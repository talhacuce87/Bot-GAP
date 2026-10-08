"""
ai/config.py — AI alt sisteminin ortam değişkeni yapılandırması.

Tüm değerler başlangıçta bir kez okunur. Sınırlar burada kırpılır ki
hatalı bir .env değeri botu düşürmesin.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("gap.ai.config")

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "evet"}


def _int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.getenv(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        log.warning("%s geçersiz (%r), varsayılan kullanılıyor: %s", name, raw, default)
        value = default
    return max(lo, min(hi, value))


def _float(name: str, default: float, lo: float, hi: float) -> float:
    raw = os.getenv(name, "").strip()
    try:
        value = float(raw) if raw else default
    except ValueError:
        log.warning("%s geçersiz (%r), varsayılan kullanılıyor: %s", name, raw, default)
        value = default
    return max(lo, min(hi, value))


def _str(name: str, default: str) -> str:
    return (os.getenv(name) or "").strip() or default


@dataclass(frozen=True)
class AIConfig:
    enabled: bool = False
    api_key: str = field(default="", repr=False)
    model: str = "google/gemma-4-31b-it:free"
    fallback_model: str = ""
    allow_paid_models: bool = False
    enforce_zero_price: bool = True
    api_base: str = "https://openrouter.ai/api/v1"
    app_url: str = "https://github.com/talhacuce87/Bot-GAP"
    app_title: str = "Bot-GAP"

    max_output_tokens: int = 350
    context_token_budget: int = 3000
    max_concurrent_requests: int = 1
    max_queue_size: int = 4
    request_timeout_seconds: float = 45.0
    total_deadline_seconds: float = 90.0
    max_retries: int = 2
    max_retry_wait_seconds: float = 30.0
    reasoning_effort: str = "none"
    temperature: float = 0.8

    response_mode: str = "mention"  # mention | command
    max_input_chars: int = 1500

    memory_enabled: bool = True
    indexing_default: bool = False
    message_retention_days: int = 30
    candidate_retention_days: int = 14
    max_message_chars: int = 2000

    daily_request_budget: int = 35
    user_daily_request_limit: int = 10
    channel_cooldown_seconds: int = 15
    user_cooldown_seconds: int = 30

    recent_context_messages: int = 25
    search_results: int = 10
    final_passages: int = 5
    neighbor_messages: int = 2
    neighbor_window_seconds: int = 900
    memory_context_limit: int = 8

    slash_sync: bool = False
    db_path: Path = PROJECT_ROOT / "data" / "ai_memory.db"
    backup_dir: Path = PROJECT_ROOT / "data" / "backups"
    backup_keep: int = 7
    persona_dir: Path = PROJECT_ROOT / "persona"

    @property
    def has_api_key(self) -> bool:
        return bool(self.api_key)


def load_config() -> AIConfig:
    mode = _str("AI_RESPONSE_MODE", "mention").lower()
    if mode not in {"mention", "command"}:
        log.warning("AI_RESPONSE_MODE=%r desteklenmiyor, 'mention' kullanılıyor", mode)
        mode = "mention"
    return AIConfig(
        enabled=_bool("AI_ENABLED", False),
        api_key=(os.getenv("OPENROUTER_API_KEY") or "").strip(),
        model=_str("OPENROUTER_MODEL", "google/gemma-4-31b-it:free"),
        fallback_model=(os.getenv("OPENROUTER_FALLBACK_MODEL") or "").strip(),
        allow_paid_models=_bool("AI_ALLOW_PAID_MODELS", False),
        enforce_zero_price=_bool("AI_ENFORCE_ZERO_PRICE", True),
        api_base=_str("OPENROUTER_API_BASE", "https://openrouter.ai/api/v1").rstrip("/"),
        max_output_tokens=_int("AI_MAX_OUTPUT_TOKENS", 350, 32, 4000),
        context_token_budget=_int("AI_CONTEXT_TOKEN_BUDGET", 3000, 500, 100_000),
        max_concurrent_requests=_int("AI_MAX_CONCURRENT_REQUESTS", 1, 1, 8),
        max_queue_size=_int("AI_MAX_QUEUE_SIZE", 4, 0, 50),
        request_timeout_seconds=_float("AI_REQUEST_TIMEOUT_SECONDS", 45.0, 5.0, 180.0),
        total_deadline_seconds=_float("AI_TOTAL_DEADLINE_SECONDS", 90.0, 10.0, 300.0),
        max_retries=_int("AI_MAX_RETRIES", 2, 0, 5),
        max_retry_wait_seconds=_float("AI_MAX_RETRY_WAIT_SECONDS", 30.0, 1.0, 120.0),
        reasoning_effort=(os.getenv("AI_REASONING_EFFORT", "none") or "").strip().lower(),
        temperature=_float("AI_TEMPERATURE", 0.8, 0.0, 2.0),
        response_mode=mode,
        max_input_chars=_int("AI_MAX_INPUT_CHARS", 1500, 100, 4000),
        memory_enabled=_bool("AI_MEMORY_ENABLED", True),
        indexing_default=_bool("AI_INDEXING_DEFAULT", False),
        message_retention_days=_int("AI_MESSAGE_RETENTION_DAYS", 30, 1, 3650),
        candidate_retention_days=_int("AI_CANDIDATE_RETENTION_DAYS", 14, 1, 365),
        daily_request_budget=_int("AI_DAILY_REQUEST_BUDGET", 35, 0, 100_000),
        user_daily_request_limit=_int("AI_USER_DAILY_REQUEST_LIMIT", 10, 1, 100_000),
        channel_cooldown_seconds=_int("AI_CHANNEL_COOLDOWN_SECONDS", 15, 0, 3600),
        user_cooldown_seconds=_int("AI_USER_COOLDOWN_SECONDS", 30, 0, 3600),
        recent_context_messages=_int("AI_RECENT_CONTEXT_MESSAGES", 25, 0, 100),
        search_results=_int("AI_SEARCH_RESULTS", 10, 1, 50),
        final_passages=_int("AI_FINAL_PASSAGES", 5, 1, 20),
        neighbor_messages=_int("AI_NEIGHBOR_MESSAGES", 2, 0, 10),
        memory_context_limit=_int("AI_MEMORY_CONTEXT_LIMIT", 8, 0, 50),
        slash_sync=_bool("AI_SLASH_SYNC", False),
        **_paths(),
    )


def _paths() -> dict[str, Path]:
    out: dict[str, Path] = {}
    if raw := (os.getenv("AI_DB_PATH") or "").strip():
        out["db_path"] = Path(raw)
    if raw := (os.getenv("AI_PERSONA_DIR") or "").strip():
        out["persona_dir"] = Path(raw)
    return out
