"""
world_cog.py — GAP Dünyası (3D Activity, web/) entegrasyonu.

Sürgündekilerin listesini 20 sn'de bir dünya sunucusuna gönderir; dünya onları
zindan hücresine koyar, sürgün bitince serbest bırakır. XP sıralamasının ilk
10'unu da dakikada bir gönderir; dünyadaki Şöhret Kürsüsü panosu bununla dolar.

!izle <link> bir watch party odası açar: link YouTube, Twitch, Kick ya da
doğrudan video dosyası olabilir. Bot "İzlemeye katıl" düğmesini kanala atar;
düğme dünyayı tarayıcıda açar ve video sinema perdesinde herkes için senkron oynar. Dünya iç ağda
`WORLD_INTERNAL_URL` (varsayılan http://world:3000) adresindedir ve istekler
`WORLD_SHARED_SECRET` ile doğrulanır. Secret yoksa cog hiçbir şey yapmaz.

Ters yön: dünya, gölde balık tutulunca botun iç HTTP ucuna (`WORLD_BOT_PORT`,
varsayılan 8081) `POST /internal/fish` atar; zar, seri ve boost botta (fishing.py).
Dünyadaki olaylar (gol, oyun galibiyeti, çay…) `/internal/world_event` ile gelir: günlük görevler
ilerler, tamamlanınca XP verilir (world_quests.py). Profil kartı `/internal/profile`, tank sezonu
`/internal/season`, dünyada çekilen fotoğraflar `/internal/photo` (PHOTO_CHANNEL_ID kanalına).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import datetime
import hmac
import io
import logging
import os
import time

import discord
import httpx
from aiohttp import web
from discord.ext import commands, tasks

import activitylog
import database as db
import fishing
import outfit
import world_quests
from xp import format_duration, streak_multiplier
from xproles import XPRoleManager
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
WATCH_USAGE = "!izle <link> — YouTube, Twitch, Kick, tabii (TRT canlı) ya da .mp4/.webm/.m3u8 linki"

# Dünyada çekilen fotoğrafların gönderileceği kanal (boşsa balık kanalı; o da yoksa kapalı)
PHOTO_CHANNEL_ID = int(os.getenv("PHOTO_CHANNEL_ID", "0") or 0) or FISH_CHANNEL_ID
PHOTO_MAX_BYTES = 3 * 1024 * 1024
# Sayaçları başarımlara da işlenen dünya olayları
ACHIEVEMENT_EVENTS = {"goal", "game_win", "tank_kill", "photo"}

# Dünyada saati/havayı oylamasız değiştirebilen roller (virgüllü rol ID'leri ya da adları);
# yöneticiler ve "Sunucuyu yönet" yetkisi olanlar her zaman değiştirebilir, diğerleri oylama açar.
WORLD_CONTROL_ROLES = {r.strip().lower() for r in os.getenv("WORLD_CONTROL_ROLES", "").split(",") if r.strip()}


def can_control_world(member) -> bool:
    perms = member.guild_permissions
    if perms.administrator or perms.manage_guild:
        return True
    return any(str(r.id) in WORLD_CONTROL_ROLES or r.name.lower() in WORLD_CONTROL_ROLES for r in member.roles)


# Mahalle: arsa sayısı üst sınırı ve arsa verisinin en büyük boyu (dünya sunucusunun kısa biçimi)
BUILD_MAX_PLOTS = 100
BUILD_MAX_DATA = 80000

PUSH_SECONDS = 20
BOARD_MINUTES = 1
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



async def game_command_text(guild_id: int, user_id: int, command: str, roles: XPRoleManager,
                            guild: discord.Guild | None = None) -> str | None:
    """Oyun içi komutların metin cevabı; bilinmeyen komutta None."""
    if command == "top":
        rows = await db.get_leaderboard(guild_id, 5)
        if not rows:
            return "🏆 Henüz XP verisi yok."
        medals = ["🥇", "🥈", "🥉", "4.", "5."]
        names = []
        for i, r in enumerate(rows):
            member = guild.get_member(int(r["user_id"])) if guild else None
            name = member.display_name if member else f"Kullanıcı {r['user_id']}"
            names.append(f"{medals[i]} {name} ({int(r['total_xp']):,})")
        return "🏆 " + " · ".join(names)
    row = await db.get_user_row(guild_id, user_id)
    total = int(row["total_xp"]) if row else 0
    level, _next, _floor, ceiling, _ratio = roles.get_progress_data(total)
    if command == "xp":
        rank = await db.get_user_rank(guild_id, user_id)
        left = f" · sonraki seviyeye {ceiling - total:,} XP" if ceiling > total else " · en üst seviye"
        return f"⭐ Seviye {level} · {total:,} XP · sıra #{rank}{left}"
    if command == "rank":
        return f"🏆 Sıralamada #{await db.get_user_rank(guild_id, user_id)} ({total:,} XP)"
    if command == "streak":
        days = int(row["streak_days"]) if row else 0
        return f"🔥 {days} günlük seri · XP çarpanı x{streak_multiplier(days):.2f}"
    if command == "ses":
        seconds = int(row["voice_seconds"]) if row else 0
        started = row["active_voice_started_at"] if row else None
        if started:
            seconds += max(0, int(time.time() - started))
        return f"🔊 Toplam ses süren: {format_duration(seconds)}"
    return None

def _today() -> datetime.date:
    """Görev günü: Türkiye saatiyle (seriyle aynı gün sınırı)."""
    return datetime.datetime.now(db.STREAK_TZ).date()


class WorldCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self.secret = os.getenv("WORLD_SHARED_SECRET", "").strip()
        self.url = os.getenv("WORLD_INTERNAL_URL", "http://world:3000").rstrip("/")
        self.port = int(os.getenv("WORLD_BOT_PORT", "8081"))
        self._client: httpx.AsyncClient | None = None
        self._runner: web.AppRunner | None = None
        self._tasks: set[asyncio.Task] = set()
        self._roles = XPRoleManager()
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
        app.router.add_post("/internal/fish_status", self.handle_fish_status)
        app.router.add_post("/internal/outfits", self.handle_outfits)
        app.router.add_post("/internal/wardrobe", self.handle_wardrobe)
        app.router.add_post("/internal/outfit", self.handle_save_outfit)
        app.router.add_post("/internal/command", self.handle_command)
        app.router.add_post("/internal/can_control", self.handle_can_control)
        app.router.add_post("/internal/builds", self.handle_builds)
        app.router.add_post("/internal/build_save", self.handle_build_save)
        app.router.add_post("/internal/build_free", self.handle_build_free)
        app.router.add_post("/internal/world_event", self.handle_world_event)
        app.router.add_post("/internal/profile", self.handle_profile)
        app.router.add_post("/internal/season", self.handle_season)
        app.router.add_post("/internal/photo", self.handle_photo)
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

    def _authorized(self, request: web.Request) -> bool:
        # bytes karşılaştırması: str sürümü ASCII dışı karakterde TypeError (500) fırlatır
        given = request.headers.get("x-world-secret", "").encode()
        return hmac.compare_digest(given, self.secret.encode())

    async def _level(self, guild_id: int, user_id: int) -> int:
        row = await db.get_user_row(guild_id, user_id)
        return self._roles.get_progress_data(int(row["total_xp"]) if row else 0)[0]

    async def handle_fish(self, request: web.Request) -> web.Response:
        """Dünyadan: {"guild", "user"} → günün balığı ya da neden tutulamadığı."""
        if not self._authorized(request):
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
            return web.json_response({"ok": False, "reason": "already", "next": await fishing.next_catch_at(guild_id, user_id)})
        log.info("Balık: %s %s (%s saat, seri %s)", user_id, result["rarity"], result["hours"], result["streak"])
        # Balık boost'u, XP kayıtlarında yönetici !boost'undan ayırt edilebilsin diye ayrıca kaydedilir
        activitylog.record(
            "fish_catch", guild_id, user_id,
            rarity=result["rarity"], hours=result["hours"], streak=result["streak"],
            boost_until=round(result["boost_until"]),
        )
        # Balık albümü ve günün "balık tut" görevi
        await db.add_world_stats(guild_id, user_id, {f"fish:{result['rarity']}": 1})
        completed = await world_quests.record(guild_id, user_id, "fish", 1, _today())
        result = {**result, "completed": await self._grant_quests(guild, user_id, completed)}
        if FISH_CHANNEL_ID and fishing.RANK[result["rarity"]] >= fishing.RANK[FISH_ANNOUNCE_MIN_RARITY]:
            # Arka planda: Discord gecikmesi dünyadaki tutuş bildirimini bekletmesin
            task = asyncio.create_task(self._announce_fish(guild, user_id, result))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        return web.json_response({"ok": True, **result})

    async def handle_fish_status(self, request: web.Request) -> web.Response:
        """Dünyadan: {"guild", "user"} → {"next": sonraki balık hakkı (epoch sn), hak varsa 0}."""
        if not self._authorized(request):
            return web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
            guild_id, user_id = int(body["guild"]), int(body["user"])
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "guild and user required"}, status=400)
        return web.json_response({"next": await fishing.next_catch_at(guild_id, user_id)})

    async def handle_outfits(self, request: web.Request) -> web.Response:
        """Dünyadan: {"guild", "users": [...]} → odadakilerin kıyafetleri (kayıtsızlara varsayılan)."""
        if not self._authorized(request):
            return web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
            guild_id = int(body["guild"])
            users = [int(u) for u in body["users"]][:200]
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "guild and users required"}, status=400)
        saved = await db.get_outfits(guild_id, users)
        out = {}
        for uid in users:
            level = await self._level(guild_id, uid)
            out[str(uid)] = outfit.validate(saved.get(uid), level)[0]
        return web.json_response({"outfits": out})

    async def handle_wardrobe(self, request: web.Request) -> web.Response:
        """Gardırop açılırken: {"guild", "user"} → kıyafet, seviye ve kilitli parçalar."""
        if not self._authorized(request):
            return web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
            guild_id, user_id = int(body["guild"]), int(body["user"])
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "guild and user required"}, status=400)
        level = await self._level(guild_id, user_id)
        return web.json_response({
            "outfit": await outfit.load(guild_id, user_id, level),
            "level": level,
            "locked": outfit.LOCKED,
        })

    async def handle_save_outfit(self, request: web.Request) -> web.Response:
        """Gardıroptan kaydet: {"guild", "user", "outfit"} → temizlenmiş kıyafet ve atılan parçalar."""
        if not self._authorized(request):
            return web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
            guild_id, user_id = int(body["guild"]), int(body["user"])
            raw = body["outfit"]
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "guild, user and outfit required"}, status=400)
        guild = self.bot.get_guild(guild_id)
        if guild is None or guild.get_member(user_id) is None:
            return web.json_response({"ok": False, "reason": "not_member"})
        clean, dropped = await outfit.save(guild_id, user_id, raw, await self._level(guild_id, user_id))
        activitylog.record("outfit_change", guild_id, user_id, outfit=clean)
        return web.json_response({"ok": True, "outfit": clean, "dropped": dropped})

    async def handle_command(self, request: web.Request) -> web.Response:
        """Oyun içi sohbetten komut: {"guild", "user", "command"} → {"text"} (yalnızca sorana gösterilir)."""
        if not self._authorized(request):
            return web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
            guild_id, user_id = int(body["guild"]), int(body["user"])
            command = str(body["command"])
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "guild, user and command required"}, status=400)
        guild = self.bot.get_guild(guild_id)
        if guild is None or guild.get_member(user_id) is None:
            return web.json_response({"text": "Bu sunucunun üyesi değilsin."})
        text = await game_command_text(guild_id, user_id, command, self._roles, guild)
        if text is None:
            return web.json_response({"error": "unknown command"}, status=400)
        activitylog.record("command", guild_id, user_id, name=command, source="world")
        return web.json_response({"text": text})

    async def handle_can_control(self, request: web.Request) -> web.Response:
        """Dünyanın saatini/havasını oylamasız değiştirebilir mi: {"guild", "user"} → {"allowed"}."""
        got = await self._member_request(request)
        if isinstance(got, web.Response):
            return got
        guild, user_id, _body = got
        return web.json_response({"ok": True, "allowed": can_control_world(guild.get_member(user_id))})

    async def handle_builds(self, request: web.Request) -> web.Response:
        """Mahalle: {"guild"} → dolu arsalar (sahibi ve blokları)."""
        if not self._authorized(request):
            return web.json_response({"error": "not found"}, status=404)
        try:
            guild_id = int((await request.json())["guild"])
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "guild required"}, status=400)
        rows = await db.get_world_builds(guild_id)
        guild = self.bot.get_guild(guild_id)

        def name(uid: int) -> str:
            member = guild.get_member(uid) if guild is not None else None
            return clean_display_name(member.display_name) if member is not None and hasattr(member, "display_name") else "Komşu"

        return web.json_response({"plots": [{"plot": p, "user": str(u), "name": name(u), "data": d} for p, u, d in rows]})

    async def handle_build_save(self, request: web.Request) -> web.Response:
        """Arsayı kaydet: {"guild", "user", "plot", "data"}; arsa başkasınınsa ya da üyenin başka arsası varsa reddedilir."""
        got = await self._member_request(request)
        if isinstance(got, web.Response):
            return got
        guild, user_id, body = got
        try:
            plot = int(body["plot"])
            data = str(body.get("data", ""))
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "plot required"}, status=400)
        if not 0 <= plot < BUILD_MAX_PLOTS or len(data) > BUILD_MAX_DATA:
            return web.json_response({"error": "bad plot or data"}, status=400)
        ok = await db.save_world_build(guild.id, plot, user_id, data)
        return web.json_response({"ok": ok} if ok else {"ok": False, "reason": "taken"})

    async def handle_build_free(self, request: web.Request) -> web.Response:
        """Üyenin arsasını boşalt: {"guild", "user"}."""
        got = await self._member_request(request)
        if isinstance(got, web.Response):
            return got
        guild, user_id, _body = got
        await db.free_world_build(guild.id, user_id)
        return web.json_response({"ok": True})

    async def _member_request(self, request: web.Request) -> tuple[discord.Guild, int, dict] | web.Response:
        """Ortak giriş: secret, {"guild", "user"} ve üyelik. Hata durumunda hazır cevap döner."""
        if not self._authorized(request):
            return web.json_response({"error": "not found"}, status=404)
        try:
            body = await request.json()
            guild_id, user_id = int(body["guild"]), int(body["user"])
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "guild and user required"}, status=400)
        guild = self.bot.get_guild(guild_id)
        if guild is None or guild.get_member(user_id) is None:
            return web.json_response({"ok": False, "reason": "not_member"})
        return guild, user_id, body

    async def _grant_quests(self, guild: discord.Guild, user_id: int, quests: list[world_quests.Quest]) -> list[dict]:
        """Tamamlanan görevlerin XP'sini verir (sürgünde XP yok, görev yine tamamlanır)."""
        if not quests:
            return []
        exile = await db.get_exile(guild.id, user_id)
        exiled = exile is not None and not db.exile_expired(exile)
        total = 0 if exiled else sum(q.xp for q in quests)
        if total:
            await db.add_text_xp(guild.id, user_id, total)
            member = guild.get_member(user_id)
            xp_cog = self.bot.get_cog("XPTrackerCog") if hasattr(self.bot, "get_cog") else None
            if xp_cog is not None and isinstance(member, discord.Member):
                await xp_cog._sync_role(member)
        for q in quests:
            activitylog.record("xp_world_quest", guild.id, user_id, amount=0 if exiled else q.xp, quest=q.key)
            activitylog.record("world", guild.id, user_id, amount=1, kind="quest")
        log.info("Dünya görevi: %s %s (+%d XP)", user_id, [q.key for q in quests], total)
        return [{"key": q.key, "title": q.title, "xp": 0 if exiled else q.xp} for q in quests]

    async def handle_world_event(self, request: web.Request) -> web.Response:
        """Dünyadan: {"guild", "user", "event", "amount"} → tamamlanan görevler ({"completed": [...]})."""
        parsed = await self._member_request(request)
        if isinstance(parsed, web.Response):
            return parsed
        guild, user_id, body = parsed
        event = str(body.get("event", ""))
        try:
            amount = max(1, min(10_000, int(body.get("amount", 1))))
        except (TypeError, ValueError):
            amount = 1
        if event not in world_quests.EVENTS and event not in world_quests.EXTRA_EVENTS:
            return web.json_response({"error": "unknown event"}, status=400)
        completed = await world_quests.record(guild.id, user_id, event, amount, _today())
        if event in ACHIEVEMENT_EVENTS:
            activitylog.record("world", guild.id, user_id, amount=amount, kind=event)
        return web.json_response({"ok": True, "completed": await self._grant_quests(guild, user_id, completed)})

    async def handle_profile(self, request: web.Request) -> web.Response:
        """Oyuncu kartı: seviye, XP, sıra, balık albümü, dünya sayaçları, sezon ve günün görevleri."""
        parsed = await self._member_request(request)
        if isinstance(parsed, web.Response):
            return parsed
        guild, user_id, _body = parsed
        row = await db.get_user_row(guild.id, user_id)
        total = int(row["total_xp"]) if row else 0
        level, _next, floor, ceiling, _ratio = self._roles.get_progress_data(total)
        stats = await db.get_world_stats(guild.id, user_id)
        today = _today()
        season = world_quests.season_key(today)
        return web.json_response({
            "ok": True,
            "level": level,
            "xp": total,
            "floor": floor,
            "ceiling": ceiling,
            "rank": await db.get_user_rank(guild.id, user_id),
            "streak": db.current_streak(row) if row else 0,
            "fish": {r.key: stats.get(f"fish:{r.key}", 0) for r in fishing.RARITIES},
            "stats": {k: stats.get(k, 0) for k in set(world_quests.STAT_KEYS.values())},
            "season": {"key": season, **{k: stats.get(f"s:{season}:{k}", 0) for k in set(world_quests.SEASON_KEYS.values())}},
            "quests": await world_quests.quest_status(guild.id, user_id, today),
        })

    async def handle_season(self, request: web.Request) -> web.Response:
        """Tank sezonu (bu ay): en çok tank vuran 10 üye, isim ve galibiyetleriyle."""
        if not self._authorized(request):
            return web.json_response({"error": "not found"}, status=404)
        try:
            guild_id = int((await request.json())["guild"])
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "guild required"}, status=400)
        guild = self.bot.get_guild(guild_id)
        season = world_quests.season_key(_today())
        top = await db.world_stat_top(guild_id, f"s:{season}:tank_kills", 10)
        entries = []
        for uid, kills in top:
            stats = await db.get_world_stats(guild_id, uid)
            member = guild.get_member(uid) if guild is not None else None
            entries.append({
                "id": str(uid),
                "name": clean_display_name(member, fallback=f"Kullanıcı {str(uid)[-4:]}"),
                "kills": kills,
                "wins": stats.get(f"s:{season}:tank_wins", 0),
            })
        return web.json_response({"season": season, "top": entries})

    async def handle_photo(self, request: web.Request) -> web.Response:
        """Dünyada çekilen fotoğraf: {"guild", "user", "image" (base64 JPEG)} → fotoğraf kanalına gönderilir."""
        parsed = await self._member_request(request)
        if isinstance(parsed, web.Response):
            return parsed
        guild, user_id, body = parsed
        if not PHOTO_CHANNEL_ID:
            return web.json_response({"ok": False, "reason": "no_channel"})
        try:
            data = base64.b64decode(str(body["image"]), validate=True)
        except (KeyError, binascii.Error, ValueError):
            return web.json_response({"error": "image required"}, status=400)
        if not data.startswith(b"\xff\xd8") or len(data) > PHOTO_MAX_BYTES:
            return web.json_response({"error": "jpeg up to 3 MB"}, status=400)
        channel = guild.get_channel(PHOTO_CHANNEL_ID)
        if not isinstance(channel, discord.abc.Messageable):
            return web.json_response({"ok": False, "reason": "no_channel"})
        try:
            await channel.send(
                f"📸 <@{user_id}> GAP Dünyası'ndan bir kare paylaştı!",
                file=discord.File(io.BytesIO(data), filename="gap-dunyasi.jpg"),
                allowed_mentions=discord.AllowedMentions.none(),
            )
        except discord.HTTPException as err:
            log.warning("Fotoğraf gönderilemedi: %s", err)
            return web.json_response({"ok": False, "reason": "send_failed"})
        activitylog.record("world", guild.id, user_id, amount=1, kind="photo")
        completed = await world_quests.record(guild.id, user_id, "photo", 1, _today())
        return web.json_response({"ok": True, "completed": await self._grant_quests(guild, user_id, completed)})

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

    @commands.command(name="dünyadurum", aliases=["dunyadurum", "dünyastat", "worldstats"])
    @commands.guild_only()
    @commands.has_permissions(administrator=True)
    async def world_stats_command(self, ctx: commands.Context) -> None:
        """Admin: GAP Dünyası'nın anlık yükü (sinema video aktarımının upload hızı, akışlar, oyuncular)."""
        if self._client is None:
            await ctx.send("ℹ️ GAP Dünyası bu botta bağlı değil.")
            return
        try:
            r = await self._client.get(f"{self.url}/internal/stats")
            r.raise_for_status()
            data = r.json()
        except (httpx.HTTPError, ValueError) as e:
            log.warning("Dünya istatistikleri alınamadı: %s", e)
            await ctx.send("❌ GAP Dünyası'na şu an ulaşılamıyor.")
            return
        m = data.get("media", {})
        hit = f"%{100 * m.get('hits', 0) / m['requests']:.0f}" if m.get("requests") else "—"
        embed = discord.Embed(title="🌍 GAP Dünyası durumu", color=discord.Color.from_rgb(88, 101, 242))
        embed.add_field(name="Video upload (son 10 sn)", value=f"**{m.get('mbps', 0)} Mbit/sn**", inline=True)
        embed.add_field(name="Aktif akış", value=str(m.get("active", 0)), inline=True)
        embed.add_field(name="Önbellek isabeti", value=hit, inline=True)
        embed.add_field(name="Toplam gönderilen", value=f"{m.get('bytes', 0) / 1e9:.2f} GB", inline=True)
        embed.add_field(name="Oda / oyuncu", value=f"{data.get('rooms', 0)} / {data.get('players', 0)}", inline=True)
        embed.set_footer(text="Sayaçlar dünya sunucusu yeniden başlayınca sıfırlanır")
        await ctx.send(embed=embed)

    @world_stats_command.error
    async def _world_stats_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MissingPermissions):
            await ctx.send("❌ Bu komut için yönetici yetkisi gerekli.")
        else:
            raise error

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
