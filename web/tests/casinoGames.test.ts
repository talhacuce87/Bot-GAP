import { describe, expect, it } from "vitest";
import {
  bjDeal, bjDouble, bjHit, bjSplit, bjStand, bjView, type Card, handValue, newShoe, numberColor, type RouletteBet, roulettePayout,
  rouletteWins, Shoe, slotLine, slotRtp, SLOT_STRIP, validBet, WHEEL,
} from "../shared/casino";

/** Kartları sırayla dağıtan deste (ilk eleman ilk çekilen). */
function stacked(...ranks: number[]): Shoe {
  const shoe = new Shoe(() => 0.5);
  shoe.cards = ranks.map((r, i): Card => ({ r, s: i % 4 })).reverse();
  return shoe;
}

describe("blackjack", () => {
  it("el değeri: As 11 ya da 1 (yumuşak)", () => {
    expect(handValue([{ r: 1, s: 0 }, { r: 13, s: 0 }])).toEqual({ total: 21, soft: true });
    expect(handValue([{ r: 1, s: 0 }, { r: 1, s: 1 }, { r: 9, s: 0 }])).toEqual({ total: 21, soft: true });
    expect(handValue([{ r: 1, s: 0 }, { r: 6, s: 1 }, { r: 10, s: 0 }])).toEqual({ total: 17, soft: false });
    expect(newShoe(Math.random).length).toBe(6 * 52);
  });

  it("dağıtım sırası oyuncu-krupiye-oyuncu-krupiye; krupiye yumuşak 17'de durur", () => {
    // Oyuncu 10+8 = 18, krupiye As+6 = yumuşak 17
    const shoe = stacked(10, 1, 8, 6, 5);
    const r = bjDeal(shoe, 100);
    expect(bjView(r).dealer[1]).toBeNull();
    bjStand(r, shoe);
    expect(r.dealer.length).toBe(2);
    expect(r.hands[0].result).toBe("win");
    expect(r.hands[0].payout).toBe(200);
  });

  it("blackjack 3:2 öder; krupiye blackjack'inde el hemen biter", () => {
    const bj = bjDeal(stacked(1, 9, 13, 7), 100);
    expect(bj.phase).toBe("done");
    expect(bj.hands[0].result).toBe("blackjack");
    expect(bj.hands[0].payout).toBe(250);
    const dealerBj = bjDeal(stacked(10, 1, 9, 12), 100);
    expect(dealerBj.phase).toBe("done");
    expect(dealerBj.hands[0].result).toBe("lose");
    const both = bjDeal(stacked(1, 1, 12, 13), 100);
    expect(both.hands[0].result).toBe("push");
    expect(both.hands[0].payout).toBe(100);
  });

  it("kart çek, patla; krupiye 17'ye kadar çeker", () => {
    const shoe = stacked(10, 10, 6, 6, 9);
    const r = bjDeal(shoe, 50);
    bjHit(r, shoe);
    expect(r.hands[0].result).toBe("bust");
    expect(r.phase).toBe("done");
    expect(r.hands[0].payout).toBe(0);
    // Oyuncu patladıysa krupiye çekmez
    expect(r.dealer.length).toBe(2);
  });

  it("ikiye katla: bahis iki katı, tek kart, el biter", () => {
    const shoe = stacked(5, 10, 6, 7, 10, 3);
    const r = bjDeal(shoe, 100);
    expect(bjView(r).canDouble).toBe(true);
    bjDouble(r, shoe);
    expect(r.hands[0].bet).toBe(200);
    expect(r.hands[0].cards.length).toBe(3);
    expect(handValue(r.hands[0].cards).total).toBe(21);
    // Krupiye 10+7 = 17 durur; 21 kazanır
    expect(r.hands[0].result).toBe("win");
    expect(r.hands[0].payout).toBe(400);
  });

  it("böl: iki el ayrı oynanır; bölünen 21 blackjack sayılmaz; Aslar birer kart alıp durur", () => {
    const shoe = stacked(8, 10, 8, 7, 3, 1, 10);
    const r = bjDeal(shoe, 100);
    expect(bjView(r).canSplit).toBe(true);
    bjSplit(r, shoe);
    expect(r.hands.length).toBe(2);
    expect(r.hands[0].cards.map((c) => c.r)).toEqual([8, 3]);
    expect(r.hands[1].cards.map((c) => c.r)).toEqual([8, 1]);
    bjDouble(r, shoe); // 8+3+10 = 21
    expect(r.active).toBe(1);
    bjStand(r, shoe); // 8+As = 19
    expect(r.phase).toBe("done");
    expect(r.hands.map((h) => h.result)).toEqual(["win", "win"]);
    expect(r.hands[0].payout).toBe(400);

    const aces = stacked(1, 9, 1, 8, 13, 12);
    const a = bjDeal(aces, 100);
    bjSplit(a, aces);
    expect(a.phase).toBe("done");
    expect(a.hands.every((h) => h.cards.length === 2)).toBe(true);
    expect(a.hands[0].result).toBe("win"); // bölünmüş As+Papaz = 21 ama blackjack değil: 1:1
    expect(a.hands[0].payout).toBe(200);
  });
});

describe("rulet", () => {
  it("çarktaki dizilim ve renkler", () => {
    expect(WHEEL.length).toBe(37);
    expect(new Set(WHEEL).size).toBe(37);
    expect(numberColor(0)).toBe("green");
    expect(numberColor(32)).toBe("red");
    expect(numberColor(15)).toBe("black");
  });

  it("ödemeler: tek sayı 35:1, düzine/kolon 2:1, dış bahisler 1:1; sıfırda dış bahisler kaybeder", () => {
    const bets: RouletteBet[] = [
      { kind: "n", v: 17, amount: 10 },
      { kind: "red", v: 0, amount: 100 },
      { kind: "dozen", v: 2, amount: 50 },
      { kind: "column", v: 2, amount: 20 },
    ];
    // 17: kırmızı değil (siyah), 2. düzine, 2. kolon
    expect(roulettePayout(bets, 17)).toBe(10 * 36 + 50 * 3 + 20 * 3);
    expect(roulettePayout(bets, 0)).toBe(0);
    expect(rouletteWins({ kind: "column", v: 3, amount: 10 }, 36)).toBe(true);
    expect(rouletteWins({ kind: "even", v: 0, amount: 10 }, 0)).toBe(false);
    expect(validBet({ kind: "n", v: 37, amount: 10 })).toBeNull();
    expect(validBet({ kind: "red", v: 0, amount: 5 })).toBeNull();
    expect(validBet({ kind: "dozen", v: 3, amount: 100 })).toEqual({ kind: "dozen", v: 3, amount: 100 });
  });

  it("evin avantajı tek sayıda ve renkte 1/37", () => {
    for (const b of [{ kind: "n", v: 7, amount: 10 }, { kind: "red", v: 0, amount: 10 }] as RouletteBet[]) {
      const ev = WHEEL.reduce((s, n) => s + roulettePayout([b], n), 0) / 37;
      expect(ev / 10).toBeCloseTo(36 / 37, 10);
    }
  });
});

describe("slot", () => {
  it("üçlü öder, tam iki kiraz yarım bahis; geri ödeme oranı %93–97", () => {
    const cherry = SLOT_STRIP.indexOf(0), seven = SLOT_STRIP.indexOf(5), bell = SLOT_STRIP.indexOf(2);
    expect(slotLine([seven, seven, seven]).mult).toBe(300);
    expect(slotLine([cherry, cherry, bell]).mult).toBe(0.5);
    expect(slotLine([cherry, bell, seven]).mult).toBe(0);
    const rtp = slotRtp();
    expect(rtp).toBeGreaterThan(0.93);
    expect(rtp).toBeLessThan(0.97);
  });
});
