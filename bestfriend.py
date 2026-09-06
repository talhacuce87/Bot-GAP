"""
bestfriend.py — Ortak ses süresine göre best friend sistemi.

Mantık:
- Bot, geçerli ses kanallarını her dakika tarar.
- Aynı kanalda bulunan her geçerli kullanıcı çifti için ortak süre yazılır.
- Bir kullanıcının en çok vakit geçirdiği kişi, 100 saat eşiğini geçince best friend olarak gösterilir.
- !bf komutu, kullanıcıya özel bir best friend kartı üretir.
"""

from __future__ import annotations

import asyncio
import io
from typing import Final

import discord
from discord.ext import commands, tasks
from PIL import Image, ImageDraw, ImageOps

import database as dbmod
from font_utils import clean_display_name
from usercard import _load_font

TRACK_INTERVAL_SECONDS: Final[int] = 60
BEST_FRIEND_THRESHOLD_SECONDS: Final[int] = 100 * 3600
CARD_WIDTH: Final[int] = 1080
CARD_HEIGHT: Final[int] = 640
AVATAR_SIZE: Final[int] = 150
LEFT_AVATAR_POS: Final[tuple[int, int]] = (95, 140)
RIGHT_AVATAR_POS: Final[tuple[int, int]] = (835, 140)
BAR_BOX: Final[tuple[int, int, int, int]] = (180, 416, 900, 454)

THEME: dict[str, object] = {
    "background_base": "#0B101E",
    "background_start": "#131A33",
    "background_end": "#0B4E54",
    "panel_fill": (12, 19, 36, 225),
    "panel_outline": "#326E7A",
    "outer_fill": (8, 13, 26, 240),
    "outer_outline": "#1D3B47",
    "box_fill": (18, 28, 52, 235),
    "box_outline": "#2A4C62",
    "accent": "#58E1C1",
    "accent_alt": "#FFB86C",
    "text_primary": "#F8FAFD",
    "text_secondary": "#B8C7DC",
    "text_muted": "#7E92B0",
    "bar_bg": "#18253D",
    "bar_fill": "#47D7C3",
    "bar_fill_end": "#FFD27A",
    "shadow": "#050C18",
}


def format_duration(total_seconds: int) -> str:
    total_seconds = max(0, int(total_seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, _ = divmod(remainder, 60)
    if hours >= 1000:
        return f"{hours:,} saat"
    if hours:
        return f"{hours}sa {minutes}dk"
    return f"{minutes}dk"


class BestFriendCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    async def cog_load(self) -> None:
        if not self.voice_pair_loop.is_running():
            self.voice_pair_loop.start()

    def cog_unload(self) -> None:
        self.voice_pair_loop.cancel()

    @staticmethod
    def _is_valid_voice_member(member: discord.Member) -> bool:
        voice_state = member.voice
        if member.bot or voice_state is None or voice_state.channel is None:
            return False
        if member.guild and member.guild.afk_channel and voice_state.channel.id == member.guild.afk_channel.id:
            return False
        return not (voice_state.self_deaf or voice_state.deaf)

    @staticmethod
    def _fit_text(
        draw: ImageDraw.ImageDraw,
        text: str,
        font,
        max_width: int,
    ) -> str:
        if draw.textbbox((0, 0), text, font=font)[2] <= max_width:
            return text
        while len(text) > 1:
            text = text[:-1]
            candidate = text.rstrip() + "…"
            if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
                return candidate
        return "…"

    @staticmethod
    async def _fetch_avatar(member: discord.Member | None) -> Image.Image:
        if member is None:
            placeholder = Image.new("RGBA", (AVATAR_SIZE, AVATAR_SIZE), (20, 32, 54, 255))
            mask = Image.new("L", (AVATAR_SIZE, AVATAR_SIZE), 0)
            ImageDraw.Draw(mask).ellipse((0, 0, AVATAR_SIZE, AVATAR_SIZE), fill=255)
            placeholder.putalpha(mask)

            draw = ImageDraw.Draw(placeholder)
            f_q = _load_font(56, bold=True)
            draw.text((AVATAR_SIZE // 2, AVATAR_SIZE // 2), "?", font=f_q, fill=(120, 145, 180, 255), anchor="mm")
            return placeholder

        try:
            data = await member.display_avatar.replace(size=256, format="png").read()
            avatar = Image.open(io.BytesIO(data)).convert("RGBA")
            avatar = ImageOps.fit(avatar, (AVATAR_SIZE, AVATAR_SIZE), centering=(0.5, 0.5))
            mask = Image.new("L", (AVATAR_SIZE, AVATAR_SIZE), 0)
            ImageDraw.Draw(mask).ellipse((0, 0, AVATAR_SIZE, AVATAR_SIZE), fill=255)
            avatar.putalpha(mask)
            return avatar
        except Exception:
            placeholder = Image.new("RGBA", (AVATAR_SIZE, AVATAR_SIZE), (20, 32, 54, 255))
            mask = Image.new("L", (AVATAR_SIZE, AVATAR_SIZE), 0)
            ImageDraw.Draw(mask).ellipse((0, 0, AVATAR_SIZE, AVATAR_SIZE), fill=255)
            placeholder.putalpha(mask)
            return placeholder

    @staticmethod
    def _hex_to_rgba(color: str, alpha: int = 255) -> tuple[int, int, int, int]:
        value = color.lstrip("#")
        return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha

    @staticmethod
    def _horizontal_gradient(width: int, height: int, start: str, end: str) -> Image.Image:
        base = Image.new("RGBA", (width, height), start)
        overlay = Image.new("RGBA", (width, height), end)
        mask = Image.new("L", (width, 1))
        mask.putdata([int(255 * i / max(1, width - 1)) for i in range(width)])
        return Image.composite(overlay, base, mask.resize((width, height)))

    def _draw_text(self, draw: ImageDraw.ImageDraw, pos: tuple[int, int], text: str, font, fill: str, anchor: str | None = None) -> None:
        shadow = str(THEME["shadow"])
        draw.text((pos[0] + 2, pos[1] + 2), text, font=font, fill=shadow, anchor=anchor)
        draw.text(pos, text, font=font, fill=fill, anchor=anchor)

    def _build_background(self) -> Image.Image:
        card = Image.new("RGBA", (CARD_WIDTH, CARD_HEIGHT), str(THEME["background_base"]))
        card.alpha_composite(
            self._horizontal_gradient(CARD_WIDTH, CARD_HEIGHT, str(THEME["background_start"]), str(THEME["background_end"]))
        )

        glow = Image.new("RGBA", (260, 260), (0, 0, 0, 0))
        glow_draw = ImageDraw.Draw(glow)
        for radius in range(120, 0, -14):
            alpha = max(0, int(75 * (radius / 120) ** 2))
            glow_draw.ellipse(
                (130 - radius, 130 - radius, 130 + radius, 130 + radius),
                fill=self._hex_to_rgba(str(THEME["accent"]), alpha),
            )
        card.alpha_composite(glow, (20, 20))
        card.alpha_composite(glow, (CARD_WIDTH - 280, CARD_HEIGHT - 280))

        draw = ImageDraw.Draw(card)
        # Dış çerçeve
        draw.rounded_rectangle(
            (24, 24, CARD_WIDTH - 24, CARD_HEIGHT - 24),
            radius=30,
            fill=THEME["outer_fill"],
            outline=str(THEME["outer_outline"]),
            width=2,
        )
        # İç ana panel (başlık üstte ferah kalacak şekilde Y=106'dan başlar)
        draw.rounded_rectangle(
            (48, 106, CARD_WIDTH - 48, CARD_HEIGHT - 44),
            radius=24,
            fill=THEME["panel_fill"],
            outline=str(THEME["panel_outline"]),
            width=2,
        )

        # Orta durum paneli (TAKIP DEVAM EDIYOR)
        draw.rounded_rectangle((380, 136, 700, 234), radius=22, fill=THEME["box_fill"], outline=str(THEME["box_outline"]), width=2)

        # Orta istatistik paneli (Ortak ses / Kalan süre / Eşik) - isimlerle çakışmayacak genişlikte
        draw.rounded_rectangle((270, 262, 810, 372), radius=22, fill=THEME["box_fill"], outline=str(THEME["box_outline"]), width=2)

        return card

    async def _resolve_bestfriend_data(self, member: discord.Member) -> tuple[discord.Member | None, int, bool]:
        row = await dbmod.get_bestfriend_row(member.guild.id, member.id)
        if row is None:
            return None, 0, False

        partner_id = int(row["partner_id"])
        shared_seconds = int(row["shared_seconds"])
        partner = member.guild.get_member(partner_id)
        return partner, shared_seconds, shared_seconds >= BEST_FRIEND_THRESHOLD_SECONDS

    async def build_card(self, member: discord.Member) -> io.BytesIO:
        partner, shared_seconds, unlocked = await self._resolve_bestfriend_data(member)
        remaining_seconds = max(0, BEST_FRIEND_THRESHOLD_SECONDS - shared_seconds)
        ratio = min(1.0, shared_seconds / BEST_FRIEND_THRESHOLD_SECONDS) if BEST_FRIEND_THRESHOLD_SECONDS else 1.0

        card = self._build_background()
        left_avatar, right_avatar = await asyncio.gather(
            self._fetch_avatar(member),
            self._fetch_avatar(partner),
        )
        card.paste(left_avatar, LEFT_AVATAR_POS, left_avatar)
        card.paste(right_avatar, RIGHT_AVATAR_POS, right_avatar)

        draw = ImageDraw.Draw(card)
        for x, y, color in [
            (LEFT_AVATAR_POS[0], LEFT_AVATAR_POS[1], str(THEME["accent"])),
            (RIGHT_AVATAR_POS[0], RIGHT_AVATAR_POS[1], str(THEME["accent_alt"])),
        ]:
            draw.ellipse((x - 6, y - 6, x + AVATAR_SIZE + 6, y + AVATAR_SIZE + 6), outline=color, width=4)

        f_title = _load_font(28, bold=True)
        f_sub = _load_font(15)
        f_name = _load_font(22, bold=True)
        f_status = _load_font(17, bold=True)
        f_center_val = _load_font(28, bold=True)
        f_box_label = _load_font(14)
        f_box_val = _load_font(21, bold=True)
        f_progress = _load_font(16, bold=True)

        # Başlık ve Alt Başlık (Panelin üstündeki alana net hizalı)
        self._draw_text(draw, (CARD_WIDTH // 2, 50), "BEST FRIEND TRACKER", f_title, str(THEME["text_primary"]), anchor="mm")
        self._draw_text(draw, (CARD_WIDTH // 2, 80), "100 saat ortak ses süresinden sonra Best Friend aktif olur", f_sub, str(THEME["text_secondary"]), anchor="mm")

        # İsimler (Avatarların altına ortalı ve max 180px genişlikle sınırlandırılmış, orta kutuya taşmaz)
        left_raw = clean_display_name(member, fallback="Kullanıcı")
        right_raw = clean_display_name(partner, fallback="Henüz Yok") if partner else "Henüz Yok"

        left_name = self._fit_text(draw, left_raw, f_name, 180)
        right_name = self._fit_text(draw, right_raw, f_name, 180)

        left_center_x = LEFT_AVATAR_POS[0] + AVATAR_SIZE // 2
        right_center_x = RIGHT_AVATAR_POS[0] + AVATAR_SIZE // 2
        self._draw_text(draw, (left_center_x, 314), left_name, f_name, str(THEME["text_primary"]), anchor="mm")
        self._draw_text(draw, (right_center_x, 314), right_name, f_name, str(THEME["text_primary"]), anchor="mm")

        # Üst Durum Rozeti
        status_text = "BEST FRIEND AKTİF" if unlocked else "TAKİP DEVAM EDİYOR"
        status_color = str(THEME["accent"]) if unlocked else str(THEME["accent_alt"])
        self._draw_text(draw, (540, 166), status_text, f_status, status_color, anchor="mm")
        self._draw_text(draw, (540, 202), format_duration(shared_seconds), f_center_val, str(THEME["text_primary"]), anchor="mm")

        # Alt 3'lü İstatistik Paneli
        # Sütun 1: Ortak Ses
        self._draw_text(draw, (360, 288), "Ortak Ses Süresi", f_box_label, str(THEME["text_muted"]), anchor="mm")
        self._draw_text(draw, (360, 328), format_duration(shared_seconds), f_box_val, str(THEME["text_primary"]), anchor="mm")

        # Sütun 2: Kalan Süre
        remaining_label = "Tamamlandı" if unlocked else format_duration(remaining_seconds)
        self._draw_text(draw, (540, 288), "Kalan Süre", f_box_label, str(THEME["text_muted"]), anchor="mm")
        self._draw_text(draw, (540, 328), remaining_label, f_box_val, str(THEME["accent"] if unlocked else THEME["text_primary"]), anchor="mm")

        # Sütun 3: Hedef Eşik
        self._draw_text(draw, (720, 288), "Hedef Eşik", f_box_label, str(THEME["text_muted"]), anchor="mm")
        self._draw_text(draw, (720, 328), "100 saat", f_box_val, str(THEME["text_primary"]), anchor="mm")

        # İlerleme Çubuğu
        x1, y1, x2, y2 = BAR_BOX
        bar_h = y2 - y1
        radius = bar_h // 2
        draw.rounded_rectangle(BAR_BOX, radius=radius, fill=str(THEME["bar_bg"]))

        inner_x1 = x1 + 4
        inner_y1 = y1 + 4
        inner_x2 = x2 - 4
        inner_y2 = y2 - 4
        inner_w = inner_x2 - inner_x1
        fill_width = int(inner_w * ratio)

        if fill_width > 0:
            fill_img = self._horizontal_gradient(max(1, fill_width), inner_y2 - inner_y1, str(THEME["bar_fill"]), str(THEME["bar_fill_end"]))
            mask = Image.new("L", (max(1, fill_width), inner_y2 - inner_y1), 0)
            ImageDraw.Draw(mask).rounded_rectangle((0, 0, max(1, fill_width), inner_y2 - inner_y1), radius=max(6, radius - 4), fill=255)
            card.paste(fill_img, (inner_x1, inner_y1), mask)

        draw.rounded_rectangle(BAR_BOX, radius=radius, outline=str(THEME["accent"]), width=2)

        progress_text = f"{min(shared_seconds, BEST_FRIEND_THRESHOLD_SECONDS) // 3600:,} / {BEST_FRIEND_THRESHOLD_SECONDS // 3600:,} saat  (%{int(ratio * 100)})"
        self._draw_text(draw, (CARD_WIDTH // 2, 480), progress_text, f_progress, str(THEME["text_secondary"]), anchor="mm")

        buf = io.BytesIO()
        card.save(buf, format="PNG")
        buf.seek(0)
        return buf

    @tasks.loop(seconds=TRACK_INTERVAL_SECONDS)
    async def voice_pair_loop(self) -> None:
        for guild in self.bot.guilds:
            afk_id = guild.afk_channel.id if guild.afk_channel else None
            for channel in guild.voice_channels:
                if afk_id is not None and channel.id == afk_id:
                    continue
                valid_members = [member for member in channel.members if self._is_valid_voice_member(member)]
                if len(valid_members) < 2:
                    continue
                await dbmod.add_pair_voice_seconds_bulk(
                    guild.id,
                    [member.id for member in valid_members],
                    TRACK_INTERVAL_SECONDS,
                )
                await asyncio.sleep(0)

    @voice_pair_loop.before_loop
    async def _before_voice_pair_loop(self) -> None:
        await self.bot.wait_until_ready()

    @commands.command(name="bf")
    async def bf_command(self, ctx: commands.Context, member: discord.Member | None = None) -> None:
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        target = member or ctx.author
        if not isinstance(target, discord.Member):
            await ctx.send("Kullanıcı bilgisi alınamadı.")
            return

        async with ctx.typing():
            try:
                buf = await self.build_card(target)
            except Exception as err:
                await ctx.send(f"❌ Best friend kartı oluşturulamadı: {err}")
                return

        await ctx.send(file=discord.File(buf, filename=f"bf-{target.id}.png"))
