// GAP Garaj tuning ekranı (GTA'daki LS Customs gibi): solda afişli menü (kategoriler → seçenekler), seçenek
// üstünde durunca araba anında o hâliyle görünür, Enter takar. Kamera seçili kategorinin parçasına döner (jant →
// ön tekerlek, spoiler → arka, plaka → arka plaka…); fareyle sürükleyerek ya da A/D ile araba etrafında dönülür.
import {
  CAR_COLORS, CAR_DECALS, CAR_ENGINES, CAR_EXHAUSTS, CAR_HORNS, CAR_LIGHTS, CAR_MODELS, CAR_NEONS, CAR_RIMS, CAR_SPOILERS, carPerf, type CarSpec, validCar,
} from "../../../shared/car";
import { itemPrice, modItem } from "../../../shared/shop";
import { owned } from "../owned";
import { hornIsTune, Horns } from "./horn";
import { sfx } from "./sfx";

/** Kamera: arabaya göre hedef nokta (yerel: +x sol, +z ön), etrafındaki açı (0 ön, π/2 sol), eğim ve uzaklık. */
export interface CamPreset {
  tx: number;
  ty: number;
  tz: number;
  yaw: number;
  pitch: number;
  dist: number;
}

interface Option {
  id: string;
  name: string;
  hex?: string;
}

interface Category {
  key: keyof CarSpec;
  label: string;
  icon: string;
  desc: string;
  cam: CamPreset;
  options?: readonly Option[];
}

const OVERVIEW: CamPreset = { tx: 0, ty: 0.6, tz: 0, yaw: 0.8, pitch: 0.26, dist: 6.4 };

const YESNO = (no: string, yes: string): Option[] => [{ id: "false", name: no }, { id: "true", name: yes }];

const CATEGORIES: Category[] = [
  { key: "engine", label: "Motor", icon: "⚙️", desc: "Chip, büyük turbo ya da yarış motoru: daha yüksek hız ve ivme. Turbo gaz bırakınca pıslar.", cam: { tx: 0, ty: 0.85, tz: 1.5, yaw: 0.55, pitch: 0.38, dist: 3.6 }, options: CAR_ENGINES },
  { key: "color", label: "Boya", icon: "🎨", desc: "Gövde rengi. Çıkartma ve yazılar boyaya göre açık ya da koyu olur.", cam: { tx: 0, ty: 0.65, tz: 0, yaw: 0.95, pitch: 0.22, dist: 6.0 }, options: CAR_COLORS },
  { key: "rim", label: "Jantlar", icon: "🛞", desc: "Jant modeli: çelik kapaklı, spor, altın ya da siyah.", cam: { tx: 0.82, ty: 0.31, tz: 1.245, yaw: 1.3, pitch: 0.1, dist: 2.4 }, options: CAR_RIMS },
  { key: "spoiler", label: "Spoiler", icon: "🪽", desc: "Bagaj kapağına arka spoiler.", cam: { tx: 0, ty: 1.15, tz: -1.9, yaw: Math.PI - 0.6, pitch: 0.42, dist: 4.4 }, options: CAR_SPOILERS },
  { key: "decal", label: "Çıkartma", icon: "🏁", desc: "Kaput ve tavandan geçen yarış şeridi, yanlarda alev ya da damalı taksi.", cam: { tx: 0, ty: 0.85, tz: 0, yaw: Math.PI / 2 + 0.15, pitch: 0.3, dist: 5.8 }, options: CAR_DECALS },
  { key: "neon", label: "Neon alt ışık", icon: "💡", desc: "Gövdenin altından yere vuran ışık; gece daha parlak.", cam: { tx: 0, ty: 0.15, tz: 0, yaw: 1.05, pitch: 0.07, dist: 5.6 }, options: CAR_NEONS },
  { key: "lights", label: "Farlar", icon: "🔦", desc: "Far camının rengi: standart, xenon (buz mavisi) ya da retro sarı.", cam: { tx: 0, ty: 0.62, tz: 2.15, yaw: 0.32, pitch: 0.12, dist: 3.4 }, options: CAR_LIGHTS },
  { key: "exhaust", label: "Egzoz", icon: "💨", desc: "Egzoz ucu: standart, çift çıkış ya da kalın krom spor.", cam: { tx: 0, ty: 0.28, tz: -2.2, yaw: Math.PI - 0.4, pitch: 0.12, dist: 2.7 }, options: CAR_EXHAUSTS },
  { key: "horn", label: "Korna", icon: "📯", desc: "Arabada E ile çalınır (basılı tut). Melodili kornalar bir kez sonuna kadar çalar.", cam: { tx: 0, ty: 0.7, tz: 2.1, yaw: 0.2, pitch: 0.15, dist: 3.8 }, options: CAR_HORNS },
  { key: "tint", label: "Cam filmi", icon: "🕶️", desc: "Koyu cam filmi: içerisi zor görünür.", cam: { tx: 0, ty: 1.1, tz: -0.1, yaw: Math.PI / 2 + 0.3, pitch: 0.12, dist: 4.2 }, options: YESNO("Yok", "Koyu film") },
  { key: "low", label: "Süspansiyon", icon: "⬇️", desc: "Basık süspansiyon: gövde tekerleklere göre aşağıda.", cam: { tx: 0, ty: 0.35, tz: 0, yaw: Math.PI / 2, pitch: 0.03, dist: 5.2 }, options: YESNO("Standart", "Basık") },
  { key: "plate", label: "Plaka", icon: "🔤", desc: "Plaka yazısı: harf, rakam ve boşluk, en çok 10 karakter.", cam: { tx: 0, ty: 0.37, tz: -2.3, yaw: Math.PI, pitch: 0.12, dist: 2.4 } },
];

export interface TuningHooks {
  /** Seçenek üstünde: araba bu hâliyle görünsün (kaydetmeden). */
  preview(spec: CarSpec): void;
  /** Takıldı: kaydet ve herkese gönder. */
  apply(spec: CarSpec): void;
  /** Menüden çıkıldı. */
  close(): void;
  /** Modifiye satın al (bir kez, bu araba için). */
  buy(item: string): void;
}

const valueOf = (spec: CarSpec, key: keyof CarSpec) => String(spec[key]);

/** Motorun karnesi: tepe hız ve 0-100 km/s süresi (ivme eğrisinden). */
function perfLine(spec: CarSpec): string {
  const p = carPerf(spec);
  let v = 0, t = 0;
  while (v < 27.78 && t < 30) {
    v += p.accel * Math.max(0.08, 1 - (v / p.top) ** 2) * 0.02;
    t += 0.02;
  }
  const zero = p.top * 1.1 < 27.78 ? "100'e çıkmaz 😅" : `0-100: ${t.toFixed(1)} sn`;
  return `Tepe hız ${Math.round(p.top * 3.6)} km/s (Shift ile ${Math.round(p.top * 3.6 * 1.1)}) · ${zero}`;
}

export class Tuning {
  private root: HTMLDivElement;
  private drag: HTMLDivElement;
  private sub: HTMLDivElement;
  private list: HTMLDivElement;
  private desc: HTMLDivElement;
  private applied!: CarSpec;
  private level: 0 | 1 = 0;
  private cat = 0;
  private sel = 0;
  private plateInput: HTMLInputElement | null = null;
  /** Satın alınınca takılacak. */
  private pending: CarSpec | null = null;
  /** Korna önizlemesi (seçeneğin üstünde durunca bir kez çalar). */
  private horns = new Horns();
  private hornTimer = 0;
  isOpen = false;
  /** Kullanıcının döndürmesi (radyan) ve döndürme tuşu; son dokunuş (otomatik dönüş için). */
  yaw = 0;
  private spin = 0;
  lastTouch = 0;

  constructor(parent: HTMLElement, private hooks: TuningHooks) {
    this.root = document.createElement("div");
    this.root.className = "tune";
    this.drag = document.createElement("div");
    this.drag.className = "tune-drag";
    const panel = document.createElement("div");
    panel.className = "tune-panel";
    panel.innerHTML = '<div class="tune-banner"><b>GAP GARAJ</b><span>TUNING</span></div>';
    this.sub = document.createElement("div");
    this.sub.className = "tune-sub";
    this.list = document.createElement("div");
    this.list.className = "tune-list";
    this.desc = document.createElement("div");
    this.desc.className = "tune-desc";
    panel.append(this.sub, this.list, this.desc);
    const keys = document.createElement("div");
    keys.className = "tune-keys";
    keys.innerHTML = "<span><kbd>↑</kbd><kbd>↓</kbd> Seç</span><span><kbd>Enter</kbd> Tak / Gir</span><span><kbd>Esc</kbd> Geri</span><span><kbd>A</kbd><kbd>D</kbd> / sürükle: Döndür</span>";
    this.root.append(this.drag, panel, keys);
    parent.append(this.root);
    // Satın alma onaylandı: bekleyen parça takılır
    owned.on(() => {
      if (!this.isOpen) return;
      const p = this.pending;
      if (p && !this.missing(p)) {
        this.pending = null;
        this.applyNow(p);
      } else this.render();
    });

    // Sürükleyerek araba etrafında dön
    let down: { x: number; yaw: number } | null = null;
    this.drag.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, yaw: this.yaw };
      this.drag.setPointerCapture(e.pointerId);
    });
    this.drag.addEventListener("pointermove", (e) => {
      if (!down) return;
      this.yaw = down.yaw - (e.clientX - down.x) * 0.008;
      this.lastTouch = performance.now();
    });
    this.drag.addEventListener("pointerup", () => (down = null));
    for (const type of ["keydown", "keyup"] as const) addEventListener(type, this.onKey, true);
  }

  /** Menünün sağ kenarı (px): araba bu kenarın sağındaki boş alanın ortasında görünsün. */
  get panelRight(): number {
    return this.isOpen ? (this.root.querySelector(".tune-panel") as HTMLElement).getBoundingClientRect().right : 0;
  }

  /** Kamera ön ayarı: kategori listesindeyken genel görünüm, içerideyken o parçanın görünümü. */
  get cam(): CamPreset {
    // Listede gezinirken de kamera üstünde durulan parçaya döner (GTA'daki gibi)
    if (this.level === 1) return CATEGORIES[this.cat].cam;
    return this.sel < CATEGORIES.length ? CATEGORIES[this.sel].cam : OVERVIEW;
  }

  /** Kare başına: A/D ile dönüş. */
  tick(dt: number): void {
    if (this.spin) {
      this.yaw += this.spin * dt * 1.6;
      this.lastTouch = performance.now();
    }
  }

  open(spec: CarSpec): void {
    this.applied = { ...spec };
    this.level = 0;
    this.cat = 0;
    this.sel = 0;
    this.yaw = 0;
    this.isOpen = true;
    this.root.classList.add("show");
    if (document.pointerLockElement) document.exitPointerLock();
    this.render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove("show");
    this.spin = 0;
    this.horns.silence();
    this.hooks.preview(this.applied);
    this.hooks.close();
  }

  private rows(): number {
    return this.level === 0 ? CATEGORIES.length + 1 : (CATEGORIES[this.cat].options?.length ?? 1);
  }

  private move(d: number): void {
    const n = this.rows();
    this.sel = (this.sel + d + n) % n;
    sfx.tick(2);
    this.yaw = 0;
    if (this.level === 1) this.previewSel();
    this.render();
  }

  /** Seçili seçenekle araba (takmadan). */
  private candidate(): CarSpec {
    const c = CATEGORIES[this.cat], o = c.options?.[this.sel];
    if (!o) return this.applied;
    const v = o.id === "true" ? true : o.id === "false" ? false : o.id;
    return validCar({ ...this.applied, [c.key]: v }) ?? this.applied;
  }

  private previewSel(): void {
    const spec = this.candidate();
    this.hooks.preview(spec);
    if (CATEGORIES[this.cat].key === "horn") {
      window.clearTimeout(this.hornTimer);
      this.horns.start(-1, spec.horn, 0.8);
      if (!hornIsTune(spec.horn)) this.hornTimer = window.setTimeout(() => this.horns.release(-1), 450);
    }
  }

  private enter(): void {
    if (this.level === 0) {
      if (this.sel === CATEGORIES.length) return this.close();
      this.cat = this.sel;
      this.level = 1;
      const c = CATEGORIES[this.cat];
      this.sel = Math.max(0, c.options?.findIndex((o) => o.id === valueOf(this.applied, c.key)) ?? 0);
      this.yaw = 0;
      sfx.chip();
      this.previewSel();
      this.render();
      if (c.key === "plate") requestAnimationFrame(() => this.plateInput?.focus());
      return;
    }
    const c = CATEGORIES[this.cat];
    if (c.key === "plate") {
      const next = validCar({ ...this.applied, plate: this.plateInput?.value ?? this.applied.plate });
      if (next) this.applyNow(next);
      return;
    }
    this.applyNow(this.candidate());
  }

  /** Arabanın bu kategorideki satın alınmamış parçası (anahtar) — yoksa null. */
  private missing(spec: CarSpec): string | null {
    const c = CATEGORIES[this.cat], v = spec[c.key];
    if (c.key === "plate") return null;
    const item = modItem(spec.model, c.key, v as string | boolean);
    return owned.has(item) ? null : item;
  }

  /** Seçeneğin fiyatı (sahipsen 0). */
  private price(key: keyof CarSpec, id: string): number {
    const item = modItem(this.applied.model, key, id === "true" ? true : id === "false" ? false : id);
    return owned.has(item) ? 0 : (itemPrice(item) ?? 0);
  }

  private applyNow(spec: CarSpec): void {
    // Satın alınmamış parça: önce satın alınır (sunucu parayı alınca takılır)
    const need = this.level === 1 ? this.missing(spec) : null;
    if (need) {
      this.pending = spec;
      this.hooks.buy(need);
      return;
    }
    if (JSON.stringify(spec) === JSON.stringify(this.applied)) return;
    this.applied = spec;
    this.hooks.apply(spec);
    sfx.win(false);
    this.render();
  }

  private back(): void {
    if (this.level === 0) return this.close();
    this.hooks.preview(this.applied);
    this.sel = this.cat;
    this.level = 0;
    this.yaw = 0;
    sfx.tick(2);
    this.render();
  }

  private render(): void {
    const model = CAR_MODELS.find((m) => m.id === this.applied.model)?.name ?? "";
    this.list.replaceChildren();
    this.plateInput = null;
    if (this.level === 0) {
      this.sub.innerHTML = `<span>${model.toUpperCase()} · KATEGORİLER</span><em>${this.sel + 1}/${this.rows()}</em>`;
      CATEGORIES.forEach((c, i) => {
        const cur = c.options?.find((o) => o.id === valueOf(this.applied, c.key));
        this.row(i, `${c.icon} ${c.label}`, cur?.name ?? this.applied.plate, cur?.hex, false);
      });
      this.row(CATEGORIES.length, "🚪 Garajdan çık", "", undefined, false);
      this.desc.textContent = this.sel < CATEGORIES.length ? CATEGORIES[this.sel].desc : "Tuning'i bitir ve arabayla dışarı sür.";
      if (this.sel === 0) this.desc.textContent += ` ${perfLine(this.applied)}`;
      return;
    }
    const c = CATEGORIES[this.cat];
    this.sub.innerHTML = `<span>${c.icon} ${c.label.toUpperCase()}</span><em>${this.sel + 1}/${this.rows()}</em>`;
    if (c.key === "plate") {
      const wrap = document.createElement("div");
      wrap.className = "tune-plate";
      const input = document.createElement("input");
      input.maxLength = 10;
      input.value = this.applied.plate;
      input.addEventListener("input", () => {
        const v = validCar({ ...this.applied, plate: input.value });
        if (v && v.plate === input.value.toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim()) this.hooks.preview(v);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.enter();
        else if (e.key === "Escape") {
          input.blur();
          this.back();
        } else return;
        e.preventDefault();
      });
      const ok = document.createElement("button");
      ok.textContent = "TAK";
      ok.addEventListener("click", () => this.enter());
      wrap.append(input, ok);
      this.list.append(wrap);
      this.plateInput = input;
    } else {
      c.options!.forEach((o, i) => {
        const on = o.id === valueOf(this.applied, c.key), p = this.price(c.key, o.id);
        this.row(i, o.name, on ? "✓ TAKILI" : p ? `${p.toLocaleString("tr-TR")} ₺` : "✓ SENİN", o.hex, on);
      });
    }
    this.desc.textContent = c.key === "engine" ? `${c.desc} ${perfLine(this.candidate())}` : c.desc;
  }

  private row(i: number, label: string, value: string, hex: string | undefined, on: boolean): void {
    const r = document.createElement("button");
    r.className = `tune-row${i === this.sel ? " sel" : ""}${on ? " on" : ""}`;
    r.innerHTML = `${hex !== undefined ? `<i style="background:${hex || "transparent"}"></i>` : ""}<span>${label}</span><b>${value}</b>`;
    r.addEventListener("pointerenter", () => {
      if (this.sel === i) return;
      this.sel = i;
      if (this.level === 1) this.previewSel();
      this.render();
    });
    r.addEventListener("click", () => {
      this.sel = i;
      this.enter();
    });
    this.list.append(r);
    if (i === this.sel) requestAnimationFrame(() => r.scrollIntoView({ block: "nearest" }));
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;
    if (e.target instanceof HTMLInputElement) return;
    const down = e.type === "keydown";
    const code = e.code;
    if (code === "KeyA" || code === "ArrowLeft" || code === "KeyD" || code === "ArrowRight") {
      this.spin = down ? (code === "KeyA" || code === "ArrowLeft" ? 1 : -1) : 0;
    } else if (down && !e.repeat) {
      if (code === "ArrowUp" || code === "KeyW") this.move(-1);
      else if (code === "ArrowDown" || code === "KeyS") this.move(1);
      else if (code === "Enter" || code === "Space" || code === "KeyF") this.enter();
      else if (code === "Escape" || code === "Backspace") this.back();
    } else if (down && (code === "ArrowUp" || code === "ArrowDown" || code === "KeyW" || code === "KeyS")) this.move(code === "ArrowUp" || code === "KeyW" ? -1 : 1);
    e.preventDefault();
    e.stopPropagation();
  };
}
