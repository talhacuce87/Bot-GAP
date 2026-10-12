"""
bestfriend.py — Ortak ses süresine göre best friend / arkadaşlık tier sistemi.

Mantık:
- Bot, ses kanallarını her dakika tarar (AFK kanalı hariç).
- Aynı kanalda bulunan her geçerli (bot değil, sağırlaştırılmamış) kullanıcı
  çifti için ortak süre yazılır.
- Her çiftin ortak süresi bir arkadaşlık tier'ı belirler (FRIEND_TIERS).
- !bf         → en çok vakit geçirilen kişiyle olan tier kartı
- !arkadaslar → en çok vakit geçirilen 10 kişinin tier listesi (görsel)
- !tierlar    → tüm tier'lar ve eşikleri
"""

from __future__ import annotations

import asyncio
import io
import logging
import math
from dataclasses import dataclass
from typing import Final

import discord
from discord.ext import commands, tasks
from PIL import Image, ImageDraw, ImageFilter

import cardutils as cu
import database as dbmod
from font_utils import clean_display_name, clean_text

log = logging.getLogger("gap.bestfriend")

TRACK_INTERVAL_SECONDS: Final[int] = 60


# ---------------------------------------------------------------------------
# Tier'lar
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FriendTier:
    name: str
    hours: int
    color: str
    emoji: str

    @property
    def seconds(self) -> int:
        return self.hours * 3600


# Eşikler artan sırada olmalı.
FRIEND_TIERS: Final[tuple[FriendTier, ...]] = (
    FriendTier("Tanıdık",       5,   "#A7B4C6", "🌱"),
    FriendTier("Arkadaş",       20,  "#6FCF97", "🤝"),
    FriendTier("Yakın Arkadaş", 50,  "#56CCF2", "💙"),
    FriendTier("Best Friend",   100, "#FF8FB1", "💞"),
    FriendTier("Kanka",         250, "#FFB86C", "🔥"),
    FriendTier("Ruh İkizi",     500, "#FFD700", "👑"),
)
NO_TIER_COLOR: Final[str] = "#8EA0BC"

# Best Friend tier'ının eşiği (ai/cog.py bu sabiti kullanır)
BEST_FRIEND_THRESHOLD_SECONDS: Final[int] = next(t for t in FRIEND_TIERS if t.name == "Best Friend").seconds


@dataclass(frozen=True)
class TierInfo:
    current: FriendTier | None
    next: FriendTier | None
    level: int        # 0 = tier yok, 1..len(FRIEND_TIERS)
    ratio: float      # mevcut tier'dan sonrakine ilerleme (0-1)
    remaining: int    # sonraki tier'a kalan saniye (max tier'da 0)

    @property
    def color(self) -> str:
        return self.current.color if self.current else NO_TIER_COLOR

    @property
    def label(self) -> str:
        return self.current.name if self.current else "Tier yok"


def get_tier_info(shared_seconds: int) -> TierInfo:
    current: FriendTier | None = None
    level = 0
    for i, tier in enumerate(FRIEND_TIERS):
        if shared_seconds >= tier.seconds:
            current, level = tier, i + 1
    nxt = FRIEND_TIERS[level] if level < len(FRIEND_TIERS) else None

    if nxt is None:
        return TierInfo(current, None, level, 1.0, 0)
    floor = current.seconds if current else 0
    ratio = (shared_seconds - floor) / max(1, nxt.seconds - floor)
    return TierInfo(current, nxt, level, max(0.0, min(1.0, ratio)), max(0, nxt.seconds - shared_seconds))


def format_duration(total_seconds: int) -> str:
    total_seconds = max(0, int(total_seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, _ = divmod(remainder, 60)
    if hours >= 1000:
        return f"{hours:,} saat"
    if hours:
        return f"{hours}sa {minutes}dk"
    return f"{minutes}dk"


def _is_valid_voice_member(member: discord.Member) -> bool:
    voice_state = member.voice
    if member.bot or voice_state is None or voice_state.channel is None:
        return False
    return not (voice_state.self_deaf or voice_state.deaf)


# ---------------------------------------------------------------------------
# !bf kartı (thread'de çalışır)
# ---------------------------------------------------------------------------

CARD_WIDTH: Final[int] = 1080
CARD_HEIGHT: Final[int] = 600
SS: Final[int] = 2                     # Kenarlar pürüzsüz olsun diye 2x çizilip küçültülür
AVATAR_SIZE: Final[int] = 170
LEFT_CENTER: Final[tuple[int, int]] = (250, 210)
RIGHT_CENTER: Final[tuple[int, int]] = (830, 210)
BADGE_RADIUS: Final[int] = 44
NAME_MAX_WIDTH: Final[int] = 230
LADDER_Y: Final[int] = 466
LADDER_START_X: Final[int] = 110
LADDER_FIRST_X: Final[int] = 230
LADDER_END_X: Final[int] = 960

THEME: dict[str, object] = {
    "background": "#0A0F1C",
    "badge_fill": "#0E1424",
    "glass_fill": (255, 255, 255, 9),
    "glass_outline": "#FFFFFF26",
    "track": "#222C42",
    "node_empty": "#121A2B",
    "node_empty_outline": "#3A4762",
    "accent": "#7DF3E1",
    "text_primary": "#F8FAFD",
    "text_secondary": "#C6D0E3",
    "text_muted": "#8EA0BC",
    "text_dark": "#14171F",
    "bar_bg": "#20304F",
    "row_odd": (11, 22, 44, 200),
    "row_even": (8, 16, 34, 200),
    "row_outline": "#233252",
    "shadow": "#05080F",
}


@dataclass(frozen=True)
class _CardData:
    left_name: str
    left_username: str
    right_name: str
    right_username: str | None
    left_avatar: bytes | None
    right_avatar: bytes | None
    shared_seconds: int
    has_partner: bool


def _mix(c1: str, c2: str, t: float) -> str:
    a, b = cu.hex_to_rgba(c1), cu.hex_to_rgba(c2)
    return "#" + "".join(f"{int(a[i] + (b[i] - a[i]) * t):02X}" for i in range(3))


def _soft_glow(card: Image.Image, center: tuple[int, int], radius: int, color: str, alpha: int, blur: int) -> None:
    """Küçük bir katmanda bulanıklaştırılıp büyütülen yumuşak ışık lekesi."""
    k = 8
    w, h = card.size
    rgb = cu.hex_to_rgba(color)[:3]
    layer = Image.new("RGBA", (w // k, h // k), (*rgb, 0))
    x, y = center
    ImageDraw.Draw(layer).ellipse(
        ((x - radius) / k, (y - radius) / k, (x + radius) / k, (y + radius) / k),
        fill=(*rgb, alpha),
    )
    layer = layer.filter(ImageFilter.GaussianBlur(blur / k)).resize((w, h), Image.Resampling.BICUBIC)
    card.alpha_composite(layer)


def _dot_grid(card: Image.Image, step: int, radius: float, alpha: int) -> None:
    layer = Image.new("RGBA", card.size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(layer)
    w, h = card.size
    for y in range(step // 2, h, step):
        for x in range(step // 2, w, step):
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(255, 255, 255, alpha))
    card.alpha_composite(layer)


def _gradient_bar(card: Image.Image, box: tuple[int, int, int, int], start: str, end: str) -> None:
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return
    grad = cu.h_gradient(w, h, start, end)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=255)
    card.paste(grad, (x0, y0), mask)


def _heart(draw: ImageDraw.ImageDraw, cx: float, cy: float, a: float, fill: str) -> None:
    """Genişliği 4a olan kalp; iki daire + teğet noktalarından geçen üçgen."""
    tip = (cx, cy + 1.9 * a)
    points = []
    for side in (-1, 1):
        c = (cx + side * a, cy - 0.5 * a)
        draw.ellipse((c[0] - a, c[1] - a, c[0] + a, c[1] + a), fill=fill)
        dx, dy = tip[0] - c[0], tip[1] - c[1]
        d = math.hypot(dx, dy)
        ang = math.atan2(dy, dx) - side * math.acos(a / d)
        points.append(((c[0] + a * math.cos(ang), c[1] + a * math.sin(ang)), c))
    (t_left, c_left), (t_right, c_right) = points
    draw.polygon([t_left, c_left, c_right, t_right, tip], fill=fill)


def _spaced_text(draw: ImageDraw.ImageDraw, center: tuple[int, int], text: str, font, fill: str, spacing: float) -> None:
    widths = [draw.textlength(ch, font=font) for ch in text]
    x = center[0] - (sum(widths) + spacing * (len(text) - 1)) / 2
    for ch, w in zip(text, widths):
        draw.text((x, center[1]), ch, font=font, fill=fill, anchor="lm")
        x += w + spacing


def _rich_line(draw: ImageDraw.ImageDraw, center: tuple[int, int], parts: list[tuple[str, object, str]]) -> None:
    """Farklı renk/fontlardaki parçaları tek satırda ortalar."""
    total = sum(draw.textlength(text, font=font) for text, font, _ in parts)
    x = center[0] - total / 2
    for text, font, fill in parts:
        draw.text((x, center[1]), text, font=font, fill=fill, anchor="lm")
        x += draw.textlength(text, font=font)


def _render_card(d: _CardData) -> io.BytesIO:
    info = get_tier_info(d.shared_seconds)
    tier_color = info.color
    accent = str(THEME["accent"])
    tp, ts, tm = str(THEME["text_primary"]), str(THEME["text_secondary"]), str(THEME["text_muted"])
    sh = str(THEME["shadow"])

    def s(v: float) -> int:
        return int(round(v * SS))

    def font(size: int, bold: bool = False):
        return cu.load_font(size * SS, bold=bold)

    W, H = CARD_WIDTH * SS, CARD_HEIGHT * SS
    R = AVATAR_SIZE // 2
    mid_x = CARD_WIDTH // 2
    cy = LEFT_CENTER[1]

    # --- Arka plan: tier rengine kayan gradient + yumuşak ışıklar + nokta dokusu
    bg = str(THEME["background"])
    card = cu.h_gradient(W, H, _mix(bg, accent, 0.05), _mix(bg, tier_color, 0.11))
    _soft_glow(card, (s(LEFT_CENTER[0]), s(cy)), s(R + 40), accent, 95, s(70))
    _soft_glow(card, (s(RIGHT_CENTER[0]), s(cy)), s(R + 40), tier_color, 100, s(70))
    _soft_glow(card, (s(mid_x), s(cy + 20)), s(150), tier_color, 40, s(80))
    _dot_grid(card, s(26), SS * 1.1, 14)
    cu.draw_translucent(
        card,
        [((s(24), s(24), W - s(24), H - s(24)), s(36), THEME["glass_fill"], str(THEME["glass_outline"]))],
        outline_width=s(2),
    )

    draw = ImageDraw.Draw(card)
    _spaced_text(draw, (s(mid_x), s(62)), "BEST FRIEND TRACKER", font(15, bold=True), tm, s(4))

    # --- İki avatarı bağlayan çizgi (rozet üstüne çizilecek)
    _gradient_bar(
        card,
        (s(LEFT_CENTER[0] + R + 20), s(cy - 2), s(RIGHT_CENTER[0] - R - 20), s(cy + 2)),
        accent, tier_color,
    )

    # --- Avatarlar + halkalar
    for (cx, _), data, ring in (
        (LEFT_CENTER, d.left_avatar, accent),
        (RIGHT_CENTER, d.right_avatar, tier_color),
    ):
        avatar = cu.circle_avatar(data, s(AVATAR_SIZE))
        card.paste(avatar, (s(cx - R), s(cy - R)), avatar)
        draw.ellipse((s(cx - R - 10), s(cy - R - 10), s(cx + R + 10), s(cy + R + 10)), outline=ring, width=s(5))
    if not d.has_partner:
        draw.text((s(RIGHT_CENTER[0]), s(cy)), "?", font=font(72, bold=True), fill=tm, anchor="mm")

    # --- Ortadaki kalp rozeti
    b = BADGE_RADIUS
    draw.ellipse((s(mid_x - b), s(cy - b), s(mid_x + b), s(cy + b)),
                 fill=str(THEME["badge_fill"]), outline=tier_color, width=s(4))
    _heart(draw, s(mid_x), s(cy - 3), s(12.5), tier_color)

    # --- İsimler
    f_name, f_user = font(28, bold=True), font(17)
    for (cx, _), name, username in (
        (LEFT_CENTER, d.left_name, d.left_username),
        (RIGHT_CENTER, d.right_name, d.right_username),
    ):
        cu.draw_text(draw, (s(cx), s(330)), cu.fit_text(draw, name, f_name, s(NAME_MAX_WIDTH)),
                     f_name, tp, sh, anchor="mm")
        if username:
            draw.text((s(cx), s(362)), cu.fit_text(draw, f"@{username}", f_user, s(NAME_MAX_WIDTH)),
                      font=f_user, fill=tm, anchor="mm")

    # --- Tier adı + özet
    f_tier = cu.fitted_font(draw, info.label, 42 * SS, s(330), 24 * SS, bold=True)
    cu.draw_text(draw, (s(mid_x), s(300)), info.label, f_tier, tier_color, sh, anchor="mm")
    summary = f"Tier {info.level} / {len(FRIEND_TIERS)}  ·  {format_duration(d.shared_seconds)} birlikte"
    draw.text((s(mid_x), s(342)), summary, font=font(17), fill=ts, anchor="mm")

    # --- Sonraki tier satırı
    f_line, f_line_b = font(18), font(18, bold=True)
    if not d.has_partner:
        parts = [("Biriyle seste vakit geçir, ilk tier ", f_line, ts),
                 (f"{FRIEND_TIERS[0].hours} saatte", f_line_b, FRIEND_TIERS[0].color), (" açılır", f_line, ts)]
    elif info.next is None:
        parts = [("Maksimum tier'a ulaştınız", f_line_b, tier_color)]
    else:
        parts = [("Sonraki tier ", f_line, ts), (info.next.name, f_line_b, info.next.color),
                 (f"  ·  {format_duration(info.remaining)} kaldı", f_line, ts)]
    _rich_line(draw, (s(mid_x), s(412)), parts)

    # --- Tier merdiveni
    step = (LADDER_END_X - LADDER_FIRST_X) / (len(FRIEND_TIERS) - 1)
    xs = [LADDER_START_X] + [LADDER_FIRST_X + i * step for i in range(len(FRIEND_TIERS))]
    if info.level >= len(FRIEND_TIERS):
        progress_x = xs[-1]
    else:
        progress_x = xs[info.level] + info.ratio * (xs[info.level + 1] - xs[info.level])

    ly = LADDER_Y
    draw.rounded_rectangle((s(LADDER_START_X), s(ly - 3), s(LADDER_END_X), s(ly + 3)),
                           radius=s(3), fill=str(THEME["track"]))
    _gradient_bar(card, (s(LADDER_START_X), s(ly - 3), s(progress_x), s(ly + 3)), accent, tier_color)
    draw.ellipse((s(LADDER_START_X - 5), s(ly - 5), s(LADDER_START_X + 5), s(ly + 5)), fill=accent)

    f_node, f_node_b, f_hours = font(15), font(15, bold=True), font(13)
    for i, tier in enumerate(FRIEND_TIERS):
        x = xs[i + 1]
        reached = i < info.level
        current = i == info.level - 1
        if current:
            draw.ellipse((s(x - 17), s(ly - 17), s(x + 17), s(ly + 17)), outline=tier.color, width=s(3))
        if reached:
            draw.ellipse((s(x - 10), s(ly - 10), s(x + 10), s(ly + 10)), fill=tier.color)
        else:
            draw.ellipse((s(x - 9), s(ly - 9), s(x + 9), s(ly + 9)),
                         fill=str(THEME["node_empty"]), outline=str(THEME["node_empty_outline"]), width=s(3))
        label_color = tier.color if current else (tp if reached else tm)
        draw.text((s(x), s(ly + 34)), tier.name, font=f_node_b if current else f_node, fill=label_color, anchor="mm")
        draw.text((s(x), s(ly + 55)), f"{tier.hours} saat", font=f_hours, fill=tm, anchor="mm")

    return cu.to_png(card.resize((CARD_WIDTH, CARD_HEIGHT), Image.Resampling.LANCZOS))


# ---------------------------------------------------------------------------
# !arkadaslar listesi (thread'de çalışır)
# ---------------------------------------------------------------------------

LIST_W: Final[int] = 860
LIST_HEADER_H: Final[int] = 96
LIST_ROW_H: Final[int] = 100
LIST_AVATAR: Final[int] = 72
LIST_BAR_W: Final[int] = 180
LIST_BAR_H: Final[int] = 10


@dataclass(frozen=True)
class _ListEntry:
    name: str
    avatar: bytes | None
    shared_seconds: int


def _render_list(owner_name: str, owner_avatar: bytes | None, entries: list[_ListEntry]) -> io.BytesIO:
    total_h = LIST_HEADER_H + len(entries) * LIST_ROW_H + 20
    canvas = Image.new("RGBA", (LIST_W, total_h))
    draw = ImageDraw.Draw(canvas)

    for y in range(total_h):
        t = y / max(1, total_h - 1)
        draw.line([(0, y), (LIST_W, y)], fill=(int(14 + t * 2), int(18 + t * 30), int(33 + t * 20), 255))

    # Başlık: sahibin avatarı + isim
    sh = str(THEME["shadow"])
    tp = str(THEME["text_primary"])
    ts = str(THEME["text_secondary"])
    f_title = cu.load_font(30, bold=True)
    f_sub = cu.load_font(16)

    head_avatar = cu.circle_avatar(owner_avatar, 56)
    canvas.paste(head_avatar, (28, 18), head_avatar)
    draw.ellipse((26, 16, 86, 76), outline=str(THEME["accent"]), width=2)
    cu.draw_text(draw, (100, 34), "Arkadaş Listesi", f_title, tp, sh, anchor="lm")
    cu.draw_text(draw, (100, 64), cu.fit_text(draw, owner_name, f_sub, LIST_W - 140), f_sub, ts, None, anchor="lm")
    draw.line([(24, LIST_HEADER_H - 6), (LIST_W - 24, LIST_HEADER_H - 6)], fill=str(THEME["row_outline"]), width=2)

    cu.draw_translucent(canvas, [
        ((10, LIST_HEADER_H + i * LIST_ROW_H + 4, LIST_W - 10, LIST_HEADER_H + (i + 1) * LIST_ROW_H - 4),
         14, THEME["row_odd"] if i % 2 == 0 else THEME["row_even"], str(THEME["row_outline"]))
        for i in range(len(entries))
    ], outline_width=1)
    draw = ImageDraw.Draw(canvas)

    f_rank = cu.load_font(22, bold=True)
    f_name = cu.load_font(20, bold=True)
    f_pill = cu.load_font(14, bold=True)
    f_time = cu.load_font(18, bold=True)
    f_hint = cu.load_font(13)

    for i, entry in enumerate(entries):
        info = get_tier_info(entry.shared_seconds)
        y0 = LIST_HEADER_H + i * LIST_ROW_H
        cy = y0 + LIST_ROW_H // 2

        draw.text((50, cy), str(i + 1), font=f_rank, fill=str(THEME["text_muted"]), anchor="mm")

        ax, ay = 78, cy - LIST_AVATAR // 2
        avatar = cu.circle_avatar(entry.avatar, LIST_AVATAR)
        canvas.paste(avatar, (ax, ay), avatar)
        draw.ellipse((ax - 3, ay - 3, ax + LIST_AVATAR + 3, ay + LIST_AVATAR + 3), outline=info.color, width=3)

        # İsim + tier rozeti
        tx = ax + LIST_AVATAR + 16
        name = cu.fit_text(draw, entry.name, f_name, LIST_W - LIST_BAR_W - 60 - tx)
        draw.text((tx, cy - 14), name, font=f_name, fill=tp, anchor="lm")
        pill_w = int(cu.text_width(draw, info.label, f_pill)) + 20
        draw.rounded_rectangle((tx, cy + 4, tx + pill_w, cy + 26), radius=11, fill=info.color)
        draw.text((tx + pill_w // 2, cy + 15), info.label, font=f_pill, fill=str(THEME["text_dark"]), anchor="mm")

        # Sağ: süre + sonraki tier'a ilerleme
        right = LIST_W - 28
        bar_x0 = right - LIST_BAR_W
        draw.text((right, cy - 18), format_duration(entry.shared_seconds), font=f_time, fill=tp, anchor="rm")
        bar_y0 = cy + 2
        draw.rounded_rectangle((bar_x0, bar_y0, right, bar_y0 + LIST_BAR_H), radius=LIST_BAR_H // 2,
                               fill=str(THEME["bar_bg"]))
        if info.ratio > 0:
            fill_w = max(LIST_BAR_H, int(LIST_BAR_W * info.ratio))
            draw.rounded_rectangle((bar_x0, bar_y0, bar_x0 + fill_w, bar_y0 + LIST_BAR_H),
                                   radius=LIST_BAR_H // 2, fill=info.next.color if info.next else info.color)
        hint = f"{info.next.name} için {format_duration(info.remaining)}" if info.next else "Maksimum tier"
        draw.text((right, bar_y0 + LIST_BAR_H + 14), hint, font=f_hint, fill=str(THEME["text_muted"]), anchor="rm")

    draw.rounded_rectangle((4, 4, LIST_W - 4, total_h - 4), radius=20, outline=str(THEME["row_outline"]), width=2)
    return cu.to_png(canvas)


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class BestFriendCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    async def cog_load(self) -> None:
        if not self.voice_pair_loop.is_running():
            self.voice_pair_loop.start()

    async def cog_unload(self) -> None:
        self.voice_pair_loop.cancel()

    @staticmethod
    async def _resolve_friends(member: discord.Member, limit: int) -> list[tuple[discord.Member, int]]:
        """Sunucuda hâlâ bulunan, en çok vakit geçirilen kişiler (çoktan aza)."""
        rows = await dbmod.get_bestfriend_rows(member.guild.id, member.id, limit=limit + 40)
        friends: list[tuple[discord.Member, int]] = []
        for row in rows:
            partner = member.guild.get_member(int(row["partner_id"]))
            if partner is not None and not partner.bot:
                friends.append((partner, int(row["shared_seconds"])))
                if len(friends) >= limit:
                    break
        return friends

    async def build_card(self, member: discord.Member) -> io.BytesIO:
        friends = await self._resolve_friends(member, limit=1)
        partner, shared_seconds = friends[0] if friends else (None, 0)
        left_avatar, right_avatar = await asyncio.gather(
            cu.fetch_avatar_bytes(member),
            cu.fetch_avatar_bytes(partner),
        )
        data = _CardData(
            left_name=clean_display_name(member),
            left_username=clean_text(member.name),
            right_name=clean_display_name(partner) if partner else "Henüz yok",
            right_username=clean_text(partner.name) if partner else None,
            left_avatar=left_avatar,
            right_avatar=right_avatar,
            shared_seconds=shared_seconds,
            has_partner=partner is not None,
        )
        return await asyncio.to_thread(_render_card, data)

    async def build_friend_list(self, member: discord.Member, limit: int = 10) -> io.BytesIO | None:
        friends = await self._resolve_friends(member, limit=limit)
        if not friends:
            return None
        avatars = await asyncio.gather(
            cu.fetch_avatar_bytes(member, size=128),
            *(cu.fetch_avatar_bytes(f, size=128) for f, _ in friends),
        )
        entries = [
            _ListEntry(name=clean_display_name(friend), avatar=avatar, shared_seconds=seconds)
            for (friend, seconds), avatar in zip(friends, avatars[1:])
        ]
        return await asyncio.to_thread(_render_list, clean_display_name(member), avatars[0], entries)

    @tasks.loop(seconds=TRACK_INTERVAL_SECONDS)
    async def voice_pair_loop(self) -> None:
        for guild in self.bot.guilds:
            for channel in (*guild.voice_channels, *guild.stage_channels):
                if channel == guild.afk_channel:
                    continue
                valid_ids = [m.id for m in channel.members if _is_valid_voice_member(m)]
                if len(valid_ids) < 2:
                    continue
                try:
                    await dbmod.add_pair_voice_seconds_bulk(guild.id, valid_ids, TRACK_INTERVAL_SECONDS)
                except Exception:
                    log.exception("Best friend süresi yazılamadı (guild=%s, kanal=%s)", guild.id, channel.id)

    @voice_pair_loop.before_loop
    async def _before_voice_pair_loop(self) -> None:
        await self.bot.wait_until_ready()

    # ------------------------------------------------------------------
    # Komutlar
    # ------------------------------------------------------------------

    @commands.command(name="bf", usage="[@kullanıcı]")
    @commands.guild_only()
    async def bf_command(self, ctx: commands.Context, member: discord.Member | None = None) -> None:
        target = member or ctx.author
        if not isinstance(target, discord.Member):
            await ctx.send("Kullanıcı bilgisi alınamadı.")
            return

        async with ctx.typing():
            try:
                buf = await self.build_card(target)
            except Exception:
                log.exception("Best friend kartı oluşturulamadı (üye=%s)", target.id)
                await ctx.send("❌ Best friend kartı oluşturulamadı, lütfen tekrar dene.")
                return

        await ctx.send(file=discord.File(buf, filename=f"bf-{target.id}.png"))

    @commands.command(
        name="arkadaslar",
        aliases=["arkadaşlar", "fl", "friends", "friendlist"],
        usage="[@kullanıcı]",
    )
    @commands.guild_only()
    async def friend_list_command(self, ctx: commands.Context, member: discord.Member | None = None) -> None:
        target = member or ctx.author
        if not isinstance(target, discord.Member):
            await ctx.send("Kullanıcı bilgisi alınamadı.")
            return

        async with ctx.typing():
            try:
                buf = await self.build_friend_list(target)
            except Exception:
                log.exception("Arkadaş listesi oluşturulamadı (üye=%s)", target.id)
                await ctx.send("❌ Arkadaş listesi oluşturulamadı, lütfen tekrar dene.")
                return

        if buf is None:
            who = "Senin" if target == ctx.author else f"**{target.display_name}** kullanıcısının"
            await ctx.send(f"{who} henüz kimseyle ortak ses süresi yok.")
            return
        await ctx.send(file=discord.File(buf, filename=f"arkadaslar-{target.id}.png"))

    @commands.command(name="tierlar", aliases=["tiers", "bftier"])
    async def tiers_command(self, ctx: commands.Context) -> None:
        lines = [
            f"{tier.emoji} **{tier.name}** — {tier.hours} saat ortak ses"
            for tier in FRIEND_TIERS
        ]
        embed = discord.Embed(
            title="Arkadaşlık Tier'ları",
            description="\n".join(lines),
            color=discord.Color.from_str(FRIEND_TIERS[3].color),
        )
        embed.set_footer(text="Aynı ses kanalında geçirilen süre sayılır (AFK ve sağırlaştırılmış hariç).")
        await ctx.send(embed=embed)
