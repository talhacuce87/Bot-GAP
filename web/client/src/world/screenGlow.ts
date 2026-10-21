// Sinema perdesinin ortama ışığı: videonun (ya da tabelanın) ortalama rengi perdenin önünü boyar ve zeminde
// bulanık bir yansıma olarak uzanır. Renk 8×8'lik küçültülmüş kopyadan saniyede birkaç kez okunur.
// Video başka bir origin'den geliyorsa (YouTube vb.) piksel okunamaz: o zaman sakin, yavaş değişen bir sinema ışığı.
import * as THREE from "three";
import { timeUniform } from "./geo";

const SAMPLE_MS = 160;
/** Işığın ve yansımanın uzandığı alan (perdenin önü, amfiye kadar). */
const POOL_DEPTH = 12;

export class ScreenGlow {
  readonly group = new THREE.Group();
  private light: THREE.SpotLight;
  private pool: THREE.Mesh;
  private poolMat: THREE.ShaderMaterial;
  private canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D | null;
  private target = new THREE.Color(0, 0, 0);
  private color = new THREE.Color(0, 0, 0);
  private lastSample = 0;
  private level = 0;
  /** Okunamayan (başka origin) kaynaklar: bir daha denenmez. */
  private tainted = new WeakSet<object>();

  constructor(
    private screen: THREE.Mesh,
    width: number,
    height: number,
  ) {
    this.canvas.width = this.canvas.height = 8;
    this.g = this.canvas.getContext("2d", { willReadFrequently: true });
    const p = screen.position;
    // Perdenin altından öne bakan geniş, yumuşak spot: amfi ve izleyiciler perdenin rengini alır
    this.light = new THREE.SpotLight(0x000000, 0, 34, Math.PI / 2.6, 1, 1.2);
    this.light.position.set(p.x, p.y - height * 0.15, p.z + 0.6);
    this.light.target.position.set(p.x, 0, p.z + 16);
    this.group.add(this.light, this.light.target);

    // Zeminde yansıma: perdeden uzaklaştıkça solan, yatayda perdenin renk dağılımını izleyen ışık havuzu
    this.poolMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: this.color }, uLevel: { value: 0 }, uTime: timeUniform, uMap: { value: null }, uHasMap: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uLevel;
        uniform float uTime;
        uniform sampler2D uMap;
        uniform float uHasMap;
        varying vec2 vUv;
        void main() {
          // vUv.y: 1 perdenin dibi, 0 uzak uç
          float near = vUv.y;
          float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
          vec3 c = uColor;
          if (uHasMap > 0.5) {
            // Perdenin ters çevrilmiş, dikeyde uzatılmış ve bulanık kopyası
            vec2 uv = vec2(vUv.x, 1.0 - (1.0 - near) * 0.9);
            vec3 m = vec3(0.0);
            for (int i = -3; i <= 3; i++) {
              m += texture2D(uMap, uv + vec2(float(i) * 0.045, float(i) * 0.09 * (1.3 - near))).rgb;
              m += texture2D(uMap, uv + vec2(-float(i) * 0.03, float(i) * 0.06)).rgb;
            }
            c = mix(uColor, m / 14.0, 0.45);
          }
          float a = pow(near, 1.6) * edge * uLevel;
          // Hafif dalgalanma: cilalı zemin değil, beton üstünde parıltı
          a *= 0.92 + 0.08 * sin(vUv.x * 40.0 + uTime * 0.7) * sin(near * 25.0);
          gl_FragColor = vec4(c * a, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.pool = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.05, POOL_DEPTH), this.poolMat);
    this.pool.rotation.x = -Math.PI / 2;
    this.pool.position.set(p.x, 0.05, p.z + 2.1 + POOL_DEPTH / 2);
    this.pool.renderOrder = 2;
    this.group.add(this.pool);
  }

  /**
   * Her kare. `on`: sinemada bir şey oynuyor; `video`: aynı origin'den oynayan video (perdeden okunur);
   * `day`: gün ışığı (gündüz ışık daha az fark edilir).
   */
  update(now: number, dt: number, on: boolean, video: HTMLVideoElement | null, day: number): void {
    const want = on ? 1 : 0;
    this.level += (want - this.level) * Math.min(1, dt * 1.5);
    // Işık sahnede hep kalır (sayısı değişirse bütün malzemeler yeniden derlenir); kapalıyken gücü 0
    if (this.level < 0.005) {
      this.light.intensity = 0;
      this.pool.visible = false;
      return;
    }
    this.pool.visible = true;
    if (now - this.lastSample > SAMPLE_MS) {
      this.lastSample = now;
      this.sample(now, video);
    }
    this.color.lerp(this.target, Math.min(1, dt * 6));
    const night = 1 - day * 0.75;
    this.light.color.copy(this.color);
    this.light.intensity = 110 * this.level * night;
    this.poolMat.uniforms.uLevel.value = this.level * (0.25 + 0.55 * night);
  }

  private sample(now: number, video: HTMLVideoElement | null): void {
    const mat = this.screen.material as THREE.MeshBasicMaterial;
    const map = mat.map ?? null;
    const src: CanvasImageSource | null = video && video.readyState >= 2 ? video : (map?.image as CanvasImageSource | undefined) ?? null;
    const u = this.poolMat.uniforms;
    if (video && video.readyState >= 2 && !this.tainted.has(video)) {
      if (!(u.uMap.value instanceof THREE.VideoTexture) || u.uMap.value.image !== video) {
        (u.uMap.value as THREE.Texture | null)?.dispose();
        const tex = new THREE.VideoTexture(video);
        tex.colorSpace = THREE.SRGBColorSpace;
        u.uMap.value = tex;
      }
    } else if (map && !video) {
      if (u.uMap.value instanceof THREE.VideoTexture) u.uMap.value.dispose();
      u.uMap.value = map;
    } else {
      u.uMap.value = null;
    }
    u.uHasMap.value = u.uMap.value ? 1 : 0;
    if (!src || !this.g || this.tainted.has(src)) return this.fallback(now);
    try {
      this.g.drawImage(src, 0, 0, 8, 8);
      const d = this.g.getImageData(0, 0, 8, 8).data;
      let r = 0, gr = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        gr += d[i + 1];
        b += d[i + 2];
      }
      const n = (d.length / 4) * 255;
      this.target.setRGB(r / n, gr / n, b / n, THREE.SRGBColorSpace);
      // Karanlık sahneler de biraz ışık versin, parlaklar patlamasın
      const l = Math.max(this.target.r, this.target.g, this.target.b);
      if (l > 0.001) this.target.multiplyScalar(THREE.MathUtils.lerp(0.35, 1, l) / l);
    } catch {
      // Başka origin: piksel okunamaz (canvas kirlendi); bu kaynak bir daha denenmez
      this.tainted.add(src);
      if (src === video) u.uMap.value = null;
      this.fallback(now);
    }
  }

  /** Okunamayan video: soğuk mavi ile sıcak arasında yavaşça gezinen sinema ışığı. */
  private fallback(now: number): void {
    const t = now / 1000;
    this.target.setHSL(0.6 + 0.08 * Math.sin(t * 0.21), 0.45, 0.45 + 0.08 * Math.sin(t * 0.9) * Math.sin(t * 0.37));
  }
}
