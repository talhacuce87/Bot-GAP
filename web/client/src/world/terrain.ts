// Arazi: tek yükseklik fonksiyonu. Düz çayır, nehir yatağı ve göl çanağı, şelale havuzu, güneyde dağlar,
// dağın içinde tünel ve mağara oyuğu, sınırın ötesinde yükselen tepeler. Zemin mesh'i, yürünebilirlik
// (çarpışma sınırları marching squares ile), mağara tavanı, nehir suyu ve şelale hep buradan çıkar.
import * as THREE from "three";
import { outsideWorld, WORLD_EXTENT } from "../../../shared/constants";
import { BRIDGE, BRIDGES, CAVE, CITY, LAKE, MOUNTAIN_EDGE, RIVER, RIVER_BANK, RIVER_HALF, TUNNEL, TUNNEL_HALF, WATERFALL } from "../../../shared/zones";
import type { Colliders } from "./colliders";
import { timeUniform } from "./geo";
import { waterEnv } from "./zones";

/** Nehir, göl ve şelale havuzunun su yüzeyi. */
export const WATER_Y = -0.42;
const BED = 1.3;
/** Tavanın en alçak yeri (tünelde baş üstü). */
const CAP_MIN = 4.5;
/** Dağ burada bu kadar yükselmeden tavan başlamaz: tünelin ağzı açık yarma olarak kalır. */
const CAP_START = 7.5;
/** Zemin ızgarası: oyun alanında ince, uzakta kaba (kenarlar 8'in katı: ince ızgara kaba ızgaraya oturur). */
const FINE = 2;
const COARSE = 8;
const INNER = { minX: -144, maxX: 136, minZ: -96, maxZ: 168 };
/** Doğu: vadi yolu ve GAP Şehri (ince ızgara; kenarları kaba ızgaraya oturur). */
const EAST = { minX: 136, maxX: 568, minZ: -312, maxZ: 72 };
/** Batı: dağın ardındaki büyük mahalle ve geçit (ince ızgara; kenarları kaba ızgaraya oturur). */
const WEST = { minX: -544, maxX: -144, minZ: -184, maxZ: 152 };
const OUTER = { minX: -640, maxX: 720, minZ: -400, maxZ: 296 };
const inArea = (a: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number) => x > a.minX && x < a.maxX && z > a.minZ && z < a.maxZ;

// ---------------------------------------------------------------------------
// Gürültü ve yardımcılar
// ---------------------------------------------------------------------------

function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** (x, z)'nin kırık çizgiye uzaklığı. */
function polyDist(pts: [number, number][], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const ex = bx - ax, ez = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
    const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
    if (d < best) best = d;
  }
  return best;
}

/** Nehrin yumuşatılmış orta çizgisi (Catmull-Rom, ~1.5 m aralıkla): oyuk ve su aynı çizgiyi izler. */
export const RIVER_PATH: [number, number][] = (() => {
  const curve = new THREE.CatmullRomCurve3(RIVER.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, "centripetal");
  const n = Math.ceil(curve.getLength() / 1.5);
  return curve.getSpacedPoints(n).map((p) => [p.x, p.z] as [number, number]);
})();
const RIVER_BOX = (() => {
  const xs = RIVER_PATH.map((p) => p[0]), zs = RIVER_PATH.map((p) => p[1]);
  const m = RIVER_BANK + 1;
  return { minX: Math.min(...xs) - m, maxX: Math.max(...xs) + m, minZ: Math.min(...zs) - m, maxZ: Math.max(...zs) + m };
})();

export function riverDist(x: number, z: number): number {
  const b = RIVER_BOX;
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return Infinity;
  return polyDist(RIVER_PATH, x, z);
}

/** Dağların eteği: x'teki kuzey sınırı (z). Batı ucunun ötesinde dağ yok. */
function edgeZ(x: number): number {
  const e = MOUNTAIN_EDGE;
  if (x <= e[0][0]) return Infinity;
  for (let i = 0; i < e.length - 1; i++) {
    const [ax, az] = e[i], [bx, bz] = e[i + 1];
    if (x <= bx) return az + ((bz - az) * (x - ax)) / (bx - ax);
  }
  return e[e.length - 1][1];
}

/** Dağın oyulmamış yüksekliği. Ön yüz dik (birkaç metrede yükselir), içeri doğru sivri sırtlar. */
export function mountainHeight(x: number, z: number): number {
  const d = z - edgeZ(x) + (noise(x * 0.12, 3.1) - 0.5) * 3;
  if (!(d > 0)) return 0;
  const rise = Math.pow(Math.min(1, d / 7), 0.65);
  const west = 0.35 + 0.65 * smooth(-96, -66, x);
  const n = noise(x * 0.035, z * 0.035) * 0.6 + noise(x * 0.09 + 5, z * 0.09 + 3) * 0.3 + noise(x * 0.21 + 9, z * 0.21 + 1) * 0.1;
  const ridge = Math.pow(1 - Math.abs(2 * noise(x * 0.05 + 11, z * 0.05 + 7) - 1), 2);
  return rise * west * (7 + n * 9 + ridge * 15 + Math.min(9, d * 0.12));
}

/** Mağara ya da tünelin dışına uzaklık (içinde ≤ 0). */
function caveOutside(x: number, z: number): number {
  const ex = (x - CAVE.x) / CAVE.rx, ez = (z - CAVE.z) / CAVE.rz;
  const cave = (Math.sqrt(ex * ex + ez * ez) - 1) * CAVE.rz;
  return Math.min(cave, polyDist(TUNNEL, x, z) - TUNNEL_HALF);
}

/** Oyuncu mağarada ya da tünelde mi (tavan gizlenir). */
export function inCave(x: number, z: number): boolean {
  return caveOutside(x, z) < 1;
}

function onBridge(x: number, z: number): boolean {
  for (const br of BRIDGE_AXES) {
    const dx = x - br.x, dz = z - br.z;
    if (Math.abs(dx * br.ux + dz * br.uz) <= BRIDGE.half && Math.abs(-dx * br.uz + dz * br.ux) <= BRIDGE.w / 2) return true;
  }
  return false;
}

/** Köprülerin ekseni: nehre dik (u köprü boyunca). */
export const BRIDGE_AXES = BRIDGES.map(({ x, z }) => {
  let best = 0, bd = Infinity;
  RIVER_PATH.forEach(([px, pz], i) => {
    const d = Math.hypot(px - x, pz - z);
    if (d < bd) [bd, best] = [d, i];
  });
  const [ax, az] = RIVER_PATH[Math.max(0, best - 2)], [bx, bz] = RIVER_PATH[Math.min(RIVER_PATH.length - 1, best + 2)];
  const len = Math.hypot(bx - ax, bz - az);
  // Nehrin yönüne dik
  return { x, z, ux: -(bz - az) / len, uz: (bx - ax) / len };
});

/** Su çanağı: yatağın en derin yerinde −BED, kıyıda 0. */
function bowl(d: number, inner: number, outer: number): number {
  return -BED * (1 - smooth(inner, outer, d));
}

/** Yürünür alanın (köy, yol koridoru, şehir) dışına uzaklık (içinde 0). */
function outsideBounds(x: number, z: number): number {
  return outsideWorld(x, z);
}

/** Zeminin son yüksekliği. */
export function terrainHeight(x: number, z: number): number {
  let h = mountainHeight(x, z);
  if (h > 0) {
    const out = caveOutside(x, z);
    if (out < 2) h *= smooth(-0.2, 1.8, out);
  }
  const o = outsideBounds(x, z);
  // Doğuda (vadi ve şehir) yamaçlar daha dik ve yüksek: yol iki tepe arasından geçer
  const east = smooth(118, 150, x);
  // Şehrin çevresinde tepeler daha alçak ve yayvan: şehirden bakınca duvar gibi durmasın
  const town = smooth(CITY.minX - 50, CITY.minX - 10, x);
  const o0 = 4 - 1.5 * east;
  const cap = 8 + 16 * east - 9 * town, slope = 0.22 + 0.4 * east - 0.22 * town;
  if (o > o0) h = Math.max(h, Math.min(cap, (o - o0) * slope) + (noise(x * 0.08, z * 0.08) - 0.5) * (1.6 + 2.4 * east) * Math.min(1, (o - o0) / 6));
  const rd = riverDist(x, z);
  if (rd < RIVER_BANK) h = Math.min(h, bowl(rd, RIVER_HALF * 0.55, RIVER_BANK));
  const ld = Math.hypot(x - LAKE.x, z - LAKE.z);
  if (ld < LAKE.r + 1.2) h = Math.min(h, bowl(ld, LAKE.r - 2.5, LAKE.r + 1.2));
  const pd = Math.hypot(x - RIVER[0][0], z - RIVER[0][1]);
  if (pd < WATERFALL.poolR + 1) h = Math.min(h, bowl(pd, WATERFALL.poolR - 2.5, WATERFALL.poolR + 1));
  return h;
}

/**
 * Zemin mesh'inin (x, z)'deki gerçek yüksekliği: ızgara köşeleri arasında, mesh'teki üçgenlerle aynı
 * bölünmeyle doğrusal. Yamaçtaki ağaç ve kayalar bununla yere oturur (fonksiyonun kendisi köşeler
 * arasında mesh'ten yüksekte kalabilir).
 */
export function groundY(x: number, z: number): number {
  const fine = inArea(INNER, x, z) ? INNER : inArea(EAST, x, z) ? EAST : inArea(WEST, x, z) ? WEST : null;
  const area = fine ?? OUTER, cell = fine ? FINE : COARSE;
  const gx = (x - area.minX) / cell, gz = (z - area.minZ) / cell;
  const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
  const X = area.minX + i * cell, Z = area.minZ + j * cell;
  const h00 = terrainHeight(X, Z), h10 = terrainHeight(X + cell, Z), h01 = terrainHeight(X, Z + cell), h11 = terrainHeight(X + cell, Z + cell);
  if ((i + j) % 2) {
    // Köşegen (i, j+1)–(i+1, j)
    return fx + fz <= 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }
  // Köşegen (i, j)–(i+1, j+1)
  return fz >= fx ? h00 + (h11 - h01) * fx + (h01 - h00) * fz : h00 + (h10 - h00) * fx + (h11 - h10) * fz;
}

/** Engel değeri: > 0 yürünemez (dik/yüksek ya da su), < 0 yürünür. Köprüler hep yürünür. */
function blockField(x: number, z: number): number {
  if (onBridge(x, z)) return -1;
  const b = WORLD_EXTENT;
  if (x < b.minX - 2 || x > b.maxX + 2 || z < b.minZ - 2 || z > b.maxZ + 2) return 1;
  const h = terrainHeight(x, z);
  return Math.max(h - 0.45, -0.15 - h);
}

/** Bu noktada yürünür mü (ağaç/çimen maskesi de bunu kullanır). */
export function walkable(x: number, z: number): boolean {
  return blockField(x, z) < 0;
}

/**
 * Yürünür alanın sınırı: blok alanının sıfır çizgisi marching squares ile parçalara ayrılır ve duvar
 * olarak eklenir (nehir kıyısı, göl, dağ eteği, tünel ve mağara duvarları, köprü korkulukları).
 */
export function terrainColliders(c: Colliders): void {
  const b = WORLD_EXTENT;
  const x0 = b.minX - 2, z0 = b.minZ - 2;
  const nx = Math.ceil((b.maxX - b.minX + 4) / FINE), nz = Math.ceil((b.maxZ - b.minZ + 4) / FINE);
  const f = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) f[j * (nx + 1) + i] = blockField(x0 + i * FINE, z0 + j * FINE);
  const at = (i: number, j: number) => f[j * (nx + 1) + i];
  // Kenar üzerindeki sıfır noktası (doğrusal)
  const cross = (va: number, vb: number) => va / (va - vb);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = at(i, j), bb = at(i + 1, j), cc = at(i + 1, j + 1), d = at(i, j + 1);
      const code = (a > 0 ? 1 : 0) | (bb > 0 ? 2 : 0) | (cc > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const X = x0 + i * FINE, Z = z0 + j * FINE;
      const pts: [number, number][] = [];
      // Kenarlar: üst (a-b), sağ (b-c), alt (d-c), sol (a-d)
      if ((a > 0) !== (bb > 0)) pts.push([X + cross(a, bb) * FINE, Z]);
      if ((bb > 0) !== (cc > 0)) pts.push([X + FINE, Z + cross(bb, cc) * FINE]);
      if ((d > 0) !== (cc > 0)) pts.push([X + cross(d, cc) * FINE, Z + FINE]);
      if ((a > 0) !== (d > 0)) pts.push([X, Z + cross(a, d) * FINE]);
      for (let k = 0; k + 1 < pts.length; k += 2) c.segment(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], 0.08);
    }
  }
}

// ---------------------------------------------------------------------------
// Zemin mesh'i
// ---------------------------------------------------------------------------

/** Düz gölgeli (low-poly) ızgara; `skip` true olan hücreler atlanır. */
function grid(
  area: { minX: number; maxX: number; minZ: number; maxZ: number },
  cell: number,
  height: (x: number, z: number) => number,
  color: (x: number, z: number, h: number, out: THREE.Color) => THREE.Color,
  skip: (cx: number, cz: number) => boolean,
): THREE.BufferGeometry {
  const nx = Math.round((area.maxX - area.minX) / cell), nz = Math.round((area.maxZ - area.minZ) / cell);
  const H = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) H[j * (nx + 1) + i] = height(area.minX + i * cell, area.minZ + j * cell);
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const v = (i: number, j: number) => {
    const x = area.minX + i * cell, z = area.minZ + j * cell, h = H[j * (nx + 1) + i];
    pos.push(x, h, z);
    color(x, z, h, c);
    col.push(c.r, c.g, c.b);
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (skip(area.minX + (i + 0.5) * cell, area.minZ + (j + 0.5) * cell)) continue;
      // Köşegen yönü dama gibi değişir: sırtlar tek yöne yatmasın
      if ((i + j) % 2) {
        v(i, j); v(i, j + 1); v(i + 1, j);
        v(i + 1, j); v(i, j + 1); v(i + 1, j + 1);
      } else {
        v(i, j); v(i, j + 1); v(i + 1, j + 1);
        v(i, j); v(i + 1, j + 1); v(i + 1, j);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

const ROCK = new THREE.Color("#857f74"), ROCK_DARK = new THREE.Color("#6a665f"), SNOW = new THREE.Color("#eef2f5");
const MUD = new THREE.Color("#8a7d5c"), SAND = new THREE.Color("#c9b88a"), CAVE_FLOOR = new THREE.Color("#4f4c45");
const _c = new THREE.Color();

/**
 * Zemin rengi: `grass` düz alanın rengi (mevsim, bölge lekeleri); kıyılar kum/çamur, dağ kaya ve
 * zirvede kar, mağara tabanı koyu taş.
 */
export function terrainColor(x: number, z: number, h: number, grass: (x: number, z: number, out: THREE.Color) => THREE.Color, out: THREE.Color): THREE.Color {
  grass(x, z, out);
  const m = mountainHeight(x, z);
  if (m > 0.6) {
    const n = noise(x * 0.3, z * 0.3);
    _c.copy(ROCK).lerp(ROCK_DARK, n);
    out.lerp(_c, smooth(0.6, 3, m));
    if (h > 27) out.lerp(SNOW, smooth(27, 32, h) * (0.8 + n * 0.2));
    if (h < 0.3 && caveOutside(x, z) < 1.5) out.copy(CAVE_FLOOR).multiplyScalar(0.9 + n * 0.2);
  }
  const water = Math.min(riverDist(x, z) - RIVER_HALF, Math.hypot(x - LAKE.x, z - LAKE.z) - LAKE.r, Math.hypot(x - RIVER[0][0], z - RIVER[0][1]) - WATERFALL.poolR);
  if (water < 3) out.lerp(h < WATER_Y ? MUD : SAND, 1 - smooth(0.5, 3, water));
  return out;
}

export interface Terrain {
  ground: THREE.BufferGeometry;
  /** Mağara ve tünelin tavanı (dağın o kısmı): içerideyken gizlenir. */
  cap: THREE.Mesh;
}

export function buildTerrain(grass: (x: number, z: number, out: THREE.Color) => THREE.Color): Terrain {
  const color = (x: number, z: number, h: number, out: THREE.Color) => terrainColor(x, z, h, grass, out);
  const inner = grid(INNER, FINE, terrainHeight, color, () => false);
  const east = grid(EAST, FINE, terrainHeight, color, () => false);
  const west = grid(WEST, FINE, terrainHeight, color, () => false);
  const outer = grid(OUTER, COARSE, terrainHeight, color, (x, z) => inArea(INNER, x, z) || inArea(EAST, x, z) || inArea(WEST, x, z));
  const ground = new THREE.BufferGeometry();
  const merge = (name: string) => {
    const parts = [inner, east, west, outer].map((g) => g.getAttribute(name).array as Float32Array);
    const out = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of parts) {
      out.set(a, at);
      at += a.length;
    }
    ground.setAttribute(name, new THREE.BufferAttribute(out, 3));
  };
  merge("position");
  merge("normal");
  merge("color");

  // Tavan: oyuğun üstünde dağın oyulmamış hali (çift yüzlü: tünel ağzından bakınca altı koyu görünür)
  const capH = (x: number, z: number) => Math.max(mountainHeight(x, z), CAP_MIN);
  const capGeo = grid(
    { minX: CAVE.x - CAVE.rx - 30, maxX: CAVE.x + CAVE.rx + 6, minZ: TUNNEL[0][1] - 4, maxZ: CAVE.z + CAVE.rz + 6 },
    FINE,
    capH,
    color,
    (x, z) => caveOutside(x, z) > FINE * 0.9 || mountainHeight(x, z) < CAP_START,
  );
  const cap = new THREE.Mesh(capGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  cap.castShadow = cap.receiveShadow = true;
  cap.matrixAutoUpdate = false;
  return { ground, cap };
}

// ---------------------------------------------------------------------------
// Nehir suyu ve şelale
// ---------------------------------------------------------------------------

/** Akan su: kıyıya doğru sığlaşan renk, akış yönünde kayan çizgiler, köpük, gökyüzü yansıması. */
function riverMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    Object.assign(shader.uniforms, waterEnv);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 aRiver;\nvarying vec2 vRiver;\nvarying vec3 vRiverW;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRiver = aRiver;\nvRiverW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime;
        uniform vec3 uSkyH;
        uniform vec3 uSkyT;
        uniform vec3 uSunDir;
        uniform float uRain;
        uniform float uFrozen;
        varying vec2 vRiver;
        varying vec3 vRiverW;
        float rHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float rNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(rHash(i), rHash(i + vec2(1.0, 0.0)), u.x), mix(rHash(i + vec2(0.0, 1.0)), rHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float across = abs(vRiver.x);
        float flow = vRiver.y - uTime * 2.2 * (1.0 - uFrozen);
        diffuseColor.rgb = mix(vec3(0.2, 0.47, 0.68), vec3(0.4, 0.68, 0.84), smoothstep(0.2, 0.95, across));
        float streak = rNoise(vec2(vRiver.x * 6.0, flow * 0.45)) * rNoise(vec2(vRiver.x * 13.0 + 4.0, flow * 1.1));
        diffuseColor.rgb += smoothstep(0.35, 0.7, streak) * 0.16;
        float foam = smoothstep(0.78, 1.0, across + (rNoise(vec2(flow * 0.8, vRiver.x * 3.0)) - 0.5) * 0.18);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.93, 0.97), foam * 0.6);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.88, 0.95) + streak * 0.03, uFrozen);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          vec3 V = normalize(cameraPosition - vRiverW);
          float w = rNoise(vec2(vRiver.x * 4.0, (vRiver.y - uTime * 2.2) * 0.7)) - 0.5;
          vec3 N = normalize(vec3(w * 0.08, 1.0, w * 0.05));
          float fres = pow(1.0 - max(dot(V, N), 0.0), 4.0);
          vec3 R = reflect(-V, N);
          vec3 sky = mix(uSkyH, uSkyT, pow(max(R.y, 0.0), 0.7));
          float glint = pow(max(dot(R, normalize(uSunDir)), 0.0), 200.0) * 2.0;
          totalEmissiveRadiance += (sky * fres * 0.6 + vec3(1.0, 0.95, 0.85) * glint) * (1.0 - uFrozen * 0.7);
        }`,
      );
  };
  m.customProgramCacheKey = () => "river";
  return m;
}

/** Nehir şeridi: yumuşak orta çizgi boyunca, kıyı eğiminin altına kadar uzanan su yüzeyi. */
export function riverMesh(): THREE.Mesh {
  const half = RIVER_HALF + 1.6;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let along = 0;
  RIVER_PATH.forEach(([x, z], i) => {
    const [ax, az] = RIVER_PATH[Math.max(0, i - 1)], [bx, bz] = RIVER_PATH[Math.min(RIVER_PATH.length - 1, i + 1)];
    const len = Math.hypot(bx - ax, bz - az);
    const px = -(bz - az) / len, pz = (bx - ax) / len;
    if (i) along += Math.hypot(x - RIVER_PATH[i - 1][0], z - RIVER_PATH[i - 1][1]);
    pos.push(x - px * half, WATER_Y, z - pz * half, x + px * half, WATER_Y, z + pz * half);
    uv.push(-1.3, along, 1.3, along);
    if (i) {
      const k = i * 2;
      idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aRiver", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Ters sarılan üçgenler yukarı baksın
  const n = g.getAttribute("normal");
  if (n.getY(0) < 0) {
    g.setIndex(idx.map((_, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]]));
    g.computeVertexNormals();
  }
  const m = new THREE.Mesh(g, riverMaterial());
  m.matrixAutoUpdate = false;
  m.receiveShadow = true;
  return m;
}

/** Şelale: dağın yüzünden, yamacı izleyerek havuza akan perde; aşağı kayan beyaz çizgiler, dipte köpük. */
export function waterfallMesh(): THREE.Mesh {
  const { x: wx, top } = WATERFALL;
  // Yamaç boyunca: dağın yüzünde `top` yüksekliğe varılan yerden havuza
  let zTop = WATERFALL.z;
  while (mountainHeight(wx, zTop) < top && zTop < WATERFALL.z + 30) zTop += 0.25;
  const rows = 18, cols = 6, half = 2.6;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    // Üstte yamaca yapışık, altta havuza doğru biraz öne düşer
    const z = zTop + (WATERFALL.z - 1.5 - zTop) * Math.pow(t, 0.8);
    const ground = Math.max(WATER_Y, mountainHeight(wx, z));
    const y = r === rows ? WATER_Y + 0.05 : Math.max(ground + 0.5, WATER_Y + 0.05);
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      // Ortası öne bombeli, kenarları ince
      const bulge = Math.sin(u * Math.PI) * 0.35;
      pos.push(wx - half + u * half * 2, y, z - bulge);
      uv.push(u, t);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + cols + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, uFrozen: waterEnv.uFrozen, uLight: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFrozen;
      uniform float uLight;
      varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1.0, 0.0)), u.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      void main() {
        float fall = vUv.y * 5.0 - uTime * 1.6 * (1.0 - uFrozen);
        float s = n(vec2(vUv.x * 18.0, fall)) * 0.6 + n(vec2(vUv.x * 40.0, fall * 2.3)) * 0.4;
        vec3 c = mix(vec3(0.55, 0.75, 0.88), vec3(0.95, 0.98, 1.0), smoothstep(0.35, 0.75, s));
        float foam = smoothstep(0.75, 1.0, vUv.y);
        c = mix(c, vec3(0.96, 0.98, 1.0), foam * 0.8);
        float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
        float a = (0.72 + 0.25 * s) * edge;
        c = mix(c, vec3(0.82, 0.9, 0.96), uFrozen);
        gl_FragColor = vec4(c * uLight, a);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(g, material);
  m.matrixAutoUpdate = false;
  m.renderOrder = 2;
  return m;
}
