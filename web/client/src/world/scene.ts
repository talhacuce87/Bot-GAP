// "GAP Meydanı": tamamen prosedürel, low-poly, vertex renkli sahne.
// Statik geometri tek mesh'te birleştirilir; tekrar eden objeler InstancedMesh ile çizilir;
// rüzgâr, alev ve duman vertex shader'da. Toplam ~20 draw call. Güneş gölgesi isteğe bağlı:
// yalnızca oyuncunun çevresindeki kutuda, uzakta zemin lekeleri devralır.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { WORLD_RADIUS } from "../../../shared/constants";
import type { Weather } from "../../../shared/protocol";
import { KAHVEHANE, PITCH } from "../../../shared/zones";
import { HOOD_BOX, HOOD, HOOD_GAP, PLOT_SIZE } from "../../../shared/build";
import type { ShadowLevel } from "../settings";
import { Builder, type PropKind, type Seat } from "./builder";
import type { Colliders } from "./colliders";
import { DayNight, skyDome } from "./daynight";
import { GrassField } from "./grassField";
import { NightFx } from "./night";
import { FameBoard, fameStatics } from "./fame";
import { blobTexture, flatMat, flickerMaterial, instanced, mat, part, timeUniform, wetEnv, wetUniform, windMaterial, withCloudShadows, withWetness } from "./geo";
import { kahvehane } from "./kahvehane";
import { type Pitch, pitch } from "./pitch";
import { djBooth, type StageLights, stageLights, stageTruss } from "./stageFx";
import { addRipple, dungeon, GROVE, grove, GROVE_SIGN, POND, pond, signPost, steppingStones, waterEnv, waterMaterial } from "./zones";
import { FAME } from "./fame";
import { SAKURA, SAKURA_CONFIG, sakuraGarden, type SakuraGarden } from "./sakura";
import { TANK_PARK } from "../../../shared/tank";

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
  /** Kare başına: shader saati ve birkaç ucuz animasyon; `focus` oyuncunun konumu (gece ışıkları). */
  update(time: number, focus?: { x: number; z: number }): void;
  /** Biri şiş çevirdi: duman kabarır, köz parlar (`time`: döngü saati, sn). */
  grillBoost(time: number): void;
  sakura: SakuraGarden;
  /** Gün ışığı (0 gece, 1 gündüz), lambaların yanma oranı ve gün batımı tonu; DayNight günceller. */
  env: { day: number; lights: number; dusk: number };
  /** Güneş gölgesi (renderer.shadowMap ayrıca açılmalı). */
  setShadows(level: ShadowLevel): void;
  /** İstanbul'un havası (gök, sis, bulut gölgesi, göle yağmur). */
  setWeather(w: Weather): void;
  /** Saati sabitle (Türkiye saati), null: gerçek saat; gök yumuşakça geçer. */
  setHour(h: number | null): void;
  /** Şimşek parlaması (0–1), her kare: ortam aydınlanır, güneş ışığı bir an sert gölge düşürür. */
  flash(v: number): void;
  /** Gökte gösterilen saat (Türkiye saati, ondalıklı). */
  hour(): number;
  /** Futbol sahası ve top. */
  pitch: Pitch;
  /** Sahne ışıkları (DJ şovu, karaoke takip spotu). */
  stageLights: StageLights;
  /** Suda dalga halkası (göl, çeşme). */
  ripple(x: number, z: number, time: number): void;
  season: Season;
  /** Oyuncunun çevresindeki sık çimen (zayıf cihazda yok). */
  grass: GrassField | null;
  /** Sinemada bir şey oynuyor: hoparlörler ritimle titrer. */
  setMusic(on: boolean): void;
  /** Hoparlörlerin üstü: nota efektleri buradan çıkar. */
  speakers: { x: number; y: number; z: number }[];
  /** Güneşin gökteki yönü (ufkun altındaysa y < 0): ışık huzmeleri ve lens parlaması için. */
  sunDir: THREE.Vector3;
}

export type Season = "spring" | "summer" | "autumn" | "winter";

/** Türkiye takvimine göre mevsim (?season= ile denenebilir). */
export function seasonOf(now = Date.now()): Season {
  const m = new Date(now + 3 * 3600_000).getUTCMonth();
  return m <= 1 || m === 11 ? "winter" : m <= 4 ? "spring" : m <= 7 ? "summer" : "autumn";
}

/** Mevsim renkleri: çimen, ağaç tacı, çalı, çiçek (sonbaharda yaprak) paleti. */
const SEASON_LOOK: Record<Season, { ground: [string, number]; oak: string[]; pine: [string, string]; sakura: string[]; bush: [string, string]; flowers: string[]; flowerClusters: number; tufts: number }> = {
  spring: {
    ground: ["#64a84a", 0.3], oak: ["#6ab24a", "#7cc257", "#5c9e40"], pine: ["#3f7a3a", "#4c8c42"],
    sakura: ["#f7a3bd", "#fbbcd0", "#f08aac", "#ffd3e1"], bush: ["#5a9a40", "#6fb04e"],
    flowers: ["#f4f1e6", "#f7d64a", "#e85a6f", "#b48ae8", "#f59a3c", "#ff9ec4"], flowerClusters: 140, tufts: 6500,
  },
  summer: {
    ground: ["#6f9a4a", 0], oak: ["#5c9a3f", "#6aa847", "#4f8a37"], pine: ["#3f7a3a", "#4c8c42"],
    sakura: ["#f7a3bd", "#fbbcd0", "#f08aac", "#ffd3e1"], bush: ["#4f8a3a", "#5f9c45"],
    flowers: ["#f4f1e6", "#f7d64a", "#e85a6f", "#b48ae8", "#f59a3c"], flowerClusters: 80, tufts: 6500,
  },
  autumn: {
    ground: ["#8c9147", 0.35], oak: ["#d9822b", "#e0a93a", "#c4561f"], pine: ["#3d7039", "#4a8040"],
    sakura: ["#d97a4a", "#e8955a", "#c9603c", "#f0b070"], bush: ["#9a7a32", "#b8862f"],
    flowers: ["#d9822b", "#c4561f", "#e0a93a", "#a8442a", "#b8862f"], flowerClusters: 150, tufts: 5000,
  },
  winter: {
    ground: ["#e4eaef", 0.82], oak: ["#e6ecef", "#d7dfe3", "#f1f4f6"], pine: ["#3c6a3a", "#e2e9ec"],
    sakura: ["#e9e2e5", "#ddd5d9", "#f3eef0", "#e4dde0"], bush: ["#d9e1e5", "#c8d2d6"],
    flowers: [], flowerClusters: 0, tufts: 0,
  },
};
let SEASON: Season = "summer";

export interface WorldOptions {
  /** Gece/gündüz testi için saat (?hour=21); verilmezse Türkiye saati. */
  hour?: number;
  /** Mevsim (verilmezse takvimden). */
  season?: Season;
  /** Oyuncunun çevresinde sık çimen. */
  grass?: boolean;
  /** Gece gerçek ışık alan en yakın lamba sayısı (0: yalnızca ucuz zemin lekeleri). */
  lamps?: number;
}

/** Gölge haritası çözünürlüğü ve oyuncu çevresinde kapladığı kutunun yarı genişliği (m). */
const SHADOW: Record<Exclude<ShadowLevel, "off">, { size: number; half: number }> = {
  low: { size: 1024, half: 24 },
  high: { size: 2048, half: 34 },
};
/** Ay yönü: gece ışık (ve silik gölgeler) buradan gelir. */
const MOON_DIR = new THREE.Vector3(20, 30, 12).normalize();

export const SCREEN_Z = -46;
export const SCREEN_W = 20;
export const SCREEN_H = SCREEN_W * (9 / 16);
const AMPHI_CENTER_Z = -46;
const AMPHI_ROWS = 6;
const SKY = new THREE.Color("#a9cfee");

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
    g.fillText("Discord'da !izle <link> yaz, perdede oynasın", 256, 190);
  });
}

/** Yön tabelasındaki satırlar (meydandan bakan oyuncuya göre ok). */
const DIRECTIONS = ["↑ SİNEMA · DJ", "SAKURA BAHÇESİ ↗", "← ZİNDAN", "← MAHALLE (İNŞA)", "MANGAL →", "↙ ŞÖHRET KÜRSÜSÜ", "↙ KAHVEHANE", "↓ FUTBOL SAHASI", "GÖLET ↘", "↖ TANK"];
const SIGN_DUNGEON = 0;
const SIGN_GROVE = 1;
const SIGN_KAHVE = 2;
const SIGN_DIR = 3;

interface SignSpec {
  at: THREE.Matrix4;
  w: number;
  h: number;
  cell: number;
}

/** Bütün tabelalar tek dokuda (2 sütun × 8 satır, 512×128 hücre) ve tek draw call. */
function signsMesh(specs: SignSpec[]): THREE.Mesh {
  const tex = canvasTexture(1024, 1024, (g) => {
    const board = (cell: number, bg: string, edge: string, text: string, color: string, font: string) => {
      const x = (cell % 2) * 512, y = Math.floor(cell / 2) * 128;
      g.fillStyle = edge;
      g.fillRect(x, y, 512, 128);
      g.fillStyle = bg;
      g.fillRect(x + 8, y + 8, 496, 112);
      g.fillStyle = color;
      g.font = font;
      g.textAlign = "center";
      g.textBaseline = "middle";
      let size = parseInt(font.match(/(\d+)px/)![1], 10);
      while (size > 20 && g.measureText(text).width > 470) g.font = font.replace(/\d+px/, `${--size}px`);
      g.fillText(text, x + 256, y + 66);
    };
    board(SIGN_DUNGEON, "#2a2c31", "#141518", "ZİNDAN", "#e8d9b0", "900 78px system-ui, sans-serif");
    board(SIGN_GROVE, "#a8743e", "#5b3f25", "LAGER'İN MANGALI", "#fff3dc", "800 52px system-ui, sans-serif");
    board(SIGN_KAHVE, "#7a2622", "#3d1512", "☕ KAHVEHANE", "#f6e7c8", "900 64px system-ui, sans-serif");
    DIRECTIONS.forEach((t, i) => board(SIGN_DIR + i, "#d0a56c", "#6b4a2b", t, "#2b1d10", "800 54px system-ui, sans-serif"));
  });
  const plane = ({ at, w, h, cell }: SignSpec) => {
    const g = new THREE.PlaneGeometry(w, h);
    const u0 = (cell % 2) * 0.5, v0 = 1 - (Math.floor(cell / 2) + 1) / 8;
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) / 8);
    g.applyMatrix4(at);
    return g;
  };
  // Işıktan etkilenir: gündüz aynı, gece loş ama okunur (Basic olsa karanlıkta neon gibi parlar).
  const mesh = new THREE.Mesh(mergeGeometries(specs.map(plane)), new THREE.MeshLambertMaterial({ map: tex, emissive: "#222222", emissiveMap: tex }));
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Meydandaki yön tabelası: doğma noktasına bakan, üst üste oklu levhalar. */
function directionPost(b: Builder): SignSpec[] {
  const x = 3.6, z = 5.2;
  b.add(part(new THREE.CylinderGeometry(0.08, 0.1, 3.7, 6), "#5b3f25", mat(x, 1.85, z)));
  b.add(part(new THREE.ConeGeometry(0.16, 0.25, 6), "#5b3f25", mat(x, 3.8, z)));
  b.colliders.circle(x, z, 0.15);
  return DIRECTIONS.map((_, i) => ({ at: mat(x, 3.55 - i * 0.33, z + 0.09), w: 1.7, h: 0.3, cell: SIGN_DIR + i }));
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
  // Sakura bahçesi: daha gür, canlı yeşil
  const ds = Math.hypot(x - SAKURA.x, z - SAKURA.z);
  if (ds < SAKURA_CONFIG.radius + 2) out.lerp(tmp.set("#5e9a3e"), Math.min(1, (SAKURA_CONFIG.radius + 2 - ds) / 3) * 0.75);
  const dd = Math.hypot(x + 55, z - 5);
  if (dd < 11) out.lerp(tmp.set("#6b6f55"), (1 - dd / 11) * 0.6);
  // Mevsim: sonbaharda sararır, kışın kar (lekeli), baharda canlanır
  const [tint, k] = SEASON_LOOK[SEASON].ground;
  if (k) out.lerp(tmp.set(tint), SEASON === "winter" ? Math.min(1, k + n * 0.08) : k);
  return out;
}

/** Sınırın ötesinde zemin hafifçe yükselir: ufuk düz bir çizgi olmasın. */
function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r <= WORLD_RADIUS + 4) return 0;
  const h = Math.min(6, (r - WORLD_RADIUS - 4) * 0.18) + Math.sin(x * 0.3) * Math.cos(z * 0.25) * 0.6 * Math.min(1, (r - WORLD_RADIUS - 4) / 4);
  // Mahalle düzlüğü: kutunun içi düz, kenarından tepelere yumuşak geçiş
  const dx = Math.max(HOOD_BOX.minX - x, 0, x - HOOD_BOX.maxX), dz = Math.max(HOOD_BOX.minZ - z, 0, z - HOOD_BOX.maxZ);
  return h * Math.min(1, Math.hypot(dx, dz) / 8);
}

function ground(b: Builder): void {
  const geo = new THREE.RingGeometry(0.01, 210, 80, 28);
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
  // Sinemaya giden taş döşeli yol (amfinin orta koridoruna kadar)
  b.add(part(new THREE.PlaneGeometry(3, 23), "#c9b99a", flatMat(0, 0.02, -22), 0.06, b.rand));
  b.clearCircle(0, 0, 11.2);
  b.clearBox(-2.2, 2.2, -34, -9);

  // Çeşme
  b.add(part(new THREE.CylinderGeometry(2.2, 2.4, 0.6, 14), "#9aa3ad", mat(0, 0.3, 0)));
  b.add(part(new THREE.CylinderGeometry(0.35, 0.5, 1.6, 8), "#9aa3ad", mat(0, 0.8, 0)));
  b.add(part(new THREE.CylinderGeometry(0.9, 0.6, 0.2, 10), "#a9b2bc", mat(0, 1.6, 0)));
  b.add(part(new THREE.CylinderGeometry(0.12, 0.16, 0.22, 6), "#8a939d", mat(0, 1.8, 0))); // fıskiye ağzı
  // Üstüne çıkılır: önce havuz kenarı, oradan tepedeki çanak
  b.colliders.circle(0, 0, 2.4, 0.6);
  b.colliders.circle(0, 0, 0.9, 1.7);

  // Saksılar: meydan kenarında çiçekli
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.sin(a) * 9.2, z = Math.cos(a) * 9.2;
    if (z < -8 || Math.abs(z - 5) < 1.5 || (Math.abs(x) < 2 && z > 0) || x > 8) continue; // yolları, doğma noktasını kapatma
    b.add(part(new THREE.CylinderGeometry(0.45, 0.35, 0.5, 8), "#b5643c", mat(x, 0.25, z)));
    b.prop("bush", mat(x, 0.62, z, a, 0.5, 0.45, 0.5));
    b.colliders.circle(x, z, 0.45, 0.9);
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
  b.add(part(new THREE.BoxGeometry(28, 0.6, 5), "#8a6f55", mat(0, 0.3, SCREEN_Z - 0.5)));
  b.add(part(new THREE.BoxGeometry(SCREEN_W + 0.8, SCREEN_H + 0.8, 0.4), "#2a2f3a", mat(0, 1.2 + SCREEN_H / 2, SCREEN_Z - 1.6)));
  for (const sx of [-1, 1]) {
    b.add(part(new THREE.BoxGeometry(0.6, SCREEN_H + 2, 0.6), "#3a3f4c", mat(sx * (SCREEN_W / 2 + 0.7), (SCREEN_H + 2) / 2, SCREEN_Z - 1.6)));
    // Hoparlör kabini (koniler ayrı mesh: müzikle titrer)
    b.add(part(new THREE.BoxGeometry(1.4, 2.4, 1), "#23262d", mat(sx * 12.8, 1.8, SCREEN_Z - 0.9)));
  }
  // Sahneye çıkılır; perde (direkleriyle) ve hoparlör kabinleri duvar
  b.colliders.segment(-14, SCREEN_Z - 0.5, 14, SCREEN_Z - 0.5, 2.5, 0.6);
  b.colliders.segment(-(SCREEN_W / 2 + 0.7), SCREEN_Z - 1.6, SCREEN_W / 2 + 0.7, SCREEN_Z - 1.6, 0.3);
  for (const sx of [-1, 1]) b.colliders.segment(sx * 12.8, SCREEN_Z - 1.2, sx * 12.8, SCREEN_Z - 0.6, 0.7);
  b.clearBox(-22, 22, -52, -17);

  const bench = mergeGeometries([
    part(new THREE.BoxGeometry(2.2, 0.12, 0.5), "#a0703f", mat(0, 0.45, 0)),
    part(new THREE.BoxGeometry(2.2, 0.5, 0.08), "#8a5f35", mat(0, 0.75, -0.24)),
    part(new THREE.BoxGeometry(0.1, 0.45, 0.45), "#5b3f25", mat(-0.95, 0.22, 0)),
    part(new THREE.BoxGeometry(0.1, 0.45, 0.45), "#5b3f25", mat(0.95, 0.22, 0)),
  ]);
  const mats: THREE.Matrix4[] = [];
  for (let row = 0; row < AMPHI_ROWS; row++) {
    const R = 13 + row * 2.6;
    const half = THREE.MathUtils.degToRad(42);
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
      b.colliders.segment(x - tx * 1.05, z - tz * 1.05, x + tx * 1.05, z + tz * 1.05, 0.3, 0.51);
      for (const o of [-0.7, 0, 0.7]) b.seats.push({ x: x + tx * o, z: z + tz * o, rot: facing });
    }
  }
  return instanced(bench, new THREE.MeshLambertMaterial({ vertexColors: true }), mats);
}

/** Hoparlör konileri: bas (büyük) ve tiz (küçük), ikişer tane; müzikte ritimle öne çıkıp geri çekilir. */
function speakerCones(): { mesh: THREE.InstancedMesh; update(time: number, level: number): void } {
  const facing = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  // Kenar halkası, içe çökük koni ve ortada toz kapağı
  const cone = mergeGeometries([
    part(new THREE.CylinderGeometry(1, 1, 0.05, 16, 1, true), "#3a3e48", facing),
    part(new THREE.CylinderGeometry(0.92, 0.35, 0.16, 16, 1, true), "#4a4f5a", new THREE.Matrix4().makeTranslation(0, 0, -0.06).multiply(facing)),
    part(new THREE.CircleGeometry(0.92, 16), "#2c3038", new THREE.Matrix4().makeTranslation(0, 0, -0.02)),
    part(new THREE.SphereGeometry(0.3, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), "#5c6270", new THREE.Matrix4().makeTranslation(0, 0, -0.08).multiply(facing)),
  ]);
  const spots: [number, number, number, number][] = []; // x, y, yarıçap, hz çarpanı
  for (const sx of [-1, 1]) spots.push([sx * 12.8, 2.2, 0.48, 1], [sx * 12.8, 1.15, 0.27, 2]);
  const z = SCREEN_Z - 0.38;
  const mesh = instanced(cone, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), spots.map(([x, y, r]) => mat(x, y, z, 0, r, r, r)));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const m = new THREE.Matrix4();
  let was = 0;
  return {
    mesh,
    update(time, level) {
      if (level < 0.01 && was < 0.01) return;
      was = level;
      // 120 BPM: vuruşta hızlı öne çıkış, yavaş dönüş; araya küçük titreşim
      const kick = Math.pow(1 - ((time * 2) % 1), 3);
      spots.forEach(([x, y, r, hz], i) => {
        const beat = hz === 1 ? kick : Math.pow(1 - ((time * 4 + 0.5) % 1), 2) * 0.7 + 0.3 * Math.abs(Math.sin(time * 23));
        const p = level * beat;
        m.compose(_v.set(x, y, z + p * 0.09 * (r / 0.48)), _q.identity(), _s.set(r * (1 + p * 0.07), r * (1 + p * 0.07), r * (1 + p * 1.6)));
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/** Orman kümeleri: harita büyüyünce boş çayır yerine yer yer sık ağaçlık. [x, z, yarıçap] */
const FOREST_CLUSTERS: [number, number, number][] = [
  [48, -48, 13], [-50, -42, 12], [-62, 60, 13], [62, 46, 11], [0, -84, 14], [-84, -8, 10], [84, -18, 10], [-16, 82, 11],
];

/** Ağaç, kaya ve çalıları serper: dış sınır halkası, orman kümeleri, açık alanlara dağınık ağaçlar. */
function nature(b: Builder): void {
  const tree = (x: number, z: number, s: number, collide: boolean) => {
    b.prop(b.rand() > 0.45 ? "pine" : "oak", mat(x, heightAt(x, z) - 0.1, z, b.rand() * 6, s));
    if (collide) b.colliders.circle(x, z, 0.35 * s);
    if (Math.hypot(x, z) < WORLD_RADIUS + 4) b.shadow(x, z, 1.4 * s);
    b.clearCircle(x, z, 0.6);
  };
  // Dış sınır: iki sıra, arkadaki daha seyrek
  for (let i = 0; i < 170; i++) {
    const a = (i / 170) * Math.PI * 2 + b.rand() * 0.03;
    const r = WORLD_RADIUS + 2 + b.rand() * (i % 3 ? 8 : 18);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!b.isClear(x, z)) continue; // mahalleye açılan boşluk
    // Mahallenin çevresine ağaç: sınırı orada da belli olsun
    tree(x, z, 0.9 + b.rand() * 1.0, false);
  }
  for (const [cx, cz, cr] of FOREST_CLUSTERS) {
    const n = Math.round(cr * 2.1);
    for (let k = 0, placed = 0; placed < n && k < n * 6; k++) {
      const a = b.rand() * Math.PI * 2, d = Math.sqrt(b.rand()) * cr;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (!b.isClear(x, z)) continue;
      tree(x, z, 0.85 + b.rand() * 0.7, true);
      placed++;
    }
  }
  for (let placed = 0, tries = 0; placed < 90 && tries < 2000; tries++) {
    const a = b.rand() * Math.PI * 2;
    const r = 14 + b.rand() * (WORLD_RADIUS - 16);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!b.isClear(x, z) || Math.hypot(x, z - 8) < 6) continue;
    tree(x, z, 0.8 + b.rand() * 0.5, true);
    placed++;
  }
  for (let i = 0, n = 0; n < 90 && i < 1500; i++) {
    const a = b.rand() * Math.PI * 2;
    const r = 12 + b.rand() * (WORLD_RADIUS - 8);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!b.isClear(x, z)) continue;
    const s = 0.5 + b.rand() * 1.2;
    b.prop("rock", mat(x, 0.15 * s, z, b.rand() * 6, s, s * 0.7, s));
    if (r < WORLD_RADIUS) b.colliders.circle(x, z, 0.5 * s, 0.55 * s);
    n++;
  }
  for (let i = 0, n = 0; n < 160 && i < 2500; i++) {
    const a = b.rand() * Math.PI * 2;
    const r = 12 + b.rand() * (WORLD_RADIUS - 8);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!b.isClear(x, z)) continue;
    const s = 0.5 + b.rand() * 0.6;
    b.prop("bush", mat(x, 0.25 * s, z, b.rand() * 6, s, s * 0.75, s));
    if (r < WORLD_RADIUS) b.colliders.circle(x, z, 0.45 * s, 0.75 * s);
    b.shadow(x, z, 0.9 * s);
    n++;
  }
  // Amfinin iki yanında çalı sırası
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      const s = 0.6 + b.rand() * 0.3;
      b.prop("bush", mat(sx * (23 + b.rand()), 0.25 * s, -20 - i * 3.2, b.rand() * 6, s, s * 0.75, s));
    }
  }
}

/** Tankın park yeri: beton zemin ve sarı-siyah köşe babaları; çevresine ağaç dikilmez. */
function tankPark(b: Builder): void {
  const { x, z, h } = TANK_PARK;
  b.add(part(new THREE.BoxGeometry(6, 0.06, 8), "#8d8f8a", mat(x, 0.03, z, h), 0.05, b.rand));
  const c = Math.cos(h), s = Math.sin(h);
  for (const [ox, oz] of [[-3.2, -4.2], [3.2, -4.2], [-3.2, 4.2], [3.2, 4.2]]) {
    const bx = x + ox * c + oz * s, bz = z - ox * s + oz * c;
    for (let k = 0; k < 4; k++) b.add(part(new THREE.CylinderGeometry(0.13, 0.13, 0.2, 8), k % 2 ? "#1d1d1d" : "#f2c230", mat(bx, 0.1 + k * 0.2, bz)));
    b.colliders.circle(bx, bz, 0.15, 0.8);
  }
  b.clearCircle(x, z, 6.5);
}

/** Meydandan her bölgeye taş yol; kenarında aralıklı lambalar. */
function paths(b: Builder): void {
  const lampEvery = 13;
  const path = (ax: number, az: number, bx: number, bz: number) => {
    steppingStones(b, ax, az, bx, bz);
    const len = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    for (let d = lampEvery * 0.6, k = 0; d < len - 3; d += lampEvery, k++) {
      const side = k % 2 ? 1.7 : -1.7; // zikzak: iki yanı da aydınlansın
      const x = ax + ux * d - uz * side, z = az + uz * d + ux * side;
      b.prop("post", mat(x, 0, z));
      b.prop("bulb", mat(x, 2.7, z));
      b.colliders.circle(x, z, 0.15);
    }
  };
  const radial = (tx: number, tz: number, endPad: number) => {
    const d = Math.hypot(tx, tz), ux = tx / d, uz = tz / d;
    path(ux * 10.9, uz * 10.9, tx - ux * endPad, tz - uz * endPad);
  };
  path(-9.7, 5, -48.6, 5); // zindan
  // Zindanın arkasından mahalleye; mahallede iki sokak boyunca lambalı yol
  const streetZ = [0, 1].map((r) => HOOD.z0 + (r + 1) * PLOT_SIZE + r * HOOD_GAP + HOOD_GAP / 2);
  path(-66, 5, -90, streetZ[1] - 0.5);
  for (const z of streetZ) path(-91, z, HOOD.x0 + 1, z);
  const streetX = [0, 1].map((c) => HOOD.x0 + (c + 1) * PLOT_SIZE + c * HOOD_GAP + HOOD_GAP / 2);
  for (const x of streetX) path(x, HOOD_BOX.minZ + 2, x, HOOD_BOX.maxZ - 2);
  path(9.7, 5, GROVE.x - 7, GROVE.z); // mangal ormanı
  radial(POND.x, POND.z, 9.2);
  radial(FAME.x, FAME.z, 3.6);
  radial(SAKURA.x, SAKURA.z, SAKURA_CONFIG.radius + 0.6);
  radial(TANK_PARK.x, TANK_PARK.z, 5);
  radial(KAHVEHANE.x, KAHVEHANE.z, 8.4);
  radial(PITCH.x, PITCH.z - PITCH.hz, 2.5);
}

function grassAndFlowers(b: Builder, scene: THREE.Scene, extraGrass: THREE.Matrix4[]): void {
  // Çimen tutamı: 3 ince üçgen, dipte koyu uçta açık
  const blades: number[] = [];
  const cols: number[] = [];
  const base = new THREE.Color("#4d7a30"), tip = new THREE.Color("#9cc35a");
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI + 0.3;
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
  const look = SEASON_LOOK[SEASON];
  const palette = look.flowers.map((c) => new THREE.Color(c));
  // Büyük haritada yoğunluk aynı; uzaktakiler shader'da gömüldüğü için maliyet sınırlı.
  for (let i = 0; i < 14000 && grass.length < look.tufts; i++) {
    const a = b.rand() * Math.PI * 2;
    const r = Math.sqrt(b.rand()) * (WORLD_RADIUS + 3);
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    if (!b.isClear(x, z)) continue;
    const s = 0.7 + b.rand() * 0.8;
    grass.push(mat(x, 0, z, b.rand() * 6, s));
  }
  // Çiçekler küme küme
  for (let c = 0; c < look.flowerClusters; c++) {
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
  grass.push(...extraGrass);
  if (grass.length) {
    const tufts = instanced(tuft, withCloudShadows(windMaterial(0.28, { side: THREE.DoubleSide }, [32, 44])), grass);
    tufts.receiveShadow = true;
    scene.add(tufts);
  }

  const head = part(new THREE.OctahedronGeometry(0.075, 0), "#ffffff", new THREE.Matrix4().makeScale(1, 0.6, 1));
  if (!flowers.length) return;
  const fm = instanced(head, windMaterial(0.5, {}, [40, 52]), flowers);
  flowerColors.forEach((c, i) => fm.setColorAt(i, c));
  scene.add(fm);
}

function propMeshes(b: Builder, scene: THREE.Scene): { bulbMaterial: THREE.MeshBasicMaterial } {
  const r = b.rand;
  const look = SEASON_LOOK[SEASON];
  // Ağaçlarda alt kapaklar hiç görünmez (kamera zeminin altına inmez): openEnded ile üçgen sayısı yarıya iner.
  const geos: Record<PropKind, THREE.BufferGeometry> = {
    pine: mergeGeometries([
      part(new THREE.CylinderGeometry(0.18, 0.25, 1.4, 6, 1, true), "#6b4a2f", mat(0, 0.7, 0)),
      part(new THREE.ConeGeometry(1.3, 2.2, 6, 1, true), look.pine[0], mat(0, 2.2, 0), 0.25, r),
      part(new THREE.ConeGeometry(0.95, 1.8, 6, 1, true), look.pine[1], mat(0, 3.2, 0), 0.25, r),
    ]),
    oak: mergeGeometries([
      part(new THREE.CylinderGeometry(0.16, 0.26, 1.8, 6, 1, true), "#6e4b2e", mat(0, 0.9, 0)),
      part(new THREE.IcosahedronGeometry(1.25, 0), look.oak[0], mat(0, 2.6, 0, 0, 1, 0.9, 1), 0.3, r),
      part(new THREE.IcosahedronGeometry(0.85, 0), look.oak[1], mat(0.6, 3.2, 0.3), 0.3, r),
      part(new THREE.IcosahedronGeometry(0.7, 0), look.oak[2], mat(-0.6, 2.9, -0.4), 0.3, r),
    ]),
    // Geniş, yayvan pembe taç; gövde hafif eğik
    sakura: mergeGeometries([
      part(new THREE.CylinderGeometry(0.13, 0.24, 1.9, 6, 1, true), "#4e342b", mat(0, 0.95, 0).multiply(new THREE.Matrix4().makeRotationZ(0.08))),
      part(new THREE.CylinderGeometry(0.06, 0.1, 1.2, 5, 1, true), "#4e342b", mat(0.45, 2.0, 0.1).multiply(new THREE.Matrix4().makeRotationZ(-0.7))),
      part(new THREE.IcosahedronGeometry(1.3, 0), look.sakura[0], mat(0.1, 2.55, 0, 0, 1.35, 0.75, 1.3), 0.25, r),
      part(new THREE.IcosahedronGeometry(0.95, 0), look.sakura[1], mat(1.0, 2.85, 0.35, 0, 1.1, 0.8, 1.1), 0.25, r),
      part(new THREE.IcosahedronGeometry(0.85, 0), look.sakura[2], mat(-0.85, 2.6, -0.45, 0, 1.15, 0.8, 1.1), 0.25, r),
      part(new THREE.IcosahedronGeometry(0.65, 0), look.sakura[3], mat(0.15, 3.3, -0.2), 0.25, r),
    ]),
    rock: part(new THREE.IcosahedronGeometry(0.6, 0), "#8b8f94", undefined, 0.2, r),
    bush: mergeGeometries([
      part(new THREE.IcosahedronGeometry(0.7, 0), look.bush[0], undefined, 0.3, r),
      part(new THREE.IcosahedronGeometry(0.45, 0), look.bush[1], mat(0.45, 0.15, 0.2), 0.3, r),
    ]),
    stone: part(new THREE.CylinderGeometry(1, 1, 0.06, 7), "#b9b2a2", undefined, 0.1, r),
    post: part(new THREE.CylinderGeometry(0.07, 0.1, 2.6, 6), "#2f3440", mat(0, 1.3, 0)),
    bulb: new THREE.SphereGeometry(0.22, 8, 6),
    flame: new THREE.ConeGeometry(0.16, 0.42, 6).translate(0, 0.1, 0),
    log: part(new THREE.CylinderGeometry(0.22, 0.24, 1.55, 7), "#7b5233", new THREE.Matrix4().makeRotationZ(Math.PI / 2), 0.15, r),
  };
  const lambert = new THREE.MeshLambertMaterial({ vertexColors: true });
  const flat = withWetness(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  const materials: Record<PropKind, THREE.Material> = {
    pine: withCloudShadows(windMaterial(0.03, { side: THREE.DoubleSide })),
    oak: withCloudShadows(windMaterial(0.04, { side: THREE.DoubleSide })),
    sakura: withCloudShadows(windMaterial(0.04, { side: THREE.DoubleSide })),
    rock: flat,
    bush: withCloudShadows(windMaterial(0.05)),
    stone: flat,
    post: lambert,
    bulb: new THREE.MeshBasicMaterial({ color: "#ffe9a8", fog: false }),
    flame: flickerMaterial("#ffa12e"),
    log: flat,
  };
  // Gölge düşürenler: ağaçlar, kayalar, çalılar, direkler, kütükler (düz taşlar ve ışıklar değil)
  const casters: PropKind[] = ["pine", "oak", "sakura", "rock", "bush", "post", "log"];
  for (const kind of Object.keys(geos) as PropKind[]) {
    if (!b.props[kind].length) continue;
    const m = instanced(geos[kind], materials[kind], b.props[kind]);
    m.castShadow = casters.includes(kind);
    m.receiveShadow = kind !== "bulb" && kind !== "flame";
    scene.add(m);
  }
  return { bulbMaterial: materials.bulb as THREE.MeshBasicMaterial };
}

/**
 * Ağaç/çalı altı lekeleri. Gerçek gölge açıkken `focus` (x, z, yarıçap) çevresinde silinir:
 * yakında gerçek gölge, uzakta leke; ikisi üst üste binmez.
 */
function shadowsMesh(b: Builder, focus: { value: THREE.Vector3 }): THREE.InstancedMesh {
  const mats: THREE.Matrix4[] = [];
  for (let i = 0; i < b.shadows.length; i += 3) {
    const s = b.shadows[i + 2] * 2;
    mats.push(flatMat(b.shadows[i], 0.036, b.shadows[i + 1], s, s));
  }
  const material = new THREE.MeshBasicMaterial({ map: blobTexture(0.32), transparent: true, depthWrite: false });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBlobFocus = focus;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uBlobFocus;\nvarying float vBlobFade;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 bw = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vBlobFade = uBlobFocus.z > 0.0 ? smoothstep(uBlobFocus.z * 0.6, uBlobFocus.z * 0.95, distance(bw.xz, uBlobFocus.xy)) : 1.0;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vBlobFade;")
      .replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.a *= vBlobFade;");
  };
  material.customProgramCacheKey = () => "blob-fade";
  const m = instanced(new THREE.PlaneGeometry(1, 1), material, mats);
  m.renderOrder = 1;
  return m;
}

/**
 * Ufuktaki dağlar: sivri, keskin sırtlı tepeler (her biri ana zirve + yan zirveler); tek mesh,
 * sisten etkilenmez, DayNight ufuk rengiyle puslar.
 */
function mountains(b: Builder): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const haze = new THREE.Color("#8fb0bf"), dark = new THREE.Color("#5f7a78"), rock = new THREE.Color("#7d8a8f"), snow = new THREE.Color("#f2f5f7");
  const peak = (x: number, z: number, h: number, rad: number, base: number) => {
    const g = new THREE.ConeGeometry(rad, h, 5, 3).toNonIndexed();
    g.deleteAttribute("uv");
    // Tepeyi biraz kaydır: simetrik koni yerine yamuk, kayalık zirve
    const pos = g.attributes.position;
    const lean = (b.rand() - 0.5) * rad * 0.35;
    for (let v = 0; v < pos.count; v++) {
      const t = (pos.getY(v) + h / 2) / h;
      pos.setX(v, pos.getX(v) + lean * t * t);
    }
    g.applyMatrix4(mat(x, h / 2 + base, z, b.rand() * 6));
    const cols = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v += 3) {
      // Üçgen başına renk: alt yamaç koyu ve yeşilimsi, yukarısı kaya, en tepe kar
      const t = ((pos.getY(v) + pos.getY(v + 1) + pos.getY(v + 2)) / 3 - base) / h;
      tmp.copy(dark).lerp(rock, Math.min(1, t * 1.6)).lerp(haze, 0.3 + b.rand() * 0.12);
      if (h > 46 && t > 0.7) tmp.copy(snow).multiplyScalar(0.92 + b.rand() * 0.08);
      for (let k = 0; k < 3; k++) tmp.toArray(cols, (v + k) * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    parts.push(g);
  };
  for (let i = 0; i < 52; i++) {
    const a = (i / 52) * Math.PI * 2 + b.rand() * 0.1;
    let dist = 178 + b.rand() * 32;
    const h = 30 + b.rand() * 48;
    const rad = 16 + b.rand() * 18;
    // Mahalle düzlüğüne taşmasın: üstüne biniyorsa geriye it
    const overlapsHood = (d: number) => {
      const px = Math.sin(a) * d, pz = Math.cos(a) * d;
      const dx = Math.max(HOOD_BOX.minX - px, 0, px - HOOD_BOX.maxX), dz = Math.max(HOOD_BOX.minZ - pz, 0, pz - HOOD_BOX.maxZ);
      return Math.hypot(dx, dz) < rad * 1.6 + 10;
    };
    while (overlapsHood(dist) && dist < 260) dist += 4;
    const x = Math.sin(a) * dist, z = Math.cos(a) * dist;
    peak(x, z, h, rad, -2);
    // Yan zirveler: aynı sırtta, alçak
    const tx = Math.cos(a), tz = -Math.sin(a);
    for (const side of [-1, 1]) {
      if (b.rand() < 0.35) continue;
      const off = rad * (0.6 + b.rand() * 0.5) * side;
      peak(x + tx * off, z + tz * off, h * (0.45 + b.rand() * 0.3), rad * (0.6 + b.rand() * 0.25), -2);
    }
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
  for (let i = 0; i < 26; i++) {
    const a = b.rand() * Math.PI * 2;
    const r = 30 + b.rand() * 140;
    mats.push(mat(Math.sin(a) * r, 55 + b.rand() * 25, Math.cos(a) * r, b.rand() * 6, 1 + b.rand() * 1.2));
  }
  const m = instanced(puff, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, fog: false, emissive: "#9aa9bd" }), mats);
  m.matrixAutoUpdate = true;
  return m;
}

// Çeşme: fıskiyeden yükselen su, üst kâseden taşıp havuza dökülen perde ve iki dalgalı su yüzeyi.
const JET_Y = 1.9; // fıskiye ağzı
const BOWL_Y = 1.715, BOWL_R = 0.75; // üst kâse suyu
const BASIN_Y = 0.61, BASIN_R = 1.9; // alt havuz suyu
const RIM_R = 0.9, RIM_Y = 1.68; // taşmanın başladığı kâse kenarı
const JET_V = 4.2, JET_SPREAD = 0.32, SPILL_V = 0.7, GRAVITY = 9.8;
/** Fıskiye damlası kâseye geri düşene kadar geçen süre. */
const JET_TIME = (2 * JET_V) / GRAVITY - 0.02;
const SPILL_TIME = Math.sqrt((2 * (RIM_Y - BASIN_Y)) / GRAVITY);
/** Taşan suyun havuza değdiği çember: halkalar buradan yayılır. */
const SPILL_LAND_R = RIM_R + SPILL_V * SPILL_TIME;

function fountain(): { parts: THREE.Object3D[]; light: { value: number } } {
  const center = { value: new THREE.Vector2(0, 0) };
  const disc = (y: number, r: number, ringR: number, hole: number) => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 28).applyMatrix4(flatMat(0, y, 0)), waterMaterial(0, 0, r, center, ringR, hole));
    m.matrixAutoUpdate = false;
    return m;
  };

  // Damlalar tamamen vertex shader'da balistik yay çizer; aKind 0 fıskiye, 1 taşma
  const jets = 90, spills = 170, n = jets + spills;
  const geo = new THREE.PlaneGeometry(1, 1);
  const seed = new Float32Array(n), kind = new Float32Array(n), angle = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed[i] = Math.random();
    kind[i] = i < jets ? 0 : 1;
    angle[i] = i < jets ? Math.random() * Math.PI * 2 : ((i - jets) / spills) * Math.PI * 2 + Math.random() * 0.05;
  }
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
  geo.setAttribute("aKind", new THREE.InstancedBufferAttribute(kind, 1));
  geo.setAttribute("aAngle", new THREE.InstancedBufferAttribute(angle, 1));
  const light = { value: 1 };
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, uLight: light },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      attribute float aKind;
      attribute float aAngle;
      uniform float uTime;
      varying vec2 vLocal;
      varying float vAlpha;
      void main() {
        vec2 dir = vec2(cos(aAngle), sin(aAngle));
        vec3 p;
        float life, t;
        if (aKind < 0.5) {
          life = ${JET_TIME.toFixed(3)};
          t = fract(uTime / life + aSeed) * life;
          float spread = ${JET_SPREAD.toFixed(2)} * fract(aSeed * 7.31);
          p = vec3(dir.x * spread * t, ${JET_Y.toFixed(2)} + ${JET_V.toFixed(2)} * t - ${(GRAVITY / 2).toFixed(2)} * t * t, dir.y * spread * t);
        } else {
          life = ${SPILL_TIME.toFixed(3)};
          t = fract(uTime / life + aSeed) * life;
          float v = ${SPILL_V.toFixed(2)} * (0.85 + 0.3 * fract(aSeed * 3.7));
          float r = ${RIM_R.toFixed(2)} + v * t;
          p = vec3(dir.x * r, ${RIM_Y.toFixed(2)} - ${(GRAVITY / 2).toFixed(2)} * t * t, dir.y * r);
        }
        float k = t / life;
        vAlpha = smoothstep(0.0, 0.08, k) * (1.0 - smoothstep(0.85, 1.0, k)) * (aKind < 0.5 ? 0.75 : 0.55);
        vLocal = uv * 2.0 - 1.0;
        vec4 center = modelViewMatrix * vec4(p, 1.0);
        float size = aKind < 0.5 ? 0.075 : 0.06;
        gl_Position = projectionMatrix * (center + vec4(position.xy * size, 0.0, 0.0));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLight;
      varying vec2 vLocal;
      varying float vAlpha;
      void main() {
        float d = dot(vLocal, vLocal);
        if (d > 1.0) discard;
        gl_FragColor = vec4(vec3(0.86, 0.94, 1.0) * uLight, vAlpha * (1.0 - d * 0.7));
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const drops = instanced(geo, material, Array.from({ length: n }, () => new THREE.Matrix4()));
  drops.frustumCulled = false;
  drops.renderOrder = 2;

  return { parts: [disc(BASIN_Y, BASIN_R, SPILL_LAND_R, 0.0), disc(BOWL_Y, BOWL_R, 0, 0.06), drops], light };
}

/** Mangal dumanı: birkaç billboard, tamamen vertex shader'da yükselip solar. */
function smoke(at: THREE.Vector3): THREE.InstancedMesh {
  const n = 10;
  const geo = new THREE.PlaneGeometry(1, 1);
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) seeds[i] = i / n;
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, uBoost: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uBoost;
      varying vec2 vLocal;
      varying float vAlpha;
      void main() {
        float t = fract(uTime * 0.22 + aSeed);
        vec3 p = vec3(sin(aSeed * 40.0 + uTime * 0.7) * 0.35 * t, t * 3.4, cos(aSeed * 23.0) * 0.3 * t);
        vec4 center = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        float size = (0.35 + t * 1.1) * (1.0 + uBoost * 0.8);
        vAlpha = smoothstep(0.0, 0.12, t) * (1.0 - t) * 0.42 * (1.0 + uBoost * 1.2);
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

export function buildWorld(opts: WorldOptions = {}): World {
  SEASON = opts.season ?? seasonOf();
  const b = new Builder();
  const scene = new THREE.Scene();
  scene.background = SKY.clone();
  scene.fog = new THREE.Fog(SKY, 55, 140);

  const hemi = new THREE.HemisphereLight("#dcefff", "#56683a", 1.6);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#fff1d6", 1.7);
  sun.position.copy(MOON_DIR).multiplyScalar(40);
  scene.add(sun, sun.target);
  // Gölge kamerası oyuncuyla birlikte kayar (update); düşük poli yüzeylerde lekelenme olmasın diye normal kaydırma
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 220;
  /** Gerçek gölge kutusunun merkezi ve yarıçapı (0: kapalı); zemin lekeleri burada silinir. */
  const blobFocus = { value: new THREE.Vector3(0, 0, 0) };
  let shadowHalf = 0;
  const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _snap = new THREE.Vector3();

  // Gökyüzü kubbesi (tek draw call, sisten etkilenmez); su aynı renkleri yansıtır
  const sky = skyDome(240);
  scene.add(sky.mesh);
  waterEnv.uSkyH.value = sky.uniforms.uHorizon.value;
  waterEnv.uSkyT.value = sky.uniforms.uTop.value;
  waterEnv.uSunDir.value = sky.uniforms.uSunDir.value;
  waterEnv.uFrozen.value = SEASON === "winter" ? 1 : 0;
  waterEnv.uMoonDir.value.copy(MOON_DIR);
  wetEnv.uWetSkyH.value = sky.uniforms.uHorizon.value;
  wetEnv.uWetSkyT.value = sky.uniforms.uTop.value;
  wetEnv.uWetSun.value = sky.uniforms.uSunDir.value;
  /** Yağmurda zemin ıslanır (~40 sn), bitince yavaşça kurur (~4 dk). */
  let wetTarget = 0, lastTime = 0, weatherKnown = false;

  ground(b);
  plaza(b);
  const benches = amphitheatre(b);
  benches.castShadow = benches.receiveShadow = true;
  scene.add(benches);
  const speakers = speakerCones();
  scene.add(speakers.mesh);
  const dz = dungeon(b);
  const gr = grove(b);
  signPost(b, GROVE_SIGN.x + 0.1, GROVE_SIGN.z, 2.1);
  const pd = pond(b);
  const garden = sakuraGarden(b);
  tankPark(b);
  // Mahalle: arsalara ağaç/kaya dikilmez (bloklar ve tabelalar features'ta)
  b.clearBox(HOOD_BOX.minX, HOOD_BOX.maxX, HOOD_BOX.minZ, HOOD_BOX.maxZ);
  scene.add(pd.water, pd.ducks);
  fameStatics(b);
  const kh = kahvehane(b);
  const field = pitch(b);
  scene.add(field.group);
  djBooth(b);
  stageTruss(b);
  const lights = stageLights();
  scene.add(lights.group);
  const dirSigns = directionPost(b);
  paths(b);
  nature(b);

  const statics = new THREE.Mesh(mergeGeometries(b.statics), withWetness(withCloudShadows(new THREE.MeshLambertMaterial({ vertexColors: true }))));
  statics.matrixAutoUpdate = false;
  statics.castShadow = statics.receiveShadow = true;
  scene.add(statics);
  const { bulbMaterial } = propMeshes(b, scene);
  grassAndFlowers(b, scene, garden.grass);
  scene.add(garden.petals);
  scene.add(shadowsMesh(b, blobFocus));
  const mountainMesh = mountains(b);
  scene.add(mountainMesh);
  const cloudMesh = clouds(b);
  scene.add(cloudMesh);
  scene.add(
    signsMesh([
      { at: dz.signAt, w: 2.8, h: 0.7, cell: SIGN_DUNGEON },
      { at: gr.signAt, w: 2.2, h: 0.55, cell: SIGN_GROVE },
      { at: kh.signAt, w: 3.2, h: 0.8, cell: SIGN_KAHVE },
      ...dirSigns,
    ]),
  );
  scene.add(gr.coals);
  const fame = new FameBoard();
  fame.group.traverse((o) => (o.castShadow = o instanceof THREE.InstancedMesh));
  scene.add(fame.group);
  const fnt = fountain();
  scene.add(...fnt.parts);
  const smokeMesh = smoke(gr.smokeAt);
  scene.add(smokeMesh);
  const smokeBoost = (smokeMesh.material as THREE.ShaderMaterial).uniforms.uBoost;
  // Gece: yakın lambalarda gerçek ışık (sayı sabit; zayıf cihazda yok), ateş böcekleri, ay
  const night = new NightFx({
    bulbs: b.props.bulb,
    flames: b.props.flame,
    swarms: [...FOREST_CLUSTERS.slice(0, 6), [SAKURA.x, SAKURA.z, SAKURA_CONFIG.radius], [POND.x, POND.z, 11], [GROVE.x, GROVE.z, 10]],
    lights: opts.lamps ?? 6,
    skyRadius: 240,
    moonDir: MOON_DIR,
  });
  scene.add(night.group);
  // Kışın çimen karın altında
  const grass = opts.grass === false || SEASON === "winter"
    ? null
    : new GrassField(
        {
          min: -(WORLD_RADIUS + 4),
          size: (WORLD_RADIUS + 4) * 2,
          allowed: (x, z) => (Math.hypot(x, z) < WORLD_RADIUS + 2 && b.isClear(x, z) ? 1 : 0),
          color: groundColor,
        },
        30000,
      );
  if (grass) {
    grass.mesh.receiveShadow = true;
    withCloudShadows(grass.mesh.material as THREE.Material);
    scene.add(grass.mesh);
  }
  if (SEASON === "winter") pd.ducks.visible = false;
  // Mangal ateşinin titreyen ışığı (gerçek lamba ışıkları açıksa)
  const fire = (opts.lamps ?? 6) > 0 ? new THREE.PointLight("#ff8a3a", 0, 10, 1.7) : null;
  if (fire) {
    fire.position.copy(gr.smokeAt).setY(1.6);
    scene.add(fire);
  }
  const env = { day: 1, lights: 0, dusk: 0 };
  let music = 0, musicOn = false;
  const dayNight = new DayNight(
    {
      scene,
      sky,
      hemi,
      sun,
      bulbMaterial,
      cloudMaterial: cloudMesh.material as THREE.MeshLambertMaterial,
      mountainMaterial: mountainMesh.material as THREE.MeshLambertMaterial,
      bulbMatrices: b.props.bulb,
      moonDir: MOON_DIR,
    },
    opts.hour,
    env,
  );
  let boostUntil = 0;
  let lastFlash = 0;

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
    update(time: number, focus?: { x: number; z: number }) {
      timeUniform.value = time;
      const dt = Math.min(0.25, Math.max(0, time - lastTime));
      lastTime = time;
      const wet = wetUniform.value;
      wetUniform.value = wet < wetTarget ? Math.min(wetTarget, wet + dt / 40) : Math.max(wetTarget, wet - dt / 240);
      night.update(time, env.lights, focus?.x ?? 0, focus?.z ?? 8);
      music += ((musicOn ? 1 : 0) - music) * 0.08;
      speakers.update(time, music);
      cloudMesh.rotation.y = time * 0.004;
      pd.update(time);
      const boost = Math.min(1, Math.max(0, (boostUntil - time) / 4));
      smokeBoost.value = boost;
      // Şiş çevrilince köz daha hızlı ve parlak titrer
      const flick = 0.5 + 0.5 * Math.sin(time * (7 + boost * 9)) * Math.sin(time * 3.3);
      coalColor.copy(coalA).lerp(coalB, Math.min(1, flick + boost * 0.5));
      if (fire) fire.intensity = (0.6 + env.lights * 3.2) * (0.75 + 0.35 * flick + boost * 0.4);
      dayNight.update(Date.now());
      waterEnv.uNight.value = 1 - env.day;
      // Damlalar ışıktan etkilenmez: gece gökyüzüyle birlikte kararsınlar
      fnt.light.value = 0.35 + 0.65 * Math.min(1, hemi.intensity / 1.6);
      if (sun.castShadow) {
        // Gölge kutusu oyuncuyu izler; ışık uzayında texel adımlarına oturtulur (kayarken titremesin)
        const dir = dayNight.lightDir;
        const texel = (shadowHalf * 2) / sun.shadow.mapSize.x;
        _right.crossVectors(THREE.Object3D.DEFAULT_UP, dir).normalize();
        _up.crossVectors(dir, _right);
        const fx = focus?.x ?? 0, fz = focus?.z ?? 8;
        const r = Math.round((_right.x * fx + _right.z * fz) / texel) * texel;
        const u = Math.round((_up.x * fx + _up.z * fz) / texel) * texel;
        const f = dir.x * fx + dir.z * fz;
        _snap.copy(_right).multiplyScalar(r).addScaledVector(_up, u).addScaledVector(dir, f);
        sun.target.position.copy(_snap);
        sun.position.copy(_snap).addScaledVector(dir, 100);
        sun.target.updateMatrixWorld();
        blobFocus.value.set(fx, fz, shadowHalf);
      } else {
        sun.position.copy(sun.target.position).addScaledVector(dayNight.lightDir, 40);
      }
    },
    setHour(h: number | null) {
      dayNight.setHour(h);
    },
    setWeather(w: Weather) {
      dayNight.setWeather(w);
      waterEnv.uRain.value = w.kind === "rain" || w.kind === "storm" ? 0.4 + 0.6 * w.intensity : 0;
      wetEnv.uWetRain.value = waterEnv.uRain.value;
      // Kışın kar yağar, zemin ıslanmaz; sis hafif nem bırakır
      wetTarget = SEASON === "winter" || w.kind === "snow" ? 0 : waterEnv.uRain.value ? 0.6 + 0.4 * w.intensity : w.kind === "fog" ? 0.25 : 0;
      // Girişte yağıyorsa zemin zaten ıslak
      if (!weatherKnown) wetUniform.value = wetTarget;
      weatherKnown = true;
    },
    flash(v: number) {
      hemi.intensity = dayNight.hemiBase + v * 2.5;
      sun.intensity = dayNight.sunBase + v * 6;
      if (v > 0.01) sun.color.setRGB(0.85, 0.9, 1);
      else if (lastFlash > 0.01) dayNight.refresh();
      lastFlash = v;
    },
    hour: () => dayNight.hour,
    pitch: field,
    stageLights: lights,
    ripple: addRipple,
    season: SEASON,
    setShadows(level: ShadowLevel) {
      const cfg = level === "off" ? null : SHADOW[level];
      sun.castShadow = !!cfg;
      blobFocus.value.z = 0;
      if (!cfg) return;
      shadowHalf = cfg.half;
      if (sun.shadow.mapSize.x !== cfg.size) {
        sun.shadow.mapSize.set(cfg.size, cfg.size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      const cam = sun.shadow.camera;
      cam.left = cam.bottom = -cfg.half;
      cam.right = cam.top = cfg.half;
      cam.updateProjectionMatrix();
    },
    sakura: garden,
    sunDir: sky.uniforms.uSunDir.value,
    env,
    grass,
    setMusic(on: boolean) {
      musicOn = on;
    },
    speakers: [-1, 1].map((sx) => ({ x: sx * 12.8, y: 3.1, z: SCREEN_Z - 0.9 })),
    grillBoost(time: number) {
      boostUntil = Math.max(boostUntil, time) + 4;
      if (boostUntil - time > 10) boostUntil = time + 10;
    },
  };
}
