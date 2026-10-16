"""
music/updater.py — YouTube çalmayı kendi kendine onaran güncelleyici.

YouTube sık sık değişir; yt-dlp ekibi de genelde saatler/günler içinde düzeltme
yayınlar. Bu modül:
- açılışta ve günde bir yt-dlp / yt-dlp-ejs / deno'yu pip ile günceller,
- YouTube hata verdiğinde önce farklı bağlantı yöntemlerini (IPv4, farklı YouTube
  istemcileri) dener; olmazsa kararlı, sonra nightly sürüme güncelleyip tekrar dener,
- çalışan yöntemi hatırlar ve sonraki tüm çağrılarda onu kullanır,
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
from music.warp import Warp

log = logging.getLogger("gap.music.updater")

PACKAGES = ["yt-dlp[default]", "yt-dlp-ejs", "deno"]
PIP_TIMEOUT = 600
# Hata kaynaklı güncellemeler en fazla bu sıklıkta denenir (YouTube'u/PyPI'yi yormamak için)
HEAL_COOLDOWN = 30 * 60
DAILY = 24 * 3600

# Bu hatalar içerikle ilgilidir (video silinmiş, yaş sınırlı…); güncelleme çözmez.
CONTENT_ERRORS = {"unavailable", "age", "live"}

# YouTube sunucu IP'sini "bot" diye işaretlediğinde sırayla denenen bağlantı yöntemleri.
# Engel çoğu zaman IPv6 adresine ya da belirli bir YouTube istemcisine (player client) özgüdür.
STRATEGIES: dict[str, list[str]] = {
    "default": [],
    "ipv4": ["--force-ipv4"],
    "tv": ["--force-ipv4", "--extractor-args", "youtube:player_client=tv,web_safari"],
    "mweb": ["--force-ipv4", "--extractor-args", "youtube:player_client=mweb,tv_simply"],
    "embedded": ["--force-ipv4", "--extractor-args", "youtube:player_client=web_embedded,tv_embedded"],
    "android_vr": ["--force-ipv4", "--extractor-args", "youtube:player_client=android_vr"],
}


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
    strategy: str = "default"
    route: str = "direct"  # direct | warp


# Engelli bir yolda (WARP'a geçince, yeni kimlikte) denenen en fazla yöntem sayısı
ROUTE_STRATEGY_LIMIT = 3


class Updater:
    def __init__(self, cfg: MusicConfig) -> None:
        self.cfg = cfg
        self.state = self._load(cfg.state_path)
        self._lock = asyncio.Lock()
        if self.state.strategy not in STRATEGIES:
            self.state.strategy = "default"
        self._apply(self.state.strategy)
        # Kullanıcı kendi proxy'sini verdiyse WARP devre dışı (onun proxy'si kullanılır)
        self.warp = Warp(cfg.state_path.parent / "warp") if cfg.warp and not cfg.proxy else None
        if self.warp is None:
            self.state.route = "direct"

    # ------------------------------------------------------------------
    # Ağ yolu: doğrudan ya da Cloudflare WARP
    # ------------------------------------------------------------------

    async def start_network(self) -> None:
        """Açılışta: kayıtlı yol WARP ise başlatır; başlamazsa doğrudan bağlantıya döner."""
        if self.state.route == "warp" and not await self._use_route("warp"):
            log.warning("WARP başlatılamadı, doğrudan bağlantıyla devam ediliyor")
            await self._use_route("direct")

    async def ensure_network(self) -> None:
        """WARP kullanılıyorsa ve süreç kapanmışsa yeniden başlatır."""
        if self.state.route == "warp" and self.warp is not None and not self.warp.running:
            log.warning("WARP süreci kapanmış, yeniden başlatılıyor")
            await self._use_route("warp")

    async def _use_route(self, route: str, *, fresh: bool = False) -> bool:
        if route == "warp":
            if self.warp is None:
                return False
            if fresh:
                ok = await self.warp.rotate()
            else:
                ok = self.warp.running or await self.warp.start()
            if not ok:
                return False
            ytdl.configure_network(proxy=self.warp.proxy_url)
            return True
        ytdl.configure_network(proxy=self.cfg.proxy)
        if self.warp is not None:
            await self.warp.stop()
        return True

    async def _try_other_routes(self) -> tuple[bool, str, str]:
        """
        Mevcut yol başarısızken: doğrudan bağlantıdaysak WARP'ı (olmazsa yeni WARP kimliğini),
        WARP'taysak yeni WARP kimliğini, sonra doğrudan bağlantıyı dener.
        """
        original = self.state.route
        if original == "direct":
            attempts = [("warp", False), ("warp", True)]
        else:
            attempts = [("warp", True), ("direct", False)]
        best = (False, "", "")
        for route, fresh in attempts:
            if not await self._use_route(route, fresh=fresh):
                best = best if best[1] else (False, "warp", self.warp.last_error if self.warp else "")
                continue
            ok, kind, err = await self.try_strategies(limit=ROUTE_STRATEGY_LIMIT)
            if ok:
                if route != original or fresh:
                    log.warning("YouTube engeli %s ile aşıldı", "yeni WARP kimliği" if fresh else route)
                self.state.route = route
                self.save()
                return True, "", ""
            if kind == "blocked" or not best[1] or best[1] == "warp":
                best = (False, kind, err)
        await self._use_route(original)
        return best

    @staticmethod
    def _apply(strategy: str) -> None:
        ytdl.configure_network(strategy_args=STRATEGIES[strategy])

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
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **ytdl.NO_WINDOW,
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
            info = await ytdl.extract_stream(self.cfg.healthcheck_url, cookies_file=self.cfg.cookies_file)
        except ytdl.YtdlError as exc:
            return False, exc.kind, str(exc)
        if error := await ytdl.wait_until_playable(info["url"], ytdl.user_agent_of(info)):
            return False, "stream", f"yt-dlp link verdi ama ses akışı açılmıyor ({error})"
        return True, "", ""

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

    def mark_failing(self, kind: str, error: str) -> None:
        """Gerçek bir şarkı açılmadı: sonraki şarkılar YouTube'da oyalanmadan yedeğe geçsin."""
        if self.state.health_ok:
            log.warning("YouTube şarkıda başarısız oldu, sorunlu sayılıyor: %s %s", kind, error[:150])
        self._record_health(False, kind, error)

    def can_heal(self) -> bool:
        return time.time() - self.state.last_heal_ts >= HEAL_COOLDOWN

    def strategy_order(self) -> list[str]:
        """Şu an kullanılan yöntem önce, sonra diğerleri."""
        current = self.state.strategy
        return [current] + [name for name in STRATEGIES if name != current]

    async def try_strategies(self, *, skip_current: bool = False, limit: int | None = None) -> tuple[bool, str, str]:
        """
        Bağlantı yöntemlerini sırayla dener (önce şu anki). Çalışan bulunursa onu
        kaydeder ve kullanmaya başlar; bulunamazsa eskisinde kalır.
        Döner: (çalışıyor mu, son hata türü, son hata mesajı).
        """
        current = self.state.strategy
        order = self.strategy_order()
        if skip_current:
            order = order[1:]
        if limit is not None:
            order = order[:limit]
        kind = err = ""
        blocked = ""
        for name in order:
            self._apply(name)
            ok, kind, err = await self.check_youtube()
            if kind == "blocked":
                blocked = err  # en açıklayıcı hata: IP engeli (diğer yöntemlerin hatası bunu gizlemesin)
            if ok:
                if name != current:
                    log.warning("YouTube engeli '%s' bağlantı yöntemiyle aşıldı (önceki: %s)", name, current)
                    self.state.strategy = name
                    self.save()
                return True, "", ""
            log.info("Bağlantı yöntemi '%s' çalışmadı: %s %s", name, kind, err[:150])
        self._apply(current)
        return (False, "blocked", blocked) if blocked else (False, kind, err)

    async def heal(self, reason: str, *, force: bool = False) -> bool:
        """
        YouTube'u onarmayı dener: diğer bağlantı yöntemleri → Cloudflare WARP (gerekirse yeni
        kimlikle) → kararlı güncelleme → nightly güncelleme (her güncellemeden sonra yöntemler
        yeniden denenir).
        Döner: YouTube şu an çalışıyor mu.
        """
        async with self._lock:
            ok, kind, err = await self.check_youtube()
            if ok:
                self._record_health(True)
                return True
            if not force and time.time() - self.state.last_heal_ts < HEAL_COOLDOWN:
                self._record_health(False, kind, err)
                return False

            self.state.last_heal_ts = time.time()
            log.warning("YouTube çalışmıyor (%s: %s) — onarım deneniyor (%s)", kind, err, reason)
            ok, kind, err = await self.try_strategies(skip_current=True)
            if ok:
                self._record_health(True)
                return True
            if self.warp is not None:
                ok, route_kind, route_err = await self._try_other_routes()
                if ok:
                    self._record_health(True)
                    return True
                if route_kind and kind != "blocked":
                    kind, err = route_kind, route_err
            if self.cfg.auto_update:
                for pre in (False, True):
                    changed = await self.update(pre=pre, reason=reason)
                    ok, kind, err = await (self.try_strategies() if changed else self.check_youtube())
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
