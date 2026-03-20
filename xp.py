import random
import sqlite3
import time
from pathlib import Path

import discord
from discord.ext import commands, tasks

from xproles import XPRoleManager


DATABASE_PATH = Path(__file__).with_name("xp_system.db")

MESSAGE_XP_MIN = 3
MESSAGE_XP_MAX = 8
MESSAGE_COOLDOWN_SECONDS = 20
VOICE_XP_INTERVAL_MINUTES = 2
VOICE_XP_PER_INTERVAL = 1


class XPTrackerCog(commands.Cog):
	def __init__(self, bot: commands.Bot) -> None:
		self.bot = bot
		self.role_manager = XPRoleManager()
		self.message_cooldowns: dict[tuple[int, int], float] = {}
		self.voice_join_times: dict[tuple[int, int], float] = {}
		self.setup_database()

	def cog_unload(self) -> None:
		self.voice_xp_loop.cancel()

	def get_connection(self) -> sqlite3.Connection:
		connection = sqlite3.connect(DATABASE_PATH)
		connection.row_factory = sqlite3.Row
		return connection

	def setup_database(self) -> None:
		with self.get_connection() as connection:
			connection.execute(
				"""
				CREATE TABLE IF NOT EXISTS user_xp (
					guild_id INTEGER NOT NULL,
					user_id INTEGER NOT NULL,
					text_xp INTEGER NOT NULL DEFAULT 0,
					voice_xp INTEGER NOT NULL DEFAULT 0,
					voice_seconds INTEGER NOT NULL DEFAULT 0,
					message_count INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY (guild_id, user_id)
				)
				"""
			)

			columns = {
				row["name"]
				for row in connection.execute("PRAGMA table_info(user_xp)").fetchall()
			}

			if "voice_seconds" not in columns:
				connection.execute(
					"ALTER TABLE user_xp ADD COLUMN voice_seconds INTEGER NOT NULL DEFAULT 0"
				)

			if "message_count" not in columns:
				connection.execute(
					"ALTER TABLE user_xp ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0"
				)

	def ensure_user(self, guild_id: int, user_id: int) -> None:
		with self.get_connection() as connection:
			connection.execute(
				"""
				INSERT OR IGNORE INTO user_xp (
					guild_id, user_id, text_xp, voice_xp, voice_seconds, message_count
				)
				VALUES (?, ?, 0, 0, 0, 0)
				""",
				(guild_id, user_id),
			)

	def add_text_xp(self, guild_id: int, user_id: int, amount: int) -> None:
		self.ensure_user(guild_id, user_id)
		with self.get_connection() as connection:
			connection.execute(
				"""
				UPDATE user_xp
				SET text_xp = text_xp + ?
				WHERE guild_id = ? AND user_id = ?
				""",
				(amount, guild_id, user_id),
			)

	def add_voice_xp(self, guild_id: int, user_id: int, amount: int) -> None:
		self.ensure_user(guild_id, user_id)
		with self.get_connection() as connection:
			connection.execute(
				"""
				UPDATE user_xp
				SET voice_xp = voice_xp + ?
				WHERE guild_id = ? AND user_id = ?
				""",
				(amount, guild_id, user_id),
			)

	def add_voice_seconds(self, guild_id: int, user_id: int, amount: int) -> None:
		if amount <= 0:
			return

		self.ensure_user(guild_id, user_id)
		with self.get_connection() as connection:
			connection.execute(
				"""
				UPDATE user_xp
				SET voice_seconds = voice_seconds + ?
				WHERE guild_id = ? AND user_id = ?
				""",
				(amount, guild_id, user_id),
			)

	def add_message_count(self, guild_id: int, user_id: int, amount: int = 1) -> None:
		if amount <= 0:
			return

		self.ensure_user(guild_id, user_id)
		with self.get_connection() as connection:
			connection.execute(
				"""
				UPDATE user_xp
				SET message_count = message_count + ?
				WHERE guild_id = ? AND user_id = ?
				""",
				(amount, guild_id, user_id),
			)

	def get_user_stats(self, guild_id: int, user_id: int) -> sqlite3.Row | None:
		self.ensure_user(guild_id, user_id)
		with self.get_connection() as connection:
			return connection.execute(
				"""
				SELECT
					text_xp,
					voice_xp,
					voice_seconds,
					message_count,
					(text_xp + voice_xp) AS total_xp
				FROM user_xp
				WHERE guild_id = ? AND user_id = ?
				""",
				(guild_id, user_id),
			).fetchone()

	def get_user_xp(self, guild_id: int, user_id: int) -> tuple[int, int, int, int]:
		row = self.get_user_stats(guild_id, user_id)

		if row is None:
			return 0, 0, 0, 0

		return row["text_xp"], row["voice_xp"], row["total_xp"], row["voice_seconds"]

	def get_leaderboard(self, guild_id: int, limit: int = 10) -> list[sqlite3.Row]:
		with self.get_connection() as connection:
			return connection.execute(
				"""
				SELECT user_id, text_xp, voice_xp, voice_seconds, message_count, (text_xp + voice_xp) AS total_xp
				FROM user_xp
				WHERE guild_id = ?
				ORDER BY total_xp DESC, voice_xp DESC, text_xp DESC
				LIMIT ?
				""",
				(guild_id, limit),
			).fetchall()

	def get_user_rank(self, guild_id: int, user_id: int) -> int:
		stats = self.get_user_stats(guild_id, user_id)
		if stats is None:
			return 0

		with self.get_connection() as connection:
			higher_count = connection.execute(
				"""
				SELECT COUNT(*)
				FROM user_xp
				WHERE guild_id = ?
				AND (
					(text_xp + voice_xp) > ?
					OR ((text_xp + voice_xp) = ? AND voice_xp > ?)
					OR ((text_xp + voice_xp) = ? AND voice_xp = ? AND text_xp > ?)
					OR ((text_xp + voice_xp) = ? AND voice_xp = ? AND text_xp = ? AND user_id < ?)
				)
				""",
				(
					guild_id,
					stats["total_xp"],
					stats["total_xp"],
					stats["voice_xp"],
					stats["total_xp"],
					stats["voice_xp"],
					stats["text_xp"],
					stats["total_xp"],
					stats["voice_xp"],
					stats["text_xp"],
					user_id,
				),
			).fetchone()[0]

		return int(higher_count) + 1

	def can_gain_message_xp(self, guild_id: int, user_id: int) -> bool:
		current_time = time.time()
		cooldown_key = (guild_id, user_id)
		last_time = self.message_cooldowns.get(cooldown_key, 0)

		if current_time - last_time < MESSAGE_COOLDOWN_SECONDS:
			return False

		self.message_cooldowns[cooldown_key] = current_time
		return True

	@staticmethod
	def is_valid_voice_member(member: discord.Member) -> bool:
		voice_state = member.voice
		if member.bot or voice_state is None or voice_state.channel is None:
			return False
		if voice_state.self_deaf or voice_state.deaf:
			return False
		return True

	@staticmethod
	def is_in_voice(state: discord.VoiceState | None) -> bool:
		return state is not None and state.channel is not None

	def start_voice_session(self, guild_id: int, user_id: int) -> None:
		self.voice_join_times.setdefault((guild_id, user_id), time.time())

	def end_voice_session(self, guild_id: int, user_id: int) -> None:
		started_at = self.voice_join_times.pop((guild_id, user_id), None)
		if started_at is None:
			return

		elapsed_seconds = max(0, int(time.time() - started_at))
		self.add_voice_seconds(guild_id, user_id, elapsed_seconds)

	def get_live_voice_seconds(self, guild_id: int, user_id: int, stored_seconds: int) -> int:
		started_at = self.voice_join_times.get((guild_id, user_id))
		if started_at is None:
			return stored_seconds
		return stored_seconds + max(0, int(time.time() - started_at))

	@staticmethod
	def format_duration(total_seconds: int) -> str:
		hours, remainder = divmod(total_seconds, 3600)
		minutes, seconds = divmod(remainder, 60)
		return f"{hours}s {minutes}dk {seconds}sn"

	def restore_active_voice_sessions(self) -> None:
		for guild in self.bot.guilds:
			for member in guild.members:
				if member.bot:
					continue
				if member.voice is not None and member.voice.channel is not None:
					self.start_voice_session(guild.id, member.id)

	def get_progress_data(self, total_xp: int) -> tuple[int, int, int, int, float]:
		return self.role_manager.get_progress_data(total_xp)

	def get_managed_role_ids(self) -> set[int]:
		return self.role_manager.get_managed_role_ids()

	def get_target_role(self, member: discord.Member) -> discord.Role | None:
		_, _, total_xp, _ = self.get_user_xp(member.guild.id, member.id)
		return self.role_manager.get_target_role(member, total_xp)

	def get_display_role(self, member: discord.Member) -> str:
		_, _, total_xp, _ = self.get_user_xp(member.guild.id, member.id)
		return self.role_manager.get_display_role(member, total_xp)

	async def sync_xp_role(self, member: discord.Member) -> None:
		_, _, total_xp, _ = self.get_user_xp(member.guild.id, member.id)
		await self.role_manager.sync_member_role(member, total_xp)

	@commands.Cog.listener()
	async def on_ready(self) -> None:
		self.restore_active_voice_sessions()
		if not self.voice_xp_loop.is_running():
			self.voice_xp_loop.start()
		print(f"Bot aktif: {self.bot.user}")

	@commands.Cog.listener()
	async def on_member_join(self, member: discord.Member) -> None:
		self.ensure_user(member.guild.id, member.id)
		await self.sync_xp_role(member)

	@commands.Cog.listener()
	async def on_message(self, message: discord.Message) -> None:
		if message.author.bot or message.guild is None:
			return

		context = await self.bot.get_context(message)
		if context.valid:
			return

		self.add_message_count(message.guild.id, message.author.id)

		if self.can_gain_message_xp(message.guild.id, message.author.id):
			earned_xp = random.randint(MESSAGE_XP_MIN, MESSAGE_XP_MAX)
			self.add_text_xp(message.guild.id, message.author.id, earned_xp)
			if isinstance(message.author, discord.Member):
				await self.sync_xp_role(message.author)

	@commands.Cog.listener()
	async def on_voice_state_update(
		self,
		member: discord.Member,
		before: discord.VoiceState,
		after: discord.VoiceState,
	) -> None:
		if member.bot or member.guild is None:
			return

		was_in_voice = self.is_in_voice(before)
		is_now_in_voice = self.is_in_voice(after)

		if not was_in_voice and is_now_in_voice:
			self.ensure_user(member.guild.id, member.id)
			self.start_voice_session(member.guild.id, member.id)
			return

		if was_in_voice and not is_now_in_voice:
			self.end_voice_session(member.guild.id, member.id)

	@tasks.loop(minutes=VOICE_XP_INTERVAL_MINUTES)
	async def voice_xp_loop(self) -> None:
		for guild in self.bot.guilds:
			for voice_channel in guild.voice_channels:
				valid_members = [member for member in voice_channel.members if self.is_valid_voice_member(member)]

				if len(valid_members) < 2:
					continue

				for member in valid_members:
					self.add_voice_xp(guild.id, member.id, VOICE_XP_PER_INTERVAL)
					await self.sync_xp_role(member)

	@voice_xp_loop.before_loop
	async def before_voice_xp_loop(self) -> None:
		await self.bot.wait_until_ready()

	@commands.command(name="xp")
	async def xp_command(self, ctx: commands.Context) -> None:
		if ctx.guild is None:
			await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
			return

		stats = self.get_user_stats(ctx.guild.id, ctx.author.id)
		if stats is None:
			await ctx.send("Kullanıcı verisi bulunamadı.")
			return

		text_xp, voice_xp, total_xp, voice_seconds = self.get_user_xp(ctx.guild.id, ctx.author.id)
		live_voice_seconds = self.get_live_voice_seconds(ctx.guild.id, ctx.author.id, voice_seconds)
		embed = discord.Embed(title="XP Durumun", color=discord.Color.blurple())
		embed.add_field(name="Mesaj XP", value=str(text_xp), inline=True)
		embed.add_field(name="Ses XP", value=str(voice_xp), inline=True)
		embed.add_field(name="Toplam XP", value=str(total_xp), inline=False)
		embed.add_field(name="Toplam Mesaj", value=str(stats["message_count"]), inline=True)
		embed.add_field(name="Ses Süresi", value=self.format_duration(live_voice_seconds), inline=False)
		await ctx.send(embed=embed)

	@commands.command(name="ses")
	async def ses_command(self, ctx: commands.Context) -> None:
		if ctx.guild is None:
			await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
			return

		_, _, _, voice_seconds = self.get_user_xp(ctx.guild.id, ctx.author.id)
		live_voice_seconds = self.get_live_voice_seconds(ctx.guild.id, ctx.author.id, voice_seconds)
		await ctx.send(f"Toplam ses süren: {self.format_duration(live_voice_seconds)}")

	@commands.command(name="topxp")
	async def topxp_command(self, ctx: commands.Context) -> None:
		if ctx.guild is None:
			await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
			return

		rows = self.get_leaderboard(ctx.guild.id)
		if not rows:
			await ctx.send("Henüz XP verisi yok.")
			return

		lines = []
		for index, row in enumerate(rows, start=1):
			member = ctx.guild.get_member(row["user_id"])
			member_name = member.display_name if member else f"Kullanıcı {row['user_id']}"
			lines.append(f"{index}. {member_name} — {row['total_xp']} XP")

		embed = discord.Embed(
			title="XP Sıralaması",
			description="\n".join(lines),
			color=discord.Color.gold(),
		)
		await ctx.send(embed=embed)

	@commands.command(name="xpsenkronize")
	@commands.has_permissions(administrator=True)
	async def xpsenkronize_command(self, ctx: commands.Context) -> None:
		if ctx.guild is None:
			await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
			return

		count = 0
		for member in ctx.guild.members:
			if member.bot:
				continue
			self.ensure_user(ctx.guild.id, member.id)
			await self.sync_xp_role(member)
			count += 1

		await ctx.send(f"XP rol kontrolü tamamlandı. Kontrol edilen üye: {count}")

	@xpsenkronize_command.error
	async def xpsenkronize_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
		if isinstance(error, commands.MissingPermissions):
			await ctx.send("Bu komut için yönetici yetkisi gerekli.")
			return
		raise error