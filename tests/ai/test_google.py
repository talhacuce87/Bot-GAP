from __future__ import annotations

import json
import time

import httpx
import pytest

from ai.budget import BudgetError, RequestBudget
from ai.google import GoogleAIClient, merge_system_into_user, next_pacific_midnight, reasoning_effort_for
from ai.openrouter import AuthError, ModelUnavailableError, OpenRouterClient, PaidModelBlockedError, RateLimitedError
from ai.providers import ProviderChain
from tests.ai.conftest import make_cfg

MSGS = [{"role": "system", "content": "KURALLAR"}, {"role": "user", "content": "selam"}]
GOOGLE_MODELS = ["models/gemini-3.8-flash", "models/gemini-2.5-flash-lite", "models/gemma-4-31b-it"]


def gcfg(tmp_path=None, **kw):
    base = dict(google_api_key="g-key", google_model="gemini-3.8-flash", google_api_base="https://google.test/v1beta/openai")
    base.update(kw)
    return make_cfg(tmp_path, **base)


def g_ok(text="Merhaba!", model="gemini-3.8-flash", prompt=1000, completion=100, total=None):
    usage = {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": total or prompt + completion}
    return httpx.Response(200, json={"model": model, "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                                     "usage": usage})


def g_err(code, status, message, retry_delay=None, quota_id=None, as_list=True):
    details = []
    if quota_id:
        details.append({"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaId": quota_id}]})
    if retry_delay:
        details.append({"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry_delay})
    err = {"error": {"code": code, "message": message, "status": status, "details": details}}
    return httpx.Response(code, json=[err] if as_list else err)


class Server:
    def __init__(self, *responses, models=GOOGLE_MODELS):
        self.responses = list(responses)
        self.models = models
        self.calls: list[dict] = []
        self.auth: list[str] = []

    def __call__(self, request):
        self.auth.append(request.headers.get("Authorization", ""))
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"object": "list", "data": [{"id": m} for m in self.models]})
        self.calls.append(json.loads(request.content))
        return self.responses.pop(0)


def gclient(server, **kw):
    sleeps = []

    async def sleep(s):
        sleeps.append(s)

    return GoogleAIClient(gcfg(**kw), transport=httpx.MockTransport(server), sleep=sleep, rng=lambda: 0.5), sleeps


# ---------------------------------------------------------------------------
# Yardımcılar
# ---------------------------------------------------------------------------


def test_reasoning_effort_mapping():
    assert reasoning_effort_for("gemini-2.5-flash-lite", "auto") == "none"
    assert reasoning_effort_for("gemini-3.8-flash", "auto") == "minimal"
    assert reasoning_effort_for("gemini-3.1-flash-lite", "auto") == "minimal"
    assert reasoning_effort_for("gemma-4-31b-it", "auto") is None
    assert reasoning_effort_for("gemini-3.8-flash", "low") == "low"
    assert reasoning_effort_for("gemini-3.8-flash", "off") is None


def test_merge_system_for_gemma():
    merged = merge_system_into_user(MSGS)
    assert [m["role"] for m in merged] == ["user"]
    assert merged[0]["content"].startswith("KURALLAR") and merged[0]["content"].endswith("selam")
    assert MSGS[1]["content"] == "selam"  # orijinal liste değişmez


def test_next_pacific_midnight():
    t = next_pacific_midnight(time.time())
    assert 0 < t - time.time() <= 86400 + 3600


# ---------------------------------------------------------------------------
# İstemci
# ---------------------------------------------------------------------------


async def test_success_payload_auth_and_cost():
    server = Server(g_ok(prompt=1000, completion=100))
    client, _ = gclient(server)
    costs = []

    async def hook(model, err, tin, tout, cost=None):
        costs.append(cost)

    res = await client.chat(MSGS, on_attempt=hook)
    assert res.text == "Merhaba!"
    p = server.calls[0]
    assert p["model"] == "gemini-3.8-flash" and p["max_tokens"] == 800
    assert p["reasoning_effort"] == "minimal"
    assert "provider" not in p and "reasoning" not in p
    assert [m["role"] for m in p["messages"]] == ["system", "user"]
    assert all(a == "Bearer g-key" for a in server.auth)
    # 1000 × 0.75/1M + 100 × 3.75/1M
    assert costs == [pytest.approx(0.000375 + 0.00075)]
    assert client.circuit_reason() is None  # ücret raporu Google'ı kapatmaz


async def test_thinking_tokens_counted_as_output():
    server = Server(g_ok(prompt=1000, completion=100, total=1400))
    client, _ = gclient(server)
    res = await client.chat(MSGS)
    assert res.cost == pytest.approx((1000 * 0.75 + 400 * 3.75) / 1e6)


async def test_gemma_gets_merged_system_and_no_reasoning():
    server = Server(g_ok(model="gemma-4-31b-it"))
    client, _ = gclient(server, google_model="gemma-4-31b-it")
    await client.chat(MSGS)
    p = server.calls[0]
    assert [m["role"] for m in p["messages"]] == ["user"] and "reasoning_effort" not in p


@pytest.mark.parametrize("message", [
    "Please pass a valid API key",                       # gerçek yanıt (2026-10 canlı doğrulandı)
    "API key not valid. Please pass a valid API key.",
    "API key expired. Please renew the API key.",
])
async def test_invalid_key_opens_circuit(message):
    server = Server(g_err(400, "INVALID_ARGUMENT", message))
    client, sleeps = gclient(server)
    with pytest.raises(AuthError):
        await client.chat(MSGS)
    assert sleeps == [] and "reddedildi" in client.circuit_reason()


async def test_per_minute_429_uses_retry_delay():
    server = Server(
        g_err(429, "RESOURCE_EXHAUSTED", "Quota exceeded", retry_delay="7s",
              quota_id="GenerateRequestsPerMinutePerProjectPerModel"),
        g_ok(),
    )
    client, sleeps = gclient(server)
    res = await client.chat(MSGS)
    assert res.attempts == 2 and sleeps == [7.0]


async def test_per_day_429_cools_model_and_uses_fallback():
    server = Server(
        g_err(429, "RESOURCE_EXHAUSTED", "Quota exceeded", quota_id="GenerateRequestsPerDayPerProjectPerModel"),
        g_ok(model="gemini-2.5-flash-lite"),
    )
    client, sleeps = gclient(server, google_fallback_models="gemini-2.5-flash-lite")
    res = await client.chat(MSGS)
    assert res.model == "gemini-2.5-flash-lite" and sleeps == []
    assert "gemini-3.8-flash" in client.cooling_models()
    assert server.calls[1]["reasoning_effort"] == "none"


async def test_503_retried_and_dict_error_body():
    server = Server(g_err(503, "UNAVAILABLE", "The model is overloaded", as_list=False), g_ok())
    client, sleeps = gclient(server)
    assert (await client.chat(MSGS)).text == "Merhaba!" and len(sleeps) == 1


async def test_unknown_model_blocked_by_list():
    client, _ = gclient(Server(), google_model="gemini-9-imaginary")
    with pytest.raises(PaidModelBlockedError):
        await client.chat(MSGS)


async def test_404_model_unavailable():
    client, _ = gclient(Server(g_err(404, "NOT_FOUND", "models/x is not found")), )
    with pytest.raises(ModelUnavailableError):
        await client.chat(MSGS)


# ---------------------------------------------------------------------------
# Sağlayıcı zinciri + bütçe
# ---------------------------------------------------------------------------


class ORServer:
    def __init__(self):
        self.calls = 0

    def __call__(self, request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [
                {"id": "test/model:free", "pricing": {"prompt": "0", "completion": "0"}}]})
        self.calls += 1
        return httpx.Response(200, json={"model": "test/model:free", "choices": [{"message": {"content": "OR cevap"}}]})


def chain(tmp_path, gserver, storage=None, **kw):
    cfg = gcfg(tmp_path, **kw)
    budget = RequestBudget(cfg, storage)
    g = GoogleAIClient(cfg, transport=httpx.MockTransport(gserver))
    orsrv = ORServer()
    o = OpenRouterClient(cfg, transport=httpx.MockTransport(orsrv))
    return ProviderChain([g, o], budget), budget, orsrv


async def _call(pc, budget):
    async def hook(model, err, tin, tout, *, provider="openrouter", cost=None):
        await budget.record_attempt(1, 5, model, err, tin, tout, provider=provider, cost_usd=cost)
    return await pc.chat(MSGS, on_attempt=hook)


async def test_chain_google_primary(tmp_path):
    pc, budget, orsrv = chain(tmp_path, Server(g_ok()))
    res = await _call(pc, budget)
    assert res.text == "Merhaba!" and orsrv.calls == 0
    assert budget.provider_used("google") == 1 and budget.provider_cost("google") > 0
    assert pc.last_provider == "google"


async def test_chain_falls_back_to_openrouter_on_google_failure(tmp_path):
    pc, budget, orsrv = chain(tmp_path, Server(g_err(400, "INVALID_ARGUMENT", "API key not valid")))
    res = await _call(pc, budget)
    assert res.text == "OR cevap" and orsrv.calls == 1
    # Sonraki istekte Google devre dışı olduğundan hiç denenmez
    await _call(pc, budget)
    assert budget.provider_used("google") == 1


async def test_google_request_cap_skips_to_openrouter(tmp_path):
    gs = Server(g_ok())
    pc, budget, orsrv = chain(tmp_path, gs, google_daily_request_budget=1)
    await _call(pc, budget)
    res = await _call(pc, budget)
    assert res.text == "OR cevap" and len(gs.calls) == 1


async def test_google_cost_cap_skips_to_openrouter(tmp_path):
    gs = Server(g_ok(prompt=100_000, completion=1000))  # ~$0.079
    pc, budget, orsrv = chain(tmp_path, gs, google_daily_cost_limit_usd=0.05)
    await _call(pc, budget)
    assert not budget.provider_has_room("google")
    res = await _call(pc, budget)
    assert res.text == "OR cevap" and len(gs.calls) == 1


async def test_all_budgets_exhausted(tmp_path):
    pc, budget, _ = chain(tmp_path, Server(), google_daily_request_budget=0, daily_request_budget=0)
    with pytest.raises(BudgetError) as exc:
        budget.check(1, 10, 5)
    assert exc.value.code == "daily_budget"


async def test_budget_cost_persists_across_restart(tmp_path, storage):
    cfg = gcfg(tmp_path)
    b = RequestBudget(cfg, storage)
    await b.record_attempt(1, 5, "gemini-3.8-flash", None, 1000, 100, provider="google", cost_usd=0.01)
    await b.record_attempt(1, 5, "x:free", None, 1, 1, provider="openrouter")
    b2 = RequestBudget(cfg, storage)
    await b2.load()
    assert b2.provider_used("google") == 1 and b2.provider_used("openrouter") == 1
    assert b2.provider_cost("google") == pytest.approx(0.01)
    assert "google 1/1000" in b2.describe() and "$0.010" in b2.describe()


async def test_provider_order_and_keys():
    assert gcfg().providers == ["google", "openrouter"]
    assert gcfg(provider_order="openrouter,google").providers == ["openrouter", "google"]
    assert gcfg(api_key="").providers == ["google"]
    assert make_cfg().providers == ["openrouter"]


async def test_upstream_rate_limit_on_google_is_not_upstream_flagged():
    """Dakikalık Google 429'u aynı modelde Retry-After ile tekrar denenir (soğuma yok)."""
    server = Server(g_err(429, "RESOURCE_EXHAUSTED", "Quota exceeded", retry_delay="200s"))
    client, sleeps = gclient(server)
    with pytest.raises(RateLimitedError):
        await client.chat(MSGS)
    assert sleeps == [] and client.cooling_models() == {}  # 200 sn > bekleme sınırı → hemen vazgeç
