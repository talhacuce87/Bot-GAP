// Yeni bölgelerin yerleşimi: istemci (sahne) ve sunucu (mesafe, kurallar) aynı sayıları kullanır.

export interface SeatSpot {
  x: number;
  z: number;
  /** Oturanın baktığı yön (avatar rot). */
  rot: number;
}

// ---- Kahvehane: tavla, satranç, okey masaları ve çay ocağı (meydanın kuzeybatısı) ----
export const KAHVEHANE = { x: -38, z: 24, hw: 7.5, hd: 6 };
export type TableKind = "tavla" | "satranc" | "okey";

export interface TableSpot {
  id: number;
  kind: TableKind;
  x: number;
  z: number;
  seats: SeatSpot[];
}

function seatsAround(x: number, z: number, n: number, r: number): SeatSpot[] {
  // n = 2: batı/doğu karşılıklı; n = 4: dört yan
  const dirs = n === 2 ? [[-1, 0], [1, 0]] : [[0, -1], [1, 0], [0, 1], [-1, 0]];
  return dirs.map(([dx, dz]) => ({ x: x + dx * r, z: z + dz * r, rot: Math.atan2(-dx, -dz) }));
}

export const TABLES: TableSpot[] = [
  { id: 0, kind: "tavla", x: -41.6, z: 21.4, seats: seatsAround(-41.6, 21.4, 2, 0.95) },
  { id: 1, kind: "satranc", x: -34.4, z: 21.4, seats: seatsAround(-34.4, 21.4, 2, 0.95) },
  { id: 2, kind: "okey", x: -38, z: 26.2, seats: seatsAround(-38, 26.2, 4, 1.05) },
  { id: 3, kind: "tavla", x: -33.6, z: 27, seats: seatsAround(-33.6, 27, 2, 0.95) },
];
/** Masanın çevresinde bu yarıçapta duran izleyebilir. */
export const TABLE_WATCH_R = 3.2;

/** Çay ocağı: tezgâhın önünde "Çay söyle". Ocakçı tezgâhın arkasında durur. */
export const TEA_COUNTER = { x: -43.6, z: 27.6, r: 2.4 };
export const TEA_MAKER = { x: -43.6, z: 29.75, rot: Math.PI };

// ---- Futbol sahası: güneyde, mahallenin ötesinde; 40×26 m ----
export const PITCH = { x: -8, z: 72, hx: 20, hz: 13, goalHalf: 3, goalH: 2.2 };
export const BALL_R = 0.32;
/** Topa bu kadar yakın oyuncu topu sürer / şut çekebilir. */
export const KICK_REACH = 1.6;

// ---- Sinema sahnesi ve DJ kabini ----
export const STAGE = { x: 0, z: -46.5, hw: 14, hd: 2.5, h: 0.6 };
/** Sahnede durulabilecek alan (oyuncu merkezi). */
export const STAGE_AREA = { minX: -9, maxX: 9, minZ: -48, maxZ: -44.6 };
/** Sahnenin önünde "Sahneye çık". */
export const STAGE_STEPS = { x: 0, z: -42.6, r: 2.6 };
export const DJ_BOOTH = { x: -16.5, z: -41.2, r: 2.4 };

// ---- Gölette kayık iskelesi ----
export const POND_AREA = { x: 24, z: 56, r: 6.5 };
export const DOCK = { x: 16.6, z: 56, r: 2.2 };
/** Kayık bu yarıçapın içinde kalır. */
export const BOAT_R = 5.4;

/** Sakura Bahçesi (görev: ziyaret). */
export const SAKURA_SPOT = { x: 40, z: -24, r: 11 };
