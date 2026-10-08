"""
ai/retrieval.py — SQLite FTS5 ile sözcüksel RAG (V1).

Embedding yok. Akış:
  1. Sorudan anlamlı terimler çıkarılır (Türkçe katlama + durak kelime
     ayıklama + temkinli ek kırpma). Terimler önek sorgusu olarak aranır:
     "oyunda" → "oyun*" → oyun, oyunu, oyuncu… ile eşleşir.
  2. Zaman ifadeleri (dün, bugün, geçen hafta, son N gün…) tarih filtresine,
     "@x ne dedi" kalıbı yazar filtresine çevrilir.
  3. FTS5 BM25 + (gerekiyorsa) yenilik bonusuyla sıralanır.
  4. Her isabetin etrafındaki birkaç mesaj eklenir, çakışan pencereler
     birleştirilir, kronolojik pasajlar döner.

Sınırlama: eşanlamlı / farklı ifade edilmiş içerik (ör. "maç" ↔ "karşılaşma")
bulunamaz; ek kırpma tam bir morfolojik çözümleyici değildir.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass, field
from typing import Iterable

from ai.storage import AIStorage, StoredMessage
from ai.textutil import fold

TR_TZ = dt.timezone(dt.timedelta(hours=3))

# Katlanmış (fold) biçimde durak kelimeler ve soru/hatırlama fiilleri.
STOPWORDS: frozenset[str] = frozenset("""
a acaba ama ancak artik aslinda az bana bazi belki ben beni benim beri bile bir biraz biri birisi birkac birsey
biz bize bizi bizim bu buna bunda bundan bunu bunun burada cok cunku da daha dahi de defa diye dogru en
fakat falan filan gibi hala hangi hani hem hep hepsi her herkes hic icin ile ilgili ise iste kadar ki kim
kime kimi kimin kimse lan mi mu misin musun miydi muydu mısın ne neden nedir nerde nerede nereye nasil niye
o olan olarak oldu olsun on ona onda ondan onlar onu onun oraya oysa ozaman pek sana sanki sen seni senin
siz sizi sizin su suna sunu tabi tamam tum ve veya ya yani yine yok var evet hayir hadi abi kanka la ya
hatirla hatirliyor hatirliyormusun hatirlat hatirlarsin soyle soyledi soylemisti demisti dedi demis dediler
konustuk konusmustuk konustugumuz konustu bahsetti bahsetmisti bahsettik yazdi yazmisti zaman ne zaman
dun bugun gecen hafta ay yil son gun gunler once sonra simdi bu sefer kac
""".split())

# Uzundan kısaya; yalnızca kalan gövde >= 4 harf ise kırpılır.
_SUFFIXES: tuple[str, ...] = tuple(sorted({
    "lerinden", "larindan", "lerinde", "larinda", "lerini", "larini", "lerine", "larina", "lerin", "larin",
    "leri", "lari", "ler", "lar",
    "inden", "indan", "unden", "undan", "inde", "inda", "unde", "unda",
    "ndan", "nden", "dan", "den", "tan", "ten",
    "nda", "nde", "da", "de", "ta", "te",
    "nin", "nun", "in", "un", "ni", "nu", "yi", "yu", "yla", "yle", "la", "le",
    "na", "ne", "ya", "ye", "ca", "ce", "ci", "cu",
    "imiz", "umuz", "iniz", "unuz", "im", "um", "i", "u", "a", "e",
}, key=len, reverse=True))

_SAID_RE = re.compile(r"\b(ne dedi|ne demisti|ne yazdi|ne yazmisti|soyledi|soylemisti|demisti|yazmisti)\b")
_LAST_N_DAYS_RE = re.compile(r"\bson (\d{1,3}) gun")
_RECENCY_HINTS = ("en son", "son zamanlarda", "gecenlerde", "yakinda", "az once", "biraz once")
_MENTION_RE = re.compile(r"<@!?(\d+)>")
_WORD_RE = re.compile(r"\w+", re.UNICODE)

MAX_TERMS = 8


def light_stem(term: str) -> str:
    for suffix in _SUFFIXES:
        if term.endswith(suffix) and len(term) - len(suffix) >= 4:
            return term[: -len(suffix)]
    return term


def extract_terms(question: str) -> list[str]:
    text = _MENTION_RE.sub(" ", question)
    text = re.sub(r"<#\d+>|<a?:\w+:\d+>|https?://\S+", " ", text)
    terms: list[str] = []
    for raw in _WORD_RE.findall(fold(text)):
        if raw in STOPWORDS or len(raw) < 2 or raw.isdigit() and len(raw) < 2:
            continue
        stem = light_stem(raw) if not raw.isdigit() else raw
        if stem in STOPWORDS:
            continue
        if stem not in terms:
            terms.append(stem)
        if len(terms) >= MAX_TERMS:
            break
    return terms


def build_fts_query(terms: Iterable[str]) -> str:
    """Terimleri FTS5 sözdizimine güvenli biçimde çevirir: "a"* OR "b"* …"""
    parts = []
    for t in terms:
        t = re.sub(r"[^\w]", "", t)
        if not t:
            continue
        # 3 harften kısa terimlerde önek araması çok gürültülü olur.
        parts.append(f'"{t}"*' if len(t) >= 3 else f'"{t}"')
    return " OR ".join(parts)


@dataclass(frozen=True)
class TimeFilter:
    since: float | None = None
    until: float | None = None
    recency_relevant: bool = False
    label: str | None = None


def parse_time_filter(question: str, now: float) -> TimeFilter:
    q = fold(question)
    local = dt.datetime.fromtimestamp(now, TR_TZ)
    today = local.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today - dt.timedelta(days=today.weekday())
    month_start = today.replace(day=1)

    if m := _LAST_N_DAYS_RE.search(q):
        days = max(1, int(m.group(1)))
        return TimeFilter(now - days * 86400, None, True, f"son {days} gün")
    if "evvelsi gun" in q or "dunden once" in q:
        return TimeFilter((today - dt.timedelta(days=2)).timestamp(), (today - dt.timedelta(days=1)).timestamp(), True, "önceki gün")
    if re.search(r"\bdun\b|\bdunku\b", q):
        return TimeFilter((today - dt.timedelta(days=1)).timestamp(), today.timestamp(), True, "dün")
    if re.search(r"\bbugun\b|\bbugunku\b", q):
        return TimeFilter(today.timestamp(), None, True, "bugün")
    if "gecen hafta" in q:
        return TimeFilter((week_start - dt.timedelta(days=7)).timestamp(), week_start.timestamp(), True, "geçen hafta")
    if "bu hafta" in q:
        return TimeFilter(week_start.timestamp(), None, True, "bu hafta")
    if "gecen ay" in q:
        prev = (month_start - dt.timedelta(days=1)).replace(day=1)
        return TimeFilter(prev.timestamp(), month_start.timestamp(), True, "geçen ay")
    if "bu ay" in q:
        return TimeFilter(month_start.timestamp(), None, True, "bu ay")
    if any(h in q for h in _RECENCY_HINTS):
        return TimeFilter(None, None, True, None)
    return TimeFilter()


def author_filter(question: str, bot_id: int | None) -> int | None:
    """"@ali ne dedi" → ali'nin ID'si. Sadece 'söyleme' fiili varsa uygulanır."""
    if not _SAID_RE.search(fold(_MENTION_RE.sub(" ", question))):
        return None
    for m in _MENTION_RE.finditer(question):
        uid = int(m.group(1))
        if uid != bot_id:
            return uid
    return None


@dataclass
class Passage:
    channel_id: int
    messages: list[StoredMessage]
    score: float
    hit_ids: list[int] = field(default_factory=list)

    @property
    def anchor(self) -> StoredMessage:
        best = self.hit_ids[0] if self.hit_ids else self.messages[0].message_id
        return next((m for m in self.messages if m.message_id == best), self.messages[0])


@dataclass
class RetrievalResult:
    passages: list[Passage]
    terms: list[str]
    time_filter: TimeFilter
    author_id: int | None

    @property
    def empty(self) -> bool:
        return not self.passages


class Retriever:
    def __init__(
        self,
        storage: AIStorage,
        *,
        search_results: int = 10,
        final_passages: int = 5,
        neighbor_messages: int = 2,
        neighbor_window_seconds: int = 900,
    ) -> None:
        self.storage = storage
        self.search_results = search_results
        self.final_passages = final_passages
        self.neighbor_messages = neighbor_messages
        self.neighbor_window_seconds = neighbor_window_seconds

    async def search(
        self,
        guild_id: int,
        question: str,
        channel_ids: Iterable[int],
        *,
        now: float,
        bot_id: int | None = None,
        exclude_ids: Iterable[int] = (),
    ) -> RetrievalResult:
        channels = list(channel_ids)
        terms = extract_terms(question)
        tf = parse_time_filter(question, now)
        author = author_filter(question, bot_id)
        result = RetrievalResult([], terms, tf, author)
        query = build_fts_query(terms)
        if not channels or not query:
            return result

        excluded = set(exclude_ids)
        hits = await self.storage.search_messages(
            guild_id, query, channels,
            user_id=author, since=tf.since, until=tf.until, limit=self.search_results + len(excluded),
        )
        hits = [h for h in hits if h.message_id not in excluded][: self.search_results]
        if not hits:
            return result

        def ranked(h: StoredMessage) -> float:
            score = h.score
            if tf.recency_relevant:
                age_days = max(0.0, (now - h.created_at) / 86400)
                score *= 1.0 + 0.5 * math.exp(-age_days / 7)
            return score

        hits.sort(key=ranked, reverse=True)

        passages: list[Passage] = []
        owner: dict[int, Passage] = {}
        for hit in hits:
            if hit.message_id in owner:
                p = owner[hit.message_id]
                p.score += ranked(hit) * 0.5
                p.hit_ids.append(hit.message_id)
                continue
            around = await self.storage.neighbors(
                guild_id, hit.channel_id, hit.created_at,
                self.neighbor_messages, self.neighbor_window_seconds,
            )
            window = sorted([*around, hit], key=lambda m: (m.created_at, m.message_id))
            window = [m for m in window if m.message_id not in excluded]
            merged = next((owner[m.message_id] for m in window if m.message_id in owner), None)
            if merged is None:
                merged = Passage(hit.channel_id, [], ranked(hit), [hit.message_id])
                passages.append(merged)
            else:
                merged.score += ranked(hit) * 0.5
                merged.hit_ids.append(hit.message_id)
            for m in window:
                if m.message_id not in owner:
                    owner[m.message_id] = merged
                    merged.messages.append(m)
            merged.messages.sort(key=lambda m: (m.created_at, m.message_id))

        passages.sort(key=lambda p: p.score, reverse=True)
        result.passages = passages[: self.final_passages]
        return result
