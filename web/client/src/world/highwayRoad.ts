// Otoyol sahnesi: TILE metrelik yol parçaları sürekli öne taşınır (sonsuz yol). Her parça birkaç hazır
// çeşitten biri: düz (tarla, ağaç, direk), üst geçit köprüsü, tabela köprüsü. Çeşit parçanın sırasından seçilir,
// aynı yer hep aynı görünür. Gökyüzü kubbesi ve ufuktaki tepeler kamerayla birlikte gider (hiç yaklaşılmaz).
// Yerel eksenler shared/highway gibi: +z ileri, +x sol; parçanın başı z = 0.
import * as THREE from "three";
import { HW } from "../../../shared/highway";
import { flatMat, mat, part, rng } from "./geo";

export const TILE = 120;
const BEHIND = 1;
const AHEAD = 6;
const PLAIN = 4;

const ASPHALT = "#3c3f45";
const LINE = "#eeeeea";
const YELLOW = "#e7bf35";
const RAIL = "#c3c8ce";
const POST = "#80868d";
const GRAVEL = "#9b9484";
const CONCRETE = "#b8b4ab";
const FIELDS = ["#7aa64f", "#8db158", "#c9b264", "#6f9446", "#a7b85e", "#b9a35a"];
const LEAVES = ["#4e7d38", "#5d8c3e", "#3f6e33", "#6b9443"];

/** Bir yol parçasının (ya da çeşidinin) geometrisini toplar. */
class Parts {
  list: THREE.BufferGeometry[] = [];
  constructor(private rand: () => number) {}
  box(w: number, h: number, d: number, color: string, x: number, y: number, z: number, ry = 0, jitter = 0): void {
    this.list.push(part(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry), jitter, this.rand));
  }
  flat(w: number, d: number, color: string, x: number, y: number, z: number): void {
    this.list.push(part(new THREE.PlaneGeometry(w, d), color, flatMat(x, y, z)));
  }
  add(g: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter = 0): void {
    this.list.push(part(g, color, m, jitter, this.rand));
  }
  merge(): THREE.BufferGeometry {
    const g = mergeAll(this.list);
    this.list = [];
    return g;
  }
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** Bütün çeşitlerde ortak: asfalt, çizgiler, emniyet şeridi, bariyer. */
function road(p: Parts): void {
  const edge = HW.median + 2 * HW.laneW;
  p.flat(2 * (HW.rail + 0.4), TILE, ASPHALT, 0, 0, TILE / 2);
  for (const s of [-1, 1]) {
    // Kenar çizgisi, emniyet şeridinin ötesi çakıl
    p.flat(0.16, TILE, LINE, s * (edge + 0.1), 0.012, TILE / 2);
    p.flat(1.4, TILE, GRAVEL, s * (HW.rail + 1.1), 0.004, TILE / 2);
    // Orta çift sarı
    p.flat(0.11, TILE, YELLOW, s * 0.16, 0.012, TILE / 2);
    // Şerit çizgileri: 4 m çizgi, 8 m boşluk
    for (let z = 2; z < TILE; z += 12) p.flat(0.14, 4, LINE, s * (HW.median + HW.laneW), 0.012, z + 2);
    // Bariyer: direkler ve çift oluklu kuşak
    for (let z = 2; z < TILE; z += 4) p.box(0.12, 0.75, 0.12, POST, s * (HW.rail + 0.12), 0.37, z);
    p.box(0.07, 0.32, TILE, RAIL, s * HW.rail, 0.58, TILE / 2);
  }
}

/** Alçak poli ağaç: gövde ve iki katlı taç (ya da kavak). */
function tree(p: Parts, rand: () => number, x: number, z: number): void {
  const s = 0.7 + rand() * 0.8;
  const leaf = LEAVES[Math.floor(rand() * LEAVES.length)];
  p.add(new THREE.CylinderGeometry(0.14 * s, 0.2 * s, 1.6 * s, 5), "#6b4f35", mat(x, 0.8 * s, z));
  if (rand() < 0.3) {
    // Kavak: ince uzun
    p.add(new THREE.ConeGeometry(0.9 * s, 6.5 * s, 6), leaf, mat(x, 4.4 * s, z, rand() * 3), 0.12);
    return;
  }
  p.add(new THREE.IcosahedronGeometry(1.7 * s, 0), leaf, mat(x, 2.9 * s, z, rand() * 3), 0.15);
  p.add(new THREE.IcosahedronGeometry(1.1 * s, 0), leaf, mat(x + 0.4 * s, 4 * s, z - 0.3 * s, rand() * 3), 0.15);
}

/** Uzakta çiftlik evi: gövde, iki yana eğik çatı. */
function house(p: Parts, rand: () => number, x: number, z: number): void {
  const w = 6 + rand() * 4, d = 5 + rand() * 3, h = 3 + rand() * 1.5, ry = rand() < 0.5 ? 0 : Math.PI / 2;
  const wall = ["#e9e1cf", "#d9c7a6", "#efe9df", "#c9b08a"][Math.floor(rand() * 4)];
  p.add(new THREE.BoxGeometry(w, h, d), wall, mat(x, h / 2, z, ry));
  // Üçgen prizma: tepesi yukarıda, boyu d, tabanı w genişliğinde, basık
  const r = (w * 1.08) / Math.sqrt(3);
  const roof = new THREE.CylinderGeometry(r, r, d * 1.08, 3).rotateX(-Math.PI / 2).scale(1, 0.5, 1);
  p.add(roof, rand() < 0.6 ? "#b5523b" : "#8a3c2d", mat(x, h + 0.25 * r, z, ry));
}

/** Kenar manzarası: tarlalar, ağaç sıraları, evler, aydınlatma direkleri. */
function scenery(p: Parts, rand: () => number): void {
  for (const s of [-1, 1]) {
    // Tarlalar: yol boyunca iki-üç şerit, renkleri farklı
    let x0 = HW.rail + 1.8;
    while (x0 < 160) {
      const w = 14 + rand() * 30;
      p.flat(w, TILE, FIELDS[Math.floor(rand() * FIELDS.length)], s * (x0 + w / 2), -0.02, TILE / 2);
      x0 += w;
    }
    // Ağaçlar: yola yakın seyrek, uzakta sık kümeler
    const trees = 14 + Math.floor(rand() * 14);
    for (let i = 0; i < trees; i++) {
      const far = rand() < 0.6;
      const x = s * (far ? 30 + rand() * 120 : HW.rail + 5 + rand() * 18);
      tree(p, rand, x, rand() * TILE);
    }
    if (rand() < 0.35) house(p, rand, s * (45 + rand() * 80), 20 + rand() * (TILE - 40));
    // Aydınlatma direği: 40 m'de bir, iki yanda kaydırılmış
    for (let z = s > 0 ? 10 : 30; z < TILE; z += 40) {
      const x = s * (HW.rail + 0.9);
      p.box(0.18, 9, 0.18, "#8f959c", x, 4.5, z);
      p.box(2.4, 0.14, 0.16, "#8f959c", x - s * 1.15, 8.95, z);
      p.box(0.7, 0.16, 0.34, "#d8d5c8", x - s * 2.2, 8.82, z);
    }
  }
}

/** Üst geçit: yolun üstünden geçen köprü, ayakları bariyerin dışında. */
function overpass(p: Parts): void {
  const z = TILE / 2, span = 70, y = 6.4;
  p.box(span * 2, 1.1, 9, CONCRETE, 0, y, z, 0, 0.04);
  for (const s of [-1, 1]) {
    p.box(span * 2, 0.9, 0.3, "#d6d2c8", 0, y + 0.95, z + s * 4.35);
    for (const x of [HW.rail + 2.5, 22, 38, 54]) p.box(1.2, y - 0.5, 1.2, "#a9a59c", s * x, (y - 0.5) / 2, z, 0, 0.05);
    // Rampa: köprünün iki ucu toprak sete iner
    const ramp = new THREE.BoxGeometry(28, 1, 12);
    p.add(ramp, "#7f9b4b", mat(s * (span + 12), y / 2 - 0.4, z, 0).multiply(new THREE.Matrix4().makeRotationZ(-s * Math.atan2(y, 28))));
  }
}

/** Tabela köprüsü: yolun üstünde yeşil yön levhaları (yazı yerine beyaz çubuklar). */
function gantry(p: Parts): void {
  const z = TILE / 2, y = 7;
  for (const s of [-1, 1]) {
    p.box(0.35, y + 0.6, 0.35, "#9aa0a6", s * (HW.rail + 0.8), (y + 0.6) / 2, z);
    // Levha: gidiş yönüne bakan yüz (−z) beyaz çerçeveli yeşil
    const cx = s * (HW.median + HW.laneW);
    p.box(6.4, 2.4, 0.15, "#1f6b3c", cx, y, z);
    p.box(6.6, 2.6, 0.08, LINE, cx, y, z + 0.06);
    p.box(3.6, 0.32, 0.05, LINE, cx + 0.6, y + 0.45, z - 0.1);
    p.box(2.4, 0.32, 0.05, LINE, cx + 1.2, y - 0.25, z - 0.1);
    p.box(0.9, 0.6, 0.05, LINE, cx - 2.2, y + 0.1, z - 0.1);
  }
  p.box(2 * (HW.rail + 0.8), 0.3, 0.3, "#9aa0a6", 0, y + 1.45, z);
  p.box(2 * (HW.rail + 0.8), 0.3, 0.3, "#9aa0a6", 0, y - 1.35, z + 0.4);
}

/** Parçanın çeşidi: her 9'da bir üst geçit, her 7'de bir tabela, gerisi düz çeşitlerden. */
function variantOf(i: number): number {
  if (((i % 9) + 9) % 9 === 4) return PLAIN;
  if (((i % 7) + 7) % 7 === 2) return PLAIN + 1;
  const h = Math.imul(i ^ 0x5bd1e995, 0x27d4eb2d);
  return ((h ^ (h >>> 13)) >>> 0) % PLAIN;
}

/** Gökyüzü kubbesi: tepede mavi, ufukta açık, altı toprak tonu. */
function skyDome(): THREE.Mesh {
  const g = new THREE.SphereGeometry(1800, 24, 12);
  const top = new THREE.Color("#4f8fd6"), horizon = new THREE.Color("#d6e6ee"), below = new THREE.Color("#a7b48c");
  const c = new Float32Array(g.attributes.position.count * 3), tmp = new THREE.Color();
  for (let i = 0; i < g.attributes.position.count; i++) {
    const y = g.attributes.position.getY(i) / 1800;
    if (y >= 0) tmp.lerpColors(horizon, top, Math.pow(y, 0.6));
    else tmp.copy(below);
    c.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  m.renderOrder = -1;
  return m;
}

/** Ufuk: iki yanda sıra sıra tepeler (sissiz, havanın rengine karışan tonlarda). */
function hills(): THREE.Mesh {
  const rand = rng(77);
  const p = new Parts(rand);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const x = s * (520 + k * 260), color = ["#8ea79a", "#9fb3b0", "#b1c2c6"][k];
      for (let z = -1600; z < 1600; z += 140 + rand() * 120) {
        const r = 140 + rand() * 200, h = 50 + rand() * 120 + k * 40;
        const g = new THREE.ConeGeometry(r, h, 7, 1);
        p.add(g, color, mat(x + (rand() - 0.5) * 160, h / 2 - 10, z, rand() * 3), 0.05);
      }
    }
  }
  return new THREE.Mesh(p.merge(), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
}

export class HighwayRoad {
  readonly group = new THREE.Group();
  /** Kamerayla giden uzak katman (gökyüzü ve tepeler). */
  readonly far = new THREE.Group();
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private variants: THREE.BufferGeometry[] = [];
  private tiles: { mesh: THREE.Mesh; i: number }[] = [];

  constructor() {
    for (let v = 0; v < PLAIN + 2; v++) {
      const rand = rng(1000 + v * 37);
      const p = new Parts(rand);
      road(p);
      scenery(p, rand);
      if (v === PLAIN) overpass(p);
      if (v === PLAIN + 1) gantry(p);
      this.variants.push(p.merge());
    }
    for (let k = 0; k < BEHIND + AHEAD + 1; k++) {
      const mesh = new THREE.Mesh(this.variants[0], this.material);
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.tiles.push({ mesh, i: NaN });
    }
    this.far.add(skyDome(), hills());
  }

  /** Görünen parçalar: `z` kameranın dünyadaki z'si, `origin` çizim kökü (sahne z = dünya z − origin). */
  update(z: number, origin: number, camera: THREE.Vector3): void {
    const n = this.tiles.length, first = Math.floor(z / TILE) - BEHIND;
    for (let i = first; i < first + n; i++) {
      const t = this.tiles[((i % n) + n) % n];
      if (t.i !== i) {
        t.i = i;
        t.mesh.geometry = this.variants[variantOf(i)];
      }
      t.mesh.position.z = i * TILE - origin;
      t.mesh.updateMatrix();
    }
    this.far.position.set(0, 0, camera.z);
  }

  dispose(): void {
    for (const g of this.variants) g.dispose();
    this.material.dispose();
    this.far.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
