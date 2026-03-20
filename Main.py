import os
from pathlib import Path

import discord
from discord.ext import commands
from dotenv import load_dotenv

from usercard import UserCardCog
from xp import XPTrackerCog


PROJECT_ROOT = Path(__file__).resolve().parent
ENV_PATH = PROJECT_ROOT / ".env"

load_dotenv(dotenv_path=ENV_PATH, override=True)

TOKEN = os.getenv("DISCORD_TOKEN", "").strip()
PREFIX = os.getenv("BOT_PREFIX", "!").strip() or "!"


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


def main() -> None:
	validate_settings()
	bot = GapBot(command_prefix=PREFIX, intents=build_intents())
	bot.run(TOKEN)


if __name__ == "__main__":
	main()