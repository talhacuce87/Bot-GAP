"""
achievements.py — Başarım tanımları ve hesaplama (Discord'dan bağımsız).

Kaynaklar:
- Olay kaydı (activity_log): işleyici yeni satırları kalıcı sayaçlara ekler
  (ekran paylaşımı, kamera, mikrofon kapalı süre, dosya/sticker/yanıt, düzenleme,
  takma ad, haftalık ikili ve üçlü ses süreleri…). Olay kaydı 365 günde silinse de
  sayaçlar kalır.
- Canlı sayaçlar (achievement_cog.py): kapıyı açan / ışıkları kapatan, sürgündeyken
  mesaj, yılbaşı/bayram.
- Anlık hesap: aktif günler, arkadaşlık süreleri, sunucuya katılma ve boost tarihi,
  haftalık/aylık özet ödülleri.

Spam'e açık başarımlar gizlidir: açılana kadar adı ve koşulu görünmez.
"""

from __future__ import annotations

import datetime
import json
from collections import defaultdict
from dataclasses import dataclass
from itertools import combinations

from database import STREAK_TZ

TIER_NAMES = ("Gümüş", "Altın", "Platin")
TIER_COLORS = ("#C9D3E0", "#FFC857", "#9BE8FF")
SINGLE_COLOR = "#58E1C1"

HOUR = 3600
FRIEND_TIER_SECONDS = 20 * HOUR   # "Arkadaş" tier'ı (bestfriend.FRIEND_TIERS)
DUO_WEEK_SECONDS = 30 * HOUR
LONG_MESSAGE_CHARS = 1000
EXPLORER_CHANNELS = 10
LOYAL_DAYS = 300
REVIVAL_BROKEN_MIN = 3            # bozulan seri en az bu kadar sürmüş olmalı
REVIVAL_TARGET = 14

# Bayramların ilk günleri (Diyanet takvimi; 2028 sonrası tahminidir, gerekirse güncelleyin)
BAYRAMS = (
    datetime.date(2027, 3, 9), datetime.date(2027, 5, 16),
    datetime.date(2028, 2, 26), datetime.date(2028, 5, 5),
    datetime.date(2029, 2, 14), datetime.date(2029, 4, 24),
    datetime.date(2030, 2, 4), datetime.date(2030, 4, 13),
)


@dataclass(frozen=True)
class Achievement:
    key: str
    name: str
    category: str
    icon: str                        # assets/badges/<icon>.png
    desc: str                        # {n}: kademe eşiği
    tiers: tuple[float, ...] = ()    # boşsa tek kademeli (koşul sağlanınca açılır)
    hidden: bool = False
    unit: str = ""
    manual: bool = False             # yalnızca yönetici verir

    @property
    def tiered(self) -> bool:
        return bool(self.tiers)

    @property
    def max_tier(self) -> int:
        return len(self.tiers) if self.tiers else 1

    def tier_for(self, value: float) -> int:
        if not self.tiers:
            return 1 if value >= 1 else 0
        return sum(1 for t in self.tiers if value >= t)

    def describe(self, tier: int | None = None) -> str:
        """tier: gösterilecek kademe (yoksa ilk/sıradaki)."""
        if not self.tiers:
            return self.desc
        index = min(max((tier or 1) - 1, 0), len(self.tiers) - 1)
        return self.desc.format(n=_fmt(self.tiers[index]))


def _fmt(n: float) -> str:
    return f"{int(n):,}".replace(",", ".")


ACHIEVEMENTS: tuple[Achievement, ...] = (
    # Ses
    Achievement("yayinci", "Yayıncı", "Ses", "1f3a5", "Seste {n} saat ekran paylaşımı", (100, 250, 500), unit="saat"),
    Achievement("yuzumuz_ortada", "Yüzümüz Ortada", "Ses", "1f4f8", "Kamerası açık {n} saat seste", (5, 25, 100), unit="saat"),
    Achievement("kulak_misafiri", "Kulak Misafiri", "Ses", "1f442", "Mikrofonu kapalı {n} saat seste", (50, 200, 500), unit="saat"),
    Achievement("kapiyi_acan", "Kapıyı Açan", "Ses", "1f6aa",
                "Boş ses kanalını {n} kez açıp arkadaşlarını beklemek", (40, 150, 400)),
    Achievement("isiklari_kapatan", "Işıkları Kapatan", "Ses", "1f526",
                "Bir muhabbetten {n} kez en son çıkan olmak", (40, 150, 400)),
    # Sohbet (gizli: spam'e açık)
    Achievement("meme_lordu", "Meme Lordu", "Sohbet", "1f5bc", "{n} kez görsel/dosya paylaşmak", (200, 1000, 3000), hidden=True),
    Achievement("sticker_canavari", "Sticker Canavarı", "Sohbet", "1f9f8", "{n} sticker göndermek", (300, 1000, 3000), hidden=True),
    Achievement("muhabbetin_ortasi", "Muhabbetin Ortası", "Sohbet", "1f4ac", "{n} mesajı birine yanıt olarak atmak",
                (500, 2000, 5000), hidden=True),
    Achievement("destan_yazdi", "Destan Yazdı", "Sohbet", "1f4dc", f"Tek mesajda {LONG_MESSAGE_CHARS:,}+ karakter".replace(",", "."),
                hidden=True),
    Achievement("gezgin", "Gezgin", "Sohbet", "1f9ed", f"{EXPLORER_CHANNELS} farklı kanalda yazmak", hidden=True),
    Achievement("ikinci_dusunce", "İkinci Düşünce", "Sohbet", "270f", "{n} kez mesaj düzenlemek", (100, 500, 1500), hidden=True),
    # Arkadaşlık
    Achievement("ayrilmaz_ikili", "Ayrılmaz İkili", "Arkadaşlık", "1f46b", "Aynı kişiyle bir haftada 30+ saat seste"),
    Achievement("uc_silahsorler", "Üç Silahşörler", "Arkadaşlık", "1f93a", "Aynı üç kişi birlikte {n} saat seste",
                (50, 200, 500), unit="saat"),
    Achievement("herkesin_kankasi", "Herkesin Kankası", "Arkadaşlık", "1f91d", "5 farklı kişiyle Arkadaş tier'ına ulaşmak"),
    # Haftalık özet / Wrapped
    Achievement("haftanin_ikilisi", "Haftanın İkilisi", "Özet", "1f465", "{n} kez haftanın ikilisi olmak", (1, 5, 15)),
    Achievement("haftanin_gece_kusu", "Haftanın Gece Kuşu", "Özet", "1f989", "{n} kez haftanın gece kuşu olmak", (1, 5, 15)),
    Achievement("wrapped_yildizi", "Wrapped Yıldızı", "Özet", "1f451", "{n} kez ayın MVP'si olmak", (1, 3, 6)),
    # Sadakat
    Achievement("gap_emektari", "Gap Emektarı", "Sadakat", "1f3d5", "Sunucuda {n} yıl", (1, 2, 3), unit="yıl"),
    Achievement("sadik", "Sadık", "Sadakat", "1f525", f"Son 365 günün {LOYAL_DAYS}'ünde aktif olmak"),
    Achievement("dirilis", "Diriliş", "Sadakat", "1f305", f"Bozulan seriyi yeniden {REVIVAL_TARGET} güne çıkarmak"),
    Achievement("sunucu_destekcisi", "Sunucu Destekçisi", "Sadakat", "1f48e", "Sunucuya {n} ay boost", (3, 6, 12), unit="ay"),
    Achievement("yilbasi_gecesi", "Yılbaşı Gecesi", "Özel Gün", "1f386", "Yılbaşı gecesi (23:30–00:30) seste olmak"),
    Achievement("bayram_ziyareti", "Bayram Ziyareti", "Özel Gün", "1f319", "Bayramın ilk günü seste olmak"),
    # Gizli
    Achievement("kimlik_krizi", "Kimlik Krizi", "Gizli", "1f3ad", "Takma adını {n} kez değiştirmek", (10, 30, 100), hidden=True),
    Achievement("firari", "Firari", "Gizli", "1f3c3", "Sürgündeyken {n} mesaj atmak", (50, 200, 500), hidden=True),
    Achievement("robotla_dertlesen", "Robotla Dertleşen", "Gizli", "1f916", "Yapay zekâyla {n} kez sohbet etmek",
                (100, 500, 2000), hidden=True),
    Achievement("fikir_babasi", "Fikir Babası", "Özel", "1f4a1", "Önerdiği bir özelliğin bota gelmesi", manual=True),
)
BY_KEY = {a.key: a for a in ACHIEVEMENTS}


def tier_label(achievement: Achievement, tier: int) -> str:
    return TIER_NAMES[tier - 1] if achievement.tiered and tier >= 1 else "Özel"


def tier_color(achievement: Achievement, tier: int) -> str:
    return TIER_COLORS[tier - 1] if achievement.tiered and tier >= 1 else SINGLE_COLOR


# ---------------------------------------------------------------------------
# Olay kaydından sayaçlar
# ---------------------------------------------------------------------------

def _meta(row) -> dict:
    raw = row["meta"]
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return {}


def week_key(ts: float) -> str:
    year, week, _ = datetime.datetime.fromtimestamp(ts, STREAK_TZ).isocalendar()
    return f"{year}-W{week:02d}"


def aggregate(rows, voice_interval: int) -> tuple[dict[tuple[int, int, str], float], set[tuple[int, int, str]]]:
    """
    Olay satırlarından sayaç artışları ve küme üyelikleri.
    Döner: ({(guild, user, anahtar): artış}, {(guild, user, "ch:<kanal>")}).
    """
    inc: dict[tuple[int, int, str], float] = defaultdict(float)
    sets: set[tuple[int, int, str]] = set()
    for row in rows:
        gid, uid, event = row["guild_id"], row["user_id"], row["event"]
        if gid is None or uid is None:
            continue
        if event == "xp_voice":
            meta = _meta(row)
            if meta.get("stream"):
                inc[gid, uid, "stream"] += voice_interval
            if meta.get("video"):
                inc[gid, uid, "video"] += voice_interval
            if meta.get("mute"):
                inc[gid, uid, "muted"] += voice_interval
            peers = sorted(set(meta.get("peers") or []))
            week = week_key(row["ts"])
            for peer in peers:
                inc[gid, uid, f"duo:{week}:{peer}"] += voice_interval
            for a, b in combinations(peers, 2):
                inc[gid, uid, f"trio:{a}-{b}"] += voice_interval
        elif event == "message":
            meta = _meta(row)
            if meta.get("cmd"):
                continue
            if meta.get("att"):
                inc[gid, uid, "att"] += 1
            if meta.get("stk"):
                inc[gid, uid, "stk"] += int(meta["stk"])
            if meta.get("reply"):
                inc[gid, uid, "reply"] += 1
            if (meta.get("len") or 0) >= LONG_MESSAGE_CHARS:
                inc[gid, uid, "long"] += 1
            if row["channel_id"]:
                sets.add((gid, uid, f"ch:{row['channel_id']}"))
        elif event == "message_edit":
            inc[gid, uid, "edit"] += 1
        elif event == "nick_change":
            inc[gid, uid, "nick"] += 1
        elif event == "ai_chat":
            inc[gid, uid, "ai"] += 1
    return dict(inc), sets


# ---------------------------------------------------------------------------
# Değerlendirme
# ---------------------------------------------------------------------------

def _days(days: list[str]) -> list[datetime.date]:
    return [datetime.date.fromisoformat(d) for d in days]


def revived(days: list[str]) -> bool:
    """Bozulan (en az REVIVAL_BROKEN_MIN günlük) bir seriden sonra yeniden REVIVAL_TARGET güne ulaşıldı mı?"""
    runs: list[int] = []
    prev = None
    for day in _days(days):
        if prev is not None and (day - prev).days == 1:
            runs[-1] += 1
        else:
            runs.append(1)
        prev = day
    broken_before = False
    for i, length in enumerate(runs):
        if broken_before and length >= REVIVAL_TARGET:
            return True
        if length >= REVIVAL_BROKEN_MIN and i < len(runs) - 1:  # sonrasında başka bir seri başladıysa bozulmuştur
            broken_before = True
    return False


@dataclass
class MemberFacts:
    """Bir üyenin başarımlar için gereken bilgileri."""
    counters: dict[str, float]
    awards: dict[str, int]
    active_days_365: int
    message_days: list[str]
    friends_20h: int
    joined_at: datetime.datetime | None
    premium_since: datetime.datetime | None
    now: datetime.datetime


def metric(key: str, f: MemberFacts) -> float:
    c = f.counters
    if key == "yayinci":
        return c.get("stream", 0) / HOUR
    if key == "yuzumuz_ortada":
        return c.get("video", 0) / HOUR
    if key == "kulak_misafiri":
        return c.get("muted", 0) / HOUR
    if key == "kapiyi_acan":
        return c.get("door", 0)
    if key == "isiklari_kapatan":
        return c.get("lights", 0)
    if key == "meme_lordu":
        return c.get("att", 0)
    if key == "sticker_canavari":
        return c.get("stk", 0)
    if key == "muhabbetin_ortasi":
        return c.get("reply", 0)
    if key == "destan_yazdi":
        return 1 if c.get("long", 0) >= 1 else 0
    if key == "gezgin":
        return 1 if sum(1 for k in c if k.startswith("ch:")) >= EXPLORER_CHANNELS else 0
    if key == "ikinci_dusunce":
        return c.get("edit", 0)
    if key == "ayrilmaz_ikili":
        return 1 if max((v for k, v in c.items() if k.startswith("duo:")), default=0) >= DUO_WEEK_SECONDS else 0
    if key == "uc_silahsorler":
        return max((v for k, v in c.items() if k.startswith("trio:")), default=0) / HOUR
    if key == "herkesin_kankasi":
        return 1 if f.friends_20h >= 5 else 0
    if key == "haftanin_ikilisi":
        return f.awards.get("week_duo", 0)
    if key == "haftanin_gece_kusu":
        return f.awards.get("week_night", 0)
    if key == "wrapped_yildizi":
        return f.awards.get("month_mvp", 0)
    if key == "gap_emektari":
        return (f.now - f.joined_at).days / 365.25 if f.joined_at else 0
    if key == "sadik":
        return 1 if f.active_days_365 >= LOYAL_DAYS else 0
    if key == "dirilis":
        return 1 if revived(f.message_days) else 0
    if key == "sunucu_destekcisi":
        return (f.now - f.premium_since).days / 30 if f.premium_since else 0
    if key == "yilbasi_gecesi":
        return c.get("newyear", 0)
    if key == "bayram_ziyareti":
        return c.get("bayram", 0)
    if key == "kimlik_krizi":
        return c.get("nick", 0)
    if key == "firari":
        return c.get("exile_msg", 0)
    if key == "robotla_dertlesen":
        return c.get("ai", 0)
    return 0  # fikir_babasi: yalnızca yönetici verir


def evaluate(facts: MemberFacts, current: dict[str, int]) -> dict[str, int]:
    """Yükselen başarımlar: {anahtar: yeni kademe}. Kademe hiçbir zaman düşmez."""
    out: dict[str, int] = {}
    for a in ACHIEVEMENTS:
        if a.manual:
            continue
        tier = a.tier_for(metric(a.key, facts))
        if tier > current.get(a.key, 0):
            out[a.key] = tier
    return out


def progress(a: Achievement, facts: MemberFacts, tier: int) -> tuple[float, float] | None:
    """Sıradaki kademe için (şu an, hedef); tamamlandıysa ya da ölçülemiyorsa None."""
    if not a.tiered or tier >= a.max_tier:
        return None
    return metric(a.key, facts), a.tiers[tier]


def special_day(now: datetime.datetime) -> str | None:
    """Şu an yılbaşı gecesi ya da bayramın ilk günü mü? (Türkiye saati)"""
    if (now.month, now.day) == (12, 31) and (now.hour, now.minute) >= (23, 30):
        return "newyear"
    if (now.month, now.day) == (1, 1) and (now.hour, now.minute) < (0, 30):
        return "newyear"
    if now.date() in BAYRAMS:
        return "bayram"
    return None
