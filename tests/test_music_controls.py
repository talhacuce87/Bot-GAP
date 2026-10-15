"""
Müzik oynatıcısı kontrol testleri: önceki şarkı / başa sarma, ileri-geri sarma,
"şimdi çalıyor" kartı ve butonları, !playlist görünümü.
Ses bağlantısı ve ağ sahtelenir.
"""

from __future__ import annotations

import io
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import discord
import pytest
from PIL import Image

from music import card, spotify
from music.cog import MusicCog, NowPlayingView
from music.config import MusicConfig
from music.player import GuildPlayer
from music.ytdl import Track

from tests.test_music import _embed_html


class FakeVoice:
    def __init__(self) -> None:
        self.playing, self.paused, self.stops = True, False, 0
        self.channel = SimpleNamespace(id=5, members=[], mention="#ses")

    def is_connected(self) -> bool:
        return True

    def is_playing(self) -> bool:
        return self.playing and not self.paused

    def is_paused(self) -> bool:
        return self.paused

    def stop(self) -> None:
        self.stops += 1
        self.playing = False

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False


@pytest.fixture
def cfg(tmp_path):
    return MusicConfig(state_path=tmp_path / "music_state.json")


def _player(cfg, *, elapsed: float = 0.0, duration: int | None = 200) -> GuildPlayer:
    cog = SimpleNamespace(cfg=cfg, forget=lambda *a: None, players={})
    player = GuildPlayer(cog, SimpleNamespace(id=1), SimpleNamespace(send=AsyncMock()))
    cog.players[1] = player
    player.voice = FakeVoice()
    player.current = Track(title="Şimdiki", requester_id=1, duration=duration)
    player._started_at = time.monotonic() - elapsed
    return player


# ---------------------------------------------------------------------------
# ⏮️ önceki / başa sar
# ---------------------------------------------------------------------------

async def test_previous_in_first_seconds_goes_to_previous_track(cfg):
    player = _player(cfg, elapsed=2)
    old, nxt = Track(title="Önceki", requester_id=1), Track(title="Sonraki", requester_id=1)
    old.extra["announced"] = True
    player.history.append(old)
    player.queue.append(nxt)

    assert player.previous() == "previous"
    assert player.voice.stops == 1
    current = player.current
    assert await player._next_track() is old
    assert "announced" not in old.extra                       # yeniden kart gönderilecek
    assert list(player.queue) == [current, nxt]               # çalan şarkı sıranın başına döndü


async def test_previous_after_threshold_restarts_track(cfg):
    player = _player(cfg, elapsed=30)
    player.history.append(Track(title="Önceki", requester_id=1))
    assert player.previous() == "restart"
    assert player._seek_to == 0 and not player._go_back


def test_previous_without_history_restarts(cfg):
    player = _player(cfg, elapsed=1)
    assert player.previous() == "restart"


def test_previous_when_idle(cfg):
    player = _player(cfg)
    player.voice.playing = False
    assert player.previous() == "none"


async def test_previous_with_queue_loop_does_not_duplicate(cfg):
    player = _player(cfg)
    first, second = Track(title="1", requester_id=1), Track(title="2", requester_id=1)
    player.loop_mode = "queue"
    player.current = first
    player.queue.append(second)
    assert await player._next_track() is second               # 1 → geçmiş + listenin sonu
    player.current = second
    player._go_back = True
    assert await player._next_track() is first
    assert list(player.queue) == [second]                     # 1 sondan da çıkarıldı


# ---------------------------------------------------------------------------
# ⏪ ⏩ sarma
# ---------------------------------------------------------------------------

def test_seek_forward_and_back(cfg):
    player = _player(cfg, elapsed=30)
    assert player.seek_relative(10) == pytest.approx(40, abs=0.5)
    assert player._seek_to == pytest.approx(40, abs=0.5)

    player = _player(cfg, elapsed=4)
    assert player.seek_relative(-10) == 0


def test_seek_past_end_skips(cfg):
    player = _player(cfg, elapsed=195, duration=200)
    assert player.seek_relative(10) is None
    assert player._skipped and player._seek_to is None


def test_elapsed_includes_seek_offset(cfg):
    player = _player(cfg, elapsed=5)
    player._offset = 60
    assert player.elapsed == pytest.approx(65, abs=0.5)


async def test_play_loop_restarts_stream_at_seek_position(cfg):
    player = _player(cfg)
    player.cog.sources = SimpleNamespace(stream_for=AsyncMock(return_value="https://akış"))
    calls: list[float] = []

    async def fake_stream(track, url, start_at):
        calls.append(start_at)
        if len(calls) == 1:
            player._seek_to = 42.0                            # kullanıcı ⏩'e bastı
            return 3.0, None
        return 150.0, None

    player._stream = fake_stream
    await player._play(player.current)
    assert calls == [0.0, 42.0]


async def test_play_loop_retries_once_on_early_failure(cfg):
    player = _player(cfg)
    track = player.current
    track.stream_url = "eski"
    player.cog.sources = SimpleNamespace(stream_for=AsyncMock(return_value="https://akış"))
    player._stream = AsyncMock(return_value=(0.4, RuntimeError("403")))
    await player._play(track)
    assert player._stream.await_count == 2                    # bir kez yeniden denendi, sonra pes
    assert track.stream_url is None


# ---------------------------------------------------------------------------
# "Şimdi çalıyor" mesajı
# ---------------------------------------------------------------------------

def _components(view: discord.ui.LayoutView) -> list[dict]:
    return view.to_components()


def _row_emojis(row: dict) -> list[str]:
    return [c["emoji"]["name"] for c in row["components"]]


def test_now_playing_view_layout(cfg):
    player = _player(cfg)
    player.now_track = player.current
    player.now_has_card = True
    player.current.extra["collection"] = "Yol Şarkıları"
    player.queue.append(Track(title="x", requester_id=1))
    comps = _components(NowPlayingView(player.cog, player))

    assert [c["type"] for c in comps] == [10, 12, 10, 1, 1]
    assert "Şimdi çalıyor" in comps[0]["content"]
    assert comps[1]["items"][0]["media"]["url"] == f"attachment://{card.FILENAME}"
    assert "<@1>" in comps[2]["content"] and "Yol Şarkıları" in comps[2]["content"]
    assert _row_emojis(comps[3]) == ["⏮️", "⏪", "⏸️", "⏩", "⏭️"]
    assert _row_emojis(comps[4]) == ["🔁", "🔀", "⏹️"]


def test_now_playing_view_reflects_pause_and_loop(cfg):
    player = _player(cfg)
    player.now_track = player.current
    player.voice.paused = True
    player.loop_mode = "track"
    comps = _components(NowPlayingView(player.cog, player))

    assert [c["type"] for c in comps] == [10, 10, 1, 1]           # kart yoksa galeri de yok
    assert "Duraklatıldı" in comps[0]["content"]
    assert _row_emojis(comps[2])[2] == "▶️"
    loop = comps[3]["components"][0]
    assert loop["emoji"]["name"] == "🔂" and loop["style"] == discord.ButtonStyle.success.value


def test_finished_view_has_no_buttons(cfg):
    player = _player(cfg)
    player.now_track = player.current
    player.now_has_card = True
    comps = _components(NowPlayingView(player.cog, player, finished=True))
    assert [c["type"] for c in comps] == [10, 12, 10]
    assert "Çalındı" in comps[0]["content"]


def test_playlist_embed_shows_history_current_and_upcoming(cfg):
    player = _player(cfg, elapsed=50, duration=200)
    player.current.extra["collection"] = "Yol Şarkıları"
    player.history.append(Track(title="Eski", requester_id=1))
    player.queue.extend(Track(title=f"S{i}", requester_id=1, duration=100) for i in range(1, 13))

    embed = MusicCog.playlist_embed(None, player, 1)
    assert embed.title == "📃 Yol Şarkıları"
    assert "~~Eski~~" in embed.description and "**Şimdiki**" in embed.description
    assert "`1.` S1" in embed.description and "S11" not in embed.description
    assert "sayfa 1/2" in embed.footer.text

    page2 = MusicCog.playlist_embed(None, player, 9)            # sınırı aşan sayfa son sayfaya iner
    assert "`11.` S11" in page2.description and "Eski" not in page2.description


# ---------------------------------------------------------------------------
# Kart
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("title", "artist", "source", "expected"),
    [
        ("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", "Rick Astley", "youtube",
         ("Never Gonna Give You Up", "Rick Astley")),
        ("Kuzu Kuzu [Official Music Video]", "TarkanVEVO", "youtube", ("Kuzu Kuzu", "Tarkan")),
        ("Gülpembe", "Barış Manço - Topic", "youtube", ("Gülpembe", "Barış Manço")),
        ("Song (Live at Wembley)", "Band", "youtube", ("Song (Live at Wembley)", "Band")),
        ("Some Song (feat. X) - Remix", "Artist", "spotify", ("Some Song (feat. X) - Remix", "Artist")),
        ("🔥🔥", None, "search", ("Şimdi çalıyor", "")),
    ],
)
def test_split_title(title, artist, source, expected):
    assert card.split_title(Track(title=title, artist=artist, requester_id=1, source=source)) == expected


def _png(color=(200, 30, 60), size=(480, 360)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.parametrize("cover", [None, _png(), b"bozuk veri"])
def test_render_card(cover):
    track = Track(title="Çok uzun bir şarkı adı " * 4, artist="Sanatçı", requester_id=1, duration=245, source="spotify")
    img = Image.open(card.render_card(track, cover))
    assert img.size == (card.WIDTH, card.HEIGHT) and img.mode == "RGBA"
    assert img.getpixel((0, 0))[3] == 0                       # yuvarlak köşe saydam
    assert img.getpixel((card.WIDTH // 2, card.HEIGHT // 2))[3] == 255


def test_spotify_cover_from_embed():
    result = spotify.parse_embed_html(_embed_html({
        "type": "track", "name": "A", "artists": [{"name": "X"}],
        "visualIdentity": {"image": [
            {"url": "https://i/300", "maxWidth": 300}, {"url": "https://i/640", "maxWidth": 640},
            {"url": "https://i/64", "maxWidth": 64},
        ]},
    }))
    assert result.cover == "https://i/640"

    playlist = spotify.parse_embed_html(_embed_html({
        "type": "playlist", "name": "L", "trackList": [{"title": "A", "subtitle": "X"}],
        "visualIdentity": {"image": [{"url": "https://playlist-kapagi", "maxWidth": 640}]},
    }))
    assert playlist.cover is None                             # playlist kapağı şarkıya ait değil
