import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Occlusion, type Portal } from "../client/src/world/occlusion";

// Kamera (0, 2, 0) −z'ye bakar; önünde 20 m'de 20 × 20 × 20 m'lik bina
function setup(cam = new THREE.Vector3(0, 2, 0), look = new THREE.Vector3(0, 2, -100)) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
  camera.position.copy(cam);
  camera.lookAt(look);
  const occ = new Occlusion([{ min: [-10, 0, -40], max: [10, 20, -20] }]);
  return { camera, occ };
}

function mesh(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0));
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  new THREE.Group().add(m);
  return m;
}

const hidden = (m: THREE.Object3D) => m.layers.mask === 0;

describe("örtme elemesi", () => {
  it("binanın tam arkasındaki gizlenir; kenardan taşan, öndeki ve yandaki görünür", () => {
    const { camera, occ } = setup();
    const behind = mesh(-3, 0, -70, 3, 4, -60);
    const peeking = mesh(-3, 0, -70, 40, 4, -60);
    const front = mesh(-3, 0, -15, 3, 4, -10);
    const beside = mesh(-60, 0, -70, -50, 4, -60);
    for (const m of [behind, peeking, front, beside]) occ.add(m);
    occ.cull(camera);
    expect([behind, peeking, front, beside].map(hidden)).toEqual([true, false, false, false]);
    // Gölge geçişi başlarken geri açılır
    occ.restore();
    expect(hidden(behind)).toBe(false);
  });

  it("kamera kutunun içindeyse ya da kapalıysa örtmez", () => {
    const inside = setup(new THREE.Vector3(0, 2, -30));
    const m = mesh(-3, 0, -90, 3, 4, -80);
    inside.occ.add(m);
    inside.occ.cull(inside.camera);
    expect(hidden(m)).toBe(false);

    const { camera, occ } = setup();
    const b = mesh(-3, 0, -70, 3, 4, -60);
    occ.add(b);
    occ.enabled = false;
    occ.cull(camera);
    expect(hidden(b)).toBe(false);
  });

  it("dükkân içi yalnızca ön cepheden görünür", () => {
    // Ön yüzü +z'ye bakan dükkân (x −5..5, z −60..−50)
    const portal: Portal = {
      room: new THREE.Box3(new THREE.Vector3(-5, -1, -60), new THREE.Vector3(5, 5, -50)),
      face: new THREE.Box3(new THREE.Vector3(-5, 0, -50), new THREE.Vector3(5, 5, -49.9)),
      nx: 0,
      nz: 1,
      px: 0,
      pz: -50,
    };
    const shop = () => {
      const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
      const occ = new Occlusion([]);
      const m = mesh(-4, 0, -59, 4, 3, -51);
      occ.add(m, portal);
      return { camera, occ, m };
    };
    // Önden bakınca görünür
    let s = shop();
    s.camera.position.set(0, 2, -30);
    s.camera.lookAt(0, 2, -55);
    s.occ.cull(s.camera);
    expect(hidden(s.m)).toBe(false);
    // Arkadan bakınca (arka duvar opak) görünmez
    s = shop();
    s.camera.position.set(0, 2, -80);
    s.camera.lookAt(0, 2, -55);
    s.occ.cull(s.camera);
    expect(hidden(s.m)).toBe(true);
    // İçeride hep görünür
    s = shop();
    s.camera.position.set(0, 2, -55);
    s.camera.lookAt(0, 2, -80);
    s.occ.cull(s.camera);
    expect(hidden(s.m)).toBe(false);
  });

  it("hareketli örnekler: kameranın arkası ve binanın arkası görünmez", () => {
    const { camera, occ } = setup();
    occ.add(mesh(-3, 0, -70, 3, 4, -60));
    occ.cull(camera);
    expect(occ.sphereVisible(0, 1, -15, 1)).toBe(true);
    expect(occ.sphereVisible(0, 1, -65, 1)).toBe(false);
    expect(occ.sphereVisible(0, 1, 10, 1)).toBe(false);
    expect(occ.sphereVisible(50, 1, -65, 1)).toBe(true);
  });
});
