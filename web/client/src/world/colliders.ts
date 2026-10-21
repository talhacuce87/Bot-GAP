// Fizik motoru yerine: düz zeminde kapsül (yarıçaplı doğru parçası) çarpışmaları.
// Daire = uzunluğu sıfır olan parça. Birkaç yüz engel için kare başına ihmal edilebilir maliyet.
// Üst yüksekliği (`top`) olan engellerin üstüne çıkılır: üstündeyken itmez, zemin olur.
import { STEP_UP, WORLD_RADIUS } from "../../../shared/constants";

export interface Vec2 {
  x: number;
  z: number;
}

/** Kenardan bu kadar taşınca (oyuncu yarıçapının oranı) düşülür: yarı ayak boşlukta durabilir. */
export const LEDGE = 0.5;

/** (px, pz)'nin parçaya uzaklığının karesi. */
function dist2(d: number[], i: number, px: number, pz: number): number {
  const ax = d[i], az = d[i + 1], ex = d[i + 2] - ax, ez = d[i + 3] - az;
  const len2 = ex * ex + ez * ez;
  let t = len2 > 0 ? ((px - ax) * ex + (pz - az) * ez) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - ax - ex * t, dz = pz - az - ez * t;
  return dx * dx + dz * dz;
}

export class Colliders {
  private data: number[] = []; // ax, az, bx, bz, r, top

  get count(): number {
    return this.data.length / 6;
  }

  /** `top`: üst yüzeyin yüksekliği (üstüne çıkılır); verilmezse aşılmaz duvar. */
  circle(x: number, z: number, r: number, top = Infinity): void {
    this.data.push(x, z, x, z, r, top);
  }

  segment(ax: number, az: number, bx: number, bz: number, r: number, top = Infinity): void {
    this.data.push(ax, az, bx, bz, r, top);
  }

  /** `p`yi engellerin dışına iter ve dünya sınırının içinde tutar (yerinde değiştirir). `y`: ayak yüksekliği. */
  resolve(p: Vec2, radius: number, y = 0): void {
    const d = this.data;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < d.length; i += 6) {
        if (d[i + 5] <= y + STEP_UP) continue; // üstünde (ya da basamak kadar alçak)
        pushOutOf(d, i, p, d[i + 4] + radius);
      }
    }
    const r = Math.hypot(p.x, p.z);
    const limit = WORLD_RADIUS - radius;
    if (r > limit) {
      p.x *= limit / r;
      p.z *= limit / r;
    }
  }

  /** Ayakları `y`de olan oyuncunun altındaki en yüksek zemin (yer 0). `y` Infinity: konuma göre en üstteki. */
  groundAt(x: number, z: number, radius: number, y = Infinity): number {
    const d = this.data;
    let g = 0;
    for (let i = 0; i < d.length; i += 6) {
      const top = d[i + 5];
      if (top <= g || top === Infinity || top > y + STEP_UP) continue;
      const reach = d[i + 4] + radius * LEDGE;
      if (x < Math.min(d[i], d[i + 2]) - reach || x > Math.max(d[i], d[i + 2]) + reach) continue;
      if (z < Math.min(d[i + 1], d[i + 3]) - reach || z > Math.max(d[i + 1], d[i + 3]) + reach) continue;
      if (dist2(d, i, x, z) <= reach * reach) g = top;
    }
    return g;
  }
}

function pushOutOf(d: number[], i: number, p: Vec2, minD: number): void {
  const ax = d[i], az = d[i + 1], bx = d[i + 2], bz = d[i + 3];
  // Hızlı ret: parçanın kutusu + yarıçap dışındaysa atla.
  if (p.x < Math.min(ax, bx) - minD || p.x > Math.max(ax, bx) + minD) return;
  if (p.z < Math.min(az, bz) - minD || p.z > Math.max(az, bz) + minD) return;
  const ex = bx - ax, ez = bz - az;
  const len2 = ex * ex + ez * ez;
  let t = len2 > 0 ? ((p.x - ax) * ex + (p.z - az) * ez) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = p.x - ax - ex * t, dz = p.z - az - ez * t;
  const dist2 = dx * dx + dz * dz;
  if (dist2 >= minD * minD) return;
  const dist = Math.sqrt(dist2);
  if (dist > 1e-5) {
    const push = (minD - dist) / dist;
    p.x += dx * push;
    p.z += dz * push;
  } else {
    p.x += minD;
  }
}
