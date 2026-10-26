// Ayarlar penceresi: solda kategoriler (Grafik, Performans, Ses, Kamera, Tuşlar, Oyun), sağda seçilen kategorinin
// ayarları. Değişiklik anında uygulanır ve cihazda saklanır; sahne kurulurken okunanlar için "Uygula" dünyayı yeniden
// yükler. Araç çubuğundaki dişliyle, telefondaki Ayarlar uygulamasıyla ya da modlardaki "Tuşlar" düğmesiyle açılır.
import { listen } from "../mode";
import {
  applyPreset,
  type Preset,
  PRESET_NAMES,
  PRESETS,
  RENDER_SCALES,
  resetSettings,
  RESTART_KEYS,
  type Settings,
  settings,
  updateSettings,
} from "../settings";
import { type Action, ACTION_NAMES, actionLabel, type Bind, bindLabel, binds, onBinds, PROFILE_ACTIONS, profile, reserved, resetBinds, setBind } from "../input/keybinds";
import { type IconName, icon } from "./icons";
import { modalClosed, modalOpened, toolButton } from "./layout";
import { el, paintRange } from "./panel";

type Choice<T> = { value: T; label: string };
type Tab = "graphics" | "performance" | "audio" | "camera" | "keys" | "game";

const TABS: { id: Tab; label: string; icon: IconName; desc: string }[] = [
  { id: "graphics", label: "Grafik", icon: "image", desc: "Görüntü kalitesi ve efektler" },
  { id: "performance", label: "Performans", icon: "gauge", desc: "Çözünürlük, kare hızı ve göstergeler" },
  { id: "audio", label: "Ses", icon: "speaker", desc: "Sinema, paylaşım, efekt ve radyo sesi" },
  { id: "camera", label: "Kamera", icon: "mouse", desc: "Bakış açısı ve fare" },
  { id: "keys", label: "Tuşlar", icon: "keyboard", desc: "Her eyleme iki tuş atanabilir" },
  { id: "game", label: "Oyun", icon: "globe", desc: "Saat, sinema ve balonlar" },
];

/** Ön ayarların altındaki kısa açıklama. */
const PRESET_HINT: Record<Preset, string> = {
  low: "Gölge ve efekt yok",
  medium: "Dengeli",
  high: "Önerilen",
  ultra: "En iyi görüntü",
};

const KEY_TITLE = { world: "Dünya tuşları", stadium: "Stadyum tuşları", volley: "Voleybol tuşları", paintball: "Paintball tuşları" } as const;
const KEY_NOTE = {
  world: "Sağ tık basılı: kamera (imleç yerinde kalır) · 1–6: hızlı slot (sol tık: kullan) · Enter: sohbet",
  stadium: "Stadyumdayken geçerli; dünyaya dönünce dünya tuşları geri gelir. Koş tuşu basılıyken müdahale: kayarak müdahale.",
  volley: "Voleybol salonundayken geçerli. Sol tık atamak için bekleyen kutuya sol tıkla. Shift lock ile kamera nişan alır.",
  paintball: "Paintball maçındayken geçerli. Sol tık atamak için bekleyen kutuya sol tıkla.",
} as const;

export class SettingsPanel {
  private root: HTMLDivElement;
  private nav: HTMLDivElement;
  private title: HTMLHeadingElement;
  private desc: HTMLParagraphElement;
  private body: HTMLDivElement;
  private applyBar: HTMLDivElement;
  private tab: Tab = "graphics";
  /** Panel açıldığında yeniden kurulum gerektiren ayarların değerleri. */
  private snapshot: Partial<Settings> = {};
  /** Yeni tuş bekleyen atama; bir sonraki tuş/fare düğmesi/tekerlek oraya yazılır. */
  private capture: { action: Action; slot: 0 | 1; stop: () => void } | null = null;
  /** Son atamadan kalan uyarı (alınan tuş, ayrılmış tuş). */
  private keyNote = "";
  /** Dokunmatikte klavye yok: Tuşlar sekmesi gizli. */
  private keyboard = !matchMedia("(pointer: coarse)").matches;

  constructor(
    private parent: HTMLElement,
    /** Sahneyi baştan kurar (çimen, kenar yumuşatma, lamba sayısı). */
    private restart: () => void,
  ) {
    toolButton(parent, { icon: "gear", label: "Ayarlar", group: 2, order: 0, onClick: () => this.toggle() });
    this.root = el("div", "settings", parent);
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Ayarlar");

    const side = el("aside", "st-side", this.root);
    const brand = el("div", "st-brand", side);
    el("small", "", brand, "GAP Dünyası");
    el("b", "", brand, "Ayarlar");
    this.nav = el("div", "st-nav", side);
    this.nav.setAttribute("role", "tablist");
    for (const t of TABS) {
      if (t.id === "keys" && !this.keyboard) continue;
      const b = el("button", "st-tab", this.nav);
      b.type = "button";
      b.dataset.tab = t.id;
      b.setAttribute("role", "tab");
      icon(t.icon, "", b);
      el("span", "", b, t.label);
      b.addEventListener("click", () => this.show(t.id));
    }
    // Varsayılana dön: yanlışlıkla basılmasın diye iki adım (ikinci tık 3 sn içinde)
    const reset = el("button", "st-reset", side);
    reset.type = "button";
    icon("reset", "", reset);
    const resetText = el("span", "", reset, "Varsayılana dön");
    let armed = 0;
    reset.addEventListener("click", () => {
      if (performance.now() > armed) {
        armed = performance.now() + 3000;
        reset.classList.add("armed");
        resetText.textContent = "Emin misin? Tekrar bas";
        window.setTimeout(() => {
          reset.classList.remove("armed");
          resetText.textContent = "Varsayılana dön";
        }, 3000);
        return;
      }
      armed = 0;
      reset.classList.remove("armed");
      resetText.textContent = "Varsayılana dön";
      resetSettings();
      this.render();
    });

    const main = el("section", "st-main", this.root);
    const head = el("header", "st-head", main);
    const titles = el("div", "st-titles", head);
    this.title = el("h3", "", titles);
    this.desc = el("p", "", titles);
    const x = el("button", "gp-x", head);
    x.type = "button";
    icon("close", "", x);
    x.setAttribute("aria-label", "Kapat");
    x.title = "Kapat (Esc)";
    x.addEventListener("click", () => this.close());
    this.body = el("div", "st-body", main);
    this.applyBar = el("div", "st-apply", main);
    icon("info", "", this.applyBar);
    el("span", "", this.applyBar, "Bu değişiklik dünyayı yeniden yükler.");
    const apply = el("button", "btn btn--primary btn--sm", this.applyBar, "Uygula");
    apply.type = "button";
    apply.addEventListener("click", () => {
      this.snapshot = this.restartValues();
      this.restart();
    });

    // Paneldeyken tuşlar oyuna gitmesin (kaydırıcıda ok tuşu, yazarken WASD); Esc kapatır
    this.root.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.close();
    });
    this.root.addEventListener("keyup", (e) => e.stopPropagation());
    listen("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen && !this.capture && this.root.isConnected) this.close();
    });
    // Stadyuma girip çıkınca geçerli tuş takımı değişir: açıksa yeniden çiz
    onBinds(() => {
      if (this.isOpen && !this.capture) this.render();
    });
    // Telefondaki Ayarlar uygulaması
    listen("gap:settings", () => this.open());
    // Modlardaki "Tuşlar" düğmesi: pencere Tuşlar sekmesinde açılır
    listen("gap:keys", () => this.open(this.keyboard ? "keys" : undefined));
  }

  get isOpen(): boolean {
    return this.root.classList.contains("show");
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(tab?: Tab): void {
    if (!this.root.isConnected) return;
    if (document.pointerLockElement) document.exitPointerLock();
    // Stadyumda ve voleybol salonunda Tuşlar sekmesiyle açılır (ayrı takımlar)
    if (tab) this.tab = tab;
    else if (!this.isOpen && profile !== "world" && this.keyboard) this.tab = "keys";
    this.snapshot = this.restartValues();
    this.render();
    if (!this.isOpen) modalOpened(this, this.parent);
    this.root.classList.add("show");
  }

  close(): void {
    this.endCapture();
    this.keyNote = "";
    if (!this.isOpen) return;
    this.root.classList.remove("show");
    modalClosed(this);
  }

  private show(tab: Tab): void {
    this.endCapture();
    this.keyNote = "";
    this.tab = tab;
    this.render();
    this.body.scrollTop = 0;
  }

  private restartValues(): Partial<Settings> {
    return Object.fromEntries(RESTART_KEYS.map((k) => [k, settings[k]]));
  }

  private set(patch: Partial<Settings>): void {
    // Grafik alanı elle değişince ön ayar "özel" olur
    const graphics = Object.keys(PRESETS.low);
    if (Object.keys(patch).some((k) => graphics.includes(k))) patch = { preset: "custom", ...patch };
    updateSettings(patch);
    this.render();
  }

  private render(): void {
    const scroll = this.body.scrollTop;
    this.body.replaceChildren();
    const meta = TABS.find((t) => t.id === this.tab)!;
    for (const b of this.nav.querySelectorAll<HTMLElement>(".st-tab")) {
      const on = b.dataset.tab === this.tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    this.title.textContent = this.tab === "keys" ? KEY_TITLE[profile] : meta.label;
    this.desc.textContent = meta.desc;
    this.body.dataset.tab = this.tab;
    const s = settings;
    const pct = (v: number) => `${Math.round(v * 100)}%`;

    switch (this.tab) {
      case "graphics": {
        this.section("Kalite");
        const presets = el("div", "st-presets", this.body);
        for (const p of Object.keys(PRESETS) as Preset[]) {
          const pb = el("button", `st-preset${s.preset === p ? " on" : ""}`, presets);
          pb.type = "button";
          el("b", "", pb, PRESET_NAMES[p]);
          el("small", "", pb, PRESET_HINT[p]);
          el("i", "st-bars", pb).dataset.level = String(["low", "medium", "high", "ultra"].indexOf(p) + 1);
          pb.addEventListener("click", () => {
            applyPreset(p);
            this.render();
          });
        }
        if (s.preset === "custom") el("div", "settings-note st-custom", this.body, "Özel ayar: aşağıdaki seçenekler elle değiştirildi.");
        this.section("Işık ve gölge");
        this.choice<Settings["shadows"]>("Gölgeler", "Güneşin gerçek zamanlı gölgesi", s.shadows, [
          { value: "off", label: "Kapalı" },
          { value: "low", label: "Düşük" },
          { value: "high", label: "Yüksek" },
        ], (v) => this.set({ shadows: v }));
        this.toggleRow("Işık parlaması", "Lambalar, ateş ve güneş parlar (bloom)", s.bloom, (v) => this.set({ bloom: v }));
        this.toggleRow("Güneş huzmeleri", "Işık huzmeleri ve lens parlaması", s.godrays, (v) => this.set({ godrays: v }));
        this.slider("Gece lamba ışıkları", "Gerçek ışık saçan lamba sayısı", s.lamps, 0, 8, 1, (v) => `${v}`, (v) => this.set({ lamps: v }));
        this.section("Görüntü");
        this.toggleRow("Renk efekti", "Renk düzenleme ve kenar karartma", s.grade, (v) => this.set({ grade: v }));
        this.toggleRow("Kenar yumuşatma", "Tırtıklı kenarları düzeltir (MSAA)", s.antialias, (v) => this.set({ antialias: v }));
        this.toggleRow("Sık çimen", "Karakterin çevresinde sallanan çimen", s.grass, (v) => this.set({ grass: v }));
        break;
      }
      case "performance":
        this.section("Çözünürlük");
        this.slider("Çözünürlük", "Ekranın piksel oranı (en çok ekranın kendisi)", s.maxDpr, 0.5, 2, 0.25, (v) => `${Math.round(Math.min(v, devicePixelRatio) * 100)}%`, (v) => this.set({ maxDpr: v }));
        this.choice<Settings["renderScale"]>("Çözünürlük ölçeği", "Otomatik: kare düşünce sahne küçük çizilip büyütülür", s.renderScale, RENDER_SCALES.map((v) => ({ value: v, label: v ? `%${Math.round(v * 100)}` : "Oto" })), (v) => this.set({ renderScale: v }), true);
        this.section("Kare hızı");
        this.choice<Settings["fpsCap"]>("Kare sınırı", "Pil ve ısı için kare hızını sınırla", s.fpsCap, [
          { value: 0, label: "Yok" },
          { value: 60, label: "60" },
          { value: 30, label: "30" },
        ], (v) => this.set({ fpsCap: v }));
        this.section("Göstergeler");
        this.toggleRow("FPS göstergesi", "Sağ altta kare hızı ve çizim sayısı", s.showFps, (v) => this.set({ showFps: v }));
        this.toggleRow("Ağ paneli", `Ping, kayıp ve grafikler · kısayol ${actionLabel("net")}`, s.showNet, (v) => this.set({ showNet: v }));
        break;
      case "audio":
        this.section("Ses düzeyleri");
        this.slider("Sinema perdesi", "Sinemada oynayan video", s.cinemaVolume, 0, 1, 0.05, pct, (v) => this.set({ cinemaVolume: v }));
        this.slider("Ekran paylaşımı", "Perdedeki paylaşılan ekran", s.shareVolume, 0, 1, 0.05, pct, (v) => this.set({ shareVolume: v }));
        this.slider("Araba radyoları", "Senin ve yakındakilerin radyosu", s.radioVolume, 0, 1, 0.05, pct, (v) => this.set({ radioVolume: v }));
        this.slider("Efektler", "Adım, korna, maç ve arayüz sesleri", s.sfxVolume, 0, 1, 0.05, pct, (v) => this.set({ sfxVolume: v }));
        break;
      case "camera":
        this.section("Görünüm");
        this.toggleRow("Birinci şahıs", `Kamerayı gözlerine alır · kısayol ${actionLabel("camera")}`, s.firstPerson, (v) => this.set({ firstPerson: v }));
        this.slider("Görüş açısı", "Geniş açı daha çok görür", s.fov, 50, 90, 5, (v) => `${v}°`, (v) => this.set({ fov: v }));
        this.section("Fare ve dokunmatik");
        this.slider("Bakış hassasiyeti", "Kameranın dönüş hızı", s.sensitivity, 0.3, 2.5, 0.1, (v) => `${v.toFixed(1)}×`, (v) => this.set({ sensitivity: v }));
        this.toggleRow("Dikey bakışı ters çevir", "Fareyi yukarı itince aşağı bakar", s.invertY, (v) => this.set({ invertY: v }));
        break;
      case "keys":
        this.keys();
        break;
      case "game":
        this.section("Gökyüzü");
        this.choice<Settings["clock"]>("Saat", "Yalnızca sende; dünyanın saati değişmez", s.clock, [
          { value: "auto", label: "Dünya" },
          { value: "day", label: "Gündüz" },
          { value: "sunset", label: "Akşam" },
          { value: "night", label: "Gece" },
        ], (v) => this.set({ clock: v }), true);
        this.toggleRow("Sinemada karart", "Perdede video açıkken önü akşama döner", s.cinemaDim, (v) => this.set({ cinemaDim: v }));
        el("div", "settings-note st-tip", this.body, "Herkes için: sohbette !saat gece ya da !hava yağmur yaz (yetkin yoksa oylama açılır).");
        this.section("Arayüz");
        this.toggleRow("Konuşma balonları", "Konuşanın başının üstünde mesaj", s.bubbles, (v) => this.set({ bubbles: v }));
        break;
    }

    const dirty = RESTART_KEYS.some((k) => this.snapshot[k] !== settings[k]);
    this.applyBar.classList.toggle("show", dirty);
    this.body.scrollTop = scroll;
  }

  /** Tuş atamaları: her eyleme iki tuş; tıklanan kutu bir sonraki tuşu/fare düğmesini/tekerleği alır. */
  private keys(): void {
    el("div", "settings-note st-tip", this.body, KEY_NOTE[profile]);
    const list = el("div", "st-keys", this.body);
    for (const a of PROFILE_ACTIONS[profile]) {
      const r = el("div", "st-key-row", list);
      el("span", "st-key-name", r, ACTION_NAMES[a]);
      const wrap = el("div", "st-key-slots", r);
      for (const slot of [0, 1] as const) {
        const waiting = this.capture?.action === a && this.capture.slot === slot;
        const bind = binds[a][slot];
        const kb = el("button", `settings-key${waiting ? " waiting" : ""}${bind ? "" : " empty"}`, wrap, waiting ? "Tuşa bas…" : bind ? bindLabel(bind) : "—");
        kb.type = "button";
        kb.title = slot ? "İkinci tuş" : "Birinci tuş";
        kb.addEventListener("click", () => this.startCapture(a, slot));
      }
    }
    if (this.keyNote) el("div", "settings-note settings-warn st-keynote", this.body, this.keyNote);
    const reset = el("button", "btn btn--sm st-keys-reset", this.body);
    reset.type = "button";
    icon("reset", "", reset);
    el("span", "", reset, "Tuşları sıfırla");
    reset.addEventListener("click", () => {
      this.endCapture();
      resetBinds();
      this.keyNote = "";
      this.render();
    });
  }

  private startCapture(action: Action, slot: 0 | 1): void {
    this.endCapture();
    const done = (bind: Bind | null) => {
      this.endCapture();
      if (bind === null) this.keyNote = "";
      else {
        if (reserved(bind)) this.keyNote = `${bindLabel(bind)} atanamaz (oyunda başka işi var).`;
        else {
          const taken = setBind(action, slot, bind);
          this.keyNote = taken ? `${bindLabel(bind)}, "${ACTION_NAMES[taken]}" eyleminden alındı.` : "";
        }
      }
      this.render();
    };
    // Pencerenin yakalama aşamasında: oyun da panel de bu tuşu görmez
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      swallow(e);
      if (e.repeat) return;
      if (e.code === "Escape") done(null);
      else if (e.code === "Backspace" || e.code === "Delete") done("");
      else done(e.code);
    };
    const onMouse = (e: MouseEvent) => {
      // Voleybolda bekleyen kutuya sol tık: sol tık atanır
      if (e.button === 0 && (profile === "volley" || profile === "paintball") && e.target instanceof Element && e.target.closest(".settings-key.waiting")) {
        swallow(e);
        return done("Mouse0");
      }
      // Sol/sağ tık atamayı iptal eder. Panel yeniden kurulmaz: tıklanan başka kutu tıklamayı alsın
      if (e.button === 0 || e.button === 2) {
        this.endCapture();
        this.keyNote = "";
        const w = this.body.querySelector(".settings-key.waiting");
        if (w) {
          w.classList.remove("waiting");
          w.textContent = bindLabel(binds[action][slot]) || "—";
        }
        this.body.querySelector(".st-keynote")?.remove();
        return;
      }
      swallow(e);
      done(`Mouse${e.button}`);
    };
    const onWheel = (e: WheelEvent) => {
      swallow(e);
      if (e.deltaY) done(e.deltaY < 0 ? "WheelUp" : "WheelDown");
    };
    const opts = { capture: true };
    addEventListener("keydown", onKey, opts);
    addEventListener("mousedown", onMouse, opts);
    addEventListener("wheel", onWheel, { capture: true, passive: false });
    this.capture = {
      action,
      slot,
      stop: () => {
        removeEventListener("keydown", onKey, opts);
        removeEventListener("mousedown", onMouse, opts);
        removeEventListener("wheel", onWheel, opts);
      },
    };
    this.keyNote = "Yeni tuşa, fare düğmesine ya da tekerleğe bas · Esc: vazgeç · Backspace: boşalt";
    this.render();
  }

  private endCapture(): void {
    this.capture?.stop();
    this.capture = null;
  }

  private section(title: string): void {
    el("h4", "settings-section", this.body, title);
  }

  /** Ayar satırı: solda ad ve kısa açıklama, sağda denetim. */
  private row(label: string, hint: string): HTMLDivElement {
    const r = el("div", "settings-row", this.body);
    const t = el("div", "settings-label", r);
    el("b", "", t, label);
    if (hint) el("small", "", t, hint);
    return r;
  }

  private toggleRow(label: string, hint: string, on: boolean, change: (v: boolean) => void): void {
    const r = this.row(label, hint);
    r.classList.add("clickable");
    const t = el("button", `settings-toggle${on ? " on" : ""}`, r);
    t.type = "button";
    t.setAttribute("role", "switch");
    t.setAttribute("aria-checked", String(on));
    t.setAttribute("aria-label", label);
    // Satırın tamamı tıklanır
    r.addEventListener("click", () => change(!on));
  }

  /** `stack`: seçenekler sığmazsa açıklamanın altında tam genişlik. */
  private choice<T>(label: string, hint: string, value: T, choices: Choice<T>[], change: (v: T) => void, stack = false): void {
    const r = this.row(label, hint);
    if (stack) r.classList.add("stack");
    const seg = el("div", "settings-seg", r);
    for (const c of choices) {
      const cb = el("button", c.value === value ? "active" : "", seg, c.label);
      cb.type = "button";
      cb.addEventListener("click", () => change(c.value));
    }
  }

  private slider(label: string, hint: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, change: (v: number) => void): void {
    const r = this.row(label, hint);
    const wrap = el("div", "settings-slider", r);
    const input = el("input", "", wrap);
    Object.assign(input, { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
    input.setAttribute("aria-label", label);
    paintRange(input);
    const out = el("output", "settings-value", wrap, fmt(value));
    input.addEventListener("input", () => {
      out.textContent = fmt(Number(input.value));
      paintRange(input);
    });
    // Bırakınca uygula: sürüklerken her adımda panel yeniden kurulmasın
    input.addEventListener("change", () => change(Number(input.value)));
  }
}
