"""
world_cog.py — GAP Dünyası (3D Activity, web/) entegrasyonu.

Sürgündekilerin listesini 20 sn'de bir dünya sunucusuna gönderir; dünya onları
zindan hücresine koyar, sürgün bitince serbest bırakır. XP sıralamasının ilk
10'unu da 5 dakikada bir gönderir; dünyadaki Şöhret Kürsüsü panosu bununla dolar.

!izle <link> bir watch party odası açar: link YouTube, Twitch, Kick ya da
doğrudan video dosyası olabilir. Bot "İzlemeye katıl" düğmesini kanala atar;
düğme dünyayı tarayıcıda açar ve video sinema perdesinde herkes için senkron oynar. Dünya iç ağda
`WORLD_INTERNAL_URL` (varsayılan http://world:3000) adresindedir ve istekler
`WORLD_SHARED_SECRET` ile doğrulanır. Secret yoksa cog hiçbir şey yapmaz.

Ters yön: dünya, gölde balık tutulunca botun iç HTTP ucuna (`WORLD_BOT_PORT`,
varsayılan 8081) `POST /internal/fish` atar; zar, seri ve boost botta (fishing.py).
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import os

import discord
import httpx
from aiohttp import web
from discord.ext import commands, tasks

import activitylog
import database as db
import fishing
from font_utils import clean_display_name

log = logging.getLogger("gap.world")

# Tutulan balıkların duyurulacağı kanal (boşsa duyuru yok) ve duyurulacak en düşük nadirlik
FISH_CHANNEL_ID = int(os.getenv("FISH_CHANNEL_ID", "0") or 0)
FISH_ANNOUNCE_MIN_RARITY = os.getenv("FISH_ANNOUNCE_MIN_RARITY", "rare").strip().lower()
if FISH_ANNOUNCE_MIN_RARITY not in fishing.RANK:
    FISH_ANNOUNCE_MIN_RARITY = "rare"

WATCH_KIND_LABELS = {
    "youtube": "YouTube",
    "twitch": "Twitch (canlı)",
    "twitch-vod": "Twitch video",
    "kick": "Kick (canlı)",
    "file": "Video dosyası",
}
WATCH_USAGE = "!izle <link> — YouTube, Twitch, Kick ya da .mp4/.webm/.m3u8 linki"

PUSH_SECONDS = 20
BOARD_MINUTES = 5
BOARD_SIZE = 10


async def build_exile_payload(guild_ids: list[int]) -> dict:
    """{"guilds": {"<sunucu id>": ["<üye id>", ...]}} — yalnızca süresi dolmamış sürgünler."""
    guilds: dict[str, list[str]] = {}
    for gid in guild_ids:
        rows = await db.list_exiles(gid)
        guilds[str(gid)] = [str(r["user_id"]) for r in rows]
    return {"guilds": guilds}


async def build_leaderboard_payload(bot: commands.Bot) -> dict:
    """{"guilds": {"<sunucu id>": [{"id", "name", "avatar", "level", "xp"}, ...]}} — XP'ye göre ilk 10."""
    xp_cog = bot.get_cog("XPTrackerCog")
    guilds: dict[str, list[dict]] = {}
    for guild in bot.guilds:
        entries = []
        for row in await db.get_leaderboard(guild.id, limit=BOARD_SIZE):
            uid = int(row["user_id"])
            member = guild.get_member(uid)
            total = int(row["total_xp"])
            level = xp_cog.get_progress_data(total)[0] if xp_cog is not None else 0
            # Sunucuya özel avatar değil kullanıcı avatarı: dünya yalnızca /avatars/<id>/<hash> proxy'ler.
            avatar = member.avatar.key if member is not None and member.avatar is not None else None
            entries.append({
                "id": str(uid),
                "name": clean_display_name(member, fallback=f"Kullanıcı {str(uid)[-4:]}"),
                "avatar": avatar,
                "level": int(level),
                "xp": total,
            })
        guilds[str(guild.id)] = entries
    return {"guilds": guilds}


class WorldCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self.secret = os.getenv("WORLD_SHARED_SECRET", "").strip()
        self.url = os.getenv("WORLD_INTERNAL_URL", "http://world:3000").rstrip("/")
        self.port = int(os.getenv("WORLD_BOT_PORT", "8081"))
        self._client: httpx.AsyncClient | None = None
        self._runner: web.AppRunner | None = None
        self._tasks: set[asyncio.Task] = set()
        self._failing = False

    async def cog_load(self) -> None:
        if not self.secret:
            log.info("WORLD_SHARED_SECRET yok; GAP Dünyası entegrasyonu kapalı")
            return
        self._client = httpx.AsyncClient(timeout=5, headers={"x-world-secret": self.secret})
        self.push_loop.start()
        self.board_loop.start()
        app = web.Application(client_max_size=4096)
        app.router.add_post("/internal/fish", self.handle_fish)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        await web.TCPSite(self._runner, "0.0.0.0", self.port).start()

    async def cog_unload(self) -> None:
        self.push_loop.cancel()
        self.board_loop.cancel()
        if self._client is not None:
            await self._client.aclose()
        if self._runner is not None:
            await self._runner.cleanup()

    async def handle_fish(self, request: web.Request) -> web.Response:
        """Dünyadan: {"guild", "user"} → günün balığı ya da neden tutulamadığı."""
        # bytes karşılaştırması: str sürümü ASCII dışı karakterde TypeError (500) fırlatır
        given = request.headers.get("x-world-secret", "").encode()
        if not hmac.compare_digest(given, self.secret.encode()):
            return web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
            guild_id, user_id = int(body["guild"]), int(body["user"])
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "guild and user required"}, status=400)
        guild = self.bot.get_guild(guild_id)
        if guild is None or guild.get_member(user_id) is None:
            return web.json_response({"ok": False, "reason": "not_member"})
        exile = await db.get_exile(guild_id, user_id)
        if exile is not None and not db.exile_expired(exile):
            return web.json_response({"ok": False, "reason": "exiled"})
        result = await fishing.catch(guild_id, user_id)
        if result is None:
            return web.json_response({"ok": False, "reason": "already"})
        log.info("Balık: %s %s (%s saat, seri %s)", user_id, result["rarity"], result["hours"], result["streak"])
        # Balık boost'u, XP kayıtlarında yönetici !boost'undan ayırt edilebilsin diye ayrıca kaydedilir
        activitylog.record(
            "fish_catch", guild_id, user_id,
            rarity=result["rarity"], hours=result["hours"], streak=result["streak"],
            boost_until=round(result["boost_until"]),
        )
        if FISH_CHANNEL_ID and fishing.RANK[result["rarity"]] >= fishing.RANK[FISH_ANNOUNCE_MIN_RARITY]:
            # Arka planda: Discord gecikmesi dünyadaki tutuş bildirimini bekletmesin
            task = asyncio.create_task(self._announce_fish(guild, user_id, result))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        return web.json_response({"ok": True, **result})

    async def _announce_fish(self, guild: discord.Guild, user_id: int, result: dict) -> None:
        channel = guild.get_channel(FISH_CHANNEL_ID)
        if not isinstance(channel, discord.abc.Messageable):
            log.warning("Balık kanalı bulunamadı: %s", FISH_CHANNEL_ID)
            return
        try:
            # Adı vurgulu gösterir ama bildirim (ping) göndermez
            await channel.send(
                fishing.announce_text(f"<@{user_id}>", result),
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except discord.HTTPException as err:
            log.warning("Balık duyurusu gönderilemedi: %s", err)

    async def push_exiles(self) -> None:
        if self._client is None:
            return
        await self._post("/internal/exiles", await build_exile_payload([g.id for g in self.bot.guilds]))

    async def push_leaderboard(self) -> None:
        if self._client is None:
            return
        await self._post("/internal/leaderboard", await build_leaderboard_payload(self.bot))

    async def _post(self, path: str, payload: dict) -> None:
        assert self._client is not None
        try:
            r = await self._client.post(f"{self.url}{path}", json=payload)
            r.raise_for_status()
            if self._failing:
                log.info("GAP Dünyası'na yeniden ulaşıldı")
            self._failing = False
        except httpx.HTTPError as e:
            # Dünya kapalıyken her 20 sn'de log basmasın.
            if not self._failing:
                log.warning("GAP Dünyası'na sürgün listesi gönderilemedi: %s", e)
            self._failing = True

    @tasks.loop(seconds=PUSH_SECONDS)
    async def push_loop(self) -> None:
        try:
            await self.push_exiles()
        except Exception:
            log.exception("Sürgün listesi hazırlanamadı")

    @push_loop.before_loop
    async def _before_push(self) -> None:
        await self.bot.wait_until_ready()

    @tasks.loop(minutes=BOARD_MINUTES)
    async def board_loop(self) -> None:
        try:
            await self.push_leaderboard()
        except Exception:
            log.exception("Sıralama hazırlanamadı")

    @board_loop.before_loop
    async def _before_board(self) -> None:
        await self.bot.wait_until_ready()

    async def create_watch(self, guild_id: int, author: discord.abc.User, url: str) -> dict | None:
        """Dünyada bir izleme odası açar. Link desteklenmiyorsa None; dünyaya ulaşılamazsa httpx hatası."""
        assert self._client is not None
        r = await self._client.post(f"{self.url}/internal/watch", json={
            "guild": str(guild_id),
            "by": {"id": str(author.id), "name": getattr(author, "display_name", author.name)},
            "url": url,
        })
        if r.status_code == 400:
            return None
        r.raise_for_status()
        return r.json()

    @commands.command(name="izle", aliases=["watch", "wp", "watchparty"], usage="<link>")
    @commands.guild_only()
    async def watch_command(self, ctx: commands.Context, url: str | None = None) -> None:
        """Watch party: linki GAP Dünyası'ndaki sinema perdesinde herkesle senkron izle."""
        if self._client is None:
            await ctx.send("ℹ️ GAP Dünyası bu botta bağlı değil.")
            return
        if not url:
            await ctx.send(f"Kullanım: `{WATCH_USAGE}`")
            return
        url = url.strip("<>")  # Discord önizlemesini kapatmak için <link> yazılabilir
        try:
            room = await self.create_watch(ctx.guild.id, ctx.author, url)
        except httpx.HTTPError as e:
            log.warning("İzleme odası açılamadı: %s", e)
            await ctx.send("❌ GAP Dünyası'na şu an ulaşılamıyor, biraz sonra tekrar dene.")
            return
        if room is None:
            await ctx.send(f"❌ Bu linki açamıyorum. Kullanım: `{WATCH_USAGE}`")
            return

        embed = discord.Embed(
            title="🎬 Watch party başladı",
            description=(
                f"**{room['title']}**\n{WATCH_KIND_LABELS.get(room['kind'], '')}\n\n"
                "Düğmeye bas, Discord ile giriş yap; video GAP Dünyası'ndaki sinema perdesinde herkes için senkron oynar."
            ),
            color=discord.Color.from_rgb(88, 101, 242),
        )
        embed.set_footer(text=f"Başlatan: {ctx.author.display_name} · Odada kimse kalmazsa 6 saat sonra kapanır")
        view = discord.ui.View()
        view.add_item(discord.ui.Button(label="İzlemeye katıl", emoji="🍿", url=room["url"]))
        await ctx.send(embed=embed, view=view)

    @commands.Cog.listener()
    async def on_exile_end(self, guild_id: int, user_id: int, row, _by) -> None:
        """Süresi dolan sürgün kapanınca beklemeden serbest bırak."""
        await self.push_exiles()

    @commands.Cog.listener()
    async def on_exile_change(self, guild_id: int, user_id: int) -> None:
        """!sürgün / !sürgünsonlandır: zindana hemen alınsın ya da çıksın."""
        await self.push_exiles()

    @commands.Cog.listener()
    async def on_guild_join(self, guild: discord.Guild) -> None:
        await self.push_exiles()
