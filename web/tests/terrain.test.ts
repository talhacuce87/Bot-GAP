import { describe, expect, it } from "vitest";
import { ACT_SPOTS, JAIL_SPAWN, PLAYER_RADIUS, RELEASE_SPAWN, TEA_SPOT } from "../shared/constants";
import { TANK_PARK } from "../shared/tank";
import { BRIDGES, CAVE, DJ_BOOTH, FAME, GROVE, HALL, KAHVEHANE, LAKE, PITCH, PLAZA, ROAD_RIVER, ROADS, SAKURA_SPOT, SPAWN, STADIUM, STAGE_STEPS, TUNNEL, VILLAGE_ROADS, VOLLEY_HALL, inStadium, inVolley } from "../shared/zones";
import { Colliders } from "../client/src/world/colliders";
import { BRIDGE_AXES, inCave, riverDist, terrainColliders, terrainHeight, walkable } from "../client/src/world/terrain";

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

  it("stadyum ve voleybol salonu düz zeminde, hiçbir yolun yakınında değil (arabayla geçerken yanlışlıkla girilmez)", () => {
    for (const [x, z] of [[STADIUM.x, STADIUM.z], [STADIUM.x + STADIUM.hw, STADIUM.z + STADIUM.hd], [VOLLEY_HALL.x, VOLLEY_HALL.z], [VOLLEY_HALL.x - VOLLEY_HALL.hw, VOLLEY_HALL.z + VOLLEY_HALL.hd]]) {
      expect(terrainHeight(x, z)).toBe(0);
    }
    for (const r of [...ROADS, ...VILLAGE_ROADS]) for (const [x, z] of r) expect(inVolley(x, z) || inStadium(x, z)).toBe(false);
  });

  it("otoban, mahalle bağlantı yolları ve köy yolları baştan sona yürünür (tepelerin arasından ve köprüden geçer)", () => {
    const blocked: string[] = [];
    for (const r of [...ROADS, ...VILLAGE_ROADS]) for (const [x, z] of r) if (!walkable(x, z)) blocked.push(`${x.toFixed(0)},${z.toFixed(0)}`);
    expect(blocked).toEqual([]);
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
    const a = BRIDGE_AXES[0];
    const q = { x: a.x - a.ux * 10, z: a.z - a.uz * 10 };
    for (let i = 0; i < 200; i++) {
      q.x += a.ux * 0.1;
      q.z += a.uz * 0.1;
      c.resolve(q, PLAYER_RADIUS);
    }
    expect(Math.hypot(q.x - (a.x + a.ux * 10), q.z - (a.z + a.uz * 10))).toBeLessThan(0.5);
    expect(riverDist(q.x, q.z)).toBeGreaterThan(6);
    // Otobanın köprüsü: batı ucundan doğu ucuna (araba da yaya da)
    const [wx, wz] = ROAD_RIVER.west, [ex, ez] = ROAD_RIVER.east;
    const r = { x: wx, z: wz };
    for (let i = 0; i < 400; i++) {
      r.x += (ex - wx) / 400;
      r.z += (ez - wz) / 400;
      c.resolve(r, PLAYER_RADIUS);
    }
    expect(Math.hypot(r.x - ex, r.z - ez)).toBeLessThan(0.5);
  });
});
