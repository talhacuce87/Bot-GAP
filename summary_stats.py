"""
summary_stats.py — Haftalık özet ve aylık Wrapped için istatistikler.

Olay kaydındaki (activity_log) satırlardan hesaplanır; Discord'a dokunmaz:
- XP: xp_message + xp_voice + xp_streak_bonus (admin değişiklikleri sayılmaz)
- Mesaj: komut olmayan "message" olayları (saat/gün/kanal dağılımıyla)
- Ses: xp_voice olayları; her biri bir ses XP aralığıdır (yanında en az bir kişi varken,
  sağır değilken). "peers" alanından kimin kiminle seste olduğu çıkarılır.
- Seviye: level_up olayları
"""

from __future__ import annotations

import datetime
import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from database import STREAK_TZ

XP_EVENTS = ("xp_message", "xp_voice", "xp_streak_bonus")
SUMMARY_EVENTS = (*XP_EVENTS, "message", "level_up")
NIGHT_HOURS = range(0, 5)  # 00:00–04:59 arası mesajlar "gece"

WEEKDAYS = ("Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar")
MONTHS = ("Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül",
          "Ekim", "Kasım", "Aralık")


# ---------------------------------------------------------------------------
# Dönemler (Türkiye saati)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Period:
    kind: str  # week | month
    start: datetime.datetime
    end: datetime.datetime

    @property
    def key(self) -> str:
        """Dönemin kimliği; aynı dönem için ikinci kez paylaşım/kullanım engellenir."""
        if self.kind == "week":
            year, week, _ = self.start.isocalendar()
            return f"{year}-W{week:02d}"
        return f"{self.start.year}-{self.start.month:02d}"

    @property
    def label(self) -> str:
        if self.kind == "month":
            return f"{MONTHS[self.start.month - 1]} {self.start.year}"
        last = self.end - datetime.timedelta(seconds=1)
        if self.start.month == last.month:
            return f"{self.start.day}–{last.day} {MONTHS[last.month - 1]}"
        return f"{self.start.day} {MONTHS[self.start.month - 1]} – {last.day} {MONTHS[last.month - 1]}"


def now_local() -> datetime.datetime:
    return datetime.datetime.now(STREAK_TZ)


def is_week_end(day: datetime.date) -> bool:
    return day.weekday() == 6  # pazar


def is_month_end(day: datetime.date) -> bool:
    return (day + datetime.timedelta(days=1)).day == 1


def week_period(now: datetime.datetime) -> Period:
    """Pazartesi 00:00'dan şu ana."""
    start = (now - datetime.timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return Period("week", start, now)


def month_period(now: datetime.datetime) -> Period:
    """Ayın 1'i 00:00'dan şu ana."""
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return Period("month", start, now)


# ---------------------------------------------------------------------------
# Hesaplama
# ---------------------------------------------------------------------------

@dataclass
class PeriodStats:
    xp: Counter = field(default_factory=Counter)
    messages: Counter = field(default_factory=Counter)
    night_messages: Counter = field(default_factory=Counter)
    voice_seconds: Counter = field(default_factory=Counter)
    level_ups: Counter = field(default_factory=Counter)
    pairs: Counter = field(default_factory=Counter)  # (küçük_id, büyük_id) → birlikte saniye
    hours: dict[int, Counter] = field(default_factory=lambda: defaultdict(Counter))      # üye → saat → mesaj
    weekdays: dict[int, Counter] = field(default_factory=lambda: defaultdict(Counter))   # üye → gün → mesaj
    guild_hours: Counter = field(default_factory=Counter)
    guild_weekdays: Counter = field(default_factory=Counter)

    @property
    def active_members(self) -> set[int]:
        return set(self.xp) | set(self.messages) | set(self.voice_seconds)

    def rank(self, user_id: int) -> int | None:
        """Dönemde kazanılan XP'ye göre sıra (1 tabanlı)."""
        if self.xp.get(user_id, 0) <= 0:
            return None
        ordered = sorted(self.xp.items(), key=lambda kv: (-kv[1], kv[0]))
        return next(i for i, (uid, _) in enumerate(ordered, start=1) if uid == user_id)

    def partners(self, user_id: int) -> Counter:
        out: Counter = Counter()
        for (a, b), seconds in self.pairs.items():
            if a == user_id:
                out[b] += seconds
            elif b == user_id:
                out[a] += seconds
        return out


def _meta(row) -> dict:
    raw = row["meta"]
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return {}


def compute(rows, voice_interval_seconds: int, *, bots: set[int] = frozenset()) -> PeriodStats:
    stats = PeriodStats()
    for row in rows:
        uid = row["user_id"]
        if uid is None or uid in bots:
            continue
        event = row["event"]
        if event in XP_EVENTS:
            stats.xp[uid] += int(row["amount"] or 0)
        if event == "xp_voice":
            stats.voice_seconds[uid] += voice_interval_seconds
            for peer in _meta(row).get("peers") or []:
                if uid < peer and peer not in bots:  # her ikili yalnızca bir kez sayılır
                    stats.pairs[(uid, peer)] += voice_interval_seconds
        elif event == "message":
            if _meta(row).get("cmd"):
                continue
            when = datetime.datetime.fromtimestamp(row["ts"], STREAK_TZ)
            stats.messages[uid] += 1
            stats.hours[uid][when.hour] += 1
            stats.weekdays[uid][when.weekday()] += 1
            stats.guild_hours[when.hour] += 1
            stats.guild_weekdays[when.weekday()] += 1
            if when.hour in NIGHT_HOURS:
                stats.night_messages[uid] += 1
        elif event == "level_up":
            stats.level_ups[uid] += 1
    return stats


def period_awards(stats: PeriodStats, kind: str) -> dict[str, list[int]]:
    """Başarımlara sayılan dönem ödülleri: haftanın ikilisi ve gece kuşu, ayın MVP'si."""
    awards: dict[str, list[int]] = {}
    if kind == "week":
        if duo := top(stats.pairs):
            awards["week_duo"] = list(duo[0][0])
        if night := top(stats.night_messages):
            awards["week_night"] = [night[0][0]]
    elif mvp := top(stats.xp):
        awards["month_mvp"] = [mvp[0][0]]
    return awards


def top(counter: Counter, n: int = 1) -> list[tuple[int, int]]:
    """En yüksek n kayıt; eşitlikte küçük ID önce (sonuç kararlı olsun)."""
    return sorted(((k, v) for k, v in counter.items() if v > 0), key=lambda kv: (-kv[1], kv[0]))[:n]


def persona(stats: PeriodStats, user_id: int) -> tuple[str, str]:
    """Kişisel kart için eğlenceli bir etiket: (ad, açıklama)."""
    msgs = stats.messages.get(user_id, 0)
    voice_min = stats.voice_seconds.get(user_id, 0) / 60
    night = stats.night_messages.get(user_id, 0)
    partners = len(stats.partners(user_id))
    if msgs >= 20 and night / msgs >= 0.3:
        return "Gece Kuşu", "Mesajlarının çoğu gece yarısından sonra"
    if partners >= 5:
        return "Sosyal Kelebek", f"{partners} farklı kişiyle seste takıldın"
    if voice_min >= 600 and voice_min >= msgs * 3:
        return "Ses Bağımlısı", "Yazmaktan çok konuşmayı seviyorsun"
    if msgs >= 200 and msgs > voice_min:
        return "Klavye Delikanlısı", "Sohbetin bel kemiği sensin"
    if msgs + voice_min < 30:
        return "Sessiz Gölge", "Az görünüyorsun ama hep oradasın"
    return "Dengeli Gapçı", "Hem yazıyor hem konuşuyorsun"


def format_hours(seconds: int) -> str:
    seconds = int(seconds)
    hours, rem = divmod(seconds, 3600)
    minutes = rem // 60
    if hours:
        return f"{hours}sa {minutes}dk" if minutes else f"{hours}sa"
    return f"{minutes}dk"


def hour_range(hour: int) -> str:
    return f"{hour:02d}:00–{(hour + 1) % 24:02d}:00"
