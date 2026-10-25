import { describe, expect, it } from "vitest";
import { ECON } from "../shared/economy";
import { courierPay, JOB_PAY, meterFare, PICKUPS, PLACES, taxiFare } from "../shared/jobs";
import type { ServerEvent } from "../shared/protocol";
import { Economy } from "../server/src/economy";
import { JobHost, type JobRoom } from "../server/src/jobs";

function room() {
  const sent = new Map<number, ServerEvent[]>();
  const players: JobRoom["players"] = new Map();
  const add = (sid: number, x = 0, z = 0) => {
    sent.set(sid, []);
    players.set(sid, { info: { name: `p${sid}` }, state: { x, z }, conn: { sid } as never });
  };
  const r: JobRoom = {
    players,
    sendTo: (conn, ev) => sent.get((conn as unknown as { sid: number }).sid)!.push(ev),
    setCar: (sid) => (players.get(sid)!.info.car = null),
    setParked: (sid) => (players.get(sid)!.info.parked = null),
  };
  const view = (sid: number) => (sent.get(sid)!.filter((e) => e.t === "job").at(-1) as Extract<ServerEvent, { t: "job" }>).view;
  /** Oyuncuyu hedefe götür ve dur (iki tick: hız ölçülür). */
  const goTo = (h: JobHost, sid: number, t: { x: number; z: number }, now: number) => {
    const p = players.get(sid)!;
    p.state.x = t.x;
    p.state.z = t.z;
    h.tick(now);
    h.tick(now + 300);
  };
  return { r, add, view, goTo, players };
}

describe("işler", () => {
  it("duraklar dolu; ücretler sınırlar içinde", () => {
    expect(PICKUPS.length).toBeGreaterThanOrEqual(5);
    expect(PLACES.length).toBeGreaterThan(25);
    expect(courierPay(0)).toBe(JOB_PAY.kuryeMin);
    expect(courierPay(5000)).toBe(JOB_PAY.kuryeMax);
    expect(taxiFare(5000)).toBe(JOB_PAY.taksiMax);
    expect(meterFare(1000)).toBe(JOB_PAY.meterStart + 10 * JOB_PAY.meterPer100);
  });

  it("kurye: paketi al, zamanında teslim et, bonuslu ödeme", () => {
    const { r, add, view, goTo, players } = room();
    const e = new Economy(null);
    const h = new JobHost(r, e, () => 0.3);
    add(1);
    h.start(1, "kurye", "a", 0);
    expect(h.modelOf(1)).toBe("motor");
    const v1 = view(1)!;
    expect(v1.phase).toBe("pickup");
    // Scooter'sız varış sayılmaz
    goTo(h, 1, v1.target!, 1000);
    expect(view(1)!.phase).toBe("pickup");
    players.get(1)!.info.car = { model: "motor" };
    goTo(h, 1, v1.target!, 2000);
    const v2 = view(1)!;
    expect(v2.phase).toBe("deliver");
    expect(v2.pay).toBeGreaterThanOrEqual(JOB_PAY.kuryeMin);
    goTo(h, 1, v2.target!, 3000);
    const bonus = Math.round((v2.pay * JOB_PAY.onTime) / 5) * 5;
    expect(e.get("a")).toBe(ECON.startMoney + v2.pay + bonus);
    expect(e.wallet("a").history[0].reason).toMatch(/zamanında/);
    expect(view(1)!.done).toBe(1);
    expect(view(1)!.phase).toBe("pickup");
    // İşi bırakınca scooter'dan iner
    h.stop(1);
    expect(players.get(1)!.info.car).toBeNull();
    expect(view(1)).toBeNull();
  });

  it("taksi: müşteriyi al, götür, ücret", () => {
    const { r, add, view, goTo, players } = room();
    const e = new Economy(null);
    const h = new JobHost(r, e, () => 0.6);
    add(1);
    h.start(1, "taksi", "a", 0);
    players.get(1)!.info.car = { model: "taksi" };
    const v1 = view(1)!;
    expect(v1.phase).toBe("fetch");
    expect(v1.npc?.name).toBeTruthy();
    goTo(h, 1, v1.target!, 1000);
    const v2 = view(1)!;
    expect(v2.phase).toBe("ride");
    goTo(h, 1, v2.target!, 2000);
    expect(e.get("a")).toBe(ECON.startMoney + v2.pay);
  });

  it("oyuncu taksi çağırır; binince taksimetre, inince yolcudan alınır", () => {
    const { r, add, view, players } = room();
    const e = new Economy(null);
    const h = new JobHost(r, e);
    add(1);
    add(2, 5, 0);
    h.join(1, "driver");
    h.join(2, "rider");
    expect(h.call(2, true)).toMatch(/taksici yok/);
    h.start(1, "taksi", "driver", 0);
    players.get(1)!.info.car = { model: "taksi" };
    expect(h.call(2, true)).toBeNull();
    h.rideChanged(2, 1, null);
    expect(view(1)!.phase).toBe("meter");
    // 1 km gidilir
    for (let i = 1; i <= 50; i++) {
      players.get(1)!.state.x = i * 20;
      h.tick(i * 1000);
    }
    const fare = meterFare(1000);
    expect(view(1)!.pay).toBe(fare);
    h.rideChanged(2, null, 1);
    expect(e.get("rider")).toBe(ECON.startMoney - fare);
    expect(e.get("driver")).toBe(ECON.startMoney + fare);
    expect(view(1)!.phase).toBe("fetch");
  });
});
