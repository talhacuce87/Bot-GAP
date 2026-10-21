"""
database.py — Merkezi async veritabanı katmanı.

Tüm SQL sorguları bu modülden geçer; xp.py / streak.py hiç
ham SQL görmez. aiosqlite kullandığı için discord.py'nin async
event loop'uyla tam uyumludur.
"""

from __future__ import annotations

import datetime
import json
import logging
import time
from itertools import combinations
from pathlib import Path
from typing import Any, Callable

import aiosqlite

log = logging.getLogger("gap.db")

DATABASE_PATH = Path(__file__).resolve().parent / "data" / "xp_system.db"

# Streak günleri Türkiye saatine (UTC+3, yaz saati yok) göre döner.
STREAK_TZ = datetime.timezone(datetime.timedelta(hours=3), "TRT")

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

CREATE TABLE IF NOT EXISTS activity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          REAL    NOT NULL,
    guild_id    INTEGER,
    user_id     INTEGER,
    event       TEXT    NOT NULL,
    channel_id  INTEGER,
    amount      INTEGER,
    actor_id    INTEGER,
    meta        TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_user_ts
    ON activity_log (guild_id, user_id, ts);

CREATE INDEX IF NOT EXISTS idx_activity_event_ts
    ON activity_log (guild_id, event, ts);

CREATE INDEX IF NOT EXISTS idx_activity_ts
    ON activity_log (ts);

-- Sürgün (XP cezası). ends_at NULL = kalıcı. Ceza bitince satır silinir.
CREATE TABLE IF NOT EXISTS exiles (
    guild_id        INTEGER NOT NULL,
    user_id         INTEGER NOT NULL,
    started_at      REAL    NOT NULL,
    ends_at         REAL,
    reason          TEXT    NOT NULL,
    moderator_id    INTEGER NOT NULL,
    channel_id      INTEGER,
    streak_at_start INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
);

-- Başarımlar: kazanılan kademe (tek kademelilerde 1)
CREATE TABLE IF NOT EXISTS achievements (
    guild_id    INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    key         TEXT    NOT NULL,
    tier        INTEGER NOT NULL,
    unlocked_at REAL    NOT NULL,
    PRIMARY KEY (guild_id, user_id, key)
);

-- Başarım sayaçları (olay kaydı silinse de kalıcı). Kümeler için değer 1 (ör. "ch:<kanal>").
CREATE TABLE IF NOT EXISTS achievement_counters (
    guild_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    key      TEXT    NOT NULL,
    value    REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, key)
);

-- Olay kaydının başarımlara işlenen son satırı
CREATE TABLE IF NOT EXISTS achievement_state (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    last_id INTEGER NOT NULL DEFAULT 0
);

-- !kart'ta gösterilecek (en fazla 3) başarım
CREATE TABLE IF NOT EXISTS card_badges (
    guild_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    keys     TEXT    NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);

-- Haftalık özet / aylık Wrapped ödülleri (haftanın ikilisi, gece kuşu, ayın MVP'si)
CREATE TABLE IF NOT EXISTS summary_awards (
    guild_id INTEGER NOT NULL,
    period   TEXT    NOT NULL,
    award    TEXT    NOT NULL,
    user_id  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, period, award, user_id)
);

-- Gölde balık tutma (fishing.py): son tutulan gün ve art arda gün serisi
CREATE TABLE IF NOT EXISTS fishing (
    guild_id  INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    last_date TEXT    NOT NULL,
    streak    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
);

-- GAP Dünyası sayaçları (world_quests.py): balık albümü, gol, oyun galibiyeti, tank vuruşu.
-- Sezonluk anahtarlar "s:<YYYY-MM>:<ad>" biçimindedir.
CREATE TABLE IF NOT EXISTS world_stats (
    guild_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    key      TEXT    NOT NULL,
    value    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_world_stats_key
    ON world_stats (guild_id, key, value DESC);

-- GAP Dünyası günlük görevleri: gün (Türkiye), görev, ilerleme, tamamlandı mı
CREATE TABLE IF NOT EXISTS world_quests (
    guild_id INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    day      TEXT    NOT NULL,
    key      TEXT    NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    done     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, day, key)
);

-- GAP Dünyası mahallesi: arsa başına sahibi ve blokları (dünya sunucusunun kısa metin biçimi)
CREATE TABLE IF NOT EXISTS world_builds (
    guild_id   INTEGER NOT NULL,
    plot       INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    data       TEXT    NOT NULL DEFAULT '',
    updated_at REAL    NOT NULL,
    PRIMARY KEY (guild_id, plot)
);

-- Chibi karakter kıyafeti (outfit.py): parça kimlikleri ve renkler, JSON
CREATE TABLE IF NOT EXISTS avatar_outfit (
    guild_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    outfit     TEXT    NOT NULL,
    updated_at REAL    NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
"""

_MIGRATIONS: list[str] = [
    "ALTER TABLE user_xp ADD COLUMN xp_boost_multiplier REAL NOT NULL DEFAULT 1.0",
    "ALTER TABLE user_xp ADD COLUMN xp_boost_expires_at REAL",
    "ALTER TABLE user_xp ADD COLUMN streak_days INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE user_xp ADD COLUMN last_message_date TEXT",
    "ALTER TABLE user_xp ADD COLUMN voice_seconds INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE user_xp ADD COLUMN active_voice_started_at REAL",
    "ALTER TABLE user_xp ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0",
    # Balık boost'u (sabit 2x) yönetici boost'undan ayrı tutulur
    "ALTER TABLE user_xp ADD COLUMN fish_boost_expires_at REAL",
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


def _today() -> datetime.date:
    return datetime.datetime.now(STREAK_TZ).date()


def next_day_start() -> float:
    """Yarının (Türkiye saatiyle) başladığı an, epoch saniye: günlük hakların yenilendiği an."""
    tomorrow = _today() + datetime.timedelta(days=1)
    return datetime.datetime.combine(tomorrow, datetime.time(), STREAK_TZ).timestamp()


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
                xp_boost_multiplier, xp_boost_expires_at, fish_boost_expires_at,
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


async def set_total_xp(
    guild_id: int,
    user_id: int,
    *,
    total: int | None = None,
    delta: int | None = None,
) -> tuple[int, int]:
    """
    Admin: toplam XP'yi ayarlar (total) ya da değiştirir (delta).
    Mesaj/ses XP oranı korunur; hiç XP yoksa tamamı mesaj XP'sine yazılır.
    Döner: (önceki_toplam, yeni_toplam)
    """
    await ensure_user(guild_id, user_id)
    async with _db() as db:
        async with db.execute(
            "SELECT text_xp, voice_xp FROM user_xp WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        ) as cur:
            row = await cur.fetchone()

        text_xp, voice_xp = int(row[0]), int(row[1])
        current = text_xp + voice_xp
        new_total = total if total is not None else current + (delta or 0)
        new_total = max(0, new_total)

        new_text = round(new_total * text_xp / current) if current > 0 else new_total
        await db.execute(
            "UPDATE user_xp SET text_xp = ?, voice_xp = ? WHERE guild_id = ? AND user_id = ?",
            (new_text, new_total - new_text, guild_id, user_id),
        )
        await db.commit()
        return current, new_total


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


async def flush_voice_sessions(guild_id: int) -> None:
    """
    Sunucudaki tüm aktif oturumların geçen süresini voice_seconds'a yazar ve
    başlangıcı ileri taşır. Periyodik çağrıldığı için bot çökse bile en fazla
    bir periyotluk süre kaybolur; bot kapalıyken geçen süre asla eklenmez.
    """
    now = time.time()
    async with _db() as db:
        await db.execute(
            """
            UPDATE user_xp
            SET voice_seconds = voice_seconds
                    + MAX(0, CAST(? - active_voice_started_at AS INTEGER)),
                active_voice_started_at = active_voice_started_at
                    + MAX(0, CAST(? - active_voice_started_at AS INTEGER))
            WHERE guild_id = ? AND active_voice_started_at IS NOT NULL
            """,
            (now, now, guild_id),
        )
        await db.commit()


async def close_stale_voice_sessions(guild_id: int, max_elapsed: int) -> None:
    """
    Açılışta çağrılır: önceki çalışmadan kalan oturumları kapatır. Son flush'tan
    sonra en fazla max_elapsed saniye eklenir (botun kapalı kaldığı süre sayılmaz).
    """
    now = time.time()
    async with _db() as db:
        await db.execute(
            """
            UPDATE user_xp
            SET voice_seconds = voice_seconds
                    + MIN(?, MAX(0, CAST(? - active_voice_started_at AS INTEGER))),
                active_voice_started_at = NULL
            WHERE guild_id = ? AND active_voice_started_at IS NOT NULL
            """,
            (max_elapsed, now, guild_id),
        )
        await db.commit()


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


async def get_bestfriend_rows(guild_id: int, user_id: int, limit: int = 10) -> list[aiosqlite.Row]:
    """Kullanıcının en çok ses geçirdiği kişiler (çoktan aza)."""
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
            LIMIT ?
            """,
            (user_id, guild_id, user_id, user_id, limit),
        ) as cur:
            return list(await cur.fetchall())


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
    if not (1.0 <= multiplier <= 10.0):  # NaN da bu kontrolden geçemez
        raise ValueError(f"Geçersiz boost çarpanı: {multiplier}")
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
    return (await get_active_boost(guild_id, user_id))[0]


async def get_active_boost(guild_id: int, user_id: int) -> tuple[float, str | None]:
    """Geçerli çarpan ve kaynağı: "admin" (!boost), "fish" (gölde balık) ya da boost yoksa None."""
    await clear_expired_boosts(guild_id, user_id)
    row = await get_user_row(guild_id, user_id)
    if row is None:
        return 1.0, None
    mult, expires = active_boost(row)
    if expires is None:
        return 1.0, None
    fish = row["fish_boost_expires_at"]
    return mult, "fish" if fish is not None and float(fish) == expires else "admin"


FISH_BOOST_MULTIPLIER = 2.0


def active_boost(row: aiosqlite.Row) -> tuple[float, float | None]:
    """
    Geçerli boost (çarpan, bitiş); yoksa (1.0, None). Yönetici boost'u ile balık
    boost'undan (2x) büyük olanı geçerlidir.
    """
    now = time.time()
    mult = float(row["xp_boost_multiplier"])
    expires = row["xp_boost_expires_at"]
    best: tuple[float, float | None] = (1.0, None)
    # Bozuk değerlere karşı koruma
    if expires is not None and expires > now and 1.0 < mult <= 10.0:
        best = (mult, float(expires))
    fish = row["fish_boost_expires_at"]
    if fish is not None and fish > now and FISH_BOOST_MULTIPLIER >= best[0]:
        best = (FISH_BOOST_MULTIPLIER, float(fish))
    return best


async def get_outfit(guild_id: int, user_id: int) -> dict | None:
    async with _db() as db:
        async with db.execute(
            "SELECT outfit FROM avatar_outfit WHERE guild_id = ? AND user_id = ?", (guild_id, user_id)
        ) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    try:
        data = json.loads(row[0])
    except (TypeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


async def get_outfits(guild_id: int, user_ids: list[int]) -> dict[int, dict]:
    if not user_ids:
        return {}
    out: dict[int, dict] = {}
    async with _db() as db:
        async with db.execute(
            f"SELECT user_id, outfit FROM avatar_outfit WHERE guild_id = ? AND user_id IN ({','.join('?' * len(user_ids))})",
            (guild_id, *user_ids),
        ) as cur:
            for uid, raw in await cur.fetchall():
                try:
                    data = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if isinstance(data, dict):
                    out[int(uid)] = data
    return out


async def set_outfit(guild_id: int, user_id: int, outfit: dict) -> None:
    async with _db() as db:
        await db.execute(
            """
            INSERT INTO avatar_outfit (guild_id, user_id, outfit, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (guild_id, user_id) DO UPDATE SET outfit = excluded.outfit, updated_at = excluded.updated_at
            """,
            (guild_id, user_id, json.dumps(outfit, separators=(",", ":")), time.time()),
        )
        await db.commit()


async def record_fish_catch(
    guild_id: int,
    user_id: int,
    roll: Callable[[int], Any],
    duration: Callable[[Any], int],
) -> tuple[Any, int, float] | None:
    """
    Günün balığını tek işlemde kaydeder: bugün zaten tutulduysa None.
    `roll(önceki_seri)` balığı seçer, `duration(balık)` boost süresini (sn) verir;
    süre mevcut balık boost'unun üstüne eklenir. Döner: (balık, yeni_seri, boost_bitişi).
    """
    today_date = _today()
    today = today_date.isoformat()
    yesterday = (today_date - datetime.timedelta(days=1)).isoformat()
    await ensure_user(guild_id, user_id)

    async with _db() as db:
        db.row_factory = aiosqlite.Row
        await db.execute("BEGIN IMMEDIATE")
        try:
            async with db.execute(
                "SELECT last_date, streak FROM fishing WHERE guild_id = ? AND user_id = ?",
                (guild_id, user_id),
            ) as cur:
                row = await cur.fetchone()
            if row is not None and row["last_date"] == today:
                await db.commit()
                return None
            prev = int(row["streak"]) if row is not None and row["last_date"] == yesterday else 0
            fish = roll(prev)

            async with db.execute(
                "SELECT fish_boost_expires_at FROM user_xp WHERE guild_id = ? AND user_id = ?",
                (guild_id, user_id),
            ) as cur:
                current = (await cur.fetchone())["fish_boost_expires_at"]
            now = time.time()
            boost_until = max(current or now, now) + duration(fish)

            await db.execute(
                """
                INSERT INTO fishing (guild_id, user_id, last_date, streak) VALUES (?, ?, ?, ?)
                ON CONFLICT (guild_id, user_id) DO UPDATE SET last_date = excluded.last_date, streak = excluded.streak
                """,
                (guild_id, user_id, today, prev + 1),
            )
            await db.execute(
                "UPDATE user_xp SET fish_boost_expires_at = ? WHERE guild_id = ? AND user_id = ?",
                (boost_until, guild_id, user_id),
            )
            await db.commit()
            return fish, prev + 1, boost_until
        except Exception:
            await db.rollback()
            raise



async def add_world_stats(guild_id: int, user_id: int, deltas: dict[str, int]) -> None:
    """Dünya sayaçlarını artırır (balık albümü, gol, galibiyet, sezon anahtarları)."""
    if not deltas:
        return
    async with _db() as db:
        await db.executemany(
            """
            INSERT INTO world_stats (guild_id, user_id, key, value) VALUES (?, ?, ?, ?)
            ON CONFLICT (guild_id, user_id, key) DO UPDATE SET value = value + excluded.value
            """,
            [(guild_id, user_id, k, int(v)) for k, v in deltas.items()],
        )
        await db.commit()


async def get_world_stats(guild_id: int, user_id: int) -> dict[str, int]:
    async with _db() as db:
        async with db.execute(
            "SELECT key, value FROM world_stats WHERE guild_id = ? AND user_id = ?",
            (guild_id, user_id),
        ) as cur:
            return {row[0]: int(row[1]) async for row in cur}


async def world_stat_top(guild_id: int, key: str, limit: int = 10) -> list[tuple[int, int]]:
    """Bir sayaçta en yüksek üyeler: [(üye, değer)], büyükten küçüğe."""
    async with _db() as db:
        async with db.execute(
            "SELECT user_id, value FROM world_stats WHERE guild_id = ? AND key = ? AND value > 0 "
            "ORDER BY value DESC, user_id LIMIT ?",
            (guild_id, key, limit),
        ) as cur:
            return [(int(r[0]), int(r[1])) async for r in cur]


async def get_world_builds(guild_id: int) -> list[tuple[int, int, str]]:
    """Mahalledeki dolu arsalar: [(arsa, sahibi, bloklar)]."""
    async with _db() as db:
        async with db.execute(
            "SELECT plot, user_id, data FROM world_builds WHERE guild_id = ? ORDER BY plot", (guild_id,)
        ) as cur:
            return [(int(r[0]), int(r[1]), str(r[2])) async for r in cur]


async def save_world_build(guild_id: int, plot: int, user_id: int, data: str) -> bool:
    """Arsayı kaydeder. Arsa başkasınınsa ya da üyenin başka arsası varsa False."""
    async with _db() as db:
        async with db.execute(
            "SELECT plot, user_id FROM world_builds WHERE guild_id = ? AND (plot = ? OR user_id = ?)",
            (guild_id, plot, user_id),
        ) as cur:
            rows = [(int(r[0]), int(r[1])) async for r in cur]
        if any(p == plot and u != user_id for p, u in rows) or any(u == user_id and p != plot for p, u in rows):
            return False
        await db.execute(
            """
            INSERT INTO world_builds (guild_id, plot, user_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (guild_id, plot) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
            """,
            (guild_id, plot, user_id, data, time.time()),
        )
        await db.commit()
        return True


async def free_world_build(guild_id: int, user_id: int) -> None:
    """Üyenin arsasını boşaltır (bloklarıyla birlikte)."""
    async with _db() as db:
        await db.execute("DELETE FROM world_builds WHERE guild_id = ? AND user_id = ?", (guild_id, user_id))
        await db.commit()


async def get_world_quests(guild_id: int, user_id: int, day: str) -> dict[str, tuple[int, bool]]:
    """{görev: (ilerleme, tamamlandı)} — o günün kayıtlı görev ilerlemesi."""
    async with _db() as db:
        async with db.execute(
            "SELECT key, progress, done FROM world_quests WHERE guild_id = ? AND user_id = ? AND day = ?",
            (guild_id, user_id, day),
        ) as cur:
            return {r[0]: (int(r[1]), bool(r[2])) async for r in cur}


async def advance_world_quests(
    guild_id: int, user_id: int, day: str, quests: list[tuple[str, int]], amounts: dict[str, int],
) -> list[str]:
    """
    Günün görevlerini (anahtar, hedef) tek işlemde ilerletir; `amounts` görev başına artış.
    Bu çağrıda tamamlanan görevlerin anahtarlarını döner (her görev bir kez tamamlanır).
    """
    completed: list[str] = []
    async with _db() as db:
        await db.execute("BEGIN IMMEDIATE")
        try:
            for key, target in quests:
                add = int(amounts.get(key, 0))
                if add <= 0:
                    continue
                async with db.execute(
                    "SELECT progress, done FROM world_quests WHERE guild_id = ? AND user_id = ? AND day = ? AND key = ?",
                    (guild_id, user_id, day, key),
                ) as cur:
                    row = await cur.fetchone()
                progress, done = (int(row[0]), bool(row[1])) if row else (0, False)
                if done:
                    continue
                progress = min(target, progress + add)
                done = progress >= target
                await db.execute(
                    """
                    INSERT INTO world_quests (guild_id, user_id, day, key, progress, done) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (guild_id, user_id, day, key) DO UPDATE SET progress = excluded.progress, done = excluded.done
                    """,
                    (guild_id, user_id, day, key, progress, int(done)),
                )
                if done:
                    completed.append(key)
            await db.commit()
        except Exception:
            await db.rollback()
            raise
    return completed


async def fish_caught_today(guild_id: int, user_id: int) -> bool:
    async with _db() as db:
        async with db.execute(
            "SELECT 1 FROM fishing WHERE guild_id = ? AND user_id = ? AND last_date = ?",
            (guild_id, user_id, _today().isoformat()),
        ) as cur:
            return await cur.fetchone() is not None


# ---------------------------------------------------------------------------
# Streak
# ---------------------------------------------------------------------------

def current_streak(row: aiosqlite.Row) -> int:
    """Gösterim için seri: son mesaj bugün ya da dün değilse seri bozulmuştur."""
    today = _today()
    if row["last_message_date"] in (today.isoformat(), (today - datetime.timedelta(days=1)).isoformat()):
        return int(row["streak_days"])
    return 0


async def update_streak(guild_id: int, user_id: int) -> tuple[int, bool]:
    """
    Günlük streak'i günceller.
    Döner: (yeni_streak, bugün_ilk_mesaj_mı)
    """
    today_date = _today()
    today = today_date.isoformat()
    yesterday = (today_date - datetime.timedelta(days=1)).isoformat()

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
# Sürgün
# ---------------------------------------------------------------------------
#
# Sürgündeki üye sabit bir düşük çarpanla XP kazanır (bkz. xp.py). Bu sürede
# seri dondurulur: update_streak çağrılmaz, ceza bitince end_exile seriyi
# kaldığı yerden devam edecek şekilde geri yükler.

def exile_expired(row: aiosqlite.Row, now: float | None = None) -> bool:
    return row["ends_at"] is not None and row["ends_at"] <= (now if now is not None else time.time())


async def set_exile(
    guild_id: int,
    user_id: int,
    *,
    ends_at: float | None,
    reason: str,
    moderator_id: int,
    channel_id: int | None,
) -> bool:
    """
    Üyeyi sürgüne gönderir. Zaten sürgündeyse yalnızca süre, sebep ve yetkili
    güncellenir (başlangıç ve dondurulan seri korunur). Döner: yeni sürgün mü.
    """
    if await get_exile(guild_id, user_id) is not None:
        async with _db() as db:
            await db.execute(
                """
                UPDATE exiles SET ends_at = ?, reason = ?, moderator_id = ?, channel_id = ?
                WHERE guild_id = ? AND user_id = ?
                """,
                (ends_at, reason, moderator_id, channel_id, guild_id, user_id),
            )
            await db.commit()
        return False

    row = await get_user_row(guild_id, user_id)
    streak = current_streak(row) if row else 0
    async with _db() as db:
        await db.execute(
            """
            INSERT INTO exiles
                (guild_id, user_id, started_at, ends_at, reason, moderator_id, channel_id, streak_at_start)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, user_id, time.time(), ends_at, reason, moderator_id, channel_id, streak),
        )
        await db.commit()
    return True


async def get_exile(guild_id: int, user_id: int) -> aiosqlite.Row | None:
    """Sürgün kaydı (süresi dolmuş ama henüz kapatılmamış olabilir; bkz. exile_expired)."""
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM exiles WHERE guild_id = ? AND user_id = ?", (guild_id, user_id),
        ) as cur:
            return await cur.fetchone()


async def list_exiles(guild_id: int) -> list[aiosqlite.Row]:
    """Sunucudaki süresi dolmamış sürgünler: önce kalıcılar, sonra en geç bitenden en erkene."""
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT * FROM exiles
            WHERE guild_id = ? AND (ends_at IS NULL OR ends_at > ?)
            ORDER BY ends_at IS NOT NULL, ends_at DESC, started_at
            """,
            (guild_id, time.time()),
        ) as cur:
            return list(await cur.fetchall())


async def list_expired_exiles() -> list[aiosqlite.Row]:
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM exiles WHERE ends_at IS NOT NULL AND ends_at <= ?", (time.time(),),
        ) as cur:
            return list(await cur.fetchall())


async def end_exile(guild_id: int, user_id: int) -> aiosqlite.Row | None:
    """
    Sürgünü bitirir ve donan seriyi geri yükler. Döner: silinen kayıt (yoksa None).

    Seri sürgün başında canlıysa son mesaj tarihi en az "dün" yapılır; böylece
    üyenin ilk mesajı seriyi kaldığı yerden sürdürür (aynı gün bittiyse bugün
    zaten sayılmıştır, ikinci kez artmaz).
    """
    yesterday = (_today() - datetime.timedelta(days=1)).isoformat()
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        await db.execute("BEGIN IMMEDIATE")
        try:
            async with db.execute(
                "SELECT * FROM exiles WHERE guild_id = ? AND user_id = ?", (guild_id, user_id),
            ) as cur:
                row = await cur.fetchone()
            if row is None:
                await db.commit()
                return None
            await db.execute("DELETE FROM exiles WHERE guild_id = ? AND user_id = ?", (guild_id, user_id))
            if row["streak_at_start"] > 0:
                await db.execute(
                    """
                    UPDATE user_xp
                    SET streak_days = ?,
                        last_message_date = MAX(COALESCE(last_message_date, ''), ?)
                    WHERE guild_id = ? AND user_id = ?
                    """,
                    (row["streak_at_start"], yesterday, guild_id, user_id),
                )
            await db.commit()
            return row
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
            ORDER BY total_xp DESC, voice_xp DESC, text_xp DESC, user_id ASC
            LIMIT ?
            """,
            (guild_id, limit),
        ) as cur:
            return await cur.fetchall()


# ---------------------------------------------------------------------------
# Olay kaydı (activity_log)
# ---------------------------------------------------------------------------

async def insert_activity_rows(rows: list[tuple[Any, ...]]) -> None:
    async with _db() as db:
        await db.executemany(
            """
            INSERT INTO activity_log
                (ts, guild_id, user_id, event, channel_id, amount, actor_id, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        await db.commit()


async def delete_activity_before(cutoff_ts: float) -> int:
    async with _db() as db:
        cur = await db.execute("DELETE FROM activity_log WHERE ts < ?", (cutoff_ts,))
        await db.commit()
        return cur.rowcount or 0


async def get_user_events(
    guild_id: int,
    user_id: int,
    since_ts: float,
    events: tuple[str, ...] | None = None,
    limit: int | None = None,
    newest_first: bool = False,
) -> list[aiosqlite.Row]:
    sql = "SELECT * FROM activity_log WHERE guild_id = ? AND user_id = ? AND ts >= ?"
    params: list[Any] = [guild_id, user_id, since_ts]
    if events:
        sql += f" AND event IN ({','.join('?' * len(events))})"
        params.extend(events)
    sql += " ORDER BY ts DESC" if newest_first else " ORDER BY ts ASC"
    if limit:
        sql += " LIMIT ?"
        params.append(limit)
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            return await cur.fetchall()


async def get_guild_events(
    guild_id: int,
    since_ts: float,
    events: tuple[str, ...],
) -> list[aiosqlite.Row]:
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"""
            SELECT * FROM activity_log
            WHERE guild_id = ? AND ts >= ? AND event IN ({','.join('?' * len(events))})
            ORDER BY ts ASC
            """,
            (guild_id, since_ts, *events),
        ) as cur:
            return await cur.fetchall()


async def get_guild_events_between(
    guild_id: int,
    start_ts: float,
    end_ts: float,
    events: tuple[str, ...],
) -> list[aiosqlite.Row]:
    """[start_ts, end_ts) aralığındaki olaylar (haftalık/aylık özetler için)."""
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"""
            SELECT ts, user_id, event, channel_id, amount, meta FROM activity_log
            WHERE guild_id = ? AND ts >= ? AND ts < ? AND event IN ({','.join('?' * len(events))})
            ORDER BY ts ASC
            """,
            (guild_id, start_ts, end_ts, *events),
        ) as cur:
            return await cur.fetchall()


# ---------------------------------------------------------------------------
# Başarımlar
# ---------------------------------------------------------------------------

async def get_activity_after(last_id: int, limit: int = 5000) -> list[aiosqlite.Row]:
    """Başarım işleyicisi için: id'si last_id'den büyük olay satırları (artan sırada)."""
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, ts, guild_id, user_id, event, channel_id, amount, meta FROM activity_log "
            "WHERE id > ? ORDER BY id ASC LIMIT ?",
            (last_id, limit),
        ) as cur:
            return await cur.fetchall()


async def get_achievement_cursor() -> int:
    async with _db() as db:
        async with db.execute("SELECT last_id FROM achievement_state WHERE id = 1") as cur:
            row = await cur.fetchone()
    return int(row[0]) if row else 0


async def set_achievement_cursor(last_id: int) -> None:
    async with _db() as db:
        await db.execute(
            "INSERT INTO achievement_state (id, last_id) VALUES (1, ?) "
            "ON CONFLICT (id) DO UPDATE SET last_id = excluded.last_id",
            (last_id,),
        )
        await db.commit()


async def add_achievement_counters(
    rows: list[tuple[int, int, str, float]], *, assign: bool = False, mode: str = "add",
) -> None:
    """
    (guild, user, key, değer) satırlarını sayaçlara yazar.
    mode: add (ekle) · assign (üzerine yaz; kümeler için) · max (büyük olan kalır).
    """
    if not rows:
        return
    mode = "assign" if assign else mode
    op = {
        "add": "achievement_counters.value + excluded.value",
        "assign": "excluded.value",
        "max": "MAX(achievement_counters.value, excluded.value)",
    }[mode]
    async with _db() as db:
        await db.executemany(
            "INSERT INTO achievement_counters (guild_id, user_id, key, value) VALUES (?, ?, ?, ?) "
            f"ON CONFLICT (guild_id, user_id, key) DO UPDATE SET value = {op}",
            rows,
        )
        await db.commit()


async def get_achievement_counters(guild_id: int) -> dict[int, dict[str, float]]:
    out: dict[int, dict[str, float]] = {}
    async with _db() as db:
        async with db.execute(
            "SELECT user_id, key, value FROM achievement_counters WHERE guild_id = ?", (guild_id,),
        ) as cur:
            async for user_id, key, value in cur:
                out.setdefault(user_id, {})[key] = value
    return out


async def get_counter_values(key: str) -> dict[tuple[int, int], float]:
    """Tüm sunucularda bir sayacın sıfırdan farklı değerleri: (guild, user) → değer."""
    async with _db() as db:
        async with db.execute(
            "SELECT guild_id, user_id, value FROM achievement_counters WHERE key = ? AND value != 0", (key,),
        ) as cur:
            return {(g, u): v for g, u, v in await cur.fetchall()}


async def claim_day(guild_id: int, key: str) -> bool:
    """Sunucu genelinde bir kez olabilecek olayı (ör. günün ilk mesajı) kapar. Döner: ilk kapan mı."""
    async with _db() as db:
        cur = await db.execute(
            "INSERT OR IGNORE INTO achievement_counters (guild_id, user_id, key, value) VALUES (?, 0, ?, 1)",
            (guild_id, key),
        )
        await db.commit()
        return cur.rowcount > 0


async def prune_duo_counters(keep_weeks: set[str]) -> None:
    """Haftalık ikili sayaçlarından ("duo:<hafta>:<üye>") yalnızca verilen haftalar kalır."""
    weeks = sorted(keep_weeks)
    async with _db() as db:
        await db.execute(
            f"DELETE FROM achievement_counters WHERE key LIKE 'duo:%' "
            f"AND substr(key, 5, 8) NOT IN ({','.join('?' * len(weeks))})",
            weeks,
        )
        await db.commit()


async def get_achievements(guild_id: int, user_id: int | None = None) -> dict[int, dict[str, tuple[int, float]]]:
    """Kullanıcı → {başarım: (kademe, açılma zamanı)}."""
    sql = "SELECT user_id, key, tier, unlocked_at FROM achievements WHERE guild_id = ?"
    params: list[Any] = [guild_id]
    if user_id is not None:
        sql += " AND user_id = ?"
        params.append(user_id)
    out: dict[int, dict[str, tuple[int, float]]] = {}
    async with _db() as db:
        async with db.execute(sql, params) as cur:
            async for uid, key, tier, unlocked_at in cur:
                out.setdefault(uid, {})[key] = (tier, unlocked_at)
    return out


async def set_achievement(guild_id: int, user_id: int, key: str, tier: int) -> None:
    async with _db() as db:
        await db.execute(
            "INSERT INTO achievements (guild_id, user_id, key, tier, unlocked_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (guild_id, user_id, key) DO UPDATE SET tier = excluded.tier, unlocked_at = excluded.unlocked_at",
            (guild_id, user_id, key, tier, time.time()),
        )
        await db.commit()


async def delete_achievement(guild_id: int, user_id: int, key: str) -> bool:
    async with _db() as db:
        cur = await db.execute(
            "DELETE FROM achievements WHERE guild_id = ? AND user_id = ? AND key = ?", (guild_id, user_id, key),
        )
        await db.commit()
        return cur.rowcount > 0


async def get_card_badges(guild_id: int, user_id: int) -> list[str]:
    async with _db() as db:
        async with db.execute(
            "SELECT keys FROM card_badges WHERE guild_id = ? AND user_id = ?", (guild_id, user_id),
        ) as cur:
            row = await cur.fetchone()
    return [k for k in (row[0].split(",") if row and row[0] else []) if k]


async def set_card_badges(guild_id: int, user_id: int, keys: list[str]) -> None:
    async with _db() as db:
        await db.execute(
            "INSERT INTO card_badges (guild_id, user_id, keys) VALUES (?, ?, ?) "
            "ON CONFLICT (guild_id, user_id) DO UPDATE SET keys = excluded.keys",
            (guild_id, user_id, ",".join(keys)),
        )
        await db.commit()


async def add_summary_awards(guild_id: int, period: str, awards: dict[str, list[int]]) -> None:
    rows = [(guild_id, period, award, uid) for award, uids in awards.items() for uid in uids]
    if not rows:
        return
    async with _db() as db:
        await db.executemany(
            "INSERT OR IGNORE INTO summary_awards (guild_id, period, award, user_id) VALUES (?, ?, ?, ?)", rows,
        )
        await db.commit()


async def count_summary_awards(guild_id: int) -> dict[int, dict[str, int]]:
    out: dict[int, dict[str, int]] = {}
    async with _db() as db:
        async with db.execute(
            "SELECT user_id, award, COUNT(*) FROM summary_awards WHERE guild_id = ? GROUP BY user_id, award",
            (guild_id,),
        ) as cur:
            async for uid, award, count in cur:
                out.setdefault(uid, {})[award] = count
    return out


async def get_active_days(guild_id: int, since_ts: float, events: tuple[str, ...]) -> dict[int, list[str]]:
    """Kullanıcı → aktif olduğu günler (Türkiye saati, artan sırada)."""
    offset = int(STREAK_TZ.utcoffset(None).total_seconds())
    out: dict[int, list[str]] = {}
    async with _db() as db:
        async with db.execute(
            f"""
            SELECT DISTINCT user_id, date(ts + ?, 'unixepoch') AS day FROM activity_log
            WHERE guild_id = ? AND ts >= ? AND user_id IS NOT NULL
              AND event IN ({','.join('?' * len(events))})
            ORDER BY user_id, day
            """,
            (offset, guild_id, since_ts, *events),
        ) as cur:
            async for uid, day in cur:
                out.setdefault(uid, []).append(day)
    return out


async def get_all_pair_seconds(guild_id: int) -> list[tuple[int, int, int]]:
    async with _db() as db:
        async with db.execute(
            "SELECT user_low_id, user_high_id, shared_seconds FROM voice_pair_stats WHERE guild_id = ?",
            (guild_id,),
        ) as cur:
            return [tuple(r) for r in await cur.fetchall()]


async def get_all_user_rows(guild_id: int) -> list[aiosqlite.Row]:
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM user_xp WHERE guild_id = ?", (guild_id,)) as cur:
            return await cur.fetchall()


async def get_all_pairs(guild_id: int) -> list[aiosqlite.Row]:
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM voice_pair_stats WHERE guild_id = ?", (guild_id,)) as cur:
            return await cur.fetchall()


async def get_admin_events(guild_id: int, since_ts: float, limit: int = 25) -> list[aiosqlite.Row]:
    async with _db() as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT * FROM activity_log
            WHERE guild_id = ? AND ts >= ? AND event LIKE 'admin_%'
            ORDER BY ts DESC
            LIMIT ?
            """,
            (guild_id, since_ts, limit),
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
        log.error("Yedek alınamadı: %s", err)
        return None
