// Futbol: top sunucuda (tek otorite). Oyuncular topa değince sürer, F/tık ile şut çeker; sahanın kenarından seker,
// kale ağzından geçerse gol. Hareket ederken her tikte, dururken iki saniyede bir yayınlanır.
import { PLAYER_RADIUS } from "../../../shared/constants";
import type { BallState } from "../../../shared/protocol";
import { BALL_R, KICK_REACH, PITCH } from "../../../shared/zones";
import type { Conn, Room } from "../room";

const GRAVITY = 9.8;
/** Yerde yuvarlanırken hız sönümü (1/sn) ve sekmede kalan hız. */
const ROLL_DAMP = 0.55;
const BOUNCE = 0.5;
const WALL_BOUNCE = 0.6;
const KICK_COOLDOWN_MS = 450;
const GOAL_RESET_MS = 2500;
/** Uzun süre kimse dokunmazsa skor sıfırlanır. */
const IDLE_RESET_MS = 10 * 60 * 1000;
const SUBSTEPS = 4;

export class Football {
  private b = { x: PITCH.x, y: 0, z: PITCH.z, vx: 0, vy: 0, vz: 0 };
  score: [number, number] = [0, 0];
  private prev = new Map<number, { x: number; z: number }>();
  private lastKick = new Map<number, number>();
  private toucher = 0;
  private lastTouch = 0;
  private resetAt = 0;
  private lastSent = 0;
  private wasMoving = false;
  private last = Date.now();

  constructor(
    private room: Room,
    private report: (sid: number, event: string) => void,
  ) {}

  state(now: number): BallState {
    const b = this.b;
    return { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, at: now };
  }

  sendTo(conn: Conn, now = Date.now()): void {
    this.room.sendTo(conn, { t: "ball", ...this.state(now) });
    this.room.sendTo(conn, { t: "score", score: this.score });
  }

  private moving(): boolean {
    const b = this.b;
    return Math.abs(b.vx) + Math.abs(b.vz) + Math.abs(b.vy) > 0.02 || b.y > 0.001;
  }

  /** Şut: yön oyuncunun baktığı yer, güç 0–1 (basılı tutma). */
  kick(sid: number, dir: number, power: number, now = Date.now()): void {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator || !Number.isFinite(dir) || !Number.isFinite(power) || this.resetAt) return;
    if (now - (this.lastKick.get(sid) ?? 0) < KICK_COOLDOWN_MS) return;
    const b = this.b;
    if (Math.hypot(p.state.x - b.x, p.state.z - b.z) > KICK_REACH || b.y > 1.2) return;
    this.lastKick.set(sid, now);
    const k = Math.max(0, Math.min(1, power));
    const speed = 7 + 11 * k;
    b.vx = Math.sin(dir) * speed;
    b.vz = Math.cos(dir) * speed;
    b.vy = 1.5 + 4.5 * k;
    this.touch(sid, now);
    this.broadcast(now);
  }

  private touch(sid: number, now: number): void {
    this.toucher = sid;
    this.lastTouch = now;
  }

  private broadcast(now: number): void {
    this.lastSent = now;
    this.room.broadcast({ t: "ball", ...this.state(now) });
  }

  tick(now: number): void {
    const dt = Math.max(0, Math.min(0.2, (now - this.last) / 1000));
    this.last = now;
    if (this.lastTouch && now - this.lastTouch > IDLE_RESET_MS && (this.score[0] || this.score[1])) {
      this.score = [0, 0];
      this.lastTouch = 0;
      this.room.broadcast({ t: "score", score: this.score });
    }
    if (this.resetAt && now >= this.resetAt) {
      Object.assign(this.b, { x: PITCH.x, y: 0, z: PITCH.z, vx: 0, vy: 0, vz: 0 });
      this.resetAt = 0;
      this.broadcast(now);
    }
    const touched = this.dribble(dt, now);
    const h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) this.step(h, now);
    const moving = this.moving();
    if (touched || (moving && now - this.lastSent > 60) || (moving !== this.wasMoving) || now - this.lastSent > 2000) this.broadcast(now);
    this.wasMoving = moving;
  }

  /** Topa değen oyuncu onu kendi hızıyla iter (sürme). */
  private dribble(dt: number, now: number): boolean {
    const b = this.b;
    let touched = false;
    for (const [sid, p] of this.room.players) {
      const prev = this.prev.get(sid);
      const vx = prev && dt > 0 ? (p.state.x - prev.x) / dt : 0;
      const vz = prev && dt > 0 ? (p.state.z - prev.z) / dt : 0;
      this.prev.set(sid, { x: p.state.x, z: p.state.z });
      if (p.info.spectator || b.y > 0.7 || this.resetAt) continue;
      const dx = b.x - p.state.x, dz = b.z - p.state.z;
      const d = Math.hypot(dx, dz);
      const reach = PLAYER_RADIUS + BALL_R + 0.05;
      if (d >= reach || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d;
      // Topu oyuncunun dışına çıkar, oyuncunun o yöndeki hızının biraz fazlasıyla it
      b.x = p.state.x + nx * reach;
      b.z = p.state.z + nz * reach;
      const push = Math.max(0, vx * nx + vz * nz);
      const along = b.vx * nx + b.vz * nz;
      const target = push * 1.25 + 0.8;
      if (along < target) {
        b.vx += nx * (target - along);
        b.vz += nz * (target - along);
      }
      this.touch(sid, now);
      touched = true;
    }
    for (const sid of this.prev.keys()) if (!this.room.players.has(sid)) this.prev.delete(sid);
    return touched;
  }

  private step(dt: number, now: number): void {
    const b = this.b;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.y += b.vy * dt;
    if (b.y > 0 || b.vy > 0) b.vy -= GRAVITY * dt;
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
    const lx = b.x - PITCH.x, lz = b.z - PITCH.z;
    // Yan çizgiler: sek
    if (Math.abs(lz) > PITCH.hz - BALL_R) {
      b.z = PITCH.z + Math.sign(lz) * (PITCH.hz - BALL_R);
      b.vz = -b.vz * WALL_BOUNCE;
    }
    if (Math.abs(lx) > PITCH.hx - BALL_R) {
      const inMouth = Math.abs(lz) < PITCH.goalHalf - BALL_R && b.y < PITCH.goalH;
      if (Math.abs(lx) > PITCH.hx + BALL_R) {
        // Kalenin içi (ağ): gol sayılır, top ağın arkasında ve yanlarında kalır
        if (!this.resetAt) this.goal(lx < 0 ? 0 : 1, now);
        if (Math.abs(lx) > PITCH.hx + 1.1) {
          b.x = PITCH.x + Math.sign(lx) * (PITCH.hx + 1.1);
          b.vx = -b.vx * 0.2;
        }
        if (Math.abs(lz) > PITCH.goalHalf - BALL_R) {
          b.z = PITCH.z + Math.sign(lz) * (PITCH.goalHalf - BALL_R);
          b.vz = -b.vz * 0.3;
        }
        if (b.y > PITCH.goalH - BALL_R) {
          b.y = PITCH.goalH - BALL_R;
          b.vy = -Math.abs(b.vy) * 0.3;
        }
      } else if (!inMouth) {
        // Kale ağzı dışı: kenar çizgisinden sek
        b.x = PITCH.x + Math.sign(lx) * (PITCH.hx - BALL_R);
        b.vx = -b.vx * WALL_BOUNCE;
      }
    }
  }

  /** `side` 0: batıdaki kaleye gol (doğu takımı sayar), 1: doğudakine. */
  private goal(side: 0 | 1, now: number): void {
    this.score[side === 0 ? 1 : 0]++;
    this.resetAt = now + GOAL_RESET_MS;
    const sid = this.toucher;
    const name = this.room.players.get(sid)?.info.name ?? "Biri";
    this.room.broadcast({ t: "goal", side, sid, name, score: this.score });
    if (sid) this.report(sid, "goal");
  }

  leave(sid: number): void {
    this.prev.delete(sid);
    this.lastKick.delete(sid);
    if (this.toucher === sid) this.toucher = 0;
  }
}
