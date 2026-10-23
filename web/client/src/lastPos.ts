// Kaldığın yer: dünyadaki son konum tarayıcıda saklanır; oyuna yeniden girince oradan başlarsın (sunucu
// "resume" ile doğrular ve herkese duyurur). Sunucu her deploy'da yeniden başladığı için orada değil, burada.
import { outsideWorld } from "../../shared/constants";
import { inStadium, inVolley } from "../../shared/zones";

const KEY = "gap-last-pos";
/** Bundan eski kayıt kullanılmaz (uzun aradan sonra meydandan başla). */
const MAX_AGE_MS = 30 * 24 * 3600_000;

export interface LastPos {
  x: number;
  z: number;
  rot: number;
}

/** Kaldığın yerden başlanabilir mi: dünyanın içinde, ışınlanılan odalarda değil (sunucu da aynısını ister). */
export function resumable(x: number, z: number): boolean {
  return outsideWorld(x, z) === 0 && !inStadium(x, z) && !inVolley(x, z);
}

export function loadLastPos(now = Date.now()): LastPos | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null") as (LastPos & { at: number }) | null;
    if (!v || ![v.x, v.z, v.rot, v.at].every(Number.isFinite) || now - v.at > MAX_AGE_MS || !resumable(v.x, v.z)) return null;
    return { x: v.x, z: v.z, rot: v.rot };
  } catch {
    return null;
  }
}

export function saveLastPos(p: LastPos, now = Date.now()): void {
  if (!resumable(p.x, p.z)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, rot: Math.round(p.rot * 100) / 100, at: now }));
  } catch {
    // gizli pencere, kapalı depolama: kaydetmeden devam
  }
}
