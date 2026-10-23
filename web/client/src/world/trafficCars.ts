// NPC arabaların çizimi: Tofaş kurucusunun gövde, cam ve lamba geometrisi bir kez toplanır, her model/renk tek
// InstancedMesh olur (oyuncu arabası gibi tek tek kurulsa araba başına ~20 draw call). Tekerlekler gövdeyle
// birlikte (dönmez); plaka, neon, far huzmesi yok. Altında yumuşak gölge.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { type CarSpec, DEFAULT_CAR } from "../../../shared/car";
import { blobTexture, boundInstances } from "./geo";
import { buildTofas } from "./tofas";

/** NPC arabaların modelleri ve renkleri (bir arabanın görünümü bu listeden). */
export const TRAFFIC_LOOKS: Pick<CarSpec, "model" | "color">[] = (() => {
  const out: Pick<CarSpec, "model" | "color">[] = [];
  const colors: CarSpec["color"][] = ["beyaz", "kirmizi", "siyah", "lacivert", "bej", "gri", "taksi", "yesil"];
  for (const model of ["sahin", "dogan", "kartal"] as const) for (const color of colors) out.push({ model, color });
  return out;
})();
const MAX_PER_LOOK = 24;

interface Batch {
  body: THREE.InstancedMesh;
  glass: THREE.InstancedMesh;
  glow: THREE.InstancedMesh;
  n: number;
}

/** Tofaşın gövde (ışıkla), cam (saydam) ve lamba (parlayan) geometrileri, araba eksenine göre. */
function harvest(spec: CarSpec): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const t = buildTofas(spec);
  t.group.updateMatrixWorld(true);
  const body: THREE.BufferGeometry[] = [], glass: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [];
  t.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry.getAttribute("color")) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal" && name !== "color") g.deleteAttribute(name);
    const m = o.material;
    if (m instanceof THREE.MeshPhongMaterial) glass.push(g);
    else if (m instanceof THREE.MeshBasicMaterial) glow.push(g);
    else if (m instanceof THREE.MeshLambertMaterial) body.push(g);
  });
  t.dispose();
  const merge = (list: THREE.BufferGeometry[]) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g))) ?? new THREE.BufferGeometry();
  return { body: merge(body), glass: merge(glass), glow: merge(glow) };
}

export class TrafficCars {
  readonly group = new THREE.Group();
  private batches = new Map<number, Batch>();
  private shadow: THREE.InstancedMesh;
  private shadowN = 0;
  private bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private glassMat = new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, opacity: 0.45, shininess: 90, specular: "#ffffff", depthWrite: false });
  private glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  /** Bu kare kurulan görünüm (kare başına en çok bir: ~8 ms). */
  private built = false;

  constructor() {
    this.shadow = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(2.1, 4.9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: blobTexture(0.5), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }),
      256,
    );
    this.shadow.count = 0;
    this.shadow.frustumCulled = false;
    this.shadow.renderOrder = 2;
    this.group.add(this.shadow);
    // Görünümler tarayıcı boştayken önceden kurulur: araba ilk göründüğü karede takılma olmasın
    const idle: (f: () => void) => void = typeof requestIdleCallback === "function" ? (f) => requestIdleCallback(f, { timeout: 2000 }) : (f) => setTimeout(f, 50);
    const warm = (look: number) => {
      if (look >= TRAFFIC_LOOKS.length) return;
      idle(() => {
        if (!this.batches.has(look)) this.make(look);
        warm(look + 1);
      });
    };
    warm(0);
  }

  /** Görünümün mesh'leri henüz kurulmadıysa bu kare kurulur; başka biri kurulduysa null (araba sonra belirir). */
  private batch(look: number): Batch | null {
    const b = this.batches.get(look);
    if (b) return b;
    if (this.built) return null;
    this.built = true;
    return this.make(look);
  }

  private make(look: number): Batch {
    const g = harvest({ ...DEFAULT_CAR, ...TRAFFIC_LOOKS[look % TRAFFIC_LOOKS.length] });
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geo, mat, MAX_PER_LOOK);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };
    const b: Batch = { body: mk(g.body, this.bodyMat), glass: mk(g.glass, this.glassMat), glow: mk(g.glow, this.glowMat), n: 0 };
    b.body.castShadow = true;
    // Örnekler her kare yer değiştirir: küre end()'de yeniden hesaplanır, üç mesh aynı küreyi kullanır.
    // Böylece kameranın ve gölge kutusunun dışında kalan görünümler çizilmez.
    b.body.geometry.computeBoundingSphere();
    b.body.boundingSphere = new THREE.Sphere();
    b.glass.boundingSphere = b.glow.boundingSphere = b.body.boundingSphere;
    for (const mesh of [b.body, b.glass, b.glow]) mesh.frustumCulled = true;
    b.glass.renderOrder = 3;
    this.batches.set(look, b);
    return b;
  }

  begin(): void {
    for (const b of this.batches.values()) b.n = 0;
    this.shadowN = 0;
    this.built = false;
  }

  /** Bir araba: görünüm, konum (yer), yön; `scale` belirip kaybolurken. */
  push(look: number, x: number, z: number, rot: number, scale = 1): void {
    const b = this.batch(look);
    if (!b || b.n >= MAX_PER_LOOK) return;
    this.q.setFromAxisAngle(this.up, rot);
    this.m.compose(this.v.set(x, 0, z), this.q, this.s.setScalar(scale));
    b.body.setMatrixAt(b.n, this.m);
    b.glass.setMatrixAt(b.n, this.m);
    b.glow.setMatrixAt(b.n, this.m);
    b.n++;
    if (this.shadowN < 256) this.shadow.setMatrixAt(this.shadowN++, this.m.compose(this.v.set(x, 0.05, z), this.q, this.s.set(scale, 1, scale)));
  }

  end(): void {
    for (const b of this.batches.values()) {
      for (const mesh of [b.body, b.glass, b.glow]) {
        mesh.count = b.n;
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (b.n) boundInstances(b.body, 0);
    }
    this.shadow.count = this.shadowN;
    this.shadow.instanceMatrix.needsUpdate = true;
  }
}

