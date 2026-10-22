import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";
import { PLAYER_RADIUS } from "../shared/constants";
import { CASINO, CASINO_MEZZ_Z } from "../shared/zones";
import type { Input } from "../client/src/input/input";
import { Player } from "../client/src/player";
import { Builder } from "../client/src/world/builder";
import { casino } from "../client/src/world/casino";
import type { World } from "../client/src/world/scene";

/** Tabelalar canvas'a yazılır: testte boş bir 2D bağlam yeter. */
function stubDocument(): void {
  const ctx: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, k) => (k === "measureText" ? () => ({ width: 0 }) : k === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => {}),
      set: () => true,
    },
  );
  (globalThis as { document?: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
}

let colliders: Builder["colliders"];
beforeAll(() => {
  stubDocument();
  const b = new Builder();
  casino(b, 0);
  colliders = b.colliders;
});

function setup(x: number, z: number) {
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
    consumeJump: () => false,
  };
  const me = new Player(world, new THREE.Color());
  // Kamera +z'ye bakıyor: ileri (moveY 1) −z yönü, yani kuzey
  const walk = (seconds: number, moveY = 1, moveX = 0) => {
    input.moveY = moveY;
    input.moveX = moveX;
    for (let t = 0; t < seconds; t += 1 / 60) me.update(1 / 60, input as unknown as Input);
    input.moveY = input.moveX = 0;
  };
  return { me, walk };
}

const westStair = CASINO.x - CASINO.hw + 0.25 + 1.5;

describe("casino", () => {
  it("ön kapıdan girilir, salonda yürünür ve kasa tezgâhında durulur", () => {
    const { me, walk } = setup(CASINO.x, CASINO.z + CASINO.hd + 9);
    walk(8);
    expect(me.z).toBeLessThan(CASINO.z);
    expect(me.z).toBeGreaterThan(CASINO_MEZZ_Z + 0.8);
    expect(me.baseY).toBe(0);
  });

  it("zemin kattan VIP kaidesinin altına ya da içine girilmez", () => {
    const { me, walk } = setup(CASINO.x - 8, CASINO_MEZZ_Z + 3);
    walk(3);
    expect(me.z).toBeGreaterThan(CASINO_MEZZ_Z + PLAYER_RADIUS - 0.01);
    expect(me.baseY).toBe(0);
  });

  it("merdivenden yürüyerek VIP katına çıkılır, korkuluk düşürmez, aynı yoldan inilir", () => {
    const { me, walk } = setup(westStair, CASINO.z + CASINO.hd - 2.5);
    // Merdivenin üstüne kadar yürü
    for (let t = 0; t < 6 && me.z > CASINO_MEZZ_Z - 1; t += 0.1) walk(0.1);
    expect(me.baseY).toBeCloseTo(CASINO.floor2, 5);
    expect(me.z).toBeLessThan(CASINO_MEZZ_Z);

    // Korkuluk boyunca katın içine (doğuya) geç, sonra salona doğru (güneye) yürü: korkuluk tutar
    const x0 = me.x;
    walk(0.2, 0, 1);
    const east = me.x > x0 ? 1 : -1;
    walk(1.5, 0, east);
    expect(Math.abs(me.x - x0)).toBeGreaterThan(3);
    walk(3, -1);
    expect(me.z).toBeLessThan(CASINO_MEZZ_Z);
    expect(me.baseY).toBeCloseTo(CASINO.floor2, 5);

    // Merdivenin başına dön ve in
    walk(3, 0, -east);
    walk(6, -1);
    expect(me.baseY).toBe(0);
    expect(me.z).toBeGreaterThan(CASINO.z);
  });
});
