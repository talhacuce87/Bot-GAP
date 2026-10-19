// Emote efekti: avatarın başından yükselip solan emoji billboard'ları.
// Hepsi tek InstancedMesh; konum/zaman örnek başına bir kez yazılır, animasyon vertex shader'da.
import * as THREE from "three";
import { EMOTES } from "../../../shared/constants";
import { timeUniform } from "../world/geo";

const POOL = 64;
const PER_EMOTE = 3;
const DURATION = 1.8;
const GRID: [number, number] = [4, 2]; // 512×256 atlas, 128px hücre
const CELL = 128;
/** Emoji başın biraz üstünden çıkar (isim etiketinin hemen altı). */
const HEAD_Y = 2.0;

function atlas(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = GRID[0] * CELL;
  c.height = GRID[1] * CELL;
  const g = c.getContext("2d")!;
  g.textAlign = "center";
  g.textBaseline = "middle";
  // Renkli emoji yazı tipleri: Windows, macOS, Android ve Linux'ta yaygın olanlar.
  g.font = `${CELL * 0.78}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
  EMOTES.forEach((em, i) => {
    g.fillText(em.emoji, (i % GRID[0]) * CELL + CELL / 2, Math.floor(i / GRID[0]) * CELL + CELL / 2 + 6);
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

  /** Bir emote patlaması: birkaç emoji, hafif dağılarak yükselir. */
  emit(x: number, y: number, z: number, emote: number, time: number): void {
    for (let k = 0; k < PER_EMOTE; k++) {
      const i = this.next;
      this.next = (this.next + 1) % POOL;
      this.m.makeTranslation(x, y + HEAD_Y, z);
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
