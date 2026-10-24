import { describe, expect, it } from "vitest";
import { betNumbers, type Card, perfectPair, roulettePayout, type Shoe, START_BALANCE, twentyOnePlus3, validBet } from "../shared/casino";
import { BJ_SEATS, LIVE_T, LIVE_TABLES, LiveBlackjack, LiveRoulette, SIDE_MAX, validBjBets } from "../shared/liveCasino";
import type { ServerEvent } from "../shared/protocol";
import { LiveHost } from "../server/src/liveTables";
import { Wallets } from "../server/src/casino";

function wallet() {
  const w = new Wallets(null);
  return {
    w,
    take: (k: string, a: number) => w.add(k, -a),
    give: (k: string, a: number) => void w.add(k, a),
  };
}

/** Ayakkabıyı belirli kartlarla doldurur (ilk eleman ilk çekilen). */
function stack(t: LiveBlackjack, ...ranks: number[]) {
  const shoe = (t as unknown as { shoe: Shoe }).shoe;
  shoe.cards = ranks.map((r, i): Card => ({ r, s: i % 4 })).reverse();
  shoe.maybeShuffle = () => false;
}

describe("canlı rulet", () => {
  it("kimse oturmuyorsa tur dönmez; oturunca bahis → çark → sonuç → yeni tur", () => {
    const { w, ...wal } = wallet();
    const t = new LiveRoulette(LIVE_TABLES[0], wal, () => 17.5 / 37);
    expect(t.tick(0)).toBe(false);
    expect(t.phase).toBe("idle");
    t.sit(0, 1, "a", "a");
    t.tick(1000);
    expect(t.phase).toBe("bet");
    expect(t.endsAt).toBe(1000 + LIVE_T.rlBet);
    // Bahis değiştirilebilir: önceki iade, yenisi düşülür
    expect(t.bet(1, [{ kind: "n", v: 0, amount: 500 }])).toBeNull();
    expect(t.bet(1, [{ kind: "n", v: 17, amount: 10 }, { kind: "red", v: 0, amount: 10 }])).toBeNull();
    expect(w.get("a")).toBe(START_BALANCE - 20);
    expect(t.view().n).toBeNull();
    t.tick(t.endsAt);
    expect(t.phase).toBe("spin");
    expect(t.bet(1, [])).not.toBeNull(); // bahisler kapandı
    expect(t.view().n).toBe(17);
    t.tick(t.endsAt);
    expect(t.phase).toBe("result");
    expect(t.seats[0]?.payout).toBe(360);
    expect(w.get("a")).toBe(START_BALANCE - 20 + 360);
    expect(t.history[0]).toBe(17);
    t.tick(t.endsAt);
    expect(t.phase).toBe("bet");
    expect(t.seats[0]?.bets).toEqual([]);
  });

  it("bahis süresinde kalkan parasını geri alır; masa boşalınca durur", () => {
    const { w, ...wal } = wallet();
    const t = new LiveRoulette(LIVE_TABLES[0], wal, () => 0.5);
    t.sit(1, 2, "b", "b");
    expect(t.sit(1, 3, "c", "c")).not.toBeNull(); // dolu
    t.tick(0);
    t.bet(2, [{ kind: "black", v: 0, amount: 100 }]);
    t.leave(2);
    expect(w.get("b")).toBe(START_BALANCE);
    t.tick(t.endsAt);
    t.tick(t.endsAt);
    t.tick(t.endsAt);
    expect(t.phase).toBe("idle");
  });
});

describe("canlı blackjack", () => {
  it("iki oyuncu sırayla oynar, süre dolan durur, krupiye oynar, kazanan ödenir", () => {
    const { w, ...wal } = wallet();
    const t = new LiveBlackjack(LIVE_TABLES[2], wal, () => 0.5);
    t.sit(0, 1, "a", "a");
    t.sit(3, 2, "b", "b");
    t.tick(0);
    expect(t.phase).toBe("bet");
    t.bet(1, { main: 100 });
    t.bet(2, { main: 200 });
    // Sıra: a, b, a, b, krupiye, krupiye; sonra çekilenler
    stack(t, 10, 10, 9, 8, 10, 6, 2);
    t.tick(t.endsAt);
    expect(t.phase).toBe("play");
    const v = t.view();
    expect(v.dealer[1]).toBeNull();
    expect(v.hands.map((h) => h.seat)).toEqual([0, 3]);
    expect(v.active).toBe(0);
    expect(t.act(2, "hit", 10)).not.toBeNull(); // sıra a'da
    expect(t.act(1, "stand", 10)).toBeNull(); // a 19'da durur
    expect(t.view().active).toBe(1);
    // b karar vermez: süre dolunca 18'de durur
    t.tick(t.turnEndsAt);
    expect(t.phase).toBe("dealer");
    // Krupiye 16 → 2 çeker: 18
    const hands = t.view().hands;
    expect(hands[0].result).toBe("win");
    expect(hands[1].result).toBe("push");
    expect(w.get("a")).toBe(START_BALANCE + 100);
    expect(w.get("b")).toBe(START_BALANCE);
    t.tick(t.endsAt);
    expect(t.phase).toBe("result");
    t.tick(t.endsAt);
    expect(t.phase).toBe("bet");
  });

  it("kimse bahis koymazsa bahis süresi yeniden başlar; kimse oturmuyorsa durur", () => {
    const wal = wallet();
    const t = new LiveBlackjack(LIVE_TABLES[2], wal, () => 0.5);
    expect(t.tick(0)).toBe(false);
    t.sit(2, 1, "a", "a");
    t.tick(0);
    t.tick(t.endsAt);
    expect(t.phase).toBe("bet");
    t.leave(1);
    t.tick(t.endsAt);
    expect(t.phase).toBe("idle");
  });

  it("bölmede yeni el aynı oyuncunun, ek bahis düşülür; elin ortasında kalkan durur", () => {
    const { w, ...wal } = wallet();
    const t = new LiveBlackjack(LIVE_TABLES[3], wal, () => 0.5);
    t.sit(0, 1, "a", "a");
    t.sit(1, 2, "b", "b");
    t.tick(0);
    t.bet(1, { main: 100 });
    t.bet(2, { main: 100 });
    stack(t, 8, 10, 8, 9, 10, 7, 3, 2);
    t.tick(t.endsAt);
    expect(t.view().canSplit).toBe(true);
    t.act(1, "split", 1);
    expect(w.get("a")).toBe(START_BALANCE - 200);
    expect(t.view().hands.map((h) => h.seat)).toEqual([0, 0, 1]);
    t.leave(1);
    t.tick(2); // a'nın elleri kendiliğinden durur
    t.tick(3);
    expect(t.view().active).toBe(2);
  });
});

describe("canlı masa sunucusu", () => {
  function host() {
    const sent: [number, ServerEvent][] = [];
    const wallets = new Wallets(null);
    const players = new Map<number, { info: { name: string }; state: { x: number; z: number }; conn: { sid: number } }>();
    const room = {
      players: { get: (sid: number) => players.get(sid) },
      sendTo: (conn: unknown, ev: ServerEvent) => sent.push([(conn as { sid: number }).sid, ev]),
    };
    const h = new LiveHost(room as never, wallets, () => 0.5);
    const add = (sid: number, x: number, z: number) => players.set(sid, { info: { name: `p${sid}` }, state: { x, z }, conn: { sid } });
    return { h, sent, add, players, wallets };
  }

  it("taburede oturulur, uzaktan oturulamaz; izleyen de masayı görür", () => {
    const { h, sent, add } = host();
    const d = LIVE_TABLES[0];
    add(1, d.seats[0].x, d.seats[0].z);
    add(2, d.x, d.z + 4);
    add(3, d.x + 20, d.z);
    expect(h.handle(3, "c", { t: "live", op: "watch", table: 0 }, 0)).not.toBeNull();
    expect(h.handle(2, "b", { t: "live", op: "sit", table: 0, seat: 0 }, 0)).not.toBeNull();
    expect(h.handle(2, "b", { t: "live", op: "watch", table: 0 }, 0)).toBeNull();
    expect(h.handle(1, "a", { t: "live", op: "sit", table: 0, seat: 0 }, 0)).toBeNull();
    const last = sent.filter(([sid, e]) => sid === 2 && e.t === "live").pop()?.[1];
    expect(last?.t === "live" && last.table.phase).toBe("bet");
    expect(last?.t === "live" && last.table.seats[0]?.name).toBe("p1");
    // İzleyici bahis koyamaz
    expect(h.handle(2, "b", { t: "live", op: "bet", bets: [{ kind: "red", v: 0, amount: 10 }] }, 1)).not.toBeNull();
  });

  it("bahis bakiyeyi günceller; çıkan oyuncu masadan kalkar", () => {
    const { h, sent, add, wallets } = host();
    const d = LIVE_TABLES[2];
    add(1, d.seats[2].x, d.seats[2].z);
    h.handle(1, "a", { t: "live", op: "sit", table: 2, seat: 2 }, 0);
    expect(h.handle(1, "a", { t: "live", op: "bet", bj: { main: 250, pp: 0, t21: 0 } }, 1)).toBeNull();
    expect(wallets.get("a")).toBe(START_BALANCE - 250);
    expect(sent.some(([, e]) => e.t === "wallet" && e.balance === START_BALANCE - 250)).toBe(true);
    h.leave(1, 2);
    expect(wallets.get("a")).toBe(START_BALANCE);
    expect(h.view(2)?.seats.every((s) => !s)).toBe(true);
  });
});

describe("canlı blackjack: Evolution kuralları", () => {
  it("7 koltuk; yan bahisler ana bahissiz konmaz ve sınırlı", () => {
    expect(LIVE_TABLES[2].seats).toHaveLength(BJ_SEATS);
    expect(BJ_SEATS).toBe(7);
    expect(typeof validBjBets({ pp: 10 })).toBe("string");
    expect(typeof validBjBets({ main: 100, t21: SIDE_MAX + 10 })).toBe("string");
    expect(validBjBets({ main: 100, pp: 25 })).toEqual({ main: 100, pp: 25, t21: 0 });
  });

  it("Perfect Pairs ve 21+3 dağıtınca hemen ödenir", () => {
    const { w, ...wal } = wallet();
    const t = new LiveBlackjack(LIVE_TABLES[2], wal, () => 0.5);
    t.sit(3, 1, "a", "a");
    t.tick(0);
    expect(t.bet(1, { main: 100, pp: 10, t21: 10 })).toBeNull();
    expect(w.get("a")).toBe(START_BALANCE - 120);
    // a: 7♠ 7♥ (karışık çift 6:1); krupiye 7♦ açık: 7-7-7 üçlü (30:1)
    stack(t, 7, 7, 7, 10, 2);
    t.tick(t.endsAt);
    const st = t.view().stakes[3]!;
    expect(st.ppWin).toEqual({ kind: "mixed", pay: 70 });
    expect(st.t21Win).toEqual({ kind: "trips", pay: 310 });
    expect(w.get("a")).toBe(START_BALANCE - 120 + 380);
  });

  it("krupiye As açınca sigorta süresi; blackjack'te sigorta 2:1 öder", () => {
    const { w, ...wal } = wallet();
    const t = new LiveBlackjack(LIVE_TABLES[2], wal, () => 0.5);
    t.sit(0, 1, "a", "a");
    t.tick(0);
    t.bet(1, { main: 100 });
    stack(t, 10, 9, 1, 13);
    t.tick(t.endsAt);
    expect(t.phase).toBe("insurance");
    expect(t.view().dealer[1]).toBeNull();
    expect(t.act(1, "hit", 1)).not.toBeNull(); // sigorta sürerken hamle yok
    expect(t.act(1, "insure", 1)).toBeNull();
    expect(w.get("a")).toBe(START_BALANCE - 150);
    t.tick(t.endsAt);
    expect(t.phase).toBe("dealer");
    expect(t.view().stakes[0]?.insWin).toBe(150);
    expect(t.view().hands[0].result).toBe("lose");
    expect(w.get("a")).toBe(START_BALANCE);
  });

  it("sigorta süresinden sonra krupiye blackjack değilse oyun sürer; el bir kez bölünür", () => {
    const { w, ...wal } = wallet();
    const t = new LiveBlackjack(LIVE_TABLES[2], wal, () => 0.5);
    t.sit(0, 1, "a", "a");
    t.tick(0);
    t.bet(1, { main: 100 });
    // a: 8 8, krupiye A 6; bölünce ilk ele yine 8 gelir ama yeniden bölünmez
    stack(t, 8, 8, 1, 6, 8, 3);
    t.tick(t.endsAt);
    t.act(1, "insure", 1);
    t.tick(t.endsAt);
    expect(t.phase).toBe("play");
    expect(w.get("a")).toBe(START_BALANCE - 150);
    expect(t.view().canSplit).toBe(true);
    t.act(1, "split", 2);
    expect(t.view().hands[0].cards.map((c) => c.r)).toEqual([8, 8]);
    expect(t.view().canSplit).toBe(false);
    expect(t.act(1, "split", 3)).not.toBeNull();
  });
});

describe("rulet iç bahisleri", () => {
  it("split, sıra, köşe, altılı, trio ve ilk dört doğru sayıları kapsar ve doğru öder", () => {
    expect(betNumbers("split", 1720)).toEqual([17, 20]);
    expect(betNumbers("split", 1718)).toEqual([17, 18]); // 18, 17'nin üstünde
    expect(betNumbers("split", 1819)).toBeNull(); // komşu değil (sıra sonu)
    expect(betNumbers("split", 3)).toEqual([0, 3]);
    expect(betNumbers("corner", 25)).toEqual([25, 26, 28, 29]);
    expect(betNumbers("corner", 3)).toBeNull();
    expect(betNumbers("line", 31)).toEqual([31, 32, 33, 34, 35, 36]);
    expect(betNumbers("trio", 2)).toEqual([0, 2, 3]);
    expect(roulettePayout([{ kind: "split", v: 1720, amount: 10 }], 20)).toBe(180);
    expect(roulettePayout([{ kind: "street", v: 4, amount: 10 }], 6)).toBe(120);
    expect(roulettePayout([{ kind: "corner", v: 25, amount: 10 }], 29)).toBe(90);
    expect(roulettePayout([{ kind: "line", v: 1, amount: 10 }], 6)).toBe(60);
    expect(roulettePayout([{ kind: "four", v: 0, amount: 10 }], 0)).toBe(90);
    expect(validBet({ kind: "corner", v: 36, amount: 10 })).toBeNull();
  });

  it("yan bahis tabloları: Perfect Pairs ve 21+3", () => {
    expect(perfectPair({ r: 5, s: 1 }, { r: 5, s: 1 })).toBe("perfect");
    expect(perfectPair({ r: 5, s: 1 }, { r: 5, s: 2 })).toBe("coloured");
    expect(perfectPair({ r: 5, s: 0 }, { r: 5, s: 2 })).toBe("mixed");
    expect(perfectPair({ r: 12, s: 0 }, { r: 13, s: 0 })).toBeNull();
    expect(twentyOnePlus3([{ r: 9, s: 3 }, { r: 9, s: 3 }, { r: 9, s: 3 }])).toBe("suitedTrips");
    expect(twentyOnePlus3([{ r: 12, s: 1 }, { r: 13, s: 1 }, { r: 1, s: 1 }])).toBe("straightFlush");
    expect(twentyOnePlus3([{ r: 1, s: 0 }, { r: 2, s: 1 }, { r: 3, s: 2 }])).toBe("straight");
    expect(twentyOnePlus3([{ r: 2, s: 2 }, { r: 9, s: 2 }, { r: 13, s: 2 }])).toBe("flush");
    expect(twentyOnePlus3([{ r: 13, s: 2 }, { r: 1, s: 0 }, { r: 2, s: 2 }])).toBeNull(); // K-A-2 kent değil
  });
});

describe("canlı blackjack: hazır", () => {
  it("oturan herkes hazır olunca süre beklenmeden dağıtılır; bahis değişince hazırlık düşer", () => {
    const wal = wallet();
    const t = new LiveBlackjack(LIVE_TABLES[2], wal, () => 0.5);
    t.sit(0, 1, "a", "a");
    t.sit(1, 2, "b", "b");
    t.tick(0);
    t.bet(1, { main: 100 }, true);
    t.tick(10);
    expect(t.phase).toBe("bet"); // b henüz hazır değil
    t.bet(2, { main: 50 }, true);
    t.bet(1, { main: 200 }); // a bahsini değiştirdi: hazır değil
    t.tick(20);
    expect(t.phase).toBe("bet");
    expect(t.view().seats[0]?.ready).toBe(false);
    t.bet(1, { main: 200 }, true);
    t.tick(30);
    expect(t.phase).not.toBe("bet");
    expect(t.view().hands.map((h) => h.bet)).toEqual([200, 50]);
  });

  it("bahissiz herkes hazırsa dağıtılmaz", () => {
    const t = new LiveBlackjack(LIVE_TABLES[2], wallet(), () => 0.5);
    t.sit(0, 1, "a", "a");
    t.tick(0);
    t.bet(1, {}, true);
    t.tick(10);
    expect(t.phase).toBe("bet");
  });
});
