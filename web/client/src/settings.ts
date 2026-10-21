// İstemci ayarları: cihazda (localStorage) saklanır, herkesin kendi ekranını etkiler.
// Grafik ön ayarı alanları birlikte doldurur; tek tek değiştirilen alan ön ayarı "özel" yapar.

const KEY = "gap-settings";

export type Preset = "low" | "medium" | "high" | "ultra";
export type ShadowLevel = "off" | "low" | "high";

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
  /** Kenar yumuşatma (MSAA). */
  antialias: boolean;
  /** Gece gerçek lamba ışığı sayısı. */
  lamps: number;
  /** En yüksek piksel oranı (ekran dpr'ı ile sınırlı). */
  maxDpr: number;
  /** Kare düşünce çözünürlüğü kendiliğinden indir. */
  adaptive: boolean;
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
  /** Ses: sinema perdesi, ekran paylaşımı, efektler (0–1). */
  cinemaVolume: number;
  shareVolume: number;
  sfxVolume: number;
  /** Kamera: üçüncü ya da birinci şahıs (V ile de değişir). */
  firstPerson: boolean;
  /** Evcil hayvan (PETS id, "" yok) ve tank kamuflajı (SKINS id). */
  pet: string;
  skin: string;
  /** Kendi ekranında saat: "auto" dünyanın saati (gerçek ya da !saat), diğerleri yalnızca sende sabit. */
  clock: "auto" | "day" | "sunset" | "night";
  /** Sinemada video açıkken perdenin önü akşama döner. */
  cinemaDim: boolean;
}

type Graphics = Pick<Settings, "shadows" | "bloom" | "grade" | "grass" | "antialias" | "lamps" | "maxDpr">;

export const PRESETS: Record<Preset, Graphics> = {
  low: { shadows: "off", bloom: false, grade: false, grass: false, antialias: false, lamps: 0, maxDpr: 1 },
  medium: { shadows: "low", bloom: true, grade: false, grass: true, antialias: true, lamps: 4, maxDpr: 1.25 },
  high: { shadows: "high", bloom: true, grade: true, grass: true, antialias: true, lamps: 6, maxDpr: 1.5 },
  ultra: { shadows: "high", bloom: true, grade: true, grass: true, antialias: true, lamps: 8, maxDpr: 2 },
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
    adaptive: true,
    fpsCap: 0,
    fov: 60,
    sensitivity: 1,
    invertY: false,
    bubbles: true,
    showFps: false,
    cinemaVolume: 1,
    shareVolume: 1,
    sfxVolume: 0.7,
    firstPerson: false,
    pet: "",
    skin: "std",
    clock: "auto",
    cinemaDim: true,
  };
}

function load(): Settings {
  const s = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Settings>;
    for (const k of Object.keys(s) as (keyof Settings)[]) {
      if (typeof saved[k] === typeof s[k]) (s as unknown as Record<string, unknown>)[k] = saved[k];
    }
  } catch {
    // depolama kapalı ya da bozuk: varsayılanlar
  }
  // Eski bağlantılar: ?low ve ?nobloom kayıtlı ayarı bu oturum için ezer
  if (params.has("low")) Object.assign(s, PRESETS.low, { preset: "low" });
  if (params.has("nobloom")) s.bloom = false;
  if (params.has("noadapt")) s.adaptive = false;
  return s;
}

export const settings: Settings = load();
const listeners = new Set<(s: Settings, changed: (keyof Settings)[]) => void>();

/** Değişiklikleri uygular, saklar ve dinleyicilere bildirir. */
export function updateSettings(patch: Partial<Settings>): void {
  const changed = (Object.keys(patch) as (keyof Settings)[]).filter((k) => patch[k] !== settings[k]);
  if (!changed.length) return;
  Object.assign(settings, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // depolama kapalı: yalnızca bu oturumda geçerli
  }
  for (const fn of listeners) fn(settings, changed);
}

export function applyPreset(p: Preset): void {
  updateSettings({ preset: p, ...PRESETS[p] });
}

export function resetSettings(): void {
  updateSettings(defaults());
}

/** Ayar değişince çağrılır; dönen işlev dinlemeyi bırakır (mod değişince). */
export function onSettings(fn: (s: Settings, changed: (keyof Settings)[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
