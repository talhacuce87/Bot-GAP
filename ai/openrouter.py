"""
ai/openrouter.py — OpenRouter chat completions istemcisi.

- Tek, yeniden kullanılan httpx.AsyncClient (bot kapanırken aclose()).
- Deneme başına zaman aşımı + toplam son tarih (deadline).
- Üstel geri çekilme + sınırlı jitter; 429'da Retry-After'a uyar, fakat
  bekleme süresi max_retry_wait_seconds'ı aşıyorsa isteği açık tutmak yerine
  hemen vazgeçer.
- 401/403 → devre kesici (geçersiz anahtar sonsuza dek denenmez).
- Günlük ücretsiz kota 429'u → sıfırlanma zamanına kadar devre kesici.
- Ücretli model koruması: model fiyatı /api/v1/models'tan doğrulanır;
  fiyatı sıfır olmayan ya da doğrulanamayan model, AI_ALLOW_PAID_MODELS
  açık değilse asla kullanılmaz. Yedek (fallback) model için de aynı kural
  geçerlidir. Yanıtta ücret raporlanırsa sağlayıcı kapatılır.
- Loglarda API anahtarı ve prompt içeriği yer almaz.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Awaitable, Callable

import httpx

from ai.config import AIConfig

log = logging.getLogger("gap.ai.openrouter")

PROVIDER_NAME = "openrouter"
MODEL_METADATA_TTL_SECONDS = 6 * 3600
KEY_STATUS_TTL_SECONDS = 300
AUTH_CIRCUIT_SECONDS = 1800
UPSTREAM_COOLDOWN_SECONDS = 120.0
UPSTREAM_COOLDOWN_MAX_SECONDS = 900.0
BACKOFF_BASE_SECONDS = 1.5
BACKOFF_CAP_SECONDS = 20.0

# OpenRouter adlandırma kuralı: ":free" sonekli varyantlar ve openrouter/free
# yönlendiricisi ücretsizdir. Yalnızca metadata alınamazsa son çare olarak kullanılır.
_FREE_BY_CONVENTION = ("openrouter/free",)


# ---------------------------------------------------------------------------
# Hatalar
# ---------------------------------------------------------------------------

class ProviderError(Exception):
    code = "provider_error"
    retryable = False
    user_message = "Yapay zekâ servisine şu an ulaşılamıyor, birazdan tekrar dene."

    def __init__(self, detail: str = "", *, status: int | None = None) -> None:
        super().__init__(detail or self.code)
        self.detail = detail
        self.status = status


class AuthError(ProviderError):
    code = "auth"
    user_message = "Yapay zekâ servisi yapılandırma hatası nedeniyle devre dışı. Yöneticiye haber ver."


class PaymentRequiredError(ProviderError):
    code = "payment_required"
    user_message = "Yapay zekâ servisi hesabında kredi sorunu var. Yöneticiye haber ver."


class QuotaExhaustedError(ProviderError):
    code = "quota_exhausted"
    user_message = "Bugünlük ücretsiz yapay zekâ kotası doldu. Yarın tekrar dene. 🙏"

    def __init__(self, detail: str = "", *, status: int | None = None, reset_at: float | None = None) -> None:
        super().__init__(detail, status=status)
        self.reset_at = reset_at


class RateLimitedError(ProviderError):
    code = "rate_limited"
    retryable = True
    user_message = "Yapay zekâ servisi şu an yoğun, biraz sonra tekrar dene."

    def __init__(
        self, detail: str = "", *, status: int | None = None,
        retry_after: float | None = None, upstream: bool = False,
    ) -> None:
        super().__init__(detail, status=status)
        self.retry_after = retry_after
        # upstream=True: OpenRouter değil, modeli sunan sağlayıcı (ör. Google AI Studio) sınırladı.
        self.upstream = upstream


class ContextLengthError(ProviderError):
    code = "context_length"
    user_message = "İstek modelin bağlam sınırını aştı."


class ModelUnavailableError(ProviderError):
    code = "model_unavailable"
    user_message = "Seçili yapay zekâ modeli şu an kullanılamıyor."


class ProviderUnavailableError(ProviderError):
    code = "unavailable"
    retryable = True


class ProviderTimeoutError(ProviderError):
    code = "timeout"
    retryable = True
    user_message = "Yapay zekâ servisi zamanında yanıt vermedi, tekrar dene."


class MalformedResponseError(ProviderError):
    code = "malformed"
    retryable = True


class EmptyResponseError(ProviderError):
    code = "empty"
    retryable = True
    user_message = "Model boş yanıt döndü, tekrar dene."


class PaidModelBlockedError(ProviderError):
    code = "paid_blocked"
    user_message = "Yapılandırılan model ücretsiz olarak doğrulanamadı; güvenlik için kullanılmadı."


class CircuitOpenError(ProviderError):
    code = "circuit_open"


class BudgetDeniedError(ProviderError):
    """Yerel bütçe, yeniden denemeye izin vermedi."""
    code = "budget_denied"
    user_message = "Bugünlük yapay zekâ istek bütçesi doldu."


# ---------------------------------------------------------------------------
# Veri tipleri
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ModelInfo:
    id: str
    context_length: int | None
    pricing: dict[str, str] = field(default_factory=dict)
    reasoning_mandatory: bool = False

    @property
    def is_free(self) -> bool:
        return pricing_is_free(self.pricing)


@dataclass(frozen=True)
class ChatResult:
    text: str
    model: str
    requested_model: str
    input_tokens: int | None
    output_tokens: int | None
    finish_reason: str | None
    attempts: int
    cost: float | None = None


AttemptHook = Callable[[str, str | None, int | None, int | None], Awaitable[None]]
"""(model, error_code | None, input_tokens, output_tokens) — her HTTP denemesinden sonra."""

AttemptGate = Callable[[], Awaitable[bool]]
"""İlk deneme dışındaki her denemeden önce çağrılır; False → yeniden deneme yapılmaz."""


def pricing_is_free(pricing: dict[str, Any] | None) -> bool:
    """Tüm fiyat alanları tam olarak 0 ise True. -1 (değişken) ve parse edilemeyenler ücretli sayılır."""
    if not pricing:
        return False
    for value in pricing.values():
        try:
            if float(value) != 0.0:
                return False
        except (TypeError, ValueError):
            return False
    return True


def _parse_retry_after(value: str | None, now: float) -> float | None:
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        return max(0.0, parsedate_to_datetime(value).timestamp() - now)
    except (TypeError, ValueError):
        return None


def _parse_reset_epoch(value: str | None) -> float | None:
    """X-RateLimit-Reset: milisaniye cinsinden epoch."""
    if not value:
        return None
    try:
        raw = float(value)
    except ValueError:
        return None
    return raw / 1000.0 if raw > 1e11 else raw


_THINK_BLOCK_RE = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE)
_THINK_OPEN_RE = re.compile(r"<(think|thinking|reasoning)>", re.IGNORECASE)
_LEAK_START_RE = re.compile(
    r"^\W*(here'?s a thinking process|thinking process|my thought process|let me think|"
    r"analy[sz]e (the )?user('s)? (input|request|message)|okay,? (so )?the user|the user (said|is asking|wants)|"
    r"düşünme süreci|kullanıcı(nın)? (mesajı|isteği)n?[ıi] analiz)",
    re.IGNORECASE,
)
_LEAK_MARKERS = ("<sunucu_verisi>", "<gecmis_kanitlar>", "<kullanici_mesaji>", "Identify Key Elements", "Rule 1:")


def strip_reasoning(text: str) -> str:
    """<think>…</think> bloklarını siler; kapanmamış bir blok varsa geri kalanı düşünmedir."""
    text = _THINK_BLOCK_RE.sub("", text)
    m = _THINK_OPEN_RE.search(text)
    if m:
        text = text[: m.start()]
    return text.strip()


def looks_like_leaked_reasoning(text: str) -> bool:
    """Modelin iç düşünmesini veya prompt'u cevap olarak döndürdüğüne dair belirgin işaretler."""
    head = text[:300]
    return bool(_LEAK_START_RE.search(head)) or any(marker in text for marker in _LEAK_MARKERS)


def _is_context_length(message: str) -> bool:
    m = message.lower()
    return any(k in m for k in ("context length", "context_length", "maximum context", "too many tokens", "prompt is too long"))


# ---------------------------------------------------------------------------
# İstemci
# ---------------------------------------------------------------------------

class OpenRouterClient:
    def __init__(
        self,
        cfg: AIConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        rng: Callable[[], float] = random.random,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.cfg = cfg
        self._sleep = sleep
        self._rng = rng
        self._clock = clock
        self._client = httpx.AsyncClient(
            base_url=cfg.api_base,
            timeout=httpx.Timeout(cfg.request_timeout_seconds, connect=10.0),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
            transport=transport,
            headers={
                "HTTP-Referer": cfg.app_url,
                "X-Title": cfg.app_title,
            },
        )
        self._models: dict[str, ModelInfo] = {}
        self._models_fetched_at = 0.0
        self._models_lock = asyncio.Lock()
        self._key_status: dict[str, Any] | None = None
        self._key_status_at = 0.0

        self._auth_blocked_until = 0.0
        self._quota_blocked_until = 0.0  # wall clock (time.time)
        self._paid_detected = False
        self._model_cooldown_until: dict[str, float] = {}  # monotonic saat
        self.last_error: str | None = None
        self.last_model_used: str | None = None

    async def aclose(self) -> None:
        await self._client.aclose()

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.cfg.api_key}"}

    # ------------------------------------------------------------------
    # Durum
    # ------------------------------------------------------------------

    def circuit_reason(self) -> str | None:
        if not self.cfg.has_api_key:
            return "OPENROUTER_API_KEY tanımlı değil"
        if self._paid_detected:
            return "ücretli kullanım tespit edildi; sağlayıcı yeniden başlatmaya kadar kapalı"
        if self._clock() < self._auth_blocked_until:
            return "API anahtarı reddedildi (401/403)"
        if time.time() < self._quota_blocked_until:
            return "sağlayıcının günlük ücretsiz kotası doldu"
        return None

    @property
    def quota_blocked_until(self) -> float:
        return self._quota_blocked_until

    # ------------------------------------------------------------------
    # Model metadata ve ücretsizlik doğrulaması
    # ------------------------------------------------------------------

    async def refresh_models(self, force: bool = False) -> bool:
        wanted = set(self.model_chain())
        async with self._models_lock:
            if not force and self._models and self._clock() - self._models_fetched_at < MODEL_METADATA_TTL_SECONDS:
                return True
            try:
                resp = await self._client.get("/models")
                resp.raise_for_status()
                data = resp.json().get("data", [])
            except (httpx.HTTPError, ValueError, AttributeError) as err:
                log.warning("OpenRouter model listesi alınamadı: %s", type(err).__name__)
                return False
            # Tüm listeyi bellekte tutmak yerine yalnızca kullanılan modeller saklanır.
            found: dict[str, ModelInfo] = {}
            for item in data if isinstance(data, list) else []:
                if isinstance(item, dict) and item.get("id") in wanted:
                    found[item["id"]] = ModelInfo(
                        id=item["id"],
                        context_length=item.get("context_length"),
                        pricing=dict(item.get("pricing") or {}),
                        reasoning_mandatory=bool((item.get("reasoning") or {}).get("mandatory")),
                    )
            self._models = found
            self._models_fetched_at = self._clock()
            missing = wanted - found.keys()
            if missing:
                log.warning("OpenRouter model listesinde bulunamadı: %s", ", ".join(sorted(missing)))
            return True

    def model_info(self, model: str) -> ModelInfo | None:
        return self._models.get(model)

    async def check_model_allowed(self, model: str) -> tuple[bool, str]:
        """(izinli_mi, açıklama). Ücretli/doğrulanamayan modeller varsayılan olarak reddedilir."""
        if self.cfg.allow_paid_models:
            return True, "ücretli modellere izin verildi (AI_ALLOW_PAID_MODELS)"
        fetched = await self.refresh_models()
        info = self._models.get(model)
        if info is not None:
            if info.is_free:
                return True, "ücretsiz (metadata ile doğrulandı)"
            return False, f"ücretli veya değişken fiyatlı model: {info.pricing}"
        if not fetched and (model.endswith(":free") or model in _FREE_BY_CONVENTION):
            return True, "metadata alınamadı; ':free' adlandırma kuralına güvenildi"
        return False, "model metadata'da bulunamadı, ücretsiz olduğu doğrulanamadı"

    async def key_status(self) -> dict[str, Any] | None:
        """GET /key: free_model_daily_requests vb. Önbellekli; hata durumunda None."""
        if not self.cfg.has_api_key:
            return None
        if self._key_status is not None and self._clock() - self._key_status_at < KEY_STATUS_TTL_SECONDS:
            return self._key_status
        try:
            resp = await self._client.get("/key", headers=self._auth_headers())
            resp.raise_for_status()
            data = resp.json().get("data")
        except (httpx.HTTPError, ValueError, AttributeError) as err:
            log.info("OpenRouter /key alınamadı: %s", type(err).__name__)
            return None
        if not isinstance(data, dict):
            return None
        # Yalnızca ihtiyaç duyulan, hassas olmayan alanlar tutulur.
        self._key_status = {
            "is_free_tier": data.get("is_free_tier"),
            "free_model_daily_requests": data.get("free_model_daily_requests"),
        }
        self._key_status_at = self._clock()
        return self._key_status

    # ------------------------------------------------------------------
    # Chat
    # ------------------------------------------------------------------

    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        on_attempt: AttemptHook | None = None,
        attempt_gate: AttemptGate | None = None,
    ) -> ChatResult:
        reason = self.circuit_reason()
        if reason:
            err = CircuitOpenError(reason)
            if time.time() < self._quota_blocked_until:
                err.user_message = QuotaExhaustedError.user_message
            elif not self.cfg.has_api_key or self._clock() < self._auth_blocked_until:
                err.user_message = AuthError.user_message
            raise err

        deadline = self._clock() + self.cfg.total_deadline_seconds
        models = self.model_chain()
        # Yakın zamanda sağlayıcısı tarafından sınırlanan modeller atlanır (hepsi soğumadaysa sırayla denenir).
        now = self._clock()
        ready = [m for m in models if self._model_cooldown_until.get(m, 0) <= now]
        if ready and len(ready) < len(models):
            log.info("Soğumadaki model(ler) atlandı: %s", ", ".join(m for m in models if m not in ready))
            models = ready

        last_error: ProviderError | None = None
        for index, model in enumerate(models):
            allowed, why = await self.check_model_allowed(model)
            if not allowed:
                log.error("Model engellendi (%s): %s", model, why)
                last_error = PaidModelBlockedError(f"{model}: {why}")
                continue
            if index > 0:
                if attempt_gate is not None and not await attempt_gate():
                    break
                log.warning("Yedek modele geçiliyor: %s → %s (%s)", models[index - 1], model,
                            last_error.code if last_error else "?")
            try:
                result = await self._chat_with_retries(
                    model, messages, max_tokens or self.cfg.max_output_tokens,
                    deadline, on_attempt, attempt_gate,
                )
                self.last_error = None
                self.last_model_used = result.model
                return result
            except ProviderError as err:
                last_error = err
                self.last_error = err.code
                # Yedek model yalnızca modele özgü sorunlarda denenir.
                if not isinstance(err, (ModelUnavailableError, ProviderUnavailableError,
                                        ProviderTimeoutError, RateLimitedError, EmptyResponseError,
                                        MalformedResponseError)):
                    raise
        assert last_error is not None
        raise last_error

    def model_chain(self) -> list[str]:
        """Birincil model + virgülle ayrılmış yedekler, tekrarsız."""
        chain = [self.cfg.model, *(m.strip() for m in self.cfg.fallback_model.split(","))]
        return list(dict.fromkeys(m for m in chain if m))

    def cooling_models(self) -> dict[str, float]:
        """Soğumadaki modeller → kalan saniye."""
        now = self._clock()
        return {m: round(t - now) for m, t in self._model_cooldown_until.items() if t > now}

    async def _chat_with_retries(
        self,
        model: str,
        messages: list[dict[str, str]],
        max_tokens: int,
        deadline: float,
        on_attempt: AttemptHook | None,
        attempt_gate: AttemptGate | None,
    ) -> ChatResult:
        attempt = 0
        while True:
            attempt += 1
            if attempt > 1 and attempt_gate is not None:
                if not await attempt_gate():
                    err = BudgetDeniedError("yerel bütçe yeniden denemeye izin vermedi")
                    err.attempts = attempt - 1  # type: ignore[attr-defined]
                    raise err
            remaining = deadline - self._clock()
            if remaining <= 1:
                err = ProviderTimeoutError("toplam süre doldu")
                err.attempts = attempt - 1  # type: ignore[attr-defined]
                raise err
            try:
                result = await self._chat_once(model, messages, max_tokens, min(remaining, self.cfg.request_timeout_seconds))
            except ProviderError as err:
                if on_attempt is not None:
                    await on_attempt(model, err.code, None, None)
                err.attempts = attempt  # type: ignore[attr-defined]
                if isinstance(err, RateLimitedError) and err.upstream:
                    # Sağlayıcı kotası saniyeler içinde açılmaz; aynı modeli tekrar denemek
                    # bütçeyi boşa harcar. Modeli soğumaya al, hemen yedeğe geç.
                    cool = min(UPSTREAM_COOLDOWN_MAX_SECONDS, err.retry_after or UPSTREAM_COOLDOWN_SECONDS)
                    self._model_cooldown_until[model] = self._clock() + cool
                    log.info("%s sağlayıcı tarafından sınırlandı, %.0f sn soğumada", model, cool)
                    raise
                if not err.retryable or attempt > self.cfg.max_retries:
                    raise
                wait = self._backoff(attempt)
                if isinstance(err, RateLimitedError) and err.retry_after is not None:
                    wait = err.retry_after
                if wait > self.cfg.max_retry_wait_seconds or self._clock() + wait >= deadline - 1:
                    log.info("Yeniden deneme atlandı: bekleme %.1fsn sınırı aşıyor", wait)
                    raise
                log.info("OpenRouter %s (deneme %d), %.1fsn sonra tekrar", err.code, attempt, wait)
                await self._sleep(wait)
                continue
            if on_attempt is not None:
                await on_attempt(result.model, None, result.input_tokens, result.output_tokens)
            return ChatResult(
                text=result.text, model=result.model, requested_model=model,
                input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                finish_reason=result.finish_reason, attempts=attempt, cost=result.cost,
            )

    def _backoff(self, attempt: int) -> float:
        base = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)))
        return base * (0.75 + 0.5 * self._rng())  # ±%25 sınırlı jitter

    def _payload(self, model: str, messages: list[dict[str, str]], max_tokens: int) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": self.cfg.temperature,
        }
        effort = self.cfg.reasoning_effort
        info = self._models.get(model)
        if effort == "none":
            # Sohbet botu için akıl yürütme kapalı: aksi halde düşünme tokenları max_tokens
            # bütçesini tüketir ve bazı modeller düşünme metnini cevaba sızdırır.
            # Akıl yürütmesi zorunlu modellerde kapatma isteği reddedileceği için gönderilmez.
            if not (info and info.reasoning_mandatory):
                payload["reasoning"] = {"enabled": False}
        elif effort in {"minimal", "low", "medium", "high"}:
            payload["reasoning"] = {"effort": effort, "exclude": True}
        if self.cfg.enforce_zero_price and not self.cfg.allow_paid_models:
            # Sağlayıcı yönlendirmesinde ücretli uç noktaları sert biçimde dışla.
            payload["provider"] = {"max_price": {"prompt": 0, "completion": 0}}
        return payload

    async def _chat_once(
        self,
        model: str,
        messages: list[dict[str, str]],
        max_tokens: int,
        timeout: float,
    ) -> ChatResult:
        started = self._clock()
        try:
            resp = await self._client.post(
                "/chat/completions",
                json=self._payload(model, messages, max_tokens),
                headers=self._auth_headers(),
                timeout=httpx.Timeout(timeout, connect=min(10.0, timeout)),
            )
        except httpx.TimeoutException as err:
            raise ProviderTimeoutError(type(err).__name__) from None
        except httpx.HTTPError as err:
            raise ProviderUnavailableError(type(err).__name__) from None

        elapsed = self._clock() - started
        status = resp.status_code
        try:
            body = resp.json()
        except ValueError:
            body = None

        error_obj = body.get("error") if isinstance(body, dict) else None
        if status >= 400 or error_obj:
            self._raise_for_error(resp, status, error_obj)

        if not isinstance(body, dict):
            raise MalformedResponseError("JSON değil", status=status)
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise MalformedResponseError("choices yok", status=status)
        choice = choices[0]
        message = choice.get("message") or {}
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):  # bazı modeller parça listesi döndürür
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        text = strip_reasoning((content or "") if isinstance(content, str) else "")
        finish_reason = choice.get("finish_reason")
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        used_model = str(body.get("model") or model)
        cost = usage.get("cost")
        try:
            cost = float(cost) if cost is not None else None
        except (TypeError, ValueError):
            cost = None

        log.info(
            "OpenRouter OK model=%s status=%s %.1fsn in=%s out=%s finish=%s",
            used_model, status, elapsed, usage.get("prompt_tokens"), usage.get("completion_tokens"), finish_reason,
        )

        if cost and cost > 0 and not self.cfg.allow_paid_models:
            self._paid_detected = True
            log.error("OpenRouter ücret raporladı (%.6f) model=%s — sağlayıcı kapatıldı", cost, used_model)

        if not text:
            raise EmptyResponseError(f"boş içerik (finish={finish_reason})", status=status)
        if looks_like_leaked_reasoning(text):
            # Düşünme metni cevap alanına sızmış; kullanıcıya gönderme, yeniden dene.
            log.warning("Model düşünme metnini cevaba sızdırdı (model=%s finish=%s), atlandı", used_model, finish_reason)
            raise EmptyResponseError("cevapta akıl yürütme metni", status=status)

        return ChatResult(
            text=text, model=used_model, requested_model=model,
            input_tokens=usage.get("prompt_tokens"), output_tokens=usage.get("completion_tokens"),
            finish_reason=finish_reason, attempts=1, cost=cost,
        )

    def _raise_for_error(self, resp: httpx.Response, status: int, error_obj: Any) -> None:
        message = ""
        meta: dict[str, Any] = {}
        if isinstance(error_obj, dict):
            message = str(error_obj.get("message") or "")
            meta = error_obj.get("metadata") if isinstance(error_obj.get("metadata"), dict) else {}
            code = error_obj.get("code")
            if isinstance(code, int) and status < 400:
                status = code  # 200 gövdesinde gelen hata
        detail = f"HTTP {status}: {message[:200]}"
        log.warning("OpenRouter hata %s", detail)

        if status in (401, 403):
            self._auth_blocked_until = self._clock() + AUTH_CIRCUIT_SECONDS
            raise AuthError(detail, status=status)
        if status == 402:
            raise PaymentRequiredError(detail, status=status)
        if status == 404:
            raise ModelUnavailableError(detail, status=status)
        if status == 413 or (status == 400 and _is_context_length(message)):
            raise ContextLengthError(detail, status=status)
        if status == 429:
            now = time.time()
            remaining = resp.headers.get("X-RateLimit-Remaining")
            reset_at = _parse_reset_epoch(resp.headers.get("X-RateLimit-Reset"))
            daily = "per-day" in message.lower() or "per day" in message.lower() or "free-models-per-day" in message.lower()
            if daily or (remaining == "0" and reset_at is not None and reset_at - now > 120):
                self._quota_blocked_until = reset_at if reset_at and reset_at > now else _next_utc_midnight(now)
                raise QuotaExhaustedError(detail, status=status, reset_at=self._quota_blocked_until)
            retry_after = _parse_retry_after(resp.headers.get("Retry-After"), now)
            if retry_after is None and reset_at is not None:
                retry_after = max(0.0, reset_at - now)
            upstream = bool(meta.get("provider_name")) or "provider returned error" in message.lower()
            raise RateLimitedError(detail, status=status, retry_after=retry_after, upstream=upstream)
        if status in (408, 504):
            raise ProviderTimeoutError(detail, status=status)
        if status >= 500:
            raise ProviderUnavailableError(detail, status=status)
        if status == 400 and meta.get("provider_name") is None and "model" in message.lower() and "not" in message.lower():
            raise ModelUnavailableError(detail, status=status)
        raise ProviderError(detail, status=status)


def _next_utc_midnight(now: float) -> float:
    return (int(now // 86400) + 1) * 86400.0
