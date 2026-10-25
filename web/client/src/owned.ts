// Satın aldıkların (sunucu söyler: "owned"): gardırop, araba menüsü, tuning ve galeri buradan bakar.
import { itemPrice } from "../../shared/shop";

const items = new Set<string>();
const listeners = new Set<() => void>();

export const owned = {
  /** Senin mi (bedava olanlar hep senin). */
  has(item: string): boolean {
    return items.has(item) || (itemPrice(item) ?? 0) === 0;
  },
  set(list: string[]): void {
    items.clear();
    for (const i of list) items.add(i);
    for (const fn of listeners) fn();
  },
  /** Değişince haber ver; bırakmak için dönen fonksiyonu çağır. */
  on(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
