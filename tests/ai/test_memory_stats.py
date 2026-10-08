from __future__ import annotations

import pytest

import database
from ai.memory import MemoryError_, MemoryService, extract_user_candidates, looks_like_plan
from ai.stats import StatsService, detect_intents
from tests.ai.conftest import add_msg

# ---------------------------------------------------------------------------
# Hafıza çıkarımı
# ---------------------------------------------------------------------------


def test_extract_candidates():
    c = extract_user_candidates("En sevdiğim oyun Valorant.")
    assert [(x.memory_type, x.content) for x in c] == [("preference", "favori oyun: Valorant")]
    c = extract_user_candidates("bana Kaptan diye seslen")
    assert [(x.memory_type, x.content) for x in c] == [("nickname", "hitap/takma ad: Kaptan")]


@pytest.mark.parametrize("text", [
    "en sevdiğim oyun ne?",                  # soru
    "en sevdiğim oyun valorant değil",       # olumsuz
    "en sevdiğim oyun a@b.com",              # hassas
    "valorant güzel oyun",                   # beyan değil
])
def test_extract_candidates_rejects(text):
    assert extract_user_candidates(text) == []


def test_plan_detection():
    assert looks_like_plan("Yarın akşam valorant oynayalım mı")
    assert looks_like_plan("cumartesi saat 9 toplanıyoruz")
    assert not looks_like_plan("dün valorant oynadık")


async def test_explicit_memory_lifecycle(storage):
    svc = MemoryService(storage)
    mem_id, created = await svc.remember_user(1, 5, "Hafta içi akşamları müsaitim")
    assert created
    assert (await svc.remember_user(1, 5, "hafta içi akşamları  MÜSAİTİM"))[1] is False
    users, _ = await svc.for_context(1, 5, set(), 10)
    assert users == ["Hafta içi akşamları müsaitim"]
    with pytest.raises(MemoryError_):
        await svc.forget(1, 6, mem_id)  # başkası silemez
    with pytest.raises(MemoryError_):
        await svc.forget(2, 5, mem_id)  # başka sunucudan silinemez
    await svc.forget(1, 5, mem_id)
    assert await svc.for_context(1, 5, set(), 10) == ([], [])


async def test_memory_rejects_sensitive_and_length(storage):
    svc = MemoryService(storage)
    with pytest.raises(MemoryError_):
        await svc.remember_user(1, 5, "şifrem: hunter2")
    with pytest.raises(MemoryError_):
        await svc.remember_user(1, 5, "x" * 301)
    with pytest.raises(MemoryError_):
        await svc.remember_user(1, 5, "a")


async def test_candidates_not_in_context_until_confirmed(storage):
    svc = MemoryService(storage)
    msg = await add_msg(storage, "en sevdiğim oyun valorant", user=5)
    ids = await svc.capture_candidates(1, 5, 10, msg, "en sevdiğim oyun valorant", store_source=True)
    assert len(ids) == 1
    assert await svc.for_context(1, 5, set(), 10) == ([], [])
    with pytest.raises(MemoryError_):
        await svc.confirm(1, 6, ids[0])  # başkasının adayı onaylanamaz
    await svc.confirm(1, 5, ids[0])
    assert (await svc.for_context(1, 5, set(), 10))[0] == ["favori oyun: valorant"]
    # Onaylandıktan sonra kaynak silinse de kalır
    await storage.delete_messages([msg])
    assert (await storage.get_memory(ids[0])).status == "confirmed"


async def test_episodic_scoped_to_channels(storage):
    svc = MemoryService(storage)
    eid, _ = await svc.add_episode(1, 10, 5, "Dün 5 saat Valorant oynadık", [6])
    assert (await svc.for_context(1, 6, {10}, 10))[1] == ["Dün 5 saat Valorant oynadık"]
    assert (await svc.for_context(1, 6, {11}, 10))[1] == []      # kanal yetkisi yok
    assert (await svc.for_context(1, 7, {10}, 10))[1] == []      # katılımcı değil
    await svc.forget(1, 6, eid)                                  # katılımcı silebilir
    assert await storage.get_memory(eid) is None


async def test_plan_capture_revoked_on_source_delete(storage):
    svc = MemoryService(storage)
    msg = await add_msg(storage, "yarın valorant oynayalım", user=5)
    mem_id = await svc.capture_plan(1, 10, 5, "ali", msg, "yarın valorant oynayalım")
    assert mem_id and (await storage.get_memory(mem_id)).status == "candidate"
    await storage.delete_messages([msg])
    assert (await storage.get_memory(mem_id)).status == "revoked"


# ---------------------------------------------------------------------------
# Bot-GAP istatistik adaptörü
# ---------------------------------------------------------------------------


def test_detect_intents():
    assert detect_intents("Kim en yüksek seviyede?") == ["leaderboard"]
    assert "user_xp" in detect_intents("seviyem kaç")
    assert detect_intents("streak durumum nasıl") == ["streak"]
    assert detect_intents("<@5> best friend'i kim") == ["bestfriend"]
    assert detect_intents("bugün hava nasıl") == []


@pytest.fixture
async def xp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    await database.init_db()
    await database.add_text_xp(1, 100, 500)
    await database.add_voice_xp(1, 100, 100)
    await database.add_text_xp(1, 200, 50)
    await database.add_text_xp(2, 300, 9999)  # başka sunucu
    await database.add_pair_voice_seconds_bulk(1, [100, 200], 7200)
    return database


def _stats():
    names = {100: "ali", 200: "veli", 300: "x"}
    return StatsService(level_for=lambda xp: xp // 100, name_for=lambda uid: names.get(uid, "?"))


async def _count_rows():
    import aiosqlite
    async with aiosqlite.connect(database.DATABASE_PATH) as c:
        async with c.execute("SELECT COUNT(*) FROM user_xp") as cur:
            return (await cur.fetchone())[0]


async def test_stats_leaderboard_uses_real_data(xp_db):
    lines = await _stats().gather(1, 200, "Kim en yüksek seviyede?", bot_id=1)
    assert lines[1] == "1. ali — Seviye 6, 600 XP"
    assert "x" not in " ".join(lines[1:]).split()  # başka sunucu yok


async def test_stats_user_and_bestfriend_readonly(xp_db):
    before = await _count_rows()
    lines = await _stats().gather(1, 999, "seviyem kaç", bot_id=1)
    assert lines == ["?: bu sunucuda kayıtlı XP verisi yok."]
    assert await _count_rows() == before  # salt-okunur: eksik kullanıcı oluşturulmadı
    lines = await _stats().gather(1, 999, "<@100> seviyesi ve streak", bot_id=1)
    assert "Seviye 6" in lines[0] and "sıralama #1" in lines[0]
    assert "serisi" in lines[1]
    lines = await _stats().gather(1, 100, "best friend'im kim", bot_id=1)
    assert "veli" in lines[0] and "2sa 0dk" in lines[0] and "henüz ulaşmadı" in lines[0]
    assert await _count_rows() == before
