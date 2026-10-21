// Uzaktaki avatarlar 3 draw call: kapsül gövde, isim, gölge (her biri InstancedMesh).
// Yakındakiler chibi karakter olarak çizilir (chibi.ts); onların kapsülü sıfır ölçekle gizlenir.
// İsim billboard'u kameraya vertex shader'da döner ve uzakta solar (CPU'suz LOD).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EMOTES, FLAG_RUNNING, FLAG_SEATED, FLAG_WALKING, vehicleOf } from "../../../shared/constants";
import type { Look } from "../../../shared/protocol";
import { ATLAS_CELLS, type AvatarAtlas, NAME_GRID } from "./atlas";
import type { ChibiLayer, LimbPose } from "./chibi";

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
  /** Karaoke: elde mikrofon. */
  mic?: boolean;
  /** İsim etiketi gizli (saklambaçta saklananlar). */
  hideName?: boolean;
  /** Avatar çizilmez (birinci şahıs kamerada kendin); gölge ve evcil hayvan kalır. */
  hidden?: boolean;
}

/** İkili etkileşim animasyonunun süresi (sn). */
export const PAIR_ANIM = 1.8;

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
  private limbs: LimbPose = { swing: 0, seated: false, wave: 0, dance: 0, hug: 0, pedal: 0, mic: 0, time: 0 };

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

    this.quat.setFromAxisAngle(this.up, rot + spin);
    if (sway !== 0) this.quat.multiply(this.tilt.setFromAxisAngle(this.xAxis, sway * 0.5));
    if (lean !== 0) this.quat.multiply(this.tilt.setFromAxisAngle(this.zAxis, lean));
    if (hug > 0) this.quat.multiply(this.tilt.setFromAxisAngle(this.xAxis, 0.18 * hug));
    // Kaykayda yana duruş ve hafif yatış
    if (vehicle === 2) this.quat.multiply(this.tilt.setFromAxisAngle(this.zAxis, moving ? Math.sin(time * 2.2 + v.phase) * 0.08 : 0));
    this.pos.set(v.x, y, v.z);
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
    l.time = time;
    const asChibi = !v.hidden && (this.chibi?.place(v.outfit, v.x, v.z, this.m, l, self) ?? false);
    if (seated && !vehicle && !asChibi) {
      y = base - SEAT_DROP;
      this.m.elements[13] = y;
    }
    this.body.setMatrixAt(i, asChibi || v.hidden ? HIDDEN : this.m);
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
