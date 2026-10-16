"""
Cloudflare WARP yolu testleri: onarımda WARP'a geçiş, kimlik yenileme, geri dönüş,
açılışta kayıtlı yolun kurulması ve wgcf/wireproxy kurulum adımları. Ağ ve gerçek
programlar sahtelenir.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from music import warp as warp_mod
from music import ytdl
from music.config import MusicConfig
from music.updater import STRATEGIES, Updater
from music.warp import Warp, WarpError, _platform, parse_trace

PROXY = "http://127.0.0.1:25345"


@pytest.fixture
def cfg(tmp_path):
    return MusicConfig(state_path=tmp_path / "music_state.json", auto_update=False)


@pytest.fixture(autouse=True)
def _reset_network():
    yield
    ytdl.configure_network(strategy_args=[], proxy="")


class FakeWarp:
    """identities[i]: i. WARP kimliğinin YouTube'da çalışıp çalışmadığı (None: WARP hiç başlamaz)."""

    def __init__(self, identities: list[bool | None]) -> None:
        self.identities = identities
        self.identity = 0
        self.running = False
        self.proxy_url = PROXY
        self.last_ip = "2a09::1"
        self.last_error = ""
        self.starts = self.rotations = self.stops = 0

    def _up(self) -> bool:
        self.running = self.identities[self.identity] is not None
        if not self.running:
            self.last_error = "bağlanamadı"
        return self.running

    async def start(self, *, fresh: bool = False) -> bool:
        self.starts += 1
        return self._up()

    async def rotate(self) -> bool:
        self.rotations += 1
        self.identity = min(self.identity + 1, len(self.identities) - 1)
        return self._up()

    async def stop(self) -> None:
        self.stops += 1
        self.running = False

    def youtube_works(self) -> bool:
        return bool(self.running and self.identities[self.identity])


def _updater(cfg, fake: FakeWarp, *, direct_works: bool = False) -> Updater:
    up = Updater(cfg)
    up.warp = fake

    async def check():
        on_warp = ytdl._proxy == PROXY
        if (on_warp and fake.youtube_works()) or (not on_warp and direct_works):
            return True, "", ""
        return False, "blocked", "Sign in to confirm you're not a bot"

    up.check_youtube = check
    return up


async def test_heal_switches_to_warp_when_direct_is_blocked(cfg):
    fake = FakeWarp([True])
    up = _updater(cfg, fake)
    assert await up.heal("test") is True
    assert up.state.route == "warp" and ytdl._proxy == PROXY
    assert Updater(cfg).state.route == "warp"                 # yeniden başlatmada hatırlanır


async def test_heal_rotates_warp_identity_when_warp_ip_is_flagged(cfg):
    fake = FakeWarp([False, True])
    up = _updater(cfg, fake)
    assert await up.heal("test") is True
    assert fake.rotations == 1 and up.state.route == "warp" and ytdl._proxy == PROXY


async def test_heal_gives_up_and_returns_to_direct(cfg):
    fake = FakeWarp([False, False])
    up = _updater(cfg, fake)
    assert await up.heal("test") is False
    assert up.state.route == "direct" and ytdl._proxy == "" and not fake.running
    assert up.state.health_kind == "blocked"                    # asıl sorun gizlenmez


async def test_warp_that_cannot_start_does_not_break_heal(cfg):
    fake = FakeWarp([None])
    up = _updater(cfg, fake)
    assert await up.heal("test") is False
    assert up.state.route == "direct" and ytdl._proxy == ""


async def test_flagged_warp_rotates_then_falls_back_to_direct(cfg):
    fake = FakeWarp([True, False])
    up = _updater(cfg, fake, direct_works=False)
    assert await up.heal("ilk") is True and up.state.route == "warp"
    fake.identities = [False, False]                            # WARP IP'si de işaretlendi
    up.state.last_heal_ts = 0
    assert await up.heal("ikinci") is False
    assert fake.rotations >= 1 and up.state.route == "warp"     # en son çalışan yolda kalır


async def test_startup_restores_saved_warp_route(cfg):
    up = _updater(cfg, FakeWarp([True]))
    up.state.route = "warp"
    await up.start_network()
    assert ytdl._proxy == PROXY

    broken = _updater(cfg, FakeWarp([None]))
    broken.state.route = "warp"
    await broken.start_network()
    assert ytdl._proxy == ""                                    # WARP açılmadıysa doğrudan devam


async def test_ensure_network_restarts_crashed_warp(cfg):
    fake = FakeWarp([True])
    up = _updater(cfg, fake)
    up.state.route = "warp"
    await up.ensure_network()
    assert fake.starts == 1 and ytdl._proxy == PROXY
    await up.ensure_network()
    assert fake.starts == 1                                     # çalışıyorsa dokunulmaz


def test_user_proxy_disables_warp(cfg):
    assert Updater(replace(cfg, proxy="http://kendi:1")).warp is None
    assert Updater(replace(cfg, warp=False)).warp is None
    assert isinstance(Updater(cfg).warp, Warp)


# ---------------------------------------------------------------------------
# Warp modülü
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("system", "machine", "expected"),
    [
        ("Linux", "x86_64", ("linux", "amd64", "amd64")),
        ("Linux", "aarch64", ("linux", "arm64", "arm64")),
        ("Linux", "armv7l", ("linux", "armv7", "arm")),
        ("Windows", "AMD64", ("windows", "amd64", "amd64")),
    ],
)
def test_platform_mapping(monkeypatch, system, machine, expected):
    monkeypatch.setattr(warp_mod.platform, "system", lambda: system)
    monkeypatch.setattr(warp_mod.platform, "machine", lambda: machine)
    assert _platform() == expected


def test_unsupported_platform(monkeypatch):
    monkeypatch.setattr(warp_mod.platform, "machine", lambda: "sparc")
    with pytest.raises(WarpError):
        _platform()


def test_parse_trace():
    info = parse_trace("fl=1\nip=2a09:bac5::1\nloc=TR\nwarp=on\n")
    assert info["ip"] == "2a09:bac5::1" and info["warp"] == "on"


async def test_profile_registration_and_fresh_identity(tmp_path, monkeypatch):
    w = Warp(tmp_path / "warp")
    w.dir.mkdir()
    calls: list[str] = []

    async def run(*args, timeout=60):
        calls.append(args[1])
        if args[1] == "register":
            (w.dir / "wgcf-account.toml").write_text("hesap")
        else:
            (w.dir / "wgcf-profile.conf").write_text("[Interface]\nPrivateKey = x\n[Peer]\nEndpoint = e:2408\n")
        return ""

    monkeypatch.setattr(w, "_run", run)
    await w.ensure_profile()
    conf = (w.dir / "wireproxy.conf").read_text()
    assert calls == ["register", "generate"]
    assert "[http]" in conf and "BindAddress = 127.0.0.1:25345" in conf and "[Peer]" in conf
    await w.ensure_profile()
    assert calls == ["register", "generate"]                    # mevcut kimlik yeniden kullanılır
    await w.ensure_profile(fresh=True)
    assert calls == ["register", "generate", "register", "generate"]


def test_binary_names(tmp_path):
    w = Warp(Path(tmp_path))
    assert w._bin("wgcf").parent == tmp_path / "bin"
    assert w.proxy_url == "http://127.0.0.1:25345"
    assert STRATEGIES["default"] == []
