import { describe, expect, it } from "vitest";
import { collide, HW, type HwCar, HwRun, LANES, nearMissPoints, newCar, stepCar, TIERS, type TrafficCar, trafficAt } from "../shared/highway";

const DT = 1 / 120;
const idle = { gas: 0, brake: 0, steer: 0 };
const car = (o: Partial<HwCar>): HwCar => ({ ...newCar(), ghost: 0, ...o });
const traffic = (o: Partial<TrafficCar>): TrafficCar => ({ id: 1, lane: 0, x: LANES[0].x, z: 0, v: LANES[0].v, look: 0, ...o });

describe("otoyol: trafik", () => {
  it("aynı tohum ve saatte herkes aynı trafiği görür", () => {
    const a = trafficAt(7, 123.4, -200, 800), b = trafficAt(7, 123.4, -200, 800);
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
    expect(trafficAt(8, 123.4, -200, 800)).not.toEqual(a);
  });

  it("arabalar şeridin hızıyla ilerler, aynı şeritte üst üste binmez", () => {
    const t0 = trafficAt(3, 50, -1000, 1000), t1 = trafficAt(3, 51, -1000, 1000);
    for (const c of t0) {
      const n = t1.find((d) => d.id === c.id);
      if (n) expect(n.z - c.z).toBeCloseTo(LANES[c.lane].v, 5);
    }
    for (let lane = 0; lane < LANES.length; lane++) {
      const zs = t0.filter((c) => c.lane === lane).map((c) => c.z).sort((p, q) => p - q);
      for (let i = 1; i < zs.length; i++) expect(zs[i] - zs[i - 1]).toBeGreaterThan(HW.length + 2);
    }
  });
});

describe("otoyol: sürüş", () => {
  it("gazla ~180 km/s'ye çıkar, aşmaz; bırakınca yavaşlar", () => {
    const c = car({ v: 0 });
    for (let i = 0; i < 120 * 6; i++) stepCar(c, { gas: 1, brake: 0, steer: 0 }, DT);
    expect(c.v * 3.6).toBeGreaterThan(100);
    for (let i = 0; i < 120 * 30; i++) stepCar(c, { gas: 1, brake: 0, steer: 0 }, DT);
    expect(c.v).toBeLessThanOrEqual(HW.vmax);
    expect(c.v).toBeGreaterThan(HW.vmax * 0.95);
    const v = c.v;
    for (let i = 0; i < 120; i++) stepCar(c, idle, DT);
    expect(c.v).toBeLessThan(v);
  });

  it("şerit değiştirmek hızdan bağımsız kısa sürer, direksiyon bırakınca düz gider", () => {
    for (const v of [20, 50]) {
      const c = car({ v, x: LANES[1].x });
      let t = 0;
      while (c.x < LANES[0].x && t < 3) {
        stepCar(c, { gas: 1, brake: 0, steer: -1 }, DT);
        t += DT;
      }
      expect(t).toBeLessThan(1.2);
      for (let i = 0; i < 120; i++) stepCar(c, { gas: 1, brake: 0, steer: 0 }, DT);
      expect(Math.abs(c.a)).toBeLessThan(0.01);
    }
  });

  it("bariyere sürtünce seker, sert girince kaza", () => {
    const soft = car({ v: 30, x: HW.rail - HW.halfW - 0.005, a: 0.05 });
    const e = stepCar(soft, idle, DT);
    expect(e?.k).toBe("rail");
    expect(soft.alive).toBe(true);
    expect(soft.damage).toBeGreaterThan(0);
    const hard = car({ v: 50, x: HW.rail - HW.halfW - 0.05, a: 0.4 });
    expect(stepCar(hard, idle, DT)?.k).toBe("crash");
    expect(hard.alive).toBe(false);
  });
});

describe("otoyol: çarpışma", () => {
  it("yandan hafif temas iter ve hasar verir, oyun sürer", () => {
    const c = car({ v: 25, x: LANES[0].x - 1.75, z: 0 });
    const t = traffic({ z: 0, v: 25 });
    const hit = collide(c, [t]);
    expect(hit?.ev.k).toBe("bump");
    expect(c.alive).toBe(true);
    expect(c.damage).toBeGreaterThan(0);
    expect(c.px).toBeLessThan(0); // sağa (x−) itildi
  });

  it("arkadan hızlı bindirme ve kafa kafaya çarpışma kazadır", () => {
    const rear = car({ v: 50, x: LANES[0].x, z: -4 });
    expect(collide(rear, [traffic({ z: 0 })])?.ev.k).toBe("crash");
    const head = car({ v: 30, x: LANES[2].x, z: -4 });
    expect(collide(head, [traffic({ lane: 2, x: LANES[2].x, z: 0, v: LANES[2].v })])?.ev.k).toBe("crash");
  });

  it("doğduktan sonra kısa süre çarpışma yok", () => {
    const c = newCar(0);
    expect(collide(c, [traffic({ x: c.x, z: 1 })])).toBeNull();
  });

  it("çok temas hasarı doldurur ve oyunu bitirir", () => {
    const c = car({ v: 25, x: LANES[0].x - 1.75 });
    let crashed = false;
    for (let i = 0; i < 30 && !crashed; i++) {
      c.x = LANES[0].x - 1.75;
      crashed = collide(c, [traffic({ z: c.z, v: 25 })])?.ev.k === "crash";
    }
    expect(crashed).toBe(true);
    expect(c.damage).toBe(100);
  });
});

describe("otoyol: makas puanı", () => {
  it("yakınlık, hız, karşı şerit ve kombo puanı artırır", () => {
    expect(nearMissPoints(0, 30, false, 1)).toBeGreaterThan(nearMissPoints(2, 30, false, 1));
    expect(nearMissPoints(2, 50, false, 1)).toBeGreaterThan(nearMissPoints(2, 20, false, 1));
    expect(nearMissPoints(2, 30, true, 1)).toBeGreaterThan(nearMissPoints(2, 30, false, 1));
    expect(nearMissPoints(2, 30, false, 4)).toBeGreaterThan(nearMissPoints(2, 30, false, 1));
    expect(nearMissPoints(2, 30, false, 99)).toBe(nearMissPoints(2, 30, false, 9));
  });

  /** Tek bir arabanın yanından `gap` boşlukla geçer (karşıdan gelen ya da aynı yönde); olaylar ve sürüş döner. */
  const passBy = (gap: number, v: number, oncoming = false, gas = 1, otherV = 15) => {
    // Arabamız x = 0'da, düz gider; diğeri 25 m önde, yanında `gap` boşlukla
    const other = traffic({ id: 5, x: 2 * HW.halfW + gap, z: 25, v: oncoming ? -20 : otherV });
    const run = new HwRun(1, 0, (t, _a, _b, out) => {
      out.length = 0;
      out.push({ ...other, z: other.z + other.v * t });
      return out;
    });
    run.car = car({ v, x: 0 });
    const events = [];
    for (let i = 0; i < 120 * 5; i++) events.push(...run.update({ gas, brake: 0, steer: 0 }, DT, i * DT));
    return { near: events.filter((e) => e.k === "near"), run };
  };

  it("yanından yakın geçilen araba makas sayılır, uzaktan geçilen sayılmaz", () => {
    expect(passBy(0.3, 40).near).toMatchObject([{ k: "near", tier: 0 }]);
    expect(passBy(0.7, 40).near).toMatchObject([{ tier: 1 }]);
    expect(passBy(1.3, 40).near).toMatchObject([{ tier: 2 }]);
    expect(passBy(2.5, 40).near).toHaveLength(0);
    expect(passBy(0.3, 40, true).near).toMatchObject([{ tier: 0, oncoming: true }]);
  });

  it("yavaş giderken makas sayılmaz; makas puanı skora eklenir", () => {
    // 5 m/sn'lik arabayı puan sınırının altında (15 m/sn, gazsız) geçmek puan getirmez
    expect(passBy(0.3, 15, false, 0, 5).near).toHaveLength(0);
    const r = passBy(0.3, 40);
    expect(r.run.stats.near).toBe(1);
    expect(r.run.stats.score).toBeGreaterThanOrEqual(TIERS[0].pts);
  });

  it("doğarkenki çarpışmasız sürede yanından geçilen araba makas sayılmaz", () => {
    const other = traffic({ id: 9, x: 0, z: 10, v: 15 });
    const run = new HwRun(1, 0, (t, _a, _b, out) => {
      out.length = 0;
      out.push({ ...other, z: other.z + other.v * t });
      return out;
    });
    run.car = { ...newCar(0), x: 0, v: 40 };
    const near = [];
    for (let i = 0; i < 120 * 3; i++) near.push(...run.update({ gas: 1, brake: 0, steer: 0 }, DT, i * DT).filter((e) => e.k === "near"));
    expect(near).toHaveLength(0);
    expect(run.car.alive).toBe(true);
  });

  it("değilen araba makas sayılmaz ve kombo sıfırlanır", () => {
    const r = passBy(-0.05, 30);
    expect(r.near).toHaveLength(0);
    expect(r.run.combo).toBe(0);
    expect(r.run.car.damage).toBeGreaterThan(0);
  });
});
