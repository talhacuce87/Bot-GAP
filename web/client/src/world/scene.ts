// "GAP Meydanı": tamamen prosedürel, low-poly, vertex renkli sahne.
// Statik geometri tek mesh'te birleştirilir; tekrar eden objeler InstancedMesh ile çizilir.
// Toplam ~10 draw call, gerçek zamanlı gölge yok.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { WORLD_RADIUS } from "../../../shared/constants";
import { Colliders } from "./colliders";

export interface Seat {
  x: number;
  z: number;
  rot: number;
}

export interface World {
  scene: THREE.Scene;
  colliders: Colliders;
  seats: Seat[];
  /** Watch party perdesinin dünya konumu (Faz 3). */
  screen: THREE.Mesh;
  spawn: { x: number; z: number; rot: number };
}

const SCREEN_Z = -22;
const SCREEN_W = 12;
const SCREEN_H = SCREEN_W * (9 / 16);
const AMPHI_CENTER_Z = -22;

function rng(seed: number): () => number {
  // mulberry32: herkes aynı dünyayı görsün diye sabit tohumlu.
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tmpColor = new THREE.Color();

/** Geometriyi index'siz, uv'siz hale getirip dönüştürür ve tek renge boyar. */
function part(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, m?: THREE.Matrix4, jitter = 0, rand?: () => number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  if (m) g.applyMatrix4(m);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  tmpColor.set(color);
  for (let i = 0; i < n; i += 3) {
    // Üçgen başına küçük ton farkı: doku olmadan "el yapımı" görünüm.
    const k = jitter && rand ? 1 + (rand() - 0.5) * jitter : 1;
    for (let v = 0; v < 3; v++) {
      colors[(i + v) * 3] = tmpColor.r * k;
      colors[(i + v) * 3 + 1] = tmpColor.g * k;
      colors[(i + v) * 3 + 2] = tmpColor.b * k;
    }
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

function mat(x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry),
    new THREE.Vector3(sx, sy, sz),
  );
}

function instanced(geo: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, material, matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function screenTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 288;
  const g = c.getContext("2d")!;
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
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

export function buildWorld(): World {
  const rand = rng(0x6a7);
  const scene = new THREE.Scene();
  const colliders = new Colliders();
  const seats: Seat[] = [];

  const skyColor = new THREE.Color("#9fc7e8");
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 35, 85);

  scene.add(new THREE.HemisphereLight("#dcefff", "#56683a", 1.6));
  const sun = new THREE.DirectionalLight("#fff1d6", 1.6);
  sun.position.set(20, 30, 12);
  scene.add(sun);

  const lambert = new THREE.MeshLambertMaterial({ vertexColors: true });
  const lambertFlat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

  // ---- Gökyüzü kubbesi (tek draw call, sisten etkilenmez) ----
  const skyGeo = new THREE.SphereGeometry(95, 16, 8);
  const skyCols = new Float32Array(skyGeo.attributes.position.count * 3);
  const top = new THREE.Color("#5d8fd0");
  for (let i = 0; i < skyGeo.attributes.position.count; i++) {
    const y = skyGeo.attributes.position.getY(i) / 95;
    tmpColor.copy(skyColor).lerp(top, Math.max(0, y));
    tmpColor.toArray(skyCols, i * 3);
  }
  skyGeo.setAttribute("color", new THREE.BufferAttribute(skyCols, 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -1;
  scene.add(sky);

  // ---- Statik zemin + sahne: tek birleşik mesh ----
  const statics: THREE.BufferGeometry[] = [];
  const flat = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

  const ground = new THREE.RingGeometry(0.01, 60, 40, 10);
  statics.push(part(ground, "#6f9a4a", flat, 0.12, rand));

  const plaza = new THREE.CircleGeometry(10, 32);
  statics.push(part(plaza, "#c9b99a", flat.clone().premultiply(new THREE.Matrix4().makeTranslation(0, 0.02, 0)), 0.06, rand));
  const plazaRing = new THREE.RingGeometry(10, 10.6, 32, 1);
  statics.push(part(plazaRing, "#a8977a", flat.clone().premultiply(new THREE.Matrix4().makeTranslation(0, 0.03, 0))));

  // Meydandan amfiye giden yol
  const path = new THREE.PlaneGeometry(3, 11);
  statics.push(part(path, "#c9b99a", flat.clone().premultiply(new THREE.Matrix4().makeTranslation(0, 0.02, -14.5)), 0.06, rand));

  // Sahne platformu ve perde çerçevesi
  statics.push(part(new THREE.BoxGeometry(18, 0.6, 4), "#8a6f55", mat(0, 0.3, SCREEN_Z - 0.5)));
  statics.push(part(new THREE.BoxGeometry(SCREEN_W + 0.8, SCREEN_H + 0.8, 0.4), "#2a2f3a", mat(0, 1.2 + SCREEN_H / 2, SCREEN_Z - 1.6)));
  for (const sx of [-1, 1]) {
    statics.push(part(new THREE.BoxGeometry(0.6, SCREEN_H + 2, 0.6), "#3a3f4c", mat(sx * (SCREEN_W / 2 + 0.7), (SCREEN_H + 2) / 2, SCREEN_Z - 1.6)));
  }
  colliders.segment(-9, SCREEN_Z - 0.5, 9, SCREEN_Z - 0.5, 2);

  // Meydan ortasında çeşme
  statics.push(part(new THREE.CylinderGeometry(2.2, 2.4, 0.6, 14), "#9aa3ad", mat(0, 0.3, 0)));
  statics.push(part(new THREE.CylinderGeometry(1.9, 1.9, 0.05, 14), "#4f8fc9", mat(0, 0.58, 0)));
  statics.push(part(new THREE.CylinderGeometry(0.35, 0.5, 1.6, 8), "#9aa3ad", mat(0, 0.8, 0)));
  colliders.circle(0, 0, 2.4);

  const staticMesh = new THREE.Mesh(mergeGeometries(statics), lambert);
  staticMesh.matrixAutoUpdate = false;
  scene.add(staticMesh);

  // ---- Perde (Faz 3'te video buraya gelecek) ----
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), new THREE.MeshBasicMaterial({ map: screenTexture(), fog: false }));
  screen.position.set(0, 1.2 + SCREEN_H / 2, SCREEN_Z - 1.38);
  screen.updateMatrix();
  screen.matrixAutoUpdate = false;
  scene.add(screen);

  // ---- Amfi oturakları: perdeye bakan yay şeklinde sıralar ----
  const bench = mergeGeometries([
    part(new THREE.BoxGeometry(2.2, 0.12, 0.5), "#a0703f", mat(0, 0.45, 0)),
    part(new THREE.BoxGeometry(2.2, 0.5, 0.08), "#8a5f35", mat(0, 0.75, -0.24)),
    part(new THREE.BoxGeometry(0.1, 0.45, 0.45), "#5b3f25", mat(-0.95, 0.22, 0)),
    part(new THREE.BoxGeometry(0.1, 0.45, 0.45), "#5b3f25", mat(0.95, 0.22, 0)),
  ]);
  const benchMats: THREE.Matrix4[] = [];
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
      benchMats.push(mat(x, 0, z, facing));
      const tx = Math.cos(theta), tz = -Math.sin(theta); // yay teğeti
      colliders.segment(x - tx * 1.05, z - tz * 1.05, x + tx * 1.05, z + tz * 1.05, 0.3);
      for (const o of [-0.7, 0, 0.7]) {
        // Oturma noktası bankın önünde, kişi oturunca banka kayar.
        seats.push({ x: x + tx * o, z: z + tz * o, rot: facing });
      }
    }
  }
  scene.add(instanced(bench, lambert, benchMats));

  // ---- Ağaçlar: dış halka (sınır) + birkaç iç ağaç ----
  const tree = mergeGeometries([
    part(new THREE.CylinderGeometry(0.18, 0.25, 1.4, 6), "#6b4a2f", mat(0, 0.7, 0)),
    part(new THREE.ConeGeometry(1.3, 2.2, 7), "#3f7a3a", mat(0, 2.2, 0), 0.25, rand),
    part(new THREE.ConeGeometry(0.95, 1.8, 7), "#4c8c42", mat(0, 3.2, 0), 0.25, rand),
  ]);
  const treeMats: THREE.Matrix4[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2 + rand() * 0.08;
    const r = WORLD_RADIUS + 2 + rand() * 9;
    const s = 0.9 + rand() * 0.8;
    treeMats.push(mat(Math.sin(a) * r, 0, Math.cos(a) * r, rand() * 6, s, s, s));
  }
  let inner = 0;
  for (let tries = 0; inner < 14 && tries < 400; tries++) {
    const a = rand() * Math.PI * 2;
    const r = 12 + rand() * (WORLD_RADIUS - 14);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (z < -4 && Math.abs(x) < 20) continue; // amfi alanı boş kalsın
    if (Math.hypot(x, z - 8) < 6) continue; // doğma noktası
    const s = 0.8 + rand() * 0.5;
    treeMats.push(mat(x, 0, z, rand() * 6, s, s, s));
    colliders.circle(x, z, 0.35 * s);
    inner++;
  }
  scene.add(instanced(tree, lambertFlat, treeMats));

  // ---- Kayalar ----
  const rock = part(new THREE.IcosahedronGeometry(0.6, 0), "#8b8f94", undefined, 0.2, rand);
  const rockMats: THREE.Matrix4[] = [];
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2;
    const r = 11 + rand() * (WORLD_RADIUS - 10);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (z < -4 && Math.abs(x) < 20 && r < WORLD_RADIUS) continue;
    const s = 0.5 + rand() * 1.1;
    rockMats.push(mat(x, 0.15 * s, z, rand() * 6, s, s * 0.7, s));
    if (r < WORLD_RADIUS) colliders.circle(x, z, 0.5 * s);
  }
  scene.add(instanced(rock, lambertFlat, rockMats));

  // ---- Meydan lambaları: direk (lambert) + ampul (basic, "parlıyor" görünümü) ----
  const post = part(new THREE.CylinderGeometry(0.07, 0.1, 2.6, 6), "#2f3440", mat(0, 1.3, 0));
  const bulbGeo = new THREE.SphereGeometry(0.22, 8, 6);
  const postMats: THREE.Matrix4[] = [];
  const bulbMats: THREE.Matrix4[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.sin(a) * 11, z = Math.cos(a) * 11;
    if (z < -9) continue; // yolu kapatma
    postMats.push(mat(x, 0, z));
    bulbMats.push(mat(x, 2.7, z));
    colliders.circle(x, z, 0.15);
  }
  scene.add(instanced(post, lambert, postMats));
  scene.add(instanced(bulbGeo, new THREE.MeshBasicMaterial({ color: "#ffe9a8" }), bulbMats));

  return { scene, colliders, seats, screen, spawn: { x: 0, z: 8, rot: Math.PI } };
}
