"""
world_quests.py — GAP Dünyası günlük görevleri ve dünya sayaçları.

Her üyeye her gün (Türkiye saati) havuzdan 3 görev düşer (görev başına 2–15 XP: 3 görev ≈ seste
yarım-bir saat; ses 2 dakikada 1 XP); seçim üye ve güne göre sabittir,
gün içinde değişmez. Dünya sunucusu olayları (`/internal/world_event`) bildirir: görev ilerler,
tamamlanınca XP verilir. Bazı olaylar profil kartındaki sayaçları da artırır (gol, galibiyet…);
tank vuruşu ve galibiyetler aylık sezon anahtarına da yazılır.
"""

from __future__ import annotations

import datetime
import random
from dataclasses import dataclass

import database as db

QUESTS_PER_DAY = 3


@dataclass(frozen=True)
class Quest:
    key: str
    title: str
    event: str
    target: int
    xp: int


QUESTS: tuple[Quest, ...] = (
    Quest("grill", "Mangalda 3 kez şiş çevir", "grill", 3, 6),
    Quest("tea", "Kahvehanede 2 çay söyle", "tea", 2, 4),
    Quest("fish", "Gölde balık tut", "fish", 1, 5),
    Quest("emote", "5 kez emote yap", "emote", 5, 3),
    Quest("goal", "Futbolda gol at", "goal", 1, 10),
    Quest("game_play", "Kahvehanede bir oyun oyna", "game_play", 1, 6),
    Quest("game_win", "Kahvehanede bir oyun kazan", "game_win", 1, 15),
    Quest("tank_hit", "Tankla 2 isabet", "tank_hit", 2, 8),
    Quest("photo", "Fotoğraf çekip Discord'a gönder", "photo", 1, 4),
    Quest("five", "Birine beşlik çak", "five", 1, 3),
    Quest("hug", "Birine sarıl", "hug", 1, 3),
    Quest("sakura", "Sakura Bahçesi'ni ziyaret et", "sakura", 1, 2),
    Quest("tag_play", "Ebelemece ya da saklambaç oyna", "tag_play", 1, 8),
    Quest("ride", "Bisiklet ya da kaykayla 300 m git", "ride", 300, 5),
    Quest("stage", "Sahneye çık ya da DJ ol", "stage", 1, 5),
)
BY_KEY = {q.key: q for q in QUESTS}
EVENTS = {q.event for q in QUESTS}

# Profil kartında gösterilen sayaçlar (olay → sayaç)
STAT_KEYS = {
    "goal": "goals",
    "game_win": "wins",
    "game_play": "games",
    "tank_hit": "tank_hits",
    "tank_kill": "tank_kills",
    "tank_win": "tank_wins",
    "photo": "photos",
    "five": "fives",
    "hug": "hugs",
    "tag_win": "tag_wins",
    "ride": "ride_m",
}
# Aylık sezona da yazılan sayaçlar
SEASON_KEYS = {"tank_kill": "tank_kills", "tank_win": "tank_wins", "goal": "goals"}
# Görev dışı ama kabul edilen olaylar
EXTRA_EVENTS = {"tank_kill", "tank_win", "tag_win"}


def season_key(when: datetime.date) -> str:
    return when.strftime("%Y-%m")


def daily(user_id: int, day: datetime.date) -> list[Quest]:
    """Üyenin o günkü görevleri: üye ve güne göre sabit, sırası da sabit."""
    rng = random.Random(f"{user_id}:{day.isoformat()}")
    return rng.sample(QUESTS, QUESTS_PER_DAY)


async def quest_status(guild_id: int, user_id: int, day: datetime.date) -> list[dict]:
    saved = await db.get_world_quests(guild_id, user_id, day.isoformat())
    out = []
    for q in daily(user_id, day):
        progress, done = saved.get(q.key, (0, False))
        out.append({"key": q.key, "title": q.title, "target": q.target, "progress": progress, "done": done, "xp": q.xp})
    return out


async def record(guild_id: int, user_id: int, event: str, amount: int, day: datetime.date) -> list[Quest]:
    """
    Olayı işler: sayaçlar artar, günün görevleri ilerler. Bu olayla tamamlanan görevleri döner
    (XP'yi çağıran verir). Bilinmeyen olay hiçbir şey yapmaz.
    """
    if (event not in EVENTS and event not in EXTRA_EVENTS) or amount <= 0:
        return []
    deltas: dict[str, int] = {}
    if event in STAT_KEYS:
        deltas[STAT_KEYS[event]] = amount
    if event in SEASON_KEYS:
        deltas[f"s:{season_key(day)}:{SEASON_KEYS[event]}"] = amount
    await db.add_world_stats(guild_id, user_id, deltas)
    todays = daily(user_id, day)
    amounts = {q.key: amount for q in todays if q.event == event}
    if not amounts:
        return []
    done = await db.advance_world_quests(guild_id, user_id, day.isoformat(), [(q.key, q.target) for q in todays], amounts)
    return [BY_KEY[k] for k in done]
