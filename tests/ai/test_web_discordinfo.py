from __future__ import annotations

import datetime as dt
import json
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import httpx
import pytest

from ai.budget import RequestBudget
from ai.discordinfo import gather_discord_info
from ai.google import GoogleAIClient, SafetyBlockedError, thinking_config
from ai.orchestrator import AIRequest, Orchestrator
from ai.persona import PersonaStore
from tests.ai.conftest import make_cfg, next_id

# ---------------------------------------------------------------------------
# Discord bilgisi
# ---------------------------------------------------------------------------


def role(name, members=(), default=False, managed=False):
    return NS(name=name, members=list(members), is_default=lambda: default, managed=managed)


def member(uid, display, name=None, bot=False):
    return NS(id=uid, display_name=display, name=name or display.lower(), bot=bot)


class Chan:
    def __init__(self, name, viewers=None, members=()):
        self.name, self.viewers, self.members = name, viewers, list(members)

    def permissions_for(self, who):
        return NS(view_channel=self.viewers is None or who.id in self.viewers)


def fake_guild():
    ali, veli, kaka, botm = member(1, "Ali"), member(2, "Veli"), member(3, "KAKA LEİTE", "kakaleite"), member(9, "Bot", bot=True)
    usta = role("Usta", [ali, veli])
    g = NS(
        id=500, name="GAP", owner_id=1, member_count=172, premium_tier=2, premium_subscription_count=7,
        created_at=dt.datetime(2021, 5, 1, tzinfo=dt.timezone.utc),
        roles=[role("@everyone", default=True), role("Bot Rolü", [botm], managed=True), usta, role("Efsane", [kaka])],
        members=[ali, veli, kaka, botm],
        text_channels=[Chan("genel"), Chan("yonetim", viewers={99})],
        voice_channels=[Chan("Oyun", members=[ali, botm]), Chan("Gizli Ses", viewers={99}, members=[veli])],
    )
    g.get_member = lambda uid: next((m for m in g.members if m.id == uid), None)
    return g, ali


def info(question, requester=None):
    g, ali = fake_guild()
    return gather_discord_info(g, requester or ali, question, 9, lambda gid, uid: [f"profil:{uid}"])


def test_server_info():
    lines = info("sunucu ne zaman kuruldu, sahibi kim")
    assert len(lines) == 1 and "01.05.2021" in lines[0] and "sahibi Ali" in lines[0] and "172 üye" in lines[0]
    assert "takviye seviyesi 2 (7 takviye)" in lines[0]


def test_roles_and_role_members():
    lines = info("sunucuda hangi roller var")
    assert "Usta (2)" in lines[0] and "Efsane (1)" in lines[0] and "Bot Rolü" not in lines[0]
    lines = info("usta rolünde kimler var")
    assert lines[0].startswith('"Usta" rolünde 2 üye var: Ali, Veli')


def test_channels_and_voice_respect_view_permission():
    lines = info("hangi kanallar var")
    assert "genel" in lines[0] and "yonetim" not in lines[0]
    lines = info("seste kim var")
    assert lines == ['Şu an "Oyun" ses kanalında: Ali.']  # bot ve görünmeyen kanal hariç


def test_online_unknown_and_named_member_profile():
    assert any("bilemem" in line for line in info("kaç kişi online"))
    assert info("kaka leite kim") == ["profil:3"]
    assert info("<@3> kim") == []  # etiketlenenler stats tarafında işlenir
    assert info("bugün hava nasıl") == []


# ---------------------------------------------------------------------------
# Google Search (native generateContent)
# ---------------------------------------------------------------------------


def web_ok(text="Dolar bugün 41,2 TL.", queries=("dolar kuru bugün",), chunks=(("bloomberght.com", "https://x.test/1"),)):
    return httpx.Response(200, json={
        "modelVersion": "gemini-3.8-flash",
        "candidates": [{
            "content": {"parts": [{"text": "düşünce", "thought": True}, {"text": text}]},
            "finishReason": "STOP",
            "groundingMetadata": {
                "webSearchQueries": list(queries),
                "groundingChunks": [{"web": {"title": t, "uri": u}} for t, u in chunks],
                "searchEntryPoint": {"renderedContent": "<div>…</div>"},
            },
        }],
        "usageMetadata": {"promptTokenCount": 1000, "toolUsePromptTokenCount": 500,
                          "candidatesTokenCount": 100, "thoughtsTokenCount": 50},
    })


class WebServer:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls: list[tuple[str, dict, dict]] = []

    def __call__(self, request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "models/gemini-3.8-flash"}]})
        self.calls.append((str(request.url), json.loads(request.content), dict(request.headers)))
        return self.responses.pop(0)


def gweb(server, **kw):
    cfg = make_cfg(google_api_key="g-key", google_native_base="https://google.test/v1beta",
                   google_api_base="https://google.test/v1beta/openai", **kw)

    async def no_sleep(_):
        return None

    return GoogleAIClient(cfg, transport=httpx.MockTransport(server), sleep=no_sleep), cfg


MSGS = [{"role": "system", "content": "KURALLAR"}, {"role": "user", "content": "dolar kaç"}]


async def test_web_chat_request_and_parsing():
    server = WebServer(web_ok())
    client, _ = gweb(server)
    ans = await client.web_chat(MSGS)
    url, body, headers = server.calls[0]
    assert url == "https://google.test/v1beta/models/gemini-3.8-flash:generateContent"
    assert headers["x-goog-api-key"] == "g-key"
    assert body["tools"] == [{"google_search": {}}]
    assert body["systemInstruction"]["parts"][0]["text"] == "KURALLAR"
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "low"}
    assert ans.text == "Dolar bugün 41,2 TL."  # düşünce parçası atlandı
    assert ans.queries == ["dolar kuru bugün"] and ans.sources == [("bloomberght.com", "https://x.test/1")]
    assert ans.input_tokens == 1500 and ans.output_tokens == 150
    assert ans.cost == pytest.approx((1500 * 0.75 + 150 * 3.75) / 1e6)


def test_thinking_config_mapping():
    assert thinking_config("gemini-2.5-flash", "none") == {"thinkingBudget": 0}
    assert thinking_config("gemini-2.5-flash", "low") == {"thinkingBudget": 1024}
    assert thinking_config("gemini-3.8-flash", "low") == {"thinkingLevel": "low"}
    assert thinking_config("gemini-3.8-flash", None) is None


async def test_web_chat_thinking_level_escalation_and_safety():
    reject = httpx.Response(400, json={"error": {"code": 400, "status": "INVALID_ARGUMENT",
                                                 "message": "Thinking level LOW is not supported for this model."}})
    server = WebServer(reject, web_ok())
    client, _ = gweb(server)
    await client.web_chat(MSGS)
    assert server.calls[1][1]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "medium"}

    blocked = httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}})
    client2, _ = gweb(WebServer(blocked))
    with pytest.raises(SafetyBlockedError):
        await client2.web_chat(MSGS)


# ---------------------------------------------------------------------------
# Orchestrator: /ara akışı
# ---------------------------------------------------------------------------


def web_req(**kw):
    base = dict(guild_id=1, guild_name="GAP", channel_id=10, channel_name="genel", user_id=5, speaker_name="ali",
                question="dolar kaç", allowed_channels=set(), channel_indexed=False, bot_id=999,
                message_id=next_id(), discord_info=["Sunucu bilgisi"])
    base.update(kw)
    return AIRequest(**base)


async def test_answer_web_budget_cost_and_no_caching(tmp_path, storage):
    server = WebServer(web_ok(queries=("q1", "q2")))
    client, cfg = gweb(server)
    budget = RequestBudget(cfg, storage)
    orch = Orchestrator(cfg, client=client, budget=budget, persona=PersonaStore(cfg.persona_dir), storage=storage)
    resp = await orch.answer_web(web_req(), client)
    assert resp.ok and resp.search_queries == ["q1", "q2"] and resp.web_sources
    assert budget.provider_used("google") == 1 and budget.provider_used("google_search") == 2
    assert budget.provider_cost("google") == pytest.approx(0.028 + (1500 * 0.75 + 150 * 3.75) / 1e6)
    assert len(orch.cache) == 0  # Google koşulları: arama sonucu saklanmaz
    prompt = server.calls[0][1]
    assert "Google Search aracın VAR" in prompt["systemInstruction"]["parts"][0]["text"]
    assert "Sunucu bilgisi" in prompt["contents"][0]["parts"][0]["text"]


async def test_answer_web_search_budget_exhausted(tmp_path, storage):
    client, cfg = gweb(WebServer(), google_daily_search_budget=0)
    orch = Orchestrator(cfg, client=client, budget=RequestBudget(cfg, storage),
                        persona=PersonaStore(cfg.persona_dir), storage=storage)
    resp = await orch.answer_web(web_req(), client)
    assert not resp.ok and resp.error_code == "search_budget"


# ---------------------------------------------------------------------------
# Cog: !ara sonucu herkese açık kanala değil DM'e gider
# ---------------------------------------------------------------------------


async def test_ara_prefix_sends_dm_only(tmp_path):
    from ai.cog import AICog
    from tests.ai.fakes import FakeGuild, make_ctx, make_member
    from tests.ai.test_cog import make_bot

    bot = await make_bot()
    server = WebServer(web_ok())
    cfg = make_cfg(tmp_path, google_api_key="g-key", google_native_base="https://google.test/v1beta",
                   google_api_base="https://google.test/v1beta/openai")
    cog = AICog(bot, cfg)
    cog.google_client = GoogleAIClient(cfg, transport=httpx.MockTransport(server))
    await bot.add_cog(cog)
    try:
        guild = FakeGuild()
        ch = guild.add_channel()
        user = make_member(guild)
        dm = NS(send=AsyncMock())
        user.create_dm = AsyncMock(return_value=dm)
        ctx = make_ctx(guild, ch, user, "!ara dolar kaç")
        await cog.ara_command.callback(cog, ctx, soru="dolar kaç")
        sent = dm.send.call_args.args[0]
        assert "41,2 TL" in sent and "Kaynaklar" in sent and "google.com/search?q=dolar+kuru+bug" in sent
        ch.send.assert_not_awaited()
        ctx.send.assert_not_awaited()  # kanala hiçbir şey yazılmadı
        ctx.message.add_reaction.assert_awaited_with("📬")
    finally:
        await bot.remove_cog("AICog")


async def test_ara_disabled_without_google(tmp_path):
    from ai.cog import AICog
    from tests.ai.fakes import FakeGuild, make_ctx, make_member
    from tests.ai.test_cog import make_bot

    bot = await make_bot()
    cog = AICog(bot, make_cfg(tmp_path))
    await bot.add_cog(cog)
    try:
        guild = FakeGuild()
        ctx = make_ctx(guild, guild.add_channel(), make_member(guild))
        await cog.ara_command.callback(cog, ctx, soru="x")
        assert "kapalı" in ctx.send.call_args.args[0]
    finally:
        await bot.remove_cog("AICog")
