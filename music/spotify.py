"""
music/spotify.py — Spotify linklerinden şarkı adı/sanatçı bilgisini okur.

Spotify sesi DRM korumalıdır ve çalınamaz; burada sadece parça bilgisi alınır,
çalma YouTube araması üzerinden yapılır (bkz. sources.py).

Sıra:
1. Herkese açık embed sayfası (anahtar gerekmez; parça, albüm, playlist).
2. Resmi Web API (SPOTIFY_CLIENT_ID/SECRET varsa; parça ve albüm — Şubat 2026'dan
   beri başkasına ait playlist'lerin şarkı listesi API'den alınamıyor).
"""

from __future__ import annotations

import base64
import json
import logging
import re
import time
from dataclasses import dataclass

import aiohttp

log = logging.getLogger("gap.music.spotify")

_URL_RE = re.compile(
    r"(?:https?://)?open\.spotify\.com/(?:intl-[a-z-]+/)?(?:embed/)?(track|album|playlist)/([A-Za-z0-9]{10,32})"
)
_URI_RE = re.compile(r"spotify:(track|album|playlist):([A-Za-z0-9]{10,32})")
_SHORT_RE = re.compile(r"(?:https?://)?(?:spotify\.link|spotify\.app\.link)/\S+")
_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)

_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
_TIMEOUT = aiohttp.ClientTimeout(total=15)


class SpotifyError(Exception):
    pass


@dataclass(frozen=True)
class SpotifyTrack:
    title: str
    artist: str
    duration_ms: int | None = None

    @property
    def query(self) -> str:
        return f"{self.artist} - {self.title}" if self.artist else self.title


@dataclass(frozen=True)
class SpotifyResult:
    kind: str  # track | album | playlist
    name: str
    tracks: list[SpotifyTrack]
    # Parça/albüm kapağı (playlist kapağı parçalara ait olmadığı için kullanılmaz)
    cover: str | None = None


def parse_link(text: str) -> tuple[str, str] | None:
    """(tür, id) döner; Spotify linki değilse None."""
    m = _URL_RE.search(text) or _URI_RE.search(text)
    return (m.group(1), m.group(2)) if m else None


def is_short_link(text: str) -> bool:
    return bool(_SHORT_RE.fullmatch(text.strip()))


def _clean(text: str | None) -> str:
    return " ".join((text or "").replace("\xa0", " ").split())


def _largest_image(images: list[dict] | None) -> str | None:
    images = [i for i in images or [] if i.get("url")]
    if not images:
        return None
    return max(images, key=lambda i: i.get("maxWidth") or i.get("width") or 0)["url"]


def parse_embed_html(html: str) -> SpotifyResult:
    """Embed sayfasındaki __NEXT_DATA__ JSON'ından parça listesini çıkarır."""
    m = _NEXT_DATA_RE.search(html)
    if not m:
        raise SpotifyError("Embed sayfasında veri bulunamadı")
    try:
        entity = json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise SpotifyError(f"Embed verisi beklenen biçimde değil: {exc}") from exc

    kind = entity.get("type") or "track"
    name = _clean(entity.get("name") or entity.get("title"))
    if kind == "track":
        artists = ", ".join(_clean(a.get("name")) for a in entity.get("artists") or [] if a.get("name"))
        tracks = [SpotifyTrack(name, artists, entity.get("duration"))]
    else:
        tracks = [
            SpotifyTrack(_clean(t.get("title")), _clean(t.get("subtitle")), t.get("duration"))
            for t in entity.get("trackList") or []
            if t.get("title") and t.get("isPlayable", True)
        ]
    if not tracks or not tracks[0].title:
        raise SpotifyError("Embed sayfasında parça yok")
    cover = _largest_image((entity.get("visualIdentity") or {}).get("image")) if kind != "playlist" else None
    return SpotifyResult(kind, name, tracks, cover)


class SpotifyClient:
    def __init__(self, client_id: str = "", client_secret: str = "") -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._token: str | None = None
        self._token_expires = 0.0

    @property
    def api_enabled(self) -> bool:
        return bool(self._client_id and self._client_secret)

    async def resolve(self, text: str) -> SpotifyResult:
        async with aiohttp.ClientSession(headers=_HEADERS, timeout=_TIMEOUT) as session:
            if is_short_link(text):
                url = text.strip() if text.startswith("http") else f"https://{text.strip()}"
                async with session.get(url, allow_redirects=True) as resp:
                    text = str(resp.url)
            parsed = parse_link(text)
            if parsed is None:
                raise SpotifyError("Spotify linki anlaşılamadı")
            kind, item_id = parsed

            errors: list[str] = []
            try:
                return await self._from_embed(session, kind, item_id)
            except (SpotifyError, aiohttp.ClientError, TimeoutError) as exc:
                errors.append(f"embed: {exc}")
                log.warning("Spotify embed okunamadı (%s/%s): %s", kind, item_id, exc)

            if self.api_enabled and kind in {"track", "album"}:
                try:
                    return await self._from_api(session, kind, item_id)
                except (SpotifyError, aiohttp.ClientError, TimeoutError) as exc:
                    errors.append(f"api: {exc}")
                    log.warning("Spotify API okunamadı (%s/%s): %s", kind, item_id, exc)

            if kind == "track":
                # Son çare: oEmbed sadece şarkı adını verir ama YouTube'da aramak için yeter
                try:
                    return await self._from_oembed(session, item_id)
                except (SpotifyError, aiohttp.ClientError, TimeoutError, ValueError) as exc:
                    errors.append(f"oembed: {exc}")

            raise SpotifyError("; ".join(errors) or "Spotify bilgisi alınamadı")

    @staticmethod
    async def _from_oembed(session: aiohttp.ClientSession, item_id: str) -> SpotifyResult:
        async with session.get(
            "https://open.spotify.com/oembed", params={"url": f"https://open.spotify.com/track/{item_id}"},
        ) as resp:
            if resp.status != 200:
                raise SpotifyError(f"HTTP {resp.status}")
            title = _clean((await resp.json(content_type=None)).get("title"))
        if not title:
            raise SpotifyError("oEmbed başlık vermedi")
        return SpotifyResult("track", title, [SpotifyTrack(title, "")])

    @staticmethod
    async def _from_embed(session: aiohttp.ClientSession, kind: str, item_id: str) -> SpotifyResult:
        async with session.get(f"https://open.spotify.com/embed/{kind}/{item_id}") as resp:
            if resp.status != 200:
                raise SpotifyError(f"HTTP {resp.status}")
            return parse_embed_html(await resp.text())

    async def _api_token(self, session: aiohttp.ClientSession) -> str:
        if self._token and time.time() < self._token_expires - 60:
            return self._token
        auth = base64.b64encode(f"{self._client_id}:{self._client_secret}".encode()).decode()
        async with session.post(
            "https://accounts.spotify.com/api/token",
            data={"grant_type": "client_credentials"},
            headers={"Authorization": f"Basic {auth}"},
        ) as resp:
            if resp.status != 200:
                raise SpotifyError(f"token HTTP {resp.status}")
            data = await resp.json()
        self._token = data["access_token"]
        self._token_expires = time.time() + int(data.get("expires_in", 3600))
        return self._token

    async def _from_api(self, session: aiohttp.ClientSession, kind: str, item_id: str) -> SpotifyResult:
        token = await self._api_token(session)
        async with session.get(
            f"https://api.spotify.com/v1/{kind}s/{item_id}",
            headers={"Authorization": f"Bearer {token}"},
        ) as resp:
            if resp.status != 200:
                raise SpotifyError(f"HTTP {resp.status}")
            data = await resp.json()

        def artists(obj: dict) -> str:
            return ", ".join(a["name"] for a in obj.get("artists") or [] if a.get("name"))

        if kind == "track":
            cover = _largest_image((data.get("album") or {}).get("images"))
            return SpotifyResult(
                "track", data["name"], [SpotifyTrack(data["name"], artists(data), data.get("duration_ms"))], cover,
            )
        items = (data.get("tracks") or {}).get("items") or []
        return SpotifyResult(
            "album", data["name"],
            [SpotifyTrack(t["name"], artists(t), t.get("duration_ms")) for t in items if t.get("name")],
            _largest_image(data.get("images")),
        )
