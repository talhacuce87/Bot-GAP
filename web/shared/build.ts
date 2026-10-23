// İnşa: köyün batısında, dağın ardındaki mahallede her üyeye bir arsa. Arsada 1 m'lik ızgaraya blok konur
// (duvar, döşeme, çatı, cam, kapı, lamba…). Sunucu ve istemci aynı tanımları kullanır; arsalar bot veritabanında
// saklanır. Köydeki eski küçük mahalle kalktı (yerinden otoban geçer); oradaki evler buraya taşınır.
import { polylineDist, smoothPath } from "./path";

/** Arsa kenarı (blok), en yüksek kat ve blok sınırı. */
export const PLOT_SIZE = 50;
export const PLOT_H = 40;
export const PLOT_MAX_BLOCKS = 20000;
/** Mahalle caddesi: iki şeritli asfalt (yarı genişlik) ve iki yanında kaldırım. */
export const HOOD_STREET_HALF = 3.2;
export const HOOD_SIDEWALK = 1.8;
/**
 * Veritabanındaki arsa numarası = PLOT_DB_BASE + dizin. Altındaki numaralar eski mahallelerin (9×9 ya da
 * 18×18) arsalarıdır: sunucu ilk yüklemede onları buradaki boş arsalara taşır.
 */
export const PLOT_DB_BASE = 10;

// ---- Mahalle: köyün batısında, dağın ardında ----
// Otoban doğu kenardaki göbekli kavşaktan girer. Kavşaktan batıya hafifçe kıvrılan üç bulvar (kuzey, orta,
// güney) ve doğuda onları bağlayan kıvrımlı cadde; batı uçta bulvarlar göletli parkın çevresindeki döngüye
// bağlanır. Arsalar bulvarların arasında dört sıra; sıralar yarım arsa kaydırılmış (ızgara hissi olmasın).

/** Göbekli kavşak: merkez, asfalt halkanın dış yarıçapı ve ortadaki adanın yarıçapı. */
export const HOOD_ROUNDABOUT = { x: -225, z: -14, r: 13, island: 6 };
/** Otobanın bağlandığı orta bulvarın kavşaktaki hizası. */
export const HOOD_MAIN_Z = HOOD_ROUNDABOUT.z;
/** Göletli park: gölet merkezi ve yarıçapı (parkın kendisi batı döngüsünün içi). */
export const HOOD_PARK = { x: -590, z: -14, pond: 14 };

/**
 * Bulvarların ve arsa sıralarının dalgası (z kayması, m): batıda ve doğuda (park döngüsüne ve doğu caddesine
 * bağlandıkları yerde) sıfıra iner. Arsalar da bulundukları yerin dalgasıyla kayar: sıralar dalgalanır ama
 * arsayla cadde arasındaki mesafe her yerde aynı kalır.
 */
export function hoodWave(x: number): number {
  const env = Math.min(1, Math.max(0, (x + 548) / 40), Math.max(0, (-232 - x) / 40));
  return 9 * env * Math.sin((x + 560) / 62);
}
/** Bulvar: batıdan doğuya her 20 m'de bir dalgalı kontrol noktası. */
const avenue = (z: number, east: number, west: number): [number, number][] => {
  const pts: [number, number][] = [[east, z]];
  for (let x = -250; x > west + 10; x -= 20) pts.push([x, z + hoodWave(x)]);
  pts.push([west, z]);
  return pts;
};

/** Caddelerin kontrol noktaları: bulvarlar doğudan batıya, doğu caddesi kuzeyden güneye, park döngüsü. */
const HOOD_ROAD_POINTS: [number, number][][] = [
  avenue(-86, -222, -548),
  avenue(-14, -225, -552),
  avenue(58, -222, -548),
  [[-222, -86], [-226, -50], [-225, -14], [-226, 22], [-222, 58]],
  [[-548, -85], [-585, -96], [-620, -62], [-628, -14], [-620, 34], [-585, 68], [-548, 57]],
];
export const HOOD_ROADS: [number, number][][] = HOOD_ROAD_POINTS.map((p) => smoothPath(p, 30));
/** Mahalleden köye giden bağlantı yollarının başladığı yer: doğu caddesinin iki ucu (kuzey, güney). */
export const LINK_STARTS: [number, number][] = [[-222, -86], [-222, 58]];

export interface Plot {
  /** Dizin (oyunda ve protokolde arsa numarası). */
  id: number;
  /** Veritabanındaki numarası. */
  db: number;
  /** En küçük köşe (dünya, tam sayı): blok (i, j, k) dünyada x0+i … x0+i+1. */
  x0: number;
  z0: number;
  /** Kenar (blok) ve blok sınırı. */
  size: number;
  max: number;
  /** Ön yüz (caddeye bakan): -1 kuzey kenarı (z0), 1 güney kenarı (z0 + size). Tabela oraya konur. */
  front: -1 | 1;
}

/** Arsa sıraları: kuzey kenarı, ilk arsanın batı kenarı ve caddeye bakan yüz. */
const ROWS: { z0: number; x0: number; front: -1 | 1 }[] = [
  { z0: -144, x0: -540, front: 1 },
  { z0: -74, x0: -525, front: -1 },
  { z0: -4, x0: -540, front: -1 },
  { z0: 66, x0: -525, front: -1 },
];
const PLOT_STEP = 60;

/** Arsalar: sıra sıra, batıdan doğuya. Sıra değişmez: kayıtlı arsalar numarayla saklanır. */
export const PLOTS: Plot[] = [];
for (const row of ROWS) {
  for (let c = 0; c < 5; c++) {
    const x0 = row.x0 + c * PLOT_STEP;
    const z0 = row.z0 + Math.round(hoodWave(x0 + PLOT_SIZE / 2));
    PLOTS.push({ id: PLOTS.length, db: PLOT_DB_BASE + PLOTS.length, x0, z0, size: PLOT_SIZE, max: PLOT_MAX_BLOCKS, front: row.front });
  }
}

/** Mahallenin yürünür alanı (çevresi tepe); köşeleri HOOD_CORNER yarıçapıyla yuvarlak. */
export const HOOD_BOX = { minX: -640, maxX: -210, minZ: -166, maxZ: 138 };
export const HOOD_CORNER = 45;

/** Mahallenin caddelerinin asfaltında mı (`margin` kenardan dışarısı da sayılır). Kavşağın adası asfalt değil. */
export function onHoodStreet(x: number, z: number, margin = 0): boolean {
  const B = HOOD_BOX;
  if (x < B.minX - margin || x > B.maxX + margin || z < B.minZ - margin || z > B.maxZ + margin) return false;
  const R = HOOD_ROUNDABOUT, dr = Math.hypot(x - R.x, z - R.z);
  if (dr < R.r + margin) return dr > R.island + margin;
  return HOOD_ROADS.some((r) => polylineDist(r, x, z) < HOOD_STREET_HALF + margin);
}

/** Arsa numarası veritabanındaki numaradan (bu mahallenin değilse -1). */
export function plotOfDb(db: number): number {
  const id = db - PLOT_DB_BASE;
  return Number.isInteger(id) && id >= 0 && id < PLOTS.length ? id : -1;
}

export type BlockKind = "cube" | "slab" | "wedge" | "glass" | "door" | "lamp" | "plant" | "fence";

export interface BlockDef {
  name: string;
  emoji: string;
  color: string;
  kind: BlockKind;
}

/** Blok türleri (id = dizin + 1; 0 boş). Sıra değişmez: kayıtlı arsalar id ile saklanır. */
export const BLOCKS: BlockDef[] = [
  { name: "Tuğla", emoji: "🧱", color: "#b5543c", kind: "cube" },
  { name: "Beyaz duvar", emoji: "⬜", color: "#ece6d8", kind: "cube" },
  { name: "Taş", emoji: "🪨", color: "#8d9095", kind: "cube" },
  { name: "Ahşap", emoji: "🪵", color: "#a0703f", kind: "cube" },
  { name: "Koyu ahşap", emoji: "🟫", color: "#5b3f25", kind: "cube" },
  { name: "Sarı sıva", emoji: "🟨", color: "#e8c46a", kind: "cube" },
  { name: "Mavi", emoji: "🟦", color: "#4a78c2", kind: "cube" },
  { name: "Yeşil", emoji: "🟩", color: "#5a9a4a", kind: "cube" },
  { name: "Kırmızı çatı", emoji: "🔺", color: "#b8402e", kind: "wedge" },
  { name: "Gri çatı", emoji: "🔻", color: "#4c535f", kind: "wedge" },
  { name: "Basamak", emoji: "🪜", color: "#b9b2a2", kind: "slab" },
  { name: "Ahşap döşeme", emoji: "🟤", color: "#c28e57", kind: "slab" },
  { name: "Cam", emoji: "🪟", color: "#a9d8f0", kind: "glass" },
  { name: "Kapı", emoji: "🚪", color: "#7a4a26", kind: "door" },
  { name: "Lamba", emoji: "💡", color: "#ffd36b", kind: "lamp" },
  { name: "Çiçek", emoji: "🌷", color: "#e85a6f", kind: "plant" },
  { name: "Çit", emoji: "🪵", color: "#d8c3a0", kind: "fence" },
  { name: "Siyah", emoji: "⬛", color: "#24262c", kind: "cube" },
];

export function blockDef(id: number): BlockDef | undefined {
  return BLOCKS[id - 1];
}

/** İçinden geçilmeyen bloklar (kapı, çiçek geçilir). */
export function isSolid(id: number): boolean {
  const k = blockDef(id)?.kind;
  return !!k && k !== "door" && k !== "plant";
}

/** Bloğun yüksekliği (yarım blok basamak olur). */
export function blockHeight(id: number): number {
  const k = blockDef(id)?.kind;
  return k === "slab" ? 0.5 : k === "fence" ? 0.9 : 1;
}

/** Arsadaki blok: yerel ızgara (i, j kat, k), tür ve yön (0–3, çeyrek tur). */
export interface Block {
  i: number;
  j: number;
  k: number;
  b: number;
  r: number;
}

/** Arsa içi hücre anahtarı (bellekte; kayıt biçimi i.j.k olduğundan değişebilir). */
export function cellKey(i: number, j: number, k: number): number {
  return (j * 64 + k) * 64 + i;
}

export function inPlot(plot: number, i: number, j: number, k: number): boolean {
  const n = PLOTS[plot]?.size ?? 0;
  return Number.isInteger(i) && Number.isInteger(j) && Number.isInteger(k) && i >= 0 && k >= 0 && j >= 0 && i < n && k < n && j < PLOT_H;
}

/** Saklama biçimi: "i.j.k.b.r" blokları virgülle (36 tabanlı, kısa). */
export function encodeBlocks(blocks: Block[]): string {
  return blocks.map((x) => [x.i, x.j, x.k, x.b, x.r].map((n) => n.toString(36)).join(".")).join(",");
}

export function decodeBlocks(plot: number, data: string): Block[] {
  const out: Block[] = [];
  const max = PLOTS[plot]?.max ?? 0;
  if (!data) return out;
  for (const part of data.split(",")) {
    const [i, j, k, b, r] = part.split(".").map((s) => parseInt(s, 36));
    if (inPlot(plot, i, j, k) && blockDef(b) && r >= 0 && r < 4) out.push({ i, j, k, b, r });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Başka arsaya taşınma: evin kapladığı alan yeni arsanın ortasına kaydırılır. Sığmayan blok atılır
 * (çağıran, sayı azaldıysa taşınmayı reddeder).
 */
export function moveBlocks(blocks: Iterable<Block>, to: number): Block[] {
  const list = [...blocks], n = PLOTS[to]?.size ?? 0;
  if (!list.length) return [];
  const span = (f: (b: Block) => number) => {
    let lo = Infinity, hi = -Infinity;
    for (const b of list) [lo, hi] = [Math.min(lo, f(b)), Math.max(hi, f(b))];
    return Math.floor((n - (hi - lo + 1)) / 2) - lo;
  };
  const di = span((b) => b.i), dk = span((b) => b.k);
  return list.map((b) => ({ ...b, i: b.i + di, k: b.k + dk })).filter((b) => inPlot(to, b.i, b.j, b.k)).slice(0, PLOTS[to]?.max ?? 0);
}

/** Arsanın durumu (istemciye giden): sahibi, adı ve bloklar. */
export interface PlotState {
  id: number;
  owner: string | null;
  name: string;
  data: string;
}
