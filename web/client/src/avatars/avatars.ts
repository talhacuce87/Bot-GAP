// Tüm avatarlar 4 draw call: gövde, yüz, isim, gölge. Her biri InstancedMesh.
// Yüz/isim billboard'ları kameraya vertex shader'da döner ve uzakta solar (CPU'suz LOD).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EMOTES, FLAG_RUNNING, FLAG_SEATED, FLAG_WALKING } from "../../../shared/constants";
import { ATLAS_CELLS, type AvatarAtlas, FACE_GRID, NAME_GRID } from "./atlas";

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
  /** Zıplama yüksekliği (m). */
  jumpY: number;
}

/** Emote gövde animasyonlarının süresi (sn). */
const EMOTE_ANIM = { wave: 1.2, hop: 0.45, dance: 2.6 } as const;

const BILLBOARD_VERT = /* glsl */ `
  attribute float aCell;
  attribute float aAlpha;
  uniform vec2 uGrid;
  uniform vec2 uSize;
  uniform vec2 uFade;
  varying vec2 vUv;
  varying vec2 vLocal;
  varying float vAlpha;
  void main() {
    vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float d = -center.z;
    vAlpha = aAlpha * (1.0 - smoothstep(uFade.x, uFade.y, d));
    float col = mod(aCell, uGrid.x);
    float row = floor(aCell / uGrid.x);
    vUv = (vec2(col, uGrid.y - 1.0 - row) + uv) / uGrid;
    vLocal = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * (center + vec4(position.xy * uSize, 0.0, 0.0));
    if (vAlpha < 0.01 || aCell < 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const FACE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec2 vLocal;
  varying float vAlpha;
  void main() {
    float r = length(vLocal);
    if (r > 1.0) discard;
    vec3 c = r > 0.86 ? vec3(1.0) : texture2D(uMap, vUv).rgb;
    gl_FragColor = vec4(c, vAlpha);
    #include <colorspace_fragment>
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

const FACE_Y = 1.78;
const NAME_Y = 2.3;
const SEAT_DROP = 0.32;

export class AvatarRenderer {
  readonly group = new THREE.Group();
  private body: THREE.InstancedMesh;
  private face: THREE.InstancedMesh;
  private name: THREE.InstancedMesh;
  private shadow: THREE.InstancedMesh;
  private faceCell: THREE.InstancedBufferAttribute;
  private faceAlpha: THREE.InstancedBufferAttribute;
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

  constructor(atlas: AvatarAtlas) {
    const quad = new THREE.PlaneGeometry(1, 1);

    this.body = new THREE.InstancedMesh(bodyGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), MAX_AVATARS);
    this.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_AVATARS * 3).fill(1), 3);

    const faceGeo = quad.clone();
    this.faceCell = new THREE.InstancedBufferAttribute(new Float32Array(MAX_AVATARS), 1);
    this.faceAlpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_AVATARS), 1);
    faceGeo.setAttribute("aCell", this.faceCell);
    faceGeo.setAttribute("aAlpha", this.faceAlpha);
    this.face = new THREE.InstancedMesh(faceGeo, billboardMaterial(FACE_FRAG, atlas.faceTex, FACE_GRID, [0.62, 0.62], [22, 30]), MAX_AVATARS);

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

    for (const mesh of [this.body, this.face, this.name, this.shadow]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Örnek konumları her kare değişir; three'nin tek seferlik bounding sphere'i yanlış kırpar.
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
    }
  }

  begin(): void {
    this.count = 0;
  }

  push(v: AvatarView, time: number): void {
    if (this.count >= MAX_AVATARS || v.alpha <= 0.01) return;
    const i = this.count++;
    const seated = (v.flags & FLAG_SEATED) !== 0;
    const airborne = v.jumpY > 0;
    const walking = (v.flags & FLAG_WALKING) !== 0 && !seated && !airborne;
    // Koşarken adımlar sıklaşır ve sallanma artar.
    const running = walking && (v.flags & FLAG_RUNNING) !== 0;
    const stepHz = running ? 14 : 9;
    const bob = walking ? Math.abs(Math.sin(time * stepHz + v.phase)) * (running ? 0.13 : 0.09) : 0;
    const sway = walking ? Math.sin(time * stepHz + v.phase) * (running ? 0.1 : 0.06) : 0;
    // Emote: dans döner, el sallama yana yatar, diğerleri zıplar.
    let spin = 0, lean = 0, hop = 0;
    const et = time - v.emoteAt;
    if (v.emote >= 0 && et >= 0) {
      const anim = EMOTES[v.emote].anim;
      if (et < EMOTE_ANIM[anim]) {
        if (anim === "dance") {
          spin = et * 6;
          hop = Math.abs(Math.sin(et * 8)) * 0.16;
        } else if (anim === "wave") {
          lean = Math.sin(et * 14) * 0.2 * (1 - et / EMOTE_ANIM.wave);
        } else {
          hop = Math.sin((et / EMOTE_ANIM.hop) * Math.PI) * 0.32;
        }
      }
    }
    const y = (seated ? -SEAT_DROP : 0) + bob + hop + v.jumpY;
    // Belirip kaybolurken alfa yerine ölçek: gövde opak kalır, sıralama sorunu olmaz.
    const s = v.alpha < 1 ? 0.3 + 0.7 * v.alpha : 1;

    this.quat.setFromAxisAngle(this.up, v.rot + spin);
    if (sway !== 0) this.quat.multiply(this.tilt.setFromAxisAngle(this.xAxis, sway * 0.5));
    if (lean !== 0) this.quat.multiply(this.tilt.setFromAxisAngle(this.zAxis, lean));
    this.pos.set(v.x, y, v.z);
    this.scl.set(s, s, s);
    this.m.compose(this.pos, this.quat, this.scl);
    this.body.setMatrixAt(i, this.m);
    this.body.setColorAt(i, v.color);

    this.m.makeTranslation(v.x, y + FACE_Y * s, v.z);
    this.face.setMatrixAt(i, this.m);
    this.m.makeTranslation(v.x, y + NAME_Y * s, v.z);
    this.name.setMatrixAt(i, this.m);
    // Havadayken gölge küçülür: yükseklik hissi.
    const sh = 0.95 * s * Math.max(0.45, 1 - v.jumpY * 0.45);
    this.m.makeScale(sh, 1, sh).setPosition(v.x, 0.04, v.z);
    this.shadow.setMatrixAt(i, this.m);

    this.faceCell.setX(i, v.cell);
    this.nameCell.setX(i, v.cell);
    this.faceAlpha.setX(i, v.alpha);
    this.nameAlpha.setX(i, v.alpha);
  }

  end(): void {
    const n = this.count;
    for (const mesh of [this.body, this.face, this.name, this.shadow]) {
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.body.instanceColor!.clearUpdateRanges();
    this.body.instanceColor!.addUpdateRange(0, n * 3);
    this.body.instanceColor!.needsUpdate = true;
    for (const a of [this.faceCell, this.faceAlpha, this.nameCell, this.nameAlpha]) {
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
