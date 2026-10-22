import { describe, expect, it } from "vitest";
import { JUMP_SHIFT } from "../shared/constants";
import type { ServerEvent } from "../shared/protocol";
import { hitBall, inCourt, NET_TOP, serveHeight, SLOT_POS, V_BALL_R, type VBall, vStep } from "../shared/volley";
import { inVolley, VOLLEY_COURT as C } from "../shared/zones";
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

function hall() {
  const room = new Room("g:volley");
  const host = { play: async () => ({ title: "x" }), title: async () => "x", loadedAt: () => 0 };
  room.games = new WorldGames(room, () => {}, host);
  const a = new FakeConn(), b = new FakeConn();
  const sa = room.join(member("a"), a, 0);
  const sb = room.join(member("b"), b, 0);
  const v = room.games.volley;
  v.random = () => 0.5;
  const place = (sid: number, x: number, z: number, rot = 0) => room.teleport(sid, x, z, rot, 0);
  /** Zıplama sayacını arttırır (sunucu bir sonraki tikte havada sayar). */
  const jump = (sid: number) => {
    const s = room.players.get(sid)!.state;
    s.flags = (s.flags + (1 << JUMP_SHIFT)) & 0xff;
  };
  const run = (from: number, to: number) => {
    for (let t = from; t < to; t += 20) v.tick(t);
  };
  return { room, v, a, b, sa, sb, place, jump, run };
}

/** Rally elle kurulur (servisçinin elindeki top bırakılır). */
const rally = (v: { s: { phase: string } }) => {
  v.s.phase = "rally";
  (v as unknown as { main: { hold: number } }).main.hold = 0;
};

/** İki kişilik maç: a batıda (kırmızı), b doğuda (mavi); servis ilk sırada kırmızıda. */
function match() {
  const h = hall();
  h.place(h.sa, C.x - 3, C.z);
  h.place(h.sb, C.x + 3, C.z);
  h.v.random = () => 0.1; // servis kırmızıda
  expect(h.v.start(h.sa, 7, 1000)).toBeNull();
  h.v.random = () => 0.5;
  h.run(1000, 3200);
  return h;
}

describe("voleybol: fizik", () => {
  it("1–13 güçteki servisler sapma ve falsoyla da fileyi aşıp sahaya düşer", () => {
    for (let p = 1; p <= 13; p++) {
      for (const j of [-1, 0, 1]) {
        const b = { x: C.x - C.hx - 1, y: serveHeight(p), z: C.z + 2, vx: 0, vy: 0, vz: 0 };
        hitBall(b, "serve", Math.PI / 2, p, p > 3 ? j : 0, p <= 3 ? j : 0);
        let net = false;
        for (let t = 0; t < 5; t += 1 / 120) {
          const ev = vStep(b, 1 / 120);
          if (ev === "net") net = true;
          if (ev === "floor") break;
        }
        expect(net).toBe(false);
        expect(b.x).toBeGreaterThan(C.x);
        expect(inCourt(b.x, b.z)).toBe(true);
      }
    }
  });

  it("smaç servis (havada) 1–13 güçte fileyi aşar, hızlı ve alçak gider", () => {
    for (let p = 1; p <= 13; p++) {
      const b = { x: C.x - C.hx - 0.5, y: serveHeight(p, true), z: C.z, vx: 0, vy: 0, vz: 0 };
      hitBall(b, "serve", Math.PI / 2, p, 0, 0, "normal", 1, true);
      expect(Math.hypot(b.vx, b.vz)).toBeGreaterThan(9);
      let net = false;
      for (let t = 0; t < 5; t += 1 / 120) {
        const ev = vStep(b, 1 / 120);
        if (ev === "net") net = true;
        if (ev === "floor") break;
      }
      expect(net).toBe(false);
      expect(inCourt(b.x, b.z) && b.x > C.x).toBe(true);
    }
  });

  it("manşet: 1 güçte yakına, 3 güçte arka sıradan pasöre, sert vuruş karşıya", () => {
    const land = (p: number) => {
      const b = { x: C.x - 8.6, y: 0.8, z: C.z, vx: 0, vy: 0, vz: 0 };
      hitBall(b, "bump", Math.PI / 2, p);
      for (let t = 0; t < 6; t += 1 / 120) if (vStep(b, 1 / 120) === "floor") break;
      return b.x - C.x;
    };
    expect(land(1)).toBeLessThan(-5.5);
    expect(land(3)).toBeGreaterThan(-3);
    expect(land(3)).toBeLessThan(-0.5);
    expect(land(8)).toBeGreaterThan(0);
  });

  it("havada öne yatan yakına, geri yatan uzağa vurur", () => {
    const land = (depth: number) => {
      const b = { x: C.x - 1, y: 3.2, z: C.z, vx: 0, vy: 0, vz: 0 };
      hitBall(b, "spike", Math.PI / 2, 8, 0, 0, "normal", depth);
      for (let t = 0; t < 4; t += 1 / 120) if (vStep(b, 1 / 120) === "floor") break;
      return b.x;
    };
    expect(land(0.65)).toBeLessThan(land(1));
    expect(land(1.35)).toBeGreaterThan(land(1));
  });

  it("düşük güçteki pas daha yüksek ve yavaş gider", () => {
    const fly = (p: number) => {
      const b = { x: C.x - 3, y: 2, z: C.z, vx: 0, vy: 0, vz: 0 };
      hitBall(b, "set", Math.PI / 2, p);
      return b;
    };
    expect(fly(2).vy).toBeGreaterThan(fly(12).vy);
  });

  it("fileye çarpan top geldiği yarıda kalır", () => {
    const b = { x: C.x - 2, y: 1.2, z: C.z, vx: 8, vy: 0, vz: 0 };
    let ev: string | null = null;
    for (let t = 0; t < 2 && ev !== "floor"; t += 1 / 120) ev = vStep(b, 1 / 120) ?? ev;
    expect(b.x).toBeLessThan(C.x);
  });

  it("smaç fileden uzaktan da fileyi aşar (ama derine gider)", () => {
    const b = { x: C.x - 2, y: 2.9, z: C.z, vx: 0, vy: 0, vz: 0 };
    hitBall(b, "spike", Math.PI / 2, 8);
    let crossY = 0;
    for (let t = 0; t < 2; t += 1 / 120) {
      const px = b.x;
      if (vStep(b, 1 / 120) === "floor") break;
      if (px < C.x && b.x >= C.x) crossY = b.y;
    }
    expect(crossY).toBeGreaterThan(NET_TOP + V_BALL_R);
    expect(b.x).toBeGreaterThan(C.x);
  });

  it("falsolu alttan servis yana kıvrılır ama nişan alınan yere iner", () => {
    const fly = (spin: number) => {
      const b: VBall = { x: C.x - C.hx - 1, y: serveHeight(2), z: C.z, vx: 0, vy: 0, vz: 0 };
      hitBall(b, "serve", Math.PI / 2, 2, 0, spin);
      let mid = 0;
      for (let t = 0; t < 6; t += 1 / 120) {
        const px = b.x;
        if (vStep(b, 1 / 120) === "floor") break;
        if (px < C.x && b.x >= C.x) mid = b.z;
      }
      return { mid, x: b.x, z: b.z };
    };
    const straight = fly(0), right = fly(1);
    // Sağa falso: fileyi sola kayık geçer, inişte aynı yere gelir
    expect(Math.abs(right.mid - straight.mid)).toBeGreaterThan(0.5);
    expect(Math.hypot(right.x - straight.x, right.z - straight.z)).toBeLessThan(0.3);
  });
});

describe("voleybol: salon ve maç", () => {
  it("salona ışınlanır, dönünce geldiği yere döner", () => {
    const { room, v, sa, place } = hall();
    place(sa, 10, 20);
    expect(v.go(sa, 100)).toBeNull();
    const p = room.players.get(sa)!.state;
    expect(inVolley(p.x, p.z)).toBe(true);
    v.home(sa, 200);
    expect([p.x, p.z]).toEqual([10, 20]);
  });

  it("maç için iki kişi gerekir; takımlar yarılara göre kurulur ve servisçi topu tutar", () => {
    const { v, a, sa, sb, place } = hall();
    place(sa, C.x - 3, C.z);
    place(sb, 0, 0); // salonda değil
    expect(v.start(sa, 15, 0)).toMatch(/iki kişi/);
    const m = match();
    expect(m.v.s.teams).toEqual([[m.sa, 0, 0, 0, 0, 0], [m.sb, 0, 0, 0, 0, 0]]);
    expect(m.v.s.phase).toBe("serve");
    expect(m.v.s.server).toBe(m.sa);
    expect(m.a.last("vball")?.hold).toBe(m.sa);
    void a;
    void sb;
  });

  it("servis: top havaya atılıp vurulur; karşılanmayan servis sayı olur, çizginin içinden atılamaz", () => {
    const { v, a, sa, place, run } = match();
    place(sa, C.x - 3, C.z, Math.PI / 2);
    v.hit(sa, "serve", Math.PI / 2, 5, false, 3300); // top elde: doğrudan servis yok
    expect(v.s.phase).toBe("serve");
    v.lift(sa, 0, 3300);
    expect(a.last("notice")?.text).toMatch(/arkasından/);
    expect(a.last("vball")?.hold).toBe(sa);
    place(sa, C.x - C.hx - 1, C.z, Math.PI / 2);
    v.lift(sa, 0, 3350);
    expect(a.last("vball")?.toss).toBe(sa);
    run(3350, 3500);
    v.hit(sa, "bump", Math.PI / 2, 5, false, 3500); // atılan topa her vuruş servis
    expect(v.s.phase).toBe("rally");
    expect(a.last("vball")?.ev).toBe("serve");
    run(3500, 6500);
    expect(v.s.score).toEqual([1, 0]);
  });

  it("havaya atılan servis topu vurulmazsa servis hatası", () => {
    const { v, sa, place, run } = match();
    place(sa, C.x - C.hx - 1, C.z, Math.PI / 2);
    v.lift(sa, 0, 3300);
    run(3300, 6000);
    expect(v.s.score).toEqual([0, 1]);
    expect(v.s.note).toBe("Servis hatası");
  });

  it("koşup zıplayan servisçi çizgiyi biraz geçse de smaç servis atar", () => {
    const { v, sa, place, jump, run, a } = match();
    place(sa, C.x - C.hx - 1, C.z, Math.PI / 2);
    v.lift(sa, 0, 3300);
    run(3300, 3900);
    jump(sa);
    v.tick(3920);
    place(sa, C.x - C.hx + 1.2, C.z, Math.PI / 2);
    const ball = a.last("vball")!;
    place(sa, ball.x - 0.5, ball.z, Math.PI / 2);
    v.hit(sa, "spike", Math.PI / 2, 12, false, 3940);
    expect(v.s.phase).toBe("rally");
    expect(Math.abs(a.last("vball")!.vx)).toBeGreaterThan(9);
  });

  it("manşet gecikme telafili: oyuncunun bastığı anda gördüğü top kabul edilir", () => {
    const { v, sa, sb, place, run, a } = match();
    place(sa, C.x - C.hx - 1, C.z, Math.PI / 2);
    v.lift(sa, 0, 3250);
    v.hit(sa, "serve", Math.PI / 2, 3, false, 3300);
    // Topun düşeceği yeri bul, b'yi oraya koy, top 1 m yüksekteyken (biraz sonra) manşet
    let t = 3300;
    let seen: { x: number; y: number; z: number } | null = null;
    while (t < 9000) {
      t += 20;
      v.tick(t);
      const ball = a.last("vball")!;
      if (ball.vy < 0 && ball.y < 1.2 && ball.x > C.x) {
        seen = { x: ball.x, y: ball.y, z: ball.z };
        break;
      }
    }
    expect(seen).not.toBeNull();
    place(sb, seen!.x + 0.5, seen!.z);
    run(t + 20, t + 140); // top bu arada daha da alçaldı
    v.hit(sb, "bump", -Math.PI / 2, 3, false, t + 160);
    expect(v.s.side).toBe(1);
    expect(v.s.touches).toBe(1);
    expect(a.last("vball")?.ev).toBe("bump");
  });

  it("aynı oyuncu üst üste dokunursa çift vuruş: rakip sayı alır; dokunan 1 sn topa dokunamaz", () => {
    const { v, sb, place, room } = match();
    // Rally'yi elle kur: top b'nin yanında, mavi tarafta
    rally(v);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x + 3, y: 1, z: C.z, vx: 0, vy: 0, vz: 0 });
    place(sb, C.x + 3.5, C.z);
    v.hit(sb, "bump", 0, 1, false, 5000);
    expect(v.s.touches).toBe(1);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x + 3, y: 1, z: C.z, vx: 0, vy: 0, vz: 0 });
    v.hit(sb, "bump", 0, 1, false, 5400); // tıklama yağmuru: sayılmaz
    expect(v.s.score).toEqual([0, 0]);
    expect(v.s.touches).toBe(1);
    v.hit(sb, "bump", 0, 1, false, 6100);
    expect(v.s.score).toEqual([1, 0]);
    expect(v.s.note).toBe("Çift vuruş");
    void room;
  });

  it("smaç havada olur; dışarı giden smaçta rakip sayı alır", () => {
    const { v, sa, place, jump, run } = match();
    rally(v);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x - 1, y: 2.8, z: C.z, vx: 0, vy: 0, vz: 0 });
    place(sa, C.x - 1.4, C.z);
    v.hit(sa, "spike", Math.PI / 2, 5, false, 5000);
    expect(v.s.side).toBe(-1); // yerdeyken smaç olmaz
    jump(sa);
    v.tick(5010);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x - 1, y: 2.8, z: C.z, vx: 0, vy: 0, vz: 0 });
    v.hit(sa, "spike", 0, 10, false, 5020); // yana, saha dışına
    expect(v.s.side).toBe(0);
    run(5040, 7000);
    expect(v.s.score).toEqual([0, 1]);
    expect(v.s.note).toBe("Dışarı");
  });

  it("blok: fileye yakın zıplayan oyuncu smaçı geri çevirir, sayı bloklayana", () => {
    const { v, sa, sb, place, jump, run, a } = match();
    rally(v);
    place(sa, C.x - 1.0, C.z);
    place(sb, C.x + 0.6, C.z);
    jump(sa);
    v.tick(5000);
    v.block(sb, 5000);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x - 0.7, y: 3.0, z: C.z, vx: 0, vy: 0, vz: 0 });
    v.hit(sa, "spike", Math.PI / 2, 4, false, 5010);
    run(5020, 8000);
    expect(a.text.some((e) => e.t === "vball" && e.ev === "block" && e.by === sb)).toBe(true);
    expect(v.s.score).toEqual([0, 1]);
  });

  it("dump bloğun üstünden aşar, yavaş düşer, sayı vurana", () => {
    const { v, sa, sb, place, jump, run, a } = match();
    rally(v);
    place(sa, C.x - 1.0, C.z);
    place(sb, C.x + 0.6, C.z);
    jump(sa);
    v.tick(5000);
    v.block(sb, 5000);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x - 0.7, y: 3.0, z: C.z, vx: 0, vy: 0, vz: 0 });
    v.hit(sa, "dump", Math.PI / 2, 4, false, 5010);
    expect(Math.abs(a.last("vball")!.vx)).toBeLessThan(4);
    run(5020, 8000);
    expect(a.text.some((e) => e.t === "vball" && e.ev === "block")).toBe(false);
    expect(v.s.score).toEqual([1, 0]);
  });

  it("maç yokken servis denenir: top ele alınır, atılır, vurulur; karşı yarıya gider, maç başlamaz", () => {
    const { v, a, sa, place, run } = hall();
    place(sa, C.x - 5, C.z + 1, Math.PI / 2);
    v.take(sa, 1000);
    expect(a.last("vball")?.hold).toBe(sa);
    v.lift(sa, 0.5, 1000);
    v.hit(sa, "serve", Math.PI / 2, 13, false, 1000);
    expect(a.last("vball")?.ev).toBe("serve");
    expect(a.last("vball")?.w).toBeTruthy(); // 12'den sert: rüzgar izi
    run(1000, 2500);
    expect(v.s.phase).toBe("free");
    const mine = [...a.text].reverse().find((e) => e.t === "vball" && e.id === sa);
    expect(mine && mine.t === "vball" && mine.x).toBeGreaterThan(C.x);
  });

  it("antrenmanda herkes kendi topunu çağırır; top yere düşüp çağıran 3 sn dokunmayınca kaybolur", () => {
    const { v, a, sa, sb, place, run } = hall();
    place(sa, C.x - 4, C.z - 2, Math.PI / 2);
    place(sb, C.x - 4, C.z + 2, Math.PI / 2);
    v.toss(sa, 2000);
    v.toss(sb, 2000);
    const ids = new Set(a.text.flatMap((e) => (e.t === "vball" && e.id ? [e.id] : [])));
    expect(ids).toEqual(new Set([sa, sb]));
    // b kendi topunu oynamaya devam eder; a bırakır
    run(2000, 3400);
    v.toss(sb, 3400);
    run(3400, 4900);
    v.toss(sb, 4900);
    expect(a.text.some((e) => e.t === "vgone")).toBe(false);
    run(4900, 5200);
    expect(a.text.filter((e) => e.t === "vgone").map((e) => e.t === "vgone" && e.id)).toEqual([sa]);
    // Maç başlayınca antrenman topları kalkar
    v.start(sa, 7, 5200);
    expect(a.last("vgone")?.id).toBe(sb);
  });

  it("pozisyon seçilir ve oraya ışınlanılır; dolu pozisyon alınamaz", () => {
    const { v, room, sa, sb, place } = hall();
    place(sa, C.x - 3, C.z);
    place(sb, C.x + 3, C.z);
    expect(v.setPos(sa, 1, 4, 100)).toBeNull();
    const p = room.players.get(sa)!.state;
    expect([p.x, p.z]).toEqual([C.x + SLOT_POS[4][0], C.z + SLOT_POS[4][1]]);
    expect(v.s.teams[1][4]).toBe(sa);
    expect(v.setPos(sb, 1, 4, 100)).toMatch(/dolu/);
    expect(v.setPos(sa, 0, 0, 200)).toBeNull();
    expect(v.s.teams).toEqual([[sa, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]);
    expect(v.setPos(sa, 0, -1, 300)).toBeNull();
    expect(v.teamOf(sa)).toBeNull();
  });

  it("havada yana yatan oyuncu yanındaki topa yetişir", () => {
    const { v, sa, place, jump } = hall();
    place(sa, C.x - 4, C.z);
    // Top oyuncunun (x yönüne bakarken) 1.9 m sağında: menzil dışında
    const ball = () => Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x - 4, y: 2.6, z: C.z + 1.9, vx: 0, vy: 0, vz: 0 });
    v.tick(4990);
    jump(sa);
    v.tick(5000);
    ball();
    v.hit(sa, "spike", Math.PI / 2, 8, false, 5010);
    expect((v as unknown as { main: { lastToucher: number } }).main.lastToucher).toBe(0);
    v.lean(sa, 1);
    ball();
    v.hit(sa, "spike", Math.PI / 2, 8, false, 5400);
    expect((v as unknown as { main: { lastToucher: number } }).main.lastToucher).toBe(sa);
  });

  it("arka sıra oyuncusu hücum çizgisinin önünde smaç vuramaz", () => {
    const { v, sa, place, jump } = match();
    expect(v.setPos(sa, 0, 4, 4000)).toBeNull();
    rally(v);
    place(sa, C.x - 1.4, C.z, Math.PI / 2);
    v.tick(4990);
    jump(sa);
    v.tick(5000);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x - 1, y: 2.8, z: C.z, vx: 0, vy: 0, vz: 0 });
    v.hit(sa, "spike", Math.PI / 2, 8, false, 5010);
    expect(v.s.side).toBe(-1);
  });

  it("servis süresi dolarsa top atılmaz, sayı rakibe geçer", () => {
    const { v, a, run } = match();
    run(3200, 15_200);
    expect(v.s.score).toEqual([0, 1]);
    expect(v.s.note).toBe("Servis süresi doldu");
    expect(a.text.some((e) => e.t === "vball" && e.ev === "serve")).toBe(false);
  });

  it("servis önce karşılanır: smaçla ve blokla karşılanamaz", () => {
    const { v, a, b, sa, sb, place, jump, run } = match();
    const ball = (v as unknown as { main: { b: object } }).main.b;
    place(sa, C.x - C.hx - 1, C.z, Math.PI / 2);
    v.lift(sa, 0, 3250);
    v.hit(sa, "serve", Math.PI / 2, 3, false, 3300);
    expect(v.s.side).toBe(0);
    // Blok: servis bloklanamaz
    place(sb, C.x + 0.6, C.z);
    v.block(sb, 3310);
    Object.assign(ball, { x: C.x - 0.7, y: 3.0, z: C.z, vx: 8, vy: 0, vz: 0 });
    run(3320, 3500);
    expect(a.text.some((e) => e.t === "vball" && e.ev === "block")).toBe(false);
    // Smaç: olmaz; manşet ya da pas olur
    place(sb, C.x + 3.4, C.z, -Math.PI / 2);
    jump(sb);
    v.tick(3520);
    Object.assign(ball, { x: C.x + 3, y: 2.8, z: C.z, vx: 0, vy: 0, vz: 0 });
    v.hit(sb, "spike", -Math.PI / 2, 8, false, 3530);
    expect(v.s.side).toBe(0);
    expect(b.last("notice")?.text).toMatch(/karşılanmalı/);
    expect(v.s.phase).toBe("rally");
    Object.assign(ball, { x: C.x + 3, y: 2.8, z: C.z, vx: 0, vy: 0, vz: 0 });
    v.hit(sb, "set", -Math.PI / 2, 8, false, 3540);
    expect(v.s.side).toBe(1);
  });

  it("filenin karşısındaki topa dokunulamaz", () => {
    const { v, sb, place } = match();
    rally(v);
    place(sb, C.x + 0.5, C.z);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x - 0.6, y: 1, z: C.z, vx: 0, vy: 0, vz: 0 });
    v.hit(sb, "bump", -Math.PI / 2, 3, false, 5000);
    expect(v.s.side).toBe(-1);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x + 0.6, y: 1, z: C.z, vx: 0, vy: 0, vz: 0 });
    v.hit(sb, "bump", -Math.PI / 2, 3, false, 5010);
    expect(v.s.side).toBe(1);
  });

  it("oyuncudan uzaklaşmış hızlı top geriye sarılıp yakalanamaz", () => {
    const { v, sb, place, run } = match();
    rally(v);
    v.tick(4990);
    place(sb, C.x + 3, C.z - 5);
    Object.assign((v as unknown as { main: { b: object } }).main.b, { x: C.x + 3, y: 1.5, z: C.z - 5, vx: 0, vy: 0, vz: 20 });
    run(5000, 5200); // top 4 m ilerledi (geçmişte oyuncunun yanındaydı)
    v.hit(sb, "bump", 0, 3, false, 5200);
    expect(v.s.side).toBe(-1);
  });

  it("set iki farkla biter: sonuç sohbete yazılır, antrenmana dönülür", () => {
    const { v, a } = match();
    v.s.score = [6, 5];
    (v as unknown as { point(w: 0 | 1, n: string, now: number): void }).point(0, "Top yere değdi", 9000);
    expect(v.s.target).toBe(0);
    expect(v.s.phase).toBe("free");
    expect(a.text.some((e) => e.t === "chat" && /Kırmızı takım kazandı/.test(e.line.text))).toBe(true);
  });
});
