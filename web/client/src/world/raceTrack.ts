// Oyuncak pistin 3D görünümü: binadaki platformun üstünde pist (asfalt, kırmızı-beyaz bordür, plastik
// bariyer, damalı çizgi) ve arabalar. Pist birimiyle kurulur, grup RACE_SCALE ile küçülür. Pist mesh'i
// tek parça (pist değişince yeniden kurulur); her araba tek mesh; duman ve nitro alevi küçük havuzlar.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CAR, gridSpot, RACE, type Track, trackOf } from "../../../shared/race";
import { RACE_HOUSE, RACE_SCALE, RACE_TRACK_Y } from "../../../shared/zones";
import { mat, part } from "./geo";

const W = RACE.halfW;
const CURB = 0.9;
const WALL = 0.6;
const WALL_H = 1.4;
const SMOKE = 80;

/** Pistin bir yanının (side +1 sağ, −1 sol) `off` uzaklıktaki kenarı: iç virajda katlanmasın diye kısalır. */
function edge(t: Track, i: number, side: number, off: number, out: THREE.Vector3, y: number): THREE.Vector3 {
  const n = t.n;
  const a = (i - 3 + n) % n, b = (i + 3) % n;
  // Dönüş yönü ve yarıçapı: teğetlerin 6 birimde dönüşü
  const cross = t.tx[a] * t.tz[b] - t.tz[a] * t.tx[b];
  const angle = Math.asin(Math.max(-1, Math.min(1, cross)));
  const r = Math.abs(angle) > 1e-4 ? 6 / Math.abs(angle) : Infinity;
  const inner = Math.sign(cross) === side;
  const o = inner ? Math.min(off, r * 0.96) : off;
  return out.set(t.px[i] + -t.tz[i] * side * o, y, t.pz[i] + t.tx[i] * side * o);
}

/** İki kenar arasında şerit (her nokta çifti için dörtgen); renk nokta başına. */
function strip(t: Track, side: number, from: number, to: number, y: number, color: (i: number) => string): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3(), k = new THREE.Color();
  for (let i = 0; i < t.n; i++) {
    const j = (i + 1) % t.n;
    edge(t, i, side, from, a, y);
    edge(t, i, side, to, b, y);
    edge(t, j, side, from, c, y);
    edge(t, j, side, to, d, y);
    k.set(color(i));
    // Üstten bakınca saat yönü tersi (yukarı bakan yüz)
    const quad = side > 0 ? [a, c, b, b, c, d] : [a, b, c, c, b, d];
    for (const v of quad) {
      pos.push(v.x, v.y, v.z);
      col.push(k.r, k.g, k.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Bariyer: kenar boyunca kutu benzeri duvar (üst + iki yan). */
function wall(t: Track, side: number, from: number, to: number, h: number, color: (i: number) => string): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const q = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const k = new THREE.Color();
  const push = (v: THREE.Vector3) => {
    pos.push(v.x, v.y, v.z);
    col.push(k.r, k.g, k.b);
  };
  for (let i = 0; i < t.n; i++) {
    const j = (i + 1) % t.n;
    edge(t, i, side, from, p[0], 0);
    edge(t, i, side, to, p[1], 0);
    edge(t, j, side, from, q[0], 0);
    edge(t, j, side, to, q[1], 0);
    k.set(color(i));
    const top = (v: THREE.Vector3) => v.clone().setY(h);
    // Üst, iç yüz, dış yüz (iki yüzlü malzeme: sarma yönü önemsiz)
    for (const v of [top(p[0]), top(q[0]), top(p[1]), top(p[1]), top(q[0]), top(q[1])]) push(v);
    for (const v of [p[0], q[0], top(p[0]), top(p[0]), q[0], top(q[0])]) push(v);
    for (const v of [p[1], top(p[1]), q[1], q[1], top(p[1]), top(q[1])]) push(v);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function trackGeometry(t: Track): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Asfalt (iki yarı), hafif şeritli
  for (const side of [-1, 1]) parts.push(strip(t, side, 0, W, 0.3, (i) => (Math.floor(i / 6) % 2 ? "#3a3e48" : "#40444f")));
  // Orta kesikli çizgi
  for (const side of [-1, 1]) parts.push(strip(t, side, 0, 0.14, 0.38, (i) => (Math.floor(i / 3) % 2 ? "#40444f" : "#e8e8e0")));
  // Bordürler
  for (const side of [-1, 1]) parts.push(strip(t, side, W, W + CURB, 0.36, (i) => (Math.floor(i / 2) % 2 ? "#e23b33" : "#f4f1e8")));
  // Plastik bariyer
  for (const side of [-1, 1]) parts.push(wall(t, side, W + CURB, W + CURB + WALL, WALL_H, (i) => (Math.floor(i / 5) % 2 ? "#2f7bd8" : "#f2c230")));
  // Damalı başlangıç çizgisi (iki sıra)
  const nx = -t.tz[0], nz = t.tx[0], tx = t.tx[0], tz = t.tz[0];
  const sq = (2 * W) / 10;
  for (let r = 0; r < 2; r++) {
    for (let k = 0; k < 10; k++) {
      const off = -W + sq * (k + 0.5), along = (r - 0.5) * sq;
      const m = mat(t.px[0] + nx * off + tx * along, 0.42, t.pz[0] + nz * off + tz * along, Math.atan2(tx, tz));
      parts.push(part(new THREE.PlaneGeometry(sq, sq).rotateX(-Math.PI / 2), (r + k) % 2 ? "#111111" : "#ffffff", m));
    }
  }
  // Başlangıç kutuları
  for (let slot = 0; slot < RACE.max; slot++) {
    const g = gridSpot(t, slot);
    parts.push(part(new THREE.PlaneGeometry(CAR.wid + 0.8, 0.18).rotateX(-Math.PI / 2), "#f4f1e8", mat(g.x - Math.cos(g.a) * (CAR.len / 2 + 0.4), 0.4, g.z - Math.sin(g.a) * (CAR.len / 2 + 0.4), Math.PI / 2 - g.a)));
  }
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)).map((p) => {
    p.deleteAttribute("uv");
    return p;
  }));
}

/** Oyuncak araba: gövde rengi oyuncunun rengi, +x ileri. */
function carGeometry(color: THREE.Color): THREE.BufferGeometry {
  const c = `#${color.getHexString()}`;
  const dark = `#${color.clone().multiplyScalar(0.55).getHexString()}`;
  const parts = [
    part(new THREE.BoxGeometry(CAR.len, 0.8, CAR.wid), c, mat(0, 0.75, 0)),
    part(new THREE.BoxGeometry(CAR.len * 0.42, 0.75, CAR.wid * 0.82), "#bfe3f7", mat(-0.25, 1.5, 0)),
    part(new THREE.BoxGeometry(CAR.len * 0.44, 0.12, CAR.wid * 0.86), c, mat(-0.25, 1.9, 0)),
    part(new THREE.BoxGeometry(0.3, 0.5, CAR.wid * 0.95), dark, mat(-CAR.len / 2 + 0.1, 1.35, 0)),
    part(new THREE.BoxGeometry(0.12, 0.2, 0.45), "#fff3b0", mat(CAR.len / 2, 0.85, -0.65)),
    part(new THREE.BoxGeometry(0.12, 0.2, 0.45), "#fff3b0", mat(CAR.len / 2, 0.85, 0.65)),
    part(new THREE.BoxGeometry(0.6, 0.06, CAR.wid * 0.5), "#ffffff", mat(0.9, 1.16, 0)),
  ];
  const wheel = new THREE.CylinderGeometry(0.5, 0.5, 0.45, 10).rotateX(Math.PI / 2);
  for (const wx of [-1.3, 1.3]) for (const wz of [-1, 1]) parts.push(part(wheel.clone(), "#1c1c20", mat(wx, 0.5, wz * (CAR.wid / 2))));
  return mergeGeometries(parts);
}

/** Araba başı isim etiketi (tepeden okunur). */
function label(text: string, color: THREE.Color): THREE.Sprite {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 64;
  const g = cv.getContext("2d")!;
  g.font = "800 36px system-ui, sans-serif";
  const w = Math.min(248, g.measureText(text).width + 24);
  g.fillStyle = "rgba(10,12,20,0.72)";
  g.beginPath();
  g.roundRect((256 - w) / 2, 6, w, 52, 14);
  g.fill();
  g.fillStyle = `#${color.getHexString()}`;
  g.fillRect((256 - w) / 2 + 10, 26, 10, 12);
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128 + 8, 33, w - 30);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(9, 2.25, 1);
  s.renderOrder = 5;
  return s;
}

export interface CarPose {
  x: number;
  z: number;
  a: number;
  /** 1 drift, 2 nitro. */
  f: number;
}

interface CarView {
  mesh: THREE.Mesh;
  flame: THREE.Mesh;
  tag: THREE.Sprite;
  name: string;
  lastSmoke: number;
}

/**
 * Gece pist binanın lambasıyla aydınlanmış görünsün: nesnenin kendi rengi kadar ışıma (gri değil; renkler
 * solmaz). Gerçek ışık eklemek bütün sahnenin shader'larını ağırlaştırırdı.
 */
function lampLit<T extends THREE.MeshLambertMaterial>(m: T, lamp: { value: number }): T {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uLamp = lamp;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uLamp;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uLamp;");
  };
  m.customProgramCacheKey = () => "race-lamp";
  return m;
}

export class RaceView {
  readonly group = new THREE.Group();
  private trackMesh: THREE.Mesh | null = null;
  private trackIndex = -1;
  /** Gece lambası (0 gündüz … 1 gece). */
  private lamp = { value: 0 };
  private material = lampLit(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), this.lamp);
  private carMaterial = lampLit(new THREE.MeshLambertMaterial({ vertexColors: true }), this.lamp);
  private cars = new Map<number, CarView>();
  private smoke: THREE.InstancedMesh;
  private puffs: { x: number; z: number; t: number; s: number }[] = [];
  private nextPuff = 0;
  private marker: THREE.Mesh;
  private m4 = new THREE.Matrix4();

  constructor() {
    this.group.position.set(RACE_HOUSE.x, RACE_TRACK_Y, RACE_HOUSE.z);
    this.group.scale.setScalar(RACE_SCALE);
    this.smoke = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.6, 0), new THREE.MeshBasicMaterial({ color: "#e9e9ee", transparent: true, opacity: 0.55, depthWrite: false }), SMOKE);
    this.smoke.count = 0;
    this.smoke.frustumCulled = false;
    this.group.add(this.smoke);
    // Kendi arabamın üstünde dönen ok
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.6, 4).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: "#ffffff", depthTest: false }));
    this.marker.renderOrder = 6;
    this.marker.visible = false;
    this.group.add(this.marker);
    this.setTrack(0);
  }

  setTrack(i: number): void {
    if (i === this.trackIndex) return;
    this.trackIndex = i;
    if (this.trackMesh) {
      this.group.remove(this.trackMesh);
      this.trackMesh.geometry.dispose();
    }
    this.trackMesh = new THREE.Mesh(trackGeometry(trackOf(i)), this.material);
    this.trackMesh.receiveShadow = true;
    this.group.add(this.trackMesh);
  }

  /** Arabası olmayanlar silinir; yenilere mesh kurulur. */
  syncCars(players: { sid: number; name: string; color: THREE.Color }[]): void {
    const keep = new Set(players.map((p) => p.sid));
    for (const [sid, v] of this.cars) {
      if (keep.has(sid)) continue;
      this.group.remove(v.mesh, v.tag);
      v.mesh.geometry.dispose();
      (v.tag.material as THREE.SpriteMaterial).map?.dispose();
      this.cars.delete(sid);
    }
    for (const p of players) {
      if (this.cars.has(p.sid)) continue;
      const mesh = new THREE.Mesh(carGeometry(p.color), this.carMaterial);
      mesh.castShadow = true;
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.4, 6).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#5fd7ff", transparent: true, opacity: 0.85 }));
      flame.position.set(-CAR.len / 2 - 1.1, 0.8, 0);
      flame.visible = false;
      mesh.add(flame);
      const tag = label(p.name, p.color);
      mesh.visible = tag.visible = false;
      this.group.add(mesh, tag);
      this.cars.set(p.sid, { mesh, flame, tag, name: p.name, lastSmoke: 0 });
    }
  }

  /** Arabanın bu karedeki yeri (yoksa gizlenir). `mine`: üstünde ok. */
  setCar(sid: number, pose: CarPose | null, time: number, mine = false): void {
    const v = this.cars.get(sid);
    if (!v) return;
    v.mesh.visible = v.tag.visible = !!pose;
    if (!pose) return;
    v.mesh.position.set(pose.x, 0.3, pose.z);
    v.mesh.rotation.y = -pose.a;
    v.tag.position.set(pose.x, 6, pose.z - 3.2);
    v.flame.visible = (pose.f & 2) !== 0;
    if (v.flame.visible) v.flame.scale.set(1 + Math.sin(time * 40) * 0.25, 1, 1);
    if (pose.f & 1 && time - v.lastSmoke > 0.05) {
      v.lastSmoke = time;
      const ca = Math.cos(pose.a), sa = Math.sin(pose.a);
      for (const side of [-1, 1]) this.puff(pose.x - ca * 1.6 - sa * side, pose.z - sa * 1.6 + ca * side, time);
    }
    if (mine) {
      this.marker.visible = true;
      this.marker.position.set(pose.x, 4.2 + Math.sin(time * 5) * 0.4, pose.z);
      this.marker.rotation.y = time * 3;
    }
  }

  private puff(x: number, z: number, time: number): void {
    const p = { x, z, t: time, s: 0.6 + Math.random() * 0.5 };
    if (this.puffs.length < SMOKE) this.puffs.push(p);
    else this.puffs[this.nextPuff++ % SMOKE] = p;
  }

  /** Kare başı: duman söner; gece pist binanın lambasıyla aydınlanır. */
  update(time: number, night: number, showMarker: boolean): void {
    if (!showMarker) this.marker.visible = false;
    let n = 0;
    for (const p of this.puffs) {
      const age = time - p.t;
      if (age < 0 || age > 0.9) continue;
      const s = p.s * (1 + age * 2.2);
      this.m4.makeScale(s, s, s).setPosition(p.x, 0.6 + age * 2, p.z);
      this.smoke.setMatrixAt(n++, this.m4);
    }
    this.smoke.count = n;
    this.smoke.instanceMatrix.needsUpdate = true;
    this.lamp.value = night * 0.55;
  }

  /** Pistin dünyadaki merkezi ve yarı ölçüleri (tepeden kamera için). */
  bounds(): { x: number; y: number; z: number; hw: number; hd: number } {
    return { x: RACE_HOUSE.x, y: RACE_TRACK_Y, z: RACE_HOUSE.z, hw: 52 * RACE_SCALE, hd: 38 * RACE_SCALE };
  }
}
