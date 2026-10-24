// Uzaktaki avatarlar 3 draw call: kapsül gövde, isim, gölge (her biri InstancedMesh).
// Yakındakiler chibi karakter olarak çizilir (chibi.ts); onların kapsülü sıfır ölçekle gizlenir.
// İsim billboard'u kameraya vertex shader'da döner ve uzakta solar (CPU'suz LOD).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EMOTES, FLAG_RUNNING, FLAG_SEATED, FLAG_WALKING, vehicleOf } from "../../../shared/constants";
import { postureAt, type Posture } from "../../../shared/mosque";
import type { Look } from "../../../shared/protocol";
import { ATLAS_CELLS, type AvatarAtlas, NAME_GRID } from "./atlas";
import type { ChibiLayer, LimbPose, VolleyPose } from "./chibi";

export const MAX_AVATARS = ATLAS_CELLS;

/** Çizilecek bir avatarın kare başına durumu. */
export interface AvatarView {
  x: number;
  z: number;
  rot: number;
  flags: number;
  alpha: number;
  cell: number;
  color: THREE.Color;
  /** Yürüme sallanması için faz ofseti (avatarlar aynı anda zıplamasın). */
  phase: number;
  /** Son emote (EMOTES indeksi, yoksa -1) ve başladığı an (sn, döngü saati). */
  emote: number;
  emoteAt: number;
  /** Zıplama yüksekliği (m), altındaki yüzeyin üstünden. */
  jumpY: number;
  /** Altındaki yüzeyin yüksekliği (çeşme, bank, tank üstü); yoksa yer. */
  baseY?: number;
  /** Chibi kıyafeti; null/undefined ise varsayılan karakter. */
  outfit?: Look | null;
  /** Zeminden ek yükseklik (sahne). */
  lift?: number;
  /** İkili etkileşim (beşlik/sarılma): başladığı an (sn) ve dönülecek yön. */
  pair?: { kind: "five" | "hug"; at: number; face: number } | null;
  /** Kayarak müdahalenin başladığı an (sn): gövde geriye yatar, ayaklar önde. */
  slide?: number | null;
  /** Çalımın (roulette) başladığı an (sn) ve yanı: oyuncu topun döndüğü yana bir tur döner. */
  trick?: { at: number; side: -1 | 1 } | null;
  /** Karaoke: elde mikrofon. */
  mic?: boolean;
  /** Bilek güreşi: kol öne, masadaki kenetli ele. */
  grip?: boolean;
  /** Voleybol hareketi ve başladığı an (sn): kollar; dalışta gövde öne yere uzanır. */
  vpose?: { kind: VolleyPose; at: number } | null;
  /** Voleybol: havada yatış (yana -1 sol … 1 sağ; öne 1 … geri -1) ve kolların duruşu (topu tutma, smaça hazır). */
  vlean?: number;
  vpitch?: number;
  vstance?: "hold" | "cock" | null;
  /** İsim etiketi gizli (saklambaçta saklananlar). */
  hideName?: boolean;
  /** Avatar çizilmez (birinci şahıs kamerada kendin); gölge ve evcil hayvan kalır. */
  hidden?: boolean;
  /** Namazda: başladığı an (sn, döngü saati; kamette ileri) ve rekât sayısı. Duruşlar shared/mosque.ts akışından. */
  namaz?: { start: number; rekat: number } | null;
  /** Şadırvanda abdest aldığı an (sn): birkaç saniye çömelip ellerini yıkar. */
  abdestAt?: number;
  /** Duruşun ek yan dönüşü (yalnızca debug görünüm denemesi: yandan bakmak için). */
  poseYaw?: number;
  /** Paintball maçında: silah iki elde önde, bakışla kalkar (`pitch` + aşağı); `crouch` 0–1 diz çöker. */
  pb?: { pitch: number; crouch: number } | null;
  /** Yalnızca gövde çizilmez, isim etiketi kalır (Tofaştaki sürücü: kabine sığmaz, etiket tavanın üstünde). */
  bodyHidden?: boolean;
}

/** İkili etkileşim animasyonunun süresi (sn). */
export const PAIR_ANIM = 1.8;

/** Kayarak müdahale pozunun süresi (sn). */
export const SLIDE_ANIM = 0.6;

/** Çalım dönüşünün süresi (sn); top da bu sürede yanından yarım daire çizer. */
export const TRICK_ANIM = 0.55;

/** Voleybol hareketlerinin süresi (sn). */
/** Dalışta gövdenin öne yatışı (yere paralele yakın) ve yatarken gövde kalınlığı kadar kalkış. */
/**
 * Namaz duruşları: gövdenin kalçadan öne yatışı (rad), kalçanın yerden yüksekliği (m), bacak ve kol açıları,
 * kolların içe dönüşü ve gövdenin yana dönüşü (selam). Kalça (paketin 0.525'i × CHIBI_SCALE) yerinde kalır.
 * Chibi kolları dinlenirken A-pozunda (~40° dışa açık): dümdüz aşağı için içe ~0.65, önde birleşmek için ~1.5.
 */
const HIP = 0.525 * 0.72;
interface PrayPose {
  tilt: number;
  hip: number;
  leg: number;
  arm: number;
  roll: number;
  yaw: number;
}
// Oturuş: diz üstü, eller dizlerde (az öne, içe)
const KADE: PrayPose = { tilt: 0.05, hip: 0.2, leg: 0.98, arm: -0.6, roll: 0.95, yaw: 0 };
const PRAY_POSES: Record<Posture | "abdest", PrayPose> = {
  // Tekbir: eller kulak hizasında (yukarı, biraz dışa)
  tekbir: { tilt: 0, hip: HIP, leg: 0, arm: -2.8, roll: -0.55, yaw: 0 },
  // Kıyam: eller göbeğin altında bağlı (kollar az öne, çok içe: önden bakınca kesişir)
  kiyam: { tilt: 0, hip: HIP, leg: 0, arm: -0.95, roll: 1.5, yaw: 0 },
  // Rükû: sırt düz, eller dizlerde
  ruku: { tilt: 1.3, hip: HIP, leg: -1.3, arm: -1.05, roll: 0.65, yaw: 0 },
  kavme: { tilt: 0, hip: HIP, leg: 0, arm: -0.05, roll: 0.65, yaw: 0 },
  // Secde: kalça yukarıda (diz üstü), baş yerde; kollar başın önünde yere
  secde: { tilt: 1.72, hip: 0.42, leg: -1.72, arm: -1.95, roll: 0.7, yaw: 0 },
  celse: KADE,
  kade: KADE,
  // Selam: başla birlikte omuzlar hafifçe sağa, sonra sola
  selamR: { ...KADE, yaw: -0.35 },
  selamL: { ...KADE, yaw: 0.35 },
  abdest: { tilt: 0.45, hip: 0.22, leg: 0.98, arm: -1.3, roll: 1.0, yaw: 0 },
};
const ABDEST_ANIM = 4.5;
const _pose: PrayPose = { tilt: 0, hip: HIP, leg: 0, arm: 0, roll: 0, yaw: 0 };

/**
 * Paintball: silah iki elde önde, bakışla kalkar/iner. Kollar dinlenirken dışa açık durur: öne yataya kaldırılıp
 * ileri eksen etrafında ~155° döndürülünce eller göğsün önünde buluşur (dönüş yukarı-aşağıyı da çevirdiği için
 * bakış aşağıdaysa kol daha çok kalkar: −π/2 − pitch).
 */
const PB_ROLL = 2.7;
const pbArm = (pitch: number) => Math.max(-2.6, Math.min(-0.6, -1.57 - pitch * 0.8));

/** O anki namaz (ya da abdest) duruşu ya da paintballda çömelme; yoksa null. Geçişler yumuşak. */
function prayPose(v: AvatarView, time: number): PrayPose | null {
  let cur: PrayPose | null = null, prev: PrayPose | null = null, k = 1;
  if (v.namaz) {
    const at = postureAt(v.namaz.rekat, time - v.namaz.start);
    if (!at) return v.namaz.start > time ? PRAY_POSES.kiyam : null;
    cur = PRAY_POSES[at.step.posture];
    prev = PRAY_POSES[at.prev];
    k = at.k;
  } else if (v.abdestAt !== undefined && time - v.abdestAt >= 0 && time - v.abdestAt < ABDEST_ANIM) {
    const t = time - v.abdestAt;
    cur = PRAY_POSES.abdest;
    prev = PRAY_POSES.kavme;
    k = Math.min(1, t * 3, (ABDEST_ANIM - t) * 3);
  }
  else if (v.pb && v.pb.crouch > 0.02) {
    // Paintball: diz çöker (topukların üstüne), kollar silahta
    const c = v.pb.crouch;
    Object.assign(_pose, { tilt: 0.1 * c, hip: HIP + (0.27 - HIP) * c, leg: 0.98 * c, arm: pbArm(v.pb.pitch), roll: PB_ROLL, yaw: 0 });
    return _pose;
  }
  if (!cur || !prev) return null;
  for (const key of ["tilt", "hip", "leg", "arm", "roll", "yaw"] as const) _pose[key] = prev[key] + (cur[key] - prev[key]) * k;
  if (v.abdestAt !== undefined && !v.namaz) _pose.arm += Math.sin(time * 9) * 0.25; // el yıkama
  return _pose;
}

const DIVE_TILT = 1.48;
const DIVE_LIFT = 0.16;
export const VPOSE_TIME: Record<VolleyPose, number> = { bump: 0.5, set: 0.55, spike: 0.45, block: 0.9, dive: 0.8 };

/** Emote gövde animasyonlarının süresi (sn). */
const EMOTE_ANIM = { wave: 1.2, hop: 0.45, dance: 2.6 } as const;

const BILLBOARD_VERT = /* glsl */ `
  attribute float aCell;
  attribute float aAlpha;
  uniform vec2 uGrid;
  uniform vec2 uSize;
  uniform vec2 uFade;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float d = -center.z;
    vAlpha = aAlpha * (1.0 - smoothstep(uFade.x, uFade.y, d));
    float col = mod(aCell, uGrid.x);
    float row = floor(aCell / uGrid.x);
    vUv = (vec2(col, uGrid.y - 1.0 - row) + uv) / uGrid;
    gl_Position = projectionMatrix * (center + vec4(position.xy * uSize, 0.0, 0.0));
    if (vAlpha < 0.01 || aCell < 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const NAME_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    if (t.a < 0.02) discard;
    gl_FragColor = vec4(t.rgb, t.a * vAlpha);
    #include <colorspace_fragment>
  }
`;

function billboardMaterial(frag: string, map: THREE.Texture, grid: [number, number], size: [number, number], fade: [number, number]) {
  return new THREE.ShaderMaterial({
    vertexShader: BILLBOARD_VERT,
    fragmentShader: frag,
    uniforms: {
      uMap: { value: map },
      uGrid: { value: new THREE.Vector2(...grid) },
      uSize: { value: new THREE.Vector2(...size) },
      uFade: { value: new THREE.Vector2(...fade) },
    },
    transparent: true,
    depthWrite: false,
  });
}

function bodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, color: number, m: THREE.Matrix4) => {
    const ng = g.toNonIndexed();
    ng.deleteAttribute("uv");
    ng.applyMatrix4(m);
    const c = new THREE.Color(color);
    const arr = new Float32Array(ng.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) c.toArray(arr, i);
    ng.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    parts.push(ng);
  };
  // Beyaz gövde instanceColor ile boyanır; koyu vizör yönü gösterir.
  add(new THREE.CapsuleGeometry(0.32, 0.75, 3, 10), 0xffffff, new THREE.Matrix4().makeTranslation(0, 0.7, 0));
  add(new THREE.BoxGeometry(0.42, 0.16, 0.14), 0x1d2230, new THREE.Matrix4().makeTranslation(0, 1.08, 0.27));
  return mergeGeometries(parts);
}

function shadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(0,0,0,0.45)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const NAME_Y = 1.9;
/** Otururken gövde kayması: kapsül bacaksız olduğu için iner; chibi kalçası bank yüzeyine (≈0.5 m) çıkar. */
const SEAT_DROP = 0.32;
export const CHIBI_SEAT_LIFT = 0.29;

/** Avatarın çizildiği yükseklik (konuşma balonu gibi üstüne konanlar için; chibi duruşu). */
export function bodyY(v: AvatarView): number {
  return (v.baseY ?? 0) + v.jumpY + (v.flags & FLAG_SEATED ? CHIBI_SEAT_LIFT : 0);
}
/** Gizlenecek kapsül için sıfır ölçek. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class AvatarRenderer {
  readonly group = new THREE.Group();
  private body: THREE.InstancedMesh;
  private name: THREE.InstancedMesh;
  private shadow: THREE.InstancedMesh;
  private nameCell: THREE.InstancedBufferAttribute;
  private nameAlpha: THREE.InstancedBufferAttribute;

  // Kare başına allocation yapmamak için tekrar kullanılan nesneler.
  private m = new THREE.Matrix4();
  private pos = new THREE.Vector3();
  private quat = new THREE.Quaternion();
  private scl = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private tilt = new THREE.Quaternion();
  private xAxis = new THREE.Vector3(1, 0, 0);
  private zAxis = new THREE.Vector3(0, 0, 1);
  private count = 0;
  private limbs: LimbPose = { swing: 0, seated: false, wave: 0, dance: 0, hug: 0, pedal: 0, mic: 0, grip: 0, time: 0 };

  constructor(
    atlas: AvatarAtlas,
    private chibi: ChibiLayer | null = null,
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);

    this.body = new THREE.InstancedMesh(bodyGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), MAX_AVATARS);
    this.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_AVATARS * 3).fill(1), 3);

    const nameGeo = quad.clone();
    this.nameCell = new THREE.InstancedBufferAttribute(new Float32Array(MAX_AVATARS), 1);
    this.nameAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_AVATARS), 1);
    nameGeo.setAttribute("aCell", this.nameCell);
    nameGeo.setAttribute("aAlpha", this.nameAlpha);
    this.name = new THREE.InstancedMesh(nameGeo, billboardMaterial(NAME_FRAG, atlas.nameTex, NAME_GRID, [1.6, 0.4], [14, 20]), MAX_AVATARS);
    this.name.renderOrder = 2;

    const shadowGeo = quad.clone().rotateX(-Math.PI / 2);
    this.shadow = new THREE.InstancedMesh(
      shadowGeo,
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }),
      MAX_AVATARS,
    );
    this.shadow.renderOrder = 1;

    for (const mesh of [this.body, this.name, this.shadow]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Örnek konumları her kare değişir; three'nin tek seferlik bounding sphere'i yanlış kırpar.
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
    }
  }

  /** Kare başı; kamera konumu yakındakileri chibi çizmek için. */
  begin(camera?: THREE.Vector3): void {
    this.count = 0;
    if (camera) this.chibi?.begin(camera);
  }

  /** `self`: kendi avatarın, uzaklıktan bağımsız her zaman chibi. */
  push(v: AvatarView, time: number, self = false): void {
    if (this.count >= MAX_AVATARS || v.alpha <= 0.01) return;
    const i = this.count++;
    // Araçta: bisiklet ve kayıkta oturur (bisiklette pedal), kaykayda ayakta kayar
    const vehicle = vehicleOf(v.flags);
    const moving = (v.flags & FLAG_WALKING) !== 0;
    const seated = (v.flags & FLAG_SEATED) !== 0 || vehicle === 1 || vehicle === 3;
    const airborne = v.jumpY > 0;
    const walking = moving && !seated && !airborne && vehicle === 0;
    // Koşarken adımlar sıklaşır ve sallanma artar.
    const running = walking && (v.flags & FLAG_RUNNING) !== 0;
    const stepHz = running ? 14 : 9;
    const bob = walking ? Math.abs(Math.sin(time * stepHz + v.phase)) * (running ? 0.13 : 0.09) : 0;
    const sway = walking ? Math.sin(time * stepHz + v.phase) * (running ? 0.1 : 0.06) : 0;
    // Emote: dans döner, el sallama yana yatar, diğerleri zıplar.
    let spin = 0, lean = 0, hop = 0, wave = 0, dance = 0, hug = 0;
    let rot = v.rot;
    const et = time - v.emoteAt;
    if (v.emote >= 0 && et >= 0) {
      const anim = EMOTES[v.emote].anim;
      if (et < EMOTE_ANIM[anim]) {
        // Kol kalkıp inerken yumuşak zarf (chibi kolları için)
        const env = Math.min(1, et * 6, (EMOTE_ANIM[anim] - et) * 6);
        if (anim === "dance") {
          // Ortak saat: aynı anda dans edenler birlikte döner ve zıplar (senkron dans)
          spin = time * 6;
          hop = Math.abs(Math.sin(time * 8)) * 0.16;
          dance = env;
        } else if (anim === "wave") {
          lean = Math.sin(et * 14) * 0.2 * (1 - et / EMOTE_ANIM.wave);
          wave = env;
        } else {
          hop = Math.sin((et / EMOTE_ANIM.hop) * Math.PI) * 0.32;
        }
      }
    }
    // Beşlik: karşıya dönüp sağ el yukarı, vuruş anında küçük zıplama • sarılma: kollar öne, hafif eğilme
    const pt = v.pair ? time - v.pair.at : -1;
    if (v.pair && pt >= 0 && pt < PAIR_ANIM) {
      const env = Math.min(1, pt * 5, (PAIR_ANIM - pt) * 5);
      rot = v.pair.face;
      spin = 0;
      if (v.pair.kind === "five") {
        wave = env;
        hop = Math.max(hop, Math.max(0, Math.sin(((pt - 0.35) / 0.3) * Math.PI)) * 0.18 * (pt > 0.35 && pt < 0.65 ? 1 : 0));
      } else {
        hug = env;
        lean = 0;
      }
    }
    // Araç yüksekliği (oturuşa göre): bisiklet selesi, kaykay tahtası, kayıkta su üstünde sallanma
    const ride = vehicle === 1 ? 0.3 : vehicle === 2 ? 0.14 : vehicle === 3 ? -0.12 + Math.sin(time * 1.7 + v.phase) * 0.04 : 0;
    const base = (v.baseY ?? 0) + bob + hop + v.jumpY + (v.lift ?? 0) + ride;
    // Araçta oturuş aracın yüksekliğinde; bankta/koltukta oturuş yüzey yüksekliğine göre
    let y = base + (seated && !vehicle ? CHIBI_SEAT_LIFT : 0);
    // Belirip kaybolurken alfa yerine ölçek: gövde opak kalır, sıralama sorunu olmaz.
    const s = v.alpha < 1 ? 0.3 + 0.7 * v.alpha : 1;

    // Çalım: topun döndüğü yana bir tur (yumuşak başlayıp biter)
    const tt = v.trick ? time - v.trick.at : -1;
    if (v.trick && tt >= 0 && tt < TRICK_ANIM) {
      const u = tt / TRICK_ANIM;
      spin = -v.trick.side * Math.PI * 2 * (u * u * (3 - 2 * u));
    }
    this.quat.setFromAxisAngle(this.up, rot + spin);
    if (sway !== 0) this.quat.multiply(this.tilt.setFromAxisAngle(this.xAxis, sway * 0.5));
    if (lean !== 0) this.quat.multiply(this.tilt.setFromAxisAngle(this.zAxis, lean));
    if (hug > 0) this.quat.multiply(this.tilt.setFromAxisAngle(this.xAxis, 0.18 * hug));
    // Kayarak müdahale: ayaklar önde, gövde geriye yatar
    const st = v.slide != null ? time - v.slide : -1;
    if (st >= 0 && st < SLIDE_ANIM) this.quat.multiply(this.tilt.setFromAxisAngle(this.xAxis, -1.15 * Math.min(1, st * 12, (SLIDE_ANIM - st) * 5)));
    // Voleybol: hareketin ağırlığı (hızla girer, sonda çıkar); dalışta gövde öne yatar
    const vp = v.vpose, vt = vp ? time - vp.at : -1, vd = vp ? VPOSE_TIME[vp.kind] : 0;
    const vw = vp && vt >= 0 && vt < vd ? Math.min(1, vt * 14, (vd - vt) * 6) : 0;
    if (vp?.kind === "dive" && vw > 0) {
      // Dalış: gövde yere boylu boyunca yatar (ayaklardan döner, göğüs yere değer), kollar başın önünde ileri
      this.quat.multiply(this.tilt.setFromAxisAngle(this.xAxis, DIVE_TILT * vw));
      y += DIVE_LIFT * vw;
    }
    if (v.vpitch) this.quat.multiply(this.tilt.setFromAxisAngle(this.xAxis, 0.38 * v.vpitch));
    if (v.vlean) this.quat.multiply(this.tilt.setFromAxisAngle(this.zAxis, 0.55 * v.vlean));
    // Kaykayda yana duruş ve hafif yatış
    if (vehicle === 2) this.quat.multiply(this.tilt.setFromAxisAngle(this.zAxis, moving ? Math.sin(time * 2.2 + v.phase) * 0.08 : 0));
    // Namaz/abdest: gövde kalçadan yatar (kalça yerinde kalacak şekilde ötelenir), selamda yana döner
    const pray = prayPose(v, time);
    let px = v.x, pz = v.z;
    if (pray) {
      const yawed = v.rot + pray.yaw + (v.poseYaw ?? 0);
      this.quat.setFromAxisAngle(this.up, yawed).multiply(this.tilt.setFromAxisAngle(this.xAxis, pray.tilt));
      const oz = -HIP * Math.sin(pray.tilt);
      px += Math.sin(yawed) * oz;
      pz += Math.cos(yawed) * oz;
      y = (v.baseY ?? 0) + pray.hip - HIP * Math.cos(pray.tilt);
    }
    this.pos.set(px, y, pz);
    this.scl.set(s, s, s);
    this.m.compose(this.pos, this.quat, this.scl);
    const l = this.limbs;
    l.swing = walking ? Math.sin(time * stepHz + v.phase) * (running ? 0.75 : 0.5) : 0;
    l.seated = seated;
    l.wave = wave;
    l.dance = dance;
    l.hug = hug;
    l.pedal = vehicle === 1 && moving ? 11 : 0;
    l.mic = v.mic ? 1 : 0;
    l.grip = v.grip ? 1 : 0;
    l.vkind = vw > 0 ? vp!.kind : undefined;
    l.vw = vw;
    l.vu = vd ? Math.min(1, vt / vd) : 0;
    l.vstance = v.vstance ?? undefined;
    l.pray = pray ? { leg: pray.leg, arm: pray.arm, roll: pray.roll } : undefined;
    l.aim = v.pb && !pray ? { arm: pbArm(v.pb.pitch), roll: PB_ROLL } : undefined;
    if (pray) l.seated = false;
    l.time = time;
    const asChibi = !v.hidden && !v.bodyHidden && (this.chibi?.place(v.outfit, px, pz, this.m, l, self) ?? false);
    if (seated && !vehicle && !asChibi && !v.bodyHidden) {
      y = base - SEAT_DROP;
      this.m.elements[13] = y;
    }
    this.body.setMatrixAt(i, asChibi || v.hidden || v.bodyHidden ? HIDDEN : this.m);
    this.body.setColorAt(i, v.color);

    this.m.makeTranslation(v.x, y + NAME_Y * s + (vehicle === 1 ? 0.25 : 0), v.z);
    this.name.setMatrixAt(i, this.m);
    // Havadayken gölge küçülür: yükseklik hissi.
    const sh = 0.95 * s * Math.max(0.45, 1 - v.jumpY * 0.45);
    this.m.makeScale(sh, 1, sh).setPosition(v.x, Math.max(0, v.baseY ?? 0) + (v.lift ?? 0) + 0.04, v.z);
    this.shadow.setMatrixAt(i, this.m);

    this.nameCell.setX(i, v.cell);
    this.nameAlpha.setX(i, v.hideName || v.hidden ? 0 : v.alpha);
  }

  end(): void {
    const n = this.count;
    this.chibi?.end();
    for (const mesh of [this.body, this.name, this.shadow]) {
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.body.instanceColor!.clearUpdateRanges();
    this.body.instanceColor!.addUpdateRange(0, n * 3);
    this.body.instanceColor!.needsUpdate = true;
    for (const a of [this.nameCell, this.nameAlpha]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n);
      a.needsUpdate = true;
    }
  }
}

/** Kullanıcı id'sinden sabit, doygun bir gövde rengi. */
export function colorFor(id: string): THREE.Color {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return new THREE.Color().setHSL(((h >>> 0) % 360) / 360, 0.55, 0.55);
}
