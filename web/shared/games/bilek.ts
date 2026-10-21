// Bilek güreşi: iki oyuncuya aynı anda "skill check" gelir (çemberde dönen ibre, üstünde isabet yayı).
// İbre yaydayken basan tutturur; erken/geç basan ya da tur bitene kadar basmayan kaçırır. Kaçıran tarafa
// kol eğilir; kaçırma farkı BILEK_LOSE olunca o tarafın bileği masaya değer ve kaybeder. Turlar hızlanır,
// yay daralır (ikisi de hep tuttursa bile oyun biter). Zamanlar sunucu saatinde (ms).

export type BilekSide = 0 | 1;

export interface BilekCheck {
  /** Tur numarası (basış hangi tura ait). */
  n: number;
  /** İbrenin dönmeye başladığı an; öncesinde çember görünür, ibre tepede bekler. */
  at: number;
  /** Bir tam tur (ms). */
  dur: number;
  /** İsabet yayının başı ve genişliği (tur kesri, 0 tepe, saat yönünde). */
  zone: number;
  width: number;
  res: "hit" | "miss" | null;
  /** Sonucun belli olduğu an (gösterim). */
  done: number;
}

export interface BilekState {
  round: number;
  misses: [number, number];
  checks: [BilekCheck | null, BilekCheck | null];
  /** Sonraki turun başlayacağı an (0: tur sürüyor). */
  next: number;
  winner: BilekSide | null;
}

export interface BilekMove {
  kind: "press";
  n: number;
  /** Basış anında ibrenin istemcide gördüğü konumu (tur kesri). */
  p: number;
}

/** Bu kadar kaçırma farkında bilek masaya değer. */
export const BILEK_LOSE = 5;
/** İbre dönmeden önce çemberin göründüğü süre. */
export const BILEK_LEAD_MS = 700;
/** Başlatınca ilk tura kadar. */
const FIRST_MS = 1500;
/** Turlar arası bekleme (en az, ek rastgele). */
const GAP_MS = 700;
const GAP_RAND_MS = 700;
/** Basış bu kadar geç gelebilir (gidiş gecikmesi); ibre turu bitince de bu kadar beklenir. */
const LATE_MS = 450;
/** Saat farkı payı: basış sunucunun gördüğünden bu kadar ileride olabilir. */
const EARLY_MS = 120;
/** Yay kenarında küçük tolerans (tur kesri). */
const EDGE = 0.012;

/** n. turun hızı ve yay genişliği: her tur biraz daha zor. */
export function bilekPace(n: number): { dur: number; width: number } {
  return { dur: Math.max(650, 1500 - (n - 1) * 60), width: Math.max(0.07, 0.17 - (n - 1) * 0.007) };
}

export function bilekInitial(now: number): BilekState {
  return { round: 0, misses: [0, 0], checks: [null, null], next: now + FIRST_MS, winner: null };
}

/** -1..1: + tarafta 0'ın bileği masaya yaklaşır (0 daha çok kaçırdı). */
export function bilekLean(s: BilekState): number {
  return Math.max(-1, Math.min(1, (s.misses[0] - s.misses[1]) / BILEK_LOSE));
}

export function bilekProgress(c: BilekCheck, now: number): number {
  return (now - c.at) / c.dur;
}

export function bilekInZone(c: BilekCheck, p: number): boolean {
  return p >= c.zone - EDGE && p <= c.zone + c.width + EDGE;
}

function resolve(s: BilekState, side: BilekSide, res: "hit" | "miss", now: number, rand: () => number): BilekState {
  const checks = [...s.checks] as BilekState["checks"];
  checks[side] = { ...checks[side]!, res, done: now };
  const misses = [...s.misses] as [number, number];
  if (res === "miss") misses[side]++;
  const other = (1 - side) as BilekSide;
  const winner = misses[side] - misses[other] >= BILEK_LOSE ? other : null;
  const done = checks.every((c) => !c || c.res);
  return { ...s, checks, misses, winner, next: done && winner === null ? now + GAP_MS + rand() * GAP_RAND_MS : 0 };
}

/** Basış: yayda ve zamanı tutarlıysa isabet, değilse kaçırma. İbre dönmeden basmak sayılmaz (null). */
export function bilekPress(s: BilekState, side: BilekSide, m: BilekMove, now: number, rand: () => number = Math.random): BilekState | null {
  const c = s.checks[side];
  if (s.winner !== null || !c || c.res || c.n !== m.n || !Number.isFinite(m.p) || m.p < 0) return null;
  const pressedAt = c.at + m.p * c.dur;
  const honest = pressedAt <= now + EARLY_MS && pressedAt >= now - LATE_MS;
  return resolve(s, side, honest && bilekInZone(c, m.p) ? "hit" : "miss", now, rand);
}

/** Zamanla değişen: yeni tur, süresi dolan (basılmayan) turlar kaçırma. Değişiklik yoksa null. */
export function bilekTick(s: BilekState, now: number, rand: () => number = Math.random): BilekState | null {
  if (s.winner !== null) return null;
  let out: BilekState | null = null;
  for (const side of [0, 1] as const) {
    const c = (out ?? s).checks[side];
    if (c && !c.res && now > c.at + c.dur + LATE_MS) out = resolve(out ?? s, side, "miss", now, rand);
    if (out?.winner != null) return out;
  }
  const cur = out ?? s;
  if (cur.next && now >= cur.next) {
    const n = cur.round + 1;
    const { dur, width } = bilekPace(n);
    const at = now + BILEK_LEAD_MS;
    const check = (): BilekCheck => ({ n, at, dur, width, zone: 0.3 + rand() * (0.92 - 0.3 - width), res: null, done: 0 });
    return { ...cur, round: n, checks: [check(), check()], next: 0 };
  }
  return out;
}
