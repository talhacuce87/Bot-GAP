"""
achievement_cog.py — Başarımlar: arka plan işleyicisi, canlı takip ve komutlar.

- Her 5 dakikada olay kaydının yeni satırları sayaçlara işlenir ve üyeler değerlendirilir.
  İlk çalıştırma geçmiş kayıtları sessizce işler (geriye dönük başarımlar duyurulmaz).
- Canlı: kapıyı açan / ışıkları kapatan (ses), sürgündeyken mesaj, yılbaşı/bayramda seste olmak.
- !başarımlar [@üye] → fular kartı · !kartdüzen → !kart'ta gösterilecek 3 rozet
- !basarimver / !basarimal (yönetici) → elle verilen başarımlar (Fikir Babası) ve düzeltmeler
- ACHIEVEMENT_CHANNEL_ID ayarlıysa yeni başarımlar orada duyurulur.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass

import discord
from discord.ext import commands, tasks

import activitylog
import database as db
from achievements import (
    ACHIEVEMENTS, BY_KEY, CATEGORIES, FRIEND_TIER_SECONDS, SOCIAL_SECONDS, TIER_NAMES, MemberFacts, aggregate, emoji,
    evaluate, find, parse_tier, progress, special_days, tier_label, week_key,
)
from badges import Goal, SashEntry, png, render_sash_card
from cardutils import fetch_avatar_bytes
from font_utils import clean_display_name
from summary_stats import STREAK_TZ, now_local
from xp import VOICE_XP_INTERVAL_MINUTES
from xproles import XPRoleManager

log = logging.getLogger("gap.achievements")

ACHIEVEMENT_CHANNEL_ID = int(os.getenv("ACHIEVEMENT_CHANNEL_ID", "0") or 0)
CARD_BADGE_LIMIT = 3
DOOR_WINDOW = 30 * 60          # boş kanalı açtıktan sonra bu süre içinde biri gelirse "kapıyı açan"
BATCH = 5000
YEAR = 365 * 86400


@dataclass
class Room:
    opener: int | None
    opened_at: float
    credited: bool = False
    had_company: bool = False


def _humans(channel) -> list[discord.Member]:
    return [m for m in channel.members if not m.bot]


class AchievementCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self._rooms: dict[int, Room] = {}
        self._lock = asyncio.Lock()
        self._roles = XPRoleManager()

    async def cog_load(self) -> None:
        self.process_loop.start()

    async def cog_unload(self) -> None:
        self.process_loop.cancel()

    # ------------------------------------------------------------------
    # İşleme
    # ------------------------------------------------------------------

    async def ingest(self) -> bool:
        """Olay kaydının yeni satırlarını sayaçlara işler. Döner: ilk (geriye dönük) işleme miydi."""
        await activitylog.flush()
        cursor = await db.get_achievement_cursor()
        first_run = cursor == 0
        joined = {
            (g.id, m.id): m.joined_at.timestamp()
            for g in getattr(self.bot, "guilds", []) for m in g.members if getattr(m, "joined_at", None)
        }
        while True:
            rows = await db.get_activity_after(cursor, BATCH)
            if not rows:
                break
            agg = aggregate(rows, VOICE_XP_INTERVAL_MINUTES * 60, joined, await db.get_counter_values("exile_start"))
            await db.add_achievement_counters([(g, u, k, v) for (g, u, k), v in agg.inc.items()])
            await db.add_achievement_counters([(g, u, k, v) for (g, u, k), v in agg.maxes.items()], mode="max")
            await db.add_achievement_counters([(g, u, k, v) for (g, u, k), v in agg.assign.items()], mode="assign")
            for (gid, day), (_, uid) in sorted(agg.first_messages.items(), key=lambda kv: kv[1][0]):
                if await db.claim_day(gid, f"gm:{day}"):                     # günün ilk mesajı (08:00 sonrası)
                    await db.add_achievement_counters([(gid, uid, "gm", 1)])
            cursor = rows[-1]["id"]
            await db.set_achievement_cursor(cursor)
            if len(rows) < BATCH:
                break
        return first_run

    async def _facts(self, guild: discord.Guild) -> dict[int, MemberFacts]:
        counters = await db.get_achievement_counters(guild.id)
        awards = await db.count_summary_awards(guild.id)
        since = time.time() - YEAR
        active = await db.get_active_days(guild.id, since, ("message", "xp_voice"))
        message_days = await db.get_active_days(guild.id, since, ("message",))
        friends: dict[int, int] = {}
        social: dict[int, int] = {}
        for a, b, seconds in await db.get_all_pair_seconds(guild.id):
            for uid in (a, b):
                if seconds >= FRIEND_TIER_SECONDS:
                    friends[uid] = friends.get(uid, 0) + 1
                if seconds >= SOCIAL_SECONDS:
                    social[uid] = social.get(uid, 0) + 1
        rows = {r["user_id"]: r for r in await db.get_all_user_rows(guild.id)}
        now = discord.utils.utcnow()
        facts = {}
        for m in guild.members:
            if m.bot:
                continue
            row = rows.get(m.id)
            facts[m.id] = MemberFacts(
                counters=counters.get(m.id, {}),
                awards=awards.get(m.id, {}),
                active_days_365=len(active.get(m.id, [])),
                message_days=message_days.get(m.id, []),
                friends_20h=friends.get(m.id, 0),
                joined_at=m.joined_at,
                premium_since=m.premium_since,
                now=now,
                active_days=active.get(m.id, []),
                friends_5h=social.get(m.id, 0),
                voice_seconds=int(row["voice_seconds"]) if row else 0,
                current_streak=db.current_streak(row) if row else 0,
                level=self._roles.get_progress_data(int(row["text_xp"]) + int(row["voice_xp"]))[0] if row else 0,
            )
        return facts

    async def evaluate_guild(self, guild: discord.Guild, *, announce: bool) -> dict[int, dict[str, int]]:
        """Üyelerin yükselen başarımlarını kaydeder. Döner: {üye: {başarım: yeni kademe}}."""
        current = await db.get_achievements(guild.id)
        changes: dict[int, dict[str, int]] = {}
        for uid, facts in (await self._facts(guild)).items():
            have = {k: tier for k, (tier, _) in current.get(uid, {}).items()}
            if new := evaluate(facts, have):
                for key, tier in new.items():
                    await db.set_achievement(guild.id, uid, key, tier)
                changes[uid] = new
        if announce and changes:
            await self._announce(guild, changes, current)
        return changes

    async def _award_special_day(self, guild: discord.Guild) -> None:
        created = getattr(guild, "created_at", None)
        founded = created.astimezone(STREAK_TZ).date() if created else None
        keys = special_days(now_local(), founded)
        if not keys:
            return
        afk = guild.afk_channel.id if guild.afk_channel else None
        rows = [
            (guild.id, m.id, key, 1)
            for key in keys
            for channel in guild.voice_channels if channel.id != afk
            for m in _humans(channel)
        ]
        await db.add_achievement_counters(rows, assign=True)

    async def run_once(self) -> None:
        async with self._lock:
            first_run = await self.ingest()
            for guild in self.bot.guilds:
                await self._award_special_day(guild)
                await self.evaluate_guild(guild, announce=not first_run)
            # Eski haftaların ikili sayaçları artık gerekmez (bu ve geçen hafta kalır)
            now = time.time()
            keep = {week_key(now), week_key(now - 7 * 86400)}
            await db.prune_duo_counters(keep)

    @tasks.loop(minutes=5)
    async def process_loop(self) -> None:
        try:
            await self.run_once()
        except Exception:
            log.exception("Başarımlar işlenemedi")

    @process_loop.before_loop
    async def _before_process(self) -> None:
        await self.bot.wait_until_ready()

    async def _announce(self, guild: discord.Guild, changes: dict[int, dict[str, int]],
                        before: dict[int, dict[str, tuple[int, float]]]) -> None:
        channel = guild.get_channel(ACHIEVEMENT_CHANNEL_ID) if ACHIEVEMENT_CHANNEL_ID else None
        if channel is None:
            return
        for uid, new in changes.items():
            lines = []
            for key, tier in new.items():
                a = BY_KEY[key]
                upgraded = key in before.get(uid, {})
                kademe = f" ({tier_label(a, tier)})" if a.tiered else ""
                if a.hidden and not upgraded:
                    lines.append(f"🤫 Gizli bir başarım buldu: **{a.name}**{kademe}")
                elif upgraded:
                    lines.append(f"⬆️ **{a.name}** artık **{tier_label(a, tier)}**")
                else:
                    lines.append(f"🏅 **{a.name}**{kademe} — {a.describe(tier)}")
            try:
                await channel.send(f"<@{uid}>\n" + "\n".join(lines),
                                   allowed_mentions=discord.AllowedMentions(users=[discord.Object(uid)]))
            except discord.HTTPException:
                log.warning("Başarım duyurusu gönderilemedi (%s)", uid)

    # ------------------------------------------------------------------
    # Canlı takip
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_voice_state_update(self, member: discord.Member, before: discord.VoiceState,
                                    after: discord.VoiceState) -> None:
        if member.bot or before.channel == after.channel:
            return
        afk = member.guild.afk_channel.id if member.guild.afk_channel else None
        now = time.time()
        rows: list[tuple[int, int, str, float]] = []

        if before.channel is not None and before.channel.id != afk:
            room = self._rooms.get(before.channel.id)
            if not _humans(before.channel):
                self._rooms.pop(before.channel.id, None)
                if room is not None and room.had_company:
                    rows.append((member.guild.id, member.id, "lights", 1))   # muhabbetten en son çıkan

        if after.channel is not None and after.channel.id != afk:
            humans = _humans(after.channel)
            if len(humans) == 1:
                self._rooms[after.channel.id] = Room(opener=member.id, opened_at=now)
            else:
                room = self._rooms.setdefault(after.channel.id, Room(opener=None, opened_at=now))
                room.had_company = True
                present = {m.id for m in humans}
                if (room.opener and not room.credited and room.opener != member.id
                        and room.opener in present and now - room.opened_at <= DOOR_WINDOW):
                    room.credited = True
                    rows.append((member.guild.id, room.opener, "door", 1))  # kapıyı açtı, arkadaşı geldi

        await db.add_achievement_counters(rows)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message) -> None:
        if message.author.bot or message.guild is None:
            return
        prefixes = await self.bot.get_prefix(message)
        prefixes = [prefixes] if isinstance(prefixes, str) else prefixes
        if any(message.content.startswith(p) for p in prefixes):
            return
        exile = await db.get_exile(message.guild.id, message.author.id)
        if exile is not None and not db.exile_expired(exile):
            await db.add_achievement_counters([(message.guild.id, message.author.id, "exile_msg", 1)])

    # ------------------------------------------------------------------
    # Kartlar
    # ------------------------------------------------------------------

    async def build_sash(self, member: discord.Member):
        facts = (await self._facts(member.guild)).get(member.id)
        earned = {k: tier for k, (tier, _) in (await db.get_achievements(member.guild.id, member.id)).get(member.id, {}).items()}
        entries = [SashEntry(a, earned.get(a.key, 0), (not a.hidden) or a.key in earned) for a in ACHIEVEMENTS]
        goals: list[Goal] = []
        if facts is not None:
            for a in ACHIEVEMENTS:
                if a.hidden or a.manual:
                    continue
                tier = earned.get(a.key, 0)
                if (p := progress(a, facts, tier, earned)) is None:
                    continue
                value, target = p
                if value <= 0:
                    continue
                unit = f" {a.unit}" if a.unit else ""
                goals.append(Goal(f"{a.name} → {tier_label(a, tier + 1)}", f"{int(value)}/{int(target)}{unit}", value / target))
            goals.sort(key=lambda g: -g.ratio)
        avatar = await fetch_avatar_bytes(member, 256)
        card = await asyncio.to_thread(render_sash_card, clean_display_name(member), avatar, entries, goals[:2])
        return await asyncio.to_thread(png, card)

    # ------------------------------------------------------------------
    # Komutlar
    # ------------------------------------------------------------------

    @commands.command(name="başarımlar", aliases=["basarimlar", "başarımlarım", "basarimlarim", "rozetler", "achievements"])
    @commands.guild_only()
    async def achievements_command(self, ctx: commands.Context, member: discord.Member | None = None) -> None:
        """Başarımları izci fuları kartında gösterir."""
        target = member or ctx.author
        if target.bot:
            await ctx.send("🤖 Botların başarımı yok.")
            return
        async with ctx.typing():
            buf = await self.build_sash(target)
        await ctx.send("Nasıl kazanılır? `!başarımrehberi` · Kartına rozet seç: `!kartdüzen`",
                       file=discord.File(buf, filename="basarimlar.png"))

    @commands.command(name="başarımrehberi", aliases=[
        "basarimrehberi", "başarımrehber", "basarimrehber", "rozetrehberi", "nasılkazanılır", "nasilkazanilir",
    ])
    @commands.guild_only()
    async def guide_command(self, ctx: commands.Context) -> None:
        """Gizli olmayan başarımların nasıl kazanıldığını ve senin durumunu gösterir."""
        earned = {k: tier for k, (tier, _) in (await db.get_achievements(ctx.guild.id, ctx.author.id)).get(ctx.author.id, {}).items()}
        embed = discord.Embed(
            title="🏅 Başarım Rehberi",
            description=(
                f"Kademeli başarımlar **{' → '.join(TIER_NAMES)}** ilerler, tek kademeliler açılınca **Özel** olur. "
                "Kademe hiç düşmez.\n✅ = sende var (kademesiyle) · ▫️ = henüz yok"
            ),
            color=discord.Color.from_rgb(88, 225, 193),
        )
        for category in CATEGORIES:
            lines = []
            for a in ACHIEVEMENTS:
                if a.category != category or a.hidden:
                    continue
                tier = earned.get(a.key, 0)
                mark = f"✅ {tier_label(a, tier)}" if tier else "▫️"
                if a.tiered:
                    unit = f" {a.unit}" if a.unit else ""
                    steps = " / ".join(f"{int(t):,}".replace(",", ".") for t in a.tiers)
                    how = f"{a.desc.replace('{n}', 'N')} — N: {steps}{unit}"
                else:
                    how = a.desc + (" (yönetici verir)" if a.manual else "")
                lines.append(f"{emoji(a)} **{a.name}** · {mark}\n┗ {how}")
            if lines:
                embed.add_field(name=category, value="\n".join(lines)[:1024], inline=False)
        hidden = [a for a in ACHIEVEMENTS if a.hidden]
        found = sum(1 for a in hidden if a.key in earned)
        embed.add_field(
            name="🤫 Gizli başarımlar",
            value=f"**{len(hidden)}** gizli başarım var, **{found}** tanesini buldun. "
                  "Adları ve koşulları açılana kadar görünmez; bulduklarını `!başarımlar` kartında görürsün.",
            inline=False,
        )
        embed.set_footer(text="!başarımlar — rozetlerin · !kartdüzen — kartında 3 rozet göster")
        await ctx.send(embed=embed)

    @commands.command(name="kartdüzen", aliases=["kartduzen", "kartdüzenle", "kartduzenle", "rozetseç", "rozetsec"])
    @commands.guild_only()
    async def card_edit_command(self, ctx: commands.Context) -> None:
        """!kart'ta gösterilecek en fazla 3 başarımı seçtirir."""
        earned = (await db.get_achievements(ctx.guild.id, ctx.author.id)).get(ctx.author.id, {})
        if not earned:
            await ctx.send("🏅 Henüz bir başarımın yok. `!başarımlar` ile neler var bir bak!")
            return
        chosen = [k for k in await db.get_card_badges(ctx.guild.id, ctx.author.id) if k in earned]
        view = BadgePicker(ctx.author, earned, chosen)
        view.message = await ctx.send(
            "🎖️ `!kart`'ında görünecek en fazla **3** başarımı seç:", view=view,
        )

    @staticmethod
    def _names() -> str:
        return ", ".join(f"`{a.name}`" for a in ACHIEVEMENTS)

    @commands.command(name="basarimver", aliases=["başarımver", "rozetver"], usage="@üye <başarım> [gümüş|altın|platin]")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def grant_command(self, ctx: commands.Context, member: discord.Member, *, name: str) -> None:
        """
        Başarımı elle verir. Kademe yazılmazsa bir üst kademe verilir (yoksa ilk kademe).
        Örn: !basarimver @üye Fikir Babası · !basarimver @üye Yayıncı altın
        """
        words = name.split()
        tier = parse_tier(words[-1]) if len(words) > 1 else None
        a = find(" ".join(words[:-1]) if tier else name)
        if a is None:
            await ctx.send(f"❌ `{name}` diye bir başarım bulamadım. Başarımlar: {self._names()}")
            return
        if member.bot:
            await ctx.send("🤖 Botlara başarım verilmez.")
            return
        current = (await db.get_achievements(ctx.guild.id, member.id)).get(member.id, {}).get(a.key, (0, 0))[0]
        if tier is None:
            tier = min(current + 1, a.max_tier)
        elif not a.tiered:
            tier = 1
        if tier == current:
            await ctx.send(f"ℹ️ {member.display_name} zaten **{a.name}** ({tier_label(a, tier)}).")
            return
        await db.set_achievement(ctx.guild.id, member.id, a.key, tier)
        activitylog.record("admin_achievement_grant", ctx.guild.id, member.id, actor_id=ctx.author.id,
                           key=a.key, tier=tier, before=current)
        label = f" · **{tier_label(a, tier)}**" if a.tiered else ""
        await ctx.send(f"🏅 {member.mention} artık **{a.name}**{label}! ({a.describe(tier)})",
                       allowed_mentions=discord.AllowedMentions(users=[member]))

    @commands.command(name="basarimal", aliases=["başarımal", "rozetal"], usage="@üye <başarım>")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def revoke_command(self, ctx: commands.Context, member: discord.Member, *, name: str) -> None:
        """Bir başarımı geri alır (yanlışlıkla verildiyse)."""
        a = find(name)
        if a is None:
            await ctx.send(f"❌ `{name}` diye bir başarım bulamadım. Başarımlar: {self._names()}")
            return
        removed = await db.delete_achievement(ctx.guild.id, member.id, a.key)
        activitylog.record("admin_achievement_revoke", ctx.guild.id, member.id, actor_id=ctx.author.id, key=a.key)
        await ctx.send(f"🗑️ **{a.name}** {member.display_name} üyesinden alındı." if removed
                       else f"ℹ️ {member.display_name} üyesinde **{a.name}** yok.")

    async def cog_command_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        elif isinstance(error, commands.MemberNotFound):
            await ctx.send(f"❌ `{error.argument}` adında bir üye bulamadım.")
        elif isinstance(error, (commands.BadArgument, commands.MissingRequiredArgument)) and ctx.command:
            await ctx.send(f"❌ Kullanım: `{ctx.prefix}{ctx.invoked_with} {ctx.command.usage or ctx.command.signature}`")


class BadgePicker(discord.ui.View):
    """!kartdüzen: kazanılan başarımlardan en fazla 3'ünü seçtiren menü (yalnızca komutu yazan kullanabilir)."""

    def __init__(self, member: discord.Member, earned: dict[str, tuple[int, float]], chosen: list[str]) -> None:
        super().__init__(timeout=180)
        self.member = member
        self.message: discord.Message | None = None
        ordered = sorted(earned.items(), key=lambda kv: (-kv[1][0], BY_KEY[kv[0]].name))[:25]
        options = [
            discord.SelectOption(
                label=BY_KEY[key].name, value=key, default=key in chosen,
                description=f"{tier_label(BY_KEY[key], tier)} · {BY_KEY[key].describe(tier)}"[:100],
                emoji=emoji(BY_KEY[key]),
            )
            for key, (tier, _) in ordered
        ]
        select = discord.ui.Select(placeholder="Rozet seç (en fazla 3)", min_values=0,
                                   max_values=min(CARD_BADGE_LIMIT, len(options)), options=options)
        select.callback = self._picked
        self.select = select
        self.add_item(select)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.member.id:
            await interaction.response.send_message("Bu menü sana ait değil; kendi kartın için `!kartdüzen` yaz.",
                                                    ephemeral=True)
            return False
        return True

    async def _picked(self, interaction: discord.Interaction) -> None:
        keys = list(self.select.values)
        await db.set_card_badges(self.member.guild.id, self.member.id, keys)
        names = ", ".join(f"**{BY_KEY[k].name}**" for k in keys) or "hiçbiri"
        await interaction.response.edit_message(content=f"✅ `!kart`'ında artık: {names}", view=None)
        self.stop()

    async def on_timeout(self) -> None:
        if self.message is not None:
            try:
                await self.message.edit(view=None)
            except discord.HTTPException:
                pass
