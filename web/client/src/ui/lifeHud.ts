// Hayat ve para göstergesi (GTA/RP): sol altta canlı minimap ve altında can, açlık, enerji barları; sağ üstte
// GAP ₺ (değişince ne için kazandığını/harcadığını yazan bildirim kartı). Paraya tıklayınca cüzdan: bugünkü kazanç
// ve harcama, son işlemler. Can sıfırlanınca "yaralı" kartı: kırmızı kenar, kalan süre, arkadaşın kaldırabilir ya
// da E ile ambulans çağırırsın.
import { ECON, LIFE, type LifeState, lira, type MoneyTx, type WalletView } from "../../../shared/economy";
import { el, Panel } from "./panel";
import { BUFFS, type BuffId } from "../../../shared/items";

/** Minimapte işaret: oyuncu, bayılmış oyuncu, park ettiğin araba, iş hedefi. */
export interface MapDot {
  x: number;
  z: number;
  kind: "player" | "downed" | "car" | "target";
}

export interface MinimapBase {
  canvas: HTMLCanvasElement;
  minX: number;
  minZ: number;
  px: number;
}

const ICONS = {
  hp: `<svg viewBox="0 0 24 24"><path d="M12 20.5s-7-4.3-9.3-8.4C1 8.8 2.9 5 6.6 5c2.1 0 3.6 1.2 5.4 3 1.8-1.8 3.3-3 5.4-3 3.7 0 5.6 3.8 3.9 7.1-2.3 4.1-9.3 8.4-9.3 8.4z"/></svg>`,
  hunger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 3v7a2 2 0 0 0 4 0V3M8 10v11M17 21V3c-2 1-3 4-3 8h3"/></svg>`,
  thirst: `<svg viewBox="0 0 24 24"><path d="M12 2.5s-6.5 7.3-6.5 12a6.5 6.5 0 0 0 13 0c0-4.7-6.5-12-6.5-12z"/></svg>`,
  energy: `<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`,
};

/** Minimapin gösterdiği genişlik (m). */
const VIEW_M = 120;

export class LifeHud {
  private root: HTMLDivElement;
  private mm: HTMLCanvasElement;
  private bars = {} as Record<keyof LifeState, HTMLElement>;
  private rows = {} as Record<keyof LifeState, HTMLElement>;
  private pill: HTMLButtonElement;
  private cards: HTMLDivElement;
  private vignette: HTMLDivElement;
  private downedCard: HTMLDivElement;
  private downedTime: HTMLElement;
  private downedBar: HTMLElement;
  private wallet: Panel;
  private balance = 0;
  private shown = 0;
  private raf = 0;
  private downedUntil = 0;
  private lastDraw = 0;
  private prog: HTMLDivElement;
  private progText: HTMLElement;
  private progBar: HTMLElement;
  /** Süren kaldırma: biten an (sunucu saati), 0: yok. */
  private reviveUntil = 0;
  private buffBox: HTMLDivElement;

  constructor(parent: HTMLElement, private a: { openWallet(): void; ambulance(): void; base(): MinimapBase | null }) {
    this.root = el("div", "life-hud", parent);
    this.buffBox = el("div", "life-buffs", this.root);
    this.mm = el("canvas", "mm-canvas", this.root);
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.mm.width = 190 * dpr;
    this.mm.height = 130 * dpr;
    const box = el("div", "life-bars", this.root);
    for (const k of ["hp", "hunger", "thirst", "energy"] as const) {
      const row = el("div", `life-row ${k}`, box);
      const ic = el("span", "life-ic", row);
      ic.innerHTML = ICONS[k];
      const bar = el("div", "life-bar", row);
      this.bars[k] = el("i", "", bar);
      this.rows[k] = row;
    }
    this.pill = el("button", "money-pill", parent);
    this.pill.title = "Cüzdan";
    this.pill.addEventListener("click", () => this.a.openWallet());
    this.cards = el("div", "money-cards", parent);
    this.vignette = el("div", "downed-vignette", parent);
    this.downedCard = el("div", "downed-card", parent);
    const head = el("div", "downed-head", this.downedCard);
    head.innerHTML = `<span class="downed-ic">${ICONS.hp}</span>`;
    this.downedTime = el("b", "", head, "Yaralısın · 1:00");
    const bar = el("div", "downed-bar", this.downedCard);
    this.downedBar = el("i", "", bar);
    const hints = el("div", "downed-hints", this.downedCard);
    el("span", "", hints, "F · arkadaşın kaldırır");
    const amb = el("button", "", hints, `E · ambulans çağır (${lira(ECON.hospitalFee)})`);
    amb.addEventListener("click", () => this.a.ambulance());
    addEventListener("keydown", (e) => {
      if (this.downedUntil && e.code === "KeyE" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) this.a.ambulance();
    });
    this.prog = el("div", "revive-prog", parent);
    this.progText = el("b", "", this.prog);
    this.progBar = el("i", "", el("div", "revive-prog-bar", this.prog));
    this.wallet = new Panel(parent, "💰 CÜZDAN", "hub-panel wallet-panel");
    this.renderPill();
  }

  setLife(l: LifeState, downedUntil: number): void {
    for (const k of ["hp", "hunger", "thirst", "energy"] as const) {
      this.bars[k].style.width = `${Math.max(0, Math.min(100, l[k]))}%`;
      this.rows[k].classList.toggle("warn", l[k] < LIFE.warnBelow);
    }
    this.downedUntil = downedUntil;
    const on = downedUntil > 0;
    this.vignette.classList.toggle("show", on);
    this.downedCard.classList.toggle("show", on);
  }

  /** Süren etkiler: minimapin üstünde küçük ikonlar. */
  setBuffs(b: Partial<Record<string, number>>): void {
    this.buffBox.replaceChildren();
    for (const [k, until] of Object.entries(b)) {
      const d = BUFFS[k as BuffId];
      if (!d || !until) continue;
      const chip = el("span", "life-buff", this.buffBox, d.icon);
      chip.title = `${d.name}: ${d.desc}`;
    }
  }

  /** Kaldırma barı: `text` ("Kemal'i kaldırıyorsun…"), biten an; 0 gizler. */
  setReviving(text: string, until: number): void {
    this.reviveUntil = until;
    this.progText.textContent = text;
    this.prog.classList.toggle("show", until > 0);
  }

  /** Bakiye değişti; açıklamalı işlemse kart. */
  setMoney(balance: number, tx?: MoneyTx | null): void {
    this.balance = balance;
    if (!this.raf) this.raf = requestAnimationFrame(this.count);
    if (tx) this.card(tx);
    if (this.wallet.isOpen) this.a.openWallet();
  }

  /** Cüzdan paneli (sunucudan). */
  showWallet(v: WalletView): void {
    const b = this.wallet.body;
    b.replaceChildren();
    const top = el("div", "wallet-top", b);
    el("small", "", top, "Bakiye");
    el("b", "", top, lira(v.balance));
    const day = el("div", "wallet-day", b);
    const earn = el("div", "wallet-earn", day);
    el("small", "", earn, "Bugün kazandın");
    el("b", "", earn, `+ ${lira(v.earned)}`);
    const spend = el("div", "wallet-spend", day);
    el("small", "", spend, "Bugün harcadın");
    el("b", "", spend, `− ${lira(v.spent)}`);
    el("h4", "settings-section", b, "Son işlemler");
    const list = el("div", "wallet-list", b);
    if (!v.history.length) el("div", "settings-note hub-note", list, "Henüz işlem yok. İşlerden ve etkinliklerden para kazanırsın.");
    for (const t of v.history) {
      const row = el("div", "wallet-row", list);
      el("span", "wallet-ic", row, t.icon);
      const mid = el("div", "wallet-mid", row);
      el("span", "", mid, t.reason);
      el("small", "", mid, new Date(t.at).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }));
      el("b", t.amount >= 0 ? "up" : "down", row, `${t.amount >= 0 ? "+" : "−"} ${lira(Math.abs(t.amount))}`);
    }
    if (!this.wallet.isOpen) this.wallet.open();
  }

  get walletOpen(): boolean {
    return this.wallet.isOpen;
  }

  closeWallet(): void {
    this.wallet.close();
  }

  /** Kare başına: minimap (saniyede ~12) ve bayılma sayacı. `rot`: avatarın baktığı açı. */
  frame(me: { x: number; z: number; rot: number }, dots: MapDot[], serverNow: number): void {
    if (this.downedUntil) {
      const left = Math.max(0, this.downedUntil - serverNow);
      const s = Math.ceil(left / 1000);
      this.downedTime.textContent = `Yaralısın · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      this.downedBar.style.width = `${(left / LIFE.downedMs) * 100}%`;
    }
    if (this.reviveUntil) {
      const u = 1 - Math.max(0, this.reviveUntil - serverNow) / LIFE.reviveMs;
      this.progBar.style.width = `${Math.min(1, u) * 100}%`;
    }
    const now = performance.now();
    if (now - this.lastDraw < 80) return;
    this.lastDraw = now;
    this.drawMap(me, dots);
  }

  private drawMap(me: { x: number; z: number; rot: number }, dots: MapDot[]): void {
    const c = this.mm, g = c.getContext("2d")!;
    const w = c.width, h = c.height, s = w / VIEW_M;
    g.fillStyle = "#16202a";
    g.fillRect(0, 0, w, h);
    const base = this.a.base();
    if (base) {
      // Kuzey yukarıda; oyuncu ortada
      const sw = (w / s) * base.px, sh = (h / s) * base.px;
      const sx = (me.x - base.minX) * base.px - sw / 2, sy = (me.z - base.minZ) * base.px - sh / 2;
      g.imageSmoothingEnabled = true;
      g.drawImage(base.canvas, sx, sy, sw, sh, 0, 0, w, h);
      g.fillStyle = "rgba(10, 14, 20, 0.18)";
      g.fillRect(0, 0, w, h);
    }
    const P = (x: number, z: number): [number, number] => [w / 2 + (x - me.x) * s, h / 2 + (z - me.z) * s];
    const r = w / 95;
    for (const d of dots) {
      const [x, y] = P(d.x, d.z);
      if (x < -6 || y < -6 || x > w + 6 || y > h + 6) continue;
      if (d.kind === "car") {
        g.fillStyle = "#85b7eb";
        g.fillRect(x - r * 1.4, y - r * 2, r * 2.8, r * 4);
      } else if (d.kind === "target") {
        g.strokeStyle = "#ef9f27";
        g.lineWidth = r * 0.9;
        g.beginPath();
        g.arc(x, y, r * 2.6, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = "#ef9f27";
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillStyle = d.kind === "downed" ? "#ff4d5e" : "#5dcaa5";
        g.beginPath();
        g.arc(x, y, r * 1.6, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Sen: baktığın yöne dönen ok
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate(Math.PI - me.rot);
    g.fillStyle = "#fff";
    g.strokeStyle = "rgba(0,0,0,0.55)";
    g.lineWidth = r * 0.5;
    g.beginPath();
    g.moveTo(0, -r * 3.6);
    g.lineTo(r * 2.4, r * 2.6);
    g.lineTo(0, r * 1.4);
    g.lineTo(-r * 2.4, r * 2.6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    g.fillStyle = "#c9a24a";
    g.font = `500 ${Math.round(r * 5)}px system-ui, sans-serif`;
    g.textAlign = "right";
    g.fillText("K", w - r * 2.5, r * 6);
  }

  private card(tx: MoneyTx): void {
    const c = el("div", `money-card ${tx.amount >= 0 ? "up" : "down"}`, this.cards);
    el("span", "money-card-ic", c, tx.icon);
    const t = el("div", "", c);
    el("b", "", t, tx.reason);
    el("small", "", t, `${tx.amount >= 0 ? "+" : "−"} ${lira(Math.abs(tx.amount))}`);
    requestAnimationFrame(() => c.classList.add("show"));
    setTimeout(() => {
      c.classList.remove("show");
      setTimeout(() => c.remove(), 400);
    }, 3800);
    while (this.cards.children.length > 3) this.cards.firstElementChild?.remove();
  }

  /** Tutar sayarak değişir. */
  private count = (): void => {
    const d = this.balance - this.shown;
    this.shown = Math.abs(d) < 1 ? this.balance : this.shown + d * 0.2;
    this.renderPill();
    this.raf = this.shown === this.balance ? 0 : requestAnimationFrame(this.count);
  };

  private renderPill(): void {
    this.pill.textContent = lira(this.shown);
  }
}
