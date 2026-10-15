"""
music/cog.py — Müzik komutları, kontrol butonları ve kendi kendini onaran arka plan görevleri.
"""

from __future__ import annotations

import asyncio
import logging
import math

import discord
from discord.ext import commands, tasks

import activitylog
from music import ytdl
from music.config import MusicConfig
from music.player import LOOP_LABELS, GuildPlayer, format_time
from music.sources import SourceError, SourceResolver
from music.updater import Updater

log = logging.getLogger("gap.music")

QUEUE_PAGE_SIZE = 10
LOOP_ARGS = {
    "kapali": "off", "kapalı": "off", "off": "off", "kapat": "off",
    "sarki": "track", "şarkı": "track", "track": "track", "tek": "track",
    "kuyruk": "queue", "liste": "queue", "queue": "queue", "hepsi": "queue",
}
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
    # Kontrol butonları
    # ------------------------------------------------------------------

    def controls_view(self, player: GuildPlayer) -> discord.ui.View:
        return MusicControls(self, player)

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

    @commands.command(name="geç", aliases=["gec", "skip", "atla", "s"])
    async def skip_command(self, ctx: commands.Context) -> None:
        """Çalan şarkıyı geçer."""
        player = self.players.get(ctx.guild.id)
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
        elif player and player.skip():
            await ctx.message.add_reaction("⏭️")
        else:
            await ctx.send("Şu an bir şey çalmıyor.")

    @commands.command(name="duraklat", aliases=["pause"])
    async def pause_command(self, ctx: commands.Context) -> None:
        player = self.players.get(ctx.guild.id)
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
        elif player and player.pause():
            await ctx.message.add_reaction("⏸️")
        else:
            await ctx.send("Şu an çalan bir şey yok.")

    @commands.command(name="devam", aliases=["resume"])
    async def resume_command(self, ctx: commands.Context) -> None:
        player = self.players.get(ctx.guild.id)
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
        elif player and player.resume():
            await ctx.message.add_reaction("▶️")
        else:
            await ctx.send("Duraklatılmış bir şarkı yok.")

    @commands.command(name="bitir", aliases=["stop", "dur", "dc", "çık", "cik", "leave"])
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

    @commands.command(name="kuyruk", aliases=["queue", "q", "sıra", "sira"], usage="[sayfa]")
    async def queue_command(self, ctx: commands.Context, page: int = 1) -> None:
        player = self.players.get(ctx.guild.id)
        if not player or (not player.current and not player.queue):
            await ctx.send("Kuyruk boş. `!çal <link>` ile bir şey ekle.")
            return
        await ctx.send(embed=self.queue_embed(player, page))

    def queue_embed(self, player: GuildPlayer, page: int = 1) -> discord.Embed:
        pages = max(1, math.ceil(len(player.queue) / QUEUE_PAGE_SIZE))
        page = max(1, min(page, pages))
        start = (page - 1) * QUEUE_PAGE_SIZE
        lines = [
            f"`{i}.` {discord.utils.escape_markdown(t.display)[:80]} · `{format_time(t.duration)}`"
            for i, t in enumerate(list(player.queue)[start:start + QUEUE_PAGE_SIZE], start=start + 1)
        ]
        now = f"🎵 **{discord.utils.escape_markdown(player.current.display)}**\n\n" if player.current else ""
        total = sum(t.duration or 0 for t in player.queue)
        embed = discord.Embed(
            title="📜 Kuyruk",
            description=now + ("\n".join(lines) if lines else "_Sırada başka şarkı yok._"),
            color=discord.Color.from_rgb(0, 212, 255),
        )
        embed.set_footer(
            text=f"{len(player.queue)} parça · toplam {format_time(total)} · tekrar: "
            f"{LOOP_LABELS[player.loop_mode]} · sayfa {page}/{pages}"
        )
        return embed

    @commands.command(name="şimdi", aliases=["simdi", "np", "nowplaying", "çalan", "calan"])
    async def now_command(self, ctx: commands.Context) -> None:
        player = self.players.get(ctx.guild.id)
        if not player or not player.current:
            await ctx.send("Şu an bir şey çalmıyor.")
            return
        await ctx.send(embed=player.now_playing_embed(player.current, with_progress=True))

    @commands.command(name="karıştır", aliases=["karistir", "shuffle"])
    async def shuffle_command(self, ctx: commands.Context) -> None:
        player = self.players.get(ctx.guild.id)
        if error := self._same_channel_error(ctx.author):
            await ctx.send(f"❌ {error}")
        elif not player or len(player.queue) < 2:
            await ctx.send("Karıştırmak için kuyrukta en az 2 şarkı olmalı.")
        else:
            player.shuffle()
            await ctx.send(f"🔀 Kuyruk karıştırıldı ({len(player.queue)} parça).")

    @commands.command(name="tekrar", aliases=["loop", "repeat"], usage="[kapalı | şarkı | kuyruk]")
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


class MusicControls(discord.ui.View):
    """"Şimdi çalıyor" mesajındaki butonlar: duraklat/devam, geç, durdur, tekrar, kuyruk."""

    def __init__(self, cog: MusicCog, player: GuildPlayer) -> None:
        super().__init__(timeout=None)
        self.cog = cog
        self.player = player

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        member = interaction.user
        if not isinstance(member, discord.Member):
            return False
        if self.cog.players.get(member.guild.id) is not self.player:
            await interaction.response.send_message("Bu oynatıcı artık aktif değil.", ephemeral=True)
            return False
        if error := self.cog._same_channel_error(member):
            await interaction.response.send_message(f"❌ {error}", ephemeral=True)
            return False
        return True

    @discord.ui.button(emoji="⏯️", style=discord.ButtonStyle.secondary)
    async def toggle_button(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        if self.player.is_paused:
            self.player.resume()
        else:
            self.player.pause()
        await interaction.response.defer()

    @discord.ui.button(emoji="⏭️", style=discord.ButtonStyle.secondary)
    async def skip_button(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        self.player.skip()
        await interaction.response.defer()

    @discord.ui.button(emoji="⏹️", style=discord.ButtonStyle.danger)
    async def stop_button(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.defer()
        await self.player.stop()

    @discord.ui.button(emoji="🔁", style=discord.ButtonStyle.secondary)
    async def loop_button(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        mode = self.player.cycle_loop()
        await interaction.response.send_message(f"Tekrar modu: **{LOOP_LABELS[mode]}**", ephemeral=True)

    @discord.ui.button(emoji="📜", style=discord.ButtonStyle.secondary)
    async def queue_button(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.send_message(embed=self.cog.queue_embed(self.player), ephemeral=True)
