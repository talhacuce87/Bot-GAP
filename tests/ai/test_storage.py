from __future__ import annotations

import sqlite3
import time

import pytest

from ai.storage import AIStorage, utc_day
from tests.ai.conftest import add_msg, next_id


async def fts_ids(st: AIStorage, query: str) -> set[int]:
    async with st._lock:
        async with st._c().execute("SELECT rowid FROM ai_messages_fts WHERE ai_messages_fts MATCH ?", (query,)) as cur:
            return {r[0] for r in await cur.fetchall()}


async def test_schema_created_and_migrations_idempotent(tmp_path):
    path = tmp_path / "ai.db"
    st = AIStorage(path)
    await st.open()
    assert await st.schema_version() == 1
    await st.close()
    # Yeniden açmak migration'ı tekrar uygulamamalı ve hata vermemeli.
    st2 = AIStorage(path)
    await st2.open()
    assert await st2.schema_version() == 1
    async with st2._c().execute("SELECT COUNT(*) FROM ai_schema_migrations") as cur:
        assert (await cur.fetchone())[0] == 1
    await st2.close()
    with sqlite3.connect(path) as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"ai_messages", "ai_messages_fts", "ai_memories", "ai_memory_sources", "ai_settings",
            "ai_usage", "ai_schema_migrations", "ai_user_privacy"} <= tables


async def test_insert_and_duplicate(storage):
    mid = next_id()
    assert await storage.insert_message(message_id=mid, guild_id=1, channel_id=10, user_id=5,
                                        author_name="a", content="merhaba dünya", created_at=1.0)
    assert not await storage.insert_message(message_id=mid, guild_id=1, channel_id=10, user_id=5,
                                            author_name="a", content="merhaba dünya", created_at=1.0)
    assert await fts_ids(storage, "merhaba") == {mid}


async def test_edit_updates_fts(storage):
    mid = await add_msg(storage, "bu akşam valorant")
    assert await storage.update_message(mid, "bu akşam minecraft", time.time())
    assert await fts_ids(storage, "valorant") == set()
    assert await fts_ids(storage, "minecraft") == {mid}
    msg = await storage.get_message(mid)
    assert msg.content == "bu akşam minecraft"


async def test_delete_removes_from_fts_and_blocks_reinsert(storage):
    mid = await add_msg(storage, "gizli plan")
    deleted, _ = await storage.delete_messages([mid])
    assert deleted == 1
    assert await fts_ids(storage, "gizli") == set()
    assert await storage.get_message(mid) is None
    # Geç gelen bir olay silinmiş mesajı geri getirmemeli.
    assert not await storage.insert_message(message_id=mid, guild_id=1, channel_id=10, user_id=100,
                                            author_name="x", content="gizli plan", created_at=2.0)
    assert not await storage.update_message(mid, "yeniden", time.time())
    assert await storage.integrity_check_fts()


async def test_fts_rebuild_consistent(storage):
    a = await add_msg(storage, "elma armut")
    await add_msg(storage, "kiraz")
    await storage.delete_messages([a])
    await storage.rebuild_fts()
    assert await storage.integrity_check_fts()
    assert await fts_ids(storage, "kiraz")
    assert not await fts_ids(storage, "elma")


async def test_search_guild_and_channel_isolation(storage):
    await add_msg(storage, "valorant gecesi", guild=1, channel=10)
    await add_msg(storage, "valorant gecesi", guild=2, channel=10)
    await add_msg(storage, "valorant gecesi", guild=1, channel=11)
    hits = await storage.search_messages(1, '"valorant"*', [10])
    assert len(hits) == 1 and hits[0].guild_id == 1 and hits[0].channel_id == 10
    assert await storage.search_messages(1, '"valorant"*', []) == []


async def test_bad_fts_syntax_does_not_raise(storage):
    await add_msg(storage, "test")
    assert await storage.search_messages(1, 'AND OR "', [10]) == []


async def test_memory_crud_and_dedup(storage):
    mid, created = await storage.add_memory(guild_id=1, user_id=5, scope="user", memory_type="note",
                                            content="Favori oyun: Valorant", source="explicit", status="confirmed")
    assert created
    mid2, created2 = await storage.add_memory(guild_id=1, user_id=5, scope="user", memory_type="note",
                                              content="favori OYUN:  valorant", source="explicit", status="confirmed")
    assert mid2 == mid and not created2
    assert len(await storage.list_user_memories(1, 5)) == 1
    # Başka kullanıcı / başka sunucu ayrı kayıt
    assert (await storage.add_memory(guild_id=2, user_id=5, scope="user", memory_type="note",
                                     content="Favori oyun: Valorant", source="explicit", status="confirmed"))[1]
    assert await storage.delete_memory(mid)
    assert await storage.list_user_memories(1, 5) == []


async def test_candidate_promoted_on_duplicate_confirm(storage):
    mid, _ = await storage.add_memory(guild_id=1, user_id=5, scope="user", memory_type="p",
                                      content="x y z", source="extracted", status="candidate", expires_at=time.time() + 100)
    await storage.add_memory(guild_id=1, user_id=5, scope="user", memory_type="p",
                             content="x y z", source="explicit", status="confirmed")
    mem = await storage.get_memory(mid)
    assert mem.status == "confirmed" and mem.expires_at is None


async def test_source_deletion_revokes_only_unconfirmed_extracted(storage):
    msg = await add_msg(storage, "en sevdiğim oyun valorant")
    cand, _ = await storage.add_memory(guild_id=1, user_id=100, scope="user", memory_type="p", content="cand",
                                       source="extracted", status="candidate", source_messages=[(msg, 10)])
    conf, _ = await storage.add_memory(guild_id=1, user_id=100, scope="user", memory_type="p", content="conf",
                                       source="extracted", status="confirmed", source_messages=[(msg, 10)])
    other = await add_msg(storage, "başka kaynak")
    multi, _ = await storage.add_memory(guild_id=1, user_id=100, scope="user", memory_type="p", content="multi",
                                        source="extracted", status="candidate",
                                        source_messages=[(msg, 10), (other, 10)])
    _, revoked = await storage.delete_messages([msg])
    assert revoked == 1
    assert (await storage.get_memory(cand)).status == "revoked"
    assert (await storage.get_memory(conf)).status == "confirmed"
    assert (await storage.get_memory(multi)).status == "candidate"


async def test_retention_prune(storage):
    now = time.time()
    old = await add_msg(storage, "eski mesaj", ts=now - 40 * 86400)
    new = await add_msg(storage, "yeni mesaj", ts=now)
    other_guild_old = await add_msg(storage, "eski mesaj", guild=2, ts=now - 10 * 86400)
    exp, _ = await storage.add_memory(guild_id=1, user_id=1, scope="user", memory_type="n", content="exp",
                                      source="explicit", status="confirmed", expires_at=now - 1)
    keep, _ = await storage.add_memory(guild_id=1, user_id=1, scope="user", memory_type="n", content="keep",
                                       source="explicit", status="confirmed")
    result = await storage.prune(30, {2: 7}, 14)
    assert result["messages"] == 2
    assert await storage.get_message(old) is None
    assert await storage.get_message(other_guild_old) is None
    assert await storage.get_message(new) is not None
    assert await storage.get_memory(exp) is None
    assert await storage.get_memory(keep) is not None
    assert not await fts_ids(storage, "eski")


async def test_delete_user_data(storage):
    await add_msg(storage, "benim mesajım", user=5)
    await add_msg(storage, "benim mesajım", user=5, guild=2)
    await add_msg(storage, "başkası", user=6)
    await storage.add_memory(guild_id=1, user_id=5, scope="user", memory_type="n", content="m",
                             source="explicit", status="confirmed")
    await storage.add_memory(guild_id=1, channel_id=10, scope="episodic", memory_type="e", content="anı",
                             source="explicit", status="confirmed", created_by=5, participants=[5, 6])
    assert await storage.count_user_data(1, 5) == (1, 2)
    msgs, mems = await storage.delete_user_data(1, 5)
    assert msgs == 1 and mems >= 2
    assert await storage.count_user_data(1, 5) == (0, 0)
    assert await storage.count_user_data(2, 5) == (1, 0)  # diğer sunucuya dokunulmaz
    assert len(await storage.search_messages(1, '"baskasi"', [10])) == 1


async def test_usage_counts(storage):
    await storage.record_usage(provider="openrouter", model="m", guild_id=1, user_id=5,
                               input_tokens=10, output_tokens=5, error_code=None)
    await storage.record_usage(provider="openrouter", model="m", guild_id=1, user_id=5,
                               input_tokens=None, output_tokens=None, error_code="rate_limited")
    await storage.record_usage(provider="openrouter", model="m", guild_id=1, user_id=6,
                               input_tokens=None, output_tokens=None, error_code=None, ts=time.time() - 3 * 86400)
    total, per_user = await storage.usage_counts(utc_day())
    assert total == 2 and per_user == {(1, 5): 2}


async def test_backup_uses_online_api(storage, tmp_path):
    await add_msg(storage, "yedeklenecek mesaj")
    dest = await storage.backup(tmp_path / "b" / "ai_backup.db")
    with sqlite3.connect(dest) as conn:
        assert conn.execute("SELECT COUNT(*) FROM ai_messages").fetchone()[0] == 1
        assert conn.execute("SELECT rowid FROM ai_messages_fts WHERE ai_messages_fts MATCH 'yedeklenecek'").fetchall()


async def test_restart_does_not_duplicate(tmp_path):
    path = tmp_path / "ai.db"
    st = AIStorage(path)
    await st.open()
    mid = await add_msg(st, "kalıcı mesaj")
    await st.add_memory(guild_id=1, user_id=1, scope="user", memory_type="n", content="kalıcı hafıza",
                        source="explicit", status="confirmed")
    await st.close()
    st = AIStorage(path)
    await st.open()
    assert not await st.insert_message(message_id=mid, guild_id=1, channel_id=10, user_id=100,
                                       author_name="a", content="kalıcı mesaj", created_at=1.0)
    _, created = await st.add_memory(guild_id=1, user_id=1, scope="user", memory_type="n", content="kalıcı hafıza",
                                     source="explicit", status="confirmed")
    assert not created
    assert (await st.stats())["messages"] == 1
    await st.close()


async def test_closed_storage_raises(tmp_path):
    st = AIStorage(tmp_path / "x.db")
    with pytest.raises(RuntimeError):
        await st.get_message(1)
