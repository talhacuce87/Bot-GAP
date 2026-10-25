import { describe, expect, it } from "vitest";
import { DEFAULT_CAR } from "../shared/car";
import { CAR_PRICES, carItem, itemPrice, lookItem, modItem, ownsCar, stripUnowned, unownedMods } from "../shared/shop";
import { Economy } from "../server/src/economy";

describe("mağaza", () => {
  it("fiyatlar: başlangıç seti ve ilk üç araba bedava, diğerleri paralı", () => {
    expect(itemPrice(lookItem("top_tisort"))).toBe(0);
    expect(itemPrice(lookItem("top_smokin"))).toBe(4500);
    expect(itemPrice(lookItem("hair_rasta"))).toBe(900);
    expect(itemPrice(carItem("sahin"))).toBe(0);
    expect(itemPrice(carItem("e30"))).toBe(85_000);
    expect(itemPrice(modItem("sahin", "engine", "turbo"))).toBe(12_000);
    expect(itemPrice(modItem("sahin", "engine", "stok"))).toBe(0);
    expect(itemPrice(modItem("sahin", "tint", true))).toBe(2000);
    expect(itemPrice("look")).toBeNull();
    expect(itemPrice(modItem("sahin", "engine", "roket"))).toBeNull();
    expect(Object.values(CAR_PRICES).filter((p) => p === 0)).toHaveLength(3);
  });

  it("satın alınmamış araba sürülmez, modifiyeler sökülür", () => {
    const owned = new Set([modItem("sahin", "rim", "altin")]);
    const owns = (i: string) => owned.has(i);
    expect(ownsCar("sahin", owns)).toBe(true);
    expect(ownsCar("passat", owns)).toBe(false);
    const spec = { ...DEFAULT_CAR, rim: "altin" as const, engine: "yaris" as const, tint: true };
    expect(unownedMods(spec, owns)).toEqual([modItem("sahin", "engine", "yaris"), modItem("sahin", "tint", true)]);
    const clean = stripUnowned(spec, owns);
    expect(clean.rim).toBe("altin");
    expect(clean.engine).toBe("stok");
    expect(clean.tint).toBe(false);
  });

  it("sahip olunanlar hesapta saklanır", () => {
    const e = new Economy(null);
    expect(e.owns("a", carItem("doblo"))).toBe(false);
    expect(e.grant("a", [carItem("doblo")])).toBe(true);
    expect(e.grant("a", [carItem("doblo")])).toBe(false);
    expect(e.owns("a", carItem("doblo"))).toBe(true);
    expect(e.ownedList("a")).toEqual([carItem("doblo")]);
  });
});
