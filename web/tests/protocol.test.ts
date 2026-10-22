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
import { WORLD_EXTENT } from "../shared/constants";

describe("protocol", () => {
  it("state round-trips with 2 cm precision and its sample time", () => {
    const view = new DataView(new ArrayBuffer(STATE_BYTES));
    encodeState(view, { x: 12.345, z: -7.891, rot: 4, flags: 3 }, 1_760_000_000_123.25);
    const out: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
    expect(decodeState(view, out)).toBe(1_760_000_000_123.25);
    expect(Math.abs(out.x - 12.345)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(out.z + 7.891)).toBeLessThanOrEqual(0.01);
    expect(out.rot).toBeCloseTo(4, 3);
    expect(out.flags).toBe(3);
  });

  it("every corner of the world (village to the far end of the city) fits the encoding", () => {
    const view = new DataView(new ArrayBuffer(STATE_BYTES));
    const out: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
    for (const x of [WORLD_EXTENT.minX, WORLD_EXTENT.maxX]) {
      for (const z of [WORLD_EXTENT.minZ, WORLD_EXTENT.maxZ]) {
        encodeState(view, { x, z, rot: 0, flags: 0 });
        decodeState(view, out);
        expect(Math.abs(out.x - x)).toBeLessThanOrEqual(0.01);
        expect(Math.abs(out.z - z)).toBeLessThanOrEqual(0.01);
      }
    }
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
    expect(decodeState(new DataView(new ArrayBuffer(5)), out)).toBe(-1);
  });

  it("accepts untimed state from a page that has not reloaded yet", () => {
    const view = new DataView(new ArrayBuffer(STATE_BYTES));
    encodeState(view, { x: 1, z: 2, rot: 0, flags: 1 }, 5000);
    const out: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
    expect(decodeState(new DataView(view.buffer, 0, 8), out)).toBe(0);
    expect(out.x).toBe(1);
  });

  it("treats a garbage sample time as unknown", () => {
    const view = new DataView(new ArrayBuffer(STATE_BYTES));
    const out: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
    for (const t of [NaN, Infinity, -5]) {
      encodeState(view, { x: 0, z: 0, rot: 0, flags: 0 }, t);
      expect(decodeState(view, out)).toBe(0);
    }
  });

  it("snapshot round-trips all entries, each with its own sample time", () => {
    const buf = new ArrayBuffer(snapshotSize(3));
    const view = new DataView(buf);
    writeSnapshotHeader(view, 1234567.5, 3);
    writeSnapshotEntry(view, 0, 7, { x: 1, z: 2, rot: 0, flags: 1 }, 12);
    writeSnapshotEntry(view, 1, 9, { x: -3, z: 4, rot: 1, flags: 2 });
    // Saatlerce duran oyuncu: yaş u16'ya sığmaz, en eski değerde kalır
    writeSnapshotEntry(view, 2, 11, { x: 0, z: 0, rot: 0, flags: 0 }, 1e9);
    const seen: number[][] = [];
    const t = readSnapshot(view, (sid, x, z, _r, flags, time) => seen.push([sid, x, z, flags, time]));
    expect(t).toBe(1234567.5);
    expect(seen).toEqual([
      [7, 1, 2, 1, 1234555.5],
      [9, -3, 4, 2, 1234567.5],
      [11, 0, 0, 0, 1234567.5 - 0xffff],
    ]);
  });

  it("rejects truncated snapshot", () => {
    const view = new DataView(new ArrayBuffer(snapshotSize(2)));
    writeSnapshotHeader(view, 0, 3);
    expect(readSnapshot(view, () => {})).toBe(-1);
  });
});
