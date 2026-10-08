"""
ai/stats.py — Mevcut Bot-GAP verilerine salt-okunur, deterministik erişim.

LLM SQL üretmez veya çalıştırmaz. Sorudaki basit niyet kalıpları uygulama
tarafında tanınır, ilgili veritabanı fonksiyonu çağrılır ve sonuç modele
<sunucu_verisi> olarak verilir. Model kullanılamazsa aynı satırlar doğrudan
kullanıcıya gösterilebilir.

Yetki: Bu veriler zaten herkese açık komutlarla (!kart, !liderlik, !bf,
!streak) görülebildiği için ek gizlilik riski yoktur; sorgular her zaman
isteğin geldiği sunucuyla sınırlıdır. XP veritabanında hiçbir şey yazılmaz:
kullanıcı satırı için mode=ro bağlantı kullanılır (database.get_user_row
eksik kullanıcıyı oluşturduğu için kullanılmaz).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Callable

import aiosqlite

import database as xpdb
from ai.textutil import fold

log = logging.getLogger("gap.ai.stats")

_INTENTS: dict[str, re.Pattern[str]] = {
    "leaderboard": re.compile(
        r"en (?:yuksek|cok) (?:seviye|level|xp)|liderlik|siralama|siralamada kim|kim (?:birinci|lider|ilk sirada)|top ?(?:5|10)"
    ),
    "user_xp": re.compile(r"\b(?:seviye(?:m|si|n)?|level(?:im|i|in)?|xp(?:'?(?:im|si|in))?|kacinci(?:yim|sin|siyim)?|rank)\b"),
    "streak": re.compile(r"\b(?:streak\w*|seri(?:m|si|n)?)\b"),
    "bestfriend": re.compile(r"best ?friend|\bbf\b|en yakin arkadas|en cok kiminle"),
    # Yalnızca soruda bir üye etiketi varsa anlamlı (aşağıda kontrol edilir).
    "member": re.compile(r"\bkim\b|kimdir|kim bu|bu kim|tanir mis|taniyor mus|hakkinda|nesi|ne zamandir"),
}
_MENTION_RE = re.compile(r"<@!?(\d+)>")


def detect_intents(question: str) -> list[str]:
    q = fold(_MENTION_RE.sub(" ", question))
    return [name for name, pat in _INTENTS.items() if pat.search(q)]


def _fmt_duration(seconds: int) -> str:
    hours, rem = divmod(max(0, int(seconds)), 3600)
    return f"{hours}sa {rem // 60}dk" if hours else f"{rem // 60}dk"


@dataclass
class UserRow:
    text_xp: int
    voice_xp: int
    voice_seconds: int
    message_count: int
    streak_days: int

    @property
    def total_xp(self) -> int:
        return self.text_xp + self.voice_xp


class StatsService:
    def __init__(
        self,
        *,
        level_for: Callable[[int], int],
        name_for: Callable[[int], str],
        db_module: Any = xpdb,
        bestfriend_threshold_seconds: int = 100 * 3600,
        member_info: Callable[[int, int], list[str]] | None = None,
    ) -> None:
        self._member_info = member_info
        self._level_for = level_for
        self._name_for = name_for
        self._db = db_module
        self._bf_threshold = bestfriend_threshold_seconds

    async def peek_user(self, guild_id: int, user_id: int) -> UserRow | None:
        path = self._db.DATABASE_PATH
        if not path.exists():
            return None
        async with aiosqlite.connect(f"file:{path}?mode=ro", uri=True) as conn:
            async with conn.execute(
                """
                SELECT text_xp, voice_xp, voice_seconds, message_count, streak_days
                FROM user_xp WHERE guild_id = ? AND user_id = ?
                """,
                (guild_id, user_id),
            ) as cur:
                row = await cur.fetchone()
        return UserRow(*(int(v or 0) for v in row)) if row else None

    async def leaderboard_lines(self, guild_id: int, limit: int = 5) -> list[str]:
        rows = await self._db.get_leaderboard(guild_id, limit)
        if not rows:
            return ["Liderlik tablosu: henüz kimse XP kazanmamış."]
        lines = [f"Liderlik tablosu (ilk {len(rows)}, toplam XP'ye göre):"]
        for i, r in enumerate(rows, 1):
            total = int(r["total_xp"])
            lines.append(f"{i}. {self._name_for(int(r['user_id']))} — Seviye {self._level_for(total)}, {total:,} XP")
        return lines

    async def user_lines(self, guild_id: int, user_id: int, *, streak: bool, xp: bool) -> list[str]:
        name = self._name_for(user_id)
        row = await self.peek_user(guild_id, user_id)
        if row is None:
            return [f"{name}: bu sunucuda kayıtlı XP verisi yok."]
        lines = []
        if xp:
            rank = await self._db.get_user_rank(guild_id, user_id)
            lines.append(
                f"{name}: Seviye {self._level_for(row.total_xp)}, toplam {row.total_xp:,} XP "
                f"(yazı {row.text_xp:,} / ses {row.voice_xp:,}), sıralama #{rank}, "
                f"{row.message_count:,} mesaj, ses süresi {_fmt_duration(row.voice_seconds)}."
            )
        if streak:
            lines.append(f"{name}: günlük mesaj serisi {row.streak_days} gün.")
        return lines

    async def bestfriend_lines(self, guild_id: int, user_id: int) -> list[str]:
        name = self._name_for(user_id)
        row = await self._db.get_bestfriend_row(guild_id, user_id)
        if row is None:
            return [f"{name}: ortak ses süresi kaydı yok."]
        seconds = int(row["shared_seconds"])
        status = "Best Friend eşiğini geçti" if seconds >= self._bf_threshold else (
            f"Best Friend eşiğine ({self._bf_threshold // 3600} saat) henüz ulaşmadı"
        )
        return [
            f"{name}: en çok ses geçirdiği kişi {self._name_for(int(row['partner_id']))} — "
            f"{_fmt_duration(seconds)} ortak ses süresi ({status})."
        ]

    async def gather(self, guild_id: int, requester_id: int, question: str, bot_id: int | None) -> list[str]:
        intents = detect_intents(question)
        target = requester_id
        mentioned = False
        for m in _MENTION_RE.finditer(question):
            if int(m.group(1)) != bot_id:
                target = int(m.group(1))
                mentioned = True
                break
        # Üye profili yalnızca "@x kim?" gibi genel sorularda; başka bir istatistik soruluyorsa gereksiz.
        if "member" in intents and (not mentioned or len(intents) > 1):
            intents.remove("member")
        if not intents:
            return []
        lines: list[str] = []
        try:
            if "member" in intents and self._member_info is not None:
                # Discord'da herkesin görebildiği profil bilgisi + seviye.
                lines += self._member_info(guild_id, target)
                if "user_xp" not in intents:
                    lines += await self.user_lines(guild_id, target, streak=False, xp=True)
            if "leaderboard" in intents:
                lines += await self.leaderboard_lines(guild_id)
            # "en çok xp kimde?" gibi sorularda soranın kendi satırı gereksiz.
            want_xp = "user_xp" in intents and ("leaderboard" not in intents or target != requester_id)
            if want_xp or "streak" in intents:
                lines += await self.user_lines(guild_id, target, streak="streak" in intents, xp=want_xp)
            if "bestfriend" in intents:
                lines += await self.bestfriend_lines(guild_id, target)
        except Exception:
            # XP veritabanı sorunu AI yanıtını engellemesin.
            log.exception("Sunucu istatistikleri okunamadı")
        return lines
