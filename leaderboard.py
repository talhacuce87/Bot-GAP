"""
leaderboard.py — !liderlik ve !roller komutları için Pillow tabanlı görsel kartlar.

İlk 10 kullanıcıyı, XP'lerini, seviyelerini ve avatarlarını
tek bir görselde gösterir; ayrıca rol haritası kartını sunar.
"""

from __future__ import annotations

import asyncio
import io
from pathlib import Path

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont, ImageOps

import database as dbmod
from font_utils import clean_display_name, clean_text
from usercard import _load_font
from xp import XPTrackerCog

# ---------------------------------------------------------------------------
# Boyutlar
# ---------------------------------------------------------------------------

CARD_W = 860
CARD_H = 96           # Her satır yüksekliği
HEADER_H = 86
AVATAR_R = 34         # Yarıçap
ROW_PADDING = 16
BAR_H = 10

BG_COLOR = "#08101E"
ROW_ODD  = (12, 22, 42, 210)
ROW_EVEN = (8, 16, 32, 210)
OUTLINE  = "#20324F"
ACCENT   = "#58E1C1"
TEXT_PRIMARY   = "#F5F7FB"
TEXT_SECONDARY = "#8EA0BC"
BAR_BG   = "#17233D"
BAR_FILL = "#47D7C3"
SHADOW   = "#050C1A"


# ---------------------------------------------------------------------------
# Yardımcılar
# ---------------------------------------------------------------------------

def _hex_rgba(color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), alpha


async def _fetch_avatar_small(member: discord.Member | None, size: int = 68) -> Image.Image | None:
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


def _draw_rank_badge(
    draw: ImageDraw.ImageDraw,
    center: tuple[int, int],
    rank: int,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> None:
    cx, cy = center
    r = 18
    if rank == 1:
        # 1. sıra: Parlak altın madalya
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(235, 185, 45), outline=(255, 230, 120), width=2)
        draw.text((cx, cy), "1", font=font, fill="#1A1202", anchor="mm")
    elif rank == 2:
        # 2. sıra: Gümüş madalya
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(185, 195, 210), outline=(230, 240, 255), width=2)
        draw.text((cx, cy), "2", font=font, fill="#121824", anchor="mm")
    elif rank == 3:
        # 3. sıra: Bronz madalya
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(195, 125, 65), outline=(245, 175, 120), width=2)
        draw.text((cx, cy), "3", font=font, fill="#1E0C04", anchor="mm")
    else:
        # 4-10 arası: Koyu halka rozet
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(18, 28, 48), outline=(38, 56, 85), width=1)
        draw.text((cx, cy), str(rank), font=font, fill="#8EA0BC", anchor="mm")


# ---------------------------------------------------------------------------
# Kart üretici
# ---------------------------------------------------------------------------

async def build_leaderboard_card(
    guild: discord.Guild,
    rows: list,
    xp_tracker: XPTrackerCog,
) -> io.BytesIO:
    count = len(rows)
    total_h = HEADER_H + count * CARD_H + 24

    canvas = Image.new("RGBA", (CARD_W, total_h), BG_COLOR)
    draw = ImageDraw.Draw(canvas)

    # Hafif degrade arka plan
    for y in range(total_h):
        t = y / max(1, total_h - 1)
        r = int(8 + t * 8)
        g = int(16 + t * 10)
        b = int(30 + t * 18)
        draw.line([(0, y), (CARD_W, y)], fill=(r, g, b, 255))

    # Başlık & Sunucu
    f_title = _load_font(28, bold=True)
    f_sub   = _load_font(15)
    safe_guild_name = clean_text(guild.name) or "Sunucu Sıralaması"

    draw.text((CARD_W // 2, 28), "XP SIRALAMASI", font=f_title,
              fill=TEXT_PRIMARY, anchor="mm")
    draw.text((CARD_W // 2, 58), safe_guild_name, font=f_sub,
              fill=TEXT_SECONDARY, anchor="mm")
    draw.line([(32, HEADER_H - 4), (CARD_W - 32, HEADER_H - 4)],
              fill=OUTLINE, width=2)

    f_rank_bold = _load_font(17, bold=True)
    f_name      = _load_font(19, bold=True)
    f_xp        = _load_font(16, bold=True)
    f_level     = _load_font(13)

    # Avatar'ları paralel çek
    members = [guild.get_member(row["user_id"]) for row in rows]
    avatars = await asyncio.gather(*[_fetch_avatar_small(m, size=AVATAR_R * 2) for m in members])

    for i, (row, member, avatar) in enumerate(zip(rows, members, avatars)):
        y0 = HEADER_H + i * CARD_H
        y1 = y0 + CARD_H

        # Satır arka planı
        row_color = ROW_ODD if i % 2 == 0 else ROW_EVEN
        draw.rounded_rectangle(
            (14, y0 + 4, CARD_W - 14, y1 - 4),
            radius=14, fill=row_color, outline=OUTLINE, width=1,
        )

        cx = 32

        # Sıra numarası / vektörel madalya
        rank_num = i + 1
        _draw_rank_badge(draw, (cx + 18, y0 + CARD_H // 2), rank_num, f_rank_bold)
        cx += 48

        # İsim belirleme (avatar fallback'te ilk harf için de lazım)
        safe_name = clean_display_name(member, fallback=f"Kullanıcı {str(row['user_id'])[-4:]}")

        # Avatar veya Yedek Baş Harf Halkası
        ax = cx
        ay = y0 + CARD_H // 2 - AVATAR_R
        if avatar:
            canvas.paste(avatar, (ax, ay), avatar)
            draw.ellipse(
                (ax - 2, ay - 2, ax + AVATAR_R * 2 + 2, ay + AVATAR_R * 2 + 2),
                outline=ACCENT, width=2,
            )
        else:
            initial = (safe_name[:1] or "?").upper()
            draw.ellipse(
                (ax, ay, ax + AVATAR_R * 2, ay + AVATAR_R * 2),
                fill=(24, 38, 62), outline=ACCENT, width=2,
            )
            f_init = _load_font(20, bold=True)
            draw.text((ax + AVATAR_R, ay + AVATAR_R), initial, font=f_init, fill=TEXT_PRIMARY, anchor="mm")

        cx += AVATAR_R * 2 + 14

        # İsim + Level
        if len(safe_name) > 22:
            safe_name = safe_name[:21] + "…"

        total_xp = int(row["total_xp"])
        level, *_ = xp_tracker.get_progress_data(total_xp)

        draw.text((cx + 2, y0 + CARD_H // 2 - 14), safe_name, font=f_name,
                  fill=TEXT_PRIMARY, anchor="lm")
        draw.text((cx + 2, y0 + CARD_H // 2 + 12), f"Seviye {level}",
                  font=f_level, fill=ACCENT, anchor="lm")

        # Sağ: XP + mini bar
        xp_str = f"{total_xp:,} XP"
        xp_x = CARD_W - 28

        # Mini progress bar
        _, _, floor, ceiling, ratio = xp_tracker.get_progress_data(total_xp)
        bar_x0 = CARD_W - 160
        bar_x1 = CARD_W - 28
        bar_y0 = y0 + CARD_H - 26
        bar_y1 = bar_y0 + BAR_H
        bar_r  = BAR_H // 2

        draw.rounded_rectangle((bar_x0, bar_y0, bar_x1, bar_y1),
                                radius=bar_r, fill=BAR_BG)
        fill_w = max(bar_r * 2, int((bar_x1 - bar_x0) * ratio))
        draw.rounded_rectangle(
            (bar_x0, bar_y0, bar_x0 + fill_w, bar_y1),
            radius=bar_r, fill=BAR_FILL,
        )

        draw.text((xp_x, y0 + CARD_H // 2 - 12), xp_str, font=f_xp,
                  fill=TEXT_PRIMARY, anchor="rm")

    # Dış çerçeve
    draw.rounded_rectangle((8, 8, CARD_W - 8, total_h - 8),
                            radius=18, outline=OUTLINE, width=2)

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

    @commands.command(name="roller", aliases=["roles", "xproller"])
    async def roles_command(self, ctx: commands.Context, member: discord.Member | None = None) -> None:
        """Sunucunun XP rol haritasını görsel kart olarak gösterir."""
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        target = member or ctx.author
        if not isinstance(target, discord.Member):
            await ctx.send("Kullanıcı bilgisi alınamadı.")
            return

        await dbmod.ensure_user(ctx.guild.id, target.id)
        row = await dbmod.get_user_row(ctx.guild.id, target.id)
        total_xp = int(row["total_xp"]) if row else 0

        from rolescard import build_roles_card
        from xproles import ROLE_REWARDS

        async with ctx.typing():
            try:
                buf = await build_roles_card(
                    ctx.guild,
                    ROLE_REWARDS,
                    total_xp,
                    target.display_name,
                )
            except Exception as err:
                await ctx.send(f"❌ Rol kartı oluşturulamadı: {err}")
                return

        await ctx.send(file=discord.File(buf, filename=f"roles-{target.id}.png"))
