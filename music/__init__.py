"""
music — YouTube / Spotify / SoundCloud linklerini ses kanalında çalan müzik modülü.

- YouTube sesi yt-dlp ile alınır; Spotify linklerinden şarkı bilgisi okunup YouTube'da aranır.
- yt-dlp kendi kendine güncellenir; YouTube bozulursa önce onarım, olmazsa SoundCloud denenir.
- MUSIC_ENABLED=false ile tamamen kapatılabilir; yüklenemezse bot onsuz çalışmaya devam eder.
"""

from __future__ import annotations

import logging

from discord.ext import commands

log = logging.getLogger("gap.music")


async def setup_music(bot: commands.Bot) -> bool:
    """Müzik cog'unu yapılandırmaya göre yükler. Döner: yüklendi mi."""
    from music.config import load_config

    cfg = load_config()
    if not cfg.enabled:
        log.info("Müzik modülü kapalı (MUSIC_ENABLED=false)")
        return False

    from music.cog import MusicCog

    await bot.add_cog(MusicCog(bot, cfg))
    return True
