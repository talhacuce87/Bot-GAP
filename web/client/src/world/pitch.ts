// Futbol sahası: çizgili çim, beyaz çizgiler, kaleler ve fileler, kenar panoları, skor tabelası ve top.
// Top sunucudan gelir (konum + hız, `at` anında); burada ileri tahmin edilip yumuşatılarak çizilir.
import * as THREE from "three";
import type { BallState } from "../../../shared/protocol";
import { BALL_R, PITCH } from "../../../shared/zones";
/** Sunucuyla aynı: top ayaktayken oyuncunun bu kadar önünde. */
const DRIBBLE_AHEAD = 0.62;
import type { Builder } from "./builder";
import { flatMat, mat, part, timeUniform } from "./geo";

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
  /** Skor; maçta kalan süre ("3:12") tabelada da yazar. */
  setScore(score: [number, number], clock?: string | null): void;
  /** Topun tahmini konumu (şut menzili, ses için). */
  ball: THREE.Vector3;
  /**
   * `lights` gece projektörlerin yanma oranı (0–1). `pose`: oyuncunun çizildiği yer ve yönü (top ayaktayken
   * sunucuyu beklemeden ayağın önünde çizilir).
   */
  update(dt: number, serverNow: number, lights?: number, pose?: (sid: number) => { x: number; z: number; rot: number } | null): void;
  /** Kaleciler: [batı x, z, eğilme, doğu x, z, eğilme]. */
  setKeepers(k: number[]): void;
  /** Topun sahibi (sid; kaleciler negatif; 0 serbest). */
  readonly owner: number;
  /** Nişan oku: topun yanında vuruş yönü ve gücü (null gizle). */
  setAim(aim: { ang: number; power: number; kind: "shot" | "pass" | "lob" } | null): void;
  /** Gol: top fileye çarptı, file dalgalanır. */
  netHit(x: number, y: number, z: number, time: number): void;
}

/** Kaleci: alçak poli gövde; batı yeşil, doğu turuncu forma, beyaz eldiven. Bacaklar yürürken sallanır. */
function keeperMesh(kit: string): { root: THREE.Group; body: THREE.Group; legs: THREE.Mesh[] } {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const m = (c: string) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
  const box = (w: number, h: number, d: number, c: string, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m(c));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const legs = [-0.12, 0.12].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.72, 0);
    body.add(pivot);
    box(0.17, 0.7, 0.2, "#1d1f26", 0, -0.35, 0, pivot);
    box(0.19, 0.1, 0.28, "#f2f2f2", 0, -0.68, 0.04, pivot);
    return pivot as unknown as THREE.Mesh;
  });
  box(0.48, 0.62, 0.3, kit, 0, 1.03, 0);
  box(0.5, 0.06, 0.32, "#14161c", 0, 0.74, 0);
  for (const x of [-0.33, 0.33]) {
    box(0.13, 0.5, 0.15, kit, x, 1.02, 0.04);
    box(0.17, 0.17, 0.17, "#f7f7f2", x, 0.72, 0.08);
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), m("#e0b48a"));
  head.position.set(0, 1.55, 0);
  body.add(head);
  box(0.42, 0.1, 0.42, kit, 0, 1.72, 0).scale.set(1, 1, 1);
  return { root, body, legs };
}

/** Projektör kuleleri: sahanın dört köşesinin dışında, kafaları ortaya dönük. */
const TOWER_H = 9;
function towers(b: Builder): { x: number; z: number; head: THREE.Vector3 }[] {
  const { x: cx, z: cz, hx, hz } = PITCH;
  const out: { x: number; z: number; head: THREE.Vector3 }[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = cx + sx * (hx + 2.4), z = cz + sz * (hz + 2.6);
      const face = Math.atan2(cx - x, cz - z);
      b.add(part(new THREE.CylinderGeometry(0.12, 0.2, TOWER_H, 6), "#59606e", mat(x, TOWER_H / 2, z)));
      // Kafa: lamba ızgarası, ortaya ve hafif aşağı bakar
      const head = mat(x, TOWER_H + 0.4, z, face).multiply(new THREE.Matrix4().makeRotationX(0.45));
      b.add(part(new THREE.BoxGeometry(1.9, 1.1, 0.25), "#2f3440", head));
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 2; j++) {
          const m = head.clone().multiply(new THREE.Matrix4().makeTranslation(-0.6 + i * 0.6, -0.25 + j * 0.5, 0.14)).multiply(new THREE.Matrix4().makeScale(0.9, 0.9, 0.45));
          b.prop("bulb", m);
        }
      }
      b.colliders.circle(x, z, 0.22);
      out.push({ x, z, head: new THREE.Vector3(x, TOWER_H + 0.4, z) });
    }
  }
  return out;
}

/** Projektör ışık konisi: kuleden sahanın içine, uca doğru solan toplamalı koni. */
function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vH;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vH = uv.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vH;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        // Kenara bakan yüzeyler soluk: hacimli ışık görüntüsü
        float edge = pow(abs(dot(vN, vV)), 1.5);
        float a = edge * pow(vH, 1.4) * uOpacity;
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.88) * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
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
  b.add(part(new THREE.RingGeometry(3.6, 3.6 + LINE_W, 48), LINE, flatMat(cx, 0.034, cz)));
  b.add(part(new THREE.CircleGeometry(0.15, 12), LINE, flatMat(cx, 0.035, cz)));
  for (const s of [-1, 1]) {
    // Ceza sahası (5 m derin, 14 m geniş), kale alanı (2 m, 8 m), penaltı noktası
    const box = (depth: number, half: number) => {
      line(b, cx + s * (hx - depth), cz, LINE_W, half * 2);
      line(b, cx + s * (hx - depth / 2), cz - half, depth, LINE_W);
      line(b, cx + s * (hx - depth / 2), cz + half, depth, LINE_W);
    };
    box(5, 7);
    box(2, 4);
    b.add(part(new THREE.CircleGeometry(0.12, 10), LINE, flatMat(cx + s * (hx - 3.6), 0.035, cz)));
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
  const lampTowers = towers(b);

  // Uzun kenarlarda alçak reklam panoları (ortada giriş boşluğu)
  const boards = ["#2f6fd0", "#e04a3a", "#f2c230", "#3a9a5a"];
  for (const sz of [-1, 1]) {
    for (let i = 0; i < Math.floor((hx * 2) / 2.6); i++) {
      const x = cx - hx + 1.3 + i * 2.6;
      if (Math.abs(x - cx) < 2) continue;
      b.add(part(new THREE.BoxGeometry(2.4, 0.55, 0.12), boards[i % 4], mat(x, 0.28, cz + sz * (hz + 0.9)), 0.05, b.rand));
      b.colliders.segment(x - 1.2, cz + sz * (hz + 0.9), x + 1.2, cz + sz * (hz + 0.9), 0.1);
    }
  }
  // Seyirci bankları: kuzey kenarında
  for (let i = 0; i < 5; i++) {
    const x = cx - 16 + i * 8, z = cz - hz - 2.2;
    b.add(part(new THREE.BoxGeometry(3, 0.1, 0.45), "#a0703f", mat(x, 0.45, z)));
    for (const lx of [-1.3, 1.3]) b.add(part(new THREE.BoxGeometry(0.08, 0.45, 0.4), "#5b3f25", mat(x + lx, 0.22, z)));
    b.colliders.segment(x - 1.5, z, x + 1.5, z, 0.3);
    for (const o of [-0.9, 0, 0.9]) b.seats.push({ x: x + o, z, rot: 0 });
  }

  const group = new THREE.Group();
  // File: gol olunca çarpma noktasından dışa doğru dalgalanır (vertex shader)
  const netHit = { value: new THREE.Vector4(0, 0, 0, -100) };
  const netMat = new THREE.MeshBasicMaterial({ map: netTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.8 });
  netMat.onBeforeCompile = (shader) => {
    shader.uniforms.uNetHit = netHit;
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform vec4 uNetHit;\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          float age = uTime - uNetHit.w;
          float d = distance(transformed, uNetHit.xyz);
          float k = exp(-d * 1.4) * exp(-age * 2.2) * (age > 0.0 ? 1.0 : 0.0);
          transformed.x += sign(transformed.x - ${cx.toFixed(2)}) * k * (0.55 + 0.25 * sin(age * 16.0));
          transformed.y -= k * 0.08;
        }`,
      );
  };
  netMat.customProgramCacheKey = () => "goal-net";
  const netMesh = new THREE.Mesh(subdivideNets(mergeNets(nets)), netMat);
  netMesh.matrixAutoUpdate = false;
  group.add(netMesh);

  // Skor tabelası: güney kenarında direkli pano
  const sc = document.createElement("canvas");
  sc.width = 256;
  sc.height = 96;
  const scoreTex = new THREE.CanvasTexture(sc);
  scoreTex.colorSpace = THREE.SRGBColorSpace;
  let lastBoard = "";
  const drawScore = (s: [number, number], clock: string | null = null) => {
    const key = `${s[0]}-${s[1]}-${clock}`;
    if (key === lastBoard) return;
    lastBoard = key;
    const g = sc.getContext("2d")!;
    g.fillStyle = "#14171c";
    g.fillRect(0, 0, 256, 96);
    g.textAlign = "center";
    if (clock) {
      // Maç: takım renkleri ve süre
      g.fillStyle = "#e04a3a";
      g.fillRect(8, 40, 10, 46);
      g.fillStyle = "#2f6fd0";
      g.fillRect(238, 40, 10, 46);
      g.fillStyle = "#f2c230";
      g.font = "700 22px ui-monospace, monospace";
      g.fillText(`⏱ ${clock}`, 128, 26);
    } else {
      g.fillStyle = "#f2c230";
      g.font = "700 22px system-ui, sans-serif";
      g.fillText("GAP FUTBOL", 128, 26);
    }
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
  // Gece projektör altında: top hafifçe kendi ışığıyla seçilir
  const ballMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const ballMesh = new THREE.Mesh(ballGeo, ballMat);
  ballMesh.castShadow = true;
  group.add(ballMesh);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(BALL_R * 1.1, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.3, depthWrite: false }));
  group.add(shadow);

  // Projektör konileri ve sahaya düşen ışık
  const beamMat = beamMaterial();
  const beamGeo = new THREE.CylinderGeometry(0.5, 7, 1, 20, 1, true).translate(0, -0.5, 0);
  // uv.y: kulede 1, yerde 0 (koni kuleye doğru parlak)
  const down = new THREE.Vector3(0, -1, 0);
  for (const t of lampTowers) {
    const target = new THREE.Vector3(cx + (t.x - cx) * 0.25, 0, cz + (t.z - cz) * 0.25);
    const dir = target.clone().sub(t.head);
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.copy(t.head);
    beam.quaternion.setFromUnitVectors(down, dir.clone().normalize());
    beam.scale.set(1, dir.length(), 1);
    beam.renderOrder = 3;
    group.add(beam);
  }
  const poolMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec2 q = abs(vUv - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.75, 1.0, q.x)) * (1.0 - smoothstep(0.7, 1.0, q.y)) * uOpacity;
        gl_FragColor = vec4(vec3(0.75, 1.0, 0.65) * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2 + 4, hz * 2 + 4).rotateX(-Math.PI / 2), poolMat);
  pool.position.set(cx, 0.045, cz);
  pool.renderOrder = 2;
  group.add(pool);

  // Nişan oku: topun altında, vuruş yönünde; güç arttıkça uzar
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(-0.12, 0);
  arrowShape.lineTo(0.12, 0);
  arrowShape.lineTo(0.12, 0.7);
  arrowShape.lineTo(0.3, 0.7);
  arrowShape.lineTo(0, 1);
  arrowShape.lineTo(-0.3, 0.7);
  arrowShape.lineTo(-0.12, 0.7);
  arrowShape.closePath();
  const arrowMat = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.75, depthWrite: false });
  // Şekil +y'ye bakar; yatırınca +z'ye (açı 0 = +z, sunucudaki vuruş yönüyle aynı)
  const arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape).rotateX(Math.PI / 2), arrowMat);
  arrowMat.side = THREE.DoubleSide;
  arrow.visible = false;
  arrow.renderOrder = 3;
  group.add(arrow);
  const AIM_COLORS = { shot: new THREE.Color("#ffd23f"), pass: new THREE.Color("#7dff9a"), lob: new THREE.Color("#7fc8ff") };

  // Hız izi: hızlı topun arkasında solan küçük toplar
  const TRAIL = 14;
  const trailMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(BALL_R * 0.8, 8, 6), new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }), TRAIL);
  trailMesh.frustumCulled = false;
  trailMesh.count = 0;
  group.add(trailMesh);
  const trail: THREE.Vector3[] = Array.from({ length: TRAIL }, () => new THREE.Vector3(cx, BALL_R, cz));
  let trailHead = 0;
  const tm = new THREE.Matrix4();

  // Kaleciler (sunucu konumlarına yumuşak geçiş, topa bakar, plonjonda yatar)
  const keepers = [keeperMesh("#2fa35a"), keeperMesh("#f08a24")].map((k, i) => {
    group.add(k.root);
    const side = i === 0 ? -1 : 1;
    k.root.position.set(cx + side * (hx - 0.6), 0, cz);
    return { ...k, side, target: new THREE.Vector3(cx + side * (hx - 0.6), 0, cz), lean: 0, walk: 0 };
  });

  let state: BallState = { x: cx, y: 0, z: cz, vx: 0, vy: 0, vz: 0, at: 0 };
  const shown = new THREE.Vector3(cx, BALL_R, cz);
  const predicted = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const q = new THREE.Quaternion();

  /** Sunucudaki fiziğin kaba kopyası: son durumdan `t` sn sonrası (sürtünme, yerçekimi, falso). */
  const predict = (t: number, out: THREE.Vector3) => {
    const s = state;
    const damp = 0.6;
    const k = (1 - Math.exp(-damp * t)) / damp;
    let y = s.y + s.vy * t - 4.9 * t * t;
    if (y < 0) y = 0;
    const air = s.y > 0.01 || s.vy > 0.5;
    let vx = s.vx, vz = s.vz;
    // Falso: hız vektörünü yolun yarısındaki açıyla döndür (yaklaşık kavis)
    if (s.spin) {
      const a = (-s.spin * t) / 2, c = Math.cos(a), sn = Math.sin(a);
      [vx, vz] = [vx * c + vz * sn, vz * c - vx * sn];
    }
    out.set(s.x + vx * (air ? t : k), y + BALL_R, s.z + vz * (air ? t : k));
    out.x = Math.max(cx - hx - 1.6, Math.min(cx + hx + 1.6, out.x));
    out.z = Math.max(cz - hz - 0.75, Math.min(cz + hz + 0.75, out.z));
    return out;
  };

  return {
    group,
    ball: shown,
    setBall(bs) {
      state = bs;
    },
    get owner() {
      return state.owner ?? 0;
    },
    setKeepers(k) {
      keepers.forEach((kp, i) => {
        kp.target.set(k[i * 3], 0, k[i * 3 + 1]);
        kp.lean = k[i * 3 + 2];
      });
    },
    setScore: drawScore,
    setAim(aim) {
      arrow.visible = !!aim;
      if (!aim) return;
      arrow.position.set(shown.x, 0.06, shown.z);
      arrow.rotation.y = aim.ang;
      const len = 1.2 + aim.power * 2.8;
      arrow.scale.set(1 + aim.power * 0.4, 1, len);
      arrowMat.color.copy(AIM_COLORS[aim.kind]);
      arrowMat.opacity = 0.45 + aim.power * 0.4;
    },
    netHit(x, y, z, time) {
      netHit.value.set(x, y, z, time);
    },
    update(dt, serverNow, lights = 0, pose) {
      beamMat.uniforms.uOpacity.value = lights * 0.1;
      poolMat.uniforms.uOpacity.value = lights * 0.085;
      ballMat.emissive.setScalar(lights * 0.35);
      pool.visible = lights > 0.02;
      // Kaleciler
      for (const k of keepers) {
        const r = k.root;
        const d = r.position.distanceTo(k.target);
        if (d > 4) r.position.copy(k.target);
        else r.position.lerp(k.target, 1 - Math.exp(-dt * 12));
        r.rotation.y = Math.atan2(shown.x - r.position.x, shown.z - r.position.z);
        k.walk += d * 6;
        const swing = Math.sin(k.walk) * Math.min(0.6, d * 3);
        k.legs[0].rotation.x = swing;
        k.legs[1].rotation.x = -swing;
        // Plonjon: yana yatar ve hafif havalanır
        k.body.rotation.z += (-k.lean * 1.25 - k.body.rotation.z) * (1 - Math.exp(-dt * 14));
        k.body.position.y = Math.abs(k.body.rotation.z) * 0.35;
      }
      const owner = state.owner ?? 0;
      const prevX = shown.x, prevZ = shown.z;
      const p = owner > 0 && pose ? pose(owner) : null;
      if (p) {
        // Top ayakta: oyuncunun çizildiği yerin önünde (gecikmesiz)
        predicted.set(p.x + Math.sin(p.rot) * DRIBBLE_AHEAD, BALL_R, p.z + Math.cos(p.rot) * DRIBBLE_AHEAD);
        if (shown.distanceTo(predicted) > 3) shown.copy(predicted);
        else shown.lerp(predicted, 1 - Math.exp(-dt * 30));
      } else if (owner < 0) {
        // Kalecinin elinde
        const k = keepers[owner === -1 ? 0 : 1];
        predicted.set(k.root.position.x - k.side * 0.35, 1.0, k.root.position.z);
        shown.lerp(predicted, 1 - Math.exp(-dt * 20));
      } else {
        const t = Math.min(0.5, Math.max(0, (serverNow - state.at) / 1000));
        predict(t, predicted);
        // Büyük sıçramada (gol sonrası ortaya dönüş) doğrudan, yoksa yumuşak
        if (shown.distanceTo(predicted) > 3) shown.copy(predicted);
        else shown.lerp(predicted, 1 - Math.exp(-dt * 18));
      }
      ballMesh.position.copy(shown);
      // Yuvarlanma: gidilen yol kadar dönüş
      const dx = shown.x - prevX, dz = shown.z - prevZ, dist = Math.hypot(dx, dz);
      if (dist > 1e-4) {
        axis.set(dz, 0, -dx).normalize();
        q.setFromAxisAngle(axis, dist / BALL_R);
        ballMesh.quaternion.premultiply(q);
      }
      // İz: hızlıyken görünür, yavaşlayınca söner
      trail[trailHead++ % TRAIL].copy(shown);
      const speed = dist / Math.max(dt, 1e-3);
      const show = Math.min(1, Math.max(0, (speed - 7) / 8));
      trailMesh.count = show > 0.02 ? TRAIL : 0;
      (trailMesh.material as THREE.MeshBasicMaterial).opacity = 0.3 * show;
      if (show > 0.02) {
        for (let i = 0; i < TRAIL; i++) {
          const p = trail[(trailHead - 1 - i + TRAIL * 2) % TRAIL];
          const sc = 1 - i / TRAIL;
          tm.makeScale(sc, sc, sc).setPosition(p);
          trailMesh.setMatrixAt(i, tm);
        }
        trailMesh.instanceMatrix.needsUpdate = true;
      }
      shadow.position.set(shown.x, 0.04, shown.z);
      const lift = shown.y - BALL_R;
      shadow.scale.setScalar(Math.max(0.4, 1 - lift * 0.3));
      (shadow.material as THREE.MeshBasicMaterial).opacity = 0.3 * Math.max(0.3, 1 - lift * 0.3);
    },
  };
}

/** File dalgalansın diye yüzeyler küçük üçgenlere bölünür (her kenar 4 parçaya). */
function subdivideNets(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.attributes.position.array as Float32Array, uv = g.attributes.uv.array as Float32Array;
  const P: number[] = [], U: number[] = [];
  const N = 4;
  for (let t = 0; t < pos.length / 9; t++) {
    const p = (i: number) => new THREE.Vector3(pos[t * 9 + i * 3], pos[t * 9 + i * 3 + 1], pos[t * 9 + i * 3 + 2]);
    const u = (i: number) => new THREE.Vector2(uv[t * 6 + i * 2], uv[t * 6 + i * 2 + 1]);
    const [a, b, c] = [p(0), p(1), p(2)], [ua, ub, uc] = [u(0), u(1), u(2)];
    const at = (i: number, j: number) => {
      const wa = 1 - (i + j) / N, wb = i / N, wc = j / N;
      return {
        v: a.clone().multiplyScalar(wa).addScaledVector(b, wb).addScaledVector(c, wc),
        t: ua.clone().multiplyScalar(wa).addScaledVector(ub, wb).addScaledVector(uc, wc),
      };
    };
    const push = (...q: { v: THREE.Vector3; t: THREE.Vector2 }[]) => q.forEach((k) => (P.push(k.v.x, k.v.y, k.v.z), U.push(k.t.x, k.t.y)));
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N - i; j++) {
        push(at(i, j), at(i + 1, j), at(i, j + 1));
        if (i + j < N - 1) push(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
  return out;
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
