// Otoyol: sonsuz düz, çift yönlü yol. Şeritler, trafik, sürüş fiziği, makas puanı ve kaza kuralları. Saf mantık:
// istemci kendi arabasını bununla sürer. Trafik tohumdan ve saatten hesaplanır (herkes aynı arabayı aynı yerde
// görür, ağ trafiği yok); trafik arabaları şeritlerinden çıkmaz, çarpışmada itilen hep oyuncudur.
// Eksenler Tofaş'ın yereli gibi: +z gidiş yönü, +x sol. Gidiş şeritleri x < 0 (sağda), karşı şeritler x > 0.
// Yön açısı a: ileri (sin a, cos a); a > 0 sola.
import { CAR_HULL_OFFSET, CAR_HULL_R, carCircles } from "./car";

export const HW = {
  laneW: 3.6,
  /** Ortadaki çift sarı çizginin yarı genişliği (engel yok: karşı şeride geçilir). */
  median: 0.3,
  /** Bariyer orta çizgiden bu kadar uzakta (iki şerit + emniyet şeridi). */
  rail: 0.3 + 2 * 3.6 + 2.2,
  /** Arabanın yarı genişliği (Tofaş 1,64 m) ve boyu. */
  halfW: 0.82,
  length: 4.34,
  /** En yüksek hız (m/sn, ~180 km/s), ivme, fren. */
  vmax: 50,
  accel: 8.5,
  brake: 17,
  /** Yana en çok bu hızla kayar (m/sn): şerit değiştirmek hızdan bağımsız ~0,6 sn. */
  latMax: 6.5,
  maxYaw: 0.42,
  /** Bu yaklaşma hızının (m/sn) üstündeki temas sert kazadır; altı sürtme/ittirme. */
  hard: 7.5,
  /** Bariyere bu yan hızın üstünde girmek kazadır. */
  hardRail: 12,
  /** Doğunca (ve tekrar başlayınca) çarpışmasız süre (sn). */
  ghost: 2,
  /** Puan bu hızın altında sayılmaz (m/sn, ~58 km/s). */
  scoreV: 16,
  /** Makasların kombo sayılması için en çok bu kadar arayla gelmesi gerekir (sn). */
  comboGap: 4,
};

/** Şeritler: orta x ve trafiğin hızı (eksi: karşıdan gelen). 0–1 gidiş (sol hızlı), 2–3 karşı. */
export const LANES = [
  { x: -(HW.median + HW.laneW * 0.5), v: 25 },
  { x: -(HW.median + HW.laneW * 1.5), v: 19 },
  { x: HW.median + HW.laneW * 0.5, v: -23 },
  { x: HW.median + HW.laneW * 1.5, v: -18 },
];

/** Bir şeritte arabaların yer aldığı aralık (m); her yuvada araba olabilir ya da olmayabilir. */
const SLOT = 24;
/** Yuva içinde kayma: iki araba arasında en az ~4 m kalır. */
const JITTER = SLOT - 10;

export interface TrafficCar {
  id: number;
  lane: number;
  x: number;
  z: number;
  /** Hız (m/sn, +z yönünde). */
  v: number;
  /** Görünüm (istemci TRAFFIC_LOOKS'tan seçer). */
  look: number;
}

/** Tamsayı karması → [0, 1). */
function hash(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(b ^ 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Yuvalar boyunca yavaş değişen yoğunluk: seyrek ve sıkışık bölümler sırayla gelir. */
function density(seed: number, lane: number, k: number): number {
  const u = k / 9, i = Math.floor(u), f = u - i, s = f * f * (3 - 2 * f);
  const n = hash(seed, lane + 100, i) * (1 - s) + hash(seed, lane + 100, i + 1) * s;
  return (lane < 2 ? 0.42 : 0.34) + (n - 0.5) * 0.5;
}

/** `t` anında (sn) [zMin, zMax] aralığındaki trafik arabaları. */
export function trafficAt(seed: number, t: number, zMin: number, zMax: number, out: TrafficCar[] = []): TrafficCar[] {
  out.length = 0;
  for (let lane = 0; lane < LANES.length; lane++) {
    const { x, v } = LANES[lane];
    const shift = v * t;
    const k0 = Math.floor((zMin - shift - JITTER / 2) / SLOT), k1 = Math.ceil((zMax - shift + JITTER / 2) / SLOT);
    for (let k = k0; k <= k1; k++) {
      if (hash(seed, lane, k) >= density(seed, lane, k)) continue;
      const z = k * SLOT + (hash(seed, lane + 10, k) - 0.5) * JITTER + shift;
      if (z < zMin || z > zMax) continue;
      out.push({ id: k * 4 + lane, lane, x, z, v, look: Math.floor(hash(seed, lane + 20, k) * 1e6) });
    }
  }
  return out;
}

export interface HwCar {
  x: number;
  z: number;
  a: number;
  /** İleri hız (m/sn, geri gitmez). */
  v: number;
  /** Çarpışmadan kalan yana itme hızı (sönümlenir). */
  px: number;
  /** Hasar (0–100); 100'de oyun biter. */
  damage: number;
  alive: boolean;
  /** Kalan çarpışmasız süre (sn). */
  ghost: number;
  /** Kazada savrulma (rad/sn). */
  spin: number;
}

export interface HwInput {
  /** Gaz ve fren 0–1; direksiyon −1 sol … 1 sağ (joystick'in moveX'i). */
  gas: number;
  brake: number;
  steer: number;
}

/** Sağdaki gidiş şeridinde, şeridin hızıyla doğar. */
export function newCar(z = 0): HwCar {
  return { x: LANES[1].x, z, a: 0, v: LANES[1].v, px: 0, damage: 0, alive: true, ghost: HW.ghost, spin: 0 };
}

/** Karşı şeritte mi (orta çizginin solunda). */
export const wrongWay = (c: HwCar) => c.x > HW.median;

export type HwEvent =
  | { k: "near"; tier: number; pts: number; combo: number; gap: number; side: number; oncoming: boolean }
  | { k: "bump"; impact: number }
  | { k: "rail"; impact: number }
  | { k: "crash"; impact: number };

/**
 * Makas dereceleri: gövdeler arası boşluk (m) en çok bu kadarsa; taban puan. İki araba kendi şeritlerinin
 * ortasındayken boşluk ~1,96 m: yan şeritteki arabayı geçmek en az "MAKAS"tır, çizgiye yaklaştıkça artar.
 */
export const TIERS = [
  { gap: 0.5, name: "KIL PAYI!", pts: 400 },
  { gap: 1.1, name: "ÇOK YAKIN!", pts: 200 },
  { gap: 2.1, name: "MAKAS!", pts: 100 },
];

/** Makas puanı: taban × hız (1–2) × karşı şerit (1,5) × kombo (her makas +0,5, en çok 5). */
export function nearMissPoints(tier: number, v: number, wrong: boolean, combo: number): number {
  const speed = 1 + Math.max(0, Math.min(1, (v - HW.scoreV) / (HW.vmax - HW.scoreV)));
  const mult = Math.min(5, 1 + 0.5 * (combo - 1));
  return Math.round((TIERS[tier].pts * speed * (wrong ? 1.5 : 1) * mult) / 5) * 5;
}

/** Fizik adımı: gaz, fren, direksiyon, itme ve bariyer. Kazadaysa yalnızca yavaşlar ve savrulur. */
export function stepCar(c: HwCar, inp: HwInput, dt: number): HwEvent | null {
  c.px *= Math.exp(-dt * 5);
  if (!c.alive) {
    c.v = Math.max(0, c.v - 18 * dt);
    c.a += c.spin * dt;
    c.spin *= Math.exp(-dt * 1.5);
    c.x += (c.v * Math.sin(c.a) + c.px) * dt;
    c.z += c.v * Math.cos(c.a) * dt;
    c.x = Math.max(-HW.rail + HW.halfW, Math.min(HW.rail - HW.halfW, c.x));
    return null;
  }
  if (inp.gas > 0) c.v += HW.accel * inp.gas * (1 - (c.v / HW.vmax) ** 2) * dt;
  else c.v -= (0.5 + c.v * 0.02) * dt;
  if (inp.brake > 0) c.v -= HW.brake * inp.brake * dt;
  c.v = Math.max(0, Math.min(HW.vmax, c.v));
  // Direksiyon: yön açısı hedefe yumuşakça gider, bırakınca düzelir; yana kayma hızı sınırlı
  const aMax = Math.min(HW.maxYaw, Math.asin(Math.min(1, HW.latMax / Math.max(c.v, 1))));
  const target = -Math.max(-1, Math.min(1, inp.steer)) * aMax;
  c.a += (target - c.a) * (1 - Math.exp(-dt * 7));
  c.x += (c.v * Math.sin(c.a) + c.px) * dt;
  c.z += c.v * Math.cos(c.a) * dt;
  c.ghost = Math.max(0, c.ghost - dt);
  // Bariyer: sürtünce seker ve hasar alır, sert girerse kaza
  const lim = HW.rail - HW.halfW;
  if (Math.abs(c.x) <= lim) return null;
  const side = Math.sign(c.x);
  const vn = Math.max(0, (c.v * Math.sin(c.a) + c.px) * side);
  c.x = side * lim;
  if (vn > HW.hardRail) return crash(c, vn, -side);
  c.px = -side * (vn * 0.4 + 0.6);
  c.a *= 0.3;
  c.v *= 1 - Math.min(0.25, vn * 0.025 + dt * 0.5);
  c.damage = Math.min(100, c.damage + vn * 2.5 + dt * 6);
  if (c.damage >= 100) return crash(c, vn, -side);
  return { k: "rail", impact: vn };
}

function crash(c: HwCar, impact: number, dir: number): HwEvent {
  c.alive = false;
  c.damage = 100;
  c.spin = (dir || 1) * Math.min(5, 1.5 + impact * 0.08);
  return { k: "crash", impact };
}

/** Çarpışma sonucu: hangi arabaya, ne kadar sert. */
export interface Contact {
  id: number;
  ev: HwEvent;
}

const R2 = 2 * CAR_HULL_R;

/**
 * Trafikle çarpışma: gövde daireleri (önde ve arkada birer) üst üste binerse yaklaşma hızına bakılır. Yavaşsa
 * araba dışarı itilir ve hasar alır; hızlıysa (arkadan bindirme, kafa kafaya) kaza.
 */
export function collide(c: HwCar, cars: TrafficCar[]): Contact | null {
  if (!c.alive || c.ghost > 0) return null;
  const [fx, fz, rx, rz] = carCircles(c.x, c.z, c.a);
  for (const t of cars) {
    if (Math.abs(t.z - c.z) > 6 || Math.abs(t.x - c.x) > 3) continue;
    let best = Infinity, nx = 0, nz = 0, pen = 0;
    for (const [px, pz] of [[fx, fz], [rx, rz]]) {
      for (const qz of [t.z + CAR_HULL_OFFSET, t.z - CAR_HULL_OFFSET]) {
        const dx = px - t.x, dz = pz - qz, d = Math.hypot(dx, dz);
        if (d < R2 && d < best) [best, nx, nz, pen] = [d, dx / (d || 1), dz / (d || 1), R2 - d];
      }
    }
    if (best === Infinity) continue;
    // Yaklaşma hızı: göreli hızın temas normali boyunca bileşeni
    const vx = c.v * Math.sin(c.a) + c.px, vz = c.v * Math.cos(c.a) - t.v;
    const vn = Math.max(0, -(vx * nx + vz * nz));
    c.x += nx * pen;
    c.z += nz * pen;
    if (vn > HW.hard) {
      c.v = Math.max(0, Math.min(c.v, t.v > 0 ? t.v : 0));
      c.px += nx * 4;
      return { id: t.id, ev: crash(c, vn, nx >= 0 ? 1 : -1) };
    }
    const j = vn * 1.4 + 1.2;
    c.px += nx * j;
    c.v = Math.max(0, Math.min(HW.vmax, c.v + nz * j * 0.6));
    c.damage = Math.min(100, c.damage + 6 + vn * 5);
    if (c.damage >= 100) return { id: t.id, ev: crash(c, vn, nx >= 0 ? 1 : -1) };
    return { id: t.id, ev: { k: "bump", impact: vn } };
  }
  return null;
}

interface Pass {
  /** Arabanın önünde görüldü mü (geçilecek araba). */
  ahead: boolean;
  /** Yan yanayken gövdeler arası en küçük boşluk. */
  gap: number;
  /** Değdi: makas sayılmaz. */
  touched: boolean;
  done: boolean;
  /** Son görüldüğü adım. */
  seen: number;
}

export type TrafficSource = (t: number, zMin: number, zMax: number, out: TrafficCar[]) => TrafficCar[];

export interface RunStats {
  score: number;
  /** Gidilen yol (m), en yüksek hız (m/sn), makas sayısı, en uzun kombo, süre (sn). */
  dist: number;
  top: number;
  near: number;
  bestCombo: number;
  time: number;
}

/**
 * Bir sürüş: araba, puan, kombo ve istatistikler. Her adımda trafik sorulur, fizik ve çarpışma işler, önünden
 * yanından geçilen arabalar için makas puanı verilir. Mesafe puanı: 4 m'de bir (karşı şeritte iki katı).
 */
export class HwRun {
  car: HwCar;
  stats: RunStats = { score: 0, dist: 0, top: 0, near: 0, bestCombo: 0, time: 0 };
  combo = 0;
  /** Son makastan beri geçen süre (sn): kombo `comboGap`'te biter. */
  sinceNear = Infinity;
  private passes = new Map<number, Pass>();
  private step = 0;
  private cars: TrafficCar[] = [];

  /** `traffic`: trafik kaynağı (varsayılan tohumdan; testler kendi arabalarını verir). */
  constructor(seed: number, z = 0, private traffic: TrafficSource = (t, a, b, out) => trafficAt(seed, t, a, b, out)) {
    this.car = newCar(z);
  }

  /** Bir adım (`t`: trafik saati, sn). Olaylar sırayla döner. */
  update(inp: HwInput, dt: number, t: number): HwEvent[] {
    const c = this.car, s = this.stats, ev: HwEvent[] = [];
    const z0 = c.z;
    const was = c.alive;
    const e = stepCar(c, inp, dt);
    if (e) ev.push(e);
    const cars = this.traffic(t, c.z - 40, c.z + 60, this.cars);
    const hit = collide(c, cars);
    if (hit) {
      ev.push(hit.ev);
      const p = this.passes.get(hit.id);
      if (p) p.touched = true;
      else this.passes.set(hit.id, { ahead: false, gap: Infinity, touched: true, done: true, seen: this.step });
    }
    // Her temas (araba ya da bariyer) komboyu bozar
    if (ev.length) this.combo = 0;
    if (!was) return ev;
    s.time += dt;
    s.top = Math.max(s.top, c.v);
    const moved = Math.max(0, c.z - z0);
    s.dist += moved;
    if (c.alive && c.v >= HW.scoreV) s.score += (moved / 4) * (wrongWay(c) ? 2 : 1);
    this.sinceNear += dt;
    if (this.sinceNear > HW.comboGap) this.combo = 0;
    if (c.alive) this.passCheck(cars, ev);
    return ev;
  }

  /** Geçilen arabalar: önündeyken görülüp arkada kalan, yan yanayken boşluğu yeterince dar olan makastır. */
  private passCheck(cars: TrafficCar[], ev: HwEvent[]): void {
    const c = this.car, step = ++this.step;
    for (const t of cars) {
      const dz = t.z - c.z;
      let p = this.passes.get(t.id);
      if (!p) this.passes.set(t.id, (p = { ahead: dz > 0, gap: Infinity, touched: false, done: false, seen: step }));
      p.seen = step;
      if (p.done) continue;
      if (dz > 0) p.ahead = true;
      if (Math.abs(dz) < HW.length) {
        p.gap = Math.min(p.gap, Math.abs(t.x - c.x) - 2 * HW.halfW);
        // Çarpışmasızken içinden geçilen araba makas sayılmaz
        if (c.ghost > 0) p.touched = true;
      }
      if (dz > -HW.length * 0.6) continue;
      p.done = true;
      const tier = TIERS.findIndex((x) => p.gap <= x.gap);
      if (!p.ahead || p.touched || tier < 0 || c.v < HW.scoreV) continue;
      this.combo++;
      this.sinceNear = 0;
      const pts = nearMissPoints(tier, c.v, wrongWay(c), this.combo);
      this.stats.score += pts;
      this.stats.near++;
      this.stats.bestCombo = Math.max(this.stats.bestCombo, this.combo);
      ev.push({ k: "near", tier, pts, combo: this.combo, gap: Math.max(0, p.gap), side: Math.sign(t.x - c.x), oncoming: t.v < 0 });
    }
    // Görüş alanından çıkanları unut
    if (step % 60 === 0) for (const [id, p] of this.passes) if (step - p.seen > 120) this.passes.delete(id);
  }
}
