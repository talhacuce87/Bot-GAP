// "GAP Meydanı": tamamen prosedürel, low-poly, vertex renkli sahne.
// Statik geometri tek mesh'te birleştirilir; tekrar eden objeler InstancedMesh ile çizilir;
// rüzgâr, alev ve duman vertex shader'da. Toplam ~20 draw call, gerçek zamanlı gölge yok.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { WORLD_RADIUS } from "../../../shared/constants";
import { Builder, type PropKind, type Seat } from "./builder";
import type { Colliders } from "./colliders";
import { FameBoard, fameStatics } from "./fame";
import { blobTexture, flatMat, flickerMaterial, instanced, mat, part, timeUniform, windMaterial } from "./geo";
import { dungeon, GROVE, grove, GROVE_SIGN, pond, signPost } from "./zones";

export type { Seat };

export interface World {
  scene: THREE.Scene;
  colliders: Colliders;
  seats: Seat[];
  /** Şöhret Kürsüsü: bot'un gönderdiği XP sıralaması. */
  fame: FameBoard;
  /** Watch party perdesinin dünya konumu (Faz 3). */
  screen: THREE.Mesh;
  spawn: { x: number; z: number; rot: number };
  /** Kare başına: shader saati ve birkaç ucuz animasyon. */
  update(time: number): void;
}

const SCREEN_Z = -22;
const SCREEN_W = 12;
const SCREEN_H = SCREEN_W * (9 / 16);
const AMPHI_CENTER_Z = -22;
const SKY = new THREE.Color("#a9cfee");
const SKY_TOP = new THREE.Color("#5b8fd6");

const tmp = new THREE.Color();

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

function screenTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 288, (g) => {
    const grad = g.createLinearGradient(0, 0, 512, 288);
    grad.addColorStop(0, "#1d2b4a");
    grad.addColorStop(1, "#3b2a5a");
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 288);
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.font = "700 64px system-ui, sans-serif";
    g.fillText("GAP SİNEMASI", 256, 140);
    g.font = "400 26px system-ui, sans-serif";
    g.fillStyle = "#c9cffd";
    g.fillText("watch party yakında", 256, 190);
  });
}

/** İki tabela tek dokuda: üst yarı ZİNDAN, alt yarı mangal. Tek draw call. */
function signsMesh(dungeonAt: THREE.Matrix4, groveAt: THREE.Matrix4): THREE.Mesh {
  const tex = canvasTexture(512, 256, (g) => {
    const board = (y: number, bg: string, edge: string, text: string, color: string, font: string) => {
      g.fillStyle = edge;
      g.fillRect(0, y, 512, 128);
      g.fillStyle = bg;
      g.fillRect(8, y + 8, 496, 112);
      g.fillStyle = color;
      g.font = font;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, 256, y + 66);
    };
    board(0, "#2a2c31", "#141518", "ZİNDAN", "#e8d9b0", "900 78px system-ui, sans-serif");
    board(128, "#a8743e", "#5b3f25", "LAGER'İN MANGALI", "#fff3dc", "800 52px system-ui, sans-serif");
  });
  const plane = (at: THREE.Matrix4, w: number, h: number, v0: number) => {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, v0 + uv.getY(i) * 0.5);
    g.applyMatrix4(at);
    return g;
  };
  const geo = mergeGeometries([plane(dungeonAt, 2.8, 0.7, 0.5), plane(groveAt, 2.2, 0.55, 0)]);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Parçalar
// ---------------------------------------------------------------------------

function groundColor(x: number, z: number, out: THREE.Color): THREE.Color {
  out.set("#6f9a4a");
  // Büyük ölçekli düzensiz lekeler: doku yerine vertex rengi
  const n = Math.sin(x * 0.21 + z * 0.13) * Math.cos(z * 0.17 - x * 0.07) + 0.5 * Math.sin(x * 0.53 - z * 0.41);
  out.offsetHSL(n * 0.012, 0, n * 0.035);
  const dg = Math.hypot(x - GROVE.x, z - GROVE.z);
  if (dg < 14) out.lerp(tmp.set("#557c36"), (1 - dg / 14) * 0.7);
  const dd = Math.hypot(x + 25, z - 5);
  if (dd < 11) out.lerp(tmp.set("#6b6f55"), (1 - dd / 11) * 0.6);
  return out;
}

/** Sınırın ötesinde zemin hafifçe yükselir: ufuk düz bir çizgi olmasın. */
function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r <= WORLD_RADIUS + 4) return 0;
  return Math.min(6, (r - WORLD_RADIUS - 4) * 0.18) + Math.sin(x * 0.3) * Math.cos(z * 0.25) * 0.6 * Math.min(1, (r - WORLD_RADIUS - 4) / 4);
}

function ground(b: Builder): void {
  const geo = new THREE.RingGeometry(0.01, 75, 72, 24);
  geo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, heightAt(x, z));
    groundColor(x, z, tmp).toArray(colors, i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.deleteAttribute("uv");
  geo.computeVertexNormals();
  b.add(geo.toNonIndexed());
}

function plaza(b: Builder): void {
  b.add(part(new THREE.CircleGeometry(10, 32), "#c9b99a", flatMat(0, 0.02, 0), 0.06, b.rand));
  b.add(part(new THREE.RingGeometry(10, 10.6, 32, 1), "#a8977a", flatMat(0, 0.03, 0)));
  // Merkez desen: iç içe halkalar
  b.add(part(new THREE.RingGeometry(3.2, 3.6, 24, 1), "#b3a383", flatMat(0, 0.025, 0)));
  b.add(part(new THREE.RingGeometry(6.4, 6.7, 28, 1), "#b3a383", flatMat(0, 0.025, 0)));
  b.add(part(new THREE.PlaneGeometry(3, 11), "#c9b99a", flatMat(0, 0.02, -14.5), 0.06, b.rand));
  b.clearCircle(0, 0, 11.2);
  b.clearBox(-1.8, 1.8, -21, -9);

  // Çeşme
  b.add(part(new THREE.CylinderGeometry(2.2, 2.4, 0.6, 14), "#9aa3ad", mat(0, 0.3, 0)));
  b.add(part(new THREE.CylinderGeometry(1.9, 1.9, 0.05, 14), "#4f8fc9", mat(0, 0.58, 0)));
  b.add(part(new THREE.CylinderGeometry(0.35, 0.5, 1.6, 8), "#9aa3ad", mat(0, 0.8, 0)));
  b.add(part(new THREE.CylinderGeometry(0.9, 0.6, 0.2, 10), "#a9b2bc", mat(0, 1.6, 0)));
  b.add(part(new THREE.CylinderGeometry(0.75, 0.75, 0.04, 10), "#5d9fd6", mat(0, 1.69, 0)));
  b.colliders.circle(0, 0, 2.4);

  // Saksılar: meydan kenarında çiçekli
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.sin(a) * 9.2, z = Math.cos(a) * 9.2;
    if (z < -8 || Math.abs(z - 5) < 1.5 || (Math.abs(x) < 2 && z > 0)) continue; // yolları ve doğma noktasını kapatma
    b.add(part(new THREE.CylinderGeometry(0.45, 0.35, 0.5, 8), "#b5643c", mat(x, 0.25, z)));
    b.prop("bush", mat(x, 0.62, z, a, 0.5, 0.45, 0.5));
    b.colliders.circle(x, z, 0.45);
  }

  // Lambalar
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.sin(a) * 11, z = Math.cos(a) * 11;
    if (z < -9) continue;
    b.prop("post", mat(x, 0, z));
    b.prop("bulb", mat(x, 2.7, z));
    b.colliders.circle(x, z, 0.15);
  }
}

function amphitheatre(b: Builder): THREE.Mesh {
  b.add(part(new THREE.BoxGeometry(18, 0.6, 4), "#8a6f55", mat(0, 0.3, SCREEN_Z - 0.5)));
  b.add(part(new THREE.BoxGeometry(SCREEN_W + 0.8, SCREEN_H + 0.8, 0.4), "#2a2f3a", mat(0, 1.2 + SCREEN_H / 2, SCREEN_Z - 1.6)));
  for (const sx of [-1, 1]) {
    b.add(part(new THREE.BoxGeometry(0.6, SCREEN_H + 2, 0.6), "#3a3f4c", mat(sx * (SCREEN_W / 2 + 0.7), (SCREEN_H + 2) / 2, SCREEN_Z - 1.6)));
    // Hoparlörler
    b.add(part(new THREE.BoxGeometry(1, 1.6, 0.8), "#23262d", mat(sx * 8, 1.4, SCREEN_Z - 0.9)));
    b.add(part(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 10), "#4a4f5a", mat(sx * 8, 1.7, SCREEN_Z - 0.48).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))));
  }
  b.colliders.segment(-9, SCREEN_Z - 0.5, 9, SCREEN_Z - 0.5, 2);
  b.clearBox(-20, 20, -27, -6);

  const bench = mergeGeometries([
    part(new THREE.BoxGeometry(2.2, 0.12, 0.5), "#a0703f", mat(0, 0.45, 0)),
    part(new THREE.BoxGeometry(2.2, 0.5, 0.08), "#8a5f35", mat(0, 0.75, -0.24)),
    part(new THREE.BoxGeometry(0.1, 0.45, 0.45), "#5b3f25", mat(-0.95, 0.22, 0)),
    part(new THREE.BoxGeometry(0.1, 0.45, 0.45), "#5b3f25", mat(0.95, 0.22, 0)),
  ]);
  const mats: THREE.Matrix4[] = [];
  for (let row = 0; row < 4; row++) {
    const R = 9 + row * 2.4;
    const half = THREE.MathUtils.degToRad(40);
    const aisle = 1.5 / R; // ortada yürüme koridoru
    const n = Math.floor(((half - aisle) * R) / 2.5);
    for (let k = 0; k < n * 2; k++) {
      const side = k < n ? -1 : 1;
      const i = k % n;
      const theta = side * (aisle + ((half - aisle) * (i + 0.5)) / n);
      const x = Math.sin(theta) * R;
      const z = AMPHI_CENTER_Z + Math.cos(theta) * R;
      const facing = theta + Math.PI; // perdeye bak
      mats.push(mat(x, 0, z, facing));
      const tx = Math.cos(theta), tz = -Math.sin(theta); // yay teğeti
      b.colliders.segment(x - tx * 1.05, z - tz * 1.05, x + tx * 1.05, z + tz * 1.05, 0.3);
      for (const o of [-0.7, 0, 0.7]) b.seats.push({ x: x + tx * o, z: z + tz * o, rot: facing });
    }
  }
  return instanced(bench, new THREE.MeshLambertMaterial({ vertexColors: true }), mats);
}

/** Ağaç, kaya ve çalıları serper: dış sınır halkası + açık alanlara iç ağaçlar. */
function nature(b: Builder): void {
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2 + b.rand() * 0.06;
    const r = WORLD_RADIUS + 2 + b.rand() * 12;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    const s = 0.9 + b.rand() * 0.9;
    b.prop(b.rand() > 0.3 ? "pine" : "oak", mat(x, heightAt(x, z) - 0.1, z, b.rand() * 6, s));
    if (r < WORLD_RADIUS + 4) b.shadow(x, z, 1.5 * s);
  }
  let placed = 0;
  for (let tries = 0; placed < 22 && tries < 800; tries++) {
    const a = b.rand() * Math.PI * 2;
    const r = 13 + b.rand() * (WORLD_RADIUS - 15);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!b.isClear(x, z) || Math.hypot(x, z - 8) < 6) continue;
    const s = 0.8 + b.rand() * 0.5;
    b.prop(b.rand() > 0.5 ? "pine" : "oak", mat(x, 0, z, b.rand() * 6, s));
    b.colliders.circle(x, z, 0.35 * s);
    b.shadow(x, z, 1.4 * s);
    b.clearCircle(x, z, 0.6);
    placed++;
  }
  for (let i = 0, n = 0; n < 28 && i < 400; i++) {
    const a = b.rand() * Math.PI * 2;
    const r = 12 + b.rand() * (WORLD_RADIUS - 10);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!b.isClear(x, z)) continue;
    const s = 0.5 + b.rand() * 1.1;
    b.prop("rock", mat(x, 0.15 * s, z, b.rand() * 6, s, s * 0.7, s));
    if (r < WORLD_RADIUS) b.colliders.circle(x, z, 0.5 * s);
    n++;
  }
  for (let i = 0, n = 0; n < 46 && i < 600; i++) {
    const a = b.rand() * Math.PI * 2;
    const r = 12 + b.rand() * (WORLD_RADIUS - 8);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!b.isClear(x, z)) continue;
    const s = 0.5 + b.rand() * 0.6;
    b.prop("bush", mat(x, 0.25 * s, z, b.rand() * 6, s, s * 0.75, s));
    if (r < WORLD_RADIUS) b.colliders.circle(x, z, 0.45 * s);
    b.shadow(x, z, 0.9 * s);
    n++;
  }
  // Amfinin iki yanında çalı sırası
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const s = 0.6 + b.rand() * 0.3;
      b.prop("bush", mat(sx * (17 + b.rand()), 0.25 * s, -12 - i * 2.6, b.rand() * 6, s, s * 0.75, s));
    }
  }
}

function grassAndFlowers(b: Builder, scene: THREE.Scene): void {
  // Çimen tutamı: 4 ince üçgen, dipte koyu uçta açık
  const blades: number[] = [];
  const cols: number[] = [];
  const base = new THREE.Color("#4d7a30"), tip = new THREE.Color("#9cc35a");
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI + 0.3;
    const h = 0.28 + (k % 2) * 0.1;
    const dx = Math.cos(a) * 0.05, dz = Math.sin(a) * 0.05;
    const lean = (k - 1.5) * 0.04;
    blades.push(-dx, 0, -dz, dx, 0, dz, lean * Math.sin(a), h, lean * Math.cos(a));
    base.toArray(cols, cols.length);
    base.toArray(cols, cols.length);
    tip.toArray(cols, cols.length);
  }
  const tuft = new THREE.BufferGeometry();
  tuft.setAttribute("position", new THREE.Float32BufferAttribute(blades, 3));
  tuft.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  tuft.computeVertexNormals();

  const grass: THREE.Matrix4[] = [];
  const flowers: THREE.Matrix4[] = [];
  const flowerColors: THREE.Color[] = [];
  const palette = ["#f4f1e6", "#f7d64a", "#e85a6f", "#b48ae8", "#f59a3c"].map((c) => new THREE.Color(c));
  for (let i = 0; i < 2600 && grass.length < 1400; i++) {
    const a = b.rand() * Math.PI * 2;
    const r = Math.sqrt(b.rand()) * (WORLD_RADIUS + 3);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!b.isClear(x, z)) continue;
    const s = 0.7 + b.rand() * 0.8;
    grass.push(mat(x, 0, z, b.rand() * 6, s));
  }
  // Çiçekler küme küme
  for (let c = 0; c < 40; c++) {
    const a = b.rand() * Math.PI * 2;
    const r = 11 + b.rand() * (WORLD_RADIUS - 10);
    const cx = Math.sin(a) * r, cz = Math.cos(a) * r;
    const color = palette[Math.floor(b.rand() * palette.length)];
    for (let k = 0; k < 12; k++) {
      const x = cx + (b.rand() - 0.5) * 2.4, z = cz + (b.rand() - 0.5) * 2.4;
      if (!b.isClear(x, z)) continue;
      flowers.push(mat(x, 0.2 + b.rand() * 0.08, z, b.rand() * 6, 0.8 + b.rand() * 0.5));
      flowerColors.push(color);
    }
  }
  scene.add(instanced(tuft, windMaterial(0.28, { side: THREE.DoubleSide }), grass));

  const head = part(new THREE.OctahedronGeometry(0.075, 0), "#ffffff", new THREE.Matrix4().makeScale(1, 0.6, 1));
  const fm = instanced(head, windMaterial(0.5), flowers);
  flowerColors.forEach((c, i) => fm.setColorAt(i, c));
  scene.add(fm);
}

function propMeshes(b: Builder, scene: THREE.Scene): void {
  const r = b.rand;
  const geos: Record<PropKind, THREE.BufferGeometry> = {
    pine: mergeGeometries([
      part(new THREE.CylinderGeometry(0.18, 0.25, 1.4, 6), "#6b4a2f", mat(0, 0.7, 0)),
      part(new THREE.ConeGeometry(1.3, 2.2, 7), "#3f7a3a", mat(0, 2.2, 0), 0.25, r),
      part(new THREE.ConeGeometry(0.95, 1.8, 7), "#4c8c42", mat(0, 3.2, 0), 0.25, r),
    ]),
    oak: mergeGeometries([
      part(new THREE.CylinderGeometry(0.16, 0.26, 1.8, 6), "#6e4b2e", mat(0, 0.9, 0)),
      part(new THREE.IcosahedronGeometry(1.25, 0), "#5c9a3f", mat(0, 2.6, 0, 0, 1, 0.9, 1), 0.3, r),
      part(new THREE.IcosahedronGeometry(0.85, 0), "#6aa847", mat(0.6, 3.2, 0.3), 0.3, r),
      part(new THREE.IcosahedronGeometry(0.7, 0), "#4f8a37", mat(-0.6, 2.9, -0.4), 0.3, r),
    ]),
    rock: part(new THREE.IcosahedronGeometry(0.6, 0), "#8b8f94", undefined, 0.2, r),
    bush: mergeGeometries([
      part(new THREE.IcosahedronGeometry(0.7, 0), "#4f8a3a", undefined, 0.3, r),
      part(new THREE.IcosahedronGeometry(0.45, 0), "#5f9c45", mat(0.45, 0.15, 0.2), 0.3, r),
    ]),
    stone: part(new THREE.CylinderGeometry(1, 1, 0.06, 7), "#b9b2a2", undefined, 0.1, r),
    post: part(new THREE.CylinderGeometry(0.07, 0.1, 2.6, 6), "#2f3440", mat(0, 1.3, 0)),
    bulb: new THREE.SphereGeometry(0.22, 8, 6),
    flame: new THREE.ConeGeometry(0.16, 0.42, 6).translate(0, 0.1, 0),
    log: part(new THREE.CylinderGeometry(0.22, 0.24, 1.55, 7), "#7b5233", new THREE.Matrix4().makeRotationZ(Math.PI / 2), 0.15, r),
  };
  const lambert = new THREE.MeshLambertMaterial({ vertexColors: true });
  const flat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const materials: Record<PropKind, THREE.Material> = {
    pine: windMaterial(0.012),
    oak: windMaterial(0.018),
    rock: flat,
    bush: windMaterial(0.04),
    stone: flat,
    post: lambert,
    bulb: new THREE.MeshBasicMaterial({ color: "#ffe9a8" }),
    flame: flickerMaterial("#ffa12e"),
    log: flat,
  };
  for (const kind of Object.keys(geos) as PropKind[]) {
    if (b.props[kind].length) scene.add(instanced(geos[kind], materials[kind], b.props[kind]));
  }
}

function shadowsMesh(b: Builder): THREE.InstancedMesh {
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < b.shadows.length; i += 3) {
    const s = b.shadows[i + 2] * 2;
    mats.push(flatMat(b.shadows[i], 0.036, b.shadows[i + 1], s, s));
  }
  const m = instanced(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: blobTexture(0.32), transparent: true, depthWrite: false }),
    mats,
  );
  m.renderOrder = 1;
  return m;
}

/** Ufuktaki dağlar: tek mesh, sisten etkilenmez, renkleri gökyüzüne karışır. */
function mountains(b: Builder): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const haze = new THREE.Color("#8fb0bf"), dark = new THREE.Color("#6f8f86"), snow = new THREE.Color("#f2f5f7");
  for (let i = 0; i < 44; i++) {
    const a = (i / 44) * Math.PI * 2 + b.rand() * 0.1;
    const dist = 105 + b.rand() * 25;
    const h = 14 + b.rand() * 26;
    const rad = 14 + b.rand() * 14;
    const g = new THREE.ConeGeometry(rad, h, 5, 2).toNonIndexed();
    g.deleteAttribute("uv");
    g.applyMatrix4(mat(Math.sin(a) * dist, h / 2 - 2, Math.cos(a) * dist, b.rand() * 6));
    const pos = g.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) {
      const t = (pos.getY(v) + 2) / h;
      tmp.copy(dark).lerp(haze, 0.4 + b.rand() * 0.1);
      if (h > 28 && t > 0.72) tmp.copy(snow);
      tmp.toArray(cols, v * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    parts.push(g);
  }
  const m = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: false }));
  m.matrixAutoUpdate = false;
  return m;
}

function clouds(b: Builder): THREE.InstancedMesh {
  const puff = mergeGeometries([
    part(new THREE.IcosahedronGeometry(3, 0), "#ffffff", mat(0, 0, 0, 0, 1.4, 0.7, 1)),
    part(new THREE.IcosahedronGeometry(2.4, 0), "#f4f7fb", mat(3.2, -0.4, 0.6, 0, 1.2, 0.65, 1)),
    part(new THREE.IcosahedronGeometry(2.2, 0), "#f4f7fb", mat(-3, -0.5, -0.4, 0, 1.2, 0.6, 1)),
  ]);
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < 16; i++) {
    const a = b.rand() * Math.PI * 2;
    const r = 35 + b.rand() * 60;
    mats.push(mat(Math.sin(a) * r, 38 + b.rand() * 18, Math.cos(a) * r, b.rand() * 6, 0.8 + b.rand() * 0.9));
  }
  const m = instanced(puff, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: false, emissive: "#9aa9bd" }), mats);
  m.matrixAutoUpdate = true;
  return m;
}

/** Mangal dumanı: birkaç billboard, tamamen vertex shader'da yükselip solar. */
function smoke(at: THREE.Vector3): THREE.InstancedMesh {
  const n = 10;
  const geo = new THREE.PlaneGeometry(1, 1);
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) seeds[i] = i / n;
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      varying vec2 vLocal;
      varying float vAlpha;
      void main() {
        float t = fract(uTime * 0.22 + aSeed);
        vec3 p = vec3(sin(aSeed * 40.0 + uTime * 0.7) * 0.35 * t, t * 3.4, cos(aSeed * 23.0) * 0.3 * t);
        vec4 center = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        float size = 0.35 + t * 1.1;
        vAlpha = smoothstep(0.0, 0.12, t) * (1.0 - t) * 0.42;
        vLocal = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * (center + vec4(position.xy * size, 0.0, 0.0));
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vLocal;
      varying float vAlpha;
      void main() {
        float d = dot(vLocal, vLocal);
        if (d > 1.0) discard;
        gl_FragColor = vec4(vec3(0.82, 0.82, 0.84), vAlpha * (1.0 - d));
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const mats = Array.from({ length: n }, () => new THREE.Matrix4().makeTranslation(at.x, at.y, at.z));
  const m = instanced(geo, material, mats);
  m.frustumCulled = false;
  m.renderOrder = 3;
  return m;
}

// ---------------------------------------------------------------------------

export function buildWorld(): World {
  const b = new Builder();
  const scene = new THREE.Scene();
  scene.background = SKY;
  scene.fog = new THREE.Fog(SKY, 45, 105);

  scene.add(new THREE.HemisphereLight("#dcefff", "#56683a", 1.6));
  const sun = new THREE.DirectionalLight("#fff1d6", 1.7);
  sun.position.set(20, 30, 12);
  scene.add(sun);

  // Gökyüzü kubbesi (tek draw call, sisten etkilenmez)
  const skyGeo = new THREE.SphereGeometry(150, 16, 8);
  const skyCols = new Float32Array(skyGeo.attributes.position.count * 3);
  for (let i = 0; i < skyGeo.attributes.position.count; i++) {
    const y = skyGeo.attributes.position.getY(i) / 150;
    tmp.copy(SKY).lerp(SKY_TOP, Math.max(0, y) ** 0.7).toArray(skyCols, i * 3);
  }
  skyGeo.setAttribute("color", new THREE.BufferAttribute(skyCols, 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -1;
  scene.add(sky);

  ground(b);
  plaza(b);
  scene.add(amphitheatre(b));
  const dz = dungeon(b);
  const gr = grove(b);
  signPost(b, GROVE_SIGN.x + 0.1, GROVE_SIGN.z, 2.1);
  pond(b);
  fameStatics(b);
  nature(b);

  const statics = new THREE.Mesh(mergeGeometries(b.statics), new THREE.MeshLambertMaterial({ vertexColors: true }));
  statics.matrixAutoUpdate = false;
  scene.add(statics);
  propMeshes(b, scene);
  grassAndFlowers(b, scene);
  scene.add(shadowsMesh(b));
  scene.add(mountains(b));
  const cloudMesh = clouds(b);
  scene.add(cloudMesh);
  scene.add(signsMesh(dz.signAt, gr.signAt));
  scene.add(gr.coals);
  const fame = new FameBoard();
  scene.add(fame.group);
  scene.add(smoke(gr.smokeAt));

  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), new THREE.MeshBasicMaterial({ map: screenTexture(), fog: false }));
  screen.position.set(0, 1.2 + SCREEN_H / 2, SCREEN_Z - 1.38);
  screen.updateMatrix();
  screen.matrixAutoUpdate = false;
  scene.add(screen);

  const coalColor = (gr.coals.material as THREE.MeshBasicMaterial).color;
  const coalA = new THREE.Color("#ff5a1a"), coalB = new THREE.Color("#ffb347");

  return {
    scene,
    colliders: b.colliders,
    seats: b.seats,
    fame,
    screen,
    spawn: { x: 0, z: 8, rot: Math.PI },
    update(time: number) {
      timeUniform.value = time;
      cloudMesh.rotation.y = time * 0.004;
      coalColor.copy(coalA).lerp(coalB, 0.5 + 0.5 * Math.sin(time * 7) * Math.sin(time * 3.3));
    },
  };
}
