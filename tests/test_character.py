"""Chibi karakter: paket, çizici, kıyafet doğrulaması, !karakter ve dünyanın kıyafet uçları."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import activitylog
import chibi_render
import database
import outfit
import world_cog

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DATABASE_PATH", tmp_path / "xp_system.db")
    monkeypatch.setattr(activitylog, "_buffer", [])
    await database.init_db()
    return database


def test_bot_and_world_ship_the_same_pack():
    for name in ("chibi.json", "chibi.bin"):
        a = (ROOT / "assets" / "chibi" / name).read_bytes()
        b = (ROOT / "web" / "client" / "chibi" / name).read_bytes()
        assert hashlib.sha256(a).digest() == hashlib.sha256(b).digest(), f"{name}: bake-chibi.mjs'yi yeniden çalıştır"


def test_pack_has_every_slot_and_small_parts():
    m = outfit.manifest()
    for slot in outfit.SLOTS:
        assert outfit.parts_in(slot), slot
    for pid, p in m["parts"].items():
        assert p["vCount"] <= 65535 and p["iCount"] % 3 == 0, pid
    assert (ROOT / "assets" / "chibi" / "chibi.bin").stat().st_size < 8 * 1024 * 1024


def test_compose_full_top_hides_bottoms_and_empty_slots_use_base_outfit():
    ids = lambda o: [p.id for p in chibi_render.compose(o)]  # noqa: E731
    assert ids({}) == ["base", "base_top", "base_bottom"]
    dress = ids({"tops": "top_gelinlik", "bottoms": "bottom_kot"})
    assert "top_gelinlik" in dress and "bottom_kot" not in dress and "base_bottom" not in dress
    # Yanlış slottaki parça yok sayılır
    assert "hat_fes" not in ids({"hair": "hat_fes"})


def test_render_draws_a_character_and_recolors():
    look = {"hair": "hair_kisa_doku", "tops": "top_tisort", "bottoms": "bottom_kot", "shoes": "shoes_sneaker"}
    img = chibi_render.render(look, size=128)
    assert img.size == (128, 128)
    alpha = img.getchannel("A")
    assert alpha.getbbox() is not None and sum(alpha.histogram()[1:]) > 128 * 128 * 0.15
    pink = chibi_render.render({**look, "colors": {"hair": "#ff00aa"}}, size=128)
    assert pink.tobytes() != img.tobytes()


def test_validate_keeps_known_parts_drops_unknown_and_locked():
    clean, dropped = outfit.validate(
        {"hair": "hair_rasta", "tops": "top_xp_hoodie", "bottoms": "yok_böyle", "hats": None,
         "colors": {"skin": "#8D5A3C", "hair": "red", "eye": "#12345"}},
        level=3,
    )
    assert clean["hair"] == "hair_rasta" and clean["hats"] is None
    assert clean["tops"] == outfit.DEFAULT_OUTFIT["tops"]  # XP Hoodie seviye 10
    assert clean["bottoms"] == outfit.DEFAULT_OUTFIT["bottoms"]
    assert clean["colors"] == {"skin": "#8d5a3c"}
    assert len(dropped) == 2
    assert outfit.validate({"tops": "top_xp_hoodie"}, level=10)[0]["tops"] == "top_xp_hoodie"


async def test_outfit_saved_and_relocked_when_level_drops(db):
    clean, _ = await outfit.save(1, 5, {"tops": "top_levelup", "hair": "hair_kirpi"}, level=5)
    assert (await outfit.load(1, 5, level=5))["tops"] == "top_levelup"
    assert (await outfit.load(1, 5, level=1))["tops"] == outfit.DEFAULT_OUTFIT["tops"]
    assert (await outfit.load(1, 6, level=1)) == outfit.validate(None, 1)[0]
    assert (await db.get_outfits(1, [5, 6])).keys() == {5}


async def test_world_outfit_endpoints(db, monkeypatch):
    monkeypatch.setenv("WORLD_SHARED_SECRET", "s3cret")
    guild = SimpleNamespace(get_member=lambda uid: object() if uid != 9 else None)
    cog = world_cog.WorldCog(SimpleNamespace(get_guild=lambda gid: guild))

    async def call(handler, body, secret="s3cret"):
        async def _json():
            return body
        r = await handler(SimpleNamespace(headers={"x-world-secret": secret}, json=_json))
        return r.status, json.loads(r.text)

    assert (await call(cog.handle_save_outfit, {"guild": 1, "user": 5, "outfit": {}}, secret="x"))[0] == 404
    assert (await call(cog.handle_save_outfit, {"guild": 1, "user": 9, "outfit": {}}))[1]["reason"] == "not_member"

    status, saved = await call(cog.handle_save_outfit, {"guild": 1, "user": 5, "outfit": {"hair": "hair_rasta", "tops": "top_xp_hoodie"}})
    assert status == 200 and saved["ok"] and saved["outfit"]["hair"] == "hair_rasta"
    assert saved["outfit"]["tops"] == outfit.DEFAULT_OUTFIT["tops"] and saved["dropped"]
    assert any(r[3] == "outfit_change" for r in activitylog._buffer)

    _, room = await call(cog.handle_outfits, {"guild": 1, "users": [5, 6]})
    assert room["outfits"]["5"]["hair"] == "hair_rasta"
    assert room["outfits"]["6"]["hair"] == outfit.DEFAULT_OUTFIT["hair"]

    _, wardrobe = await call(cog.handle_wardrobe, {"guild": 1, "user": 5})
    assert wardrobe["level"] == 1 and wardrobe["locked"]["top_xp_hoodie"] == 10


async def test_karakter_command_sends_image_embed(db):
    import discord

    import character_cog

    sent = []

    class Ctx(SimpleNamespace):
        async def send(self, *a, **kw):
            sent.append(kw)

        def typing(self):
            return _AsyncNull()

    class _AsyncNull:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    guild = SimpleNamespace(id=1)
    author = SimpleNamespace(id=5, guild=guild, display_name="Barış", color=discord.Color.default())
    cog = character_cog.CharacterCog(SimpleNamespace())
    ctx = Ctx(guild=guild, author=author)

    await cog.karakter_command.callback(cog, ctx, member=None)
    embed, file = sent[0]["embed"], sent[0]["file"]
    assert embed.title.endswith("Barış") and embed.image.url == "attachment://karakter.png"
    assert file.filename == "karakter.png" and "özelleştirilmedi" in embed.footer.text

    await outfit.save(1, 5, {"hair": "hair_rasta"}, level=1)
    await cog.karakter_command.callback(cog, ctx, member=None)
    assert "Rasta" in sent[1]["embed"].description and sent[1]["embed"].footer.text == "Gardırop: GAP Dünyası"
