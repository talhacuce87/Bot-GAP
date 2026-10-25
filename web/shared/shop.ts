// Mağazalar (RP, Faz 4): kıyafet ve saç (berber, GAP Moda), arabalar (GAP Galeri) ve modifiyeler (GAP Garaj)
// paralıdır; bir kez alınan senindir. Her kategoride basit bir başlangıç seti bedava, Şahin/Doğan/Kartal bedava;
// seviye ödülü kıyafetler (botun kilitledikleri) satılmaz, seviyeyle açılır. Bütün fiyatlar burada.
//
// Sahip olunanlar dize anahtarlarla saklanır: "look:<parça>", "car:<model>", "mod:<model>:<alan>:<değer>".
import { CAR_MODELS, type CarModel, type CarSpec, DEFAULT_CAR, isBike } from "./car";

/** Kıyafet ve saç fiyatları (₺); listede olmayan parça bedava (başlangıç seti ya da seviye ödülü). */
export const LOOK_PRICES: Record<string, number> = {
  // Üst
  top_bikini: 700, top_bomber: 1800, top_crop: 900, top_deri: 3500, top_ekose: 1200, top_elbise: 2200,
  top_forma_barca: 1500, top_forma_bm: 1500, top_forma_milli: 1500, top_forma_sb: 1500, top_forma_sk: 1500, top_forma_sl: 1500,
  top_gelinlik: 5000, top_hakem: 1200, top_hoodie: 1400, top_ittihat: 1500, top_kazak: 1100, top_kolsuz: 600, top_kot_ceket: 2000,
  top_mont: 2600, top_sisme: 2800, top_smokin: 4500, top_takim: 4000, top_uniforma: 2400, top_yeniceri: 3000,
  // Alt
  bottom_bikini_alt: 500, bottom_etek: 900, bottom_forma_sort_barca: 700, bottom_forma_sort_bm: 700, bottom_forma_sort_milli: 700,
  bottom_forma_sort_sb: 700, bottom_forma_sort_sk: 700, bottom_forma_sort_sl: 700, bottom_hakem_sort: 600, bottom_kargo: 1100,
  bottom_kumas: 1300, bottom_salvar: 1600, bottom_smokin_alt: 2500, bottom_uniforma_alt: 1500,
  // Saç (berber)
  hair_ayrik: 300, hair_boxer: 300, hair_fauxhawk: 600, hair_hacimli_geri: 500, hair_joleli: 400, hair_kase: 300, hair_kivircik: 400,
  hair_kornrow: 800, hair_orgu: 600, hair_pompadour: 700, hair_rasta: 900, hair_topuz_orgu: 600, hair_twist: 700, hair_ucgen: 500,
  hair_uzun_kivircik: 600, hair_yan_kakul: 400,
  // Sakal (berber)
  facial_burma: 400, facial_kecisakal: 300, facial_pala: 500, facial_tamsakal: 300, facial_uzunsakal: 600,
  // Ayakkabı
  shoes_basket: 1200, shoes_bot: 1500, shoes_cizme: 1800, shoes_klasik: 1400, shoes_krampon: 1000, shoes_topuklu: 1600,
  // Şapka
  hat_asker: 800, hat_bere: 500, hat_bork: 1200, hat_duvak: 1500, hat_fes: 900, hat_insaat: 600, hat_kalpak: 1400, hat_kep_ters: 300,
  hat_motor: 1000, hat_sarik: 1100, hat_silindir: 2000,
  // Gözlük
  glasses_kalin: 500, glasses_kalp: 700, glasses_monokl: 1200, glasses_pilot: 900, glasses_spor: 600,
};

/** Hangi dükkânda satılır: saç ve sakal berberde, gerisi GAP Moda'da. */
export const lookShop = (id: string): "barber" | "fashion" => (id.startsWith("hair_") || id.startsWith("facial_") ? "barber" : "fashion");

/** Araba fiyatları (₺): ilk üçü bedava. */
export const CAR_PRICES: Record<(typeof CAR_MODELS)[number]["id"], number> = {
  sahin: 0, dogan: 0, kartal: 0, doblo: 25_000, linea: 32_000, passat: 55_000, e30: 85_000, scooter: 1_000,
};

/** Modifiye fiyat çarpanı: motorlarda parçalar yarı fiyat (50 ₺'ye yuvarlanır). */
const modScale = (model: string) => (isBike(model) ? 0.5 : 1);

/** Modifiye fiyatları (₺, araba başına bir kez): alan → değer → fiyat; varsayılan değer bedava. */
export const MOD_PRICES: Partial<Record<keyof CarSpec, Record<string, number>>> = {
  color: { kirmizi: 1000, siyah: 1000, lacivert: 1000, bej: 1000, gri: 1000, taksi: 1000, yesil: 1000, turuncu: 1000, mor: 1000, bebek: 1000, pembe: 1000 },
  rim: { spor: 3000, altin: 6000, siyah: 3500 },
  spoiler: { kucuk: 2500, buyuk: 4500 },
  decal: { serit: 1500, alev: 3000, dama: 1500 },
  neon: { mavi: 4000, pembe: 4000, yesil: 4000, kirmizi: 4000, mor: 4000, turuncu: 4000, sari: 4000, turkuaz: 4000, beyaz: 4000, siyah: 5000 },
  lights: { xenon: 1500, sari: 1500 },
  exhaust: { cift: 2000, spor: 4000 },
  engine: { chip: 5000, turbo: 12_000, yaris: 20_000 },
  horn: { dolmus: 1000, kamyon: 1500, cucaracha: 2000, dugun: 2000 },
};
/** Açık/kapalı modifiyeler (true olunca ücretli). */
export const MOD_FLAG_PRICES: Partial<Record<keyof CarSpec, number>> = { tint: 2000, low: 3000 };

export const lookItem = (id: string) => `look:${id}`;
export const carItem = (m: string) => `car:${m}`;
export const modItem = (m: string, field: string, value: string | boolean) => `mod:${m}:${field}:${value}`;

/** Bir öğenin fiyatı (bedavaysa 0; bilinmiyorsa null). */
export function itemPrice(item: string): number | null {
  const [kind, a, b, c] = item.split(":");
  if (kind === "look") return a ? (LOOK_PRICES[a] ?? 0) : null;
  if (kind === "car") return a in CAR_PRICES ? CAR_PRICES[a as keyof typeof CAR_PRICES] : null;
  if (kind === "mod" && a in CAR_PRICES) {
    const field = b as keyof CarSpec;
    const scaled = (p: number) => Math.round((p * modScale(a)) / 50) * 50;
    if (field in MOD_FLAG_PRICES) return c === "true" ? scaled(MOD_FLAG_PRICES[field] ?? 0) : null;
    const t = MOD_PRICES[field];
    if (!t) return null;
    if (c === String(DEFAULT_CAR[field])) return 0;
    return c in t ? scaled(t[c]) : null;
  }
  return null;
}

/** Arabanın sahip olunmayan (ücretli) parçaları: modifiye anahtarları. */
export function unownedMods(spec: CarSpec, owns: (item: string) => boolean): string[] {
  const out: string[] = [];
  for (const f of Object.keys(MOD_PRICES) as (keyof CarSpec)[]) {
    const v = spec[f];
    if (v === DEFAULT_CAR[f]) continue;
    const item = modItem(spec.model, f, v as string);
    if ((itemPrice(item) ?? 0) > 0 && !owns(item)) out.push(item);
  }
  for (const f of Object.keys(MOD_FLAG_PRICES) as (keyof CarSpec)[]) {
    if (spec[f] !== true) continue;
    const item = modItem(spec.model, f, true);
    if (!owns(item)) out.push(item);
  }
  return out;
}

/** Sahip olunmayan modifiyeleri varsayılana döndürür (sunucu: satın alınmamış parçayla gezilmez). */
export function stripUnowned(spec: CarSpec, owns: (item: string) => boolean): CarSpec {
  const out = { ...spec };
  for (const item of unownedMods(spec, owns)) {
    const field = item.split(":")[2] as keyof CarSpec;
    (out as Record<string, unknown>)[field] = DEFAULT_CAR[field];
  }
  return out;
}

export const ownsCar = (model: CarModel, owns: (item: string) => boolean) => !(model in CAR_PRICES) || CAR_PRICES[model as keyof typeof CAR_PRICES] === 0 || owns(carItem(model));

/** Öğenin satıştaki adı (cüzdan geçmişi için). */
export function itemLabel(item: string): string {
  const [kind, a, b, c] = item.split(":");
  if (kind === "car") return CAR_MODELS.find((m) => m.id === a)?.name ?? a;
  if (kind === "mod") return `${CAR_MODELS.find((m) => m.id === a)?.name ?? a} · ${b} ${c === "true" ? "" : c}`.trim();
  return a;
}
