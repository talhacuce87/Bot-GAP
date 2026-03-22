import os
from pathlib import Path

import discord
from discord.ext import commands
from dotenv import load_dotenv

from leaderboard import LeaderboardCog
from usercard import UserCardCog
from xp import XPTrackerCog

if os.name == "nt":
	import msvcrt
else:
	import fcntl


PROJECT_ROOT = Path(__file__).resolve().parent
ENV_PATH = PROJECT_ROOT / ".env"
LOCK_PATH = PROJECT_ROOT / ".botgap.lock"

load_dotenv(dotenv_path=ENV_PATH, override=True)

TOKEN = os.getenv("DISCORD_TOKEN", "").strip()
PREFIX = os.getenv("BOT_PREFIX", "!").strip() or "!"


class BotAlreadyRunningError(RuntimeError):
	pass


class SingleInstanceLock:
	def __init__(self, lock_path: Path) -> None:
		self.lock_path = lock_path
		self.handle = None

	def acquire(self) -> None:
		self.lock_path.touch(exist_ok=True)
		self.handle = self.lock_path.open("a+", encoding="utf-8")
		self.handle.seek(0, os.SEEK_END)
		if self.handle.tell() == 0:
			self.handle.write("0")
			self.handle.flush()
		self.handle.seek(0)

		try:
			if os.name == "nt":
				msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
			else:
				fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
		except (OSError, PermissionError) as error:
			self.handle.close()
			self.handle = None
			raise BotAlreadyRunningError("Bot zaten çalışıyor. Önce mevcut bot sürecini kapat.") from error

		self.handle.seek(0)
		self.handle.truncate()
		self.handle.write(str(os.getpid()))
		self.handle.flush()

	def release(self) -> None:
		if self.handle is None:
			return

		self.handle.seek(0)
		try:
			if os.name == "nt":
				msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
			else:
				fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
		finally:
			self.handle.close()
			self.handle = None


def build_intents() -> discord.Intents:
	intents = discord.Intents.default()
	intents.message_content = True
	intents.members = True
	intents.voice_states = True
	intents.guilds = True
	return intents


def validate_settings() -> None:
	if not TOKEN:
		raise ValueError(".env içindeki DISCORD_TOKEN alanına bot tokenını eklemelisin.")


class GapBot(commands.Bot):
	async def setup_hook(self) -> None:
		await self.add_cog(XPTrackerCog(self))
		await self.add_cog(UserCardCog(self))
		await self.add_cog(LeaderboardCog(self))


def main() -> None:
	instance_lock = SingleInstanceLock(LOCK_PATH)
	instance_lock.acquire()
	validate_settings()
	bot = GapBot(command_prefix=PREFIX, intents=build_intents())
	try:
		bot.run(TOKEN)
	finally:
		instance_lock.release()


if __name__ == "__main__":
	try:
		main()
	except BotAlreadyRunningError as error:
		print(error)