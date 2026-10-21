// Uçtan uca senkron: A çember çizerek yürür; konumu gerçek kodla (kodlayıcı, oda, snapshot, uzak oyuncu,
// çizim gecikmesi, saat senkronu) dalgalı/takılan sıralı hatlardan (TCP gibi) B ve C'ye gider.
// Herkesin saati farklı. İkisi de A'yı akıcı ve kendi çizim anındaki gerçek yerinde görmeli.
import { describe, expect, it } from "vitest";
import { FLAG_WALKING, SEND_HZ, TICK_HZ } from "../shared/constants";
import { decodeState, encodeState, type PlayerState, readSnapshot, STATE_BYTES } from "../shared/protocol";
import { type Conn, Room } from "../server/src/room";
import { Pacer, ServerClock } from "../client/src/clock";
import { InterpDelay } from "../client/src/jitter";
import { Remote } from "../client/src/avatars/remotes";

const T0 = 1_760_000_000_000;
const SPEED = 4.2;
const RADIUS = 8;

function rng(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

class Sim {
  now = 0;
  private q: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;

  at(at: number, fn: () => void): void {
    const e = { at, seq: this.seq++, fn };
    let lo = 0;
    let hi = this.q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.q[mid].at <= at) lo = mid + 1;
      else hi = mid;
    }
    this.q.splice(lo, 0, e);
  }

  run(until: number): void {
    while (this.q.length && this.q[0].at <= until) {
      const e = this.q.shift()!;
      this.now = e.at;
      e.fn();
    }
  }
}

/** Sıralı hat: gecikme + dalgalanma, ara sıra takılma; takılan paket arkasındakileri de bekletir. */
interface LineSpec {
  base: number;
  jitter: number;
  stallP?: number;
  stallMs?: number;
}

class Line {
  private last = 0;
  constructor(
    private sim: Sim,
    private rand: () => number,
    private spec: LineSpec,
  ) {}

  send(fn: () => void): void {
    const { base, jitter, stallP = 0, stallMs = 0 } = this.spec;
    const t = this.sim.now + base + this.rand() * jitter + (this.rand() < stallP ? stallMs : 0);
    this.last = Math.max(this.last, t);
    this.sim.at(this.last, fn);
  }
}

interface PeerSpec {
  fps: number;
  skew: number;
  up: LineSpec;
  down: LineSpec;
}

interface Scenario {
  seconds: number;
  walker: PeerSpec;
  observers: PeerSpec[];
}

interface Report {
  /** Gösterilen yerle A'nın o çizim anındaki gerçek yeri arasındaki fark (m). */
  errP99: number;
  errMax: number;
  /** Kare başına gösterilen hız / gerçek hız. */
  speedMin: number;
  speedP01: number;
  speedP99: number;
  speedMax: number;
  /** Donan kare oranı (hız gerçeğin %30'undan az). */
  frozen: number;
  delay: number;
}

const pct = (a: number[], q: number) => a[Math.min(a.length - 1, Math.floor(a.length * q))];

function simulate(sc: Scenario, seed = 7): Report[] {
  const sim = new Sim();
  const rand = rng(seed);
  const room = new Room("g:sim");
  const serverNow = () => T0 + sim.now;

  interface Peer {
    spec: PeerSpec;
    sid: number;
    up: Line;
    down: Line;
    clock: ServerClock;
    local: () => number;
  }
  const peers: Peer[] = [];
  const onSnapshot = new Map<Peer, (view: DataView) => void>();
  const addPeer = (spec: PeerSpec, name: string): Peer => {
    const p = { spec, sid: 0, up: new Line(sim, rand, spec.up), down: new Line(sim, rand, spec.down), clock: new ServerClock(), local: () => T0 + spec.skew + sim.now };
    const conn: Conn = {
      bufferedAmount: 0,
      send: (data) => {
        if (typeof data === "string") return;
        p.down.send(() => onSnapshot.get(p)?.(new DataView(data.buffer, data.byteOffset, data.byteLength)));
      },
    };
    p.sid = room.join({ id: name, name, avatar: null, guest: true }, conn, serverNow());
    // NTP benzeri ping, 2 sn'de bir (aynı sıralı hattan)
    const ping = () => {
      const sent = p.local();
      p.up.send(() => {
        const s = serverNow();
        p.down.send(() => p.clock.sample(sent, s, p.local()));
      });
      sim.at(sim.now + 2000, ping);
    };
    sim.at(rand() * 50, ping);
    peers.push(p);
    return p;
  };

  // A: çember üzerinde sabit hızla yürür; konumu Net.update'in yaptığı gibi gönderir
  const a = addPeer(sc.walker, "a");
  const spawn = { ...room.players.get(a.sid)!.state };
  const truth = (t: number) => {
    const ang = ((t / 1000) * SPEED) / RADIUS;
    return { x: spawn.x - RADIUS + RADIUS * Math.cos(ang), z: spawn.z + RADIUS * Math.sin(ang) };
  };
  const pacer = new Pacer(SEND_HZ);
  const buf = new ArrayBuffer(STATE_BYTES);
  const view = new DataView(buf);
  let lastA = 0;
  const frameA = () => {
    const dt = (sim.now - lastA) / 1000;
    lastA = sim.now;
    if (pacer.due(dt)) {
      const pos = truth(sim.now);
      encodeState(view, { ...pos, rot: 0, flags: FLAG_WALKING }, a.clock.synced ? a.clock.now(a.local()) : 0);
      const msg = new DataView(buf.slice(0));
      a.up.send(() => {
        const s: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
        const sentAt = decodeState(msg, s);
        if (sentAt >= 0) room.applyState(a.sid, s, serverNow(), sentAt);
      });
    }
    sim.at(sim.now + 1000 / sc.walker.fps + (rand() - 0.5) * 3, frameA);
  };
  sim.at(0, frameA);

  // Sunucu: setInterval gibi biraz oynayan yayın
  let ticks = 0;
  const tick = () => {
    room.tick(serverNow(), ++ticks % TICK_HZ === 0);
    sim.at(sim.now + 1000 / TICK_HZ + (rand() - 0.5) * 2, tick);
  };
  sim.at(0, tick);

  // Gözlemciler: Net.onMessage ve main.ts'teki döngünün yaptığı
  const warmup = 4000;
  const logs = sc.observers.map((spec, k) => {
    const o = addPeer(spec, `o${k}`);
    const interp = new InterpDelay();
    const remote = new Remote({ sid: a.sid, id: "a", name: "a", avatar: null, spectator: false, jailed: false }, 0);
    onSnapshot.set(o, (v) => {
      const arrival = o.clock.synced ? o.clock.now(o.local()) : NaN;
      readSnapshot(v, (sid, x, z, rot, flags, time) => {
        if (sid === a.sid) interp.feed(remote, arrival, o.local(), time, x, z, rot, flags);
      });
    });
    const log = { err: [] as number[], speed: [] as number[], delay: 0 };
    let last = 0;
    let prev: { x: number; z: number } | null = null;
    const frame = () => {
      const dt = (sim.now - last) / 1000;
      last = sim.now;
      const renderTime = o.clock.now(o.local()) - interp.update(dt);
      remote.sample(renderTime, dt);
      if (sim.now > warmup && remote.hasData) {
        const t = truth(renderTime - T0);
        log.err.push(Math.hypot(remote.x - t.x, remote.z - t.z));
        if (prev && dt > 0) log.speed.push(Math.hypot(remote.x - prev.x, remote.z - prev.z) / dt / SPEED);
      }
      prev = { x: remote.x, z: remote.z };
      log.delay = interp.delay;
      sim.at(sim.now + 1000 / spec.fps + (rand() - 0.5) * 2, frame);
    };
    sim.at(rand() * 16, frame);
    return log;
  });

  sim.run(sc.seconds * 1000);
  return logs.map((l) => {
    const err = [...l.err].sort((x, y) => x - y);
    const speed = [...l.speed].sort((x, y) => x - y);
    return {
      errP99: pct(err, 0.99),
      errMax: err[err.length - 1],
      speedMin: speed[0],
      speedP01: pct(speed, 0.01),
      speedP99: pct(speed, 0.99),
      speedMax: speed[speed.length - 1],
      frozen: speed.filter((s) => s < 0.3).length / speed.length,
      delay: l.delay,
    };
  });
}

// A: 60 fps, yükleme hattı dalgalı. B: 60 fps, iyi hat. C: 144 fps, kötü Wi-Fi.
const jittery: Scenario = {
  seconds: 30,
  walker: { fps: 60, skew: 41_234, up: { base: 35, jitter: 30 }, down: { base: 30, jitter: 15 } },
  observers: [
    { fps: 60, skew: -20_000, up: { base: 25, jitter: 10 }, down: { base: 25, jitter: 20 } },
    { fps: 144, skew: 7_777, up: { base: 50, jitter: 40 }, down: { base: 60, jitter: 80 } },
  ],
};

// Aynı hatlar, üstüne TCP takılmaları (kayıp paketin yeniden gönderilmesi): A'nın ve C'nin hattında
const stalling: Scenario = {
  ...jittery,
  walker: { ...jittery.walker, up: { base: 35, jitter: 30, stallP: 0.01, stallMs: 300 } },
  observers: [jittery.observers[0], { ...jittery.observers[1], down: { base: 60, jitter: 80, stallP: 0.03, stallMs: 250 } }],
};

describe("network sync (end to end)", () => {
  it("everyone sees a jittery walker smoothly and where they really were", () => {
    for (const seed of [1, 2, 3]) {
      const [b, c] = simulate(jittery, seed);
      for (const r of [b, c]) {
        // Hiç donma yok, ışınlanma yok: kare başına hız gerçeğe yakın
        expect(r.frozen).toBe(0);
        expect(r.speedMin).toBeGreaterThan(0.6);
        expect(r.speedMax).toBeLessThan(1.4);
        // Çizim anındaki gerçek yerinden birkaç cm
        expect(r.errP99).toBeLessThan(0.12);
        expect(r.errMax).toBeLessThan(0.2);
        expect(r.delay).toBeLessThan(400);
      }
      // İyi ve kötü hattaki iki kişi A'yı aynı sapmayla görür (fark yalnızca A'nın saat tahmininden)
      expect(Math.abs(b.errP99 - c.errP99)).toBeLessThan(0.02);
    }
  });

  it("rides out TCP stalls without teleports", () => {
    for (const seed of [1, 2, 3]) {
      for (const r of simulate(stalling, seed)) {
        expect(r.frozen).toBeLessThan(0.02);
        expect(r.speedP01).toBeGreaterThan(0.3);
        expect(r.speedP99).toBeLessThan(1.5);
        expect(r.speedMax).toBeLessThan(4);
        expect(r.errP99).toBeLessThan(0.4);
        expect(r.errMax).toBeLessThan(1);
      }
    }
  });
});
