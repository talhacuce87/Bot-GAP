// Araba: oyuncunun kendi arabası (Tofaşlar ve Türkiye yollarının efsaneleri). Sürerken konumu normal oyuncu
// konumudur (araba merkezi, yön `rot`); kim hangi arabada (model, renk, jant, motor…) oyuncu bilgisinde taşınır
// ve sunucu doğrular.

export const CAR_MODELS = [
  { id: "sahin", name: "Şahin" },
  { id: "dogan", name: "Doğan SLX" },
  { id: "kartal", name: "Kartal" },
  { id: "linea", name: "Linea 1.3 Multijet" },
  { id: "doblo", name: "Doblo" },
  { id: "passat", name: "Passat 1.9 TDI" },
  { id: "e30", name: "BMW E30" },
  { id: "scooter", name: "Scooter" },
] as const;
export const CAR_COLORS = [
  { id: "beyaz", name: "Beyaz", hex: "#f1efe7" },
  { id: "kirmizi", name: "Kırmızı", hex: "#b3121c" },
  { id: "siyah", name: "Siyah", hex: "#1b1c1f" },
  { id: "lacivert", name: "Lacivert", hex: "#1d2b55" },
  { id: "bej", name: "Bej", hex: "#d9c9a3" },
  { id: "gri", name: "Gri metalik", hex: "#8d949b" },
  { id: "taksi", name: "Taksi sarısı", hex: "#f2c230" },
  { id: "yesil", name: "Yeşil", hex: "#2f6b3a" },
  { id: "turuncu", name: "Turuncu", hex: "#e8742a" },
  { id: "mor", name: "Mor", hex: "#5b2a86" },
  { id: "bebek", name: "Bebek mavisi", hex: "#8fc3e6" },
  { id: "pembe", name: "Pembe", hex: "#e889b5" },
] as const;
export const CAR_RIMS = [
  { id: "celik", name: "Çelik (jant kapaklı)" },
  { id: "spor", name: "Spor" },
  { id: "altin", name: "Altın" },
  { id: "siyah", name: "Siyah" },
] as const;
export const CAR_SPOILERS = [
  { id: "yok", name: "Yok" },
  { id: "kucuk", name: "Küçük" },
  { id: "buyuk", name: "Büyük (drift)" },
] as const;
export const CAR_DECALS = [
  { id: "yok", name: "Yok" },
  { id: "serit", name: "Yarış şeridi" },
  { id: "alev", name: "Alev" },
  { id: "dama", name: "Damalı (taksi)" },
] as const;
export const CAR_NEONS = [
  { id: "yok", name: "Yok", hex: "" },
  { id: "mavi", name: "Mavi", hex: "#3fa9ff" },
  { id: "pembe", name: "Pembe", hex: "#ff4fd8" },
  { id: "yesil", name: "Yeşil", hex: "#4dff88" },
  { id: "kirmizi", name: "Kırmızı", hex: "#ff3b3b" },
  { id: "mor", name: "Mor", hex: "#a86bff" },
  { id: "turuncu", name: "Turuncu", hex: "#ff8a1f" },
  { id: "sari", name: "Sarı", hex: "#ffd23f" },
  { id: "turkuaz", name: "Turkuaz", hex: "#25e8d8" },
  { id: "beyaz", name: "Beyaz", hex: "#f2f5ff" },
  /** Siyah ışık yanmaz: yere koyu bir gölge hâlesi düşer, tüpler mat siyah. */
  { id: "siyah", name: "Siyah", hex: "#111114" },
] as const;

/** Far camı: ışığın rengi (gece daha belirgin). */
export const CAR_LIGHTS = [
  { id: "standart", name: "Standart", hex: "#fff6dc" },
  { id: "xenon", name: "Xenon (buz mavisi)", hex: "#cfe6ff" },
  { id: "sari", name: "Sarı (retro)", hex: "#ffd46b" },
] as const;
export const CAR_EXHAUSTS = [
  { id: "standart", name: "Standart" },
  { id: "cift", name: "Çift çıkış" },
  { id: "spor", name: "Spor (kalın krom)" },
] as const;

/** Motor (GAP Garaj): en yüksek hız ve ivme çarpanı. */
export const CAR_ENGINES = [
  { id: "stok", name: "Stok" },
  { id: "chip", name: "Chip tuning (Aşama 1)" },
  { id: "turbo", name: "Büyük turbo (Aşama 2)" },
  { id: "yaris", name: "Yarış motoru (Aşama 3)" },
] as const;
/** Korna: basılı tutulan (standart, dolmuş, TIR) ya da bir kez çalan melodi (La Cucaracha, düğün konvoyu). */
export const CAR_HORNS = [
  { id: "standart", name: "Standart" },
  { id: "dolmus", name: "Dolmuş (cırtlak)" },
  { id: "kamyon", name: "Havalı korna (TIR)" },
  { id: "cucaracha", name: "La Cucaracha" },
  { id: "dugun", name: "Düğün konvoyu" },
] as const;

type Id<T extends readonly { id: string }[]> = T[number]["id"];

/**
 * İşin araçları (shared/jobs): kuryenin GAP Kurye scooter'ı ve sarı GAP Taksi (Doblo). Garajda ve çağırma
 * menüsünde yoktur; yalnızca o işteyken sürülür (sunucu doğrular).
 */
export const JOB_CAR_MODELS = [
  { id: "motor", name: "GAP Kurye scooter" },
  { id: "taksi", name: "GAP Taksi" },
] as const;
export type CarModel = Id<typeof CAR_MODELS> | Id<typeof JOB_CAR_MODELS>;
export const isJobCar = (m: unknown): m is Id<typeof JOB_CAR_MODELS> => JOB_CAR_MODELS.some((x) => x.id === m);

/**
 * İki tekerlekliler (kurye ve kişisel scooter; yeni motorlar buraya eklenir): küçük gövde, yolcu almaz, sürücü
 * selede görünür; spoiler, çıkartma, cam filmi ve basık süspansiyon yoktur.
 */
export const BIKE_MODELS: readonly CarModel[] = ["motor", "scooter"];
export const isBike = (m: unknown): boolean => BIKE_MODELS.includes(m as CarModel);
/** Motorlarda olmayan modifiyeler (tuning menüsünde çıkmaz, sunucu varsayılana döndürür). */
export const BIKE_NO_MODS: readonly (keyof CarSpec)[] = ["spoiler", "decal", "tint", "low"];

export interface CarSpec {
  model: CarModel;
  color: Id<typeof CAR_COLORS>;
  rim: Id<typeof CAR_RIMS>;
  spoiler: Id<typeof CAR_SPOILERS>;
  decal: Id<typeof CAR_DECALS>;
  neon: Id<typeof CAR_NEONS>;
  lights: Id<typeof CAR_LIGHTS>;
  exhaust: Id<typeof CAR_EXHAUSTS>;
  engine: Id<typeof CAR_ENGINES>;
  horn: Id<typeof CAR_HORNS>;
  /** Koyu cam filmi. */
  tint: boolean;
  /** Basık süspansiyon. */
  low: boolean;
  /** Plaka yazısı (büyük harf, rakam, boşluk; en çok 10). */
  plate: string;
}

export const DEFAULT_CAR: CarSpec = { model: "sahin", color: "beyaz", rim: "celik", spoiler: "yok", decal: "yok", neon: "yok", lights: "standart", exhaust: "standart", engine: "stok", horn: "standart", tint: false, low: false, plate: "34 GAP 34" };

/** Park halindeki araba: indiğin yerde kalır, herkes görür (yalnızca sahibi biner). */
export interface ParkedCar {
  car: CarSpec;
  x: number;
  z: number;
  rot: number;
  /** Hasarı ve göçükleri (park edince de görünür; binince geri gelir). */
  dmg?: number;
  dents?: CarDents | null;
}
/** Arabayı bu kadar uzağa park edebilir/çağırabilirsin (sunucu, oyuncunun konumuna göre). */
export const PARK_REACH = 10;
/** Park halindeki arabaya binmek için arabanın orta eksenine en çok bu kadar yakın olmalı (yandan ~2 m). */
export const ENTER_REACH = 3;

/** Sunucunun kabul ettiği en yüksek araba hızı (m/sn; en hızlı model, yarış motoru ve Shift ile). */
export const CAR_MAX_SPEED = 46;
/** Stok Şahin'in en yüksek hızı (m/sn); geri vites, fren ve el freni yavaşlaması. */
export const CAR_SPEED = 25;
export const CAR_REVERSE = 7;
export const CAR_BRAKE = 22;
export const CAR_HANDBRAKE = 9;
/** Shift: kısa süreli fazladan güç (en yüksek hız çarpanı). */
export const CAR_BOOST = 1.1;

/**
 * Modelin sürüşü: en yüksek hız (m/sn), ivme (m/sn²), direksiyon, yol tutuş (1 normal), arkadan itiş (kayma
 * eğilimi: gaz verince arka kayar) ve motor sesi (devir çarpanı, dizel mi).
 */
export interface CarStats {
  top: number;
  accel: number;
  turn: number;
  grip: number;
  drift: number;
  pitch: number;
  diesel: boolean;
}
export const CAR_STATS: Record<CarModel, CarStats> = {
  // Scooter: çevik ve hızlı kalkar, son sürati düşük
  motor: { top: 21, accel: 12.5, turn: 1.3, grip: 1.1, drift: 0.1, pitch: 1.5, diesel: false },
  // Kişisel scooter: kuryeninkiyle aynı; motor modifiyesiyle açılır
  scooter: { top: 21, accel: 12.5, turn: 1.3, grip: 1.1, drift: 0.1, pitch: 1.5, diesel: false },
  // Taksi Doblo: dizel, ağır
  taksi: { top: 23, accel: 8.6, turn: 0.94, grip: 0.92, drift: 0.2, pitch: 0.75, diesel: true },
  sahin: { top: CAR_SPEED, accel: 10, turn: 1, grip: 1, drift: 0.6, pitch: 1, diesel: false },
  dogan: { top: 26.5, accel: 10.5, turn: 1.02, grip: 1.03, drift: 0.6, pitch: 1.08, diesel: false },
  kartal: { top: 24, accel: 9.2, turn: 0.95, grip: 0.98, drift: 0.7, pitch: 0.95, diesel: false },
  // Linea 1.3 Multijet: yakmaz, ama kaldırmaz da
  linea: { top: 24.5, accel: 8.6, turn: 1.04, grip: 1.08, drift: 0.1, pitch: 0.72, diesel: true },
  // Doblo: yüksek ve hafif; virajda yalpalar
  doblo: { top: 23, accel: 8.4, turn: 0.92, grip: 0.9, drift: 0.2, pitch: 0.75, diesel: true },
  // Passat B5 TDI: otoyol canavarı
  passat: { top: 28, accel: 11, turn: 0.97, grip: 1.05, drift: 0.2, pitch: 0.7, diesel: true },
  // E30: arkadan itişli, el freniyle drift kralı
  e30: { top: 27, accel: 11.5, turn: 1.12, grip: 0.95, drift: 1.6, pitch: 1.25, diesel: false },
};
const ENGINE_MULT: Record<Id<typeof CAR_ENGINES>, { top: number; accel: number }> = {
  stok: { top: 1, accel: 1 },
  chip: { top: 1.1, accel: 1.2 },
  turbo: { top: 1.22, accel: 1.45 },
  yaris: { top: 1.36, accel: 1.75 },
};

/** Arabanın (model + motor) en yüksek hızı ve ivmesiyle sürüşü. */
export function carPerf(spec: Pick<CarSpec, "model" | "engine">): CarStats {
  const s = CAR_STATS[spec.model] ?? CAR_STATS.sahin, m = ENGINE_MULT[spec.engine] ?? ENGINE_MULT.stok;
  return { ...s, top: s.top * m.top, accel: s.accel * m.accel };
}
/**
 * Görsel hasar (herkes görür): ön, arka, sol ve sağ göçük (0–3) ve kırık farlar (bit: 1 sol, 2 sağ).
 * Arabanın yerel ekseni: +x sol, +z ön.
 */
export interface CarDents {
  f: number;
  r: number;
  l: number;
  rt: number;
  hl: number;
}
export const NO_DENTS: CarDents = { f: 0, r: 0, l: 0, rt: 0, hl: 0 };
/** İstemciden gelen hasarı doğrular (geçersizse null). */
export function validDents(v: unknown): CarDents | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const lvl = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 3 ? (x as number) : null);
  const f = lvl(o.f), r = lvl(o.r), l = lvl(o.l), rt = lvl(o.rt), hl = lvl(o.hl);
  return f === null || r === null || l === null || rt === null || hl === null ? null : { f, r, l, rt, hl };
}

/** Çarpışma: gövde boyunca iki daire (merkezden ±OFFSET, yarıçap R). */
export const CAR_HULL_R = 0.92;
export const CAR_HULL_OFFSET = 1.15;

const PLATE = /^[0-9A-ZÇĞİÖŞÜ ]{1,10}$/;
/** Plaka yazısını düzeltir (büyük harf, tek boşluk); geçersizse null. */
export function normalPlate(v: string): string | null {
  const p = v.toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim().slice(0, 10);
  return PLATE.test(p) ? p : null;
}

function pick<T extends readonly { id: string }[]>(list: T, v: unknown, def: Id<T>): Id<T> {
  return typeof v === "string" && list.some((o) => o.id === v) ? (v as Id<T>) : def;
}

/** İstemciden gelen arabayı doğrular: geçersiz alanlar varsayılana döner; nesne değilse null (arabadan in). */
export function validCar(v: unknown): CarSpec | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  const plate = typeof c.plate === "string" ? c.plate.toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim().slice(0, 10) : "";
  const out: CarSpec = {
    // İş araçları burada düşer (sunucu işteyse ayrıca izin verir)
    model: pick(CAR_MODELS, c.model, "sahin"),
    color: pick(CAR_COLORS, c.color, DEFAULT_CAR.color),
    rim: pick(CAR_RIMS, c.rim, DEFAULT_CAR.rim),
    spoiler: pick(CAR_SPOILERS, c.spoiler, DEFAULT_CAR.spoiler),
    decal: pick(CAR_DECALS, c.decal, DEFAULT_CAR.decal),
    neon: pick(CAR_NEONS, c.neon, DEFAULT_CAR.neon),
    lights: pick(CAR_LIGHTS, c.lights, DEFAULT_CAR.lights),
    exhaust: pick(CAR_EXHAUSTS, c.exhaust, DEFAULT_CAR.exhaust),
    engine: pick(CAR_ENGINES, c.engine, DEFAULT_CAR.engine),
    horn: pick(CAR_HORNS, c.horn, DEFAULT_CAR.horn),
    tint: c.tint === true,
    low: c.low === true,
    plate: PLATE.test(plate) ? plate : DEFAULT_CAR.plate,
  };
  // Motorda spoiler, çıkartma, cam filmi, basık süspansiyon olmaz
  if (isBike(out.model)) for (const k of BIKE_NO_MODS) (out as unknown as Record<string, unknown>)[k] = DEFAULT_CAR[k];
  return out;
}

/** Modelin gövdesi: iki dairenin yarıçapı ve merkezden uzaklığı (scooter araba kadar yer kaplamaz). */
export function carHullOf(model: string): { r: number; off: number } {
  return isBike(model) ? { r: 0.42, off: 0.5 } : { r: CAR_HULL_R, off: CAR_HULL_OFFSET };
}

/** Arabanın ön ve arka çarpışma dairelerinin merkezleri (ön x, z, arka x, z); `off` modelin gövdesinden. */
export function carCircles(x: number, z: number, h: number, off = CAR_HULL_OFFSET): [number, number, number, number] {
  const s = Math.sin(h) * off, c = Math.cos(h) * off;
  return [x + s, z + c, x - s, z - c];
}

// ---- Araba radyosu: sürücünün çaldığı şarkı; yakındakiler uzaklığa göre kısılarak duyar ----

/** Çalan şarkı: YouTube videosu, görünen ad ve sunucu saatiyle başladığı an (herkes aynı yerden dinler). */
export interface CarRadio {
  id: string;
  title: string;
  at: number;
}
/** Radyo sırası (sahibine gider): şarkılar, çalan, karıştırma ve tekrar. */
export interface RadioQueueView {
  items: { title: string }[];
  /** Çalan şarkının sıradaki yeri (yoksa −1); çalıyor mu. */
  index: number;
  playing: boolean;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
}
/** Sırada en çok bu kadar şarkı. */
export const RADIO_QUEUE_MAX = 200;
/** Yolcu koltukları (sürücü hariç). */
export const RIDE_SEATS = 3;

/** Bu uzaklıkta radyo susar; yakınlaştıkça ses artar. */
export const RADIO_RANGE = 55;

/** Radyo linki: YouTube videosu ya da Spotify şarkısı; desteklenmiyorsa null. */
export function parseRadioUrl(raw: string): { kind: "youtube" | "spotify"; id: string } | null {
  const text = raw.trim();
  const sp = /^spotify:track:([A-Za-z0-9]{22})$/.exec(text);
  if (sp) return { kind: "spotify", id: sp[1] };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "open.spotify.com") {
    const i = parts.indexOf("track");
    const id = i >= 0 ? parts[i + 1] : null;
    return id && /^[A-Za-z0-9]{22}$/.test(id) ? { kind: "spotify", id } : null;
  }
  let id: string | null = null;
  if (host === "youtube.com" || host === "youtube-nocookie.com") id = url.searchParams.get("v") ?? (["shorts", "live", "embed"].includes(parts[0]) ? parts[1] : null);
  else if (host === "youtu.be") id = parts[0] ?? null;
  return id && /^[\w-]{11}$/.test(id) ? { kind: "youtube", id } : null;
}
