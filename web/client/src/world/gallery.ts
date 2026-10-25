// GAP Galeri: şehrin doğu ucunda, z=10 caddesinin bittiği yerde lüks showroom. Batıya (caddeye) bakan boydan cam
// cephe ve altın çerçeveli kapı, önünde bayraklı avlu. İçeride beyaz mermer zemin (altın derzler), yüksek tavanda
// spotlar ve her platforma inen ışık hüzmesi; 3×3 döner platformda arabalar (boşlarda "YAKINDA"), girişte
// resepsiyon ve galerici, köşede deri koltuklu bekleme alanı. Platformdaki arabaya ya da galericiye F: galeri.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CAR_MODELS, type CarSpec, DEFAULT_CAR } from "../../../shared/car";
import { GALLERY_AREA } from "../../../shared/zones";
import type { Builder } from "./builder";
import type { CityNpc } from "./city";
import { mat, part } from "./geo";
import { buildTofas } from "./tofas";

/** Bina: içi x 408–448 (40 m), z −4–24 (28 m), tavan 8 m; giriş batı duvarının ortasında. */
const X0 = GALLERY_AREA.minX + 10, X1 = GALLERY_AREA.maxX - 4, Z0 = GALLERY_AREA.minZ + 5, Z1 = GALLERY_AREA.maxZ - 5, H = 8;
const ZC = (Z0 + Z1) / 2, DOOR = 4.2;
const MARBLE = "#f3f1ec", MARBLE2 = "#e9e6df", GOLD = "#d4af37", DARK = "#1c1f26", LEATHER = "#5a3a26";

/** Sergi yerleri (3×3): arabası olan platformlar ve "yakında" boşlukları. Yeni araba gelince listeye eklenir. */
const SHOWN: (CarSpec["model"] | null)[] = [null, "passat", null, "e30", null, "linea", null, "doblo", null];
export const GALLERY_SLOTS: { x: number; z: number; model: CarSpec["model"] | null }[] = SHOWN.map((model, i) => ({
  x: X0 + 13 + (i % 3) * 11,
  z: Z0 + 5 + Math.floor(i / 3) * 9,
  model,
}));
/** Galerici: girişin sağında resepsiyon; yaklaşma noktası kapıdan girer girmez önünde. */
export const GALLERY_DESK = { x: X0 + 3.2, z: ZC + 5 };

function label(text: string, w: number, h: number, bg: string, fg: string, font: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = font;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function gallery(b: Builder): { group: THREE.Group; npcs: CityNpc[] } {
  const group = new THREE.Group();
  const box = (sx: number, sy: number, sz: number, color: string, px: number, py: number, pz: number, jitter = 0) =>
    b.add(part(new THREE.BoxGeometry(sx, sy, sz), color, mat(px, py, pz), jitter, b.rand));
  const cyl = (r0: number, r1: number, hh: number, color: string, px: number, py: number, pz: number, seg = 32) =>
    b.add(part(new THREE.CylinderGeometry(r0, r1, hh, seg), color, mat(px, py, pz)));
  const glows: THREE.BufferGeometry[] = [];
  const glow = (g: THREE.BufferGeometry, color: string, m: THREE.Matrix4) => glows.push(part(g, color, m));
  const xm = (X0 + X1) / 2;

  // ---- Avlu: z=10 caddesi aynı asfalt, çizgi, kaldırım ve bordürle devam eder, kapı önünde taş meydanda biter ----
  const ax = GALLERY_AREA.minX, PZ = X0 - 5; // cadde burada biter, meydan başlar
  const SW = 3, RH = 5, WALK = "#cfcbc2", CURB = "#9d9a93", LINE = "#f1f1ec";
  box(GALLERY_AREA.maxX - ax, 0.04, GALLERY_AREA.maxZ - GALLERY_AREA.minZ, "#bdb9b0", (ax + GALLERY_AREA.maxX) / 2, 0.01, (GALLERY_AREA.minZ + GALLERY_AREA.maxZ) / 2, 0.03);
  box(PZ - ax, 0.03, RH * 2, "#3c3f45", (ax + PZ) / 2, 0.025, ZC, 0.04);
  for (const s of [-1, 1]) {
    box(PZ - ax, 0.06, SW, WALK, (ax + PZ) / 2, 0.05, ZC + s * (RH + SW / 2));
    box(PZ - ax, 0.1, 0.24, CURB, (ax + PZ) / 2, 0.05, ZC + s * (RH + 0.12), 0.01);
    box(PZ - ax, 0.01, 0.15, LINE, (ax + PZ) / 2, 0.043, ZC + s * (RH - 0.3));
  }
  for (let x = ax + 1; x < PZ - 2; x += 6) box(Math.min(3, PZ - 1 - x), 0.01, 0.14, LINE, x + 1.5, 0.044, ZC);
  // Meydan: kaldırım hizasında açık taş, kenarı altın şerit; araba da yaya da düz yürür/geçer
  box(X0 - PZ, 0.06, (RH + SW) * 2 + 6, "#e4e0d8", (PZ + X0) / 2, 0.05, ZC, 0.02);
  box(0.12, 0.012, (RH + SW) * 2 + 6, GOLD, PZ + 0.06, 0.083, ZC);
  for (const s of [-1, 1]) {
    const fz = ZC + s * 9;
    cyl(0.07, 0.09, 9, "#cfd3d8", X0 - 4, 4.5, fz, 10);
    b.colliders.circle(X0 - 4, fz, 0.15);
    glow(new THREE.BoxGeometry(0.04, 1.4, 2.2), s > 0 ? "#1d9e75" : GOLD, mat(X0 - 4, 7.8, fz + 1.15));
    cyl(0.75, 0.6, 0.8, "#e9e6df", X0 - 1.5, 0.4, ZC + s * 4.2, 18);
    b.colliders.circle(X0 - 1.5, ZC + s * 4.2, 0.8);
    b.add(part(new THREE.SphereGeometry(0.75, 10, 8), "#3f7a3a", mat(X0 - 1.5, 1.15, ZC + s * 4.2)));
  }

  // ---- Zemin: mermer karolar ve altın derzler ----
  for (let x = X0; x < X1 - 0.01; x += 2) for (let z = Z0; z < Z1 - 0.01; z += 2) box(1.96, 0.06, 1.96, ((x + z) / 2) % 2 ? MARBLE : MARBLE2, x + 1, 0.05, z + 1);
  for (let x = X0; x <= X1; x += 4) box(0.04, 0.065, Z1 - Z0, GOLD, x, 0.05, ZC);
  for (let z = Z0; z <= Z1; z += 4) box(X1 - X0, 0.065, 0.04, GOLD, xm, 0.05, z);

  // ---- Duvarlar (krem), altın süpürgelik, tavan, cephe çerçevesi ----
  box(X1 - X0, H, 0.4, "#ece8df", xm, H / 2, Z0);
  box(X1 - X0, H, 0.4, "#ece8df", xm, H / 2, Z1);
  box(0.4, H, Z1 - Z0, "#ece8df", X1, H / 2, ZC);
  for (const z of [Z0 + 0.22, Z1 - 0.22]) box(X1 - X0, 0.25, 0.05, GOLD, xm, 0.2, z);
  box(0.05, 0.25, Z1 - Z0, GOLD, X1 - 0.22, 0.2, ZC);
  box(X1 - X0 + 1, 0.5, Z1 - Z0 + 1, "#f6f4ef", xm, H + 0.25, ZC);
  box(X1 - X0 + 1.2, 0.18, Z1 - Z0 + 1.2, GOLD, xm, H + 0.55, ZC);
  // Cephe: altın direkler, üstte koyu tabela kuşağı
  for (const z of [Z0, ZC - DOOR / 2, ZC + DOOR / 2, Z1]) box(0.35, H, 0.35, GOLD, X0, H / 2, z);
  box(0.5, 1.4, Z1 - Z0 + 0.4, DARK, X0 - 0.05, H - 0.7, ZC);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.2), new THREE.MeshBasicMaterial({ map: label("GAP GALERİ", 1400, 120, DARK, GOLD, "800 96px Georgia, serif") }));
  sign.position.set(X0 - 0.32, H - 0.7, ZC);
  sign.rotation.y = -Math.PI / 2;
  group.add(sign);
  // Cam cephe (kapı aralığı açık)
  const glass = new THREE.MeshPhongMaterial({ color: "#a9cfe0", transparent: true, opacity: 0.22, shininess: 120, specular: "#ffffff", depthWrite: false });
  for (const [a, c] of [[Z0, ZC - DOOR / 2], [ZC + DOOR / 2, Z1]]) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(c - a, H - 1.4), glass);
    pane.position.set(X0, (H - 1.4) / 2, (a + c) / 2);
    pane.rotation.y = -Math.PI / 2;
    pane.renderOrder = 3;
    group.add(pane);
  }
  // Çarpışma: duvarlar, cam (kapı hariç); arabayla girilmez
  b.colliders.segment(X0, Z0, X1, Z0, 0.25);
  b.colliders.segment(X0, Z1, X1, Z1, 0.25);
  b.colliders.segment(X1, Z0, X1, Z1, 0.25);
  b.colliders.segment(X0, Z0, X0, ZC - DOOR / 2, 0.2);
  b.colliders.segment(X0, ZC + DOOR / 2, X0, Z1, 0.2);
  b.carColliders.segment(X0, ZC - DOOR / 2, X0, ZC + DOOR / 2, 0.2);

  // ---- Platformlar: altın kenarlı, ışıklı halkalı döner tabla; tavandan inen spot hüzmesi ----
  const beamMat = new THREE.MeshBasicMaterial({ color: "#fff3cf", transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const pivots: THREE.Group[] = [];
  GALLERY_SLOTS.forEach((s, i) => {
    cyl(2.75, 2.85, 0.28, "#f7f5f0", s.x, 0.14, s.z, 40);
    cyl(2.9, 2.9, 0.06, GOLD, s.x, 0.29, s.z, 40);
    glow(new THREE.TorusGeometry(2.62, 0.035, 6, 48).rotateX(Math.PI / 2), "#ffe9a8", mat(s.x, 0.31, s.z));
    b.colliders.circle(s.x, s.z, 2.9);
    // Tavan spotu ve hüzme
    glow(new THREE.CylinderGeometry(0.45, 0.45, 0.08, 16), "#fffbe8", mat(s.x, H - 0.02, s.z));
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 2.6, H - 0.4, 24, 1, true), beamMat);
    beam.position.set(s.x, H / 2, s.z);
    group.add(beam);
    const pivot = new THREE.Group();
    pivot.position.set(s.x, 0.32, s.z);
    group.add(pivot);
    pivots.push(pivot);
    if (!s.model) {
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.6), new THREE.MeshBasicMaterial({ map: label("YAKINDA", 520, 120, DARK, GOLD, "800 64px Georgia, serif"), side: THREE.DoubleSide }));
      tag.position.set(0, 1.2, 0);
      pivot.add(tag);
      return;
    }
    try {
      const colors = ["siyah", "beyaz", "gri", "kirmizi", "lacivert", "bej", "yesil"] as const;
      const car = buildTofas({ ...DEFAULT_CAR, model: s.model, color: colors[i % colors.length], rim: i % 2 ? "spor" : "altin", plate: "GAP 0 KM" });
      car.setNight(0.3);
      car.setHeadlights(0, { decal: false });
      pivot.add(car.group);
    } catch {
      // WebGL'siz ortam (test)
    }
    // Model adı: platformun önünde yerde
    const name = CAR_MODELS.find((m) => m.id === s.model)?.name ?? s.model;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(3, 0.42), new THREE.MeshBasicMaterial({ map: label(name.toUpperCase(), 600, 84, DARK, GOLD, "700 46px Georgia, serif") }));
    plate.position.set(s.x - 3.1, 0.33, s.z);
    plate.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    group.add(plate);
  });
  // Platformlar yavaşça döner: görünmez (renk yazmayan) bir parçanın çizimi her karede çevirir
  const ticker = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  ticker.position.set(xm, 1, ZC);
  ticker.frustumCulled = false;
  ticker.onBeforeRender = () => {
    const t = performance.now() / 1000;
    pivots.forEach((p, i) => (p.rotation.y = i * 0.9 + t * 0.3));
  };
  group.add(ticker);

  // ---- Resepsiyon (girişin sağında) ve bekleme salonu (sol köşe) ----
  const D = GALLERY_DESK;
  box(1, 1.1, 4, DARK, D.x + 1.3, 0.55, D.z);
  box(1.1, 0.08, 4.1, GOLD, D.x + 1.3, 1.14, D.z);
  b.colliders.segment(D.x + 1.3, D.z - 2, D.x + 1.3, D.z + 2, 0.55);
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.5), new THREE.MeshBasicMaterial({ map: label("GAP GALERİ", 480, 100, DARK, GOLD, "700 52px Georgia, serif") }));
  logo.position.set(D.x + 0.78, 0.65, D.z);
  logo.rotation.y = -Math.PI / 2;
  group.add(logo);
  for (const [sx, sz, ry] of [[X0 + 2.2, Z0 + 2.4, 0], [X0 + 5.2, Z0 + 1.2, Math.PI / 2]] as const) {
    const L = 3;
    const along = ry ? [0.9, L] : [L, 0.9];
    box(along[0], 0.45, along[1], LEATHER, sx, 0.3, sz);
    box(ry ? 0.25 : L, 0.55, ry ? L : 0.25, LEATHER, sx + (ry ? 0.35 : 0), 0.75, sz - (ry ? 0 : 0.35));
    b.colliders.segment(sx - (ry ? 0 : L / 2), sz - (ry ? L / 2 : 0), sx + (ry ? 0 : L / 2), sz + (ry ? L / 2 : 0), 0.5, 0.5);
    for (let k = -1; k <= 1; k++) b.seats.push({ x: sx + (ry ? 0 : k), z: sz + (ry ? k : 0), rot: ry ? -Math.PI / 2 : 0 });
  }
  cyl(0.6, 0.6, 0.45, "#2b2f38", X0 + 4.2, 0.25, Z0 + 3.4, 20);
  cyl(0.62, 0.62, 0.04, GOLD, X0 + 4.2, 0.49, Z0 + 3.4, 20);
  b.colliders.circle(X0 + 4.2, Z0 + 3.4, 0.6, 0.5);

  // Işıklar (spotlar, halkalar, bayraklar): tek parlak mesh
  if (glows.length) group.add(new THREE.Mesh(mergeGeometries(glows), new THREE.MeshBasicMaterial({ vertexColors: true })));
  b.clearBox(GALLERY_AREA.minX, GALLERY_AREA.maxX, GALLERY_AREA.minZ, GALLERY_AREA.maxZ);
  const npcs: CityNpc[] = [
    {
      name: "Galerici Serkan",
      x: D.x + 2.2,
      z: D.z,
      rot: -Math.PI / 2,
      outfit: { hair: "hair_joleli", tops: "top_takim", bottoms: "bottom_kumas", shoes: "shoes_klasik", hats: null, glasses: "glasses_pilot", facial: null, colors: { hair: "#1f1a17", skin: "#d9a77c" } },
      act: { x: D.x, z: D.z, r: 2.6, label: "Galerici Serkan · Galeriye bak 🚗", line: "Hoş geldiniz! Hepsi sıfır kilometre, beğendiğinize yakından bakın.", fx: "sparkle", gallery: true },
    },
  ];
  return { group, npcs };
}
