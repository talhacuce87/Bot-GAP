"""
Sürgün sistemi testleri: süre okuma, veritabanı kayıtları, serinin dondurulup
geri yüklenmesi, sürgünde XP hesabı, komutlar ve !sürgünler kartı.
"""

from __future__ import annotations

import datetime
import io
import time
from types import SimpleNamespace

import pytest
from PIL import Image

import activitylog
import database
import exile
import xp
from tests.test_bestfriend_and_fixes import _Guild, _Member, _set

H = 3600


@pytest.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    monkeypatch.setattr(activitylog, "_buffer", [])
    await database.init_db()
    return database


def _day(offset: int = 0) -> str:
    return (database._today() + datetime.timedelta(days=offset)).isoformat()


# ---------------------------------------------------------------------------
# Süre
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        ("30dk", 30 * 60), ("12sa", 12 * H), ("3g", 3 * 24 * H), ("1hafta", 7 * 24 * H),
        ("1g12sa", 36 * H), ("1g 12sa", 36 * H), ("2", 2 * H), ("1.5sa", 90 * 60), ("1ay", 30 * 24 * H),
        ("kalıcı", 0), ("KALICI", 0), ("Kalıcı", 0), ("süresiz", 0),
        ("abc", None), ("30sn", None), ("0dk", None), ("10x", None), ("30s", None), ("", None),
    ],
)
def test_parse_duration(text, seconds):
    assert exile.parse_duration(text) == seconds


@pytest.mark.parametrize(
    ("seconds", "text"),
    [(None, "Kalıcı"), (30, "<1dk"), (600, "10dk"), (H, "1sa"), (90 * 60, "1sa 30dk"),
     (24 * H, "1g"), (3 * 24 * H + 4 * H + 5, "3g 4sa")],
)
def test_format_remaining(seconds, text):
    assert exile.format_remaining(seconds) == text


# ---------------------------------------------------------------------------
# Veritabanı ve seri
# ---------------------------------------------------------------------------

async def test_set_update_list_and_end(db):
    assert await db.set_exile(1, 5, ends_at=time.time() + H, reason="ilk", moderator_id=9, channel_id=3) is True
    first = await db.get_exile(1, 5)
    assert await db.set_exile(1, 5, ends_at=None, reason="ikinci", moderator_id=8, channel_id=4) is False
    updated = await db.get_exile(1, 5)
    assert (updated["reason"], updated["ends_at"], updated["moderator_id"]) == ("ikinci", None, 8)
    assert updated["started_at"] == first["started_at"]             # başlangıç korunur

    await db.set_exile(1, 6, ends_at=time.time() + 2 * H, reason="x", moderator_id=9, channel_id=None)
    await db.set_exile(1, 7, ends_at=time.time() - 1, reason="bitti", moderator_id=9, channel_id=None)
    await db.set_exile(2, 5, ends_at=None, reason="başka sunucu", moderator_id=9, channel_id=None)
    assert [r["user_id"] for r in await db.list_exiles(1)] == [5, 6]  # kalıcı önce, dolan yok
    assert [r["user_id"] for r in await db.list_expired_exiles()] == [7]

    assert (await db.end_exile(1, 5))["reason"] == "ikinci"
    assert await db.get_exile(1, 5) is None
    assert await db.end_exile(1, 5) is None


@pytest.mark.parametrize(
    ("last_date_offset", "days_pass", "expected_after_release"),
    [
        (-1, True, -1),   # seri canlıydı, sürgün günler sürdü → bitince "dün" sayılır, ilk mesaj seriyi artırır
        (0, False, 0),    # bugün yazmıştı ve aynı gün affedildi → bugün ikinci kez artmaz
    ],
)
async def test_streak_frozen_and_restored(db, last_date_offset, days_pass, expected_after_release):
    await db.ensure_user(1, 5)
    await _set(5, "streak_days = 12, last_message_date = ?", _day(last_date_offset))
    await db.set_exile(1, 5, ends_at=None, reason="sebep", moderator_id=9, channel_id=None)
    assert (await db.get_exile(1, 5))["streak_at_start"] == 12

    if days_pass:  # sürgün 10 gün önce başlamış gibi: son mesaj tarihi o günden kaldı
        await _set(5, "last_message_date = ?", _day(-10))
    await db.end_exile(1, 5)
    row = await db.get_user_row(1, 5)
    assert (row["streak_days"], row["last_message_date"]) == (12, _day(expected_after_release))
    assert await db.update_streak(1, 5) == ((13, True) if expected_after_release == -1 else (12, False))


async def test_broken_streak_is_not_revived(db):
    await db.ensure_user(1, 5)
    await _set(5, "streak_days = 30, last_message_date = ?", _day(-5))
    await db.set_exile(1, 5, ends_at=None, reason="sebep", moderator_id=9, channel_id=None)
    assert (await db.get_exile(1, 5))["streak_at_start"] == 0
    await db.end_exile(1, 5)
    assert await db.update_streak(1, 5) == (1, True)


# ---------------------------------------------------------------------------
# XP hesabı
# ---------------------------------------------------------------------------

def _xp_cog() -> tuple[xp.XPTrackerCog, list]:
    dispatched: list = []

    async def get_context(message):
        return SimpleNamespace(valid=False)

    bot = SimpleNamespace(get_context=get_context, dispatch=lambda *a: dispatched.append(a))
    return xp.XPTrackerCog(bot), dispatched


def _message(uid: int = 5):
    return SimpleNamespace(
        author=SimpleNamespace(bot=False, id=uid), guild=SimpleNamespace(id=1),
        channel=SimpleNamespace(id=3, send=None), content="merhaba",
    )


def test_exiled_xp_carries_fraction():
    cog, _ = _xp_cog()
    assert [cog._exiled_xp(1, 5, 1) for _ in range(4)] == [0, 1, 0, 1]   # ses: 2 dk'da 1 → yarısı
    assert cog._exiled_xp(1, 5, 7) == 3 and cog._exiled_xp(1, 5, 7) == 4  # 3.5 + 3.5


async def test_message_xp_is_half_and_ignores_boost_and_streak(db, monkeypatch):
    monkeypatch.setattr(xp.random, "randint", lambda a, b: 8)
    cog, _ = _xp_cog()
    await db.ensure_user(1, 5)
    await _set(5, "streak_days = 20, last_message_date = ?", _day(-1))
    await db.set_boost(1, 5, 3.0, H)
    await db.set_exile(1, 5, ends_at=time.time() + H, reason="sebep", moderator_id=9, channel_id=None)

    await cog.on_message(_message())
    row = await db.get_user_row(1, 5)
    assert row["text_xp"] == 4                                        # 8 × 0.5, boost/seri yok
    assert (row["streak_days"], row["last_message_date"]) == (20, _day(-1))  # seri dondu

    # Sürgün yokken aynı mesaj: 8 × 3 boost × 1.42 seri
    await db.end_exile(1, 5)
    cog._cooldowns.clear()
    await cog.on_message(_message())
    row = await db.get_user_row(1, 5)
    assert row["text_xp"] == 4 + round(8 * 3.0 * xp.streak_multiplier(21))
    assert row["streak_days"] == 21


async def test_expired_exile_closes_itself_before_streak(db):
    cog, dispatched = _xp_cog()
    await db.ensure_user(1, 5)
    await _set(5, "streak_days = 7, last_message_date = ?", _day(-1))
    await db.set_exile(1, 5, ends_at=time.time() + H, reason="sebep", moderator_id=9, channel_id=None)
    await _set(5, "last_message_date = ?", _day(-3))                # sürgünde 2 gün geçti
    async with database._db() as conn:
        await conn.execute("UPDATE exiles SET ends_at = ?", (time.time() - 5,))
        await conn.commit()

    await cog.on_message(_message())
    assert await db.get_exile(1, 5) is None
    assert dispatched and dispatched[0][0] == "exile_end"
    assert (await db.get_user_row(1, 5))["streak_days"] == 8          # seri kaldığı yerden devam etti


# ---------------------------------------------------------------------------
# Komutlar
# ---------------------------------------------------------------------------

class _Ctx:
    def __init__(self) -> None:
        self.guild = _Guild()
        self.author = _Member(self.guild, 9, "Talha")
        self.channel = SimpleNamespace(id=3)
        self.sent: list = []
        self.prefix, self.invoked_with = "!", "sürgün"

    async def send(self, content=None, **kwargs):
        self.sent.append(content if content is not None else kwargs.get("embed"))


def _cmd(name: str):
    return next(c for c in exile.ExileCog.__cog_commands__ if c.name == name)


def test_command_names_and_aliases():
    assert {"surgun", "exile"} <= set(_cmd("sürgün").aliases)
    assert {"surgunler"} <= set(_cmd("sürgünler").aliases)
    assert {"surgunsonlandir", "sürgünbitir"} <= set(_cmd("sürgünsonlandır").aliases)


async def test_exile_and_unexile_commands(db):
    audits: list = []
    cog = exile.ExileCog(SimpleNamespace(get_cog=lambda name: None))
    cog._audit = lambda ctx, event, target, **meta: audits.append((event, target.id, meta))
    ctx = _Ctx()
    target = _Member(ctx.guild, 5, "Ahmet")
    target.mention = "<@5>"
    target.display_avatar.url = "https://cdn/avatar.png"

    await _cmd("sürgün").callback(cog, ctx, target, "bilmem", reason="uzun bir sebep")
    await _cmd("sürgün").callback(cog, ctx, target, "2g", reason="kısa")
    assert "Süreyi anlayamadım" in ctx.sent[0] and "sebep yazmak zorunlu" in ctx.sent[1]
    assert await db.get_exile(1, 5) is None

    await _cmd("sürgün").callback(cog, ctx, target, "2g", reason="spam yaptı")
    row = await db.get_exile(1, 5)
    assert row["ends_at"] == pytest.approx(time.time() + 48 * H, abs=5)
    assert "Sürgüne gönderildi" in ctx.sent[-1].title and "0.5x" in ctx.sent[-1].description

    await _cmd("sürgün").callback(cog, ctx, target, "kalıcı", reason="tekrar spam")
    assert (await db.get_exile(1, 5))["ends_at"] is None
    assert "güncellendi" in ctx.sent[-1].title

    await _cmd("sürgünsonlandır").callback(cog, ctx, target)
    assert await db.get_exile(1, 5) is None and "sürgünden döndü" in ctx.sent[-1]
    await _cmd("sürgünsonlandır").callback(cog, ctx, target)
    assert "zaten sürgünde değil" in ctx.sent[-1]
    assert [a[0] for a in audits] == ["admin_exile", "admin_exile", "admin_exile_end"]


async def test_bots_cannot_be_exiled(db):
    cog = exile.ExileCog(SimpleNamespace(get_cog=lambda name: None))
    ctx = _Ctx()
    bot_member = _Member(ctx.guild, 77, "Bot-GAP", bot=True)
    await _cmd("sürgün").callback(cog, ctx, bot_member, "1g", reason="deneme sebebi")
    assert "Botlar" in ctx.sent[-1] and await db.get_exile(1, 77) is None


async def test_expiry_announces_in_original_channel(db):
    sent: list[str] = []
    alerts: list = []
    channel = SimpleNamespace(send=lambda text, **k: _record(sent, text))
    guild = SimpleNamespace(get_channel=lambda cid: channel if cid == 3 else None)
    bot = SimpleNamespace(get_guild=lambda gid: guild, dispatch=lambda *a: alerts.append(a))
    cog = exile.ExileCog(bot)

    await db.ensure_user(1, 5)
    await _set(5, "streak_days = 4, last_message_date = ?", _day(0))
    await db.set_exile(1, 5, ends_at=time.time() - 1, reason="sebep", moderator_id=9, channel_id=3)
    for row in await db.list_expired_exiles():
        await cog._expire(row)

    assert await db.get_exile(1, 5) is None
    assert "<@5> sürgünden döndü" in sent[0] and "4 günden" in sent[0]
    assert alerts[0][0] == "gap_alert"


async def _record(store: list, text: str) -> None:
    store.append(text)


# ---------------------------------------------------------------------------
# Kart
# ---------------------------------------------------------------------------

def _png(color: str, mode: str = "RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, (128, 128), color).save(buf, "PNG")
    return buf.getvalue()


@pytest.mark.parametrize("count", [0, 1, 4])
def test_card_renders(count):
    now = time.time()
    entries = [
        exile.ExileEntry(
            name=f"Üye {i}" * (i + 1), user_id=1000 + i, reason="sebep " * (i * 10 + 1), moderator="Talha",
            started_at=now - H, ends_at=None if i == 0 else now + i * H, streak=i * 5,
            avatar=[None, _png("red"), _png((0, 0, 0, 0), "RGBA"), b"bozuk"][i],
        )
        for i in range(count)
    ]
    img = Image.open(exile.render_exile_card("The Gap 🔥", entries, more=3 if count else 0, now=now))
    assert img.mode == "RGB" and img.width == exile.W
    assert img.height == exile.HEADER_H + count * exile.ROW_H + exile.FOOTER_H + (0 if count else 50)
