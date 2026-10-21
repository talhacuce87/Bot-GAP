import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { PLAYER_RADIUS } from "../shared/constants";
import { HULL_TOP, hullCircles, TURRET_TOP } from "../shared/tank";
import type { Input } from "../client/src/input/input";
import { Player } from "../client/src/player";
import { Colliders } from "../client/src/world/colliders";
import type { World } from "../client/src/world/scene";

/** Meydandaki çeşme: havuz kenarı 0.6, tepedeki çanak 1.7. */
function fountain(): Colliders {
  const c = new Colliders();
  c.circle(0, 0, 2.4, 0.6);
  c.circle(0, 0, 0.9, 1.7);
  return c;
}

function setup(colliders: Colliders, x: number, z: number) {
  const world = { spawn: { x, z, rot: 0 }, colliders, seats: [] } as unknown as World;
  const input = {
    moveX: 0,
    moveY: 0,
    run: false,
    jump: false,
    consumeLook(out: { x: number; y: number }) {
      out.x = out.y = 0;
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
  // Kamera +z'ye bakıyor: ileri (moveY 1) −z yönü
  const walk = (seconds: number, jump = false) => {
    input.moveY = 1;
    input.jump = jump;
    step(seconds);
    input.moveY = 0;
  };
  /** Zıplayıp ileri gider; altındaki yüzey `top` olunca durur ve konar. */
  const hop = (top: number) => {
    input.moveY = 1;
    input.jump = true;
    for (let t = 0; t < 2 && me.baseY < top; t += 1 / 60) me.update(1 / 60, input as unknown as Input);
    input.moveY = 0;
    step(1.2);
  };
  return { me, input, step, walk, hop };
}

const feet = (me: Player) => me.baseY + me.jumpY;

describe("climbing onto things", () => {
  it("walks into the fountain without climbing, but jumps onto its rim and then onto the top", () => {
    const { me, walk, hop } = setup(fountain(), 0, 5);
    walk(2);
    expect(me.z).toBeGreaterThan(2.4 + PLAYER_RADIUS - 0.01); // duvar gibi itti
    expect(feet(me)).toBe(0);

    hop(0.6); // havuz kenarına
    expect(me.baseY).toBe(0.6);
    expect(me.jumpY).toBe(0);

    walk(1); // çanağa dayan
    hop(1.7); // oradan tepeye
    expect(me.baseY).toBe(1.7);
    expect(me.jumpY).toBe(0);
    expect(Math.hypot(me.x, me.z)).toBeLessThan(0.9 + PLAYER_RADIUS);
  });

  it("falls off the edge and lands on the ground", () => {
    const { me, input, hop, step } = setup(fountain(), 0, 5);
    hop(0.6);
    expect(me.baseY).toBe(0.6);
    input.moveY = -1; // geri yürü: kenardan düş
    step(1);
    input.moveY = 0;
    step(1);
    expect(feet(me)).toBe(0);
    expect(me.z).toBeGreaterThan(2.4);
  });

  it("cannot jump onto something higher than a jump", () => {
    const c = new Colliders();
    c.circle(0, 0, 1, 1.6);
    const { me, walk, step } = setup(c, 0, 3);
    walk(1.5, true);
    step(1.5);
    expect(feet(me)).toBe(0);
    expect(me.z).toBeGreaterThan(1 + PLAYER_RADIUS - 0.01);
  });

  it("climbs onto the tank's deck and turret, and rides along when it moves", () => {
    const { me, walk, hop, step } = setup(new Colliders(), 0, 4.5);
    me.obstacle = hullCircles(0, 0, 0);
    walk(1);
    hop(HULL_TOP);
    expect(me.baseY).toBe(HULL_TOP);
    walk(1);
    hop(TURRET_TOP);
    expect(me.baseY).toBe(TURRET_TOP);

    // Tank 1 m kaydı: üstündeki de kayar
    const x0 = me.x;
    for (let i = 1; i <= 10; i++) {
      me.obstacle = hullCircles(i * 0.1, 0, 0);
      step(1 / 60);
    }
    expect(me.x - x0).toBeCloseTo(1, 2);
    expect(me.baseY).toBe(TURRET_TOP);
  });
});
