"""
ai/guard.py — Güvenlik ve gizlilik yardımcıları.

- Kullanıcı girdisini temizleme / uzunluk sınırı
- Hassas veri (e-posta, telefon, IBAN, TC kimlik, kart no, token) maskeleme
- Güvenilmeyen metnin prompt sınırlayıcılarını bozamaması
- Kaynak kanal yetkilendirmesi: geçmiş arama sonucu, yanıtın gönderileceği
  kanalı görebilen herkesin zaten görebileceği kanallarla sınırlanır.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

import discord

from ai.textutil import collapse_ws, truncate

# ---------------------------------------------------------------------------
# Hassas veri
# ---------------------------------------------------------------------------

def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def _tckn_ok(d: str) -> bool:
    if len(d) != 11 or d[0] == "0":
        return False
    n = [int(c) for c in d]
    if ((sum(n[0:9:2]) * 7 - sum(n[1:8:2])) % 10) != n[9]:
        return False
    return sum(n[:10]) % 10 == n[10]


# Mention/emoji ID'lerinin (<@123…>) içindeki rakamlara dokunmamak için sınır.
_NB = r"(?<![\d<@#:&!])"

_SENSITIVE_PATTERNS: list[tuple[str, re.Pattern[str], Any]] = [
    ("email", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), None),
    ("iban", re.compile(r"\bTR\s?\d{2}(?:\s?\d{4}){5}\s?\d{2}\b", re.IGNORECASE), None),
    ("card", re.compile(_NB + r"\d(?:[ -]?\d){12,15}(?![\d>])"),
     lambda m: _luhn_ok(re.sub(r"\D", "", m.group(0)))),
    ("tckn", re.compile(_NB + r"\d{11}(?![\d>])"), lambda m: _tckn_ok(m.group(0))),
    ("phone", re.compile(_NB + r"(?:\+?90[\s-]?)?\(?0?5\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?![\d>])"), None),
    ("discord_token", re.compile(r"\b[MNO][\w-]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b"), None),
    ("api_key", re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"), None),
    ("password", re.compile(r"(?i)\b(?:şifre(?:m|si)?|parola(?:m)?|password)\s*[:=]?\s*\S+"), None),
]

REDACTED = "[gizlendi]"


def find_sensitive(text: str) -> list[str]:
    found = []
    for name, pat, valid in _SENSITIVE_PATTERNS:
        if any(valid is None or valid(m) for m in pat.finditer(text)):
            found.append(name)
    return found


def redact_sensitive(text: str) -> str:
    for _, pat, valid in _SENSITIVE_PATTERNS:
        text = pat.sub(lambda m, v=valid: REDACTED if v is None or v(m) else m.group(0), text)
    return text


# ---------------------------------------------------------------------------
# Girdi / çıktı
# ---------------------------------------------------------------------------

def strip_bot_mention(text: str, bot_id: int | None) -> str:
    if bot_id:
        text = re.sub(rf"<@!?{bot_id}>", " ", text)
    return collapse_ws(text)


def clean_user_input(text: str, bot_id: int | None, max_chars: int) -> str:
    return truncate(strip_bot_mention(text, bot_id), max_chars)


def neutralize_untrusted(text: str) -> str:
    """
    Kullanıcı kontrolündeki metnin, prompt'taki <...> blok sınırlayıcılarını
    taklit edip "bloktan çıkmasını" engeller.
    """
    return text.replace("<", "‹").replace(">", "›")


_MASS_MENTION_RE = re.compile(r"@(everyone|here)", re.IGNORECASE)


def clean_model_output(text: str, max_chars: int = 1900) -> str:
    # allowed_mentions zaten kapalı; bu ek bir katman. Sıfır genişlikli boşlukla kır.
    text = _MASS_MENTION_RE.sub(lambda m: "@​" + m.group(1), text)
    text = re.sub(r"<@[!&]?\d+>", "", text)  # modelin ürettiği ham mention'lar
    text = re.sub(r"\s*\[K\d+(?:\s*,\s*K?\d+)*\]", "", text)  # iç kanıt etiketleri; linkler ayrıca eklenir
    return truncate(text.strip(), max_chars)


def render_mentions(text: str, resolve_user: Any = None, resolve_channel: Any = None) -> str:
    """<@id> / <#id> belirteçlerini okunabilir isimlere çevirir (modele ID sızmasın, ping atılmasın)."""
    def user_sub(m: re.Match[str]) -> str:
        name = resolve_user(int(m.group(1))) if resolve_user else None
        return f"@{name}" if name else "@kullanıcı"

    def chan_sub(m: re.Match[str]) -> str:
        name = resolve_channel(int(m.group(1))) if resolve_channel else None
        return f"#{name}" if name else "#kanal"

    text = re.sub(r"<@!?(\d+)>", user_sub, text)
    text = re.sub(r"<@&\d+>", "@rol", text)
    text = re.sub(r"<#(\d+)>", chan_sub, text)
    text = re.sub(r"<a?:(\w+):\d+>", r":\1:", text)
    return text


# ---------------------------------------------------------------------------
# Kanal yetkilendirmesi
# ---------------------------------------------------------------------------

def _can_read(channel: Any, who: Any) -> bool:
    try:
        perms = channel.permissions_for(who)
    except Exception:
        return False
    return bool(perms.view_channel and perms.read_message_history)


def authorized_source_channels(
    guild: discord.Guild,
    requester: discord.Member,
    response_channel: Any,
    indexed_channel_ids: Iterable[int],
) -> set[int]:
    """
    Geçmiş aramada kullanılabilecek kanal ID'leri. Bir kanal ancak şu
    koşulların hepsini sağlıyorsa döner:
      1. Kanal şu an indekslemeye açık (indexed_channel_ids içinde),
      2. Soran üye kanalı görebiliyor ve geçmişini okuyabiliyor (güncel izin),
      3. Kanal ya yanıtın gönderileceği kanalın kendisi (veya onun üst kanalı),
         ya da @everyone tarafından okunabilen herkese açık bir kanal.
    3. kural, özel bir kanaldaki konuşmanın daha geniş kitleli bir kanalda
    yanıt olarak sızmasını engeller.
    """
    same = {getattr(response_channel, "id", None), getattr(response_channel, "parent_id", None)}
    same.discard(None)
    allowed: set[int] = set()
    for cid in indexed_channel_ids:
        ch = guild.get_channel_or_thread(cid) if hasattr(guild, "get_channel_or_thread") else guild.get_channel(cid)
        if ch is None or not _can_read(ch, requester):
            continue
        if cid in same or _can_read(ch, guild.default_role):
            allowed.add(cid)
    return allowed


def jump_url(guild_id: int, channel_id: int, message_id: int) -> str:
    return f"https://discord.com/channels/{guild_id}/{channel_id}/{message_id}"
