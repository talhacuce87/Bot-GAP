// Ayarlar paneli (⚙️): grafik ön ayarları ve tek tek grafik, kamera/kontrol, tuş atamaları, arayüz ayarları.
// Değişiklik anında uygulanır ve cihazda saklanır; sahne kurulurken okunanlar için "Uygula" dünyayı yeniden yükler.
import {
  applyPreset,
  type Preset,
  PRESET_NAMES,
  PRESETS,
  resetSettings,
  RESTART_KEYS,
  type Settings,
  settings,
  updateSettings,
} from "../settings";
import { type Action, ACTION_NAMES, type Bind, bindLabel, binds, RESERVED, resetBinds, setBind } from "../input/keybinds";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}

type Choice<T> = { value: T; label: string };

export class SettingsPanel {
  private root: HTMLDivElement;
  private body: HTMLDivElement;
  private applyBar: HTMLDivElement;
  /** Panel açıldığında yeniden kurulum gerektiren ayarların değerleri. */
  private snapshot: Partial<Settings> = {};
  /** Yeni tuş bekleyen atama; bir sonraki tuş/fare düğmesi/tekerlek oraya yazılır. */
  private capture: { action: Action; slot: 0 | 1; stop: () => void } | null = null;
  /** Son atamadan kalan uyarı (alınan tuş, ayrılmış tuş). */
  private keyNote = "";

  constructor(
    parent: HTMLElement,
    /** Sahneyi baştan kurar (çimen, kenar yumuşatma, lamba sayısı). */
    private restart: () => void,
  ) {
    const btn = el("button", "wardrobe-btn settings-btn", parent, "⚙️");
    btn.title = "Ayarlar";
    btn.addEventListener("click", () => this.toggle());
    this.root = el("div", "panel settings", parent);
    const head = el("div", "wardrobe-head", this.root);
    el("h3", "", head, "AYARLAR");
    const x = el("button", "wardrobe-x", head, "✕");
    x.addEventListener("click", () => this.close());
    this.body = el("div", "settings-body", this.root);
    this.applyBar = el("div", "settings-apply", this.root);
    el("span", "", this.applyBar, "Bu değişiklik dünyayı yeniden yükler.");
    el("button", "", this.applyBar, "Uygula").addEventListener("click", () => {
      this.snapshot = this.restartValues();
      this.restart();
    });
    // Paneldeyken tuşlar oyuna gitmesin (kaydırıcıda ok tuşu, yazarken WASD); Esc kapatır
    this.root.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.close();
    });
    this.root.addEventListener("keyup", (e) => e.stopPropagation());
  }

  get isOpen(): boolean {
    return this.root.classList.contains("show");
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    this.snapshot = this.restartValues();
    this.render();
    this.root.classList.add("show");
  }

  close(): void {
    this.endCapture();
    this.keyNote = "";
    this.root.classList.remove("show");
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
    const b = this.body;
    b.replaceChildren();
    const s = settings;

    this.section("Grafik");
    const presets = el("div", "settings-presets", b);
    for (const p of Object.keys(PRESETS) as Preset[]) {
      const pb = el("button", s.preset === p ? "active" : "", presets, PRESET_NAMES[p]);
      pb.addEventListener("click", () => {
        applyPreset(p);
        this.render();
      });
    }
    if (s.preset === "custom") el("div", "settings-note", b, "Özel ayar");

    this.choice<Settings["shadows"]>("Gölgeler", s.shadows, [
      { value: "off", label: "Kapalı" },
      { value: "low", label: "Düşük" },
      { value: "high", label: "Yüksek" },
    ], (v) => this.set({ shadows: v }));
    this.toggleRow("Işık parlaması (bloom)", s.bloom, (v) => this.set({ bloom: v }));
    this.toggleRow("Renk efekti ve kenar karartma", s.grade, (v) => this.set({ grade: v }));
    this.toggleRow("Sık çimen", s.grass, (v) => this.set({ grass: v }));
    this.toggleRow("Kenar yumuşatma", s.antialias, (v) => this.set({ antialias: v }));
    this.slider("Gece lamba ışıkları", s.lamps, 0, 8, 1, (v) => `${v}`, (v) => this.set({ lamps: v }));
    this.slider("Çözünürlük", s.maxDpr, 0.5, 2, 0.25, (v) => `${Math.round(Math.min(v, devicePixelRatio) * 100)}%`, (v) => this.set({ maxDpr: v }));
    this.toggleRow("Kare düşünce çözünürlüğü indir", s.adaptive, (v) => this.set({ adaptive: v }));
    this.choice<Settings["fpsCap"]>("Kare sınırı", s.fpsCap, [
      { value: 0, label: "Yok" },
      { value: 60, label: "60" },
      { value: 30, label: "30" },
    ], (v) => this.set({ fpsCap: v }));

    this.section("Ses");
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    this.slider("Sinema perdesi", s.cinemaVolume, 0, 1, 0.05, pct, (v) => this.set({ cinemaVolume: v }));
    this.slider("Ekran paylaşımı", s.shareVolume, 0, 1, 0.05, pct, (v) => this.set({ shareVolume: v }));
    this.slider("Efektler", s.sfxVolume, 0, 1, 0.05, pct, (v) => this.set({ sfxVolume: v }));

    this.section("Kamera ve kontrol");
    this.toggleRow("Birinci şahıs kamera (V)", s.firstPerson, (v) => this.set({ firstPerson: v }));
    this.slider("Görüş açısı", s.fov, 50, 90, 5, (v) => `${v}°`, (v) => this.set({ fov: v }));
    this.slider("Bakış hassasiyeti", s.sensitivity, 0.3, 2.5, 0.1, (v) => `${v.toFixed(1)}×`, (v) => this.set({ sensitivity: v }));
    this.toggleRow("Dikey bakışı ters çevir", s.invertY, (v) => this.set({ invertY: v }));

    if (!matchMedia("(pointer: coarse)").matches) this.keys();

    this.section("Gökyüzü");
    this.choice<Settings["clock"]>("Saat (yalnızca sende)", s.clock, [
      { value: "auto", label: "Dünya" },
      { value: "day", label: "Gündüz" },
      { value: "sunset", label: "Akşam" },
      { value: "night", label: "Gece" },
    ], (v) => this.set({ clock: v }));
    this.toggleRow("Sinemada video açıkken karart", s.cinemaDim, (v) => this.set({ cinemaDim: v }));
    el("div", "settings-note", b, "Herkes için: sohbette !saat gece / !hava yağmur (yetkin yoksa oylama açılır)");

    this.section("Arayüz");
    this.toggleRow("Konuşma balonları", s.bubbles, (v) => this.set({ bubbles: v }));
    this.toggleRow("FPS göstergesi", s.showFps, (v) => this.set({ showFps: v }));

    const reset = el("button", "settings-reset", b, "Varsayılana dön");
    reset.addEventListener("click", () => {
      resetSettings();
      this.render();
    });

    const dirty = RESTART_KEYS.some((k) => this.snapshot[k] !== settings[k]);
    this.applyBar.classList.toggle("show", dirty);
  }

  /** Tuş atamaları: her eyleme iki tuş; tıklanan kutu bir sonraki tuşu/fare düğmesini/tekerleği alır. */
  private keys(): void {
    this.section("Tuşlar");
    el("div", "settings-note", this.body, "Sağ tık basılı: kamera (imleç yerinde kalır) • 1–6: emote • Enter: sohbet");
    for (const a of Object.keys(ACTION_NAMES) as Action[]) {
      const r = this.row(ACTION_NAMES[a]);
      const wrap = el("div", "settings-keys", r);
      for (const slot of [0, 1] as const) {
        const waiting = this.capture?.action === a && this.capture.slot === slot;
        const kb = el("button", `settings-key${waiting ? " waiting" : ""}${binds[a][slot] ? "" : " empty"}`, wrap, waiting ? "Tuşa bas…" : bindLabel(binds[a][slot]));
        kb.addEventListener("click", () => this.startCapture(a, slot));
      }
    }
    if (this.keyNote) el("div", "settings-note settings-warn", this.body, this.keyNote);
    const reset = el("button", "settings-reset", this.body, "Tuşları sıfırla");
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
        if (RESERVED.has(bind)) this.keyNote = `${bindLabel(bind)} atanamaz (oyunda başka işi var).`;
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
      // Sol/sağ tık atamayı iptal eder. Panel yeniden kurulmaz: tıklanan başka kutu tıklamayı alsın
      if (e.button === 0 || e.button === 2) {
        this.endCapture();
        this.keyNote = "";
        const w = this.body.querySelector(".settings-key.waiting");
        if (w) {
          w.classList.remove("waiting");
          w.textContent = bindLabel(binds[action][slot]);
        }
        this.body.querySelector(".settings-warn")?.remove();
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
    this.keyNote = "Yeni tuşa, fare düğmesine ya da tekerleğe bas • Esc: vazgeç • Backspace: boşalt";
    this.render();
  }

  private endCapture(): void {
    this.capture?.stop();
    this.capture = null;
  }

  private section(title: string): void {
    el("h4", "settings-section", this.body, title);
  }

  private row(label: string): HTMLDivElement {
    const r = el("div", "settings-row", this.body);
    el("span", "settings-label", r, label);
    return r;
  }

  private toggleRow(label: string, on: boolean, change: (v: boolean) => void): void {
    const r = this.row(label);
    const t = el("button", `settings-toggle${on ? " on" : ""}`, r);
    t.setAttribute("role", "switch");
    t.setAttribute("aria-checked", String(on));
    t.setAttribute("aria-label", label);
    t.addEventListener("click", () => change(!on));
  }

  private choice<T>(label: string, value: T, choices: Choice<T>[], change: (v: T) => void): void {
    const r = this.row(label);
    const seg = el("div", "settings-seg", r);
    for (const c of choices) {
      const cb = el("button", c.value === value ? "active" : "", seg, c.label);
      cb.addEventListener("click", () => change(c.value));
    }
  }

  private slider(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, change: (v: number) => void): void {
    const r = this.row(label);
    const wrap = el("div", "settings-slider", r);
    const input = el("input", "", wrap);
    Object.assign(input, { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
    input.setAttribute("aria-label", label);
    const out = el("span", "settings-value", wrap, fmt(value));
    input.addEventListener("input", () => (out.textContent = fmt(Number(input.value))));
    // Bırakınca uygula: sürüklerken her adımda panel yeniden kurulmasın
    input.addEventListener("change", () => change(Number(input.value)));
  }
}
