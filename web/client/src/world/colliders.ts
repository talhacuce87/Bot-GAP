// Fizik motoru yerine: düz zeminde kapsül (yarıçaplı doğru parçası) çarpışmaları.
// Daire = uzunluğu sıfır olan parça. Birkaç yüz engel için kare başına ihmal edilebilir maliyet.
import { WORLD_RADIUS } from "../../../shared/constants";

export interface Vec2 {
  x: number;
  z: number;
}

export class Colliders {
  private data: number[] = []; // ax, az, bx, bz, r

  get count(): number {
    return this.data.length / 5;
  }

  circle(x: number, z: number, r: number): void {
    this.data.push(x, z, x, z, r);
  }

  segment(ax: number, az: number, bx: number, bz: number, r: number): void {
    this.data.push(ax, az, bx, bz, r);
  }

  /** `p`yi engellerin dışına iter ve dünya sınırının içinde tutar (yerinde değiştirir). */
  resolve(p: Vec2, radius: number): void {
    const d = this.data;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < d.length; i += 5) {
        const ax = d[i], az = d[i + 1], bx = d[i + 2], bz = d[i + 3];
        const minD = d[i + 4] + radius;
        // Hızlı ret: parçanın kutusu + yarıçap dışındaysa atla.
        if (p.x < Math.min(ax, bx) - minD || p.x > Math.max(ax, bx) + minD) continue;
        if (p.z < Math.min(az, bz) - minD || p.z > Math.max(az, bz) + minD) continue;
        const ex = bx - ax, ez = bz - az;
        const len2 = ex * ex + ez * ez;
        let t = len2 > 0 ? ((p.x - ax) * ex + (p.z - az) * ez) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + ex * t, cz = az + ez * t;
        const dx = p.x - cx, dz = p.z - cz;
        const dist2 = dx * dx + dz * dz;
        if (dist2 >= minD * minD) continue;
        const dist = Math.sqrt(dist2);
        if (dist > 1e-5) {
          const push = (minD - dist) / dist;
          p.x += dx * push;
          p.z += dz * push;
        } else {
          p.x += minD;
        }
      }
    }
    const r = Math.hypot(p.x, p.z);
    const limit = WORLD_RADIUS - radius;
    if (r > limit) {
      p.x *= limit / r;
      p.z *= limit / r;
    }
  }
}
