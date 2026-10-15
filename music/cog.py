"""
music/cog.py — Müzik komutları, "şimdi çalıyor" oynatıcısı ve kendi kendini onaran arka plan görevleri.

Çalma kontrolü "şimdi çalıyor" mesajındaki butonlarla yapılır:
    ⏮️ başa sar / önceki   ⏪ 10 sn geri   ⏯️ duraklat-devam   ⏩ 10 sn ileri   ⏭️ sonraki
    🔁 tekrar   🔀 karıştır   ⏹️ bitir
Eski komutlar (!geç, !duraklat…) gizli olarak çalışmaya devam eder.
"""

from __future__ import annotations

import asyncio
import logging
import math

import discord
from discord.ext import commands, tasks

import activitylog
from music import card, ytdl
from music.config import MusicConfig
from music.player import LOOP_LABELS, SEEK_STEP, GuildPlayer, format_time
from music.sources import SourceError, SourceResolver
from music.updater import Updater
from music.ytdl import Track

log = logging.getLogger("gap.music")

QUEUE_PAGE_SIZE = 10
LOOP_ARGS = {
    "kapali": "off", "kapalı": "off", "off": "off", "kapat": "off",
    "sarki": "track", "şarkı": "track", "track": "track", "tek": "track",
    "kuyruk": "queue", "liste": "queue", "queue": "queue", "hepsi": "queue", "playlist": "queue",
}
SOURCE_NOTES = {"spotify": "Spotify → YouTube", "soundcloud": "SoundCloud"}
ACCENT = discord.Color.from_rgb(0, 212, 255)
BLOCKED_HINT = (
    "YouTube bu sunucunun IP adresini bot olarak işaretlemiş olabilir. Kalıcı çözüm: yedek bir "
    "Google hesabıyla YouTube'a girip çerezleri (cookies.txt) dışa aktar, `.env` içine "
    "`YTDLP_COOKIES_FILE=/app/data/cookies.txt` yaz ve botu yeniden başlat."
)


class MusicCog(commands.Cog):
    def __init__(self, bot: commands.Bot, cfg: MusicConfig) -> None:
        self.bot = bot
        self.cfg = cfg
        self.updater = Updater(cfg)
        self.sources = SourceResolver(cfg, self.updater)
        self.players: dict[int, GuildPlayer] = {}
        self._alone_timers: dict[int, asyncio.Task] = {}
        self._was_failing = not self.updater.state.health_ok
        self.ffmpeg = ytdl.ffmpeg_path()

    async def cog_load(self) -> None:
        self.health_loop.change_interval(hours=self.cfg.healthcheck_hours)
        self.health_loop.start()
        self.update_loop.start()

    async def cog_unload(self) -> None:
        self.health_loop.cancel()
        self.update_loop.cancel()
        for task in self._alone_timers.values():
            task.cancel()
        for player in list(self.players.values()):
            await player.stop()

    # ------------------------------------------------------------------
    # Oynatıcı yönetimi
    # ------------------------------------------------------------------

    def forget(self, guild_id: int, player: GuildPlayer) -> None:
        if self.players.get(guild_id) is player:
            del self.players[guild_id]

    def get_player(self, guild: discord.Guild) -> GuildPlayer | None:
        return self.players.get(guild.id)

    def _player_for(self, ctx: commands.Context) -> GuildPlayer:
        player = self.players.get(ctx.guild.id)
        if player is None:
            player = GuildPlayer(self, ctx.guild, ctx.channel)
            self.players[ctx.guild.id] = player
        player.text_channel = ctx.channel
        return player

    @staticmethod
    def _user_channel(member: discord.Member) -> discord.VoiceChannel | None:
        voice = member.voice
        return voice.channel if voice and voice.channel else None

    def _same_channel_error(self, member: discord.Member) -> str | None:
        """Kullanıcı botu kontrol edebilir mi? Edemiyorsa nedeni döner."""
        player = self.players.get(member.guild.id)
        channel = self._user_channel(member)
        if channel is None:
            return "Önce bir ses kanalına girmelisin."
        if player and player.is_connected and player.channel != channel:
            return f"Ben şu an {player.channel.mention} kanalındayım; orada olanlar kontrol edebilir."
        return None

    async def cog_check(self, ctx: commands.Context) -> bool:
        if ctx.guild is None:
            raise commands.NoPrivateMessage()
        return True

    async def cog_command_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        elif isinstance(error, commands.NoPrivateMessage):
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
        elif isinstance(error, (commands.BadArgument, commands.MissingRequiredArgument)) and ctx.command:
            usage = ctx.command.usage or ctx.command.signature
            await ctx.send(f"❌ Kullanım: `{ctx.prefix}{ctx.invoked_with} {usage}`")
        elif isinstance(error, commands.CommandInvokeError) and isinstance(
            error.original, (discord.ClientException, asyncio.TimeoutError, discord.ConnectionClosed),
        ):
            await ctx.send("❌ Ses kanalına bağlanamadım, birazdan tekrar dene.")

    # ------------------------------------------------------------------
    # Oynatıcı mesajı & çalma listesi
    # ------------------------------------------------------------------

    def now_playing_view(self, player: GuildPlayer, *, finished: bool = False) -> NowPlayingView:
        return NowPlayingView(self, player, finished=finished)

    def playlist_embed(self, player: GuildPlayer, page: int = 1) -> discord.Embed:
        queue = list(player.queue)
        pages = max(1, math.ceil(len(queue) / QUEUE_PAGE_SIZE))
        page = max(1, min(page, pages))
        start = (page - 1) * QUEUE_PAGE_SIZE
        esc = discord.utils.escape_markdown
        current = player.current

        parts: list[str] = []
        if page == 1 and player.history:
            parts.append("\n".join(f"⏮️ ~~{esc(t.display)[:70]}~~" for t in list(player.history)[-2:]))
        if current:
            icon = "⏸️" if player.is_paused else "▶️"
            line = f"{icon} **{esc(current.display)[:90]}**"
            if current.duration:
                ratio = min(1.0, player.elapsed / current.duration)
                filled = int(ratio * 16)
                line += (f"\n`{format_time(player.elapsed)}` {'▰' * filled}{'▱' * (16 - filled)} "
                         f"`{format_time(current.duration)}`")
            parts.append(line)
        upcoming = [
            f"`{i}.` {esc(t.display)[:80]} · `{format_time(t.duration)}`"
            for i, t in enumerate(queue[start:start + QUEUE_PAGE_SIZE], start=start + 1)
        ]
        parts.append("**Sıradakiler**\n" + "\n".join(upcoming) if upcoming else "_Sırada başka şarkı yok._")

        collection = current.extra.get("collection") if current else None
        embed = discord.Embed(
            title=f"📃 {collection}"[:256] if collection else "📜 Çalma listesi",
            description="\n\n".join(parts)[:4000],
            color=ACCENT,
        )
        remaining = sum(t.duration or 0 for t in queue)
        if current and current.duration:
            remaining += max(0, current.duration - int(player.elapsed))
        embed.set_footer(
            text=f"{len(queue)} şarkı sırada · kalan {format_time(remaining)} · tekrar: "
            f"{LOOP_LABELS[player.loop_mode]} · sayfa {page}/{pages}"
        )
        if current and current.thumbnail:
            embed.set_thumbnail(url=current.thumbnail)
        return embed

    async def _check_control(self, ctx: commands.Context) -> GuildPlayer | None:
        """Gizli kontrol komutları için: aynı kanalda mı, bir şey çalıyor mu?"""
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
            return None
        player = self.players.get(ctx.guild.id)
        if not player or not player.current:
            await ctx.send("Şu an bir şey çalmıyor.")
            return None
        return player

    # ------------------------------------------------------------------
    # Komutlar
    # ------------------------------------------------------------------

    @commands.command(name="çal", aliases=["cal", "play", "p"], usage="<YouTube/Spotify/SoundCloud linki ya da şarkı adı>")
    async def play_command(self, ctx: commands.Context, *, query: str | None = None) -> None:
        """YouTube, Spotify ya da SoundCloud linkini (veya aramayı) ses kanalında çalar."""
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
            return

        player = self.players.get(ctx.guild.id)
        if not query:
            if player and player.resume():
                await ctx.send("▶️ Devam ediyor.")
            else:
                await ctx.send(f"❌ Kullanım: `{ctx.prefix}{ctx.invoked_with} <link ya da şarkı adı>`")
            return

        async with ctx.typing():
            try:
                tracks, collection = await self.sources.resolve(query, ctx.author.id)
            except SourceError as exc:
                await ctx.send(f"❌ {exc}")
                return

        for track in tracks:
            track.extra["collection"] = collection
        player = self._player_for(ctx)
        await player.connect(self._user_channel(ctx.author))
        was_busy = player.current is not None or bool(player.queue)
        added = player.add(tracks)
        player.start()

        if added == 0:
            await ctx.send(f"❌ Kuyruk dolu (en fazla {self.cfg.max_queue} parça).")
        elif collection:
            extra = f" (kuyruk sınırı yüzünden {len(tracks) - added} parça eklenmedi)" if added < len(tracks) else ""
            await ctx.send(f"📃 **{discord.utils.escape_markdown(collection)}** — **{added}** parça kuyruğa eklendi{extra}.")
        elif was_busy:
            track = tracks[0]
            await ctx.send(
                f"➕ Kuyruğa eklendi: **{discord.utils.escape_markdown(track.display)}** "
                f"(`{format_time(track.duration)}`) — sıra **{len(player.queue)}**"
            )
        elif tracks[0].fallback == "soundcloud":
            await ctx.send("ℹ️ YouTube şu an erişilemiyor, şarkı SoundCloud'dan çalınıyor.")

    @commands.command(name="playlist", aliases=["kuyruk", "queue", "q", "liste", "sıra", "sira", "pl"], usage="[sayfa]")
    async def playlist_command(self, ctx: commands.Context, page: int = 1) -> None:
        """Çalan playlist'i / kuyruğu gösterir: önceki, şimdi çalan ve sıradaki şarkılar."""
        player = self.players.get(ctx.guild.id)
        if not player or (not player.current and not player.queue):
            await ctx.send("Şu an bir şey çalmıyor. `!çal <link>` ile başlat.")
            return
        view = PlaylistView(self, player, page)
        view.message = await ctx.send(embed=self.playlist_embed(player, page), view=view)

    @commands.command(name="şimdi", aliases=["simdi", "np", "nowplaying", "çalan", "calan", "oynatıcı", "oynatici"])
    async def now_command(self, ctx: commands.Context) -> None:
        """Oynatıcıyı (kart + butonlar) sohbetin en altına yeniden gönderir."""
        player = self.players.get(ctx.guild.id)
        if not player or not player.current:
            await ctx.send("Şu an bir şey çalmıyor.")
            return
        player.text_channel = ctx.channel
        await player.send_now_playing()

    # Butonlarla yapılabilenlerin komut hâlleri; !yardim'da gösterilmez ama çalışır.

    @commands.command(name="geç", aliases=["gec", "skip", "atla", "s", "sonraki", "next"], hidden=True)
    async def skip_command(self, ctx: commands.Context) -> None:
        if (player := await self._check_control(ctx)) and player.skip():
            await ctx.message.add_reaction("⏭️")

    @commands.command(name="önceki", aliases=["onceki", "prev", "previous", "back"], hidden=True)
    async def previous_command(self, ctx: commands.Context) -> None:
        if (player := await self._check_control(ctx)) and player.previous() != "none":
            await ctx.message.add_reaction("⏮️")

    @commands.command(name="ileri", aliases=["forward", "ff"], usage="[saniye]", hidden=True)
    async def forward_command(self, ctx: commands.Context, seconds: int = SEEK_STEP) -> None:
        if player := await self._check_control(ctx):
            pos = player.seek_relative(abs(seconds))
            if pos is None:
                await ctx.send("⏭️ Şarkının sonuna gelindi, sıradakine geçiliyor.")
            else:
                await ctx.send(f"⏩ `{format_time(pos)}` / `{format_time(player.current.duration)}`")

    @commands.command(name="geri", aliases=["rewind", "rw"], usage="[saniye]", hidden=True)
    async def rewind_command(self, ctx: commands.Context, seconds: int = SEEK_STEP) -> None:
        if player := await self._check_control(ctx):
            pos = player.seek_relative(-abs(seconds))
            if pos is not None:
                await ctx.send(f"⏪ `{format_time(pos)}` / `{format_time(player.current.duration)}`")

    @commands.command(name="duraklat", aliases=["pause"], hidden=True)
    async def pause_command(self, ctx: commands.Context) -> None:
        if (player := await self._check_control(ctx)) and player.pause():
            await ctx.message.add_reaction("⏸️")
            await player.refresh_controls()

    @commands.command(name="devam", aliases=["resume"], hidden=True)
    async def resume_command(self, ctx: commands.Context) -> None:
        if (player := await self._check_control(ctx)) and player.resume():
            await ctx.message.add_reaction("▶️")
            await player.refresh_controls()

    @commands.command(name="bitir", aliases=["stop", "dur", "dc", "çık", "cik", "leave"], hidden=True)
    async def stop_command(self, ctx: commands.Context) -> None:
        """Müziği durdurur, kuyruğu temizler ve kanaldan çıkar."""
        player = self.players.get(ctx.guild.id)
        if not player:
            await ctx.send("Zaten bir ses kanalında değilim.")
            return
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
            return
        await player.stop()
        await ctx.message.add_reaction("⏹️")

    @commands.command(name="karıştır", aliases=["karistir", "shuffle"], hidden=True)
    async def shuffle_command(self, ctx: commands.Context) -> None:
        player = self.players.get(ctx.guild.id)
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
        elif not player or len(player.queue) < 2:
            await ctx.send("Karıştırmak için sırada en az 2 şarkı olmalı.")
        else:
            player.shuffle()
            await ctx.send(f"🔀 Liste karıştırıldı ({len(player.queue)} şarkı).")

    @commands.command(name="tekrar", aliases=["loop", "repeat"], usage="[kapalı | şarkı | liste]", hidden=True)
    async def loop_command(self, ctx: commands.Context, mode: str | None = None) -> None:
        player = self.players.get(ctx.guild.id)
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
            return
        if not player:
            await ctx.send("Şu an bir şey çalmıyor.")
            return
        if mode is None:
            player.cycle_loop()
        elif mode.lower() in LOOP_ARGS:
            player.loop_mode = LOOP_ARGS[mode.lower()]
        else:
            raise commands.BadArgument(mode)
        await ctx.send(f"Tekrar modu: **{LOOP_LABELS[player.loop_mode]}**")
        await player.refresh_controls()

    @commands.command(name="volume", aliases=["vol", "sesduzeyi", "sesdüzeyi"], usage="[0-100]")
    async def volume_command(self, ctx: commands.Context, percent: int | None = None) -> None:
        player = self.players.get(ctx.guild.id)
        if not player:
            await ctx.send("Şu an bir şey çalmıyor.")
            return
        if percent is None:
            await ctx.send(f"🔊 Ses düzeyi: **%{round(player.volume * 100)}**")
            return
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
            return
        player.set_volume(percent)
        await ctx.send(f"🔊 Ses düzeyi **%{round(player.volume * 100)}** olarak ayarlandı.")

    @commands.command(name="kaldır", aliases=["kaldir", "remove"], usage="<sıra numarası>")
    async def remove_command(self, ctx: commands.Context, index: int) -> None:
        player = self.players.get(ctx.guild.id)
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
            return
        removed = player.remove(index) if player else None
        if removed is None:
            await ctx.send("❌ Kuyrukta o numarada bir şarkı yok. Numaralar için `!kuyruk`.")
        else:
            await ctx.send(f"🗑️ Kuyruktan çıkarıldı: **{discord.utils.escape_markdown(removed.display)}**")

    @commands.command(name="temizle", aliases=["clear"])
    async def clear_command(self, ctx: commands.Context) -> None:
        player = self.players.get(ctx.guild.id)
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
        elif not player or not player.queue:
            await ctx.send("Kuyruk zaten boş.")
        else:
            count = len(player.queue)
            player.queue.clear()
            await ctx.send(f"🧹 Kuyruktan **{count}** parça temizlendi; çalan şarkı devam ediyor.")

    # ------------------------------------------------------------------
    # Yönetici komutları
    # ------------------------------------------------------------------

    @commands.command(name="muzikdurum", aliases=["müzikdurum", "musicstatus"])
    @commands.has_permissions(administrator=True)
    async def status_command(self, ctx: commands.Context) -> None:
        """Müzik sisteminin sağlık ve güncelleme durumunu gösterir."""
        st = self.updater.state

        def ago(ts: float) -> str:
            if not ts:
                return "hiç"
            return f"<t:{int(ts)}:R>"

        health = "✅ Çalışıyor" if st.health_ok else f"❌ Çalışmıyor ({st.health_kind})"
        embed = discord.Embed(title="🎵 Müzik sistemi durumu", color=discord.Color.from_rgb(0, 212, 255))
        embed.add_field(name="YouTube", value=f"{health}\nSon kontrol: {ago(st.health_ts)}", inline=False)
        if not st.health_ok:
            embed.add_field(name="Hata", value=f"`{st.health_error[:200]}`\nSorun başlangıcı: {ago(st.failing_since)}", inline=False)
        embed.add_field(
            name="yt-dlp",
            value=f"`{await ytdl.version() or '?'}` ({'nightly' if st.channel == 'nightly' else 'kararlı'})\n"
            f"Son güncelleme: {ago(st.last_update_ts)} — {'✅' if st.last_update_ok else '❌'} `{st.last_update_msg[:120]}`",
            inline=False,
        )
        embed.add_field(name="Otomatik güncelleme", value="Açık" if self.cfg.auto_update else "Kapalı", inline=True)
        embed.add_field(name="YouTube çerezi", value="Var" if self.cfg.cookies_file else "Yok", inline=True)
        embed.add_field(name="Spotify API", value="Var" if self.sources.spotify.api_enabled else "Yok (embed kullanılıyor)", inline=True)
        embed.add_field(name="Aktif oynatıcı", value=str(len(self.players)), inline=True)
        await ctx.send(embed=embed)

    @commands.command(name="muzikguncelle", aliases=["müzikgüncelle", "musicupdate"])
    @commands.has_permissions(administrator=True)
    async def force_update_command(self, ctx: commands.Context) -> None:
        """yt-dlp'yi hemen günceller ve YouTube'u test eder."""
        msg = await ctx.send("🔧 Güncelleniyor ve YouTube test ediliyor, bu bir dakika sürebilir…")
        async with self.updater._lock:
            await self.updater.update(reason=f"!muzikguncelle ({ctx.author})")
        ok = await self.updater.heal("elle tetiklendi", force=True)
        activitylog.record("admin_music_update", ctx.guild.id, ctx.author.id, channel_id=ctx.channel.id, ok=ok)
        await self._report_health_change()
        await msg.edit(content="✅ YouTube çalışıyor." if ok else
                       f"❌ YouTube hâlâ çalışmıyor ({self.updater.state.health_kind}). Şarkılar SoundCloud'dan çalınmaya çalışılacak.")

    # ------------------------------------------------------------------
    # Ses kanalı olayları
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_voice_state_update(
        self, member: discord.Member, before: discord.VoiceState, after: discord.VoiceState,
    ) -> None:
        player = self.players.get(member.guild.id)
        if player is None:
            return

        # Bot kanaldan atıldıysa / bağlantı koptuysa temizle
        if self.bot.user and member.id == self.bot.user.id and after.channel is None:
            if not player._closing:
                await player.stop()
            return

        channel = player.channel
        if channel is None:
            return
        humans = [m for m in channel.members if not m.bot]
        timer = self._alone_timers.get(member.guild.id)
        if humans:
            if timer:
                timer.cancel()
                self._alone_timers.pop(member.guild.id, None)
        elif timer is None or timer.done():
            self._alone_timers[member.guild.id] = asyncio.create_task(self._leave_if_alone(member.guild.id))

    async def _leave_if_alone(self, guild_id: int) -> None:
        try:
            await asyncio.sleep(self.cfg.alone_timeout)
            player = self.players.get(guild_id)
            if player and player.channel and not any(not m.bot for m in player.channel.members):
                await player._say("👋 Kanalda kimse kalmadı, çıkıyorum.")
                await player.stop()
        finally:
            self._alone_timers.pop(guild_id, None)

    # ------------------------------------------------------------------
    # Kendi kendini onarma
    # ------------------------------------------------------------------

    @tasks.loop(hours=6)
    async def health_loop(self) -> None:
        try:
            await self.updater.health_check()
            await self._report_health_change()
        except Exception:
            log.exception("Müzik sağlık kontrolü başarısız")

    @tasks.loop(hours=24)
    async def update_loop(self) -> None:
        try:
            await self.updater.routine_update()
        except Exception:
            log.exception("Rutin yt-dlp güncellemesi başarısız")

    @health_loop.before_loop
    async def _before_health(self) -> None:
        await self.bot.wait_until_ready()
        await asyncio.sleep(120)  # açılıştaki rutin güncelleme önce bitsin

    @update_loop.before_loop
    async def _before_update(self) -> None:
        await self.bot.wait_until_ready()

    async def _report_health_change(self) -> None:
        """Sorun başlarsa (günde bir kez) ve düzelince log kanalına haber ver."""
        st = self.updater.state
        if st.health_ok:
            if self._was_failing:
                self._was_failing = False
                self.bot.dispatch("gap_alert", None, "✅ Müzik: YouTube tekrar çalışıyor",
                                  "Otomatik onarım başarılı oldu; bir şey yapmana gerek yok.")
            return
        self._was_failing = True
        if self.updater.should_alert():
            hint = BLOCKED_HINT if st.health_kind == "blocked" else (
                "yt-dlp en yeni (nightly) sürüme güncellendi ama YouTube hâlâ açılmıyor. Genelde yt-dlp ekibi "
                "birkaç gün içinde düzeltme yayınlar; bot her gün kendini güncelleyip tekrar deneyecek."
            )
            self.bot.dispatch(
                "gap_alert", None, "🎵 Müzik: YouTube çalışmıyor",
                f"**Hata:** `{st.health_kind}` — {st.health_error[:200]}\n"
                f"Bu sürede şarkılar SoundCloud'dan çalınmaya çalışılıyor.\n\n{hint}",
            )
            self.updater.mark_alerted()


class NowPlayingView(discord.ui.LayoutView):
    """
    "Şimdi çalıyor" mesajı: başlık satırı, kart görseli, bilgi satırı ve iki sıra buton.
    finished=True iken (şarkı bitti) butonlar kalkar, yazı ve kart kalır.
    """

    def __init__(self, cog: MusicCog, player: GuildPlayer, *, finished: bool = False) -> None:
        super().__init__(timeout=None)
        self.cog = cog
        self.player = player
        track = player.now_track or player.current
        if track is None:
            self.add_item(discord.ui.TextDisplay("🎵 Çalma bitti."))
            return

        name, artist = card.split_title(track, plain=True)
        title = discord.utils.escape_markdown(f"{name} - {artist}" if artist else name)
        if finished:
            head = f"🎵 · Çalındı **{title}**"
        elif player.is_paused:
            head = f"⏸️ · Duraklatıldı **{title}**"
        else:
            head = f"🔊 · Şimdi çalıyor **{title}**"
        self.add_item(discord.ui.TextDisplay(head[:1000]))
        if player.now_has_card:
            self.add_item(discord.ui.MediaGallery(discord.MediaGalleryItem(f"attachment://{card.FILENAME}")))
        self.add_item(discord.ui.TextDisplay(self._info_line(track, finished)))
        if finished:
            return

        b = self._button
        style = discord.ButtonStyle
        loop_emoji = "🔂" if player.loop_mode == "track" else "🔁"
        self.add_item(discord.ui.ActionRow(
            b("⏮️", self.previous_button),
            b("⏪", self.rewind_button),
            b("▶️" if player.is_paused else "⏸️", self.toggle_button, style.primary),
            b("⏩", self.forward_button),
            b("⏭️", self.skip_button),
        ))
        self.add_item(discord.ui.ActionRow(
            b(loop_emoji, self.loop_button, style.success if player.loop_mode != "off" else style.secondary),
            b("🔀", self.shuffle_button),
            b("⏹️", self.stop_button, style.danger),
        ))

    def _info_line(self, track: Track, finished: bool) -> str:
        parts = [f"İsteyen: <@{track.requester_id}>"]
        if track.fallback == "soundcloud":
            parts.append("YouTube erişilemedi, SoundCloud'dan çalınıyor")
        elif note := SOURCE_NOTES.get(track.source):
            parts.append(note)
        if collection := track.extra.get("collection"):
            parts.append(f"📃 {discord.utils.escape_markdown(collection)[:60]}")
        if not finished:
            if self.player.loop_mode != "off":
                parts.append(f"Tekrar: {LOOP_LABELS[self.player.loop_mode]}")
            if self.player.queue:
                parts.append(f"Sırada {len(self.player.queue)} şarkı · `!playlist`")
        if track.url:
            parts.append(f"[Kaynağı aç]({track.url})")
        return "-# " + " · ".join(parts)

    @staticmethod
    def _button(emoji: str, handler, style: discord.ButtonStyle = discord.ButtonStyle.secondary) -> discord.ui.Button:
        button = discord.ui.Button(emoji=emoji, style=style)
        button.callback = handler
        return button

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        member = interaction.user
        if not isinstance(member, discord.Member):
            return False
        player = self.cog.players.get(member.guild.id)
        if player is not self.player or player.now_message is None or (
            interaction.message is not None and interaction.message.id != player.now_message.id
        ):
            await interaction.response.send_message("Bu oynatıcı artık aktif değil; en alttaki mesajı kullan.", ephemeral=True)
            return False
        if error := self.cog._same_channel_error(member):
            await interaction.response.send_message(f"❌ {error}", ephemeral=True)
            return False
        return True

    async def _refresh(self, interaction: discord.Interaction) -> None:
        await interaction.response.edit_message(
            view=NowPlayingView(self.cog, self.player), allowed_mentions=discord.AllowedMentions.none(),
        )

    async def _not_playing(self, interaction: discord.Interaction) -> None:
        await interaction.response.send_message("Şu an bir şey çalmıyor.", ephemeral=True, delete_after=5)

    async def previous_button(self, interaction: discord.Interaction) -> None:
        if self.player.previous() == "none":
            await self._not_playing(interaction)
        else:
            await interaction.response.defer()

    async def _seek(self, interaction: discord.Interaction, delta: int) -> None:
        if not self.player.current:
            await self._not_playing(interaction)
            return
        pos = self.player.seek_relative(delta)
        if pos is None:
            await interaction.response.defer()  # sona gelindi, sıradakine geçildi
            return
        icon = "⏩" if delta > 0 else "⏪"
        await interaction.response.send_message(
            f"{icon} `{format_time(pos)}` / `{format_time(self.player.current.duration)}`", ephemeral=True, delete_after=4,
        )

    async def rewind_button(self, interaction: discord.Interaction) -> None:
        await self._seek(interaction, -SEEK_STEP)

    async def forward_button(self, interaction: discord.Interaction) -> None:
        await self._seek(interaction, SEEK_STEP)

    async def toggle_button(self, interaction: discord.Interaction) -> None:
        if not (self.player.resume() if self.player.is_paused else self.player.pause()):
            await self._not_playing(interaction)
            return
        await self._refresh(interaction)

    async def skip_button(self, interaction: discord.Interaction) -> None:
        if self.player.skip():
            await interaction.response.defer()
        else:
            await self._not_playing(interaction)

    async def loop_button(self, interaction: discord.Interaction) -> None:
        self.player.cycle_loop()
        await self._refresh(interaction)

    async def shuffle_button(self, interaction: discord.Interaction) -> None:
        if len(self.player.queue) < 2:
            await interaction.response.send_message(
                "Karıştırmak için sırada en az 2 şarkı olmalı.", ephemeral=True, delete_after=5,
            )
            return
        self.player.shuffle()
        await interaction.response.send_message(
            f"🔀 Liste karıştırıldı ({len(self.player.queue)} şarkı).", ephemeral=True, delete_after=5,
        )

    async def stop_button(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        await self.player.stop()


class PlaylistView(discord.ui.View):
    """!playlist mesajındaki sayfa ve yenile butonları."""

    def __init__(self, cog: MusicCog, player: GuildPlayer, page: int) -> None:
        super().__init__(timeout=300)
        self.cog = cog
        self.player = player
        self.page = page
        self.message: discord.Message | None = None

    async def _show(self, interaction: discord.Interaction, page: int) -> None:
        if self.cog.players.get(self.player.guild.id) is not self.player:
            await interaction.response.edit_message(content="Çalma bitti.", embed=None, view=None)
            return
        pages = max(1, math.ceil(len(self.player.queue) / QUEUE_PAGE_SIZE))
        self.page = max(1, min(page, pages))
        await interaction.response.edit_message(embed=self.cog.playlist_embed(self.player, self.page), view=self)

    @discord.ui.button(emoji="◀️", style=discord.ButtonStyle.secondary)
    async def prev_page(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await self._show(interaction, self.page - 1)

    @discord.ui.button(emoji="🔄", style=discord.ButtonStyle.secondary)
    async def refresh_page(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await self._show(interaction, self.page)

    @discord.ui.button(emoji="▶️", style=discord.ButtonStyle.secondary)
    async def next_page(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await self._show(interaction, self.page + 1)

    async def on_timeout(self) -> None:
        if self.message is not None:
            try:
                await self.message.edit(view=None)
            except discord.HTTPException:
                pass
