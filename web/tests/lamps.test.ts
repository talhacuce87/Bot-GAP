import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { LampField, lampsFrom, MAX_CARS } from "../client/src/world/lamps";

/** Hücrenin (dünya x, z) ızgaradaki lamba listesi (1'den başlayan dizinler). */
function cellLamps(f: LampField, x: number, z: number): number[] {
  const u = f.uniforms, a = u.uLampArea.value, cols = u.uLampDims.value.x, per = a.w;
  const cx = Math.floor((x - a.x) / a.z), cz = Math.floor((z - a.y) / a.z);
  const data = u.uLampGrid.value!.image.data as Float32Array, out: number[] = [];
  for (let k = 0; k < per; k++) {
    const v = data[((cz * cols + cx) * per + k) * 4];
    if (!v) break;
    out.push(v);
  }
  return out;
}

describe("gece ışığı (ızgaralı)", () => {
  it("her lamba menzilindeki hücrelere yazılır, uzaktaki hücreye yazılmaz; hücrede en yakın önce", () => {
    const f = new LampField([
      { x: 0, y: 2.7, z: 0, fire: false },
      { x: 10, y: 6, z: 0, fire: false },
      { x: 300, y: 2.7, z: 0, fire: true },
    ]);
    expect(cellLamps(f, 0, 0)).toEqual(expect.arrayContaining([1, 2]));
    expect(cellLamps(f, 0, 0)).not.toContain(3);
    // Uzun lamba (6 m) daha uzağa ulaşır: 30 m ötedeki hücrede o var, kısa lamba yok
    expect(cellLamps(f, 32, 0)).toContain(2);
    expect(cellLamps(f, 32, 0)).not.toContain(1);
    expect(cellLamps(f, 300, 0)).toEqual([3]);
  });

  it("sahnedeki ampul ve meşale dönüşümlerinden lamba listesi", () => {
    const l = lampsFrom([new THREE.Matrix4().makeTranslation(1, 5, 2)], [new THREE.Matrix4().makeTranslation(3, 1, 4)]);
    expect(l).toEqual([{ x: 1, y: 5, z: 2, fire: false }, { x: 3, y: 1.3, z: 4, fire: true }]);
  });

  it("farlar en çok MAX_CARS; yön birim, güç ayrı", () => {
    const f = new LampField([]);
    f.setHeadlights(Array.from({ length: MAX_CARS + 3 }, (_, i) => ({ x: i, y: 0.7, z: 0, dx: 0, dz: 1, color: new THREE.Color("#fff") })));
    expect(f.uniforms.uCarCount.value).toBe(MAX_CARS);
    const d = f.uniforms.uCarDir.value[0];
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 5);
    expect(d.w).toBeGreaterThan(10);
  });

  it("malzemeye bir kez eklenir, önceki shader eklemesi ve önbellek anahtarı korunur; uygun olmayan malzeme atlanır", () => {
    const f = new LampField([]);
    const m = new THREE.MeshLambertMaterial();
    let prevRan = 0;
    m.onBeforeCompile = () => void prevRan++;
    m.customProgramCacheKey = () => "onceki";
    f.patch(m);
    f.patch(m);
    const shader = { vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader, uniforms: {} };
    m.onBeforeCompile(shader as never, null as never);
    expect(prevRan).toBe(1);
    expect(m.customProgramCacheKey()).toBe("onceki-lamps");
    expect(shader.fragmentShader).toContain("uLampNight");
    expect((shader.fragmentShader.match(/uniform float uLampNight/g) ?? []).length).toBe(1);
    const basic = new THREE.MeshBasicMaterial();
    f.patch(basic);
    expect(basic.customProgramCacheKey()).not.toContain("lamps");
  });
});
