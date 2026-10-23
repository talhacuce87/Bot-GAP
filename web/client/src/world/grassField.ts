// Sık çimen: kameranın önündeki ~18 m'lik alanda on binlerce ince, sivri yaprak.
// Yapraklar dünyada sabittir; alan kamerayla birlikte "sarılır" (toroidal), uzaklaştıkça yere gömülür.
// Nereye çimen çıkacağı ve rengi dünya maskesinden (yollar, meydan, yapılar boş) okunur.
// Yakındaki karakterler çimeni ezer/iter. Lambert ışığı alır: gece lambaların altında parlar.
import * as THREE from "three";
import { timeUniform } from "./geo";

const RADIUS = 18;
const MASK_RES = 256;
const PATCH = RADIUS * 2;
export const MAX_PUSHERS = 8;

export interface GrassMask {
  /** Maskenin kapladığı kare: [min, min + size]. */
  min: number;
  size: number;
  /** Çimen izni (0–1). */
  allowed(x: number, z: number): number;
  /** Zeminin rengi (çimen dibi buna uyar). */
  color(x: number, z: number, out: THREE.Color): THREE.Color;
}

function bakeMask(m: GrassMask, res: number): THREE.DataTexture {
  const data = new Uint8Array(res * res * 4);
  const c = new THREE.Color();
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = m.min + ((i + 0.5) / res) * m.size, z = m.min + ((j + 0.5) / res) * m.size;
      const k = (j * res + i) * 4;
      m.color(x, z, c);
      data[k] = Math.round(m.allowed(x, z) * 255);
      data[k + 1] = Math.round(Math.min(1, c.r) * 255);
      data[k + 2] = Math.round(Math.min(1, c.g) * 255);
      data[k + 3] = Math.round(Math.min(1, c.b) * 255);
    }
  }
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Tek yaprak: 3 bölüm, uca doğru incelir (7 köşe, 5 üçgen). y: 0..1. */
function bladeGeometry(): THREE.BufferGeometry {
  const w = 0.045;
  const rows = [0, 0.38, 0.72];
  const pos: number[] = [];
  for (const y of rows) {
    const half = w * (1 - y * 0.75);
    pos.push(-half, y, 0, half, y, 0);
  }
  pos.push(0, 1, 0);
  const idx = [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 6];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 3).fill(1), 3));
  g.setIndex(idx);
  return g;
}

export class GrassField {
  readonly mesh: THREE.Mesh;
  private center = { value: new THREE.Vector2() };
  private pushers = { value: Array.from({ length: MAX_PUSHERS }, () => new THREE.Vector3(1e5, 1e5, 0)) };
  private fwd = new THREE.Vector3();
  /** Maskenin izin kanalı (MASK_RES²): alanın altında hiç çimen yoksa mesh çizilmez. */
  private allowed: Uint8Array;
  private maskMin: number;
  private maskSize: number;

  constructor(mask: GrassMask, count: number) {
    const blade = bladeGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = blade.index;
    geo.setAttribute("position", blade.attributes.position);
    geo.setAttribute("color", blade.attributes.color);
    const off = new Float32Array(count * 2);
    const rnd = new Float32Array(count * 3);
    let s = 1234567;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      off[i * 2] = rand() * PATCH;
      off[i * 2 + 1] = rand() * PATCH;
      rnd.set([rand(), rand() * Math.PI * 2, rand()], i * 3);
    }
    geo.setAttribute("aOffset", new THREE.InstancedBufferAttribute(off, 2));
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rnd, 3));
    geo.instanceCount = count;

    const tex = bakeMask(mask, MASK_RES);
    const data = tex.image.data as Uint8Array;
    this.allowed = new Uint8Array(MASK_RES * MASK_RES);
    for (let k = 0; k < this.allowed.length; k++) this.allowed[k] = data[k * 4];
    this.maskMin = mask.min;
    this.maskSize = mask.size;
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uTime: timeUniform,
        uMask: { value: tex },
        uMaskBox: { value: new THREE.Vector2(mask.min, mask.size) },
        uCenter: this.center,
        uPush: this.pushers,
      });
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          attribute vec2 aOffset;
          attribute vec3 aRand;
          uniform float uTime;
          uniform sampler2D uMask;
          uniform vec2 uMaskBox;
          uniform vec2 uCenter;
          uniform vec3 uPush[${MAX_PUSHERS}];`,
        )
        // Işık yukarıdan gelsin diye normal hep yukarı: yaprakların iki yüzü de aynı aydınlanır.
        .replace("#include <beginnormal_vertex>", "vec3 objectNormal = vec3(0.0, 1.0, 0.0);")
        .replace(
          "#include <begin_vertex>",
          `vec2 wp = uCenter + mod(aOffset - uCenter + ${RADIUS.toFixed(1)}, ${PATCH.toFixed(1)}) - ${RADIUS.toFixed(1)};
          vec4 m = texture2D(uMask, (wp - uMaskBox.x) / uMaskBox.y);
          float fade = (1.0 - smoothstep(${(RADIUS * 0.6).toFixed(1)}, ${RADIUS.toFixed(1)}, distance(wp, uCenter))) * smoothstep(0.35, 0.85, m.r);
          float h = position.y;
          float H = mix(0.26, 0.58, aRand.x * aRand.x) * fade;
          vec2 dir = vec2(cos(aRand.y), sin(aRand.y));
          vec2 side = vec2(-dir.y, dir.x);
          vec3 transformed = vec3(dir.x * position.x, h * H, dir.y * position.x);
          // Doğal kavis + rüzgâr (scene.ts'teki rüzgârla aynı dalga)
          float gust = 0.55 + 0.45 * sin(uTime * 0.35 - wp.x * 0.045 - wp.y * 0.03);
          float sway = gust * (sin(uTime * 1.6 + wp.x * 0.31 + wp.y * 0.23) + 0.4 * sin(uTime * 3.1 + wp.x * 0.7 + aRand.z * 3.0));
          vec2 bend = side * (aRand.z - 0.5) * 0.45 * H + vec2(sway * 0.22, sway * 0.13) * H;
          // Karakterler çimeni iter ve ezer
          for (int i = 0; i < ${MAX_PUSHERS}; i++) {
            vec2 dd = wp - uPush[i].xy;
            float r = uPush[i].z;
            float k = 1.0 - smoothstep(0.0, r, length(dd));
            bend += normalize(dd + 1e-4) * k * 0.55 * H;
            transformed.y *= 1.0 - k * 0.55 * h;
          }
          transformed.xz += bend * h * h;
          transformed += vec3(wp.x, 0.0, wp.y);
          // Dipte zemin rengi (koyu), uçta açık ve hafif sarımsı; her yaprak biraz farklı
          // (color_vertex bundan önce çalışır: renk burada yazılır)
          vec3 tipC = m.gba * (1.35 + aRand.z * 0.25) + vec3(0.03, 0.05, 0.0);
          vColor.rgb = mix(m.gba * 0.62, tipC, h);`,
        )
        // Instancing yok: dönüşüm zaten dünya koordinatında
        .replace("#include <project_vertex>", "vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);\ngl_Position = projectionMatrix * mvPosition;");
    };
    material.customProgramCacheKey = () => "grass-field";
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  private anyGrass(cx: number, cz: number): boolean {
    const k = MASK_RES / this.maskSize;
    const i0 = Math.max(0, Math.floor((cx - RADIUS - this.maskMin) * k)), i1 = Math.min(MASK_RES - 1, Math.floor((cx + RADIUS - this.maskMin) * k));
    const j0 = Math.max(0, Math.floor((cz - RADIUS - this.maskMin) * k)), j1 = Math.min(MASK_RES - 1, Math.floor((cz + RADIUS - this.maskMin) * k));
    // Shader 0.35'in altını gömer
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (this.allowed[j * MASK_RES + i] > 89) return true;
    return false;
  }

  /**
   * Kare başına: alan kameranın baktığı yöne kayar (önündeki çimen sık); `pushers` x, z, yarıçap.
   */
  update(camera: THREE.Camera, pushers: readonly { x: number; z: number; r: number }[]): void {
    camera.getWorldDirection(this.fwd);
    this.fwd.y = 0;
    this.fwd.normalize();
    this.center.value.set(camera.position.x + this.fwd.x * RADIUS * 0.55, camera.position.z + this.fwd.z * RADIUS * 0.55);
    // Asfalt, meydan, bina içi: alanın altında hiç çimen yoksa 30 bin yaprak boşuna işlenmesin
    this.mesh.visible = this.anyGrass(this.center.value.x, this.center.value.y);
    const u = this.pushers.value;
    for (let i = 0; i < MAX_PUSHERS; i++) {
      const p = pushers[i];
      if (p) u[i].set(p.x, p.z, p.r);
      else u[i].set(1e5, 1e5, 0.0001);
    }
  }
}
