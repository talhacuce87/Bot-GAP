"""
outfit.py — Chibi karakter kıyafeti: doğrulama, kilitli parçalar ve kayıt.

Kıyafet: {"hair": parça, "tops": …, "bottoms", "shoes", "hats", "glasses", "facial",
          "colors": {"skin"|"hair"|"eye": "#rrggbb"}}. Boş/None slot = o parça yok
(üst/alt boşsa temel atlet/şort görünür). Parça kimlikleri assets/chibi/chibi.json'dan.

Hem !karakter (character_cog.py) hem dünyadaki gardırop (world_cog.py → /internal/outfit)
aynı kuralları buradan kullanır.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

import database as db

MANIFEST_PATH = Path(__file__).resolve().parent / "assets" / "chibi" / "chibi.json"

SLOTS = ("hair", "tops", "bottoms", "shoes", "hats", "glasses", "facial")
COLOR_KEYS = ("skin", "hair", "eye")
SLOT_LABELS = {
    "hair": "Saç", "tops": "Üst", "bottoms": "Alt", "shoes": "Ayakkabı",
    "hats": "Şapka", "glasses": "Gözlük", "facial": "Sakal/Bıyık",
}

# Herkese açık olmayan parçalar: açılması için gereken seviye. Kilidi kaldırmak için satırı sil.
LOCKED: dict[str, int] = {
    "top_levelup": 5,
    "top_xp_hoodie": 10,
}

DEFAULT_OUTFIT: dict = {
    "hair": "hair_kisa_doku",
    "tops": "top_tisort",
    "bottoms": "bottom_kot",
    "shoes": "shoes_sneaker",
    "hats": None,
    "glasses": None,
    "facial": None,
    "colors": {},
}

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


@lru_cache(maxsize=1)
def manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def parts_in(slot: str) -> dict[str, dict]:
    """Bir slotta seçilebilir parçalar (temel atlet/şort hariç)."""
    return {pid: p for pid, p in manifest()["parts"].items() if p["cat"] == slot and not pid.startswith("base")}


def label(part_id: str | None) -> str:
    if not part_id:
        return "—"
    return manifest()["parts"].get(part_id, {}).get("label", part_id)


def is_unlocked(part_id: str, level: int) -> bool:
    return level >= LOCKED.get(part_id, 0)


def validate(raw: dict | None, level: int) -> tuple[dict, list[str]]:
    """
    Gelen kıyafeti temizler: bilinmeyen/yanlış slottaki parçalar ve kilitli parçalar
    varsayılana döner, renkler #rrggbb değilse atılır. Döner: (temiz kıyafet, atılanlar).
    """
    raw = raw if isinstance(raw, dict) else {}
    clean: dict = {}
    dropped: list[str] = []
    for slot in SLOTS:
        value = raw.get(slot, DEFAULT_OUTFIT[slot])
        if value in (None, ""):
            clean[slot] = None
        elif isinstance(value, str) and value in parts_in(slot):
            if is_unlocked(value, level):
                clean[slot] = value
            else:
                clean[slot] = DEFAULT_OUTFIT[slot]
                dropped.append(f"{label(value)} (seviye {LOCKED[value]})")
        else:
            clean[slot] = DEFAULT_OUTFIT[slot]
            dropped.append(str(value))
    colors = raw.get("colors") if isinstance(raw.get("colors"), dict) else {}
    clean["colors"] = {k: colors[k].lower() for k in COLOR_KEYS if isinstance(colors.get(k), str) and _HEX.match(colors[k])}
    return clean, dropped


async def load(guild_id: int, user_id: int, level: int) -> dict:
    """Kayıtlı kıyafet (kilidi sonradan kapanan parçalar varsayılana döner); yoksa varsayılan."""
    saved = await db.get_outfit(guild_id, user_id)
    return validate(saved, level)[0] if saved else validate(None, level)[0]


async def save(guild_id: int, user_id: int, raw: dict, level: int) -> tuple[dict, list[str]]:
    clean, dropped = validate(raw, level)
    await db.set_outfit(guild_id, user_id, clean)
    return clean, dropped
