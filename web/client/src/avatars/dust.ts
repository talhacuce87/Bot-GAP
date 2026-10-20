// Zıplama tozu: kalkışta küçük, inişte ayakların çevresinden halka gibi açılan çizgi film tozu.
// Puflar tek InstancedMesh; çıkış noktası/zaman örnek başına bir kez yazılır, hareket vertex shader'da.
import * as THREE from "three";
import { timeUniform } from "../world/geo";

const POOL = 192;
const DURATION = 0.8;
/** Bu mesafeden uzaktaki toz hiç üretilmez. */
const MAX_DIST = 40;

const VERT = /* glsl */ `
  attribute vec3 aOrigin;
  attribute vec3 aMove; // yön x/z, hız
  attribute vec2 aLife; // başlangıç, boyut
  uniform float uTime;
  varying vec2 vLocal;
  varying float vT;
  void main() {
    float t = (uTime - aLife.x) / ${DURATION.toFixed(2)};
    vT = t;
    // Hızlı çıkıp yavaşlar (ease-out); hafifçe yükselir, sonda söner.
    float ease = 1.0 - pow(1.0 - clamp(t, 0.0, 1.0), 3.0);
    vec3 p = aOrigin + vec3(aMove.x * ease * aMove.z, 0.22 + ease * 0.4 * aMove.z, aMove.y * ease * aMove.z);
    vec4 center = modelViewMatrix * vec4(p, 1.0);
    float size = aLife.y * (0.45 + 0.9 * smoothstep(0.0, 0.25, t)) * (1.0 - 0.55 * smoothstep(0.55, 1.0, t));
    vLocal = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * (center + vec4(position.xy * size, 0.0, 0.0));
    if (t < 0.0 || t > 1.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

// İki tonlu puf: üstte aydınlık, altta gölgeli; kenarda ince koyu çizgi (anime tozu).
const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLight;
  varying vec2 vLocal;
  varying float vT;
  void main() {
    float d = length(vLocal);
    // Sönerken içten "erir": kenar sabit, ortada delik büyür
    float hole = smoothstep(0.55, 1.0, vT) * 0.85;
    if (d > 1.0 || d < hole) discard;
    float shade = step(0.15, vLocal.y - vLocal.x * 0.35 + 0.1);
    vec3 c = mix(uColor * 0.78, uColor, shade);
    c = mix(c, uColor * 0.5, smoothstep(0.82, 0.9, d));
    float a = 0.9 * (1.0 - smoothstep(0.7, 1.0, vT));
    gl_FragColor = vec4(c * uLight, a);
    #include <colorspace_fragment>
  }
`;

export class DustFx {
  readonly mesh: THREE.InstancedMesh;
  private origin: THREE.InstancedBufferAttribute;
  private move: THREE.InstancedBufferAttribute;
  private life: THREE.InstancedBufferAttribute;
  private next = 0;
  private prevY = new WeakMap<object, number>();
  /** Işık (gece kararır). */
  readonly light = { value: 1 };

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.origin = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 3), 3);
    this.move = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 3), 3);
    this.life = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 2).fill(-100), 2);
    geo.setAttribute("aOrigin", this.origin);
    geo.setAttribute("aMove", this.move);
    geo.setAttribute("aLife", this.life);
    this.mesh = new THREE.InstancedMesh(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uTime: timeUniform, uColor: { value: new THREE.Color("#efe4cf") }, uLight: this.light },
        transparent: true,
        depthWrite: false,
      }),
      POOL,
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /**
   * Kare başına her avatar için: yükseklik sıfırdan çıkınca kalkış, sıfıra dönünce iniş tozu.
   * `camera`: uzaktakiler için toz üretilmez.
   */
  track(v: { x: number; z: number; jumpY: number }, time: number, camera: THREE.Vector3): void {
    const prev = this.prevY.get(v);
    this.prevY.set(v, v.jumpY);
    if (prev === undefined || (prev > 0) === (v.jumpY > 0)) return;
    if ((v.x - camera.x) ** 2 + (v.z - camera.z) ** 2 > MAX_DIST * MAX_DIST) return;
    // Puflar çimenin üstünde kalacak kadar büyük ve yüksek
    if (v.jumpY > 0) this.burst(v.x, v.z, time, 6, 0.7, 0.5);
    else this.burst(v.x, v.z, time, 12, 1.25, 0.68);
  }

  /** `n` puf halka şeklinde dışa açılır; `reach` m, `size` puf çapı. */
  burst(x: number, z: number, time: number, n: number, reach: number, size: number): void {
    const a0 = Math.random() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % POOL;
      const a = a0 + (k / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      this.origin.setXYZ(i, x + Math.cos(a) * 0.18, 0, z + Math.sin(a) * 0.18);
      this.move.setXYZ(i, Math.cos(a), Math.sin(a), reach * (0.75 + Math.random() * 0.5));
      this.life.setXY(i, time + Math.random() * 0.04, size * (0.75 + Math.random() * 0.5));
    }
    this.origin.needsUpdate = this.move.needsUpdate = this.life.needsUpdate = true;
  }
}
