import { describe, expect, it } from "vitest";
import { ACT_SPOTS, JAIL_SPAWN, PLAYER_RADIUS, RELEASE_SPAWN, TEA_SPOT } from "../shared/constants";
import { TANK_PARK } from "../shared/tank";
import { BRIDGES, CAVE, DJ_BOOTH, FAME, GROVE, HALL, KAHVEHANE, LAKE, PITCH, PLAZA, SAKURA_SPOT, SPAWN, STAGE_STEPS, TUNNEL } from "../shared/zones";
import { Colliders } from "../client/src/world/colliders";
import { BRIDGE_AXES, inCave, riverDist, terrainColliders, walkable } from "../client/src/world/terrain";

describe("arazi ve yerleşim", () => {
  it("önemli noktaların hepsi yürünebilir", () => {
    const spots: [string, { x: number; z: number }][] = [
      ["doğma", SPAWN], ["meydan kenarı", { x: PLAZA.x, z: PLAZA.z + 9 }], ["kahvehane", KAHVEHANE], ["çay ocağı", TEA_SPOT],
      ["kürsü önü", { x: FAME.x - 3, z: FAME.z }], ["mangal", ACT_SPOTS.grill], ["mangal girişi", GROVE], ["saha", PITCH], ["salon kapısı", { x: HALL.x - HALL.hw - 2, z: HALL.z }],
      ["sakura", SAKURA_SPOT], ["tank", TANK_PARK], ["sahne", STAGE_STEPS], ["dj", DJ_BOOTH], ["tünel", { x: TUNNEL[1][0], z: TUNNEL[1][1] }],
      ["mağara", CAVE], ["hücre", JAIL_SPAWN], ["parmaklık önü", ACT_SPOTS.bars], ["serbest kalış", RELEASE_SPAWN], ["göl kıyısı", { x: LAKE.x, z: LAKE.z + LAKE.r + 2 }],
    ];
    for (const [name, p] of spots) expect(walkable(p.x, p.z), name).toBe(true);
  });

  it("nehir, göl ve dağ yürünmez; köprüler yürünür", () => {
    expect(walkable(-28, 30)).toBe(false);
    expect(walkable(LAKE.x, LAKE.z)).toBe(false);
    expect(walkable(0, 125)).toBe(false);
    for (const b of BRIDGES) expect(walkable(b.x, b.z)).toBe(true);
    expect(inCave(CAVE.x, CAVE.z)).toBe(true);
    expect(inCave(SPAWN.x, SPAWN.z)).toBe(false);
  });

  it("nehir köprü dışında geçilemez, köprüden geçilir", () => {
    const c = new Colliders();
    terrainColliders(c);
    // Köprünün uzağında batı kıyısından doğuya yürü
    const p = { x: -40, z: 30 };
    for (let i = 0; i < 400; i++) {
      p.x += 0.1;
      c.resolve(p, PLAYER_RADIUS);
    }
    expect(p.x).toBeLessThan(-30);
    // Köprünün ekseni boyunca bir uçtan öbürüne
    const a = BRIDGE_AXES[1];
    const q = { x: a.x - a.ux * 10, z: a.z - a.uz * 10 };
    for (let i = 0; i < 200; i++) {
      q.x += a.ux * 0.1;
      q.z += a.uz * 0.1;
      c.resolve(q, PLAYER_RADIUS);
    }
    expect(Math.hypot(q.x - (a.x + a.ux * 10), q.z - (a.z + a.uz * 10))).toBeLessThan(0.5);
    expect(riverDist(q.x, q.z)).toBeGreaterThan(6);
  });
});
