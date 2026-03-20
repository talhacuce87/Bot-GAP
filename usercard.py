import io
from pathlib import Path

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont, ImageOps

from xp import XPTrackerCog


CARD_WIDTH = 1050
CARD_HEIGHT = 600
AVATAR_SIZE = 150
AVATAR_POSITION = (76, 120)
RANK_CENTER = (886, 136)
BAR_BOX = (285, 482, 948, 526)
BAR_INNER_PADDING = 6

TEXT_PRIMARY = "#F5F7FB"
TEXT_SECONDARY = "#C9D4E4"
TEXT_MUTED = "#8EA0BC"
PANEL_FILL = (11, 19, 35, 220)
PANEL_OUTLINE = "#233252"
ACCENT = "#58E1C1"
ACCENT_ALT = "#6D7DFF"
BAR_BG = "#17233D"
BAR_FILL = "#47D7C3"
BAR_FILL_END = "#6A7BFF"


class UserCardCog(commands.Cog):
	def __init__(self, bot: commands.Bot) -> None:
		self.bot = bot

	def get_xp_tracker(self) -> XPTrackerCog:
		xp_tracker = self.bot.get_cog("XPTrackerCog")
		if not isinstance(xp_tracker, XPTrackerCog):
			raise RuntimeError("XP sistemi yüklenemedi.")
		return xp_tracker

	@staticmethod
	def hex_to_rgba(color: str, alpha: int = 255) -> tuple[int, int, int, int]:
		color = color.lstrip("#")
		return (
			int(color[0:2], 16),
			int(color[2:4], 16),
			int(color[4:6], 16),
			alpha,
		)

	@staticmethod
	def truncate_text(text: str, max_length: int) -> str:
		if len(text) <= max_length:
			return text
		return text[: max_length - 1] + "…"

	@staticmethod
	def fit_text_to_width(
		draw: ImageDraw.ImageDraw,
		text: str,
		font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
		max_width: int,
	) -> str:
		if draw.textbbox((0, 0), text, font=font)[2] <= max_width:
			return text

		trimmed = text
		while len(trimmed) > 1:
			trimmed = trimmed[:-1]
			candidate = trimmed.rstrip() + "…"
			if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
				return candidate

		return "…"

	def load_fitted_font(
		self,
		draw: ImageDraw.ImageDraw,
		text: str,
		start_size: int,
		max_width: int,
		min_size: int = 18,
		bold: bool = False,
	) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
		for font_size in range(start_size, min_size - 1, -1):
			font = self.load_font(font_size, bold=bold)
			if draw.textbbox((0, 0), text, font=font)[2] <= max_width:
				return font
		return self.load_font(min_size, bold=bold)

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
	def draw_panel(
		draw: ImageDraw.ImageDraw,
		box: tuple[int, int, int, int],
		radius: int = 28,
		fill: tuple[int, int, int, int] = PANEL_FILL,
		outline: str = PANEL_OUTLINE,
	) -> None:
		draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=2)

	@staticmethod
	def paste_glow(card: Image.Image, center: tuple[int, int], radius: int, color: str, alpha: int) -> None:
		glow = Image.new("RGBA", (radius * 2, radius * 2), (0, 0, 0, 0))
		glow_draw = ImageDraw.Draw(glow)
		for current_radius in range(radius, 0, -12):
			current_alpha = max(0, int(alpha * (current_radius / radius) ** 2))
			glow_draw.ellipse(
				(radius - current_radius, radius - current_radius, radius + current_radius, radius + current_radius),
				fill=UserCardCog.hex_to_rgba(color, current_alpha),
			)
		card.alpha_composite(glow, (center[0] - radius, center[1] - radius))

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

		draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, outline=ACCENT, width=2)

	@staticmethod
	def create_card_background() -> Image.Image:
		card = Image.new("RGBA", (CARD_WIDTH, CARD_HEIGHT), "#08111F")
		background = UserCardCog.create_horizontal_gradient(CARD_WIDTH, CARD_HEIGHT, "#0A1424", "#101B34")
		card.alpha_composite(background)
		UserCardCog.paste_glow(card, (140, 40), 180, "#2DE2C5", 70)
		UserCardCog.paste_glow(card, (960, 560), 220, "#5670FF", 80)
		UserCardCog.paste_glow(card, (860, 120), 120, "#46E2C4", 55)

		draw = ImageDraw.Draw(card)
		UserCardCog.draw_panel(draw, (30, 30, CARD_WIDTH - 30, CARD_HEIGHT - 30), radius=34, fill=(7, 13, 26, 232), outline="#203155")
		UserCardCog.draw_panel(draw, (56, 76, 245, 314), radius=28)
		UserCardCog.draw_panel(draw, (270, 182, 505, 292), radius=24)
		UserCardCog.draw_panel(draw, (530, 182, 765, 292), radius=24)
		UserCardCog.draw_panel(draw, (270, 314, 505, 424), radius=24)
		UserCardCog.draw_panel(draw, (530, 314, 765, 424), radius=24)
		UserCardCog.draw_panel(draw, (800, 70, 972, 242), radius=30)
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
		draw.ellipse((AVATAR_POSITION[0] - 7, AVATAR_POSITION[1] - 7, AVATAR_POSITION[0] + AVATAR_SIZE + 7, AVATAR_POSITION[1] + AVATAR_SIZE + 7), outline=ACCENT, width=4)

		name_font = self.load_font(46, bold=True)
		username_font = self.load_font(24)
		label_font = self.load_font(19)
		value_font = self.load_font(31, bold=True)
		rank_font = self.load_font(42, bold=True)
		level_font = self.load_font(28, bold=True)
		progress_font = self.load_font(18, bold=True)

		display_name = self.fit_text_to_width(draw, member.display_name, name_font, 430)
		self.draw_text(draw, (286, 92), display_name, name_font, TEXT_PRIMARY)
		username = self.fit_text_to_width(draw, f"@{member.name}", username_font, 280)
		self.draw_text(draw, (289, 144), username, username_font, TEXT_SECONDARY)

		left_label_x = 292
		left_value_x = 292
		right_label_x = 552
		right_value_x = 552

		self.draw_text(draw, (left_label_x, 206), "Current Role", label_font, TEXT_MUTED)
		role_font = self.load_fitted_font(draw, current_role, start_size=31, max_width=200, min_size=20, bold=True)
		self.draw_text(draw, (left_value_x, 242), current_role, role_font, TEXT_PRIMARY)

		self.draw_text(draw, (right_label_x, 206), "Total XP", label_font, TEXT_MUTED)
		self.draw_text(draw, (right_value_x, 242), f"{total_xp:,}", value_font, TEXT_PRIMARY)

		self.draw_text(draw, (left_label_x, 338), "Messages Sent", label_font, TEXT_MUTED)
		self.draw_text(draw, (left_value_x, 374), f"{int(stats['message_count']):,}", value_font, TEXT_PRIMARY)

		self.draw_text(draw, (right_label_x, 338), "Voice Time", label_font, TEXT_MUTED)
		voice_text = self.fit_text_to_width(draw, xp_tracker.format_duration(live_voice_seconds), value_font, 190)
		self.draw_text(draw, (right_value_x, 374), voice_text, value_font, TEXT_PRIMARY)

		self.draw_text(draw, (886, 96), "RANK", label_font, TEXT_MUTED, anchor="mm")
		self.draw_text(draw, RANK_CENTER, str(rank), rank_font, TEXT_PRIMARY, anchor="mm")
		self.draw_text(draw, (886, 188), f"Level {level}", label_font, ACCENT, anchor="mm")

		self.draw_progress_bar(card, progress_ratio)
		self.draw_text(draw, (286, 438), f"Level {level}", level_font, TEXT_PRIMARY)

		if next_ceiling <= current_floor:
			next_label = "MAX"
		else:
			next_label = f"Level {next_level}"

		self.draw_text(draw, (948, 438), next_label, level_font, TEXT_PRIMARY, anchor="rm")
		self.draw_text(draw, (616, 550), self.format_xp_progress(total_xp, next_ceiling), progress_font, TEXT_SECONDARY, anchor="mm")

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