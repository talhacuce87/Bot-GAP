import { describe, expect, it } from "vitest";
import { ROOM_MAX_PLAYERS, WORLD_RADIUS } from "../shared/constants";
import { readSnapshot, type ServerEvent } from "../shared/protocol";
import { SESSION_TTL_MS, type SessionUser, signSession, verifySession } from "../server/src/auth";
import { type Conn, Room } from "../server/src/room";

const user = (id: string): SessionUser => ({ id, name: id, avatar: null, guest: true });

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

  it("skips snapshots for backed-up connections", () => {
    const room = new Room("g:test");
    const slow = new FakeConn();
    room.join(user("a"), slow);
    slow.bufferedAmount = 1 << 20;
    room.tick(1, true);
    expect(slow.binary.length).toBe(0);
  });
});
