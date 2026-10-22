// Hızlı yol: sunucunun (node-datachannel) ve istemcinin (RTCPeerConnection; burada node-datachannel'ın
// tarayıcı uyumlu karşılığı) bağlantıları gerçek UDP üzerinden, tek portta, genel IP duyurusuyla konuşur.
import { afterAll, describe, expect, it } from "vitest";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { cleanup } from "node-datachannel";
import { type ClientEvent, MSG_PONG, PING_BYTES, type ServerEvent, writePing } from "../shared/protocol";
import { announce, setupRtc } from "../server/src/rtc";
import { FastLink as ClientLink } from "../client/src/rtc";

(globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = RTCPeerConnection;
afterAll(() => cleanup());

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("announce", () => {
  it("swaps the container address for the public one in candidates and SDP", () => {
    expect(announce("a=candidate:1 1 UDP 2114977791 172.18.0.5 40000 typ host", "203.0.113.7")).toBe(
      "a=candidate:1 1 UDP 2114977791 203.0.113.7 40000 typ host",
    );
    expect(announce("v=0\r\nc=IN IP4 172.18.0.5\r\n", "203.0.113.7")).toBe("v=0\r\nc=IN IP4 203.0.113.7\r\n");
  });
});

describe("fast path", () => {
  it("carries state up and snapshots down over UDP, several clients on one port", async () => {
    const rtc = await setupRtc(41000 + Math.floor(Math.random() * 1000), "127.0.0.1");
    expect(rtc).not.toBeNull();
    const clients = [0, 1, 2].map((i) => {
      const got = { up: [] as number[], down: [] as number[] };
      let client: ClientLink;
      // WebSocket yerine doğrudan: sunucu olayı istemciye, istemci olayı sunucuya
      const server = rtc!.link(
        (ev: ServerEvent) => {
          if (ev.t === "rtc") void client.answer(ev.sdp);
          else if (ev.t === "rtcice") client.candidate(ev.c, ev.mid);
        },
        (buf) => got.up.push(buf[0]),
      );
      client = new ClientLink(
        (ev: ClientEvent) => ev.t === "rtc" && server.offer(ev.sdp),
        (data) => got.down.push(new Uint8Array(data)[0]),
      );
      return { i, server, client, got };
    });
    await until(() => clients.every((c) => c.client.open && c.server.open));
    for (const c of clients) {
      expect(c.client.send(new Uint8Array([10 + c.i]).buffer)).toBe(true);
      expect(c.server.send(new Uint8Array([20 + c.i]))).toBe(true);
    }
    await until(() => clients.every((c) => c.got.up.length && c.got.down.length));
    for (const c of clients) {
      expect(c.got.up).toEqual([10 + c.i]);
      expect(c.got.down).toEqual([20 + c.i]);
    }
    // Hızlı yolun ping'i sunucunun bağlantısında cevaplanır (oyun koduna uğramaz)
    const pinger = clients[0];
    const ping = new DataView(new ArrayBuffer(PING_BYTES));
    writePing(ping, 7, 123.5);
    expect(pinger.client.send(ping.buffer)).toBe(true);
    await until(() => pinger.got.down.length > 1);
    expect(pinger.got.down.at(-1)).toBe(MSG_PONG);
    expect(pinger.got.up).toEqual([10]);
    for (const c of clients) {
      c.client.close();
      c.server.close();
    }
    // Kapandıktan sonra gönderim WebSocket'e düşer
    expect(clients[0].server.send(new Uint8Array([1]))).toBe(false);
    expect(clients[0].client.send(new Uint8Array([1]).buffer)).toBe(false);
  });

  it("stays off when no port is configured", async () => {
    expect(await setupRtc(0, "127.0.0.1")).toBeNull();
  });
});
