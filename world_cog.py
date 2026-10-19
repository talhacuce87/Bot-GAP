"""
world_cog.py — GAP Dünyası (3D Activity, web/) entegrasyonu.

Sürgündekilerin listesini 20 sn'de bir dünya sunucusuna gönderir; dünya onları
zindan hücresine koyar, sürgün bitince serbest bırakır. Dünya iç ağda
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

log = logging.getLogger("gap.world")

PUSH_SECONDS = 20


async def build_exile_payload(guild_ids: list[int]) -> dict:
    """{"guilds": {"<sunucu id>": ["<üye id>", ...]}} — yalnızca süresi dolmamış sürgünler."""
    guilds: dict[str, list[str]] = {}
    for gid in guild_ids:
        rows = await db.list_exiles(gid)
        guilds[str(gid)] = [str(r["user_id"]) for r in rows]
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

    async def cog_unload(self) -> None:
        self.push_loop.cancel()
        if self._client is not None:
            await self._client.aclose()

    async def push_exiles(self) -> None:
        if self._client is None:
            return
        payload = await build_exile_payload([g.id for g in self.bot.guilds])
        try:
            r = await self._client.post(f"{self.url}/internal/exiles", json=payload)
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
