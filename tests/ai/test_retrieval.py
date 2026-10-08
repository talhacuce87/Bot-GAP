from __future__ import annotations

import datetime as dt

from ai.guard import jump_url
from ai.retrieval import (
    TR_TZ, Retriever, author_filter, build_fts_query, extract_terms, light_stem, parse_time_filter,
)
from ai.textutil import fold, normalize_for_index
from tests.ai.conftest import add_msg

NOW = dt.datetime(2026, 10, 8, 15, 0, tzinfo=TR_TZ).timestamp()  # Perşembe


def test_turkish_fold():
    assert fold("IŞIK") == fold("ışık") == "isik"
    assert fold("İSTANBUL") == fold("istanbul") == "istanbul"
    assert fold("Çğüöş") == "cguos"
    assert normalize_for_index("<@123> Selam  ÇOCUKLAR <:pepe:456>") == "selam cocuklar"


def test_extract_terms_drops_stopwords_and_stems():
    terms = extract_terms("Dün akşam Valorant'ta kim kazandı hatırlıyor musun?")
    assert "valorant" in terms
    assert "kim" not in terms and "dun" not in terms and "hatirliyor" not in terms
    assert light_stem("oyunda") == "oyun"
    assert light_stem("oyun") == "oyun"          # zaten kısa gövde
    assert light_stem("toplantida") == "toplanti"
    assert extract_terms("<@123> ne dedi?") == []


def test_build_fts_query_safe():
    assert build_fts_query(["valorant", "ab"]) == '"valorant"* OR "ab"'
    assert build_fts_query(['ki"m*']) == '"kim"*'
    assert build_fts_query([]) == ""


def test_time_filters():
    tf = parse_time_filter("dün ne konuştuk", NOW)
    assert tf.label == "dün"
    assert dt.datetime.fromtimestamp(tf.since, TR_TZ).date() == dt.date(2026, 10, 7)
    assert tf.until == dt.datetime(2026, 10, 8, tzinfo=TR_TZ).timestamp()
    tf = parse_time_filter("geçen hafta ne yaptık", NOW)
    assert dt.datetime.fromtimestamp(tf.since, TR_TZ).date() == dt.date(2026, 9, 28)
    assert dt.datetime.fromtimestamp(tf.until, TR_TZ).date() == dt.date(2026, 10, 5)
    tf = parse_time_filter("son 3 gün", NOW)
    assert abs(tf.since - (NOW - 3 * 86400)) < 1
    assert parse_time_filter("valorant", NOW).since is None
    assert parse_time_filter("en son ne oynadık", NOW).recency_relevant


def test_author_filter():
    assert author_filter("<@55> ne dedi valorant hakkında", bot_id=1) == 55
    assert author_filter("<@1> <@55> ne demişti", bot_id=1) == 55
    assert author_filter("<@55> ile valorant oynadık", bot_id=1) is None


def _retriever(storage, **kw):
    return Retriever(storage, search_results=10, final_passages=5, neighbor_messages=1,
                     neighbor_window_seconds=600, **kw)


async def test_exact_and_game_name_search(storage):
    target = await add_msg(storage, "Akşam Valorant oynayalım mı", ts=NOW - 3600)
    await add_msg(storage, "pizza söyledim", ts=NOW - 7200)
    res = await _retriever(storage).search(1, "valorant ne zaman oynadık", [10], now=NOW)
    assert [p.anchor.message_id for p in res.passages] == [target]


async def test_turkish_case_and_unicode_matching(storage):
    mid = await add_msg(storage, "IŞIK açık kalmış", ts=NOW - 100)
    res = await _retriever(storage).search(1, "ışık", [10], now=NOW)
    assert res.passages and res.passages[0].anchor.message_id == mid
    mid2 = await add_msg(storage, "ŞEHİR merkezinde buluşuruz", ts=NOW - 50)
    res = await _retriever(storage).search(1, "şehir", [10], now=NOW)
    assert any(p.anchor.message_id == mid2 for p in res.passages)


async def test_suffix_stemming_prefix_match(storage):
    mid = await add_msg(storage, "minecraft sunucusu kuruldu", ts=NOW - 100)
    res = await _retriever(storage).search(1, "sunucuda ne oldu", [10], now=NOW)
    assert res.passages and res.passages[0].anchor.message_id == mid


async def test_lexical_limitation_synonym_miss(storage):
    """Belgelenmiş sınırlama: farklı kelimeyle ifade edilen içerik bulunamaz."""
    await add_msg(storage, "dün akşamki karşılaşmayı kazandık", ts=NOW - 100)
    res = await _retriever(storage).search(1, "maç", [10], now=NOW)
    assert res.empty


async def test_date_filter(storage):
    yesterday = dt.datetime(2026, 10, 7, 21, 0, tzinfo=TR_TZ).timestamp()
    old = dt.datetime(2026, 10, 1, 21, 0, tzinfo=TR_TZ).timestamp()
    y = await add_msg(storage, "valorant turnuvası", ts=yesterday)
    await add_msg(storage, "valorant turnuvası", ts=old)
    res = await _retriever(storage).search(1, "dün valorant", [10], now=NOW)
    assert [p.anchor.message_id for p in res.passages] == [y]


async def test_author_filter_search(storage):
    a = await add_msg(storage, "valorant çok iyi", user=55, ts=NOW - 100)
    await add_msg(storage, "valorant berbat", user=66, ts=NOW - 5000)
    res = await _retriever(storage).search(1, "<@55> valorant hakkında ne dedi", [10], now=NOW, bot_id=1)
    assert res.author_id == 55
    assert all(m.user_id == 55 for p in res.passages for m in p.messages if m.message_id in p.hit_ids)
    assert res.passages[0].anchor.message_id == a


async def test_ranking_prefers_more_matching_terms(storage):
    weak = await add_msg(storage, "valorant", ts=NOW - 50000)
    strong = await add_msg(storage, "valorant turnuva finali ali kazandı", ts=NOW - 90000)
    res = await _retriever(storage).search(1, "valorant turnuva finali", [10], now=NOW)
    ids = [p.anchor.message_id for p in res.passages]
    assert ids.index(strong) < ids.index(weak)


async def test_context_window_expansion_and_merge(storage):
    base = NOW - 10_000
    m1 = await add_msg(storage, "bu akşam ne yapıyoruz", ts=base)
    m2 = await add_msg(storage, "valorant oynayalım", ts=base + 10, user=101)
    m3 = await add_msg(storage, "tamam saat dokuzda", ts=base + 20)
    m4 = await add_msg(storage, "valorant için hazırım", ts=base + 30, user=102)
    await add_msg(storage, "alakasız uzak mesaj", ts=base + 5000)
    res = await _retriever(storage).search(1, "valorant", [10], now=NOW)
    assert len(res.passages) == 1  # çakışan pencereler birleşti
    ids = [m.message_id for m in res.passages[0].messages]
    assert ids == [m1, m2, m3, m4]  # kronolojik, tekrar yok
    assert set(res.passages[0].hit_ids) == {m2, m4}


async def test_no_results(storage):
    await add_msg(storage, "selam")
    res = await _retriever(storage).search(1, "uzay gemisi", [10], now=NOW)
    assert res.empty
    res = await _retriever(storage).search(1, "ne?", [10], now=NOW)
    assert res.empty and res.terms == []


async def test_unauthorized_channel_excluded(storage):
    await add_msg(storage, "gizli yönetici planı", channel=99)
    res = await _retriever(storage).search(1, "yönetici planı", [10], now=NOW)
    assert res.empty
    res = await _retriever(storage).search(1, "yönetici planı", [10, 99], now=NOW)
    assert not res.empty


async def test_exclude_ids(storage):
    mid = await add_msg(storage, "valorant", ts=NOW - 5)
    res = await _retriever(storage).search(1, "valorant", [10], now=NOW, exclude_ids=[mid])
    assert res.empty


def test_jump_link():
    assert jump_url(1, 2, 3) == "https://discord.com/channels/1/2/3"
