"""GAP Dünyası entegrasyonu: sürgün listesinin dünyaya gönderilmesi."""

from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace

import discord
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

    async def status(body):
        r = await cog.handle_fish_status(req(body))
        return json.loads(r.text)

    assert await status({"guild": "1", "user": "5"}) == {"next": 0}
    status_code, first = await call({"guild": "1", "user": "5"})
    assert status_code == 200 and first["ok"] and first["hours"] >= 1
    tomorrow = database.next_day_start()
    assert first["next"] == tomorrow and tomorrow - time.time() <= 86400
    assert (await call({"guild": "1", "user": "5"}))[1] == {"ok": False, "reason": "already", "next": tomorrow}
    assert await status({"guild": "1", "user": "5"}) == {"next": tomorrow}

    # Tutulan balık olay kaydına düşer (yönetici boost'undan ayırt etmek için)
    catches = [r for r in activitylog._buffer if r[3] == "fish_catch"]
    assert len(catches) == 1 and catches[0][1:3] == (1, 5)
    assert json.loads(catches[0][7])["rarity"] == first["rarity"]

    # ASCII dışı secret başlığı 500 değil, 404 dönmeli
    assert (await call({"guild": "1", "user": "5"}, secret="şifre"))[0] == 404


class _FishChannel(discord.abc.Messageable):
    def __init__(self):
        self.sent = []

    async def _get_channel(self):
        return self

    async def send(self, content=None, **kw):
        self.sent.append((content, kw))


async def test_fish_catch_announced_in_fish_channel_from_rare_up(db, monkeypatch):
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    monkeypatch.setattr(world_cog, "FISH_CHANNEL_ID", 77)
    monkeypatch.setattr(world_cog, "FISH_ANNOUNCE_MIN_RARITY", "rare")
    channel = _FishChannel()
    guild = SimpleNamespace(
        get_member=lambda uid: object(),
        get_channel=lambda cid: channel if cid == 77 else None,
    )
    bot = SimpleNamespace(get_guild=lambda gid: guild)
    cog = world_cog.WorldCog(bot)

    rolls = {}

    async def fake_catch(guild_id, user_id):
        return {"rarity": rolls[user_id], "label": "Efsanevi" if rolls[user_id] == "legendary" else "Yaygın",
                "fish": "Altın Sazan", "hours": 24, "streak": 3, "luck": 0.2, "boost_until": time.time()}

    monkeypatch.setattr(world_cog.fishing, "catch", fake_catch)

    async def _json(uid):
        return {"guild": "1", "user": str(uid)}

    for uid, rarity in ((5, "common"), (6, "legendary")):
        rolls[uid] = rarity
        await cog.handle_fish(SimpleNamespace(headers={"x-world-secret": "s3cret"}, json=lambda uid=uid: _json(uid)))
    await asyncio.gather(*cog._tasks)

    assert len(channel.sent) == 1  # common duyurulmaz
    text, kw = channel.sent[0]
    assert "<@6>" in text and "EFSANEVİ" in text and "24 saat 2x XP" in text
    assert kw["allowed_mentions"].users is False  # ping yok

    # Kanal bulunamazsa sessizce geçer
    monkeypatch.setattr(world_cog, "FISH_CHANNEL_ID", 99)
    rolls[7] = "epic"
    await cog.handle_fish(SimpleNamespace(headers={"x-world-secret": "s3cret"}, json=lambda: _json(7)))
    await asyncio.gather(*cog._tasks)
    assert len(channel.sent) == 1


async def test_game_command_endpoint_answers_xp_streak_voice_and_rank(db, monkeypatch):
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    guild = SimpleNamespace(get_member=lambda uid: SimpleNamespace(display_name=f"Üye {uid}") if uid in (5, 6) else None)
    cog = world_cog.WorldCog(SimpleNamespace(get_guild=lambda gid: guild if gid == 1 else None))
    await database.add_text_xp(1, 5, 500)
    await database.add_voice_xp(1, 6, 900)

    async def call(body, secret="s3cret"):
        async def _json():
            return body
        r = await cog.handle_command(SimpleNamespace(headers={"x-world-secret": secret}, json=_json))
        return r.status, json.loads(r.text)

    assert (await call({"guild": 1, "user": 5, "command": "xp"}, secret="x"))[0] == 404
    status, xp = await call({"guild": 1, "user": 5, "command": "xp"})
    assert status == 200 and "500 XP" in xp["text"] and "sıra #2" in xp["text"]
    assert "#1" in (await call({"guild": 1, "user": 6, "command": "rank"}))[1]["text"]
    assert "günlük seri" in (await call({"guild": 1, "user": 5, "command": "streak"}))[1]["text"]
    assert "ses süren" in (await call({"guild": 1, "user": 5, "command": "ses"}))[1]["text"]
    top = (await call({"guild": 1, "user": 5, "command": "top"}))[1]["text"]
    assert top.index("Üye 6") < top.index("Üye 5") and "🥇 Üye 6 (900)" in top
    assert (await call({"guild": 1, "user": 5, "command": "rm -rf"}))[0] == 400
    assert "üyesi değilsin" in (await call({"guild": 1, "user": 7, "command": "xp"}))[1]["text"]
    assert any(r[3] == "command" and json.loads(r[7]).get("source") == "world" for r in activitylog._buffer)


async def test_world_stats_command_shows_upload(monkeypatch):
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    cog = world_cog.WorldCog(SimpleNamespace())

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/internal/stats" and request.headers["x-world-secret"] == "s3cret"
        return httpx.Response(200, json={"media": {"bytes": 2_500_000_000, "mbps": 42.5, "active": 7, "hits": 90, "requests": 100}, "rooms": 2, "players": 15})

    cog._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), headers={"x-world-secret": "s3cret"})
    sent = []

    async def send(**kw):
        sent.append(kw["embed"])

    await cog.world_stats_command.callback(cog, SimpleNamespace(send=send))
    fields = {f.name: f.value for f in sent[0].fields}
    assert fields["Video upload (son 10 sn)"] == "**42.5 Mbit/sn**"
    assert fields["Aktif akış"] == "7" and fields["Önbellek isabeti"] == "%90"
    assert fields["Toplam gönderilen"] == "2.50 GB" and fields["Oda / oyuncu"] == "2 / 15"


def _member_req(body, secret="s3cret"):
    async def _json():
        return body
    return SimpleNamespace(headers={"x-world-secret": secret}, json=_json)


async def test_world_event_advances_daily_quests_and_grants_xp_once(db, monkeypatch):
    import world_quests

    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    guild = SimpleNamespace(id=1, get_member=lambda uid: object() if uid == 5 else None)
    cog = world_cog.WorldCog(SimpleNamespace(get_guild=lambda gid: guild if gid == 1 else None))
    today = world_cog._today()
    quest = world_quests.daily(5, today)[0]

    async def send(event, amount):
        r = await cog.handle_world_event(_member_req({"guild": "1", "user": "5", "event": event, "amount": amount}))
        return json.loads(r.text)

    assert (await cog.handle_world_event(_member_req({"guild": "1", "user": "5", "event": "nope"}))).status == 400
    assert (await send(quest.event, quest.target - 1 or 1))["ok"]
    body = await send(quest.event, quest.target)
    assert [c["key"] for c in body["completed"]] == [quest.key] or quest.target == 1
    again = await send(quest.event, quest.target)
    assert again["completed"] == []  # bir görev günde bir kez
    row = await db.get_user_row(1, 5)
    assert int(row["total_xp"]) == quest.xp


async def test_profile_reports_album_stats_and_season(db, monkeypatch):
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    guild = SimpleNamespace(id=1, get_member=lambda uid: object())
    cog = world_cog.WorldCog(SimpleNamespace(get_guild=lambda gid: guild))
    season = world_cog._today().strftime("%Y-%m")
    await db.add_world_stats(1, 5, {"fish:rare": 2, "goals": 3, f"s:{season}:tank_kills": 4})
    await db.add_world_stats(1, 5, {"goals": 1})
    r = json.loads((await cog.handle_profile(_member_req({"guild": "1", "user": "5"}))).text)
    assert r["fish"]["rare"] == 2 and r["fish"]["legendary"] == 0
    assert r["stats"]["goals"] == 4
    assert r["season"]["tank_kills"] == 4
    assert len(r["quests"]) == 3

    top = json.loads((await cog.handle_season(_member_req({"guild": "1"}))).text)
    assert top["season"] == season and top["top"][0]["kills"] == 4


async def test_photo_requires_jpeg_and_channel(db, monkeypatch):
    import base64

    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    sent = []

    class Channel(discord.abc.Messageable):
        async def _get_channel(self):
            return self

        async def send(self, content=None, **kw):
            sent.append((content, kw))

    guild = SimpleNamespace(id=1, get_member=lambda uid: object(), get_channel=lambda cid: Channel())
    cog = world_cog.WorldCog(SimpleNamespace(get_guild=lambda gid: guild))
    monkeypatch.setattr(world_cog, "PHOTO_CHANNEL_ID", 0)
    r = json.loads((await cog.handle_photo(_member_req({"guild": "1", "user": "5", "image": ""}))).text)
    assert r == {"ok": False, "reason": "no_channel"}
    monkeypatch.setattr(world_cog, "PHOTO_CHANNEL_ID", 42)
    bad = await cog.handle_photo(_member_req({"guild": "1", "user": "5", "image": base64.b64encode(b"GIF89a").decode()}))
    assert bad.status == 400
    ok = json.loads((await cog.handle_photo(_member_req({"guild": "1", "user": "5", "image": base64.b64encode(b"\xff\xd8\xff\xe0jpeg").decode()}))).text)
    assert ok["ok"] and len(sent) == 1


async def test_can_control_by_permission_or_configured_role(monkeypatch):
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    monkeypatch.setattr(world_cog, "WORLD_CONTROL_ROLES", {"sinemacı", "77"})

    def member(admin=False, manage=False, roles=()):
        perms = SimpleNamespace(administrator=admin, manage_guild=manage)
        return SimpleNamespace(guild_permissions=perms, roles=[SimpleNamespace(id=i, name=n) for i, n in roles])

    members = {
        1: member(admin=True),
        2: member(manage=True),
        3: member(roles=[(5, "Sinemacı")]),
        4: member(roles=[(77, "Başka")]),
        5: member(roles=[(9, "Üye")]),
    }
    guild = SimpleNamespace(id=1, get_member=members.get)
    cog = world_cog.WorldCog(SimpleNamespace(get_guild=lambda gid: guild))
    allowed = {}
    for uid in members:
        r = json.loads((await cog.handle_can_control(_member_req({"guild": "1", "user": str(uid)}))).text)
        allowed[uid] = r["allowed"]
    assert allowed == {1: True, 2: True, 3: True, 4: True, 5: False}
    gone = json.loads((await cog.handle_can_control(_member_req({"guild": "1", "user": "99"}))).text)
    assert gone == {"ok": False, "reason": "not_member"}
