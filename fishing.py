"""
fishing.py — GAP Dünyası'ndaki gölde günde bir kez balık tutma.

Tutulan balığın nadirliği süreli 2x XP boost'u verir (Yaygın 1 saat … Efsanevi 24 saat).
Boost, yöneticinin !boost'undan ayrı tutulur; geçerli çarpan ikisinin büyüğüdür
ve yeni balık süreyi üstüne ekler. Her gün art arda tutmak efsanevi ihtimalini
+%0.1 artırır (en fazla %5); fark yaygından düşülür. Gün sınırı Türkiye saatidir.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Callable

import database as db

LUCK_PER_DAY = 0.1  # yüzde puan
LUCK_MAX = 4.5      # efsanevi %0.5 + 4.5 = %5


@dataclass(frozen=True)
class Rarity:
    key: str
    label: str
    fish: str
    chance: float  # yüzde
    hours: int


# Nadirden yaygına; roll() bu sırayla bakar.
RARITIES = (
    Rarity("legendary", "Efsanevi", "Altın Sazan", 0.5, 24),
    Rarity("epic", "Epik", "Yayın Balığı", 2.0, 8),
    Rarity("rare", "Nadir", "Turna", 7.5, 4),
    Rarity("uncommon", "Az Bulunur", "Kızılkanat", 20.0, 2),
    Rarity("common", "Yaygın", "Sazan", 70.0, 1),
)


# Yaygından nadire sıra: common 0 … legendary 4 (duyuru eşiği karşılaştırması için)
RANK = {r.key: i for i, r in enumerate(reversed(RARITIES))}

ANNOUNCE_EMOJI = {"legendary": "🌟", "epic": "💜", "rare": "💙", "uncommon": "💚", "common": "🐟"}


def announce_text(mention: str, result: dict) -> str:
    """Discord balık kanalına gidecek duyuru metni."""
    emoji = ANNOUNCE_EMOJI.get(result["rarity"], "🎣")
    head = f"{emoji} **EFSANEVİ!** " if result["rarity"] == "legendary" else f"{emoji} "
    return (
        f"{head}{mention} gölden **{result['label']} {result['fish']}** çıkardı! "
        f"⚡ {result['hours']} saat 2x XP · 🔥 {result['streak']} günlük seri"
    )


def luck_bonus(prev_streak: int) -> float:
    """Dün dahil art arda balık tutulan gün sayısına göre efsanevi ihtimaline eklenen yüzde puan."""
    return min(max(prev_streak, 0) * LUCK_PER_DAY, LUCK_MAX)


def chances(prev_streak: int) -> dict[str, float]:
    luck = luck_bonus(prev_streak)
    out = {r.key: r.chance for r in RARITIES}
    out["legendary"] += luck
    out["common"] -= luck
    return out


def roll(prev_streak: int, r: float) -> Rarity:
    """r ∈ [0, 1): nadirden yaygına birikimli yüzdelerle seçer."""
    p = chances(prev_streak)
    x = r * 100
    acc = 0.0
    for rarity in RARITIES:
        acc += p[rarity.key]
        if x < acc:
            return rarity
    return RARITIES[-1]


async def catch(guild_id: int, user_id: int, rand: Callable[[], float] = random.random) -> dict | None:
    """Bugün ilk kez tutuyorsa balığı tutar ve boost'u uygular; zaten tuttuysa None."""
    result = await db.record_fish_catch(
        guild_id, user_id, lambda prev: roll(prev, rand()), lambda rarity: rarity.hours * 3600,
    )
    if result is None:
        return None
    rarity, streak, boost_until = result
    return {
        "rarity": rarity.key,
        "label": rarity.label,
        "fish": rarity.fish,
        "hours": rarity.hours,
        "streak": streak,
        "luck": round(luck_bonus(streak - 1), 1),
        "boost_until": boost_until,
    }
