import { describe, expect, it } from "vitest";
import { FLAG_DRIVING, FLAG_WALKING, INTERP_DELAY_MS } from "../shared/constants";
import { InterpDelay, MAX_INTERP_MS, MIN_INTERP_MS } from "../client/src/jitter";
import { Remote } from "../client/src/avatars/remotes";

const info = { sid: 1, id: "u1", name: "u1", avatar: null, spectator: false, jailed: false };

const settle = (d: InterpDelay, frames = 600) => {
  for (let i = 0; i < frames; i++) d.update(1 / 60);
};

/** 3 sn boyunca saniyede 15 ölçüm. */
const feedNeeds = (d: InterpDelay, need: (i: number) => number, start = 0) => {
  for (let i = 0; i < 45; i++) d.arrived(need(i), start + i * 66);
};

describe("InterpDelay", () => {
  it("settles just above the measured need on a steady line", () => {
    const d = new InterpDelay();
    feedNeeds(d, (i) => 120 + (i % 3));
    settle(d);
    expect(d.delay).toBeGreaterThanOrEqual(122);
    expect(d.delay).toBeLessThan(140);
  });

  it("covers a jittery line, but ignores a rare spike", () => {
    const d = new InterpDelay();
    feedNeeds(d, (i) => (i % 5 === 0 ? 300 : 120));
    settle(d);
    expect(d.delay).toBeGreaterThanOrEqual(300);
    expect(d.delay).toBeLessThanOrEqual(MAX_INTERP_MS);

    const e = new InterpDelay();
    feedNeeds(e, (i) => (i === 20 ? 900 : 120));
    settle(e);
    expect(e.delay).toBeLessThan(140);
  });

  it("never drops below one broadcast interval", () => {
    const d = new InterpDelay();
    feedNeeds(d, () => 5);
    settle(d);
    expect(d.delay).toBeCloseTo(MIN_INTERP_MS, 6);
  });

  it("changes smoothly and shrinks back once the line calms down", () => {
    const d = new InterpDelay();
    feedNeeds(d, () => 600);
    d.update(1 / 60);
    // Tek karede en fazla birkaç ms: oyuncular ışınlanmaz
    expect(d.delay - INTERP_DELAY_MS).toBeLessThan(5);
    settle(d);
    expect(d.delay).toBe(MAX_INTERP_MS);
    // Eski ölçümler pencereden çıkınca yeni hat belirler
    feedNeeds(d, () => 120, 10_000);
    settle(d, 60 * 30);
    expect(d.delay).toBeLessThan(140);
  });

  it("keeps its target when too few players move to measure", () => {
    const d = new InterpDelay();
    feedNeeds(d, () => 200);
    const t = d.target;
    d.arrived(20, 20_000);
    expect(d.target).toBe(t);
  });

  it("measures only moving players, from their previous newest sample", () => {
    const d = new InterpDelay();
    const walker = new Remote(info, 0);
    const idle = new Remote({ ...info, sid: 2 }, 0);
    for (let i = 0; i < 40; i++) {
      const t = 1000 + i * 66;
      // Örnek 66 ms aralıklı, her biri 80 ms sonra geliyor: bir öncekinin yaşı 146 ms
      d.feed(walker, t + 80, t, t, i * 0.3, 0, 0, FLAG_WALKING);
      // Duran oyuncu (saniyede bir aynı yer) ölçümü şişirmemeli
      d.feed(idle, t + 80, t, Math.floor(i / 15) * 1000, 0, 0, 0, 0);
    }
    settle(d);
    expect(d.target).toBeCloseTo(146 + 10, 0);
  });
});

describe("Remote", () => {
  it("rejects duplicate and out-of-order samples", () => {
    const r = new Remote(info, 0);
    expect(r.push(1000, 0, 0, 0, FLAG_WALKING)).toBe(true);
    expect(r.push(1000, 1, 0, 0, FLAG_WALKING)).toBe(false);
    expect(r.push(900, 1, 0, 0, FLAG_WALKING)).toBe(false);
    expect(r.newestTime).toBe(1000);
  });

  it("is moving only when walking or driving and displaced", () => {
    const r = new Remote(info, 0);
    r.push(1000, 0, 0, 0, FLAG_WALKING);
    expect(r.moving).toBe(false);
    r.push(1066, 0, 0, 1, FLAG_WALKING);
    expect(r.moving).toBe(false);
    r.push(1132, 0.3, 0, 1, FLAG_WALKING);
    expect(r.moving).toBe(true);
    r.push(1198, 0.6, 0, 1, FLAG_DRIVING);
    expect(r.moving).toBe(true);
    r.push(1264, 0.7, 0, 1, 0);
    expect(r.moving).toBe(false);
  });

  it("keeps a walking player moving briefly when a snapshot is late", () => {
    const r = new Remote(info, 0);
    r.push(1000, 0, 0, 0, FLAG_WALKING);
    r.push(1066, 0.3, 0, 0, FLAG_WALKING);
    r.sample(1066 + 33, 1 / 60);
    expect(r.x).toBeCloseTo(0.45, 2);
    // En fazla 200 ms ileri
    r.sample(1066 + 1000, 1 / 60);
    expect(r.x).toBeCloseTo(0.3 + (0.3 * 200) / 66, 3);
  });

  it("does not extrapolate a player who stopped", () => {
    const r = new Remote(info, 0);
    r.push(1000, 0, 0, 0, FLAG_WALKING);
    r.push(1066, 0.3, 0, 0, 0);
    r.sample(1200, 1 / 60);
    expect(r.x).toBeCloseTo(0.3, 5);
  });

  it("eases out an overshoot instead of snapping back", () => {
    const r = new Remote(info, 0);
    r.push(1000, 0, 0, 0, FLAG_WALKING);
    r.push(1066, 0.3, 0, 0, FLAG_WALKING);
    // Son hızla 200 ms ileri gitti (~1.2), oysa oyuncu 0.4'te durmuş
    r.sample(1066 + 250, 1 / 60);
    expect(r.x).toBeCloseTo(0.3 + (0.3 * 200) / 66, 3);
    r.push(1132, 0.4, 0, 0, 0);
    r.sample(1066 + 250 + 16, 1 / 60);
    // Tek karede 0.4'e atlamaz
    expect(r.x).toBeGreaterThan(1);
    for (let i = 0; i < 40; i++) r.sample(1300 + i * 16, 1 / 60);
    expect(r.x).toBeCloseTo(0.4, 2);
  });

  it("eases out the gap after a hold instead of jumping", () => {
    const r = new Remote(info, 0);
    r.push(1000, 0, 0, 0, FLAG_WALKING);
    // Gönderenin hattı takıldı: örnekler arası çok uzun, hız bilinmiyor, oyuncu yerinde bekler
    r.push(2300, 1, 0, 0, FLAG_WALKING);
    r.sample(2500, 1 / 60);
    expect(r.x).toBe(1);
    r.push(2400, 1.4, 0, 0, FLAG_WALKING);
    r.sample(2516, 1 / 60);
    // Yeni yer ~1.86; tek karede en fazla saniyede 6 m'lik hamle kadar yaklaşır
    expect(r.x).toBeLessThan(1 + 6 / 60 + 0.01);
    for (let i = 0; i < 60; i++) r.sample(2516, 1 / 60);
    expect(r.x).toBeCloseTo(1.4 + 0.4 * (116 / 100), 3);
  });

  it("follows the new sample seamlessly when the player kept walking", () => {
    const r = new Remote(info, 0);
    r.push(1000, 0, 0, 0, FLAG_WALKING);
    r.push(1066, 0.3, 0, 0, FLAG_WALKING);
    r.sample(1066 + 50, 1 / 60);
    const before = r.x;
    r.push(1132, 0.6, 0, 0, FLAG_WALKING);
    r.sample(1066 + 66, 1 / 60);
    // Tahmin doğruydu: düzeltme yok, akış devam ediyor
    expect(r.x - before).toBeGreaterThan(0);
    expect(r.x - before).toBeLessThan(0.1);
    expect(r.x).toBeCloseTo(0.6, 2);
  });

  it("snaps (no easing) after a teleport", () => {
    const r = new Remote(info, 0);
    r.push(1000, 0, 0, 0, FLAG_WALKING);
    r.push(1066, 0.3, 0, 0, FLAG_WALKING);
    r.sample(1200, 1 / 60);
    r.teleport(50, 50, 0);
    r.sample(1216, 1 / 60);
    expect(r.x).toBe(50);
    expect(r.z).toBe(50);
  });
});
