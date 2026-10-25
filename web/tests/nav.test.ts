import { describe, expect, it } from "vitest";
import { lookAhead, RoadGraph, worldRoads } from "../client/src/nav/roadGraph";
import { GARAGE, PLAZA } from "../shared/zones";
import { HOOD_ROUNDABOUT } from "../shared/build";

describe("navigasyon", () => {
  const g = new RoadGraph(worldRoads());

  it("bütün yollar birbirine bağlı", () => {
    expect(g.components()).toBe(1);
  });

  it("meydandan GAP Garaj'a ve mahalleye yol boyunca rota; rota düz çizgiden uzun ama makul", () => {
    for (const to of [GARAGE, HOOD_ROUNDABOUT]) {
      const r = g.route(PLAZA.x, PLAZA.z, to.x, to.z);
      expect(r.length).toBeGreaterThan(5);
      let len = 0;
      for (let i = 1; i < r.length; i++) len += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
      const direct = Math.hypot(to.x - PLAZA.x, to.z - PLAZA.z);
      expect(len).toBeGreaterThanOrEqual(direct * 0.99);
      expect(len).toBeLessThan(direct * 3);
      // Adımlar kısa (yoldan kopup arazide uçmuyor), baş ve son hariç
      for (let i = 2; i < r.length - 1; i++) expect(Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1])).toBeLessThan(40);
    }
  });

  it("yakın hedefe düz gidilir; ok rotada ileriyi gösterir", () => {
    expect(g.route(0, 0, 10, 10)).toEqual([[0, 0], [10, 10]]);
    const r: [number, number][] = [[0, 0], [0, 50], [50, 50]];
    const a = lookAhead(r, 0, 40, 20);
    expect(a.x).toBeCloseTo(10);
    expect(a.z).toBeCloseTo(50);
    expect(a.left).toBeCloseTo(60);
  });
});
