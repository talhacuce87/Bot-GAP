import { describe, expect, it } from "vitest";
import { HW, HwRun, LANES, nearMissPoints, Road, ROAD_STEP, TIERS, type TrafficCar, trafficAt, TrafficYield } from "../shared/highway";

const DT = 1 / 60;
const traffic = (o: Partial<TrafficCar>): TrafficCar => ({ id: 1, lane: 0, s: 0, d: LANES[0].d, v: LANES[0].v, look: 0, ...o });

describe("otoyol: yol", () => {
  it("aynı tohumla herkes aynı yolu görür, tohum değişince yol değişir", () => {
    const a = new Road(7), b = new Road(7), c = new Road(8);
    for (const s of [0, 500, 3333, 12000]) {
      expect(b.at(s)).toEqual(a.at(s));
    }
    expect(c.at(5000)).not.toEqual(a.at(5000));
  });

  it("virajlar ve yokuşlar var ama yol geri dönmez, dağa tırmanmaz", () => {
    const r = new Road(3);
    let maxTh = 0, maxH = 0, maxK = 0, maxG = 0, curvy = 0, hilly = 0;
    for (let s = 0; s < 40_000; s += 10) {
      const p = r.at(s);
      maxTh = Math.max(maxTh, Math.abs(p.th));
      maxH = Math.max(maxH, Math.abs(p.h));
      maxK = Math.max(maxK, Math.abs(p.k));
      maxG = Math.max(maxG, Math.abs(p.g));
      if (Math.abs(p.k) > 1 / 1000) curvy++;
      if (Math.abs(p.g) > 0.02) hilly++;
    }
    expect(maxTh).toBeLessThan(1.25);
    expect(maxH).toBeLessThan(40);
    expect(maxK).toBeLessThanOrEqual(1 / 200 + 1e-9);
    expect(maxG).toBeLessThanOrEqual(0.061);
    // Yolun önemli bir kısmı virajlı ve eğimli
    expect(curvy / 4000).toBeGreaterThan(0.3);
    expect(hilly / 4000).toBeGreaterThan(0.3);
  });

  it("orta çizgi kopmaz: ardışık noktalar örnek aralığı kadar uzakta", () => {
    const r = new Road(11);
    let prev = r.at(0);
    for (let s = ROAD_STEP; s < 5000; s += ROAD_STEP) {
      const p = r.at(s);
      expect(Math.hypot(p.x - prev.x, p.z - prev.z)).toBeCloseTo(ROAD_STEP, 2);
      prev = { ...p };
    }
  });

  it("dünyadaki nokta yoldaki yerine geri izdüşer", () => {
    const r = new Road(5);
    let hint = -1;
    for (const [s, d] of [[120, 0], [800, -6], [2500, 4.3], [6000, -9.5], [9000, 2]] as const) {
      const w = r.world(s, d);
      const p = r.project(w.x, w.z, hint);
      expect(p.s).toBeCloseTo(s, 1);
      expect(p.d).toBeCloseTo(d, 1);
      hint = p.i;
      // İpucusuz da aynı
      expect(r.project(w.x, w.z).s).toBeCloseTo(s, 1);
    }
  });

  it("orta bariyerde nadir açıklıklar var (ters şeride yalnızca oradan geçilir)", () => {
    const r = new Road(9);
    const gaps = r.gapsIn(0, 50_000);
    expect(gaps.length).toBeGreaterThan(8);
    expect(gaps.length).toBeLessThan(30);
    expect(gaps[0][0]).toBeGreaterThan(800);
    let open = 0;
    for (const [a, b] of gaps) {
      expect(b - a).toBeGreaterThanOrEqual(140);
      expect(b - a).toBeLessThanOrEqual(260);
      expect(r.gapAt((a + b) / 2)).toEqual([a, b]);
      expect(r.gapAt(a - 1)).toBeNull();
      open += b - a;
    }
    expect(open / 50_000).toBeLessThan(0.12);
  });
});

describe("otoyol: trafik", () => {
  it("aynı tohum ve saatte herkes aynı trafiği görür", () => {
    const a = trafficAt(7, 123.4, 0, 1000), b = trafficAt(7, 123.4, 0, 1000);
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
    expect(trafficAt(8, 123.4, 0, 1000)).not.toEqual(a);
  });

  it("arabalar şeridin hızıyla ilerler, aynı şeritte üst üste binmez", () => {
    const t0 = trafficAt(3, 50, 0, 2000), t1 = trafficAt(3, 51, 0, 2000);
    for (const c of t0) {
      const n = t1.find((x) => x.id === c.id);
      if (n) expect(n.s - c.s).toBeCloseTo(LANES[c.lane].v, 5);
    }
    for (let lane = 0; lane < LANES.length; lane++) {
      const ss = t0.filter((c) => c.lane === lane).map((c) => c.s).sort((p, q) => p - q);
      for (let i = 1; i < ss.length; i++) expect(ss[i] - ss[i - 1]).toBeGreaterThan(HW.length + 2);
    }
  });

  it("arkadan gelen trafik önünde duran oyuncuya çarpmaz, sırayla bekler; oyuncu gidince yetişir", () => {
    const y = new TrafficYield();
    const me = { s: 500, d: LANES[1].d };
    const lane1 = (t: number) => trafficAt(4, t, 0, 1000).filter((c) => c.lane === 1 || c.lane === 3);
    let t = 0, minGap = Infinity, overtook = false;
    // 30 sn duruyoruz
    for (; t < 30; t += DT) {
      const cars = lane1(t);
      y.apply(cars, me.s, me.d, DT);
      const behind = cars.filter((c) => c.lane === 1 && c.s <= me.s + 1).sort((a, b) => b.s - a.s);
      if (behind[0]) minGap = Math.min(minGap, me.s - behind[0].s);
      for (let i = 1; i < behind.length; i++) expect(behind[i - 1].s - behind[i].s).toBeGreaterThan(HW.length + 2);
      if (cars.some((c) => c.lane === 1 && c.s > me.s + 1 && c.s < me.s + 20 && c.s - c.v * t < me.s)) overtook = true;
    }
    expect(minGap).toBeGreaterThan(HW.length + 2);
    expect(overtook).toBe(false);
    // Karşı şerit beklemez: kendi saatindeki yerinde
    const raw = lane1(t).filter((c) => c.lane === 3);
    const after = lane1(t);
    y.apply(after, me.s, me.d, DT);
    expect(after.filter((c) => c.lane === 3).map((c) => c.s)).toEqual(raw.map((c) => c.s));
    // Oyuncu uzaklaşınca bekleyenler çizelgelerine döner
    for (let k = 0; k < 60 * 120; k++, t += DT) y.apply(lane1(t), 5000, me.d, DT);
    const free = lane1(t);
    const plain = free.map((c) => c.s);
    y.apply(free, 5000, me.d, DT);
    expect(free.filter((c) => c.s < 4000).map((c) => c.s)).toEqual(plain.filter((s) => s < 4000));
  });

  it("şeritler bariyerle otokorkuluk arasında", () => {
    for (const l of LANES) {
      expect(Math.abs(l.d) - HW.halfW).toBeGreaterThan(HW.barrier);
      expect(Math.abs(l.d) + HW.halfW).toBeLessThan(HW.rail);
    }
  });
});

describe("otoyol: makas puanı", () => {
  it("yakınlık, hız, karşı şerit ve kombo puanı artırır", () => {
    expect(nearMissPoints(0, 25, false, 1)).toBeGreaterThan(nearMissPoints(2, 25, false, 1));
    expect(nearMissPoints(2, 30, false, 1)).toBeGreaterThan(nearMissPoints(2, 15, false, 1));
    expect(nearMissPoints(2, 25, true, 1)).toBeGreaterThan(nearMissPoints(2, 25, false, 1));
    expect(nearMissPoints(2, 25, false, 4)).toBeGreaterThan(nearMissPoints(2, 25, false, 1));
    expect(nearMissPoints(2, 25, false, 99)).toBe(nearMissPoints(2, 25, false, 9));
  });

  /** Tek bir arabanın yanından `gap` boşlukla geçer: biz d = −2, v hızıyla; o 25 m önde. */
  const passBy = (gap: number, v: number, o: { oncoming?: boolean; otherV?: number; ghost?: number; touch?: boolean } = {}) => {
    const run = new HwRun();
    run.ghost = o.ghost ?? 0;
    const myD = -2, other = traffic({ id: 5, d: myD + 2 * HW.halfW + gap, s: 25, v: o.oncoming ? -18 : (o.otherV ?? 12) });
    const near = [];
    let s = 0;
    for (let i = 0; i < 60 * 6; i++) {
      const t = i * DT;
      if (o.touch && i === 60) run.touch(other.id);
      near.push(...run.update(s, myD, v, DT, [{ ...other, s: other.s + other.v * t }]).filter((e) => e.k === "near"));
      s += v * DT;
    }
    return { near, run };
  };

  it("yanından yakın geçilen araba makas sayılır, uzaktan geçilen sayılmaz", () => {
    expect(passBy(0.3, 25).near).toMatchObject([{ k: "near", tier: 0 }]);
    expect(passBy(0.8, 25).near).toMatchObject([{ tier: 1 }]);
    expect(passBy(1.9, 25).near).toMatchObject([{ tier: 2 }]);
    expect(passBy(2.5, 25).near).toHaveLength(0);
    expect(passBy(0.3, 20, { oncoming: true }).near).toMatchObject([{ tier: 0, oncoming: true }]);
  });

  it("yavaş geçmek, çarpışmasız sürede geçmek ve değmek makas sayılmaz", () => {
    expect(passBy(0.3, 10, { otherV: 3 }).near).toHaveLength(0);
    expect(passBy(0.3, 25, { ghost: 3 }).near).toHaveLength(0);
    expect(passBy(0.3, 25, { touch: true }).near).toHaveLength(0);
    const r = passBy(0.3, 25);
    expect(r.run.stats.near).toBe(1);
    expect(r.run.stats.score).toBeGreaterThanOrEqual(TIERS[0].pts);
  });

  it("hızlı giderken yol puanı akar, karşı şeritte iki katı", () => {
    const go = (d: number, v: number) => {
      const run = new HwRun();
      for (let i = 0; i <= 60; i++) run.update(i * v * DT, d, v, DT, []);
      return run.stats.score;
    };
    expect(go(-2, 20)).toBeCloseTo(5, 0);
    expect(go(2, 20)).toBeCloseTo(10, 0);
    expect(go(-2, 8)).toBe(0);
  });
});

describe("otoyol: hasar ve kaza", () => {
  it("hafif temas hasar verir ve komboyu bozar, sert temas oyunu bitirir", () => {
    const run = new HwRun();
    run.ghost = 0;
    run.combo = 3;
    expect(run.hit(4)).toMatchObject({ k: "bump" });
    expect(run.damage).toBeCloseTo(5 + 4 * 4);
    expect(run.combo).toBe(0);
    expect(run.alive).toBe(true);
    expect(run.hit(HW.hard + 1)).toMatchObject({ k: "crash" });
    expect(run.alive).toBe(false);
    expect(run.hit(3)).toBeNull();
  });

  it("çok temas hasarı doldurur", () => {
    const run = new HwRun();
    run.ghost = 0;
    let last = null;
    for (let i = 0; i < 10 && run.alive; i++) last = run.hit(8);
    expect(last).toMatchObject({ k: "crash" });
    expect(run.damage).toBe(100);
  });

  it("doğunca kısa süre çarpma sayılmaz", () => {
    const run = new HwRun();
    expect(run.hit(30)).toBeNull();
    expect(run.alive).toBe(true);
  });
});
