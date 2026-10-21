// Meydan dışındaki bölgeler: zindan (batı), LAGER'in mangalı (doğu, orman içi), gölet (güney).
// Hepsi Builder'a parça ekler; kendi draw call'ları yalnızca animasyonlu kısımlar (köz, duman, su, ördekler).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { DOCK } from "../../../shared/zones";
import type { Builder } from "./builder";
import { flatMat, mat, part, timeUniform } from "./geo";

const STONE = "#6f7378";
const STONE_DARK = "#55595f";
const IRON = "#26282d";
const WOOD = "#8a5f35";
const WOOD_DARK = "#5b3f25";

function box(b: Builder, w: number, h: number, d: number, color: string, x: number, y: number, z: number, ry = 0, jitter = 0): void {
  b.add(part(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry), jitter, b.rand));
}

/** Yol boyunca hafif savrulmuş basamak taşları. */
export function steppingStones(b: Builder, ax: number, az: number, bx: number, bz: number, step = 0.95): void {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.floor(len / step);
  const px = -(bz - az) / len, pz = (bx - ax) / len;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const side = (b.rand() - 0.5) * 0.5;
    const x = ax + (bx - ax) * t + px * side;
    const z = az + (bz - az) * t + pz * side;
    const s = 0.35 + b.rand() * 0.2;
    b.prop("stone", mat(x, 0.03, z, b.rand() * 6, s, 1, s * (0.8 + b.rand() * 0.4)));
  }
  // Yol kenarı da açık kalsın: ağaç/çalı manzarayı kapatmasın.
  b.clearSegment(ax, az, bx, bz, 2.2);
}

/** Zindanın eski (küçük harita) konumuna göre kayması; hücre sınırları shared/constants JAIL ile aynı. */
const DX = -29.5;

// ---------------------------------------------------------------------------
// Zindan: üç tarafı taş duvar, meydana bakan yüzü demir parmaklık. Üstü açık (kamera görsün).
// ---------------------------------------------------------------------------

export function dungeon(b: Builder): { signAt: THREE.Matrix4 } {
  const x0 = -30 + DX, x1 = -21 + DX; // dış kenarlar
  const z0 = 0.8, z1 = 9.2;
  const barsX = -21.4 + DX;
  const H = 3.2;
  const cz = (z0 + z1) / 2;

  // Zemin: koyu taş döşeme + çevresinde kararmış toprak
  b.add(part(new THREE.CircleGeometry(7.5, 20), "#585d50", flatMat(-24.5 + DX, 0.012, cz), 0.15, b.rand));
  box(b, x1 - x0 + 0.4, 0.12, z1 - z0 + 0.4, "#4a4d52", (x0 + x1) / 2, 0.06, cz, 0, 0.12);

  // Duvarlar (taş blok dokusu için parçalı)
  for (let z = z0; z < z1 - 0.01; z += 1.4) {
    const d = Math.min(1.4, z1 - z);
    box(b, 0.8, H, d, b.rand() > 0.5 ? STONE : STONE_DARK, x0 + 0.4, H / 2, z + d / 2, 0, 0.1);
  }
  for (const wz of [z0 + 0.4, z1 - 0.4]) {
    for (let x = x0 + 0.8; x < x1 - 0.31; x += 1.4) {
      const w = Math.min(1.4, x1 - 0.3 - x);
      box(b, w, H, 0.8, b.rand() > 0.5 ? STONE : STONE_DARK, x + w / 2, H / 2, wz, 0, 0.1);
    }
  }
  // Mazgallar
  for (let z = z0 + 0.3; z < z1; z += 1.2) box(b, 0.8, 0.45, 0.55, STONE, x0 + 0.4, H + 0.22, z, 0, 0.1);
  for (const wz of [z0 + 0.4, z1 - 0.4]) {
    for (let x = x0 + 1.4; x < x1 - 0.5; x += 1.2) box(b, 0.55, 0.45, 0.8, STONE, x, H + 0.22, wz, 0, 0.1);
  }
  // Ön köşe kuleleri
  for (const pz of [z0 + 0.4, z1 - 0.4]) {
    box(b, 1.1, H + 0.8, 1.1, STONE_DARK, x1 - 0.35, (H + 0.8) / 2, pz, 0, 0.1);
    box(b, 1.3, 0.3, 1.3, STONE, x1 - 0.35, H + 0.95, pz);
  }

  // Parmaklıklar
  const bar = new THREE.CylinderGeometry(0.045, 0.045, H - 0.3, 5);
  for (let z = z0 + 1.05; z < z1 - 0.9; z += 0.34) b.add(part(bar.clone(), IRON, mat(barsX, (H - 0.3) / 2 + 0.15, z)));
  box(b, 0.22, 0.3, z1 - z0 - 1.2, IRON, barsX, H - 0.05, cz);
  box(b, 0.22, 0.14, z1 - z0 - 1.2, IRON, barsX, 0.2, cz);

  // Hücre içi: taş sedir (oturulabilir), saman, kova, duvara asılı zincirler
  box(b, 0.6, 0.45, 3, STONE_DARK, x0 + 1.2, 0.22, cz, 0, 0.1);
  for (const o of [-0.8, 0.8]) b.seats.push({ x: x0 + 1.35, z: cz + o, rot: Math.PI / 2 });
  b.add(part(new THREE.IcosahedronGeometry(0.7, 0), "#c9a94f", mat(-23.2 + DX, 0.15, z0 + 1.8, 0.4, 1.2, 0.35, 1), 0.25, b.rand));
  b.add(part(new THREE.CylinderGeometry(0.22, 0.18, 0.35, 8), "#6b5a3e", mat(-22.6 + DX, 0.3, z1 - 1.5)));
  for (const cz2 of [cz - 1.6, cz + 1.6]) {
    for (let i = 0; i < 5; i++) {
      b.add(part(new THREE.TorusGeometry(0.07, 0.022, 4, 6), IRON, mat(x0 + 0.86, 2.4 - i * 0.13, cz2, (i % 2) * (Math.PI / 2))));
    }
  }

  // Meşaleler: kulelerin önünde
  for (const tz of [z0 - 0.3, z1 + 0.3]) {
    b.add(part(new THREE.CylinderGeometry(0.06, 0.08, 2, 6), WOOD_DARK, mat(x1 + 0.4, 1, tz)));
    b.add(part(new THREE.CylinderGeometry(0.2, 0.1, 0.25, 7), IRON, mat(x1 + 0.4, 2.1, tz)));
    b.prop("flame", mat(x1 + 0.4, 2.42, tz, 0, 0.9));
    b.colliders.circle(x1 + 0.4, tz, 0.15);
  }

  // Çarpışma: duvarlar + parmaklık (içerden dışarı, dışarıdan içeri geçilmez)
  b.colliders.segment(x0 + 0.4, z0, x0 + 0.4, z1, 0.4);
  b.colliders.segment(x0, z0 + 0.4, x1, z0 + 0.4, 0.4);
  b.colliders.segment(x0, z1 - 0.4, x1, z1 - 0.4, 0.4);
  b.colliders.segment(barsX, z0, barsX, z1, 0.12);
  b.colliders.circle(x1 - 0.35, z0 + 0.4, 0.6);
  b.colliders.circle(x1 - 0.35, z1 - 0.4, 0.6);

  // Çevre: kuru ağaç, kayalar, kemik yığını
  b.clearBox(x0 - 0.5, x1 + 5, z0 - 2, z1 + 2); // önünde ziyaretçi alanı
  const dead = new THREE.CylinderGeometry(0.12, 0.2, 2.6, 5);
  b.add(part(dead, "#4b3b2c", mat(-31.5 + DX, 1.3, 11, 0, 1)));
  b.add(part(new THREE.CylinderGeometry(0.05, 0.08, 1.2, 4), "#4b3b2c", mat(-31.2 + DX, 2.1, 11, 0.6).multiply(new THREE.Matrix4().makeRotationZ(-0.9))));
  b.add(part(new THREE.CylinderGeometry(0.04, 0.07, 1, 4), "#4b3b2c", mat(-31.8 + DX, 1.7, 11.2, 2.1).multiply(new THREE.Matrix4().makeRotationZ(0.8))));
  b.colliders.circle(-31.5 + DX, 11, 0.25);
  for (let i = 0; i < 6; i++) {
    const a = b.rand() * 0.6;
    b.add(part(new THREE.IcosahedronGeometry(0.09, 0), "#e8e2cf", mat(-28.4 + a + DX, 0.15 + (i % 3) * 0.05, 8.1 - a, 0, 1)));
  }
  b.add(part(new THREE.IcosahedronGeometry(0.16, 0), "#efe9d8", mat(-28.1 + DX, 0.32, 7.9, 0, 1, 0.9, 1.1)));
  for (const [rx, rz, s] of [[-19.5 + DX, -0.5, 0.8], [-20 + DX, 11, 1.1], [-32.5 + DX, 3, 1.3], [-31.8 + DX, -1.5, 0.9]]) {
    b.prop("rock", mat(rx, 0.15 * s, rz, b.rand() * 6, s, s * 0.7, s));
    b.colliders.circle(rx, rz, 0.5 * s);
  }

  // Tabela: parmaklığın üstünde, meydana bakar; arkasında pano
  box(b, 0.1, 0.85, 3.0, "#1c1d21", x1 - 0.06, H + 0.55, cz);
  return { signAt: mat(x1 + 0.02, H + 0.55, cz, Math.PI / 2) };
}

// ---------------------------------------------------------------------------
// LAGER'in mangalı: doğuda, sık ağaçların arasında bir açıklık.
// ---------------------------------------------------------------------------

export const GROVE = { x: 58, z: 5 };
/** Mangal tabelası: orman girişinde, yolun kenarında. Çevresine ağaç dikilmez. */
export const GROVE_SIGN = { x: GROVE.x - 6.4, z: GROVE.z - 1.9 };
const SIGN_CLEAR = 3.2;

export function grove(b: Builder): { signAt: THREE.Matrix4; coals: THREE.Mesh; smokeAt: THREE.Vector3 } {
  const { x: gx, z: gz } = GROVE;
  const grillX = gx + 0.6, grillZ = gz;

  // Orman zemini ve köz etrafındaki toprak
  b.add(part(new THREE.CircleGeometry(7, 22), "#5f8a3d", flatMat(gx, 0.012, gz), 0.1, b.rand));
  b.add(part(new THREE.CircleGeometry(3.6, 18), "#8d7350", flatMat(grillX, 0.02, grillZ), 0.12, b.rand));
  b.clearCircle(gx, gz, 6.2);
  b.clearCircle(GROVE_SIGN.x, GROVE_SIGN.z, SIGN_CLEAR);

  // Mangal: ayaklar, gövde, ızgara teli, şişler
  const metal = "#2c2d31";
  for (const [lx, lz] of [[-0.55, -0.2], [0.55, -0.2], [-0.55, 0.2], [0.55, 0.2]]) {
    box(b, 0.06, 0.75, 0.06, metal, grillX + lx, 0.37, grillZ + lz);
  }
  box(b, 1.35, 0.28, 0.6, metal, grillX, 0.86, grillZ);
  box(b, 1.45, 0.05, 0.08, "#3d3f45", grillX, 1.0, grillZ - 0.32);
  box(b, 1.45, 0.05, 0.08, "#3d3f45", grillX, 1.0, grillZ + 0.32);
  for (let i = 0; i < 7; i++) box(b, 0.02, 0.02, 0.62, "#9aa0a8", grillX - 0.6 + i * 0.2, 1.06, grillZ);
  const foods = ["#7a3b1f", "#8a4423", "#3f8f3a", "#c43a2b", "#7a3b1f"];
  for (let s = 0; s < 3; s++) {
    const sz = grillZ - 0.18 + s * 0.18;
    b.add(part(new THREE.CylinderGeometry(0.008, 0.008, 1.5, 3), "#c8c8c8", mat(grillX, 1.12, sz).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))));
    for (let i = 0; i < 5; i++) box(b, 0.11, 0.09, 0.09, foods[(i + s) % foods.length], grillX - 0.44 + i * 0.22, 1.12, sz, b.rand(), 0.15);
  }
  b.colliders.circle(grillX, grillZ, 0.85);
  b.shadow(grillX, grillZ, 1.2);

  const coals = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.48), new THREE.MeshBasicMaterial({ color: "#ff7a2a" }));
  coals.position.set(grillX, 1.0, grillZ);
  coals.updateMatrix();
  coals.matrixAutoUpdate = false;

  // Kütük oturaklar: mangalın etrafında, ona bakan
  for (const deg of [35, 105, 175, 250, 320]) {
    const a = THREE.MathUtils.degToRad(deg);
    const lx = grillX + Math.cos(a) * 2.7, lz = grillZ + Math.sin(a) * 2.7;
    const tx = -Math.sin(a), tz = Math.cos(a); // teğet
    const ry = Math.atan2(tx, tz);
    b.prop("log", mat(lx, 0.22, lz, ry));
    b.colliders.segment(lx - tx * 0.7, lz - tz * 0.7, lx + tx * 0.7, lz + tz * 0.7, 0.28);
    const face = Math.atan2(grillX - lx, grillZ - lz);
    for (const o of [-0.4, 0.4]) b.seats.push({ x: lx + tx * o, z: lz + tz * o, rot: face });
  }

  // Piknik masası
  const tx0 = gx - 3.6, tz0 = gz + 4.2;
  box(b, 1.9, 0.08, 0.85, "#a0703f", tx0, 0.76, tz0, 0, 0.1);
  for (const lx of [-0.75, 0.75]) box(b, 0.08, 0.72, 0.7, WOOD_DARK, tx0 + lx, 0.37, tz0);
  for (const oz of [-0.72, 0.72]) {
    box(b, 1.9, 0.06, 0.3, "#9a6a3a", tx0, 0.45, tz0 + oz);
    for (const lx of [-0.75, 0.75]) box(b, 0.06, 0.42, 0.2, WOOD_DARK, tx0 + lx, 0.21, tz0 + oz);
    for (const sx of [-0.5, 0.5]) b.seats.push({ x: tx0 + sx, z: tz0 + oz * 1.25, rot: oz < 0 ? 0 : Math.PI });
  }
  b.colliders.segment(tx0 - 0.9, tz0, tx0 + 0.9, tz0, 0.75);
  b.shadow(tx0, tz0, 1.4);

  // Buzluk
  box(b, 0.62, 0.38, 0.42, "#2f6fd0", gx + 3.2, 0.2, gz + 2.6, 0.3);
  box(b, 0.66, 0.08, 0.46, "#f2f2f2", gx + 3.2, 0.43, gz + 2.6, 0.3);
  b.colliders.circle(gx + 3.2, gz + 2.6, 0.4);

  // Ağaçlar arası ışık zinciri: oturma alanını çevreleyen 4 direk, sarkan küçük ampuller (kapalı halka)
  const posts: [number, number][] = [[gx - 2.5, gz - 4.6], [gx + 3.8, gz - 3.6], [gx + 4.6, gz + 4.2], [gx - 4.8, gz + 1.4]];
  for (const [px, pz] of posts) {
    b.add(part(new THREE.CylinderGeometry(0.07, 0.09, 2.8, 6), WOOD_DARK, mat(px, 1.4, pz)));
    b.colliders.circle(px, pz, 0.12);
  }
  for (let s = 0; s < posts.length; s++) {
    const [ax, az] = posts[s], [bx, bz] = posts[(s + 1) % posts.length];
    const n = Math.round(Math.hypot(bx - ax, bz - az) * 2);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const sag = Math.sin(t * Math.PI) * 0.55;
      b.prop("bulb", mat(ax + (bx - ax) * t, 2.7 - sag, az + (bz - az) * t, 0, 0.3));
    }
  }

  // Sık orman halkası, meydana bakan tarafta giriş boşluğu
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2 + b.rand() * 0.1;
    const dirToPlaza = Math.PI; // -x
    const da = Math.abs(((a - dirToPlaza + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (da < 0.45) continue;
    const r = 7.2 + b.rand() * 4.5;
    const x = gx + Math.cos(a) * r, z = gz + Math.sin(a) * r;
    if (Math.hypot(x - GROVE_SIGN.x, z - GROVE_SIGN.z) < SIGN_CLEAR) continue;
    const s = 0.85 + b.rand() * 0.6;
    b.prop(b.rand() > 0.45 ? "pine" : "oak", mat(x, 0, z, b.rand() * 6, s));
    b.colliders.circle(x, z, 0.32 * s);
    b.shadow(x, z, 1.5 * s);
  }
  for (let i = 0; i < 10; i++) {
    const a = b.rand() * Math.PI * 2;
    const r = 6 + b.rand() * 1.5;
    const s = 0.6 + b.rand() * 0.5;
    const x = gx + Math.cos(a) * r, z = gz + Math.sin(a) * r;
    if (Math.hypot(x - GROVE_SIGN.x, z - GROVE_SIGN.z) < SIGN_CLEAR - 1) continue;
    b.prop("bush", mat(x, 0.2 * s, z, b.rand() * 6, s, s * 0.8, s));
  }

  return {
    signAt: mat(GROVE_SIGN.x, 1.75, GROVE_SIGN.z, -Math.PI / 2),
    coals,
    smokeAt: new THREE.Vector3(grillX, 1.15, grillZ),
  };
}

/** Tabela direği (tabela yüzü ayrı, yazılı dokuyla çizilir). */
export function signPost(b: Builder, x: number, z: number, h: number): void {
  b.add(part(new THREE.BoxGeometry(0.14, h, 0.14), WOOD_DARK, mat(x, h / 2, z)));
  b.add(part(new THREE.BoxGeometry(0.06, 0.65, 2.35), WOOD_DARK, mat(x - 0.05, h - 0.35, z)));
  b.colliders.circle(x, z, 0.12);
}

// ---------------------------------------------------------------------------
// Gölet: güneyde, kenarında bir bank.
// ---------------------------------------------------------------------------

export const POND = { x: 24, z: 56 };

/**
 * Suyun çevresi: gökyüzü yansıması (DayNight renkleri), yağmur damlaları, donma ve dalga halkaları
 * (kıyıda yürüyen, balık, kayık). scene.ts gökyüzü uniform'larını buraya bağlar.
 */
export const RIPPLES = 8;
export const waterEnv = {
  uSkyH: { value: new THREE.Color("#a9cfee") },
  uSkyT: { value: new THREE.Color("#5b8fd6") },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uRain: { value: 0 },
  uFrozen: { value: 0 },
  uRipples: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector3(0, 0, -100)) },
};
let rippleNext = 0;

/** Suya bir halka bırak (x, z dünya; `time` döngü saati sn). */
export function addRipple(x: number, z: number, time: number): void {
  waterEnv.uRipples.value[rippleNext++ % RIPPLES].set(x, z, time);
}

/**
 * Su yüzeyi: dalga, parıltı, kıyı köpüğü ve `ring` noktasının çevresinde yayılan halkalar
 * (gölde ördek, çeşmede suyun düştüğü yer); hepsi fragment shader'da. `ringR` > 0 ise halkalar
 * noktadan değil o yarıçaptaki çemberden yayılır; `hole` halkanın tam ortasını boş bırakır.
 */
export function waterMaterial(
  cx: number,
  cz: number,
  r: number,
  ring: { value: THREE.Vector2 },
  ringR = 0,
  hole = 0.25,
): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.uniforms.uDuck = ring;
    shader.uniforms.uDeep = { value: new THREE.Color("#3a7fba") };
    shader.uniforms.uShallow = { value: new THREE.Color("#5ea8db") };
    Object.assign(shader.uniforms, waterEnv);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vWater;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWater = (modelMatrix * vec4(transformed, 1.0)).xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime;
        uniform vec2 uDuck;
        uniform vec3 uDeep;
        uniform vec3 uShallow;
        uniform vec3 uSkyH;
        uniform vec3 uSkyT;
        uniform vec3 uSunDir;
        uniform float uRain;
        uniform float uFrozen;
        uniform vec3 uRipples[${RIPPLES}];
        varying vec2 vWater;
        float vWave;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec2 q = vWater - vec2(${cx.toFixed(2)}, ${cz.toFixed(2)});
        float d = length(q) / ${r.toFixed(2)};
        diffuseColor.rgb = mix(uDeep, uShallow, smoothstep(0.15, 1.0, d));
        float w = sin(vWater.x * 1.9 + uTime * 1.2) * sin(vWater.y * 2.3 - uTime * 0.9)
                + 0.5 * sin((vWater.x - vWater.y) * 3.7 + uTime * 1.8);
        diffuseColor.rgb += w * 0.03 + smoothstep(1.1, 1.45, w) * 0.22;
        float dd = abs(distance(vWater, uDuck) - ${ringR.toFixed(2)});
        diffuseColor.rgb += max(sin(dd * 10.0 - uTime * 5.0), 0.0) * exp(-dd * 1.5) * smoothstep(${hole.toFixed(2)}, ${(hole + 0.2).toFixed(2)}, dd) * 0.16;
        float shore = smoothstep(0.88, 1.0, d + 0.03 * sin(atan(q.y, q.x) * 7.0 + uTime * 1.5));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.9, 0.95), shore * 0.5);
        vWave = w;
        // Dalga halkaları: yürüyen, balık, kayık
        for (int i = 0; i < ${RIPPLES}; i++) {
          vec3 rp = uRipples[i];
          float age = uTime - rp.z;
          if (age < 0.0 || age > 3.0) continue;
          float ring = abs(distance(vWater, rp.xy) - age * 1.3);
          diffuseColor.rgb += (1.0 - smoothstep(0.0, 0.1, ring)) * (1.0 - age / 3.0) * 0.28;
        }
        // Yağmur damlaları: hücre başına rastgele anda açılan küçük halkalar
        if (uRain > 0.0) {
          vec2 g = vWater * 1.6;
          vec2 id = floor(g);
          float h = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
          float t = fract(uTime * 0.9 + h);
          vec2 c = id + 0.5 + (vec2(h, fract(h * 7.3)) - 0.5) * 0.6;
          float rr = abs(length(g - c) - t * 0.45);
          diffuseColor.rgb += (1.0 - smoothstep(0.0, 0.06, rr)) * (1.0 - t) * 0.3 * uRain * step(h, uRain);
        }
        // Donmuş göl: buz rengi, dalgasız
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.88, 0.95) + w * 0.015, uFrozen);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          // Gökyüzü yansıması (bakış açısı yataylaştıkça artar) ve güneş parıltısı
          vec3 wpos = vec3(vWater.x, 0.03, vWater.y);
          vec3 V = normalize(cameraPosition - wpos);
          vec3 N = normalize(vec3(vWave * 0.05, 1.0, vWave * 0.03));
          float fres = pow(1.0 - max(dot(V, N), 0.0), 4.0);
          vec3 R = reflect(-V, N);
          vec3 sky = mix(uSkyH, uSkyT, pow(max(R.y, 0.0), 0.7));
          float glint = pow(max(dot(R, normalize(uSunDir)), 0.0), 240.0) * 2.5;
          totalEmissiveRadiance += (sky * fres * 0.7 + vec3(1.0, 0.95, 0.85) * glint) * (1.0 - uFrozen * 0.7);
        }`,
      );
  };
  m.customProgramCacheKey = () => `water-${cx}-${cz}-${r}-${ringR}-${hole}`;
  return m;
}

/** Ana ördek + iki yavru, tek InstancedMesh. Model +z'ye bakar, su çizgisi y=0. */
function duckMesh(): THREE.InstancedMesh {
  const white = "#f4f1e8";
  const geo = mergeGeometries([
    part(new THREE.SphereGeometry(1, 7, 5), white, mat(0, 0.1, 0, 0, 0.22, 0.15, 0.32)),
    part(new THREE.ConeGeometry(0.08, 0.18, 5), white, new THREE.Matrix4().makeRotationX(-1).setPosition(0, 0.16, -0.3)),
    part(new THREE.CylinderGeometry(0.06, 0.08, 0.18, 6), white, mat(0, 0.22, 0.17)),
    part(new THREE.SphereGeometry(0.12, 7, 5), white, mat(0, 0.33, 0.2)),
    part(new THREE.BoxGeometry(0.09, 0.04, 0.13), "#f29a2e", mat(0, 0.31, 0.35)),
    part(new THREE.BoxGeometry(0.22, 0.03, 0.03), "#1a1a1a", mat(0, 0.36, 0.25)),
  ]);
  const m = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), 3);
  m.setColorAt(0, new THREE.Color(1, 1, 1));
  for (const i of [1, 2]) m.setColorAt(i, new THREE.Color("#ffd84a"));
  m.frustumCulled = false;
  return m;
}

export function pond(b: Builder): { water: THREE.Mesh; ducks: THREE.InstancedMesh; update(time: number): void } {
  const { x: px, z: pz } = POND;
  const r = 6.5;
  b.add(part(new THREE.CircleGeometry(r + 0.8, 24), "#d6c48e", flatMat(px, 0.012, pz), 0.08, b.rand));
  const duckAt = { value: new THREE.Vector2(px, pz) };
  const water = new THREE.Mesh(new THREE.CircleGeometry(r, 32).applyMatrix4(flatMat(px, 0.03, pz)), waterMaterial(px, pz, r, duckAt));
  water.matrixAutoUpdate = false;
  const ducks = duckMesh();
  for (let i = 0; i < 6; i++) {
    const a = b.rand() * Math.PI * 2, d = b.rand() * r * 0.75;
    b.add(part(new THREE.CircleGeometry(0.22 + b.rand() * 0.12, 7, 0.5, Math.PI * 1.8), "#4f9a45", flatMat(px + Math.cos(a) * d, 0.045, pz + Math.sin(a) * d, 1, 1, b.rand() * 6)));
  }
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + b.rand() * 0.3;
    const s = 0.4 + b.rand() * 0.5;
    b.prop("rock", mat(px + Math.cos(a) * (r + 0.6), 0.1 * s, pz + Math.sin(a) * (r + 0.6), b.rand() * 6, s, s * 0.6, s));
  }
  b.colliders.circle(px, pz, r);
  b.clearCircle(px, pz, r + 0.9);

  // Kayık iskelesi: batı kıyısında, suya uzanan tahtalar
  for (let i = 0; i < 6; i++) {
    box(b, 0.42, 0.08, 1.5, i % 2 ? "#8f6640" : "#9b7451", DOCK.x - 1.2 + i * 0.45, 0.18, DOCK.z, 0, 0.08);
  }
  for (const [ox, oz] of [[-1.3, -0.7], [-1.3, 0.7], [1.2, -0.7], [1.2, 0.7]]) {
    b.add(part(new THREE.CylinderGeometry(0.07, 0.08, 0.7, 6), WOOD_DARK, mat(DOCK.x + ox, 0.12, DOCK.z + oz)));
  }
  b.clearCircle(DOCK.x, DOCK.z, 2.4);

  // Göle bakan bank
  const bx = px - 0.2, bz = pz - r - 2;
  box(b, 1.8, 0.1, 0.45, "#a0703f", bx, 0.45, bz, 0);
  box(b, 1.8, 0.45, 0.07, WOOD, bx, 0.72, bz - 0.22, 0);
  for (const lx of [-0.75, 0.75]) box(b, 0.08, 0.45, 0.4, WOOD_DARK, bx + lx, 0.22, bz);
  b.colliders.segment(bx - 0.85, bz, bx + 0.85, bz, 0.3);
  for (const o of [-0.45, 0.45]) b.seats.push({ x: bx + o, z: bz, rot: 0 });
  b.shadow(bx, bz, 1.2);

  // Ördekler gölü dalgalı bir halkada turlar; yavrular aynı yolu biraz geriden izler.
  const path = (t: number, out: THREE.Vector2) =>
    out.set(px + Math.cos(t * 0.1) * r * (0.55 + 0.12 * Math.sin(t * 0.23)), pz + Math.sin(t * 0.1) * r * (0.55 + 0.12 * Math.sin(t * 0.23)));
  const p0 = new THREE.Vector2(), p1 = new THREE.Vector2();
  const euler = new THREE.Euler(0, 0, 0, "YXZ"), q = new THREE.Quaternion();
  const pos = new THREE.Vector3(), scale = new THREE.Vector3(), m4 = new THREE.Matrix4();
  return {
    water,
    ducks,
    update(time) {
      for (let i = 0; i < 3; i++) {
        const t = time - i * 2.2;
        path(t, p0);
        path(t + 0.05, p1);
        // Ana ördek ~14 sn'de bir başını suya daldırır
        const cyc = time % 14;
        const dip = i === 0 && cyc < 1.6 ? Math.sin((cyc / 1.6) * Math.PI) : 0;
        euler.set(dip * 1.0, Math.atan2(p1.x - p0.x, p1.y - p0.y) + 0.15 * Math.sin(time * 1.7 + i), 0.06 * Math.sin(time * 2.1 + i));
        const s = i ? 0.5 : 1;
        pos.set(p0.x, 0.03 + 0.015 * Math.sin(time * 2.4 + i * 1.3), p0.y);
        ducks.setMatrixAt(i, m4.compose(pos, q.setFromEuler(euler), scale.set(s, s, s)));
        if (i === 0) duckAt.value.copy(p0);
      }
      ducks.instanceMatrix.needsUpdate = true;
    },
  };
}
