import io

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont, ImageOps

from xp import XPTrackerCog
from xproles import ROLE_REWARDS


CARD_WIDTH = 1050
CARD_HEIGHT = 600
AVATAR_SIZE = 150
AVATAR_POSITION = (76, 120)
RANK_CENTER = (886, 136)
BAR_BOX = (285, 482, 948, 526)
BAR_INNER_PADDING = 6

DEFAULT_THEME = {
	"background_base": "#08111F",
	"background_start": "#0A1424",
	"background_end": "#101B34",
	"panel_fill": (11, 19, 35, 220),
	"panel_outline": "#233252",
	"outer_panel_fill": (7, 13, 26, 232),
	"outer_panel_outline": "#203155",
	"text_primary": "#F5F7FB",
	"text_secondary": "#C9D4E4",
	"text_muted": "#8EA0BC",
	"accent": "#58E1C1",
	"bar_bg": "#17233D",
	"bar_fill": "#47D7C3",
	"bar_fill_end": "#6A7BFF",
	"shadow": "#120F1D",
	"glow_primary": "#2DE2C5",
	"glow_secondary": "#5670FF",
	"glow_tertiary": "#46E2C4",
}

ROLE_THEMES = {
	ROLE_REWARDS[0]: {"background_base": "#0C1510", "background_start": "#0F1F16", "background_end": "#183124", "panel_outline": "#27523A", "outer_panel_outline": "#2E6144", "accent": "#7FE08B", "bar_bg": "#16281D", "bar_fill": "#64D989", "bar_fill_end": "#C5F17A", "glow_primary": "#62E18B", "glow_secondary": "#A9F06E", "glow_tertiary": "#8CF6C3"},
	ROLE_REWARDS[150]: {"background_base": "#1A1320", "background_start": "#20172A", "background_end": "#31203D", "panel_outline": "#58416C", "outer_panel_outline": "#6C4D82", "accent": "#FFD36E", "bar_bg": "#2A1F33", "bar_fill": "#FFC766", "bar_fill_end": "#FF9B70", "glow_primary": "#FFD36E", "glow_secondary": "#FF9E6C", "glow_tertiary": "#FFF0A8"},
	ROLE_REWARDS[400]: {"background_base": "#10192A", "background_start": "#12203A", "background_end": "#1D3152", "panel_outline": "#315884", "outer_panel_outline": "#3E6DA1", "accent": "#78D3FF", "bar_bg": "#162742", "bar_fill": "#66CFFF", "bar_fill_end": "#9687FF", "glow_primary": "#57C8FF", "glow_secondary": "#8E7FFF", "glow_tertiary": "#8DEFF0"},
	ROLE_REWARDS[800]: {"background_base": "#121D12", "background_start": "#172A17", "background_end": "#254227", "panel_outline": "#3F7146", "outer_panel_outline": "#4C8854", "accent": "#9EE86C", "bar_bg": "#1E3120", "bar_fill": "#93E46A", "bar_fill_end": "#46D996", "glow_primary": "#8FE869", "glow_secondary": "#3EDB8F", "glow_tertiary": "#C4F797"},
	ROLE_REWARDS[1400]: {"background_base": "#171520", "background_start": "#201A2D", "background_end": "#342545", "panel_outline": "#664B89", "outer_panel_outline": "#795BA3", "accent": "#9CC0FF", "bar_bg": "#272135", "bar_fill": "#97BCFF", "bar_fill_end": "#7DE9D1", "glow_primary": "#9FB5FF", "glow_secondary": "#7CF3D7", "glow_tertiary": "#D7C0FF"},
	ROLE_REWARDS[2300]: {"background_base": "#171A1C", "background_start": "#1C2428", "background_end": "#2B383D", "panel_outline": "#526870", "outer_panel_outline": "#637C85", "accent": "#A3F1FF", "bar_bg": "#222D31", "bar_fill": "#87E8F8", "bar_fill_end": "#80BFFF", "glow_primary": "#7DEAF8", "glow_secondary": "#8DB5FF", "glow_tertiary": "#C8FFFF"},
	ROLE_REWARDS[3500]: {"background_base": "#1A1412", "background_start": "#251A17", "background_end": "#3A2721", "panel_outline": "#7A5143", "outer_panel_outline": "#966554", "accent": "#FFB26B", "bar_bg": "#31211C", "bar_fill": "#FFAA63", "bar_fill_end": "#FF7A62", "glow_primary": "#FFAC63", "glow_secondary": "#FF745A", "glow_tertiary": "#FFD09A"},
	ROLE_REWARDS[5200]: {"background_base": "#101622", "background_start": "#131E31", "background_end": "#1D2F4A", "panel_outline": "#37598A", "outer_panel_outline": "#456DA8", "accent": "#76B8FF", "bar_bg": "#17263D", "bar_fill": "#67B2FF", "bar_fill_end": "#5FEDD9", "glow_primary": "#6CAEFF", "glow_secondary": "#5DE5D9", "glow_tertiary": "#A6D4FF"},
	ROLE_REWARDS[7600]: {"background_base": "#111B24", "background_start": "#152434", "background_end": "#22374E", "panel_outline": "#3D6B8D", "outer_panel_outline": "#5081A6", "accent": "#8DE9FF", "bar_bg": "#1A2B40", "bar_fill": "#81E6F7", "bar_fill_end": "#68B2FF", "glow_primary": "#7BE5FF", "glow_secondary": "#62AFFF", "glow_tertiary": "#B7F9FF"},
	ROLE_REWARDS[10500]: {"background_base": "#23130F", "background_start": "#351913", "background_end": "#58241A", "panel_outline": "#9A4D36", "outer_panel_outline": "#BD6445", "accent": "#FF8B5C", "bar_bg": "#3A2018", "bar_fill": "#FF825A", "bar_fill_end": "#FFC964", "glow_primary": "#FF7E53", "glow_secondary": "#FFC85B", "glow_tertiary": "#FFC0A1"},
	ROLE_REWARDS[14500]: {"background_base": "#1A1223", "background_start": "#241634", "background_end": "#3A2053", "panel_outline": "#7750A3", "outer_panel_outline": "#8E62C1", "accent": "#C094FF", "bar_bg": "#2A1D3F", "bar_fill": "#B88DFF", "bar_fill_end": "#64DFFF", "glow_primary": "#BC8CFF", "glow_secondary": "#60D6FF", "glow_tertiary": "#E7C9FF"},
	ROLE_REWARDS[19500]: {"background_base": "#261E10", "background_start": "#332714", "background_end": "#4F3C1D", "panel_outline": "#8F7132", "outer_panel_outline": "#AA8940", "accent": "#F4D35E", "bar_bg": "#3A2E18", "bar_fill": "#EBCF5F", "bar_fill_end": "#FFF0A1", "glow_primary": "#F0D35A", "glow_secondary": "#FFF1AE", "glow_tertiary": "#FFD980"},
	ROLE_REWARDS[25500]: {"background_base": "#181511", "background_start": "#211E18", "background_end": "#352B22", "panel_outline": "#75644B", "outer_panel_outline": "#8B785A", "accent": "#F7E8B0", "bar_bg": "#2A241D", "bar_fill": "#EEDFA7", "bar_fill_end": "#C99962", "glow_primary": "#F0E3AE", "glow_secondary": "#D39F6A", "glow_tertiary": "#FFF6D2"},
	ROLE_REWARDS[32500]: {"background_base": "#11181E", "background_start": "#14232C", "background_end": "#1F3A47", "panel_outline": "#3D7487", "outer_panel_outline": "#4A91A6", "accent": "#CFFBFF", "bar_bg": "#1B2D36", "bar_fill": "#B7F7FF", "bar_fill_end": "#84C3FF", "glow_primary": "#C2FAFF", "glow_secondary": "#7FC1FF", "glow_tertiary": "#EDFEFF"},
	ROLE_REWARDS[40000]: {"background_base": "#141520", "background_start": "#1C1A30", "background_end": "#2D2550", "panel_outline": "#6C62A3", "outer_panel_outline": "#8276C4", "accent": "#BBD4FF", "bar_bg": "#25233A", "bar_fill": "#AFC9FF", "bar_fill_end": "#62F4D1", "glow_primary": "#B5CEFF", "glow_secondary": "#62EED1", "glow_tertiary": "#E3DDFF"},
}


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
		shadow_fill: str,
		anchor: str | None = None,
		shadow: bool = True,
	) -> None:
		if shadow:
			draw.text((position[0] + 2, position[1] + 2), text, font=font, fill=shadow_fill, anchor=anchor)
		draw.text(position, text, font=font, fill=fill, anchor=anchor)

	@staticmethod
	def draw_panel(
		draw: ImageDraw.ImageDraw,
		box: tuple[int, int, int, int],
		radius: int,
		fill: tuple[int, int, int, int],
		outline: str,
	) -> None:
		draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=2)

	@staticmethod
	def get_card_theme(role_id: int | None) -> dict[str, object]:
		theme = DEFAULT_THEME.copy()
		if role_id is not None:
			theme.update(ROLE_THEMES.get(role_id, {}))
		return theme

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

	def draw_progress_bar(self, card: Image.Image, progress_ratio: float, theme: dict[str, object]) -> None:
		draw = ImageDraw.Draw(card)
		x1, y1, x2, y2 = BAR_BOX
		radius = (y2 - y1) // 2
		draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, fill=str(theme["bar_bg"]))

		inner_box = (
			x1 + BAR_INNER_PADDING,
			y1 + BAR_INNER_PADDING,
			x2 - BAR_INNER_PADDING,
			y2 - BAR_INNER_PADDING,
		)
		inner_width = inner_box[2] - inner_box[0]
		fill_width = max(radius, int(inner_width * progress_ratio)) if progress_ratio > 0 else 0

		if fill_width > 0:
			gradient = self.create_horizontal_gradient(
				fill_width,
				inner_box[3] - inner_box[1],
				str(theme["bar_fill"]),
				str(theme["bar_fill_end"]),
			)
			fill_mask = Image.new("L", (fill_width, inner_box[3] - inner_box[1]), 0)
			mask_draw = ImageDraw.Draw(fill_mask)
			mask_draw.rounded_rectangle(
				(0, 0, fill_width, inner_box[3] - inner_box[1]),
				radius=max(8, radius - BAR_INNER_PADDING),
				fill=255,
			)
			card.paste(gradient, (inner_box[0], inner_box[1]), fill_mask)

		draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, outline=str(theme["accent"]), width=2)

	@staticmethod
	def create_card_background(theme: dict[str, object]) -> Image.Image:
		card = Image.new("RGBA", (CARD_WIDTH, CARD_HEIGHT), str(theme["background_base"]))
		background = UserCardCog.create_horizontal_gradient(
			CARD_WIDTH,
			CARD_HEIGHT,
			str(theme["background_start"]),
			str(theme["background_end"]),
		)
		card.alpha_composite(background)
		UserCardCog.paste_glow(card, (140, 40), 180, str(theme["glow_primary"]), 70)
		UserCardCog.paste_glow(card, (960, 560), 220, str(theme["glow_secondary"]), 80)
		UserCardCog.paste_glow(card, (860, 120), 120, str(theme["glow_tertiary"]), 55)

		draw = ImageDraw.Draw(card)
		UserCardCog.draw_panel(draw, (30, 30, CARD_WIDTH - 30, CARD_HEIGHT - 30), 34, theme["outer_panel_fill"], str(theme["outer_panel_outline"]))
		UserCardCog.draw_panel(draw, (56, 76, 245, 314), 28, theme["panel_fill"], str(theme["panel_outline"]))
		UserCardCog.draw_panel(draw, (270, 182, 505, 292), 24, theme["panel_fill"], str(theme["panel_outline"]))
		UserCardCog.draw_panel(draw, (530, 182, 765, 292), 24, theme["panel_fill"], str(theme["panel_outline"]))
		UserCardCog.draw_panel(draw, (270, 314, 505, 424), 24, theme["panel_fill"], str(theme["panel_outline"]))
		UserCardCog.draw_panel(draw, (530, 314, 765, 424), 24, theme["panel_fill"], str(theme["panel_outline"]))
		UserCardCog.draw_panel(draw, (800, 70, 972, 242), 30, theme["panel_fill"], str(theme["panel_outline"]))
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
		target_role = xp_tracker.get_target_role(member)
		theme = self.get_card_theme(None if target_role is None else target_role.id)

		card = self.create_card_background(theme).resize((CARD_WIDTH, CARD_HEIGHT))
		avatar = await self.fetch_avatar_image(member)
		card.paste(avatar, AVATAR_POSITION, avatar)
		draw = ImageDraw.Draw(card)
		draw.ellipse(
			(AVATAR_POSITION[0] - 7, AVATAR_POSITION[1] - 7, AVATAR_POSITION[0] + AVATAR_SIZE + 7, AVATAR_POSITION[1] + AVATAR_SIZE + 7),
			outline=str(theme["accent"]),
			width=4,
		)

		name_font = self.load_font(46, bold=True)
		username_font = self.load_font(24)
		label_font = self.load_font(19)
		value_font = self.load_font(31, bold=True)
		rank_font = self.load_font(42, bold=True)
		level_font = self.load_font(28, bold=True)
		progress_font = self.load_font(18, bold=True)

		display_name = self.fit_text_to_width(draw, member.display_name, name_font, 430)
		self.draw_text(draw, (286, 92), display_name, name_font, str(theme["text_primary"]), str(theme["shadow"]))
		username = self.fit_text_to_width(draw, f"@{member.name}", username_font, 280)
		self.draw_text(draw, (289, 144), username, username_font, str(theme["text_secondary"]), str(theme["shadow"]))

		left_label_x = 292
		left_value_x = 292
		right_label_x = 552
		right_value_x = 552

		self.draw_text(draw, (left_label_x, 206), "Current Role", label_font, str(theme["text_muted"]), str(theme["shadow"]))
		role_font = self.load_fitted_font(draw, current_role, start_size=31, max_width=200, min_size=20, bold=True)
		self.draw_text(draw, (left_value_x, 242), current_role, role_font, str(theme["text_primary"]), str(theme["shadow"]))

		self.draw_text(draw, (right_label_x, 206), "Total XP", label_font, str(theme["text_muted"]), str(theme["shadow"]))
		self.draw_text(draw, (right_value_x, 242), f"{total_xp:,}", value_font, str(theme["text_primary"]), str(theme["shadow"]))

		self.draw_text(draw, (left_label_x, 338), "Messages Sent", label_font, str(theme["text_muted"]), str(theme["shadow"]))
		self.draw_text(draw, (left_value_x, 374), f"{int(stats['message_count']):,}", value_font, str(theme["text_primary"]), str(theme["shadow"]))

		self.draw_text(draw, (right_label_x, 338), "Total Voice Time", label_font, str(theme["text_muted"]), str(theme["shadow"]))
		voice_text = self.fit_text_to_width(draw, xp_tracker.format_duration(live_voice_seconds), value_font, 190)
		self.draw_text(draw, (right_value_x, 374), voice_text, value_font, str(theme["text_primary"]), str(theme["shadow"]))

		self.draw_text(draw, (886, 96), "RANK", label_font, str(theme["text_muted"]), str(theme["shadow"]), anchor="mm")
		self.draw_text(draw, RANK_CENTER, str(rank), rank_font, str(theme["text_primary"]), str(theme["shadow"]), anchor="mm")
		self.draw_text(draw, (886, 188), f"Level {level}", label_font, str(theme["accent"]), str(theme["shadow"]), anchor="mm")

		self.draw_progress_bar(card, progress_ratio, theme)
		self.draw_text(draw, (286, 438), f"Level {level}", level_font, str(theme["text_primary"]), str(theme["shadow"]))

		if next_ceiling <= current_floor:
			next_label = "MAX"
		else:
			next_label = f"Level {next_level}"

		self.draw_text(draw, (948, 438), next_label, level_font, str(theme["text_primary"]), str(theme["shadow"]), anchor="rm")
		self.draw_text(draw, (616, 550), self.format_xp_progress(total_xp, next_ceiling), progress_font, str(theme["text_secondary"]), str(theme["shadow"]), anchor="mm")

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