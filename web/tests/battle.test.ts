import { describe, expect, it } from "vitest";
import { BASES, COUNTDOWN_MS, COVER, END_MS, MATCH_MS, RESPAWN_MS, TANK_HP } from "../shared/arena";
import type { ServerEvent } from "../shared/protocol";
import { computeShot, FIRE_COOLDOWN_MS, shellAt } from "../shared/tank";
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

/** İki oyuncu, karşı takımlar; a, b'nin tam karşısında ve aralarında siper yok (z = 40 hattı). */
function duel() {
  const room = new Room("b:test");
  const a = new FakeConn(), b = new FakeConn();
  const sa = room.join(member("a"), a, 0);
  const sb = room.join(member("b"), b, 0);
  const battle = room.battle!;
  battle.pickTeam(sa, 0, 0);
  battle.pickTeam(sb, 1, 0);
  const place = (sid: number, x: number, z: number) => room.teleport(sid, x, z, 0, 0);
  place(sa, -15, 40);
  place(sb, 10, 40);
  return { room, battle, a, b, sa, sb, place };
}

describe("tank battle", () => {
  it("is only active in battle rooms", () => {
    expect(new Room("d:x").battle).toBeNull();
    expect(new Room("b:d:x").battle).not.toBeNull();
  });

  it("balances teams to at most one player difference and spawns at the team base", () => {
    const room = new Room("b:t");
    const conns = [new FakeConn(), new FakeConn(), new FakeConn()];
    const [s1, s2, s3] = conns.map((c, i) => room.join(member(`p${i}`), c, 0));
    const battle = room.battle!;
    expect(battle.pickTeam(s1, 0)).toBe(true);
    expect(battle.pickTeam(s2, 0)).toBe(false); // 2–0 olurdu
    expect(battle.pickTeam(s2, 1)).toBe(true);
    expect(battle.pickTeam(s3, 0)).toBe(true); // 2–1: olur
    const p1 = room.players.get(s1)!.state;
    expect(Math.hypot(p1.x - BASES[0].x, p1.z - BASES[0].z)).toBeLessThan(21);
    expect(conns[0].text.some((e) => e.t === "spawn" && e.sid === s1)).toBe(true);
  });

  it("dead or team-less tanks cannot move, and tanks stay inside the arena", () => {
    const room = new Room("b:t");
    const s = room.join(member("a"), new FakeConn(), 0);
    const before = { ...room.players.get(s)!.state };
    room.applyState(s, { x: before.x + 0.3, z: before.z, rot: 0, flags: 0 }, 100);
    expect(room.players.get(s)!.state.x).toBe(before.x); // takım yok
    room.battle!.pickTeam(s, 0, 0);
    room.teleport(s, 54.9, 0, 0, 0);
    room.applyState(s, { x: 56, z: 0, rot: 0, flags: 0 }, 200);
    expect(Math.hypot(room.players.get(s)!.state.x, room.players.get(s)!.state.z)).toBeLessThanOrEqual(55.0001);
  });

  it("three hits destroy a tank, the kill scores during a match, and it respawns", () => {
    const { room, battle, sa, sb, b, place } = duel();
    battle.tick(0); // wait → count
    expect(battle.phase).toBe("count");
    battle.tick(COUNTDOWN_MS); // maç başlar, herkes üste döner
    expect(battle.phase).toBe("play");
    place(sa, -15, 40);
    place(sb, 10, 40);

    let now = COUNTDOWN_MS + 1000;
    for (let i = 0; i < TANK_HP; i++) {
      battle.fire(sa, { h: Math.PI / 2, tr: Math.PI / 2, el: 0.03 }, now); // +x: b'ye
      now += FIRE_COOLDOWN_MS;
      battle.tick(now); // mermi ~0.5 sn'de varır
    }
    const victim = battle.tanks.get(sb)!;
    expect(victim.alive).toBe(false);
    expect(battle.score).toEqual([1, 0]);
    expect(battle.tanks.get(sa)!.kills).toBe(1);
    expect(b.text.some((e) => e.t === "kill" && e.killer === sa && e.victim === sb)).toBe(true);
    expect(room.players.get(sb)).toBeTruthy();

    battle.tick(now + RESPAWN_MS);
    expect(victim.alive).toBe(true);
    expect(victim.hp).toBe(TANK_HP);
  });

  it("no firing during the countdown, and damage waits for the shell to land", () => {
    const { battle, sa, sb } = duel();
    battle.tick(0);
    battle.fire(sa, { h: 0, tr: Math.PI / 2, el: 0.03 }, 10);
    battle.tick(COUNTDOWN_MS - 1);
    expect(battle.tanks.get(sb)!.hp).toBe(TANK_HP);

    const { battle: b2, sa: a2, sb: b2s } = duel();
    b2.fire(a2, { h: 0, tr: Math.PI / 2, el: 0.03 }, 1000); // bekleme evresinde atış serbest
    b2.tick(1001);
    expect(b2.tanks.get(b2s)!.hp).toBe(TANK_HP); // henüz uçuyor
    b2.tick(2000);
    expect(b2.tanks.get(b2s)!.hp).toBe(TANK_HP - 1);
  });

  it("the match ends on time, shows results, then counts down again", () => {
    const { battle } = duel();
    battle.tick(0);
    battle.tick(COUNTDOWN_MS);
    battle.tick(COUNTDOWN_MS + MATCH_MS);
    expect(battle.phase).toBe("end");
    battle.tick(COUNTDOWN_MS + MATCH_MS + END_MS);
    expect(battle.phase).toBe("count");
  });

  it("shells stop at cover", () => {
    const rock = COVER.find((c) => c.x === 0 && c.z === 0)!;
    // Merkezdeki kayanın arkasındaki düşman: kaya önce
    const { direct, end } = computeShot(-15, 0, Math.PI / 2, [{ sid: 9, x: 10, z: 0, r: 1.6, top: 2.4 }], 0.03, COVER);
    expect(direct).toBe(0);
    expect(Math.abs(end.x)).toBeLessThan(rock.r + 0.5);
    const free = computeShot(-15, 0, Math.PI / 2, [], 0.03);
    expect(shellAt(free.shot, free.shot.flight).x).toBeGreaterThan(10);
  });
});
