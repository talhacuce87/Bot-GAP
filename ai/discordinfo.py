"""
ai/discordinfo.py — Sorudaki niyete göre Discord önbelleğinden okunan sunucu bilgisi.

Model Discord'a doğrudan erişmez; uygulama soruda tanıdığı basit niyetler için
bilgiyi toplar ve <sunucu_verisi> olarak verir. Yalnızca soran kişinin Discord'da
zaten görebildiği bilgiler döner:
  - sunucu bilgisi (kuruluş, sahip, üye/kanal/rol/takviye sayıları)
  - roller ve bir rolün üyeleri (üye listesinde herkese açık)
  - soran kişinin görebildiği kanallar ve o kanallarda seste olanlar
  - adı geçen / etiketlenen üyelerin profil bilgisi
Mesaj içerikleri buradan OKUNMAZ (bunun için yönetici onaylı kanal hafızası var).
Çevrimiçi durumu, botta Presence Intent olmadığı için bilinemez.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any, Callable

from ai.retrieval import TR_TZ
from ai.textutil import fold

_SERVER_RE = re.compile(
    r"sunucu\w* (ne zaman|kac|sahib|kurucu|olustur|kurul|bilgi|hakkinda|yas)|kurucu\w*|sahibi kim|owner|"
    r"kac (uye|kisi)|uye sayisi|kisi var|boost|takviye"
)
_ROLES_RE = re.compile(r"\broller\w*|\brol(u|un|unde|une|deki|de|e)?\b|rol listesi|hangi rol")
_CHANNELS_RE = re.compile(r"kanallar\w*|kanal listesi|hangi kanal|kac kanal")
_VOICE_RE = re.compile(r"\bseste\b|\bseste kim|ses kanal|sesli|voice|\bsesteki")
_ONLINE_RE = re.compile(r"online|cevrimici|aktif kac|kac kisi aktif|kimler aktif")
_WHO_RE = re.compile(r"\bkim\b|kimdir|kim bu|tanir mis|taniyor mus|hakkinda|nesi")
_MENTION_RE = re.compile(r"<@!?(\d+)>")

MAX_LIST = 25


def _fmt_date(d: dt.datetime | None) -> str:
    return d.astimezone(TR_TZ).strftime("%d.%m.%Y") if d else "?"


def _can_view(channel: Any, member: Any) -> bool:
    try:
        return bool(channel.permissions_for(member).view_channel)
    except Exception:
        return False


def _names(items: list[str], limit: int = MAX_LIST) -> str:
    shown = ", ".join(items[:limit])
    return shown + (f" … (+{len(items) - limit})" if len(items) > limit else "")


def _word_in(needle: str, haystack: str) -> bool:
    return bool(needle) and re.search(rf"(?<!\w){re.escape(needle)}(?!\w)", haystack) is not None


def server_lines(guild: Any) -> list[str]:
    owner = guild.get_member(guild.owner_id) if getattr(guild, "owner_id", None) else None
    text_count = len(getattr(guild, "text_channels", []))
    voice_count = len(getattr(guild, "voice_channels", []))
    roles = [r for r in getattr(guild, "roles", []) if not r.is_default()]
    return [
        f"Sunucu \"{guild.name}\": {_fmt_date(getattr(guild, 'created_at', None))} tarihinde kuruldu; "
        f"sahibi {owner.display_name if owner else 'bilinmiyor'}; {getattr(guild, 'member_count', '?')} üye; "
        f"{text_count} yazı ve {voice_count} ses kanalı; {len(roles)} rol; "
        f"takviye seviyesi {getattr(guild, 'premium_tier', 0)} ({getattr(guild, 'premium_subscription_count', 0) or 0} takviye)."
    ]


def role_lines(guild: Any, folded_question: str) -> list[str]:
    roles = [r for r in reversed(getattr(guild, "roles", [])) if not r.is_default() and not getattr(r, "managed", False)]
    named = [r for r in roles if len(fold(r.name)) >= 3 and _word_in(fold(r.name), folded_question)]
    lines: list[str] = []
    for r in named[:3]:
        members = [m.display_name for m in getattr(r, "members", []) if not m.bot]
        lines.append(f"\"{r.name}\" rolünde {len(members)} üye var: {_names(members) or '-'}.")
    if not named:
        lines.append("Sunucudaki roller (üstten alta, üye sayısıyla): "
                     + _names([f"{r.name} ({len(getattr(r, 'members', []))})" for r in roles], 30) + ".")
    return lines


def channel_lines(guild: Any, requester: Any) -> list[str]:
    text = [c.name for c in getattr(guild, "text_channels", []) if _can_view(c, requester)]
    voice = [c.name for c in getattr(guild, "voice_channels", []) if _can_view(c, requester)]
    return [f"Görebildiğin yazı kanalları: {_names(text, 40) or '-'}.",
            f"Görebildiğin ses kanalları: {_names(voice, 40) or '-'}."]


def voice_lines(guild: Any, requester: Any) -> list[str]:
    lines = []
    for c in getattr(guild, "voice_channels", []):
        if not _can_view(c, requester):
            continue
        people = [m.display_name for m in getattr(c, "members", []) if not m.bot]
        if people:
            lines.append(f"Şu an \"{c.name}\" ses kanalında: {_names(people)}.")
    return lines or ["Şu an görebildiğin ses kanallarında kimse yok."]


def named_members(guild: Any, folded_question: str, exclude: set[int]) -> list[int]:
    """Soruda adı (görünen ad / kullanıcı adı) bütün kelime olarak geçen üyeler; en fazla 3."""
    found: list[int] = []
    for m in getattr(guild, "members", []):
        if m.bot or m.id in exclude:
            continue
        for name in {fold(m.display_name), fold(m.name)}:
            if len(name) >= 3 and _word_in(name, folded_question):
                found.append(m.id)
                break
        if len(found) >= 3:
            break
    return found


def gather_discord_info(
    guild: Any,
    requester: Any,
    question: str,
    bot_id: int | None,
    member_info: Callable[[int, int], list[str]],
) -> list[str]:
    q = fold(_MENTION_RE.sub(" ", question))
    lines: list[str] = []
    if _SERVER_RE.search(q):
        lines += server_lines(guild)
    if _ROLES_RE.search(q):
        lines += role_lines(guild, q)
    if _CHANNELS_RE.search(q):
        lines += channel_lines(guild, requester)
    if _VOICE_RE.search(q):
        lines += voice_lines(guild, requester)
    if _ONLINE_RE.search(q):
        lines.append("Çevrimiçi/aktif üye sayısını bilemem (botun durum bilgisi izni yok).")
    if _WHO_RE.search(q):
        mentioned = {int(x) for x in _MENTION_RE.findall(question)}
        for uid in named_members(guild, q, exclude=mentioned | {bot_id or 0}):
            lines += member_info(guild.id, uid)
    return lines
