// Casino oyunları (sunucu ve istemci ortak, saf mantık): blackjack, Avrupa ruleti ve slot. Rastgelelik
// dışarıdan verilir (sunucu kripto RNG'si, testte sabit). Para birimi: test coin (GAP).

export const START_BALANCE = 10_000;
/** Bakiye bunun altına düşünce "test coin al" açılır ve bakiye bu kadar olur. */
export const REFILL_TO = 5_000;
export const MIN_BET = 10;
export const MAX_BET = 5_000;

export type Rng = () => number;

// ---------------------------------------------------------------------------
// Kartlar ve blackjack
// ---------------------------------------------------------------------------

/** r: 1 (As) … 13 (Papaz), s: 0 ♠ 1 ♥ 2 ♦ 3 ♣ */
export interface Card {
  r: number;
  s: number;
}

export const DECKS = 6;
/** Ayakkabının bu kadarı dağıtılınca yeni el başında karıştırılır. */
export const PENETRATION = 0.75;

export function newShoe(rng: Rng, decks = DECKS): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < decks; d++) for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) cards.push({ r, s });
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/** Kartın blackjack değeri (As 1; yumuşak hesap handValue'da). */
export const cardValue = (c: Card) => (c.r >= 10 ? 10 : c.r);

export function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0, aces = 0;
  for (const c of cards) {
    total += cardValue(c);
    if (c.r === 1) aces++;
  }
  const soft = aces > 0 && total + 10 <= 21;
  return { total: soft ? total + 10 : total, soft };
}

export type BjResult = "blackjack" | "win" | "push" | "lose" | "bust";

export interface BjHand {
  cards: Card[];
  bet: number;
  done: boolean;
  doubled: boolean;
  /** Bölünmüş elden (21'i blackjack sayılmaz). */
  split: boolean;
  result?: BjResult;
  /** Ele dönen toplam (bahis dahil). */
  payout?: number;
}

export interface BjRound {
  dealer: Card[];
  hands: BjHand[];
  active: number;
  phase: "player" | "done";
}

export const MAX_HANDS = 4;

export const isBlackjack = (h: BjHand) => !h.split && h.cards.length === 2 && handValue(h.cards).total === 21;

export class Shoe {
  cards: Card[];
  private size: number;
  constructor(private rng: Rng, decks = DECKS) {
    this.cards = newShoe(rng, decks);
    this.size = this.cards.length;
  }
  /** Yeni el başında: ayakkabı yeterince azaldıysa yeniden karılır. */
  maybeShuffle(): boolean {
    if (this.cards.length > this.size * (1 - PENETRATION)) return false;
    this.cards = newShoe(this.rng, this.size / 52);
    return true;
  }
  draw(): Card {
    if (!this.cards.length) this.cards = newShoe(this.rng, this.size / 52);
    return this.cards.pop()!;
  }
}

/** El dağıt: oyuncuya iki, krupiyeye iki (biri kapalı). Blackjack'ler hemen sonuçlanır (krupiye bakar). */
export function bjDeal(shoe: Shoe, bet: number): BjRound {
  const p = [shoe.draw()], d = [shoe.draw()];
  p.push(shoe.draw());
  d.push(shoe.draw());
  const round: BjRound = { dealer: d, hands: [{ cards: p, bet, done: false, doubled: false, split: false }], active: 0, phase: "player" };
  const dealerBj = handValue(d).total === 21;
  if (dealerBj || isBlackjack(round.hands[0])) {
    round.hands[0].done = true;
    settle(round);
  }
  return round;
}

const activeHand = (r: BjRound): BjHand | null => (r.phase === "player" ? r.hands[r.active] ?? null : null);

export function canSplit(r: BjRound): boolean {
  const h = activeHand(r);
  return !!h && h.cards.length === 2 && cardValue(h.cards[0]) === cardValue(h.cards[1]) && r.hands.length < MAX_HANDS && !(h.split && h.cards[0].r === 1);
}
export function canDouble(r: BjRound): boolean {
  const h = activeHand(r);
  return !!h && h.cards.length === 2 && !(h.split && h.cards[0].r === 1);
}

/** Etkin el bitti: sıradakine geç; hepsi bittiyse krupiye oynar ve sonuçlanır. */
function advance(r: BjRound, shoe: Shoe): void {
  while (r.active < r.hands.length && r.hands[r.active].done) r.active++;
  if (r.active < r.hands.length) return;
  // Krupiye: patlamamış el varsa yumuşak 17'de dahil 17'ye kadar çeker (S17)
  if (r.hands.some((h) => h.result !== "bust")) while (handValue(r.dealer).total < 17) r.dealer.push(shoe.draw());
  settle(r);
}

function settle(r: BjRound): void {
  r.phase = "done";
  const dv = handValue(r.dealer).total, dealerBj = r.dealer.length === 2 && dv === 21;
  for (const h of r.hands) {
    const v = handValue(h.cards).total;
    if (v > 21) h.result = "bust";
    else if (isBlackjack(h)) h.result = dealerBj ? "push" : "blackjack";
    else if (dealerBj) h.result = "lose";
    else if (dv > 21 || v > dv) h.result = "win";
    else h.result = v === dv ? "push" : "lose";
    h.payout = h.result === "blackjack" ? h.bet * 2.5 : h.result === "win" ? h.bet * 2 : h.result === "push" ? h.bet : 0;
  }
}

/** Kart çek; 21'e varınca el kendiliğinden durur. */
export function bjHit(r: BjRound, shoe: Shoe): boolean {
  const h = activeHand(r);
  if (!h) return false;
  h.cards.push(shoe.draw());
  const v = handValue(h.cards).total;
  if (v > 21) {
    h.result = "bust";
    h.done = true;
  } else if (v === 21) h.done = true;
  if (h.done) advance(r, shoe);
  return true;
}

export function bjStand(r: BjRound, shoe: Shoe): boolean {
  const h = activeHand(r);
  if (!h) return false;
  h.done = true;
  advance(r, shoe);
  return true;
}

/** İkiye katla: bahis iki katı, tek kart, el biter. (Ek bahsi sunucu bakiyeden düşer.) */
export function bjDouble(r: BjRound, shoe: Shoe): boolean {
  if (!canDouble(r)) return false;
  const h = r.hands[r.active];
  h.bet *= 2;
  h.doubled = true;
  h.cards.push(shoe.draw());
  if (handValue(h.cards).total > 21) h.result = "bust";
  h.done = true;
  advance(r, shoe);
  return true;
}

/** Böl: iki el, her birine birer kart; bölünen Aslar birer kart alıp durur. (Ek bahsi sunucu düşer.) */
export function bjSplit(r: BjRound, shoe: Shoe): boolean {
  if (!canSplit(r)) return false;
  const h = r.hands[r.active];
  const second: BjHand = { cards: [h.cards.pop()!], bet: h.bet, done: false, doubled: false, split: true };
  h.split = true;
  h.cards.push(shoe.draw());
  second.cards.push(shoe.draw());
  r.hands.splice(r.active + 1, 0, second);
  const aces = h.cards[0].r === 1;
  for (const x of [h, second]) if (aces || handValue(x.cards).total === 21) x.done = true;
  advance(r, shoe);
  return true;
}

/** İstemciye giden görünüm: el sürerken krupiyenin ikinci kartı kapalı. */
export interface BjView {
  dealer: (Card | null)[];
  hands: BjHand[];
  active: number;
  phase: "player" | "done";
  canSplit: boolean;
  canDouble: boolean;
  /** Bu el başında deste karıldı. */
  shuffled?: boolean;
}

export function bjView(r: BjRound, shuffled = false): BjView {
  return {
    dealer: r.phase === "player" ? [r.dealer[0], null] : r.dealer,
    hands: r.hands,
    active: r.active,
    phase: r.phase,
    canSplit: canSplit(r),
    canDouble: canDouble(r),
    shuffled,
  };
}

// ---------------------------------------------------------------------------
// Avrupa ruleti (tek sıfır)
// ---------------------------------------------------------------------------

export const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const numberColor = (n: number): "green" | "red" | "black" => (n === 0 ? "green" : RED.has(n) ? "red" : "black");

/** Bahis: tek sayı, renk, tek/çift, 1–18/19–36, düzine (1–3), kolon (1–3: 1, 2, 3'ten başlayanlar). */
export type RouletteKind = "n" | "red" | "black" | "odd" | "even" | "low" | "high" | "dozen" | "column";
export interface RouletteBet {
  kind: RouletteKind;
  /** Sayı (0–36), düzine ya da kolon (1–3); diğerlerinde 0. */
  v: number;
  amount: number;
}

export function rouletteWins(b: RouletteBet, n: number): boolean {
  if (b.kind === "n") return n === b.v;
  if (n === 0) return false;
  switch (b.kind) {
    case "red": return RED.has(n);
    case "black": return !RED.has(n);
    case "odd": return n % 2 === 1;
    case "even": return n % 2 === 0;
    case "low": return n <= 18;
    case "high": return n >= 19;
    case "dozen": return Math.ceil(n / 12) === b.v;
    case "column": return ((n - 1) % 3) + 1 === b.v;
  }
}

/** Kazanan bahsin oranı (bahis başına net kazanç). */
export const roulettePays = (k: RouletteKind) => (k === "n" ? 35 : k === "dozen" || k === "column" ? 2 : 1);

export function validBet(b: unknown): RouletteBet | null {
  if (!b || typeof b !== "object") return null;
  const x = b as Record<string, unknown>;
  const kinds: RouletteKind[] = ["n", "red", "black", "odd", "even", "low", "high", "dozen", "column"];
  if (!kinds.includes(x.kind as RouletteKind) || !Number.isInteger(x.v) || !Number.isInteger(x.amount)) return null;
  const kind = x.kind as RouletteKind, v = x.v as number, amount = x.amount as number;
  if (amount < MIN_BET || amount > MAX_BET) return null;
  if (kind === "n" ? v < 0 || v > 36 : kind === "dozen" || kind === "column" ? v < 1 || v > 3 : v !== 0) return null;
  return { kind, v, amount };
}

/** Çevirişin toplam dönüşü (kazanan bahisler bahisleriyle birlikte). */
export function roulettePayout(bets: RouletteBet[], n: number): number {
  return bets.reduce((sum, b) => sum + (rouletteWins(b, n) ? b.amount * (roulettePays(b.kind) + 1) : 0), 0);
}

// ---------------------------------------------------------------------------
// Slot: üç makara, orta çizgi
// ---------------------------------------------------------------------------

export const SLOT_SYMBOLS = ["🍒", "🍋", "🔔", "⭐", "💎", "7", "GAP"] as const;
/** Makaradaki adet (ağırlık): az olan nadir. Her makara aynı. */
export const SLOT_WEIGHTS = [6, 5, 4, 3, 2, 1, 1];
/** Üçlü için bahsin katı. */
export const SLOT_PAYS = [12, 15, 25, 50, 100, 300, 777];
/** Tam iki kiraz için bahsin katı. */
export const SLOT_TWO_CHERRIES = 0.5;
export const SLOT_BETS = [10, 20, 50, 100, 250, 500];

/** Makara şeridi: ağırlıklarla dizilmiş ve karıştırılmış sabit sıra (görünüm ve olasılık aynı). */
export const SLOT_STRIP: number[] = (() => {
  const out: number[] = [];
  SLOT_WEIGHTS.forEach((w, i) => {
    for (let k = 0; k < w; k++) out.push(i);
  });
  // Sabit karıştırma: aynı simgeler yan yana yığılmasın
  let s = 7;
  const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
})();

/** Orta çizgideki simgeler (şerit konumlarından) ve kazanç (bahis katı). */
export function slotLine(stops: number[]): { symbols: number[]; mult: number } {
  const symbols = stops.map((i) => SLOT_STRIP[((i % SLOT_STRIP.length) + SLOT_STRIP.length) % SLOT_STRIP.length]);
  if (symbols[0] === symbols[1] && symbols[1] === symbols[2]) return { symbols, mult: SLOT_PAYS[symbols[0]] };
  const cherries = symbols.filter((s) => s === 0).length;
  return { symbols, mult: cherries === 2 ? SLOT_TWO_CHERRIES : 0 };
}

/** Kesin geri ödeme oranı (RTP): bütün durak bileşimleri üzerinden. */
export function slotRtp(): number {
  const n = SLOT_STRIP.length;
  let sum = 0;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) sum += slotLine([a, b, c]).mult;
  return sum / n ** 3;
}
