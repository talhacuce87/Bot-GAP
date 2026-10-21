// Ağ panelinin verisi: ping (hızlı yol ve WebSocket), kayıp, dalgalanma, çizim gecikmesi ve ihtiyacı, bant genişliği.
// Ölçümler zaman damgalı halka tamponlarda (son 60 sn) birikir; panel kapalıyken de tutulur, az yer kaplar.

/** Grafiklerin geriye baktığı süre (ms). */
export const SPAN_MS = 60_000;
/** İhtiyaç ölçümleri bu dilimlerde toplanır (en büyüğü): oyuncu sayısı × yayın hızı kadar ölçüm gelir. */
export const NEED_BUCKET_MS = 500;
/** Kayıp oranı bu kadar süreye bakar. */
const LOSS_WINDOW_MS = 30_000;
/** Bu sürede cevabı gelmeyen ping kaybolmuş sayılır. */
const LOST_AFTER_MS = 2000;
/** Çizim gecikmesi saniyede bu kadar kez örneklenir. */
const DELAY_HZ = 10;

export interface Summary {
  now: number;
  avg: number;
  min: number;
  max: number;
}

/** Zaman damgalı ölçümler; sığmayan en eskiler düşer. */
export class Series {
  private t: Float64Array;
  private v: Float32Array;
  private head = 0;
  private n = 0;

  constructor(private cap: number) {
    this.t = new Float64Array(cap);
    this.v = new Float32Array(cap);
  }

  push(t: number, v: number): void {
    this.t[this.head] = t;
    this.v[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }

  get size(): number {
    return this.n;
  }

  /** Eskiden yeniye, `since` ve sonrasındaki ölçümler. */
  each(since: number, fn: (t: number, v: number) => void): void {
    const start = (this.head - this.n + this.cap) % this.cap;
    for (let k = 0; k < this.n; k++) {
      const i = (start + k) % this.cap;
      if (this.t[i] >= since) fn(this.t[i], this.v[i]);
    }
  }

  /** En yeni ölçüm (yoksa NaN). */
  last(): number {
    return this.n ? this.v[(this.head - 1 + this.cap) % this.cap] : NaN;
  }

  lastTime(): number {
    return this.n ? this.t[(this.head - 1 + this.cap) % this.cap] : NaN;
  }

  /** Son `k` ölçümün ortancası (yoksa NaN). */
  median(k: number): number {
    const m = Math.min(k, this.n);
    if (!m) return NaN;
    const a: number[] = [];
    for (let j = 1; j <= m; j++) a.push(this.v[(this.head - j + this.cap) % this.cap]);
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
  }

  /** `t`'ye en yakın ölçüm, `within` ms'den uzaksa NaN. */
  nearest(t: number, within: number): number {
    let best = NaN;
    let bestD = within;
    this.each(t - within, (ti, v) => {
      const d = Math.abs(ti - t);
      if (d <= bestD) {
        bestD = d;
        best = v;
      }
    });
    return best;
  }

  /** `since` ve sonrasının özeti; ölçüm yoksa null. */
  summary(since: number): Summary | null {
    let n = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let now = NaN;
    this.each(since, (_t, v) => {
      n++;
      sum += v;
      min = Math.min(min, v);
      max = Math.max(max, v);
      now = v;
    });
    return n ? { now, avg: sum / n, min, max } : null;
  }
}

export interface Rates {
  udp: number;
  ws: number;
}

export class NetStats {
  /** Panel açık: hızlı yol daha sık ölçülür (grafik akıcı olsun). */
  live = false;
  readonly udp = new Series(512);
  readonly ws = new Series(64);
  readonly delay = new Series(SPAN_MS / (1000 / DELAY_HZ) + 16);
  /** 500 ms'lik dilimlerde, hareket eden bir oyuncunun yeni örneği geldiğinde bir öncekinin en büyük yaşı. */
  readonly needMax = new Series(SPAN_MS / NEED_BUCKET_MS + 4);
  /** Saniyede gelen/giden bayt (yük; başlıklar hariç), hareket eden biri beklenirken geçen karelerin oranı, snapshot/sn. */
  readonly bytesIn = new Series(64);
  readonly bytesOut = new Series(64);
  readonly starve = new Series(64);
  readonly snapshots = new Series(64);
  /** Son saniyenin hızları (B/sn), kanala göre. */
  rateIn: Rates = { udp: 0, ws: 0 };
  rateOut: Rates = { udp: 0, ws: 0 };
  /** Hızlı yol ping'inin dalgalanması (ms; ardışık ölçümlerin farkı, RFC 3550 gibi yumuşatılmış). */
  jitter = NaN;
  /** Son 30 sn'de cevapsız kalan hızlı yol ping'lerinin oranı (ölçüm yoksa NaN). */
  loss = NaN;

  private inNow: Rates = { udp: 0, ws: 0 };
  private outNow: Rates = { udp: 0, ws: 0 };
  private snapsNow = 0;
  private sec = NaN;
  private nextDelay = 0;
  private frames = NaN;
  private starved = 0;
  private bucket = NaN;
  private bucketMax = 0;
  private pending = new Map<number, number>();
  private outcomes = new Series(512);

  received(bytes: number, udp: boolean): void {
    this.inNow[udp ? "udp" : "ws"] += bytes;
  }

  sent(bytes: number, udp: boolean): void {
    this.outNow[udp ? "udp" : "ws"] += bytes;
  }

  snapshot(): void {
    this.snapsNow++;
  }

  pingSent(seq: number, now: number): void {
    this.pending.set(seq, now);
  }

  /** Hızlı yol ping'inin cevabı (geç kalmış, kayıp sayılmış cevap yok sayılır). */
  pong(seq: number, rtt: number, now: number): void {
    const sent = this.pending.get(seq);
    if (sent === undefined) return;
    this.pending.delete(seq);
    this.outcomes.push(sent, 0);
    const prev = this.udp.last();
    if (Number.isFinite(prev)) {
      const d = Math.abs(rtt - prev);
      this.jitter = Number.isFinite(this.jitter) ? this.jitter + (d - this.jitter) / 16 : d;
    }
    this.udp.push(now, rtt);
  }

  wsPong(rtt: number, now: number): void {
    this.ws.push(now, rtt);
  }

  need(need: number, now: number): void {
    const b = Math.floor(now / NEED_BUCKET_MS) * NEED_BUCKET_MS;
    if (b !== this.bucket) {
      if (Number.isFinite(this.bucket)) this.needMax.push(this.bucket, this.bucketMax);
      this.bucket = b;
      this.bucketMax = 0;
    }
    this.bucketMax = Math.max(this.bucketMax, need);
  }

  /** Henüz kapanmamış dilim (grafikte en sağdaki sütun). */
  openBucket(): { t: number; v: number } | null {
    return Number.isFinite(this.bucket) ? { t: this.bucket, v: this.bucketMax } : null;
  }

  /** Her kare: çizim gecikmesi örneği ve saniyelik toplamlar. `frames`/`starved`: Remotes'un toplam sayaçları. */
  tick(now: number, delay: number, frames: number, starved: number): void {
    if (now >= this.nextDelay) {
      this.nextDelay = now + 1000 / DELAY_HZ;
      this.delay.push(now, delay);
    }
    if (Number.isNaN(this.sec)) {
      this.sec = now;
      this.frames = frames;
      this.starved = starved;
      return;
    }
    if (now - this.sec < 1000) return;
    const k = 1000 / (now - this.sec);
    this.sec = now;
    this.rateIn = { udp: this.inNow.udp * k, ws: this.inNow.ws * k };
    this.rateOut = { udp: this.outNow.udp * k, ws: this.outNow.ws * k };
    this.bytesIn.push(now, this.rateIn.udp + this.rateIn.ws);
    this.bytesOut.push(now, this.rateOut.udp + this.rateOut.ws);
    this.snapshots.push(now, this.snapsNow * k);
    this.inNow = { udp: 0, ws: 0 };
    this.outNow = { udp: 0, ws: 0 };
    this.snapsNow = 0;
    const df = frames - this.frames;
    this.starve.push(now, df > 0 ? (starved - this.starved) / df : 0);
    this.frames = frames;
    this.starved = starved;
    for (const [seq, sent] of this.pending) {
      if (now - sent < LOST_AFTER_MS) continue;
      this.pending.delete(seq);
      this.outcomes.push(sent, 1);
    }
    const o = this.outcomes.summary(now - LOSS_WINDOW_MS);
    this.loss = o ? o.avg : NaN;
  }

  /** Hızlı yol kapandı: bekleyen ping'ler kayıp sayılmaz (yol yok). */
  dropPending(): void {
    this.pending.clear();
  }
}
