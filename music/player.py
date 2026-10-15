"""
music/player.py — Sunucu başına müzik çalar: kuyruk, tekrar modları, ses düzeyi.

Her sunucunun tek bir GuildPlayer'ı ve onu süren tek bir arka plan görevi vardır.
Ses discord.py'nin FFmpeg kaynağıyla çalınır; FFmpeg kopan bağlantıyı kendisi
yeniden kurar (-reconnect). Akış hemen koparsa (süresi dolmuş link vb.) parça
taze bir linkle bir kez daha denenir.
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
from music.sources import SourceError
from music.ytdl import Track

if TYPE_CHECKING:
    from music.cog import MusicCog

log = logging.getLogger("gap.music.player")

FFMPEG_BEFORE = "-nostdin -reconnect 1 -reconnect_streamed 1 -reconnect_on_network_error 1 -reconnect_delay_max 5"
FFMPEG_OPTIONS = "-vn"
# Bundan kısa süren çalma (sn) akış hatası sayılır ve parça bir kez daha denenir
EARLY_FAILURE_SECONDS = 5

LOOP_MODES = ("off", "track", "queue")
LOOP_LABELS = {"off": "Kapalı", "track": "🔂 Şarkı", "queue": "🔁 Kuyruk"}


def format_time(seconds: float | int | None) -> str:
    if seconds is None:
        return "?"
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


class GuildPlayer:
    def __init__(self, cog: MusicCog, guild: discord.Guild, text_channel: discord.abc.Messageable) -> None:
        self.cog = cog
        self.guild = guild
        self.text_channel = text_channel
        self.queue: deque[Track] = deque()
        self.current: Track | None = None
        self.loop_mode = "off"
        self.volume = cog.cfg.default_volume / 100
        self.voice: discord.VoiceClient | None = None
        self.now_message: discord.Message | None = None

        self._wakeup = asyncio.Event()
        self._track_done = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._skipped = False
        self._closing = False
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
    def channel(self) -> discord.VoiceChannel | None:
        return self.voice.channel if self.voice else None

    @property
    def elapsed(self) -> float:
        if not self.current or not self._started_at:
            return 0.0
        paused = self._paused_total + (time.monotonic() - self._paused_at if self._paused_at else 0.0)
        return time.monotonic() - self._started_at - paused

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
        if not self.voice or not (self.voice.is_playing() or self.voice.is_paused()):
            return False
        self._skipped = True
        self.voice.stop()
        return True

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
        if self.voice and (self.voice.is_playing() or self.voice.is_paused()):
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

    async def _next_track(self) -> Track | None:
        previous, skipped = self.current, self._skipped
        self._skipped = False
        if previous and self.loop_mode == "track" and not skipped:
            return previous
        if previous and self.loop_mode == "queue":
            previous.stream_url = None  # sırası gelince taze link alınsın
            previous.extra.pop("announced", None)
            self.queue.append(previous)
        self.current = None

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

    async def _play(self, track: Track, *, retry: bool = True) -> None:
        self.current = track
        try:
            stream_url = await self.cog.sources.stream_for(track)
        except SourceError as exc:
            await self._say(f"⚠️ **{discord.utils.escape_markdown(track.display)}** çalınamadı: {exc} Sıradakine geçiyorum.")
            return
        if not self.is_connected or self._closing:
            return

        source = discord.PCMVolumeTransformer(
            discord.FFmpegPCMAudio(stream_url, executable=self.cog.ffmpeg, before_options=FFMPEG_BEFORE, options=FFMPEG_OPTIONS),
            volume=self.volume,
        )
        loop = asyncio.get_running_loop()
        self._track_done.clear()
        play_error: list[Exception] = []

        def after(error: Exception | None) -> None:
            if error:
                play_error.append(error)
            loop.call_soon_threadsafe(self._track_done.set)

        self._started_at = time.monotonic()
        self._paused_at = None
        self._paused_total = 0.0
        self.voice.play(source, after=after)

        if track.extra.get("announced") is None:
            track.extra["announced"] = True
            await self._send_now_playing(track)
        activitylog.record(
            "music_play", self.guild.id, track.requester_id,
            channel_id=self.channel.id if self.channel else None,
            title=track.display[:150], source=track.source, fallback=track.fallback,
        )
        prefetch = asyncio.create_task(self._prefetch_next())

        await self._track_done.wait()
        prefetch.cancel()
        played = self.elapsed

        if play_error:
            log.warning("Çalma hatası (%s): %s", track.display, play_error[0])
        # Akış hemen koptuysa (link süresi dolmuş / geçici hata) taze linkle bir kez daha dene
        if retry and not self._skipped and not self._closing and played < EARLY_FAILURE_SECONDS and (
            play_error or (track.duration or 0) > EARLY_FAILURE_SECONDS
        ):
            log.info("Akış erken bitti (%.1f sn), yeniden deneniyor: %s", played, track.display)
            track.stream_url = None
            await self._play(track, retry=False)

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

    def now_playing_embed(self, track: Track, *, with_progress: bool = False) -> discord.Embed:
        title = discord.utils.escape_markdown(track.display)
        embed = discord.Embed(
            title="🎵 Şimdi çalıyor",
            description=f"**[{title}]({track.url})**" if track.url else f"**{title}**",
            color=discord.Color.from_rgb(0, 212, 255),
        )
        if with_progress and track.duration:
            ratio = min(1.0, self.elapsed / track.duration)
            bar = "▬" * int(ratio * 14) + "🔘" + "▬" * (14 - int(ratio * 14))
            embed.add_field(name="İlerleme", value=f"`{format_time(self.elapsed)}` {bar} `{format_time(track.duration)}`", inline=False)
        else:
            embed.add_field(name="Süre", value=format_time(track.duration), inline=True)
        embed.add_field(name="İsteyen", value=f"<@{track.requester_id}>", inline=True)
        if self.loop_mode != "off":
            embed.add_field(name="Tekrar", value=LOOP_LABELS[self.loop_mode], inline=True)
        if self.queue:
            nxt = discord.utils.escape_markdown(self.queue[0].display)
            embed.add_field(name=f"Sırada ({len(self.queue)})", value=nxt[:100], inline=False)
        footer = {"spotify": "Spotify linki · YouTube'dan çalınıyor", "soundcloud": "SoundCloud"}.get(track.source)
        if track.fallback == "soundcloud":
            footer = "YouTube şu an erişilemiyor · SoundCloud'dan çalınıyor"
        if footer:
            embed.set_footer(text=footer)
        if track.thumbnail:
            embed.set_thumbnail(url=track.thumbnail)
        return embed

    async def _send_now_playing(self, track: Track) -> None:
        await self._retire_controls()
        try:
            self.now_message = await self.text_channel.send(
                embed=self.now_playing_embed(track), view=self.cog.controls_view(self),
            )
        except discord.HTTPException:
            self.now_message = None

    async def _retire_controls(self) -> None:
        """Eski "şimdi çalıyor" mesajındaki butonları kaldır."""
        if self.now_message is not None:
            try:
                await self.now_message.edit(view=None)
            except discord.HTTPException:
                pass
            self.now_message = None

    # ------------------------------------------------------------------
    # Temizlik
    # ------------------------------------------------------------------

    async def _cleanup(self) -> None:
        self._closing = True
        self.current = None
        self.queue.clear()
        await self._retire_controls()
        if self.voice is not None:
            try:
                await self.voice.disconnect(force=True)
            except Exception:
                pass
            self.voice = None
        self.cog.forget(self.guild.id, self)
