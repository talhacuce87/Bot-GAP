// GAP Şehri ve ona giden vadi yolu. Köyün doğusundan (eski casino yeri) başlayan iki şeritli asfalt,
// iki tepe arasından kıvrılarak şehrin bulvarına bağlanır. Şehir: dört şeritli bulvar ve cadde ağı,
// kavşaklarda trafik lambaları ve yaya geçitleri; merkezde casino, çevresinde cam gökdelenler ve
// rezidanslar, güneyde orta katlı binalar, AVM, park ve villalar.
//
// Hepsi statik (Builder'ın tek mesh'i); parlayanlar (pencereler, LED, neon, trafik ışıkları) ayrı Basic
// mesh'lerde. Gece pencereler yanar, gökdelenlerin tepesindeki kırmızı ikaz lambaları yanıp söner.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BOULEVARD_Z, CASINO, CITY, RIVER_BANK, ROAD_HALF, ROAD_PATH, ROAD_WALK, CITY_DX, LINK_ROADS, onAsphalt, polylineDist, roadDist, STREETS, type Street, GARAGE, VILLAGE_ROAD_HALF, VILLAGE_ROADS, villageRoadDist } from "../../../shared/zones";
import type { Look } from "../../../shared/protocol";
import type { Builder } from "./builder";
import { floodMaterial } from "./casino";
import { HOOD_PARK, HOOD_ROADS, HOOD_ROUNDABOUT, HOOD_SIDEWALK, HOOD_STREET_HALF, onHoodStreet, PLOTS } from "../../../shared/build";
import { ROAD_BRIDGE_HALF, riverDist } from "./terrain";
import { furnish, type Kit, MALL_SIGNS, SHOPS } from "./interiors";
import { mat, part } from "./geo";
import { staticMesh, tiledStatics } from "./tiles";
import type { OccluderBox, Portal } from "./occlusion";
import { signalLamp, signalNow } from "./signals";

const ASPHALT = "#3c3f45";
const ASPHALT_DARK = "#34373c";
const CONCRETE = "#bdb9b0";
const SIDEWALK = "#cfcbc2";
const CURB = "#9d9a93";
const LINE = "#f1f1ec";
const YELLOW = "#f2c230";
const STEEL = "#4b5058";
const STEEL_LIGHT = "#9aa2ab";
const CONCRETE_DARK = "#8e8a82";
const LAWN = "#6f9c4c";
const GOLD = "#d6aa3c";

/** Basamak yüksekliğinin altında: kaldırımda yürürken ayak gömülmesin diye ince. */
const Y_BASE = 0.02;
const Y_ASPHALT = 0.04;
/** Köprü nehrin oyuğunun bu kadar içinde (kıyıların biraz ötesine dek). */
const RIVER_SPAN = RIVER_BANK + 0.5;
const Y_WALK = 0.08;

/** Girilebilir dükkânın içi (eksene hizalı); içerideyken kamera bunun içinde kalır. */
export interface Room {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Tavanın altı (kamera bunun altında kalır). */
  ceil: number;
}

/** Dükkânda çalışan (sabit NPC) ve tezgâhının önündeki etkileşim. */
export interface CityNpc {
  name: string;
  x: number;
  z: number;
  rot: number;
  outfit: Look;
  act: { x: number; z: number; r: number; label: string; line: string; fx: "tea" | "sparkle" | "party"; shop?: "barber" | "fashion" };
}

export interface City {
  group: THREE.Group;
  rooms: Room[];
  npcs: CityNpc[];
  /**
   * Dükkân iç mekânları (dükkân başına bir mesh): uzaktakiler kare başına gizlenir (geo.ts cullFar), yalnızca
   * ön cepheden görünürler (`portals`, occlusion.ts).
   */
  interiors: THREE.Group;
  portals: Map<THREE.Object3D, Portal>;
  /** Dükkân katlarının duvarları ve tavanları (karolar; dışarıdan da görünür). */
  walls: THREE.Group;
  /** Kare başına: gece pencereleri, ikaz lambaları, trafik ışıkları. */
  update(time: number, night: number): void;
}

const SHOP_GLASS = "#33495c";
const WALL_T = 0.3;
const DOOR_W = 2.6;
const DOOR_H = 3.1;

/** Tabela dokusu (tek canvas): her hücre 512×128, 2 sütun × 8 satır. */
interface Cell {
  text: string;
  bg: string;
  fg: string;
  sub?: string;
  edge?: string;
}
const NEON_CELLS: Cell[] = [
  { text: "GAP MARKET", bg: "#0f5132", fg: "#f4fff6", edge: "#7dffb0" },
  { text: "GAP KAHVE", bg: "#3b2314", fg: "#ffe9c7", edge: "#ffb46b" },
  { text: "BURGER GAP", bg: "#a8161d", fg: "#ffe14d", edge: "#ffd34d" },
  { text: "ECZANE", bg: "#e8f7ee", fg: "#d0102a", edge: "#d0102a" },
  { text: "GAP BANK", bg: "#0b2545", fg: "#e7f0ff", edge: "#7fb2ff" },
  { text: "GAP AVM", bg: "#1a0f2e", fg: "#ff7ad9", edge: "#c58bff", sub: "AÇIK · 10:00 – 22:00" },
  { text: "GAP COLA", bg: "#b00d1e", fg: "#ffffff", edge: "#ffffff", sub: "Buz gibi!" },
  { text: "CASINO", bg: "#120d05", fg: "#ffd36b", edge: "#ffd36b", sub: "★ BULVARIN ORTASINDA ★" },
  { text: "GAP TOWER", bg: "#0a1726", fg: "#bfe9ff", edge: "#5fd3ff" },
  { text: "GAP AIR", bg: "#062b3d", fg: "#ffffff", edge: "#40d9ff", sub: "Dünyaya açılın" },
  { text: "OTEL GAP", bg: "#26180b", fg: "#f6d9a2", edge: "#f6d9a2", sub: "★ ★ ★ ★ ★" },
  { text: "DURAK", bg: "#1f4fbf", fg: "#ffffff", edge: "#ffffff" },
  { text: "BERBER", bg: "#f4f1ea", fg: "#1a1a1a", edge: "#c8102e" },
  { text: "GAP FM 99.9", bg: "#2a0b3d", fg: "#ffe14d", edge: "#ff4fd8", sub: "Şehrin sesi" },
  ...MALL_SIGNS.map((text, i): Cell => {
    const look: [string, string, string][] = [["#1a0f1e", "#ff9ad5", "#ff4fd8"], ["#0a1626", "#7fd4ff", "#3fa9ff"], ["#1a0610", "#ff4f9a", "#ff2d6f"], ["#fff4d6", "#e94f4f", "#f59e0b"], ["#fdf2f6", "#d0457f", "#f9a8c8"], ["#2b2f35", "#e8ecf2", "#9aa2ab"], ["#0b2545", "#ffffff", "#7fb2ff"]];
    const [bg, fg, edge] = look[i % look.length];
    return { text, bg, fg, edge };
  }),
];
/** Atlas satır sayısı (hücre 512×128). */
const ATLAS_ROWS = 16;
const cellIndex = (text: string) => NEON_CELLS.findIndex((c) => c.text === text);

function neonAtlas(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = ATLAS_ROWS * 128;
  const g = c.getContext("2d")!;
  NEON_CELLS.forEach((cell, i) => {
    const x = (i % 2) * 512, y = Math.floor(i / 2) * 128;
    g.fillStyle = cell.edge ?? cell.fg;
    g.fillRect(x, y, 512, 128);
    g.fillStyle = cell.bg;
    g.fillRect(x + 6, y + 6, 500, 116);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = cell.fg;
    g.shadowColor = cell.edge ?? cell.fg;
    g.shadowBlur = 14;
    let size = cell.sub ? 58 : 70;
    g.font = `900 ${size}px system-ui, sans-serif`;
    while (size > 20 && g.measureText(cell.text).width > 470) g.font = `900 ${--size}px system-ui, sans-serif`;
    g.fillText(cell.text, x + 256, y + (cell.sub ? 52 : 66));
    if (cell.sub) {
      g.shadowBlur = 0;
      g.font = "700 24px system-ui, sans-serif";
      g.fillText(cell.sub, x + 256, y + 100);
    }
    g.shadowBlur = 0;
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Yol tabelası dokusu: beyaz zemin, siyah çerçeve ve yazı; `cross` kırmızı çaprazla (yerleşim çıkışı). */
function placeSign(text: string, cross: boolean, sub?: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 384;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1b1b1b";
  g.fillRect(0, 0, 1024, 384);
  g.fillStyle = "#fbfbf6";
  g.fillRect(18, 18, 988, 348);
  g.fillStyle = "#151515";
  g.textAlign = "center";
  g.textBaseline = "middle";
  let size = 150;
  g.font = `900 ${size}px system-ui, sans-serif`;
  while (g.measureText(text).width > 900) g.font = `900 ${--size}px system-ui, sans-serif`;
  g.fillText(text, 512, sub ? 165 : 196);
  if (sub) {
    g.font = "700 54px system-ui, sans-serif";
    g.fillText(sub, 512, 300);
  }
  if (cross) {
    g.strokeStyle = "#d4111e";
    g.lineWidth = 46;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(70, 330);
    g.lineTo(954, 54);
    g.moveTo(70, 54);
    g.lineTo(954, 330);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Hız sınırı levhası (kırmızı halka) ya da mavi yön levhası. */
function roundSign(text: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.arc(128, 128, 124, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#d4111e";
  g.lineWidth = 30;
  g.beginPath();
  g.arc(128, 128, 104, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "#111";
  g.font = "900 104px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, 136);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Şehir kapısının kirişi: lacivert zemin, altın büyük yazı, beyaz alt yazı (gece parlar ama okunur). */
function gateSign(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 384;
  const g = c.getContext("2d")!;
  g.fillStyle = "#0d1b2a";
  g.fillRect(0, 0, 2048, 384);
  g.strokeStyle = "#d6aa3c";
  g.lineWidth = 10;
  g.strokeRect(14, 14, 2020, 356);
  g.textAlign = "center";
  g.textBaseline = "middle";
  const grad = g.createLinearGradient(0, 60, 0, 250);
  grad.addColorStop(0, "#fff1c4");
  grad.addColorStop(0.5, "#e9b949");
  grad.addColorStop(1, "#b9862c");
  g.fillStyle = grad;
  g.font = "900 190px system-ui, sans-serif";
  g.fillText("GAP ŞEHRİ", 1024, 160);
  g.fillStyle = "#dfe7f2";
  g.font = "700 78px system-ui, sans-serif";
  g.fillText("HOŞ GELDİNİZ", 1024, 312);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function blueSign(text: string, sub: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 1024, 512);
  g.fillStyle = "#1849a9";
  g.fillRect(14, 14, 996, 484);
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "900 130px system-ui, sans-serif";
  g.fillText(text, 512, 200);
  g.font = "800 80px system-ui, sans-serif";
  g.fillText(sub, 512, 380);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function city(b: Builder): City {
  const group = new THREE.Group();
  const glows: THREE.BufferGeometry[] = [];
  /** Gece yanan pencereler (gündüz görünmez). */
  const windows: THREE.BufferGeometry[] = [];
  /** Kırmızı ikaz lambaları (yanıp söner). */
  const beacons: THREE.BufferGeometry[] = [];
  /** Trafik ışıkları: [yatay cadde | dikey cadde][kırmızı, sarı, yeşil]. */
  const signals: THREE.BufferGeometry[][][] = [[[], [], []], [[], [], []]];
  const neon: THREE.BufferGeometry[] = [];
  /** Dükkân katlarının duvarları (gölge almaz: kulenin gölgesi içeriyi karartmasın; gece kendi ışığıyla aydınlık). */
  const walls: THREE.BufferGeometry[] = [];
  /** Dükkânların içi (dükkân başına): yalnızca kapıdan ve vitrinden görünür. */
  const shops: { geos: THREE.BufferGeometry[]; name: string; portal: Portal }[] = [];
  const rooms: Room[] = [];
  const npcs: CityNpc[] = [];
  const atlas = neonAtlas();
  const rand = b.rand;

  const solid = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, m: THREE.Matrix4, jitter = 0.04) => b.add(part(geo, color, m, jitter, rand));
  const box = (w: number, h: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, ry = 0, jitter = 0.04) =>
    solid(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry), jitter);
  const ibox = (w: number, h: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, ry = 0, jitter = 0.03) =>
    walls.push(part(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry), jitter, rand));
  const gbox = (w: number, h: number, d: number, color: string, x: number, y: number, z: number, ry = 0, into = glows) =>
    into.push(part(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry)));
  const cyl = (r0: number, r1: number, h: number, color: string, x: number, y: number, z: number, seg = 10) =>
    solid(new THREE.CylinderGeometry(r0, r1, h, seg), color, mat(x, y, z), 0.02);
  /** Dönmüş dikdörtgen (yerel x boyunca w, z boyunca d) için dört kenar duvarı. */
  const rectCollider = (x: number, z: number, w: number, d: number, ry = 0, top = Infinity) => {
    const c = Math.cos(ry), s = Math.sin(ry);
    const pt = (lx: number, lz: number): [number, number] => [x + lx * c + lz * s, z - lx * s + lz * c];
    const p = [pt(-w / 2, -d / 2), pt(w / 2, -d / 2), pt(w / 2, d / 2), pt(-w / 2, d / 2)];
    for (let i = 0; i < 4; i++) b.colliders.segment(p[i][0], p[i][1], p[(i + 1) % 4][0], p[(i + 1) % 4][1], 0.15, top);
  };
  /** Neon tabela (atlas hücresi): `at` düzlemin dönüşümü, plane +z'ye bakar. */
  const sign = (text: string, w: number, h: number, at: THREE.Matrix4) => {
    const cell = cellIndex(text);
    const g = new THREE.PlaneGeometry(w, h);
    const u0 = (cell % 2) * 0.5, v0 = 1 - (Math.floor(cell / 2) + 1) / ATLAS_ROWS;
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) / ATLAS_ROWS);
    g.applyMatrix4(at);
    neon.push(g);
  };
  /** Bir cephenin noktası: (cx, cz) merkezli, `ry` yönüne bakan yüz; o yüz boyunca t, dışarı doğru d. */
  const facePt = (cx: number, cz: number, ry: number, t: number, d: number): [number, number] => [
    cx + Math.cos(ry) * t + Math.sin(ry) * d,
    cz - Math.sin(ry) * t + Math.cos(ry) * d,
  ];
  /** Dört yüz: [ry, yüz genişliği, merkeze uzaklık]. */
  const faces = (w: number, d: number): [number, number, number][] => [[0, w, d / 2], [Math.PI, w, d / 2], [Math.PI / 2, d, w / 2], [-Math.PI / 2, d, w / 2]];

  /** Gece pencere ızgarası: bir yüze, kat başına ve sütun başına, rastgele yanan camlar. */
  const nightWindows = (cx: number, cz: number, w: number, d: number, y0: number, y1: number, floorH: number, colW: number, lit = 0.45) => {
    const warm = ["#ffd9a0", "#ffe7c2", "#fff3e0", "#cfe6ff", "#ffd38a"];
    for (const [ry, fw, off] of faces(w, d)) {
      const cols = Math.max(1, Math.floor(fw / colW));
      for (let y = y0 + floorH / 2; y < y1 - 0.5; y += floorH) {
        for (let k = 0; k < cols; k++) {
          if (rand() > lit) continue;
          const t = -fw / 2 + (k + 0.5) * (fw / cols);
          const [px, pz] = facePt(cx, cz, ry, t, off + 0.06);
          windows.push(part(new THREE.PlaneGeometry((fw / cols) * 0.78, floorH * 0.62), warm[Math.floor(rand() * warm.length)], mat(px, y, pz, ry)));
        }
      }
    }
  };

  // ==================================================================
  // Vadi yolu: asfalt şerit, banket, çizgiler, bariyerler, lambalar, tabelalar
  // ==================================================================
  const path = ROAD_PATH;
  const tangent = (i: number, pts = path): [number, number] => {
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    return [(c[0] - a[0]) / l, (c[1] - a[1]) / l];
  };
  /** Yolun iki kenar ofseti arasında şerit (o0 < o1; + sağ/güney tarafı). `pts`: hangi yol (otoban ya da köy yolu). */
  const ribbon = (i0: number, i1: number, o0: number, o1: number, y: number, color: string, jitter = 0.03, pts = path) => {
    const pos: number[] = [];
    for (let i = i0; i < i1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const [tax, taz] = tangent(i, pts), [tbx, tbz] = tangent(i + 1, pts);
      // Normal (sağa): (−tz, tx)
      const a0 = [ax - taz * o0, az + tax * o0], a1 = [ax - taz * o1, az + tax * o1];
      const b0 = [bx - tbz * o0, bz + tbx * o0], b1 = [bx - tbz * o1, bz + tbx * o1];
      pos.push(a0[0], y, a0[1], b0[0], y, b0[1], a1[0], y, a1[1], a1[0], y, a1[1], b0[0], y, b0[1], b1[0], y, b1[1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    // Yukarı bakan yüz: sarma yönü ters kaldıysa çevir
    const n = g.attributes.normal;
    if (n.count && n.getY(0) < 0) {
      for (let k = 0; k < pos.length; k += 9) for (let q = 0; q < 3; q++) [pos[k + 3 + q], pos[k + 6 + q]] = [pos[k + 6 + q], pos[k + 3 + q]];
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
    }
    solid(g, color, new THREE.Matrix4(), jitter);
  };
  // Asfalt şehrin kenarında biter (bulvarın asfaltıyla üst üste binip titremesin)
  const last = path.findIndex((p) => p[0] > CITY.minX - 1) - 1;
  for (let i = 0; i < path.length - 1; i++) b.clearSegment(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1], ROAD_WALK);
  ribbon(0, last, -ROAD_HALF - 1.4, ROAD_HALF + 1.4, Y_BASE, "#8f8878", 0.06);
  ribbon(0, last, -ROAD_HALF, ROAD_HALF, Y_ASPHALT, ASPHALT, 0.05);
  for (const s of [-1, 1]) ribbon(0, last, s > 0 ? ROAD_HALF - 0.38 : -ROAD_HALF + 0.2, s > 0 ? ROAD_HALF - 0.2 : -ROAD_HALF + 0.38, Y_ASPHALT + 0.004, LINE, 0);
  // Orta çizgi: kesikli sarı (köyün içinde ve şehrin girişinde de)
  for (let i = 0; i < last; i += 3) ribbon(i, Math.min(i + 1, last), -0.09, 0.09, Y_ASPHALT + 0.005, YELLOW, 0);
  {
    // Yolun ucundan bulvarın başına kadar (üst üste binmeden) asfalt ve banket
    const [ex, ez] = path[last], len = CITY.minX - ex;
    if (len > 0.01) {
      box(len, 0.03, ROAD_HALF * 2, ASPHALT, ex + len / 2, Y_ASPHALT - 0.015, ez, 0, 0.04);
    }
  }

  /** Yol üzerindeki i'nci noktanın sağ (s=1) ya da sol (s=−1) kenarından `o` uzaklıkta nokta ve yol yönü. */
  const sidePt = (i: number, s: number, o: number, pts = path) => {
    const [tx, tz] = tangent(i, pts);
    return { x: pts[i][0] - tz * o * s, z: pts[i][1] + tx * o * s, heading: Math.atan2(tx, tz) };
  };
  // Bariyerler (vadide, köy sınırından sonra): direkler ve galvaniz bariyer; üstünden atlanır
  const valley = path.findIndex((p) => p[0] > 132), valleyEnd = path.findIndex((p) => p[0] > CITY.minX - 10);
  for (const s of [-1, 1]) {
    for (let i = valley; i < valleyEnd - 1; i++) {
      const a = sidePt(i, s, ROAD_HALF + 1.2), c = sidePt(i + 1, s, ROAD_HALF + 1.2);
      const len = Math.hypot(c.x - a.x, c.z - a.z), ry = Math.atan2(-(c.z - a.z), c.x - a.x);
      box(len + 0.05, 0.28, 0.08, STEEL_LIGHT, (a.x + c.x) / 2, 0.68, (a.z + c.z) / 2, ry, 0.02);
      if (i % 2 === 0) box(0.12, 0.75, 0.12, STEEL, a.x, 0.37, a.z, ry, 0.02);
      if (i % 8 === 0) gbox(0.1, 0.1, 0.03, s > 0 ? "#ff8a2a" : "#ffffff", a.x, 0.82, a.z, ry);
      b.colliders.segment(a.x, a.z, c.x, c.z, 0.1, 0.8);
    }
  }
  // Otobanın nehir köprüsü: tabliyenin iki yanında beton kiriş ve korkuluk, altında ayaklar (yayalar
  // kaldırımından geçer; yürünürlük terrain.ts'te). Nehrin oyuğu boyunca, iki kıyının biraz ötesine dek.
  const overRiver = path.map((p) => riverDist(p[0], p[1]) < RIVER_SPAN);
  for (let i = 0; i < path.length - 1; i++) {
    if (!overRiver[i] && !overRiver[i + 1]) continue;
    for (const s of [-1, 1]) {
      const a = sidePt(i, s, ROAD_BRIDGE_HALF), c = sidePt(i + 1, s, ROAD_BRIDGE_HALF);
      const len = Math.hypot(c.x - a.x, c.z - a.z), ry = Math.atan2(-(c.z - a.z), c.x - a.x);
      const mx = (a.x + c.x) / 2, mz = (a.z + c.z) / 2;
      box(len + 0.05, 0.9, 0.35, CONCRETE_DARK, mx, -0.42, mz, ry, 0.03);
      box(len + 0.05, 0.12, 0.14, STEEL_LIGHT, mx, 1.0, mz, ry, 0.02);
      box(len + 0.05, 0.06, 0.06, STEEL_LIGHT, mx, 0.55, mz, ry, 0.02);
      if (i % 2 === 0) box(0.1, 1.0, 0.1, STEEL, a.x, 0.5, a.z, ry, 0.02);
      b.colliders.segment(a.x, a.z, c.x, c.z, 0.12);
    }
    if (i % 4 === 0) {
      const [px, pz] = path[i];
      box(ROAD_BRIDGE_HALF * 1.6, 2.2, 1.1, CONCRETE_DARK, px, -1.6, pz, sidePt(i, 1, 0).heading, 0.04);
    }
  }
  /** Modern sokak lambası: ince direk, yola uzanan kol, altı LED'li başlık (ampul gece ışığı verir). */
  const streetLamp = (x: number, z: number, toward: number, height = 6.4) => {
    cyl(0.09, 0.13, height, STEEL, x, height / 2, z, 8);
    const ax = Math.sin(toward), az = Math.cos(toward);
    box(1.7, 0.09, 0.09, STEEL, x + ax * 0.85, height - 0.05, z + az * 0.85, toward - Math.PI / 2, 0);
    const hx = x + ax * 1.7, hz = z + az * 1.7;
    box(0.75, 0.13, 0.32, "#2b2f35", hx, height - 0.12, hz, toward - Math.PI / 2, 0);
    gbox(0.6, 0.03, 0.24, "#fff4dc", hx, height - 0.2, hz, toward - Math.PI / 2);
    b.prop("bulb", mat(hx, height - 0.35, hz, 0, 0.6));
    b.colliders.circle(x, z, 0.16);
  };
  for (let i = 6, k = 0; i < last - 4; i += 15, k++) {
    if (overRiver[i]) continue; // köprüde lamba suya düşerdi
    const s = k % 2 ? 1 : -1, p = sidePt(i, s, ROAD_HALF + 2.2);
    if (villageRoadDist(p.x, p.z) < VILLAGE_ROAD_HALF + 1.5) continue; // köy yolunun ağzına düşmesin
    streetLamp(p.x, p.z, p.heading + (s > 0 ? -Math.PI / 2 : Math.PI / 2) + Math.PI);
  }
  // Mahallenin kuzey ve güney bağlantı yolları: otobanla aynı genişlik. Bağlandıkları yerde (otoban, köy yolu,
  // mahalle caddesi) asfaltları ayrı yükseklikte (titreşmesin); çizgiler ve lambalar kavşakların dışında.
  for (const r of LINK_ROADS) {
    const n = r.length - 1;
    for (let i = 0; i < n; i++) b.clearSegment(r[i][0], r[i][1], r[i + 1][0], r[i + 1][1], ROAD_WALK);
    ribbon(0, n, -ROAD_HALF - 1.4, ROAD_HALF + 1.4, Y_BASE - 0.003, "#8f8878", 0.06, r);
    ribbon(0, n, -ROAD_HALF, ROAD_HALF, Y_ASPHALT - 0.003, ASPHALT, 0.05, r);
    const free = (p: [number, number]) => polylineDist(ROAD_PATH, p[0], p[1]) > ROAD_HALF + 1.6 && !onHoodStreet(p[0], p[1], 2) && villageRoadDist(p[0], p[1]) > VILLAGE_ROAD_HALF + 1.6;
    const i0 = Math.max(0, r.findIndex(free)), i1 = r.length - 1 - Math.max(0, [...r].reverse().findIndex(free));
    for (const s of [-1, 1]) ribbon(i0, i1, s > 0 ? ROAD_HALF - 0.38 : -ROAD_HALF + 0.2, s > 0 ? ROAD_HALF - 0.2 : -ROAD_HALF + 0.38, Y_ASPHALT + 0.001, LINE, 0, r);
    for (let i = i0; i < i1; i += 3) ribbon(i, Math.min(i + 1, i1), -0.09, 0.09, Y_ASPHALT + 0.002, YELLOW, 0, r);
    for (let i = i0 + 4, k = 0; i < i1 - 2; i += 15, k++) {
      const s = k % 2 ? 1 : -1, p = sidePt(i, s, ROAD_HALF + 2.2, r);
      if (onAsphalt(p.x, p.z, 0.5)) continue;
      streetLamp(p.x, p.z, p.heading + (s > 0 ? -Math.PI / 2 : Math.PI / 2) + Math.PI);
    }
  }
  // Köy yolları: otobandan ayrılan dar asfalt. Kavşakta otobanın asfaltının biraz altında kalır (aynı
  // yükseklikte iki yüzey titreşir); kenar ve orta çizgiler otobanın dışında başlar, uçta yuvarlak dönüş yeri.
  for (const r of VILLAGE_ROADS) {
    const n = r.length - 1, H = VILLAGE_ROAD_HALF;
    for (let i = 0; i < n; i++) b.clearSegment(r[i][0], r[i][1], r[i + 1][0], r[i + 1][1], H + 3);
    ribbon(0, n, -H - 1, H + 1, Y_BASE - 0.006, "#8f8878", 0.06, r);
    ribbon(0, n, -H, H, Y_ASPHALT - 0.006, ASPHALT, 0.05, r);
    const start = Math.max(0, r.findIndex((p) => roadDist(p[0], p[1]) > ROAD_HALF + 1.6));
    for (const s of [-1, 1]) ribbon(start, n, s > 0 ? H - 0.32 : -H + 0.18, s > 0 ? H - 0.18 : -H + 0.32, Y_ASPHALT - 0.002, LINE, 0, r);
    for (let i = start; i < n; i += 3) ribbon(i, Math.min(i + 1, n), -0.08, 0.08, Y_ASPHALT - 0.001, YELLOW, 0, r);
    const [ex, ez] = r[n];
    solid(new THREE.CircleGeometry(H + 1, 24).rotateX(-Math.PI / 2), "#8f8878", mat(ex, Y_BASE - 0.008, ez), 0.04);
    solid(new THREE.CircleGeometry(H, 24).rotateX(-Math.PI / 2), ASPHALT, mat(ex, Y_ASPHALT - 0.008, ez), 0.04);
    for (let i = start + 3, k = 0; i < n - 1; i += 8, k++) {
      const s = k % 2 ? 1 : -1, p = sidePt(i, s, H + 1.8, r);
      streetLamp(p.x, p.z, p.heading + (s > 0 ? -Math.PI / 2 : Math.PI / 2) + Math.PI, 5.2);
    }
  }
  // Mahalle (dağın ardı): kıvrımlı bulvarlar, doğu caddesi ve park döngüsü; iki yanda kaldırım, kesikli orta
  // çizgi, ağaç sıraları ve lambalar. Girişte göbekli kavşak (adası çimen, ortasında çınar), batıda göletli park.
  // Her cadde bir öncekinden biraz yüksekte: kesiştikleri yerde iki yüzey aynı yükseklikte titreşmesin.
  {
    const H = HOOD_STREET_HALF, W = H + HOOD_SIDEWALK;
    HOOD_ROADS.forEach((r, k) => {
      const n = r.length - 1, y = 0.016 + k * 0.0012;
      ribbon(0, n, -W, W, y, CONCRETE, 0.03, r);
      ribbon(0, n, -H, H, y + 0.008, ASPHALT, 0.04, r);
      // Kesişmelerde ve kavşakta çizgi yok
      const others = (x: number, z: number) => HOOD_ROADS.some((o, m) => m !== k && polylineDist(o, x, z) < W + 1) || Math.hypot(x - HOOD_ROUNDABOUT.x, z - HOOD_ROUNDABOUT.z) < HOOD_ROUNDABOUT.r + 2;
      for (let i = 0; i < n; i += 2) if (!others(r[i][0], r[i][1]) && !others(r[i + 1][0], r[i + 1][1])) ribbon(i, i + 1, -0.08, 0.08, y + 0.009, YELLOW, 0, r);
      // Kenar çizgileri (gece yolun nerede bittiği seçilsin); kesişmelerde ve kavşakta kesilir
      for (let i = 0; i < n; i++) {
        if (others(r[i][0], r[i][1]) || others(r[i + 1][0], r[i + 1][1])) continue;
        for (const sd of [-1, 1]) ribbon(i, i + 1, sd > 0 ? H - 0.3 : -H + 0.16, sd > 0 ? H - 0.16 : -H + 0.3, y + 0.009, LINE, 0, r);
      }
      // Lambalar kaldırımda (kolu yola uzanır); ağaçlar kaldırımın dışındaki çimenlikte, tepeleri asfalta
      // taşmasın diye hiçbir yolun 2,5 m yakınına ve arsaların içine dikilmez (yer yoksa ağaç yok)
      for (let i = 3, t = 0; i < n - 2; i += 6, t++) {
        const s = t % 2 ? 1 : -1;
        if (t % 3 === 2) {
          const p = sidePt(i, s, H + 1.25, r);
          if (others(p.x, p.z) || onAsphalt(p.x, p.z, 0.5)) continue;
          streetLamp(p.x, p.z, p.heading + (s > 0 ? -Math.PI / 2 : Math.PI / 2) + Math.PI, 5.2);
          continue;
        }
        const p = sidePt(i, s, W + 1.9, r);
        const inPlot = PLOTS.some((q) => p.x > q.x0 - 2 && p.x < q.x0 + q.size + 2 && p.z > q.z0 - 2 && p.z < q.z0 + q.size + 2);
        if (inPlot || onAsphalt(p.x, p.z, 2.5) || others(p.x, p.z)) continue;
        b.prop(rand() > 0.25 ? "oak" : "sakura", mat(p.x, 0, p.z, rand() * 6, 0.6 + rand() * 0.15));
        b.colliders.circle(p.x, p.z, 0.28);
      }
    });
    // Orta bulvarın batı ucu: parkın girişinde dönüş yeri
    const mid = HOOD_ROADS[1], [ex, ez] = mid[mid.length - 1];
    solid(new THREE.CircleGeometry(W, 28).rotateX(-Math.PI / 2), CONCRETE, mat(ex, 0.03, ez), 0.03);
    solid(new THREE.CircleGeometry(H + 1, 28).rotateX(-Math.PI / 2), ASPHALT, mat(ex, 0.038, ez), 0.04);
    // Göbekli kavşak
    const R = HOOD_ROUNDABOUT;
    solid(new THREE.CircleGeometry(R.r + HOOD_SIDEWALK, 40).rotateX(-Math.PI / 2), CONCRETE, mat(R.x, 0.04, R.z), 0.03);
    solid(new THREE.CircleGeometry(R.r, 40).rotateX(-Math.PI / 2), ASPHALT, mat(R.x, 0.046, R.z), 0.04);
    solid(new THREE.RingGeometry(R.island, R.island + 0.35, 40).rotateX(-Math.PI / 2), "#f4f4f0", mat(R.x, 0.05, R.z), 0);
    solid(new THREE.CylinderGeometry(R.island, R.island, 0.22, 40), "#6f9a4a", mat(R.x, 0.11, R.z), 0.05);
    b.prop("oak", mat(R.x, 0.2, R.z, 0.6, 1.5));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      b.prop("bush", mat(R.x + Math.cos(a) * (R.island - 1.2), 0.3, R.z + Math.sin(a) * (R.island - 1.2), a, 0.8, 0.6, 0.8));
    }
    b.colliders.circle(R.x, R.z, R.island);
    // Göletli park: su, kıyı taşları, çevresinde ağaçlar (batı döngüsünün içi)
    const P = HOOD_PARK;
    solid(new THREE.CircleGeometry(P.pond + 1.6, 40).rotateX(-Math.PI / 2), "#b9ad8c", mat(P.x, 0.02, P.z), 0.05);
    solid(new THREE.CircleGeometry(P.pond, 40).rotateX(-Math.PI / 2), "#4f8fc4", mat(P.x, 0.03, P.z), 0.03);
    for (let k = 0; k < 22; k++) {
      const a = (k / 22) * Math.PI * 2 + rand() * 0.2, rr = P.pond + 0.6 + rand() * 0.6, sz = 0.5 + rand() * 0.6;
      b.prop("rock", mat(P.x + Math.cos(a) * rr, 0.1, P.z + Math.sin(a) * rr, rand() * 6, sz, sz * 0.6, sz));
    }
    b.colliders.circle(P.x, P.z, P.pond);
    // Göletin çevresinde alçak park lambaları (gece yürüyüş yolu aydınlık)
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.2, lx = P.x + Math.cos(a) * (P.pond + 5), lz = P.z + Math.sin(a) * (P.pond + 5);
      b.prop("post", mat(lx, 0, lz));
      b.prop("bulb", mat(lx, 2.7, lz));
      b.colliders.circle(lx, lz, 0.15);
    }
    for (let k = 0, placed = 0; placed < 40 && k < 400; k++) {
      const x = P.x - 36 + rand() * 72, z = P.z - 78 + rand() * 156;
      if (Math.hypot(x - P.x, z - P.z) < P.pond + 7 || onAsphalt(x, z, 3) || x > -548) continue; // gölet, lambaları ve yolu
      // Döngünün içinde kalsın: o hizadaki döngünün batı kenarının doğusunda
      const west = Math.min(...HOOD_ROADS[4].filter(([, pz]) => Math.abs(pz - z) < 4).map(([px]) => px));
      if (!(x > west + 6)) continue;
      b.prop(rand() > 0.4 ? "oak" : "pine", mat(x, 0, z, rand() * 6, 0.8 + rand() * 0.6));
      b.colliders.circle(x, z, 0.35);
      placed++;
    }
  }
  // Reflektörlü kenar direkleri
  for (let i = valley; i < valleyEnd; i += 5) {
    for (const s of [-1, 1]) {
      const p = sidePt(i, s, ROAD_HALF + 2.0);
      box(0.12, 1.0, 0.12, "#f4f4f0", p.x, 0.5, p.z, p.heading, 0);
      box(0.13, 0.2, 0.13, "#151515", p.x, 0.88, p.z, p.heading, 0);
    }
  }

  // Tabelalar: yerleşim tabelası (bir yüzü giriş, arkası çıkış), hız sınırı, yön levhası
  const signMats: THREE.Material[] = [];
  const signBoard = (x: number, z: number, ry: number, front: THREE.Texture, back: THREE.Texture | null, w = 3.2, h = 1.2, y = 2.3) => {
    // Direkler panonun iki yanında (içinden geçmez); pano üst ve alttan kelepçeyle direklere tutturulur
    const ux = Math.cos(ry), uz = -Math.sin(ry), off = w / 2 + 0.05 + 0.07;
    for (const s of [-1, 1]) {
      const px = x + ux * s * off, pz = z + uz * s * off;
      cyl(0.06, 0.06, y + h / 2 + 0.08, STEEL_LIGHT, px, (y + h / 2 + 0.08) / 2, pz, 8);
      cyl(0.075, 0.075, 0.03, STEEL_LIGHT, px, y + h / 2 + 0.095, pz, 8);
      for (const dy of [-h / 2 + 0.12, h / 2 - 0.12]) box(0.16, 0.06, 0.05, STEEL_LIGHT, x + ux * s * (w / 2 + 0.1), y + dy, z + uz * s * (w / 2 + 0.1), ry, 0);
    }
    box(w + 0.1, h + 0.1, 0.06, "#2a2a2a", x, y, z, ry, 0);
    for (const [tex, flip] of [[front, 0], [back, Math.PI]] as const) {
      if (!tex) continue;
      const m = new THREE.MeshLambertMaterial({ map: tex, emissive: "#3a3a3a", emissiveMap: tex });
      signMats.push(m);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
      const nx = Math.sin(ry + flip) * 0.035, nz = Math.cos(ry + flip) * 0.035;
      plane.position.set(x + nx, y, z + nz);
      plane.rotation.y = ry + flip;
      group.add(plane);
    }
    for (const s of [-1, 1]) b.colliders.circle(x + ux * s * off, z + uz * s * off, 0.12);
  };
  // Köy çıkışı: doğuya gidenin sağında; ön yüz köyden çıkana (batıya bakar), arka yüz köye girene
  {
    const i = path.findIndex((p) => p[0] > 127);
    const p = sidePt(i, 1, ROAD_HALF + 3.4);
    signBoard(p.x, p.z, p.heading + Math.PI, placeSign("GAP KÖYÜ", true), placeSign("GAP KÖYÜ", false, "Hoş geldiniz"));
    const q = sidePt(i + 10, 1, ROAD_HALF + 3.4);
    signBoard(q.x, q.z, q.heading + Math.PI, roundSign("50"), null, 0.9, 0.9, 2.2);
    const r = sidePt(i + 26, 1, ROAD_HALF + 3.6);
    signBoard(r.x, r.z, r.heading + Math.PI, blueSign("GAP ŞEHRİ →", "250 m · CASINO"), null, 2.8, 1.4, 2.6);
    // Köye dönene: köy tarafına doğru mavi levha
    const t = sidePt(i + 6, -1, ROAD_HALF + 3.4);
    signBoard(t.x, t.z, t.heading, blueSign("← GAP KÖYÜ", "Kahvehane · Sinema"), null, 2.8, 1.4, 2.6);
  }
  // Şehir girişi: ön yüz gelene (batıya bakar), arka yüz şehirden çıkana (çarpılı)
  {
    const i = path.findIndex((p) => p[0] > CITY.minX - 14);
    const p = sidePt(i, 1, ROAD_HALF + 3.4);
    signBoard(p.x, p.z, p.heading + Math.PI, placeSign("GAP ŞEHRİ", false, "Nüfus: herkes"), placeSign("GAP ŞEHRİ", true));
  }

  // ==================================================================
  // Şehir zemini ve caddeler
  // ==================================================================
  const CX = (CITY.minX + CITY.maxX) / 2, CZ = (CITY.minZ + CITY.maxZ) / 2;
  b.clearBox(CITY.minX - 1, CITY.maxX + 1, CITY.minZ - 1, CITY.maxZ + 1);
  box(CITY.maxX - CITY.minX + 2, 0.04, CITY.maxZ - CITY.minZ + 2, CONCRETE, CX, Y_BASE - 0.02, CZ, 0, 0.02);
  // Beton plakaların derzleri (6 m)
  for (let x = CITY.minX + 6; x < CITY.maxX; x += 6) box(0.05, 0.01, CITY.maxZ - CITY.minZ, "#aaa69d", x, Y_BASE + 0.001, CZ, 0, 0);
  for (let z = CITY.minZ + 6; z < CITY.maxZ; z += 6) box(CITY.maxX - CITY.minX, 0.01, 0.05, "#aaa69d", CX, Y_BASE + 0.001, z, 0, 0);

  const horiz = (s: Street) => s.az === s.bz;
  /** Caddenin başı/sonu ve diğer caddelerle kesiştiği yerler (kendi ekseni boyunca). */
  const crossings = (s: Street, asphalt = false): { at: number; half: number }[] => {
    const out: { at: number; half: number }[] = [];
    for (const o of STREETS) {
      if (o === s || horiz(o) === horiz(s)) continue;
      if (horiz(s)) {
        if (o.ax >= Math.min(s.ax, s.bx) && o.ax <= Math.max(s.ax, s.bx) && s.az >= Math.min(o.az, o.bz) - 0.01 && s.az <= Math.max(o.az, o.bz) + 0.01) out.push({ at: o.ax, half: asphalt ? o.half : o.half + o.walk });
      } else if (o.az >= Math.min(s.az, s.bz) && o.az <= Math.max(s.az, s.bz) && s.ax >= Math.min(o.ax, o.bx) - 0.01 && s.ax <= Math.max(o.ax, o.bx) + 0.01) out.push({ at: o.az, half: asphalt ? o.half : o.half + o.walk });
    }
    return out.sort((a, c) => a.at - c.at);
  };
  /** Kesişimler dışındaki aralıklar [a, b] (caddenin ekseni boyunca). */
  const spans = (s: Street, pad: number, asphalt = false): [number, number][] => {
    const a0 = horiz(s) ? Math.min(s.ax, s.bx) : Math.min(s.az, s.bz), a1 = horiz(s) ? Math.max(s.ax, s.bx) : Math.max(s.az, s.bz);
    const out: [number, number][] = [];
    let at = a0;
    for (const c of crossings(s, asphalt)) {
      if (c.at - c.half - pad > at) out.push([at, c.at - c.half - pad]);
      at = Math.max(at, c.at + c.half + pad);
    }
    if (a1 > at) out.push([at, a1]);
    return out;
  };
  /** Caddenin yerel koordinatından dünyaya: u eksen boyunca, v yana (+ güney/doğu). */
  const sp = (s: Street, u: number, v: number): [number, number] => (horiz(s) ? [u, s.az + v] : [s.ax + v, u]);
  const sbox = (s: Street, u0: number, u1: number, v: number, wv: number, h: number, y: number, color: string, jitter = 0.03) => {
    const [x, z] = sp(s, (u0 + u1) / 2, v);
    if (horiz(s)) box(u1 - u0, h, wv, color, x, y, z, 0, jitter);
    else box(wv, h, u1 - u0, color, x, y, z, 0, jitter);
  };

  const intersections: { x: number; z: number; h: Street; v: Street }[] = [];
  for (const s of STREETS) {
    // Kavşakta asfaltı yatay cadde taşır; dikey cadde orada kesilir (iki asfalt üst üste binip titremesin)
    const L0 = horiz(s) ? Math.min(s.ax, s.bx) : Math.min(s.az, s.bz), L1 = horiz(s) ? Math.max(s.ax, s.bx) : Math.max(s.az, s.bz);
    for (const [u0, u1] of horiz(s) ? [[L0, L1] as [number, number]] : spans(s, 0, true)) {
      sbox(s, u0, u1, 0, s.half * 2, 0.03, Y_ASPHALT - 0.015, s === STREETS[0] ? ASPHALT_DARK : ASPHALT, 0.04);
    }
    for (const c of crossings(s)) if (horiz(s)) intersections.push({ x: c.at, z: s.az, h: s, v: STREETS.find((o) => !horiz(o) && o.ax === c.at)! });
    // Kaldırımlar ve bordür taşları (kesişimlerde açık)
    for (const [u0, u1] of spans(s, 0)) {
      for (const side of [-1, 1]) {
        sbox(s, u0, u1, side * (s.half + s.walk / 2), s.walk, 0.06, Y_WALK - 0.03, SIDEWALK);
        sbox(s, u0, u1, side * (s.half + 0.12), 0.24, 0.1, Y_WALK - 0.03, CURB, 0.01);
      }
    }
    // Şerit çizgileri
    for (const [u0, u1] of spans(s, 4)) {
      for (const side of [-1, 1]) sbox(s, u0, u1, side * (s.half - 0.3), 0.15, 0.01, Y_ASPHALT + 0.003, LINE, 0);
      if (s === STREETS[0]) {
        // Bulvar: ortada refüj (çiçekli, üstüne çıkılır), iki yanında kesik şerit çizgisi
        sbox(s, u0, u1, 0, 1.8, 0.16, 0.08, "#b9b4aa", 0.02);
        sbox(s, u0 + 0.3, u1 - 0.3, 0, 1.4, 0.04, 0.17, "#5c8a3e", 0.08);
        b.colliders.segment(...sp(s, u0, 0), ...sp(s, u1, 0), 0.9, 0.17);
        for (const side of [-1, 1]) for (let u = u0 + 1; u < u1 - 2; u += 6) sbox(s, u, u + 3, side * 3.9, 0.14, 0.01, Y_ASPHALT + 0.003, LINE, 0);
      } else {
        for (let u = u0 + 1; u < u1 - 2; u += 6) sbox(s, u, u + 3, 0, 0.14, 0.01, Y_ASPHALT + 0.003, LINE, 0);
      }
    }
  }
  // Yaya geçitleri: her kesişimin dört kolunda zebra
  for (const it of intersections) {
    for (const [s, other] of [[it.h, it.v], [it.v, it.h]] as const) {
      const at = horiz(s) ? it.x : it.z;
      const lo = horiz(s) ? Math.min(s.ax, s.bx) : Math.min(s.az, s.bz), hi = horiz(s) ? Math.max(s.ax, s.bx) : Math.max(s.az, s.bz);
      for (const dir of [-1, 1]) {
        const u = at + dir * (other.half + other.walk + 1.6);
        if (u < lo + 1 || u > hi - 1) continue;
        for (let v = -s.half + 0.6; v < s.half - 0.4; v += 1.1) {
          const [x, z] = sp(s, u, v);
          if (horiz(s)) box(2.6, 0.01, 0.55, LINE, x, Y_ASPHALT + 0.004, z, 0, 0);
          else box(0.55, 0.01, 2.6, LINE, x, Y_ASPHALT + 0.004, z, 0, 0);
        }
        // Dur çizgisi
        const [x, z] = sp(s, u + dir * 2.0, 0);
        if (horiz(s)) box(0.3, 0.01, s.half * 2 - 0.8, LINE, x, Y_ASPHALT + 0.004, z, 0, 0);
        else box(s.half * 2 - 0.8, 0.01, 0.3, LINE, x, Y_ASPHALT + 0.004, z, 0, 0);
      }
    }
  }
  // Trafik lambaları: kesişimin iki köşesinde direk; her direkte iki yöne bakan sinyal kafası
  const signalHead = (x: number, y: number, z: number, ry: number, dirGroup: 0 | 1) => {
    box(0.42, 1.25, 0.3, "#1c1e22", x, y, z, ry, 0);
    const [fx, fz] = [Math.sin(ry) * 0.16, Math.cos(ry) * 0.16];
    ["#ff2a2a", "#ffbe1a", "#2aff7a"].forEach((c, k) => {
      const ly = y + 0.38 - k * 0.38;
      box(0.26, 0.26, 0.04, "#2a2d33", x + fx * 0.9, ly, z + fz * 0.9, ry, 0);
      signals[dirGroup][k].push(part(new THREE.CylinderGeometry(0.11, 0.11, 0.03, 12).rotateX(Math.PI / 2), c, mat(x + fx, ly, z + fz, ry)));
    });
  };
  for (const it of intersections) {
    const hx = it.v.half + 1.4, hz = it.h.half + 1.4;
    for (const [sx, sz] of [[1, -1], [-1, 1]]) {
      const px = it.x + sx * hx, pz = it.z + sz * hz;
      if (px < CITY.minX + 1 || pz > CITY.maxZ - 1) continue;
      cyl(0.1, 0.12, 5.2, STEEL, px, 2.6, pz, 8);
      box(0.12, 0.12, 2.6, STEEL, px, 5.1, pz - sz * 1.3, 0, 0);
      box(2.6, 0.12, 0.12, STEEL, px - sx * 1.3, 5.1, pz, 0, 0);
      // Yatay caddedeki sürücüye (x boyunca gelene) ve dikeydekine bakan kafalar
      signalHead(px - sx * 2.4, 4.5, pz, sx > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
      signalHead(px, 4.5, pz - sz * 2.4, sz > 0 ? 0 : Math.PI, 1);
      signalHead(px, 2.6, pz, sx > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
      b.colliders.circle(px, pz, 0.18);
    }
  }
  // Sokak lambaları ve kaldırım ağaçları (durak gibi yerlerin çevresi boş kalır)
  const BUS = { x: 404 + CITY_DX, z: BOULEVARD_Z + STREETS[0].half + STREETS[0].walk - 0.9 };
  // Durak ve GAP Garaj'ın kepenk önü boş kalır (lamba, ağaç dikilmez)
  const keepClear: [number, number, number][] = [[BUS.x, BUS.z, 5], [GARAGE.x + GARAGE.w / 2 + 2, GARAGE.z, 7]];
  const clearOf = (x: number, z: number) => keepClear.every(([cx, cz, r]) => Math.hypot(x - cx, z - cz) > r);
  for (const s of STREETS) {
    for (const [u0, u1] of spans(s, 2)) {
      let k = 0;
      for (let u = u0 + 4; u < u1 - 3; u += 11, k++) {
        for (const side of [-1, 1]) {
          const v = side * (s.half + 0.7);
          const [x, z] = sp(s, u + (side > 0 ? 5 : 0), v);
          if (k % 2 === 0) {
            if (clearOf(x, z)) streetLamp(x, z, horiz(s) ? (side > 0 ? Math.PI : 0) : side > 0 ? -Math.PI / 2 : Math.PI / 2, s === STREETS[0] ? 7.2 : 6.2);
          } else {
            const [tx, tz] = sp(s, u + (side > 0 ? 5 : 0), side * (s.half + s.walk - 1.1));
            if ((Math.abs(tx - CASINO.x) < 22 && tz < BOULEVARD_Z) || !clearOf(tx, tz)) continue;
            box(1.4, 0.03, 1.4, "#5a4632", tx, Y_WALK + 0.005, tz, 0, 0.05);
            b.prop(rand() > 0.3 ? "oak" : "sakura", mat(tx, 0, tz, rand() * 6, 0.75 + rand() * 0.25));
            b.colliders.circle(tx, tz, 0.3);
          }
        }
      }
    }
  }
  // Bulvarın refüjünde lambalar ve ağaçlar
  {
    const s = STREETS[0];
    for (const [u0, u1] of spans(s, 4)) {
      for (let u = u0 + 5, k = 0; u < u1 - 3; u += 9, k++) {
        const [x, z] = sp(s, u, 0);
        if (k % 2) {
          cyl(0.1, 0.13, 7.6, STEEL, x, 3.8, z, 8);
          for (const d of [-1, 1]) {
            box(0.09, 0.09, 2.0, STEEL, x, 7.55, z + d * 1.0, 0, 0);
            box(0.32, 0.13, 0.75, "#2b2f35", x, 7.45, z + d * 2.0, 0, 0);
            gbox(0.24, 0.03, 0.6, "#fff4dc", x, 7.37, z + d * 2.0);
            b.prop("bulb", mat(x, 7.15, z + d * 2.0, 0, 0.6));
          }
          b.colliders.circle(x, z, 0.16);
        } else {
          b.prop("oak", mat(x, 0.17, z, rand() * 6, 0.8));
          b.colliders.circle(x, z, 0.3);
        }
      }
    }
  }

  // ==================================================================
  // Şehir kapısı: bulvarın başında iki beyaz pilon ve üstlerinde LED'li kiriş
  // ==================================================================
  {
    const gx = CITY.minX + 6, half = STREETS[0].half + STREETS[0].walk + 1.5;
    for (const s of [-1, 1]) {
      const z = BOULEVARD_Z + s * half;
      box(1.6, 11, 1.6, "#f3f1ec", gx, 5.5, z, 0, 0.02);
      box(1.7, 0.25, 1.7, GOLD, gx, 11.1, z, 0, 0);
      gbox(0.08, 10, 0.08, "#fff1cf", gx - 0.82, 5.5, z, 0);
      gbox(0.08, 10, 0.08, "#fff1cf", gx + 0.82, 5.5, z, 0);
      b.colliders.circle(gx, z, 1.05);
    }
    box(0.9, 1.6, half * 2, "#f3f1ec", gx, 10.4, BOULEVARD_Z, 0, 0.02);
    for (const s of [-1, 1]) {
      gbox(0.04, 0.06, half * 2, "#ffd36b", gx + s * 0.47, 9.7, BOULEVARD_Z);
      gbox(0.04, 0.06, half * 2, "#ffd36b", gx + s * 0.47, 11.1, BOULEVARD_Z);
    }
    const tex = gateSign();
    for (const flip of [-1, 1]) {
      const m = new THREE.MeshBasicMaterial({ map: tex, color: "#d8d8d8" });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 1.4), m);
      plane.position.set(gx + flip * 0.47, 10.4, BOULEVARD_Z);
      plane.rotation.y = flip * (Math.PI / 2);
      group.add(plane);
    }
  }

  // ==================================================================
  // Binalar
  // ==================================================================
  /** Şeffaf camlar (vitrinler, dolap kapakları): ayrı, saydam mesh. */
  const glassGeos: THREE.BufferGeometry[] = [];
  const kit: Kit = {
    rand,
    geo: (g, color, m, jitter = 0.02) => shops[shops.length - 1].geos.push(part(g, color, m, jitter, rand)),
    glowGeo: (g, color, m) => glows.push(part(g, color, m)),
    glassGeo: (g, m) => glassGeos.push(part(g, "#c4dce8", m)),
    sign: (text, w, h, m) => sign(text, w, h, m),
    seat: (x, z, rot, h) => b.seats.push({ x, z, rot, h }),
    wall: (ax, az, bx, bz, r, top) => b.colliders.segment(ax, az, bx, bz, r, top),
    prop: (kind, m) => b.prop(kind, m),
    npc: (n) => npcs.push(n),
  };
  /** Dükkânı döşer ve odayı (personel bölmesinin önüne) daraltır. */
  const fit = (shop: string, x: number, z: number, w: number, d: number, h: number, face: number) => {
    const r = furnish(kit, shop, x, z, w - 2 * WALL_T, d - 2 * WALL_T, h, face);
    if (r) Object.assign(rooms[rooms.length - 1], r);
  };

  /**
   * Giriş katı: vitrin camı, beyaz lento, kapı saçağı ve dükkân tabelası (`face` yüzünde). Tabelası bir dükkânsa içi
   * girilebilir: o zaman katın kutusunu döndürür (üstündeki kütlenin örtücüsü içeriden bakınca örtmez).
   */
  const podium = (x: number, z: number, w: number, d: number, h: number, color: string, face: number, shop?: string, canopy = true): OccluderBox["room"] => {
    const side = Math.abs(Math.sin(face)) > 0.5;
    const fw = side ? d : w, off = side ? w / 2 : d / 2;
    if (canopy) {
      const [cx2, cz2] = facePt(x, z, face, 0, off + 1.2);
      box(Math.min(fw - 2, 8), 0.2, 2.4, "#e9e7e1", cx2, Math.min(h * 0.68, DOOR_H + 0.45), cz2, face, 0.02);
      gbox(Math.min(fw - 2, 8) - 0.4, 0.03, 2.0, "#fff4dc", cx2, Math.min(h * 0.68, DOOR_H + 0.45) - 0.11, cz2, face);
    }
    if (shop) {
      // Tabela: cephe bandının üstünde, kendi koyu panosunun önünde (hiçbir şeyle iç içe değil)
      const bandTop = h * 0.72 + 0.2, sh = Math.min((fw - 1) / 4, h - bandTop - 0.1), y = bandTop + 0.02 + sh / 2;
      const [px, pz] = facePt(x, z, face, 0, off + 0.1);
      box(sh * 4 + 0.16, sh + 0.12, 0.08, "#1d1f24", px, y, pz, face, 0);
      const [sx, sz] = facePt(x, z, face, 0, off + 0.16);
      sign(shop, sh * 4, sh, mat(sx, y, sz, face));
    }
    if (shop && SHOPS[shop]) {
      const room = shell(x, z, w, d, h, color, face, shop);
      fit(shop, x, z, w, d, h, face);
      return room;
    }
    box(w, h, d, color, x, h / 2, z, 0, 0.03);
    b.occluder(x, z, w, d, 0, h);
    box(w + 0.06, h * 0.62, d + 0.06, "#2b3a48", x, h * 0.36, z, 0, 0.02);
    box(w + 0.1, 0.35, d + 0.1, "#eeece6", x, h * 0.72, z, 0, 0.02);
    rectCollider(x, z, w, d);
    return undefined;
  };

  /**
   * İçi boş giriş katı: dört duvar (önde kapı boşluğu), dışta vitrin camı, tavan ve tavan ışıkları. Duvarlar
   * opak, içerisi yalnızca ön cepheden görünür: kat, kendisiyle kesişmeyenler için örtücü; iç mekânın portalı ön yüz.
   */
  const shell = (x: number, z: number, w: number, d: number, h: number, color: string, face: number, name: string) => {
    const nx = Math.round(Math.sin(face)), nz = Math.round(Math.cos(face));
    const fo = nx ? w / 2 : d / 2;
    const fx = x + nx * (fo + 0.05), fz = z + nz * (fo + 0.05);
    shops.push({
      geos: [],
      name,
      portal: {
        room: new THREE.Box3(new THREE.Vector3(x - w / 2, -1, z - d / 2), new THREE.Vector3(x + w / 2, h, z + d / 2)),
        face: new THREE.Box3(new THREE.Vector3(fx - (nx ? 0.05 : w / 2), 0, fz - (nz ? 0.05 : d / 2)), new THREE.Vector3(fx + (nx ? 0.05 : w / 2), h, fz + (nz ? 0.05 : d / 2))),
        nx,
        nz,
        px: x + nx * fo,
        pz: z + nz * fo,
      },
    });
    const room: OccluderBox["room"] = { min: [x - w / 2, 0, z - d / 2], max: [x + w / 2, h, z + d / 2] };
    b.occluder(x, z, w, d, 0, h, { hull: true });
    for (const [ry, fw, off] of faces(w, d)) {
      const front = Math.abs(Math.sin(ry - face)) < 0.01 && Math.cos(ry - face) > 0;
      const segs: [number, number][] = front ? [[-fw / 2, -DOOR_W / 2], [DOOR_W / 2, fw / 2]] : [[-fw / 2, fw / 2]];
      for (const [t0, t1] of segs) {
        const [cx, cz] = facePt(x, z, ry, (t0 + t1) / 2, off - WALL_T / 2);
        const gw = t1 - t0 - 0.7, top = h * 0.62;
        if (front && gw > 0.5) {
          // Vitrin: iki uçta pervaz, altta denizlik, üstte alınlık; arası şeffaf cam ve ince kayıtlar
          const mid = (t0 + t1) / 2;
          for (const [a, b2] of [[t0, t0 + 0.35], [t1 - 0.35, t1]]) {
            const [px, pz] = facePt(x, z, ry, (a + b2) / 2, off - WALL_T / 2);
            ibox(0.35, h, WALL_T, color, px, h / 2, pz, ry);
          }
          ibox(gw, 0.6, WALL_T, color, cx, 0.3, cz, ry);
          ibox(gw, h - top, WALL_T, color, cx, top + (h - top) / 2, cz, ry);
          const [gx, gz] = facePt(x, z, ry, mid, off - WALL_T / 2);
          glassGeos.push(part(new THREE.BoxGeometry(gw, top - 0.6, 0.03), "#c4dce8", mat(gx, 0.6 + (top - 0.6) / 2, gz, ry)));
          const n = Math.max(1, Math.round(gw / 2));
          for (let k = 0; k <= n; k++) {
            const [mx, mz] = facePt(x, z, ry, t0 + 0.35 + (k * gw) / n, off - WALL_T / 2);
            ibox(0.06, top - 0.6, WALL_T + 0.04, STEEL, mx, 0.6 + (top - 0.6) / 2, mz, ry, 0);
          }
          for (const y of [0.6, top]) ibox(gw, 0.06, WALL_T + 0.06, STEEL, cx, y, cz, ry, 0);
          const [sx2, sz2] = facePt(x, z, ry, mid, off - WALL_T - 0.1);
          ibox(gw, 0.05, 0.25, "#d8d3c8", sx2, 0.62, sz2, ry, 0.01);
        } else {
          ibox(t1 - t0, h, WALL_T, color, cx, h / 2, cz, ry);
          if (gw > 0.3) {
            const [gx, gz] = facePt(x, z, ry, (t0 + t1) / 2, off + 0.02);
            ibox(gw, h * 0.6 - 0.6, 0.06, SHOP_GLASS, gx, 0.6 + (h * 0.6 - 0.6) / 2, gz, ry, 0.02);
          }
        }
        const [ax, az] = facePt(x, z, ry, t0, off - WALL_T / 2), [bx2, bz2] = facePt(x, z, ry, t1, off - WALL_T / 2);
        b.colliders.segment(ax, az, bx2, bz2, WALL_T / 2);
      }
      const [lx, lz] = facePt(x, z, ry, 0, off + 0.04);
      ibox(fw + 0.1, 0.35, 0.1, "#eeece6", lx, h * 0.72, lz, ry, 0.02);
      if (front) {
        const [cx, cz] = facePt(x, z, ry, 0, off - WALL_T / 2);
        ibox(DOOR_W, h - DOOR_H, WALL_T, color, cx, DOOR_H + (h - DOOR_H) / 2, cz, ry);
        for (const s2 of [-1, 1]) {
          const [px, pz] = facePt(x, z, ry, s2 * (DOOR_W / 2 + 0.06), off - WALL_T / 2);
          ibox(0.14, DOOR_H + 0.1, WALL_T + 0.12, STEEL, px, (DOOR_H + 0.1) / 2, pz, ry, 0);
          // İçeri açılmış cam kanat
          const [gx, gz] = facePt(x, z, ry, s2 * (DOOR_W / 2 - 0.05), off - WALL_T - 0.6);
          ibox(0.05, DOOR_H - 0.3, 1.1, "#a8c9d8", gx, (DOOR_H - 0.3) / 2, gz, ry, 0);
        }
        ibox(DOOR_W + 0.3, 0.14, WALL_T + 0.12, STEEL, cx, DOOR_H + 0.05, cz, ry, 0);
        // Yaya girer, araba giremez
        const [ax, az] = facePt(x, z, ry, -DOOR_W / 2, off), [bx2, bz2] = facePt(x, z, ry, DOOR_W / 2, off);
        b.carColliders.segment(ax, az, bx2, bz2, 0.2);
      }
    }
    ibox(w, 0.3, d, "#f3f1ec", x, h - 0.15, z, 0, 0.01);
    for (let lx = -w / 2 + 2.5; lx < w / 2 - 1; lx += 4) {
      for (let lz = -d / 2 + 2.5; lz < d / 2 - 1; lz += 4) gbox(1.0, 0.03, 0.35, "#d9d2c2", x + lx, h - 0.31, z + lz);
    }
    rooms.push({ minX: x - w / 2 + WALL_T, maxX: x + w / 2 - WALL_T, minZ: z - d / 2 + WALL_T, maxZ: z + d / 2 - WALL_T, ceil: h - 0.3 });
    return room;
  };

  /** Kırmızı ikaz lambalı anten. */
  const antenna = (x: number, y: number, z: number, h: number) => {
    cyl(0.08, 0.16, h, STEEL_LIGHT, x, y + h / 2, z, 6);
    beacons.push(part(new THREE.IcosahedronGeometry(0.22, 1), "#ff2020", mat(x, y + h + 0.1, z)));
  };
  /** Cam gökdelen: kademeli kütleler, dikey çıtalar, kat bantları, gece pencereleri; tepede LED taç. */
  const glassTower = (o: { x: number; z: number; w: number; d: number; h: number; glass: string; frame: string; face: number; shop?: string; helipad?: boolean; crown?: string; billboard?: string }) => {
    const base = 5.5;
    const room = podium(o.x, o.z, o.w + 2, o.d + 2, base, "#d9d6cf", o.face, o.shop);
    const tiers: [number, number, number][] = [[o.w, o.d, o.h * 0.62], [o.w * 0.82, o.d * 0.82, o.h * 0.88], [o.w * 0.6, o.d * 0.6, o.h]];
    let y0 = base;
    for (const [tw, td, top] of tiers) {
      const th = top - y0;
      box(tw, th, td, o.glass, o.x, y0 + th / 2, o.z, 0, 0.05);
      // Örtücü yere kadar: kademeler ve giriş katı iç içe (birleşim çizgisinde boşluk kalmaz)
      b.occluder(o.x, o.z, tw, td, 0, top, { room });
      for (const [ry, fw, off] of faces(tw, td)) {
        const n = Math.max(2, Math.round(fw / 2.2));
        for (let k = 0; k <= n; k++) {
          const [px, pz] = facePt(o.x, o.z, ry, -fw / 2 + (k * fw) / n, off + 0.05);
          box(0.12, th, 0.12, o.frame, px, y0 + th / 2, pz, ry, 0);
        }
      }
      for (let y = y0 + 3.6; y < top - 0.2; y += 3.6) box(tw + 0.12, 0.16, td + 0.12, o.frame, o.x, y, o.z, 0, 0);
      box(tw + 0.4, 0.4, td + 0.4, o.frame, o.x, top + 0.2, o.z, 0, 0.02);
      gbox(tw + 0.45, 0.06, td + 0.45, o.crown ?? "#bfe9ff", o.x, top + 0.02, o.z);
      nightWindows(o.x, o.z, tw, td, y0, top, 3.6, 2.2, 0.5);
      y0 = top + 0.4;
    }
    const [tw, td] = [o.w * 0.6, o.d * 0.6];
    if (o.helipad) {
      cyl(Math.min(tw, td) * 0.42, Math.min(tw, td) * 0.42, 0.25, "#3a3d42", o.x, y0 + 0.12, o.z, 24);
      const r = Math.min(tw, td) * 0.42;
      solid(new THREE.TorusGeometry(r * 0.78, 0.08, 4, 32).rotateX(Math.PI / 2), "#f4f4f0", mat(o.x, y0 + 0.26, o.z), 0);
      box(0.35, 0.02, 2.2, "#f4f4f0", o.x - 0.7, y0 + 0.26, o.z, 0, 0);
      box(0.35, 0.02, 2.2, "#f4f4f0", o.x + 0.7, y0 + 0.26, o.z, 0, 0);
      box(1.4, 0.02, 0.35, "#f4f4f0", o.x, y0 + 0.26, o.z, 0, 0);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        gbox(0.12, 0.08, 0.12, "#7dff9a", o.x + Math.cos(a) * r * 0.95, y0 + 0.3, o.z + Math.sin(a) * r * 0.95);
      }
      antenna(o.x + tw / 2 - 0.6, y0, o.z + td / 2 - 0.6, 4);
    } else {
      box(tw * 0.5, 2.2, td * 0.5, o.frame, o.x, y0 + 1.1, o.z, 0, 0.02);
      antenna(o.x, y0 + 2.2, o.z, 7);
    }
    if (o.billboard) {
      const [bx, bz] = facePt(o.x, o.z, o.face, 0, (Math.abs(Math.sin(o.face)) > 0.5 ? o.w : o.d) / 2 + 0.2);
      const ty = o.h * 0.62 - 6;
      sign(o.billboard, o.w * 0.7, o.w * 0.175, mat(bx, ty, bz, o.face));
    }
  };
  /** Rezidans: beyaz gövde, kat kat şerit pencereler ve ön/arka balkonlar. */
  const residence = (o: { x: number; z: number; w: number; d: number; h: number; face: number; shop?: string; accent: string }) => {
    const base = 4.5;
    const room = podium(o.x, o.z, o.w + 1.4, o.d + 1.4, base, "#e2ded6", o.face, o.shop);
    const th = o.h - base;
    box(o.w, th, o.d, "#f2efe8", o.x, base + th / 2, o.z, 0, 0.03);
    b.occluder(o.x, o.z, o.w, o.d, 0, o.h, { room });
    const fh = 3.2;
    for (let y = base; y < o.h - 1; y += fh) {
      box(o.w + 0.06, 1.7, o.d + 0.06, "#33475a", o.x, y + 1.55, o.z, 0, 0.02);
      for (const s of [-1, 1]) {
        const ry = s > 0 ? 0 : Math.PI;
        const [bx, bz] = facePt(o.x, o.z, ry, 0, o.d / 2 + 0.6);
        box(o.w - 1, 0.2, 1.3, "#f7f5f0", bx, y + 0.1, bz, ry, 0.02);
        const [rx, rz] = facePt(o.x, o.z, ry, 0, o.d / 2 + 1.2);
        box(o.w - 1, 0.95, 0.06, "#a8c9d8", rx, y + 0.65, rz, ry, 0.02);
        box(o.w - 1, 0.06, 0.1, o.accent, rx, y + 1.13, rz, ry, 0);
      }
    }
    nightWindows(o.x, o.z, o.w, o.d, base, o.h, fh, 2.6, 0.55);
    box(o.w + 0.3, 0.6, o.d + 0.3, "#e6e2da", o.x, o.h + 0.3, o.z, 0, 0.02);
    gbox(o.w + 0.35, 0.05, o.d + 0.35, "#fff1cf", o.x, o.h + 0.62, o.z);
    for (let k = 0; k < 3; k++) box(1.2, 0.9, 1.2, "#a9adb2", o.x - o.w / 3 + k * (o.w / 3), o.h + 1.05, o.z - o.d / 4, 0, 0.05);
    antenna(o.x + o.w / 2 - 0.8, o.h + 0.6, o.z + o.d / 2 - 0.8, 3);
  };
  /** Orta katlı: renkli cephe, pencere ızgarası, zemin katta dükkânlar ve tenteler, çatıda klima. */
  const midrise = (o: { x: number; z: number; w: number; d: number; floors: number; color: string; face: number; shop?: string; awning: string; roofSign?: string }) => {
    const fh = 3.3, base = 5.0, h = base + o.floors * fh;
    const room = podium(o.x, o.z, o.w, o.d, base, o.color, o.face, o.shop, false);
    box(o.w, h - base, o.d, o.color, o.x, base + (h - base) / 2, o.z, 0, 0.05);
    b.occluder(o.x, o.z, o.w, o.d, 0, h, { room });
    for (const [ry, fw, off] of faces(o.w, o.d)) {
      const cols = Math.floor(fw / 3);
      for (let f = 0; f < o.floors; f++) {
        for (let k = 0; k < cols; k++) {
          const [px, pz] = facePt(o.x, o.z, ry, -fw / 2 + (k + 0.5) * (fw / cols), off + 0.03);
          box(1.5, 1.9, 0.08, "#2d3a46", px, base + f * fh + 1.7, pz, ry, 0.02);
          box(1.7, 0.12, 0.2, "#efece5", px, base + f * fh + 0.68, pz, ry, 0);
        }
      }
    }
    nightWindows(o.x, o.z, o.w, o.d, base, h, fh, 3, 0.5);
    // Tente: yüzün boyunca eğimli renkli şerit
    const [ax, az] = facePt(o.x, o.z, o.face, 0, (Math.abs(Math.sin(o.face)) > 0.5 ? o.w : o.d) / 2 + 0.8);
    const fw = Math.abs(Math.sin(o.face)) > 0.5 ? o.d : o.w;
    solid(new THREE.BoxGeometry(fw - 1, 0.08, 1.7), o.awning, mat(ax, 3.12, az, o.face).multiply(new THREE.Matrix4().makeRotationX(0.32)), 0.02);
    for (let k = 0; k < Math.floor(fw - 1); k += 2) {
      const [vx, vz] = facePt(o.x, o.z, o.face, -(fw - 1) / 2 + k + 0.5, (Math.abs(Math.sin(o.face)) > 0.5 ? o.w : o.d) / 2 + 1.62);
      box(0.9, 0.18, 0.02, "#f4f4f0", vx, 2.8, vz, o.face, 0);
    }
    box(o.w + 0.3, 0.7, o.d + 0.3, "#d7d3cb", o.x, h + 0.35, o.z, 0, 0.02);
    for (let k = 0; k < 4; k++) box(1.1, 0.8, 1.1, "#a9adb2", o.x - o.w / 3 + (k % 2) * (o.w / 1.5), h + 1.1, o.z + (k < 2 ? -1 : 1) * (o.d / 4), 0, 0.05);
    cyl(1.1, 1.1, 2.2, "#8b6b4a", o.x + o.w / 4, h + 1.8, o.z, 12);
    if (o.roofSign) {
      // Çatıda çelik ayaklı reklam panosu
      const [bx, bz] = facePt(o.x, o.z, o.face, 0, (Math.abs(Math.sin(o.face)) > 0.5 ? o.w : o.d) / 2 - 1.5);
      for (const s of [-1, 1]) {
        const [lx, lz] = [bx + Math.cos(o.face) * s * 3.2, bz - Math.sin(o.face) * s * 3.2];
        box(0.2, 3, 0.2, STEEL, lx, h + 2.2, lz, o.face, 0);
      }
      box(8.4, 2.3, 0.2, STEEL, bx, h + 4.6, bz, o.face, 0);
      const [sx, sz] = facePt(bx, bz, o.face, 0, 0.12);
      sign(o.roofSign, 8, 2, mat(sx, h + 4.6, sz, o.face));
    }
  };
  /** AVM: iki katlı geniş cam cephe, dev LED ekran ve giriş saçağı. */
  const mall = (x: number, z: number, w: number, d: number, face: number) => {
    const h = 11, g = 5;
    // Zemin kat girilebilir yemek katı; üstte AVM'nin iki katı
    const room = shell(x, z, w, d, g, "#ece9e2", face, "GAP AVM");
    fit("GAP AVM", x, z, w, d, g, face);
    box(w, h - g, d, "#ece9e2", x, g + (h - g) / 2, z, 0, 0.03);
    b.occluder(x, z, w, d, 0, h, { room });
    for (const [ry, fw, off] of faces(w, d)) {
      const [px, pz] = facePt(x, z, ry, 0, off + 0.04);
      box(fw - 2, 2.6, 0.1, "#3a5266", px, 6.6, pz, ry, 0.02);
      for (let k = 0; k <= Math.floor(fw / 3); k++) {
        const [mx, mz] = facePt(x, z, ry, -fw / 2 + 1 + k * ((fw - 2) / Math.floor(fw / 3)), off + 0.1);
        box(0.12, h - g - 1, 0.1, "#f7f6f2", mx, g + (h - g - 1) / 2, mz, ry, 0);
      }
      const [lx, lz] = facePt(x, z, ry, 0, off + 0.12);
      gbox(fw - 1, 0.06, 0.06, "#c58bff", lx, h - 0.4, lz, ry);
    }
    const [sx, sz] = facePt(x, z, face, 0, d / 2 + 0.15);
    box(w * 0.66, w * 0.2, 0.2, "#1b1b22", sx, h - 2.0, sz, face, 0);
    const [tx, tz] = facePt(x, z, face, 0, d / 2 + 0.28);
    sign("GAP AVM", w * 0.62, w * 0.155, mat(tx, h - 2.0, tz, face));
    const [cx2, cz2] = facePt(x, z, face, 0, d / 2 + 2);
    box(9, 0.3, 4, "#f2f0ea", cx2, 4.2, cz2, face, 0.02);
    gbox(8.4, 0.03, 3.4, "#fff4dc", cx2, 4.03, cz2, face);
    for (const s of [-1, 1]) {
      const [px, pz] = facePt(x, z, face, s * 4.2, d / 2 + 3.7);
      cyl(0.16, 0.16, 4.1, "#f2f0ea", px, 2.05, pz, 10);
      b.colliders.circle(px, pz, 0.2);
    }
    box(w + 0.3, 0.5, d + 0.3, "#d7d3cb", x, h + 0.25, z, 0, 0.02);
  };
  /** Villa: bahçe çimi, çit ve çalılar, modern iki kütle (beyaz ve ahşap) ya da beşik çatılı ev, araba yolu. */
  const house = (x: number, z: number, style: number, accent: string, car?: string) => {
    const lw = 13, ld = 16;
    box(lw, 0.03, ld, LAWN, x, Y_BASE + 0.015, z, 0, 0.08);
    // Çit (bahçe kenarı, ön tarafta yol girişi açık)
    for (const s of [-1, 1]) {
      box(0.1, 0.9, ld, "#f2f0ea", x + s * lw / 2, 0.45, z, 0, 0);
      b.colliders.segment(x + s * lw / 2, z - ld / 2, x + s * lw / 2, z + ld / 2, 0.08);
    }
    box(lw, 0.9, 0.1, "#f2f0ea", x, 0.45, z + ld / 2, 0, 0);
    b.colliders.segment(x - lw / 2, z + ld / 2, x + lw / 2, z + ld / 2, 0.08);
    for (const s of [-1, 1]) {
      box(4, 0.9, 0.1, "#f2f0ea", x + s * 4.5, 0.45, z - ld / 2, 0, 0);
      b.colliders.segment(x + s * 2.5, z - ld / 2, x + s * 6.5, z - ld / 2, 0.08);
    }
    box(3.2, 0.03, 7, "#9b968c", x - 3.5, Y_BASE + 0.03, z - ld / 2 + 3.5, 0, 0.05);
    box(1.2, 0.03, 4, "#b8b2a6", x + 1.2, Y_BASE + 0.03, z - ld / 2 + 2, 0, 0.05);
    const hz = z + 1.5;
    if (style === 0) {
      box(9, 3.2, 7, "#f5f3ee", x, 1.6, hz, 0, 0.02);
      box(7, 3, 6, "#f5f3ee", x + 1.2, 4.7, hz + 0.4, 0, 0.02);
      b.occluder(x, hz, 9, 7, 0, 3.2);
      b.occluder(x + 1.1, hz + 0.4, 6.8, 6, 0, 6.2);
      box(3.2, 3, 6.06, "#9a6b43", x - 1.1, 4.7, hz + 0.4, 0, 0.05);
      box(5, 2.2, 0.08, "#2d3a46", x + 1.4, 1.5, hz - 3.52, 0, 0.02);
      box(3.5, 1.8, 0.08, "#2d3a46", x + 2.2, 4.8, hz - 2.62, 0, 0.02);
      box(9.4, 0.25, 7.4, "#e3dfd7", x, 3.25, hz, 0, 0.02);
      box(7.3, 0.3, 6.3, "#e3dfd7", x + 1.2, 6.3, hz + 0.4, 0, 0.02);
      box(1.2, 2.3, 0.1, accent, x - 2.6, 1.15, hz - 3.52, 0, 0);
      windows.push(part(new THREE.PlaneGeometry(4.6, 1.8), "#ffe1ad", mat(x + 1.4, 1.5, hz - 3.58, Math.PI)));
    } else {
      box(8.5, 3.4, 7, accent, x, 1.7, hz, 0, 0.03);
      b.occluder(x, hz, 8.5, 7, 0, 3.4);
      for (const s of [-1, 1]) {
        solid(new THREE.BoxGeometry(9.4, 0.25, 4.6), "#5d4a42", mat(x, 4.35, hz + s * 1.8).multiply(new THREE.Matrix4().makeRotationX(s * 0.62)), 0.04);
      }
      solid(new THREE.CylinderGeometry(3.6, 3.6, 8.4, 3, 1).rotateZ(Math.PI / 2).rotateY(Math.PI / 2), accent, mat(x, 3.4 + 0.6, hz, Math.PI / 2, 1, 0.5, 1), 0.02);
      box(0.7, 1.6, 0.7, "#8b5a46", x + 2.6, 5.6, hz + 1.2, 0, 0.03);
      for (const wx of [-2.6, 2.6]) box(1.4, 1.3, 0.08, "#2d3a46", x + wx, 1.9, hz - 3.52, 0, 0.02);
      box(1.1, 2.2, 0.1, "#f5f3ee", x, 1.1, hz - 3.52, 0, 0);
      windows.push(part(new THREE.PlaneGeometry(1.2, 1.1), "#ffe1ad", mat(x - 2.6, 1.9, hz - 3.58, Math.PI)));
    }
    rectCollider(x, hz, style === 0 ? 9 : 8.5, 7);
    b.prop("bush", mat(x + 4.6, 0, z - 6.2, rand() * 6, 0.9));
    b.prop("bush", mat(x - 5.6, 0, z + 6.5, rand() * 6, 1.1));
    b.prop(rand() > 0.5 ? "oak" : "sakura", mat(x + 4.2, 0, z + 5.6, rand() * 6, 0.9));
    b.colliders.circle(x + 4.2, z + 5.6, 0.3);
    // Posta kutusu
    box(0.1, 1.0, 0.1, STEEL, x + 2.5, 0.5, z - ld / 2 - 0.3, 0, 0);
    box(0.4, 0.3, 0.5, accent, x + 2.5, 1.1, z - ld / 2 - 0.3, 0, 0);
    if (car) parkedCar(x - 3.5, z - ld / 2 + 3.2, Math.PI / 2, car);
  };
  /** Park edilmiş araba (yerel x boyunca uzun): gövde, kabin, tekerlekler, farlar ve stoplar. */
  const parkedCar = (x: number, z: number, ry: number, color: string) => {
    const c = Math.cos(ry), s = Math.sin(ry);
    const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * s, z - lx * s + lz * c];
    const p = (w: number, h: number, d: number, col: string, lx: number, y: number, lz: number, jitter = 0.02) => {
      const [px, pz] = at(lx, lz);
      box(w, h, d, col, px, y, pz, ry, jitter);
    };
    p(4.2, 0.62, 1.82, color, 0, 0.62, 0);
    p(4.24, 0.22, 1.86, "#222428", 0, 0.32, 0, 0);
    p(2.3, 0.62, 1.62, "#26303a", -0.25, 1.24, 0);
    p(2.0, 0.08, 1.5, color, -0.25, 1.58, 0);
    for (const [lx, lz] of [[1.35, 0.86], [1.35, -0.86], [-1.35, 0.86], [-1.35, -0.86]]) {
      const [wx, wz] = at(lx, lz);
      solid(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12).rotateX(Math.PI / 2), "#151517", mat(wx, 0.34, wz, ry), 0);
      solid(new THREE.CylinderGeometry(0.18, 0.18, 0.26, 8).rotateX(Math.PI / 2), "#b9bec4", mat(wx, 0.34, wz, ry), 0);
    }
    for (const lz of [-0.62, 0.62]) {
      const [hx, hz] = at(2.11, lz), [tx, tz] = at(-2.11, lz);
      glows.push(part(new THREE.BoxGeometry(0.04, 0.14, 0.38), "#fff6dc", mat(hx, 0.74, hz, ry)));
      glows.push(part(new THREE.BoxGeometry(0.04, 0.12, 0.42), "#ff2a2a", mat(tx, 0.76, tz, ry)));
    }
    b.colliders.segment(...at(-1.5, 0), ...at(1.5, 0), 0.95);
  };
  const CAR_COLORS = ["#c8102e", "#1f5fbf", "#f4f4f0", "#1a1a1d", "#9aa2ab", "#e9b44c", "#2e8b57", "#6b2d8c", "#ff7f2a"];
  const carColor = () => CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)];

  // ---- Kuzey sırası (bulvarın kuzeyi): gökdelenler; ortada casino ----
  glassTower({ x: 400 + CITY_DX, z: -70, w: 20, d: 17, h: 46, glass: "#3d6e8f", frame: "#e9edf0", face: 0, shop: "GAP KAHVE", billboard: "GAP AIR" });
  residence({ x: 400 + CITY_DX, z: -103, w: 20, d: 14, h: 30, face: 0, accent: "#d6aa3c" });
  glassTower({ x: 438.5 + CITY_DX, z: -72, w: 10, d: 13, h: 38, glass: "#2e5a74", frame: "#cfd6dd", face: 0, shop: "ECZANE", crown: "#ffd36b" });
  glassTower({ x: 493.5 + CITY_DX, z: -72, w: 10, d: 13, h: 42, glass: "#355b6b", frame: "#cfd6dd", face: 0, shop: "BERBER", crown: "#ffd36b" });
  glassTower({ x: 531 + CITY_DX, z: -72, w: 24, d: 22, h: 68, glass: "#1f4f72", frame: "#f2f5f7", face: 0, shop: "GAP BANK", helipad: true, crown: "#5fd3ff", billboard: "GAP TOWER" });
  residence({ x: 531 + CITY_DX, z: -106, w: 22, d: 12, h: 34, face: 0, accent: "#5fd3ff" });
  // Casinonun arkasında otopark
  {
    const px = CASINO.x, pz = CASINO.z - CASINO.hd - 14;
    box(36, 0.02, 20, "#45484e", px, Y_ASPHALT - 0.01, pz, 0, 0.04);
    // Kuzey sırasının ortası boş: GAP Ring'e (pit kapısına) giden geçit
    for (let k = -8; k <= 8; k++) if (k < -2 || k > 2) box(0.12, 0.01, 5, LINE, px + k * 2.4, Y_ASPHALT + 0.003, pz - 5, 0, 0);
    for (let k = -8; k <= 8; k++) box(0.12, 0.01, 5, LINE, px + k * 2.4, Y_ASPHALT + 0.003, pz + 5, 0, 0);
    for (let k = -8; k < 8; k++) {
      if (rand() < 0.35 || (k >= -2 && k <= 1)) continue;
      parkedCar(px + k * 2.4 + 1.2, pz - 5, Math.PI / 2 + (rand() > 0.5 ? Math.PI : 0), carColor());
    }
    for (let k = -8; k < 8; k++) {
      if (rand() < 0.45) continue;
      parkedCar(px + k * 2.4 + 1.2, pz + 5, Math.PI / 2 + (rand() > 0.5 ? Math.PI : 0), carColor());
    }
    for (const s of [-1, 1]) streetLamp(px + s * 17, pz, s > 0 ? -Math.PI / 2 : Math.PI / 2, 6);
  }

  // ---- Güney sırası (bulvar ile güney caddesi arası): park, ofis, AVM, kule ----
  // Park: çim, çapraz yollar, havuz ve fıskiye, banklar, ağaçlar, çiçek tarhları
  {
    const px = 401 + CITY_DX, pz = -13.5, pw = 30, pd = 31;
    box(pw, 0.03, pd, LAWN, px, Y_BASE + 0.015, pz, 0, 0.08);
    for (const r of [Math.atan2(pd, pw), -Math.atan2(pd, pw)]) box(Math.hypot(pw, pd) - 2, 0.03, 2.2, "#d8ccb0", px, Y_BASE + 0.03, pz, r, 0.04);
    cyl(5.4, 5.4, 0.03, "#d8ccb0", px, Y_BASE + 0.035, pz, 28);
    cyl(4, 4.2, 0.5, "#e8e5de", px, 0.25, pz, 28);
    solid(new THREE.CylinderGeometry(3.7, 3.7, 0.04, 28), "#4aa3d6", mat(px, 0.47, pz), 0.02);
    cyl(0.3, 0.45, 1.6, "#e8e5de", px, 1.1, pz, 12);
    glows.push(part(new THREE.CylinderGeometry(0.05, 0.12, 1.4, 8), "#cfefff", mat(px, 2.5, pz)));
    b.colliders.circle(px, pz, 4.2);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8, r = 7.2;
      const bx = px + Math.cos(a) * r, bz = pz + Math.sin(a) * r, rot = Math.atan2(px - bx, pz - bz);
      box(1.6, 0.08, 0.5, "#9a6b43", bx, 0.48, bz, rot, 0.04);
      box(1.6, 0.4, 0.08, "#9a6b43", bx - Math.sin(rot) * 0.24, 0.72, bz - Math.cos(rot) * 0.24, rot, 0.04);
      for (const s of [-0.6, 0.6]) box(0.08, 0.45, 0.45, STEEL, bx + Math.cos(rot) * s, 0.22, bz - Math.sin(rot) * s, rot, 0);
      for (const s of [-0.4, 0.4]) b.seats.push({ x: bx + Math.cos(rot) * s, z: bz - Math.sin(rot) * s, rot });
    }
    for (let k = 0; k < 16; k++) {
      const a = rand() * Math.PI * 2, r = 9 + rand() * 4;
      const tx = px + Math.cos(a) * r, tz = pz + Math.sin(a) * r;
      if (Math.abs(tx - px) > pw / 2 - 1.5 || Math.abs(tz - pz) > pd / 2 - 1.5) continue;
      b.prop(k % 3 ? "oak" : "sakura", mat(tx, 0, tz, rand() * 6, 0.8 + rand() * 0.4));
      b.colliders.circle(tx, tz, 0.35);
    }
    const flowers = ["#ff6b9a", "#ffd36b", "#c58bff", "#ff8a3a"];
    for (const [fx, fz] of [[px - 11, pz - 11], [px + 11, pz - 11], [px - 11, pz + 11], [px + 11, pz + 11]]) {
      cyl(1.6, 1.6, 0.3, "#8a7a62", fx, 0.15, fz, 16);
      for (let k = 0; k < 14; k++) {
        const a = rand() * Math.PI * 2, r = rand() * 1.4;
        box(0.25, 0.3, 0.25, flowers[k % 4], fx + Math.cos(a) * r, 0.42, fz + Math.sin(a) * r, a, 0.1);
      }
      b.colliders.circle(fx, fz, 1.6, 0.3);
    }
    for (const [lx, lz] of [[px - 6, pz - 6], [px + 6, pz + 6], [px - 6, pz + 6], [px + 6, pz - 6]]) {
      b.prop("post", mat(lx, 0, lz));
      b.prop("bulb", mat(lx, 2.7, lz));
      b.colliders.circle(lx, lz, 0.15);
    }
  }
  midrise({ x: 445 + CITY_DX, z: -13.5, w: 24, d: 26, floors: 4, color: "#c9805e", face: Math.PI, shop: "GAP MARKET", awning: "#2e8b57", roofSign: "GAP COLA" });
  mall(487 + CITY_DX, -13.5, 24, 26, Math.PI);
  glassTower({ x: 531 + CITY_DX, z: -13.5, w: 22, d: 22, h: 56, glass: "#3a6b7d", frame: "#eef2f4", face: Math.PI, shop: "OTEL GAP", crown: "#ffd36b", billboard: "OTEL GAP" });

  // ---- Otobüs durağı: bulvarın güney kaldırımı ----
  {
    const { x, z } = BUS;
    box(5, 0.12, 1.8, "#e9eef2", x, 2.7, z, 0, 0.02);
    for (const sx of [-2.3, 2.3]) box(0.1, 2.7, 0.1, STEEL, x + sx, 1.35, z + 0.75, 0, 0);
    box(4.6, 2.1, 0.06, "#a8c9d8", x, 1.5, z + 0.8, 0, 0.02);
    sign("GAP COLA", 1.8, 0.45, mat(x - 1.3, 1.6, z + 0.74, Math.PI));
    box(3.2, 0.1, 0.5, "#9a6b43", x + 0.6, 0.5, z + 0.4, 0, 0.03);
    for (const o of [-0.6, 0.4, 1.4]) b.seats.push({ x: x + o, z: z + 0.35, rot: Math.PI });
    cyl(0.06, 0.06, 3, STEEL, x - 3, 1.5, z - 0.6, 8);
    box(1.3, 0.38, 0.04, STEEL, x - 3, 2.85, z - 0.6, 0, 0);
    sign("DURAK", 1.2, 0.3, mat(x - 3, 2.85, z - 0.63, Math.PI));
    b.colliders.segment(x - 2.3, z + 0.8, x + 2.3, z + 0.8, 0.12);
  }

  // ---- Güney caddesi boyunca parka park etmiş arabalar ----
  {
    const s = STREETS[4];
    for (const [u0, u1] of spans(s, 4)) {
      for (let u = u0 + 3; u < u1 - 4; u += 6.5) {
        if (rand() < 0.4) continue;
        const [x, z] = sp(s, u, -(s.half - 1.2));
        parkedCar(x, z, 0, carColor());
      }
    }
  }

  // ---- Villalar: güney caddesinin güneyi ----
  const accents = ["#c8102e", "#e9b44c", "#1f5fbf", "#2e8b57", "#d97a4a", "#6b8fb5", "#b0547a", "#4a7a6b"];
  let hk = 0;
  for (const [x0, x1] of [[386, 416], [432, 458], [474, 500], [516, 546]].map(([a, c]) => [a + CITY_DX, c + CITY_DX])) {
    const n = 2;
    for (let k = 0; k < n; k++) {
      const x = x0 + ((k + 0.5) * (x1 - x0)) / n;
      house(x, 28.5, hk % 3 === 1 ? 1 : 0, accents[hk % accents.length], rand() > 0.4 ? carColor() : undefined);
      hk++;
    }
  }

  // ==================================================================
  // Mesh'ler
  // ==================================================================
  const addMesh = (geos: THREE.BufferGeometry[], material: THREE.Material) => {
    if (!geos.length) return null;
    const m = new THREE.Mesh(mergeGeometries(geos), material);
    m.matrixAutoUpdate = false;
    group.add(m);
    return m;
  };
  addMesh(glows, new THREE.MeshBasicMaterial({ vertexColors: true }));
  const insideFlood = { value: 0 };
  const flood = floodMaterial(insideFlood, {});
  const wallTiles = tiledStatics(walls, flood);
  wallTiles.traverse((o) => (o.castShadow = o.receiveShadow = false));
  group.add(wallTiles);
  // İç mekânlar yalnızca camdan ve kapıdan, yakından görünür: dükkân başına mesh, uzaktakiler çizilmez
  const interiors = new THREE.Group();
  interiors.userData.maxDist = 70;
  const portals = new Map<THREE.Object3D, Portal>();
  for (const shop of shops) {
    if (!shop.geos.length) continue;
    const m = staticMesh(shop.geos, flood, `iç ${shop.name}`);
    m.castShadow = m.receiveShadow = false;
    interiors.add(m);
    portals.set(m, shop.portal);
  }
  group.add(interiors);
  const glassMesh = addMesh(glassGeos, new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.26, shininess: 90, specular: "#ffffff", depthWrite: false }));
  if (glassMesh) glassMesh.renderOrder = 3;
  addMesh(neon, new THREE.MeshBasicMaterial({ map: atlas }));
  const windowMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false });
  const windowMesh = addMesh(windows, windowMat);
  const beaconMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  addMesh(beacons, beaconMat);
  const signalMats = signals.map((dir) => dir.map((geos) => {
    const m = new THREE.MeshBasicMaterial({ vertexColors: true });
    addMesh(geos, m);
    return m;
  }));

  return {
    group,
    rooms,
    npcs,
    interiors,
    portals,
    walls: wallTiles,
    update(time, night) {
      // İç aydınlatma: gündüz de hafif (tavanlar yeşilimsi gök yansımasıyla kararmasın), gece daha çok
      insideFlood.value = 0.22 + night * 0.25;
      windowMat.opacity = Math.min(1, night * 1.2);
      if (windowMesh) windowMesh.visible = night > 0.02;
      beaconMat.color.setScalar(Math.sin(time * 3.2) > 0.2 ? 1 : 0.12);
      // Trafik lambaları ortak saatle (signals.ts): herkeste aynı, NPC arabalar da buna uyar
      const now = signalNow();
      ([0, 1] as const).forEach((dir) => {
        const on = signalLamp(now, dir);
        signalMats[dir].forEach((m, k) => m.color.setScalar(k === on ? 1 : 0.1));
      });
      for (const m of signMats) (m as THREE.MeshLambertMaterial).emissive.setScalar(0.23 + night * 0.35);
    },
  };
}
