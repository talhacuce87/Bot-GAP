// Ekonomi deposu: GAP ₺ bakiyeleri, hayat barları (can/açlık/enerji), cüzdan geçmişi ve günlük kazanç/harcama.
// Dünya sunucusunun veri dosyasında (Docker volume) Discord hesabına bağlı saklanır; misafirlerinki ("guest:"
// anahtarlı) yalnızca bellekte, oturum boyunca. Para değişince dinleyen (sunucu) oyuncuya bildirim gönderir.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ECON, FULL_LIFE, type LifeState, type MoneyTx, type WalletView } from "../../shared/economy";
import { emptyInv, INV, itemDef, type Slot } from "../../shared/items";

interface Day {
  day: string;
  earned: number;
  spent: number;
  /** Kumarhanede bugünkü net kayıp (kazanınca azalır). */
  casino: number;
}

/** Para işlemi açıklaması (yoksa geçmişe yazılmaz, bildirim de gitmez: ör. kumarhane bahisleri). */
export interface TxInfo {
  reason: string;
  icon: string;
  /** Kumarhane: günlük kayıp sınırına sayılır. */
  casino?: boolean;
}

const today = (now = Date.now()) => new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
const guest = (key: string) => key.startsWith("guest:");

export class Economy {
  private balances = new Map<string, number>();
  private lives = new Map<string, LifeState>();
  private invs = new Map<string, Slot[]>();
  private history = new Map<string, MoneyTx[]>();
  private days = new Map<string, Day>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private warned = false;
  readonly ready: Promise<void>;
  /** Para değişti (sunucu ilgili oyuncuya gönderir). */
  onChange: (key: string, balance: number, tx: MoneyTx | null) => void = () => {};

  /** `file` null: yalnızca bellekte (testler). */
  constructor(private file: string | null) {
    this.ready = file
      ? readFile(file, "utf8")
          .then((t) => {
            const o = JSON.parse(t) as { balances?: Record<string, number>; lives?: Record<string, LifeState>; history?: Record<string, MoneyTx[]>; invs?: Record<string, Slot[]> };
            for (const [k, v] of Object.entries(o.balances ?? {})) if (Number.isFinite(v)) this.balances.set(k, v);
            // Su barından önceki kayıtlarda su yok: dolu başlar
            for (const [k, v] of Object.entries(o.lives ?? {})) if (v && Number.isFinite(v.hp)) this.lives.set(k, { ...v, thirst: Number.isFinite(v.thirst) ? v.thirst : 100 });
            for (const [k, v] of Object.entries(o.invs ?? {})) {
              if (!Array.isArray(v)) continue;
              const s = emptyInv();
              v.slice(0, INV.slots).forEach((x, i) => (s[i] = x && itemDef(x.id) && x.n > 0 ? { id: x.id, n: x.n } : null));
              this.invs.set(k, s);
            }
            for (const [k, v] of Object.entries(o.history ?? {})) if (Array.isArray(v)) this.history.set(k, v.slice(0, ECON.historyMax));
          })
          .catch(() => {})
      : Promise.resolve();
  }

  get(key: string): number {
    let b = this.balances.get(key);
    if (b === undefined) {
      b = ECON.startMoney;
      this.balances.set(key, b);
      this.save();
    }
    return b;
  }

  /**
   * Bakiyeyi `delta` kadar değiştirir; yetmezse (ya da kumarhane günlük kayıp sınırı dolduysa) false. `tx`
   * verilirse cüzdan geçmişine yazılır ve bildirim gider.
   */
  add(key: string, delta: number, tx?: TxInfo): boolean {
    const b = this.get(key) + delta;
    if (b < 0) return false;
    const d = this.day(key);
    if (tx?.casino && delta < 0 && d.casino - delta > ECON.casinoDailyLoss) return false;
    this.balances.set(key, Math.round(b * 100) / 100);
    if (tx?.casino) d.casino -= delta;
    if (delta > 0) d.earned += delta;
    else d.spent -= delta;
    let rec: MoneyTx | null = null;
    if (tx && !tx.casino && delta) {
      rec = { amount: delta, reason: tx.reason, icon: tx.icon, at: Date.now() };
      const h = this.history.get(key) ?? [];
      h.unshift(rec);
      this.history.set(key, h.slice(0, ECON.historyMax));
    }
    this.save();
    this.onChange(key, this.balances.get(key)!, rec);
    return true;
  }

  /** Ücret: yetmezse elde olan alınır (hastane gibi zorunlu ödemeler). Alınan tutarı döndürür. */
  charge(key: string, amount: number, tx: TxInfo): number {
    const take = Math.min(amount, this.get(key));
    if (take > 0) this.add(key, -take, tx);
    return take;
  }

  /** Kumarhane için cüzdan: bahisler günlük kayıp sınırına sayılır, geçmişe yazılmaz. */
  casino(): { get(key: string): number; add(key: string, delta: number): boolean } {
    return { get: (k) => this.get(k), add: (k, d) => this.add(k, d, { reason: "Kumarhane", icon: "🎰", casino: true }) };
  }

  /** Bugün kumarhanede daha ne kadar kaybedilebilir. */
  casinoLeft(key: string): number {
    return Math.max(0, ECON.casinoDailyLoss - this.day(key).casino);
  }

  life(key: string): LifeState {
    return { ...(this.lives.get(key) ?? FULL_LIFE) };
  }

  setLife(key: string, l: LifeState): void {
    const r = (v: number) => Math.round(v * 10) / 10;
    this.lives.set(key, { hp: r(l.hp), hunger: r(l.hunger), thirst: r(l.thirst), energy: r(l.energy) });
    this.save();
  }

  /** Çanta (kopya). */
  inv(key: string): Slot[] {
    return (this.invs.get(key) ?? emptyInv()).map((s) => (s ? { ...s } : null));
  }

  setInv(key: string, slots: Slot[]): void {
    this.invs.set(key, slots);
    this.save();
  }

  wallet(key: string): WalletView {
    const d = this.day(key);
    return { balance: this.get(key), earned: d.earned, spent: d.spent, history: this.history.get(key) ?? [] };
  }

  private day(key: string): Day {
    const t = today();
    let d = this.days.get(key);
    if (!d || d.day !== t) this.days.set(key, (d = { day: t, earned: 0, spent: 0, casino: 0 }));
    return d;
  }

  private save(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const file = this.file!;
      // Misafirler kalıcı değil
      const keep = <T>(m: Map<string, T>) => Object.fromEntries([...m].filter(([k]) => !guest(k)));
      const body = JSON.stringify({ balances: keep(this.balances), lives: keep(this.lives), history: keep(this.history), invs: keep(this.invs) });
      void mkdir(join(file, ".."), { recursive: true })
        .then(() => writeFile(file, body))
        .catch((e) => {
          if (!this.warned) console.warn("[economy] kayıt yazılamadı:", e);
          this.warned = true;
        });
    }, 2000);
  }
}
