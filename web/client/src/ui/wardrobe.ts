// Gardırop: kıyafet seçimi ve canlı önizleme (ekranı kaplayan pencerede, platformdaki karakter).
// Kaydet → bot doğrular, odaya botun temizlediği kıyafet yayınlanır. Vazgeç/kapat → kayıtlı kıyafete döner.
import { LOOK_SLOTS, type Look, type LookColor, type LookSlot, type WardrobeInfo } from "../../../shared/protocol";
import { lookItem, LOOK_PRICES, lookShop } from "../../../shared/shop";
import { owned } from "../owned";
import type { ChibiManifest, ChibiPack } from "../avatars/chibiPack";
import { type PreviewFocus, type ThumbRegion, WardrobePreview } from "./wardrobePreview";

type Tab = LookSlot | "colors";

const TABS: { key: Tab; label: string; focus: PreviewFocus; region: ThumbRegion }[] = [
  { key: "hair", label: "Saç", focus: "head", region: "head" },
  { key: "tops", label: "Üst", focus: "body", region: "torso" },
  { key: "bottoms", label: "Alt", focus: "body", region: "legs" },
  { key: "shoes", label: "Ayakkabı", focus: "body", region: "feet" },
  { key: "hats", label: "Şapka", focus: "head", region: "head" },
  { key: "glasses", label: "Gözlük", focus: "head", region: "head" },
  { key: "facial", label: "Sakal", focus: "head", region: "head" },
  { key: "colors", label: "Renkler", focus: "body", region: "torso" },
];

/** Dükkânda açılan gardırop: yalnızca o dükkânın işi (berberde saç, modada kıyafet). */
export type WardrobeShop = "barber" | "fashion";
const SHOP: Record<WardrobeShop, { kicker: string; title: string; tabs: Tab[]; colors: LookColor[] }> = {
  barber: { kicker: "BERBER CEMİL", title: "BERBER", tabs: ["hair", "facial", "colors"], colors: ["hair"] },
  fashion: { kicker: "GAP AVM", title: "GAP MODA", tabs: ["tops", "bottoms", "shoes", "hats", "glasses"], colors: [] },
};

/** Kategori simgeleri (24×24 çizgi). */
const ICONS: Record<Tab, string> = {
  hair: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/>',
  tops: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  bottoms: '<path d="M6 2h12l1.2 20h-5.4L12 10.5 10.2 22H4.8z"/><path d="M6 6h12"/>',
  shoes: '<path d="M2 18h20v-2.4a2.5 2.5 0 0 0-2-2.45L14.5 12 13 6H8.6L8 9.2l-4 1A2.6 2.6 0 0 0 2 12.7z"/><path d="M9.5 12.5h2M10 15h2.5"/>',
  hats: '<path d="M5 15a7 7 0 0 1 14 0"/><path d="M2.5 15h19v1.8a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M12 8V5"/>',
  glasses: '<circle cx="6" cy="15" r="4"/><circle cx="18" cy="15" r="4"/><path d="M14 15a2 2 0 0 0-4 0M2.5 13 5 7c.7-1.3 1.4-2 3-2M21.5 13 19 7c-.7-1.3-1.5-2-3-2"/>',
  facial: '<path d="M5 6v5a7 7 0 0 0 14 0V6"/><path d="M8 13c1.5-1.2 2.7-1.2 4 0 1.3-1.2 2.5-1.2 4 0"/>',
  colors: '<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/>',
};

/** Boş seçenek: üst/alt boşsa temel atlet/şort görünür. */
const NONE_LABEL: Record<LookSlot, string> = {
  hair: "Kel", tops: "Temel atlet", bottoms: "Temel şort", shoes: "Yalınayak", hats: "Yok", glasses: "Yok", facial: "Yok",
};

/** Saç ve üstlerde grup sırası (paket README'si); bilinmeyen gruplar sona. */
const GROUP_ORDER = ["Kısa", "Orta", "Uzun", "Örgü", "Günlük", "Forma", "Ceket", "Resmi", "Spor", "Tarihi", "Özel"];

/** Grup başına kart rengi (kartın alt şeridi ve parıltısı). */
const GROUP_TINT: Record<string, string> = {
  Kısa: "#8a9bb8", Günlük: "#8a9bb8",
  Orta: "#3fcf8e", Forma: "#3fcf8e",
  Uzun: "#3d8bff", Ceket: "#3d8bff",
  Örgü: "#a66bff", Resmi: "#a66bff",
  Spor: "#22c7d6", Tarihi: "#ff8a3d", Özel: "#ffc83d",
};
const DEFAULT_TINT = "#6c7bff";

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
  /** Açılıp kapanınca: dünya girişi (WASD, fare) ve dünya çizimi durur/sürer. */
  modal(open: boolean): void;
  /** Dünyanın indirdiği chibi paketi (henüz inmediyse null). */
  pack(): ChibiPack | null;
  /** Satın al (sunucu parayı alır, "owned" ile döner). */
  buy(item: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.append(e);
  return e;
}

function icon(key: Tab, parent: HTMLElement): void {
  const s = el("span", "wd-icon", parent);
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
}

/** Tuş ipucu: [ESC] Vazgeç gibi. */
function kbd(parent: HTMLElement, keys: string, label: string): HTMLElement {
  const wrap = el("span", "wd-hint", parent);
  for (const k of keys.split(" ")) el("kbd", "", wrap).textContent = k;
  el("span", "", wrap).textContent = label;
  return wrap;
}

/** Aramada Türkçe harf ve büyük/küçük farkı yok sayılır. */
function fold(s: string): string {
  return s.toLocaleLowerCase("tr").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
}

const copyLook = (l: Look): Look => ({ ...l, colors: { ...l.colors } });

export class Wardrobe {
  private backdrop: HTMLDivElement;
  private panel: HTMLDivElement;
  private preview: WardrobePreview;
  private rail: HTMLElement;
  private listTitle: HTMLHeadingElement;
  private listCount: HTMLSpanElement;
  private search: HTMLInputElement;
  private body: HTMLDivElement;
  private saveBtn: HTMLButtonElement;
  private levelEl: HTMLSpanElement;
  private tab: Tab = "hair";
  /** Gösterilen sekmeler ve renkler (dükkânda kısıtlı). */
  private tabs = TABS;
  private colorKeys = Object.keys(PALETTES) as LookColor[];
  private kickerEl: HTMLSpanElement;
  private titleEl: HTMLHeadingElement;
  private look: Look = {};
  /** Açılışta kayıtlı kıyafet (Sıfırla buna döner; kart resimleri bunun üzerine giydirilir). */
  private saved: Look = {};
  private info: WardrobeInfo | null = null;
  /** Dükkânda açıldıysa hangisi (satın alma yalnızca orada). */
  private shop: WardrobeShop | null = null;
  /** Satın alınıp giyilmeyi bekleyen kayıt. */
  private pendingSave = false;
  private dirty = false;
  private query = "";
  private abort = new AbortController();
  isOpen = false;

  constructor(
    root: HTMLElement,
    private manifest: ChibiManifest,
    private hooks: WardrobeHooks,
    playerName = "",
  ) {
    this.backdrop = el("div", "wardrobe-backdrop", root);
    this.panel = el("div", "wardrobe", this.backdrop);

    // ---- Üst şerit: başlık, oyuncu, kapat ----
    const top = el("header", "wd-top", this.panel);
    const title = el("div", "wd-title", top);
    this.kickerEl = el("span", "wd-kicker", title);
    this.titleEl = el("h2", "", title);
    const player = el("div", "wd-player", top);
    el("span", "wd-player-name", player).textContent = playerName;
    this.levelEl = el("span", "wd-level", player);
    const close = el("button", "wd-x", top);
    close.title = "Kapat";
    kbd(close, "ESC", "Kapat");
    close.addEventListener("click", () => this.close());

    // ---- Sol: kategori slotları ----
    this.rail = el("nav", "wd-rail", this.panel);

    // ---- Orta: sahne ----
    const stage = el("section", "wd-stage", this.panel);
    el("div", "wd-stage-name", stage).textContent = playerName || "GAP";
    this.preview = new WardrobePreview(stage, () => hooks.pack());
    const turn = el("div", "wd-turn", stage);
    const turnBtn = (text: string, title: string, fn: () => void) => {
      const b = el("button", "", turn);
      b.textContent = text;
      b.title = title;
      b.addEventListener("click", fn);
    };
    turnBtn("◀", "Sola döndür (A)", () => this.preview.turn(-1));
    turnBtn("Öne dön", "Yüzü öne çevir", () => this.preview.front());
    turnBtn("▶", "Sağa döndür (D)", () => this.preview.turn(1));

    // ---- Sağ: parça listesi ----
    const list = el("section", "wd-list", this.panel);
    const head = el("div", "wd-list-head", list);
    const titles = el("div", "wd-list-titles", head);
    this.listTitle = el("h3", "", titles);
    this.listCount = el("span", "wd-count", titles);
    this.search = el("input", "wd-search", head);
    this.search.type = "search";
    this.search.placeholder = "Ara…";
    this.search.addEventListener("input", () => {
      this.query = this.search.value;
      this.renderBody(true);
    });
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.search.blur();
    });
    this.body = el("div", "wd-body", list);

    // ---- Alt şerit: tuşlar ve kaydet ----
    const foot = el("footer", "wd-foot", this.panel);
    const hints = el("div", "wd-hints", foot);
    kbd(hints, "A D", "Döndür");
    kbd(hints, "Q E", "Kategori");
    kbd(hints, "🖱", "Sürükle · Tekerlek");
    const actions = el("div", "wd-actions", foot);
    el("span", "wd-dirty", actions).textContent = "Kaydedilmemiş değişiklik";
    const reset = el("button", "wd-btn ghost", actions);
    reset.textContent = "Sıfırla";
    reset.addEventListener("click", () => this.reset());
    const cancel = el("button", "wd-btn", actions);
    kbd(cancel, "ESC", "Vazgeç");
    cancel.addEventListener("click", () => this.close());
    const save = (this.saveBtn = el("button", "wd-btn primary", actions));
    kbd(save, "ENTER", "Kaydet");
    save.disabled = true;
    save.addEventListener("click", () => this.save());

    // Pencerenin dışına tıklamak kapatır (sürükleme dışarıda bitince değil)
    let downOutside = false;
    this.backdrop.addEventListener("pointerdown", (e) => (downOutside = e.target === this.backdrop));
    this.backdrop.addEventListener("click", (e) => {
      if (downOutside && e.target === this.backdrop) this.close();
    });

    // Açma tuşu Input'ta (ayarlanabilir; pencere açıkken de yalnızca o çalışır). Buradakiler pencere tuşları.
    const signal = this.abort.signal;
    addEventListener("keydown", (e) => {
      if (!this.isOpen || e.target instanceof HTMLInputElement) return;
      const spin = { KeyA: -1, ArrowLeft: -1, KeyD: 1, ArrowRight: 1 }[e.code];
      if (spin) this.preview.setSpin(spin);
      else if (e.repeat) return;
      else if (e.key === "Escape") this.close();
      else if (e.key === "Enter") this.save();
      else if (e.code === "KeyQ" || e.code === "KeyE") this.step(e.code === "KeyQ" ? -1 : 1);
      else return;
      e.preventDefault();
    }, { signal });
    addEventListener("keyup", (e) => {
      if (/^(KeyA|KeyD|ArrowLeft|ArrowRight)$/.test(e.code)) this.preview.setSpin(0);
    }, { signal });
  }

  /** Mod değişince: önizlemenin WebGL bağlamı ve dinleyiciler bırakılır. */
  dispose(): void {
    if (this.isOpen) this.hide();
    this.abort.abort();
    this.preview.dispose();
    this.backdrop.remove();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** `tab` verilirse o sekmeyle açılır (hair, tops, colors…); `shop` verilirse yalnızca o dükkânın sekmeleri. */
  open(tab?: string, shop?: WardrobeShop): void {
    const s = shop ? SHOP[shop] : null;
    this.shop = shop ?? null;
    this.pendingSave = false;
    this.tabs = s ? TABS.filter((x) => s.tabs.includes(x.key)) : TABS;
    this.colorKeys = s ? s.colors : (Object.keys(PALETTES) as LookColor[]);
    this.kickerEl.textContent = s?.kicker ?? "KARAKTER";
    this.titleEl.textContent = s?.title ?? "GARDIROP";
    this.panel.classList.toggle("shop", !!s);
    const t = this.tabs.find((x) => x.key === tab);
    if (t) this.tab = t.key;
    else if (!this.tabs.some((x) => x.key === this.tab)) this.tab = this.tabs[0].key;
    this.isOpen = true;
    this.info = null;
    this.dirty = false;
    this.query = this.search.value = "";
    this.panel.classList.remove("dirty");
    this.backdrop.classList.add("show");
    this.hooks.modal(true);
    this.preview.setLook(null);
    this.preview.setFocus(this.tabInfo().focus);
    this.preview.start();
    this.levelEl.textContent = "";
    this.body.replaceChildren(Object.assign(el("div", "wd-msg"), { textContent: "Yükleniyor…" }));
    this.renderRail();
    this.renderHead(0);
    this.saveBtn.disabled = true;
    this.hooks.request();
    this.hooks.opened();
  }

  /** Bağlantı (yeniden) kurulunca: açıkken liste gelmediyse yeniden iste. */
  retry(): void {
    if (this.isOpen && !this.info) this.hooks.request();
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
    this.backdrop.classList.remove("show");
    this.preview.stop();
    this.hooks.modal(false);
  }

  /** Giyilenlerden satın alınmamış ücretli parçalar. */
  private unowned(look: Look = this.look): string[] {
    return LOOK_SLOTS.map((s) => look[s]).filter((v): v is string => !!v && !owned.has(lookItem(v))).map(lookItem);
  }

  private save(): void {
    if (!this.info) return;
    const need = this.unowned();
    if (need.length) {
      // Dükkânda: önce satın al, sunucu onaylayınca giy (ownedChanged)
      if (!this.shop) return;
      this.pendingSave = true;
      for (const i of need) this.hooks.buy(i);
      this.saveBtn.disabled = true;
      return;
    }
    this.hooks.save(this.look);
    this.dirty = false;
    this.pendingSave = false;
    this.hide();
  }

  /** Satın aldıkların değişti: kartlar ve kaydet düğmesi yenilenir; bekleyen kayıt varsa giyilir. */
  ownedChanged(): void {
    if (!this.isOpen || !this.info) return;
    this.saveBtn.disabled = false;
    if (this.pendingSave && !this.unowned().length) return this.save();
    this.updateSaveLabel();
    this.renderBody();
  }

  /** Kaydet düğmesi: satın alınacak varsa toplam fiyatı yazar. */
  private updateSaveLabel(): void {
    const need = this.unowned();
    const total = need.reduce((s, i) => s + (LOOK_PRICES[i.slice(5)] ?? 0), 0);
    this.saveBtn.querySelector(".wd-buy")?.remove();
    this.saveBtn.classList.toggle("buy", need.length > 0);
    if (need.length) el("span", "wd-buy", this.saveBtn).textContent = this.shop ? `Satın al ve giy · ${total.toLocaleString("tr-TR")} ₺` : "Önce satın al";
  }

  /** Kayıtlı kıyafete dön (pencere açık kalır). */
  private reset(): void {
    if (!this.info) return;
    if (this.dirty) this.hooks.cancel();
    this.look = copyLook(this.saved);
    this.setDirty(false);
    this.preview.setLook(this.look);
    this.renderRail();
    this.renderBody();
  }

  onInfo(w: WardrobeInfo | { error: string }): void {
    if (!this.isOpen) return;
    if ("error" in w) {
      this.body.replaceChildren(Object.assign(el("div", "wd-msg"), { textContent: w.error }));
      return;
    }
    this.info = w;
    this.saveBtn.disabled = false;
    this.saved = copyLook(w.outfit);
    this.look = copyLook(w.outfit);
    this.levelEl.textContent = `SV ${w.level}`;
    this.preview.setLook(this.look);
    this.renderRail();
    this.renderBody();
  }

  private tabInfo(key: Tab = this.tab) {
    return TABS.find((t) => t.key === key)!;
  }

  private setDirty(on: boolean): void {
    this.dirty = on;
    this.panel.classList.toggle("dirty", on);
    this.updateSaveLabel();
  }

  private change(next: Look): void {
    this.look = next;
    this.setDirty(true);
    this.hooks.preview(next);
    this.preview.setLook(next);
    this.renderRail();
    this.renderBody();
  }

  private select(tab: Tab): void {
    this.tab = tab;
    this.query = this.search.value = "";
    this.preview.setFocus(this.tabInfo().focus);
    this.renderRail();
    this.renderBody(true);
  }

  private step(dir: number): void {
    const i = this.tabs.findIndex((t) => t.key === this.tab);
    this.select(this.tabs[(i + dir + this.tabs.length) % this.tabs.length].key);
  }

  private labelOf(slot: LookSlot): string {
    const id = this.look[slot];
    return id ? this.manifest.parts[id]?.label ?? id : NONE_LABEL[slot];
  }

  private renderRail(): void {
    this.rail.replaceChildren(
      ...this.tabs.map((t) => {
        const b = el("button", `wd-slot${t.key === this.tab ? " active" : ""}`);
        icon(t.key, b);
        const text = el("span", "wd-slot-text", b);
        el("small", "", text).textContent = t.label;
        const value = el("strong", "", text);
        if (t.key === "colors") {
          value.className = "wd-dots";
          for (const c of this.colorKeys) {
            el("i", "", value).style.background = this.look.colors?.[c] ?? PALETTES[c].colors[c === "hair" ? 1 : 0];
          }
        } else {
          value.textContent = this.info ? this.labelOf(t.key) : "—";
        }
        b.addEventListener("click", () => this.select(t.key));
        return b;
      }),
    );
  }

  private renderHead(count: number): void {
    this.listTitle.textContent = this.tab === "colors" && this.colorKeys.length === 1 ? `${PALETTES[this.colorKeys[0]].label} rengi` : this.tabInfo().label;
    this.listCount.textContent = this.tab === "colors" ? this.colorKeys.map((k) => PALETTES[k].label).join(" · ") : `${count} parça`;
    this.search.hidden = this.tab === "colors";
  }

  /** `top`: listeyi başa sar (sekme ya da arama değişince). */
  private renderBody(top = false): void {
    if (!this.info) {
      this.renderHead(0);
      return;
    }
    const scroll = top ? 0 : this.body.scrollTop;
    this.preview.clearThumbs();
    this.body.replaceChildren(this.tab === "colors" ? this.colorsView() : this.slotView(this.tab));
    this.body.scrollTop = scroll;
  }

  /** Kart resmi için: kayıtlı kıyafetin üzerine yalnızca bu parça giydirilir (renkler güncel). */
  private thumbLook(slot: LookSlot, id: string | null): Look {
    const l: Look = { ...this.saved, colors: { ...this.look.colors }, [slot]: id };
    // Saç kartlarında şapka saçı örtmesin
    if (slot === "hair") l.hats = null;
    return l;
  }

  private slotView(slot: LookSlot): HTMLElement {
    const wrap = el("div", "wd-grid");
    const region = this.tabInfo().region;
    const q = fold(this.query.trim());
    const card = (id: string | null, label: string, tint: string) => {
      const need = id ? this.info!.locked[id] : undefined;
      const locked = need !== undefined && this.info!.level < need;
      const on = (this.look[slot] ?? null) === id;
      // Ücretli ve alınmamış: dükkânında denenir (fiyatı yazar), başka yerde kilitli
      const price = id && !owned.has(lookItem(id)) ? (LOOK_PRICES[id] ?? 0) : 0;
      const sellsHere = !!id && this.shop === lookShop(id);
      const forSale = price > 0 && !locked;
      const b = el("button", `wd-card${on ? " on" : ""}${locked || (forSale && !sellsHere) ? " locked" : ""}`, wrap);
      b.style.setProperty("--tint", tint);
      b.disabled = locked || (forSale && !sellsHere);
      if (forSale) el("span", "wd-price", b).textContent = sellsHere ? `${price.toLocaleString("tr-TR")} ₺` : `🛒 ${price.toLocaleString("tr-TR")} ₺ · ${lookShop(id!) === "barber" ? "Berberde" : "GAP Moda'da"}`;
      const thumb = el("div", "wd-thumb", b);
      const img = el("img", "", thumb);
      img.alt = "";
      img.draggable = false;
      const show = (url: string) => {
        img.src = url;
        thumb.classList.add("ready");
      };
      const url = this.preview.thumb(this.thumbLook(slot, id), region, show);
      if (url) show(url);
      el("span", "wd-card-name", b).textContent = label;
      if (on) el("span", "wd-badge", b).textContent = "GİYİLİ";
      if (locked) el("span", "wd-lock", b).textContent = `🔒 SV ${need}`;
      b.addEventListener("click", () => this.change({ ...this.look, [slot]: id }));
    };

    const rank = (g?: string) => (g ? (GROUP_ORDER.indexOf(g) + 1 || GROUP_ORDER.length + 1) : 0);
    const entries = Object.entries(this.manifest.parts)
      .filter(([id, p]) => p.cat === slot && !id.startsWith("base"))
      .filter(([id, p]) => !q || fold(p.label ?? id).includes(q))
      .sort(([, a], [, b]) => rank(a.group) - rank(b.group) || (a.label ?? "").localeCompare(b.label ?? "", "tr"));
    this.renderHead(entries.length);
    if (!q) card(null, NONE_LABEL[slot], "#5a6378");
    let group = "";
    for (const [id, p] of entries) {
      if (p.group && p.group !== group) {
        group = p.group;
        const g = el("div", "wd-group", wrap);
        g.style.setProperty("--tint", GROUP_TINT[group] ?? DEFAULT_TINT);
        el("span", "", g).textContent = group;
      }
      card(id, p.label ?? id, (p.group && GROUP_TINT[p.group]) || DEFAULT_TINT);
    }
    if (q && !entries.length) el("div", "wd-msg", wrap).textContent = `“${this.query.trim()}” için parça yok.`;
    return wrap;
  }

  private colorsView(): HTMLElement {
    this.renderHead(0);
    const wrap = el("div", "wd-colors");
    for (const key of this.colorKeys) {
      const section = el("div", "wd-color-section", wrap);
      el("div", "wd-group", section).append(Object.assign(el("span", ""), { textContent: PALETTES[key].label }));
      const row = el("div", "wd-color-row", section);
      const current = this.look.colors?.[key];
      const set = (v: string | undefined) => {
        const colors = { ...this.look.colors };
        if (v) colors[key] = v;
        else delete colors[key];
        this.change({ ...this.look, colors });
      };
      const def = el("button", `wd-swatch default${current ? "" : " on"}`, row);
      def.title = "Varsayılan";
      def.textContent = "↺";
      def.addEventListener("click", () => set(undefined));
      for (const c of PALETTES[key].colors) {
        const s = el("button", `wd-swatch${current === c ? " on" : ""}`, row);
        s.style.background = c;
        s.title = c;
        s.addEventListener("click", () => set(c));
      }
      const custom = PALETTES[key].colors.includes(current ?? "") ? undefined : current;
      const pickWrap = el("label", `wd-swatch pick${custom ? " on" : ""}`, row);
      pickWrap.title = "Özel renk";
      if (custom) pickWrap.style.background = custom;
      const pick = el("input", "", pickWrap);
      pick.type = "color";
      pick.value = current ?? PALETTES[key].colors[0];
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
