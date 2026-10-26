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

/** Bir takılma: kare süresi ve nerede uzadığı. */
export interface Hitch {
  /** Önceki kareden bu yana geçen süre (ms). */
  dt: number;
  /** Bu karede JS'in simülasyon ve çizim komutları süreleri; dt'den çok küçükse bekleme ekran kartında ya da tarayıcıda (GC, derleme). */
  sim: number;
  draw: number;
  /** Bu karede yeni derlenen shader programı, kurulan geometri ve doku sayısı. */
  programs: number;
  geometries: number;
  textures: number;
  /** Aynı anda tarayıcının bildirdiği uzun görev süresi (0 yok): ana iş parçacığı kilitlendi, GC ya da yükleme. */
  long: number;
  at: number;
}

const HITCH_MS = 45;
const KEEP = 40;

/**
 * Takılma kaydı: `HITCH_MS`'yi aşan kareleri ve nedenini ipuçlarıyla saklar (yalnızca ölçüm, davranışı değiştirmez).
 * Konsolda `gapHitches()` ya da debug göstergesinde son takılma görünür.
 */
export class HitchLog {
  readonly list: Hitch[] = [];
  total = 0;
  private programs = 0;
  private geometries = 0;
  private textures = 0;
  private lastLong = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    // Tarayıcının "uzun görev"i (50 ms+ ana iş parçacığı kilidi): GC ve doku/shader yüklemesi de burada görünür
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (this.lastLong = e.duration))).observe({ entryTypes: ["longtask"] });
    } catch {
      /* desteklenmiyor */
    }
  }

  /** Her kare sonunda; arka plandan dönüş gibi uç değerleri (>1 sn) yok sayar. */
  frame(dt: number, sim: number, draw: number): void {
    const info = this.renderer.info;
    const programs = info.programs?.length ?? 0;
    const { geometries, textures } = info.memory;
    if (dt > HITCH_MS && dt < 1000) {
      this.total++;
      this.list.push({ dt, sim, draw, programs: programs - this.programs, geometries: geometries - this.geometries, textures: textures - this.textures, long: this.lastLong, at: performance.now() });
      this.lastLong = 0;
      if (this.list.length > KEEP) this.list.shift();
    }
    this.programs = programs;
    this.geometries = geometries;
    this.textures = textures;
  }

  /** Son takılmanın tek satırı: `83 ms (sim 3, çizim 70, +2 shader)`. */
  describe(): string {
    const h = this.list[this.list.length - 1];
    if (!h) return "takılma yok";
    const hint = [h.programs > 0 && `+${h.programs} shader`, h.geometries > 0 && `+${h.geometries} geo`, h.textures > 0 && `+${h.textures} doku`, h.long > 0 && `uzun görev ${h.long.toFixed(0)} ms`].filter(Boolean).join(" ");
    return `${this.total} takılma, son ${h.dt.toFixed(0)} ms (sim ${h.sim.toFixed(0)}, çizim ${h.draw.toFixed(0)}${hint ? ", " + hint : ""})`;
  }
}
