// Gardırop: kıyafet seçimi ve canlı önizleme (kendi karakterin üzerinde). Kaydet → bot doğrular,
// odaya botun temizlediği kıyafet yayınlanır. Vazgeç/kapat → kayıtlı kıyafete döner.
import { LOOK_SLOTS, type Look, type LookColor, type LookSlot, type WardrobeInfo } from "../../../shared/protocol";
import type { ChibiManifest } from "../avatars/chibiPack";

const TABS: { key: LookSlot | "colors"; label: string; emoji: string }[] = [
  { key: "hair", label: "Saç", emoji: "💇" },
  { key: "tops", label: "Üst", emoji: "👕" },
  { key: "bottoms", label: "Alt", emoji: "👖" },
  { key: "shoes", label: "Ayakkabı", emoji: "👟" },
  { key: "hats", label: "Şapka", emoji: "🎩" },
  { key: "glasses", label: "Gözlük", emoji: "👓" },
  { key: "facial", label: "Sakal", emoji: "🧔" },
  { key: "colors", label: "Renk", emoji: "🎨" },
];

/** Boş seçenek: üst/alt boşsa temel atlet/şort görünür. */
const NONE_LABEL: Record<LookSlot, string> = {
  hair: "Kel", tops: "Temel atlet", bottoms: "Temel şort", shoes: "Yalınayak", hats: "Yok", glasses: "Yok", facial: "Yok",
};

/** Saç ve üstlerde grup sırası (paket README'si); bilinmeyen gruplar sona. */
const GROUP_ORDER = ["Kısa", "Orta", "Uzun", "Örgü", "Günlük", "Forma", "Ceket", "Resmi", "Spor", "Tarihi", "Özel"];

const PALETTES: Record<LookColor, { label: string; colors: string[] }> = {
  skin: { label: "Ten", colors: ["#f6d7c3", "#ecb998", "#d9a07a", "#b97a53", "#8d5a3c", "#5e3b28"] },
  hair: { label: "Saç", colors: ["#1f1a17", "#4a3122", "#7b4a2a", "#c58b4a", "#e8c77a", "#a83a2c", "#e05a9a", "#3b6fd6", "#7a5bd6", "#d8d8d8"] },
  eye: { label: "Göz", colors: ["#3a5fc4", "#2fa36b", "#7b4a2a", "#3d3d3d", "#8a55c9", "#c9a227"] },
};

export interface WardrobeHooks {
  /** Sunucudan kayıtlı kıyafet + kilitleri iste. */
  request(): void;
  /** Seçim değişti: kendi karakterinde göster. */
  preview(look: Look): void;
  save(look: Look): void;
  /** Kaydetmeden kapandı: kayıtlı kıyafete dön. */
  cancel(): void;
  /** Açılınca kamerayı karakterin önüne al. */
  opened(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.append(e);
  return e;
}

export class Wardrobe {
  private panel: HTMLDivElement;
  private body: HTMLDivElement;
  private tabBar: HTMLDivElement;
  private saveBtn: HTMLButtonElement;
  private tab: LookSlot | "colors" = "hair";
  private look: Look = {};
  private info: WardrobeInfo | null = null;
  private dirty = false;
  isOpen = false;

  constructor(
    root: HTMLElement,
    private manifest: ChibiManifest,
    private hooks: WardrobeHooks,
  ) {
    this.panel = el("div", "panel wardrobe", root);
    const head = el("div", "wardrobe-head", this.panel);
    el("h3", "", head).textContent = "👕 GARDIROP";
    const close = el("button", "wardrobe-x", head);
    close.textContent = "✕";
    close.title = "Kapat (Esc)";
    close.addEventListener("click", () => this.close());
    this.tabBar = el("div", "wardrobe-tabs", this.panel);
    this.body = el("div", "wardrobe-body", this.panel);
    const foot = el("div", "wardrobe-foot", this.panel);
    const cancel = el("button", "wardrobe-cancel", foot);
    cancel.textContent = "Vazgeç";
    cancel.addEventListener("click", () => this.close());
    const save = (this.saveBtn = el("button", "wardrobe-save", foot));
    save.textContent = "Kaydet";
    save.disabled = true;
    save.addEventListener("click", () => {
      if (!this.info) return;
      this.hooks.save(this.look);
      this.dirty = false;
      this.hide();
    });

    addEventListener("keydown", (e) => {
      if (e.repeat || e.target instanceof HTMLInputElement) return;
      // Açma tuşu Input'ta (ayarlanabilir); burada yalnızca Esc
      if (e.key === "Escape" && this.isOpen) this.close();
    });
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.isOpen = true;
    this.info = null;
    this.panel.classList.add("show");
    this.body.replaceChildren(Object.assign(el("div", "wardrobe-msg"), { textContent: "Yükleniyor…" }));
    this.tabBar.replaceChildren();
    this.saveBtn.disabled = true;
    this.hooks.request();
    this.hooks.opened();
  }

  /** Kaydetmeden kapat: önizleme geri alınır. */
  close(): void {
    if (!this.isOpen) return;
    if (this.dirty) this.hooks.cancel();
    this.dirty = false;
    this.hide();
  }

  private hide(): void {
    this.isOpen = false;
    this.panel.classList.remove("show");
  }

  onInfo(w: WardrobeInfo | { error: string }): void {
    if (!this.isOpen) return;
    if ("error" in w) {
      this.body.replaceChildren(Object.assign(el("div", "wardrobe-msg"), { textContent: w.error }));
      return;
    }
    this.info = w;
    this.saveBtn.disabled = false;
    this.look = { ...w.outfit, colors: { ...w.outfit.colors } };
    this.renderTabs();
    this.renderBody();
  }

  private change(next: Look): void {
    this.look = next;
    this.dirty = true;
    this.hooks.preview(next);
    this.renderBody();
  }

  private renderTabs(): void {
    this.tabBar.replaceChildren(
      ...TABS.map((t) => {
        const b = el("button", t.key === this.tab ? "active" : "");
        b.textContent = `${t.emoji} ${t.label}`;
        b.addEventListener("click", () => {
          this.tab = t.key;
          this.renderTabs();
          this.renderBody();
        });
        return b;
      }),
    );
  }

  private renderBody(): void {
    if (!this.info) return;
    const scroll = this.body.scrollTop;
    this.body.replaceChildren(this.tab === "colors" ? this.colorsView() : this.slotView(this.tab));
    this.body.scrollTop = scroll;
  }

  private slotView(slot: LookSlot): HTMLElement {
    const wrap = el("div", "wardrobe-grid");
    const item = (id: string | null, label: string) => {
      const b = el("button", "wardrobe-item", wrap);
      const need = id ? this.info!.locked[id] : undefined;
      const locked = need !== undefined && this.info!.level < need;
      b.textContent = locked ? `🔒 ${label} · Sv ${need}` : label;
      b.disabled = locked;
      if ((this.look[slot] ?? null) === id) b.classList.add("on");
      b.addEventListener("click", () => this.change({ ...this.look, [slot]: id }));
    };
    item(null, NONE_LABEL[slot]);
    const rank = (g?: string) => (g ? (GROUP_ORDER.indexOf(g) + 1 || GROUP_ORDER.length + 1) : 0);
    const entries = Object.entries(this.manifest.parts)
      .filter(([id, p]) => p.cat === slot && !id.startsWith("base"))
      .sort(([, a], [, b]) => rank(a.group) - rank(b.group) || (a.label ?? "").localeCompare(b.label ?? "", "tr"));
    let group = "";
    for (const [id, p] of entries) {
      if (p.group && p.group !== group) {
        group = p.group;
        el("div", "wardrobe-group", wrap).textContent = group;
      }
      item(id, p.label ?? id);
    }
    return wrap;
  }

  private colorsView(): HTMLElement {
    const wrap = el("div", "wardrobe-colors");
    for (const key of Object.keys(PALETTES) as LookColor[]) {
      const row = el("div", "wardrobe-color-row", wrap);
      el("span", "wardrobe-color-label", row).textContent = PALETTES[key].label;
      const current = this.look.colors?.[key];
      const set = (v: string | undefined) => {
        const colors = { ...this.look.colors };
        if (v) colors[key] = v;
        else delete colors[key];
        this.change({ ...this.look, colors });
      };
      const def = el("button", `swatch default${current ? "" : " on"}`, row);
      def.title = "Varsayılan";
      def.textContent = "↺";
      def.addEventListener("click", () => set(undefined));
      for (const c of PALETTES[key].colors) {
        const s = el("button", `swatch${current === c ? " on" : ""}`, row);
        s.style.background = c;
        s.title = c;
        s.addEventListener("click", () => set(c));
      }
      const pick = el("input", "swatch-pick", row);
      pick.type = "color";
      pick.value = current ?? PALETTES[key].colors[0];
      pick.title = "Özel renk";
      pick.addEventListener("change", () => set(pick.value));
    }
    return wrap;
  }
}

/** Kıyafette yalnızca bilinen slotlar kalır (sunucuya gönderilecek biçim). */
export function plainLook(look: Look): Look {
  const out: Look = {};
  for (const s of LOOK_SLOTS) out[s] = look[s] ?? null;
  out.colors = { ...look.colors };
  return out;
}
