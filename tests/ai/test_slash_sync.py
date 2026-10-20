"""AI_SLASH_SYNC: toplu komut yazımı Activity başlatma komutunu (/launch) silmemeli."""

from __future__ import annotations

from types import SimpleNamespace

from ai.cog import ENTRY_POINT_TYPE, sync_slash_commands


async def test_sync_keeps_activity_entry_point_and_replaces_the_rest():
    entry = {"id": "9", "application_id": "1", "version": "5", "name": "launch", "description": "GAP Dünyası",
             "type": ENTRY_POINT_TYPE, "handler": 2, "integration_types": [0], "contexts": [0]}
    stale = {"id": "8", "name": "eski", "description": "x", "type": 1}
    written = {}

    async def get_global_commands(app_id):
        assert app_id == 1
        return [entry, stale]

    async def bulk_upsert_global_commands(app_id, payload):
        written["payload"] = payload
        return payload

    tree = SimpleNamespace(get_commands=lambda: [SimpleNamespace(to_dict=lambda t: {"name": "ara", "type": 1})])
    bot = SimpleNamespace(
        application_id=1, tree=tree,
        http=SimpleNamespace(get_global_commands=get_global_commands, bulk_upsert_global_commands=bulk_upsert_global_commands),
    )
    assert await sync_slash_commands(bot) == 2
    names = [c["name"] for c in written["payload"]]
    assert names == ["ara", "launch"]  # eski komut silinir, /launch korunur
    kept = written["payload"][1]
    assert kept["id"] == "9" and kept["handler"] == 2 and "version" not in kept
