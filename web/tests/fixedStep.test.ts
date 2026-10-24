import { describe, expect, it } from "vitest";
import { FixedStep, lerp, lerpAngle } from "../client/src/npcs/fixedStep";

describe("sabit adımlı benzetim", () => {
  it("240 fps'te saniyede 30 adım, 30 fps'in altında kare başına en çok bir (birleşik) adım", () => {
    const fast = new FixedStep(1 / 30);
    let steps = 0, simulated = 0;
    for (let k = 0; k < 240; k++) {
      const h = fast.advance(1 / 240);
      if (h > 0) {
        steps++;
        simulated += h;
      }
    }
    expect(steps).toBeGreaterThanOrEqual(29);
    expect(steps).toBeLessThanOrEqual(30);
    expect(simulated).toBeCloseTo(steps / 30, 6);

    const slow = new FixedStep(1 / 30);
    let total = 0;
    for (let k = 0; k < 20; k++) {
      const h = slow.advance(1 / 12);
      expect(h).toBeGreaterThan(0);
      total += h;
    }
    // Biriken artık bir adımdan az: zaman kaybolmaz
    expect(20 / 12 - total).toBeGreaterThanOrEqual(0);
    expect(20 / 12 - total).toBeLessThan(1 / 30);
  });

  it("ara değer: adımdan sonra 0'dan başlar, bir sonraki adıma doğru 1'e yaklaşır", () => {
    const c = new FixedStep(0.1);
    expect(c.advance(0.1)).toBeCloseTo(0.1);
    expect(c.alpha).toBeCloseTo(0);
    c.advance(0.05);
    expect(c.alpha).toBeCloseTo(0.5);
    c.advance(0.04);
    expect(c.alpha).toBeCloseTo(0.9);
    // Birleşik adım (iki adım birden): son adımdan bu yana geçen süre birleşik süreye göre
    const d = new FixedStep(0.1);
    expect(d.advance(0.25)).toBeCloseTo(0.2);
    expect(d.alpha).toBeCloseTo(1 - 0.05 / 0.2);
  });

  it("sekme uzun süre arka plandaysa tek adım, en çok 0.25 sn", () => {
    const c = new FixedStep(1 / 30);
    expect(c.advance(30)).toBeCloseTo(0.25);
    expect(c.advance(0)).toBe(0);
  });

  it("açı ara değeri ±π'de kısa yoldan döner", () => {
    expect(lerp(2, 4, 0.25)).toBe(2.5);
    expect(lerpAngle(3.0, -3.0, 0.5)).toBeCloseTo(Math.PI, 2);
    expect(lerpAngle(0.1, -0.1, 0.5)).toBeCloseTo(0);
  });
});
