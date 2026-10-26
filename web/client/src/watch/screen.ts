// Videoyu 3D perdeye yerleştirir: oynatıcı DOM'da, CSS3DRenderer ile perdenin tam üstüne,
// WebGL canvas'ın ARKASINA konur. Perde WebGL'de saydam bir "delik" olarak çizilir; video oradan görünür.
// Önünden geçen avatarlar derinlik testiyle videonun üstünde kalır. GPU'ya ek maliyeti yoktur.
import { listen } from "../mode";
import * as THREE from "three";
import { CSS3DObject, CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";

/** Oynatıcının CSS piksel boyutu; perde genişliğine ölçeklenir. */
const PX_W = 1280;
const PX_H = 720;

export class ScreenVideo {
  /** Oynatıcıların yerleştirildiği kutu (16:9). */
  readonly host: HTMLDivElement;
  /** Perdedeki kutu: oynatıcılar ve üstte ekran paylaşımı; tam ekran olan budur. */
  private frame: HTMLDivElement;
  /** Ekran paylaşımı: oynatıcının üstüne biner, varken perde hep açıktır. */
  private overlay: HTMLElement | null = null;
  private playerActive = false;
  private css = new CSS3DRenderer();
  private cssScene = new THREE.Scene();
  private object: CSS3DObject;
  private normalMaterial: THREE.Material | THREE.Material[];
  private holeMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true, // OPAQUE tanımlanırsa alfa 1'e zorlanır; delik için alfa 0 yazılmalı
    opacity: 0,
    blending: THREE.NoBlending,
    fog: false,
  });
  private active = false;
  /** Kamera perdenin dibinde: köşelerden biri kameranın arkasında (CSS 3B bunu çizemez). */
  private tooClose = false;
  /** Yakından bakınca delik yerine: kapalı ekran gibi koyu perde. */
  private closeMaterial = new THREE.MeshBasicMaterial({ color: "#0b0d12", fog: false });
  private corners: THREE.Vector3[];
  private v = new THREE.Vector3();

  constructor(
    private screen: THREE.Mesh,
    screenWidth: number,
  ) {
    const hw = screenWidth / 2, hh = (screenWidth * PX_H) / PX_W / 2;
    this.corners = [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]].map(([x, y]) => new THREE.Vector3(x, y, 0));
    this.normalMaterial = screen.material;
    this.frame = document.createElement("div");
    this.frame.className = "screen-host";
    this.frame.style.width = `${PX_W}px`;
    this.frame.style.height = `${PX_H}px`;
    this.host = document.createElement("div");
    this.host.className = "screen-players";
    this.frame.append(this.host);
    this.object = new CSS3DObject(this.frame);
    this.object.position.copy(screen.position);
    this.object.quaternion.copy(screen.quaternion);
    this.object.scale.setScalar(screenWidth / PX_W);
    this.cssScene.add(this.object);

    const el = this.css.domElement;
    el.className = "screen-layer";
    document.body.prepend(el); // canvas'ın arkasında
    this.resize();
    listen("resize", () => this.resize());
  }

  private resize(): void {
    this.css.setSize(innerWidth, innerHeight);
  }

  /** Katmanı tamamen kaldırır (mod değişince): içindeki oynatıcılar da durur. */
  destroy(): void {
    this.overlay?.remove();
    this.css.domElement.remove();
  }

  /** Perde şu an video deliği mi. */
  get isActive(): boolean {
    return this.active;
  }

  /** Video varken perde deliğe döner; yokken normal (tabelalı) perde. */
  setActive(on: boolean): void {
    this.playerActive = on;
    this.refresh();
  }

  /** Ekran paylaşımı katmanı (null: kaldır). */
  setOverlay(el: HTMLElement | null): void {
    if (this.overlay && this.overlay !== el) this.overlay.remove();
    this.overlay = el;
    if (el) this.frame.append(el);
    this.refresh();
  }

  private refresh(): void {
    const on = this.playerActive || !!this.overlay;
    if (on === this.active) return;
    this.active = on;
    this.applyMaterial();
  }

  private applyMaterial(): void {
    const hole = this.active && !this.tooClose;
    this.screen.material = hole ? this.holeMaterial : this.active ? this.closeMaterial : this.normalMaterial;
    this.css.domElement.style.display = hole ? "" : "none";
  }

  /** Etkileşim modu: canvas tıklamaları geçirir, oynatıcıya doğrudan tıklanabilir (Kick sesi, çerez onayı vb.). */
  setInteractive(on: boolean, canvas: HTMLCanvasElement): void {
    canvas.style.pointerEvents = on ? "none" : "";
    this.css.domElement.style.pointerEvents = on ? "auto" : "none";
  }

  /** Tarayıcı tam ekran destekliyor mu (iOS Safari'de öğe tam ekranı yok). */
  get canFullscreen(): boolean {
    return document.fullscreenEnabled && typeof this.frame.requestFullscreen === "function";
  }

  get fullscreen(): boolean {
    return document.fullscreenElement === this.frame;
  }

  /**
   * Oynatıcı kutusunu tam ekran yapar. Kutu yerinden oynatılmaz (iframe taşınırsa yeniden yüklenir);
   * tam ekran öğesi en üst katmanda çizilir ve 3D dönüşümü tarayıcı yok sayar. Esc ile çıkılır.
   */
  async toggleFullscreen(): Promise<void> {
    if (this.fullscreen) await document.exitFullscreen();
    else if (this.canFullscreen) await this.frame.requestFullscreen();
  }

  render(camera: THREE.Camera): void {
    if (!this.active) return;
    // Perdenin bir köşesi kameranın arkasına (ya da dibine) düştüyse CSS 3B katmanı bozulur: delik açık kalır,
    // arkasında boş sayfa görünür. O an deliği kapat, perdeyi koyu çiz; uzaklaşınca video geri gelir.
    camera.updateMatrixWorld();
    const close = this.corners.some((c) => this.v.copy(c).applyMatrix4(this.screen.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z > -0.6);
    if (close !== this.tooClose) {
      this.tooClose = close;
      this.applyMaterial();
    }
    if (!close) this.css.render(this.cssScene, camera);
  }
}
