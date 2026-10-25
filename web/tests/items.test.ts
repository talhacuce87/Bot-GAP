import { describe, expect, it } from "vitest";
import { ECON, LIFE } from "../shared/economy";
import { addItems, emptyInv, INV, invKg, type ItemId, moveSlot } from "../shared/items";
import type { ServerEvent } from "../shared/protocol";
import { Economy } from "../server/src/economy";
import { Bags, type BagRoom } from "../server/src/inventory";
import { LifeHost, type LifeRoom } from "../server/src/life";

describe("çanta", () => {
  it("eşyalar yığılır, slot ve ağırlık sınırı", () => {
    let s = addItems(emptyInv(), "simit", 12)!;
    expect(s[0]).toEqual({ id: "simit", n: 10 });
    expect(s[1]).toEqual({ id: "simit", n: 2 });
    s = addItems(s, "simit", 3)!;
    expect(s[1]).toEqual({ id: "simit", n: 5 });
    expect(addItems(emptyInv(), "su", 31)).toBeNull(); // 15,5 kg
    expect(invKg(addItems(emptyInv(), "su", 30)!)).toBeCloseTo(INV.maxKg);
  });

  it("sürükle-bırak: yer değiştirir, aynı eşyayı birleştirir", () => {
    const s = addItems(addItems(emptyInv(), "cay", 4)!, "kahve", 1)!;
    const m = moveSlot(s, 1, 7)!;
    expect(m[1]).toBeNull();
    expect(m[7]).toEqual({ id: "kahve", n: 1 });
    const t = [...emptyInv()];
    t[0] = { id: "cay", n: 8 };
    t[1] = { id: "cay", n: 5 };
    const merged = moveSlot(t, 1, 0)!;
    expect(merged[0]).toEqual({ id: "cay", n: 10 });
    expect(merged[1]).toEqual({ id: "cay", n: 3 });
  });
});

function room() {
  const sent = new Map<number, ServerEvent[]>();
  const all: ServerEvent[] = [];
  const players = new Map<number, { info: { name: string; held?: ItemId | null; downed?: boolean }; state: { x: number; z: number; flags: number }; conn: never }>();
  const add = (sid: number, x = 0) => {
    sent.set(sid, []);
    players.set(sid, { info: { name: `p${sid}` }, state: { x, z: 0, flags: 0 }, conn: { sid } as never });
  };
  const r: LifeRoom & BagRoom = {
    players,
    sendTo: (conn: unknown, ev: ServerEvent) => sent.get((conn as { sid: number }).sid)!.push(ev),
    broadcast: (ev: ServerEvent) => all.push(ev),
    teleport: () => 0,
  };
  const inv = (sid: number) => (sent.get(sid)!.filter((e) => e.t === "inv").at(-1) as Extract<ServerEvent, { t: "inv" }>).slots;
  return { r, add, inv, all, sent };
}

describe("dükkân ve çanta sunucusu", () => {
  it("sepet tek seferde ödenir; para yetmezse ya da dükkânda yoksa alınmaz", () => {
    const { r, add, inv } = room();
    const e = new Economy(null);
    const b = new Bags(r, e, null);
    add(1);
    b.join(1, "a");
    expect(b.shop(1, "kahve", [{ id: "kahve", n: 2 }, { id: "sandvic", n: 1 }])).toBeNull();
    expect(e.get("a")).toBe(ECON.startMoney - 2 * 45 - 70);
    expect(inv(1).slice(0, 2)).toEqual([{ id: "kahve", n: 2 }, { id: "sandvic", n: 1 }]);
    expect(e.wallet("a").history[0].reason).toBe("GAP Kahve alışverişi");
    expect(b.shop(1, "simit", [{ id: "burger", n: 1 }])).toBeNull(); // simitçide burger yok: yok sayılır
    expect(e.get("a")).toBe(ECON.startMoney - 160);
    e.add("a", -(e.get("a") - 10));
    expect(b.shop(1, "burger", [{ id: "burger", n: 1 }])).toMatch(/Bakiyen/);
  });

  it("yiyince barlar dolar, etki başlar, herkes görür; elindeki eşya", () => {
    const { r, add, all } = room();
    const e = new Economy(null);
    e.setLife("a", { hp: 100, hunger: 20, thirst: 50, energy: 50 });
    const life = new LifeHost(r, e);
    const b = new Bags(r, e, life);
    add(1);
    life.join(1, "a", 0);
    b.join(1, "a");
    b.shop(1, "burger", [{ id: "burger", n: 1 }]);
    b.handle(1, { t: "inv", op: "hold", slot: 0 });
    expect((r.players.get(1)!.info as { held?: ItemId | null }).held).toBe("burger");
    expect(b.handle(1, { t: "inv", op: "use", slot: 0 }, 1000)).toBeNull();
    expect(all.some((x) => x.t === "eat" && x.item === "burger")).toBe(true);
    expect((r.players.get(1)!.info as { held?: ItemId | null }).held).toBeNull();
    expect(life.activeBuffs("a", 1000).tok).toBe(1000 + 10 * 60_000);
    // Tokken açlık yarı hızda
    // Tokken açlık yarı hızda düşer (20 + 65 = 85; 60 sn: −0,83)
    for (let t = 2000; t <= 62_000; t += 1000) life.tick(t);
    life.leave(1);
    expect(e.life("a").hunger).toBeCloseTo(85 - (100 / LIFE.hungerMinutes) * 0.5, 0);
  });

  it("yaralıyken yenmez; yanındaki arkadaşa verilir", () => {
    const { r, add, inv } = room();
    const e = new Economy(null);
    const life = new LifeHost(r, e);
    const b = new Bags(r, e, life);
    add(1);
    add(2, 1);
    life.join(1, "a", 0);
    life.join(2, "b", 0);
    b.join(1, "a");
    b.join(2, "b");
    b.shop(1, "simit", [{ id: "simit", n: 3 }]);
    life.hurt(1, 200, 0);
    expect(b.handle(1, { t: "inv", op: "use", slot: 0 })).toMatch(/Yaralı/);
    expect(b.handle(1, { t: "inv", op: "give", slot: 0, sid: 2 })).toBeNull();
    expect(inv(1)[0]).toBeNull();
    expect(inv(2)[0]).toEqual({ id: "simit", n: 3 });
    r.players.get(2)!.state.x = 10;
    expect(b.handle(2, { t: "inv", op: "give", slot: 0, sid: 1 })).toMatch(/yanına/);
    expect(LIFE.reviveHp).toBeGreaterThan(0);
  });
});
