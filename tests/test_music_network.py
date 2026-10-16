"""
YouTube engeline karşı ağ katmanı testleri: ses akışı kontrolü (probe), şarkı bazında
bağlantı yöntemi değiştirme ve sağlık kontrolünün "link verdi ama açılmıyor" durumunu yakalaması.
"""

from __future__ import annotations

import io
import wave
from dataclasses import replace
from unittest.mock import AsyncMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from music import ytdl
from music.config import MusicConfig
from music.sources import SourceResolver
from music.updater import STRATEGIES, Updater
from music.ytdl import YtdlError


@pytest.fixture
def cfg(tmp_path):
    return MusicConfig(state_path=tmp_path / "music_state.json")


@pytest.fixture(autouse=True)
def _reset_network():
    yield
    ytdl.configure_network(strategy_args=[], proxy="")


def _wav(seconds: float = 2.0) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(bytes(2 * int(8000 * seconds)))
    return buf.getvalue()


async def test_probe_stream_uses_ffmpeg_with_user_agent():
    """Probe, çalarken kullanılan FFmpeg'in kendisiyle ve aynı User-Agent ile yapılır."""
    seen: list[str] = []

    async def song(request):
        seen.append(request.headers.get("User-Agent", ""))
        if request.headers.get("User-Agent") != "Tarayici/1.0":   # YouTube gibi: UA tutmazsa 403
            return web.Response(status=403)
        return web.Response(body=_wav(), content_type="audio/wav")

    app = web.Application()
    app.router.add_get("/song.wav", song)
    async with TestServer(app) as server:
        url = str(server.make_url("/song.wav"))
        assert await ytdl.probe_stream(url, "Tarayici/1.0") is None
        assert "403" in await ytdl.probe_stream(url)
    assert "Tarayici/1.0" in seen and any(ua.startswith("Lavf") for ua in seen)
    assert await ytdl.probe_stream("http://127.0.0.1:9/yok.wav", timeout=10) is not None


def _fake_ytdl(monkeypatch, *, extract, probe):
    """extract(yöntem) → info ya da YtdlError; probe(yöntem) → None ya da hata. Denenen yöntemler kaydedilir."""
    tried: list[str] = []

    def name_of(args):
        return next(n for n, a in STRATEGIES.items() if a == args)

    async def extract_stream(target, *, cookies_file="", strategy_args=None):
        name = name_of(strategy_args if strategy_args is not None else ytdl._strategy_args)
        tried.append(name)
        result = extract(name)
        if isinstance(result, Exception):
            raise result
        return {"url": f"https://akis/{name}", "title": "Şarkı", "duration": 200, "webpage_url": target}

    async def probe_stream(url, user_agent=None, **_):
        return probe(url.rsplit("/", 1)[1])

    monkeypatch.setattr(ytdl, "extract_stream", extract_stream)
    monkeypatch.setattr(ytdl, "probe_stream", probe_stream)
    return tried


async def test_song_uses_another_strategy_when_link_is_forbidden(cfg, monkeypatch):
    tried = _fake_ytdl(monkeypatch, extract=lambda n: None,
                       probe=lambda n: None if n == "tv" else "HTTP 403")
    res = SourceResolver(cfg, Updater(cfg))
    info = await res._youtube_stream("https://youtu.be/x", "")
    assert info["url"] == "https://akis/tv"
    assert tried == ["default", "ipv4", "tv"]
    assert res.updater.state.strategy == "default"             # bu videoya özel; genel ayar değişmez


async def test_song_tries_youtube_once_when_it_is_known_broken(cfg, monkeypatch):
    tried = _fake_ytdl(monkeypatch, extract=lambda n: YtdlError("blocked", "not a bot"), probe=lambda n: None)
    up = Updater(cfg)
    up.state.health_ok = False
    with pytest.raises(YtdlError) as exc:
        await SourceResolver(cfg, up)._youtube_stream("https://youtu.be/x", "")
    assert tried == ["default"] and exc.value.kind == "blocked"      # tek deneme, sonra yedeğe

    tried.clear()
    _fake_ytdl(monkeypatch, extract=lambda n: None, probe=lambda n: None)
    assert (await SourceResolver(cfg, up)._youtube_stream("https://youtu.be/x", ""))["url"] == "https://akis/default"


async def test_song_tries_at_most_three_strategies_without_condemning_youtube(cfg, monkeypatch):
    tried = _fake_ytdl(monkeypatch, extract=lambda n: None, probe=lambda n: "HTTP 403")
    up = Updater(cfg)
    with pytest.raises(YtdlError) as exc:
        await SourceResolver(cfg, up)._youtube_stream("https://youtu.be/x", "")
    assert tried == ["default", "ipv4", "tv"] and exc.value.kind == "stream"
    assert up.state.health_ok              # tek şarkı yüzünden değil, sağlık testine göre karar verilir


async def test_blocked_error_is_reported_over_later_errors(cfg, monkeypatch):
    errors = {"default": YtdlError("blocked", "not a bot")}
    _fake_ytdl(monkeypatch, extract=lambda n: errors.get(n, YtdlError("error", "page needs reload")),
               probe=lambda n: None)
    with pytest.raises(YtdlError) as exc:
        await SourceResolver(cfg, Updater(cfg))._youtube_stream("https://youtu.be/x", "")
    assert exc.value.kind == "blocked"                             # SoundCloud yedeği ve uyarı doğru çalışsın


async def test_content_error_stops_immediately(cfg, monkeypatch):
    tried = _fake_ytdl(monkeypatch, extract=lambda n: YtdlError("unavailable", "Video unavailable"),
                       probe=lambda n: None)
    with pytest.raises(YtdlError):
        await SourceResolver(cfg, Updater(cfg))._youtube_stream("https://youtu.be/x", "")
    assert tried == ["default"]


async def test_healthcheck_fails_when_link_does_not_open(cfg, monkeypatch):
    _fake_ytdl(monkeypatch, extract=lambda n: None, probe=lambda n: "HTTP 403")
    ok, kind, err = await Updater(cfg).check_youtube()
    assert (ok, kind) == (False, "stream") and "403" in err


async def test_heal_skips_strategies_whose_links_do_not_open(cfg, monkeypatch):
    _fake_ytdl(monkeypatch, extract=lambda n: None, probe=lambda n: None if n == "embedded" else "HTTP 403")
    up = Updater(replace(cfg, auto_update=False))
    assert await up.heal("test") is True
    assert up.state.strategy == "embedded" and ytdl._strategy_args == STRATEGIES["embedded"]


@pytest.mark.parametrize("probe_error", [None, "HTTP 403"])
async def test_resolve_single_youtube_link_uses_working_stream(cfg, monkeypatch, probe_error):
    _fake_ytdl(monkeypatch, extract=lambda n: None,
               probe=lambda n: probe_error if n == "default" else None)
    res = SourceResolver(cfg, Updater(cfg))
    res.updater.heal = AsyncMock(return_value=False)
    tracks, _ = await res.resolve("https://www.youtube.com/watch?v=abc", 1)
    assert tracks[0].stream_url == ("https://akis/default" if probe_error is None else "https://akis/ipv4")
