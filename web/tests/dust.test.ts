import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DustFx } from "../client/src/avatars/dust";

/** Başlangıç zamanı yazılmış (kullanılmış) puf sayısı. */
const used = (d: DustFx) => {
  const life = (d.mesh.geometry.getAttribute("aLife") as THREE.InstancedBufferAttribute).array;
  let n = 0;
  for (let i = 0; i < life.length; i += 2) if (life[i] > 0) n++;
  return n;
};

describe("zıplama tozu", () => {
  const cam = new THREE.Vector3(0, 3, 6);

  it("kalkışta az, inişte çok puf; yerde dururken ya da havadayken hiç", () => {
    const d = new DustFx();
    const v = { x: 0, z: 0, jumpY: 0 };
    d.track(v, 1, cam);
    expect(used(d)).toBe(0);
    v.jumpY = 0.3;
    d.track(v, 1.1, cam);
    const takeoff = used(d);
    expect(takeoff).toBeGreaterThan(0);
    v.jumpY = 0.8;
    d.track(v, 1.2, cam);
    expect(used(d)).toBe(takeoff);
    v.jumpY = 0;
    d.track(v, 1.6, cam);
    expect(used(d) - takeoff).toBeGreaterThan(takeoff);
  });

  it("uzaktaki avatar için toz üretmez; ilk görüldüğü kare iniş sayılmaz", () => {
    const d = new DustFx();
    const far = { x: 200, z: 0, jumpY: 0.5 };
    d.track(far, 1, cam);
    far.jumpY = 0;
    d.track(far, 1.5, cam);
    expect(used(d)).toBe(0);
    const fresh = { x: 1, z: 1, jumpY: 0 };
    d.track(fresh, 2, cam);
    expect(used(d)).toBe(0);
  });
});
