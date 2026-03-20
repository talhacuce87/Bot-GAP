import discord


ROLE_REWARDS = {
	0: 1484447513837568031,
	150: 1484447344475766814,
	400: 1484447172148727860,
	800: 1404413459285671937,
	1400: 1484447060739620914,
	2300: 1484446934528954399,
	3500: 1484446734540083231,
	5200: 1155446898090577951,
	7600: 1484446639207878686,
	10500: 1484446522975457310,
	14500: 1484446269630844928,
	19500: 1082000597223485531,
	25500: 1484446089192149093,
	32500: 1484445942928248832,
	40000: 1080896681492619294,
}


class XPRoleManager:
	def __init__(self, role_rewards: dict[int, int] | None = None) -> None:
		self.role_rewards = role_rewards or ROLE_REWARDS

	@staticmethod
	def sanitize_role_name(role_name: str) -> str:
		for separator in (" - ", " – ", " — "):
			if separator in role_name:
				return role_name.split(separator, maxsplit=1)[0].strip()
		return role_name.strip()

	def get_progress_data(self, total_xp: int) -> tuple[int, int, int, int, float]:
		thresholds = sorted(self.role_rewards)
		current_level = 1
		current_floor = thresholds[0]
		next_ceiling = thresholds[0]

		for index, required_xp in enumerate(thresholds):
			if total_xp >= required_xp:
				current_level = index + 1
				current_floor = required_xp
				if index + 1 < len(thresholds):
					next_ceiling = thresholds[index + 1]
				else:
					next_ceiling = required_xp

		if next_ceiling <= current_floor:
			return current_level, current_level, current_floor, next_ceiling, 1.0

		progress = (total_xp - current_floor) / (next_ceiling - current_floor)
		progress = max(0.0, min(1.0, progress))
		return current_level, current_level + 1, current_floor, next_ceiling, progress

	def get_managed_role_ids(self) -> set[int]:
		return set(self.role_rewards.values())

	def get_target_role(self, member: discord.Member, total_xp: int) -> discord.Role | None:
		target_role = None

		for required_xp, role_id in sorted(self.role_rewards.items()):
			role = member.guild.get_role(role_id)
			if role is None:
				continue

			if total_xp >= required_xp:
				target_role = role

		return target_role

	def get_display_role(self, member: discord.Member, total_xp: int) -> str:
		target_role = self.get_target_role(member, total_xp)
		if target_role is not None:
			return self.sanitize_role_name(target_role.name)

		visible_roles = [self.sanitize_role_name(role.name) for role in reversed(member.roles) if role.name != "@everyone"]
		if not visible_roles:
			return "Tiny Gapper"
		return visible_roles[0]

	async def sync_member_role(self, member: discord.Member, total_xp: int) -> None:
		if member.bot or member.guild is None or member.guild.me is None:
			return

		managed_role_ids = self.get_managed_role_ids()
		if not managed_role_ids:
			return

		target_role = self.get_target_role(member, total_xp)
		current_xp_roles = [role for role in member.roles if role.id in managed_role_ids]

		roles_to_remove = [
			role for role in current_xp_roles
			if target_role is None or role.id != target_role.id
		]

		if roles_to_remove:
			removable_roles = [role for role in roles_to_remove if role < member.guild.me.top_role]
			if removable_roles:
				try:
					await member.remove_roles(*removable_roles, reason="XP rol senkronizasyonu")
				except discord.Forbidden:
					pass

		if target_role is not None and target_role not in member.roles:
			if target_role < member.guild.me.top_role:
				try:
					await member.add_roles(target_role, reason="XP rol ödülü")
				except discord.Forbidden:
					pass