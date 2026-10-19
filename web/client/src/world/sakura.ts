// Sakura Bahçesi: kuzeydoğuda, torii kapılı, sakura ağaçları ve taş fenerlerle çevrili çimenlik.
// Ağaçlar Builder prop'u ("sakura"), fenerler statik + ampul prop'u (gece haleleri DayNight'tan gelir).
// Yapraklar tek InstancedMesh: bir kısmı dallardan süzülür, kalanı yerde durur ve yürüyen oyuncunun
// ayağının dibinde havalanır. Hepsi vertex shader'da.
import * as THREE from "three";
import type { Builder } from "./builder";
import { mat, part, timeUniform } from "./geo";
import { steppingStones } from "./zones";

export const SAKURA = { x: 40, z: -24 };

/** Bahçenin ayarları: yoğunluk ve boyutlar buradan değişir. */
export const SAKURA_CONFIG = {
  radius: 11,
  /** Bahçeye ayrıca serpilen çimen tutamı ve boy çarpanı (dışarıdakinden gür ve uzun). */
  grass: { count: 1100, height: 1.05 },
  trees: 9,
  lanterns: 6,
  petals: { ground: 520, falling: 160 },
  petalColors: ["#fedfe1", "#f9c6cf", "#f4a9bb"],
};

const STONE = "#a7a294";
const STONE_DARK = "#8a8679";
const TORII = "#c23b2a";

type Spot = { x: number; z: number; r: number };

export interface SakuraGarden {
  petals: THREE.InstancedMesh;
  /** Bahçeye ayrıca serpilecek çimen tutamları (grassAndFlowers ana çimen mesh'ine ekler). */
  grass: THREE.Matrix4[];
  /** Oyuncu bu kadar içerideyse bahçede sayılır (giriş efekti için). */
  inside(x: number, z: number, margin?: number): boolean;
  /** Kare başına: oyuncunun konumu ve hızı (0 durgun … 1 koşu); yerdeki yapraklar havalanır. */
  kick(x: number, z: number, strength: number): void;
}

function lantern(b: Builder, x: number, z: number, ry: number): void {
  const add = (g: THREE.BufferGeometry, color: string, m: THREE.Matrix4) => b.add(part(g, color, m, 0.1, b.rand));
  add(new THREE.BoxGeometry(0.62, 0.16, 0.62), STONE_DARK, mat(x, 0.08, z, ry));
  add(new THREE.CylinderGeometry(0.12, 0.15, 0.7, 6), STONE, mat(x, 0.5, z, ry));
  add(new THREE.BoxGeometry(0.52, 0.08, 0.52), STONE, mat(x, 0.89, z, ry));
  // Ateş odası: köşe direkleri arası açık, içindeki ampul görünür
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const o = new THREE.Vector3(cx * 0.17, 0, cz * 0.17).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    add(new THREE.BoxGeometry(0.07, 0.32, 0.07), STONE, mat(x + o.x, 1.09, z + o.z, ry));
  }
  add(new THREE.ConeGeometry(0.5, 0.32, 4), STONE_DARK, mat(x, 1.41, z, ry + Math.PI / 4));
  add(new THREE.SphereGeometry(0.08, 6, 4), STONE_DARK, mat(x, 1.6, z));
  b.prop("bulb", mat(x, 1.09, z, 0, 0.55));
  b.colliders.circle(x, z, 0.38);
  b.shadow(x, z, 0.6);
}

function torii(b: Builder, x: number, z: number, ry: number): void {
  const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), ry);
  for (const s of [-1.7, 1.7]) {
    const px = x + side.x * s, pz = z + side.z * s;
    b.add(part(new THREE.CylinderGeometry(0.17, 0.2, 3.7, 8), TORII, mat(px, 1.85, pz)));
    b.add(part(new THREE.CylinderGeometry(0.26, 0.26, 0.3, 8), "#2a2522", mat(px, 0.15, pz)));
    b.colliders.circle(px, pz, 0.24);
  }
  b.add(part(new THREE.BoxGeometry(4.2, 0.2, 0.24), TORII, mat(x, 3.0, z, ry))); // nuki
  b.add(part(new THREE.BoxGeometry(5.0, 0.26, 0.4), TORII, mat(x, 3.72, z, ry))); // kasagi
  b.add(part(new THREE.BoxGeometry(5.4, 0.12, 0.46), "#2a2522", mat(x, 3.91, z, ry)));
  b.add(part(new THREE.BoxGeometry(0.22, 0.6, 0.18), TORII, mat(x, 3.35, z, ry))); // gakuzuka
}

function bench(b: Builder, x: number, z: number, face: number): void {
  const wood = "#7a5236";
  const fwd = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), face);
  const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), face);
  b.add(part(new THREE.BoxGeometry(1.8, 0.1, 0.5), "#9a6a44", mat(x, 0.45, z, face), 0.1, b.rand));
  for (const s of [-0.7, 0.7]) b.add(part(new THREE.BoxGeometry(0.12, 0.42, 0.42), wood, mat(x + side.x * s, 0.21, z + side.z * s, face)));
  b.colliders.segment(x - side.x * 0.85, z - side.z * 0.85, x + side.x * 0.85, z + side.z * 0.85, 0.3);
  for (const s of [-0.45, 0.45]) b.seats.push({ x: x + side.x * s - fwd.x * 0.05, z: z + side.z * s - fwd.z * 0.05, rot: face });
  b.shadow(x, z, 1.1);
}

/** Yapraklar: `aFall` 1 olanlar dallardan süzülür, 0 olanlar yerde yatar ve tekmelenir. */
function petalMesh(ground: [number, number][], falling: [number, number][], rand: () => number): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(0.11, 0.075);
  geo.deleteAttribute("uv");
  const n = ground.length + falling.length;
  const seeds = new Float32Array(n), fall = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seeds[i] = rand();
    fall[i] = i < falling.length ? 1 : 0;
  }
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
  geo.setAttribute("aFall", new THREE.InstancedBufferAttribute(fall, 1));

  const kick = { value: new THREE.Vector3(0, 0, 0) };
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, flatShading: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.uniforms.uKick = kick;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform vec3 uKick;\nattribute float aSeed;\nattribute float aFall;\nmat2 rot2(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }")
      .replace(
        "#include <begin_vertex>",
        `vec3 p = position;
        vec3 off = vec3(0.0);
        float s = aSeed;
        if (aFall > 0.5) {
          // ~15 sn'de bir dallardan yere: salınarak, takla atarak; uçlarda küçülüp kaybolur
          float t = fract(uTime * 0.065 + s);
          float tumble = uTime * 2.4 + s * 30.0;
          p.xy = rot2(tumble) * p.xy;
          p.yz = rot2(tumble * 0.7) * p.yz;
          p *= smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.93, 1.0, t));
          off = vec3(sin(uTime * 0.9 + s * 17.0) * 0.6 + t * 1.6, mix(3.4, 0.03, t), cos(uTime * 0.7 + s * 11.0) * 0.5 + t * 0.4);
        } else {
          p = vec3(p.x, 0.0, p.y);
          p.xz = rot2(s * 6.2832) * p.xz;
          vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
          vec2 d = ip - uKick.xy;
          float k = uKick.z * (1.0 - smoothstep(0.3, 1.7, length(d)));
          float ph = uTime * 5.0 + s * 50.0;
          vec2 away = normalize(d + vec2(0.001));
          p.yz = rot2(ph * k) * p.yz;
          off = vec3(away.x * k * 0.4 + sin(ph) * 0.1 * k, k * (0.2 + 0.4 * abs(sin(ph * 0.5 + s * 9.0))), away.y * k * 0.4 + cos(ph) * 0.1 * k);
        }
        vec3 transformed = p + off;`,
      );
  };
  material.customProgramCacheKey = () => "sakura-petals";

  const m = new THREE.InstancedMesh(geo, material, n);
  const palette = SAKURA_CONFIG.petalColors.map((c) => new THREE.Color(c));
  const tm = new THREE.Matrix4();
  [...falling, ...ground].forEach(([x, z], i) => {
    m.setMatrixAt(i, tm.makeTranslation(x, i < falling.length ? 0 : 0.04, z));
    m.setColorAt(i, palette[Math.floor(rand() * palette.length)]);
  });
  m.frustumCulled = false;
  m.matrixAutoUpdate = false;
  m.userData.kick = kick;
  return m;
}

export function sakuraGarden(b: Builder): SakuraGarden {
  const { x: cx, z: cz } = SAKURA;
  const { radius: R } = SAKURA_CONFIG;
  // Meydandan gelen yolun yönü: torii bahçenin meydana bakan kenarında
  const dl = Math.hypot(cx, cz), ux = cx / dl, uz = cz / dl;
  const gateX = cx - ux * (R - 0.4), gateZ = cz - uz * (R - 0.4);
  const face = Math.atan2(ux, uz);
  const spots: Spot[] = [];
  const keep = (x: number, z: number, r: number) => spots.push({ x, z, r });

  torii(b, gateX, gateZ, face);
  keep(gateX, gateZ, 2.2);
  steppingStones(b, gateX + ux * 0.8, gateZ + uz * 0.8, cx - ux * 2.6, cz - uz * 2.6, 0.8);

  // Ortada büyük sakura, ona bakan iki bank
  b.prop("sakura", mat(cx, 0, cz, b.rand() * 6, 1.4));
  b.colliders.circle(cx, cz, 0.45);
  b.shadow(cx, cz, 3.2);
  keep(cx, cz, 0.7);
  for (const a of [face + Math.PI * 0.55, face - Math.PI * 0.55]) {
    const bx = cx - Math.sin(a) * 3.4, bz = cz - Math.cos(a) * 3.4;
    bench(b, bx, bz, a);
    keep(bx, bz, 1.1);
  }

  // Halka: sakuralar dışta, fenerler içte; giriş açıklığı boş
  const gateAngle = Math.atan2(-ux, -uz);
  const trees: [number, number, number][] = [];
  for (let i = 0; i < SAKURA_CONFIG.trees; i++) {
    const a = gateAngle + 0.75 + (i / (SAKURA_CONFIG.trees - 1)) * (Math.PI * 2 - 1.5) + (b.rand() - 0.5) * 0.15;
    const r = R - 1.6 + b.rand() * 1.2;
    const x = cx + Math.sin(a) * r, z = cz + Math.cos(a) * r, s = 0.95 + b.rand() * 0.35;
    b.prop("sakura", mat(x, 0, z, b.rand() * 6, s));
    b.colliders.circle(x, z, 0.3 * s);
    b.shadow(x, z, 2 * s);
    keep(x, z, 0.5);
    trees.push([x, z, s]);
  }
  for (let i = 0; i < SAKURA_CONFIG.lanterns; i++) {
    const a = gateAngle + 0.5 + (i / (SAKURA_CONFIG.lanterns - 1)) * (Math.PI * 2 - 1.0);
    const x = cx + Math.sin(a) * 6.3, z = cz + Math.cos(a) * 6.3;
    lantern(b, x, z, a);
    keep(x, z, 0.6);
  }
  // Torii'nin iki yanında birer fener
  for (const s of [-2.6, 2.6]) {
    const x = gateX + ux * 1.4 + uz * s, z = gateZ + uz * 1.4 - ux * s;
    lantern(b, x, z, face);
    keep(x, z, 0.6);
  }
  // Dışarıdaki ağaç/çalı/çimen bahçeye girmesin; bahçenin kendi çimeni aşağıda.
  b.clearCircle(cx, cz, R + 1);

  const pathClear = (x: number, z: number) => {
    const ex = cx - gateX, ez = cz - gateZ, len2 = ex * ex + ez * ez;
    const t = Math.max(0, Math.min(1, ((x - gateX) * ex + (z - gateZ) * ez) / len2));
    return Math.hypot(x - (gateX + ex * t), z - (gateZ + ez * t)) > 0.75;
  };
  const free = (x: number, z: number) => pathClear(x, z) && spots.every((p) => Math.hypot(x - p.x, z - p.z) > p.r);

  const grass: THREE.Matrix4[] = [];
  for (let i = 0; grass.length < SAKURA_CONFIG.grass.count && i < SAKURA_CONFIG.grass.count * 4; i++) {
    const a = b.rand() * Math.PI * 2, r = Math.sqrt(b.rand()) * R;
    const x = cx + Math.sin(a) * r, z = cz + Math.cos(a) * r;
    if (free(x, z)) grass.push(mat(x, 0, z, b.rand() * 6, (0.8 + b.rand() * 0.7) * SAKURA_CONFIG.grass.height));
  }

  // Yerdeki yapraklar ağaç altlarında yoğun; düşenler taçların altından başlar
  const ground: [number, number][] = [];
  const falling: [number, number][] = [];
  const allTrees: [number, number, number][] = [[cx, cz, 1.4], ...trees];
  for (let i = 0; ground.length < SAKURA_CONFIG.petals.ground && i < SAKURA_CONFIG.petals.ground * 4; i++) {
    const [tx, tz, s] = allTrees[Math.floor(b.rand() * allTrees.length)];
    const a = b.rand() * Math.PI * 2, r = Math.sqrt(b.rand()) * 2.6 * s;
    const x = tx + Math.cos(a) * r, z = tz + Math.sin(a) * r;
    if (Math.hypot(x - cx, z - cz) < R) ground.push([x, z]);
  }
  for (let i = 0; i < SAKURA_CONFIG.petals.falling; i++) {
    const [tx, tz, s] = allTrees[Math.floor(b.rand() * allTrees.length)];
    const a = b.rand() * Math.PI * 2, r = b.rand() * 1.6 * s;
    falling.push([tx + Math.cos(a) * r - 0.8, tz + Math.sin(a) * r]);
  }
  const petals = petalMesh(ground, falling, b.rand);
  const kick = petals.userData.kick as { value: THREE.Vector3 };

  return {
    petals,
    grass,
    inside: (x, z, margin = 0) => Math.hypot(x - cx, z - cz) < R - margin,
    kick(x, z, strength) {
      // Ani değil: yapraklar yavaşça kalkıp iner
      const k = kick.value;
      k.z += (strength - k.z) * 0.08;
      k.x = x;
      k.y = z;
    },
  };
}
