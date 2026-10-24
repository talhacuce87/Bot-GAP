// Canlı poker (Texas Hold'em, oyuncular birbirine karşı): casinonun VIP katındaki oval masa. En az 4 oyuncu
// oturunca el başlar; masaya oturan test coinden masaya para alır (kalkınca kalan cüzdana döner). Kör bahisler,
// sırayla süreli hamleler (dolarsa check ya da pas), flop/turn/river, yan potlar ve showdown. Saf mantık: sunucu
// yetkili (server/src/liveTables.ts), herkes kendi kartlarını, showdown'da açılanları görür.
import type { Card, Rng } from "./casino";
import type { LiveTableDef, LiveWallet } from "./liveCasino";

export const POKER = {
  sb: 10,
  bb: 20,
  /** Masaya oturunca alınan para (oyuncu seçebilir). */
  buyIn: 1000,
  minBuyIn: 200,
  maxBuyIn: 5000,
  minPlayers: 4,
  /** El arası geri sayım, hamle süresi ve showdown gösterimi (ms). */
  startMs: 5000,
  turnMs: 20000,
  showMs: 7000,
  foldWinMs: 4000,
};

// ---------------------------------------------------------------------------
// El değerlendirme: 7 karttan en iyi 5'li
// ---------------------------------------------------------------------------

const rv = (c: Card) => (c.r === 1 ? 14 : c.r);
const B5 = 15 ** 5;

/** Beş kartın gücü: büyük olan kazanır (kategori × 15⁵ + sıralı rütbeler). */
export function score5(cs: Card[]): number {
  const v = cs.map(rv).sort((a, b) => b - a);
  const flush = cs.every((c) => c.s === cs[0].s);
  let straight = 0;
  if (new Set(v).size === 5) {
    if (v[0] - v[4] === 4) straight = v[0];
    else if (v[0] === 14 && v[1] === 5) straight = 5;
  }
  const counts = new Map<number, number>();
  for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
  // Önce adet, sonra rütbe: [rütbe, adet]
  const g = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const pack = (cat: number, ranks: number[]) => {
    let s = cat;
    for (let i = 0; i < 5; i++) s = s * 15 + (ranks[i] ?? 0);
    return s;
  };
  if (straight && flush) return pack(8, [straight]);
  if (g[0][1] === 4) return pack(7, [g[0][0], g[1][0]]);
  if (g[0][1] === 3 && g[1][1] === 2) return pack(6, [g[0][0], g[1][0]]);
  if (flush) return pack(5, v);
  if (straight) return pack(4, [straight]);
  if (g[0][1] === 3) return pack(3, g.map((x) => x[0]));
  if (g[0][1] === 2 && g[1][1] === 2) return pack(2, g.map((x) => x[0]));
  if (g[0][1] === 2) return pack(1, g.map((x) => x[0]));
  return pack(0, v);
}

/** 5–7 karttan en iyi beşli. */
export function bestScore(cards: Card[]): number {
  if (cards.length <= 5) return cards.length === 5 ? score5(cards) : 0;
  let best = 0;
  const n = cards.length;
  // 7 kartta iki, 6 kartta bir kart dışarıda kalır
  for (let a = 0; a < n; a++) {
    if (n === 6) best = Math.max(best, score5(cards.filter((_, i) => i !== a)));
    else for (let b = a + 1; b < n; b++) best = Math.max(best, score5(cards.filter((_, i) => i !== a && i !== b)));
  }
  return best;
}

const CATS = ["Yüksek kart", "Çift", "İki çift", "Üçlü", "Kent", "Renk", "Ful", "Kare", "Sıralı renk"];
const RANK_TR: Record<number, string> = { 14: "As", 13: "Papaz", 12: "Kız", 11: "Vale" };
const rankTr = (r: number) => RANK_TR[r] ?? String(r);

/** Elin adı: "Çift · As", "Ful · Papaz / 7", "Royal flush". */
export function handName(score: number): string {
  if (!score) return "";
  const cat = Math.floor(score / B5);
  const r = (i: number) => Math.floor(score / 15 ** (4 - i)) % 15;
  if (cat === 8 && r(0) === 14) return "Royal flush";
  if (cat === 6 || cat === 2) return `${CATS[cat]} · ${rankTr(r(0))} / ${rankTr(r(1))}`;
  return `${CATS[cat]} · ${rankTr(r(0))}`;
}

// ---------------------------------------------------------------------------
// Masa
// ---------------------------------------------------------------------------

export type PokerPhase = "idle" | "start" | "preflop" | "flop" | "turn" | "river" | "showdown";
const BETTING: PokerPhase[] = ["preflop", "flop", "turn", "river"];

interface PSeat {
  sid: number;
  name: string;
  key: string;
  stack: number;
  /** Bu turdaki ve bu eldeki toplam katkı. */
  bet: number;
  total: number;
  cards: Card[] | null;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  /** Elin ortasında kalktı: el bitene kadar katkısı potta kalır. */
  gone: boolean;
  action: string | null;
  won: number;
  best: number;
}

export interface PokerSeatView {
  sid: number;
  name: string;
  stack: number;
  bet: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  /** Kendi kartların ve showdown'da açılanlar; diğerleri kapalı (null). */
  cards: (Card | null)[];
  action: string | null;
  won: number;
  best: string | null;
  gone: boolean;
}

export interface PokerTableView {
  id: number;
  kind: "poker";
  phase: PokerPhase;
  endsAt: number;
  seats: (PokerSeatView | null)[];
  board: Card[];
  pot: number;
  button: number;
  sbSeat: number;
  bbSeat: number;
  toAct: number;
  turnEndsAt: number;
  currentBet: number;
  minRaise: number;
  blinds: [number, number];
  hand: number;
  winners: { seat: number; amount: number; best: string | null }[];
  /** Elin başlaması için oturup parası olan oyuncu sayısı ve gereken. */
  ready: number;
  need: number;
}

export class LivePoker {
  phase: PokerPhase = "idle";
  endsAt = 0;
  turnEndsAt = 0;
  seats: (PSeat | null)[];
  board: Card[] = [];
  private deck: Card[] = [];
  button = -1;
  sbSeat = -1;
  bbSeat = -1;
  toAct = -1;
  currentBet = 0;
  minRaise = POKER.bb;
  hand = 0;
  winners: { seat: number; amount: number; best: string | null }[] = [];
  private now = 0;

  constructor(readonly def: LiveTableDef, private wallet: LiveWallet, private rng: Rng) {
    this.seats = def.seats.map(() => null);
  }

  /** Masaya otur: \`buyIn\` kadar test coin masaya gelir. */
  sit(seat: number, sid: number, name: string, key: string, buyIn = POKER.buyIn): string | null {
    if (!(seat >= 0 && seat < this.seats.length)) return "♠ Geçersiz yer.";
    if (this.seats[seat]) return "♠ Bu yer dolu.";
    const a = Math.floor(Number(buyIn));
    if (!(a >= POKER.minBuyIn && a <= POKER.maxBuyIn)) return `♠ Masaya ${POKER.minBuyIn}–${POKER.maxBuyIn} arası para alınır.`;
    if (!this.wallet.take(key, a)) return "💰 Bakiyen masaya oturmaya yetmiyor.";
    this.seats[seat] = { sid, name, key, stack: a, bet: 0, total: 0, cards: null, folded: false, allIn: false, acted: false, gone: false, action: null, won: 0, best: 0 };
    return null;
  }

  /** Parası biten (ya da azalan) oyuncu, el dışındayken masaya para ekler. */
  rebuy(sid: number, amount = POKER.buyIn): string | null {
    const s = this.seats.find((x) => x?.sid === sid && !x.gone);
    if (!s) return "♠ Önce masaya otur.";
    if (s.cards && !s.folded && this.betting()) return "♠ El bitince para ekleyebilirsin.";
    const a = Math.floor(Number(amount));
    if (!(a >= POKER.minBuyIn && s.stack + a <= POKER.maxBuyIn)) return `♠ Masada en çok ${POKER.maxBuyIn} olabilir.`;
    if (!this.wallet.take(s.key, a)) return "💰 Bakiyen yetmiyor.";
    s.stack += a;
    return null;
  }

  leave(sid: number): boolean {
    const i = this.seats.findIndex((s) => s?.sid === sid && !s.gone);
    if (i < 0) return false;
    const s = this.seats[i]!;
    this.wallet.give(s.key, s.stack);
    s.stack = 0;
    if (this.betting() && s.cards && !s.folded) {
      // El sürüyor: pas sayılır, katkısı potta kalır; koltuk el bitince boşalır
      s.folded = true;
      s.gone = true;
      s.sid = -1;
      s.action = "AYRILDI";
      if (this.toAct === i || this.inHand().length <= 1) this.advance(this.now);
    } else if (this.betting() && s.total > 0) {
      s.gone = true;
      s.sid = -1;
    } else this.seats[i] = null;
    return true;
  }

  /** Sırası gelen oyuncunun hamlesi: fold, check, call, raise (amount: bu turda toplam bahis), allin. */
  act(sid: number, op: string, now: number, amount?: number): string | null {
    this.now = now;
    if (!this.betting()) return "♠ Şu an hamle yapılamaz.";
    const s = this.seats[this.toAct];
    if (!s || s.sid !== sid) return "♠ Sıra sende değil.";
    const err = this.apply(this.toAct, op, amount);
    if (err) return err;
    this.advance(now);
    return null;
  }

  tick(now: number): boolean {
    this.now = now;
    const ready = this.readyCount();
    if (this.phase === "idle") {
      if (ready < POKER.minPlayers) return false;
      this.phase = "start";
      this.endsAt = now + POKER.startMs;
      return true;
    }
    if (this.phase === "start") {
      if (ready < POKER.minPlayers) {
        this.phase = "idle";
        return true;
      }
      if (now < this.endsAt) return false;
      this.startHand(now);
      return true;
    }
    if (this.betting()) {
      const s = this.seats[this.toAct];
      // Süre doldu ya da oyuncu yok: check olabiliyorsa check, yoksa pas
      if (!s || s.gone || now >= this.turnEndsAt) {
        this.apply(this.toAct, s && s.bet >= this.currentBet ? "check" : "fold");
        this.advance(now);
        return true;
      }
      return false;
    }
    // Showdown bitti: ayrılanlar kalkar, yeni el için geri sayım
    if (now < this.endsAt) return false;
    this.cleanup();
    if (this.readyCount() >= POKER.minPlayers) {
      this.phase = "start";
      this.endsAt = now + 2500;
    } else this.phase = "idle";
    return true;
  }

  private betting(): boolean {
    return BETTING.includes(this.phase);
  }

  private readyCount(): number {
    return this.seats.filter((s) => s && !s.gone && s.stack > 0).length;
  }

  private inHand(): number[] {
    return this.seats.map((s, i) => (s && s.cards && !s.folded ? i : -1)).filter((i) => i >= 0);
  }

  /** `from`dan sonraki (döngüsel) ilk koltuk. */
  private nextSeat(from: number, ok: (s: PSeat) => boolean): number {
    const n = this.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k + n) % n, s = this.seats[i];
      if (s && ok(s)) return i;
    }
    return -1;
  }

  private cleanup(): void {
    this.seats.forEach((s, i) => {
      if (!s) return;
      if (s.gone) this.seats[i] = null;
      else Object.assign(s, { bet: 0, total: 0, cards: null, folded: false, allIn: false, acted: false, action: null, won: 0, best: 0 });
    });
  }

  private draw(): Card {
    return this.deck.pop()!;
  }

  private put(s: PSeat, a: number): void {
    const x = Math.min(a, s.stack);
    s.stack -= x;
    s.bet += x;
    s.total += x;
    if (s.stack === 0) s.allIn = true;
  }

  private startHand(now: number): void {
    this.cleanup();
    const plays = (s: PSeat) => !s.gone && s.stack > 0;
    this.hand++;
    this.winners = [];
    this.board = [];
    // Yeni karılmış 52 kart
    this.deck = [];
    for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) this.deck.push({ r, s });
    for (let i = this.deck.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
    }
    this.button = this.nextSeat(this.button, plays);
    this.sbSeat = this.nextSeat(this.button, plays);
    this.bbSeat = this.nextSeat(this.sbSeat, plays);
    for (const s of this.seats) if (s && plays(s)) s.cards = [];
    this.put(this.seats[this.sbSeat]!, POKER.sb);
    this.seats[this.sbSeat]!.action = `SB ${POKER.sb}`;
    this.put(this.seats[this.bbSeat]!, POKER.bb);
    this.seats[this.bbSeat]!.action = `BB ${POKER.bb}`;
    // Kartlar butonun solundan başlayarak ikişer
    for (let k = 0; k < 2; k++) {
      let i = this.button;
      do {
        i = this.nextSeat(i, (s) => !!s.cards);
        this.seats[i]!.cards!.push(this.draw());
      } while (i !== this.button);
    }
    this.currentBet = POKER.bb;
    this.minRaise = POKER.bb;
    this.phase = "preflop";
    this.toAct = this.bbSeat;
    this.advance(now);
  }

  /** Hamleyi uygula (hata metni ya da null). */
  private apply(i: number, op: string, amount?: number): string | null {
    const s = this.seats[i];
    if (!s) return null;
    const toCall = this.currentBet - s.bet;
    if (op === "fold") {
      s.folded = true;
      s.action = "PAS";
    } else if (op === "check") {
      if (toCall > 0) return "♠ Check olmaz: ya call ya pas.";
      s.action = "CHECK";
    } else if (op === "call") {
      if (toCall <= 0) s.action = "CHECK";
      else {
        this.put(s, toCall);
        s.action = s.allIn ? "ALL-IN" : `CALL ${toCall}`;
      }
    } else if (op === "raise" || op === "allin") {
      const max = s.bet + s.stack;
      let target = op === "allin" ? max : Math.floor(Number(amount));
      if (!(target > 0)) return "♠ Geçersiz miktar.";
      if (target >= max) target = max;
      else if (target < this.currentBet + this.minRaise) return `♠ En az ${this.currentBet + this.minRaise} olmalı.`;
      if (target <= this.currentBet) {
        // Yetmeyen all-in: call gibi
        this.put(s, target - s.bet);
        s.action = "ALL-IN";
      } else {
        const inc = target - this.currentBet;
        if (inc >= this.minRaise) this.minRaise = inc;
        this.put(s, target - s.bet);
        this.currentBet = target;
        s.action = s.allIn ? "ALL-IN" : this.currentBet === inc ? `BET ${target}` : `RAISE ${target}`;
        // Yeniden açılır: diğerleri tekrar karar verir
        for (const o of this.seats) if (o && o !== s && o.cards && !o.folded && !o.allIn) o.acted = false;
      }
    } else return "♠ Bilinmeyen hamle.";
    s.acted = true;
    return null;
  }

  /** Sıradaki oyuncu; tur bittiyse sonraki kart(lar) ya da showdown. */
  private advance(now: number): void {
    const live = this.inHand();
    if (live.length === 1) return this.winByFold(live[0], now);
    const pending = (s: PSeat) => !!s.cards && !s.folded && !s.allIn && (!s.acted || s.bet < this.currentBet);
    const next = this.nextSeat(this.toAct, pending);
    if (next >= 0) {
      this.toAct = next;
      this.turnEndsAt = now + POKER.turnMs;
      return;
    }
    // Tur bitti
    for (const s of this.seats) {
      if (!s) continue;
      s.bet = 0;
      s.acted = false;
      if (s.cards && !s.folded && !s.allIn && s.action !== null && !s.action.startsWith("ALL")) s.action = null;
    }
    this.currentBet = 0;
    this.minRaise = POKER.bb;
    const canAct = live.filter((i) => !this.seats[i]!.allIn).length;
    if (this.board.length === 5) return this.showdown(now);
    if (canAct <= 1) {
      while (this.board.length < 5) this.board.push(this.draw());
      return this.showdown(now);
    }
    if (this.board.length === 0) {
      this.board.push(this.draw(), this.draw(), this.draw());
      this.phase = "flop";
    } else {
      this.board.push(this.draw());
      this.phase = this.board.length === 4 ? "turn" : "river";
    }
    this.toAct = this.nextSeat(this.button, (s) => !!s.cards && !s.folded && !s.allIn);
    this.turnEndsAt = now + POKER.turnMs;
  }

  private winByFold(i: number, now: number): void {
    const pot = this.seats.reduce((a, s) => a + (s?.total ?? 0), 0);
    const s = this.seats[i]!;
    s.stack += pot;
    s.won = pot;
    this.winners = [{ seat: i, amount: pot, best: null }];
    this.phase = "showdown";
    this.toAct = -1;
    this.endsAt = now + POKER.foldWinMs;
  }

  /** Eller açılır; ana pot ve yan potlar katkı seviyelerine göre en iyi elde(lere) dağıtılır. */
  private showdown(now: number): void {
    const live = this.inHand();
    for (const i of live) this.seats[i]!.best = bestScore([...this.seats[i]!.cards!, ...this.board]);
    const contrib = this.seats.map((s, i) => [i, s?.total ?? 0] as [number, number]).filter(([, t]) => t > 0);
    const levels = [...new Set(contrib.map(([, t]) => t))].sort((a, b) => a - b);
    let prev = 0;
    const won = new Map<number, number>();
    for (const level of levels) {
      const amount = contrib.reduce((a, [, t]) => a + Math.min(t, level) - Math.min(t, prev), 0);
      prev = level;
      const eligible = live.filter((i) => this.seats[i]!.total >= level);
      if (!eligible.length || !amount) continue;
      const top = Math.max(...eligible.map((i) => this.seats[i]!.best));
      // Kazananlar butonun solundan sırayla (bölünemeyen artık ilkine)
      const winners = eligible.filter((i) => this.seats[i]!.best === top)
        .sort((a, b) => ((a - this.button + this.seats.length) % this.seats.length) - ((b - this.button + this.seats.length) % this.seats.length));
      const share = Math.floor(amount / winners.length);
      winners.forEach((i, k) => won.set(i, (won.get(i) ?? 0) + share + (k === 0 ? amount - share * winners.length : 0)));
    }
    this.winners = [];
    for (const [i, amount] of won) {
      const s = this.seats[i]!;
      s.stack += amount;
      s.won = amount;
      this.winners.push({ seat: i, amount, best: handName(s.best) });
    }
    this.phase = "showdown";
    this.toAct = -1;
    this.endsAt = now + POKER.showMs;
  }

  view(viewer = -1): PokerTableView {
    const live = this.inHand();
    const reveal = this.phase === "showdown" && live.length > 1;
    return {
      id: this.def.id, kind: "poker", phase: this.phase, endsAt: this.endsAt,
      seats: this.seats.map((s) => s && {
        sid: s.sid, name: s.name, stack: s.stack, bet: s.bet, inHand: !!s.cards && !s.folded, folded: s.folded, allIn: s.allIn,
        cards: s.cards ? (s.sid === viewer || (reveal && !s.folded) ? s.cards : s.cards.map(() => null)) : [],
        action: s.action, won: s.won, best: reveal && !s.folded && s.best ? handName(s.best) : null, gone: s.gone,
      }),
      board: this.board,
      pot: this.seats.reduce((a, s) => a + (s?.total ?? 0), 0),
      button: this.button, sbSeat: this.sbSeat, bbSeat: this.bbSeat,
      toAct: this.betting() ? this.toAct : -1,
      turnEndsAt: this.turnEndsAt,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      blinds: [POKER.sb, POKER.bb],
      hand: this.hand,
      winners: this.winners,
      ready: this.readyCount(),
      need: POKER.minPlayers,
    };
  }
}
