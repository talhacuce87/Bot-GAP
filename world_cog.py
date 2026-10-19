"""
world_cog.py — GAP Dünyası (3D Activity, web/) entegrasyonu.

Sürgündekilerin listesini 20 sn'de bir dünya sunucusuna gönderir; dünya onları
zindan hücresine koyar, sürgün bitince serbest bırakır. XP sıralamasının ilk
10'unu da 5 dakikada bir gönderir; dünyadaki Şöhret Kürsüsü panosu bununla dolar. Dünya iç ağda
`WORLD_INTERNAL_URL` (varsayılan http://world:3000) adresindedir ve istekler
`WORLD_SHARED_SECRET` ile doğrulanır. Secret yoksa cog hiçbir şey yapmaz.
"""

from __future__ import annotations

import logging
import os

import discord
import httpx
from discord.ext import commands, tasks

import database as db
from font_utils import clean_display_name

log = logging.getLogger("gap.world")

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
        self._client: httpx.AsyncClient | None = None
        self._failing = False

    async def cog_load(self) -> None:
        if not self.secret:
            log.info("WORLD_SHARED_SECRET yok; GAP Dünyası entegrasyonu kapalı")
            return
        self._client = httpx.AsyncClient(timeout=5, headers={"x-world-secret": self.secret})
        self.push_loop.start()
        self.board_loop.start()

    async def cog_unload(self) -> None:
        self.push_loop.cancel()
        self.board_loop.cancel()
        if self._client is not None:
            await self._client.aclose()

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
