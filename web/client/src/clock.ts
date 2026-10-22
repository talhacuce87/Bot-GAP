// Zamanlama: sunucu saati tahmini (NTP benzeri) ve değişken kare süresinden sabit hızda gönderim.
// Sunucu saati her oyuncunun konumuna damga olarak gider; saat sıçrarsa uzak oyuncular da sıçrar ve
// gönderilen örnek zamanları geriye gider. Bu yüzden yeni ölçüm bir anda değil, yavaşça uygulanır.

/** Son bu kadar süredeki pong'lara bakılır (ölçüm sıklığından bağımsız: ağ paneli açıkken hızlı yol sık ölçer). */
const WINDOW_MS = 12_000;
const MAX_SAMPLES = 64;
/** Saat düzeltilirken en fazla bu oranda hızlanır/yavaşlar (20 ms'lik düzeltme 0,4 sn sürer). */
export const SLEW = 0.05;
/** Bundan büyük düzeltme beklemeden uygulanır (sayfanın ilk ölçümü, uzun kopukluk sonrası). */
export const JUMP_MS = 250;

export class ServerClock {
  private cur = 0;
  private target = 0;
  private at = 0;
  private started = false;
  private samples: { rtt: number; offset: number; at: number }[] = [];

  /** Bu bağlantıda en az bir ölçüm var. */
  get synced(): boolean {
    return this.samples.length > 0;
  }

  /**
   * Pong geldi; RTT'yi döndürür. Yerel saatle: `sent` ping'in gönderildiği, `received` pong'un geldiği an.
   * `server`: sunucunun cevapladığı an. En düşük RTT'li ölçümün ofseti en güvenilirdir.
   */
  sample(sent: number, server: number, received: number): number {
    const rtt = received - sent;
    this.samples.push({ rtt, offset: server - (sent + rtt / 2), at: received });
    while (this.samples.length > MAX_SAMPLES || received - this.samples[0].at > WINDOW_MS) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offsetAt(received);
    this.target = best.offset;
    if (!this.started || Math.abs(this.target - this.cur) > JUMP_MS) this.cur = this.target;
    this.started = true;
    return rtt;
  }

  /** `local` anındaki ofset (sunucu − yerel, ms); düzeltme o ana kadar yürütülür. */
  offsetAt(local: number): number {
    if (local > this.at) {
      const step = (local - this.at) * SLEW;
      this.cur += Math.max(-step, Math.min(step, this.target - this.cur));
      this.at = local;
    }
    return this.cur;
  }

  /** Henüz uygulanmamış düzeltme (ms): yavaşça kapanıyor. */
  get pending(): number {
    return this.target - this.cur;
  }

  /** `local` anındaki tahmini sunucu saati; büyük düzeltme dışında hep ileri gider. */
  now(local: number): number {
    return local + this.offsetAt(local);
  }

  /** Yeni bağlantı: ölçümler atılır, saat olduğu yerden devam eder (yeni ölçüm yakınsa yavaşça oturur). */
  reset(): void {
    this.samples = [];
  }
}

/** Değişken kare süresinden sabit hızda tetik: artan süre bir sonrakine kalır, uzun takılmadan sonra birikmez. */
export class Pacer {
  private acc = 0;

  constructor(private readonly hz: number) {}

  /** Her kare çağrılır; bu karede sıra geldiyse true. */
  due(dt: number): boolean {
    this.acc += dt;
    if (this.acc < 1 / this.hz) return false;
    this.acc %= 1 / this.hz;
    return true;
  }
}
