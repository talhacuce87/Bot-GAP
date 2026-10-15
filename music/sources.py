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

import asyncio
import logging
import re
import time
import unicodedata
from urllib.parse import parse_qs, urlparse

import aiohttp

from music import spotify, ytdl
from music.config import MusicConfig
from music.updater import CONTENT_ERRORS, STRATEGIES, Updater
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
# !muzikdurum'daki canlı SoundCloud testi için aranan şarkı
SC_TEST_QUERY = "Barış Manço Gülpembe"
# YouTube çalışırken bir şarkı için en fazla bu kadar bağlantı yöntemi denenir (bekletmemek için)
SONG_STRATEGY_LIMIT = 3
_NOISE_WORDS = {
    "official", "video", "music", "audio", "lyrics", "lyric", "hd", "hq", "4k", "upgrade", "remaster",
    "remastered", "feat", "ft", "klip", "clip", "mv", "visualizer", "the", "and", "ve", "ile", "topic", "vevo",
}
_TR_FOLD = str.maketrans("çğıöşüÇĞİÖŞÜ", "cgiosuCGIOSU")


def _words(text: str) -> set[str]:
    """Karşılaştırma için sade kelimeler: küçük harf, Türkçe/aksan katlama, gürültü kelimeleri atılır."""
    text = unicodedata.normalize("NFKD", text.translate(_TR_FOLD).casefold())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return {w for w in re.findall(r"\w+", text) if len(w) > 1 and w not in _NOISE_WORDS}


# Adayda olup aranan şarkıda olmayan bu kelimeler başka bir versiyon demektir (slowed, cover…)
_VARIANT_WORDS = {
    "slowed", "reverb", "sped", "speed", "spedup", "nightcore", "remix", "rmx", "cover", "karaoke",
    "instrumental", "enstrumantal", "8d", "live", "canli", "acoustic", "akustik", "mashup", "bassboosted",
    "boosted", "lofi", "tiktok", "edit", "loop", "hour", "saat",
}


def clean_query(text: str) -> str:
    """
    YouTube başlığını aramaya uygun hâle getirir: (Official Video), [4K] gibi ekler atılır;
    versiyon bildiren parantezler ((Remix), (Live)…) kalır.
    """
    text = re.sub(r"[(\[]([^)\]]*)[)\]]",
                  lambda m: f" {m.group(1)} " if _words(m.group(1)) & _VARIANT_WORDS else " ", text)
    text = re.sub(r"\s*[–—|]\s*", " - ", text)
    return " ".join(text.split()).strip(" -")


def match_score(query: str, candidate: str) -> float:
    """
    Aranan şarkının kelimelerinin ne kadarı adayda geçiyor (0–1). Aday başka bir versiyonsa
    (aranan şarkıda olmayan "slowed", "cover", "remix"… kelimeleri) 0 döner.
    """
    wanted, found = _words(query), _words(candidate)
    if not wanted or (found & _VARIANT_WORDS) - wanted:
        return 0.0
    return len(wanted & found) / len(wanted)


def is_same_song(query: str, candidate: str) -> bool:
    """
    Aday aranan şarkı mı? Kısa sorgularda (≤4 kelime) bütün kelimeler, uzunlarda 5 kelimede
    en fazla 1 eksik kabul edilir. ("Sezen Aksu - Firuze" ≠ "Sezen Aksu - Geri Dön")
    """
    wanted = _words(query)
    if not wanted:
        return False
    allowed_missing = len(wanted) // 5
    return match_score(query, candidate) >= 1 - allowed_missing / len(wanted) - 1e-9


def _not_found_anywhere(kind: str) -> str:
    return f"{ERROR_MESSAGES.get(kind, ERROR_MESSAGES['error'])} SoundCloud'da da aynı şarkı bulunamadı."


def _duration_ok(candidate: float | None, expected: int | None) -> bool:
    if not expected or not candidate:
        return True
    return abs(candidate - expected) <= max(20, expected * 0.15)


class SourceError(Exception):
    """Kullanıcıya gösterilecek, anlaşılır hata."""


ERROR_MESSAGES = {
    "unavailable": "Bu içerik bulunamadı ya da kaldırılmış.",
    "age": "Bu video yaş sınırlı olduğu için çalınamıyor.",
    "live": "Canlı yayınlar çalınamıyor.",
    "blocked": "YouTube şu an bota erişim vermiyor.",
    "timeout": "Kaynak çok geç cevap verdi.",
    "stream": "YouTube şu an ses akışını açmıyor.",
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
        # SoundCloud yedeğinin son hatası (!muzikdurum'da gösterilir)
        self.soundcloud_error = ""
        self._heal_task: asyncio.Task | None = None

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
            if kind == "youtube":
                target = _normalize_youtube(text)
                info = await self._with_heal(lambda: self._youtube_stream(target, cookies), kind)
            else:
                info = await ytdl.extract_stream(text)
            track = ytdl._entry_to_track(info, requester_id, "soundcloud" if kind == "soundcloud" else "youtube")
            _check_duration(track, self.cfg)
            track.stream_url = info["url"]
            track.user_agent = ytdl.user_agent_of(info)
            track.stream_expires = time.time() + STREAM_TTL
            return [track], None
        except YtdlError as exc:
            if kind in {"youtube", "search"} and exc.kind not in CONTENT_ERRORS:
                # YouTube onarılamadı: aynı şeyi SoundCloud'da ara
                query = text if kind == "search" else await youtube_title(text)
                fallback = await self._soundcloud_track(query, requester_id)
                if fallback:
                    return [fallback], None
                raise SourceError(_not_found_anywhere(exc.kind)) from exc
            raise SourceError(ERROR_MESSAGES.get(exc.kind, ERROR_MESSAGES["error"])) from exc

    async def _soundcloud_track(
        self, query: str | None, requester_id: int, expected_duration: int | None = None,
    ) -> Track | None:
        """
        SoundCloud'da arar. 30 sn'lik önizlemeleri (ücretli parçalar) ve aranan şarkıya
        benzemeyen sonuçları atlar; alakasız bir şarkı çalmaktansa hiç çalmamak yeğdir.
        """
        query = clean_query(query or "")
        if not query:
            return None
        try:
            _, entries = await ytdl.extract_flat(f"scsearch5:{query}", limit=5)
            scored = [
                (match_score(query, f"{e.get('title') or ''} {e.get('uploader') or ''}"), e)
                for e in entries
                if e.get("url") and (e.get("duration") or 0) > SC_PREVIEW_SECONDS
                and _duration_ok(e.get("duration"), expected_duration)
                and is_same_song(query, f"{e.get('title') or ''} {e.get('uploader') or ''}")
            ]
            if not scored:
                self.soundcloud_error = "Aranan şarkıya benzeyen tam sürüm bulunamadı"
                log.info("SoundCloud'da eşleşen tam sürüm yok: %s", query)
                return None
            scored.sort(key=lambda se: (-se[0], abs((se[1].get("duration") or 0) - (expected_duration or 0))))
            info = await ytdl.extract_stream(scored[0][1]["url"])
        except YtdlError as exc:
            self.soundcloud_error = f"{exc.kind}: {exc}"
            log.warning("SoundCloud yedeği çalışmadı (%s): %s", query, self.soundcloud_error)
            return None
        if "/preview/" in info.get("url", ""):
            return None
        self.soundcloud_error = ""
        track = ytdl._entry_to_track(info, requester_id, "soundcloud")
        track.stream_url = info["url"]
        track.user_agent = ytdl.user_agent_of(info)
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

        target = track.url or f"ytsearch1:{track.query or track.display}"
        try:
            if track.source == "soundcloud":
                info = await ytdl.extract_stream(target)
            else:
                cookies = self.cfg.cookies_file
                info = await self._with_heal(lambda: self._youtube_stream(target, cookies), track.source)
        except YtdlError as exc:
            if exc.kind in CONTENT_ERRORS and track.source != "spotify":
                raise SourceError(ERROR_MESSAGES[exc.kind]) from exc
            # YouTube onarılamadı ya da bu parça açılmıyor: SoundCloud'da aynı şarkı
            if track.source == "spotify" and track.artist:
                # SoundCloud'da "feat." sanatçılar genelde yazmaz; ana sanatçı + şarkı adıyla ara
                query = f"{track.artist.split(',')[0].strip()} - {track.title}"
            elif track.url and track.source in {"youtube", "search"}:
                query = await youtube_title(track.url)
            else:
                query = track.query
            # Süre filtresi yalnızca Spotify'ın verdiği gerçek şarkı süresiyle (YouTube klipleri farklı uzunlukta olabilir)
            expected = track.duration if track.source == "spotify" else None
            fallback = await self._soundcloud_track(query or track.display, track.requester_id, expected)
            if not fallback:
                raise SourceError(_not_found_anywhere(exc.kind)) from exc
            info = {"url": fallback.stream_url, "webpage_url": fallback.url,
                    "http_headers": {"User-Agent": fallback.user_agent} if fallback.user_agent else {},
                    "duration": fallback.duration, "thumbnail": fallback.thumbnail}
            track.fallback = "soundcloud"

        if track.source == "spotify" and not track.url:
            track.url = info.get("webpage_url")
            track.thumbnail = track.thumbnail or info.get("thumbnail")
        track.duration = track.duration or (int(info["duration"]) if info.get("duration") else None)
        track.stream_url = info["url"]
        track.user_agent = ytdl.user_agent_of(info)
        track.stream_expires = time.time() + STREAM_TTL
        return track.stream_url

    async def _youtube_stream(self, target: str, cookies: str) -> dict:
        """
        YouTube parçasının bilgisini ve gerçekten açılan bir ses akışını getirir.

        Hangi bağlantı yönteminin çalıştığı videoya göre değişebilir (bazı istemcilerin
        linkleri bazı videolarda 403 döner). Bu yüzden link çalmadan önce denenir; açılmazsa
        bu parça için birkaç yöntem daha denenir. Hiçbiri olmazsa YouTube sorunlu sayılır ve
        sonraki şarkılarda onarım bitene kadar tek hızlı deneme yapılıp yedeğe geçilir.
        """
        # YouTube zaten sorunluysa tek hızlı deneme (bazı videolar yine açılabilir), sonra yedeğe
        limit = SONG_STRATEGY_LIMIT if self.updater.state.health_ok else 1
        order = self.updater.strategy_order()[:limit]
        error: YtdlError | None = None
        for name in order:
            try:
                info = await ytdl.extract_stream(target, cookies_file=cookies, strategy_args=STRATEGIES[name])
            except YtdlError as exc:
                if exc.kind in CONTENT_ERRORS:
                    raise
                error = error if error and error.kind == "blocked" else exc
                continue
            if (problem := await ytdl.probe_stream(info["url"], ytdl.user_agent_of(info))) is None:
                if name != order[0]:
                    log.info("'%s' bu parçada '%s' yöntemiyle açıldı", target[:80], name)
                return info
            error = error or YtdlError("stream", f"Ses akışı açılmıyor ({problem})")
        error = error or YtdlError("error", "Ses akışı bulunamadı")
        self.updater.mark_failing(error.kind, str(error))
        raise error

    async def check_soundcloud(self) -> tuple[bool, str]:
        """Canlı test: SoundCloud'da bir şarkı bulunup akışı alınabiliyor mu."""
        track = await self._soundcloud_track(SC_TEST_QUERY, 0)
        if track is not None:
            return True, ""
        return False, self.soundcloud_error or "Arama sonuç vermedi"

    async def _with_heal(self, call, kind: str):
        """
        yt-dlp çağrısı. YouTube kaynaklı (içerik dışı) hatada onarım arka planda başlatılır ve
        hata hemen yükseltilir: şarkı beklemeden yedeğe geçer, sonraki şarkılar onarımdan yararlanır.
        """
        try:
            return await call()
        except YtdlError as exc:
            if exc.kind in CONTENT_ERRORS or kind.startswith("soundcloud"):
                raise
            self._heal_in_background(f"{kind} hatası: {exc.kind}")
            raise

    def _heal_in_background(self, reason: str) -> None:
        if (self._heal_task and not self._heal_task.done()) or not self.updater.can_heal():
            return

        async def run() -> None:
            try:
                await self.updater.heal(reason)
            except Exception:
                log.exception("Arka plan YouTube onarımı başarısız")

        self._heal_task = asyncio.create_task(run(), name="music-heal")
