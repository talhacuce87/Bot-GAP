// Eldeki eşya: hızlı slottan seçilen yiyecek/içecek avatarın sağ elinde küçük bir model olarak görünür (simit,
// çay bardağı, burger…). Yerken el ağza gider (avatars.ts: LimbPose.eat), model de onunla kalkar.
import * as THREE from "three";
import type { ItemId } from "../../../shared/items";
import type { AvatarView } from "../avatars/avatars";

const mat = (c: string, o: Partial<THREE.MeshLambertMaterialParameters> = {}) => new THREE.MeshLambertMaterial({ color: c, ...o });

function part(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x, y, z);
  mesh.rotation.x = rx;
  return mesh;
}

/** Eşyanın küçük modeli (avatarın ölçeğinde; tabanı eldedir). */
function model(id: ItemId): THREE.Group {
  const g = new THREE.Group();
  switch (id) {
    case "simit":
      g.add(part(new THREE.TorusGeometry(0.07, 0.024, 8, 18), mat("#c8843a"), 0, 0.07, 0));
      break;
    case "pogaca":
      g.add(part(new THREE.SphereGeometry(0.06, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat("#e0a650"), 0, 0.01, 0));
      break;
    case "sandvic":
      g.add(part(new THREE.BoxGeometry(0.14, 0.03, 0.1), mat("#e9c98f"), 0, 0.015));
      g.add(part(new THREE.BoxGeometry(0.15, 0.015, 0.11), mat("#6dbb4a"), 0, 0.037));
      g.add(part(new THREE.BoxGeometry(0.14, 0.03, 0.1), mat("#e9c98f"), 0, 0.06));
      break;
    case "burger":
      g.add(part(new THREE.CylinderGeometry(0.07, 0.07, 0.03, 14), mat("#d99a4e"), 0, 0.015));
      g.add(part(new THREE.CylinderGeometry(0.075, 0.075, 0.025, 14), mat("#5a3220"), 0, 0.042));
      g.add(part(new THREE.CylinderGeometry(0.078, 0.078, 0.01, 14), mat("#f2c230"), 0, 0.059));
      g.add(part(new THREE.SphereGeometry(0.07, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat("#d99a4e"), 0, 0.064));
      break;
    case "cay":
      g.add(part(new THREE.CylinderGeometry(0.03, 0.022, 0.09, 12), mat("#b23a1d", { transparent: true, opacity: 0.85 }), 0, 0.05));
      g.add(part(new THREE.CylinderGeometry(0.05, 0.05, 0.008, 14), mat("#f2f2f2"), 0, 0.004));
      break;
    case "kahve":
      g.add(part(new THREE.CylinderGeometry(0.035, 0.03, 0.06, 12), mat("#f5f1e8"), 0, 0.03));
      g.add(part(new THREE.CylinderGeometry(0.033, 0.033, 0.004, 12), mat("#3b2416"), 0, 0.059));
      break;
    case "enerji":
      g.add(part(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 12), mat("#1f6fd1"), 0, 0.06));
      g.add(part(new THREE.CylinderGeometry(0.028, 0.03, 0.01, 12), mat("#c9ced6"), 0, 0.125));
      break;
    case "su":
      g.add(part(new THREE.CylinderGeometry(0.032, 0.032, 0.15, 12), mat("#9ad4f5", { transparent: true, opacity: 0.7 }), 0, 0.075));
      g.add(part(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 10), mat("#2a6fd6"), 0, 0.16));
      break;
  }
  g.scale.setScalar(1.25);
  return g;
}

/** El: gövdenin önünde, sağda (avatar ölçeğinde). */
const FWD = 0.2;
const SIDE = 0.2;
const HAND_Y = 0.48;

export class HeldItems {
  readonly group = new THREE.Group();
  private cache = new Map<ItemId, THREE.Group[]>();
  private used: THREE.Group[] = [];

  begin(): void {
    for (const g of this.used) {
      g.visible = false;
      this.cache.get(g.userData.id as ItemId)!.push(g);
    }
    this.used = [];
  }

  /** Avatarın elindekini çiz; `eat` 0..1: el ağza. */
  place(v: AvatarView, id: ItemId, eat: number): void {
    let list = this.cache.get(id);
    if (!list) this.cache.set(id, (list = []));
    let g = list.pop();
    if (!g) {
      g = model(id);
      g.userData.id = id;
      this.group.add(g);
    }
    g.visible = true;
    this.used.push(g);
    const fx = Math.sin(v.rot), fz = Math.cos(v.rot);
    const rx = -fz, rz = fx;
    const side = SIDE * (1 - eat * 0.55), fwd = FWD + eat * 0.02;
    g.position.set(v.x + fx * fwd + rx * side, (v.baseY ?? 0) + v.jumpY + (v.lift ?? 0) + HAND_Y + eat * 0.42, v.z + fz * fwd + rz * side);
    g.rotation.set(-eat * 0.9, v.rot, 0, "YXZ");
  }
}
