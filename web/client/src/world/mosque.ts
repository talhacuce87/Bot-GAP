// GAP Camii: şehrin güneyinde, kıbleye dönük klasik Osmanlı selâtin camisi. Merkezi büyük kubbe, dört yarım
// kubbe, köşe kubbeleri ve ağırlık kuleleri; üç şerefeli dört minare; revaklı avlu, ortada şadırvan, taçkapı.
// İçeride halı ve saflar, mihrap, minber, kürsü, dev avize, hat levhaları ve vakit panosu. Gece cephe
// projektörle aydınlanır, şerefelerde kandiller yanar.
// Yerel koordinat (shared/mosque.ts): orijin kubbenin altı, +z kıble, −z avlu. Harim duvarları kamera
// tarafındaysa (içeride) yarı saydam olur; kubbe içeriden görünür (iç yüzü süslemeli).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { HARIM, IMAM_SPOT, inHarim, MOSQUE, mosqueLocal, mosqueWorld, QIBLA_ROT, SADIRVAN } from "../../../shared/mosque";
import { clock, currentVakit, dayTimes, nextVakit, VAKIT_NAMES } from "../../../shared/prayer";
import type { Builder } from "./builder";
import { floodMaterial } from "./casino";
import { mat, part } from "./geo";

const H = 14; // harim duvar yüksekliği
const W = HARIM + 1.1; // duvarın dış yüzü
const T = 1.1;
const STONE = ["#ece5d6", "#e6dfcf", "#efe9dc"];
const LEAD = "#6e7884";
const GOLD = "#d6aa3c";
const MARBLE = "#e8e1d3";
const TILE = "#2f6db5";

const ROOT = mat(MOSQUE.x, 0, MOSQUE.z, QIBLA_ROT);
/** Yerel dönüşüm → dünya matrisi. */
const L = (x: number, y: number, z: number, ry = 0, sx = 1, sy = sx, sz = sx) => ROOT.clone().multiply(mat(x, y, z, ry, sx, sy, sz));

export interface Mosque {
  group: THREE.Group;
  update(time: number, dt: number, focus: { x: number; z: number } | undefined, camera: THREE.Vector3 | undefined, night: number): void;
  /** Minarelerin tepeleri (ezan sesi buradan). */
  minarets: { x: number; z: number }[];
}

/** Hat levhası: yeşil zeminde altın Arapça yazı. */
function levha(text: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c9a640";
  g.beginPath();
  g.arc(256, 256, 252, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#14492f";
  g.beginPath();
  g.arc(256, 256, 236, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#e9c766";
  g.font = "700 190px 'Amiri', 'Scheherazade New', 'Traditional Arabic', 'Arial', serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.direction = "rtl";
  g.fillText(text, 256, 270);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Taçkapı yazısı. */
function gateSign(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#14492f";
  g.fillRect(0, 0, 1024, 256);
  g.strokeStyle = "#d6aa3c";
  g.lineWidth = 14;
  g.strokeRect(10, 10, 1004, 236);
  g.fillStyle = "#e9c766";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "800 112px system-ui, sans-serif";
  g.fillText("GAP CAMİİ", 512, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Vakit panosu: günün vakitleri, girmiş vakit ve sıradakine kalan süre. */
function drawBoard(g: CanvasRenderingContext2D, now: number): void {
  const t = dayTimes(now), cur = currentVakit(now), next = nextVakit(now);
  g.fillStyle = "#14231c";
  g.fillRect(0, 0, 512, 640);
  g.strokeStyle = "#d6aa3c";
  g.lineWidth = 10;
  g.strokeRect(6, 6, 500, 628);
  g.fillStyle = "#e9c766";
  g.textAlign = "center";
  g.font = "800 46px system-ui, sans-serif";
  g.fillText("VAKİTLER", 256, 70);
  const rows: [string, number, string | null][] = [
    ["İmsak", t.imsak, "sabah"], ["Güneş", t.gunes, null], ["Öğle", t.ogle, "ogle"], ["İkindi", t.ikindi, "ikindi"], ["Akşam", t.aksam, "aksam"], ["Yatsı", t.yatsi, "yatsi"],
  ];
  rows.forEach(([name, at, key], i) => {
    const y = 140 + i * 66;
    const active = !!cur && key === cur.key;
    if (active) {
      g.fillStyle = "rgba(214,170,60,0.25)";
      g.fillRect(30, y - 40, 452, 58);
    }
    g.fillStyle = active ? "#ffe7a3" : "#f2efe6";
    g.font = `${active ? 800 : 600} 40px system-ui, sans-serif`;
    g.textAlign = "left";
    g.fillText(name, 52, y);
    g.textAlign = "right";
    g.fillText(clock(at), 460, y);
  });
  const mins = Math.max(0, Math.round((next.at - now) / 60000));
  g.textAlign = "center";
  g.fillStyle = "#9fd8b4";
  g.font = "700 32px system-ui, sans-serif";
  g.fillText(`${VAKIT_NAMES[next.key]} ezanına ${mins >= 60 ? `${Math.floor(mins / 60)} sa ` : ""}${mins % 60} dk`, 256, 560);
  g.fillStyle = "#cfc8b6";
  g.font = "600 26px system-ui, sans-serif";
  g.fillText(cur ? `Şimdi: ${VAKIT_NAMES[cur.key]} vakti` : "Şimdi vakit yok (kerahat)", 256, 606);
}

export function mosque(b: Builder): Mosque {
  const group = new THREE.Group();
  /** 0–3 harim duvarları (ön, kıble, batı, doğu), 4 çatı/kubbeler, 5 iç mekân, 6 kubbenin iç yüzü. */
  const geos: THREE.BufferGeometry[][] = [[], [], [], [], [], [], []];
  let g = 4;
  const add = (geo: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter = 0.03) => geos[g].push(part(geo, color, m, jitter, b.rand));
  /** Dış cephe (avlu, minare, şadırvan, revak): gece projektörle aydınlanır. */
  const stat = (geo: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter = 0.03) => geos[4].push(part(geo, color, m, jitter, b.rand));
  /** Zemin döşemesi (sahnenin statik mesh'inde: yağmurda ıslanır). */
  const pave = (geo: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter = 0.03) => b.add(part(geo, color, m, jitter, b.rand));
  const stone = () => STONE[Math.floor(b.rand() * STONE.length)];
  /** Yerel noktalar arası duvar çarpışması. */
  const wallCol = (ax: number, az: number, bx: number, bz: number, r: number) => {
    const a = mosqueWorld(ax, az), c = mosqueWorld(bx, bz);
    b.colliders.segment(a.x, a.z, c.x, c.z, r);
  };
  const circleCol = (x: number, z: number, r: number, top = Infinity) => {
    const p = mosqueWorld(x, z);
    b.colliders.circle(p.x, p.z, r, top);
  };
  const keepOut = (x: number, z: number, r: number) => {
    const p = mosqueWorld(x, z);
    b.clearCircle(p.x, p.z, r);
  };

  // ------------------------------------------------------------------
  // Yaklaşım: şehirden taçkapıya taş döşeli yol, külliyenin çevresinde servi ağaçları
  // ------------------------------------------------------------------
  const gate = mosqueWorld(0, -56);
  pave(new THREE.BoxGeometry(16, 0.06, gate.z - 38), "#d9cfbd", mat(316, 0.03, (gate.z + 38) / 2), 0.05);
  for (let z = 44; z < gate.z - 2; z += 9) {
    for (const sx of [-1, 1]) {
      const x = 316 + sx * 9.5;
      b.prop("pine", mat(x, 0, z, b.rand() * 6, 0.55, 1.7, 0.55));
      b.colliders.circle(x, z, 0.35);
      b.prop("post", mat(316 + sx * 7.4, 0, z + 4.5));
      b.prop("bulb", mat(316 + sx * 7.4, 2.7, z + 4.5));
      b.colliders.circle(316 + sx * 7.4, z + 4.5, 0.15);
    }
  }
  b.clearBox(306, 326, 38, gate.z);
  // Ön meydan (taçkapının önü) ve külliyenin çevresi
  pave(new THREE.BoxGeometry(30, 0.06, 12), "#d9cfbd", L(0, 0.035, -60), 0.05);
  for (let i = 0; i < 46; i++) {
    const a = (i / 46) * Math.PI * 2;
    const lx = Math.cos(a) * 34, lz = -18 + Math.sin(a) * 52;
    if (Math.abs(lx) < 9 && lz < -50) continue; // taçkapının önü açık
    const p = mosqueWorld(lx, lz);
    b.prop("pine", mat(p.x, 0, p.z, b.rand() * 6, 0.6, 1.8 + b.rand() * 0.4, 0.6));
    b.colliders.circle(p.x, p.z, 0.35);
  }
  keepOut(0, -18, 30);
  keepOut(0, -38, 24);

  // ------------------------------------------------------------------
  // Avlu: mermer zemin, üç yanda revak (sütunlar, kubbeli saçak), dış duvar, taçkapı
  // ------------------------------------------------------------------
  const AZ0 = -52.5, AZ1 = -W; // avlu kuzey ve güney kenarı
  const AW = 18;
  pave(new THREE.BoxGeometry(AW * 2, 0.08, AZ1 - AZ0), MARBLE, L(0, 0.04, (AZ0 + AZ1) / 2), 0.04);
  // Zemin deseni: çapraz şeritler
  for (let k = -3; k <= 3; k++) pave(new THREE.BoxGeometry(0.25, 0.01, AZ1 - AZ0 - 2), "#c9bfa9", L(k * 4.5, 0.085, (AZ0 + AZ1) / 2), 0);
  // Dış duvar (alçak, mazgallı)
  const cw = (x: number, z: number, w: number, d: number) => {
    stat(new THREE.BoxGeometry(w, 5, d), stone(), L(x, 2.5, z), 0.04);
    stat(new THREE.BoxGeometry(w + 0.3, 0.35, d + 0.3), "#d8cfbd", L(x, 5.15, z), 0.02);
  };
  for (const sx of [-1, 1]) {
    cw(sx * (AW + 0.45), (AZ0 + AZ1) / 2, 0.9, AZ1 - AZ0);
    wallCol(sx * (AW + 0.45), AZ0, sx * (AW + 0.45), AZ1, 0.45);
    cw((sx * (AW + 2.6)) / 2, AZ0, AW - 2.6, 0.9);
    wallCol(sx * 2.8, AZ0, sx * (AW + 0.9), AZ0, 0.45);
  }
  // Revak: batı, doğu ve kuzeyde iç kenarda sütunlar, üstte düz saçak ve her bölmede küçük kubbe
  const column = (x: number, z: number, h: number) => {
    stat(new THREE.CylinderGeometry(0.32, 0.36, h, 10), "#f1ece2", L(x, h / 2, z), 0.02);
    stat(new THREE.BoxGeometry(0.85, 0.35, 0.85), GOLD, L(x, h + 0.17, z), 0.02);
    stat(new THREE.BoxGeometry(0.8, 0.3, 0.8), "#d8cfbd", L(x, 0.15, z), 0.02);
    circleCol(x, z, 0.4);
  };
  const smallDome = (x: number, y: number, z: number, r: number, put = stat) => {
    put(new THREE.CylinderGeometry(r * 1.02, r * 1.02, r * 0.35, 16), stone(), L(x, y + r * 0.17, z), 0.02);
    put(new THREE.SphereGeometry(r, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2), LEAD, L(x, y + r * 0.35, z), 0.04);
    put(new THREE.ConeGeometry(0.06, 0.6, 6), GOLD, L(x, y + r * 1.35 + 0.3, z), 0);
  };
  for (const sx of [-1, 1]) {
    const cx = sx * (AW - 3.3);
    for (let z = AZ0 + 3.3; z < AZ1 - 1.5; z += 3.5) column(cx, z, 4.4);
    stat(new THREE.BoxGeometry(3.6, 0.4, AZ1 - AZ0 - 3), "#e4dccb", L(sx * (AW - 1.6), 4.95, (AZ0 + AZ1) / 2 + 1.5), 0.03);
    for (let z = AZ0 + 5.1; z < AZ1 - 2; z += 3.5) smallDome(sx * (AW - 1.6), 5.15, z, 1.45);
  }
  for (let x = -AW + 3.3 + 3.5; x < AW - 3.3; x += 3.5) {
    if (Math.abs(x) < 2.6) continue; // taçkapının arkası açık
    column(x, AZ0 + 3.3, 4.4);
  }
  stat(new THREE.BoxGeometry(AW * 2, 0.4, 3.6), "#e4dccb", L(0, 4.95, AZ0 + 1.6), 0.03);
  for (let x = -AW + 5; x < AW - 4; x += 3.5) if (Math.abs(x) > 2.8) smallDome(x, 5.15, AZ0 + 1.6, 1.45);
  // Avluda çınarlar
  for (const [x, z] of [[-9, -27], [9, -27], [-9, -44], [9, -44]]) {
    const p = mosqueWorld(x, z);
    b.prop("oak", mat(p.x, 0, p.z, b.rand() * 6, 1.25));
    b.colliders.circle(p.x, p.z, 0.45);
    stat(new THREE.CylinderGeometry(1.2, 1.2, 0.3, 12), "#cfc6b2", L(x, 0.15, z));
  }

  // Taçkapı: yüksek mermer portal, sivri kemerli niş, üstte yazı (gece yazı parlar)
  let gateMat: THREE.MeshLambertMaterial | null = null;
  {
    const z = AZ0;
    for (const sx of [-1, 1]) {
      stat(new THREE.BoxGeometry(2.6, 10.5, 2.8), stone(), L(sx * 2.9, 5.25, z), 0.03);
      wallCol(sx * 1.7, z - 1.4, sx * 1.7, z + 1.4, 0.15);
    }
    stat(new THREE.BoxGeometry(8.4, 3.2, 2.8), stone(), L(0, 8.9, z), 0.03);
    stat(new THREE.BoxGeometry(8.8, 0.45, 3.1), GOLD, L(0, 10.7, z), 0.02);
    // Sivri kemer: iki eğik kiriş
    for (const sx of [-1, 1]) stat(new THREE.BoxGeometry(0.35, 2.6, 0.5), "#d8cfbd", L(sx * 0.85, 6.4, z - 1.45, 0).multiply(new THREE.Matrix4().makeRotationZ(sx * 0.55)), 0);
    for (let k = 0; k < 5; k++) stat(new THREE.BoxGeometry(3.2 - k * 0.5, 0.22, 0.4), k % 2 ? GOLD : "#e8dfc9", L(0, 7.4 + k * 0.28, z - 1.3), 0);
    const tex = gateSign();
    gateMat = new THREE.MeshLambertMaterial({ map: tex, emissive: "#ffffff", emissiveMap: tex, emissiveIntensity: 0.2 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), gateMat);
    sign.applyMatrix4(L(0, 8.9, z - 1.42, Math.PI));
    sign.matrixAutoUpdate = false;
    group.add(sign);
  }

  // ------------------------------------------------------------------
  // Şadırvan: sekizgen mermer hazne, musluklar, sekiz sütunlu kurşun çatı
  // ------------------------------------------------------------------
  {
    const { x: sx0, z: sz0 } = SADIRVAN;
    stat(new THREE.CylinderGeometry(2.7, 2.8, 0.95, 8), "#f1ece2", L(sx0, 0.48, sz0, Math.PI / 8), 0.02);
    stat(new THREE.CylinderGeometry(2.45, 2.45, 0.05, 8), "#4fa3d8", L(sx0, 0.96, sz0, Math.PI / 8), 0);
    stat(new THREE.CylinderGeometry(0.5, 0.65, 1.8, 8), "#f1ece2", L(sx0, 1.5, sz0), 0.02);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const fx = sx0 + Math.cos(a) * 2.78, fz = sz0 + Math.sin(a) * 2.78;
      stat(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 6).rotateZ(Math.PI / 2), GOLD, L(fx, 0.75, fz, -a), 0);
      // Abdest taburesi
      stat(new THREE.CylinderGeometry(0.28, 0.3, 0.42, 8), "#cfc6b2", L(sx0 + Math.cos(a) * 3.45, 0.21, sz0 + Math.sin(a) * 3.45), 0.02);
      // Çatı sütunları
      const px = sx0 + Math.cos(a + Math.PI / 8) * 4, pz = sz0 + Math.sin(a + Math.PI / 8) * 4;
      stat(new THREE.CylinderGeometry(0.16, 0.18, 4.2, 8), "#f1ece2", L(px, 2.1, pz), 0.02);
      circleCol(px, pz, 0.22);
    }
    stat(new THREE.CylinderGeometry(4.7, 4.7, 0.3, 8), "#e4dccb", L(sx0, 4.35, sz0, Math.PI / 8), 0.02);
    stat(new THREE.ConeGeometry(4.5, 2.2, 8), LEAD, L(sx0, 5.6, sz0, Math.PI / 8), 0.03);
    stat(new THREE.ConeGeometry(0.08, 0.8, 6), GOLD, L(sx0, 7.1, sz0), 0);
    circleCol(sx0, sz0, 2.85, 0.95);
  }

  // ------------------------------------------------------------------
  // Son cemaat yeri: harimin önünde sütunlu, beş kubbeli revak
  // ------------------------------------------------------------------
  for (let x = -14; x <= 14.01; x += 3.5) {
    if (Math.abs(x) < 1.8) continue; // kapının önü
    column(x, -W - 3.8, 5.6);
  }
  stat(new THREE.BoxGeometry(W * 2, 0.45, 4.3), "#e4dccb", L(0, 6.3, -W - 2.1), 0.03);
  for (const x of [-11, -5.5, 0, 5.5, 11]) smallDome(x, 6.5, -W - 2.1, 1.85);

  // ------------------------------------------------------------------
  // Harim duvarları (dört grup; içeride kamera tarafındaki solar)
  // ------------------------------------------------------------------
  /** `side`: 0 ön (−z), 1 kıble (+z), 2 batı (−x), 3 doğu (+x). Duvar yerel x boyunca, `ry` ile döndürülür. */
  const harimWall = (side: number, door: number, doorH: number) => {
    g = side;
    const ry = [0, Math.PI, Math.PI / 2, -Math.PI / 2][side];
    const len = W * 2;
    const P = (u: number, d: number): [number, number] => {
      // u duvar boyunca, d dışa doğru (duvarın ortasından)
      if (side === 0) return [u, -W + T / 2 - d];
      if (side === 1) return [-u, W - T / 2 + d];
      if (side === 2) return [-W + T / 2 - d, -u];
      return [W - T / 2 + d, u];
    };
    const piece = (w: number, h: number, dep: number, color: string, u: number, y: number, d = 0, jitter = 0.03) => {
      const [x, z] = P(u, d);
      add(new THREE.BoxGeometry(w, h, dep), color, L(x, y, z, ry), jitter);
    };
    // Duvar gövdesi (kapı boşluğu dahil)
    const half = len / 2;
    for (const s of [-1, 1]) {
      const w = half - door;
      piece(w, H, T, stone(), s * (door + w / 2), H / 2);
      const [ax, az] = P(s * door, 0), [bx, bz] = P(s * half, 0);
      wallCol(ax, az, bx, bz, T / 2);
    }
    if (door > 0) piece(door * 2, H - doorH, T, stone(), 0, doorH + (H - doorH) / 2);
    // Kuşaklar ve saçak
    piece(len + 0.3, 0.4, T + 0.2, "#d8cfbd", 0, H - 0.2, 0, 0.02);
    piece(len + 0.1, 0.25, T + 0.12, "#d8cfbd", 0, 6.5, 0, 0.02);
    // Pencereler: iki sıra, dışta koyu cam, içte açık renkli vitray
    for (const [y, h, step] of [[3.6, 2.4, 3.2], [9.6, 2.8, 3.2]] as const) {
      for (let u = -half + 2.4; u < half - 1.5; u += step) {
        if (door > 0 && Math.abs(u) < door + 0.8 && y < doorH + 1.5) continue;
        piece(1.25, h, 0.12, "#25384f", u, y, T / 2 + 0.04, 0);
        piece(1.55, 0.25, 0.2, GOLD, u, y + h / 2 + 0.15, T / 2 + 0.05, 0);
        piece(1.2, h, 0.08, b.rand() > 0.5 ? "#a9d6ff" : "#f5d98c", u, y, -T / 2 - 0.03, 0);
      }
    }
    // İç yüz: alt kuşak İznik çinisi (mavi-beyaz), üstü krem
    piece(len - T * 2, 3.2, 0.06, TILE, 0, 1.6, -T / 2 - 0.02, 0.1);
    for (let u = -half + T + 0.6; u < half - T; u += 1.2) piece(0.5, 0.5, 0.07, "#f4f0e6", u, 1.6, -T / 2 - 0.035, 0);
    piece(len - T * 2, 0.18, 0.08, GOLD, 0, 3.25, -T / 2 - 0.03, 0);
  };
  harimWall(0, 1.8, 5.6);
  harimWall(1, 0, 0);
  harimWall(2, 1.2, 4.2);
  harimWall(3, 1.2, 4.2);
  // Ana kapı: altın çerçeve ve ahşap kanatlar (açık)
  g = 0;
  add(new THREE.BoxGeometry(4.4, 0.4, T + 0.3), GOLD, L(0, 5.8, -W + T / 2), 0.02);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.12, 5.4, 1.5), "#6b3f1f", L(s * 1.8, 2.7, -W - 0.2, s * 0.9), 0.05);

  // ------------------------------------------------------------------
  // Çatı: tavan döşemesi (ortası açık), kasnak, ana kubbe, yarım kubbeler, köşe kubbeleri, ağırlık kuleleri
  // ------------------------------------------------------------------
  g = 4;
  const R = 10.6; // ana kubbe
  {
    const shape = new THREE.Shape();
    shape.moveTo(-W, -W);
    shape.lineTo(W, -W);
    shape.lineTo(W, W);
    shape.lineTo(-W, W);
    shape.lineTo(-W, -W);
    const hole = new THREE.Path();
    hole.absarc(0, 0, R, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const slab = new THREE.ExtrudeGeometry(shape, { depth: 0.6, bevelEnabled: false, curveSegments: 32 }).rotateX(-Math.PI / 2);
    add(slab, "#e9e2d2", L(0, H, 0), 0.02);
  }
  // Kasnak: pencereli silindir
  add(new THREE.CylinderGeometry(R, R, 2.8, 40, 1, true), "#ebe4d4", L(0, H + 2, 0), 0.02);
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    add(new THREE.BoxGeometry(0.9, 1.5, 0.12), "#25384f", L(Math.sin(a) * (R + 0.05), H + 2, Math.cos(a) * (R + 0.05), a), 0);
  }
  add(new THREE.TorusGeometry(R + 0.1, 0.22, 6, 48).rotateX(Math.PI / 2), "#d8cfbd", L(0, H + 3.4, 0), 0);
  // Ana kubbe ve alem
  add(new THREE.SphereGeometry(R, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2), LEAD, L(0, H + 3.4, 0), 0.04);
  const top = H + 3.4 + R;
  add(new THREE.CylinderGeometry(0.12, 0.2, 1.6, 8), GOLD, L(0, top + 0.8, 0), 0);
  add(new THREE.SphereGeometry(0.42, 10, 8), GOLD, L(0, top + 1.6, 0), 0);
  add(new THREE.TorusGeometry(0.62, 0.11, 6, 16, Math.PI * 1.4), GOLD, L(0, top + 2.5, 0, 0).multiply(new THREE.Matrix4().makeRotationZ(-Math.PI * 0.2)), 0);
  // Yarım kubbeler (dört yanda, ortaya açık)
  for (const [x, z, ry] of [[0, 9.6, 0], [0, -9.6, Math.PI], [9.6, 0, Math.PI / 2], [-9.6, 0, -Math.PI / 2]] as const) {
    add(new THREE.SphereGeometry(6.2, 24, 8, 0, Math.PI, 0, Math.PI / 2), LEAD, L(x, H + 0.6, z, ry), 0.04);
  }
  // Köşe kubbeleri ve ağırlık kuleleri
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      smallDome(sx * 11.6, H + 0.6, sz * 11.6, 3.1, add);
      const tx = sx * (W - 0.4), tz = sz * (W - 0.4);
      add(new THREE.CylinderGeometry(1.35, 1.5, 4.2, 8), stone(), L(tx, H + 2.1, tz), 0.03);
      add(new THREE.ConeGeometry(1.45, 2.2, 8), LEAD, L(tx, H + 5.3, tz), 0.03);
      add(new THREE.ConeGeometry(0.06, 0.8, 6), GOLD, L(tx, H + 6.8, tz), 0);
    }
  }
  // Mihrap çıkıntısı (dışta)
  add(new THREE.BoxGeometry(5.2, 9, 1.6), stone(), L(0, 4.5, W + 0.7), 0.03);
  add(new THREE.ConeGeometry(3.3, 1.6, 4), LEAD, L(0, 9.8, W + 0.7, Math.PI / 4), 0.03);

  // ------------------------------------------------------------------
  // Kubbenin iç yüzü: krem zemin, mavi ve altın halkalar, ortada lacivert madalyon
  // ------------------------------------------------------------------
  g = 6;
  const bands: [number, number, string][] = [
    [0, 0.12, "#1e3f73"], [0.12, 0.2, "#efe7d6"], [0.2, 0.26, GOLD], [0.26, 0.62, "#efe7d6"], [0.62, 0.7, "#2f6db5"], [0.7, 0.92, "#efe7d6"], [0.92, 1, GOLD],
  ];
  for (const [a0, a1, c] of bands) {
    add(new THREE.SphereGeometry(R - 0.15, 40, 3, 0, Math.PI * 2, (a0 * Math.PI) / 2, ((a1 - a0) * Math.PI) / 2), c, L(0, H + 3.4, 0), 0);
  }
  add(new THREE.CylinderGeometry(R - 0.15, R - 0.15, 2.8, 40, 1, true), "#efe7d6", L(0, H + 2, 0), 0);
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2 + Math.PI / 20;
    add(new THREE.BoxGeometry(0.85, 1.4, 0.06), "#f5d98c", L(Math.sin(a) * (R - 0.25), H + 2, Math.cos(a) * (R - 0.25), a), 0);
  }
  // Yarım kubbe ve köşelerin iç tavanı: tavan döşemesinin altı süslemeli
  for (let k = 0; k < 4; k++) add(new THREE.TorusGeometry(R + 0.4, 0.18, 5, 48).rotateX(Math.PI / 2), k % 2 ? GOLD : "#2f6db5", L(0, H - 0.25 - k * 0.32, 0), 0);

  // ------------------------------------------------------------------
  // İç mekân: halı ve saflar, mihrap, minber, kürsü, avize
  // ------------------------------------------------------------------
  g = 5;
  add(new THREE.BoxGeometry(HARIM * 2, 0.06, HARIM * 2), "#8e1f2e", L(0, 0.04, 0), 0.04);
  for (let k = 0; k < 15; k++) {
    const z = IMAM_SPOT.z - 1.05 - k * 1.7;
    if (z < -HARIM + 0.5) break;
    add(new THREE.BoxGeometry(HARIM * 2 - 1, 0.012, 0.1), "#c9a24a", L(0, 0.075, z), 0);
  }
  add(new THREE.BoxGeometry(HARIM * 2 - 0.6, 0.014, 0.35), "#1f5f45", L(0, 0.076, -HARIM + 0.6), 0);
  // Mihrap: çerçeve, lacivert niş, mukarnas, sivri tepe, iki şamdan
  {
    const z = HARIM - 0.2;
    add(new THREE.BoxGeometry(4, 7.2, 0.5), "#eadcb6", L(0, 3.6, z), 0.02);
    add(new THREE.BoxGeometry(2.4, 5.2, 0.3), "#24476f", L(0, 2.6, z - 0.2), 0.02);
    add(new THREE.BoxGeometry(2.7, 0.2, 0.35), GOLD, L(0, 5.25, z - 0.25), 0);
    for (let k = 0; k < 4; k++) add(new THREE.BoxGeometry(2.2 - k * 0.45, 0.32, 0.3), k % 2 ? GOLD : "#2f6db5", L(0, 5.6 + k * 0.34, z - 0.22), 0);
    add(new THREE.ConeGeometry(1.6, 1.4, 4), GOLD, L(0, 7.6, z - 0.1, Math.PI / 4), 0);
    for (const sx of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.12, 0.22, 2.4, 8), GOLD, L(sx * 2.6, 1.2, z - 0.8), 0);
      const fl = mosqueWorld(sx * 2.6, z - 0.8);
      b.prop("flame", mat(fl.x, 2.6, fl.z, 0, 0.7));
      circleCol(sx * 2.6, z - 0.8, 0.25);
    }
  }
  // Minber: mihrabın sağında (kıbleye bakana göre; yerel −x), kıble duvarına doğru yükselen merdiven ve külahlı köşk
  {
    const mx = -4.3;
    for (let k = 0; k < 9; k++) add(new THREE.BoxGeometry(1.2, 0.4 * (k + 1), 0.8), k % 2 ? "#f1ece2" : "#e6dfcf", L(mx, 0.2 * (k + 1), 7.4 + k * 0.8), 0.02);
    for (const sx of [-0.66, 0.66]) add(new THREE.BoxGeometry(0.1, 3.6, 7.4), "#e8dfc9", L(mx + sx, 2.4, 10.9), 0.02);
    add(new THREE.BoxGeometry(1.4, 2.4, 1.4), "#f1ece2", L(mx, 4.8, 14.4), 0.02);
    add(new THREE.ConeGeometry(1.0, 2.4, 8), GOLD, L(mx, 7.2, 14.4), 0.02);
    wallCol(mx, 7, mx, 15, 0.75);
  }
  // Kürsü
  add(new THREE.BoxGeometry(1.6, 1.3, 1.6), "#7a4a26", L(6, 0.65, 9), 0.05);
  add(new THREE.BoxGeometry(1.6, 1.2, 0.15), "#7a4a26", L(6, 1.9, 9.75), 0.05);
  circleCol(6, 9, 1);
  // Avize: kubbeden sarkan büyük halka, zincirler, kandiller
  {
    const ry = 4.6, rr = 7.4;
    add(new THREE.TorusGeometry(rr, 0.09, 6, 64).rotateX(Math.PI / 2), "#a57c2c", L(0, ry, 0), 0);
    add(new THREE.TorusGeometry(rr * 0.55, 0.07, 6, 48).rotateX(Math.PI / 2), "#a57c2c", L(0, ry + 0.6, 0), 0);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const len = H + 3.4 + R * 0.92 - ry;
      add(new THREE.CylinderGeometry(0.025, 0.025, len, 4), "#5a4a2a", L(Math.cos(a) * rr * 0.97, ry + len / 2, Math.sin(a) * rr * 0.97), 0);
    }
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const p = mosqueWorld(Math.cos(a) * rr, Math.sin(a) * rr);
      b.prop("bulb", mat(p.x, ry + 0.25, p.z, 0, 0.32));
    }
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const p = mosqueWorld(Math.cos(a) * rr * 0.55, Math.sin(a) * rr * 0.55);
      b.prop("bulb", mat(p.x, ry + 0.85, p.z, 0, 0.28));
    }
  }

  // ------------------------------------------------------------------
  // Minareler: kare kaide, on iki köşeli gövde, üç şerefe, kurşun külah, alem; gece şerefelerde kandil
  // ------------------------------------------------------------------
  const minarets: { x: number; z: number }[] = [];
  for (const [mx, mz] of [[-W - 1.6, -W - 1.6], [W + 1.6, -W - 1.6], [-AW - 1.6, AZ0 + 0.9], [AW + 1.6, AZ0 + 0.9]] as const) {
    stat(new THREE.BoxGeometry(3.2, 7, 3.2), stone(), L(mx, 3.5, mz), 0.03);
    stat(new THREE.CylinderGeometry(1.25, 1.65, 1.2, 12), stone(), L(mx, 7.6, mz), 0.03);
    stat(new THREE.CylinderGeometry(1.05, 1.2, 33, 12), "#f1ece2", L(mx, 24.7, mz), 0.02);
    for (const y of [20, 29, 37]) {
      stat(new THREE.CylinderGeometry(1.95, 1.3, 0.8, 12), "#e4dccb", L(mx, y, mz), 0.02);
      stat(new THREE.TorusGeometry(1.9, 0.07, 4, 24).rotateX(Math.PI / 2), "#d8cfbd", L(mx, y + 0.95, mz), 0);
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const p = mosqueWorld(mx + Math.cos(a) * 1.9, mz + Math.sin(a) * 1.9);
        b.prop("bulb", mat(p.x, y + 1.15, p.z, 0, 0.3));
      }
    }
    stat(new THREE.ConeGeometry(1.15, 9, 12), LEAD, L(mx, 45.7, mz), 0.03);
    stat(new THREE.CylinderGeometry(0.06, 0.1, 1.2, 6), GOLD, L(mx, 50.8, mz), 0);
    stat(new THREE.SphereGeometry(0.22, 8, 6), GOLD, L(mx, 51.4, mz), 0);
    circleCol(mx, mz, 2.2);
    minarets.push(mosqueWorld(mx, mz));
  }

  // ------------------------------------------------------------------
  // Mesh'ler
  // ------------------------------------------------------------------
  const flood = { value: 0.2 };
  const inner = { value: 0.3 };
  const wallMats: THREE.MeshLambertMaterial[] = [];
  for (let i = 0; i < 4; i++) {
    const m = floodMaterial(flood, { transparent: true, opacity: 1 });
    wallMats.push(m);
    const mesh = new THREE.Mesh(mergeGeometries(geos[i]), m);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  const roof = new THREE.Mesh(mergeGeometries(geos[4]), floodMaterial(flood, { side: THREE.DoubleSide }));
  roof.castShadow = roof.receiveShadow = true;
  roof.matrixAutoUpdate = false;
  const interior = new THREE.Mesh(mergeGeometries(geos[5]), floodMaterial(inner, {}));
  interior.receiveShadow = true;
  interior.matrixAutoUpdate = false;
  const domeIn = new THREE.Mesh(mergeGeometries(geos[6]), floodMaterial(inner, { side: THREE.BackSide }));
  domeIn.matrixAutoUpdate = false;
  group.add(roof, interior, domeIn);

  // Hat levhaları (yan duvarlarda, yüksekte) ve vakit panoları (içeride arka duvarda, dışarıda kapının yanında)
  const levhaMats: THREE.Material[] = [];
  for (const [text, side] of [["الله", -1], ["محمد", 1]] as const) {
    const m = new THREE.MeshLambertMaterial({ map: levha(text), transparent: true, emissive: "#555555" });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(2.2, 40), m);
    mesh.applyMatrix4(L(side * (HARIM - 0.12), 9.6, 4, -side * (Math.PI / 2)));
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    levhaMats.push(m);
  }
  const boardCanvas = document.createElement("canvas");
  boardCanvas.width = 512;
  boardCanvas.height = 640;
  const boardTex = new THREE.CanvasTexture(boardCanvas);
  boardTex.colorSpace = THREE.SRGBColorSpace;
  const boardMat = new THREE.MeshLambertMaterial({ map: boardTex, emissive: "#ffffff", emissiveMap: boardTex, emissiveIntensity: 0.45 });
  for (const at of [L(-6, 3.6, -HARIM + 0.08), L(-6, 2.6, -W - 0.06, Math.PI)]) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 3), boardMat);
    mesh.applyMatrix4(at);
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  let boardAt = -Infinity;

  /** Kameranın (içerideyken) hangi duvarın tarafında olduğu, yerel koordinatta. */
  const cameraSide = [
    (c: { x: number; z: number }) => c.z < -HARIM + 2.5,
    (c: { x: number; z: number }) => c.z > HARIM - 2.5,
    (c: { x: number; z: number }) => c.x < -HARIM + 2.5,
    (c: { x: number; z: number }) => c.x > HARIM - 2.5,
  ];
  const opacity = [1, 1, 1, 1];

  return {
    group,
    minarets,
    update(_time, dt, focus, camera, night) {
      // Gece cephe projektörle, içerisi kandillerle aydınlık
      flood.value = 0.06 + night * 0.55;
      if (gateMat) gateMat.emissiveIntensity = 0.2 + night * 0.7;
      inner.value = 0.28 + night * 0.22;
      const now = Date.now();
      if (now - boardAt > 20_000) {
        boardAt = now;
        drawBoard(boardCanvas.getContext("2d")!, now);
        boardTex.needsUpdate = true;
      }
      const inside = !!focus && inHarim(focus.x, focus.z);
      const cam = camera ? mosqueLocal(camera.x, camera.z) : null;
      const k = 1 - Math.exp(-dt * 8);
      for (let i = 0; i < 4; i++) {
        const target = inside && cam && cameraSide[i](cam) ? 0.15 : 1;
        opacity[i] += (target - opacity[i]) * k;
        const m = wallMats[i];
        m.opacity = opacity[i];
        m.depthWrite = opacity[i] > 0.95;
      }
      for (const m of levhaMats) m.opacity = Math.min(opacity[2], opacity[3]) > 0.5 ? 1 : 0.3;
    },
  };
}
