// Voleybol salonu (Volleyball 4.2 tarzı): top sunucuda (tek otorite). Menüden salona ışınlanılır; maç yokken
// serbest antrenman (G ile kendi topunu çağırıp kendine at, V ile servis dene; çağrılan top yere düşüp çağıran 3 sn
// dokunmayınca kaybolur), oyuncular sahadaki altı pozisyondan birini seçer,
// maç başlayınca rally usulü: servis, en fazla üç dokunuş, aynı oyuncu üst üste dokunamaz (blok sayılmaz), top
// yere değince sayı. Vuruşlar gecikme telafili: oyuncunun bastığı anda gördüğü top konumu (son ~450 ms'lik
// geçmişte) kontrol edilir ve top oradan fırlatılır. Havada A/D ile yana, W/S ile öne/geri yatan oyuncunun
// menzili o yana kayar (öne yatan yakına, geri yatan uzağa vurur). Servis: top ele alınır (maçta servisçide),
// havaya atılır (falso o an seçilir), düşerken vurulur; havadayken vurulursa smaç servis. Arka sıra oyuncusu
// hücum çizgisinin önünde smaç ve blok yapamaz.
import { JUMP_MASK, JUMP_SHIFT, VJUMP_TIME } from "../../../shared/constants";
import type { ServerEvent } from "../../../shared/protocol";
import {
  ATTACK_LINE,
  emptyTeams,
  halfOf,
  hitBall,
  inCourt,
  LOB_POWER,
  isBackRow,
  leanShift,
  members,
  NET_TOP,
  PITCH_DEPTH,
  REACH,
  SET_TYPES,
  type SetType,
  serveHeight,
  SLOT_POS,
  tossBall,
  V_BALL_R,
  type VBall,
  type VolleyEv,
  type VolleyHit,
  type VolleyState,
  VOLLEY_TARGETS,
  VOLLEY_TEAM_MAX,
  vStep,
  WIND_POWER,
} from "../../../shared/volley";
import { inVolley, SPAWN, VOLLEY_COURT } from "../../../shared/zones";
import { CHAT_HISTORY } from "../chat";
import type { Conn, Room } from "../room";

const STEP = 1 / 120;
/** Vuruş geçmişi: bu kadar eski top konumları da kabul (oyuncunun gecikmesi). */
const HISTORY_MS = 450;
const HIT_COOLDOWN_MS = 300;
const TOSS_COOLDOWN_MS = 1200;
const SERVE_MS = 12_000;
const POINT_MS = 2600;
const FIRST_SERVE_MS = 2000;
/** Blok zıplaması bu kadar sürer; fileye bu kadar yakın olmalı. */
const BLOCK_MS = 1100;
const BLOCK_NET = 1.6;
const DIVE_MS = 750;
/**
 * Top yere değince sayı bu kadar bekler: gecikmeli oyuncunun yere değmeden önce bastığı vuruş gelirse
 * (geçmişte yere değmeden önceki bir konuma) sayı iptal olur.
 */
const LAND_GRACE_MS = 180;
/** Zıplamadan sonra bu kadar süre havada sayılır (smaç/dump, yana yatış). */
const AIR_MS = VJUMP_TIME * 1000 + 250;
/** Smaç serviste zıplamanın çizginin arkasından başladığı kabul edilen pay (momentumla sahaya girilir). */
const JUMP_SERVE_SLACK = 2.5;
const HITS: readonly VolleyEv[] = ["bump", "set", "spike", "dump", "serve"];
const DEFAULT_WIND = "#dff3ff";

/** Antrenman topu: yere düştüyse ve çağıran bu kadar süredir dokunmadıysa kaybolur. */
const PRACTICE_MS = 3000;
/** Yere düşen antrenman topu en az bu kadar görünür kalır. */
const PRACTICE_FALL_MS = 800;

type Hist = { x: number; y: number; z: number; at: number };

/** Sahadaki bir top: id 0 maç (ortak) topu; antrenmanda çağrılan toplar çağıranın sid'iyle. */
interface Ball {
  id: number;
  b: VBall;
  hist: Hist[];
  /** Servisçinin elindeki top (0 yok). */
  hold: number;
  /** Servis için topu havaya atan (0 yok; yalnız o vurabilir) ve seçtiği falso. */
  tossBy: number;
  tossSpin: number;
  /** Son sert vuruşun rüzgar rengi (yoksa null). */
  windC: string | null;
  lastToucher: number;
  /** Top dump ile bırakıldı: blok onu durduramaz (üstünden aşar). */
  dumped: boolean;
  /** Son dokunuş blok muydu (bloklayan yeniden dokunabilir). */
  blockTouch: boolean;
  pendingEv: { ev: VolleyEv; by: number } | null;
  /** Yere değdi, sayı bekliyor (bkz. LAND_GRACE_MS). */
  landing: { winner: 0 | 1; note: string; at: number } | null;
  lastSent: number;
  wasMoving: boolean;
  /** Antrenman topu: çağıranın son dokunduğu an; top son vuruştan sonra yere değdiyse o an (0 değmedi). */
  touchAt: number;
  fellAt: number;
}

const newBall = (id: number, x: number, z: number): Ball => ({
  id, b: { x, y: V_BALL_R, z, vx: 0, vy: 0, vz: 0, ax: 0, az: 0 }, hist: [], hold: 0, tossBy: 0, tossSpin: 0, windC: null,
  lastToucher: 0, dumped: false, blockTouch: false, pendingEv: null, landing: null, lastSent: 0, wasMoving: false, touchAt: 0, fellAt: 0,
});

export class Volleyball {
  /** Maç topu (antrenmanda da sahanın ortasında durur, herkes oynayabilir). */
  private main = newBall(0, VOLLEY_COURT.x - 3, VOLLEY_COURT.z);
  /** Antrenmanda oyuncuların çağırdığı toplar (oyuncu başına bir). */
  private practice = new Map<number, Ball>();
  s: VolleyState = { phase: "free", teams: emptyTeams(), score: [0, 0], target: 0, server: 0, until: 0, side: -1, touches: 0, note: "" };
  /** Oyuncuların rüzgar rengi. */
  private winds = new Map<number, string>();
  /** Servis sırası (takım başına) ve servisi atacak takım. */
  private rot: [number, number] = [0, 0];
  private serveTeam: 0 | 1 = 0;
  private lastHit = new Map<number, number>();
  private lastToss = new Map<number, number>();
  private jumps = new Map<number, { seq: number; at: number }>();
  private blockUntil = new Map<number, number>();
  private diveUntil = new Map<number, number>();
  /** Havada yatış: v yana (-1 sol, 1 sağ), f öne (1) / geri (-1). */
  private leans = new Map<number, { v: number; f: number }>();
  /** Salona nereden gelindi (dönünce oraya). */
  private from = new Map<number, { x: number; z: number; rot: number }>();
  private last = Date.now();
  private lastScan = 0;
  /** Sert servis sapması (testte sabitlenir). */
  random: () => number = Math.random;

  constructor(private room: Room) {}

  private balls(): Ball[] {
    return [this.main, ...this.practice.values()];
  }

  sendTo(conn: Conn, now = Date.now()): void {
    for (const ball of this.balls()) this.room.sendTo(conn, this.ballEvent(ball, now));
    this.room.sendTo(conn, { t: "vstate", state: this.s });
  }

  private ballEvent(ball: Ball, now: number): ServerEvent {
    const b = ball.b, ev = ball.pendingEv;
    return {
      t: "vball", x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, at: now,
      ...(ball.id ? { id: ball.id } : {}),
      ...(b.ax || b.az ? { ax: b.ax, az: b.az } : {}),
      ...(ball.hold ? { hold: ball.hold } : {}),
      ...(ball.tossBy ? { toss: ball.tossBy } : {}),
      ...(ev ? { ev: ev.ev, by: ev.by } : {}),
      ...(ev && ball.windC && HITS.includes(ev.ev) ? { w: ball.windC } : {}),
    };
  }

  private broadcast(ball: Ball, now: number): void {
    this.room.broadcast(this.ballEvent(ball, now));
    ball.pendingEv = null;
    ball.lastSent = now;
  }

  private sendState(): void {
    this.room.broadcast({ t: "vstate", state: this.s });
  }

  private notice(sid: number, text: string): void {
    const conn = this.room.players.get(sid)?.conn;
    if (conn) this.room.sendTo(conn, { t: "notice", text });
  }

  get playing(): boolean {
    return this.s.target > 0;
  }

  teamOf(sid: number): 0 | 1 | null {
    return sid > 0 && this.s.teams[0].includes(sid) ? 0 : sid > 0 && this.s.teams[1].includes(sid) ? 1 : null;
  }

  private inHall(sid: number): boolean {
    const p = this.room.players.get(sid);
    return !!p && !p.info.spectator && inVolley(p.state.x, p.state.z);
  }

  // ---------------------------------------------------------------------------
  // Salon: giriş/çıkış, pozisyonlar, maç
  // ---------------------------------------------------------------------------

  /** Salona ışınla (güney kenarındaki yedek kulübelerinin önüne). Hata metni ya da null. */
  go(sid: number, now = Date.now()): string | null {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator || p.info.jailed) return "🏐 Şu an salona gidemezsin.";
    if (inVolley(p.state.x, p.state.z)) return null;
    this.from.set(sid, { x: p.state.x, z: p.state.z, rot: p.state.rot });
    const C = VOLLEY_COURT;
    this.room.moveTo(sid, C.x + (this.random() - 0.5) * 4, C.z + C.hz + 2.5, Math.PI, now);
    return null;
  }

  /** Dünyaya dön: takımdan çıkar, geldiği yere ışınlanır. */
  home(sid: number, now = Date.now()): void {
    if (!this.inHall(sid)) return;
    this.dropFromTeam(sid, now);
    const back = this.from.get(sid) ?? SPAWN;
    this.from.delete(sid);
    this.room.moveTo(sid, back.x, back.z, back.rot, now);
  }

  /**
   * Pozisyon seç (slot 0–5, bkz. SLOT_POS; -1: izleyici): o pozisyona ışınlanır. Hata metni ya da null.
   */
  setPos(sid: number, team: 0 | 1, slot: number, now = Date.now()): string | null {
    if (!this.inHall(sid)) return "🏐 Önce voleybol salonuna git.";
    if (slot < 0) {
      this.dropFromTeam(sid, now);
      return null;
    }
    if (!Number.isInteger(slot) || slot >= VOLLEY_TEAM_MAX) return null;
    const list = this.s.teams[team];
    if (list[slot] === sid) {
      this.toSlot(sid, team, slot, now);
      return null;
    }
    if (list[slot]) return "🏐 Bu pozisyon dolu.";
    this.dropFromTeam(sid, now, false);
    list[slot] = sid;
    this.toSlot(sid, team, slot, now);
    this.sendState();
    return null;
  }

  private dropFromTeam(sid: number, now: number, send = true): void {
    const t = this.teamOf(sid);
    if (t === null) return;
    this.s.teams[t] = this.s.teams[t].map((s) => (s === sid ? 0 : s));
    if (this.main.hold === sid) this.main.hold = 0;
    if (this.main.tossBy === sid) this.main.tossBy = 0;
    if (send) {
      this.sendState();
      if (this.playing && !members(this.s, t).length) this.finish(null, now, "🏐 Takımlardan biri boşaldı, maç bitti.");
      else if (this.playing && this.s.phase === "serve" && this.s.server === sid) this.startServe(now);
    }
  }

  /**
   * Maç başlat (set `target` sayıya, iki fark): salondaki pozisyonsuzlar az kişili takımın boş pozisyonlarına
   * girer; herkes kendi pozisyonuna konur. Antrenman topları kaybolur.
   */
  start(sid: number, target: number, now = Date.now()): string | null {
    if (!this.inHall(sid)) return "🏐 Önce voleybol salonuna git.";
    if (this.playing) return "🏐 Zaten bir maç sürüyor.";
    const t = VOLLEY_TARGETS.includes(target as never) ? target : 15;
    const teams = this.s.teams, count = (k: 0 | 1) => members(this.s, k).length;
    const put = (k: 0 | 1, other: number) => {
      const i = teams[k].indexOf(0);
      if (i < 0) return false;
      teams[k][i] = other;
      return true;
    };
    for (const [other, p] of this.room.players) {
      if (p.info.spectator || p.info.jailed || !inVolley(p.state.x, p.state.z) || this.teamOf(other) !== null) continue;
      const pick = count(0) < count(1) ? 0 : count(1) < count(0) ? 1 : halfOf(p.state.x);
      if (!put(pick, other)) put((1 - pick) as 0 | 1, other);
    }
    if (!count(0) || !count(1)) {
      // Tek tarafta toplandılarsa biri karşıya geçer
      const full = count(0) ? 0 : 1, list = members(this.s, full);
      if (list.length < 2) {
        this.sendState();
        return "🏐 Maç için salonda en az iki kişi olmalı.";
      }
      const mover = list[list.length - 1];
      teams[full] = teams[full].map((s) => (s === mover ? 0 : s));
      put((1 - full) as 0 | 1, mover);
    }
    Object.assign(this.s, { target: t, score: [0, 0], side: -1, touches: 0, note: "" });
    this.rot = [0, 0];
    this.serveTeam = this.random() < 0.5 ? 0 : 1;
    teams.forEach((list, team) => list.forEach((s, i) => s && this.toSlot(s, team as 0 | 1, i, now)));
    for (const id of [...this.practice.keys()]) this.removePractice(id);
    // Kısa hazırlık, sonra ilk servis
    this.rest();
    this.s.phase = "point";
    this.s.until = now + FIRST_SERVE_MS;
    this.sendState();
    this.broadcast(this.main, now);
    return null;
  }

  /** Maçı bitir (kimse kazanmaz). */
  stop(sid: number, now = Date.now()): string | null {
    if (!this.playing) return "🏐 Süren bir maç yok.";
    if (this.teamOf(sid) === null) return "🏐 Maçı yalnızca oyuncular bitirebilir.";
    this.finish(null, now, `🏐 Maç ${this.room.players.get(sid)?.info.name ?? "biri"} tarafından bitirildi.`);
    return null;
  }

  /** Pozisyonuna ışınla (fileden uzaklık, yan); fileye bakar. */
  private toSlot(sid: number, team: 0 | 1, slot: number, now: number): void {
    const C = VOLLEY_COURT, s = team === 0 ? -1 : 1;
    const [d, side] = SLOT_POS[slot];
    this.room.moveTo(sid, C.x + s * d, C.z + side, team === 0 ? Math.PI / 2 : -Math.PI / 2, now);
  }

  /** Maç topu sahanın ortasında, yerde (servis yok). */
  private rest(): void {
    Object.assign(this.main.b, { x: VOLLEY_COURT.x - 3, y: V_BALL_R, z: VOLLEY_COURT.z, vx: 0, vy: 0, vz: 0, ax: 0, az: 0 });
    this.main.hold = this.main.tossBy = 0;
    this.main.hist = [];
  }

  /** Servis sırası: servisi atacak takımın sıradaki oyuncusu, çizginin arkasına konur. */
  private startServe(now: number): void {
    const list = members(this.s, this.serveTeam);
    if (!list.length) return this.finish(null, now, "🏐 Takımlardan biri boşaldı, maç bitti.");
    const server = list[this.rot[this.serveTeam] % list.length];
    const C = VOLLEY_COURT, s = this.serveTeam === 0 ? -1 : 1, m = this.main;
    this.room.moveTo(server, C.x + s * (C.hx + 1.2), C.z + (this.random() - 0.5) * 3, this.serveTeam === 0 ? Math.PI / 2 : -Math.PI / 2, now);
    m.hold = server;
    m.tossBy = 0;
    m.lastToucher = 0;
    m.blockTouch = false;
    Object.assign(this.s, { phase: "serve", server, until: now + SERVE_MS, side: -1, touches: 0 });
    this.sendState();
    this.broadcast(m, now);
  }

  /** Sayı: `winner` takımı kazandı; servis el değiştirdiyse o takımda sıradaki oyuncuya geçer. */
  private point(winner: 0 | 1, note: string, now: number): void {
    const s = this.s;
    this.main.landing = null;
    s.score[winner]++;
    s.note = note;
    s.phase = "point";
    s.until = now + POINT_MS;
    this.main.hold = this.main.tossBy = 0;
    if (winner !== this.serveTeam) {
      this.serveTeam = winner;
      this.rot[winner]++;
    }
    const [a, b] = s.score;
    const lead = winner === 0 ? a - b : b - a;
    if (s.score[winner] >= s.target && lead >= 2) {
      this.sendState();
      return this.finish(winner, now);
    }
    this.sendState();
  }

  /** Hata yapan takımın rakibi sayı alır. */
  private fault(team: 0 | 1, note: string, now: number): void {
    this.point((1 - team) as 0 | 1, note, now);
  }

  /** Maç sonu: sonuç sohbete; pozisyonlar kalır, serbest antrenmana dönülür. */
  private finish(winner: 0 | 1 | null, now: number, text?: string): void {
    const [r, b] = this.s.score;
    const line = text ?? `🏐 Voleybol maçı bitti: 🔴 ${r} – ${b} 🔵 · ${winner === 0 ? "Kırmızı" : "Mavi"} takım kazandı!`;
    this.room.say({ kind: "system", sid: 0, name: "Bot GAP", text: line, at: now }, CHAT_HISTORY);
    Object.assign(this.s, { phase: "free", target: 0, server: 0, until: 0, side: -1, touches: 0, note: winner === null ? "" : `${winner === 0 ? "🔴 Kırmızı" : "🔵 Mavi"} kazandı!` });
    this.main.hold = this.main.tossBy = 0;
    this.sendState();
    this.broadcast(this.main, now);
  }

  // ---------------------------------------------------------------------------
  // Antrenman topları
  // ---------------------------------------------------------------------------

  /** Oyuncunun çağırdığı top (yoksa ayağının dibinde oluşur). */
  private own(sid: number, x: number, z: number): Ball {
    let ball = this.practice.get(sid);
    if (!ball) {
      ball = newBall(sid, x, z);
      this.practice.set(sid, ball);
    }
    return ball;
  }

  private removePractice(id: number): void {
    if (!this.practice.delete(id)) return;
    this.room.broadcast({ t: "vgone", id });
  }

  /** Vuruş ya da çağırma: top yeniden oyunda; çağıranın kendi dokunuşu kaybolma süresini baştan başlatır. */
  private touched(ball: Ball, sid: number, now: number): void {
    ball.fellAt = 0;
    if (ball.id === sid) ball.touchAt = now;
  }

  // ---------------------------------------------------------------------------
  // Vuruşlar
  // ---------------------------------------------------------------------------

  /** Zıplamanın üstünden kısa süre geçti mi (smaç/dump havada olur). */
  private airborne(sid: number, now: number): boolean {
    const j = this.jumps.get(sid);
    return !!j && j.at > 0 && now - j.at < AIR_MS;
  }

  /** Havadaki yatışın menzile kattığı kayma (yerde yok); `dir` oyuncunun baktığı yön. */
  private leanOffset(sid: number, dir: number, now: number): [number, number] {
    const l = this.leans.get(sid);
    if (!l || !this.airborne(sid, now)) return [0, 0];
    return leanShift(dir, l.v, l.f);
  }

  /** Havada öne yatan yakına, geri yatan uzağa vurur (uzaklık çarpanı). */
  private depthOf(sid: number, now: number): number {
    const l = this.leans.get(sid);
    return l && this.airborne(sid, now) ? 1 - l.f * PITCH_DEPTH : 1;
  }

  /** Havada yatış (A/D yana, W/S öne/geri): menzil ve blok o yana kayar; herkese çizilir. */
  lean(sid: number, v: number, f = 0): void {
    if (!this.inHall(sid)) return;
    const l = Math.sign(v) || 0, fw = Math.sign(f) || 0, cur = this.leans.get(sid);
    if ((cur?.v ?? 0) === l && (cur?.f ?? 0) === fw) return;
    if (l || fw) this.leans.set(sid, { v: l, f: fw });
    else this.leans.delete(sid);
    this.room.broadcast({ t: "vact", sid, a: "lean", v: l, f: fw });
  }

  /** Rüzgar rengi (özelleştirme): sert vuruşlarda topun arkasındaki iz. */
  wind(sid: number, c: string): void {
    if (/^#[0-9a-f]{6}$/i.test(c)) this.winds.set(sid, c.toLowerCase());
  }

  /** Arka sıra oyuncusu maçta hücum çizgisinin önünde mi (orada smaç ve blok yok). */
  private backRowFront(sid: number): boolean {
    const team = this.teamOf(sid), p = this.room.players.get(sid);
    if (!this.playing || team === null || !p) return false;
    return isBackRow(this.s.teams[team].indexOf(sid)) && Math.abs(p.state.x - VOLLEY_COURT.x) < ATTACK_LINE;
  }

  /** Antrenman: maç yokken kendi topunu çağırıp kendine at (önüne, yukarı). */
  toss(sid: number, now = Date.now()): void {
    const p = this.room.players.get(sid);
    if (!p || !this.inHall(sid) || this.playing) return;
    if (now - (this.lastToss.get(sid) ?? 0) < TOSS_COOLDOWN_MS) return;
    this.lastToss.set(sid, now);
    const dx = Math.sin(p.state.rot), dz = Math.cos(p.state.rot);
    const ball = this.own(sid, p.state.x, p.state.z);
    Object.assign(ball.b, { x: p.state.x + dx * 0.6, y: 1.6, z: p.state.z + dz * 0.6, vx: dx * 0.3, vy: 5.2, vz: dz * 0.3, ax: 0, az: 0 });
    Object.assign(ball, { hold: 0, tossBy: 0, hist: [], lastToucher: 0, dumped: false, landing: null, windC: null });
    this.touched(ball, sid, now);
    ball.pendingEv = { ev: "set", by: sid };
    this.broadcast(ball, now);
  }

  /** Antrenman servisi: kendi topunu ele al (maçta servisçi maç topunu zaten tutar). */
  take(sid: number, now = Date.now()): void {
    const p = this.room.players.get(sid);
    if (!p || !this.inHall(sid) || this.playing || this.practice.get(sid)?.hold === sid) return;
    if (now - (this.lastToss.get(sid) ?? -Infinity) < TOSS_COOLDOWN_MS) return;
    this.lastToss.set(sid, now);
    const ball = this.own(sid, p.state.x, p.state.z);
    Object.assign(ball, { hold: sid, tossBy: 0, landing: null, hist: [], windC: null });
    Object.assign(ball.b, { x: p.state.x, y: 1.1, z: p.state.z, vx: 0, vy: 0, vz: 0, ax: 0, az: 0 });
    this.touched(ball, sid, now);
    this.broadcast(ball, now);
  }

  /** Elindeki topu servis için havaya at (`spin`: o an seçilen falso); düşerken yalnız o vurabilir. */
  lift(sid: number, spin: number, now = Date.now()): void {
    const p = this.room.players.get(sid), ball = this.balls().find((x) => x.hold === sid);
    if (!p || !ball) return;
    if (this.playing) {
      const team = this.teamOf(sid);
      if (this.s.phase !== "serve" || this.s.server !== sid || team === null) return;
      if (!this.behindLine(team, p.state.x, 0.25)) return this.notice(sid, "🏐 Servisi çizginin arkasından at.");
    }
    tossBall(ball.b, p.state.x, p.state.z, p.state.rot);
    ball.hold = 0;
    ball.tossBy = sid;
    ball.tossSpin = Number.isFinite(spin) ? Math.max(-1, Math.min(1, spin)) : 0;
    ball.hist = [];
    ball.lastToucher = 0;
    this.touched(ball, sid, now);
    this.broadcast(ball, now);
  }

  /** `team`ın servis çizgisinin arkasında mı (`slack` m içeri pay). */
  private behindLine(team: 0 | 1, x: number, slack: number): boolean {
    const C = VOLLEY_COURT;
    return team === 0 ? x <= C.x - C.hx + slack : x >= C.x + C.hx - slack;
  }

  /** Blok için zıpladı (fileye yakınsa): kısa süre top filenin üstünden geçemez (bkz. blockTick). */
  block(sid: number, now = Date.now()): void {
    const p = this.room.players.get(sid);
    if (!p || !this.inHall(sid) || (this.playing && this.teamOf(sid) === null)) return;
    if (Math.abs(p.state.x - VOLLEY_COURT.x) > BLOCK_NET || this.backRowFront(sid)) return;
    this.blockUntil.set(sid, now + BLOCK_MS);
    this.room.broadcast({ t: "vact", sid, a: "block" });
  }

  dive(sid: number, now = Date.now()): void {
    if (!this.inHall(sid)) return;
    this.diveUntil.set(sid, now + DIVE_MS);
    this.room.broadcast({ t: "vact", sid, a: "dive" });
  }

  /** Vuruş: geçerliyse (menzil, dokunuş kuralları) menzildeki en yakın top yeni yayına oturur. */
  hit(sid: number, kind: VolleyHit, dir: number, power: number, dive = false, now = Date.now(), st?: SetType): void {
    const p = this.room.players.get(sid);
    if (!p || !this.inHall(sid) || !Number.isFinite(dir) || !Number.isFinite(power)) return;
    if (!["bump", "set", "spike", "dump", "serve"].includes(kind)) return;
    if (now - (this.lastHit.get(sid) ?? 0) < HIT_COOLDOWN_MS) return;
    const team = this.teamOf(sid);
    if (this.playing && team === null) return;
    // Havaya atılmış servis topu: yalnız atan vurur (hangi tuşla olursa olsun servis)
    const tossed = this.balls().find((x) => x.tossBy === sid);
    if (tossed) return this.serveHit(tossed, sid, dir, power, now);
    if (kind === "serve") return;
    const phase = this.s.phase;
    if (phase === "serve" || phase === "point") return;
    if ((kind === "spike" || kind === "dump") && !this.airborne(sid, now)) return;
    if ((kind === "spike" || kind === "dump") && this.backRowFront(sid)) return this.notice(sid, "🏐 Arka sıra hücum çizgisinin önünden smaç vuramaz.");
    const reach = REACH[dive && kind === "bump" && (this.diveUntil.get(sid) ?? 0) > now ? "dive" : kind];
    const [ox, oz] = this.leanOffset(sid, dir, now);
    // Elde tutulan ya da servis için atılan toplar dışında menzildeki en yakın top
    let ball: Ball | null = null, at: (Hist & { d: number }) | null = null;
    for (const x of this.balls()) {
      if (x.hold || x.tossBy) continue;
      const h = this.sample(x, p.state.x + ox, p.state.z + oz, reach, now, x.landing?.at);
      if (h && (!at || h.d < at.d)) [ball, at] = [x, h];
    }
    if (!ball || !at) return;
    ball.landing = null;
    this.lastHit.set(sid, now);
    if (this.playing && team !== null) {
      const s = this.s;
      if (s.side === team) {
        if (ball.lastToucher === sid && !ball.blockTouch) return this.fault(team, "Çift vuruş", now);
        if (++s.touches > 3) return this.fault(team, "4 vuruş", now);
      } else {
        s.side = team;
        s.touches = 1;
      }
      this.sendState();
    }
    ball.lastToucher = sid;
    ball.blockTouch = false;
    ball.dumped = kind === "dump";
    this.touched(ball, sid, now);
    // Oyuncunun gördüğü yerden fırlat, aradan geçen süre kadar ilerlet
    Object.assign(ball.b, { x: at.x, y: at.y, z: at.z });
    this.windFor(ball, sid, power);
    hitBall(ball.b, kind, dir, power, 0, 0, st && SET_TYPES.includes(st) ? st : "normal", this.depthOf(sid, now));
    this.advance(ball, (now - at.at) / 1000, now);
    ball.hist = [];
    ball.pendingEv = { ev: kind, by: sid };
    this.broadcast(ball, now);
  }

  private windFor(ball: Ball, sid: number, power: number): void {
    ball.windC = power > WIND_POWER ? (this.winds.get(sid) ?? DEFAULT_WIND) : null;
  }

  /**
   * Havaya atılan servis topuna vuruş: yerdeyse güce göre alttan falsolu ya da üstten, havadaysa smaç servis.
   * Maçta çizginin arkasından (smaç serviste zıplayıp momentumla biraz içeri girilebilir); maç yokken herkes
   * bulunduğu yerden karşı yarıya deneme servisi atabilir.
   */
  private serveHit(ball: Ball, sid: number, dir: number, power: number, now: number): void {
    const p = this.room.players.get(sid)!, air = this.airborne(sid, now);
    const team = this.playing ? this.teamOf(sid) : halfOf(p.state.x);
    if (team === null) return;
    const [ox, oz] = this.leanOffset(sid, dir, now);
    const at = this.sample(ball, p.state.x + ox, p.state.z + oz, air ? REACH.spike : REACH.serve, now);
    if (!at) return;
    if (this.playing && !this.behindLine(team, p.state.x, air ? JUMP_SERVE_SLACK : 0.4)) return this.notice(sid, "🏐 Servisi çizginin arkasından at.");
    this.lastHit.set(sid, now);
    ball.tossBy = 0;
    Object.assign(ball.b, { x: at.x, y: at.y, z: at.z });
    this.windFor(ball, sid, power);
    hitBall(ball.b, "serve", dir, power, this.random() * 2 - 1, ball.tossSpin, "normal", this.depthOf(sid, now), air);
    this.touched(ball, sid, now);
    this.served(ball, sid, team);
    this.advance(ball, (now - at.at) / 1000, now);
    this.broadcast(ball, now);
  }

  /** Servis süresi doldu: elindeki maç topunu kendiliğinden alttan atar. */
  private autoServe(sid: number, team: 0 | 1, x: number, z: number, now: number): void {
    const toward = team === 0 ? 1 : -1, m = this.main;
    Object.assign(m.b, { x: x + toward * 0.3, y: serveHeight(LOB_POWER), z });
    hitBall(m.b, "serve", toward > 0 ? Math.PI / 2 : -Math.PI / 2, LOB_POWER);
    m.hold = 0;
    m.windC = null;
    this.served(m, sid, team);
    this.broadcast(m, now);
  }

  private served(ball: Ball, sid: number, team: 0 | 1): void {
    ball.hist = [];
    ball.lastToucher = sid;
    ball.blockTouch = false;
    ball.dumped = false;
    if (this.playing && ball === this.main) {
      Object.assign(this.s, { phase: "rally", side: team, touches: 1, note: "" });
      this.sendState();
    }
    ball.pendingEv = { ev: "serve", by: sid };
  }

  /** Atılan servis topu vurulmadan yere düştü: maçta servis hatası. */
  private tossFell(ball: Ball, now: number): void {
    ball.tossBy = 0;
    if (ball === this.main && this.playing && this.s.phase === "serve") this.fault(this.serveTeam, "Servis hatası", now);
  }

  /**
   * Oyuncunun basarken gördüğü top: geçmişte (ve şimdi) menzile giren en yakın konum ve uzaklığı. Yoksa null.
   */
  private sample(ball: Ball, px: number, pz: number, reach: { r: number; lo: number; hi: number }, now: number, before = Infinity): (Hist & { d: number }) | null {
    let best: (Hist & { d: number }) | null = null;
    const b = ball.b;
    for (const h of [...ball.hist, { x: b.x, y: b.y, z: b.z, at: now }]) {
      if (now - h.at > HISTORY_MS || h.at >= before || h.y < reach.lo || h.y > reach.hi) continue;
      const d = Math.hypot(h.x - px, h.z - pz);
      if (d <= reach.r && (!best || d < best.d)) best = { ...h, d };
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Kare başına
  // ---------------------------------------------------------------------------

  tick(now: number): void {
    const dt = Math.max(0, Math.min(0.25, (now - this.last) / 1000));
    this.last = now;
    // Zıplamalar: durum bitlerindeki sayaç her zıplamada artar
    for (const [sid, p] of this.room.players) {
      const seq = (p.state.flags & JUMP_MASK) >> JUMP_SHIFT;
      const j = this.jumps.get(sid);
      if (!j) this.jumps.set(sid, { seq, at: 0 });
      else if (j.seq !== seq) this.jumps.set(sid, { seq, at: now });
    }
    if (now - this.lastScan > 1000) {
      this.lastScan = now;
      // Salondan çıkanlar takımdan düşer
      for (const sid of [...members(this.s, 0), ...members(this.s, 1)]) if (!this.inHall(sid)) this.dropFromTeam(sid, now);
    }
    // Antrenman topu: çağıran salondan çıkınca ya da top yere düşüp çağıran PRACTICE_MS boyunca dokunmayınca kaybolur
    for (const [sid, ball] of this.practice) {
      const idle = !ball.hold && ball.fellAt > 0 && now - ball.touchAt >= PRACTICE_MS && now - ball.fellAt >= PRACTICE_FALL_MS;
      if (idle || this.playing || !this.inHall(sid)) this.removePractice(sid);
    }
    this.tickMain(dt, now);
    for (const ball of this.practice.values()) {
      if (ball.hold) this.follow(ball, now);
      else this.fly(ball, dt, now);
    }
  }

  private tickMain(dt: number, now: number): void {
    const s = this.s, m = this.main;
    if (m.hold) {
      // Top servisçinin elinde (fizik yok); maçta süre dolarsa kendiliğinden alttan servis
      const p = this.room.players.get(m.hold);
      if (s.phase === "serve" && now >= s.until) {
        if (p) Object.assign(m.b, { x: p.state.x, y: 1.1, z: p.state.z, vx: 0, vy: 0, vz: 0, ax: 0, az: 0 });
        const team = this.teamOf(m.hold);
        if (p && team !== null) this.autoServe(m.hold, team, p.state.x, p.state.z, now);
        else this.startServe(now);
      } else this.follow(m, now);
      return;
    }
    // Servis: top havaya atılana kadar bekler
    if (s.phase === "serve" && !m.tossBy) return;
    if (m.landing && now - m.landing.at >= LAND_GRACE_MS) {
      const l = m.landing;
      m.landing = null;
      if (s.phase === "rally") this.point(l.winner, l.note, now);
    }
    if (s.phase === "point" && now >= s.until) {
      if (this.playing) this.startServe(now);
      return;
    }
    this.fly(m, dt, now);
  }

  /** Elde tutulan top oyuncuyla gider; antrenmanda tutan salondan çıkarsa bırakılır. */
  private follow(ball: Ball, now: number): void {
    const p = this.room.players.get(ball.hold);
    if (p) Object.assign(ball.b, { x: p.state.x, y: 1.1, z: p.state.z, vx: 0, vy: 0, vz: 0, ax: 0, az: 0 });
    if (!this.playing && (!p || !this.inHall(ball.hold))) {
      ball.hold = 0;
      this.broadcast(ball, now);
    }
  }

  /** Serbest top: fizik, geçmiş, yayın (hareket ederken ~10 Hz). */
  private fly(ball: Ball, dt: number, now: number): void {
    this.advance(ball, dt, now);
    const b = ball.b;
    ball.hist.push({ x: b.x, y: b.y, z: b.z, at: now });
    while (ball.hist.length && now - ball.hist[0].at > HISTORY_MS) ball.hist.shift();
    const moving = Math.abs(b.vx) + Math.abs(b.vy) + Math.abs(b.vz) > 0.02;
    if (ball.pendingEv || (moving && now - ball.lastSent > 100) || moving !== ball.wasMoving || now - ball.lastSent > 2000) this.broadcast(ball, now);
    ball.wasMoving = moving;
  }

  /** Fizik `t` sn: blok, file, yere değince sayı. */
  private advance(ball: Ball, t: number, now: number): void {
    for (let u = 0; u < t; u += STEP) {
      const ev = vStep(ball.b, Math.min(STEP, t - u));
      this.blockTick(ball, now);
      if (ev === "net" || ev === "wall") ball.pendingEv ??= { ev, by: 0 };
      if (ev === "floor") {
        ball.pendingEv ??= { ev, by: 0 };
        if (!ball.fellAt) ball.fellAt = now;
        if (ball.tossBy) this.tossFell(ball, now);
        else if (ball === this.main && this.s.phase === "rally" && this.playing && !ball.landing) this.landed(now);
      }
    }
  }

  /**
   * Maç topu yere değdi: sahanın içindeyse o yarının rakibi, dışarıdaysa son dokunanın rakibi sayı alır
   * (kısa bir beklemeden sonra; bkz. LAND_GRACE_MS).
   */
  private landed(now: number): void {
    const b = this.main.b, s = this.s;
    const out = !inCourt(b.x, b.z);
    const loser = out ? (s.side !== -1 ? s.side : this.serveTeam) : halfOf(b.x);
    this.main.landing = { winner: (1 - loser) as 0 | 1, note: out ? "Dışarı" : "Top yere değdi", at: now };
  }

  /**
   * Blok: fileye yakın zıplayan oyuncunun önünden (yana yattıysa o yana kayık), karşı taraftan gelen top
   * geçemez; aşağı, geldiği yarıya döner. Blok dokunuş sayılmaz (bloklayan yeniden oynayabilir).
   */
  private blockTick(ball: Ball, now: number): void {
    if (!this.blockUntil.size || ball.dumped) return;
    const b = ball.b, C = VOLLEY_COURT;
    if (Math.abs(b.x - C.x) > 0.5 || b.y < NET_TOP - 0.15 || b.y > NET_TOP + 1.8) return;
    for (const [sid, until] of this.blockUntil) {
      if (until <= now) {
        this.blockUntil.delete(sid);
        continue;
      }
      const p = this.room.players.get(sid);
      if (!p) continue;
      const half = halfOf(p.state.x), dir = half === 0 ? -1 : 1;
      const [, oz] = this.leanOffset(sid, p.state.rot, now);
      // Top bloklayanın yarısına doğru gelmeli, karşı taraf vurmuş olmalı
      if (Math.sign(b.vx) !== dir || Math.abs(b.z - p.state.z - oz) > 1.0 || Math.abs(p.state.x - C.x) > BLOCK_NET) continue;
      const team = this.teamOf(sid);
      if (this.playing ? team === null || this.s.side === team : ball.lastToucher === sid) continue;
      this.blockUntil.delete(sid);
      b.x = C.x - dir * (V_BALL_R + 0.05);
      b.vx = -dir * (2 + Math.abs(b.vx) * 0.25);
      b.vy = Math.min(b.vy, -1);
      b.vz *= 0.4;
      b.ax = b.az = 0;
      if (this.playing && team !== null) {
        this.s.side = team;
        this.s.touches = 0;
        this.sendState();
      }
      ball.lastToucher = sid;
      ball.blockTouch = true;
      ball.fellAt = 0;
      ball.pendingEv = { ev: "block", by: sid };
      return;
    }
  }

  leave(sid: number): void {
    this.dropFromTeam(sid, Date.now());
    for (const m of [this.lastHit, this.lastToss, this.jumps, this.blockUntil, this.diveUntil, this.leans, this.from, this.winds]) m.delete(sid);
    this.removePractice(sid);
    for (const ball of this.balls()) {
      if (ball.hold === sid) ball.hold = 0;
      if (ball.tossBy === sid) ball.tossBy = 0;
      if (ball.lastToucher === sid) ball.lastToucher = 0;
    }
  }
}
