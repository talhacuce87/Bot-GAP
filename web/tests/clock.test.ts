import { describe, expect, it } from "vitest";
import { JUMP_MS, Pacer, ServerClock, SLEW } from "../client/src/clock";

describe("ServerClock", () => {
  it("takes the first measurement at once and trusts the lowest-RTT one", () => {
    const c = new ServerClock();
    expect(c.synced).toBe(false);
    // Sunucu yerelden 5000 ms ileride; gidiş 20, dönüş 20 ms
    expect(c.sample(1000, 6020, 1040)).toBe(40);
    expect(c.synced).toBe(true);
    expect(c.offsetAt(1040)).toBe(5000);
    // Yavaş ölçüm (gidiş 100, dönüş 20): ofseti 40 ms kaydırırdı, ama daha iyi ölçüm varken yok sayılır
    c.sample(3000, 8100, 3120);
    expect(c.offsetAt(5000)).toBe(5000);
  });

  it("slews small corrections instead of jumping", () => {
    const c = new ServerClock();
    c.sample(1000, 6020, 1040);
    // Daha iyi ölçüm: ofset 5010 çıkıyor
    c.sample(2000, 7020, 2020);
    expect(c.offsetAt(2020)).toBe(5000);
    expect(c.offsetAt(2020 + 100)).toBeCloseTo(5000 + 100 * SLEW, 6);
    expect(c.offsetAt(2020 + 10 / SLEW)).toBeCloseTo(5010, 6);
    expect(c.offsetAt(10_000)).toBeCloseTo(5010, 6);
  });

  it("never runs backwards while slewing", () => {
    const c = new ServerClock();
    c.sample(1000, 6020, 1040);
    c.sample(2000, 6990, 2020); // ofset 4980: geri düzeltme
    let prev = -Infinity;
    for (let t = 2020; t < 4000; t += 16) {
      const now = c.now(t);
      expect(now).toBeGreaterThan(prev);
      prev = now;
    }
  });

  it("jumps when the correction is large", () => {
    const c = new ServerClock();
    c.sample(1000, 6020, 1040);
    c.sample(2000, 2000 + 5000 + JUMP_MS + 100 + 10, 2020);
    expect(c.offsetAt(2020)).toBe(5000 + JUMP_MS + 100);
  });

  it("keeps its offset across a reconnect", () => {
    const c = new ServerClock();
    c.sample(1000, 6020, 1040);
    c.reset();
    expect(c.synced).toBe(false);
    expect(c.now(2000)).toBe(7000);
    c.sample(3000, 8030, 3040); // ofset 5010: yakın, yavaşça oturur
    expect(c.offsetAt(3040)).toBe(5000);
  });
});

describe("Pacer", () => {
  it("fires at the exact average rate with uneven frames", () => {
    const p = new Pacer(30);
    let fired = 0;
    let seed = 1;
    for (let i = 0; i < 60 * 60; i++) {
      seed = (seed * 16807) % 2147483647;
      if (p.due(1 / 60 + ((seed / 2147483647) - 0.5) * 0.002)) fired++;
    }
    expect(fired).toBeGreaterThanOrEqual(30 * 60 - 2);
    expect(fired).toBeLessThanOrEqual(30 * 60 + 2);
  });

  it("does not burst after a long frame", () => {
    const p = new Pacer(30);
    expect(p.due(0.51)).toBe(true);
    expect(p.due(1 / 60)).toBe(false);
  });
});
