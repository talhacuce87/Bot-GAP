"""Gölde balık tutma: nadirlik zarı, şans serisi, günde bir sınır ve 2x boost."""

from __future__ import annotations

import datetime
import time

import pytest

import activitylog
import database
import fishing


@pytest.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    monkeypatch.setattr(activitylog, "_buffer", [])
    await database.init_db()
    return database


def test_roll_uses_cumulative_chances_rarest_first():
    assert fishing.roll(0, 0.0).key == "legendary"
    assert fishing.roll(0, 0.00499).key == "legendary"
    assert fishing.roll(0, 0.005).key == "epic"
    assert fishing.roll(0, 0.025).key == "rare"
    assert fishing.roll(0, 0.10).key == "uncommon"
    assert fishing.roll(0, 0.30).key == "common"
    assert fishing.roll(0, 0.99999).key == "common"
    assert sum(fishing.chances(0).values()) == pytest.approx(100)


def test_luck_grows_per_day_and_caps_at_five_percent():
    assert fishing.chances(10)["legendary"] == pytest.approx(1.5)
    assert fishing.chances(45)["legendary"] == pytest.approx(5.0)
    assert fishing.chances(400)["legendary"] == pytest.approx(5.0)
    assert fishing.chances(400)["common"] == pytest.approx(65.5)
    assert sum(fishing.chances(400).values()) == pytest.approx(100)
    assert fishing.roll(45, 0.0499).key == "legendary"


async def test_once_per_day_streak_and_stacking_boost(db, monkeypatch):
    day = [datetime.date(2026, 10, 19)]
    monkeypatch.setattr(database, "_today", lambda: day[0])

    first = await fishing.catch(1, 5, rand=lambda: 0.5)  # yaygın: 1 saat
    assert first["rarity"] == "common" and first["streak"] == 1 and first["luck"] == 0
    assert await fishing.catch(1, 5, rand=lambda: 0.0) is None  # aynı gün ikinci kez yok

    day[0] += datetime.timedelta(days=1)
    second = await fishing.catch(1, 5, rand=lambda: 0.0)  # efsanevi: 24 saat, üstüne eklenir
    assert second["rarity"] == "legendary" and second["streak"] == 2 and second["luck"] == 0.1
    assert second["boost_until"] == pytest.approx(time.time() + 25 * 3600, abs=5)
    assert await db.get_active_multiplier(1, 5) == 2.0

    day[0] += datetime.timedelta(days=2)  # bir gün atlandı: seri sıfırlanır
    assert (await fishing.catch(1, 5, rand=lambda: 0.5))["streak"] == 1


async def test_fish_boost_never_lowers_a_bigger_admin_boost(db, monkeypatch):
    await fishing.catch(1, 6, rand=lambda: 0.5)
    await db.set_boost(1, 6, 3.0, 600)
    row = await db.get_user_row(1, 6)
    mult, until = db.active_boost(row)
    assert mult == 3.0 and until == pytest.approx(time.time() + 600, abs=5)

    await db.set_boost(1, 6, 1.5, 600)  # küçük yönetici boost'u: balığın 2x'i geçerli
    assert await db.get_active_multiplier(1, 6) == 2.0


async def test_active_boost_reports_its_source(db):
    assert await db.get_active_boost(1, 7) == (1.0, None)
    await fishing.catch(1, 7, rand=lambda: 0.5)
    assert await db.get_active_boost(1, 7) == (2.0, "fish")
    await db.set_boost(1, 7, 3.0, 600)  # büyük yönetici boost'u geçerli olur
    assert await db.get_active_boost(1, 7) == (3.0, "admin")
