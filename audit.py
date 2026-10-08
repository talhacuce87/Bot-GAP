"""
audit.py — Denetim (audit) cog'u.

- Her mesajın metadatasını, ses giriş/çıkış/mute/yayın değişikliklerini,
  üye giriş/çıkışlarını, komutları ve komut hatalarını activity_log'a yazar.
- Canlı şüphe dedektörü: makro/self-bot zamanlaması, kopyala-yapıştır spam,
  XP cooldown'ına yapışık mesajlaşma, mikrofonu kapalı ses kasma ve
  yeni açılmış hesapla ses kasma.
- Şüpheli hareketleri ve admin işlemlerini LOG_CHANNEL_ID kanalına bildirir.
- Admin analiz komutları: !analiz, !supheli, !eskianaliz, !olaylar, !adminlog
"""

from __future__ import annotations

import datetime as dt
import io
import logging
import os
import statistics
import time
from collections import Counter, defaultdict, deque

import discord
from discord.ext import commands, tasks

import activitylog
import analysis
import database as db

log = logging.getLogger("gap.audit")

LOG_CHANNEL_ID = int(os.getenv("LOG_CHANNEL_ID", "0") or 0)

MESSAGE_COOLDOWN_SECONDS = analysis.MESSAGE_COOLDOWN_SECONDS
DETECT_WINDOW = 10
FLAG_COOLDOWN_SECONDS = 3600
VOICE_WATCH_MINUTES = 5
MUTED_FARM_TICKS = 6            # 6 × 5dk = 30dk boyunca herkes mute ise
NEW_ACCOUNT_DAYS = 14

_USER_ERRORS = (
    commands.CommandNotFound,
    commands.MissingPermissions,
    commands.MissingRequiredArgument,
    commands.BadArgument,
    commands.CheckFailure,
    commands.CommandOnCooldown,
    commands.UserInputError,
)


def _fmt_ts(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, analysis.TR_TZ).strftime("%d.%m %H:%M:%S")


def _account_age_days(user: discord.abc.User) -> float:
    return (discord.utils.utcnow() - user.created_at).total_seconds() / 86400


class AuditCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self._recent: dict[tuple[int, int], deque[tuple[float, str | None]]] = defaultdict(
            lambda: deque(maxlen=DETECT_WINDOW)
        )
        self._last_flag: dict[tuple[int, int, str], float] = {}
        self._voice_joined: dict[tuple[int, int], float] = {}
        self._muted_ticks: Counter = Counter()

    async def cog_load(self) -> None:
        activitylog.start()
        self.voice_watch_loop.start()
        self.maintenance_loop.start()

    async def cog_unload(self) -> None:
        self.voice_watch_loop.cancel()
        self.maintenance_loop.cancel()
        await activitylog.stop()

    # ------------------------------------------------------------------
    # Bildirim
    # ------------------------------------------------------------------

    async def _alert(
        self,
        guild: discord.Guild | None,
        title: str,
        description: str,
        color: discord.Color = discord.Color.orange(),
    ) -> None:
        if not LOG_CHANNEL_ID:
            return
        channel = self.bot.get_channel(LOG_CHANNEL_ID)
        if not isinstance(channel, discord.abc.Messageable):
            return
        if guild is not None and getattr(channel, "guild", None) not in (None, guild):
            return
        embed = discord.Embed(title=title, description=description[:4000], color=color)
        embed.timestamp = discord.utils.utcnow()
        try:
            await channel.send(embed=embed)
        except discord.HTTPException as err:
            log.warning("Log kanalına yazılamadı: %s", err)

    @commands.Cog.listener()
    async def on_gap_alert(self, guild: discord.Guild | None, title: str, description: str) -> None:
        """Diğer cog'lar self.bot.dispatch('gap_alert', guild, başlık, açıklama) ile bildirim gönderir."""
        await self._alert(guild, title, description, discord.Color.blurple())

    async def _flag(
        self,
        guild: discord.Guild,
        user: discord.abc.User,
        rule: str,
        detail: str,
        *,
        channel_id: int | None = None,
        cooldown: int = FLAG_COOLDOWN_SECONDS,
        **meta,
    ) -> None:
        key = (guild.id, user.id, rule)
        now = time.time()
        if now - self._last_flag.get(key, 0) < cooldown:
            return
        self._last_flag[key] = now

        activitylog.record(
            "suspicious", guild.id, user.id, channel_id=channel_id, rule=rule, detail=detail, **meta
        )
        log.warning("ŞÜPHELİ [%s] %s (%s) guild=%s: %s", rule, user, user.id, guild.id, detail)
        await self._alert(
            guild,
            f"⚠️ Şüpheli hareket: {rule}",
            f"**Üye:** {user.mention} (`{user.id}`)\n"
            + (f"**Kanal:** <#{channel_id}>\n" if channel_id else "")
            + f"**Detay:** {detail}\n\n`!analiz {user.id}` ile geçmişini incele.",
        )

    # ------------------------------------------------------------------
    # Mesajlar
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or message.guild is None:
            return

        ctx = await self.bot.get_context(message)
        is_cmd = ctx.valid
        h = activitylog.content_hash(message.content)
        activitylog.record(
            "message",
            message.guild.id,
            message.author.id,
            channel_id=message.channel.id,
            len=len(message.content),
            h=h,
            att=len(message.attachments) or None,
            stk=len(message.stickers) or None,
            reply=bool(message.reference) or None,
            cmd=is_cmd or None,
        )
        if is_cmd:
            return
        await self._detect_message(message, h)

    async def _detect_message(self, message: discord.Message, h: str | None) -> None:
        key = (message.guild.id, message.author.id)
        window = self._recent[key]
        window.append((time.time(), h))
        if len(window) < DETECT_WINDOW:
            return

        hashes = [x[1] for x in window if x[1]]
        if hashes:
            top_hash, count = Counter(hashes).most_common(1)[0]
            if count >= 5:
                await self._flag(
                    message.guild, message.author, "tekrar_mesaj",
                    f"son {DETECT_WINDOW} mesajın {count} tanesi aynı içerik",
                    channel_id=message.channel.id,
                )

        stamps = [x[0] for x in window]
        gaps = [b - a for a, b in zip(stamps, stamps[1:])]
        mean = statistics.fmean(gaps)
        if 5 <= mean <= 600:
            cv = statistics.pstdev(gaps) / mean
            if cv < 0.08:
                await self._flag(
                    message.guild, message.author, "makro_zamanlama",
                    f"son {len(gaps)} mesaj aralığı neredeyse sabit (ort. {mean:.1f}sn, CV {cv:.3f}) — makro/self-bot olabilir",
                    channel_id=message.channel.id,
                )
        hug = sum(1 for g in gaps if MESSAGE_COOLDOWN_SECONDS <= g <= MESSAGE_COOLDOWN_SECONDS + 4)
        if hug >= len(gaps) - 1:
            await self._flag(
                message.guild, message.author, "cooldown_kasma",
                f"son {len(gaps)} mesajın {hug} tanesi tam XP cooldown'ı ({MESSAGE_COOLDOWN_SECONDS}sn) dolunca atılmış",
                channel_id=message.channel.id,
            )

    @commands.Cog.listener()
    async def on_message_delete(self, message: discord.Message) -> None:
        if message.author.bot or message.guild is None:
            return
        age = (discord.utils.utcnow() - message.created_at).total_seconds()
        activitylog.record(
            "message_delete",
            message.guild.id,
            message.author.id,
            channel_id=message.channel.id,
            age=round(age),
            len=len(message.content),
            h=activitylog.content_hash(message.content),
        )

    @commands.Cog.listener()
    async def on_message_edit(self, before: discord.Message, after: discord.Message) -> None:
        if after.author.bot or after.guild is None or before.content == after.content:
            return
        activitylog.record(
            "message_edit",
            after.guild.id,
            after.author.id,
            channel_id=after.channel.id,
            len_before=len(before.content),
            len_after=len(after.content),
        )

    # ------------------------------------------------------------------
    # Ses
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_voice_state_update(
        self,
        member: discord.Member,
        before: discord.VoiceState,
        after: discord.VoiceState,
    ) -> None:
        if member.bot:
            return
        gid, uid = member.guild.id, member.id
        afk_id = member.guild.afk_channel.id if member.guild.afk_channel else None
        key = (gid, uid)

        if before.channel is None and after.channel is not None:
            self._voice_joined[key] = time.time()
            activitylog.record(
                "voice_join", gid, uid, channel_id=after.channel.id,
                mute=after.self_mute or after.mute or None,
                deaf=after.self_deaf or after.deaf or None,
                afk=(after.channel.id == afk_id) or None,
            )
        elif before.channel is not None and after.channel is None:
            joined = self._voice_joined.pop(key, None)
            activitylog.record(
                "voice_leave", gid, uid, channel_id=before.channel.id,
                seconds=round(time.time() - joined) if joined else None,
            )
        elif before.channel and after.channel and before.channel.id != after.channel.id:
            activitylog.record(
                "voice_move", gid, uid, channel_id=after.channel.id,
                from_ch=before.channel.id, afk=(after.channel.id == afk_id) or None,
            )

        changes = {
            attr: getattr(after, attr)
            for attr in ("self_mute", "self_deaf", "mute", "deaf", "self_stream", "self_video")
            if getattr(before, attr) != getattr(after, attr)
        }
        if changes and before.channel is not None and after.channel is not None:
            activitylog.record(
                "voice_state", gid, uid, channel_id=after.channel.id, **changes
            )

    @staticmethod
    def _voice_valid(member: discord.Member) -> bool:
        vs = member.voice
        return (
            not member.bot
            and vs is not None
            and vs.channel is not None
            and not (vs.self_deaf or vs.deaf)
        )

    @tasks.loop(minutes=VOICE_WATCH_MINUTES)
    async def voice_watch_loop(self) -> None:
        seen: set = set()
        for guild in self.bot.guilds:
            afk_id = guild.afk_channel.id if guild.afk_channel else None
            for channel in guild.voice_channels:
                if channel.id == afk_id:
                    continue
                valid = [m for m in channel.members if self._voice_valid(m)]
                if len(valid) < 2:
                    continue

                # 1) Herkes mikrofonu kapalı → ses XP'si sessizce kasılıyor olabilir
                if all(m.voice.self_mute or m.voice.mute for m in valid):
                    key = (guild.id, channel.id, frozenset(m.id for m in valid))
                    seen.add(key)
                    self._muted_ticks[key] += 1
                    if self._muted_ticks[key] >= MUTED_FARM_TICKS:
                        minutes = self._muted_ticks[key] * VOICE_WATCH_MINUTES
                        names = ", ".join(f"{m} ({m.id})" for m in valid)
                        for m in valid:
                            await self._flag(
                                guild, m, "sessiz_ses_kasma",
                                f"{channel.name} kanalında {minutes}+ dk boyunca herkes mikrofonu kapalı: {names}",
                                channel_id=channel.id, cooldown=6 * 3600,
                            )

                # 2) Yeni açılmış hesapla birlikte ses → alt hesap şüphesi
                for m in valid:
                    age = _account_age_days(m)
                    if age < NEW_ACCOUNT_DAYS:
                        peers = ", ".join(f"{p} ({p.id})" for p in valid if p.id != m.id)
                        await self._flag(
                            guild, m, "yeni_hesap_ses",
                            f"{age:.0f} günlük hesap {channel.name} kanalında ses XP'si alıyor; yanında: {peers}",
                            channel_id=channel.id, cooldown=24 * 3600,
                        )

        for key in list(self._muted_ticks):
            if key not in seen:
                del self._muted_ticks[key]

    @voice_watch_loop.before_loop
    async def _before_voice_watch(self) -> None:
        await self.bot.wait_until_ready()

    @tasks.loop(hours=24)
    async def maintenance_loop(self) -> None:
        await activitylog.flush()
        await activitylog.prune_old_events()
        cutoff = time.time() - FLAG_COOLDOWN_SECONDS * 24
        self._last_flag = {k: v for k, v in self._last_flag.items() if v > cutoff}
        stale = time.time() - 600
        for key in [k for k, w in self._recent.items() if not w or w[-1][0] < stale]:
            del self._recent[key]

    @maintenance_loop.before_loop
    async def _before_maintenance(self) -> None:
        await self.bot.wait_until_ready()

    # ------------------------------------------------------------------
    # Üyeler & bağlantı
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_ready(self) -> None:
        log.info("Bot hazır: %s | %d sunucu", self.bot.user, len(self.bot.guilds))
        for guild in self.bot.guilds:
            for vc in guild.voice_channels:
                for m in vc.members:
                    if not m.bot:
                        self._voice_joined.setdefault((guild.id, m.id), time.time())

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member) -> None:
        age = _account_age_days(member)
        activitylog.record(
            "member_join", member.guild.id, member.id,
            account_age_days=round(age, 1),
            created_at=member.created_at.isoformat(),
            name=str(member),
        )
        log.info("Üye katıldı: %s (%s) hesap yaşı %.1f gün", member, member.id, age)
        if age < NEW_ACCOUNT_DAYS:
            await self._alert(
                member.guild,
                "🆕 Yeni hesap katıldı",
                f"{member.mention} (`{member.id}`) — hesap **{age:.1f} gün** önce açılmış.",
                discord.Color.yellow(),
            )

    @commands.Cog.listener()
    async def on_member_remove(self, member: discord.Member) -> None:
        stay = None
        if member.joined_at:
            stay = round((discord.utils.utcnow() - member.joined_at).total_seconds() / 86400, 1)
        activitylog.record("member_leave", member.guild.id, member.id, stay_days=stay, name=str(member))
        log.info("Üye ayrıldı: %s (%s)", member, member.id)

    @commands.Cog.listener()
    async def on_member_update(self, before: discord.Member, after: discord.Member) -> None:
        if before.nick != after.nick:
            activitylog.record("nick_change", after.guild.id, after.id, old=before.nick, new=after.nick)

    # ------------------------------------------------------------------
    # Komutlar & hatalar
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_command(self, ctx: commands.Context) -> None:
        activitylog.record(
            "command",
            ctx.guild.id if ctx.guild else None,
            ctx.author.id,
            channel_id=ctx.channel.id,
            name=ctx.command.qualified_name if ctx.command else None,
            text=ctx.message.content[:200],
        )

    @commands.Cog.listener()
    async def on_command_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        original = getattr(error, "original", error)
        name = ctx.command.qualified_name if ctx.command else ctx.invoked_with
        activitylog.record(
            "command_error",
            ctx.guild.id if ctx.guild else None,
            ctx.author.id,
            channel_id=ctx.channel.id,
            name=name,
            error=type(original).__name__,
            msg=str(original)[:300],
        )

        if isinstance(error, commands.MissingPermissions):
            log.warning("Yetkisiz admin komutu denemesi: %s (%s) → !%s", ctx.author, ctx.author.id, name)
            if ctx.guild:
                activitylog.record("admin_denied", ctx.guild.id, ctx.author.id, channel_id=ctx.channel.id, name=name)
                await self._alert(
                    ctx.guild,
                    "🚫 Yetkisiz admin komutu denemesi",
                    f"{ctx.author.mention} (`{ctx.author.id}`) → `{ctx.message.content[:200]}`",
                    discord.Color.red(),
                )
        elif isinstance(error, _USER_ERRORS):
            log.info("Komut hatası (%s) %s: %s", type(error).__name__, ctx.author, ctx.message.content[:100])
        else:
            log.error(
                "Komut çöktü: !%s (%s)", name, ctx.message.content[:200],
                exc_info=(type(original), original, original.__traceback__),
            )

    # ------------------------------------------------------------------
    # Admin analiz komutları
    # ------------------------------------------------------------------

    @staticmethod
    async def _send_text(ctx: commands.Context, title: str, text: str) -> None:
        if len(text) <= 1800:
            await ctx.send(f"**{title}**\n```\n{text}\n```")
        else:
            data = io.BytesIO(text.encode("utf-8"))
            await ctx.send(f"**{title}** (uzun rapor, dosya olarak)", file=discord.File(data, "rapor.txt"))

    def _name(self, guild: discord.Guild, user_id: int) -> str:
        m = guild.get_member(user_id)
        return f"{m} ({user_id})" if m else f"ayrılmış ({user_id})"

    async def cog_command_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        elif isinstance(error, (commands.BadArgument, commands.MissingRequiredArgument)):
            await ctx.send(f"❌ Hatalı kullanım. Örnek: `!{ctx.command.qualified_name} {ctx.command.signature}`")

    @commands.command(name="analiz")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def analiz_command(self, ctx: commands.Context, member: discord.User, days: float = 30) -> None:
        """Bir üyenin son N gündeki aktivitesini hile/kasma açısından analiz eder."""
        await activitylog.flush()
        since = time.time() - days * 86400
        rows = await db.get_user_events(ctx.guild.id, member.id, since, analysis.ANALYSIS_EVENTS)

        voice_peers = analysis.analyze_user(member.id, rows, days).top_peers
        peer_msgs: dict[int, int] = {}
        for pid, _ in voice_peers:
            peer_msgs[pid] = len(await db.get_user_events(ctx.guild.id, pid, since, ("message",)))

        rep = analysis.analyze_user(member.id, rows, days, peer_msgs)
        text = analysis.format_report(rep, str(member))

        extra = [f"  Hesap yaşı: {_account_age_days(member):.0f} gün"]
        gm = ctx.guild.get_member(member.id)
        if gm and gm.joined_at:
            extra.append(f"  Sunucuda: {(discord.utils.utcnow() - gm.joined_at).days} gün")
        for pid, ticks in voice_peers:
            peer = self.bot.get_user(pid)
            age = f"{_account_age_days(peer):.0f}g hesap" if peer else "?"
            extra.append(
                f"  ↳ ses partneri {self._name(ctx.guild, pid)}: {ticks} tick, "
                f"{peer_msgs.get(pid, 0)} mesaj, {age}"
            )
        await self._send_text(ctx, f"🔎 Analiz — {member}", text + "\n" + "\n".join(extra))

    @commands.command(name="supheli", aliases=["şüpheli"])
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def supheli_command(self, ctx: commands.Context, days: float = 7) -> None:
        """Sunucudaki tüm üyeleri tarar, şüphe skoruna göre sıralar."""
        await activitylog.flush()
        rows = await db.get_guild_events(ctx.guild.id, time.time() - days * 86400, analysis.ANALYSIS_EVENTS)
        reports = [r for r in analysis.analyze_guild(rows, days) if r.flags][:15]
        if not reports:
            await ctx.send(f"✅ Son {days:g} günde şüpheli hareket bulunamadı.")
            return
        lines = []
        for rep in reports:
            lines.append(f"[{rep.score:>2}] {self._name(ctx.guild, rep.user_id)} — {rep.total_xp:,} XP")
            for f in rep.flags:
                lines.append(f"     • {f.code}: {f.detail}")
        await self._send_text(ctx, f"🕵️ Şüpheli listesi — son {days:g} gün", "\n".join(lines))

    @commands.command(name="eskianaliz")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def eskianaliz_command(self, ctx: commands.Context) -> None:
        """Olay kaydı başlamadan önceki toplam verilerden (XP, ses süresi, ses çiftleri) tarama yapar."""
        users = await db.get_all_user_rows(ctx.guild.id)
        pairs = await db.get_all_pairs(ctx.guild.id)
        results = analysis.legacy_scan(users, pairs)[:20]
        if not results:
            await ctx.send("✅ Toplam verilerde belirgin anormallik bulunamadı.")
            return
        lines = []
        for uid, flags in results:
            lines.append(f"[{sum(f.weight for f in flags):>2}] {self._name(ctx.guild, uid)}")
            for f in flags:
                detail = f.detail
                for pid in [int(x) for x in detail.split() if x.isdigit() and len(x) >= 15]:
                    detail = detail.replace(str(pid), self._name(ctx.guild, pid))
                lines.append(f"     • {f.code}: {detail}")
        await self._send_text(ctx, "📜 Geçmiş veri taraması (tüm zamanlar)", "\n".join(lines))

    @commands.command(name="olaylar")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def olaylar_command(self, ctx: commands.Context, member: discord.User, limit: int = 30) -> None:
        """Bir üyenin son olaylarını kronolojik listeler."""
        await activitylog.flush()
        limit = max(1, min(limit, 500))
        rows = await db.get_user_events(ctx.guild.id, member.id, 0, limit=limit, newest_first=True)
        if not rows:
            await ctx.send("Bu üye için kayıtlı olay yok.")
            return
        lines = []
        for r in reversed(rows):
            amount = f" {r['amount']:+d}" if r["amount"] is not None else ""
            ch = f" #{r['channel_id']}" if r["channel_id"] else ""
            meta = f" {r['meta']}" if r["meta"] else ""
            lines.append(f"{_fmt_ts(r['ts'])} {r['event']}{amount}{ch}{meta}")
        await self._send_text(ctx, f"📋 {member} — son {len(rows)} olay", "\n".join(lines))

    @commands.command(name="adminlog")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def adminlog_command(self, ctx: commands.Context, days: float = 30) -> None:
        """Admin XP/boost işlemlerinin ve yetkisiz denemelerin geçmişi."""
        await activitylog.flush()
        rows = await db.get_admin_events(ctx.guild.id, time.time() - days * 86400, limit=100)
        if not rows:
            await ctx.send(f"Son {days:g} günde admin işlemi yok.")
            return
        lines = []
        for r in rows:
            actor = self._name(ctx.guild, r["actor_id"]) if r["actor_id"] else self._name(ctx.guild, r["user_id"])
            target = self._name(ctx.guild, r["user_id"]) if r["actor_id"] else "-"
            amount = f" {r['amount']:+,}" if r["amount"] is not None else ""
            lines.append(f"{_fmt_ts(r['ts'])} {r['event']}{amount} | yapan: {actor} → hedef: {target} {r['meta'] or ''}")
        await self._send_text(ctx, f"🛡️ Admin işlemleri — son {days:g} gün", "\n".join(lines))
