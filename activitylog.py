"""
activitylog.py — Loglama altyapısı ve olay (event) kaydı.

İki katman:
  1. Uygulama logları (Python logging): stdout + data/logs/bot.log
     (günlük döner, LOG_FILE_RETENTION_DAYS gün saklanır). Container
     yeniden kurulsa bile data/ volume'ü sayesinde kaybolmaz.
  2. Olay kaydı (activity_log tablosu): XP kazanımı, mesaj metadatası,
     ses giriş/çıkış/mute, admin işlemleri, rol değişimleri, komutlar ve
     şüpheli hareket bayrakları. Geçmişe dönük analiz bu tablodan yapılır.

Gizlilik: Mesaj içeriği saklanmaz; yalnızca uzunluğu ve normalize edilmiş
içeriğin kısa hash'i tutulur (kopyala-yapıştır spam tespiti için yeterli).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import time
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import Any

import database as db

LOG_DIR = Path(__file__).resolve().parent / "data" / "logs"
LOG_FILE_RETENTION_DAYS = int(os.getenv("LOG_FILE_RETENTION_DAYS", "90"))
EVENT_RETENTION_DAYS = int(os.getenv("EVENT_RETENTION_DAYS", "365"))

FLUSH_INTERVAL_SECONDS = 2.0
FLUSH_BATCH_SIZE = 200

log = logging.getLogger("gap.events")

_buffer: list[tuple[Any, ...]] = []
_flush_task: asyncio.Task | None = None
_flush_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Uygulama logları
# ---------------------------------------------------------------------------

def setup_logging() -> None:
    """Root logger'ı stdout + dönen dosyaya yönlendirir. bot.run(log_handler=None) ile kullan."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter(
        "%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)

    file_handler = TimedRotatingFileHandler(
        LOG_DIR / "bot.log",
        when="midnight",
        backupCount=LOG_FILE_RETENTION_DAYS,
        encoding="utf-8",
        utc=True,
    )
    file_handler.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers.clear()
    root.addHandler(stream)
    root.addHandler(file_handler)

    # discord.http her isteği DEBUG'da yazar; INFO yeterli.
    logging.getLogger("discord").setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Yardımcılar
# ---------------------------------------------------------------------------

_WS_RE = re.compile(r"\s+")


def content_hash(text: str) -> str | None:
    """Mesaj içeriğinin normalize edilmiş kısa hash'i. Boş mesajda None."""
    normalized = _WS_RE.sub(" ", text.casefold()).strip()
    if not normalized:
        return None
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Olay kaydı
# ---------------------------------------------------------------------------

def record(
    event: str,
    guild_id: int | None,
    user_id: int | None = None,
    *,
    channel_id: int | None = None,
    amount: int | None = None,
    actor_id: int | None = None,
    **meta: Any,
) -> None:
    """
    Olayı tampona ekler; arka plan görevi topluca DB'ye yazar.
    Senkron ve hızlıdır, event handler'ları bloklamaz.
    """
    _buffer.append((
        time.time(),
        guild_id,
        user_id,
        event,
        channel_id,
        amount,
        actor_id,
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")) if meta else None,
    ))
    if len(_buffer) >= FLUSH_BATCH_SIZE:
        _ensure_flush_task()


async def flush() -> None:
    async with _flush_lock:
        if not _buffer:
            return
        rows = _buffer[:]
        del _buffer[: len(rows)]
        try:
            await db.insert_activity_rows(rows)
        except Exception:
            log.exception("Olay kaydı yazılamadı (%d satır), tampona geri alındı", len(rows))
            _buffer[:0] = rows


async def _flush_loop() -> None:
    while True:
        await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
        await flush()


def _ensure_flush_task() -> None:
    global _flush_task
    if _flush_task is None or _flush_task.done():
        try:
            _flush_task = asyncio.get_running_loop().create_task(_flush_loop())
        except RuntimeError:
            pass


def start() -> None:
    _ensure_flush_task()


async def stop() -> None:
    global _flush_task
    if _flush_task is not None:
        _flush_task.cancel()
        _flush_task = None
    await flush()


async def prune_old_events() -> int:
    cutoff = time.time() - EVENT_RETENTION_DAYS * 86400
    deleted = await db.delete_activity_before(cutoff)
    if deleted:
        log.info("%d eski olay kaydı silindi (> %d gün)", deleted, EVENT_RETENTION_DAYS)
    return deleted
