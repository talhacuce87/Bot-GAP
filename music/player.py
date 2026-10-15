"""
music/player.py — Sunucu başına müzik çalar: kuyruk, geçmiş, sarma, tekrar modları, ses düzeyi.

Her sunucunun tek bir GuildPlayer'ı ve onu süren tek bir arka plan görevi vardır.
Ses discord.py'nin FFmpeg kaynağıyla çalınır; FFmpeg kopan bağlantıyı kendisi
yeniden kurar (-reconnect). Akış hemen koparsa (süresi dolmuş link vb.) parça
taze bir linkle bir kez daha denenir. İleri/geri sarma FFmpeg'i aynı parça için
`-ss <saniye>` ile yeniden başlatarak yapılır.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import deque
from typing import TYPE_CHECKING

import discord

import activitylog
from music import card, ytdl
from music.sources import SourceError
from music.ytdl import Track, format_time

if TYPE_CHECKING:
    from music.cog import MusicCog

__all__ = ["GuildPlayer", "LOOP_LABELS", "LOOP_MODES", "format_time"]

log = logging.getLogger("gap.music.player")

FFMPEG_BEFORE = "-nostdin -reconnect 1 -reconnect_streamed 1 -reconnect_on_network_error 1 -reconnect_delay_max 5"
FFMPEG_OPTIONS = "-vn"
# Bundan kısa süren çalma (sn) akış hatası sayılır ve parça bir kez daha denenir
EARLY_FAILURE_SECONDS = 5
# ⏮️: şarkının ilk bu kadar saniyesindeyse önceki şarkıya, sonrasındaysa başa döner
PREVIOUS_THRESHOLD = 5
SEEK_STEP = 10
HISTORY_SIZE = 50

LOOP_MODES = ("off", "track", "queue")
LOOP_LABELS = {"off": "Kapalı", "track": "🔂 Şarkı", "queue": "🔁 Liste"}


class GuildPlayer:
    def __init__(self, cog: MusicCog, guild: discord.Guild, text_channel: discord.abc.Messageable) -> None:
        self.cog = cog
        self.guild = guild
        self.text_channel = text_channel
        self.queue: deque[Track] = deque()
        self.history: deque[Track] = deque(maxlen=HISTORY_SIZE)
        self.current: Track | None = None
        self.loop_mode = "off"
        self.volume = cog.cfg.default_volume / 100
        self.voice: discord.VoiceClient | None = None
        # Son "şimdi çalıyor" mesajı, gösterdiği parça ve kart eklenip eklenemediği
        self.now_message: discord.Message | None = None
        self.now_track: Track | None = None
        self.now_has_card = False

        self._wakeup = asyncio.Event()
        self._track_done = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._skipped = False
        self._go_back = False
        self._seek_to: float | None = None
        self._closing = False
        self._offset = 0.0
        self._started_at = 0.0
        self._paused_at: float | None = None
        self._paused_total = 0.0

    # ------------------------------------------------------------------
    # Durum
    # ------------------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        return self.voice is not None and self.voice.is_connected()

    @property
    def is_paused(self) -> bool:
        return self.voice is not None and self.voice.is_paused()

    @property
    def is_active(self) -> bool:
        return self.voice is not None and (self.voice.is_playing() or self.voice.is_paused())

    @property
    def channel(self) -> discord.VoiceChannel | None:
        return self.voice.channel if self.voice else None

    @property
    def elapsed(self) -> float:
        """Parçanın neresinde olduğumuz (sn), sarmalar dahil."""
        if not self.current or not self._started_at:
            return 0.0
        paused = self._paused_total + (time.monotonic() - self._paused_at if self._paused_at else 0.0)
        return self._offset + time.monotonic() - self._started_at - paused

    # ------------------------------------------------------------------
    # Bağlantı & kuyruk
    # ------------------------------------------------------------------

    async def connect(self, channel: discord.VoiceChannel) -> None:
        if self.is_connected:
            if self.voice.channel != channel:
                await self.voice.move_to(channel)
            return
        self.voice = await channel.connect(self_deaf=True, timeout=20, reconnect=True)

    def add(self, tracks: list[Track]) -> int:
        room = max(0, self.cog.cfg.max_queue - len(self.queue))
        added = tracks[:room]
        self.queue.extend(added)
        if added:
            self._wakeup.set()
        return len(added)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._closing = False
            self._task = asyncio.create_task(self._run(), name=f"music-{self.guild.id}")

    def skip(self) -> bool:
        if not self.is_active:
            return False
        self._skipped = True
        self.voice.stop()
        return True

    def previous(self) -> str:
        """⏮️ davranışı. Döner: 'restart' (başa sardı) | 'previous' (önceki şarkı) | 'none'."""
        if not self.is_active or not self.current:
            return "none"
        if self.elapsed > PREVIOUS_THRESHOLD or not self.history:
            return "restart" if self.seek(0) else "none"
        self._go_back = True
        self._skipped = True
        self.voice.stop()
        return "previous"

    def seek(self, position: float) -> bool:
        """Çalan parçada verilen saniyeye atlar. Parçanın sonunu geçiyorsa sıradakine geçer."""
        if not self.is_active or not self.current:
            return False
        position = max(0.0, position)
        duration = self.current.duration
        if duration and position >= duration - 1:
            return self.skip()
        self._seek_to = position
        self.voice.stop()
        return True

    def seek_relative(self, delta: float) -> float | None:
        """İleri (+) / geri (-) sarar; yeni konumu döner (sıradakine geçildiyse ya da çalmıyorsa None)."""
        if not self.current:
            return None
        target = max(0.0, self.elapsed + delta)
        duration = self.current.duration
        if not self.seek(target) or (duration and target >= duration - 1):
            return None
        return target

    def pause(self) -> bool:
        if self.voice and self.voice.is_playing():
            self.voice.pause()
            self._paused_at = time.monotonic()
            return True
        return False

    def resume(self) -> bool:
        if self.voice and self.voice.is_paused():
            self.voice.resume()
            if self._paused_at:
                self._paused_total += time.monotonic() - self._paused_at
            self._paused_at = None
            return True
        return False

    def set_volume(self, percent: int) -> None:
        self.volume = max(0, min(100, percent)) / 100
        source = self.voice.source if self.voice else None
        if isinstance(source, discord.PCMVolumeTransformer):
            source.volume = self.volume

    def cycle_loop(self) -> str:
        self.loop_mode = LOOP_MODES[(LOOP_MODES.index(self.loop_mode) + 1) % len(LOOP_MODES)]
        return self.loop_mode

    def shuffle(self) -> None:
        items = list(self.queue)
        random.shuffle(items)
        self.queue = deque(items)

    def remove(self, index: int) -> Track | None:
        """1 tabanlı sıra numarasıyla kuyruktan siler."""
        if not 1 <= index <= len(self.queue):
            return None
        self.queue.rotate(-(index - 1))
        removed = self.queue.popleft()
        self.queue.rotate(index - 1)
        return removed

    async def stop(self) -> None:
        """Kuyruğu temizler, çalmayı durdurur ve kanaldan çıkar."""
        self._closing = True
        self.queue.clear()
        self.loop_mode = "off"
        if self.is_active:
            self._skipped = True
            self.voice.stop()
        self._wakeup.set()
        if self._task and not self._task.done() and self._task is not asyncio.current_task():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        await self._cleanup()

    # ------------------------------------------------------------------
    # Çalma döngüsü
    # ------------------------------------------------------------------

    async def _run(self) -> None:
        try:
            while not self._closing:
                track = await self._next_track()
                if track is None:
                    break
                await self._play(track)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Müzik çalar beklenmedik şekilde durdu (guild=%s)", self.guild.id)
        finally:
            if not self._closing:
                await self._cleanup()

    @staticmethod
    def _fresh(track: Track) -> Track:
        """Parça yeniden çalınacak: yeni "şimdi çalıyor" mesajı gönderilsin."""
        track.extra.pop("announced", None)
        return track

    async def _next_track(self) -> Track | None:
        previous, skipped, back = self.current, self._skipped, self._go_back
        self._skipped = self._go_back = False
        self.current = None

        if back and self.history:
            prev = self.history.pop()
            if self.queue and self.queue[-1] is prev:  # liste tekrarında sona eklenmişti
                self.queue.pop()
            if previous:
                self.queue.appendleft(self._fresh(previous))
            return self._fresh(prev)

        if previous and self.loop_mode == "track" and not skipped:
            self.current = previous
            return previous
        if previous:
            self.history.append(previous)
            if self.loop_mode == "queue":
                previous.stream_url = None  # sırası gelince taze link alınsın
                self.queue.append(self._fresh(previous))

        while not self.queue:
            self._wakeup.clear()
            try:
                await asyncio.wait_for(self._wakeup.wait(), timeout=self.cog.cfg.idle_timeout)
            except asyncio.TimeoutError:
                await self._say("💤 Bir süredir bir şey çalmıyor, kanaldan çıkıyorum.")
                return None
            if self._closing:
                return None
        return self.queue.popleft()

    async def _play(self, track: Track) -> None:
        self.current = track
        start_at, retried = 0.0, False
        while True:
            try:
                stream_url = await self.cog.sources.stream_for(track)
            except SourceError as exc:
                await self._say(f"⚠️ **{discord.utils.escape_markdown(track.display)}** çalınamadı: {exc} Sıradakine geçiyorum.")
                return
            if not self.is_connected or self._closing:
                return

            played, error = await self._stream(track, stream_url, start_at)
            if self._closing:
                return
            if self._seek_to is not None:
                start_at, self._seek_to = self._seek_to, None
                self._skipped = False
                continue
            if error:
                log.warning("Çalma hatası (%s): %s", track.display, error)
            # Akış hemen koptuysa (link süresi dolmuş / geçici hata) taze linkle bir kez daha dene
            remaining = (track.duration or 0) - start_at
            if not retried and not self._skipped and played < EARLY_FAILURE_SECONDS and (
                error or remaining > EARLY_FAILURE_SECONDS
            ):
                log.info("Akış erken bitti (%.1f sn), yeniden deneniyor: %s", played, track.display)
                retried = True
                track.stream_url = None
                continue
            return

    async def _stream(self, track: Track, stream_url: str, start_at: float) -> tuple[float, Exception | None]:
        """Parçayı start_at saniyesinden çalar, bitmesini bekler. Döner: (çalınan süre, hata)."""
        before = FFMPEG_BEFORE + ytdl.ffmpeg_input_options(track.user_agent) + (f" -ss {start_at:.2f}" if start_at else "")
        source = discord.PCMVolumeTransformer(
            discord.FFmpegPCMAudio(stream_url, executable=self.cog.ffmpeg, before_options=before, options=FFMPEG_OPTIONS),
            volume=self.volume,
        )
        loop = asyncio.get_running_loop()
        self._track_done.clear()
        play_error: list[Exception] = []

        def after(error: Exception | None) -> None:
            if error:
                play_error.append(error)
            loop.call_soon_threadsafe(self._track_done.set)

        was_paused = self._paused_at is not None
        self._offset = start_at
        self._started_at = time.monotonic()
        self._paused_at = None
        self._paused_total = 0.0
        self.voice.play(source, after=after)

        if track.extra.get("announced") is None:
            track.extra["announced"] = True
            await self.send_now_playing()
            activitylog.record(
                "music_play", self.guild.id, track.requester_id,
                channel_id=self.channel.id if self.channel else None,
                title=track.display[:150], source=track.source, fallback=track.fallback,
            )
        elif was_paused:
            await self.refresh_controls()  # duraklatılmışken sarıldı; artık çalıyor
        prefetch = asyncio.create_task(self._prefetch_next())

        await self._track_done.wait()
        prefetch.cancel()
        return self.elapsed - start_at, (play_error[0] if play_error else None)

    async def _prefetch_next(self) -> None:
        """Sıradaki parçanın ses linkini önceden hazırla ki geçiş beklemesin."""
        await asyncio.sleep(3)
        if self.queue:
            nxt = self.queue[0]
            try:
                await self.cog.sources.stream_for(nxt)
            except Exception:
                pass  # çalma sırası gelince tekrar denenecek

    # ------------------------------------------------------------------
    # Mesajlar
    # ------------------------------------------------------------------

    async def _say(self, text: str) -> None:
        try:
            await self.text_channel.send(text)
        except discord.HTTPException:
            pass

    async def send_now_playing(self) -> None:
        """Çalan şarkının kartını ve kontrol butonlarını yeni bir mesaj olarak gönderir."""
        track = self.current
        if track is None:
            return
        await self._retire_controls()
        file = None
        try:
            cover = await card.fetch_cover(track.thumbnail)
            file = discord.File(await asyncio.to_thread(card.render_card, track, cover), filename=card.FILENAME)
        except Exception:
            log.exception("Şimdi çalıyor kartı çizilemedi: %s", track.display)
        self.now_track, self.now_has_card = track, file is not None
        try:
            kwargs = {"file": file} if file else {}
            self.now_message = await self.text_channel.send(
                view=self.cog.now_playing_view(self), allowed_mentions=discord.AllowedMentions.none(), **kwargs,
            )
        except discord.HTTPException:
            log.exception("Şimdi çalıyor mesajı gönderilemedi")
            self.now_message = None

    async def refresh_controls(self) -> None:
        """Butonları ve yazıyı güncel duruma (duraklatıldı, tekrar modu…) getirir."""
        if self.now_message is None or self.now_track is None:
            return
        try:
            await self.now_message.edit(view=self.cog.now_playing_view(self), allowed_mentions=discord.AllowedMentions.none())
        except discord.HTTPException:
            pass

    async def _retire_controls(self) -> None:
        """Eski "şimdi çalıyor" mesajındaki butonları kaldırır (kart ve yazı kalır)."""
        if self.now_message is not None:
            message, self.now_message = self.now_message, None
            try:
                await message.edit(view=self.cog.now_playing_view(self, finished=True))
            except discord.HTTPException:
                pass

    # ------------------------------------------------------------------
    # Temizlik
    # ------------------------------------------------------------------

    async def _cleanup(self) -> None:
        self._closing = True
        await self._retire_controls()
        self.current = None
        self.queue.clear()
        self.history.clear()
        if self.voice is not None:
            try:
                await self.voice.disconnect(force=True)
            except Exception:
                pass
            self.voice = None
        self.cog.forget(self.guild.id, self)
