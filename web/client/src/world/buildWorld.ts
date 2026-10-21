// Mahalle: arsaların blokları (tür başına tek InstancedMesh), arsa sınırları ve sahip tabelaları, bloklarla
// çarpışma (ızgara: duvarın içinden geçilmez, üstüne zıplanır). Değişince örnekler toptan yeniden yazılır
// (birkaç bin blok, nadiren): kare başına maliyeti yok.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { STEP_UP } from "../../../shared/constants";
import {
  type Block,
  type BlockKind,
  BLOCKS,
  blockDef,
  blockHeight,
  cellKey,
  decodeBlocks,
  isSolid,
  PLOT_H,
  PLOT_MAX_BLOCKS,
  PLOT_SIZE,
  PLOTS,
  type PlotState,
} from "../../../shared/build";
import type { Vec2 } from "./colliders";
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

/** Tür başına geometri: tabanı y=0'da, xz'de hücrenin ortasında. */
function geometryFor(kind: BlockKind): THREE.BufferGeometry {
  switch (kind) {
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
    case "glass":
      return centered(new THREE.BoxGeometry(1, 1, 0.12), 0.5);
    case "door":
      // İki blok boyunda kapı (üstündeki hücre boş bırakılır)
      return centered(new THREE.BoxGeometry(0.92, 2, 0.12), 1);
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

const KINDS: BlockKind[] = ["cube", "slab", "wedge", "glass", "door", "lamp", "plant", "fence"];
/** Tür başına en çok örnek (bütün arsalar). */
const CAP = PLOTS.length * PLOT_MAX_BLOCKS;

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
  private meshes = {} as Record<BlockKind, THREE.InstancedMesh>;
  /** Örnek → (arsa, hücre anahtarı): ışın testinde vurulan blok. */
  private lookup = {} as Record<BlockKind, { plot: number; key: number }[]>;
  private dirty = true;
  private lampMat: THREE.MeshBasicMaterial;
  private ground: THREE.Mesh;
  private signs: { mesh: THREE.Mesh; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; text: string }[] = [];
  /** Sütun başına dolu katlar (bit maskesi) ve en üst blokların yükseklikleri: çarpışma için. */
  private columns = new Map<number, { mask: number; tops: number[] }>();

  constructor() {
    const solidMat = new THREE.MeshLambertMaterial({ flatShading: true });
    const colored = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const glass = new THREE.MeshLambertMaterial({ color: "#ffffff", transparent: true, opacity: 0.38, depthWrite: false });
    this.lampMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    const mats: Record<BlockKind, THREE.Material> = {
      cube: solidMat, slab: solidMat, wedge: solidMat, door: solidMat, fence: solidMat,
      glass, lamp: this.lampMat, plant: colored,
    };
    for (const kind of KINDS) {
      const m = new THREE.InstancedMesh(geometryFor(kind), mats[kind], CAP);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = kind !== "glass" && kind !== "lamp";
      m.receiveShadow = kind !== "glass";
      if (kind === "glass") m.renderOrder = 4;
      this.meshes[kind] = m;
      this.lookup[kind] = [];
      this.group.add(m);
    }
    // Arsa zeminleri: hafif açık toprak, kenarında taş çerçeve (ışın testinde zemin)
    const tiles = PLOTS.map((p) => new THREE.PlaneGeometry(PLOT_SIZE, PLOT_SIZE).rotateX(-Math.PI / 2).translate(p.x0 + PLOT_SIZE / 2, 0.025, p.z0 + PLOT_SIZE / 2));
    this.ground = new THREE.Mesh(mergeGeometries(tiles), new THREE.MeshLambertMaterial({ color: "#8fa86a" }));
    this.ground.receiveShadow = true;
    this.group.add(this.ground);
    const frame: THREE.BufferGeometry[] = [];
    for (const p of PLOTS) {
      const cx = p.x0 + PLOT_SIZE / 2, cz = p.z0 + PLOT_SIZE / 2;
      for (const [w, d, x, z] of [[PLOT_SIZE + 0.3, 0.15, cx, p.z0], [PLOT_SIZE + 0.3, 0.15, cx, p.z0 + PLOT_SIZE], [0.15, PLOT_SIZE + 0.3, p.x0, cz], [0.15, PLOT_SIZE + 0.3, p.x0 + PLOT_SIZE, cz]]) {
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
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.45), new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, emissive: "#333333", emissiveMap: tex }));
      mesh.position.set(p.x0 + PLOT_SIZE + 0.15, 1.6, p.z0 + 0.15);
      mesh.rotation.y = Math.PI / 4;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.4, 6), new THREE.MeshLambertMaterial({ color: "#5b3f25" }));
      post.position.set(p.x0 + PLOT_SIZE + 0.15, 0.7, p.z0 + 0.15);
      this.group.add(mesh, post);
      this.signs.push({ mesh, canvas, tex, text: "" });
    }
    this.drawSigns();
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
    p.blocks = new Map(decodeBlocks(s.data).map((b) => [cellKey(b.i, b.j, b.k), b]));
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
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<BlockKind, number>;
    for (const k of KINDS) this.lookup[k].length = 0;
    this.columns.clear();
    this.plots.forEach((p, plot) => {
      const base = PLOTS[plot];
      for (const [key, bl] of p.blocks) {
        const def = blockDef(bl.b);
        if (!def) continue;
        const mesh = this.meshes[def.kind];
        const n = counts[def.kind]++;
        pos.set(base.x0 + bl.i + 0.5, bl.j, base.z0 + bl.k + 0.5);
        q.setFromAxisAngle(up, (bl.r * Math.PI) / 2);
        mesh.setMatrixAt(n, m.compose(pos, q, one));
        // Aynı renk duvarlar düz görünmesin: hücreye göre çok hafif ton farkı
        const jitter = 1 + (((bl.i * 7 + bl.j * 13 + bl.k * 5) % 7) - 3) * 0.012;
        // Saksı/çiçek kendi renklerinde (örnek rengi beyaz); diğerleri türün rengi
        mesh.setColorAt(n, def.kind === "plant" ? c.setRGB(1, 1, 1) : c.set(def.color).multiplyScalar(def.kind === "lamp" || def.kind === "glass" ? 1 : jitter));
        this.lookup[def.kind].push({ plot, key });
        // Çarpışma sütunu
        if (isSolid(bl.b)) {
          const ck = colKey(base.x0 + bl.i, base.z0 + bl.k);
          const col = this.columns.get(ck) ?? { mask: 0, tops: new Array(PLOT_H).fill(0) };
          col.mask |= 1 << bl.j;
          col.tops[bl.j] = bl.j + blockHeight(bl.b);
          this.columns.set(ck, col);
        }
      }
    });
    for (const k of KINDS) {
      const mesh = this.meshes[k];
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Işın: önce bloklar, sonra arsa zemini. Arsa dışında null. */
  raycast(ray: THREE.Raycaster): BuildHit | null {
    let best: BuildHit | null = null, bestD = Infinity;
    for (const kind of KINDS) {
      const mesh = this.meshes[kind];
      if (!mesh.count) continue;
      for (const h of ray.intersectObject(mesh, false)) {
        if (h.distance >= bestD || h.instanceId === undefined) break;
        const l = this.lookup[kind][h.instanceId];
        const bl = l && this.plots[l.plot].blocks.get(l.key);
        if (!bl || !h.face) continue;
        // Normal dünya eksenine yuvarlanır (çatı eğiminde yukarı)
        const n = h.face.normal.clone().transformDirection(new THREE.Matrix4().makeRotationY((bl.r * Math.PI) / 2));
        const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
        const [nx, ny, nz] = ay >= ax && ay >= az ? [0, Math.sign(n.y), 0] : ax >= az ? [Math.sign(n.x), 0, 0] : [0, 0, Math.sign(n.z)];
        best = { plot: l.plot, i: bl.i, j: bl.j, k: bl.k, nx, ny, nz };
        bestD = h.distance;
        break;
      }
    }
    const g = ray.intersectObject(this.ground, false)[0];
    if (g && g.distance < bestD) {
      const plot = PLOTS.findIndex((p) => g.point.x >= p.x0 && g.point.x < p.x0 + PLOT_SIZE && g.point.z >= p.z0 && g.point.z < p.z0 + PLOT_SIZE);
      if (plot >= 0) {
        const p = PLOTS[plot];
        best = { plot, i: Math.floor(g.point.x - p.x0), j: -1, k: Math.floor(g.point.z - p.z0), nx: 0, ny: 1, nz: 0 };
      }
    }
    return best;
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
          if (!(col.mask & (1 << j))) continue;
          const top = col.tops[j];
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
function blocksBody(col: { mask: number; tops: number[] }, y: number): boolean {
  for (let j = 0; j < PLOT_H; j++) {
    if (!(col.mask & (1 << j))) continue;
    if (col.tops[j] > y + STEP_UP && j < y + BODY_H) return true;
  }
  return false;
}

/** Palet: blok türleri (UI için). */
export const PALETTE = BLOCKS.map((b, i) => ({ id: i + 1, ...b }));
