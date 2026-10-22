// Voleybol (Volleyball 4.2 tarzı): top sunucuda (tek otorite), istemci aynı fizikle (vStep) araya çizer.
// Vuruşlar (manşet, pas, smaç, dump, servis) topu bir yaya oturtur: hedef nokta oyuncunun baktığı yönde,
// uzaklığı güç seviyesine (1–15; Q/E, Z/X/C) göre; havada W öne yatıp yakına, S geriye yatıp uzağa vurur. File
// sahanın ortasında (x ekseninde); batı yarı kırmızı (0), doğu yarı mavi (1). Servis: top ele alınır, havaya
// atılır, düşerken vurulur (havadayken smaç servis); düşük güçte (1–3) alttan falsolu, top yana kıvrılarak yine
// nişan alınan yere iner.
import { VOLLEY_COURT, VOLLEY_HALL } from "./zones";

export const V_BALL_R = 0.22;
/** Biraz süzülür (gerçek 9.8): oyuncu topun altına yetişebilsin. */
export const V_GRAVITY = 8;
/** Filenin üst kenarı ve genişliği (yarı; direkler saha kenarının dışında). */
export const NET_TOP = 2.43;
export const NET_HALF = VOLLEY_COURT.hz + 0.6;
export const POWER_MIN = 1;
export const POWER_MAX = 15;
/** Bu güce kadar servis alttan falsolu; manşet ve pas daha yüksek ve yavaş. */
export const LOB_POWER = 3;
/** Bu güçten sert vuruşta topun arkasında rüzgar izi. */
export const WIND_POWER = 12;
/** Takımda en fazla oyuncu (altı pozisyon); bir sette sayı ve fark. */
export const VOLLEY_TEAM_MAX = 6;
export const VOLLEY_TARGETS = [7, 15, 25] as const;
/** Havada A/D ile yana yatınca vuruş ve blok menzili bu kadar yana kayar (m). */
export const LEAN_REACH = 0.8;
/** Havada W/S ile öne/geri yatınca menzil o yana kayar (m) ve vuruş bu oranda yakına/uzağa gider. */
export const PITCH_REACH = 0.5;
export const PITCH_DEPTH = 0.35;
/** Hücum çizgisi fileden bu kadar uzakta: arka sıra oyuncusu bunun önünde zıplayamaz. */
export const ATTACK_LINE = VOLLEY_COURT.hx / 3;
/** Falsonun topu yana çektiği ivme (m/sn², falso 1 iken). */
const SPIN_ACC = 2.6;
/** Yerdeki topun sekmesi, filede ve duvarda kalan hız. */
const FLOOR_BOUNCE = 0.45;
const NET_BOUNCE = 0.3;
const WALL_BOUNCE = 0.5;

export type VolleyHit = "bump" | "set" | "spike" | "dump" | "serve";
/** Top olayı: vuruş, blok, file, yer, duvar. */
export type VolleyEv = VolleyHit | "block" | "net" | "floor" | "wall";
/** Pas türü (B): normal, yüksek (yavaş, smaççıya zaman), hızlı (alçak, çabuk smaç). */
export type SetType = "normal" | "high" | "quick";
export const SET_TYPES: readonly SetType[] = ["normal", "high", "quick"];
export const SET_NAMES: Record<SetType, string> = { normal: "NORMAL", high: "YÜKSEK", quick: "HIZLI" };

export interface VBall {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Falso: yatay ivme (yere ya da fileye değene kadar). */
  ax?: number;
  az?: number;
}

/** Pozisyonlar: 0–2 ön sıra (fileye yakın), 3–5 arka sıra; her sırada soldan sağa (z: -, 0, +). */
export const SLOT_POS: readonly [number, number][] = [
  [2.6, -4], [2.6, 0], [2.6, 4],
  [8.6, -4], [8.6, 0], [8.6, 4],
];

export interface VolleyState {
  /**
   * free: maç yok (antrenman: G ile top atılır, V ile servis denenir); serve: servis bekleniyor;
   * rally: top oyunda; point: sayı oldu, kısa ara.
   */
  phase: "free" | "serve" | "rally" | "point";
  /** Takımların altı pozisyonu (sid, boşsa 0): 0 kırmızı batı yarı, 1 mavi doğu yarı (bkz. SLOT_POS). */
  teams: [number[], number[]];
  score: [number, number];
  /** Set kaç sayıya (iki fark gerekir); 0 maç yok. */
  target: number;
  /** Servisi atan/atacak oyuncu. */
  server: number;
  /** serve: servis süresinin sonu; point: sonraki servisin başlangıcı. */
  until: number;
  /** Topa son dokunan takım (-1 yok) ve o takımın bu sahadaki dokunuş sayısı. */
  side: -1 | 0 | 1;
  touches: number;
  /** Son sayının açıklaması (ör. "Dışarı", "4 vuruş"). */
  note: string;
}

/** Arka sıra pozisyonu mu (bkz. SLOT_POS). */
export const isBackRow = (slot: number) => slot >= 3;

export const emptyTeams = (): [number[], number[]] => [Array(VOLLEY_TEAM_MAX).fill(0), Array(VOLLEY_TEAM_MAX).fill(0)];

/** Takımdaki oyuncular (boş pozisyonlar hariç). */
export function members(s: VolleyState, team: 0 | 1): number[] {
  return s.teams[team].filter((sid) => sid > 0);
}

/** Vuruşun geçerli olduğu top konumu (oyuncuya göre): yatay uzaklık ve yükseklik aralığı. */
export const REACH: Record<VolleyHit | "dive", { r: number; lo: number; hi: number }> = {
  bump: { r: 1.35, lo: 0, hi: 2.2 },
  set: { r: 1.35, lo: 0.5, hi: 4.4 },
  spike: { r: 1.6, lo: 1.7, hi: 5.3 },
  dump: { r: 1.35, lo: 1.7, hi: 5 },
  serve: { r: 1.8, lo: 0, hi: 4 },
  dive: { r: 2.1, lo: 0, hi: 1.3 },
};

/** `dir` yönüne bakanın sağı (birim vektör, x ve z). */
export function rightOf(dir: number): [number, number] {
  return [-Math.cos(dir), Math.sin(dir)];
}

/** `dir` yönüne bakarken havadaki yatışın (yan `lean`, öne `pitch`; -1..1) menzile kattığı kayma. */
export function leanShift(dir: number, lean: number, pitch: number): [number, number] {
  const [rx, rz] = rightOf(dir);
  return [rx * lean * LEAN_REACH + Math.sin(dir) * pitch * PITCH_REACH, rz * lean * LEAN_REACH + Math.cos(dir) * pitch * PITCH_REACH];
}

/** Servis için havaya atılan top: oyuncunun önünden, olduğu yerden dimdik yukarı (tepe ~4.4 m). */
export function tossBall(b: VBall, x: number, z: number, rot: number): void {
  const dx = Math.sin(rot), dz = Math.cos(rot);
  Object.assign(b, { x: x + dx * 0.45, y: 1.15, z: z + dz * 0.45, vx: dx * 0.2, vy: 7.2, vz: dz * 0.2, ax: 0, az: 0 });
}

/** Nokta hangi yarıda (0 batı, 1 doğu). */
export function halfOf(x: number): 0 | 1 {
  return x < VOLLEY_COURT.x ? 0 : 1;
}

/** Top yere sahanın içinde mi değdi (çizgi içeride sayılır). */
export function inCourt(x: number, z: number): boolean {
  return Math.abs(x - VOLLEY_COURT.x) <= VOLLEY_COURT.hx + V_BALL_R * 0.5 && Math.abs(z - VOLLEY_COURT.z) <= VOLLEY_COURT.hz + V_BALL_R * 0.5;
}

/**
 * Bir adım fizik (yerinde değiştirir): yerçekimi, falso, file (alt kısım duvar gibi, üst kenar halat), salon
 * duvarları ve tavan, yer (seker, sonra yuvarlanır). Bu adımda olan olayı döndürür.
 */
export function vStep(b: VBall, dt: number): "net" | "floor" | "wall" | null {
  const C = VOLLEY_COURT, H = VOLLEY_HALL, R = V_BALL_R;
  let ev: "net" | "floor" | "wall" | null = null;
  const px = b.x - C.x;
  if (b.ax || b.az) {
    b.vx += (b.ax ?? 0) * dt;
    b.vz += (b.az ?? 0) * dt;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  if (b.y > R || b.vy > 0) b.vy -= V_GRAVITY * dt;
  // File
  const nx = b.x - C.x;
  if (Math.abs(b.z - C.z) < NET_HALF) {
    if (b.y < NET_TOP) {
      // Geldiği yarıda kalır
      const side = Math.sign(px) || (b.vx > 0 ? -1 : 1);
      if (side * nx < R) {
        b.x = C.x + side * R;
        if (side * b.vx < 0) {
          b.vx = -b.vx * NET_BOUNCE;
          b.vz *= 0.7;
          ev = "net";
        }
      }
    } else if (b.y < NET_TOP + R) {
      // Üst kenar: halattan seker (top filenin üstünden yuvarlanabilir)
      const dy = b.y - NET_TOP, d = Math.hypot(nx, dy);
      if (d < R && d > 1e-4) {
        const ux = nx / d, uy = dy / d;
        b.x = C.x + ux * R;
        b.y = NET_TOP + uy * R;
        const vn = b.vx * ux + b.vy * uy;
        if (vn < 0) {
          b.vx -= (1 + NET_BOUNCE) * vn * ux;
          b.vy -= (1 + NET_BOUNCE) * vn * uy;
          ev = "net";
        }
      }
    }
  }
  // Duvarlar ve tavan
  const wx = H.hw - 0.3 - R, wz = H.hd - 0.3 - R;
  if (Math.abs(b.x - C.x) > wx) {
    b.x = C.x + Math.sign(b.x - C.x) * wx;
    b.vx = -b.vx * WALL_BOUNCE;
    ev ??= "wall";
  }
  if (Math.abs(b.z - C.z) > wz) {
    b.z = C.z + Math.sign(b.z - C.z) * wz;
    b.vz = -b.vz * WALL_BOUNCE;
    ev ??= "wall";
  }
  if (b.y > H.h - R && b.vy > 0) {
    b.y = H.h - R;
    b.vy = -b.vy * WALL_BOUNCE;
    ev ??= "wall";
  }
  // Yer
  if (b.y <= R) {
    b.y = R;
    if (b.vy < -0.6) {
      b.vy = -b.vy * FLOOR_BOUNCE;
      b.vx *= 0.7;
      b.vz *= 0.7;
      ev = "floor";
    } else {
      b.vy = 0;
      const f = Math.exp(-dt * 2.5);
      b.vx *= f;
      b.vz *= f;
      if (Math.hypot(b.vx, b.vz) < 0.05) b.vx = b.vz = 0;
    }
  }
  // Falso yalnızca ilk uçuşta
  if (ev) b.ax = b.az = 0;
  return ev;
}

/** `t` sn ilerisi (adım adım; `stopAtFloor`: ilk yere değişte durur). */
export function vPredict(b: VBall, t: number, out: VBall, stopAtFloor = false): VBall {
  Object.assign(out, b);
  out.ax = b.ax ?? 0;
  out.az = b.az ?? 0;
  const h = 1 / 120;
  for (let s = 0; s < t; s += h) {
    if (vStep(out, Math.min(h, t - s)) === "floor" && stopAtFloor) break;
  }
  return out;
}

/** (b)'den yatay (tx, tz) noktasına, en yüksek noktası `apex` olan yay. Uçuş süresini döndürür. */
export function arcTo(b: VBall, tx: number, tz: number, apex: number): number {
  const top = Math.max(apex, b.y + 0.15);
  const vy = Math.sqrt(2 * V_GRAVITY * (top - b.y));
  const t = vy / V_GRAVITY + Math.sqrt((2 * (top - V_BALL_R)) / V_GRAVITY);
  const dx = tx - b.x, dz = tz - b.z;
  b.vx = dx / t;
  b.vz = dz / t;
  b.vy = vy;
  return t;
}

/**
 * Falso (`spin` -1..1, artı sağa): top uçuş boyunca yana kıvrılır ama `t` sn sonra yine aynı yere iner
 * (başlangıç hızı ters yöne kaydırılır).
 */
function addSpin(b: VBall, spin: number, t: number): void {
  const s = Math.max(-1, Math.min(1, Number.isFinite(spin) ? spin : 0));
  const h = Math.hypot(b.vx, b.vz);
  if (!s || h < 1e-3) return;
  const [rx, rz] = rightOf(Math.atan2(b.vx, b.vz));
  b.ax = rx * s * SPIN_ACC;
  b.az = rz * s * SPIN_ACC;
  b.vx -= (b.ax * t) / 2;
  b.vz -= (b.az * t) / 2;
}

const clampPower = (p: number) => Math.round(Math.max(POWER_MIN, Math.min(POWER_MAX, Number.isFinite(p) ? p : 8)));

/** Servis türü: havadayken smaç servis (2), yerde 1–3 alttan falsolu (0), 4–15 üstten (1). */
function serveKind(p: number, jump: boolean): 0 | 1 | 2 {
  return jump ? 2 : p <= LOB_POWER ? 0 : 1;
}

/**
 * Vuruşun topa verdiği hız (top `b`nin konumundan). `dir` oyuncunun baktığı yatay yön (radyan, +z'den +x'e),
 * `power` 1–15. `jitter` -1..1 rastgele sapma (sert servis isabeti), `spin` -1..1 falso (alttan servis), `set` pas
 * türü, `depth` uzaklık çarpanı (havada W/S yatışı), `jump` havada vurulan servis. Servis yalnızca karşı yarıya.
 */
export function hitBall(b: VBall, kind: VolleyHit, dir: number, power: number, jitter = 0, spin = 0, set: SetType = "normal", depth = 1, jump = false): void {
  const p = clampPower(power);
  const sx = Math.sin(dir), sz = Math.cos(dir);
  const k = Number.isFinite(depth) ? Math.max(0.5, Math.min(1.5, depth)) : 1;
  const ahead = (L: number) => [b.x + sx * L * k, b.z + sz * L * k] as const;
  b.ax = b.az = 0;
  switch (kind) {
    case "bump": {
      // Manşet (karşılama): 1 güçte yakına, 3 güçte arka sıradan pasörün üstüne (~7 m), daha sert vuruş
      // karşı yarıya gider. Düşük güçte daha yüksek ve yavaş.
      const [tx, tz] = ahead(p <= LOB_POWER ? p * 2.3 : 2.3 * LOB_POWER + (p - LOB_POWER) * 1.2);
      arcTo(b, tx, tz, p <= LOB_POWER ? Math.max(b.y + 3.4, 6) : Math.max(b.y + 2.6, 4.8));
      break;
    }
    case "set": {
      // Pas: smaççının önüne; türü yayın yüksekliğini belirler. Güç azaldıkça daha yüksek ve yavaş, arttıkça
      // alçak ve hızlı.
      const [tx, tz] = ahead(1 + p * 0.5);
      const base = set === "high" ? Math.max(b.y + 3.6, 6.6) : set === "quick" ? Math.max(b.y + 0.8, 3.4) : Math.max(b.y + 2.4, 5.2);
      arcTo(b, tx, tz, Math.max(b.y + 0.5, NET_TOP + 0.6, base + (8 - p) * 0.22));
      break;
    }
    case "dump": {
      // Dump: bloğun üstünden aşırtıp filenin arkasına yavaşça bırakma (blok durduramaz, savunma yetişebilir)
      const [tx, tz] = ahead(2.4 + p * 0.15);
      arcTo(b, tx, tz, Math.max(b.y + 1.3, NET_TOP + 2));
      break;
    }
    case "spike": {
      // Smaç: sert ve aşağı; güç arttıkça hızlı ve derin. Fileye doğruysa en az fileyi aşacak kadar düz
      // (fileden uzakta vuran topu ancak derine, belki dışarı vurabilir).
      const speed = 9 + p * 0.95;
      const vyFor = (L: number) => {
        const t = L / speed;
        return Math.min(1, (V_BALL_R - b.y + 0.5 * V_GRAVITY * t * t) / t);
      };
      let L = (3 + p * 0.5) * k;
      const C = VOLLEY_COURT, dn = sx !== 0 ? (C.x - b.x) / sx : -1;
      if (dn > 0) {
        const tn = dn / speed, clear = NET_TOP + V_BALL_R + 0.12;
        while (L < 28 && b.y + vyFor(L) * tn - 0.5 * V_GRAVITY * tn * tn < clear) L += 0.25;
      }
      b.vx = sx * speed;
      b.vz = sz * speed;
      b.vy = vyFor(L);
      break;
    }
    case "serve": {
      // Karşı yarıya: yerde güç 1–3 alttan falsolu (çok yüksek, güvenli), 4–15 üstten (sertleştikçe sapar);
      // havada smaç servis (hızlı, alçak, riskli)
      const C = VOLLEY_COURT;
      const toward = b.x < C.x ? 1 : -1;
      // Yön en fazla ~35° yana
      const a = Math.atan2(sx, sz), base = toward > 0 ? Math.PI / 2 : -Math.PI / 2;
      let off = a - base;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      const ang = base + Math.max(-0.6, Math.min(0.6, off));
      const sk = serveKind(p, jump);
      const far = sk === 0 ? 3 + p * 1.5 : sk === 1 ? 3.5 + (p - 4) * 0.8 : 4.8 + p * 0.5;
      const into = Math.min(C.hx * 2 - 0.4, far * k) + jitter * (sk === 0 ? 0 : sk === 1 ? (p > 10 ? 0.9 : 0.4) : 1.1);
      const toNet = Math.abs(b.x - C.x);
      const L = (toNet + Math.max(1.5, into)) / Math.max(0.5, Math.abs(Math.sin(ang)));
      const tx = b.x + Math.sin(ang) * L, tz = b.z + Math.cos(ang) * L;
      const t = arcTo(b, tx, tz, sk === 0 ? 7.2 : sk === 1 ? 5.2 : 4.2);
      if (sk === 0) addSpin(b, spin, t);
      break;
    }
  }
}

/** Servis türü adı (güç seviyesine göre; havada smaç servis). */
export function serveName(power: number, jump = false): string {
  return ["Alttan falsolu servis", "Üstten servis", "Smaç servis"][serveKind(clampPower(power), jump)];
}

/** Servisin başlangıç yüksekliği: alttan bel hizasında, üstten başın üstünde, smaç serviste zıplamanın tepesinde. */
export function serveHeight(power: number, jump = false): number {
  return [1.3, 2.5, 3.6][serveKind(clampPower(power), jump)];
}
