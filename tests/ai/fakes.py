"""Discord nesneleri için hafif sahteler (ağ bağlantısı olmadan cog testleri)."""

from __future__ import annotations

import datetime as dt
import itertools
from unittest.mock import AsyncMock, MagicMock

import discord

_ids = itertools.count(1_200_000_000_000_000_000)


def nid() -> int:
    return next(_ids)


class FakeChannel:
    def __init__(self, guild, cid=None, name="genel", public=True, readers=()):
        self.id = cid or nid()
        self.name = name
        self.guild = guild
        self.public = public
        self.readers = set(readers)
        self.parent_id = None
        self.type = discord.ChannelType.text
        self.send = AsyncMock()
        self.typing = lambda: _AsyncNull()
        self.mention = f"<#{self.id}>"

    def permissions_for(self, who):
        if who == "everyone":
            ok = self.public
        else:
            ok = self.public or getattr(who, "id", None) in self.readers
        gp = getattr(who, "guild_permissions", None)
        if gp is not None and gp.administrator:
            return discord.Permissions.all()
        return discord.Permissions(view_channel=ok, read_message_history=ok, send_messages=ok)


class _AsyncNull:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeGuild:
    def __init__(self, gid=None, name="GAP"):
        self.id = gid or nid()
        self.name = name
        self.default_role = "everyone"
        self.channels: dict[int, FakeChannel] = {}
        self.members: dict[int, object] = {}
        self.afk_channel = None
        self.voice_channels = []
        self.me = None  # xproles.sync_member_role erken döner

    def get_role(self, rid):
        return None

    def add_channel(self, **kw) -> FakeChannel:
        ch = FakeChannel(self, **kw)
        self.channels[ch.id] = ch
        return ch

    @property
    def text_channels(self):
        return list(self.channels.values())

    def get_channel_or_thread(self, cid):
        return self.channels.get(cid)

    get_channel = get_channel_or_thread

    def get_member(self, uid):
        return self.members.get(uid)


def make_member(guild, uid=None, name="ali", admin=False, bot=False):
    m = MagicMock(spec=discord.Member)
    m.id = uid or nid()
    m.bot = bot
    m.display_name = name
    m.name = name
    m.mention = f"<@{m.id}>"
    m.guild = guild
    m.guild_permissions = discord.Permissions(administrator=admin)
    m.send = AsyncMock()
    m.voice = None
    m.roles = []
    m.created_at = dt.datetime(2020, 1, 1, tzinfo=dt.timezone.utc)
    m.display_avatar = MagicMock()
    guild.members[m.id] = m
    return m


def make_message(guild, channel, author, content, *, mentions=(), reference=None, webhook_id=None):
    msg = MagicMock(spec=discord.Message)
    msg.id = nid()
    msg.guild = guild
    msg.channel = channel
    msg.author = author
    msg.content = content
    msg.mentions = list(mentions)
    msg.role_mentions = []
    msg.mention_everyone = False
    msg.reference = reference
    msg.webhook_id = webhook_id
    msg.attachments = []
    msg.stickers = []
    msg.created_at = dt.datetime.now(dt.timezone.utc)
    msg.reply = AsyncMock()
    msg.add_reaction = AsyncMock()
    return msg


def make_ctx(guild, channel, author, content="!x"):
    ctx = MagicMock()
    ctx.guild = guild
    ctx.channel = channel
    ctx.author = author
    ctx.interaction = None
    ctx.message = make_message(guild, channel, author, content)
    ctx.send = AsyncMock()
    ctx.permissions = discord.Permissions(administrator=bool(author.guild_permissions.administrator))
    return ctx
