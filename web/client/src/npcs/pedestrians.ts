// NPC yayalar: birbirine bağlı kaldırımlarda ve köy patikalarında bir yere gidip dönenler (yolda vitrine bakıp,
// telefonuna göz atıp duran), köşede telefonla konuşanlar, karşılıklı sohbet edenler, banklarda oturanlar.
// Konumları sunucu saatinin fonksiyonudur (yol ağı, tur, hız ve duraklar sabit tohumdan): herkes aynı yayayı
// aynı yerde görür, ağ trafiği yok. Oyuncuya yol verme, arabadan kaçma, el sallamaya karşılık verme yereldir.
// Arabanın çarptığı yaya sunucu üzerinden herkese duyurulur ("pedhit").
import { CAR_HULL_R, carCircles } from "../../../shared/car";
import type { ClientEvent } from "../../../shared/protocol";
import { CHIBI_SEAT_LIFT } from "../avatars/avatars";
import type { CrowdPose, CrowdRenderer } from "../avatars/crowd";
import type { Walkway, Zone } from "../world/walkways";
import { lerp, lerpAngle } from "./fixedStep";

/** Yayaların konuşma balonu kimlikleri bu sayıdan başlar (oyuncu sid'leriyle çakışmaz). */
export const PED_SID_BASE = 80_000;
/** Bölge başına yürüyen yaya ("normal" kalabalıkta; yoğunluk saate göre bunun bir kısmı). */
const COUNTS: Record<Zone, number> = { village: 50, city: 80, hood: 56 };
/** Bu kadarı bir noktada durur (telefon, sohbet). */
const LOITER = 0.18;
/** Bankların bu kadarında biri oturur (yoğunluğa göre). */
const SIT_SHARE = 0.35;
const WALK_MIN = 1.35;
const WALK_MAX = 1.85;
/** Tur uzunluğu (m): bir yere gidip döner. */
const TOUR_MIN = 120;
const TOUR_MAX = 420;
/** Yol ağı: bu kadar yakın uçlar birleşir, kopuk uçlar bu kadar uzaktaki yola bağlanır. */
const SNAP = 1.5;
const BRIDGE = 5;
/** Yol uçlarının uzatılması ve bundan kısa çıkmaz kuyrukların budanması (m). */
const EXTEND = 5;
const STUB = 6;
/** Çizim yarıçapı ve en çok çizilen yaya (zayıf cihazda daha az). */
const DRAW_R = 80;
const DRAW_R_LOW = 45;
const MAX_DRAWN = 64;
const MAX_DRAWN_LOW = 24;
/** Çarpma: arabanın en az bu hızı (m/sn); aynı yayaya tekrar çarpma bekleme süresi (sn). */
export const HIT_SPEED = 3;
const HIT_COOLDOWN = 3;
/** Düşme animasyonu: savrulma, yerde kalma, kalkma (sn). */
const FLY_T = 0.55;
const LIE_T = 2.4;
const UP_T = 3.1;
/** Çizim durumu bitleri (benzetim adımı yazar, çizim pozu bunlardan kurar). */
const S_MOVING = 1;
const S_RUN = 2;
const S_WAVE = 4;
const S_PHONE = 8;
/** Adım başına kayıtlı değerler: x, y, z, yön, düşme açısı. */
const REC = 5;
const HIT_LINES = ["Kör müsün!", "Ayy belim!", "Hey! Yavaş!", "Ehliyeti nereden aldın?", "Polis çağırıyorum!", "Ah ah, gençler…"];

type P2 = [number, number];
type Kind = "walk" | "phone" | "chat" | "sit";

/** Yürüyüşün bir dilimi: `t0`dan itibaren `s0`'dan `s1`'e (durakta s0 = s1). */
interface Leg {
  t0: number;
  s0: number;
  s1: number;
  /** Durakta yapılan: 0 bakınma, 1 telefona bakma. */
  act: number;
}

interface Ped {
  zone: Zone;
  kind: Kind;
  outfit: number;
  /** Yoğunluk eşiği: bölgenin o saatteki yoğunluğu bunun üstündeyse görünür. */
  gate: number;
  phase: number;
  v: number;
  /** Tur: kırık çizgi, kümülatif uzunluk, gidiş-dönüş zaman çizelgesi ve süresi. */
  pts: P2[];
  cum: number[];
  legs: Leg[];
  T: number;
  /** Yürürken yönün sağına kayma (iki yönde de sağdan yürür). */
  lat: number;
  /** Duran/oturanın yeri, yönü ve yüksekliği. */
  sx: number;
  sz: number;
  srot: number;
  sy: number;
  /** Kaba eleme için turun kutusu. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Oyuncu ya da araba (her kare çağıran doldurur). */
export interface Mover {
  x: number;
  z: number;
  /** Arabadaysa hızı (m/sn), yayaysa 0. */
  speed: number;
  vx: number;
  vz: number;
  /** Az önce el salladı. */
  wave: boolean;
}

/** Kendi araban (çarpma bunun üzerinden sunucuya bildirilir). */
export interface MyCar {
  x: number;
  z: number;
  rot: number;
  v: number;
}

/** Oturulabilecek bank. */
export interface BenchSeat {
  x: number;
  z: number;
  rot: number;
  h?: number;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bölgenin saate göre yoğunluğu (0–1), Türkiye saati. */
export function zoneDensity(zone: Zone, h: number): number {
  const at = (pts: [number, number][]) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [h0, d0] = pts[i], [h1, d1] = pts[i + 1];
      if (h >= h0 && h <= h1) return d0 + ((d1 - d0) * (h - h0)) / (h1 - h0);
    }
    return pts[pts.length - 1][1];
  };
  if (zone === "city") return at([[0, 0.6], [3, 0.2], [6, 0.25], [9, 0.65], [13, 0.7], [17, 0.85], [21, 1], [24, 0.6]]);
  if (zone === "hood") return at([[0, 0.2], [3, 0.05], [6, 0.1], [9, 0.45], [13, 0.5], [19, 0.55], [22, 0.35], [24, 0.2]]);
  return at([[0, 0.3], [3, 0.1], [6, 0.2], [9, 0.6], [13, 0.75], [18, 0.7], [22, 0.45], [24, 0.3]]);
}

/** Konumun bölgesi (bank gibi yola bağlı olmayanlar için). */
function zoneAt(x: number): Zone {
  return x > 200 ? "city" : x < -200 ? "hood" : "village";
}

// ---------------------------------------------------------------------------
// Yol ağı: yürüyüş yolları kesiştikleri ve uçlarının birleştiği yerlerde düğümlere ayrılır
// ---------------------------------------------------------------------------

interface Edge {
  a: number;
  b: number;
  pts: P2[];
  len: number;
  zone: Zone;
}

interface Graph {
  nodes: P2[];
  edges: Edge[];
  /** Düğümden çıkan kenarlar. */
  out: number[][];
}

function segHit(a: P2, b: P2, c: P2, d: P2): [number, number] | null {
  const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u >= 0 && u <= 1 ? [t, u] : null;
}

/** Kırık çizginin iki ucunu kendi yönünde `d` kadar uzatır (T-kavşakta karşı kaldırımla kesişsin). */
function extend(pts: P2[], d: number): P2[] {
  if (pts.length < 2) return pts;
  const ext = (a: P2, b: P2): P2 => {
    const dx = a[0] - b[0], dz = a[1] - b[1], l = Math.hypot(dx, dz) || 1;
    return [a[0] + (dx / l) * d, a[1] + (dz / l) * d];
  };
  return [ext(pts[0], pts[1]), ...pts.slice(1, -1), ext(pts[pts.length - 1], pts[pts.length - 2])];
}

/**
 * Yürüyüş yollarından düğümlü ağ. Uçlar biraz uzatılır (T-kavşaklar birleşsin), sonra uçta kalan kısa
 * kuyruklar budanır.
 */
export function buildGraph(input: Walkway[], ok: (x: number, z: number) => boolean = () => true): Graph {
  const ways = input.map((w) => ({ ...w, pts: extend(w.pts, EXTEND) }));
  // Her yolun üzerindeki kesim noktaları: s (parça indeksi + oran)
  const cuts: number[][] = ways.map((w) => [0, w.pts.length - 1]);
  for (let i = 0; i < ways.length; i++) {
    const A = ways[i].pts;
    for (let j = i + 1; j < ways.length; j++) {
      const B = ways[j].pts;
      for (let p = 0; p < A.length - 1; p++) {
        const ax0 = Math.min(A[p][0], A[p + 1][0]), ax1 = Math.max(A[p][0], A[p + 1][0]);
        const az0 = Math.min(A[p][1], A[p + 1][1]), az1 = Math.max(A[p][1], A[p + 1][1]);
        for (let q = 0; q < B.length - 1; q++) {
          if (Math.max(B[q][0], B[q + 1][0]) < ax0 || Math.min(B[q][0], B[q + 1][0]) > ax1) continue;
          if (Math.max(B[q][1], B[q + 1][1]) < az0 || Math.min(B[q][1], B[q + 1][1]) > az1) continue;
          const h = segHit(A[p], A[p + 1], B[q], B[q + 1]);
          // Uzatılmış uçlar suyun ya da tepenin üstünde kesişebilir: oradan geçit açılmaz
          if (!h || !ok(A[p][0] + (A[p + 1][0] - A[p][0]) * h[0], A[p][1] + (A[p + 1][1] - A[p][1]) * h[0])) continue;
          cuts[i].push(p + h[0]);
          cuts[j].push(q + h[1]);
        }
      }
    }
  }
  const nodes: P2[] = [];
  const node = (x: number, z: number): number => {
    for (let k = 0; k < nodes.length; k++) if (Math.abs(nodes[k][0] - x) < SNAP && Math.abs(nodes[k][1] - z) < SNAP) return k;
    nodes.push([x, z]);
    return nodes.length - 1;
  };
  const at = (P: P2[], s: number): P2 => {
    const i = Math.min(P.length - 2, Math.floor(s)), u = s - i;
    return [P[i][0] + (P[i + 1][0] - P[i][0]) * u, P[i][1] + (P[i + 1][1] - P[i][1]) * u];
  };
  const edges: Edge[] = [];
  ways.forEach((w, i) => {
    const cs = [...new Set(cuts[i].map((c) => Math.round(c * 1e4) / 1e4))].sort((x, y) => x - y);
    for (let k = 0; k < cs.length - 1; k++) {
      const s0 = cs[k], s1 = cs[k + 1];
      const pts: P2[] = [at(w.pts, s0)];
      for (let v = Math.floor(s0) + 1; v < s1; v++) pts.push(w.pts[v]);
      pts.push(at(w.pts, s1));
      let len = 0;
      for (let v = 1; v < pts.length; v++) len += Math.hypot(pts[v][0] - pts[v - 1][0], pts[v][1] - pts[v - 1][1]);
      if (len < 0.5) continue;
      edges.push({ a: node(pts[0][0], pts[0][1]), b: node(pts[pts.length - 1][0], pts[pts.length - 1][1]), pts, len, zone: w.zone });
    }
  });
  // Uzatmadan kalan kısa çıkmaz kuyrukları buda (birkaç tur: kuyruk kuyruğa bağlıysa)
  for (let pass = 0; pass < 3; pass++) {
    const deg = new Array(nodes.length).fill(0);
    for (const e of edges) {
      deg[e.a]++;
      deg[e.b]++;
    }
    for (let k = edges.length - 1; k >= 0; k--) {
      const e = edges[k];
      if (e.len < STUB && (deg[e.a] === 1) !== (deg[e.b] === 1)) edges.splice(k, 1);
    }
  }
  // Hiçbir yere bağlanmayan uçlar uzatılmış kalmasın: yolun asıl ucuna geri çekilir
  const deg = new Array(nodes.length).fill(0);
  for (const e of edges) {
    deg[e.a]++;
    deg[e.b]++;
  }
  for (const e of edges) {
    for (const end of [0, 1] as const) {
      if (deg[end ? e.b : e.a] !== 1) continue;
      const i = end ? e.pts.length - 1 : 0, j = end ? i - 1 : 1;
      const [a, b] = [e.pts[i], e.pts[j]], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const cut = Math.min(EXTEND, l - 0.1);
      if (cut <= 0) continue;
      e.pts[i] = [a[0] + ((b[0] - a[0]) / l) * cut, a[1] + ((b[1] - a[1]) / l) * cut];
      e.len -= cut;
      nodes.push(e.pts[i]);
      if (end) e.b = nodes.length - 1;
      else e.a = nodes.length - 1;
    }
  }
  const out: number[][] = nodes.map(() => []);
  edges.forEach((e, k) => {
    out[e.a].push(k);
    out[e.b].push(k);
  });
  // Kopuk uçları en yakın başka düğüme kısa bir bağlantıyla bağla (patikanın ucu meydanın halkasına gibi)
  for (let n = 0; n < nodes.length; n++) {
    if (out[n].length !== 1) continue;
    let best = -1, bestD = BRIDGE;
    for (let m = 0; m < nodes.length; m++) {
      if (m === n || out[m].some((k) => edges[k].a === n || edges[k].b === n)) continue;
      const d = Math.hypot(nodes[m][0] - nodes[n][0], nodes[m][1] - nodes[n][1]);
      if (d < bestD) [best, bestD] = [m, d];
    }
    if (best < 0) continue;
    const k = edges.push({ a: n, b: best, pts: [nodes[n], nodes[best]], len: bestD, zone: edges[out[n][0]].zone }) - 1;
    out[n].push(k);
    out[best].push(k);
  }
  return { nodes, edges, out };
}

function cumulative(pts: P2[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}

/** Tur: düğümden başlayıp ağda rastgele (geri dönmeden) yürüyerek `len` metrelik kırık çizgi. */
function tour(g: Graph, start: number, len: number, rand: () => number): P2[] {
  const pts: P2[] = [g.nodes[start]];
  let at = start, prev = -1, total = 0;
  for (let step = 0; step < 40 && total < len; step++) {
    const opts = g.out[at].filter((k) => k !== prev);
    const list = opts.length ? opts : g.out[at];
    if (!list.length) break;
    const k = list[Math.floor(rand() * list.length)];
    const e = g.edges[k];
    const seq = e.a === at ? e.pts : [...e.pts].reverse();
    for (let i = 1; i < seq.length; i++) pts.push(seq[i]);
    total += e.len;
    prev = k;
    at = e.a === at ? e.b : e.a;
  }
  return pts;
}

/** Gidiş-dönüş zaman çizelgesi: yolda birkaç durak, uçlarda bekleme. */
function schedule(len: number, v: number, rand: () => number): { legs: Leg[]; T: number } {
  const stops: { s: number; d: number; act: number }[] = [];
  const n = Math.floor(len / 70);
  for (let k = 0; k < n; k++) stops.push({ s: (0.1 + rand() * 0.8) * len, d: 2.5 + rand() * 6, act: rand() < 0.35 ? 1 : 0 });
  stops.sort((a, b) => a.s - b.s);
  const legs: Leg[] = [];
  let t = 0;
  const walk = (s0: number, s1: number) => {
    legs.push({ t0: t, s0, s1, act: 0 });
    t += Math.abs(s1 - s0) / v;
  };
  const wait = (s: number, d: number, act: number) => {
    legs.push({ t0: t, s0: s, s1: s, act });
    t += d;
  };
  wait(0, 2 + rand() * 6, 0);
  let s = 0;
  for (const st of stops) {
    walk(s, st.s);
    wait(st.s, st.d, st.act);
    s = st.s;
  }
  walk(s, len);
  wait(len, 3 + rand() * 8, rand() < 0.4 ? 1 : 0);
  s = len;
  // Dönüşte duraklarda daha kısa
  for (let k = stops.length - 1; k >= 0; k--) {
    walk(s, stops[k].s);
    s = stops[k].s;
    if (rand() < 0.5) wait(s, stops[k].d * 0.5, stops[k].act);
  }
  walk(s, 0);
  return { legs, T: t };
}

/** Yol üzerinde `s` metredeki nokta ve yön (yürüyüş yönü +). */
function along(pts: P2[], cum: number[], s: number, out: { x: number; z: number; dx: number; dz: number }): void {
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1, u = Math.min(1, Math.max(0, (s - cum[lo]) / seg));
  const a = pts[lo], b = pts[hi];
  out.x = a[0] + (b[0] - a[0]) * u;
  out.z = a[1] + (b[1] - a[1]) * u;
  out.dx = (b[0] - a[0]) / seg;
  out.dz = (b[1] - a[1]) / seg;
}

/** Yayalar ve kendi tepkileri. */
export class Pedestrians {
  private peds: Ped[] = [];
  /** Yerel tepki kayması (yol verme, kaçma) ve yumuşatılmış yön. */
  private ox: Float32Array;
  private oz: Float32Array;
  private rot: Float32Array;
  /** Son çizildiği kare (yönü ilk görüldüğünde yumuşatmadan koymak için). */
  private seen: Int32Array;
  /** Bu kare çizildiği konum (konuşma balonu için). */
  private px: Float32Array;
  private pz: Float32Array;
  /** Son ve önceki benzetim adımındaki x, y, z, yön, düşme (REC'er); çizim ikisinin arasından. */
  private cur: Float32Array;
  private prev: Float32Array;
  /** Son adımın durum bitleri (S_*) ve belirme ölçeği. */
  private state: Uint8Array;
  private fade: Float32Array;
  private down = new Map<number, { at: number; vx: number; vz: number }>();
  private lastHit = new Map<number, number>();
  private frame = 0;
  private pose: CrowdPose = { swing: 0, seated: false, wave: 0, phone: 0 };
  private tmp = { x: 0, z: 0, dx: 0, dz: 1 };
  private order: number[] = [];
  private dist: Float32Array;

  constructor(ways: Walkway[], outfits: number, benches: BenchSeat[] = [], ok?: (x: number, z: number) => boolean) {
    const rand = mulberry(0x5eed_9a7);
    const pickOutfit = () => Math.floor(rand() * Math.max(1, outfits));
    const g = buildGraph(ways, ok);
    for (const zone of ["village", "city", "hood"] as Zone[]) {
      // Başlangıç düğümleri: bölgenin kenarlarının uçları, kenar uzunluğuyla orantılı
      const edges = g.edges.filter((e) => e.zone === zone);
      const total = edges.reduce((s, e) => s + e.len, 0);
      if (!total) continue;
      const pickEdge = () => {
        let r = rand() * total;
        for (const e of edges) {
          if (r < e.len) return e;
          r -= e.len;
        }
        return edges[edges.length - 1];
      };
      for (let k = 0; k < COUNTS[zone]; k++) {
        const e = pickEdge();
        const base = { zone, outfit: pickOutfit(), gate: rand(), phase: rand() * 1000, lat: 0.2 + rand() * 0.5, sy: 0 };
        if (rand() < LOITER) {
          // Duran: kenarın bir noktasında, yolun kenarında
          const cum = cumulative(e.pts);
          along(e.pts, cum, rand() * e.len, this.tmp);
          const side = rand() < 0.5 ? -1 : 1;
          const x = this.tmp.x - this.tmp.dz * 0.9 * side, z = this.tmp.z + this.tmp.dx * 0.9 * side;
          const still = { pts: [[x, z]] as P2[], cum: [0], legs: [], T: 1, v: 0, minX: x, maxX: x, minZ: z, maxZ: z };
          if (rand() < 0.5) {
            this.peds.push({ ...base, ...still, kind: "phone", sx: x, sz: z, srot: rand() * Math.PI * 2 });
          } else {
            // Sohbet: karşılıklı iki kişi
            const a = rand() * Math.PI * 2, ca = Math.sin(a) * 0.45, sa = Math.cos(a) * 0.45;
            this.peds.push({ ...base, ...still, kind: "chat", sx: x - ca, sz: z - sa, srot: a });
            this.peds.push({ ...base, ...still, kind: "chat", outfit: pickOutfit(), sx: x + ca, sz: z + sa, srot: a + Math.PI });
          }
          continue;
        }
        const v = WALK_MIN + rand() * (WALK_MAX - WALK_MIN);
        const pts = tour(g, rand() < 0.5 ? e.a : e.b, TOUR_MIN + rand() * (TOUR_MAX - TOUR_MIN), rand);
        const cum = cumulative(pts);
        const { legs, T } = schedule(cum[cum.length - 1], v, rand);
        const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
        this.peds.push({
          ...base, kind: "walk", v, pts, cum, legs, T, sx: 0, sz: 0, srot: 0,
          minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs),
        });
      }
    }
    // Banklarda oturanlar
    for (const b of benches) {
      if (rand() >= SIT_SHARE) continue;
      const y = (b.h ?? 0.5) - 0.5 + CHIBI_SEAT_LIFT;
      this.peds.push({
        zone: zoneAt(b.x), kind: "sit", outfit: pickOutfit(), gate: rand(), phase: rand() * 1000, v: 0, lat: 0,
        pts: [[b.x, b.z]], cum: [0], legs: [], T: 1, sx: b.x, sz: b.z, srot: b.rot, sy: y,
        minX: b.x, maxX: b.x, minZ: b.z, maxZ: b.z,
      });
    }
    const n = this.peds.length;
    this.ox = new Float32Array(n);
    this.oz = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.seen = new Int32Array(n).fill(-10);
    this.px = new Float32Array(n).fill(NaN);
    this.pz = new Float32Array(n).fill(NaN);
    this.dist = new Float32Array(n);
    this.cur = new Float32Array(n * REC);
    this.prev = new Float32Array(n * REC);
    this.state = new Uint8Array(n);
    this.fade = new Float32Array(n);
  }

  get count(): number {
    return this.peds.length;
  }

  /** Yayanın `t` (sunucu saati, sn) anındaki temel konumu ve yönü; `moving` yürüyor mu, `act` duraktaki hali. */
  baseAt(i: number, t: number, out: { x: number; z: number; rot: number; moving: boolean; act?: number }): void {
    const p = this.peds[i];
    if (p.kind !== "walk") {
      out.x = p.sx;
      out.z = p.sz;
      out.rot = p.srot;
      out.moving = false;
      out.act = 0;
      return;
    }
    const u = (((t + p.phase) % p.T) + p.T) % p.T;
    let lo = 0, hi = p.legs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p.legs[mid].t0 <= u) lo = mid;
      else hi = mid - 1;
    }
    const leg = p.legs[lo];
    const moving = leg.s0 !== leg.s1;
    const dir = leg.s1 >= leg.s0 ? 1 : -1;
    const s = moving ? leg.s0 + dir * (u - leg.t0) * p.v : leg.s0;
    // Durakta: son yürüdüğü yöne bakar (ilk durakta ileri)
    const facing = moving ? dir : lo > 0 ? (p.legs[lo - 1].s1 >= p.legs[lo - 1].s0 ? 1 : -1) : 1;
    along(p.pts, p.cum, Math.min(p.cum[p.cum.length - 1], Math.max(0, s)), this.tmp);
    const dx = this.tmp.dx * facing, dz = this.tmp.dz * facing;
    // Yönün sağına (sağdan yürü)
    out.x = this.tmp.x - dz * p.lat;
    out.z = this.tmp.z + dx * p.lat;
    out.rot = Math.atan2(dx, dz);
    out.moving = moving;
    out.act = moving ? 0 : leg.act;
  }

  /** Sunucu duyurdu: araba çarptı. `time` yerel saat (sn). */
  hit(id: number, vx: number, vz: number, time: number): string | null {
    if (!(id >= 0 && id < this.peds.length) || this.peds[id].kind === "sit") return null;
    const cur = this.down.get(id);
    if (cur && time - cur.at < UP_T) return null;
    this.down.set(id, { at: time, vx, vz });
    return HIT_LINES[Math.floor(Math.random() * HIT_LINES.length)];
  }

  /** Konuşma balonunun yeri (yaya bu kare çizildiyse). */
  anchor(id: number): { x: number; z: number; y: number } | null {
    const x = this.px[id], z = this.pz[id];
    return id >= 0 && id < this.peds.length && this.seen[id] === this.frame && !Number.isNaN(x) ? { x, z, y: 0 } : null;
  }

  /**
   * Benzetim adımı (FixedStep, ~30 Hz): `serverMs` ortak saat, `time` yerel animasyon saati (sn), `dt` adımın süresi,
   * `hour` dünyanın saati, `mul` kalabalık çarpanı (0 kapalı). Yakındakilerin yerini, tepkisini ve pozunu kaydeder
   * (çizim `draw` ile); arabanla çarptığın yayayı `send` ile bildirir. `taken`: oyuncuların oturduğu yerler
   * (bankta üst üste binmesinler).
   */
  step(
    crowd: CrowdRenderer,
    serverMs: number,
    time: number,
    dt: number,
    cam: { x: number; z: number },
    hour: number,
    mul: number,
    movers: Mover[],
    myCar: MyCar | null,
    lowPower: boolean,
    send: (ev: ClientEvent) => void,
    taken: { x: number; z: number }[] = [],
  ): void {
    this.frame++;
    if (!crowd.ready || mul <= 0) {
      this.order.length = 0;
      return;
    }
    const t = serverMs / 1000;
    const R = lowPower ? DRAW_R_LOW : DRAW_R, maxDrawn = lowPower ? MAX_DRAWN_LOW : MAX_DRAWN;
    const dens: Record<Zone, number> = { village: zoneDensity("village", hour) * mul, city: zoneDensity("city", hour) * mul, hood: zoneDensity("hood", hour) * mul };
    const base = { x: 0, z: 0, rot: 0, moving: false, act: 0 };
    // Görünür ve yakın olanlar, yakından uzağa
    this.order.length = 0;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (dens[p.zone] - p.gate <= 0) continue;
      if (cam.x < p.minX - R || cam.x > p.maxX + R || cam.z < p.minZ - R || cam.z > p.maxZ + R) continue;
      this.baseAt(i, t, base);
      const d = Math.hypot(base.x - cam.x, base.z - cam.z);
      if (d > R) continue;
      if (p.kind === "sit" && taken.some((q) => Math.abs(q.x - p.sx) < 0.5 && Math.abs(q.z - p.sz) < 0.5)) continue;
      this.dist[i] = d;
      this.order.push(i);
    }
    this.order.sort((a, b) => this.dist[a] - this.dist[b]);
    if (this.order.length > maxDrawn) this.order.length = maxDrawn;

    const k = 1 - Math.exp(-dt * 4);
    for (const i of this.order) {
      const p = this.peds[i];
      this.baseAt(i, t, base);
      // Belirip kaybolma: yoğunluk eşiğe yakınken küçülerek
      const fade = Math.min(1, (dens[p.zone] - p.gate) / 0.06) * Math.min(1, (R - this.dist[i]) / 6);
      // Tepkiler: oyuncuya yol ver, arabadan kaç, el sallayana el salla (oturan yalnızca el sallar)
      let tx = 0, tz = 0, run = false, waveAt: Mover | null = null;
      for (const m of movers) {
        const dx = base.x - m.x, dz = base.z - m.z, d = Math.hypot(dx, dz);
        if (m.wave && d < 7) waveAt = m;
        if (p.kind === "sit") continue;
        if (m.speed > 4 && d < 8) {
          // Yaklaşan arabanın yolundan yana çekil
          const sp = m.speed, ux = m.vx / sp, uz = m.vz / sp;
          // Yalnızca arabanın yolundaysa (önünde ve şeridinde): kaldırımda yanından geçen araba kaçırtmaz
          const lateral = dx * -uz + dz * ux;
          if (dx * ux + dz * uz > -1.5 && Math.abs(lateral) < 2.6) {
            const side = lateral >= 0 ? 1 : -1;
            const want = 2.6 * (1 - d / 8);
            tx += -uz * side * want;
            tz += ux * side * want;
            run = true;
          }
        } else if (d < 1.4 && d > 1e-3) {
          tx += (dx / d) * (1.4 - d) * 0.8;
          tz += (dz / d) * (1.4 - d) * 0.8;
        }
      }
      // Uzun süredir görünmüyorduysa eski kayma kalmasın (belirirken sıçramasın)
      if (this.seen[i] < this.frame - 1) this.ox[i] = this.oz[i] = 0;
      // Kayma yürüyerek/koşarak olur: hızı sınırlı (ışınlanır gibi yana atlamasın)
      {
        const ex = (tx - this.ox[i]) * k * 2, ez = (tz - this.oz[i]) * k * 2, e = Math.hypot(ex, ez);
        const max = (run ? 3.2 : 1.1) * dt;
        const f = e > max ? max / e : 1;
        this.ox[i] += ex * f;
        this.oz[i] += ez * f;
      }
      let x = base.x + this.ox[i], z = base.z + this.oz[i];
      let want = base.rot, moving = base.moving || run;
      if (waveAt && !run && p.kind !== "sit") {
        want = Math.atan2(waveAt.x - x, waveAt.z - z);
        moving = false;
      }
      const fresh = this.seen[i] < this.frame - 1;
      if (fresh) this.rot[i] = want;
      const dr = Math.atan2(Math.sin(want - this.rot[i]), Math.cos(want - this.rot[i]));
      this.rot[i] += dr * Math.min(1, dt * 5);
      this.seen[i] = this.frame;

      // Araba çarptı: geriye savrulur, yatar, kalkar
      let fall = 0, y = p.kind === "sit" ? p.sy : p.zone === "village" ? 0 : 0.06;
      const dn = this.down.get(i);
      const ft = dn ? time - dn.at : -1;
      if (dn && ft < UP_T) {
        const sp = Math.hypot(dn.vx, dn.vz) || 1, f = Math.min(8, sp * 0.5);
        const u = Math.min(ft, FLY_T) / FLY_T, push = f * (1 - (1 - u) * (1 - u)) * 0.6;
        x += (dn.vx / sp) * push;
        z += (dn.vz / sp) * push;
        // Arabaya dönük düşer (sırtüstü)
        this.rot[i] = Math.atan2(-dn.vx, -dn.vz);
        fall = ft < FLY_T ? 1.45 * u : ft < LIE_T ? 1.45 : 1.45 * Math.max(0, 1 - (ft - LIE_T) / (UP_T - LIE_T));
        y += ft < FLY_T ? Math.sin(u * Math.PI) * 0.35 : 0.08;
        moving = false;
        // Kalkınca bulunduğu yerden yoluna yavaşça döner
        if (ft > LIE_T) {
          this.ox[i] = x - base.x;
          this.oz[i] = z - base.z;
        }
      } else if (dn) this.down.delete(i);

      // Arabanla çarptın mı: sunucuya bildir (o herkese duyurur)
      if (myCar && p.kind !== "sit" && Math.abs(myCar.v) > HIT_SPEED && !dn && time - (this.lastHit.get(i) ?? -Infinity) > HIT_COOLDOWN) {
        const [fx, fz, bx, bz] = carCircles(myCar.x, myCar.z, myCar.rot);
        const r = CAR_HULL_R + 0.3;
        if (Math.hypot(x - fx, z - fz) < r || Math.hypot(x - bx, z - bz) < r) {
          this.lastHit.set(i, time);
          const vx = Math.sin(myCar.rot) * myCar.v, vz = Math.cos(myCar.rot) * myCar.v;
          send({ t: "pedhit", id: i, vx: Math.round(vx * 10) / 10, vz: Math.round(vz * 10) / 10 });
        }
      }

      // Kayıt: önceki adım (yeni beliren ya da sıçrayan yaya ara değerlenmez), son adım, poz durumu
      const o = i * REC, c = this.cur, pv = this.prev;
      const jump = fresh || Math.abs(c[o] - x) + Math.abs(c[o + 2] - z) > 3;
      for (let r = 0; r < REC; r++) pv[o + r] = c[o + r];
      c[o] = x;
      c[o + 1] = y;
      c[o + 2] = z;
      c[o + 3] = this.rot[i];
      c[o + 4] = fall;
      if (jump) for (let r = 0; r < REC; r++) pv[o + r] = c[o + r];
      this.state[i] =
        (moving ? S_MOVING : 0) | (run ? S_RUN : 0) | (waveAt && !run && !fall ? S_WAVE : 0) |
        ((p.kind === "phone" || (base.act === 1 && !moving)) && !fall ? S_PHONE : 0);
      this.fade[i] = 0.3 + 0.7 * Math.max(0, fade);
    }
  }

  /**
   * Kare başına: son adımda seçilen yayalar son iki adımın arasında (`alpha` 0 önceki, 1 son adım) kalabalık
   * çizicisine itilir; kol-bacak salınımı ve bakınma kare saatiyle (`time`).
   */
  draw(crowd: CrowdRenderer, time: number, alpha: number, cam: { x: number; z: number }): void {
    crowd.begin(cam.x, cam.z);
    const c = this.cur, pv = this.prev;
    for (const i of this.order) {
      const p = this.peds[i];
      const o = i * REC;
      const x = lerp(pv[o], c[o], alpha), y = lerp(pv[o + 1], c[o + 1], alpha), z = lerp(pv[o + 2], c[o + 2], alpha);
      const rot = lerpAngle(pv[o + 3], c[o + 3], alpha), fall = lerp(pv[o + 4], c[o + 4], alpha);
      this.px[i] = x;
      this.pz[i] = z;
      const st = this.state[i];
      const moving = (st & S_MOVING) !== 0, run = (st & S_RUN) !== 0;
      // Adımlar hıza uyar (kaymasın); koşarken sık ve geniş
      const po = this.pose;
      const stepHz = run ? 9 : 2.4 * p.v + 1.2;
      po.swing = moving ? Math.sin(time * stepHz + p.phase) * (run ? 0.7 : 0.38) : 0;
      po.seated = p.kind === "sit";
      po.wave = st & S_WAVE ? 1 : 0;
      po.phone = st & S_PHONE ? 1 : 0;
      if ((p.kind === "chat" || p.kind === "sit") && !fall) po.swing = Math.sin(time * 1.3 + p.phase) * 0.1 * (p.kind === "sit" ? 0 : 1);
      // Dururken ara ara etrafına bakar (gövde hafifçe döner)
      const look = !moving && !fall && p.kind !== "sit" ? Math.sin(time * 0.5 + p.phase) * 0.35 : 0;
      const bob = moving ? Math.abs(Math.sin(time * stepHz + p.phase)) * 0.04 : 0;
      crowd.push(p.outfit, x, y + bob, z, rot + look, po, time, fall, this.fade[i]);
    }
    crowd.end();
  }
}
