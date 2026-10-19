"""
textutils.py — Türkçe karakterlere duyarsız karşılaştırma.

Üyeler komutları ve isimleri bazen Türkçe karakterle (!başarımlar), bazen karakterleri
düzleştirerek (!basarimlar), bazen karışık (!basarımlar) yazıyor. fold() hepsini aynı
biçime indirir.
"""

from __future__ import annotations

import re

_TR = str.maketrans("çğıöşüÇĞİÖŞÜâîûÂÎÛ", "cgiosuCGIOSUaiuAIU")


def fold(text: str) -> str:
    """Küçük harf, Türkçe karakterler düz, boşluk/altçizgi/noktalama yok: "Fikir Babası" → "fikirbabasi"."""
    return re.sub(r"[\W_]+", "", text.translate(_TR).casefold())
