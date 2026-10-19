// Adaptif render ölçeği: kare düşmeye başlayınca çözünürlüğü indirir, uzun süre sorunsuzsa geri çıkarır.
// Yükseltme hemen ardından tekrar düşüş getirirse o seviye tavan olarak kilitlenir (salınım olmasın).
import type * as THREE from "three";

const WINDOW = 60;
const DROP_MS = 20; // 60 Hz'de bir kare kaçırıldı sayılır
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

  constructor(
    private renderer: THREE.WebGLRenderer,
    private baseDpr: number,
    private adaptive: boolean,
  ) {
    this.apply();
  }

  private apply(): void {
    this.renderer.setPixelRatio(this.baseDpr * this.scale);
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

    if (!this.adaptive) return;
    this.frames++;
    if (dtMs > DROP_MS) this.dropped++;
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
