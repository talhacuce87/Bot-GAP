"""
cardutils.py — Kart üreten cog'ların (usercard, bestfriend, leaderboard)
ortak Pillow yardımcıları.

Not: ImageDraw, RGBA bir görsele yarı saydam renk çizerken alttaki pikselle
karıştırmaz, alpha'yı doğrudan piksele yazar (PNG delikli çıkar). Yarı saydam
şekiller bu yüzden draw_translucent ile ayrı katmana çizilip birleştirilir.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Sequence

import discord
from PIL import Image, ImageDraw, ImageFont, ImageOps

Font = ImageFont.FreeTypeFont | ImageFont.ImageFont

# ---------------------------------------------------------------------------
# Font cache — disk'ten sadece bir kez okunur
# ---------------------------------------------------------------------------

_font_cache: dict[tuple[int, bool], Font] = {}


def load_font(size: int, bold: bool = False) -> Font:
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

    font: Font | None = None
    for path in candidates:
        try:
            font = ImageFont.truetype(path, size)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default(size=size)

    _font_cache[key] = font
    return font


# ---------------------------------------------------------------------------
# Renk & metin
# ---------------------------------------------------------------------------

def hex_to_rgba(color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), alpha


def text_width(draw: ImageDraw.ImageDraw, text: str, font: Font) -> float:
    left, _, right, _ = draw.textbbox((0, 0), text, font=font)
    return right - left


def fit_text(draw: ImageDraw.ImageDraw, text: str, font: Font, max_width: int) -> str:
    """Metin sığmıyorsa sonunu '…' ile kısaltır."""
    if text_width(draw, text, font) <= max_width:
        return text
    while len(text) > 1:
        text = text[:-1]
        candidate = text.rstrip() + "…"
        if text_width(draw, candidate, font) <= max_width:
            return candidate
    return "…"


def fitted_font(
    draw: ImageDraw.ImageDraw,
    text: str,
    start: int,
    max_width: int,
    min_size: int = 18,
    bold: bool = False,
) -> Font:
    """Metnin sığdığı en büyük font boyutunu seçer (min_size'a kadar)."""
    for size in range(start, min_size - 1, -1):
        font = load_font(size, bold=bold)
        if text_width(draw, text, font) <= max_width:
            return font
    return load_font(min_size, bold=bold)


def draw_text(
    draw: ImageDraw.ImageDraw,
    pos: tuple[int, int],
    text: str,
    font: Font,
    fill: str,
    shadow: str | None,
    anchor: str | None = None,
) -> None:
    if shadow:
        draw.text((pos[0] + 2, pos[1] + 2), text, font=font, fill=shadow, anchor=anchor)
    draw.text(pos, text, font=font, fill=fill, anchor=anchor)


# ---------------------------------------------------------------------------
# Şekiller
# ---------------------------------------------------------------------------

def h_gradient(width: int, height: int, start: str, end: str) -> Image.Image:
    base = Image.new("RGBA", (width, height), start)
    overlay = Image.new("RGBA", (width, height), end)
    mask = Image.new("L", (width, 1))
    mask.putdata([int(255 * i / max(1, width - 1)) for i in range(width)])
    return Image.composite(overlay, base, mask.resize((width, height)))


def draw_translucent(
    card: Image.Image,
    panels: Sequence[tuple[tuple[int, int, int, int], int, tuple[int, int, int, int], str | None]],
    outline_width: int = 2,
) -> None:
    """
    (box, radius, fill_rgba, outline) listesindeki yuvarlak köşeli panelleri
    ayrı bir katmana çizip kartın üstüne alpha-blend eder. Aynı çağrıdaki
    paneller üst üste binmemeli; iç içe paneller için ayrı çağrı yapılmalı.
    """
    layer = Image.new("RGBA", card.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for box, radius, fill, outline in panels:
        draw.rounded_rectangle(
            box,
            radius=radius,
            fill=fill,
            outline=outline,
            width=outline_width if outline else 0,
        )
    card.alpha_composite(layer)


def paste_glow(card: Image.Image, center: tuple[int, int], radius: int, color: str, alpha: int) -> None:
    glow = Image.new("RGBA", (radius * 2, radius * 2), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for r in range(radius, 0, -12):
        a = max(0, int(alpha * (r / radius) ** 2))
        gd.ellipse((radius - r, radius - r, radius + r, radius + r), fill=hex_to_rgba(color, a))
    card.alpha_composite(glow, (center[0] - radius, center[1] - radius))


def rounded_bar(
    card: Image.Image,
    box: tuple[int, int, int, int],
    ratio: float,
    bg: str,
    fill_start: str,
    fill_end: str,
    outline: str | None = None,
    padding: int = 6,
) -> None:
    """Gradient dolgulu yuvarlak progress bar."""
    draw = ImageDraw.Draw(card)
    x1, y1, x2, y2 = box
    radius = (y2 - y1) // 2
    draw.rounded_rectangle(box, radius=radius, fill=bg)

    ix1, iy1, ix2, iy2 = x1 + padding, y1 + padding, x2 - padding, y2 - padding
    inner_h = iy2 - iy1
    ratio = max(0.0, min(1.0, ratio))
    fill_w = max(inner_h, int((ix2 - ix1) * ratio)) if ratio > 0 else 0

    if fill_w > 0:
        grad = h_gradient(fill_w, inner_h, fill_start, fill_end)
        mask = Image.new("L", (fill_w, inner_h), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, fill_w - 1, inner_h - 1), radius=inner_h // 2, fill=255)
        card.paste(grad, (ix1, iy1), mask)

    if outline:
        draw.rounded_rectangle(box, radius=radius, outline=outline, width=2)


# ---------------------------------------------------------------------------
# Avatar
# ---------------------------------------------------------------------------

async def fetch_avatar_bytes(member: discord.abc.User | None, size: int = 256) -> bytes | None:
    """Avatarı indirir; üye yoksa ya da indirme başarısızsa None döner."""
    if member is None:
        return None
    try:
        return await member.display_avatar.replace(size=size, format="png").read()
    except Exception:  # ağ hatası vs. — kart avatarsız da üretilebilir
        return None


def circle_avatar(data: bytes | None, size: int, placeholder: tuple[int, int, int, int] = (32, 48, 78, 255)) -> Image.Image:
    """Yuvarlak avatar; veri yoksa düz renkli yuvarlak placeholder."""
    if data is None:
        img = Image.new("RGBA", (size, size), placeholder)
    else:
        try:
            img = Image.open(io.BytesIO(data)).convert("RGBA")
            img = ImageOps.fit(img, (size, size), centering=(0.5, 0.5))
        except OSError:
            img = Image.new("RGBA", (size, size), placeholder)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    img.putalpha(mask)
    return img


# ---------------------------------------------------------------------------
# Çıktı
# ---------------------------------------------------------------------------

def to_png(card: Image.Image) -> io.BytesIO:
    """Kartı tamamen opak PNG olarak kaydeder."""
    buf = io.BytesIO()
    card.convert("RGB").save(buf, format="PNG")
    buf.seek(0)
    return buf
