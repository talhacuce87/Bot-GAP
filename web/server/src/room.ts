// Oda başına oyuncu durumu ve 15 Hz snapshot yayını.
import {
  clampToJail,
  FLAG_DRIVING,
  FLAG_MASK,
  JAIL_SPAWN,
  maxSpeed,
  RELEASE_SPAWN,
  ROOM_MAX_PLAYERS,
  WORLD_RADIUS,
} from "../../shared/constants";
import {
  type ChatLine,
  type Look,
  type PlayerInfo,
  PETS,
  type PlayerState,
  type ServerEvent,
  SKINS,
  snapshotSize,
  writeSnapshotEntry,
  writeSnapshotHeader,
} from "../../shared/protocol";
import { clampElev, computeShot, DEFAULT_ELEV, FIRE_COOLDOWN_MS, TANK_PARK, TANK_REACH, TANK_RETURN_MS } from "../../shared/tank";
import type { SessionUser } from "./auth";
import { Battle } from "./battle";
import type { WorldGames } from "./games/world";

const PET_IDS = new Set<string>(PETS.map((p) => p.id));
const SKIN_IDS = new Set<string>(SKINS.map((s) => s.id));

/** Odanın tek tankı. Sürücü varken konumu sürücünün konumudur. */
interface Tank {
  driver: number;
  x: number;
  z: number;
  h: number;
  tr: number;
  /** Namlu açısı. */
  el: number;
  lastFire: number;
  /** Son inişin zamanı: uzun süre boş kalırsa park yerine döner. */
  idleSince: number;
}

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
  /** Son sohbet mesajları (yalnızca bellekte); yeni gelen geçmişi görür. */
  readonly chat: ChatLine[] = [];
  /** Bu odaya bağlı sinema (izleme odası); Activity'deki ve linkle gelenler aynı videoyu paylaşır. */
  watchId: string | null = null;
  readonly tank: Tank = { driver: 0, x: TANK_PARK.x, z: TANK_PARK.z, h: TANK_PARK.h, tr: TANK_PARK.h, el: DEFAULT_ELEV, lastFire: 0, idleSince: 0 };
  /** Tank savaşı odası ("b:..."): dünyanın tek tankı yerine takımlı maç. */
  readonly battle: Battle | null;
  /** Dünya odasının oyunları (savaş odasında yok); sunucu oda açılınca kurar. */
  games: WorldGames | null = null;
  /** Görev/sayaç olayı (botta): sunucu bağlar; tank isabeti, savaşta vuruş ve galibiyet buradan. */
  onReport: (sid: number, event: string, amount?: number) => void = () => {};
  private nextSid = 1;
  private dirty = false;

  constructor(readonly key: string) {
    this.battle = key.startsWith("b:") ? new Battle(this) : null;
  }

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
    if (this.battle) this.battle.join(sid);
    else this.sendTo(conn, this.tankEvent());
    this.games?.join(sid, conn);
    this.broadcast({ t: "join", player: info }, sid);
    this.dirty = true;
    return sid;
  }

  leave(sid: number): void {
    const p = this.players.get(sid);
    if (!p) return;
    if (this.tank.driver === sid) this.exitTank(sid);
    this.players.delete(sid);
    this.battle?.leave(sid);
    this.games?.leave(sid);
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
    if (this.battle && !this.battle.canMove(sid)) return;
    if (this.games?.frozen(sid)) {
      p.lastUpdate = now;
      return;
    }
    const dt = Math.min(1, Math.max(0, (now - p.lastUpdate) / 1000));
    // Araçtan inip binerken iki durumun hızlısı (bisikletten inen bir an daha hızlı gidebilir)
    const maxStep = Math.max(maxSpeed(s.flags), maxSpeed(p.state.flags)) * dt * 1.3 + 0.5;
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
    this.battle?.clamp(p.state);
    p.state.rot = s.rot;
    // Sürücü bayrağını yalnızca gerçekten süren taşır
    p.state.flags = s.flags & FLAG_MASK & (this.tank.driver === sid ? FLAG_MASK : ~FLAG_DRIVING);
    p.lastUpdate = now;
    this.dirty = true;
  }

  /** Odaya sohbet satırı: geçmişe eklenir ve herkese gider. */
  say(line: ChatLine, max = 30): void {
    this.chat.push(line);
    if (this.chat.length > max) this.chat.splice(0, this.chat.length - max);
    this.broadcast({ t: "chat", line });
  }

  /** Evcil hayvan ve tank kamuflajı (istemcide saklanır): geçerli değilse boş. */
  setCosmetics(sid: number, pet: unknown, skin: unknown): void {
    const p = this.players.get(sid);
    if (!p) return;
    p.info.pet = typeof pet === "string" && PET_IDS.has(pet) ? pet : null;
    p.info.skin = typeof skin === "string" && SKIN_IDS.has(skin) ? skin : null;
    this.broadcast({ t: "cosm", sid, pet: p.info.pet, skin: p.info.skin });
    this.battle?.refresh();
  }

  /** Bottan gelen (doğrulanmış) kıyafeti uygular ve odaya duyurur. Oyuncu ayrıldıysa bir şey yapmaz. */
  setLook(sid: number, look: Look): void {
    const p = this.players.get(sid);
    if (!p) return;
    p.info.look = look;
    this.broadcast({ t: "look", sid, look });
  }

  /**
   * Sürgün listesi değişince çağrılır: durumu değişen oyuncuyu zindana alır ya da çıkarır.
   * Konumu sunucu belirler ve herkese bildirir; istemci kendini oraya ışınlar.
   */
  updateJail(isExiled: (userId: string, guild: string | null) => boolean, now = Date.now()): void {
    for (const [sid, p] of this.players) {
      const jailed = p.forceJail || (!p.user.guest && isExiled(p.user.id, p.guild));
      if (jailed === p.info.jailed) continue;
      if (jailed && this.tank.driver === sid) this.exitTank(sid);
      p.info.jailed = jailed;
      Object.assign(p.state, jailed ? JAIL_SPAWN : RELEASE_SPAWN);
      p.state.flags = 0;
      p.lastUpdate = now;
      const { x, z, rot } = p.state;
      this.broadcast({ t: "jail", sid, jailed, x, z, rot });
      this.dirty = true;
    }
  }

  /** Sunucunun belirlediği yere koyar (savaşta doğma); sonraki hız kontrolü buradan başlar. */
  teleport(sid: number, x: number, z: number, rot: number, now = Date.now()): void {
    const p = this.players.get(sid);
    if (!p) return;
    Object.assign(p.state, { x, z, rot });
    p.lastUpdate = now;
    this.dirty = true;
  }

  private tankEvent(): ServerEvent {
    const { driver, x, z, h, tr, el } = this.tank;
    return { t: "tank", driver, x, z, h, tr, el };
  }

  /** Tanka binme: yakında, boşta, izleyici ya da sürgünde değilse. Başarılıysa true. */
  enterTank(sid: number): boolean {
    const p = this.players.get(sid);
    const t = this.tank;
    if (!p || p.info.spectator || p.info.jailed || t.driver) return false;
    if (Math.hypot(p.state.x - t.x, p.state.z - t.z) > TANK_REACH + 0.5) return false;
    t.driver = sid;
    // Sürücü tankın yerine geçer; sonraki konumları tankı taşır.
    p.state.x = t.x;
    p.state.z = t.z;
    this.broadcast(this.tankEvent());
    this.dirty = true;
    return true;
  }

  /** İniş (ya da sürücü ayrıldı/sürgüne gitti): tank son konumunda park eder. */
  exitTank(sid: number, now = Date.now()): void {
    const p = this.players.get(sid);
    const t = this.tank;
    if (t.driver !== sid) return;
    t.driver = 0;
    t.idleSince = now;
    if (p) {
      t.x = p.state.x;
      t.z = p.state.z;
      p.state.flags &= ~FLAG_DRIVING;
    }
    this.broadcast(this.tankEvent());
  }

  aimTank(sid: number, h: number, tr: number, el = DEFAULT_ELEV): void {
    if (this.tank.driver !== sid || !Number.isFinite(h) || !Number.isFinite(tr)) return;
    this.tank.h = h;
    this.tank.tr = tr;
    this.tank.el = clampElev(el);
    this.broadcast({ t: "taim", h, tr, el: this.tank.el }, sid);
  }

  /**
   * Sürücü ateş etti: atışı hesaplar ve herkese yollar (bekleme süresi dolmadıysa yok sayılır).
   * `aim`: atış anındaki gövde/kule açısı; son "taim" gecikmiş ya da düşmüş olabilir.
   */
  fire(sid: number, aim?: { h: number; tr: number; el?: number }, now = Date.now()): void {
    const t = this.tank;
    const p = this.players.get(sid);
    if (t.driver !== sid || !p || now - t.lastFire < FIRE_COOLDOWN_MS) return;
    t.lastFire = now;
    if (aim && Number.isFinite(aim.h) && Number.isFinite(aim.tr)) {
      t.h = aim.h;
      t.tr = aim.tr;
      if (aim.el !== undefined) t.el = clampElev(aim.el);
    }
    const targets = [...this.players]
      .filter(([s, q]) => s !== sid && !q.info.spectator)
      .map(([s, q]) => ({ sid: s, x: q.state.x, z: q.state.z }));
    const { shot, hits } = computeShot(p.state.x, p.state.z, t.tr, targets, t.el);
    this.broadcast({ t: "shell", sid, shot, hits });
    if (hits.length) this.onReport(sid, "tank_hit", hits.length);
  }

  /** Değişiklik varsa (ya da her saniye) tüm aktif oyuncuların konumunu yayınlar. */
  tick(now: number, force = false): void {
    this.battle?.tick(now);
    this.games?.tick(now);
    const t = this.tank;
    if (!t.driver && t.idleSince && now - t.idleSince > TANK_RETURN_MS) {
      Object.assign(t, { x: TANK_PARK.x, z: TANK_PARK.z, h: TANK_PARK.h, tr: TANK_PARK.h, el: DEFAULT_ELEV, idleSince: 0 });
      this.broadcast(this.tankEvent());
    }
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

  /** Her bağlantıyı oyuncunun sunucusuyla gezer (sunucu bazlı yayınlar için). */
  each(fn: (conn: Conn, guild: string | null) => void): void {
    for (const p of this.players.values()) fn(p.conn, p.guild);
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
  /** Yeni oda açılınca (sunucu oyunları ve raporlamayı bağlar). */
  onCreate: (room: Room) => void = () => {};

  get(key: string): Room {
    let r = this.rooms.get(key);
    if (!r) {
      r = new Room(key);
      this.rooms.set(key, r);
      this.onCreate(r);
    }
    return r;
  }

  find(key: string): Room | undefined {
    return this.rooms.get(key);
  }

  release(room: Room): void {
    if (room.size === 0) this.rooms.delete(room.key);
  }

  all(): Iterable<Room> {
    return this.rooms.values();
  }
}
