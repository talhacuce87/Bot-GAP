"""
ai/persona.py — Düzenlenebilir persona yükleyici.

persona/default.md varsayılandır; persona/<guild_id>.md varsa o sunucu için
onu kullanır. Dosyalar değişiklik zamanına göre önbelleğe alınır, bot
yeniden başlatılmadan düzenlenebilir. Persona sadece üslup tanımlar;
güvenlik kuralları context.py'deki sabit sistem kurallarındadır ve persona
dosyasıyla geçersiz kılınamaz.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("gap.ai.persona")

MAX_PERSONA_CHARS = 4000
FALLBACK_PERSONA = (
    "Sen Bot-GAP adlı samimi, kısa ve dürüst bir Discord botusun. Türkçe konuşursun. "
    "Bilmediğin şeyleri uydurmazsın."
)


class PersonaStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self._cache: dict[Path, tuple[float, str]] = {}

    def _read(self, path: Path) -> str | None:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None
        cached = self._cache.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
        try:
            text = path.read_text(encoding="utf-8").strip()[:MAX_PERSONA_CHARS]
        except OSError as err:
            log.warning("Persona okunamadı (%s): %s", path.name, err)
            return None
        self._cache[path] = (mtime, text)
        return text

    def get(self, guild_id: int | None = None) -> str:
        if guild_id is not None:
            text = self._read(self.directory / f"{int(guild_id)}.md")
            if text:
                return text
        return self._read(self.directory / "default.md") or FALLBACK_PERSONA
