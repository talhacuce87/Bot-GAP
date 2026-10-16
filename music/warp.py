"""
music/warp.py — Cloudflare WARP üzerinden çıkış (YouTube/SoundCloud sunucu IP'sini engellediğinde).

Sunucu IP'leri (veri merkezi) YouTube'da sık sık "bot" diye işaretlenir. WARP, Cloudflare'in
ücretsiz VPN'idir; hesap ya da ödeme gerektirmez. Bot:
- wgcf ile ücretsiz bir WARP kimliği alır (WireGuard profili),
- wireproxy ile bu profili yerel bir HTTP proxy olarak açar (kullanıcı alanında çalışır;
  root, NET_ADMIN ya da /dev/net/tun gerekmez),
- yt-dlp ve FFmpeg trafiğini bu proxy'den geçirir (bkz. updater.py),
- WARP IP'si de işaretlenirse kimliği yenileyip yeni bir IP alır.

İki program da sabit sürümle GitHub'dan bir kez indirilir ve data/warp/ altında saklanır.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import platform
import shutil
import stat
import tarfile
from pathlib import Path

import aiohttp

from music.ytdl import NO_WINDOW

log = logging.getLogger("gap.music.warp")

WGCF_VERSION = "2.3.1"
WIREPROXY_VERSION = "1.1.3"
WGCF_URL = "https://github.com/ViRb3/wgcf/releases/download/v{v}/wgcf_{v}_{os}_{arch}{ext}"
WIREPROXY_URL = "https://github.com/windtf/wireproxy/releases/download/v{v}/wireproxy_{os}_{arch}.tar.gz"
TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace"
DEFAULT_PORT = 25345
START_TIMEOUT = 20


class WarpError(Exception):
    pass


def _platform() -> tuple[str, str, str]:
    """(işletim sistemi, wgcf mimarisi, wireproxy mimarisi)."""
    system = platform.system().lower()
    machine = platform.machine().lower()
    if machine in {"x86_64", "amd64"}:
        return system, "amd64", "amd64"
    if machine in {"aarch64", "arm64"}:
        return system, "arm64", "arm64"
    if machine.startswith("armv7") or machine.startswith("armv6"):
        return system, "armv7" if machine.startswith("armv7") else "armv6", "arm"
    if machine in {"i386", "i686", "x86"}:
        return system, "386", "386"
    raise WarpError(f"Desteklenmeyen işlemci: {machine}")


def parse_trace(text: str) -> dict[str, str]:
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


class Warp:
    def __init__(self, directory: Path, port: int = DEFAULT_PORT) -> None:
        self.dir = directory
        self.port = port
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self.last_ip = ""
        self.last_error = ""

    @property
    def proxy_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    # ------------------------------------------------------------------
    # Kurulum
    # ------------------------------------------------------------------

    def _bin(self, name: str) -> Path:
        return self.dir / "bin" / (name + (".exe" if os.name == "nt" else ""))

    async def _download(self, url: str) -> bytes:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120)) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    raise WarpError(f"İndirilemedi ({resp.status}): {url}")
                return await resp.read()

    async def ensure_binaries(self) -> None:
        system, wgcf_arch, wp_arch = _platform()
        (self.dir / "bin").mkdir(parents=True, exist_ok=True)
        wgcf = self._bin("wgcf")
        if not wgcf.exists():
            ext = ".exe" if system == "windows" else ""
            url = WGCF_URL.format(v=WGCF_VERSION, os=system, arch=wgcf_arch, ext=ext)
            log.info("wgcf indiriliyor: %s", url)
            wgcf.write_bytes(await self._download(url))
            wgcf.chmod(wgcf.stat().st_mode | stat.S_IEXEC)
        wireproxy = self._bin("wireproxy")
        if not wireproxy.exists():
            url = WIREPROXY_URL.format(v=WIREPROXY_VERSION, os=system, arch=wp_arch)
            log.info("wireproxy indiriliyor: %s", url)
            data = await self._download(url)
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                member = next((m for m in tar.getmembers() if Path(m.name).name.startswith("wireproxy") and m.isfile()), None)
                if member is None:
                    raise WarpError("wireproxy arşivinde program bulunamadı")
                wireproxy.write_bytes(tar.extractfile(member).read())
            wireproxy.chmod(wireproxy.stat().st_mode | stat.S_IEXEC)

    async def _run(self, *args: str, timeout: float = 60) -> str:
        proc = await asyncio.create_subprocess_exec(
            *args, cwd=self.dir, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, **NO_WINDOW,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise WarpError(f"{Path(args[0]).name} {timeout:g} sn içinde bitmedi")
        text = out.decode("utf-8", "replace")
        if proc.returncode != 0:
            raise WarpError(f"{Path(args[0]).name} {' '.join(args[1:])} başarısız: {text.strip()[-300:]}")
        return text

    async def ensure_profile(self, *, fresh: bool = False) -> None:
        """WARP kimliği ve wireproxy ayarı. fresh=True: yeni kimlik (yeni IP) alınır."""
        account, profile = self.dir / "wgcf-account.toml", self.dir / "wgcf-profile.conf"
        if fresh:
            account.unlink(missing_ok=True)
            profile.unlink(missing_ok=True)
        if not account.exists():
            await self._run(str(self._bin("wgcf")), "register", "--accept-tos")
        if not profile.exists():
            await self._run(str(self._bin("wgcf")), "generate")
        conf = profile.read_text(encoding="utf-8").rstrip() + f"\n\n[http]\nBindAddress = 127.0.0.1:{self.port}\n"
        (self.dir / "wireproxy.conf").write_text(conf, encoding="utf-8")

    # ------------------------------------------------------------------
    # Çalıştırma
    # ------------------------------------------------------------------

    async def trace(self) -> dict[str, str]:
        """WARP üzerinden Cloudflare'e sorar: çıkış IP'si ve warp=on/off."""
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            async with session.get(TRACE_URL, proxy=self.proxy_url) as resp:
                return parse_trace(await resp.text())

    async def start(self, *, fresh: bool = False) -> bool:
        """WARP proxy'sini hazırlar ve çalıştırır. Döner: çalışıyor mu (warp=on)."""
        async with self._lock:
            try:
                await self._stop()
                self.dir.mkdir(parents=True, exist_ok=True)
                await self.ensure_binaries()
                await self.ensure_profile(fresh=fresh)
                log_file = open(self.dir / "wireproxy.log", "ab")
                try:
                    self._proc = await asyncio.create_subprocess_exec(
                        str(self._bin("wireproxy")), "-c", str(self.dir / "wireproxy.conf"),
                        cwd=self.dir, stdout=log_file, stderr=log_file, **NO_WINDOW,
                    )
                finally:
                    log_file.close()
                loop = asyncio.get_running_loop()
                deadline = loop.time() + START_TIMEOUT
                while loop.time() < deadline:
                    if not self.running:
                        raise WarpError("wireproxy hemen kapandı (data/warp/wireproxy.log)")
                    try:
                        info = await self.trace()
                    except (aiohttp.ClientError, TimeoutError):
                        await asyncio.sleep(1)
                        continue
                    if info.get("warp") in {"on", "plus"}:
                        self.last_ip, self.last_error = info.get("ip", ""), ""
                        log.info("WARP hazır (çıkış IP: %s, %s)", self.last_ip, info.get("loc", "?"))
                        return True
                    raise WarpError(f"Cloudflare WARP'ı görmüyor: warp={info.get('warp')}")
                raise WarpError(f"WARP {START_TIMEOUT} sn içinde bağlanamadı")
            except (WarpError, OSError, aiohttp.ClientError, tarfile.TarError) as exc:
                self.last_error = str(exc)[:300]
                log.warning("WARP başlatılamadı: %s", exc)
                await self._stop()
                return False

    async def rotate(self) -> bool:
        """Yeni WARP kimliği (yeni çıkış IP'si) alıp yeniden başlatır."""
        log.info("WARP kimliği yenileniyor")
        return await self.start(fresh=True)

    async def _stop(self) -> None:
        if self.running:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._proc.kill()
                await self._proc.wait()
        self._proc = None

    async def stop(self) -> None:
        async with self._lock:
            await self._stop()

    def remove(self) -> None:
        """Testler için: indirilen her şeyi siler."""
        shutil.rmtree(self.dir, ignore_errors=True)
