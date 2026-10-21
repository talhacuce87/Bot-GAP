// Gardırop sahnesi: pencerenin ortasında platformda dönen büyük karakter + parça kartlarının küçük
// 3D resimleri (aynı WebGL bağlamında, ekran dışı hedefe çizilip resme çevrilir).
// Dünyanın indirdiği chibi paketini paylaşır; yalnızca gardırop açıkken çizer.
import * as THREE from "three";
import type { Look } from "../../../shared/protocol";
import { CHIBI_SCALE, ChibiLayer, type LimbPose } from "../avatars/chibi";
import { type ChibiPack, lookKey } from "../avatars/chibiPack";

const FOV = 28;
/**
 * Kamera odakları, karakter boyuna oranla: bakılan yükseklik ve görünen dikey alan.
 * Tüm boy; kafa ve omuzlar (saç, şapka, gözlük, sakal sekmeleri).
 */
const FRAMES = {
  body: { y: 0.5, view: 1.25 },
  head: { y: 0.72, view: 0.9 },
};
export type PreviewFocus = keyof typeof FRAMES;

/** Kart resimlerinde karakterin hangi bölgesi görünür (boya oranla) ve hangi açıdan. */
const REGIONS = {
  head: { y: 0.77, view: 0.6, yaw: 0.4 },
  torso: { y: 0.39, view: 0.44, yaw: 0.3 },
  legs: { y: 0.2, view: 0.44, yaw: 0.3 },
  feet: { y: 0.06, view: 0.22, yaw: 0.8 },
};
export type ThumbRegion = keyof typeof REGIONS;
const THUMB_PX = 192;
/** Kare başına en fazla bu kadar kart resmi (her biri bir kıyafet geometrisi kurar). */
const THUMBS_PER_FRAME = 2;
const THUMB_CACHE_MAX = 400;

const IDLE: LimbPose = { swing: 0, seated: false, wave: 0, dance: 0, hug: 0, pedal: 0, mic: 0, time: 0 };

interface ThumbJob {
  key: string;
  look: Look;
  region: ThumbRegion;
  done: ((url: string) => void)[];
}

function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight("#eef4ff", "#4a3f5a", 1.7));
  const key = new THREE.DirectionalLight("#fff3df", 2.1);
  key.position.set(2.5, 4, 3.5);
  const rim = new THREE.DirectionalLight("#9fb8ff", 1.4);
  rim.position.set(-3, 2.5, -3);
  scene.add(key, rim);
}

export class WardrobePreview {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
  private layer = new ChibiLayer(1, 1000);
  private pose = new THREE.Matrix4();
  private limbs: LimbPose = { ...IDLE };
  private look: Look | null = null;
  private status: HTMLDivElement;
  private resize: ResizeObserver;
  private ring: THREE.Mesh;
  /** Karakter boyu (m); paket inince temel gövdeden ölçülür. */
  private height = 1.6;
  /** Karakterin dönüşü (radyan); 0 kameraya bakar. */
  private yaw = 0;
  private targetYaw = 0;
  /** Basılı tutulan döndürme tuşu: -1 sola, 1 sağa. */
  private spin = 0;
  private zoom = 1;
  private focus: PreviewFocus = "body";
  private camY = 0;
  private camDist = 0;
  private dragId = -1;
  private dragX = 0;
  private last = 0;
  private waveT = 0;

  private thumbScene = new THREE.Scene();
  private thumbLayer = new ChibiLayer(1, 1000);
  private thumbCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50);
  private thumbTarget: THREE.WebGLRenderTarget | null = null;
  private thumbPose = new THREE.Matrix4();
  private thumbPixels = new Uint8Array(THUMB_PX * THUMB_PX * 4);
  private thumbCanvas = document.createElement("canvas");
  private thumbs = new Map<string, string>();
  private queue: ThumbJob[] = [];

  constructor(
    parent: HTMLElement,
    private getPack: () => ChibiPack | null,
  ) {
    this.el = document.createElement("div");
    this.el.className = "wd-canvas";
    this.canvas = document.createElement("canvas");
    this.status = document.createElement("div");
    this.status.className = "wd-canvas-msg";
    this.el.append(this.canvas, this.status);
    parent.append(this.el);

    addLights(this.scene);
    this.scene.add(this.layer.group);
    // Platform: koyu disk, üstünde parlayan halka
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.56, 64),
      new THREE.MeshBasicMaterial({ color: 0x05060c, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.53, 0.57, 96),
      new THREE.MeshBasicMaterial({ color: 0x8b7bff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.57, 0.85, 96),
      new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    for (const m of [disc, this.ring, halo]) {
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.003;
      this.scene.add(m);
    }

    addLights(this.thumbScene);
    this.thumbScene.add(this.thumbLayer.group);
    this.thumbCanvas.width = this.thumbCanvas.height = THUMB_PX;

    this.canvas.addEventListener("pointerdown", (e) => {
      this.dragId = e.pointerId;
      this.dragX = e.clientX;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.dragId) return;
      this.targetYaw += (e.clientX - this.dragX) * 0.012;
      this.dragX = e.clientX;
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId === this.dragId) this.dragId = -1;
    };
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
    this.canvas.addEventListener("dblclick", () => this.front());
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoom = THREE.MathUtils.clamp(this.zoom * (e.deltaY > 0 ? 1.1 : 0.9), 0.55, 1.6);
    }, { passive: false });
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(this.el);
  }

  setLook(look: Look | null): void {
    this.look = look;
    // Yeni parça: kısa bir el sallama
    this.waveT = 1.2;
  }

  setFocus(focus: PreviewFocus): void {
    if (this.focus === focus) return;
    this.focus = focus;
    this.zoom = 1;
  }

  /** Düğmeyle sekizde bir tur döndür. */
  turn(dir: number): void {
    this.targetYaw += dir * (Math.PI / 4);
  }

  setSpin(dir: number): void {
    this.spin = dir;
  }

  /** Yüzü öne: en yakın tam tura döner (ters yönde fırıl fırıl dönmesin). */
  front(): void {
    this.targetYaw = Math.round(this.targetYaw / (Math.PI * 2)) * Math.PI * 2;
    this.zoom = 1;
  }

  /**
   * Kart resmi: hazırsa adresi döner; değilse sıraya alır, hazır olunca `done` çağrılır.
   * Sıra her liste çiziminde `clearThumbs` ile boşaltılır (görünmeyen sekmenin resimleri beklemesin).
   */
  thumb(look: Look, region: ThumbRegion, done: (url: string) => void): string | null {
    const key = `${region}|${lookKey(look)}`;
    const url = this.thumbs.get(key);
    if (url) return url;
    const job = this.queue.find((j) => j.key === key);
    if (job) job.done.push(done);
    else this.queue.push({ key, look, region, done: [done] });
    return null;
  }

  clearThumbs(): void {
    this.queue.length = 0;
  }

  start(): void {
    if (!this.renderer) {
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
      } catch {
        this.status.textContent = "Önizleme açılamadı (WebGL).";
        return;
      }
      this.renderer.toneMapping = THREE.NeutralToneMapping;
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.thumbTarget = new THREE.WebGLRenderTarget(THUMB_PX, THUMB_PX, { samples: 4 });
      this.thumbTarget.texture.colorSpace = THREE.SRGBColorSpace;
    }
    this.yaw = this.targetYaw = 0;
    this.zoom = 1;
    this.spin = 0;
    // Açılışta kamera kayarak gelmesin
    this.camY = this.camDist = 0;
    this.last = performance.now();
    this.fit();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  stop(): void {
    this.renderer?.setAnimationLoop(null);
    this.dragId = -1;
    this.spin = 0;
    this.queue.length = 0;
  }

  dispose(): void {
    this.stop();
    this.resize.disconnect();
    this.thumbTarget?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }

  private fit(): void {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!this.renderer || !w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(now: number): void {
    const renderer = this.renderer!;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const pack = this.getPack();
    if (pack && !this.layer.pack) {
      this.layer.usePack(pack);
      this.thumbLayer.usePack(pack);
      const geo = pack.build(null);
      geo.computeBoundingBox();
      this.height = geo.boundingBox!.max.y * CHIBI_SCALE;
      geo.dispose();
      this.camY = this.camDist = 0;
    }
    this.status.textContent = this.layer.pack ? "" : "Karakter yükleniyor…";
    if (this.layer.pack) {
      for (let n = 0; n < THUMBS_PER_FRAME && this.queue.length; n++) this.renderThumb(this.queue.shift()!);
    }

    const k = 1 - Math.exp(-dt * 10);
    this.targetYaw += this.spin * dt * 2.6;
    this.yaw += (this.targetYaw - this.yaw) * k;
    const f = FRAMES[this.focus];
    const y = f.y * this.height;
    const dist = (f.view * this.height * this.zoom) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    if (!this.camDist) [this.camY, this.camDist] = [y, dist];
    this.camY += (y - this.camY) * k;
    this.camDist += (dist - this.camDist) * k;
    // Dar (dikey) alanda tüm boy sığsın diye kamera geri çekilir
    const fitBack = this.camera.aspect < 0.75 ? 0.75 / this.camera.aspect : 1;
    this.camera.position.set(0, this.camY + 0.1, this.camDist * fitBack);
    this.camera.lookAt(0, this.camY, 0);

    this.waveT = Math.max(0, this.waveT - dt);
    this.limbs.time = now / 1000;
    // Nefes: kollar hafifçe sallanır; yeni seçimde el sallar
    this.limbs.swing = Math.sin(this.limbs.time * 1.6) * 0.06;
    this.limbs.wave = Math.min(1, this.waveT * 3);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.75 + Math.sin(this.limbs.time * 2.2) * 0.2;
    this.pose.makeRotationY(this.yaw);
    this.layer.begin(this.camera.position);
    this.layer.place(this.look, 0, 0, this.pose, this.limbs, true);
    this.layer.end();
    renderer.render(this.scene, this.camera);
  }

  private renderThumb(job: ThumbJob): void {
    const renderer = this.renderer!;
    const r = REGIONS[job.region];
    const h = this.height;
    const half = (r.view * h) / 2;
    const cam = this.thumbCam;
    cam.left = cam.bottom = -half;
    cam.right = cam.top = half;
    cam.position.set(0, r.y * h, 10);
    cam.lookAt(0, r.y * h, 0);
    cam.updateProjectionMatrix();
    this.thumbPose.makeRotationY(r.yaw);
    this.thumbLayer.begin(cam.position);
    const ok = this.thumbLayer.place(job.look, 0, 0, this.thumbPose, IDLE, true);
    this.thumbLayer.end();
    if (!ok) return;

    renderer.setRenderTarget(this.thumbTarget);
    renderer.clear();
    renderer.render(this.thumbScene, cam);
    renderer.readRenderTargetPixels(this.thumbTarget!, 0, 0, THUMB_PX, THUMB_PX, this.thumbPixels);
    renderer.setRenderTarget(null);

    // WebGL satırları alttan üste: resim için ters çevrilir
    const ctx = this.thumbCanvas.getContext("2d")!;
    const img = ctx.createImageData(THUMB_PX, THUMB_PX);
    const row = THUMB_PX * 4;
    for (let y = 0; y < THUMB_PX; y++) img.data.set(this.thumbPixels.subarray((THUMB_PX - 1 - y) * row, (THUMB_PX - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    const url = this.thumbCanvas.toDataURL("image/png");
    if (this.thumbs.size >= THUMB_CACHE_MAX) this.thumbs.delete(this.thumbs.keys().next().value!);
    this.thumbs.set(job.key, url);
    for (const done of job.done) done(url);
  }
}
