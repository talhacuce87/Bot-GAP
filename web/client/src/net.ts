// WebSocket istemcisi: 15 Hz konum gönderimi, snapshot alımı, saat senkronu ve yeniden bağlanma.
import { SEND_HZ } from "../../shared/constants";
import { encodeState, type PlayerState, readSnapshot, type ServerEvent, STATE_BYTES } from "../../shared/protocol";
import type { Remotes } from "./avatars/remotes";

export type NetStatus = "connecting" | "online" | "offline" | "denied";

const KEEPALIVE_MS = 1000;
const PING_MS = 2000;

export class Net {
  status: NetStatus = "connecting";
  /** Sunucu saati − yerel saat (ms). */
  offset = 0;
  rtt = 0;
  you = -1;
  onStatus: (s: NetStatus) => void = () => {};

  private ws: WebSocket | null = null;
  private sendBuf = new ArrayBuffer(STATE_BYTES);
  private sendView = new DataView(this.sendBuf);
  private sendAcc = 0;
  private lastSent = { x: NaN, z: NaN, rot: NaN, flags: -1 };
  private lastSentAt = 0;
  private pingTimer = 0;
  private retry = 0;
  private rttSamples: { rtt: number; offset: number }[] = [];
  private readonly onEntry: (sid: number, x: number, z: number, rot: number, flags: number, time: number) => void;

  constructor(
    private url: string,
    private remotes: Remotes,
  ) {
    // Snapshot okuyucusu için sabit fonksiyon: mesaj başına closure oluşturulmaz.
    this.onEntry = (sid, x, z, rot, flags, time) => {
      if (sid === this.you) return;
      this.remotes.map.get(sid)?.push(time, x, z, rot, flags);
    };
    this.connect();
  }

  /** Yerel saate göre tahmini sunucu zamanı. */
  serverNow(): number {
    return performance.timeOrigin + performance.now() + this.offset;
  }

  private setStatus(s: NetStatus): void {
    this.status = s;
    this.onStatus(s);
  }

  private connect(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = (e) => {
      window.clearInterval(this.pingTimer);
      this.ws = null;
      this.you = -1;
      // Upgrade reddi tarayıcıda 1006 olarak görünür; hiç açılmadan kapanırsa yine dene ama yavaşla.
      if (e.code === 4001) {
        this.setStatus("denied");
        return;
      }
      this.setStatus("offline");
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      window.setTimeout(() => this.connect(), delay);
    };
  }

  private ping(): void {
    this.ws?.send(JSON.stringify({ t: "ping", c: performance.timeOrigin + performance.now() }));
  }

  private onMessage(data: ArrayBuffer | string): void {
    if (typeof data !== "string") {
      readSnapshot(new DataView(data), this.onEntry);
      return;
    }
    const ev = JSON.parse(data) as ServerEvent;
    switch (ev.t) {
      case "welcome":
        this.you = ev.you;
        this.remotes.clear();
        for (const p of ev.players) if (p.sid !== ev.you) this.remotes.add(p);
        this.lastSent.flags = -1; // hemen tam durum gönder
        this.setStatus("online");
        break;
      case "join":
        if (ev.player.sid !== this.you) this.remotes.add(ev.player);
        break;
      case "leave":
        this.remotes.leave(ev.sid);
        break;
      case "pong": {
        // NTP benzeri: en düşük RTT'li örneğin ofseti en güvenilirdir.
        const now = performance.timeOrigin + performance.now();
        const rtt = now - ev.c;
        this.rttSamples.push({ rtt, offset: ev.s - (ev.c + rtt / 2) });
        if (this.rttSamples.length > 6) this.rttSamples.shift();
        let best = this.rttSamples[0];
        for (const s of this.rttSamples) if (s.rtt < best.rtt) best = s;
        this.offset = best.offset;
        this.rtt = rtt;
        break;
      }
    }
  }

  /** Her kare çağrılır; durum değiştiyse SEND_HZ'de, değişmediyse saniyede bir gönderir. */
  update(dt: number, s: PlayerState): void {
    this.sendAcc += dt;
    if (this.sendAcc < 1 / SEND_HZ) return;
    this.sendAcc = 0;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.you < 0) return;
    const l = this.lastSent;
    const now = performance.now();
    const same = Math.abs(l.x - s.x) < 0.005 && Math.abs(l.z - s.z) < 0.005 && Math.abs(l.rot - s.rot) < 0.005 && l.flags === s.flags;
    if (same && now - this.lastSentAt < KEEPALIVE_MS) return;
    encodeState(this.sendView, s);
    ws.send(this.sendBuf);
    l.x = s.x;
    l.z = s.z;
    l.rot = s.rot;
    l.flags = s.flags;
    this.lastSentAt = now;
  }
}
