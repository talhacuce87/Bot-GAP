"""
leaderboard.py — !liderlik komutu için Pillow tabanlı sıralama kartı.

İlk 10 kullanıcıyı, XP'lerini, seviyelerini ve avatarlarını
tek bir görselde gösterir.
"""

from __future__ import annotations

import asyncio
import io
from pathlib import Path

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont, ImageOps

import database as dbmod
from xp import XPTrackerCog
from usercard import _load_font

# ---------------------------------------------------------------------------
# Boyutlar
# ---------------------------------------------------------------------------

CARD_W = 860
CARD_H = 100          # Her satır yüksekliği
HEADER_H = 80
AVATAR_R = 36         # Yarıçap
ROW_PADDING = 16
BAR_H = 10

MEDAL_COLORS = ["#FFD700", "#C0C0C0", "#CD7F32"]  # Altın, gümüş, bronz

BG_COLOR = "#0A1424"
ROW_ODD  = (11, 22, 44, 200)
ROW_EVEN = (8, 16, 34, 200)
OUTLINE  = "#233252"
ACCENT   = "#58E1C1"
TEXT_PRIMARY   = "#F5F7FB"
TEXT_SECONDARY = "#8EA0BC"
BAR_BG   = "#17233D"
BAR_FILL = "#47D7C3"
SHADOW   = "#050C1A"


# ---------------------------------------------------------------------------
# Yardımcı
# ---------------------------------------------------------------------------

def _hex_rgba(color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), alpha


async def _fetch_avatar_small(member: discord.Member | None, size: int = 72) -> Image.Image | None:
    if member is None:
        return None
    try:
        data = await member.display_avatar.replace(size=128, format="png").read()
        img = Image.open(io.BytesIO(data)).convert("RGBA")
        img = ImageOps.fit(img, (size, size), centering=(0.5, 0.5))
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
        img.putalpha(mask)
        return img
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Kart üretici
# ---------------------------------------------------------------------------

async def build_leaderboard_card(
    guild: discord.Guild,
    rows: list,
    xp_tracker: XPTrackerCog,
) -> io.BytesIO:
    count = len(rows)
    total_h = HEADER_H + count * CARD_H + 20

    canvas = Image.new("RGBA", (CARD_W, total_h), BG_COLOR)
    draw = ImageDraw.Draw(canvas)

    # Hafif gradient arka plan
    for y in range(total_h):
        t = y / max(1, total_h - 1)
        r = int(10 + t * 6)
        g = int(20 + t * 8)
        b = int(36 + t * 15)
        draw.line([(0, y), (CARD_W, y)], fill=(r, g, b, 255))

    # Başlık
    f_title = _load_font(32, bold=True)
    f_sub   = _load_font(16)
    draw.text((CARD_W // 2, 24), "🏆  XP Sıralaması", font=f_title,
              fill=TEXT_PRIMARY, anchor="mm")
    draw.text((CARD_W // 2, 58), guild.name, font=f_sub,
              fill=TEXT_SECONDARY, anchor="mm")
    draw.line([(30, HEADER_H - 4), (CARD_W - 30, HEADER_H - 4)],
              fill=OUTLINE, width=2)

    f_rank  = _load_font(22, bold=True)
    f_name  = _load_font(20, bold=True)
    f_xp    = _load_font(17)
    f_level = _load_font(14)

    # Avatar'ları paralel çek
    members = [guild.get_member(row["user_id"]) for row in rows]
    avatars = await asyncio.gather(*[_fetch_avatar_small(m, size=AVATAR_R * 2) for m in members])

    for i, (row, member, avatar) in enumerate(zip(rows, members, avatars)):
        y0 = HEADER_H + i * CARD_H
        y1 = y0 + CARD_H

        # Satır arka planı
        row_color = ROW_ODD if i % 2 == 0 else ROW_EVEN
        draw.rounded_rectangle(
            (10, y0 + 4, CARD_W - 10, y1 - 4),
            radius=14, fill=row_color, outline=OUTLINE, width=1,
        )

        cx = 26  # sol kenar imleci

        # Sıra numarası / madalya
        rank_num = i + 1
        if rank_num <= 3:
            rank_str = ["🥇", "🥈", "🥉"][rank_num - 1]
        else:
            rank_str = str(rank_num)

        draw.text((cx + 24, y0 + CARD_H // 2), rank_str, font=f_rank,
                  fill=MEDAL_COLORS[i] if i < 3 else TEXT_SECONDARY, anchor="mm")
        cx += 52

        # Avatar
        if avatar:
            ax = cx
            ay = y0 + CARD_H // 2 - AVATAR_R
            canvas.paste(avatar, (ax, ay), avatar)
            # Halka
            draw.ellipse(
                (ax - 2, ay - 2, ax + AVATAR_R * 2 + 2, ay + AVATAR_R * 2 + 2),
                outline=ACCENT, width=2,
            )
        cx += AVATAR_R * 2 + 12

        # İsim + level
        name = member.display_name if member else f"Kullanıcı {row['user_id']}"
        if len(name) > 22:
            name = name[:21] + "…"

        total_xp = int(row["total_xp"])
        level, *_ = xp_tracker.get_progress_data(total_xp)

        draw.text((cx + 2, y0 + CARD_H // 2 - 14), name, font=f_name,
                  fill=TEXT_PRIMARY, anchor="lm")
        draw.text((cx + 2, y0 + CARD_H // 2 + 10), f"Seviye {level}",
                  font=f_level, fill=ACCENT, anchor="lm")

        # Sağ: XP + mini bar
        xp_str = f"{total_xp:,} XP"
        xp_x = CARD_W - 24

        # Mini progress bar
        _, _, floor, ceiling, ratio = xp_tracker.get_progress_data(total_xp)
        bar_x0 = CARD_W - 160
        bar_x1 = CARD_W - 24
        bar_y0 = y0 + CARD_H - 28
        bar_y1 = bar_y0 + BAR_H
        bar_r  = BAR_H // 2

        draw.rounded_rectangle((bar_x0, bar_y0, bar_x1, bar_y1),
                                radius=bar_r, fill=BAR_BG)
        fill_w = max(bar_r * 2, int((bar_x1 - bar_x0) * ratio))
        draw.rounded_rectangle(
            (bar_x0, bar_y0, bar_x0 + fill_w, bar_y1),
            radius=bar_r, fill=BAR_FILL,
        )

        draw.text((xp_x, y0 + CARD_H // 2 - 10), xp_str, font=f_xp,
                  fill=TEXT_PRIMARY, anchor="rm")

    # Dış çerçeve
    draw.rounded_rectangle((4, 4, CARD_W - 4, total_h - 4),
                            radius=20, outline=OUTLINE, width=2)

    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    buf.seek(0)
    return buf


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class LeaderboardCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    def _get_xp_tracker(self) -> XPTrackerCog:
        cog = self.bot.get_cog("XPTrackerCog")
        if not isinstance(cog, XPTrackerCog):
            raise RuntimeError("XP sistemi yüklenemedi.")
        return cog

    @commands.command(name="liderlik", aliases=["lb", "top"])
    async def liderlik_command(self, ctx: commands.Context) -> None:
        """Görsel XP sıralama tablosunu gösterir."""
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        rows = await dbmod.get_leaderboard(ctx.guild.id, limit=10)
        if not rows:
            await ctx.send("Henüz XP verisi yok.")
            return

        xp_tracker = self._get_xp_tracker()

        async with ctx.typing():
            try:
                buf = await build_leaderboard_card(ctx.guild, rows, xp_tracker)
            except Exception as err:
                await ctx.send(f"❌ Sıralama kartı oluşturulamadı: {err}")
                return

        await ctx.send(file=discord.File(buf, filename="liderlik.png"))
