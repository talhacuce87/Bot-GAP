"""
ai/textutil.py — Türkçe duyarlı metin normalizasyonu ve kaba token tahmini.

FTS5'in unicode61 tokenizer'ı Türkçe büyük/küçük harf kurallarını bilmez:
"IŞIK" → "işik", "ışık" → "ısık" olur ve eşleşmez. Bu yüzden hem indekslenen
metni hem sorguyu aynı fonksiyondan geçirip ASCII'ye yakın bir forma
katlıyoruz (ı/İ/I → i, ş → s, ğ → g, ç → c, ö → o, ü → u).
"""

from __future__ import annotations

import re
import unicodedata

_TR_MAP = str.maketrans({
    "İ": "i", "I": "i", "ı": "i",
    "Ş": "s", "ş": "s",
    "Ğ": "g", "ğ": "g",
    "Ç": "c", "ç": "c",
    "Ö": "o", "ö": "o",
    "Ü": "u", "ü": "u",
    "Â": "a", "â": "a", "Î": "i", "î": "i", "Û": "u", "û": "u",
})

_WS_RE = re.compile(r"\s+")
_DISCORD_TOKEN_RE = re.compile(r"<(?:@[!&]?|#|a?:\w+:)\d+>")


def fold(text: str) -> str:
    """Türkçe harfleri katlar, kalan aksanları siler, küçük harfe çevirir."""
    text = text.translate(_TR_MAP)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return text.lower()


def normalize_for_index(text: str) -> str:
    """İndekslenecek arama metni: mention/emoji ID'leri atılır, katlanır."""
    text = _DISCORD_TOKEN_RE.sub(" ", text)
    return _WS_RE.sub(" ", fold(text)).strip()


def collapse_ws(text: str) -> str:
    return _WS_RE.sub(" ", text).strip()


def estimate_tokens(text: str) -> int:
    """
    Kaba ve bilerek kötümser token tahmini. Türkçe eklemeli bir dil olduğu
    için BPE tokenizer'lar İngilizceden daha fazla token üretir; ~3 karakter
    = 1 token varsayımı çoğu model için üst sınıra yakındır. Kesin değildir.
    """
    if not text:
        return 0
    return len(text) // 3 + 1


def truncate(text: str, max_chars: int, suffix: str = "…") -> str:
    if len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - len(suffix))].rstrip() + suffix
