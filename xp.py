"""
xp.py — XP sistemi: mesaj/ses XP, streak, boost, admin komutları.

Tüm DB işlemleri database.py üzerinden geçer; bu cog sadece
Discord event'lerini ve komutları yönetir.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from pathlib import Path

import discord
from discord.ext import commands, tasks

import activitylog
import database as db
from xproles import XPRoleManager

log = logging.getLogger("gap.xp")

# ---------------------------------------------------------------------------
# Sabitler
# ---------------------------------------------------------------------------

MESSAGE_XP_MIN = 3
MESSAGE_XP_MAX = 8
MESSAGE_COOLDOWN_SECONDS = 20

VOICE_XP_INTERVAL_MINUTES = 2
VOICE_XP_PER_INTERVAL = 1

# Açılışta önceki çalışmadan kalan ses oturumlarına en fazla bu kadar saniye
# eklenir (son flush'tan sonra geçen süre; botun kapalı kaldığı süre sayılmaz).
VOICE_RESTORE_MAX_SECONDS = VOICE_XP_INTERVAL_MINUTES * 60 + 60

# Streak bonusu: her streak günü için +% bonus (max %50)
STREAK_BONUS_PER_DAY = 0.02
STREAK_BONUS_MAX = 0.50

# Streak ödülleri: {gün: bonus_xp}
STREAK_MILESTONES: dict[int, int] = {
    7:  50,
    14: 120,
    30: 300,
    60: 700,
    100: 1500,
}

# Admin XP komutlarında zorunlu sebep açıklamasının en kısa uzunluğu
ADMIN_REASON_MIN_LENGTH = 5

BOOST_MIN, BOOST_MAX = 1.0, 10.0
BOOST_MAX_HOURS = 720

# Sürgündeki üyenin sabit XP çarpanı; boost ve seri çarpanı yok sayılır (bkz. exile.py)
EXILE_MULTIPLIER = 0.5

FEATURE_REQUESTS_PATH = Path(__file__).resolve().parent / "data" / "features.txt"
FEATURE_MAX_LENGTH = 1000


# ---------------------------------------------------------------------------
# Yardımcı fonksiyonlar
# ---------------------------------------------------------------------------

def format_duration(total_seconds: int) -> str:
    total_seconds = max(0, int(total_seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    parts: list[str] = []
    if hours:
        parts.append(f"{hours}sa")
    if minutes or hours:
        parts.append(f"{minutes}dk")
    parts.append(f"{seconds}sn")
    return " ".join(parts)


def streak_multiplier(streak_days: int) -> float:
    bonus = min(streak_days * STREAK_BONUS_PER_DAY, STREAK_BONUS_MAX)
    return round(1.0 + bonus, 4)


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class XPTrackerCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self.role_manager = XPRoleManager()
        # Cooldown: (guild_id, user_id) → unix timestamp
        self._cooldowns: dict[tuple[int, int], float] = {}
        self._feature_lock = asyncio.Lock()
        # Sürgünde 0.5x çarpanın küsuratı: (guild_id, user_id) → biriken XP (örn. ses XP'si 1 → 0.5)
        self._exile_carry: dict[tuple[int, int], float] = {}

    async def cog_load(self) -> None:
        await db.init_db()
        FEATURE_REQUESTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        FEATURE_REQUESTS_PATH.touch(exist_ok=True)

    def cog_unload(self) -> None:
        self.voice_xp_loop.cancel()
        self.daily_backup_loop.cancel()

    # ------------------------------------------------------------------
    # Cooldown
    # ------------------------------------------------------------------

    def _check_cooldown(self, guild_id: int, user_id: int) -> bool:
        """True döner ve cooldown'ı yenilerse XP kazanılabilir."""
        now = time.time()
        key = (guild_id, user_id)
        if now - self._cooldowns.get(key, 0) < MESSAGE_COOLDOWN_SECONDS:
            return False
        self._cooldowns[key] = now
        # Bellek temizliği
        if len(self._cooldowns) > 10_000:
            cutoff = now - MESSAGE_COOLDOWN_SECONDS
            self._cooldowns = {k: v for k, v in self._cooldowns.items() if v > cutoff}
        return True

    @staticmethod
    def _build_feature_entry(message: discord.Message, request: str) -> str:
        timestamp = discord.utils.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
        channel = getattr(message.channel, "name", str(message.channel.id))
        author = getattr(message.author, "display_name", str(message.author))
        # Satır sonları tek satıra indirilir; aksi halde dosyaya sahte kayıt eklenebilir.
        clean = " ".join(request.split())[:FEATURE_MAX_LENGTH]
        author = " ".join(author.split())
        return (
            f"[{timestamp}] "
            f"guild={message.guild.id} channel=#{channel} "
            f"user={author} ({message.author.id}) :: {clean}\n"
        )

    @staticmethod
    def _append_feature_entry(entry: str) -> None:
        with FEATURE_REQUESTS_PATH.open("a", encoding="utf-8") as handle:
            handle.write(entry)

    # ------------------------------------------------------------------
    # Ses yardımcıları
    # ------------------------------------------------------------------

    @staticmethod
    def _is_valid_voice_member(member: discord.Member) -> bool:
        vs = member.voice
        if member.bot or vs is None or vs.channel is None:
            return False
        if member.guild and member.guild.afk_channel and vs.channel.id == member.guild.afk_channel.id:
            return False
        return not (vs.self_deaf or vs.deaf)

    # ------------------------------------------------------------------
    # Senkronizasyon
    # ------------------------------------------------------------------

    def _audit_admin(
        self,
        ctx: commands.Context,
        event: str,
        target: discord.Member | None = None,
        amount: int | None = None,
        **meta,
    ) -> None:
        """Admin işlemini olay kaydına, log dosyasına ve log kanalına yazar."""
        target_id = target.id if target else ctx.author.id
        activitylog.record(
            event, ctx.guild.id, target_id,
            channel_id=ctx.channel.id, amount=amount, actor_id=ctx.author.id, **meta,
        )
        target_txt = f" → {target} ({target.id})" if target else ""
        log.info("ADMIN %s: %s (%s)%s amount=%s %s", event, ctx.author, ctx.author.id, target_txt, amount, meta)
        details = "\n".join(f"**{k}:** {v}" for k, v in meta.items())
        self.bot.dispatch(
            "gap_alert",
            ctx.guild,
            f"🛡️ Admin işlemi: {event}",
            f"**Yapan:** {ctx.author.mention} (`{ctx.author.id}`)\n"
            + (f"**Hedef:** {target.mention} (`{target.id}`)\n" if target else "")
            + (f"**Miktar:** {amount:+,}\n" if amount is not None else "")
            + details,
        )

    @staticmethod
    async def _require_reason(ctx: commands.Context, reason: str | None, usage: str) -> str | None:
        """Sebep yoksa veya çok kısaysa kullanıcıyı uyarır ve None döner."""
        reason = (reason or "").strip()
        if len(reason) < ADMIN_REASON_MIN_LENGTH:
            await ctx.send(
                f"❌ Bu işlem için sebep yazmak zorunlu (en az {ADMIN_REASON_MIN_LENGTH} karakter).\n"
                f"Kullanım: `{usage}`"
            )
            return None
        return reason[:300]

    async def get_exile(self, guild_id: int, user_id: int):
        """
        Üyenin süren sürgün kaydı (yoksa None). Süresi dolmuş ama henüz kapatılmamış
        bir sürgün burada kapatılır ki seri bozulmadan geri yüklensin.
        """
        row = await db.get_exile(guild_id, user_id)
        if row is None or not db.exile_expired(row):
            return row
        ended = await db.end_exile(guild_id, user_id)
        if ended is not None:
            self.bot.dispatch("exile_end", guild_id, user_id, ended, None)
        return None

    def _exiled_xp(self, guild_id: int, user_id: int, base: float) -> int:
        """Sürgün çarpanıyla kazanılan XP; küsurat bir sonrakine aktarılır."""
        key = (guild_id, user_id)
        total = self._exile_carry.get(key, 0.0) + base * EXILE_MULTIPLIER
        earned = int(total)
        self._exile_carry[key] = total - earned
        return earned

    async def _sync_role(self, member: discord.Member) -> None:
        row = await db.get_user_row(member.guild.id, member.id)
        total_xp = int(row["total_xp"]) if row else 0
        await self.role_manager.sync_member_role(member, total_xp)

    # ------------------------------------------------------------------
    # Public API (usercard.py ve leaderboard.py bunları kullanır)
    # ------------------------------------------------------------------

    async def get_user_stats(self, guild_id: int, user_id: int):
        return await db.get_user_row(guild_id, user_id)

    async def get_user_rank(self, guild_id: int, user_id: int) -> int:
        return await db.get_user_rank(guild_id, user_id)

    async def get_leaderboard(self, guild_id: int, limit: int = 10):
        return await db.get_leaderboard(guild_id, limit)

    def get_progress_data(self, total_xp: int) -> tuple[int, int, int, int, float]:
        return self.role_manager.get_progress_data(total_xp)

    def get_target_role(self, member: discord.Member, total_xp: int) -> discord.Role | None:
        return self.role_manager.get_target_role(member, total_xp)

    def get_display_role(self, member: discord.Member, total_xp: int) -> str:
        return self.role_manager.get_display_role(member, total_xp)

    @staticmethod
    def format_duration(seconds: int) -> str:
        return format_duration(seconds)

    def get_live_voice_seconds(
        self,
        guild_id: int,
        user_id: int,
        stored_seconds: int,
        started_at: float | None,
    ) -> int:
        if started_at is None:
            return stored_seconds
        return stored_seconds + max(0, int(time.time() - started_at))

    async def ensure_user(self, guild_id: int, user_id: int) -> None:
        await db.ensure_user(guild_id, user_id)

    # ------------------------------------------------------------------
    # Event: hazır
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_ready(self) -> None:
        await self._restore_voice_sessions()
        if not self.voice_xp_loop.is_running():
            self.voice_xp_loop.start()
        if not self.daily_backup_loop.is_running():
            self.daily_backup_loop.start()
        backup_path = await db.backup_db()
        if backup_path:
            log.info("Başlangıç veritabanı yedeği alındı: %s", backup_path)
        log.info("XP sistemi aktif: %s", self.bot.user)

    async def _restore_voice_sessions(self) -> None:
        """
        Önceki çalışmadan (ya da bağlantı kopmasından) kalan oturumları kapatır,
        şu an seste olanlar için yeni oturum açar. Botun kapalı kaldığı süre eklenmez.
        """
        for guild in self.bot.guilds:
            afk_id = guild.afk_channel.id if guild.afk_channel else None
            try:
                await db.close_stale_voice_sessions(guild.id, VOICE_RESTORE_MAX_SECONDS)
                for channel in guild.voice_channels:
                    if afk_id is not None and channel.id == afk_id:
                        continue
                    for member in channel.members:
                        if not member.bot:
                            await db.start_voice_session(guild.id, member.id)
            except Exception:
                log.exception("Ses oturumları geri yüklenemedi (guild=%s)", guild.id)

    # ------------------------------------------------------------------
    # Event: üye katılımı
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        await db.ensure_user(member.guild.id, member.id)
        await self._sync_role(member)

    # ------------------------------------------------------------------
    # Event: mesaj
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or message.guild is None:
            return

        ctx = await self.bot.get_context(message)
        guild_id = message.guild.id
        user_id = message.author.id

        # Sürgünde seri donar: ilerlemez, bozulmaz, ödül vermez.
        exile = await self.get_exile(guild_id, user_id)

        # Günlük seri, normal mesaj ve komut mesajlarında da ilerler.
        streak, is_first_today = (0, False) if exile else await db.update_streak(guild_id, user_id)

        # Streak milestone bildirimi
        if is_first_today and streak in STREAK_MILESTONES:
            bonus = STREAK_MILESTONES[streak]
            await db.add_text_xp(guild_id, user_id, bonus)
            activitylog.record(
                "xp_streak_bonus", guild_id, user_id,
                channel_id=message.channel.id, amount=bonus, streak=streak,
            )
            log.info("Streak ödülü: %s (%s) %d gün +%d XP", message.author, user_id, streak, bonus)
            try:
                await message.channel.send(
                    f"🔥 {message.author.mention} **{streak} günlük seri!** "
                    f"+{bonus} bonus XP kazandın!",
                    delete_after=15,
                )
            except discord.HTTPException:
                pass

        if ctx.valid:
            return

        await db.add_message_count(guild_id, user_id)

        if self._check_cooldown(guild_id, user_id):
            base_xp = random.randint(MESSAGE_XP_MIN, MESSAGE_XP_MAX)

            if exile:
                # Sürgün: sabit çarpan, boost ve seri yok sayılır
                boost, boost_src, s_mult = 1.0, None, None
                earned = self._exiled_xp(guild_id, user_id, base_xp)
                if earned <= 0:
                    return
            else:
                boost, boost_src = await db.get_active_boost(guild_id, user_id)
                s_mult = streak_multiplier(streak)
                earned = max(1, round(base_xp * boost * s_mult))

            # Seviye atlama kontrolü için önceki XP
            old_row = await db.get_user_row(guild_id, user_id)
            old_xp = int(old_row["total_xp"]) if old_row else 0
            old_level, _, _, _, _ = self.role_manager.get_progress_data(old_xp)

            await db.add_text_xp(guild_id, user_id, earned)
            activitylog.record(
                "xp_message", guild_id, user_id,
                channel_id=message.channel.id, amount=earned,
                base=base_xp, boost=boost if boost != 1.0 else None, boost_src=boost_src,
                streak_mult=s_mult,
                exile=EXILE_MULTIPLIER if exile else None,
            )

            if isinstance(message.author, discord.Member):
                await self._sync_role(message.author)

                new_xp = old_xp + earned
                new_level, _, _, _, _ = self.role_manager.get_progress_data(new_xp)
                if new_level > old_level:
                    activitylog.record(
                        "level_up", guild_id, user_id,
                        channel_id=message.channel.id, old=old_level, new=new_level, total_xp=new_xp,
                    )
                    log.info("Seviye atladı: %s (%s) %d → %d", message.author, user_id, old_level, new_level)
                    role_name = self.get_display_role(message.author, new_xp)
                    embed = discord.Embed(
                        title="🎉 Seviye Atladın!",
                        description=(
                            f"Tebrikler {message.author.mention}! "
                            f"**Seviye {new_level}** ({role_name}) derecesine ulaştın! 🚀"
                        ),
                        color=discord.Color.from_rgb(0, 212, 255),
                    )
                    try:
                        avatar_url = message.author.display_avatar.url
                        embed.set_thumbnail(url=avatar_url)
                    except Exception:
                        pass
                    try:
                        await message.channel.send(embed=embed)
                    except (discord.HTTPException, discord.Forbidden):
                        pass

    # ------------------------------------------------------------------
    # Event: ses durumu
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_voice_state_update(
        self,
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ) -> None:
        if member.bot or member.guild is None:
            return

        afk_id = member.guild.afk_channel.id if member.guild.afk_channel else None
        was_in = before.channel is not None and (afk_id is None or before.channel.id != afk_id)
        is_in = after.channel is not None and (afk_id is None or after.channel.id != afk_id)

        if not was_in and is_in:
            await db.ensure_user(member.guild.id, member.id)
            await db.start_voice_session(member.guild.id, member.id)
        elif was_in and not is_in:
            await db.end_voice_session(member.guild.id, member.id)

    # ------------------------------------------------------------------
    # Periyodik ses XP
    # ------------------------------------------------------------------

    @tasks.loop(minutes=VOICE_XP_INTERVAL_MINUTES)
    async def voice_xp_loop(self) -> None:
        for guild in self.bot.guilds:
            try:
                # Ses süresini düzenli olarak DB'ye yaz (çökmede süre kaybı/şişmesi olmasın)
                await db.flush_voice_sessions(guild.id)
            except Exception:
                log.exception("Ses süresi kaydedilemedi (guild=%s)", guild.id)

            afk_id = guild.afk_channel.id if guild.afk_channel else None
            for channel in guild.voice_channels:
                if afk_id is not None and channel.id == afk_id:
                    continue
                valid = [m for m in channel.members if self._is_valid_voice_member(m)]
                if len(valid) < 2:
                    continue
                for member in valid:
                    # Tek bir üyedeki hata (üye çıktı, DB kilitli…) döngünün tamamını durdurmamalı
                    try:
                        exile = await self.get_exile(guild.id, member.id)
                        if exile:
                            boost, boost_src = 1.0, None
                            earned = self._exiled_xp(guild.id, member.id, VOICE_XP_PER_INTERVAL)
                            if earned <= 0:
                                continue
                        else:
                            boost, boost_src = await db.get_active_boost(guild.id, member.id)
                            earned = max(1, round(VOICE_XP_PER_INTERVAL * boost))
                        await db.add_voice_xp(guild.id, member.id, earned)
                        activitylog.record(
                            "xp_voice", guild.id, member.id,
                            channel_id=channel.id, amount=earned,
                            exile=EXILE_MULTIPLIER if exile else None,
                            mute=(member.voice.self_mute or member.voice.mute) or None,
                            stream=member.voice.self_stream or None,
                            video=member.voice.self_video or None,
                            boost=boost if boost != 1.0 else None,
                            boost_src=boost_src,
                            peers=[m.id for m in valid if m.id != member.id],
                            bots=[m.id for m in channel.members if m.bot] or None,
                        )
                        await self._sync_role(member)
                    except Exception:
                        log.exception("Ses XP'si verilemedi (guild=%s, üye=%s)", guild.id, member.id)
                    await asyncio.sleep(0)  # Rate limit dostu

    @voice_xp_loop.before_loop
    async def _before_voice_loop(self) -> None:
        await self.bot.wait_until_ready()

    @tasks.loop(hours=24)
    async def daily_backup_loop(self) -> None:
        backup_path = await db.backup_db()
        if backup_path:
            log.info("Günlük otomatik yedek alındı: %s", backup_path)

    @daily_backup_loop.before_loop
    async def _before_backup_loop(self) -> None:
        await self.bot.wait_until_ready()

    # ==================================================================
    # KOMUTLAR
    # ==================================================================

    async def cog_command_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        """Bu cog'daki komutlar için ortak kullanıcı hatası mesajları (loglama audit.py'de)."""
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        elif isinstance(error, commands.NoPrivateMessage):
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
        elif isinstance(error, (commands.BadArgument, commands.MissingRequiredArgument)) and ctx.command:
            usage = ctx.command.usage or ctx.command.signature
            await ctx.send(f"❌ Kullanım: `{ctx.prefix}{ctx.invoked_with} {usage}`")

    # ------------------------------------------------------------------
    # !xp
    # ------------------------------------------------------------------

    @commands.command(name="xp")
    async def xp_command(self, ctx: commands.Context) -> None:
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        row = await db.get_user_row(ctx.guild.id, ctx.author.id)
        if row is None:
            await ctx.send("Kullanıcı verisi bulunamadı.")
            return

        live_seconds = self.get_live_voice_seconds(
            ctx.guild.id, ctx.author.id,
            int(row["voice_seconds"]),
            row["active_voice_started_at"],
        )

        boost, boost_expires = db.active_boost(row)
        boost_str = ""
        if boost_expires is not None:
            remaining = max(0, int(boost_expires - time.time()))
            boost_str = f"\n⚡ Aktif boost: **{boost:g}x** — {format_duration(remaining)} kaldı"

        exile = await self.get_exile(ctx.guild.id, ctx.author.id)
        streak = exile["streak_at_start"] if exile else db.current_streak(row)
        s_mult = streak_multiplier(streak)
        if exile:
            ends = "kalıcı" if exile["ends_at"] is None else f"<t:{int(exile['ends_at'])}:R> bitiyor"
            boost_str = (
                f"⛓️ **Sürgündesin** ({ends}): tüm XP **{EXILE_MULTIPLIER:g}x**, "
                f"boost ve seri çarpanı işlemiyor.\n📝 Sebep: {exile['reason']}"
            )
        total_xp = int(row["total_xp"])
        current_role = self.get_display_role(ctx.author, total_xp)
        next_role_name, next_role_xp = self.role_manager.get_next_role_info(ctx.author, total_xp)

        if next_role_xp is None:
            next_role_value = "Maksimum role ulaştın."
        else:
            remaining = max(0, next_role_xp - total_xp)
            label = next_role_name or f"{next_role_xp:,} XP rolü"
            next_role_value = f"{label} için **{remaining:,} XP** kaldı"

        embed = discord.Embed(title="📊 XP Durumun", color=discord.Color.blurple())
        embed.add_field(name="Mesaj XP", value=f"{int(row['text_xp']):,}", inline=True)
        embed.add_field(name="Ses XP", value=f"{int(row['voice_xp']):,}", inline=True)
        embed.add_field(name="Toplam XP", value=f"{total_xp:,}", inline=False)
        embed.add_field(name="Mevcut Rol", value=current_role, inline=True)
        embed.add_field(name="Sonraki Rol", value=next_role_value, inline=False)
        embed.add_field(name="Toplam Mesaj", value=f"{int(row['message_count']):,}", inline=True)
        embed.add_field(name="Ses Süresi", value=format_duration(live_seconds), inline=True)
        embed.add_field(
            name="🔥 Seri",
            value=f"{streak} gün (donduruldu, sürgün bitince x{s_mult:.2f} ile devam)" if exile
            else f"{streak} gün (x{s_mult:.2f} çarpan)",
            inline=False,
        )
        if boost_str:
            embed.description = boost_str
        await ctx.send(embed=embed)

    # ------------------------------------------------------------------
    # !ses
    # ------------------------------------------------------------------

    @commands.command(name="ses")
    async def ses_command(self, ctx: commands.Context) -> None:
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        row = await db.get_user_row(ctx.guild.id, ctx.author.id)
        if row is None:
            await ctx.send("Kullanıcı verisi bulunamadı.")
            return

        live = self.get_live_voice_seconds(
            ctx.guild.id, ctx.author.id,
            int(row["voice_seconds"]),
            row["active_voice_started_at"],
        )
        await ctx.send(f"🔊 Bu sunucudaki toplam ses süren: **{format_duration(live)}**")

    # ------------------------------------------------------------------
    # !topxp
    # ------------------------------------------------------------------

    @commands.command(name="topxp")
    async def topxp_command(self, ctx: commands.Context) -> None:
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        rows = await db.get_leaderboard(ctx.guild.id)
        if not rows:
            await ctx.send("Henüz XP verisi yok.")
            return

        lines: list[str] = []
        for i, row in enumerate(rows, 1):
            member = ctx.guild.get_member(row["user_id"])
            name = member.display_name if member else f"Kullanıcı {row['user_id']}"
            lines.append(f"**{i}.** {name} — {int(row['total_xp']):,} XP")

        embed = discord.Embed(
            title="🏆 XP Sıralaması",
            description="\n".join(lines),
            color=discord.Color.gold(),
        )
        await ctx.send(embed=embed)

    # ------------------------------------------------------------------
    # !streak
    # ------------------------------------------------------------------

    @commands.command(name="streak")
    async def streak_command(self, ctx: commands.Context) -> None:
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        row = await db.get_user_row(ctx.guild.id, ctx.author.id)
        exile = await self.get_exile(ctx.guild.id, ctx.author.id)
        if exile:
            streak = exile["streak_at_start"]
            await ctx.send(
                f"⛓️ **{ctx.author.display_name}**, sürgündesin; serin **{streak} günde** donduruldu.\n"
                f"Sürgün bitince **x{streak_multiplier(streak):.2f}** çarpanla kaldığın yerden devam eder."
            )
            return
        streak = db.current_streak(row) if row else 0
        mult = streak_multiplier(streak)

        next_milestone = next(
            (d for d in sorted(STREAK_MILESTONES) if d > streak), None
        )
        milestone_str = (
            f"\nSonraki ödül: **{next_milestone}. gün** (+{STREAK_MILESTONES[next_milestone]} XP)"
            if next_milestone else "\n🎉 Tüm streak ödüllerini aldın!"
        )

        await ctx.send(
            f"🔥 **{ctx.author.display_name}** — **{streak} günlük seri!**\n"
            f"XP çarpanın: **x{mult:.2f}**{milestone_str}"
        )

    # ------------------------------------------------------------------
    # !feature
    # ------------------------------------------------------------------

    @commands.command(name="feature")
    async def feature_command(self, ctx: commands.Context, *, request: str | None = None) -> None:
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        if request is None or not request.strip():
            await ctx.send("❌ Kullanım: `!feature <istek>`")
            return

        entry = self._build_feature_entry(ctx.message, request)
        async with self._feature_lock:
            await asyncio.to_thread(self._append_feature_entry, entry)

        await ctx.send("✅ Feature isteğin kaydedildi.")

    # ------------------------------------------------------------------
    # !xpsenkronize (admin)
    # ------------------------------------------------------------------

    @commands.command(name="xpsenkronize")
    @commands.has_permissions(administrator=True)
    async def xpsenkronize_command(self, ctx: commands.Context) -> None:
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        count = 0
        for member in ctx.guild.members:
            if member.bot:
                continue
            await db.ensure_user(ctx.guild.id, member.id)
            await self._sync_role(member)
            await asyncio.sleep(0)
            count += 1

        self._audit_admin(ctx, "admin_sync", checked=count)
        await ctx.send(f"✅ XP rol kontrolü tamamlandı. Kontrol edilen üye: **{count}**")

    # ------------------------------------------------------------------
    # !xpayarla (admin) — kullanıcının XP'sini doğrudan ayarla
    # ------------------------------------------------------------------

    @commands.command(name="xpayarla", usage="@kullanıcı <miktar> <sebep>")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def xpayarla_command(
        self,
        ctx: commands.Context,
        member: discord.Member,
        total_xp: int,
        *,
        reason: str | None = None,
    ) -> None:
        """Kullanıcının toplam XP'sini ayarlar. Mesaj/ses XP oranı korunur."""
        reason = await self._require_reason(ctx, reason, "!xpayarla @kullanıcı <miktar> <sebep>")
        if reason is None:
            return

        if total_xp < 0:
            await ctx.send("❌ XP 0'dan küçük olamaz.")
            return

        before, total_xp = await db.set_total_xp(ctx.guild.id, member.id, total=total_xp)
        self._audit_admin(
            ctx, "admin_xp_set", member,
            amount=total_xp - before, before=before, after=total_xp, sebep=reason,
        )
        await self._sync_role(member)
        await ctx.send(
            f"✅ **{member.display_name}** kullanıcısının XP'si **{before:,}** → **{total_xp:,}** olarak ayarlandı.\n"
            f"📝 Sebep: {reason}"
        )

    # ------------------------------------------------------------------
    # !xpekle (admin) — mevcut XP'ye ekle
    # ------------------------------------------------------------------

    @commands.command(name="xpekle", usage="@kullanıcı <miktar> <sebep>")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def xpekle_command(
        self,
        ctx: commands.Context,
        member: discord.Member,
        amount: int,
        *,
        reason: str | None = None,
    ) -> None:
        """Kullanıcıya XP ekler (negatif değer XP çıkarır). Mesaj/ses XP oranı korunur."""
        reason = await self._require_reason(ctx, reason, "!xpekle @kullanıcı <miktar> <sebep>")
        if reason is None:
            return

        current, new_total = await db.set_total_xp(ctx.guild.id, member.id, delta=amount)
        self._audit_admin(
            ctx, "admin_xp_add", member,
            amount=new_total - current, before=current, after=new_total, sebep=reason,
        )
        await self._sync_role(member)

        verb = "eklendi" if amount >= 0 else "çıkarıldı"
        await ctx.send(
            f"✅ **{member.display_name}** kullanıcısına **{abs(amount):,} XP** {verb}. "
            f"Yeni toplam: **{new_total:,} XP**\n"
            f"📝 Sebep: {reason}"
        )

    # ------------------------------------------------------------------
    # !xpcikar (admin) — mevcut XP'den çıkar
    # ------------------------------------------------------------------

    @commands.command(
        name="xpcikar",
        aliases=["xpçıkar", "xpcıkar", "xpsil"],
        usage="@kullanıcı <miktar> <sebep>",
    )
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def xpcikar_command(
        self,
        ctx: commands.Context,
        member: discord.Member,
        amount: int,
        *,
        reason: str | None = None,
    ) -> None:
        """Kullanıcıdan XP çıkarır (0'ın altına düşmez). Mesaj/ses XP oranı korunur."""
        reason = await self._require_reason(ctx, reason, "!xpçıkar @kullanıcı <miktar> <sebep>")
        if reason is None:
            return

        if amount <= 0:
            await ctx.send("❌ Çıkarılacak miktar 0'dan büyük olmalı.")
            return

        current, new_total = await db.set_total_xp(ctx.guild.id, member.id, delta=-amount)
        removed = current - new_total
        self._audit_admin(
            ctx, "admin_xp_remove", member,
            amount=-removed, before=current, after=new_total, sebep=reason,
        )
        await self._sync_role(member)

        note = f" (sadece {removed:,} XP'si vardı)" if removed < amount else ""
        await ctx.send(
            f"✅ **{member.display_name}** kullanıcısından **{removed:,} XP** çıkarıldı{note}. "
            f"Yeni toplam: **{new_total:,} XP**\n"
            f"📝 Sebep: {reason}"
        )

    # ------------------------------------------------------------------
    # !boost (admin) — XP boost ver
    # ------------------------------------------------------------------

    @commands.command(name="boost", usage="@kullanıcı <çarpan> [saat] <sebep>")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def boost_command(
        self,
        ctx: commands.Context,
        member: discord.Member,
        multiplier: float,
        hours: float | None = None,
        *,
        reason: str | None = None,
    ) -> None:
        """
        Kullanıcıya XP boost uygular. Saat verilmezse 1 saattir.
        Örnek: !boost @kullanıcı 2.0 24 etkinlik ödülü  → 24 saat boyunca 2x XP
        """
        reason = await self._require_reason(ctx, reason, "!boost @kullanıcı <çarpan> [saat] <sebep>")
        if reason is None:
            return

        if hours is None:
            hours = 1.0

        # isfinite: "nan"/"inf" float'a çevrilebildiği için ayrıca kontrol edilir
        if not math.isfinite(multiplier) or not (BOOST_MIN <= multiplier <= BOOST_MAX):
            await ctx.send(f"❌ Çarpan {BOOST_MIN:g} ile {BOOST_MAX:g} arasında olmalı.")
            return

        if not math.isfinite(hours) or hours <= 0 or hours > BOOST_MAX_HOURS:
            await ctx.send(f"❌ Süre 0-{BOOST_MAX_HOURS} saat arasında olmalı.")
            return

        duration = int(hours * 3600)
        await db.set_boost(ctx.guild.id, member.id, multiplier, duration)
        self._audit_admin(ctx, "admin_boost", member, multiplier=multiplier, hours=hours, sebep=reason)

        h = int(hours)
        m = int((hours - h) * 60)
        await ctx.send(
            f"⚡ **{member.display_name}** kullanıcısına **{multiplier}x XP boost** uygulandı! "
            f"Süre: **{h}sa {m}dk**\n"
            f"📝 Sebep: {reason}"
        )

    # ------------------------------------------------------------------
    # !yedekle (admin) — Veritabanı yedeği al
    # ------------------------------------------------------------------

    @commands.command(name="yedekle", aliases=["backup"])
    @commands.has_permissions(administrator=True)
    async def backup_command(self, ctx: commands.Context) -> None:
        """Veritabanının anlık yedeğini alır (admin)."""
        backup_path = await db.backup_db()
        self._audit_admin(ctx, "admin_backup", path=backup_path)
        if backup_path:
            await ctx.send(f"✅ Veritabanı yedeği başarıyla oluşturuldu:\n`{backup_path}`")
        else:
            await ctx.send("❌ Yedek alınırken bir hata oluştu.")

