// Canlı casino masaları (Evolution'daki gibi): her masada herkes için tek, süreli tur. Oturanlar oynar, yakındakiler
// izler. Rulet: bahis süresi → çark → sonuç → yeni tur. Blackjack (7 koltuk, Evolution kuralları): bahis süresi
// (ana bahis + Perfect Pairs + 21+3) → dağıt → krupiye As açtıysa sigorta → sırayla her elde karar süresi (dolarsa
// "dur") → krupiye → sonuç. Kimse oturmuyorsa tur dönmez. Saf mantık: para cüzdan geri çağrısıyla,
// rastgelelik dışarıdan; sunucu yetkili (server/src/liveTables.ts), istemci görünümü çizer.
import {
  type BjHand, bjAdvance, bjDouble, bjHit, bjSettle, bjSplit, bjStand, type BjRound, canDouble, canSplit, type Card, handValue,
  isBlackjack, MAX_BET, MIN_BET, type PairKind, perfectPair, PP_PAYS, roulettePayout, type RouletteBet, type Rng, Shoe, T21_PAYS,
  type T21Kind, twentyOnePlus3, validBet,
} from "./casino";
import { CASINO, CASINO_MEZZ_Z } from "./zones";
import { LivePoker, type PokerTableView } from "./poker";

export type LiveKind = "roulette" | "blackjack" | "poker";
export interface LiveSeatPos {
  x: number;
  z: number;
  rot: number;
}
export interface LiveTableDef {
  id: number;
  kind: LiveKind;
  x: number;
  z: number;
  seats: LiveSeatPos[];
}

/** Masa sırası: VIP merdivenlerinin önündeki orta şerit (dünyadaki casino ile aynı). */
const MED_Z = (CASINO_MEZZ_Z + 13 + CASINO_MEZZ_Z) / 2 + 2.5;

function rouletteDef(id: number, x: number, z: number): LiveTableDef {
  return { id, kind: "roulette", x, z, seats: [-0.85, -0.1, 0.65, 1.35].map((o) => ({ x: x + o, z: z + 1.35, rot: Math.PI })) };
}
/** Blackjack masasında koltuk sayısı ve yay üzerinde koltuklar arası açı. */
export const BJ_SEATS = 7;
export const BJ_STEP = 0.4;
/** Koltuğun yaydaki açısı: 0. koltuk krupiyenin solunda (oyuncunun sağında), kartları ilk o alır. */
export const bjSeatAngle = (seat: number) => ((BJ_SEATS - 1) / 2 - seat) * BJ_STEP;

function blackjackDef(id: number, x: number, z: number): LiveTableDef {
  const seats = Array.from({ length: BJ_SEATS }, (_, i) => {
    const a = bjSeatAngle(i), sx = x + Math.sin(a) * 2.05, sz = z + Math.cos(a) * 2.05;
    return { x: sx, z: sz, rot: Math.atan2(x - sx, z - sz) };
  });
  return { id, kind: "blackjack", x, z, seats };
}

/** Poker masası: VIP katındaki oval masa; 7 koltuk masanın etrafında, krupiye kuzeyde (duvar tarafı). */
export const POKER_SEATS = 7;
/** Koltuğun oval üzerindeki açısı (0: güney, saat yönünde). */
export const pokerSeatAngle = (i: number) => -2.55 + (i * 5.1) / (POKER_SEATS - 1);
function pokerDef(id: number): LiveTableDef {
  const x = CASINO.x, z = (CASINO.z - CASINO.hd + 0.25 + CASINO_MEZZ_Z) / 2 - 0.2;
  const seats = Array.from({ length: POKER_SEATS }, (_, i) => {
    const a = pokerSeatAngle(i), sx = x + Math.sin(a) * 3.1, sz = z + Math.cos(a) * 2.05;
    return { x: sx, z: sz, rot: Math.atan2(x - sx, z - sz) };
  });
  return { id, kind: "poker", x, z, seats };
}

export const LIVE_TABLES: LiveTableDef[] = [
  rouletteDef(0, CASINO.x - 8, MED_Z - 3.5),
  rouletteDef(1, CASINO.x + 8, MED_Z - 3.5),
  blackjackDef(2, CASINO.x - 8, MED_Z + 3),
  blackjackDef(3, CASINO.x + 8, MED_Z + 3),
  pokerDef(4),
];
/** Masayı izlemek için masa merkezine bu kadar yakın olmalı (oturmak için tabure yanında). */
export const WATCH_R = 6;
export const SEAT_R = 2.6;

/** Tur süreleri (ms). */
export const LIVE_T = {
  rlBet: 15_000,
  rlSpin: 7_000,
  rlResult: 6_000,
  bjBet: 15_000,
  /** Krupiye As açınca sigorta kararı. */
  bjInsurance: 8_000,
  bjTurn: 12_000,
  /** Krupiye kartları açılırken (kart başına) ve sonuç. */
  bjDealerCard: 700,
  bjResult: 6_000,
};

/** Cüzdan: düş (yetmezse false) ve ekle. Anahtar oyuncunun cüzdanı (oturduğu an alınır). */
export interface LiveWallet {
  take(key: string, amount: number): boolean;
  give(key: string, amount: number): void;
}

export interface LiveSeatView {
  sid: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Rulet
// ---------------------------------------------------------------------------

export type RoulettePhase = "idle" | "bet" | "spin" | "result";

export interface RouletteTableView {
  id: number;
  kind: "roulette";
  phase: RoulettePhase;
  /** Fazın bittiği an (sunucu saati). */
  endsAt: number;
  seats: (LiveSeatView & { bets: RouletteBet[]; payout: number | null } | null)[];
  /** Çarkta duracağı sayı: yalnızca çark dönmeye başlayınca bilinir. */
  n: number | null;
  history: number[];
}

interface RlSeat {
  sid: number;
  name: string;
  key: string;
  bets: RouletteBet[];
  payout: number | null;
}

export class LiveRoulette {
  phase: RoulettePhase = "idle";
  endsAt = 0;
  n: number | null = null;
  history: number[] = [];
  seats: (RlSeat | null)[];
  /** Kalkan oyuncuların bu turdaki bahisleri yine sonuçlanır. */
  private orphans: RlSeat[] = [];

  constructor(readonly def: LiveTableDef, private wallet: LiveWallet, private rng: Rng) {
    this.seats = def.seats.map(() => null);
  }

  sit(seat: number, sid: number, name: string, key: string): string | null {
    if (!(seat >= 0 && seat < this.seats.length)) return "🎡 Geçersiz yer.";
    if (this.seats[seat]) return "🎡 Bu yer dolu.";
    this.seats[seat] = { sid, name, key, bets: [], payout: null };
    return null;
  }

  leave(sid: number): boolean {
    const i = this.seats.findIndex((s) => s?.sid === sid);
    if (i < 0) return false;
    const s = this.seats[i]!;
    // Bahis süresindeyse para iade; çark dönerken bahis sonuçlanır
    if (this.phase === "bet") this.wallet.give(s.key, total(s.bets));
    else if (this.phase === "spin" && s.bets.length) this.orphans.push(s);
    this.seats[i] = null;
    return true;
  }

  /** Bu turun bahislerini (tamamı) koy: öncekinin parası iade, yenisi düşülür. */
  bet(sid: number, raw: unknown): string | null {
    const s = this.seats.find((x) => x?.sid === sid);
    if (!s) return "🎡 Önce masaya otur.";
    if (this.phase !== "bet") return "🎡 Bahisler kapandı, sıradaki turu bekle.";
    // Özel bahisler (komşular, Voisins …) masaya çok sayıda çip koyar
    const list = Array.isArray(raw) ? raw.slice(0, 160).map(validBet) : [];
    if (list.some((b) => !b)) return "🎡 Bahisler geçersiz.";
    const bets = list as RouletteBet[], next = total(bets), prev = total(s.bets);
    if (next > MAX_BET * 10) return "🎡 Masa limiti aşıldı.";
    this.wallet.give(s.key, prev);
    if (!this.wallet.take(s.key, next)) {
      this.wallet.take(s.key, prev);
      return "💰 Bakiyen bu bahislere yetmiyor.";
    }
    s.bets = bets;
    return null;
  }

  /** Zamanlayıcı: faz değiştiyse true. */
  tick(now: number): boolean {
    const seated = this.seats.some(Boolean);
    if (this.phase === "idle") {
      if (!seated) return false;
      this.startBetting(now);
      return true;
    }
    if (now < this.endsAt) return false;
    if (this.phase === "bet") {
      this.phase = "spin";
      this.n = Math.floor(this.rng() * 37);
      this.endsAt = now + LIVE_T.rlSpin;
    } else if (this.phase === "spin") {
      for (const s of [...this.seats, ...this.orphans]) {
        if (!s) continue;
        s.payout = s.bets.length ? roulettePayout(s.bets, this.n!) : null;
        if (s.payout) this.wallet.give(s.key, s.payout);
      }
      this.orphans = [];
      // İstatistik için son 200 çeviriş
      this.history = [this.n!, ...this.history].slice(0, 200);
      this.phase = "result";
      this.endsAt = now + LIVE_T.rlResult;
    } else if (seated) this.startBetting(now);
    else {
      this.phase = "idle";
      this.n = null;
      for (const s of this.seats) if (s) s.bets = [];
    }
    return true;
  }

  private startBetting(now: number): void {
    this.phase = "bet";
    this.n = null;
    this.endsAt = now + LIVE_T.rlBet;
    for (const s of this.seats) {
      if (!s) continue;
      s.bets = [];
      s.payout = null;
    }
  }

  view(): RouletteTableView {
    return {
      id: this.def.id, kind: "roulette", phase: this.phase, endsAt: this.endsAt,
      seats: this.seats.map((s) => (s ? { sid: s.sid, name: s.name, bets: s.bets, payout: s.payout } : null)),
      n: this.phase === "spin" || this.phase === "result" ? this.n : null,
      history: this.history,
    };
  }
}

const total = (bets: RouletteBet[]) => bets.reduce((a, b) => a + b.amount, 0);

// ---------------------------------------------------------------------------
// Blackjack
// ---------------------------------------------------------------------------

export type BlackjackPhase = "idle" | "bet" | "insurance" | "play" | "dealer" | "result";

export interface LiveHand extends BjHand {
  /** Elin sahibi oturma yeri. */
  seat: number;
}

/** Koltuğun bahisleri: ana bahis, Perfect Pairs ve 21+3 (yan bahisler ana bahissiz konmaz). */
export interface BjBets {
  main: number;
  pp: number;
  t21: number;
}
export const NO_BETS: BjBets = { main: 0, pp: 0, t21: 0 };
export const betTotal = (b: BjBets) => b.main + b.pp + b.t21;

/** Bu eldeki koltuk: konan bahisler, sigorta ve dağıtınca hemen sonuçlanan yan bahisler. */
export interface BjStake extends BjBets {
  ins: number;
  /** Krupiye blackjack'inde sigortanın dönüşü (sonuçta). */
  insWin: number;
  ppWin: { kind: PairKind; pay: number } | null;
  t21Win: { kind: T21Kind; pay: number } | null;
}

export interface BlackjackTableView {
  id: number;
  kind: "blackjack";
  phase: BlackjackPhase;
  endsAt: number;
  /** Bahis süresinde koltukların o anki bahisleri ve "hazır" durumu. */
  seats: (LiveSeatView & { bets: BjBets; ready: boolean } | null)[];
  /** Dağıtılan elde koltuk koltuk bahisler ve yan bahis sonuçları. */
  stakes: (BjStake | null)[];
  /** Krupiye: el sürerken ikinci kart kapalı (null). */
  dealer: (Card | null)[];
  hands: LiveHand[];
  /** Sırası gelen el (hands içinde), yoksa −1; onun karar süresinin sonu. */
  active: number;
  turnEndsAt: number;
  canSplit: boolean;
  canDouble: boolean;
  shuffled: boolean;
}

interface BjSeat {
  sid: number;
  name: string;
  key: string;
  bets: BjBets;
  /** Bahsini koydu, süreyi beklemeden dağıtılsın istiyor. */
  ready: boolean;
}

/** Yan bahis sınırı (Evolution'da ana bahisten düşük). */
export const SIDE_MAX = 1_000;
/** Canlı masada 8 deste (Evolution). */
export const LIVE_DECKS = 8;

/** Bahis isteğini doğrular: hata metni ya da temiz bahisler. */
export function validBjBets(raw: unknown): BjBets | string {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (k: string) => (o[k] === undefined ? 0 : Number(o[k]));
  const b = { main: n("main"), pp: n("pp"), t21: n("t21") };
  if (![b.main, b.pp, b.t21].every((x) => Number.isInteger(x) && x >= 0)) return "🃏 Bahis geçersiz.";
  if (b.main && !(b.main >= MIN_BET && b.main <= MAX_BET)) return `🃏 Ana bahis ${MIN_BET}–${MAX_BET} arası olmalı.`;
  for (const x of [b.pp, b.t21]) if (x && !(x >= MIN_BET && x <= SIDE_MAX)) return `🃏 Yan bahis ${MIN_BET}–${SIDE_MAX} arası olmalı.`;
  if (!b.main && (b.pp || b.t21)) return "🃏 Yan bahis için önce ana bahis koy.";
  return b;
}

/** Bu elde bölünebilir mi: canlı masada her el bir kez bölünür. */
const canSplitLive = (r: BjRound) => canSplit(r) && !r.hands[r.active].split;

export class LiveBlackjack {
  phase: BlackjackPhase = "idle";
  endsAt = 0;
  turnEndsAt = 0;
  seats: (BjSeat | null)[];
  private shoe: Shoe;
  private round: BjRound | null = null;
  private stakes: (BjStake | null)[] = [];
  /** Elin oynandığı anki cüzdan anahtarları (kalkan oyuncunun eli de sonuçlanır). */
  private keys: string[] = [];
  private lastActive = -1;
  private shuffled = false;

  constructor(readonly def: LiveTableDef, private wallet: LiveWallet, rng: Rng) {
    this.seats = def.seats.map(() => null);
    this.shoe = new Shoe(rng, LIVE_DECKS);
  }

  sit(seat: number, sid: number, name: string, key: string): string | null {
    if (!(seat >= 0 && seat < this.seats.length)) return "🃏 Geçersiz yer.";
    if (this.seats[seat]) return "🃏 Bu yer dolu.";
    this.seats[seat] = { sid, name, key, bets: { ...NO_BETS }, ready: false };
    return null;
  }

  leave(sid: number): boolean {
    const i = this.seats.findIndex((s) => s?.sid === sid);
    if (i < 0) return false;
    const s = this.seats[i]!;
    if (this.phase === "bet") this.wallet.give(s.key, betTotal(s.bets));
    this.seats[i] = null;
    return true;
  }

  /**
   * Bu elin bahislerini (tamamı) koy: öncekinin parası iade, yenisi düşülür. `ready`: oyuncu hazır (masadaki herkes
   * hazırsa süre beklenmeden dağıtılır); bahis hazır demeden değişirse hazırlık düşer.
   */
  bet(sid: number, raw: unknown, ready = false): string | null {
    const s = this.seats.find((x) => x?.sid === sid);
    if (!s) return "🃏 Önce masaya otur.";
    if (this.phase !== "bet") return "🃏 Bahisler kapandı, sıradaki eli bekle.";
    const b = validBjBets(raw);
    if (typeof b === "string") return b;
    const prev = betTotal(s.bets);
    this.wallet.give(s.key, prev);
    if (!this.wallet.take(s.key, betTotal(b))) {
      this.wallet.take(s.key, prev);
      return "💰 Bakiyen bu bahse yetmiyor.";
    }
    s.bets = b;
    s.ready = !!ready;
    return null;
  }

  /** Oturan herkes hazır ve en az bir bahis var: dağıtmak için süre beklenmez. */
  private allReady(): boolean {
    const seated = this.seats.filter((s): s is BjSeat => !!s);
    return seated.length > 0 && seated.every((s) => s.ready) && seated.some((s) => s.bets.main > 0);
  }

  /** Sırası gelen oyuncunun hamlesi; sigorta süresinde "insure". */
  act(sid: number, op: string, now: number): string | null {
    const r = this.round;
    if (op === "insure") return this.insure(sid);
    if (!r || this.phase !== "play") return "🃏 Şu an hamle yapılamaz.";
    const h = r.hands[r.active] as LiveHand | undefined;
    if (!h || this.seats[h.seat]?.sid !== sid) return "🃏 Sıra sende değil.";
    if (op === "double" || op === "split") {
      if (op === "double" ? !canDouble(r) : !canSplitLive(r)) return "🃏 Bu el için olmaz.";
      if (!this.wallet.take(this.keys[h.seat], h.bet)) return "💰 Bakiyen yetmiyor.";
      if (op === "double") bjDouble(r, this.shoe);
      else bjSplit(r, this.shoe);
    } else if (op === "hit") bjHit(r, this.shoe);
    else if (op === "stand") bjStand(r, this.shoe);
    else return null;
    this.after(now);
    return null;
  }

  /** Sigorta: krupiye As açınca, ana bahsin yarısı; krupiye blackjack yaparsa 2:1 öder. */
  private insure(sid: number): string | null {
    if (this.phase !== "insurance") return "🃏 Sigorta zamanı değil.";
    const i = this.seats.findIndex((s) => s?.sid === sid);
    const st = this.stakes[i];
    if (i < 0 || !st) return "🃏 Bu elde yoksun.";
    if (st.ins) return null;
    const cost = st.main / 2;
    if (!this.wallet.take(this.keys[i], cost)) return "💰 Bakiyen yetmiyor.";
    st.ins = cost;
    return null;
  }

  tick(now: number): boolean {
    const seated = this.seats.some(Boolean);
    if (this.phase === "idle") {
      if (!seated) return false;
      this.startBetting(now);
      return true;
    }
    if (this.phase === "play") {
      const r = this.round!;
      const h = r.hands[r.active] as LiveHand | undefined;
      // Sahibi kalktıysa ya da süre dolduysa: dur
      if (h && (!this.seats[h.seat] || now >= this.turnEndsAt)) {
        bjStand(r, this.shoe);
        this.after(now);
        return true;
      }
      return false;
    }
    if (now < this.endsAt && !(this.phase === "bet" && this.allReady())) return false;
    if (this.phase === "bet") {
      const playing = this.seats.map((s, i) => (s && s.bets.main ? i : -1)).filter((i) => i >= 0);
      if (!playing.length) {
        if (seated) this.startBetting(now);
        else this.phase = "idle";
        return true;
      }
      this.deal(playing, now);
    } else if (this.phase === "insurance") {
      this.peek(now);
    } else if (this.phase === "dealer") {
      this.phase = "result";
      this.endsAt = now + LIVE_T.bjResult;
    } else if (this.phase === "result") {
      this.round = null;
      if (seated) this.startBetting(now);
      else this.phase = "idle";
    }
    return true;
  }

  private startBetting(now: number): void {
    this.phase = "bet";
    this.endsAt = now + LIVE_T.bjBet;
    this.round = null;
    this.stakes = [];
    this.lastActive = -1;
    for (const s of this.seats) if (s) Object.assign(s, { bets: { ...NO_BETS }, ready: false });
  }

  /** Dağıt: her oyuncuya iki, krupiyeye iki (biri kapalı); yan bahisler hemen sonuçlanır. */
  private deal(playing: number[], now: number): void {
    this.shuffled = this.shoe.maybeShuffle();
    this.keys = this.seats.map((s) => s?.key ?? "");
    const hands: LiveHand[] = playing.map((i) => ({ seat: i, cards: [], bet: this.seats[i]!.bets.main, done: false, doubled: false, split: false }));
    for (let k = 0; k < 2; k++) for (const h of hands) h.cards.push(this.shoe.draw());
    const dealer = [this.shoe.draw(), this.shoe.draw()];
    this.round = { dealer, hands, active: 0, phase: "player" };
    this.stakes = this.seats.map(() => null);
    for (const h of hands) {
      const b = this.seats[h.seat]!.bets;
      const [c0, c1] = h.cards;
      const pk = b.pp ? perfectPair(c0, c1) : null, tk = b.t21 ? twentyOnePlus3([c0, c1, dealer[0]]) : null;
      const st: BjStake = {
        ...b, ins: 0, insWin: 0,
        ppWin: pk && { kind: pk, pay: b.pp * (PP_PAYS[pk] + 1) },
        t21Win: tk && { kind: tk, pay: b.t21 * (T21_PAYS[tk] + 1) },
      };
      if (st.ppWin) this.wallet.give(this.keys[h.seat], st.ppWin.pay);
      if (st.t21Win) this.wallet.give(this.keys[h.seat], st.t21Win.pay);
      this.stakes[h.seat] = st;
    }
    for (const s of this.seats) if (s) s.bets = { ...NO_BETS };
    // Krupiye As açtıysa önce sigorta süresi; yoksa (10'luk kartta) hemen bakar
    if (dealer[0].r === 1) {
      this.phase = "insurance";
      this.endsAt = now + LIVE_T.bjInsurance;
      return;
    }
    this.peek(now);
  }

  /** Krupiye blackjack'e bakar: varsa el biter (sigortalar 2:1 öder); yoksa sıra oyunculara. */
  private peek(now: number): void {
    const r = this.round!;
    const dealerBj = handValue(r.dealer).total === 21;
    for (const [i, st] of this.stakes.entries()) {
      if (!st?.ins || !dealerBj) continue;
      st.insWin = st.ins * 3;
      this.wallet.give(this.keys[i], st.insWin);
    }
    for (const h of r.hands) if (dealerBj || isBlackjack(h)) h.done = true;
    // Hepsi bitti (blackjack'ler ya da krupiye blackjack): krupiye çekmeden sonuçlanır
    if (r.hands.every((h) => h.done)) bjSettle(r);
    else bjAdvance(r, this.shoe);
    this.phase = "play";
    this.after(now);
  }

  /** Hamleden sonra: bölmede yeni ele sahip ata, sıra değiştiyse süre baştan; el bittiyse ödeme. */
  private after(now: number): void {
    const r = this.round!;
    const hands = r.hands as LiveHand[];
    for (let i = 1; i < hands.length; i++) if (hands[i].seat === undefined) hands[i].seat = hands[i - 1].seat;
    if (r.phase === "done") {
      for (const h of hands) if (h.payout) this.wallet.give(this.keys[h.seat], h.payout);
      this.phase = "dealer";
      // Krupiyenin açacağı kartlar kadar bekle (istemci tek tek gösterir)
      this.endsAt = now + LIVE_T.bjDealerCard * Math.max(1, r.dealer.length - 1);
      return;
    }
    if (r.active !== this.lastActive) {
      this.lastActive = r.active;
      this.turnEndsAt = now + LIVE_T.bjTurn;
    }
  }

  view(): BlackjackTableView {
    const r = this.round;
    const live = r && r.phase === "player" && this.phase !== "dealer";
    const hidden = live || this.phase === "insurance";
    return {
      id: this.def.id, kind: "blackjack", phase: this.phase, endsAt: this.endsAt,
      seats: this.seats.map((s) => (s ? { sid: s.sid, name: s.name, bets: s.bets, ready: s.ready } : null)),
      stakes: this.stakes,
      dealer: r ? (hidden ? [r.dealer[0], null] : r.dealer) : [],
      hands: (r?.hands as LiveHand[]) ?? [],
      active: live && this.phase === "play" ? r.active : -1,
      turnEndsAt: this.turnEndsAt,
      canSplit: !!live && this.phase === "play" && canSplitLive(r),
      canDouble: !!live && this.phase === "play" && canDouble(r),
      shuffled: this.shuffled,
    };
  }
}

export type LiveTableView = RouletteTableView | BlackjackTableView | PokerTableView;
export type LiveTable = LiveRoulette | LiveBlackjack | LivePoker;

export function makeTable(def: LiveTableDef, wallet: LiveWallet, rng: Rng): LiveTable {
  if (def.kind === "poker") return new LivePoker(def, wallet, rng);
  return def.kind === "roulette" ? new LiveRoulette(def, wallet, rng) : new LiveBlackjack(def, wallet, rng);
}
