// Render ölçeği: ayarda sabit (%100/%77/...) ya da "Otomatik": kare düşmeye başlayınca çözünürlüğü indirir,
// uzun süre sorunsuzsa geri çıkarır. Yükseltme hemen ardından tekrar düşüş getirirse o seviye tavan olarak
// kilitlenir (salınım olmasın). `upscale` açıkken tuval tam çözünürlükte kalır, ölçeği çizim (FSR benzeri
// büyütme) uygular; kapalıyken piksel oranı düşer, tarayıcı büyütür.
import type * as THREE from "three";

const WINDOW = 60;
const DROP_MS = 20; // 60 Hz'de bir kare kaçırıldı sayılır (kare sınırı varsa ona göre genişler)
const MIN_SCALE = 0.6;
const STEP_DOWN = 0.15;
const STEP_UP = 0.1;
const STABLE_WINDOWS_TO_UP = 6; // ~6 sn
const REGRET_WINDOWS = 4; // yükseltmeden sonra bu kadar pencerede düşerse tavan

export interface PerfStats {
  fps: number;
  frameMs: number;
  cpuMs: number;
  scale: number;
  calls: number;
  triangles: number;
}

export class PerfGovernor {
  scale = 1;
  readonly stats: PerfStats = { fps: 0, frameMs: 0, cpuMs: 0, scale: 1, calls: 0, triangles: 0 };

  private ceiling = 1;
  private frames = 0;
  private dropped = 0;
  private stable = 0;
  private sinceUp = Infinity;
  private statFrames = 0;
  private statTime = 0;
  private statCpu = 0;
  private dropMs = DROP_MS;

  /** Ayardaki sabit ölçek; 0 = otomatik. */
  private fixed = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private baseDpr: number,
    private upscale = false,
  ) {
    this.apply();
  }

  /**
   * Ayardan: en yüksek piksel oranı, kare sınırı (0 = yok) ve render ölçeği (0 = otomatik).
   * Piksel oranı ya da ölçek ayarı değişince ölçek ve tavan baştan başlar.
   */
  configure(baseDpr: number, fpsCap: number, renderScale = 0): void {
    this.dropMs = fpsCap ? Math.max(DROP_MS, (1000 / fpsCap) * 1.25) : DROP_MS;
    if (baseDpr === this.baseDpr && renderScale === this.fixed) return;
    this.baseDpr = baseDpr;
    this.fixed = renderScale;
    this.scale = renderScale || 1;
    this.ceiling = 1;
    this.frames = this.dropped = this.stable = 0;
    this.apply();
  }

  private apply(): void {
    const pr = this.upscale ? this.baseDpr : this.baseDpr * this.scale;
    if (this.renderer.getPixelRatio() !== pr) this.renderer.setPixelRatio(pr);
    this.stats.scale = this.scale;
  }

  /** Her kare sonunda: `dtMs` kare aralığı, `cpuMs` bu karede JS + render komutları süresi. */
  frame(dtMs: number, cpuMs: number): void {
    // Arka plandan dönüş gibi uç değerler ölçümü bozmasın.
    if (dtMs > 250) return;
    const info = this.renderer.info.render;
    this.stats.calls = info.calls;
    this.stats.triangles = info.triangles;

    this.statFrames++;
    this.statTime += dtMs;
    this.statCpu += cpuMs;
    if (this.statTime >= 500) {
      this.stats.fps = (this.statFrames * 1000) / this.statTime;
      this.stats.frameMs = this.statTime / this.statFrames;
      this.stats.cpuMs = this.statCpu / this.statFrames;
      this.statFrames = 0;
      this.statTime = 0;
      this.statCpu = 0;
    }

    if (this.fixed) return;
    this.frames++;
    if (dtMs > this.dropMs) this.dropped++;
    if (this.frames < WINDOW) return;

    const bad = this.dropped >= WINDOW * 0.1;
    this.sinceUp++;
    if (bad) {
      this.stable = 0;
      if (this.sinceUp <= REGRET_WINDOWS) this.ceiling = Math.max(MIN_SCALE, this.scale - STEP_UP);
      if (this.scale > MIN_SCALE) {
        this.scale = Math.max(MIN_SCALE, +(this.scale - STEP_DOWN).toFixed(2));
        this.apply();
      }
    } else if (this.dropped === 0) {
      this.stable++;
      if (this.stable >= STABLE_WINDOWS_TO_UP && this.scale < this.ceiling) {
        this.scale = Math.min(this.ceiling, +(this.scale + STEP_UP).toFixed(2));
        this.stable = 0;
        this.sinceUp = 0;
        this.apply();
      }
    } else {
      this.stable = 0;
    }
    this.frames = this.dropped = 0;
  }
}

/** Kare sınırı: ekran daha hızlı yeniliyorsa araya kare atlar. `ready` false ise bu kare çizilmez. */
export class FrameLimiter {
  private lastDraw = -Infinity;

  ready(now: number, fpsCap: number): boolean {
    if (!fpsCap) return true;
    const interval = 1000 / fpsCap;
    const since = now - this.lastDraw;
    // 1 ms pay: yenileme hızının tam katlarında kare kaçmasın
    if (since < interval - 1) return false;
    this.lastDraw = since > interval * 3 ? now : this.lastDraw + interval * Math.floor(since / interval);
    return true;
  }
}
