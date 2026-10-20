import { describe, expect, it } from "vitest";
import { FLAG_DRIVING } from "../shared/constants";
import type { ServerEvent } from "../shared/protocol";
import { BLAST_RADIUS, computeShot, ELEV_MAX, ELEV_MIN, FIRE_COOLDOWN_MS, HIT_HEIGHT, shellAt, TANK_PARK } from "../shared/tank";

const GROUND_TIME = computeShot(0, 0, 0, []).shot.flight;
import type { SessionUser } from "../server/src/auth";
import { type Conn, Room } from "../server/src/room";

const member = (id: string): SessionUser => ({ id, name: id, avatar: null, guest: false });

class FakeConn implements Conn {
  bufferedAmount = 0;
  text: ServerEvent[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.text.push(JSON.parse(data));
  }
}

describe("computeShot", () => {
  it("lands on the ground when nobody is in the way", () => {
    const { shot, hits } = computeShot(0, 0, 0, []);
    expect(shot.flight).toBeCloseTo(GROUND_TIME);
    expect(shellAt(shot, shot.flight).y).toBeCloseTo(0, 1);
    expect(hits).toEqual([]);
  });

  it("stops at the first player in its path and knocks them away from the blast", () => {
    // Kule +z'ye bakıyor; hedef 15 m önde, yolun tam üstünde
    const { shot, hits } = computeShot(0, 0, 0, [{ sid: 7, x: 0, z: 15 }, { sid: 8, x: 0, z: 25 }]);
    const end = shellAt(shot, shot.flight);
    expect(shot.flight).toBeLessThan(GROUND_TIME);
    expect(Math.hypot(end.x, end.z - 15)).toBeLessThan(1);
    expect(hits.map((h) => h.sid)).toEqual([7]); // arkadaki 10 m ötede, patlamanın dışında
    expect(hits[0].vz).toBeGreaterThan(0);
  });

  it("raising the barrel lobs farther and over heads; lowering it lands close", () => {
    const flat = shellAt(computeShot(0, 0, 0, []).shot, GROUND_TIME).z;
    const up = computeShot(0, 0, 0, [], ELEV_MAX).shot;
    const down = computeShot(0, 0, 0, [], ELEV_MIN).shot;
    expect(shellAt(up, up.flight).z).toBeGreaterThan(flat * 2);
    expect(shellAt(down, down.flight).z).toBeLessThan(flat * 0.7);
    // Yukarı namluyla 15 m öndeki oyuncunun üstünden geçer
    expect(shellAt(up, 12 / up.vh).y).toBeGreaterThan(HIT_HEIGHT);
    expect(computeShot(0, 0, 0, [{ sid: 1, x: 0, z: 15 }], ELEV_MAX).shot.flight).toBeCloseTo(up.flight);
    // Sınır dışı açı kırpılır
    expect(computeShot(0, 0, 0, [], 3).shot.vy).toBeCloseTo(up.vy);
  });

  it("pushes bystanders inside the blast radius outward", () => {
    const { shot } = computeShot(0, 0, Math.PI / 2, []);
    const end = shellAt(shot, shot.flight);
    const { hits } = computeShot(0, 0, Math.PI / 2, [{ sid: 3, x: end.x, z: end.z + BLAST_RADIUS * 0.5 }]);
    expect(hits).toHaveLength(1);
    expect(hits[0].vz).toBeGreaterThan(0);
  });
});

describe("Room tank", () => {
  const near = (room: Room, sid: number) => {
    const s = room.players.get(sid)!.state;
    s.x = TANK_PARK.x + 2;
    s.z = TANK_PARK.z;
  };

  it("lets one nearby player drive and parks where they get out", () => {
    const room = new Room("d:t");
    const a = new FakeConn(), b = new FakeConn();
    const sa = room.join(member("a"), a, 0);
    const sb = room.join(member("b"), b, 0);
    expect(b.text.some((e) => e.t === "tank" && e.driver === 0)).toBe(true);
    expect(room.enterTank(sa)).toBe(false); // doğma noktası tanktan uzak
    near(room, sa);
    near(room, sb);
    expect(room.enterTank(sa)).toBe(true);
    expect(room.enterTank(sb)).toBe(false); // dolu
    expect(b.text.at(-1)).toMatchObject({ t: "tank", driver: sa });

    room.players.get(sa)!.state.x = TANK_PARK.x + 5;
    room.exitTank(sa);
    expect(room.tank).toMatchObject({ driver: 0, x: TANK_PARK.x + 5 });
  });

  it("only the driver keeps the driving flag, aims and fires, with a cooldown", () => {
    const room = new Room("d:t");
    const a = new FakeConn(), b = new FakeConn();
    const sa = room.join(member("a"), a, 0);
    const sb = room.join(member("b"), b, 0);
    room.applyState(sb, { ...room.players.get(sb)!.state, flags: FLAG_DRIVING }, 100);
    expect(room.players.get(sb)!.state.flags & FLAG_DRIVING).toBe(0);

    near(room, sa);
    room.enterTank(sa);
    room.aimTank(sb, 1, 1); // sürücü değil: yok sayılır
    room.aimTank(sa, 0.5, 2);
    expect(room.tank).toMatchObject({ h: 0.5, tr: 2 });
    expect(a.text.some((e) => e.t === "taim")).toBe(false); // sürücünün kendisine geri yollanmaz

    room.fire(sb, undefined, 10_000);
    room.fire(sa, undefined, 10_000);
    room.fire(sa, undefined, 10_000 + FIRE_COOLDOWN_MS - 1);
    expect(b.text.filter((e) => e.t === "shell")).toHaveLength(1);
    room.fire(sa, undefined, 10_000 + FIRE_COOLDOWN_MS);
    expect(b.text.filter((e) => e.t === "shell")).toHaveLength(2);
  });

  it("fires along the turret angle sent with the shot, even if the last aim update was lost", () => {
    const room = new Room("d:t");
    const b = new FakeConn();
    const sa = room.join(member("a"), new FakeConn(), 0);
    room.join(member("b"), b, 0);
    near(room, sa);
    room.enterTank(sa);
    room.aimTank(sa, 0, 0); // sunucunun bildiği son açı: +z
    room.fire(sa, { h: 0, tr: Math.PI / 2, el: ELEV_MAX }, 10_000); // oysa kule +x'e dönmüş, namlu kalkmıştı
    const shell = b.text.find((e) => e.t === "shell");
    expect(shell?.t === "shell" && shell.shot.dx).toBeCloseTo(1);
    expect(shell?.t === "shell" && shell.shot.dz).toBeCloseTo(0);
    expect(room.tank.tr).toBeCloseTo(Math.PI / 2);
    expect(shell?.t === "shell" && shell.shot.vy).toBeGreaterThan(5);
  });

  it("frees the tank when the driver leaves or is jailed", () => {
    const room = new Room("d:t");
    const sa = room.join(member("a"), new FakeConn(), 0);
    near(room, sa);
    room.enterTank(sa);
    room.updateJail((id) => id === "a");
    expect(room.tank.driver).toBe(0);
    expect(room.enterTank(sa)).toBe(false); // sürgündeyken binemez

    const sb = room.join(member("b"), new FakeConn(), 0);
    near(room, sb);
    room.enterTank(sb);
    room.leave(sb);
    expect(room.tank.driver).toBe(0);
  });
});
