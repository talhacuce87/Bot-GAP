// Tavla (backgammon) kuralları. Noktalar 0–23; oyuncu 0 (beyaz) 23 → 0 yönünde oynar, evi 0–5;
// oyuncu 1 (siyah) 0 → 23 yönünde, evi 18–23. `points[i]` > 0 beyaz, < 0 siyah pul sayısı.
// Zar kuralı: mümkünse iki zarın (çiftte dördünün) hepsi oynanmalı; yalnızca biri oynanabiliyorsa büyük olan.

export type Side = 0 | 1;

export interface TavlaState {
  points: number[];
  /** Kırılıp bara çıkan pullar. */
  bar: [number, number];
  /** Toplanan pullar. */
  off: [number, number];
  turn: Side;
  /** Bu turda oynanmamış zarlar. */
  dice: number[];
  /** Turun başındaki zarlar (gösterim). */
  rolled: number[];
  winner: Side | null;
  /** Kaybeden hiç pul toplamadıysa mars (2 sayı). */
  mars: boolean;
}

/** `from` -1: bar; `to` -1: toplama (dışarı). */
export interface TavlaMove {
  from: number;
  to: number;
  die: number;
}

export const CHECKERS = 15;

export function tavlaInitial(turn: Side, dice: [number, number]): TavlaState {
  const points = new Array(24).fill(0);
  points[23] = 2; points[12] = 5; points[7] = 3; points[5] = 5;
  points[0] = -2; points[11] = -5; points[16] = -3; points[18] = -5;
  return { points, bar: [0, 0], off: [0, 0], turn, dice: rollDice(dice), rolled: [...dice], winner: null, mars: false };
}

/** Çift atılırsa dört hamle. */
export function rollDice([a, b]: [number, number]): number[] {
  return a === b ? [a, a, a, a] : [a, b];
}

const own = (s: TavlaState, i: number, side: Side) => (side === 0 ? s.points[i] > 0 : s.points[i] < 0);
const count = (s: TavlaState, i: number, side: Side) => (side === 0 ? Math.max(0, s.points[i]) : Math.max(0, -s.points[i]));
const enemyAt = (s: TavlaState, i: number, side: Side) => count(s, i, (1 - side) as Side);

/** Bütün pullar evdeyse toplanabilir. */
function allHome(s: TavlaState, side: Side): boolean {
  if (s.bar[side]) return false;
  for (let i = 0; i < 24; i++) {
    const home = side === 0 ? i <= 5 : i >= 18;
    if (!home && own(s, i, side)) return false;
  }
  return true;
}

/** Tek zarla yapılabilecek hamleler (zar kuralına bakmadan). */
function singleMoves(s: TavlaState, die: number): TavlaMove[] {
  const side = s.turn, out: TavlaMove[] = [];
  const dir = side === 0 ? -1 : 1;
  const open = (to: number) => enemyAt(s, to, side) <= 1;
  if (s.bar[side]) {
    const to = side === 0 ? 24 - die : die - 1;
    if (open(to)) out.push({ from: -1, to, die });
    return out;
  }
  const home = allHome(s, side);
  for (let i = 0; i < 24; i++) {
    if (!own(s, i, side)) continue;
    const to = i + dir * die;
    if (to >= 0 && to < 24) {
      if (open(to)) out.push({ from: i, to, die });
    } else if (home) {
      // Toplama: tam zarla ya da daha gerideki noktada pul yoksa büyük zarla
      const dist = side === 0 ? i + 1 : 24 - i;
      if (dist === die) out.push({ from: i, to: -1, die });
      else if (die > dist) {
        let farther = false;
        for (let j = 0; j < 24; j++) {
          const d = side === 0 ? j + 1 : 24 - j;
          if (d > dist && own(s, j, side)) farther = true;
        }
        if (!farther) out.push({ from: i, to: -1, die });
      }
    }
  }
  return out;
}

/** Hamleyi uygular (kırma dahil); zarı listeden düşer. Kazananı belirler, turu değiştirmez. */
function apply(s: TavlaState, m: TavlaMove): TavlaState {
  const side = s.turn, sign = side === 0 ? 1 : -1;
  const n: TavlaState = { ...s, points: [...s.points], bar: [...s.bar] as [number, number], off: [...s.off] as [number, number], dice: [...s.dice] };
  n.dice.splice(n.dice.indexOf(m.die), 1);
  if (m.from === -1) n.bar[side]--;
  else n.points[m.from] -= sign;
  if (m.to === -1) n.off[side]++;
  else {
    if (enemyAt(n, m.to, side) === 1) {
      n.points[m.to] = 0;
      n.bar[1 - side]++;
    }
    n.points[m.to] += sign;
  }
  if (n.off[side] === CHECKERS) {
    n.winner = side;
    n.mars = n.off[1 - side] === 0;
  }
  return n;
}

/**
 * Kalan zarlarla oynanabilecek en uzun hamle dizisinin uzunluğu ve kullanılabilen en büyük tek zar.
 * Çiftte aynı duruma farklı sıralarla varılır: `memo` aynı durumu bir kez hesaplar.
 */
function best(s: TavlaState, memo = new Map<string, { len: number; maxDie: number }>()): { len: number; maxDie: number } {
  if (s.winner !== null || !s.dice.length) return { len: 0, maxDie: 0 };
  const key = `${s.points.join(",")}|${s.bar.join(",")}|${s.off.join(",")}|${s.dice.join(",")}`;
  const hit = memo.get(key);
  if (hit) return hit;
  let len = 0, maxDie = 0;
  for (const die of new Set(s.dice)) {
    for (const m of singleMoves(s, die)) {
      const r = best(apply(s, m), memo);
      if (r.len + 1 > len) len = r.len + 1;
      maxDie = Math.max(maxDie, die);
      if (len === s.dice.length) break; // daha uzunu olamaz
    }
  }
  const out = { len, maxDie };
  memo.set(key, out);
  return out;
}

/** Şu an yapılabilecek yasal tek hamleler (zar kuralına uyan). Boşsa tur pas geçer. */
export function tavlaMoves(s: TavlaState): TavlaMove[] {
  if (s.winner !== null || !s.dice.length) return [];
  const memo = new Map<string, { len: number; maxDie: number }>();
  const goal = best(s, memo);
  if (!goal.len) return [];
  const out: TavlaMove[] = [];
  for (const die of new Set(s.dice)) {
    for (const m of singleMoves(s, die)) {
      const rest = best(apply(s, m), memo);
      if (rest.len + 1 < goal.len) continue;
      // Yalnızca bir zar oynanabiliyorsa (iki farklı zar) büyüğü oynanmalı
      if (goal.len === 1 && s.dice.length === 2 && s.dice[0] !== s.dice[1] && die !== goal.maxDie) continue;
      out.push(m);
    }
  }
  return out;
}

/** Yasal hamleyse yeni durumu döner; zarlar bitince ya da hamle kalmayınca `needsRoll` true. */
export function tavlaMove(s: TavlaState, m: TavlaMove): { state: TavlaState; turnOver: boolean } | null {
  const legal = tavlaMoves(s).find((l) => l.from === m.from && l.to === m.to && l.die === m.die);
  if (!legal) return null;
  const state = apply(s, legal);
  return { state, turnOver: state.winner !== null || !tavlaMoves(state).length };
}

/** Sıra karşıya geçer, yeni zar atılır. */
export function tavlaNextTurn(s: TavlaState, dice: [number, number]): TavlaState {
  return { ...s, turn: (1 - s.turn) as Side, dice: rollDice(dice), rolled: [...dice] };
}
