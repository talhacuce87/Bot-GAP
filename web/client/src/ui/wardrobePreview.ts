// Gardırop önizlemesi: pencerenin solunda kendi küçük sahnesinde dönen büyük karakter.
// Dünyanın indirdiği chibi paketini paylaşır; yalnızca gardırop açıkken çizer.
import * as THREE from "three";
import type { Look } from "../../../shared/protocol";
import { CHIBI_SCALE, ChibiLayer, type LimbPose } from "../avatars/chibi";
import type { ChibiPack } from "../avatars/chibiPack";

const FOV = 28;
/**
 * Kamera odakları, karakter boyuna oranla: bakılan yükseklik ve görünen dikey alan.
 * Tüm boy; kafa ve omuzlar (saç, şapka, gözlük, sakal sekmeleri).
 */
const FRAMES = {
  body: { y: 0.5, view: 1.2 },
  head: { y: 0.72, view: 0.9 },
};
export type PreviewFocus = keyof typeof FRAMES;

export class WardrobePreview {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
  /** Karakter boyu (m); paket inince temel gövdeden ölçülür. */
  private height = 1.6;
  private layer = new ChibiLayer(1, 1000);
  private pose = new THREE.Matrix4();
  private limbs: LimbPose = { swing: 0, seated: false, wave: 0, dance: 0, hug: 0, pedal: 0, mic: 0, time: 0 };
  private look: Look | null = null;
  private status: HTMLDivElement;
  private resize: ResizeObserver;
  /** Karakterin dönüşü (radyan); 0 kameraya bakar. */
  private yaw = 0;
  private targetYaw = 0;
  private zoom = 1;
  private focus: PreviewFocus = "body";
  private camY = 0;
  private camDist = 0;
  private dragId = -1;
  private dragX = 0;
  private last = 0;
  private waveT = 0;

  constructor(
    parent: HTMLElement,
    private getPack: () => ChibiPack | null,
  ) {
    this.el = document.createElement("div");
    this.el.className = "wardrobe-stage";
    this.canvas = document.createElement("canvas");
    this.status = document.createElement("div");
    this.status.className = "wardrobe-stage-msg";
    const hint = document.createElement("div");
    hint.className = "wardrobe-stage-hint";
    hint.textContent = "Sürükle: döndür · Tekerlek: yakınlaş · Çift tık: öne çevir";
    this.el.append(this.canvas, this.status, hint);
    parent.append(this.el);

    this.scene.add(new THREE.HemisphereLight("#eef4ff", "#5a4a3a", 1.7));
    const key = new THREE.DirectionalLight("#fff3df", 2.1);
    key.position.set(2.5, 4, 3.5);
    const rim = new THREE.DirectionalLight("#9fb8ff", 1.1);
    rim.position.set(-3, 2.5, -3);
    this.scene.add(key, rim, this.layer.group);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 48),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.002;
    this.scene.add(floor);

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
    this.canvas.addEventListener("dblclick", () => {
      // En yakın tam tura döner: ters yönde fırıl fırıl dönmesin
      this.targetYaw = Math.round(this.targetYaw / (Math.PI * 2)) * Math.PI * 2;
      this.zoom = 1;
    });
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
    }
    this.yaw = this.targetYaw = 0;
    this.zoom = 1;
    // Açılışta kamera kayarak gelmesin
    this.camY = this.camDist = 0;
    this.last = performance.now();
    this.fit();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  stop(): void {
    this.renderer?.setAnimationLoop(null);
    this.dragId = -1;
  }

  dispose(): void {
    this.stop();
    this.resize.disconnect();
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
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const pack = this.getPack();
    if (pack && !this.layer.pack) {
      this.layer.usePack(pack);
      const geo = pack.build(null);
      geo.computeBoundingBox();
      this.height = geo.boundingBox!.max.y * CHIBI_SCALE;
      geo.dispose();
      this.camY = this.camDist = 0;
    }
    this.status.textContent = this.layer.pack ? "" : "Karakter yükleniyor…";

    const k = 1 - Math.exp(-dt * 10);
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
    this.pose.makeRotationY(this.yaw);
    this.layer.begin(this.camera.position);
    this.layer.place(this.look, 0, 0, this.pose, this.limbs, true);
    this.layer.end();
    this.renderer!.render(this.scene, this.camera);
  }
}
