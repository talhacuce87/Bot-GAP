// Bölgelerin yerleşimi: istemci (sahne) ve sunucu (mesafe, kurallar) aynı sayıları kullanır.
//
// Harita (kuzey −z): sinema üstte ortada (x = 0), başlangıç meydanı batıda, kahvehane meydanın kuzeyinde.
// Nehir kuzeybatıdaki gölden güneydeki dağlardan dökülen şelaleye çapraz uzanır, iki köprüyle geçilir.
// Dağların içinde tünelle girilen mağara zindan; nehrin doğusunda kapalı futbol salonu.

/** Başlangıç meydanı (çeşme): oyuncular bunun biraz güneyinde doğar. */
export const PLAZA = { x: -100, z: 62 };
export const SPAWN = { x: PLAZA.x, z: PLAZA.z + 8, rot: Math.PI };

/** Göl: nehrin döküldüğü yer; kayık, balık, ördekler. */
export const LAKE = { x: -84, z: -56, r: 17 };

/**
 * Nehrin orta çizgisi: şelalenin havuzundan göle (x, z). Su yarı genişliği RIVER_HALF, kıyı eğimiyle
 * yatak RIVER_BANK'e kadar uzanır; bunun içine yürünmez (köprüler hariç).
 */
export const RIVER: [number, number][] = [
  [2, 89], [-5, 76], [-14, 62], [-22, 47], [-28, 30], [-33, 14], [-41, 1], [-50, -12], [-58, -25], [-67, -38], [-74, -47],
];
export const RIVER_HALF = 4.2;
export const RIVER_BANK = 6.4;
/** Köprüler: nehrin üzerinde, orta noktaları (yön nehre dik, sahnede hesaplanır). */
export const BRIDGES = [{ x: -50, z: -12 }, { x: -14, z: 62 }];
export const BRIDGE = { half: 8.5, w: 3.4 };

/** Şelale: dağın yüzünden havuza dökülür. `top` döküldüğü yükseklik. */
export const WATERFALL = { x: 2, z: 95.5, top: 13, poolR: 6.5 };

/** Dağların kuzey eteği: x boyunca z (bunun güneyi dağ). Batıda kıvrılıp biter. */
export const MOUNTAIN_EDGE: [number, number][] = [
  [-92, 128], [-84, 104], [-70, 97], [-44, 94], [-18, 95], [2, 97], [20, 93], [36, 91], [62, 92], [92, 90], [140, 94],
];

/** Mağara (dağın içinde, elips) ve ona giden tünel (orta çizgi). */
export const CAVE = { x: 60, z: 128, rx: 22, rz: 12 };
export const TUNNEL: [number, number][] = [[35, 84], [41, 100], [54, 118]];
export const TUNNEL_HALF = 3.2;

export interface SeatSpot {
  x: number;
  z: number;
  /** Oturanın baktığı yön (avatar rot). */
  rot: number;
}

// ---- Kahvehane: tavla, satranç, okey, bilek güreşi masaları ve çay ocağı (meydanın kuzeyi) ----
export const KAHVEHANE = { x: -102, z: 14, hw: 7.5, hd: 6 };
const KX = KAHVEHANE.x, KZ = KAHVEHANE.z;
export type TableKind = "tavla" | "satranc" | "okey" | "bilek";

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

function tableAt(id: number, kind: TableKind, dx: number, dz: number, n: number, r: number): TableSpot {
  return { id, kind, x: KX + dx, z: KZ + dz, seats: seatsAround(KX + dx, KZ + dz, n, r) };
}

export const TABLES: TableSpot[] = [
  tableAt(0, "tavla", -3.6, -2.6, 2, 0.95),
  tableAt(1, "satranc", 3.6, -2.6, 2, 0.95),
  tableAt(2, "okey", 0, 2.2, 4, 1.05),
  tableAt(3, "tavla", 4.4, 3, 2, 0.95),
  // Bilek güreşi: dar masa, karşılıklı iki tabure (dirsekler ortada buluşsun)
  tableAt(4, "bilek", -3.4, 1.2, 2, 0.72),
];
/** Masanın çevresinde bu yarıçapta duran izleyebilir. */
export const TABLE_WATCH_R = 3.2;

/** Çay ocağı: tezgâhın önünde "Çay söyle". Ocakçı tezgâhın arkasında durur. */
export const TEA_COUNTER = { x: KX - 5.6, z: KZ + 3.6, r: 2.4 };
export const TEA_MAKER = { x: KX - 5.6, z: KZ + 5.75, rot: Math.PI };

/**
 * Futbol sahası: merkez, yarı en/boy, kale ağzının yarı genişliği ve yüksekliği. `sidePad`: yan
 * duvarlar (top seker) taç çizgisinin bu kadar dışında (stadyumda panolar çizgiden geride).
 */
export interface Field {
  x: number;
  z: number;
  hx: number;
  hz: number;
  goalHalf: number;
  goalH: number;
  sidePad?: number;
}

// ---- Futbol sahası: nehrin doğusunda, kapalı salonun içinde; 40×26 m ----
export const PITCH: Field = { x: 66, z: 58, hx: 20, hz: 13, goalHalf: 3, goalH: 2.2 };

// ---- Stadyum: dünyanın dışında (kuzeyde, ufkun ardında), yalnızca "!maç" ile ışınlanılan 64×40 m saha ----
// Konumlar ağda ±327 m'ye sığmalı (bkz. protocol quantPos).
export const STADIUM_PITCH: Field = { x: 0, z: -280, hx: 32, hz: 20, goalHalf: 3.66, goalH: 2.44, sidePad: 1.4 };
/** Stadyumda yürünebilen alan (oyuncu merkezi): sahanın çevresi, kale fileleri dahil. */
export const STADIUM = { x: STADIUM_PITCH.x, z: STADIUM_PITCH.z, hw: STADIUM_PITCH.hx + 1.6, hd: STADIUM_PITCH.hz + 1.0 };

/** Nokta stadyumun bulunduğu bölgede mi (dünyadan ayrı; oraya yalnızca ışınlanılır). */
export function inStadium(x: number, z: number): boolean {
  return Math.abs(x - STADIUM.x) < STADIUM.hw + 40 && Math.abs(z - STADIUM.z) < STADIUM.hd + 40;
}

// ---- Voleybol salonu: dünyanın dışında (doğuda, ufkun ardında), menüden ışınlanılan kapalı salon ----
// Saha 16×9 m (chibi ölçeğinde); file sahanın ortasında, x ekseninde (batı yarı kırmızı, doğu yarı mavi).
export const VOLLEY_COURT = { x: 280, z: 0, hx: 12, hz: 6 };
/** Salonun duvarları (yarı ölçüler) ve yüksekliği. */
export const VOLLEY_HALL = { x: VOLLEY_COURT.x, z: VOLLEY_COURT.z, hw: VOLLEY_COURT.hx + 7, hd: VOLLEY_COURT.hz + 7, h: 11 };

/** Nokta voleybol salonunun bulunduğu bölgede mi (oraya yalnızca ışınlanılır). */
export function inVolley(x: number, z: number): boolean {
  return Math.abs(x - VOLLEY_HALL.x) < VOLLEY_HALL.hw + 30 && Math.abs(z - VOLLEY_HALL.z) < VOLLEY_HALL.hd + 30;
}

/** Salonun duvarları (dış kenar yarı ölçüleri) ve yüksekliği. */
export const HALL ={ x: PITCH.x, z: PITCH.z, hw: PITCH.hx + 4.6, hd: PITCH.hz + 5, h: 11, door: 3.4 };
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

// ---- Gölde kayık iskelesi (batı kıyısı) ----
export const POND_AREA = LAKE;
export const DOCK = { x: LAKE.x - LAKE.r - 0.9, z: LAKE.z, r: 2.2 };
/** Kayık bu yarıçapın içinde kalır. */
export const BOAT_R = LAKE.r - 1.1;

/** Sakura Bahçesi (görev: ziyaret): sinemanın doğusunda. Torii, `SAKURA_FROM`dan gelen yola bakar. */
export const SAKURA_SPOT = { x: 56, z: -36, r: 11 };
export const SAKURA_FROM = { x: 10, z: -12 };

/**
 * Oyuncak pist binası: meydandan kahvehaneye giden yolun batısında, kapısı (doğu) yola bakar. İçinde alçak
 * bir platformda oyuncak pist (shared/race.ts birimleri RACE_SCALE ile küçülür).
 */
export const RACE_HOUSE = { x: -116, z: 36, hw: 7.6, hd: 6.2, h: 4.6, door: 1.6 };
export const RACE_SCALE = 0.1;
/** Pist platformunun üstü. */
export const RACE_TRACK_Y = 0.3;

/** LAGER'in mangalı: güneybatıda, dağların eteğindeki ormanda. */
export const GROVE = { x: -112, z: 118 };
/** Şöhret Kürsüsü: meydanın doğusu, yüzü meydana dönük. */
export const FAME = { x: -72, z: 72 };
