from __future__ import annotations

import json
import time
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import httpx
import pytest

import database
from ai.budget import RequestBudget
from ai.google import GoogleAIClient
from ai.memory import MemoryService
from ai.openrouter import MAX_TOOL_ROUNDS
from ai.orchestrator import AIRequest, Orchestrator
from ai.persona import PersonaStore
from ai.retrieval import Retriever
from ai.stats import StatsService
from ai.tools import ToolContext, execute_tool, resolve_member, tool_specs
from tests.ai.conftest import add_msg, make_cfg, next_id

# ---------------------------------------------------------------------------
# Sahte sunucu
# ---------------------------------------------------------------------------


def member(uid, display, name=None):
    return NS(id=uid, display_name=display, name=name or display.lower(), bot=False)


def guild():
    ali, veli = member(100, "Ali"), member(200, "Veli Baba", "velibaba")
    g = NS(id=1, name="GAP", members=[ali, veli], roles=[], text_channels=[], voice_channels=[],
           owner_id=100, member_count=2, created_at=None)
    g.get_member = lambda uid: next((m for m in g.members if m.id == uid), None)
    return g, ali, veli


def test_resolve_member():
    g, ali, veli = guild()
    assert resolve_member(g, "ben", ali) is ali
    assert resolve_member(g, "<@200>", ali) is veli
    assert resolve_member(g, "veli", ali) is veli          # önek
    assert resolve_member(g, "VELİBABA", ali) is veli      # kullanıcı adı, Türkçe katlama
    assert resolve_member(g, "baba", ali) is veli          # alt dize
    assert resolve_member(g, "zeynep", ali) is None


# ---------------------------------------------------------------------------
# Sahte Google (OpenAI uyumlu uç nokta + araç çağrıları)
# ---------------------------------------------------------------------------


def tool_call(name, args, cid="call_1"):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)},
            "extra_content": {"google": {"thought_signature": "SIG-" + cid}}}


def g_tool(*calls):
    return httpx.Response(200, json={"model": "gemini-3.8-flash", "choices": [{
        "message": {"role": "assistant", "content": None, "tool_calls": list(calls)}, "finish_reason": "tool_calls"}],
        "usage": {"prompt_tokens": 900, "completion_tokens": 20, "total_tokens": 920}})


def g_text(text):
    return httpx.Response(200, json={"model": "gemini-3.8-flash", "choices": [{
        "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1000, "completion_tokens": 50, "total_tokens": 1050}})


def g_web(text="Galatasaray 2-1 kazandı."):
    return httpx.Response(200, json={"modelVersion": "gemini-3.8-flash", "candidates": [{
        "content": {"parts": [{"text": text}]}, "finishReason": "STOP",
        "groundingMetadata": {"webSearchQueries": ["galatasaray maç sonucu"],
                              "groundingChunks": [{"web": {"title": "ntvspor.net", "uri": "https://x.test/r"}}]}}],
        "usageMetadata": {"promptTokenCount": 800, "candidatesTokenCount": 60}})


class GServer:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.chat: list[dict] = []
        self.native: list[dict] = []

    def __call__(self, request):
        path = request.url.path
        if path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "models/gemini-3.8-flash"}]})
        body = json.loads(request.content)
        (self.native if path.endswith(":generateContent") else self.chat).append(body)
        return self.responses.pop(0)


@pytest.fixture
async def xp(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp.db")
    await database.init_db()
    await database.add_text_xp(1, 200, 700)
    return database


def build(tmp_path, storage, server, **cfg_kw):
    cfg = make_cfg(tmp_path, google_api_key="g-key", google_api_base="https://google.test/v1beta/openai",
                   google_native_base="https://google.test/v1beta", api_key="", **cfg_kw)
    google = GoogleAIClient(cfg, transport=httpx.MockTransport(server))
    budget = RequestBudget(cfg, storage)
    stats = StatsService(level_for=lambda xp: xp // 100, name_for=lambda uid: {100: "Ali", 200: "Veli Baba"}.get(uid, "?"))
    orch = Orchestrator(cfg, client=google, budget=budget, persona=PersonaStore(cfg.persona_dir), storage=storage,
                        retriever=Retriever(storage, neighbor_messages=0), memory=MemoryService(storage),
                        stats=stats, web_client=google)
    return orch, budget, cfg


def request(orch, question, *, allowed=frozenset(), web=True):
    g, ali, _ = guild()
    channel = NS(id=10)
    mid = next_id()
    ctx = ToolContext(
        guild=g, requester=ali, channel=channel, question=question, bot_id=999,
        allowed_channels=set(allowed), channel_indexed=True, message_id=mid,
        member_info=lambda gid, uid: [f"profil {uid}"], name_for=lambda uid, fb: fb or str(uid),
        channel_name_for=lambda cid: "genel", stats=orch.stats, retriever=orch.retriever, memory=orch.memory,
        web_available=web,
    )
    return AIRequest(guild_id=1, guild_name="GAP", channel_id=10, channel_name="genel", user_id=100,
                     speaker_name="Ali", question=question, allowed_channels=set(allowed), channel_indexed=True,
                     bot_id=999, message_id=mid, web_available=web, tool_context=ctx), ctx


# ---------------------------------------------------------------------------
# Araç döngüsü
# ---------------------------------------------------------------------------


async def test_model_picks_stats_tool_and_answers(tmp_path, storage, xp):
    server = GServer(g_tool(tool_call("get_member_stats", {"member": "veli"})), g_text("Veli Baba 7. seviyede!"))
    orch, budget, _ = build(tmp_path, storage, server)
    req, ctx = request(orch, "veli kaçıncı levelde ya")
    resp = await orch.answer(req)
    assert resp.ok and resp.text == "Veli Baba 7. seviyede!" and resp.tools_used == ["get_member_stats"]
    first, second = server.chat
    names = {t["function"]["name"] for t in first["tools"]}
    assert {"get_member_stats", "get_leaderboard", "web_search", "get_voice_activity"} <= names
    assert first["tool_choice"] == "auto"
    assert "<sunucu_verisi>" not in first["messages"][1]["content"]  # araç modunda ön-toplama yok
    # Asistan mesajı thought_signature ile aynen geri gönderildi; araç sonucu eklendi
    assistant, tool_msg = second["messages"][-2], second["messages"][-1]
    assert assistant["tool_calls"][0]["extra_content"]["google"]["thought_signature"] == "SIG-call_1"
    assert tool_msg["role"] == "tool" and tool_msg["tool_call_id"] == "call_1"
    assert "Seviye 7" in tool_msg["content"] and "700 XP" in tool_msg["content"]
    assert budget.used_today == 2  # her tur bütçeden düşer


async def test_tool_round_limit_forces_answer(tmp_path, storage, xp):
    loops = [g_tool(tool_call("get_server_info", {}, f"c{i}")) for i in range(MAX_TOOL_ROUNDS)]
    server = GServer(*loops, g_text("Tamam, bu kadar."))
    orch, _, _ = build(tmp_path, storage, server)
    req, _ = request(orch, "sunucuyu anlat")
    resp = await orch.answer(req)
    assert resp.text == "Tamam, bu kadar."
    assert server.chat[-1]["tool_choice"] == "none"


async def test_web_search_tool_returns_private_answer(tmp_path, storage, xp):
    server = GServer(g_tool(tool_call("web_search", {"query": "galatasaray son maç sonucu"})), g_web())
    orch, budget, _ = build(tmp_path, storage, server)
    req, _ = request(orch, "dün gs maçı kaç kaç bitti")
    resp = await orch.answer(req)
    assert resp.ok and resp.private and resp.text == "Galatasaray 2-1 kazandı."
    assert resp.web_sources == [("ntvspor.net", "https://x.test/r")]
    assert server.native[0]["tools"] == [{"google_search": {}}]
    assert "galatasaray son maç sonucu" in server.native[0]["contents"][0]["parts"][0]["text"]
    assert budget.provider_used("google_search") == 1
    assert len(orch.cache) == 0  # özel cevap önbelleğe yazılmaz


async def test_history_search_tool_gives_sources(tmp_path, storage, xp):
    mid = await add_msg(storage, "cumartesi valorant turnuvası var", channel=10, ts=time.time() - 3600)
    server = GServer(g_tool(tool_call("search_chat_history", {"query": "valorant turnuva"})),
                     g_text("Cumartesi turnuva var demiştiniz."))
    orch, _, _ = build(tmp_path, storage, server)
    req, _ = request(orch, "turnuva ne zamandı", allowed={10})
    resp = await orch.answer(req)
    assert resp.sources == [f"https://discord.com/channels/1/10/{mid}"]
    assert "cumartesi valorant" in server.chat[1]["messages"][-1]["content"]


async def test_history_tool_absent_without_authorized_channels(tmp_path, storage):
    orch, _, _ = build(tmp_path, storage, GServer())
    _, ctx = request(orch, "x", allowed=set(), web=False)
    names = {t["function"]["name"] for t in tool_specs(ctx)}
    assert "search_chat_history" not in names and "web_search" not in names


async def test_save_memory_explicit_vs_candidate(tmp_path, storage):
    orch, _, _ = build(tmp_path, storage, GServer())
    _, ctx = request(orch, "bunu hatırla: en sevdiğim oyun valorant")
    out = await execute_tool(ctx, "save_user_memory", json.dumps({"fact": "En sevdiği oyun Valorant"}))
    assert "Kaydedildi" in out.text
    assert [m.status for m in await storage.list_user_memories(1, 100)] == ["confirmed"]

    _, ctx2 = request(orch, "valorant çok iyi oyun")
    out = await execute_tool(ctx2, "save_user_memory", {"fact": "Valorant'ı çok seviyor"})
    assert "aday" in out.text and ctx2.candidate_ids
    statuses = sorted(m.status for m in await storage.list_user_memories(1, 100))
    assert statuses == ["candidate", "confirmed"]

    out = await execute_tool(ctx2, "save_user_memory", {"fact": "şifrem: 1234"})
    assert "Kaydedilmedi" in out.text


async def test_bad_tool_args_and_unknown_tool(tmp_path, storage):
    orch, _, _ = build(tmp_path, storage, GServer())
    _, ctx = request(orch, "x")
    assert "Bilinmeyen" in (await execute_tool(ctx, "drop_table", "{}")).text
    # bozuk JSON → boş argüman → konuşan kişinin kendisi çözülür, istisna yok
    assert "profil 100" in (await execute_tool(ctx, "get_member_profile", "{bozuk json")).text
    out = await execute_tool(ctx, "get_member_profile", {"member": "zeynep"})
    assert "bulunamadı" in out.text


async def test_fallback_model_without_tools_gets_prefetched_data(tmp_path, storage, xp):
    """Araç desteklemeyen sağlayıcı (OpenRouter ücretsiz model) eski ön-toplama yoluyla çalışır."""
    from ai.openrouter import OpenRouterClient

    calls = []

    def orserver(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "test/model:free", "pricing": {"prompt": "0", "completion": "0"}}]})
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"model": "test/model:free", "choices": [{"message": {"content": "ok"}}]})

    cfg = make_cfg(tmp_path)
    client = OpenRouterClient(cfg, transport=httpx.MockTransport(orserver))
    stats = StatsService(level_for=lambda xp: xp // 100, name_for=lambda uid: "Veli")
    orch = Orchestrator(cfg, client=client, budget=RequestBudget(cfg, storage), persona=PersonaStore(cfg.persona_dir),
                        storage=storage, stats=stats)
    req, _ = request(orch, "<@200> seviyesi kaç")
    resp = await orch.answer(req)
    assert resp.ok and "tools" not in calls[0]
    assert "<sunucu_verisi>" in calls[0]["messages"][1]["content"] and "Seviye 7" in calls[0]["messages"][1]["content"]


# ---------------------------------------------------------------------------
# Cog: etiketle sorulan soruda model internete bakarsa cevap DM'e gider
# ---------------------------------------------------------------------------


async def test_mention_web_answer_goes_to_dm(tmp_path, xp):
    from ai.cog import AICog
    from tests.ai.fakes import FakeGuild, make_member, make_message
    from tests.ai.test_cog import BOT_ID, BOT_MENTION, make_bot

    server = GServer(g_tool(tool_call("web_search", {"query": "dolar kuru"})), g_web("Dolar 41 TL."))
    bot = await make_bot()
    cfg = make_cfg(tmp_path, google_api_key="g-key", google_api_base="https://google.test/v1beta/openai",
                   google_native_base="https://google.test/v1beta", api_key="")
    cog = AICog(bot, cfg)
    cog.google_client = GoogleAIClient(cfg, transport=httpx.MockTransport(server))
    await bot.add_cog(cog)
    try:
        g = FakeGuild()
        ch = g.add_channel()
        user = make_member(g)
        dm = NS(send=AsyncMock())
        user.create_dm = AsyncMock(return_value=dm)
        msg = make_message(g, ch, user, f"<@{BOT_ID}> dolar ne kadar", mentions=[BOT_MENTION])
        await cog.on_message(msg)
        assert "Dolar 41 TL." in dm.send.call_args.args[0] and "Kaynaklar" in dm.send.call_args.args[0]
        public = msg.reply.call_args.args[0]
        assert "DM" in public and "41" not in public  # kanala sonuç yazılmadı
    finally:
        await bot.remove_cog("AICog")
