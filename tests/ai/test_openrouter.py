from __future__ import annotations

import json
import time

import httpx
import pytest

from ai.openrouter import (
    AuthError, BudgetDeniedError, CircuitOpenError, ContextLengthError, EmptyResponseError,
    MalformedResponseError, OpenRouterClient, PaidModelBlockedError,
    ProviderTimeoutError, ProviderUnavailableError, QuotaExhaustedError, RateLimitedError,
    looks_like_leaked_reasoning, pricing_is_free, strip_reasoning,
)
from tests.ai.conftest import make_cfg

FREE = {"prompt": "0", "completion": "0"}
PAID = {"prompt": "0.000001", "completion": "0.000002"}
MSGS = [{"role": "user", "content": "selam"}]


def ok_body(text="Selam!", model="test/model:free", cost=None):
    usage = {"prompt_tokens": 12, "completion_tokens": 3}
    if cost is not None:
        usage["cost"] = cost
    return {"model": model, "choices": [{"message": {"content": text}, "finish_reason": "stop"}], "usage": usage}


class Server:
    """Sıralı yanıt kuyruğu olan sahte OpenRouter."""

    def __init__(self, responses, models=None):
        self.responses = list(responses)
        self.models = models if models is not None else [
            {"id": "test/model:free", "pricing": FREE, "context_length": 8000},
            {"id": "fallback/model:free", "pricing": FREE, "context_length": 8000},
            {"id": "paid/model", "pricing": PAID, "context_length": 8000},
        ]
        self.chat_calls: list[dict] = []
        self.models_calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            self.models_calls += 1
            if isinstance(self.models, Exception):
                raise self.models
            return httpx.Response(200, json={"data": self.models})
        if request.url.path.endswith("/key"):
            return httpx.Response(200, json={"data": {"is_free_tier": True, "label": "x",
                                                      "free_model_daily_requests": {"used": 3, "limit": 50, "remaining": 47}}})
        assert request.headers["Authorization"] == "Bearer test-key"
        self.chat_calls.append(json.loads(request.content))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make_client(server, **cfg_overrides):
    sleeps: list[float] = []
    clock = FakeClock()

    async def fake_sleep(s):
        sleeps.append(s)
        clock.t += s

    client = OpenRouterClient(
        make_cfg(**cfg_overrides), transport=httpx.MockTransport(server),
        sleep=fake_sleep, rng=lambda: 0.5, clock=clock,
    )
    return client, sleeps


async def test_success_and_payload():
    server = Server([httpx.Response(200, json=ok_body())])
    client, _ = make_client(server)
    attempts = []

    async def hook(model, err, tin, tout):
        attempts.append((model, err, tin, tout))

    res = await client.chat(MSGS, on_attempt=hook)
    assert res.text == "Selam!" and res.attempts == 1 and res.input_tokens == 12
    assert attempts == [("test/model:free", None, 12, 3)]
    payload = server.chat_calls[0]
    assert payload["model"] == "test/model:free"
    assert payload["max_tokens"] == 350
    assert payload["provider"] == {"max_price": {"prompt": 0, "completion": 0}}
    assert payload["reasoning"] == {"enabled": False}  # sohbet için akıl yürütme kapalı
    await client.aclose()


async def test_content_parts_list():
    body = ok_body()
    body["choices"][0]["message"]["content"] = [{"type": "text", "text": "par"}, {"type": "text", "text": "ça"}]
    client, _ = make_client(Server([httpx.Response(200, json=body)]))
    assert (await client.chat(MSGS)).text == "parça"


async def test_empty_response_retried_then_fails():
    server = Server([httpx.Response(200, json=ok_body(text="")) for _ in range(3)])
    client, sleeps = make_client(server)
    with pytest.raises(EmptyResponseError):
        await client.chat(MSGS)
    assert len(server.chat_calls) == 3 and len(sleeps) == 2


async def test_invalid_credentials_opens_circuit():
    server = Server([httpx.Response(401, json={"error": {"code": 401, "message": "No auth"}})])
    client, sleeps = make_client(server)
    with pytest.raises(AuthError):
        await client.chat(MSGS)
    assert sleeps == []  # yeniden denenmez
    with pytest.raises(CircuitOpenError):
        await client.chat(MSGS)
    assert len(server.chat_calls) == 1
    assert "401" in client.circuit_reason() or "reddedildi" in client.circuit_reason()


async def test_429_respects_retry_after():
    server = Server([
        httpx.Response(429, headers={"Retry-After": "3"}, json={"error": {"code": 429, "message": "Rate limit exceeded"}}),
        httpx.Response(200, json=ok_body()),
    ])
    client, sleeps = make_client(server)
    res = await client.chat(MSGS)
    assert res.attempts == 2 and sleeps == [3.0]


async def test_429_retry_after_too_long_fails_fast():
    server = Server([httpx.Response(429, headers={"Retry-After": "600"},
                                    json={"error": {"code": 429, "message": "Rate limit exceeded"}})])
    client, sleeps = make_client(server)
    with pytest.raises(RateLimitedError):
        await client.chat(MSGS)
    assert sleeps == []


async def test_free_daily_quota_exhausted():
    reset_ms = int((time.time() + 5 * 3600) * 1000)
    server = Server([httpx.Response(
        429,
        headers={"X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(reset_ms)},
        json={"error": {"code": 429, "message": "Rate limit exceeded: free-models-per-day"}},
    )])
    client, sleeps = make_client(server)
    with pytest.raises(QuotaExhaustedError):
        await client.chat(MSGS)
    assert sleeps == []
    assert client.quota_blocked_until == pytest.approx(reset_ms / 1000, abs=1)
    with pytest.raises(CircuitOpenError) as exc:
        await client.chat(MSGS)
    assert "kota" in exc.value.user_message


async def test_500_retries_then_fails():
    server = Server([httpx.Response(500, json={"error": {"code": 500, "message": "boom"}}) for _ in range(3)])
    client, sleeps = make_client(server)
    with pytest.raises(ProviderUnavailableError):
        await client.chat(MSGS)
    assert len(server.chat_calls) == 3
    assert sleeps == [1.5, 3.0]  # üstel, rng=0.5 → jitter çarpanı 1.0


async def test_timeout():
    server = Server([httpx.ReadTimeout("t"), httpx.ReadTimeout("t"), httpx.ReadTimeout("t")])
    client, _ = make_client(server)
    with pytest.raises(ProviderTimeoutError):
        await client.chat(MSGS)


async def test_malformed_json():
    server = Server([httpx.Response(200, content=b"<html>oops</html>") for _ in range(3)])
    client, _ = make_client(server)
    with pytest.raises(MalformedResponseError):
        await client.chat(MSGS)


async def test_error_inside_200_body():
    server = Server([httpx.Response(200, json={"error": {"code": 502, "message": "upstream"}})] * 3)
    client, _ = make_client(server)
    with pytest.raises(ProviderUnavailableError):
        await client.chat(MSGS)


async def test_context_length_not_retried():
    server = Server([httpx.Response(400, json={"error": {"code": 400, "message": "This model's maximum context length is 8000 tokens"}})])
    client, sleeps = make_client(server)
    with pytest.raises(ContextLengthError):
        await client.chat(MSGS)
    assert sleeps == []


async def test_model_unavailable_uses_free_fallback():
    server = Server([
        httpx.Response(404, json={"error": {"code": 404, "message": "No endpoints found"}}),
        httpx.Response(200, json=ok_body(model="fallback/model:free")),
    ])
    client, _ = make_client(server, fallback_model="fallback/model:free")
    res = await client.chat(MSGS)
    assert res.model == "fallback/model:free" and res.requested_model == "fallback/model:free"
    assert [c["model"] for c in server.chat_calls] == ["test/model:free", "fallback/model:free"]


async def test_paid_fallback_never_used():
    server = Server([httpx.Response(404, json={"error": {"code": 404, "message": "No endpoints"}})])
    client, _ = make_client(server, fallback_model="paid/model")
    with pytest.raises(PaidModelBlockedError):
        await client.chat(MSGS)
    assert [c["model"] for c in server.chat_calls] == ["test/model:free"]


async def test_paid_primary_blocked():
    server = Server([])
    client, _ = make_client(server, model="paid/model")
    with pytest.raises(PaidModelBlockedError):
        await client.chat(MSGS)
    assert server.chat_calls == []


async def test_unknown_model_blocked_but_free_suffix_trusted_when_metadata_down():
    server = Server([httpx.Response(200, json=ok_body())], models=httpx.ConnectError("down"))
    client, _ = make_client(server)
    assert (await client.chat(MSGS)).text == "Selam!"   # ':free' kuralı
    client2, _ = make_client(Server([], models=httpx.ConnectError("down")), model="vendor/unknown")
    with pytest.raises(PaidModelBlockedError):
        await client2.chat(MSGS)


async def test_variable_price_router_is_not_free():
    assert pricing_is_free(FREE)
    assert not pricing_is_free({"prompt": "-1", "completion": "-1"})
    assert not pricing_is_free(PAID)
    assert not pricing_is_free({})
    assert not pricing_is_free({"prompt": "abc"})


async def test_reported_cost_disables_provider():
    server = Server([httpx.Response(200, json=ok_body(cost=0.002))])
    client, _ = make_client(server)
    await client.chat(MSGS)
    assert client.circuit_reason() and "ücretli" in client.circuit_reason()
    with pytest.raises(CircuitOpenError):
        await client.chat(MSGS)


async def test_budget_gate_stops_retries():
    server = Server([httpx.Response(500, json={}) for _ in range(3)])
    client, _ = make_client(server)

    async def deny():
        return False

    with pytest.raises(BudgetDeniedError):
        await client.chat(MSGS, attempt_gate=deny)
    assert len(server.chat_calls) == 1


async def test_retry_budget_exhausted_total_deadline():
    server = Server([httpx.Response(503, json={}) for _ in range(10)])
    client, _ = make_client(server, max_retries=5, total_deadline_seconds=10.0)
    with pytest.raises((ProviderUnavailableError, ProviderTimeoutError)):
        await client.chat(MSGS)
    assert len(server.chat_calls) < 6


async def test_missing_api_key():
    client, _ = make_client(Server([]), api_key="")
    with pytest.raises(CircuitOpenError):
        await client.chat(MSGS)


async def test_key_status_only_safe_fields():
    client, _ = make_client(Server([]))
    status = await client.key_status()
    assert status == {"is_free_tier": True, "free_model_daily_requests": {"used": 3, "limit": 50, "remaining": 47}}


async def test_model_metadata_cached():
    server = Server([httpx.Response(200, json=ok_body()), httpx.Response(200, json=ok_body())])
    client, _ = make_client(server)
    await client.chat(MSGS)
    await client.chat(MSGS)
    assert server.models_calls == 1
    assert client.model_info("test/model:free").context_length == 8000


LEAK = """Here's a thinking process:

Analyze User Input:
Server: GAP | Channel: #bot-komut | Time: 08.10.2026 20:35 (TSİ)
Speaking user: peaZ
User message: "selam"
Identify Key Elements from the Prompt/System:"""


def test_leak_detection_and_think_stripping():
    assert looks_like_leaked_reasoning(LEAK)
    assert looks_like_leaked_reasoning("Okay, so the user is greeting me. I should reply.")
    assert looks_like_leaked_reasoning("Selam! <kullanici_mesaji> falan")
    assert not looks_like_leaked_reasoning("Selam peaZ! Nasılsın? 😄")
    assert not looks_like_leaked_reasoning("Kullanıcı adın çok havalı bu arada")
    assert strip_reasoning("<think>uzun düşünme</think>\nSelam!") == "Selam!"
    assert strip_reasoning("Selam! <think>yarım kalan düşünme") == "Selam!"


async def test_leaked_reasoning_never_returned_and_retried():
    server = Server([
        httpx.Response(200, json=ok_body(text=LEAK)),
        httpx.Response(200, json=ok_body(text="<think>hmm</think>Selam peaZ! 👋")),
    ])
    client, _ = make_client(server)
    res = await client.chat(MSGS)
    assert res.text == "Selam peaZ! 👋" and res.attempts == 2


async def test_leaked_reasoning_exhausts_to_error_not_text():
    server = Server([httpx.Response(200, json=ok_body(text=LEAK)) for _ in range(3)])
    client, _ = make_client(server)
    with pytest.raises(EmptyResponseError):
        await client.chat(MSGS)


async def test_reasoning_not_disabled_for_mandatory_models():
    models = [{"id": "test/model:free", "pricing": FREE, "context_length": 8000, "reasoning": {"mandatory": True}}]
    server = Server([httpx.Response(200, json=ok_body())], models=models)
    client, _ = make_client(server)
    await client.chat(MSGS)
    assert "reasoning" not in server.chat_calls[0]


async def test_reasoning_effort_override():
    server = Server([httpx.Response(200, json=ok_body())])
    client, _ = make_client(server, reasoning_effort="low")
    await client.chat(MSGS)
    assert server.chat_calls[0]["reasoning"] == {"effort": "low", "exclude": True}


def upstream_429(retry_after=None):
    headers = {"Retry-After": str(retry_after)} if retry_after else {}
    return httpx.Response(429, headers=headers, json={"error": {
        "code": 429, "message": "Provider returned error",
        "metadata": {"provider_name": "Google AI Studio", "raw": "quota"}}})


async def test_upstream_429_skips_retries_and_uses_fallback_chain():
    models = [
        {"id": "test/model:free", "pricing": FREE, "context_length": 8000},
        {"id": "second/model:free", "pricing": FREE, "context_length": 8000},
        {"id": "third/model:free", "pricing": FREE, "context_length": 8000},
    ]
    server = Server([upstream_429(), upstream_429(), httpx.Response(200, json=ok_body(model="third/model:free"))],
                    models=models)
    client, sleeps = make_client(server, fallback_model="second/model:free, third/model:free")
    res = await client.chat(MSGS)
    assert res.model == "third/model:free"
    assert [c["model"] for c in server.chat_calls] == ["test/model:free", "second/model:free", "third/model:free"]
    assert sleeps == []  # aynı model tekrar denenmedi, beklenmedi
    assert set(client.cooling_models()) == {"test/model:free", "second/model:free"}

    # Sonraki istek soğumadaki modelleri hiç denemeden doğrudan çalışan modele gider
    server.responses.append(httpx.Response(200, json=ok_body(model="third/model:free")))
    await client.chat(MSGS)
    assert server.chat_calls[-1]["model"] == "third/model:free" and len(server.chat_calls) == 4


async def test_upstream_cooldown_expires_and_respects_retry_after():
    server = Server([upstream_429(retry_after=30), httpx.Response(200, json=ok_body()),
                     httpx.Response(200, json=ok_body())])
    client, _ = make_client(server, fallback_model="fallback/model:free")
    await client.chat(MSGS)
    assert client.cooling_models() == {"test/model:free": 30}
    client._clock.t += 31
    await client.chat(MSGS)
    assert server.chat_calls[-1]["model"] == "test/model:free"


async def test_all_models_cooling_still_tries():
    server = Server([upstream_429(), httpx.Response(200, json=ok_body())])
    client, _ = make_client(server)
    with pytest.raises(RateLimitedError):
        await client.chat(MSGS)
    await client.chat(MSGS)  # tek model soğumada olsa da denenir (atlanacak alternatif yok)
    assert len(server.chat_calls) == 2


async def test_openrouter_own_429_still_retried():
    server = Server([
        httpx.Response(429, headers={"Retry-After": "2"}, json={"error": {"code": 429, "message": "Rate limit exceeded"}}),
        httpx.Response(200, json=ok_body()),
    ])
    client, sleeps = make_client(server)
    await client.chat(MSGS)
    assert sleeps == [2.0] and client.cooling_models() == {}
