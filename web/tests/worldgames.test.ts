import { describe, expect, it, vi } from "vitest";
import { BILEK_LOSE } from "../shared/games/bilek";
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

/** Ortanın 0.6 batısından doğu kalesinin köşesine (kalecinin uzağına) yön. */
const CORNER = Math.atan2(PITCH.hx + 0.6, PITCH.goalHalf - 0.7);

describe("futbol", () => {
  it("şut kaleye girince gol sayılır, atan raporlanır ve top ortaya döner", () => {
    const { games, a, sa, place, reports } = world();
    games.football.random = () => 0.999; // kaleci şutu okuyamasın
    // Topun hemen batısında, doğudaki kalenin köşesine (kalecinin içinden top geçmez)
    place(sa, PITCH.x - 0.6, PITCH.z);
    games.football.kick(sa, CORNER, 0.5, 1000);
    place(sa, PITCH.x, PITCH.z + 5); // orta noktadan uzakta: ortaya dönen topu almasın
    for (let t = 1000; t < 5000; t += 66) games.football.tick(t);
    const goal = a.last("goal");
    expect(goal?.sid).toBe(sa);
    expect(goal?.side).toBe(1);
    expect(goal?.score).toEqual([1, 0]);
    expect(reports).toContainEqual([sa, "goal", 1]);
    for (let t = 5000; t < 9000; t += 66) games.football.tick(t);
    const ball = a.last("ball")!;
    expect(Math.hypot(ball.x - PITCH.x, ball.z - PITCH.z)).toBeLessThan(0.5);
  });

  it("pas, baktığı yöndeki oyuncuya yerden gider", () => {
    const { games, a, sa, sb, place } = world();
    place(sa, PITCH.x - 0.6, PITCH.z);
    // b sağ çaprazda (yaklaşık 20° sapma): pas ona yönelir
    place(sb, PITCH.x + 8, PITCH.z + 3);
    games.football.kick(sa, Math.PI / 2, 0.3, 1000, "pass");
    const ball = a.last("ball")!;
    expect(ball.ev).toBe("pass");
    expect(ball.vy).toBe(0);
    expect(Math.atan2(ball.vx, ball.vz)).toBeCloseTo(Math.atan2(8.6, 3), 1);
  });

  it("falsolu şut kavis çizer, aşırtma yükselir", () => {
    const { games, sa, place } = world();
    place(sa, PITCH.x - 0.6, PITCH.z);
    games.football.kick(sa, Math.PI / 2, 0.5, 1000, "shot", 1);
    for (let t = 1000; t < 1500; t += 66) games.football.tick(t);
    const s = games.football.state(1500);
    // +x'e bakarken sağ +z yönü: top +z'ye kıvrılır
    expect(s.z).toBeGreaterThan(PITCH.z + 0.2);
    const w2 = world();
    w2.place(w2.sa, PITCH.x - 0.6, PITCH.z);
    w2.games.football.kick(w2.sa, Math.PI / 2, 1, 1000, "lob");
    let peak = 0;
    for (let t = 1000; t < 2500; t += 66) {
      w2.games.football.tick(t);
      peak = Math.max(peak, w2.games.football.state(t).y);
    }
    expect(peak).toBeGreaterThan(2.5);
  });

  it("direğe çarpan top seker ve gol olmaz", () => {
    const { games, a, sa, sb, place } = world();
    games.football.random = () => 0.5; // sapma yok, kaleci kurtaramaz
    // Ortadan doğu kalesinin direğine (z = +goalHalf) doğru sert şut
    place(sa, PITCH.x - 0.6, PITCH.z);
    place(sb, PITCH.x - 20, PITCH.z);
    games.football.kick(sa, Math.atan2(PITCH.hx, PITCH.goalHalf), 1, 1000, "shot");
    place(sa, PITCH.x - 8, PITCH.z - 6);
    let post = false;
    for (let t = 1000; t < 3000; t += 66) {
      games.football.tick(t);
      if (a.last("ball")?.ev === "post") post = true;
    }
    expect(post).toBe(true);
    expect(a.last("goal")).toBeUndefined();
  });

  it("maç: takımlar yarıya göre kurulur, süre bitince kazanan duyurulur", () => {
    const { games, room, a, sa, sb, place } = world();
    games.football.random = () => 0.999;
    place(sa, PITCH.x - 5, PITCH.z);
    place(sb, PITCH.x + 5, PITCH.z);
    expect(games.football.startMatch(1, 1000)).toBeNull();
    expect(a.last("match")?.match?.teams).toEqual([[sa], [sb]]);
    // Kırmızı (a) doğu kalesine atar: skor [1, 0]
    place(sb, PITCH.x, PITCH.z + 6);
    place(sa, PITCH.x - 0.6, PITCH.z);
    for (let t = 1000; t < 3600; t += 66) games.football.tick(t);
    games.football.kick(sa, CORNER, 0.5, 3600);
    for (let t = 3600; t < 8000; t += 66) games.football.tick(t);
    expect(a.last("goal")?.score).toEqual([1, 0]);
    games.football.tick(62_000);
    expect(a.last("match")?.match).toBeNull();
    expect(room.chat.at(-1)?.text).toContain("Kırmızı takım kazandı");
  });

  it("topa yaklaşan topu alır, top önünde gider; rakip müdahaleyle kapar", () => {
    const { games, a, sa, sb, place } = world();
    games.football.random = () => 0.1;
    place(sb, PITCH.x - 10, PITCH.z + 6);
    place(sa, PITCH.x - 0.5, PITCH.z);
    games.football.tick(1000);
    expect(games.football.ownerSid).toBe(sa);
    // Doğuya koşar (rot π/2): top hep önünde
    for (let i = 1; i <= 10; i++) {
      place(sa, PITCH.x - 0.5 + i * 0.4, PITCH.z);
      games.football.tick(1000 + i * 66);
    }
    const s = games.football.state(2000);
    expect(s.x).toBeGreaterThan(PITCH.x + 3);
    // Rakip önden gelip müdahale eder
    place(sb, s.x + 0.9, PITCH.z);
    games.football.tackle(sb, 3000);
    expect(games.football.ownerSid).not.toBe(sa);
    expect(a.last("ball")?.ev).toBe("tackle");
  });

  it("halı saha: yan duvara giden top seker, oyun durmaz (taç yok)", () => {
    const { games, a, sa, sb, place } = world();
    place(sb, PITCH.x - 10, PITCH.z - 6);
    place(sa, PITCH.x - 0.6, PITCH.z);
    // Güneye (+z) sert pas: yan duvara çarpar
    games.football.kick(sa, 0, 1, 1000, "pass");
    place(sa, PITCH.x - 8, PITCH.z - 5);
    let back = false;
    for (let t = 1000; t < 4500; t += 66) {
      games.football.tick(t);
      const s = games.football.state(t);
      expect(Math.abs(s.z - PITCH.z)).toBeLessThanOrEqual(PITCH.hz);
      if (s.vz < 0) back = true;
    }
    expect(back).toBe(true);
    expect(a.last("fb")).toBeUndefined();
  });

  it("kaleci kaleye gelen şutu kurtarır", () => {
    const { games, a, sa, sb, place } = world();
    games.football.random = () => 0; // kaleci hep kurtarır
    place(sb, PITCH.x - 10, PITCH.z + 6);
    place(sa, PITCH.x - 0.6, PITCH.z);
    games.football.kick(sa, Math.PI / 2, 0.3, 1000);
    place(sa, PITCH.x - 6, PITCH.z - 5);
    let saved = false;
    for (let t = 1000; t < 5000; t += 66) {
      games.football.tick(t);
      if (a.last("ball")?.ev === "save") saved = true;
    }
    expect(saved).toBe(true);
    expect(a.last("goal")).toBeUndefined();
  });

  it("kaleci şutu okuyamasa da üstüne gelen top içinden geçmez, takılan karede bile", () => {
    const { games, a, sa, sb, place } = world();
    games.football.random = () => 0.999; // hiçbir şutu okuyamaz
    place(sb, PITCH.x - 10, PITCH.z + 6);
    place(sa, PITCH.x - 0.6, PITCH.z);
    games.football.kick(sa, Math.PI / 2, 1, 1000);
    place(sa, PITCH.x - 6, PITCH.z - 5);
    // Sunucu takılıyor: 200 ms'lik kareler (top karede metrelerce yol alır)
    let saved = false;
    for (let t = 1000; t < 5000; t += 200) {
      games.football.tick(t);
      if (a.last("ball")?.ev === "save") saved = true;
    }
    expect(saved).toBe(true);
    expect(a.last("goal")).toBeUndefined();
  });

  it("kalecinin elindeki top alınamaz; kaleci kendisine şut çekene değil arkadaşına pas verir", () => {
    const { room, games, a, sa, sb, place } = world();
    games.football.random = () => 0;
    const c = room.join(member("c"), new FakeConn(), 0);
    place(sb, PITCH.x - 10, PITCH.z + 6);
    place(c, PITCH.x + 10, PITCH.z - 6);
    place(sa, PITCH.x - 0.6, PITCH.z);
    games.football.kick(sa, Math.PI / 2, 0.3, 1000);
    let t = 1000;
    for (; t < 5000 && games.football.ownerSid >= 0; t += 66) {
      place(sa, Math.min(PITCH.x + PITCH.hx - 1.2, PITCH.x + (t - 1000) / 200), PITCH.z);
      games.football.tick(t);
    }
    expect(games.football.ownerSid).toBe(-2);
    // Şutu çeken kalecinin dibinde: ne müdahale ne vuruş ne de üstüne basmak topu alır
    const held = games.football.state(t);
    place(sa, held.x - 0.3, held.z);
    games.football.tackle(sa, t + 10);
    games.football.kick(sa, -Math.PI / 2, 1, t + 20);
    for (let i = 0; i < 10; i++) games.football.tick(t + 30 + i * 30);
    expect(games.football.ownerSid).toBe(-2);
    // Elinden çıkarınca c'ye (topu ona getiren a'ya değil)
    let pass;
    for (t += 330; t < 8000 && !pass; t += 66) {
      games.football.tick(t);
      const e = a.last("ball");
      if (e?.ev === "pass" && e.by === -2) pass = e;
    }
    expect(pass).toBeDefined();
    const toC = Math.atan2(PITCH.x + 10 - pass!.x, PITCH.z - 6 - pass!.z);
    expect(Math.abs(Math.atan2(pass!.vx, pass!.vz) - toC)).toBeLessThan(0.2);
  });

  it("kaleciye sürülen top elinde kalır", () => {
    const { games, sa, sb, place } = world();
    place(sb, PITCH.x - 10, PITCH.z + 6);
    place(sa, PITCH.x + 10, PITCH.z);
    games.football.tick(900);
    games.football.tick(1000);
    // Topu al, doğu kalesine doğru sür
    place(sa, PITCH.x - 0.5, PITCH.z);
    games.football.tick(1066);
    expect(games.football.ownerSid).toBe(sa);
    for (let i = 1; i <= 80 && games.football.ownerSid === sa; i++) {
      place(sa, PITCH.x - 0.5 + i * 0.4, PITCH.z);
      games.football.tick(1066 + i * 66);
    }
    expect(games.football.ownerSid).toBe(-2);
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

  it("bilek güreşi: çember sunucu saatinde döner, yayda basan tutturur, ${BILEK_LOSE} fark kaçıran kaybeder", () => {
    const { games, a, sa, sb, place, reports } = world();
    const t = TABLES.find((x) => x.kind === "bilek")!;
    place(sa, t.seats[0].x, t.seats[0].z);
    place(sb, t.seats[1].x, t.seats[1].z);
    games.handle(sa, { t: "tsit", id: t.id, seat: 0 });
    games.handle(sb, { t: "tsit", id: t.id, seat: 1 });
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      games.handle(sa, { t: "tstart", id: t.id });
      const state = () => {
        const g = a.last("table")!.game!;
        if (g.kind !== "bilek") throw new Error("bilek değil");
        return g.state;
      };
      for (let i = 0; i < BILEK_LOSE; i++) {
        now = Math.max(now, state().next) + 1;
        games.tick(now);
        const c = state().checks[0]!;
        // a yayın ortasında basar; b hiç basmaz, süre dolunca kaçırır
        const p = c.zone + c.width / 2;
        now = c.at + p * c.dur + 60;
        games.handle(sa, { t: "tmove", id: t.id, move: { kind: "press", n: c.n, p } });
        expect(state().checks[0]!.res).toBe("hit");
        now = c.at + c.dur + 1000;
        games.tick(now);
      }
      expect(state().misses).toEqual([0, BILEK_LOSE]);
      expect(state().winner).toBe(0);
      expect(a.last("table")!.note).toContain("bilek güreşini kazandı");
      expect(reports).toContainEqual([sa, "game_win", 1]);
    } finally {
      clock.mockRestore();
    }
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

describe("mahalle (inşa)", () => {
  it("arsa sahiplenilir, yalnızca sahibi blok koyar, herkes görür; boşaltınca arsa açılır", async () => {
    const { Builds } = await import("../server/src/games/build");
    const { games, room, a, b, sa, sb } = world();
    games.builds = new Builds(room, null);
    games.handle(sa, { t: "bclaim" });
    expect(a.last("plot")?.plot).toMatchObject({ id: 0, owner: "a" });
    games.handle(sa, { t: "bclaim" });
    expect(a.last("notice")?.text).toContain("Zaten");
    games.handle(sa, { t: "bset", i: 1, j: 0, k: 2, b: 1, r: 0 });
    expect(b.last("bset")).toMatchObject({ plot: 0, i: 1, j: 0, k: 2, b: 1 });
    // b'nin arsası yok: koyamaz; arsa alınca kendi arsasına (1) koyar
    const before = b.text.length;
    games.handle(sb, { t: "bset", i: 0, j: 0, k: 0, b: 2, r: 0 });
    expect(b.text.length).toBe(before);
    games.handle(sb, { t: "bclaim" });
    games.handle(sb, { t: "bset", i: 0, j: 0, k: 0, b: 2, r: 0 });
    expect(a.last("bset")).toMatchObject({ plot: 1, b: 2 });
    // Sınır dışı ve geçersiz blok reddedilir
    games.handle(sa, { t: "bset", i: 99, j: 0, k: 0, b: 1, r: 0 });
    games.handle(sa, { t: "bset", i: 0, j: 0, k: 0, b: 999, r: 0 });
    expect(a.last("bset")).toMatchObject({ plot: 1 });
    games.handle(sa, { t: "bfree" });
    expect(a.last("plot")?.plot).toMatchObject({ id: 0, owner: null, data: "" });
  });
});


describe("yardımlı şut", () => {
  it("kaleye dönükken kalecinin uzak köşesine, arkası dönükken baktığı yöne", async () => {
    const { assistedShot, attackSide, FINISH_RANGE, goalView } = await import("../shared/football");
    const bx = PITCH.x + PITCH.hx - 10, bz = PITCH.z;
    // Doğu kalesine bakıyor (π/2), kaleci üst köşede (+z): şut alt köşeye (-z)
    const dir = assistedShot(1, bx, bz, Math.PI / 2, PITCH.z + 1);
    expect(Math.cos(dir)).toBeLessThan(0);
    expect(Math.sin(dir)).toBeGreaterThan(0.9);
    // Arkası dönük: yardım yok
    expect(assistedShot(1, bx, bz, -Math.PI / 2, null)).toBe(-Math.PI / 2);
    // Maçta takıma göre hücum kalesi; maçsız baktığı yöne yakın olan
    expect(attackSide(0, bx, bz, -Math.PI / 2)).toBe(1);
    expect(attackSide(null, bx, bz, -Math.PI / 2)).toBe(-1);
    expect(goalView(1, bx, bz, Math.PI / 2).dist).toBeLessThan(FINISH_RANGE);
  });
});
