// Futbol: top sunucuda (tek otorite). Topa yaklaşan oyuncu topu alır ve önünde sürer (top ayağa bağlı);
// F'ye dokunmak pas, basılı tutmak şut, G aşırtma, yana basarak vurmak falso. Rakibin topuna F ile müdahale
// edilir. Kapalı halı saha: duvarlar oyunun içinde (taç/aut yok, top seker); iki yapay zekâ kaleci kaleyi
// korur. "!maç" süreli takımlı maç.
import type { BallEvent, BallState, KickKind, MatchState } from "../../../shared/protocol";
import { BALL_R, KICK_REACH, PITCH } from "../../../shared/zones";
import { CHAT_HISTORY } from "../chat";
import type { Conn, Room } from "../room";

const GRAVITY = 9.8;
/** Yerde yuvarlanırken hız sönümü (1/sn), havada hava direnci, sekmede kalan hız. */
const ROLL_DAMP = 0.6;
const AIR_DAMP = 0.08;
const BOUNCE = 0.5;
const POST_BOUNCE = 0.7;
const POST_R = 0.06;
const KICK_COOLDOWN_MS = 350;
const HEAD_COOLDOWN_MS = 400;
const GOAL_RESET_MS = 2500;
/** Duvardan sekmede kalan hız (halı saha panoları). */
const WALL_BOUNCE = 0.62;
/** Uzun süre kimse dokunmazsa skor sıfırlanır. */
const IDLE_RESET_MS = 10 * 60 * 1000;
const SUBSTEPS = 4;
/** Asist: golden önceki dokunuş bu kadar yeniyse ve başkasınınsa. */
const ASSIST_MS = 8000;
/** Pas hedefi: baktığı yönden bu açı içinde ve bu mesafedeki en uygun oyuncu. */
const PASS_CONE = 0.55;
const PASS_RANGE: [number, number] = [2.5, 24];
export const MATCH_MINUTES: [number, number, number] = [1, 5, 15];

/** Top sahipliği: topun oyuncunun önündeki yeri, alma yarıçapı, alınabilecek en yüksek top hızı. */
export const DRIBBLE_AHEAD = 0.62;
const GAIN_R = 0.8;
const GAIN_MAX_SPEED = 14;
/** Vuran/topu kaptıran bu süre topu yeniden alamaz. */
const REGAIN_MS = 350;
const TACKLE_R = 1.7;
const TACKLE_COOLDOWN_MS = 1000;
/** Rakip topun üstüne basıp duruyorsa top serbest kalır (gövde ile kesme). */
const BLOCK_R = 0.45;
const BLOCK_MS = 450;

/** Kaleci: kale çizgisinin önünde, ceza alanında kalır. */
const GK_REACH = 0.7;
const GK_DIVE_REACH = 1.25;
const GK_SPEED = 4.2;
const GK_DIVE_SPEED = 7.5;
const GK_HOLD_MS = 1100;
const GK_BOX = 4.5;

interface Keeper {
  side: -1 | 1;
  x: number;
  z: number;
  /** Plonjon (-1…1, + sağına doğru). */
  lean: number;
  holdUntil: number;
  /** Bu şuta karar verildi mi (tutamadıysa aynı şutta tekrar denemez). */
  decided: number;
}

export class Football {
  private b = { x: PITCH.x, y: 0, z: PITCH.z, vx: 0, vy: 0, vz: 0, spin: 0 };
  score: [number, number] = [0, 0];
  private prev = new Map<number, { x: number; z: number; vx: number; vz: number }>();
  private lastKick = new Map<number, number>();
  /** Topu alamaz (vurdu, kaptırdı, müdahalesi boşa çıktı) şu ana kadar. */
  private noGain = new Map<number, number>();
  private lastTackle = new Map<number, number>();
  private blockSince = new Map<number, number>();
  /** Topun sahibi: sid; -1/-2 kaleciler; 0 serbest. */
  private owner = 0;
  private toucher = 0;
  private prevToucher = { sid: 0, at: 0 };
  private lastTouch = 0;
  private resetAt = 0;
  private lastSent = 0;
  private wasMoving = false;
  private last = Date.now();
  private match: MatchState | null = null;
  private pendingEv: { ev: BallEvent; by: number } | null = null;
  /** Her vuruşta artar: kaleci her şuta bir kez karar verir. */
  private shotId = 0;
  private keepers: Keeper[] = [-1, 1].map((side) => ({ side: side as -1 | 1, x: PITCH.x + side * (PITCH.hx - 0.6), z: PITCH.z, lean: 0, holdUntil: 0, decided: -1 }));
  private lastGk = 0;
  /** Kalecinin kararı için rastgele (testte sabitlenir). */
  random: () => number = Math.random;

  constructor(
    private room: Room,
    private report: (sid: number, event: string) => void,
  ) {}

  state(now: number): BallState {
    const b = this.b;
    return { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, at: now, spin: b.spin, ...(this.owner ? { owner: this.owner } : {}) };
  }

  sendTo(conn: Conn, now = Date.now()): void {
    this.room.sendTo(conn, { t: "ball", ...this.state(now) });
    this.room.sendTo(conn, { t: "score", score: this.score });
    this.room.sendTo(conn, { t: "gk", k: this.gkState() });
    if (this.match) this.room.sendTo(conn, { t: "match", match: this.match });
  }

  private gkState(): number[] {
    return this.keepers.flatMap((k) => [round(k.x), round(k.z), round(k.lean)]);
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

  /** Topun sahibi (sid; kaleciler negatif; 0 serbest). */
  get ownerSid(): number {
    return this.owner;
  }

  /**
   * Vuruş: `dir` oyuncunun baktığı yön, `power` 0–1 (basılı tutma), `curve` -1…1 falso.
   * Topu ayağında tutan ya da serbest topun yanındaki vurabilir. Pas yerden, baktığı yöndeki oyuncuya
   * (koşuyorsa önüne) gider; aşırtma yüksek yay çizer; sert şut biraz sapar.
   */
  kick(sid: number, dir: number, power: number, now = Date.now(), kind: KickKind = "shot", curve = 0): void {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator || !Number.isFinite(dir) || !Number.isFinite(power) || this.resetAt) return;
    if (kind !== "shot" && kind !== "pass" && kind !== "lob") return;
    if (now - (this.lastKick.get(sid) ?? 0) < KICK_COOLDOWN_MS) return;
    const b = this.b;
    if (this.owner && this.owner !== sid) return;
    if (this.owner !== sid && (Math.hypot(p.state.x - b.x, p.state.z - b.z) > KICK_REACH || b.y > 1.2)) return;
    this.lastKick.set(sid, now);
    this.release(sid, now);
    const k = Math.max(0, Math.min(1, power));
    const c = Number.isFinite(curve) ? Math.max(-1, Math.min(1, curve)) : 0;
    let speed: number;
    if (kind === "pass") {
      const target = this.passTarget(sid, b.x, b.z, dir);
      if (target) {
        // Hedefin koşusuna göre önüne at: varış süresi kadar ilerisi
        const d0 = Math.hypot(target.x - b.x, target.z - b.z);
        const t = d0 / Math.min(16, Math.max(6, d0 * 1.1 + 2));
        const tx = target.x + target.vx * t, tz = target.z + target.vz * t;
        dir = Math.atan2(tx - b.x, tz - b.z);
        speed = Math.min(17, Math.hypot(tx - b.x, tz - b.z) * 1.1 + 2);
      } else speed = 6 + 8 * k;
      b.vy = 0;
      b.spin = 0;
    } else if (kind === "lob") {
      speed = 5 + 7 * k;
      b.vy = 5 + 3.5 * k;
      b.spin = c * 0.6;
    } else {
      speed = 9 + 15 * k;
      b.vy = 0.6 + 3.4 * k;
      b.spin = c * 1.4;
      // Tam güçte isabet düşer
      dir += (this.random() - 0.5) * 0.12 * k * k;
    }
    b.vx = Math.sin(dir) * speed;
    b.vz = Math.cos(dir) * speed;
    this.shotId++;
    this.touch(sid, now);
    this.pendingEv = { ev: kind, by: sid };
    this.broadcast(now);
  }

  /** Müdahale: rakibin ayağındaki topa; başarılıysa top serbest kalır ve müdahale edenin önüne düşer. */
  tackle(sid: number, now = Date.now()): void {
    const p = this.room.players.get(sid);
    const o = this.owner > 0 ? this.room.players.get(this.owner) : undefined;
    if (!p || !o || this.owner === sid || p.info.spectator) return;
    if (now - (this.lastTackle.get(sid) ?? 0) < TACKLE_COOLDOWN_MS) return;
    const b = this.b;
    if (Math.hypot(p.state.x - b.x, p.state.z - b.z) > TACKLE_R) return;
    this.lastTackle.set(sid, now);
    // Önden müdahale daha kolay; arkadan girilirse çoğu zaman boşa çıkar
    const fx = Math.sin(o.state.rot), fz = Math.cos(o.state.rot);
    const front = (p.state.x - o.state.x) * fx + (p.state.z - o.state.z) * fz >= 0;
    if (this.random() < (front ? 0.62 : 0.32)) {
      const victim = this.owner;
      this.release(victim, now);
      this.noGain.set(victim, now + 700);
      const dx = p.state.x - b.x, dz = p.state.z - b.z, d = Math.hypot(dx, dz) || 1;
      b.vx = (dx / d) * 3 + Math.sin(p.state.rot) * 1.5;
      b.vz = (dz / d) * 3 + Math.cos(p.state.rot) * 1.5;
      b.vy = 0.8;
      this.touch(sid, now);
    } else this.noGain.set(sid, now + 900);
    this.pendingEv = { ev: "tackle", by: sid };
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

  /** Top sahibinden çıkar (vuruş, kaptırma). */
  private release(sid: number, now: number): void {
    if (this.owner === sid) this.owner = 0;
    this.noGain.set(sid, Math.max(this.noGain.get(sid) ?? 0, now + REGAIN_MS));
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
      this.place(PITCH.x, PITCH.z);
      this.resetAt = 0;
      this.resetKeepers();
      this.broadcast(now);
    }
    const touched = this.players(dt, now);
    if (this.owner > 0) this.carry(now);
    else if (this.owner < 0) this.keeperCarry();
    else {
      const h = dt / SUBSTEPS;
      for (let i = 0; i < SUBSTEPS; i++) this.step(h, now);
    }
    this.keeperTick(dt, now);
    const moving = this.moving();
    if (touched || this.pendingEv || (moving && now - this.lastSent > 60) || moving !== this.wasMoving || now - this.lastSent > 2000) this.broadcast(now);
    this.wasMoving = moving;
  }

  private place(x: number, z: number): void {
    Object.assign(this.b, { x, y: 0, z, vx: 0, vy: 0, vz: 0, spin: 0 });
    this.owner = 0;
  }

  /**
   * Oyuncular ve top: serbest topa en yakın oyuncu topu alır (göğüsle yumuşatma dahil); kafa hizasındaki
   * top kafayla karşılanır; topu tutanın üstüne basıp duran rakip topu serbest bırakır.
   */
  private players(dt: number, now: number): boolean {
    const b = this.b;
    let touched = false;
    let gain = 0, gainD = Infinity;
    for (const [sid, p] of this.room.players) {
      const prev = this.prev.get(sid);
      const vx = prev && dt > 0 ? (p.state.x - prev.x) / dt : 0;
      const vz = prev && dt > 0 ? (p.state.z - prev.z) / dt : 0;
      // Hız tik aralığında gürültülü: yumuşat
      const sx = prev ? prev.vx * 0.5 + vx * 0.5 : 0, sz = prev ? prev.vz * 0.5 + vz * 0.5 : 0;
      this.prev.set(sid, { x: p.state.x, z: p.state.z, vx: sx, vz: sz });
      if (p.info.spectator || this.resetAt) continue;
      const d = Math.hypot(b.x - p.state.x, b.z - p.state.z);
      if (this.owner) {
        // Gövdeyle kesme: rakip topun üstünde duruyorsa top bir süre sonra serbest kalır
        if (this.owner > 0 && sid !== this.owner && d < BLOCK_R) {
          const since = this.blockSince.get(sid) ?? now;
          this.blockSince.set(sid, since);
          if (now - since > BLOCK_MS) {
            this.release(this.owner, now);
            this.blockSince.clear();
            b.vx = -b.vx * 0.3;
            b.vz = -b.vz * 0.3;
            touched = true;
          }
        } else this.blockSince.delete(sid);
        continue;
      }
      if ((this.noGain.get(sid) ?? 0) > now) continue;
      if (b.y >= 1.0) {
        if (b.y < 2.3 && d < 0.6 && now - (this.lastKick.get(sid) ?? 0) > HEAD_COOLDOWN_MS) touched = this.header(sid, p.state.rot, now) || touched;
        continue;
      }
      // Göğüsle/ayakla kontrol: yavaş ya da orta hızdaki topu alır
      if (d < GAIN_R && Math.hypot(b.vx, b.vz) < GAIN_MAX_SPEED && d < gainD) {
        gain = sid;
        gainD = d;
      }
    }
    for (const sid of this.prev.keys()) if (!this.room.players.has(sid)) this.prev.delete(sid);
    if (gain) {
      this.owner = gain;
      this.blockSince.clear();
      this.touch(gain, now);
      touched = true;
    }
    return touched;
  }

  /** Top ayakta: sahibinin önünde, onun hızıyla (istemci aynı yeri kendi konumundan çizer). */
  private carry(now: number): void {
    const p = this.room.players.get(this.owner);
    const v = this.prev.get(this.owner);
    if (!p) {
      this.owner = 0;
      return;
    }
    const b = this.b;
    const x = p.state.x + Math.sin(p.state.rot) * DRIBBLE_AHEAD, z = p.state.z + Math.cos(p.state.rot) * DRIBBLE_AHEAD;
    // Sahibi ışınlandı/uzaklaştı (araç, oturma): top serbest kalır
    if (Math.hypot(x - b.x, z - b.z) > 3) {
      this.owner = 0;
      return;
    }
    b.x = x;
    b.z = z;
    b.y = 0;
    b.vx = v?.vx ?? 0;
    b.vz = v?.vz ?? 0;
    b.vy = 0;
    b.spin = 0;
    // Duvara sürülen top duvarda kalır; kale ağzından sürülürse gol
    this.lines(now);
  }

  private keeperCarry(): void {
    const k = this.keepers[this.owner === -1 ? 0 : 1];
    Object.assign(this.b, { x: k.x - k.side * 0.45, y: 1.0, z: k.z, vx: 0, vy: 0, vz: 0, spin: 0 });
  }

  /** Kafa: top oyuncunun baktığı yöne, gelen hızın bir kısmıyla ve hafif yukarı sekerek gider. */
  private header(sid: number, rot: number, now: number): boolean {
    const b = this.b;
    this.lastKick.set(sid, now);
    const speed = Math.hypot(b.vx, b.vz) * 0.55 + 4;
    b.vx = Math.sin(rot) * speed;
    b.vz = Math.cos(rot) * speed;
    b.vy = b.y > 1.6 ? 0.3 : 2.2;
    b.spin = 0;
    this.shotId++;
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
    if (!this.resetAt) this.saves(now);
    this.lines(now);
  }

  /** Çizgiler: kale ağzından geçen gol; geri kalan her yerde duvar (halı saha: top seker, oyun durmaz). */
  private lines(now: number): void {
    const b = this.b;
    const lx = b.x - PITCH.x, lz = b.z - PITCH.z;
    if (this.resetAt && Math.abs(lx) > PITCH.hx) {
      // Ağın içi: top ağın arkasında ve yanlarında kalır
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
      return;
    }
    // Yan duvarlar
    if (Math.abs(lz) > PITCH.hz - BALL_R) {
      b.z = PITCH.z + Math.sign(lz) * (PITCH.hz - BALL_R);
      b.vz = -b.vz * WALL_BOUNCE;
      b.spin *= -0.5;
    }
    if (Math.abs(lx) <= PITCH.hx - BALL_R) return;
    const inMouth = Math.abs(lz) < PITCH.goalHalf - BALL_R * 0.5 && b.y < PITCH.goalH - BALL_R;
    if (inMouth) {
      if (!this.resetAt && Math.abs(lx) > PITCH.hx + BALL_R) this.goal(lx < 0 ? 0 : 1, now);
      return;
    }
    // Kale çizgisinin geri kalanı: duvar
    b.x = PITCH.x + Math.sign(lx) * (PITCH.hx - BALL_R);
    b.vx = -b.vx * WALL_BOUNCE;
    b.spin *= -0.5;
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

  // ---------------------------------------------------------------------------
  // Kaleciler
  // ---------------------------------------------------------------------------

  private resetKeepers(): void {
    for (const k of this.keepers) {
      k.x = PITCH.x + k.side * (PITCH.hx - 0.6);
      k.z = PITCH.z;
      k.lean = 0;
      k.holdUntil = 0;
    }
  }

  /** Kaleci hareketi: şut geliyorsa topun kaleye varacağı yere plonjon, yakın serbest topa çıkış, yoksa açı kapatma. */
  private keeperTick(dt: number, now: number): void {
    const b = this.b;
    let active = false;
    for (const p of this.room.players.values()) if (Math.abs(p.state.x - PITCH.x) < PITCH.hx + 10 && Math.abs(p.state.z - PITCH.z) < PITCH.hz + 10) active = true;
    for (let i = 0; i < 2; i++) {
      const k = this.keepers[i];
      const s = k.side, gx = PITCH.x + s * PITCH.hx;
      const id = i === 0 ? -1 : -2;
      if (this.owner === id) {
        k.lean *= Math.exp(-dt * 6);
        if (now >= k.holdUntil) this.distribute(k, id, now);
        continue;
      }
      let tx: number, tz: number, speed = GK_SPEED;
      const towards = b.vx * s;
      const toLine = (gx - b.x) / (b.vx || 1e-6);
      if (!this.owner && towards > 3 && toLine > 0 && toLine < 1.6) {
        // Şut geliyor: topun kale çizgisine varacağı yer
        const zc = b.z + b.vz * toLine;
        tz = clamp(zc, PITCH.z - PITCH.goalHalf - 0.3, PITCH.z + PITCH.goalHalf + 0.3);
        tx = gx - s * 0.5;
        speed = toLine < 0.8 ? GK_DIVE_SPEED : GK_SPEED * 1.4;
      } else if (!this.owner && Math.abs(b.x - gx) < GK_BOX && Math.abs(b.z - PITCH.z) < GK_BOX + 0.8 && Math.hypot(b.vx, b.vz) < 7 && b.y < 1) {
        // Ceza alanındaki serbest topa çık
        tx = b.x;
        tz = b.z;
        speed = GK_SPEED * 1.2;
      } else {
        // Açı kapatma: topla kalenin ortası arasında, çizginin biraz önünde
        const dist = Math.hypot(b.x - gx, b.z - PITCH.z);
        tz = PITCH.z + clamp((b.z - PITCH.z) * 0.35, -(PITCH.goalHalf - 0.4), PITCH.goalHalf - 0.4);
        tx = gx - s * (0.6 + Math.min(1.4, (30 - Math.min(30, dist)) / 25));
        if (!active) [tx, tz] = [gx - s * 0.6, PITCH.z];
      }
      tx = clamp(tx, Math.min(gx, gx - s * GK_BOX), Math.max(gx, gx - s * GK_BOX));
      const dx = tx - k.x, dz = tz - k.z, d = Math.hypot(dx, dz);
      const stepLen = Math.min(d, speed * dt);
      if (d > 1e-4) {
        k.x += (dx / d) * stepLen;
        k.z += (dz / d) * stepLen;
      }
      // Plonjon: hızlı yana gidişte gövde yatar
      const lateral = d > 1e-4 ? (dz / d) * (stepLen / Math.max(dt, 1e-3)) : 0;
      const want = speed === GK_DIVE_SPEED ? clamp(lateral / GK_DIVE_SPEED, -1, 1) * -s : 0;
      k.lean += (want - k.lean) * Math.min(1, dt * 10);
    }
    if (active && now - this.lastGk > 66) {
      this.lastGk = now;
      this.room.broadcast({ t: "gk", k: this.gkState() });
    }
  }

  /**
   * Kurtarış: kaleci menzilindeki topu tutar ya da (sert şutta) çeler. Her şuta bir kez karar verir;
   * köşeye ve sert gelen şut daha zor kurtarılır (kaçırırsa aynı şutta tekrar denemez).
   */
  private saves(now: number): void {
    const b = this.b;
    if (this.owner) return;
    for (let i = 0; i < 2; i++) {
      const k = this.keepers[i];
      const id = i === 0 ? -1 : -2;
      if (k.decided === this.shotId || this.toucher === id) continue;
      const reach = GK_REACH + Math.abs(k.lean) * (GK_DIVE_REACH - GK_REACH);
      if (Math.hypot(b.x - k.x, b.z - k.z) > reach || b.y > 2.2) continue;
      k.decided = this.shotId;
      const speed = Math.hypot(b.vx, b.vz);
      const corner = Math.min(1, Math.abs(b.z - PITCH.z) / PITCH.goalHalf);
      const chance = clamp(1.3 - speed / 26 - corner * 0.35 - b.y * 0.08, 0.15, 0.97);
      if (this.random() > chance) continue;
      this.touch(id, now);
      if (speed > 16) {
        // Çelme: top kaleden uzağa, yana sekerek
        b.vx = -k.side * Math.max(3, Math.abs(b.vx) * 0.3);
        b.vz = (this.random() - 0.5) * 8;
        b.vy = 2.5;
        b.spin = 0;
      } else {
        this.owner = id;
        k.holdUntil = now + GK_HOLD_MS;
      }
      this.pendingEv = { ev: "save", by: id };
    }
  }

  /** Kaleci topu oyuna sokar: maçta takım arkadaşına, yoksa sahanın içine uzun vuruş. */
  private distribute(k: Keeper, id: number, now: number): void {
    const b = this.b;
    this.owner = 0;
    const team = k.side === -1 ? 0 : 1;
    let target: { x: number; z: number } | null = null;
    let best = Infinity;
    for (const [sid, p] of this.room.players) {
      if (p.info.spectator || (this.match && this.teamOf(sid) !== team)) continue;
      if (!this.match) continue;
      const d = Math.hypot(p.state.x - k.x, p.state.z - k.z);
      if (d > 4 && d < best) {
        best = d;
        target = { x: p.state.x, z: p.state.z };
      }
    }
    const tx = target?.x ?? PITCH.x - k.side * (4 + this.random() * 6), tz = target?.z ?? PITCH.z + (this.random() - 0.5) * PITCH.hz;
    const d = Math.hypot(tx - b.x, tz - b.z) || 1;
    const speed = Math.min(16, d * 0.9 + 3);
    b.x = k.x - k.side * 0.6;
    b.y = 0.4;
    b.vx = ((tx - b.x) / d) * speed;
    b.vz = ((tz - b.z) / d) * speed;
    b.vy = 3.2;
    this.shotId++;
    this.touch(id, now);
    this.pendingEv = { ev: "pass", by: id };
  }

  /** `side` 0: batıdaki kaleye gol (doğu/mavi takım sayar), 1: doğudakine (batı/kırmızı sayar). */
  private goal(side: 0 | 1, now: number): void {
    const scoring = side === 0 ? 1 : 0;
    this.score[scoring]++;
    this.resetAt = now + GOAL_RESET_MS;
    this.owner = 0;
    const sid = this.toucher > 0 ? this.toucher : 0;
    const name = this.room.players.get(sid)?.info.name ?? "Biri";
    // Maçta kendi kalesine atan sayılmaz (gol takıma yazılır, oyuncuya görev yok)
    const own = this.match && sid ? this.teamOf(sid) === side : false;
    const pt = this.prevToucher;
    const assistSid = !own && sid && pt.sid > 0 && pt.sid !== sid && now - pt.at < ASSIST_MS && (this.teamOf(pt.sid) ?? 0) === (this.teamOf(sid) ?? 0) ? pt.sid : 0;
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
    this.place(PITCH.x, PITCH.z);
    this.resetKeepers();
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
    this.noGain.delete(sid);
    this.lastTackle.delete(sid);
    this.blockSince.delete(sid);
    if (this.owner === sid) this.owner = 0;
    if (this.toucher === sid) this.toucher = 0;
    if (this.match) {
      const m = this.match;
      m.teams = [m.teams[0].filter((s) => s !== sid), m.teams[1].filter((s) => s !== sid)];
      this.room.broadcast({ t: "match", match: m });
    }
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
