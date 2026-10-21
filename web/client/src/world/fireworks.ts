// Havai fişek: roket yükselir, patlar, kıvılcımlar çekimle düşüp söner. Herkes aynı tohumla aynı gösteriyi görür.
// Tek Points nesnesi; her patlama attribute'lara bir kez yazılır, hareket tamamen vertex shader'da.
import * as THREE from "three";
import { rng, timeUniform } from "./geo";

const BURSTS = 24;
const SPARKS = 140;
const PER = SPARKS + 1; // + roket
const RISE = 1.1;
const LIFE = 2.6;

const COLORS = ["#ff4d4d", "#ffd23f", "#4dff88", "#4dc3ff", "#d04dff", "#ffffff", "#ff8a3d", "#ff5fd2"].map((c) => new THREE.Color(c));

export class Fireworks {
  readonly points: THREE.Points;
  /** Patlama anı (sn, döngü saati) ve konumu: ses için. */
  onBurst: (delay: number, x: number, y: number, z: number) => void = () => {};
  private next = 0;
  private start: THREE.BufferAttribute;
  private origin: THREE.BufferAttribute;
  private vel: THREE.BufferAttribute;
  private color: THREE.BufferAttribute;
  private kind: THREE.BufferAttribute;
  private timers: number[] = [];

  constructor() {
    const n = BURSTS * PER;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.start = new THREE.BufferAttribute(new Float32Array(n).fill(-1e5), 1);
    this.origin = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.vel = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.color = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.kind = new THREE.BufferAttribute(new Float32Array(n), 1);
    for (const a of [this.start, this.origin, this.vel, this.color, this.kind]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aStart", this.start);
    g.setAttribute("aOrigin", this.origin);
    g.setAttribute("aVel", this.vel);
    g.setAttribute("aColor", this.color);
    g.setAttribute("aKind", this.kind);
    const material = new THREE.ShaderMaterial({
      uniforms: { uTime: timeUniform, uScale: { value: innerHeight / 2 } },
      vertexShader: /* glsl */ `
        attribute float aStart;
        attribute vec3 aOrigin;
        attribute vec3 aVel;
        attribute vec3 aColor;
        attribute float aKind;
        uniform float uTime;
        uniform float uScale;
        varying vec3 vColor;
        varying float vA;
        void main() {
          float t = uTime - aStart;
          vec3 p;
          float a;
          if (aKind > 0.5) {
            // Roket: yerden patlama noktasına, sonra söner
            float k = clamp((t + ${RISE.toFixed(2)}) / ${RISE.toFixed(2)}, 0.0, 1.0);
            p = mix(vec3(aOrigin.x, 0.5, aOrigin.z), aOrigin, 1.0 - (1.0 - k) * (1.0 - k));
            a = (t < 0.0 && t > -${RISE.toFixed(2)}) ? 1.0 : 0.0;
            vColor = vec3(1.0, 0.8, 0.5);
          } else {
            // Kıvılcım: hava sürtünmesiyle yavaşlar, yerçekimiyle düşer
            float tt = max(t, 0.0);
            float drag = (1.0 - exp(-1.6 * tt)) / 1.6;
            p = aOrigin + aVel * drag + vec3(0.0, -2.2 * tt * tt, 0.0);
            float life = tt / ${LIFE.toFixed(2)};
            a = (t >= 0.0 && life < 1.0) ? (1.0 - life) * (0.7 + 0.3 * sin(uTime * 30.0 + aVel.x * 9.0)) : 0.0;
            vColor = aColor * (1.0 + 2.0 * exp(-tt * 6.0));
          }
          vA = a;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = a > 0.0 ? clamp((aKind > 0.5 ? 1.4 : 1.15) * uScale / -mv.z, 2.5, 36.0) : 0.0;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord * 2.0 - 1.0);
          if (d > 1.0) discard;
          // Parlak çekirdek, yumuşak hale
          float a = (pow(1.0 - d, 1.5) + 0.6 * step(d, 0.25)) * vA;
          gl_FragColor = vec4(vColor * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    addEventListener("resize", () => (material.uniforms.uScale.value = innerHeight / 2));
    this.points = new THREE.Points(g, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
  }

  /**
   * Gösteri: `count` patlama, `startAt` (sn, döngü saati) itibarıyla ~0.6 sn arayla. Konumlar meydanın
   * üstünde, sinemaya doğru yayılır.
   */
  show(seed: number, startAt: number, count: number): void {
    const r = rng(seed);
    const now = performance.now() / 1000;
    for (let k = 0; k < count; k++) {
      const at = startAt + k * (0.35 + r() * 0.5) + (count > 20 ? Math.floor(k / 8) * 1.5 : 0);
      const x = (r() - 0.5) * 60, z = -10 - r() * 40, y = 28 + r() * 18;
      const c1 = COLORS[Math.floor(r() * COLORS.length)], c2 = COLORS[Math.floor(r() * COLORS.length)];
      const ring = r() < 0.3;
      const speed = 12 + r() * 8;
      const seeds = Array.from({ length: SPARKS * 3 }, () => r());
      // Yazmayı patlama yaklaşınca yap: havuz dönerken eski gösterinin kıvılcımları kesilmesin
      const delay = Math.max(0, at - RISE - now - 0.1);
      this.timers.push(window.setTimeout(() => this.write(at, x, y, z, c1, c2, ring, speed, seeds), delay * 1000));
      this.onBurst(at - now, x, y, z);
    }
  }

  private write(at: number, x: number, y: number, z: number, c1: THREE.Color, c2: THREE.Color, ring: boolean, speed: number, seeds: number[]): void {
    const base = (this.next++ % BURSTS) * PER;
    const v = new THREE.Vector3();
    for (let i = 0; i < PER; i++) {
      const idx = base + i;
      this.start.setX(idx, at);
      this.origin.setXYZ(idx, x, y, z);
      this.kind.setX(idx, i === SPARKS ? 1 : 0);
      if (i === SPARKS) continue;
      const u = seeds[i * 3], w = seeds[i * 3 + 1], j = seeds[i * 3 + 2];
      // Küre (ya da halka) üzerinde düzgün dağılım
      const th = u * Math.PI * 2;
      const ph = ring ? Math.PI / 2 + (w - 0.5) * 0.15 : Math.acos(2 * w - 1);
      v.set(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)).multiplyScalar(speed * (0.8 + j * 0.3));
      this.vel.setXYZ(idx, v.x, v.y, v.z);
      const c = j < 0.5 ? c1 : c2;
      this.color.setXYZ(idx, c.r, c.g, c.b);
    }
    for (const a of [this.start, this.origin, this.vel, this.color, this.kind]) {
      a.clearUpdateRanges();
      a.addUpdateRange(base * a.itemSize, PER * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const t of this.timers) window.clearTimeout(t);
  }
}
