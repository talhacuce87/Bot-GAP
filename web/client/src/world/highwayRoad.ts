// Otoyol sahnesi: yol virajlı ve yokuşlu olduğu için her TILE metrelik parça yolun o bölümüne göre kurulur (parça
// görüş alanına girince, karede en çok bir tane). Parçada asfalt, şerit çizgileri, beton orta bariyer (açıklıklarda
// biter, uçlarında bariller), otokorkuluk, aydınlatma direkleri; yoldan uzaklaştıkça yükselip alçalan arazi, tarla
// renkleri, ağaçlar, köy evleri; arada üst geçit ve tabela köprüsü. Parçanın köşeleri yolun aynı örneklerinden
// hesaplandığı için parçalar dikişsiz birleşir. Gökyüzü kubbesi ve ufuktaki tepeler kamerayla gider.
import * as THREE from "three";
import { hash, HW, type Road, ROAD_STEP, type RoadPoint } from "../../../shared/highway";
import { mat, part, rng } from "./geo";

export const TILE = 120;
const BEHIND = 1;
const AHEAD = 6;
/** Arazi yoldan en çok bu kadar yana uzanır (viraj içinde yarıçapa göre daralır: katlanmasın). */
const WIDE = 240;

const ASPHALT = "#3c3f45";
const LINE = "#eeeeea";
const YELLOW = "#e7bf35";
const RAIL = "#c3c8ce";
const POST = "#80868d";
const GRAVEL = "#9b9484";
const CONCRETE = "#bdb9b0";
const FIELDS = [new THREE.Color("#7aa64f"), new THREE.Color("#8db158"), new THREE.Color("#c9b264"), new THREE.Color("#6f9446"), new THREE.Color("#a7b85e"), new THREE.Color("#b9a35a")];
const LEAVES = ["#4e7d38", "#5d8c3e", "#3f6e33", "#6b9443"];

/** İki boyutlu yumuşak gürültü (0–1). */
function noise(seed: number, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number) => hash(seed, a, b);
  const top = h(xi, yi) * (1 - sx) + h(xi + 1, yi) * sx, bot = h(xi, yi + 1) * (1 - sx) + h(xi + 1, yi + 1) * sx;
  return top * (1 - sy) + bot * sy;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Arazinin yola göre yüksekliği: yolun kenarı biraz aşağıda (hendek), uzaklaştıkça tepeler ve çukurlar. */
export function terrainLift(seed: number, s: number, d: number): number {
  const a = Math.abs(d);
  const ditch = -0.35 * smooth(HW.rail + 1, HW.rail + 3, a) * (1 - smooth(HW.rail + 6, HW.rail + 14, a));
  const hills = (noise(seed + 7, s / 140, d / 90) - 0.45) * 26 * smooth(HW.rail + 8, 90, a);
  const far = noise(seed + 9, s / 400, d / 200) * 30 * smooth(90, WIDE, a);
  return ditch + hills + far;
}

/** Hazır parça (ağaç, direk, köprü…): renkli, indekssiz geometri dizileri. */
interface Proto {
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
}

function proto(list: THREE.BufferGeometry[]): Proto {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  return { pos, nor, col };
}

/** Parçanın geometrisi: şeritler (dörtgenler) ve yerleştirilmiş hazır parçalar. */
class Mesh {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  private c = new THREE.Color();

  /** Dörtgen (a, b, c, d sırayla, yukarıdan bakınca saat yönünün tersine); köşe başına renk. */
  quad(a: number[], b: number[], c: number[], d: number[], ca: THREE.Color, cb = ca, cc = cb, cd = ca): void {
    this.tri(a, b, c, ca, cb, cc);
    this.tri(a, c, d, ca, cc, cd);
  }

  tri(a: number[], b: number[], c: number[], ca: THREE.Color, cb: THREE.Color, cc: THREE.Color): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    [nx, ny, nz] = [nx / l, ny / l, nz / l];
    for (const [p, col] of [[a, ca], [b, cb], [c, cc]] as const) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(col.r, col.g, col.b);
    }
  }

  color(hex: string): THREE.Color {
    return this.c.set(hex).clone();
  }

  /** Hazır parçayı dönüşümüyle ekle (döndürme + ölçek; normaller yalnızca döner). */
  add(p: Proto, m: THREE.Matrix4): void {
    const e = m.elements;
    const sx = Math.hypot(e[0], e[1], e[2]) || 1, sy = Math.hypot(e[4], e[5], e[6]) || 1, sz = Math.hypot(e[8], e[9], e[10]) || 1;
    for (let i = 0; i < p.pos.length; i += 3) {
      const x = p.pos[i], y = p.pos[i + 1], z = p.pos[i + 2];
      this.pos.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
      const nx = p.nor[i], ny = p.nor[i + 1], nz = p.nor[i + 2];
      this.nor.push((e[0] / sx) * nx + (e[4] / sy) * ny + (e[8] / sz) * nz, (e[1] / sx) * nx + (e[5] / sy) * ny + (e[9] / sz) * nz, (e[2] / sx) * nx + (e[6] / sy) * ny + (e[10] / sz) * nz);
      this.col.push(p.col[i], p.col[i + 1], p.col[i + 2]);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ---- Hazır parçalar (bir kez kurulur) ----

function box(list: THREE.BufferGeometry[], w: number, h: number, d: number, color: string, x: number, y: number, z: number, rand?: () => number, jitter = 0): void {
  list.push(part(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z), jitter, rand));
}

function makeProtos() {
  const rand = rng(41);
  const trees = LEAVES.map((leaf, i) => {
    const l: THREE.BufferGeometry[] = [];
    l.push(part(new THREE.CylinderGeometry(0.14, 0.2, 1.6, 5), "#6b4f35", mat(0, 0.8, 0)));
    l.push(part(new THREE.IcosahedronGeometry(1.7, 0), leaf, mat(0, 2.9, 0, i), 0.15, rand));
    l.push(part(new THREE.IcosahedronGeometry(1.1, 0), leaf, mat(0.4, 4, -0.3, i * 2), 0.15, rand));
    return proto(l);
  });
  const poplar = proto([part(new THREE.CylinderGeometry(0.12, 0.16, 1.2, 5), "#6b4f35", mat(0, 0.6, 0)), part(new THREE.ConeGeometry(0.9, 6.5, 6), "#4a7a36", mat(0, 4.4, 0), 0.12, rand)]);
  const houses = ["#e9e1cf", "#d9c7a6", "#efe9df", "#c9b08a"].map((wall, i) => {
    const w = 7, d = 6, h = 3.4, r = (w * 1.08) / Math.sqrt(3);
    const roof = new THREE.CylinderGeometry(r, r, d * 1.08, 3).rotateX(-Math.PI / 2).scale(1, 0.5, 1);
    return proto([part(new THREE.BoxGeometry(w, h, d), wall, mat(0, h / 2, 0)), part(roof, i % 2 ? "#8a3c2d" : "#b5523b", mat(0, h + 0.25 * r, 0))]);
  });
  // Direk: yerel +x yola doğru (kol yolun üstüne uzanır)
  const pole: THREE.BufferGeometry[] = [];
  box(pole, 0.18, 9, 0.18, "#8f959c", 0, 4.5, 0);
  box(pole, 2.4, 0.14, 0.16, "#8f959c", 1.15, 8.95, 0);
  box(pole, 0.7, 0.16, 0.34, "#d8d5c8", 2.2, 8.82, 0);
  const post: THREE.BufferGeometry[] = [];
  box(post, 0.12, 0.8, 0.12, POST, 0, 0.3, 0);
  // Bariyer ucu: sarı-siyah başlık ve önünde turuncu varil sırası (yerel +z açıklığa doğru)
  const cap: THREE.BufferGeometry[] = [];
  box(cap, 0.62, 0.86, 0.5, "#f2c230", 0, 0.43, 0.25);
  box(cap, 0.64, 0.18, 0.52, "#1b1c1f", 0, 0.45, 0.25);
  for (let i = 0; i < 3; i++) {
    cap.push(part(new THREE.CylinderGeometry(0.32, 0.32, 0.95, 8), i % 2 ? "#f3f1ec" : "#e8742a", mat(0, 0.47, 1.1 + i * 0.75)));
    cap.push(part(new THREE.CylinderGeometry(0.33, 0.33, 0.14, 8), "#f3f1ec", mat(0, 0.62, 1.1 + i * 0.75)));
  }
  // Üst geçit: yolun üstünden geçen köprü (yerel x yana), ayakları bariyerin dışında
  const bridge: THREE.BufferGeometry[] = [];
  const span = 60, y = 6.6;
  box(bridge, span * 2, 1.1, 9, CONCRETE, 0, y, 0, rand, 0.04);
  for (const s of [-1, 1]) {
    box(bridge, span * 2, 0.9, 0.3, "#d6d2c8", 0, y + 0.95, s * 4.35);
    for (const x of [HW.rail + 2.5, 26, 44]) box(bridge, 1.2, y + 8, 1.2, "#a9a59c", s * x, y - 4.5, 0, rand, 0.05);
    // Uçlarda toprak set
    box(bridge, 30, y + 10, 14, "#7f9b4b", s * (span + 13), y / 2 - 5, 0, rand, 0.06);
  }
  // Tabela köprüsü: yeşil yön levhaları (yazı yerine beyaz çubuklar); levhalar gidiş yönüne (−z) bakar
  const gantry: THREE.BufferGeometry[] = [];
  const gy = 7;
  for (const s of [-1, 1]) {
    box(gantry, 0.35, gy + 3.6, 0.35, "#9aa0a6", s * (HW.rail + 0.8), gy / 2 - 1.2, 0);
    const cx = s * (HW.median + HW.laneW);
    box(gantry, 6.4, 2.4, 0.15, "#1f6b3c", cx, gy, 0);
    box(gantry, 6.6, 2.6, 0.08, LINE, cx, gy, 0.06);
    box(gantry, 3.6, 0.32, 0.05, LINE, cx + 0.6, gy + 0.45, -0.1);
    box(gantry, 2.4, 0.32, 0.05, LINE, cx + 1.2, gy - 0.25, -0.1);
    box(gantry, 0.9, 0.6, 0.05, LINE, cx - 2.2, gy + 0.1, -0.1);
  }
  box(gantry, 2 * (HW.rail + 0.8), 0.3, 0.3, "#9aa0a6", 0, gy + 1.45, 0);
  box(gantry, 2 * (HW.rail + 0.8), 0.3, 0.3, "#9aa0a6", 0, gy - 1.35, 0.4);
  return { trees, poplar, houses, pole: proto(pole), post: proto(post), cap: proto(cap), bridge: proto(bridge), gantry: proto(gantry) };
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

/** Ufuk: çepeçevre sıra sıra tepeler (sissiz, havanın rengine karışan tonlarda). */
function hills(): THREE.Mesh {
  const rand = rng(77);
  const list: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const r0 = 700 + k * 260, color = ["#8ea79a", "#9fb3b0", "#b1c2c6"][k];
    for (let a = 0; a < Math.PI * 2; a += 0.12 + rand() * 0.1) {
      const r = 140 + rand() * 200, h = 60 + rand() * 120 + k * 40, rr = r0 + (rand() - 0.5) * 160;
      list.push(part(new THREE.ConeGeometry(r, h, 7, 1), color, mat(Math.sin(a) * rr, h / 2 - 20, Math.cos(a) * rr, rand() * 3), 0.05, rand));
    }
  }
  const p = proto(list);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(p.pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(p.nor, 3));
  g.setAttribute("color", new THREE.BufferAttribute(p.col, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
}

export class HighwayRoad {
  readonly group = new THREE.Group();
  /** Kamerayla giden uzak katman (gökyüzü ve tepeler). */
  readonly far = new THREE.Group();
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private protos = makeProtos();
  private tiles = new Map<number, { mesh: THREE.Mesh; ox: number; oz: number }>();
  private pt: RoadPoint = { x: 0, z: 0, h: 0, th: 0, g: 0, k: 0 };

  constructor(private road: Road) {
    this.far.add(skyDome(), hills());
  }

  /**
   * Görünen parçalar: `s` arabanın yol üstündeki yeri, (ox, oz) çizim kökü (sahne = dünya − kök). Eksik parça
   * kurulur (`all` değilse karede en çok bir tane: takılmasın), uzakta kalan atılır.
   */
  update(s: number, ox: number, oz: number, camera: THREE.Vector3, camY: number, all = false): void {
    const first = Math.floor(s / TILE) - BEHIND, last = first + BEHIND + AHEAD;
    for (const [k, t] of this.tiles) {
      if (k >= first && k <= last) continue;
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      this.tiles.delete(k);
    }
    let built = 0;
    for (let k = first; k <= last; k++) {
      if (k < 0 || this.tiles.has(k) || (!all && built++ > 0 && k > first + 2)) continue;
      this.tiles.set(k, this.build(k));
    }
    for (const t of this.tiles.values()) {
      t.mesh.position.set(t.ox - ox, 0, t.oz - oz);
      t.mesh.updateMatrix();
      if (!t.mesh.parent) this.group.add(t.mesh);
    }
    this.far.position.set(camera.x, camY - 8, camera.z);
  }

  /** Parçayı kurar: köşeler parçanın başına göre (sahne koordinatları küçük kalsın). */
  private build(k: number): { mesh: THREE.Mesh; ox: number; oz: number } {
    const road = this.road, seed = road.seed, s0 = k * TILE, n = TILE / ROAD_STEP;
    const o = road.at(s0, this.pt);
    const ox = o.x, oz = o.z;
    const m = new Mesh();
    // Örnekler: yer, sol yön, yükseklik, yön açısı ve eğrilik
    const S: { s: number; x: number; z: number; h: number; th: number; k: number; lx: number; lz: number }[] = [];
    for (let j = 0; j <= n; j++) {
      const s = s0 + j * ROAD_STEP, p = road.at(s, this.pt);
      S.push({ s, x: p.x - ox, z: p.z - oz, h: p.h, th: p.th, k: p.k, lx: Math.cos(p.th), lz: -Math.sin(p.th) });
    }
    const at = (j: number, d: number, dy = 0) => {
      const q = S[j];
      return [q.x + q.lx * d, q.h + dy, q.z + q.lz * d];
    };
    // Şerit: [d0, d1] arası, sabit renk
    const strip = (d0: number, d1: number, dy: number, color: THREE.Color, from = 0, to = n) => {
      for (let j = from; j < to; j++) m.quad(at(j, d0, dy), at(j + 1, d0, dy), at(j + 1, d1, dy), at(j, d1, dy), color);
    };
    // Dikey şerit (bariyer kuşağı): iki yüzlü
    const wall = (d: number, y0: number, y1: number, color: THREE.Color, j: number) => {
      m.quad(at(j, d, y0), at(j + 1, d, y0), at(j + 1, d, y1), at(j, d, y1), color);
      m.quad(at(j + 1, d, y0), at(j, d, y0), at(j, d, y1), at(j + 1, d, y1), color);
    };

    // Asfalt ve emniyet şeridinin dışındaki çakıl
    strip(-(HW.rail + 0.4), HW.rail + 0.4, 0, m.color(ASPHALT));
    for (const sd of [-1, 1]) strip(sd > 0 ? HW.rail + 0.4 : -(HW.rail + 1.6), sd > 0 ? HW.rail + 1.6 : -(HW.rail + 0.4), -0.02, m.color(GRAVEL));

    // Arazi: yolun iki yanında sütunlar; viraj içinde yarıçapa göre daralır
    const cols = [HW.rail + 1.6, HW.rail + 4, HW.rail + 9, 28, 48, 80, 125, 180, WIDE];
    const field = (s: number, d: number, out: THREE.Color) => {
      const f = FIELDS[Math.floor(noise(seed + 3, s / 110, d / 45) * FIELDS.length * 0.999)];
      return out.copy(f).multiplyScalar(0.9 + noise(seed + 5, s / 13, d / 9) * 0.2);
    };
    for (const sd of [-1, 1]) {
      const ring = S.map((q) => {
        // Bu yan virajın içindeyse arazi yarıçapın %80'ine kadar
        const inner = q.k * sd > 1e-5 ? Math.min(WIDE, 0.8 / Math.abs(q.k)) : WIDE;
        const scale = (inner - cols[0]) / (WIDE - cols[0]);
        return cols.map((c, i) => (i === 0 ? c : cols[0] + (c - cols[0]) * scale) * sd);
      });
      const cA = new THREE.Color(), cB = new THREE.Color(), cC = new THREE.Color(), cD = new THREE.Color();
      for (let j = 0; j < n; j++) {
        for (let c = 0; c + 1 < cols.length; c++) {
          const d0 = ring[j][c], d1 = ring[j][c + 1], e0 = ring[j + 1][c], e1 = ring[j + 1][c + 1];
          const y = (jj: number, d: number) => terrainLift(seed, S[jj].s, d) - 0.02;
          const a = at(j, d0, y(j, d0)), b = at(j + 1, e0, y(j + 1, e0)), cc = at(j + 1, e1, y(j + 1, e1)), dd = at(j, d1, y(j, d1));
          field(S[j].s, d0, cA);
          field(S[j + 1].s, e0, cB);
          field(S[j + 1].s, e1, cC);
          field(S[j].s, d1, cD);
          // Sağ yanda (d < 0) köşe sırası ters: yüz yukarı baksın
          if (sd > 0) m.quad(a, b, cc, dd, cA, cB, cC, cD);
          else m.quad(dd, cc, b, a, cD, cC, cB, cA);
        }
        // Dış kenar: aşağı perde (arazinin bittiği yer görünmesin)
        const last = cols.length - 1, d0 = ring[j][last], e0 = ring[j + 1][last];
        const top0 = at(j, d0, terrainLift(seed, S[j].s, d0)), top1 = at(j + 1, e0, terrainLift(seed, S[j + 1].s, e0));
        const g = m.color("#7b9150");
        m.quad([top0[0], top0[1] - 60, top0[2]], [top1[0], top1[1] - 60, top1[2]], top1, top0, g);
        m.quad(top1, [top1[0], top1[1] - 60, top1[2]], [top0[0], top0[1] - 60, top0[2]], top0, g);
      }
    }

    // Çizgiler: kenarlar beyaz düz, şerit arası kesik (4 m çizgi 8 m boşluk), bariyerin iki yanı sarı
    const white = m.color(LINE), yellow = m.color(YELLOW);
    const edge = HW.median + 2 * HW.laneW;
    for (const sd of [-1, 1]) {
      const a = sd * (edge + 0.02), b = sd * (edge + 0.17);
      strip(Math.min(a, b), Math.max(a, b), 0.025, white);
      const y0 = sd * (HW.median + 0.02), y1 = sd * (HW.median + 0.14);
      for (let j = 0; j < n; j++) {
        const s = S[j].s;
        // Bariyer açıklığında sarı çizgi kesikli (buradan karşıya geçilir)
        if (!road.gapAt(s + 1) || s % 6 < 3) strip(Math.min(y0, y1), Math.max(y0, y1), 0.025, yellow, j, j + 1);
        if (s % 12 < 4) {
          const c = sd * (HW.median + HW.laneW);
          strip(c - 0.07, c + 0.07, 0.025, white, j, j + 1);
        }
      }
    }

    // Orta bariyer (New Jersey): açıklık dışındaki her örnek arası
    const conc = m.color(CONCRETE), concTop = m.color("#d2cec6");
    const B = HW.barrier, T = 0.12, H = 0.85;
    for (let j = 0; j < n; j++) {
      if (road.gapAt(S[j].s + ROAD_STEP / 2)) continue;
      m.quad(at(j, -B, 0), at(j + 1, -B, 0), at(j + 1, -T, H), at(j, -T, H), conc);
      m.quad(at(j + 1, B, 0), at(j, B, 0), at(j, T, H), at(j + 1, T, H), conc);
      m.quad(at(j, -T, H), at(j + 1, -T, H), at(j + 1, T, H), at(j, T, H), concTop);
    }
    // Açıklığın iki ucunda başlık ve variller (açıklığa doğru)
    for (const [ga, gb] of road.gapsIn(s0, s0 + TILE)) {
      for (const [se, dir] of [[ga, 1], [gb, -1]] as const) {
        if (se < s0 || se >= s0 + TILE) continue;
        const p = road.at(se, this.pt);
        m.add(this.protos.cap, mat(p.x - ox, p.h, p.z - oz, p.th + (dir > 0 ? 0 : Math.PI)));
      }
    }

    // Otokorkuluk: kuşak ve 4 m'de bir direk
    const rail = m.color(RAIL);
    for (const sd of [-1, 1]) {
      for (let j = 0; j < n; j++) {
        wall(sd * HW.rail, 0.42, 0.76, rail, j);
        if (S[j].s % 4 === 0) {
          const p = at(j, sd * (HW.rail + 0.1));
          m.add(this.protos.post, mat(p[0], p[1], p[2], S[j].th));
        }
      }
    }

    // Aydınlatma direkleri: 50 m'de bir, iki yanda kaydırılmış; kol yola doğru
    for (let j = 0; j <= n; j++) {
      const s = S[j].s;
      for (const sd of [-1, 1]) {
        if (s % 50 !== (sd > 0 ? 0 : 26)) continue;
        const p = at(j, sd * (HW.rail + 0.9));
        m.add(this.protos.pole, mat(p[0], p[1], p[2], S[j].th + (sd > 0 ? Math.PI : 0)));
      }
    }

    // Ağaçlar ve evler: parçanın tohumundan; viraj içinde arazinin dışına taşmasın
    const rand = rng(seed * 31 + k * 7919);
    const place = (pr: Proto, s: number, d: number, sc: number, ry: number) => {
      const q = road.at(s, this.pt);
      const x = q.x + Math.cos(q.th) * d - ox, z = q.z - Math.sin(q.th) * d - oz;
      m.add(pr, mat(x, q.h + terrainLift(seed, s, d) - 0.1, z, ry, sc));
    };
    const roomAt = (s: number, sd: number) => {
      const q = road.at(s, this.pt);
      return q.k * sd > 1e-5 ? Math.min(WIDE, 0.8 / Math.abs(q.k)) - 8 : WIDE - 8;
    };
    const trees = 26 + Math.floor(rand() * 20);
    for (let i = 0; i < trees; i++) {
      const sd = rand() < 0.5 ? -1 : 1, s = s0 + rand() * TILE;
      const near = rand() < 0.35, room = roomAt(s, sd);
      const d = sd * Math.min(room, near ? HW.rail + 5 + rand() * 14 : 25 + rand() * (room - 25));
      const pr = rand() < 0.25 ? this.protos.poplar : this.protos.trees[Math.floor(rand() * this.protos.trees.length)];
      place(pr, s, d, 0.7 + rand() * 0.8, rand() * 6);
    }
    if (rand() < 0.45) {
      const sd = rand() < 0.5 ? -1 : 1, s = s0 + 20 + rand() * (TILE - 40);
      place(this.protos.houses[Math.floor(rand() * this.protos.houses.length)], s, sd * Math.min(roomAt(s, sd), 40 + rand() * 70), 1, rand() * 6);
    }

    // Üst geçit (9 parçada bir) ve tabela köprüsü (7 parçada bir), parçanın ortasında yola dik
    const special = ((k % 9) + 9) % 9 === 4 ? this.protos.bridge : ((k % 7) + 7) % 7 === 2 ? this.protos.gantry : null;
    if (special) {
      const mid = S[n >> 1];
      m.add(special, mat(mid.x, mid.h, mid.z, mid.th));
    }

    const mesh = new THREE.Mesh(m.build(), this.material);
    mesh.matrixAutoUpdate = false;
    return { mesh, ox, oz };
  }

  dispose(): void {
    for (const t of this.tiles.values()) t.mesh.geometry.dispose();
    this.tiles.clear();
    this.material.dispose();
    this.far.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
