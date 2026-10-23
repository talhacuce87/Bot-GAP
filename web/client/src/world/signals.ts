// Şehrin trafik lambaları: herkeste aynı (sunucu saatiyle) döner; NPC arabalar da buna göre durur.
// 12 sn döngü: yatay caddeler (x boyunca gidenler, grup 0) 0–5 yeşil, 5–6.5 sarı, sonra kırmızı; dikey (grup 1) 6 sn kaymış.

export const SIGNAL_CYCLE = 12;
const GREEN = 5;
const YELLOW = 6.5;

/** Ortak saat (sunucu, ms): Features her kare yazar. Yazılmadıysa yerel saat. */
export const signalClock = { ms: 0 };

/** Yanan lamba: 0 kırmızı, 1 sarı, 2 yeşil. `t` saniye. */
export function signalLamp(t: number, group: 0 | 1): 0 | 1 | 2 {
  const u = (((t + (group ? 6 : 0)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return u < GREEN ? 2 : u < YELLOW ? 1 : 0;
}

/** Şu anki ortak saat (sn). */
export function signalNow(): number {
  return (signalClock.ms || Date.now()) / 1000;
}

/** Grubun yeşilinin başladığı an (döngü içinde, sn). */
export function greenStart(group: 0 | 1): number {
  return group ? SIGNAL_CYCLE - 6 : 0;
}
