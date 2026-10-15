"""
music/updater.py — YouTube çalmayı kendi kendine onaran güncelleyici.

YouTube sık sık değişir; yt-dlp ekibi de genelde saatler/günler içinde düzeltme
yayınlar. Bu modül:
- açılışta ve günde bir yt-dlp / yt-dlp-ejs / deno'yu pip ile günceller,
- YouTube hata verdiğinde önce kararlı sürüme, olmazsa nightly sürüme günceller
  ve tekrar dener,
- durumu data/music_state.json'a yazar (yöneticiler !muzikdurum ile görür).

yt-dlp her çağrıda ayrı süreçte çalıştığı için (ytdl.py) güncelleme bot yeniden
başlatılmadan hemen devreye girer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from music import ytdl
from music.config import MusicConfig

log = logging.getLogger("gap.music.updater")

PACKAGES = ["yt-dlp[default]", "yt-dlp-ejs", "deno"]
PIP_TIMEOUT = 600
# Hata kaynaklı güncellemeler en fazla bu sıklıkta denenir (YouTube'u/PyPI'yi yormamak için)
HEAL_COOLDOWN = 30 * 60
DAILY = 24 * 3600

# Bu hatalar içerikle ilgilidir (video silinmiş, yaş sınırlı…); güncelleme çözmez.
CONTENT_ERRORS = {"unavailable", "age", "live"}


@dataclass
class MusicState:
    last_update_ts: float = 0.0
    last_update_ok: bool = True
    last_update_msg: str = ""
    channel: str = "stable"  # stable | nightly
    last_heal_ts: float = 0.0
    health_ok: bool = True
    health_ts: float = 0.0
    health_error: str = ""
    health_kind: str = ""
    failing_since: float = 0.0
    last_alert_ts: float = 0.0


class Updater:
    def __init__(self, cfg: MusicConfig) -> None:
        self.cfg = cfg
        self.state = self._load(cfg.state_path)
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Durum
    # ------------------------------------------------------------------

    @staticmethod
    def _load(path: Path) -> MusicState:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            known = MusicState.__dataclass_fields__
            return MusicState(**{k: v for k, v in data.items() if k in known})
        except (OSError, ValueError, TypeError):
            return MusicState()

    def save(self) -> None:
        try:
            self.cfg.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.cfg.state_path.write_text(json.dumps(asdict(self.state), indent=2), encoding="utf-8")
        except OSError as exc:
            log.warning("Müzik durumu kaydedilemedi: %s", exc)

    # ------------------------------------------------------------------
    # Güncelleme
    # ------------------------------------------------------------------

    async def pip_upgrade(self, *, pre: bool = False) -> tuple[bool, str]:
        """yt-dlp ve yardımcılarını günceller. Döner: (başarılı mı, mesaj)."""
        cmd = [sys.executable, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check",
               "--no-input", "--quiet", *(["--pre"] if pre else []), *PACKAGES]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            _, err = await asyncio.wait_for(proc.communicate(), timeout=PIP_TIMEOUT)
        except (OSError, asyncio.TimeoutError) as exc:
            return False, f"pip çalıştırılamadı: {exc}"
        if proc.returncode != 0:
            return False, err.decode("utf-8", "replace").strip()[-300:] or f"pip çıkış kodu {proc.returncode}"
        return True, "ok"

    async def update(self, *, pre: bool = False, reason: str = "") -> bool:
        """Güncelleme yapar; yt-dlp sürümü değiştiyse True döner."""
        before = await ytdl.version()
        ok, msg = await self.pip_upgrade(pre=pre)
        after = await ytdl.version()
        self.state.last_update_ts = time.time()
        self.state.last_update_ok = ok
        self.state.last_update_msg = msg if not ok else f"{before} → {after}"
        if ok and pre:
            self.state.channel = "nightly"
        self.save()
        if ok:
            log.info("yt-dlp güncellendi (%s%s): %s → %s", "nightly" if pre else "kararlı",
                     f", sebep: {reason}" if reason else "", before, after)
        else:
            log.warning("yt-dlp güncellenemedi (%s): %s", reason or "rutin", msg)
        return ok and before != after

    async def routine_update(self) -> None:
        """Açılışta / günlük: kararlı sürümü güncel tut (nightly'deyse nightly'de kal)."""
        if not self.cfg.auto_update:
            return
        async with self._lock:
            await self.update(pre=self.state.channel == "nightly", reason="rutin")

    # ------------------------------------------------------------------
    # Sağlık & onarım
    # ------------------------------------------------------------------

    async def check_youtube(self) -> tuple[bool, str, str]:
        """Döner: (çalışıyor mu, hata türü, hata mesajı)."""
        try:
            await ytdl.extract_stream(self.cfg.healthcheck_url, cookies_file=self.cfg.cookies_file)
            return True, "", ""
        except ytdl.YtdlError as exc:
            return False, exc.kind, str(exc)

    def _record_health(self, ok: bool, kind: str = "", error: str = "") -> None:
        now = time.time()
        self.state.health_ts = now
        self.state.health_kind = kind
        self.state.health_error = error[:300]
        if ok:
            self.state.failing_since = 0.0
        elif self.state.health_ok or not self.state.failing_since:
            self.state.failing_since = now
        self.state.health_ok = ok
        self.save()

    async def heal(self, reason: str, *, force: bool = False) -> bool:
        """
        YouTube'u onarmayı dener: kararlı güncelleme → test → nightly → test.
        Döner: YouTube şu an çalışıyor mu.
        """
        async with self._lock:
            ok, kind, err = await self.check_youtube()
            if ok:
                self._record_health(True)
                return True
            if not self.cfg.auto_update:
                self._record_health(False, kind, err)
                return False
            if not force and time.time() - self.state.last_heal_ts < HEAL_COOLDOWN:
                self._record_health(False, kind, err)
                return False

            self.state.last_heal_ts = time.time()
            log.warning("YouTube çalışmıyor (%s: %s) — onarım deneniyor (%s)", kind, err, reason)
            for pre in (False, True):
                await self.update(pre=pre, reason=reason)
                ok, kind, err = await self.check_youtube()
                if ok:
                    log.info("YouTube onarıldı (%s güncelleme ile)", "nightly" if pre else "kararlı")
                    self._record_health(True)
                    return True
            self._record_health(False, kind, err)
            return False

    async def health_check(self) -> bool:
        ok, kind, err = await self.check_youtube()
        if ok:
            self._record_health(True)
            return True
        return await self.heal("periyodik sağlık kontrolü")

    def should_alert(self) -> bool:
        """Sorun sürüyorsa günde en fazla bir kez yöneticilere haber ver."""
        if self.state.health_ok:
            return False
        return time.time() - self.state.last_alert_ts >= DAILY

    def mark_alerted(self) -> None:
        self.state.last_alert_ts = time.time()
        self.save()
