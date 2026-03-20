import io
from pathlib import Path

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont, ImageOps

from xp import XPTrackerCog


CARD_BACKGROUND_PATH = Path(__file__).with_name("assets") / "userkart.png"

CARD_WIDTH = 1050
CARD_HEIGHT = 600
AVATAR_SIZE = 180
AVATAR_POSITION = (70, 150)
RANK_CENTER = (901, 111)
BAR_BOX = (318, 474, 905, 522)
BAR_INNER_PADDING = 8

TEXT_PRIMARY = "#F7F7F8"
TEXT_SECONDARY = "#B8C0D9"
TEXT_MUTED = "#8D98B7"
ACCENT_GLOW = "#B18BFF"
BAR_BG = "#2A2140"
BAR_FILL = "#8F63FF"
BAR_FILL_END = "#B794FF"


class UserCardCog(commands.Cog):
	def __init__(self, bot: commands.Bot) -> None:
		self.bot = bot

	def get_xp_tracker(self) -> XPTrackerCog:
		xp_tracker = self.bot.get_cog("XPTrackerCog")
		if not isinstance(xp_tracker, XPTrackerCog):
			raise RuntimeError("XP sistemi yüklenemedi.")
		return xp_tracker

	@staticmethod
	def truncate_text(text: str, max_length: int) -> str:
		if len(text) <= max_length:
			return text
		return text[: max_length - 1] + "…"

	@staticmethod
	def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
		font_candidates = []
		if bold:
			font_candidates.extend([
				r"C:\Windows\Fonts\arialbd.ttf",
				r"C:\Windows\Fonts\segoeuib.ttf",
			])
		font_candidates.extend([
			r"C:\Windows\Fonts\arial.ttf",
			r"C:\Windows\Fonts\segoeui.ttf",
		])

		for font_path in font_candidates:
			try:
				return ImageFont.truetype(font_path, size)
			except OSError:
				continue

		return ImageFont.load_default()

	@staticmethod
	def draw_text(
		draw: ImageDraw.ImageDraw,
		position: tuple[int, int],
		text: str,
		font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
		fill: str,
		anchor: str | None = None,
		shadow: bool = True,
	) -> None:
		if shadow:
			draw.text((position[0] + 2, position[1] + 2), text, font=font, fill="#120F1D", anchor=anchor)
		draw.text(position, text, font=font, fill=fill, anchor=anchor)

	@staticmethod
	async def fetch_avatar_image(member: discord.Member) -> Image.Image:
		avatar_asset = member.display_avatar.replace(size=256, format="png")
		avatar_bytes = await avatar_asset.read()
		avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA")
		avatar = ImageOps.fit(avatar, (AVATAR_SIZE, AVATAR_SIZE), centering=(0.5, 0.5))

		mask = Image.new("L", (AVATAR_SIZE, AVATAR_SIZE), 0)
		mask_draw = ImageDraw.Draw(mask)
		mask_draw.ellipse((0, 0, AVATAR_SIZE, AVATAR_SIZE), fill=255)
		avatar.putalpha(mask)
		return avatar

	@staticmethod
	def create_horizontal_gradient(width: int, height: int, start_color: str, end_color: str) -> Image.Image:
		gradient = Image.new("RGBA", (width, height), start_color)
		base = Image.new("RGBA", (width, height), end_color)
		mask = Image.new("L", (width, 1))
		mask.putdata([int(255 * (index / max(1, width - 1))) for index in range(width)])
		mask = mask.resize((width, height))
		return Image.composite(base, gradient, mask)

	def draw_progress_bar(self, card: Image.Image, progress_ratio: float) -> None:
		draw = ImageDraw.Draw(card)
		x1, y1, x2, y2 = BAR_BOX
		radius = (y2 - y1) // 2
		draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, fill=BAR_BG)

		inner_box = (
			x1 + BAR_INNER_PADDING,
			y1 + BAR_INNER_PADDING,
			x2 - BAR_INNER_PADDING,
			y2 - BAR_INNER_PADDING,
		)
		inner_width = inner_box[2] - inner_box[0]
		fill_width = max(radius, int(inner_width * progress_ratio)) if progress_ratio > 0 else 0

		if fill_width > 0:
			gradient = self.create_horizontal_gradient(fill_width, inner_box[3] - inner_box[1], BAR_FILL, BAR_FILL_END)
			fill_mask = Image.new("L", (fill_width, inner_box[3] - inner_box[1]), 0)
			mask_draw = ImageDraw.Draw(fill_mask)
			mask_draw.rounded_rectangle(
				(0, 0, fill_width, inner_box[3] - inner_box[1]),
				radius=max(8, radius - BAR_INNER_PADDING),
				fill=255,
			)
			card.paste(gradient, (inner_box[0], inner_box[1]), fill_mask)

		draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, outline=ACCENT_GLOW, width=2)

	@staticmethod
	def create_card_background() -> Image.Image:
		if CARD_BACKGROUND_PATH.exists():
			return Image.open(CARD_BACKGROUND_PATH).convert("RGBA")

		card = Image.new("RGBA", (CARD_WIDTH, CARD_HEIGHT), "#171223")
		draw = ImageDraw.Draw(card)
		draw.rounded_rectangle((20, 20, CARD_WIDTH - 20, CARD_HEIGHT - 20), radius=30, fill="#201833")
		return card

	@staticmethod
	def format_xp_progress(current_xp: int, next_xp: int) -> str:
		if next_xp <= current_xp:
			return "MAX"
		return f"{current_xp:,} / {next_xp:,} XP"

	async def build_user_card(self, member: discord.Member) -> io.BytesIO:
		xp_tracker = self.get_xp_tracker()
		stats = xp_tracker.get_user_stats(member.guild.id, member.id)
		if stats is None:
			raise ValueError("Kullanıcı verisi bulunamadı.")

		total_xp = int(stats["total_xp"])
		live_voice_seconds = xp_tracker.get_live_voice_seconds(member.guild.id, member.id, int(stats["voice_seconds"]))
		rank = xp_tracker.get_user_rank(member.guild.id, member.id)
		level, next_level, current_floor, next_ceiling, progress_ratio = xp_tracker.get_progress_data(total_xp)
		current_role = xp_tracker.get_display_role(member)

		card = self.create_card_background().resize((CARD_WIDTH, CARD_HEIGHT))
		avatar = await self.fetch_avatar_image(member)
		card.paste(avatar, AVATAR_POSITION, avatar)
		draw = ImageDraw.Draw(card)

		name_font = self.load_font(42, bold=True)
		username_font = self.load_font(24)
		label_font = self.load_font(22)
		value_font = self.load_font(30, bold=True)
		rank_font = self.load_font(34, bold=True)
		level_font = self.load_font(28, bold=True)
		progress_font = self.load_font(20, bold=True)

		self.draw_text(draw, (287, 142), self.truncate_text(member.display_name, 22), name_font, TEXT_PRIMARY)
		username = f"@{member.name}"
		self.draw_text(draw, (289, 191), self.truncate_text(username, 28), username_font, TEXT_SECONDARY)

		left_label_x = 289
		left_value_x = 289
		right_label_x = 632
		right_value_x = 632

		self.draw_text(draw, (left_label_x, 254), "Current Role", label_font, TEXT_MUTED)
		self.draw_text(draw, (left_value_x, 284), self.truncate_text(current_role, 20), value_font, TEXT_PRIMARY)

		self.draw_text(draw, (right_label_x, 254), "Total XP", label_font, TEXT_MUTED)
		self.draw_text(draw, (right_value_x, 284), f"{total_xp:,}", value_font, TEXT_PRIMARY)

		self.draw_text(draw, (left_label_x, 352), "Messages Sent", label_font, TEXT_MUTED)
		self.draw_text(draw, (left_value_x, 382), f"{int(stats['message_count']):,}", value_font, TEXT_PRIMARY)

		self.draw_text(draw, (right_label_x, 352), "Voice Time", label_font, TEXT_MUTED)
		self.draw_text(draw, (right_value_x, 382), xp_tracker.format_duration(live_voice_seconds), value_font, TEXT_PRIMARY)

		self.draw_text(draw, RANK_CENTER, str(rank), rank_font, TEXT_PRIMARY, anchor="mm")

		self.draw_progress_bar(card, progress_ratio)
		self.draw_text(draw, (318, 431), f"Level {level}", level_font, TEXT_PRIMARY)

		if next_ceiling <= current_floor:
			next_label = "MAX"
		else:
			next_label = f"Level {next_level}"

		self.draw_text(draw, (905, 431), next_label, level_font, TEXT_PRIMARY, anchor="ra")
		self.draw_text(draw, (611, 535), self.format_xp_progress(total_xp, next_ceiling), progress_font, TEXT_SECONDARY, anchor="mm")

		buffer = io.BytesIO()
		card.save(buffer, format="PNG")
		buffer.seek(0)
		return buffer

	@commands.command(name="kart")
	async def kart_command(self, ctx: commands.Context, member: discord.Member | None = None) -> None:
		if ctx.guild is None:
			await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
			return

		target = member or ctx.author
		if not isinstance(target, discord.Member):
			await ctx.send("Kullanıcı bilgisi alınamadı.")
			return

		self.get_xp_tracker().ensure_user(ctx.guild.id, target.id)

		try:
			card_buffer = await self.build_user_card(target)
		except Exception as error:
			await ctx.send(f"Kart oluşturulamadı: {error}")
			return

		await ctx.send(file=discord.File(card_buffer, filename=f"kart-{target.id}.png"))