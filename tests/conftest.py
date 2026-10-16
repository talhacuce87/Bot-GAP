import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def _no_stream_warmup_wait(monkeypatch):
    """Testlerde YouTube linklerinin 403 ısınma beklemesi yapılmasın."""
    from music import ytdl

    monkeypatch.setattr(ytdl, "STREAM_WARMUP_SECONDS", 0)


@pytest.fixture(autouse=True)
def _no_real_warp(monkeypatch):
    """Testlerde Cloudflare WARP indirilip başlatılmasın (WARP testleri kendi sahtesini kurar)."""
    from music.warp import Warp

    async def unavailable(self, *, fresh=False):
        self.last_error = "testte WARP kapalı"
        return False

    async def rotate(self):
        return await unavailable(self, fresh=True)

    monkeypatch.setattr(Warp, "start", unavailable)
    monkeypatch.setattr(Warp, "rotate", rotate)
