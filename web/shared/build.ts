// İnşa: "GAP Mahallesi"nde ya da dağın ardındaki büyük mahallede her üyeye bir arsa. Arsada 1 m'lik ızgaraya
// blok konur (duvar, döşeme, çatı, cam, kapı, lamba…). Sunucu ve istemci aynı tanımları kullanır; arsalar bot veritabanında saklanır.

/** Küçük mahallenin arsa kenarı (blok), bütün arsaların en yüksek katı ve küçük arsanın blok sınırı. */
export const PLOT_SIZE = 18;
export const PLOT_H = 40;
export const PLOT_MAX_BLOCKS = 5000;
/** Büyük mahallenin arsa kenarı, blok sınırı ve arsalar arası sokak. */
export const BIG_PLOT_SIZE = 50;
export const BIG_PLOT_MAX_BLOCKS = 20000;
export const BIG_GAP = 6;
/** Arsalar arası sokak genişliği. */
export const HOOD_GAP = 3;
/** Mahallenin en küçük köşesi (dünya x/z): kahvehanenin güneyi, gölün kuzeyi, nehrin batısı. */
export const HOOD = { x0: -133, z0: -34, cols: 3, rows: 2 };
/** Büyük mahalle: köyün batısındaki dağ halkasının ardında; küçük mahallenin sokağından geçitle gidilir. */
export const BIG_HOOD = { x0: -514, z0: -152, cols: 4, rows: 5 };
const GAP = HOOD_GAP;

export interface Plot {
  id: number;
  /** En küçük köşe (dünya, tam sayı): blok (i, j, k) dünyada x0+i … x0+i+1. */
  x0: number;
  z0: number;
  /** Kenar (blok) ve blok sınırı. */
  size: number;
  max: number;
  big: boolean;
}

/** Arsalar: önce küçük mahalle (0–5), sonra büyük mahalle. Sıra değişmez: kayıtlı arsalar id ile saklanır. */
export const PLOTS: Plot[] = [];
for (let r = 0; r < HOOD.rows; r++) {
  for (let c = 0; c < HOOD.cols; c++) {
    PLOTS.push({ id: PLOTS.length, x0: HOOD.x0 + c * (PLOT_SIZE + GAP), z0: HOOD.z0 + r * (PLOT_SIZE + GAP), size: PLOT_SIZE, max: PLOT_MAX_BLOCKS, big: false });
  }
}
for (let r = 0; r < BIG_HOOD.rows; r++) {
  for (let c = 0; c < BIG_HOOD.cols; c++) {
    const step = BIG_PLOT_SIZE + BIG_GAP;
    PLOTS.push({ id: PLOTS.length, x0: BIG_HOOD.x0 + c * step, z0: BIG_HOOD.z0 + r * step, size: BIG_PLOT_SIZE, max: BIG_PLOT_MAX_BLOCKS, big: true });
  }
}

/** Mahallenin kapladığı kutu (ağaç/kaya dikilmez). */
export const HOOD_BOX = {
  minX: HOOD.x0 - 2,
  maxX: HOOD.x0 + HOOD.cols * PLOT_SIZE + (HOOD.cols - 1) * GAP + 2,
  minZ: HOOD.z0 - 2,
  maxZ: HOOD.z0 + HOOD.rows * PLOT_SIZE + (HOOD.rows - 1) * GAP + 2,
};

/** Büyük mahallenin yürünür alanı (çevresinde sokak payıyla; dışı tepe). */
export const BIG_HOOD_BOX = {
  minX: BIG_HOOD.x0 - BIG_GAP,
  maxX: BIG_HOOD.x0 + BIG_HOOD.cols * BIG_PLOT_SIZE + (BIG_HOOD.cols - 1) * BIG_GAP + BIG_GAP,
  minZ: BIG_HOOD.z0 - BIG_GAP,
  maxZ: BIG_HOOD.z0 + BIG_HOOD.rows * BIG_PLOT_SIZE + (BIG_HOOD.rows - 1) * BIG_GAP + BIG_GAP,
};

/** Geçit: küçük mahallenin sokağından (batı ucu) büyük mahallenin doğu sokağına düz yol; yürünür yarı genişlik. */
export const HOOD_PASS = { z: HOOD.z0 + PLOT_SIZE + HOOD_GAP / 2, x0: BIG_HOOD_BOX.maxX - 2, x1: HOOD_BOX.minX + 2, half: 5 };

/** Geçidin dışına uzaklık (içinde 0). */
export function passOutside(x: number, z: number): number {
  const P = HOOD_PASS;
  return Math.max(0, Math.hypot(Math.max(P.x0 - x, 0, x - P.x1), z - P.z) - P.half);
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
