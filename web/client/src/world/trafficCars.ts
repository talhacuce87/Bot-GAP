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
  private side = new THREE.Vector3(1, 0, 0);
  private tilt = new THREE.Quaternion();

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
  }

  /**
   * Bütün görünümlerin mesh'leri: yükleme ekranında, shader ön derlemesinden önce çağrılır (~24 Tofaş kurulumu).
   * Oyun sırasında geometri kurulmaz, cam ve gövde programları da ilk karede hazırdır.
   */
  prebuild(): void {
    for (let look = 0; look < TRAFFIC_LOOKS.length; look++) this.batch(look);
  }

  /** Görünümün mesh'leri (prebuild çağrılmadıysa ilk kullanıldığında kurulur). */
  private batch(look: number): Batch {
    look %= TRAFFIC_LOOKS.length;
    return this.batches.get(look) ?? this.make(look);
  }

  private make(look: number): Batch {
    const g = harvest({ ...DEFAULT_CAR, ...TRAFFIC_LOOKS[look] });
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.InstancedMesh(geo, mat, MAX_PER_LOOK);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
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
  }

  /**
   * Bir araba: görünüm, konum (yer), yön; `scale` belirip kaybolurken. Yokuşlu yolda (otoyol) `y` yolun yüksekliği,
   * `pitch` burnun aşağı eğimi (rad).
   */
  push(look: number, x: number, z: number, rot: number, scale = 1, y = 0, pitch = 0): void {
    const b = this.batch(look);
    if (b.n >= MAX_PER_LOOK) return;
    this.q.setFromAxisAngle(this.up, rot);
    if (pitch) this.q.multiply(this.tilt.setFromAxisAngle(this.side, pitch));
    this.m.compose(this.v.set(x, y, z), this.q, this.s.setScalar(scale));
    b.body.setMatrixAt(b.n, this.m);
    b.glass.setMatrixAt(b.n, this.m);
    b.glow.setMatrixAt(b.n, this.m);
    b.n++;
    if (this.shadowN < 256) this.shadow.setMatrixAt(this.shadowN++, this.m.compose(this.v.set(x, y + 0.05, z), this.q, this.s.set(scale, 1, scale)));
  }

  end(): void {
    for (const b of this.batches.values()) {
      // Boş görünüm çizim listesine girmesin (program ve uniform bağlama boşuna)
      for (const mesh of [b.body, b.glass, b.glow]) {
        mesh.count = b.n;
        mesh.visible = b.n > 0;
        if (b.n) mesh.instanceMatrix.needsUpdate = true;
      }
      if (b.n) boundInstances(b.body, 0);
    }
    this.shadow.count = this.shadowN;
    this.shadow.instanceMatrix.needsUpdate = true;
  }
}

