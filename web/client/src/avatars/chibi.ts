// Yakındaki avatarlar chibi karakter olarak çizilir; uzaktakiler (ve paket inmeden önce) kapsül kalır.
// Avatar başına 2 draw call (gövde + kontur). Kıyafet geometrisi kıyafet anahtarıyla önbelleğe alınır,
// aynı kıyafeti giyenler aynı geometriyi paylaşır. Kol/bacak dönüşü vertex shader'da (aLimb).
import * as THREE from "three";
import type { Look } from "../../../shared/protocol";
import { type ChibiManifest, ChibiPack, LIMB_COUNT, lookKey } from "./chibiPack";

/** Paket ~2.2 m boyunda; dünya kapsül avatarlara göre ölçekli (oturaklar, kapılar). */
export const CHIBI_SCALE = 0.72;
/** Kare başına en fazla bu kadar yeni kıyafet geometrisi kurulur (takılma olmasın). */
const BUILDS_PER_FRAME = 2;
const CACHE_MAX = 64;
const OUTLINE_WIDTH = 0.012;
/**
 * Kontur kabuğu kameradan bu kadar (m) geri itilir: siluette görünür ama kafa derisine yakın saç
 * tutamlarını (ya da gövdeye yakın parçaları) önden örtmez.
 */
const OUTLINE_PUSH = 0.03;
/** Kontur bu mesafeden uzakta çizilmez (üçgen sayısını ikiye katlıyor, uzakta fark edilmiyor). */
const OUTLINE_RADIUS = 15;

/** Uzuv açıları (radyan): x ekseni öne/arkaya sallama, z ekseni yana kaldırma. */
export interface LimbPose {
  /** Yürürken kol/bacak salınımı; + sağ kol ve sol bacak öne. */
  swing: number;
  seated: boolean;
  /** 0..1 sağ kolu yukarı kaldırma (el sallama). */
  wave: number;
  /** Dansta iki kol yukarıda sallanır. */
  dance: number;
  /** 0..1 sarılma: iki kol öne. */
  hug: number;
  /** Bisiklette pedal çevirme (oturur, bacaklar sırayla). */
  pedal: number;
  /** 0..1 sağ el ağza (karaoke mikrofonu). */
  mic: number;
  time: number;
}

const LIMB_GLSL = /* glsl */ `
  attribute float aLimb;
  attribute float aOutline;
  uniform vec2 uLimbA[${LIMB_COUNT}];
  uniform vec3 uPivot[${LIMB_COUNT}];
  mat3 limbMat(int i) {
    vec2 a = uLimbA[i];
    float cx = cos(a.x), sx = sin(a.x), cz = cos(a.y), sz = sin(a.y);
    mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
    mat3 rz = mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
    return rz * rx;
  }
`;

function patch(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: Record<string, THREE.IUniform>, outline: boolean): void {
  Object.assign(shader.uniforms, uniforms);
  // beginnormal_vertex MeshBasicMaterial'da koşullu (envmap/skinning yoksa hiç yok); bu yüzden
  // konum ve kontur begin_vertex'te kendi uzuv matrisini hesaplar, normal ayrıca döndürülür.
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${LIMB_GLSL}`)
    .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\nobjectNormal = limbMat(int(aLimb + 0.5)) * objectNormal;`)
    .replace(
      "#include <begin_vertex>",
      `int li = int(aLimb + 0.5);
       mat3 lm = limbMat(li);
       vec3 transformed = lm * (position - uPivot[li]) + uPivot[li];` +
        (outline ? `\ntransformed += normalize(lm * normal) * (${(OUTLINE_WIDTH / CHIBI_SCALE).toFixed(4)} * aOutline);` : ""),
    );
  if (outline) {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>\nmvPosition.z -= ${OUTLINE_PUSH.toFixed(3)};\ngl_Position = projectionMatrix * mvPosition;`,
    );
  }
}

interface Slot {
  mesh: THREE.Mesh;
  outline: THREE.Mesh;
  angles: THREE.Vector2[];
  key: string;
}

interface CacheEntry {
  geo: THREE.BufferGeometry;
  usedAt: number;
}

export class ChibiLayer {
  readonly group = new THREE.Group();
  pack: ChibiPack | null = null;
  private slots: Slot[] = [];
  private used = 0;
  private builds = 0;
  private frame = 0;
  private cache = new Map<string, CacheEntry>();
  private cam = new THREE.Vector3();
  private pivots: THREE.Vector3[] = [];
  private mat = new THREE.Matrix4();
  private scale = new THREE.Matrix4().makeScale(CHIBI_SCALE, CHIBI_SCALE, CHIBI_SCALE);

  constructor(
    private max: number,
    private radius: number,
  ) {}

  /** Paket (~2 MB sıkıştırılmış) arka planda iner; o zamana kadar herkes kapsül çizilir. */
  async load(manifest: ChibiManifest, binUrl: string): Promise<void> {
    const res = await fetch(binUrl);
    if (!res.ok) throw new Error(`chibi paketi: ${res.status}`);
    this.usePack(new ChibiPack(manifest, await res.arrayBuffer()));
  }

  /** İnmiş paketi paylaşır (gardırop önizlemesi aynı paketi yeniden indirmesin). */
  usePack(pack: ChibiPack): void {
    this.pack = pack;
    // Dizi yerinde doldurulur: kurulmuş yuvaların uniform'ları aynı diziyi gösteriyor
    this.pivots.length = 0;
    for (let l = 0; l < LIMB_COUNT; l++) this.pivots.push(new THREE.Vector3().fromArray(pack.pivots, l * 3));
  }

  private makeSlot(): Slot {
    const angles = Array.from({ length: LIMB_COUNT }, () => new THREE.Vector2());
    const uniforms = { uLimbA: { value: angles }, uPivot: { value: this.pivots } };
    // Saç katmanları çift yüzlü plakalar: arkası dönük tutam da çizilsin, konturu örtsün
    const body = new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide });
    body.onBeforeCompile = (s) => patch(s, uniforms, false);
    body.customProgramCacheKey = () => "chibi-body";
    const line = new THREE.MeshBasicMaterial({ color: 0x1c1622, side: THREE.BackSide });
    line.onBeforeCompile = (s) => patch(s, uniforms, true);
    line.customProgramCacheKey = () => "chibi-outline";
    const empty = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(empty, body);
    // Güneş gölgesi de pozdaki uzuvlarla düşsün (varsayılan derinlik malzemesi uzuvları döndürmez)
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (s) => patch(s, uniforms, false);
    depth.customProgramCacheKey = () => "chibi-depth";
    mesh.customDepthMaterial = depth;
    mesh.castShadow = mesh.receiveShadow = true;
    const outline = new THREE.Mesh(empty, line);
    for (const m of [mesh, outline]) {
      m.matrixAutoUpdate = false;
      m.frustumCulled = false;
      m.visible = false;
      this.group.add(m);
    }
    const slot = { mesh, outline, angles, key: "" };
    this.slots.push(slot);
    return slot;
  }

  /** Kare başı: kamera konumu (uzaklık için). */
  begin(camera: THREE.Vector3): void {
    this.used = 0;
    this.builds = 0;
    this.frame++;
    this.cam.copy(camera);
  }

  /**
   * Avatarı chibi olarak yerleştirir; uzaksa, yer yoksa ya da geometrisi henüz hazır değilse
   * false döner ve çağıran kapsül çizer. `pose` dünya matrisi (konum, yön, sallanma, ölçek).
   */
  place(look: Look | null | undefined, x: number, z: number, pose: THREE.Matrix4, limbs: LimbPose, always = false): boolean {
    if (!this.pack || this.used >= this.max) return false;
    const d2 = (x - this.cam.x) ** 2 + (z - this.cam.z) ** 2;
    if (!always && d2 > this.radius ** 2) return false;
    const key = lookKey(look);
    let entry = this.cache.get(key);
    if (!entry) {
      if (this.builds >= BUILDS_PER_FRAME) return false;
      this.builds++;
      entry = { geo: this.pack.build(look), usedAt: this.frame };
      this.cache.set(key, entry);
      this.evict();
    }
    entry.usedAt = this.frame;
    const slot = this.slots[this.used] ?? this.makeSlot();
    this.used++;
    if (slot.key !== key) {
      slot.key = key;
      slot.mesh.geometry = entry.geo;
      slot.outline.geometry = entry.geo;
    }
    this.mat.multiplyMatrices(pose, this.scale);
    slot.mesh.matrix.copy(this.mat);
    slot.outline.matrix.copy(this.mat);
    slot.mesh.matrixWorldNeedsUpdate = slot.outline.matrixWorldNeedsUpdate = true;
    slot.mesh.visible = true;
    slot.outline.visible = d2 <= OUTLINE_RADIUS ** 2;
    setLimbs(slot.angles, limbs);
    return true;
  }

  end(): void {
    for (let i = this.used; i < this.slots.length; i++) {
      const s = this.slots[i];
      s.mesh.visible = s.outline.visible = false;
    }
  }

  /** Önbellek dolunca en uzun süre kullanılmayan (bu kare çizilmeyen) geometriyi siler. */
  private evict(): void {
    while (this.cache.size > CACHE_MAX) {
      let oldKey = "", oldAt = Infinity;
      for (const [k, e] of this.cache) if (e.usedAt < oldAt && e.usedAt < this.frame) [oldKey, oldAt] = [k, e.usedAt];
      if (!oldKey) return;
      const geo = this.cache.get(oldKey)!.geo;
      this.cache.delete(oldKey);
      for (const s of this.slots) {
        if (s.key === oldKey) {
          s.key = "";
          s.mesh.geometry = s.outline.geometry = new THREE.BufferGeometry();
        }
      }
      geo.dispose();
    }
  }
}

/**
 * Uzuv açıları: 2-3 kollar, 4-5 bacaklar. Paketteki "_L" bakanın solu: 2 ve 4 −X, 3 ve 5 +X
 * tarafında (karakter +Z'ye bakar). z ekseni etrafında + açı +X'teki kolu yukarı kaldırır.
 */
export function setLimbs(a: THREE.Vector2[], p: LimbPose): void {
  for (const v of a) v.set(0, 0);
  const s = p.swing;
  a[2].x = -s * 0.9;
  a[3].x = s * 0.9;
  if (p.seated) {
    // Bacaklar öne kırılır (x ekseni etrafında eksi açı ayağı +Z'ye çevirir)
    a[4].x = a[5].x = -1.45;
    if (p.pedal) {
      const c = Math.sin(p.time * p.pedal);
      a[4].x = -1.15 + c * 0.45;
      a[5].x = -1.15 - c * 0.45;
      // Eller gidona
      a[2].x = a[3].x = -1.1;
    }
  } else {
    a[4].x = s;
    a[5].x = -s;
  }
  if (p.wave > 0) {
    // +X'teki kol yukarı, el sallanır
    a[3].y = 2.3 * p.wave + Math.sin(p.time * 14) * 0.25 * p.wave;
    a[3].x = 0;
  }
  if (p.hug > 0) {
    a[2].x = a[3].x = -1.45 * p.hug;
    a[2].y = -0.35 * p.hug;
    a[3].y = 0.35 * p.hug;
  }
  if (p.mic > 0) {
    a[3].x = -2.3 * p.mic;
    a[3].y = 0.5 * p.mic;
  }
  if (p.dance > 0) {
    const w = Math.sin(p.time * 8);
    a[2].y = (-2.2 + w * 0.3) * p.dance;
    a[3].y = (2.2 + w * 0.3) * p.dance;
    a[2].x = a[3].x = 0;
  }
}
