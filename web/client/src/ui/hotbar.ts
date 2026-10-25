// Alttaki hızlı slot (Minecraft gibi): çantanın ilk 6 slotu; 1–6 ile seçilen eşya eline geçer, sol tıkla
// kullanılır (yenir/içilir). Aynı rakama yeniden basınca el boşalır. Seçili eşyanın adı kısa süre üstünde yazar.
import { INV, itemDef, type Slot } from "../../../shared/items";
import { el } from "./panel";

export class Hotbar {
  private root: HTMLDivElement;
  private cells: HTMLDivElement[] = [];
  private label: HTMLDivElement;
  private labelTimer = 0;
  private slots: Slot[] = [];
  selected: number | null = null;

  constructor(parent: HTMLElement, private pick: (i: number) => void) {
    this.root = el("div", "hotbar", parent);
    this.label = el("div", "hotbar-label", this.root);
    const row = el("div", "hotbar-row", this.root);
    for (let i = 0; i < INV.hotbar; i++) {
      const c = el("div", "hotbar-slot", row);
      el("small", "", c, String(i + 1));
      c.addEventListener("click", () => this.pick(i));
      this.cells.push(c);
    }
  }

  setSlots(s: Slot[]): void {
    this.slots = s;
    this.render();
  }

  select(i: number | null): void {
    this.selected = i;
    this.render();
    const s = i === null ? null : this.slots[i], d = s ? itemDef(s.id) : undefined;
    window.clearTimeout(this.labelTimer);
    this.label.textContent = d ? `${d.name} · sol tık: ${d.cat === "drink" ? "iç" : "ye"}` : "";
    this.label.classList.toggle("show", !!d);
    this.labelTimer = window.setTimeout(() => this.label.classList.remove("show"), 1800);
  }

  /** Seçili slottaki eşya (yoksa null). */
  held(): Slot {
    return this.selected === null ? null : (this.slots[this.selected] ?? null);
  }

  private render(): void {
    this.cells.forEach((c, i) => {
      c.querySelector(".hotbar-item")?.remove();
      c.classList.toggle("on", i === this.selected);
      const s = this.slots[i], d = s ? itemDef(s.id) : undefined;
      if (!s || !d) return;
      const it = el("span", "hotbar-item", c, d.icon);
      if (s.n > 1) el("b", "", it, String(s.n));
    });
  }
}
