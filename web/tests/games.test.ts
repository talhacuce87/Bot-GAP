import { describe, expect, it } from "vitest";
import { BILEK_LEAD_MS, BILEK_LOSE, bilekInitial, bilekLean, bilekPress, type BilekState, bilekTick } from "../shared/games/bilek";
import { chessInitial, chessMove, type ChessState, inCheck, legalMoves } from "../shared/games/chess";
import { isWinningHand, okeyDeal, okeyMove, type Tile } from "../shared/games/okey";
import { tavlaInitial, tavlaMove, tavlaMoves, type TavlaState } from "../shared/games/tavla";

const sq = (s: string) => (s.charCodeAt(1) - 49) * 8 + (s.charCodeAt(0) - 97);
const mv = (st: ChessState, from: string, to: string, promo?: string) => {
  const n = chessMove(st, { from: sq(from), to: sq(to), promo });
  if (!n) throw new Error(`yasal değil: ${from}-${to}`);
  return n;
};

describe("satranç", () => {
  it("başlangıçta 20 yasal hamle, yasal olmayan reddedilir", () => {
    const s = chessInitial();
    expect(legalMoves(s)).toHaveLength(20);
    expect(chessMove(s, { from: sq("e2"), to: sq("e5") })).toBeNull();
    expect(chessMove(s, { from: sq("e7"), to: sq("e5") })).toBeNull(); // sıra beyazda
  });

  it("çoban matı", () => {
    let s = chessInitial();
    for (const [a, b] of [["e2", "e4"], ["e7", "e5"], ["f1", "c4"], ["b8", "c6"], ["d1", "h5"], ["g8", "f6"], ["h5", "f7"]]) s = mv(s, a, b);
    expect(s.result).toBe("w");
    expect(s.reason).toBe("mat");
    expect(inCheck(s)).toBe(true);
  });

  it("rok, geçerken alma ve terfi", () => {
    let s: ChessState = { ...chessInitial(), board: "R...K..R" + "........".repeat(3) + "...p...." + "........" + "P......." + "....k...", turn: "w", castling: "KQ" };
    s = mv(s, "e1", "g1");
    expect(s.board.slice(0, 8)).toBe("R....RK.");
    // Siyah şah oynar, beyaz a piyonu terfi eder (a7 → a8 at)
    s = mv(s, "e8", "d8");
    s = mv(s, "a7", "a8", "n");
    expect(s.board[sq("a8")]).toBe("N");

    let e: ChessState = { ...chessInitial(), board: "....K..." + "....P..." + "........" + "...p...." + "........" + "........" + "........" + "....k...", turn: "w", castling: "" };
    e = mv(e, "e2", "e4");
    expect(e.ep).toBe(sq("e3"));
    e = mv(e, "d4", "e3");
    expect(e.board[sq("e4")]).toBe(".");
  });

  it("şah tehdit altındayken rok yok, kendini şaha sokan hamle yok", () => {
    const s: ChessState = { ...chessInitial(), board: "....K..R" + "........".repeat(3) + "....r..." + "........".repeat(2) + "k.......", turn: "w", castling: "K" };
    expect(chessMove(s, { from: sq("e1"), to: sq("g1") })).toBeNull();
    expect(legalMoves(s).every((m) => m.from !== sq("e1") || m.to !== sq("e2"))).toBe(true);
  });
});

describe("tavla", () => {
  const empty = (turn: 0 | 1, dice: number[]): TavlaState => ({
    points: new Array(24).fill(0), bar: [0, 0], off: [0, 0], turn, dice, rolled: dice, winner: null, mars: false,
  });

  it("açılışta 3-1 ile 8 ve 6'dan 5'e kapı", () => {
    const s = tavlaInitial(0, [3, 1]);
    const moves = tavlaMoves(s);
    expect(moves.some((m) => m.from === 7 && m.to === 4 && m.die === 3)).toBe(true);
    let r = tavlaMove(s, { from: 7, to: 4, die: 3 })!;
    expect(r.turnOver).toBe(false);
    r = tavlaMove(r.state, { from: 5, to: 4, die: 1 })!;
    expect(r.turnOver).toBe(true);
    expect(r.state.points[4]).toBe(2);
  });

  it("bardaki pul önce girmeli, kapalı kapıya girilmez", () => {
    const s = empty(0, [6, 6, 6, 6]);
    s.bar[0] = 1;
    s.points[18] = -2; // 24 - 6 = 18 kapalı
    s.points[10] = 3;
    expect(tavlaMoves(s)).toEqual([]);
    s.dice = [5, 2];
    s.rolled = [5, 2];
    expect(tavlaMoves(s).every((m) => m.from === -1)).toBe(true);
  });

  it("tek zar oynanabiliyorsa büyüğü oynanır ve toplama kuralları", () => {
    const s = empty(0, [6, 2]);
    s.points[3] = 1;
    s.points[0] = 1;
    s.off[0] = 13;
    // Ev dolu: 6 ile 4. noktadan (zar 4 < 6, daha geride pul yok) topla
    const moves = tavlaMoves(s);
    expect(moves.some((m) => m.from === 3 && m.to === -1 && m.die === 6)).toBe(true);
    let r = tavlaMove(s, { from: 3, to: -1, die: 6 })!;
    r = tavlaMove(r.state, { from: 0, to: -1, die: 2 })!;
    expect(r.state.winner).toBe(0);
    expect(r.state.mars).toBe(true);
  });

  it("vurulan pul bara çıkar", () => {
    const s = empty(1, [3, 1]);
    s.points[2] = -1;
    s.points[5] = 1;
    const r = tavlaMove(s, { from: 2, to: 5, die: 3 })!;
    expect(r.state.bar[0]).toBe(1);
    expect(r.state.points[5]).toBe(-1);
  });
});

describe("okey", () => {
  const id = (color: number, num: number, copy = 0) => ((color * 13 + num - 1) * 2 + copy);
  const okey: Tile = { color: 3, num: 5 }; // kırmızı 5 joker

  it("seri ve perlerle biten el", () => {
    const hand = [
      id(0, 1), id(0, 2), id(0, 3),
      id(1, 7), id(2, 7), id(0, 7),
      id(2, 11), id(2, 12), id(2, 13), id(2, 1),
      id(1, 4), id(1, 5), id(1, 6), id(1, 8, 1),
    ];
    // 1-4-5-6 mavi + 8 mavi kopuk: okeysiz bitmez
    expect(isWinningHand(hand, okey)).toBe(false);
    hand[13] = id(3, 5); // okey (kırmızı 5) mavi 7'nin yerine… seriye 4-5-6-[okey] olarak
    expect(isWinningHand(hand, okey)).toBe(true);
  });

  it("13-1-2 seri sayılmaz, çifte bitiş olur", () => {
    const bad = [id(0, 13), id(0, 1), id(0, 2), id(1, 3), id(1, 4), id(1, 5), id(2, 3), id(2, 4), id(2, 5), id(0, 9), id(1, 9), id(2, 9), id(0, 6), id(0, 7)];
    expect(isWinningHand(bad, okey)).toBe(false);
    const pairs = [1, 2, 3, 4, 6, 8, 9].flatMap((n) => [id(0, n, 0), id(0, n, 1)]);
    expect(isWinningHand(pairs, okey)).toBe(true);
  });

  it("dağıtım, çekme ve atma sırası", () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const s = okeyDeal(4, rand);
    expect(s.hands.map((h) => h.length)).toEqual([15, 14, 14, 14]);
    expect(s.pile.length).toBe(106 - 1 - 57);
    expect(okeyMove(s, 0, { kind: "draw", from: "pile" })).toBeNull(); // ilk oyuncu önce atar
    const a = okeyMove(s, 0, { kind: "discard", tile: s.hands[0][0] })!;
    expect(a.turn).toBe(1);
    const b = okeyMove(a, 1, { kind: "draw", from: "left" })!;
    expect(b.hands[1]).toContain(s.hands[0][0]);
    expect(okeyMove(b, 1, { kind: "discard", tile: b.hands[1][0], finish: true })).toBeNull();
  });
});

describe("bilek güreşi", () => {
  const rand = () => 0.5;
  /** İlk turu başlatır: iki çember gelir, ibre BILEK_LEAD_MS sonra döner. */
  const round = (s: BilekState, now: number): BilekState => bilekTick(s, Math.max(now, s.next), rand)!;
  const mid = (s: BilekState, side: 0 | 1) => s.checks[side]!.zone + s.checks[side]!.width / 2;
  const pressAt = (s: BilekState, side: 0 | 1, p: number) => {
    const c = s.checks[side]!;
    return bilekPress(s, side, { kind: "press", n: c.n, p }, c.at + p * c.dur, rand);
  };

  it("yayda basan tutturur, dışında basan kaçırır ve kol ona yatar", () => {
    let s = round(bilekInitial(0), 0);
    expect(s.round).toBe(1);
    s = pressAt(s, 0, mid(s, 0))!;
    expect(s.checks[0]!.res).toBe("hit");
    s = pressAt(s, 1, s.checks[1]!.zone - 0.1)!;
    expect(s.checks[1]!.res).toBe("miss");
    expect(s.misses).toEqual([0, 1]);
    expect(bilekLean(s)).toBeLessThan(0);
    expect(s.next).toBeGreaterThan(0);
  });

  it("basmayan tur bitince kaçırır; ibre dönmeden basmak sayılmaz", () => {
    let s = round(bilekInitial(0), 0);
    const c = s.checks[0]!;
    expect(bilekPress(s, 0, { kind: "press", n: c.n, p: -0.1 }, c.at - BILEK_LEAD_MS / 2, rand)).toBeNull();
    s = pressAt(s, 1, mid(s, 1))!;
    expect(bilekTick(s, c.at + c.dur, rand)).toBeNull();
    s = bilekTick(s, c.at + c.dur + 1000, rand)!;
    expect(s.misses).toEqual([1, 0]);
  });

  it("geçmişe dönük basış (yaya denk gelen eski konum) kaçırmadır", () => {
    const s = round(bilekInitial(0), 0);
    const c = s.checks[0]!;
    const late = bilekPress(s, 0, { kind: "press", n: c.n, p: mid(s, 0) }, c.at + c.dur + 400 + mid(s, 0) * c.dur, rand)!;
    expect(late.checks[0]!.res).toBe("miss");
  });

  it(`${BILEK_LOSE} kaçırma farkında kaçıran kaybeder`, () => {
    let s = bilekInitial(0);
    for (let i = 0; i < BILEK_LOSE; i++) {
      expect(s.winner).toBeNull();
      s = round(s, 0);
      s = pressAt(s, 0, mid(s, 0))!;
      s = pressAt(s, 1, 0.01)!;
    }
    expect(s.winner).toBe(0);
    expect(bilekLean(s)).toBe(-1);
    expect(bilekTick(s, s.checks[0]!.at + 99999, rand)).toBeNull();
  });

  it("turlar hızlanır ve yay daralır", () => {
    let s = round(bilekInitial(0), 0);
    const first = s.checks[0]!;
    for (let i = 0; i < 10; i++) {
      s = pressAt(s, 0, mid(s, 0))!;
      s = pressAt(s, 1, mid(s, 1))!;
      s = round(s, 0);
    }
    expect(s.misses).toEqual([0, 0]);
    expect(s.checks[0]!.dur).toBeLessThan(first.dur);
    expect(s.checks[0]!.width).toBeLessThan(first.width);
  });
});
