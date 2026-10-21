import { describe, expect, it } from "vitest";
import { NEED_BUCKET_MS, NetStats, Series } from "../client/src/netstats";
import { MSG_PONG, PING_BYTES, pongFor, readPong, writePing } from "../shared/protocol";

describe("ping over the fast path", () => {
  it("answers a ping with its sequence, send time and the server time", () => {
    const view = new DataView(new ArrayBuffer(PING_BYTES));
    writePing(view, 70_000, 1234.5);
    const pong = pongFor(view, 99_999)!;
    expect(pong[0]).toBe(MSG_PONG);
    expect(readPong(new DataView(pong.buffer))).toEqual({ seq: 70_000 & 0xffff, c: 1234.5, s: 99_999 });
    expect(pongFor(new DataView(new ArrayBuffer(16)), 1)).toBeNull();
  });
});

describe("Series", () => {
  it("keeps the newest samples in order and summarises a window", () => {
    const s = new Series(4);
    for (let i = 1; i <= 6; i++) s.push(i * 100, i * 10);
    const seen: number[] = [];
    s.each(0, (_t, v) => seen.push(v));
    expect(seen).toEqual([30, 40, 50, 60]);
    expect(s.last()).toBe(60);
    expect(s.median(3)).toBe(50);
    expect(s.nearest(440, 50)).toBe(40);
    expect(s.nearest(1000, 50)).toBeNaN();
    expect(s.summary(450)).toEqual({ now: 60, avg: 55, min: 50, max: 60 });
    expect(new Series(4).summary(0)).toBeNull();
  });
});

describe("NetStats", () => {
  it("counts unanswered fast-path pings as lost, ignoring late answers", () => {
    const st = new NetStats();
    st.tick(0, 100, 0, 0);
    for (let i = 0; i < 10; i++) st.pingSent(i, i * 250);
    for (let i = 0; i < 8; i++) st.pong(i, 40, i * 250 + 40);
    st.tick(5000, 100, 0, 0);
    expect(st.loss).toBeCloseTo(0.2, 5);
    st.pong(9, 40, 5100); // kayıp sayıldıktan sonra gelen cevap
    st.tick(6100, 100, 0, 0);
    expect(st.loss).toBeCloseTo(0.2, 5);
  });

  it("smooths jitter from successive round trips", () => {
    const st = new NetStats();
    const rtts = [40, 60, 40, 60, 40, 60];
    rtts.forEach((r, i) => {
      st.pingSent(i, i * 100);
      st.pong(i, r, i * 100 + r);
    });
    // Her seferinde 20 ms fark: yumuşatılmış değer 20'ye doğru büyür, aşmaz
    expect(st.jitter).toBeGreaterThan(19);
    expect(st.jitter).toBeLessThanOrEqual(20);
    expect(st.udp.median(5)).toBe(60);
  });

  it("rolls up bytes, snapshots and stalls per second", () => {
    const st = new NetStats();
    st.tick(0, 100, 0, 0);
    st.received(1500, true);
    st.received(500, false);
    st.sent(480, true);
    for (let i = 0; i < 15; i++) st.snapshot();
    st.tick(1000, 100, 60, 3);
    expect(st.rateIn).toEqual({ udp: 1500, ws: 500 });
    expect(st.rateOut).toEqual({ udp: 480, ws: 0 });
    expect(st.bytesIn.last()).toBe(2000);
    expect(st.snapshots.last()).toBe(15);
    expect(st.starve.last()).toBeCloseTo(0.05, 5);
  });

  it("keeps the latest sample's worst age per bucket", () => {
    const st = new NetStats();
    st.need(120, 10);
    st.need(180, 200);
    st.need(90, NEED_BUCKET_MS + 10);
    expect(st.needMax.last()).toBe(180);
    expect(st.openBucket()).toEqual({ t: NEED_BUCKET_MS, v: 90 });
  });
});
