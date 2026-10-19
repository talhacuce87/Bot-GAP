import { describe, expect, it } from "vitest";
import { JAIL, JAIL_SPAWN, RELEASE_SPAWN, ROOM_MAX_PLAYERS, WORLD_RADIUS } from "../shared/constants";
import { readSnapshot, type ServerEvent } from "../shared/protocol";
import { SESSION_TTL_MS, type SessionUser, signSession, verifySession } from "../server/src/auth";
import { type Conn, Room } from "../server/src/room";

const user = (id: string): SessionUser => ({ id, name: id, avatar: null, guest: true });
const member = (id: string): SessionUser => ({ id, name: id, avatar: null, guest: false });

class FakeConn implements Conn {
  bufferedAmount = 0;
  text: ServerEvent[] = [];
  binary: Uint8Array[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.text.push(JSON.parse(data));
    else this.binary.push(data);
  }
}

describe("session tokens", () => {
  it("verifies a signed token", () => {
    const t = signSession(user("a"), "s3cret", 1000);
    expect(verifySession(t, "s3cret", 2000)).toEqual(user("a"));
  });

  it("rejects tampered, wrong-secret and expired tokens", () => {
    const t = signSession(user("a"), "s3cret", 1000);
    expect(verifySession(t, "other", 2000)).toBeNull();
    expect(verifySession(`x${t}`, "s3cret", 2000)).toBeNull();
    expect(verifySession(t, "s3cret", 1000 + SESSION_TTL_MS + 1)).toBeNull();
    expect(verifySession("garbage", "s3cret")).toBeNull();
  });
});

describe("Room", () => {
  it("welcomes newcomers with everyone and announces them to others", () => {
    const room = new Room("g:test");
    const a = new FakeConn();
    const b = new FakeConn();
    const sa = room.join(user("a"), a);
    const sb = room.join(user("b"), b);
    const welcome = b.text[0];
    expect(welcome.t).toBe("welcome");
    if (welcome.t === "welcome") {
      expect(welcome.you).toBe(sb);
      expect(welcome.players.map((p) => p.sid).sort()).toEqual([sa, sb].sort());
    }
    expect(a.text.some((e) => e.t === "join" && e.player.sid === sb)).toBe(true);
    room.leave(sb);
    expect(a.text.at(-1)).toEqual({ t: "leave", sid: sb });
  });

  it("limits movement speed and keeps players inside the world", () => {
    const room = new Room("g:test");
    const sid = room.join(user("a"), new FakeConn(), 0);
    const start = { ...room.players.get(sid)!.state };
    room.applyState(sid, { x: 1000, z: 0, rot: 0, flags: 1 }, 100);
    const p = room.players.get(sid)!.state;
    expect(Math.hypot(p.x - start.x, p.z - start.z)).toBeLessThan(2);
    for (let t = 200; t < 20000; t += 100) room.applyState(sid, { x: 1000, z: 0, rot: 0, flags: 1 }, t);
    expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(WORLD_RADIUS + 1.001);
  });

  it("broadcasts snapshots only when dirty, excluding spectators", () => {
    const room = new Room("g:test");
    const conns: FakeConn[] = [];
    for (let i = 0; i <= ROOM_MAX_PLAYERS; i++) {
      const c = new FakeConn();
      conns.push(c);
      room.join(user(`u${i}`), c);
    }
    const last = conns.at(-1)!;
    const w = last.text[0];
    expect(w.t === "welcome" && w.players[0].spectator).toBe(true);

    room.tick(1);
    let count = 0;
    readSnapshot(new DataView(last.binary[0].buffer), () => count++);
    expect(count).toBe(ROOM_MAX_PLAYERS);

    room.tick(2);
    expect(last.binary.length).toBe(1); // değişiklik yok → yayın yok
    room.tick(3, true);
    expect(last.binary.length).toBe(2);
  });

  it("promotes the oldest spectator when an active player leaves", () => {
    const room = new Room("g:test");
    const sids: number[] = [];
    for (let i = 0; i < ROOM_MAX_PLAYERS + 2; i++) sids.push(room.join(user(`u${i}`), new FakeConn()));
    const watcher = new FakeConn();
    room.join(user("watcher"), watcher); // izleyici, olayları dinler
    room.leave(sids[0]);
    const firstSpectator = sids[ROOM_MAX_PLAYERS];
    expect(room.players.get(firstSpectator)!.info.spectator).toBe(false);
    expect(room.players.get(sids[ROOM_MAX_PLAYERS + 1])!.info.spectator).toBe(true);
    expect(watcher.text.some((e) => e.t === "join" && e.player.sid === firstSpectator && !e.player.spectator)).toBe(true);
  });

  it("skips snapshots for backed-up connections", () => {
    const room = new Room("g:test");
    const slow = new FakeConn();
    room.join(user("a"), slow);
    slow.bufferedAmount = 1 << 20;
    room.tick(1, true);
    expect(slow.binary.length).toBe(0);
  });
});

describe("jail", () => {
  it("spawns exiled players in the cell and keeps them inside", () => {
    const room = new Room("d:x");
    const sid = room.join(member("1"), new FakeConn(), 0, { jailed: true });
    const p = room.players.get(sid)!;
    expect(p.state.x).toBe(JAIL_SPAWN.x);
    for (let t = 100; t < 10000; t += 100) room.applyState(sid, { x: 0, z: 5, rot: 0, flags: 1 }, t);
    expect(p.state.x).toBeLessThanOrEqual(JAIL.maxX);
    expect(p.state.z).toBeGreaterThanOrEqual(JAIL.minZ);
  });

  it("jails and releases live, announcing the teleport to everyone", () => {
    const room = new Room("d:x");
    const watcher = new FakeConn();
    room.join(member("2"), watcher, 0, { guild: "123456" });
    const sid = room.join(member("1"), new FakeConn(), 0, { guild: "123456" });
    const exiled = new Set(["1"]);
    room.updateJail((id, guild) => guild === "123456" && exiled.has(id));
    let ev = watcher.text.at(-1)!;
    expect(ev).toMatchObject({ t: "jail", sid, jailed: true, x: JAIL_SPAWN.x, z: JAIL_SPAWN.z });

    const before = watcher.text.length;
    room.updateJail((id) => exiled.has(id)); // değişiklik yok → olay yok
    expect(watcher.text.length).toBe(before);

    exiled.clear();
    room.updateJail(() => false);
    ev = watcher.text.at(-1)!;
    expect(ev).toMatchObject({ t: "jail", sid, jailed: false, x: RELEASE_SPAWN.x });
  });

  it("never jails guests unless they asked for the test cell", () => {
    const room = new Room("g:x");
    const a = room.join(user("guest-a"), new FakeConn());
    const b = room.join(user("guest-b"), new FakeConn(), 0, { jailed: true, forceJail: true });
    room.updateJail(() => true);
    expect(room.players.get(a)!.info.jailed).toBe(false);
    room.updateJail(() => false);
    expect(room.players.get(b)!.info.jailed).toBe(true);
  });
});

describe("flags", () => {
  it("keeps jump counter and running bits, drops unknown bits", () => {
    const room = new Room("g:f");
    const sid = room.join(user("a"), new FakeConn(), 0);
    room.applyState(sid, { x: 0, z: 8, rot: 0, flags: 0b1101 | 16 | 128 }, 100);
    expect(room.players.get(sid)!.state.flags).toBe(0b1101 | 16);
  });
});
