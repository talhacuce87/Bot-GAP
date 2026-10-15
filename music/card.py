"""
music/card.py — "Şimdi çalıyor" kartı: solda kapak, sağda şarkı adı ve sanatçı.

Arka plan kapağın bulanık ve karartılmış hâlidir; kapak yoksa (indirilemediyse)
koyu bir gradient ve nota simgesi kullanılır. Kenarlar saydamdır, Discord'un
koyu temasında yuvarlak köşeli kart gibi görünür.
"""

from __future__ import annotations

import io
import logging
import re

import aiohttp
from PIL import Image, ImageDraw, ImageFilter, ImageOps

from cardutils import draw_translucent, fit_text, load_font, text_width
from font_utils import clean_text
from music.ytdl import Track, format_time

log = logging.getLogger("gap.music.card")

WIDTH, HEIGHT = 1200, 360
RADIUS = 28
COVER = 280
PAD = (HEIGHT - COVER) // 2
TEXT_X = PAD + COVER + 44
TEXT_W = WIDTH - TEXT_X - 48
MAX_COVER_BYTES = 5 * 1024 * 1024
FILENAME = "simdi-caliyor.png"

SOURCE_BADGES = {
    "youtube": ("YOUTUBE", (255, 48, 64)),
    "search": ("YOUTUBE", (255, 48, 64)),
    "spotify": ("SPOTIFY", (30, 215, 96)),
    "soundcloud": ("SOUNDCLOUD", (255, 119, 0)),
}

# DejaVu'da olmayan (kutucuk çıkan) yazılar: CJK, kana, hangul, tam genişlik
_UNSUPPORTED_RANGES = ((0x2E80, 0x9FFF), (0xAC00, 0xD7AF), (0xF900, 0xFAFF), (0xFF00, 0xFFEF), (0x20000, 0x3FFFF))


# YouTube başlıklarındaki "(Official Video)", "[4K Remaster]", "(Lyrics)" gibi ekler
_NOISE_RE = re.compile(
    r"\s*[(\[][^)\]]*\b(official|video|audio|lyrics?|4k|hd|hq|remaster(ed)?|klip|visuali[sz]er|mv|m/v)\b[^)\]]*[)\]]",
    re.I,
)


def card_text(text: str | None) -> str:
    text = clean_text(text or "")
    text = "".join(ch for ch in text if not any(a <= ord(ch) <= b for a, b in _UNSUPPORTED_RANGES))
    return " ".join(text.split()).strip(" -–—·|")


def split_title(track: Track, *, plain: bool = False) -> tuple[str, str]:
    """
    Gösterilecek (şarkı adı, sanatçı). plain=True mesaj metni içindir: Discord her
    yazıyı çizebildiği için emoji/CJK temizlenmez, sadece YouTube ekleri atılır.
    """
    clean = (lambda t: " ".join((t or "").split())) if plain else card_text
    title = clean(track.title)
    artist = clean(track.artist)
    if track.source in {"youtube", "search"}:
        title = _NOISE_RE.sub("", title).strip() or title
        artist = re.sub(r"\s*-\s*Topic$|VEVO$", "", artist).strip()
        if " - " in title:  # "Sanatçı - Şarkı"
            artist, title = (part.strip() for part in title.split(" - ", 1))
    if artist and artist.lower() in title.lower():
        artist = ""
    return title or "Şimdi çalıyor", artist


async def fetch_cover(url: str | None) -> bytes | None:
    if not url:
        return None
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    return None
                data = bytearray()
                async for chunk in resp.content.iter_chunked(64 * 1024):
                    data += chunk
                    if len(data) > MAX_COVER_BYTES:
                        return None
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return None
    return bytes(data) or None


def _open_cover(data: bytes | None) -> Image.Image | None:
    if not data:
        return None
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError):
        return None
    # YouTube küçük resimlerindeki siyah bantları (letterbox) kırp
    bbox = img.convert("L").point(lambda v: 255 if v > 18 else 0).getbbox()
    if bbox and (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > img.width * img.height * 0.3:
        img = img.crop(bbox)
    return img


def _rounded(img: Image.Image, radius: int) -> Image.Image:
    img = img.convert("RGBA")
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius=radius, fill=255)
    img.putalpha(mask)
    return img


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int, max_lines: int) -> list[str]:
    words, lines, line = text.split(), [], ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if text_width(draw, candidate, font) <= max_width or not line:
            line = candidate
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = fit_text(draw, lines[-1] + " …", font, max_width)
    return [fit_text(draw, ln, font, max_width) for ln in lines]


def render_card(track: Track, cover_bytes: bytes | None) -> io.BytesIO:
    cover = _open_cover(cover_bytes)

    # Arka plan
    if cover is not None:
        bg = ImageOps.fit(cover, (WIDTH // 4, HEIGHT // 4)).filter(ImageFilter.GaussianBlur(6)).resize((WIDTH, HEIGHT))
        card = bg.convert("RGBA")
        card.alpha_composite(Image.new("RGBA", (WIDTH, HEIGHT), (12, 12, 16, 200)))
    else:
        card = Image.new("RGBA", (WIDTH, HEIGHT), (24, 20, 30, 255))
        glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse((-200, -200, 600, 600), fill=(0, 212, 255, 40))
        card.alpha_composite(glow.filter(ImageFilter.GaussianBlur(80)))

    # Kapak (gölgesiyle)
    shadow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((PAD + 4, PAD + 8, PAD + COVER + 4, PAD + COVER + 8), radius=20, fill=(0, 0, 0, 150))
    card.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(10)))
    if cover is not None:
        art = ImageOps.fit(cover, (COVER, COVER), method=Image.LANCZOS)
    else:
        art = Image.new("RGB", (COVER, COVER), (40, 36, 52))
        note_font = load_font(150, bold=True)
        ImageDraw.Draw(art).text((COVER // 2, COVER // 2), "♪", font=note_font, fill=(0, 212, 255), anchor="mm")
    card.alpha_composite(_rounded(art, 20), (PAD, PAD))

    draw = ImageDraw.Draw(card)

    # Başlık (gerekirse 2 satır), sanatçı
    title, artist = split_title(track)
    title_lines: list[str] = []
    for size in range(56, 39, -2):
        font = load_font(size, bold=True)
        if text_width(draw, title, font) <= TEXT_W:
            title_lines = [title]
            break
    else:
        font = load_font(42, bold=True)
        title_lines = _wrap(draw, title, font, TEXT_W, 2)
    line_h = font.size + 10

    artist_font = load_font(32)
    meta_font = load_font(24, bold=True)
    block_h = line_h * len(title_lines) + (48 if artist else 0) + 62
    y = (HEIGHT - block_h) // 2 + 4
    for line in title_lines:
        draw.text((TEXT_X, y), line, font=font, fill=(255, 255, 255))
        y += line_h
    if artist:
        draw.text((TEXT_X, y + 4), fit_text(draw, artist, artist_font, TEXT_W), font=artist_font, fill=(190, 190, 200))
        y += 48

    # Alt satır: kaynak etiketi + süre
    y += 22
    label, color = SOURCE_BADGES.get("soundcloud" if track.fallback == "soundcloud" else track.source, ("MÜZİK", (0, 212, 255)))
    badge_w = int(text_width(draw, label, meta_font)) + 32
    draw_translucent(card, [((TEXT_X, y, TEXT_X + badge_w, y + 40), 20, (*color, 60), None)])
    draw = ImageDraw.Draw(card)
    draw.text((TEXT_X + badge_w // 2, y + 20), label, font=meta_font, fill=color, anchor="mm")
    if track.duration:
        draw.text((TEXT_X + badge_w + 18, y + 20), format_time(track.duration), font=meta_font,
                  fill=(170, 170, 180), anchor="lm")

    # Köşede küçük imza
    sig_font = load_font(20, bold=True)
    draw.text((WIDTH - 28, 24), "THE GAP", font=sig_font, fill=(150, 150, 160), anchor="ra")

    card = _rounded(card, RADIUS)
    buf = io.BytesIO()
    card.save(buf, format="PNG", optimize=True)
    buf.seek(0)
    return buf
