import { describe, expect, it } from "vitest";
import {
  decodeState,
  encodeState,
  type PlayerState,
  readSnapshot,
  snapshotSize,
  STATE_BYTES,
  writeSnapshotEntry,
  writeSnapshotHeader,
} from "../shared/protocol";

describe("protocol", () => {
  it("state round-trips with centimetre precision", () => {
    const view = new DataView(new ArrayBuffer(STATE_BYTES));
    encodeState(view, { x: 12.345, z: -7.891, rot: 4, flags: 3 });
    const out: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
    expect(decodeState(view, out)).toBe(true);
    expect(out.x).toBeCloseTo(12.35, 2);
    expect(out.z).toBeCloseTo(-7.89, 2);
    expect(out.rot).toBeCloseTo(4, 3);
    expect(out.flags).toBe(3);
  });

  it("normalises negative rotation", () => {
    const view = new DataView(new ArrayBuffer(STATE_BYTES));
    encodeState(view, { x: 0, z: 0, rot: -Math.PI / 2, flags: 0 });
    const out: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
    decodeState(view, out);
    expect(out.rot).toBeCloseTo((3 * Math.PI) / 2, 3);
  });

  it("rejects wrong-sized state", () => {
    const out: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
    expect(decodeState(new DataView(new ArrayBuffer(5)), out)).toBe(false);
  });

  it("snapshot round-trips all entries", () => {
    const buf = new ArrayBuffer(snapshotSize(2));
    const view = new DataView(buf);
    writeSnapshotHeader(view, 1234567.5, 2);
    writeSnapshotEntry(view, 0, 7, { x: 1, z: 2, rot: 0, flags: 1 });
    writeSnapshotEntry(view, 1, 9, { x: -3, z: 4, rot: 1, flags: 2 });
    const seen: number[][] = [];
    const t = readSnapshot(view, (sid, x, z, _r, flags) => seen.push([sid, x, z, flags]));
    expect(t).toBe(1234567.5);
    expect(seen).toEqual([
      [7, 1, 2, 1],
      [9, -3, 4, 2],
    ]);
  });

  it("rejects truncated snapshot", () => {
    const view = new DataView(new ArrayBuffer(snapshotSize(2)));
    writeSnapshotHeader(view, 0, 3);
    expect(readSnapshot(view, () => {})).toBe(-1);
  });
});
