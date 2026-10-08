"""
ai/memory.py — Uzun süreli hafıza politikası.

Katmanlar:
  - Kullanıcı hafızası (scope='user'): kullanıcının kendisi hakkında açıkça
    söylediği / onayladığı kalıcı bilgiler (takma ad, sevdiği oyun…).
  - Episodik hafıza (scope='episodic'): sunucudaki ortak olaylar (planlar,
    oyun geceleri, anılar). Her zaman bir kanala bağlıdır; yalnızca o kanalı
    görmeye yetkili isteklerde kullanılır.

Durum yaşam döngüsü: candidate → confirmed → (silme) / revoked
  - !hafizaekle / !ani → doğrudan 'confirmed' (kullanıcı kendisi istedi).
  - Bota yazılan mesajlardaki basit kalıplar ("en sevdiğim oyun X",
    "bana X de") → 'candidate'. Adaylar prompt'a GİRMEZ; kullanıcı
    !onayla <id> ile onaylarsa kullanılır, yoksa süresi dolunca silinir.
  - Kaynak mesajı silinen, onaylanmamış türetilmiş hafıza → 'revoked'.
LLM ile hafıza çıkarımı yapılmaz (V1). Şaka/ironi tespiti yapılamadığı için
otomatik çıkarım asla doğrudan onaylı kayıt üretmez.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

from ai.guard import find_sensitive
from ai.storage import AIStorage, Memory
from ai.textutil import collapse_ws, fold, truncate

MIN_MEMORY_CHARS = 3
MAX_MEMORY_CHARS = 300
EPISODE_PLAN_TTL_DAYS = 7
EPISODE_DEFAULT_TTL_DAYS = 365


class MemoryError_(Exception):
    def __init__(self, user_message: str) -> None:
        super().__init__(user_message)
        self.user_message = user_message


@dataclass(frozen=True)
class Candidate:
    memory_type: str
    content: str


# Kalıplar katlanmış (fold) metin üzerinde çalışır.
_FAV_RE = re.compile(r"\ben sevdigim ([a-z]+) (?:da |de )?([\w' .:-]{2,60}?)(?:[.!,;]|\s+(?:ama|ve|cunku)\b|$)")
_NICK_RES = (
    re.compile(r"\bbana ([\w' -]{2,30}?) (?:diye )?(?:seslen|hitap et|de)\b"),
    re.compile(r"\b(?:benim )?(?:adim|ismim) ([\w'-]{2,30})(?:[.!,;\s]|$)"),
)
_PLAN_WHEN = r"(?:yarin|bu aksam|bu gece|haftaya|hafta sonu|pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar|saat \d{1,2})"
_PLAN_WHAT = r"(?:oynayalim|oynariz|oynuyoruz|oynayacagiz|toplaniyoruz|toplanalim|bulusuyoruz|bulusalim|takilalim|takiliyoruz|girelim|giriyoruz|izleyelim|izliyoruz)"
_PLAN_RE = re.compile(rf"\b{_PLAN_WHEN}\b.*\b{_PLAN_WHAT}\b|\b{_PLAN_WHAT}\b.*\b{_PLAN_WHEN}\b")
_NEGATION_RE = re.compile(r"\b(degil|degilim|sevmem|sevmiyorum|yok)\b")

_FAV_LABELS = {
    "oyun": "favori oyun", "oyunum": "favori oyun", "film": "favori film", "dizi": "favori dizi",
    "sarki": "favori şarkı", "grup": "favori grup", "yemek": "favori yemek", "takim": "tuttuğu takım",
    "karakter": "favori karakter", "renk": "favori renk", "kitap": "favori kitap", "sanatci": "favori sanatçı",
}


def _span_from_original(original: str, folded: str, m: re.Match[str], group: int) -> str:
    """Katlanmış metinde bulunan grubu, uzunluklar eşitse orijinal yazımla döndür."""
    if len(original) == len(folded):
        return original[m.start(group): m.end(group)]
    return m.group(group)


def extract_user_candidates(text: str) -> list[Candidate]:
    """Kullanıcının kendisi hakkındaki basit, açık beyanları aday olarak çıkarır."""
    if "?" in text or find_sensitive(text):
        return []
    folded = fold(text)
    if _NEGATION_RE.search(folded):
        return []
    out: list[Candidate] = []
    for m in _FAV_RE.finditer(folded):
        label = _FAV_LABELS.get(m.group(1))
        value = collapse_ws(_span_from_original(text, folded, m, 2)).strip(" .'")
        if label and len(value) >= 2:
            out.append(Candidate("preference", f"{label}: {value}"))
    for pat in _NICK_RES:
        if m := pat.search(folded):
            value = collapse_ws(_span_from_original(text, folded, m, 1)).strip(" .'")
            if 2 <= len(value) <= 30:
                out.append(Candidate("nickname", f"hitap/takma ad: {value}"))
            break
    return out


def looks_like_plan(text: str) -> bool:
    return bool(_PLAN_RE.search(fold(text))) and not find_sensitive(text)


def _validate_content(content: str) -> str:
    content = collapse_ws(content)
    if len(content) < MIN_MEMORY_CHARS:
        raise MemoryError_("Hafıza metni çok kısa.")
    if len(content) > MAX_MEMORY_CHARS:
        raise MemoryError_(f"Hafıza metni en fazla {MAX_MEMORY_CHARS} karakter olabilir.")
    if find_sensitive(content):
        raise MemoryError_(
            "Bu metin hassas bilgi (e-posta, telefon, şifre, kart vb.) içeriyor gibi görünüyor; "
            "güvenliğin için kaydetmedim."
        )
    return content


class MemoryService:
    def __init__(self, storage: AIStorage, *, candidate_retention_days: int = 14) -> None:
        self.storage = storage
        self.candidate_retention_days = candidate_retention_days

    # ------------------------------------------------------------------
    # Kullanıcı hafızası
    # ------------------------------------------------------------------

    async def remember_user(self, guild_id: int, user_id: int, content: str, memory_type: str = "note") -> tuple[int, bool]:
        content = _validate_content(content)
        return await self.storage.add_memory(
            guild_id=guild_id, user_id=user_id, scope="user", memory_type=memory_type,
            content=content, source="explicit", status="confirmed", confidence=1.0, created_by=user_id,
        )

    async def capture_candidates(
        self, guild_id: int, user_id: int, channel_id: int, message_id: int, text: str, *, store_source: bool
    ) -> list[int]:
        """Bota yazılmış bir mesajdan aday hafızalar çıkarır. Döner: oluşturulan aday ID'leri."""
        ids: list[int] = []
        expires = time.time() + self.candidate_retention_days * 86400
        for cand in extract_user_candidates(text):
            mem_id, created = await self.storage.add_memory(
                guild_id=guild_id, user_id=user_id, scope="user", memory_type=cand.memory_type,
                content=cand.content, source="extracted", status="candidate", confidence=0.6,
                created_by=user_id, expires_at=expires,
                source_messages=[(message_id, channel_id)] if store_source else (),
            )
            if created:
                ids.append(mem_id)
        return ids

    async def confirm(self, guild_id: int, user_id: int, memory_id: int) -> Memory:
        mem = await self.storage.get_memory(memory_id)
        if mem is None or mem.guild_id != guild_id or mem.user_id != user_id or mem.status == "revoked":
            raise MemoryError_("Bu ID ile sana ait bir hafıza bulamadım.")
        if mem.status != "confirmed":
            await self.storage.set_memory_status(memory_id, "confirmed", expires_at=None)
        return mem

    # ------------------------------------------------------------------
    # Episodik hafıza
    # ------------------------------------------------------------------

    async def add_episode(
        self,
        guild_id: int,
        channel_id: int,
        creator_id: int,
        content: str,
        participants: list[int],
        source_messages: list[tuple[int, int | None]] = (),  # type: ignore[assignment]
        ttl_days: int | None = EPISODE_DEFAULT_TTL_DAYS,
    ) -> tuple[int, bool]:
        content = _validate_content(content)
        return await self.storage.add_memory(
            guild_id=guild_id, channel_id=channel_id, scope="episodic", memory_type="episode",
            content=content, source="explicit", status="confirmed", confidence=1.0, created_by=creator_id,
            expires_at=time.time() + ttl_days * 86400 if ttl_days else None,
            participants={creator_id, *participants}, source_messages=source_messages,
        )

    async def capture_plan(
        self, guild_id: int, channel_id: int, author_id: int, author_name: str, message_id: int, text: str
    ) -> int | None:
        """İndekslenen kanaldaki plan cümlelerini kısa ömürlü aday anı olarak kaydeder."""
        if not looks_like_plan(text):
            return None
        mem_id, created = await self.storage.add_memory(
            guild_id=guild_id, channel_id=channel_id, scope="episodic", memory_type="plan",
            content=f"{author_name} plan önerdi: {truncate(collapse_ws(text), 200)}",
            source="extracted", status="candidate", confidence=0.5, created_by=author_id,
            expires_at=time.time() + EPISODE_PLAN_TTL_DAYS * 86400,
            participants=[author_id], source_messages=[(message_id, channel_id)],
        )
        return mem_id if created else None

    # ------------------------------------------------------------------
    # Silme ve listeleme
    # ------------------------------------------------------------------

    async def forget(self, guild_id: int, user_id: int, memory_id: int, *, is_admin: bool = False) -> Memory:
        mem = await self.storage.get_memory(memory_id)
        if mem is None or mem.guild_id != guild_id:
            raise MemoryError_("Bu ID ile bir hafıza bulamadım.")
        allowed = is_admin or mem.user_id == user_id or mem.created_by == user_id
        if not allowed and mem.scope == "episodic":
            allowed = user_id in await self.storage.memory_participants(memory_id)
        if not allowed:
            raise MemoryError_("Bu hafıza sana ait değil; silemezsin.")
        await self.storage.delete_memory(memory_id)
        return mem

    async def for_context(
        self, guild_id: int, user_id: int, channel_ids: set[int], limit: int
    ) -> tuple[list[str], list[str]]:
        """Prompt'a girecek onaylı hafızalar: kullanıcının kendi kayıtları + yetkili kanallardaki ortak anılar."""
        if limit <= 0:
            return [], []
        users = await self.storage.list_user_memories(guild_id, user_id, ("confirmed",), limit=limit)
        episodes = await self.storage.list_episodic(
            guild_id, channel_ids, participant_id=user_id, limit=max(1, limit // 2)
        ) if channel_ids else []
        return [m.content for m in users], [m.content for m in episodes]
