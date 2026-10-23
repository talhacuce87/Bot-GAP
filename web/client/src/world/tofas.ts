// Tofaş (Şahin sedan, Doğan SLX, Kartal station): yandan silüetten çekilen gövde (çamurluk kemerleri,
// eğimli ön/arka cam, yuvarlatılmış kenarlar), şeffaf camların ardında torpido, koltuklar ve direksiyon.
// Her modelin kendi ön ve arka yüzü: Şahin ikiz köşeli far ve kromlu ızgara, Doğan tek parça far, gövde
// rengi tampon ve sis farı, Kartal station tavan ve dikey stoplar. Jant lastiğin içine gömülü katmanlarda
// (yüzeyler üst üste binmez). Neon yere yumuşak bir ışık hâlesi olarak vurur; altında temas gölgesi.
//
// Yerel +z ön, +x sol (sürücü tarafı), araba merkezi orijinde ve tekerlekler yerde.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CAR_COLORS, CAR_LIGHTS, CAR_NEONS, type CarSpec } from "../../../shared/car";
import { mat, part } from "./geo";

/** Gövde ölçüleri (gerçek Tofaş: 4,33 × 1,64 × 1,39 m, aks aralığı 2,49 m). */
const W = 1.64;
const ZF = 2.17;
const ZR = -2.17;
const AXLE = 1.245;
const TRACK = 0.7;
const TIRE_R = 0.31;
const TIRE_W = 0.19;
const BELT = 0.93;
const ROOF = 1.39;
const CAB_W = 1.4;
/** Yuvarlatma payı: gövdenin gerçek ön/arka yüzü ve üstü silüetten bu kadar dışarıda. */
const BEV = 0.035;
const FZ = ZF + BEV;
const RZ = ZR - BEV;
const TRIM = "#1b1c1f";
const CHROME = "#cfd3d8";
const RUBBER = "#121315";

const MODEL_NAMES = { sahin: "ŞAHİN", dogan: "DOĞAN SLX", kartal: "KARTAL" } as const;

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
function softTexture(kind: "glow" | "shadow"): THREE.CanvasTexture {
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

function plateTexture(text: string): THREE.CanvasTexture {
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
   * yolda ışık lekesi (gerçek far ışığı olmayan düşük grafikte).
   */
  setHeadlights(n: number, o?: { decal?: boolean; haze?: number }): void;
  /** Tekerlekler: `dist` metre yuvarlanır (geri giderken eksi), ön tekerlekler `steer` radyan döner. */
  roll(dist: number, steer: number): void;
  /** Hasar (0 yok – 3 ağır): boya kararır, tozlanır. */
  setDamage(level: number): void;
  dispose(): void;
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
  const model = spec.model;
  const wagon = model === "kartal";
  const dogan = model === "dogan";
  /** Basık süspansiyon: gövde tekerleklere göre aşağıda. */
  const dy = spec.low ? -0.06 : 0;
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const add = (into: THREE.BufferGeometry[], g: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter = 0) => into.push(part(g, color, m, jitter, rand));
  const bodyAt = (x: number, y: number, z: number, ry = 0) => mat(x, y + dy, z, ry);
  const box = (w: number, h: number, d: number, color: string, x: number, y: number, z: number, jitter = 0) => add(body, new THREE.BoxGeometry(w, h, d), color, bodyAt(x, y, z), jitter);
  const lit = (w: number, h: number, d: number, color: string, x: number, y: number, z: number) => add(glow, new THREE.BoxGeometry(w, h, d), color, bodyAt(x, y, z));
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
  // Alt gövde: çamurluk kemerli silüet (sedanda bagaj, stationda kabin arkaya kadar)
  // ---------------------------------------------------------------
  const lower = new THREE.Shape();
  const ARCH = 0.385;
  lower.moveTo(ZF - 0.07, 0.3);
  lower.lineTo(AXLE + ARCH, 0.3);
  lower.absarc(AXLE, 0.31, ARCH, 0, Math.PI, false);
  lower.lineTo(-AXLE + ARCH, 0.3);
  lower.absarc(-AXLE, 0.31, ARCH, 0, Math.PI, false);
  lower.lineTo(ZR + 0.07, 0.3);
  lower.lineTo(ZR, 0.42);
  lower.lineTo(ZR, 0.84);
  lower.lineTo(ZR + 0.05, wagon ? BELT : 0.93);
  if (!wagon) lower.lineTo(-1.15, 0.955);
  lower.lineTo(1.0, BELT);
  lower.lineTo(ZF - 0.09, 0.845);
  lower.lineTo(ZF, 0.78);
  lower.lineTo(ZF, 0.42);
  lower.closePath();
  add(body, extrude(lower, W, 0.035), paint, bodyAt(0, 0, 0), 0.015);
  // Çamurluk içi (koyu astar)
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const liner = new THREE.CylinderGeometry(ARCH - BEV - 0.01, ARCH - BEV - 0.01, 0.3, 16, 1, true, 0, Math.PI).rotateZ(Math.PI / 2);
      add(body, liner, "#0d0e10", bodyAt(sx * (W / 2 - 0.17), 0.31, sz * AXLE));
    }
  }

  // ---------------------------------------------------------------
  // Kabin: direkler ve tavan (boya), camlar (şeffaf), B direği siyah, tavan kenarında krom oluk
  // ---------------------------------------------------------------
  const cabRear = wagon ? -2.05 : -1.13, roofRear = wagon ? -1.98 : -0.7;
  const cab = poly([[1.0, BELT - 0.01], [0.3, ROOF], [roofRear, ROOF], [cabRear, wagon ? BELT : 0.95]]);
  add(body, extrude(cab, CAB_W, 0.045), paint, bodyAt(0, 0, 0), 0.015);
  const sideGlass: [number, number][][] = [
    [[0.9, 0.975], [0.29, 1.335], [-0.12, 1.335], [-0.12, 0.975]],
    wagon ? [[-0.22, 0.975], [-0.22, 1.335], [-1.05, 1.335], [-1.05, 0.975]] : [[-0.22, 0.975], [-0.22, 1.335], [-0.67, 1.335], [-1.02, 0.985]],
  ];
  if (wagon) sideGlass.push([[-1.15, 0.975], [-1.15, 1.335], [-1.93, 1.335], [-1.99, 0.975]]);
  for (const pts of sideGlass) add(glass, extrude(poly(pts), CAB_W + 0.016, 0), spec.tint ? "#0d1014" : "#9fb4c2", bodyAt(0, 0, 0));
  // Ön cam ve arka cam (eğik)
  slab(glass, 0.97, 0.955, 0.33, 1.365, CAB_W - 0.12, 0.02, spec.tint ? "#0d1014" : "#9fb4c2", 0.05);
  if (wagon) slab(glass, -2.04, 0.98, -1.99, 1.34, CAB_W - 0.14, 0.02, spec.tint ? "#0d1014" : "#9fb4c2", 0.05);
  else slab(glass, -0.73, 1.365, -1.1, 0.98, CAB_W - 0.12, 0.02, spec.tint ? "#0d1014" : "#9fb4c2", 0.05);
  // Siyah B (ve stationda C) direği, cam çıtaları, tavan oluğu
  box(CAB_W + 0.03, 0.38, 0.1, TRIM, 0, 1.155, -0.17);
  if (wagon) box(CAB_W + 0.03, 0.38, 0.1, TRIM, 0, 1.155, -1.1);
  for (const sx of [-1, 1]) {
    box(0.012, 0.02, wagon ? 2.9 : 1.95, CHROME, sx * (CAB_W / 2 + 0.012), 0.968, wagon ? -0.55 : -0.06);
    box(0.02, 0.025, Math.abs(roofRear) + 0.32, CHROME, sx * (CAB_W / 2 - 0.01), ROOF + 0.035, (0.3 + roofRear) / 2);
  }
  if (wagon) for (const sx of [-1, 1]) {
    // Kartal: tavan rayları
    box(0.04, 0.05, 2.2, "#2c2e33", sx * 0.6, ROOF + 0.09, -0.85);
    for (const z of [0.15, -0.85, -1.85]) box(0.05, 0.08, 0.06, "#2c2e33", sx * 0.6, ROOF + 0.05, z);
  }

  // ---------------------------------------------------------------
  // Kaporta detayları: kapı ve kaput çizgileri, kollar, koruma çıtası, marşpiyel, ayna, anten, depo kapağı
  // ---------------------------------------------------------------
  const seamX = W / 2 + 0.004;
  for (const sx of [-1, 1]) {
    for (const z of wagon ? [0.98, -0.17, -1.1] : [0.98, -0.17, -1.11]) box(0.008, 0.56, 0.012, "#2a2b2e", sx * seamX, 0.64, z);
    for (const z of [0.6, -0.48]) {
      box(0.03, 0.035, 0.17, CHROME, sx * (W / 2 + 0.015), 0.8, z);
      box(0.012, 0.05, 0.2, "#2a2b2e", sx * (W / 2 + 0.006), 0.8, z);
    }
    box(0.03, 0.065, 3.7, TRIM, sx * (W / 2 + 0.016), 0.54, 0);
    box(0.034, 0.012, 3.7, CHROME, sx * (W / 2 + 0.02), 0.555, 0);
    box(0.04, 0.09, 1.7, dogan ? TRIM : "#26272a", sx * (W / 2 - 0.005), 0.34, 0);
    // Ayna: gövdeye bağlayan kol ve kapak
    box(0.08, 0.04, 0.08, TRIM, sx * (CAB_W / 2 + 0.1), 0.99, 0.82);
    box(0.06, 0.1, 0.16, dogan ? paint : TRIM, sx * (CAB_W / 2 + 0.17), 1.03, 0.8);
    box(0.012, 0.08, 0.13, "#7f96a6", sx * (CAB_W / 2 + 0.205), 1.03, 0.8);
  }
  // Kaput ve bagaj çizgileri
  for (const sx of [-1, 1]) slab(body, 1.02, BELT, ZF - 0.1, 0.845, 0.012, 0.006, "#2a2b2e", BEV + 0.004, sx * 0.7);
  if (!wagon) {
    box(1.5, 0.008, 0.02, "#2a2b2e", 0, 0.955 + BEV + 0.003, -1.16);
    for (const sx of [-1, 1]) box(0.012, 0.006, 0.95, "#2a2b2e", sx * 0.7, 0.95 + BEV + 0.003, -1.64);
  } else box(1.4, 0.012, 0.012, "#2a2b2e", 0, 0.9, RZ - 0.004);
  // Anten (sağ ön çamurluk) ve depo kapağı (sağ arka)
  add(body, new THREE.CylinderGeometry(0.006, 0.01, 0.8, 5), "#222", bodyAt(-0.72, 1.24, 1.55));
  box(0.01, 0.12, 0.12, "#2a2b2e", -(W / 2 + 0.004), 0.82, -1.55);

  // ---------------------------------------------------------------
  // Ön: tampon, ızgara, farlar, sinyaller, plaka, amblem
  // ---------------------------------------------------------------
  const bumper = dogan ? paint : TRIM;
  box(W + 0.06, 0.17, 0.16, bumper, 0, 0.37, ZF + 0.06);
  for (const sx of [-1, 1]) box(0.16, 0.17, 0.4, bumper, sx * (W / 2 - 0.02), 0.37, ZF - 0.1);
  if (!dogan) box(W + 0.07, 0.025, 0.02, CHROME, 0, 0.42, ZF + 0.142);
  box(W - 0.14, 0.3, 0.04, "#101113", 0, 0.62, FZ + 0.005);
  if (dogan) {
    // Doğan: tek parça geniş farlar, ince gövde rengi ızgara çıtası, tamponda sis farları
    for (const sx of [-1, 1]) {
      box(0.52, 0.2, 0.03, CHROME, sx * 0.52, 0.64, FZ + 0.012);
      lit(0.48, 0.16, 0.03, head, sx * 0.52, 0.64, FZ + 0.02);
      box(0.18, 0.11, 0.02, "#151515", sx * 0.48, 0.36, ZF + 0.148);
      lit(0.14, 0.08, 0.02, "#fff3b0", sx * 0.48, 0.36, ZF + 0.155);
      lit(0.1, 0.06, 0.02, "#ffa23a", sx * (W / 2 - 0.05), 0.5, FZ - 0.01);
    }
    box(0.42, 0.05, 0.035, paint, 0, 0.72, FZ + 0.02);
    for (let k = 0; k < 3; k++) box(0.38, 0.015, 0.03, "#2a2b2e", 0, 0.57 + k * 0.045, FZ + 0.02);
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
  // Tofaş amblemi
  add(body, new THREE.CylinderGeometry(0.055, 0.055, 0.02, 16).rotateX(Math.PI / 2), CHROME, bodyAt(0, 0.64, FZ + 0.035));
  add(body, new THREE.CylinderGeometry(0.04, 0.04, 0.02, 16).rotateX(Math.PI / 2), "#1f4fbf", bodyAt(0, 0.64, FZ + 0.04));

  // ---------------------------------------------------------------
  // Arka: tampon, stoplar (kırmızı/turuncu/beyaz bölmeli), plaka yuvası, egzoz
  // ---------------------------------------------------------------
  box(W + 0.06, 0.17, 0.16, bumper, 0, 0.37, ZR - 0.06);
  for (const sx of [-1, 1]) box(0.16, 0.17, 0.4, bumper, sx * (W / 2 - 0.02), 0.37, ZR + 0.1);
  if (!dogan) box(W + 0.07, 0.025, 0.02, CHROME, 0, 0.42, ZR - 0.142);
  if (wagon) {
    // Kartal: arka köşelerde dikey stoplar, bagaj kapağı kolu
    for (const sx of [-1, 1]) {
      box(0.16, 0.42, 0.03, TRIM, sx * 0.72, 0.7, RZ - 0.01);
      lit(0.12, 0.22, 0.03, "#e01919", sx * 0.72, 0.76, RZ - 0.02);
      lit(0.12, 0.08, 0.03, "#ffa23a", sx * 0.72, 0.6, RZ - 0.02);
      lit(0.12, 0.05, 0.03, "#f4f4f0", sx * 0.72, 0.53, RZ - 0.02);
    }
    box(0.3, 0.04, 0.03, CHROME, 0, 0.8, RZ - 0.015);
  } else {
    for (const sx of [-1, 1]) {
      box(0.6, 0.22, 0.03, TRIM, sx * 0.49, 0.67, RZ - 0.01);
      const segs: [number, number, string][] = [[0.72, 0.2, "#e01919"], [0.55, 0.12, "#ffa23a"], [0.44, 0.08, "#f4f4f0"], [0.31, 0.16, "#e01919"]];
      for (const [x, w, c] of segs) lit(w - 0.02, 0.17, 0.03, c, sx * x, 0.67, RZ - 0.02);
    }
    box(0.36, 0.2, 0.025, "#26272a", 0, 0.67, RZ - 0.01);
  }
  add(body, new THREE.CylinderGeometry(0.035, 0.035, 0.02, 14).rotateX(Math.PI / 2), CHROME, bodyAt(0, 0.82, RZ - 0.02));
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
  box(1.32, 0.12, 0.34, "#232326", 0, 0.95, 0.62);
  lit(0.24, 0.07, 0.01, "#7fd4ff", 0.36, 1.03, 0.515);
  add(body, new THREE.TorusGeometry(0.17, 0.022, 6, 18).rotateX(-0.45), "#1a1a1a", bodyAt(0.36, 1.03, 0.47));
  for (const sx of [-1, 1]) {
    box(0.48, 0.12, 0.5, cloth, sx * 0.36, 0.55, -0.02);
    add(body, new THREE.BoxGeometry(0.46, 0.62, 0.12).rotateX(-0.18), cloth, bodyAt(sx * 0.36, 0.86, -0.3));
    box(0.26, 0.16, 0.1, cloth, sx * 0.36, 1.24, -0.36);
  }
  box(1.3, 0.12, 0.5, cloth, 0, 0.55, -0.92);
  add(body, new THREE.BoxGeometry(1.3, 0.5, 0.12).rotateX(-0.2), cloth, bodyAt(0, 0.82, wagon ? -1.23 : -0.84));
  box(1.36, 0.04, 2.6, "#1d1d20", 0, 0.47, -0.35);

  // ---------------------------------------------------------------
  // Çıkartmalar ve aksesuarlar
  // ---------------------------------------------------------------
  const stripe = light ? "#1b1c1f" : "#f4f4f0";
  if (spec.decal === "serit") {
    for (const x of [-0.17, 0.17]) {
      slab(body, 1.02, BELT, ZF - 0.1, 0.845, 0.16, 0.006, stripe, BEV + 0.008, x);
      box(0.16, 0.006, Math.abs(roofRear) + 0.25, stripe, x, ROOF + 0.048, (0.3 + roofRear) / 2);
      if (!wagon) slab(body, -1.16, 0.955, ZR + 0.06, 0.93, 0.16, 0.006, stripe, BEV + 0.008, x);
    }
  } else if (spec.decal === "alev") {
    // Ön çamurluktan arkaya uzanan alev dilleri: dış kat kırmızı-turuncu, iç kat sarı
    const tongue = (scale: number) => {
      const s = new THREE.Shape();
      s.moveTo(1.95, 0.45);
      const tips: [number, number][] = [[0.6, 0.86], [0.85, 0.66], [-0.2, 0.82], [0.25, 0.6], [-0.9, 0.7], [-0.2, 0.5], [-1.4, 0.52], [0.2, 0.42]];
      for (const [z, y] of tips) s.lineTo(1.95 + (z - 1.95) * scale, 0.45 + (y - 0.45) * scale);
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
        if ((k + r) % 2) box(0.006, 0.06, 0.2, "#151515", sx * (W / 2 + 0.008), 0.66 + r * 0.06, -1.6 + k * 0.2);
      }
    }
    box(0.66, 0.16, 0.24, "#f2c230", 0, ROOF + 0.13, -0.15);
    box(0.7, 0.03, 0.28, TRIM, 0, ROOF + 0.05, -0.15);
  }
  if (spec.spoiler === "kucuk") {
    slab(body, ZR + 0.25, wagon ? ROOF + 0.02 : 0.98, ZR + 0.05, wagon ? ROOF + 0.06 : 1.02, W - 0.24, 0.045, light ? paint : TRIM, 0.02);
  } else if (spec.spoiler === "buyuk") {
    const zw = ZR + 0.22, yb = wagon ? ROOF : 0.96;
    for (const sx of [-0.55, 0.55]) box(0.05, 0.3, 0.12, TRIM, sx, yb + 0.15, zw);
    slab(body, zw + 0.2, yb + 0.33, zw - 0.18, yb + 0.29, W + 0.08, 0.045, paint, 0);
    for (const sx of [-1, 1]) box(0.03, 0.18, 0.44, TRIM, sx * (W / 2 + 0.06), yb + 0.33, zw);
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
  const disposables: { dispose(): void }[] = [];
  const mesh = (geos: THREE.BufferGeometry[], material: THREE.Material, shadow = false) => {
    const m = new THREE.Mesh(mergeGeometries(geos), material);
    m.castShadow = shadow;
    group.add(m);
    disposables.push(m.geometry, material);
    return m;
  };
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mesh(body, bodyMat, true);
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
  mesh(glow, new THREE.MeshBasicMaterial({ vertexColors: true }));

  const decal = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ry: number, emissive = "#555555", transparent = false) => {
    const m = new THREE.MeshLambertMaterial({ map: tex, emissive, emissiveMap: tex, transparent });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    p.position.set(x, y + dy, z);
    p.rotation.y = ry;
    group.add(p);
    disposables.push(tex, m, p.geometry);
  };
  decal(plateTexture(spec.plate), 0.52, 0.115, 0, 0.37, ZF + 0.146, 0);
  decal(plateTexture(spec.plate), 0.52, 0.115, 0, 0.37, ZR - 0.146, Math.PI);
  decal(badgeTexture(MODEL_NAMES[model]), 0.36, 0.08, -0.5, wagon ? 0.9 : 0.86, RZ - 0.008, Math.PI, "#444444", true);
  if (spec.decal === "dama") {
    for (const s of [-1, 1]) decal(badgeTexture("TAKSİ", "#111", "#f2c230"), 0.62, 0.14, 0, ROOF + 0.13, -0.15 + s * 0.125, s > 0 ? 0 : Math.PI, "#7a6a20");
  }

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(W + 0.7, 4.33 + 0.8).rotateX(-Math.PI / 2),
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
      const p = new THREE.Mesh(new THREE.PlaneGeometry(W + s, 4.33 + s * 1.2).rotateX(-Math.PI / 2), neonMats[i]);
      p.position.y = 0.07 + i * 0.01;
      p.renderOrder = 2;
      group.add(p);
      disposables.push(p.geometry, neonMats[i]);
    }
    const tubes = [-1, 1].map((sx) => part(new THREE.CylinderGeometry(0.018, 0.018, 3.2, 6).rotateX(Math.PI / 2), neonHex, mat(sx * (W / 2 - 0.12), 0.27 + dy, 0)));
    tubes.push(part(new THREE.CylinderGeometry(0.018, 0.018, W - 0.4, 6).rotateZ(Math.PI / 2), neonHex, mat(0, 0.27 + dy, ZF - 0.25)));
    mesh(tubes, new THREE.MeshBasicMaterial({ vertexColors: true }));
  }
  // ---------------------------------------------------------------
  // Farlar: gece öne uzanan hüzmeler (iki koni), yolda önü aydınlatan ışık lekesi, far ve stop haleleri.
  // Hepsi toplamalı ve ucuz: sahnedeki bütün arabalarda çalışır (gerçek ışık yalnızca en yakın birkaçında,
  // bkz. cars.ts). Gündüz görünmez.
  // ---------------------------------------------------------------
  const headCol = new THREE.Color(head);
  const lampY = 0.64 + dy, lampX = dogan ? 0.52 : 0.46;
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
  for (const sx of [-1, 1]) {
    // Koni: tepesi farda, ekseni öne (+z), hafif aşağı ve dışa bakar
    const g = new THREE.ConeGeometry(1.6, BEAM_LEN, 20, 1, true).translate(0, -BEAM_LEN / 2, 0).rotateX(-Math.PI / 2 + 0.07).rotateY(sx * 0.05);
    const m = new THREE.Mesh(g, beamMat);
    m.position.set(sx * lampX, lampY, FZ + 0.05);
    m.renderOrder = 7;
    m.frustumCulled = false;
    group.add(m);
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
        float half = 0.12 + 0.36 * along;          // genişlik öne doğru açılır
        float x = abs(vUv.x - 0.5);
        float side = 1.0 - smoothstep(half * 0.5, half, x);
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
    group.add(sp);
    disposables.push(m);
    return m;
  };
  const heads = [-1, 1].map((sx) => halo(headCol, 0.45, sx * lampX, lampY, FZ + 0.06));
  const tails = [-1, 1].map((sx) => halo("#ff2a1a", 0.3, sx * 0.66, 0.72 + dy, RZ - 0.05));
  pool.visible = false;
  return {
    group,
    headColor: headCol,
    setHeadlights(n, o = {}) {
      const on = n > 0.01, haze = Math.min(1, (o.haze ?? 0) * 1.5);
      pool.visible = on && o.decal !== false;
      for (const c of group.children) if (c instanceof THREE.Mesh && c.material === beamMat) c.visible = on && haze > 0.02;
      beamUniforms.uOpacity.value = 0.1 * n * haze;
      poolUniforms.uOpacity.value = 0.75 * n;
      for (const m of heads) m.opacity = 0.85 * n;
      for (const m of tails) m.opacity = 0.6 * n;
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
