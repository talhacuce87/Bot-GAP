// Emote efekti: avatarın başından yükselip solan emoji billboard'ları.
// Hepsi tek InstancedMesh; konum/zaman örnek başına bir kez yazılır, animasyon vertex shader'da.
import * as THREE from "three";
import { EMOTES } from "../../../shared/constants";
import { timeUniform } from "../world/geo";

const POOL = 64;
const PER_EMOTE = 3;
const DURATION = 1.8;
const GRID: [number, number] = [4, 4]; // 512×512 atlas, 128px hücre

/** Emote'lardan sonraki hücreler: etkileşim efektleri. */
export const FX_CELL = { skewer: EMOTES.length, tomato: EMOTES.length + 1, tea: EMOTES.length + 2, splat: EMOTES.length + 3 };
const FX_EMOJI = ["🍢", "🍅", "🍵", "💥"];
const CELL = 128;
/** Emoji isim etiketinin üstünden çıkar: yüzü ve ismi kapatmasın. */
const HEAD_Y = 2.6;

let sharedAtlas: THREE.CanvasTexture | null = null;

function atlas(): THREE.CanvasTexture {
  sharedAtlas ??= drawAtlas();
  return sharedAtlas;
}

function drawAtlas(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = GRID[0] * CELL;
  c.height = GRID[1] * CELL;
  const g = c.getContext("2d")!;
  g.textAlign = "center";
  g.textBaseline = "middle";
  // Renkli emoji yazı tipleri: Windows, macOS, Android ve Linux'ta yaygın olanlar.
  g.font = `${CELL * 0.78}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
  [...EMOTES.map((e) => e.emoji), ...FX_EMOJI].forEach((emoji, i) => {
    g.fillText(emoji, (i % GRID[0]) * CELL + CELL / 2, Math.floor(i / GRID[0]) * CELL + CELL / 2 + 6);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const VERT = /* glsl */ `
  attribute float aCell;
  attribute float aStart;
  attribute vec2 aDrift;
  uniform float uTime;
  uniform vec2 uGrid;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float t = (uTime - aStart) / ${DURATION.toFixed(2)};
    vec3 p = vec3(aDrift.x * t + sin(t * 9.0 + aStart * 7.0) * 0.08, t * 1.5, aDrift.y * t);
    vec4 center = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    float size = 0.55 * (0.4 + 0.8 * smoothstep(0.0, 0.12, t) - 0.2 * smoothstep(0.12, 0.3, t));
    vAlpha = 1.0 - smoothstep(0.65, 1.0, t);
    float col = mod(aCell, uGrid.x);
    float row = floor(aCell / uGrid.x);
    vUv = (vec2(col, uGrid.y - 1.0 - row) + uv) / uGrid;
    gl_Position = projectionMatrix * (center + vec4(position.xy * size, 0.0, 0.0));
    if (t < 0.0 || t > 1.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    if (c.a * vAlpha < 0.02) discard;
    gl_FragColor = vec4(c.rgb, c.a * vAlpha);
    #include <colorspace_fragment>
  }
`;

export class EmoteFx {
  readonly mesh: THREE.InstancedMesh;
  private cell: THREE.InstancedBufferAttribute;
  private start: THREE.InstancedBufferAttribute;
  private drift: THREE.InstancedBufferAttribute;
  private next = 0;
  private m = new THREE.Matrix4();

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.cell = new THREE.InstancedBufferAttribute(new Float32Array(POOL), 1);
    this.start = new THREE.InstancedBufferAttribute(new Float32Array(POOL).fill(-100), 1);
    this.drift = new THREE.InstancedBufferAttribute(new Float32Array(POOL * 2), 2);
    geo.setAttribute("aCell", this.cell);
    geo.setAttribute("aStart", this.start);
    geo.setAttribute("aDrift", this.drift);
    this.mesh = new THREE.InstancedMesh(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uTime: timeUniform, uMap: { value: atlas() }, uGrid: { value: new THREE.Vector2(...GRID) } },
        transparent: true,
        depthWrite: false,
      }),
      POOL,
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  /** Bir emote patlaması: birkaç emoji, hafif dağılarak yükselir. `lift`: zemin üstü çıkış yüksekliği. */
  emit(x: number, y: number, z: number, emote: number, time: number, lift = HEAD_Y, count = PER_EMOTE): void {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % POOL;
      this.m.makeTranslation(x, y + lift, z);
      this.mesh.setMatrixAt(i, this.m);
      this.cell.setX(i, emote);
      this.start.setX(i, time + k * 0.12);
      const a = Math.random() * Math.PI * 2;
      this.drift.setXY(i, Math.cos(a) * 0.5, Math.sin(a) * 0.5);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cell.needsUpdate = this.start.needsUpdate = this.drift.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Fırlatılan nesneler (çay, domates): A'dan B'ye yay çizer, düşünce patlama.
// ---------------------------------------------------------------------------

const THROW_POOL = 16;
const FLIGHT = 0.9;

const THROW_VERT = /* glsl */ `
  attribute vec3 aFrom;
  attribute vec3 aTo;
  attribute float aStart;
  attribute float aCell;
  uniform float uTime;
  uniform vec2 uGrid;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float t = (uTime - aStart) / ${FLIGHT.toFixed(2)};
    vec3 p = mix(aFrom, aTo, t) + vec3(0.0, sin(t * 3.14159) * 2.4, 0.0);
    vec4 center = modelViewMatrix * vec4(p, 1.0);
    float col = mod(aCell, uGrid.x);
    float row = floor(aCell / uGrid.x);
    vUv = (vec2(col, uGrid.y - 1.0 - row) + uv) / uGrid;
    vAlpha = 1.0;
    gl_Position = projectionMatrix * (center + vec4(position.xy * 0.5, 0.0, 0.0));
    if (t < 0.0 || t > 1.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

interface Landing {
  at: number;
  x: number;
  y: number;
  z: number;
  cell: number;
}

export class ThrowFx {
  readonly mesh: THREE.InstancedMesh;
  private from: THREE.InstancedBufferAttribute;
  private to: THREE.InstancedBufferAttribute;
  private start: THREE.InstancedBufferAttribute;
  private cell: THREE.InstancedBufferAttribute;
  private next = 0;
  private landings: Landing[] = [];

  constructor(private burst: EmoteFx) {
    // Emoji efektiyle aynı yol (InstancedMesh); konumlar örnek matrisinden değil özniteliklerden gelir.
    const geo = new THREE.PlaneGeometry(1, 1);
    this.from = new THREE.InstancedBufferAttribute(new Float32Array(THROW_POOL * 3), 3);
    this.to = new THREE.InstancedBufferAttribute(new Float32Array(THROW_POOL * 3), 3);
    this.start = new THREE.InstancedBufferAttribute(new Float32Array(THROW_POOL).fill(-100), 1);
    this.cell = new THREE.InstancedBufferAttribute(new Float32Array(THROW_POOL), 1);
    geo.setAttribute("aFrom", this.from);
    geo.setAttribute("aTo", this.to);
    geo.setAttribute("aStart", this.start);
    geo.setAttribute("aCell", this.cell);
    this.mesh = new THREE.InstancedMesh(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: THROW_VERT,
        fragmentShader: FRAG,
        uniforms: { uTime: timeUniform, uMap: { value: atlas() }, uGrid: { value: new THREE.Vector2(...GRID) } },
        transparent: true,
        depthWrite: false,
      }),
      THROW_POOL,
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  launch(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, cell: number, time: number, splat: number): void {
    const i = this.next;
    this.next = (this.next + 1) % THROW_POOL;
    this.from.setXYZ(i, fx, fy, fz);
    this.to.setXYZ(i, tx, ty, tz);
    this.start.setX(i, time);
    this.cell.setX(i, cell);
    this.from.needsUpdate = this.to.needsUpdate = this.start.needsUpdate = this.cell.needsUpdate = true;
    this.landings.push({ at: time + FLIGHT, x: tx, y: ty, z: tz, cell: splat });
  }

  /** Düşen nesneler için patlama; kare başına yalnızca bekleyen varsa iş yapar. */
  update(time: number): void {
    if (!this.landings.length) return;
    for (let k = this.landings.length - 1; k >= 0; k--) {
      const l = this.landings[k];
      if (time < l.at) continue;
      this.burst.emit(l.x, l.y, l.z, l.cell, time, 0.2, 2);
      this.landings.splice(k, 1);
    }
  }
}
