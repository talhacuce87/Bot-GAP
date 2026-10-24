// Patinaj izleri: kayan arabaların arka lastiklerinden yola kalan koyu çizgiler (tek InstancedMesh; yer dolunca
// en eski iz silinir).
import * as THREE from "three";

const MAX = 900;

export class Skids {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: "#121212", transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** (x0, z0) → (x1, z1) arası bir iz parçası (lastik genişliğinde). */
  add(x0: number, z0: number, x1: number, z1: number, w = 0.2): void {
    const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
    if (len < 0.03 || len > 3) return;
    this.q.setFromAxisAngle(Skids.UP, Math.atan2(dx, dz));
    this.m.compose(this.p.set((x0 + x1) / 2, 0.055, (z0 + z1) / 2), this.q, this.s.set(w, 1, len + 0.04));
    this.mesh.setMatrixAt(this.next, this.m);
    this.next = (this.next + 1) % MAX;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
