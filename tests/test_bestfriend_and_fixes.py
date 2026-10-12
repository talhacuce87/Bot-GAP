"""
Arkadaşlık tier'ları, !bf / !arkadaslar kartları, !xpçıkar ve veritabanı
düzeltmeleri (ses süresi, XP oranı, boost, streak, sıralama) için testler.
"""

from __future__ import annotations

import io
import time

import pytest
from PIL import Image

import bestfriend as bf
import database

H = 3600


@pytest.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    await database.init_db()
    return database


async def _set(user_id: int, sql_set: str, *params) -> None:
    async with database._db() as conn:
        await conn.execute(f"UPDATE user_xp SET {sql_set} WHERE guild_id = 1 AND user_id = ?", (*params, user_id))
        await conn.commit()


# ---------------------------------------------------------------------------
# Sahte Discord nesneleri
# ---------------------------------------------------------------------------

def _png(color: str) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), color).save(buf, "PNG")
    return buf.getvalue()


class _Asset:
    def __init__(self, color: str | None) -> None:
        self.color = color

    def replace(self, **_):
        return self

    async def read(self) -> bytes:
        if self.color is None:
            raise OSError("ağ hatası")
        return _png(self.color)


class _Guild:
    id = 1

    def __init__(self) -> None:
        self.members: dict[int, _Member] = {}

    def get_member(self, uid: int):
        return self.members.get(uid)


class _Member:
    def __init__(self, guild: _Guild, uid: int, name: str, color: str | None = "red", bot: bool = False) -> None:
        self.guild, self.id, self.display_name, self.name, self.bot = guild, uid, name, name.lower(), bot
        self.display_avatar = _Asset(color)
        guild.members[uid] = self


# ---------------------------------------------------------------------------
# Tier hesapları
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("hours", "current", "nxt", "ratio"),
    [
        (0, None, "Tanıdık", 0.0),
        (4, None, "Tanıdık", 0.8),
        (5, "Tanıdık", "Arkadaş", 0.0),
        (35, "Arkadaş", "Yakın Arkadaş", 0.5),
        (100, "Best Friend", "Kanka", 0.0),
        (600, "Ruh İkizi", None, 1.0),
    ],
)
def test_tier_info(hours, current, nxt, ratio):
    info = bf.get_tier_info(hours * H)
    assert (info.current.name if info.current else None) == current
    assert (info.next.name if info.next else None) == nxt
    assert info.ratio == pytest.approx(ratio)


def test_tiers_sorted_and_ai_threshold_kept():
    hours = [t.hours for t in bf.FRIEND_TIERS]
    assert hours == sorted(hours)
    assert bf.BEST_FRIEND_THRESHOLD_SECONDS == 100 * H  # ai/cog.py bu sabiti kullanır


# ---------------------------------------------------------------------------
# Kartlar
# ---------------------------------------------------------------------------

async def test_friend_list_skips_bots_and_departed_members(db):
    g = _Guild()
    me = _Member(g, 1, "Ahmet")
    _Member(g, 2, "Mehmet")
    _Member(g, 3, "Ayşe")
    _Member(g, 4, "BotX", bot=True)
    await db.add_pair_voice_seconds_bulk(1, [1, 2], 30 * H)
    await db.add_pair_voice_seconds_bulk(1, [1, 3], 60 * H)
    await db.add_pair_voice_seconds_bulk(1, [1, 4], 999 * H)  # bot
    await db.add_pair_voice_seconds_bulk(1, [1, 99], 888 * H)  # sunucudan çıkmış

    cog = bf.BestFriendCog.__new__(bf.BestFriendCog)
    friends = await cog._resolve_friends(me, 10)
    assert [(f.display_name, s) for f, s in friends] == [("Ayşe", 60 * H), ("Mehmet", 30 * H)]


@pytest.mark.parametrize("hours", [0, 72, 620])
async def test_bf_card_renders_opaque(db, hours):
    g = _Guild()
    me = _Member(g, 1, "Ahmet 🎮")
    if hours:
        _Member(g, 2, "Mehmet", color=None)  # avatar indirilemese de kart üretilmeli
        await db.add_pair_voice_seconds_bulk(1, [1, 2], hours * H)

    cog = bf.BestFriendCog.__new__(bf.BestFriendCog)
    img = Image.open(await cog.build_card(me))
    assert img.size == (bf.CARD_WIDTH, bf.CARD_HEIGHT)
    assert img.mode == "RGB"


async def test_friend_list_renders_and_empty_returns_none(db):
    g = _Guild()
    me = _Member(g, 1, "Ahmet")
    cog = bf.BestFriendCog.__new__(bf.BestFriendCog)
    assert await cog.build_friend_list(me) is None

    for uid in range(2, 6):
        _Member(g, uid, f"Üye {uid}")
        await db.add_pair_voice_seconds_bulk(1, [1, uid], uid * 20 * H)
    img = Image.open(await cog.build_friend_list(me))
    assert img.mode == "RGB"
    assert img.size[1] == bf.LIST_HEADER_H + 4 * bf.LIST_ROW_H + 20


# ---------------------------------------------------------------------------
# Veritabanı düzeltmeleri
# ---------------------------------------------------------------------------

async def test_set_total_xp_keeps_text_voice_ratio(db):
    await db.add_text_xp(1, 5, 1000)
    await db.add_voice_xp(1, 5, 250)
    assert await db.set_total_xp(1, 5, delta=250) == (1250, 1500)
    row = await db.get_user_row(1, 5)
    assert (row["text_xp"], row["voice_xp"]) == (1200, 300)

    assert await db.set_total_xp(1, 6, total=100) == (0, 100)
    row = await db.get_user_row(1, 6)
    assert (row["text_xp"], row["voice_xp"]) == (100, 0)
    assert await db.set_total_xp(1, 6, delta=-500) == (100, 0)


async def test_restart_does_not_count_downtime_as_voice_time(db):
    await db.start_voice_session(1, 7)
    await _set(7, "active_voice_started_at = ?", time.time() - 10 * H)
    await db.close_stale_voice_sessions(1, 180)
    row = await db.get_user_row(1, 7)
    assert row["voice_seconds"] == 180
    assert row["active_voice_started_at"] is None


async def test_flush_voice_sessions_keeps_fraction(db):
    await db.start_voice_session(1, 8)
    await _set(8, "active_voice_started_at = ?", time.time() - 125.5)
    await db.flush_voice_sessions(1)
    row = await db.get_user_row(1, 8)
    assert row["voice_seconds"] == 125
    live = row["voice_seconds"] + time.time() - row["active_voice_started_at"]
    assert live == pytest.approx(125.5, abs=1)


async def test_boost_validation_and_expiry(db):
    with pytest.raises(ValueError):
        await db.set_boost(1, 9, float("nan"), 3600)
    await _set(9, "xp_boost_multiplier = 50, xp_boost_expires_at = ?", time.time() + 99)
    assert await db.get_active_multiplier(1, 9) == 1.0

    await db.set_boost(1, 9, 2.0, -5)
    row = await db.get_user_row(1, 9)
    assert db.active_boost(row) == (1.0, None)


async def test_streak_counts_once_per_day_and_broken_streak_shows_zero(db):
    assert await db.update_streak(1, 10) == (1, True)
    assert await db.update_streak(1, 10) == (1, False)
    await _set(10, "streak_days = 9, last_message_date = '2020-01-01'")
    row = await db.get_user_row(1, 10)
    assert db.current_streak(row) == 0


async def test_rank_matches_leaderboard_on_ties(db):
    for uid in (23, 21, 22):
        await db.add_text_xp(1, uid, 777)
    rows = await db.get_leaderboard(1, 10)
    assert [r["user_id"] for r in rows] == [21, 22, 23]
    for i, uid in enumerate((21, 22, 23), start=1):
        assert await db.get_user_rank(1, uid) == i


# ---------------------------------------------------------------------------
# !xpçıkar
# ---------------------------------------------------------------------------

async def test_xpcikar_command(db, monkeypatch):
    from xp import XPTrackerCog

    cmd = next(c for c in XPTrackerCog.__cog_commands__ if c.name == "xpcikar")
    assert "xpçıkar" in cmd.aliases

    sent: list[str] = []

    class Ctx:
        guild = _Guild()
        author = channel = None

        async def send(self, msg):
            sent.append(msg)

    cog = XPTrackerCog.__new__(XPTrackerCog)
    monkeypatch.setattr(cog, "_audit_admin", lambda *a, **k: None, raising=False)

    async def no_sync(member):
        return None

    monkeypatch.setattr(cog, "_sync_role", no_sync, raising=False)
    target = _Member(_Guild(), 7, "Ahmet")

    await db.add_text_xp(1, 7, 800)
    await db.add_voice_xp(1, 7, 200)
    await cmd.callback(cog, Ctx(), target, 300, reason="test sebebi")
    await cmd.callback(cog, Ctx(), target, 5000, reason="test sebebi")
    await cmd.callback(cog, Ctx(), target, 300, reason="kısa")

    assert "300 XP** çıkarıldı" in sent[0] and "700 XP" in sent[0]
    assert "sadece 700 XP'si vardı" in sent[1]
    assert "sebep yazmak zorunlu" in sent[2]
    row = await db.get_user_row(1, 7)
    assert (row["text_xp"], row["voice_xp"]) == (0, 0)
