// Gece: lambalar çevresini gerçekten aydınlatır, zeminde sıcak ışık havuzları, ağaçlıklarda ateş böcekleri, gökte ay.
// Gerçek ışık yalnızca oyuncuya en yakın birkaç lambada (havuzdaki PointLight'lar oraya taşınır);
// uzaktakiler ucuz toplamalı zemin lekesiyle aydınlanır. Işık sayısı sabit kalır: shader yeniden derlenmez.
import { listen } from "../mode";
import * as THREE from "three";
import { timeUniform } from "./geo";

/** Köy patikalarındaki kısa lambanın ampul yüksekliği (scene.ts'teki "bulb"); şehir ve mahalle lambaları daha uzun. */
const BULB_Y = 2.7;
/** Gerçek ışığın tam güçte olduğu ve tamamen söndüğü oyuncu mesafesi. */
const LIT_NEAR = 24;
const LIT_FAR = 36;
const WARM = new THREE.Color("#ffc27a");
const FIRE = new THREE.Color("#ff8a3a");

export interface NightOptions {
  /** Lamba ve meşale ampullerinin dönüşümleri. */
  bulbs: THREE.Matrix4[];
  flames: THREE.Matrix4[];
  /** Ateş böceklerinin toplandığı yerler: [x, z, yarıçap]. */
  swarms: [number, number, number][];
  /** Gerçek ışık sayısı (zayıf cihazda 0). */
  lights: number;
  /** Zemindeki ışık lekeleri (bütün lambalar gerçek ışık verirken gerekmez, bkz. lamps.ts). */
  pools?: boolean;
  skyRadius: number;
  /** Ay yönü (gece ışığının geldiği yer). */
  moonDir: THREE.Vector3;
}

interface Lamp {
  x: number;
  y: number;
  z: number;
  fire: boolean;
}

/** Zemindeki sıcak ışık lekeleri: tek draw call, toplamalı. Oyuncunun yakınında gerçek ışık devralır. */
function poolMesh(lamps: Lamp[], realLights: boolean): { mesh: THREE.InstancedMesh; opacity: { value: number }; focus: { value: THREE.Vector2 } } {
  const opacity = { value: 0 };
  const focus = { value: new THREE.Vector2() };
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const tint = new Float32Array(lamps.length * 3);
  lamps.forEach((l, i) => (l.fire ? FIRE : WARM).toArray(tint, i * 3));
  geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: { uOpacity: opacity, uFocus: focus },
    vertexShader: /* glsl */ `
      attribute vec3 aTint;
      uniform vec2 uFocus;
      varying vec2 vLocal;
      varying vec3 vTint;
      varying float vFade;
      void main() {
        vLocal = uv * 2.0 - 1.0;
        vTint = aTint;
        vec4 wp = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vFade = ${realLights ? `0.35 + 0.65 * smoothstep(${LIT_NEAR.toFixed(1)}, ${LIT_FAR.toFixed(1)}, distance(wp.xz, uFocus))` : "1.0"};
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec2 vLocal;
      varying vec3 vTint;
      varying float vFade;
      void main() {
        float d = dot(vLocal, vLocal);
        if (d > 1.0) discard;
        float a = pow(1.0 - d, 2.2) * uOpacity * vFade;
        gl_FragColor = vec4(vTint * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const m = new THREE.InstancedMesh(geo, material, lamps.length);
  const mm = new THREE.Matrix4();
  // Uzun lambanın ışık lekesi daha geniş
  lamps.forEach((l, i) => {
    const r = l.fire ? 5 : 8.5 * Math.max(1, (l.y / BULB_Y) * 0.8);
    m.setMatrixAt(i, mm.makeScale(r, 1, r).setPosition(l.x, 0.05, l.z));
  });
  m.computeBoundingSphere();
  m.matrixAutoUpdate = false;
  m.renderOrder = 1;
  return { mesh: m, opacity, focus };
}

/** Ateş böcekleri: süzülen, yanıp sönen sarı-yeşil noktalar (tamamen vertex shader). */
function fireflies(swarms: [number, number, number][], opacity: { value: number }): THREE.Points {
  const per = 34;
  const n = swarms.length * per;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  let s = 11;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  swarms.forEach(([x, z, r], k) => {
    for (let i = 0; i < per; i++) {
      const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r;
      pos.set([x + Math.cos(a) * d, 0.4 + rand() * 2.2, z + Math.sin(a) * d], (k * per + i) * 3);
      seed[k * per + i] = rand();
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, uOpacity: opacity, uScale: { value: innerHeight / 2 } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uScale;
      varying float vA;
      void main() {
        float t = uTime * (0.25 + aSeed * 0.2) + aSeed * 60.0;
        vec3 p = position + vec3(sin(t * 1.3) * 0.9, sin(t * 0.9 + aSeed * 4.0) * 0.35, cos(t * 1.1) * 0.9);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        // Ara ara parlar: keskin yanıp sönme
        vA = pow(max(0.0, sin(uTime * (1.2 + aSeed) + aSeed * 30.0)), 6.0);
        gl_PointSize = clamp(0.16 * uScale / -mv.z, 1.5, 14.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord * 2.0 - 1.0);
        if (d > 1.0) discard;
        float a = (1.0 - d) * (1.0 - d) * (0.25 + 0.75 * vA) * uOpacity;
        gl_FragColor = vec4(vec3(0.85, 1.0, 0.45) * a * 1.6, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(g, material);
  p.frustumCulled = false;
  p.matrixAutoUpdate = false;
  p.renderOrder = 6;
  listen("resize", () => (material.uniforms.uScale.value = innerHeight / 2));
  return p;
}

/** Ay: hale ile yumuşak disk; gökyüzünün önünde, sisten etkilenmez. */
function moonMesh(dir: THREE.Vector3, radius: number, opacity: { value: number }): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: { uOpacity: opacity },
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      void main() {
        vLocal = uv * 2.0 - 1.0;
        vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        gl_Position = projectionMatrix * (center + vec4(position.xy * 26.0, 0.0, 0.0));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec2 vLocal;
      void main() {
        float d = length(vLocal);
        float disc = 1.0 - smoothstep(0.24, 0.26, d);
        // Hafif lekeler: iki koyu daire
        float mare = smoothstep(0.09, 0.02, length(vLocal - vec2(-0.07, 0.05))) * 0.12 + smoothstep(0.06, 0.0, length(vLocal - vec2(0.08, -0.06))) * 0.1;
        vec3 c = vec3(0.93, 0.95, 1.0) * (1.0 - mare);
        float halo = pow(max(0.0, 1.0 - d), 3.0) * 0.35;
        float a = max(disc, halo) * uOpacity;
        gl_FragColor = vec4(mix(vec3(0.55, 0.65, 1.0), c, disc) * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  m.position.copy(dir).normalize().multiplyScalar(radius * 0.9);
  m.updateMatrix();
  m.matrixAutoUpdate = false;
  m.frustumCulled = false;
  m.renderOrder = -0.5;
  return m;
}

export class NightFx {
  readonly group = new THREE.Group();
  private lamps: Lamp[] = [];
  private pool: THREE.PointLight[] = [];
  private pools: ReturnType<typeof poolMesh>;
  private flyOpacity = { value: 0 };
  private moonOpacity = { value: 0 };
  private flies: THREE.Points;
  private moon: THREE.Mesh;
  private order: number[] = [];
  private showPools: boolean;
  private lastPick = -Infinity;
  private v = new THREE.Vector3();

  constructor(o: NightOptions) {
    for (const [list, fire] of [[o.bulbs, false], [o.flames, true]] as const) {
      for (const m of list) {
        this.v.setFromMatrixPosition(m);
        // Işık ampulün gerçek yüksekliğinde (şehir ve mahalle lambaları 5–6 m: ışık direğin ortasından çıkmasın)
        this.lamps.push({ x: this.v.x, y: fire ? this.v.y + 0.3 : Math.max(BULB_Y, this.v.y), z: this.v.z, fire });
      }
    }
    this.pools = poolMesh(this.lamps, o.lights > 0);
    this.showPools = o.pools ?? true;
    for (let i = 0; i < o.lights; i++) {
      const l = new THREE.PointLight(WARM, 0, 11, 1.6);
      this.pool.push(l);
      this.group.add(l);
    }
    this.flies = fireflies(o.swarms, this.flyOpacity);
    this.moon = moonMesh(o.moonDir, o.skyRadius, this.moonOpacity);
    this.moon.userData.sky = true;
    this.group.add(this.pools.mesh, this.flies, this.moon);
    this.order = this.lamps.map((_, i) => i);
  }

  /**
   * Kare başına. `lights`: lambaların yanma oranı (0 gündüz, 1 gece), `x/z` oyuncu.
   * Hangi lambanın gerçek ışık alacağı 4 Hz seçilir; ışık gücü mesafeyle söner (geçişte patlama olmaz).
   */
  update(time: number, lights: number, x: number, z: number): void {
    const on = lights > 0.01;
    // Işıklar hep sahnede kalır (yalnızca güçleri sıfırlanır): sayıları değişirse bütün shader'lar yeniden derlenir.
    this.pools.mesh.visible = on && this.showPools;
    this.flies.visible = this.moon.visible = on;
    this.pools.opacity.value = lights * 0.55;
    this.pools.focus.value.set(x, z);
    this.flyOpacity.value = lights;
    this.moonOpacity.value = lights;
    if (!on) {
      for (const l of this.pool) l.intensity = 0;
      return;
    }
    if (time - this.lastPick > 0.25 && this.pool.length) {
      this.lastPick = time;
      const d = (i: number) => (this.lamps[i].x - x) ** 2 + (this.lamps[i].z - z) ** 2;
      this.order.sort((a, b) => d(a) - d(b));
    }
    this.pool.forEach((l, k) => {
      const lamp = this.lamps[this.order[k]];
      if (!lamp) {
        l.intensity = 0;
        return;
      }
      const dist = Math.hypot(lamp.x - x, lamp.z - z);
      const fade = 1 - THREE.MathUtils.smoothstep(dist, LIT_NEAR, LIT_FAR);
      // Meşale titrer
      const flick = lamp.fire ? 0.8 + 0.2 * Math.sin(time * 13 + lamp.x) * Math.sin(time * 7.7 + lamp.z) : 1;
      l.position.set(lamp.x, lamp.y - 0.25, lamp.z);
      l.color.copy(lamp.fire ? FIRE : WARM);
      // Uzun lamba daha geniş alanı aydınlatır (yükseklikle menzil ve güç artar)
      const tall = lamp.fire ? 1 : lamp.y / BULB_Y;
      l.distance = 11 * Math.max(1, tall * 0.85);
      l.intensity = lights * fade * flick * (lamp.fire ? 5 : 9 * tall * tall * 0.8 + 1.8);
    });
  }
}
