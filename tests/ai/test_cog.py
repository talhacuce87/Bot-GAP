from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import discord
import httpx
import pytest
from discord.ext import commands

from ai.cog import AICog, split_message
from ai.openrouter import OpenRouterClient
from tests.ai.conftest import make_cfg
from tests.ai.fakes import FakeGuild, make_ctx, make_member, make_message

BOT_ID = 4242


class Server:
    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [
                {"id": "test/model:free", "pricing": {"prompt": "0", "completion": "0"}, "context_length": 32000}]})
        self.calls.append(json.loads(request.content))
        return httpx.Response(200, json={"model": "test/model:free",
                                         "choices": [{"message": {"content": "Selam dostum!"}}]})


async def make_bot():
    bot = commands.Bot(command_prefix="!", intents=discord.Intents.default(), help_command=None)
    await bot._async_setup_hook()  # login olmadan loop/_ready kurulumu
    bot._connection.user = SimpleNamespace(id=BOT_ID, display_name="Bot-GAP")
    return bot


@pytest.fixture
async def env(tmp_path):
    bot = await make_bot()
    cfg = make_cfg(tmp_path)
    cog = AICog(bot, cfg)
    server = Server()
    cog.client = OpenRouterClient(cfg, transport=httpx.MockTransport(server))
    await bot.add_cog(cog)  # cog_load çalışır, komutlar bota kaydolur
    guild = FakeGuild()
    channel = guild.add_channel(name="genel")
    user = make_member(guild, name="ali")
    admin = make_member(guild, name="admin", admin=True)
    await cog._set_channel(guild.id, channel.id, "index", "1", admin.id)
    yield SimpleNamespace(bot=bot, cog=cog, server=server, guild=guild, channel=channel, user=user, admin=admin)
    await bot.remove_cog("AICog")


BOT_MENTION = SimpleNamespace(id=BOT_ID)


async def test_mention_triggers_reply_and_ingests(env):
    msg = make_message(env.guild, env.channel, env.user, f"<@{BOT_ID}> selam", mentions=[BOT_MENTION])
    await env.cog.on_message(msg)
    msg.reply.assert_awaited_once()
    args, kwargs = msg.reply.call_args
    assert args[0] == "Selam dostum!"
    assert kwargs["allowed_mentions"].everyone is False and kwargs["mention_author"] is False
    assert await env.cog.storage.get_message(msg.id) is not None
    assert len(env.server.calls) == 1


async def test_duplicate_event_processed_once(env):
    msg = make_message(env.guild, env.channel, env.user, f"<@{BOT_ID}> selam", mentions=[BOT_MENTION])
    await env.cog.on_message(msg)
    await env.cog.on_message(msg)
    assert len(env.server.calls) == 1


async def test_reply_to_bot_triggers(env):
    bot_msg = make_message(env.guild, env.channel, SimpleNamespace(id=BOT_ID, display_name="Bot-GAP"), "önceki cevap")
    ref = SimpleNamespace(resolved=bot_msg, message_id=bot_msg.id)
    msg = make_message(env.guild, env.channel, env.user, "devam et", reference=ref)
    await env.cog.on_message(msg)
    msg.reply.assert_awaited_once()
    assert "önceki cevap" in env.server.calls[0]["messages"][1]["content"]


async def test_plain_message_no_reply(env):
    msg = make_message(env.guild, env.channel, env.user, "sıradan mesaj")
    await env.cog.on_message(msg)
    msg.reply.assert_not_awaited()
    assert env.server.calls == []
    assert await env.cog.storage.get_message(msg.id) is not None


@pytest.mark.parametrize("kind", ["bot", "webhook", "dm"])
async def test_ignored_sources(env, kind):
    author = make_member(env.guild, bot=(kind == "bot"))
    msg = make_message(env.guild, env.channel, author, f"<@{BOT_ID}> selam", mentions=[BOT_MENTION],
                       webhook_id=123 if kind == "webhook" else None)
    if kind == "dm":
        msg.guild = None
    await env.cog.on_message(msg)
    msg.reply.assert_not_awaited()
    assert env.server.calls == []
    if kind != "dm":
        assert await env.cog.storage.get_message(msg.id) is None


async def test_commands_not_ingested_or_answered(env):
    msg = make_message(env.guild, env.channel, env.user, f"!xp <@{BOT_ID}>", mentions=[BOT_MENTION])
    await env.cog.on_message(msg)
    msg.reply.assert_not_awaited()
    assert await env.cog.storage.get_message(msg.id) is None


async def test_unindexed_channel_not_stored(env):
    other = env.guild.add_channel(name="sohbet")
    msg = make_message(env.guild, other, env.user, "burası indekslenmiyor")
    await env.cog.on_message(msg)
    assert await env.cog.storage.get_message(msg.id) is None


async def test_sensitive_redacted_on_ingest(env):
    msg = make_message(env.guild, env.channel, env.user, "mailim ali@example.com")
    await env.cog.on_message(msg)
    stored = await env.cog.storage.get_message(msg.id)
    assert "ali@example.com" not in stored.content


async def test_opt_out(env):
    ctx = make_ctx(env.guild, env.channel, env.user)
    await env.cog.aigizlilik_command.callback(env.cog, ctx, "kapat")
    msg = make_message(env.guild, env.channel, env.user, "kaydetme beni")
    await env.cog.on_message(msg)
    assert await env.cog.storage.get_message(msg.id) is None


async def test_command_mode_ignores_mentions(env):
    await env.cog._set_guild(env.guild.id, "response_mode", "command", env.admin.id)
    msg = make_message(env.guild, env.channel, env.user, f"<@{BOT_ID}> selam", mentions=[BOT_MENTION])
    await env.cog.on_message(msg)
    msg.reply.assert_not_awaited()


async def test_guild_disabled(env):
    await env.cog._set_guild(env.guild.id, "enabled", "0", env.admin.id)
    msg = make_message(env.guild, env.channel, env.user, f"<@{BOT_ID}> selam", mentions=[BOT_MENTION])
    await env.cog.on_message(msg)
    msg.reply.assert_not_awaited()
    assert await env.cog.storage.get_message(msg.id) is None


async def test_ai_command(env):
    ctx = make_ctx(env.guild, env.channel, env.user, "!ai selam")
    await env.cog.ai_command.callback(env.cog, ctx, mesaj="selam")
    ctx.send.assert_awaited()
    assert ctx.send.call_args.args[0] == "Selam dostum!"


async def test_edit_and_delete_sync(env):
    msg = make_message(env.guild, env.channel, env.user, "ilk hali")
    await env.cog.on_message(msg)
    await env.cog.on_raw_message_edit(SimpleNamespace(guild_id=env.guild.id, message_id=msg.id,
                                                      data={"content": "yeni hali"}))
    assert (await env.cog.storage.get_message(msg.id)).content == "yeni hali"
    await env.cog.on_raw_message_delete(SimpleNamespace(guild_id=env.guild.id, channel_id=env.channel.id,
                                                        message_id=msg.id))
    assert await env.cog.storage.get_message(msg.id) is None


async def test_unuttur_flow(env):
    msg = make_message(env.guild, env.channel, env.user, "bir mesaj")
    await env.cog.on_message(msg)
    await env.cog.memory.remember_user(env.guild.id, env.user.id, "kendim hakkında bilgi")
    ctx = make_ctx(env.guild, env.channel, env.user)
    await env.cog.unuttur_command.callback(env.cog, ctx, None)
    assert "unuttur onay" in ctx.send.call_args.args[0]
    assert await env.cog.storage.count_user_data(env.guild.id, env.user.id) == (1, 1)
    await env.cog.unuttur_command.callback(env.cog, ctx, "onay")
    assert await env.cog.storage.count_user_data(env.guild.id, env.user.id) == (0, 0)


async def test_hafiza_commands_and_ownership(env):
    ctx = make_ctx(env.guild, env.channel, env.user)
    await env.cog.hafizaekle_command.callback(env.cog, ctx, bilgi="En sevdiğim oyun Valorant")
    mems = await env.cog.storage.list_user_memories(env.guild.id, env.user.id)
    assert len(mems) == 1
    other = make_member(env.guild, name="veli")
    octx = make_ctx(env.guild, env.channel, other)
    await env.cog.unut_command.callback(env.cog, octx, mems[0].id)
    assert "sana ait değil" in octx.send.call_args.args[0]
    await env.cog.hafizam_command.callback(env.cog, ctx)
    sent = env.user.send.call_args.args[0]
    assert "Valorant" in sent
    await env.cog.unut_command.callback(env.cog, ctx, mems[0].id)
    assert await env.cog.storage.list_user_memories(env.guild.id, env.user.id) == []


async def test_hatirla_no_llm(env):
    msg = make_message(env.guild, env.channel, env.user, "cumartesi valorant turnuvası")
    await env.cog.on_message(msg)
    ctx = make_ctx(env.guild, env.channel, env.user)
    await env.cog.hatirla_command.callback(env.cog, ctx, sorgu="valorant turnuvası")
    embed = ctx.send.call_args.kwargs["embed"]
    assert "valorant" in embed.fields[0].value.lower()
    assert f"/{env.channel.id}/{msg.id}" in embed.fields[0].value
    assert env.server.calls == []


async def test_admin_commands_require_permission(env):
    ctx = make_ctx(env.guild, env.channel, env.user)
    with pytest.raises(commands.MissingPermissions):
        for check in env.cog.aiayar_group.checks:
            await discord.utils.maybe_coroutine(check, ctx)
    actx = make_ctx(env.guild, env.channel, env.admin)
    for check in env.cog.aiayar_group.checks:
        assert await discord.utils.maybe_coroutine(check, actx)
    # Alt komutlar grup kontrolünü devralır (grup çağrısı olmadan çalıştırılamaz)
    assert env.cog.aiayar_kanal.parent is env.cog.aiayar_group


async def test_admin_channel_toggle_posts_notice(env):
    other = env.guild.add_channel(name="oyun")
    ctx = make_ctx(env.guild, env.channel, env.admin)
    await env.cog.aiayar_kanal.callback(env.cog, ctx, "ekle", other)
    assert env.cog.is_indexed(env.guild.id, other.id)
    other.send.assert_awaited()
    assert "Bilgilendirme" in other.send.call_args.args[0]
    await env.cog.aiayar_kanal.callback(env.cog, ctx, "cikar", other)
    assert not env.cog.is_indexed(env.guild.id, other.id)


async def test_settings_persist_across_restart(env, tmp_path):
    cog2 = AICog(env.bot, env.cog.cfg)
    await cog2.cog_load()
    try:
        assert cog2.is_indexed(env.guild.id, env.channel.id)
    finally:
        await cog2.cog_unload()


async def test_listener_errors_are_contained(env, monkeypatch):
    monkeypatch.setattr(env.cog.storage, "insert_message", AsyncMock(side_effect=RuntimeError("disk dolu")))
    msg = make_message(env.guild, env.channel, env.user, "selam")
    await env.cog.on_message(msg)  # istisna dışarı sızmamalı


async def test_no_api_key_reports_unavailable(tmp_path):
    bot = await make_bot()
    cog = AICog(bot, make_cfg(tmp_path, api_key=""))
    await cog.cog_load()
    try:
        guild = FakeGuild()
        ch = guild.add_channel()
        user = make_member(guild)
        msg = make_message(guild, ch, user, f"<@{BOT_ID}> selam", mentions=[BOT_MENTION])
        await cog.on_message(msg)
        assert "API anahtarı" in msg.reply.call_args.args[0]
    finally:
        await cog.cog_unload()


async def test_storage_failure_degrades_gracefully(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    bot = await make_bot()
    cog = AICog(bot, make_cfg(tmp_path, db_path=blocker / "sub" / "ai.db"))
    await cog.cog_load()
    try:
        assert cog.storage is None and cog.storage_error
        assert cog.orchestrator is not None  # sohbet yine çalışabilir
        guild = FakeGuild()
        ctx = make_ctx(guild, guild.add_channel(), make_member(guild))
        await cog.hafizam_command.callback(cog, ctx)
        assert "kullanılamıyor" in ctx.send.call_args.args[0]
    finally:
        await cog.cog_unload()


def test_split_message():
    parts = split_message("a" * 4500)
    assert all(len(p) <= 1990 for p in parts) and "".join(parts) == "a" * 4500
    assert split_message("kısa") == ["kısa"]


async def test_guild_disabled_blocks_ai_but_not_privacy_commands(env):
    await env.cog.memory.remember_user(env.guild.id, env.user.id, "bir bilgi")
    await env.cog._set_guild(env.guild.id, "enabled", "0", env.admin.id)
    ctx = make_ctx(env.guild, env.channel, env.user)
    await env.cog.hatirla_command.callback(env.cog, ctx, sorgu="bilgi")
    assert "kapatıldı" in ctx.send.call_args.args[0]
    await env.cog.ai_command.callback(env.cog, ctx, mesaj="selam")
    assert "kapatıldı" in ctx.send.call_args.args[0]
    await env.cog.unuttur_command.callback(env.cog, ctx, "onay")
    assert "Silindi" in ctx.send.call_args.args[0]
    assert env.server.calls == []


@pytest.mark.parametrize("content", [
    "!aiayar", "!aiayar kanal ekle", "!aiayar ac", "!aiayar kapat", "!aiayar mod command",
    "!aiayar cooldown 0", "!aiayar saklama 1", "!aiayar bakim", "!aiayar yedekle",
])
async def test_admin_subcommands_denied_for_regular_users_via_dispatch(env, content, monkeypatch):
    """Gerçek komut dağıtımıyla: grup + alt komutlar yönetici olmayanlara kapalı."""
    monkeypatch.setattr(commands.Context, "send", AsyncMock())
    errors = []

    async def on_command_error(ctx, err):
        errors.append(err)

    env.bot.add_listener(on_command_error, "on_command_error")
    before = dict(env.cog._guild_settings.get(env.guild.id, {}))
    msg = make_message(env.guild, env.channel, env.user, content)
    ctx = await env.bot.get_context(msg)
    assert ctx.valid
    await env.bot.invoke(ctx)
    await asyncio.sleep(0.01)  # dispatch edilen hata olayları işlensin
    assert errors and isinstance(errors[0], commands.MissingPermissions)
    assert env.cog._guild_settings.get(env.guild.id, {}) == before

    # Yönetici aynı komutu çalıştırabilir
    errors.clear()
    actx = await env.bot.get_context(make_message(env.guild, env.channel, env.admin, content))
    await env.bot.invoke(actx)
    await asyncio.sleep(0.01)
    assert not errors


async def test_google_primary_end_to_end_and_status(tmp_path):
    from ai.google import GoogleAIClient

    def gserver(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "models/gemini-3.8-flash"}]})
        return httpx.Response(200, json={"model": "gemini-3.8-flash", "choices": [{"message": {"content": "Google burada!"}}],
                                         "usage": {"prompt_tokens": 1000, "completion_tokens": 100, "total_tokens": 1100}})

    bot = await make_bot()
    cfg = make_cfg(tmp_path, google_api_key="g-key", google_api_base="https://google.test/v1beta/openai")
    cog = AICog(bot, cfg)
    cog.client = OpenRouterClient(cfg, transport=httpx.MockTransport(Server()))
    cog.google_client = GoogleAIClient(cfg, transport=httpx.MockTransport(gserver))
    await bot.add_cog(cog)
    try:
        assert [c.provider_name for c in cog.provider.clients] == ["google", "openrouter"]
        guild = FakeGuild()
        ch = guild.add_channel()
        user = make_member(guild)
        msg = make_message(guild, ch, user, f"<@{BOT_ID}> selam", mentions=[BOT_MENTION])
        await cog.on_message(msg)
        assert msg.reply.call_args.args[0] == "Google burada!"
        ctx = make_ctx(guild, ch, user)
        await cog.aidurum_command.callback(cog, ctx)
        status = ctx.send.call_args.args[0]
        assert "Google AI" in status and "1/1000" in status and "~$0.001" in status
        assert "OpenRouter" in status
    finally:
        await bot.remove_cog("AICog")
