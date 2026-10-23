import { describe, expect, it } from "vitest";

// Rotalar yürüyüş ağı modülünü (terrain, fame) içe aktarır: Node'da en küçük DOM
const ctx2d = new Proxy(
  {},
  {
    get: (_t, k) =>
      k === "measureText" ? () => ({ width: 10 })
      : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop() {} })
      : () => {},
    set: () => true,
  },
);
Object.assign(globalThis, {
  document: { createElement: () => ({ width: 1, height: 1, style: {}, getContext: () => ctx2d }) },
  window: globalThis,
  matchMedia: () => ({ matches: false }),
  location: { search: "", hostname: "localhost" },
  addEventListener() {},
});

describe("NPC trafik", () => {
  it("rotalar asfaltta (şehir bulvarı ve göbekli kavşak dahil), kapalı döngü; otuzdan fazla araba", async () => {
    const { buildRoutes } = await import("../client/src/npcs/trafficRoutes");
    const { onAsphalt, CITY } = await import("../shared/zones");
    const { HOOD_ROUNDABOUT } = await import("../shared/build");
    const routes = buildRoutes();
    const off: string[] = [];
    for (const r of routes) {
      const a = r.pts[0], b = r.pts[r.pts.length - 1];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1]), r.name).toBeLessThan(0.5);
      for (const [x, z] of r.pts) {
        const city = x > CITY.minX && x < CITY.maxX && z > CITY.minZ && z < CITY.maxZ;
        const ra = Math.hypot(x - HOOD_ROUNDABOUT.x, z - HOOD_ROUNDABOUT.z) < HOOD_ROUNDABOUT.r;
        if (!city && !ra && !onAsphalt(x, z, 0.3)) off.push(`${r.name} ${x.toFixed(0)},${z.toFixed(0)}`);
      }
    }
    expect(off.slice(0, 5)).toEqual([]);
    expect(routes.reduce((s, r) => s + r.offsets.length, 0)).toBeGreaterThan(30);
  });

  it("konumlar yalnızca saate bağlı: iki istemci aynı arabayı aynı yerde görür", async () => {
    const { buildRoutes, trajAt } = await import("../client/src/npcs/trafficRoutes");
    const a = buildRoutes(), b = buildRoutes();
    for (let i = 0; i < a.length; i++) {
      for (const t of [0, 77.7, 1.7e9 + 3.3]) expect(trajAt(b[i], t)).toEqual(trajAt(a[i], t));
    }
  });

  it("şehirde kırmızıda geçen yok; aynı rotadaki arabalar kuyrukta üst üste binmez", async () => {
    const { buildRoutes, trajAt } = await import("../client/src/npcs/trafficRoutes");
    const { signalLamp } = await import("../client/src/world/signals");
    let red = 0, close = 0;
    for (const r of buildRoutes()) {
      for (let t = 1.7e9; t < 1.7e9 + 240; t += 0.1) {
        const ss = r.offsets.map((o) => trajAt(r, t - r.t0 - o));
        for (const L of r.stops) for (const q of ss) {
          const d = (((q.s - L.s) % r.len) + r.len) % r.len;
          if (d < 0.3 && q.v > 2 && signalLamp(t, L.group) === 0) red++;
        }
        const s = ss.map((q) => (((q.s % r.len) + r.len) % r.len)).sort((x, y) => x - y);
        for (let i = 0; s.length > 1 && i < s.length; i++) if ((i + 1 < s.length ? s[i + 1] : s[0] + r.len) - s[i] < 6.5) close++;
      }
    }
    expect(red).toBe(0);
    expect(close).toBe(0);
  });

  it("önüne çıkan oyuncu için durur, sonra çizelgesine yetişir", async () => {
    const { AmbientTraffic } = await import("../client/src/npcs/traffic");
    const tr = new AmbientTraffic(false);
    const t0 = 1.7e12;
    tr.update(t0, 0.016, { x: 0, z: 0 }, 13, 1, []);
    const car = tr.cars.find((c) => c.shown && c.v > 5)!;
    expect(car).toBeTruthy();
    // Arabanın 5 m önüne geç
    const me = { x: car.x + Math.sin(car.rot) * 5, z: car.z + Math.cos(car.rot) * 5, car: null };
    const at = { x: car.x, z: car.z };
    for (let i = 1; i <= 60; i++) tr.update(t0 + i * 16, 0.016, { x: 0, z: 0 }, 13, 1, [me]);
    expect(Math.hypot(car.x - at.x, car.z - at.z)).toBeLessThan(1);
    expect(car.delay).toBeGreaterThan(0.8);
    for (let i = 61; i <= 2000; i++) tr.update(t0 + i * 16, 0.016, { x: 0, z: 0 }, 13, 1, []);
    expect(car.delay).toBe(0);
  });
});
