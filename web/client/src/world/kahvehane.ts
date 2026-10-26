// Kahvehane: ahşap döşeme, çardak direkleri ve ampul zinciri, tavla/satranç/okey/bilek güreşi masaları, hasır tabureler,
// çay ocağı (semaver, ince belli bardaklar). Hepsi statik (Builder); tabureler masaya bağlı oturak.
import * as THREE from "three";
import { KAHVEHANE, TABLES, TEA_COUNTER } from "../../../shared/zones";
import type { Builder } from "./builder";
import { bulbChain, flatMat, mat, part } from "./geo";

const WOOD = "#8a5f35";
const WOOD_DARK = "#5b3f25";
const PLANK = ["#9b7451", "#a37b56", "#94704d"];

function box(b: Builder, w: number, h: number, d: number, color: string, x: number, y: number, z: number, ry = 0, jitter = 0.08): void {
  b.add(part(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry), jitter, b.rand));
}

function cyl(b: Builder, r0: number, r1: number, h: number, color: string, x: number, y: number, z: number, seg = 8): void {
  b.add(part(new THREE.CylinderGeometry(r0, r1, h, seg), color, mat(x, y, z)));
}

/** Masa: dört ayak ve üst tabla; `top` tabla rengi. */
function table(b: Builder, x: number, z: number, w: number, d: number, top: string): void {
  box(b, w, 0.07, d, top, x, 0.74, z);
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(b, 0.06, 0.72, 0.06, WOOD_DARK, x + lx * (w / 2 - 0.08), 0.36, z + lz * (d / 2 - 0.08));
  b.colliders.circle(x, z, Math.max(w, d) * 0.55);
}

function tavlaBoard(b: Builder, x: number, z: number): void {
  // Açık tavla kutusu: koyu çerçeve, iki yarı, üçgen haneler
  box(b, 0.86, 0.05, 0.6, "#6b3f1f", x, 0.8, z, 0, 0);
  box(b, 0.78, 0.02, 0.52, "#d9b98a", x, 0.825, z, 0, 0);
  box(b, 0.03, 0.03, 0.56, "#6b3f1f", x, 0.835, z, 0, 0);
  for (let i = 0; i < 12; i++) {
    const px = x - 0.36 + (i % 6) * 0.055 + (i < 6 ? 0 : 0.39);
    for (const pz of [-1, 1]) {
      const tri = new THREE.ConeGeometry(0.022, 0.2, 3).rotateX((pz * Math.PI) / 2).rotateY(Math.PI / 6);
      b.add(part(tri, i % 2 ? "#7a2e22" : "#2e3d52", mat(px, 0.84, z + pz * 0.15), 0));
    }
  }
  // Birkaç pul
  for (const [px, pz, c] of [[-0.3, -0.2, "#f2ecdc"], [-0.3, -0.16, "#f2ecdc"], [0.25, 0.2, "#2a2420"], [0.31, 0.2, "#2a2420"], [0.05, -0.2, "#f2ecdc"]] as const) {
    cyl(b, 0.022, 0.022, 0.012, c, x + px, 0.84, z + pz, 10);
  }
}

function chessBoard(b: Builder, x: number, z: number): void {
  box(b, 0.62, 0.04, 0.62, "#4a2f1c", x, 0.8, z, 0, 0);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      b.add(part(new THREE.BoxGeometry(0.07, 0.012, 0.07), (i + j) % 2 ? "#e8d9b8" : "#6f4a2e", mat(x - 0.245 + i * 0.07, 0.826, z - 0.245 + j * 0.07), 0));
    }
  }
  // Birkaç taş: piyonlar ve şahlar
  for (let i = 0; i < 8; i += 2) {
    cyl(b, 0.015, 0.022, 0.05, "#f4efe3", x - 0.245 + i * 0.07, 0.858, z - 0.175, 8);
    cyl(b, 0.015, 0.022, 0.05, "#2b2522", x - 0.175 + i * 0.07, 0.858, z + 0.175, 8);
  }
  cyl(b, 0.016, 0.026, 0.09, "#f4efe3", x + 0.035, 0.877, z - 0.245, 8);
  cyl(b, 0.016, 0.026, 0.09, "#2b2522", x + 0.035, 0.877, z + 0.245, 8);
}

function okeyTable(b: Builder, x: number, z: number): void {
  // Yeşil çuha ve dört istaka
  box(b, 1.1, 0.012, 1.1, "#2f7a4a", x, 0.784, z, 0, 0.04);
  for (const [dx, dz, ry] of [[0, -0.42, 0], [0.42, 0, Math.PI / 2], [0, 0.42, 0], [-0.42, 0, Math.PI / 2]] as const) {
    box(b, 0.7, 0.08, 0.06, "#a0703f", x + dx, 0.83, z + dz, ry, 0);
    for (let i = 0; i < 7; i++) {
      const o = -0.27 + i * 0.09;
      box(b, 0.07, 0.09, 0.015, "#f3eee0", x + dx + (ry ? 0 : o), 0.88, z + dz + (ry ? o : 0) + (ry ? 0 : -Math.sign(dz) * 0.02), ry, 0);
    }
  }
  // Ortada taş yığını
  for (let i = 0; i < 4; i++) box(b, 0.07, 0.03 + i * 0.012, 0.1, "#f3eee0", x - 0.12 + i * 0.08, 0.8, z, 0.2 * i, 0);
}

/** Bilek güreşi masası: ortada iki dirsek minderi (kırmızı batıda, mavi doğuda) ve yanlarda tutamak. */
function bilekTable(b: Builder, x: number, z: number): void {
  box(b, 0.66, 0.012, 0.5, "#3b4250", x, 0.784, z, 0, 0.04);
  for (const [dx, c] of [[-1, "#c0392b"], [1, "#2e6fd0"]] as const) {
    cyl(b, 0.075, 0.075, 0.025, c, x + dx * 0.15, 0.795, z, 12);
    // Boştaki elin tuttuğu kazık
    cyl(b, 0.018, 0.018, 0.14, "#c7ccd1", x + dx * 0.24, 0.86, z + dx * 0.17, 8);
  }
}

/** Hasır tabure: masaya bağlı oturak. */
function stool(b: Builder, x: number, z: number): void {
  cyl(b, 0.22, 0.2, 0.06, "#c9a35a", x, 0.44, z, 8);
  for (const [lx, lz] of [[-0.14, -0.14], [0.14, -0.14], [-0.14, 0.14], [0.14, 0.14]]) box(b, 0.04, 0.42, 0.04, WOOD_DARK, x + lx, 0.21, z + lz, 0, 0);
}

export function kahvehane(b: Builder): { signAt: THREE.Matrix4[] } {
  const { x: cx, z: cz, hw, hd } = KAHVEHANE;
  b.clearBox(cx - hw - 1, cx + hw + 1, cz - hd - 1, cz + hd + 1);

  // Döşeme: tahta sıraları
  const rows = 12;
  for (let i = 0; i < rows; i++) {
    const z = cz - hd + (i + 0.5) * ((hd * 2) / rows);
    box(b, hw * 2, 0.1, (hd * 2) / rows - 0.03, PLANK[i % 3], cx, 0.05, z, 0, 0.05);
  }
  b.add(part(new THREE.PlaneGeometry(hw * 2 + 1.2, hd * 2 + 1.2), "#7d6a4e", flatMat(cx, 0.015, cz), 0.06, b.rand));

  // Çardak: kenarlarda direkler, üstte kirişler (çatı yok: kamera masaları görsün)
  const posts: [number, number][] = [];
  for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) posts.push([cx + sx * hw, cz + sz * hd]);
  for (const [px, pz] of posts) {
    box(b, 0.18, 3.1, 0.18, WOOD_DARK, px, 1.55, pz, 0, 0.05);
    b.colliders.circle(px, pz, 0.15);
  }
  for (const sz of [-1, 1]) box(b, hw * 2 + 0.3, 0.16, 0.16, WOOD, cx, 3.1, cz + sz * hd, 0, 0.05);
  for (const sx of [-1, 0, 1]) box(b, 0.14, 0.14, hd * 2 + 0.3, WOOD, cx + sx * hw, 3.05, cz, 0, 0.05);
  // Ampul zinciri: direkler arasında sarkan
  const chain = (ax: number, az: number, bx: number, bz: number, n: number) => bulbChain(b, ax, az, bx, bz, 2.95, 0.45, n);
  chain(cx - hw, cz - hd, cx, cz - hd, 10);
  chain(cx, cz - hd, cx + hw, cz - hd, 10);
  chain(cx - hw, cz + hd, cx, cz + hd, 10);
  chain(cx, cz + hd, cx + hw, cz + hd, 10);
  chain(cx - hw, cz - hd, cx + hw, cz + hd, 18);
  chain(cx + hw, cz - hd, cx - hw, cz + hd, 18);

  // Masalar
  for (const t of TABLES) {
    if (t.kind === "okey") {
      table(b, t.x, t.z, 1.2, 1.2, "#8f6640");
      okeyTable(b, t.x, t.z);
    } else if (t.kind === "bilek") {
      table(b, t.x, t.z, 0.72, 0.56, "#6b4a2c");
      bilekTable(b, t.x, t.z);
    } else {
      table(b, t.x, t.z, 0.95, 0.75, "#8f6640");
      if (t.kind === "tavla") tavlaBoard(b, t.x, t.z);
      else chessBoard(b, t.x, t.z);
    }
    t.seats.forEach((s, i) => {
      stool(b, s.x, s.z);
      b.seats.push({ x: s.x, z: s.z, rot: s.rot, table: { id: t.id, seat: i } });
    });
  }

  // Çay ocağı: tezgâh, semaver, tepside bardaklar; üstünde kısa çizgili tente
  const tx = TEA_COUNTER.x, tz = TEA_COUNTER.z + 1.2;
  box(b, 2.4, 1.0, 0.7, "#7a5233", tx, 0.5, tz, 0, 0.06);
  box(b, 2.5, 0.06, 0.8, "#c9b28a", tx, 1.03, tz, 0, 0.03);
  cyl(b, 0.2, 0.24, 0.5, "#c7ccd1", tx - 0.6, 1.31, tz, 12);
  cyl(b, 0.12, 0.18, 0.12, "#aab0b6", tx - 0.6, 1.62, tz, 12);
  cyl(b, 0.09, 0.07, 0.18, "#b5722f", tx - 0.6, 1.77, tz, 10);
  box(b, 0.5, 0.02, 0.32, "#c0c4c8", tx + 0.35, 1.07, tz, 0, 0);
  for (let i = 0; i < 6; i++) cyl(b, 0.035, 0.028, 0.1, "#b4471c", tx + 0.18 + (i % 3) * 0.12, 1.13, tz - 0.08 + Math.floor(i / 3) * 0.16, 8);
  b.colliders.segment(tx - 1.2, tz, tx + 1.2, tz, 0.4);
  for (let i = 0; i < 8; i++) {
    box(b, 0.32, 0.04, 1.2, i % 2 ? "#f2efe6" : "#c9302c", tx - 1.12 + i * 0.32, 2.45, tz + 0.15, 0, 0);
  }
  for (const sx of [-1, 1]) box(b, 0.08, 2.4, 0.08, WOOD_DARK, tx + sx * 1.2, 1.2, tz + 0.7, 0, 0);

  // Ön girişte yer saksıları
  for (const sx of [-1, 1]) {
    cyl(b, 0.35, 0.28, 0.5, "#b5643c", cx + sx * 2.2, 0.35, cz - hd - 0.7, 8);
    b.prop("bush", mat(cx + sx * 2.2, 0.78, cz - hd - 0.7, sx, 0.45, 0.4, 0.45));
    b.colliders.circle(cx + sx * 2.2, cz - hd - 0.7, 0.4);
  }

  // Tabelalar: kuzeydeki girişin üstünde göle, güney kirişinde meydana bakar
  return { signAt: [mat(cx, 3.55, cz - hd - 0.05, Math.PI), mat(cx, 3.55, cz + hd + 0.05, 0)] };
}
