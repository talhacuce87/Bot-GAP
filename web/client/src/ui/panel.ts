// Ortak açılır panel: başlık, kapat düğmesi, gövde. Açıkken tuşlar oyuna gitmez; Esc kapatır.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}

export function button(parent: HTMLElement, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", cls, parent, label);
  b.addEventListener("click", onClick);
  return b;
}

export class Panel {
  readonly root: HTMLDivElement;
  readonly body: HTMLDivElement;
  private titleEl: HTMLHeadingElement;
  onClose: () => void = () => {};

  constructor(parent: HTMLElement, title: string, cls: string) {
    this.root = el("div", `panel gpanel ${cls}`, parent);
    const head = el("div", "wardrobe-head", this.root);
    this.titleEl = el("h3", "", head, title);
    button(head, "✕", () => this.close(), "wardrobe-x").setAttribute("aria-label", "Kapat");
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
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen && this.root.isConnected) this.close();
    });
  }

  set title(t: string) {
    this.titleEl.textContent = t;
  }

  get isOpen(): boolean {
    return this.root.classList.contains("show");
  }

  open(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    this.root.classList.add("show");
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.classList.remove("show");
    this.onClose();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }
}
