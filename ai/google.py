"""
ai/google.py — Google AI Studio (Gemini API) istemcisi, OpenAI uyumlu uç nokta üzerinden.

ÜCRETLİ OLABİLİR: Faturalandırması açık bir projenin anahtarıyla her istek
ücretlendirilir. GOOGLE_AI_API_KEY verilmesi bilinçli bir tercih sayılır;
harcama budget.py'deki günlük istek ve tahmini USD sınırlarıyla kesilir.
Maliyet, yanıttaki token sayıları × .env'deki birim fiyatlarla tahmin edilir
(Google bu uç noktada ücret raporlamaz).

OpenRouterClient'ın yeniden deneme / yedek model / soğuma döngüsü aynen
kullanılır; burada yalnızca sağlayıcıya özgü kısımlar vardır:
  - kimlik doğrulama, model listesi, düşünme (thinking) ayarı
  - Gemma modellerinde "system" rolü desteklenmediği için sistem mesajı
    kullanıcı mesajına katlanır
  - Google hata biçimi (RESOURCE_EXHAUSTED, retryDelay, API_KEY_INVALID)
"""

from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass, field
import logging
import re
import time
from typing import Any

import httpx

# Model bir düşünme seviyesini reddederse sırayla denenecek bir sonraki değer (None = parametreyi gönderme).
_EFFORT_ESCALATION: dict[str | None, str | None] = {"none": "minimal", "minimal": "low", "low": "medium", "medium": None}
_THINKING_REJECTED_RE = re.compile(r"thinking (level|budget)|reasoning[_ ]effort", re.IGNORECASE)

from ai.openrouter import (
    AUTH_CIRCUIT_SECONDS, MODEL_METADATA_TTL_SECONDS, AuthError, CircuitOpenError, ContextLengthError,
    EmptyResponseError, MalformedResponseError, ModelInfo, ModelUnavailableError, OpenRouterClient,
    PaymentRequiredError, ProviderError, ProviderTimeoutError, ProviderUnavailableError, RateLimitedError,
    _parse_retry_after, strip_reasoning,
)

log = logging.getLogger("gap.ai.google")

try:
    from zoneinfo import ZoneInfo

    _PACIFIC = ZoneInfo("America/Los_Angeles")
except Exception:  # tzdata yoksa kaba yaklaşım: UTC-8
    _PACIFIC = dt.timezone(dt.timedelta(hours=-8))

_RETRY_DELAY_RE = re.compile(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"')


def next_pacific_midnight(now: float | None = None) -> float:
    """Google günlük kotaları Pasifik saatiyle gece yarısı sıfırlanır."""
    local = dt.datetime.fromtimestamp(now if now is not None else time.time(), _PACIFIC)
    tomorrow = (local + dt.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return tomorrow.timestamp()


def reasoning_effort_for(model: str, configured: str) -> str | None:
    """
    Gönderilecek reasoning_effort değeri (None = gönderme).
    auto: Gemini 2.5 → "none" (düşünme kapalı); Gemini 3+ düşünme kapatılamaz → "low"
    (bazı 3.x modelleri "minimal"i reddeder; canlı doğrulandı: gemini-3.8-flash);
    Gemma ve diğerleri → gönderilmez.
    """
    if configured and configured != "auto":
        return None if configured in {"off", "omit", "-"} else configured
    m = model.lower().removeprefix("models/")
    if m.startswith("gemini-2.5"):
        return "none"
    if re.match(r"gemini-([3-9]|\d{2,})", m):
        return "low"
    return None


def merge_system_into_user(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    """Sistem mesajlarını ilk kullanıcı mesajının başına katlar (system rolü olmayan modeller için)."""
    system = "\n\n".join(m["content"] for m in messages if m.get("role") == "system")
    rest = [dict(m) for m in messages if m.get("role") != "system"]
    if not system:
        return rest
    for m in rest:
        if m.get("role") == "user":
            m["content"] = f"{system}\n\n---\n\n{m['content']}"
            return rest
    return [{"role": "user", "content": system}, *rest]


_LEVEL_TO_BUDGET = {"minimal": 512, "low": 1024, "medium": 8192, "high": 24576}


def thinking_config(model: str, effort: str | None) -> dict[str, Any] | None:
    """Native API thinkingConfig: Gemini 2.5 bütçe (token), Gemini 3+ seviye kullanır."""
    if effort is None:
        return None
    m = model.lower()
    if m.startswith("gemini-2.5"):
        return {"thinkingBudget": 0 if effort == "none" else _LEVEL_TO_BUDGET.get(effort, 1024)}
    if effort == "none":
        return None
    return {"thinkingLevel": effort}


class SafetyBlockedError(ProviderError):
    code = "safety_blocked"
    user_message = "Bu isteği güvenlik filtreleri nedeniyle cevaplayamıyorum."


@dataclass
class WebAnswer:
    text: str
    model: str
    sources: list[tuple[str, str]] = field(default_factory=list)  # (başlık, url)
    queries: list[str] = field(default_factory=list)              # Google'da yapılan aramalar
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost: float | None = None                                     # yalnızca model token maliyeti


class ThinkingLevelRejectedError(ProviderError):
    """Model istenen düşünme seviyesini reddetti; seviye yükseltildi, hemen tekrar denenebilir."""
    code = "thinking_level"
    retryable = True


class GoogleAIClient(OpenRouterClient):
    provider_name = "google"
    label = "Google AI"
    key_env = "GOOGLE_AI_API_KEY"

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._available_models: set[str] = set()
        # Modelin reddettiği düşünme seviyesinden sonra öğrenilen değer (süreç boyunca hatırlanır).
        self._effort_override: dict[str, str | None] = {}

    def _effort(self, model: str) -> str | None:
        if model in self._effort_override:
            return self._effort_override[model]
        return reasoning_effort_for(model, self.cfg.google_reasoning_effort)

    # --- Kancalar ---------------------------------------------------------

    def _api_key(self) -> str:
        return self.cfg.google_api_key

    def _base_url(self) -> str:
        return self.cfg.google_api_base

    def _default_headers(self) -> dict[str, str]:
        return {}

    def _default_max_tokens(self) -> int:
        return self.cfg.google_max_output_tokens

    def model_chain(self) -> list[str]:
        chain = [self.cfg.google_model, *(m.strip() for m in self.cfg.google_fallback_models.split(","))]
        return list(dict.fromkeys(m for m in chain if m))

    def _compute_cost(self, model: str, usage: dict[str, Any]) -> float | None:
        """Token × birim fiyat. Düşünme tokenları çıktı sayılır; belirsizlikte yüksek tahmin edilir."""
        prompt = int(usage.get("prompt_tokens") or 0)
        completion = int(usage.get("completion_tokens") or 0)
        details = usage.get("completion_tokens_details") or {}
        reasoning = int(details.get("reasoning_tokens") or 0) if isinstance(details, dict) else 0
        total = int(usage.get("total_tokens") or 0)
        output = max(completion + reasoning, total - prompt)
        if not prompt and not output:
            return None
        return (prompt * self.cfg.google_price_input_per_m + output * self.cfg.google_price_output_per_m) / 1_000_000

    def _on_cost(self, cost: float | None, model: str) -> None:
        # Ücret beklenen durum; sınır budget.py'de uygulanır.
        return None

    async def key_status(self) -> dict[str, Any] | None:
        return None

    # --- Model listesi ----------------------------------------------------

    async def refresh_models(self, force: bool = False) -> bool:
        async with self._models_lock:
            if not force and self._available_models and self._clock() - self._models_fetched_at < MODEL_METADATA_TTL_SECONDS:
                return True
            try:
                resp = await self._client.get("/models", headers=self._auth_headers())
                resp.raise_for_status()
                data = resp.json().get("data", [])
            except (httpx.HTTPError, ValueError, AttributeError) as err:
                log.warning("Google model listesi alınamadı: %s", type(err).__name__)
                return False
            ids = {
                str(item.get("id", "")).removeprefix("models/")
                for item in data if isinstance(item, dict) and item.get("id")
            }
            self._available_models = ids
            self._models = {m: ModelInfo(id=m, context_length=None) for m in self.model_chain() if m in ids}
            self._models_fetched_at = self._clock()
            missing = [m for m in self.model_chain() if m not in ids]
            if missing:
                sample = ", ".join(sorted(i for i in ids if i.startswith(("gemini", "gemma")))[:15])
                log.warning("Google model listesinde bulunamadı: %s — mevcut örnekler: %s", ", ".join(missing), sample)
            return True

    async def check_model_allowed(self, model: str) -> tuple[bool, str]:
        fetched = await self.refresh_models()
        if fetched and self._available_models and model not in self._available_models:
            return False, "Google model listesinde yok (GOOGLE_AI_MODEL adını kontrol et)"
        return True, "Google AI (ücretli olabilir; günlük istek/USD sınırı uygulanır)"

    # --- İstek ------------------------------------------------------------

    def _payload(self, model: str, messages: list[dict[str, str]], max_tokens: int) -> dict[str, Any]:
        if model.lower().startswith("gemma"):
            messages = merge_system_into_user(messages)
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": self.cfg.temperature,
        }
        effort = self._effort(model)
        if effort:
            payload["reasoning_effort"] = effort
        self._last_payload_model = model
        return payload

    def _raise_for_error(self, resp: httpx.Response, status: int, error_obj: Any) -> None:
        message = ""
        g_status = ""
        if isinstance(error_obj, dict):
            message = str(error_obj.get("message") or "")
            g_status = str(error_obj.get("status") or "")
            code = error_obj.get("code")
            if isinstance(code, int) and status < 400:
                status = code
        raw = resp.text[:4000] if resp.content else ""
        detail = f"HTTP {status} {g_status}: {message[:200]}".strip()
        log.warning("Google AI hata %s", detail)
        low = f"{message} {raw}".lower()

        if status in (401, 403) or any(k in low for k in (
            "api_key_invalid", "api key not valid", "valid api key", "api key expired", "api_key_expired",
        )):
            self._auth_blocked_until = self._clock() + AUTH_CIRCUIT_SECONDS
            raise AuthError(detail, status=status)
        if status == 402 or ("billing" in low and status == 400):
            raise PaymentRequiredError(detail, status=status)
        if status == 404:
            raise ModelUnavailableError(detail, status=status)
        if status == 413 or (status == 400 and (
            "token count" in low or "maximum number of tokens" in low or "context" in low and "exceed" in low
        )):
            raise ContextLengthError(detail, status=status)
        if status == 429:
            now = time.time()
            retry_after = _parse_retry_after(resp.headers.get("Retry-After"), now)
            if retry_after is None and (m := _RETRY_DELAY_RE.search(raw or json.dumps(error_obj or {}))):
                retry_after = float(m.group(1))
            if "perday" in low or "per day" in low or "requests_per_day" in low:
                # Model başına günlük kota: Pasifik gece yarısına kadar bu modeli soğut (yedekler denenebilir).
                raise RateLimitedError(detail, status=status, retry_after=next_pacific_midnight(now) - now, upstream=True)
            raise RateLimitedError(detail, status=status, retry_after=retry_after, upstream=False)
        if status == 400 and _THINKING_REJECTED_RE.search(message) and "not supported" in low:
            model = getattr(self, "_last_payload_model", self.cfg.google_model)
            current = self._effort(model)
            nxt = _EFFORT_ESCALATION.get(current)
            if current is not None:
                self._effort_override[model] = nxt
                log.warning("%s düşünme seviyesi %r desteklenmiyor → %r ile tekrar denenecek", model, current, nxt)
                raise ThinkingLevelRejectedError(detail, status=status)
        if status in (408, 504) or g_status == "DEADLINE_EXCEEDED":
            raise ProviderTimeoutError(detail, status=status)
        if status >= 500:
            raise ProviderUnavailableError(detail, status=status)
        raise ProviderError(detail, status=status)

    # --- Google Search ile internet araması (native generateContent) ----------

    def _web_payload(self, model: str, messages: list[dict[str, str]], max_tokens: int) -> dict[str, Any]:
        system = "\n\n".join(m["content"] for m in messages if m.get("role") == "system")
        user = "\n\n".join(m["content"] for m in messages if m.get("role") != "system")
        gen: dict[str, Any] = {"maxOutputTokens": max_tokens, "temperature": self.cfg.temperature}
        if tc := thinking_config(model, self._effort(model)):
            gen["thinkingConfig"] = tc
        self._last_payload_model = model
        body: dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "tools": [{"google_search": {}}],
            "generationConfig": gen,
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        return body

    async def web_chat(self, messages: list[dict[str, str]], *, on_attempt: Any = None) -> WebAnswer:
        """Google Search aracı açık tek bir cevap. Arama sorguları ve kaynaklar ayrıca döner."""
        if reason := self.circuit_reason():
            raise CircuitOpenError(reason)
        model = next((m for m in self.model_chain() if not m.lower().startswith("gemma")), None)
        if model is None:
            raise ModelUnavailableError("internet araması için bir Gemini modeli gerekli (Gemma desteklemez)")
        url = f"{self.cfg.google_native_base}/models/{model}:generateContent"
        attempt = 0
        while True:
            attempt += 1
            try:
                answer = await self._web_once(url, model, messages)
            except ProviderError as err:
                if on_attempt is not None:
                    await on_attempt(model, err.code, None, None)
                wait = self._backoff(attempt)
                if isinstance(err, RateLimitedError) and err.retry_after is not None:
                    wait = err.retry_after
                if not err.retryable or attempt > self.cfg.max_retries or wait > self.cfg.max_retry_wait_seconds:
                    raise
                if not isinstance(err, ThinkingLevelRejectedError):
                    await self._sleep(wait)
                continue
            if on_attempt is not None:
                await on_attempt(answer.model, None, answer.input_tokens, answer.output_tokens, cost=answer.cost)
            self.last_model_used = answer.model
            return answer

    async def _web_once(self, url: str, model: str, messages: list[dict[str, str]]) -> WebAnswer:
        started = self._clock()
        try:
            resp = await self._client.post(
                url, json=self._web_payload(model, messages, self._default_max_tokens()),
                headers={"x-goog-api-key": self._api_key()},
            )
        except httpx.TimeoutException as err:
            raise ProviderTimeoutError(type(err).__name__) from None
        except httpx.HTTPError as err:
            raise ProviderUnavailableError(type(err).__name__) from None
        status = resp.status_code
        try:
            body = resp.json()
        except ValueError:
            body = None
        if isinstance(body, list) and len(body) == 1 and isinstance(body[0], dict):
            body = body[0]
        error_obj = body.get("error") if isinstance(body, dict) else None
        if status >= 400 or error_obj:
            self._raise_for_error(resp, status, error_obj)
        if not isinstance(body, dict):
            raise MalformedResponseError("JSON değil", status=status)
        if (body.get("promptFeedback") or {}).get("blockReason"):
            raise SafetyBlockedError(str(body["promptFeedback"]["blockReason"]), status=status)
        candidates = body.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            raise MalformedResponseError("candidates yok", status=status)
        cand = candidates[0]
        parts = ((cand.get("content") or {}).get("parts")) or []
        text = strip_reasoning("".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought")))
        finish = cand.get("finishReason")
        if not text:
            if finish in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"):
                raise SafetyBlockedError(str(finish), status=status)
            raise EmptyResponseError(f"boş içerik (finish={finish})", status=status)

        gm = cand.get("groundingMetadata") or {}
        queries = [q for q in (gm.get("webSearchQueries") or []) if isinstance(q, str) and q.strip()]
        sources: list[tuple[str, str]] = []
        for chunk in gm.get("groundingChunks") or []:
            web = chunk.get("web") if isinstance(chunk, dict) else None
            if isinstance(web, dict) and web.get("uri") and (web.get("title"), web["uri"]) not in sources:
                sources.append((str(web.get("title") or web["uri"]), str(web["uri"])))

        usage = body.get("usageMetadata") or {}
        tin = int(usage.get("promptTokenCount") or 0) + int(usage.get("toolUsePromptTokenCount") or 0)
        tout = int(usage.get("candidatesTokenCount") or 0) + int(usage.get("thoughtsTokenCount") or 0)
        cost = (tin * self.cfg.google_price_input_per_m + tout * self.cfg.google_price_output_per_m) / 1_000_000
        log.info("Google AI web OK model=%s %.1fsn in=%s out=%s aramalar=%d kaynak=%d finish=%s ~$%.5f",
                 model, self._clock() - started, tin, tout, len(queries), len(sources), finish, cost)
        return WebAnswer(text=text, model=str(body.get("modelVersion") or model), sources=sources,
                         queries=queries, input_tokens=tin, output_tokens=tout, cost=cost)

