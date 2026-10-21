// Sahne parçalarını toplayan kurucu: bölgeler buraya ekler, sonunda her tür tek mesh'e iner.
// Böylece yeni bir bölge eklemek draw call sayısını artırmaz.
import * as THREE from "three";
import { Colliders } from "./colliders";
import { rng } from "./geo";

export interface Seat {
  x: number;
  z: number;
  rot: number;
  /** Kahvehane masası sandalyesi: oturunca masaya katılır. */
  table?: { id: number; seat: number };
  /** Oturulan yüzeyin yüksekliği; verilmezse bank (SEAT_H). */
  h?: number;
}

/** Bankların oturma yüksekliği: avatarların oturma duruşu buna göre ayarlı. */
export const SEAT_H = 0.5;

/** Tekrarlanan objeler: her biri tek InstancedMesh olarak çizilir. */
export type PropKind = "pine" | "oak" | "sakura" | "rock" | "bush" | "stone" | "post" | "bulb" | "flame" | "log";

export class Builder {
  readonly rand = rng(0x6a7);
  /** Tek mesh'te birleştirilecek, vertex renkli statik geometri. */
  readonly statics: THREE.BufferGeometry[] = [];
  readonly colliders = new Colliders();
  readonly seats: Seat[] = [];
  readonly props: Record<PropKind, THREE.Matrix4[]> = {
    pine: [], oak: [], sakura: [], rock: [], bush: [], stone: [], post: [], bulb: [], flame: [], log: [],
  };
  /** Zemin gölgeleri: x, z, yarıçap. */
  readonly shadows: number[] = [];
  /** Çimen/çiçek serpilmeyecek alanlar. */
  private keepOut: { x: number; z: number; r: number }[] = [];
  private keepOutBoxes: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  private keepOutSegs: number[] = []; // ax, az, bx, bz, r

  add(geo: THREE.BufferGeometry): void {
    this.statics.push(geo);
  }

  prop(kind: PropKind, m: THREE.Matrix4): void {
    this.props[kind].push(m);
  }

  shadow(x: number, z: number, r: number): void {
    this.shadows.push(x, z, r);
  }

  clearCircle(x: number, z: number, r: number): void {
    this.keepOut.push({ x, z, r });
  }

  clearBox(minX: number, maxX: number, minZ: number, maxZ: number): void {
    this.keepOutBoxes.push({ minX, maxX, minZ, maxZ });
  }

  /** Bir yol şeridini (iki nokta arası, yarıçaplı) boş tutar. */
  clearSegment(ax: number, az: number, bx: number, bz: number, r: number): void {
    this.keepOutSegs.push(ax, az, bx, bz, r);
  }

  isClear(x: number, z: number): boolean {
    for (const c of this.keepOut) if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r) return false;
    for (const b of this.keepOutBoxes) if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return false;
    const s = this.keepOutSegs;
    for (let i = 0; i < s.length; i += 5) {
      const ex = s[i + 2] - s[i], ez = s[i + 3] - s[i + 1];
      const len2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - s[i]) * ex + (z - s[i + 1]) * ez) / len2));
      const dx = x - (s[i] + ex * t), dz = z - (s[i + 1] + ez * t);
      if (dx * dx + dz * dz < s[i + 4] * s[i + 4]) return false;
    }
    return true;
  }
}
