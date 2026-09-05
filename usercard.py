"""
usercard.py — !kart komutu için Pillow tabanlı kullanıcı kartı üretimi.

Değişiklikler:
- Font nesneleri sınıf düzeyinde cache'lenir (disk I/O azalır)
- XP verileri artık async db çağrılarından gelir
- get_live_voice_seconds imzası güncellendi
"""

from __future__ import annotations

import io
from pathlib import Path

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont, ImageOps

import database as dbmod
from xp import XPTrackerCog
from xproles import ROLE_REWARDS

# ---------------------------------------------------------------------------
# Kart boyutları
# ---------------------------------------------------------------------------

CARD_WIDTH = 1050
CARD_HEIGHT = 600
AVATAR_SIZE = 150
AVATAR_POSITION = (76, 120)
RANK_CENTER = (886, 136)
BAR_BOX = (285, 482, 948, 526)
BAR_INNER_PADDING = 6

# ---------------------------------------------------------------------------
# Temalar
# ---------------------------------------------------------------------------

DEFAULT_THEME: dict[str, object] = {
    "background_base": "#08111F",
    "background_start": "#0A1424",
    "background_end": "#101B34",
    "panel_fill": (11, 19, 35, 220),
    "panel_outline": "#233252",
    "outer_panel_fill": (7, 13, 26, 232),
    "outer_panel_outline": "#203155",
    "text_primary": "#F5F7FB",
    "text_secondary": "#C9D4E4",
    "text_muted": "#8EA0BC",
    "accent": "#58E1C1",
    "bar_bg": "#17233D",
    "bar_fill": "#47D7C3",
    "bar_fill_end": "#6A7BFF",
    "shadow": "#120F1D",
    "glow_primary": "#2DE2C5",
    "glow_secondary": "#5670FF",
    "glow_tertiary": "#46E2C4",
}

ROLE_THEMES: dict[int, dict[str, object]] = {
    ROLE_REWARDS[0]:     {"background_base": "#0C1510", "background_start": "#0F1F16", "background_end": "#183124", "panel_outline": "#27523A", "outer_panel_outline": "#2E6144", "accent": "#7FE08B", "bar_bg": "#16281D", "bar_fill": "#64D989", "bar_fill_end": "#C5F17A", "glow_primary": "#62E18B", "glow_secondary": "#A9F06E", "glow_tertiary": "#8CF6C3"},
    ROLE_REWARDS[150]:   {"background_base": "#1A1320", "background_start": "#20172A", "background_end": "#31203D", "panel_outline": "#58416C", "outer_panel_outline": "#6C4D82", "accent": "#FFD36E", "bar_bg": "#2A1F33", "bar_fill": "#FFC766", "bar_fill_end": "#FF9B70", "glow_primary": "#FFD36E", "glow_secondary": "#FF9E6C", "glow_tertiary": "#FFF0A8"},
    ROLE_REWARDS[400]:   {"background_base": "#10192A", "background_start": "#12203A", "background_end": "#1D3152", "panel_outline": "#315884", "outer_panel_outline": "#3E6DA1", "accent": "#78D3FF", "bar_bg": "#162742", "bar_fill": "#66CFFF", "bar_fill_end": "#9687FF", "glow_primary": "#57C8FF", "glow_secondary": "#8E7FFF", "glow_tertiary": "#8DEFF0"},
    ROLE_REWARDS[800]:   {"background_base": "#121D12", "background_start": "#172A17", "background_end": "#254227", "panel_outline": "#3F7146", "outer_panel_outline": "#4C8854", "accent": "#9EE86C", "bar_bg": "#1E3120", "bar_fill": "#93E46A", "bar_fill_end": "#46D996", "glow_primary": "#8FE869", "glow_secondary": "#3EDB8F", "glow_tertiary": "#C4F797"},
    ROLE_REWARDS[1400]:  {"background_base": "#171520", "background_start": "#201A2D", "background_end": "#342545", "panel_outline": "#664B89", "outer_panel_outline": "#795BA3", "accent": "#9CC0FF", "bar_bg": "#272135", "bar_fill": "#97BCFF", "bar_fill_end": "#7DE9D1", "glow_primary": "#9FB5FF", "glow_secondary": "#7CF3D7", "glow_tertiary": "#D7C0FF"},
    ROLE_REWARDS[2300]:  {"background_base": "#171A1C", "background_start": "#1C2428", "background_end": "#2B383D", "panel_outline": "#526870", "outer_panel_outline": "#637C85", "accent": "#A3F1FF", "bar_bg": "#222D31", "bar_fill": "#87E8F8", "bar_fill_end": "#80BFFF", "glow_primary": "#7DEAF8", "glow_secondary": "#8DB5FF", "glow_tertiary": "#C8FFFF"},
    ROLE_REWARDS[3500]:  {"background_base": "#1A1412", "background_start": "#251A17", "background_end": "#3A2721", "panel_outline": "#7A5143", "outer_panel_outline": "#966554", "accent": "#FFB26B", "bar_bg": "#31211C", "bar_fill": "#FFAA63", "bar_fill_end": "#FF7A62", "glow_primary": "#FFAC63", "glow_secondary": "#FF745A", "glow_tertiary": "#FFD09A"},
    ROLE_REWARDS[5200]:  {"background_base": "#101622", "background_start": "#131E31", "background_end": "#1D2F4A", "panel_outline": "#37598A", "outer_panel_outline": "#456DA8", "accent": "#76B8FF", "bar_bg": "#17263D", "bar_fill": "#67B2FF", "bar_fill_end": "#5FEDD9", "glow_primary": "#6CAEFF", "glow_secondary": "#5DE5D9", "glow_tertiary": "#A6D4FF"},
    ROLE_REWARDS[7600]:  {"background_base": "#111B24", "background_start": "#152434", "background_end": "#22374E", "panel_outline": "#3D6B8D", "outer_panel_outline": "#5081A6", "accent": "#8DE9FF", "bar_bg": "#1A2B40", "bar_fill": "#81E6F7", "bar_fill_end": "#68B2FF", "glow_primary": "#7BE5FF", "glow_secondary": "#62AFFF", "glow_tertiary": "#B7F9FF"},
    ROLE_REWARDS[10500]: {"background_base": "#23130F", "background_start": "#351913", "background_end": "#58241A", "panel_outline": "#9A4D36", "outer_panel_outline": "#BD6445", "accent": "#FF8B5C", "bar_bg": "#3A2018", "bar_fill": "#FF825A", "bar_fill_end": "#FFC964", "glow_primary": "#FF7E53", "glow_secondary": "#FFC85B", "glow_tertiary": "#FFC0A1"},
    ROLE_REWARDS[14500]: {"background_base": "#1A1223", "background_start": "#241634", "background_end": "#3A2053", "panel_outline": "#7750A3", "outer_panel_outline": "#8E62C1", "accent": "#C094FF", "bar_bg": "#2A1D3F", "bar_fill": "#B88DFF", "bar_fill_end": "#64DFFF", "glow_primary": "#BC8CFF", "glow_secondary": "#60D6FF", "glow_tertiary": "#E7C9FF"},
    ROLE_REWARDS[19500]: {"background_base": "#261E10", "background_start": "#332714", "background_end": "#4F3C1D", "panel_outline": "#8F7132", "outer_panel_outline": "#AA8940", "accent": "#F4D35E", "bar_bg": "#3A2E18", "bar_fill": "#EBCF5F", "bar_fill_end": "#FFF0A1", "glow_primary": "#F0D35A", "glow_secondary": "#FFF1AE", "glow_tertiary": "#FFD980"},
    ROLE_REWARDS[25500]: {"background_base": "#181511", "background_start": "#211E18", "background_end": "#352B22", "panel_outline": "#75644B", "outer_panel_outline": "#8B785A", "accent": "#F7E8B0", "bar_bg": "#2A241D", "bar_fill": "#EEDFA7", "bar_fill_end": "#C99962", "glow_primary": "#F0E3AE", "glow_secondary": "#D39F6A", "glow_tertiary": "#FFF6D2"},
    ROLE_REWARDS[32500]: {"background_base": "#11181E", "background_start": "#14232C", "background_end": "#1F3A47", "panel_outline": "#3D7487", "outer_panel_outline": "#4A91A6", "accent": "#CFFBFF", "bar_bg": "#1B2D36", "bar_fill": "#B7F7FF", "bar_fill_end": "#84C3FF", "glow_primary": "#C2FAFF", "glow_secondary": "#7FC1FF", "glow_tertiary": "#EDFEFF"},
    ROLE_REWARDS[40000]: {"background_base": "#141520", "background_start": "#1C1A30", "background_end": "#2D2550", "panel_outline": "#6C62A3", "outer_panel_outline": "#8276C4", "accent": "#BBD4FF", "bar_bg": "#25233A", "bar_fill": "#AFC9FF", "bar_fill_end": "#62F4D1", "glow_primary": "#B5CEFF", "glow_secondary": "#62EED1", "glow_tertiary": "#E3DDFF"},
    ROLE_REWARDS[100000]: {"background_base": "#160F24", "background_start": "#211338", "background_end": "#38205F", "panel_outline": "#7B53C7", "outer_panel_outline": "#9168E3", "accent": "#E3C6FF", "bar_bg": "#281C40", "bar_fill": "#C89BFF", "bar_fill_end": "#6FE7FF", "glow_primary": "#D09DFF", "glow_secondary": "#6DE1FF", "glow_tertiary": "#F3D9FF"},
    ROLE_REWARDS[250000]: {"background_base": "#1E170D", "background_start": "#302310", "background_end": "#533917", "panel_outline": "#A27A29", "outer_panel_outline": "#C79635", "accent": "#FFE28A", "bar_bg": "#3B2C14", "bar_fill": "#F6D76E", "bar_fill_end": "#FF9D57", "glow_primary": "#FDDC75", "glow_secondary": "#FFA15C", "glow_tertiary": "#FFF1B4"},
    ROLE_REWARDS[500000]: {"background_base": "#0F1C1E", "background_start": "#123033", "background_end": "#1A5357", "panel_outline": "#2F8E95", "outer_panel_outline": "#3DB0B8", "accent": "#B8FFF9", "bar_bg": "#173639", "bar_fill": "#8EF2E8", "bar_fill_end": "#88B8FF", "glow_primary": "#90FFF3", "glow_secondary": "#8AB7FF", "glow_tertiary": "#D7FFFF"},
    ROLE_REWARDS[1000000]: {"background_base": "#14110D", "background_start": "#20180F", "background_end": "#382515", "panel_outline": "#8E6A2C", "outer_panel_outline": "#B08533", "accent": "#FFF0B0", "bar_bg": "#312416", "bar_fill": "#F4E0A1", "bar_fill_end": "#FFD16B", "glow_primary": "#FFF0B6", "glow_secondary": "#FFD56F", "glow_tertiary": "#FFF8D9"},
}

# ---------------------------------------------------------------------------
# Font cache — disk'ten sadece bir kez okunur
# ---------------------------------------------------------------------------

_font_cache: dict[tuple[int, bool], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}


def _load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    key = (size, bold)
    if key in _font_cache:
        return _font_cache[key]

    assets_dir = Path(__file__).resolve().parent / "assets" / "fonts"
    candidates: list[str] = []

    if bold:
        candidates += [
            str(assets_dir / "DejaVuSans-Bold.ttf"),
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            r"C:\Windows\Fonts\arialbd.ttf",
            r"C:\Windows\Fonts\segoeuib.ttf",
        ]
    candidates += [
        str(assets_dir / "DejaVuSans.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
    ]

    font: ImageFont.FreeTypeFont | ImageFont.ImageFont = ImageFont.load_default()
    for path in candidates:
        try:
            font = ImageFont.truetype(path, size)
            break
        except OSError:
            continue

    _font_cache[key] = font
    return font


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class UserCardCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    # ------------------------------------------------------------------
    # Yardımcılar
    # ------------------------------------------------------------------

    def _get_xp_tracker(self) -> XPTrackerCog:
        cog = self.bot.get_cog("XPTrackerCog")
        if not isinstance(cog, XPTrackerCog):
            raise RuntimeError("XP sistemi yüklenemedi.")
        return cog

    @staticmethod
    def _hex_to_rgba(color: str, alpha: int = 255) -> tuple[int, int, int, int]:
        c = color.lstrip("#")
        return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), alpha

    @staticmethod
    def _fit_text(
        draw: ImageDraw.ImageDraw,
        text: str,
        font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
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

    def _fitted_font(
        self,
        draw: ImageDraw.ImageDraw,
        text: str,
        start: int,
        max_width: int,
        min_size: int = 18,
        bold: bool = False,
    ) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        for size in range(start, min_size - 1, -1):
            font = _load_font(size, bold=bold)
            if draw.textbbox((0, 0), text, font=font)[2] <= max_width:
                return font
        return _load_font(min_size, bold=bold)

    @staticmethod
    def _draw_text(
        draw: ImageDraw.ImageDraw,
        pos: tuple[int, int],
        text: str,
        font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
        fill: str,
        shadow: str,
        anchor: str | None = None,
        with_shadow: bool = True,
    ) -> None:
        if with_shadow:
            draw.text((pos[0] + 2, pos[1] + 2), text, font=font, fill=shadow, anchor=anchor)
        draw.text(pos, text, font=font, fill=fill, anchor=anchor)

    @staticmethod
    def _draw_panel(
        draw: ImageDraw.ImageDraw,
        box: tuple[int, int, int, int],
        radius: int,
        fill: tuple[int, int, int, int],
        outline: str,
    ) -> None:
        draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=2)

    @staticmethod
    def _theme(role_id: int | None) -> dict[str, object]:
        theme = DEFAULT_THEME.copy()
        if role_id is not None:
            theme.update(ROLE_THEMES.get(role_id, {}))
        return theme

    @staticmethod
    def _paste_glow(card: Image.Image, center: tuple[int, int], radius: int, color: str, alpha: int) -> None:
        glow = Image.new("RGBA", (radius * 2, radius * 2), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        for r in range(radius, 0, -12):
            a = max(0, int(alpha * (r / radius) ** 2))
            gd.ellipse((radius - r, radius - r, radius + r, radius + r),
                       fill=UserCardCog._hex_to_rgba(color, a))
        card.alpha_composite(glow, (center[0] - radius, center[1] - radius))

    @staticmethod
    async def _fetch_avatar(member: discord.Member) -> Image.Image:
        data = await member.display_avatar.replace(size=256, format="png").read()
        avatar = Image.open(io.BytesIO(data)).convert("RGBA")
        avatar = ImageOps.fit(avatar, (AVATAR_SIZE, AVATAR_SIZE), centering=(0.5, 0.5))
        mask = Image.new("L", (AVATAR_SIZE, AVATAR_SIZE), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, AVATAR_SIZE, AVATAR_SIZE), fill=255)
        avatar.putalpha(mask)
        return avatar

    @staticmethod
    def _h_gradient(width: int, height: int, start: str, end: str) -> Image.Image:
        base = Image.new("RGBA", (width, height), start)
        overlay = Image.new("RGBA", (width, height), end)
        mask = Image.new("L", (width, 1))
        mask.putdata([int(255 * i / max(1, width - 1)) for i in range(width)])
        mask = mask.resize((width, height))
        return Image.composite(overlay, base, mask)

    def _draw_progress_bar(self, card: Image.Image, ratio: float, theme: dict[str, object]) -> None:
        draw = ImageDraw.Draw(card)
        x1, y1, x2, y2 = BAR_BOX
        radius = (y2 - y1) // 2
        draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, fill=str(theme["bar_bg"]))

        ix = x1 + BAR_INNER_PADDING
        iy = y1 + BAR_INNER_PADDING
        iw = x2 - BAR_INNER_PADDING
        ih = y2 - BAR_INNER_PADDING
        inner_w = iw - ix
        fill_w = max(radius, int(inner_w * ratio)) if ratio > 0 else 0

        if fill_w > 0:
            grad = self._h_gradient(fill_w, ih - iy, str(theme["bar_fill"]), str(theme["bar_fill_end"]))
            fill_mask = Image.new("L", (fill_w, ih - iy), 0)
            ImageDraw.Draw(fill_mask).rounded_rectangle(
                (0, 0, fill_w, ih - iy),
                radius=max(8, radius - BAR_INNER_PADDING),
                fill=255,
            )
            card.paste(grad, (ix, iy), fill_mask)

        draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, outline=str(theme["accent"]), width=2)

    def _build_background(self, theme: dict[str, object]) -> Image.Image:
        card = Image.new("RGBA", (CARD_WIDTH, CARD_HEIGHT), str(theme["background_base"]))
        card.alpha_composite(self._h_gradient(CARD_WIDTH, CARD_HEIGHT,
                                              str(theme["background_start"]),
                                              str(theme["background_end"])))
        self._paste_glow(card, (140, 40), 180, str(theme["glow_primary"]), 70)
        self._paste_glow(card, (960, 560), 220, str(theme["glow_secondary"]), 80)
        self._paste_glow(card, (860, 120), 120, str(theme["glow_tertiary"]), 55)

        draw = ImageDraw.Draw(card)
        self._draw_panel(draw, (30, 30, CARD_WIDTH - 30, CARD_HEIGHT - 30),
                         34, theme["outer_panel_fill"], str(theme["outer_panel_outline"]))
        for box, r in [
            ((56, 76, 245, 314), 28),
            ((270, 182, 505, 292), 24),
            ((530, 182, 765, 292), 24),
            ((270, 314, 505, 424), 24),
            ((530, 314, 765, 424), 24),
            ((800, 70, 972, 242), 30),
        ]:
            self._draw_panel(draw, box, r, theme["panel_fill"], str(theme["panel_outline"]))
        return card

    # ------------------------------------------------------------------
    # Kart üretimi
    # ------------------------------------------------------------------

    async def build_card(self, member: discord.Member) -> io.BytesIO:
        xp = self._get_xp_tracker()
        row = await dbmod.get_user_row(member.guild.id, member.id)
        if row is None:
            raise ValueError("Kullanıcı verisi bulunamadı.")

        total_xp = int(row["total_xp"])
        live_voice = xp.get_live_voice_seconds(
            member.guild.id, member.id,
            int(row["voice_seconds"]),
            row["active_voice_started_at"],
        )
        rank = await xp.get_user_rank(member.guild.id, member.id)
        level, next_level, floor, ceiling, ratio = xp.get_progress_data(total_xp)
        display_role = xp.get_display_role(member, total_xp)
        target_role = xp.get_target_role(member, total_xp)
        theme = self._theme(None if target_role is None else target_role.id)

        card = self._build_background(theme)
        avatar = await self._fetch_avatar(member)
        card.paste(avatar, AVATAR_POSITION, avatar)

        draw = ImageDraw.Draw(card)
        ax, ay = AVATAR_POSITION
        draw.ellipse(
            (ax - 7, ay - 7, ax + AVATAR_SIZE + 7, ay + AVATAR_SIZE + 7),
            outline=str(theme["accent"]), width=4,
        )

        # Fontlar (cache'den)
        f_name     = _load_font(46, bold=True)
        f_user     = _load_font(24)
        f_label    = _load_font(19)
        f_value    = _load_font(31, bold=True)
        f_rank     = _load_font(42, bold=True)
        f_level    = _load_font(28, bold=True)
        f_progress = _load_font(18, bold=True)

        dt = self._draw_text
        sh = str(theme["shadow"])
        tp = str(theme["text_primary"])
        ts = str(theme["text_secondary"])
        tm = str(theme["text_muted"])
        ac = str(theme["accent"])

        name_str = self._fit_text(draw, member.display_name, f_name, 430)
        dt(draw, (286, 92), name_str, f_name, tp, sh)
        user_str = self._fit_text(draw, f"@{member.name}", f_user, 280)
        dt(draw, (289, 144), user_str, f_user, ts, sh)

        dt(draw, (292, 206), "Current Role", f_label, tm, sh)
        f_role = self._fitted_font(draw, display_role, 31, 200, 20, bold=True)
        dt(draw, (292, 242), display_role, f_role, tp, sh)

        dt(draw, (552, 206), "Total XP", f_label, tm, sh)
        dt(draw, (552, 242), f"{total_xp:,}", f_value, tp, sh)

        dt(draw, (292, 338), "Messages Sent", f_label, tm, sh)
        dt(draw, (292, 374), f"{int(row['message_count']):,}", f_value, tp, sh)

        dt(draw, (552, 338), "Total Voice Time", f_label, tm, sh)
        voice_str = self._fit_text(draw, xp.format_duration(live_voice), f_value, 190)
        dt(draw, (552, 374), voice_str, f_value, tp, sh)

        dt(draw, (886, 96), "RANK", f_label, tm, sh, anchor="mm")
        dt(draw, RANK_CENTER, str(rank), f_rank, tp, sh, anchor="mm")
        dt(draw, (886, 188), f"Level {level}", f_label, ac, sh, anchor="mm")

        self._draw_progress_bar(card, ratio, theme)
        dt(draw, (286, 438), f"Level {level}", f_level, tp, sh)
        next_label = "MAX" if ceiling <= floor else f"Level {next_level}"
        dt(draw, (948, 438), next_label, f_level, tp, sh, anchor="rm")

        xp_text = "MAX" if ceiling <= floor else f"{total_xp:,} / {ceiling:,} XP"
        dt(draw, (616, 550), xp_text, f_progress, ts, sh, anchor="mm")

        buf = io.BytesIO()
        card.save(buf, format="PNG")
        buf.seek(0)
        return buf

    # ------------------------------------------------------------------
    # Komut
    # ------------------------------------------------------------------

    @commands.command(name="kart")
    async def kart_command(self, ctx: commands.Context, member: discord.Member | None = None) -> None:
        if ctx.guild is None:
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
            return

        target = member or ctx.author
        if not isinstance(target, discord.Member):
            await ctx.send("Kullanıcı bilgisi alınamadı.")
            return

        await dbmod.ensure_user(ctx.guild.id, target.id)

        async with ctx.typing():
            try:
                buf = await self.build_card(target)
            except Exception as err:
                await ctx.send(f"❌ Kart oluşturulamadı: {err}")
                return

        await ctx.send(file=discord.File(buf, filename=f"kart-{target.id}.png"))
