// GAP Garaj: berberin arkasındaki tuning atölyesi (GTA'daki LS Customs gibi). Koyu metal cephe, turuncu şerit,
// neon "GAP GARAJ" tabelası, yukarı sarılmış kepenk; içeride parlak sarı işaretli döner platform, iki direkli
// lift, alet duvarı, lastik rafı, tezgâh ve kırmızı takım dolabı. Arabayla kepenkten girilip işarete gelinir.
import * as THREE from "three";
import { GARAGE } from "../../../shared/zones";
import type { Builder } from "./builder";
import { mat, part } from "./geo";

export interface GarageView {
  group: THREE.Group;
  /** Kamera sınırı ve gölge için oda. */
  room: { minX: number; maxX: number; minZ: number; maxZ: number; ceil: number };
  /** İşaret nabız gibi parlar; tuning açıkken söner. */
  update(time: number, active: boolean): void;
}

const WALL_OUT = "#2c3036";
const WALL_IN = "#565c66";
const FLOOR = "#474b52";
const ORANGE = "#ff7a1a";
const HAZARD = "#f2c230";

function signTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#101216";
  g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = ORANGE;
  g.lineWidth = 10;
  g.strokeRect(14, 14, 996, 228);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = ORANGE;
  g.shadowBlur = 28;
  g.font = "italic 900 132px system-ui, sans-serif";
  g.fillStyle = "#ffffff";
  g.fillText("GAP GARAJ", 512, 112);
  g.shadowBlur = 10;
  g.font = "800 38px system-ui, sans-serif";
  g.fillStyle = ORANGE;
  g.fillText("TUNING · BOYA · JANT · NEON", 512, 206);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function garage(b: Builder): GarageView {
  const group = new THREE.Group();
  const rand = b.rand;
  const add = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, m?: THREE.Matrix4, jitter = 0.03) => b.add(part(geo, color, m, jitter, rand));
  const box = (w: number, h: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, ry = 0, jitter = 0.03) =>
    add(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry), jitter);
  const cyl = (r0: number, r1: number, h: number, color: string, x: number, y: number, z: number, seg = 12) =>
    add(new THREE.CylinderGeometry(r0, r1, h, seg), color, mat(x, y, z), 0.02);
  const glows: THREE.BufferGeometry[] = [];
  const glow = (w: number, h: number, d: number, color: string, x: number, y: number, z: number, ry = 0) => glows.push(part(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry)));

  const { x: CX, z: CZ, w: W, d: D, h: H, door: DOOR } = GARAGE;
  const x0 = CX - W / 2, x1 = CX + W / 2, z0 = CZ - D / 2, z1 = CZ + D / 2, T = 0.3;
  b.clearBox(x0 - 1, x1 + 4, z0 - 1, z1 + 1);

  // ---- Zemin: epoksi beton, platform çevresinde sarı-siyah ikaz şeridi ----
  box(W, 0.06, D, FLOOR, CX, 0.03, CZ, 0, 0.02);
  const sp = GARAGE.spot;
  cyl(3.1, 3.1, 0.05, "#2a2d33", sp.x, 0.08, sp.z, 40);
  cyl(2.95, 2.95, 0.055, "#3b3f47", sp.x, 0.085, sp.z, 40);
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    box(0.7, 0.012, 0.18, k % 2 ? HAZARD : "#141518", sp.x + Math.cos(a) * 3.25, 0.065, sp.z + Math.sin(a) * 3.25, -a + Math.PI / 2, 0);
  }
  // Kapıdan platforma giden sürüş şeridi (beyaz kenar çizgileri)
  for (const s of [-1, 1]) box(x1 - (sp.x + 3.3), 0.012, 0.12, "#e8e8e2", (x1 + sp.x + 3.3) / 2, 0.065, CZ + s * 1.6, 0, 0);

  // ---- Duvarlar: dış koyu metal (dikey nervürler), iç açık gri; doğu cephede kapı boşluğu ----
  const wall = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az), ry = Math.atan2(-(bz - az), bx - ax);
    box(len, H, T, WALL_OUT, (ax + bx) / 2, H / 2, (az + bz) / 2, ry, 0.02);
    b.colliders.segment(ax, az, bx, bz, T / 2);
  };
  wall(x0, z0, x1, z0);
  wall(x0, z1, x1, z1);
  wall(x0, z0, x0, z1);
  wall(x1, z0, x1, CZ - DOOR);
  wall(x1, CZ + DOOR, x1, z1);
  // Kapının üstü (lento) ve çatı
  const doorH = 4.3;
  box(T, H - doorH, 2 * DOOR + 0.2, WALL_OUT, x1, doorH + (H - doorH) / 2, CZ, 0, 0.02);
  box(W + 0.6, 0.35, D + 0.6, "#24272c", CX, H + 0.17, CZ, 0, 0.02);
  box(W + 0.7, 0.3, D + 0.7, ORANGE, CX, H - 0.6, CZ, 0, 0);
  // Dış nervürler (uzun yüzler)
  for (let z = z0 + 1; z < z1; z += 1.2) for (const x of [x0 - T / 2 - 0.04]) box(0.08, H - 0.7, 0.12, "#3a3f47", x, (H - 0.7) / 2, z, 0, 0);
  for (let x = x0 + 1; x < x1; x += 1.2) for (const z of [z0 - T / 2 - 0.04, z1 + T / 2 + 0.04]) box(0.12, H - 0.7, 0.08, "#3a3f47", x, (H - 0.7) / 2, z, 0, 0);
  // İç kaplama (açık gri) ve süpürgelik
  for (const [w, d, x, z] of [[W - 2 * T, 0.04, CX, z0 + T / 2 + 0.03], [W - 2 * T, 0.04, CX, z1 - T / 2 - 0.03], [0.04, D - 2 * T, x0 + T / 2 + 0.03, CZ]] as const) {
    box(w, H - 0.4, d, WALL_IN, x, (H - 0.4) / 2, z, 0, 0.02);
    box(w === 0.04 ? 0.06 : w, 0.25, w === 0.04 ? d : 0.06, "#1d1f23", x, 0.13, z, 0, 0);
  }
  for (const s of [-1, 1]) box(0.04, H - 0.4, D / 2 - DOOR - T, WALL_IN, x1 - T / 2 - 0.03, (H - 0.4) / 2, CZ + s * (DOOR + (D / 2 - DOOR) / 2), 0, 0.02);

  // ---- Kapı: sarı-siyah ikaz çerçevesi, yukarı sarılmış kepenk, üstte neon tabela ----
  for (const s of [-1, 1]) {
    for (let k = 0; k < 9; k++) box(0.22, 0.48, 0.24, k % 2 ? HAZARD : "#141518", x1 + 0.12, 0.24 + k * 0.48, CZ + s * (DOOR + 0.12), 0, 0);
  }
  add(new THREE.CylinderGeometry(0.32, 0.32, 2 * DOOR + 0.3, 16).rotateX(Math.PI / 2), "#8a9099", mat(x1 - 0.5, doorH - 0.15, CZ), 0.02);
  box(0.08, 0.5, 2 * DOOR, "#6f757e", x1 - 0.18, doorH - 0.42, CZ, 0, 0.02);
  const signMat = new THREE.MeshBasicMaterial({ map: signTexture() });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 1.65), signMat);
  sign.position.set(x1 + 0.2, doorH + 1.0, CZ);
  sign.rotation.y = Math.PI / 2;
  group.add(sign);
  box(0.12, 1.85, 6.8, "#101216", x1 + 0.12, doorH + 1.0, CZ, 0, 0);
  glow(0.06, 0.06, 2 * DOOR, ORANGE, x1 + 0.2, doorH + 0.05, CZ);
  // Kapının iki yanında dikey turuncu ışık şeridi
  for (const s of [-1, 1]) glow(0.06, H - 1, 0.08, ORANGE, x1 + 0.2, (H - 1) / 2 + 0.3, CZ + s * (DOOR + 1.6));
  // Kaldırımdan kapıya rampa
  box(3, 0.08, 2 * DOOR, "#3f434a", x1 + 1.5, 0.1, CZ, 0, 0.03);

  // ---- İç: tavan ışıkları ----
  for (let z = z0 + 3; z < z1 - 2; z += 4.5) for (const x of [CX - 3, CX + 2.5]) {
    box(3.4, 0.08, 0.5, "#1d1f23", x, H - 0.45, z, 0, 0);
    glow(3.2, 0.04, 0.32, "#f4f8ff", x, H - 0.5, z);
  }
  // Platformun üstünde halka spot
  glows.push(part(new THREE.TorusGeometry(2.2, 0.05, 6, 40).rotateX(Math.PI / 2), "#ffe0b0", mat(sp.x, H - 0.55, sp.z)));

  // ---- Kuzey duvarı (z0): alet panosu, tezgâh, kırmızı takım dolabı ----
  {
    const z = z0 + T / 2 + 0.06;
    box(5, 2.2, 0.05, "#c9a46a", CX - 2, 2.4, z + 0.02, 0, 0.04);
    for (let k = 0; k < 14; k++) {
      const tx = CX - 4.2 + (k % 7) * 0.7, ty = 1.8 + Math.floor(k / 7) * 0.9;
      box(0.08, 0.5 + (k % 3) * 0.12, 0.04, ["#b9bec4", "#e8742a", "#1f4fbf", "#3a3d42"][k % 4], tx, ty + 0.2, z + 0.07, 0, 0);
    }
    box(5, 0.1, 0.8, "#6b4a2b", CX - 2, 0.95, z + 0.45, 0, 0.03);
    for (const s of [-1, 1]) box(0.08, 0.9, 0.7, "#2b2f36", CX - 2 + s * 2.3, 0.45, z + 0.45, 0, 0);
    box(0.5, 0.3, 0.35, "#3a3d42", CX - 3.6, 1.15, z + 0.45, 0, 0.02);
    box(1.2, 1.1, 0.6, "#c8102e", CX + 2.6, 0.55, z + 0.35, 0, 0.02);
    for (let k = 0; k < 4; k++) box(1.1, 0.02, 0.02, "#d0d4d9", CX + 2.6, 0.2 + k * 0.25, z + 0.66, 0, 0);
    b.colliders.segment(CX - 4.5, z + 0.5, CX + 3.3, z + 0.5, 0.45);
  }
  // ---- Güney duvarı (z1): iki direkli lift (yanında boş platform) ve lastik rafı ----
  {
    const z = z1 - 2.4;
    for (const s of [-1, 1]) {
      box(0.3, 3.6, 0.3, "#c8102e", CX - 3 + s * 1.6, 1.8, z, 0, 0.02);
      box(0.9, 0.08, 0.18, "#2b2f36", CX - 3 + s * 1.1, 0.6, z - 0.5, 0, 0);
      b.colliders.circle(CX - 3 + s * 1.6, z, 0.25);
    }
    box(3.5, 0.15, 0.2, "#c8102e", CX - 3, 3.55, z, 0, 0);
    // Lastik rafı: iki kat, kenarına dizili lastikler
    const rx = CX + 3.2, rz = z1 - 0.7;
    for (const y of [0.05, 1.2]) box(3.4, 0.06, 0.8, "#3a3f47", rx, y + 0.4, rz, 0, 0);
    for (const s of [-1, 1]) box(0.06, 2.0, 0.8, "#3a3f47", rx + s * 1.7, 1.0, rz, 0, 0);
    for (const y of [0.78, 1.93]) for (let k = 0; k < 5; k++) add(new THREE.TorusGeometry(0.26, 0.11, 6, 16), "#16171a", mat(rx - 1.3 + k * 0.65, y, rz), 0.02);
    b.colliders.segment(rx - 1.7, rz, rx + 1.7, rz, 0.45);
  }
  // Batı duvarı (x0): büyük "GAP" logosu ve kompresör
  {
    const x = x0 + T / 2 + 0.06;
    glow(0.04, 0.18, 5.2, ORANGE, x + 0.02, 4.6, CZ);
    glow(0.04, 0.18, 5.2, ORANGE, x + 0.02, 3.0, CZ);
    const logo = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.15), signMat);
    logo.position.set(x + 0.05, 3.8, CZ);
    logo.rotation.y = Math.PI / 2;
    group.add(logo);
    cyl(0.32, 0.32, 0.9, "#1f4fbf", x + 0.6, 0.45, z1 - 4.5, 14);
    b.colliders.circle(x + 0.6, z1 - 4.5, 0.35);
  }

  const glowMesh = new THREE.Mesh(mergeAll(glows), new THREE.MeshBasicMaterial({ vertexColors: true }));
  glowMesh.matrixAutoUpdate = false;
  group.add(glowMesh);

  // ---- Parlayan işaret: sarı halka ve hafif dolgu (GTA'daki gibi), nabız gibi ----
  const ringMat = new THREE.MeshBasicMaterial({ color: "#ffcc33", transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  const fillMat = new THREE.MeshBasicMaterial({ color: "#ffb21a", transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending });
  const marker = new THREE.Group();
  marker.add(new THREE.Mesh(new THREE.RingGeometry(1.55, 1.75, 48).rotateX(-Math.PI / 2), ringMat));
  marker.add(new THREE.Mesh(new THREE.CircleGeometry(1.55, 48).rotateX(-Math.PI / 2), fillMat));
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.65, 1.65, 1.6, 40, 1, true), new THREE.MeshBasicMaterial({ color: "#ffcc33", transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  beam.position.y = 0.8;
  marker.add(beam);
  marker.position.set(sp.x, 0.13, sp.z);
  for (const m of marker.children) m.renderOrder = 4;
  group.add(marker);

  return {
    group,
    room: { minX: x0 + T, maxX: x1 - T, minZ: z0 + T, maxZ: z1 - T, ceil: H - 0.3 },
    update(time, active) {
      marker.visible = !active;
      const k = 0.5 + 0.5 * Math.sin(time * 3.2);
      ringMat.opacity = 0.55 + 0.4 * k;
      fillMat.opacity = 0.1 + 0.12 * k;
      marker.scale.setScalar(1 + 0.04 * k);
    },
  };
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const total = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "color"]) {
    const arr = new Float32Array(total * 3);
    let o = 0;
    for (const g of geos) {
      const a = g.attributes[name].array as Float32Array;
      arr.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return out;
}
