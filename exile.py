"""
exile.py — Sürgün sistemi: yöneticilerin XP cezası.

- !sürgün @üye <süre|kalıcı> <sebep> → üye XP'yi sabit 0.5x kazanır; boost ve
  seri çarpanı yok sayılır, seri dondurulur (bkz. xp.py, database.py).
- !sürgünsonlandır @üye → cezayı erken bitirir.
- !sürgünler → sürgündekileri ve kalan sürelerini hapishane temalı bir kartta gösterir.

Süresi dolan sürgünler dakikada bir kontrol edilip kendiliğinden biter; seri
kaldığı yerden devam eder.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import time
from dataclasses import dataclass

import discord
from discord.ext import commands, tasks
from PIL import Image, ImageDraw, ImageOps

import activitylog
import database as db
from cardutils import draw_translucent, fetch_avatar_bytes, fit_text, load_font, text_width, to_png
from font_utils import clean_display_name, clean_text
from xp import EXILE_MULTIPLIER, XPTrackerCog, streak_multiplier

log = logging.getLogger("gap.exile")

PERMANENT_WORDS = {"kalıcı", "kalici", "süresiz", "suresiz", "sonsuz", "perm", "permanent"}
MAX_EXILE_SECONDS = 365 * 86400
LIST_LIMIT = 10

_UNITS = {
    "dk": 60, "dak": 60, "dakika": 60, "m": 60, "min": 60,
    "sa": 3600, "saat": 3600, "h": 3600,
    "g": 86400, "gün": 86400, "gun": 86400, "d": 86400,
    "hf": 604800, "hafta": 604800, "w": 604800,
    "ay": 2592000,
}
_DURATION_PART = re.compile(r"(\d+(?:[.,]\d+)?)\s*([a-zçğıöşü]*)")
_DURATION_RE = re.compile(r"(?:\d+(?:[.,]\d+)?\s*[a-zçğıöşü]*\s*)+")

USAGE_EXILE = "!sürgün @kullanıcı <süre|kalıcı> <sebep>"


def parse_duration(text: str) -> int | None:
    """
    "30dk", "12sa", "3g", "1hafta", "1g12sa", "2" (saat) → saniye. "kalıcı" → 0.
    Anlaşılamazsa None.
    """
    text = text.strip().lower()
    if text in PERMANENT_WORDS:
        return 0
    if not _DURATION_RE.fullmatch(text):
        return None
    total = 0.0
    for number, unit in _DURATION_PART.findall(text):
        factor = _UNITS.get(unit or "sa")
        if factor is None:
            return None
        total += float(number.replace(",", ".")) * factor
    seconds = int(total)
    return seconds if seconds >= 60 else None


def format_remaining(seconds: float | None) -> str:
    """Kalan süre: '3g 4sa', '2sa 15dk', '12dk', '<1dk'. None → 'Kalıcı'."""
    if seconds is None:
        return "Kalıcı"
    seconds = int(max(0, seconds))
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days:
        return f"{days}g {hours}sa" if hours else f"{days}g"
    if hours:
        return f"{hours}sa {minutes}dk" if minutes else f"{hours}sa"
    return f"{minutes}dk" if minutes else "<1dk"


# ---------------------------------------------------------------------------
# !sürgünler kartı
# ---------------------------------------------------------------------------
# Botun koyu lacivert temasında; turuncu/kırmızı uyarı rengi, demir parmaklıklar,
# sabıka fotoğrafı (boy çizgili mugshot) ve üstte ikaz şeridi ile hapishane havası.

W = 900
HEADER_H = 150
ROW_H = 128
FOOTER_H = 56
PAD = 22
SHOT = 92  # mugshot kare boyutu

BG_TOP, BG_BOTTOM = (8, 16, 30), (14, 22, 40)
PANEL = (14, 22, 40, 225)
OUTLINE = "#2A2F45"
TEXT = "#F5F7FB"
MUTED = "#8EA0BC"
AMBER = "#FFB547"
RED = "#FF5D5D"
IRON_DARK = (28, 32, 40)
IRON_LIGHT = (92, 100, 116)


@dataclass
class ExileEntry:
    name: str
    user_id: int
    reason: str
    moderator: str
    started_at: float
    ends_at: float | None
    streak: int
    avatar: bytes | None


def _vertical_gradient(w: int, h: int, top: tuple, bottom: tuple) -> Image.Image:
    img = Image.new("RGBA", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        draw.line([(0, y), (w, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
    return img


def _bars(size: tuple[int, int], count: int, width: int, alpha: int = 255) -> Image.Image:
    """Yandan ışık almış demir parmaklıklar (saydam katman)."""
    w, h = size
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    gap = w / count
    for i in range(count):
        x = int(gap * i + gap / 2 - width / 2)
        draw.rectangle((x, 0, x + width, h), fill=(*IRON_DARK, alpha))
        draw.rectangle((x + 1, 0, x + max(2, width // 3), h), fill=(*IRON_LIGHT, alpha))
    return layer


def _hazard_stripe(w: int, h: int) -> Image.Image:
    img = Image.new("RGBA", (w, h), (24, 20, 14, 255))
    draw = ImageDraw.Draw(img)
    step = h * 2
    for x in range(-h, w + h, step):
        draw.polygon([(x, h), (x + h, 0), (x + 2 * h, 0), (x + h, h)], fill=(255, 181, 71, 255))
    return img


def _padlock(draw: ImageDraw.ImageDraw, cx: int, cy: int, s: int, color: str) -> None:
    draw.arc((cx - s * 0.55, cy - s * 1.15, cx + s * 0.55, cy - s * 0.05), 180, 360, fill=color, width=max(3, s // 6))
    draw.line((cx - s * 0.55 + 1, cy - s * 0.62, cx - s * 0.55 + 1, cy - s * 0.2), fill=color, width=max(3, s // 6))
    draw.line((cx + s * 0.55 - 2, cy - s * 0.62, cx + s * 0.55 - 2, cy - s * 0.2), fill=color, width=max(3, s // 6))
    draw.rounded_rectangle((cx - s * 0.8, cy - s * 0.25, cx + s * 0.8, cy + s * 0.75), radius=s // 6, fill=color)
    draw.ellipse((cx - s * 0.14, cy + s * 0.05, cx + s * 0.14, cy + s * 0.33), fill="#08101E")
    draw.rectangle((cx - s * 0.05, cy + s * 0.25, cx + s * 0.05, cy + s * 0.5), fill="#08101E")


def _mugshot(avatar: bytes | None, name: str, number: str) -> Image.Image:
    """Boy çizgili arka plan önünde soluk avatar, önünde parmaklık, altında numara tabelası."""
    shot = Image.new("RGBA", (SHOT, SHOT), (34, 40, 56, 255))
    draw = ImageDraw.Draw(shot)
    for y in range(6, SHOT, 10):  # boy çizgileri
        draw.line((0, y, SHOT if y % 20 == 6 else 14, y), fill=(70, 80, 100, 255), width=1)

    if avatar:
        try:
            img = Image.open(io.BytesIO(avatar)).convert("RGBA")
            base = Image.new("RGBA", img.size, (34, 40, 56, 255))
            img = ImageOps.fit(Image.alpha_composite(base, img).convert("RGB"), (SHOT - 16, SHOT - 16))
            gray = ImageOps.grayscale(img).convert("RGB")
            img = Image.blend(img, gray, 0.65)  # soluk, sabıka fotoğrafı gibi
            shot.paste(img, (8, 4))
        except (OSError, ValueError):
            avatar = None
    if not avatar:
        initial = (name[:1] or "?").upper()
        draw.ellipse((18, 10, SHOT - 18, SHOT - 26), fill=(52, 60, 80, 255))
        draw.text((SHOT // 2, (SHOT - 16) // 2), initial, font=load_font(30, bold=True), fill=MUTED, anchor="mm")

    shot.alpha_composite(_bars((SHOT, SHOT), 4, 5))
    plate_font = load_font(13, bold=True)
    draw = ImageDraw.Draw(shot)
    draw.rectangle((10, SHOT - 22, SHOT - 10, SHOT - 4), fill=(12, 14, 20, 255), outline=AMBER)
    draw.text((SHOT // 2, SHOT - 13), number, font=plate_font, fill=AMBER, anchor="mm")

    mask = Image.new("L", (SHOT, SHOT), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, SHOT - 1, SHOT - 1), radius=12, fill=255)
    shot.putalpha(mask)
    return shot


def render_exile_card(guild_name: str, entries: list[ExileEntry], more: int = 0, now: float | None = None) -> io.BytesIO:
    now = now if now is not None else time.time()
    rows = len(entries)
    empty_h = 0 if entries else 50
    height = HEADER_H + rows * ROW_H + empty_h + FOOTER_H
    card = _vertical_gradient(W, height, BG_TOP, BG_BOTTOM)

    # Arka planda silik parmaklıklar
    card.alpha_composite(_bars((W, height), 14, 10, alpha=38))

    # Başlık: ikaz şeridi, kilit, yazılar
    card.alpha_composite(_hazard_stripe(W, 14), (0, 0))
    draw = ImageDraw.Draw(card)
    draw_translucent(card, [((PAD, 34, W - PAD, HEADER_H - 14), 18, (10, 16, 30, 235), OUTLINE)])
    draw = ImageDraw.Draw(card)
    _padlock(draw, PAD + 52, 90, 30, AMBER)
    draw.text((PAD + 100, 70), "SÜRGÜN LİSTESİ", font=load_font(36, bold=True), fill=TEXT, anchor="lm")
    count_txt = f"{rows + more} sürgün" if rows + more else "Sürgünde kimse yok"
    sub = f"{clean_text(guild_name) or 'Sunucu'}  ·  {count_txt}"
    draw.text((PAD + 100, 108), fit_text(draw, sub, load_font(17), W - PAD * 2 - 260), font=load_font(17), fill=MUTED, anchor="lm")
    tag_font = load_font(15, bold=True)
    tag = f"{EXILE_MULTIPLIER:g}x XP"
    tw = int(text_width(draw, tag, tag_font)) + 28
    draw.rounded_rectangle((W - PAD - 24 - tw, 72, W - PAD - 24, 108), radius=18, outline=RED, width=2)
    draw.text((W - PAD - 24 - tw // 2, 90), tag, font=tag_font, fill=RED, anchor="mm")

    name_font = load_font(22, bold=True)
    small = load_font(15)
    small_bold = load_font(15, bold=True)
    big = load_font(26, bold=True)

    for i, e in enumerate(entries):
        y0 = HEADER_H + i * ROW_H
        permanent = e.ends_at is None
        accent = RED if permanent else AMBER
        draw_translucent(card, [((PAD, y0 + 6, W - PAD, y0 + ROW_H - 6), 16, PANEL, OUTLINE)])
        draw = ImageDraw.Draw(card)
        draw.rounded_rectangle((PAD, y0 + 6, PAD + 6, y0 + ROW_H - 6), radius=3, fill=accent)

        shot = _mugshot(e.avatar, e.name, f"#{str(e.user_id)[-4:]}")
        card.alpha_composite(shot, (PAD + 20, y0 + (ROW_H - SHOT) // 2))
        draw = ImageDraw.Draw(card)

        tx = PAD + 20 + SHOT + 20
        right_w = 210
        text_w = W - PAD - right_w - tx - 10
        draw.text((tx, y0 + 30), fit_text(draw, e.name, name_font, text_w), font=name_font, fill=TEXT, anchor="lm")
        draw.text((tx, y0 + 60), fit_text(draw, f"Sebep: {e.reason}", small, text_w), font=small, fill=MUTED, anchor="lm")
        frozen = f"Seri {e.streak} günde donduruldu" if e.streak else "Boost ve seri işlemiyor"
        draw.text((tx, y0 + 86), fit_text(draw, f"Sürgün eden: {e.moderator}  ·  {frozen}", small, text_w),
                  font=small, fill=(120, 132, 156), anchor="lm")

        # Sağ: kalan süre ve çekilen cezanın çubuğu
        rx = W - PAD - 24
        if permanent:
            draw.text((rx, y0 + 40), "KALICI", font=big, fill=RED, anchor="rm")
            draw.text((rx, y0 + 68), "yönetici kaldırana kadar", font=small, fill=MUTED, anchor="rm")
        else:
            draw.text((rx, y0 + 40), format_remaining(e.ends_at - now), font=big, fill=AMBER, anchor="rm")
            draw.text((rx, y0 + 68), "kaldı", font=small_bold, fill=MUTED, anchor="rm")

        bx0, bx1, by = rx - 180, rx, y0 + 92
        draw.rounded_rectangle((bx0, by, bx1, by + 10), radius=5, fill=(26, 32, 50))
        if permanent:
            for x in range(bx0, bx1, 14):  # kırmızı-siyah çizgili "bitmeyen" çubuk
                draw.polygon([(x, by + 10), (x + 6, by), (x + 12, by), (x + 6, by + 10)], fill=(150, 50, 50))
        else:
            total = max(1.0, e.ends_at - e.started_at)
            ratio = min(1.0, max(0.0, (now - e.started_at) / total))
            fill_w = max(10, int((bx1 - bx0) * ratio))
            draw.rounded_rectangle((bx0, by, bx0 + fill_w, by + 10), radius=5, fill=AMBER)

    # Alt bilgi
    fy = HEADER_H + rows * ROW_H
    if not entries:
        draw.text((W // 2, fy + 18), "Herkes özgür.", font=load_font(20, bold=True), fill=MUTED, anchor="mm")
        fy += empty_h
    note = f"Sürgündekiler tüm XP'yi {EXILE_MULTIPLIER:g}x kazanır; boost ve seri çarpanı işlemez, seri donar."
    if more:
        note = f"+{more} kişi daha  ·  " + note
    draw.text((W // 2, fy + FOOTER_H // 2 - 4), fit_text(draw, note, small, W - PAD * 2),
              font=small, fill=(110, 122, 146), anchor="mm")

    draw.rounded_rectangle((6, 6, W - 7, height - 7), radius=18, outline=OUTLINE, width=2)
    return to_png(card)


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class ExileCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    async def cog_load(self) -> None:
        self.expiry_loop.start()

    async def cog_unload(self) -> None:
        self.expiry_loop.cancel()

    def _xp(self) -> XPTrackerCog | None:
        cog = self.bot.get_cog("XPTrackerCog")
        return cog if isinstance(cog, XPTrackerCog) else None

    def _audit(self, ctx: commands.Context, event: str, target: discord.Member, **meta) -> None:
        xp = self._xp()
        if xp is not None:
            xp._audit_admin(ctx, event, target, **meta)
        else:
            activitylog.record(event, ctx.guild.id, target.id, channel_id=ctx.channel.id, actor_id=ctx.author.id, **meta)

    async def cog_command_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        elif isinstance(error, commands.NoPrivateMessage):
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
        elif isinstance(error, commands.MemberNotFound):
            await ctx.send(f"❌ `{error.argument}` adında bir üye bulamadım.")
        elif isinstance(error, (commands.BadArgument, commands.MissingRequiredArgument)) and ctx.command:
            usage = ctx.command.usage or ctx.command.signature
            await ctx.send(f"❌ Kullanım: `{ctx.prefix}{ctx.invoked_with} {usage}`")

    # ------------------------------------------------------------------
    # Komutlar
    # ------------------------------------------------------------------

    @commands.command(name="sürgün", aliases=["surgun", "sürgun", "surgün", "exile"],
                      usage="@kullanıcı <süre|kalıcı> <sebep>")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def exile_command(
        self, ctx: commands.Context, member: discord.Member, duration: str, *, reason: str | None = None,
    ) -> None:
        """Üyeyi sürgüne gönderir: XP 0.5x, boost ve seri çarpanı yok sayılır, seri donar."""
        seconds = parse_duration(duration)
        if seconds is None:
            await ctx.send(
                f"❌ Süreyi anlayamadım: `{duration}`. Örnekler: `30dk`, `12sa`, `3g`, `1hafta`, `1g12sa` ya da `kalıcı`.\n"
                f"Kullanım: `{USAGE_EXILE}`"
            )
            return
        if seconds > MAX_EXILE_SECONDS:
            await ctx.send("❌ Süre en fazla 365 gün olabilir; daha uzunu için `kalıcı` yaz.")
            return
        reason = await XPTrackerCog._require_reason(ctx, reason, USAGE_EXILE)
        if reason is None:
            return
        if member.bot:
            await ctx.send("❌ Botlar sürgüne gönderilemez.")
            return

        ends_at = time.time() + seconds if seconds else None
        is_new = await db.set_exile(
            ctx.guild.id, member.id, ends_at=ends_at, reason=reason,
            moderator_id=ctx.author.id, channel_id=ctx.channel.id,
        )
        exile = await db.get_exile(ctx.guild.id, member.id)
        label = "kalıcı" if ends_at is None else format_remaining(seconds)
        self._audit(ctx, "admin_exile", member, sure=label, sebep=reason, yeni=is_new)

        when = "Bir yönetici `!sürgünsonlandır` ile kaldırana kadar sürecek." if ends_at is None \
            else f"Bitiş: <t:{int(ends_at)}:F> (<t:{int(ends_at)}:R>)"
        title = "⛓️ Sürgüne gönderildi" if is_new else "⛓️ Sürgün güncellendi"
        streak = exile["streak_at_start"] if exile else 0
        embed = discord.Embed(
            title=title,
            description=(
                f"{member.mention} artık tüm XP'yi **{EXILE_MULTIPLIER:g}x** kazanacak; "
                f"boost ve seri çarpanı işlemeyecek.\n"
                + (f"🔥 Serisi **{streak} günde** donduruldu; ceza bitince kaldığı yerden devam edecek.\n"
                   if streak else "")
                + f"\n⏳ **Süre:** {label}\n{when}\n📝 **Sebep:** {reason}"
            ),
            color=discord.Color.from_rgb(255, 93, 93),
        )
        embed.set_thumbnail(url=member.display_avatar.url)
        embed.set_footer(text=f"Sürgün eden: {ctx.author.display_name}")
        await ctx.send(embed=embed, allowed_mentions=discord.AllowedMentions(users=[member]))

    @commands.command(name="sürgünsonlandır", aliases=[
        "surgunsonlandir", "sürgünsonlandir", "surgunsonlandır", "sürgünbitir", "surgunbitir", "unexile",
    ], usage="@kullanıcı")
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def unexile_command(self, ctx: commands.Context, member: discord.Member) -> None:
        """Sürgünü erken bitirir; XP çarpanı normale, seri kaldığı yerden devam eder."""
        row = await db.end_exile(ctx.guild.id, member.id)
        if row is None:
            await ctx.send(f"ℹ️ **{member.display_name}** zaten sürgünde değil.")
            return
        self._audit(ctx, "admin_exile_end", member, sebep=row["reason"])
        await ctx.send(self._release_text(member.mention, row, by=ctx.author.display_name),
                       allowed_mentions=discord.AllowedMentions(users=[member]))

    @commands.command(name="sürgünler", aliases=["surgunler", "sürgunler", "surgünler", "exiles"])
    @commands.guild_only()
    async def exiles_command(self, ctx: commands.Context) -> None:
        """Sürgündekileri ve kalan sürelerini kart olarak gösterir."""
        for row in await db.list_expired_exiles():  # süresi dolanlar listede görünmesin
            if row["guild_id"] == ctx.guild.id:
                await self._expire(row)
        rows = await db.list_exiles(ctx.guild.id)
        shown, more = rows[:LIST_LIMIT], max(0, len(rows) - LIST_LIMIT)

        members = [ctx.guild.get_member(r["user_id"]) for r in shown]
        avatars = await asyncio.gather(*(fetch_avatar_bytes(m, 128) for m in members))
        entries = []
        for r, m, a in zip(shown, members, avatars):
            mod = ctx.guild.get_member(r["moderator_id"])
            entries.append(ExileEntry(
                name=clean_display_name(m, fallback=f"Ayrılmış üye {str(r['user_id'])[-4:]}"),
                user_id=r["user_id"],
                reason=clean_text(r["reason"]) or "-",
                moderator=clean_display_name(mod, fallback="Yönetici"),
                started_at=r["started_at"],
                ends_at=r["ends_at"],
                streak=r["streak_at_start"],
                avatar=a,
            ))
        async with ctx.typing():
            buf = await asyncio.to_thread(render_exile_card, ctx.guild.name, entries, more)
        await ctx.send(file=discord.File(buf, filename="surgunler.png"))

    # ------------------------------------------------------------------
    # Süre dolunca
    # ------------------------------------------------------------------

    @staticmethod
    def _release_text(mention: str, row, by: str | None = None) -> str:
        streak = row["streak_at_start"]
        head = f"🔓 {mention} sürgünden döndü" + (f" (**{by}** tarafından affedildi)." if by else ", cezası bitti.")
        tail = (f" Serisi **{streak} günden** devam ediyor (x{streak_multiplier(streak):.2f})."
                if streak else "")
        return f"{head} XP çarpanı normale döndü.{tail}"

    async def _announce_release(self, guild_id: int, user_id: int, row) -> None:
        guild = self.bot.get_guild(guild_id)
        if guild is None:
            return
        activitylog.record("exile_expired", guild_id, user_id, actor_id=None, sebep=row["reason"])
        mention = f"<@{user_id}>"
        channel = guild.get_channel(row["channel_id"]) if row["channel_id"] else None
        if channel is not None:
            try:
                await channel.send(self._release_text(mention, row),
                                   allowed_mentions=discord.AllowedMentions(users=[discord.Object(user_id)]))
            except discord.HTTPException:
                pass
        self.bot.dispatch("gap_alert", guild, "🔓 Sürgün bitti", f"{mention} (`{user_id}`) sürgünün süresi doldu.")

    async def _expire(self, row) -> None:
        ended = await db.end_exile(row["guild_id"], row["user_id"])
        if ended is not None:
            await self._announce_release(row["guild_id"], row["user_id"], ended)

    @commands.Cog.listener()
    async def on_exile_end(self, guild_id: int, user_id: int, row, _by) -> None:
        """XP sistemi süresi dolmuş bir sürgünü (mesaj/ses sırasında) kapattığında."""
        await self._announce_release(guild_id, user_id, row)

    @tasks.loop(minutes=1)
    async def expiry_loop(self) -> None:
        try:
            for row in await db.list_expired_exiles():
                await self._expire(row)
        except Exception:
            log.exception("Süresi dolan sürgünler kapatılamadı")

    @expiry_loop.before_loop
    async def _before_expiry(self) -> None:
        await self.bot.wait_until_ready()
