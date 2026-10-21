// Yardımlı vuruş (arcade futbol oyunlarındaki gibi): yön kameradan değil oyuncunun baktığı/koştuğu yönden
// gelir; kaleye aşağı yukarı dönükse şut kendiliğinden kalecinin uzak köşesine nişan alır.
import { PITCH } from "./zones";

/** Bu açıdan (radyan) fazla sapmışsa nişan yardımı yok: baktığı yöne vurur. */
const ASSIST_MAX = 1.25;
/** Bu açının içinde tam yardım (köşeye kilitlenir), ASSIST_MAX'a doğru azalır. */
const ASSIST_FULL = 0.7;
/** Kaleye bu kadar yakınken kısa dokunuş pas değil plase şut. */
export const FINISH_RANGE = 12;

/** İki açının farkı (-π…π). */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Hücum edilen kale: maçta takıma göre (kırmızı batıyı savunur, doğuya atar); maç yoksa baktığı yöne
 * daha yakın olan kale. -1 batı, 1 doğu.
 */
export function attackSide(team: 0 | 1 | null, x: number, z: number, facing: number): -1 | 1 {
  if (team !== null) return team === 0 ? 1 : -1;
  const east = Math.abs(angleDiff(facing, Math.atan2(PITCH.x + PITCH.hx - x, PITCH.z - z)));
  const west = Math.abs(angleDiff(facing, Math.atan2(PITCH.x - PITCH.hx - x, PITCH.z - z)));
  return east <= west ? 1 : -1;
}

/** Topun kaleye uzaklığı ve kaleye dönüklük (açı farkı). */
export function goalView(side: -1 | 1, x: number, z: number, facing: number): { dist: number; off: number } {
  const gx = PITCH.x + side * PITCH.hx;
  return { dist: Math.hypot(gx - x, PITCH.z - z), off: Math.abs(angleDiff(facing, Math.atan2(gx - x, PITCH.z - z))) };
}

/**
 * Şutun yönü: kaleye dönükse kalecinin uzak köşesine (kaleci bilinmiyorsa baktığı tarafa yakın köşeye),
 * yardım kale açısından uzaklaştıkça azalır; kaleye arkası dönükse baktığı yön.
 */
export function assistedShot(side: -1 | 1, bx: number, bz: number, facing: number, keeperZ: number | null): number {
  const gx = PITCH.x + side * PITCH.hx;
  const center = Math.atan2(gx - bx, PITCH.z - bz);
  const off = Math.abs(angleDiff(facing, center));
  if (off > ASSIST_MAX) return facing;
  const inset = PITCH.goalHalf - 0.55;
  const corners = [PITCH.z - inset, PITCH.z + inset].map((z) => Math.atan2(gx - bx, z - bz));
  let target: number;
  if (keeperZ !== null && Math.abs(keeperZ - PITCH.z) > 0.25) target = keeperZ > PITCH.z ? corners[0] : corners[1];
  else target = Math.abs(angleDiff(facing, corners[0])) < Math.abs(angleDiff(facing, corners[1])) ? corners[0] : corners[1];
  const k = off <= ASSIST_FULL ? 1 : 1 - (off - ASSIST_FULL) / (ASSIST_MAX - ASSIST_FULL);
  return facing + angleDiff(target, facing) * k;
}
