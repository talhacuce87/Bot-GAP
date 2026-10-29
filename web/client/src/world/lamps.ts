// Gece ışığı: dünyadaki BÜTÜN lambalar gerçek ışık verir (yalnızca en yakın birkaçı değil) ve arabaların farları
// önlerini gerçekten aydınlatır. Yöntem (tarayıcı oyunlarının "ızgaralı ışık" yolu): dünya 24 m'lik hücrelere
// bölünür, her hücreye ışığı düşen lambaların listesi bir dokuya yazılır; her yüzey yalnızca kendi hücresindeki
// lambaları hesaplar. Malzemelere shader eklemesiyle bağlanır (Lambert/Standard/Phong); gündüz hesap atlanır.
// Sokak lambası aşağı bakar (dibi parlak, kenarı yumuşak söner); far üst kenarı keskin, yana yayılan huzme.
// Yağmurda ıslak yüzeyler lamba ve farları parlak yansıtır.
// Mahalledeki inşa lambaları da aynı ızgaraya sonradan eklenir: her yöne loş, sıcak ışık; ışık mahallenin blok
// ızgarasında (3B doku) yüzeyden lambaya yürütülen ışınla duvarlarda kesilir (cam biraz geçirir), gölgeye az bir
// sekme ışığı düşer: ışın izlemeye benzer yumuşak iç mekân aydınlatması.
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
/** İnşa lambası: sıcak, loş, kısa menzilli (gölgesi blok ızgarasından); ışık taşı daha güçlü ve sarı. */
const BUILD_LAMP = new THREE.Color("#ffc98a");
const BUILD_RANGE = 9;
const BUILD_POWER = 3.2;
const GLOW_COLOR = new THREE.Color("#ffd98a");
const GLOW_RANGE = 11;
const GLOW_POWER = 4.6;

/** İnşa ışığı: konum ve ışık taşı mı. */
export interface BuildLight {
  x: number;
  y: number;
  z: number;
  glow?: boolean;
}

/** Mahallenin blok ızgarası (gölge için): 1 m hücre, değer 255 dolu, 200 cam, 128 yarım blok (alt yarı). */
export interface BuildOccupancy {
  data: Uint8Array;
  /** Izgaranın dünyadaki köşesi (x, z) ve boyutları (x, kat, z). */
  x0: number;
  z0: number;
  w: number;
  h: number;
  d: number;
}

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
  uniform highp sampler3D uBuildOcc;
  uniform vec3 uBuildOrigin;
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

  // İnşa lambası gölgesi: yüzeyden lambaya blok ızgarasında yürü (dolu blok keser, cam azaltır, basamak alt yarısı)
  float buildShadow(vec3 from, vec3 to) {
    ivec3 dims = textureSize(uBuildOcc, 0);
    vec3 d = to - from;
    float len = length(d);
    int n = int(clamp(len * 1.6, 2.0, 16.0));
    float jit = fract(sin(dot(from.xz, vec2(12.9898, 78.233))) * 43758.5453);
    float T = 1.0;
    for (int s = 0; s < 16; s++) {
      if (s >= n - 1) break;
      vec3 q = from + d * ((float(s) + jit) / float(n));
      ivec3 v = ivec3(floor(q.x - uBuildOrigin.x), floor(q.y), floor(q.z - uBuildOrigin.z));
      if (any(lessThan(v, ivec3(0))) || any(greaterThanEqual(v, dims))) continue;
      float o = texelFetch(uBuildOcc, v, 0).r;
      if (o > 0.95) return 0.0;
      if (o > 0.7) T *= 0.78;
      else if (o > 0.4 && fract(q.y) < 0.5) return 0.0;
    }
    return T;
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
        if (c.a < 0.0) {
          // İnşa lambası: her yöne; duvar arkası gölgede (az bir sekme ışığı kalır), yakın yüzeyler yumuşak
          float T = buildShadow(vLampW + nW * 0.08, p.xyz);
          float att = -c.a * lampWindow(d, p.w) / (d * d + 0.6);
          float lit = max(dot(nW, l), 0.0) * T + 0.12 * (0.4 + 0.6 * T);
          lampSum += c.rgb * att * lit;
          vec3 h = normalize(l + vW);
          lampSpec += c.rgb * att * T * pow(max(dot(nW, h), 0.0), shin) * gloss;
          continue;
        }
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

/** Yamalı malzemenin uniform'larını veren lamba alanı (son kurulan dünya). */
const lampOwner = new WeakMap<THREE.Material, LampField>();

export class LampField {
  readonly uniforms = {
    uLampGrid: { value: null as THREE.DataTexture | null },
    uLampData: { value: null as THREE.DataTexture | null },
    uLampArea: { value: new THREE.Vector4() },
    uLampDims: { value: new THREE.Vector2() },
    uBuildOcc: { value: emptyOcc() as THREE.Data3DTexture },
    uBuildOrigin: { value: new THREE.Vector3() },
    uLampNight: { value: 0 },
    uLampWet: wetUniform,
    uCarPos: { value: Array.from({ length: MAX_CARS }, () => new THREE.Vector4()) },
    uCarDir: { value: Array.from({ length: MAX_CARS }, () => new THREE.Vector4()) },
    uCarCol: { value: Array.from({ length: MAX_CARS }, () => new THREE.Color()) },
    uCarCount: { value: 0 },
  };
  private patched = new WeakSet<THREE.Material>();

  /** Dünyanın sabit lambaları, ızgara alanı ve hücre başına menzili değen sabit lambalar (mesafeleriyle). */
  private fixed: Lamp[];
  private area: { minX: number; minZ: number; cols: number; rows: number };
  private fixedHits: [number, number][][] = [];
  /** İnşa lambaları (mahallede, değiştikçe). */
  private built: BuildLight[] = [];

  constructor(lamps: Lamp[]) {
    this.fixed = lamps;
    const ext = {
      minX: HOOD_BOX.minX - 30,
      maxX: CITY.maxX + 30,
      minZ: Math.min(RACE_AREA.minZ, HOOD_BOX.minZ, WORLD_BOUNDS.minZ) - 30,
      maxZ: Math.max(WORLD_BOUNDS.maxZ, HOOD_BOX.maxZ) + 30,
    };
    const cols = Math.ceil((ext.maxX - ext.minX) / CELL), rows = Math.ceil((ext.maxZ - ext.minZ) / CELL);
    this.area = { minX: ext.minX, minZ: ext.minZ, cols, rows };
    const ranges = lamps.map((l) => (l.fire ? 11 : 13 * Math.max(1, l.y / 2.7)));
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) this.fixedHits.push(this.hitsIn(cx, cy, lamps, ranges, 0));
    }
    this.uniforms.uLampArea.value.set(ext.minX, ext.minZ, CELL, PER_CELL);
    this.uniforms.uLampDims.value.set(cols, rows);
    this.write();
  }

  /** Hücreye menzili değen lambalar: [genel dizin, hücre merkezine uzaklık²]. */
  private hitsIn(cx: number, cy: number, list: { x: number; z: number }[], ranges: number[], offset: number): [number, number][] {
    const x0 = this.area.minX + cx * CELL, z0 = this.area.minZ + cy * CELL, mx = x0 + CELL / 2, mz = z0 + CELL / 2;
    const hits: [number, number][] = [];
    list.forEach((l, i) => {
      const dx = Math.max(x0 - l.x, 0, l.x - (x0 + CELL)), dz = Math.max(z0 - l.z, 0, l.z - (z0 + CELL));
      if (dx * dx + dz * dz < ranges[i] * ranges[i]) hits.push([offset + i, (l.x - mx) ** 2 + (l.z - mz) ** 2]);
    });
    return hits;
  }

  /** Lamba verisi ve ızgara dokularını sabit + inşa lambalarından yeniden yazar. */
  private write(): void {
    const lamps = this.fixed, built = this.built, all = lamps.length + built.length;
    // Lamba verisi: 1. satır konum + menzil, 2. satır renk + güç (inşa lambasında güç eksi: her yöne, gölgeli)
    const n = Math.max(1, all);
    const data = new Float32Array(n * 2 * 4);
    lamps.forEach((l, i) => {
      const tall = Math.max(1, l.y / 2.7);
      const range = l.fire ? 11 : 13 * tall;
      const inTown = (l.x > CITY.minX - 6 && l.x < CITY.maxX + 6) || (l.x < HOOD_BOX.maxX + 6 && l.x > HOOD_BOX.minX - 6);
      const color = l.fire ? FIRE : inTown ? LED : SODIUM;
      const power = l.fire ? 7 : 9 * tall * tall;
      data.set([l.x, l.y - 0.2, l.z, range], i * 4);
      data.set([color.r, color.g, color.b, power], (n + i) * 4);
    });
    built.forEach((l, k) => {
      const i = lamps.length + k, c = l.glow ? GLOW_COLOR : BUILD_LAMP;
      data.set([l.x, l.y, l.z, l.glow ? GLOW_RANGE : BUILD_RANGE], i * 4);
      data.set([c.r, c.g, c.b, -(l.glow ? GLOW_POWER : BUILD_POWER)], (n + i) * 4);
    });
    this.uniforms.uLampData.value?.dispose();
    const dataTex = new THREE.DataTexture(data, n, 2, THREE.RGBAFormat, THREE.FloatType);
    dataTex.needsUpdate = true;
    // Izgara: her hücreye menzili değen lambalar (doluysa hücre merkezine en yakınları)
    const { cols, rows } = this.area;
    const ranges = built.map((l) => (l.glow ? GLOW_RANGE : BUILD_RANGE));
    const grid = new Float32Array(cols * PER_CELL * rows * 4);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let hits = this.fixedHits[cy * cols + cx];
        if (built.length) hits = [...hits, ...this.hitsIn(cx, cy, built, ranges, lamps.length)];
        hits.sort((a, b) => a[1] - b[1]);
        hits.slice(0, PER_CELL).forEach(([i], k) => (grid[((cy * cols + cx) * PER_CELL + k) * 4] = i + 1));
      }
    }
    this.uniforms.uLampGrid.value?.dispose();
    const gridTex = new THREE.DataTexture(grid, cols * PER_CELL, rows, THREE.RGBAFormat, THREE.FloatType);
    gridTex.needsUpdate = true;
    this.uniforms.uLampGrid.value = gridTex;
    this.uniforms.uLampData.value = dataTex;
  }

  /** İnşa lambaları ve mahallenin blok ızgarası değişti (gölgeler için). */
  setBuild(lamps: BuildLight[], occ: BuildOccupancy): void {
    const same = lamps.length === this.built.length && lamps.every((l, i) => l.x === this.built[i].x && l.y === this.built[i].y && l.z === this.built[i].z && !!l.glow === !!this.built[i].glow);
    if (!same) {
      this.built = lamps;
      this.write();
    }
    let tex = this.uniforms.uBuildOcc.value;
    if (tex.image.width !== occ.w || tex.image.height !== occ.h || tex.image.depth !== occ.d) {
      tex.dispose();
      tex = new THREE.Data3DTexture(occ.data, occ.w, occ.h, occ.d);
      tex.format = THREE.RedFormat;
      tex.type = THREE.UnsignedByteType;
      tex.unpackAlignment = 1;
      this.uniforms.uBuildOcc.value = tex;
    } else tex.image.data = occ.data;
    tex.needsUpdate = true;
    this.uniforms.uBuildOrigin.value.set(occ.x0, 0, occ.z0);
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

  /**
   * Malzemeye gece ışığını ekler (bir kez; önceki shader eklemeleri korunur). Modül düzeyinde paylaşılan malzemeler
   * mod değişiminden (dünya → tank/otoyol → dünya) sağ çıkar: yeni dünyanın lambaları onları yeniden yamarsa GLSL iki
   * kez eklenir ve shader derlenmez. Yama malzemede bir kez kalır; uniform'lar o anki sahibinden (son dünya) okunur.
   */
  patch(m: THREE.Material): void {
    if (this.patched.has(m) || m.userData.noLamps) return;
    if (!(m instanceof THREE.MeshLambertMaterial || m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshPhongMaterial)) return;
    this.patched.add(m);
    const owned = lampOwner.has(m);
    lampOwner.set(m, this);
    if (owned) {
      m.needsUpdate = true;
      return;
    }
    const prev = m.onBeforeCompile.bind(m);
    const prevKey = m.customProgramCacheKey.bind(m);
    m.onBeforeCompile = (shader, renderer) => {
      prev(shader, renderer);
      Object.assign(shader.uniforms, lampOwner.get(m)!.uniforms);
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

/** Başlangıçta boş (1×1×1) blok ızgarası: inşa lambası yokken gölge hesabı bir şey bulmaz. */
function emptyOcc(): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}
