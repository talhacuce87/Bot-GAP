"""
ai/providers.py — Sağlayıcı zinciri.

AI_PROVIDER_ORDER sırasıyla (varsayılan google → openrouter) sağlayıcıları dener.
Bir sağlayıcı devre dışıysa (anahtar yok, 401, kota) veya yerel günlük bütçesi
dolmuşsa atlanır; bir sağlayıcının tüm modelleri başarısız olursa sıradakine
geçilir. Bağlam sınırı hatası ise dışarı iletilir (orchestrator prompt'u
küçültüp yeniden dener).
"""

from __future__ import annotations

import logging
from typing import Any

from ai.budget import RequestBudget
from ai.openrouter import (
    AttemptHook, BudgetDeniedError, ChatResult, CircuitOpenError, ContextLengthError, ModelInfo,
    OpenRouterClient, ProviderError,
)

log = logging.getLogger("gap.ai.providers")


class ProviderChain:
    def __init__(self, clients: list[OpenRouterClient], budget: RequestBudget) -> None:
        if not clients:
            raise ValueError("en az bir sağlayıcı gerekli")
        self.clients = clients
        self.budget = budget
        self.last_error: str | None = None
        self.last_model_used: str | None = None
        self.last_provider: str | None = None

    @property
    def primary(self) -> OpenRouterClient:
        return self.clients[0]

    def client(self, name: str) -> OpenRouterClient | None:
        return next((c for c in self.clients if c.provider_name == name), None)

    def circuit_reason(self) -> str | None:
        reasons = [c.circuit_reason() for c in self.clients]
        if any(r is None for r in reasons):
            return None
        return "; ".join(f"{c.label}: {r}" for c, r in zip(self.clients, reasons))

    def model_info(self, model: str) -> ModelInfo | None:
        for c in self.clients:
            if info := c.model_info(model):
                return info
        return None

    def cooling_models(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for c in self.clients:
            out.update(c.cooling_models())
        return out

    async def key_status(self) -> dict[str, Any] | None:
        c = self.client("openrouter")
        return await c.key_status() if c else None

    async def aclose(self) -> None:
        for c in self.clients:
            try:
                await c.aclose()
            except Exception:
                log.exception("%s istemcisi kapatılamadı", c.label)

    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        on_attempt: AttemptHook | None = None,
        attempt_gate: Any = None,  # sağlayıcı bazlı bütçe kapısı kullanılır
    ) -> ChatResult:
        last_error: ProviderError | None = None
        skipped: list[ProviderError] = []
        for client in self.clients:
            name = client.provider_name
            if reason := client.circuit_reason():
                skipped.append(CircuitOpenError(f"{client.label}: {reason}"))
                continue
            if not self.budget.provider_has_room(name):
                log.info("%s günlük bütçesi dolu, atlanıyor", client.label)
                skipped.append(BudgetDeniedError(f"{client.label} günlük bütçesi doldu"))
                continue

            async def hook(model, error_code, tin, tout, *, cost=None, _name=name):
                if on_attempt is not None:
                    await on_attempt(model, error_code, tin, tout, provider=_name, cost=cost)

            async def gate(_name=name):
                return await self.budget.attempt_gate(_name)

            if last_error is not None:
                log.warning("Sağlayıcı değiştiriliyor → %s (önceki hata: %s)", client.label, last_error.code)
            try:
                result = await client.chat(messages, max_tokens=max_tokens, on_attempt=hook, attempt_gate=gate)
            except ContextLengthError:
                raise
            except ProviderError as err:
                last_error = err
                self.last_error = f"{name}:{err.code}"
                continue
            self.last_error = None
            self.last_model_used = result.model
            self.last_provider = name
            return result

        if last_error is not None:
            raise last_error
        # Hiçbir sağlayıcı denenemedi: kullanıcıya en anlamlı sebebi göster.
        if any(isinstance(e, BudgetDeniedError) for e in skipped):
            raise next(e for e in skipped if isinstance(e, BudgetDeniedError))
        err = skipped[0] if skipped else CircuitOpenError("sağlayıcı yok")
        raise err
