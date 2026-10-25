// GAP Garaj tuning ekranı (GTA'daki LS Customs gibi): solda afişli menü (kategoriler → seçenekler), seçenek
// üstünde durunca araba anında o hâliyle görünür, Enter takar. Kamera seçili kategorinin parçasına döner (jant →
// ön tekerlek, spoiler → arka, plaka → arka plaka…); fareyle sürükleyerek ya da A/D ile araba etrafında dönülür.
import {
  CAR_COLORS, CAR_DECALS, CAR_ENGINES, CAR_EXHAUSTS, CAR_HORNS, CAR_LIGHTS, CAR_MODELS, CAR_NEONS, CAR_RIMS, CAR_SPOILERS, BIKE_NO_MODS, carPerf, type CarSpec, isBike, normalPlate, validCar,
} from "../../../shared/car";
import { itemPrice, modItem } from "../../../shared/shop";
import { owned } from "../owned";
import { hornIsTune, Horns } from "./horn";
import { sfx } from "./sfx";
import { type IconName, iconHtml } from "./icons";

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
  icon: IconName;
  desc: string;
  cam: CamPreset;
  options?: readonly Option[];
}

const OVERVIEW: CamPreset = { tx: 0, ty: 0.6, tz: 0, yaw: 0.8, pitch: 0.26, dist: 6.4 };

const YESNO = (no: string, yes: string): Option[] => [{ id: "false", name: no }, { id: "true", name: yes }];

const CATEGORIES: Category[] = [
  { key: "engine", label: "Motor", icon: "engine", desc: "Chip, büyük turbo ya da yarış motoru: daha yüksek hız ve ivme. Turbo gaz bırakınca pıslar.", cam: { tx: 0, ty: 0.85, tz: 1.5, yaw: 0.55, pitch: 0.38, dist: 3.6 }, options: CAR_ENGINES },
  { key: "color", label: "Boya", icon: "paintBucket", desc: "Gövde rengi. Çıkartma ve yazılar boyaya göre açık ya da koyu olur.", cam: { tx: 0, ty: 0.65, tz: 0, yaw: 0.95, pitch: 0.22, dist: 6.0 }, options: CAR_COLORS },
  { key: "rim", label: "Jantlar", icon: "tire", desc: "Jant modeli: çelik kapaklı, spor, altın ya da siyah.", cam: { tx: 0.82, ty: 0.31, tz: 1.245, yaw: 1.3, pitch: 0.1, dist: 2.4 }, options: CAR_RIMS },
  { key: "spoiler", label: "Spoiler", icon: "airplane", desc: "Bagaj kapağına arka spoiler.", cam: { tx: 0, ty: 1.15, tz: -1.9, yaw: Math.PI - 0.6, pitch: 0.42, dist: 4.4 }, options: CAR_SPOILERS },
  { key: "decal", label: "Çıkartma", icon: "flag", desc: "Kaput ve tavandan geçen yarış şeridi, yanlarda alev ya da damalı taksi.", cam: { tx: 0, ty: 0.85, tz: 0, yaw: Math.PI / 2 + 0.15, pitch: 0.3, dist: 5.8 }, options: CAR_DECALS },
  { key: "neon", label: "Neon alt ışık", icon: "lightbulb", desc: "Gövdenin altından yere vuran ışık; gece daha parlak.", cam: { tx: 0, ty: 0.15, tz: 0, yaw: 1.05, pitch: 0.07, dist: 5.6 }, options: CAR_NEONS },
  { key: "lights", label: "Farlar", icon: "headlights", desc: "Far camının rengi: standart, xenon (buz mavisi) ya da retro sarı.", cam: { tx: 0, ty: 0.62, tz: 2.15, yaw: 0.32, pitch: 0.12, dist: 3.4 }, options: CAR_LIGHTS },
  { key: "exhaust", label: "Egzoz", icon: "wind", desc: "Egzoz ucu: standart, çift çıkış ya da kalın krom spor.", cam: { tx: 0, ty: 0.28, tz: -2.2, yaw: Math.PI - 0.4, pitch: 0.12, dist: 2.7 }, options: CAR_EXHAUSTS },
  { key: "horn", label: "Korna", icon: "megaphone", desc: "Arabada E ile çalınır (basılı tut). Melodili kornalar bir kez sonuna kadar çalar.", cam: { tx: 0, ty: 0.7, tz: 2.1, yaw: 0.2, pitch: 0.15, dist: 3.8 }, options: CAR_HORNS },
  { key: "tint", label: "Cam filmi", icon: "sunglasses", desc: "Koyu cam filmi: içerisi zor görünür.", cam: { tx: 0, ty: 1.1, tz: -0.1, yaw: Math.PI / 2 + 0.3, pitch: 0.12, dist: 4.2 }, options: YESNO("Yok", "Koyu film") },
  { key: "low", label: "Süspansiyon", icon: "arrowDown", desc: "Basık süspansiyon: gövde tekerleklere göre aşağıda.", cam: { tx: 0, ty: 0.35, tz: 0, yaw: Math.PI / 2, pitch: 0.03, dist: 5.2 }, options: YESNO("Standart", "Basık") },
  { key: "plate", label: "Plaka", icon: "tag", desc: "Plaka yazısı: harf, rakam ve boşluk, en çok 10 karakter.", cam: { tx: 0, ty: 0.37, tz: -2.3, yaw: Math.PI, pitch: 0.12, dist: 2.4 } },
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
  /** Arabanın hasarı: seviye (0–3), göçük ya da kırık far var mı, tamir ücreti, tamir sürüyor mu. */
  wear(): { level: number; dented: boolean; fee: number; busy: boolean };
  /** Tamir et (hafif çizik bedava, hasar ücretli). */
  repair(): void;
}

/** Motorlarda kamera: araba için ayarlanan bakış noktaları küçük gövdeye sıkıştırılır, daha yakından bakılır. */
function bikeCam(c: CamPreset): CamPreset {
  return { ...c, tx: c.tx * 0.3, ty: Math.min(1.1, c.ty * 0.85 + 0.12), tz: c.tz * 0.45, dist: c.dist * 0.55 };
}
const REPAIR_DESC = "Göçükler, kırık farlar, duman ve motorun kaybettiği güç: hepsi sıfırlanır. Hafif çizikler bedava silinir.";

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
  /** Bu arabanın kategorileri (motorda spoiler, çıkartma, cam filmi, süspansiyon yok). */
  private cats: Category[] = CATEGORIES;
  private bike = false;
  private level: 0 | 1 = 0;
  private cat = 0;
  private sel = 0;
  private plateInput: HTMLInputElement | null = null;
  /** Satın alınınca takılacak parça (alan, değer) ve anahtarı: yalnızca o parça alınınca, o anki arabaya takılır. */
  private pending: { key: keyof CarSpec; value: CarSpec[keyof CarSpec]; item: string } | null = null;
  /** Korna önizlemesi (seçeneğin üstünde durunca bir kez çalar). */
  private horns = new Horns();
  private hornTimer = 0;
  isOpen = false;
  /** Kullanıcının döndürmesi (radyan) ve döndürme tuşu; son dokunuş (otomatik dönüş için). */
  yaw = 0;
  private spin = 0;
  private spinKeys = { l: false, r: false };
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
      if (p && owned.has(p.item)) {
        this.pending = null;
        this.applyNow(validCar({ ...this.applied, [p.key]: p.value }) ?? this.applied);
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
    this.drag.addEventListener("pointercancel", () => (down = null));
    for (const type of ["keydown", "keyup"] as const) addEventListener(type, this.onKey, true);
  }

  /** Menünün sağ kenarı (px): araba bu kenarın sağındaki boş alanın ortasında görünsün. */
  get panelRight(): number {
    return this.isOpen ? (this.root.querySelector(".tune-panel") as HTMLElement).getBoundingClientRect().right : 0;
  }

  /** Kamera ön ayarı: kategori listesindeyken genel görünüm, içerideyken o parçanın görünümü. */
  get cam(): CamPreset {
    // Listede gezinirken de kamera üstünde durulan parçaya döner (GTA'daki gibi)
    const c = this.level === 1 ? this.cats[this.cat].cam : this.sel < this.cats.length ? this.cats[this.sel].cam : OVERVIEW;
    return this.bike ? bikeCam(c) : c;
  }

  /** Kare başına: A/D ile dönüş. */
  tick(dt: number): void {
    if (this.spin) {
      this.yaw += this.spin * dt * 1.6;
      this.lastTouch = performance.now();
    }
  }

  /** Kategori listesinin sonundaki satırlar: tamir ve çıkış. */
  private get repairRow(): number {
    return this.cats.length;
  }

  private get exitRow(): number {
    return this.cats.length + 1;
  }

  open(spec: CarSpec): void {
    this.applied = { ...spec };
    this.bike = isBike(spec.model);
    this.cats = this.bike ? CATEGORIES.filter((c) => !BIKE_NO_MODS.includes(c.key)) : CATEGORIES;
    this.level = 0;
    this.cat = 0;
    // Hasarlı geldiysen imleç Tamir'de başlar
    const w = this.hooks.wear();
    this.sel = w.level || w.dented ? this.repairRow : 0;
    this.yaw = 0;
    this.isOpen = true;
    this.root.classList.add("show");
    if (document.pointerLockElement) document.exitPointerLock();
    this.render();
  }

  /** Hasar değişti (tamir edildi): listeyi yenile. */
  refresh(): void {
    if (this.isOpen && this.level === 0) this.render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.pending = null;
    this.root.classList.remove("show");
    this.spin = 0;
    this.spinKeys = { l: false, r: false };
    this.horns.silence();
    this.hooks.preview(this.applied);
    this.hooks.close();
  }

  private rows(): number {
    return this.level === 0 ? this.exitRow + 1 : (this.cats[this.cat].options?.length ?? 1);
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
    const c = this.cats[this.cat], o = c.options?.[this.sel];
    if (!o) return this.applied;
    const v = o.id === "true" ? true : o.id === "false" ? false : o.id;
    return validCar({ ...this.applied, [c.key]: v }) ?? this.applied;
  }

  private previewSel(): void {
    const spec = this.candidate();
    this.hooks.preview(spec);
    if (this.cats[this.cat].key === "horn") {
      window.clearTimeout(this.hornTimer);
      this.horns.start(-1, spec.horn, 0.8);
      if (!hornIsTune(spec.horn)) this.hornTimer = window.setTimeout(() => this.horns.release(-1), 450);
    }
  }

  private enter(): void {
    if (this.level === 0) {
      if (this.sel === this.exitRow) return this.close();
      if (this.sel === this.repairRow) {
        const w = this.hooks.wear();
        if (!w.busy && (w.level || w.dented)) this.hooks.repair();
        else sfx.tick(1);
        return this.render();
      }
      this.cat = this.sel;
      this.level = 1;
      const c = this.cats[this.cat];
      this.sel = Math.max(0, c.options?.findIndex((o) => o.id === valueOf(this.applied, c.key)) ?? 0);
      this.yaw = 0;
      sfx.chip();
      this.previewSel();
      this.render();
      if (c.key === "plate") requestAnimationFrame(() => this.plateInput?.focus());
      return;
    }
    const c = this.cats[this.cat];
    if (c.key === "plate") {
      // Geçersiz yazı sessizce "34 GAP 34"e dönmesin: uyar, takma
      const plate = normalPlate(this.plateInput?.value ?? this.applied.plate);
      if (!plate) {
        this.desc.textContent = "⚠️ Plakada yalnızca harf, rakam ve boşluk olabilir (en çok 10 karakter).";
        sfx.tick(1);
        return;
      }
      this.applyNow({ ...this.applied, plate });
      return;
    }
    this.applyNow(this.candidate());
  }

  /** Arabanın bu kategorideki satın alınmamış parçası (anahtar) — yoksa null. */
  private missing(spec: CarSpec): string | null {
    const c = this.cats[this.cat], v = spec[c.key];
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
      const key = this.cats[this.cat].key;
      this.pending = { key, value: spec[key], item: need };
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
    this.horns.silence();
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
      this.sub.innerHTML = `<span>${model.toLocaleUpperCase("tr-TR")} · KATEGORİLER</span><em>${this.sel + 1}/${this.rows()}</em>`;
      this.cats.forEach((c, i) => {
        const cur = c.options?.find((o) => o.id === valueOf(this.applied, c.key));
        this.row(i, c.label, cur?.name ?? this.applied.plate, cur?.hex, false, c.icon);
      });
      const w = this.hooks.wear();
      const state = w.busy ? "Tamir ediliyor…" : w.level ? `${w.fee.toLocaleString("tr-TR")} ₺` : w.dented ? "Bedava" : "Sağlam";
      this.row(this.repairRow, `Tamir${w.level ? ` · ${["", "hafif", "orta", "ağır"][w.level]} hasar` : ""}`, state, undefined, false, "wrench");
      this.row(this.exitRow, "Garajdan çık", "", undefined, false, "doorOpen");
      this.desc.textContent = this.sel < this.cats.length ? this.cats[this.sel].desc : this.sel === this.repairRow ? REPAIR_DESC : "Tuning'i bitir ve arabayla dışarı sür.";
      if (this.sel === 0) this.desc.textContent += ` ${perfLine(this.applied)}`;
      return;
    }
    const c = this.cats[this.cat];
    this.sub.innerHTML = `<span>${iconHtml(c.icon)} ${c.label.toLocaleUpperCase("tr-TR")}</span><em>${this.sel + 1}/${this.rows()}</em>`;
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
      ok.textContent = "Tak";
      ok.addEventListener("click", () => this.enter());
      wrap.append(input, ok);
      this.list.append(wrap);
      this.plateInput = input;
    } else {
      c.options!.forEach((o, i) => {
        const on = o.id === valueOf(this.applied, c.key), p = this.price(c.key, o.id);
        this.row(i, o.name, on ? "Takılı" : p ? `${p.toLocaleString("tr-TR")} ₺` : "Senin", o.hex, on);
      });
    }
    this.desc.textContent = c.key === "engine" ? `${c.desc} ${perfLine(this.candidate())}` : c.desc;
  }

  private row(i: number, label: string, value: string, hex: string | undefined, on: boolean, ic?: IconName): void {
    const r = document.createElement("button");
    r.className = `tune-row${i === this.sel ? " sel" : ""}${on ? " on" : ""}`;
    r.innerHTML = `${ic ? iconHtml(ic, "tune-ic") : ""}${hex !== undefined ? `<i style="background:${hex || "transparent"}"></i>` : ""}<span>${label}</span><b>${value}</b>`;
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
    // Tarayıcı kısayolları (F5, F12, Ctrl+R…) çalışsın
    if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.code)) return;
    const down = e.type === "keydown";
    const code = e.code;
    if (code === "KeyA" || code === "ArrowLeft" || code === "KeyD" || code === "ArrowRight") {
      // İki yön birden basılıyken biri bırakılınca öteki sürsün
      this.spinKeys[code === "KeyA" || code === "ArrowLeft" ? "l" : "r"] = down;
      this.spin = (this.spinKeys.l ? 1 : 0) - (this.spinKeys.r ? 1 : 0);
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
