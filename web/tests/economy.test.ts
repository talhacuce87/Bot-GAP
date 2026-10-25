import { describe, expect, it } from "vitest";
import { FLAG_RUNNING, FLAG_SEATED } from "../shared/constants";
import { carHitDamage, ECON, fallDamage, FULL_LIFE, LIFE, stepLife } from "../shared/economy";
import type { ServerEvent } from "../shared/protocol";
import { Economy } from "../server/src/economy";
import { HOSPITAL, LifeHost, type LifeRoom } from "../server/src/life";

describe("hayat barları", () => {
  it("açlık 60, enerji 90 dakikada biter; koşmak iki kat, oturmak doldurur", () => {
    expect(stepLife(FULL_LIFE, 30 * 60, { running: false, seated: false }).hunger).toBeCloseTo(50);
    expect(stepLife(FULL_LIFE, 45 * 60, { running: false, seated: false }).energy).toBeCloseTo(50);
    expect(stepLife(FULL_LIFE, 45 * 60, { running: true, seated: false }).energy).toBeCloseTo(0);
    expect(stepLife({ hp: 100, hunger: 100, energy: 40 }, 60, { running: false, seated: true }).energy).toBeCloseTo(40 + LIFE.seatedEnergyPerMin);
  });

  it("açlık sıfırken can gider; doyken can dolar", () => {
    expect(stepLife({ hp: 50, hunger: 0, energy: 50 }, 60, { running: false, seated: false }).hp).toBeCloseTo(50 - LIFE.starvePerMin);
    expect(stepLife({ hp: 50, hunger: 100, energy: 100 }, 60, { running: false, seated: false }).hp).toBeGreaterThan(50);
  });

  it("düşme ve çarpma canı", () => {
    expect(fallDamage(3)).toBe(0);
    expect(fallDamage(6)).toBe(16);
    expect(fallDamage(100)).toBe(LIFE.hitMax);
    expect(carHitDamage(5)).toBe(0);
    expect(carHitDamage(16)).toBe(40);
  });
});

describe("ekonomi", () => {
  it("10.000 ₺ ile başlar; açıklamalı işlem geçmişe ve bildirime gider", () => {
    const e = new Economy(null);
    const seen: (string | null)[] = [];
    e.onChange = (_k, _b, tx) => seen.push(tx?.reason ?? null);
    expect(e.get("a")).toBe(ECON.startMoney);
    expect(e.add("a", 250, { reason: "Teslimat", icon: "📦" })).toBe(true);
    expect(e.add("a", -20_000, { reason: "Araba", icon: "🚗" })).toBe(false);
    const w = e.wallet("a");
    expect(w.balance).toBe(ECON.startMoney + 250);
    expect(w.earned).toBe(250);
    expect(w.history.map((t) => t.reason)).toEqual(["Teslimat"]);
    expect(seen).toEqual(["Teslimat"]);
  });

  it("kumarhane günlük kayıp sınırı; geçmişe yazılmaz", () => {
    const e = new Economy(null);
    e.add("a", 50_000);
    const c = e.casino();
    expect(c.add("a", -ECON.casinoDailyLoss)).toBe(true);
    expect(c.add("a", -10)).toBe(false);
    expect(c.add("a", 100)).toBe(true);
    expect(c.add("a", -100)).toBe(true);
    expect(e.wallet("a").history).toEqual([]);
  });

  it("zorunlu ücret yetmezse eldekini alır", () => {
    const e = new Economy(null);
    e.add("a", -(ECON.startMoney - 100));
    expect(e.charge("a", ECON.hospitalFee, { reason: "Hastane", icon: "🚑" })).toBe(100);
    expect(e.get("a")).toBe(0);
  });
});

function room() {
  const sent = new Map<number, ServerEvent[]>();
  const players: LifeRoom["players"] = new Map();
  const tps: number[] = [];
  const add = (sid: number, x = 0, z = 0) => {
    sent.set(sid, []);
    players.set(sid, { info: { name: `p${sid}` }, state: { x, z, flags: 0 }, conn: { sid } as never });
  };
  const r: LifeRoom = {
    players,
    sendTo: (conn, ev) => sent.get((conn as unknown as { sid: number }).sid)!.push(ev),
    broadcast: () => {},
    teleport: (sid) => (tps.push(sid), 0),
  };
  const last = (sid: number) => sent.get(sid)!.filter((e) => e.t === "life").at(-1) as Extract<ServerEvent, { t: "life" }>;
  return { r, add, last, tps, players };
}

describe("hayat sunucusu", () => {
  it("yüksekten düşen can kaybeder, bayılır; arkadaşı yanında kalarak kaldırır", () => {
    const { r, add, last, players } = room();
    const e = new Economy(null);
    const h = new LifeHost(r, e);
    add(1);
    add(2, 1, 0);
    h.join(1, "a", 0);
    h.join(2, "b", 0);
    h.fall(1, 6, 10);
    expect(last(1).hp).toBe(100 - 16);
    h.hurt(1, 200, 2000);
    expect(h.isDowned(1)).toBe(true);
    expect(players.get(1)!.info.downed).toBe(true);
    expect(last(1).downed).toBe(2000 + LIFE.downedMs);
    players.get(2)!.state.x = 10;
    expect(h.revive(2, 1, 2100)).toMatch(/yanına/);
    players.get(2)!.state.x = 1;
    expect(h.revive(2, 1, 2200)).toBeNull();
    // Hemen kalkmaz; uzaklaşırsa iptal
    h.tick(2300);
    expect(h.isDowned(1)).toBe(true);
    players.get(2)!.state.x = 10;
    h.tick(2400);
    players.get(2)!.state.x = 1;
    h.tick(2200 + LIFE.reviveMs + 1);
    expect(h.isDowned(1)).toBe(true);
    // Yeniden başlar, süre boyunca yanında kalır
    expect(h.revive(2, 1, 10_000)).toBeNull();
    h.tick(10_000 + LIFE.reviveMs - 100);
    expect(h.isDowned(1)).toBe(true);
    h.tick(10_000 + LIFE.reviveMs);
    expect(h.isDowned(1)).toBe(false);
    expect(last(1).hp).toBe(LIFE.reviveHp);
  });

  it("kimse kaldırmazsa hastanede uyanır ve fatura öder", () => {
    const { r, add, last, tps } = room();
    const e = new Economy(null);
    const h = new LifeHost(r, e);
    add(1);
    h.join(1, "a", 0);
    h.hurt(1, 200, 1000);
    h.tick(1000 + LIFE.downedMs + 1);
    expect(h.isDowned(1)).toBe(false);
    expect(tps).toEqual([1]);
    expect(last(1).hp).toBe(LIFE.hospitalHp);
    expect(last(1).tp).toEqual(HOSPITAL);
    expect(e.get("a")).toBe(ECON.startMoney - ECON.hospitalFee);
  });

  it("hızlı araba yayaya çarpar, yavaş araba çarpmaz", () => {
    const { r, add, last, players } = room();
    const h = new LifeHost(r, new Economy(null));
    add(1);
    add(2, 5, 0);
    h.join(1, "a", 0);
    h.join(2, "b", 0);
    players.get(1)!.info.car = {};
    h.carMove(1, 0, 0, 1000);
    h.carMove(1, 1, 0, 1200); // 5 m/sn
    expect(last(2).hp).toBe(100);
    h.carMove(1, 5, 0, 1400); // 20 m/sn
    expect(last(2).hp).toBe(100 - carHitDamage(20));
  });

  it("koşarken enerji hızlı gider, otururken dolar", () => {
    const { r, add, last, players } = room();
    const e = new Economy(null);
    e.setLife("a", { hp: 100, hunger: 100, energy: 50 });
    const h = new LifeHost(r, e);
    add(1);
    h.join(1, "a", 0);
    players.get(1)!.state.flags = FLAG_RUNNING;
    for (let t = 1000; t <= 60_000; t += 1000) h.tick(t);
    const run = last(1).energy;
    expect(run).toBeLessThan(50);
    players.get(1)!.state.flags = FLAG_SEATED;
    for (let t = 61_000; t <= 120_000; t += 1000) h.tick(t);
    expect(last(1).energy).toBeGreaterThan(run);
  });
});
