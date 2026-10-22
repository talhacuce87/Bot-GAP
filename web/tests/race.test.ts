import { describe, expect, it } from "vitest";
import {
  BARRIER, CHECKPOINTS, GRID, JUMP_PENALTY, LIGHT_STEP, LIGHTS_DELAY, lightsAt, lineU, MAX_RACERS, RACE_AREA, RACE_PRIZES,
  RaceSession, START_S, TRACK, TRACK_HALF, TRACK_LENGTH, trackAt, trackProject,
} from "../shared/race";

/** Pistte `from` yay noktasından `dist` metre ileri, `step` adımlarla sürer (her adımda konum bildirir). */
function drive(race: RaceSession, sid: number, from: number, dist: number, now: { t: number }, step = 1.5, side = 0) {
  for (let d = 0; d <= dist; d += step) {
    const p = trackAt(from + d);
    now.t += 80;
    race.move(sid, p.x + p.dz * side, p.z - p.dx * side, now.t);
  }
  return from + dist;
}

describe("GAP Ring pisti", () => {
  it("orta boy: ~650 m, alanın içinde, bariyerlerle birlikte", () => {
    expect(TRACK_LENGTH).toBeGreaterThan(520);
    expect(TRACK_LENGTH).toBeLessThan(760);
    for (const p of TRACK) {
      expect(p.x - BARRIER).toBeGreaterThan(RACE_AREA.minX);
      expect(p.x + BARRIER).toBeLessThan(RACE_AREA.maxX);
      expect(p.z - BARRIER).toBeGreaterThan(RACE_AREA.minZ);
      expect(p.z + BARRIER).toBeLessThan(RACE_AREA.maxZ);
    }
  });

  it("pistin uzak parçaları birbirine bariyer payından yaklaşmaz", () => {
    let min = Infinity;
    for (let i = 0; i < TRACK.length; i += 2) {
      for (let j = i + 2; j < TRACK.length; j += 2) {
        const along = Math.min(Math.abs(TRACK[j].s - TRACK[i].s), TRACK_LENGTH - Math.abs(TRACK[j].s - TRACK[i].s));
        if (along < 45) continue;
        min = Math.min(min, Math.hypot(TRACK[i].x - TRACK[j].x, TRACK[i].z - TRACK[j].z));
      }
    }
    expect(min).toBeGreaterThan(2 * BARRIER + 1);
  });

  it("virajlar bariyerin iç tarafı kendini kesmeyecek kadar geniş", () => {
    let minR = Infinity;
    for (let i = 0; i < TRACK.length; i++) {
      const a = TRACK[i], b = TRACK[(i + 3) % TRACK.length];
      const turn = Math.abs(Math.atan2(a.dx * b.dz - a.dz * b.dx, a.dx * b.dx + a.dz * b.dz));
      const ds = (b.s - a.s + TRACK_LENGTH) % TRACK_LENGTH;
      if (turn > 1e-3) minR = Math.min(minR, ds / turn);
    }
    expect(minR).toBeGreaterThan(BARRIER + 1);
  });

  it("grid kutuları asfaltta, çizginin gerisinde ve birbirinden ayrı", () => {
    expect(GRID).toHaveLength(MAX_RACERS);
    for (const [i, g] of GRID.entries()) {
      const p = trackProject(g.x, g.z);
      expect(Math.abs(p.d)).toBeLessThan(TRACK_HALF - 1.5);
      expect(lineU(p.s)).toBeGreaterThan(TRACK_LENGTH - 60);
      for (const h of GRID.slice(i + 1)) expect(Math.hypot(g.x - h.x, g.z - h.z)).toBeGreaterThan(4);
    }
    // Ana düzlük ve pit kapısı güneyde (z ≈ −138), çizgi kapının doğusunda
    expect(Math.abs(trackAt(START_S).z + 138)).toBeLessThan(1);
    expect(trackAt(START_S).x).toBeGreaterThan(476);
  });
});

describe("yarış", () => {
  it("F1 lambaları: saniyede bir yanar, gizli bekleme sonrası hepsi söner ve yeşil yanar", () => {
    const race = new RaceSession(() => 0.5);
    expect(race.join(1, "A", 0, GRID[0].x, GRID[0].z)).toBeNull();
    expect(race.start(1, 3, 1000)).toBeNull();
    const v = race.view();
    expect(v.goAt).toBeNull();
    const t0 = 1000 + LIGHTS_DELAY;
    expect(lightsAt(v, t0 - 1).red).toBe(0);
    expect(lightsAt(v, t0).red).toBe(1);
    expect(lightsAt(v, t0 + 2 * LIGHT_STEP).red).toBe(3);
    expect(lightsAt(v, t0 + 4 * LIGHT_STEP + 10).red).toBe(5);
    expect(lightsAt(v, t0 + 9000).red).toBe(5);
    expect(race.tick(t0 + 5 * LIGHT_STEP + 100)).toBe(false);
    expect(race.tick(t0 + 5 * LIGHT_STEP + 200 + 1400)).toBe(true);
    const go = race.view();
    expect(go.phase).toBe("racing");
    expect(lightsAt(go, go.goAt! + 100)).toEqual({ red: 0, green: true });
  });

  it("yalnızca grid sahibi başlatır; dolu kutuya, uzaktan ve yarış sürerken girilmez", () => {
    const race = new RaceSession();
    expect(race.join(1, "A", 0, GRID[0].x + 30, GRID[0].z)).not.toBeNull();
    race.join(1, "A", 0, GRID[0].x, GRID[0].z);
    expect(race.join(2, "B", 0, GRID[0].x, GRID[0].z)).not.toBeNull();
    expect(race.join(2, "B", 1, GRID[1].x, GRID[1].z)).toBeNull();
    expect(race.start(2, 3, 0)).not.toBeNull();
    expect(race.start(1, 4, 0)).not.toBeNull();
    expect(race.start(1, 1, 0)).toBeNull();
    expect(race.join(3, "C", 2, GRID[2].x, GRID[2].z)).not.toBeNull();
  });

  it("turları kontrol noktalarıyla sayar; ilk bitiren kazanır, erken kalkana ceza, ödüller ilk üçe", () => {
    const race = new RaceSession(() => 0);
    for (const i of [0, 1, 2]) race.join(i + 1, `R${i}`, i, GRID[i].x, GRID[i].z);
    const now = { t: 0 };
    race.start(1, 1, now.t, (sid) => GRID[sid - 1]);
    // 3 numara lambalar yanarken kıpırdar: +5 sn
    now.t = LIGHTS_DELAY + 1000;
    expect(race.move(3, GRID[2].x + 3, GRID[2].z, now.t)).toBe(true);
    now.t = race.goAt;
    race.tick(now.t);
    expect(race.view().phase).toBe("racing");
    // 1 ve 2 tam tur atar (önce 1), 3 kısa yoldan geçemez: yalnızca çizgiyi geçip uzaklaşır
    const s1 = trackProject(GRID[0].x, GRID[0].z).s, s2 = trackProject(GRID[1].x, GRID[1].z).s;
    const lap = TRACK_LENGTH + 20;
    drive(race, 1, s1, lap, now, 1.5, 1);
    let v = race.view();
    expect(v.racers[0].sid).toBe(1);
    expect(v.racers[0].total).not.toBeNull();
    expect(v.endAt).not.toBeNull();
    drive(race, 2, s2, lap, now, 1.5, -1);
    v = race.view();
    expect(v.racers.map((r) => r.sid).slice(0, 2)).toEqual([1, 2]);
    expect(v.racers[1].gap).toBeGreaterThan(0);
    // Kısa yol: çizgiyi geçer, sonra pistin yarısına ışınlanıp çizgiye döner → tur sayılmaz
    const s3 = trackProject(GRID[2].x, GRID[2].z).s;
    drive(race, 3, s3, 40, now);
    drive(race, 3, START_S - 30, 40, now);
    expect(race.view().racers.find((r) => r.sid === 3)!.total).toBeNull();
    // Süre dolar: 3 DNF, ödüller 1 ve 2'ye
    now.t = v.endAt! + 1;
    expect(race.tick(now.t)).toBe(true);
    v = race.view();
    expect(v.phase).toBe("done");
    expect(v.racers.find((r) => r.sid === 3)!.dnf).toBe(true);
    expect(v.racers.find((r) => r.sid === 3)!.penalty).toBe(JUMP_PENALTY);
    expect([...race.rewards()]).toEqual([[1, RACE_PRIZES[0]], [2, RACE_PRIZES[1]]]);
    expect(CHECKPOINTS).toBeGreaterThan(4);
  });

  it("tek başına yarışana ödül yok; yarıştan çıkan DNF olur", () => {
    const race = new RaceSession(() => 0);
    race.join(1, "A", 0, GRID[0].x, GRID[0].z);
    race.join(2, "B", 1, GRID[1].x, GRID[1].z);
    const now = { t: 0 };
    race.start(1, 1, 0);
    now.t = race.goAt;
    race.tick(now.t);
    race.leave(2);
    drive(race, 1, trackProject(GRID[0].x, GRID[0].z).s, TRACK_LENGTH + 20, now);
    race.tick(now.t + 1);
    const v = race.view();
    expect(v.phase).toBe("done");
    expect(v.racers[1].dnf).toBe(true);
    expect(race.rewards().get(1)).toBe(RACE_PRIZES[0]);
  });
});

describe("yarış sunucusu", () => {
  it("arabasız gride geçilmez; bitince ödül cüzdana, durum herkese yayınlanır", async () => {
    const { RaceHost } = await import("../server/src/race");
    const sent: unknown[] = [];
    const players = new Map([
      [1, { info: { name: "A", car: {} as unknown }, state: { x: GRID[0].x, z: GRID[0].z } }],
      [2, { info: { name: "B", car: null as unknown }, state: { x: GRID[1].x, z: GRID[1].z } }],
    ]);
    const paid: [number, number][] = [];
    const host = new RaceHost({ players, broadcast: (ev) => sent.push(ev) }, (sid, amount) => paid.push([sid, amount]), () => 0);
    expect(host.handle(2, { t: "race", op: "join", slot: 1 }, 0)).toMatch(/Tofaş/);
    players.get(2)!.info.car = {};
    expect(host.handle(1, { t: "race", op: "join", slot: 0 }, 0)).toBeNull();
    expect(host.handle(2, { t: "race", op: "join", slot: 1 }, 0)).toBeNull();
    expect(host.handle(1, { t: "race", op: "start", laps: 1 }, 0)).toBeNull();
    expect(sent.length).toBe(3);
    const now = { t: host.session.goAt };
    host.tick(now.t);
    // 1 numara bir tur atar, 2 numara çıkar (DNF)
    for (let d = 0; d <= TRACK_LENGTH + 20; d += 1.5) {
      const p = trackAt(trackProject(GRID[0].x, GRID[0].z).s + d);
      now.t += 80;
      host.move(1, p.x, p.z, now.t);
    }
    host.leave(2, now.t);
    host.tick(now.t + 1);
    expect(host.view().phase).toBe("done");
    expect(paid).toEqual([[1, RACE_PRIZES[0]]]);
  });
});

describe("tur sayımı (gerçekçi sürüş)", () => {
  /** 30 Hz konum, 16 m/sn; her turun sayıldığı yer (çizgiye göre, m) ve görünen tur. */
  function race(slot: number, laps: number, jumpDuringLights = 0) {
    const race = new RaceSession(() => 0.3);
    const g = GRID[slot];
    race.join(1, "A", slot, g.x, g.z);
    race.start(1, laps, 0, () => g);
    let s = trackProject(g.x, g.z).s;
    const t = { now: LIGHTS_DELAY + 100 };
    // Lambalar yanarken gaza basan: çizgiyi geçer
    for (let d = 0; d < jumpDuringLights; d += 0.53) {
      s += 0.53;
      t.now += 33;
      const p = trackAt(s);
      race.move(1, p.x, p.z, Math.min(t.now, race.goAt - 1));
    }
    t.now = race.goAt;
    race.tick(t.now);
    const counted: { lap: number; at: number }[] = [];
    let lap = race.view().racers[0].lap;
    for (let i = 0; i < (laps + 1) * 1100 && race.view().racers[0].total === null; i++) {
      s += 0.53;
      t.now += 33;
      const p = trackAt(s);
      race.move(1, p.x, p.z, t.now);
      const v = race.view().racers[0];
      if (v.lap !== lap || v.total !== null) {
        const u = lineU(trackProject(p.x, p.z).s);
        counted.push({ lap: v.total !== null ? laps + 1 : v.lap, at: u > TRACK_LENGTH / 2 ? u - TRACK_LENGTH : u });
        lap = v.lap;
      }
    }
    return { counted, view: race.view().racers[0] };
  }

  it("her grid kutusundan: her tur tam bitiş çizgisinde sayılır, ilk tur dahil", () => {
    for (const slot of [0, 3, 7]) {
      const { counted, view } = race(slot, 3);
      expect(counted.map((c) => c.lap)).toEqual([2, 3, 4]);
      for (const c of counted) {
        expect(c.at).toBeGreaterThanOrEqual(0);
        expect(c.at).toBeLessThan(1.2);
      }
      expect(view.total).not.toBeNull();
    }
  });

  it("lambalar yanarken çizgiyi geçen de turunu kaybetmez (cezası yazılır)", () => {
    const { counted, view } = race(0, 3, 80);
    expect(counted.map((c) => c.lap)).toEqual([2, 3, 4]);
    expect(view.penalty).toBe(JUMP_PENALTY);
  });
});
