// Eşyalar, dükkânlar ve çanta (RP). Satın alınan yiyecek ve içecekler çantaya girer; çantadan ya da alttaki hızlı
// slottan (1–6, eldeki eşya) kullanılır. Kullanınca açlık/enerji dolar, bazıları süreli etki (buff) verir.
// Gerçekçi: hamur işi ve tuzlu yiyecekler biraz susatır, kahve az susatır; susuzluğu en çok su giderir.
// Bütün fiyat ve etki değerleri burada (tek yerden ayarlanır).

export type ItemCat = "food" | "drink" | "item";
export type BuffId = "kafein" | "enerji" | "tok";

export interface ItemDef {
  name: string;
  /** Kısa emoji (çanta, dükkân kartı). */
  icon: string;
  cat: ItemCat;
  price: number;
  /** Ağırlık (kg) ve bir slotta en çok kaç tane. */
  kg: number;
  stack: number;
  desc: string;
  /** Kullanınca: barlara eklenen ve verdiği etki. */
  use?: { hunger?: number; thirst?: number; energy?: number; hp?: number; buff?: BuffId };
}

export const ITEMS = {
  simit: { name: "Simit", icon: "🥯", cat: "food", price: 15, kg: 0.1, stack: 10, desc: "Taze, susamlı, çıtır. Biraz susatır.", use: { hunger: 15, thirst: -5 } },
  pogaca: { name: "Poğaça", icon: "🥐", cat: "food", price: 20, kg: 0.1, stack: 10, desc: "Peynirli, sıcacık. Biraz susatır.", use: { hunger: 18, thirst: -6 } },
  sandvic: { name: "Sandviç", icon: "🥪", cat: "food", price: 70, kg: 0.3, stack: 5, desc: "Kaşarlı, domatesli.", use: { hunger: 35, thirst: -8 } },
  burger: { name: "Burger menü", icon: "🍔", cat: "food", price: 140, kg: 0.6, stack: 3, desc: "GAP Burger, patates, içecek. Tuzlu ama yanında içeceği var; uzun süre tok tutar.", use: { hunger: 65, thirst: 5, buff: "tok" } },
  cay: { name: "Çay", icon: "🍵", cat: "drink", price: 10, kg: 0.2, stack: 10, desc: "Tavşan kanı, ince belli bardakta.", use: { thirst: 12, energy: 6 } },
  kahve: { name: "Türk kahvesi", icon: "☕", cat: "drink", price: 45, kg: 0.3, stack: 5, desc: "Köpüklü, yanında bir bardak su. Kafein: bir süre hızlı yürürsün.", use: { thirst: 5, energy: 20, buff: "kafein" } },
  enerji: { name: "Enerji içeceği", icon: "🥤", cat: "drink", price: 60, kg: 0.35, stack: 5, desc: "Şekerli ve gazlı. Bir süre koşarken enerjin bitmez.", use: { thirst: 12, energy: 35, buff: "enerji" } },
  su: { name: "Su", icon: "💧", cat: "drink", price: 10, kg: 0.5, stack: 5, desc: "Yarım litre, buz gibi. Susuzluğu en iyi o giderir.", use: { thirst: 40, energy: 2 } },
} satisfies Record<string, ItemDef>;

export type ItemId = keyof typeof ITEMS;

/** Etki satırı (kartlar için): "+15 açlık · −5 su · ☕ %15 hızlı yürürsün". */
export function useText(d: ItemDef): string {
  const u = d.use;
  if (!u) return "";
  const n = (v: number | undefined, what: string) => (v ? `${v > 0 ? "+" : "−"}${Math.abs(v)} ${what}` : "");
  return [n(u.hunger, "açlık"), n(u.thirst, "su"), n(u.energy, "enerji"), u.buff ? `${BUFFS[u.buff].icon} ${BUFFS[u.buff].desc}` : ""].filter(Boolean).join(" · ");
}
export const itemDef = (id: string): ItemDef | undefined => (ITEMS as Record<string, ItemDef>)[id];

/** Süreli etkiler. */
export const BUFFS: Record<BuffId, { name: string; icon: string; ms: number; desc: string }> = {
  kafein: { name: "Kafein", icon: "☕", ms: 5 * 60_000, desc: "%15 hızlı yürürsün" },
  enerji: { name: "Enerji", icon: "⚡", ms: 3 * 60_000, desc: "Koşarken enerjin bitmez" },
  tok: { name: "Tok", icon: "🍔", ms: 10 * 60_000, desc: "Açlığın yarı hızda düşer" },
};
/** Kafeinliyken yürüme hızı çarpanı (sunucunun hız sınırı %30 pay bırakır). */
export const KAFEIN_SPEED = 1.15;

/** Dükkânlar: ne satar. */
export const SHOPS = {
  kahve: { name: "GAP Kahve", icon: "☕", items: ["kahve", "cay", "sandvic", "pogaca", "su"] },
  market: { name: "GAP Market", icon: "🛒", items: ["su", "enerji", "sandvic", "simit", "pogaca"] },
  burger: { name: "GAP Burger", icon: "🍔", items: ["burger", "su", "enerji"] },
  simit: { name: "Simitçi Hüsnü", icon: "🥯", items: ["simit", "pogaca"] },
  cay: { name: "Kahvehane", icon: "🍵", items: ["cay", "kahve", "simit"] },
} satisfies Record<string, { name: string; icon: string; items: ItemId[] }>;

export type ShopId = keyof typeof SHOPS;

/** Çanta: slot sayısı (ilk `hotbar` tanesi alttaki hızlı slot), taşıma sınırı (kg), sepette en çok. */
export const INV = { slots: 30, hotbar: 6, maxKg: 15, cartMax: 20 };

export type Slot = { id: ItemId; n: number } | null;

export const invKg = (slots: Slot[]) => slots.reduce((s, x) => s + (x ? (itemDef(x.id)?.kg ?? 0) * x.n : 0), 0);

/**
 * `id`'den `n` tane ekler (önce aynı eşyalı slotlara, sonra boşlara; hızlı slottan başlar). Sığmazsa ya da çok
 * ağırsa null; yoksa yeni slotlar.
 */
export function addItems(slots: Slot[], id: ItemId, n: number): Slot[] | null {
  const d = itemDef(id);
  if (!d || n <= 0) return null;
  if (invKg(slots) + d.kg * n > INV.maxKg + 1e-9) return null;
  const out = slots.map((s) => (s ? { ...s } : null));
  let left = n;
  for (const s of out) {
    if (!left) break;
    if (s?.id === id && s.n < d.stack) {
      const k = Math.min(left, d.stack - s.n);
      s.n += k;
      left -= k;
    }
  }
  for (let i = 0; i < out.length && left; i++) {
    if (out[i]) continue;
    const k = Math.min(left, d.stack);
    out[i] = { id, n: k };
    left -= k;
  }
  return left ? null : out;
}

/** Sürükle-bırak: aynı eşyaysa birleştir (sığdığı kadar), değilse yer değiştir. */
export function moveSlot(slots: Slot[], from: number, to: number): Slot[] | null {
  if (from === to || !slots[from] || to < 0 || to >= slots.length) return null;
  const out = slots.map((s) => (s ? { ...s } : null));
  const a = out[from]!, b = out[to];
  if (b && b.id === a.id) {
    const k = Math.min(a.n, (itemDef(a.id)?.stack ?? 1) - b.n);
    if (k <= 0) return null;
    b.n += k;
    a.n -= k;
    out[from] = a.n ? a : null;
  } else {
    out[to] = a;
    out[from] = b;
  }
  return out;
}

export const emptyInv = (): Slot[] => Array.from({ length: INV.slots }, () => null);
