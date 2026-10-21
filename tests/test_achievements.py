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
from achievements import ACHIEVEMENTS, BY_KEY, MemberFacts, aggregate, evaluate, revived, special_days
from badges import SashEntry, draw_patch, render_sash_card, sash_size
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
    assert len(ACHIEVEMENTS) == 54 and len(BY_KEY) == 54
    assert {"podyum", "zirve", "hizli_yukselis", "kefil", "kurucu_kadro", "kanal_hoplayan", "sohbet_baslatan",
            "can_dostu"}.isdisjoint(BY_KEY)
    assert BY_KEY["ses_kurdu"].tiers == (250, 1000, 2000) and BY_KEY["maraton"].tiers == (12, 17, 24)
    assert BY_KEY["gece_nobeti"].tiers == (25, 50, 150) and BY_KEY["kalabalik_sever"].tiers == (10, 50, 150)
    assert BY_KEY["sosyal_kelebek"].tiers == (15, 20, 30) and BY_KEY["koleksiyoncu"].tiers == (10, 20, 30)
    assert BY_KEY["platin_avcisi"].tiers == (3, 7, 10) and BY_KEY["ataturkun_evlatlari"].name == "Atatürk'ün Evlatları"
    assert len({a.icon for a in ACHIEVEMENTS}) == 54                       # her rozetin kendi simgesi
    assert BY_KEY["yayinci"].tiers[0] == 100 and BY_KEY["yuzumuz_ortada"].tiers[0] == 5
    assert BY_KEY["kulak_misafiri"].tiers[0] == 50
    assert BY_KEY["kapiyi_acan"].tiers[0] == 40 and BY_KEY["isiklari_kapatan"].tiers[0] == 40
    assert BY_KEY["sunucu_destekcisi"].tiers == (3, 6, 12)
    spammy = {"meme_lordu", "sticker_canavari", "muhabbetin_ortasi", "destan_yazdi", "gezgin", "ikinci_dusunce",
              "kimlik_krizi", "firari", "robotla_dertlesen", "pismanlik", "sabikali", "islah_oldum", "hayalet"}
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
    agg = aggregate(rows, 120)
    inc, sets = agg.inc, {k for k, v in agg.assign.items() if k[2].startswith("ch:")}
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
    assert special_days(when) == ([expected] if expected else [])


def test_republic_day_and_gap_birthday():
    day = datetime.datetime(2026, 10, 29, 20, 0, tzinfo=STREAK_TZ)
    assert special_days(day) == ["republic"]
    assert special_days(day, founded=datetime.date(2019, 10, 29)) == ["republic", "gapbday"]
    assert special_days(day, founded=datetime.date(2026, 10, 29)) == ["republic"]     # kuruluş günü yıldönümü değil


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
    assert "**13** gizli başarım var, **1** tanesini buldun" in text
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
    assert card.size == sash_size(len(ACHIEVEMENTS)) and card.size[0] == 1400
    assert sash_size(60)[1] > sash_size(47)[1]                              # rozet arttıkça kart uzar


async def test_sash_card_from_cog(db):
    guild = _Guild()
    member = _member(guild, 1, days=800)
    cog = _cog(guild)
    await cog.run_once()
    img = Image.open(await cog.build_sash(member))
    assert img.size == sash_size(len(ACHIEVEMENTS))



# ---------------------------------------------------------------------------
# Yeni başarımlar
# ---------------------------------------------------------------------------

def _ts(day: int, hour: int, minute: int = 0) -> float:
    return datetime.datetime(2026, 10, day, hour, minute, tzinfo=STREAK_TZ).timestamp()


def test_aggregate_new_counters():
    crowd = list(range(2, 11))                                              # kendisiyle 10 kişi
    rows = [
        _row(1, "xp_voice", {"peers": [2]}, ts=_ts(5, 3, 30)),             # 03:30 gece nöbeti
        _row(1, "xp_voice", {"peers": crowd}, ts=_ts(5, 21)),
        _row(1, "xp_voice", {"peers": crowd}, ts=_ts(5, 22)),               # aynı gün ikinci kez sayılmaz
        _row(1, "xp_voice", {"peers": crowd[:8]}, ts=_ts(6, 21)),           # 9 kişilik: sayılmaz
        _row(1, "xp_message"), _row(1, "xp_message"),
        _row(1, "message", {"len": 5}, ts=_ts(5, 7, 59)),                   # 08:00 öncesi: günaydın sayılmaz
        _row(2, "message", {"len": 5}, ts=_ts(5, 8, 5)),                    # günün ilk 08:00 sonrası mesajı
        _row(1, "message", {"len": 5}, ts=_ts(5, 9, 0)),
        _row(1, "message_delete"), _row(1, "message_delete"),
        _row(1, "voice_leave", {"seconds": 13 * H}), _row(1, "voice_leave", {"seconds": 2 * H}),
    ]
    agg = aggregate(rows, 120)
    assert agg.inc[1, 1, "night_voice"] == 120
    assert {k[2] for k in agg.assign if k[2].startswith("crowd:")} == {"crowd:2026-10-05"}
    assert agg.inc[1, 1, "xpmsg"] == 2 and agg.inc[1, 1, "deleted"] == 2
    assert agg.inc[1, 1, "morning"] == 1 and agg.inc[1, 2, "morning"] == 1
    assert agg.first_messages[1, "2026-10-05"][1] == 2
    assert agg.maxes[1, 1, "max_session"] == 13 * H


def test_newcomer_voice_counts_only_first_30_days():
    joined = {(1, 2): _ts(1, 12), (1, 3): _ts(1, 12) - 40 * 86400}
    rows = [_row(1, "xp_voice", {"peers": [2, 3]}, ts=_ts(10, 20))]
    agg = aggregate(rows, 120, joined)
    assert agg.inc[1, 1, "new:2"] == 120 and (1, 1, "new:3") not in agg.inc


def test_reform_needs_10_hour_exile_and_30_clean_days():
    start = _ts(1, 10)
    short = aggregate([_row(1, "admin_exile", {"yeni": True}, ts=start),
                       _row(1, "admin_exile_end", ts=start + 9 * H)], 120)
    assert short.assign[1, 1, "reform_from"] == 0                           # 10 saatten kısa: sayılmaz
    long = aggregate([_row(1, "exile_expired", ts=start + 11 * H)], 120, exile_starts={(1, 1): start})
    assert long.assign[1, 1, "reform_from"] == start + 11 * H               # önceki turdan kalan başlangıç
    update = aggregate([_row(1, "admin_exile", {"yeni": False}, ts=start)], 120)
    assert (1, 1, "exiled") not in update.inc                               # süre güncellemesi yeni sürgün değil

    end = start + 11 * H
    now = datetime.datetime.fromtimestamp(end + 31 * 86400, datetime.timezone.utc)
    assert evaluate(_facts(counters={"reform_from": end, "exiled": 1}, now=now), {})["islah_oldum"] == 1
    early = datetime.datetime.fromtimestamp(end + 10 * 86400, datetime.timezone.utc)
    assert "islah_oldum" not in evaluate(_facts(counters={"reform_from": end}, now=early), {})


def test_streak_level_voice_ghost_and_social():
    days = [f"2026-08-{d:02d}" for d in range(1, 9)] + ["2026-10-01"]        # 8 gün seri, sonra 50+ gün yok
    new = evaluate(_facts(message_days=days, active_days=days, voice_seconds=260 * H, level=10,
                          friends_5h=16, counters={"max_session": 17 * H, "night_voice": 26 * H, "gm": 10,
                                                   "xpmsg": 1000, "morning": 100, "new:5": 5 * H,
                                                   **{f"crowd:2026-09-{d:02d}": 1 for d in range(1, 11)}}), {})
    assert new["atesli_seri"] == 1 and new["yukselen_yildiz"] == 2 and new["ses_kurdu"] == 1
    assert new["hayalet"] == 1 and new["sosyal_kelebek"] == 1 and new["maraton"] == 2
    assert new["gece_nobeti"] == 1 and new["gunaydin"] == 1 and new["klavye_ustasi"] == 1
    assert new["sabahci"] == 1 and new["hos_geldin_komitesi"] == 1 and new["kalabalik_sever"] == 1
    assert evaluate(_facts(current_streak=31), {})["atesli_seri"] == 2


def test_collection_achievements_count_other_badges():
    earned = {k: BY_KEY[k].max_tier for k in ("yayinci", "kulak_misafiri", "gap_emektari")}
    earned.update({k: 1 for k in ("sadik", "dirilis", "gezgin", "destan_yazdi", "sabikali", "hayalet")})
    new = evaluate(_facts(counters={"door": 40}), earned)                  # +Kapıyı Açan = 10 başarım
    assert new["kapiyi_acan"] == 1 and new["koleksiyoncu"] == 1 and new["platin_avcisi"] == 1
    assert "koleksiyoncu" not in evaluate(_facts(), {k: 1 for k in list(earned)[:5]})


async def test_first_message_of_day_is_claimed_once(db):
    guild = _Guild()
    _member(guild, 1)
    _member(guild, 2)
    await db.insert_activity_rows([
        (_ts(5, 8, 1), 1, 2, "message", 10, None, None, None),
        (_ts(5, 9), 1, 1, "message", 10, None, None, None),
    ])
    cog = _cog(guild)
    await cog.run_once()
    await db.insert_activity_rows([(_ts(5, 8, 0), 1, 1, "message", 10, None, None, None)])   # geç işlenen ama erken mesaj
    await cog.run_once()
    counters = await db.get_achievement_counters(1)
    assert counters[2]["gm"] == 1 and "gm" not in counters.get(1, {})       # o gün zaten kapıldı


async def test_weekly_mvp_award_counts(db):
    from summary_stats import PeriodStats, period_awards

    stats = PeriodStats()
    stats.xp.update({5: 100, 6: 300})
    assert period_awards(stats, "week")["week_mvp"] == [6]
    await db.add_summary_awards(1, "week:2026-W43", {"week_mvp": [6]})
    assert (await db.count_summary_awards(1))[6]["week_mvp"] == 1



async def test_facts_use_xp_streak_and_voice_from_user_rows(db):
    """Gerçek kullanıcı satırlarından seviye, toplam ses ve seri okunur (Yükselen Yıldız, Ses Kurdu, Ateşli Seri)."""
    guild = _Guild()
    _member(guild, 1)
    await db.add_text_xp(1, 1, 1500)
    await db.add_voice_xp(1, 1, 1000)                                       # toplam 2.500 XP → seviye 6
    async with database._db() as conn:
        today = database._today().isoformat()
        await conn.execute("UPDATE user_xp SET voice_seconds = ?, streak_days = 8, last_message_date = ? "
                           "WHERE user_id = 1", (300 * H, today))
        await conn.commit()
    cog = _cog(guild)
    facts = (await cog._facts(guild))[1]
    assert facts.level == 6 and facts.voice_seconds == 300 * H and facts.current_streak == 8
    await cog.run_once()
    got = (await db.get_achievements(1))[1]
    assert got["yukselen_yildiz"][0] == 1 and got["ses_kurdu"][0] == 1 and got["atesli_seri"][0] == 1


def test_world_events_feed_world_achievements():
    goal = {**_row(1, "world", {"kind": "goal"}), "amount": 3}
    rows = [_row(1, "fish_catch", {"rarity": "legendary"}), _row(1, "fish_catch", {"rarity": "common"}), goal,
            _row(1, "world", {"kind": "bilinmeyen"})]
    out = ach.aggregate(rows, 60)
    assert out.inc[1, 1, "fish"] == 2 and out.inc[1, 1, "fish_legend"] == 1
    assert out.inc[1, 1, "w_goal"] == 3 and (1, 1, "w_bilinmeyen") not in out.inc
    facts = _facts(counters={"fish": 10, "fish_legend": 1, "w_goal": 5})
    earned = ach.evaluate(facts, {})
    assert earned["balikci"] == 1 and earned["altin_sazan"] == 1 and earned["golcu"] == 1
