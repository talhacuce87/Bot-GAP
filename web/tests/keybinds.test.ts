import { beforeEach, describe, expect, it } from "vitest";
import { actionsOf, bindLabel, binds, DEFAULT_BINDS, resetBinds, setBind } from "../client/src/input/keybinds";

describe("key bindings", () => {
  beforeEach(() => resetBinds());

  it("starts with run on left shift and shift lock on right shift", () => {
    expect(binds.run[0]).toBe("ShiftLeft");
    expect(binds.shiftlock[0]).toBe("ShiftRight");
    expect(actionsOf("WheelDown")).toEqual(["zoomOut"]);
  });

  it("moves a key that is already used to the new action", () => {
    const taken = setBind("jump", 1, "WheelDown");
    expect(taken).toBe("zoomOut");
    expect(binds.jump).toEqual(["Space", "WheelDown"]);
    expect(binds.zoomOut).toEqual(["", ""]);
    expect(actionsOf("WheelDown")).toEqual(["jump"]);
  });

  it("swapping slots of the same action does not report a conflict", () => {
    expect(setBind("forward", 1, "KeyW")).toBeNull();
    expect(binds.forward).toEqual(["", "KeyW"]);
  });

  it("clears a slot and resets to defaults", () => {
    setBind("sit", 0, "");
    expect(binds.sit[0]).toBe("");
    resetBinds();
    expect(binds).toEqual(DEFAULT_BINDS);
  });

  it("a key event without a code triggers nothing (empty slots are not a key)", () => {
    expect(binds.photo[1]).toBe("");
    expect(actionsOf("")).toEqual([]);
  });

  it("names keys for the screen", () => {
    expect(bindLabel("KeyQ")).toBe("Q");
    expect(bindLabel("WheelDown")).toBe("Tekerlek ↓");
    expect(bindLabel("Mouse4")).toBe("Fare ileri");
    expect(bindLabel("")).toBe("—");
  });
});
