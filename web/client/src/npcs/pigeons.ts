// Güvercin sürüleri: meydanda ve casinonun önünde yerde gagalayıp seker; biri koşarak ya da arabayla yaklaşınca
// (ya da çok yakına gelince) sürü havalanır, birkaç tur atıp yerine konar. Yerel süs: herkeste aynı olması
// gerekmez. Gövde ve kanatlar iki InstancedMesh.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CASINO, PLAZA } from "../../../shared/zones";
import { mat, part } from "../world/geo";
import { lerp, lerpAngle } from "./fixedStep";

interface Bird {
  hx: number;
  hz: number;
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Önceki benzetim adımındaki yer ve yön (çizim ikisinin arasından). */
  px: number;
  py: number;
  pz: number;
  prot: number;
  /** Uçuş: başladığı an, tur yarıçapı ve yönü; 0 ise yerde. */
  flyAt: number;
  r: number;
  dir: number;
  phase: number;
}

interface Flock {
  x: number;
  z: number;
  birds: Bird[];
  /** Sürü havadayken yere iniş zamanı (sn). */
  landAt: number;
  /** Kamera yakın mı (uzaktaysa çizilmez). */
  near: boolean;
}

/** Ürkütme: koşan/araba bu kadar yakına gelince, yürüyen ise daha yakına. */
const SCARE_FAST = 5;
const SCARE_SLOW = 1.6;
const FLY_TIME = 9;

export interface Scarer {
  x: number;
  z: number;
  fast: boolean;
}

function birdGeometry(): { body: THREE.BufferGeometry; wing: THREE.BufferGeometry } {
  const body = mergeGeometries([
    part(new THREE.SphereGeometry(0.09, 7, 5), "#8a8f9c", mat(0, 0.11, 0, 0, 1, 0.85, 1.35)),
    part(new THREE.SphereGeometry(0.055, 7, 5), "#5d6b7c", mat(0, 0.2, 0.1)),
    part(new THREE.ConeGeometry(0.018, 0.05, 4).rotateX(Math.PI / 2), "#d9a441", mat(0, 0.2, 0.17)),
    part(new THREE.BoxGeometry(0.08, 0.015, 0.09), "#6c7280", mat(0, 0.11, -0.14)),
    part(new THREE.CylinderGeometry(0.008, 0.008, 0.06, 4), "#c96a5a", mat(-0.03, 0.03, 0)),
    part(new THREE.CylinderGeometry(0.008, 0.008, 0.06, 4), "#c96a5a", mat(0.03, 0.03, 0)),
  ])!;
  // Kanat: omuzdan yana uzanan ince levha (iki yan tek geometride; çırpma ölçekle)
  const wing = mergeGeometries([
    part(new THREE.BoxGeometry(0.16, 0.012, 0.09).translate(0.08, 0, 0), "#7d8494", mat(0.04, 0.14, 0)),
    part(new THREE.BoxGeometry(0.16, 0.012, 0.09).translate(-0.08, 0, 0), "#7d8494", mat(-0.04, 0.14, 0)),
  ])!;
  return { body, wing };
}

export class Pigeons {
  readonly group = new THREE.Group();
  private flocks: Flock[] = [];
  private body: THREE.InstancedMesh;
  private wing: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private xAxis = new THREE.Vector3(1, 0, 0);
  private tilt = new THREE.Quaternion();

  constructor() {
    const spots: [number, number, number][] = [
      [PLAZA.x - 4, PLAZA.z + 5, 14],
      [PLAZA.x + 6, PLAZA.z - 4, 8],
      [CASINO.x - 8, CASINO.z + CASINO.hd + 7, 12],
    ];
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [x, z, n] of spots) {
      const birds: Bird[] = [];
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2, r = rand() * 2.6;
        const hx = x + Math.cos(a) * r, hz = z + Math.sin(a) * r;
        const rot = rand() * 6.28;
        birds.push({ hx, hz, x: hx, y: 0, z: hz, rot, px: hx, py: 0, pz: hz, prot: rot, flyAt: 0, r: 5 + rand() * 4, dir: rand() < 0.5 ? -1 : 1, phase: rand() * 10 });
      }
      this.flocks.push({ x, z, birds, landAt: 0, near: false });
    }
    const total = this.flocks.reduce((s, f) => s + f.birds.length, 0);
    const { body, wing } = birdGeometry();
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.body = new THREE.InstancedMesh(body, material, total);
    this.wing = new THREE.InstancedMesh(wing, material, total);
    for (const mesh of [this.body, this.wing]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  /** Benzetim adımı (FixedStep): ürkme, uçuş ve yerdeki dönüş. Çizim `draw` ile. */
  step(time: number, dt: number, cam: { x: number; z: number }, scarers: Scarer[]): void {
    for (const f of this.flocks) {
      const near = Math.hypot(f.x - cam.x, f.z - cam.z) < 120;
      f.near = near;
      const flying = f.landAt > time;
      if (!flying && near) {
        for (const s of scarers) {
          const d = Math.hypot(s.x - f.x, s.z - f.z);
          if (d < (s.fast ? SCARE_FAST : SCARE_SLOW) + 2.6) {
            // En yakın kuş da ürkerse bütün sürü kalkar
            const close = f.birds.some((b) => Math.hypot(s.x - b.x, s.z - b.z) < (s.fast ? SCARE_FAST : SCARE_SLOW));
            if (!close) continue;
            f.landAt = time + FLY_TIME;
            f.birds.forEach((b, k) => (b.flyAt = time + k * 0.04));
            break;
          }
        }
      }
      for (const b of f.birds) {
        b.px = b.x;
        b.py = b.y;
        b.pz = b.z;
        b.prot = b.rot;
        const ft = time - b.flyAt;
        if (b.flyAt && ft >= 0 && ft < FLY_TIME) {
          // Kalkış, tur, iniş: yükseklik yumuşak bir tümsek; konum sürü merkezinin çevresinde daire
          const u = ft / FLY_TIME;
          const up = Math.sin(Math.min(1, u * 1.15) * Math.PI);
          const a = b.phase + b.dir * ft * 0.9;
          const blend = Math.min(1, ft * 1.5) * Math.min(1, (FLY_TIME - ft) * 0.8);
          const cx = f.x + Math.cos(a) * b.r, cz = f.z + Math.sin(a) * b.r;
          const nx = b.hx + (cx - b.hx) * blend, nz = b.hz + (cz - b.hz) * blend;
          if (dt > 0) b.rot = Math.atan2(nx - b.x, nz - b.z) || b.rot;
          b.x = nx;
          b.z = nz;
          b.y = up * (6 + (b.phase % 3));
        } else {
          b.flyAt = 0;
          b.x = b.hx;
          b.z = b.hz;
          b.y = 0;
        }
        // Yerde ara sıra dönme
        if (b.y <= 0.05) b.rot += Math.sin(time * 0.7 + b.phase) * dt * 0.8;
      }
    }
  }

  /** Kare başına: yakındaki sürüler son iki adımın arasında (`alpha`); gagalama ve kanat çırpma kare saatiyle. */
  draw(time: number, alpha: number): void {
    let i = 0;
    for (const f of this.flocks) {
      if (!f.near) {
        i += f.birds.length;
        continue;
      }
      for (const b of f.birds) {
        const y = lerp(b.py, b.y, alpha);
        const air = y > 0.05;
        // Yerde: gagalama (öne eğilme)
        const peck = air ? 0 : Math.max(0, Math.sin(time * 3 + b.phase * 7)) ** 6 * 0.5;
        this.q.setFromAxisAngle(this.up, lerpAngle(b.prot, b.rot, alpha));
        if (peck) this.q.multiply(this.tilt.setFromAxisAngle(this.xAxis, peck));
        this.m.compose(this.v.set(lerp(b.px, b.x, alpha), y, lerp(b.pz, b.z, alpha)), this.q, this.s.set(1, 1, 1));
        this.body.setMatrixAt(i, this.m);
        // Kanat: havada hızlı çırpma, yerde katlı (dar)
        const flap = air ? 0.35 + Math.abs(Math.sin(time * 18 + b.phase)) * 1.1 : 0.25;
        this.m.compose(this.v, this.q, this.s.set(flap, 1, 1));
        this.wing.setMatrixAt(i, this.m);
        i++;
      }
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.wing.instanceMatrix.needsUpdate = true;
  }
}
