// Dünya odasının oyunları ve sosyal etkileşimleri tek yerde: kahvehane masaları, futbol, ebelemece/saklambaç,
// sahne/DJ, ikili etkileşimler (beşlik, sarılma), havai fişek, görev olayları.
import type { ServerEvent, TagMode, Weather } from "../../../shared/protocol";
import { SAKURA_SPOT } from "../../../shared/zones";
import type { Conn, Room } from "../room";
import type { Builds } from "./build";
import { Football } from "./football";
import { Race } from "./race";
import { Sky } from "./sky";
import { Stage, type StageHost } from "./stage";
import { Tables } from "./tables";
import { Tag } from "./tag";

/** Görev/sayaç olayı (botta): oyuncu, olay, miktar. */
export type Report = (sid: number, event: string, amount?: number) => void;

const PAIR_R = 3;
const PAIR_TTL_MS = 10_000;
const PAIR_COOLDOWN_MS = 4000;
const FIREWORKS_COOLDOWN_MS = 60_000;
const RIDE_MIN_MS = 4000;

export class WorldGames {
  readonly tables: Tables;
  readonly football: Football;
  readonly tag: Tag;
  readonly stage: Stage;
  readonly sky: Sky;
  readonly race: Race;
  /** Mahalle (bot bağlıysa kalıcı). */
  builds: Builds | null = null;
  /** Hedef → bekleyen istek. */
  private pairs = new Map<number, { from: number; kind: "five" | "hug"; at: number }>();
  private lastPair = new Map<number, number>();
  private lastRide = new Map<number, number>();
  private lastFireworks = 0;
  /** Bu bağlantıda Sakura Bahçesi'ne girenler (görev bir kez). */
  private sakura = new Set<number>();
  private lastScan = 0;

  constructor(
    private room: Room,
    private report: Report,
    host: StageHost,
    /** İstanbul'un anlık havası (sabit hava yokken geçerli olan). */
    liveWeather: () => Weather = () => ({ kind: "clear", intensity: 0, cloud: 0.15, temp: null }),
  ) {
    const r = (sid: number, event: string) => report(sid, event);
    this.tables = new Tables(room, r);
    this.football = new Football(room, r);
    this.tag = new Tag(room, r);
    this.stage = new Stage(room, host, r);
    this.sky = new Sky(room, liveWeather);
    this.race = new Race(room, r);
  }

  join(sid: number, conn: Conn): void {
    this.tables.sendAll(conn, sid);
    this.football.sendTo(conn);
    this.tag.sendTo(conn);
    this.stage.sendTo(conn);
    this.sky.sendTo(conn);
    this.race.sendTo(conn);
    this.builds?.sendTo(conn);
  }

  leave(sid: number): void {
    this.tables.leave(sid);
    this.football.leave(sid);
    this.tag.leave(sid);
    this.stage.leave(sid);
    this.sky.leave(sid);
    this.race.leave(sid);
    this.pairs.delete(sid);
    for (const [to, req] of this.pairs) if (req.from === sid) this.pairs.delete(to);
    this.sakura.delete(sid);
    this.lastPair.delete(sid);
    this.lastRide.delete(sid);
  }

  tick(now: number): void {
    this.tables.tick(now);
    this.football.tick(now);
    this.tag.tick(now);
    this.sky.tick(now);
    this.race.tick(now);
    if (now - this.lastScan > 1000) {
      this.lastScan = now;
      for (const [sid, p] of this.room.players) {
        if (this.sakura.has(sid) || p.info.spectator) continue;
        if (Math.hypot(p.state.x - SAKURA_SPOT.x, p.state.z - SAKURA_SPOT.z) < SAKURA_SPOT.r) {
          this.sakura.add(sid);
          this.report(sid, "sakura");
        }
      }
    }
  }

  /** Saklambaçta gözü kapalı ebe yürüyemez. */
  frozen(sid: number): boolean {
    return this.tag.frozen(sid);
  }

  /** Havai fişek (komut ya da özel gün): herkes aynı tohumla aynı gösteriyi görür. */
  fireworks(now: number, count: number, force = false): boolean {
    if (!force && now - this.lastFireworks < FIREWORKS_COOLDOWN_MS) return false;
    this.lastFireworks = now;
    this.room.broadcast({ t: "fireworks", seed: Math.floor(Math.random() * 1e9), at: now + 600, count });
    return true;
  }

  openTag(sid: number, mode: TagMode): string | null {
    return this.tag.open(sid, mode);
  }

  private send(sid: number, ev: ServerEvent): void {
    const conn = this.room.players.get(sid)?.conn;
    if (conn) this.room.sendTo(conn, ev);
  }

  private pair(sid: number, kind: unknown, to: unknown, now: number): void {
    if ((kind !== "five" && kind !== "hug") || typeof to !== "number" || to === sid) return;
    const a = this.room.players.get(sid), b = this.room.players.get(to);
    if (!a || !b || a.info.spectator || b.info.spectator) return;
    if (now - (this.lastPair.get(sid) ?? 0) < PAIR_COOLDOWN_MS) return;
    if (Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z) > PAIR_R) return this.send(sid, { t: "notice", text: "🤝 Biraz daha yaklaş." });
    this.lastPair.set(sid, now);
    this.pairs.set(to, { from: sid, kind, at: now });
    this.send(to, { t: "pairreq", from: sid, name: a.info.name, kind });
  }

  private pairOk(sid: number, from: unknown, now: number): void {
    const req = this.pairs.get(sid);
    if (!req || req.from !== from || now - req.at > PAIR_TTL_MS) return;
    this.pairs.delete(sid);
    const a = this.room.players.get(req.from), b = this.room.players.get(sid);
    if (!a || !b || Math.hypot(a.state.x - b.state.x, a.state.z - b.state.z) > PAIR_R + 1) return;
    this.room.broadcast({ t: "pair", a: req.from, b: sid, kind: req.kind });
    this.report(req.from, req.kind);
    this.report(sid, req.kind);
  }

  /** Dünya oyun mesajları (true: işlendi). */
  handle(sid: number, msg: Record<string, unknown>, now = Date.now()): boolean {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
    switch (msg.t) {
      case "tsit":
        if (!this.tables.sit(sid, num(msg.id), num(msg.seat))) this.send(sid, { t: "notice", text: "🪑 Bu sandalye dolu ya da uzaktasın." });
        return true;
      case "tleave":
        this.tables.leave(sid);
        return true;
      case "tstart":
        this.tables.start(sid, num(msg.id));
        return true;
      case "tmove":
        if (msg.move && typeof msg.move === "object") this.tables.move(sid, num(msg.id), msg.move as never);
        return true;
      case "tresign":
        this.tables.resign(sid, num(msg.id));
        return true;
      case "bclaim":
        this.builds?.claim(sid);
        return true;
      case "bset":
        this.builds?.set(sid, num(msg.i), num(msg.j), num(msg.k), num(msg.b), num(msg.r), now);
        return true;
      case "bfree":
        this.builds?.free(sid);
        return true;
      case "tackle":
        this.football.tackle(sid, now);
        return true;
      case "kick":
        this.football.kick(sid, num(msg.dir), num(msg.power), now, (msg.kind ?? "shot") as never, num(msg.curve ?? 0));
        return true;
      case "tagjoin":
        this.tag.join(sid);
        return true;
      case "rjoin":
        this.race.join(sid);
        return true;
      case "rleave":
        this.race.leave(sid, now);
        return true;
      case "rtrack":
        this.race.setTrack(sid, num(msg.i));
        return true;
      case "rstart":
        this.race.start(sid, now);
        return true;
      case "rcar":
        this.race.car(sid, num(msg.x), num(msg.z), num(msg.a), num(msg.f) | 0, now);
        return true;
      case "pair":
        this.pair(sid, msg.kind, msg.to, now);
        return true;
      case "pairok":
        this.pairOk(sid, msg.from, now);
        return true;
      case "fireworks":
        if (!this.fireworks(now, 12)) this.send(sid, { t: "notice", text: "🎆 Biraz bekle, gökyüzü daha yeni aydınlandı." });
        return true;
      case "dj":
        this.stage.djCommand(sid, String(msg.op), typeof msg.show === "number" ? msg.show : undefined);
        return true;
      case "stage":
        this.stage.setSinger(sid, msg.on === true);
        return true;
      case "wended":
        this.stage.ended(now);
        return true;
      case "ride": {
        const m = num(msg.m);
        if (!(m > 0) || now - (this.lastRide.get(sid) ?? 0) < RIDE_MIN_MS) return true;
        this.lastRide.set(sid, now);
        // Saniyede en fazla ~12 m: sahte büyük sayılar görevi bitirmesin
        this.report(sid, "ride", Math.min(Math.round(m), 120));
        return true;
      }
      default:
        return false;
    }
  }
}
