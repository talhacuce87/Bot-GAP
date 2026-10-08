"""
ai/cog.py — AICog: Discord tarafı.

Mesaj işleme iki ayrı iştir:
  - İndeksleme: yalnızca yöneticinin açtığı kanallarda, opt-out etmemiş
    kullanıcıların komut olmayan mesajları (hassas veriler maskelenerek)
    ai_memory.db'ye yazılır.
  - Yanıt: bot etiketlenirse, bota yanıt verilirse veya !ai kullanılırsa.
Bu cog yalnızca bir on_message *dinleyicisi* ekler; XP, denetim ve komut
işleme akışlarına dokunmaz. Her dinleyici kendi hatasını yakalar.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from collections import OrderedDict
from typing import Any

import discord
from discord.ext import commands, tasks

from ai.budget import RequestBudget
from ai.config import AIConfig
from ai.context import ChatLine
from ai.guard import authorized_source_channels, jump_url, redact_sensitive, render_mentions
from ai.memory import MemoryError_, MemoryService
from ai.google import GoogleAIClient
from ai.openrouter import OpenRouterClient
from ai.orchestrator import AIRequest, AIResponse, Orchestrator
from ai.persona import PersonaStore
from ai.providers import ProviderChain
from ai.retrieval import TR_TZ, Retriever
from ai.stats import StatsService
from ai.storage import AIStorage
from ai.textutil import collapse_ws, truncate

log = logging.getLogger("gap.ai")

NO_MENTIONS = discord.AllowedMentions.none()
MAINTENANCE_HOURS = 6
PROCESSED_CACHE_SIZE = 2000
DISCORD_LIMIT = 2000


def split_message(text: str, limit: int = DISCORD_LIMIT - 10) -> list[str]:
    parts: list[str] = []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = text.rfind(" ", 0, limit)
        if cut < limit // 2:
            cut = limit
        parts.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
    if text:
        parts.append(text)
    return parts


def _fmt_date(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, TR_TZ).strftime("%d.%m.%Y %H:%M")


class AICog(commands.Cog, name="AICog"):
    def __init__(self, bot: commands.Bot, cfg: AIConfig) -> None:
        self.bot = bot
        self.cfg = cfg
        self.storage: AIStorage | None = None
        self.storage_error: str | None = None
        self.client = OpenRouterClient(cfg)
        self.google_client: GoogleAIClient | None = GoogleAIClient(cfg) if cfg.has_google_key else None
        self.budget = RequestBudget(cfg, None)
        self.provider: ProviderChain | None = None
        self.persona = PersonaStore(cfg.persona_dir)
        self.memory: MemoryService | None = None
        self.orchestrator: Orchestrator | None = None
        # guild_id → {key: value}; (guild_id, channel_id) → {key: value}
        self._guild_settings: dict[int, dict[str, str]] = {}
        self._channel_settings: dict[tuple[int, int], dict[str, str]] = {}
        self._opt_outs: set[tuple[int, int]] = set()
        self._processed: OrderedDict[int, None] = OrderedDict()
        self._slash_synced = False
        self._last_backup_day: str | None = None

    # ------------------------------------------------------------------
    # Yaşam döngüsü
    # ------------------------------------------------------------------

    async def cog_load(self) -> None:
        try:
            storage = AIStorage(self.cfg.db_path)
            await storage.open()
            self.storage = storage
            for guild_id, channel_id, key, value in await storage.load_settings():
                if channel_id:
                    self._channel_settings.setdefault((guild_id, channel_id), {})[key] = value
                else:
                    self._guild_settings.setdefault(guild_id, {})[key] = value
            self._opt_outs = await storage.load_opt_outs()
            self.budget = RequestBudget(self.cfg, storage)
            await self.budget.load()
            log.info("AI veritabanı hazır: %s (şema v%d)", self.cfg.db_path.name, await storage.schema_version())
        except Exception as err:
            # Hafıza olmadan da (sadece sohbet) çalışabiliriz; durum !aidurum'da görünür.
            self.storage = None
            self.storage_error = f"{type(err).__name__}: {err}"
            log.exception("AI veritabanı açılamadı — hafıza/indeksleme devre dışı, sadece sohbet modu")

        retriever = memory = None
        if self.storage is not None:
            retriever = Retriever(
                self.storage,
                search_results=self.cfg.search_results,
                final_passages=self.cfg.final_passages,
                neighbor_messages=self.cfg.neighbor_messages,
                neighbor_window_seconds=self.cfg.neighbor_window_seconds,
            )
            memory = MemoryService(self.storage, candidate_retention_days=self.cfg.candidate_retention_days)
        self.memory = memory
        by_name = {"openrouter": self.client, "google": self.google_client}
        clients = [by_name[p] for p in self.cfg.providers if by_name.get(p) is not None]
        self.provider = ProviderChain(clients or [self.client], self.budget)
        self.orchestrator = Orchestrator(
            self.cfg,
            client=self.provider,
            budget=self.budget,
            persona=self.persona,
            storage=self.storage,
            retriever=retriever,
            memory=memory,
            stats=self._build_stats(),
            name_for=self._display_name,
            channel_name_for=self._channel_name,
        )
        if not self.cfg.providers:
            log.warning("AI_ENABLED=true fakat ne GOOGLE_AI_API_KEY ne OPENROUTER_API_KEY var — AI yanıtları devre dışı")
        if self.google_client is not None:
            log.warning(
                "Google AI etkin (ÜCRETLİ olabilir): model=%s günlük sınır=%d istek / ~$%.2f",
                self.cfg.google_model, self.cfg.google_daily_request_budget, self.cfg.google_daily_cost_limit_usd,
            )
        self.maintenance_loop.start()
        log.info(
            "AI modülü yüklendi: sağlayıcılar=%s openrouter=%s%s mod=%s hafıza=%s bütçe=[%s]",
            " → ".join(c.label for c in self.provider.clients), self.cfg.model,
            f" (yedek: {self.cfg.fallback_model})" if self.cfg.fallback_model else "", self.cfg.response_mode,
            self.cfg.memory_enabled and self.storage is not None, self.budget.describe(),
        )

    async def cog_unload(self) -> None:
        self.maintenance_loop.cancel()
        clients = self.provider.clients if self.provider else [self.client, self.google_client]
        for c in {id(c): c for c in [*clients, self.client, self.google_client] if c is not None}.values():
            try:
                await c.aclose()
            except Exception:
                log.exception("%s istemcisi kapatılamadı", c.label)
        if self.storage is not None:
            try:
                await self.storage.close()
            except Exception:
                log.exception("AI veritabanı kapatılamadı")

    def _build_stats(self) -> StatsService | None:
        try:
            import bestfriend
            threshold = bestfriend.BEST_FRIEND_THRESHOLD_SECONDS
        except Exception:
            threshold = 100 * 3600

        def level_for(total_xp: int) -> int:
            xp_cog = self.bot.get_cog("XPTrackerCog")
            if xp_cog is None:
                return 0
            return int(xp_cog.get_progress_data(total_xp)[0])

        def name_for(user_id: int) -> str:
            return self._display_name(None, user_id, None)

        return StatsService(level_for=level_for, name_for=name_for, bestfriend_threshold_seconds=threshold)

    # ------------------------------------------------------------------
    # Ayarlar
    # ------------------------------------------------------------------

    def guild_setting(self, guild_id: int, key: str, default: str) -> str:
        return self._guild_settings.get(guild_id, {}).get(key, default)

    def guild_enabled(self, guild_id: int) -> bool:
        return self.guild_setting(guild_id, "enabled", "1") == "1"

    def response_mode(self, guild_id: int) -> str:
        return self.guild_setting(guild_id, "response_mode", self.cfg.response_mode)

    def channel_cooldown(self, guild_id: int) -> int:
        try:
            return int(self.guild_setting(guild_id, "channel_cooldown", str(self.cfg.channel_cooldown_seconds)))
        except ValueError:
            return self.cfg.channel_cooldown_seconds

    def retention_days(self, guild_id: int) -> int:
        try:
            return int(self.guild_setting(guild_id, "retention_days", str(self.cfg.message_retention_days)))
        except ValueError:
            return self.cfg.message_retention_days

    def is_indexed(self, guild_id: int, channel_id: int) -> bool:
        value = self._channel_settings.get((guild_id, channel_id), {}).get("index")
        if value is None:
            return self.cfg.indexing_default
        return value == "1"

    def indexed_channels(self, guild: discord.Guild) -> set[int]:
        explicit = {cid for (gid, cid), s in self._channel_settings.items() if gid == guild.id and s.get("index") == "1"}
        if not self.cfg.indexing_default:
            return explicit
        disabled = {cid for (gid, cid), s in self._channel_settings.items() if gid == guild.id and s.get("index") == "0"}
        return (explicit | {c.id for c in guild.text_channels}) - disabled

    async def _set_guild(self, guild_id: int, key: str, value: str, by: int) -> None:
        if self.storage is None:
            raise RuntimeError("AI veritabanı kullanılamıyor")
        await self.storage.set_setting(guild_id, 0, key, value, by)
        self._guild_settings.setdefault(guild_id, {})[key] = value

    async def _set_channel(self, guild_id: int, channel_id: int, key: str, value: str, by: int) -> None:
        if self.storage is None:
            raise RuntimeError("AI veritabanı kullanılamıyor")
        await self.storage.set_setting(guild_id, channel_id, key, value, by)
        self._channel_settings.setdefault((guild_id, channel_id), {})[key] = value

    # ------------------------------------------------------------------
    # İsim çözümleme
    # ------------------------------------------------------------------

    def _display_name(self, guild_id: int | None, user_id: int, fallback: str | None) -> str:
        if self.bot.user and user_id == self.bot.user.id:
            return "Bot-GAP"
        guilds = [self.bot.get_guild(guild_id)] if guild_id else self.bot.guilds
        for guild in guilds:
            member = guild.get_member(user_id) if guild else None
            if member is not None:
                return member.display_name
        return fallback or "eski üye"

    def _channel_name(self, guild_id: int, channel_id: int) -> str:
        guild = self.bot.get_guild(guild_id)
        ch = guild.get_channel_or_thread(channel_id) if guild else None
        return getattr(ch, "name", None) or "kanal"

    # ------------------------------------------------------------------
    # Durum
    # ------------------------------------------------------------------

    def unavailable_reason(self, guild_id: int | None = None) -> str | None:
        if guild_id is not None and not self.guild_enabled(guild_id):
            return "Bu sunucuda AI özellikleri yönetici tarafından kapatıldı."
        if not self.cfg.providers:
            return "AI yapılandırılmamış (API anahtarı yok). Yöneticiye haber ver."
        return None

    def _provider_lines(self) -> list[str]:
        """Sağlayıcı başına model, günlük kullanım/sınır ve (ücretliyse) tahmini harcama."""
        if self.provider is None:
            return []
        lines = []
        for i, c in enumerate(self.provider.clients, 1):
            name = c.provider_name
            models = " → ".join(f"`{m}`" for m in c.model_chain())
            usage = f"{self.budget.provider_used(name)}/{self.budget.request_limit(name)} istek"
            if (limit := self.budget.cost_limit(name)) is not None:
                usage += f", ~${self.budget.provider_cost(name):.3f}/${limit:.2f}"
            state = c.circuit_reason()
            lines.append(f"**{i}. {c.label}:** {models} • bugün {usage} (UTC)" + (f" ⚠️ {state}" if state else ""))
        return lines

    def _mark_processed(self, message_id: int) -> bool:
        """Mesaj daha önce işlendiyse False (çift event koruması)."""
        if message_id in self._processed:
            return False
        self._processed[message_id] = None
        while len(self._processed) > PROCESSED_CACHE_SIZE:
            self._processed.popitem(last=False)
        return True

    async def _is_command(self, message: discord.Message) -> bool:
        prefixes = await self.bot.get_prefix(message)
        if isinstance(prefixes, str):
            prefixes = [prefixes]
        content = message.content
        return any(p and content.startswith(p) for p in prefixes if not p.startswith("<@"))

    def _is_trigger(self, message: discord.Message) -> bool:
        me = self.bot.user
        if me is None or self.response_mode(message.guild.id) != "mention":
            return False
        if any(u.id == me.id for u in message.mentions):
            return True
        ref = message.reference
        resolved = getattr(ref, "resolved", None) if ref else None
        return isinstance(resolved, discord.Message) and resolved.author.id == me.id

    # ------------------------------------------------------------------
    # Dinleyiciler
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_ready(self) -> None:
        if self.cfg.slash_sync and not self._slash_synced:
            self._slash_synced = True
            try:
                synced = await self.bot.tree.sync()
                log.info("Slash komutları senkronize edildi: %d", len(synced))
            except discord.HTTPException as err:
                log.warning("Slash komutları senkronize edilemedi: %s", err)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        try:
            if message.guild is None or message.author.bot or message.webhook_id is not None:
                return
            if not self.guild_enabled(message.guild.id) or not self._mark_processed(message.id):
                return
            is_command = await self._is_command(message)
            if not is_command:
                await self._ingest(message)
            if not is_command and self._is_trigger(message):
                await self._respond_to_message(message)
        except Exception:
            log.exception("AI on_message hatası (mesaj %s)", message.id)

    async def _ingest(self, message: discord.Message) -> None:
        if self.storage is None or not message.content.strip():
            return
        gid, cid, uid = message.guild.id, message.channel.id, message.author.id
        if not self.is_indexed(gid, cid) or (gid, uid) in self._opt_outs:
            return
        content = truncate(redact_sensitive(message.content), self.cfg.max_message_chars)
        ref_id = message.reference.message_id if message.reference else None
        inserted = await self.storage.insert_message(
            message_id=message.id, guild_id=gid, channel_id=cid, user_id=uid,
            author_name=message.author.display_name, content=content,
            created_at=message.created_at.timestamp(), reply_to_id=ref_id,
        )
        if inserted and self.memory is not None and self.cfg.memory_enabled:
            await self.memory.capture_plan(gid, cid, uid, message.author.display_name, message.id, content)

    @commands.Cog.listener()
    async def on_raw_message_edit(self, payload: discord.RawMessageUpdateEvent) -> None:
        if self.storage is None or payload.guild_id is None:
            return
        content = payload.data.get("content")
        if content is None:
            return
        try:
            await self.storage.update_message(
                payload.message_id,
                truncate(redact_sensitive(content), self.cfg.max_message_chars),
                time.time(),
            )
        except Exception:
            log.exception("AI mesaj düzenleme senkronu başarısız")

    @commands.Cog.listener()
    async def on_raw_message_delete(self, payload: discord.RawMessageDeleteEvent) -> None:
        await self._delete_ids(payload.guild_id, payload.channel_id, [payload.message_id])

    @commands.Cog.listener()
    async def on_raw_bulk_message_delete(self, payload: discord.RawBulkMessageDeleteEvent) -> None:
        await self._delete_ids(payload.guild_id, payload.channel_id, list(payload.message_ids))

    async def _delete_ids(self, guild_id: int | None, channel_id: int, ids: list[int]) -> None:
        if guild_id is None:
            return
        if self.orchestrator is not None:
            for mid in ids:
                self.orchestrator.cache.remove_message(guild_id, channel_id, mid)
        if self.storage is None:
            return
        try:
            deleted, revoked = await self.storage.delete_messages(ids)
            if revoked:
                log.info("Silinen mesajlar nedeniyle %d türetilmiş hafıza iptal edildi", revoked)
        except Exception:
            log.exception("AI mesaj silme senkronu başarısız")

    # ------------------------------------------------------------------
    # Yanıt üretimi
    # ------------------------------------------------------------------

    def _build_request(
        self,
        guild: discord.Guild,
        channel: Any,
        author: discord.Member,
        text: str,
        message_id: int | None,
        reply_msg: discord.Message | None,
    ) -> AIRequest:
        allowed = set()
        if self.storage is not None:
            allowed = authorized_source_channels(guild, author, channel, self.indexed_channels(guild))
        reply_line = None
        if reply_msg is not None and reply_msg.content and reply_msg.channel.id == channel.id:
            reply_line = ChatLine(
                "Bot-GAP (sen)" if self.bot.user and reply_msg.author.id == self.bot.user.id else reply_msg.author.display_name,
                redact_sensitive(reply_msg.content), reply_msg.created_at.timestamp(),
                is_bot=bool(self.bot.user and reply_msg.author.id == self.bot.user.id),
            )
        return AIRequest(
            guild_id=guild.id, guild_name=guild.name,
            channel_id=channel.id, channel_name=getattr(channel, "name", "kanal"),
            user_id=author.id, speaker_name=author.display_name,
            question=redact_sensitive(text),
            allowed_channels=allowed,
            channel_indexed=self.is_indexed(guild.id, channel.id),
            bot_id=self.bot.user.id if self.bot.user else None,
            message_id=message_id, reply_to=reply_line,
            channel_cooldown=self.channel_cooldown(guild.id),
        )

    def _format_response(self, resp: AIResponse) -> str:
        text = resp.text
        if resp.sources:
            text += "\n-# Kaynaklar: " + " ".join(f"<{u}>" for u in resp.sources)
        if resp.candidate_ids:
            ids = ", ".join(f"`!onayla {i}`" for i in resp.candidate_ids)
            text += f"\n-# 📝 Bunu hafızama eklememi istersen: {ids}"
        return text

    async def _generate(self, req: AIRequest, channel: Any) -> AIResponse:
        assert self.orchestrator is not None
        try:
            async with channel.typing():
                return await self.orchestrator.answer(req)
        except discord.HTTPException:
            # typing() başarısız olsa bile cevap üretmeyi dene.
            return await self.orchestrator.answer(req)

    async def _respond_to_message(self, message: discord.Message) -> None:
        reason = self.unavailable_reason(message.guild.id)
        if reason or self.orchestrator is None or not isinstance(message.author, discord.Member):
            if reason:
                await self._safe_reply(message, reason)
            return
        ref = message.reference
        reply_msg = ref.resolved if ref and isinstance(ref.resolved, discord.Message) else None
        req = self._build_request(message.guild, message.channel, message.author, message.content, message.id, reply_msg)
        resp = await self._generate(req, message.channel)
        await self._safe_reply(message, self._format_response(resp))

    async def _safe_reply(self, message: discord.Message, text: str) -> None:
        parts = split_message(text)
        try:
            first = True
            for part in parts:
                if first:
                    await message.reply(part, mention_author=False, allowed_mentions=NO_MENTIONS)
                    first = False
                else:
                    await message.channel.send(part, allowed_mentions=NO_MENTIONS)
        except discord.HTTPException as err:
            log.warning("AI cevabı gönderilemedi: %s", err)

    async def _ctx_send(self, ctx: commands.Context, text: str, *, ephemeral: bool = False) -> None:
        for part in split_message(text):
            await ctx.send(part, allowed_mentions=NO_MENTIONS, ephemeral=ephemeral)

    # ------------------------------------------------------------------
    # Hata yönetimi
    # ------------------------------------------------------------------

    async def cog_command_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, (commands.MissingPermissions, commands.CheckFailure)):
            msg = "❌ Bu komut için yönetici yetkisi gerekli." if isinstance(error, commands.MissingPermissions) \
                else "❌ Bu komut burada kullanılamaz."
        elif isinstance(error, (commands.MissingRequiredArgument, commands.BadArgument)):
            msg = f"❌ Hatalı kullanım. Örnek: `!{ctx.command.qualified_name} {ctx.command.signature}`"
        else:
            msg = "❌ Bir şeyler ters gitti; olay kaydedildi."
        try:
            await ctx.send(msg, allowed_mentions=NO_MENTIONS, ephemeral=True)
        except discord.HTTPException:
            pass

    def _require_storage(self, guild_id: int | None = None) -> str | None:
        """guild_id verilirse sunucuda AI'ın açık olması da şart koşulur (gizlilik komutları vermez)."""
        if self.storage is None:
            return "❌ AI hafıza veritabanı şu an kullanılamıyor (`!aidurum`)."
        if guild_id is not None and not self.guild_enabled(guild_id):
            return "⛔ Bu sunucuda AI özellikleri yönetici tarafından kapatıldı."
        return None

    # ------------------------------------------------------------------
    # Kullanıcı komutları
    # ------------------------------------------------------------------

    @commands.hybrid_command(name="ai", description="Bot-GAP'e bir şey sor")
    @commands.guild_only()
    async def ai_command(self, ctx: commands.Context, *, mesaj: str) -> None:
        """Yapay zekâya soru sor: !ai <mesaj>"""
        reason = self.unavailable_reason(ctx.guild.id)
        if reason or self.orchestrator is None:
            await self._ctx_send(ctx, reason or "❌ AI kullanılamıyor.", ephemeral=True)
            return
        if ctx.interaction is not None:
            await ctx.defer()
        reply_msg = None
        if ctx.interaction is None and ctx.message.reference and isinstance(ctx.message.reference.resolved, discord.Message):
            reply_msg = ctx.message.reference.resolved
        req = self._build_request(
            ctx.guild, ctx.channel, ctx.author, mesaj,
            ctx.message.id if ctx.interaction is None else None, reply_msg,
        )
        resp = await self._generate(req, ctx.channel)
        await self._ctx_send(ctx, self._format_response(resp))

    @commands.hybrid_command(name="hatirla", aliases=["hatırla"], description="Kayıtlı sohbet geçmişinde ara")
    @commands.guild_only()
    async def hatirla_command(self, ctx: commands.Context, *, sorgu: str) -> None:
        """Yetkili kanalların kayıtlı geçmişinde arar (yapay zekâ kotası harcamaz)."""
        if err := self._require_storage(ctx.guild.id):
            await self._ctx_send(ctx, err, ephemeral=True)
            return
        allowed = authorized_source_channels(ctx.guild, ctx.author, ctx.channel, self.indexed_channels(ctx.guild))
        if not allowed:
            await self._ctx_send(
                ctx, "Bu kanaldan erişebileceğim, hafızası açık bir kanal yok. "
                     "Yöneticiler `!aiayar kanal ekle` ile kanal açabilir.", ephemeral=True)
            return
        result = await self.orchestrator.recall(ctx.guild.id, sorgu, allowed, self.bot.user.id if self.bot.user else None)
        if result is None or result.empty:
            hint = "" if result is None or result.terms else " (aranacak anlamlı bir kelime bulamadım)"
            await self._ctx_send(ctx, f"🔎 Bununla ilgili bir konuşma bulamadım{hint}. "
                                      "Farklı kelimelerle denemek işe yarayabilir.")
            return
        embed = discord.Embed(
            title=f"🔎 \"{truncate(sorgu, 80)}\" için bulduklarım",
            color=discord.Color.from_rgb(0, 212, 255),
        )
        for p in result.passages:
            lines = []
            for m in p.messages:
                name = self._display_name(ctx.guild.id, m.user_id, m.author_name)
                marker = "▶ " if m.message_id in p.hit_ids else ""
                lines.append(f"{marker}**{discord.utils.escape_markdown(name)}:** "
                             f"{discord.utils.escape_markdown(truncate(collapse_ws(m.content), 160))}")
            anchor = p.anchor
            value = truncate("\n".join(lines), 900) + f"\n[Mesaja git]({jump_url(ctx.guild.id, p.channel_id, anchor.message_id)})"
            embed.add_field(
                name=f"#{self._channel_name(ctx.guild.id, p.channel_id)} • {_fmt_date(anchor.created_at)}",
                value=value, inline=False,
            )
        filters = []
        if result.time_filter.label:
            filters.append(f"zaman: {result.time_filter.label}")
        if result.author_id:
            filters.append(f"yazan: {self._display_name(ctx.guild.id, result.author_id, None)}")
        embed.set_footer(text="Arama kelime eşleşmesiyle yapılır; farklı ifade edilmiş konuşmaları kaçırabilir."
                         + (f" | {', '.join(filters)}" if filters else ""))
        await ctx.send(embed=embed, allowed_mentions=NO_MENTIONS)

    @commands.hybrid_command(name="hafizam", aliases=["hafızam"], description="Hakkındaki kayıtlı hafızaları gör")
    @commands.guild_only()
    async def hafizam_command(self, ctx: commands.Context) -> None:
        """Hakkında tuttuğum hafızaları gösterir (DM ile)."""
        if err := self._require_storage():
            await self._ctx_send(ctx, err, ephemeral=True)
            return
        mems = await self.storage.list_user_memories(ctx.guild.id, ctx.author.id)
        msgs, _ = await self.storage.count_user_data(ctx.guild.id, ctx.author.id)
        lines = [f"🧠 **{ctx.guild.name}** sunucusunda hakkında tuttuklarım:"]
        if not mems:
            lines.append("_Kayıtlı hafıza yok._")
        for m in mems:
            status = "✅" if m.status == "confirmed" else "❔ aday"
            exp = f" (bitiş {_fmt_date(m.expires_at)})" if m.expires_at else ""
            lines.append(f"`#{m.id}` {status} {discord.utils.escape_markdown(m.content)}{exp}")
        lines.append(f"\n📨 İndekslenmiş mesaj sayın: **{msgs}**")
        lines.append("Sil: `!unut <id>` • Aday onayla: `!onayla <id>` • Her şeyi sil: `!unuttur` • "
                     "Mesajlarımı kaydetme: `!aigizlilik kapat`")
        text = "\n".join(lines)
        if ctx.interaction is not None:
            await self._ctx_send(ctx, text, ephemeral=True)
            return
        try:
            for part in split_message(text):
                await ctx.author.send(part, allowed_mentions=NO_MENTIONS)
            await ctx.message.add_reaction("📬")
        except discord.HTTPException:
            await ctx.send("DM'lerin kapalı olduğu için gönderemedim; aşağıdaki mesaj 60 sn sonra silinecek.",
                           delete_after=60)
            for part in split_message(text):
                await ctx.send(part, allowed_mentions=NO_MENTIONS, delete_after=60)

    @commands.hybrid_command(name="hafizaekle", aliases=["aklindatut", "aklındatut"],
                             description="Kendin hakkında bir bilgiyi hatırlamamı iste")
    @commands.guild_only()
    async def hafizaekle_command(self, ctx: commands.Context, *, bilgi: str) -> None:
        """Kendin hakkında bir bilgiyi hafızama ekler: !hafizaekle en sevdiğim oyun Valorant"""
        if err := self._require_storage(ctx.guild.id):
            await self._ctx_send(ctx, err, ephemeral=True)
            return
        if not self.cfg.memory_enabled:
            await self._ctx_send(ctx, "❌ Uzun süreli hafıza bu botta kapalı.", ephemeral=True)
            return
        try:
            mem_id, created = await self.memory.remember_user(ctx.guild.id, ctx.author.id, bilgi)
        except MemoryError_ as err:
            await self._ctx_send(ctx, f"❌ {err.user_message}", ephemeral=True)
            return
        verb = "Not aldım" if created else "Zaten biliyordum, güncelledim"
        await self._ctx_send(ctx, f"🧠 {verb} (`#{mem_id}`). Silmek için `!unut {mem_id}`.", ephemeral=True)

    @commands.hybrid_command(name="onayla", description="Aday bir hafızayı onayla")
    @commands.guild_only()
    async def onayla_command(self, ctx: commands.Context, memory_id: int) -> None:
        """Aday hafızayı onaylar: !onayla <id>"""
        if err := self._require_storage():
            await self._ctx_send(ctx, err, ephemeral=True)
            return
        try:
            mem = await self.memory.confirm(ctx.guild.id, ctx.author.id, memory_id)
        except MemoryError_ as err:
            await self._ctx_send(ctx, f"❌ {err.user_message}", ephemeral=True)
            return
        await self._ctx_send(ctx, f"✅ Hafızaya eklendi: {discord.utils.escape_markdown(mem.content)}", ephemeral=True)

    @commands.hybrid_command(name="unut", description="Bir hafıza kaydını sil")
    @commands.guild_only()
    async def unut_command(self, ctx: commands.Context, memory_id: int) -> None:
        """Sana ait (veya katılımcısı olduğun) bir hafızayı siler: !unut <id>"""
        if err := self._require_storage():
            await self._ctx_send(ctx, err, ephemeral=True)
            return
        is_admin = bool(getattr(ctx.author.guild_permissions, "administrator", False))
        try:
            await self.memory.forget(ctx.guild.id, ctx.author.id, memory_id, is_admin=is_admin)
        except MemoryError_ as err:
            await self._ctx_send(ctx, f"❌ {err.user_message}", ephemeral=True)
            return
        await self._ctx_send(ctx, f"🗑️ `#{memory_id}` numaralı hafıza silindi.", ephemeral=True)

    @commands.hybrid_command(name="unuttur", description="Bu sunucudaki tüm AI verilerini sil")
    @commands.guild_only()
    async def unuttur_command(self, ctx: commands.Context, onay: str | None = None) -> None:
        """Bu sunucudaki kayıtlı mesajlarını ve kişisel hafızalarını kalıcı olarak siler."""
        if err := self._require_storage():
            await self._ctx_send(ctx, err, ephemeral=True)
            return
        msgs, mems = await self.storage.count_user_data(ctx.guild.id, ctx.author.id)
        if (onay or "").strip().lower() not in {"onay", "onayla", "evet"}:
            await self._ctx_send(
                ctx,
                f"⚠️ Bu sunucuda hakkında **{msgs}** kayıtlı mesaj ve **{mems}** hafıza var.\n"
                "Hepsini kalıcı olarak silmek için `!unuttur onay` yaz. Bu işlem geri alınamaz.\n"
                "-# İleride mesajlarının hiç kaydedilmemesi için: `!aigizlilik kapat`",
                ephemeral=True,
            )
            return
        deleted_msgs, deleted_mems = await self.storage.delete_user_data(ctx.guild.id, ctx.author.id)
        self.orchestrator.cache.forget_user(ctx.guild.id, ctx.author.id)
        log.info("Kullanıcı AI verisini sildi: guild=%s user=%s mesaj=%d hafıza=%d",
                 ctx.guild.id, ctx.author.id, deleted_msgs, deleted_mems)
        await self._ctx_send(ctx, f"🧹 Silindi: {deleted_msgs} mesaj kaydı, {deleted_mems} hafıza.", ephemeral=True)

    @commands.hybrid_command(name="aigizlilik", description="Mesajlarının AI hafızasına kaydedilmesini aç/kapat")
    @commands.guild_only()
    async def aigizlilik_command(self, ctx: commands.Context, durum: str | None = None) -> None:
        """!aigizlilik kapat → mesajların kaydedilmez • !aigizlilik ac → tekrar izin ver"""
        if err := self._require_storage():
            await self._ctx_send(ctx, err, ephemeral=True)
            return
        key = (ctx.guild.id, ctx.author.id)
        choice = (durum or "").strip().lower()
        if choice in {"kapat", "kapali", "kapalı", "off"}:
            await self.storage.set_opt_out(*key, True)
            self._opt_outs.add(key)
            await self._ctx_send(ctx, "🔒 Bundan sonra mesajların AI hafızasına kaydedilmeyecek. "
                                      "Mevcut kayıtları silmek için `!unuttur`.", ephemeral=True)
        elif choice in {"ac", "aç", "acik", "açık", "on"}:
            await self.storage.set_opt_out(*key, False)
            self._opt_outs.discard(key)
            await self._ctx_send(ctx, "🔓 Hafızası açık kanallardaki mesajların yeniden kaydedilebilir.", ephemeral=True)
        else:
            state = "kapalı 🔒" if key in self._opt_outs else "açık 🔓"
            await self._ctx_send(ctx, f"Mesaj kaydı izni: **{state}**. Değiştirmek için `!aigizlilik ac|kapat`.",
                                 ephemeral=True)

    @commands.hybrid_command(name="ani", aliases=["anı"], description="Bu kanala ortak bir anı kaydet")
    @commands.guild_only()
    async def ani_command(self, ctx: commands.Context, *, metin: str) -> None:
        """Ortak bir anı kaydeder: !ani Dün gece 5 saat Valorant oynadık @ali @veli"""
        if err := self._require_storage(ctx.guild.id):
            await self._ctx_send(ctx, err, ephemeral=True)
            return
        participants = [m.id for m in (ctx.message.mentions if ctx.interaction is None else []) if not m.bot]
        sources: list[tuple[int, int | None]] = []
        ref = ctx.message.reference if ctx.interaction is None else None
        if ref and ref.message_id and self.is_indexed(ctx.guild.id, ctx.channel.id):
            sources.append((ref.message_id, ctx.channel.id))
        content = render_mentions(
            metin, lambda uid: self._display_name(ctx.guild.id, uid, None),
            lambda cid: self._channel_name(ctx.guild.id, cid),
        )
        try:
            mem_id, created = await self.memory.add_episode(
                ctx.guild.id, ctx.channel.id, ctx.author.id, content, participants, sources,
            )
        except MemoryError_ as err:
            await self._ctx_send(ctx, f"❌ {err.user_message}", ephemeral=True)
            return
        await self._ctx_send(ctx, f"📸 Anı kaydedildi (`#{mem_id}`)." if created else f"Bu anı zaten kayıtlı (`#{mem_id}`).")

    @commands.hybrid_command(name="anilar", aliases=["anılar"], description="Bu kanaldan görülebilen ortak anılar")
    @commands.guild_only()
    async def anilar_command(self, ctx: commands.Context) -> None:
        """Bu kanaldan erişilebilen kayıtlı ortak anıları ve plan adaylarını listeler."""
        if err := self._require_storage(ctx.guild.id):
            await self._ctx_send(ctx, err, ephemeral=True)
            return
        visible = {ctx.channel.id} | authorized_source_channels(
            ctx.guild, ctx.author, ctx.channel, {c.id for c in ctx.guild.text_channels}
        )
        mems = await self.storage.list_episodic(ctx.guild.id, visible, statuses=("confirmed", "candidate"), limit=15)
        if not mems:
            await self._ctx_send(ctx, "Henüz kayıtlı bir ortak anı yok. `!ani <metin>` ile ekleyebilirsin.")
            return
        lines = ["📸 **Ortak anılar**"]
        for m in mems:
            tag = "" if m.status == "confirmed" else " _(otomatik plan adayı)_"
            lines.append(f"`#{m.id}` {_fmt_date(m.created_at)} — {discord.utils.escape_markdown(m.content)}{tag}")
        await self._ctx_send(ctx, "\n".join(lines))

    @commands.hybrid_command(name="aiyardim", aliases=["aiyardım"], description="AI özellikleri ve gizlilik bilgisi")
    async def aiyardim_command(self, ctx: commands.Context) -> None:
        """AI yetenekleri, sınırları ve gizlilik bilgisi."""
        embed = discord.Embed(title="🤖 Bot-GAP Yapay Zekâ", color=discord.Color.from_rgb(98, 225, 194))
        embed.add_field(name="💬 Sohbet", value=(
            "• Beni etiketle veya mesajıma yanıt ver: `@Bot-GAP selam`\n"
            "• `!ai <mesaj>` — doğrudan soru sor\n"
            "• \"Kim en yüksek seviyede?\", \"seviyem kaç?\", \"best friend'im kim?\" gibi soruları "
            "gerçek veritabanından cevaplarım."
        ), inline=False)
        embed.add_field(name="🧠 Hafıza", value=(
            "• `!hatirla <konu>` — hafızası açık kanallarda geçmiş konuşmaları arar (kota harcamaz)\n"
            "• `!hafizaekle <bilgi>` — kendin hakkında bir şeyi hatırlamamı iste\n"
            "• `!hafizam` — hakkında tuttuklarımı gör (DM) • `!onayla <id>` — aday hafızayı onayla\n"
            "• `!ani <metin>` / `!anilar` — ortak anılar"
        ), inline=False)
        embed.add_field(name="🔒 Gizlilik", value=(
            "• Mesajlar yalnızca yöneticilerin **açıkça açtığı** kanallarda, "
            f"en fazla **{self.cfg.message_retention_days} gün** (sunucu ayarına göre) saklanır. DM'ler saklanmaz.\n"
            "• E-posta, telefon, kart, şifre gibi bilgiler kaydedilmeden önce maskelenir.\n"
            "• Silinen/düzenlenen mesajlar hafızada da silinir/güncellenir.\n"
            "• `!unut <id>` • `!unuttur` (her şeyini sil) • `!aigizlilik kapat` (kaydetme)\n"
            "• Cevap üretmek için sorun ve yalnızca ilgili kısa bağlam bir yapay zekâ sağlayıcısına "
            "(Google AI Studio ve/veya OpenRouter) gönderilir; sağlayıcılar veriyi kendi koşullarına göre işleyebilir."
        ), inline=False)
        embed.add_field(name="⚠️ Sınırlar", value=(
            "• Geçmiş araması kelime eşleşmesiyle çalışır; farklı ifade edilmiş konuşmaları kaçırabilir.\n"
            "• Ücretsiz model kotası sınırlıdır; günlük ve kişisel limitler vardır.\n"
            "• Yapay zekâ hata yapabilir; kayıtta bulamadığı şeyi uydurmaması istenir ama garanti değildir."
        ), inline=False)
        await ctx.send(embed=embed, allowed_mentions=NO_MENTIONS)

    @commands.hybrid_command(name="aidurum", description="AI sistem durumu")
    async def aidurum_command(self, ctx: commands.Context) -> None:
        """AI durumu, model ve günlük bütçe."""
        guild_id = ctx.guild.id if ctx.guild else None
        circuit = self.provider.circuit_reason() if self.provider else "başlatılmadı"
        if guild_id is not None and not self.guild_enabled(guild_id):
            state = "⛔ Bu sunucuda kapalı"
        elif circuit:
            state = f"⚠️ Kısıtlı: {circuit}"
        else:
            state = "✅ Aktif"
        lines = [
            f"**Durum:** {state}",
        ]
        lines += self._provider_lines()
        if guild_id is not None:
            lines.append(f"**Senin bugünkü kullanımın:** {self.budget.user_used_today(guild_id, ctx.author.id)}"
                         f"/{self.cfg.user_daily_request_limit}")
        key = await self.provider.key_status() if self.provider else None
        free = (key or {}).get("free_model_daily_requests")
        if isinstance(free, dict) and free.get("limit") is not None:
            lines.append(f"**OpenRouter ücretsiz günlük kota:** {free.get('used', '?')}/{free.get('limit')}")
        lines.append(f"**Hafıza:** {'açık' if self.cfg.memory_enabled and self.storage else 'kapalı'}"
                     + (" — ⚠️ veritabanı hatası" if self.storage_error else ""))
        if guild_id is not None:
            lines.append(f"**Bu kanal indeksleniyor mu:** {'evet' if self.is_indexed(guild_id, ctx.channel.id) else 'hayır'}")
            lines.append(f"**Yanıt modu:** {self.response_mode(guild_id)}")
        await self._ctx_send(ctx, "\n".join(lines))

    # ------------------------------------------------------------------
    # Yönetici komutları
    # ------------------------------------------------------------------

    @commands.group(name="aiayar", invoke_without_command=True)
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def aiayar_group(self, ctx: commands.Context) -> None:
        """AI yönetici ayarları ve sistem durumu."""
        gid = ctx.guild.id
        channels = sorted(self.indexed_channels(ctx.guild))
        stats = await self.storage.stats() if self.storage else {}
        lines = [
            "⚙️ **AI ayarları**",
            f"Sunucuda AI: **{'açık' if self.guild_enabled(gid) else 'kapalı'}** • Yanıt modu: **{self.response_mode(gid)}**",
            f"Kanal cooldown: **{self.channel_cooldown(gid)} sn** • Kullanıcı cooldown: {self.cfg.user_cooldown_seconds} sn",
            f"Mesaj saklama: **{self.retention_days(gid)} gün**",
            f"İndekslenen kanallar: {' '.join(f'<#{c}>' for c in channels) or '_yok_'}",
            *self._provider_lines(),
            f"Kuyruk: {self.budget.queue_depth} • Son hata: {getattr(self.provider, 'last_error', None) or '-'}"
            f" • Son model: `{getattr(self.provider, 'last_model_used', None) or '-'}`",
        ]
        cooling = self.provider.cooling_models() if self.provider else {}
        if cooling:
            lines.append("Soğumadaki modeller: " + ", ".join(f"`{m}` ({sec} sn)" for m, sec in cooling.items()))
        if stats:
            lines.append(
                f"DB: {stats.get('messages', 0)} mesaj, {stats.get('memories', 0)} hafıza, "
                f"{stats.get('candidates', 0)} aday • {stats.get('db_bytes', 0) / 1e6:.1f} MB "
                f"(WAL {stats.get('wal_bytes', 0) / 1e6:.1f} MB)"
            )
        if self.storage_error:
            lines.append(f"⚠️ DB hatası: `{truncate(self.storage_error, 200)}`")
        lines.append(
            "\nKomutlar: `!aiayar ac|kapat` • `!aiayar kanal ekle|cikar [#kanal]` • `!aiayar mod mention|command` • "
            "`!aiayar cooldown <sn>` • `!aiayar saklama <gün>` • `!aiayar bakim` • `!aiayar yedekle`"
        )
        await ctx.send("\n".join(lines), allowed_mentions=NO_MENTIONS)

    @aiayar_group.command(name="ac", aliases=["aç"])
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def aiayar_ac(self, ctx: commands.Context) -> None:
        await self._set_guild(ctx.guild.id, "enabled", "1", ctx.author.id)
        self._audit(ctx, "ai_enabled")
        await ctx.send("✅ AI bu sunucuda açıldı.")

    @aiayar_group.command(name="kapat")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def aiayar_kapat(self, ctx: commands.Context) -> None:
        await self._set_guild(ctx.guild.id, "enabled", "0", ctx.author.id)
        self._audit(ctx, "ai_disabled")
        await ctx.send("⛔ AI bu sunucuda kapatıldı (yanıt ve indeksleme durdu; mevcut veriler saklama süresince kalır).")

    @aiayar_group.command(name="kanal")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def aiayar_kanal(self, ctx: commands.Context, islem: str, kanal: discord.TextChannel | None = None) -> None:
        """!aiayar kanal ekle|cikar [#kanal]"""
        target = kanal or ctx.channel
        islem = islem.lower()
        if islem in {"ekle", "ac", "aç"}:
            await self._set_channel(ctx.guild.id, target.id, "index", "1", ctx.author.id)
            self._audit(ctx, "ai_index_on", channel=target.id)
            await ctx.send(f"🧠 {target.mention} için AI hafızası açıldı.", allowed_mentions=NO_MENTIONS)
            try:
                await target.send(
                    "📌 **Bilgilendirme:** Bu kanaldaki mesajlar, bot sohbetlerinde geçmişi hatırlayabilmesi için "
                    f"en fazla **{self.retention_days(ctx.guild.id)} gün** Bot-GAP AI hafızasında saklanacak. "
                    "Hassas bilgiler maskelenir; silinen mesajlar hafızadan da silinir.\n"
                    "Kaydedilmek istemiyorsan `!aigizlilik kapat`, kayıtlarını silmek için `!unuttur`. "
                    "Detaylar: `!aiyardim`",
                    allowed_mentions=NO_MENTIONS,
                )
            except discord.HTTPException:
                pass
        elif islem in {"cikar", "çıkar", "kapat", "sil"}:
            await self._set_channel(ctx.guild.id, target.id, "index", "0", ctx.author.id)
            self._audit(ctx, "ai_index_off", channel=target.id)
            await ctx.send(f"🔕 {target.mention} için AI hafızası kapatıldı. Mevcut kayıtlar artık aramada "
                           "kullanılmaz ve saklama süresi dolunca silinir.", allowed_mentions=NO_MENTIONS)
        else:
            await ctx.send("Kullanım: `!aiayar kanal ekle|cikar [#kanal]`")

    @aiayar_group.command(name="mod")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def aiayar_mod(self, ctx: commands.Context, mod: str) -> None:
        mod = mod.lower()
        if mod not in {"mention", "command"}:
            await ctx.send("Kullanım: `!aiayar mod mention|command` (command = sadece `!ai`)")
            return
        await self._set_guild(ctx.guild.id, "response_mode", mod, ctx.author.id)
        self._audit(ctx, "ai_mode", mode=mod)
        await ctx.send(f"✅ Yanıt modu: **{mod}**")

    @aiayar_group.command(name="cooldown")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def aiayar_cooldown(self, ctx: commands.Context, saniye: int) -> None:
        saniye = max(0, min(3600, saniye))
        await self._set_guild(ctx.guild.id, "channel_cooldown", str(saniye), ctx.author.id)
        self._audit(ctx, "ai_cooldown", seconds=saniye)
        await ctx.send(f"✅ Kanal cooldown: **{saniye} sn**")

    @aiayar_group.command(name="saklama")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def aiayar_saklama(self, ctx: commands.Context, gun: int) -> None:
        gun = max(1, min(3650, gun))
        await self._set_guild(ctx.guild.id, "retention_days", str(gun), ctx.author.id)
        self._audit(ctx, "ai_retention", days=gun)
        await ctx.send(f"✅ Mesaj saklama süresi: **{gun} gün** (bir sonraki bakımda uygulanır, `!aiayar bakim`).")

    @aiayar_group.command(name="bakim", aliases=["bakım"])
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def aiayar_bakim(self, ctx: commands.Context) -> None:
        if err := self._require_storage():
            await ctx.send(err)
            return
        result = await self._maintenance()
        await ctx.send(f"🧹 Bakım tamam: {result}")

    @aiayar_group.command(name="yedekle", aliases=["backup"])
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def aiayar_yedekle(self, ctx: commands.Context) -> None:
        if err := self._require_storage():
            await ctx.send(err)
            return
        path = await self._backup()
        self._audit(ctx, "ai_backup")
        await ctx.send(f"✅ AI veritabanı yedeklendi: `{path.name}`" if path else "❌ Yedek alınamadı.")

    def _audit(self, ctx: commands.Context, event: str, **meta: Any) -> None:
        log.info("AI ADMIN %s: %s (%s) guild=%s %s", event, ctx.author, ctx.author.id, ctx.guild.id, meta)
        try:
            import activitylog
            activitylog.record(f"admin_{event}", ctx.guild.id, ctx.author.id,
                               channel_id=ctx.channel.id, actor_id=ctx.author.id, **meta)
        except Exception:
            log.debug("activitylog kaydı yazılamadı", exc_info=True)

    # ------------------------------------------------------------------
    # Bakım ve yedek
    # ------------------------------------------------------------------

    async def _maintenance(self) -> dict[str, int]:
        assert self.storage is not None
        overrides: dict[int, int] = {}
        for gid, settings in self._guild_settings.items():
            if "retention_days" in settings:
                try:
                    overrides[gid] = int(settings["retention_days"])
                except ValueError:
                    pass
        result = await self.storage.prune(
            self.cfg.message_retention_days, overrides, self.cfg.candidate_retention_days
        )
        if any(result.values()):
            log.info("AI bakım: %s", result)
        return result

    async def _backup(self) -> Any:
        assert self.storage is not None
        day = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
        try:
            path = await self.storage.backup(self.cfg.backup_dir / f"ai_memory_{day}.db")
        except Exception:
            log.exception("AI veritabanı yedeği alınamadı")
            return None
        self._last_backup_day = day
        old = sorted(self.cfg.backup_dir.glob("ai_memory_*.db"))
        for stale in old[: max(0, len(old) - self.cfg.backup_keep)]:
            try:
                stale.unlink()
            except OSError:
                pass
        return path

    @tasks.loop(hours=MAINTENANCE_HOURS)
    async def maintenance_loop(self) -> None:
        if self.storage is None:
            return
        try:
            await self._maintenance()
            day = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d")
            if self._last_backup_day != day:
                path = await self._backup()
                if path:
                    log.info("AI veritabanı yedeği alındı: %s", path)
        except Exception:
            log.exception("AI bakım döngüsü hatası")

    @maintenance_loop.before_loop
    async def _before_maintenance(self) -> None:
        await self.bot.wait_until_ready()
        await asyncio.sleep(60)  # açılıştaki diğer işlerle çakışmasın
