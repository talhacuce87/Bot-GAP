import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../shared/protocol";
import { ballAt, ballBlocked, BUNKERS, bunkerDist, PB, PB_BOOTH, PB_FIELD, PB_INNER, spawnSpots } from "../shared/paintball";
import { outsideWorld } from "../shared/constants";
import { terrainHeight, walkable } from "../client/src/world/terrain";
import type { SessionUser } from "../server/src/auth";
import { Paintball } from "../server/src/games/paintball";
import { type Conn, Room } from "../server/src/room";

const member = (id: string): SessionUser => ({ id, name: id, avatar: null, guest: false });

class FakeConn implements Conn {
  bufferedAmount = 0;
  text: ServerEvent[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.text.push(JSON.parse(data));
  }
  of<T extends ServerEvent["t"]>(t: T): Extract<ServerEvent, { t: T }>[] {
    return this.text.filter((e) => e.t === t) as Extract<ServerEvent, { t: T }>[];
  }
}

describe("paintball: top ve saha", () => {
  it("top bombeli gider: 30 m'de düz çizginin metrelerce altında, yere düşünce durur", () => {
    const shot = { o: [0, 1.3, 0] as [number, number, number], d: [0, 0, 1] as [number, number, number] };
    expect(ballAt(shot, 0)).toEqual({ x: 0, y: 1.3, z: 0 });
    // 30 m'ye varış anı
    let t = 0;
    while (ballAt(shot, t).z < 30) t += 0.001;
    const drop = 1.3 - ballAt(shot, t).y;
    expect(drop).toBeGreaterThan(1.5);
    expect(drop).toBeLessThan(3.5);
    // Sürtünme: ikinci 10 m ilkinden yavaş geçilir
    const at = (z: number) => {
      let s = 0;
      while (ballAt(shot, s).z < z) s += 0.001;
      return s;
    };
    expect(at(20) - at(10)).toBeGreaterThan(at(10) - at(0));
  });

  it("engel, yer ve ağ topu durdurur; boşluk durdurmaz", () => {
    const b = BUNKERS.find((k) => k.kind === "tower")!;
    expect(ballBlocked(b.ax, 1, b.az)).toEqual({ kind: "bunker", i: BUNKERS.indexOf(b) });
    expect(ballBlocked(PB_FIELD.x + 3, -0.01, PB_FIELD.z + 3)).toEqual({ kind: "ground" });
    expect(ballBlocked(PB_FIELD.x + PB_FIELD.hx + 0.2, 1.5, PB_FIELD.z)).toEqual({ kind: "net" });
    // Ağın üstünden aşan top durmaz
    expect(ballBlocked(PB_FIELD.x + PB_FIELD.hx + 0.2, 6, PB_FIELD.z)).toBeNull();
    // Üs çizgisinin önü boş
    expect(ballBlocked(PB_FIELD.x - 5, 1, PB_FIELD.z - 16.4)).toBeNull();
  });

  it("saha köyde düz ve yürünür; engeller içeride, doğma noktaları boş", () => {
    for (const [x, z] of [[PB_INNER.minX, PB_INNER.minZ], [PB_INNER.maxX, PB_INNER.maxZ], [PB_BOOTH.x - 2.1, PB_BOOTH.z]]) {
      expect(outsideWorld(x, z)).toBe(0);
      expect(terrainHeight(x, z)).toBe(0);
      expect(walkable(x, z)).toBe(true);
    }
    for (const b of BUNKERS) {
      for (const [x, z] of [[b.ax, b.az], [b.bx, b.bz]]) {
        expect(Math.abs(x - PB_FIELD.x) + b.r).toBeLessThan(PB_FIELD.hx);
        expect(Math.abs(z - PB_FIELD.z) + b.r).toBeLessThan(PB_FIELD.hz);
      }
    }
    for (const slot of [0, 1] as const) {
      for (const s of spawnSpots(slot)) for (const b of BUNKERS) expect(bunkerDist(b, s.x, s.z).d).toBeGreaterThan(b.r + 1);
    }
  });
});

function setup(wins: Record<string, number> = {}) {
  const room = new Room("g:pb");
  const reports: [number, string][] = [];
  let clock = 1_000_000;
  const pb = new Paintball(room, (sid, e) => reports.push([sid, e]), () => clock);
  pb.winsOf = async (sid) => wins[room.players.get(sid)!.user.id] ?? 0;
  const ca = new FakeConn(), cb = new FakeConn();
  const a = room.join(member("a"), ca, 0);
  const b = room.join(member("b"), cb, 0);
  const put = (sid: number, x: number, z: number) => room.teleport(sid, x, z, 0, clock);
  const atBooth = (sid: number) => put(sid, PB_BOOTH.x - 2.1, PB_BOOTH.z);
  const tick = (ms: number) => {
    // Kısa adımlarla: toplar ve geçmiş kayıtları gerçek oyundaki gibi işlensin
    for (let left = ms; left > 0; left -= 66) {
      clock += Math.min(66, left);
      pb.tick(clock);
    }
  };
  return { room, pb, reports, a, b, ca, cb, put, atBooth, tick, now: () => clock };
}

/** `from`dan `to`ya göğüs hizasında atış (yakın mesafe: düşüş ihmal edilebilir). */
function aim(from: { x: number; z: number }, to: { x: number; z: number }) {
  const o: [number, number, number] = [from.x, 1.3, from.z];
  const dx = to.x - from.x, dz = to.z - from.z, dy = 0.9 - 1.3;
  const len = Math.hypot(dx, dy, dz);
  return { o, d: [dx / len, dy / len, dz / len] as [number, number, number] };
}

/** Maçı başlatıp oyuna geçirir. */
function startMatch(s: ReturnType<typeof setup>) {
  s.atBooth(s.a);
  s.pb.join(s.a, s.now());
  s.atBooth(s.b);
  s.pb.join(s.b, s.now());
  s.tick(PB.countMs + 100);
}

describe("paintball: sunucu", () => {
  it("sıraya iki kişi girince geri sayım başlar, üslere ışınlanır, geri sayımda donar", () => {
    const s = setup();
    s.put(s.a, 0, 0);
    s.pb.join(s.a, s.now());
    expect(s.pb.state.queue).toEqual([]); // kulübeden uzak
    s.atBooth(s.a);
    s.pb.join(s.a, s.now());
    expect(s.pb.state.queue).toEqual([s.a]);
    expect(s.pb.state.phase).toBe("idle");
    s.atBooth(s.b);
    s.pb.join(s.b, s.now());
    expect(s.pb.state.phase).toBe("count");
    expect(s.pb.state.queue).toEqual([]);
    const pa = s.room.players.get(s.a)!.state, spot = spawnSpots(0)[1];
    expect(Math.hypot(pa.x - spot.x, pa.z - spot.z)).toBeLessThan(0.01);
    expect(s.pb.frozen(s.a)).toBe(true);
    s.tick(PB.countMs + 100);
    expect(s.pb.state.phase).toBe("play");
    expect(s.pb.frozen(s.a)).toBe(false);
  });

  it("isabet: rakip vurulur, donar, 3 sn sonra kendi üssünde doğar; hazne ve atış hızı sınırlı", () => {
    const s = setup();
    startMatch(s);
    const A = s.room.players.get(s.a)!.state, B = s.room.players.get(s.b)!.state;
    s.put(s.a, PB_FIELD.x, PB_FIELD.z - 6);
    s.put(s.b, PB_FIELD.x + 2, PB_FIELD.z - 1);
    s.tick(PB.safeMs);
    const shot = aim(A, B);
    s.pb.fire(s.a, shot.o, shot.d, s.now(), s.now());
    // Aynı anda ikinci atış: atış aralığı dolmadı
    s.pb.fire(s.a, shot.o, shot.d, s.now(), s.now());
    expect(s.ca.of("pbshot").length).toBe(1);
    s.tick(400);
    const vb = s.pb.state.players.find((p) => p.sid === s.b)!;
    expect(vb.alive).toBe(false);
    expect(s.pb.state.players.find((p) => p.sid === s.a)!.kills).toBe(1);
    expect(s.cb.of("pbhit")[0]).toMatchObject({ by: s.a, victim: s.b });
    expect(s.reports).toContainEqual([s.a, "pb_hit"]);
    expect(s.pb.frozen(s.b)).toBe(true);
    s.tick(PB.respawnMs + 100);
    expect(vb.alive).toBe(true);
    expect(spawnSpots(1).some((p) => Math.hypot(p.x - B.x, p.z - B.z) < 0.01)).toBe(true);
    // Hazne: 20 atış, sonra doldurmadan atılmaz
    let shots = 0;
    for (let i = 0; i < 30; i++) {
      s.tick(PB.fireMs);
      const before = s.ca.of("pbshot").length;
      s.pb.fire(s.a, [A.x, 1.3, A.z], [0, 0.2, 0.98], s.now(), s.now());
      shots += s.ca.of("pbshot").length - before;
    }
    expect(shots).toBe(PB.hopper - 1);
  });

  it("gecikme telafisi: atanın gördüğü andaki yerine bakılır", () => {
    const s = setup();
    startMatch(s);
    s.put(s.a, PB_FIELD.x, PB_FIELD.z - 6);
    s.put(s.b, PB_FIELD.x + 2, PB_FIELD.z - 1);
    s.tick(PB.safeMs + 300);
    const seen = s.now() - 200;
    // B o arada kaçtı; A 200 ms eski görüntüsüne ateş eder
    s.put(s.b, PB_FIELD.x + 5, PB_FIELD.z - 1);
    const shot = aim(s.room.players.get(s.a)!.state, { x: PB_FIELD.x + 2, z: PB_FIELD.z - 1 });
    s.pb.fire(s.a, shot.o, shot.d, seen, s.now());
    s.tick(400);
    expect(s.pb.state.players.find((p) => p.sid === s.b)!.alive).toBe(false);
  });

  it("süre bitince en çok vuran kazanır; çekilen kaybeder, oynamış sayılmaz", async () => {
    const s = setup();
    startMatch(s);
    s.put(s.a, PB_FIELD.x, PB_FIELD.z - 6);
    s.put(s.b, PB_FIELD.x + 2, PB_FIELD.z - 1);
    s.tick(PB.safeMs);
    const shot = aim(s.room.players.get(s.a)!.state, s.room.players.get(s.b)!.state);
    s.pb.fire(s.a, shot.o, shot.d, s.now(), s.now());
    s.tick(PB.matchMs);
    expect(s.pb.state.phase).toBe("end");
    expect(s.pb.state.winner).toBe(s.a);
    expect(s.reports.filter(([, e]) => e === "pb_play").length).toBe(2);
    expect(s.reports).toContainEqual([s.a, "pb_win"]);
    s.tick(PB.endMs + 100);
    expect(s.pb.state.phase).toBe("idle");
    expect(s.pb.state.players).toEqual([]);

    const t = setup();
    startMatch(t);
    t.pb.leave(t.b, t.now());
    expect(t.pb.state.winner).toBe(t.a);
    expect(t.reports).toEqual([[t.a, "pb_play"], [t.a, "pb_win"]]);
    expect(t.pb.state.players.map((p) => p.sid)).toEqual([t.a]);
  });

  it("skinler galibiyetle açılır", async () => {
    const s = setup({ a: 3 });
    s.atBooth(s.a);
    s.pb.info(s.a);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.ca.of("pbwins").at(-1)?.wins).toBe(3);
    s.pb.join(s.a, s.now());
    s.pb.skin(s.a, "orman"); // 3 galibiyet: açık
    s.pb.skin(s.b, "orman"); // b'nin galibiyeti yok
    s.atBooth(s.b);
    s.pb.join(s.b, s.now());
    const skin = (sid: number) => s.pb.state.players.find((p) => p.sid === sid)!.skin;
    expect(skin(s.a)).toBe("orman");
    expect(skin(s.b)).toBe("klasik");
    s.pb.skin(s.a, "efsane");
    expect(skin(s.a)).toBe("orman");
  });
});
