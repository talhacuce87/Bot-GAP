import { describe, expect, it } from "vitest";
import { signValue, verifyValue } from "../server/src/auth";
import { Watch, Watches, WATCH_IDLE_MS } from "../server/src/watch";

const yt = { kind: "youtube" as const, id: "dQw4w9WgXcQ", start: 30 };
const kick = { kind: "kick" as const, channel: "abc" };

describe("Watch", () => {
  it("starts playing from the link's start time and advances with the clock", () => {
    const w = new Watch("x", null, "Ali", yt, "Video", 1000);
    expect(w.state).toMatchObject({ playing: true, position: 30, op: "load", by: "Ali" });
    expect(w.positionAt(11_000)).toBeCloseTo(40);
  });

  it("pause freezes the server-side position, play resumes from it", () => {
    const w = new Watch("x", null, "Ali", yt, "Video", 0);
    expect(w.apply({ op: "pause" }, "Ayşe", 5000)).toBe(true);
    expect(w.state).toMatchObject({ playing: false, position: 35, by: "Ayşe", op: "pause" });
    expect(w.positionAt(60_000)).toBe(35);
    expect(w.apply({ op: "pause" }, "Ayşe", 6000)).toBe(false); // zaten duruyor
    expect(w.apply({ op: "play" }, "Ali", 10_000)).toBe(true);
    expect(w.positionAt(12_000)).toBeCloseTo(37);
  });

  it("seek clamps bad positions and live streams cannot be paused or seeked", () => {
    const w = new Watch("x", null, "Ali", yt, "Video", 0);
    expect(w.apply({ op: "seek", pos: -50 }, "Ali", 1)).toBe(true);
    expect(w.state.position).toBe(0);
    expect(w.apply({ op: "seek", pos: Number.NaN }, "Ali", 2)).toBe(false);

    const live = new Watch("y", null, "Ali", kick, "Kick", 0);
    expect(live.apply({ op: "pause" }, "Ali", 1)).toBe(false);
    expect(live.apply({ op: "seek", pos: 10 }, "Ali", 1)).toBe(false);
  });

  it("load switches the source and restarts playback", () => {
    const w = new Watch("x", null, "Ali", yt, "Video", 0);
    w.apply({ op: "pause" }, "Ali", 1000);
    w.load(kick, "Kick", "Mert", 2000);
    expect(w.state).toMatchObject({ source: kick, title: "Kick", playing: true, position: 0, by: "Mert", op: "load" });
  });
});

describe("Watches", () => {
  it("creates unique ids and sweeps only empty, idle rooms", () => {
    const ws = new Watches();
    const a = ws.create(null, "Ali", yt, "A", 0);
    const b = ws.create(null, "Ali", yt, "B", 0);
    expect(a.id).not.toBe(b.id);
    ws.sweep((w) => w.id === a.id, WATCH_IDLE_MS + 1);
    expect(ws.get(a.id)).toBeUndefined();
    expect(ws.get(b.id)).toBeDefined(); // içinde biri var
  });
});

describe("signed values (OAuth state)", () => {
  it("round-trips and rejects tampering", () => {
    const t = signValue("123|/w/abc", "s");
    expect(verifyValue(t, "s")).toBe("123|/w/abc");
    expect(verifyValue(t, "other")).toBeNull();
    expect(verifyValue(t.replace(/^./, "x"), "s")).toBeNull();
  });
});
