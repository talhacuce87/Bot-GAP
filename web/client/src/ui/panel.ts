// Ortak açılır panel: başlık şeridi (simge, başlık, kapat), gövde. Ekranın ortasında açılır, arkası kararır; aynı
// anda tek panel açık kalır (yenisi açılınca öncekiler kapanır). Açıkken tuşlar oyuna gitmez; Esc kapatır.
import { listen } from "../mode";
import { type IconName, icon, stripEmoji } from "./icons";
import { modalClosed, modalOpened } from "./layout";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}

export function button(parent: HTMLElement, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", cls, parent, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/** Kaydırıcının dolu kısmı (Chrome ray rengini kendisi boyamaz). */
export function paintRange(r: HTMLInputElement): void {
  const min = Number(r.min || 0), max = Number(r.max || 100);
  r.style.setProperty("--p", `${((Number(r.value) - min) / (max - min || 1)) * 100}%`);
}

/** Kaydırıcı: değişince dolu kısım da güncellenir. */
export function range(parent: HTMLElement, o: { min: number; max: number; step: number; value: number; label?: string; cls?: string }): HTMLInputElement {
  const r = el("input", o.cls ?? "", parent);
  Object.assign(r, { type: "range", min: String(o.min), max: String(o.max), step: String(o.step), value: String(o.value) });
  if (o.label) r.setAttribute("aria-label", o.label);
  paintRange(r);
  r.addEventListener("input", () => paintRange(r));
  return r;
}

export class Panel {
  readonly root: HTMLDivElement;
  readonly body: HTMLDivElement;
  private titleEl: HTMLHeadingElement;
  private iconEl: HTMLSpanElement | null = null;
  onClose: () => void = () => {};

  constructor(private parent: HTMLElement, title: string, cls: string, iconName?: IconName) {
    this.root = el("div", `gpanel ${cls}`, parent);
    this.root.setAttribute("role", "dialog");
    const head = el("div", "gp-head", this.root);
    if (iconName) this.iconEl = icon(iconName, "gp-icon", head);
    this.titleEl = el("h3", "gp-title", head);
    this.title = title;
    const x = button(head, "", () => this.close(), "gp-x");
    icon("close", "", x);
    x.setAttribute("aria-label", "Kapat");
    x.title = "Kapat (Esc)";
    this.body = el("div", "gpanel-body", this.root);
    this.root.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement && e.key !== "Escape") {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      if (e.key === "Escape") this.close();
    });
    this.root.addEventListener("keyup", (e) => e.stopPropagation());
    // Odak panelin dışındayken de Esc kapatsın (mod değişince eski panel DOM'dan çıkar, yok sayılır)
    listen("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen && this.root.isConnected) this.close();
    });
  }

  /** Başlık: emojisi atılır, büyük harfle yazılır. */
  set title(t: string) {
    const clean = stripEmoji(t);
    this.titleEl.textContent = clean;
    this.root.setAttribute("aria-label", clean);
  }

  /** Başlıktaki simge (varsa değişir). */
  set icon(name: IconName) {
    const next = icon(name, "gp-icon");
    if (this.iconEl) this.iconEl.replaceWith(next);
    else this.titleEl.before(next);
    this.iconEl = next;
  }

  get isOpen(): boolean {
    return this.root.classList.contains("show");
  }

  open(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    if (!this.isOpen) modalOpened(this, this.parent);
    this.root.classList.add("show");
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.classList.remove("show");
    modalClosed(this);
    this.onClose();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }
}
