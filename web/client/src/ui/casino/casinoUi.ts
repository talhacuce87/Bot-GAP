// Casino oyun ekranı: masaya oturunca açılan alt katman. Başlık, canlı bakiye (GAP ₺, sayarak değişir) ve
// "Kalk". Açıkken klavye oyuna değil bu ekrana gider (yanlışlıkla kalkılmaz); kısayolları oyun işler.
// Rulet ve blackjack canlı masalardır: oturan oynar, yakında duran izler (sunucuda ortak, süreli turlar).
import { POKER } from "../../../../shared/poker";
import type { ClientEvent, ServerEvent } from "../../../../shared/protocol";
import { BlackjackView } from "./blackjackView";
import type { LiveCtx } from "./liveBar";
import { LiveBlackjackView } from "./liveBlackjackView";
import { LivePokerView } from "./livePokerView";
import { RouletteView } from "./rouletteView";
import { SlotView } from "./slotView";

export type GameKind = "blackjack" | "roulette" | "slot" | "poker";
export type CasinoEvent = Extract<ServerEvent, { t: "wallet" | "bj" | "roulette" | "slot" | "live" }>;

export interface GameView {
  readonly el: HTMLElement;
  /** Bu oyunun sunucu olayı. */
  event(ev: CasinoEvent): void;
  /** Klavye kısayolu: işlendiyse true. */
  key(code: string): boolean;
  /** Sunucu hamleyi reddetti (bildirim geldi): bekleyen hamle kilidini aç. */
  failed(): void;
  /** Bakiye dışarıdan değişti: düğmeleri yenile. */
  refresh(): void;
  dispose(): void;
}

export interface CasinoCtx {
  send(ev: ClientEvent): void;
  balance(): number;
  /** Bakiyeyi güncelle (sayarak). */
  setBalance(b: number): void;
  toast(text: string): void;
}

const TITLES: Record<GameKind, string> = { blackjack: "♠ BLACKJACK", roulette: "🎡 RULET", slot: "🎰 GAP SLOT", poker: "♣ TEXAS HOLD'EM" };

/** Canlı masa: masa numarası ve oturulan koltuk (null: izleyici). */
export interface LiveSeat {
  table: number;
  seat: number | null;
}

export const fmt = (n: number) => Math.round(n).toLocaleString("tr-TR");

export class CasinoUi {
  private root: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private balEl: HTMLElement;
  private body: HTMLDivElement;
  private view: GameView | null = null;
  private kind: GameKind | null = null;
  private live: LiveSeat | null = null;
  /** Canlı masadan ilk görünüm geldi mi (gelmeden ret: yer dolu vb.). */
  private liveSeen = false;
  private closeBtn: HTMLButtonElement;
  /** Açık mı (görünür sınıfı bir kare sonra eklenir; o arada gelen olaylar kaybolmasın). */
  private opened = false;
  private target = 0;
  private shown = 0;
  private raf = 0;
  private watchdog = 0;
  private ctx: CasinoCtx;

  constructor(
    private parent: HTMLElement,
    private net: { send(ev: ClientEvent): void; serverNow(): number; you: number },
    private opts: { onClose(): void; toast(text: string): void },
  ) {
    this.root = document.createElement("div");
    this.root.className = "cz-overlay";
    const head = document.createElement("div");
    head.className = "cz-head";
    this.titleEl = document.createElement("div");
    this.titleEl.className = "cz-title";
    const bal = document.createElement("div");
    bal.className = "cz-balance";
    bal.innerHTML = '💰 <b>0</b> <span>₺</span>';
    this.balEl = bal.querySelector("b")!;
    const close = (this.closeBtn = document.createElement("button"));
    close.className = "cz-close";
    close.textContent = "Kalk ✕";
    close.title = "Masadan kalk (Esc)";
    close.addEventListener("click", () => this.leave());
    head.append(this.titleEl, bal, close);
    this.body = document.createElement("div");
    this.body.className = "cz-body";
    const panel = document.createElement("div");
    panel.className = "cz-panel";
    panel.append(head, this.body);
    this.root.append(panel);
    parent.append(this.root);
    this.ctx = {
      send: (ev) => {
        this.net.send(ev);
        // Yanıt gelmezse (bağlantı koptu) oyun ekranı kilitli kalmasın
        clearTimeout(this.watchdog);
        this.watchdog = window.setTimeout(() => this.view?.failed(), 4000);
      },
      balance: () => this.target,
      setBalance: (b) => this.setBalance(b),
      toast: (t) => this.opts.toast(t),
    };
    // Yakalama aşamasında: açıkken tuşlar oyunun girişine (yürüme, kalkma) ulaşmaz
    for (const type of ["keydown", "keyup"] as const) addEventListener(type, this.onKey, true);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Son bilinen bakiye. */
  get balance(): number {
    return this.target;
  }

  get game(): GameKind | null {
    return this.isOpen ? this.kind : null;
  }

  /** Canlı masa izlenirken (oturmadan) açık mı. */
  get watching(): LiveSeat | null {
    return this.isOpen && this.live?.seat === null ? this.live : null;
  }

  open(kind: GameKind, live: LiveSeat | null = null): void {
    if (this.isOpen && this.kind === kind && this.live?.table === live?.table && this.live?.seat === live?.seat) return;
    if (this.live) this.net.send({ t: "live", op: "leave" });
    this.view?.dispose();
    this.kind = kind;
    this.live = live;
    this.liveSeen = false;
    this.titleEl.innerHTML = live ? `<i class="cz-live-dot"></i>CANLI ${TITLES[kind]}` : TITLES[kind];
    this.closeBtn.textContent = live?.seat === null ? "Ayrıl ✕" : "Kalk ✕";
    this.closeBtn.title = live?.seat === null ? "İzlemeyi bırak (Esc)" : "Masadan kalk (Esc)";
    const lc: LiveCtx | null = live && { ...live, me: () => this.net.you, now: () => this.net.serverNow() };
    this.view =
      kind === "poker" && lc
        ? new LivePokerView(this.ctx, lc)
        : kind === "blackjack"
        ? lc ? new LiveBlackjackView(this.ctx, lc) : new BlackjackView(this.ctx)
        : kind === "roulette" ? new RouletteView(this.ctx, lc) : new SlotView(this.ctx);
    // Pokerde masaya bakiyeden para alınır (bakiye azsa elindeki kadar)
    const buyIn = kind === "poker" ? Math.max(POKER.minBuyIn, Math.min(POKER.buyIn, Math.floor(this.target))) : undefined;
    if (live) this.net.send(live.seat === null ? { t: "live", op: "watch", table: live.table } : { t: "live", op: "sit", table: live.table, seat: live.seat, buyIn });
    this.body.replaceChildren(this.view.el);
    this.root.className = `cz-overlay cz-${kind}`;
    this.opened = true;
    requestAnimationFrame(() => this.root.classList.add("show"));
    this.parent.classList.add("casino-open");
    if (document.pointerLockElement) document.exitPointerLock();
    this.net.send({ t: "casino", op: "wallet" });
  }

  close(): void {
    if (this.live && this.isOpen) this.net.send({ t: "live", op: "leave" });
    this.live = null;
    this.opened = false;
    this.root.classList.remove("show");
    this.parent.classList.remove("casino-open");
    this.view?.dispose();
    this.view = null;
  }

  event(ev: CasinoEvent): void {
    clearTimeout(this.watchdog);
    if (ev.t === "live") {
      if (!this.isOpen || ev.table.id !== this.live?.table) return;
      // Oturduysak masa koltuğu bize gösterene kadar kabul edilmiş sayılmaz (reddedilirse kalkılır)
      if (this.live.seat === null || ev.table.seats[this.live.seat]?.sid === this.net.you) this.liveSeen = true;
    }
    if (ev.t === "wallet") {
      this.setBalance(ev.balance);
      this.view?.refresh();
    } else this.view?.event(ev);
  }

  /** Sunucudan bildirim geldi (hata ya da reddedilen hamle). */
  failed(): void {
    clearTimeout(this.watchdog);
    // Canlı masa bizi almadı (yer dolu, uzak): kalk
    if (this.live && !this.liveSeen && this.isOpen) return this.leave();
    this.view?.failed();
  }

  /** Kalk ya da izlemeyi bırak. */
  private leave(): void {
    if (this.live?.seat === null) this.close();
    else this.opts.onClose();
  }

  private setBalance(b: number): void {
    this.target = b;
    if (this.raf) return;
    const tick = () => {
      const d = this.target - this.shown;
      this.shown = Math.abs(d) < 1 ? this.target : this.shown + d * 0.18;
      this.balEl.textContent = fmt(this.shown);
      this.balEl.parentElement!.classList.toggle("up", d > 1);
      this.balEl.parentElement!.classList.toggle("down", d < -1);
      this.raf = this.shown === this.target ? 0 : requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if (e.code === "Escape") {
      if (e.type === "keydown") this.leave();
      e.stopPropagation();
      return;
    }
    // Enter sohbeti açar (masada konuşulabilsin)
    if (e.code === "Enter" || e.code === "NumpadEnter") return;
    // Son tıklanan düğme odakta kalmasın: Space ona bir kez daha basardı (ör. çipi tekrar eklerdi)
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement && this.root.contains(focused)) focused.blur();
    if (e.type === "keydown" && !e.repeat && this.view?.key(e.code)) e.preventDefault();
    if (e.code === "Space") e.preventDefault();
    e.stopPropagation();
  };
}
