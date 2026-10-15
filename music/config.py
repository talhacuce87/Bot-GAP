"""
music/config.py — Müzik modülünün ortam değişkeni yapılandırması.

Tüm değerler başlangıçta bir kez okunur; hatalı bir .env değeri botu
düşürmesin diye sınırlar burada kırpılır.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("gap.music.config")

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Sağlık kontrolü için yıllardır yerinde duran, kısa bir video ("Me at the zoo").
DEFAULT_HEALTHCHECK_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"


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


def _str(name: str, default: str = "") -> str:
    return (os.getenv(name) or "").strip() or default


@dataclass(frozen=True)
class MusicConfig:
    enabled: bool = True
    # Boşta (kuyruk boş) bu kadar saniye kalınca kanaldan çıkılır
    idle_timeout: int = 300
    # Kanalda bottan başka kimse kalmayınca bu kadar saniye sonra çıkılır
    alone_timeout: int = 60
    max_queue: int = 200
    max_playlist: int = 100
    # Bundan uzun parçalar (saniye) kuyruğa alınmaz
    max_track_seconds: int = 3 * 3600
    default_volume: int = 50
    # yt-dlp / yt-dlp-ejs / deno'yu kendi kendine güncelle (açılışta + günlük + hata anında)
    auto_update: bool = True
    healthcheck_url: str = DEFAULT_HEALTHCHECK_URL
    healthcheck_hours: int = 6
    # YouTube sunucu IP'sini engellerse: Netscape formatında çerez dosyası (yedek bir hesaptan)
    cookies_file: str = ""
    spotify_client_id: str = ""
    spotify_client_secret: str = field(default="", repr=False)
    state_path: Path = PROJECT_ROOT / "data" / "music_state.json"


def load_config() -> MusicConfig:
    cookies = _str("YTDLP_COOKIES_FILE")
    if cookies and not Path(cookies).is_file():
        log.warning("YTDLP_COOKIES_FILE bulunamadı, çerezsiz devam ediliyor: %s", cookies)
        cookies = ""
    return MusicConfig(
        enabled=_bool("MUSIC_ENABLED", True),
        idle_timeout=_int("MUSIC_IDLE_TIMEOUT_SECONDS", 300, 30, 3600),
        alone_timeout=_int("MUSIC_ALONE_TIMEOUT_SECONDS", 60, 10, 3600),
        max_queue=_int("MUSIC_MAX_QUEUE", 200, 10, 1000),
        max_playlist=_int("MUSIC_MAX_PLAYLIST", 100, 1, 500),
        max_track_seconds=_int("MUSIC_MAX_TRACK_MINUTES", 180, 5, 24 * 60) * 60,
        default_volume=_int("MUSIC_DEFAULT_VOLUME", 50, 1, 100),
        auto_update=_bool("MUSIC_AUTO_UPDATE", True),
        healthcheck_url=_str("MUSIC_HEALTHCHECK_URL", DEFAULT_HEALTHCHECK_URL),
        healthcheck_hours=_int("MUSIC_HEALTHCHECK_HOURS", 6, 1, 168),
        cookies_file=cookies,
        spotify_client_id=_str("SPOTIFY_CLIENT_ID"),
        spotify_client_secret=_str("SPOTIFY_CLIENT_SECRET"),
    )
