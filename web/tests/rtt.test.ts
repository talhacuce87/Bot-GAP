import { describe, expect, it } from "vitest";
import { KICK_COOLDOWN_MS, RttMonitor, SLOW_PINGS, STALL_MS } from "../client/src/rtt";

describe("RttMonitor", () => {
  it("shows the median, so a single spike does not move the number", () => {
    const m = new RttMonitor();
    m.reset(0);
    for (const [i, rtt] of [80, 75, 1100, 82, 78].entries()) m.sample(rtt, i * 2000);
    expect(m.rtt).toBe(80);
  });

  it("reconnects after consecutive slow pings, but not on isolated spikes", () => {
    const m = new RttMonitor();
    m.reset(0);
    let t = 0;
    const tick = (rtt: number) => m.sample(rtt, (t += 2000));
    // Arada düzelen sıçramalar: yeniden bağlanma yok
    for (let i = 0; i < 10; i++) expect(tick(i % 2 ? 900 : 80)).toBe(false);
    tick(80);
    for (let i = 1; i < SLOW_PINGS; i++) expect(tick(1000)).toBe(false);
    expect(tick(1000)).toBe(true);
  });

  it("waits out the cooldown before forcing another reconnect", () => {
    const m = new RttMonitor();
    m.reset(0);
    let t = 0;
    const slowRun = () => {
      let kicked = false;
      for (let i = 0; i < SLOW_PINGS; i++) kicked = m.sample(1000, (t += 2000)) || kicked;
      return kicked;
    };
    expect(slowRun()).toBe(true);
    m.reset(t);
    expect(slowRun()).toBe(false); // hat gerçekten kötü: döngüye girme
    t += KICK_COOLDOWN_MS;
    expect(slowRun()).toBe(true);
  });

  it("detects a connection that stopped answering", () => {
    const m = new RttMonitor();
    m.reset(0);
    m.sample(80, 2000);
    expect(m.stalled(2000 + STALL_MS - 1)).toBe(false);
    expect(m.stalled(2000 + STALL_MS + 1)).toBe(true);
  });
});
