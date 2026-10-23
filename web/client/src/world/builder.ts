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
  /** Casino taburesi: oturunca bu oyun açılır; (x, y, z) kameranın yaklaşıp baktığı nokta (masa ya da ekran). */
  game?: { kind: "blackjack" | "roulette" | "slot"; x: number; y: number; z: number };
}

/** Bankların oturma yüksekliği: avatarların oturma duruşu buna göre ayarlı. */
export const SEAT_H = 0.5;

/** Tekrarlanan objeler: her biri tek InstancedMesh olarak çizilir. */
export type PropKind = "pine" | "oak" | "sakura" | "rock" | "bush" | "stone" | "post" | "bulb" | "flame" | "log";

const KEEP_CELL = 16;
const keepKey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);

export class Builder {
  readonly rand = rng(0x6a7);
  /** Tek mesh'te birleştirilecek, vertex renkli statik geometri. */
  readonly statics: THREE.BufferGeometry[] = [];
  readonly colliders = new Colliders();
  /** Yalnızca arabaları durduran engeller (dükkân ve casino kapıları: yaya geçer, araba girmez). */
  readonly carColliders = new Colliders();
  readonly seats: Seat[] = [];
  readonly props: Record<PropKind, THREE.Matrix4[]> = {
    pine: [], oak: [], sakura: [], rock: [], bush: [], stone: [], post: [], bulb: [], flame: [], log: [],
  };
  /** Zemin gölgeleri: x, z, yarıçap. */
  readonly shadows: number[] = [];
  /**
   * Çimen/çiçek serpilmeyecek alanlar: her biri eklenirken kapladığı ızgara hücrelerine yazılır, `isClear`
   * yalnızca noktanın hücresine bakar (bütün listeyi taramak açılışta ~0.6 sn tutuyordu).
   */
  private keepCells = new Map<number, ((x: number, z: number) => boolean)[]>();
  /** Ağaç/çimen serpilmeyecek arazi (su, dağ); scene.ts terrain.ts'ten bağlar. */
  blocked: ((x: number, z: number) => boolean) | null = null;

  add(geo: THREE.BufferGeometry): void {
    this.statics.push(geo);
  }

  prop(kind: PropKind, m: THREE.Matrix4): void {
    this.props[kind].push(m);
  }

  shadow(x: number, z: number, r: number): void {
    this.shadows.push(x, z, r);
  }

  private keep(minX: number, maxX: number, minZ: number, maxZ: number, inside: (x: number, z: number) => boolean): void {
    for (let i = Math.floor(minX / KEEP_CELL); i <= Math.floor(maxX / KEEP_CELL); i++) {
      for (let j = Math.floor(minZ / KEEP_CELL); j <= Math.floor(maxZ / KEEP_CELL); j++) {
        const key = keepKey(i, j);
        let list = this.keepCells.get(key);
        if (!list) this.keepCells.set(key, (list = []));
        list.push(inside);
      }
    }
  }

  clearCircle(x: number, z: number, r: number): void {
    this.keep(x - r, x + r, z - r, z + r, (px, pz) => (px - x) ** 2 + (pz - z) ** 2 < r * r);
  }

  clearBox(minX: number, maxX: number, minZ: number, maxZ: number): void {
    this.keep(minX, maxX, minZ, maxZ, (px, pz) => px > minX && px < maxX && pz > minZ && pz < maxZ);
  }

  /** Bir yol şeridini (iki nokta arası, yarıçaplı) boş tutar. */
  clearSegment(ax: number, az: number, bx: number, bz: number, r: number): void {
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez || 1;
    this.keep(Math.min(ax, bx) - r, Math.max(ax, bx) + r, Math.min(az, bz) - r, Math.max(az, bz) + r, (px, pz) => {
      const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / len2));
      const dx = px - (ax + ex * t), dz = pz - (az + ez * t);
      return dx * dx + dz * dz < r * r;
    });
  }

  isClear(x: number, z: number): boolean {
    if (this.blocked?.(x, z)) return false;
    const list = this.keepCells.get(keepKey(Math.floor(x / KEEP_CELL), Math.floor(z / KEEP_CELL)));
    if (list) for (const inside of list) if (inside(x, z)) return false;
    return true;
  }
}
