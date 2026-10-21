// Satranç kuralları: yasal hamle üretimi (rok, geçerken alma, terfi), şah, mat, pat ve basit beraberlikler.
// Tahta 64 karakterlik dizi: büyük harf beyaz (PNBRQK), küçük harf siyah, "." boş. İndeks = sıra*8 + sütun,
// sıra 0 beyazın ilk sırası (a1 = 0, h8 = 63).

export type Color = "w" | "b";

export interface ChessState {
  board: string;
  turn: Color;
  /** Kalan rok hakları: "KQkq" alt kümesi. */
  castling: string;
  /** Geçerken alınabilecek kare (-1: yok). */
  ep: number;
  /** 50 hamle kuralı sayacı (yarım hamle). */
  halfmove: number;
  /** Bitmişse kazanan ("draw": berabere). */
  result: Color | "draw" | null;
  reason: "" | "mat" | "pat" | "terk" | "50 hamle" | "yetersiz taş" | "süre";
  /** Son hamle (tahtada vurgulanır). */
  last: { from: number; to: number } | null;
}

export interface ChessMove {
  from: number;
  to: number;
  /** Terfi taşı (q, r, b, n); verilmezse vezir. */
  promo?: string;
}

const START = "RNBQKBNR" + "PPPPPPPP" + "........".repeat(4) + "pppppppp" + "rnbqkbnr";

export function chessInitial(): ChessState {
  return { board: START, turn: "w", castling: "KQkq", ep: -1, halfmove: 0, result: null, reason: "", last: null };
}

const colorOf = (p: string): Color | null => (p === "." ? null : p === p.toUpperCase() ? "w" : "b");
const file = (i: number) => i & 7;
const rank = (i: number) => i >> 3;
const onBoard = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** `sq` karesi `by` rengince tehdit ediliyor mu. */
export function attacked(board: string, sq: number, by: Color): boolean {
  const f0 = file(sq), r0 = rank(sq);
  const is = (f: number, r: number, kinds: string) => {
    if (!onBoard(f, r)) return false;
    const p = board[r * 8 + f];
    return colorOf(p) === by && kinds.includes(p.toLowerCase());
  };
  const dir = by === "w" ? -1 : 1; // piyon saldırısı: beyaz piyon aşağıdan saldırır
  if (is(f0 - 1, r0 + dir, "p") || is(f0 + 1, r0 + dir, "p")) return true;
  for (const [df, dr] of KNIGHT) if (is(f0 + df, r0 + dr, "n")) return true;
  for (const [df, dr] of KING) if (is(f0 + df, r0 + dr, "k")) return true;
  const ray = (dirs: number[][], kinds: string) => {
    for (const [df, dr] of dirs) {
      let f = f0 + df, r = r0 + dr;
      while (onBoard(f, r)) {
        const p = board[r * 8 + f];
        if (p !== ".") {
          if (colorOf(p) === by && kinds.includes(p.toLowerCase())) return true;
          break;
        }
        f += df;
        r += dr;
      }
    }
    return false;
  };
  return ray(ROOK, "rq") || ray(BISHOP, "bq");
}

export function inCheck(s: ChessState, c: Color = s.turn): boolean {
  const k = s.board.indexOf(c === "w" ? "K" : "k");
  return k >= 0 && attacked(s.board, k, c === "w" ? "b" : "w");
}

function pseudoMoves(s: ChessState): ChessMove[] {
  const out: ChessMove[] = [];
  const b = s.board, me = s.turn, them: Color = me === "w" ? "b" : "w";
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (colorOf(p) !== me) continue;
    const f0 = file(i), r0 = rank(i), kind = p.toLowerCase();
    const push = (f: number, r: number) => {
      const to = r * 8 + f;
      if (kind === "p" && (r === 7 || r === 0)) for (const promo of "qrbn") out.push({ from: i, to, promo });
      else out.push({ from: i, to });
    };
    if (kind === "p") {
      const dir = me === "w" ? 1 : -1, startRank = me === "w" ? 1 : 6;
      if (onBoard(f0, r0 + dir) && b[(r0 + dir) * 8 + f0] === ".") {
        push(f0, r0 + dir);
        if (r0 === startRank && b[(r0 + 2 * dir) * 8 + f0] === ".") push(f0, r0 + 2 * dir);
      }
      for (const df of [-1, 1]) {
        const f = f0 + df, r = r0 + dir;
        if (!onBoard(f, r)) continue;
        const t = r * 8 + f;
        if (colorOf(b[t]) === them || t === s.ep) push(f, r);
      }
    } else if (kind === "n" || kind === "k") {
      for (const [df, dr] of kind === "n" ? KNIGHT : KING) {
        const f = f0 + df, r = r0 + dr;
        if (onBoard(f, r) && colorOf(b[r * 8 + f]) !== me) push(f, r);
      }
      if (kind === "k") {
        // Rok: şah ve kale yerinde, arası boş, şah tehdit altında değil ve geçtiği kare tehdit edilmiyor
        const home = me === "w" ? 0 : 56;
        if (i === home + 4 && !attacked(b, i, them)) {
          const [ks, qs] = me === "w" ? ["K", "Q"] : ["k", "q"];
          if (s.castling.includes(ks) && b[home + 5] === "." && b[home + 6] === "." && !attacked(b, home + 5, them)) out.push({ from: i, to: home + 6 });
          if (s.castling.includes(qs) && b[home + 3] === "." && b[home + 2] === "." && b[home + 1] === "." && !attacked(b, home + 3, them)) out.push({ from: i, to: home + 2 });
        }
      }
    } else {
      const dirs = kind === "r" ? ROOK : kind === "b" ? BISHOP : [...ROOK, ...BISHOP];
      for (const [df, dr] of dirs) {
        let f = f0 + df, r = r0 + dr;
        while (onBoard(f, r)) {
          const c = colorOf(b[r * 8 + f]);
          if (c === me) break;
          push(f, r);
          if (c === them) break;
          f += df;
          r += dr;
        }
      }
    }
  }
  return out;
}

/** Hamleyi kurallara bakmadan uygular (yalnızca yasal hamlelerle çağrılır). */
function play(s: ChessState, m: ChessMove): ChessState {
  const b = s.board.split("");
  const p = b[m.from], kind = p.toLowerCase(), me = s.turn;
  const capture = b[m.to] !== "." || (kind === "p" && m.to === s.ep);
  if (kind === "p" && m.to === s.ep) b[m.to + (me === "w" ? -8 : 8)] = ".";
  b[m.to] = p;
  b[m.from] = ".";
  if (kind === "p" && (rank(m.to) === 7 || rank(m.to) === 0)) {
    const promo = "qrbn".includes(m.promo ?? "") ? m.promo! : "q";
    b[m.to] = me === "w" ? promo.toUpperCase() : promo;
  }
  if (kind === "k" && Math.abs(m.to - m.from) === 2) {
    // Rok: kale şahın öbür yanına
    const home = me === "w" ? 0 : 56;
    if (m.to === home + 6) {
      b[home + 5] = b[home + 7];
      b[home + 7] = ".";
    } else {
      b[home + 3] = b[home];
      b[home] = ".";
    }
  }
  let castling = s.castling;
  const strip = (chars: string) => (castling = castling.replace(new RegExp(`[${chars}]`, "g"), ""));
  if (p === "K") strip("KQ");
  if (p === "k") strip("kq");
  for (const sq of [m.from, m.to]) {
    if (sq === 0) strip("Q");
    if (sq === 7) strip("K");
    if (sq === 56) strip("q");
    if (sq === 63) strip("k");
  }
  const ep = kind === "p" && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) / 2 : -1;
  return {
    board: b.join(""),
    turn: me === "w" ? "b" : "w",
    castling,
    ep,
    halfmove: kind === "p" || capture ? 0 : s.halfmove + 1,
    result: null,
    reason: "",
    last: { from: m.from, to: m.to },
  };
}

export function legalMoves(s: ChessState): ChessMove[] {
  if (s.result) return [];
  return pseudoMoves(s).filter((m) => !inCheck(play(s, m), s.turn));
}

function insufficient(board: string): boolean {
  const pieces = board.replace(/[.kK]/g, "");
  return pieces === "" || pieces === "b" || pieces === "B" || pieces === "n" || pieces === "N";
}

/** Yasal hamleyse yeni durumu (bitiş dahil), değilse null döner. */
export function chessMove(s: ChessState, m: ChessMove): ChessState | null {
  const legal = legalMoves(s).find((l) => l.from === m.from && l.to === m.to && (l.promo === undefined || l.promo === (m.promo ?? "q")));
  if (!legal) return null;
  const next = play(s, legal);
  if (!legalMoves(next).length) {
    next.result = inCheck(next) ? s.turn : "draw";
    next.reason = inCheck(next) ? "mat" : "pat";
  } else if (next.halfmove >= 100) {
    next.result = "draw";
    next.reason = "50 hamle";
  } else if (insufficient(next.board)) {
    next.result = "draw";
    next.reason = "yetersiz taş";
  }
  return next;
}
