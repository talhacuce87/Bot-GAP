// GAP Camii: şehrin güneyinde, 466 caddesinin ucunda külliye. Cami kıbleye dönük (İstanbul'dan 151.6°),
// bu yüzden şehrin ızgarasına göre açılı durur. Yerel koordinat: orijin ana kubbenin altı, +z kıble (mihrap),
// −z avlu ve taçkapı. Namazın akışı (rekâtlar, duruşlar) da burada: sunucu süreyi, istemci duruşu buradan alır.
import { REKAT, type VakitKey } from "./prayer";

/** Kıble yönü (dünyada; kuzey −z, doğu +x): İstanbul'dan Kâbe'ye 151.6°. */
const QIBLA_BEARING = 151.6 * (Math.PI / 180);
/** Avatar yönü (rot) kıbleye bakarken: ileri (sin rot, cos rot). */
export const QIBLA_ROT = Math.atan2(Math.sin(QIBLA_BEARING), -Math.cos(QIBLA_BEARING));

/** Külliyenin yürünür alanı (dünya, şehrin güney kenarına bitişik). */
export const MOSQUE_AREA = { minX: 248, maxX: 392, minZ: 40, maxZ: 168 };
/** Ana kubbenin altı (dünya). Taçkapı 466 caddesinin hizasına düşer. */
export const MOSQUE = { x: 342, z: 119 };

const COS = Math.cos(QIBLA_ROT), SIN = Math.sin(QIBLA_ROT);

/** Yerel (lx, lz) → dünya. */
export function mosqueWorld(lx: number, lz: number): { x: number; z: number } {
  return { x: MOSQUE.x + lx * COS + lz * SIN, z: MOSQUE.z - lx * SIN + lz * COS };
}

/** Dünya → yerel. */
export function mosqueLocal(x: number, z: number): { x: number; z: number } {
  const dx = x - MOSQUE.x, dz = z - MOSQUE.z;
  return { x: dx * COS - dz * SIN, z: dx * SIN + dz * COS };
}

/** Harim (namaz salonu) yarı genişliği (iç, duvarın iç yüzü). */
export const HARIM = 15.4;
/** İmamın yeri (mihrabın önü, yerel). */
export const IMAM_SPOT = { x: 0, z: 12.6 };
/** Şadırvan (avlunun ortası, yerel) ve abdest alınan yarıçap. */
export const SADIRVAN = { x: 0, z: -35, r: 4.6 };
/** Abdest bu kadar süre geçerli. */
export const ABDEST_MS = 2 * 3600_000;
/** Cemaatin saf tutması için imam başlattıktan sonra beklenen süre (kamet). */
export const KAMET_MS = 12_000;

/** Harimin içinde mi (dünya). */
export function inHarim(x: number, z: number, pad = 0): boolean {
  const l = mosqueLocal(x, z);
  return Math.abs(l.x) < HARIM - pad && Math.abs(l.z) < HARIM - pad;
}

/** Şadırvanın başında mı. */
export function atSadirvan(x: number, z: number): boolean {
  const l = mosqueLocal(x, z);
  return Math.hypot(l.x - SADIRVAN.x, l.z - SADIRVAN.z) < SADIRVAN.r;
}

const SAF_W = 0.95;
const SAF_PER_ROW = 27;
/** `i`. cemaatin yeri (yerel): imamın arkasında saflar, her saf ortadan iki yana dolar. */
export function safSlot(i: number): { x: number; z: number } {
  const row = Math.floor(i / SAF_PER_ROW), k = i % SAF_PER_ROW;
  const side = k % 2 ? 1 : -1, n = Math.ceil(k / 2);
  return { x: side * n * SAF_W, z: IMAM_SPOT.z - 1.9 - row * 1.7 };
}

// ---------------------------------------------------------------------------
// Namazın akışı
// ---------------------------------------------------------------------------

export type Posture = "tekbir" | "kiyam" | "ruku" | "kavme" | "secde" | "celse" | "kade" | "selamR" | "selamL";

export const POSTURE_NAMES: Record<Posture, string> = {
  tekbir: "Tekbir",
  kiyam: "Kıyam",
  ruku: "Rükû",
  kavme: "Doğrulma",
  secde: "Secde",
  celse: "Oturuş",
  kade: "Oturuş (tahiyyat)",
  selamR: "Selam",
  selamL: "Selam",
};

export interface Step {
  posture: Posture;
  /** Başlangıç (sn, namazın başından) ve süre. */
  at: number;
  dur: number;
  /** Kaçıncı rekât (1'den). */
  rekat: number;
}

const plans = new Map<number, Step[]>();

/** `rekat` rekâtlık farzın duruşları sırayla. */
export function prayerPlan(rekat: number): Step[] {
  let p = plans.get(rekat);
  if (p) return p;
  p = [];
  let at = 0;
  const push = (posture: Posture, dur: number, r: number) => {
    p!.push({ posture, at, dur, rekat: r });
    at += dur;
  };
  for (let r = 1; r <= rekat; r++) {
    if (r === 1) push("tekbir", 1.6, r);
    push("kiyam", r === 1 ? 7 : 6, r);
    push("ruku", 3.5, r);
    push("kavme", 1.6, r);
    push("secde", 3, r);
    push("celse", 1.6, r);
    push("secde", 3, r);
    if (r === rekat) {
      push("kade", 8, r);
      push("selamR", 1.8, r);
      push("selamL", 1.8, r);
    } else if (r === 2) push("kade", 5, r);
  }
  plans.set(rekat, p);
  return p;
}

/** Namazın toplam süresi (sn). */
export function prayerLength(rekat: number): number {
  const p = prayerPlan(rekat), last = p[p.length - 1];
  return last.at + last.dur;
}

export function rekatOf(key: VakitKey): number {
  return REKAT[key];
}

/** `t` sn'deki duruş ve bir öncekine geçişin ağırlığı (0 önceki → 1 şimdiki). */
export function postureAt(rekat: number, t: number): { step: Step; prev: Posture; k: number } | null {
  const p = prayerPlan(rekat);
  if (t < 0 || t >= prayerLength(rekat)) return null;
  let i = 0;
  while (i + 1 < p.length && p[i + 1].at <= t) i++;
  const prev = i ? p[i - 1].posture : "kiyam";
  const u = Math.min(1, (t - p[i].at) / 0.55);
  return { step: p[i], prev, k: u * u * (3 - 2 * u) };
}
