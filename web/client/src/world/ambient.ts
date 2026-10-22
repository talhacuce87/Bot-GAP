// Ortam efektleri: yerde süzülen sis, mevsim parçacıkları (sonbahar yaprağı, bahar yaprağı, yaz polenleri),
// gol konfetisi, sahne dumanı ve ıslak zeminde adım sıçramaları. Hepsi tek InstancedMesh'ler; hareket vertex
// shader'da, CPU yalnızca birkaç uniform (ve patlamalarda birkaç örnek) yazar.
import * as THREE from "three";
import { STAGE } from "../../../shared/zones";
import type { Season } from "./scene";
import { timeUniform } from "./geo";

/** Tek kare (quad) + örnek başına öznitelikler. */
function quads(count: number, attrs: Record<string, [Float32Array, number]>): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.setAttribute("position", quad.attributes.position);
  geo.setAttribute("uv", quad.attributes.uv);
  for (const [name, [arr, size]] of Object.entries(attrs)) geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
  geo.instanceCount = count;
  return geo;
}

function rand4(count: number): Float32Array {
  const a = new Float32Array(count * 4);
  for (let i = 0; i < a.length; i++) a[i] = Math.random();
  return a;
}

// ---------------------------------------------------------------------------
// Sis: oyuncunun çevresinde yere yakın, rüzgârla kayan pus katmanları (sabah, sisli hava, yağmur)
// ---------------------------------------------------------------------------

const MIST_BOX = 80;

export class Mist {
  readonly mesh: THREE.Mesh;
  private u: { uCenter: { value: THREE.Vector3 }; uDensity: { value: number }; uColor: { value: THREE.Color } };

  constructor(count = 46) {
    this.u = { uCenter: { value: new THREE.Vector3() }, uDensity: { value: 0 }, uColor: { value: new THREE.Color() } };
    const material = new THREE.ShaderMaterial({
      uniforms: { ...this.u, uTime: timeUniform },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform vec3 uCenter;
        uniform float uTime;
        varying vec2 vUv;
        varying vec2 vW;
        varying float vEdge;
        void main() {
          vUv = uv;
          vec2 xz = aSeed.xy * ${MIST_BOX.toFixed(1)} + uTime * vec2(0.35, 0.12);
          vec2 wp = uCenter.xz + mod(xz - uCenter.xz + ${(MIST_BOX / 2).toFixed(1)}, ${MIST_BOX.toFixed(1)}) - ${(MIST_BOX / 2).toFixed(1)};
          float size = 14.0 + aSeed.z * 10.0;
          vec3 p = vec3(wp.x + position.x * size, 0.2 + aSeed.w * 1.4, wp.y - position.y * size);
          vW = p.xz;
          // Kutunun kenarına yaklaşan katman söner (sarılırken birden belirmesin)
          vec2 rel = abs(wp - uCenter.xz) / ${(MIST_BOX / 2).toFixed(1)};
          vEdge = 1.0 - smoothstep(0.7, 1.0, max(rel.x, rel.y));
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uDensity;
        uniform float uTime;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying vec2 vW;
        varying float vEdge;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1.0, 0.0)), u.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          if (d > 1.0) discard;
          vec2 q = vW * 0.09 + uTime * vec2(0.02, 0.01);
          float k = n(q) * 0.6 + n(q * 2.3 + 5.0) * 0.4;
          float a = (1.0 - d * d) * smoothstep(0.3, 0.8, k) * uDensity * vEdge * 0.3;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(quads(count, { aSeed: [rand4(count), 4] }), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  /** `density` 0–1; renk sisin rengiyle aynı (gece karanlık, sabah pembe-gri). */
  update(camera: THREE.Vector3, density: number, color: THREE.Color, dt: number): void {
    this.u.uDensity.value += (density - this.u.uDensity.value) * (1 - Math.exp(-dt * 0.8));
    this.mesh.visible = this.u.uDensity.value > 0.01;
    this.u.uCenter.value.copy(camera);
    this.u.uColor.value.copy(color).lerp(new THREE.Color(1, 1, 1), 0.25);
  }
}

// ---------------------------------------------------------------------------
// Mevsim parçacıkları: kameranın çevresinde süzülen sonbahar yaprakları, bahar yaprakları ya da yaz polenleri
// ---------------------------------------------------------------------------

const LEAF_BOX = 34;
const LEAF_LOOK: Partial<Record<Season, { colors: string[]; count: number; size: [number, number]; fall: number; glow: number }>> = {
  autumn: { colors: ["#d9822b", "#c4561f", "#e0a93a", "#a8442a", "#e8b04a"], count: 260, size: [0.16, 0.1], fall: 0.9, glow: 0 },
  spring: { colors: ["#f7a3bd", "#fbbcd0", "#ffd3e1", "#f4f1e6"], count: 200, size: [0.09, 0.07], fall: 0.6, glow: 0 },
  summer: { colors: ["#fff3b0", "#ffffff", "#f6f0c8"], count: 180, size: [0.035, 0.035], fall: -0.05, glow: 1 },
};

export class SeasonParticles {
  readonly mesh: THREE.Mesh | null = null;
  /** Yaz polenleri: yalnızca gündüz. */
  private glow = false;
  private u = { uCenter: { value: new THREE.Vector3() }, uLight: { value: 1 }, uWind: { value: 1 } };

  constructor(season: Season, low: boolean) {
    const look = LEAF_LOOK[season];
    if (!look) return;
    this.glow = !!look.glow;
    const count = Math.round(look.count * (low ? 0.4 : 1));
    const palette = look.colors.map((c) => new THREE.Color(c));
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) palette[i % palette.length].toArray(colors, i * 3);
    const material = new THREE.ShaderMaterial({
      uniforms: { ...this.u, uTime: timeUniform },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        attribute vec3 aColor;
        uniform vec3 uCenter;
        uniform float uTime;
        uniform float uWind;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vA;
        varying float vShade;
        void main() {
          vUv = uv;
          vColor = aColor;
          float H = 14.0;
          float y = mod(aSeed.y * H - uTime * ${look.fall.toFixed(2)} * (0.7 + aSeed.z * 0.6), H);
          // Rüzgârla yana savrulur, salınarak düşer
          vec2 drift = vec2(uTime * 0.6 * uWind, uTime * 0.25 * uWind) * (0.6 + aSeed.w);
          vec2 sway = vec2(sin(uTime * 1.3 + aSeed.x * 30.0), cos(uTime * 1.1 + aSeed.z * 20.0)) * 0.7;
          vec2 xz = aSeed.xz * ${LEAF_BOX.toFixed(1)} + drift + sway;
          vec2 wp = uCenter.xz + mod(xz - uCenter.xz + ${(LEAF_BOX / 2).toFixed(1)}, ${LEAF_BOX.toFixed(1)}) - ${(LEAF_BOX / 2).toFixed(1)};
          vec3 c = vec3(wp.x, y + 0.05, wp.y);
          // Takla: yaprak kendi ekseninde döner (yüzü ışığa dönünce parlar)
          float a1 = uTime * (1.5 + aSeed.w * 2.5) + aSeed.x * 6.28;
          float a2 = uTime * (0.9 + aSeed.z * 1.5) + aSeed.y * 6.28;
          vec3 p = vec3(position.x * ${look.size[0].toFixed(3)}, position.y * ${look.size[1].toFixed(3)}, 0.0);
          p = vec3(p.x * cos(a1) - p.z * sin(a1), p.y, p.x * sin(a1) + p.z * cos(a1));
          p = vec3(p.x, p.y * cos(a2) - p.z * sin(a2), p.y * sin(a2) + p.z * cos(a2));
          vShade = 0.65 + 0.35 * abs(cos(a1) * cos(a2));
          vec2 rel = abs(wp - uCenter.xz) / ${(LEAF_BOX / 2).toFixed(1)};
          vA = (1.0 - smoothstep(0.75, 1.0, max(rel.x, rel.y))) * smoothstep(0.0, 0.6, y) * (1.0 - smoothstep(H - 2.0, H, y));
          gl_Position = projectionMatrix * viewMatrix * vec4(c + p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uLight;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vA;
        varying float vShade;
        void main() {
          vec2 q = vUv * 2.0 - 1.0;
          ${look.glow
            ? "float d = dot(q, q); if (d > 1.0) discard; gl_FragColor = vec4(vColor * (0.6 + uLight), vA * (1.0 - d) * 0.8);"
            : "if (q.x * q.x + q.y * q.y * 2.2 > 1.0) discard; vec3 c = vColor * vShade * uLight; c *= 1.0 - 0.25 * step(abs(q.y), 0.05); gl_FragColor = vec4(c, vA);"}
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      ...(look.glow ? { blending: THREE.AdditiveBlending } : {}),
    });
    const mesh = new THREE.Mesh(quads(count, { aSeed: [rand4(count), 4], aColor: [colors, 3] }), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    this.mesh = mesh;
  }

  /**
   * `light`: gün ışığı (gece kararır; polenler yalnızca gündüz görünür), `wind` 0.5–2 (fırtınada sert),
   * `indoor`: kapalı salonda (voleybol) hiç görünmez.
   */
  update(camera: THREE.Vector3, light: number, wind: number, indoor = false): void {
    if (!this.mesh) return;
    this.u.uCenter.value.copy(camera);
    this.u.uLight.value = light;
    this.mesh.visible = !indoor && (!this.glow || light > 0.7);
    this.u.uWind.value += (wind - this.u.uWind.value) * 0.01;
  }
}

// ---------------------------------------------------------------------------
// Patlamalı parçacıklar (konfeti, su sıçraması): halka havuz, örnek başına bir kez yazılır
// ---------------------------------------------------------------------------

class Burst {
  readonly mesh: THREE.Mesh;
  private origin: THREE.InstancedBufferAttribute;
  private vel: THREE.InstancedBufferAttribute;
  private start: THREE.InstancedBufferAttribute;
  private color: THREE.InstancedBufferAttribute;
  private next = 0;

  constructor(
    private pool: number,
    vertexBody: string,
    fragment: string,
    extra: Record<string, THREE.IUniform> = {},
    additive = false,
  ) {
    const geo = quads(pool, {
      aOrigin: [new Float32Array(pool * 3), 3],
      aVel: [new Float32Array(pool * 3), 3],
      aStart: [new Float32Array(pool).fill(-1e5), 1],
      aColor: [new Float32Array(pool * 3), 3],
    });
    this.origin = geo.attributes.aOrigin as THREE.InstancedBufferAttribute;
    this.vel = geo.attributes.aVel as THREE.InstancedBufferAttribute;
    this.start = geo.attributes.aStart as THREE.InstancedBufferAttribute;
    this.color = geo.attributes.aColor as THREE.InstancedBufferAttribute;
    for (const a of [this.origin, this.vel, this.start, this.color]) a.setUsage(THREE.DynamicDrawUsage);
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: timeUniform, ...extra },
      vertexShader: /* glsl */ `
        attribute vec3 aOrigin;
        attribute vec3 aVel;
        attribute float aStart;
        attribute vec3 aColor;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vT;
        void main() {
          vUv = uv;
          vColor = aColor;
          float t = uTime - aStart;
          ${vertexBody}
        }
      `,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      ...(additive ? { blending: THREE.AdditiveBlending } : {}),
    });
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, t: number, c: THREE.Color): void {
    const i = this.next++ % this.pool;
    this.origin.setXYZ(i, x, y, z);
    this.vel.setXYZ(i, vx, vy, vz);
    this.start.setX(i, t);
    this.color.setXYZ(i, c.r, c.g, c.b);
    for (const a of [this.origin, this.vel, this.start, this.color]) a.needsUpdate = true;
  }
}

const CONFETTI_COLORS = ["#ff4d4d", "#ffd23f", "#4dff88", "#4dc3ff", "#d04dff", "#ffffff", "#ff8a3d", "#ff5fd2"].map((c) => new THREE.Color(c));

/** Gol (ve kutlama) konfetisi: yukarı saçılır, havada süzülüp döne döne düşer. */
export class Confetti {
  private b = new Burst(
    700,
    /* glsl */ `
      vT = t / 4.5;
      float tt = max(t, 0.0);
      // Hava sürtünmesi: hızla yavaşlar, sonra yaprak gibi süzülerek iner
      float k = (1.0 - exp(-2.2 * tt)) / 2.2;
      vec3 p = aOrigin + aVel * k + vec3(sin(tt * 3.0 + aColor.r * 20.0) * 0.4, -0.9 * tt, cos(tt * 2.5 + aColor.g * 20.0) * 0.4);
      p.y = max(p.y, 0.03);
      float a = tt * (4.0 + aColor.b * 6.0);
      vec3 q = vec3(position.x * 0.12, position.y * 0.07, 0.0);
      q = vec3(q.x * cos(a) - q.z * sin(a), q.y * cos(a * 0.7), q.x * sin(a) + q.y * sin(a * 0.7));
      gl_Position = (t < 0.0 || vT > 1.0) ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(p + q, 1.0);
    `,
    /* glsl */ `
      uniform float uLight;
      varying vec3 vColor;
      varying float vT;
      void main() {
        gl_FragColor = vec4(vColor * uLight, 1.0 - smoothstep(0.8, 1.0, vT));
      }
    `,
    { uLight: { value: 1 } },
  );
  readonly mesh = this.b.mesh;

  burst(x: number, y: number, z: number, t: number, count = 220): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, up = 5 + Math.random() * 7, out = 1.5 + Math.random() * 4.5;
      this.b.emit(x, y, z, Math.cos(a) * out, up, Math.sin(a) * out, t + Math.random() * 0.15, CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
    }
  }

  set light(v: number) {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uLight.value = v;
  }
}

/** Islak zeminde adım sıçraması: ayağın çevresinden küçük damlalar sıçrayıp düşer. */
export class Splashes {
  private b = new Burst(
    360,
    /* glsl */ `
      vT = t / 0.45;
      vec3 p = aOrigin + aVel * t + vec3(0.0, -9.8 * 0.5 * t * t, 0.0);
      vec4 mv = viewMatrix * vec4(p, 1.0);
      mv.xy += position.xy * vec2(0.025, 0.06);
      gl_Position = (t < 0.0 || vT > 1.0 || p.y < 0.0) ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
    `,
    /* glsl */ `
      uniform float uLight;
      varying vec2 vUv;
      varying float vT;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        if (d > 1.0) discard;
        gl_FragColor = vec4(vec3(0.8, 0.88, 1.0) * uLight, (1.0 - d) * (1.0 - vT) * 0.7);
      }
    `,
    { uLight: { value: 1 } },
  );
  readonly mesh = this.b.mesh;
  private white = new THREE.Color(1, 1, 1);

  step(x: number, z: number, t: number, strength: number): void {
    const n = Math.round(4 + strength * 5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 0.5 + Math.random() * 1.1;
      this.b.emit(x + Math.cos(a) * 0.12, 0.03, z + Math.sin(a) * 0.12, Math.cos(a) * s, 1.4 + Math.random() * 1.6 * strength, Math.sin(a) * s, t, this.white);
    }
  }

  set light(v: number) {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uLight.value = v;
  }
}

// ---------------------------------------------------------------------------
// Sahne dumanı: ışık şovu sırasında sahnenin üstünde ağır ağır dolaşan duman (ışık konileri içinde parlar)
// ---------------------------------------------------------------------------

export class StageHaze {
  readonly mesh: THREE.Mesh;
  private u = { uLevel: { value: 0 }, uColor: { value: new THREE.Color(0.75, 0.78, 0.9) } };

  constructor(count = 26) {
    const material = new THREE.ShaderMaterial({
      uniforms: { ...this.u, uTime: timeUniform },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime;
        varying vec2 vUv;
        varying float vA;
        void main() {
          vUv = uv;
          float t = fract(uTime * (0.03 + aSeed.w * 0.03) + aSeed.x);
          vec3 c = vec3(
            ${(-STAGE.hw + 2).toFixed(1)} + aSeed.y * ${((STAGE.hw - 2) * 2).toFixed(1)} + sin(uTime * 0.2 + aSeed.z * 9.0) * 1.5,
            ${(STAGE.h + 0.5).toFixed(2)} + t * 3.5,
            ${(STAGE.z - 1).toFixed(2)} + aSeed.z * 5.0 + t * 3.0);
          vA = sin(t * 3.1416);
          vec4 mv = viewMatrix * vec4(c, 1.0);
          mv.xy += position.xy * (2.2 + t * 3.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uLevel;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying float vA;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          if (d > 1.0) discard;
          gl_FragColor = vec4(uColor, (1.0 - d) * (1.0 - d) * vA * uLevel * 0.16);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(quads(count, { aSeed: [rand4(count), 4] }), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  /** `on` ışık şovu var; `night` 0–1 (gündüz duman daha az görünür). */
  update(on: boolean, night: number, dt: number): void {
    const target = on ? 0.5 + 0.5 * night : 0;
    this.u.uLevel.value += (target - this.u.uLevel.value) * (1 - Math.exp(-dt * 0.8));
    this.mesh.visible = this.u.uLevel.value > 0.01;
    this.u.uColor.value.setRGB(0.75, 0.78, 0.9).multiplyScalar(0.5 + 0.5 * (1 - night));
  }
}
