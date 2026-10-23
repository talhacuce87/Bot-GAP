import { expect, it } from "vitest";
import type * as THREE from "three";
import "./sceneShim";

// Çok üçgenli bir mesh dünyanın büyük kısmını kaplarsa ne kameranın ne de gölge kutusunun elemesi işe yarar:
// her kare (gölgeyle iki kez) tamamı çizilir. Eskiden bütün ağaçlar ve dükkân içleri böyleydi.
const HEAVY_TRIS = 15_000;
const MAX_RADIUS = 130;

it("ağır mesh'ler yerel: kamera ve gölge elemesi işe yarar", async () => {
  const THREE = await import("three");
  const { buildWorld } = await import("../client/src/world/scene");
  const w = buildWorld({ grass: true, season: "summer" });
  w.scene.updateMatrixWorld(true);
  const s = new THREE.Sphere();
  const wide: string[] = [];
  let total = 0;
  w.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const inst = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh) : null;
    const n = m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
    const tris = (n / 3) * (inst ? inst.count : 1);
    total += tris;
    if (tris < HEAVY_TRIS) return;
    if (inst && !inst.boundingSphere) inst.computeBoundingSphere();
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    s.copy(inst ? inst.boundingSphere! : m.geometry.boundingSphere!).applyMatrix4(o.matrixWorld);
    // Kamerayla gelen çimen alanı ayrı (konumu shader'da)
    if (!o.frustumCulled) return;
    let path = "";
    for (let p: THREE.Object3D | null = o; p; p = p.parent) path = `${p.name || p.type}/${path}`;
    if (s.radius > MAX_RADIUS) wide.push(`${path} ${(tris / 1000).toFixed(0)}k üçgen, ${s.radius.toFixed(0)} m`);
  });
  expect(wide).toEqual([]);
  console.log(`sahne toplamı ${(total / 1000).toFixed(0)}k üçgen`);
}, 60_000);
