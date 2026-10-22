// Voleybol salonu (istemci): top çizimi (sunucunun yayı, aynı fizikle araya), Volleyball 4.2 tuşları ve alt
// paneli (falso noktalı top, güç x/15, stamina x/10, zıplama ve pas türü), skor şeridi, voleybol menüsü (P:
// pozisyon, maç, özelleştirme). Salona girince "volley" tuş takımı geçerli olur. Vuruş yönü kameranın baktığı
// yön (shift lock ile nişan); güç Q/E ile 1–15, Z/X/C ile 1/8/15. Her sprint (T) bir stamina harcar; dururken
// çabuk, yürürken yavaş dolar. Zıplarken momentum korunur; havada A/D yana, W/S öne/geri yatırır (menzil o yana
// kayar; öne yatan yakına, geri yatan uzağa vurur). Servis: V ile top ele alınır (maçta servisçide), sol tık
// topu havaya atar (güç 1–3'te sağa sola gidip gelen kırmızı nokta o an durur ve falsoyu belirler), düşerken
// sol tık vurur; koşup zıplayarak smaç servis atılabilir. 12'den sert vuruşta topun arkasında rüzgar izi ve yolunu
// çizen renkli çizgi, düştüğü yerde rüzgar patlaması. Topun yere ilk değdiği yerde bir süre iz kalır. Antrenmanda
// herkes kendi topunu çağırır (sahada birden çok top; vuruş menzildeki en yakına).
import * as THREE from "three";
import { JUMP_MASK } from "../../shared/constants";
import {
  ATTACK_LINE,
  hitBall,
  isBackRow,
  leanShift,
  LOB_POWER,
  PITCH_DEPTH,
  POWER_MAX,
  POWER_MIN,
  REACH,
  SET_NAMES,
  SET_TYPES,
  type SetType,
  serveName,
  TOUCH_COOLDOWN_MS,
  V_BALL_R,
  type VBall,
  type VolleyEv,
  type VolleyHit,
  type VolleyState,
  emptyTeams,
  halfOf,
  VOLLEY_TARGETS,
  vPredict,
  WIND_POWER,
} from "../../shared/volley";
import { inVolley, VOLLEY_COURT } from "../../shared/zones";
import type { VolleyPose } from "./avatars/chibi";
import type { Remotes } from "./avatars/remotes";
import type { Input } from "./input/input";
import { type Action, actionLabel, onBinds, profile, setProfile } from "./input/keybinds";
import type { Net } from "./net";
import type { Player } from "./player";
import { button, el, Panel } from "./ui/panel";
import { falloff, sfx } from "./ui/sfx";
import type { VolleyCourt } from "./world/volleyCourt";

/** Stamina: en fazla 10; her sprint 1 harcar. Dururken saniyede STAND_REGEN, yürürken WALK_REGEN dolar. */
const STAMINA_MAX = 10;
const STAND_REGEN = 1;
const WALK_REGEN = 0.3;
/** Dalış: süratle öne uzanma (sn, m/sn) ve iki dalış arası. */
const DIVE = { t: 0.5, speed: 8, cooldown: 1.1, window: 0.75 };
/** Havada sayılır (smaç/dump). */
const AIR = 0.18;
const POWER_KEY = "gap-volley-power";
const SET_KEY = "gap-volley-set";
const WIND_KEY = "gap-volley-wind";
/** Pozisyon adları (bkz. SLOT_POS). */
const SLOT_NAMES = ["Ön sol", "Ön orta", "Ön sağ", "Arka sol", "Arka orta", "Arka sağ"];
/** Rüzgar izi renk seçenekleri (özelleştirme). */
const WINDS: [string, string][] = [
  ["#dff3ff", "Beyaz"], ["#5ad1ff", "Buz"], ["#2f7bff", "Mavi"], ["#c77dff", "Mor"],
  ["#ff7ad9", "Pembe"], ["#ff4a3d", "Ateş"], ["#ff9f1c", "Turuncu"], ["#ffd23f", "Altın"], ["#7cff6b", "Yeşil"],
];
/** Falso noktasının gidip gelme hızı (rad/sn). */
const DOT_SPEED = 2.6;

type BallMsg = VBall & { id?: number; at: number; hold?: number; toss?: number; sv?: 1; w?: string; ev?: VolleyEv; by?: number };
type MenuTab = "pos" | "match" | "style";

export interface VolleyDeps {
  scene: THREE.Scene;
  court: VolleyCourt;
  net: Net;
  input: Input;
  me: Player;
  remotes: Remotes;
  camera: THREE.PerspectiveCamera;
  hudRoot: HTMLElement;
  nameOf(sid: number): string;
  toast(text: string): void;
}

export class VolleyClient {
  /** Salonda mıyım. */
  active = false;
  private s: VolleyState = { phase: "free", teams: emptyTeams(), score: [0, 0], target: 0, server: 0, until: 0, side: -1, touches: 0, note: "" };
  /** Sahadaki toplar: 0 maç topu, diğerleri antrenmanda çağıranın sid'iyle. */
  private balls = new Map<number, BallView>();
  private power = 8;
  private setType: SetType = "normal";
  private mode: "spike" | "block" = "spike";
  private stamina = STAMINA_MAX;
  /** Sprint tuşu basılı mıydı ve bu basışta sprint hakkı var mı. */
  private runHeld = false;
  private sprinting = false;
  private lastDive = -Infinity;
  /** Son dokunuşun zamanı (performance.now, ms): bekleme süresinde vuruş hiç gitmez, top yerelde de oynamaz. */
  private lastTouch = -Infinity;
  private diveUntil = -Infinity;
  private diveHit = false;
  private jumpSeq = -1;
  /** Sunucuya son bildirilen yatış (yana, öne) ve uzak oyuncuların yatış hedefleri. */
  private sentLean = 0;
  private sentPitch = 0;
  private leans = new Map<number, { v: number; f: number }>();
  /** Servis: topu havaya atarken seçilen falso (null: nokta hâlâ gidip geliyor). */
  private spinLock: number | null = null;
  /** Rüzgar rengim ve şu an topun arkasındaki iz (null yok). */
  private windColor = WINDS[0][0];
  private menuTab: MenuTab = "pos";
  private lastWarn = -Infinity;
  /** Önceki karedeki konum (dalış yönü). */
  private prevX = 0;
  private prevZ = 0;
  private dir = new THREE.Vector3();
  private lastKeys = 0;
  // HUD
  private root: HTMLDivElement;
  private scoreEl: HTMLDivElement;
  private infoEl: HTMLDivElement;
  private ballEl: HTMLDivElement;
  private dot: SVGCircleElement;
  private powFill: HTMLDivElement;
  private powText: HTMLSpanElement;
  private staFill: HTMLDivElement;
  private staText: HTMLSpanElement;
  private modeEl: HTMLElement;
  private setEl: HTMLElement;
  private keyEls: { a: Action; e: HTMLElement }[] = [];
  private help: HTMLDivElement;
  private exitBtn: HTMLButtonElement;
  private teamBtn: HTMLButtonElement;
  private panel: Panel;
  private offBinds: () => void;

  constructor(private d: VolleyDeps) {
    try {
      const p = Number(localStorage.getItem(POWER_KEY));
      if (p >= POWER_MIN && p <= POWER_MAX) this.power = p;
      const st = localStorage.getItem(SET_KEY) as SetType | null;
      if (st && SET_TYPES.includes(st)) this.setType = st;
      const w = localStorage.getItem(WIND_KEY);
      if (w && /^#[0-9a-f]{6}$/i.test(w)) this.windColor = w;
    } catch {
      // depolama kapalı
    }
    this.balls.set(0, new BallView(d.scene, { x: VOLLEY_COURT.x - 3, y: V_BALL_R, z: VOLLEY_COURT.z, vx: 0, vy: 0, vz: 0, at: 0 }));

    const hud = d.hudRoot;
    this.root = el("div", "vb-hud", hud);
    const top = el("div", "vb-top", this.root);
    this.scoreEl = el("div", "vb-score", top);
    this.infoEl = el("div", "vb-info", top);
    // Alt panel (4.2 düzeni): üstte falso topu, ortada güç ve stamina, yanlarda zıplama ve pas türü
    const bars = el("div", "vb-bars", this.root);
    this.ballEl = el("div", "vb-ball", bars);
    this.ballEl.innerHTML =
      `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#fff" stroke="#111" stroke-width="5"/>` +
      `<path d="M50 6 C34 30 34 70 50 94 M8 38 C34 46 66 46 92 38 M20 82 C40 62 62 56 92 62 M56 7 C70 26 84 40 94 46" fill="none" stroke="#111" stroke-width="4"/>` +
      `<circle class="vb-dot" r="8" fill="#ff1a1a"/></svg>`;
    this.dot = this.ballEl.querySelector(".vb-dot")!;
    const row = el("div", "vb-row", bars);
    const key = (parent: HTMLElement, a: Action, hidden = false) => {
      const k = el("span", "vb-key", parent);
      if (hidden) k.style.visibility = "hidden";
      else this.keyEls.push({ a, e: k });
      return k;
    };
    const left = el("div", "vb-side", row);
    key(left, "vMode");
    const lt = el("span", "", left);
    el("small", "", lt, "ZIPLAMA:");
    this.modeEl = el("b", "", lt);
    const meters = el("div", "vb-meters", row);
    const meter = (cls: string, label: string, keys: [Action, Action] | null) => {
      const r = el("div", "vb-meter-row", meters);
      key(r, keys?.[0] ?? "vPowDown", !keys);
      const m = el("div", `vb-meter ${cls}`, r);
      const fill = el("div", "vb-meter-fill", m);
      const text = el("div", "vb-meter-text", m);
      el("span", "", text, label);
      const val = el("span", "", text);
      key(r, keys?.[1] ?? "vPowUp", !keys);
      return [fill, val] as const;
    };
    [this.powFill, this.powText] = meter("pow", "GÜÇ", ["vPowDown", "vPowUp"]);
    [this.staFill, this.staText] = meter("sta", "STAMİNA", null);
    const right = el("div", "vb-side", row);
    const rt = el("span", "", right);
    el("small", "", rt, "PAS TÜRÜ:");
    this.setEl = el("b", "", rt);
    key(right, "vSetType");
    this.help = el("div", "fb-help vb-help", hud);
    this.exitBtn = el("button", "battle-exit fb-exit", hud, "🏠 Dünyaya dön");
    this.exitBtn.addEventListener("click", () => this.goHome());
    this.teamBtn = el("button", "battle-switch", hud, "🏐 Menü");
    this.teamBtn.addEventListener("click", () => this.togglePos());
    this.panel = new Panel(hud, "🏐 VOLEYBOL", "vb-menu");
    this.offBinds = onBinds(() => this.renderHelp());

    const { net } = d;
    net.onVball = (b) => this.onBall(b);
    net.onVgone = (id) => {
      this.balls.get(id)?.dispose();
      if (id) this.balls.delete(id);
    };
    net.onVstate = (s) => this.onState(s);
    net.onVact = (sid, a, v, f) => {
      if (sid === net.you) return;
      if (a === "lean") this.leans.set(sid, { v: v ?? 0, f: f ?? 0 });
      else this.poseOf(sid, a);
    };
  }

  dispose(): void {
    this.offBinds();
    for (const v of this.balls.values()) v.dispose();
    this.balls.clear();
    for (const e of [this.root, this.help, this.exitBtn, this.teamBtn, this.panel.root]) e.remove();
    if (profile === "volley") setProfile("world");
  }

  /** Menüdeki 🏐: salondaysa pozisyon menüsü, değilse salona ışınlan. */
  menu(): void {
    if (this.active) this.togglePos();
    else if (this.d.me.driving) this.d.toast("🏐 Önce tanktan in.");
    else this.d.net.send({ t: "vgo" });
  }

  private get you(): number {
    return this.d.net.you;
  }

  /** Şu oyuncunun elinde tuttuğu / servis için havaya attığı top. */
  private heldBy(sid: number): BallView | undefined {
    for (const v of this.balls.values()) if (v.msg.hold === sid) return v;
  }

  private tossedBy(sid: number): BallView | undefined {
    for (const v of this.balls.values()) if (v.msg.toss === sid) return v;
  }

  private myTeam(): 0 | 1 | null {
    const t = this.s.teams, you = this.you;
    if (!you) return null;
    return t[0].includes(you) ? 0 : t[1].includes(you) ? 1 : null;
  }

  // ---------------------------------------------------------------------------
  // Ağ
  // ---------------------------------------------------------------------------

  private onBall(b: BallMsg): void {
    const id = b.id ?? 0;
    let v = this.balls.get(id);
    const was = v?.msg;
    if (!v) this.balls.set(id, (v = new BallView(this.d.scene, b)));
    v.set(b);
    if (b.toss && b.toss !== was?.toss && b.toss !== this.you && this.active) sfx.pop();
    const kind = b.ev as VolleyHit;
    // Sunucunun onayladığı dokunuş (yerelde çizilmemiş olsa bile) beklemeyi başlatır
    if (b.by === this.you && ["bump", "set", "spike", "dump", "serve"].includes(kind)) this.lastTouch = Math.max(this.lastTouch, performance.now());
    if (!b.ev || !b.by || b.by === this.you) return;
    if (["bump", "set", "spike", "dump", "serve"].includes(kind)) this.poseOf(b.by, POSE[kind]);
    if (!this.active) return;
    const gain = falloff(Math.hypot(b.x - this.d.me.x, b.z - this.d.me.z));
    if (b.ev === "spike") sfx.kick(gain);
    else if (b.ev === "block") sfx.post(gain);
    else if (b.ev === "serve") sfx.kick(0.7 * gain);
    else if (b.ev !== "net" && b.ev !== "floor" && b.ev !== "wall") sfx.header(0.8 * gain);
  }

  private onState(s: VolleyState): void {
    const was = this.s;
    this.s = s;
    if (this.panel.isOpen) this.renderPos();
    if (!this.active) return;
    const name = (t: number) => (t ? "🔵 Mavi" : "🔴 Kırmızı");
    if (s.target && !was.target) {
      sfx.whistle();
      const t = this.myTeam();
      this.d.toast(`🏐 Maç başladı (${s.target} sayı)!${t === null ? "" : ` Takımın: ${name(t)}`}`);
    } else if (!s.target && was.target) {
      sfx.whistle();
      sfx.cheer(0.6);
      if (s.note) this.d.toast(`🏆 ${s.note}`);
    } else if (s.target && (s.score[0] !== was.score[0] || s.score[1] !== was.score[1])) {
      const w = s.score[0] !== was.score[0] ? 0 : 1;
      sfx.whistle();
      if (w === this.myTeam()) sfx.cheer(0.35);
      this.d.toast(`🏐 Sayı ${name(w)}${s.note ? ` · ${s.note}` : ""} · ${s.score[0]}–${s.score[1]}`);
    }
    if (s.phase === "serve" && (was.phase !== "serve" || was.server !== s.server) && s.server === this.you) {
      this.d.toast(`🏐 Servis sende! ${actionLabel("vHit")}: topu havaya at, düşerken ${actionLabel("vHit")}: vur · koşup zıplarsan smaç servis`);
    }
  }

  /** Uzak oyuncunun kol/gövde hareketi. */
  private poseOf(sid: number, kind: VolleyPose): void {
    const r = this.d.remotes.map.get(sid);
    if (r) r.vpose = { kind, at: performance.now() / 1000 };
  }

  // ---------------------------------------------------------------------------
  // Tuşlar (oyuncu güncellemesinden önce)
  // ---------------------------------------------------------------------------

  keys(time: number): void {
    const { input, me, net } = this.d;
    const dt = Math.min(0.1, Math.max(0, time - this.lastKeys));
    this.lastKeys = time;
    const k = (a: Action) => input.consumeKey(a);
    const hit = k("vHit"), mode = k("vMode"), dump = k("vDump"), dive = k("vDive"), setF = k("vSetF"), setB = k("vSetB");
    const down = k("vPowDown"), up = k("vPowUp"), p1 = k("vPow1"), p8 = k("vPow8"), p15 = k("vPow15");
    const serve = k("vServe"), toss = k("vToss"), team = k("vTeam"), setType = k("vSetType");
    if (!this.active) {
      this.runHeld = this.sprinting = false;
      return;
    }
    if (team) this.togglePos();
    if (down || up) this.setPower(this.power + (up ? 1 : 0) - (down ? 1 : 0));
    if (p1) this.setPower(1);
    if (p8) this.setPower(8);
    if (p15) this.setPower(POWER_MAX);
    if (mode) {
      this.mode = this.mode === "spike" ? "block" : "spike";
      sfx.tile();
    }
    if (setType) {
      this.setType = SET_TYPES[(SET_TYPES.indexOf(this.setType) + 1) % SET_TYPES.length];
      sfx.tile();
      try {
        localStorage.setItem(SET_KEY, this.setType);
      } catch {
        // depolama kapalı
      }
    }
    // Maçta arka sıra oyuncusu hücum çizgisinin önünde zıplayamaz (smaç ve blok yok)
    const mine = this.myTeam();
    if (this.s.target && mine !== null && me.jumpY <= 0 && isBackRow(this.s.teams[mine].indexOf(this.you)) && Math.abs(me.x - VOLLEY_COURT.x) < ATTACK_LINE && input.consumeJump()) {
      if (time - this.lastWarn > 2) this.d.toast("🏐 Arka sıradasın: hücum çizgisinin önünde zıplayamazsın.");
      this.lastWarn = time;
    }
    // Sprint: her basış bir stamina; stamina yoksa koşulamaz. Dururken çabuk, yürürken yavaş dolar.
    const moving = Math.abs(input.moveX) + Math.abs(input.moveY) > 0.15;
    const held = input.run;
    if (held && !this.runHeld) {
      this.sprinting = this.stamina >= 1;
      if (this.sprinting) this.stamina -= 1;
      else this.d.toast("🏐 Stamina yok, biraz dinlen.");
    }
    if (!held) this.sprinting = false;
    this.runHeld = held;
    input.run = this.sprinting;
    if (!(this.sprinting && moving)) this.stamina = Math.min(STAMINA_MAX, this.stamina + (moving ? WALK_REGEN : STAND_REGEN) * dt);
    if (me.seated || me.vehicle || me.driving) return;
    const air = me.jumpY > AIR;
    if (this.heldBy(this.you) && (hit || serve)) this.lift();
    else if (this.tossedBy(this.you) && (hit || serve)) this.hit("serve");
    else {
      if (hit) {
        if (!air) this.hit("bump");
        else if (this.mode === "spike") this.hit("spike");
      }
      if (setF) this.hit("set");
      if (setB) this.hit("set", Math.PI);
      if (dump && air) this.hit("dump");
      // Antrenmanda kendi topunu servis için ele al (maçta sırası gelen maç topunu zaten tutar)
      if (serve && !this.s.target) net.send({ t: "vhold" });
    }
    if (toss && !this.s.target) {
      net.send({ t: "vtoss" });
      sfx.pop();
    }
    if (dive && !air && time - this.lastDive > DIVE.cooldown) {
      this.lastDive = time;
      this.diveUntil = time + DIVE.window;
      this.diveHit = false;
      // Gidilen yöne (tuş yoksa baktığı yöne) uzanır
      const mx = me.x - this.prevX, mz = me.z - this.prevZ;
      const ang = moving && Math.hypot(mx, mz) > 1e-3 ? Math.atan2(mx, mz) : me.rot;
      me.rot = ang;
      me.dash(Math.sin(ang) * DIVE.speed, Math.cos(ang) * DIVE.speed, DIVE.t);
      me.vpose = { kind: "dive", at: performance.now() / 1000 };
      net.send({ t: "vdive", dir: ang });
      sfx.bump(0.5);
    }
  }

  private setPower(p: number): void {
    const v = Math.max(POWER_MIN, Math.min(POWER_MAX, p));
    if (v === this.power) return;
    this.power = v;
    sfx.tile();
    try {
      localStorage.setItem(POWER_KEY, String(v));
    } catch {
      // depolama kapalı
    }
  }

  /** Falso noktası (-1 sol … 1 sağ): seçildiyse o, yoksa sürekli gidip gelir. */
  private dotSpin(): number {
    return this.spinLock ?? Math.sin((performance.now() / 1000) * DOT_SPEED);
  }

  /** Elindeki servis topunu havaya at: güç 1–3'te nokta o an durur ve falsoyu belirler. */
  private lift(): void {
    const { me, net } = this.d;
    const spin = this.power <= LOB_POWER ? Math.round(this.dotSpin() * 100) / 100 : 0;
    this.spinLock = spin;
    me.rot = this.aim();
    me.vpose = { kind: "set", at: performance.now() / 1000 };
    net.send({ t: "vlift", spin });
    sfx.pop();
  }

  /** Kameranın baktığı yatay yön (radyan). */
  private aim(): number {
    this.d.camera.getWorldDirection(this.dir);
    return Math.atan2(this.dir.x, this.dir.z);
  }

  /**
   * Vuruş: yön kameradan (pas geriye ise ters), güç seviyesi, pas türü; servis topuna seçilen falso. Top
   * yerelde menzildeyse (havada yatınca menzil o yana kayar) yeni yay hemen çizilir; sunucu onaylayınca kendi
   * yayı gelir, reddederse top eski yoluna döner. Sunucunun kesin reddedeceği vuruşlar (filenin karşısındaki top,
   * karşılanmamış servise smaç) yerelde çizilmez; dokunuştan sonraki beklemede vuruş hiç gönderilmez.
   */
  private hit(kind: VolleyHit, turn = 0, dive = false): void {
    const { me, net } = this.d;
    const serve = kind === "serve", air = me.jumpY > AIR;
    const dir = this.aim() + turn;
    const spin = serve && !air && this.power <= LOB_POWER ? (this.spinLock ?? 0) : 0;
    me.rot = kind === "set" && turn ? dir - Math.PI : dir;
    me.vpose = { kind: serve ? (air || this.power > LOB_POWER ? "spike" : "bump") : POSE[kind], at: performance.now() / 1000 };
    if (performance.now() - this.lastTouch < TOUCH_COOLDOWN_MS) return;
    net.send({ t: "vhit", kind, dir, p: this.power, ...(dive ? { dive: true } : {}), ...(kind === "set" ? { st: this.setType } : {}) });
    const [ox, oz] = air ? leanShift(dir, me.leanDir, me.pitchDir) : [0, 0];
    const px = me.x + ox, pz = me.z + oz;
    const r = REACH[dive ? "dive" : serve ? (air ? "spike" : "serve") : kind];
    // Servis kendi attığı topa; diğer vuruşlar kendi yarısındaki menzildeki en yakın serbest topa
    const side = (this.myTeam() ?? halfOf(me.x)) === 0 ? -1 : 1, attack = kind === "spike" || kind === "dump";
    let best: BallView | undefined, bd = Infinity;
    for (const v of this.balls.values()) {
      const b = v.shown, d = Math.hypot(b.x - px, b.z - pz);
      const free = !v.msg.hold && (serve ? v.msg.toss === this.you : !v.msg.toss && !(attack && v.msg.sv) && side * (b.x - VOLLEY_COURT.x) >= -V_BALL_R);
      if (free && d <= r.r && b.y >= r.lo && b.y <= r.hi && d < bd) [best, bd] = [v, d];
    }
    if (!best) return;
    this.lastTouch = performance.now();
    const b = best.shown;
    const nb: BallMsg = { id: best.msg.id, x: b.x, y: b.y, z: b.z, vx: 0, vy: 0, vz: 0, at: net.serverNow() };
    hitBall(nb, kind, dir, this.power, 0, spin, this.setType, air ? 1 - me.pitchDir * PITCH_DEPTH : 1, serve && air);
    best.msg = nb;
    best.liveWind = this.power > WIND_POWER ? this.windColor : null;
    if (kind === "spike" || (serve && air)) sfx.kick(1);
    else if (serve) sfx.kick(0.7);
    else sfx.header(0.8);
  }

  // ---------------------------------------------------------------------------
  // Kare başına (oyuncu güncellemesinden sonra)
  // ---------------------------------------------------------------------------

  update(dt: number, time: number, serverNow: number): void {
    const { me, net } = this.d;
    const here = inVolley(me.x, me.z);
    if (here !== this.active) this.enter(here);
    if (!here) for (const v of this.balls.values()) v.hide();
    // Blok: blok modunda fileye yakın zıplayınca
    const seq = me.flags & JUMP_MASK;
    if (seq !== this.jumpSeq) {
      if (this.jumpSeq >= 0 && here && this.mode === "block" && Math.abs(me.x - VOLLEY_COURT.x) < 1.6) {
        net.send({ t: "vblock" });
        me.vpose = { kind: "block", at: performance.now() / 1000 };
      }
      this.jumpSeq = seq;
    }
    if (!here) return;
    // Havada yatış (yana ve öne): sunucu menzili kaydırır, herkes çizer
    if (me.leanDir !== this.sentLean || me.pitchDir !== this.sentPitch) {
      this.sentLean = me.leanDir;
      this.sentPitch = me.pitchDir;
      net.send({ t: "vlean", v: me.leanDir, f: me.pitchDir });
    }
    const k = 1 - Math.exp(-dt * 12);
    for (const [sid, t] of this.leans) {
      const r = this.d.remotes.map.get(sid);
      if (!r) {
        this.leans.delete(sid);
        continue;
      }
      r.vlean += (t.v - r.vlean) * k;
      r.vpitch += (t.f - r.vpitch) * k;
      if (!t.v && !t.f && Math.abs(r.vlean) + Math.abs(r.vpitch) < 0.01) {
        r.vlean = r.vpitch = 0;
        this.leans.delete(sid);
      }
    }
    // Kolların duruşu: servis topunu tutan önde tutar, havadaki smaççı sağ kolunu geride hazırlar
    const holders = new Set<number>();
    for (const v of this.balls.values()) if (v.msg.hold) holders.add(v.msg.hold);
    me.vstance = holders.has(this.you) ? "hold" : this.mode === "spike" && me.jumpY > 0.3 ? "cock" : null;
    for (const [sid, r] of this.d.remotes.map) {
      r.vstance = !inVolley(r.x, r.z) ? null : holders.has(sid) ? "hold" : r.jumpY > 0.3 && r.vpose?.kind !== "block" ? "cock" : null;
    }
    if (!holders.has(this.you) && !this.tossedBy(this.you)) this.spinLock = null;
    // Maçta kendi yarında kal (servisçi çizginin arkasına da geçebilir)
    const team = this.myTeam();
    if (this.s.target && team !== null) {
      const cx = VOLLEY_COURT.x;
      me.x = team === 0 ? Math.min(me.x, cx - 0.35) : Math.max(me.x, cx + 0.35);
    }
    const holder = (sid: number) => (sid === this.you ? this.d.me : this.d.remotes.map.get(sid));
    for (const v of this.balls.values()) v.update(dt, time, serverNow, this.d.camera.position, holder);
    // Dalışta bir top yakına gelirse kendiliğinden manşet
    if (time < this.diveUntil && !this.diveHit) {
      const r = REACH.dive;
      for (const v of this.balls.values()) {
        const b = v.shown;
        if (Math.hypot(b.x - me.x, b.z - me.z) <= r.r && b.y <= r.hi && !v.msg.hold && !v.msg.toss) {
          this.diveHit = true;
          this.hit("bump", 0, true);
          break;
        }
      }
    }
    this.prevX = me.x;
    this.prevZ = me.z;
    this.hud(serverNow);
  }

  private enter(on: boolean): void {
    this.active = on;
    this.d.me.volley = on;
    setProfile(on ? "volley" : "world");
    this.root.classList.toggle("show", on);
    this.exitBtn.classList.toggle("show", on);
    this.teamBtn.classList.toggle("show", on);
    this.d.hudRoot.classList.toggle("volley", on);
    const keys = on && !this.d.input.touch;
    this.help.classList.toggle("show", keys);
    if (!on) {
      this.panel.close();
      if (this.sentLean || this.sentPitch) this.d.net.send({ t: "vlean", v: 0, f: 0 });
      this.sentLean = this.sentPitch = 0;
      this.d.me.vstance = null;
    } else {
      this.d.net.send({ t: "vwind", c: this.windColor });
      this.renderHelp();
      this.d.toast(
        this.d.input.touch
          ? "🏐 Voleybol salonundasın! Pozisyon, maç ve özelleştirme için 🏐 Menü."
          : `🏐 Voleybol salonu! ${actionLabel("vTeam")}: menü (pozisyon, maç, özelleştirme) · ${actionLabel("vToss")}: kendine top at · ${actionLabel("vServe")}: servis topunu al.`,
      );
    }
  }

  private hud(serverNow: number): void {
    const s = this.s, team = this.myTeam();
    this.scoreEl.innerHTML = s.target
      ? `<b class="vb-red">🔴 ${s.score[0]}</b> – <b class="vb-blue">${s.score[1]} 🔵</b> <small>${s.target} sayı</small>`
      : "🏐 Antrenman";
    let info: string;
    const holding = !!this.heldBy(this.you), tossed = !!this.tossedBy(this.you);
    if (holding) info = `${actionLabel("vHit")}: topu havaya at${this.power <= LOB_POWER ? " (nokta durur, falso)" : ""} · ${serveName(this.power)}`;
    else if (tossed) info = `${actionLabel("vHit")}: vur · havadaysan ${serveName(this.power, true)}`;
    else if (!s.target) info = `${actionLabel("vTeam")}: menü · ${actionLabel("vToss")}: top at · ${actionLabel("vServe")}: servis topu`;
    else if (s.phase === "serve") {
      const left = Math.max(0, Math.ceil((s.until - serverNow) / 1000));
      info = s.server === this.you ? `Servis sende · ${left} sn` : `Servis: ${this.d.nameOf(s.server)} · ${left} sn`;
    } else if (s.phase === "rally") info = s.side === -1 ? "" : `${s.side ? "🔵" : "🔴"} dokunuş ${s.touches}/3${team === null ? " · izliyorsun" : ""}`;
    else info = s.note ? `Sayı · ${s.note}` : "Hazırlan…";
    if (this.infoEl.textContent !== info) this.infoEl.textContent = info;
    // Güç ve stamina
    this.powFill.style.width = `${(this.power / POWER_MAX) * 100}%`;
    const pt = `${this.power} / ${POWER_MAX}`;
    if (this.powText.textContent !== pt) this.powText.textContent = pt;
    this.staFill.style.width = `${(this.stamina / STAMINA_MAX) * 100}%`;
    this.staFill.classList.toggle("low", this.stamina < 1);
    const st = `${Math.floor(this.stamina)} / ${STAMINA_MAX}`;
    if (this.staText.textContent !== st) this.staText.textContent = st;
    const m = this.mode === "spike" ? "SMAÇ" : "BLOK";
    if (this.modeEl.textContent !== m) this.modeEl.textContent = m;
    const sn = SET_NAMES[this.setType];
    if (this.setEl.textContent !== sn) this.setEl.textContent = sn;
    // Falso topu (servis, güç 1–3): kırmızı nokta topa nereden vurulacağı; sağa sola gidip gelir, top havaya
    // atılınca durur
    const lob = this.power <= LOB_POWER && (holding || tossed);
    this.ballEl.classList.toggle("show", lob);
    this.ballEl.classList.toggle("locked", lob && this.spinLock !== null);
    if (lob) {
      const a = Math.PI / 2 + this.dotSpin() * 1.1;
      this.dot.setAttribute("cx", (50 + Math.cos(a) * 34).toFixed(1));
      this.dot.setAttribute("cy", (50 + Math.sin(a) * 34).toFixed(1));
    }
    this.d.court.setBoard(s.score, s.target, s.target ? (s.phase === "serve" ? `Servis: ${this.d.nameOf(s.server)}` : s.note) : `Antrenman · ${actionLabel("vTeam")}: pozisyon`);
  }

  /** Tuş ipucu şeridi ve alt paneldeki tuşlar: geçerli atamalarla. */
  private renderHelp(): void {
    if (profile !== "volley") return;
    for (const { a, e } of this.keyEls) e.textContent = actionLabel(a);
    const k = (a: Action) => `<b>${actionLabel(a)}</b>`;
    this.help.innerHTML =
      `${k("vHit")} Manşet · havada Smaç · ${k("vSetF")}/${k("vSetB")} Pas · ${k("vDump")} Dump · ${k("vDive")} Dalış · ` +
      `${k("vPow1")}/${k("vPow8")}/${k("vPow15")} Güç 1/8/15 · ${k("vServe")} Servis topu (${k("vHit")} at, ${k("vHit")} vur) · ${k("run")} Sprint · ` +
      `havada WASD yatış · ${k("vToss")} Top at · ${k("vTeam")} Menü <button type="button">⌨️ Tuşlar</button>`;
    this.help.querySelector("button")?.addEventListener("click", () => dispatchEvent(new Event("gap:keys")));
  }

  private goHome(): void {
    this.panel.close();
    this.d.net.send({ t: "vhome" });
  }

  private togglePos(): void {
    if (this.panel.isOpen) return this.panel.close();
    this.renderPos();
    this.panel.open();
  }

  /** Voleybol menüsü: sekmeler (pozisyon, maç, özelleştirme) ve seçili sekme. */
  private renderPos(): void {
    const b = this.panel.body;
    b.replaceChildren();
    const tabs = el("div", "vb-tabs", b);
    const tabNames: [MenuTab, string][] = [["pos", "POZİSYON"], ["match", "MAÇ"], ["style", "ÖZELLEŞTİRME"]];
    for (const [t, name] of tabNames) {
      button(tabs, name, () => {
        this.menuTab = t;
        this.renderPos();
      }, `vb-tab${this.menuTab === t ? " on" : ""}`);
    }
    const page = el("div", "vb-page", b);
    if (this.menuTab === "pos") this.renderSlots(page);
    else if (this.menuTab === "match") this.renderMatch(page);
    else this.renderStyle(page);
    button(b, "🏠 Dünyaya dön", () => this.goHome(), "fb-team-btn fb-team-home");
  }

  /**
   * Pozisyonlar (4.2 gibi kuşbakışı saha): solda kırmızı, sağda mavi; fileye yakın sütun ön sıra. Boş
   * pozisyona tıklayan oraya geçer.
   */
  private renderSlots(b: HTMLElement): void {
    const s = this.s, mine = this.myTeam(), net = this.d.net, you = this.you;
    const court = el("div", "vb-court", b);
    for (const t of [0, 1] as const) {
      const half = el("div", `vb-half h${t}`, court);
      for (let r = 0; r < 3; r++) {
        for (const slot of t === 0 ? [3 + r, r] : [r, 3 + r]) {
          const sid = s.teams[t][slot] ?? 0;
          const name = sid ? this.d.nameOf(sid) : "";
          const cls = `vb-slot t${t}${sid ? "" : " free"}${sid && sid === you ? " me" : ""}`;
          const btn = button(half, sid ? name.slice(0, 12) : "+", () => net.send({ t: "vpos", team: t, slot }), cls);
          btn.title = `${t ? "🔵 Mavi" : "🔴 Kırmızı"} · ${SLOT_NAMES[slot]}${name ? ` · ${name}` : ""}`;
          btn.disabled = !!sid && sid !== you;
        }
      }
    }
    el("div", "settings-note", b, "Boş bir pozisyona tıkla, oraya geçersin. Fileye yakın sütun ön sıra; arka sıra hücum çizgisinin önünde zıplayamaz.");
    if (mine !== null) button(b, "👀 İzleyiciye geç", () => net.send({ t: "vpos", team: mine, slot: -1 }), "fb-team-btn");
  }

  /** Maç: skor, başlat (7/15/25) ya da bitir. */
  private renderMatch(b: HTMLElement): void {
    const s = this.s, mine = this.myTeam(), net = this.d.net;
    const n = (t: 0 | 1) => s.teams[t].filter((x) => x > 0).length;
    el("div", "vb-match-score", b).innerHTML = s.target
      ? `<b class="vb-red">🔴 ${s.score[0]}</b> – <b class="vb-blue">${s.score[1]} 🔵</b><small>${s.target} sayılık set sürüyor</small>`
      : `<b class="vb-red">🔴 ${n(0)}</b> v <b class="vb-blue">${n(1)} 🔵</b><small>maç yok · antrenman</small>`;
    if (!s.target) {
      el("div", "settings-note", b, "Maç başlat: pozisyonsuzlar az kişili takıma girer (en fazla 6v6). Set iki farkla biter.");
      const starts = el("div", "fb-team-row", b);
      for (const t of VOLLEY_TARGETS) {
        button(starts, `▶ ${t} sayı`, () => {
          net.send({ t: "vstart", target: t });
          this.panel.close();
        }, "fb-team-btn vb-start");
      }
    } else if (mine !== null) {
      button(b, "⏹ Maçı bitir", () => {
        net.send({ t: "vstop" });
        this.panel.close();
      }, "fb-team-btn");
    } else el("div", "settings-note", b, "Maçı yalnızca oyuncular bitirebilir.");
  }

  /** Özelleştirme: sert vuruşların (güç 13+) rüzgar izinin rengi. */
  private renderStyle(b: HTMLElement): void {
    el("div", "vb-style-title", b, "💨 RÜZGAR EFEKTİ");
    el("div", "settings-note", b, `Güç ${WIND_POWER}'den yüksek vuruşta topun arkasında bu renkte rüzgar izi çıkar; herkes görür.`);
    const preview = el("div", "vb-wind-preview", b);
    preview.style.setProperty("--wind", this.windColor);
    const grid = el("div", "vb-swatches", b);
    for (const [c, name] of WINDS) {
      const sw = button(grid, "", () => this.setWind(c), `vb-swatch${c === this.windColor ? " on" : ""}`);
      sw.style.setProperty("--wind", c);
      sw.title = name;
      sw.setAttribute("aria-label", name);
    }
    const custom = el("label", "vb-custom", b, "Özel renk ");
    const input = el("input", "", custom);
    input.type = "color";
    input.value = this.windColor;
    input.addEventListener("change", () => this.setWind(input.value));
  }

  private setWind(c: string): void {
    if (!/^#[0-9a-f]{6}$/i.test(c)) return;
    this.windColor = c.toLowerCase();
    sfx.tile();
    try {
      localStorage.setItem(WIND_KEY, this.windColor);
    } catch {
      // depolama kapalı
    }
    this.d.net.send({ t: "vwind", c: this.windColor });
    if (this.panel.isOpen) this.renderPos();
  }
}

const HIT_EVS: readonly VolleyEv[] = ["bump", "set", "spike", "dump", "serve"];

/** Dokular bir kez çizilir, bütün toplarda paylaşılır. */
const once = <T>(make: () => T): (() => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};
const BALL_TEX = once(() => ballTexture());
const GUST_TEX = once(() => gustTexture());
const MARK_TEX = once(() => markTexture());

/**
 * Sahadaki bir top: sunucunun yayı (aynı fizikle araya), yerdeki gölgesi, sert vuruşta rüzgar izi ve yolu,
 * yere ilk değdiği yerdeki iz ve rüzgar patlaması.
 */
class BallView {
  /** Son bilinen top (sunucu zamanında `at`); yerel vuruş tahmini de buraya yazılır. */
  msg: BallMsg;
  shown: THREE.Vector3;
  /** Sert vuruşun rüzgar rengi (top bir yere değene kadar). */
  liveWind: string | null = null;
  private pred: VBall = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  private mesh: THREE.Mesh;
  private shadow: THREE.Mesh;
  private trail = new WindTrail();
  private path = new WindPath();
  private impact = new WindImpact();
  /** Topun son düştüğü yerdeki iz; top bu vuruştan sonra yere değdi mi. */
  private mark: THREE.Mesh;
  private markAt = -Infinity;
  private landed = true;
  private tmp = new THREE.Vector3();
  private axis = new THREE.Vector3();

  constructor(private scene: THREE.Scene, b: BallMsg) {
    this.msg = b;
    this.shown = new THREE.Vector3(b.x, b.y, b.z);
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(V_BALL_R, 20, 14), new THREE.MeshLambertMaterial({ map: BALL_TEX() }));
    this.mesh.castShadow = true;
    this.mesh.position.copy(this.shown);
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(V_BALL_R * 1.1, 18).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.mark = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 28).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: MARK_TEX(), transparent: true, opacity: 0, depthWrite: false }),
    );
    this.mark.renderOrder = 1;
    this.mark.visible = false;
    scene.add(this.mesh, this.shadow, this.trail.mesh, this.path.mesh, this.impact.group, this.mark);
  }

  /** Sunucudan gelen top. */
  set(b: BallMsg): void {
    this.msg = b;
    // İlk düştüğü yere iz; sert vuruşla gelen top orada rüzgar patlaması yapar
    if (b.ev === "floor" && !this.landed) {
      this.landed = true;
      this.mark.position.set(b.x, 0.03, b.z);
      this.markAt = performance.now() / 1000;
      if (this.liveWind) this.impact.fire(b.x, b.z, this.liveWind);
    }
    if ((b.ev && HIT_EVS.includes(b.ev)) || b.hold || b.toss) this.landed = false;
    // Rüzgar izi: sert vuruşla başlar, top bir yere değince (ya da yeni vuruşta) biter
    if (b.ev) this.liveWind = HIT_EVS.includes(b.ev) ? (b.w ?? null) : null;
    if (b.hold || b.toss) this.liveWind = null;
  }

  update(dt: number, time: number, serverNow: number, cam: THREE.Vector3, holder: (sid: number) => { x: number; z: number; rot: number; jumpY?: number } | undefined): void {
    const b = this.msg, shown = this.shown;
    this.mesh.visible = this.shadow.visible = true;
    if (b.hold) {
      // Servisçinin elinde: önde, uzattığı ellerin üstünde
      const p = holder(b.hold);
      if (p) shown.set(p.x + Math.sin(p.rot) * 0.5, 0.95 + (p.jumpY ?? 0), p.z + Math.cos(p.rot) * 0.5);
    } else {
      vPredict(b, Math.min(2.5, Math.max(0, (serverNow - b.at) / 1000)), this.pred);
      const p = this.pred;
      if (Math.hypot(p.x - shown.x, p.y - shown.y, p.z - shown.z) > 2.5) shown.set(p.x, p.y, p.z);
      else shown.lerp(this.tmp.set(p.x, p.y, p.z), 1 - Math.exp(-dt * 22));
    }
    // Dönme: gidilen yol kadar
    const dx = shown.x - this.mesh.position.x, dz = shown.z - this.mesh.position.z, dist = Math.hypot(dx, dz);
    this.mesh.position.copy(shown);
    if (dist > 1e-4 && dist < 2) this.mesh.rotateOnWorldAxis(this.axis.set(dz, 0, -dx).normalize(), dist / V_BALL_R);
    // Gölge: top yükseldikçe küçülür ve solar (nereye düşeceğini kestirmeye yarar)
    const h = Math.max(0, shown.y - V_BALL_R);
    this.shadow.position.set(shown.x, 0.035, shown.z);
    this.shadow.scale.setScalar(1 + h * 0.12);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.12, 0.4 - h * 0.05);
    this.trail.update(shown, cam, this.liveWind, dt, time);
    this.path.update(shown, cam, this.liveWind, dt);
    this.impact.update(dt);
    // Düşüş izi: 6 sn belirgin, sonra 2 sn'de solar
    const ma = 6 + 2 - (performance.now() / 1000 - this.markAt);
    this.mark.visible = ma > 0;
    (this.mark.material as THREE.MeshBasicMaterial).opacity = 0.75 * Math.min(1, ma / 2);
  }

  /** Salonda değilken hiçbiri çizilmez. */
  hide(): void {
    this.mesh.visible = this.shadow.visible = this.trail.mesh.visible = this.path.mesh.visible = this.impact.group.visible = this.mark.visible = false;
  }

  dispose(): void {
    const objs = [this.mesh, this.shadow, this.trail.mesh, this.path.mesh, this.mark, ...this.impact.group.children];
    this.scene.remove(this.mesh, this.shadow, this.trail.mesh, this.path.mesh, this.impact.group, this.mark);
    for (const o of objs) {
      if (!(o instanceof THREE.Mesh)) continue;
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
}

/**
 * Rüzgar izi: sert vuruşta topun arkasında kameraya dönük, uca doğru incelip solan bir şerit ve çevresinde
 * dönen iki ince rüzgar çizgisi (eklemeli karışım).
 */
class WindTrail {
  readonly mesh: THREE.Mesh;
  private pts: THREE.Vector3[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private color = new THREE.Color();
  private fade = 0;
  private t = new THREE.Vector3();
  private side = new THREE.Vector3();
  private view = new THREE.Vector3();
  private p1 = new THREE.Vector3();
  private p2 = new THREE.Vector3();
  private static N = 26;
  private static STRANDS = 3;

  constructor() {
    const N = WindTrail.N, S = WindTrail.STRANDS, verts = S * N * 2;
    this.pos = new Float32Array(verts * 3);
    this.col = new Float32Array(verts * 4);
    const idx: number[] = [];
    for (let s = 0; s < S; s++) {
      for (let i = 0; i < N - 1; i++) {
        const a = (s * N + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  update(ball: THREE.Vector3, cam: THREE.Vector3, color: string | null, dt: number, time: number): void {
    const N = WindTrail.N;
    this.fade = color ? Math.min(1, this.fade + dt * 8) : Math.max(0, this.fade - dt * 2.2);
    if (color) this.color.set(color);
    if (this.fade <= 0) {
      this.pts.length = 0;
      this.mesh.visible = false;
      return;
    }
    const head = this.pts.length ? this.pts[0] : null;
    if (!head || head.distanceToSquared(ball) > 1e-4) {
      this.pts.unshift((this.pts.length >= N ? this.pts.pop()! : new THREE.Vector3()).copy(ball));
    }
    const n = this.pts.length;
    this.mesh.visible = n > 1;
    if (n < 2) return;
    const { pos, col } = this;
    const c = this.color;
    for (let s = 0; s < WindTrail.STRANDS; s++) {
      for (let i = 0; i < N; i++) {
        const k = Math.min(i, n - 1);
        const p = this.pts[k];
        // Teğet ve kameraya dönük yan vektör
        const q = this.pts[Math.min(k + 1, n - 1)], r = this.pts[Math.max(k - 1, 0)];
        this.t.subVectors(r, q);
        if (this.t.lengthSq() < 1e-8) this.t.set(1, 0, 0);
        this.t.normalize();
        this.view.subVectors(cam, p).normalize();
        this.side.crossVectors(this.t, this.view);
        if (this.side.lengthSq() < 1e-8) this.side.set(0, 1, 0);
        this.side.normalize();
        const u = i / (N - 1), taper = 1 - u;
        let w: number, a: number;
        this.p1.copy(p);
        if (s === 0) {
          w = 0.17 * taper;
          a = 0.32 * taper * taper;
        } else {
          // Dönen rüzgar çizgisi: topun yolunun çevresinde sarmal
          this.p2.crossVectors(this.t, this.side).normalize();
          const th = time * 16 + i * 0.55 + (s === 2 ? Math.PI : 0), rad = 0.34 * (0.4 + 0.6 * taper);
          this.p1.addScaledVector(this.side, Math.cos(th) * rad).addScaledVector(this.p2, Math.sin(th) * rad);
          w = 0.06 * taper + 0.015;
          a = 0.85 * taper;
        }
        a *= this.fade * (k < i ? 0 : 1);
        const v = (s * N + i) * 2;
        for (let e = 0; e < 2; e++) {
          const o = (v + e) * 3, sg = e ? -w : w;
          pos[o] = this.p1.x + this.side.x * sg;
          pos[o + 1] = this.p1.y + this.side.y * sg;
          pos[o + 2] = this.p1.z + this.side.z * sg;
          const ci = (v + e) * 4;
          col[ci] = c.r;
          col[ci + 1] = c.g;
          col[ci + 2] = c.b;
          col[ci + 3] = a;
        }
      }
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}

/**
 * Rüzgarlı topun yolu: vuruştan düşene kadar topun geçtiği her yeri seçilen renkte ince, kameraya dönük bir şerit
 * olarak çizer; top bir yere değince solar.
 */
class WindPath {
  readonly mesh: THREE.Mesh;
  private pts: THREE.Vector3[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private color = new THREE.Color();
  private fade = 0;
  private live = false;
  private t = new THREE.Vector3();
  private side = new THREE.Vector3();
  private view = new THREE.Vector3();
  private static N = 240;

  constructor() {
    const N = WindPath.N;
    this.pos = new Float32Array(N * 2 * 3);
    this.col = new Float32Array(N * 2 * 4);
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  update(ball: THREE.Vector3, cam: THREE.Vector3, color: string | null, dt: number): void {
    const N = WindPath.N;
    // Yeni sert vuruş: yol baştan
    if (color && !this.live) this.pts.length = 0;
    this.live = !!color;
    if (color) this.color.set(color);
    this.fade = color ? 1 : Math.max(0, this.fade - dt * 0.9);
    if (this.fade <= 0) {
      this.pts.length = 0;
      this.mesh.visible = false;
      return;
    }
    if (color) {
      const last = this.pts[this.pts.length - 1];
      if (!last || last.distanceToSquared(ball) > 0.01) {
        if (this.pts.length >= N) this.pts.shift();
        this.pts.push(ball.clone());
      }
    }
    const n = this.pts.length;
    this.mesh.visible = n > 1;
    if (n < 2) return;
    const { pos, col } = this, c = this.color;
    for (let i = 0; i < N; i++) {
      const k = Math.min(i, n - 1), p = this.pts[k];
      this.t.subVectors(this.pts[Math.min(k + 1, n - 1)], this.pts[Math.max(k - 1, 0)]);
      if (this.t.lengthSq() < 1e-8) this.t.set(1, 0, 0);
      this.side.crossVectors(this.t.normalize(), this.view.subVectors(cam, p).normalize());
      if (this.side.lengthSq() < 1e-8) this.side.set(0, 1, 0);
      this.side.normalize();
      // Başta ince girer, yol boyunca sabit kalınlık
      const w = 0.035 * Math.min(1, (k + 1) / 6), a = i < n ? 0.85 * this.fade : 0;
      for (let e = 0; e < 2; e++) {
        const o = (i * 2 + e) * 3, sg = e ? -w : w;
        pos[o] = p.x + this.side.x * sg;
        pos[o + 1] = p.y + this.side.y * sg;
        pos[o + 2] = p.z + this.side.z * sg;
        const ci = (i * 2 + e) * 4;
        col[ci] = c.r;
        col[ci + 1] = c.g;
        col[ci + 2] = c.b;
        col[ci + 3] = a;
      }
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}

/**
 * Rüzgar patlaması: sert vuruşla gelen top yere değince düştüğü yerden dönerek genişleyen rüzgar halkaları ve
 * yükselip daralan bir girdap (eklemeli, seçilen renkte).
 */
class WindImpact {
  readonly group = new THREE.Group();
  private rings: THREE.Mesh[] = [];
  private t = Infinity;
  private static DUR = 0.9;

  constructor() {
    const tex = GUST_TEX();
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
      );
      m.renderOrder = 5;
      this.rings.push(m);
      this.group.add(m);
    }
    this.group.visible = false;
  }

  fire(x: number, z: number, color: string): void {
    this.group.position.set(x, 0.05, z);
    for (const r of this.rings) (r.material as THREE.MeshBasicMaterial).color.set(color);
    this.t = 0;
    this.group.visible = true;
  }

  update(dt: number): void {
    if (this.t >= WindImpact.DUR) {
      this.group.visible = false;
      return;
    }
    this.t += dt;
    this.rings.forEach((r, i) => {
      // 0–1: yerde genişleyen halkalar; 2–3: yükselip daralan girdap
      const rise = i >= 2, u = Math.max(0, Math.min(1, (this.t - (rise ? (i - 2) * 0.1 : i * 0.14)) / (WindImpact.DUR * 0.8)));
      const ease = 1 - (1 - u) * (1 - u);
      r.scale.setScalar(rise ? 1.6 - ease * 0.7 : 0.6 + ease * 5.2);
      r.position.y = rise ? ease * 1.6 : 0;
      r.rotation.y = (i % 2 ? -1 : 1) * this.t * 7;
      (r.material as THREE.MeshBasicMaterial).opacity = u <= 0 ? 0 : (1 - u) ** 1.5 * (rise ? 0.6 : 0.95);
    });
  }
}

/** Rüzgar halkası dokusu: ince halka ve içinde dönen kavisli çizgiler. */
function gustTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.translate(64, 64);
  g.strokeStyle = "#fff";
  g.lineCap = "round";
  g.globalAlpha = 0.9;
  g.lineWidth = 3;
  g.beginPath();
  g.arc(0, 0, 58, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2, r = 30 + (i % 3) * 9;
    g.globalAlpha = 0.55;
    g.lineWidth = 2 + (i % 2);
    g.beginPath();
    g.arc(0, 0, r, a, a + 1.1);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Düşüş izi dokusu: ortası koyu, kenara doğru solan leke ve ince açık halka. */
function markTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(0,0,0,0.85)");
  r.addColorStop(0.6, "rgba(0,0,0,0.55)");
  r.addColorStop(0.85, "rgba(0,0,0,0.15)");
  r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = "rgba(255,255,255,0.5)";
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(32, 32, 26, 0, Math.PI * 2);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Vuruşun kol hareketi. */
const POSE: Record<VolleyHit, VolleyPose> = { bump: "bump", set: "set", spike: "spike", dump: "set", serve: "spike" };

/** Voleybol topu: sarı-mavi-beyaz kavisli şeritler. */
function ballTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  const colors = ["#f6d23a", "#2a5fc4", "#f4f4f0"];
  for (let i = 0; i < 6; i++) {
    g.fillStyle = colors[i % 3];
    g.beginPath();
    for (let x = 0; x <= 256; x += 8) {
      const y = (i * 128) / 6 + Math.sin((x / 256) * Math.PI * 4) * 8;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    for (let x = 256; x >= 0; x -= 8) g.lineTo(x, ((i + 1) * 128) / 6 + Math.sin((x / 256) * Math.PI * 4) * 8 + 1);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
