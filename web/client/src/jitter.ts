// Uzak oyuncuların ne kadar geriden çizileceği: sabit değil, snapshot'ların ne kadar geç geldiğine göre.
// Pingi dalgalı olanda gecikme büyür (oyuncular donup ışınlanmaz), hat düzelince yavaşça geri iner.
import { INTERP_DELAY_MS, TICK_HZ } from "../../shared/constants";

/** Gecikme bundan fazla büyümez: hat çok kötüyse ara sıra donmak, hep çok geride kalmaktan iyidir. */
export const MAX_INTERP_MS = 400;
/** Son ~3 sn'lik snapshot gecikmesine bakılır. */
const WINDOW = 45;
const MARGIN_MS = 10;
/** Gecikme değişirken çizim saati en fazla bu oranda yavaşlar/hızlanır (oyuncular geri sekmesin). */
const GROW = 0.25;
const SHRINK = 0.05;

export class InterpDelay {
  /** Şu an kullanılan gecikme (ms). */
  delay = INTERP_DELAY_MS;
  target = INTERP_DELAY_MS;
  private late: number[] = [];

  /** Snapshot geldi: `lateness` = varış anındaki sunucu saati − snapshot'ın zamanı (ms). */
  arrived(lateness: number): void {
    this.late.push(lateness);
    if (this.late.length > WINDOW) this.late.shift();
    const sorted = [...this.late].sort((a, b) => a - b);
    // %95'lik dilim: tek tük çok geç gelen paket gecikmeyi şişirmez
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    this.target = Math.min(MAX_INTERP_MS, Math.max(INTERP_DELAY_MS, p95 + 1000 / TICK_HZ + MARGIN_MS));
  }

  /** Her kare: gecikmeyi hedefe yumuşakça yaklaştırır ve döndürür. */
  update(dt: number): number {
    const d = this.target - this.delay;
    const step = dt * 1000 * (d > 0 ? GROW : SHRINK);
    this.delay += Math.max(-step, Math.min(step, d));
    return this.delay;
  }

  /** Yeni bağlantı: eski ölçümler (eski saat ofseti) atılır, gecikme olduğu yerden devam eder. */
  reset(): void {
    this.late = [];
  }
}
