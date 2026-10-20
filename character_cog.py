"""
character_cog.py — !karakter: üyenin GAP Dünyası'ndaki chibi karakterinin resmi.

    !karakter            → kendi karakterin
    !karakter <üye>      → etiket, kullanıcı adı ya da sunucu takma adıyla başkasınınki

Kıyafet dünyadaki gardıroptan değiştirilir (outfit.py, world_cog.py → /internal/outfit);
resim chibi_render.py ile GPU'suz çizilir.
"""

from __future__ import annotations

import asyncio
import io
import logging

import discord
from discord.ext import commands

import chibi_render
import database as db
import outfit
from xproles import XPRoleManager

log = logging.getLogger("gap.character")

IMAGE_SIZE = 512


async def member_level(member: discord.Member, roles: XPRoleManager | None = None) -> int:
    row = await db.get_user_row(member.guild.id, member.id)
    total = int(row["total_xp"]) if row else 0
    return (roles or XPRoleManager()).get_progress_data(total)[0]


class CharacterCog(commands.Cog):
    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self.roles = XPRoleManager()

    @commands.command(name="karakter", aliases=["karakterim", "chibi", "avatar3d"], usage="[üye]")
    @commands.guild_only()
    async def karakter_command(self, ctx: commands.Context, *, member: discord.Member | None = None) -> None:
        """Kendi ya da başka bir üyenin karakterini resim olarak gösterir."""
        target = member or ctx.author
        level = await member_level(target, self.roles)
        saved = await db.get_outfit(ctx.guild.id, target.id)
        look = await outfit.load(ctx.guild.id, target.id, level)

        async with ctx.typing():
            try:
                image = await asyncio.to_thread(chibi_render.render, look, IMAGE_SIZE)
            except Exception:
                log.exception("Karakter çizilemedi: %s", target.id)
                await ctx.send("❌ Karakter çizilemedi, biraz sonra tekrar dene.")
                return
            buf = io.BytesIO()
            image.save(buf, "PNG")
            buf.seek(0)

        lines = [f"**{outfit.SLOT_LABELS[slot]}:** {outfit.label(look[slot])}" for slot in outfit.SLOTS if look[slot]]
        embed = discord.Embed(
            title=f"🧍 {target.display_name}",
            description="\n".join(lines),
            color=target.color if target.color.value else discord.Color.from_rgb(0, 212, 255),
        )
        embed.set_image(url="attachment://karakter.png")
        embed.set_footer(
            text="Gardırop: GAP Dünyası" if saved else "Henüz özelleştirilmedi · GAP Dünyası'ndaki gardıroptan değiştir"
        )
        await ctx.send(embed=embed, file=discord.File(buf, filename="karakter.png"))

    @karakter_command.error
    async def _karakter_error(self, ctx: commands.Context, error: commands.CommandError) -> None:
        if isinstance(error, commands.MemberNotFound):
            await ctx.send(f"❌ `{error.argument}` adında bir üye bulamadım.")
        elif isinstance(error, commands.NoPrivateMessage):
            await ctx.send("Bu komut sadece sunucuda kullanılabilir.")
        else:
            raise error
