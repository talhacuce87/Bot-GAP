// İstemci ayarları: cihazda (localStorage) saklanır, herkesin kendi ekranını etkiler.
// Grafik ön ayarı alanları birlikte doldurur; tek tek değiştirilen alan ön ayarı "özel" yapar.

import { CAR_MODELS, type CarSpec, DEFAULT_CAR, isJobCar, validCar } from "../../shared/car";

const KEY = "gap-settings";

export type Preset = "low" | "medium" | "high" | "ultra";
export type ShadowLevel = "off" | "low" | "high";
export type RenderScale = 0 | 1 | 0.77 | 0.67 | 0.5;
export const RENDER_SCALES: readonly RenderScale[] = [0, 1, 0.77, 0.67, 0.5];

export interface Settings {
  preset: Preset | "custom";
  /** Gerçek zamanlı güneş gölgesi (kapalıyken yalnızca zemin lekeleri). */
  shadows: ShadowLevel;
  /** Işık parlaması: lambalar, ateş, güneş. */
  bloom: boolean;
  /** Renk düzenleme ve kenar karartma (son işlem). */
  grade: boolean;
  /** Oyuncunun çevresindeki sık çimen. */
  grass: boolean;
  /** Güneş ışık huzmeleri ve lens parlaması. */
  godrays: boolean;
  /** Kenar yumuşatma (MSAA). */
  antialias: boolean;
  /** Gece gerçek lamba ışığı sayısı. */
  lamps: number;
  /** En yüksek piksel oranı (ekran dpr'ı ile sınırlı). */
  maxDpr: number;
  /**
   * Çözünürlük ölçeği: sahne bu oranda çizilip FSR benzeri büyütmeyle tuvale taşınır.
   * 0 = otomatik (kare düşünce kendiliğinden iner, sorunsuzsa geri çıkar).
   */
  renderScale: RenderScale;
  /** Kare sınırı: 0 = ekranın yenileme hızı. */
  fpsCap: 0 | 30 | 60;
  fov: number;
  /** Fare/dokunmatik bakış hassasiyeti çarpanı. */
  sensitivity: number;
  invertY: boolean;
  /** Konuşma balonları. */
  bubbles: boolean;
  /** Köşede FPS göstergesi. */
  showFps: boolean;
  /** Köşede ağ paneli: ping, kayıp, grafikler (kısayol: F3). */
  showNet: boolean;
  /** Ses: sinema perdesi, ekran paylaşımı, efektler (0–1). */
  cinemaVolume: number;
  shareVolume: number;
  sfxVolume: number;
  /** Kamera: üçüncü ya da birinci şahıs (V ile de değişir). */
  firstPerson: boolean;
  /** Evcil hayvan (PETS id, "" yok) ve tank kamuflajı (SKINS id). */
  pet: string;
  /** Telefonun duvar kağıdı (ui/phone WALLS id). */
  phoneWall: string;
  /** Son çağrılan/sürülen Tofaş (görünümü GAP Garaj'da düzenlenir). */
  car: CarSpec;
  /** Her modelin kendi tuning'i (Şahin, Doğan SLX, Kartal herkeste var). */
  cars: Record<CarSpec["model"], CarSpec>;
  /** Araba radyolarının sesi (0–1). */
  radioVolume: number;
  skin: string;
  /** Paintball silahının skini (shared/paintball GUN_SKINS; galibiyetle açılır, sunucu doğrular). */
  pbSkin: string;
  /** Kendi ekranında saat: "auto" dünyanın saati (gerçek ya da !saat), diğerleri yalnızca sende sabit. */
  clock: "auto" | "day" | "sunset" | "night";
  /** Sinemada video açıkken perdenin önü akşama döner. */
  cinemaDim: boolean;
}

type Graphics = Pick<Settings, "shadows" | "bloom" | "grade" | "grass" | "godrays" | "antialias" | "lamps" | "maxDpr" | "renderScale">;

export const PRESETS: Record<Preset, Graphics> = {
  low: { shadows: "off", bloom: false, grade: false, grass: false, godrays: false, antialias: false, lamps: 0, maxDpr: 1, renderScale: 0 },
  medium: { shadows: "low", bloom: true, grade: false, grass: true, godrays: false, antialias: true, lamps: 4, maxDpr: 1.25, renderScale: 0 },
  high: { shadows: "high", bloom: true, grade: true, grass: true, godrays: true, antialias: true, lamps: 6, maxDpr: 1.5, renderScale: 0 },
  ultra: { shadows: "high", bloom: true, grade: true, grass: true, godrays: true, antialias: true, lamps: 8, maxDpr: 2, renderScale: 1 },
};

export const PRESET_NAMES: Record<Preset, string> = { low: "Düşük", medium: "Orta", high: "Yüksek", ultra: "Ultra" };

/** Değişince dünyanın yeniden kurulması gereken alanlar (sahne/renderer kurulurken okunur). */
export const RESTART_KEYS: readonly (keyof Settings)[] = ["grass", "antialias", "lamps"];

// Testler (node) bu modülü dolaylı içe aktarır: tarayıcı nesneleri yoksa varsayılanlar
const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
/** Dokunmatik ve az çekirdekli cihazlar: varsayılan düşük kalite. */
export const lowPowerDevice = params.has("low") || touch || ((typeof navigator === "undefined" ? 0 : navigator.hardwareConcurrency) || 4) <= 4;

function defaults(): Settings {
  const preset: Preset = lowPowerDevice ? "low" : "high";
  return {
    preset,
    ...PRESETS[preset],
    fpsCap: 0,
    fov: 60,
    sensitivity: 1,
    invertY: false,
    bubbles: true,
    showFps: false,
    showNet: false,
    cinemaVolume: 1,
    shareVolume: 1,
    sfxVolume: 0.7,
    firstPerson: false,
    pet: "",
    phoneWall: "gece",
    car: { ...DEFAULT_CAR },
    cars: Object.fromEntries(CAR_MODELS.map((m) => [m.id, { ...DEFAULT_CAR, model: m.id }])) as Settings["cars"],
    radioVolume: 0.8,
    skin: "std",
    pbSkin: "klasik",
    clock: "auto",
    cinemaDim: true,
  };
}

function load(): Settings {
  const s = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Settings> & { adaptive?: boolean };
    for (const k of Object.keys(s) as (keyof Settings)[]) {
      if (typeof saved[k] === typeof s[k]) (s as unknown as Record<string, unknown>)[k] = saved[k];
    }
    // Eski kayıt: "kare düşünce çözünürlüğü indir" kapalıysa sabit %100
    if (saved.renderScale === undefined && saved.adaptive === false) s.renderScale = 1;
  } catch {
    // depolama kapalı ya da bozuk: varsayılanlar
  }
  if (!RENDER_SCALES.includes(s.renderScale)) s.renderScale = 0;
  s.car = validCar(s.car) ?? { ...DEFAULT_CAR };
  // Model başına tuning: eski kayıtta yalnızca tek araba vardı (o modelin ayarı olur, diğerleri onun boyasıyla)
  // Kayıtta olmayan yeni model (ör. scooter) sıfır gelir; hiç model kaydı yoksa eski tek arabanın görünümü
  const cars = (s.cars ?? {}) as Partial<Record<string, unknown>>, fresh = !Object.keys(cars).length;
  s.cars = Object.fromEntries(
    CAR_MODELS.map((m) => [m.id, validCar(cars[m.id]) ?? (s.car.model === m.id ? { ...s.car } : fresh ? { ...s.car, model: m.id } : { ...DEFAULT_CAR, model: m.id })]),
  ) as Settings["cars"];
  for (const m of CAR_MODELS) s.cars[m.id].model = m.id;
  // Eski bağlantılar: ?low ve ?nobloom kayıtlı ayarı bu oturum için ezer
  if (params.has("low")) Object.assign(s, PRESETS.low, { preset: "low" });
  if (params.has("nobloom")) s.bloom = false;
  if (params.has("noadapt") && !s.renderScale) s.renderScale = 1;
  return s;
}

export const settings: Settings = load();
/** Kaydedilen araba: iş aracı (taksi, scooter) kaydedilmez, işe girmeden önceki araban kalır. */
let ownCar = settings.car;
const listeners = new Set<(s: Settings, changed: (keyof Settings)[]) => void>();

/** Değişiklikleri uygular, saklar ve dinleyicilere bildirir. */
export function updateSettings(patch: Partial<Settings>): void {
  const changed = (Object.keys(patch) as (keyof Settings)[]).filter((k) => patch[k] !== settings[k]);
  if (!changed.length) return;
  Object.assign(settings, patch);
  try {
    if (!isJobCar(settings.car.model)) ownCar = settings.car;
    localStorage.setItem(KEY, JSON.stringify({ ...settings, car: ownCar }));
  } catch {
    // depolama kapalı: yalnızca bu oturumda geçerli
  }
  for (const fn of listeners) fn(settings, changed);
}

export function applyPreset(p: Preset): void {
  updateSettings({ preset: p, ...PRESETS[p] });
}

/** Ayarlar penceresindekileri varsayılana döndürür; araba, evcil hayvan, kamuflaj ve duvar kağıdı seçimleri kalır. */
export function resetSettings(): void {
  const { car, cars, pet, skin, pbSkin, phoneWall } = settings;
  updateSettings({ ...defaults(), car, cars, pet, skin, pbSkin, phoneWall });
}

/** Ayar değişince çağrılır; dönen işlev dinlemeyi bırakır (mod değişince). */
export function onSettings(fn: (s: Settings, changed: (keyof Settings)[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
