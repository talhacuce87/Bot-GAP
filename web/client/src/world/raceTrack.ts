// GAP Ring: casino otoparkının arkasındaki yarış pisti. Asfalt şerit, beyaz kenar çizgileri, virajlarda kırmızı-
// beyaz kerbler ve çakıl havuzu, iki yanda beton bariyer (arabayı durdurur, yaya üstünden atlar) ve lastik
// yığınları; start/bitiş damalı çizgisi, numaralı grid kutuları, beş lambalı start köprüsü (F1 gibi: kırmızılar
// tek tek yanar, hepsi söner, yeşil yanar), tribün, pit binası, otoparka bağlanan paddock ve iç sahada ağaçlar.
import * as THREE from "three";
import { BARRIER, GRID, PIT_GATE, RACE_AREA, START_S, TRACK, TRACK_HALF, TRACK_LENGTH, trackAt, trackProject } from "../../../shared/race";
import type { Builder } from "./builder";
import { Colliders, type DynamicColliders } from "./colliders";
import { mat, part } from "./geo";

export interface RaceTrack {
  group: THREE.Group;
  /** Start lambaları: yanık kırmızı sayısı (0–5) ve yeşil. */
  setLights(red: number, green: boolean): void;
  /** Pit kapısı: yarış sürerken kol iner, arabalar pistten çıkamaz/giremez. */
  setGate(closed: boolean): void;
}

const ASPHALT = "#3a3d43";
const LINE = "#f1f1ec";
const KERB_RED = "#d8262b";
const GRAVEL = "#c9b58e";
const WALL = "#e6e6e2";
const WALL_RED = "#c8262b";
const Y = 0.06;

/** Orta çizginin sol normali (sürüş yönüne göre): (dz, −dx). */
const left = (i: number) => {
  const p = TRACK[i];
  return [p.dz, -p.dx] as const;
};

/** Noktadaki eğrilik yarıçapı (yakın noktaların yön farkından). */
function radiusAt(i: number): number {
  const n = TRACK.length, a = TRACK[(i - 2 + n) % n], b = TRACK[(i + 2) % n];
  const turn = Math.abs(Math.atan2(a.dx * b.dz - a.dz * b.dx, a.dx * b.dx + a.dz * b.dz));
  const ds = (b.s - a.s + TRACK_LENGTH) % TRACK_LENGTH;
  return turn > 1e-4 ? ds / turn : Infinity;
}

/** Yön değişimi (çapraz çarpım): < 0 sola, > 0 sağa dönüş. */
function turnAt(i: number): number {
  const n = TRACK.length, a = TRACK[(i - 2 + n) % n], b = TRACK[(i + 2) % n];
  return a.dx * b.dz - a.dz * b.dx;
}

/** Virajın içi hangi tarafta: +1 sol, −1 sağ. */
function insideSide(i: number): number {
  return turnAt(i) > 0 ? -1 : 1;
}

/**
 * Viraj bölgeleri: keskin noktalar genişletilir ve aradaki kısa boşluklar doldurulur, böylece çakıl yamalar
 * halinde değil virajın tamamında durur. Her bölge için dış taraf (toplam dönüşe göre): −1 sağ, +1 sol.
 */
function cornerRegions(n: number): { idx: number[]; outside: number }[] {
  const sharp = Array.from({ length: n }, (_, i) => radiusAt(i) < 45);
  let on = sharp.map((_, i) => {
    for (let k = -6; k <= 6; k++) if (sharp[(i + k + n) % n]) return true;
    return false;
  });
  // Kısa boşlukları (< 16 nokta ≈ 24 m) doldur
  const start = on.indexOf(false);
  if (start < 0) on = on.map(() => true);
  else {
    let k = 0;
    while (k < n) {
      const i = (start + k) % n;
      if (on[i]) {
        k++;
        continue;
      }
      let len = 0;
      while (len < n && !on[(i + len) % n]) len++;
      if (len < 16) for (let j = 0; j < len; j++) on[(i + j) % n] = true;
      k += len;
    }
  }
  const regions: { idx: number[]; outside: number }[] = [];
  const first = on.indexOf(false);
  if (first < 0) return [{ idx: Array.from({ length: n }, (_, i) => i), outside: 1 }];
  let cur: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    if (on[i]) cur.push(i);
    else if (cur.length) {
      const turn = cur.reduce((a, j) => a + turnAt(j), 0);
      regions.push({ idx: cur, outside: turn < 0 ? -1 : 1 });
      cur = [];
    }
  }
  return regions;
}

/** Orta çizgiye paralel şerit: seçilen segmentlerde [o1, o2] ofsetleri arası dörtgenler. */
function ribbon(segs: number[], o1: number, o2: number, y: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const n = TRACK.length;
  for (const i of segs) {
    const j = (i + 1) % n, a = TRACK[i], b = TRACK[j];
    const [ax, az] = left(i), [bx, bz] = left(j);
    const p = (q: typeof a, nx: number, nz: number, o: number) => [q.x + nx * o, y, q.z + nz * o];
    const a1 = p(a, ax, az, o1), a2 = p(a, ax, az, o2), b1 = p(b, bx, bz, o1), b2 = p(b, bx, bz, o2);
    // Yukarı bakan iki üçgen (sarım yönü ofset sırasına göre)
    if (o2 > o1) pos.push(...a1, ...b1, ...a2, ...a2, ...b1, ...b2);
    else pos.push(...a1, ...a2, ...b1, ...a2, ...b2, ...b1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function numberTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const g = c.getContext("2d")!;
  // Üst yarı: köprü afişi; alt yarı: 8 grid numarası
  g.fillStyle = "#101318";
  g.fillRect(0, 0, 1024, 128);
  g.fillStyle = "#e10600";
  g.fillRect(0, 108, 1024, 20);
  g.font = "900 84px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#ffffff";
  g.fillText("GAP RING", 512, 58);
  g.clearRect(0, 128, 1024, 128);
  g.font = "900 96px system-ui, sans-serif";
  for (let i = 0; i < 8; i++) g.fillText(String(i + 1), 64 + i * 128, 196);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Atlasın bir dikdörtgeni için UV'li düzlem. */
function atlasPlane(w: number, h: number, u0: number, v0: number, u1: number, v1: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return g;
}

export function raceTrack(b: Builder): RaceTrack {
  const group = new THREE.Group();
  const rand = b.rand;
  const add = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, m?: THREE.Matrix4, jitter = 0.03) => b.add(part(geo, color, m, jitter, rand));
  const box = (w: number, h: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, ry = 0, jitter = 0.03) =>
    add(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry), jitter);
  const cyl = (r0: number, r1: number, h: number, color: string, x: number, y: number, z: number, seg = 10) =>
    add(new THREE.CylinderGeometry(r0, r1, h, seg), color, mat(x, y, z), 0.02);
  const glows: THREE.BufferGeometry[] = [];

  // Doğal süs (ağaç, kaya) pistin alanına dikilmesin; kendi ağaçlarımızı aşağıda koyarız
  b.clearBox(RACE_AREA.minX, RACE_AREA.maxX, RACE_AREA.minZ, RACE_AREA.maxZ);
  const n = TRACK.length;
  const all = Array.from({ length: n }, (_, i) => i);

  // ---- Asfalt, kenar çizgileri ----
  add(ribbon(all, -TRACK_HALF, TRACK_HALF, Y), ASPHALT, undefined, 0.025);
  for (const s of [-1, 1]) add(ribbon(all, s * (TRACK_HALF - 0.45), s * (TRACK_HALF - 0.25), Y + 0.01), LINE, undefined, 0);

  // ---- Kerbler: pistin iki yanında kesintisiz kırmızı-beyaz (3 m'de bir renk); virajların dışında çakıl ----
  const kerbRed: number[] = [], kerbWhite: number[] = [];
  for (const i of all) (Math.floor(TRACK[i].s / 3) % 2 ? kerbRed : kerbWhite).push(i);
  for (const s of [-1, 1]) {
    add(ribbon(kerbRed, s * TRACK_HALF, s * (TRACK_HALF + 1.1), Y + 0.01), KERB_RED, undefined, 0);
    add(ribbon(kerbWhite, s * TRACK_HALF, s * (TRACK_HALF + 1.1), Y + 0.01), LINE, undefined, 0);
  }
  for (const r of cornerRegions(n)) add(ribbon(r.idx, r.outside * (TRACK_HALF + 1.1), r.outside * (BARRIER - 0.4), Y - 0.012), GRAVEL, undefined, 0.08);

  // ---- Bariyerler: beton duvar, 4 parçada bir kırmızı panel; arabayı durdurur, yaya üstünden atlar ----
  const startU = START_S;
  for (const s of [-1, 1]) {
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n, a = TRACK[i], c = TRACK[j];
      const [ax, az] = left(i), [cx, cz] = left(j);
      const p1x = a.x + ax * s * BARRIER, p1z = a.z + az * s * BARRIER, p2x = c.x + cx * s * BARRIER, p2z = c.z + cz * s * BARRIER;
      // Pit kapısı: ana düzlüğün güney (sağ) yanında açıklık
      const mx = (p1x + p2x) / 2, mz = (p1z + p2z) / 2;
      if (s < 0 && Math.abs(mx - PIT_GATE.x) < PIT_GATE.half && mz > -140) continue;
      const ex = p2x - p1x, ez = p2z - p1z, len = Math.hypot(ex, ez);
      if (len < 0.05) continue;
      box(len + 0.08, 0.9, 0.35, Math.floor(i / 8) % 2 ? WALL : WALL_RED, mx, 0.45, mz, Math.atan2(-ez, ex), 0.02);
      b.colliders.segment(p1x, p1z, p2x, p2z, 0.22, 0.9);
    }
  }
  // Pit kapısının iki yanında direk ve kırmızı-beyaz kol (açık)
  for (const sx of [-1, 1]) {
    const x = PIT_GATE.x + sx * PIT_GATE.half, z = -138 + BARRIER;
    cyl(0.18, 0.2, 1.4, "#f2f2ee", x, 0.7, z);
    for (let k = 0; k < 3; k++) box(0.12, 0.25, 1.2, k % 2 ? LINE : KERB_RED, x, 1.25, z + 0.7 + k * 1.2, 0, 0);
  }
  // Pit kapısı kolu: yarış sürerken iner (kırmızı-beyaz), yalnızca arabaları durdurur
  const gateZ = -138 + BARRIER;
  const boom = new THREE.Group();
  const boomMats = [new THREE.MeshLambertMaterial({ color: KERB_RED }), new THREE.MeshLambertMaterial({ color: LINE })];
  const segs = 7, segW = (2 * PIT_GATE.half - 0.4) / segs;
  for (let k = 0; k < segs; k++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(segW, 0.2, 0.2), boomMats[k % 2]);
    m.position.set(PIT_GATE.x - PIT_GATE.half + 0.2 + (k + 0.5) * segW, 1.05, gateZ);
    boom.add(m);
  }
  boom.visible = false;
  group.add(boom);
  const gateWall = new Colliders();
  gateWall.segment(PIT_GATE.x - PIT_GATE.half, gateZ, PIT_GATE.x + PIT_GATE.half, gateZ, 0.25);
  const gate: DynamicColliders & { closed: boolean } = {
    closed: false,
    resolve(p, radius, y) {
      if (this.closed) gateWall.resolve(p, radius, y);
    },
    groundAt: () => 0,
  };
  b.carColliders.extra = gate;

  // Viraj dışlarında lastik yığınları (bariyerin dışına)
  for (let i = 0; i < n; i += 9) {
    if (radiusAt(i) > 30) continue;
    const s = -insideSide(i), [lx, lz] = left(i), p = TRACK[i];
    const x = p.x + lx * s * (BARRIER + 0.9), z = p.z + lz * s * (BARRIER + 0.9);
    for (let k = 0; k < 3; k++) cyl(0.42, 0.42, 0.3, k % 2 ? "#1d1d20" : "#2a2a2e", x, 0.15 + k * 0.3, z, 12);
    b.colliders.circle(x, z, 0.45, 0.9);
  }

  // ---- Start/bitiş: damalı çizgi (2 sıra), köprü, lambalar ----
  const sp = trackAt(startU), ry = Math.atan2(sp.dx, sp.dz), [nlx, nlz] = [sp.dz, -sp.dx];
  const cells = 12, cw = (2 * TRACK_HALF) / cells;
  for (let row = 0; row < 2; row++) {
    for (let k = 0; k < cells; k++) {
      const o = -TRACK_HALF + (k + 0.5) * cw, f = (row - 0.5) * 0.9;
      const x = sp.x + nlx * o + sp.dx * f, z = sp.z + nlz * o + sp.dz * f;
      box(cw, 0.01, 0.9, (k + row) % 2 ? "#111214" : "#f4f4f0", x, Y + 0.008, z, ry, 0);
    }
  }
  const gy = 6.2;
  for (const s of [-1, 1]) {
    const x = sp.x + nlx * s * (TRACK_HALF + 1.4), z = sp.z + nlz * s * (TRACK_HALF + 1.4);
    box(0.5, gy + 0.6, 0.5, "#2b2f36", x, (gy + 0.6) / 2, z, ry, 0.02);
    box(1.2, 0.3, 1.2, "#2b2f36", x, 0.15, z, ry, 0.02);
    b.colliders.circle(x, z, 0.4);
  }
  // Köprü kirişi ve afiş (iki yüzlü)
  const beamW = 2 * TRACK_HALF + 3.4;
  box(0.6, 0.9, beamW, "#1e2228", sp.x, gy, sp.z, ry + Math.PI / 2, 0.02);
  const tex = numberTexture();
  const bannerMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  for (const f of [-1, 1]) {
    const m = new THREE.Mesh(atlasPlane(beamW - 1, 0.85, 0, 0.5, 1, 1), bannerMat);
    m.position.set(sp.x + sp.dx * f * 0.31, gy + 0.95, sp.z + sp.dz * f * 0.31);
    m.rotation.y = ry + (f > 0 ? 0 : Math.PI);
    group.add(m);
  }
  box(beamW - 0.8, 1.0, 0.6, "#101318", sp.x, gy + 0.95, sp.z, ry, 0);
  // Lamba kutuları: beş sütun, her birinde iki kırmızı ve bir yeşil; grid tarafına (geri) bakar
  const redMats = Array.from({ length: 5 }, () => new THREE.MeshBasicMaterial({ color: "#2a0606" }));
  const greenMat = new THREE.MeshBasicMaterial({ color: "#062a10" });
  const lamp = new THREE.CylinderGeometry(0.17, 0.17, 0.08, 16).rotateX(Math.PI / 2);
  for (let k = 0; k < 5; k++) {
    const o = (k - 2) * 0.75;
    const cx = sp.x + nlx * o - sp.dx * 0.35, cz = sp.z + nlz * o - sp.dz * 0.35;
    box(0.55, 1.5, 0.3, "#0d0f12", cx, gy - 1.05, cz, ry, 0);
    for (const [y, m] of [[gy - 0.55, redMats[k]], [gy - 1.0, redMats[k]], [gy - 1.5, greenMat]] as const) {
      const mesh = new THREE.Mesh(lamp, m);
      mesh.position.set(cx - sp.dx * 0.16, y, cz - sp.dz * 0.16);
      mesh.rotation.y = ry;
      group.add(mesh);
    }
  }

  // ---- Grid kutuları: beyaz köşebent ve numara ----
  const numMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  GRID.forEach((g, i) => {
    const dx = Math.sin(g.rot), dz = Math.cos(g.rot), lx = dz, lz = -dx;
    box(2.4, 0.01, 0.16, LINE, g.x + dx * 2.4, Y + 0.008, g.z + dz * 2.4, g.rot, 0);
    for (const s of [-1, 1]) box(0.16, 0.01, 1.4, LINE, g.x + lx * s * 1.2 + dx * 1.7, Y + 0.008, g.z + lz * s * 1.2 + dz * 1.7, g.rot, 0);
    const num = new THREE.Mesh(atlasPlane(1.1, 1.1, i / 8, 0, (i + 1) / 8, 0.5).rotateX(-Math.PI / 2), numMat);
    num.position.set(g.x + dx * 3.4, Y + 0.012, g.z + dz * 3.4);
    num.rotation.y = g.rot + Math.PI;
    group.add(num);
  });

  // ---- Paddock: otoparktan pit kapısına asfalt, pit binası, tribün ----
  const padZ0 = -138 + BARRIER + 0.2, padZ1 = RACE_AREA.maxZ + 1;
  box(56, 0.04, padZ1 - padZ0, "#45484e", PIT_GATE.x, Y - 0.02, (padZ0 + padZ1) / 2, 0, 0.04);
  for (const s of [-1, 1]) box(0.14, 0.01, padZ1 - padZ0 - 1, LINE, PIT_GATE.x + s * PIT_GATE.half, Y + 0.004, (padZ0 + padZ1) / 2, 0, 0);
  // Pit binası (batıda): beyaz gövde, üç garaj kapısı, çatı şeridi ve afiş
  {
    const x = 432, z = -121.5, w = 26, d = 8, h = 4.2;
    box(w, h, d, "#f2f2ee", x, h / 2, z, 0, 0.02);
    box(w + 0.4, 0.4, d + 0.4, "#1e2228", x, h + 0.2, z, 0, 0);
    box(w + 0.2, 0.25, 0.1, "#e10600", x, h - 0.4, z - d / 2 - 0.06, 0, 0);
    for (let k = -1; k <= 1; k++) box(5.5, 3.0, 0.1, "#3a4048", x + k * 7.5, 1.5, z - d / 2 - 0.05, 0, 0.02);
    const sign = new THREE.Mesh(atlasPlane(8, 1, 0, 0.5, 1, 1), bannerMat);
    sign.position.set(x, h + 1.0, z - d / 2 - 0.2);
    sign.rotation.y = Math.PI;
    group.add(sign);
    box(8.2, 1.15, 0.12, "#101318", x, h + 1.0, z - d / 2 - 0.12, 0, 0);
    for (const s of [-1, 1]) box(0.15, 1.2, 0.15, "#2b2f36", x + s * 3.6, h + 0.4, z - d / 2 - 0.1, 0, 0);
    const [x0, x1, z0, z1] = [x - w / 2, x + w / 2, z - d / 2, z + d / 2];
    for (const [ax, az, bx2, bz2] of [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]]) b.colliders.segment(ax, az, bx2, bz2, 0.2);
  }
  // Tribün (doğuda): beton basamaklar, renkli koltuk sıraları, kolonlu çatı; piste (kuzeye) bakar
  {
    const x = 510, w = 40, z0 = -126.6;
    const seats = ["#e10600", "#1f4fbf", "#f2c230", "#2e8b57"];
    for (let k = 0; k < 5; k++) {
      const z = z0 + k * 1.9, y = 0.5 + k * 0.75;
      box(w, y, 1.9, "#bfc3c8", x, y / 2, z + 0.95, 0, 0.02);
      for (let c = 0; c < 20; c++) box(1.6, 0.35, 0.5, seats[(c + k) % 4], x - w / 2 + 1 + c * 2, y + 0.18, z + 0.7, 0, 0.05);
    }
    const roofY = 6.6;
    for (const s of [-1, 0, 1]) box(0.35, roofY, 0.35, "#2b2f36", x + s * (w / 2 - 0.5), roofY / 2, z0 + 9.2, 0, 0);
    box(w + 1.2, 0.3, 8.6, "#e8e9ec", x, roofY + 0.1, z0 + 5.4, 0, 0.02);
    box(w + 1.2, 0.5, 0.2, "#e10600", x, roofY - 0.1, z0 + 1.1, 0, 0);
    for (const [ax, az, bx2, bz2] of [[x - w / 2, z0, x + w / 2, z0], [x + w / 2, z0, x + w / 2, z0 + 9.5], [x - w / 2, z0, x - w / 2, z0 + 9.5]]) b.colliders.segment(ax, az, bx2, bz2, 0.2);
  }
  // Işık direkleri (gece yarışı): köşelerde, başlık parlar
  for (const [x, z] of [[398, -134], [540, -134], [540, -286], [398, -286], [470, -246], [500, -196]] as const) {
    if (Math.abs(trackProject(x, z).d) < BARRIER + 2) continue;
    cyl(0.16, 0.24, 14, "#8a9099", x, 7, z, 8);
    box(2.6, 1.0, 0.5, "#2b2f36", x, 14.2, z, Math.atan2(470 - x, -210 - z), 0);
    glows.push(part(new THREE.BoxGeometry(2.3, 0.8, 0.1), "#f4f8ff", mat(x, 14.2, z, Math.atan2(470 - x, -210 - z)).multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.28))));
    b.colliders.circle(x, z, 0.3);
  }
  // İç sahada ve kenarlarda çam ağaçları (pistten uzak)
  for (let k = 0; k < 160; k++) {
    const x = RACE_AREA.minX + 4 + rand() * (RACE_AREA.maxX - RACE_AREA.minX - 8);
    const z = RACE_AREA.minZ + 4 + rand() * (RACE_AREA.maxZ - RACE_AREA.minZ - 20);
    if (z > -150 && Math.abs(x - PIT_GATE.x) < 60) continue;
    if (Math.abs(trackProject(x, z).d) < BARRIER + 4) continue;
    const sc = 0.8 + rand() * 0.6;
    b.prop("pine", mat(x, 0, z, rand() * 6, sc));
    b.colliders.circle(x, z, 0.35 * sc);
  }

  if (glows.length) {
    const g = new THREE.Mesh(mergeAll(glows), new THREE.MeshBasicMaterial({ vertexColors: true }));
    g.matrixAutoUpdate = false;
    group.add(g);
  }
  const ON_RED = new THREE.Color("#ff1a1a"), OFF_RED = new THREE.Color("#2a0606");
  const ON_GREEN = new THREE.Color("#2bff6a"), OFF_GREEN = new THREE.Color("#062a10");
  return {
    group,
    setGate(closed) {
      gate.closed = closed;
      boom.visible = closed;
    },
    setLights(red, green) {
      redMats.forEach((m, k) => m.color.copy(k < red ? ON_RED : OFF_RED));
      greenMat.color.copy(green ? ON_GREEN : OFF_GREEN);
    },
  };
}

function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Hepsi part() ile aynı özniteliklerde (position, normal, color)
  const total = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "color"]) {
    const arr = new Float32Array(total * 3);
    let o = 0;
    for (const g of geos) {
      const a = g.attributes[name].array as Float32Array;
      arr.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return out;
}
