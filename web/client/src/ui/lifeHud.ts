// Hayat ve para göstergesi (GTA/RP): sol altta canlı minimap ve altında can, açlık, enerji barları; sağ üstte
// GAP ₺ (değişince ne için kazandığını/harcadığını yazan bildirim kartı). Paraya tıklayınca cüzdan: bugünkü kazanç
// ve harcama, son işlemler. Can sıfırlanınca "yaralı" kartı: kırmızı kenar, kalan süre, arkadaşın kaldırabilir ya
// da E ile ambulans çağırırsın.
import { ECON, LIFE, type LifeState, lira, type MoneyTx, type WalletView } from "../../../shared/economy";
import { type IconName, icon } from "./icons";
import { region, setToolTip } from "./layout";
import { el, Panel } from "./panel";
import { BUFFS, type BuffId } from "../../../shared/items";

/** Minimapte işaret: oyuncu, bayılmış oyuncu, park ettiğin araba, iş hedefi. */
export interface MapDot {
  x: number;
  z: number;
  kind: "player" | "downed" | "car" | "target" | "call" | "waypoint";
}

export interface MinimapBase {
  canvas: HTMLCanvasElement;
  minX: number;
  minZ: number;
  px: number;
}

const ICONS: Record<keyof LifeState, IconName> = { hp: "heart", hunger: "forkKnife", thirst: "drop", energy: "lightning" };
const NAMES: Record<keyof LifeState, string> = { hp: "Can", hunger: "Açlık", thirst: "Susuzluk", energy: "Enerji" };

/** Navigasyon rotasının rengi (navigator NAV_COLOR ile aynı). */
const NAV_LINE = "#36c8ff";

/** Minimapin gösterdiği genişlik (m) ve ekrandaki boyutu (px). */
const VIEW_M = 120;
const MM_W = 214;
const MM_H = 140;

export class LifeHud {
  private root: HTMLDivElement;
  private mm: HTMLCanvasElement;
  private bars = {} as Record<keyof LifeState, HTMLElement>;
  private rows = {} as Record<keyof LifeState, HTMLElement>;
  private pill: HTMLButtonElement;
  private pillValue: HTMLElement;
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
    this.root = el("div", "life-hud", region(parent, "bl"));
    this.buffBox = el("div", "life-buffs", this.root);
    this.mm = el("canvas", "mm-canvas", el("div", "mm-wrap", this.root));
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.mm.width = MM_W * dpr;
    this.mm.height = MM_H * dpr;
    const box = el("div", "life-bars", this.root);
    for (const k of ["hp", "hunger", "thirst", "energy"] as const) {
      const row = el("div", `life-row ${k}`, box);
      row.title = NAMES[k];
      icon(ICONS[k], "", el("span", "life-ic", row));
      const bar = el("div", "life-bar", row);
      this.bars[k] = el("i", "", bar);
      this.rows[k] = row;
    }
    const tr = region(parent, "tr");
    this.pill = el("button", "money-pill", tr);
    this.pill.type = "button";
    el("span", "money-ic", this.pill, "₺");
    this.pillValue = el("span", "money-val", this.pill);
    setToolTip(this.pill, "Cüzdan");
    this.pill.addEventListener("click", () => this.a.openWallet());
    this.cards = el("div", "money-cards", tr);
    this.vignette = el("div", "downed-vignette", parent);
    const bc = region(parent, "bc");
    this.downedCard = el("div", "downed-card", bc);
    const head = el("div", "downed-head", this.downedCard);
    icon("heart", "downed-ic", head);
    this.downedTime = el("b", "", head, "Yaralısın · 1:00");
    const bar = el("div", "downed-bar", this.downedCard);
    this.downedBar = el("i", "", bar);
    const hints = el("div", "downed-hints", this.downedCard);
    el("span", "", hints, "Arkadaşın F ile kaldırabilir");
    const amb = el("button", "", hints, `E · Ambulans (${lira(ECON.hospitalFee)})`);
    amb.type = "button";
    amb.addEventListener("click", () => this.a.ambulance());
    addEventListener("keydown", (e) => {
      if (this.downedUntil && e.code === "KeyE" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) this.a.ambulance();
    });
    this.prog = el("div", "revive-prog", bc);
    this.progText = el("b", "", this.prog);
    this.progBar = el("i", "", el("div", "revive-prog-bar", this.prog));
    this.wallet = new Panel(parent, "Cüzdan", "hub-panel wallet-panel", "wallet");
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
  frame(me: { x: number; z: number; rot: number }, dots: MapDot[], serverNow: number, route: readonly [number, number][] | null = null): void {
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
    this.drawMap(me, dots, route);
  }

  private drawMap(me: { x: number; z: number; rot: number }, dots: MapDot[], route: readonly [number, number][] | null): void {
    const c = this.mm, g = c.getContext("2d")!;
    const w = c.width, h = c.height, s = w / VIEW_M;
    g.fillStyle = "#121a22";
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
    // Navigasyon rotası (GPS çizgisi): koyu kenarlı mavi
    if (route && route.length > 1) {
      g.lineCap = g.lineJoin = "round";
      for (const [color, width] of [["rgba(4, 30, 60, 0.75)", r * 2.4], [NAV_LINE, r * 1.3]] as const) {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        route.forEach(([x, z], i) => (i ? g.lineTo(...P(x, z)) : g.moveTo(...P(x, z))));
        g.stroke();
      }
    }
    for (const d of dots) {
      let [x, y] = P(d.x, d.z);
      const goal = d.kind === "target" || d.kind === "waypoint", tint = d.kind === "waypoint" ? NAV_LINE : "#ef9f27";
      // Hedef (iş ya da işaret) minimapin dışındaysa kenarda, yönünü gösteren üçgen (GTA gibi)
      if (goal && (x < r * 3 || y < r * 3 || x > w - r * 3 || y > h - r * 3)) {
        const dx = x - w / 2, dy = y - h / 2, k = Math.min((w / 2 - r * 3) / Math.abs(dx || 1e-6), (h / 2 - r * 3) / Math.abs(dy || 1e-6));
        x = w / 2 + dx * k;
        y = h / 2 + dy * k;
        g.save();
        g.translate(x, y);
        g.rotate(Math.atan2(dy, dx));
        g.fillStyle = tint;
        g.strokeStyle = "rgba(0,0,0,0.5)";
        g.lineWidth = r * 0.4;
        g.beginPath();
        g.moveTo(r * 2.6, 0);
        g.lineTo(-r * 1.6, r * 1.8);
        g.lineTo(-r * 1.6, -r * 1.8);
        g.closePath();
        g.fill();
        g.stroke();
        g.restore();
        continue;
      }
      if (x < -6 || y < -6 || x > w + 6 || y > h + 6) continue;
      if (d.kind === "call") {
        g.fillStyle = "#fac775";
        g.strokeStyle = "#412402";
        g.lineWidth = r * 0.5;
        g.beginPath();
        g.arc(x, y, r * 2, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        continue;
      }
      if (d.kind === "car") {
        g.fillStyle = "#e8eef5";
        g.fillRect(x - r * 1.4, y - r * 2, r * 2.8, r * 4);
      } else if (goal) {
        g.strokeStyle = tint;
        g.lineWidth = r * 0.9;
        g.beginPath();
        g.arc(x, y, r * 2.6, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = tint;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      } else {
        g.fillStyle = d.kind === "downed" ? "#ff5a6a" : "#5db3ff";
        g.beginPath();
        g.arc(x, y, r * 1.6, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Sen: baktığın yöne dönen ok (safran)
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate(Math.PI - me.rot);
    g.fillStyle = "#ffb547";
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
    this.pillValue.textContent = Math.round(this.shown).toLocaleString("tr-TR");
  }
}
