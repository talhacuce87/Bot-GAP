"""
music/sources.py — Kullanıcı girdisini (link ya da arama) çalınabilir parçalara çevirir.

- YouTube / YouTube Music: video, playlist, arama
- Spotify: parça / albüm / playlist bilgisi okunur, YouTube'da aranarak çalınır
- SoundCloud: parça / set
- Düz metin: YouTube araması

Çalma anında YouTube hata verirse önce updater ile onarım denenir; yine olmazsa
aynı şarkı SoundCloud'da aranır (fallback).
"""

from __future__ import annotations

import logging
import time
from urllib.parse import parse_qs, urlparse

import aiohttp

from music import spotify, ytdl
from music.config import MusicConfig
from music.updater import CONTENT_ERRORS, Updater
from music.ytdl import Track, YtdlError

log = logging.getLogger("gap.music.sources")

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
SOUNDCLOUD_HOSTS = {"soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"}
SPOTIFY_HOSTS = {"open.spotify.com", "spotify.link", "spotify.app.link"}

# YouTube akış URL'leri ~6 saat geçerli; güvenli tarafta kal
STREAM_TTL = 4 * 3600
MAX_QUERY_LENGTH = 200
# SoundCloud'da ücretli parçalar sadece 30 sn'lik önizleme olarak gelir
SC_PREVIEW_SECONDS = 31


class SourceError(Exception):
    """Kullanıcıya gösterilecek, anlaşılır hata."""


ERROR_MESSAGES = {
    "unavailable": "Bu içerik bulunamadı ya da kaldırılmış.",
    "age": "Bu video yaş sınırlı olduğu için çalınamıyor.",
    "live": "Canlı yayınlar çalınamıyor.",
    "blocked": "YouTube şu an bota erişim vermiyor.",
    "timeout": "Kaynak çok geç cevap verdi.",
    "error": "İçerik okunamadı.",
}


def classify_input(text: str) -> str:
    """youtube | youtube_playlist | spotify | soundcloud | search | unsupported"""
    text = text.strip()
    if text.startswith("spotify:"):
        return "spotify"
    if not text.lower().startswith(("http://", "https://")):
        return "search"
    parsed = urlparse(text)
    host = (parsed.hostname or "").lower()
    if host in YOUTUBE_HOSTS:
        qs = parse_qs(parsed.query)
        if "list" in qs and "v" not in qs and host != "youtu.be":
            return "youtube_playlist"
        return "youtube"
    if host in SPOTIFY_HOSTS:
        return "spotify"
    if host in SOUNDCLOUD_HOSTS:
        return "soundcloud_set" if "/sets/" in parsed.path else "soundcloud"
    return "unsupported"


def _normalize_youtube(url: str) -> str:
    """watch?v=…&list=… gibi linklerde sadece videoyu çal."""
    parsed = urlparse(url)
    qs = parse_qs(parsed.query)
    if (parsed.hostname or "").endswith("youtube.com") and "v" in qs:
        return f"https://www.youtube.com/watch?v={qs['v'][0]}"
    return url


async def youtube_title(url: str) -> str | None:
    """YouTube engelliyken bile genelde çalışan oEmbed ile video başlığını alır (SoundCloud yedeği için)."""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            async with session.get("https://www.youtube.com/oembed", params={"url": url, "format": "json"}) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
    except (aiohttp.ClientError, TimeoutError, ValueError):
        return None
    title = data.get("title")
    author = data.get("author_name")
    return f"{author} - {title}" if title and author and author.lower() not in title.lower() else title


def _check_duration(track: Track, cfg: MusicConfig) -> None:
    if track.duration and track.duration > cfg.max_track_seconds:
        raise SourceError(f"Parça çok uzun (en fazla {cfg.max_track_seconds // 60} dakika).")


class SourceResolver:
    def __init__(self, cfg: MusicConfig, updater: Updater) -> None:
        self.cfg = cfg
        self.updater = updater
        self.spotify = spotify.SpotifyClient(cfg.spotify_client_id, cfg.spotify_client_secret)

    # ------------------------------------------------------------------
    # Girdi → parça listesi
    # ------------------------------------------------------------------

    async def resolve(self, text: str, requester_id: int) -> tuple[list[Track], str | None]:
        """Döner: (parçalar, playlist/albüm adı ya da None)."""
        text = " ".join(text.split())[:MAX_QUERY_LENGTH]
        if not text:
            raise SourceError("Bir link ya da şarkı adı yazmalısın.")
        kind = classify_input(text)
        cookies = self.cfg.cookies_file

        if kind == "unsupported":
            raise SourceError("Sadece YouTube, Spotify ve SoundCloud linkleri destekleniyor.")

        if kind == "spotify":
            try:
                result = await self.spotify.resolve(text)
            except spotify.SpotifyError as exc:
                log.warning("Spotify çözülemedi: %s", exc)
                raise SourceError("Spotify linki okunamadı.") from exc
            tracks = [
                Track(title=t.title, artist=t.artist, query=t.query, requester_id=requester_id,
                      duration=(t.duration_ms or 0) // 1000 or None, thumbnail=result.cover, source="spotify")
                for t in result.tracks[: self.cfg.max_playlist]
            ]
            return tracks, (result.name if result.kind != "track" else None)

        try:
            if kind in {"youtube_playlist", "soundcloud_set"}:
                title, entries = await self._with_heal(
                    lambda: ytdl.extract_flat(text, limit=self.cfg.max_playlist, cookies_file=cookies), kind,
                )
                source = "soundcloud" if kind == "soundcloud_set" else "youtube"
                tracks = [ytdl._entry_to_track(e, requester_id, source) for e in entries if e.get("url")]
                tracks = [t for t in tracks if not t.duration or t.duration <= self.cfg.max_track_seconds]
                if not tracks:
                    raise SourceError("Playlist boş ya da okunamadı.")
                return tracks, title or "Playlist"

            if kind == "search":
                _, entries = await self._with_heal(
                    lambda: ytdl.extract_flat(f"ytsearch1:{text}", limit=1, cookies_file=cookies), kind,
                )
                if not entries:
                    raise SourceError(f"`{text}` için sonuç bulunamadı.")
                track = ytdl._entry_to_track(entries[0], requester_id, "youtube")
                track.source = "search"
                _check_duration(track, self.cfg)
                return [track], None

            # Tek video (YouTube / SoundCloud): bilgi + akış URL'si tek seferde
            target = _normalize_youtube(text) if kind == "youtube" else text
            info = await self._with_heal(lambda: ytdl.extract_stream(target, cookies_file=cookies), kind)
            track = ytdl._entry_to_track(info, requester_id, "soundcloud" if kind == "soundcloud" else "youtube")
            _check_duration(track, self.cfg)
            track.stream_url = info["url"]
            track.stream_expires = time.time() + STREAM_TTL
            return [track], None
        except YtdlError as exc:
            if kind in {"youtube", "search"} and exc.kind not in CONTENT_ERRORS:
                # YouTube onarılamadı: aynı şeyi SoundCloud'da ara
                query = text if kind == "search" else await youtube_title(text)
                fallback = await self._soundcloud_track(query, requester_id)
                if fallback:
                    return [fallback], None
            raise SourceError(ERROR_MESSAGES.get(exc.kind, ERROR_MESSAGES["error"])) from exc

    async def _soundcloud_track(
        self, query: str | None, requester_id: int, expected_duration: int | None = None,
    ) -> Track | None:
        """SoundCloud'da arar; 30 sn'lik önizlemeleri (ücretli parçalar) atlar."""
        if not query:
            return None
        try:
            _, entries = await ytdl.extract_flat(f"scsearch5:{query}", limit=5)
            full = [e for e in entries if e.get("url") and (e.get("duration") or 0) > SC_PREVIEW_SECONDS]
            if not full:
                return None
            if expected_duration:
                full.sort(key=lambda e: abs((e.get("duration") or 0) - expected_duration))
            info = await ytdl.extract_stream(full[0]["url"])
        except YtdlError:
            return None
        if "/preview/" in info.get("url", ""):
            return None
        track = ytdl._entry_to_track(info, requester_id, "soundcloud")
        track.stream_url = info["url"]
        track.stream_expires = time.time() + STREAM_TTL
        track.fallback = "soundcloud"
        return track

    # ------------------------------------------------------------------
    # Parça → ses akışı (çalma anında)
    # ------------------------------------------------------------------

    async def stream_for(self, track: Track) -> str:
        """Parçanın çalınabilir ses akışı URL'sini döner; gerekirse onarır / SoundCloud'a düşer."""
        if track.stream_url and time.time() < track.stream_expires:
            return track.stream_url

        cookies = self.cfg.cookies_file if track.source != "soundcloud" else ""
        target = track.url or f"ytsearch1:{track.query or track.display}"
        try:
            info = await self._with_heal(lambda: ytdl.extract_stream(target, cookies_file=cookies), track.source)
        except YtdlError as exc:
            if exc.kind in CONTENT_ERRORS and track.source != "spotify":
                raise SourceError(ERROR_MESSAGES[exc.kind]) from exc
            # YouTube onarılamadı ya da bu parça açılmıyor: SoundCloud'da aynı şarkı
            query = track.query or (await youtube_title(track.url) if track.url and track.source == "youtube" else None)
            fallback = await self._soundcloud_track(query or track.display, track.requester_id, track.duration)
            if not fallback:
                raise SourceError(ERROR_MESSAGES.get(exc.kind, ERROR_MESSAGES["error"])) from exc
            info = {"url": fallback.stream_url, "webpage_url": fallback.url,
                    "duration": fallback.duration, "thumbnail": fallback.thumbnail}
            track.fallback = "soundcloud"

        if track.source == "spotify" and not track.url:
            track.url = info.get("webpage_url")
            track.thumbnail = track.thumbnail or info.get("thumbnail")
        track.duration = track.duration or (int(info["duration"]) if info.get("duration") else None)
        track.stream_url = info["url"]
        track.stream_expires = time.time() + STREAM_TTL
        return track.stream_url

    async def _with_heal(self, call, kind: str):
        """yt-dlp çağrısı; YouTube kaynaklı (içerik dışı) hatada bir kez onarıp tekrar dener."""
        try:
            return await call()
        except YtdlError as exc:
            if exc.kind in CONTENT_ERRORS or kind.startswith("soundcloud"):
                raise
            healed = await self.updater.heal(f"{kind} hatası: {exc.kind}")
            if not healed:
                raise
            return await call()
