"""
info.py — Komut rehberi, deploy notları (changelog) ve bot durum komutları.
"""

from __future__ import annotations

import time
import discord
from discord.ext import commands

BOT_VERSION = "2.1.0"
LAST_DEPLOY_DATE = "6 Eylül 2026"


class InfoCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @commands.command(name="yardim", aliases=["help", "komutlar", "commands"])
    async def help_command(self, ctx: commands.Context) -> None:
        """Tüm bot komutlarını kategorilerine göre listeler."""
        embed = discord.Embed(
            title="🤖 Bot-GAP Komut Rehberi",
            description=(
                "**Bot-GAP**, sunucu içi XP/seviye ilerlemesi, ses istatistikleri ve "
                "Best Friend takip sistemini yönetir.\n"
                "Varsayılan komut ön eki: `!`"
            ),
            color=discord.Color.from_rgb(0, 212, 255),
        )

        embed.add_field(
            name="📊 Profil & İstatistik Kartları",
            value=(
                "• `!kart [@üye]` — Özelleştirilmiş görsel profil ve seviye kartı\n"
                "• `!bf [@üye]` — En çok ses geçirilen partnerle ortak Best Friend kartı\n"
                "• `!xp` — Hızlı metin tabanlı XP ve aktif boost durumu\n"
                "• `!streak` — Günlük mesaj serisi ve XP çarpanı bonusu"
            ),
            inline=False,
        )

        embed.add_field(
            name="🏆 Sıralama & Roller",
            value=(
                "• `!liderlik` — En yüksek XP'ye sahip ilk 10 üyenin görsel afişi\n"
                "• `!roller` — 19 XP rol seviyesi ve gereksinimlerini gösteren görsel harita\n"
                "• `!topxp` — Metin tabanlı ilk 10 XP listesi"
            ),
            inline=False,
        )

        embed.add_field(
            name="🚀 Sistem & Sürüm",
            value=(
                "• `!yenilikler` — Son deployda gelen tüm özellikleri ve güncellemeleri gösterir\n"
                "• `!feature <istek>` — Bot geliştiricisine özellik önerisi kaydeder\n"
                "• `!ping` — Bot gecikme süresini (latency) ölçer"
            ),
            inline=False,
        )

        is_admin = False
        if ctx.guild and getattr(getattr(ctx.author, "guild_permissions", None), "administrator", False):
            is_admin = True

        if is_admin:
            embed.add_field(
                name="⚙️ Yönetici Komutları (Admin)",
                value=(
                    "• `!xpekle @üye <miktar>` — Kullanıcıya XP ekler veya çıkarır\n"
                    "• `!xpayarla @üye <miktar>` — Kullanıcının toplam XP'sini doğrudan belirler\n"
                    "• `!boost @üye <çarpan> [saat]` — Belirtilen süre için geçici XP boost tanımlar\n"
                    "• `!xpsenkronize` — Sunucu üyelerinin XP rollerini kontrol edip eşitler\n"
                    "• `!yedekle` — Veritabanının anlık yedeğini güvenle alır"
                ),
                inline=False,
            )

        embed.set_footer(
            text=f"Bot-GAP v{BOT_VERSION} • Son güncelleme detayları için: !yenilikler"
        )
        if self.bot.user and self.bot.user.display_avatar:
            try:
                embed.set_thumbnail(url=self.bot.user.display_avatar.url)
            except Exception:
                pass

        await ctx.send(embed=embed)

    @commands.command(name="yenilikler", aliases=["changelog", "guncelleme", "surum", "updates", "yenilik"])
    async def changelog_command(self, ctx: commands.Context) -> None:
        """Son deployda gelen yenilikleri ve özellikleri listeler."""
        embed = discord.Embed(
            title=f"🚀 Bot-GAP v{BOT_VERSION} Deploy & Güncelleme Notları",
            description=(
                f"**Yayın Tarihi:** {LAST_DEPLOY_DATE}\n"
                "Bu deploy ile botun tüm görsel kart altyapısı yenilendi, güvenlik mekanizmaları "
                "ve otomatik yedekleme sistemleri devreye alındı."
            ),
            color=discord.Color.from_rgb(98, 225, 194),
        )

        embed.add_field(
            name="🎨 Yenilenen Görsel Kart Tasarımları",
            value=(
                "• **`!roller`**: Rozetlerdeki gölge titremesi (çift çizim blur) giderildi, "
                "seviye metinleri kusursuz ortalandı ve 1M XP taşma sınırları çözüldü.\n"
                "• **`!kart`**: Ses kutusundaki taşma dinamik küçülen fontlarla çözüldü, "
                "rol bulunamadığında XP kademesine göre tema fallback desteği eklendi.\n"
                "• **`!bf`**: Başlık çizgisi çakışması ve kullanıcı adı taşmaları düzeltildi, "
                "100 saat hedefli estetik ilerleme çubuğu konumlandırıldı."
            ),
            inline=False,
        )

        embed.add_field(
            name="🥇 Vektörel Madalyalar & Glif Temizleyici",
            value=(
                "• **`!liderlik`**: Kırık emoji tofu kutuları (`[]`) yerine Pillow ile "
                "özel parlak Altın, Gümüş ve Bronz madalyalar çizildi.\n"
                "• **Font Koruması**: Kullanıcı adlarındaki emojiler temizlenirken "
                "tüm Türkçe karakterler (ç, ğ, ı, ö, ş, ü) eksiksiz korunur."
            ),
            inline=False,
        )

        embed.add_field(
            name="🛑 AFK Ses Kanalı Koruması",
            value=(
                "• AFK ses kanalında bulunan kullanıcıların haksız ses XP'si veya Best Friend "
                "süresi kazanması engellendi. Normal odalara geçildiğinde sayım otomatik devam eder."
            ),
            inline=False,
        )

        embed.add_field(
            name="🎉 Seviye Atlama Kutlaması",
            value=(
                "• Mesaj atarak yeni bir XP seviyesi kazanan üyeler için kanala otomatik "
                "avatar içeren şık tebrik kutlama mesajı gönderilir."
            ),
            inline=False,
        )

        embed.add_field(
            name="🛡️ Otomatik Veritabanı Yedeği",
            value=(
                "• SQLite WAL checkpoint ile bot başlangıcında ve her 24 saatte bir "
                "`data/backups/` altına güvenli tarihli otomatik yedek oluşturulur.\n"
                "• Yöneticiler `!yedekle` komutuyla diledikleri an manuel yedek alabilir."
            ),
            inline=False,
        )

        embed.set_footer(text="Bot-GAP • Tüm komutlar için: !yardim")
        if self.bot.user and self.bot.user.display_avatar:
            try:
                embed.set_thumbnail(url=self.bot.user.display_avatar.url)
            except Exception:
                pass

        await ctx.send(embed=embed)

    @commands.command(name="ping", aliases=["gecikme"])
    async def ping_command(self, ctx: commands.Context) -> None:
        """Bot gecikme süresini ölçer."""
        import math

        t1 = time.perf_counter()
        msg = await ctx.send("🏓 Ölçülüyor...")
        t2 = time.perf_counter()
        msg_latency = max(0, round((t2 - t1) * 1000))

        ws = getattr(self.bot, "latency", None)
        if ws is not None and not math.isnan(ws) and not math.isinf(ws):
            ws_str = f"{round(ws * 1000)} ms"
        else:
            ws_str = "Bağlanıyor..."

        embed = discord.Embed(
            title="🏓 Pong!",
            description=(
                f"• **WebSocket Gecikmesi:** `{ws_str}`\n"
                f"• **Mesaj Gecikmesi:** `{msg_latency} ms`"
            ),
            color=discord.Color.from_rgb(0, 212, 255),
        )
        await msg.edit(content=None, embed=embed)
