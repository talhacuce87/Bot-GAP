import { describe, expect, it } from "vitest";
import { INTERP_DELAY_MS, FLAG_WALKING } from "../shared/constants";
import { InterpDelay, MAX_INTERP_MS } from "../client/src/jitter";
import { Remote } from "../client/src/avatars/remotes";

const settle = (d: InterpDelay) => {
  for (let i = 0; i < 600; i++) d.update(1 / 60);
};

describe("InterpDelay", () => {
  it("keeps the default delay on a steady line", () => {
    const d = new InterpDelay();
    for (let i = 0; i < 60; i++) d.arrived(20 + (i % 3));
    settle(d);
    expect(d.delay).toBe(INTERP_DELAY_MS);
  });

  it("grows to cover a jittery line, but ignores a rare spike", () => {
    const d = new InterpDelay();
    // Çoğu 40 ms, ara sıra 250 ms geç
    for (let i = 0; i < 45; i++) d.arrived(i % 5 === 0 ? 250 : 40);
    settle(d);
    expect(d.delay).toBeGreaterThan(250 + 60);
    expect(d.delay).toBeLessThanOrEqual(MAX_INTERP_MS);

    const e = new InterpDelay();
    for (let i = 0; i < 45; i++) e.arrived(i === 20 ? 900 : 40);
    settle(e);
    expect(e.delay).toBeLessThan(150);
  });

  it("changes smoothly and shrinks back once the line calms down", () => {
    const d = new InterpDelay();
    for (let i = 0; i < 45; i++) d.arrived(600);
    d.update(1 / 60);
    // Tek karede en fazla birkaç ms: oyuncular ışınlanmaz
    expect(d.delay - INTERP_DELAY_MS).toBeLessThan(5);
    settle(d);
    expect(d.delay).toBe(MAX_INTERP_MS);
    for (let i = 0; i < 45; i++) d.arrived(20);
    for (let i = 0; i < 60 * 30; i++) d.update(1 / 60);
    expect(d.delay).toBe(INTERP_DELAY_MS);
  });
});

describe("Remote extrapolation", () => {
  const info = { sid: 1, id: "u1", name: "u1", avatar: null, spectator: false, jailed: false };

  it("keeps a walking player moving briefly when a snapshot is late", () => {
    const r = new Remote(info, 0);
    r.push(1000, 0, 0, 0, FLAG_WALKING);
    r.push(1066, 0.3, 0, 0, FLAG_WALKING);
    r.sample(1066 + 33, 1 / 60);
    expect(r.x).toBeCloseTo(0.45, 2);
    // En fazla 100 ms ileri
    r.sample(1066 + 1000, 1 / 60);
    expect(r.x).toBeLessThan(0.3 + 0.5);
  });

  it("does not extrapolate a player who stopped", () => {
    const r = new Remote(info, 0);
    r.push(1000, 0, 0, 0, FLAG_WALKING);
    r.push(1066, 0.3, 0, 0, 0);
    r.sample(1200, 1 / 60);
    expect(r.x).toBeCloseTo(0.3, 5);
  });
});
