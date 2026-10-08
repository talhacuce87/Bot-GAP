"""
ai/orchestrator.py — Bir AI isteğinin uçtan uca akışı (Discord'dan bağımsız).

  temizle → bütçe slotu → bağlam topla (son konuşma, hafıza, sunucu verisi,
  geçmiş kanıt) → prompt kur → OpenRouter → çıktıyı temizle → kaynak linkleri

Sağlayıcı hatası, bütçe reddi veya bağlam toplama hatası her zaman
kullanıcıya gösterilebilir bir AIResponse'a dönüşür; istisna dışarı sızmaz.
"""

from __future__ import annotations

import logging
import re
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field, replace
from typing import Any, Callable

from ai.budget import BudgetError, RequestBudget
from ai.config import AIConfig
from ai.context import BuiltContext, ChatLine, ContextBuilder, ContextInput
from ai.guard import clean_model_output, clean_user_input, jump_url, render_mentions
from ai.memory import MemoryService
from ai.openrouter import ContextLengthError, ProviderError
from ai.persona import PersonaStore
from ai.retrieval import RetrievalResult, Retriever, parse_time_filter
from ai.stats import StatsService
from ai.storage import AIStorage
from ai.textutil import fold

log = logging.getLogger("gap.ai.orchestrator")

_HISTORY_CUES = re.compile(
    r"hatirl|demisti|dememis|konusmustuk|konustugumuz|konustuk|konusmus|bahsetmis|bahsetti|soylemisti|yazmisti|"
    r"ne dedi|kim dedi|ne yazdi|"
    r"daha once|gecen sefer|gecen hafta|gecen ay|\bdun\b|ne zaman|kim (?:demisti|soylemisti|yazmisti)|"
    r"planimiz|ne planla"
)
MAX_SOURCE_LINKS = 3
SAFETY_TOKENS = 200


def is_historical(question: str) -> bool:
    return bool(_HISTORY_CUES.search(fold(question)))


class ConversationCache:
    """Bota yöneltilen sorular ve botun cevapları; kanal başına sınırlı, LRU."""

    def __init__(self, max_channels: int = 200, per_channel: int = 12) -> None:
        self.max_channels = max_channels
        self.per_channel = per_channel
        # (guild, kanal) → [(message_id, user_id, satır)]; bot satırlarında user_id None.
        self._data: OrderedDict[tuple[int, int], deque[tuple[int | None, int | None, ChatLine]]] = OrderedDict()

    def add(
        self, guild_id: int, channel_id: int, line: ChatLine,
        message_id: int | None = None, user_id: int | None = None,
    ) -> None:
        key = (guild_id, channel_id)
        dq = self._data.get(key)
        if dq is None:
            dq = self._data[key] = deque(maxlen=self.per_channel)
        dq.append((message_id, user_id, line))
        self._data.move_to_end(key)
        while len(self._data) > self.max_channels:
            self._data.popitem(last=False)

    def get(self, guild_id: int, channel_id: int) -> list[tuple[int | None, int | None, ChatLine]]:
        return list(self._data.get((guild_id, channel_id), ()))

    def forget_user(self, guild_id: int, user_id: int) -> None:
        """Kullanıcının soruları ve onlara verilen bot cevapları önbellekten çıkarılır."""
        for (gid, _), dq in self._data.items():
            if gid != guild_id:
                continue
            kept, skip_answer = [], False
            for item in dq:
                if item[1] == user_id:
                    skip_answer = True
                    continue
                if skip_answer and item[2].is_bot:
                    skip_answer = False
                    continue
                skip_answer = False
                kept.append(item)
            dq.clear()
            dq.extend(kept)

    def remove_message(self, guild_id: int, channel_id: int, message_id: int) -> None:
        dq = self._data.get((guild_id, channel_id))
        if dq:
            kept = [item for item in dq if item[0] != message_id]
            dq.clear()
            dq.extend(kept)

    def clear_guild(self, guild_id: int) -> None:
        for key in [k for k in self._data if k[0] == guild_id]:
            del self._data[key]

    def __len__(self) -> int:
        return len(self._data)


@dataclass
class AIRequest:
    guild_id: int
    guild_name: str
    channel_id: int
    channel_name: str
    user_id: int
    speaker_name: str
    question: str
    allowed_channels: set[int]
    channel_indexed: bool
    bot_id: int | None
    message_id: int | None = None
    reply_to: ChatLine | None = None
    channel_cooldown: int | None = None
    member_count: int | None = None
    now: float = field(default_factory=time.time)


@dataclass
class AIResponse:
    text: str
    ok: bool
    sources: list[str] = field(default_factory=list)
    model: str | None = None
    error_code: str | None = None
    candidate_ids: list[int] = field(default_factory=list)


class Orchestrator:
    def __init__(
        self,
        cfg: AIConfig,
        *,
        client: Any,  # ProviderChain veya tek bir OpenRouterClient
        budget: RequestBudget,
        persona: PersonaStore,
        storage: AIStorage | None = None,
        retriever: Retriever | None = None,
        memory: MemoryService | None = None,
        stats: StatsService | None = None,
        name_for: Callable[[int, int, str | None], str] | None = None,
        channel_name_for: Callable[[int, int], str] | None = None,
        cache: ConversationCache | None = None,
    ) -> None:
        self.cfg = cfg
        self.client = client
        self.budget = budget
        self.persona = persona
        self.storage = storage
        self.retriever = retriever
        self.memory = memory
        self.stats = stats
        self.cache = cache or ConversationCache()
        self._name_for = name_for or (lambda gid, uid, fallback: fallback or "kullanıcı")
        self._channel_name_for = channel_name_for or (lambda gid, cid: "kanal")

    # ------------------------------------------------------------------
    # Yardımcılar
    # ------------------------------------------------------------------

    def _render(self, guild_id: int, text: str) -> str:
        return render_mentions(
            text,
            lambda uid: self._name_for(guild_id, uid, None),
            lambda cid: self._channel_name_for(guild_id, cid),
        )

    def token_budget(self) -> int:
        budget = self.cfg.context_token_budget
        info = self.client.model_info(self.cfg.model)
        if info and info.context_length:
            budget = min(budget, info.context_length - self.cfg.max_output_tokens - SAFETY_TOKENS)
        return max(300, budget)

    async def _recent(self, req: AIRequest) -> list[tuple[int | None, ChatLine]]:
        """Son konuşma: indekslenmiş kanal mesajları + bot ile yapılan son yazışmalar, kronolojik."""
        items: dict[tuple[float, int], tuple[int | None, ChatLine]] = {}
        seen_ids: set[int] = set()
        if self.storage is not None and req.channel_indexed and self.cfg.recent_context_messages:
            for m in await self.storage.recent_messages(
                req.guild_id, req.channel_id, self.cfg.recent_context_messages, before_ts=req.now
            ):
                if m.message_id == req.message_id:
                    continue
                seen_ids.add(m.message_id)
                items[(m.created_at, m.message_id)] = (m.message_id, ChatLine(
                    self._name_for(req.guild_id, m.user_id, m.author_name),
                    self._render(req.guild_id, m.content), m.created_at,
                ))
        for mid, _, line in self.cache.get(req.guild_id, req.channel_id):
            if mid is not None and mid in seen_ids:
                continue
            items[(line.ts, mid or 0)] = (mid, line)
        ordered = [items[k] for k in sorted(items)]
        return ordered[-max(1, self.cfg.recent_context_messages):]

    # ------------------------------------------------------------------
    # Sohbet
    # ------------------------------------------------------------------

    async def answer(self, req: AIRequest) -> AIResponse:
        question = clean_user_input(req.question, req.bot_id, self.cfg.max_input_chars)
        if not question:
            return AIResponse("Efendim? 🙂 Bir şey sormak için mesajını da yaz.", ok=False, error_code="empty_input")

        try:
            async with self.budget.slot(
                req.guild_id, req.channel_id, req.user_id, channel_cooldown=req.channel_cooldown
            ):
                return await self._answer_in_slot(req, question)
        except BudgetError as err:
            return AIResponse(err.user_message, ok=False, error_code=err.code)

    async def _answer_in_slot(self, req: AIRequest, question: str) -> AIResponse:
        rendered_q = self._render(req.guild_id, question)
        # Geçmiş arama yalnızca geçmişe dönük sorularda yapılır; aksi halde ilgisiz kelime
        # eşleşmeleri modele "kanıt" gibi gider ve uydurmaya yol açar.
        historical = is_historical(question) or parse_time_filter(question, req.now).since is not None

        recent: list[tuple[int | None, ChatLine]] = []
        user_mems: list[str] = []
        episodes: list[str] = []
        server_data: list[str] = []
        retrieval: RetrievalResult | None = None
        try:
            recent = await self._recent(req)
            if self.memory is not None and self.cfg.memory_enabled:
                user_mems, episodes = await self.memory.for_context(
                    req.guild_id, req.user_id, req.allowed_channels, self.cfg.memory_context_limit
                )
            if self.stats is not None:
                server_data = await self.stats.gather(req.guild_id, req.user_id, req.question, req.bot_id)
            if self.retriever is not None and req.allowed_channels and historical:
                retrieval = await self.retriever.search(
                    req.guild_id, question, req.allowed_channels, now=req.now, bot_id=req.bot_id,
                    exclude_ids={req.message_id} if req.message_id else (),
                )
        except Exception:
            # Bağlam toplanamazsa yine de sade bir cevap verilebilir; durumu logla.
            log.exception("AI bağlamı toplanırken hata (guild=%s)", req.guild_id)

        builder = ContextBuilder(
            self.token_budget(),
            name_for=lambda uid, fb: self._name_for(req.guild_id, uid, fb),
            channel_name_for=lambda cid: self._channel_name_for(req.guild_id, cid),
        )
        passages = []
        if retrieval:
            for p in retrieval.passages:
                p.messages = [replace(m, content=self._render(req.guild_id, m.content)) for m in p.messages]
                passages.append(p)
        # Aynı mesaj hem kanıtta hem son konuşmada tekrarlanmasın; kanıt kopyası kalır.
        evidence_ids = {m.message_id for p in passages for m in p.messages}
        recent_lines = [line for mid, line in recent if mid is None or mid not in evidence_ids]
        inp = ContextInput(
            question=rendered_q,
            speaker_name=req.speaker_name,
            guild_name=req.guild_name,
            channel_name=req.channel_name,
            now=req.now,
            persona=self.persona.get(req.guild_id),
            recent=recent_lines,
            reply_to=req.reply_to,
            user_memories=user_mems,
            episodic_memories=episodes,
            server_data=server_data,
            passages=passages,
            historical=historical,
            member_count=req.member_count,
            channel_memory=req.channel_indexed if self.storage is not None else None,
        )
        built = builder.build(inp)
        if built.dropped:
            log.info("Bağlam bütçesi nedeniyle düşenler: %s (~%d token)", built.dropped, built.approx_tokens)

        async def on_attempt(model, error_code, tin, tout, *, provider="openrouter", cost=None):
            await self.budget.record_attempt(
                req.guild_id, req.user_id, model, error_code, tin, tout, provider=provider, cost_usd=cost
            )

        try:
            try:
                result = await self.client.chat(
                    built.messages, on_attempt=on_attempt, attempt_gate=self.budget.attempt_gate
                )
            except ContextLengthError:
                if not await self.budget.attempt_gate():
                    raise
                built = builder.build(inp, token_budget=max(300, self.token_budget() // 2))
                log.info("Bağlam sınırı aşıldı, yarı bütçeyle tekrar deneniyor (~%d token)", built.approx_tokens)
                result = await self.client.chat(
                    built.messages, on_attempt=on_attempt, attempt_gate=self.budget.attempt_gate
                )
        except ProviderError as err:
            log.warning("AI yanıtı üretilemedi: %s", err.code)
            if server_data:
                text = "🤖 Yapay zekâ şu an cevap veremiyor ama veritabanından bakabildim:\n" + "\n".join(
                    f"• {line}" for line in server_data
                )
                return AIResponse(clean_model_output(text), ok=False, error_code=err.code)
            return AIResponse(err.user_message, ok=False, error_code=err.code)

        text = clean_model_output(result.text)
        sources = self._sources(req, built) if historical else []

        self.cache.add(req.guild_id, req.channel_id,
                       ChatLine(req.speaker_name, rendered_q, req.now), req.message_id, req.user_id)
        self.cache.add(req.guild_id, req.channel_id, ChatLine("Bot-GAP", text, time.time(), is_bot=True))

        candidate_ids: list[int] = []
        if self.memory is not None and self.cfg.memory_enabled and req.message_id:
            try:
                candidate_ids = await self.memory.capture_candidates(
                    req.guild_id, req.user_id, req.channel_id, req.message_id, question,
                    store_source=req.channel_indexed,
                )
            except Exception:
                log.exception("Aday hafıza çıkarılamadı")

        return AIResponse(text, ok=True, sources=sources, model=result.model, candidate_ids=candidate_ids)

    def _sources(self, req: AIRequest, built: BuiltContext) -> list[str]:
        links: list[str] = []
        for p in built.used_passages[:MAX_SOURCE_LINKS]:
            # Yalnızca istek anında yetkili olan kanallardan link (retrieval zaten filtreli; ikinci kontrol).
            if p.channel_id in req.allowed_channels:
                links.append(jump_url(req.guild_id, p.channel_id, p.anchor.message_id))
        return links

    # ------------------------------------------------------------------
    # LLM'siz geçmiş arama (!hatirla)
    # ------------------------------------------------------------------

    async def recall(self, guild_id: int, query: str, allowed_channels: set[int], bot_id: int | None) -> RetrievalResult | None:
        if self.retriever is None or not allowed_channels:
            return None
        return await self.retriever.search(guild_id, query, allowed_channels, now=time.time(), bot_id=bot_id)
