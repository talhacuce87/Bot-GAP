"""GAP Dünyası entegrasyonu: sürgün listesinin dünyaya gönderilmesi."""

from __future__ import annotations

import json
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


async def test_leaderboard_payload_uses_names_avatars_and_levels(db):
    await db.add_text_xp(1, 111111, 500)
    await db.add_voice_xp(1, 222222, 900)
    await db.add_text_xp(1, 333333, 50)

    members = {
        111111: SimpleNamespace(id=111111, display_name="Ali", name="ali", avatar=SimpleNamespace(key="a" * 32)),
        222222: SimpleNamespace(id=222222, display_name="Ayşe", name="ayse", avatar=None),
    }
    guild = SimpleNamespace(id=1, get_member=members.get)
    xp_cog = SimpleNamespace(get_progress_data=lambda total: (total // 100, 0, 0, 0, 0.0))
    bot = SimpleNamespace(guilds=[guild], get_cog=lambda name: xp_cog if name == "XPTrackerCog" else None)

    payload = await world_cog.build_leaderboard_payload(bot)
    rows = payload["guilds"]["1"]

    assert [r["id"] for r in rows] == ["222222", "111111", "333333"]
    assert rows[0] == {"id": "222222", "name": "Ayşe", "avatar": None, "level": 9, "xp": 900}
    assert rows[1]["avatar"] == "a" * 32 and rows[1]["level"] == 5
    assert rows[2]["name"] == "Kullanıcı 3333"  # sunucudan ayrılmış üye


async def test_leaderboard_posted_to_world(db, monkeypatch):
    await db.add_text_xp(1, 111111, 10)
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    bot = SimpleNamespace(guilds=[SimpleNamespace(id=1, get_member=lambda uid: None)], get_cog=lambda name: None)
    cog = world_cog.WorldCog(bot)
    seen = []
    cog._client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: (seen.append(r), httpx.Response(200))[1]),
        headers={"x-world-secret": cog.secret},
    )
    await cog.push_leaderboard()
    assert seen[0].url.path == "/internal/leaderboard"
    assert b'"111111"' in seen[0].content


class _Ctx:
    def __init__(self):
        self.guild = SimpleNamespace(id=1)
        self.author = SimpleNamespace(id=42, name="ali", display_name="Ali")
        self.sent: list[dict] = []

    async def send(self, content=None, **kwargs):
        self.sent.append({"content": content, **kwargs})


def _watch_cog(monkeypatch, handler):
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    cog = world_cog.WorldCog(SimpleNamespace(guilds=[]))
    cog._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://world.test")
    cog.url = "http://world.test"
    return cog


async def test_watch_command_posts_room_link(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"id": "abc123", "url": "https://world.example/w/abc123", "title": "Film", "kind": "youtube"})

    cog = _watch_cog(monkeypatch, handler)
    ctx = _Ctx()
    await world_cog.WorldCog.watch_command.callback(cog, ctx, "<https://youtu.be/dQw4w9WgXcQ>")

    body = seen[0].read()
    assert b'"https://youtu.be/dQw4w9WgXcQ"' in body and b'"Ali"' in body
    msg = ctx.sent[0]
    assert "Film" in msg["embed"].description
    assert msg["view"].children[0].url == "https://world.example/w/abc123"


async def test_watch_command_rejects_unsupported_and_survives_world_down(monkeypatch):
    cog = _watch_cog(monkeypatch, lambda r: httpx.Response(400, json={"error": "unsupported"}))
    ctx = _Ctx()
    await world_cog.WorldCog.watch_command.callback(cog, ctx, "https://netflix.com/watch/1")
    assert "açamıyorum" in ctx.sent[0]["content"]

    def down(request):
        raise httpx.ConnectError("down")

    cog = _watch_cog(monkeypatch, down)
    await world_cog.WorldCog.watch_command.callback(cog, ctx, "https://youtu.be/dQw4w9WgXcQ")
    assert "ulaşılamıyor" in ctx.sent[-1]["content"]

    await world_cog.WorldCog.watch_command.callback(cog, ctx, None)
    assert "Kullanım" in ctx.sent[-1]["content"]


async def test_fish_endpoint_checks_secret_membership_and_daily_limit(db, monkeypatch):
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    guild = SimpleNamespace(get_member=lambda uid: object() if uid == 5 else None)
    bot = SimpleNamespace(get_guild=lambda gid: guild if gid == 1 else None)
    cog = world_cog.WorldCog(bot)

    def req(body, secret="s3cret"):
        async def _json():
            return body
        return SimpleNamespace(headers={"x-world-secret": secret}, json=_json)

    async def call(*a, **kw):
        r = await cog.handle_fish(req(*a, **kw))
        return r.status, json.loads(r.text)

    assert (await call({"guild": "1", "user": "5"}, secret="wrong"))[0] == 404
    assert (await call({"guild": "1"}))[0] == 400
    assert (await call({"guild": "1", "user": "6"}))[1] == {"ok": False, "reason": "not_member"}

    status, first = await call({"guild": "1", "user": "5"})
    assert status == 200 and first["ok"] and first["hours"] >= 1
    assert (await call({"guild": "1", "user": "5"}))[1] == {"ok": False, "reason": "already"}

    # Tutulan balık olay kaydına düşer (yönetici boost'undan ayırt etmek için)
    catches = [r for r in activitylog._buffer if r[3] == "fish_catch"]
    assert len(catches) == 1 and catches[0][1:3] == (1, 5)
    assert json.loads(catches[0][7])["rarity"] == first["rarity"]

    # ASCII dışı secret başlığı 500 değil, 404 dönmeli
    assert (await call({"guild": "1", "user": "5"}, secret="şifre"))[0] == 404
