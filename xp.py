"""
xp.py — XP sistemi: mesaj/ses XP, streak, boost, admin komutları.

Tüm DB işlemleri database.py üzerinden geçer; bu cog sadece
Discord event'lerini ve komutları yönetir.
"""

from __future__ import annotations

import asyncio
import random
import time
from pathlib import Path
from typing import TYPE_CHECKING

import discord
from discord.ext import commands, tasks

import database as db
from xproles import XPRoleManager

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------------------
# Sabitler
# ---------------------------------------------------------------------------

MESSAGE_XP_MIN = 3
MESSAGE_XP_MAX = 8
MESSAGE_COOLDOWN_SECONDS = 20

VOICE_XP_INTERVAL_MINUTES = 2
VOICE_XP_PER_INTERVAL = 1

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

FEATURE_REQUESTS_PATH = Path(__file__).resolve().parent / "data" / "features.txt"


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
        return (
            f"[{timestamp}] "
            f"guild={message.guild.id} channel=#{channel} "
            f"user={author} ({message.author.id}) :: {request.strip()}\n"
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
            print(f"[DB] Başlangıç veritabanı yedeği alındı: {backup_path}")
        print(f"[XP] Bot aktif: {self.bot.user}")

    async def _restore_voice_sessions(self) -> None:
        for guild in self.bot.guilds:
            afk_id = guild.afk_channel.id if guild.afk_channel else None
            for member in guild.members:
                if member.bot:
                    continue
                if (
                    member.voice
                    and member.voice.channel
                    and (afk_id is None or member.voice.channel.id != afk_id)
                ):
                    await db.start_voice_session(guild.id, member.id)
                else:
                    await db.end_voice_session(guild.id, member.id)

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

        # Günlük seri, normal mesaj ve komut mesajlarında da ilerler.
        streak, is_first_today = await db.update_streak(guild_id, user_id)

        # Streak milestone bildirimi
        if is_first_today and streak in STREAK_MILESTONES:
            bonus = STREAK_MILESTONES[streak]
            await db.add_text_xp(guild_id, user_id, bonus)
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

            # Boost çarpanı
            boost = await db.get_active_multiplier(guild_id, user_id)

            # Streak çarpanı
            s_mult = streak_multiplier(streak)

            earned = max(1, round(base_xp * boost * s_mult))

            # Seviye atlama kontrolü için önceki XP
            old_row = await db.get_user_row(guild_id, user_id)
            old_xp = int(old_row["total_xp"]) if old_row else 0
            old_level, _, _, _, _ = self.role_manager.get_progress_data(old_xp)

            await db.add_text_xp(guild_id, user_id, earned)

            if isinstance(message.author, discord.Member):
                await self._sync_role(message.author)

                new_xp = old_xp + earned
                new_level, _, _, _, _ = self.role_manager.get_progress_data(new_xp)
                if new_level > old_level:
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
            afk_id = guild.afk_channel.id if guild.afk_channel else None
            for channel in guild.voice_channels:
                if afk_id is not None and channel.id == afk_id:
                    continue
                valid = [m for m in channel.members if self._is_valid_voice_member(m)]
                if len(valid) < 2:
                    continue
                for member in valid:
                    boost = await db.get_active_multiplier(guild.id, member.id)
                    earned = max(1, round(VOICE_XP_PER_INTERVAL * boost))
                    await db.add_voice_xp(guild.id, member.id, earned)
                    await self._sync_role(member)
                    await asyncio.sleep(0)  # Rate limit dostu

    @voice_xp_loop.before_loop
    async def _before_voice_loop(self) -> None:
        await self.bot.wait_until_ready()

    @tasks.loop(hours=24)
    async def daily_backup_loop(self) -> None:
        backup_path = await db.backup_db()
        if backup_path:
            print(f"[DB] Günlük otomatik yedek alındı: {backup_path}")

    @daily_backup_loop.before_loop
    async def _before_backup_loop(self) -> None:
        await self.bot.wait_until_ready()

    # ==================================================================
    # KOMUTLAR
    # ==================================================================

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

        boost = float(row["xp_boost_multiplier"])
        boost_expires = row["xp_boost_expires_at"]
        boost_str = ""
        if boost > 1.0 and boost_expires:
            remaining = max(0, int(boost_expires - time.time()))
            h, r = divmod(remaining, 3600)
            m, s = divmod(r, 60)
            boost_str = f"\n⚡ Aktif boost: **{boost}x** — {h}sa {m}dk {s}sn kaldı"

        streak = int(row["streak_days"])
        s_mult = streak_multiplier(streak)
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
            value=f"{streak} gün (x{s_mult:.2f} çarpan)",
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
        streak = int(row["streak_days"]) if row else 0
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

        await ctx.send(f"✅ XP rol kontrolü tamamlandı. Kontrol edilen üye: **{count}**")

    @xpsenkronize_command.error
    async def _xpsenkronize_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        else:
            raise error

    # ------------------------------------------------------------------
    # !xpayarla (admin) — kullanıcının XP'sini doğrudan ayarla
    # ------------------------------------------------------------------

    @commands.command(name="xpayarla")
    @commands.has_permissions(administrator=True)
    async def xpayarla_command(
        self,
        ctx: commands.Context,
        member: discord.Member,
        total_xp: int,
    ) -> None:
        """Kullanıcının toplam XP'sini ayarlar. Ses/metin oranı yarı yarıya bölünür."""
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        if total_xp < 0:
            await ctx.send("❌ XP 0'dan küçük olamaz.")
            return

        half = total_xp // 2
        await db.set_xp(ctx.guild.id, member.id, text_xp=half, voice_xp=total_xp - half)
        await self._sync_role(member)
        await ctx.send(
            f"✅ **{member.display_name}** kullanıcısının XP'si **{total_xp:,}** olarak ayarlandı."
        )

    @xpayarla_command.error
    async def _xpayarla_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        elif isinstance(error, commands.BadArgument):
            await ctx.send("❌ Kullanım: `!xpayarla @kullanıcı <miktar>`")
        else:
            raise error

    # ------------------------------------------------------------------
    # !xpekle (admin) — mevcut XP'ye ekle
    # ------------------------------------------------------------------

    @commands.command(name="xpekle")
    @commands.has_permissions(administrator=True)
    async def xpekle_command(
        self,
        ctx: commands.Context,
        member: discord.Member,
        amount: int,
    ) -> None:
        """Kullanıcıya XP ekler (negatif değer XP çıkarır)."""
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        row = await db.get_user_row(ctx.guild.id, member.id)
        current = int(row["total_xp"]) if row else 0
        new_total = max(0, current + amount)
        half = new_total // 2
        await db.set_xp(ctx.guild.id, member.id, text_xp=half, voice_xp=new_total - half)
        await self._sync_role(member)

        verb = "eklendi" if amount >= 0 else "çıkarıldı"
        await ctx.send(
            f"✅ **{member.display_name}** kullanıcısına **{abs(amount):,} XP** {verb}. "
            f"Yeni toplam: **{new_total:,} XP**"
        )

    @xpekle_command.error
    async def _xpekle_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        elif isinstance(error, commands.BadArgument):
            await ctx.send("❌ Kullanım: `!xpekle @kullanıcı <miktar>`")
        else:
            raise error

    # ------------------------------------------------------------------
    # !boost (admin) — XP boost ver
    # ------------------------------------------------------------------

    @commands.command(name="boost")
    @commands.has_permissions(administrator=True)
    async def boost_command(
        self,
        ctx: commands.Context,
        member: discord.Member,
        multiplier: float,
        hours: float = 1.0,
    ) -> None:
        """
        Kullanıcıya XP boost uygular.
        Örnek: !boost @kullanıcı 2.0 24   → 24 saat boyunca 2x XP
        """
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        if multiplier < 1.0 or multiplier > 10.0:
            await ctx.send("❌ Çarpan 1.0 ile 10.0 arasında olmalı.")
            return

        if hours <= 0 or hours > 720:
            await ctx.send("❌ Süre 0-720 saat arasında olmalı.")
            return

        duration = int(hours * 3600)
        await db.set_boost(ctx.guild.id, member.id, multiplier, duration)

        h = int(hours)
        m = int((hours - h) * 60)
        await ctx.send(
            f"⚡ **{member.display_name}** kullanıcısına **{multiplier}x XP boost** uygulandı! "
            f"Süre: **{h}sa {m}dk**"
        )

    @boost_command.error
    async def _boost_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        elif isinstance(error, commands.BadArgument):
            await ctx.send("❌ Kullanım: `!boost @kullanıcı <çarpan> [saat]`")
        else:
            raise error
