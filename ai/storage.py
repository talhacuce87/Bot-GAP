"""
ai/storage.py — ai_memory.db erişim katmanı.

XP veritabanından (data/xp_system.db) tamamen ayrıdır; AI migration'ları ve
saklama politikası mevcut şemaya dokunmaz.

Tek bir uzun ömürlü aiosqlite bağlantısı kullanılır ve tüm işlemler bir
asyncio.Lock ile sıralanır: SQLite zaten tek yazıcılıdır, düşük trafikli bir
Discord botunda bu hem en az bellek kullanan hem de çok adımlı işlemlerin
birbirine karışmasını engelleyen en basit yoldur.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import aiosqlite

from ai.migrations import MIGRATIONS
from ai.textutil import normalize_for_index

log = logging.getLogger("gap.ai.storage")

DB_OP_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True)
class StoredMessage:
    message_id: int
    guild_id: int
    channel_id: int
    user_id: int
    author_name: str | None
    content: str
    created_at: float
    reply_to_id: int | None = None
    score: float = 0.0


@dataclass(frozen=True)
class Memory:
    id: int
    guild_id: int
    user_id: int | None
    channel_id: int | None
    scope: str
    memory_type: str
    content: str
    source: str
    confidence: float
    status: str
    created_by: int | None
    created_at: float
    updated_at: float
    expires_at: float | None


@dataclass
class UsageSummary:
    per_provider: dict[str, int] = field(default_factory=dict)
    cost_per_provider: dict[str, float] = field(default_factory=dict)
    per_user: dict[tuple[int, int], int] = field(default_factory=dict)  # yalnızca başarılı cevaplar

    @property
    def total(self) -> int:
        return sum(self.per_provider.values())


def utc_day(ts: float | None = None) -> str:
    when = dt.datetime.fromtimestamp(ts if ts is not None else time.time(), dt.timezone.utc)
    return when.date().isoformat()


def utc_day_start(ts: float | None = None) -> float:
    when = dt.datetime.fromtimestamp(ts if ts is not None else time.time(), dt.timezone.utc)
    return dt.datetime(when.year, when.month, when.day, tzinfo=dt.timezone.utc).timestamp()


def _row_to_message(row: aiosqlite.Row, score: float = 0.0) -> StoredMessage:
    return StoredMessage(
        message_id=row["message_id"],
        guild_id=row["guild_id"],
        channel_id=row["channel_id"],
        user_id=row["user_id"],
        author_name=row["author_name"],
        content=row["content"],
        created_at=row["created_at"],
        reply_to_id=row["reply_to_id"],
        score=score,
    )


def _row_to_memory(row: aiosqlite.Row) -> Memory:
    return Memory(**{k: row[k] for k in Memory.__dataclass_fields__})


_MSG_COLS = "message_id, guild_id, channel_id, user_id, author_name, content, created_at, reply_to_id"
_MEM_COLS = ", ".join(Memory.__dataclass_fields__)


class AIStorage:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Yaşam döngüsü
    # ------------------------------------------------------------------

    async def open(self) -> None:
        if self._conn is not None:
            return
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = await aiosqlite.connect(self.path, timeout=10)
        conn.row_factory = aiosqlite.Row
        try:
            await conn.execute("PRAGMA journal_mode = WAL")
            await conn.execute("PRAGMA synchronous = NORMAL")
            await conn.execute("PRAGMA foreign_keys = ON")
            await conn.execute("PRAGMA busy_timeout = 5000")
            await conn.execute("PRAGMA temp_store = MEMORY")
            await conn.execute("PRAGMA cache_size = -2000")  # ~2 MB sayfa önbelleği
            self._conn = conn
            await self._migrate()
        except Exception:
            self._conn = None
            await conn.close()
            raise

    async def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                await conn.execute("PRAGMA optimize")
            except sqlite3.Error:
                pass
            await conn.close()

    @property
    def is_open(self) -> bool:
        return self._conn is not None

    def _c(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("AI veritabanı açık değil")
        return self._conn

    async def _run(self, coro_fn, *args):
        """Kilit + zaman aşımı altında bir DB işlemi çalıştırır."""
        async with self._lock:
            return await asyncio.wait_for(coro_fn(self._c(), *args), DB_OP_TIMEOUT_SECONDS)

    async def _migrate(self) -> None:
        conn = self._c()
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_schema_migrations (
                version    INTEGER PRIMARY KEY,
                name       TEXT NOT NULL,
                applied_at REAL NOT NULL
            )
            """
        )
        async with conn.execute("SELECT version FROM ai_schema_migrations") as cur:
            applied = {row[0] async for row in cur}
        for version, name, sql in MIGRATIONS:
            if version in applied:
                continue
            log.info("AI DB migration uygulanıyor: %d (%s)", version, name)
            # executescript kendi COMMIT'ini yapar; IF NOT EXISTS ifadeleri tekrar güvenli.
            # ALTER TABLE ADD COLUMN için IF NOT EXISTS olmadığından, yarıda kalmış bir
            # migration'ın tekrarında "duplicate column" hatası uygulanmış sayılır.
            try:
                await conn.executescript(sql)
            except sqlite3.OperationalError as err:
                if "duplicate column" not in str(err).lower():
                    raise
                log.info("Migration %d: sütun zaten var, devam ediliyor", version)
            await conn.execute(
                "INSERT OR IGNORE INTO ai_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                (version, name, time.time()),
            )
            await conn.commit()

    async def schema_version(self) -> int:
        async def op(c):
            async with c.execute("SELECT COALESCE(MAX(version), 0) FROM ai_schema_migrations") as cur:
                return (await cur.fetchone())[0]
        return await self._run(op)

    # ------------------------------------------------------------------
    # Ayarlar
    # ------------------------------------------------------------------

    async def load_settings(self) -> list[tuple[int, int, str, str]]:
        async def op(c):
            async with c.execute("SELECT guild_id, channel_id, key, value FROM ai_settings") as cur:
                return [tuple(r) for r in await cur.fetchall()]
        return await self._run(op)

    async def set_setting(self, guild_id: int, channel_id: int, key: str, value: str, by: int | None) -> None:
        async def op(c):
            await c.execute(
                """
                INSERT INTO ai_settings (guild_id, channel_id, key, value, updated_by, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(guild_id, channel_id, key)
                DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
                              updated_at = excluded.updated_at
                """,
                (guild_id, channel_id, key, value, by, time.time()),
            )
            await c.commit()
        await self._run(op)

    # ------------------------------------------------------------------
    # Kullanıcı gizlilik tercihleri
    # ------------------------------------------------------------------

    async def load_opt_outs(self) -> set[tuple[int, int]]:
        async def op(c):
            async with c.execute("SELECT guild_id, user_id FROM ai_user_privacy WHERE opted_out = 1") as cur:
                return {(r[0], r[1]) for r in await cur.fetchall()}
        return await self._run(op)

    async def set_opt_out(self, guild_id: int, user_id: int, opted_out: bool) -> None:
        async def op(c):
            await c.execute(
                """
                INSERT INTO ai_user_privacy (guild_id, user_id, opted_out, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(guild_id, user_id)
                DO UPDATE SET opted_out = excluded.opted_out, updated_at = excluded.updated_at
                """,
                (guild_id, user_id, int(opted_out), time.time()),
            )
            await c.commit()
        await self._run(op)

    # ------------------------------------------------------------------
    # Mesajlar
    # ------------------------------------------------------------------

    async def insert_message(
        self,
        *,
        message_id: int,
        guild_id: int,
        channel_id: int,
        user_id: int,
        author_name: str | None,
        content: str,
        created_at: float,
        reply_to_id: int | None = None,
    ) -> bool:
        """Mesajı kaydeder. Aynı message_id zaten varsa (silinmiş dahil) False döner."""
        norm = normalize_for_index(content)

        async def op(c):
            cur = await c.execute(
                """
                INSERT OR IGNORE INTO ai_messages
                    (message_id, guild_id, channel_id, user_id, author_name,
                     content, norm_content, reply_to_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (message_id, guild_id, channel_id, user_id, author_name,
                 content, norm, reply_to_id, created_at),
            )
            await c.commit()
            return (cur.rowcount or 0) > 0
        return await self._run(op)

    async def update_message(self, message_id: int, content: str, edited_at: float) -> bool:
        norm = normalize_for_index(content)

        async def op(c):
            cur = await c.execute(
                """
                UPDATE ai_messages
                SET content = ?, norm_content = ?, edited_at = ?
                WHERE message_id = ? AND deleted_at IS NULL
                """,
                (content, norm, edited_at, message_id),
            )
            await c.commit()
            return (cur.rowcount or 0) > 0
        return await self._run(op)

    async def delete_messages(self, message_ids: Iterable[int]) -> tuple[int, int]:
        """
        Mesajları siler: içerik boşaltılır (FTS'den düşer), yalnızca tekrar
        eklenmesini engelleyen bir mezar taşı kalır. Tek kaynağı bu mesajlar
        olan ve kullanıcı tarafından onaylanmamış türetilmiş hafızalar iptal
        edilir. Döner: (silinen_mesaj, iptal_edilen_hafıza)
        """
        ids = list(dict.fromkeys(int(i) for i in message_ids))
        if not ids:
            return 0, 0

        async def op(c):
            now = time.time()
            deleted = revoked = 0
            for chunk_start in range(0, len(ids), 500):
                chunk = ids[chunk_start: chunk_start + 500]
                marks = ",".join("?" * len(chunk))
                cur = await c.execute(
                    f"""
                    UPDATE ai_messages
                    SET content = '', norm_content = '', author_name = NULL, deleted_at = ?
                    WHERE message_id IN ({marks}) AND deleted_at IS NULL
                    """,
                    (now, *chunk),
                )
                deleted += cur.rowcount or 0

                async with c.execute(
                    f"SELECT DISTINCT memory_id FROM ai_memory_sources WHERE message_id IN ({marks})",
                    chunk,
                ) as mcur:
                    affected = [r[0] for r in await mcur.fetchall()]
                await c.execute(f"DELETE FROM ai_memory_sources WHERE message_id IN ({marks})", chunk)
                if affected:
                    amarks = ",".join("?" * len(affected))
                    cur = await c.execute(
                        f"""
                        UPDATE ai_memories
                        SET status = 'revoked', content = '', norm_content = '', updated_at = ?
                        WHERE id IN ({amarks})
                          AND source = 'extracted'
                          AND status != 'confirmed'
                          AND NOT EXISTS (SELECT 1 FROM ai_memory_sources s WHERE s.memory_id = ai_memories.id)
                        """,
                        (now, *affected),
                    )
                    revoked += cur.rowcount or 0
            await c.commit()
            return deleted, revoked
        return await self._run(op)

    async def get_message(self, message_id: int) -> StoredMessage | None:
        async def op(c):
            async with c.execute(
                f"SELECT {_MSG_COLS} FROM ai_messages WHERE message_id = ? AND deleted_at IS NULL",
                (message_id,),
            ) as cur:
                row = await cur.fetchone()
            return _row_to_message(row) if row else None
        return await self._run(op)

    async def recent_messages(
        self,
        guild_id: int,
        channel_id: int,
        limit: int,
        before_ts: float | None = None,
    ) -> list[StoredMessage]:
        """Kanalın son mesajları, kronolojik sırada."""
        if limit <= 0:
            return []

        async def op(c):
            async with c.execute(
                f"""
                SELECT {_MSG_COLS} FROM ai_messages
                WHERE guild_id = ? AND channel_id = ? AND deleted_at IS NULL
                  AND created_at < ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (guild_id, channel_id, before_ts if before_ts is not None else time.time() + 1, limit),
            ) as cur:
                rows = await cur.fetchall()
            return [_row_to_message(r) for r in reversed(rows)]
        return await self._run(op)

    async def search_messages(
        self,
        guild_id: int,
        fts_query: str,
        channel_ids: Iterable[int],
        *,
        user_id: int | None = None,
        since: float | None = None,
        until: float | None = None,
        limit: int = 10,
    ) -> list[StoredMessage]:
        """
        FTS5 araması. Sonuçlar her zaman guild_id ve verilen kanal listesiyle
        sınırlanır; kanal listesi boşsa hiçbir şey dönmez. Skor: bm25 (küçük
        = daha alakalı), burada işareti çevrilip büyük = iyi yapılır.
        """
        channels = list(dict.fromkeys(channel_ids))
        if not channels or not fts_query:
            return []
        sql = f"""
            SELECT {', '.join('m.' + c.strip() for c in _MSG_COLS.split(','))},
                   bm25(ai_messages_fts) AS rank
            FROM ai_messages_fts
            JOIN ai_messages m ON m.message_id = ai_messages_fts.rowid
            WHERE ai_messages_fts MATCH ?
              AND m.guild_id = ?
              AND m.deleted_at IS NULL
              AND m.channel_id IN ({','.join('?' * len(channels))})
        """
        params: list[Any] = [fts_query, guild_id, *channels]
        if user_id is not None:
            sql += " AND m.user_id = ?"
            params.append(user_id)
        if since is not None:
            sql += " AND m.created_at >= ?"
            params.append(since)
        if until is not None:
            sql += " AND m.created_at < ?"
            params.append(until)
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        async def op(c):
            try:
                async with c.execute(sql, params) as cur:
                    rows = await cur.fetchall()
            except sqlite3.OperationalError as err:
                # Bozuk FTS sözdizimi kullanıcı hatasıdır; botu düşürmesin.
                log.warning("FTS sorgusu başarısız (%s): %r", err, fts_query)
                return []
            return [_row_to_message(r, score=-float(r["rank"])) for r in rows]
        return await self._run(op)

    async def neighbors(
        self,
        guild_id: int,
        channel_id: int,
        around_ts: float,
        count: int,
        window_seconds: float,
    ) -> list[StoredMessage]:
        """Bir mesajın etrafındaki (önce/sonra) en fazla `count`'ar mesaj."""
        if count <= 0:
            return []

        async def op(c):
            async with c.execute(
                f"""
                SELECT {_MSG_COLS} FROM ai_messages
                WHERE guild_id = ? AND channel_id = ? AND deleted_at IS NULL
                  AND created_at < ? AND created_at >= ?
                ORDER BY created_at DESC LIMIT ?
                """,
                (guild_id, channel_id, around_ts, around_ts - window_seconds, count),
            ) as cur:
                before = list(reversed(await cur.fetchall()))
            async with c.execute(
                f"""
                SELECT {_MSG_COLS} FROM ai_messages
                WHERE guild_id = ? AND channel_id = ? AND deleted_at IS NULL
                  AND created_at > ? AND created_at <= ?
                ORDER BY created_at ASC LIMIT ?
                """,
                (guild_id, channel_id, around_ts, around_ts + window_seconds, count),
            ) as cur:
                after = await cur.fetchall()
            return [_row_to_message(r) for r in (*before, *after)]
        return await self._run(op)

    async def count_user_data(self, guild_id: int, user_id: int) -> tuple[int, int]:
        async def op(c):
            async with c.execute(
                "SELECT COUNT(*) FROM ai_messages WHERE guild_id = ? AND user_id = ? AND deleted_at IS NULL",
                (guild_id, user_id),
            ) as cur:
                msgs = (await cur.fetchone())[0]
            async with c.execute(
                """
                SELECT COUNT(*) FROM ai_memories
                WHERE guild_id = ? AND (user_id = ? OR created_by = ?) AND status != 'revoked'
                """,
                (guild_id, user_id, user_id),
            ) as cur:
                mems = (await cur.fetchone())[0]
            return msgs, mems
        return await self._run(op)

    async def delete_user_data(self, guild_id: int, user_id: int) -> tuple[int, int]:
        """
        Kullanıcının bu sunucudaki tüm mesaj kayıtlarını ve kişisel hafızalarını
        kalıcı olarak siler. Kullanıcının mesajlarına dayanan türetilmiş
        hafızalar da iptal edilir. Döner: (mesaj, hafıza)
        """
        async with self._lock:
            c = self._c()
            async with c.execute(
                "SELECT message_id FROM ai_messages WHERE guild_id = ? AND user_id = ?",
                (guild_id, user_id),
            ) as cur:
                msg_ids = [r[0] for r in await cur.fetchall()]

        _, revoked = await self.delete_messages(msg_ids)

        async def op(c):
            # Mezar taşları dahil satırları tamamen kaldır (FTS içeriği zaten boş).
            cur = await c.execute(
                "DELETE FROM ai_messages WHERE guild_id = ? AND user_id = ?", (guild_id, user_id)
            )
            msgs = cur.rowcount or 0
            cur = await c.execute(
                "DELETE FROM ai_memories WHERE guild_id = ? AND (user_id = ? OR created_by = ?)",
                (guild_id, user_id, user_id),
            )
            mems = cur.rowcount or 0
            await c.execute(
                """
                DELETE FROM ai_memory_participants
                WHERE user_id = ? AND memory_id IN (SELECT id FROM ai_memories WHERE guild_id = ?)
                """,
                (user_id, guild_id),
            )
            await c.execute("DELETE FROM ai_memories WHERE status = 'revoked' AND guild_id = ?", (guild_id,))
            await c.commit()
            return msgs, mems + revoked
        return await self._run(op)

    # ------------------------------------------------------------------
    # Hafızalar
    # ------------------------------------------------------------------

    async def add_memory(
        self,
        *,
        guild_id: int,
        scope: str,
        memory_type: str,
        content: str,
        source: str,
        status: str,
        user_id: int | None = None,
        channel_id: int | None = None,
        confidence: float = 1.0,
        created_by: int | None = None,
        expires_at: float | None = None,
        participants: Iterable[int] = (),
        source_messages: Iterable[tuple[int, int | None]] = (),
    ) -> tuple[int, bool]:
        """
        Hafıza ekler. Aynı kapsamda normalize içeriği aynı olan aktif bir kayıt
        varsa yenisi oluşturulmaz; mevcut kayıt güncellenir (adayken onaylanırsa
        onaylı hale gelir). Döner: (id, yeni_mi)
        """
        norm = normalize_for_index(content)

        async def op(c):
            now = time.time()
            async with c.execute(
                """
                SELECT id, status FROM ai_memories
                WHERE guild_id = ? AND scope = ? AND norm_content = ? AND status != 'revoked'
                  AND user_id IS ? AND channel_id IS ?
                LIMIT 1
                """,
                (guild_id, scope, norm, user_id, channel_id),
            ) as cur:
                existing = await cur.fetchone()

            if existing:
                mem_id = existing["id"]
                new_status = "confirmed" if "confirmed" in (existing["status"], status) else status
                await c.execute(
                    """
                    UPDATE ai_memories
                    SET status = ?, confidence = MAX(confidence, ?), updated_at = ?,
                        expires_at = CASE WHEN ? = 'confirmed' THEN ? ELSE expires_at END
                    WHERE id = ?
                    """,
                    (new_status, confidence, now, new_status, expires_at, mem_id),
                )
                created = False
            else:
                cur = await c.execute(
                    """
                    INSERT INTO ai_memories
                        (guild_id, user_id, channel_id, scope, memory_type, content, norm_content,
                         source, confidence, status, created_by, created_at, updated_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (guild_id, user_id, channel_id, scope, memory_type, content, norm,
                     source, confidence, status, created_by, now, now, expires_at),
                )
                mem_id = cur.lastrowid
                created = True

            await c.executemany(
                "INSERT OR IGNORE INTO ai_memory_participants (memory_id, user_id) VALUES (?, ?)",
                [(mem_id, uid) for uid in set(participants)],
            )
            await c.executemany(
                "INSERT OR IGNORE INTO ai_memory_sources (memory_id, message_id, channel_id) VALUES (?, ?, ?)",
                [(mem_id, mid, ch) for mid, ch in source_messages],
            )
            await c.commit()
            return mem_id, created
        return await self._run(op)

    async def get_memory(self, memory_id: int) -> Memory | None:
        async def op(c):
            async with c.execute(f"SELECT {_MEM_COLS} FROM ai_memories WHERE id = ?", (memory_id,)) as cur:
                row = await cur.fetchone()
            return _row_to_memory(row) if row else None
        return await self._run(op)

    async def list_user_memories(
        self,
        guild_id: int,
        user_id: int,
        statuses: tuple[str, ...] = ("candidate", "confirmed"),
        limit: int = 50,
    ) -> list[Memory]:
        async def op(c):
            async with c.execute(
                f"""
                SELECT {_MEM_COLS} FROM ai_memories
                WHERE guild_id = ? AND user_id = ? AND scope = 'user'
                  AND status IN ({','.join('?' * len(statuses))})
                  AND (expires_at IS NULL OR expires_at > ?)
                ORDER BY status = 'confirmed' DESC, updated_at DESC
                LIMIT ?
                """,
                (guild_id, user_id, *statuses, time.time(), limit),
            ) as cur:
                return [_row_to_memory(r) for r in await cur.fetchall()]
        return await self._run(op)

    async def list_episodic(
        self,
        guild_id: int,
        channel_ids: Iterable[int],
        *,
        statuses: tuple[str, ...] = ("confirmed",),
        participant_id: int | None = None,
        limit: int = 20,
    ) -> list[Memory]:
        """Yalnızca yetkili kanallara bağlı episodik hafızalar."""
        channels = list(dict.fromkeys(channel_ids))
        if not channels:
            return []
        sql = f"""
            SELECT {', '.join('m.' + f for f in Memory.__dataclass_fields__)} FROM ai_memories m
            WHERE m.guild_id = ? AND m.scope = 'episodic'
              AND m.status IN ({','.join('?' * len(statuses))})
              AND m.channel_id IN ({','.join('?' * len(channels))})
              AND (m.expires_at IS NULL OR m.expires_at > ?)
        """
        params: list[Any] = [guild_id, *statuses, *channels, time.time()]
        if participant_id is not None:
            sql += " AND EXISTS (SELECT 1 FROM ai_memory_participants p WHERE p.memory_id = m.id AND p.user_id = ?)"
            params.append(participant_id)
        sql += " ORDER BY m.updated_at DESC LIMIT ?"
        params.append(limit)

        async def op(c):
            async with c.execute(sql, params) as cur:
                return [_row_to_memory(r) for r in await cur.fetchall()]
        return await self._run(op)

    async def memory_participants(self, memory_id: int) -> list[int]:
        async def op(c):
            async with c.execute(
                "SELECT user_id FROM ai_memory_participants WHERE memory_id = ? ORDER BY user_id", (memory_id,)
            ) as cur:
                return [r[0] for r in await cur.fetchall()]
        return await self._run(op)

    async def memory_sources(self, memory_id: int) -> list[tuple[int, int | None]]:
        async def op(c):
            async with c.execute(
                "SELECT message_id, channel_id FROM ai_memory_sources WHERE memory_id = ?", (memory_id,)
            ) as cur:
                return [(r[0], r[1]) for r in await cur.fetchall()]
        return await self._run(op)

    async def set_memory_status(self, memory_id: int, status: str, expires_at: float | None = None) -> bool:
        async def op(c):
            cur = await c.execute(
                "UPDATE ai_memories SET status = ?, expires_at = ?, updated_at = ? WHERE id = ? AND status != 'revoked'",
                (status, expires_at, time.time(), memory_id),
            )
            await c.commit()
            return (cur.rowcount or 0) > 0
        return await self._run(op)

    async def delete_memory(self, memory_id: int) -> bool:
        async def op(c):
            cur = await c.execute("DELETE FROM ai_memories WHERE id = ?", (memory_id,))
            await c.commit()
            return (cur.rowcount or 0) > 0
        return await self._run(op)

    # ------------------------------------------------------------------
    # Kullanım muhasebesi
    # ------------------------------------------------------------------

    async def record_usage(
        self,
        *,
        provider: str,
        model: str | None,
        guild_id: int | None,
        user_id: int | None,
        input_tokens: int | None,
        output_tokens: int | None,
        error_code: str | None,
        cost_usd: float | None = None,
        ts: float | None = None,
    ) -> None:
        ts = ts if ts is not None else time.time()

        async def op(c):
            await c.execute(
                """
                INSERT INTO ai_usage
                    (ts, day, guild_id, user_id, provider, model, request_count,
                     approximate_input_tokens, approximate_output_tokens, error_code, approximate_cost_usd)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                """,
                (ts, utc_day(ts), guild_id, user_id, provider, model, input_tokens, output_tokens,
                 error_code, cost_usd),
            )
            await c.commit()
        await self._run(op)

    async def usage_counts(self, day: str) -> "UsageSummary":
        """Belirtilen UTC günü için sağlayıcı ve kullanıcı bazında istek sayıları ve tahmini maliyet."""
        async def op(c):
            async with c.execute(
                """
                SELECT provider, guild_id, user_id, SUM(request_count), SUM(COALESCE(approximate_cost_usd, 0)),
                       SUM(CASE WHEN error_code IS NULL THEN request_count ELSE 0 END)
                FROM ai_usage WHERE day = ? GROUP BY provider, guild_id, user_id
                """,
                (day,),
            ) as cur:
                rows = await cur.fetchall()
            summary = UsageSummary()
            for provider, gid, uid, count, cost, ok_count in rows:
                count = int(count or 0)
                summary.per_provider[provider] = summary.per_provider.get(provider, 0) + count
                summary.cost_per_provider[provider] = summary.cost_per_provider.get(provider, 0.0) + float(cost or 0)
                # Kişisel sınır yalnızca başarılı cevapları sayar; sağlayıcı hataları kullanıcıdan düşmez.
                if gid is not None and uid is not None and ok_count:
                    summary.per_user[(gid, uid)] = summary.per_user.get((gid, uid), 0) + int(ok_count)
            return summary
        return await self._run(op)

    # ------------------------------------------------------------------
    # Bakım
    # ------------------------------------------------------------------

    async def prune(
        self,
        default_retention_days: int,
        guild_retention: dict[int, int],
        candidate_retention_days: int,
        usage_retention_days: int = 90,
    ) -> dict[str, int]:
        now = time.time()

        async def op(c):
            result = {"messages": 0, "memories": 0, "usage": 0}
            # Sunucuya özel saklama süresi olanlar
            for guild_id, days in guild_retention.items():
                cur = await c.execute(
                    "DELETE FROM ai_messages WHERE guild_id = ? AND created_at < ?",
                    (guild_id, now - days * 86400),
                )
                result["messages"] += cur.rowcount or 0
            # Geri kalanlar varsayılan süreyle
            params: list[Any] = [now - default_retention_days * 86400]
            sql = "DELETE FROM ai_messages WHERE created_at < ?"
            if guild_retention:
                sql += f" AND guild_id NOT IN ({','.join('?' * len(guild_retention))})"
                params.extend(guild_retention)
            cur = await c.execute(sql, params)
            result["messages"] += cur.rowcount or 0

            # Süresi geçmiş hafızalar, eski adaylar, iptal edilmişler
            cur = await c.execute(
                """
                DELETE FROM ai_memories
                WHERE status = 'revoked'
                   OR (expires_at IS NOT NULL AND expires_at < ?)
                   OR (status = 'candidate' AND updated_at < ?)
                """,
                (now, now - candidate_retention_days * 86400),
            )
            result["memories"] = cur.rowcount or 0
            # Kaynak mesajı saklama süresiyle silinmiş referanslar
            await c.execute(
                """
                DELETE FROM ai_memory_sources
                WHERE message_id NOT IN (SELECT message_id FROM ai_messages)
                """
            )
            cur = await c.execute("DELETE FROM ai_usage WHERE ts < ?", (now - usage_retention_days * 86400,))
            result["usage"] = cur.rowcount or 0
            await c.commit()
            await c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            return result
        return await self._run(op)

    async def rebuild_fts(self) -> None:
        async def op(c):
            await c.execute("INSERT INTO ai_messages_fts(ai_messages_fts) VALUES ('rebuild')")
            await c.commit()
        await self._run(op)

    async def integrity_check_fts(self) -> bool:
        async def op(c):
            try:
                await c.execute("INSERT INTO ai_messages_fts(ai_messages_fts, rank) VALUES ('integrity-check', 1)")
                return True
            except sqlite3.DatabaseError:
                return False
        return await self._run(op)

    async def backup(self, dest: Path) -> Path:
        """SQLite online backup API ile tutarlı bir kopya alır (aktif yazmalar sırasında da güvenli)."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".tmp")

        async def op(c):
            target = await aiosqlite.connect(tmp)
            try:
                await c.backup(target)
            finally:
                await target.close()
        await self._run(op)
        tmp.replace(dest)
        return dest

    async def stats(self) -> dict[str, int]:
        async def op(c):
            out: dict[str, int] = {}
            for name, sql in (
                ("messages", "SELECT COUNT(*) FROM ai_messages WHERE deleted_at IS NULL"),
                ("memories", "SELECT COUNT(*) FROM ai_memories WHERE status = 'confirmed'"),
                ("candidates", "SELECT COUNT(*) FROM ai_memories WHERE status = 'candidate'"),
            ):
                async with c.execute(sql) as cur:
                    out[name] = (await cur.fetchone())[0]
            return out
        result = await self._run(op)
        if str(self.path) != ":memory:":
            result["db_bytes"] = self.path.stat().st_size if self.path.exists() else 0
            wal = self.path.with_name(self.path.name + "-wal")
            result["wal_bytes"] = wal.stat().st_size if wal.exists() else 0
        return result
