// Tofaş: oyuncunun kendi arabası. Sürerken konumu normal oyuncu konumudur (araba merkezi, yön `rot`);
// kim hangi arabada (model, renk, jant…) oyuncu bilgisinde taşınır ve sunucu doğrular.

export const CAR_MODELS = [
  { id: "sahin", name: "Şahin" },
  { id: "dogan", name: "Doğan SLX" },
  { id: "kartal", name: "Kartal" },
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

type Id<T extends readonly { id: string }[]> = T[number]["id"];

export interface CarSpec {
  model: Id<typeof CAR_MODELS>;
  color: Id<typeof CAR_COLORS>;
  rim: Id<typeof CAR_RIMS>;
  spoiler: Id<typeof CAR_SPOILERS>;
  decal: Id<typeof CAR_DECALS>;
  neon: Id<typeof CAR_NEONS>;
  lights: Id<typeof CAR_LIGHTS>;
  exhaust: Id<typeof CAR_EXHAUSTS>;
  /** Koyu cam filmi. */
  tint: boolean;
  /** Basık süspansiyon. */
  low: boolean;
  /** Plaka yazısı (büyük harf, rakam, boşluk; en çok 10). */
  plate: string;
}

export const DEFAULT_CAR: CarSpec = { model: "sahin", color: "beyaz", rim: "celik", spoiler: "yok", decal: "yok", neon: "yok", lights: "standart", exhaust: "standart", tint: false, low: false, plate: "34 GAP 34" };

/** Park halindeki araba: indiğin yerde kalır, herkes görür (yalnızca sahibi biner). */
export interface ParkedCar {
  car: CarSpec;
  x: number;
  z: number;
  rot: number;
}
/** Arabayı bu kadar uzağa park edebilir/çağırabilirsin (sunucu, oyuncunun konumuna göre). */
export const PARK_REACH = 10;
/** Park halindeki arabaya binmek için arabanın orta eksenine en çok bu kadar yakın olmalı (yandan ~2 m). */
export const ENTER_REACH = 3;

/** Sunucunun kabul ettiği en yüksek araba hızı (m/sn, takip toleransıyla). */
export const CAR_MAX_SPEED = 19;
/** İstemcide ileri ve geri en yüksek hız, ivmeler, dönüş. */
export const CAR_SPEED = 16;
export const CAR_REVERSE = 5;
export const CAR_ACCEL = 7;
export const CAR_BRAKE = 16;
export const CAR_TURN = 1.7;
/** Çarpışma: gövde boyunca iki daire (merkezden ±OFFSET, yarıçap R). */
export const CAR_HULL_R = 0.92;
export const CAR_HULL_OFFSET = 1.15;

const PLATE = /^[0-9A-ZÇĞİÖŞÜ ]{1,10}$/;

function pick<T extends readonly { id: string }[]>(list: T, v: unknown, def: Id<T>): Id<T> {
  return typeof v === "string" && list.some((o) => o.id === v) ? (v as Id<T>) : def;
}

/** İstemciden gelen arabayı doğrular: geçersiz alanlar varsayılana döner; nesne değilse null (arabadan in). */
export function validCar(v: unknown): CarSpec | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  const plate = typeof c.plate === "string" ? c.plate.toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim().slice(0, 10) : "";
  return {
    model: pick(CAR_MODELS, c.model, DEFAULT_CAR.model),
    color: pick(CAR_COLORS, c.color, DEFAULT_CAR.color),
    rim: pick(CAR_RIMS, c.rim, DEFAULT_CAR.rim),
    spoiler: pick(CAR_SPOILERS, c.spoiler, DEFAULT_CAR.spoiler),
    decal: pick(CAR_DECALS, c.decal, DEFAULT_CAR.decal),
    neon: pick(CAR_NEONS, c.neon, DEFAULT_CAR.neon),
    lights: pick(CAR_LIGHTS, c.lights, DEFAULT_CAR.lights),
    exhaust: pick(CAR_EXHAUSTS, c.exhaust, DEFAULT_CAR.exhaust),
    tint: c.tint === true,
    low: c.low === true,
    plate: PLATE.test(plate) ? plate : DEFAULT_CAR.plate,
  };
}

/** Arabanın ön ve arka çarpışma dairelerinin merkezleri (ön x, z, arka x, z). */
export function carCircles(x: number, z: number, h: number): [number, number, number, number] {
  const s = Math.sin(h) * CAR_HULL_OFFSET, c = Math.cos(h) * CAR_HULL_OFFSET;
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
