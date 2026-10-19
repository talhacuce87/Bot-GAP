// Videoyu 3D perdeye yerleştirir: oynatıcı DOM'da, CSS3DRenderer ile perdenin tam üstüne,
// WebGL canvas'ın ARKASINA konur. Perde WebGL'de saydam bir "delik" olarak çizilir; video oradan görünür.
// Önünden geçen avatarlar derinlik testiyle videonun üstünde kalır. GPU'ya ek maliyeti yoktur.
import * as THREE from "three";
import { CSS3DObject, CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";

/** Oynatıcının CSS piksel boyutu; perde genişliğine ölçeklenir. */
const PX_W = 1280;
const PX_H = 720;

export class ScreenVideo {
  /** Oynatıcıların yerleştirildiği kutu (16:9). */
  readonly host: HTMLDivElement;
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

  constructor(
    private screen: THREE.Mesh,
    screenWidth: number,
  ) {
    this.normalMaterial = screen.material;
    this.host = document.createElement("div");
    this.host.className = "screen-host";
    this.host.style.width = `${PX_W}px`;
    this.host.style.height = `${PX_H}px`;
    this.object = new CSS3DObject(this.host);
    this.object.position.copy(screen.position);
    this.object.quaternion.copy(screen.quaternion);
    this.object.scale.setScalar(screenWidth / PX_W);
    this.cssScene.add(this.object);

    const el = this.css.domElement;
    el.className = "screen-layer";
    document.body.prepend(el); // canvas'ın arkasında
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  private resize(): void {
    this.css.setSize(innerWidth, innerHeight);
  }

  /** Video varken perde deliğe döner; yokken normal (tabelalı) perde. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.screen.material = on ? this.holeMaterial : this.normalMaterial;
    this.css.domElement.style.display = on ? "" : "none";
  }

  /** Etkileşim modu: canvas tıklamaları geçirir, oynatıcıya doğrudan tıklanabilir (Kick sesi, çerez onayı vb.). */
  setInteractive(on: boolean, canvas: HTMLCanvasElement): void {
    canvas.style.pointerEvents = on ? "none" : "";
    this.css.domElement.style.pointerEvents = on ? "auto" : "none";
  }

  render(camera: THREE.Camera): void {
    if (this.active) this.css.render(this.cssScene, camera);
  }
}
