"""
Main.py — Bot giriş noktası.

Yüklenecek cog'lar:
  - XPTrackerCog   (xp.py)
    - BestFriendCog  (bestfriend.py)
  - UserCardCog    (usercard.py)
  - LeaderboardCog (leaderboard.py)
  - InfoCog        (info.py)
  - AuditCog       (audit.py) — olay kaydı, hile tespiti, analiz komutları
  - ExileCog       (exile.py) — !sürgün XP cezası ve !sürgünler kartı
  - SummaryCog     (summary.py) — haftalık özet ve aylık Wrapped kartları
  - AchievementCog (achievement_cog.py) — başarımlar, !başarımlar fuları, !kartdüzen
  - WorldCog       (world_cog.py) — GAP Dünyası: sürgündekileri 3D dünyadaki zindana yollar
  - AICog          (ai/)      — isteğe bağlı hafızalı sohbet (AI_ENABLED=true ise)
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import discord
from discord.ext import commands
from dotenv import load_dotenv

import activitylog
from achievement_cog import AchievementCog
from audit import AuditCog
from bestfriend import BestFriendCog
from exile import ExileCog
from info import InfoCog
from leaderboard import LeaderboardCog
from summary import SummaryCog
from textutils import fold
from usercard import UserCardCog
from world_cog import WorldCog
from xp import XPTrackerCog

if os.name == "nt":
    import msvcrt
else:
    import fcntl

PROJECT_ROOT = Path(__file__).resolve().parent
LOCK_PATH = PROJECT_ROOT / ".botgap.lock"

load_dotenv(dotenv_path=PROJECT_ROOT / ".env", override=True)
TOKEN  = os.getenv("DISCORD_TOKEN", "").strip()
PREFIX = os.getenv("BOT_PREFIX", "!").strip() or "!"


# ---------------------------------------------------------------------------
# Tek instance kilidi
# ---------------------------------------------------------------------------

class BotAlreadyRunningError(RuntimeError):
    pass


class SingleInstanceLock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._handle = None

    def acquire(self) -> None:
        self.path.touch(exist_ok=True)
        self._handle = self.path.open("a+", encoding="utf-8")
        self._handle.seek(0, os.SEEK_END)
        if self._handle.tell() == 0:
            self._handle.write("0")
            self._handle.flush()
        self._handle.seek(0)

        try:
            if os.name == "nt":
                msvcrt.locking(self._handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, PermissionError) as exc:
            self._handle.close()
            self._handle = None
            raise BotAlreadyRunningError(
                "Bot zaten çalışıyor. Önce mevcut bot sürecini kapat."
            ) from exc

        self._handle.seek(0)
        self._handle.truncate()
        self._handle.write(str(os.getpid()))
        self._handle.flush()

    def release(self) -> None:
        if self._handle is None:
            return
        try:
            if os.name == "nt":
                # msvcrt.locking dosyanın o anki konumundan itibaren çalışır;
                # PID yazıldıktan sonra konum 0'da değil, kilitli byte'a dön.
                self._handle.seek(0)
                msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._handle.close()
            self._handle = None


# ---------------------------------------------------------------------------
# Bot
# ---------------------------------------------------------------------------

def _intents() -> discord.Intents:
    intents = discord.Intents.default()
    intents.message_content = True
    intents.members = True
    intents.voice_states = True
    intents.guilds = True
    return intents


def _validate() -> None:
    if not TOKEN:
        raise ValueError(".env içindeki DISCORD_TOKEN alanına bot tokenını eklemelisin.")


class GapBot(commands.Bot):
    _folded_commands: dict[str, commands.Command] = {}
    _folded_count = -1

    async def get_context(self, origin, /, *, cls=commands.Context):
        """Komut bulunamazsa Türkçe karakterlere duyarsız tekrar arar (!basarımlar → !başarımlar)."""
        ctx = await super().get_context(origin, cls=cls)
        if ctx.command is None and ctx.invoked_with:
            ctx.command = self._folded_lookup(ctx.invoked_with)
        return ctx

    def _folded_lookup(self, name: str) -> commands.Command | None:
        if self._folded_count != len(self.all_commands):
            folded: dict[str, commands.Command] = {}
            for command in self.walk_commands():
                for alias in (command.name, *command.aliases):
                    folded.setdefault(fold(alias), command)
            self._folded_commands, self._folded_count = folded, len(self.all_commands)
        return self._folded_commands.get(fold(name))

    async def setup_hook(self) -> None:
        await self.add_cog(XPTrackerCog(self))
        await self.add_cog(BestFriendCog(self))
        await self.add_cog(UserCardCog(self))
        await self.add_cog(LeaderboardCog(self))
        await self.add_cog(InfoCog(self))
        await self.add_cog(AuditCog(self))
        await self.add_cog(ExileCog(self))
        await self.add_cog(SummaryCog(self))
        await self.add_cog(AchievementCog(self))
        await self.add_cog(WorldCog(self))
        await self._load_ai()

    async def _load_ai(self) -> None:
        # İsteğe bağlı AI eklentisi; yüklenemezse bot onsuz devam eder.
        try:
            from ai import setup_ai

            await setup_ai(self)
        except Exception:
            logging.getLogger("gap").exception("AI modülü yüklenemedi; bot AI olmadan devam ediyor")

    async def close(self) -> None:
        await activitylog.stop()
        await super().close()


def main() -> None:
    activitylog.setup_logging()
    _validate()
    lock = SingleInstanceLock(LOCK_PATH)
    lock.acquire()
    bot = GapBot(
        command_prefix=PREFIX,
        intents=_intents(),
        help_command=None,
        case_insensitive=True,
    )
    try:
        # log_handler=None: discord.py kendi handler'ını kurmasın, setup_logging'deki kullanılsın
        bot.run(TOKEN, log_handler=None)
    finally:
        lock.release()


if __name__ == "__main__":
    try:
        main()
    except BotAlreadyRunningError as err:
        logging.getLogger("gap").error("%s", err)
