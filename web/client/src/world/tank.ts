// Tank: M26 Pershing modeli (client/tank/m26.obj) üç parçada: gövde, dönen kule, kalkan namlu (3 draw call).
// Model arka planda iner; o zamana kadar tank görünmez (çarpışma yine çalışır).
// Ayrıca uçan mermi, patlama ve "bum" sesi. Konum/açıyı main.ts verir.
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { DEFAULT_ELEV, GUN_PIVOT_Z, MUZZLE_Y, type Shot, shellAt } from "../../../shared/tank";
import m26Url from "../../tank/m26.obj?url";

const RECOIL_TIME = 0.35;
/** Dünyadaki tankın tonu: nötr metal × bu = zeytin yeşili. */
const OLIVE = "#a6a47a";
/**
 * Model ileriye -z ile bakar, zemini y -0.67, kule ekseni z -0.1'de. Bizde ileri +z, zemin 0,
 * kule ekseni orijin: 180° döndür, 1.25 ölçekle (paylaşılan GUN_PIVOT_Z / MUZZLE_Y / GUN_LEN buna göre).
 */
const MODEL_SCALE = 1.25;
const MODEL_FIX = new THREE.Matrix4()
  .makeScale(-MODEL_SCALE, MODEL_SCALE, -MODEL_SCALE)
  .multiply(new THREE.Matrix4().makeTranslation(0, 0.67, 0.1));
const TURRET_PARTS = /^(body_upper|body_side|hatch|machine_gun|antenna_)/;
const GUN_PARTS = /^cannon/;
/** Malzeme renkleri (modelin dokusu yok). Gövde metali nötr: rengi tankın tonu verir (dünyada zeytin, savaşta takım). */
const COLORS: Record<string, string> = {
  metal: "#a9a9a2",
  metal_black: "#2b2a26",
  rubber: "#1d1d1b",
  lights_front: "#efe8cc",
  lights_rear: "#8a1a12",
};

/** OBJ'yi gövde/kule/namlu geometrilerine ayırır; malzemeler vertex rengine iner. */
type Model = { hull: THREE.BufferGeometry; turret: THREE.BufferGeometry; gun: THREE.BufferGeometry };
let model: Promise<Model> | null = null;

/** Tek seferlik: savaşta onlarca tank aynı geometriyi paylaşır. */
function sharedModel(): Promise<Model> {
  model ??= loadModel();
  return model;
}

/** Ekranın ortasından çıkan ışının (nişangâh) zemine (y = 0) değdiği nokta; yatay bakışta `far` metre ötesi. */
export function aimRay(camera: THREE.Camera, out: THREE.Vector3, far = 150): THREE.Vector3 {
  camera.getWorldDirection(out);
  const t = out.y < -1e-3 ? Math.min(-camera.position.y / out.y, far) : far;
  return out.multiplyScalar(t).add(camera.position);
}

async function loadModel(): Promise<Model> {
  const root = await new OBJLoader().loadAsync(m26Url);
  const parts: Record<"hull" | "turret" | "gun", THREE.BufferGeometry[]> = { hull: [], turret: [], gun: [] };
  const tmp = new THREE.Color();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = (o.geometry as THREE.BufferGeometry).index ? (o.geometry as THREE.BufferGeometry).toNonIndexed() : (o.geometry as THREE.BufferGeometry);
    g.deleteAttribute("uv");
    g.applyMatrix4(MODEL_FIX);
    const mats = (Array.isArray(o.material) ? o.material : [o.material]) as THREE.Material[];
    const n = g.attributes.position.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
    const colors = new Float32Array(n * 3);
    for (const grp of groups) {
      tmp.set(COLORS[mats[grp.materialIndex ?? 0]?.name] ?? COLORS.metal);
      for (let i = grp.start; i < Math.min(n, grp.start + grp.count); i++) tmp.toArray(colors, i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.clearGroups();
    parts[GUN_PARTS.test(o.name) ? "gun" : TURRET_PARTS.test(o.name) ? "turret" : "hull"].push(g);
  });
  // Namlu kendi mili etrafında döner: mil orijine
  const gun = mergeGeometries(parts.gun).translate(0, -MUZZLE_Y, -GUN_PIVOT_Z);
  return { hull: mergeGeometries(parts.hull), turret: mergeGeometries(parts.turret), gun };
}

/** Kamuflaj desenleri: üç renk lekesi (gövdenin dünya konumuna değil kendi uzayına göre: tankla döner). */
const CAMO: Record<string, [string, string, string] | null> = {
  std: null,
  desert: ["#c9a66b", "#a8834e", "#e2c690"],
  forest: ["#4a5e32", "#2f3d22", "#6f7a45"],
  winter: ["#e8eef2", "#b9c3c9", "#8f9aa1"],
  urban: ["#7d8288", "#4e5358", "#a9adb2"],
  pink: ["#f29ac0", "#d9659a", "#ffd0e3"],
  gold: ["#e8b923", "#b98a12", "#fff0a0"],
};

export class TankView {
  readonly group = new THREE.Group();
  private hull: THREE.Mesh;
  private turret: THREE.Mesh;
  private gun: THREE.Mesh;
  private firedAt = -Infinity;
  private material: THREE.MeshLambertMaterial;
  private loaded = false;
  private tint = new THREE.Color(OLIVE);
  private camo = {
    uCamoOn: { value: 0 },
    uCamoA: { value: new THREE.Color() },
    uCamoB: { value: new THREE.Color() },
    uCamoC: { value: new THREE.Color() },
  };
  /** Savaşta: verisi gelmemiş tank gizlenir. */
  shown = true;
  /** Vurulmuş: kararır (enkaz). */
  dead = false;
  /** Ekranda çizilen (yumuşatılmış) durum. */
  x = 0;
  z = 0;
  h = 0;
  tr = 0;
  el = DEFAULT_ELEV;

  constructor() {
    // Modelde normali içe bakan yüzler var (Blender çift taraflı çizdiği için fark edilmemiş): iki yüz de çizilsin
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    // Kamuflaj: yerel konuma göre değer gürültüsüyle üç renkli leke; paletli yürüyen aksam (koyu) etkilenmez
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.camo);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vCamoP;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCamoP = position;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uCamoOn;
          uniform vec3 uCamoA;
          uniform vec3 uCamoB;
          uniform vec3 uCamoC;
          varying vec3 vCamoP;
          float camoN(vec3 p) {
            vec3 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float n = dot(i, vec3(1.0, 57.0, 113.0));
            vec4 h = fract(sin(vec4(n, n + 1.0, n + 57.0, n + 58.0)) * 43758.5453);
            vec4 h2 = fract(sin(vec4(n + 113.0, n + 114.0, n + 170.0, n + 171.0)) * 43758.5453);
            vec4 m = mix(h, h2, f.z);
            return mix(mix(m.x, m.y, f.x), mix(m.z, m.w, f.x), f.y);
          }`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          if (uCamoOn > 0.5) {
            float lum = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
            float n = camoN(vCamoP * 1.6) * 0.65 + camoN(vCamoP * 3.7 + 7.0) * 0.35;
            vec3 camo = n < 0.42 ? uCamoB : n < 0.6 ? uCamoA : uCamoC;
            // Koyu parçalar (palet, teker) ve çok açıklar (far) olduğu gibi kalır
            float body = smoothstep(0.08, 0.18, lum) * (1.0 - smoothstep(0.75, 0.9, lum));
            diffuseColor.rgb = mix(diffuseColor.rgb, camo * (0.75 + lum * 0.6), body);
          }`,
        );
    };
    material.customProgramCacheKey = () => "tank-camo";
    this.material = material;
    this.hull = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.turret = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.gun = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.gun.position.set(0, MUZZLE_Y, GUN_PIVOT_Z);
    this.turret.add(this.gun);
    for (const m of [this.hull, this.turret, this.gun]) m.castShadow = m.receiveShadow = true;
    this.group.add(this.hull, this.turret);
    this.group.visible = false;
    void sharedModel()
      .then((m) => {
        this.hull.geometry = m.hull;
        this.turret.geometry = m.turret;
        this.gun.geometry = m.gun;
        this.loaded = true;
      })
      .catch((err) => console.warn("[tank]", err));
  }

  /** Ton: modelin renkleriyle çarpılır (varsayılan zeytin; savaşta takım rengi). */
  setTint(color: THREE.ColorRepresentation): void {
    this.tint.set(color);
  }

  /** Kamuflaj (SKINS id; "std" ya da bilinmeyen: düz). Desenliyken takım tonu hafifletilir. */
  setSkin(id: string | null | undefined): void {
    const c = CAMO[id ?? "std"] ?? null;
    this.camo.uCamoOn.value = c ? 1 : 0;
    if (!c) return;
    this.camo.uCamoA.value.set(c[0]);
    this.camo.uCamoB.value.set(c[1]);
    this.camo.uCamoC.value.set(c[2]);
  }

  /** `k` 1: anında (kendi tankı / park), küçükse uzak sürücünün açılarına yumuşakça yaklaşır. */
  set(x: number, z: number, h: number, tr: number, el: number, k = 1): void {
    const lerpAngle = (a: number, b: number) => {
      let d = (b - a) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      return a + d * k;
    };
    this.x = x;
    this.z = z;
    this.h = lerpAngle(this.h, h);
    this.tr = lerpAngle(this.tr, tr);
    this.el += (el - this.el) * k;
  }

  recoil(time: number): void {
    this.firedAt = time;
  }

  update(time: number, moving: number): void {
    // Hareket ederken motor titremesi; ateşte kule geri teper
    this.group.visible = this.loaded && this.shown;
    // Desenliyken takım rengi hafif bir ton olarak kalır (kırmızı/mavi ayırt edilsin)
    if (this.camo.uCamoOn.value) this.material.color.set("#ffffff").lerp(this.tint, 0.35).multiplyScalar(this.dead ? 0.22 : 1);
    else this.material.color.copy(this.tint).multiplyScalar(this.dead ? 0.22 : 1);
    const shake = this.dead ? 0 : moving * 0.015 * Math.sin(time * 40);
    this.group.position.set(this.x, shake, this.z);
    this.group.rotation.y = this.h;
    this.turret.rotation.y = this.tr - this.h;
    const r = (time - this.firedAt) / RECOIL_TIME;
    const kick = r >= 0 && r < 1 ? Math.sin(r * Math.PI) * 0.25 : 0;
    // Geri tepme namluyu kendi ekseninde geri iter; namlu yukarı pozitif (x ekseninde eksi)
    this.gun.rotation.x = -this.el;
    this.gun.position.z = GUN_PIVOT_Z - kick;
  }
}

// ---------------------------------------------------------------------------
// Mermi ve patlama: küçük havuzlar, boştayken görünmez (çizilmez).
// ---------------------------------------------------------------------------

interface Flight {
  shot: Shot;
  start: number;
  mesh: THREE.Mesh;
  done: boolean;
}

interface Blast {
  at: number;
  flash: THREE.Mesh;
  smoke: THREE.Mesh;
}

const BLAST_TIME = 1.1;

let audio: AudioContext | null = null;

/** Gürültü + alçak sinüs: uzaklaştıkça kısılan "bum". `far` 0 yakın … 1 duyulmaz. */
function boom(far: number, big: boolean): void {
  if (far >= 1) return;
  try {
    audio ??= new AudioContext();
  } catch {
    return;
  }
  const ctx = audio;
  void ctx.resume();
  const t0 = ctx.currentTime;
  const vol = (1 - far) ** 2 * (big ? 0.9 : 0.55);
  const len = big ? 1.2 : 0.5;
  const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(big ? 900 : 1800, t0);
  lp.frequency.exponentialRampToValueAtTime(120, t0 + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + len);
  noise.connect(lp).connect(g).connect(ctx.destination);
  noise.start(t0);
  const thump = ctx.createOscillator();
  thump.frequency.setValueAtTime(big ? 75 : 110, t0);
  thump.frequency.exponentialRampToValueAtTime(35, t0 + 0.4);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(vol * 0.9, t0);
  tg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
  thump.connect(tg).connect(ctx.destination);
  thump.start(t0);
  thump.stop(t0 + 0.5);
}

export class ShellFx {
  readonly group = new THREE.Group();
  private flights: Flight[] = [];
  private blasts: Blast[] = [];
  /** Patlama anı: main.ts emoji parçacığı ve savrulma için kullanır. */
  onImpact: (x: number, y: number, z: number, shot: Shot) => void = () => {};

  constructor() {
    const shellGeo = new THREE.SphereGeometry(0.13, 8, 6);
    const shellMat = new THREE.MeshBasicMaterial({ color: "#ffcf70" });
    for (let i = 0; i < 6; i++) this.flights.push({ shot: null!, start: 0, mesh: new THREE.Mesh(shellGeo, shellMat), done: true });
    const flashGeo = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 4; i++) {
      const flash = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ color: "#ff9a3d", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      const smoke = new THREE.Mesh(flashGeo, new THREE.MeshLambertMaterial({ color: "#6f6a62", transparent: true, depthWrite: false, flatShading: true }));
      this.blasts.push({ at: -Infinity, flash, smoke });
    }
    for (const f of this.flights) this.group.add(f.mesh);
    for (const b of this.blasts) this.group.add(b.flash, b.smoke);
    this.group.traverse((o) => (o.visible = o === this.group));
  }

  /** Atış: namlu ağzında parlama ve ses, mermi aynı yayla uçar. `listener`: kameranın konumu. */
  fire(shot: Shot, time: number, listener: THREE.Vector3): void {
    const f = this.flights.find((x) => x.done) ?? this.flights[0];
    Object.assign(f, { shot, start: time, done: false });
    f.mesh.visible = true;
    this.explode(shot.x, shot.y, shot.z, time, 0.35);
    boom(Math.hypot(listener.x - shot.x, listener.z - shot.z) / 70, false);
  }

  private explode(x: number, y: number, z: number, time: number, size = 1): void {
    const b = this.blasts.reduce((a, c) => (c.at < a.at ? c : a));
    b.at = time;
    b.flash.position.set(x, y, z);
    b.smoke.position.set(x, y, z);
    b.flash.userData.size = size;
    b.smoke.userData.y = y;
    b.flash.visible = b.smoke.visible = true;
  }

  update(time: number, listener: THREE.Vector3): void {
    for (const f of this.flights) {
      if (f.done) continue;
      const t = time - f.start;
      if (t >= f.shot.flight) {
        f.done = true;
        f.mesh.visible = false;
        const p = shellAt(f.shot, f.shot.flight);
        const y = Math.max(0.2, p.y);
        this.explode(p.x, y, p.z, time);
        boom(Math.hypot(listener.x - p.x, listener.z - p.z) / 90, true);
        this.onImpact(p.x, y, p.z, f.shot);
        continue;
      }
      const p = shellAt(f.shot, t);
      f.mesh.position.set(p.x, p.y, p.z);
    }
    for (const b of this.blasts) {
      if (!b.flash.visible && !b.smoke.visible) continue;
      const k = (time - b.at) / BLAST_TIME;
      const size = b.flash.userData.size as number;
      if (k >= 1) {
        b.flash.visible = b.smoke.visible = false;
        continue;
      }
      // Parlama hızla büyüyüp söner; duman yavaşça şişip yükselir
      const fk = Math.min(1, k * 6);
      b.flash.scale.setScalar(size * (0.4 + fk * 1.8));
      (b.flash.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - fk) ** 2;
      b.flash.visible = fk < 1;
      b.smoke.scale.setScalar(size * (0.6 + k * 2.2));
      b.smoke.position.y = (b.smoke.userData.y as number) + k * 1.4 * size;
      (b.smoke.material as THREE.MeshLambertMaterial).opacity = 0.55 * (1 - k);
    }
  }
}
