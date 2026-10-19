"""
badges.py — Başarım rozetlerinin çizimi.

- draw_patch: işlemeli izci rozeti (kademe renginde dikişli kenar, kumaş zemin, simge, yıldızlar).
  Kilitli rozetler soluk ve "dikilmemiş", gizli kilitliler "?" olarak çizilir.
- render_sash_card: !başarımlar — rozetlerin dikildiği, kartı çaprazlama geçen bir fular.
- Simgeler assets/badges/ altındaki Twemoji PNG'leridir (bkz. KAYNAK.md).
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

from achievements import Achievement, tier_color, tier_label
from cardutils import circle_avatar, draw_translucent, fit_text, load_font, paste_glow, text_width

ICON_DIR = Path(__file__).resolve().parent / "assets" / "badges"

BG_TOP, BG_BOTTOM = (8, 16, 30), (14, 24, 44)
OUTLINE = "#20324F"
TEXT = "#F5F7FB"
MUTED = "#8EA0BC"
ACCENT = "#58E1C1"
FABRIC = (21, 64, 66)          # fuların kumaşı (koyu petrol yeşili)
LOCKED_RING = "#3A4660"


@lru_cache(maxsize=64)
def _icon(name: str) -> Image.Image | None:
    try:
        return Image.open(ICON_DIR / f"{name}.png").convert("RGBA")
    except OSError:
        return None


def _rgb(color: str) -> tuple[int, int, int]:
    c = color.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def _shade(rgb: tuple[int, int, int], f: float) -> tuple[int, int, int]:
    return tuple(max(0, min(255, int(v * f))) for v in rgb)


def _star(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    pts = []
    for i in range(10):
        ang = -math.pi / 2 + i * math.pi / 5
        rad = r if i % 2 == 0 else r * 0.45
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    draw.polygon(pts, fill=fill)


def draw_patch(a: Achievement, tier: int, size: int, *, state: str = "earned") -> Image.Image:
    """state: earned | locked | hidden"""
    s = size * 3  # büyük çizip küçültmek kenarları yumuşatır
    img = Image.new("RGBA", (s + 12, s + 12), (0, 0, 0, 0))

    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse((10, 16, s + 6, s + 12), fill=(0, 0, 0, 120 if state == "earned" else 60))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6)))

    draw = ImageDraw.Draw(img)
    ring_w = int(s * 0.1)
    if state == "earned":
        ring = _rgb(tier_color(a, tier))
        draw.ellipse((4, 4, s + 4, s + 4), fill=ring)
        # kumaş zemin
        inner = (4 + ring_w, 4 + ring_w, s + 4 - ring_w, s + 4 - ring_w)
        draw.ellipse(inner, fill=(18, 30, 52))
        draw.ellipse((inner[0] + 6, inner[1] + 6, inner[2] - 6, inner[3] - 6), fill=(24, 40, 66))
        # dikiş: kenar boyunca kısa çizgiler
        stitch = _shade(ring, 0.55)
        r = s / 2 - ring_w / 2
        cx = cy = 4 + s / 2
        for i in range(48):
            a0 = i * 2 * math.pi / 48
            a1 = a0 + math.pi / 64
            draw.line([(cx + r * math.cos(a0), cy + r * math.sin(a0)), (cx + r * math.cos(a1), cy + r * math.sin(a1))],
                      fill=stitch, width=max(2, s // 60))
        draw.ellipse((4, 4, s + 4, s + 4), outline=_shade(ring, 0.7), width=max(2, s // 80))
    else:
        cx = cy = 4 + s / 2
        draw.ellipse((4, 4, s + 4, s + 4), fill=(16, 24, 40))
        # dikilmemiş: kesik çizgili kenar
        r = s / 2 - 4
        for i in range(36):
            a0 = i * 2 * math.pi / 36
            a1 = a0 + math.pi / 40
            draw.line([(cx + r * math.cos(a0), cy + r * math.sin(a0)), (cx + r * math.cos(a1), cy + r * math.sin(a1))],
                      fill=LOCKED_RING, width=max(3, s // 45))

    if state == "hidden":
        draw.text((cx, cy), "?", font=load_font(int(s * 0.42), bold=True), fill=LOCKED_RING, anchor="mm")
    else:
        icon = _icon(a.icon)
        if icon is not None:
            icon_size = int(s * 0.5)
            icon = icon.resize((icon_size, icon_size), Image.LANCZOS)
            if state == "locked":
                gray = ImageOps.grayscale(icon.convert("RGB")).convert("RGBA")
                gray.putalpha(icon.getchannel("A").point(lambda v: v * 0.35))
                icon = gray
            img.alpha_composite(icon, (int(cx - icon_size / 2), int(cy - icon_size / 2 - (s * 0.04 if a.tiered else 0))))
        if state == "earned" and a.tiered:
            draw = ImageDraw.Draw(img)
            gap = s * 0.11
            for i in range(tier):
                _star(draw, cx + (i - (tier - 1) / 2) * gap, cy + s * 0.3, s * 0.05, _rgb(tier_color(a, tier)))

    return img.resize((size + 4, size + 4), Image.LANCZOS)


# ---------------------------------------------------------------------------
# !başarımlar kartı
# ---------------------------------------------------------------------------

@dataclass
class SashEntry:
    achievement: Achievement
    tier: int          # 0 = kilitli
    visible: bool      # gizli ve kilitliyse False


@dataclass
class Goal:
    name: str
    text: str
    ratio: float


W = 1400
HEADER_H = 210
COLS = 10                      # satır sayısı rozet sayısına göre artar
CELL_W, CELL_H = 124, 166
PATCH = 88


def sash_size(count: int) -> tuple[int, int]:
    """Kartın boyutu: rozet sayısına göre yükseklik büyür."""
    rows = max(1, -(-count // COLS))
    band_w, band_h = COLS * CELL_W + 420, rows * CELL_H + 70
    rad = math.radians(6)
    rotated_h = int(band_w * math.sin(rad) + band_h * math.cos(rad))
    return W, HEADER_H + rotated_h - 40


def _fabric(width: int, height: int) -> Image.Image:
    band = Image.new("RGBA", (width, height), (*FABRIC, 255))
    draw = ImageDraw.Draw(band)
    # dokuma: ince çapraz çizgiler
    for x in range(-height, width, 7):
        draw.line([(x, 0), (x + height, height)], fill=(*_shade(FABRIC, 1.12), 255), width=1)
    for x in range(0, width + height, 11):
        draw.line([(x, 0), (x - height, height)], fill=(*_shade(FABRIC, 0.9), 255), width=1)
    # kenarlarda koyu şerit ve dikiş
    edge = _shade(FABRIC, 0.6)
    draw.rectangle((0, 0, width, 14), fill=(*edge, 255))
    draw.rectangle((0, height - 14, width, height), fill=(*edge, 255))
    for y in (24, height - 24):
        for x in range(0, width, 22):
            draw.line([(x, y), (x + 12, y)], fill=(198, 214, 196, 255), width=3)
    return band


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, width: int) -> list[str]:
    """En fazla iki satır; sığmayan kısım kısaltılır."""
    if text_width(draw, text, font) <= width or " " not in text:
        return [fit_text(draw, text, font, width)]
    words = text.split()
    for cut in range(len(words) - 1, 0, -1):
        first = " ".join(words[:cut])
        if text_width(draw, first, font) <= width:
            return [first, fit_text(draw, " ".join(words[cut:]), font, width)]
    return [fit_text(draw, text, font, width)]


def render_sash_card(name: str, avatar: bytes | None, entries: list[SashEntry], goals: list[Goal]) -> Image.Image:
    _, H = sash_size(len(entries))
    rows = max(1, -(-len(entries) // COLS))
    card = Image.new("RGBA", (W, H))
    draw = ImageDraw.Draw(card)
    for y in range(H):
        t = y / (H - 1)
        draw.line([(0, y), (W, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)) + (255,))
    paste_glow(card, (120, 40), 280, ACCENT, 40)
    paste_glow(card, (W - 120, H - 80), 300, "#47A9FF", 30)

    # Fular: rozetler önce düz banda dikilir, sonra bant çapraz döndürülür
    band_w = COLS * CELL_W + 420  # kumaş kenarlardan taşar, rozetler içeride kalır
    band_h = rows * CELL_H + 70
    band = _fabric(band_w, band_h)
    bdraw = ImageDraw.Draw(band)
    x0 = (band_w - COLS * CELL_W) // 2
    for i, e in enumerate(entries):
        col, row = i % COLS, i // COLS
        cx = x0 + col * CELL_W + CELL_W // 2
        top = 38 + row * CELL_H
        state = "earned" if e.tier > 0 else ("locked" if e.visible else "hidden")
        patch = draw_patch(e.achievement, max(e.tier, 1), PATCH, state=state)
        band.alpha_composite(patch, (cx - patch.width // 2, top))
        label = e.achievement.name if e.visible or e.tier else "???"
        f = load_font(15, bold=True)
        lines = _wrap(bdraw, label, f, CELL_W - 8)
        for j, line in enumerate(lines):
            bdraw.text((cx, top + PATCH + 16 + j * 18), line, font=f,
                       fill=TEXT if e.tier else (150, 166, 178), anchor="mm")
        if e.tier:
            bdraw.text((cx, top + PATCH + 17 + len(lines) * 18), tier_label(e.achievement, e.tier),
                       font=load_font(13, bold=True), fill=tier_color(e.achievement, e.tier), anchor="mm")
    rotated = band.rotate(6, resample=Image.BICUBIC, expand=True)
    shadow = Image.new("RGBA", rotated.size, (0, 0, 0, 0))
    shadow.putalpha(rotated.getchannel("A").point(lambda v: 110 if v else 0))
    shadow = shadow.filter(ImageFilter.GaussianBlur(12))
    ox, oy = (W - rotated.width) // 2, HEADER_H + (H - HEADER_H - rotated.height) // 2 + 10
    card.alpha_composite(shadow, (ox + 6, oy + 14))
    card.alpha_composite(rotated, (ox, oy))

    # Başlık
    card.alpha_composite(circle_avatar(avatar, 112), (44, 40))
    draw = ImageDraw.Draw(card)
    draw.ellipse((40, 36, 160, 156), outline=ACCENT, width=4)
    earned = sum(1 for e in entries if e.tier)
    hidden_found = sum(1 for e in entries if e.tier and e.achievement.hidden)
    hidden_total = sum(1 for e in entries if e.achievement.hidden)
    draw.text((186, 50), "BAŞARIMLAR", font=load_font(18, bold=True), fill=ACCENT)
    draw.text((186, 74), fit_text(draw, name, load_font(38, bold=True), 520), font=load_font(38, bold=True), fill=TEXT)
    draw.text((186, 124), f"{earned}/{len(entries)} rozet  ·  {hidden_found}/{hidden_total} gizli başarım bulundu",
              font=load_font(19), fill=MUTED)

    # Sıradaki hedefler
    if goals:
        gx = W - 44 - 520
        draw_translucent(card, [((gx, 34, W - 44, 34 + 34 + 46 * len(goals[:2])), 18, (14, 22, 40, 225), OUTLINE)])
        draw = ImageDraw.Draw(card)
        draw.text((gx + 20, 46), "SIRADAKİ HEDEFLER", font=load_font(15, bold=True), fill=ACCENT)
        for i, g in enumerate(goals[:2]):
            y = 74 + i * 46
            draw.text((gx + 20, y), fit_text(draw, g.name, load_font(17, bold=True), 230), font=load_font(17, bold=True), fill=TEXT)
            draw.text((W - 64, y), g.text, font=load_font(15), fill=MUTED, anchor="ra")
            bx0, bx1 = gx + 20, W - 64
            draw.rounded_rectangle((bx0, y + 24, bx1, y + 32), radius=4, fill=(26, 36, 58))
            fill_w = max(8, int((bx1 - bx0) * max(0.0, min(1.0, g.ratio))))
            draw.rounded_rectangle((bx0, y + 24, bx0 + fill_w, y + 32), radius=4, fill=ACCENT)

    draw.rounded_rectangle((6, 6, W - 7, H - 7), radius=22, outline=OUTLINE, width=2)
    return card


def png(card: Image.Image) -> io.BytesIO:
    buf = io.BytesIO()
    card.convert("RGB").save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf

