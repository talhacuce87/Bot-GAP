// Okey kuralları: 106 taş (4 renk × 1–13 × 2 + 2 sahte okey), gösterge ve okey, 2–4 oyuncu.
// Sıra: ortadan ya da soldakinin attığı taşı çek, sonra bir taş at. Elini bitiren son taşı "bitir" diye atar;
// kalan 14 taş per (aynı sayı, farklı renk, 3–4) ve serilere (aynı renk, ardışık, 3+; 12-13-1 olur, 13-1-2 olmaz)
// ya da 7 çifte ayrılabilmeli. Okey taşı her şeyin yerine geçer; sahte okey okeyin gerçek değeridir.

export const COLORS = ["Sarı", "Mavi", "Siyah", "Kırmızı"] as const;
export const TILE_COUNT = 106;
export const FAKE_OKEY = [104, 105];

export interface Tile {
  color: number;
  num: number;
}

/** Taş kimliği: (renk*13 + sayı-1)*2 + kopya; 104 ve 105 sahte okey. */
export function tileOf(id: number): Tile | null {
  if (id >= 104) return null;
  const v = id >> 1;
  return { color: Math.floor(v / 13), num: (v % 13) + 1 };
}

export interface OkeyState {
  /** Oturan oyuncu sayısı (2–4); sıra 0..n-1. */
  players: number;
  hands: number[][];
  pile: number[];
  /** Her oyuncunun attığı taşlar (sonuncusu üstte); bir sonraki oyuncu üsttekini alabilir. */
  discards: number[][];
  indicator: number;
  okey: Tile;
  turn: number;
  /** "draw": taş çekecek • "discard": taş atacak */
  phase: "draw" | "discard";
  winner: number | null;
  /** Ortada taş kalmadı, kimse bitiremedi. */
  draw: boolean;
}

/** Göstergenin bir üstü okeydir (13'ün üstü 1). */
export function okeyOf(indicator: Tile): Tile {
  return { color: indicator.color, num: (indicator.num % 13) + 1 };
}

/** Karıştırılmış taşlarla yeni el; `rand` 0–1 (sunucuda Math.random). İlk oyuncu 15 taşla başlar. */
export function okeyDeal(players: number, rand: () => number, starter = 0): OkeyState {
  const ids = Array.from({ length: TILE_COUNT }, (_, i) => i);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const indicatorAt = ids.findIndex((id) => id < 104);
  const [indicator] = ids.splice(indicatorAt, 1);
  const hands = Array.from({ length: players }, (_, p) => ids.splice(0, p === starter ? 15 : 14));
  return {
    players,
    hands,
    pile: ids,
    discards: Array.from({ length: players }, () => []),
    indicator,
    okey: okeyOf(tileOf(indicator)!),
    turn: starter,
    phase: "discard",
    winner: null,
    draw: false,
  };
}

/** Taşın oyundaki değeri: okey joker (null), sahte okey okeyin değeri. */
function valueOf(id: number, okey: Tile): Tile | null {
  const t = tileOf(id);
  if (!t) return { ...okey };
  return t.color === okey.color && t.num === okey.num ? null : t;
}

/** 14 taş per/seri ya da 7 çift olarak dizilebiliyor mu. */
export function isWinningHand(ids: number[], okey: Tile): boolean {
  if (ids.length !== 14) return false;
  const vals: Tile[] = [];
  let jokers = 0;
  for (const id of ids) {
    const v = valueOf(id, okey);
    if (v) vals.push(v);
    else jokers++;
  }
  return pairs(vals, jokers) || groups(vals, jokers);
}

function pairs(vals: Tile[], jokers: number): boolean {
  const counts = new Map<string, number>();
  for (const v of vals) counts.set(`${v.color}-${v.num}`, (counts.get(`${v.color}-${v.num}`) ?? 0) + 1);
  let single = 0;
  for (const c of counts.values()) {
    if (c > 2) return false;
    if (c === 1) single++;
  }
  return single <= jokers && (vals.length + jokers) % 2 === 0;
}

/** Bütün taşları per ve serilere dağıtır. 1'ler seride 13'ün üstünde de (14 olarak) kullanılabilir. */
function groups(vals: Tile[], jokers: number): boolean {
  const ones = vals.map((v, i) => (v.num === 1 ? i : -1)).filter((i) => i >= 0);
  // Her 1 için iki seçenek: 1 ya da 14 (en fazla 8 bir: 256 deneme, pratikte çok az)
  for (let mask = 0; mask < 1 << ones.length; mask++) {
    const tiles = vals.map((v) => ({ ...v }));
    ones.forEach((i, k) => {
      if (mask & (1 << k)) tiles[i].num = 14;
    });
    tiles.sort((a, b) => a.color - b.color || a.num - b.num);
    if (solve(tiles, jokers)) return true;
  }
  return false;
}

function solve(tiles: Tile[], jokers: number): boolean {
  if (!tiles.length) return jokers === 0 || jokers >= 3;
  const t = tiles[0];
  const rest = tiles.slice(1);
  // Per: aynı sayı, farklı renkler (14 olarak seçilen 1 pere giremez)
  if (t.num <= 13) {
    const others: number[] = [];
    const colors = new Set([t.color]);
    rest.forEach((o, i) => {
      if (o.num === t.num && !colors.has(o.color)) {
        colors.add(o.color);
        others.push(i);
      }
    });
    // Diğer renklerden her alt küme + jokerlerle 3 ya da 4 taş
    for (let mask = 0; mask < 1 << others.length; mask++) {
      const picked = others.filter((_, k) => mask & (1 << k));
      for (let size = 3; size <= 4; size++) {
        const need = size - 1 - picked.length;
        if (need < 0 || need > jokers) continue;
        const left = rest.filter((_, i) => !picked.includes(i));
        if (solve(left, jokers - need)) return true;
      }
    }
  }
  // Seri: t'den yukarı (öncesine joker de konabilir), aynı renk ardışık; en az 3
  for (let before = 0; before <= jokers; before++) {
    if (t.num - before < 1) break;
    let left = rest;
    let j = jokers - before;
    let len = before + 1;
    let next = t.num + 1;
    while (true) {
      if (len >= 3 && solve(left, j)) return true;
      if (next > 14) break;
      const at = left.findIndex((o) => o.color === t.color && o.num === next);
      if (at >= 0) left = left.filter((_, i) => i !== at);
      else if (j > 0) j--;
      else break;
      len++;
      next++;
    }
  }
  return false;
}

/** Sıradaki oyuncunun solundaki (ondan önce oynayan) oyuncu. */
export function leftOf(s: OkeyState, p: number): number {
  return (p + s.players - 1) % s.players;
}

export type OkeyMove =
  | { kind: "draw"; from: "pile" | "left" }
  | { kind: "discard"; tile: number; finish?: boolean };

/** Hamleyi uygular; geçersizse null. Bitirme geçersizse taş atılmaz (hamle reddedilir). */
export function okeyMove(s: OkeyState, player: number, m: OkeyMove): OkeyState | null {
  if (s.winner !== null || s.draw || player !== s.turn) return null;
  const hands = s.hands.map((h) => [...h]);
  const discards = s.discards.map((d) => [...d]);
  const pile = [...s.pile];
  if (m.kind === "draw") {
    if (s.phase !== "draw") return null;
    if (m.from === "pile") {
      const id = pile.pop();
      if (id === undefined) return null;
      hands[player].push(id);
    } else {
      const id = discards[leftOf(s, player)].pop();
      if (id === undefined) return null;
      hands[player].push(id);
    }
    return { ...s, hands, discards, pile, phase: "discard" };
  }
  if (s.phase !== "discard") return null;
  const at = hands[player].indexOf(m.tile);
  if (at < 0) return null;
  hands[player].splice(at, 1);
  if (m.finish) {
    if (!isWinningHand(hands[player], s.okey)) return null;
    discards[player].push(m.tile);
    return { ...s, hands, discards, pile, winner: player };
  }
  discards[player].push(m.tile);
  const next = (player + 1) % s.players;
  // Ortada taş kalmadıysa el berabere biter
  return { ...s, hands, discards, pile, turn: next, phase: "draw", draw: pile.length === 0 };
}

/** Oyuncunun görebileceği durum: diğerlerinin eli yalnızca sayı olarak. */
export function okeyView(s: OkeyState, player: number): Omit<OkeyState, "hands" | "pile"> & { hand: number[]; counts: number[]; pileCount: number } {
  const { hands, pile, ...rest } = s;
  return { ...rest, hand: player >= 0 ? [...hands[player]] : [], counts: hands.map((h) => h.length), pileCount: pile.length };
}
