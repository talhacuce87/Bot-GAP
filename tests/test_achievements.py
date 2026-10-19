"""
Başarım testleri: tanımlar ve kademeler, olay işleyici, Diriliş, özel günler, canlı takip
(kapıyı açan / ışıkları kapatan, Firari), geriye dönük işleme, duyurular, !kartdüzen,
yönetici komutları ve kartlar.
"""

from __future__ import annotations

import datetime
import io
import json
import time
from types import SimpleNamespace

import pytest
from PIL import Image

import achievement_cog
import achievements as ach
import activitylog
import database
from achievements import ACHIEVEMENTS, BY_KEY, MemberFacts, aggregate, evaluate, revived, special_day
from badges import SashEntry, draw_patch, render_sash_card
from summary_stats import STREAK_TZ

H = 3600


@pytest.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    monkeypatch.setattr(activitylog, "_buffer", [])
    await database.init_db()
    return database


def _row(uid, event, meta=None, *, ts=None, channel=10, gid=1):
    return {"ts": ts or time.time(), "guild_id": gid, "user_id": uid, "event": event, "channel_id": channel,
            "amount": None, "meta": json.dumps(meta) if meta else None}


def _facts(**kw) -> MemberFacts:
    base = dict(counters={}, awards={}, active_days_365=0, message_days=[], friends_20h=0, joined_at=None,
                premium_since=None, now=datetime.datetime(2026, 10, 19, tzinfo=datetime.timezone.utc))
    base.update(kw)
    return MemberFacts(**base)


# ---------------------------------------------------------------------------
# Tanımlar
# ---------------------------------------------------------------------------

def test_catalog_matches_requests():
    assert len(ACHIEVEMENTS) == 27 and len(BY_KEY) == 27
    assert {"podyum", "zirve", "hizli_yukselis", "kefil"}.isdisjoint(BY_KEY)
    assert BY_KEY["yayinci"].tiers[0] == 100 and BY_KEY["yuzumuz_ortada"].tiers[0] == 5
    assert BY_KEY["kulak_misafiri"].tiers[0] == 50
    assert BY_KEY["kapiyi_acan"].tiers[0] == 40 and BY_KEY["isiklari_kapatan"].tiers[0] == 40
    assert BY_KEY["sunucu_destekcisi"].tiers == (3, 6, 12)
    spammy = {"meme_lordu", "sticker_canavari", "muhabbetin_ortasi", "destan_yazdi", "gezgin", "ikinci_dusunce",
              "kimlik_krizi", "firari", "robotla_dertlesen"}
    assert {a.key for a in ACHIEVEMENTS if a.hidden} == spammy
    for a in ACHIEVEMENTS:
        assert list(a.tiers) == sorted(a.tiers)


def test_icons_exist():
    from badges import ICON_DIR

    missing = [a.key for a in ACHIEVEMENTS if not (ICON_DIR / f"{a.icon}.png").exists()]
    assert missing == []


def test_tiers():
    a = BY_KEY["yayinci"]
    assert [a.tier_for(v) for v in (99.9, 100, 260, 999)] == [0, 1, 2, 3]
    assert a.describe(1) == "Seste 100 saat ekran paylaşımı" and a.describe(3).startswith("Seste 500")
    assert BY_KEY["sadik"].tier_for(1) == 1 and BY_KEY["sadik"].tier_for(0) == 0
    assert ach.tier_label(a, 2) == "Altın" and ach.tier_label(BY_KEY["sadik"], 1) == "Özel"


# ---------------------------------------------------------------------------
# Olay işleyici
# ---------------------------------------------------------------------------

def test_aggregate():
    rows = [
        _row(1, "xp_voice", {"peers": [3, 2], "stream": True, "video": True, "mute": True}),
        _row(1, "xp_voice", {"peers": [2]}),
        _row(1, "message", {"len": 1200, "att": 2, "stk": 3, "reply": True}, channel=11),
        _row(1, "message", {"cmd": True, "att": 1}, channel=12),          # komut sayılmaz
        _row(1, "message_edit"), _row(1, "nick_change"), _row(1, "ai_chat"),
        _row(None, "message"),
    ]
    inc, sets = aggregate(rows, 120)
    week = ach.week_key(rows[0]["ts"])
    assert inc[1, 1, "stream"] == inc[1, 1, "video"] == inc[1, 1, "muted"] == 120
    assert inc[1, 1, f"duo:{week}:2"] == 240 and inc[1, 1, f"duo:{week}:3"] == 120
    assert inc[1, 1, "trio:2-3"] == 120
    assert inc[1, 1, "att"] == 1 and inc[1, 1, "stk"] == 3 and inc[1, 1, "reply"] == 1 and inc[1, 1, "long"] == 1
    assert inc[1, 1, "edit"] == inc[1, 1, "nick"] == inc[1, 1, "ai"] == 1
    assert sets == {(1, 1, "ch:11")}


@pytest.mark.parametrize(
    ("days", "expected"),
    [
        (["2026-01-01", "2026-01-02", "2026-01-03"] + [f"2026-02-{d:02d}" for d in range(1, 15)], True),
        ([f"2026-02-{d:02d}" for d in range(1, 15)], False),                     # hiç bozulmamış
        (["2026-01-01", "2026-01-02"] + [f"2026-02-{d:02d}" for d in range(1, 15)], False),  # bozulan çok kısa
        (["2026-01-01", "2026-01-02", "2026-01-03"] + [f"2026-02-{d:02d}" for d in range(1, 14)], False),
    ],
)
def test_revival(days, expected):
    assert revived(days) is expected


def test_evaluate_never_downgrades_and_skips_manual():
    facts = _facts(counters={"muted": 210 * H, "door": 41}, awards={"week_duo": 5}, friends_20h=5,
                   joined_at=datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc))
    new = evaluate(facts, {"kulak_misafiri": 1})
    assert new["kulak_misafiri"] == 2 and new["kapiyi_acan"] == 1
    assert new["haftanin_ikilisi"] == 2 and new["herkesin_kankasi"] == 1 and new["gap_emektari"] == 2
    assert evaluate(facts, {"kulak_misafiri": 3}).get("kulak_misafiri") is None
    assert "fikir_babasi" not in evaluate(_facts(counters={"x": 1}), {})


def test_duo_needs_30h_in_same_week():
    assert evaluate(_facts(counters={"duo:2026-W40:2": 29 * H}), {}).get("ayrilmaz_ikili") is None
    assert evaluate(_facts(counters={"duo:2026-W40:2": 30 * H}), {})["ayrilmaz_ikili"] == 1


@pytest.mark.parametrize(
    ("when", "expected"),
    [
        (datetime.datetime(2026, 12, 31, 23, 45, tzinfo=STREAK_TZ), "newyear"),
        (datetime.datetime(2027, 1, 1, 0, 20, tzinfo=STREAK_TZ), "newyear"),
        (datetime.datetime(2027, 1, 1, 0, 40, tzinfo=STREAK_TZ), None),
        (datetime.datetime(2026, 12, 31, 22, 0, tzinfo=STREAK_TZ), None),
        (datetime.datetime(2027, 3, 9, 15, 0, tzinfo=STREAK_TZ), "bayram"),
        (datetime.datetime(2027, 3, 10, 15, 0, tzinfo=STREAK_TZ), None),
    ],
)
def test_special_days(when, expected):
    assert special_day(when) == expected


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class _Guild:
    id = 1
    afk_channel = None

    def __init__(self):
        self.members = []
        self.voice_channels = []
        self.sent: list[str] = []
        guild = self

        async def send(content=None, **_):
            guild.sent.append(content)

        self.channel = SimpleNamespace(send=send)

    def get_member(self, uid):
        return next((m for m in self.members if m.id == uid), None)

    def get_channel(self, cid):
        return self.channel


def _member(guild, uid, *, bot=False, days=10):
    now = datetime.datetime.now(datetime.timezone.utc)
    m = SimpleNamespace(id=uid, bot=bot, guild=guild, display_name=f"Üye{uid}", name=f"uye{uid}",
                        joined_at=now - datetime.timedelta(days=days), premium_since=None,
                        display_avatar=SimpleNamespace(replace=lambda **_: SimpleNamespace(read=_avatar)))
    guild.members.append(m)
    return m


async def _avatar():
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), "red").save(buf, "PNG")
    return buf.getvalue()


def _cog(guild):
    async def get_prefix(message):
        return "!"
    return achievement_cog.AchievementCog(SimpleNamespace(guilds=[guild], get_prefix=get_prefix))


async def test_backfill_is_silent_then_new_unlocks_are_announced(db, monkeypatch):
    monkeypatch.setattr(achievement_cog, "ACHIEVEMENT_CHANNEL_ID", 99)
    guild = _Guild()
    _member(guild, 1, days=400)                                           # 1 yıllık: Gap Emektarı
    _member(guild, 2, bot=True)
    await db.insert_activity_rows([(time.time(), 1, 1, "message", 10, None, None, json.dumps({"len": 1500}))])
    cog = _cog(guild)
    await cog.run_once()
    got = (await db.get_achievements(1))[1]
    assert set(got) == {"gap_emektari", "destan_yazdi"} and 2 not in await db.get_achievements(1)
    assert guild.sent == []                                               # geriye dönük: sessiz

    rows = [(time.time(), 1, 1, "message", 10 + i, None, None, None) for i in range(10)]
    await db.insert_activity_rows(rows)
    await cog.run_once()
    assert "gezgin" in (await db.get_achievements(1))[1]
    assert len(guild.sent) == 1 and "Gizli bir başarım" in guild.sent[0] and "Gezgin" in guild.sent[0]
    await cog.run_once()
    assert len(guild.sent) == 1                                           # tekrar duyurulmaz


def _voice(channel):
    return SimpleNamespace(channel=channel)


async def test_door_and_lights(db):
    guild = _Guild()
    a, b, c = (_member(guild, i) for i in (1, 2, 3))
    room = SimpleNamespace(id=50, members=[])
    cog = _cog(guild)
    none = _voice(None)

    async def join(m):
        room.members.append(m)
        await cog.on_voice_state_update(m, none, _voice(room))

    async def leave(m):
        room.members.remove(m)
        await cog.on_voice_state_update(m, _voice(room), none)

    await join(a)              # a boş kanalı açtı
    await join(b)              # b geldi → a kapıyı açtı
    await join(c)              # ikinci kez sayılmaz
    await leave(b)
    await leave(c)
    await leave(a)             # a muhabbetten en son çıktı
    await join(a)              # yalnız girip çıkmak sayılmaz (spam)
    await leave(a)
    counters = await db.get_achievement_counters(1)
    assert counters[1] == {"door": 1, "lights": 1}
    assert 2 not in counters and 3 not in counters


async def test_firari_counts_messages_while_exiled(db):
    guild = _Guild()
    _member(guild, 1)
    cog = _cog(guild)
    msg = lambda text: SimpleNamespace(author=SimpleNamespace(bot=False, id=1), guild=guild, content=text)  # noqa: E731
    await cog.on_message(msg("selam"))
    await db.set_exile(1, 1, ends_at=None, reason="test", moderator_id=9, channel_id=None)
    await cog.on_message(msg("sürgündeyim"))
    await cog.on_message(msg("!xp"))                                      # komut sayılmaz
    assert (await db.get_achievement_counters(1))[1] == {"exile_msg": 1}


async def test_special_day_awards_people_in_voice(db, monkeypatch):
    guild = _Guild()
    a, _ = _member(guild, 1), _member(guild, 2)
    guild.voice_channels = [SimpleNamespace(id=5, members=[a])]
    monkeypatch.setattr(achievement_cog, "now_local", lambda: datetime.datetime(2026, 12, 31, 23, 50, tzinfo=STREAK_TZ))
    await _cog(guild).run_once()
    got = await db.get_achievements(1)
    assert "yilbasi_gecesi" in got[1] and "yilbasi_gecesi" not in got.get(2, {})


async def test_old_duo_weeks_are_pruned(db):
    old = "duo:2025-W01:2"
    await db.add_achievement_counters([(1, 1, old, 5.0), (1, 1, f"duo:{ach.week_key(time.time())}:2", 5.0)])
    guild = _Guild()
    _member(guild, 1)
    await _cog(guild).run_once()
    keys = set((await db.get_achievement_counters(1))[1])
    assert old not in keys and any(k.startswith("duo:") for k in keys)


async def test_grant_and_revoke(db):
    guild = _Guild()
    target = _member(guild, 1)
    target.mention, target.display_name = "<@1>", "Ahmet"
    sent: list[str] = []
    ctx = SimpleNamespace(guild=guild, author=SimpleNamespace(id=9), send=lambda m, **k: _store(sent, m))
    cog = _cog(guild)
    grant = achievement_cog.AchievementCog.grant_command.callback
    tier = lambda key: _tier(db, key)  # noqa: E731

    await grant(cog, ctx, target, name="fikir babasi")                    # Türkçe karakter olmadan
    assert await tier("fikir_babasi") == 1 and "Fikir Babası" in sent[-1]
    await grant(cog, ctx, target, name="Fikir Babası")
    assert "zaten" in sent[-1]

    await grant(cog, ctx, target, name="yayinci")                         # kademe yazılmazsa ilk kademe
    assert await tier("yayinci") == 1
    await grant(cog, ctx, target, name="Yayıncı platin")
    assert await tier("yayinci") == 3 and "Platin" in sent[-1]
    await grant(cog, ctx, target, name="yayıncı 2")                       # yönetici düzeltmesi: düşürebilir
    assert await tier("yayinci") == 2
    await grant(cog, ctx, target, name="Haftanın Gece Kuşu altın")
    assert await tier("haftanin_gece_kusu") == 2
    await grant(cog, ctx, target, name="sadık altın")                     # tek kademelide kademe yok sayılır
    assert await tier("sadik") == 1

    await grant(cog, ctx, target, name="olmayan başarım")
    assert "bulamadım" in sent[-1] and "Yayıncı" in sent[-1]
    await achievement_cog.AchievementCog.revoke_command.callback(cog, ctx, target, name="FİKİR BABASI")
    assert await tier("fikir_babasi") == 0 and "alındı" in sent[-1]


async def _store(store, msg):
    store.append(msg)


async def _tier(db, key):
    return (await db.get_achievements(1)).get(1, {}).get(key, (0, 0))[0]


@pytest.mark.parametrize(
    ("text", "key"),
    [("fikir babasi", "fikir_babasi"), ("FİKİR BABASI", "fikir_babasi"), ("ikinci dusunce", "ikinci_dusunce"),
     ("yüzümüz", "yuzumuz_ortada"), ("gece kusu", "haftanin_gece_kusu"), ("kapiyi_acan", "kapiyi_acan"),
     ("haftanın", None), ("", None), ("xyz", None)],
)
def test_find(text, key):
    found = ach.find(text)
    assert (found.key if found else None) == key


def test_parse_tier():
    assert [ach.parse_tier(x) for x in ("gümüş", "ALTIN", "altin", "3", "4", "x")] == [1, 2, 2, 3, None, None]


async def test_guide_shows_visible_achievements_and_status(db):
    guild = _Guild()
    _member(guild, 1)
    await db.set_achievement(1, 1, "yayinci", 2)
    await db.set_achievement(1, 1, "meme_lordu", 1)
    sent: list = []

    async def send(content=None, embed=None, **_):
        sent.append(embed)

    ctx = SimpleNamespace(guild=guild, author=SimpleNamespace(id=1), send=send)
    await achievement_cog.AchievementCog.guide_command.callback(_cog(guild), ctx)
    embed = sent[0]
    text = "\n".join(f"{f.name}\n{f.value}" for f in embed.fields)
    assert "Yayıncı** · ✅ Altın" in text and "100 / 250 / 500 saat" in text
    assert "Kapıyı Açan** · ▫️" in text and "(yönetici verir)" in text
    assert "Meme Lordu" not in text and "Sticker" not in text                  # gizliler ele verilmez
    assert "**9** gizli başarım var, **1** tanesini buldun" in text
    assert all(len(f.value) <= 1024 for f in embed.fields) and len(embed) <= 6000


async def test_badge_picker_limits_and_saves(db):
    guild = _Guild()
    member = _member(guild, 1)
    earned = {"yayinci": (2, 0.0), "gezgin": (1, 0.0), "sadik": (1, 0.0), "dirilis": (1, 0.0)}
    view = achievement_cog.BadgePicker(member, earned, ["gezgin"])
    assert view.select.max_values == 3 and len(view.select.options) == 4
    assert view.select.options[0].value == "yayinci"                      # yüksek kademe önce
    assert [o.value for o in view.select.options if o.default] == ["gezgin"]
    view.select._values = ["yayinci", "sadik"]  # kullanıcı seçimi
    edits: list[str] = []

    async def edit_message(content=None, view=None):
        edits.append(content)

    interaction = SimpleNamespace(response=SimpleNamespace(edit_message=edit_message), user=SimpleNamespace(id=1))
    await view._picked(interaction)
    assert await db.get_card_badges(1, 1) == ["yayinci", "sadik"] and "Yayıncı" in edits[0]


# ---------------------------------------------------------------------------
# Kartlar
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("state", ["earned", "locked", "hidden"])
def test_patch_renders(state):
    img = draw_patch(BY_KEY["yayinci"], 3, 100, state=state)
    assert img.size == (104, 104) and img.mode == "RGBA"


def test_sash_card_renders():
    entries = [SashEntry(a, 1 if i % 3 == 0 else 0, not a.hidden) for i, a in enumerate(ACHIEVEMENTS)]
    card = render_sash_card("Çok uzun bir isim 🔥", None, entries, [])
    assert card.size == (1400, 1040)


async def test_sash_card_from_cog(db):
    guild = _Guild()
    member = _member(guild, 1, days=800)
    cog = _cog(guild)
    await cog.run_once()
    img = Image.open(await cog.build_sash(member))
    assert img.size == (1400, 1040)
