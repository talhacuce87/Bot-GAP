// Futbol sahası: çizgili çim, beyaz çizgiler, kaleler ve fileler, kenar panoları, skor tabelası ve top.
// Top sunucudan gelir (konum + hız, `at` anında); burada ileri tahmin edilip yumuşatılarak çizilir.
import * as THREE from "three";
import type { BallState } from "../../../shared/protocol";
import { BALL_R, PITCH } from "../../../shared/zones";
import type { Builder } from "./builder";
import { flatMat, mat, part } from "./geo";

const LINE = "#f4f4ee";
const LINE_W = 0.12;

function line(b: Builder, x: number, z: number, w: number, d: number): void {
  b.add(part(new THREE.PlaneGeometry(w, d), LINE, flatMat(x, 0.034, z)));
}

/** Kale: direkler, üst direk, arka çerçeve; file ayrı (saydam). */
function goal(b: Builder, side: -1 | 1, nets: THREE.BufferGeometry[]): void {
  const gx = PITCH.x + side * PITCH.hx, { goalHalf: gh, goalH: h } = PITCH;
  const depth = 1.2;
  const post = (x: number, z: number, len: number, horiz: "x" | "z" | null) => {
    const g = new THREE.CylinderGeometry(0.06, 0.06, len, 8);
    if (horiz === "z") g.rotateX(Math.PI / 2);
    if (horiz === "x") g.rotateZ(Math.PI / 2);
    b.add(part(g, "#ffffff", mat(x, horiz ? h : len / 2, z)));
  };
  post(gx, PITCH.z - gh, h, null);
  post(gx, PITCH.z + gh, h, null);
  post(gx, PITCH.z, gh * 2, "z");
  // Arka çerçeve
  const bx = gx + side * depth;
  for (const sz of [-1, 1]) {
    b.add(part(new THREE.CylinderGeometry(0.035, 0.035, depth, 6).rotateZ(Math.PI / 2), "#d8d8d8", mat(gx + side * depth / 2, h, PITCH.z + sz * gh)));
    b.add(part(new THREE.CylinderGeometry(0.035, 0.035, h, 6), "#d8d8d8", mat(bx, h / 2, PITCH.z + sz * gh)));
  }
  b.colliders.circle(gx, PITCH.z - gh, 0.12);
  b.colliders.circle(gx, PITCH.z + gh, 0.12);
  // File: arka, iki yan ve üst yüzey
  const back = new THREE.PlaneGeometry(gh * 2, h).rotateY(Math.PI / 2).translate(bx, h / 2, PITCH.z);
  const top = new THREE.PlaneGeometry(depth, gh * 2).rotateX(-Math.PI / 2).translate(gx + side * depth / 2, h, PITCH.z);
  const sideA = new THREE.PlaneGeometry(depth, h).translate(gx + side * depth / 2, h / 2, PITCH.z - gh);
  const sideB = sideA.clone().translate(0, 0, gh * 2);
  nets.push(back, top, sideA, sideB);
}

function netTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(255,255,255,0.85)";
  g.lineWidth = 3;
  for (let i = 0; i <= 64; i += 16) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 64);
    g.moveTo(0, i);
    g.lineTo(64, i);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 4);
  return t;
}

export interface Pitch {
  group: THREE.Group;
  setBall(b: BallState, serverNow: number): void;
  setScore(score: [number, number]): void;
  /** Topun tahmini konumu (şut menzili, ses için). */
  ball: THREE.Vector3;
  update(dt: number, serverNow: number): void;
}

export function pitch(b: Builder): Pitch {
  const { x: cx, z: cz, hx, hz } = PITCH;
  b.clearBox(cx - hx - 2.5, cx + hx + 2.5, cz - hz - 2, cz + hz + 2);

  // Çim şeritleri
  const stripes = 12;
  for (let i = 0; i < stripes; i++) {
    const w = (hx * 2 + 2) / stripes;
    b.add(part(new THREE.PlaneGeometry(w, hz * 2 + 2), i % 2 ? "#5f9b45" : "#6aa94e", flatMat(cx - hx - 1 + (i + 0.5) * w, 0.02, cz), 0.03, b.rand));
  }
  // Çizgiler: kenarlar, orta çizgi, orta yuvarlak, ceza sahaları
  line(b, cx, cz - hz, hx * 2 + LINE_W, LINE_W);
  line(b, cx, cz + hz, hx * 2 + LINE_W, LINE_W);
  line(b, cx - hx, cz, LINE_W, hz * 2);
  line(b, cx + hx, cz, LINE_W, hz * 2);
  line(b, cx, cz, LINE_W, hz * 2);
  b.add(part(new THREE.RingGeometry(2.4, 2.4 + LINE_W, 40), LINE, flatMat(cx, 0.034, cz)));
  b.add(part(new THREE.CircleGeometry(0.15, 12), LINE, flatMat(cx, 0.035, cz)));
  for (const s of [-1, 1]) {
    const bx = cx + s * (hx - 2.5);
    line(b, bx, cz, LINE_W, 9);
    line(b, cx + s * (hx - 1.25), cz - 4.5, 2.5, LINE_W);
    line(b, cx + s * (hx - 1.25), cz + 4.5, 2.5, LINE_W);
    b.add(part(new THREE.CircleGeometry(0.12, 10), LINE, flatMat(cx + s * (hx - 1.8), 0.035, cz)));
  }
  // Köşe bayrakları
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const fx = cx + sx * hx, fz = cz + sz * hz;
      b.add(part(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 5), "#f2f2f2", mat(fx, 0.65, fz)));
      b.add(part(new THREE.BoxGeometry(0.02, 0.28, 0.4), "#e8c81e", mat(fx, 1.15, fz + 0.2)));
      b.colliders.circle(fx, fz, 0.08);
    }
  }
  const nets: THREE.BufferGeometry[] = [];
  goal(b, -1, nets);
  goal(b, 1, nets);

  // Uzun kenarlarda alçak reklam panoları (ortada giriş boşluğu)
  const boards = ["#2f6fd0", "#e04a3a", "#f2c230", "#3a9a5a"];
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 10; i++) {
      const x = cx - hx + 1.3 + i * 2.6;
      if (Math.abs(x - cx) < 2) continue;
      b.add(part(new THREE.BoxGeometry(2.4, 0.55, 0.12), boards[i % 4], mat(x, 0.28, cz + sz * (hz + 0.9)), 0.05, b.rand));
      b.colliders.segment(x - 1.2, cz + sz * (hz + 0.9), x + 1.2, cz + sz * (hz + 0.9), 0.1);
    }
  }
  // Seyirci bankları: kuzey kenarında
  for (let i = 0; i < 3; i++) {
    const x = cx - 8 + i * 8, z = cz - hz - 2.2;
    b.add(part(new THREE.BoxGeometry(3, 0.1, 0.45), "#a0703f", mat(x, 0.45, z)));
    for (const lx of [-1.3, 1.3]) b.add(part(new THREE.BoxGeometry(0.08, 0.45, 0.4), "#5b3f25", mat(x + lx, 0.22, z)));
    b.colliders.segment(x - 1.5, z, x + 1.5, z, 0.3);
    for (const o of [-0.9, 0, 0.9]) b.seats.push({ x: x + o, z, rot: 0 });
  }

  const group = new THREE.Group();
  const netMesh = new THREE.Mesh(
    mergeNets(nets),
    new THREE.MeshBasicMaterial({ map: netTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.8 }),
  );
  netMesh.matrixAutoUpdate = false;
  group.add(netMesh);

  // Skor tabelası: güney kenarında direkli pano
  const sc = document.createElement("canvas");
  sc.width = 256;
  sc.height = 96;
  const scoreTex = new THREE.CanvasTexture(sc);
  scoreTex.colorSpace = THREE.SRGBColorSpace;
  const drawScore = (s: [number, number]) => {
    const g = sc.getContext("2d")!;
    g.fillStyle = "#14171c";
    g.fillRect(0, 0, 256, 96);
    g.fillStyle = "#f2c230";
    g.font = "700 22px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText("GAP FUTBOL", 128, 26);
    g.fillStyle = "#ffffff";
    g.font = "800 50px ui-monospace, monospace";
    g.fillText(`${s[0]} - ${s[1]}`, 128, 82);
    scoreTex.needsUpdate = true;
  };
  drawScore([0, 0]);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.98), new THREE.MeshBasicMaterial({ map: scoreTex, toneMapped: false }));
  board.position.set(cx, 3.1, cz + hz + 2.2);
  board.rotation.y = Math.PI;
  group.add(board);
  for (const sx of [-1.2, 1.2]) b.add(part(new THREE.CylinderGeometry(0.06, 0.08, 3.6, 6), "#2f3440", mat(cx + sx, 1.8, cz + hz + 2.25)));
  b.colliders.circle(cx - 1.2, cz + hz + 2.25, 0.1);
  b.colliders.circle(cx + 1.2, cz + hz + 2.25, 0.1);

  // Top: beyaz ikosahedron, beşgen lekeler siyah
  const ballGeo = new THREE.IcosahedronGeometry(BALL_R, 1).toNonIndexed();
  const cols = new Float32Array(ballGeo.attributes.position.count * 3);
  for (let i = 0; i < cols.length; i += 9) {
    const dark = (i / 9) % 5 === 0;
    for (let k = 0; k < 9; k++) cols[i + k] = dark ? 0.12 : 0.95;
  }
  ballGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  const ballMesh = new THREE.Mesh(ballGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  ballMesh.castShadow = true;
  group.add(ballMesh);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(BALL_R * 1.1, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.3, depthWrite: false }));
  group.add(shadow);

  let state: BallState = { x: cx, y: 0, z: cz, vx: 0, vy: 0, vz: 0, at: 0 };
  const shown = new THREE.Vector3(cx, BALL_R, cz);
  const predicted = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const q = new THREE.Quaternion();

  /** Sunucudaki fiziğin kaba kopyası: son durumdan `t` sn sonrası (sürtünme ve yerçekimi). */
  const predict = (t: number, out: THREE.Vector3) => {
    const s = state;
    const damp = 0.55;
    const k = (1 - Math.exp(-damp * t)) / damp;
    let y = s.y + s.vy * t - 4.9 * t * t;
    if (y < 0) y = 0;
    const air = s.y > 0.01 || s.vy > 0.5;
    out.set(s.x + s.vx * (air ? t : k), y + BALL_R, s.z + s.vz * (air ? t : k));
    out.x = Math.max(cx - hx - 1.1, Math.min(cx + hx + 1.1, out.x));
    out.z = Math.max(cz - hz, Math.min(cz + hz, out.z));
    return out;
  };

  return {
    group,
    ball: shown,
    setBall(bs) {
      state = bs;
    },
    setScore: drawScore,
    update(dt, serverNow) {
      const t = Math.min(0.5, Math.max(0, (serverNow - state.at) / 1000));
      predict(t, predicted);
      const prevX = shown.x, prevZ = shown.z;
      // Büyük sıçramada (gol sonrası ortaya dönüş) doğrudan, yoksa yumuşak
      if (shown.distanceTo(predicted) > 3) shown.copy(predicted);
      else shown.lerp(predicted, 1 - Math.exp(-dt * 18));
      ballMesh.position.copy(shown);
      // Yuvarlanma: gidilen yol kadar dönüş
      const dx = shown.x - prevX, dz = shown.z - prevZ, dist = Math.hypot(dx, dz);
      if (dist > 1e-4) {
        axis.set(dz, 0, -dx).normalize();
        q.setFromAxisAngle(axis, dist / BALL_R);
        ballMesh.quaternion.premultiply(q);
      }
      shadow.position.set(shown.x, 0.04, shown.z);
      const lift = shown.y - BALL_R;
      shadow.scale.setScalar(Math.max(0.4, 1 - lift * 0.3));
      (shadow.material as THREE.MeshBasicMaterial).opacity = 0.3 * Math.max(0.3, 1 - lift * 0.3);
    },
  };
}

function mergeNets(nets: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Fileler aynı malzeme: tek mesh
  const g = new THREE.BufferGeometry();
  const pos: number[] = [], uv: number[] = [];
  for (const n of nets) {
    const ni = n.index ? n.toNonIndexed() : n;
    pos.push(...(ni.attributes.position.array as Float32Array));
    uv.push(...(ni.attributes.uv.array as Float32Array));
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
