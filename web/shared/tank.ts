// Tank: istemci ve sunucunun ortak sabitleri ve mermi balistiği.
// Mermiyi sunucu hesaplar (nereye düştüğü, kimi ittiği); istemciler aynı yayı aynı formülle çizer.
// Can/ölüm yok: isabet ve patlama yakındakileri savurur.

import { STEP_UP } from "./constants";

/** Tankın park yeri (sahnede beton zemin ve tabela var). Sürücüsüz uzun süre kalırsa buraya döner. */
export const TANK_PARK = { x: -32, z: -16, h: Math.PI / 2 };
/** Sürücüsüz tank bu kadar süre sonra park yerine döner. */
export const TANK_RETURN_MS = 10 * 60 * 1000;
/** Binmek için tanka en fazla bu kadar yakın olmalı. */
export const TANK_REACH = 4.5;

export const TANK_SPEED = 6.5; // ileri, m/sn (sunucunun yürüme hız sınırının altında)
export const TANK_REVERSE = 3.2;
export const TANK_TURN = 1.4; // gövde dönüşü, rad/sn
export const TURRET_TURN = 2.4; // kule dönüşü, rad/sn
/** Gövde iki daireyle (ön/arka) yaklaşık: çarpışma ve yayanları itmek için. */
export const TANK_HULL_R = 1.25;
export const TANK_HULL_OFFSET = 0.75;

export const FIRE_COOLDOWN_MS = 1500;
/**
 * Namlunun döndüğü mil: kule merkezinin önünde, bu yükseklikte. Namlu ucu milden GUN_LEN ileride.
 * M26 modelinden (client/tank/m26.obj, 1.25 ölçek): mil model (y 0.385, z -0.75), uç z -2.71.
 */
export const GUN_PIVOT_Z = 0.81;
export const MUZZLE_Y = 1.32;
export const GUN_LEN = 2.45;
/** Namlu açısı (rad, yukarı pozitif). Varsayılan neredeyse düz: mermi oyuncu boyunun üstünden aşmaz. */
export const ELEV_MIN = -0.06;
export const ELEV_MAX = 0.25;
export const DEFAULT_ELEV = Math.atan2(1.2, 40);
export const ELEV_TURN = 0.9; // rad/sn
export const SHELL_SPEED = 40; // namlu çıkış hızı
export const SHELL_GRAVITY = 9.8;
/** Doğrudan isabet: merminin oyuncu gövdesine yatay mesafesi ve yükseklik sınırı. */
export const HIT_RADIUS = 0.75;
export const HIT_HEIGHT = 2.0;
/** Patlamanın savurduğu alan ve merkezdeki savrulma hızı (m/sn). */
export const BLAST_RADIUS = 3.6;
export const BLAST_PUSH = 12;

/** Tankın üstüne çıkılır: gövde güvertesi ve kule tepesi (M26 modelinden ölçüldü). */
export const HULL_TOP = 1.0;
export const TURRET_TOP = 1.9;
export const TURRET_R = 0.8;

/**
 * `c` (hullCircles) tankının, ayakları `y`de olan oyuncunun altındaki yüzeyi (yoksa 0).
 * Kule gövde dairelerinin ortasında. `reach`: kenardan taşma payı.
 */
export function tankGround(c: readonly number[], x: number, z: number, reach: number, y = Infinity): number {
  const mx = (c[0] + c[2]) / 2, mz = (c[1] + c[3]) / 2;
  if (TURRET_TOP <= y + STEP_UP && Math.hypot(x - mx, z - mz) <= TURRET_R + reach) return TURRET_TOP;
  if (HULL_TOP > y + STEP_UP) return 0;
  const r = TANK_HULL_R + reach;
  return Math.hypot(x - c[0], z - c[1]) <= r || Math.hypot(x - c[2], z - c[3]) <= r ? HULL_TOP : 0;
}

/** Tankın iki çarpışma dairesinin merkezleri. */
export function hullCircles(x: number, z: number, h: number): [number, number, number, number] {
  const fx = Math.sin(h) * TANK_HULL_OFFSET, fz = Math.cos(h) * TANK_HULL_OFFSET;
  return [x + fx, z + fz, x - fx, z - fz];
}

export function clampElev(e: number): number {
  return Number.isFinite(e) ? Math.min(ELEV_MAX, Math.max(ELEV_MIN, e)) : DEFAULT_ELEV;
}

/**
 * Namlu ucundan yatayda `dist`, dikeyde `rise` metre ötedeki noktayı vuran (alçak yaylı) namlu açısı.
 * Menzil dışındaysa en yüksek açı (en uzak atış).
 */
export function solveElev(dist: number, rise: number): number {
  const v2 = SHELL_SPEED * SHELL_SPEED, g = SHELL_GRAVITY;
  const d = Math.max(dist, 0.5);
  const disc = v2 * v2 - g * (g * d * d + 2 * rise * v2);
  if (disc < 0) return ELEV_MAX;
  return clampElev(Math.atan((v2 - Math.sqrt(disc)) / (g * d)));
}

export interface Shot {
  /** Namlu ucu. */
  x: number;
  y: number;
  z: number;
  /** Atış yönü (yatay birim vektör). */
  dx: number;
  dz: number;
  /** Yatay ve dikey başlangıç hızı. */
  vh: number;
  vy: number;
  /** Uçuş süresi (sn): sonunda patlar. */
  flight: number;
}

/** Atıştan `t` sn sonra merminin konumu. */
export function shellAt(s: Shot, t: number): { x: number; y: number; z: number } {
  return {
    x: s.x + s.dx * s.vh * t,
    y: s.y + s.vy * t - 0.5 * SHELL_GRAVITY * t * t,
    z: s.z + s.dz * s.vh * t,
  };
}

/** Hedef: varsayılan bir yaya (HIT_RADIUS/HIT_HEIGHT); tank savaşında gövde silindiri. */
export interface ShotTarget {
  sid: number;
  x: number;
  z: number;
  r?: number;
  top?: number;
}

/** Mermiyi durduran engel: yarıçap ve yükseklikli silindir (arenadaki siperler). */
export interface ShotObstacle {
  x: number;
  z: number;
  r: number;
  h: number;
}

/**
 * Tankın konumu, kule ve namlu açısından atışı hesaplar: yol boyunca ilk değdiği hedefte ya da
 * engelde, yoksa yerde patlar. `targets`: sürücü hariç. Döner: atış, savrulanlar (hız vektörüyle),
 * doğrudan vurulan (`direct`, yoksa 0) ve patlama noktası.
 * Namlu yukarıdayken mermi baş hizasının üstünden geçer, ancak inerken (ya da yerde) isabet eder.
 * `bound`: dairesel duvar (arena kenarı); dışına taşan alçak mermi duvarda patlar.
 * ponytail: dünyada ağaç/duvar sunucuda yok; mermi onların içinden geçer (arenada siperler var).
 */
export function computeShot(
  tankX: number,
  tankZ: number,
  turret: number,
  targets: ShotTarget[],
  elev = DEFAULT_ELEV,
  obstacles: readonly ShotObstacle[] = [],
  bound?: { r: number; h: number },
): { shot: Shot; hits: { sid: number; vx: number; vz: number }[]; direct: number; end: { x: number; y: number; z: number } } {
  const el = clampElev(elev);
  const dx = Math.sin(turret), dz = Math.cos(turret);
  const reach = GUN_PIVOT_Z + GUN_LEN * Math.cos(el);
  const y = MUZZLE_Y + GUN_LEN * Math.sin(el);
  const vh = SHELL_SPEED * Math.cos(el), vy = SHELL_SPEED * Math.sin(el);
  const ground = (vy + Math.sqrt(vy * vy + 2 * SHELL_GRAVITY * y)) / SHELL_GRAVITY;
  const shot: Shot = { x: tankX + dx * reach, y, z: tankZ + dz * reach, dx, dz, vh, vy, flight: ground };
  let direct = 0;
  const step = 1 / 120;
  search: for (let t = 0; t < ground; t += step) {
    const p = shellAt(shot, t);
    for (const q of targets) {
      if (p.y < (q.top ?? HIT_HEIGHT) && Math.hypot(q.x - p.x, q.z - p.z) < (q.r ?? HIT_RADIUS)) {
        shot.flight = t;
        direct = q.sid;
        break search;
      }
    }
    for (const o of obstacles) {
      if (p.y < o.h && Math.hypot(o.x - p.x, o.z - p.z) < o.r) {
        shot.flight = t;
        break search;
      }
    }
    if (bound && p.y < bound.h && Math.hypot(p.x, p.z) > bound.r) {
      shot.flight = t;
      break;
    }
  }
  const end = shellAt(shot, shot.flight);
  const hits: { sid: number; vx: number; vz: number }[] = [];
  for (const q of targets) {
    const ox = q.x - end.x, oz = q.z - end.z;
    const d = Math.hypot(ox, oz);
    if (d >= BLAST_RADIUS) continue;
    // Tam merkezdeyse atış yönünde savrulur
    const ux = d > 0.05 ? ox / d : dx, uz = d > 0.05 ? oz / d : dz;
    const k = BLAST_PUSH * (1 - d / BLAST_RADIUS * 0.6);
    hits.push({ sid: q.sid, vx: ux * k, vz: uz * k });
  }
  return { shot, hits, direct, end };
}
