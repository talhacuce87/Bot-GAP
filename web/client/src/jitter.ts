// Uzak oyuncuların ne kadar geriden çizileceği: sabit değil, ölçülen ihtiyaca göre.
// İhtiyaç: hareket eden bir oyuncunun yeni örneği geldiği anda, elimizdeki bir önceki en yeni örneğinin yaşı.
// Çizim en az bu kadar geriden yapılırsa o oyuncu hep iki örneğin arasında kalır (donmaz, ileri tahmin gerekmez).
// Gönderenin hattı, sunucunun yayın aralığı ve bizim hattımız bu tek ölçümde toplanır; hat düzelince yavaşça geri iner.
import { INTERP_DELAY_MS, TICK_HZ } from "../../shared/constants";
import type { Remote } from "./avatars/remotes";

/** Gecikme bundan fazla büyümez: hat çok kötüyse ara sıra ileri tahmin, hep çok geride kalmaktan iyidir. */
export const MAX_INTERP_MS = 400;
/** Sunucu ancak her yayında yeni örnek verebilir: bundan aşağısı anlamsız. */
export const MIN_INTERP_MS = 1000 / TICK_HZ;
/** Son 3 sn'lik ölçümlere bakılır. */
const WINDOW_MS = 3000;
/** Hedef en sık bu aralıkla yeniden hesaplanır (pencerede oyuncu sayısı × yayın hızı kadar ölçüm olabilir). */
const RECALC_MS = 250;
/** Bundan az ölçümle hedef değişmez (herkes duruyor, yeni bağlantı). */
const MIN_SAMPLES = 10;
const MARGIN_MS = 10;
/** Gecikme değişirken çizim saati en fazla bu oranda yavaşlar/hızlanır (oyuncular geri sekmesin). */
const GROW = 0.25;
const SHRINK = 0.05;

export class InterpDelay {
  /** Şu an kullanılan gecikme (ms). */
  delay = INTERP_DELAY_MS;
  target = INTERP_DELAY_MS;
  /** Her ihtiyaç ölçümünde (ağ paneli). */
  onNeed: (need: number, now: number) => void = () => {};
  private needs: number[] = [];
  private times: number[] = [];
  private nextCalc = 0;

  /**
   * Snapshot'taki bir oyuncu örneği: uzak oyuncuya yazılır, oyuncu hareket ediyorsa ihtiyaç ölçülür.
   * `arrival`: varış anı (sunucu saati; saat henüz belli değilse NaN), `local`: yerel saat (ms).
   */
  feed(r: Remote, arrival: number, local: number, time: number, x: number, z: number, rot: number, flags: number): void {
    const need = r.moving ? arrival - r.newestTime : NaN;
    if (r.push(time, x, z, rot, flags) && need >= 0) this.arrived(need, local);
  }

  /** Hareket eden oyuncunun yeni örneği geldi: `need` bir öncekinin o anki yaşı (ms), `now` yerel saat (ms). */
  arrived(need: number, now: number): void {
    this.onNeed(need, now);
    this.needs.push(need);
    this.times.push(now);
    if (now >= this.nextCalc) this.recalc(now);
  }

  private recalc(now: number): void {
    this.nextCalc = now + RECALC_MS;
    let old = 0;
    while (old < this.times.length && now - this.times[old] > WINDOW_MS) old++;
    if (old) {
      this.needs.splice(0, old);
      this.times.splice(0, old);
    }
    if (this.needs.length < MIN_SAMPLES) return;
    const sorted = [...this.needs].sort((a, b) => a - b);
    // %95'lik dilim: tek tük çok geç gelen paket gecikmeyi şişirmez (o an ileri tahmin idare eder)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    this.target = Math.min(MAX_INTERP_MS, Math.max(MIN_INTERP_MS, p95 + MARGIN_MS));
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
    this.needs = [];
    this.times = [];
    this.nextCalc = 0;
  }
}
