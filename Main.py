"""
Main.py — Bot giriş noktası.

Yüklenecek cog'lar:
  - XPTrackerCog   (xp.py)
    - BestFriendCog  (bestfriend.py)
  - UserCardCog    (usercard.py)
  - LeaderboardCog (leaderboard.py)
"""

from __future__ import annotations

import os
from pathlib import Path

import discord
from discord.ext import commands
from dotenv import load_dotenv

from bestfriend import BestFriendCog
from leaderboard import LeaderboardCog
from usercard import UserCardCog
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
    async def setup_hook(self) -> None:
        await self.add_cog(XPTrackerCog(self))
        await self.add_cog(BestFriendCog(self))
        await self.add_cog(UserCardCog(self))
        await self.add_cog(LeaderboardCog(self))


def main() -> None:
    lock = SingleInstanceLock(LOCK_PATH)
    lock.acquire()
    _validate()
    bot = GapBot(command_prefix=PREFIX, intents=_intents())
    try:
        bot.run(TOKEN)
    finally:
        lock.release()


if __name__ == "__main__":
    try:
        main()
    except BotAlreadyRunningError as err:
        print(err)
