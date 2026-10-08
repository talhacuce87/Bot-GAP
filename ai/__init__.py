"""
ai — Bot-GAP için isteğe bağlı, hafızalı sohbet eklentisi.

AI_ENABLED=false (varsayılan) iken hiçbir AI modülü yüklenmez, ağ veya
veritabanı bağlantısı açılmaz; bot eskisi gibi çalışır.
"""

from __future__ import annotations

import logging

from discord.ext import commands

log = logging.getLogger("gap.ai")


async def setup_ai(bot: commands.Bot) -> bool:
    """AI cog'unu yapılandırmaya göre yükler. Döner: yüklendi mi."""
    from ai.config import load_config

    cfg = load_config()
    if not cfg.enabled:
        log.info("AI modülü kapalı (AI_ENABLED=false)")
        return False

    from ai.cog import AICog

    await bot.add_cog(AICog(bot, cfg))
    return True
