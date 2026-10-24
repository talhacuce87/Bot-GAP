// GAP Paintball sahası: köyde, kahvehaneyle nehir arasında. Suni çim (şeritli) ve çizgiler, dört yanı ağ,
// rengârenk şişme engeller (silindir, kule, dorito, pasta, yılan, tuğla), batıda bilet kulübesi (silah rafı,
// tabela) ve tribün, köşelerde ışık kuleleri (gece yanar, çim ve engeller projektörle aydınlanır), kuzey uçta
// canlı skor tabelası.
// Kurallar ve ölçüler shared/paintball.ts'te; engeller çarpışmaya da girer (üstüne çıkılabilir).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BUNKERS, type Bunker, GUN_SKINS, NET_H, PB_BOOTH, PB_FIELD, PB_STANDS } from "../../../shared/paintball";
import type { Builder } from "./builder";
import { floodMaterial } from "./casino";
import { flatMat, mat, part } from "./geo";
import { markerMesh } from "./marker";

const { x: CX, z: CZ, hx: HX, hz: HZ } = PB_FIELD;
const TURF = ["#3d8f3f", "#36823a"];
const LINE = "#f2f2ea";
/** Şişme engellerin renkleri (gerçek speedball sahaları gibi alacalı). */
const BUNKER_COLORS = ["#e2402e", "#2c63c9", "#f2c230", "#23252b"];
const SEAM = "#f4f4f0";

export interface PaintballField {
  group: THREE.Group;
  /** Skor tabelası: satırlar (boşsa "GAP PAINTBALL" ve sıradakiler). */
  setBoard(lines: string[], colors?: string[]): void;
  update(night: number): void;
}

/** Şişme engel: gövde ana renkte, ortada beyaz dikiş bandı, tepe yuvarlak. */
function bunkerParts(b: Bunker, color: string, out: THREE.BufferGeometry[]): void {
  const x = (b.ax + b.bx) / 2, z = (b.az + b.bz) / 2;
  const len = Math.hypot(b.bx - b.ax, b.bz - b.az);
  const ry = Math.atan2(b.bz - b.az, b.bx - b.ax);
  const trim = color === "#23252b" ? "#f2c230" : SEAM;
  switch (b.kind) {
    case "can":
    case "tower": {
      const top = Math.min(b.r, 0.4);
      out.push(part(new THREE.CylinderGeometry(b.r, b.r * 1.02, b.h - top, 18), color, mat(x, (b.h - top) / 2, z)));
      const cap = new THREE.SphereGeometry(b.r, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.scale(1, top / b.r, 1);
      out.push(part(cap, color, mat(x, b.h - top, z)));
      for (const y of b.kind === "tower" ? [0.55, 1.35] : [0.7]) out.push(part(new THREE.CylinderGeometry(b.r + 0.012, b.r + 0.012, 0.14, 18, 1, true), trim, mat(x, y, z)));
      break;
    }
    case "cake": {
      out.push(part(new THREE.CylinderGeometry(b.r, b.r * 1.03, b.h - 0.25, 22), color, mat(x, (b.h - 0.25) / 2, z)));
      const rim = new THREE.TorusGeometry(b.r - 0.25, 0.25, 8, 22);
      rim.rotateX(Math.PI / 2);
      out.push(part(rim, color, mat(x, b.h - 0.25, z)));
      out.push(part(new THREE.CircleGeometry(b.r - 0.25, 22), color, flatMat(x, b.h, z)));
      out.push(part(new THREE.CylinderGeometry(b.r + 0.012, b.r + 0.012, 0.12, 22, 1, true), trim, mat(x, 0.45, z)));
      break;
    }
    case "dorito": {
      // Üçgen piramit: iç yarıçapı çarpışma yarıçapına yakın
      const g = new THREE.ConeGeometry(b.r * 1.7, b.h, 3, 1);
      out.push(part(g, color, mat(x, b.h / 2, z, ry + Math.PI / 6)));
      const band = new THREE.CylinderGeometry(b.r * 1.7 * 0.6, b.r * 1.7 * 0.68, 0.12, 3, 1, true);
      out.push(part(band, trim, mat(x, b.h * 0.42, z, ry + Math.PI / 6, 1.02)));
      break;
    }
    case "snake": {
      const g = new THREE.CapsuleGeometry(b.h / 2, len, 4, 14);
      g.rotateZ(Math.PI / 2);
      out.push(part(g, color, mat(x, b.h / 2, z, -ry, 1, 1, b.r / (b.h / 2))));
      for (const s of [-0.33, 0, 0.33]) {
        const ring = new THREE.TorusGeometry(b.h / 2 + 0.005, 0.035, 6, 16);
        ring.rotateY(Math.PI / 2);
        out.push(part(ring, trim, mat(x + Math.cos(ry) * len * s, b.h / 2, z + Math.sin(ry) * len * s, -ry, 1, 1, b.r / (b.h / 2))));
      }
      break;
    }
    case "brick": {
      const w = len + b.r * 1.8;
      out.push(part(new THREE.BoxGeometry(w, b.h - 0.2, b.r * 2), color, mat(x, (b.h - 0.2) / 2, z, -ry)));
      const top = new THREE.CapsuleGeometry(0.2, w - 0.4, 3, 10);
      top.rotateZ(Math.PI / 2);
      top.scale(1, 1, b.r / 0.2);
      out.push(part(top, color, mat(x, b.h - 0.2, z, -ry)));
      out.push(part(new THREE.BoxGeometry(w + 0.02, 0.13, b.r * 2 + 0.02), trim, mat(x, 0.62, z, -ry)));
      break;
    }
  }
}

/** Ağ dokusu: siyah ince ızgara (şeffaf zemin). */
function netTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(20,22,24,0.9)";
  g.lineWidth = 3;
  g.strokeRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function signTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#16181d";
  g.fillRect(0, 0, 512, 128);
  for (const [i, col] of ["#ff7a1a", "#2fb8ff", "#f2c230", "#e2402e"].entries()) {
    g.fillStyle = col;
    g.beginPath();
    g.arc(46 + (i % 2) * 22, 40 + Math.floor(i / 2) * 44, 15 - i * 2, 0, Math.PI * 2);
    g.fill();
  }
  g.textBaseline = "middle";
  g.font = "800 50px system-ui, sans-serif";
  g.fillStyle = "#ffffff";
  g.fillText("GAP", 108, 50, 120);
  const gap = Math.min(120, g.measureText("GAP").width);
  g.fillStyle = "#ff7a1a";
  g.fillText("PAINTBALL", 108 + gap + 14, 50, 512 - 124 - gap - 14);
  g.fillStyle = "#b9c0cc";
  g.font = "600 24px system-ui, sans-serif";
  g.fillText("1v1 · 3 dakika · en çok vuran kazanır", 108, 102, 392);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function paintballField(b: Builder): PaintballField {
  const group = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry) => geos.push(g);
  /** Projektörle aydınlanan zemin ve engeller (gece parlar). */
  const lit: THREE.BufferGeometry[] = [];

  // ---- Zemin: şeritli suni çim ve çizgiler ----
  const PAD = 1.2;
  const strip = 3;
  for (let z0 = -HZ - PAD, i = 0; z0 < HZ + PAD - 1e-3; z0 += strip, i++) {
    const d = Math.min(strip, HZ + PAD - z0);
    lit.push(part(new THREE.PlaneGeometry(HX * 2 + PAD * 2, d), TURF[i % 2], flatMat(CX, 0.025, CZ + z0 + d / 2)));
  }
  const line = (x: number, z: number, w: number, d: number) => lit.push(part(new THREE.PlaneGeometry(w, d), LINE, flatMat(x, 0.03, z)));
  line(CX - HX + 0.15, CZ, 0.12, HZ * 2);
  line(CX + HX - 0.15, CZ, 0.12, HZ * 2);
  line(CX, CZ - HZ + 0.15, HX * 2, 0.12);
  line(CX, CZ + HZ - 0.15, HX * 2, 0.12);
  line(CX, CZ, HX * 2, 0.1);
  // Üs çizgileri: kesikli
  for (const s of [-1, 1]) for (let x = -HX + 0.6; x < HX - 0.5; x += 1.2) line(CX + x + 0.3, CZ + s * 14.8, 0.6, 0.1);
  lit.push(part(new THREE.RingGeometry(2.4, 2.52, 36), LINE, flatMat(CX, 0.031, CZ)));
  b.clearBox(CX - HX - 2.5, CX + HX + 2.5, CZ - HZ - 2.5, CZ + HZ + 2.5);

  // ---- Şişme engeller ----
  BUNKERS.forEach((bk, i) => {
    bunkerParts(bk, BUNKER_COLORS[(i * 3 + (bk.kind === "tower" ? 1 : 0)) % BUNKER_COLORS.length], lit);
    if (bk.ax === bk.bx && bk.az === bk.bz) b.colliders.circle(bk.ax, bk.az, bk.r * (bk.kind === "dorito" ? 0.85 : 1), bk.h);
    else b.colliders.segment(bk.ax, bk.az, bk.bx, bk.bz, bk.r, bk.h);
    b.shadow((bk.ax + bk.bx) / 2, (bk.az + bk.bz) / 2, Math.max(bk.r, Math.hypot(bk.bx - bk.ax, bk.bz - bk.az) / 2 + bk.r) * 1.1);
  });

  // ---- Ağ: direkler, alt tahta, üst halat; ağın kendisi şeffaf doku ----
  const posts: [number, number][] = [];
  for (let x = -HX; x <= HX + 1e-3; x += HX / 3) posts.push([CX + x, CZ - HZ - 0.3], [CX + x, CZ + HZ + 0.3]);
  for (let z = -HZ + HZ / 5; z < HZ - 1e-3; z += HZ / 5) posts.push([CX - HX - 0.3, CZ + z], [CX + HX + 0.3, CZ + z]);
  for (const [x, z] of posts) add(part(new THREE.CylinderGeometry(0.06, 0.07, NET_H + 0.3, 6), "#2a2d33", mat(x, (NET_H + 0.3) / 2, z)));
  const netMat = new THREE.MeshLambertMaterial({ map: netTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.05 });
  const sides: [number, number, number, number][] = [
    [CX, CZ - HZ - 0.3, HX * 2 + 0.6, 0],
    [CX, CZ + HZ + 0.3, HX * 2 + 0.6, 0],
    [CX - HX - 0.3, CZ, HZ * 2 + 0.6, Math.PI / 2],
    [CX + HX + 0.3, CZ, HZ * 2 + 0.6, Math.PI / 2],
  ];
  for (const [x, z, w, ry] of sides) {
    const g = new THREE.PlaneGeometry(w, NET_H);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w * 7, uv.getY(i) * NET_H * 7);
    const net = new THREE.Mesh(g, netMat);
    net.position.set(x, NET_H / 2 + 0.3, z);
    net.rotation.y = ry;
    net.renderOrder = 1;
    group.add(net);
    // Alt tahta (top altından kaçmasın) ve üst halat
    add(part(new THREE.BoxGeometry(w, 0.32, 0.05), "#1f5e2f", mat(x, 0.16, z, ry)));
    add(part(new THREE.BoxGeometry(w, 0.04, 0.04), "#2a2d33", mat(x, NET_H + 0.3, z, ry)));
    const half = w / 2;
    const dx = Math.cos(ry) * half, dz = -Math.sin(ry) * half;
    b.colliders.segment(x - dx, z - dz, x + dx, z + dz, 0.12);
  }

  // ---- Bilet kulübesi: tezgâh köy yoluna (batıya) bakar, arkada silah rafı ----
  const { x: KX, z: KZ } = PB_BOOTH;
  const wood = "#8a5a33", plank = "#a06a3d", roof = "#ff7a1a";
  add(part(new THREE.BoxGeometry(3.4, 0.12, 3.8), "#6b4a2b", mat(KX, 0.06, KZ)));
  add(part(new THREE.BoxGeometry(0.12, 2.6, 3.8), plank, mat(KX + 1.64, 1.36, KZ)));
  for (const s of [-1, 1]) add(part(new THREE.BoxGeometry(3.4, 2.6, 0.12), plank, mat(KX, 1.36, KZ + s * 1.84)));
  add(part(new THREE.BoxGeometry(0.5, 1.05, 3.6), wood, mat(KX - 1.45, 0.6, KZ)));
  add(part(new THREE.BoxGeometry(0.8, 0.08, 3.8), "#c49a6c", mat(KX - 1.5, 1.14, KZ)));
  for (const s of [-1, 1]) add(part(new THREE.BoxGeometry(0.12, 2.6, 0.12), wood, mat(KX - 1.64, 1.36, KZ + s * 1.84)));
  // Çatı: turuncu-beyaz şeritli tente
  for (let i = 0; i < 6; i++) add(part(new THREE.BoxGeometry(4.3, 0.08, 0.72), i % 2 ? "#ffffff" : roof, mat(KX - 0.35, 2.82 + (i - 2.5) * -0.035, KZ - 1.8 + i * 0.72 + 0.36, 0, 1, 1, 1).multiply(new THREE.Matrix4().makeRotationZ(-0.1))));
  b.colliders.segment(KX - 1.45, KZ - 1.84, KX - 1.45, KZ + 1.84, 0.3);
  b.colliders.segment(KX + 1.64, KZ - 1.84, KX + 1.64, KZ + 1.84, 0.1);
  for (const s of [-1, 1]) b.colliders.segment(KX - 1.64, KZ + s * 1.84, KX + 1.64, KZ + s * 1.84, 0.1);
  b.occluder(KX + 0.1, KZ, 3.2, 3.6, 0, 2.6);
  b.shadow(KX, KZ, 2.6);
  b.clearBox(KX - 5, KX + 2.5, KZ - 3, KZ + 3);
  // Kulübeye giden çakıl yol (köy yolundan)
  add(part(new THREE.PlaneGeometry(4.2, 2.2), "#b9ab8f", flatMat(KX - 3.9, 0.022, KZ), 0.08, b.rand));
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: signTexture() }));
  sign.position.set(KX - 1.74, 3.45, KZ);
  sign.rotation.y = -Math.PI / 2;
  group.add(sign);
  add(part(new THREE.BoxGeometry(0.06, 0.9, 3.3), "#16181d", mat(KX - 1.7, 3.45, KZ)));
  // Arka duvarda silah rafı: skinlerden birkaçı
  GUN_SKINS.slice(0, 5).forEach((sk, i) => {
    const gun = markerMesh(sk);
    gun.position.set(KX + 1.48, 1.62, KZ - 1.3 + i * 0.65);
    gun.rotation.set(Math.PI / 2 - 0.1, 0, 0);
    gun.scale.setScalar(1.3);
    group.add(gun);
  });
  add(part(new THREE.BoxGeometry(0.06, 1.3, 3.4), "#5a3b20", mat(KX + 1.56, 1.6, KZ)));

  // ---- Tribün: batı ağının dışında, sahaya (doğuya) bakan üç basamak ----
  const { x: TX, z: TZ, hw: TW, hd: TD } = PB_STANDS;
  for (let i = 0; i < 3; i++) {
    const h = 0.42 + i * 0.42, x = TX + TW - 0.55 - i * 1.2;
    add(part(new THREE.BoxGeometry(1.2, h, TD * 2), i % 2 ? "#8c96a3" : "#9aa4b1", mat(x, h / 2, TZ)));
    add(part(new THREE.BoxGeometry(0.5, 0.06, TD * 2), "#2c63c9", mat(x + 0.25, h + 0.03, TZ)));
    b.colliders.segment(x, TZ - TD + 0.6, x, TZ + TD - 0.6, 0.6, h);
    for (let z = -TD + 0.8; z <= TD - 0.8 + 1e-3; z += 1.1) b.seats.push({ x: x + 0.2, z: TZ + z, rot: Math.PI / 2, h: h + 0.06 });
  }
  b.clearBox(TX - TW - 0.5, TX + TW + 0.5, TZ - TD - 0.5, TZ + TD + 0.5);
  b.occluder(TX, TZ, TW * 2, TD * 2, 0, 0.4);

  // ---- Işık kuleleri: köşelerde, kafaları sahaya dönük ----
  const heads: THREE.Mesh[] = [];
  const headMat = new THREE.MeshLambertMaterial({ color: "#d8dde4", emissive: "#fff3c4", emissiveIntensity: 0 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = CX + sx * (HX + 1.6), z = CZ + sz * (HZ + 1.6);
    add(part(new THREE.CylinderGeometry(0.11, 0.16, 8, 8), "#5d636c", mat(x, 4, z)));
    add(part(new THREE.BoxGeometry(1.5, 0.75, 0.25), "#3a3f46", mat(x, 8.1, z, Math.atan2(CX - x, CZ - z))));
    const head = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.6), headMat);
    const face = Math.atan2(CX - x, CZ - z);
    head.position.set(x + Math.sin(face) * 0.14, 8.1, z + Math.cos(face) * 0.14);
    head.rotation.set(0, face, 0);
    heads.push(head);
    group.add(head);
    b.colliders.circle(x, z, 0.2);
    b.prop("bulb", mat(x + Math.sin(face) * 0.5, 7.7, z + Math.cos(face) * 0.5, 0, 0.6));
  }

  // ---- Skor tabelası: kuzey ucun ardında, sahaya bakar ----
  const boardCanvas = document.createElement("canvas");
  boardCanvas.width = 512;
  boardCanvas.height = 192;
  const boardTex = new THREE.CanvasTexture(boardCanvas);
  boardTex.colorSpace = THREE.SRGBColorSpace;
  const BZ = CZ - HZ - 2.4;
  for (const s of [-1, 1]) add(part(new THREE.BoxGeometry(0.16, 6.2, 0.16), "#3a3f46", mat(CX + s * 2.3, 3.1, BZ)));
  add(part(new THREE.BoxGeometry(5.2, 2.1, 0.22), "#16181d", mat(CX, 5.6, BZ - 0.06)));
  const board = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 1.84), new THREE.MeshBasicMaterial({ map: boardTex, fog: true }));
  board.position.set(CX, 5.6, BZ + 0.06);
  group.add(board);
  for (const s of [-1, 1]) b.colliders.circle(CX + s * 2.3, BZ, 0.15);
  let boardKey: string | null = null;
  const setBoard = (lines: string[], colors: string[] = []) => {
    const key = lines.join("|") + colors.join("|");
    if (key === boardKey) return;
    boardKey = key;
    const g = boardCanvas.getContext("2d")!;
    g.fillStyle = "#0d0f13";
    g.fillRect(0, 0, 512, 192);
    g.textAlign = "center";
    g.textBaseline = "middle";
    const rows = lines.length ? lines : ["GAP PAINTBALL", "Kulübeden sıraya gir"];
    rows.forEach((t, i) => {
      g.fillStyle = colors[i] ?? (i ? "#c9d1dc" : "#ff9a3c");
      g.font = i ? "600 34px system-ui, sans-serif" : "800 54px system-ui, sans-serif";
      g.fillText(t, 256, rows.length === 1 ? 96 : 52 + i * 58, 490);
    });
    boardTex.needsUpdate = true;
  };
  setBoard([]);

  for (const g of geos) b.add(g);
  const flood = { value: 0 };
  const field = new THREE.Mesh(mergeGeometries(lit), floodMaterial(flood, {}));
  field.receiveShadow = true;
  group.add(field);

  return {
    group,
    setBoard,
    update(night: number) {
      headMat.emissiveIntensity = night * 1.6;
      flood.value = night * 0.42;
    },
  };
}
