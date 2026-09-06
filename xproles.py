"""
xproles.py — Rol eşlemeleri ve XP ilerleme hesaplama.

Hiç Discord API çağrısı yapmaz; saf hesaplama mantığı burada,
ağ işlemleri xp.py'de kalır.
"""

from __future__ import annotations

import discord

# XP eşiği → Discord rol ID
ROLE_REWARDS: dict[int, int] = {
    0:     1484447513837568031,
    150:   1484447344475766814,
    400:   1484447172148727860,
    800:   1404413459285671937,
    1400:  1484447060739620914,
    2300:  1484446934528954399,
    3500:  1484446734540083231,
    5200:  1155446898090577951,
    7600:  1484446639207878686,
    10500: 1484446522975457310,
    14500: 1484446269630844928,
    19500: 1082000597223485531,
    25500: 1484446089192149093,
    32500: 1484445942928248832,
    40000: 1080896681492619294,
    100000: 1545813630648459334,
    250000: 1545813865009389678,
    500000: 1545813991723634849,
    1000000: 1545814125958144010,
}

DEFAULT_ROLE_NAMES: dict[int, str] = {
    0:       "Tiny Gapper",
    150:     "Starter Gapper",
    400:     "Rookie Gapper",
    800:     "Mini Gapper",
    1400:    "Junior Gapper",
    2300:    "Skilled Gapper",
    3500:    "Advanced Gapper",
    5200:    "Pro Gapper",
    7600:    "Elite Gapper",
    10500:   "Epic Gapper",
    14500:   "Mythic Gapper",
    19500:   "Legendary Gapper",
    25500:   "Godlike Gapper",
    32500:   "Immortal Gapper",
    40000:   "Master Gapper",
    100000:  "The GAP V",
    250000:  "The GAP X",
    500000:  "The GAP Zenith",
    1000000: "The GAP Legend",
}

_SORTED_THRESHOLDS: list[int] = sorted(ROLE_REWARDS)


class XPRoleManager:
    def __init__(self, role_rewards: dict[int, int] | None = None) -> None:
        self.role_rewards = role_rewards or ROLE_REWARDS
        self._sorted = sorted(self.role_rewards)

    # ------------------------------------------------------------------
    # Yardımcılar
    # ------------------------------------------------------------------

    @staticmethod
    def sanitize_role_name(name: str) -> str:
        """'Tiny Gapper – 🍃' → 'Tiny Gapper'"""
        for sep in (" - ", " – ", " — "):
            if sep in name:
                return name.split(sep, 1)[0].strip()
        return name.strip()

    def get_managed_role_ids(self) -> set[int]:
        return set(self.role_rewards.values())

    def get_tier_threshold(self, total_xp: int) -> int:
        """Kullanıcının toplam XP'sine göre hak kazandığı en yüksek eşiği döner."""
        current = self._sorted[0]
        for req in self._sorted:
            if total_xp >= req:
                current = req
            else:
                break
        return current

    # ------------------------------------------------------------------
    # İlerleme
    # ------------------------------------------------------------------

    def get_progress_data(self, total_xp: int) -> tuple[int, int, int, int, float]:
        """
        Döner: (mevcut_level, sonraki_level, alt_eşik, üst_eşik, oran)
        """
        thresholds = self._sorted
        level = 1
        floor = thresholds[0]
        ceiling = thresholds[0]

        for i, req in enumerate(thresholds):
            if total_xp >= req:
                level = i + 1
                floor = req
                ceiling = thresholds[i + 1] if i + 1 < len(thresholds) else req

        if ceiling <= floor:
            return level, level, floor, ceiling, 1.0

        ratio = max(0.0, min(1.0, (total_xp - floor) / (ceiling - floor)))
        return level, level + 1, floor, ceiling, ratio

    # ------------------------------------------------------------------
    # Rol seçimi
    # ------------------------------------------------------------------

    def get_target_role(self, member: discord.Member, total_xp: int) -> discord.Role | None:
        target: discord.Role | None = None
        for req, role_id in sorted(self.role_rewards.items()):
            if total_xp >= req:
                role = member.guild.get_role(role_id)
                if role is not None:
                    target = role
        return target

    def get_display_role(self, member: discord.Member, total_xp: int) -> str:
        role = self.get_target_role(member, total_xp)
        if role is not None:
            return self.sanitize_role_name(role.name)
        visible = [
            self.sanitize_role_name(r.name)
            for r in reversed(member.roles)
            if r.name != "@everyone"
        ]
        if visible:
            return visible[0]
        tier = self.get_tier_threshold(total_xp)
        return DEFAULT_ROLE_NAMES.get(tier, "Tiny Gapper")

    def get_next_role_info(self, member: discord.Member, total_xp: int) -> tuple[str | None, int | None]:
        for req, role_id in sorted(self.role_rewards.items()):
            if total_xp < req:
                role = member.guild.get_role(role_id)
                if role is not None:
                    role_name = self.sanitize_role_name(role.name)
                else:
                    role_name = DEFAULT_ROLE_NAMES.get(req, f"{req:,} XP Rolü")
                return role_name, req
        return None, None

    # ------------------------------------------------------------------
    # Senkronizasyon
    # ------------------------------------------------------------------

    async def sync_member_role(self, member: discord.Member, total_xp: int) -> None:
        if member.bot or member.guild is None or member.guild.me is None:
            return

        managed = self.get_managed_role_ids()
        target = self.get_target_role(member, total_xp)
        bot_top = member.guild.me.top_role

        to_remove = [
            r for r in member.roles
            if r.id in managed and (target is None or r.id != target.id) and r < bot_top
        ]
        if to_remove:
            try:
                await member.remove_roles(*to_remove, reason="XP rol senkronizasyonu")
            except discord.Forbidden:
                pass

        if target and target not in member.roles and target < bot_top:
            try:
                await member.add_roles(target, reason="XP rol ödülü")
            except discord.Forbidden:
                pass
