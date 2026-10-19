// Oda başına oyuncu durumu ve 15 Hz snapshot yayını.
import {
  clampToJail,
  FLAG_SEATED,
  FLAG_WALKING,
  JAIL_SPAWN,
  RELEASE_SPAWN,
  ROOM_MAX_PLAYERS,
  WALK_SPEED,
  WORLD_RADIUS,
} from "../../shared/constants";
import {
  type PlayerInfo,
  type PlayerState,
  type ServerEvent,
  snapshotSize,
  writeSnapshotEntry,
  writeSnapshotHeader,
} from "../../shared/protocol";
import type { SessionUser } from "./auth";

export interface Conn {
  send(data: string | Uint8Array): void;
  /** Gönderilmeyi bekleyen bayt; yavaş istemcilere snapshot atlanır. */
  readonly bufferedAmount: number;
}

interface Player {
  info: PlayerInfo;
  user: SessionUser;
  /** Activity'nin açıldığı sunucu (sürgün sunucu bazında). */
  guild: string | null;
  /** Test için zorla zindana konmuş misafir (`?jail=1`). */
  forceJail: boolean;
  state: PlayerState;
  lastUpdate: number;
  joinedAt: number;
  conn: Conn;
}

const MAX_BUFFERED = 64 * 1024;
const SPAWN_RADIUS = 3;
const SPAWN_Z = 8;

export class Room {
  readonly players = new Map<number, Player>();
  private nextSid = 1;
  private dirty = false;

  constructor(readonly key: string) {}

  get size(): number {
    return this.players.size;
  }

  private activeCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.info.spectator) n++;
    return n;
  }

  join(user: SessionUser, conn: Conn, now = Date.now(), opts: JoinOptions = {}): number {
    // 60000 ve üstü istemcide yerel sahte oyunculara ayrılmış.
    while (this.players.has(this.nextSid)) this.nextSid = (this.nextSid % 59999) + 1;
    const sid = this.nextSid;
    this.nextSid = (this.nextSid % 59999) + 1;
    const info: PlayerInfo = {
      sid,
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      spectator: this.activeCount() >= ROOM_MAX_PLAYERS,
      jailed: !!opts.jailed,
    };
    const a = Math.random() * Math.PI * 2;
    const state: PlayerState = {
      x: Math.cos(a) * SPAWN_RADIUS * Math.random(),
      z: SPAWN_Z + Math.sin(a) * SPAWN_RADIUS * Math.random(),
      rot: Math.PI,
      flags: 0,
    };
    if (info.jailed) Object.assign(state, JAIL_SPAWN);
    const others = [...this.players.values()].map((p) => p.info);
    this.players.set(sid, {
      info,
      user,
      guild: opts.guild ?? null,
      forceJail: !!opts.forceJail,
      state,
      lastUpdate: now,
      joinedAt: now,
      conn,
    });
    this.sendTo(conn, { t: "welcome", you: sid, room: this.key, players: [info, ...others] });
    this.broadcast({ t: "join", player: info }, sid);
    this.dirty = true;
    return sid;
  }

  leave(sid: number): void {
    const p = this.players.get(sid);
    if (!p) return;
    this.players.delete(sid);
    this.broadcast({ t: "leave", sid });
    // Boşalan yere en eski izleyici geçer; istemciler onu yeni katılan gibi görür.
    if (!p.info.spectator) {
      for (const q of this.players.values()) {
        if (!q.info.spectator) continue;
        q.info.spectator = false;
        q.lastUpdate = Date.now();
        this.broadcast({ t: "join", player: q.info });
        break;
      }
    }
    this.dirty = true;
  }

  /** İstemcinin bildirdiği konumu sınırlar ve hız kontrolünden geçirerek uygular. */
  applyState(sid: number, s: PlayerState, now = Date.now()): void {
    const p = this.players.get(sid);
    if (!p || p.info.spectator) return;
    const dt = Math.min(1, Math.max(0, (now - p.lastUpdate) / 1000));
    const maxStep = WALK_SPEED * dt * 1.5 + 0.5;
    let dx = s.x - p.state.x;
    let dz = s.z - p.state.z;
    const d = Math.hypot(dx, dz);
    if (d > maxStep) {
      dx *= maxStep / d;
      dz *= maxStep / d;
    }
    let x = p.state.x + dx;
    let z = p.state.z + dz;
    const r = Math.hypot(x, z);
    const limit = WORLD_RADIUS + 1;
    if (r > limit) {
      x *= limit / r;
      z *= limit / r;
    }
    p.state.x = x;
    p.state.z = z;
    if (p.info.jailed) clampToJail(p.state);
    p.state.rot = s.rot;
    p.state.flags = s.flags & (FLAG_WALKING | FLAG_SEATED);
    p.lastUpdate = now;
    this.dirty = true;
  }

  /**
   * Sürgün listesi değişince çağrılır: durumu değişen oyuncuyu zindana alır ya da çıkarır.
   * Konumu sunucu belirler ve herkese bildirir; istemci kendini oraya ışınlar.
   */
  updateJail(isExiled: (userId: string, guild: string | null) => boolean, now = Date.now()): void {
    for (const [sid, p] of this.players) {
      const jailed = p.forceJail || (!p.user.guest && isExiled(p.user.id, p.guild));
      if (jailed === p.info.jailed) continue;
      p.info.jailed = jailed;
      Object.assign(p.state, jailed ? JAIL_SPAWN : RELEASE_SPAWN);
      p.state.flags = 0;
      p.lastUpdate = now;
      const { x, z, rot } = p.state;
      this.broadcast({ t: "jail", sid, jailed, x, z, rot });
      this.dirty = true;
    }
  }

  /** Değişiklik varsa (ya da her saniye) tüm aktif oyuncuların konumunu yayınlar. */
  tick(now: number, force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;
    let count = 0;
    for (const p of this.players.values()) if (!p.info.spectator) count++;
    const buf = new Uint8Array(snapshotSize(count));
    const view = new DataView(buf.buffer);
    writeSnapshotHeader(view, now, count);
    let i = 0;
    for (const [sid, p] of this.players) {
      if (!p.info.spectator) writeSnapshotEntry(view, i++, sid, p.state);
    }
    for (const p of this.players.values()) {
      if (p.conn.bufferedAmount < MAX_BUFFERED) p.conn.send(buf);
    }
  }

  sendTo(conn: Conn, ev: ServerEvent): void {
    conn.send(JSON.stringify(ev));
  }

  broadcast(ev: ServerEvent, exceptSid?: number): void {
    const msg = JSON.stringify(ev);
    for (const [sid, p] of this.players) if (sid !== exceptSid) p.conn.send(msg);
  }

  summary() {
    return {
      room: this.key,
      players: [...this.players.values()].map((p) => ({
        id: p.info.id,
        name: p.info.name,
        spectator: p.info.spectator,
        jailed: p.info.jailed,
        since: p.joinedAt,
      })),
    };
  }
}

export interface JoinOptions {
  guild?: string | null;
  jailed?: boolean;
  forceJail?: boolean;
}

export class Rooms {
  private rooms = new Map<string, Room>();

  get(key: string): Room {
    let r = this.rooms.get(key);
    if (!r) {
      r = new Room(key);
      this.rooms.set(key, r);
    }
    return r;
  }

  release(room: Room): void {
    if (room.size === 0) this.rooms.delete(room.key);
  }

  all(): Iterable<Room> {
    return this.rooms.values();
  }
}
