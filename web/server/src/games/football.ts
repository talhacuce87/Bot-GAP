// Futbol: top sunucuda (tek otorite). Topa yaklaşan oyuncu topu alır ve önünde sürer (top ayağa bağlı);
// F'ye dokunmak pas, basılı tutmak şut, G aşırtma, yana basarak vurmak falso. Rakibin topuna F ile müdahale
// edilir. Kapalı halı saha: duvarlar oyunun içinde (taç/aut yok, top seker); iki yapay zekâ kaleci kaleyi
// korur. İki saha var: salondaki (serbest oyun) ve stadyum; "!maç" süreli takımlı maçı stadyumda oynatır
// (oyuncular oraya ışınlanır, bitince salona döner). Stadyumda çalım ve kayarak müdahale de var.
import type { BallEvent, BallState, KickKind, MatchState } from "../../../shared/protocol";
import { BALL_R, type Field, KICK_REACH, PITCH } from "../../../shared/zones";
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
/**
 * Ayakta müdahale: menzil ve önündeki açı (topa dönük olmalı). Başarılıysa top müdahale edenin ayağına
 * geçer (FIFA/PES gibi); kaptıran bir süre topu alamaz ve hemen geri müdahale edemez (karşılıklı kapışma,
 * top iki oyuncu arasında gidip gelmesin). Topu yeni kapan kısa süre korunur.
 */
const TACKLE_R = 1.5;
const TACKLE_CONE = 1.2;
const TACKLE_COOLDOWN_MS = 1000;
const LOSE_MS = 1200;
const STEAL_GUARD_MS = 600;
/** Rakip topun üstüne basıp duruyorsa top serbest kalır (gövde ile kesme). */
const BLOCK_R = 0.45;
const BLOCK_MS = 450;
/**
 * Kayarak müdahale anında karar vermez: kayış boyunca (SLIDE_MS) öne uzanan ayak topa değerse olur
 * (ayağın bu karede süpürdüğü yol topa SLIDE_HIT kadar yaklaşmalı). Önden/yandan çoğu zaman topu alır,
 * arkadan girilirse neredeyse hiç (gerçekte faul). Değmezse kayan bir süre yerde kalır (topu alamaz).
 */
const SLIDE_MS = 650;
const SLIDE_FOOT = 0.55;
const SLIDE_HIT = 0.6;
const SLIDE_COOLDOWN_MS = 1600;
const SLIDE_MISS_MS = 900;
/** Çalım (roulette) bu süre müdahaleye kapalı; çalım/rainbow arası bekleme. */
const SKILL_MS = 650;
const SKILL_COOLDOWN_MS = 1400;
/** Rainbow: top arkadan başın üstünden öne aşırtılır; yapan bu süre topu yeniden alamaz. */
const RAINBOW_VY = 5.4;
const RAINBOW_NOGAIN_MS = 750;

/** Kaleci: kale çizgisinin önünde, ceza alanında kalır. */
const GK_REACH = 0.7;
const GK_DIVE_REACH = 1.25;
const GK_SPEED = 4.2;
const GK_DIVE_SPEED = 7.5;
/** Büyük kalede (stadyum) kaleci kale genişliğiyle orantılı güçlenir; şut okuması da bu kadar iyileşir. */
const GK_READ_BONUS = 0.12;
/** Şut gelirken kalecinin tepki penceresi (top çizgiye bu kadar saniye kala harekete geçer). */
const GK_REACT_S = 2.2;
/** Uzaktan şut: topun kaleye varma süresi bunu aşınca okuma şansı hızla artar (bkz. GK_TIME_GAIN). */
const GK_TIME_FREE_S = 0.45;
/** Saniye başına en düşük okuma şansı artışı: ~1 sn yolda kalan şut neredeyse hep okunur. */
const GK_TIME_GAIN = 2.1;
const GK_HOLD_MS = 1100;
const GK_BOX = 4.5;
/** Şutu okuyamayan kaleci yerinde kalır (yalnızca bu hızla kayar). */
const GK_LATE_SPEED = 0.6;
/** Kalecinin kendi vuruşu/çelmesi bu süre ona geri dönmez. */
const GK_RETOUCH_MS = 400;

interface Keeper {
  side: -1 | 1;
  x: number;
  z: number;
  /** Plonjon (-1…1, + sağına doğru). */
  lean: number;
  holdUntil: number;
  /** Hangi şutu okudu (her şuta bir kez karar verir). */
  decided: number;
  /** Bu şutu okuyamadı: plonjon yok, yerinde kalır (gövdesine gelen top yine durur). */
  beaten: boolean;
  /** Son dokunuşu (kendi vuruşunu yeniden yakalamasın). */
  touchedAt: number;
  /** Topu ona getiren (maç yokken pas buna verilmez). */
  from: number;
}

export class Football {
  private b: { x: number; y: number; z: number; vx: number; vy: number; vz: number; spin: number };
  score: [number, number] = [0, 0];
  private prev = new Map<number, { x: number; z: number; vx: number; vz: number }>();
  private lastKick = new Map<number, number>();
  /** Topu alamaz (vurdu, kaptırdı, müdahalesi boşa çıktı) şu ana kadar. */
  private noGain = new Map<number, number>();
  private lastTackle = new Map<number, number>();
  private blockSince = new Map<number, number>();
  /** Müdahaleye ve gövdeyle kesmeye kapalı (çalımda, topu yeni kapınca) şu ana kadar; son çalım anı. */
  private guard = new Map<number, number>();
  private lastSkill = new Map<number, number>();
  /** Süren kaymalar: bitiş, yön, başladığı yer ve ayağın son yeri. */
  private slides = new Map<number, { until: number; dx: number; dz: number; sx: number; sz: number; fx: number; fz: number }>();
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
  private pendingEv: { ev: BallEvent; by: number; side?: -1 | 1 } | null = null;
  /** Her vuruşta artar: kaleci her şuta bir kez karar verir. */
  private shotId = 0;
  private keepers: Keeper[];
  /** Kaleci gücü: kale salondakinden büyükse menzil/hız oranla artar. */
  private gk: { reach: number; dive: number; speed: number; diveSpeed: number; read: number };
  private lastGk = 0;
  /** Kalecinin kararı için rastgele (testte sabitlenir). */
  random: () => number = Math.random;
  /** Mesajlarda sahanın etiketi (stadyum `f: 1`). */
  private tag: { f?: 1 };

  /**
   * `f`: saha ölçüleri; `stadium`: maçlar burada oynanır (`home`: maç bitince oyuncuların döndüğü saha).
   */
  constructor(
    private room: Room,
    private report: (sid: number, event: string) => void,
    readonly f: Field = PITCH,
    private stadium: { home: Field } | null = null,
  ) {
    this.b = { x: f.x, y: 0, z: f.z, vx: 0, vy: 0, vz: 0, spin: 0 };
    this.keepers = [-1, 1].map((side) => ({ side: side as -1 | 1, x: f.x + side * (f.hx - 0.6), z: f.z, lean: 0, holdUntil: 0, decided: -1, beaten: false, touchedAt: 0, from: 0 }));
    this.tag = stadium ? { f: 1 } : {};
    const g = Math.max(1, f.goalHalf / PITCH.goalHalf);
    this.gk = { reach: GK_REACH * g, dive: GK_DIVE_REACH * g, speed: GK_SPEED * g, diveSpeed: GK_DIVE_SPEED * g, read: g > 1 ? GK_READ_BONUS : 0 };
  }

  state(now: number): BallState {
    const b = this.b;
    return { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, at: now, spin: b.spin, ...(this.owner ? { owner: this.owner } : {}), ...this.tag };
  }

  sendTo(conn: Conn, now = Date.now()): void {
    this.room.sendTo(conn, { t: "ball", ...this.state(now) });
    this.room.sendTo(conn, { t: "score", score: this.score, ...this.tag });
    this.room.sendTo(conn, { t: "gk", k: this.gkState(), ...this.tag });
    if (this.match) this.room.sendTo(conn, { t: "match", match: this.match });
  }

  /** Oyuncu bu sahada ya da kenarında mı (vuruş/müdahale mesajları buna gelir). */
  near(x: number, z: number): boolean {
    return this.nearPitch(x, z);
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
    if (kind !== "shot" && kind !== "pass" && kind !== "lob" && kind !== "power") return;
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
    } else if (kind === "power") {
      // Power şut: çok sert ve alçak, falsosuz; tam güçte biraz daha sapar
      speed = 12 + 20 * k;
      b.vy = 0.3 + 2.4 * k;
      b.spin = 0;
      dir += (this.random() - 0.5) * 0.16 * k * k;
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

  /**
   * Müdahale: ayakta, önündeki (topa dönük, menzilde) rakip topuna; başarılıysa top müdahale edenin ayağına
   * geçer. `slide`: koşarken kayarak: karar kayış boyunca, ayak topa değerse (slideTick). Çalım yapan ya da
   * topu yeni kapan o an müdahaleye kapalı; maçta takım arkadaşına girilmez.
   */
  tackle(sid: number, now = Date.now(), slide = false): void {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator || this.owner === sid || this.resetAt) return;
    if (now - (this.lastTackle.get(sid) ?? 0) < (slide ? SLIDE_COOLDOWN_MS : TACKLE_COOLDOWN_MS)) return;
    if (slide) {
      // Kayış görünür (yere yatar); topa değip değmediğine kayış boyunca bakılır
      this.lastTackle.set(sid, now);
      const dx = Math.sin(p.state.rot), dz = Math.cos(p.state.rot);
      this.slides.set(sid, { until: now + SLIDE_MS, dx, dz, sx: p.state.x, sz: p.state.z, fx: p.state.x + dx * SLIDE_FOOT, fz: p.state.z + dz * SLIDE_FOOT });
      this.pendingEv = { ev: "slide", by: sid };
      this.broadcast(now);
      this.slideTick(now);
      return;
    }
    const b = this.b;
    const o = this.rivalOwner(sid);
    if (!o) return;
    const dx = b.x - p.state.x, dz = b.z - p.state.z;
    if (Math.hypot(dx, dz) > TACKLE_R || angleOff(Math.atan2(dx, dz), p.state.rot) > TACKLE_CONE) return;
    this.lastTackle.set(sid, now);
    // Önden müdahale daha kolay; arkadan girilirse çoğu zaman boşa çıkar
    const front = (p.state.x - o.state.x) * Math.sin(o.state.rot) + (p.state.z - o.state.z) * Math.cos(o.state.rot) >= 0;
    if ((this.guard.get(this.owner) ?? 0) <= now && this.random() < (front ? 0.62 : 0.32)) {
      this.steal(sid, now);
      this.noGain.delete(sid);
    } else this.noGain.set(sid, now + 900);
    this.pendingEv = { ev: "tackle", by: sid };
    this.broadcast(now);
  }

  /** Topun sahibi, `sid`'in rakibiyse (maçta takım arkadaşı ve kaleciler değil). */
  private rivalOwner(sid: number): { state: { x: number; z: number; rot: number } } | undefined {
    if (this.owner <= 0 || this.owner === sid || (this.match && this.teamOf(sid) === this.teamOf(this.owner))) return undefined;
    return this.room.players.get(this.owner);
  }

  /** Top `sid`'e geçer (müdahale, gövdeyle kesme): kaptıran bir süre alamaz ve geri müdahale edemez. */
  private steal(sid: number, now: number): void {
    const victim = this.owner;
    this.release(victim, now);
    this.noGain.set(victim, now + LOSE_MS);
    this.lastTackle.set(victim, now);
    this.slides.delete(victim);
    this.owner = sid;
    this.guard.set(sid, now + STEAL_GUARD_MS);
    this.blockSince.clear();
    this.touch(sid, now);
  }

  /**
   * Süren kaymalar: öne uzanan ayağın bu karede süpürdüğü yol topa değerse rakibin topu (önden/yandan
   * çoğunlukla, arkadan nadiren) ya da serbest top kayış yönüne itilir. Kayış biterse yerde kalır.
   */
  private slideTick(now: number): void {
    const b = this.b;
    for (const [sid, s] of this.slides) {
      const p = this.room.players.get(sid);
      if (!p) {
        this.slides.delete(sid);
        continue;
      }
      const fx = p.state.x + s.dx * SLIDE_FOOT, fz = p.state.z + s.dz * SLIDE_FOOT;
      const hit = !this.resetAt && b.y < 0.5 && segDist(b.x, b.z, s.fx, s.fz, fx, fz) <= SLIDE_HIT;
      s.fx = fx;
      s.fz = fz;
      if (hit && this.owner > 0 && this.owner !== sid) {
        const o = this.rivalOwner(sid);
        // Takım arkadaşının topunun üstünden kayar
        if (!o) continue;
        this.slides.delete(sid);
        // Arkadan: kayış yönü sahibinin baktığı yönle aynı ve kayış onun arkasından başladı
        const of = { x: Math.sin(o.state.rot), z: Math.cos(o.state.rot) };
        const behind = s.dx * of.x + s.dz * of.z > 0.5 && (s.sx - o.state.x) * of.x + (s.sz - o.state.z) * of.z < 0;
        if ((this.guard.get(this.owner) ?? 0) <= now && this.random() < (behind ? 0.12 : 0.85)) {
          const victim = this.owner;
          this.release(victim, now);
          this.noGain.set(victim, now + LOSE_MS);
          this.lastTackle.set(victim, now);
          this.poke(s.dx, s.dz, 5);
          this.touch(sid, now);
          this.noGain.set(sid, now + 300);
          this.pendingEv = { ev: "tackle", by: sid };
        } else this.noGain.set(sid, now + SLIDE_MISS_MS);
        continue;
      }
      if (hit && !this.owner) {
        // Serbest top: kayarak uzaklaştırır
        this.slides.delete(sid);
        this.poke(s.dx, s.dz, 7);
        this.shotId++;
        this.touch(sid, now);
        this.noGain.set(sid, now + 300);
        this.pendingEv = { ev: "tackle", by: sid };
        continue;
      }
      if (now >= s.until) {
        this.slides.delete(sid);
        this.noGain.set(sid, Math.max(this.noGain.get(sid) ?? 0, now + SLIDE_MISS_MS));
      }
    }
  }

  private poke(dx: number, dz: number, speed: number): void {
    const b = this.b;
    b.vx = dx * speed;
    b.vz = dz * speed;
    b.vy = 0.5;
    b.spin = 0;
  }

  /**
   * Çalım (roulette): top ayaktayken; kısa süre müdahaleye ve gövdeyle kesmeye kapalı. `side` topun döndüğü
   * yan (1 sağ, -1 sol): istemci oyuncuyu o yana çapraz atar, topu yanından yarım daire çizdirir.
   */
  skill(sid: number, now = Date.now(), side: -1 | 1 = 1): void {
    if (this.owner !== sid || this.resetAt) return;
    if (now - (this.lastSkill.get(sid) ?? 0) < SKILL_COOLDOWN_MS) return;
    this.lastSkill.set(sid, now);
    this.guard.set(sid, now + SKILL_MS);
    this.blockSince.clear();
    this.pendingEv = { ev: "skill", by: sid, side };
    this.broadcast(now);
  }

  /**
   * Rainbow: topu topukla arkadan başının üstünden öne aşırtır (koşu hızından biraz hızlı, önüne düşer).
   * Top havadayken rakip kafayla ya da düştüğü yerde alabilir.
   */
  rainbow(sid: number, now = Date.now()): void {
    const p = this.room.players.get(sid);
    if (!p || this.owner !== sid || this.resetAt) return;
    if (now - (this.lastSkill.get(sid) ?? 0) < SKILL_COOLDOWN_MS) return;
    this.lastSkill.set(sid, now);
    this.release(sid, now);
    this.noGain.set(sid, now + RAINBOW_NOGAIN_MS);
    const b = this.b, dx = Math.sin(p.state.rot), dz = Math.cos(p.state.rot);
    const v = this.prev.get(sid);
    const run = v ? Math.max(0, v.vx * dx + v.vz * dz) : 0;
    const speed = clamp(run + 2.5, 4, 9.5);
    Object.assign(b, { x: p.state.x - dx * 0.25, y: 0.25, z: p.state.z - dz * 0.25, vx: dx * speed, vy: RAINBOW_VY, vz: dz * speed, spin: 0 });
    this.shotId++;
    this.touch(sid, now);
    this.pendingEv = { ev: "rainbow", by: sid };
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
    this.room.broadcast({ t: "ball", ...this.state(now), ...(ev ? { ev: ev.ev, by: ev.by, ...(ev.side ? { side: ev.side } : {}) } : {}) });
  }

  tick(now: number): void {
    const dt = Math.max(0, Math.min(0.2, (now - this.last) / 1000));
    this.last = now;
    if (!this.match && this.lastTouch && now - this.lastTouch > IDLE_RESET_MS && (this.score[0] || this.score[1])) {
      this.score = [0, 0];
      this.lastTouch = 0;
      this.room.broadcast({ t: "score", score: this.score, ...this.tag });
    }
    if (this.match) this.matchTick(now);
    if (this.resetAt && now >= this.resetAt) {
      this.place(this.f.x, this.f.z);
      this.resetAt = 0;
      this.resetKeepers();
      this.broadcast(now);
    }
    let touched = this.players(dt, now);
    if (this.slides.size) {
      const owner = this.owner;
      this.slideTick(now);
      touched ||= owner !== this.owner;
    }
    if (this.owner > 0) {
      this.carry(now);
      // Kaleciye sürülen top da geçmez
      if (this.owner > 0 && !this.resetAt) this.saves(now, this.b.x, this.b.z);
    } else if (this.owner < 0) this.keeperCarry();
    else {
      const h = dt / SUBSTEPS;
      // Kaleci tuttuysa top kalan adımlarda yoluna devam etmez
      for (let i = 0; i < SUBSTEPS && !this.owner; i++) this.step(h, now);
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
        // Gövdeyle kesme: rakip topun üstünde duruyorsa bir süre sonra top ona geçer (kaptıran hemen geri alamaz)
        if (this.owner > 0 && sid !== this.owner && d < BLOCK_R && (this.guard.get(this.owner) ?? 0) <= now && (this.noGain.get(sid) ?? 0) <= now && this.rivalOwner(sid)) {
          const since = this.blockSince.get(sid) ?? now;
          this.blockSince.set(sid, since);
          if (now - since > BLOCK_MS) {
            this.steal(sid, now);
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
    const px = b.x, pz = b.z;
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
    if (!this.resetAt) this.saves(now, px, pz);
    this.lines(now);
  }

  /** Çizgiler: kale ağzından geçen gol; geri kalan her yerde duvar (halı saha: top seker, oyun durmaz). */
  private lines(now: number): void {
    const b = this.b;
    const lx = b.x - this.f.x, lz = b.z - this.f.z;
    if (this.resetAt && Math.abs(lx) > this.f.hx) {
      // Ağın içi: top ağın arkasında ve yanlarında kalır
      if (Math.abs(lx) > this.f.hx + 1.1) {
        b.x = this.f.x + Math.sign(lx) * (this.f.hx + 1.1);
        b.vx = -b.vx * 0.15;
      }
      if (Math.abs(lz) > this.f.goalHalf - BALL_R) {
        b.z = this.f.z + Math.sign(lz) * (this.f.goalHalf - BALL_R);
        b.vz = -b.vz * 0.2;
      }
      if (b.y > this.f.goalH - BALL_R) {
        b.y = this.f.goalH - BALL_R;
        b.vy = -Math.abs(b.vy) * 0.3;
      }
      b.spin = 0;
      return;
    }
    // Yan duvarlar (stadyumda panolar taç çizgisinin biraz dışında)
    const wz = this.f.hz + (this.f.sidePad ?? 0) - BALL_R;
    if (Math.abs(lz) > wz) {
      b.z = this.f.z + Math.sign(lz) * wz;
      b.vz = -b.vz * WALL_BOUNCE;
      b.spin *= -0.5;
    }
    if (Math.abs(lx) <= this.f.hx - BALL_R) return;
    const inMouth = Math.abs(lz) < this.f.goalHalf - BALL_R * 0.5 && b.y < this.f.goalH - BALL_R;
    if (inMouth) {
      if (!this.resetAt && Math.abs(lx) > this.f.hx + BALL_R) this.goal(lx < 0 ? 0 : 1, now);
      return;
    }
    // Kale çizgisinin geri kalanı: duvar
    b.x = this.f.x + Math.sign(lx) * (this.f.hx - BALL_R);
    b.vx = -b.vx * WALL_BOUNCE;
    b.spin *= -0.5;
  }

  /** Direkler ve üst direk: top çarparsa seker ("tak" sesi). */
  private posts(): void {
    const b = this.b;
    for (const side of [-1, 1]) {
      const gx = this.f.x + side * this.f.hx;
      if (Math.abs(b.x - gx) > 1) continue;
      if (b.y < this.f.goalH + BALL_R) {
        for (const sz of [-1, 1]) {
          const pz = this.f.z + sz * this.f.goalHalf;
          const dx = b.x - gx, dz = b.z - pz, d = Math.hypot(dx, dz);
          if (d < BALL_R + POST_R && d > 1e-4) this.bounceOff(dx / d, 0, dz / d, gx + (dx / d) * (BALL_R + POST_R), b.y, pz + (dz / d) * (BALL_R + POST_R), "post");
        }
      }
      // Üst direk: x–y düzleminde silindir
      if (Math.abs(b.z - this.f.z) < this.f.goalHalf) {
        const dx = b.x - gx, dy = b.y + BALL_R - this.f.goalH, d = Math.hypot(dx, dy);
        if (d < BALL_R + POST_R && d > 1e-4) this.bounceOff(dx / d, dy / d, 0, gx + (dx / d) * (BALL_R + POST_R), this.f.goalH - BALL_R + (dy / d) * (BALL_R + POST_R), b.z, "bar");
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
      k.x = this.f.x + k.side * (this.f.hx - 0.6);
      k.z = this.f.z;
      k.lean = 0;
      k.holdUntil = 0;
      k.beaten = false;
    }
  }

  /** Kaleci hareketi: şut geliyorsa topun kaleye varacağı yere plonjon, yakın serbest topa çıkış, yoksa açı kapatma. */
  private keeperTick(dt: number, now: number): void {
    const b = this.b;
    let active = false;
    for (const p of this.room.players.values()) if (Math.abs(p.state.x - this.f.x) < this.f.hx + 10 && Math.abs(p.state.z - this.f.z) < this.f.hz + 10) active = true;
    for (let i = 0; i < 2; i++) {
      const k = this.keepers[i];
      const s = k.side, gx = this.f.x + s * this.f.hx;
      const id = i === 0 ? -1 : -2;
      if (this.owner === id) {
        k.lean *= Math.exp(-dt * 6);
        if (now >= k.holdUntil) this.distribute(k, id, now);
        continue;
      }
      let tx: number, tz: number, speed = this.gk.speed;
      const towards = b.vx * s;
      const toLine = (gx - b.x) / (b.vx || 1e-6);
      if (!this.owner && towards > 3 && toLine > 0 && toLine < GK_REACT_S) {
        // Şut geliyor: topun kale çizgisine varacağı yer
        const zc = b.z + b.vz * toLine;
        if (k.decided !== this.shotId) {
          // Her şuta bir kez: köşeye ve sert gelen şutu okumak zor
          k.decided = this.shotId;
          const corner = Math.min(1, Math.abs(zc - this.f.z) / this.f.goalHalf);
          // Uzaktan gelen şut (topun yolda geçireceği süre) ne kadar sert olsa da okunur
          const floor = clamp((toLine - GK_TIME_FREE_S) * GK_TIME_GAIN, 0, 0.97);
          const chance = clamp(Math.max(floor, 1.3 + this.gk.read - Math.hypot(b.vx, b.vz) / 26 - corner * 0.35 - b.y * 0.08), 0.15, 0.97);
          k.beaten = this.random() > chance;
        }
        tz = clamp(zc, this.f.z - this.f.goalHalf - 0.3, this.f.z + this.f.goalHalf + 0.3);
        tx = gx - s * 0.5;
        speed = k.beaten ? GK_LATE_SPEED : toLine < 0.8 ? this.gk.diveSpeed : this.gk.speed * 1.4;
      } else if (!this.owner && Math.abs(b.x - gx) < GK_BOX && Math.abs(b.z - this.f.z) < GK_BOX + 0.8 && Math.hypot(b.vx, b.vz) < 7 && b.y < 1) {
        // Ceza alanındaki serbest topa çık
        tx = b.x;
        tz = b.z;
        speed = this.gk.speed * 1.2;
      } else {
        // Açı kapatma: topla kalenin ortası arasında, çizginin biraz önünde
        const dist = Math.hypot(b.x - gx, b.z - this.f.z);
        tz = this.f.z + clamp((b.z - this.f.z) * 0.5, -(this.f.goalHalf - 0.4), this.f.goalHalf - 0.4);
        tx = gx - s * (0.6 + Math.min(1.4, (30 - Math.min(30, dist)) / 25));
        if (!active) [tx, tz] = [gx - s * 0.6, this.f.z];
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
      const want = speed === this.gk.diveSpeed ? clamp(lateral / this.gk.diveSpeed, -1, 1) * -s : 0;
      k.lean += (want - k.lean) * Math.min(1, dt * 10);
    }
    if (active && now - this.lastGk > 66) {
      this.lastGk = now;
      this.room.broadcast({ t: "gk", k: this.gkState(), ...this.tag });
    }
  }

  /**
   * Kurtarış: kalecinin menzilinden top hiçbir şekilde geçemez. Bu karede topun gittiği yol (px,pz → top)
   * kaleciye değiyorsa tutar ya da (sert şutta) çeler; ayakta sürülen topu da alır. Şans yalnızca
   * kalecinin şutu okuyup oraya yetişmesinde (keeperTick).
   */
  private saves(now: number, px: number, pz: number): void {
    const b = this.b;
    if (this.owner < 0 || b.y > this.f.goalH) return;
    for (let i = 0; i < 2; i++) {
      const k = this.keepers[i];
      const id = i === 0 ? -1 : -2;
      if (now - k.touchedAt < GK_RETOUCH_MS) continue;
      // Maçta kendi takımının sürdüğü topu almaz
      if (this.owner > 0 && this.match && this.teamOf(this.owner) === (k.side === -1 ? 0 : 1)) continue;
      const reach = this.gk.reach + Math.abs(k.lean) * (this.gk.dive - this.gk.reach);
      if (segDist(k.x, k.z, px, pz, b.x, b.z) > reach + BALL_R) continue;
      const from = this.owner > 0 ? this.owner : this.toucher;
      if (this.owner > 0) this.release(this.owner, now);
      const speed = Math.hypot(b.vx, b.vz);
      // Top kalecinin önünde kalır (içinden geçmiş olamaz)
      b.x = k.x - k.side * Math.min(reach, 0.45);
      b.z = clamp(b.z, k.z - reach, k.z + reach);
      this.touch(id, now);
      k.touchedAt = now;
      k.from = from;
      if (speed > 16 && b.y > 0.15) {
        // Çelme: top kaleden uzağa, yana sekerek
        b.vx = -k.side * Math.max(3, Math.abs(b.vx) * 0.3);
        b.vz = (this.random() - 0.5) * 8;
        b.vy = 2.5;
        b.spin = 0;
      } else {
        this.owner = id;
        k.holdUntil = now + GK_HOLD_MS;
        this.keeperCarry();
      }
      this.shotId++;
      this.pendingEv = { ev: "save", by: id };
      return;
    }
  }

  /**
   * Kaleci topu oyuna sokar: önce takım arkadaşına, en boşta olana (yanında ya da pas yolunda rakip
   * olmayan, makul uzaklıktaki), koşusunun önüne; yakındaysa yerden, uzaksa havadan. Maç yokken topu ona
   * getiren dışında herkes arkadaş sayılır. Kimse yoksa sahanın içine uzun vuruş.
   */
  private distribute(k: Keeper, id: number, now: number): void {
    const b = this.b;
    this.owner = 0;
    const team = k.side === -1 ? 0 : 1;
    const mates: { x: number; z: number; vx: number; vz: number }[] = [];
    const rivals: { x: number; z: number }[] = [];
    for (const [sid, p] of this.room.players) {
      if (p.info.spectator) continue;
      if (this.match ? this.teamOf(sid) !== team : sid === k.from) {
        rivals.push({ x: p.state.x, z: p.state.z });
        continue;
      }
      if (!this.nearPitch(p.state.x, p.state.z)) continue;
      const v = this.prev.get(sid);
      mates.push({ x: p.state.x, z: p.state.z, vx: v?.vx ?? 0, vz: v?.vz ?? 0 });
    }
    const sx = k.x - k.side * 0.6, sz = k.z;
    let target: (typeof mates)[number] | null = null;
    let best = Infinity;
    for (const m of mates) {
      const d = Math.hypot(m.x - sx, m.z - sz);
      if (d < 2.5 || d > 32) continue;
      let score = Math.abs(d - 10) * 0.2;
      for (const r of rivals) {
        if (Math.hypot(r.x - m.x, r.z - m.z) < 2.5) score += 4;
        if (segDist(r.x, r.z, sx, sz, m.x, m.z) < 1.5) score += 6;
      }
      if (score < best) {
        best = score;
        target = m;
      }
    }
    let tx: number, tz: number;
    if (target) {
      // Koşusunun önüne: varış süresi kadar ilerisi
      const t = Math.hypot(target.x - sx, target.z - sz) / 12;
      tx = clamp(target.x + target.vx * t, this.f.x - this.f.hx + 1, this.f.x + this.f.hx - 1);
      tz = clamp(target.z + target.vz * t, this.f.z - this.f.hz + 1, this.f.z + this.f.hz - 1);
    } else {
      tx = this.f.x - k.side * (4 + this.random() * 6);
      tz = this.f.z + (this.random() - 0.5) * this.f.hz;
    }
    const d = Math.hypot(tx - sx, tz - sz) || 1;
    let speed: number;
    b.x = sx;
    b.z = sz;
    b.spin = 0;
    if (target && d <= 14) {
      // Yerden pas
      speed = Math.min(17, d * 1.1 + 2);
      b.y = 0;
      b.vy = 0;
    } else {
      // Havadan: hedefin yanına düşen yay
      speed = Math.min(16, d * 0.9 + 3);
      b.y = 0.4;
      b.vy = Math.min(7, (GRAVITY * d) / (2 * speed));
    }
    b.vx = ((tx - sx) / d) * speed;
    b.vz = ((tz - sz) / d) * speed;
    this.shotId++;
    this.touch(id, now);
    k.touchedAt = now;
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
    this.room.broadcast({ t: "goal", side, sid, name, score: this.score, ...(assist ? { assist } : {}), ...(own ? { own } : {}), ...this.tag });
    if (sid && !own) this.report(sid, "goal");
    this.toucher = 0;
    this.prevToucher = { sid: 0, at: 0 };
  }

  // ---------------------------------------------------------------------------
  // Maç
  // ---------------------------------------------------------------------------

  /**
   * Süreli maç başlatır: sahadakiler (ve kenarındakiler) bulundukları yarıya göre takımlara ayrılır,
   * skor sıfırlanır, top ortaya konur. Stadyumda salondaki sahadakiler de katılır ve herkes stadyumda
   * kendi yarısına ışınlanır. Hata metni ya da null.
   */
  startMatch(minutes: number, now = Date.now()): string | null {
    if (this.match) return "⚽ Zaten bir maç sürüyor.";
    const m = Math.round(Math.max(MATCH_MINUTES[0], Math.min(MATCH_MINUTES[2], Number.isFinite(minutes) ? minutes : MATCH_MINUTES[1])));
    const home = this.stadium?.home;
    const teams: [number[], number[]] = [[], []];
    for (const [sid, p] of this.room.players) {
      if (p.info.spectator || p.info.jailed) continue;
      const { x, z } = p.state;
      if (this.nearPitch(x, z)) teams[x < this.f.x ? 0 : 1].push(sid);
      else if (home && nearField(home, x, z)) teams[x < home.x ? 0 : 1].push(sid);
    }
    if (teams[0].length + teams[1].length < 2) return "⚽ Maç için sahada en az iki kişi olmalı.";
    // Tek yarıda toplandılarsa dengele
    while (Math.abs(teams[0].length - teams[1].length) > 1) {
      const [from, to] = teams[0].length > teams[1].length ? [teams[0], teams[1]] : [teams[1], teams[0]];
      to.push(from.pop()!);
    }
    this.match = { endsAt: now + m * 60_000, teams };
    this.score = [0, 0];
    this.place(this.f.x, this.f.z);
    this.resetKeepers();
    this.resetAt = now + GOAL_RESET_MS;
    if (home) teams.forEach((list, t) => list.forEach((sid, i) => this.toHalf(sid, t as 0 | 1, i, list.length, now)));
    this.room.broadcast({ t: "score", score: this.score, ...this.tag });
    this.room.broadcast({ t: "match", match: this.match });
    this.broadcast(now);
    return null;
  }

  /** Stadyumda takımın yarısına diziliş: kendi yarısında, ortaya bakar. */
  private toHalf(sid: number, team: 0 | 1, i: number, n: number, now: number): void {
    const s = team === 0 ? -1 : 1, f = this.f;
    const x = f.x + s * f.hx * (i % 2 ? 0.55 : 0.28);
    const z = f.z + clamp((i - (n - 1) / 2) * 5, -(f.hz - 2), f.hz - 2);
    this.room.moveTo(sid, x, z, team === 0 ? Math.PI / 2 : -Math.PI / 2, now);
  }

  /** Stadyumdan salondaki sahaya: orta çizginin yanına sıra sıra. */
  private sendHome(sids: number[], now: number): void {
    const home = this.stadium?.home;
    if (!home) return;
    sids.forEach((sid, i) => this.room.moveTo(sid, home.x + ((i % 8) - 3.5) * 1.6, home.z - 4 - Math.floor(i / 8) * 1.6, Math.PI, now));
  }

  /** Süren maça katıl: az kişili takıma girer, stadyumda kendi yarısına ışınlanır. Hata metni ya da null. */
  joinMatch(sid: number, now = Date.now()): string | null {
    const m = this.match, p = this.room.players.get(sid);
    if (!m || !p) return "⚽ Süren bir maç yok. Sahada !maç yazarak başlat.";
    if (p.info.spectator || p.info.jailed) return "⚽ Şu an maça katılamazsın.";
    let team = this.teamOf(sid);
    if (team === null) {
      team = m.teams[0].length <= m.teams[1].length ? 0 : 1;
      m.teams[team].push(sid);
      this.room.broadcast({ t: "match", match: m });
    }
    if (this.stadium) this.toHalf(sid, team, m.teams[team].indexOf(sid), m.teams[team].length, now);
    return null;
  }

  /** Maçtan ayrıl: takımdan çıkar, salona döner. */
  leaveMatch(sid: number, now = Date.now()): boolean {
    const m = this.match;
    if (!m || this.teamOf(sid) === null) return false;
    m.teams = [m.teams[0].filter((s) => s !== sid), m.teams[1].filter((s) => s !== sid)];
    if (this.owner === sid) this.owner = 0;
    this.room.broadcast({ t: "match", match: m });
    this.sendHome([sid], now);
    return true;
  }

  /** Takım değiştir (stadyumda B menüsü): maçta değilse o takıma katılır; kendi yarısına ışınlanır. Hata metni ya da null. */
  switchTeam(sid: number, team: 0 | 1, now = Date.now()): string | null {
    const m = this.match, p = this.room.players.get(sid);
    if (!m || !p) return "⚽ Süren bir maç yok. Menüden maç başlatabilirsin.";
    if (p.info.spectator || p.info.jailed) return "⚽ Şu an maça katılamazsın.";
    if (this.teamOf(sid) === team) return `⚽ Zaten ${team ? "🔵 Mavi" : "🔴 Kırmızı"} takımdasın.`;
    m.teams = [m.teams[0].filter((s) => s !== sid), m.teams[1].filter((s) => s !== sid)];
    m.teams[team].push(sid);
    if (this.owner === sid) this.release(sid, now);
    this.room.broadcast({ t: "match", match: m });
    if (this.stadium) this.toHalf(sid, team, m.teams[team].length - 1, m.teams[team].length, now);
    return null;
  }

  /** Stadyumdan dünyaya dön: maçtaysa maçtan ayrılır; her durumda salondaki sahaya ışınlanır. */
  goHome(sid: number, now = Date.now()): void {
    const p = this.room.players.get(sid);
    if (!this.stadium || !p || !this.nearPitch(p.state.x, p.state.z)) return;
    if (!this.leaveMatch(sid, now)) {
      if (this.owner === sid) this.release(sid, now);
      this.sendHome([sid], now);
    }
  }

  private nearPitch(x: number, z: number): boolean {
    return nearField(this.f, x, z);
  }

  private matchTick(now: number): void {
    const m = this.match!;
    // Salonda: sonradan sahaya gelen az kişili takıma katılır (stadyuma !maç katıl ile gelinir)
    if (!this.stadium) {
      for (const [sid, p] of this.room.players) {
        if (p.info.spectator || this.teamOf(sid) !== null || !this.nearPitch(p.state.x, p.state.z)) continue;
        m.teams[m.teams[0].length <= m.teams[1].length ? 0 : 1].push(sid);
        this.room.broadcast({ t: "match", match: m });
      }
    }
    if (now < m.endsAt) return;
    const [r, bl] = this.score;
    const text = r === bl ? `⚽ Maç bitti: ${r} – ${bl}, berabere!` : `⚽ Maç bitti: 🔴 ${r} – ${bl} 🔵 · ${r > bl ? "Kırmızı" : "Mavi"} takım kazandı!`;
    this.room.say({ kind: "system", sid: 0, name: "Bot GAP", text, at: now }, CHAT_HISTORY);
    if (r !== bl) for (const sid of m.teams[r > bl ? 0 : 1]) if (this.room.players.has(sid)) this.report(sid, "match_win");
    this.match = null;
    this.room.broadcast({ t: "match", match: null });
    // Stadyumda kim varsa (takımlar ve sonradan gelenler) salona döner
    const here = [...this.room.players].filter(([, p]) => !p.info.spectator && this.nearPitch(p.state.x, p.state.z)).map(([sid]) => sid);
    this.sendHome(here, now);
    this.owner = 0;
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
    this.guard.delete(sid);
    this.lastSkill.delete(sid);
    this.slides.delete(sid);
    if (this.owner === sid) this.owner = 0;
    if (this.toucher === sid) this.toucher = 0;
    if (this.match) {
      const m = this.match;
      m.teams = [m.teams[0].filter((s) => s !== sid), m.teams[1].filter((s) => s !== sid)];
      this.room.broadcast({ t: "match", match: m });
    }
  }
}

/** Sahada ya da kenarında (4 m içinde). */
function nearField(f: Field, x: number, z: number): boolean {
  return Math.abs(x - f.x) < f.hx + 4 && Math.abs(z - f.z) < f.hz + 4;
}

/** (px,pz) noktasının (ax,az)–(bx,bz) doğru parçasına uzaklığı. */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz;
  const t = l > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / l, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** İki yön arasındaki açı farkı (0–π). */
function angleOff(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
