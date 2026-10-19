"""
summary.py — Haftalık özet ve aylık Wrapped.

- Pazar 21:00'de (Türkiye saati) haftalık sunucu özeti, ayın son günü 21:00'de aylık
  Wrapped kartı SUMMARY_CHANNEL_ID (yoksa ANNOUNCE_CHANNEL_ID) kanalına kendiliğinden gider.
  Bot o saatte kapalıysa aynı gün açılınca gönderir; her dönem için bir kez.
- !haftalik yalnızca pazar, !wrapped yalnızca ayın son günü çalışır ve kişisel kartı verir.
  Herkes dönem başına bir kez kullanabilir (spam olmasın).
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

import discord
from discord.ext import commands, tasks
from PIL import Image, ImageDraw

import activitylog
import database as db
from cardutils import (
    circle_avatar, draw_translucent, fetch_avatar_bytes, fit_text, load_font, paste_glow, text_width, to_png,
)
from font_utils import clean_display_name, clean_text
from summary_stats import (
    SUMMARY_EVENTS, WEEKDAYS, Period, PeriodStats, compute, format_hours, hour_range, is_month_end, is_week_end,
    month_period, now_local, period_awards, persona, top, week_period,
)
from xp import VOICE_XP_INTERVAL_MINUTES
from xproles import XPRoleManager

log = logging.getLogger("gap.summary")

SUMMARY_CHANNEL_ID = int(os.getenv("SUMMARY_CHANNEL_ID", "0") or 0)
ANNOUNCE_CHANNEL_ID = int(os.getenv("ANNOUNCE_CHANNEL_ID", "0") or 0)
POST_HOUR = int(os.getenv("SUMMARY_POST_HOUR", "21") or 21)
STATE_PATH = Path(__file__).resolve().parent / "data" / "summary_state.json"
VOICE_INTERVAL_SECONDS = VOICE_XP_INTERVAL_MINUTES * 60

# ---------------------------------------------------------------------------
# Tema
# ---------------------------------------------------------------------------

W = 1000
BG_TOP, BG_BOTTOM = (8, 16, 30), (14, 24, 44)
PANEL = (14, 22, 40, 225)
OUTLINE = "#20324F"
TEXT = "#F5F7FB"
MUTED = "#8EA0BC"
THEMES = {
    "week": {"accent": "#58E1C1", "accent2": "#47A9FF", "label": "HAFTALIK ÖZET"},
    "month": {"accent": "#C08CFF", "accent2": "#FFC857", "label": "AYLIK WRAPPED"},
}


@dataclass
class Tile:
    label: str
    title: str
    value: str
    avatars: tuple[bytes | None, ...] = ()


# ---------------------------------------------------------------------------
# Çizim
# ---------------------------------------------------------------------------

def _background(height: int, accent: str, accent2: str) -> Image.Image:
    card = Image.new("RGBA", (W, height))
    draw = ImageDraw.Draw(card)
    for y in range(height):
        t = y / max(1, height - 1)
        draw.line([(0, y), (W, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)) + (255,))
    paste_glow(card, (110, 30), 260, accent, 38)
    paste_glow(card, (W - 80, height - 60), 260, accent2, 26)
    return card


def _avatar(card: Image.Image, data: bytes | None, center: tuple[int, int], size: int, ring: str | None) -> None:
    img = circle_avatar(data, size)
    x, y = center[0] - size // 2, center[1] - size // 2
    if ring:
        ImageDraw.Draw(card).ellipse((x - 4, y - 4, x + size + 3, y + size + 3), outline=ring, width=4)
    card.alpha_composite(img, (x, y))


def _tiles(card: Image.Image, tiles: list[Tile], top: int, accent: str) -> int:
    """2 sütunlu kutucuklar; döner: bitiş y'si."""
    tile_w, tile_h, gap, pad = (W - 2 * 32 - 20) // 2, 112, 20, 32
    for i, tile in enumerate(tiles):
        col, row = i % 2, i // 2
        x0 = pad + col * (tile_w + gap)
        y0 = top + row * (tile_h + gap)
        draw_translucent(card, [((x0, y0, x0 + tile_w, y0 + tile_h), 18, PANEL, OUTLINE)])
        draw = ImageDraw.Draw(card)
        draw.rounded_rectangle((x0, y0 + 18, x0 + 5, y0 + tile_h - 18), radius=3, fill=accent)
        tx = x0 + 24
        if tile.avatars:
            for j, data in enumerate(tile.avatars):
                _avatar(card, data, (x0 + 52 + j * 40, y0 + tile_h // 2 + 8), 56, OUTLINE if j else None)
            draw = ImageDraw.Draw(card)
            tx = x0 + 52 + (len(tile.avatars) - 1) * 40 + 44
        width = x0 + tile_w - tx - 18
        draw.text((x0 + 24, y0 + 16), tile.label, font=load_font(15, bold=True), fill=accent)
        draw.text((tx, y0 + 46), fit_text(draw, tile.title or "—", load_font(22, bold=True), width),
                  font=load_font(22, bold=True), fill=TEXT)
        draw.text((tx, y0 + 78), fit_text(draw, tile.value, load_font(17), width), font=load_font(17), fill=MUTED)
    rows = (len(tiles) + 1) // 2
    return top + rows * (tile_h + gap) - gap


def render_server_card(
    kind: str, period_label: str, guild_name: str, mvp: Tile | None, podium: list[str], tiles: list[Tile], footer: str,
) -> Image.Image:
    theme = THEMES[kind]
    accent, accent2 = theme["accent"], theme["accent2"]
    rows = (len(tiles) + 1) // 2
    height = 150 + 190 + rows * 132 + 90
    card = _background(height, accent, accent2)
    draw = ImageDraw.Draw(card)

    draw.text((32, 34), theme["label"], font=load_font(18, bold=True), fill=accent)
    draw.text((32, 60), period_label, font=load_font(40, bold=True), fill=TEXT)
    draw.text((32, 110), fit_text(draw, clean_text(guild_name) or "Sunucu", load_font(18), W - 64),
              font=load_font(18), fill=MUTED)

    # MVP paneli
    y0 = 150
    draw_translucent(card, [((32, y0, W - 32, y0 + 170), 22, PANEL, OUTLINE)])
    if mvp is None:
        draw = ImageDraw.Draw(card)
        draw.text((W // 2, y0 + 85), "Bu dönem pek hareket olmadı.", font=load_font(24, bold=True), fill=MUTED, anchor="mm")
    else:
        _avatar(card, mvp.avatars[0] if mvp.avatars else None, (32 + 95, y0 + 85), 120, accent)
        draw = ImageDraw.Draw(card)
        draw.text((32 + 180, y0 + 36), mvp.label, font=load_font(16, bold=True), fill=accent)
        draw.text((32 + 180, y0 + 62), fit_text(draw, mvp.title, load_font(32, bold=True), 420),
                  font=load_font(32, bold=True), fill=TEXT)
        draw.text((32 + 180, y0 + 108), mvp.value, font=load_font(22, bold=True), fill=accent2)
        px = W - 32 - 300
        for i, line in enumerate(podium[:3], start=1):
            draw.text((px, y0 + 34 + (i - 1) * 40), f"{i + 1}.", font=load_font(20, bold=True), fill=MUTED)
            draw.text((px + 36, y0 + 34 + (i - 1) * 40), fit_text(draw, line, load_font(20), 250),
                      font=load_font(20), fill=TEXT)

    end = _tiles(card, tiles, y0 + 190, accent)
    draw = ImageDraw.Draw(card)
    draw.text((W // 2, end + 45), fit_text(draw, footer, load_font(18), W - 64), font=load_font(18), fill=MUTED, anchor="mm")
    draw.rounded_rectangle((6, 6, W - 7, height - 7), radius=20, outline=OUTLINE, width=2)
    return card


def render_personal_card(
    kind: str, period_label: str, name: str, avatar: bytes | None, xp_text: str, rank_text: str,
    persona_name: str, persona_desc: str, tiles: list[Tile], footer: str,
) -> Image.Image:
    theme = THEMES[kind]
    accent, accent2 = theme["accent"], theme["accent2"]
    rows = (len(tiles) + 1) // 2
    height = 300 + rows * 132 + 80
    card = _background(height, accent, accent2)
    _avatar(card, avatar, (32 + 80, 120), 150, accent)
    draw = ImageDraw.Draw(card)
    tx = 32 + 180
    draw.text((tx, 40), f"{theme['label']} · {period_label}".upper(), font=load_font(17, bold=True), fill=accent)
    draw.text((tx, 66), fit_text(draw, name, load_font(36, bold=True), W - tx - 32), font=load_font(36, bold=True), fill=TEXT)
    draw.text((tx, 118), xp_text, font=load_font(30, bold=True), fill=accent2)
    xw = int(text_width(draw, xp_text, load_font(30, bold=True)))
    draw.text((tx + xw + 16, 128), rank_text, font=load_font(19), fill=MUTED)

    # Kişilik etiketi
    py = 172
    draw_translucent(card, [((tx, py, W - 32, py + 76), 18, (*_rgb(accent), 40), accent)])
    draw = ImageDraw.Draw(card)
    draw.text((tx + 20, py + 12), "BU DÖNEMKİ HÂLİN", font=load_font(14, bold=True), fill=accent)
    draw.text((tx + 20, py + 34), persona_name, font=load_font(24, bold=True), fill=TEXT)
    pw = int(text_width(draw, persona_name, load_font(24, bold=True)))
    draw.text((tx + 36 + pw, py + 41), fit_text(draw, persona_desc, load_font(17), W - 32 - tx - pw - 60),
              font=load_font(17), fill=MUTED)

    end = _tiles(card, tiles, 280, accent)
    draw = ImageDraw.Draw(card)
    draw.text((W // 2, end + 40), fit_text(draw, footer, load_font(18), W - 64), font=load_font(18), fill=MUTED, anchor="mm")
    draw.rounded_rectangle((6, 6, W - 7, height - 7), radius=20, outline=OUTLINE, width=2)
    return card


def _rgb(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


# ---------------------------------------------------------------------------
# Durum (dönem başına bir paylaşım / kişi başına bir kullanım)
# ---------------------------------------------------------------------------

class SummaryState:
    def __init__(self, path: Path) -> None:
        self.path = path
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        self.posted: dict[str, str] = data.get("posted", {})
        self.used: dict[str, list[int]] = data.get("used", {})

    def save(self) -> None:
        # Yalnızca son birkaç dönemin kullanım kaydı tutulur
        self.used = dict(sorted(self.used.items())[-6:])
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"posted": self.posted, "used": self.used}, indent=2), encoding="utf-8")
        except OSError as exc:
            log.warning("Özet durumu kaydedilemedi: %s", exc)

    def was_posted(self, kind: str, key: str) -> bool:
        return self.posted.get(kind) == key

    def mark_posted(self, kind: str, key: str) -> None:
        self.posted[kind] = key
        self.save()

    def has_used(self, key: str, user_id: int) -> bool:
        return user_id in self.used.get(key, [])

    def mark_used(self, key: str, user_id: int) -> None:
        self.used.setdefault(key, []).append(user_id)
        self.save()


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class SummaryCog(commands.Cog):
    def __init__(self, bot: commands.Bot, state_path: Path = STATE_PATH) -> None:
        self.bot = bot
        self.state = SummaryState(state_path)
        self.roles = XPRoleManager()
        self._lock = asyncio.Lock()

    async def cog_load(self) -> None:
        self.post_loop.start()

    async def cog_unload(self) -> None:
        self.post_loop.cancel()

    # ------------------------------------------------------------------
    # Veri
    # ------------------------------------------------------------------

    async def _stats(self, guild: discord.Guild, period: Period) -> PeriodStats:
        await activitylog.flush()  # tampondaki son olaylar da sayılsın
        rows = await db.get_guild_events_between(
            guild.id, period.start.timestamp(), period.end.timestamp(), SUMMARY_EVENTS,
        )
        bots = {m.id for m in guild.members if m.bot}
        return compute(rows, VOICE_INTERVAL_SECONDS, bots=bots)

    @staticmethod
    def _name(guild: discord.Guild, user_id: int) -> str:
        return clean_display_name(guild.get_member(user_id), fallback=f"Ayrılmış üye {str(user_id)[-4:]}")

    async def _avatars(self, guild: discord.Guild, *user_ids: int) -> tuple[bytes | None, ...]:
        return tuple(await asyncio.gather(*(fetch_avatar_bytes(guild.get_member(u), 256) for u in user_ids)))

    async def _longest_streak(self, guild: discord.Guild) -> tuple[int, int] | None:
        best = None
        for row in await db.get_all_user_rows(guild.id):
            member = guild.get_member(row["user_id"])
            if member is None or member.bot:
                continue
            streak = db.current_streak(row)
            if streak and (best is None or streak > best[1]):
                best = (row["user_id"], streak)
        return best

    # ------------------------------------------------------------------
    # Sunucu kartı
    # ------------------------------------------------------------------

    async def build_server_card(self, guild: discord.Guild, period: Period):
        stats = await self._stats(guild, period)
        word = "HAFTANIN" if period.kind == "week" else "AYIN"
        ranking = top(stats.xp, 4)
        mvp = None
        if ranking:
            uid, xp = ranking[0]
            mvp = Tile(f"{word} MVP'Sİ", self._name(guild, uid), f"+{xp:,} XP".replace(",", "."),
                       await self._avatars(guild, uid))
        podium = [f"{self._name(guild, uid)} · {xp:,} XP".replace(",", ".") for uid, xp in ranking[1:4]]

        tiles: list[Tile] = []
        if voice := top(stats.voice_seconds):
            uid, sec = voice[0]
            tiles.append(Tile("SESTE EN ÇOK", self._name(guild, uid), format_hours(sec), await self._avatars(guild, uid)))
        else:
            tiles.append(Tile("SESTE EN ÇOK", "—", "Kimse seste buluşmadı"))
        if chat := top(stats.messages):
            uid, count = chat[0]
            tiles.append(Tile("EN ÇOK YAZAN", self._name(guild, uid), f"{count} mesaj", await self._avatars(guild, uid)))
        else:
            tiles.append(Tile("EN ÇOK YAZAN", "—", "Sessiz bir dönem"))
        if duo := top(stats.pairs):
            (a, b), sec = duo[0]
            tiles.append(Tile(f"{word} İKİLİSİ", f"{self._name(guild, a)} & {self._name(guild, b)}",
                              f"{format_hours(sec)} birlikte seste", await self._avatars(guild, a, b)))
        else:
            tiles.append(Tile(f"{word} İKİLİSİ", "—", "Seste ikili yok"))
        if streak := await self._longest_streak(guild):
            uid, days = streak
            tiles.append(Tile("EN UZUN SERİ", self._name(guild, uid), f"{days} gün üst üste", await self._avatars(guild, uid)))
        else:
            tiles.append(Tile("EN UZUN SERİ", "—", "Seri yok"))
        if night := top(stats.night_messages):
            uid, count = night[0]
            tiles.append(Tile("GECE KUŞU", self._name(guild, uid), f"00:00–05:00 arası {count} mesaj",
                              await self._avatars(guild, uid)))
        else:
            tiles.append(Tile("GECE KUŞU", "—", "Herkes erken yatmış"))
        leveled = top(stats.level_ups, 3)
        tiles.append(Tile(
            "SEVİYE ATLAYANLAR",
            ", ".join(self._name(guild, uid) for uid, _ in leveled) or "—",
            f"{sum(stats.level_ups.values())} kez seviye atlandı" if leveled else "Bu dönem seviye atlayan yok",
        ))

        total_msgs = sum(stats.messages.values())
        total_voice = sum(stats.voice_seconds.values())
        footer = f"{total_msgs:,} mesaj · {format_hours(total_voice)} ses · {len(stats.active_members)} aktif üye".replace(",", ".")
        if stats.guild_weekdays:
            day = top(stats.guild_weekdays)[0][0]
            hour = top(stats.guild_hours)[0][0]
            footer += f" · en hareketli: {WEEKDAYS[day]}, {hour_range(hour)}"
        card = await asyncio.to_thread(render_server_card, period.kind, period.label, guild.name, mvp, podium, tiles, footer)
        return await asyncio.to_thread(to_png, card)

    # ------------------------------------------------------------------
    # Kişisel kart
    # ------------------------------------------------------------------

    async def build_personal_card(self, member: discord.Member, period: Period):
        guild = member.guild
        stats = await self._stats(guild, period)
        uid = member.id
        if uid not in stats.active_members:
            return None

        gained = stats.xp.get(uid, 0)
        rank = stats.rank(uid)
        row = await db.get_user_row(guild.id, uid)
        total = int(row["total_xp"]) if row else 0
        level_now = self.roles.get_progress_data(total)[0]
        level_before = self.roles.get_progress_data(max(0, total - gained))[0]

        tiles = [
            Tile("MESAJ", f"{stats.messages.get(uid, 0)}", "komut hariç"),
            Tile("SES", format_hours(stats.voice_seconds.get(uid, 0)), "yanında biri varken"),
        ]
        if partner := top(stats.partners(uid)):
            pid, sec = partner[0]
            tiles.append(Tile("EN ÇOK TAKILDIĞIN", self._name(guild, pid), f"{format_hours(sec)} birlikte seste",
                              await self._avatars(guild, pid)))
        else:
            tiles.append(Tile("EN ÇOK TAKILDIĞIN", "—", "Seste kimseyle buluşmadın"))
        hours, days = stats.hours.get(uid), stats.weekdays.get(uid)
        tiles.append(Tile("EN AKTİF SAATİN", hour_range(top(hours)[0][0]) if hours else "—", "en çok yazdığın saat"))
        tiles.append(Tile("EN AKTİF GÜNÜN", WEEKDAYS[top(days)[0][0]] if days else "—", "en çok yazdığın gün"))
        tiles.append(Tile(
            "SEVİYE",
            f"Seviye {level_before} → {level_now}" if level_now > level_before else f"Seviye {level_now}",
            f"{level_now - level_before} seviye atladın" if level_now > level_before else "Bir sonrakine az kaldı",
        ))

        streak = db.current_streak(row) if row else 0
        exile = await db.get_exile(guild.id, uid)
        if exile is not None:
            streak = exile["streak_at_start"]
        footer = f"Toplam {total:,} XP · Seri: {streak} gün".replace(",", ".")
        name_persona, desc = persona(stats, uid)
        rank_text = f"sunucuda {rank}." if rank else ""
        card = await asyncio.to_thread(
            render_personal_card, period.kind, period.label, clean_display_name(member),
            (await self._avatars(guild, uid))[0], f"+{gained:,} XP".replace(",", "."), rank_text,
            name_persona, desc, tiles, footer,
        )
        return await asyncio.to_thread(to_png, card)

    # ------------------------------------------------------------------
    # Komutlar
    # ------------------------------------------------------------------

    async def _personal(self, ctx: commands.Context, kind: str) -> None:
        now = now_local()
        if kind == "week":
            available, period = is_week_end(now.date()), week_period(now)
            when = "Haftalık özet sadece **pazar** günleri açılır."
            nxt = (now + datetime.timedelta(days=6 - now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        else:
            available, period = is_month_end(now.date()), month_period(now)
            when = "Wrapped sadece **ayın son günü** açılır."
            first_next = (now.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
            nxt = (first_next - datetime.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        if not available:
            await ctx.send(f"📅 {when} Bir sonraki: <t:{int(nxt.timestamp())}:F> (<t:{int(nxt.timestamp())}:R>)")
            return
        key = f"{period.key}:{ctx.guild.id}"
        if self.state.has_used(key, ctx.author.id):
            word = "haftanın" if kind == "week" else "ayın"
            await ctx.send(f"🗓️ Bu {word} kartını zaten aldın, yukarıda bir yerde duruyor.")
            return
        async with ctx.typing():
            buf = await self.build_personal_card(ctx.author, period)
        if buf is None:
            await ctx.send("👀 Bu dönem pek ortalarda yoktun; gösterecek bir şey birikmedi.")
            return
        self.state.mark_used(key, ctx.author.id)
        name = "haftalik" if kind == "week" else "wrapped"
        await ctx.send(file=discord.File(buf, filename=f"{name}.png"))

    @commands.command(name="haftalik", aliases=["haftalık", "haftaliközet", "haftalikozet", "weekly"])
    @commands.guild_only()
    async def weekly_command(self, ctx: commands.Context) -> None:
        """Kişisel haftalık özet kartı (yalnızca pazar, haftada bir kez)."""
        await self._personal(ctx, "week")

    @commands.command(name="wrapped", aliases=["aylik", "aylık", "aylıközet", "aylikozet"])
    @commands.guild_only()
    async def wrapped_command(self, ctx: commands.Context) -> None:
        """Kişisel aylık Wrapped kartı (yalnızca ayın son günü, ayda bir kez)."""
        await self._personal(ctx, "month")

    # ------------------------------------------------------------------
    # Otomatik paylaşım
    # ------------------------------------------------------------------

    def _channel(self) -> discord.abc.Messageable | None:
        channel_id = SUMMARY_CHANNEL_ID or ANNOUNCE_CHANNEL_ID
        return self.bot.get_channel(channel_id) if channel_id else None

    async def post_due(self, now: datetime.datetime | None = None) -> list[str]:
        """
        Zamanı gelmiş ve henüz işlenmemiş dönemler için ödülleri (başarımlar) kaydeder ve kanal
        ayarlıysa özet kartını gönderir. Döner: işlenen türler.
        """
        now = now or now_local()
        if now.hour < POST_HOUR:
            return []
        channel = self._channel()
        if channel is not None and getattr(channel, "guild", None) is not None:
            guilds = [channel.guild]
        else:
            channel, guilds = None, list(getattr(self.bot, "guilds", []))
        if not guilds:
            return []
        sent: list[str] = []
        async with self._lock:
            for kind, due, period in (
                ("week", is_week_end(now.date()), week_period(now)),
                ("month", is_month_end(now.date()), month_period(now)),
            ):
                if not due or self.state.was_posted(kind, period.key):
                    continue
                for guild in guilds:
                    await db.add_summary_awards(
                        guild.id, f"{kind}:{period.key}", period_awards(await self._stats(guild, period), kind),
                    )
                if channel is None:
                    self.state.mark_posted(kind, period.key)
                    sent.append(kind)
                    continue
                try:
                    buf = await self.build_server_card(channel.guild, period)
                    title = (f"📊 **Haftanın özeti** · {period.label}" if kind == "week"
                             else f"🎁 **{period.label} Wrapped**")
                    hint = ("Kendi kartın için bugün `!haftalik` yaz." if kind == "week"
                            else "Kendi Wrapped'ın için bugün `!wrapped` yaz.")
                    await channel.send(f"{title}\n{hint}", file=discord.File(buf, filename=f"{kind}.png"))
                except discord.HTTPException:
                    log.exception("Özet gönderilemedi (%s)", kind)
                    continue
                self.state.mark_posted(kind, period.key)
                sent.append(kind)
                log.info("%s özeti paylaşıldı: %s", kind, period.key)
        return sent

    @tasks.loop(minutes=5)
    async def post_loop(self) -> None:
        try:
            await self.post_due()
        except Exception:
            log.exception("Özet paylaşım döngüsü hatası")

    @post_loop.before_loop
    async def _before_post(self) -> None:
        await self.bot.wait_until_ready()
