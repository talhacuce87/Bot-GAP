// Futbol: top sunucuda (tek otorite). Koşan oyuncu topu önünde sürer; F'ye dokunmak pas (önündeki oyuncuya),
// basılı tutmak şut, G aşırtma. Yana basarak vurulursa top falsolu gider. Havadaki top kafayla karşılanır;
// direkten ve üst direkten seker. Kale ağzından geçen top gol; "!maç" ile süreli, takımlı maç oynanır.
import { PLAYER_RADIUS } from "../../../shared/constants";
import type { BallEvent, BallState, KickKind, MatchState } from "../../../shared/protocol";
import { BALL_R, KICK_REACH, PITCH } from "../../../shared/zones";
import { CHAT_HISTORY } from "../chat";
import type { Conn, Room } from "../room";

const GRAVITY = 9.8;
/** Yerde yuvarlanırken hız sönümü (1/sn), havada hava direnci, sekmede kalan hız. */
const ROLL_DAMP = 0.6;
const AIR_DAMP = 0.08;
const BOUNCE = 0.5;
const WALL_BOUNCE = 0.6;
const POST_BOUNCE = 0.7;
const POST_R = 0.06;
const KICK_COOLDOWN_MS = 350;
const HEAD_COOLDOWN_MS = 400;
const GOAL_RESET_MS = 2500;
/** Uzun süre kimse dokunmazsa skor sıfırlanır. */
const IDLE_RESET_MS = 10 * 60 * 1000;
const SUBSTEPS = 4;
/** Asist: golden önceki dokunuş bu kadar yeniyse ve başkasınınsa. */
const ASSIST_MS = 8000;
/** Pas hedefi: baktığı yönden bu açı içinde ve bu mesafedeki en uygun oyuncu. */
const PASS_CONE = 0.55;
const PASS_RANGE: [number, number] = [2.5, 24];
export const MATCH_MINUTES: [number, number, number] = [1, 5, 15];

export class Football {
  private b = { x: PITCH.x, y: 0, z: PITCH.z, vx: 0, vy: 0, vz: 0, spin: 0 };
  score: [number, number] = [0, 0];
  private prev = new Map<number, { x: number; z: number; vx: number; vz: number }>();
  private lastKick = new Map<number, number>();
  private toucher = 0;
  private prevToucher = { sid: 0, at: 0 };
  private lastTouch = 0;
  private resetAt = 0;
  private lastSent = 0;
  private wasMoving = false;
  private last = Date.now();
  private match: MatchState | null = null;
  private pendingEv: { ev: BallEvent; by: number } | null = null;

  constructor(
    private room: Room,
    private report: (sid: number, event: string) => void,
  ) {}

  state(now: number): BallState {
    const b = this.b;
    return { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, at: now, spin: b.spin };
  }

  sendTo(conn: Conn, now = Date.now()): void {
    this.room.sendTo(conn, { t: "ball", ...this.state(now) });
    this.room.sendTo(conn, { t: "score", score: this.score });
    if (this.match) this.room.sendTo(conn, { t: "match", match: this.match });
  }

  private moving(): boolean {
    const b = this.b;
    return Math.abs(b.vx) + Math.abs(b.vz) + Math.abs(b.vy) > 0.02 || b.y > 0.001;
  }

  /** Takımı (maç yoksa null). */
  teamOf(sid: number): 0 | 1 | null {
    const m = this.match;
    if (!m) return null;
    return m.teams[0].includes(sid) ? 0 : m.teams[1].includes(sid) ? 1 : null;
  }

  /**
   * Vuruş: `dir` oyuncunun baktığı yön, `power` 0–1 (basılı tutma), `curve` -1…1 falso.
   * Pas yerden gider ve baktığı yöndeki oyuncuya (koşuyorsa önüne) yönelir; aşırtma yüksek yay çizer.
   */
  kick(sid: number, dir: number, power: number, now = Date.now(), kind: KickKind = "shot", curve = 0): void {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator || !Number.isFinite(dir) || !Number.isFinite(power) || this.resetAt) return;
    if (kind !== "shot" && kind !== "pass" && kind !== "lob") return;
    if (now - (this.lastKick.get(sid) ?? 0) < KICK_COOLDOWN_MS) return;
    const b = this.b;
    if (Math.hypot(p.state.x - b.x, p.state.z - b.z) > KICK_REACH || b.y > 1.2) return;
    this.lastKick.set(sid, now);
    const k = Math.max(0, Math.min(1, power));
    const c = Number.isFinite(curve) ? Math.max(-1, Math.min(1, curve)) : 0;
    let speed: number;
    if (kind === "pass") {
      const target = this.passTarget(sid, b.x, b.z, dir);
      if (target) {
        // Hedefin koşusuna göre önüne at: varış süresi kadar ilerisi
        const d0 = Math.hypot(target.x - b.x, target.z - b.z);
        speed = Math.min(16, Math.max(6, d0 * 1.1 + 2));
        const t = d0 / speed;
        dir = Math.atan2(target.x + target.vx * t - b.x, target.z + target.vz * t - b.z);
        speed = Math.min(17, Math.hypot(target.x + target.vx * t - b.x, target.z + target.vz * t - b.z) * 1.1 + 2);
      } else speed = 6 + 8 * k;
      b.vy = 0;
      b.spin = 0;
    } else if (kind === "lob") {
      speed = 5 + 7 * k;
      b.vy = 5 + 3.5 * k;
      b.spin = c * 0.6;
    } else {
      speed = 8 + 14 * k;
      b.vy = 1 + 3.2 * k;
      b.spin = c * 1.4;
    }
    b.vx = Math.sin(dir) * speed;
    b.vz = Math.cos(dir) * speed;
    this.touch(sid, now);
    this.pendingEv = { ev: kind, by: sid };
    this.broadcast(now);
  }

  /** Pas için en uygun oyuncu: baktığı yöne en yakın açı, makul mesafe; maçta yalnızca takım arkadaşı. */
  private passTarget(sid: number, bx: number, bz: number, dir: number): { x: number; z: number; vx: number; vz: number } | null {
    const team = this.teamOf(sid);
    let best: { x: number; z: number; vx: number; vz: number } | null = null;
    let bestScore = Infinity;
    for (const [other, p] of this.room.players) {
      if (other === sid || p.info.spectator) continue;
      if (team !== null && this.teamOf(other) !== team) continue;
      const dx = p.state.x - bx, dz = p.state.z - bz, d = Math.hypot(dx, dz);
      if (d < PASS_RANGE[0] || d > PASS_RANGE[1]) continue;
      let off = Math.abs(Math.atan2(dx, dz) - dir) % (Math.PI * 2);
      if (off > Math.PI) off = Math.PI * 2 - off;
      if (off > PASS_CONE) continue;
      const score = off * 10 + d * 0.15;
      if (score < bestScore) {
        bestScore = score;
        const v = this.prev.get(other);
        best = { x: p.state.x, z: p.state.z, vx: v?.vx ?? 0, vz: v?.vz ?? 0 };
      }
    }
    return best;
  }

  private touch(sid: number, now: number): void {
    if (sid !== this.toucher && this.toucher) this.prevToucher = { sid: this.toucher, at: now };
    this.toucher = sid;
    this.lastTouch = now;
  }

  private broadcast(now: number): void {
    this.lastSent = now;
    const ev = this.pendingEv;
    this.pendingEv = null;
    this.room.broadcast({ t: "ball", ...this.state(now), ...(ev ? { ev: ev.ev, by: ev.by } : {}) });
  }

  tick(now: number): void {
    const dt = Math.max(0, Math.min(0.2, (now - this.last) / 1000));
    this.last = now;
    if (!this.match && this.lastTouch && now - this.lastTouch > IDLE_RESET_MS && (this.score[0] || this.score[1])) {
      this.score = [0, 0];
      this.lastTouch = 0;
      this.room.broadcast({ t: "score", score: this.score });
    }
    if (this.match) this.matchTick(now);
    if (this.resetAt && now >= this.resetAt) {
      Object.assign(this.b, { x: PITCH.x, y: 0, z: PITCH.z, vx: 0, vy: 0, vz: 0, spin: 0 });
      this.resetAt = 0;
      this.broadcast(now);
    }
    const touched = this.dribble(dt, now);
    const h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) this.step(h, now);
    const moving = this.moving();
    if (touched || this.pendingEv || (moving && now - this.lastSent > 60) || moving !== this.wasMoving || now - this.lastSent > 2000) this.broadcast(now);
    this.wasMoving = moving;
  }

  /**
   * Sürme: koşan oyuncu topu önünde, kendi hızının biraz üstünde tutar (kısa dokunuşlar); duran oyuncu
   * yalnızca topu kenara iter. Göğüs/kafa hizasındaki top kafayla karşılanır.
   */
  private dribble(dt: number, now: number): boolean {
    const b = this.b;
    let touched = false;
    for (const [sid, p] of this.room.players) {
      const prev = this.prev.get(sid);
      const vx = prev && dt > 0 ? (p.state.x - prev.x) / dt : 0;
      const vz = prev && dt > 0 ? (p.state.z - prev.z) / dt : 0;
      // Hız tik aralığında gürültülü: yumuşat
      const sx = prev ? prev.vx * 0.5 + vx * 0.5 : 0, sz = prev ? prev.vz * 0.5 + vz * 0.5 : 0;
      this.prev.set(sid, { x: p.state.x, z: p.state.z, vx: sx, vz: sz });
      if (p.info.spectator || this.resetAt) continue;
      const dx = b.x - p.state.x, dz = b.z - p.state.z;
      const d = Math.hypot(dx, dz);
      if (b.y > 0.55) {
        if (b.y < 2.1 && d < 0.55 && now - (this.lastKick.get(sid) ?? 0) > HEAD_COOLDOWN_MS) touched = this.header(sid, p.state.rot, now) || touched;
        continue;
      }
      const reach = PLAYER_RADIUS + BALL_R + 0.05;
      if (d >= reach || d < 1e-4) continue;
      const speed = Math.hypot(sx, sz);
      if (speed > 1) {
        // Önde tut: hedef nokta oyuncunun koştuğu yönde, top oraya oyuncudan biraz hızlı gider
        const ux = sx / speed, uz = sz / speed;
        const ahead = reach + 0.35 + speed * 0.05;
        const tx = p.state.x + ux * ahead, tz = p.state.z + uz * ahead;
        const knock = speed > 5.5 ? 1.25 : 1.08;
        b.vx = sx * knock + (tx - b.x) * 5;
        b.vz = sz * knock + (tz - b.z) * 5;
        b.spin = 0;
      }
      const nx = dx / d, nz = dz / d;
      b.x = p.state.x + nx * reach;
      b.z = p.state.z + nz * reach;
      const along = b.vx * nx + b.vz * nz;
      if (along < 0.8) {
        b.vx += nx * (0.8 - along);
        b.vz += nz * (0.8 - along);
      }
      this.touch(sid, now);
      touched = true;
    }
    for (const sid of this.prev.keys()) if (!this.room.players.has(sid)) this.prev.delete(sid);
    return touched;
  }

  /** Kafa: top oyuncunun baktığı yöne, gelen hızın bir kısmıyla ve hafif yukarı sekerek gider. */
  private header(sid: number, rot: number, now: number): boolean {
    const b = this.b;
    this.lastKick.set(sid, now);
    const speed = Math.hypot(b.vx, b.vz) * 0.55 + 4;
    b.vx = Math.sin(rot) * speed;
    b.vz = Math.cos(rot) * speed;
    b.vy = b.y > 1.5 ? 0.5 : 2.5;
    b.spin = 0;
    this.touch(sid, now);
    this.pendingEv = { ev: "head", by: sid };
    return true;
  }

  private step(dt: number, now: number): void {
    const b = this.b;
    // Falso: hız vektörü dönerek kavis çizer (hızlıyken), zamanla söner
    if (b.spin && Math.hypot(b.vx, b.vz) > 2) {
      const a = -b.spin * dt, c = Math.cos(a), s = Math.sin(a);
      const vx = b.vx * c + b.vz * s;
      b.vz = b.vz * c - b.vx * s;
      b.vx = vx;
    }
    b.spin *= Math.exp(-dt * (b.y > 0 ? 0.6 : 3));
    if (Math.abs(b.spin) < 0.01) b.spin = 0;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.y += b.vy * dt;
    if (b.y > 0 || b.vy > 0) {
      b.vy -= GRAVITY * dt;
      const f = Math.exp(-dt * AIR_DAMP);
      b.vx *= f;
      b.vz *= f;
    }
    if (b.y <= 0 && b.vy <= 0) {
      // Yere değdi: hızlı düşüyorsa seker, yavaşsa yuvarlanır
      b.y = 0;
      b.vy = b.vy < -1 ? -b.vy * BOUNCE : 0;
    }
    if (b.y === 0) {
      const f = Math.exp(-dt * ROLL_DAMP);
      b.vx *= f;
      b.vz *= f;
      if (Math.hypot(b.vx, b.vz) < 0.05) b.vx = b.vz = 0;
    }
    this.posts();
    const lx = b.x - PITCH.x, lz = b.z - PITCH.z;
    // Yan çizgiler (panolar): sek
    if (Math.abs(lz) > PITCH.hz - BALL_R) {
      b.z = PITCH.z + Math.sign(lz) * (PITCH.hz - BALL_R);
      b.vz = -b.vz * WALL_BOUNCE;
      b.spin *= -0.5;
    }
    if (Math.abs(lx) > PITCH.hx - BALL_R) {
      const inMouth = Math.abs(lz) < PITCH.goalHalf - BALL_R && b.y < PITCH.goalH - BALL_R;
      if (Math.abs(lx) > PITCH.hx + BALL_R && (inMouth || this.resetAt)) {
        // Kalenin içi (ağ): gol sayılır, top ağın arkasında ve yanlarında kalır
        if (!this.resetAt) this.goal(lx < 0 ? 0 : 1, now);
        if (Math.abs(lx) > PITCH.hx + 1.1) {
          b.x = PITCH.x + Math.sign(lx) * (PITCH.hx + 1.1);
          b.vx = -b.vx * 0.15;
        }
        if (Math.abs(lz) > PITCH.goalHalf - BALL_R) {
          b.z = PITCH.z + Math.sign(lz) * (PITCH.goalHalf - BALL_R);
          b.vz = -b.vz * 0.2;
        }
        if (b.y > PITCH.goalH - BALL_R) {
          b.y = PITCH.goalH - BALL_R;
          b.vy = -Math.abs(b.vy) * 0.3;
        }
        b.spin = 0;
      } else if (!inMouth && Math.abs(lx) <= PITCH.hx + BALL_R) {
        // Kale ağzı dışı: kenar çizgisinden sek
        b.x = PITCH.x + Math.sign(lx) * (PITCH.hx - BALL_R);
        b.vx = -b.vx * WALL_BOUNCE;
        b.spin *= -0.5;
      } else if (!inMouth) {
        // Ağın dışından (üstünden/yanından) gelen: kale çizgisinin dışında kalmasın
        b.x = PITCH.x + Math.sign(lx) * (PITCH.hx - BALL_R);
        b.vx = -Math.abs(b.vx) * Math.sign(lx) * WALL_BOUNCE;
      }
    }
  }

  /** Direkler ve üst direk: top çarparsa seker ("tak" sesi). */
  private posts(): void {
    const b = this.b;
    for (const side of [-1, 1]) {
      const gx = PITCH.x + side * PITCH.hx;
      if (Math.abs(b.x - gx) > 1) continue;
      if (b.y < PITCH.goalH + BALL_R) {
        for (const sz of [-1, 1]) {
          const pz = PITCH.z + sz * PITCH.goalHalf;
          const dx = b.x - gx, dz = b.z - pz, d = Math.hypot(dx, dz);
          if (d < BALL_R + POST_R && d > 1e-4) this.bounceOff(dx / d, 0, dz / d, gx + (dx / d) * (BALL_R + POST_R), b.y, pz + (dz / d) * (BALL_R + POST_R), "post");
        }
      }
      // Üst direk: x–y düzleminde silindir
      if (Math.abs(b.z - PITCH.z) < PITCH.goalHalf) {
        const dx = b.x - gx, dy = b.y + BALL_R - PITCH.goalH, d = Math.hypot(dx, dy);
        if (d < BALL_R + POST_R && d > 1e-4) this.bounceOff(dx / d, dy / d, 0, gx + (dx / d) * (BALL_R + POST_R), PITCH.goalH - BALL_R + (dy / d) * (BALL_R + POST_R), b.z, "bar");
      }
    }
  }

  private bounceOff(nx: number, ny: number, nz: number, x: number, y: number, z: number, ev: BallEvent): void {
    const b = this.b;
    const vn = b.vx * nx + b.vy * ny + b.vz * nz;
    b.x = x;
    b.y = Math.max(0, y);
    b.z = z;
    if (vn >= 0) return;
    const k = (1 + POST_BOUNCE) * vn;
    b.vx -= k * nx;
    b.vy -= k * ny;
    b.vz -= k * nz;
    b.spin = 0;
    if (Math.abs(vn) > 2) this.pendingEv = { ev, by: 0 };
  }

  /** `side` 0: batıdaki kaleye gol (doğu/mavi takım sayar), 1: doğudakine (batı/kırmızı sayar). */
  private goal(side: 0 | 1, now: number): void {
    const scoring = side === 0 ? 1 : 0;
    this.score[scoring]++;
    this.resetAt = now + GOAL_RESET_MS;
    const sid = this.toucher;
    const name = this.room.players.get(sid)?.info.name ?? "Biri";
    // Maçta kendi kalesine atan sayılmaz (gol takıma yazılır, oyuncuya görev yok)
    const own = this.match ? this.teamOf(sid) === side : false;
    const pt = this.prevToucher;
    const assistSid = !own && pt.sid && pt.sid !== sid && now - pt.at < ASSIST_MS && (this.teamOf(pt.sid) ?? 0) === (this.teamOf(sid) ?? 0) ? pt.sid : 0;
    const assist = assistSid ? this.room.players.get(assistSid)?.info.name : undefined;
    this.room.broadcast({ t: "goal", side, sid, name, score: this.score, ...(assist ? { assist } : {}), ...(own ? { own } : {}) });
    if (sid && !own) this.report(sid, "goal");
    this.toucher = 0;
    this.prevToucher = { sid: 0, at: 0 };
  }

  // ---------------------------------------------------------------------------
  // Maç
  // ---------------------------------------------------------------------------

  /**
   * Süreli maç başlatır: sahadakiler (ve kenarındakiler) bulundukları yarıya göre takımlara ayrılır,
   * skor sıfırlanır, top ortaya konur. Hata metni ya da null.
   */
  startMatch(minutes: number, now = Date.now()): string | null {
    if (this.match) return "⚽ Zaten bir maç sürüyor.";
    const m = Math.round(Math.max(MATCH_MINUTES[0], Math.min(MATCH_MINUTES[2], Number.isFinite(minutes) ? minutes : MATCH_MINUTES[1])));
    const teams: [number[], number[]] = [[], []];
    for (const [sid, p] of this.room.players) {
      if (p.info.spectator || !this.nearPitch(p.state.x, p.state.z)) continue;
      teams[p.state.x < PITCH.x ? 0 : 1].push(sid);
    }
    if (teams[0].length + teams[1].length < 2) return "⚽ Maç için sahada en az iki kişi olmalı.";
    // Tek yarıda toplandılarsa dengele
    while (Math.abs(teams[0].length - teams[1].length) > 1) {
      const [from, to] = teams[0].length > teams[1].length ? [teams[0], teams[1]] : [teams[1], teams[0]];
      to.push(from.pop()!);
    }
    this.match = { endsAt: now + m * 60_000, teams };
    this.score = [0, 0];
    Object.assign(this.b, { x: PITCH.x, y: 0, z: PITCH.z, vx: 0, vy: 0, vz: 0, spin: 0 });
    this.resetAt = now + GOAL_RESET_MS;
    this.room.broadcast({ t: "score", score: this.score });
    this.room.broadcast({ t: "match", match: this.match });
    this.broadcast(now);
    return null;
  }

  private nearPitch(x: number, z: number): boolean {
    return Math.abs(x - PITCH.x) < PITCH.hx + 4 && Math.abs(z - PITCH.z) < PITCH.hz + 4;
  }

  private matchTick(now: number): void {
    const m = this.match!;
    // Sonradan sahaya gelen az kişili takıma katılır
    for (const [sid, p] of this.room.players) {
      if (p.info.spectator || this.teamOf(sid) !== null || !this.nearPitch(p.state.x, p.state.z)) continue;
      m.teams[m.teams[0].length <= m.teams[1].length ? 0 : 1].push(sid);
      this.room.broadcast({ t: "match", match: m });
    }
    if (now < m.endsAt) return;
    const [r, bl] = this.score;
    const text = r === bl ? `⚽ Maç bitti: ${r} – ${bl}, berabere!` : `⚽ Maç bitti: 🔴 ${r} – ${bl} 🔵 · ${r > bl ? "Kırmızı" : "Mavi"} takım kazandı!`;
    this.room.say({ kind: "system", sid: 0, name: "Bot GAP", text, at: now }, CHAT_HISTORY);
    if (r !== bl) for (const sid of m.teams[r > bl ? 0 : 1]) if (this.room.players.has(sid)) this.report(sid, "match_win");
    this.match = null;
    this.room.broadcast({ t: "match", match: null });
  }

  /** Maçı erken bitirir (sonuç duyurulur). */
  endMatch(now = Date.now()): boolean {
    if (!this.match) return false;
    this.match.endsAt = now;
    this.matchTick(now);
    return true;
  }

  leave(sid: number): void {
    this.prev.delete(sid);
    this.lastKick.delete(sid);
    if (this.toucher === sid) this.toucher = 0;
    if (this.match) {
      const m = this.match;
      m.teams = [m.teams[0].filter((s) => s !== sid), m.teams[1].filter((s) => s !== sid)];
      this.room.broadcast({ t: "match", match: m });
    }
  }
}
