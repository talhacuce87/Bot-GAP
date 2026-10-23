import { expect, it } from "vitest";
import type * as THREE from "three";

// Sahneyi Node'da kurmak için en küçük DOM: tabelaların tuvali her çizim çağrısını kabul eder (çizim sonucu
// burada önemsiz; yalnızca nesnelerin nereye konduğuna bakılır).
const ctx2d = new Proxy(
  {},
  {
    get: (_t, k) =>
      k === "measureText" ? () => ({ width: 10 })
      : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop() {} })
      : k === "getImageData" ? () => ({ data: new Uint8ClampedArray(4) })
      : () => {},
    set: () => true,
  },
);
const fakeCanvas = () => ({ width: 1, height: 1, style: {}, getContext: () => ctx2d, addEventListener() {}, toDataURL: () => "" });
const fakeEl = () => ({ style: {}, append() {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, toggle() {} } });
Object.assign(globalThis, {
  document: { createElement: (t: string) => (t === "canvas" ? fakeCanvas() : fakeEl()), createElementNS: fakeCanvas, body: { append() {} } },
  window: globalThis,
  matchMedia: () => ({ matches: false }),
  innerHeight: 720,
  innerWidth: 1280,
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame() {},
  location: { search: "", hostname: "localhost" },
});

it("mahalle: arsalar caddeye, kavşağa, gölete ve birbirine taşmaz; her arsanın önü caddeye yakın; caddeler yürünür", async () => {
  const { HOOD_BOX, HOOD_PARK, HOOD_ROADS, PLOTS, onHoodStreet } = await import("../shared/build");
  const { walkable } = await import("../client/src/world/terrain");
  for (const p of PLOTS) {
    // Arsanın kenarı boyunca ve içinde 5 m'de bir: asfalt ya da gölet yok
    for (let i = 0; i <= p.size; i += 5) {
      for (let k = 0; k <= p.size; k += 5) {
        const x = p.x0 + i, z = p.z0 + k;
        expect(onHoodStreet(x, z, 0.5), `arsa ${p.id + 1} (${x},${z}) caddede`).toBe(false);
        expect(Math.hypot(x - HOOD_PARK.x, z - HOOD_PARK.z)).toBeGreaterThan(HOOD_PARK.pond);
        expect(x >= HOOD_BOX.minX && x <= HOOD_BOX.maxX && z >= HOOD_BOX.minZ && z <= HOOD_BOX.maxZ).toBe(true);
      }
    }
    for (const q of PLOTS) if (q !== p) expect(p.x0 + p.size <= q.x0 || q.x0 + q.size <= p.x0 || p.z0 + p.size <= q.z0 || q.z0 + q.size <= p.z0).toBe(true);
    // Ön yüzün ortası caddenin 11 m yakınında (bulvar kıvrıldığı yerde arada kaldırım ve çimenlik kalır)
    const fz = p.front < 0 ? p.z0 : p.z0 + p.size;
    expect(onHoodStreet(p.x0 + p.size / 2, fz, 11), `arsa ${p.id + 1} caddeden uzak`).toBe(true);
  }
  for (const r of HOOD_ROADS) for (const [x, z] of r) expect(walkable(x, z), `${x},${z}`).toBe(true);
});

it("otobanın, köy yollarının ve mahalle caddelerinin üstünde engel, patika taşı ya da direk yok (arabalar takılmaz, üst üste binme yok)", async () => {
  const { Builder } = await import("../client/src/world/builder");
  const props: [string, number, number][] = [];
  const prop = Builder.prototype.prop;
  Builder.prototype.prop = function (kind: never, m: THREE.Matrix4) {
    props.push([kind, m.elements[12], m.elements[14]]);
    return prop.call(this, kind, m);
  };
  const { buildWorld } = await import("../client/src/world/scene");
  const { CITY, onAsphalt } = await import("../shared/zones");
  const w = buildWorld({ grass: false });
  // Şehrin bulvarı ayrı (refüj ve kavşak düzeni): yalnızca köy, otoban ve mahalle
  const outsideCity = (x: number) => x < CITY.minX - 4;

  const data = (w.colliders as unknown as { data: number[] }).data;
  const blocked: string[] = [];
  for (let i = 0; i < data.length; i += 6) {
    const [ax, az, bx, bz, r] = data.slice(i, i + 5);
    for (let t = 0; t <= 1; t += 0.25) {
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      if (outsideCity(x) && onAsphalt(x, z, r)) {
        blocked.push(`${x.toFixed(1)},${z.toFixed(1)}`);
        break;
      }
    }
  }
  expect(blocked).toEqual([]);
  // Lamba ampulleri yolun üstüne uzanan kolda asılıdır; diğer her şey asfaltın dışında
  const onRoad = props.filter(([k, x, z]) => k !== "bulb" && outsideCity(x) && onAsphalt(x, z, 0.3)).map(([k, x, z]) => `${k} ${x.toFixed(1)},${z.toFixed(1)}`);
  expect(onRoad).toEqual([]);
}, 60_000);
