from __future__ import annotations

import dataclasses
import itertools
from pathlib import Path

import pytest

from ai.config import AIConfig
from ai.storage import AIStorage

_ids = itertools.count(1_000_000_000_000_000_000)


def next_id() -> int:
    return next(_ids)


def make_cfg(tmp_path: Path | None = None, **overrides) -> AIConfig:
    base = AIConfig(
        enabled=True,
        api_key="test-key",
        model="test/model:free",
        api_base="https://openrouter.test/api/v1",
        db_path=(tmp_path / "ai_memory.db") if tmp_path else Path(":memory:"),
        backup_dir=(tmp_path / "backups") if tmp_path else Path("/nonexistent"),
        persona_dir=Path(__file__).resolve().parents[2] / "persona",
        user_cooldown_seconds=0,
        channel_cooldown_seconds=0,
        max_retries=2,
    )
    return dataclasses.replace(base, **overrides)


@pytest.fixture
def cfg(tmp_path):
    return make_cfg(tmp_path)


@pytest.fixture
async def storage(tmp_path):
    st = AIStorage(tmp_path / "ai_memory.db")
    await st.open()
    yield st
    await st.close()


async def add_msg(st: AIStorage, content: str, *, guild=1, channel=10, user=100, ts=1_000.0, mid=None, name="ali"):
    mid = mid or next_id()
    await st.insert_message(
        message_id=mid, guild_id=guild, channel_id=channel, user_id=user,
        author_name=name, content=content, created_at=ts,
    )
    return mid
