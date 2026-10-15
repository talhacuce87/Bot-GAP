"""
music/ytdl.py — yt-dlp'yi ayrı bir süreç olarak çalıştırır.

yt-dlp bot sürecine import edilmez; her çağrı `python -m yt_dlp` ile ayrı
süreçte çalışır. Böylece updater.py yt-dlp'yi pip ile güncellediğinde yeni
sürüm, bot yeniden başlatılmadan bir sonraki çağrıda devreye girer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import shutil
import sys
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("gap.music.ytdl")

DEFAULT_TIMEOUT = 60

# Ağ ayarları: updater.py YouTube engelini aşan yöntemi (strategy) seçer, proxy .env'den gelir.
_strategy_args: list[str] = []
_proxy = ""


def configure_network(*, strategy_args: list[str] | None = None, proxy: str | None = None) -> None:
    global _strategy_args, _proxy
    if strategy_args is not None:
        _strategy_args = list(strategy_args)
    if proxy is not None:
        _proxy = proxy.strip()


def ffmpeg_input_options(user_agent: str | None = None) -> str:
    """
    Akışı açarken FFmpeg'e verilecek girdi seçenekleri.

    - YouTube ses linkini, linki alan istemcinin User-Agent'ına bağlar; FFmpeg kendi
      varsayılanıyla ("Lavf/…") isterse 403 alır. Bu yüzden yt-dlp'nin User-Agent'ı verilir.
    - Link onu isteyen IP'ye de bağlı olduğu için yt-dlp proxy kullanıyorsa FFmpeg de aynı
      proxy'den çekmeli (FFmpeg yalnızca HTTP proxy destekler).
    """
    opts = ""
    if user_agent:
        opts += f" -user_agent {shlex.quote(user_agent)}"
    if _proxy.lower().startswith(("http://", "https://")):
        opts += f" -http_proxy {shlex.quote(_proxy)}"
    return opts


class YtdlError(Exception):
    """yt-dlp hatası. kind: blocked | unavailable | age | live | timeout | stream | error"""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass
class Track:
    title: str
    requester_id: int
    # Çalınacak sayfa (YouTube/SoundCloud). Spotify parçalarında None; query'den aranır.
    url: str | None = None
    query: str | None = None
    artist: str | None = None
    duration: int | None = None
    thumbnail: str | None = None
    source: str = "youtube"  # youtube | spotify | soundcloud | search
    # Çözülmüş ses akışı (YouTube linkleri birkaç saat geçerli)
    stream_url: str | None = None
    stream_expires: float = 0.0
    # Akışı FFmpeg ile açarken gönderilecek User-Agent (YouTube linki buna bağlı)
    user_agent: str | None = None
    # YouTube çalışmadığı için başka kaynaktan çalındıysa (örn. "soundcloud")
    fallback: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def display(self) -> str:
        if self.artist and self.artist.lower() not in self.title.lower():
            return f"{self.artist} — {self.title}"
        return self.title


def format_time(seconds: float | int | None) -> str:
    if seconds is None:
        return "?"
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def deno_path() -> str | None:
    """pip ile kurulan deno'yu bulur; yoksa PATH'teki deno (yt-dlp kendisi de arar)."""
    try:
        import deno

        return deno.find_deno_bin()
    except Exception:
        return shutil.which("deno")


def ffmpeg_path() -> str:
    """Sistemdeki ffmpeg; yoksa imageio-ffmpeg'in getirdiği hazır ffmpeg."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def classify_error(stderr: str) -> str:
    text = stderr.lower()
    # "Sign in to confirm your age" de "sign in to confirm" içerir; önce yaş kontrolü
    if "confirm your age" in text or "age-restricted" in text or "inappropriate for some users" in text:
        return "age"
    if any(s in text for s in (
        "sign in to confirm", "not a bot", "http error 429", "too many requests",
        "rate-limit", "rate limit", "try again later",
    )):
        return "blocked"
    # YouTube tarafındaki değişikliklerden kaynaklanan, güncellemeyle düzelen hatalar
    if "requested format" in text or "signature" in text or "nsig" in text or "challenge" in text:
        return "error"
    if "is live" in text or "live event" in text or "premieres in" in text:
        return "live"
    if any(s in text for s in (
        "unavailable", "private video", "has been removed", "is not available",
        "does not exist", "no video results", "unable to find", "404",
    )):
        return "unavailable"
    return "error"


def build_command(
    args: list[str], target: str, cookies_file: str = "", strategy_args: list[str] | None = None,
) -> list[str]:
    cmd = [sys.executable, "-m", "yt_dlp", "-J", "--no-warnings", "--ignore-config", "--no-progress"]
    if cookies_file:
        cmd += ["--cookies", cookies_file]
    if _proxy:
        cmd += ["--proxy", _proxy]
    cmd += _strategy_args if strategy_args is None else strategy_args
    # "--" sonrası hiçbir zaman seçenek olarak yorumlanmaz (kullanıcı girdisi buraya gelir)
    return cmd + list(args) + ["--", target]


def subprocess_env() -> dict[str, str]:
    """
    yt-dlp YouTube için JS çalıştırıcısı (deno) ister ve onu PATH'te arar. pip ile
    kurulan deno'nun klasörünü PATH'in başına ekleriz; böylece yt-dlp'nin komut
    satırı seçeneklerine bağımlı kalmayız (seçenek adı değişse de çalışmaya devam eder).
    """
    env = dict(os.environ)
    deno = deno_path()
    if deno:
        env["PATH"] = os.pathsep.join([os.path.dirname(deno), env.get("PATH", "")])
    return env


async def run_json(
    args: list[str], target: str, *, cookies_file: str = "", timeout: int = DEFAULT_TIMEOUT,
    strategy_args: list[str] | None = None,
) -> dict:
    cmd = build_command(args, target, cookies_file, strategy_args)
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=subprocess_env(),
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise YtdlError("timeout", f"yt-dlp {timeout} sn içinde cevap vermedi")

    err = stderr.decode("utf-8", "replace")
    if proc.returncode != 0 or not stdout.strip():
        kind = classify_error(err)
        last = err.strip().splitlines()[-1] if err.strip() else f"çıkış kodu {proc.returncode}"
        log.info("yt-dlp hatası (%s) %s: %s", kind, target[:120], last[:300])
        raise YtdlError(kind, last[:300])
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise YtdlError("error", f"yt-dlp çıktısı okunamadı: {exc}") from exc


# ---------------------------------------------------------------------------
# Yüksek seviye işlemler
# ---------------------------------------------------------------------------

AUDIO_FORMAT = "bestaudio[acodec=opus]/bestaudio/best"


def _entry_to_track(entry: dict, requester_id: int, source: str) -> Track:
    url = entry.get("webpage_url") or entry.get("url")
    if url and source == "youtube" and not url.startswith("http"):
        url = f"https://www.youtube.com/watch?v={url}"
    thumbs = entry.get("thumbnails") or []
    return Track(
        title=entry.get("title") or "Bilinmeyen parça",
        requester_id=requester_id,
        url=url,
        artist=entry.get("uploader") or entry.get("channel") or entry.get("artist"),
        duration=int(entry["duration"]) if entry.get("duration") else None,
        thumbnail=entry.get("thumbnail") or (thumbs[-1].get("url") if thumbs else None),
        source=source,
    )


async def extract_stream(target: str, *, cookies_file: str = "", strategy_args: list[str] | None = None) -> dict:
    """Tek bir parçanın tüm bilgisini ve ses akışı URL'sini getirir. target bir URL ya da 'ytsearch1:…' olabilir."""
    info = await run_json(
        ["--no-playlist", "-f", AUDIO_FORMAT], target, cookies_file=cookies_file, strategy_args=strategy_args,
    )
    if info.get("entries") is not None:  # arama sonucu
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise YtdlError("unavailable", "Arama sonuç vermedi")
        info = entries[0]
    if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"}:
        raise YtdlError("live", "Canlı yayınlar çalınamıyor")
    if not info.get("url"):
        raise YtdlError("error", "Ses akışı bulunamadı")
    return info


async def extract_flat(target: str, *, limit: int, cookies_file: str = "") -> tuple[str | None, list[dict]]:
    """Playlist ya da arama sonuçlarını hızlıca (akış URL'si olmadan) listeler. Döner: (başlık, girdiler)."""
    info = await run_json(
        ["--flat-playlist", "--playlist-end", str(limit)], target, cookies_file=cookies_file,
    )
    if info.get("entries") is None:
        return info.get("title"), [info]
    return info.get("title"), [e for e in info["entries"] if e][:limit]


def user_agent_of(info: dict) -> str | None:
    return (info.get("http_headers") or {}).get("User-Agent")


async def probe_stream(url: str, user_agent: str | None = None, *, timeout: float = 25) -> str | None:
    """
    Ses akışının çalınabildiğini, çalarken kullanılan FFmpeg'in kendisiyle 1 saniye
    okuyarak doğrular. yt-dlp link verse de link 403 dönebilir (bazı YouTube istemcileri,
    eksik User-Agent…); Python'un HTTP istemcisi YouTube'a farklı göründüğü için bu
    kontrol mutlaka FFmpeg ile yapılır. Döner: hata metni ya da None (açılıyor).
    """
    cmd = [ffmpeg_path(), "-v", "error", "-nostdin", *shlex.split(ffmpeg_input_options(user_agent)),
           "-t", "1", "-i", url, "-f", "null", "-"]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
    except OSError as exc:
        return f"FFmpeg çalıştırılamadı: {exc}"
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return f"{timeout:g} sn içinde açılmadı"
    if proc.returncode != 0:
        lines = err.decode("utf-8", "replace").strip().splitlines()
        return (lines[-1] if lines else f"FFmpeg çıkış kodu {proc.returncode}")[:200]
    return None


async def version() -> str | None:
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "yt_dlp", "--version",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        proc.kill()
        return None
    return out.decode().strip() or None
