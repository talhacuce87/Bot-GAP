import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../shared/protocol";
import { DEFAULT_CAR } from "../shared/car";
import type { SessionUser } from "../server/src/auth";
import { WorldGames } from "../server/src/games/world";
import { type Conn, Room } from "../server/src/room";

// Yürüyüş ağı terrain/fame modüllerini içe aktarır: Node'da en küçük DOM (roads.test ile aynı)
const ctx2d = new Proxy(
  {},
  {
    get: (_t, k) =>
      k === "measureText" ? () => ({ width: 10 })
      : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop() {} })
      : k === "getImageData" ? () => ({ data: new Uint8ClampedArray(4) })
      : () => {},
    set: () => true,
  },
);
const fakeCanvas = () => ({ width: 1, height: 1, style: {}, getContext: () => ctx2d, addEventListener() {}, toDataURL: () => "" });
Object.assign(globalThis, {
  document: { createElement: () => fakeCanvas(), createElementNS: fakeCanvas, body: { append() {} } },
  window: globalThis,
  matchMedia: () => ({ matches: false }),
  location: { search: "", hostname: "localhost" },
});

describe("NPC yayalar", () => {
  it("konumları yalnızca saate bağlı: iki istemci aynı yayayı aynı yerde görür", async () => {
    const { walkways } = await import("../client/src/world/walkways");
    const { Pedestrians } = await import("../client/src/npcs/pedestrians");
    const a = new Pedestrians(walkways(), 10), b = new Pedestrians(walkways(), 10);
    expect(a.count).toBeGreaterThan(100);
    const pa = { x: 0, z: 0, rot: 0, moving: false }, pb = { ...pa };
    for (const t of [0, 1234.5, 1.7e9, 1.7e9 + 77.25]) {
      for (let i = 0; i < a.count; i += 7) {
        a.baseAt(i, t, pa);
        b.baseAt(i, t, pb);
        expect(pb).toEqual(pa);
      }
    }
  });

  it("yayalar yürünür alanda kalır, çoğu asfaltın dışında (yalnızca yaya geçitlerinde yola iner)", async () => {
    const { walkways } = await import("../client/src/world/walkways");
    const { Pedestrians } = await import("../client/src/npcs/pedestrians");
    const { walkable } = await import("../client/src/world/terrain");
    const { onAsphalt, outsideWorld } = await import("../shared/zones").then(async (z) => ({ ...z, ...(await import("../shared/constants")) }));
    const peds = new Pedestrians(walkways(), 10, [], walkable);
    const p = { x: 0, z: 0, rot: 0, moving: false };
    let total = 0, asphalt = 0;
    const bad: string[] = [];
    for (let i = 0; i < peds.count; i++) {
      for (let t = 0; t < 600; t += 37) {
        peds.baseAt(i, t, p);
        total++;
        if (onAsphalt(p.x, p.z)) asphalt++;
        if (!walkable(p.x, p.z) || outsideWorld(p.x, p.z) > 0) bad.push(`${i}@${t}: ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(asphalt / total).toBeLessThan(0.12);
  });

  it("yoğunluk saate göre 0–1 arası; şehir gece casino saatinde kalabalık, sabaha karşı tenha", async () => {
    const { zoneDensity } = await import("../client/src/npcs/pedestrians");
    for (const zone of ["village", "city", "hood"] as const) {
      for (let h = 0; h < 24; h += 0.5) {
        const d = zoneDensity(zone, h);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
      }
    }
    expect(zoneDensity("city", 21)).toBeGreaterThan(zoneDensity("city", 4) * 3);
  });
});

const member = (id: string): SessionUser => ({ id, name: id, avatar: null, guest: false });

class FakeConn implements Conn {
  bufferedAmount = 0;
  text: ServerEvent[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.text.push(JSON.parse(data));
  }
  hits(): Extract<ServerEvent, { t: "pedhit" }>[] {
    return this.text.filter((e): e is Extract<ServerEvent, { t: "pedhit" }> => e.t === "pedhit");
  }
}

describe("pedhit (sunucu)", () => {
  function world() {
    const room = new Room("g:npc");
    room.games = new WorldGames(room, () => {}, { play: async () => ({ title: "x" }), title: async () => "x", loadedAt: () => 0 });
    const a = new FakeConn(), b = new FakeConn();
    const sa = room.join(member("a"), a, 0);
    room.join(member("b"), b, 0);
    return { room, games: room.games, a, b, sa };
  }

  it("yalnızca arabadaki çarpar; herkese duyurulur, hız sınırlanır", () => {
    const { room, games, b, sa } = world();
    games.handle(sa, { t: "pedhit", id: 3, vx: 5, vz: 0 }, 1000);
    expect(b.hits()).toEqual([]);
    room.setCar(sa, DEFAULT_CAR);
    games.handle(sa, { t: "pedhit", id: 3, vx: 99, vz: -1 }, 2000);
    expect(b.hits()).toEqual([{ t: "pedhit", id: 3, vx: 25, vz: -1, by: sa }]);
  });

  it("aynı yaya bir süre tekrar düşmez, oyuncu art arda bildiremez; geçersiz kimlik yok sayılır", () => {
    const { room, games, b, sa } = world();
    room.setCar(sa, DEFAULT_CAR);
    games.handle(sa, { t: "pedhit", id: 1, vx: 4, vz: 0 }, 10_000);
    games.handle(sa, { t: "pedhit", id: 2, vx: 4, vz: 0 }, 10_100); // oyuncu beklemesi
    games.handle(sa, { t: "pedhit", id: 1, vx: 4, vz: 0 }, 11_000); // yaya hâlâ yerde
    games.handle(sa, { t: "pedhit", id: -1, vx: 4, vz: 0 }, 12_000);
    games.handle(sa, { t: "pedhit", id: 1.5, vx: 4, vz: 0 }, 12_500);
    games.handle(sa, { t: "pedhit", id: 2, vx: 4, vz: 0 }, 13_000);
    expect(b.hits().map((h) => h.id)).toEqual([1, 2]);
  });
});

describe("araba hasarı (sunucu)", () => {
  it("yalnızca arabadayken 0–3 kabul edilir, herkese duyurulur; arabadan inince sıfırlanır", () => {
    const room = new Room("g:dmg");
    const a = new FakeConn(), b = new FakeConn();
    const sa = room.join(member("a"), a, 0);
    room.join(member("b"), b, 0);
    const dmg = () => b.text.filter((e) => e.t === "cardmg");
    room.setCarDamage(sa, 2);
    expect(dmg()).toEqual([]);
    room.setCar(sa, DEFAULT_CAR);
    room.setCarDamage(sa, 7);
    room.setCarDamage(sa, 1.5);
    room.setCarDamage(sa, 2);
    expect(dmg()).toEqual([{ t: "cardmg", sid: sa, d: 2, z: null }]);
    room.setCar(sa, null);
    expect(room.players.get(sa)!.info.dmg).toBe(0);
  });
});
