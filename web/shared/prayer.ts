// İstanbul namaz vakitleri (gökbilimsel hesap, Diyanet parametreleri: imsak 18°, yatsı 17°, ikindi gölge
// boyu 1; güneş −7, öğle +5, ikindi +4, akşam +7 dk temkin) ve vakit pencereleri. Sunucu (bir vakit bir
// kez) ve istemci (ezan, pano) aynı hesabı kullanır.

const LAT = 41.0082;
const LON = 28.9784;
/** Türkiye saati UTC+3 (yaz saati yok). */
const TZ = 3;
const DEG = Math.PI / 180;

export type VakitKey = "sabah" | "ogle" | "ikindi" | "aksam" | "yatsi";

export const VAKIT_NAMES: Record<VakitKey, string> = { sabah: "Sabah", ogle: "Öğle", ikindi: "İkindi", aksam: "Akşam", yatsi: "Yatsı" };
/** Farz rekât sayıları. */
export const REKAT: Record<VakitKey, number> = { sabah: 2, ogle: 4, ikindi: 4, aksam: 3, yatsi: 4 };

/** Günün vakitleri (epoch ms). */
export interface DayTimes {
  imsak: number;
  gunes: number;
  ogle: number;
  ikindi: number;
  aksam: number;
  yatsi: number;
}

/** Türkiye takvim günü (UTC+3) için gece yarısının epoch ms'i. */
function dayStart(now: number): number {
  const t = now + TZ * 3600_000;
  return t - (((t % 86_400_000) + 86_400_000) % 86_400_000) - TZ * 3600_000;
}

/** Güneşin sapma açısı (derece) ve zaman denklemi (saat), Julian gün için. */
function sun(jd: number): { dec: number; eqt: number } {
  const d = jd - 2451545.0;
  const g = (357.529 + 0.98560028 * d) % 360;
  const q = (280.459 + 0.98564736 * d) % 360;
  const l = (q + 1.915 * Math.sin(g * DEG) + 0.02 * Math.sin(2 * g * DEG)) % 360;
  const e = 23.439 - 0.00000036 * d;
  const ra = Math.atan2(Math.cos(e * DEG) * Math.sin(l * DEG), Math.cos(l * DEG)) / DEG / 15;
  const dec = Math.asin(Math.sin(e * DEG) * Math.sin(l * DEG)) / DEG;
  let eqt = q / 15 - ((ra + 24) % 24);
  eqt = ((eqt + 12) % 24 + 24) % 24 - 12;
  return { dec, eqt };
}

/** Güneşin ufkun `angle` derece altına indiği an ile öğle arasındaki süre (saat). */
function hourAngle(angle: number, dec: number): number {
  const v = (-Math.sin(angle * DEG) - Math.sin(dec * DEG) * Math.sin(LAT * DEG)) / (Math.cos(dec * DEG) * Math.cos(LAT * DEG));
  return Math.acos(Math.max(-1, Math.min(1, v))) / DEG / 15;
}

/** İkindi: gölge boyu (1 + cisim boyu) olduğu an, öğleden sonra (saat). */
function asrAngle(dec: number): number {
  const a = -Math.atan(1 / (1 + Math.tan(Math.abs(LAT - dec) * DEG))) / DEG;
  return hourAngle(a, dec);
}

/** `now`ın düştüğü Türkiye gününün vakitleri. */
export function dayTimes(now: number): DayTimes {
  const start = dayStart(now);
  const jd = start / 86_400_000 + 2440587.5 + 0.5;
  const { dec, eqt } = sun(jd);
  const noon = 12 + TZ - LON / 15 - eqt;
  const at = (h: number, adjMin = 0) => start + h * 3600_000 + adjMin * 60_000;
  return {
    imsak: at(noon - hourAngle(18, dec)),
    gunes: at(noon - hourAngle(0.833, dec), -7),
    ogle: at(noon, 5),
    ikindi: at(noon + asrAngle(dec), 4),
    aksam: at(noon + hourAngle(0.833, dec), 7),
    yatsi: at(noon + hourAngle(17, dec)),
  };
}

export interface Vakit {
  key: VakitKey;
  /** Bu vaktin kimliği (gün + vakit): bir vakit kişi başı bir kez kılınır. */
  id: string;
  start: number;
  end: number;
}

const dayId = (ms: number) => new Date(ms + TZ * 3600_000).toISOString().slice(0, 10);

/** O an girmiş vakit (güneş doğduktan öğleye kadar yok: null). Yatsı ertesi günün imsakına kadar sürer. */
export function currentVakit(now: number): Vakit | null {
  const t = dayTimes(now);
  const prev = dayTimes(now - 86_400_000);
  const next = dayTimes(now + 86_400_000);
  const windows: [VakitKey, number, number][] = [
    ["yatsi", prev.yatsi, t.imsak],
    ["sabah", t.imsak, t.gunes],
    ["ogle", t.ogle, t.ikindi],
    ["ikindi", t.ikindi, t.aksam],
    ["aksam", t.aksam, t.yatsi],
    ["yatsi", t.yatsi, next.imsak],
  ];
  for (const [key, start, end] of windows) if (now >= start && now < end) return { key, id: `${dayId(start)}:${key}`, start, end };
  return null;
}

/** Sıradaki vaktin başlangıcı (ezan) ve adı. */
export function nextVakit(now: number): { key: VakitKey; at: number } {
  const t = dayTimes(now), n = dayTimes(now + 86_400_000);
  const list: [VakitKey, number][] = [["sabah", t.imsak], ["ogle", t.ogle], ["ikindi", t.ikindi], ["aksam", t.aksam], ["yatsi", t.yatsi], ["sabah", n.imsak]];
  for (const [key, at] of list) if (at > now) return { key, at };
  return { key: "sabah", at: n.imsak };
}

/** "13:05" biçiminde Türkiye saati. */
export function clock(ms: number): string {
  return new Date(ms + TZ * 3600_000).toISOString().slice(11, 16);
}
