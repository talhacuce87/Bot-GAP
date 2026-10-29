// Arabalar: Tofaşlar (Şahin sedan, Doğan SLX, Kartal station) ve Türkiye yollarının efsaneleri (Linea 1.3
// Multijet, Doblo, Passat B5 TDI, BMW E30). Yandan silüetten çekilen gövde (çamurluk kemerleri, eğimli ön/arka
// cam, yuvarlatılmış kenarlar), şeffaf camların ardında torpido, koltuklar ve direksiyon. Her modelin ölçüleri
// (SHAPES) ve kendi ön ve arka yüzü var: Şahin ikiz köşeli far ve kromlu ızgara, Doğan tek parça far, Kartal
// dikey stoplar, Linea çekik farlar, Passat kromlu geniş ızgara, E30 dörtlü yuvarlak far ve böbrek ızgara,
// Doblo yüksek kutu gövde. Jant lastiğin içine gömülü katmanlarda (yüzeyler üst üste binmez). Neon yere yumuşak
// bir ışık hâlesi olarak vurur; altında temas gölgesi.
//
// Yerel +z ön, +x sol (sürücü tarafı), araba merkezi orijinde ve tekerlekler yerde.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CAR_COLORS, CAR_LIGHTS, CAR_NEONS, type CarDents, type CarSpec } from "../../../shared/car";
import { mat, part } from "./geo";

/**
 * Modelin ölçüleri (yan silüet, z öne): genişlik, ön/arka uç, aks (±), iz, lastik, bel çizgisi ve tavan
 * yüksekliği, kabin genişliği; ön camın alt/üst ucu (cabFront/wsTop), tavanın arka ucu, kabinin arka ucu ve
 * oradaki yükseklik, B (ve C) direği, burun ve kaput yüksekliği, bagajın arka kenarı ve kaputla birleştiği yer.
 */
interface Shape {
  W: number;
  ZF: number;
  ZR: number;
  AXLE: number;
  TRACK: number;
  TIRE_R: number;
  BELT: number;
  ROOF: number;
  CAB_W: number;
  cabFront: number;
  wsTop: number;
  roofRear: number;
  cabRear: number;
  cabRearY: number;
  bPillar: number;
  cPillar?: number;
  noseY: number;
  hoodY: number;
  deckY: number;
  deck?: [number, number];
  /** Station/van: kabin arkaya kadar. */
  wagon?: boolean;
}

/** Tofaş ölçüleri (gerçek: 4,33 × 1,64 × 1,39 m, aks aralığı 2,49 m). */
const TOFAS: Shape = {
  W: 1.64, ZF: 2.17, ZR: -2.17, AXLE: 1.245, TRACK: 0.7, TIRE_R: 0.31, BELT: 0.93, ROOF: 1.39, CAB_W: 1.4,
  cabFront: 1.0, wsTop: 0.3, roofRear: -0.7, cabRear: -1.13, cabRearY: 0.95, bPillar: -0.17, noseY: 0.78, hoodY: 0.845, deckY: 0.93, deck: [-1.15, 0.955],
};
const SHAPES: Record<CarSpec["model"], Shape> = {
  sahin: TOFAS,
  dogan: TOFAS,
  kartal: { ...TOFAS, roofRear: -1.98, cabRear: -2.05, cabRearY: TOFAS.BELT, cPillar: -1.1, deckY: TOFAS.BELT, deck: undefined, wagon: true },
  // Linea: uzun, yüksek bagajlı, yatık ön camlı modern sedan
  linea: {
    W: 1.73, ZF: 2.28, ZR: -2.28, AXLE: 1.3, TRACK: 0.74, TIRE_R: 0.32, BELT: 0.98, ROOF: 1.49, CAB_W: 1.5,
    cabFront: 1.28, wsTop: 0.36, roofRear: -0.72, cabRear: -1.38, cabRearY: 1.04, bPillar: -0.1, noseY: 0.82, hoodY: 0.9, deckY: 1.01, deck: [-1.42, 1.05],
  },
  // Doblo: yüksek kutu gövde, dik ön cam, sürgülü yan kapı
  doblo: {
    W: 1.72, ZF: 2.08, ZR: -2.08, AXLE: 1.3, TRACK: 0.74, TIRE_R: 0.31, BELT: 1.02, ROOF: 1.84, CAB_W: 1.64,
    cabFront: 1.3, wsTop: 0.5, roofRear: -2.0, cabRear: -2.06, cabRearY: 1.02, bPillar: 0.05, cPillar: -1.05, noseY: 0.88, hoodY: 0.97, deckY: 1.02, wagon: true,
  },
  // Passat B5: uzun, yuvarlak hatlı sedan
  passat: {
    W: 1.74, ZF: 2.35, ZR: -2.35, AXLE: 1.36, TRACK: 0.75, TIRE_R: 0.32, BELT: 0.96, ROOF: 1.46, CAB_W: 1.5,
    cabFront: 1.2, wsTop: 0.3, roofRear: -0.85, cabRear: -1.42, cabRearY: 1.0, bPillar: -0.15, noseY: 0.8, hoodY: 0.88, deckY: 0.98, deck: [-1.47, 1.01],
  },
  // E30: alçak, köşeli, dik camlı klasik sedan
  e30: {
    W: 1.65, ZF: 2.16, ZR: -2.16, AXLE: 1.285, TRACK: 0.7, TIRE_R: 0.3, BELT: 0.88, ROOF: 1.36, CAB_W: 1.42,
    cabFront: 0.95, wsTop: 0.36, roofRear: -0.78, cabRear: -1.06, cabRearY: 0.9, bPillar: -0.16, noseY: 0.76, hoodY: 0.8, deckY: 0.88, deck: [-1.1, 0.9],
  },
  // İş araçları: taksi Doblo gövdesiyle kurulur, scooter ayrı (motor.ts); yer tutucu
  taksi: TOFAS,
  motor: TOFAS,
  scooter: TOFAS,
};

const TIRE_W = 0.19;
/** Yuvarlatma payı: gövdenin gerçek ön/arka yüzü ve üstü silüetten bu kadar dışarıda. */
const BEV = 0.035;
const TRIM = "#1b1c1f";
const CHROME = "#cfd3d8";
const RUBBER = "#121315";

const MODEL_NAMES: Record<CarSpec["model"], string> = { sahin: "ŞAHİN", dogan: "DOĞAN SLX", kartal: "KARTAL", linea: "LINEA", doblo: "DOBLÒ", passat: "PASSAT", e30: "316i", taksi: "DOBLÒ", motor: "GAP", scooter: "GAP" };
/** Bagajın solundaki ikinci yazı (motor). */
const ENGINE_BADGE: Partial<Record<CarSpec["model"], string>> = { linea: "1.3 MULTIJET", passat: "TDI", doblo: "1.3 MULTIJET" };

/** Far ve stop halesi: merkezden yumuşakça sönen yuvarlak parıltı (bir kez üretilir). */
let roundGlowTex: THREE.CanvasTexture | null = null;
function roundGlow(): THREE.CanvasTexture {
  if (roundGlowTex) return roundGlowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.12)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  roundGlowTex = new THREE.CanvasTexture(c);
  roundGlowTex.colorSpace = THREE.SRGBColorSpace;
  return roundGlowTex;
}

/** Bir kez üretilen dokular: yumuşak ışık hâlesi (neon) ve yumuşak gölge. */
let glowTex: THREE.CanvasTexture | null = null;
let shadowTex: THREE.CanvasTexture | null = null;
export function softTexture(kind: "glow" | "shadow"): THREE.CanvasTexture {
  const cached = kind === "glow" ? glowTex : shadowTex;
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const g = c.getContext("2d")!;
  // Yuvarlatılmış dikdörtgenin çevresine doğru sönen yoğunluk (kat kat bulanık dolgu)
  const layers = kind === "glow" ? 18 : 12;
  for (let i = 0; i < layers; i++) {
    const t = i / layers, inset = 6 + t * (kind === "glow" ? 46 : 38);
    g.fillStyle = kind === "glow" ? `rgba(255,255,255,${0.06 + t * 0.05})` : `rgba(0,0,0,${0.05 + t * 0.06})`;
    g.beginPath();
    g.roundRect(inset, inset * 1.5, 128 - inset * 2, 256 - inset * 3, 40 - t * 30);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  if (kind === "glow") glowTex = tex;
  else shadowTex = tex;
  return tex;
}

function labelTexture(draw: (g: CanvasRenderingContext2D) => void, w = 256, h = 56): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function plateTexture(text: string): THREE.CanvasTexture {
  return labelTexture((g) => {
    g.fillStyle = "#111";
    g.fillRect(0, 0, 256, 56);
    g.fillStyle = "#f7f7f2";
    g.fillRect(3, 3, 250, 50);
    g.fillStyle = "#1f4fbf";
    g.fillRect(3, 3, 30, 50);
    g.fillStyle = "#fff";
    g.font = "700 16px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText("TR", 18, 46);
    g.fillStyle = "#111";
    g.font = "800 34px system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillText(text, 144, 30);
  });
}

/** Krom harfli model yazısı (bagajın sağında) ya da taksi tepe lambası yazısı. */
function badgeTexture(text: string, color = "#e9edf1", bg = ""): THREE.CanvasTexture {
  return labelTexture((g) => {
    if (bg) {
      g.fillStyle = bg;
      g.fillRect(0, 0, 256, 56);
    }
    g.fillStyle = color;
    g.font = "900 italic 38px system-ui, sans-serif";
    // Uzun yazı (1.3 MULTIJET) küçülerek sığar
    const w = g.measureText(text).width;
    if (w > 236) g.font = `900 italic ${Math.floor((38 * 236) / w)}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.shadowColor = "rgba(0,0,0,0.6)";
    g.shadowBlur = 3;
    g.fillText(text, 128, 30);
  });
}

/** Yandan silüet (z, y) → x boyunca genişliğe çekilmiş, kenarları yuvarlatılmış katı. */
function extrude(shape: THREE.Shape, width: number, bevel: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 14 });
  g.translate(0, 0, -(width - 2 * bevel) / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

function poly(pts: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  pts.forEach(([z, y], i) => (i ? s.lineTo(z, y) : s.moveTo(z, y)));
  s.closePath();
  return s;
}

export interface TofasMesh {
  group: THREE.Group;
  /** Far camının rengi (gerçek far ışığı da bu renkte). */
  headColor: THREE.Color;
  /** Neon ve farların gece parlaklığı (0–1). */
  setNight(n: number): void;
  /**
   * Farlar (0 kapalı – 1 gece tam): far ve stop haleleri; `haze` (yağmur 0–1) kadar havada huzme; `decal`
   * yolda ışık lekesi (gerçek far ışığı olmayan düşük grafikte); `high` uzun far (selektör): daha parlak ve uzun.
   */
  setHeadlights(n: number, o?: { decal?: boolean; haze?: number; high?: boolean }): void;
  /** Fren lambaları (stoplar parlar). */
  setBrake(on: boolean): void;
  /** Gövdenin yatışı: `roll` yana (+ sola), `pitch` öne-arkaya (+ burun aşağı), radyan. */
  setLean(roll: number, pitch: number): void;
  /** Tekerlekler: `dist` metre yuvarlanır (geri giderken eksi), ön tekerlekler `steer` radyan döner. */
  roll(dist: number, steer: number): void;
  /** Hasar (0 yok – 3 ağır): boya kararır, tozlanır. */
  setDamage(level: number): void;
  /** Göçükler (çarpılan taraf içeri çöker), kırık farlar, ağır hasarda sarkan tampon ve aralanan kapı. */
  setDents(d: CarDents): void;
  dispose(): void;
}

/** Tavanın yerden yüksekliği (taksi tepe lambasıyla): içindekinin isim etiketi bunun üstünde durur. */
export function roofOf(model: CarSpec["model"]): number {
  const sh = SHAPES[model === "taksi" ? "doblo" : model] ?? TOFAS;
  return sh.ROOF + (model === "taksi" ? 0.32 : 0.1);
}

export function buildTofas(spec: CarSpec): TofasMesh {
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const paint = CAR_COLORS.find((c) => c.id === spec.color)?.hex ?? "#f1efe7";
  /** Far camının ışığı (standart, xenon, sarı). */
  const head = CAR_LIGHTS.find((l) => l.id === spec.lights)?.hex ?? "#fff6dc";
  /** Açık renkli boyada şerit ve yazılar koyu, koyu boyada beyaz. */
  const light = new THREE.Color(paint).getHSL({ h: 0, s: 0, l: 0 }).l > 0.55;
  // GAP Taksi: sarı, damalı Doblo
  const model = spec.model === "taksi" ? "doblo" : spec.model;
  const sh = SHAPES[model] ?? TOFAS;
  const { W, ZF, ZR, AXLE, TRACK, TIRE_R, BELT, ROOF, CAB_W, cabFront, wsTop, roofRear, cabRear, cabRearY, bPillar, noseY, hoodY, deckY } = sh;
  const FZ = ZF + BEV, RZ = ZR - BEV, LEN = ZF - ZR;
  const wagon = !!sh.wagon;
  const tofas = model === "sahin" || model === "dogan" || model === "kartal";
  const dogan = model === "dogan";
  const glassColor = spec.tint ? "#0d1014" : "#9fb4c2";
  /** Basık süspansiyon: gövde tekerleklere göre aşağıda. */
  const dy = spec.low ? -0.06 : 0;
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const add = (into: THREE.BufferGeometry[], g: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter = 0) => into.push(part(g, color, m, jitter, rand));
  const bodyAt = (x: number, y: number, z: number, ry = 0) => mat(x, y + dy, z, ry);
  const box = (w: number, h: number, d: number, color: string, x: number, y: number, z: number, jitter = 0) => add(body, new THREE.BoxGeometry(w, h, d), color, bodyAt(x, y, z), jitter);
  const lit = (w: number, h: number, d: number, color: string, x: number, y: number, z: number) => add(glow, new THREE.BoxGeometry(w, h, d), color, bodyAt(x, y, z));
  /** Yuvarlak lamba ya da amblem: öne bakan kısa silindir. */
  const disc = (into: THREE.BufferGeometry[], r: number, color: string, x: number, y: number, z: number) =>
    add(into, new THREE.CylinderGeometry(r, r, 0.02, 16).rotateX(Math.PI / 2), color, bodyAt(x, y, z));
  /** (z, y) iki noktası arasında eğik ince levha (cam, şerit); dışa doğru `out` kadar kaydırılır. */
  const slab = (into: THREE.BufferGeometry[], z0: number, y0: number, z1: number, y1: number, width: number, thick: number, color: string, out: number, x = 0) => {
    const dz = z1 - z0, dyy = y1 - y0, len = Math.hypot(dz, dyy);
    let nz = dyy / len, ny = -dz / len;
    if (ny < 0) [nz, ny] = [-nz, -ny];
    const m = new THREE.Matrix4().makeTranslation(x, (y0 + y1) / 2 + ny * out + dy, (z0 + z1) / 2 + nz * out);
    m.multiply(new THREE.Matrix4().makeRotationX(Math.atan2(-dyy, dz)));
    add(into, new THREE.BoxGeometry(width, thick, len), color, m);
  };

  // ---------------------------------------------------------------
  // Alt gövde: çamurluk kemerli silüet (sedanda bagaj, station/vanda kabin arkaya kadar)
  // ---------------------------------------------------------------
  const lower = new THREE.Shape();
  const ARCH = TIRE_R + 0.075;
  lower.moveTo(ZF - 0.07, 0.3);
  lower.lineTo(AXLE + ARCH, 0.3);
  lower.absarc(AXLE, TIRE_R, ARCH, 0, Math.PI, false);
  lower.lineTo(-AXLE + ARCH, 0.3);
  lower.absarc(-AXLE, TIRE_R, ARCH, 0, Math.PI, false);
  lower.lineTo(ZR + 0.07, 0.3);
  lower.lineTo(ZR, 0.42);
  lower.lineTo(ZR, deckY - 0.09);
  lower.lineTo(ZR + 0.05, deckY);
  if (sh.deck) lower.lineTo(sh.deck[0], sh.deck[1]);
  lower.lineTo(cabFront, BELT);
  lower.lineTo(ZF - 0.09, hoodY);
  lower.lineTo(ZF, noseY);
  lower.lineTo(ZF, 0.42);
  lower.closePath();
  add(body, extrude(lower, W, 0.035), paint, bodyAt(0, 0, 0), 0.015);
  // Çamurluk içi (koyu astar)
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const liner = new THREE.CylinderGeometry(ARCH - BEV - 0.01, ARCH - BEV - 0.01, 0.3, 16, 1, true, 0, Math.PI).rotateZ(Math.PI / 2);
      add(body, liner, "#0d0e10", bodyAt(sx * (W / 2 - 0.17), TIRE_R, sz * AXLE));
    }
  }

  // ---------------------------------------------------------------
  // Kabin: direkler ve tavan (boya), camlar (şeffaf), B direği siyah, tavan kenarında krom oluk
  // ---------------------------------------------------------------
  const cab = poly([[cabFront, BELT - 0.01], [wsTop, ROOF], [roofRear, ROOF], [cabRear, cabRearY]]);
  add(body, extrude(cab, CAB_W, 0.045), paint, bodyAt(0, 0, 0), 0.015);
  /** Ön ve arka direğin (z) verilen yükseklikteki yeri. */
  const zA = (y: number) => cabFront + ((y - BELT) / (ROOF - BELT)) * (wsTop - cabFront);
  const zC = (y: number) => roofRear + ((ROOF - y) / (ROOF - cabRearY)) * (cabRear - roofRear);
  const yb = BELT + 0.045, yt = ROOF - 0.055, cP = sh.cPillar ?? cabRear;
  let sideGlass: [number, number][][];
  if (tofas) {
    sideGlass = [
      [[0.9, 0.975], [0.29, 1.335], [-0.12, 1.335], [-0.12, 0.975]],
      wagon ? [[-0.22, 0.975], [-0.22, 1.335], [-1.05, 1.335], [-1.05, 0.975]] : [[-0.22, 0.975], [-0.22, 1.335], [-0.67, 1.335], [-1.02, 0.985]],
    ];
    if (wagon) sideGlass.push([[-1.15, 0.975], [-1.15, 1.335], [-1.93, 1.335], [-1.99, 0.975]]);
  } else {
    sideGlass = [[[zA(yb) - 0.07, yb], [zA(yt) - 0.07, yt], [bPillar + 0.05, yt], [bPillar + 0.05, yb]]];
    if (wagon) {
      sideGlass.push([[bPillar - 0.05, yb], [bPillar - 0.05, yt], [cP + 0.05, yt], [cP + 0.05, yb]]);
      sideGlass.push([[cP - 0.05, yb], [cP - 0.05, yt], [zC(yt) + 0.07, yt], [zC(yb) + 0.07, yb]]);
    } else sideGlass.push([[bPillar - 0.05, yb], [bPillar - 0.05, yt], [zC(yt) + 0.07, yt], [Math.max(zC(yb), cabRear + 0.1) + 0.07, yb]]);
  }
  for (const pts of sideGlass) add(glass, extrude(poly(pts), CAB_W + 0.016, 0), glassColor, bodyAt(0, 0, 0));
  // Ön cam ve arka cam (eğik)
  slab(glass, cabFront - 0.03, BELT + 0.025, wsTop + 0.03, ROOF - 0.025, CAB_W - 0.12, 0.02, glassColor, 0.05);
  if (wagon) slab(glass, cabRear + 0.01, BELT + 0.05, roofRear - 0.01, ROOF - 0.05, CAB_W - 0.14, 0.02, glassColor, 0.05);
  else slab(glass, roofRear - 0.03, ROOF - 0.025, cabRear + 0.03, cabRearY + 0.03, CAB_W - 0.12, 0.02, glassColor, 0.05);
  // Siyah B (ve station/vanda C) direği, cam çıtaları, tavan oluğu
  const pillarH = ROOF - BELT - 0.08, pillarY = (BELT + ROOF) / 2 - 0.005;
  box(CAB_W + 0.03, pillarH, 0.1, TRIM, 0, pillarY, bPillar);
  if (wagon) box(CAB_W + 0.03, pillarH, 0.1, TRIM, 0, pillarY, cP);
  for (const sx of [-1, 1]) {
    box(0.012, 0.02, cabFront - cabRear - 0.18, model === "e30" || tofas || model === "passat" ? CHROME : TRIM, sx * (CAB_W / 2 + 0.012), BELT + 0.038, (cabFront + cabRear) / 2);
    box(0.02, 0.025, wsTop - roofRear + 0.02, CHROME, sx * (CAB_W / 2 - 0.01), ROOF + 0.035, (wsTop + roofRear) / 2);
  }
  if (wagon) for (const sx of [-1, 1]) {
    // Station/van: tavan rayları
    const rz = (wsTop + roofRear) / 2, rl = (wsTop - roofRear) * 0.85;
    box(0.04, 0.05, rl, "#2c2e33", sx * (CAB_W / 2 - 0.1), ROOF + 0.09, rz);
    for (const k of [-0.5, 0, 0.5]) box(0.05, 0.08, 0.06, "#2c2e33", sx * (CAB_W / 2 - 0.1), ROOF + 0.05, rz + k * rl);
  }

  // ---------------------------------------------------------------
  // Kaporta detayları: kapı ve kaput çizgileri, kollar, koruma çıtası, marşpiyel, ayna, anten, depo kapağı
  // ---------------------------------------------------------------
  const seamX = W / 2 + 0.004;
  const doorH = BELT - 0.37, doorY = (BELT + 0.35) / 2;
  for (const sx of [-1, 1]) {
    // Kapı çizgileri tekerlek boşluğuna taşmasın: ön kapı ön, arka kapı arka çamurluk kemerinde biter
    const seams = tofas
      ? (wagon ? [0.98, -0.17, -1.1] : [0.98, -0.17, -1.11])
      : [Math.min(cabFront - 0.02, AXLE - ARCH - 0.03), bPillar, wagon ? cP : Math.max(cabRear + 0.02, -AXLE + ARCH + 0.03)];
    for (const z of seams) box(0.008, doorH, 0.012, "#2a2b2e", sx * seamX, doorY, z);
    // Doblo: sürgülü kapının rayı
    if (model === "doblo") box(0.012, 0.02, cP - bPillar + 0.4, "#2a2b2e", sx * seamX, BELT + 0.02, (cP + bPillar) / 2 - 0.2);
    const handleY = BELT - 0.13;
    for (const z of [bPillar + 0.77, bPillar - 0.31]) {
      box(0.03, 0.035, 0.17, model === "doblo" ? TRIM : CHROME, sx * (W / 2 + 0.015), handleY, z);
      box(0.012, 0.05, 0.2, "#2a2b2e", sx * (W / 2 + 0.006), handleY, z);
    }
    if (tofas || model === "e30") {
      box(0.03, 0.065, LEN * 0.853, TRIM, sx * (W / 2 + 0.016), 0.54, 0);
      box(0.034, 0.012, LEN * 0.853, CHROME, sx * (W / 2 + 0.02), 0.555, 0);
    } else box(0.025, 0.05, LEN * 0.6, model === "doblo" ? "#2a2b2e" : paint, sx * (W / 2 + 0.014), 0.52, 0.05);
    box(0.04, 0.09, AXLE * 2 - 0.8, dogan || !tofas ? TRIM : "#26272a", sx * (W / 2 - 0.005), 0.34, 0);
    // Ayna: gövdeye bağlayan kol ve kapak
    const mz = cabFront - 0.2, my = BELT + 0.1;
    box(0.08, 0.04, 0.08, TRIM, sx * (CAB_W / 2 + 0.1), my - 0.04, mz + 0.02);
    box(0.06, 0.1, 0.16, dogan || model === "linea" || model === "passat" ? paint : TRIM, sx * (CAB_W / 2 + 0.17), my, mz);
    box(0.012, 0.08, 0.13, "#7f96a6", sx * (CAB_W / 2 + 0.205), my, mz);
  }
  // Kaput ve bagaj çizgileri
  for (const sx of [-1, 1]) slab(body, cabFront + 0.02, BELT, ZF - 0.1, hoodY, 0.012, 0.006, "#2a2b2e", BEV + 0.004, sx * (W / 2 - 0.12));
  if (sh.deck) {
    const [dz, dyk] = sh.deck;
    box(W - 0.14, 0.008, 0.02, "#2a2b2e", 0, dyk + BEV + 0.003, dz - 0.01);
    for (const sx of [-1, 1]) box(0.012, 0.006, dz - ZR - 0.07, "#2a2b2e", sx * (W / 2 - 0.12), (dyk + deckY) / 2 + BEV + 0.003, (dz + ZR) / 2);
  } else {
    box(W - 0.24, 0.012, 0.012, "#2a2b2e", 0, BELT - 0.03, RZ - 0.004);
    // Doblo: iki kanatlı arka kapı
    if (model === "doblo") box(0.012, ROOF - 0.5, 0.012, "#2a2b2e", 0, (ROOF + 0.4) / 2, RZ - 0.004);
  }
  // Anten (sağ ön çamurluk; Doblo ve Passat'ta tavanda) ve depo kapağı (sağ arka)
  if (model === "doblo" || model === "passat") add(body, new THREE.CylinderGeometry(0.006, 0.012, 0.35, 5).rotateX(-0.4), "#222", bodyAt(0, ROOF + 0.15, roofRear + 0.2));
  else add(body, new THREE.CylinderGeometry(0.006, 0.01, 0.8, 5), "#222", bodyAt(-(W / 2 - 0.1), hoodY + 0.4, ZF - 0.62));
  box(0.01, 0.12, 0.12, "#2a2b2e", -(W / 2 + 0.004), BELT - 0.11, ZR + 0.62);

  // ---------------------------------------------------------------
  // Ön: tampon, ızgara, farlar, sinyaller, plaka, amblem
  // ---------------------------------------------------------------
  const bumper = model === "e30" ? CHROME : dogan || model === "linea" || model === "passat" ? paint : model === "doblo" ? "#2a2b2e" : TRIM;
  box(W + 0.06, 0.17, 0.16, bumper, 0, 0.37, ZF + 0.06);
  for (const sx of [-1, 1]) box(0.16, 0.17, 0.4, bumper, sx * (W / 2 - 0.02), 0.37, ZF - 0.1);
  if (model === "sahin" || model === "kartal") box(W + 0.07, 0.025, 0.02, CHROME, 0, 0.42, ZF + 0.142);
  const faceH = noseY - 0.48, faceY = (noseY + 0.46) / 2;
  if (model !== "linea" && model !== "passat") box(W - 0.14, faceH, 0.04, "#101113", 0, faceY, FZ + 0.005);
  /** Farların yüksekliği ve yanı (hâle ve gerçek far ışığı buradan). */
  let lampY = 0.64, lampX = 0.46, tailX = 0.66, tailY = 0.72;
  /** Arka amblemin yeri. */
  let emblemY = 0.82;
  if (model === "dogan") {
    // Doğan: tek parça geniş farlar, ince gövde rengi ızgara çıtası, tamponda sis farları
    lampX = 0.52;
    for (const sx of [-1, 1]) {
      box(0.52, 0.2, 0.03, CHROME, sx * 0.52, 0.64, FZ + 0.012);
      lit(0.48, 0.16, 0.03, head, sx * 0.52, 0.64, FZ + 0.02);
      box(0.18, 0.11, 0.02, "#151515", sx * 0.48, 0.36, ZF + 0.148);
      lit(0.14, 0.08, 0.02, "#fff3b0", sx * 0.48, 0.36, ZF + 0.155);
      lit(0.1, 0.06, 0.02, "#ffa23a", sx * (W / 2 - 0.05), 0.5, FZ - 0.01);
    }
    box(0.42, 0.05, 0.035, paint, 0, 0.72, FZ + 0.02);
    for (let k = 0; k < 3; k++) box(0.38, 0.015, 0.03, "#2a2b2e", 0, 0.57 + k * 0.045, FZ + 0.02);
  } else if (model === "linea") {
    // Linea: kaputa doğru çekik geniş farlar, ince kromlu ızgara, tamponda geniş hava girişi ve sis farları
    lampY = 0.7;
    lampX = 0.56;
    box(W - 0.1, 0.3, 0.04, paint, 0, 0.66, FZ - 0.005);
    for (const sx of [-1, 1]) {
      add(body, new THREE.BoxGeometry(0.46, 0.16, 0.04).rotateZ(sx * 0.12), "#16181b", bodyAt(sx * 0.56, 0.7, FZ + 0.012));
      add(glow, new THREE.BoxGeometry(0.4, 0.11, 0.03).rotateZ(sx * 0.12), head, bodyAt(sx * 0.56, 0.7, FZ + 0.022));
      lit(0.12, 0.05, 0.02, "#ffa23a", sx * 0.74, 0.68, FZ + 0.03);
      box(0.16, 0.09, 0.02, "#151515", sx * 0.58, 0.35, ZF + 0.148);
      lit(0.12, 0.06, 0.02, "#fff3b0", sx * 0.58, 0.35, ZF + 0.155);
    }
    box(0.5, 0.09, 0.035, "#16181b", 0, 0.66, FZ + 0.015);
    box(0.52, 0.02, 0.04, CHROME, 0, 0.7, FZ + 0.02);
    box(0.95, 0.12, 0.03, "#16181b", 0, 0.34, ZF + 0.15);
  } else if (model === "passat") {
    // Passat B5: büyük gövde rengi ön, kromlu çerçeveli geniş ızgara, kalın yuvarlak hatlı farlar
    lampX = 0.6;
    lampY = 0.66;
    box(W - 0.1, faceH, 0.04, paint, 0, faceY, FZ - 0.005);
    for (const sx of [-1, 1]) {
      box(0.42, 0.2, 0.035, "#16181b", sx * 0.6, 0.66, FZ + 0.012);
      lit(0.36, 0.15, 0.03, head, sx * 0.6, 0.66, FZ + 0.022);
      lit(0.08, 0.05, 0.02, "#ffa23a", sx * 0.76, 0.6, FZ + 0.03);
    }
    box(0.62, 0.2, 0.035, CHROME, 0, 0.65, FZ + 0.012);
    box(0.58, 0.16, 0.035, "#121315", 0, 0.65, FZ + 0.02);
    for (let k = 0; k < 4; k++) box(0.56, 0.012, 0.03, "#5a5e64", 0, 0.59 + k * 0.04, FZ + 0.03);
    box(1.0, 0.1, 0.03, "#16181b", 0, 0.34, ZF + 0.15);
  } else if (model === "e30") {
    // E30: dörtlü yuvarlak far, ortada böbrek ızgara, kromlu tampon
    lampY = 0.62;
    lampX = 0.45;
    for (const sx of [-1, 1]) {
      for (const x of [0.6, 0.35]) {
        disc(body, 0.085, CHROME, sx * x, 0.62, FZ + 0.01);
        disc(glow, 0.068, head, sx * x, 0.62, FZ + 0.02);
      }
      box(0.12, 0.17, 0.035, CHROME, sx * 0.08, 0.62, FZ + 0.012);
      box(0.09, 0.14, 0.035, "#0c0c0d", sx * 0.08, 0.62, FZ + 0.02);
      lit(0.14, 0.06, 0.02, "#ffa23a", sx * 0.6, 0.43, ZF + 0.152);
    }
  } else if (model === "doblo") {
    // Doblo: yüksek, iri farlar, küçük siyah ızgara, kalın plastik tampon
    lampY = 0.78;
    lampX = 0.6;
    for (const sx of [-1, 1]) {
      box(0.36, 0.24, 0.035, "#16181b", sx * 0.6, 0.78, FZ + 0.012);
      lit(0.3, 0.19, 0.03, head, sx * 0.6, 0.78, FZ + 0.02);
      lit(0.08, 0.06, 0.02, "#ffa23a", sx * 0.72, 0.7, FZ + 0.03);
    }
    for (let k = 0; k < 3; k++) box(0.58, 0.02, 0.03, "#2a2b2e", 0, 0.66 + k * 0.05, FZ + 0.02);
  } else {
    // Şahin / Kartal: ikiz köşeli farlar (krom çerçeve), kromlu yatay ızgara
    for (const sx of [-1, 1]) {
      for (const [x, w] of [[0.6, 0.3], [0.31, 0.22]] as const) {
        box(w + 0.04, 0.2, 0.03, CHROME, sx * x, 0.64, FZ + 0.012);
        lit(w, 0.16, 0.03, head, sx * x, 0.64, FZ + 0.02);
      }
      lit(0.16, 0.07, 0.02, "#ffa23a", sx * 0.58, 0.47, ZF + 0.152);
    }
    for (let k = 0; k < 5; k++) box(0.34, 0.014, 0.03, CHROME, 0, 0.57 + k * 0.035, FZ + 0.02);
  }
  // Amblem: Tofaş (mavi), Fiat (kırmızı), VW ve BMW (yuvarlak)
  const badge = tofas ? "#1f4fbf" : model === "linea" || model === "doblo" ? "#a3101f" : model === "e30" ? "#2a6fd1" : "#16264d";
  const by = model === "e30" ? noseY + 0.02 : lampY - (model === "linea" ? 0.04 : 0);
  disc(body, 0.055, CHROME, 0, by, FZ + 0.035);
  disc(body, 0.04, badge, 0, by, FZ + 0.04);
  if (model === "e30") for (const a of [0, Math.PI / 2]) add(body, new THREE.BoxGeometry(0.04, 0.04, 0.02), "#f2f2f2", bodyAt(0.02 * Math.cos(a + 0.8), by + 0.02 * Math.sin(a + 0.8), FZ + 0.05));

  // ---------------------------------------------------------------
  // Arka: tampon, stoplar (kırmızı/turuncu/beyaz bölmeli), plaka yuvası, egzoz
  // ---------------------------------------------------------------
  box(W + 0.06, 0.17, 0.16, bumper, 0, 0.37, ZR - 0.06);
  for (const sx of [-1, 1]) box(0.16, 0.17, 0.4, bumper, sx * (W / 2 - 0.02), 0.37, ZR + 0.1);
  if (model === "sahin" || model === "kartal") box(W + 0.07, 0.025, 0.02, CHROME, 0, 0.42, ZR - 0.142);
  if (model === "kartal" || model === "doblo") {
    // Kartal / Doblo: arka köşelerde dikey stoplar, bagaj kapağı kolu
    const tall = model === "doblo" ? 1.6 : 1;
    tailX = 0.72;
    tailY = 0.76 * (model === "doblo" ? 1.15 : 1);
    for (const sx of [-1, 1]) {
      box(0.16, 0.42 * tall, 0.03, TRIM, sx * 0.72, 0.7 * (tall > 1 ? 1.15 : 1), RZ - 0.01);
      lit(0.12, 0.22 * tall, 0.03, "#e01919", sx * 0.72, 0.76 * (tall > 1 ? 1.15 : 1) + (tall - 1) * 0.06, RZ - 0.02);
      lit(0.12, 0.08, 0.03, "#ffa23a", sx * 0.72, 0.6 * (tall > 1 ? 1.08 : 1), RZ - 0.02);
      lit(0.12, 0.05, 0.03, "#f4f4f0", sx * 0.72, 0.53 * (tall > 1 ? 1.08 : 1), RZ - 0.02);
    }
    box(0.3, 0.04, 0.03, CHROME, model === "doblo" ? 0.25 : 0, model === "doblo" ? 1.0 : 0.8, RZ - 0.015);
    emblemY = model === "doblo" ? 1.15 : 0.82;
  } else if (model === "linea") {
    // Linea: bagaja uzanan geniş yatay stoplar, aralarında krom çıta
    tailX = 0.6;
    tailY = 0.86;
    for (const sx of [-1, 1]) {
      box(0.5, 0.17, 0.03, TRIM, sx * 0.57, 0.86, RZ - 0.01);
      lit(0.3, 0.13, 0.03, "#d81414", sx * 0.64, 0.86, RZ - 0.02);
      lit(0.14, 0.06, 0.03, "#f4f4f0", sx * 0.42, 0.84, RZ - 0.02);
    }
    box(0.6, 0.025, 0.02, CHROME, 0, 0.86, RZ - 0.015);
    emblemY = 0.76;
  } else if (model === "passat") {
    // Passat: gövdeye gömülü dikdörtgen stoplar (kırmızı, turuncu sinyal, beyaz geri vites)
    tailX = 0.6;
    tailY = 0.8;
    for (const sx of [-1, 1]) {
      box(0.5, 0.2, 0.03, TRIM, sx * 0.57, 0.8, RZ - 0.01);
      for (const [x, w, c] of [[0.7, 0.2, "#d81414"], [0.53, 0.12, "#ffa23a"], [0.41, 0.1, "#d81414"]] as const) lit(w - 0.02, 0.16, 0.03, c, sx * x, 0.8, RZ - 0.02);
    }
    emblemY = 0.85;
  } else if (model === "e30") {
    // E30: arkada boydan boya siyah şerit içinde bölmeli stoplar
    tailX = 0.6;
    tailY = 0.7;
    box(W - 0.06, 0.17, 0.03, TRIM, 0, 0.7, RZ - 0.01);
    for (const sx of [-1, 1]) {
      for (const [x, w, c] of [[0.66, 0.24, "#d81414"], [0.48, 0.12, "#ffa23a"], [0.37, 0.08, "#f4f4f0"]] as const) lit(w - 0.02, 0.13, 0.03, c, sx * x, 0.7, RZ - 0.02);
    }
    emblemY = 0.82;
  } else {
    for (const sx of [-1, 1]) {
      box(0.6, 0.22, 0.03, TRIM, sx * 0.49, 0.67, RZ - 0.01);
      const segs: [number, number, string][] = [[0.72, 0.2, "#e01919"], [0.55, 0.12, "#ffa23a"], [0.44, 0.08, "#f4f4f0"], [0.31, 0.16, "#e01919"]];
      for (const [x, w, c] of segs) lit(w - 0.02, 0.17, 0.03, c, sx * x, 0.67, RZ - 0.02);
    }
    box(0.36, 0.2, 0.025, "#26272a", 0, 0.67, RZ - 0.01);
  }
  add(body, new THREE.CylinderGeometry(0.035, 0.035, 0.02, 14).rotateX(Math.PI / 2), CHROME, bodyAt(0, emblemY, RZ - 0.02));
  // Egzoz: standart tek boru, çift çıkış (iki yanda), spor (kalın krom uç)
  const pipe = (x: number, r: number, len: number, color: string) => {
    // Boru tampon altından arkaya uzanır; ucunda koyu ağız
    const cz = ZR - 0.1 - (len - 0.3) / 2;
    add(body, new THREE.CylinderGeometry(r, r + 0.005, len, 12).rotateX(Math.PI / 2), color, bodyAt(x, 0.25, cz));
    add(body, new THREE.CylinderGeometry(r - 0.013, r - 0.013, 0.02, 12).rotateX(Math.PI / 2), "#0c0c0c", bodyAt(x, 0.25, cz - len / 2 - 0.004));
  };
  if (spec.exhaust === "cift") for (const x of [-0.5, 0.5]) pipe(x, 0.045, 0.3, CHROME);
  else if (spec.exhaust === "spor") {
    pipe(0.42, 0.072, 0.38, CHROME);
    pipe(0.6, 0.072, 0.38, CHROME);
  } else pipe(0.5, 0.045, 0.3, "#6b6e72");

  // ---------------------------------------------------------------
  // İç: torpido, direksiyon, ön koltuklar, arka kanepe (camlardan görünür)
  // ---------------------------------------------------------------
  const cloth = "#4a4038";
  const dashZ = cabFront - 0.38;
  box(CAB_W - 0.08, 0.12, 0.34, "#232326", 0, BELT + 0.02, dashZ);
  lit(0.24, 0.07, 0.01, "#7fd4ff", 0.36, BELT + 0.1, dashZ - 0.105);
  add(body, new THREE.TorusGeometry(0.17, 0.022, 6, 18).rotateX(-0.45), "#1a1a1a", bodyAt(0.36, BELT + 0.1, dashZ - 0.15));
  for (const sx of [-1, 1]) {
    box(0.48, 0.12, 0.5, cloth, sx * 0.36, 0.55, -0.02);
    add(body, new THREE.BoxGeometry(0.46, 0.62, 0.12).rotateX(-0.18), cloth, bodyAt(sx * 0.36, 0.86, -0.3));
    box(0.26, 0.16, 0.1, cloth, sx * 0.36, 1.24, -0.36);
  }
  box(1.3, 0.12, 0.5, cloth, 0, 0.55, -0.92);
  add(body, new THREE.BoxGeometry(1.3, 0.5, 0.12).rotateX(-0.2), cloth, bodyAt(0, 0.82, wagon ? -1.23 : -0.84));
  box(CAB_W - 0.04, 0.04, 2.6, "#1d1d20", 0, 0.47, -0.35);

  // ---------------------------------------------------------------
  // Çıkartmalar ve aksesuarlar
  // ---------------------------------------------------------------
  const stripe = light ? "#1b1c1f" : "#f4f4f0";
  if (spec.decal === "serit") {
    for (const x of [-0.17, 0.17]) {
      slab(body, cabFront + 0.02, BELT, ZF - 0.1, hoodY, 0.16, 0.006, stripe, BEV + 0.008, x);
      box(0.16, 0.006, wsTop - roofRear - 0.05, stripe, x, ROOF + 0.048, (wsTop + roofRear) / 2);
      if (sh.deck) slab(body, sh.deck[0] - 0.01, sh.deck[1], ZR + 0.06, deckY, 0.16, 0.006, stripe, BEV + 0.008, x);
    }
  } else if (spec.decal === "alev") {
    // Ön çamurluktan arkaya uzanan alev dilleri: dış kat kırmızı-turuncu, iç kat sarı
    const z0 = ZF - 0.22;
    const tongue = (scale: number) => {
      const s = new THREE.Shape();
      s.moveTo(z0, 0.45);
      const tips: [number, number][] = [[0.6, 0.86], [0.85, 0.66], [-0.2, 0.82], [0.25, 0.6], [-0.9, 0.7], [-0.2, 0.5], [-1.4, 0.52], [0.2, 0.42]];
      for (const [z, y] of tips) s.lineTo(z0 + (z - 1.95) * scale, 0.45 + (y - 0.45) * scale);
      s.closePath();
      return s;
    };
    for (const sx of [-1, 1]) {
      for (const [scale, color, off] of [[1, "#ff4a1c", 0.006], [0.7, "#ffa21f", 0.009], [0.42, "#ffe14d", 0.012]] as const) {
        const g = new THREE.ShapeGeometry(tongue(scale)).rotateY(-Math.PI / 2);
        add(body, g, color, bodyAt(sx * (W / 2 + off), 0, 0));
      }
    }
  } else if (spec.decal === "dama") {
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 16; k++) for (let r = 0; r < 2; r++) {
        if ((k + r) % 2) box(0.006, 0.06, 0.2, "#151515", sx * (W / 2 + 0.008), BELT - 0.27 + r * 0.06, -1.6 + k * 0.2);
      }
    }
    box(0.66, 0.16, 0.24, "#f2c230", 0, ROOF + 0.13, -0.15);
    box(0.7, 0.03, 0.28, TRIM, 0, ROOF + 0.05, -0.15);
  }
  if (spec.spoiler === "kucuk") {
    slab(body, ZR + 0.25, wagon ? ROOF + 0.02 : deckY + 0.05, ZR + 0.05, wagon ? ROOF + 0.06 : deckY + 0.09, W - 0.24, 0.045, light ? paint : TRIM, 0.02);
  } else if (spec.spoiler === "buyuk") {
    const zw = ZR + 0.22, yb2 = wagon ? ROOF : deckY + 0.03;
    for (const sx of [-0.55, 0.55]) box(0.05, 0.3, 0.12, TRIM, sx, yb2 + 0.15, zw);
    slab(body, zw + 0.2, yb2 + 0.33, zw - 0.18, yb2 + 0.29, W + 0.08, 0.045, paint, 0);
    for (const sx of [-1, 1]) box(0.03, 0.18, 0.44, TRIM, sx * (W / 2 + 0.06), yb2 + 0.33, zw);
  }

  // ---------------------------------------------------------------
  // Tekerlekler: açık lastik gövdesi, yanak halkası, içeride fren diski, jant yüzü ve jant deseni
  // (her katman ayrı derinlikte: üst üste binmez)
  // ---------------------------------------------------------------
  const rim = spec.rim;
  /** Her tekerlek kendi göbeğinin çevresinde kurulur: [x, z, geometriler]. */
  const wheels: { x: number; z: number; front: boolean; geos: THREE.BufferGeometry[] }[] = [];
  const rimFace = { celik: "#9aa0a6", spor: "#2b2e33", altin: "#4a3a1a", siyah: "#141518" }[rim];
  const spokeColor = { celik: CHROME, spor: "#c3c8ce", altin: "#e2b84a", siyah: "#2d3035" }[rim];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wx = sx * TRACK, wz = sz * AXLE, out = sx;
      const faceOut = (g: THREE.BufferGeometry) => g.rotateY(out > 0 ? Math.PI / 2 : -Math.PI / 2);
      const wheel: THREE.BufferGeometry[] = [];
      wheels.push({ x: wx, z: wz, front: sz > 0, geos: wheel });
      /** Göbeğe göre konum (dünyada (x, y, z) olan nokta). */
      const mat = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x - wx, y - TIRE_R, z - wz);
      const body = wheel;
      add(body, new THREE.CylinderGeometry(TIRE_R, TIRE_R, TIRE_W, 22, 1, true).rotateZ(Math.PI / 2), RUBBER, mat(wx, TIRE_R, wz));
      // Lastik sırtında diş çizgileri: dönüş gözle görülsün
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        add(body, new THREE.BoxGeometry(TIRE_W - 0.02, 0.012, 0.05), "#26282c", mat(wx, TIRE_R, wz).multiply(new THREE.Matrix4().makeRotationX(a)).multiply(new THREE.Matrix4().makeTranslation(0, TIRE_R + 0.002, 0)));
      }
      for (const side of [-1, 1]) {
        const ring = new THREE.RingGeometry(0.2, TIRE_R, 22).rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
        add(body, ring, "#18191b", mat(wx + side * (TIRE_W / 2), TIRE_R, wz));
      }
      const xo = wx + out * (TIRE_W / 2);
      add(body, faceOut(new THREE.CircleGeometry(0.16, 18)), "#3a3c40", mat(xo - out * 0.075, TIRE_R, wz));
      add(body, faceOut(new THREE.CircleGeometry(0.2, 22)), rimFace, mat(xo - out * (rim === "celik" ? 0.02 : 0.045), TIRE_R, wz));
      if (rim === "celik") {
        // Jant kapağı: kubbe, yarıklar, ortada amblem
        add(body, faceOut(new THREE.CircleGeometry(0.165, 20)), CHROME, mat(xo - out * 0.013, TIRE_R, wz));
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          add(body, faceOut(new THREE.PlaneGeometry(0.035, 0.07)), "#3a3c40", mat(xo - out * 0.008, TIRE_R + Math.sin(a) * 0.115, wz + Math.cos(a) * 0.115));
        }
        add(body, faceOut(new THREE.CircleGeometry(0.045, 14)), "#1f4fbf", mat(xo - out * 0.004, TIRE_R, wz));
      } else {
        const n = rim === "altin" ? 10 : rim === "spor" ? 5 : 6;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          const m = mat(xo - out * 0.03, TIRE_R, wz).multiply(new THREE.Matrix4().makeRotationX(a)).multiply(new THREE.Matrix4().makeTranslation(0, 0.1, 0));
          add(body, new THREE.BoxGeometry(0.02, 0.19, rim === "altin" ? 0.025 : 0.055), spokeColor, m);
        }
        add(body, new THREE.TorusGeometry(0.192, 0.012, 4, 22).rotateY(Math.PI / 2), rim === "siyah" ? "#3a3d42" : spokeColor, mat(xo - out * 0.02, TIRE_R, wz));
        add(body, faceOut(new THREE.CircleGeometry(0.05, 14)), rim === "siyah" ? "#c8102e" : spokeColor, mat(xo - out * 0.018, TIRE_R, wz));
      }
    }
  }

  // ---------------------------------------------------------------
  // Mesh'ler: gövde, cam (şeffaf), ışıklar, plakalar, rozet, temas gölgesi, neon hâlesi
  // ---------------------------------------------------------------
  const group = new THREE.Group();
  /** Gövde (tekerlekler, gölge ve neon hâlesi hariç): virajda yana, gaz/frende öne-arkaya yatar. */
  const shell = new THREE.Group();
  shell.rotation.order = "YXZ";
  group.add(shell);
  const disposables: { dispose(): void }[] = [];
  const mesh = (geos: THREE.BufferGeometry[], material: THREE.Material, shadow = false) => {
    const m = new THREE.Mesh(mergeGeometries(geos), material);
    m.castShadow = shadow;
    shell.add(m);
    disposables.push(m.geometry, material);
    return m;
  };
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const bodyMesh = mesh(body, bodyMat, true);
  // Tekerlekler: göbekte dönen parça; öndekiler direksiyonla birlikte bir pivotta döner
  const spins: THREE.Mesh[] = [];
  const steers: THREE.Group[] = [];
  for (const w of wheels) {
    const pivot = new THREE.Group();
    pivot.position.set(w.x, TIRE_R, w.z);
    const m = new THREE.Mesh(mergeGeometries(w.geos), bodyMat);
    m.castShadow = true;
    pivot.add(m);
    group.add(pivot);
    disposables.push(m.geometry);
    spins.push(m);
    if (w.front) steers.push(pivot);
  }
  let spin = 0;
  const glassMesh = mesh(glass, new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: spec.tint ? 0.88 : 0.42, shininess: 90, specular: "#ffffff", depthWrite: false }));
  glassMesh.renderOrder = 3;
  const glowMesh = mesh(glow, new THREE.MeshBasicMaterial({ vertexColors: true }));

  const decal = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ry: number, emissive = "#555555", transparent = false) => {
    const m = new THREE.MeshLambertMaterial({ map: tex, emissive, emissiveMap: tex, transparent });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    p.position.set(x, y + dy, z);
    p.rotation.y = ry;
    shell.add(p);
    disposables.push(tex, m, p.geometry);
  };
  decal(plateTexture(spec.plate), 0.52, 0.115, 0, 0.37, ZF + 0.146, 0);
  decal(plateTexture(spec.plate), 0.52, 0.115, 0, 0.37, ZR - 0.146, Math.PI);
  const badgeY = { linea: 0.72, passat: 0.64, e30: 0.58, doblo: 1.12, kartal: 0.9 }[model as string] ?? 0.86;
  // Doblo'da yazılar stopların arasında kalsın
  const badgeX = model === "doblo" ? 0.4 : 0.5;
  decal(badgeTexture(MODEL_NAMES[model]), 0.36, 0.08, -badgeX, badgeY, RZ - 0.008, Math.PI, "#444444", true);
  const engineBadge = ENGINE_BADGE[model];
  if (engineBadge) decal(badgeTexture(engineBadge), 0.36, 0.08, badgeX, badgeY, RZ - 0.008, Math.PI, "#444444", true);
  if (spec.decal === "dama") {
    for (const s of [-1, 1]) decal(badgeTexture("TAKSİ", "#111", "#f2c230"), 0.62, 0.14, 0, ROOF + 0.13, -0.15 + s * 0.125, s > 0 ? 0 : Math.PI, "#7a6a20");
  }

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(W + 0.7, LEN + 0.8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: softTexture("shadow"), transparent: true, opacity: 0.65, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }),
  );
  shadow.position.y = 0.06;
  shadow.renderOrder = 1;
  group.add(shadow);
  disposables.push(shadow.geometry, shadow.material as THREE.Material);

  const neonHex = CAR_NEONS.find((n) => n.id === spec.neon)?.hex;
  let neonMats: THREE.MeshBasicMaterial[] = [];
  const darkNeon = spec.neon === "siyah";
  if (neonHex) {
    // Yere vuran yumuşak hâle (geniş ve dar iki kat) ve marşpiyel altında parlayan tüpler. Hâle zeminden biraz
    // yukarıda ve derinlikte öne çekili: asfalt, kaldırım ve kavşaklar arasında gidip gelip titremez (z-fighting).
    // Siyah ışık toplanarak görünmez; onun yerine koyu, yarı saydam bir hâle düşer.
    const haloMat = () =>
      new THREE.MeshBasicMaterial({
        color: neonHex,
        map: softTexture("glow"),
        transparent: true,
        blending: darkNeon ? THREE.NormalBlending : THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -8,
      });
    neonMats = [haloMat(), haloMat()];
    for (const [i, s] of [[0, 3.4], [1, 1.6]] as const) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(W + s, LEN + s * 1.2).rotateX(-Math.PI / 2), neonMats[i]);
      p.position.y = 0.07 + i * 0.01;
      p.renderOrder = 2;
      group.add(p);
      disposables.push(p.geometry, neonMats[i]);
    }
    const tubes = [-1, 1].map((sx) => part(new THREE.CylinderGeometry(0.018, 0.018, LEN * 0.74, 6).rotateX(Math.PI / 2), neonHex, mat(sx * (W / 2 - 0.12), 0.27 + dy, 0)));
    tubes.push(part(new THREE.CylinderGeometry(0.018, 0.018, W - 0.4, 6).rotateZ(Math.PI / 2), neonHex, mat(0, 0.27 + dy, ZF - 0.25)));
    mesh(tubes, new THREE.MeshBasicMaterial({ vertexColors: true }));
  }
  // ---------------------------------------------------------------
  // Farlar: gece öne uzanan hüzmeler (iki koni), yolda önü aydınlatan ışık lekesi, far ve stop haleleri.
  // Hepsi toplamalı ve ucuz: sahnedeki bütün arabalarda çalışır (gerçek ışık yalnızca en yakın birkaçında,
  // bkz. cars.ts). Gündüz görünmez.
  // ---------------------------------------------------------------
  const headCol = new THREE.Color(head);
  const lampH = lampY + dy;
  const beamUniforms = { uColor: { value: headCol }, uOpacity: { value: 0 } };
  const beamMat = new THREE.ShaderMaterial({
    uniforms: beamUniforms,
    vertexShader: /* glsl */ `
      varying float vAlong;
      varying float vFacing;
      void main() {
        vAlong = uv.y;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 n = normalize(mat3(modelMatrix) * normal);
        vFacing = abs(dot(n, normalize(cameraPosition - wp.xyz)));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlong;
      varying float vFacing;
      void main() {
        // Fara yakın parlak, uca doğru söner; koninin kenarlarından bakınca yumuşak (sert çizgi olmasın)
        float a = pow(vAlong, 1.8) * pow(vFacing, 1.5) * uOpacity;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const BEAM_LEN = 11;
  const beams: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    // Koni: tepesi farda, ekseni öne (+z), hafif aşağı ve dışa bakar
    const g = new THREE.ConeGeometry(1.6, BEAM_LEN, 20, 1, true).translate(0, -BEAM_LEN / 2, 0).rotateX(-Math.PI / 2 + 0.07).rotateY(sx * 0.05);
    const m = new THREE.Mesh(g, beamMat);
    m.position.set(sx * lampX, lampH, FZ + 0.05);
    m.renderOrder = 7;
    m.frustumCulled = false;
    shell.add(m);
    beams.push(m);
    disposables.push(g);
  }
  disposables.push(beamMat);
  // Yolda ışık lekesi: arabanın önünde genişleyen yumuşak yamuk
  const poolUniforms = { uColor: { value: headCol }, uOpacity: { value: 0 } };
  const poolMat = new THREE.ShaderMaterial({
    uniforms: poolUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float along = vUv.y;                       // 0 araba, 1 uç
        float halfW = 0.12 + 0.36 * along;         // genişlik öne doğru açılır
        float x = abs(vUv.x - 0.5);
        float side = 1.0 - smoothstep(halfW * 0.5, halfW, x);
        // Yakında güçlü, uzağa doğru yavaşça söner (far uzağa vurur)
        float len = smoothstep(0.0, 0.05, along) * (1.0 - smoothstep(0.3, 1.0, along) * 0.85) * (1.0 - smoothstep(0.85, 1.0, along));
        float a = side * len * uOpacity;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  const POOL_LEN = 30;
  const poolGeo = new THREE.PlaneGeometry(10, POOL_LEN).rotateX(-Math.PI / 2).rotateY(Math.PI);
  const pool = new THREE.Mesh(poolGeo, poolMat);
  pool.position.set(0, 0.08, FZ + POOL_LEN / 2 - 0.4);
  pool.renderOrder = 2;
  group.add(pool);
  disposables.push(poolGeo, poolMat);
  // Far ve stop haleleri: camın etrafında küçük, yuvarlak parıltı (kameraya dönük)
  const halo = (color: THREE.ColorRepresentation, size: number, x: number, y: number, z: number) => {
    const m = new THREE.SpriteMaterial({ map: roundGlow(), color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const sp = new THREE.Sprite(m);
    sp.scale.set(size, size, 1);
    sp.position.set(x, y, z);
    sp.renderOrder = 8;
    shell.add(sp);
    disposables.push(m);
    return m;
  };
  const headSprites: THREE.Sprite[] = [];
  const heads = [-1, 1].map((sx) => halo(headCol, 0.45, sx * lampX, lampH, FZ + 0.06));
  for (const c of shell.children) if (c instanceof THREE.Sprite && heads.includes(c.material)) headSprites.push(c);
  const tails = [-1, 1].map((sx) => halo("#ff2a1a", 0.3, sx * tailX, tailY + dy, RZ - 0.05));
  pool.visible = false;
  let tailN = 0, braking = false;
  // ---------------------------------------------------------------
  // Hasar: göçükler köşe noktaları itilerek (ilk göçükte asıl konumlar saklanır, onarımda geri döner), kırık far
  // camı kararır ve o taraf yanmaz; ağır hasarda tampon sarkar, kapı aralanır (ayrı parçalar, sallanır)
  // ---------------------------------------------------------------
  let broken = 0;
  let dentKey = "0,0,0,0,0";
  const origPos = new Map<THREE.BufferGeometry, Float32Array>();
  let glowCol: Float32Array | null = null;
  const hash = (x: number, y: number, z: number) => {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const FRONT = [0, 0.07, 0.15, 0.26], SIDE = [0, 0.05, 0.1, 0.17];
  const deform = (g: THREE.BufferGeometry, d: CarDents) => {
    const pos = g.attributes.position as THREE.BufferAttribute;
    let o = origPos.get(g);
    if (!o) origPos.set(g, (o = new Float32Array(pos.array as Float32Array)));
    const a = pos.array as Float32Array;
    for (let i = 0; i < a.length; i += 3) {
      let x = o[i], y = o[i + 1], z = o[i + 2];
      const n = hash(o[i], o[i + 1], o[i + 2]) - 0.5;
      if (d.f) {
        const t = smooth(ZF - 1.0, ZF + 0.1, z);
        z -= FRONT[d.f] * t;
        y += n * 0.05 * d.f * t;
        x *= 1 - 0.025 * d.f * t;
      }
      if (d.r) {
        const t = smooth(ZR + 1.0, ZR - 0.1, z);
        z += FRONT[d.r] * t;
        y += n * 0.05 * d.r * t;
        x *= 1 - 0.025 * d.r * t;
      }
      for (const [lvl, sx] of [[d.l, 1], [d.rt, -1]] as const) {
        if (!lvl) continue;
        const t = smooth(W / 2 - 0.45, W / 2 + 0.05, x * sx) * Math.exp(-(((z - 0.15) / 1.0) ** 2));
        x -= sx * SIDE[lvl] * t * (1 + n * 0.6);
        y += n * 0.03 * lvl * t;
      }
      a[i] = x;
      a[i + 1] = y;
      a[i + 2] = z;
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  };
  /** Kırık farın camı: o taraftaki far noktalarının rengi kararır. */
  const lampGlass = (hl: number) => {
    const g = glowMesh.geometry, col = g.attributes.color as THREE.BufferAttribute, pos = g.attributes.position.array as Float32Array;
    if (!glowCol) glowCol = new Float32Array(col.array as Float32Array);
    const c = col.array as Float32Array;
    for (let i = 0; i < c.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const side = x > 0 ? 1 : 2;
      const dead = (hl & side) !== 0 && z > ZF - 0.35 && Math.abs(Math.abs(x) - lampX) < 0.22 && Math.abs(y - (lampY + dy)) < 0.16;
      c[i] = dead ? 0.16 : glowCol[i];
      c[i + 1] = dead ? 0.16 : glowCol[i + 1];
      c[i + 2] = dead ? 0.17 : glowCol[i + 2];
    }
    col.needsUpdate = true;
  };
  // Sarkan tampon ve aralanan kapı (ağır hasarda görünür)
  const loosePart = (w: number, h: number, depth: number, color: string) => {
    const pivot = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), new THREE.MeshLambertMaterial({ color }));
    m.castShadow = true;
    pivot.add(m);
    pivot.visible = false;
    shell.add(pivot);
    disposables.push(m.geometry, m.material as THREE.Material);
    return { pivot, m };
  };
  const hangBumper = loosePart(W * 0.92, 0.16, 0.12, TRIM);
  hangBumper.m.position.set(W * 0.46, 0, 0);
  hangBumper.pivot.position.set(-W * 0.46, 0.34 + dy, ZF + 0.08);
  const doorLen = Math.max(0.7, cabFront - 0.1 - bPillar);
  const doors = [1, -1].map((sx) => {
    const p = loosePart(0.05, BELT - 0.3, doorLen, paint);
    p.m.position.set(0, 0, -doorLen / 2);
    p.pivot.position.set(sx * (W / 2 + 0.03), (BELT + 0.3) / 2 + dy, cabFront - 0.1);
    return { ...p, sx };
  });
  let sway = 0;
  const applyTails = () => {
    for (const m of tails) m.opacity = Math.max(0.6 * tailN, braking ? 0.95 : 0);
  };
  return {
    group,
    headColor: headCol,
    setHeadlights(n, o = {}) {
      // Uzun far: gündüz de göz alır; havada huzme yağmursuz da hafifçe görünür
      const high = !!o.high;
      if (high) n = Math.max(n, 1);
      const on = n > 0.01, haze = Math.min(1, (o.haze ?? 0) * 1.5 + (high ? 0.5 : 0));
      pool.visible = on && o.decal !== false;
      for (const b of beams) b.visible = on && haze > 0.02;
      beamUniforms.uOpacity.value = 0.1 * n * haze * (high ? 1.8 : 1);
      poolUniforms.uOpacity.value = (high ? 1 : 0.75) * n;
      for (const sp of headSprites) sp.scale.setScalar(high ? 1.1 : 0.45);
      heads.forEach((m, i) => (m.opacity = (broken & (i ? 1 : 2) ? 0 : 1) * (high ? 1 : 0.85) * n));
      tailN = n;
      applyTails();
    },
    setBrake(on) {
      if (on === braking) return;
      braking = on;
      applyTails();
    },
    setLean(roll, pitch) {
      shell.rotation.z = roll;
      shell.rotation.x = pitch;
      // Sarkan parçalar virajda ve frende sallanır
      sway += (roll * 6 - pitch * 4 - sway) * 0.2;
      hangBumper.pivot.rotation.z = -0.32 + sway * 0.4;
      for (const dr of doors) dr.pivot.rotation.y = -dr.sx * (0.55 + sway * 0.5 * dr.sx);
    },
    setDents(d) {
      const key = `${d.f},${d.r},${d.l},${d.rt},${d.hl}`;
      if (key === dentKey) return;
      dentKey = key;
      deform(bodyMesh.geometry, d);
      deform(glassMesh.geometry, d);
      deform(glowMesh.geometry, d);
      broken = d.hl;
      lampGlass(d.hl);
      hangBumper.pivot.visible = d.f >= 3;
      doors[0].pivot.visible = d.l >= 3;
      doors[1].pivot.visible = d.rt >= 3;
    },
    setDamage(level) {
      bodyMat.color.setScalar(1 - 0.16 * Math.max(0, Math.min(3, level)));
    },
    roll(dist, steer) {
      spin = (spin + dist / TIRE_R) % (Math.PI * 2);
      for (const m of spins) m.rotation.x = spin;
      for (const p of steers) p.rotation.y = steer;
    },
    setNight(n) {
      if (neonMats.length) {
        neonMats[0].opacity = darkNeon ? 0.3 : 0.35 + 0.45 * n;
        neonMats[1].opacity = darkNeon ? 0.45 : 0.45 + 0.5 * n;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
