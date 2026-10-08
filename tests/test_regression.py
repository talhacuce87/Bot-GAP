"""
Mevcut Bot-GAP davranışının AI eklentisiyle bozulmadığını doğrulayan testler.
Gerçek GapBot sınıfı ve gerçek cog'lar (XP, Audit, BestFriend, …) yüklenir;
yalnızca Discord ağ katmanı sahtedir ve veritabanları geçici dizindedir.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import aiosqlite
import discord
import pytest

import activitylog
import database
from tests.ai.fakes import FakeGuild, make_member, make_message

ROOT = Path(__file__).resolve().parent.parent
BOT_ID = 4242
EXISTING_COGS = {"XPTrackerCog", "BestFriendCog", "UserCardCog", "LeaderboardCog", "InfoCog", "AuditCog"}


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    monkeypatch.setattr(activitylog, "_buffer", [])
    monkeypatch.setenv("AI_DB_PATH", str(tmp_path / "ai_memory.db"))
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    monkeypatch.setenv("AI_USER_COOLDOWN_SECONDS", "0")
    monkeypatch.setenv("AI_CHANNEL_COOLDOWN_SECONDS", "0")
    return tmp_path


async def start_bot(ai_enabled: bool, monkeypatch):
    monkeypatch.setenv("AI_ENABLED", "true" if ai_enabled else "false")
    from Main import GapBot

    bot = GapBot(command_prefix="!", intents=discord.Intents.default(), help_command=None, case_insensitive=True)
    await bot._async_setup_hook()
    bot._connection.user = SimpleNamespace(id=BOT_ID, display_name="Bot-GAP")
    await bot.setup_hook()
    return bot


async def xp_row(guild_id: int, user_id: int):
    async with aiosqlite.connect(database.DATABASE_PATH) as c:
        async with c.execute(
            "SELECT text_xp, message_count FROM user_xp WHERE guild_id = ? AND user_id = ?", (guild_id, user_id)
        ) as cur:
            return await cur.fetchone()


async def dispatch_listeners(bot, msg):
    """Bot'un on_message dinleyicilerini (XP, Audit, AI) sırayla çalıştırır."""
    for cog in bot.cogs.values():
        for name, listener in cog.get_listeners():
            if name == "on_message":
                await listener(msg)


async def test_ai_disabled_leaves_bot_unchanged(isolated, monkeypatch):
    bot = await start_bot(False, monkeypatch)
    try:
        assert set(bot.cogs) == EXISTING_COGS
        assert bot.get_command("ai") is None
    finally:
        await bot.close()


async def test_ai_enabled_loads_alongside_existing_cogs(isolated, monkeypatch):
    bot = await start_bot(True, monkeypatch)
    try:
        assert set(bot.cogs) == EXISTING_COGS | {"AICog"}
        for name in ("xp", "kart", "liderlik", "bf", "streak", "yardim", "analiz", "ai", "hatirla", "aiayar"):
            assert bot.get_command(name) is not None, name
    finally:
        await bot.close()


async def test_ai_import_failure_does_not_block_startup(isolated, monkeypatch):
    import ai

    monkeypatch.setattr(ai, "setup_ai", AsyncMock(side_effect=RuntimeError("bozuk")))
    bot = await start_bot(True, monkeypatch)
    try:
        assert set(bot.cogs) == EXISTING_COGS
    finally:
        await bot.close()


async def test_xp_still_registers_and_ai_does_not_duplicate(isolated, monkeypatch):
    bot = await start_bot(True, monkeypatch)
    try:
        ai_cog = bot.get_cog("AICog")
        guild = FakeGuild()
        channel = guild.add_channel()
        user = make_member(guild)
        await ai_cog._set_channel(guild.id, channel.id, "index", "1", 1)

        await dispatch_listeners(bot, make_message(guild, channel, user, "merhaba millet"))
        text_xp, count = await xp_row(guild.id, user.id)
        assert text_xp > 0 and count == 1                     # XP tek sefer
        assert (await ai_cog.storage.stats())["messages"] == 1  # AI ayrıca indeksledi

        # Bot mention'ı da normal mesaj gibi sayılır (mevcut davranış); AI XP eklemez.
        mention = make_message(guild, channel, user, f"<@{BOT_ID}> selam", mentions=[SimpleNamespace(id=BOT_ID)])
        await dispatch_listeners(bot, mention)
        _, count = await xp_row(guild.id, user.id)
        assert count == 2
        assert "API anahtarı" in mention.reply.call_args.args[0]  # anahtar yok → kibar hata

        # !ai bir komuttur: mevcut kurala göre mesaj sayacı artmaz.
        await dispatch_listeners(bot, make_message(guild, channel, user, "!ai selam"))
        _, count = await xp_row(guild.id, user.id)
        assert count == 2

        # Audit olay kaydı da çalışmaya devam ediyor
        assert any(row[3] == "message" for row in activitylog._buffer)
    finally:
        await bot.close()


async def test_ai_failure_does_not_interrupt_xp(isolated, monkeypatch):
    bot = await start_bot(True, monkeypatch)
    try:
        ai_cog = bot.get_cog("AICog")
        guild = FakeGuild()
        channel = guild.add_channel()
        user = make_member(guild)
        await ai_cog._set_channel(guild.id, channel.id, "index", "1", 1)
        monkeypatch.setattr(ai_cog.storage, "insert_message", AsyncMock(side_effect=OSError("disk")))
        await dispatch_listeners(bot, make_message(guild, channel, user, "selam"))
        assert (await xp_row(guild.id, user.id))[1] == 1
    finally:
        await bot.close()


async def test_shutdown_closes_ai_resources(isolated, monkeypatch):
    bot = await start_bot(True, monkeypatch)
    ai_cog = bot.get_cog("AICog")
    await bot.close()
    assert not ai_cog.storage.is_open
    assert ai_cog.client._client.is_closed


def test_deployment_preserves_ai_database():
    compose = (ROOT / "docker-compose.yaml").read_text()
    assert re.search(r"-\s*\./data:/app/data", compose)
    from ai.config import AIConfig
    assert AIConfig().db_path.parent == ROOT / "data"         # AI DB volume içinde
    assert AIConfig().backup_dir.parent == ROOT / "data"
    dockerignore = (ROOT / ".dockerignore").read_text().split()
    assert "data/" in dockerignore and ".env" in dockerignore  # imaja veri/sır girmez
    gitignore = (ROOT / ".gitignore").read_text()
    assert "data/*.db" in gitignore and ".env" in gitignore
