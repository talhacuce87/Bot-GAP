// Tank savaşı arenası ve maç kuralları: sunucu (isabet, doğma) ve istemci (sahne, çarpışma) aynı listeyi kullanır.

/** Arenanın yürünebilir yarıçapı; kenarda alçak beton duvar var (mermi de çarpar). */
export const ARENA_RADIUS = 55;
export const ARENA_WALL_H = 1.4;

export const TEAMS = [
  { name: "Kırmızı", color: "#e0453a" },
  { name: "Mavi", color: "#3a7be0" },
] as const;
export type Team = 0 | 1;

/** Takım üsleri: karşılıklı, merkeze bakan. Doğanlar üssün önünde yan yana dizilir. */
export const BASES = [
  { x: -44, z: 0, h: Math.PI / 2 },
  { x: 44, z: 0, h: -Math.PI / 2 },
] as const;

export const TANK_HP = 3;
export const RESPAWN_MS = 5000;
export const MATCH_MS = 5 * 60 * 1000;
export const COUNTDOWN_MS = 5000;
export const END_MS = 12_000;
/** Doğrudan isabet dışında, patlama merkezine bu kadar yakın düşman tanka da 1 hasar. */
export const SPLASH_DAMAGE_R = 2.4;
/** Tankın isabet silindiri (gövde ~2.3 × 4 m). */
export const TANK_HIT_R = 1.6;
export const TANK_HIT_TOP = 2.4;

export type Phase = "wait" | "count" | "play" | "end";

/** Siper: daire (x, z, yarıçap) ve yükseklik; `kind` yalnızca görünüş. */
export interface Cover {
  x: number;
  z: number;
  r: number;
  h: number;
  kind: "rock" | "crates" | "wall";
}

// Yarısı tanımlanır, x'e göre aynalanır: iki takım için birebir aynı harita.
const HALF: Cover[] = [
  { x: -30, z: -14, r: 1.6, h: 1.8, kind: "crates" },
  { x: -30, z: 14, r: 1.6, h: 1.8, kind: "crates" },
  { x: -22, z: 0, r: 2.6, h: 2.6, kind: "rock" },
  { x: -16, z: -24, r: 3.2, h: 3.2, kind: "rock" },
  { x: -16, z: 24, r: 3.2, h: 3.2, kind: "rock" },
  { x: -10, z: -9, r: 1.5, h: 1.6, kind: "wall" },
  { x: -10, z: 9, r: 1.5, h: 1.6, kind: "wall" },
  { x: -36, z: -30, r: 2.4, h: 2.4, kind: "rock" },
  { x: -36, z: 30, r: 2.4, h: 2.4, kind: "rock" },
];

export const COVER: Cover[] = [
  ...HALF,
  ...HALF.map((c) => ({ ...c, x: -c.x })),
  // Orta: büyük kaya ve iki yanında kasa yığını
  { x: 0, z: 0, r: 4, h: 3.6, kind: "rock" },
  { x: 0, z: -18, r: 1.7, h: 1.8, kind: "crates" },
  { x: 0, z: 18, r: 1.7, h: 1.8, kind: "crates" },
];

/** Takımın `slot`. tankının doğma yeri: üssün önünde, merkeze dik doğrultuda sıra sıra. */
export function spawnPoint(team: Team, slot: number): { x: number; z: number; h: number } {
  const b = BASES[team];
  const side = ((slot % 2 ? 1 : -1) * Math.ceil(slot / 2)) * 5.5;
  return { x: b.x, z: b.z + Math.max(-20, Math.min(20, side)), h: b.h };
}
