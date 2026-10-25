import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CAR_BOOST, CAR_ENGINES, CAR_HULL_R, CAR_MAX_SPEED, CAR_MODELS, CAR_SPEED, carPerf, DEFAULT_CAR, NO_DENTS, validCar } from "../shared/car";
import { PLAYER_RADIUS } from "../shared/constants";
import type { ServerEvent } from "../shared/protocol";
import { type Conn, Room } from "../server/src/room";
import type { Input } from "../client/src/input/input";
import { Player } from "../client/src/player";
import { Colliders } from "../client/src/world/colliders";
import type { World } from "../client/src/world/scene";

class FakeConn implements Conn {
  bufferedAmount = 0;
  text: ServerEvent[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.text.push(JSON.parse(data));
  }
}

/** Kuzeyde (z = −20) bir duvar; ortasında 2.6 m'lik kapı, kapıda yalnızca arabayı durduran çizgi. */
function setup(x: number, z: number) {
  const colliders = new Colliders();
  const carColliders = new Colliders();
  colliders.segment(-30, -20, -1.3, -20, 0.15);
  colliders.segment(1.3, -20, 30, -20, 0.15);
  carColliders.segment(-1.3, -20, 1.3, -20, 0.2);
  const world = { spawn: { x, z, rot: Math.PI }, colliders, carColliders, seats: [] } as unknown as World;
  const input = {
    moveX: 0,
    moveY: 0,
    run: false,
    lookX: 0,
    consumeLook(out: { x: number; y: number }) {
      out.x = this.lookX;
      out.y = 0;
    },
    consumeZoom: () => 0,
    hand: false,
    consumeAction: () => false,
    consumeJump: () => false,
    heldAction(a: string) {
      return a === "jump" && this.hand;
    },
  };
  const me = new Player(world, new THREE.Color());
  me.rot = Math.PI; // kuzeye (−z) bakar
  (me as unknown as { yaw: number }).yaw = 0;
  const run = (seconds: number, moveY: number, moveX = 0, fast = false) => {
    input.moveY = moveY;
    input.moveX = moveX;
    input.run = fast;
    let top = 0;
    for (let t = 0; t < seconds; t += 1 / 60) {
      const x0 = me.x, z0 = me.z;
      me.update(1 / 60, input as unknown as Input);
      top = Math.max(top, Math.hypot(me.x - x0, me.z - z0) * 60);
    }
    input.moveY = input.moveX = 0;
    return top;
  };
  return { me, run, input };
}

describe("Tofaş", () => {
  it("geçersiz görünüm alanlarını varsayılana çevirir, plakayı büyük harf yapar", () => {
    expect(validCar(null)).toBeNull();
    expect(validCar("x")).toBeNull();
    const c = validCar({ model: "ferrari", color: "kirmizi", rim: "altin", neon: "mavi", tint: "evet", low: true, plate: "  06 doğan  9 " });
    expect(c).toEqual({ ...DEFAULT_CAR, color: "kirmizi", rim: "altin", neon: "mavi", low: true, plate: "06 DOĞAN 9" });
    expect(validCar({ plate: "<script>" })?.plate).toBe(DEFAULT_CAR.plate);
  });

  it("gazla hızlanır ama sınırı aşmaz, duvara çarpınca durur", () => {
    const { me, run } = setup(10, 160);
    me.enterCar();
    const top = run(14, 1, 0, true);
    expect(top).toBeGreaterThan(CAR_SPEED * 0.9);
    expect(top).toBeLessThan(CAR_MAX_SPEED);
    // 180 m ileride duvar: tam hızda bile içinden geçmez
    expect(me.z).toBeGreaterThan(-20 + CAR_HULL_R - 0.05);
    expect(me.car!.v).toBeLessThan(2);
  });

  it("direksiyon yalnızca giderken döndürür; fren ve geri vites çalışır", () => {
    const { me, run } = setup(0, 60);
    me.enterCar();
    run(1, 0, 1);
    expect(me.rot).toBeCloseTo(Math.PI, 5);
    run(2, 1, 1);
    expect(Math.abs(me.rot - Math.PI)).toBeGreaterThan(0.3);
    run(3, -1);
    expect(me.car!.v).toBeLessThan(0);
  });

  it("sürerken kamera fareyle serbestçe döner; fare bırakılınca bir süre sonra arabanın arkasına geçer", () => {
    const { me, run, input } = setup(0, 60);
    const yaw = () => (me as unknown as { yaw: number }).yaw;
    me.enterCar();
    run(1, 1);
    const behind = me.rot + Math.PI;
    input.lookX = 120;
    run(0.3, 1);
    input.lookX = 0;
    const turned = yaw();
    expect(Math.abs(turned - behind)).toBeGreaterThan(0.5);
    run(1, 1);
    expect(Math.abs(yaw() - turned)).toBeLessThan(0.05);
    run(4, 1);
    const d = Math.atan2(Math.sin(yaw() - (me.rot + Math.PI)), Math.cos(yaw() - (me.rot + Math.PI)));
    expect(Math.abs(d)).toBeLessThan(0.1);
  });

  it("araba dükkân kapısından giremez ama yaya geçer; inince sürücü kapısından çıkar", () => {
    const { me, run } = setup(0, -5);
    me.enterCar();
    run(4, 1);
    expect(me.z).toBeGreaterThan(-20);
    me.exitCar();
    expect(me.car).toBeNull();
    me.x = 0;
    (me as unknown as { yaw: number }).yaw = 0;
    run(6, 1);
    expect(me.z).toBeLessThan(-20 - PLAYER_RADIUS);
  });
});

describe("Araba · sürüş", () => {
  it("motor yükseltmesi ve model tepe hızı değiştirir; en hızlısı bile sunucu sınırının altında", () => {
    const stock = carPerf({ model: "sahin", engine: "stok" });
    const race = carPerf({ model: "sahin", engine: "yaris" });
    expect(race.top).toBeGreaterThan(stock.top * 1.3);
    expect(race.accel).toBeGreaterThan(stock.accel * 1.5);
    for (const m of CAR_MODELS) for (const e of CAR_ENGINES) expect(carPerf({ model: m.id, engine: e.id }).top * CAR_BOOST).toBeLessThan(CAR_MAX_SPEED);
    expect(validCar({ model: "linea", engine: "yaris", horn: "cucaracha" })).toMatchObject({ model: "linea", engine: "yaris", horn: "cucaracha" });
    expect(validCar({ engine: "v12", horn: "siren" })).toMatchObject({ engine: "stok", horn: "standart" });
  });

  it("el freni arabayı kaydırır (drift) ve yavaşlatır; bırakınca lastikler toparlar", () => {
    const { me, run, input } = setup(0, 200);
    me.enterCar();
    run(4, 1);
    const v0 = me.car!.v;
    input.hand = true;
    run(0.6, 1, 1);
    expect(Math.abs(me.car!.slip)).toBeGreaterThan(2);
    expect(me.car!.v).toBeLessThan(v0);
    input.hand = false;
    run(1.5, 1);
    expect(Math.abs(me.car!.slip)).toBeLessThan(0.5);
  });

  it("duvara açılı çarpınca donup kalmaz: seker, duvar boyunca kayar, döner", () => {
    const { me, run } = setup(-5, -2);
    me.enterCar();
    me.rot = Math.PI + 0.6; // kuzeye, 34° açıyla duvara
    run(2.4, 1);
    const sp = Math.hypot(me.car!.v, me.car!.slip);
    expect(me.z).toBeGreaterThan(-20 + 0.5);
    expect(sp).toBeGreaterThan(2);
    expect(Math.abs(me.car!.spin ?? 0) + Math.abs(me.rot - (Math.PI + 0.6))).toBeGreaterThan(0.05);
  });

  it("başka araca çarpınca hız kütleye göre paylaşılır, o da itilir", () => {
    const { me, run } = setup(-10, 60);
    let got = 0;
    const body = { x: -10, z: 50, rot: 0, vx: 0, vz: 0, mass: 1, hl: 2.15, hw: 0.86, hit: (dvx: number, dvz: number) => (got += Math.hypot(dvx, dvz)) };
    (me as unknown as { world: { carBodies: () => unknown[] } }).world.carBodies = () => [body];
    me.enterCar();
    run(1.5, 1);
    expect(got).toBeGreaterThan(2);
    expect(me.z).toBeGreaterThan(50 + 1.5);
  });

  it("normal virajda yol tutar (kayma küçük)", () => {
    const { me, run } = setup(0, 200);
    me.enterCar();
    run(3, 1);
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      run(1 / 30, 1, 0.5);
      worst = Math.max(worst, Math.abs(me.car!.slip));
    }
    expect(worst).toBeLessThan(1.5);
  });
});

describe("Room · Tofaş", () => {
  it("arabaya binişi duyurur ve arabadakinin daha hızlı gitmesine izin verir", () => {
    const room = new Room("g:test");
    const a = new FakeConn(), b = new FakeConn();
    const sa = room.join({ id: "a", name: "a", avatar: null, guest: true }, a, 0);
    room.join({ id: "b", name: "b", avatar: null, guest: true }, b, 0);
    const p = room.players.get(sa)!.state;
    const start = { x: p.x, z: p.z };
    // Yürürken 100 ms'de ancak birkaç metre
    room.applyState(sa, { x: start.x + 20, z: start.z, rot: 0, flags: 1 }, 100);
    const walked = p.x - start.x;
    room.setCar(sa, validCar({ color: "taksi" }));
    expect(b.text.some((e) => e.t === "car" && e.sid === sa && e.car?.color === "taksi")).toBe(true);
    const x1 = p.x;
    room.applyState(sa, { x: x1 + 20, z: start.z, rot: 0, flags: 0 }, 200);
    expect(p.x - x1).toBeGreaterThan(walked);
    expect(p.x - x1).toBeLessThan(CAR_MAX_SPEED * 0.1 * 1.3 + 0.6);
    room.setCar(sa, null);
    expect(room.players.get(sa)!.info.car).toBeNull();
  });
});

describe("Room · park halindeki araba", () => {
  it("inince araba yanında park edilir, herkes görür; uzağa park edilmez; binince park yeri boşalır", () => {
    const room = new Room("g:test");
    const a = new FakeConn(), b = new FakeConn();
    const sa = room.join({ id: "a", name: "a", avatar: null, guest: true }, a, 0);
    room.join({ id: "b", name: "b", avatar: null, guest: true }, b, 0);
    const p = room.players.get(sa)!;
    const car = validCar({ model: "kartal", color: "kirmizi" })!;
    room.setParked(sa, { car, x: p.state.x + 300, z: p.state.z, rot: 0 });
    expect(p.info.parked ?? null).toBeNull();
    room.setParked(sa, { car, x: p.state.x + 3, z: p.state.z, rot: 1 });
    expect(p.info.parked?.car.model).toBe("kartal");
    expect(b.text.some((e) => e.t === "parked" && e.sid === sa && e.parked?.car.color === "kirmizi")).toBe(true);
    room.setCar(sa, car);
    expect(p.info.parked).toBeNull();
    expect(b.text.some((e) => e.t === "parked" && e.sid === sa && e.parked === null)).toBe(true);
  });

  it("göçükleriyle park edilir (geçersiz hasar düşer); iş aracı göçüksüz park eder ve hasar almaz", () => {
    const room = new Room("g:test");
    const a = new FakeConn();
    const sa = room.join({ id: "a", name: "a", avatar: null, guest: true }, a, 0);
    const p = room.players.get(sa)!;
    const car = validCar({ model: "sahin" })!;
    const dents = { f: 2, r: 0, l: 1, rt: 0, hl: 1 };
    room.setParked(sa, { car, x: p.state.x + 3, z: p.state.z, rot: 0, dmg: 2, dents });
    expect(p.info.parked?.dmg).toBe(2);
    expect(p.info.parked?.dents).toEqual(dents);
    room.setParked(sa, { car, x: p.state.x + 3, z: p.state.z, rot: 0, dmg: 9, dents: { f: 7 } });
    expect(p.info.parked?.dmg).toBeUndefined();
    expect(p.info.parked?.dents).toBeUndefined();
    // İş aracı: işte değilken model düşer; işteyken bile hasar 0
    room.setCar(sa, { ...car, model: "taksi" });
    room.setCarDamage(sa, 3, dents);
    expect(p.info.dmg ?? 0).toBe(0);
    expect(p.info.dents ?? NO_DENTS).toEqual(NO_DENTS);
    room.setCar(sa, car);
    room.setCarDamage(sa, 3, dents);
    expect(p.info.dmg).toBe(3);
  });

  it("eski kayıttaki arabaya far ve egzoz varsayılan olarak eklenir", () => {
    const c = validCar({ model: "dogan", color: "siyah", lights: "lazer", exhaust: "cift" })!;
    expect(c.lights).toBe("standart");
    expect(c.exhaust).toBe("cift");
    expect(validCar({ ...DEFAULT_CAR })).toEqual(DEFAULT_CAR);
  });
});
