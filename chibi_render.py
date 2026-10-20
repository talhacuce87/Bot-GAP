"""
chibi_render.py — Chibi karakter resmi (!karakter) için yazılım çizici.

assets/chibi/chibi.{json,bin} paketini (web/scripts/bake-chibi.mjs üretir) okur,
seçili parçaları birleştirir ve Pillow ile çizer: ressam algoritması (uzaktan yakına),
iki tonlu cel gölgelendirme ve ters gövde (inverted hull) konturu. GPU/OpenGL gerekmez;
~10-20 bin üçgen yarım saniyenin altında çizilir.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw

PACK_DIR = Path(__file__).resolve().parent / "assets" / "chibi"

# Kıyafet anahtarları = paket kategorileri
SLOTS = ("hair", "tops", "bottoms", "shoes", "hats", "glasses", "facial")
COLOR_KEYS = {"skin": 1, "hair": 2, "eye": 3}  # renk sınıfı numaraları (manifest "tints")

# Ressam algoritmasında üst üste binen giysi katmanları: büyük olan önde kalır (m)
LAYER_BIAS = {"base": 0.0, "bottoms": 0.01, "shoes": 0.015, "tops": 0.03, "facial": 0.035,
              "hair": 0.04, "glasses": 0.045, "hats": 0.05}

@dataclass
class Part:
    id: str
    cat: str
    pos: list[tuple[float, float, float]]
    nor: list[tuple[float, float, float]]
    col: list[tuple[int, int, int]]
    tint: list[int]
    tris: list[tuple[int, int, int]]
    ref: dict[str, list[int]]
    full: bool


@lru_cache(maxsize=1)
def load_pack(pack_dir: Path = PACK_DIR) -> tuple[dict, dict[str, Part]]:
    manifest = json.loads((pack_dir / "chibi.json").read_text(encoding="utf-8"))
    blob = (pack_dir / "chibi.bin").read_bytes()
    stride, scale = manifest["stride"], manifest["posScale"]
    vfmt = struct.Struct("<3h3b3BBBx")
    parts: dict[str, Part] = {}
    for pid, m in manifest["parts"].items():
        pos, nor, col, tint = [], [], [], []
        for i in range(m["vCount"]):
            px, py, pz, nx, ny, nz, r, g, b, t, _limb = vfmt.unpack_from(blob, m["vOff"] + i * stride)
            pos.append((px * scale, py * scale, pz * scale))
            nor.append((nx / 127, ny / 127, nz / 127))
            col.append((r, g, b))
            tint.append(t)
        idx = struct.unpack_from(f"<{m['iCount']}H", blob, m["iOff"])
        tris = [(idx[i], idx[i + 1], idx[i + 2]) for i in range(0, len(idx), 3)]
        parts[pid] = Part(pid, m["cat"], pos, nor, col, tint, tris, m.get("ref", {}), bool(m.get("full")))
    return manifest, parts


def compose(outfit: dict[str, str | None]) -> list[Part]:
    """Kıyafete göre çizilecek parçalar; boş üst/alt için temel atlet/şort, tek parça üst altı gizler."""
    _, parts = load_pack()
    chosen = {slot: outfit.get(slot) for slot in SLOTS}
    chosen = {slot: pid for slot, pid in chosen.items() if pid in parts and parts[pid].cat == slot}
    out = [parts["base"]]
    top = parts.get(chosen.get("tops", ""))
    out.append(top or parts["base_top"])
    if not (top and top.full):
        out.append(parts.get(chosen.get("bottoms", "")) or parts["base_bottom"])
    for slot in ("shoes", "hair", "hats", "glasses", "facial"):
        if slot in chosen:
            out.append(parts[chosen[slot]])
    return out


def _lum(c) -> float:
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def _smoothstep(a: float, b: float, x: float) -> float:
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def _hex(value: str | None) -> tuple[int, int, int] | None:
    if not value:
        return None
    v = value.lstrip("#")
    if len(v) != 6:
        return None
    try:
        return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    except ValueError:
        return None


def render(outfit: dict | None = None, size: int = 512, yaw_deg: float = -24.0,
           background: tuple[int, int, int, int] = (0, 0, 0, 0)) -> Image.Image:
    """
    Karakteri 3/4 açıdan çizer. outfit: slot → parça kimliği (outfit.py doğrular),
    renkler outfit["colors"] = {"skin"|"hair"|"eye": "#rrggbb"}. Boş kıyafet: temel atlet/şort.
    """
    outfit = outfit or {}
    manifest, _ = load_pack()
    chosen = compose(outfit)
    colors = {k: _hex((outfit.get("colors") or {}).get(k)) for k in COLOR_KEYS}
    hat = any(p.cat == "hats" for p in chosen)
    hc = manifest["headCenter"]
    hat_r = manifest["hatHairRadius"]

    ss = 2  # süper örnekleme: büyük çizip küçült (kenar yumuşatma)
    W = size * ss
    yaw, pitch = math.radians(yaw_deg), math.radians(8)
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
    light = (0.45, 0.75, 0.5)
    ll = math.sqrt(sum(c * c for c in light))
    light = tuple(c / ll for c in light)
    outline_w = 0.012

    def view(p):
        x, y, z = p
        x, z = x * cy + z * sy, -x * sy + z * cy  # y ekseni etrafında
        y, z = y * cp - z * sp, y * sp + z * cp   # hafif yukarıdan bakış
        return x, y, z

    # Önce dünya koordinatlarında tüm üçgenler (bounding box için)
    faces = []  # (derinlik, [(x,y)...], renk)
    hull = []
    pts_all = []
    for part in chosen:
        # Renk değişimi parlaklığı korur: köşenin referansa göre açıklığı seçilen renge uygulanır
        recolor = {}
        for name, t in COLOR_KEYS.items():
            want, ref = colors[name], part.ref.get(name)
            if want and ref:
                recolor[t] = (want, max(_lum(ref), 1.0))
        vpos = []
        for i, p in enumerate(part.pos):
            if hat and part.cat == "hair":
                d = [p[k] - hc[k] for k in range(3)]
                r = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
                if r > hat_r and p[1] > hc[1] - 0.1:
                    p = tuple(hc[k] + d[k] * hat_r / r for k in range(3))
            vpos.append(view(p))
        vnor = [view(n) for n in part.nor]
        bias = LAYER_BIAS.get(part.cat, 0.0)
        pts_all.extend(vpos)
        for a, b, c in part.tris:
            pa, pb, pc = vpos[a], vpos[b], vpos[c]
            # Ekran uzayında yön: önü bize bakan mı?
            cross = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])
            nx = (vnor[a][0] + vnor[b][0] + vnor[c][0]) / 3
            ny = (vnor[a][1] + vnor[b][1] + vnor[c][1]) / 3
            nz = (vnor[a][2] + vnor[b][2] + vnor[c][2]) / 3
            depth = (pa[2] + pb[2] + pc[2]) / 3 + bias
            col = [sum(part.col[v][k] for v in (a, b, c)) / 3 for k in range(3)]
            t = part.tint[a]
            if t in recolor:
                want, ref_lum = recolor[t]
                # Açık/koyu katman farkı korunur ama yumuşatılır; açık katmanlar beyaza patlamasın
                f = min(1.3, (_lum(col) / ref_lum) ** 0.5)
                col = [want[k] * f for k in range(3)]
            lam = nx * light[0] + ny * light[1] + nz * light[2]
            # Cel gölge: iki ton, aradaki geçiş dar ama yumuşak (sadeleştirilmiş ağda benek olmasın)
            shade = 0.78 + 0.22 * _smoothstep(-0.05, 0.3, lam)
            rgb = tuple(min(255, int(c * shade)) for c in col)
            faces.append((depth, (pa, pb, pc), rgb))
            # Kontur: köşeleri normal boyunca dışarı it, arkaya bakan yüzleri siyah çiz
            if cross < 0 or nz < 0:
                ex = [(v[0] + vnor[i][0] * outline_w, v[1] + vnor[i][1] * outline_w, v[2] + vnor[i][2] * outline_w)
                      for v, i in ((pa, a), (pb, b), (pc, c))]
                hull.append(((ex[0][2] + ex[1][2] + ex[2][2]) / 3 + bias - 0.004, tuple(ex), (28, 22, 34)))

    xs = [p[0] for p in pts_all]
    ys = [p[1] for p in pts_all]
    span = max(max(xs) - min(xs), max(ys) - min(ys)) * 1.12
    cx, cyy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    k = W / span

    img = Image.new("RGBA", (W, W), background)
    draw = ImageDraw.Draw(img)
    # Uzaktan yakına (z büyüdükçe kameraya yakın)
    for _, tri, rgb in sorted(hull + faces, key=lambda f: f[0]):
        draw.polygon([((x - cx) * k + W / 2, W / 2 - (y - cyy) * k) for x, y, _z in tri], fill=rgb)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import sys
    import time

    t = time.perf_counter()
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "chibi.png")
    render({"hair": "hair_kisa_doku", "tops": "top_tisort", "bottoms": "bottom_kot", "shoes": "shoes_sneaker"}).save(out)
    print(f"{out} ({time.perf_counter() - t:.2f}s)")
