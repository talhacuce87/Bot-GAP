// Mahalle: arsaların blokları (parça başına tek InstancedMesh, gerektikçe büyür), arsa sınırları ve sahip
// tabelaları, bloklarla çarpışma (ızgara: duvarın içinden geçilmez, üstüne zıplanır). Değişince örnekler
// toptan yeniden yazılır: kare başına maliyeti yok. İmlecin gösterdiği hücre arsanın ızgarasında yürünerek
// bulunur (on binlerce örnekte mesh ışın testi yavaş kalır).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { STEP_UP } from "../../../shared/constants";
import {
  type Block,
  BLOCKS,
  blockDef,
  DOOR_OPEN,
  blockHeight,
  cellKey,
  decodeBlocks,
  isSolid,
  PLOT_H,
  PLOTS,
  type PlotState,
} from "../../../shared/build";
import type { Vec2 } from "./colliders";
import type { BuildOccupancy } from "./lamps";
import { LEDGE } from "./colliders";
import { part } from "./geo";

/** Oyuncunun boyu: bu yükseklikteki blok önünü keser. */
const BODY_H = 1.6;

interface PlotView {
  owner: string | null;
  name: string;
  blocks: Map<number, Block>;
}

function centered(g: THREE.BufferGeometry, y = 0): THREE.BufferGeometry {
  return g.translate(0, y, 0);
}

/**
 * Çizim parçaları: düz türler kendi geometrisiyle; ince cam direk + kollar (komşularına bağlanır), cam blok yüzleri
 * (cam bloklar arasındaki yüz çizilmez, birleşik görünür) ve kapı (menteşesi sola ya da sağa).
 */
type MeshKey = "cube" | "slab" | "wedge" | "lamp" | "plant" | "fence" | "post" | "arm" | "gface" | "doorL" | "doorR";
const MESHES: MeshKey[] = ["cube", "slab", "wedge", "lamp", "plant", "fence", "post", "arm", "gface", "doorL", "doorR"];
/** Parça başına başlangıç örnek sayısı; dolunca mesh daha büyüğüyle değişir. */
const CAP: Record<MeshKey, number> = {
  cube: 16000, slab: 4000, wedge: 4000, lamp: 1000, plant: 1000, fence: 2000, post: 3000, arm: 6000, gface: 6000, doorL: 300, doorR: 300,
};

/**
 * Minecraft tarzı ahşap kapı (iki blok boyu): çerçeve, üstte iki pencere, altta tahta çizgileri ve kol. Kol
 * menteşenin karşısında: `handle` +1 sağda (menteşe solda), −1 solda.
 */
function doorGeometry(handle: 1 | -1): THREE.BufferGeometry {
  const at = (x: number, y: number) => new THREE.Matrix4().makeTranslation(x, y, 0);
  const wood = "#9a6a37", frame = "#6e4521", win = "#cfe9f5";
  return mergeGeometries([
    part(new THREE.BoxGeometry(0.92, 2, 0.1), wood, at(0, 1)),
    part(new THREE.BoxGeometry(0.1, 2, 0.13), frame, at(-0.41, 1)),
    part(new THREE.BoxGeometry(0.1, 2, 0.13), frame, at(0.41, 1)),
    part(new THREE.BoxGeometry(0.92, 0.1, 0.13), frame, at(0, 1.95)),
    part(new THREE.BoxGeometry(0.92, 0.1, 0.13), frame, at(0, 1.02)),
    part(new THREE.BoxGeometry(0.92, 0.1, 0.13), frame, at(0, 0.05)),
    part(new THREE.BoxGeometry(0.08, 0.86, 0.13), frame, at(0, 1.48)),
    part(new THREE.BoxGeometry(0.29, 0.78, 0.115), win, at(-0.2, 1.48)),
    part(new THREE.BoxGeometry(0.29, 0.78, 0.115), win, at(0.2, 1.48)),
    ...[-0.18, 0, 0.18].map((x) => part(new THREE.BoxGeometry(0.03, 0.86, 0.12), frame, at(x, 0.53))),
    part(new THREE.BoxGeometry(0.05, 0.16, 0.24), "#2e2e33", at(handle * 0.33, 1.0)),
  ]);
}

function geometryFor(key: MeshKey): THREE.BufferGeometry {
  switch (key) {
    case "cube":
      return centered(new THREE.BoxGeometry(1, 1, 1), 0.5);
    case "slab":
      return centered(new THREE.BoxGeometry(1, 0.5, 1), 0.25);
    case "wedge": {
      // Rampa: -z yüzü tam yükseklik, +z kenarında sıfır (yön r ile döner)
      const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > 0 && p.getZ(i) > 0) p.setY(i, -0.5);
      g.computeVertexNormals();
      return centered(g, 0.5);
    }
    case "post":
      return centered(new THREE.BoxGeometry(0.12, 1, 0.12), 0.5);
    case "arm":
      // Ortadan +x kenarına uzanan ince cam (yönüne göre döner)
      return new THREE.BoxGeometry(0.44, 1, 0.1).translate(0.28, 0.5, 0);
    case "gface":
      // Cam bloğun bir yüzü: +z'ye bakan, hücre ortasından yarım blok önde
      return new THREE.PlaneGeometry(1, 1).translate(0, 0, 0.5);
    case "doorL":
      return doorGeometry(1);
    case "doorR":
      return doorGeometry(-1);
    case "lamp":
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.05, 0.07, 0.7, 6), "#2f3440", new THREE.Matrix4().makeTranslation(0, 0.35, 0)),
        part(new THREE.BoxGeometry(0.3, 0.3, 0.3), "#ffffff", new THREE.Matrix4().makeTranslation(0, 0.85, 0)),
      ]);
    case "plant":
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.22, 0.18, 0.3, 7), "#9a5b36", new THREE.Matrix4().makeTranslation(0, 0.15, 0)),
        part(new THREE.IcosahedronGeometry(0.28, 0), "#4f8a37", new THREE.Matrix4().makeTranslation(0, 0.45, 0)),
        part(new THREE.IcosahedronGeometry(0.12, 0), "#e85a6f", new THREE.Matrix4().makeTranslation(0.05, 0.7, 0.02)),
        part(new THREE.IcosahedronGeometry(0.1, 0), "#f7d64a", new THREE.Matrix4().makeTranslation(-0.12, 0.62, -0.1)),
      ]);
    case "fence":
      return mergeGeometries([
        part(new THREE.BoxGeometry(0.12, 0.9, 0.12), "#ffffff", new THREE.Matrix4().makeTranslation(-0.44, 0.45, 0)),
        part(new THREE.BoxGeometry(0.12, 0.9, 0.12), "#ffffff", new THREE.Matrix4().makeTranslation(0.44, 0.45, 0)),
        part(new THREE.BoxGeometry(1, 0.1, 0.06), "#ffffff", new THREE.Matrix4().makeTranslation(0, 0.65, 0)),
        part(new THREE.BoxGeometry(1, 0.1, 0.06), "#ffffff", new THREE.Matrix4().makeTranslation(0, 0.3, 0)),
      ]);
  }
}

/** Yatay komşular: +x (doğu), −z (kuzey), −x (batı), +z (güney); kolun dönüş açısı yönle aynı sırada. */
const DIRS: [number, number, number][] = [[1, 0, 0], [0, -1, Math.PI / 2], [-1, 0, Math.PI], [0, 1, -Math.PI / 2]];
/** Cam bloğun yüzleri: komşu (di, dj, dk) ve düzlemin dönüşü (x, y). */
const FACES: [number, number, number, number, number][] = [
  [0, 0, 1, 0, 0], [1, 0, 0, 0, Math.PI / 2], [0, 0, -1, 0, Math.PI], [-1, 0, 0, 0, -Math.PI / 2], [0, 1, 0, -Math.PI / 2, 0], [0, -1, 0, Math.PI / 2, 0],
];
/** Işının arsada en çok yürüyeceği hücre. */
const RAY_STEPS = 400;
/** Gölge ızgarasının kapladığı alan: bütün arsalar. */
const OCC = (() => {
  const x0 = Math.min(...PLOTS.map((p) => p.x0)), z0 = Math.min(...PLOTS.map((p) => p.z0));
  return { x0, z0, w: Math.max(...PLOTS.map((p) => p.x0 + p.size)) - x0, h: PLOT_H, d: Math.max(...PLOTS.map((p) => p.z0 + p.size)) - z0 };
})();
/** Gölge ızgarasında blok değerleri: tam dolu, cam (ışığın bir kısmını geçirir), alt yarısı dolu. */
const OCC_SOLID = 255, OCC_GLASS = 200, OCC_HALF = 128;

/** Bir örnek: konum, dönüş (y; yüzlerde x de) ve renk. */
interface Inst {
  x: number;
  y: number;
  z: number;
  ry: number;
  rx: number;
  color: THREE.Color;
}

/** Kapı oyuncunun önünde mi (F ile açılır): arsa, hücre ve açık mı. */
export interface DoorSpot {
  plot: number;
  i: number;
  j: number;
  k: number;
  open: boolean;
}

export interface BuildHit {
  plot: number;
  /** Vurulan hücre (blok ya da zemin altı: j = -1). */
  i: number;
  j: number;
  k: number;
  /** Yüzeyin normali: yeni blok vurulan hücrenin bu yönündeki komşusuna konur. */
  nx: number;
  ny: number;
  nz: number;
}

export class BuildWorld {
  readonly group = new THREE.Group();
  plots: PlotView[] = PLOTS.map(() => ({ owner: null, name: "", blocks: new Map() }));
  private meshes = {} as Record<MeshKey, THREE.InstancedMesh>;
  private dirty = true;
  private lampMat: THREE.MeshBasicMaterial;
  private ground: THREE.Mesh;
  private signs: { mesh: THREE.Mesh; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; text: string }[] = [];
  /** İnşa lambaları ve blok ızgarası (gece ışığı ve gölgesi için): değişince `lightDirty`. */
  light: { lamps: { x: number; y: number; z: number }[]; occ: BuildOccupancy } = {
    lamps: [],
    occ: { data: new Uint8Array(OCC.w * OCC.h * OCC.d), ...OCC },
  };
  lightDirty = false;
  /** Sütun başına dolu katların üst yükseklikleri (boş kat 0): çarpışma için. */
  private columns = new Map<number, Float32Array>();

  constructor() {
    const solidMat = new THREE.MeshLambertMaterial({ flatShading: true });
    const colored = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const glass = new THREE.MeshLambertMaterial({ color: "#ffffff", transparent: true, opacity: 0.38, depthWrite: false });
    this.lampMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mats: Record<MeshKey, THREE.Material> = {
      cube: solidMat, slab: solidMat, wedge: solidMat, fence: solidMat, lamp: this.lampMat, plant: colored,
      post: glass, arm: glass, gface: glass, doorL: colored, doorR: colored,
    };
    for (const key of MESHES) this.meshes[key] = this.instanced(key, geometryFor(key), mats[key], CAP[key]);
    // Arsa zeminleri: hafif açık toprak, kenarında taş çerçeve
    const tiles = PLOTS.map((p) => new THREE.PlaneGeometry(p.size, p.size).rotateX(-Math.PI / 2).translate(p.x0 + p.size / 2, 0.025, p.z0 + p.size / 2));
    this.ground = new THREE.Mesh(mergeGeometries(tiles), new THREE.MeshLambertMaterial({ color: "#8fa86a" }));
    this.ground.receiveShadow = true;
    this.group.add(this.ground);
    const frame: THREE.BufferGeometry[] = [];
    for (const p of PLOTS) {
      const n = p.size, cx = p.x0 + n / 2, cz = p.z0 + n / 2;
      for (const [w, d, x, z] of [[n + 0.3, 0.15, cx, p.z0], [n + 0.3, 0.15, cx, p.z0 + n], [0.15, n + 0.3, p.x0, cz], [0.15, n + 0.3, p.x0 + n, cz]]) {
        frame.push(part(new THREE.BoxGeometry(w, 0.08, d), "#cfc6b0", new THREE.Matrix4().makeTranslation(x, 0.04, z)));
      }
    }
    const frameMesh = new THREE.Mesh(mergeGeometries(frame), new THREE.MeshLambertMaterial({ vertexColors: true }));
    frameMesh.receiveShadow = true;
    this.group.add(frameMesh);
    // Tabelalar: arsanın yol tarafındaki köşesinde direk üstünde sahibin adı
    for (const p of PLOTS) {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 64;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      // Işıktan etkilenir: gece loş ama okunur (Basic olsa gece parlayıp yazıyı yutar)
      // Arsa büyük: tabela iki kat büyük ve yüksekte, uzaktan okunur
      const k = 2;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.8 * k, 0.45 * k), new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, emissive: "#333333", emissiveMap: tex }));
      // Caddeye bakan kenarın doğu köşesinde
      const sz = p.front < 0 ? p.z0 + 0.15 : p.z0 + p.size - 0.15;
      mesh.position.set(p.x0 + p.size + 0.15, 1.6 * k, sz);
      mesh.rotation.y = Math.PI / 4;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * k, 0.06 * k, 1.6 * k - 0.2, 6), new THREE.MeshLambertMaterial({ color: "#5b3f25" }));
      post.position.set(p.x0 + p.size + 0.15, (1.6 * k - 0.2) / 2, sz);
      this.group.add(mesh, post);
      this.signs.push({ mesh, canvas, tex, text: "" });
    }
    this.drawSigns();
  }

  private instanced(key: MeshKey, geo: THREE.BufferGeometry, mat: THREE.Material, cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, cap);
    const glass = key === "post" || key === "arm" || key === "gface";
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = !glass && key !== "lamp";
    m.receiveShadow = !glass;
    if (glass) m.renderOrder = 4;
    this.group.add(m);
    return m;
  }

  /** Tür için en az `n` örneklik mesh (yetmiyorsa geometrisi ve malzemesi aynı, daha büyüğüyle değişir). */
  private ensureCapacity(key: MeshKey, n: number): void {
    const old = this.meshes[key];
    if (n <= old.instanceMatrix.count) return;
    this.group.remove(old);
    this.meshes[key] = this.instanced(key, old.geometry, old.material as THREE.Material, Math.ceil(n * 1.5));
    old.dispose();
  }

  private drawSigns(): void {
    this.signs.forEach((s, i) => {
      const p = this.plots[i];
      const text = p.owner ? `🏠 ${p.name}` : "🔨 BOŞ ARSA";
      if (text === s.text) return;
      s.text = text;
      const g = s.canvas.getContext("2d")!;
      g.fillStyle = p.owner ? "#f1e6cc" : "#d9efc4";
      g.fillRect(0, 0, 256, 64);
      g.strokeStyle = "#5b3f25";
      g.lineWidth = 6;
      g.strokeRect(3, 3, 250, 58);
      g.fillStyle = "#2b1d10";
      g.textAlign = "center";
      g.textBaseline = "middle";
      let size = 30;
      g.font = `800 ${size}px system-ui, sans-serif`;
      while (size > 14 && g.measureText(text).width > 236) g.font = `800 ${--size}px system-ui, sans-serif`;
      g.fillText(text, 128, 34);
      s.tex.needsUpdate = true;
    });
  }

  setAll(states: PlotState[]): void {
    for (const s of states) this.setPlot(s);
  }

  setPlot(s: PlotState): void {
    const p = this.plots[s.id];
    if (!p) return;
    p.owner = s.owner;
    p.name = s.name;
    p.blocks = new Map(decodeBlocks(s.id, s.data).map((b) => [cellKey(b.i, b.j, b.k), b]));
    this.dirty = true;
  }

  set(plot: number, i: number, j: number, k: number, b: number, r: number): void {
    const p = this.plots[plot];
    if (!p) return;
    const key = cellKey(i, j, k);
    if (b) p.blocks.set(key, { i, j, k, b, r });
    else p.blocks.delete(key);
    this.dirty = true;
  }

  plotOf(userId: string): number {
    return this.plots.findIndex((p) => p.owner === userId);
  }

  /** Kare başına: değiştiyse örnekleri yeniden yaz; gece lambalar parlar. */
  update(lights: number): void {
    this.lampMat.color.setScalar(0.75 + lights * 1.6);
    if (!this.dirty) return;
    this.dirty = false;
    this.drawSigns();
    const out = Object.fromEntries(MESHES.map((k) => [k, [] as Inst[]])) as Record<MeshKey, Inst[]>;
    const white = new THREE.Color(1, 1, 1);
    this.columns.clear();
    const occ = this.light.occ.data, lampsLit: { x: number; y: number; z: number }[] = [];
    occ.fill(0);
    const mark = (wx: number, j: number, wz: number, v: number) => {
      const x = wx - OCC.x0, z = wz - OCC.z0;
      if (x >= 0 && z >= 0 && x < OCC.w && z < OCC.d && j >= 0 && j < OCC.h) occ[x + OCC.w * (j + OCC.h * z)] = v;
    };
    /** Sütuna dolu kat ekle (çarpışma). */
    const fill = (wx: number, wz: number, j: number, top: number) => {
      if (j >= PLOT_H) return;
      const ck = colKey(wx, wz);
      const col = this.columns.get(ck) ?? new Float32Array(PLOT_H);
      col[j] = top;
      this.columns.set(ck, col);
    };
    this.plots.forEach((p, plot) => {
      const base = PLOTS[plot];
      const kindAt = (i: number, j: number, k: number) => blockDef(p.blocks.get(cellKey(i, j, k))?.b ?? 0)?.kind;
      for (const bl of p.blocks.values()) {
        const def = blockDef(bl.b);
        if (!def) continue;
        const cx = base.x0 + bl.i + 0.5, cz = base.z0 + bl.k + 0.5, rot = bl.r & 3, ry = (rot * Math.PI) / 2;
        // Işık: lamba ampulü ışık kaynağı; dolu bloklar gölge düşürür, cam az, kapalı kapı tam
        const wx = base.x0 + bl.i, wz = base.z0 + bl.k;
        if (def.kind === "lamp") lampsLit.push({ x: cx, y: bl.j + 0.85, z: cz });
        else if (def.kind === "cube" || def.kind === "wedge") mark(wx, bl.j, wz, OCC_SOLID);
        else if (def.kind === "glass" || def.kind === "glassbox") mark(wx, bl.j, wz, OCC_GLASS);
        else if (def.kind === "slab") mark(wx, bl.j, wz, OCC_HALF);
        else if (def.kind === "door" && !(bl.r & DOOR_OPEN)) {
          mark(wx, bl.j, wz, OCC_SOLID);
          mark(wx, bl.j + 1, wz, OCC_SOLID);
        }
        const put = (key: MeshKey, x: number, y: number, z: number, a: number, color: THREE.Color, rx = 0) => out[key].push({ x, y, z, ry: a, rx, color });
        // Aynı renk duvarlar düz görünmesin: hücreye göre çok hafif ton farkı
        const jitter = 1 + (((bl.i * 7 + bl.j * 13 + bl.k * 5) % 7) - 3) * 0.012;
        const tint = new THREE.Color(def.color);
        if (def.kind === "glass") {
          // İnce cam: cam, cam blok ve dolu küplere bağlanır; tek bağlantıda düz devam eder, bağlantısızsa yönünde durur
          const link = DIRS.map(([di, dk]) => {
            const n = kindAt(bl.i + di, bl.j, bl.k + dk);
            return n === "glass" || n === "glassbox" || n === "cube";
          });
          const n = link.filter(Boolean).length;
          if (n === 0) link[rot % 2 ? 1 : 0] = link[rot % 2 ? 3 : 2] = true;
          else if (n === 1) link[(link.indexOf(true) + 2) % 4] = true;
          put("post", cx, bl.j, cz, 0, tint);
          link.forEach((on, d) => on && put("arm", cx, bl.j, cz, DIRS[d][2], tint));
        } else if (def.kind === "glassbox") {
          // Cam blok: cam bloğa ya da dolu küpe bakan yüz çizilmez (yan yana bloklar tek parça görünür)
          for (const [di, dj, dk, rx, a] of FACES) {
            const n = kindAt(bl.i + di, bl.j + dj, bl.k + dk);
            if (n === "glassbox" || n === "cube") continue;
            put("gface", cx, bl.j + 0.5, cz, a, tint, rx);
          }
        } else if (def.kind === "door") {
          // Menteşe solda; solunda aynı yöne bakan kapı varsa sağda (çift kapı iki yana açılır)
          const ldx = Math.round(-Math.cos(ry)), ldz = Math.round(Math.sin(ry));
          const left = p.blocks.get(cellKey(bl.i + ldx, bl.j, bl.k + ldz));
          const h = left && blockDef(left.b)?.kind === "door" && (left.r & 3) === rot ? 1 : -1;
          const open = (bl.r & DOOR_OPEN) !== 0;
          // Açıkken menteşe çevresinde 90° döner: yerel merkez (h·0.46, 0.46)
          const lx = open ? h * 0.46 : 0, lz = open ? 0.46 : 0;
          const x = cx + lx * Math.cos(ry) + lz * Math.sin(ry), z = cz - lx * Math.sin(ry) + lz * Math.cos(ry);
          put(h < 0 ? "doorL" : "doorR", x, bl.j, z, ry + (open ? (h * Math.PI) / 2 : 0), white);
          // Kapalı kapı geçilmez (iki blok boyu)
          if (!open) {
            fill(base.x0 + bl.i, base.z0 + bl.k, bl.j, bl.j + 1);
            fill(base.x0 + bl.i, base.z0 + bl.k, bl.j + 1, bl.j + 2);
          }
        } else {
          // Saksı/çiçek kendi renklerinde (örnek rengi beyaz); diğerleri türün rengi
          put(def.kind as MeshKey, cx, bl.j, cz, ry, def.kind === "plant" ? white : tint.multiplyScalar(def.kind === "lamp" ? 1 : jitter));
        }
        // Çarpışma sütunu
        if (isSolid(bl.b) && def.kind !== "door") fill(base.x0 + bl.i, base.z0 + bl.k, bl.j, bl.j + blockHeight(bl.b));
      }
    });
    this.light.lamps = lampsLit;
    this.lightDirty = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, "YXZ"), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    for (const key of MESHES) {
      const list = out[key];
      this.ensureCapacity(key, list.length);
      const mesh = this.meshes[key];
      list.forEach((it, n) => {
        mesh.setMatrixAt(n, m.compose(pos.set(it.x, it.y, it.z), q.setFromEuler(e.set(it.rx, it.ry, 0)), one));
        mesh.setColorAt(n, it.color);
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Yakındaki kapı (F ile açılır/kapanır): ayakların hizasında, en yakını. */
  doorNear(x: number, z: number, y: number, reach = 2.2): DoorSpot | null {
    let best: DoorSpot | null = null, bestD = reach;
    PLOTS.forEach((base, plot) => {
      if (x < base.x0 - reach || x > base.x0 + base.size + reach || z < base.z0 - reach || z > base.z0 + base.size + reach) return;
      const view = this.plots[plot];
      const ci = Math.floor(x - base.x0), ck = Math.floor(z - base.z0), cj = Math.floor(y + 0.1);
      for (let i = ci - 2; i <= ci + 2; i++) for (let k = ck - 2; k <= ck + 2; k++) for (let j = cj - 1; j <= cj; j++) {
        const b = j >= 0 ? view.blocks.get(cellKey(i, j, k)) : undefined;
        if (!b || blockDef(b.b)?.kind !== "door") continue;
        const d = Math.hypot(x - (base.x0 + i + 0.5), z - (base.z0 + k + 0.5));
        if (d < bestD) [best, bestD] = [{ plot, i, j, k, open: (b.r & DOOR_OPEN) !== 0 }, d];
      }
    });
    return best;
  }

  /**
   * Işın `plot` arsasında: ızgarada hücre hücre yürür (Amanatides–Woo), ilk dolu hücre ya da arsa zemini.
   * Kapının üst yarısı da kapıya sayılır. Arsaya değmezse null.
   */
  raycast(ray: THREE.Raycaster, plot: number): BuildHit | null {
    const base = PLOTS[plot], view = this.plots[plot];
    if (!base || !view) return null;
    const size = [base.size, PLOT_H, base.size];
    // Arsanın yerel ızgarasında (x0, 0, z0 köşesi) başlangıç ve yön
    const o = [ray.ray.origin.x - base.x0, ray.ray.origin.y, ray.ray.origin.z - base.z0];
    const d = [ray.ray.direction.x, ray.ray.direction.y, ray.ray.direction.z];
    // Kutuya giriş: en geç giren eksen girilen yüzü verir (içerideyse t0 = 0)
    let t0 = 0, t1 = Infinity, axis = -1;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < 0 || o[a] > size[a]) return null;
        continue;
      }
      let lo = -o[a] / d[a], hi = (size[a] - o[a]) / d[a];
      if (lo > hi) [lo, hi] = [hi, lo];
      if (lo > t0) [t0, axis] = [lo, a];
      t1 = Math.min(t1, hi);
    }
    if (t0 > t1) return null;
    const c = o.map((v, a) => Math.min(size[a] - 1, Math.max(0, Math.floor(v + d[a] * (t0 + 1e-6)))));
    const step = d.map((v) => Math.sign(v));
    const tNext = d.map((v, a) => (v > 0 ? (c[a] + 1 - o[a]) / v : v < 0 ? (c[a] - o[a]) / v : Infinity));
    const tDelta = d.map((v) => (v ? 1 / Math.abs(v) : Infinity));
    const normal = [0, 0, 0];
    if (axis >= 0) normal[axis] = -step[axis];
    const inside = axis < 0;
    for (let n = 0; n < RAY_STEPS; n++) {
      const [i, j, k] = c;
      if (i < 0 || k < 0 || i >= base.size || k >= base.size || j >= PLOT_H) return null;
      if (j < 0) return normal[1] > 0 ? { plot, i, j: -1, k, nx: 0, ny: 1, nz: 0 } : null;
      const below = j > 0 ? view.blocks.get(cellKey(i, j - 1, k)) : undefined;
      const hit = view.blocks.get(cellKey(i, j, k)) ?? (below && blockDef(below.b)?.kind === "door" ? below : undefined);
      // Kamera bir bloğun içindeyse o blok atlanır
      if (hit && !(inside && n === 0)) return { plot, i: hit.i, j: hit.j, k: hit.k, nx: normal[0], ny: normal[1], nz: normal[2] };
      const a = tNext[0] <= tNext[1] && tNext[0] <= tNext[2] ? 0 : tNext[1] <= tNext[2] ? 1 : 2;
      c[a] += step[a];
      tNext[a] += tDelta[a];
      normal.fill(0);
      normal[a] = -step[a];
    }
    return null;
  }

  /** Bloklarla çarpışma: gövde hizasında dolu hücrelerin dışına it (Colliders.resolve sonrası). */
  resolve(p: Vec2, radius: number, y: number): void {
    if (!this.columns.size) return;
    const x0 = Math.floor(p.x - radius - 1), x1 = Math.floor(p.x + radius + 1);
    const z0 = Math.floor(p.z - radius - 1), z1 = Math.floor(p.z + radius + 1);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const col = this.columns.get(colKey(ix, iz));
        if (!col || !blocksBody(col, y)) continue;
        // Kare hücre: en yakın noktaya uzaklık yarıçaptan küçükse dışarı it
        const nx = Math.max(ix, Math.min(p.x, ix + 1)), nz = Math.max(iz, Math.min(p.z, iz + 1));
        const dx = p.x - nx, dz = p.z - nz, d = Math.hypot(dx, dz);
        if (d >= radius) continue;
        if (d > 1e-5) {
          p.x = nx + (dx / d) * radius;
          p.z = nz + (dz / d) * radius;
        } else {
          // Merkez hücrenin içinde: en kısa kenardan çık
          const exits = [[p.x - ix, -1, 0], [ix + 1 - p.x, 1, 0], [p.z - iz, 0, -1], [iz + 1 - p.z, 0, 1]].sort((a, b) => a[0] - b[0])[0];
          p.x += exits[1] * (exits[0] + radius);
          p.z += exits[2] * (exits[0] + radius);
        }
      }
    }
  }

  /** Ayakları `y`de olanın altındaki en yüksek blok üstü (yoksa 0). */
  groundAt(x: number, z: number, radius: number, y: number): number {
    if (!this.columns.size) return 0;
    const r = radius * LEDGE;
    let g = 0;
    for (let ix = Math.floor(x - r); ix <= Math.floor(x + r); ix++) {
      for (let iz = Math.floor(z - r); iz <= Math.floor(z + r); iz++) {
        const col = this.columns.get(colKey(ix, iz));
        if (!col) continue;
        const nx = Math.max(ix, Math.min(x, ix + 1)), nz = Math.max(iz, Math.min(z, iz + 1));
        if (Math.hypot(x - nx, z - nz) > r) continue;
        for (let j = PLOT_H - 1; j >= 0; j--) {
          const top = col[j];
          if (!top) continue;
          if (top <= y + STEP_UP && top > g) {
            g = top;
            break;
          }
        }
      }
    }
    return g;
  }
}

function colKey(ix: number, iz: number): number {
  return (ix + 1000) * 4096 + (iz + 1000);
}

/** Sütunda gövde hizasına (ayaktan basamak üstü – baş) denk gelen dolu blok var mı. */
function blocksBody(col: Float32Array, y: number): boolean {
  for (let j = 0; j < PLOT_H; j++) {
    if (col[j] && col[j] > y + STEP_UP && j < y + BODY_H) return true;
  }
  return false;
}

/** Palet: blok türleri (UI için). */
export const PALETTE = BLOCKS.map((b, i) => ({ id: i + 1, ...b }));
