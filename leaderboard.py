import io
from pathlib import Path

import discord
from discord.ext import commands
from PIL import Image, ImageDraw, ImageFont, ImageOps

from xp import XPTrackerCog


CARD_WIDTH = 860
ROW_HEIGHT = 100
HEADER_HEIGHT = 80
AVATAR_RADIUS = 36
BAR_HEIGHT = 10

MEDAL_COLORS = ["#FFD700", "#C0C0C0", "#CD7F32"]

BACKGROUND = "#0A1424"
ROW_ODD = (11, 22, 44, 200)
ROW_EVEN = (8, 16, 34, 200)
OUTLINE = "#233252"
ACCENT = "#58E1C1"
TEXT_PRIMARY = "#F5F7FB"
TEXT_SECONDARY = "#8EA0BC"
BAR_BACKGROUND = "#17233D"
BAR_FILL = "#47D7C3"


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
	assets_dir = Path(__file__).resolve().parent / "assets" / "fonts"
	font_candidates = []
	if bold:
		font_candidates.append(str(assets_dir / "DejaVuSans-Bold.ttf"))
	font_candidates.append(str(assets_dir / "DejaVuSans.ttf"))
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


async def fetch_avatar(member: discord.Member | None, size: int = 72) -> Image.Image | None:
	if member is None:
		return None

	try:
		avatar_bytes = await member.display_avatar.replace(size=128, format="png").read()
		avatar = Image.open(io.BytesIO(avatar_bytes)).convert("RGBA")
		avatar = ImageOps.fit(avatar, (size, size), centering=(0.5, 0.5))
		mask = Image.new("L", (size, size), 0)
		ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
		avatar.putalpha(mask)
		return avatar
	except Exception:
		return None


async def build_leaderboard_card(
	guild: discord.Guild,
	rows: list,
	xp_tracker: XPTrackerCog,
) -> io.BytesIO:
	total_height = HEADER_HEIGHT + len(rows) * ROW_HEIGHT + 20
	canvas = Image.new("RGBA", (CARD_WIDTH, total_height), BACKGROUND)
	draw = ImageDraw.Draw(canvas)

	for y in range(total_height):
		ratio = y / max(1, total_height - 1)
		red = int(10 + ratio * 6)
		green = int(20 + ratio * 8)
		blue = int(36 + ratio * 15)
		draw.line([(0, y), (CARD_WIDTH, y)], fill=(red, green, blue, 255))

	title_font = load_font(32, bold=True)
	subtitle_font = load_font(16)
	draw.text((CARD_WIDTH // 2, 24), "XP Siralamasi", font=title_font, fill=TEXT_PRIMARY, anchor="mm")
	draw.text((CARD_WIDTH // 2, 58), guild.name, font=subtitle_font, fill=TEXT_SECONDARY, anchor="mm")
	draw.line([(30, HEADER_HEIGHT - 4), (CARD_WIDTH - 30, HEADER_HEIGHT - 4)], fill=OUTLINE, width=2)

	rank_font = load_font(22, bold=True)
	name_font = load_font(20, bold=True)
	xp_font = load_font(17)
	level_font = load_font(14)

	members = [guild.get_member(row["user_id"]) for row in rows]
	avatars = [await fetch_avatar(member, size=AVATAR_RADIUS * 2) for member in members]

	for index, (row, member, avatar) in enumerate(zip(rows, members, avatars), start=1):
		y_start = HEADER_HEIGHT + (index - 1) * ROW_HEIGHT
		y_end = y_start + ROW_HEIGHT
		row_fill = ROW_ODD if index % 2 == 1 else ROW_EVEN
		draw.rounded_rectangle(
			(10, y_start + 4, CARD_WIDTH - 10, y_end - 4),
			radius=14,
			fill=row_fill,
			outline=OUTLINE,
			width=1,
		)

		cursor_x = 26
		rank_label = ["1", "2", "3"][index - 1] if index <= 3 else str(index)
		rank_color = MEDAL_COLORS[index - 1] if index <= 3 else TEXT_SECONDARY
		draw.text((cursor_x + 24, y_start + ROW_HEIGHT // 2), rank_label, font=rank_font, fill=rank_color, anchor="mm")
		cursor_x += 52

		if avatar is not None:
			avatar_x = cursor_x
			avatar_y = y_start + ROW_HEIGHT // 2 - AVATAR_RADIUS
			canvas.paste(avatar, (avatar_x, avatar_y), avatar)
			draw.ellipse(
				(avatar_x - 2, avatar_y - 2, avatar_x + AVATAR_RADIUS * 2 + 2, avatar_y + AVATAR_RADIUS * 2 + 2),
				outline=ACCENT,
				width=2,
			)
		cursor_x += AVATAR_RADIUS * 2 + 12

		member_name = member.display_name if member is not None else f"Kullanici {row['user_id']}"
		if len(member_name) > 22:
			member_name = member_name[:21] + "..."

		total_xp = int(row["total_xp"])
		level, _, _, _, progress_ratio = xp_tracker.get_progress_data(total_xp)

		draw.text((cursor_x + 2, y_start + ROW_HEIGHT // 2 - 14), member_name, font=name_font, fill=TEXT_PRIMARY, anchor="lm")
		draw.text((cursor_x + 2, y_start + ROW_HEIGHT // 2 + 10), f"Seviye {level}", font=level_font, fill=ACCENT, anchor="lm")

		bar_x0 = CARD_WIDTH - 160
		bar_x1 = CARD_WIDTH - 24
		bar_y0 = y_start + ROW_HEIGHT - 28
		bar_y1 = bar_y0 + BAR_HEIGHT
		bar_radius = BAR_HEIGHT // 2
		draw.rounded_rectangle((bar_x0, bar_y0, bar_x1, bar_y1), radius=bar_radius, fill=BAR_BACKGROUND)
		fill_width = max(bar_radius * 2, int((bar_x1 - bar_x0) * progress_ratio))
		draw.rounded_rectangle((bar_x0, bar_y0, bar_x0 + fill_width, bar_y1), radius=bar_radius, fill=BAR_FILL)

		draw.text((CARD_WIDTH - 24, y_start + ROW_HEIGHT // 2 - 10), f"{total_xp:,} XP", font=xp_font, fill=TEXT_PRIMARY, anchor="rm")

	draw.rounded_rectangle((4, 4, CARD_WIDTH - 4, total_height - 4), radius=20, outline=OUTLINE, width=2)

	buffer = io.BytesIO()
	canvas.save(buffer, format="PNG")
	buffer.seek(0)
	return buffer


class LeaderboardCog(commands.Cog):
	def __init__(self, bot: commands.Bot) -> None:
		self.bot = bot

	def get_xp_tracker(self) -> XPTrackerCog:
		xp_tracker = self.bot.get_cog("XPTrackerCog")
		if not isinstance(xp_tracker, XPTrackerCog):
			raise RuntimeError("XP sistemi yuklenemedi.")
		return xp_tracker

	@commands.command(name="liderlik", aliases=["lb", "top"])
	async def leaderboard_command(self, ctx: commands.Context) -> None:
		if ctx.guild is None:
			await ctx.send("Bu komut sadece sunucuda kullanilabilir.")
			return

		rows = self.get_xp_tracker().get_leaderboard(ctx.guild.id, limit=10)
		if not rows:
			await ctx.send("Henuz XP verisi yok.")
			return

		async with ctx.typing():
			try:
				buffer = await build_leaderboard_card(ctx.guild, rows, self.get_xp_tracker())
			except Exception as error:
				await ctx.send(f"Siralama karti olusturulamadi: {error}")
				return

		await ctx.send(file=discord.File(buffer, filename="liderlik.png"))