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

// ---- Kahvehane: tavla, satranç, okey masaları ve çay ocağı (meydanın kuzeyi) ----
export const KAHVEHANE = { x: -102, z: 14, hw: 7.5, hd: 6 };
const KX = KAHVEHANE.x, KZ = KAHVEHANE.z;
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

function tableAt(id: number, kind: TableKind, dx: number, dz: number, n: number, r: number): TableSpot {
  return { id, kind, x: KX + dx, z: KZ + dz, seats: seatsAround(KX + dx, KZ + dz, n, r) };
}

export const TABLES: TableSpot[] = [
  tableAt(0, "tavla", -3.6, -2.6, 2, 0.95),
  tableAt(1, "satranc", 3.6, -2.6, 2, 0.95),
  tableAt(2, "okey", 0, 2.2, 4, 1.05),
  tableAt(3, "tavla", 4.4, 3, 2, 0.95),
];
/** Masanın çevresinde bu yarıçapta duran izleyebilir. */
export const TABLE_WATCH_R = 3.2;

/** Çay ocağı: tezgâhın önünde "Çay söyle". Ocakçı tezgâhın arkasında durur. */
export const TEA_COUNTER = { x: KX - 5.6, z: KZ + 3.6, r: 2.4 };
export const TEA_MAKER = { x: KX - 5.6, z: KZ + 5.75, rot: Math.PI };

// ---- Futbol sahası: nehrin doğusunda, kapalı salonun içinde; 40×26 m ----
export const PITCH = { x: 66, z: 58, hx: 20, hz: 13, goalHalf: 3, goalH: 2.2 };
/** Salonun duvarları (dış kenar yarı ölçüleri) ve yüksekliği. */
export const HALL = { x: PITCH.x, z: PITCH.z, hw: PITCH.hx + 4.6, hd: PITCH.hz + 5, h: 11, door: 3.4 };
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

/** LAGER'in mangalı: güneybatıda, dağların eteğindeki ormanda. */
export const GROVE = { x: -112, z: 118 };
/** Şöhret Kürsüsü: meydanın doğusu, yüzü meydana dönük. */
export const FAME = { x: -72, z: 72 };

// ---- Vadi yolu ve GAP Şehri: köyün doğusundan (eski casino yeri) vadiden geçen asfalt, sonunda şehir ----

/** Yolun kontrol noktaları (x, z): köyde başlar, vadide kıvrılır, şehrin bulvarına bağlanır. */
export const ROAD_POINTS: [number, number][] = [
  [96, -40], [125, -40], [160, -30], [200, -27], [240, -42], [280, -55], [320, -49], [352, -41], [386, -40],
];
/** Asfaltın yarı genişliği (iki şerit) ve koridorun yürünür yarı genişliği (banketler dahil). */
export const ROAD_HALF = 4.2;
export const ROAD_WALK = 10;

/** Catmull-Rom ile yumuşatılmış orta çizgi, ~2 m aralıkla (asfalt, arazi ve ileride arabalar aynı çizgiyi izler). */
export const ROAD_PATH: [number, number][] = (() => {
  const P = ROAD_POINTS, out: [number, number][] = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    const n = Math.max(2, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(P[P.length - 1]);
  return out;
})();
const ROAD_BOX = (() => {
  const xs = ROAD_PATH.map((p) => p[0]), zs = ROAD_PATH.map((p) => p[1]), m = ROAD_WALK + 40;
  return { minX: Math.min(...xs) - m, maxX: Math.max(...xs) + m, minZ: Math.min(...zs) - m, maxZ: Math.max(...zs) + m };
})();

/** Yolun orta çizgisine uzaklık (uzaktaysa Infinity). */
export function roadDist(x: number, z: number): number {
  const b = ROAD_BOX;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return Infinity;
  let best = Infinity;
  const P = ROAD_PATH;
  for (let i = 0; i < P.length - 1; i++) {
    const [ax, az] = P[i], [bx, bz] = P[i + 1];
    const ex = bx - ax, ez = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
    const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
    if (d < best) best = d;
  }
  return best;
}

/** Şehrin yürünür alanı (çevresi tepe). */
export const CITY = { minX: 384, maxX: 548, minZ: -120, maxZ: 40 };
/**
 * Şehrin cadde ağı: her biri asfaltın orta çizgisi (a → b), asfalt yarı genişliği ve kaldırım genişliği.
 * Bulvar yolun devamı (dört şerit, ortada refüj).
 */
export interface Street {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  half: number;
  walk: number;
}
export const BOULEVARD_Z = -40;
export const STREETS: Street[] = [
  { ax: CITY.minX, az: BOULEVARD_Z, bx: CITY.maxX, bz: BOULEVARD_Z, half: 7.5, walk: 4 },
  { ax: 424, az: CITY.minZ, bx: 424, bz: CITY.maxZ, half: 5, walk: 3 },
  { ax: 508, az: CITY.minZ, bx: 508, bz: CITY.maxZ, half: 5, walk: 3 },
  { ax: 466, az: BOULEVARD_Z, bx: 466, bz: CITY.maxZ, half: 5, walk: 3 },
  { ax: CITY.minX, az: 10, bx: CITY.maxX, bz: 10, half: 5, walk: 3 },
];

// ---- Casino: GAP Şehri'nin merkezinde, bulvara bakar; beyaz mermer, altın detay, iki kat ----
/**
 * Zemin kat çift yükseklikte oyun salonu; kuzey şeridinde dolu bir kaidenin üstünde VIP katı (`floor2`).
 * İki yan duvar boyunca merdivenler. Giriş güney cephesinin ortasında (`door` kapının yarı genişliği);
 * ön meydanı bulvarın kaldırımına kadar uzanır.
 */
export const CASINO = { x: 466, z: -78, hw: 17, hd: 13, h: 12, floor2: 4.8, door: 3 };
/**
 * GAP Garaj: berberin arkasında, 508 caddesine (doğuya) bakan tuning atölyesi. Arabayla kepenkten girilir;
 * içerideki parlayan işarete (`spot`, araba batıya bakar) gelince tuning ekranı açılır.
 */
export const GARAGE = { x: 493, z: -99, w: 14, d: 24, h: 6.5, door: 3.2, spot: { x: 493.5, z: -99, rot: -Math.PI / 2 } };

/** VIP katının ön kenarı (z): bunun kuzeyi kat. */
export const CASINO_MEZZ_Z = CASINO.z - CASINO.hd + 9;
