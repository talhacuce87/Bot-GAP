import { describe, expect, it } from "vitest";
import { type Card, MIN_BET, REFILL_TO, Shoe, SLOT_STRIP, START_BALANCE } from "../shared/casino";
import type { ServerEvent } from "../shared/protocol";
import { Casino, Wallets } from "../server/src/casino";

/** Sıradaki rastgele sayılar (biterse 0.5). */
const seq = (...xs: number[]) => () => (xs.length ? xs.shift()! : 0.5);

function table(rng = () => 0.5) {
  const c = new Casino(new Wallets(null), rng);
  const play = (msg: Parameters<Casino["handle"]>[2], inside = true) => c.handle(1, "u", msg, inside);
  /** Başarılı olması beklenen hamle. */
  const ok = (msg: Parameters<Casino["handle"]>[2]): ServerEvent => {
    const r = play(msg);
    if ("error" in r) throw new Error(r.error);
    return r;
  };
  return { c, play, ok };
}

/** Ayakkabıyı belirli kartlarla doldurur (ilk eleman ilk çekilen). */
function stackShoe(c: Casino, ...ranks: number[]) {
  const shoe = new Shoe(() => 0.5);
  shoe.cards = ranks.map((r, i): Card => ({ r, s: i % 4 })).reverse();
  shoe.maybeShuffle = () => false;
  (c as unknown as { shoes: Map<number, Shoe> }).shoes.set(1, shoe);
}

describe("casino sunucusu", () => {
  it("yeni oyuncu test coinle başlar; casino dışında oynanmaz", () => {
    const { play } = table();
    expect(play({ t: "casino", op: "wallet" })).toEqual({ t: "wallet", balance: START_BALANCE });
    expect("error" in play({ t: "slot", bet: 10 }, false)).toBe(true);
  });

  it("blackjack: bahis düşülür, kazanç eklenir; ikiye katlamada ek bahis düşer", () => {
    const { c, ok } = table();
    stackShoe(c, 10, 9, 7, 8, 4);
    // Oyuncu 10+7, krupiye 9+8
    const dealt = ok({ t: "bj", op: "deal", bet: 100 });
    expect(dealt.t === "bj" && dealt.balance).toBe(START_BALANCE - 100);
    expect(dealt.t === "bj" && dealt.view.dealer[1]).toBeNull();
    const hit = ok({ t: "bj", op: "hit" }); // 21
    expect(hit.t === "bj" && hit.view.phase).toBe("done");
    expect(hit.t === "bj" && hit.balance).toBe(START_BALANCE + 100);

    stackShoe(c, 6, 10, 5, 7, 10);
    ok({ t: "bj", op: "deal", bet: 200 });
    const dbl = ok({ t: "bj", op: "double" }); // 6+5+10 = 21, krupiye 17
    expect(dbl.t === "bj" && dbl.view.hands[0].bet).toBe(400);
    expect(dbl.t === "bj" && dbl.balance).toBe(START_BALANCE + 100 + 400);
  });

  it("yetersiz bakiyede bahis alınmaz; bitince test coin doldurulur", () => {
    const { c, play } = table();
    expect("error" in play({ t: "bj", op: "deal", bet: 50_000 })).toBe(true);
    c.wallets.add("u", -(START_BALANCE - 5));
    expect("error" in play({ t: "slot", bet: 10 })).toBe(true);
    expect(play({ t: "casino", op: "refill" })).toEqual({ t: "wallet", balance: REFILL_TO });
    expect("error" in play({ t: "casino", op: "refill" })).toBe(true);
    expect(MIN_BET).toBe(10);
  });

  it("masadan kalkıp dönen oyuncunun yarım eli yeni bahis alınmadan sürer", () => {
    const { c, ok } = table();
    stackShoe(c, 10, 10, 6, 7, 5);
    ok({ t: "bj", op: "deal", bet: 100 });
    const again = ok({ t: "bj", op: "deal", bet: 500 });
    expect(again.t === "bj" && again.view.phase).toBe("player");
    expect(again.t === "bj" && again.view.hands[0].bet).toBe(100);
    expect(again.t === "bj" && again.balance).toBe(START_BALANCE - 100);
  });

  it("oyuncu elin ortasında çıkarsa el durur ve sonuçlanır", () => {
    const { c, play } = table();
    stackShoe(c, 10, 10, 9, 7, 5);
    play({ t: "bj", op: "deal", bet: 100 }); // 19'a karşı 17
    c.leave(1, "u");
    expect(c.wallets.get("u")).toBe(START_BALANCE + 100);
  });

  it("rulet ve slot: sonuç sunucuda, ödeme bakiyeye", () => {
    // Rulet 17 gelsin: 17/37 ≈ 0.4595
    const { ok } = table(seq(17.5 / 37));
    const r = ok({ t: "roulette", bets: [{ kind: "n", v: 17, amount: 10 }, { kind: "red", v: 0, amount: 10 }] });
    expect(r.t === "roulette" && r.n).toBe(17);
    expect(r.t === "roulette" && r.payout).toBe(360);
    expect(r.t === "roulette" && r.balance).toBe(START_BALANCE - 20 + 360);

    const seven = SLOT_STRIP.indexOf(5) + 0.5;
    const s = table(seq(seven / SLOT_STRIP.length, seven / SLOT_STRIP.length, seven / SLOT_STRIP.length));
    const spin = s.ok({ t: "slot", bet: 10 });
    expect(spin.t === "slot" && spin.mult).toBe(300);
    expect(spin.t === "slot" && spin.balance).toBe(START_BALANCE - 10 + 3000);
    expect("error" in s.play({ t: "slot", bet: 7 })).toBe(true);
  });
});
