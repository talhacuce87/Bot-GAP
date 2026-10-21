// Oyuncak pist yarışı (istemci): kendi arabamı sürerim (fizik shared/race.ts), konumu ~15 Hz gönderirim;
// diğerlerinin arabaları sunucudan gelen konumlarla yumuşatılarak çizilir. Yarışırken karakter yürümez,
// kamera piste tepeden bakar. Tuşlar: W/S ya da oklar gaz/fren, A/D direksiyon, Space drift, E nitro.
import * as THREE from "three";
import type { RaceState } from "../../shared/protocol";
import { advance, autopilot, CAR, type CarInput, type CarState, carFlags, newCar, newProgress, type Progress, project, RACE, score, stepCar, type Track, trackOf, TRACKS } from "../../shared/race";
import type { Input } from "./input/input";
import type { Net } from "./net";
import { RaceUi } from "./ui/raceUi";
import { sfx } from "./ui/sfx";
import { type CarPose, RaceView } from "./world/raceTrack";

/** Katılım sırasına göre oyuncak araba renkleri. */
export const RACE_COLORS = ["#e23b33", "#2f7bd8", "#f2c230", "#3fae4f", "#f08a2c", "#9b5de5", "#2ec4c4", "#f06292"].map((c) => new THREE.Color(c));

const SEND_MS = 1000 / 15;
const INTERP_MS = 120;
const STEP = 1 / 120;

interface Sample {
  t: number;
  x: number;
  z: number;
  a: number;
  f: number;
}

interface RemoteCar {
  buf: Sample[];
  prog: Progress;
  hint: number;
}

export interface RaceContext {
  scene: THREE.Scene;
  net: Net;
  input: Input;
  camera: THREE.PerspectiveCamera;
  hudRoot: HTMLElement;
  touch: boolean;
  nameOf(sid: number): string;
  toast(text: string): void;
}

export class RaceClient {
  readonly view = new RaceView();
  private ui: RaceUi;
  private state: RaceState | null = null;
  private track: Track = trackOf(0);
  private car: CarState | null = null;
  private prog: Progress = newProgress();
  private remotes = new Map<number, RemoteCar>();
  private keys = { up: false, down: false, left: false, right: false, drift: false, nitro: false };
  private abort = new AbortController();
  private acc = 0;
  private lastSend = 0;
  private blocked = false;
  private lastBeep = 99;
  private wasBoost = false;
  private flashUntil = 0;
  private flash = "";
  private shownLap = 0;
  private bumpAt = 0;
  private up = new THREE.Vector3(0, 1, 0);
  /** Debug antrenmanı (?debug&pist=N): sunucusuz, otomatik pilotlu botlarla. */
  private practiceReq: { track: number; bots: number; auto: boolean; lobby: boolean } | null = null;
  private practicing = false;
  private auto = false;
  private bots = new Map<number, { car: CarState; skill: number; prog: Progress }>();

  constructor(private c: RaceContext) {
    c.scene.add(this.view.group);
    this.ui = new RaceUi(c.hudRoot, c.touch, {
      leave: () => c.net.send({ t: "rleave" }),
      track: (i) => c.net.send({ t: "rtrack", i }),
      start: () => c.net.send({ t: "rstart" }),
    });
    const map: Record<string, keyof RaceClient["keys"]> = {
      KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down", KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right", Space: "drift", KeyE: "nitro",
    };
    const signal = this.abort.signal;
    const key = (on: boolean) => (e: KeyboardEvent) => {
      const k = map[e.code];
      if (!k || !this.driving() || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      this.keys[k] = on;
      e.preventDefault();
    };
    addEventListener("keydown", key(true), { signal });
    addEventListener("keyup", key(false), { signal });
    addEventListener("blur", () => Object.keys(this.keys).forEach((k) => (this.keys[k as keyof RaceClient["keys"]] = false)), { signal });
  }

  /** Lobide ya da yarışta mıyım. */
  joined(): boolean {
    return !!this.state?.players.some((p) => p.sid === this.c.net.you);
  }

  /** Geri sayımda ya da yarışta (karakter yürümez, kamera tepede). */
  driving(): boolean {
    const s = this.state;
    return !!s && (s.phase === "countdown" || s.phase === "race") && this.joined();
  }

  /** Lobi/sonuç panelini yeniden göster (F ile). */
  openPanel(): void {
    this.ui.setPanel(this.state, this.c.net.you, (sid) => this.name(sid), (sid) => this.colorHex(sid), this.c.net.serverNow());
  }

  /** Debug: bağlantı kurulunca sunucusuz antrenman başlar. */
  requestPractice(track: number, bots: number, auto: boolean, lobby = false): void {
    this.practiceReq = { track: Math.max(0, Math.min(TRACKS.length - 1, track)), bots: Math.max(0, Math.min(RACE.max - 1, bots)), auto, lobby };
  }

  private practice(req: { track: number; bots: number; auto: boolean; lobby: boolean }): void {
    const you = this.c.net.you, now = this.c.net.serverNow();
    const players = [you, ...Array.from({ length: req.bots }, (_, i) => -(i + 1))].map((sid) => ({ sid, lap: 0, place: 0, time: 0 }));
    this.practicing = true;
    this.auto = req.auto;
    // Yalnızca lobi paneli (görünüm denemesi)
    if (req.lobby) return this.onState({ phase: "lobby", host: you, track: req.track, players, startAt: 0, endsAt: 0 });
    this.onState({ phase: "countdown", host: you, track: req.track, players, startAt: now + RACE.countdownMs, endsAt: now + RACE.maxMs });
    this.bots.clear();
    players.slice(1).forEach((p, k) => this.bots.set(p.sid, { car: newCar(this.track, k + 1), skill: 0.75 + Math.random() * 0.25, prog: newProgress() }));
  }

  /** Antrenmanda botları sürer (uzak araba gibi örnek üretir) ve yarış akışını yerelde yürütür. */
  private practiceTick(dt: number, now: number): void {
    const s = this.state!;
    if (s.phase === "countdown" && now >= s.startAt) s.phase = "race";
    if (s.phase === "end" && now >= s.endsAt) {
      this.practicing = false;
      this.onState(null);
      return;
    }
    if (s.phase !== "race") return;
    for (const [sid, b] of this.bots) {
      for (let k = 0; k < Math.round(dt / STEP); k++) stepCar(b.car, autopilot(this.track, b.car, b.skill), STEP, this.track);
      advance(this.track, b.prog, b.car.hint);
      const p = s.players.find((q) => q.sid === sid)!;
      if (!p.place && b.prog.lap > RACE.laps) [p.place, p.time] = [s.players.filter((q) => q.place).length + 1, now - s.startAt];
      p.lap = Math.min(RACE.laps, b.prog.lap);
      this.onCars([sid, Math.round(b.car.x * 10), Math.round(b.car.z * 10), Math.round(b.car.a * 100), carFlags(b.car)]);
    }
    const me = s.players.find((q) => q.sid === this.c.net.you)!;
    if (!me.place && this.prog.lap > RACE.laps) [me.place, me.time] = [s.players.filter((q) => q.place).length + 1, now - s.startAt];
    if (s.players.every((q) => q.place)) {
      s.phase = "end";
      s.endsAt = now + RACE.resultMs;
      this.onState({ ...s });
    }
  }

  private name(sid: number): string {
    return sid < 0 ? `Bot ${-sid}` : this.c.nameOf(sid);
  }

  private colorHex(sid: number): string {
    return `#${this.colorOf(sid).getHexString()}`;
  }

  private colorOf(sid: number): THREE.Color {
    const i = this.state?.players.findIndex((p) => p.sid === sid) ?? -1;
    return RACE_COLORS[Math.max(0, i) % RACE_COLORS.length];
  }

  onState(s: RaceState | null): void {
    // Antrenmandayken sunucunun yarış durumu (başka bir yarış) karışmasın
    if (this.practicing && s !== this.state && !(s && s.host === this.c.net.you && s.players.some((p) => p.sid < 0))) return;
    const prev = this.state;
    this.state = s;
    const you = this.c.net.you;
    this.view.setTrack(s?.track ?? 0);
    this.track = trackOf(s?.track ?? 0);
    const racing = !!s && s.phase !== "lobby" && s.players.length > 0;
    this.view.syncCars(racing ? s!.players.map((p) => ({ sid: p.sid, name: this.name(p.sid), color: this.colorOf(p.sid) })) : []);
    // Yeni yarış: arabam başlangıç kutusunda
    if (s?.phase === "countdown" && prev?.phase !== "countdown") {
      const slot = s.players.findIndex((p) => p.sid === you);
      this.car = slot >= 0 ? newCar(this.track, slot) : null;
      this.prog = newProgress();
      this.remotes.clear();
      this.shownLap = 0;
      this.lastBeep = 99;
    }
    if (!s || s.phase === "lobby") {
      this.car = null;
      this.remotes.clear();
    }
    const me = s?.players.find((p) => p.sid === you);
    if (me?.place && prev?.players.find((p) => p.sid === you)?.place !== me.place) sfx.cheer(me.place === 1 ? 1 : 0.4);
    this.openPanel();
  }

  onCars(c: number[]): void {
    const now = performance.now(), you = this.c.net.you;
    for (let i = 0; i + 4 < c.length; i += 5) {
      const sid = c[i];
      if (sid === you) continue;
      let r = this.remotes.get(sid);
      if (!r) this.remotes.set(sid, (r = { buf: [], prog: newProgress(), hint: -1 }));
      const s: Sample = { t: now, x: c[i + 1] / 10, z: c[i + 2] / 10, a: c[i + 3] / 100, f: c[i + 4] };
      r.buf.push(s);
      if (r.buf.length > 8) r.buf.shift();
      const p = project(this.track, s.x, s.z, r.hint);
      r.hint = p.i;
      advance(this.track, r.prog, p.i);
    }
  }

  /** Uzak arabanın çizim anındaki yeri (geriden, iki örnek arası). */
  private remotePose(r: RemoteCar, t: number): CarPose | null {
    const b = r.buf;
    if (!b.length) return null;
    if (t <= b[0].t) return b[0];
    for (let i = 0; i + 1 < b.length; i++) {
      const p = b[i], q = b[i + 1];
      if (t > q.t) continue;
      const k = (t - p.t) / Math.max(1, q.t - p.t);
      let da = q.a - p.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      return { x: p.x + (q.x - p.x) * k, z: p.z + (q.z - p.z) * k, a: p.a + da * k, f: q.f };
    }
    return b[b.length - 1];
  }

  private input(): CarInput {
    const k = this.keys, t = this.ui.touch;
    return {
      throttle: (k.up || t.gas ? 1 : 0) - (k.down || t.brake ? 1 : 0),
      steer: (k.right || t.right ? 1 : 0) - (k.left || t.left ? 1 : 0),
      drift: k.drift || t.drift,
      nitro: k.nitro || t.nitro,
    };
  }

  update(dt: number, time: number, night: number): void {
    const net = this.c.net;
    const now = net.serverNow();
    if (this.practiceReq && net.you > 0) {
      this.practice(this.practiceReq);
      this.practiceReq = null;
    }
    if (this.practicing && this.state) this.practiceTick(dt, now);
    const s = this.state;
    const driving = this.driving();
    if (driving !== this.blocked) {
      this.blocked = driving;
      this.c.input.setBlocked(driving);
      // Dünya etkileşim ipuçları (otur, F…) ve tuş satırı yarışta gizli
      this.c.hudRoot.classList.toggle("racing", driving);
      if (!driving) Object.keys(this.keys).forEach((k) => (this.keys[k as keyof RaceClient["keys"]] = false));
    }
    const me = s?.players.find((p) => p.sid === net.you);
    const renderT = performance.now() - INTERP_MS;

    if (s && this.car && me) {
      const countdown = (s.startAt - now) / 1000;
      const go = (s.phase === "race" || s.phase === "countdown") && countdown <= 0;
      // Geri sayım bipleri
      const beat = Math.ceil(countdown);
      if (s.phase === "countdown" && beat < this.lastBeep && beat <= 3 && beat > 0) sfx.beep();
      if (go && this.lastBeep > 0) sfx.beep(true);
      this.lastBeep = go ? 0 : beat;

      if (go || s.phase === "end") {
        // Bitirince ya da sonuç ekranında araba kendi kendine yavaşlar
        const inp = me.place || s.phase === "end" ? { throttle: 0, steer: 0, drift: false, nitro: false } : this.auto ? autopilot(this.track, this.car) : this.input();
        this.acc = Math.min(0.1, this.acc + dt);
        while (this.acc >= STEP) {
          this.acc -= STEP;
          const hit = stepCar(this.car, inp, STEP, this.track);
          if (hit > 6 && time - this.bumpAt > 0.25) {
            this.bumpAt = time;
            sfx.bump(Math.min(1, hit / 25));
          }
        }
        this.collide(renderT, time);
        advance(this.track, this.prog, this.car.hint);
        if (this.car.boost && !this.wasBoost) sfx.boost();
        this.wasBoost = this.car.boost;
        if (this.prog.lap === RACE.laps && this.shownLap !== RACE.laps) {
          this.flash = "SON TUR!";
          this.flashUntil = time + 1.6;
        }
        this.shownLap = this.prog.lap;
        if (s.phase === "race" && !me.place && !this.practicing && performance.now() - this.lastSend >= SEND_MS) {
          this.lastSend = performance.now();
          const r = (v: number) => Math.round(v * 100) / 100;
          net.send({ t: "rcar", x: r(this.car.x), z: r(this.car.z), a: r(this.car.a), f: carFlags(this.car) });
        }
      }
      this.view.setCar(net.you, { x: this.car.x, z: this.car.z, a: this.car.a, f: carFlags(this.car) }, time, true);
      this.ui.setHud(
        s.phase === "end"
          ? null
          : {
              lap: this.prog.lap,
              place: me.place || this.place(),
              count: s.players.length,
              time: go ? now - s.startAt : 0,
              nitro: this.car.nitro,
              drift: this.car.drift,
              boost: this.car.boost,
              countdown,
              finished: me.place,
              flash: time < this.flashUntil ? this.flash : "",
              standings: this.standings(),
            },
      );
    } else {
      this.ui.setHud(null);
    }
    for (const [sid, r] of this.remotes) this.view.setCar(sid, this.remotePose(r, renderT), time);
    this.view.update(time, night, !!this.car);
    if (s && (s.phase === "lobby" || s.phase === "end")) this.openPanel();
    else if (!s || !this.joined()) this.ui.setPanel(null, net.you, () => "", () => "", now);
    this.camera(driving || (!!this.car && s?.phase === "end"));
  }

  /** Diğer arabalara değince itişme: üst üste binmeyi aç, yaklaşan hızı karşılıklı paylaş. */
  private collide(renderT: number, time: number): void {
    const car = this.car!;
    for (const r of this.remotes.values()) {
      const p = this.remotePose(r, renderT);
      if (!p) continue;
      const dx = car.x - p.x, dz = car.z - p.z, d = Math.hypot(dx, dz), min = CAR.r * 1.9;
      if (d >= min || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d;
      car.x += nx * (min - d) * 0.6;
      car.z += nz * (min - d) * 0.6;
      // Karşı arabanın hızı son iki örnekten
      const b = r.buf, q = b[b.length - 1], o = b[b.length - 2];
      const ovx = o ? ((q.x - o.x) / Math.max(1, q.t - o.t)) * 1000 : 0, ovz = o ? ((q.z - o.z) / Math.max(1, q.t - o.t)) * 1000 : 0;
      const rel = (car.vx - ovx) * nx + (car.vz - ovz) * nz;
      if (rel < 0) {
        car.vx -= nx * rel * 0.9;
        car.vz -= nz * rel * 0.9;
        if (time - this.bumpAt > 0.2) {
          this.bumpAt = time;
          sfx.bump(Math.min(1, -rel / 20));
        }
      }
    }
  }

  /** Bitirenler sırayla, sonra ilerlemeye göre. */
  private ranking(): number[] {
    const s = this.state!;
    const val = (sid: number) => {
      const p = s.players.find((q) => q.sid === sid)!;
      if (p.place) return 1e6 - p.place;
      if (sid === this.c.net.you) return this.car ? score(this.track, this.prog, this.car.hint) : -1e6;
      const r = this.remotes.get(sid);
      return r && r.hint >= 0 ? score(this.track, r.prog, r.hint) : -1e6;
    };
    return s.players.map((p) => p.sid).sort((a, b) => val(b) - val(a));
  }

  private place(): number {
    return this.ranking().indexOf(this.c.net.you) + 1;
  }

  private standings(): { name: string; color: string; lap: number; done: boolean }[] {
    const s = this.state!;
    return this.ranking().map((sid) => {
      const p = s.players.find((q) => q.sid === sid)!;
      return { name: this.name(sid), color: this.colorHex(sid), lap: p.lap, done: !!p.place };
    });
  }

  /** Yarışırken kamera pistin tam tepesinde (kuzey yukarıda), bütün pist sığar. */
  private camera(on: boolean): void {
    const cam = this.c.camera;
    if (!on) {
      if (cam.up.y !== 1) cam.up.set(0, 1, 0);
      return;
    }
    const b = this.view.bounds();
    const tan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const h = Math.max((b.hd + 0.6) / tan, (b.hw + 0.6) / (tan * cam.aspect));
    cam.up.set(0, 0, -1);
    cam.position.set(b.x, b.y + h, b.z + 0.001);
    cam.lookAt(b.x, b.y, b.z);
    cam.up.copy(this.up);
  }

  dispose(): void {
    if (this.blocked) this.c.input.setBlocked(false);
    this.c.hudRoot.classList.remove("racing");
    this.abort.abort();
    this.ui.dispose();
    this.c.scene.remove(this.view.group);
  }
}
