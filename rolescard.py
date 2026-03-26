import io
import math
from pathlib import Path

import discord
from PIL import Image, ImageDraw, ImageFont

from xproles import XPRoleManager


CARD_WIDTH = 1180
HEADER_HEIGHT = 150
SUMMARY_HEIGHT = 150
PADDING = 34
COLUMN_GAP = 24
ROW_HEIGHT = 86
ROW_GAP = 14

BACKGROUND_TOP = "#09131F"
BACKGROUND_BOTTOM = "#132742"
PANEL_FILL = (9, 17, 31, 214)
PANEL_OUTLINE = "#274161"
TEXT_PRIMARY = "#F5F7FB"
TEXT_SECONDARY = "#A8BCD6"
TEXT_MUTED = "#7F97B7"
ACCENT = "#62E1C2"
LOCKED_FILL = (18, 28, 45, 215)
UNLOCKED_FILL = (15, 38, 43, 225)
CURRENT_FILL = (31, 58, 71, 235)
LOCKED_OUTLINE = "#314866"
UNLOCKED_OUTLINE = "#4ABDA8"
CURRENT_OUTLINE = "#F0C96B"


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


def draw_text(
	draw: ImageDraw.ImageDraw,
	position: tuple[int, int],
	text: str,
	font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
	fill: str,
	shadow_fill: str = "#08101A",
	anchor: str | None = None,
) -> None:
	draw.text((position[0] + 2, position[1] + 2), text, font=font, fill=shadow_fill, anchor=anchor)
	draw.text(position, text, font=font, fill=fill, anchor=anchor)


def create_gradient_background(width: int, height: int) -> Image.Image:
	canvas = Image.new("RGBA", (width, height), BACKGROUND_TOP)
	draw = ImageDraw.Draw(canvas)
	start = tuple(int(BACKGROUND_TOP[index:index + 2], 16) for index in (1, 3, 5))
	end = tuple(int(BACKGROUND_BOTTOM[index:index + 2], 16) for index in (1, 3, 5))

	for y in range(height):
		ratio = y / max(1, height - 1)
		color = tuple(int(start[channel] + (end[channel] - start[channel]) * ratio) for channel in range(3))
		draw.line([(0, y), (width, y)], fill=color + (255,))

	for center_x, center_y, radius, color in (
		(120, 80, 180, (58, 212, 182, 36)),
		(width - 140, height - 90, 240, (83, 130, 255, 34)),
		(width - 220, 80, 130, (240, 201, 107, 28)),
	):
		glow = Image.new("RGBA", (radius * 2, radius * 2), (0, 0, 0, 0))
		glow_draw = ImageDraw.Draw(glow)
		for current_radius in range(radius, 0, -10):
			alpha = max(0, int(color[3] * (current_radius / radius) ** 2))
			glow_draw.ellipse(
				(radius - current_radius, radius - current_radius, radius + current_radius, radius + current_radius),
				fill=(color[0], color[1], color[2], alpha),
			)
		canvas.alpha_composite(glow, (center_x - radius, center_y - radius))

	return canvas


def fit_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont, max_width: int) -> str:
	if draw.textbbox((0, 0), text, font=font)[2] <= max_width:
		return text

	trimmed = text
	while len(trimmed) > 1:
		trimmed = trimmed[:-1]
		candidate = trimmed.rstrip() + "..."
		if draw.textbbox((0, 0), candidate, font=font)[2] <= max_width:
			return candidate

	return "..."


def get_role_entries(guild: discord.Guild, role_rewards: dict[int, int]) -> list[dict[str, object]]:
	entries: list[dict[str, object]] = []
	for level, (required_xp, role_id) in enumerate(sorted(role_rewards.items()), start=1):
		role = guild.get_role(role_id)
		role_name = f"Rol {role_id}" if role is None else XPRoleManager.sanitize_role_name(role.name)
		role_color = "#6A86A9"
		if role is not None and role.color.value:
			role_color = str(role.color)
		entries.append({
			"level": level,
			"required_xp": required_xp,
			"role_name": role_name,
			"role_color": role_color,
			"exists": role is not None,
		})
	return entries


def get_progress_summary(entries: list[dict[str, object]], total_xp: int) -> tuple[dict[str, object] | None, dict[str, object] | None]:
	current_entry = None
	next_entry = None
	for entry in entries:
		if total_xp >= int(entry["required_xp"]):
			current_entry = entry
			continue
		next_entry = entry
		break
	return current_entry, next_entry


def draw_summary_box(
	draw: ImageDraw.ImageDraw,
	box: tuple[int, int, int, int],
	label: str,
	value: str,
	accent_color: str,
	value_font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
	label_font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> None:
	draw.rounded_rectangle(box, radius=22, fill=PANEL_FILL, outline=PANEL_OUTLINE, width=2)
	draw.rounded_rectangle((box[0] + 14, box[1] + 14, box[0] + 72, box[1] + 72), radius=18, fill=accent_color)
	draw.text((box[0] + 28, box[1] + 26), label[:1], font=load_font(28, bold=True), fill="#09131F")
	draw_text(draw, (box[0] + 92, box[1] + 28), label, label_font, TEXT_MUTED)
	draw_text(draw, (box[0] + 92, box[1] + 68), value, value_font, TEXT_PRIMARY)


async def build_roles_card(
	guild: discord.Guild,
	role_rewards: dict[int, int],
	total_xp: int,
	member_name: str,
) -> io.BytesIO:
	entries = get_role_entries(guild, role_rewards)
	columns = 2
	rows_per_column = math.ceil(len(entries) / columns)
	body_height = rows_per_column * ROW_HEIGHT + max(0, rows_per_column - 1) * ROW_GAP
	card_height = HEADER_HEIGHT + SUMMARY_HEIGHT + body_height + PADDING * 2 + 28
	card = create_gradient_background(CARD_WIDTH, card_height)
	draw = ImageDraw.Draw(card)

	draw.rounded_rectangle((14, 14, CARD_WIDTH - 14, card_height - 14), radius=34, fill=(7, 12, 22, 80), outline=PANEL_OUTLINE, width=2)

	title_font = load_font(40, bold=True)
	subtitle_font = load_font(18)
	summary_label_font = load_font(16)
	summary_value_font = load_font(25, bold=True)
	row_role_font = load_font(24, bold=True)
	row_meta_font = load_font(16)
	row_xp_font = load_font(23, bold=True)
	level_font = load_font(14, bold=True)

	current_entry, next_entry = get_progress_summary(entries, total_xp)
	current_role_name = "Henuz rol yok" if current_entry is None else str(current_entry["role_name"])
	if next_entry is None:
		next_role_text = "Tum roller acildi"
	else:
		remaining_xp = max(0, int(next_entry["required_xp"]) - total_xp)
		next_role_text = f"{next_entry['role_name']} • {remaining_xp:,} XP kaldi"

	draw_text(draw, (PADDING, 34), "XP Rol Haritasi", title_font, TEXT_PRIMARY)
	draw_text(draw, (PADDING, 86), guild.name, subtitle_font, TEXT_SECONDARY)
	draw_text(draw, (CARD_WIDTH - PADDING, 44), member_name, subtitle_font, TEXT_SECONDARY, anchor="ra")
	draw_text(draw, (CARD_WIDTH - PADDING, 80), f"Toplam XP: {total_xp:,}", load_font(24, bold=True), ACCENT, anchor="ra")

	summary_top = HEADER_HEIGHT
	box_width = (CARD_WIDTH - PADDING * 2 - COLUMN_GAP * 2) // 3
	for index, (label, value, color) in enumerate((
		("Toplam XP", f"{total_xp:,}", "#62E1C2"),
		("Aktif Rol", current_role_name, "#7DA9FF"),
		("Siradaki Hedef", next_role_text, "#F0C96B"),
	)):
		x1 = PADDING + index * (box_width + COLUMN_GAP)
		x2 = x1 + box_width
		draw_summary_box(draw, (x1, summary_top, x2, summary_top + 106), label, fit_text(draw, value, summary_value_font, box_width - 122), color, summary_value_font, summary_label_font)

	body_top = HEADER_HEIGHT + SUMMARY_HEIGHT
	column_width = (CARD_WIDTH - PADDING * 2 - COLUMN_GAP) // 2

	for index, entry in enumerate(entries):
		column = index // rows_per_column
		row = index % rows_per_column
		x1 = PADDING + column * (column_width + COLUMN_GAP)
		y1 = body_top + row * (ROW_HEIGHT + ROW_GAP)
		x2 = x1 + column_width
		y2 = y1 + ROW_HEIGHT

		required_xp = int(entry["required_xp"])
		is_unlocked = total_xp >= required_xp
		is_current = current_entry is not None and required_xp == int(current_entry["required_xp"])

		fill = CURRENT_FILL if is_current else UNLOCKED_FILL if is_unlocked else LOCKED_FILL
		outline = CURRENT_OUTLINE if is_current else UNLOCKED_OUTLINE if is_unlocked else LOCKED_OUTLINE
		draw.rounded_rectangle((x1, y1, x2, y2), radius=22, fill=fill, outline=outline, width=2)

		badge_color = str(entry["role_color"])
		draw.rounded_rectangle((x1 + 14, y1 + 14, x1 + 74, y1 + 74), radius=18, fill=badge_color, outline="#E8F1FF", width=2)
		draw_text(draw, (x1 + 44, y1 + 34), f"L{entry['level']}", level_font, "#08131E", anchor="mm")

		role_name = fit_text(draw, str(entry["role_name"]), row_role_font, column_width - 240)
		draw_text(draw, (x1 + 94, y1 + 18), role_name, row_role_font, TEXT_PRIMARY)

		status_parts = []
		if is_current:
			status_parts.append("su anki rol")
		elif is_unlocked:
			status_parts.append("acildi")
		else:
			status_parts.append("kilitli")
		if not bool(entry["exists"]):
			status_parts.append("sunucuda yok")
		draw_text(draw, (x1 + 94, y1 + 54), " • ".join(status_parts), row_meta_font, TEXT_MUTED)

		draw_text(draw, (x2 - 20, y1 + 30), f"{required_xp:,} XP", row_xp_font, ACCENT if is_unlocked else TEXT_PRIMARY, anchor="ra")
		if not is_unlocked and current_entry is not None:
			remaining_xp = max(0, required_xp - total_xp)
			meta_text = f"{remaining_xp:,} XP kaldi"
		else:
			meta_text = "hazir"
		draw_text(draw, (x2 - 20, y1 + 58), meta_text, row_meta_font, TEXT_SECONDARY, anchor="ra")

	buffer = io.BytesIO()
	card.save(buffer, format="PNG")
	buffer.seek(0)
	return buffer