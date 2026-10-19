import { describe, expect, it } from "vitest";
import { daylight, istanbulHour } from "../client/src/world/daynight";

describe("day/night", () => {
  it("uses Turkey time (UTC+3) and accepts an override", () => {
    expect(istanbulHour(Date.UTC(2026, 9, 19, 18, 30))).toBeCloseTo(21.5);
    expect(istanbulHour(Date.UTC(2026, 9, 19, 22, 0))).toBeCloseTo(1);
    expect(istanbulHour(0, 27)).toBe(3);
  });

  it("is full day at noon, full night at 2am and in between at dusk", () => {
    expect(daylight(12)).toBe(1);
    expect(daylight(2)).toBe(0);
    expect(daylight(23)).toBe(0);
    const dusk = daylight(19.5);
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
  });
});
