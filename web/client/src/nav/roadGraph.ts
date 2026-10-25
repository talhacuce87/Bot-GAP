// Navigasyon (GPS): dünyanın yollarından (otoban, bağlantı ve köy yolları, şehir caddeleri, mahalle sokakları,
// göbekli kavşak) bir ağ kurulur; hedefe en kısa yol bu ağ üstünde A* ile bulunur. Yollar kesiştiği yerde
// birbirine bağlanır (birbirine yakın düğümler). Yoldan uzak başlangıç ya da hedef en yakın düğüme düz bağlanır.
import { HOOD_ROADS, HOOD_ROUNDABOUT, HOOD_STREET_HALF } from "../../../shared/build";
import { LINK_ROADS, ROAD_HALF, ROAD_PATH, STREETS, VILLAGE_ROAD_HALF, VILLAGE_ROADS } from "../../../shared/zones";

type P = [number, number];

/** Yol çizgisi: orta çizgi noktaları ve yarı genişliği. */
export interface RoadLine {
  pts: readonly P[];
  half: number;
  closed?: boolean;
}

/** Düğümler arası en büyük aralık (m). */
const STEP = 6;
/** Başka yolun düğümü bu kadar yakınsa (yarı genişlikler eklenir) kavşak sayılır. */
const JOIN = 4;
const CELL = 16;
/** Hedef bu kadar yakınsa yol aranmaz, düz gidilir. */
const DIRECT = 45;

/** Oyunun bütün yolları (haritanın çizdiği aynı liste) ve kavşağın çemberi. */
export function worldRoads(): RoadLine[] {
  const R = HOOD_ROUNDABOUT, ring: P[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2, r = (R.r + R.island) / 2;
    ring.push([R.x + Math.cos(a) * r, R.z + Math.sin(a) * r]);
  }
  return [
    ...STREETS.map((s) => ({ pts: [[s.ax, s.az], [s.bx, s.bz]] as P[], half: s.half })),
    ...HOOD_ROADS.map((pts) => ({ pts, half: HOOD_STREET_HALF })),
    ...VILLAGE_ROADS.map((pts) => ({ pts, half: VILLAGE_ROAD_HALF })),
    ...[ROAD_PATH, ...LINK_ROADS].map((pts) => ({ pts, half: ROAD_HALF })),
    { pts: ring, half: (R.r - R.island) / 2, closed: true },
  ];
}

export class RoadGraph {
  readonly x: number[] = [];
  readonly z: number[] = [];
  /** Komşular (düğüm dizini). */
  readonly adj: number[][] = [];
  private line: number[] = [];
  private cells = new Map<number, number[]>();

  constructor(lines: RoadLine[]) {
    lines.forEach((l, li) => {
      const pts = l.closed ? [...l.pts, l.pts[0]] : l.pts;
      let prev = -1, first = -1;
      for (let i = 0; i < pts.length; i++) {
        const [ax, az] = pts[i];
        // Uzun parçayı STEP aralıkla böl
        if (i > 0) {
          const [px, pz] = pts[i - 1], n = Math.ceil(Math.hypot(ax - px, az - pz) / STEP);
          for (let k = 1; k < n; k++) prev = this.chain(prev, px + ((ax - px) * k) / n, pz + ((az - pz) * k) / n, li);
        }
        // Kapalı çizginin son noktası ilkidir
        if (l.closed && i === pts.length - 1) this.link(prev, first);
        else {
          prev = this.chain(prev, ax, az, li);
          if (first < 0) first = prev;
        }
      }
    });
    // Kavşaklar: başka yolun en yakın düğümüne bağla
    for (let i = 0; i < this.x.length; i++) {
      const best = new Map<number, [number, number]>();
      const reach = JOIN + Math.max(...lines.map((l) => l.half));
      this.near(this.x[i], this.z[i], reach, (j, d) => {
        const lj = this.line[j];
        if (lj === this.line[i]) return;
        const lim = JOIN + lines[this.line[i]].half + lines[lj].half;
        if (d > lim) return;
        const b = best.get(lj);
        if (!b || d < b[1]) best.set(lj, [j, d]);
      });
      for (const [j] of best.values()) this.link(i, j);
    }
  }

  private chain(prev: number, x: number, z: number, line: number): number {
    const i = this.x.length;
    this.x.push(x);
    this.z.push(z);
    this.adj.push([]);
    this.line.push(line);
    const key = this.key(x, z);
    const c = this.cells.get(key);
    if (c) c.push(i);
    else this.cells.set(key, [i]);
    if (prev >= 0) this.link(prev, i);
    return i;
  }

  private link(a: number, b: number): void {
    if (a < 0 || b < 0 || a === b || this.adj[a].includes(b)) return;
    this.adj[a].push(b);
    this.adj[b].push(a);
  }

  private key(x: number, z: number): number {
    return Math.floor(x / CELL) * 100_003 + Math.floor(z / CELL);
  }

  /** (x, z)'ye `r` metre içindeki düğümler. */
  private near(x: number, z: number, r: number, fn: (i: number, d: number) => void): void {
    const n = Math.ceil(r / CELL), cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        for (const k of this.cells.get((cx + i) * 100_003 + cz + j) ?? []) {
          const d = Math.hypot(this.x[k] - x, this.z[k] - z);
          if (d <= r) fn(k, d);
        }
      }
    }
  }

  /** En yakın düğüm (arama yarıçapını büyüterek). */
  nearest(x: number, z: number): number {
    for (let r = CELL; r <= CELL * 64; r *= 2) {
      let best = -1, bd = Infinity;
      this.near(x, z, r, (i, d) => {
        if (d < bd) [best, bd] = [i, d];
      });
      if (best >= 0) return best;
    }
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.x.length; i++) {
      const d = Math.hypot(this.x[i] - x, this.z[i] - z);
      if (d < bd) [best, bd] = [i, d];
    }
    return best;
  }

  /** Bağlı parça sayısı (test: bütün yollar birbirine bağlı mı). */
  components(): number {
    const seen = new Uint8Array(this.x.length);
    let n = 0;
    for (let s = 0; s < this.x.length; s++) {
      if (seen[s]) continue;
      n++;
      const stack = [s];
      seen[s] = 1;
      while (stack.length) for (const j of this.adj[stack.pop()!]) if (!seen[j]) stack.push(j), (seen[j] = 1);
    }
    return n;
  }

  /** `from`dan `to`ya yol boyunca giden nokta dizisi (baş ve son dahil). */
  route(fx: number, fz: number, tx: number, tz: number): P[] {
    if (Math.hypot(tx - fx, tz - fz) < DIRECT || !this.x.length) return [[fx, fz], [tx, tz]];
    const a = this.nearest(fx, fz), b = this.nearest(tx, tz);
    const n = this.x.length, g = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const h = (i: number) => Math.hypot(this.x[i] - this.x[b], this.z[i] - this.z[b]);
    const open = new Heap();
    g[a] = 0;
    open.push(a, h(a));
    while (open.size) {
      const i = open.pop();
      if (done[i]) continue;
      done[i] = 1;
      if (i === b) break;
      for (const j of this.adj[i]) {
        const c = g[i] + Math.hypot(this.x[j] - this.x[i], this.z[j] - this.z[i]);
        if (c < g[j]) {
          g[j] = c;
          from[j] = i;
          open.push(j, c + h(j));
        }
      }
    }
    // Ulaşılamıyorsa düz
    if (a !== b && from[b] < 0) return [[fx, fz], [tx, tz]];
    const path: P[] = [];
    for (let i = b; i >= 0; i = i === a ? -1 : from[i]) path.push([this.x[i], this.z[i]]);
    path.reverse();
    return [[fx, fz], ...path, [tx, tz]];
  }
}

/** Küçük ikili yığın (A* açık listesi). */
class Heap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      [ids[i], ids[p], keys[i], keys[p]] = [ids[p], ids[i], keys[p], keys[i]];
      i = p;
    }
  }

  pop(): number {
    const { ids, keys } = this;
    const top = ids[0], lastId = ids.pop()!, lastKey = keys.pop()!;
    if (ids.length) {
      ids[0] = lastId;
      keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < ids.length && keys[l] < keys[m]) m = l;
        if (r < ids.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [ids[i], ids[m], keys[i], keys[m]] = [ids[m], ids[i], keys[m], keys[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Rotada şu anki yerin `ahead` metre ilerisi: okun baktığı nokta (bir sonraki dönüş). Rotanın en yakın parçası
 * bulunur, oradan yol boyunca ilerlenir. Kalan yol uzunluğunu da döndürür.
 */
export function lookAhead(route: readonly P[], x: number, z: number, ahead: number): { x: number; z: number; left: number; off: number } {
  let bi = 0, bt = 0, bd = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const [ax, az] = route[i], [bx, bz] = route[i + 1], ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2));
    const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
    if (d < bd) [bi, bt, bd] = [i, t, d];
  }
  let left = 0;
  for (let i = bi; i < route.length - 1; i++) {
    const seg = Math.hypot(route[i + 1][0] - route[i][0], route[i + 1][1] - route[i][1]);
    left += i === bi ? seg * (1 - bt) : seg;
  }
  // İleri yürü
  let need = ahead, i = bi, t = bt;
  while (i < route.length - 1) {
    const [ax, az] = route[i], [bx, bz] = route[i + 1], seg = Math.hypot(bx - ax, bz - az), rest = seg * (1 - t);
    if (rest >= need) {
      const k = t + need / (seg || 1);
      return { x: ax + (bx - ax) * k, z: az + (bz - az) * k, left, off: bd };
    }
    need -= rest;
    i++;
    t = 0;
  }
  const end = route[route.length - 1];
  return { x: end[0], z: end[1], left, off: bd };
}
