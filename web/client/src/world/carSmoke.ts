// Hasarlı arabanın kaputundan çıkan duman: yükselip büyüyen, sönen gri bulutçuklar (tek InstancedMesh, kameraya dönük).
import * as THREE from "three";
import { blobTexture } from "./geo";

const MAX = 160;
const LIFE = 2.2;

interface Puff {
  x: number;
  y: number;
  z: number;
  at: number;
  dark: number;
}

export class CarSmoke {
  readonly mesh: THREE.InstancedMesh;
  private puffs: Puff[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();

  constructor() {
    const tex = blobTexture(0.9);
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color: "#ffffff" }), MAX);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  /** Bir duman bulutçuğu; `dark` 0 açık gri, 1 kara duman. */
  emit(x: number, y: number, z: number, time: number, dark = 0.5): void {
    if (this.puffs.length >= MAX) this.puffs.shift();
    this.puffs.push({ x: x + (Math.random() - 0.5) * 0.3, y, z: z + (Math.random() - 0.5) * 0.3, at: time, dark });
  }

  update(time: number, camera: THREE.Camera): void {
    this.puffs = this.puffs.filter((p) => time - p.at < LIFE);
    this.q.copy(camera.quaternion);
    let n = 0;
    for (const p of this.puffs) {
      const u = (time - p.at) / LIFE;
      const size = (0.5 + u * 1.6) * (1 - u ** 4);
      this.m.compose(this.v.set(p.x + u * 0.6, p.y + u * 2.2, p.z), this.q, this.s.set(size, size, 1));
      this.mesh.setMatrixAt(n, this.m);
      // Söndükçe saydamlık yerine kararıp küçülür gibi: renk arka plana (beyaza) değil griye kayar
      const g = (0.55 - p.dark * 0.4) * (1 - u * 0.3) + u * 0.25;
      this.mesh.setColorAt(n, this.c.setRGB(g, g, g));
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
