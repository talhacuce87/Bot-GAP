"""
ai/budget.py — Sağlayıcıdan bağımsız yerel istek bütçesi ve hız sınırı.

- Sağlayıcı başına günlük bütçe (UTC gün sınırı; ai_usage tablosundan yüklenir,
  yeniden başlatma sayaçları sıfırlamaz). Her HTTP denemesi — başarısız olanlar
  dahil — bütçeden düşer, çünkü sağlayıcı da onları sayabilir. Ücretli
  sağlayıcıda (Google) ayrıca günlük tahmini USD sınırı vardır.
  Bir sağlayıcının bütçesi dolarsa diğeri kullanılmaya devam eder.
- Kullanıcı başına günlük sınır: tek kullanıcı tüm ücretsiz kotayı tüketemez.
- Kullanıcı ve kanal cooldown'ları.
- Eşzamanlılık semaforu + sınırlı bekleme kuyruğu: kuyruk doluysa istek
  beklemeye alınmaz, kullanıcıya "meşgul" denir.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from typing import AsyncIterator, Callable

from ai.config import AIConfig
from ai.storage import AIStorage, utc_day

log = logging.getLogger("gap.ai.budget")

_MAX_TRACKED_KEYS = 5000


class BudgetError(Exception):
    def __init__(self, code: str, user_message: str) -> None:
        super().__init__(code)
        self.code = code
        self.user_message = user_message


class RequestBudget:
    def __init__(
        self,
        cfg: AIConfig,
        storage: AIStorage | None,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.cfg = cfg
        self.storage = storage
        self._clock = clock
        self._sem = asyncio.Semaphore(cfg.max_concurrent_requests)
        self._waiting = 0
        self._in_flight: set[tuple[int, int]] = set()
        self._pending = 0
        self._day = utc_day(clock())
        self._day_provider: dict[str, int] = {}
        self._day_cost: dict[str, float] = {}
        self._day_user: dict[tuple[int, int], int] = {}
        # Anahtarı olmayan kurulumda da kontroller çalışsın diye en az bir sağlayıcı.
        self.providers: list[str] = cfg.providers or ["openrouter"]
        self._user_last: dict[tuple[int, int], float] = {}
        self._channel_last: dict[tuple[int, int], float] = {}

    async def load(self) -> None:
        if self.storage is None:
            return
        self._day = utc_day(self._clock())
        summary = await self.storage.usage_counts(self._day)
        self._day_provider = dict(summary.per_provider)
        self._day_cost = dict(summary.cost_per_provider)
        self._day_user = dict(summary.per_user)
        log.info("AI bütçesi yüklendi: %s", self.describe())

    def _roll_day(self) -> None:
        today = utc_day(self._clock())
        if today != self._day:
            self._day = today
            self._day_provider.clear()
            self._day_cost.clear()
            self._day_user.clear()

    def request_limit(self, provider: str) -> int:
        return self.cfg.google_daily_request_budget if provider == "google" else self.cfg.daily_request_budget

    def cost_limit(self, provider: str) -> float | None:
        return self.cfg.google_daily_cost_limit_usd if provider == "google" else None

    def provider_has_room(self, provider: str, reserve: int = 0) -> bool:
        self._roll_day()
        if self._day_provider.get(provider, 0) + reserve >= self.request_limit(provider):
            return False
        limit = self.cost_limit(provider)
        return limit is None or self._day_cost.get(provider, 0.0) < limit

    def describe(self) -> str:
        parts = []
        for p in self.providers:
            text = f"{p} {self.provider_used(p)}/{self.request_limit(p)}"
            if (limit := self.cost_limit(p)) is not None:
                text += f" (~${self.provider_cost(p):.3f}/${limit:.2f})"
            parts.append(text)
        return ", ".join(parts)

    # ------------------------------------------------------------------
    # Durum
    # ------------------------------------------------------------------

    @property
    def used_today(self) -> int:
        self._roll_day()
        return sum(self._day_provider.values())

    def provider_used(self, provider: str) -> int:
        self._roll_day()
        return self._day_provider.get(provider, 0)

    def provider_cost(self, provider: str) -> float:
        self._roll_day()
        return self._day_cost.get(provider, 0.0)

    def user_used_today(self, guild_id: int, user_id: int) -> int:
        self._roll_day()
        return self._day_user.get((guild_id, user_id), 0)

    @property
    def queue_depth(self) -> int:
        return self._waiting

    # ------------------------------------------------------------------
    # Kontroller
    # ------------------------------------------------------------------

    def check(self, guild_id: int, channel_id: int, user_id: int, channel_cooldown: int | None = None) -> None:
        """Kotaları kontrol eder; aşılmışsa BudgetError fırlatır. Hiçbir şey tüketmez."""
        self._roll_day()
        now = self._clock()
        if not any(self.provider_has_room(p, reserve=self._pending) for p in self.providers):
            raise BudgetError("daily_budget", "Bugünlük yapay zekâ istek bütçesi doldu, yarın (UTC 00:00 sonrası) tekrar dene. 🙏")
        if self._day_user.get((guild_id, user_id), 0) >= self.cfg.user_daily_request_limit:
            raise BudgetError("user_daily", "Bugünlük kişisel yapay zekâ sınırına ulaştın; herkese sıra gelsin diye böyle. Yarın görüşürüz!")
        if (guild_id, user_id) in self._in_flight:
            raise BudgetError("user_in_flight", "Önceki sorunu hâlâ düşünüyorum, bir saniye. ⏳")
        wait = self.cfg.user_cooldown_seconds - (now - self._user_last.get((guild_id, user_id), 0))
        if wait > 0:
            raise BudgetError("user_cooldown", f"Biraz yavaş 🙂 {int(wait) + 1} sn sonra tekrar sor.")
        cd = self.cfg.channel_cooldown_seconds if channel_cooldown is None else channel_cooldown
        wait = cd - (now - self._channel_last.get((guild_id, channel_id), 0))
        if wait > 0:
            raise BudgetError("channel_cooldown", f"Bu kanalda az önce cevap verdim, {int(wait) + 1} sn sonra tekrar dene.")
        if self._waiting >= self.cfg.max_queue_size and self._sem.locked():
            raise BudgetError("queue_full", "Şu an çok yoğunum, birazdan tekrar dene.")

    @contextlib.asynccontextmanager
    async def slot(
        self,
        guild_id: int,
        channel_id: int,
        user_id: int,
        *,
        channel_cooldown: int | None = None,
        wait_timeout: float | None = None,
    ) -> AsyncIterator[None]:
        """Kontrol + cooldown işaretleme + eşzamanlılık slotu."""
        self.check(guild_id, channel_id, user_id, channel_cooldown)
        key = (guild_id, user_id)
        now = self._clock()
        self._user_last[key] = now
        self._channel_last[(guild_id, channel_id)] = now
        self._trim()
        self._in_flight.add(key)
        self._pending += 1
        self._waiting += 1
        acquired = False
        try:
            try:
                await asyncio.wait_for(self._sem.acquire(), wait_timeout or self.cfg.total_deadline_seconds)
                acquired = True
            except asyncio.TimeoutError:
                raise BudgetError("queue_timeout", "Sıra çok uzun sürdü, birazdan tekrar dene.") from None
            finally:
                self._waiting -= 1
            yield
        finally:
            if acquired:
                self._sem.release()
            self._pending -= 1
            self._in_flight.discard(key)

    async def attempt_gate(self, provider: str | None = None) -> bool:
        """Yeniden deneme / yedek model öncesi: (verilen ya da herhangi bir) sağlayıcıda yer var mı?"""
        if provider is not None:
            return self.provider_has_room(provider)
        return any(self.provider_has_room(p) for p in self.providers)

    async def record_attempt(
        self,
        guild_id: int | None,
        user_id: int | None,
        model: str | None,
        error_code: str | None,
        input_tokens: int | None,
        output_tokens: int | None,
        provider: str = "openrouter",
        cost_usd: float | None = None,
    ) -> None:
        self._roll_day()
        self._day_provider[provider] = self._day_provider.get(provider, 0) + 1
        if cost_usd:
            self._day_cost[provider] = self._day_cost.get(provider, 0.0) + cost_usd
        if guild_id is not None and user_id is not None:
            key = (guild_id, user_id)
            self._day_user[key] = self._day_user.get(key, 0) + 1
        if self.storage is not None:
            try:
                await self.storage.record_usage(
                    provider=provider, model=model, guild_id=guild_id, user_id=user_id,
                    input_tokens=input_tokens, output_tokens=output_tokens, error_code=error_code,
                    cost_usd=cost_usd, ts=self._clock(),
                )
            except Exception:
                # Muhasebe hatası isteği düşürmesin; bellekteki sayaç yine de güncel.
                log.exception("AI kullanım kaydı yazılamadı")

    def _trim(self) -> None:
        if len(self._user_last) + len(self._channel_last) <= _MAX_TRACKED_KEYS:
            return
        cutoff = self._clock() - max(self.cfg.user_cooldown_seconds, self.cfg.channel_cooldown_seconds, 3600)
        self._user_last = {k: v for k, v in self._user_last.items() if v > cutoff}
        self._channel_last = {k: v for k, v in self._channel_last.items() if v > cutoff}
