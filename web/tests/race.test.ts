import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../shared/protocol";
import { advance, autopilot, CAR, gridSpot, newCar, newProgress, project, RACE, sectorOf, stepCar, type Track, trackOf, TRACKS } from "../shared/race";
import { RACE_HOUSE } from "../shared/zones";
import type { SessionUser } from "../server/src/auth";
import { WorldGames } from "../server/src/games/world";
import { type Conn, Room } from "../server/src/room";

/** Yarışı bitirene kadar sürer; turlar ve süre (sn) döner. */
function drive(t: Track, maxS = 180) {
  const c = newCar(t, 0);
  const prog = newProgress();
  let time = 0, walls = 0, maxNitro = 0;
  const dt = 1 / 120;
  while (time < maxS && prog.lap <= RACE.laps) {
    const inp = autopilot(t, c);
    if (stepCar(c, inp, dt, t) > 0) walls++;
    advance(t, prog, c.hint);
    maxNitro = Math.max(maxNitro, c.nitro);
    time += dt;
  }
  return { prog, time, walls, c, maxNitro };
}

describe("oyuncak pist: pistler ve fizik", () => {
  it("her pist sürülebilir: otomatik pilot 3 turu bitirir", () => {
    for (let i = 0; i < TRACKS.length; i++) {
      const t = trackOf(i);
      const r = drive(t);
      expect(r.prog.lap, TRACKS[i].name).toBeGreaterThan(RACE.laps);
      // Bir yarış makul sürede biter (tur başına ~10–40 sn)
      expect(r.time, TRACKS[i].name).toBeLessThan(120);
      expect(r.time, TRACKS[i].name).toBeGreaterThan(20);
    }
  });

  it("başlangıç kutuları pistte ve çizginin gerisinde (son sektör)", () => {
    for (let i = 0; i < TRACKS.length; i++) {
      const t = trackOf(i);
      for (let slot = 0; slot < RACE.max; slot++) {
        const g = gridSpot(t, slot);
        const p = project(t, g.x, g.z);
        expect(Math.abs(p.d)).toBeLessThan(RACE.halfW - CAR.r * 0.6);
        expect(sectorOf(t, p.i)).toBe(RACE.sectors - 1);
      }
    }
  });

  it("drift nitro doldurur, nitro azami hızı aşırır, duvar arabayı pistte tutar", () => {
    const t = trackOf(4);
    // Düz giderken hızlan
    const c = newCar(t, 0);
    let top = 0;
    for (let k = 0; k < 240; k++) {
      stepCar(c, { throttle: 1, steer: 0, drift: false, nitro: false }, 1 / 120, t);
      top = Math.max(top, Math.hypot(c.vx, c.vz));
    }
    expect(top).toBeGreaterThan(CAR.maxV * 0.7);
    expect(top).toBeLessThanOrEqual(CAR.maxV + 0.01);
    // Drift: hızlıyken dönerken Space (kısa, duvara varmadan); yanlamasına kayar, nitro dolar
    const dr = newCar(t, 0);
    dr.vx = Math.cos(dr.a) * 28;
    dr.vz = Math.sin(dr.a) * 28;
    let drifted = false;
    for (let k = 0; k < 36; k++) {
      stepCar(dr, { throttle: 1, steer: -1, drift: true, nitro: false }, 1 / 120, t);
      drifted ||= dr.drift;
    }
    expect(drifted).toBe(true);
    expect(dr.nitro).toBeGreaterThan(0.03);
    // Duvara rağmen pistin içinde
    expect(Math.abs(project(t, c.x, c.z, c.hint).d)).toBeLessThanOrEqual(RACE.halfW);
    // Nitro: dolu depoyla azami hızın üstüne çıkar
    const d = newCar(t, 0);
    d.nitro = 1;
    let best = 0;
    for (let k = 0; k < 240; k++) {
      stepCar(d, { throttle: 1, steer: 0, drift: false, nitro: true }, 1 / 120, t);
      best = Math.max(best, Math.hypot(d.vx, d.vz));
    }
    expect(best).toBeGreaterThan(CAR.maxV);
    expect(d.nitro).toBeLessThan(1);
  });

  it("sektör atlanırsa tur sayılmaz (kestirme yok)", () => {
    const t = trackOf(0);
    const p = newProgress();
    advance(t, p, 0); // çizgiyi geç: 1. tur
    expect(p.lap).toBe(1);
    advance(t, p, Math.floor(t.n * 0.6)); // ortadaki sektörlere atlamak sayılmaz
    advance(t, p, 0);
    expect(p.lap).toBe(1);
  });
});

const member = (id: string): SessionUser => ({ id, name: id, avatar: null, guest: false });

class FakeConn implements Conn {
  bufferedAmount = 0;
  text: ServerEvent[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.text.push(JSON.parse(data));
  }
}

function room() {
  const r = new Room("g:race");
  const reports: [number, string][] = [];
  const host = { play: async () => ({ title: "x" }), title: async () => "x", loadedAt: () => 0 };
  r.games = new WorldGames(r, (sid, e) => reports.push([sid, e]), host);
  const sa = r.join(member("a"), new FakeConn(), 0);
  const sb = r.join(member("b"), new FakeConn(), 0);
  for (const sid of [sa, sb]) r.teleport(sid, RACE_HOUSE.x, RACE_HOUSE.z, 0, 0);
  return { r, race: r.games.race, sa, sb, reports };
}

describe("oyuncak pist: sunucu", () => {
  it("tek kişi sürebilir ama ödül almaz", () => {
    const { race, sa, reports } = room();
    race.join(sa);
    race.start(sa, 0);
    expect(race.state?.phase).toBe("countdown");
    race.tick(RACE.countdownMs);
    const t = trackOf(0);
    let now = RACE.countdownMs;
    for (let lap = 0; lap <= RACE.laps && !race.state?.players[0].place; lap++) {
      for (let i = lap === 0 ? t.n - 2 : 0; i < t.n; i += 3) {
        now += 100;
        race.car(sa, t.px[i % t.n], t.pz[i % t.n], 0, 0, now);
      }
      now += 100;
      race.car(sa, t.px[1], t.pz[1], 0, 0, now);
    }
    expect(race.state?.phase).toBe("end");
    expect(race.state?.players[0].place).toBe(1);
    expect(reports).toHaveLength(0);
  });

  it("binada katılınır, lobiyi açan pisti seçip başlatır", () => {
    const { r, race, sa, sb } = room();
    race.join(sa);
    expect(race.state?.host).toBe(sa);
    race.join(sb);
    race.setTrack(sb, 2); // lobi sahibi değil
    expect(race.state?.track).toBe(0);
    race.setTrack(sa, 3);
    race.start(sb, 1000); // lobi sahibi değil
    expect(race.state?.phase).toBe("lobby");
    race.start(sa, 1000);
    expect(race.state?.phase).toBe("countdown");
    expect(race.racing(sa) && race.racing(sb)).toBe(true);
    // Binanın dışından katılınmaz
    const sc = r.join(member("c"), new FakeConn(), 0);
    race.join(sc);
    expect(race.state?.players.some((p) => p.sid === sc)).toBe(false);
  });

  it("turlar sıradan sayılır, bitiren sıralanır, kazanan raporlanır; ışınlanma yok sayılır", () => {
    const { race, sa, sb, reports } = room();
    race.join(sa);
    race.join(sb);
    race.setTrack(sa, 1);
    race.start(sa, 0);
    const t = trackOf(1);
    let now = RACE.countdownMs;
    race.tick(now);
    expect(race.state?.phase).toBe("race");
    // Işınlanma: pistin yarısına atlamak kabul edilmez
    const far = Math.floor(t.n / 2);
    race.car(sb, t.px[far], t.pz[far], 0, 0, now + 50);
    expect(race.state?.players.find((p) => p.sid === sb)?.lap).toBe(0);
    // A pist boyunca sürer (orta çizgi, gerçekçi hızla): 3 tur
    const step = 3;
    for (let lap = 0; lap <= RACE.laps && !race.state?.players.find((p) => p.sid === sa)?.place; lap++) {
      for (let i = lap === 0 ? t.n - 2 : 0; i < t.n; i += step) {
        now += 100;
        race.car(sa, t.px[i % t.n], t.pz[i % t.n], 0, 0, now);
        race.tick(now);
      }
      now += 100;
      race.car(sa, t.px[1], t.pz[1], 0, 0, now);
    }
    const a = race.state!.players.find((p) => p.sid === sa)!;
    expect(a.place).toBe(1);
    expect(a.time).toBeGreaterThan(0);
    // İlk bitirenden sonra süre dolunca yarış biter; B ikinci olur
    race.tick(now + RACE.finishWaitMs + 1);
    expect(race.state?.phase).toBe("end");
    expect(race.state?.players.find((p) => p.sid === sb)?.place).toBe(2);
    expect(reports).toContainEqual([sa, "race_win"]);
    expect(reports.filter(([, e]) => e === "race_play")).toHaveLength(2);
    // Sonuçtan sonra lobiye dönülür
    race.tick(now + RACE.finishWaitMs + RACE.resultMs + 10);
    expect(race.state?.phase).toBe("lobby");
    expect(race.state?.host).toBe(sa);
  });
});
