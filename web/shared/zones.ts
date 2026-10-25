// Bölgelerin yerleşimi: istemci (sahne) ve sunucu (mesafe, kurallar) aynı sayıları kullanır.
import { HOOD_MAIN_Z, HOOD_ROUNDABOUT, LINK_STARTS, onHoodStreet } from "./build";
import { polylineDist, smoothPath } from "./path";

export { polylineDist };
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
/**
 * Ahşap yaya köprüleri: nehrin üzerinde, orta noktaları (yön nehre dik, sahnede hesaplanır). Kuzeydeki geçiş
 * otobanın köprüsüdür (kaldırımından yürünür; bkz. ROAD_RIVER).
 */
export const BRIDGES = [{ x: -14, z: 62 }];
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

// ---- Stadyum: dünyanın dışında (güneyde, dağların ardında), yalnızca "!maç" ile ışınlanılan 64×40 m saha ----
// Hiçbir yolun yakınında değil: arabayla geçen yanlışlıkla girmez. Konumlar ağda ±655 m'ye sığmalı
// (bkz. protocol quantPos, POS_SCALE).
export const STADIUM_PITCH: Field = { x: -170, z: 420, hx: 32, hz: 20, goalHalf: 3.66, goalH: 2.44, sidePad: 1.4 };
/** Stadyumda yürünebilen alan (oyuncu merkezi): sahanın çevresi, kale fileleri dahil. */
export const STADIUM = { x: STADIUM_PITCH.x, z: STADIUM_PITCH.z, hw: STADIUM_PITCH.hx + 1.6, hd: STADIUM_PITCH.hz + 1.0 };

/** Nokta stadyumun bulunduğu bölgede mi (dünyadan ayrı; oraya yalnızca ışınlanılır). */
export function inStadium(x: number, z: number): boolean {
  return Math.abs(x - STADIUM.x) < STADIUM.hw + 40 && Math.abs(z - STADIUM.z) < STADIUM.hd + 40;
}

// ---- Voleybol salonu: dünyanın dışında (güneyde, stadyumun yanında), menüden ışınlanılan kapalı salon ----
// Saha 16×9 m (chibi ölçeğinde); file sahanın ortasında, x ekseninde (batı yarı kırmızı, doğu yarı mavi).
export const VOLLEY_COURT = { x: 120, z: 420, hx: 12, hz: 6 };
/** Salonun duvarları (yarı ölçüler) ve yüksekliği. */
export const VOLLEY_HALL = { x: VOLLEY_COURT.x, z: VOLLEY_COURT.z, hw: VOLLEY_COURT.hx + 7, hd: VOLLEY_COURT.hz + 7, h: 11 };

/**
 * Işınlanılan odaların altındaki düz zemin (yarı ölçüler): arazi burada sıfıra iner, çevresi tepe. Stadyumun
 * çim zemini 260×200; salon kapalı.
 */
export const ROOM_FLATS = [
  { x: STADIUM_PITCH.x, z: STADIUM_PITCH.z, hw: 132, hd: 102 },
  { x: VOLLEY_COURT.x, z: VOLLEY_COURT.z, hw: 45, hd: 40 },
];

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

// ---- Otoban: dağın ardındaki mahalleden köyü geçip vadiden GAP Şehri'ne giden asfalt ----

/**
 * GAP Şehri ve yarış pisti, ilk tasarımlarındaki yerlerinden bu kadar batıda (köye yakın; vadi yolu kısa).
 * Şehirdeki ve pistteki bütün konumlar ilk yerlerine bu kaydırma eklenerek yazılır.
 */
export const CITY_DX = -150;
/** Şehrin batı kenarı (otobanın bulvara bağlandığı yer). */
const CITY_X0 = 384 + CITY_DX;

/**
 * Yolun kontrol noktaları (x, z): mahallenin girişindeki göbekli kavşakta başlar (orta bulvarın hizasında),
 * geçitten köye iner, eski küçük mahallenin
 * yerinden geçer, nehri köprüyle aşar, sinemanın önünden (amfinin arkasından) köyün doğusuna, oradan vadiden
 * şehrin bulvarına. Arabalar mahalleden şehre kesintisiz gider.
 */
export const ROAD_POINTS: [number, number][] = [
  [HOOD_ROUNDABOUT.x + HOOD_ROUNDABOUT.r, HOOD_MAIN_Z], [-150, HOOD_MAIN_Z], [-90, HOOD_MAIN_Z], [-62, -14], [-50, -12], [-38, -8], [-15, -4],
  [25, -4], [70, -12],
  [100, -40], [130, -40], [165, -31], [200, -38], [CITY_X0 + 2, -40],
];
/** Yolun köyün doğu kapısındaki noktası (şehir yolu buradan vadiye girer; köy patikaları buraya bağlanır). */
export const ROAD_VILLAGE_GATE: [number, number] = [100, -40];
/** Otobanın nehri geçtiği köprünün iki ucu (batı, doğu): yaya patikaları buraya bağlanır. */
export const ROAD_RIVER: { west: [number, number]; east: [number, number] } = { west: [-64, -14.3], east: [-36, -7.4] };
/** Asfaltın yarı genişliği (iki şerit) ve koridorun yürünür yarı genişliği (banketler dahil). */
export const ROAD_HALF = 4.2;
export const ROAD_WALK = 10;

/** Otobanın yumuşatılmış orta çizgisi (asfalt, arazi ve arabalar aynı çizgiyi izler). */
export const ROAD_PATH: [number, number][] = smoothPath(ROAD_POINTS, 35);

/**
 * Mahallenin diğer bağlantıları (otobanla aynı genişlikte): kuzey yolu mahallenin doğu caddesinin kuzey ucundan
 * tepeleri aşıp köyün kuzeybatısına iner, gölün batısından otobana bağlanır; güney yolu güney ucundan köyün
 * batısına iner, meydanın güneyinden dolanıp meydanla şöhret kürsüsünün arasından batıdaki köy
 * yoluna bağlanır. Böylece mahalle,
 * otoban ve köy halka olur.
 */
export const LINK_ROAD_POINTS: [number, number][][] = [
  [LINK_STARTS[0], [-190, -100], [-160, -104], [-140, -84], [-124, -60], [-121, -36], [-120, HOOD_MAIN_Z]],
  [LINK_STARTS[1], [-190, 72], [-160, 86], [-135, 89], [-112, 84], [-94, 82], [-83, 73], [-82, 60], [-85, 49]],
];
export const LINK_ROADS: [number, number][][] = LINK_ROAD_POINTS.map((p) => smoothPath(p, 30));
/** Otoban ve bağlantı yolları: aynı genişlik, yürünür koridor ve köprü kuralı. */
export const ROADS: [number, number][][] = [ROAD_PATH, ...LINK_ROADS];

/**
 * Köy yolları: otobandan ayrılan iki şeritli dar asfalt. Batıdaki meydana (doğuş noktası; kahvehanenin
 * doğusundan), doğudaki kapalı sahanın kuzey kapısına (tank parkının batısından). İlk nokta otobanın üstünde.
 */
export const VILLAGE_ROAD_POINTS: [number, number][][] = [
  [[-80, HOOD_MAIN_Z], [-80, 4], [-80, 22], [-82, 38], [-85, 49]],
  [[38, -6], [46, 6], [56, 18], [64, 29], [69, 35]],
];
export const VILLAGE_ROAD_HALF = 3.2;
export const VILLAGE_ROADS: [number, number][][] = VILLAGE_ROAD_POINTS.map((p) => smoothPath(p, 18));


/** En yakın köy yolunun orta çizgisine uzaklık. */
export function villageRoadDist(x: number, z: number): number {
  let best = Infinity;
  for (const r of VILLAGE_ROADS) best = Math.min(best, polylineDist(r, x, z));
  return best;
}

/** Asfaltın (otoban, köy yolu ya da mahalle caddesi) üstünde mi; `margin` kenardan ne kadar dışarısı da sayılır. */
export function onAsphalt(x: number, z: number, margin = 0): boolean {
  return roadDist(x, z) < ROAD_HALF + margin || villageRoadDist(x, z) < VILLAGE_ROAD_HALF + margin || onHoodStreet(x, z, margin);
}

/** Yol parçalarının ızgara dizini: hücreye (ROAD_CELL m) değen parçalar; uzaklık yalnızca yakındakilere bakar. */
const ROAD_CELL = 32;
/** Bundan uzak noktalar için kesin uzaklık gerekmez (arazi tepeleri en fazla bu kadar öteye bakar). */
const ROAD_REACH = ROAD_WALK + 40;
/** Bütün yolların parçaları düz dizide: ax, az, bx, bz. */
const ROAD_SEGS: number[] = ROADS.flatMap((P) => P.slice(0, -1).flatMap((a, i) => [a[0], a[1], P[i + 1][0], P[i + 1][1]]));
const roadCells = (() => {
  const cells = new Map<number, number[]>();
  for (let i = 0; i < ROAD_SEGS.length; i += 4) {
    const ax = ROAD_SEGS[i], az = ROAD_SEGS[i + 1], bx = ROAD_SEGS[i + 2], bz = ROAD_SEGS[i + 3];
    const x0 = Math.floor((Math.min(ax, bx) - ROAD_REACH) / ROAD_CELL), x1 = Math.floor((Math.max(ax, bx) + ROAD_REACH) / ROAD_CELL);
    const z0 = Math.floor((Math.min(az, bz) - ROAD_REACH) / ROAD_CELL), z1 = Math.floor((Math.max(az, bz) + ROAD_REACH) / ROAD_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cx * 100_000 + cz;
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
    }
  }
  return cells;
})();

/** En yakın yolun (otoban ya da bağlantı yolu) orta çizgisine uzaklık (ROAD_REACH'ten uzaksa Infinity olabilir). */
export function roadDist(x: number, z: number): number {
  const segs = roadCells.get(Math.floor(x / ROAD_CELL) * 100_000 + Math.floor(z / ROAD_CELL));
  if (!segs) return Infinity;
  let best = Infinity;
  for (const i of segs) {
    const ax = ROAD_SEGS[i], az = ROAD_SEGS[i + 1], bx = ROAD_SEGS[i + 2], bz = ROAD_SEGS[i + 3];
    const ex = bx - ax, ez = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
    const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
    if (d < best) best = d;
  }
  return best;
}

/** Şehrin yürünür alanı (çevresi tepe). */
export const CITY = { minX: 384 + CITY_DX, maxX: 548 + CITY_DX, minZ: -120, maxZ: 40 };
/** GAP Galeri'nin arsası: şehrin doğu ucunda, z=10 caddesinin bittiği yerde (şehre bitişik yürünür alan). */
export const GALLERY_AREA = { minX: CITY.maxX, maxX: CITY.maxX + 54, minZ: -9, maxZ: 29 };
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
  { ax: 424 + CITY_DX, az: CITY.minZ, bx: 424 + CITY_DX, bz: CITY.maxZ, half: 5, walk: 3 },
  { ax: 508 + CITY_DX, az: CITY.minZ, bx: 508 + CITY_DX, bz: CITY.maxZ, half: 5, walk: 3 },
  { ax: 466 + CITY_DX, az: BOULEVARD_Z, bx: 466 + CITY_DX, bz: CITY.maxZ, half: 5, walk: 3 },
  { ax: CITY.minX, az: 10, bx: CITY.maxX, bz: 10, half: 5, walk: 3 },
];

// ---- Casino: GAP Şehri'nin merkezinde, bulvara bakar; beyaz mermer, altın detay, iki kat ----
/**
 * Zemin kat çift yükseklikte oyun salonu; kuzey şeridinde dolu bir kaidenin üstünde VIP katı (`floor2`).
 * İki yan duvar boyunca merdivenler. Giriş güney cephesinin ortasında (`door` kapının yarı genişliği);
 * ön meydanı bulvarın kaldırımına kadar uzanır.
 */
export const CASINO = { x: 466 + CITY_DX, z: -78, hw: 17, hd: 13, h: 12, floor2: 4.8, door: 3 };
/**
 * GAP Garaj: berberin arkasında, 508 caddesine (doğuya) bakan tuning atölyesi. Arabayla kepenkten girilir;
 * içerideki parlayan işarete (`spot`, araba batıya bakar) gelince tuning ekranı açılır.
 */
export const GARAGE = { x: 493 + CITY_DX, z: -99, w: 14, d: 24, h: 6.5, door: 3.2, spot: { x: 493.5 + CITY_DX, z: -99, rot: -Math.PI / 2 } };
/** Garaj işaretinin bu kadar yakınına araba park edilmez (yoksa işareti kapatır, kimse tuning'e giremez). */
export const GARAGE_KEEP_CLEAR = 3.6;

/** VIP katının ön kenarı (z): bunun kuzeyi kat. */
export const CASINO_MEZZ_Z = CASINO.z - CASINO.hd + 9;
