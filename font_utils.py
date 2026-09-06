"""
font_utils.py — Görsel kartlar için metin temizleme ve font yardımcıları.

DejaVuSans gibi standart fontların desteklemediği emoji ve özel sembolleri
temizleyerek kartlarda boş kutucuk ("tofu" []) oluşmasını engeller.
"""

from __future__ import annotations

import unicodedata
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import discord


def is_emoji_or_unsupported(ch: str) -> bool:
    """Karakterin emoji veya DejaVu tarafından desteklenmeyen sembol olup olmadığını kontrol eder."""
    cp = ord(ch)
    cat = unicodedata.category(ch)

    # Unicode emoji ve piktogram aralıkları
    if (
        0x1F000 <= cp <= 0x1FAFF  # Emojiler, semboller, piktogramlar
        or 0x2600 <= cp <= 0x27BF  # Çeşitli semboller ve dingbat'ler (⚡, ☕, vs.)
        or 0xFE00 <= cp <= 0xFE0F  # Varyasyon seçiciler
        or 0x1F1E0 <= cp <= 0x1F1FF  # Bayraklar
        or 0x200D == cp  # Zero-width joiner
        or 0x200B <= cp <= 0x200F  # Görünmez boşluklar
        or cat in ("Cs", "So", "Cn")  # Surrogate, diğer semboller ve tanımsızlar
    ):
        return True
    return False


def clean_text(text: str) -> str:
    """
    Fontta kutu [] oluşturacak emojileri ve geçersiz glifleri temizler,
    Türkçe karakterleri ve standart metinleri korur.
    """
    if not text:
        return ""

    cleaned_chars = [ch for ch in text if not is_emoji_or_unsupported(ch)]
    result = "".join(cleaned_chars).strip()
    # Fazladan boşlukları teke indir
    return " ".join(result.split())


def clean_display_name(member: discord.Member | None, fallback: str = "Kullanıcı") -> str:
    """
    Kullanıcı adını veya sunucu takma adını temizler.
    Tüm isim emojiden oluşuyorsa kullanıcı adına veya varsayılana döner.
    """
    if member is None:
        return fallback

    display = clean_text(getattr(member, "display_name", ""))
    if display:
        return display

    name = clean_text(getattr(member, "name", ""))
    if name:
        return name

    user_id = getattr(member, "id", None)
    if user_id:
        return f"Kullanıcı {str(user_id)[-4:]}"

    return fallback
