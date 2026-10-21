// İnşa: "GAP Mahallesi"nde her üyeye bir arsa. Arsada 1 m'lik ızgaraya blok konur (duvar, döşeme, çatı,
// cam, kapı, lamba…). Sunucu ve istemci aynı tanımları kullanır; arsalar bot veritabanında saklanır.

/** Arsa kenarı (blok) ve en yüksek kat. */
export const PLOT_SIZE = 9;
export const PLOT_H = 10;
export const PLOT_MAX_BLOCKS = 700;
const GAP = 2.5;
/** Mahallenin kuzeydoğu köşesi (dünya, en küçük x/z): zindanın kuzeyi. */
export const HOOD = { x0: -80, z0: 18, cols: 3, rows: 3 };

export interface Plot {
  id: number;
  /** En küçük köşe (dünya, tam sayı): blok (i, j, k) dünyada x0+i … x0+i+1. */
  x0: number;
  z0: number;
}

export const PLOTS: Plot[] = [];
for (let r = 0; r < HOOD.rows; r++) {
  for (let c = 0; c < HOOD.cols; c++) {
    PLOTS.push({ id: PLOTS.length, x0: HOOD.x0 + c * (PLOT_SIZE + GAP), z0: HOOD.z0 + r * (PLOT_SIZE + GAP) });
  }
}

/** Mahallenin kapladığı kutu (ağaç/kaya dikilmez). */
export const HOOD_BOX = {
  minX: HOOD.x0 - 1,
  maxX: HOOD.x0 + HOOD.cols * PLOT_SIZE + (HOOD.cols - 1) * GAP + 1,
  minZ: HOOD.z0 - 1,
  maxZ: HOOD.z0 + HOOD.rows * PLOT_SIZE + (HOOD.rows - 1) * GAP + 1,
};

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

export function cellKey(i: number, j: number, k: number): number {
  return (j * PLOT_SIZE + k) * PLOT_SIZE + i;
}

export function inPlot(i: number, j: number, k: number): boolean {
  return Number.isInteger(i) && Number.isInteger(j) && Number.isInteger(k) && i >= 0 && k >= 0 && j >= 0 && i < PLOT_SIZE && k < PLOT_SIZE && j < PLOT_H;
}

/** Saklama biçimi: "i.j.k.b.r" blokları virgülle (36 tabanlı, kısa). */
export function encodeBlocks(blocks: Block[]): string {
  return blocks.map((x) => [x.i, x.j, x.k, x.b, x.r].map((n) => n.toString(36)).join(".")).join(",");
}

export function decodeBlocks(data: string): Block[] {
  const out: Block[] = [];
  if (!data) return out;
  for (const part of data.split(",")) {
    const [i, j, k, b, r] = part.split(".").map((s) => parseInt(s, 36));
    if (inPlot(i, j, k) && blockDef(b) && r >= 0 && r < 4) out.push({ i, j, k, b, r });
    if (out.length >= PLOT_MAX_BLOCKS) break;
  }
  return out;
}

/** Arsanın durumu (istemciye giden): sahibi, adı ve bloklar. */
export interface PlotState {
  id: number;
  owner: string | null;
  name: string;
  data: string;
}
