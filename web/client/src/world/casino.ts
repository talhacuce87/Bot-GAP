// Casino: beyaz mermer gövde, altın varak detaylar, LED şeritler ve neon tabelalar. Zemin kat çift
// yükseklikte oyun salonu (rulet, blackjack, slot makineleri, kasa); kuzey şeridinde dolu bir kaidenin
// üstünde VIP katı (bakara masası, lounge, bar). Kaidenin altına girilmez: çarpışmalar "üstüne çıkılır"
// engellerle kurulur, iki yan duvardaki merdivenlerle kata çıkılır.
//
// Salon gibi: içerideyken çatı gizlenir, kameranın tarafındaki duvar yarı saydam olur. Parlayan parçalar
// (LED, ekran, ampul) ışıktan etkilenmeyen ayrı mesh'lerde: gece bloom'la parlarlar.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CASINO, CASINO_MEZZ_Z } from "../../../shared/zones";
import type { Builder, Seat } from "./builder";
import type { CityNpc } from "./city";
import { mat, part } from "./geo";

const { x: CX, z: CZ, hw: HW, hd: HD, h: H, floor2: F2, door: DOOR } = CASINO;
const X0 = CX - HW, X1 = CX + HW;
/** Kuzey (arka) ve güney (giriş) cepheleri. */
const Z0 = CZ - HD, Z1 = CZ + HD;
const MZ = CASINO_MEZZ_Z;
/** Duvar kalınlığı ve iç yüzeyin cepheden uzaklığı. */
const T = 0.5;
const IN = T / 2;
/** İçeriden bakınca kalan duvar kuşağı (salonla aynı). */
const LOW = 1.3;
const DOOR_H = 4.2;
const CANOPY_Y = 4.8;

// Merdivenler: her basamak STEP_UP'tan alçak, böylece yürüyerek çıkılır
const STEPS = 26;
const RISE = F2 / STEPS;
const TREAD = 0.5;
const STAIR_W = 3;
/** Merdivenin dibi (güney ucu); kuzeye doğru yükselir, VIP katının ön kenarında biter. */
const STAIR_Z = MZ + STEPS * TREAD;

const MARBLE = ["#f6f4f0", "#efece6", "#f9f8f5"];
const MARBLE_WARM = "#ebe5da";
const VEINS = ["#d6cfc2", "#cdc5b6", "#ddd7cc"];
const GOLD = "#d6aa3c";
const GOLD_LIGHT = "#f0cf6a";
const GOLD_DARK = "#a77d22";
const GLASS = "#3a4f66";
const ONYX = "#1d1e23";
const CARPET = "#9c1a2c";
const VIP_CARPET = "#5a1426";
const FELT = "#17603f";
const LEATHER = "#fbf8f1";

/** Parlayanlar: sıcak beyaz LED, altın, neon. */
const LED = "#fff1cf";
const LED_GOLD = "#ffd36b";
const NEON = ["#ff4fd8", "#7ef9ff", "#b07cff", "#ffd36b", "#5dff9e", "#ff6b6b"];

/**
 * Parça grupları: 0–3 üst duvarlar (kuzey, güney, batı, doğu), 4 çatı, 5 sabit (her zaman görünür),
 * 6 iç mekân (gölge almaz: 12 m'lik duvarların gölgesi salonu karartmasın, içerisi hep aydınlık).
 */
const ROOF = 4;
const STATIC = 5;
const INTERIOR = 6;

export interface Casino {
  group: THREE.Group;
  /** Krupiyeler (masaların arkasında). */
  npcs: CityNpc[];
  inside(x: number, z: number): boolean;
  /** Kare başına: çatı/duvar solması, kayan ampuller, dönen hale, avize ve gece ışıkları. */
  update(time: number, dt: number, focus: { x: number; z: number } | undefined, camera: THREE.Vector3 | undefined, night: number): void;
}

const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _one = new THREE.Vector3(1, 1, 1);

/**
 * Gece projektörü: yüzey kendi rengiyle orantılı parlar (beyaz mermer beyaz, altın altın, cam koyu kalır).
 * `flood` gece artar; gündüz 0.
 */
export function floodMaterial(flood: { value: number }, params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, ...params });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFlood = flood;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uFlood;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * uFlood;");
  };
  m.customProgramCacheKey = () => "casino-flood";
  return m;
}

/** `m`'den sonra yerel öteleme ve dönüş (`m · T(x,y,z) · R`). */
function local(m: THREE.Matrix4, x: number, y: number, z: number, r?: THREE.Matrix4): THREE.Matrix4 {
  const out = m.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z));
  return r ? out.multiply(r) : out;
}

/** Yazı dokusu: altın varak harfler (ya da verilen renk), isteğe bağlı koyu zemin. */
function textPlane(text: string, w: number, h: number, opts: { color?: string; bg?: string; sub?: string } = {}): THREE.Mesh {
  const cw = 1024, ch = Math.max(64, Math.round((cw * h) / w));
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const g = c.getContext("2d")!;
  if (opts.bg) {
    g.fillStyle = opts.bg;
    g.fillRect(0, 0, cw, ch);
  }
  const main = opts.sub ? ch * 0.62 : ch * 0.55;
  let size = Math.round(ch * (opts.sub ? 0.58 : 0.72));
  g.font = `900 ${size}px system-ui, sans-serif`;
  while (size > 16 && g.measureText(text).width > cw * 0.9) g.font = `900 ${--size}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (opts.color) g.fillStyle = opts.color;
  else {
    const grad = g.createLinearGradient(0, main - size / 2, 0, main + size / 2);
    grad.addColorStop(0, "#fff6cf");
    grad.addColorStop(0.45, "#f3c95c");
    grad.addColorStop(0.55, "#b9882c");
    grad.addColorStop(1, "#ffe08a");
    g.fillStyle = grad;
  }
  g.shadowColor = opts.color ?? "#ffcf5a";
  g.shadowBlur = size * 0.25;
  g.fillText(text, cw / 2, main);
  g.shadowBlur = 0;
  g.fillText(text, cw / 2, main);
  if (opts.sub) {
    g.font = `700 ${Math.round(ch * 0.17)}px system-ui, sans-serif`;
    g.fillStyle = "#f6e3a6";
    g.fillText(opts.sub, cw / 2, ch * 0.88);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.renderOrder = 2;
  return m;
}

export function casino(b: Builder, lamps: number): Casino {
  const group = new THREE.Group();
  const solids: THREE.BufferGeometry[][] = [[], [], [], [], [], [], []];
  const glows: THREE.BufferGeometry[][] = [[], [], [], [], [], []];
  const chase: THREE.BufferGeometry[][] = [[], []];
  /** Gruba göre solan ek malzemeler (yazılar). */
  const fades: THREE.Material[][] = [[], [], [], [], []];
  let g = STATIC;

  const solid = (geo: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter = 0.03) => {
    solids[g].push(part(geo, color, m, jitter, b.rand));
  };
  const glow = (geo: THREE.BufferGeometry, color: string, m: THREE.Matrix4) => glows[g === INTERIOR ? STATIC : g].push(part(geo, color, m));
  const box = (w: number, h: number, d: number, color: string, x: number, y: number, z: number, ry = 0, jitter = 0.03) =>
    solid(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry), jitter);
  const gbox = (w: number, h: number, d: number, color: string, x: number, y: number, z: number, ry = 0) =>
    glow(new THREE.BoxGeometry(w, h, d), color, mat(x, y, z, ry));
  const cyl = (r0: number, r1: number, h: number, color: string, x: number, y: number, z: number, seg = 16) =>
    solid(new THREE.CylinderGeometry(r0, r1, h, seg), color, mat(x, y, z), 0.02);
  const gcyl = (r0: number, r1: number, h: number, color: string, x: number, y: number, z: number, seg = 16) =>
    glow(new THREE.CylinderGeometry(r0, r1, h, seg), color, mat(x, y, z));
  /** Yatay halka (altın kuşak ya da LED). */
  const ring = (r: number, tube: number, color: string, x: number, y: number, z: number, lit = false) => {
    const geo = new THREE.TorusGeometry(r, tube, 6, Math.max(16, Math.round(r * 14))).rotateX(Math.PI / 2);
    if (lit) glow(geo, color, mat(x, y, z));
    else solid(geo, color, mat(x, y, z), 0);
  };
  /** İki nokta arasında çubuk (zincir, korkuluk). */
  const rod = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, color: string, lit = false) => {
    const a = new THREE.Vector3(ax, ay, az), d = new THREE.Vector3(bx - ax, by - ay, bz - az);
    const len = d.length();
    _q.setFromUnitVectors(_up, d.normalize());
    const m = new THREE.Matrix4().compose(a.addScaledVector(d, len / 2), _q, _one);
    if (lit) glow(new THREE.CylinderGeometry(r, r, len, 6), color, m);
    else solid(new THREE.CylinderGeometry(r, r, len, 6), color, m, 0);
  };
  const marble = () => MARBLE[Math.floor(b.rand() * MARBLE.length)];
  const addText = (mesh: THREE.Mesh, x: number, y: number, z: number, ry: number, fadeGroup: number) => {
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    group.add(mesh);
    if (fadeGroup < STATIC) fades[fadeGroup].push(mesh.material as THREE.Material);
  };

  b.clearBox(X0 - 3, X1 + 3, Z0 - 3, Z1 + 15);

  // ------------------------------------------------------------------
  // Dış duvarlar: mermer paneller, altın kanatlar (içinde LED), iki sıra pencere, kat kuşağı, korniş
  // ------------------------------------------------------------------
  /** `side` grubu; (cx, cz) duvarın ortası, `ry` dışa bakan yön (yerel x duvar boyunca, yerel z dışarı). */
  const wall = (side: number, wx: number, wz: number, len: number, ry: number, door: boolean, innerSkip: (x: number, z: number) => boolean) => {
    const ax = Math.cos(ry), az = -Math.sin(ry), nx = Math.sin(ry), nz = Math.cos(ry);
    const P = (o: number, d: number): [number, number] => [wx + ax * o + nx * d, wz + az * o + nz * d];
    const piece = (w: number, h: number, d: number, color: string, o: number, y: number, dd = 0, jitter = 0.03) => {
      const [x, z] = P(o, dd);
      box(w, h, d, color, x, y, z, ry, jitter);
    };
    const gpiece = (w: number, h: number, d: number, color: string, o: number, y: number, dd = 0) => {
      const [x, z] = P(o, dd);
      gbox(w, h, d, color, x, y, z, ry);
    };
    const spans: [number, number][] = door ? [[-len / 2, -DOOR], [DOOR, len / 2]] : [[-len / 2, len / 2]];
    for (const [s0, s1] of spans) {
      const w = s1 - s0, mid = (s0 + s1) / 2;
      g = STATIC;
      piece(w, LOW, T, MARBLE_WARM, mid, LOW / 2);
      piece(w, 0.14, T + 0.1, GOLD, mid, 0.07, 0, 0);
      piece(w, 0.08, T + 0.06, GOLD, mid, LOW - 0.04, 0, 0);
      g = side;
      piece(w, H - LOW, T, marble(), mid, LOW + (H - LOW) / 2);
      const [ax0, az0] = P(s0, 0), [ax1, az1] = P(s1, 0);
      b.colliders.segment(ax0, az0, ax1, az1, T / 2);
    }
    g = side;
    if (door) piece(DOOR * 2, H - DOOR_H, T, marble(), 0, DOOR_H + (H - DOOR_H) / 2);

    const nb = Math.round(len / 4.25), bw = len / nb;
    // Kanatlar: dışta altın, ortasında LED şerit; içte ince altın pilastr
    for (let k = 1; k < nb; k++) {
      const o = -len / 2 + k * bw;
      const y0 = door && Math.abs(o) < 7.6 ? CANOPY_Y + 0.3 : LOW;
      g = side;
      piece(0.38, H - y0, 0.3, GOLD, o, y0 + (H - y0) / 2, T / 2 + 0.15, 0.02);
      gpiece(0.08, H - y0 - 0.7, 0.04, LED, o, y0 + (H - y0) / 2, T / 2 + 0.31);
      if (!innerSkip(...P(o, 0))) {
        piece(0.3, H - LOW - 0.6, 0.2, GOLD, o, LOW + (H - LOW - 0.6) / 2, -(T / 2 + 0.1), 0.02);
        gpiece(0.05, H - LOW - 1.2, 0.03, LED_GOLD, o, LOW + (H - LOW - 0.6) / 2, -(T / 2 + 0.21));
      }
      // Cephe dibinde yukarı vuran ışık
      g = STATIC;
      gpiece(0.55, 0.06, 0.3, LED, o, 0.03, T / 2 + 0.5);
    }
    // Pencereler: altın çerçeveli koyu cam; zemin kat ve üst kat
    g = side;
    const windowAt = (oc: number, cy: number, wh: number, split: boolean) => {
      const ww = bw - 1.1;
      piece(ww, wh, T + 0.08, GLASS, oc, cy, 0, 0.02);
      for (const s of [-1, 1]) {
        piece(ww + 0.2, 0.12, T + 0.18, GOLD, oc, cy + s * (wh / 2 + 0.06), 0, 0);
        piece(0.12, wh, T + 0.18, GOLD, oc + s * (ww / 2 + 0.06), cy, 0, 0);
      }
      piece(0.07, wh, T + 0.14, GOLD_LIGHT, oc, cy, 0, 0);
      if (split) piece(ww, 0.07, T + 0.14, GOLD_LIGHT, oc, cy + wh / 2 - wh / 3, 0, 0);
    };
    for (let j = 0; j < nb; j++) {
      const oc = -len / 2 + (j + 0.5) * bw;
      if (!(door && Math.abs(oc) < DOOR + 1.3)) windowAt(oc, 3.15, 2.3, false);
      if (!(door && Math.abs(oc) < 7.9)) windowAt(oc, 8.3, 5.4, true);
    }
    // Kat kuşağı (altın) ve altında LED; tepede taşan mermer korniş, altın şerit ve LED
    piece(len, 0.3, T + 0.24, GOLD, 0, 5.0, 0, 0);
    gpiece(len, 0.05, T + 0.26, LED, 0, 4.82);
    piece(len + 1.2, 0.7, T + 1.0, marble(), 0, H + 0.35);
    piece(len + 0.4, 0.22, T + 0.4, GOLD, 0, H - 0.22, 0, 0);
    gpiece(len + 1.2, 0.06, 0.06, LED_GOLD, 0, H + 0.02, T / 2 + 0.47);
    gpiece(len - 1.5, 0.06, 0.06, LED, 0, H - 0.6, -(T / 2 + 0.08));
    // Mermer damarları: dış yüzde ince, eğik, hafif gri çizgiler
    for (let k = 0; k < nb * 4; k++) {
      const o = -len / 2 + 0.4 + b.rand() * (len - 0.8), y = LOW + 0.3 + b.rand() * (H - LOW - 0.9);
      if (door && Math.abs(o) < DOOR + 0.3 && y < DOOR_H + 0.2) continue;
      const [x, z] = P(o, T / 2 + 0.012);
      const m = mat(x, y, z, ry).multiply(new THREE.Matrix4().makeRotationZ((b.rand() - 0.5) * 1.4));
      solid(new THREE.BoxGeometry(0.6 + b.rand() * 1.8, 0.035, 0.02), VEINS[k % VEINS.length], m, 0);
    }
  };
  // İç pilastrlar: VIP duvarında (tabela ve bar rafları) ve merdivenlerin boyunca yok
  const besideStairs = (_x: number, z: number) => z > MZ - 0.6 && z < STAIR_Z + 0.6;
  wall(0, CX, Z0, HW * 2, Math.PI, false, () => true);
  wall(1, CX, Z1, HW * 2, 0, true, () => false);
  wall(2, X0, CZ, HD * 2, -Math.PI / 2, false, besideStairs);
  wall(3, X1, CZ, HD * 2, Math.PI / 2, false, besideStairs);

  // Köşe kuleleri: mermer silindir, altın kuşaklar, dikey LED'ler; tepesi düz cam bant ve altın kapak
  for (const [tx, tz] of [[X0, Z0], [X1, Z0], [X0, Z1], [X1, Z1]]) {
    g = tz === Z0 ? 0 : 1;
    const th = H + 1.6;
    cyl(1.8, 1.8, H, MARBLE[0], tx, H / 2, tz, 28);
    cyl(1.74, 1.74, th - H, GLASS, tx, H + (th - H) / 2, tz, 28);
    for (const y of [0.1, LOW, 5.0, H]) cyl(1.87, 1.87, y < 1 ? 0.2 : 0.24, GOLD, tx, y, tz, 28);
    cyl(1.95, 1.95, 0.22, GOLD, tx, th + 0.11, tz, 28);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      gbox(0.06, H - 1.6, 0.06, LED, tx + Math.cos(a) * 1.81, LOW + (H - 1.6) / 2 + 0.1, tz + Math.sin(a) * 1.81);
      gbox(0.05, th - H - 0.2, 0.05, LED_GOLD, tx + Math.cos(a) * 1.76, H + (th - H) / 2, tz + Math.sin(a) * 1.76);
    }
    ring(1.96, 0.04, LED_GOLD, tx, th + 0.23, tz, true);
    b.colliders.circle(tx, tz, 1.85);
  }

  // ------------------------------------------------------------------
  // Çatı: kademeli taç (cam kat ve LED çizgili mermer kat), önde yelpaze gibi açılan altın kanatlar,
  // en üstte ışıklı GAP tabelası ve gökyüzünü tarayan projektörler (içerideyken gizlenir)
  // ------------------------------------------------------------------
  g = ROOF;
  box(HW * 2 + 0.6, 0.5, HD * 2 + 0.6, marble(), CX, H + 0.25, CZ);
  const t1 = H + 0.5, t1h = 3.2;
  box(24, t1h, 14, GLASS, CX, t1 + t1h / 2, CZ, 0, 0.02);
  for (let k = 0; k <= 12; k++) box(0.14, t1h, 14.1, GOLD_LIGHT, CX - 12 + k * 2, t1 + t1h / 2, CZ, 0, 0);
  for (const s2 of [-1, 1]) {
    box(24.2, t1h, 0.14, GOLD_LIGHT, CX, t1 + t1h / 2, CZ + s2 * 7, 0, 0);
    for (const sx of [-1, 1]) box(0.7, t1h + 0.1, 0.7, MARBLE[0], CX + sx * 12, t1 + t1h / 2, CZ + s2 * 7, 0, 0.02);
  }
  box(24.6, 0.3, 14.6, MARBLE[0], CX, t1 + t1h + 0.15, CZ);
  box(24.7, 0.12, 14.7, GOLD, CX, t1 + t1h + 0.34, CZ, 0, 0);
  gbox(24.8, 0.05, 14.8, LED_GOLD, CX, t1 + t1h + 0.02, CZ);
  const t2 = t1 + t1h + 0.4, t2h = 2.6;
  box(15, t2h, 8, marble(), CX, t2 + t2h / 2, CZ - 1.5);
  for (let k = 0; k < 4; k++) gbox(15.06, 0.06, 8.06, k % 2 ? LED : LED_GOLD, CX, t2 + 0.45 + k * 0.55, CZ - 1.5);
  box(15.3, 0.2, 8.3, GOLD, CX, t2 + t2h + 0.1, CZ - 1.5, 0, 0);
  // Ön kenarda altın kanatlar: ortada yüksek, kenarlara doğru alçalan bıçaklar; kenarlarında LED
  for (let k = -5; k <= 5; k++) {
    const bh = 2.2 + (5 - Math.abs(k)) * 1.05, bx = CX + k * 1.25, bz = CZ + 6.4;
    const by = t1 + t1h + 0.4;
    box(0.22, bh, 1.4, k % 2 ? GOLD : GOLD_LIGHT, bx, by + bh / 2, bz, 0, 0.02);
    gbox(0.06, bh - 0.2, 0.06, LED, bx, by + bh / 2, bz + 0.72);
  }
  // Çatı tabelası: altın çerçeveli koyu pano üstünde GAP (taç katının üstünde, güneye bakar)
  const topY = t2 + t2h + 2.2;
  box(9.4, 3.0, 0.3, ONYX, CX, topY, CZ - 0.5, 0, 0);
  box(9.8, 0.18, 0.4, GOLD, CX, topY + 1.55, CZ - 0.5, 0, 0);
  box(9.8, 0.18, 0.4, GOLD, CX, topY - 1.55, CZ - 0.5, 0, 0);
  for (const sx of [-1, 1]) cyl(0.12, 0.12, 2.2, GOLD_DARK, CX + sx * 3.8, t2 + t2h + 0.6, CZ - 0.5, 8);
  const roofSign = textPlane("GAP", 8.8, 2.8, { sub: "CASINO · RESORT" });
  addText(roofSign, CX, topY, CZ - 0.33, 0, STATIC);
  // Projektörler: taç katının köşelerinde; ışık huzmeleri gece görünür ve yavaşça döner
  const beams: THREE.Group[] = [];
  const beamMat = new THREE.MeshBasicMaterial({ color: "#fff0c4", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const beamGeo = new THREE.CylinderGeometry(0.25, 3.6, 80, 16, 1, true).translate(0, 40, 0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const bx = CX + sx * 11.2, bz = CZ + sz * 6.2;
    cyl(0.45, 0.55, 0.5, GOLD_DARK, bx, t1 + t1h + 0.6, bz, 12);
    glow(new THREE.CylinderGeometry(0.4, 0.4, 0.05, 12), LED, mat(bx, t1 + t1h + 0.88, bz));
    const pivot = new THREE.Group();
    pivot.position.set(bx, t1 + t1h + 0.9, bz);
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.rotation.z = 0.42;
    pivot.add(beam);
    group.add(pivot);
    beams.push(pivot);
  }

  // ------------------------------------------------------------------
  // Giriş: yarım elips saçak, altın sütunlar, kayan ampuller, kapı çerçevesi ve açık cam kanatlar
  // ------------------------------------------------------------------
  g = STATIC;
  const CR = 9, CD = 6.5;
  solid(new THREE.CylinderGeometry(1, 1, 0.42, 48, 1, false, -Math.PI / 2, Math.PI), MARBLE[0], mat(CX, CANOPY_Y, Z1, 0, CR, 1, CD), 0.02);
  solid(new THREE.TorusGeometry(1, 0.03, 6, 48, Math.PI).rotateX(Math.PI / 2), GOLD, mat(CX, CANOPY_Y, Z1, 0, CR + 0.05, 7, CD + 0.05), 0);
  glow(new THREE.TorusGeometry(1, 0.012, 4, 48, Math.PI).rotateX(Math.PI / 2), LED, mat(CX, CANOPY_Y - 0.23, Z1, 0, CR - 0.4, 3, CD - 0.4));
  for (let ix = -7; ix <= 7; ix += 2) {
    for (let iz = 1; iz <= 5.5; iz += 1.5) {
      if ((ix / (CR - 0.7)) ** 2 + (iz / (CD - 0.5)) ** 2 < 1) gcyl(0.17, 0.17, 0.03, LED, CX + ix, CANOPY_Y - 0.225, Z1 + iz, 12);
    }
  }
  for (let k = 1; k < 40; k++) {
    const t = (k / 40) * Math.PI;
    chase[k % 2].push(part(new THREE.IcosahedronGeometry(0.1, 1), LED_GOLD, mat(CX + Math.cos(t) * (CR + 0.12), CANOPY_Y + 0.27, Z1 + Math.sin(t) * (CD + 0.12))));
  }
  for (const s of [-1, 1]) {
    const px = CX + s * 6, pz = Z1 + 4.2;
    box(0.95, 0.4, 0.95, MARBLE[0], px, 0.2, pz);
    box(1.0, 0.08, 1.0, GOLD, px, 0.42, pz, 0, 0);
    cyl(0.32, 0.36, CANOPY_Y - 0.65, GOLD, px, 0.4 + (CANOPY_Y - 0.65) / 2, pz, 20);
    for (const y of [1.4, 2.6, 3.8]) ring(0.37, 0.025, LED_GOLD, px, y, pz, true);
    box(0.8, 0.25, 0.8, GOLD_LIGHT, px, CANOPY_Y - 0.33, pz, 0, 0);
    b.colliders.circle(px, pz, 0.42);
  }
  // Kapı çerçevesi
  for (const s of [-1, 1]) box(0.5, DOOR_H + 0.3, T + 0.6, GOLD, CX + s * (DOOR + 0.25), (DOOR_H + 0.3) / 2, Z1, 0, 0.02);
  box(DOOR * 2 + 1, 0.45, T + 0.6, GOLD, CX, DOOR_H + 0.2, Z1, 0, 0.02);
  gbox(DOOR * 2, 0.08, 0.05, LED, CX, DOOR_H - 0.05, Z1 + IN + 0.32);
  gbox(DOOR * 2, 0.03, 0.4, LED_GOLD, CX, 0.02, Z1);
  b.carColliders.segment(CX - DOOR, Z1, CX + DOOR, Z1, 0.3);
  // İçeri açılmış cam kanatlar (kasanın dibinde)
  for (const s of [-1, 1]) {
    const lx = CX + s * (DOOR - 0.08);
    box(0.06, 3.6, 1.5, "#9fc4d6", lx, 1.85, Z1 - IN - 0.75, 0, 0);
    box(0.1, 3.7, 0.08, GOLD, lx, 1.85, Z1 - IN - 1.5, 0, 0);
    box(0.1, 0.08, 1.5, GOLD, lx, 3.66, Z1 - IN - 0.75, 0, 0);
    box(0.1, 0.08, 1.5, GOLD, lx, 0.06, Z1 - IN - 0.75, 0, 0);
    cyl(0.02, 0.02, 1.2, GOLD_LIGHT, lx - s * 0.08, 1.4, Z1 - IN - 1.2, 6);
  }
  // Tabela: koyu cam pano, altın çerçeve, çevresinde ampuller, ortada altın harfler
  g = 1;
  const signY = 8.0, signZ = Z1 + IN + 0.42;
  box(15, 3.4, 0.25, ONYX, CX, signY, signZ - 0.05, 0, 0);
  for (const s of [-1, 1]) {
    box(15.4, 0.22, 0.4, GOLD, CX, signY + s * 1.8, signZ, 0, 0);
    box(0.22, 3.8, 0.4, GOLD, CX + s * 7.6, signY, signZ, 0, 0);
  }
  for (let k = 0; k <= 30; k++) {
    for (const s of [-1, 1]) gbox(0.12, 0.12, 0.12, k % 2 ? LED : LED_GOLD, CX - 7.5 + k * 0.5, signY + s * 1.8, signZ + 0.22);
  }
  for (let k = 1; k < 7; k++) {
    for (const s of [-1, 1]) gbox(0.12, 0.12, 0.12, k % 2 ? LED : LED_GOLD, CX + s * 7.6, signY - 1.8 + k * 0.5143, signZ + 0.22);
  }
  addText(textPlane("GAP CASINO", 14, 3, { sub: "★  WIN BIG · PLAY GOLD  ★" }), CX, signY, signZ + 0.09, 0, 1);

  // ------------------------------------------------------------------
  // Ön meydan: mermer karo, kırmızı halı ve altın direkler, iki fıskiye, iki dev zar, lambalar
  // ------------------------------------------------------------------
  g = STATIC;
  const PZ0 = Z1, PZ1 = Z1 + 14, PX0 = CX - 14, PX1 = CX + 14;
  for (let ix = 0; ix < 14; ix++) {
    for (let iz = 0; iz < 7; iz++) {
      box(1.98, 0.06, 1.98, (ix + iz) % 2 ? "#e6e1d7" : MARBLE[2], PX0 + 1 + ix * 2, 0.03, PZ0 + 1 + iz * 2, 0, 0.02);
    }
  }
  for (const s of [-1, 1]) {
    box(PX1 - PX0 + 0.2, 0.07, 0.16, GOLD, CX, 0.04, (PZ0 + PZ1) / 2 + s * 7, 0, 0);
    box(0.16, 0.07, PZ1 - PZ0, GOLD, CX + s * 14, 0.04, (PZ0 + PZ1) / 2, 0, 0);
  }
  const carpet = (z0: number, z1: number) => {
    box(2.4, 0.02, z1 - z0, CARPET, CX, 0.075, (z0 + z1) / 2, 0, 0.02);
    for (const s of [-1, 1]) box(0.08, 0.025, z1 - z0, GOLD, CX + s * 1.24, 0.077, (z0 + z1) / 2, 0, 0);
  };
  carpet(Z1 - IN, PZ1);
  for (let z = Z1 + 1.6; z < PZ1 - 0.5; z += 2.2) {
    for (const s of [-1, 1]) {
      const sx = CX + s * 1.75;
      cyl(0.05, 0.05, 0.95, GOLD, sx, 0.475, z, 8);
      cyl(0.16, 0.18, 0.05, GOLD, sx, 0.05, z, 12);
      solid(new THREE.SphereGeometry(0.08, 10, 6), GOLD_LIGHT, mat(sx, 0.98, z), 0);
      if (z + 2.2 < PZ1 - 0.5) rod(sx, 0.84, z, sx, 0.84, z + 2.2, 0.03, CARPET);
      b.colliders.circle(sx, z, 0.08);
    }
  }
  // Fıskiyeler
  for (const s of [-1, 1]) {
    const fx = CX + s * 9, fz = Z1 + 7.5;
    cyl(2.7, 2.85, 0.6, MARBLE[0], fx, 0.3, fz, 36);
    ring(2.72, 0.08, GOLD, fx, 0.6, fz);
    gcyl(2.5, 2.5, 0.04, "#5ec6ec", fx, 0.54, fz, 36);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      gcyl(0.1, 0.1, 0.03, LED, fx + Math.cos(a) * 2.1, 0.57, fz + Math.sin(a) * 2.1, 8);
    }
    cyl(0.35, 0.55, 1.4, MARBLE[1], fx, 1.2, fz, 16);
    cyl(1.25, 0.6, 0.32, MARBLE[0], fx, 1.95, fz, 24);
    ring(1.25, 0.05, GOLD, fx, 2.1, fz);
    glow(new THREE.CylinderGeometry(1.3, 2.25, 1.5, 24, 1, true), "#9edff7", mat(fx, 1.35, fz));
    cyl(0.2, 0.3, 0.8, MARBLE[1], fx, 2.5, fz, 12);
    solid(new THREE.SphereGeometry(0.36, 16, 10), GOLD_LIGHT, mat(fx, 3.0, fz), 0);
    gcyl(0.05, 0.08, 1.2, "#d8f4ff", fx, 3.8, fz, 8);
    b.colliders.circle(fx, fz, 2.85);
  }
  // Dev zarlar: beyaz mermer, altın noktalar
  for (const s of [-1, 1]) {
    const dx = CX + s * 5.5, dz = PZ1 - 3, ry = s * 0.45;
    box(2.7, 0.5, 2.7, MARBLE[1], dx, 0.25, dz, ry);
    box(2.8, 0.08, 2.8, GOLD, dx, 0.52, dz, ry, 0);
    gbox(2.85, 0.04, 2.85, LED_GOLD, dx, 0.05, dz, ry);
    const S = 1.7, half = S / 2, o = 0.45;
    const die = mat(dx, 0.56 + half, dz, ry);
    solid(new THREE.BoxGeometry(S, S, S), MARBLE[0], die, 0.02);
    const pips: [number, number, number, THREE.Matrix4 | undefined][] = [];
    const face = (pts: [number, number][], to: (u: number, v: number) => [number, number, number], r?: THREE.Matrix4) => {
      for (const [u, v] of pts) pips.push([...to(u, v), r]);
    };
    const five: [number, number][] = [[0, 0], [-o, -o], [o, o], [-o, o], [o, -o]];
    const three: [number, number][] = [[-o, o], [0, 0], [o, -o]];
    const four: [number, number][] = [[-o, -o], [o, o], [-o, o], [o, -o]];
    const six: [number, number][] = [[-o, -o], [-o, 0], [-o, o], [o, -o], [o, 0], [o, o]];
    const rx = new THREE.Matrix4().makeRotationX(Math.PI / 2), rz = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    face(five, (u, v) => [u, half, v]);
    face(three, (u, v) => [u, v, half], rx);
    face(four, (u, v) => [u, v, -half], rx);
    face([[0, 0]], (u, v) => [half, v, u], rz);
    face(six, (u, v) => [-half, v, u], rz);
    for (const [px, py, pz, r] of pips) solid(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 14), GOLD, local(die, px, py, pz, r), 0);
    b.colliders.circle(dx, dz, 1.6);
  }
  // Lambalar ve çit çalıları
  for (const [lx, lz] of [[PX0 + 0.8, PZ1 - 0.8], [PX1 - 0.8, PZ1 - 0.8], [PX0 + 0.8, PZ0 + 2.2], [PX1 - 0.8, PZ0 + 2.2]]) {
    b.prop("post", mat(lx, 0, lz));
    b.prop("bulb", mat(lx, 2.7, lz));
    b.colliders.circle(lx, lz, 0.15);
  }
  for (let z = PZ0 + 4; z < PZ1 - 1.5; z += 2.2) {
    for (const x of [PX0 - 1, PX1 + 1]) b.prop("bush", mat(x, 0, z, b.rand() * 6, 1.1));
  }

  // ------------------------------------------------------------------
  // İç mekân: karo zemin ve altın derzler, ortada oniks madalyon, sütunlar, avize
  // ------------------------------------------------------------------
  g = INTERIOR;
  const IX0 = X0 + IN, IX1 = X1 - IN, IZ1 = Z1 - IN;
  const tw = (IX1 - IX0) / 16, td = (IZ1 - MZ) / 8;
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 8; j++) {
      box(tw, 0.06, td, (i + j) % 2 ? "#e9e4da" : MARBLE[2], IX0 + (i + 0.5) * tw, 0.03, MZ + (j + 0.5) * td, 0, 0.015);
    }
  }
  for (let i = 1; i < 16; i++) box(0.05, 0.065, IZ1 - MZ, GOLD, IX0 + i * tw, 0.035, (IZ1 + MZ) / 2, 0, 0);
  for (let j = 1; j < 8; j++) box(IX1 - IX0, 0.065, 0.05, GOLD, CX, 0.035, MZ + j * td, 0, 0);
  const MED_Z = (STAIR_Z + MZ) / 2 + 2.5;
  cyl(3.2, 3.2, 0.03, ONYX, CX, 0.075, MED_Z, 48);
  ring(3.2, 0.07, GOLD, CX, 0.08, MED_Z);
  ring(2.35, 0.04, GOLD_LIGHT, CX, 0.09, MED_Z);
  for (let k = 0; k < 8; k++) box(0.22, 0.02, k % 2 ? 3.4 : 4.6, GOLD, CX, 0.095, MED_Z, (k * Math.PI) / 8, 0);
  gcyl(0.5, 0.5, 0.025, LED_GOLD, CX, 0.105, MED_Z, 24);
  carpet(MED_Z + 3.25, IZ1);
  carpet(MZ + 0.8, MED_Z - 3.25);

  // Sütunlar: mermer gövde, altın bilezikler, dikey LED yivler
  for (const [px, pz] of [[CX - 3.6, MED_Z + 4.5], [CX + 3.6, MED_Z + 4.5], [CX - 3.6, MED_Z - 4.5], [CX + 3.6, MED_Z - 4.5]]) {
    box(1.15, 0.5, 1.15, MARBLE[0], px, 0.25, pz);
    box(1.2, 0.08, 1.2, GOLD, px, 0.52, pz, 0, 0);
    cyl(0.42, 0.42, H - 0.6, MARBLE[1], px, 0.5 + (H - 0.6) / 2, pz, 20);
    for (const y of [1.3, F2, H - 1.4]) cyl(0.46, 0.46, 0.18, GOLD, px, y, pz, 20);
    for (let k = 0; k < 3; k++) {
      // Yumuşak altın: gece bloom'da patlamasın (salonun ışığı avizeden gelsin)
      const a = (k / 3) * Math.PI * 2 + 0.5;
      gbox(0.05, H - 3.4, 0.05, "#d9b25e", px + Math.cos(a) * 0.43, 1.4 + (H - 3.4) / 2, pz + Math.sin(a) * 0.43);
    }
    cyl(0.8, 0.46, 0.7, GOLD, px, H - 0.45, pz, 20);
    b.colliders.circle(px, pz, 0.6);
  }

  // Avize: üç kat altın halka, sarkan kristaller (ayrı mesh, yavaşça döner)
  const chSolid: THREE.BufferGeometry[] = [], chGlow: THREE.BufferGeometry[] = [];
  {
    const sp = (geo: THREE.BufferGeometry, color: string, m: THREE.Matrix4, lit: boolean) => (lit ? chGlow : chSolid).push(part(geo, color, m));
    const tiers: [number, number, number][] = [[3.1, 8.4, 30], [2.2, 7.8, 22], [1.3, 7.2, 14]];
    for (const [r, y, n] of tiers) {
      sp(new THREE.TorusGeometry(r, 0.07, 6, 48).rotateX(Math.PI / 2), GOLD, mat(0, y, 0), false);
      sp(new THREE.TorusGeometry(r, 0.025, 4, 48).rotateX(Math.PI / 2), LED_GOLD, mat(0, y - 0.09, 0), true);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, cx = Math.cos(a) * r, cz = Math.sin(a) * r, drop = 0.35 + (k % 3) * 0.18;
        sp(new THREE.BoxGeometry(0.015, drop, 0.015), LED, mat(cx, y - drop / 2, cz), true);
        sp(new THREE.OctahedronGeometry(0.12), "#fffaf0", mat(cx, y - drop - 0.1, cz, a, 1, 1.7, 1), true);
      }
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const v = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r), top = new THREE.Vector3(0, y + 1.1, 0);
        const d = top.clone().sub(v), len = d.length();
        _q.setFromUnitVectors(_up, d.normalize());
        sp(new THREE.CylinderGeometry(0.03, 0.03, len, 6), GOLD, new THREE.Matrix4().compose(v.addScaledVector(d, len / 2), _q, _one), false);
      }
    }
    sp(new THREE.CylinderGeometry(0.06, 0.06, H - 6.6, 8), GOLD, mat(0, 6.6 + (H - 6.6) / 2, 0), false);
    sp(new THREE.SphereGeometry(0.4, 16, 10), GOLD_LIGHT, mat(0, 6.7, 0), false);
    sp(new THREE.IcosahedronGeometry(0.3, 1), LED, mat(0, 6.2, 0), true);
  }
  const chandelier = new THREE.Group();
  chandelier.position.set(CX, 0, MED_Z);
  const chMesh = new THREE.Mesh(mergeGeometries(chSolid), new THREE.MeshLambertMaterial({ vertexColors: true }));
  chMesh.castShadow = true;
  chandelier.add(chMesh, new THREE.Mesh(mergeGeometries(chGlow), new THREE.MeshBasicMaterial({ vertexColors: true })));
  group.add(chandelier);

  // ------------------------------------------------------------------
  // Oyun masaları ve makineler
  // ------------------------------------------------------------------
  /** Bar taburesi: altın ayak, beyaz deri minder, alçak sırtlık; oturulur (`rot` masaya bakar). */
  const stool = (x: number, z: number, rot: number, floor = 0, game?: Seat["game"]) => {
    cyl(0.24, 0.28, 0.05, GOLD, x, floor + 0.025, z, 14);
    cyl(0.045, 0.045, 0.45, GOLD, x, floor + 0.25, z, 8);
    cyl(0.25, 0.23, 0.12, LEATHER, x, floor + 0.5, z, 16);
    ring(0.25, 0.02, GOLD, x, floor + 0.44, z);
    const bx = x - Math.sin(rot) * 0.22, bz = z - Math.cos(rot) * 0.22;
    box(0.42, 0.32, 0.06, LEATHER, bx, floor + 0.74, bz, rot, 0.02);
    box(0.44, 0.04, 0.08, GOLD, bx, floor + 0.91, bz, rot, 0);
    b.seats.push({ x, z, rot, h: floor + 0.5, game });
  };
  const npcs: CityNpc[] = [];
  /** Krupiye: masanın arkasında, oyunculara bakar. */
  const dealer = (name: string, x: number, z: number, rot: number, hair: string, skin: string) => {
    npcs.push({
      name, x, z, rot,
      outfit: { hair, tops: "top_smokin", bottoms: "bottom_smokin_alt", shoes: "shoes_klasik", hats: null, glasses: null, facial: null, colors: { hair: "#1a1512", skin } },
      act: { x, z: z + 1.6, r: 1.2, label: "Krupiyeyle konuş 🎩", line: "Bir tabureye otur, bahsini koy. Bol şans!", fx: "sparkle" },
    });
  };
  const chips = (x: number, z: number, y: number, n: number) => {
    const cols = ["#c8102e", "#1a1a1d", "#1f5fbf", "#f2efe6", GOLD];
    for (let k = 0; k < n; k++) {
      const cx = x + (b.rand() - 0.5) * 0.5, cz = z + (b.rand() - 0.5) * 0.3, hgt = 0.02 + Math.floor(b.rand() * 5) * 0.015;
      cyl(0.045, 0.045, hgt, cols[k % cols.length], cx, y + hgt / 2, cz, 10);
    }
  };

  /** Rulet: mermer gövde, altın kenar, yeşil çuha; batı ucunda çark, doğuda bahis tablosu, güneyde 4 tabure. */
  const roulette = (cx: number, cz: number) => {
    box(3.2, 0.72, 1.5, MARBLE[0], cx, 0.36, cz);
    box(3.26, 0.08, 1.56, GOLD, cx, 0.04, cz, 0, 0);
    box(3.5, 0.1, 1.8, GOLD, cx, 0.77, cz, 0, 0.02);
    box(3.3, 0.03, 1.6, FELT, cx, 0.835, cz, 0, 0.02);
    gbox(3.2, 0.03, 1.5, LED_GOLD, cx, 0.7, cz);
    const wx = cx - 1.15;
    cyl(0.62, 0.55, 0.14, "#4a2a17", wx, 0.9, cz, 28);
    cyl(0.5, 0.5, 0.04, "#b3122a", wx, 0.98, cz, 28);
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      box(0.16, 0.012, 0.08, k === 0 ? "#1b8a3a" : k % 2 ? "#141416" : "#b3122a", wx + Math.cos(a) * 0.41, 1.0, cz + Math.sin(a) * 0.41, -a, 0);
    }
    cyl(0.3, 0.3, 0.05, GOLD_DARK, wx, 1.0, cz, 20);
    solid(new THREE.ConeGeometry(0.12, 0.2, 12), GOLD, mat(wx, 1.12, cz), 0);
    for (const ry of [0, Math.PI / 2]) box(0.4, 0.025, 0.025, GOLD_LIGHT, wx, 1.17, cz, ry, 0);
    solid(new THREE.SphereGeometry(0.03, 8, 6), "#ffffff", mat(wx + 0.36, 1.03, cz + 0.12), 0);
    box(0.13, 0.012, 0.46, "#1b8a3a", cx - 0.42, 0.856, cz, 0, 0);
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 3; j++) {
        box(0.135, 0.012, 0.14, (i * 3 + j) % 2 ? "#141416" : "#b3122a", cx - 0.28 + i * 0.15, 0.856, cz - 0.16 + j * 0.16, 0, 0);
      }
    }
    for (let i = 0; i < 3; i++) box(0.58, 0.012, 0.14, "#f2efe6", cx - 0.06 + i * 0.6, 0.856, cz + 0.38, 0, 0);
    chips(cx + 0.5, cz - 0.5, 0.85, 6);
    for (const o of [-0.85, -0.1, 0.65, 1.35]) stool(cx + o, cz + 1.35, Math.PI, 0, { kind: "roulette", x: cx, y: 0.9, z: cz });
    dealer("Krupiye", cx - 1.15, cz - 1.25, 0, "hair_joleli", "#e5bf98");
    b.colliders.segment(cx - 1.0, cz, cx + 1.0, cz, 0.85);
  };

  /** Blackjack: yarım daire masa, düz kenar kuzeyde (krupiye), yayda 5 tabure ve bahis halkaları. */
  const blackjack = (cx: number, cz: number) => {
    const half = (r: number, h: number) => new THREE.CylinderGeometry(r, r, h, 28, 1, false, -Math.PI / 2, Math.PI);
    solid(half(1.5, 0.72), MARBLE[0], mat(cx, 0.36, cz), 0.02);
    box(3.0, 0.72, 0.04, MARBLE[1], cx, 0.36, cz, 0, 0);
    solid(half(1.65, 0.1), GOLD, mat(cx, 0.77, cz), 0.02);
    box(3.3, 0.1, 0.06, GOLD, cx, 0.77, cz - 0.02, 0, 0);
    solid(half(1.5, 0.03), "#14593a", mat(cx, 0.835, cz), 0.02);
    glow(half(1.4, 0.03), LED_GOLD, mat(cx, 0.7, cz));
    for (let k = -2; k <= 2; k++) {
      const a = k * 0.5;
      ring(0.13, 0.012, GOLD_LIGHT, cx + Math.sin(a) * 1.05, 0.856, cz + Math.cos(a) * 1.05);
      box(0.09, 0.006, 0.13, "#fbfbf8", cx + Math.sin(a) * 0.75, 0.855, cz + Math.cos(a) * 0.75, a + 0.2, 0);
      box(0.09, 0.006, 0.13, "#fbfbf8", cx + Math.sin(a) * 0.75 + 0.05, 0.858, cz + Math.cos(a) * 0.75, a - 0.15, 0);
      const r = 2.05, sx = cx + Math.sin(a) * r, sz = cz + Math.cos(a) * r;
      stool(sx, sz, Math.atan2(cx - sx, cz - sz), 0, { kind: "blackjack", x: cx, y: 0.9, z: cz + 0.35 });
    }
    box(0.8, 0.05, 0.25, ONYX, cx, 0.87, cz + 0.2, 0, 0);
    chips(cx, cz + 0.2, 0.895, 8);
    box(0.25, 0.16, 0.34, GOLD_DARK, cx + 0.9, 0.93, cz + 0.25, 0.3, 0);
    b.colliders.circle(cx, cz + 0.45, 1.15);
    dealer("Krupiye", cx, cz - 0.45, 0, "hair_yan_ayrik", "#d9a77c");
    for (const s of [-1, 1]) b.colliders.circle(cx + s * 1.1, cz + 0.3, 0.45);
  };

  /** Slot makinesi (yerel +z önü): beyaz gövde, altın kenarlar, neon ekran ve tepelik, önünde tabure. */
  const slot = (x: number, z: number, ry: number, hue: string, k: number) => {
    const c = Math.cos(ry), s = Math.sin(ry);
    const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * s, z - lx * s + lz * c];
    const p = (w: number, h: number, d: number, color: string, lx: number, y: number, lz: number, lit = false) => {
      const [px, pz] = at(lx, lz);
      if (lit) gbox(w, h, d, color, px, y, pz, ry);
      else box(w, h, d, color, px, y, pz, ry, 0.02);
    };
    p(0.8, 0.95, 0.7, MARBLE[0], 0, 0.475, 0);
    for (const sx of [-1, 1]) p(0.04, 1.95, 0.72, GOLD, sx * 0.42, 0.975, -0.05);
    p(0.82, 0.08, 0.36, GOLD, 0, 0.99, 0.18);
    for (const [bx, col] of [[-0.22, "#ff4f6b"], [0, "#ffd36b"], [0.22, "#5dff9e"]] as const) p(0.12, 0.03, 0.07, col, bx, 1.045, 0.24, true);
    p(0.8, 0.95, 0.5, MARBLE[1], 0, 1.45, -0.08);
    p(0.66, 0.6, 0.02, hue, 0, 1.5, 0.175, true);
    for (const rx of [-0.2, 0, 0.2]) p(0.17, 0.42, 0.02, "#fff7e6", rx, 1.5, 0.19, true);
    p(0.82, 0.28, 0.46, GOLD, 0, 2.06, -0.08);
    p(0.7, 0.17, 0.02, hue, 0, 2.06, 0.155, true);
    const [tx, tz] = at(0, -0.08);
    chase[k % 2].push(part(new THREE.IcosahedronGeometry(0.08, 1), LED_GOLD, mat(tx, 2.27, tz)));
    const [lx, lz] = at(0.47, 0.1);
    cyl(0.025, 0.025, 0.42, GOLD_LIGHT, lx, 1.32, lz, 6);
    solid(new THREE.SphereGeometry(0.065, 10, 6), "#d8142c", mat(lx, 1.55, lz), 0);
    b.colliders.circle(x, z, 0.5);
    const [sx, sz] = at(0, 0.95);
    stool(sx, sz, ry + Math.PI, 0, { kind: "slot", x: at(0, 0.18)[0], y: 1.5, z: at(0, 0.18)[1] });
  };

  for (const sx of [-1, 1]) {
    roulette(CX + sx * 8, MED_Z - 3.5);
    blackjack(CX + sx * 8, MED_Z + 3);
    for (let i = 0; i < 6; i++) {
      const x = CX + sx * (12.6 - i * 1.1);
      slot(x, IZ1 - 0.45, Math.PI, NEON[(i + (sx > 0 ? 3 : 0)) % NEON.length], i);
      slot(x, MZ + 0.45, 0, NEON[(i + (sx > 0 ? 0 : 3) + 1) % NEON.length], i + 1);
    }
  }

  // ------------------------------------------------------------------
  // VIP kaidesi (dolu): ön yüzde kasa; üstü VIP katı. Yanlarda merdivenler.
  // ------------------------------------------------------------------
  const baseD = MZ - (Z0 + IN);
  box(IX1 - IX0, F2, baseD, MARBLE[1], CX, F2 / 2, (MZ + Z0 + IN) / 2, 0, 0.02);
  for (let zc = Z0 + IN + 0.5; zc < MZ; zc += 1) b.colliders.segment(IX0 + 0.5, Math.min(zc, MZ - 0.5), IX1 - 0.5, Math.min(zc, MZ - 0.5), 0.5, F2);
  // Ön yüz: altın şerit, LED, dikey altın çizgiler
  box(IX1 - IX0 - 2 * STAIR_W, 0.32, 0.12, GOLD, CX, F2 - 0.16, MZ + 0.06, 0, 0);
  gbox(IX1 - IX0 - 2 * STAIR_W, 0.04, 0.05, LED, CX, F2 - 0.36, MZ + 0.1);
  for (let x = IX0 + STAIR_W + 1.5; x < IX1 - STAIR_W - 1; x += 3) {
    if (Math.abs(x - CX) < 4.6) continue;
    box(0.08, F2 - 0.5, 0.05, GOLD, x, (F2 - 0.5) / 2 + 0.1, MZ + 0.03, 0, 0);
  }
  // Kasa: altın parmaklıklı koyu cam, mermer tezgâh, içeride sıcak ışık
  box(7.4, 2.1, 0.06, ONYX, CX, 2.2, MZ + 0.03, 0, 0);
  gbox(7.0, 0.05, 0.04, "#ffe2a0", CX, 3.15, MZ + 0.07);
  for (let x = -3.5; x <= 3.51; x += 0.3) cyl(0.02, 0.02, 2.0, GOLD, CX + x, 2.2, MZ + 0.12, 6);
  box(7.6, 0.12, 0.2, GOLD, CX, 3.3, MZ + 0.1, 0, 0);
  box(8, 1.05, 0.75, MARBLE[0], CX, 0.525, MZ + 0.375);
  box(8.1, 0.06, 0.85, GOLD, CX, 1.08, MZ + 0.4, 0, 0);
  gbox(8, 0.03, 0.03, LED_GOLD, CX, 0.99, MZ + 0.77);
  for (let k = 0; k < 4; k++) box(0.22, 0.04, 0.11, GOLD_LIGHT, CX - 2.5 + k * 1.6, 1.13, MZ + 0.35, 0.1 * k, 0);
  addText(textPlane("KASA", 2.8, 0.8), CX, 3.85, MZ + 0.07, 0, STATIC);
  b.colliders.segment(CX - 3.6, MZ + 0.4, CX + 3.6, MZ + 0.4, 0.4);

  // Merdivenler: mermer basamaklar, altın burun, basamak altında LED; iç yanda altın korkuluk
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? IX0 : IX1 - STAIR_W, x1 = x0 + STAIR_W, xm = (x0 + x1) / 2;
    const inner = side < 0 ? x1 : x0;
    for (let i = 0; i < STEPS; i++) {
      const top = (i + 1) * RISE, zc = STAIR_Z - (i + 0.5) * TREAD;
      box(STAIR_W, top, TREAD, i % 2 ? MARBLE[0] : MARBLE[2], xm, top / 2, zc, 0, 0.015);
      box(STAIR_W, 0.035, 0.06, GOLD, xm, top - 0.017, zc + TREAD / 2 - 0.03, 0, 0);
      gbox(STAIR_W - 0.2, 0.025, 0.02, LED, xm, top - 0.07, zc + TREAD / 2 + 0.005);
      b.colliders.segment(x0 + 0.25, zc, x1 - 0.25, zc, TREAD / 2, top);
    }
    // Yan yüzü (salona bakan): mermer ve altın şerit eğimi
    for (let i = 0; i < STEPS; i += 2) {
      const top = (i + 1) * RISE, zc = STAIR_Z - (i + 0.5) * TREAD;
      cyl(0.03, 0.03, 0.95, GOLD, inner, top + 0.475, zc, 6);
    }
    rod(inner, RISE + 0.95, STAIR_Z - 0.25, inner, F2 + 0.95, MZ, 0.045, GOLD_LIGHT);
    rod(inner, RISE + 0.9, STAIR_Z - 0.25, inner, F2 + 0.9, MZ, 0.015, LED_GOLD, true);
    rod(inner, RISE + 0.2, STAIR_Z - 0.25, inner, F2 + 0.2, MZ, 0.025, GOLD);
    cyl(0.07, 0.07, 1.1, GOLD, inner, 0.55, STAIR_Z - 0.05, 10);
    solid(new THREE.SphereGeometry(0.11, 12, 8), GOLD_LIGHT, mat(inner, 1.15, STAIR_Z - 0.05), 0);
    b.colliders.segment(inner, STAIR_Z, inner, MZ, 0.06);
  }

  // ------------------------------------------------------------------
  // VIP katı: bordo halı, ön korkuluk, bakara masası, lounge, bar ve neon tabela
  // ------------------------------------------------------------------
  const vx0 = IX0 + STAIR_W, vx1 = IX1 - STAIR_W, vz0 = Z0 + IN;
  box(vx1 - vx0, 0.03, MZ - vz0 - 0.3, VIP_CARPET, CX, F2 + 0.015, (vz0 + MZ - 0.3) / 2, 0, 0.02);
  for (const s of [-1, 1]) {
    box(vx1 - vx0, 0.035, 0.08, GOLD, CX, F2 + 0.017, (vz0 + MZ - 0.3) / 2 + s * ((MZ - vz0 - 0.3) / 2 - 0.3), 0, 0);
    box(0.08, 0.035, MZ - vz0 - 0.3, GOLD, CX + s * ((vx1 - vx0) / 2 - 0.3), F2 + 0.017, (vz0 + MZ - 0.3) / 2, 0, 0);
  }
  // Ön korkuluk: altın babalar, üst ve alt küpeşte, LED
  const railZ = MZ - 0.06;
  for (let x = vx0 + 0.3; x <= vx1 - 0.29; x += 0.6) cyl(0.025, 0.025, 0.95, GOLD, x, F2 + 0.5, railZ, 6);
  box(vx1 - vx0, 0.08, 0.12, GOLD_LIGHT, CX, F2 + 1.0, railZ, 0, 0);
  box(vx1 - vx0, 0.05, 0.06, GOLD, CX, F2 + 0.12, railZ, 0, 0);
  gbox(vx1 - vx0, 0.02, 0.03, LED_GOLD, CX, F2 + 0.94, railZ + 0.05);
  b.colliders.segment(vx0, railZ, vx1, railZ, 0.08);

  // Bakara masası
  const bz = (vz0 + MZ) / 2 - 0.2;
  solid(new THREE.CylinderGeometry(1, 1, 0.72, 40), MARBLE[0], mat(CX, F2 + 0.36, bz, 0, 2.3, 1, 1.25), 0.02);
  solid(new THREE.CylinderGeometry(1, 1, 0.1, 40), GOLD, mat(CX, F2 + 0.77, bz, 0, 2.45, 1, 1.38), 0.02);
  solid(new THREE.CylinderGeometry(1, 1, 0.03, 40), "#2b1650", mat(CX, F2 + 0.835, bz, 0, 2.3, 1, 1.25), 0.02);
  glow(new THREE.CylinderGeometry(1, 1, 0.03, 40), LED_GOLD, mat(CX, F2 + 0.68, bz, 0, 2.2, 1, 1.15));
  ring(0.4, 0.02, GOLD_LIGHT, CX, F2 + 0.856, bz);
  chips(CX - 1, bz + 0.3, F2 + 0.85, 6);
  chips(CX + 1, bz + 0.3, F2 + 0.85, 6);
  for (const a of [-1.9, -1.15, -0.4, 0.4, 1.15, 1.9]) {
    const sx = CX + Math.sin(a) * 3.1, sz = bz + Math.cos(a) * 2.05;
    stool(sx, sz, Math.atan2(CX - sx, bz - sz), F2);
  }
  b.colliders.segment(CX - 1.1, bz, CX + 1.1, bz, 1.2);
  // Masanın üstünde altın halka avize
  ring(1.0, 0.05, GOLD, CX, F2 + 3.3, bz);
  ring(0.95, 0.025, LED, CX, F2 + 3.22, bz, true);
  rod(CX, F2 + 3.3, bz, CX, H, bz, 0.03, GOLD);

  // Lounge: beyaz deri koltuklar, altın kaide ve cam sehpa
  const sofa = (cx: number, cz: number, ry: number, len: number) => {
    const c = Math.cos(ry), s = Math.sin(ry);
    const at = (lx: number, lz: number): [number, number] => [cx + lx * c + lz * s, cz - lx * s + lz * c];
    const p = (w: number, h: number, d: number, color: string, lx: number, y: number, lz: number) => {
      const [px, pz] = at(lx, lz);
      box(w, h, d, color, px, F2 + y, pz, ry, 0.02);
    };
    p(len + 0.1, 0.07, 0.9, GOLD, 0, 0.035, 0);
    p(len, 0.38, 0.85, LEATHER, 0, 0.26, 0);
    p(len, 0.6, 0.2, LEATHER, 0, 0.65, -0.36);
    p(len + 0.04, 0.05, 0.24, GOLD, 0, 0.97, -0.36);
    for (const sx of [-1, 1]) p(0.2, 0.55, 0.85, LEATHER, sx * (len / 2 + 0.05), 0.42, 0);
    const [gx, gz] = at(0, 0);
    gbox(len, 0.03, 0.8, LED_GOLD, gx, F2 + 0.015, gz, ry);
    const n = Math.max(2, Math.round(len / 0.85));
    for (let i = 0; i < n; i++) {
      const [sx, sz] = at(-len / 2 + (i + 0.5) * (len / n), 0.08);
      b.seats.push({ x: sx, z: sz, rot: ry, h: F2 + 0.45 });
    }
    const [ax, az] = at(-len / 2, -0.1), [bx2, bz2] = at(len / 2, -0.1);
    b.colliders.segment(ax, az, bx2, bz2, 0.42);
  };
  sofa(CX - 9.5, vz0 + 1.3, 0, 3.4);
  sofa(CX - 12.3, bz + 0.6, Math.PI / 2, 2.6);
  sofa(CX - 6.7, bz + 0.6, -Math.PI / 2, 2.6);
  cyl(0.65, 0.65, 0.04, "#cfe6ee", CX - 9.5, F2 + 0.45, bz + 0.4, 24);
  ring(0.65, 0.03, GOLD, CX - 9.5, F2 + 0.45, bz + 0.4);
  cyl(0.1, 0.25, 0.42, GOLD, CX - 9.5, F2 + 0.21, bz + 0.4, 12);
  solid(new THREE.CylinderGeometry(0.06, 0.08, 0.25, 10), GOLD_LIGHT, mat(CX - 9.3, F2 + 0.6, bz + 0.3), 0);
  b.colliders.circle(CX - 9.5, bz + 0.4, 0.7);

  // Bar: mermer tezgâh, altın tepe, arkada ışıklı raflar ve şişeler
  const barX0 = CX + 5.6, barX1 = CX + 12.2, barZ = vz0 + 3.4, barM = (barX0 + barX1) / 2, barW = barX1 - barX0;
  box(barW, 1.1, 0.7, MARBLE[0], barM, F2 + 0.55, barZ);
  box(barW + 0.2, 0.07, 0.85, GOLD, barM, F2 + 1.135, barZ, 0, 0);
  gbox(barW, 0.03, 0.03, LED_GOLD, barM, F2 + 1.06, barZ + 0.43);
  for (let k = 0; k <= 8; k++) box(0.06, 1.0, 0.04, GOLD, barX0 + 0.1 + k * ((barW - 0.2) / 8), F2 + 0.55, barZ + 0.36, 0, 0);
  for (let k = 0; k < 5; k++) stool(barX0 + 0.7 + k * 1.3, barZ + 1.15, Math.PI, F2);
  b.colliders.segment(barX0 + 0.3, barZ, barX1 - 0.3, barZ, 0.45);
  const shelfZ = vz0 + 0.3;
  box(barW + 0.4, 2.4, 0.06, ONYX, barM, F2 + 1.75, vz0 + 0.04, 0, 0);
  gbox(barW + 0.2, 0.04, 0.03, "#ffd9a0", barM, F2 + 2.95, vz0 + 0.1);
  const bottle = ["#ffb347", "#5dff9e", "#ff6b9a", "#7ef9ff", "#ffd36b", "#c58bff"];
  for (const [k, y] of [1.15, 1.7, 2.25].entries()) {
    box(barW + 0.2, 0.05, 0.4, GOLD, barM, F2 + y, shelfZ, 0, 0);
    gbox(barW + 0.1, 0.02, 0.02, LED, barM, F2 + y - 0.04, shelfZ + 0.19);
    for (let i = 0; i < 12; i++) {
      const bx2 = barX0 + 0.35 + i * ((barW - 0.7) / 11), hgt = 0.24 + ((i + k) % 3) * 0.05;
      gcyl(0.045, 0.055, hgt, bottle[(i + k * 2) % bottle.length], bx2, F2 + y + 0.025 + hgt / 2, shelfZ, 8);
      gcyl(0.015, 0.02, 0.08, "#fff3d6", bx2, F2 + y + 0.065 + hgt, shelfZ, 6);
    }
  }
  b.colliders.segment(barX0, shelfZ, barX1, shelfZ, 0.25);

  // Neon tabelalar: kuzey duvarında VIP ve BAR
  addText(textPlane("VIP", 5.6, 2.2, { sub: "HIGH ROLLERS" }), CX, F2 + 4.6, vz0 + 0.12, 0, 0);
  addText(textPlane("BAR", 2.6, 0.9, { color: "#ff7ad9" }), barM, F2 + 3.55, vz0 + 0.08, 0, 0);
  g = 0;
  box(6.2, 2.7, 0.08, ONYX, CX, F2 + 4.6, vz0 + 0.04, 0, 0);
  for (const s of [-1, 1]) {
    box(6.4, 0.12, 0.14, GOLD, CX, F2 + 4.6 + s * 1.38, vz0 + 0.06, 0, 0);
    box(0.12, 2.9, 0.14, GOLD, CX + s * 3.15, F2 + 4.6, vz0 + 0.06, 0, 0);
  }
  for (let k = 0; k < 12; k++) {
    // Tabelanın iki yanında altın güneş ışınları
    for (const s of [-1, 1]) {
      const a = (k / 11 - 0.5) * 2.2;
      const ox = CX + s * (3.4 + Math.cos(a) * 1.2), oy = F2 + 4.6 + Math.sin(a) * 1.2;
      gbox(1.1, 0.04, 0.03, LED_GOLD, ox, oy, vz0 + 0.05, 0);
    }
  }

  // ------------------------------------------------------------------
  // Mesh'ler: gruplar (solan duvarlar, çatı), sabit parıltılar, kayan ampuller, gece ışıkları
  // ------------------------------------------------------------------
  const solidMeshes: THREE.Mesh[] = [];
  const glowMeshes: THREE.Mesh[] = [];
  const outsideFlood = { value: 0 }, insideFlood = { value: 0 };
  for (let i = 0; i < 7; i++) {
    if (solids[i].length) {
      const m = new THREE.Mesh(mergeGeometries(solids[i]), floodMaterial(i === INTERIOR ? insideFlood : outsideFlood, { transparent: i < STATIC, opacity: 1 }));
      // Duvarlar ve iç mekân gölge almaz: beyaz mermer her saatte beyaz kalsın (ön meydan alır)
      m.castShadow = i !== INTERIOR;
      m.receiveShadow = i === STATIC;
      m.matrixAutoUpdate = false;
      group.add(m);
      solidMeshes[i] = m;
      if (i < STATIC) fades[i].push(m.material as THREE.Material);
    }
    if (i < INTERIOR && glows[i].length) {
      const m = new THREE.Mesh(mergeGeometries(glows[i]), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: i < STATIC }));
      m.matrixAutoUpdate = false;
      group.add(m);
      glowMeshes[i] = m;
      if (i < STATIC) fades[i].push(m.material as THREE.Material);
    }
  }
  const chaseMats = chase.map((parts) => {
    const m = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshBasicMaterial({ vertexColors: true }));
    m.matrixAutoUpdate = false;
    group.add(m);
    return m.material as THREE.MeshBasicMaterial;
  });

  // Gece: avizenin ve VIP katının sıcak ışığı (gerçek lamba ışıkları açıksa; uzaktayken sönük)
  const lights: THREE.PointLight[] = [];
  if (lamps > 0) {
    for (const [lx, ly, lz, dist] of [[CX, 6.4, MED_Z, 26], [CX, F2 + 3, bz, 16]] as const) {
      const l = new THREE.PointLight("#ffdca0", 0, dist, 1.4);
      l.position.set(lx, ly, lz);
      group.add(l);
      lights.push(l);
    }
  }

  const inside = (x: number, z: number) => Math.abs(x - CX) < HW && Math.abs(z - CZ) < HD;
  const cameraSide = [
    (c: THREE.Vector3) => c.z < Z0 + 2.5,
    (c: THREE.Vector3) => c.z > Z1 - 2.5,
    (c: THREE.Vector3) => c.x < X0 + 2.5,
    (c: THREE.Vector3) => c.x > X1 - 2.5,
  ];
  const opacity = [1, 1, 1, 1];

    return {
    group,
    npcs,
    inside,
    update(time, dt, focus, camera, night) {
      const inCasino = !!focus && inside(focus.x, focus.z);
      if (solidMeshes[ROOF]) solidMeshes[ROOF].visible = !inCasino;
      if (glowMeshes[ROOF]) glowMeshes[ROOF].visible = !inCasino;
      roofSign.visible = !inCasino;
      const k = 1 - Math.exp(-dt * 8);
      for (let i = 0; i < 4; i++) {
        const target = inCasino && camera && cameraSide[i](camera) ? 0.15 : 1;
        opacity[i] += (target - opacity[i]) * k;
        for (const m of fades[i]) {
          m.opacity = opacity[i];
          if (m instanceof THREE.MeshLambertMaterial) m.depthWrite = opacity[i] > 0.95;
        }
        if (solidMeshes[i]) solidMeshes[i].castShadow = opacity[i] > 0.95;
      }
      // Kayan ampuller: iki takım sırayla yanar
      const on = Math.floor(time * 2.6) % 2 === 0;
      chaseMats[0].color.setScalar(on ? 1 : 0.22);
      chaseMats[1].color.setScalar(on ? 0.22 : 1);
      // Projektörler: her biri kendi fazıyla döner, gece görünür
      beams.forEach((p, i) => (p.rotation.y = time * 0.32 + i * 1.7 + Math.sin(time * 0.21 + i) * 0.6));
      beamMat.opacity = 0.11 * night;
      for (const p of beams) p.visible = night > 0.02;
      outsideFlood.value = night * 0.42;
      insideFlood.value = night * 0.4;
      chandelier.rotation.y = time * 0.06;
      if (lights.length) {
        const near = focus ? Math.hypot(focus.x - CX, focus.z - CZ) : Infinity;
        const fade = near < 45 ? 1 : near < 70 ? (70 - near) / 25 : 0;
        lights[0].intensity = (0.4 + 2.6 * night) * fade * 4;
        lights[1].intensity = (0.3 + 2.0 * night) * fade * 3;
      }
    },
  };
}
