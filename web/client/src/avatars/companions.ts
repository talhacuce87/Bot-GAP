// Evcil hayvanlar ve araçlar. Evcil hayvan sahibinin arkasından seker; konumu her istemcide yerel olarak
// hesaplanır (sahibin konumu zaten herkeste aynı). Araç (bisiklet, kaykay, kayık) avatarın altında çizilir.
// Tür başına tek InstancedMesh.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { FLAG_WALKING, type Vehicle, vehicleOf } from "../../../shared/constants";
import { mat, part } from "../world/geo";
import type { AvatarView } from "./avatars";

const MAX = 64;

function petGeometry(kind: string): THREE.BufferGeometry {
  const P = (g: THREE.BufferGeometry, c: string, m: THREE.Matrix4) => part(g, c, m);
  if (kind === "duck") {
    return mergeGeometries([
      P(new THREE.SphereGeometry(0.16, 8, 6), "#ffd84a", mat(0, 0.16, 0, 0, 1, 0.85, 1.25)),
      P(new THREE.SphereGeometry(0.11, 8, 6), "#ffe066", mat(0, 0.33, 0.12)),
      P(new THREE.BoxGeometry(0.1, 0.03, 0.08), "#f29a2e", mat(0, 0.32, 0.24)),
      P(new THREE.BoxGeometry(0.15, 0.015, 0.015), "#1a1a1a", mat(0, 0.36, 0.19)),
    ]);
  }
  if (kind === "cat") {
    return mergeGeometries([
      P(new THREE.CapsuleGeometry(0.11, 0.24, 3, 8).rotateX(Math.PI / 2), "#e39a4c", mat(0, 0.2, 0)),
      P(new THREE.SphereGeometry(0.12, 8, 6), "#e8a457", mat(0, 0.32, 0.2)),
      P(new THREE.ConeGeometry(0.045, 0.09, 4), "#c97f36", mat(-0.06, 0.45, 0.2)),
      P(new THREE.ConeGeometry(0.045, 0.09, 4), "#c97f36", mat(0.06, 0.45, 0.2)),
      P(new THREE.CylinderGeometry(0.025, 0.02, 0.3, 5).rotateX(-0.9), "#c97f36", mat(0, 0.32, -0.25)),
      ...[[-0.07, 0.12], [0.07, 0.12], [-0.07, -0.12], [0.07, -0.12]].map(([x, z]) => P(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 5), "#e8a457", mat(x, 0.06, z))),
      P(new THREE.BoxGeometry(0.16, 0.015, 0.015), "#1a1a1a", mat(0, 0.35, 0.31)),
    ]);
  }
  if (kind === "dog") {
    return mergeGeometries([
      P(new THREE.CapsuleGeometry(0.13, 0.3, 3, 8).rotateX(Math.PI / 2), "#a4683a", mat(0, 0.26, 0)),
      P(new THREE.SphereGeometry(0.14, 8, 6), "#b5764a", mat(0, 0.42, 0.26)),
      P(new THREE.BoxGeometry(0.1, 0.08, 0.12), "#d9b58c", mat(0, 0.38, 0.39)),
      P(new THREE.SphereGeometry(0.03, 6, 4), "#1a1a1a", mat(0, 0.41, 0.46)),
      P(new THREE.BoxGeometry(0.05, 0.14, 0.08), "#6e4325", mat(-0.12, 0.42, 0.24)),
      P(new THREE.BoxGeometry(0.05, 0.14, 0.08), "#6e4325", mat(0.12, 0.42, 0.24)),
      P(new THREE.CylinderGeometry(0.03, 0.02, 0.2, 5).rotateX(-0.6), "#a4683a", mat(0, 0.38, -0.3)),
      ...[[-0.09, 0.14], [0.09, 0.14], [-0.09, -0.14], [0.09, -0.14]].map(([x, z]) => P(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 5), "#b5764a", mat(x, 0.08, z))),
    ]);
  }
  // Tavşan
  return mergeGeometries([
    P(new THREE.SphereGeometry(0.15, 8, 6), "#f2efe9", mat(0, 0.16, 0, 0, 1, 0.9, 1.15)),
    P(new THREE.SphereGeometry(0.1, 8, 6), "#f6f4ef", mat(0, 0.3, 0.13)),
    P(new THREE.CapsuleGeometry(0.03, 0.16, 2, 6), "#f6f4ef", mat(-0.04, 0.47, 0.11)),
    P(new THREE.CapsuleGeometry(0.03, 0.16, 2, 6), "#f6f4ef", mat(0.04, 0.47, 0.11)),
    P(new THREE.SphereGeometry(0.05, 6, 4), "#ffffff", mat(0, 0.18, -0.17)),
    P(new THREE.SphereGeometry(0.018, 5, 4), "#e88a9a", mat(0, 0.3, 0.23)),
  ]);
}

function vehicleGeometry(v: Vehicle): THREE.BufferGeometry {
  const P = (g: THREE.BufferGeometry, c: string, m: THREE.Matrix4) => part(g, c, m);
  if (v === 1) {
    // Bisiklet: iki teker, kadro, sele, gidon (+Z ileri)
    const wheel = (z: number) => P(new THREE.TorusGeometry(0.3, 0.035, 6, 16).rotateY(Math.PI / 2), "#202228", mat(0, 0.33, z));
    return mergeGeometries([
      wheel(0.45),
      wheel(-0.45),
      P(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 5).rotateX(Math.PI / 2), "#d8343a", mat(0, 0.5, 0)),
      P(new THREE.CylinderGeometry(0.025, 0.025, 0.45, 5).rotateX(0.35), "#d8343a", mat(0, 0.48, -0.25)),
      P(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 5).rotateX(-0.3), "#d8343a", mat(0, 0.5, 0.4)),
      P(new THREE.BoxGeometry(0.14, 0.05, 0.24), "#1b1b1b", mat(0, 0.72, -0.2)),
      P(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 5).rotateZ(Math.PI / 2), "#9aa0a8", mat(0, 0.78, 0.45)),
    ]);
  }
  if (v === 2) {
    return mergeGeometries([
      P(new THREE.BoxGeometry(0.24, 0.035, 0.85), "#2b3c66", mat(0, 0.1, 0)),
      ...[[-0.08, 0.3], [0.08, 0.3], [-0.08, -0.3], [0.08, -0.3]].map(([x, z]) => P(new THREE.CylinderGeometry(0.04, 0.04, 0.04, 8).rotateZ(Math.PI / 2), "#f2c230", mat(x, 0.05, z))),
    ]);
  }
  // Kayık: tekne gövdesi, oturak, iki kürek
  return mergeGeometries([
    P(new THREE.CylinderGeometry(0.5, 0.35, 0.3, 10, 1, true).scale(1, 1, 2.2), "#8a5a32", mat(0, 0.08, 0)),
    P(new THREE.CircleGeometry(0.45, 10).rotateX(-Math.PI / 2).scale(1, 1, 2.1), "#6e4628", mat(0, -0.02, 0)),
    P(new THREE.BoxGeometry(0.85, 0.05, 0.25), "#a0703f", mat(0, 0.15, -0.1)),
    P(new THREE.CylinderGeometry(0.02, 0.02, 1.4, 5).rotateZ(1.2), "#c9a35a", mat(-0.55, 0.15, 0.1)),
    P(new THREE.CylinderGeometry(0.02, 0.02, 1.4, 5).rotateZ(-1.2), "#c9a35a", mat(0.55, 0.15, 0.1)),
  ]);
}

interface PetState {
  x: number;
  z: number;
  rot: number;
  hop: number;
  seen: number;
}

export class Companions {
  readonly group = new THREE.Group();
  private pets = new Map<string, THREE.InstancedMesh>();
  private vehicles: THREE.InstancedMesh[] = [];
  private state = new Map<number, PetState>();
  private counts = new Map<THREE.InstancedMesh, number>();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private up = new THREE.Vector3(0, 1, 0);
  private fwd = new THREE.Vector3(0, 0, 1);
  private tilt = new THREE.Quaternion();
  private frame = 0;

  constructor() {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    for (const kind of ["duck", "cat", "dog", "bunny"]) {
      const mesh = new THREE.InstancedMesh(petGeometry(kind), material, MAX);
      this.pets.set(kind, mesh);
    }
    for (const v of [1, 2, 3] as Vehicle[]) this.vehicles[v] = new THREE.InstancedMesh(vehicleGeometry(v), material, MAX);
    for (const mesh of [...this.pets.values(), ...this.vehicles.filter(Boolean)]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.count = 0;
      this.group.add(mesh);
    }
  }

  begin(): void {
    this.frame++;
    for (const mesh of this.counts.keys()) this.counts.set(mesh, 0);
  }

  private add(mesh: THREE.InstancedMesh): void {
    const n = this.counts.get(mesh) ?? 0;
    if (n >= MAX) return;
    mesh.setMatrixAt(n, this.m);
    this.counts.set(mesh, n + 1);
  }

  /** Bir avatarın evcil hayvanı ve aracı. `id` avatarın kalıcı kimliği (sid). */
  push(id: number, a: AvatarView, pet: string | null | undefined, time: number, dt: number): void {
    const vehicle = vehicleOf(a.flags);
    if (vehicle && this.vehicles[vehicle] && a.alpha > 0.01) {
      const bob = vehicle === 3 ? Math.sin(time * 1.7 + a.phase) * 0.04 : 0;
      const lean = vehicle === 1 && a.flags & FLAG_WALKING ? Math.sin(time * 5.5 + a.phase) * 0.03 : 0;
      this.q.setFromAxisAngle(this.up, a.rot);
      if (lean) this.q.multiply(this.tilt.setFromAxisAngle(this.fwd, lean));
      this.m.compose(this.v.set(a.x, (vehicle === 3 ? 0.02 : 0) + bob + (a.lift ?? 0), a.z), this.q, this.s.set(1, 1, 1));
      this.add(this.vehicles[vehicle]);
    }
    const mesh = pet ? this.pets.get(pet) : undefined;
    if (!mesh || a.alpha <= 0.01 || vehicle === 3) {
      this.state.delete(id);
      return;
    }
    // Sahibin sağ arkasında durur; uzaklaşınca seke seke yetişir, çok uzaksa ışınlanır
    const back = 1.0, side = 0.6;
    const tx = a.x - Math.sin(a.rot) * back + Math.cos(a.rot) * side;
    const tz = a.z - Math.cos(a.rot) * back - Math.sin(a.rot) * side;
    let p = this.state.get(id);
    if (!p || Math.hypot(p.x - tx, p.z - tz) > 12) {
      p = { x: tx, z: tz, rot: a.rot, hop: 0, seen: this.frame };
      this.state.set(id, p);
    }
    p.seen = this.frame;
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    const speed = Math.min(d * 3.2, 9);
    if (d > 0.08) {
      p.x += (dx / d) * speed * dt;
      p.z += (dz / d) * speed * dt;
      const want = Math.atan2(dx, dz);
      const diff = ((want - p.rot + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      p.rot += diff * Math.min(1, dt * 10);
      p.hop += dt * (8 + speed);
    } else {
      // Dururken sahibine döner
      const want = Math.atan2(a.x - p.x, a.z - p.z);
      const diff = ((want - p.rot + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      p.rot += diff * Math.min(1, dt * 4);
    }
    const hopY = d > 0.08 ? Math.abs(Math.sin(p.hop)) * (pet === "bunny" ? 0.22 : 0.08) : 0;
    this.q.setFromAxisAngle(this.up, p.rot);
    // Kedi ve köpek dururken kuyruk sallar gibi hafif sallanır
    const idle = d <= 0.08 ? Math.sin(time * 3 + id) * 0.04 : 0;
    if (idle) this.q.multiply(this.tilt.setFromAxisAngle(this.fwd, idle));
    this.m.compose(this.v.set(p.x, hopY + (a.lift ?? 0), p.z), this.q, this.s.set(1, 1, 1));
    this.add(mesh);
  }

  end(): void {
    for (const mesh of [...this.pets.values(), ...this.vehicles.filter(Boolean)]) {
      mesh.count = this.counts.get(mesh) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const [id, p] of this.state) if (p.seen !== this.frame) this.state.delete(id);
  }
}
