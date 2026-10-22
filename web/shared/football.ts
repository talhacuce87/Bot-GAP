// Yardımlı vuruş (arcade futbol oyunlarındaki gibi): yön kameradan değil oyuncunun baktığı/koştuğu yönden
// gelir; kaleye aşağı yukarı dönükse şut kendiliğinden kalecinin uzak köşesine nişan alır.
import { type Field, PITCH } from "./zones";

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
 * daha yakın olan kale. -1 batı, 1 doğu. `F`: saha (salon ya da stadyum).
 */
export function attackSide(team: 0 | 1 | null, x: number, z: number, facing: number, F: Field = PITCH): -1 | 1 {
  if (team !== null) return team === 0 ? 1 : -1;
  const east = Math.abs(angleDiff(facing, Math.atan2(F.x + F.hx - x, F.z - z)));
  const west = Math.abs(angleDiff(facing, Math.atan2(F.x - F.hx - x, F.z - z)));
  return east <= west ? 1 : -1;
}

/** Topun kaleye uzaklığı ve kaleye dönüklük (açı farkı). */
export function goalView(side: -1 | 1, x: number, z: number, facing: number, F: Field = PITCH): { dist: number; off: number } {
  const gx = F.x + side * F.hx;
  return { dist: Math.hypot(gx - x, F.z - z), off: Math.abs(angleDiff(facing, Math.atan2(gx - x, F.z - z))) };
}

/**
 * Şutun yönü: kaleye dönükse kalecinin uzak köşesine (kaleci bilinmiyorsa baktığı tarafa yakın köşeye),
 * yardım kale açısından uzaklaştıkça azalır; kaleye arkası dönükse baktığı yön.
 */
export function assistedShot(side: -1 | 1, bx: number, bz: number, facing: number, keeperZ: number | null, F: Field = PITCH): number {
  const gx = F.x + side * F.hx;
  const center = Math.atan2(gx - bx, F.z - bz);
  const off = Math.abs(angleDiff(facing, center));
  if (off > ASSIST_MAX) return facing;
  const inset = F.goalHalf - 0.55;
  const corners = [F.z - inset, F.z + inset].map((z) => Math.atan2(gx - bx, z - bz));
  let target: number;
  if (keeperZ !== null && Math.abs(keeperZ - F.z) > 0.25) target = keeperZ > F.z ? corners[0] : corners[1];
  else target = Math.abs(angleDiff(facing, corners[0])) < Math.abs(angleDiff(facing, corners[1])) ? corners[0] : corners[1];
  const k = off <= ASSIST_FULL ? 1 : 1 - (off - ASSIST_FULL) / (ASSIST_MAX - ASSIST_FULL);
  return facing + angleDiff(target, facing) * k;
}
