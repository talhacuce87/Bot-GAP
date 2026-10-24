import { describe, expect, it } from "vitest";
import type { Card } from "../shared/casino";
import { LIVE_TABLES } from "../shared/liveCasino";
import { bestScore, handName, LivePoker, POKER, score5 } from "../shared/poker";
import { Wallets } from "../server/src/casino";

/** "As", "Kh", "Td", "2c" → kart (s: ♠0 ♥1 ♦2 ♣3). */
const c = (t: string): Card => {
  const r = "A23456789TJQK".indexOf(t[0]) + 1;
  return { r, s: "shdc".indexOf(t[1]) };
};
const cs = (t: string) => t.split(" ").map(c);

function table(n: number, buyIn = 1000) {
  const w = new Wallets(null);
  const t = new LivePoker(LIVE_TABLES[4], { take: (k, a) => w.add(k, -a), give: (k, a) => void w.add(k, a) }, () => 0.5);
  for (let i = 0; i < n; i++) expect(t.sit(i, i + 1, `p${i}`, `k${i}`, buyIn)).toBeNull();
  return { t, w };
}
/** El başlat (geri sayımı atlayarak). */
function deal(t: LivePoker, now = 0) {
  t.tick(now);
  t.tick(now + POKER.startMs);
}
const seat = (t: LivePoker, i: number) => t.seats[i]!;
/** Sıradaki oyuncunun sid'i. */
const turn = (t: LivePoker) => seat(t, t.toAct).sid;

describe("poker eli değerlendirme", () => {
  it("kategoriler ve eşitlik bozma", () => {
    expect(handName(score5(cs("As Ks Qs Js Ts")))).toBe("Royal flush");
    expect(score5(cs("2h 2d 2c 9s 9h"))).toBeGreaterThan(score5(cs("Ah Kh 9h 5h 3h")));
    // As-5 kenti (wheel) en küçük kent
    expect(handName(score5(cs("Ah 2d 3c 4s 5h")))).toBe("Kent · 5");
    expect(score5(cs("6h 2d 3c 4s 5h"))).toBeGreaterThan(score5(cs("Ah 2d 3c 4s 5h")));
    // İki çiftte kicker
    expect(score5(cs("Kh Kd 7c 7s Ah"))).toBeGreaterThan(score5(cs("Ks Kc 7h 7d Qh")));
    // 7 karttan en iyisi
    expect(handName(bestScore(cs("Ah Ad 7c 7s 7h 2d 9c")))).toBe("Ful · 7 / As");
  });
});

describe("canlı poker", () => {
  it("en az 4 oyuncu: 3 kişiyle el başlamaz, 4. oturunca geri sayım ve körler", () => {
    const { t, w } = table(3);
    expect(w.get("k0")).toBe(10_000 - 1000);
    expect(t.tick(0)).toBe(false);
    expect(t.phase).toBe("idle");
    t.sit(3, 4, "p3", "k3");
    deal(t);
    expect(t.phase).toBe("preflop");
    expect(t.view().pot).toBe(POKER.sb + POKER.bb);
    expect(seat(t, t.sbSeat).bet).toBe(POKER.sb);
    expect(seat(t, t.bbSeat).bet).toBe(POKER.bb);
    // Herkesin iki kartı var; kimse başkasının kartını görmez
    const v = t.view(1);
    expect(v.seats.filter((s) => s?.inHand).length).toBe(4);
    expect(v.seats[0]!.cards.every(Boolean)).toBe(true);
    expect(v.seats[1]!.cards).toEqual([null, null]);
    // Sıra büyük körün solunda
    expect(t.toAct).toBe((t.bbSeat + 1) % 7 === 4 ? 0 : (t.bbSeat + 1) % 7);
  });

  it("herkes pas derse büyük kör potu alır, yeni el başlar", () => {
    const { t } = table(4);
    deal(t);
    const bb = t.bbSeat;
    for (let k = 0; k < 3; k++) expect(t.act(turn(t), "fold", 10 + k)).toBeNull();
    expect(t.phase).toBe("showdown");
    expect(t.winners).toEqual([{ seat: bb, amount: 30, best: null }]);
    expect(seat(t, bb).stack).toBe(1010);
    t.tick(10_000);
    expect(t.phase).toBe("start");
  });

  it("check ve call ile river'a gidilir, showdown'da en iyi el kazanır", () => {
    const { t } = table(4);
    deal(t);
    // Kartları belirle: herkes 2 kart, masaya gelecek 5 kart
    const hands = ["Ah Ad", "Kh Kd", "7c 2d", "9s 8s"];
    hands.forEach((h, i) => (seat(t, i).cards = cs(h)));
    (t as unknown as { deck: Card[] }).deck = cs("3h 4c Jd 7d Ac").reverse();
    // Preflop: herkes call, büyük kör check
    while (t.phase === "preflop") t.act(turn(t), seat(t, t.toAct).bet < t.currentBet ? "call" : "check", 1);
    expect(t.board.length).toBe(3);
    while (t.phase !== "showdown") t.act(turn(t), "check", 2);
    expect(t.board.map((x) => x.r)).toEqual([3, 4, 11, 7, 1]);
    // As üçlüsü kazanır
    expect(t.winners).toEqual([{ seat: 0, amount: 80, best: "Üçlü · As" }]);
    expect(seat(t, 0).stack).toBe(1060);
    // Showdown'da eller herkese açık
    expect(t.view(3).seats[1]!.cards.every(Boolean)).toBe(true);
  });

  it("raise en az bir önceki artış kadar; all-in yan potu ayırır", () => {
    const { t } = table(4);
    t.seats[0]!.stack = 100; // kısa yığın
    deal(t);
    expect(t.act(turn(t), "raise", 25)).not.toBeNull(); // 20 + 20 = en az 40
    // Kartları belirle: kısa yığın (0) en iyi el, 1 ikinci
    ["Ah Ad", "Kh Kd", "7c 2d", "9s 8s"].forEach((h, i) => (seat(t, i).cards = cs(h)));
    (t as unknown as { deck: Card[] }).deck = cs("3h 4c Jd 6d 2c").reverse();
    // Sırayla: herkes 300'e çıkar ya da all-in
    while (t.phase === "preflop") {
      const s = seat(t, t.toAct);
      if (s.stack + s.bet <= 300) t.act(s.sid, "allin", 1);
      else if (t.currentBet < 300) t.act(s.sid, "raise", 1, 300);
      else t.act(s.sid, "call", 1);
    }
    while (t.phase !== "showdown") t.act(turn(t), "check", 2);
    // Ana pot: 4 × 100 = 400 → 0 (As çifti); yan pot: 3 × 200 = 600 → 1 (Papaz çifti)
    expect(t.winners.find((x) => x.seat === 0)?.amount).toBe(400);
    expect(t.winners.find((x) => x.seat === 1)?.amount).toBe(600);
  });

  it("süre dolunca check ya da pas; elin ortasında kalkan pas sayılır, parası cüzdana döner", () => {
    const { t, w } = table(4);
    deal(t);
    const first = t.toAct;
    t.tick(t.turnEndsAt); // call gerekiyordu: pas
    expect(seat(t, first).folded).toBe(true);
    const next = t.toAct;
    const sid = turn(t);
    t.leave(sid);
    expect(w.get(`k${next}`)).toBe(10_000);
    expect(t.toAct).not.toBe(next);
    expect(t.view().seats[next]?.gone).toBe(true);
  });
});
