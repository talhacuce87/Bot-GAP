// Gece ışığı: dünyadaki BÜTÜN lambalar gerçek ışık verir (yalnızca en yakın birkaçı değil) ve arabaların farları
// önlerini gerçekten aydınlatır. Yöntem (tarayıcı oyunlarının "ızgaralı ışık" yolu): dünya 24 m'lik hücrelere
// bölünür, her hücreye ışığı düşen lambaların listesi bir dokuya yazılır; her yüzey yalnızca kendi hücresindeki
// lambaları hesaplar. Malzemelere shader eklemesiyle bağlanır (Lambert/Standard/Phong); gündüz hesap atlanır.
// Sokak lambası aşağı bakar (dibi parlak, kenarı yumuşak söner); far üst kenarı keskin, yana yayılan huzme.
// Yağmurda ıslak yüzeyler lamba ve farları parlak yansıtır.
import * as THREE from "three";
import { WORLD_BOUNDS } from "../../../shared/constants";
import { CITY } from "../../../shared/zones";
import { HOOD_BOX } from "../../../shared/build";
import { RACE_AREA } from "../../../shared/ring";
import { wetUniform } from "./geo";

/** Izgara hücresi (m) ve hücre başına en çok lamba. */
const CELL = 24;
const PER_CELL = 12;
/** Aynı anda en çok bu kadar arabanın farı (en yakınlar). */
export const MAX_CARS = 8;
/** Farın menzili (m) ve gücü. */
const HEAD_RANGE = 45;
const HEAD_POWER = 120;

/** Işık renkleri: köyde sıcak sodyum, şehir ve mahallede beyazımsı LED, meşale ateş. */
const SODIUM = new THREE.Color("#ffb46e");
const LED = new THREE.Color("#fff0dc");
const FIRE = new THREE.Color("#ff8a3a");

export interface Lamp {
  x: number;
  y: number;
  z: number;
  fire: boolean;
}

export interface Headlight {
  /** Farların ortası (dünya) ve baktığı yön (birim, yatay). */
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  color: THREE.Color;
}

/** Lambalar: sokak lambası ampulleri ve meşaleler (sahnedeki "bulb" ve "flame" dönüşümlerinden). */
export function lampsFrom(bulbs: THREE.Matrix4[], flames: THREE.Matrix4[]): Lamp[] {
  const v = new THREE.Vector3(), out: Lamp[] = [];
  for (const m of bulbs) out.push({ ...v.setFromMatrixPosition(m), fire: false });
  for (const m of flames) {
    v.setFromMatrixPosition(m);
    out.push({ x: v.x, y: v.y + 0.3, z: v.z, fire: true });
  }
  return out.map(({ x, y, z, fire }) => ({ x, y, z, fire }));
}

const GLSL_COMMON = /* glsl */ `
  uniform highp sampler2D uLampGrid;
  uniform highp sampler2D uLampData;
  uniform vec4 uLampArea;
  uniform vec2 uLampDims;
  uniform float uLampNight;
  uniform float uLampWet;
  uniform vec4 uCarPos[${MAX_CARS}];
  uniform vec4 uCarDir[${MAX_CARS}];
  uniform vec3 uCarCol[${MAX_CARS}];
  uniform int uCarCount;
  varying vec3 vLampW;

  // Yumuşak pencere: menzilin sonunda tam sıfır (hücre sınırında ışık kesilmez)
  float lampWindow(float d, float range) {
    float r = d / range;
    float w = clamp(1.0 - r * r * r * r, 0.0, 1.0);
    return w * w;
  }
`;

const GLSL_APPLY = /* glsl */ `
  if (uLampNight > 0.001) {
    vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    vec3 vW = normalize(cameraPosition - vLampW);
    vec3 lampSum = vec3(0.0);
    vec3 lampSpec = vec3(0.0);
    float gloss = 0.08 + uLampWet * 1.6;
    float shin = mix(18.0, 90.0, uLampWet);
    ivec2 cell = ivec2(floor((vLampW.xz - uLampArea.xy) / uLampArea.z));
    if (cell.x >= 0 && cell.y >= 0 && cell.x < int(uLampDims.x) && cell.y < int(uLampDims.y)) {
      for (int k = 0; k < ${PER_CELL}; k++) {
        float idx = texelFetch(uLampGrid, ivec2(cell.x * ${PER_CELL} + k, cell.y), 0).r;
        if (idx < 0.5) break;
        vec4 p = texelFetch(uLampData, ivec2(int(idx) - 1, 0), 0);
        vec4 c = texelFetch(uLampData, ivec2(int(idx) - 1, 1), 0);
        vec3 L = p.xyz - vLampW;
        float d = length(L);
        if (d > p.w) continue;
        vec3 l = L / d;
        // Aşağı bakan lamba: tam altı en parlak, yanlara doğru söner (duvarlar da biraz alır)
        float down = mix(0.18, 1.0, smoothstep(0.05, 0.85, l.y));
        float att = c.a * lampWindow(d, p.w) / (d * d + 1.0) * down;
        lampSum += c.rgb * att * max(dot(nW, l), 0.0);
        vec3 h = normalize(l + vW);
        lampSpec += c.rgb * att * pow(max(dot(nW, h), 0.0), shin) * gloss;
      }
    }
    // Farlar: kısa huzme; yana geniş, dikeyde dar, üst kenarı keskin (karşıdakinin gözünü almaz)
    for (int i = 0; i < ${MAX_CARS}; i++) {
      if (i >= uCarCount) break;
      vec3 L = uCarPos[i].xyz - vLampW;
      float d = length(L);
      if (d > uCarPos[i].w) continue;
      vec3 l = L / d;
      vec3 fwd = uCarDir[i].xyz;
      vec3 ray = -l;
      float along = dot(ray, fwd);
      if (along <= 0.0) continue;
      vec3 right = normalize(vec3(fwd.z, 0.0, -fwd.x));
      float side = dot(ray, right) / along;
      float lift = ray.y / along;
      float beam = (1.0 - smoothstep(0.45, 0.75, abs(side))) * (1.0 - smoothstep(-0.005, 0.02, lift - 0.0)) * smoothstep(-0.6, -0.12, lift);
      // Merkez daha parlak (gerçek far deseni), yakında yumuşak
      beam *= 0.55 + 0.45 * (1.0 - smoothstep(0.0, 0.4, abs(side)));
      // Yola çok yatık düşen ışık Lambert'te sıfıra iner (yol kısa aydınlanırdı): yarım Lambert
      float att = uCarDir[i].w * beam * lampWindow(d, uCarPos[i].w) / (d * d * 0.25 + 4.0);
      float wrap = dot(nW, l) * 0.5 + 0.5;
      lampSum += uCarCol[i] * att * wrap * wrap;
      vec3 h = normalize(l + vW);
      lampSpec += uCarCol[i] * att * pow(max(dot(nW, h), 0.0), shin) * gloss;
    }
    // Lambert ışığı π'ye bölünür (ay ve güneşle aynı ölçek); parlama Lambert'te ayrı toplanmadığından buraya
    reflectedLight.directDiffuse += (diffuseColor.rgb * RECIPROCAL_PI * lampSum + lampSpec * 0.35) * uLampNight;
  }
`;

export class LampField {
  readonly uniforms = {
    uLampGrid: { value: null as THREE.DataTexture | null },
    uLampData: { value: null as THREE.DataTexture | null },
    uLampArea: { value: new THREE.Vector4() },
    uLampDims: { value: new THREE.Vector2() },
    uLampNight: { value: 0 },
    uLampWet: wetUniform,
    uCarPos: { value: Array.from({ length: MAX_CARS }, () => new THREE.Vector4()) },
    uCarDir: { value: Array.from({ length: MAX_CARS }, () => new THREE.Vector4()) },
    uCarCol: { value: Array.from({ length: MAX_CARS }, () => new THREE.Color()) },
    uCarCount: { value: 0 },
  };
  private patched = new WeakSet<THREE.Material>();

  constructor(lamps: Lamp[]) {
    const area = {
      minX: HOOD_BOX.minX - 30,
      maxX: CITY.maxX + 30,
      minZ: Math.min(RACE_AREA.minZ, HOOD_BOX.minZ, WORLD_BOUNDS.minZ) - 30,
      maxZ: Math.max(WORLD_BOUNDS.maxZ, HOOD_BOX.maxZ) + 30,
    };
    const cols = Math.ceil((area.maxX - area.minX) / CELL), rows = Math.ceil((area.maxZ - area.minZ) / CELL);
    // Lamba verisi: 1. satır konum + menzil, 2. satır renk + güç
    const n = Math.max(1, lamps.length);
    const data = new Float32Array(n * 2 * 4);
    const ranges: number[] = [];
    lamps.forEach((l, i) => {
      const tall = Math.max(1, l.y / 2.7);
      const range = l.fire ? 11 : 13 * tall;
      const inTown = (l.x > CITY.minX - 6 && l.x < CITY.maxX + 6) || (l.x < HOOD_BOX.maxX + 6 && l.x > HOOD_BOX.minX - 6);
      const color = l.fire ? FIRE : inTown ? LED : SODIUM;
      const power = l.fire ? 7 : 9 * tall * tall;
      data.set([l.x, l.y - 0.2, l.z, range], i * 4);
      data.set([color.r, color.g, color.b, power], (n + i) * 4);
      ranges.push(range);
    });
    const dataTex = new THREE.DataTexture(data, n, 2, THREE.RGBAFormat, THREE.FloatType);
    dataTex.needsUpdate = true;
    // Izgara: her hücreye menzili değen lambalar (doluysa hücre merkezine en yakınları)
    const grid = new Float32Array(cols * PER_CELL * rows * 4);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const x0 = area.minX + cx * CELL, z0 = area.minZ + cy * CELL, mx = x0 + CELL / 2, mz = z0 + CELL / 2;
        const hits: [number, number][] = [];
        lamps.forEach((l, i) => {
          const dx = Math.max(x0 - l.x, 0, l.x - (x0 + CELL)), dz = Math.max(z0 - l.z, 0, l.z - (z0 + CELL));
          if (dx * dx + dz * dz < ranges[i] * ranges[i]) hits.push([i, (l.x - mx) ** 2 + (l.z - mz) ** 2]);
        });
        hits.sort((a, b) => a[1] - b[1]);
        hits.slice(0, PER_CELL).forEach(([i], k) => (grid[((cy * cols + cx) * PER_CELL + k) * 4] = i + 1));
      }
    }
    const gridTex = new THREE.DataTexture(grid, cols * PER_CELL, rows, THREE.RGBAFormat, THREE.FloatType);
    gridTex.needsUpdate = true;
    this.uniforms.uLampGrid.value = gridTex;
    this.uniforms.uLampData.value = dataTex;
    this.uniforms.uLampArea.value.set(area.minX, area.minZ, CELL, PER_CELL);
    this.uniforms.uLampDims.value.set(cols, rows);
  }

  /** Lambaların yanma oranı (0 gündüz, 1 gece). */
  setNight(n: number): void {
    this.uniforms.uLampNight.value = n;
  }

  /** Bu karenin farları (en yakınlar önde; fazlası atılır). */
  setHeadlights(list: Headlight[]): void {
    const u = this.uniforms, n = Math.min(MAX_CARS, list.length);
    for (let i = 0; i < n; i++) {
      const h = list[i];
      u.uCarPos.value[i].set(h.x, h.y, h.z, HEAD_RANGE);
      const len = Math.hypot(h.dx, 0.06, h.dz) || 1;
      u.uCarDir.value[i].set(h.dx / len, -0.06 / len, h.dz / len, HEAD_POWER);
      u.uCarCol.value[i].copy(h.color);
    }
    u.uCarCount.value = n;
  }

  /** Malzemeye gece ışığını ekler (bir kez; önceki shader eklemeleri korunur). */
  patch(m: THREE.Material): void {
    if (this.patched.has(m) || m.userData.noLamps) return;
    if (!(m instanceof THREE.MeshLambertMaterial || m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshPhongMaterial)) return;
    this.patched.add(m);
    const prev = m.onBeforeCompile.bind(m);
    const prevKey = m.customProgramCacheKey.bind(m);
    m.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vLampW;").replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        #ifdef USE_INSTANCING
          vLampW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vLampW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`,
      );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${GLSL_COMMON}`)
        .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${GLSL_APPLY}`);
    };
    m.customProgramCacheKey = () => `${prevKey()}-lamps`;
    m.needsUpdate = true;
  }

  /** Sahnedeki bütün uygun malzemeler (yeni eklenenler için ara ara yeniden çağrılır). */
  patchScene(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mm = (o as THREE.Mesh).material;
      if (!mm) return;
      for (const m of Array.isArray(mm) ? mm : [mm]) this.patch(m);
    });
  }
}
