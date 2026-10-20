import { describe, expect, it } from "vitest";
import { FLAG_SEATED, FLAG_WALKING, JUMP_SHIFT, JUMP_TIME, jumpHeight } from "../shared/constants";
import { Remote } from "../client/src/avatars/remotes";

const info = { sid: 1, id: "u1", name: "u1", avatar: null, spectator: false, jailed: false };

/** Uzak oyuncuya 15 Hz örnek akıtıp `secs` boyunca örnekler. */
function run(r: Remote, flags: number, t0: number, secs: number, maxY = { v: 0 }): number {
  const dt = 1 / 60;
  for (let t = 0; t < secs; t += dt) {
    const now = t0 + t * 1000;
    if (Math.round(t * 60) % 4 === 0) r.push(now, 0, 0, 0, flags);
    r.sample(now - 100, dt);
    maxY.v = Math.max(maxY.v, r.jumpY);
  }
  return t0 + secs * 1000;
}

describe("jump", () => {
  it("follows the same arc for everyone and lands", () => {
    expect(jumpHeight(0)).toBe(0);
    expect(jumpHeight(JUMP_TIME / 2)).toBeGreaterThan(0.9);
    expect(jumpHeight(JUMP_TIME + 0.01)).toBe(0);
  });

  it("floats: hangs near the top and lands slower than it takes off", () => {
    const peak = Math.max(...Array.from({ length: 100 }, (_, i) => jumpHeight((i / 100) * JUMP_TIME)));
    // Sürenin üçte birinden fazlası tepenin %85'inin üstünde geçer
    let high = 0;
    for (let i = 0; i < 100; i++) if (jumpHeight(((i + 0.5) / 100) * JUMP_TIME) > peak * 0.85) high++;
    expect(high).toBeGreaterThan(33);
    const dt = 0.02;
    const takeoff = jumpHeight(dt) / dt;
    const landing = jumpHeight(JUMP_TIME - dt) / dt;
    expect(landing).toBeLessThan(takeoff);
  });

  it("remote starts a jump only when the counter changes", () => {
    const r = new Remote(info, 0);
    const peak = { v: 0 };
    let t = run(r, FLAG_WALKING, 1000, 1, peak);
    expect(peak.v).toBe(0); // ilk örnek sayacı öğrenir, zıplama sayılmaz

    t = run(r, FLAG_WALKING | (1 << JUMP_SHIFT), t, 1.5, peak);
    expect(peak.v).toBeGreaterThan(0.9);
    expect(r.jumpY).toBe(0); // indi

    // Arka arkaya ikinci zıplama da görünür
    peak.v = 0;
    t = run(r, FLAG_WALKING | (2 << JUMP_SHIFT), t, 1.5, peak);
    expect(peak.v).toBeGreaterThan(0.9);

    // Oturmak sayacı korur: sahte zıplama yok
    peak.v = 0;
    run(r, FLAG_SEATED | (2 << JUMP_SHIFT), t, 1, peak);
    expect(peak.v).toBe(0);
  });
});
