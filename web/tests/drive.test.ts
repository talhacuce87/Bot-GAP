import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { FLAG_DRIVING, PLAYER_RADIUS } from "../shared/constants";
import { computeShot, DEFAULT_ELEV, ELEV_MAX, hullCircles, shellAt, solveElev, TANK_HULL_R, TANK_SPEED } from "../shared/tank";
import type { Input } from "../client/src/input/input";
import { Player } from "../client/src/player";
import { Colliders } from "../client/src/world/colliders";
import type { World } from "../client/src/world/scene";

function setup(colliders = new Colliders()) {
  const world = { spawn: { x: 0, z: 0, rot: 0 }, colliders, seats: [] } as unknown as World;
  const input = {
    moveX: 0,
    moveY: 0,
    run: false,
    jump: false,
    lookY: 0,
    consumeLook(out: { x: number; y: number }) {
      out.x = 0;
      out.y = this.lookY;
      this.lookY = 0;
    },
    consumeZoom: () => 0,
    consumeAction: () => false,
    consumeJump() {
      const j = this.jump;
      this.jump = false;
      return j;
    },
  };
  const me = new Player(world, new THREE.Color());
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) me.update(1 / 60, input as unknown as Input);
  };
  return { me, input, step };
}

describe("driving the tank", () => {
  it("drives forward along the hull, turns with A/D and fires on Space", () => {
    const { me, input, step } = setup();
    me.enterTank(0, 0, 0, 0);
    input.moveY = 1;
    step(3);
    expect(me.z).toBeGreaterThan(TANK_SPEED * 1.5); // +z'ye (gövde yönü) ilerledi
    expect(Math.abs(me.x)).toBeLessThan(0.01);
    expect(me.flags & FLAG_DRIVING).toBeTruthy();

    input.moveY = 0;
    input.moveX = 1; // sağa dön: başlık azalır
    step(0.5);
    expect(me.driving!.h).toBeLessThan(0);

    input.jump = true;
    step(1 / 60);
    expect(me.wantsFire).toBe(true);
  });

  it("turns the turret and barrel onto the crosshair point so the shell lands there", () => {
    const { me, step } = setup();
    me.enterTank(0, 0, 0, 0);
    me.aimAt = { x: 30, y: 0, z: 30 }; // sağ-ön, ~42 m
    step(3);
    expect(me.aimReady).toBe(true);
    const { shot } = computeShot(me.x, me.z, me.driving!.tr, [], me.driving!.el);
    const end = shellAt(shot, shot.flight);
    expect(Math.hypot(end.x - 30, end.z - 30)).toBeLessThan(1.5);

    me.aimAt = { x: 0, y: 40, z: 150 }; // gökyüzü: menzil dışı, en uzak atış
    step(2);
    expect(me.driving!.el).toBeCloseTo(ELEV_MAX);
  });

  it("solves low-arc elevation and saturates when out of range", () => {
    expect(solveElev(25, 0)).toBeGreaterThan(DEFAULT_ELEV - 0.05);
    expect(solveElev(25, 0)).toBeLessThan(0.1);
    expect(solveElev(500, 0)).toBe(ELEV_MAX);
    expect(solveElev(60, 0)).toBeGreaterThan(solveElev(30, 0));
  });

  it("is stopped by obstacles and drops the driver beside the hull", () => {
    const walls = new Colliders();
    walls.segment(-10, 8, 10, 8, 0.3);
    const { me, input, step } = setup(walls);
    me.enterTank(0, 0, 0, 0);
    input.moveY = 1;
    step(5);
    const [fx, fz] = hullCircles(me.x, me.z, me.driving!.h);
    expect(fz).toBeLessThanOrEqual(8 - 0.3 - TANK_HULL_R + 0.05); // ön daire duvarı geçmedi
    expect(Math.abs(fx)).toBeLessThan(0.5);

    const tank = { x: me.x, z: me.z };
    me.exitTank();
    expect(me.driving).toBeNull();
    expect(me.flags & FLAG_DRIVING).toBe(0);
    expect(Math.hypot(me.x - tank.x, me.z - tank.z)).toBeGreaterThan(2);
  });

  it("knocks walkers back, and walkers cannot pass through the parked tank", () => {
    const { me, input, step } = setup();
    me.knock(10, 0);
    step(1);
    expect(me.x).toBeGreaterThan(2.5);

    // Tank önde dururken ileri yürüyen oyuncu gövdenin içine giremez
    me.teleport(0, -6, 0);
    me.obstacle = hullCircles(0, 0, 0);
    input.moveY = 1; // teleport kamerayı arkaya koyar: ileri = +z, tanka doğru
    step(3);
    expect(me.z).toBeGreaterThan(-3); // gerçekten tanka dayandı
    const [fx, fz, bx, bz] = me.obstacle;
    const gap = Math.min(Math.hypot(me.x - fx, me.z - fz), Math.hypot(me.x - bx, me.z - bz));
    expect(gap).toBeGreaterThanOrEqual(TANK_HULL_R + PLAYER_RADIUS - 0.01);
  });
});
