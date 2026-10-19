"""
Haftalık özet ve aylık Wrapped testleri: dönemler, istatistikler, kullanım kısıtları
(yalnızca pazar / ayın son günü, dönemde bir kez), otomatik paylaşım ve kartlar.
"""

from __future__ import annotations

import datetime
import io
import json
from types import SimpleNamespace

import pytest
from PIL import Image

import activitylog
import database
import summary
from summary_stats import (
    STREAK_TZ, compute, is_month_end, is_week_end, month_period, persona, top, week_period,
)

TZ = STREAK_TZ
SUNDAY = datetime.datetime(2026, 10, 25, 21, 30, tzinfo=TZ)
MONDAY = datetime.datetime(2026, 10, 26, 12, 0, tzinfo=TZ)
MONTH_END = datetime.datetime(2026, 10, 31, 22, 0, tzinfo=TZ)


def _row(ts, uid, event, amount=None, **meta):
    return {"ts": ts, "user_id": uid, "event": event, "amount": amount, "meta": json.dumps(meta) if meta else None}


# ---------------------------------------------------------------------------
# Dönemler
# ---------------------------------------------------------------------------

def test_periods_and_keys():
    week = week_period(SUNDAY)
    assert week.start == datetime.datetime(2026, 10, 19, tzinfo=TZ) and week.end == SUNDAY
    assert week.key == "2026-W43" and week.label == "19–25 Ekim"
    month = month_period(MONTH_END)
    assert month.start == datetime.datetime(2026, 10, 1, tzinfo=TZ)
    assert month.key == "2026-10" and month.label == "Ekim 2026"
    cross = week_period(datetime.datetime(2026, 11, 1, 20, 0, tzinfo=TZ))
    assert cross.label == "26 Ekim – 1 Kasım"


@pytest.mark.parametrize(
    ("day", "week_end", "month_end"),
    [
        (datetime.date(2026, 10, 25), True, False),
        (datetime.date(2026, 10, 26), False, False),
        (datetime.date(2026, 10, 31), False, True),
        (datetime.date(2027, 2, 28), True, True),
        (datetime.date(2028, 2, 28), False, False),   # artık yıl
        (datetime.date(2028, 2, 29), False, True),
    ],
)
def test_day_rules(day, week_end, month_end):
    assert is_week_end(day) is week_end and is_month_end(day) is month_end


# ---------------------------------------------------------------------------
# İstatistik
# ---------------------------------------------------------------------------

def test_compute_counts_xp_messages_voice_pairs_and_levels():
    night = datetime.datetime(2026, 10, 21, 2, 30, tzinfo=TZ).timestamp()
    day = datetime.datetime(2026, 10, 21, 15, 0, tzinfo=TZ).timestamp()
    rows = [
        _row(day, 1, "xp_message", 5), _row(day, 1, "message", len=10),
        _row(day, 1, "message", cmd=True),                                  # komut sayılmaz
        _row(night, 2, "message"), _row(night, 2, "xp_message", 4),
        _row(day, 1, "xp_voice", 1, peers=[2, 3]), _row(day, 2, "xp_voice", 1, peers=[1]),
        _row(day, 3, "xp_voice", 1, peers=[1]),
        _row(day, 1, "xp_streak_bonus", 50), _row(day, 2, "level_up"),
        _row(day, 99, "message"),                                           # bot
        _row(day, None, "message"),
    ]
    stats = compute(rows, 120, bots={99})
    assert stats.xp == {1: 56, 2: 5, 3: 1}
    assert stats.messages == {1: 1, 2: 1}
    assert stats.night_messages == {2: 1}
    assert stats.voice_seconds == {1: 120, 2: 120, 3: 120}
    assert stats.pairs == {(1, 2): 120, (1, 3): 120}                         # her ikili bir kez
    assert stats.partners(1) == {2: 120, 3: 120} and stats.partners(3) == {1: 120}
    assert stats.level_ups == {2: 1}
    assert stats.rank(1) == 1 and stats.rank(3) == 3 and stats.rank(42) is None
    assert stats.hours[1][15] == 1 and stats.weekdays[2][2] == 1
    assert stats.active_members == {1, 2, 3}


def test_top_is_stable_on_ties():
    from collections import Counter

    assert top(Counter({5: 3, 2: 3, 9: 1}), 2) == [(2, 3), (5, 3)]
    assert top(Counter({1: 0})) == []


def test_persona():
    def stats_for(messages=0, night=0, voice_min=0, partners=0):
        rows = []
        t = datetime.datetime(2026, 10, 21, 2 if night else 15, tzinfo=TZ).timestamp()
        rows += [_row(t, 1, "message") for _ in range(messages)]
        rows += [_row(t, 1, "xp_voice", 1, peers=[100 + (i % max(partners, 1))]) for i in range(voice_min // 2)]
        return compute(rows, 120)

    assert persona(stats_for(messages=40, night=1), 1)[0] == "Gece Kuşu"
    assert persona(stats_for(voice_min=40, partners=6), 1)[0] == "Sosyal Kelebek"
    assert persona(stats_for(voice_min=800, partners=1), 1)[0] == "Ses Bağımlısı"
    assert persona(stats_for(messages=300), 1)[0] == "Klavye Delikanlısı"
    assert persona(stats_for(messages=3), 1)[0] == "Sessiz Gölge"


# ---------------------------------------------------------------------------
# Komutlar: yalnızca pazar / ayın son günü, dönemde bir kez
# ---------------------------------------------------------------------------

class _Ctx:
    def __init__(self, uid=7):
        self.author = SimpleNamespace(id=uid)
        self.guild = SimpleNamespace(id=1)
        self.sent: list = []

    async def send(self, content=None, file=None, **_):
        self.sent.append(file or content)

    def typing(self):
        class _T:
            async def __aenter__(self_):
                return None

            async def __aexit__(self_, *a):
                return None
        return _T()


@pytest.fixture
def cog(tmp_path, monkeypatch):
    c = summary.SummaryCog(SimpleNamespace(), state_path=tmp_path / "summary_state.json")
    calls: list = []

    async def fake_card(member, period):
        calls.append((member.id, period.kind))
        return io.BytesIO(b"png")

    monkeypatch.setattr(c, "build_personal_card", fake_card)
    c.calls = calls
    return c


def _at(monkeypatch, when):
    monkeypatch.setattr(summary, "now_local", lambda: when)


async def test_weekly_only_on_sunday_and_once(cog, monkeypatch):
    _at(monkeypatch, MONDAY)
    ctx = _Ctx()
    await cog._personal(ctx, "week")
    assert "pazar" in ctx.sent[-1] and not cog.calls

    _at(monkeypatch, SUNDAY)
    await cog._personal(ctx, "week")
    assert cog.calls == [(7, "week")] and isinstance(ctx.sent[-1], summary.discord.File)
    await cog._personal(ctx, "week")
    assert "zaten aldın" in ctx.sent[-1] and len(cog.calls) == 1        # spam yok

    other = _Ctx(uid=8)
    await cog._personal(other, "week")
    assert len(cog.calls) == 2                                          # başkası alabilir


async def test_wrapped_only_on_month_end(cog, monkeypatch):
    _at(monkeypatch, SUNDAY)
    ctx = _Ctx()
    await cog._personal(ctx, "month")
    assert "ayın son günü" in ctx.sent[-1] and not cog.calls
    _at(monkeypatch, MONTH_END)
    await cog._personal(ctx, "month")
    assert cog.calls == [(7, "month")]


async def test_usage_survives_restart(cog, tmp_path, monkeypatch):
    _at(monkeypatch, SUNDAY)
    await cog._personal(_Ctx(), "week")
    again = summary.SummaryCog(SimpleNamespace(), state_path=tmp_path / "summary_state.json")
    assert again.state.has_used(f"{week_period(SUNDAY).key}:1", 7)


async def test_inactive_member_gets_message_and_can_retry(cog, monkeypatch):
    _at(monkeypatch, SUNDAY)

    async def nothing(member, period):
        return None

    monkeypatch.setattr(cog, "build_personal_card", nothing)
    ctx = _Ctx()
    await cog._personal(ctx, "week")
    assert "ortalarda yoktun" in ctx.sent[-1]
    assert not cog.state.has_used(f"{week_period(SUNDAY).key}:1", 7)


# ---------------------------------------------------------------------------
# Otomatik paylaşım
# ---------------------------------------------------------------------------

async def test_auto_post_once_per_period(tmp_path, monkeypatch):
    sent: list = []

    async def send(content=None, file=None):
        sent.append(content)

    channel = SimpleNamespace(guild=SimpleNamespace(id=1), send=send)
    c = summary.SummaryCog(SimpleNamespace(get_channel=lambda cid: channel), state_path=tmp_path / "s.json")
    monkeypatch.setattr(summary, "SUMMARY_CHANNEL_ID", 555)

    async def fake_server_card(guild, period):
        return io.BytesIO(b"png")

    monkeypatch.setattr(c, "build_server_card", fake_server_card)

    assert await c.post_due(SUNDAY.replace(hour=20)) == []               # saat 21'den önce değil
    assert await c.post_due(MONDAY.replace(hour=22)) == []               # pazartesi değil
    assert await c.post_due(SUNDAY) == ["week"]
    assert await c.post_due(SUNDAY.replace(hour=23)) == []               # aynı hafta ikinci kez yok
    assert await c.post_due(MONTH_END) == ["month"]
    both = datetime.datetime(2027, 2, 28, 21, 5, tzinfo=TZ)               # hem pazar hem ay sonu
    assert await c.post_due(both) == ["week", "month"]
    assert "Haftanın özeti" in sent[0] and "!haftalik" in sent[0] and "Wrapped" in sent[1]


async def test_no_channel_no_post(tmp_path, monkeypatch):
    c = summary.SummaryCog(SimpleNamespace(get_channel=lambda cid: None), state_path=tmp_path / "s.json")
    monkeypatch.setattr(summary, "SUMMARY_CHANNEL_ID", 0)
    monkeypatch.setattr(summary, "ANNOUNCE_CHANNEL_ID", 0)
    assert await c.post_due(SUNDAY) == []


# ---------------------------------------------------------------------------
# Kartlar (gerçek veritabanıyla)
# ---------------------------------------------------------------------------

class _Asset:
    def __init__(self, color):
        self.color = color

    def replace(self, **_):
        return self

    async def read(self):
        buf = io.BytesIO()
        Image.new("RGB", (64, 64), self.color).save(buf, "PNG")
        return buf.getvalue()


class _Guild:
    id = 1
    name = "The Gap 🔥"

    def __init__(self):
        self.members = []

    def get_member(self, uid):
        return next((m for m in self.members if m.id == uid), None)


def _member(guild, uid, name, color="red", bot=False):
    m = SimpleNamespace(id=uid, display_name=name, name=name.lower(), bot=bot, guild=guild, display_avatar=_Asset(color))
    guild.members.append(m)
    return m


@pytest.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    monkeypatch.setattr(activitylog, "_buffer", [])
    await database.init_db()
    return database


async def test_cards_render_from_real_events(db, tmp_path):
    guild = _Guild()
    talha, baris = _member(guild, 1, "Talha"), _member(guild, 2, "Barış", "blue")
    _member(guild, 3, "Sessiz")
    t = datetime.datetime(2026, 10, 22, 23, 0, tzinfo=TZ).timestamp()
    rows = []
    for _ in range(30):
        rows.append((t, 1, 1, "message", 9, None, None, None))
        rows.append((t, 1, 1, "xp_message", 9, 6, None, None))
    for _ in range(20):
        rows.append((t, 1, 1, "xp_voice", 9, 1, None, json.dumps({"peers": [2]})))
        rows.append((t, 1, 2, "xp_voice", 9, 1, None, json.dumps({"peers": [1]})))
    rows.append((t - 10**7, 1, 1, "message", 9, None, None, None))                 # dönem dışı
    await db.insert_activity_rows(rows)
    await db.add_text_xp(1, 1, 500)

    c = summary.SummaryCog(SimpleNamespace(), state_path=tmp_path / "s.json")
    period = week_period(SUNDAY)
    server = Image.open(await c.build_server_card(guild, period))
    assert server.width == summary.W and server.mode == "RGB"
    personal = Image.open(await c.build_personal_card(talha, period))
    assert personal.width == summary.W
    assert await c.build_personal_card(guild.get_member(3), period) is None         # hareketsiz üye
    stats = await c._stats(guild, period)
    assert stats.messages[1] == 30 and stats.pairs[(1, 2)] == 20 * summary.VOICE_INTERVAL_SECONDS
    assert baris.id in stats.partners(1)


def test_commands_registered():
    names = {c.name: c for c in summary.SummaryCog.__cog_commands__}
    assert {"haftalık", "weekly"} <= set(names["haftalik"].aliases)
    assert {"aylik", "aylık"} <= set(names["wrapped"].aliases)
