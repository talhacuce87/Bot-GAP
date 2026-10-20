"""
info.py — Komut rehberi, deploy notları (changelog) ve bot durum komutları.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path

import discord
from discord.ext import commands

BOT_VERSION = "2.10.0"
LAST_DEPLOY_DATE = "20 Ekim 2026"

# Yeni sürüm açıldığında güncelleme notlarının otomatik paylaşılacağı kanal (boşsa paylaşılmaz)
ANNOUNCE_CHANNEL_ID = int(os.getenv("ANNOUNCE_CHANNEL_ID", "0") or 0)
ANNOUNCED_VERSION_PATH = Path(__file__).resolve().parent / "data" / "announced_version.txt"

log = logging.getLogger("gap.info")


class InfoCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self._announce_checked = False

    # ------------------------------------------------------------------
    # Otomatik sürüm duyurusu
    # ------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_ready(self) -> None:
        # on_ready yeniden bağlanmalarda da tetiklenir; süreç başına bir kez kontrol et.
        if self._announce_checked:
            return
        self._announce_checked = True
        await self._announce_new_version()

    async def _announce_new_version(self) -> None:
        if not ANNOUNCE_CHANNEL_ID:
            return

        try:
            last = ANNOUNCED_VERSION_PATH.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            last = ""
        if last == BOT_VERSION:
            return

        channel = self.bot.get_channel(ANNOUNCE_CHANNEL_ID)
        if not isinstance(channel, discord.abc.Messageable):
            log.warning("Duyuru kanalı bulunamadı: %s", ANNOUNCE_CHANNEL_ID)
            return

        try:
            await channel.send(embed=self._build_changelog_embed())
        except discord.HTTPException as err:
            log.warning("Sürüm duyurusu gönderilemedi: %s", err)
            return

        # Sadece başarılı gönderimden sonra yaz; hata olursa bir sonraki açılışta tekrar denenir.
        ANNOUNCED_VERSION_PATH.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(ANNOUNCED_VERSION_PATH.write_text, BOT_VERSION, "utf-8")
        log.info("v%s güncelleme notları #%s kanalına duyuruldu", BOT_VERSION, channel)

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
                "• `!karakter [üye]` — GAP Dünyası'ndaki chibi karakterinin resmi\n"
                "• `!bf [@üye]` — En çok ses geçirilen partnerle arkadaşlık tier kartı\n"
                "• `!arkadaslar [@üye]` — En çok ses geçirilen 10 kişi ve tier'ları\n"
                "• `!tierlar` — Arkadaşlık tier'ları ve saat eşikleri\n"
                "• `!xp` — Hızlı metin tabanlı XP ve aktif boost durumu\n"
                "• `!streak` — Günlük mesaj serisi ve XP çarpanı bonusu\n"
                "• `!haftalik` — Kişisel haftalık özet kartın (sadece pazar, haftada bir)\n"
                "• `!wrapped` — Kişisel aylık Wrapped kartın (sadece ayın son günü, ayda bir)\n"
                "• `!başarımlar [@üye]` — Rozetlerin izci fuları üzerinde · `!başarımrehberi` — Nasıl kazanılır\n"
                "• `!kartdüzen` — Kartında görünecek 3 rozeti seç"
            ),
            inline=False,
        )

        embed.add_field(
            name="🏆 Sıralama & Roller",
            value=(
                "• `!liderlik` — En yüksek XP'ye sahip ilk 10 üyenin görsel afişi\n"
                "• `!roller` — 19 XP rol seviyesi ve gereksinimlerini gösteren görsel harita\n"
                "• `!topxp` — Metin tabanlı ilk 10 XP listesi\n"
                "• `!sürgünler` — Sürgündekiler ve kalan cezaları"
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

        if self.bot.get_cog("AICog") is not None:
            embed.add_field(
                name="🧠 Yapay Zekâ Sohbet & Hafıza",
                value=(
                    "• `@Bot-GAP <mesaj>` veya `!ai <mesaj>` — Botla sohbet et\n"
                    "• `!hatirla <konu>` — Kayıtlı sohbet geçmişinde ara\n"
                    "• `/ara <soru>` veya `!ara <soru>` — İnternette araştır (cevap yalnızca sana)\n"
                    "• `!hafizam` / `!hafizaekle` / `!unut <id>` / `!unuttur` — Hafızanı yönet\n"
                    "• `!aiyardim` — Yetenekler, sınırlar ve gizlilik • `!aidurum` — Durum ve kota"
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
                    "• `!xpekle @üye <miktar> <sebep>` — Kullanıcıya XP ekler\n"
                    "• `!xpçıkar @üye <miktar> <sebep>` — Kullanıcıdan XP çıkarır\n"
                    "• `!xpayarla @üye <miktar> <sebep>` — Kullanıcının toplam XP'sini doğrudan belirler\n"
                    "• `!boost @üye <çarpan> [saat] <sebep>` — Belirtilen süre için geçici XP boost tanımlar\n"
                    "• `!sürgün @üye <süre|kalıcı> <sebep>` — XP 0.5x, boost ve seri işlemez (örn. `3g`, `12sa`)\n"
                    "• `!sürgünsonlandır @üye` — Sürgünü erken bitirir\n"
                    "• `!basarimver @üye <başarım> [gümüş|altın|platin]` / `!basarimal @üye <başarım>` — Başarım ver / geri al\n"
                    "• *XP komutlarında sebep zorunludur; tüm işlemler kayıt altına alınır*\n"
                    "• `!xpsenkronize` — Sunucu üyelerinin XP rollerini kontrol edip eşitler\n"
                    "• `!yedekle` — Veritabanının anlık yedeğini güvenle alır\n"
                    "• `!dünyadurum` — GAP Dünyası'nın anlık video upload hızı, akışlar ve oyuncular"
                ),
                inline=False,
            )
            embed.add_field(
                name="🕵️ Denetim & Hile Analizi (Admin)",
                value=(
                    "• `!supheli [gün]` — Tüm üyeleri tarar, şüphe skoruna göre sıralar\n"
                    "• `!analiz @üye [gün]` — Üyenin XP kaynakları, mesaj/ses davranışı ve ses partnerleri\n"
                    "• `!eskianaliz` — Kayıt öncesi toplam verilerden alt hesap/anormal XP taraması\n"
                    "• `!olaylar @üye [adet]` — Üyenin son olay kayıtları\n"
                    "• `!adminlog [gün]` — XP/boost admin işlemleri ve yetkisiz denemeler"
                ),
                inline=False,
            )
            if self.bot.get_cog("AICog") is not None:
                embed.add_field(
                    name="🧠 AI Yönetimi (Admin)",
                    value=(
                        "• `!aiayar` — AI ayarları ve sistem durumu\n"
                        "• `!aiayar kanal ekle|cikar [#kanal]` — Kanal hafızasını aç/kapat\n"
                        "• `!aiayar ac|kapat`, `mod`, `cooldown`, `saklama`, `bakim`, `yedekle`"
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
        await ctx.send(embed=self._build_changelog_embed())

    def _build_changelog_embed(self) -> discord.Embed:
        embed = discord.Embed(
            title=f"🚀 Bot-GAP v{BOT_VERSION} Deploy & Güncelleme Notları",
            description=(
                f"**Yayın Tarihi:** {LAST_DEPLOY_DATE}\n"
                "GAP Dünyası daha canlı: sık çimen, gece ışıkları, konuşma baloncukları! 🌙✨"
            ),
            color=discord.Color.from_rgb(0, 212, 255),
        )

        embed.add_field(
            name="✨ Dünya Görsel Güncellemesi",
            value=(
                "• 🌙 Gece lambalar etrafı gerçekten aydınlatıyor, ışıklar parlıyor; ağaçlıklarda ateş böcekleri, gökte ay\n"
                "• 🌿 Karakterin çevresinde sık, rüzgârda dalgalanan çimen; üstünden geçince eğiliyor\n"
                "• 💬 Sohbete yazdığın mesaj kafanın üstünde baloncuk olarak çıkıyor\n"
                "• 💨 Zıpladığında ayaklarından toz kalkıyor, zıplama artık havada süzülüyor\n"
                "• 🔊 Sinemada bir şey oynarken hoparlörler ritimle titriyor, notalar uçuşuyor"
            ),
            inline=False,
        )

        embed.add_field(
            name="🌍 GAP Dünyası",
            value=(
                "• Ses kanalında 🚀 Etkinlikler → **Bot GAP** ile 3D dünyaya gir\n"
                "• 🎬 Sinema: 🎬 düğmesi, perdenin önünde **F** ya da `!izle <link>`. TRT (tabii) ve .m3u8/.mp4 videolar "
                "**Activity'nin içinde perdede** oynar; YouTube/Twitch/Kick tarayıcıda, ama herkes aynı odada. ⛶ tam ekran\n"
                "• 💬 Oyun içi sohbet (**Enter**): `!xp`, `!seri`, `!ses`, `!sıra`, `!gardırop`, `!yardım` komutları da çalışır\n"
                "• 🍢 Mangal, ⛓️ zindanda çay/domates, 🌸 Sakura Bahçesi, 🏆 Şöhret Kürsüsü\n"
                "• 🎣 Gölde günde bir balık: nadirliğe göre 1–24 saat **2x XP**; art arda günler efsanevi şansını artırır"
            ),
            inline=False,
        )

        embed.add_field(
            name="🏅 #ödüller",
            value="• Nadir balıklar ve yeni başarımlar #ödüller kanalında duyuruluyor (ping atmadan)",
            inline=False,
        )

        embed.set_footer(text="Bot-GAP • Tüm komutlar için: !yardim")
        if self.bot.user and self.bot.user.display_avatar:
            try:
                embed.set_thumbnail(url=self.bot.user.display_avatar.url)
            except Exception:
                pass

        return embed

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
