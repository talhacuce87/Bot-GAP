"""
achievements.py — Başarım tanımları ve hesaplama (Discord'dan bağımsız).

Kaynaklar:
- Olay kaydı (activity_log): işleyici yeni satırları kalıcı sayaçlara ekler
  (ekran paylaşımı, kamera, mikrofon kapalı süre, dosya/sticker/yanıt, düzenleme,
  takma ad, haftalık ikili ve üçlü ses süreleri, en uzun oturum, gece sesi, kalabalık
  ses günleri, XP'li/sabah/silinen mesajlar, yeni gelenlerle ses, sürgün geçmişi…).
  Olay kaydı 365 günde silinse de sayaçlar kalır.
- Canlı sayaçlar (achievement_cog.py): kapıyı açan / ışıkları kapatan, sürgündeyken
  mesaj, günün ilk mesajı, özel günlerde seste olmak.
- Anlık hesap: aktif günler, seriler, seviye, toplam ses, arkadaşlık süreleri, sunucuya
  katılma ve boost tarihi, haftalık/aylık özet ödülleri, diğer başarımlar (koleksiyon).

Spam'e açık başarımlar gizlidir: açılana kadar adı ve koşulu görünmez.
"""

from __future__ import annotations

import datetime
import json
from collections import defaultdict
from dataclasses import dataclass, field
from itertools import combinations

from database import STREAK_TZ
from textutils import fold

TIER_NAMES = ("Gümüş", "Altın", "Platin")
TIER_COLORS = ("#C9D3E0", "#FFC857", "#9BE8FF")
SINGLE_COLOR = "#58E1C1"

HOUR = 3600
DAY = 86400
FRIEND_TIER_SECONDS = 20 * HOUR   # "Arkadaş" tier'ı (bestfriend.FRIEND_TIERS)
SOCIAL_SECONDS = 5 * HOUR         # Sosyal Kelebek: kişi başı en az bu kadar ses
DUO_WEEK_SECONDS = 30 * HOUR
WELCOME_SECONDS = 5 * HOUR        # Hoş Geldin Komitesi: yeni gelenle en az bu kadar ses
NEWCOMER_DAYS = 30
CROWD_SIZE = 10                   # Kalabalık Sever: kendisi dahil en az bu kadar kişilik ses
NIGHT_WATCH_HOURS = (3, 4)        # 03:00–04:59
MORNING_HOURS = (8, 9)            # 08:00–09:59
FIRST_MESSAGE_HOUR = 8            # Günaydın: 08:00'den sonraki ilk mesaj
LONG_MESSAGE_CHARS = 1000
EXPLORER_CHANNELS = 10
LOYAL_DAYS = 300
REVIVAL_BROKEN_MIN = 3            # bozulan seri en az bu kadar sürmüş olmalı
REVIVAL_TARGET = 14
GHOST_GAP_DAYS = 30
REFORM_MIN_EXILE = 10 * HOUR      # Islah Oldum: aralıksız en az bu kadar süren sürgün
REFORM_CLEAN_DAYS = 30
REPUBLIC_DAY = (10, 29)

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
    Achievement("ses_kurdu", "Ses Kurdu", "Ses", "1f43a", "Toplam {n} saat seste", (250, 1000, 2000), unit="saat"),
    Achievement("maraton", "Maraton", "Ses", "23f1", "Tek seferde aralıksız {n} saat seste", (12, 17, 24), unit="saat"),
    Achievement("gece_nobeti", "Gece Nöbeti", "Ses", "1f303", "03:00–05:00 arası toplam {n} saat seste",
                (25, 50, 150), unit="saat"),
    Achievement("kalabalik_sever", "Kalabalık Sever", "Ses", "1f389",
                f"{CROWD_SIZE}+ kişilik seste {{n}} farklı gün bulunmak", (10, 50, 150), unit="gün"),
    Achievement("yayinci", "Yayıncı", "Ses", "1f3a5", "Seste {n} saat ekran paylaşımı", (100, 250, 500), unit="saat"),
    Achievement("yuzumuz_ortada", "Yüzümüz Ortada", "Ses", "1f4f8", "Kamerası açık {n} saat seste", (5, 25, 100), unit="saat"),
    Achievement("kulak_misafiri", "Kulak Misafiri", "Ses", "1f442", "Mikrofonu kapalı {n} saat seste", (50, 200, 500), unit="saat"),
    Achievement("kapiyi_acan", "Kapıyı Açan", "Ses", "1f6aa",
                "Boş ses kanalını {n} kez açıp arkadaşlarını beklemek", (40, 150, 400)),
    Achievement("isiklari_kapatan", "Işıkları Kapatan", "Ses", "1f526",
                "Bir muhabbetten {n} kez en son çıkan olmak", (40, 150, 400)),
    # Sohbet
    Achievement("klavye_ustasi", "Klavye Ustası", "Sohbet", "2328", "XP kazandıran {n} mesaj", (1000, 5000, 20000)),
    Achievement("gunaydin", "Günaydın", "Sohbet", "2600", "08:00'den sonra sunucudaki günün ilk mesajını {n} kez atmak",
                (10, 50, 150)),
    Achievement("sabahci", "Sabahçı", "Sohbet", "2615", "08:00–10:00 arası {n} mesaj", (100, 500, 1500)),
    Achievement("meme_lordu", "Meme Lordu", "Sohbet", "1f5bc", "{n} kez görsel/dosya paylaşmak", (200, 1000, 3000), hidden=True),
    Achievement("sticker_canavari", "Sticker Canavarı", "Sohbet", "1f9f8", "{n} sticker göndermek", (300, 1000, 3000), hidden=True),
    Achievement("muhabbetin_ortasi", "Muhabbetin Ortası", "Sohbet", "1f4ac", "{n} mesajı birine yanıt olarak atmak",
                (500, 2000, 5000), hidden=True),
    Achievement("destan_yazdi", "Destan Yazdı", "Sohbet", "1f4dc", f"Tek mesajda {LONG_MESSAGE_CHARS:,}+ karakter".replace(",", "."),
                hidden=True),
    Achievement("gezgin", "Gezgin", "Sohbet", "1f9ed", f"{EXPLORER_CHANNELS} farklı kanalda yazmak", hidden=True),
    Achievement("ikinci_dusunce", "İkinci Düşünce", "Sohbet", "270f", "{n} kez mesaj düzenlemek", (100, 500, 1500), hidden=True),
    Achievement("pismanlik", "Pişmanlık", "Sohbet", "1f5d1", "{n} mesajı silinmek", (50, 200, 500), hidden=True),
    # Arkadaşlık
    Achievement("ayrilmaz_ikili", "Ayrılmaz İkili", "Arkadaşlık", "1f46b", "Aynı kişiyle bir haftada 30+ saat seste"),
    Achievement("uc_silahsorler", "Üç Silahşörler", "Arkadaşlık", "1f93a", "Aynı üç kişi birlikte {n} saat seste",
                (50, 200, 500), unit="saat"),
    Achievement("herkesin_kankasi", "Herkesin Kankası", "Arkadaşlık", "1f91d", "5 farklı kişiyle Arkadaş tier'ına ulaşmak"),
    Achievement("sosyal_kelebek", "Sosyal Kelebek", "Arkadaşlık", "1f98b", "{n} farklı kişiyle en az 5'er saat seste",
                (15, 20, 30), unit="kişi"),
    Achievement("hos_geldin_komitesi", "Hoş Geldin Komitesi", "Arkadaşlık", "1f44b",
                f"Yeni gelen {{n}} kişiyle ilk {NEWCOMER_DAYS} gününde 5'er saat seste", (1, 5, 10), unit="kişi"),
    # İlerleme
    Achievement("atesli_seri", "Ateşli Seri", "İlerleme", "2604", "{n} günlük seri", (7, 30, 100), unit="gün"),
    Achievement("yukselen_yildiz", "Yükselen Yıldız", "İlerleme", "1f31f", "Seviye {n}", (5, 10, 15)),
    Achievement("koleksiyoncu", "Koleksiyoncu", "İlerleme", "1f5c3", "{n} başarım toplamak", (10, 20, 30)),
    Achievement("platin_avcisi", "Platin Avcısı", "İlerleme", "1f4a0", "{n} başarımda Platin kademe", (3, 7, 10)),
    # Haftalık özet / Wrapped
    Achievement("haftanin_mvpsi", "Haftanın MVP'si", "Özet", "1f3c6", "{n} kez haftanın MVP'si olmak", (1, 5, 15)),
    Achievement("haftanin_ikilisi", "Haftanın İkilisi", "Özet", "1f465", "{n} kez haftanın ikilisi olmak", (1, 5, 15)),
    Achievement("haftanin_gece_kusu", "Haftanın Gece Kuşu", "Özet", "1f989", "{n} kez haftanın gece kuşu olmak", (1, 5, 15)),
    Achievement("wrapped_yildizi", "Wrapped Yıldızı", "Özet", "1f451", "{n} kez ayın MVP'si olmak", (1, 3, 6)),
    # Sadakat
    Achievement("gap_emektari", "Gap Emektarı", "Sadakat", "1f3d5", "Sunucuda {n} yıl", (1, 2, 3), unit="yıl"),
    Achievement("sadik", "Sadık", "Sadakat", "1f525", f"Son 365 günün {LOYAL_DAYS}'ünde aktif olmak"),
    Achievement("dirilis", "Diriliş", "Sadakat", "1f305", f"Bozulan seriyi yeniden {REVIVAL_TARGET} güne çıkarmak"),
    Achievement("sunucu_destekcisi", "Sunucu Destekçisi", "Sadakat", "1f48e", "Sunucuya {n} ay boost", (3, 6, 12), unit="ay"),
    # Özel günler
    Achievement("yilbasi_gecesi", "Yılbaşı Gecesi", "Özel Gün", "1f386", "Yılbaşı gecesi (23:30–00:30) seste olmak"),
    Achievement("bayram_ziyareti", "Bayram Ziyareti", "Özel Gün", "1f319", "Bayramın ilk günü seste olmak"),
    Achievement("ataturkun_evlatlari", "Atatürk'ün Evlatları", "Özel Gün", "1f1f9-1f1f7", "29 Ekim'de seste olmak"),
    Achievement("gap_dogum_gunu", "Gap'in Doğum Günü", "Özel Gün", "1f382", "Sunucunun kuruluş yıldönümünde seste olmak"),
    # GAP Dünyası
    Achievement("balikci", "Balıkçı", "Dünya", "1f3a3", "Gölde {n} balık tutmak", (10, 50, 150)),
    Achievement("altin_sazan", "Altın Sazan", "Dünya", "1f420", "Efsanevi bir balık tutmak"),
    Achievement("golcu", "Golcü", "Dünya", "26bd", "Dünyada {n} gol atmak", (5, 25, 100)),
    Achievement("kahvehane_ustasi", "Kahvehane Ustası", "Dünya", "1f3b2", "Kahvehanede {n} oyun kazanmak", (5, 25, 100)),
    Achievement("tank_asi", "Tank Ası", "Dünya", "1fa96", "Tank savaşında {n} tank vurmak", (10, 50, 200)),
    Achievement("gorev_adami", "Görev Adamı", "Dünya", "1f4cb", "{n} günlük dünya görevi tamamlamak", (10, 50, 200)),
    Achievement("fotografci", "Fotoğrafçı", "Dünya", "1f4f7", "Dünyadan {n} fotoğraf paylaşmak", (5, 25, 100)),
    # Gizli
    Achievement("kimlik_krizi", "Kimlik Krizi", "Gizli", "1f3ad", "Takma adını {n} kez değiştirmek", (10, 30, 100), hidden=True),
    Achievement("firari", "Firari", "Gizli", "1f3c3", "Sürgündeyken {n} mesaj atmak", (50, 200, 500), hidden=True),
    Achievement("robotla_dertlesen", "Robotla Dertleşen", "Gizli", "1f916", "Yapay zekâyla {n} kez sohbet etmek",
                (100, 500, 2000), hidden=True),
    Achievement("sabikali", "Sabıkalı", "Gizli", "1f694", "En az bir kez sürgüne gitmek", hidden=True),
    Achievement("islah_oldum", "Islah Oldum", "Gizli", "1f607",
                f"En az {REFORM_MIN_EXILE // HOUR} saatlik bir sürgünden sonra {REFORM_CLEAN_DAYS} gün temiz kalmak", hidden=True),
    Achievement("hayalet", "Hayalet", "Gizli", "1f47b", f"{GHOST_GAP_DAYS} gün hiç görünmeyip geri dönmek", hidden=True),
    Achievement("fikir_babasi", "Fikir Babası", "Özel", "1f4a1", "Önerdiği bir özelliğin bota gelmesi", manual=True),
)
BY_KEY = {a.key: a for a in ACHIEVEMENTS}
CATEGORIES = tuple(dict.fromkeys(a.category for a in ACHIEVEMENTS))
META_KEYS = {"koleksiyoncu", "platin_avcisi"}   # diğer başarımlara bakılarak hesaplanır


def find(text: str) -> Achievement | None:
    """İsimden/anahtardan başarım; Türkçe karakter ve boşluk farkı önemsiz, tek eşleşen kısmi ad da olur."""
    wanted = fold(text)
    if not wanted:
        return None
    for a in ACHIEVEMENTS:
        if wanted in (fold(a.key), fold(a.name)):
            return a
    partial = [a for a in ACHIEVEMENTS if wanted in fold(a.name)]
    return partial[0] if len(partial) == 1 else None


def parse_tier(text: str) -> int | None:
    """"altın", "2", "Platin" → kademe numarası; değilse None."""
    t = fold(text)
    if t.isdigit() and 1 <= int(t) <= len(TIER_NAMES):
        return int(t)
    for i, name in enumerate(TIER_NAMES, start=1):
        if t == fold(name):
            return i
    return None


def emoji(a: Achievement) -> str:
    return "".join(chr(int(cp, 16)) for cp in a.icon.split("-"))


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


def _local(ts: float) -> datetime.datetime:
    return datetime.datetime.fromtimestamp(ts, STREAK_TZ)


def week_key(ts: float) -> str:
    year, week, _ = _local(ts).isocalendar()
    return f"{year}-W{week:02d}"


@dataclass
class Aggregate:
    """Bir grup olay satırından çıkan sayaç değişiklikleri; anahtarlar (guild, user, sayaç)."""
    inc: dict[tuple[int, int, str], float] = field(default_factory=lambda: defaultdict(float))
    maxes: dict[tuple[int, int, str], float] = field(default_factory=dict)     # en büyük değer kalır
    assign: dict[tuple[int, int, str], float] = field(default_factory=dict)    # son değer kalır (kümeler dahil)
    first_messages: dict[tuple[int, str], tuple[float, int]] = field(default_factory=dict)  # (guild, gün) → (ts, üye)


def aggregate(
    rows, voice_interval: int, joined: dict[tuple[int, int], float] | None = None,
    exile_starts: dict[tuple[int, int], float] | None = None,
) -> Aggregate:
    """
    Olay satırlarını (id sırasıyla) sayaç değişikliklerine çevirir.
    joined: (guild, üye) → sunucuya katılma zamanı (Hoş Geldin Komitesi için).
    exile_starts: önceki turlardan kalan, süren sürgünlerin başlangıcı (Islah Oldum için).
    """
    joined = joined or {}
    starts = dict(exile_starts or {})
    out = Aggregate()
    inc, maxes, assign = out.inc, out.maxes, out.assign
    for row in rows:
        gid, uid, event, ts = row["guild_id"], row["user_id"], row["event"], row["ts"]
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
            local = _local(ts)
            if local.hour in NIGHT_WATCH_HOURS:
                inc[gid, uid, "night_voice"] += voice_interval
            peers = sorted(set(meta.get("peers") or []))
            if len(peers) + 1 >= CROWD_SIZE:
                assign[gid, uid, f"crowd:{local.date().isoformat()}"] = 1
            week = week_key(ts)
            for peer in peers:
                inc[gid, uid, f"duo:{week}:{peer}"] += voice_interval
                peer_joined = joined.get((gid, peer))
                if peer_joined is not None and 0 <= ts - peer_joined <= NEWCOMER_DAYS * DAY:
                    inc[gid, uid, f"new:{peer}"] += voice_interval
            for a, b in combinations(peers, 2):
                inc[gid, uid, f"trio:{a}-{b}"] += voice_interval
        elif event == "xp_message":
            inc[gid, uid, "xpmsg"] += 1
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
                assign[gid, uid, f"ch:{row['channel_id']}"] = 1
            local = _local(ts)
            if local.hour in MORNING_HOURS:
                inc[gid, uid, "morning"] += 1
            if local.hour >= FIRST_MESSAGE_HOUR:
                day = (gid, local.date().isoformat())
                if day not in out.first_messages or ts < out.first_messages[day][0]:
                    out.first_messages[day] = (ts, uid)
        elif event == "message_edit":
            inc[gid, uid, "edit"] += 1
        elif event == "message_delete":
            inc[gid, uid, "deleted"] += 1
        elif event == "nick_change":
            inc[gid, uid, "nick"] += 1
        elif event == "ai_chat":
            inc[gid, uid, "ai"] += 1
        elif event == "fish_catch":
            inc[gid, uid, "fish"] += 1
            if _meta(row).get("rarity") == "legendary":
                inc[gid, uid, "fish_legend"] += 1
        elif event == "world":
            kind = _meta(row).get("kind")
            if kind in ("goal", "game_win", "tank_kill", "quest", "photo"):
                inc[gid, uid, f"w_{kind}"] += int(row["amount"] or 1)
        elif event == "voice_leave":
            seconds = _meta(row).get("seconds")
            if seconds:
                key = (gid, uid, "max_session")
                maxes[key] = max(maxes.get(key, 0), float(seconds))
        elif event == "admin_exile":
            if _meta(row).get("yeni", True):                   # süre güncellemesi yeni sürgün sayılmaz
                inc[gid, uid, "exiled"] += 1
                starts[gid, uid] = ts
                assign[gid, uid, "exile_start"] = ts
                assign[gid, uid, "reform_from"] = 0          # yeni sürgün: ıslah süresi sıfırlanır
        elif event in ("admin_exile_end", "exile_expired"):
            start = starts.pop((gid, uid), 0)
            if start and ts - start >= REFORM_MIN_EXILE:
                assign[gid, uid, "reform_from"] = ts
            assign[gid, uid, "exile_start"] = 0
    out.inc = dict(inc)
    return out


# ---------------------------------------------------------------------------
# Değerlendirme
# ---------------------------------------------------------------------------

def _days(days: list[str]) -> list[datetime.date]:
    return [datetime.date.fromisoformat(d) for d in days]


def _runs(days: list[str]) -> list[int]:
    runs: list[int] = []
    prev = None
    for day in _days(days):
        if prev is not None and (day - prev).days == 1:
            runs[-1] += 1
        else:
            runs.append(1)
        prev = day
    return runs


def revived(days: list[str]) -> bool:
    """Bozulan (en az REVIVAL_BROKEN_MIN günlük) bir seriden sonra yeniden REVIVAL_TARGET güne ulaşıldı mı?"""
    runs = _runs(days)
    broken_before = False
    for i, length in enumerate(runs):
        if broken_before and length >= REVIVAL_TARGET:
            return True
        if length >= REVIVAL_BROKEN_MIN and i < len(runs) - 1:  # sonrasında başka bir seri başladıysa bozulmuştur
            broken_before = True
    return False


def longest_run(days: list[str]) -> int:
    return max(_runs(days), default=0)


def came_back(days: list[str]) -> bool:
    """İki aktif gün arasında en az GHOST_GAP_DAYS gün sessizlik var mı (yani gidip geri döndü mü)?"""
    dates = _days(days)
    return any((b - a).days > GHOST_GAP_DAYS for a, b in zip(dates, dates[1:]))


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
    active_days: list[str] = field(default_factory=list)
    friends_5h: int = 0
    voice_seconds: int = 0
    current_streak: int = 0
    level: int = 0


def metric(key: str, f: MemberFacts) -> float:
    c = f.counters
    simple = {
        "yayinci": c.get("stream", 0) / HOUR,
        "yuzumuz_ortada": c.get("video", 0) / HOUR,
        "kulak_misafiri": c.get("muted", 0) / HOUR,
        "kapiyi_acan": c.get("door", 0),
        "isiklari_kapatan": c.get("lights", 0),
        "ses_kurdu": f.voice_seconds / HOUR,
        "maraton": c.get("max_session", 0) / HOUR,
        "gece_nobeti": c.get("night_voice", 0) / HOUR,
        "kalabalik_sever": sum(1 for k in c if k.startswith("crowd:")),
        "klavye_ustasi": c.get("xpmsg", 0),
        "gunaydin": c.get("gm", 0),
        "sabahci": c.get("morning", 0),
        "meme_lordu": c.get("att", 0),
        "sticker_canavari": c.get("stk", 0),
        "muhabbetin_ortasi": c.get("reply", 0),
        "ikinci_dusunce": c.get("edit", 0),
        "pismanlik": c.get("deleted", 0),
        "uc_silahsorler": max((v for k, v in c.items() if k.startswith("trio:")), default=0) / HOUR,
        "sosyal_kelebek": f.friends_5h,
        "hos_geldin_komitesi": sum(1 for k, v in c.items() if k.startswith("new:") and v >= WELCOME_SECONDS),
        "atesli_seri": max(longest_run(f.message_days), f.current_streak),
        "yukselen_yildiz": f.level,
        "haftanin_mvpsi": f.awards.get("week_mvp", 0),
        "haftanin_ikilisi": f.awards.get("week_duo", 0),
        "haftanin_gece_kusu": f.awards.get("week_night", 0),
        "wrapped_yildizi": f.awards.get("month_mvp", 0),
        "gap_emektari": (f.now - f.joined_at).days / 365.25 if f.joined_at else 0,
        "sunucu_destekcisi": (f.now - f.premium_since).days / 30 if f.premium_since else 0,
        "yilbasi_gecesi": c.get("newyear", 0),
        "bayram_ziyareti": c.get("bayram", 0),
        "ataturkun_evlatlari": c.get("republic", 0),
        "gap_dogum_gunu": c.get("gapbday", 0),
        "kimlik_krizi": c.get("nick", 0),
        "firari": c.get("exile_msg", 0),
        "robotla_dertlesen": c.get("ai", 0),
        "sabikali": c.get("exiled", 0),
        "balikci": c.get("fish", 0),
        "altin_sazan": 1 if c.get("fish_legend", 0) >= 1 else 0,
        "golcu": c.get("w_goal", 0),
        "kahvehane_ustasi": c.get("w_game_win", 0),
        "tank_asi": c.get("w_tank_kill", 0),
        "gorev_adami": c.get("w_quest", 0),
        "fotografci": c.get("w_photo", 0),
    }
    if key in simple:
        return simple[key]
    if key == "destan_yazdi":
        return 1 if c.get("long", 0) >= 1 else 0
    if key == "gezgin":
        return 1 if sum(1 for k in c if k.startswith("ch:")) >= EXPLORER_CHANNELS else 0
    if key == "ayrilmaz_ikili":
        return 1 if max((v for k, v in c.items() if k.startswith("duo:")), default=0) >= DUO_WEEK_SECONDS else 0
    if key == "herkesin_kankasi":
        return 1 if f.friends_20h >= 5 else 0
    if key == "sadik":
        return 1 if f.active_days_365 >= LOYAL_DAYS else 0
    if key == "dirilis":
        return 1 if revived(f.message_days) else 0
    if key == "hayalet":
        return 1 if came_back(f.active_days) else 0
    if key == "islah_oldum":
        since = c.get("reform_from", 0)
        return 1 if since and f.now.timestamp() - since >= REFORM_CLEAN_DAYS * DAY else 0
    return 0  # fikir_babasi: yalnızca yönetici verir; koleksiyon başarımları evaluate'te


def evaluate(facts: MemberFacts, current: dict[str, int]) -> dict[str, int]:
    """Yükselen başarımlar: {anahtar: yeni kademe}. Kademe hiçbir zaman düşmez."""
    out: dict[str, int] = {}
    for a in ACHIEVEMENTS:
        if a.manual or a.key in META_KEYS:
            continue
        tier = a.tier_for(metric(a.key, facts))
        if tier > current.get(a.key, 0):
            out[a.key] = tier
    # Koleksiyon: diğer başarımlara bakar (bu turda açılanlar dahil)
    merged = {**current, **out}
    others = {k: t for k, t in merged.items() if k not in META_KEYS and t > 0}
    meta_values = {
        "koleksiyoncu": len(others),
        "platin_avcisi": sum(1 for k, t in others.items() if BY_KEY.get(k) and BY_KEY[k].tiered and t >= BY_KEY[k].max_tier),
    }
    for key, value in meta_values.items():
        tier = BY_KEY[key].tier_for(value)
        if tier > current.get(key, 0):
            out[key] = tier
    return out


def meta_metric(key: str, earned: dict[str, int]) -> float:
    others = {k: t for k, t in earned.items() if k not in META_KEYS and t > 0}
    if key == "koleksiyoncu":
        return len(others)
    return sum(1 for k, t in others.items() if BY_KEY.get(k) and BY_KEY[k].tiered and t >= BY_KEY[k].max_tier)


def progress(a: Achievement, facts: MemberFacts, tier: int, earned: dict[str, int] | None = None) -> tuple[float, float] | None:
    """Sıradaki kademe için (şu an, hedef); tamamlandıysa ya da ölçülemiyorsa None."""
    if not a.tiered or tier >= a.max_tier:
        return None
    value = meta_metric(a.key, earned or {}) if a.key in META_KEYS else metric(a.key, facts)
    return value, a.tiers[tier]


def special_days(now: datetime.datetime, founded: datetime.date | None = None) -> list[str]:
    """Şu an hangi özel günlerin içindeyiz? (Türkiye saati) → sayaç anahtarları."""
    out: list[str] = []
    if (now.month, now.day) == (12, 31) and (now.hour, now.minute) >= (23, 30):
        out.append("newyear")
    if (now.month, now.day) == (1, 1) and (now.hour, now.minute) < (0, 30):
        out.append("newyear")
    if now.date() in BAYRAMS:
        out.append("bayram")
    if (now.month, now.day) == REPUBLIC_DAY:
        out.append("republic")
    if founded is not None and (now.month, now.day) == (founded.month, founded.day) and now.year > founded.year:
        out.append("gapbday")
    return out
