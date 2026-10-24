// GAP Paintball: kulübede sıraya girilir, ilk iki kişi 1v1 süreli deathmatch oynar (sıradakiler sonra).
// Maç başlarken iki oyuncu kendi üssüne ışınlanır; geri sayımda ve vurulunca yerinden kıpırdamaz.
// Toplar sunucuda uçar (shared/paintball.ts balistiği): engele, yere, ağa çarpan durur; rakibe değen onu vurur.
// Gecikme telafisi: atanın gördüğü an (`at`) kadar geriye gidilip rakibin o anki yerine bakılır (en çok
// PB.maxRewindMs). Süre bitince en çok vuran kazanır; galibiyet skin açar (bot sayar: "pb_win").
import { ballAt, ballBlocked, BALL, GUN_SKINS, hitsPlayer, PB, PB_AREA, PB_EXIT, PB_INNER, type Shot, spawnSpots } from "../../../shared/paintball";
import type { PbPlayer, PbState } from "../../../shared/protocol";
import type { Conn, Room } from "../room";

const STEP = 1 / 240;
const HISTORY_MS = 1000;

interface Ball {
  sid: number;
  shot: Shot;
  /** Sunucunun kabul ettiği an ve atanın ekranının ne kadar geride olduğu (ms). */
  at: number;
  rewind: number;
  /** Uçuşun hesaplandığı süre (sn). */
  t: number;
}

interface Gun {
  ammo: number;
  lastFire: number;
  reloadUntil: number;
}

const finite = (...v: unknown[]) => v.every((x) => typeof x === "number" && Number.isFinite(x));
const vec3 = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && finite(...v);

export class Paintball {
  state: PbState = { phase: "idle", players: [], queue: [], startAt: 0, endsAt: 0 };
  /** Botun saydığı galibiyetler (üye id → sayı); ilk sorulduğunda yüklenir, kazanınca burada da artar. */
  private wins = new Map<string, number>();
  private asked = new Set<string>();
  /** Bottan galibiyet sayısı (index.ts bağlar); yoksa herkes 0 (yalnızca açık skinler). */
  winsOf: ((sid: number) => Promise<number | null>) | null = null;
  private skins = new Map<number, string>();
  private poses = new Map<number, { p: number; c: number; y: number }>();
  private guns = new Map<number, Gun>();
  private balls: Ball[] = [];
  private hist = new Map<number, { t: number; x: number; z: number }[]>();
  private posesDirty = false;

  constructor(
    private room: Room,
    private report: (sid: number, event: string) => void,
    private clock: () => number = () => Date.now(),
  ) {}

  private publish(): void {
    this.room.broadcast({ t: "pb", state: this.state });
  }

  sendTo(conn: Conn): void {
    this.room.sendTo(conn, { t: "pb", state: this.state });
  }

  private notice(sid: number, text: string): void {
    const conn = this.room.players.get(sid)?.conn;
    if (conn) this.room.sendTo(conn, { t: "notice", text });
  }

  private player(sid: number): PbPlayer | undefined {
    return this.state.players.find((p) => p.sid === sid);
  }

  private live(): boolean {
    return this.state.phase === "count" || this.state.phase === "play";
  }

  /** Maçta (geri sayım dahil) mı. */
  playing(sid: number): boolean {
    return this.live() && !!this.player(sid);
  }

  /** Geri sayımda ve vurulmuşken yürünmez. */
  frozen(sid: number): boolean {
    const p = this.player(sid);
    return !!p && (this.state.phase === "count" || (this.state.phase === "play" && !p.alive));
  }

  winsFor(sid: number): number {
    const p = this.room.players.get(sid);
    return p ? this.wins.get(p.user.id) ?? 0 : 0;
  }

  /** Galibiyet sayısını (bir kez) bottan ister ve oyuncuya yollar. */
  info(sid: number): void {
    const p = this.room.players.get(sid);
    if (!p) return;
    const id = p.user.id;
    const send = () => this.room.players.get(sid) && this.room.sendTo(p.conn, { t: "pbwins", wins: this.wins.get(id) ?? 0 });
    if (this.asked.has(id) || !this.winsOf) return send();
    this.asked.add(id);
    this.winsOf(sid)
      .then((n) => {
        if (n !== null) this.wins.set(id, Math.max(n, this.wins.get(id) ?? 0));
      })
      .catch(() => this.asked.delete(id))
      .finally(send);
  }

  join(sid: number, now = this.clock()): void {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator || p.info.jailed) return;
    const s = this.state;
    if (s.queue.includes(sid) || this.player(sid)) return;
    const { x, z } = p.state;
    if (x < PB_AREA.minX || x > PB_AREA.maxX || z < PB_AREA.minZ || z > PB_AREA.maxZ) return this.notice(sid, "🎯 Sıraya girmek için paintball sahasının kulübesine gel.");
    if (s.queue.length >= PB.maxQueue) return this.notice(sid, "🎯 Sıra dolu, biraz sonra tekrar dene.");
    s.queue.push(sid);
    this.info(sid);
    if (!this.start(now)) {
      this.notice(sid, s.queue.length === 1 && s.phase === "idle" ? "🎯 Sıradasın. Rakip gelince maç başlar." : `🎯 Sıradasın (${s.queue.indexOf(sid) + 1}.). Bu maç bitince oynayacaksın.`);
      this.publish();
    }
  }

  /** Sıradan çık; maçtaysa çekilir (rakip kazanır). */
  leave(sid: number, now = this.clock()): void {
    const s = this.state;
    const queued = s.queue.includes(sid);
    s.queue = s.queue.filter((q) => q !== sid);
    if (this.live() && this.player(sid)) {
      const other = s.players.find((p) => p.sid !== sid);
      this.finish(now, other?.sid ?? 0, sid);
    } else if (queued) this.publish();
  }

  gone(sid: number): void {
    this.leave(sid);
    this.skins.delete(sid);
    this.poses.delete(sid);
    this.guns.delete(sid);
  }

  skin(sid: number, id: unknown): void {
    const sk = GUN_SKINS.find((k) => k.id === id);
    if (!sk) return;
    if (this.winsFor(sid) < sk.wins) return this.notice(sid, `🎯 ${sk.name} skini için ${sk.wins} galibiyet gerekli.`);
    this.skins.set(sid, sk.id);
    const p = this.player(sid);
    if (p && p.skin !== sk.id) {
      p.skin = sk.id;
      this.publish();
    }
  }

  pose(sid: number, p: unknown, c: unknown, y: unknown): void {
    if (!this.player(sid) || !finite(p, y)) return;
    this.poses.set(sid, { p: Math.max(-1.5, Math.min(1.5, p as number)), c: c ? 1 : 0, y: Math.max(0, Math.min(3, y as number)) });
    this.posesDirty = true;
  }

  private gun(sid: number): Gun {
    let g = this.guns.get(sid);
    if (!g) this.guns.set(sid, (g = { ammo: PB.hopper, lastFire: 0, reloadUntil: 0 }));
    return g;
  }

  reload(sid: number, now = this.clock()): void {
    if (!this.playing(sid)) return;
    const g = this.gun(sid);
    if (g.reloadUntil || g.ammo >= PB.hopper) return;
    // İstemcinin saatiyle küçük fark: biraz erken dolmuş sayılır
    g.reloadUntil = now + PB.reloadMs - 200;
  }

  fire(sid: number, o: unknown, d: unknown, at: unknown, now = this.clock()): void {
    const me = this.player(sid);
    const p = this.room.players.get(sid);
    if (!me || !p || this.state.phase !== "play" || !me.alive || !vec3(o) || !vec3(d) || !finite(at)) return;
    const g = this.gun(sid);
    if (g.reloadUntil) {
      if (now < g.reloadUntil) return;
      g.ammo = PB.hopper;
      g.reloadUntil = 0;
    }
    if (g.ammo <= 0 || now - g.lastFire < PB.fireMs * 0.7) return;
    // Top gözünün önünden çıkar; yön birim vektör
    if (Math.hypot(o[0] - p.state.x, o[2] - p.state.z) > 1.5 || o[1] < 0 || o[1] > 3.5) return;
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 0.9 || len > 1.1) return;
    g.ammo--;
    g.lastFire = now;
    if (!g.ammo) g.reloadUntil = now + PB.reloadMs - 200;
    const shot: Shot = { o: [o[0], o[1], o[2]], d: [d[0] / len, d[1] / len, d[2] / len] };
    const rewind = Math.max(0, Math.min(PB.maxRewindMs, now - (at as number)));
    this.balls.push({ sid, shot, at: now, rewind, t: 0 });
    this.room.broadcast({ t: "pbshot", sid, o: shot.o, d: shot.d, at: now });
  }

  /** Maçı başlat (boştaysa ve sırada iki kişi varsa). */
  private start(now: number): boolean {
    const s = this.state;
    if (s.phase !== "idle") return false;
    s.queue = s.queue.filter((sid) => this.room.players.has(sid));
    if (s.queue.length < 2) return false;
    const pair = s.queue.splice(0, 2);
    s.players = pair.map((sid, i) => ({ sid, slot: i as 0 | 1, kills: 0, deaths: 0, alive: true, respawnAt: 0, safeUntil: 0, skin: this.skins.get(sid) ?? GUN_SKINS[0].id }));
    s.phase = "count";
    s.startAt = now + PB.countMs;
    s.endsAt = s.startAt + PB.matchMs;
    s.winner = undefined;
    this.balls = [];
    this.hist.clear();
    for (const pl of s.players) {
      this.guns.set(pl.sid, { ammo: PB.hopper, lastFire: 0, reloadUntil: 0 });
      const spot = spawnSpots(pl.slot)[1];
      this.room.moveTo(pl.sid, spot.x, spot.z, spot.rot, now);
      pl.safeUntil = s.startAt + PB.safeMs;
    }
    const [a, b] = s.players.map((pl) => this.room.players.get(pl.sid)?.info.name ?? "?");
    this.room.broadcast({ t: "notice", text: `🎯 Paintball: ${a} vs ${b} başlıyor!` });
    this.publish();
    return true;
  }

  /** Maç biter: `winner` 0 berabere; `quit` çekilen (oynanmış sayılmaz). */
  private finish(now: number, winner: number, quit = 0): void {
    const s = this.state;
    const played = s.phase === "play";
    s.phase = "end";
    s.endsAt = now + PB.endMs;
    s.winner = winner;
    this.balls = [];
    const name = (sid: number) => this.room.players.get(sid)?.info.name ?? "?";
    if (played) for (const p of s.players) if (p.sid !== quit) this.report(p.sid, "pb_play");
    // Galibiyet yalnızca oynanan maçta (geri sayımda çekilen rakibe galibiyet yazdırmaz)
    if (winner && played) {
      this.report(winner, "pb_win");
      const u = this.room.players.get(winner)?.user.id;
      if (u) this.wins.set(u, (this.wins.get(u) ?? 0) + 1);
      const conn = this.room.players.get(winner)?.conn;
      if (conn) this.room.sendTo(conn, { t: "pbwins", wins: this.winsFor(winner) });
    }
    const w = this.player(winner), l = s.players.find((p) => p.sid !== winner);
    const text = quit
      ? `🎯 ${name(quit)} maçtan çekildi${winner ? `, ${name(winner)} kazandı` : ""}!`
      : w ? `🏆 Paintball: ${name(winner)} kazandı (${w.kills}–${l?.kills ?? 0})!` : `🎯 Paintball berabere bitti (${s.players[0]?.kills ?? 0}–${s.players[1]?.kills ?? 0}).`;
    this.room.broadcast({ t: "notice", text });
    // Çekilen hemen dışarı çıkar
    if (quit) {
      s.players = s.players.filter((p) => p.sid !== quit);
      this.release(quit, 0, now);
    }
    this.publish();
  }

  /** Oyuncuyu ağın dışına bırakır. */
  private release(sid: number, i: number, now: number): void {
    if (!this.room.players.has(sid)) return;
    this.room.moveTo(sid, PB_EXIT.x, PB_EXIT.z + i * 1.4, PB_EXIT.rot, now);
  }

  /** Atanın gördüğü andaki konum (geçmişten doğrusal ara değer). */
  private posAt(sid: number, t: number): { x: number; z: number } | null {
    const h = this.hist.get(sid);
    const st = this.room.players.get(sid)?.state;
    if (!st) return null;
    if (!h?.length || t >= h[h.length - 1].t) return st;
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1], b = h[i];
      if (t >= a.t) {
        const k = (t - a.t) / Math.max(1, b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return h[0];
  }

  private respawn(p: PbPlayer, now: number): void {
    const foe = this.state.players.find((q) => q.sid !== p.sid);
    const fs = foe ? this.room.players.get(foe.sid)?.state : undefined;
    const spots = spawnSpots(p.slot);
    // Rakipten en uzak doğma noktası
    const spot = fs ? spots.reduce((a, b) => (Math.hypot(b.x - fs.x, b.z - fs.z) > Math.hypot(a.x - fs.x, a.z - fs.z) ? b : a)) : spots[1];
    this.room.moveTo(p.sid, spot.x, spot.z, spot.rot, now);
    p.alive = true;
    p.safeUntil = now + PB.safeMs;
    this.guns.set(p.sid, { ammo: PB.hopper, lastFire: 0, reloadUntil: 0 });
  }

  private flyBalls(now: number): void {
    const s = this.state;
    const pos = { x: 0, y: 0, z: 0 };
    this.balls = this.balls.filter((b) => {
      const until = Math.min(BALL.life, (now - b.at) / 1000);
      const foe = s.players.find((p) => p.sid !== b.sid);
      while (b.t < until) {
        b.t = Math.min(until, b.t + STEP);
        ballAt(b.shot, b.t, pos);
        if (foe?.alive) {
          const seen = b.at - b.rewind + b.t * 1000;
          const fp = this.posAt(foe.sid, seen), pose = this.poses.get(foe.sid);
          if (fp && seen >= foe.safeUntil && hitsPlayer(pos.x, pos.y, pos.z, fp.x, pose?.y ?? 0, fp.z, !!pose?.c)) {
            this.hit(b.sid, foe, pos, now);
            return false;
          }
        }
        if (ballBlocked(pos.x, pos.y, pos.z)) return false;
      }
      return b.t < BALL.life;
    });
  }

  private hit(by: number, victim: PbPlayer, at: { x: number; y: number; z: number }, now: number): void {
    const shooter = this.player(by);
    if (shooter) shooter.kills++;
    victim.deaths++;
    victim.alive = false;
    victim.respawnAt = now + PB.respawnMs;
    this.room.broadcast({ t: "pbhit", by, victim: victim.sid, x: at.x, y: at.y, z: at.z });
    this.report(by, "pb_hit");
    this.publish();
  }

  tick(now = this.clock()): void {
    const s = this.state;
    if (s.phase === "idle") return;
    // Sahadan kaçan ya da çıkan çekilmiş sayılır
    for (const p of s.players) {
      const st = this.room.players.get(p.sid)?.state;
      if (!st) {
        if (this.live()) return this.leave(p.sid, now);
        continue;
      }
      if (this.live() && (st.x < PB_INNER.minX - 3 || st.x > PB_INNER.maxX + 3 || st.z < PB_INNER.minZ - 3 || st.z > PB_INNER.maxZ + 3)) {
        this.notice(p.sid, "🎯 Sahadan çıktın, maçtan çekildin.");
        return this.leave(p.sid, now);
      }
      let h = this.hist.get(p.sid);
      if (!h) this.hist.set(p.sid, (h = []));
      h.push({ t: now, x: st.x, z: st.z });
      while (h.length && now - h[0].t > HISTORY_MS) h.shift();
    }
    if (s.phase === "count" && now >= s.startAt) {
      s.phase = "play";
      this.publish();
    }
    if (s.phase === "play") {
      for (const p of s.players) if (!p.alive && now >= p.respawnAt) {
        this.respawn(p, now);
        this.publish();
      }
      this.flyBalls(now);
      if (now >= s.endsAt) {
        const [a, b] = s.players;
        this.finish(now, a && b && a.kills !== b.kills ? (a.kills > b.kills ? a.sid : b.sid) : 0);
      }
    }
    if (s.phase === "end" && now >= s.endsAt) {
      s.players.forEach((p, i) => this.release(p.sid, i, now));
      s.players = [];
      s.phase = "idle";
      s.winner = undefined;
      if (!this.start(now)) this.publish();
      return;
    }
    if (this.posesDirty) {
      this.posesDirty = false;
      const p: number[] = [];
      for (const pl of s.players) {
        const q = this.poses.get(pl.sid);
        if (q) p.push(pl.sid, Math.round(q.p * 100), q.c, Math.round(q.y * 100));
      }
      this.room.broadcast({ t: "pbposes", p });
    }
  }
}
