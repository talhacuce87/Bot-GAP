"""
Müzik modülü testleri: girdi sınıflandırma, Spotify okuma, yt-dlp hata türleri,
kendi kendini onarma akışı, SoundCloud yedeği, kuyruk mantığı ve bot entegrasyonu.
Ağ ve gerçek yt-dlp çağrısı yapılmaz; hepsi sahtelenir.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import discord
import pytest

from music import spotify, ytdl
from music.config import MusicConfig
from music.player import GuildPlayer
from music.sources import SourceError, SourceResolver, _normalize_youtube, classify_input
from music.updater import Updater
from music.ytdl import Track, YtdlError


@pytest.fixture
def cfg(tmp_path):
    return MusicConfig(state_path=tmp_path / "music_state.json")


# ---------------------------------------------------------------------------
# Girdi sınıflandırma
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"),
        ("https://youtu.be/dQw4w9WgXcQ?si=abc", "youtube"),
        ("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM", "youtube"),
        ("https://www.youtube.com/playlist?list=PL123", "youtube_playlist"),
        ("https://open.spotify.com/intl-tr/track/4uLU6hMCjMI75M1A2tKUQC?si=x", "spotify"),
        ("spotify:album:4aawyAB9vmqN3uQ7FjRGTy", "spotify"),
        ("https://spotify.link/abcDEF", "spotify"),
        ("https://soundcloud.com/artist/song", "soundcloud"),
        ("https://soundcloud.com/artist/sets/album", "soundcloud_set"),
        ("tarkan şımarık", "search"),
        ("https://example.com/a.mp3", "unsupported"),
        ("http://localhost:8080/admin", "unsupported"),
    ],
)
def test_classify_input(text, kind):
    assert classify_input(text) == kind


def test_normalize_youtube_drops_playlist_part():
    assert _normalize_youtube("https://www.youtube.com/watch?v=abc123&list=RDabc&index=2") == (
        "https://www.youtube.com/watch?v=abc123"
    )


@pytest.mark.parametrize(
    ("stderr", "kind"),
    [
        ("ERROR: [youtube] x: Sign in to confirm you're not a bot", "blocked"),
        ("ERROR: This content isn't available, try again later", "blocked"),
        ("ERROR: [youtube] aaaaaaaaaaa: This video is unavailable", "unavailable"),
        ("ERROR: Private video", "unavailable"),
        ("ERROR: Sign in to confirm your age", "age"),
        ("ERROR: Requested format is not available", "error"),
        ("ERROR: nsig extraction failed", "error"),
        ("ERROR: something new and weird", "error"),
    ],
)
def test_classify_error(stderr, kind):
    assert ytdl.classify_error(stderr) == kind


def test_user_input_never_becomes_an_option():
    cmd = ytdl.build_command(["--no-playlist"], "--exec rm -rf /")
    assert cmd[-2:] == ["--", "--exec rm -rf /"]
    assert cmd[:3] == [sys.executable, "-m", "yt_dlp"]


# ---------------------------------------------------------------------------
# Spotify
# ---------------------------------------------------------------------------

def _embed_html(entity: dict) -> str:
    data = {"props": {"pageProps": {"state": {"data": {"entity": entity}}}}}
    return f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script></html>'


def test_spotify_parse_link():
    assert spotify.parse_link("https://open.spotify.com/intl-tr/track/4uLU6hMCjMI75M1A2tKUQC?si=1") == (
        "track", "4uLU6hMCjMI75M1A2tKUQC")
    assert spotify.parse_link("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M") == ("playlist", "37i9dQZF1DXcBWIGoYBM5M")
    assert spotify.parse_link("https://youtube.com/watch?v=x") is None


def test_spotify_embed_track_and_playlist():
    track = spotify.parse_embed_html(_embed_html({
        "type": "track", "name": "Never Gonna Give You Up", "duration": 213573,
        "artists": [{"name": "Rick Astley"}],
    }))
    assert track.kind == "track"
    assert track.tracks[0].query == "Rick Astley - Never Gonna Give You Up"

    playlist = spotify.parse_embed_html(_embed_html({
        "type": "playlist", "name": "Liste",
        "trackList": [
            {"title": "A", "subtitle": "X,\xa0Y", "duration": 1000, "isPlayable": True},
            {"title": "B", "subtitle": "Z", "duration": 2000, "isPlayable": False},
        ],
    }))
    assert playlist.name == "Liste"
    assert [(t.title, t.artist) for t in playlist.tracks] == [("A", "X, Y")]


def test_spotify_embed_without_data_raises():
    with pytest.raises(spotify.SpotifyError):
        spotify.parse_embed_html("<html>değişmiş sayfa</html>")


# ---------------------------------------------------------------------------
# Kendi kendini onarma
# ---------------------------------------------------------------------------

def _scripted_updater(cfg, results: list[bool]):
    """check_youtube sırayla results'taki sonuçları döner; update çağrıları kaydedilir."""
    up = Updater(cfg)
    calls: list[bool] = []
    it = iter(results)

    async def check():
        ok = next(it)
        return (True, "", "") if ok else (False, "error", "nsig extraction failed")

    async def update(*, pre=False, reason=""):
        calls.append(pre)
        return True

    up.check_youtube = check
    up.update = update
    return up, calls


async def test_heal_does_nothing_when_youtube_works(cfg):
    up, calls = _scripted_updater(cfg, [True])
    assert await up.heal("test") is True
    assert calls == [] and up.state.health_ok


async def test_heal_stable_update_fixes(cfg):
    up, calls = _scripted_updater(cfg, [False, True])
    assert await up.heal("test") is True
    assert calls == [False]


async def test_heal_falls_back_to_nightly(cfg):
    up, calls = _scripted_updater(cfg, [False, False, True])
    assert await up.heal("test") is True
    assert calls == [False, True]


async def test_heal_gives_up_alerts_once_and_respects_cooldown(cfg):
    up, calls = _scripted_updater(cfg, [False, False, False, False])
    assert await up.heal("test") is False
    assert calls == [False, True]
    assert not up.state.health_ok and up.state.failing_since
    assert up.should_alert()
    up.mark_alerted()
    assert not up.should_alert()                     # günde bir kez
    assert await up.heal("tekrar") is False
    assert calls == [False, True]                    # 30 dk içinde yeniden güncelleme yok
    assert Updater(cfg).state.health_ok is False     # durum diske yazıldı


async def test_heal_without_auto_update(cfg):
    up, calls = _scripted_updater(replace(cfg, auto_update=False), [False])
    assert await up.heal("test") is False
    assert calls == []


# ---------------------------------------------------------------------------
# Kaynak çözümleme & SoundCloud yedeği
# ---------------------------------------------------------------------------

async def test_unsupported_link_is_rejected(cfg):
    res = SourceResolver(cfg, Updater(cfg))
    with pytest.raises(SourceError, match="Sadece YouTube"):
        await res.resolve("https://example.com/a.mp3", 1)


async def test_spotify_playlist_becomes_lazy_tracks(cfg, monkeypatch):
    res = SourceResolver(replace(cfg, max_playlist=2), Updater(cfg))
    result = spotify.SpotifyResult("playlist", "Liste", [
        spotify.SpotifyTrack("A", "X", 120000), spotify.SpotifyTrack("B", "Y", None), spotify.SpotifyTrack("C", "Z")])
    monkeypatch.setattr(res.spotify, "resolve", AsyncMock(return_value=result))
    tracks, name = await res.resolve("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", 7)
    assert name == "Liste"
    assert [(t.query, t.duration, t.source, t.requester_id) for t in tracks] == [
        ("X - A", 120, "spotify", 7), ("Y - B", None, "spotify", 7)]


async def test_stream_falls_back_to_soundcloud_when_youtube_is_broken(cfg, monkeypatch):
    up = Updater(cfg)
    monkeypatch.setattr(up, "heal", AsyncMock(return_value=False))
    res = SourceResolver(cfg, up)

    async def extract_stream(target, *, cookies_file=""):
        if target.startswith("ytsearch") or "youtube" in target:
            raise YtdlError("blocked", "Sign in to confirm you're not a bot")
        return {"url": "https://sc/stream.mp3", "title": "Song", "webpage_url": "https://soundcloud.com/a/song",
                "duration": 200, "uploader": "Artist"}

    async def extract_flat(target, *, limit, cookies_file=""):
        assert target.startswith("scsearch")
        return None, [
            {"url": "https://api.soundcloud.com/tracks/1", "duration": 30.0},   # önizleme → atlanır
            {"url": "https://api.soundcloud.com/tracks/2", "duration": 199.0},
        ]

    monkeypatch.setattr(ytdl, "extract_stream", extract_stream)
    monkeypatch.setattr(ytdl, "extract_flat", extract_flat)

    track = Track(title="Song", artist="Artist", query="Artist - Song", requester_id=1, source="spotify", duration=200)
    assert await res.stream_for(track) == "https://sc/stream.mp3"
    assert track.fallback == "soundcloud"
    up.heal.assert_awaited()


async def test_deleted_video_does_not_trigger_heal(cfg, monkeypatch):
    up = Updater(cfg)
    monkeypatch.setattr(up, "heal", AsyncMock(return_value=True))
    res = SourceResolver(cfg, up)
    monkeypatch.setattr(ytdl, "extract_stream", AsyncMock(side_effect=YtdlError("unavailable", "This video is unavailable")))
    with pytest.raises(SourceError, match="kaldırılmış"):
        await res.resolve("https://www.youtube.com/watch?v=aaaaaaaaaaa", 1)
    up.heal.assert_not_awaited()


async def test_too_long_track_is_rejected(cfg, monkeypatch):
    res = SourceResolver(replace(cfg, max_track_seconds=600), Updater(cfg))
    monkeypatch.setattr(ytdl, "extract_stream", AsyncMock(return_value={
        "url": "https://x", "title": "10 saat yağmur sesi", "duration": 36000, "webpage_url": "https://youtu.be/x"}))
    with pytest.raises(SourceError, match="çok uzun"):
        await res.resolve("https://youtu.be/xxxxxxxxxxx", 1)


async def test_cached_stream_is_reused(cfg, monkeypatch):
    res = SourceResolver(cfg, Updater(cfg))
    monkeypatch.setattr(ytdl, "extract_stream", AsyncMock(side_effect=AssertionError("çağrılmamalı")))
    track = Track(title="x", requester_id=1, url="https://youtu.be/x", stream_url="https://cached",
                  stream_expires=time.time() + 60)
    assert await res.stream_for(track) == "https://cached"


# ---------------------------------------------------------------------------
# Kuyruk mantığı
# ---------------------------------------------------------------------------

def _player(cfg, **cfg_overrides):
    cog = SimpleNamespace(cfg=replace(cfg, **cfg_overrides), forget=lambda *a: None)
    return GuildPlayer(cog, SimpleNamespace(id=1), SimpleNamespace(send=AsyncMock()))


def _tracks(n: int) -> list[Track]:
    return [Track(title=f"T{i}", requester_id=1) for i in range(1, n + 1)]


def test_queue_add_cap_remove_shuffle(cfg):
    player = _player(cfg, max_queue=3)
    assert player.add(_tracks(5)) == 3
    assert player.remove(2).title == "T2"
    assert [t.title for t in player.queue] == ["T1", "T3"]
    assert player.remove(9) is None
    player.add(_tracks(1))
    before = sorted(t.title for t in player.queue)
    player.shuffle()
    assert sorted(t.title for t in player.queue) == before


def test_loop_mode_cycles(cfg):
    player = _player(cfg)
    assert [player.cycle_loop() for _ in range(3)] == ["track", "queue", "off"]


async def test_next_track_respects_loop_modes(cfg):
    player = _player(cfg)
    t1, t2 = _tracks(2)
    player.add([t1, t2])

    assert await player._next_track() is t1
    player.current = t1
    player.loop_mode = "track"
    assert await player._next_track() is t1          # şarkı tekrarı
    player._skipped = True
    assert await player._next_track() is t2          # geçince tekrar atlanır

    player.current = t2
    player.loop_mode = "queue"
    t2.stream_url = "eski"
    assert await player._next_track() is t2          # kuyruk tekrarı: sona eklenip geri gelir
    assert t2.stream_url is None                     # taze link alınacak


async def test_idle_timeout_returns_none(cfg):
    player = _player(cfg, idle_timeout=0)
    assert await player._next_track() is None
    player.text_channel.send.assert_awaited()


# ---------------------------------------------------------------------------
# Bot entegrasyonu & sağlık bildirimi
# ---------------------------------------------------------------------------

async def _start_bot(monkeypatch, tmp_path, music_enabled: bool):
    import database

    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    monkeypatch.setenv("AI_ENABLED", "false")
    monkeypatch.setenv("MUSIC_ENABLED", "true" if music_enabled else "false")
    from Main import GapBot

    bot = GapBot(command_prefix="!", intents=discord.Intents.default(), help_command=None, case_insensitive=True)
    await bot._async_setup_hook()
    await bot.setup_hook()
    return bot


async def test_music_commands_register_without_conflicts(monkeypatch, tmp_path):
    bot = await _start_bot(monkeypatch, tmp_path, True)
    try:
        assert bot.get_cog("MusicCog") is not None
        for name in ("çal", "cal", "play", "p", "geç", "skip", "bitir", "kuyruk", "şimdi", "np",
                     "tekrar", "volume", "karıştır", "kaldır", "temizle", "muzikdurum", "muzikguncelle",
                     "playlist", "pl", "önceki", "ileri", "geri", "duraklat", "devam"):
            assert bot.get_command(name) is not None, name
        assert bot.get_command("ses").cog_name == "XPTrackerCog"   # mevcut !ses bozulmadı
    finally:
        await bot.close()


async def test_music_can_be_disabled(monkeypatch, tmp_path):
    bot = await _start_bot(monkeypatch, tmp_path, False)
    try:
        assert bot.get_cog("MusicCog") is None and bot.get_command("çal") is None
    finally:
        await bot.close()


async def test_health_alerts_once_then_reports_recovery(monkeypatch, tmp_path):
    bot = await _start_bot(monkeypatch, tmp_path, True)
    try:
        cog = bot.get_cog("MusicCog")
        cog.updater.cfg = replace(cog.updater.cfg, state_path=tmp_path / "ms.json")
        alerts: list[str] = []
        monkeypatch.setattr(bot, "dispatch", lambda event, guild, title, desc: alerts.append(title))

        cog.updater._record_health(False, "blocked", "Sign in to confirm you're not a bot")
        await cog._report_health_change()
        await cog._report_health_change()
        assert alerts == ["🎵 Müzik: YouTube çalışmıyor"]          # tekrar tekrar bildirmez

        cog.updater._record_health(True)
        await cog._report_health_change()
        assert alerts[-1] == "✅ Müzik: YouTube tekrar çalışıyor"
    finally:
        await bot.close()
