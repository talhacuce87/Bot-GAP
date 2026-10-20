// Tank savaşı: takımlar, can, isabet, yeniden doğma, skor ve süreli maç. Odası "b:" ile başlayanlarda çalışır.
// Konumlar oyuncuların kendi snapshot'ıdır (Room.applyState); burada yalnızca maç kuralları var.
import {
  ARENA_RADIUS,
  ARENA_WALL_H,
  COUNTDOWN_MS,
  COVER,
  END_MS,
  MATCH_MS,
  type Phase,
  RESPAWN_MS,
  spawnPoint,
  SPLASH_DAMAGE_R,
  TANK_HIT_R,
  TANK_HIT_TOP,
  TANK_HP,
  type Team,
} from "../../shared/arena";
import type { BattleState, Fighter } from "../../shared/protocol";
import { clampElev, computeShot, DEFAULT_ELEV, FIRE_COOLDOWN_MS } from "../../shared/tank";
import type { Room } from "./room";

interface Tank extends Fighter {
  lastFire: number;
  respawnAt: number;
  h: number;
  tr: number;
  el: number;
}

/** Mermi uçarken bekleyen hasar: patlama anında işlenir. */
interface Pending {
  at: number;
  killer: number;
  victim: number;
}

const finite = (...v: unknown[]) => v.every((x) => typeof x === "number" && Number.isFinite(x));

export class Battle {
  readonly tanks = new Map<number, Tank>();
  phase: Phase = "wait";
  endsAt = 0;
  score: [number, number] = [0, 0];
  private pending: Pending[] = [];

  constructor(private room: Room) {}

  state(): BattleState {
    const fighters = [...this.tanks.values()].map(({ sid, team, hp, alive, kills, deaths }) => ({ sid, team, hp, alive, kills, deaths }));
    return { phase: this.phase, endsAt: this.endsAt, score: [...this.score], fighters };
  }

  private publish(): void {
    this.room.broadcast({ t: "battle", ...this.state() });
  }

  private count(team: Team, except = 0): number {
    let n = 0;
    for (const t of this.tanks.values()) if (t.team === team && t.sid !== except) n++;
    return n;
  }

  join(sid: number): void {
    this.tanks.set(sid, { sid, team: -1, hp: TANK_HP, alive: false, kills: 0, deaths: 0, lastFire: -Infinity, respawnAt: 0, h: 0, tr: 0, el: DEFAULT_ELEV });
    // Yeni gelen diğer tankların açılarını bilsin
    const conn = this.room.players.get(sid)?.conn;
    if (conn) for (const t of this.tanks.values()) if (t.team >= 0) this.room.sendTo(conn, { t: "baim", sid: t.sid, h: t.h, tr: t.tr, el: t.el });
    this.publish();
  }

  leave(sid: number): void {
    this.tanks.delete(sid);
    this.pending = this.pending.filter((p) => p.victim !== sid);
    this.publish();
  }

  /** Ölüyken ya da takımsızken konum güncellemesi kabul edilmez (enkaz yerinde kalır). */
  canMove(sid: number): boolean {
    return !!this.tanks.get(sid)?.alive;
  }

  clamp(p: { x: number; z: number }): void {
    const r = Math.hypot(p.x, p.z);
    if (r > ARENA_RADIUS) {
      p.x *= ARENA_RADIUS / r;
      p.z *= ARENA_RADIUS / r;
    }
  }

  /** Takım seçimi: bir takım diğerinden en fazla 1 kişi fazla olabilir. Başarılıysa true. */
  pickTeam(sid: number, team: Team, now = Date.now()): boolean {
    const t = this.tanks.get(sid);
    if (!t || (team !== 0 && team !== 1) || t.team === team) return false;
    if (this.count(team, sid) + 1 - this.count((1 - team) as Team, sid) > 1) return false;
    t.team = team;
    this.spawn(t, now);
    this.publish();
    return true;
  }

  private spawn(t: Tank, now: number): void {
    const team = t.team as Team;
    const mates = [...this.tanks.values()].filter((o) => o.team === team).map((o) => o.sid).sort((a, b) => a - b);
    const s = spawnPoint(team, mates.indexOf(t.sid));
    Object.assign(t, { hp: TANK_HP, alive: true, respawnAt: 0, h: s.h, tr: s.h, el: DEFAULT_ELEV });
    this.room.teleport(t.sid, s.x, s.z, s.h, now);
    this.room.broadcast({ t: "spawn", sid: t.sid, x: s.x, z: s.z, h: s.h });
  }

  aim(sid: number, h: unknown, tr: unknown, el: unknown): void {
    const t = this.tanks.get(sid);
    if (!t?.alive || !finite(h, tr, el)) return;
    t.h = h as number;
    t.tr = tr as number;
    t.el = clampElev(el as number);
    this.room.broadcast({ t: "baim", sid, h: t.h, tr: t.tr, el: t.el }, sid);
  }

  /** Atış: mermi siperde, duvarda, düşman tankında ya da yerde patlar; dost tank da mermiyi durdurur. */
  fire(sid: number, aim: { h?: unknown; tr?: unknown; el?: unknown } = {}, now = Date.now()): void {
    const t = this.tanks.get(sid);
    const p = this.room.players.get(sid);
    if (!t?.alive || !p || this.phase === "count" || this.phase === "end" || now - t.lastFire < FIRE_COOLDOWN_MS) return;
    t.lastFire = now;
    if (finite(aim.h, aim.tr, aim.el)) {
      t.h = aim.h as number;
      t.tr = aim.tr as number;
      t.el = clampElev(aim.el as number);
    }
    const enemies: { sid: number; x: number; z: number; r: number; top: number }[] = [];
    const blockers = [...COVER];
    for (const o of this.tanks.values()) {
      const q = this.room.players.get(o.sid);
      if (!o.alive || o.sid === sid || !q) continue;
      if (o.team === t.team) blockers.push({ x: q.state.x, z: q.state.z, r: TANK_HIT_R, h: TANK_HIT_TOP, kind: "wall" });
      else enemies.push({ sid: o.sid, x: q.state.x, z: q.state.z, r: TANK_HIT_R, top: TANK_HIT_TOP });
    }
    const { shot, direct, end } = computeShot(p.state.x, p.state.z, t.tr, enemies, t.el, blockers, { r: ARENA_RADIUS + 0.6, h: ARENA_WALL_H });
    this.room.broadcast({ t: "shell", sid, shot, hits: [] });
    const at = now + shot.flight * 1000;
    for (const e of enemies) {
      if (e.sid === direct || Math.hypot(e.x - end.x, e.z - end.z) < SPLASH_DAMAGE_R) this.pending.push({ at, killer: sid, victim: e.sid });
    }
  }

  private startMatch(now: number): void {
    this.phase = "play";
    this.endsAt = now + MATCH_MS;
    this.score = [0, 0];
    this.pending = [];
    for (const t of this.tanks.values()) {
      t.kills = t.deaths = 0;
      if (t.team >= 0) this.spawn(t, now);
    }
  }

  tick(now: number): void {
    let changed = false;
    // Patlaması gelen hasarlar
    if (this.pending.length) {
      const due = this.pending.filter((p) => p.at <= now);
      this.pending = this.pending.filter((p) => p.at > now);
      for (const d of due) {
        const v = this.tanks.get(d.victim);
        if (!v?.alive) continue;
        v.hp--;
        changed = true;
        if (v.hp > 0) continue;
        v.alive = false;
        v.deaths++;
        v.respawnAt = now + RESPAWN_MS;
        const k = this.tanks.get(d.killer);
        if (k) {
          k.kills++;
          if (this.phase === "play" && k.team >= 0) this.score[k.team as Team]++;
        }
        this.room.broadcast({ t: "kill", killer: d.killer, victim: d.victim });
      }
    }
    for (const t of this.tanks.values()) {
      if (!t.alive && t.team >= 0 && t.respawnAt && now >= t.respawnAt) {
        this.spawn(t, now);
        changed = true;
      }
    }
    // Evreler: bekleme → geri sayım → maç → sonuç → (yeniden geri sayım)
    const both = this.count(0) > 0 && this.count(1) > 0;
    const set = (phase: Phase, ms: number) => {
      this.phase = phase;
      this.endsAt = ms ? now + ms : 0;
      changed = true;
    };
    if (this.phase === "wait" && both) set("count", COUNTDOWN_MS);
    else if (this.phase === "count" && !both) set("wait", 0);
    else if (this.phase === "count" && now >= this.endsAt) {
      this.startMatch(now);
      changed = true;
    } else if (this.phase === "play" && (!both || now >= this.endsAt)) set("end", END_MS);
    else if (this.phase === "end" && now >= this.endsAt) set(both ? "count" : "wait", both ? COUNTDOWN_MS : 0);
    if (changed) this.publish();
  }

  /** Savaşa ait mesajları işler (true: işlendi). Dünyanın tankı savaş odasında yoktur. */
  handle(sid: number, msg: Record<string, unknown>, now = Date.now()): boolean {
    switch (msg.t) {
      case "team":
        if (this.tanks.get(sid)?.team !== msg.team && !this.pickTeam(sid, msg.team as Team, now)) {
          const conn = this.room.players.get(sid)?.conn;
          if (conn) this.room.sendTo(conn, { t: "notice", text: "Bu takım şu an dolu: takımlar en fazla 1 kişi farkla dengelenir." });
        }
        return true;
      case "taim":
        this.aim(sid, msg.h, msg.tr, msg.el);
        return true;
      case "fire":
        this.fire(sid, msg, now);
        return true;
      case "tank":
        return true;
      default:
        return false;
    }
  }
}
