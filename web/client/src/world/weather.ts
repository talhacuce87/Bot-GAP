// Hava efektleri: yağmur çizgileri ve kar taneleri kameranın çevresinde "sarılan" bir kutuda düşer (çimen gibi),
// fırtınada ara ara şimşek. Hepsi vertex shader'da; CPU yalnızca birkaç uniform yazar.
import * as THREE from "three";
import type { Weather } from "../../../shared/protocol";
import { timeUniform } from "./geo";

const BOX = 36;
const HEIGHT = 22;

function precipitation(count: number, snow: boolean): { mesh: THREE.Mesh; uniforms: { uCenter: { value: THREE.Vector3 }; uAmount: { value: number }; uLight: { value: number } } } {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.setAttribute("position", quad.attributes.position);
  geo.setAttribute("uv", quad.attributes.uv);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 4));
  geo.instanceCount = count;
  const uniforms = { uCenter: { value: new THREE.Vector3() }, uAmount: { value: 0 }, uLight: { value: 1 } };
  const material = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uTime: timeUniform },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform vec3 uCenter;
      uniform float uAmount;
      uniform float uTime;
      varying vec2 vUv;
      varying float vA;
      void main() {
        vUv = uv;
        // Miktara göre örneklerin bir kısmı görünür
        float on = step(aSeed.w, uAmount);
        float speed = ${snow ? "1.3 + aSeed.z * 0.8" : "16.0 + aSeed.z * 6.0"};
        float y = mod(aSeed.y * ${HEIGHT.toFixed(1)} - uTime * speed, ${HEIGHT.toFixed(1)});
        vec2 xz = aSeed.xz * ${BOX.toFixed(1)};
        vec2 wp = uCenter.xz + mod(xz - uCenter.xz + ${(BOX / 2).toFixed(1)}, ${BOX.toFixed(1)}) - ${(BOX / 2).toFixed(1)};
        ${snow ? "wp += vec2(sin(uTime * 0.9 + aSeed.x * 40.0), cos(uTime * 0.7 + aSeed.y * 30.0)) * 0.6;" : "wp.x += y * 0.08;"}
        vec3 p = vec3(wp.x, y + uCenter.y - 4.0, wp.y);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        ${snow
          ? "vec2 size = vec2(0.07 + aSeed.z * 0.05);"
          : "vec2 size = vec2(0.018, 0.55 + aSeed.z * 0.35);"}
        mv.xy += position.xy * size * on;
        vA = on * smoothstep(0.0, 2.0, y) * (1.0 - smoothstep(${(HEIGHT - 3).toFixed(1)}, ${HEIGHT.toFixed(1)}, y));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLight;
      varying vec2 vUv;
      varying float vA;
      void main() {
        ${snow
          ? "float d = length(vUv - 0.5) * 2.0; if (d > 1.0) discard; float a = (1.0 - d * d) * vA * 0.9; gl_FragColor = vec4(vec3(1.0) * uLight, a);"
          : "float a = (1.0 - abs(vUv.x - 0.5) * 2.0) * vA * 0.38; gl_FragColor = vec4(vec3(0.75, 0.8, 0.9) * uLight, a);"}
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  return { mesh, uniforms: material.uniforms as unknown as typeof uniforms };
}

export class WeatherFx {
  readonly group = new THREE.Group();
  /** 0–1: şimşek anı (sahne ışıkları kısa süre parlar). */
  flash = 0;
  /** Şimşek çaktı (ses için). */
  onThunder: () => void = () => {};
  private rain: ReturnType<typeof precipitation>;
  private snow: ReturnType<typeof precipitation>;
  private w: Weather = { kind: "clear", intensity: 0, cloud: 0.2, temp: null };
  private rainAmount = 0;
  private snowAmount = 0;
  private nextBolt = 0;

  constructor(low: boolean) {
    this.rain = precipitation(low ? 1500 : 5000, false);
    this.snow = precipitation(low ? 1200 : 3500, true);
    this.group.add(this.rain.mesh, this.snow.mesh);
  }

  set(w: Weather): void {
    this.w = w;
  }

  get current(): Weather {
    return this.w;
  }

  /** `light`: gece kararması (0.3 gece – 1 gündüz). */
  update(time: number, dt: number, camera: THREE.Vector3, light: number): void {
    const w = this.w;
    const rainT = w.kind === "rain" || w.kind === "storm" ? 0.35 + 0.65 * w.intensity : 0;
    const snowT = w.kind === "snow" ? 0.35 + 0.65 * w.intensity : 0;
    // Geçişler yumuşak: yağmur yavaş başlar, yavaş diner
    this.rainAmount += (rainT - this.rainAmount) * Math.min(1, dt * 0.4);
    this.snowAmount += (snowT - this.snowAmount) * Math.min(1, dt * 0.4);
    for (const [p, a] of [[this.rain, this.rainAmount], [this.snow, this.snowAmount]] as const) {
      p.mesh.visible = a > 0.01;
      p.uniforms.uAmount.value = a;
      p.uniforms.uCenter.value.copy(camera);
      p.uniforms.uLight.value = light + this.flash;
    }
    // Fırtına: 5–14 sn'de bir şimşek, iki hızlı parlama
    this.flash = Math.max(0, this.flash - dt * 4);
    if (w.kind === "storm") {
      if (!this.nextBolt) this.nextBolt = time + 3;
      if (time > this.nextBolt) {
        this.nextBolt = time + 5 + Math.random() * 9;
        this.flash = 1;
        window.setTimeout(() => (this.flash = 0.8), 160);
        this.onThunder();
      }
    } else this.nextBolt = 0;
  }
}
