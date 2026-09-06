"""
database.py — Merkezi async veritabanı katmanı.

Tüm SQL sorguları bu modülden geçer; xp.py / streak.py hiç
ham SQL görmez. aiosqlite kullandığı için discord.py'nin async
event loop'uyla tam uyumludur.
"""

from __future__ import annotations

import time
from itertools import combinations
from pathlib import Path
from typing import Any

import aiosqlite

DATABASE_PATH = Path(__file__).resolve().parent / "data" / "xp_system.db"

# ---------------------------------------------------------------------------
# Şema
# ---------------------------------------------------------------------------

_DDL = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user_xp (
    guild_id                INTEGER NOT NULL,
    user_id                 INTEGER NOT NULL,
    text_xp                 INTEGER NOT NULL DEFAULT 0,
    voice_xp                INTEGER NOT NULL DEFAULT 0,
    voice_seconds           INTEGER NOT NULL DEFAULT 0,
    active_voice_started_at REAL,
    message_count           INTEGER NOT NULL DEFAULT 0,
    xp_boost_multiplier     REAL    NOT NULL DEFAULT 1.0,
    xp_boost_expires_at     REAL,
    streak_days             INTEGER NOT NULL DEFAULT 0,
    last_message_date       TEXT,
    PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_total_xp
    ON user_xp (guild_id, (text_xp + voice_xp) DESC);

CREATE INDEX IF NOT EXISTS idx_guild_user
    ON user_xp (guild_id, user_id);

CREATE TABLE IF NOT EXISTS voice_pair_stats (
    guild_id      INTEGER NOT NULL,
    user_low_id   INTEGER NOT NULL,
    user_high_id  INTEGER NOT NULL,
    shared_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_low_id, user_high_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_pair_lookup
    ON voice_pair_stats (guild_id, user_low_id, user_high_id);

CREATE INDEX IF NOT EXISTS idx_voice_pair_seconds
    ON voice_pair_stats (guild_id, shared_seconds DESC);
"""

_MIGRATIONS: list[str] = [
    "ALTER TABLE user_xp ADD COLUMN xp_boost_multiplier REAL NOT NULL DEFAULT 1.0",
    "ALTER TABLE user_xp ADD COLUMN xp_boost_expires_at REAL",
    "ALTER TABLE user_xp ADD COLUMN streak_days INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE user_xp ADD COLUMN last_message_date TEXT",
    "ALTER TABLE user_xp ADD COLUMN voice_seconds INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE user_xp ADD COLUMN active_voice_started_at REAL",
    "ALTER TABLE user_xp ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0",
]


async def init_db() -> None:
    """Veritabanını oluşturur, migration'ları uygular."""
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DATABASE_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(_DDL)

        existing = {
            row[1]
            async for row in await db.execute("PRAGMA table_info(user_xp)")
        }
        for stmt in _MIGRATIONS:
            col = stmt.split("ADD COLUMN")[1].strip().split()[0]
            if col not in existing:
                try:
                    await db.execute(stmt)
                except aiosqlite.OperationalError:
                    pass

        await db.commit()


def _db() -> aiosqlite.Connection:
    """Her sorgu için bağımsız bir bağlantı açar (WAL sayesinde güvenli)."""
    return aiosqlite.connect(DATABASE_PATH)


def _utc_today_iso() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).date().isoformat()


def _normalize_pair(user_a: int, user_b: int) -> tuple[int, int]:
    if user_a == user_b:
        raise ValueError("Aynı kullanıcı çifti kaydedilemez.")
    return (user_a, user_b) if user_a < user_b else (user_b, user_a)


# ---------------------------------------------------------------------------
# Kullanıcı yönetimi
# ---------------------------------------------------------------------------

async def ensure_user(guild_id: int, user_id: int) -> None:
    async with _db() as db:
        await db.execute(
            """
            INSERT OR IGNORE INTO user_xp (guild_id, user_id)
            VALUES (?, ?)
            """,
            (guild_id, user_id),
        )
        await db.commit()


async def get_user_row(guild_id: int, user_id: int) -> aiosqlite.Row | None:
    await ensure_user(guild_id, user_id)
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT
                text_xp, voice_xp, voice_seconds,
                active_voice_started_at, message_count,
                (text_xp + voice_xp) AS total_xp,
                xp_boost_multiplier, xp_boost_expires_at,
                streak_days, last_message_date
            FROM user_xp
            WHERE guild_id = ? AND user_id = ?
            """,
            (guild_id, user_id),
        ) as cursor:
            return await cursor.fetchone()


# ---------------------------------------------------------------------------
# XP yazma
# ---------------------------------------------------------------------------

async def add_text_xp(guild_id: int, user_id: int, amount: int) -> None:
    await ensure_user(guild_id, user_id)
    async with _db() as db:
        await db.execute(
            "UPDATE user_xp SET text_xp = text_xp + ? WHERE guild_id = ? AND user_id = ?",
            (amount, guild_id, user_id),
        )
        await db.commit()


async def add_voice_xp(guild_id: int, user_id: int, amount: int) -> None:
    await ensure_user(guild_id, user_id)
    async with _db() as db:
        await db.execute(
            "UPDATE user_xp SET voice_xp = voice_xp + ? WHERE guild_id = ? AND user_id = ?",
            (amount, guild_id, user_id),
        )
        await db.commit()


async def set_xp(guild_id: int, user_id: int, text_xp: int, voice_xp: int) -> None:
    """Admin: XP'yi doğrudan ayarla."""
    await ensure_user(guild_id, user_id)
    async with _db() as db:
        await db.execute(
            """
            UPDATE user_xp
            SET text_xp = ?, voice_xp = ?
            WHERE guild_id = ? AND user_id = ?
            """,
            (max(0, text_xp), max(0, voice_xp), guild_id, user_id),
        )
        await db.commit()


async def add_message_count(guild_id: int, user_id: int) -> None:
    await ensure_user(guild_id, user_id)
    async with _db() as db:
        await db.execute(
            "UPDATE user_xp SET message_count = message_count + 1 WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        )
        await db.commit()


# ---------------------------------------------------------------------------
# Ses oturumu
# ---------------------------------------------------------------------------

async def start_voice_session(guild_id: int, user_id: int) -> None:
    await ensure_user(guild_id, user_id)
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT active_voice_started_at FROM user_xp WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        ) as cur:
            row = await cur.fetchone()

        if row and row["active_voice_started_at"] is not None:
            return  # Zaten aktif oturum var

        await db.execute(
            "UPDATE user_xp SET active_voice_started_at = ? WHERE guild_id = ? AND user_id = ?",
            (time.time(), guild_id, user_id),
        )
        await db.commit()


async def end_voice_session(guild_id: int, user_id: int) -> int:
    """Oturumu kapatır, geçen saniyeyi döner."""
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT active_voice_started_at FROM user_xp WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        ) as cur:
            row = await cur.fetchone()

        if not row or row["active_voice_started_at"] is None:
            return 0

        elapsed = max(0, int(time.time() - row["active_voice_started_at"]))
        await db.execute(
            """
            UPDATE user_xp
            SET voice_seconds = voice_seconds + ?,
                active_voice_started_at = NULL
            WHERE guild_id = ? AND user_id = ?
            """,
            (elapsed, guild_id, user_id),
        )
        await db.commit()
        return elapsed


async def add_pair_voice_seconds_bulk(guild_id: int, user_ids: list[int], amount: int) -> int:
    unique_ids = sorted(set(user_ids))
    if amount <= 0 or len(unique_ids) < 2:
        return 0

    rows = [
        (guild_id, low_id, high_id, amount)
        for low_id, high_id in combinations(unique_ids, 2)
    ]
    if not rows:
        return 0

    async with _db() as db:
        await db.executemany(
            """
            INSERT INTO voice_pair_stats (guild_id, user_low_id, user_high_id, shared_seconds)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, user_low_id, user_high_id)
            DO UPDATE SET shared_seconds = shared_seconds + excluded.shared_seconds
            """,
            rows,
        )
        await db.commit()
    return len(rows)


async def get_bestfriend_row(guild_id: int, user_id: int) -> aiosqlite.Row | None:
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT
                CASE
                    WHEN user_low_id = ? THEN user_high_id
                    ELSE user_low_id
                END AS partner_id,
                shared_seconds
            FROM voice_pair_stats
            WHERE guild_id = ?
              AND (user_low_id = ? OR user_high_id = ?)
            ORDER BY shared_seconds DESC, partner_id ASC
            LIMIT 1
            """,
            (user_id, guild_id, user_id, user_id),
        ) as cur:
            return await cur.fetchone()


async def get_pair_shared_seconds(guild_id: int, user_a: int, user_b: int) -> int:
    low_id, high_id = _normalize_pair(user_a, user_b)
    async with _db() as db:
        async with db.execute(
            """
            SELECT shared_seconds
            FROM voice_pair_stats
            WHERE guild_id = ? AND user_low_id = ? AND user_high_id = ?
            """,
            (guild_id, low_id, high_id),
        ) as cur:
            row = await cur.fetchone()
    return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# Boost
# ---------------------------------------------------------------------------

async def set_boost(
    guild_id: int,
    user_id: int,
    multiplier: float,
    duration_seconds: int,
) -> None:
    await ensure_user(guild_id, user_id)
    expires_at = time.time() + duration_seconds
    async with _db() as db:
        await db.execute(
            """
            UPDATE user_xp
            SET xp_boost_multiplier = ?, xp_boost_expires_at = ?
            WHERE guild_id = ? AND user_id = ?
            """,
            (multiplier, expires_at, guild_id, user_id),
        )
        await db.commit()


async def clear_expired_boosts(guild_id: int, user_id: int) -> None:
    async with _db() as db:
        await db.execute(
            """
            UPDATE user_xp
            SET xp_boost_multiplier = 1.0, xp_boost_expires_at = NULL
            WHERE guild_id = ? AND user_id = ?
              AND xp_boost_expires_at IS NOT NULL
              AND xp_boost_expires_at < ?
            """,
            (guild_id, user_id, time.time()),
        )
        await db.commit()


async def get_active_multiplier(guild_id: int, user_id: int) -> float:
    await clear_expired_boosts(guild_id, user_id)
    row = await get_user_row(guild_id, user_id)
    if row is None:
        return 1.0
    return float(row["xp_boost_multiplier"])


# ---------------------------------------------------------------------------
# Streak
# ---------------------------------------------------------------------------

async def update_streak(guild_id: int, user_id: int) -> tuple[int, bool]:
    """
    Günlük streak'i günceller.
    Döner: (yeni_streak, bugün_ilk_mesaj_mı)
    """
    import datetime
    today = _utc_today_iso()
    yesterday = (
        datetime.datetime.now(datetime.timezone.utc).date() - datetime.timedelta(days=1)
    ).isoformat()

    await ensure_user(guild_id, user_id)

    async with _db() as db:
        db.row_factory = aiosqlite.Row
        await db.execute("BEGIN IMMEDIATE")
        try:
            async with db.execute(
                """
                SELECT streak_days, last_message_date
                FROM user_xp
                WHERE guild_id = ? AND user_id = ?
                """,
                (guild_id, user_id),
            ) as cur:
                row = await cur.fetchone()

            if row is None:
                await db.commit()
                return 1, True

            last_date = row["last_message_date"]
            streak = int(row["streak_days"])

            if last_date == today:
                await db.commit()
                return streak, False

            new_streak = streak + 1 if last_date == yesterday else 1

            await db.execute(
                """
                UPDATE user_xp
                SET streak_days = ?, last_message_date = ?
                WHERE guild_id = ? AND user_id = ?
                """,
                (new_streak, today, guild_id, user_id),
            )
            await db.commit()
            return new_streak, True
        except Exception:
            await db.rollback()
            raise


# ---------------------------------------------------------------------------
# Sıralama & leaderboard
# ---------------------------------------------------------------------------

async def get_user_rank(guild_id: int, user_id: int) -> int:
    row = await get_user_row(guild_id, user_id)
    if row is None:
        return 0

    total = int(row["total_xp"])
    voice = int(row["voice_xp"])
    text = int(row["text_xp"])

    async with _db() as db:
        async with db.execute(
            """
            SELECT COUNT(*) FROM user_xp
            WHERE guild_id = ?
              AND (
                  (text_xp + voice_xp) > ?
                  OR ((text_xp + voice_xp) = ? AND voice_xp > ?)
                  OR ((text_xp + voice_xp) = ? AND voice_xp = ? AND text_xp > ?)
                  OR ((text_xp + voice_xp) = ? AND voice_xp = ? AND text_xp = ? AND user_id < ?)
              )
            """,
            (guild_id, total, total, voice, total, voice, text, total, voice, text, user_id),
        ) as cur:
            result = await cur.fetchone()

    return (result[0] if result else 0) + 1


async def get_leaderboard(guild_id: int, limit: int = 10) -> list[aiosqlite.Row]:
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT user_id, text_xp, voice_xp, voice_seconds, message_count,
                   (text_xp + voice_xp) AS total_xp
            FROM user_xp
            WHERE guild_id = ?
            ORDER BY total_xp DESC, voice_xp DESC, text_xp DESC
            LIMIT ?
            """,
            (guild_id, limit),
        ) as cur:
            return await cur.fetchall()


# ---------------------------------------------------------------------------
# Otomatik Yedekleme
# ---------------------------------------------------------------------------

BACKUP_DIR = Path(__file__).resolve().parent / "data" / "backups"


async def backup_db() -> str | None:
    """Veritabanının tarihli bir yedeğini data/backups/ altına oluşturur."""
    if not DATABASE_PATH.exists():
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    import datetime
    import shutil

    today_str = datetime.datetime.now().strftime("%Y%m%d")
    backup_file = BACKUP_DIR / f"xp_system_{today_str}.db"
    try:
        async with _db() as source:
            await source.execute("PRAGMA wal_checkpoint(PASSIVE)")
        shutil.copy2(DATABASE_PATH, backup_file)
        return str(backup_file)
    except Exception as err:
        print(f"[Backup] Hata: {err}")
        return None
