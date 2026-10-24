// GAP Paintball (istemci): kulübede sıraya gir, skin seç; maçta birinci şahıs (sağda kol ve silah), sol tık ateş
// (basılı: seri), Ctrl/C çömel, R doldur, G çekil. Toplar herkeste aynı balistikle (shared/paintball.ts) bombeli
// uçar; engele/yere çarpınca boya lekesi kalır. İsabet sunucunun: vurulunca ekrana boya sıçrar, 3 sn sonra üste
// doğarsın. Seyirciler maçtakileri silahlı ve (çömelince) diz çökmüş görür; kuzeydeki tabela skoru gösterir.
import * as THREE from "three";
import { BALL, ballAt, ballBlocked, ballVel, BUNKERS, bunkerDist, GUN_SKINS, gunSkin, PAINT, PB, PB_BOOTH, PB_INNER, PLAYER, type Shot } from "../../shared/paintball";
import type { PbPlayer, PbState } from "../../shared/protocol";
import type { AvatarView } from "./avatars/avatars";
import type { Remotes } from "./avatars/remotes";
import type { FeatureAct } from "./features";
import type { Input } from "./input/input";
import { actionLabel, profile, setProfile } from "./input/keybinds";
import type { Net } from "./net";
import type { Player } from "./player";
import { settings, updateSettings } from "./settings";
import { button, Panel } from "./ui/panel";
import { falloff, sfx } from "./ui/sfx";
import { markerMesh, MUZZLE } from "./world/marker";
import type { PaintballField } from "./world/paintball";

const STEP = 1 / 240;
const MAX_BALLS = 160;
const MAX_SPLATS = 260;
const MAX_DROPS = 200;
const POSE_MS = 66;
/** Debug maketinin sid'i (gerçek oyuncularla çakışmaz). */
const DUMMY = 65000;
/** Debug denemesinde benim sid'im (bağlantı kopsa da deneme sürer). */
const DEBUG_ME = 65001;
/** Kulübenin tezgâhı (oyuncunun durduğu yer). */
const COUNTER = { x: PB_BOOTH.x - 2.1, z: PB_BOOTH.z, r: 2.6 };
/** Birinci şahıs silahın kameraya göre yeri. */
const VM_POS = new THREE.Vector3(0.2, -0.2, -0.4);
const VM_SCALE = 0.52;

export interface PaintballContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  net: Net;
  me: Player;
  remotes: Remotes;
  input: Input;
  hudRoot: HTMLElement;
  field: PaintballField;
  nameOf(sid: number): string;
  toast(text: string): void;
  /** Debug: maket rakip (görünüm denemesi). */
  dummy?: () => AvatarView;
}

interface FlyingBall {
  sid: number;
  shot: Shot;
  /** Topun 0. anı (döngü saati, sn) ve hesaplandığı süre. */
  born: number;
  t: number;
  color: THREE.Color;
  /** Görünüşte namludan çıkar: ilk ~0.12 sn bu noktadan gerçek yola kayar. */
  from: THREE.Vector3 | null;
}

interface Drop {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  color: THREE.Color;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Boya lekesi dokusu: ortada lekeler, çevreye sıçramış damlalar (beyaz; renk örnekten). */
function splatTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI * 2, d = r() * 16;
    g.beginPath();
    g.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 14 + r() * 14, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 16; i++) {
    const a = r() * Math.PI * 2, d = 30 + r() * 28;
    g.beginPath();
    g.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 2 + r() * 5, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}

/** İki nokta arasında silindir (kollar). */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, mat: THREE.Material): THREE.Mesh {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, 10);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

export class PaintballClient {
  private state: PbState = { phase: "idle", players: [], queue: [], startAt: 0, endsAt: 0 };
  private wins = 0;
  private asked = false;
  private active = false;
  private ammo: number = PB.hopper;
  private reloadUntil = 0;
  private lastFire = 0;
  private lastPose = { at: 0, p: NaN, c: -1, y: NaN };
  private kick = 0;
  private hitFlash = 0;
  private wasAlive = true;
  private lastTime = 0;
  private poses = new Map<number, { p: number; c: number; y: number; k: number }>();
  private balls: FlyingBall[] = [];
  private ballMesh: THREE.InstancedMesh;
  private splatMesh: THREE.InstancedMesh;
  private splatNext = 0;
  private drops: Drop[] = [];
  private dropMesh: THREE.InstancedMesh;
  private guns = new Map<number, THREE.Group>();
  private vm = new THREE.Group();
  private vmGun: THREE.Group | null = null;
  private vmSleeve: THREE.MeshLambertMaterial;
  private touchFire = false;
  private touchCrouch = false;
  private dummy: AvatarView | null = null;
  private debug: "fps" | "tp" | null = null;
  /** Debug: maket hep çömelmiş (1) ya da ayakta (0); yoksa sırayla. */
  private dummyCrouch: number | undefined;
  // Arayüz
  private root: HTMLDivElement;
  private score: HTMLDivElement;
  private ammoEl: HTMLDivElement;
  private ammoBar: HTMLDivElement;
  private center: HTMLDivElement;
  private splatEl: HTMLDivElement;
  private feed: HTMLDivElement;
  private hitmark: HTMLDivElement;
  private help: HTMLDivElement;
  private touchRow: HTMLDivElement;
  private panel: Panel;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private m = new THREE.Matrix4();
  private up = new THREE.Vector3(0, 0, 1);

  constructor(private c: PaintballContext) {
    const ball = new THREE.SphereGeometry(1, 8, 6);
    this.ballMesh = new THREE.InstancedMesh(ball, new THREE.MeshBasicMaterial({ color: "#ffffff" }), MAX_BALLS);
    this.ballMesh.count = 0;
    this.ballMesh.frustumCulled = false;
    this.splatMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshLambertMaterial({ map: splatTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      MAX_SPLATS,
    );
    this.splatMesh.count = 0;
    this.splatMesh.frustumCulled = false;
    this.splatMesh.renderOrder = 2;
    this.dropMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 5, 4), new THREE.MeshBasicMaterial({ color: "#ffffff" }), MAX_DROPS);
    this.dropMesh.count = 0;
    this.dropMesh.frustumCulled = false;
    c.scene.add(this.ballMesh, this.splatMesh, this.dropMesh);

    // Birinci şahıs: kol ve silah. Sahnenin geri kalanından sonra, derinlik temizlenip çizilir (duvara girmez).
    this.vmSleeve = new THREE.MeshLambertMaterial({ color: PAINT[0], fog: false });
    this.vm.visible = false;
    c.scene.add(this.vm);
    this.buildViewmodel();

    // ---- Arayüz ----
    const hud = c.hudRoot;
    this.root = el("div", "pb-hud", hud);
    this.score = el("div", "pb-score", this.root);
    el("div", "pb-cross", this.root);
    this.hitmark = el("div", "pb-hitmark", this.root);
    const ammo = el("div", "pb-ammo", this.root);
    this.ammoEl = el("div", "pb-ammo-n", ammo);
    const bar = el("div", "pb-ammo-track", ammo);
    this.ammoBar = el("div", "pb-ammo-bar", bar);
    this.center = el("div", "pb-center", this.root);
    this.splatEl = el("div", "pb-splat", hud);
    this.feed = el("div", "pb-feed", this.root);
    this.help = el("div", "pb-help", this.root);
    this.touchRow = el("div", "pb-touch", this.root);
    if (c.input.touch) {
      const fire = el("button", "pb-tbtn pb-tfire", this.touchRow, "🎯");
      const hold = (on: boolean) => (e: Event) => {
        e.preventDefault();
        this.touchFire = on;
      };
      fire.addEventListener("pointerdown", hold(true));
      fire.addEventListener("pointerup", hold(false));
      fire.addEventListener("pointercancel", hold(false));
      button(this.touchRow, "⤓", () => (this.touchCrouch = !this.touchCrouch), "pb-tbtn");
      button(this.touchRow, "↻", () => this.reload(), "pb-tbtn");
    }
    this.panel = new Panel(hud, "🎯 GAP PAINTBALL", "pb-panel");

    const params = new URLSearchParams(location.search);
    if (params.has("debug") && params.has("pbtest")) this.debug = params.get("pbtest") === "tp" ? "tp" : "fps";
    if (params.has("pbcomel")) this.dummyCrouch = Number(params.get("pbcomel")) ? 1 : 0;
    // Debug: sürekli ateş (topların uçuşu ve lekeler)
    if (this.debug && params.has("pbates")) this.touchFire = true;
  }

  /** Benim sid'im (debug denemesinde sabit). */
  private get you(): number {
    return this.debug ? DEBUG_ME : this.c.net.you;
  }

  // ---------------------------------------------------------------------------
  // Sunucudan
  // ---------------------------------------------------------------------------

  onState(s: PbState): void {
    if (this.debug) return;
    const you = this.you;
    const prev = this.state;
    const wasIn = prev.players.some((p) => p.sid === you) && prev.phase !== "idle";
    this.state = s;
    const mine = s.players.find((p) => p.sid === you);
    // Yeni maç: lekeler silinir
    if (s.phase === "count" && prev.phase !== "count") this.clearSplats();
    if (mine && (s.phase === "count" && prev.phase !== "count")) this.spawned(mine);
    if (mine && s.phase === "play" && mine.alive && !this.wasAlive) this.spawned(mine);
    if (mine) this.wasAlive = mine.alive;
    if (s.phase === "end" && prev.phase !== "end" && (mine || wasIn)) {
      const w = s.winner;
      this.center.textContent = !w ? "🤝 Berabere" : w === you ? "🏆 KAZANDIN!" : "Kaybettin";
      this.center.className = `pb-center show big${w === you ? " good" : ""}`;
      if (w === you) sfx.win(true);
    }
    if (this.panel.isOpen) this.renderPanel();
  }

  onShot(sid: number, o: [number, number, number], d: [number, number, number], at: number): void {
    if (sid === this.you) return; // kendi topum zaten uçuyor
    const age = Math.max(0, Math.min(0.4, (this.c.net.serverNow() - at) / 1000));
    const gun = this.guns.get(sid);
    const from = gun?.visible ? gun.localToWorld(this.tmp.copy(MUZZLE)).clone() : null;
    this.addBall(sid, { o, d }, performance.now() / 1000 - age, from);
    const d2 = Math.hypot(o[0] - this.c.camera.position.x, o[2] - this.c.camera.position.z);
    sfx.pbShot(falloff(d2) * 0.8);
  }

  onHit(by: number, victim: number, x: number, y: number, z: number): void {
    const you = this.you;
    // Vuran top durur (o oyuncunun bu noktaya en yakın topu)
    let best = -1, bestD = 1.5;
    const p = this.tmp;
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      if (b.sid !== by) continue;
      ballAt(b.shot, b.t, p);
      const d = Math.hypot(p.x - x, p.y - y, p.z - z);
      if (d < bestD) [best, bestD] = [i, d];
    }
    if (best >= 0) this.balls.splice(best, 1);
    const color = this.paint(by);
    this.burst(new THREE.Vector3(x, y, z), color, 22);
    const cam = this.c.camera.position;
    sfx.pbSplat(falloff(Math.hypot(x - cam.x, z - cam.z)));
    if (victim === you) {
      this.splatEl.style.setProperty("--pb-paint", `#${color.getHexString()}`);
      this.splatEl.classList.remove("show");
      void this.splatEl.offsetWidth;
      this.splatEl.classList.add("show");
      this.c.toast(`💥 ${this.c.nameOf(by)} seni vurdu!`);
    }
    if (by === you) {
      this.hitFlash = 1;
      sfx.pbHitMark();
    }
    if (this.active || this.near()) {
      const line = el("div", "pb-feed-line", this.feed);
      const a = el("span", "", line, this.c.nameOf(by));
      a.style.color = `#${this.paint(by).getHexString()}`;
      line.append(" 🎯 ");
      const v = el("span", "", line, this.c.nameOf(victim));
      v.style.color = `#${this.paint(victim).getHexString()}`;
      while (this.feed.children.length > 4) this.feed.firstChild!.remove();
      window.setTimeout(() => line.remove(), 6000);
    }
  }

  onPoses(p: number[]): void {
    for (let i = 0; i + 3 < p.length; i += 4) {
      const cur = this.poses.get(p[i]);
      this.poses.set(p[i], { p: p[i + 1] / 100, c: p[i + 2], y: p[i + 3] / 100, k: cur?.k ?? 0 });
    }
  }

  onWins(n: number): void {
    this.wins = n;
    // Seçili skin açıksa sunucuya bildir (açık değilse klasik)
    const sk = gunSkin(settings.pbSkin);
    if (sk.wins <= n) this.c.net.send({ t: "pbskin", id: sk.id });
    if (this.panel.isOpen) this.renderPanel();
  }

  // ---------------------------------------------------------------------------
  // Etkileşim
  // ---------------------------------------------------------------------------

  /** Maçta mıyım (geri sayım ve sonuç dahil): dünya etkileşimleri kapalı. */
  busy(): boolean {
    return this.active;
  }

  private near(): boolean {
    const { me } = this.c;
    return Math.hypot(me.x - COUNTER.x, me.z - COUNTER.z) < COUNTER.r;
  }

  acts(): FeatureAct[] {
    if (this.active || !this.near()) return [];
    const queued = this.state.queue.includes(this.you);
    return [
      queued ? { key: "f", label: "Paintball sırasından çık", act: "pb-leave" } : { key: "f", label: "Paintball sırasına gir 🎯 (1v1)", act: "pb-join" },
      { key: "g", label: "Silah skinleri 🎨", act: "pb-panel" },
    ];
  }

  handleAct(act: string): boolean {
    const { net } = this.c;
    switch (act) {
      case "pb-join": {
        const sk = gunSkin(settings.pbSkin);
        if (sk.wins <= this.wins) net.send({ t: "pbskin", id: sk.id });
        net.send({ t: "pbjoin" });
        return true;
      }
      case "pb-leave":
        net.send({ t: "pbleave" });
        return true;
      case "pb-panel":
        this.renderPanel();
        this.panel.open();
        return true;
      default:
        return false;
    }
  }

  private renderPanel(): void {
    const b = this.panel.body;
    b.replaceChildren();
    const s = this.state, you = this.you;
    const name = (sid: number) => this.c.nameOf(sid);
    const status = el("div", "pb-status", b);
    if (s.phase === "idle") status.textContent = s.queue.length ? `Sırada ${s.queue.length} kişi, rakip bekleniyor.` : "Saha boş. Sıraya gir, ikinci kişi gelince maç başlar.";
    else {
      const [a, c] = s.players;
      status.textContent = `Maç: ${a ? `${name(a.sid)} ${a.kills}` : "?"} — ${c ? `${c.kills} ${name(c.sid)}` : "?"}${s.queue.length ? ` · sırada ${s.queue.length} kişi` : ""}`;
    }
    const queued = s.queue.includes(you);
    if (!s.players.some((p) => p.sid === you)) {
      button(b, queued ? `Sıradan çık (${s.queue.indexOf(you) + 1}.)` : "🎯 Sıraya gir", () => this.handleAct(queued ? "pb-leave" : "pb-join"), "pb-join-btn");
    }
    el("div", "settings-note", b, "1v1 · 3 dakika · vurulan 3 sn sonra kendi üssünde doğar · en çok vuran kazanır. Galibiyetler yeni skin açar.");
    el("h3", "pb-skins-head", b, `🎨 Silah skinleri · ${this.wins} galibiyet`);
    const grid = el("div", "pb-skins", b);
    for (const sk of GUN_SKINS) {
      const locked = sk.wins > this.wins;
      const cell = el("button", `pb-skin${settings.pbSkin === sk.id ? " active" : ""}${locked ? " locked" : ""}`, grid);
      const sw = el("div", "pb-swatch", cell);
      const cols = sk.pattern ?? [sk.body, sk.accent, sk.hopper];
      sw.style.background = `linear-gradient(135deg, ${cols.map((c2, i) => `${c2} ${(i / cols.length) * 100}% ${((i + 1) / cols.length) * 100}%`).join(", ")})`;
      if (sk.glow) sw.style.boxShadow = `0 0 10px ${sk.accent}`;
      el("div", "pb-skin-name", cell, sk.name);
      el("div", "pb-skin-req", cell, locked ? `🔒 ${sk.wins} galibiyet` : settings.pbSkin === sk.id ? "✓ seçili" : "açık");
      cell.disabled = locked;
      cell.addEventListener("click", () => {
        if (locked) return;
        updateSettings({ pbSkin: sk.id });
        this.c.net.send({ t: "pbskin", id: sk.id });
        this.buildViewmodel();
        this.renderPanel();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Kare başı
  // ---------------------------------------------------------------------------

  private mine(): PbPlayer | undefined {
    return this.state.players.find((p) => p.sid === this.you);
  }

  private paint(sid: number): THREE.Color {
    const slot = this.state.players.find((p) => p.sid === sid)?.slot ?? (sid === this.you ? 0 : 1);
    return new THREE.Color(PAINT[slot]);
  }

  /** Doğdum (maç başı ya da vurulduktan sonra): sahanın ortasına bakarım, hazne dolu. */
  private spawned(p: PbPlayer): void {
    this.c.me.lookToward(p.slot === 0 ? 0 : Math.PI);
    this.ammo = PB.hopper;
    this.reloadUntil = 0;
  }

  private setActive(on: boolean): void {
    const { me, input } = this.c;
    this.active = on;
    if (on) {
      setProfile("paintball");
      me.fps = { fence: PB_INNER, crouch: false, speed: PLAYER.speed, crouchSpeed: PLAYER.crouchSpeed, eye: PLAYER.eye, crouchEye: PLAYER.crouchEye };
      input.setPointerLock(true);
      this.ammo = PB.hopper;
      this.reloadUntil = 0;
      this.panel.close();
      this.buildViewmodel();
      this.help.textContent = input.touch
        ? "🎯: ateş (basılı: seri) · ⤓: çömel · ↻: doldur"
        : `${actionLabel("pbFire")}: ateş (basılı: seri) · ${actionLabel("pbCrouch")}: çömel · ${actionLabel("pbReload")}: doldur · ${actionLabel("pbLeave")}: çekil · Esc: imleci bırak`;
      this.help.classList.add("show");
      window.setTimeout(() => this.help.classList.remove("show"), 9000);
    } else {
      if (profile === "paintball") setProfile("world");
      me.fps = null;
      input.setPointerLock(false);
      this.touchFire = this.touchCrouch = false;
      this.center.className = "pb-center";
    }
    this.root.classList.toggle("show", on);
    this.c.hudRoot.classList.toggle("paintball", on);
    this.vm.visible = on;
  }

  private reload(): void {
    if (!this.active || this.reloadUntil || this.ammo >= PB.hopper || this.state.phase !== "play") return;
    this.reloadUntil = performance.now() + PB.reloadMs;
    this.c.net.send({ t: "pbreload" });
    sfx.pbReload();
  }

  private fire(now: number): void {
    const { camera, net } = this.c;
    const d = camera.getWorldDirection(this.tmp2);
    // Boya topu sapar: küçük rastgele dağılım
    d.x += (Math.random() - 0.5) * 0.014;
    d.y += (Math.random() - 0.5) * 0.014;
    d.z += (Math.random() - 0.5) * 0.014;
    d.normalize();
    const o = camera.position;
    const shot: Shot = { o: [o.x, o.y, o.z], d: [d.x, d.y, d.z] };
    net.send({ t: "pbfire", o: shot.o, d: shot.d, at: net.serverNow() - net.interp.delay });
    const muzzle = this.vmGun ? this.vmGun.localToWorld(this.tmp.copy(MUZZLE)).clone() : null;
    this.addBall(this.you, shot, now / 1000, muzzle);
    this.ammo--;
    this.lastFire = now;
    this.kick = 1;
    sfx.pbShot(0.9);
    if (!this.ammo) this.reload();
  }

  private addBall(sid: number, shot: Shot, born: number, from: THREE.Vector3 | null): void {
    if (this.balls.length >= MAX_BALLS) this.balls.shift();
    this.balls.push({ sid, shot, born, t: 0, color: this.paint(sid), from });
  }

  /** Kare başı; `time` döngü saati (sn). Geçişler bu saatin farkından (kare süresi bazen 0 gelir). */
  update(time: number): void {
    const { me, input, net, remotes } = this.c;
    const dt = Math.max(0, Math.min(0.1, time - this.lastTime));
    this.lastTime = time;
    const you = this.you;
    const now = performance.now();
    if (this.debug && !this.mine()) this.practice(time);
    const mine = this.mine();
    const inGame = !!mine && this.state.phase !== "idle" && this.debug !== "tp";
    if (inGame !== this.active) this.setActive(inGame);
    if (!this.asked && this.near()) {
      this.asked = true;
      net.send({ t: "pbinfo" });
    }

    // ---- Kendi silahım ----
    const play = this.state.phase === "play" && !!mine?.alive;
    if (this.active) {
      if (input.consumeKey("pbLeave")) {
        net.send({ t: "pbleave" });
        if (this.debug) this.debug = null;
      }
      if (input.consumeKey("pbReload")) this.reload();
      if (this.reloadUntil && now >= this.reloadUntil) {
        this.reloadUntil = 0;
        this.ammo = PB.hopper;
      }
      const crouch = input.heldAction("pbCrouch") || this.touchCrouch;
      if (me.fps) {
        me.fps.crouch = crouch && !!mine?.alive;
        me.fps.frozen = this.state.phase === "count" || (this.state.phase === "play" && !mine?.alive);
      }
      const want = (input.heldAction("pbFire") && (input.locked || input.touch)) || this.touchFire;
      if (play && want && !this.reloadUntil && this.ammo > 0 && now - this.lastFire >= PB.fireMs) this.fire(now);
      else if (play && want && !this.ammo && !this.reloadUntil) this.reload();
      // Bakış ve çömelme: değişince ~15 Hz, değişmese de yarım saniyede bir
      const v = me.view, y = (me.baseY ?? 0) + me.jumpY, c = me.fps?.crouch ? 1 : 0;
      const lp = this.lastPose;
      const changed = Math.abs(v.pitch - lp.p) > 0.03 || c !== lp.c || Math.abs(y - lp.y) > 0.05;
      if ((changed && now - lp.at > POSE_MS) || now - lp.at > 500) {
        this.lastPose = { at: now, p: v.pitch, c, y };
        if (!this.debug) net.send({ t: "pbpose", p: v.pitch, c, y });
      }
    }

    // ---- Maçtakilerin duruşu ve elindeki silah ----
    const shown = new Set<number>();
    for (const p of this.state.players) {
      const view: AvatarView | undefined = p.sid === you ? (this.debug === "tp" ? me : undefined) : p.sid === DUMMY ? this.dummy ?? undefined : remotes.map.get(p.sid);
      if (!view) continue;
      const pose = this.poses.get(p.sid) ?? { p: 0, c: 0, y: 0, k: 0 };
      if (p.sid === DUMMY) pose.c = this.dummyCrouch ?? (Math.sin(time * 0.8) > 0.3 ? 1 : 0);
      if (p.sid === you) pose.c = me.crouchK > 0.5 ? 1 : 0;
      pose.k = Math.max(0, Math.min(1, pose.k + (pose.c - pose.k) * (1 - Math.exp(-dt * 12))));
      this.poses.set(p.sid, pose);
      view.pb = p.alive || this.state.phase !== "play" ? { pitch: pose.p, crouch: pose.k } : null;
      shown.add(p.sid);
      this.placeGun(p.sid, p.skin, view, pose, !!view.pb && (view as { hasData?: boolean }).hasData !== false);
    }
    for (const [sid, g] of this.guns) if (!shown.has(sid)) g.visible = false;
    for (const r of remotes.map.values()) if (!shown.has(r.info.sid)) (r as AvatarView).pb = null;
    if (this.debug !== "tp" && !shown.has(you)) (me as AvatarView).pb = null;

    this.flyBalls(time);
    this.updateDrops(dt);
    this.updateViewmodel(time, dt, now);
    this.updateHud(now);
    this.updateBoard();
  }

  /**
   * Debug denemesi (?debug&pbtest: birinci şahıs, pbtest=tp: kendi karakterim silahlı, dışarıdan; pbcomel=1:
   * maket çömelik; pbates: sürekli ateş ve sahaya önceden atılmış toplar): sunucusuz maç ve maket rakip.
   */
  private practice(time: number): void {
    const { me, net } = this.c;
    const p = (sid: number, slot: 0 | 1, skin: string): PbPlayer => ({ sid, slot, kills: 2 - slot, deaths: 1 + slot, alive: true, respawnAt: 0, safeUntil: 0, skin });
    this.state = { phase: "play", players: [p(DEBUG_ME, 0, settings.pbSkin), p(DUMMY, 1, "neon")], queue: [], startAt: 0, endsAt: net.serverNow() + 151_000 };
    if (this.c.dummy) this.dummy = this.c.dummy();
    if (!new URLSearchParams(location.search).has("pbates")) return;
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const d = new THREE.Vector3(Math.sin(a * 3) * 0.35, (i % 5) * 0.03 - 0.06, 1).normalize();
      this.addBall(i % 2 ? DUMMY : DEBUG_ME, { o: [me.x + Math.sin(a) * 0.5, 1.3, me.z + Math.cos(a) * 0.5], d: [d.x, d.y, d.z] }, time - 2.4, null);
    }
  }

  /** Avatarın elindeki silah (göğüs hizasında, bakışla kalkar). */
  private placeGun(sid: number, skinId: string, v: AvatarView, pose: { p: number; k: number }, on: boolean): void {
    let g = this.guns.get(sid);
    if (!g || g.userData.skin !== gunSkin(skinId).id) {
      if (g) this.c.scene.remove(g);
      g = markerMesh(gunSkin(skinId));
      g.scale.setScalar(0.85);
      this.guns.set(sid, g);
      this.c.scene.add(g);
    }
    g.visible = on;
    if (!on) return;
    const fx = Math.sin(v.rot), fz = Math.cos(v.rot);
    const y = (v.baseY ?? 0) + v.jumpY + 0.64 - 0.12 * pose.k - pose.p * 0.08;
    g.position.set(v.x + fx * 0.3 - fz * 0.04, y, v.z + fz * 0.3 + fx * 0.04);
    g.rotation.set(-pose.p * 0.8, v.rot + Math.PI, 0, "YXZ");
  }

  private flyBalls(time: number): void {
    const p = this.tmp, vel = this.tmp2;
    let n = 0;
    const live: FlyingBall[] = [];
    for (const b of this.balls) {
      const until = Math.min(BALL.life, time - b.born);
      let stop = false;
      while (b.t < until) {
        b.t = Math.min(until, b.t + STEP);
        ballAt(b.shot, b.t, p);
        const hit = ballBlocked(p.x, p.y, p.z);
        if (hit) {
          this.splat(p, hit.kind === "bunker" ? hit.i : hit.kind === "ground" ? -1 : -2, b.color);
          stop = true;
          break;
        }
      }
      if (stop || b.t >= BALL.life) continue;
      live.push(b);
      // Namludan gerçek yola kayış
      const k = b.from ? Math.min(1, b.t / 0.12) : 1;
      if (b.from && k < 1) p.lerpVectors(b.from, p.clone(), k * k * (3 - 2 * k));
      ballVel(b.shot, b.t, vel);
      this.q.setFromUnitVectors(this.up, vel.normalize());
      // Kameranın dibindeyken (namludan çıkarken) küçük: ekranı kaplamasın
      const near = Math.max(0.3, Math.min(1, p.distanceTo(this.c.camera.position) / 2.5));
      const r = BALL.r * 1.3 * near;
      this.m.compose(p, this.q, this.tmp2.set(r, r, r * 2));
      this.ballMesh.setMatrixAt(n, this.m);
      this.ballMesh.setColorAt(n, b.color);
      n++;
    }
    this.balls = live;
    this.ballMesh.count = n;
    this.ballMesh.instanceMatrix.needsUpdate = true;
    if (this.ballMesh.instanceColor) this.ballMesh.instanceColor.needsUpdate = true;
  }

  /** Leke: yere (bunker −1), bunkere (i), ağa (−2: yalnızca sıçrama). */
  private splat(p: THREE.Vector3, where: number, color: THREE.Color): void {
    const at = p.clone();
    this.burst(at, color, 10);
    const cam = this.c.camera.position;
    const d = Math.hypot(at.x - cam.x, at.z - cam.z);
    if (d < 30) sfx.pbSplat(falloff(d) * 0.5);
    if (where === -2) return;
    const n = new THREE.Vector3(0, 1, 0);
    if (where >= 0) {
      const bk = BUNKERS[where];
      const { cx, cz } = bunkerDist(bk, at.x, at.z);
      if (at.y < bk.h - 0.12) n.set(at.x - cx, bk.kind === "dorito" ? 0.35 : 0, at.z - cz).normalize();
    } else at.y = 0.03;
    at.addScaledVector(n, 0.012);
    this.q.setFromUnitVectors(this.up, n);
    this.q.multiply(new THREE.Quaternion().setFromAxisAngle(this.up, Math.random() * Math.PI * 2));
    const size = 0.22 + Math.random() * 0.16;
    this.m.compose(at, this.q, new THREE.Vector3(size, size, size));
    const i = this.splatNext;
    this.splatNext = (this.splatNext + 1) % MAX_SPLATS;
    this.splatMesh.setMatrixAt(i, this.m);
    this.splatMesh.setColorAt(i, color);
    this.splatMesh.count = Math.max(this.splatMesh.count, i + 1);
    this.splatMesh.instanceMatrix.needsUpdate = true;
    if (this.splatMesh.instanceColor) this.splatMesh.instanceColor.needsUpdate = true;
  }

  private clearSplats(): void {
    this.splatMesh.count = 0;
    this.splatNext = 0;
  }

  private burst(at: THREE.Vector3, color: THREE.Color, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.drops.length >= MAX_DROPS) this.drops.shift();
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).multiplyScalar(2.5 + Math.random() * 2.5);
      this.drops.push({ p: at.clone(), v, life: 0.35 + Math.random() * 0.3, color });
    }
  }

  private updateDrops(dt: number): void {
    let n = 0;
    this.drops = this.drops.filter((d) => (d.life -= dt) > 0);
    for (const d of this.drops) {
      d.v.y -= 9.8 * dt;
      d.p.addScaledVector(d.v, dt);
      if (d.p.y < 0.03) d.p.y = 0.03;
      const s = 0.02 * Math.min(1, d.life * 4);
      this.m.makeScale(s, s, s).setPosition(d.p);
      this.dropMesh.setMatrixAt(n, this.m);
      this.dropMesh.setColorAt(n, d.color);
      n++;
    }
    this.dropMesh.count = n;
    this.dropMesh.instanceMatrix.needsUpdate = true;
    if (this.dropMesh.instanceColor) this.dropMesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Birinci şahıs: kol ve silah
  // ---------------------------------------------------------------------------

  private buildViewmodel(): void {
    for (const ch of [...this.vm.children]) this.vm.remove(ch);
    const mine = this.mine();
    this.vmSleeve.color.set(PAINT[mine?.slot ?? 0]);
    // Derinliği temizleyen görünmez parça: önce o çizilir, sonra kol ve silah (duvarın içine girmez)
    const clear = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
    clear.position.set(0, 0, -0.5);
    clear.renderOrder = 999;
    clear.frustumCulled = false;
    clear.onBeforeRender = (renderer) => {
      renderer.state.buffers.depth.setMask(true);
      renderer.clearDepth();
    };
    const gun = markerMesh(gunSkin(settings.pbSkin), { fog: false });
    gun.position.copy(VM_POS);
    gun.rotation.set(0.02, -0.03, 0);
    gun.scale.setScalar(VM_SCALE);
    this.vmGun = gun;
    const glove = new THREE.MeshLambertMaterial({ color: "#26272b", fog: false });
    // Sağ el kabzada, kol aşağı sağdan gelir; sol el ön tutamakta
    const rHand = new THREE.Vector3(0, -0.1, 0.05), lHand = new THREE.Vector3(0, -0.09, -0.17);
    const arms = new THREE.Group();
    arms.add(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.1), glove).translateX(rHand.x).translateY(rHand.y).translateZ(rHand.z));
    arms.add(limb(rHand.clone().add(new THREE.Vector3(0.01, -0.03, 0.04)), new THREE.Vector3(0.16, -0.3, 0.32), 0.045, 0.055, this.vmSleeve));
    arms.add(new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.07, 0.09), glove).translateX(lHand.x).translateY(lHand.y).translateZ(lHand.z));
    arms.add(limb(lHand.clone().add(new THREE.Vector3(-0.02, -0.03, 0.02)), new THREE.Vector3(-0.22, -0.32, 0.1), 0.04, 0.052, this.vmSleeve));
    gun.add(arms);
    this.vm.add(clear, gun);
    this.vm.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      if (mesh !== clear) {
        mesh.renderOrder = 1000;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          m.transparent = true;
          m.depthWrite = true;
          (m as THREE.MeshLambertMaterial).fog = false;
        }
      }
    });
  }

  private updateViewmodel(time: number, dt: number, now: number): void {
    const { camera, me } = this.c;
    if (!this.active || !this.vmGun) return;
    const mine = this.mine();
    this.vm.visible = !!mine?.alive || this.state.phase !== "play";
    this.vm.position.copy(camera.position);
    this.vm.quaternion.copy(camera.quaternion);
    this.kick = Math.max(0, this.kick - dt * 9);
    const moving = Math.min(1, Math.hypot(me.x - (this.vm.userData.px ?? me.x), me.z - (this.vm.userData.pz ?? me.z)) / Math.max(dt, 1e-3) / 4);
    this.vm.userData.px = me.x;
    this.vm.userData.pz = me.z;
    const bob = (this.vm.userData.bob = ((this.vm.userData.bob as number) ?? 0) + (moving - ((this.vm.userData.bob as number) ?? 0)) * (1 - Math.exp(-dt * 8)));
    const g = this.vmGun;
    // Doldururken silah yana yatar ve aşağı iner
    const r = this.reloadUntil ? 1 - (this.reloadUntil - now) / PB.reloadMs : 0;
    const rl = this.reloadUntil ? Math.sin(Math.min(1, r) * Math.PI) : 0;
    g.position.set(
      VM_POS.x + Math.sin(time * 9) * 0.008 * bob,
      VM_POS.y + Math.abs(Math.cos(time * 9)) * 0.01 * bob - rl * 0.08 - me.crouchK * 0.01,
      VM_POS.z + this.kick * 0.045,
    );
    g.rotation.set(0.02 + this.kick * 0.12 + rl * 0.3, -0.03, rl * 0.7);
  }

  private updateHud(now: number): void {
    if (!this.active) return;
    const s = this.state, you = this.you;
    const mine = this.mine();
    const foe = s.players.find((p) => p.sid !== you);
    const serverNow = this.c.net.serverNow();
    const left = s.phase === "play" ? mmss(s.endsAt - serverNow) : s.phase === "count" ? mmss(PB.matchMs) : "0:00";
    const meCol = PAINT[mine?.slot ?? 0], foeCol = PAINT[foe?.slot ?? 1];
    const html = `<span style="color:${meCol}">Sen ${mine?.kills ?? 0}</span><i>${left}</i><span style="color:${foeCol}">${foe?.kills ?? 0} ${foe ? this.c.nameOf(foe.sid) : "Rakip"}</span>`;
    if (this.score.innerHTML !== html) this.score.innerHTML = html;
    const ammoText = this.reloadUntil ? "Dolduruluyor…" : `${this.ammo} / ${PB.hopper}`;
    if (this.ammoEl.textContent !== ammoText) this.ammoEl.textContent = ammoText;
    const frac = this.reloadUntil ? 1 - (this.reloadUntil - now) / PB.reloadMs : this.ammo / PB.hopper;
    this.ammoBar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    this.ammoBar.classList.toggle("low", !this.reloadUntil && this.ammo <= 5);
    this.hitFlash = Math.max(0, this.hitFlash - 0.05);
    this.hitmark.style.opacity = String(this.hitFlash);
    // Ortadaki büyük yazı: geri sayım, vuruldun, sonuç
    if (s.phase === "count") this.setCenter(`${Math.max(1, Math.ceil((s.startAt - serverNow) / 1000))}`, "big");
    else if (s.phase === "play" && mine && !mine.alive) this.setCenter(`💥 Vuruldun · ${Math.max(1, Math.ceil((mine.respawnAt - serverNow) / 1000))}`, "");
    else if (s.phase === "play") this.setCenter("", "");
  }

  private setCenter(text: string, cls: string): void {
    const c = `pb-center${text ? " show" : ""}${cls ? ` ${cls}` : ""}`;
    if (this.center.textContent !== text) this.center.textContent = text;
    if (this.center.className !== c) this.center.className = c;
  }

  private updateBoard(): void {
    const s = this.state;
    const [a, b] = s.players;
    if (s.phase !== "idle" && a && b) {
      const left = s.phase === "play" ? mmss(s.endsAt - this.c.net.serverNow()) : s.phase === "count" ? "Başlıyor" : "Bitti";
      this.c.field.setBoard([`${a.kills}  —  ${b.kills}`, `${this.c.nameOf(a.sid)} vs ${this.c.nameOf(b.sid)} · ${left}`], [PAINT[0], "#e6ebf2"]);
    } else this.c.field.setBoard(s.queue.length ? ["GAP PAINTBALL", `Sırada ${s.queue.length} kişi`] : []);
  }

  /** Debug maketi (dünyada çizilecek ekstra avatar). */
  extras(): AvatarView[] {
    return this.dummy ? [this.dummy] : [];
  }

  dispose(): void {
    if (this.active) this.setActive(false);
    this.root.remove();
    this.splatEl.remove();
    this.panel.close();
    this.c.scene.remove(this.ballMesh, this.splatMesh, this.dropMesh, this.vm);
    for (const g of this.guns.values()) this.c.scene.remove(g);
  }
}
