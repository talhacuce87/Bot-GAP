"""GAP Dünyası entegrasyonu: sürgün listesinin dünyaya gönderilmesi."""

from __future__ import annotations

import time
from types import SimpleNamespace

import httpx
import pytest

import activitylog
import database
import world_cog


@pytest.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    monkeypatch.setattr(activitylog, "_buffer", [])
    await database.init_db()
    return database


async def test_payload_lists_only_active_exiles_per_guild(db):
    now = time.time()
    await db.set_exile(1, 10, ends_at=None, reason="kalıcı", moderator_id=99, channel_id=None)
    await db.set_exile(1, 11, ends_at=now + 3600, reason="1 saat", moderator_id=99, channel_id=None)
    await db.set_exile(1, 12, ends_at=now - 5, reason="bitti", moderator_id=99, channel_id=None)
    await db.set_exile(2, 20, ends_at=None, reason="diğer sunucu", moderator_id=99, channel_id=None)

    payload = await world_cog.build_exile_payload([1, 2, 3])

    assert sorted(payload["guilds"]["1"]) == ["10", "11"]
    assert payload["guilds"]["2"] == ["20"]
    assert payload["guilds"]["3"] == []


async def test_push_posts_with_secret_and_survives_world_being_down(db, monkeypatch):
    await db.set_exile(1, 10, ends_at=None, reason="x", moderator_id=99, channel_id=None)
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    monkeypatch.setenv("WORLD_INTERNAL_URL", "http://world.test")
    bot = SimpleNamespace(guilds=[SimpleNamespace(id=1)])
    cog = world_cog.WorldCog(bot)

    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    cog._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), headers={"x-world-secret": cog.secret})
    await cog.push_exiles()
    assert seen[0].url == "http://world.test/internal/exiles"
    assert seen[0].headers["x-world-secret"] == "s3cret"
    assert b'"10"' in seen[0].content

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    cog._client = httpx.AsyncClient(transport=httpx.MockTransport(down))
    await cog.push_exiles()  # hata fırlatmamalı
    assert cog._failing is True


def test_disabled_without_secret(monkeypatch):
    monkeypatch.delenv("WORLD_SHARED_SECRET", raising=False)
    cog = world_cog.WorldCog(SimpleNamespace(guilds=[]))
    assert cog.secret == ""
