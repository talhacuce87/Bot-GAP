// Çanta (I): solda dönen 3D karakterin ve etrafında kıyafet yuvaları (kıyafet mağazası gelince dolacak), altında
// süren etkiler; sağda sekmeli slot ızgarası, ağırlık barı ve en altta hızlı slot sırası (1–6, Minecraft gibi).
// Eşyalar sürükle-bırakla taşınır (aynı eşya birleşir); tıklanan eşyanın kartı: kullan, yanındakine ver, at.
// Dolap gelince ızgaranın yanına ikinci bir ızgara olarak açılacak.
import type { Look } from "../../../shared/protocol";
import { BUFFS, type BuffId, INV, invKg, type ItemCat, itemDef, type Slot, useText } from "../../../shared/items";
import type { ChibiPack } from "../avatars/chibiPack";
import { el, Panel } from "./panel";
import { WardrobePreview } from "./wardrobePreview";

type Tab = "all" | ItemCat;
const TABS: [Tab, string][] = [["all", "Hepsi"], ["food", "Yiyecek"], ["drink", "İçecek"], ["item", "Eşya"]];
const EQUIP: [string, string, string][] = [
  ["hat", "🧢", "Şapka"],
  ["top", "👕", "Üst"],
  ["bag", "🎒", "Çanta"],
  ["bottom", "👖", "Alt"],
  ["shoes", "👟", "Ayakkabı"],
];

export interface InvHooks {
  op(op: "use" | "drop", slot: number): void;
  move(from: number, to: number): void;
  give(slot: number, sid: number): void;
  /** Yanındaki (verilebilecek) oyuncu. */
  nearest(): { sid: number; name: string } | null;
  pack(): ChibiPack | null;
  look(): Look | null;
}

export class InventoryUi {
  private panel: Panel;
  private preview: WardrobePreview;
  private slots: Slot[] = Array.from({ length: INV.slots }, () => null);
  private cells: HTMLDivElement[] = [];
  private tab: Tab = "all";
  private sel = -1;
  private kgText: HTMLElement;
  private kgBar: HTMLElement;
  private detail: HTMLDivElement;
  private buffBox: HTMLDivElement;
  private tabs = new Map<Tab, HTMLButtonElement>();
  /** Sürükleme: kaynak slot, hayalet ve başladığı nokta. */
  private drag: { from: number; ghost: HTMLElement | null; x: number; y: number } | null = null;
  private dropArmed = -1;

  constructor(parent: HTMLElement, private h: InvHooks, playerName: string) {
    this.panel = new Panel(parent, "🎒 ÇANTA", "inv-panel");
    this.panel.onClose = () => this.preview.stop();
    const wrap = el("div", "inv-wrap", this.panel.body);

    // Sol: karakter ve kıyafet yuvaları
    const left = el("section", "inv-char", wrap);
    el("div", "inv-name", left, playerName || "GAP");
    const stage = el("div", "inv-stage", left);
    this.preview = new WardrobePreview(stage, () => h.pack());
    for (const [k, icon, name] of EQUIP) {
      const e = el("div", `inv-eq inv-eq-${k}`, left);
      el("span", "", e, icon);
      e.title = `${name} · kıyafet mağazasıyla gelecek`;
    }
    this.buffBox = el("div", "inv-buffs", left);

    // Sağ: sekmeler, ağırlık, ızgara, hızlı slot, kart
    const right = el("section", "inv-side", wrap);
    const head = el("div", "inv-head", right);
    const tabs = el("div", "inv-tabs", head);
    for (const [t, label] of TABS) {
      const b = el("button", "inv-tab", tabs, label);
      b.addEventListener("click", () => {
        this.tab = t;
        this.render();
      });
      this.tabs.set(t, b);
    }
    const kg = el("div", "inv-kg", head);
    this.kgText = el("span", "", kg);
    this.kgBar = el("i", "", el("div", "inv-kg-bar", kg));
    const grid = el("div", "inv-grid", right);
    for (let i = INV.hotbar; i < INV.slots; i++) this.cell(grid, i);
    el("div", "inv-hot-label", right, "Hızlı slot · 1–6 ile eline al, sol tıkla kullan");
    const hot = el("div", "inv-grid inv-hot", right);
    for (let i = 0; i < INV.hotbar; i++) this.cell(hot, i);
    this.detail = el("div", "inv-detail", right);

    addEventListener("pointermove", (e) => this.dragMove(e));
    addEventListener("pointerup", (e) => this.dragEnd(e));
    this.render();
  }

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  toggle(): void {
    if (this.isOpen) this.panel.close();
    else this.open();
  }

  open(): void {
    this.preview.setLook(this.h.look());
    this.preview.start();
    this.render();
    this.panel.open();
  }

  setSlots(s: Slot[]): void {
    this.slots = s;
    if (this.sel >= 0 && !s[this.sel]) this.sel = -1;
    this.render();
  }

  setBuffs(b: Partial<Record<BuffId, number>>, serverNow: number): void {
    this.buffBox.replaceChildren();
    for (const [k, until] of Object.entries(b) as [BuffId, number][]) {
      const left = Math.max(0, Math.ceil((until - serverNow) / 60_000));
      const chip = el("div", "inv-buff", this.buffBox, `${BUFFS[k].icon} ${BUFFS[k].name} · ${left} dk`);
      chip.title = BUFFS[k].desc;
    }
  }

  private cell(parent: HTMLElement, i: number): void {
    const c = el("div", "inv-slot", parent);
    c.dataset.i = String(i);
    if (i < INV.hotbar) el("small", "inv-key", c, String(i + 1));
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.slots[i]) return;
      e.preventDefault();
      this.drag = { from: i, ghost: null, x: e.clientX, y: e.clientY };
    });
    c.addEventListener("dblclick", () => this.slots[i] && this.h.op("use", i));
    this.cells[i] = c;
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.ghost) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      const s = this.slots[d.from];
      d.ghost = el("div", "inv-ghost", document.body, s ? itemDef(s.id)?.icon ?? "" : "");
      this.cells[d.from].classList.add("dragging");
    }
    d.ghost.style.left = `${e.clientX}px`;
    d.ghost.style.top = `${e.clientY}px`;
  }

  private dragEnd(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (!d.ghost) {
      // Tıklama: seç
      this.sel = this.sel === d.from ? -1 : d.from;
      this.dropArmed = -1;
      this.render();
      return;
    }
    d.ghost.remove();
    this.cells[d.from].classList.remove("dragging");
    const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(".inv-slot");
    const to = target ? Number(target.dataset.i) : -1;
    if (to >= 0 && to !== d.from) {
      this.h.move(d.from, to);
      this.sel = to;
    }
  }

  private render(): void {
    for (const [t, b] of this.tabs) b.classList.toggle("on", t === this.tab);
    for (let i = 0; i < INV.slots; i++) {
      const c = this.cells[i], s = this.slots[i], d = s ? itemDef(s.id) : undefined;
      c.querySelector(".inv-item")?.remove();
      c.classList.toggle("sel", i === this.sel);
      c.classList.toggle("dim", !!d && this.tab !== "all" && d.cat !== this.tab);
      if (!s || !d) continue;
      const it = el("span", "inv-item", c, d.icon);
      if (s.n > 1) el("b", "inv-n", it, String(s.n));
      c.title = d.name;
    }
    const kg = invKg(this.slots);
    this.kgText.textContent = `${kg.toFixed(1).replace(".", ",")} / ${INV.maxKg} kg`;
    this.kgBar.style.width = `${Math.min(100, (kg / INV.maxKg) * 100)}%`;
    this.kgBar.classList.toggle("full", kg > INV.maxKg * 0.85);
    this.renderDetail();
  }

  private renderDetail(): void {
    const box = this.detail;
    box.replaceChildren();
    const s = this.sel >= 0 ? this.slots[this.sel] : null, d = s ? itemDef(s.id) : undefined;
    if (!s || !d) {
      el("div", "inv-hint", box, "Bir eşyaya tıkla: ne işe yaradığını gör. Sürükle: yerini değiştir. Çift tık: kullan.");
      return;
    }
    el("span", "inv-detail-ic", box, d.icon);
    const mid = el("div", "inv-detail-mid", box);
    el("b", "", mid, `${d.name}${s.n > 1 ? ` ×${s.n}` : ""}`);
    el("small", "", mid, d.desc);
    const fx = useText(d);
    if (fx) el("span", "inv-fx", mid, fx);
    const btns = el("div", "inv-btns", box);
    const i = this.sel;
    if (d.use) el("button", "inv-use", btns, d.cat === "drink" ? "İç" : "Ye").addEventListener("click", () => this.h.op("use", i));
    const near = this.h.nearest();
    const give = el("button", "", btns, near ? `${near.name}'e ver` : "Ver");
    give.disabled = !near;
    give.title = near ? "" : "Vermek için bir arkadaşının yanına git";
    give.addEventListener("click", () => near && this.h.give(i, near.sid));
    const drop = el("button", "inv-drop", btns, this.dropArmed === i ? "Emin misin?" : "At");
    drop.addEventListener("click", () => {
      if (this.dropArmed === i) {
        this.dropArmed = -1;
        this.h.op("drop", i);
      } else {
        this.dropArmed = i;
        this.renderDetail();
      }
    });
  }
}
