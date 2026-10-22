// Casino: test coin cüzdanları ve oyunlar (sunucu yetkili). Kartlar, rulet ve slot sonuçları burada,
// kriptografik rastgeleyle belirlenir; istemci yalnızca gösterir. Bakiyeler dosyada (WORLD_DATA_DIR)
// saklanır; ileride gerçek ekonomiye (bot veritabanı) taşınacak.
import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bjDeal, bjDouble, bjHit, bjSplit, bjStand, bjView, type BjRound, canDouble, canSplit, MAX_BET, MIN_BET, REFILL_TO, type Rng,
  roulettePayout, type RouletteBet, Shoe, SLOT_BETS, SLOT_STRIP, slotLine, START_BALANCE, validBet,
} from "../../shared/casino";
import type { ServerEvent } from "../../shared/protocol";

export const secureRng: Rng = () => randomInt(0, 2 ** 32) / 2 ** 32;

export class Wallets {
  private balances = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;
  readonly ready: Promise<void>;

  /** `file` null: yalnızca bellekte (testler). */
  constructor(private file: string | null) {
    this.ready = file
      ? readFile(file, "utf8")
          .then((t) => {
            for (const [k, v] of Object.entries(JSON.parse(t) as Record<string, number>)) if (Number.isFinite(v)) this.balances.set(k, v);
          })
          .catch(() => {})
      : Promise.resolve();
  }

  get(key: string): number {
    let b = this.balances.get(key);
    if (b === undefined) {
      b = START_BALANCE;
      this.balances.set(key, b);
      this.save();
    }
    return b;
  }

  /** Bakiyeyi `delta` kadar değiştirir; yetmezse false (değişmez). */
  add(key: string, delta: number): boolean {
    const b = this.get(key) + delta;
    if (b < 0) return false;
    this.balances.set(key, Math.round(b * 100) / 100);
    this.save();
    return true;
  }

  /** Bakiye en küçük bahsin altındaysa test coin doldurur. */
  refill(key: string): boolean {
    if (this.get(key) >= MIN_BET) return false;
    this.balances.set(key, REFILL_TO);
    this.save();
    return true;
  }

  private save(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const file = this.file!;
      void mkdir(join(file, ".."), { recursive: true })
        .then(() => writeFile(file, JSON.stringify(Object.fromEntries(this.balances))))
        .catch((e) => {
          if (!this.warned) console.warn("[casino] bakiyeler yazılamadı:", e);
          this.warned = true;
        });
    }, 1500);
  }
}

/** Oyuncunun casinodaki mesajları. */
export type CasinoMsg =
  | { t: "casino"; op: "wallet" | "refill" }
  | { t: "bj"; op: "deal"; bet: number }
  | { t: "bj"; op: "hit" | "stand" | "double" | "split" }
  | { t: "roulette"; bets: RouletteBet[] }
  | { t: "slot"; bet: number };

export class Casino {
  private shoes = new Map<number, Shoe>();
  private rounds = new Map<number, BjRound>();

  constructor(readonly wallets: Wallets, private rng: Rng = secureRng) {}

  /**
   * Bir mesajı işler; oyuncuya gidecek olayı ya da hatayı döndürür. `inside`: oyuncu casinonun içinde mi
   * (oyunlar yalnızca orada oynanır; bakiye her yerde görülebilir).
   */
  handle(sid: number, key: string, msg: CasinoMsg, inside: boolean): ServerEvent | { error: string } {
    const w = this.wallets;
    if (msg.t === "casino") {
      if (msg.op === "refill" && !w.refill(key)) return { error: "💰 Bakiyen bitince test coin alabilirsin." };
      return { t: "wallet", balance: w.get(key) };
    }
    if (!inside) return { error: "🎰 Oyunlar yalnızca casinonun içinde oynanır." };
    if (msg.t === "bj") {
      let r = this.rounds.get(sid);
      if (msg.op === "deal") {
        // Yarım kalmış el (masadan kalkıp dönünce): yeni bahis alınmaz, el kaldığı yerden sürer
        if (r && r.phase === "player") return this.bjEvent(sid, key, r);
        const bet = Math.floor(Number(msg.bet));
        if (!(bet >= MIN_BET && bet <= MAX_BET)) return { error: `🃏 Bahis ${MIN_BET}–${MAX_BET} arası olmalı.` };
        if (!w.add(key, -bet)) return { error: "💰 Bakiyen yetmiyor." };
        let shoe = this.shoes.get(sid);
        let shuffled = false;
        if (!shoe) {
          shoe = new Shoe(this.rng);
          this.shoes.set(sid, shoe);
          shuffled = true;
        } else shuffled = shoe.maybeShuffle();
        r = bjDeal(shoe, bet);
        this.rounds.set(sid, r);
        return this.bjEvent(sid, key, r, shuffled);
      }
      const shoe = this.shoes.get(sid);
      if (!r || !shoe || r.phase !== "player") return { error: "🃏 Önce bahsini koyup dağıt." };
      const h = r.hands[r.active];
      if (msg.op === "double" || msg.op === "split") {
        if (msg.op === "double" ? !canDouble(r) : !canSplit(r)) return { error: "🃏 Bu el için olmaz." };
        if (!w.add(key, -h.bet)) return { error: "💰 Bakiyen yetmiyor." };
        if (msg.op === "double") bjDouble(r, shoe);
        else bjSplit(r, shoe);
      } else if (msg.op === "hit") bjHit(r, shoe);
      else bjStand(r, shoe);
      return this.bjEvent(sid, key, r);
    }
    if (msg.t === "roulette") {
      const bets = Array.isArray(msg.bets) ? msg.bets.slice(0, 60).map(validBet) : [];
      if (!bets.length || bets.some((b) => !b)) return { error: "🎡 Bahisler geçersiz." };
      const ok = bets as RouletteBet[], total = ok.reduce((s, b) => s + b.amount, 0);
      if (total > MAX_BET * 4) return { error: "🎡 Masa limiti aşıldı." };
      if (!w.add(key, -total)) return { error: "💰 Bakiyen yetmiyor." };
      const n = Math.floor(this.rng() * 37);
      const payout = roulettePayout(ok, n);
      w.add(key, payout);
      return { t: "roulette", n, bets: ok, payout, balance: w.get(key) };
    }
    const bet = Number(msg.bet);
    if (!SLOT_BETS.includes(bet)) return { error: "🎰 Geçersiz bahis." };
    if (!w.add(key, -bet)) return { error: "💰 Bakiyen yetmiyor." };
    const stops = [0, 1, 2].map(() => Math.floor(this.rng() * SLOT_STRIP.length));
    const { mult } = slotLine(stops);
    const payout = bet * mult;
    w.add(key, payout);
    return { t: "slot", stops, mult, payout, balance: w.get(key) };
  }

  private bjEvent(sid: number, key: string, r: BjRound, shuffled = false): ServerEvent {
    if (r.phase === "done") {
      const win = r.hands.reduce((s, h) => s + (h.payout ?? 0), 0);
      if (win) this.wallets.add(key, win);
      this.rounds.delete(sid);
    }
    return { t: "bj", view: bjView(r, shuffled), balance: this.wallets.get(key) };
  }

  /** Oyuncu ayrıldı: yarım kalan el kendiliğinden durur ve sonuçlanır (çıkıp bahis kurtarılamaz). */
  leave(sid: number, key: string): void {
    const r = this.rounds.get(sid), shoe = this.shoes.get(sid);
    if (r && shoe) {
      while (r.phase === "player") bjStand(r, shoe);
      this.bjEvent(sid, key, r);
    }
    this.shoes.delete(sid);
  }
}
