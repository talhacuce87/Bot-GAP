// Sabit adımlı benzetim: NPC'lerin kararları (yol verme, bekleme, ürkme) kare hızından bağımsız saniyede ~30 kez
// hesaplanır, çizim her kare son iki adımın arasından ara değerle yapılır. 240 fps'te de benzetim 30 kez çalışır.

/** Adım süresi (sn). */
export const SIM_STEP = 1 / 30;

export class FixedStep {
  private acc = 0;
  /** Son adımın süresi (birleşik adımda birkaç adım). */
  private span: number;

  constructor(readonly step = SIM_STEP) {
    this.span = step;
  }

  /**
   * Karenin süresini biriktirir; bu kare benzetim adımı atılacaksa süresini (sn), yoksa 0 döner. Kare adımdan
   * uzunsa birikenler tek adımda atılır (yavaş cihazda kare başına en çok bir benzetim).
   */
  advance(dt: number): number {
    this.acc += Math.max(0, dt);
    if (this.acc < this.step) return 0;
    const n = Math.floor(this.acc / this.step);
    this.acc -= n * this.step;
    // Sekme arka plandaydı: geçen koca süre tek adımda (çizelgeler sunucu saatinden, kayma birikmez)
    this.span = Math.min(n * this.step, 0.25);
    return this.span;
  }

  /** Çizimin son iki adım arasındaki yeri (0 önceki, 1 son adım): adımdan bu yana geçen süre kadar. */
  get alpha(): number {
    return Math.min(1, Math.max(0, 1 - (this.step - this.acc) / this.span));
  }
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Açıların arası en kısa yoldan (±π'de sıçramaz). */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}
