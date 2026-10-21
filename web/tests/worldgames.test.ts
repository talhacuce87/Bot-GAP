import { describe, expect, it } from "vitest";
import { CTF_TARGET, flagHome } from "../shared/arena";
import type { ServerEvent } from "../shared/protocol";
import { PITCH, TABLES } from "../shared/zones";
import type { SessionUser } from "../server/src/auth";
import { WorldGames } from "../server/src/games/world";
import { type Conn, Room } from "../server/src/room";

const member = (id: string): SessionUser => ({ id, name: id, avatar: null, guest: false });

class FakeConn implements Conn {
  bufferedAmount = 0;
  text: ServerEvent[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.text.push(JSON.parse(data));
  }
  last<T extends ServerEvent["t"]>(t: T): Extract<ServerEvent, { t: T }> | undefined {
    return [...this.text].reverse().find((e) => e.t === t) as Extract<ServerEvent, { t: T }> | undefined;
  }
}

function world() {
  const room = new Room("g:games");
  const reports: [number, string, number][] = [];
  const host = { play: async () => ({ title: "x" }), title: async () => "x", loadedAt: () => 0 };
  room.games = new WorldGames(room, (sid, e, n = 1) => reports.push([sid, e, n]), host);
  const a = new FakeConn(), b = new FakeConn();
  const sa = room.join(member("a"), a, 0);
  const sb = room.join(member("b"), b, 0);
  const place = (sid: number, x: number, z: number) => room.teleport(sid, x, z, 0, 0);
  return { room, games: room.games, a, b, sa, sb, place, reports };
}

describe("futbol", () => {
  it("şut kaleye girince gol sayılır, atan raporlanır ve top ortaya döner", () => {
    const { games, a, sa, place, reports } = world();
    // Topun hemen batısında, doğudaki kaleye bakarak (yön +x = π/2)
    place(sa, PITCH.x - 0.6, PITCH.z);
    games.football.kick(sa, Math.PI / 2, 0.2, 1000);
    for (let t = 1000; t < 5000; t += 66) games.football.tick(t);
    const goal = a.last("goal");
    expect(goal?.sid).toBe(sa);
    expect(goal?.side).toBe(1);
    expect(goal?.score).toEqual([1, 0]);
    expect(reports).toContainEqual([sa, "goal", 1]);
    place(sa, PITCH.x, PITCH.z + 5); // orta noktadan uzakta: dönen topa değmesin
    for (let t = 5000; t < 9000; t += 66) games.football.tick(t);
    const ball = a.last("ball")!;
    expect(Math.hypot(ball.x - PITCH.x, ball.z - PITCH.z)).toBeLessThan(0.5);
  });

  it("uzaktan şut çekilemez", () => {
    const { games, a, sa, place } = world();
    place(sa, PITCH.x + 5, PITCH.z);
    const before = a.text.length;
    games.football.kick(sa, 0, 1, 1000);
    expect(a.text.length).toBe(before);
  });
});

describe("kahvehane masaları", () => {
  it("iki kişi oturur, satranç başlar, sırası olmayan oynayamaz, pes eden kaybeder", () => {
    const { games, a, b, sa, sb, place, reports } = world();
    const t = TABLES.find((x) => x.kind === "satranc")!;
    place(sa, t.seats[0].x, t.seats[0].z);
    place(sb, t.seats[1].x, t.seats[1].z);
    expect(games.handle(sa, { t: "tsit", id: t.id, seat: 0 })).toBe(true);
    games.handle(sb, { t: "tsit", id: t.id, seat: 1 });
    games.handle(sa, { t: "tstart", id: t.id });
    expect(a.last("table")?.game?.kind).toBe("satranc");
    // e2-e4 beyaz (a); siyah (b) beyazın hamlesini yapamaz
    games.handle(sb, { t: "tmove", id: t.id, move: { from: 12, to: 28 } });
    expect((b.last("table")?.game?.state as { turn: string }).turn).toBe("w");
    games.handle(sa, { t: "tmove", id: t.id, move: { from: 12, to: 28 } });
    expect((b.last("table")?.game?.state as { turn: string }).turn).toBe("b");
    games.handle(sb, { t: "tresign", id: t.id });
    expect(a.last("table")?.note).toContain("pes etti");
    expect(reports).toContainEqual([sa, "game_win", 1]);
    expect(reports.filter((r) => r[1] === "game_play")).toHaveLength(2);
  });

  it("uzaktan oturulamaz; okey'de herkes yalnızca kendi elini görür", () => {
    const { games, a, b, sa, sb, place } = world();
    const t = TABLES.find((x) => x.kind === "okey")!;
    games.handle(sa, { t: "tsit", id: t.id, seat: 0 });
    expect(a.last("notice")?.text).toContain("uzaktasın");
    place(sa, t.seats[0].x, t.seats[0].z);
    place(sb, t.seats[2].x, t.seats[2].z);
    games.handle(sa, { t: "tsit", id: t.id, seat: 0 });
    games.handle(sb, { t: "tsit", id: t.id, seat: 2 });
    games.handle(sa, { t: "tstart", id: t.id });
    const va = a.last("table")!.game!, vb = b.last("table")!.game!;
    if (va.kind !== "okey" || vb.kind !== "okey") throw new Error("okey değil");
    expect(va.state.hand).toHaveLength(15);
    expect(vb.state.hand).toHaveLength(14);
    expect(va.state.hand.some((id) => vb.state.hand.includes(id))).toBe(false);
    // Kalkan oyunu bitirir
    games.handle(sb, { t: "tleave" });
    expect(a.last("table")?.game).toBeNull();
  });
});

describe("ebelemece", () => {
  it("katılım süresi bitince ebe seçilir, dokunan ebeliği geçirir", () => {
    const { games, a, sa, sb, place } = world();
    games.openTag(sa, "ebelemece");
    games.handle(sb, { t: "tagjoin" });
    place(sa, 0, 0);
    place(sb, 20, 20);
    games.tag.tick(Date.now() + 21_000);
    const st = a.last("tag")!.state!;
    expect(st.phase).toBe("play");
    const it = st.it, other = it === sa ? sb : sa;
    place(other, 0.5, 0);
    place(it, 0, 0);
    games.tag.tick(Date.now() + 25_000);
    expect(a.last("tag")!.state!.it).toBe(other);
  });
});

describe("bayrak kapmaca", () => {
  it("düşman bayrağını üssüne götüren takım sayı alır", () => {
    const room = new Room("b:ctf");
    const conns = [new FakeConn(), new FakeConn()];
    const [sa, sb] = conns.map((c, i) => room.join(member(`p${i}`), c, 0));
    const battle = room.battle!;
    battle.setMode(sa, "ctf", 0);
    battle.pickTeam(sa, 0, 0);
    battle.pickTeam(sb, 1, 0);
    battle.tick(1);
    battle.tick(10_000); // geri sayım bitti, maç başladı
    expect(battle.phase).toBe("play");
    const enemy = flagHome(1);
    room.teleport(sa, enemy.x, enemy.z, 0, 10_000);
    battle.tick(10_100);
    expect(battle.flags[1].carrier).toBe(sa);
    const home = flagHome(0);
    room.teleport(sa, home.x, home.z, 0, 10_200);
    battle.tick(10_300);
    expect(battle.score[0]).toBe(1);
    expect(battle.flags[1].home).toBe(true);
    expect(CTF_TARGET).toBeGreaterThan(1);
  });

  it("herkes tekte takım arkadaşı yok: takım sayısı dengelenmez", () => {
    const room = new Room("b:ffa");
    const ids = [0, 1, 2].map((i) => room.join(member(`q${i}`), new FakeConn(), 0));
    const battle = room.battle!;
    battle.setMode(ids[0], "ffa", 0);
    expect(ids.every((sid) => battle.pickTeam(sid, 0, 0))).toBe(true);
    battle.tick(1);
    expect(battle.phase).toBe("count");
  });
});

describe("saat ve hava (!saat, !hava)", () => {
  const sky = async (games: WorldGames, sid: number, text: string, canControl = false) => {
    const { runCommand, parseCommand } = await import("../server/src/chat");
    const out = { replies: [] as string[], announced: [] as string[] };
    const p = parseCommand(text)!;
    await runCommand(
      {
        user: member(`u${sid}`),
        sid,
        guild: "1",
        bot: null,
        inWatch: false,
        reply: (t) => out.replies.push(t),
        announce: (t) => out.announced.push(t),
        open: () => {},
        cinema: async () => ({ error: "x" }),
        cinemaAllowed: () => true,
        canControl: async () => canControl,
        world: {
          weather: () => "",
          fireworks: () => true,
          tag: () => null,
          tagJoin: () => {},
          enqueue: async () => "",
          queueText: () => "",
          skip: () => {},
          sky: games.sky,
        },
      },
      p.cmd,
      p.args,
    );
    return out;
  };

  it("yetkili hemen değiştirir; herkese saat gider ve süre dolunca gerçeğe döner", async () => {
    const { games, a, b, sa } = world();
    const out = await sky(games, sa, "!saat gece", true);
    expect(out.announced[0]).toContain("gece");
    expect(a.last("clock")?.hour).toBe(22);
    expect(b.last("clock")?.hour).toBe(22);
    games.sky.tick(Date.now() + 3 * 3600_000);
    expect(b.last("clock")?.hour).toBeNull();
  });

  it("yetkisiz oylama açar; ikinci oy geçirir", async () => {
    const { games, b, sa, sb } = world();
    const first = await sky(games, sa, "!hava yağmur");
    expect(first.announced[0]).toContain("1/2");
    expect(games.sky.weather().kind).toBe("clear");
    const second = await sky(games, sb, "!hava yağmur");
    expect(second.announced[0]).toContain("Oylama geçti");
    expect(games.sky.weather().kind).toBe("rain");
    expect(b.last("weather")?.weather.kind).toBe("rain");
  });

  it("aynı kişi iki kez oy veremez, saat biçimleri anlaşılır", async () => {
    const { games, sa } = world();
    await sky(games, sa, "!saat 21:30");
    const again = await sky(games, sa, "!saat 21:30");
    expect(again.announced[0]).toContain("1/2");
    expect(games.sky.hour).toBeNull();
    const bad = await sky(games, sa, "!saat yarın");
    expect(bad.replies[0]).toContain("Kullanım");
  });
});
