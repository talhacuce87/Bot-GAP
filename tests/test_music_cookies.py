"""
!muzikcerez (Discord'dan YouTube çerezi yükleme), art arda hata koruması ve
SoundCloud yedeğinin sonuç sırası testleri.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import discord
import pytest
from discord.ext import commands

import activitylog
from music import config as music_config
from music import ytdl
from music.cog import MusicCog, parse_cookie_file
from music.config import MusicConfig
from music.player import MAX_FAILURES_IN_ROW, GuildPlayer
from music.sources import SourceError, SourceResolver
from music.updater import Updater
from music.ytdl import Track

LOGGED_IN = (
    "# Netscape HTTP Cookie File\n"
    ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tLOGIN_INFO\tabc\n"
    "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-3PSID\tdef\n"
    ".youtube.com\tTRUE\t/\tFALSE\t1893456000\tPREF\tf6=40000000\n"
    ".google.com\tTRUE\t/\tTRUE\t1893456000\tNID\txyz\n"
)
ANONYMOUS = ".youtube.com\tTRUE\t/\tFALSE\t1893456000\tPREF\tf6=40000000\n"


@pytest.fixture
def cfg(tmp_path):
    return MusicConfig(state_path=tmp_path / "music_state.json")


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    monkeypatch.setattr(activitylog, "record", lambda *a, **k: None)


def test_parse_cookie_file():
    assert parse_cookie_file(LOGGED_IN) == (3, True)
    assert parse_cookie_file(ANONYMOUS) == (1, False)
    assert parse_cookie_file("merhaba dünya") == (0, False)


# ---------------------------------------------------------------------------
# !muzikcerez
# ---------------------------------------------------------------------------

class _Attachment:
    def __init__(self, text: str) -> None:
        self.data = text.encode()
        self.size = len(self.data)

    async def read(self) -> bytes:
        return self.data


class _Ctx:
    def __init__(self, *, attachment: str | None = None, in_guild: bool = False) -> None:
        self.author = SimpleNamespace(id=7)
        self.guild = SimpleNamespace(id=1) if in_guild else None
        self.sent: list[str] = []
        self.edits: list[str] = []
        self.deleted = False
        ctx = self

        async def delete():
            ctx.deleted = True

        self.message = SimpleNamespace(attachments=[_Attachment(attachment)] if attachment else [], delete=delete)
        self.command = SimpleNamespace(name="muzikcerez")

    async def send(self, content=None, **_):
        self.sent.append(content)
        ctx = self

        async def edit(content=None, **__):
            ctx.edits.append(content)

        return SimpleNamespace(edit=edit)


def _cog(cfg, *, admin: bool = True, heal_ok: bool = True) -> MusicCog:
    member = SimpleNamespace(guild_permissions=SimpleNamespace(administrator=admin))
    guild = SimpleNamespace(get_member=lambda uid: member)
    bot = SimpleNamespace(guilds=[guild], dispatch=lambda *a: None)
    cog = MusicCog(bot, cfg)
    cog.updater.heal = AsyncMock(return_value=heal_ok)
    cog._report_health_change = AsyncMock()
    return cog


def _run(cog, ctx, action=None):
    cmd = next(c for c in MusicCog.__cog_commands__ if c.name == "muzikcerez")
    return cmd.callback(cog, ctx, action)


async def test_cookie_upload_from_dm_is_saved_and_used(cfg):
    cog = _cog(cfg)
    ctx = _Ctx(attachment=LOGGED_IN)
    await _run(cog, ctx)

    path = cfg.state_path.parent / "cookies.txt"
    assert path.read_text(encoding="utf-8") == LOGGED_IN
    assert cog.cfg.cookies_file == str(path)
    assert cog.sources.cfg.cookies_file == cog.updater.cfg.cookies_file == str(path)   # yeniden başlatmadan
    cog.updater.heal.assert_awaited_once()
    assert "YouTube çalışıyor" in ctx.edits[-1]
    assert "--cookies" in ytdl.build_command([], "x", cog.sources.cfg.cookies_file)


async def test_cookie_upload_in_channel_deletes_message(cfg):
    cog = _cog(cfg)
    ctx = _Ctx(attachment=LOGGED_IN, in_guild=True)
    await _run(cog, ctx)
    assert ctx.deleted and "DM" in ctx.sent[0]


@pytest.mark.parametrize(
    ("text", "expected"),
    [(ANONYMOUS, "giriş yapılmış"), ("bozuk dosya", "Netscape")],
)
async def test_invalid_cookie_files_are_rejected(cfg, text, expected):
    cog = _cog(cfg)
    ctx = _Ctx(attachment=text)
    await _run(cog, ctx)
    assert expected in ctx.sent[-1]
    assert not (cfg.state_path.parent / "cookies.txt").exists() and cog.cfg.cookies_file == ""


async def test_cookie_help_remove_and_permissions(cfg):
    cog = _cog(cfg)
    ctx = _Ctx()
    await _run(cog, ctx)
    assert "Gizli pencerede" in ctx.sent[-1] or "gizli pencere" in ctx.sent[-1].lower()

    await _run(cog, _Ctx(attachment=LOGGED_IN))
    ctx = _Ctx()
    await _run(cog, ctx, "sil")
    assert not (cfg.state_path.parent / "cookies.txt").exists() and cog.cfg.cookies_file == ""

    stranger = _cog(cfg, admin=False)
    ctx = _Ctx(attachment=LOGGED_IN)
    await _run(stranger, ctx)
    assert "yönetici" in ctx.sent[-1] and not (cfg.state_path.parent / "cookies.txt").exists()


async def test_failed_heal_after_upload_explains(cfg):
    cog = _cog(cfg, heal_ok=False)
    cog.updater.state.health_kind, cog.updater.state.health_error = "blocked", "Sign in to confirm"
    ctx = _Ctx(attachment=LOGGED_IN)
    await _run(cog, ctx)
    assert "hâlâ açılmıyor" in ctx.edits[-1] and "blocked" in ctx.edits[-1]


async def test_only_cookie_command_works_in_dm(cfg):
    cog = _cog(cfg)
    assert await cog.cog_check(SimpleNamespace(guild=None, command=SimpleNamespace(name="muzikcerez")))
    with pytest.raises(commands.NoPrivateMessage):
        await cog.cog_check(SimpleNamespace(guild=None, command=SimpleNamespace(name="çal")))


def test_uploaded_cookie_file_is_picked_up_after_restart(tmp_path, monkeypatch):
    path = tmp_path / "cookies.txt"
    monkeypatch.setattr(music_config, "DEFAULT_COOKIES_PATH", path)
    monkeypatch.delenv("YTDLP_COOKIES_FILE", raising=False)
    assert music_config.load_config().cookies_file == ""
    path.write_text(LOGGED_IN, encoding="utf-8")
    assert music_config.load_config().cookies_file == str(path)


# ---------------------------------------------------------------------------
# Art arda hata koruması
# ---------------------------------------------------------------------------

async def test_playlist_stops_after_repeated_failures(cfg):
    cog = SimpleNamespace(cfg=cfg, forget=lambda *a: None,
                          sources=SimpleNamespace(stream_for=AsyncMock(side_effect=SourceError("YouTube kapalı."))))
    sent: list[str] = []
    player = GuildPlayer(cog, SimpleNamespace(id=1), SimpleNamespace(send=AsyncMock(side_effect=lambda t: sent.append(t))))
    player.voice = SimpleNamespace(is_connected=lambda: True)
    player.add([Track(title=f"Ş{i}", requester_id=1) for i in range(10)])

    for _ in range(MAX_FAILURES_IN_ROW):
        await player._play(player.queue.popleft())
    assert len(sent) == MAX_FAILURES_IN_ROW
    assert "Art arda" in sent[-1] and "7" in sent[-1]                 # kalan 7 şarkı tek mesajla
    assert not player.queue


async def test_success_resets_failure_count(cfg):
    results = [SourceError("x"), SourceError("x"), "https://akis", SourceError("x"), SourceError("x")]
    cog = SimpleNamespace(cfg=cfg, forget=lambda *a: None, sources=SimpleNamespace(stream_for=AsyncMock(side_effect=results)))
    player = GuildPlayer(cog, SimpleNamespace(id=1), SimpleNamespace(send=AsyncMock()))
    player.voice = SimpleNamespace(is_connected=lambda: False)     # başarılı akış çalınmadan döner
    player.add([Track(title=f"Ş{i}", requester_id=1) for i in range(8)])
    for _ in range(5):
        await player._play(player.queue.popleft())
    assert len(player.queue) == 3                                  # sayaç sıfırlandığı için liste durmadı


# ---------------------------------------------------------------------------
# SoundCloud sonuç sırası
# ---------------------------------------------------------------------------

async def test_soundcloud_keeps_search_order_when_duration_unknown(cfg, monkeypatch):
    res = SourceResolver(cfg, Updater(cfg))
    entries = [
        {"url": "https://sc/1", "duration": 227.0, "title": "Nilüfer - Son Arzum", "uploader": "A"},
        {"url": "https://sc/2", "duration": 224.0, "title": "dizi müziği nilüfer son arzum", "uploader": "B"},
    ]
    monkeypatch.setattr(ytdl, "extract_flat", AsyncMock(return_value=(None, entries)))
    picked: list[str] = []

    async def extract_stream(url, **_):
        picked.append(url)
        return {"url": url + "/stream", "title": "x", "webpage_url": url, "duration": 200}

    monkeypatch.setattr(ytdl, "extract_stream", extract_stream)
    await res._soundcloud_track("Nilüfer - Son Arzum", 1, None)
    assert picked == ["https://sc/1"]                                # en kısa değil, en alakalı
    await res._soundcloud_track("Nilüfer - Son Arzum", 1, 225)
    assert picked[-1] == "https://sc/2"                              # süre biliniyorsa en yakın
