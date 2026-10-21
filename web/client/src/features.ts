// Dünyanın yeni özellikleri tek yerde: hava ve havai fişek, futbol, kahvehane masaları ve çay ocağı, DJ ve sahne,
// ebelemece/saklambaç, beşlik/sarılma, araçlar ve evcil hayvanlar, görevler, oyuncu kartı, fotoğraf modu.
// main.ts her kare `update` çağırır; yakındaki etkileşimleri `acts` ile ekler.
import * as THREE from "three";
import { FLAG_RUNNING, FLAG_WALKING, vehicleOf, type Vehicle } from "../../shared/constants";
import type { KickKind, MatchState } from "../../shared/protocol";
import { assistedShot, attackSide, FINISH_RANGE, goalView } from "../../shared/football";
import { DJ_BOOTH, DOCK, KICK_REACH, PITCH, POND_AREA, RACE_HOUSE, STAGE, STAGE_STEPS, TABLE_WATCH_R, TABLES, TEA_COUNTER, TEA_MAKER } from "../../shared/zones";
import { RaceClient } from "./race";
import { BilekArms } from "./world/bilekArms";
import { type AvatarRenderer, type AvatarView, colorFor } from "./avatars/avatars";
import { Companions } from "./avatars/companions";
import { type EmoteFx, FX_CELL } from "./avatars/emotes";
import type { AvatarAtlas } from "./avatars/atlas";
import type { Remote, Remotes } from "./avatars/remotes";
import type { Session } from "./discord";
import type { Input } from "./input/input";
import type { ModeLife } from "./mode";
import type { Net } from "./net";
import type { Player } from "./player";
import { settings, updateSettings } from "./settings";
import { BoardGameUi } from "./ui/boardGame";
import type { Hud } from "./ui/hud";
import { Hub } from "./ui/hub";
import { canvasToJpeg, PhotoMode } from "./ui/photo";
import { ProfileUi } from "./ui/profile";
import { falloff, sfx } from "./ui/sfx";
import { WorldHud } from "./ui/worldHud";
import { Confetti, Mist, SeasonParticles, Splashes, StageHaze } from "./world/ambient";
import { daylight, istanbulHour } from "./world/daynight";
import { wetUniform } from "./world/geo";
import { Fireworks } from "./world/fireworks";
import { SCREEN_H, SCREEN_W, type World } from "./world/scene";
import { ScreenGlow } from "./world/screenGlow";
import { BuildWorld } from "./world/buildWorld";
import { BuildMode } from "./ui/buildUi";
import { WeatherFx } from "./world/weather";

/** Yakındaki etkileşim (F/G düğmesi). */
export interface FeatureAct {
  key: "f" | "g";
  label: string;
  act: string;
}

export interface FeatureContext {
  life: ModeLife;
  world: World;
  net: Net;
  me: Player;
  remotes: Remotes;
  atlas: AvatarAtlas;
  avatars: AvatarRenderer;
  hud: Hud;
  hudRoot: HTMLElement;
  input: Input;
  emoteFx: EmoteFx;
  session: Session;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  lowPower: boolean;
  /** Sahneyi hemen çizer (fotoğraf için). */
  renderNow(): void;
  /** Sohbete komut yaz ve gönder (ör. "!kuyruk link"). */
  say(text: string): void;
  battle(): void;
  /** Müzik seviyesi (0–1, hoparlör titreşimiyle aynı). */
  music(): number;
  /** Sinemada video açık ve oyuncu perdenin önünde. */
  inCinema(): boolean;
  /** Sinemada bir şey oynuyor (perdede ya da tarayıcıda). */
  cinemaOn(): boolean;
}

/** Kişisel saat ayarı → saat; sinema modu en az bu kadar karanlık. */
const CLOCK_HOURS = { day: 13, sunset: 19.5, night: 22 } as const;
const CINEMA_HOUR = 21;

const TEA_MAKER_NAME = "Ocakçı Rıza";
const RIDE_REPORT_MS = 8000;
/** F'ye bundan kısa basmak pas. */
const PASS_TAP = 0.18;
const TEAM_COLORS = [new THREE.Color("#ff3b30"), new THREE.Color("#2f8bff")];

/** Kalan maç süresi "m:ss". */
function matchClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class Features {
  readonly photo: PhotoMode;
  private companions = new Companions();
  private weatherFx: WeatherFx;
  private fireworks = new Fireworks();
  private screenGlow: ScreenGlow;
  private buildWorld = new BuildWorld();
  private build: BuildMode;
  /** Oyuncak pist yarışı. */
  readonly race: RaceClient;
  private mist = new Mist();
  private leaves: SeasonParticles;
  private confetti = new Confetti();
  private bilekArms = new BilekArms();
  private splashes = new Splashes();
  private haze = new StageHaze();
  /** Islak zeminde son adım anı (sid → sn): sıçrama adım ritminde. */
  private lastStep = new Map<number, number>();
  private fogColor = new THREE.Color();
  private boards: BoardGameUi;
  private profile: ProfileUi;
  private hub: Hub;
  private whud: WorldHud;
  private stage = { dj: 0, show: 0, singer: 0 };
  /** Önceki karede sahnede miydik: inişi (F, öne yürüme, araç, ışınlanma) sunucuya bildirmek için. */
  private wasOnStage = false;
  /** Sunucunun sabitlediği saat (!saat), null: gerçek saat. */
  private worldClock: number | null = null;
  private score: [number, number] = [0, 0];
  /** Basılı tutulan vuruş: tuş, tür ve geçen süre (sn). */
  private charge: { key: "actF" | "actG"; kind: "shot" | "lob"; t: number } | null = null;
  private match: MatchState | null = null;
  /** Maçta oyuncuların altındaki takım halkaları. */
  private rings: THREE.InstancedMesh;
  private lastSeat: { id: number; seat: number } | null = null;
  private sitAt = 0;
  private lastRide = 0;
  private lastRipple = 0;
  private lastMark = 0;
  private lastTagHud = 0;
  private teaMaker: AvatarView;
  private down = { x: 0, y: 0, at: 0 };
  private proj = new THREE.Vector3();

  constructor(private c: FeatureContext) {
    const { world, net, hud, hudRoot, me } = c;
    world.scene.add(this.companions.group, this.fireworks.points);
    this.weatherFx = new WeatherFx(c.lowPower);
    world.scene.add(this.weatherFx.group);
    // Mahalle: bloklar sahnede, çarpışmaya da katılır
    world.scene.add(this.buildWorld.group);
    world.colliders.extra = this.buildWorld;
    this.build = new BuildMode(hudRoot, this.buildWorld, world.scene, c.canvas, c.camera, {
      userId: () => c.session.user.id,
      send: (ev) => net.send(ev),
      toast: (t) => hud.toast(t),
    });
    c.life.onStop(() => (world.colliders.extra = null));
    this.screenGlow = new ScreenGlow(world.screen, SCREEN_W, SCREEN_H);
    world.scene.add(this.screenGlow.group, this.bilekArms.group);
    this.leaves = new SeasonParticles(world.season, c.lowPower);
    world.scene.add(this.mist.mesh, this.confetti.mesh, this.splashes.mesh, this.haze.mesh);
    this.rings = new THREE.InstancedMesh(
      new THREE.RingGeometry(0.42, 0.56, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false }),
      32,
    );
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 2;
    world.scene.add(this.rings);
    if (this.leaves.mesh) world.scene.add(this.leaves.mesh);
    c.life.onStop(() => this.fireworks.dispose());
    this.race = new RaceClient({
      scene: world.scene,
      net,
      input: c.input,
      camera: c.camera,
      hudRoot,
      touch: c.input.touch,
      nameOf: (sid) => this.nameOf(sid),
      toast: (t) => hud.toast(t),
    });
    c.life.onStop(() => this.race.dispose());

    // Ocakçı: çay ocağının arkasında duran sabit karakter
    this.teaMaker = {
      x: TEA_MAKER.x, z: TEA_MAKER.z, rot: TEA_MAKER.rot, flags: 0, alpha: 1, cell: c.atlas.alloc(TEA_MAKER_NAME),
      color: colorFor("ocakci"), phase: 0.7, emote: -1, emoteAt: 0, jumpY: 0,
      outfit: { hair: "hair_kisa_doku", tops: "top_tisort", bottoms: "bottom_kot", shoes: "shoes_sneaker", facial: null, hats: null, glasses: null, colors: { hair: "#2a2522", skin: "#e0b48a" } },
    };

    this.boards = new BoardGameUi(hudRoot, () => net.you, (ev) => net.send(ev), () => net.serverNow());
    this.profile = new ProfileUi(hudRoot, {
      me: () => net.you,
      request: (sid) => net.send({ t: "profile", sid }),
      avatar: (sid) => {
        const info = sid === net.you ? null : c.remotes.map.get(sid)?.info;
        const id = info ? info.id : c.session.user.id;
        const hash = info ? info.avatar : c.session.user.avatar;
        return hash ? `${c.session.base}/avatar/${id}/${hash}` : null;
      },
    });
    this.whud = new WorldHud(hudRoot, () => net.you, {
      dj: (op, show) => net.send({ t: "dj", op, show }),
      enqueue: (url) => c.say(`!kuyruk ${url}`),
      tagJoin: () => net.send({ t: "tagjoin" }),
      pairOk: (from) => net.send({ t: "pairok", from }),
    }, (sid) => this.nameOf(sid));
    this.photo = new PhotoMode(hudRoot, {
      capture: () => {
        c.renderNow();
        return canvasToJpeg(c.canvas);
      },
      setFilter: () => {},
      upload: (image) => this.upload(image),
      toast: (t) => hud.toast(t),
      quests: (d) => this.questToast(d),
    });
    this.hub = new Hub(hudRoot, c.input.touch, {
      quests: () => this.profile.openQuests(),
      card: () => this.profile.open(net.you, c.session.user.name),
      album: () => this.profile.openAlbum(c.session.user.name),
      photo: () => this.photo.toggle(),
      vehicle: (v) => this.setVehicle(v),
      fireworks: () => net.send({ t: "fireworks" }),
      tag: (mode) => c.say(`!${mode}`),
      match: () => c.say(this.match ? "!maç bitir" : "!maç 5"),
      build: () => this.build.toggle(),
      pair: (kind) => this.pair(kind),
      queue: () => this.whud.openQueue(),
      weather: () => c.say("!hava"),
      battle: c.battle,
      cosmetics: () => this.sendCosmetics(),
    });

    // ---- Ağ olayları ----
    net.onClock = (h) => (this.worldClock = h);
    net.onWeather = (w) => {
      world.setWeather(w);
      this.weatherFx.set(w);
    };
    this.weatherFx.onThunder = () => sfx.thunder();
    net.onFireworks = (seed, at, count) => {
      const startAt = (at - net.offset - performance.timeOrigin) / 1000;
      this.fireworks.show(seed, Math.max(startAt, performance.now() / 1000 + 0.2), count);
    };
    this.fireworks.onBurst = (delay, x, _y, z) => {
      const d = Math.hypot(x - c.camera.position.x, z - c.camera.position.z);
      sfx.firework(delay, 0.4 + 0.6 * falloff(d * 0.5), (x - c.camera.position.x) / 40);
    };
    net.onBall = (b) => {
      world.pitch.setBall(b, net.serverNow());
      // Vuruş/direk sesleri (kendi vuruşumuzun sesi basınca çaldı)
      if (!b.ev || b.by === net.you) return;
      const gain = falloff(Math.hypot(b.x - me.x, b.z - me.z));
      if (b.ev === "post" || b.ev === "bar") sfx.post(Math.max(0.15, gain));
      else if (b.ev === "save") {
        sfx.header(Math.max(0.3, gain));
        sfx.cheer(0.35 * gain);
      } else if (b.ev === "tackle") sfx.kick(0.35 * gain);
      else if (b.ev === "head") sfx.header(gain);
      else sfx.kick((b.ev === "pass" ? 0.45 : 0.8) * gain);
    };
    net.onGk = (k) => world.pitch.setKeepers(k);
    net.onPlots = (p) => this.buildWorld.setAll(p);
    net.onPlot = (p) => {
      const was = this.buildWorld.plots[p.id]?.owner;
      this.buildWorld.setPlot(p);
      if (p.owner === c.session.user.id && was !== p.owner) hud.toast("🏠 Arsa senin! Mahallede tabelada adın yazıyor. N ile inşa et.");
    };
    net.onBset = (plot, i, j, k, b, r) => this.buildWorld.set(plot, i, j, k, b, r);
    net.onFb = (text) => {
      if (Math.hypot(me.x - PITCH.x, me.z - PITCH.z) > 40) return;
      sfx.whistle();
      hud.toast(text);
    };
    net.onMatch = (m) => {
      const was = this.match;
      this.match = m;
      if (m && !was) {
        sfx.whistle();
        const team = m.teams[0].includes(net.you) ? "🔴 Kırmızı" : m.teams[1].includes(net.you) ? "🔵 Mavi" : null;
        hud.toast(team ? `⚽ Maç başladı! Takımın: ${team}` : "⚽ Maç başladı!");
      } else if (!m && was) {
        sfx.whistle();
        sfx.cheer(0.7);
      }
    };
    net.onScore = (s) => {
      this.score = s;
      world.pitch.setScore(s);
    };
    net.onGoal = (side, sid, name, s, assist, own) => {
      this.score = s;
      world.pitch.setScore(s);
      sfx.whistle();
      sfx.cheer(Math.max(0.3, falloff(Math.hypot(PITCH.x - me.x, PITCH.z - me.z))));
      const bp = world.pitch.ball;
      world.pitch.netHit(bp.x, bp.y, bp.z, performance.now() / 1000);
      const t = performance.now() / 1000;
      const gx = PITCH.x + (side ? 1 : -1) * PITCH.hx;
      c.emoteFx.emit(gx, 1, PITCH.z, FX_CELL.party, t, 0.5, 6);
      this.confetti.burst(gx - (side ? 1 : -1) * 1.5, 1.5, PITCH.z, t);
      c.emoteFx.emit(gx, 1.5, PITCH.z, FX_CELL.ball, t + 0.2, 0.5, 3);
      const who = sid === net.you ? "Sen attın" : name;
      hud.toast(own ? `🙈 Kendi kalesine! ${who} · ${s[0]}–${s[1]}` : `⚽ GOL! ${who}${assist ? ` · asist: ${assist}` : ""} · ${s[0]}–${s[1]}`);
    };
    net.onTable = (t) => {
      this.boards.update(t);
      // Masa oyunu bitti: kazanan için kupa
      if (t.note.startsWith("🏆") && t.game) {
        const winner = t.order.find((s) => t.note.includes(this.nameOf(s)));
        if (winner) this.fxAt(winner, FX_CELL.trophy, 3);
      }
    };
    net.onTag = (s) => this.whud.setTag(s, net.serverNow());
    net.onRace = (s) => this.race.onState(s);
    net.onRcars = (cars) => this.race.onCars(cars);
    net.onPairReq = (from, name, kind) => {
      this.whud.pairRequest(from, name, kind);
      sfx.pop();
    };
    net.onPair = (a, b, kind) => this.playPair(a, b, kind);
    net.onQuest = (done) => this.questToast(done);
    net.onProfile = (sid, name, p, err) => this.profile.onProfile(sid, name, p, err);
    net.onStage = (s) => {
      this.stage = { dj: s.dj, show: s.show, singer: s.singer };
      this.whud.setStage(s);
      // Sunucu sahneyi başkasına verdiyse in
      if (me.onStage && s.singer !== net.you) me.setStage(false);
    };
    net.onCosm = () => {};
    const prevWelcome = net.onStatus;
    net.onStatus = (s) => {
      prevWelcome(s);
      if (s === "online") this.sendCosmetics();
    };

    // 3B'de bir avatara tıklayınca oyuncu kartı (sürükleme değilse)
    c.canvas.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY, at: performance.now() }));
    c.canvas.addEventListener("pointerup", (e) => {
      if (this.build.active || c.input.locked || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6 || performance.now() - this.down.at > 400) return;
      const sid = this.pickAvatar(e.clientX, e.clientY);
      if (sid) this.profile.open(sid, this.nameOf(sid));
    });
  }

  private nameOf(sid: number): string {
    return sid === this.c.net.you ? this.c.session.user.name : this.c.remotes.map.get(sid)?.info.name ?? "Biri";
  }

  /** İnşa modunda rakamlar blok seçer (emote değil). */
  get building(): boolean {
    return this.build.active;
  }

  /** Oyuncu listesinden kart açma. */
  openCard(sid: number, name: string): void {
    this.profile.open(sid < 0 ? this.c.net.you : sid, name);
  }

  private sendCosmetics(): void {
    this.c.net.send({ t: "cosm", pet: settings.pet || null, skin: settings.skin || null });
  }

  private async upload(image: string): Promise<{ ok: boolean; error?: string; completed?: never[] }> {
    const s = this.c.session;
    const guild = new URL(s.wsUrl).searchParams.get("guild");
    try {
      const r = await fetch(`${s.base}/api/photo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: s.session, guild, watch: s.watchId, image }),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; completed?: never[] };
      return r.ok && body.ok ? { ok: true, completed: body.completed } : { ok: false, error: body.error };
    } catch {
      return { ok: false, error: "Bağlantı hatası." };
    }
  }

  private questToast(done: { title: string; xp: number }[]): void {
    if (!done.length) return;
    sfx.quest();
    this.c.hud.toast(`📋 Görev tamam: ${done.map((d) => `${d.title} (+${d.xp} XP)`).join(" · ")}`);
    this.profile.questsDone(done as never);
    this.fxAt(this.c.net.you, FX_CELL.sparkle, 4);
  }

  private fxAt(sid: number, cell: number, n = 2): void {
    const p = this.posOf(sid);
    if (p) this.c.emoteFx.emit(p.x, 0, p.z, cell, performance.now() / 1000, undefined, n);
  }

  private posOf(sid: number): { x: number; z: number } | null {
    if (sid === this.c.net.you) return this.c.me;
    const r = this.c.remotes.map.get(sid);
    return r?.hasData ? r : null;
  }

  private setVehicle(v: Vehicle): void {
    const me = this.c.me;
    if (me.driving || me.jailed) return;
    if (me.vehicle === 3 && v !== 3) me.setVehicle(v, DOCK);
    else me.setVehicle(v);
    if (v) this.c.hud.toast(v === 1 ? "🚲 Bisiklete bindin (B: değiştir)" : v === 2 ? "🛹 Kaykaydasın (B: değiştir)" : "🛶 Kayıktasın: iskelede F ile in");
  }

  /** En yakın oyuncuya beşlik/sarılma isteği. */
  private pair(kind: "five" | "hug"): void {
    const { me, remotes, net, hud } = this.c;
    let best: Remote | null = null, bestD = 3;
    for (const r of remotes.map.values()) {
      if (!r.hasData || r.leaving) continue;
      const d = Math.hypot(r.x - me.x, r.z - me.z);
      if (d < bestD) [best, bestD] = [r, d];
    }
    if (!best) return hud.toast("🤝 Yakında kimse yok (3 m içinde olmalı).");
    net.send({ t: "pair", kind, to: best.info.sid });
    hud.toast(kind === "five" ? `🙌 ${best.info.name}'e beşlik uzattın…` : `🤗 ${best.info.name}'e kollarını açtın…`);
  }

  private playPair(a: number, b: number, kind: "five" | "hug"): void {
    const pa = this.posOf(a), pb = this.posOf(b);
    if (!pa || !pb) return;
    const t = performance.now() / 1000;
    const set = (sid: number, from: { x: number; z: number }, to: { x: number; z: number }) => {
      const face = Math.atan2(to.x - from.x, to.z - from.z);
      const view: AvatarView | undefined = sid === this.c.net.you ? this.c.me : this.c.remotes.map.get(sid);
      if (view) view.pair = { kind, at: t, face };
    };
    set(a, pa, pb);
    set(b, pb, pa);
    const mx = (pa.x + pb.x) / 2, mz = (pa.z + pb.z) / 2;
    this.c.emoteFx.emit(mx, 0.2, mz, kind === "five" ? FX_CELL.five : FX_CELL.hearts, t + (kind === "five" ? 0.4 : 0.2), undefined, kind === "five" ? 3 : 4);
    window.setTimeout(() => (kind === "five" ? sfx.clap() : sfx.pop()), kind === "five" ? 420 : 200);
    if (a === this.c.net.you || b === this.c.net.you) {
      const other = this.nameOf(a === this.c.net.you ? b : a);
      this.c.hud.toast(kind === "five" ? `🙌 ${other} ile beşlik!` : `🤗 ${other} ile sarıldınız`);
    }
  }

  /** Ekrandaki tıklamaya en yakın avatar (30 px içinde). */
  private pickAvatar(cx: number, cy: number): number {
    const { camera, remotes, me, net } = this.c;
    let best = 0, bestD = 30;
    const test = (sid: number, x: number, z: number) => {
      this.proj.set(x, 1.1, z).project(camera);
      if (this.proj.z > 1) return;
      const sx = ((this.proj.x + 1) / 2) * innerWidth, sy = ((1 - this.proj.y) / 2) * innerHeight;
      const d = Math.hypot(sx - cx, sy - cy);
      if (d < bestD) [best, bestD] = [sid, d];
    };
    for (const r of remotes.map.values()) if (r.hasData && !r.leaving) test(r.info.sid, r.x, r.z);
    if (!settings.firstPerson) test(net.you, me.x, me.z);
    return best;
  }

  // ---------------------------------------------------------------------------
  // Yakındaki etkileşimler
  // ---------------------------------------------------------------------------

  acts(): FeatureAct[] {
    const { me, world } = this.c;
    if (me.jailed || me.driving || this.race.driving()) return [];
    const near = (p: { x: number; z: number }, r: number) => Math.hypot(me.x - p.x, me.z - p.z) <= r;
    if (me.vehicle === 3) return near(DOCK, 4.5) || Math.hypot(me.x - POND_AREA.x, me.z - POND_AREA.z) > 4.6 ? [{ key: "f", label: "Kayıktan in 🛶", act: "boat-off" }] : [];
    if (me.onStage) return [{ key: "f", label: "Sahneden in 🎤", act: "stage-off" }];
    // Futbol: top ayaktaysa ya da serbest top yakınsa vuruş; rakibin ayağındaysa müdahale
    const ball = world.pitch.ball;
    const owner = world.pitch.owner;
    const ballD = Math.hypot(ball.x - me.x, ball.z - me.z);
    if (owner > 0 && owner !== this.c.net.you && ballD <= 1.7 && !me.seated) return [{ key: "f", label: "Müdahale 🦵", act: "tackle" }];
    if ((owner === this.c.net.you || (owner === 0 && ballD <= KICK_REACH)) && !me.seated) {
      const ch = this.charge;
      const fin = this.finishing();
      return [
        { key: "f", label: ch?.kind === "shot" ? "Şut… bırak ⚽" : fin ? "Şut ⚽ (basılı: sert)" : "Pas · basılı tut: şut ⚽", act: "kick" },
        { key: "g", label: ch?.kind === "lob" ? "Aşırtma… bırak 🌙" : "Aşırtma 🌙", act: "lob" },
      ];
    }
    if (me.seatTable) return [{ key: "f", label: "Masayı aç 🎲", act: `table:${me.seatTable.id}` }];
    if (near(TEA_COUNTER, TEA_COUNTER.r)) return [{ key: "f", label: "Çay söyle 🍵", act: "cay" }];
    for (const t of TABLES) {
      if (near(t, TABLE_WATCH_R) && !me.seated) return [{ key: "f", label: "Masayı izle 👀 (oynamak için tabureye otur)", act: `table:${t.id}` }];
    }
    if (near(DJ_BOOTH, DJ_BOOTH.r)) {
      const mine = this.stage.dj === this.c.net.you;
      return mine
        ? [{ key: "f", label: "DJ paneli 🎧", act: "dj-panel" }, { key: "g", label: "Kabinden çık", act: "dj-leave" }]
        : [{ key: "f", label: this.stage.dj ? `DJ: ${this.nameOf(this.stage.dj)} · kuyruğa şarkı ekle 🎵` : "DJ ol 🎧", act: this.stage.dj ? "queue" : "dj-take" }];
    }
    if (near(STAGE_STEPS, STAGE_STEPS.r)) return [{ key: "f", label: this.stage.singer ? `Sahnede ${this.nameOf(this.stage.singer)} 🎤` : "Sahneye çık 🎤 (karaoke)", act: this.stage.singer ? "queue" : "stage-on" }];
    if (near(DOCK, DOCK.r + 0.6) && !me.vehicle) return [{ key: "f", label: "Kayığa bin 🛶", act: "boat-on" }];
    if (Math.abs(me.x - RACE_HOUSE.x) < RACE_HOUSE.hw && Math.abs(me.z - RACE_HOUSE.z) < RACE_HOUSE.hd && !me.seated) {
      return [this.race.joined() ? { key: "f", label: "Yarış lobisi 🏎️", act: "race-panel" } : { key: "f", label: "Oyuncak pist yarışına katıl 🏎️", act: "race-join" }];
    }
    return [];
  }

  /** Etkileşim gerçekleşti (true: işlendi). */
  handleAct(act: string, now: number): boolean {
    const { me, net, hud, emoteFx } = this.c;
    if (act === "tackle") {
      net.send({ t: "tackle" });
      sfx.kick(0.3);
      return true;
    }
    if (act === "kick" || act === "lob") {
      // Şarj başlar: bırakınca vurulur (F'ye kısa dokunuş pas). Dokunmatikte hemen orta güçle.
      if (this.c.input.touch) this.kick(0.55, act === "lob" ? "lob" : this.finishing() ? "shot" : "pass");
      else this.charge = { key: act === "lob" ? "actG" : "actF", kind: act === "lob" ? "lob" : "shot", t: 0 };
      return true;
    }
    if (act.startsWith("table:")) {
      this.boards.open(Number(act.slice(6)));
      return true;
    }
    switch (act) {
      case "cay":
        net.send({ t: "act", a: "cay" });
        emoteFx.emit(me.x, 0, me.z, FX_CELL.tea, now / 1000, undefined, 2);
        this.teaMaker.emote = 0;
        this.teaMaker.emoteAt = now / 1000;
        hud.toast(`🍵 ${TEA_MAKER_NAME}: "Hemen geliyor, tavşan kanı!"`);
        return true;
      case "dj-take":
        net.send({ t: "dj", op: "take" });
        return true;
      case "dj-leave":
        net.send({ t: "dj", op: "leave" });
        return true;
      case "dj-panel":
      case "queue":
        this.whud.openQueue();
        return true;
      case "stage-on":
        me.setStage(true);
        net.send({ t: "stage", on: true });
        hud.toast("🎤 Sahnedesin! Şarkıyı kuyruğa ekle (🎵) ya da !izle ile karaoke videosu aç.");
        return true;
      case "stage-off":
        me.setStage(false);
        return true;
      case "boat-on":
        this.setVehicle(3);
        return true;
      case "race-join":
        net.send({ t: "rjoin" });
        return true;
      case "race-panel":
        this.race.openPanel();
        return true;
      case "boat-off":
        this.setVehicle(0);
        return true;
      default:
        return false;
    }
  }

  /** Maçtaki takımım (yoksa null). */
  private myTeam(): 0 | 1 | null {
    const m = this.match, you = this.c.net.you;
    return m ? (m.teams[0].includes(you) ? 0 : m.teams[1].includes(you) ? 1 : null) : null;
  }

  /** Hücum ettiğim kale ve ona göre durumum (top nerede, kaleye ne kadar dönüğüm). */
  private attack(): { side: -1 | 1; dist: number; off: number } {
    const { me, world } = this.c;
    const b = world.pitch.ball;
    const side = attackSide(this.myTeam(), b.x, b.z, me.rot);
    return { side, ...goalView(side, b.x, b.z, me.rot) };
  }

  /** Kaleye yakın ve dönük: kısa dokunuş pas değil plase şut. */
  private finishing(): boolean {
    const a = this.attack();
    return a.dist < FINISH_RANGE && a.off < 0.9;
  }

  /**
   * Vuruş yönü (FIFA/PES gibi kameradan değil, oyuncunun baktığı/koştuğu yönden): şut kaleye dönükse
   * kalecinin uzak köşesine kendiliğinden nişan alır; aşırtma kaleye yakınken kalecinin üstünden kaleye.
   */
  private kickDir(kind: KickKind): number {
    const { me, world } = this.c;
    const b = world.pitch.ball;
    const a = this.attack();
    if (kind === "shot") return assistedShot(a.side, b.x, b.z, me.rot, world.pitch.keeper(a.side).z);
    if (kind === "lob" && a.dist < 20 && a.off < 0.9) return assistedShot(a.side, b.x, b.z, me.rot, null);
    return me.rot;
  }

  private kick(power: number, kind: KickKind): void {
    const { me, net } = this.c;
    const ang = this.kickDir(kind);
    net.send({ t: "kick", dir: ang, power, kind, curve: 0 });
    me.rot = ang;
    sfx.kick(kind === "pass" ? 0.45 : 0.6 + power * 0.4);
  }

  // ---------------------------------------------------------------------------
  // Kare başına
  // ---------------------------------------------------------------------------

  /** Kısayollar (oyuncu güncellemesinden önce). */
  keys(): void {
    const { input, me } = this.c;
    if (input.consumeKey("menu")) this.hub.toggle();
    if (input.consumeKey("build")) this.build.toggle();
    if (this.build.active) {
      const e = input.consumeEmote();
      if (e >= 0) this.build.pickSlot(e);
    }
    if (input.consumeKey("photo")) this.photo.toggle();
    if (input.consumeKey("quests")) this.profile.toggleQuests();
    if (input.consumeKey("card")) this.profile.open(this.c.net.you, this.c.session.user.name);
    if (input.consumeKey("album")) this.profile.openAlbum(this.c.session.user.name);
    if (input.consumeKey("five")) this.pair("five");
    if (input.consumeKey("hug")) this.pair("hug");
    if (input.consumeKey("accept")) this.whud.acceptPair();
    if (input.consumeKey("camera")) updateSettings({ firstPerson: !settings.firstPerson });
    if (input.consumeKey("vehicle") && me.vehicle !== 3) this.setVehicle(((me.vehicle + 1) % 3) as Vehicle);
    me.photo = this.photo.active;
  }

  update(time: number, dt: number, now: number): void {
    const { me, net, world, remotes, input, emoteFx, camera } = this.c;
    const serverNow = net.serverNow();

    // Saat: kişisel ayar > sinema modu (gündüzse) > dünyanın saati (!saat) > gerçek saat
    let hour: number | null = settings.clock === "auto" ? this.worldClock : CLOCK_HOURS[settings.clock];
    // Karartma, karartılmış gökten değil asıl saatten karar verir (yoksa kararınca kapanıp gidip gelir)
    if (settings.clock === "auto" && settings.cinemaDim && this.c.inCinema() && daylight(hour ?? istanbulHour()) > 0.3) hour = CINEMA_HOUR;
    world.setHour(hour);

    this.buildWorld.update(world.env.lights);
    this.build.update();
    this.race.update(dt, time, 1 - world.env.day);
    this.bilekArms.update((id) => this.boards.table(id), dt);
    this.screenGlow.update(now, dt, this.c.cinemaOn(), document.querySelector<HTMLVideoElement>(".screen-players video"), world.env.day);
    this.ambient(time, dt, world);

    // Sahne: nasıl inilirse inilsin sunucuya bildir (sunucu sahneyi aldıysa bu mesaj yok sayılır)
    if (this.wasOnStage && !me.onStage) net.send({ t: "stage", on: false });
    this.wasOnStage = me.onStage;

    // Masa: tabureye oturunca masaya katıl, kalkınca ayrıl
    const seat = me.seatTable;
    if (seat?.id !== this.lastSeat?.id || seat?.seat !== this.lastSeat?.seat) {
      if (seat) {
        net.send({ t: "tsit", id: seat.id, seat: seat.seat });
        this.sitAt = now;
        this.boards.open(seat.id);
      } else {
        net.send({ t: "tleave" });
        if (this.boards.current === this.lastSeat?.id) this.boards.close();
      }
      this.lastSeat = seat;
    } else if (seat && now - this.sitAt > 1500) {
      // Sunucu henüz kabul etmediyse (konumum yetişmemiş olabilir) yeniden dene; başkası oturduysa kalk
      const t = this.boards.table(seat.id);
      const holder = t?.seats[seat.seat];
      if (holder !== net.you) {
        this.sitAt = now;
        if (holder) {
          me.standUpNow();
          this.c.hud.toast("🪑 Bu tabureye başkası oturdu.");
        } else net.send({ t: "tsit", id: seat.id, seat: seat.seat });
      }
    }

    // Vuruş gücü: basılı tutuldukça dolar (0.9 sn'de tam). F'ye kısa dokunuş pas (kaleye yakınsa plase şut),
    // uzun basış şut; G aşırtma. Yön oyuncunun baktığı/koştuğu yön, şut kaleye kendiliğinden nişan alır.
    const ch = this.charge;
    if (ch) {
      if (input.heldAction(ch.key)) {
        ch.t += dt;
        const p = Math.min(1, ch.t / 0.9);
        const tap = ch.kind === "shot" && ch.t < PASS_TAP;
        this.whud.setPower(tap ? null : p, ch.kind === "lob" ? "Aşırtma" : "Şut");
      } else {
        const tap = ch.kind === "shot" && ch.t < PASS_TAP;
        if (tap) this.kick(this.finishing() ? 0.5 : 0.4, this.finishing() ? "shot" : "pass");
        else this.kick(Math.max(0.15, Math.min(1, ch.t / 0.9)), ch.kind);
        this.charge = null;
        this.whud.setPower(null);
      }
    }
    // Nişan oku: topun yanındayken vuruş yönü ve gücü
    const ball = world.pitch.ball;
    const owner = world.pitch.owner;
    // Topla koşan biraz yavaş (FIFA/PES gibi): savunma yetişebilsin
    me.speedMul = owner === net.you ? 0.88 : 1;
    const canKick = (owner === net.you || (owner === 0 && Math.hypot(ball.x - me.x, ball.z - me.z) <= KICK_REACH + 0.6)) && !me.seated && !me.vehicle;
    world.pitch.setAim(
      canKick && !input.touch
        ? (() => {
            // Ok, gidecek yönü gösterir: şutta kaleye kilitlenen yön, pasta baktığın yön
            const kind: KickKind = ch ? (ch.kind === "shot" && ch.t < PASS_TAP && !this.finishing() ? "pass" : ch.kind) : this.finishing() ? "shot" : "pass";
            return { ang: this.kickDir(kind), power: ch ? Math.min(1, ch.t / 0.9) : 0, kind };
          })()
        : null,
    );
    const nearPitch = Math.abs(me.x - PITCH.x) < PITCH.hx + 8 && Math.abs(me.z - PITCH.z) < PITCH.hz + 8;
    const m = this.match;
    const clock = m ? matchClock(m.endsAt - serverNow) : null;
    const myTeam = m ? (m.teams[0].includes(net.you) ? 0 : m.teams[1].includes(net.you) ? 1 : null) : null;
    this.whud.setScore(nearPitch || m ? this.score : null, clock, myTeam);
    world.pitch.setScore(this.score, clock);
    world.pitch.update(dt, serverNow, world.env.lights, (sid) => {
      const run = (f: number) => (f & FLAG_RUNNING ? 2 : f & FLAG_WALKING ? 1 : 0);
      if (sid === net.you) return { x: me.x, z: me.z, rot: me.rot, run: run(me.flags) };
      const r = remotes.map.get(sid);
      return r?.hasData ? { x: r.x, z: r.z, rot: r.rot, run: run(r.flags) } : null;
    });
    this.updateRings(m);

    // Yolculuk: görev için ara ara bildirilir
    if (me.rideMeters >= 1 && now - this.lastRide > RIDE_REPORT_MS) {
      this.lastRide = now;
      net.send({ t: "ride", m: Math.round(me.rideMeters) });
      me.rideMeters = 0;
    }

    // Kayık ve kıyıda yürüyenler gölde halka bırakır
    if (time - this.lastRipple > 0.45) {
      this.lastRipple = time;
      const ripple = (x: number, z: number, flags: number) => {
        const d = Math.hypot(x - POND_AREA.x, z - POND_AREA.z);
        const boat = vehicleOf(flags) === 3;
        if ((boat && flags & FLAG_WALKING) || (!boat && flags & FLAG_WALKING && d < POND_AREA.r + 1.2)) {
          const k = boat ? 1 : POND_AREA.r / d;
          world.ripple(POND_AREA.x + (x - POND_AREA.x) * k, POND_AREA.z + (z - POND_AREA.z) * k, time);
        }
      };
      ripple(me.x, me.z, me.flags);
      for (const r of remotes.map.values()) if (r.hasData) ripple(r.x, r.z, r.flags);
    }

    // Ebelemece/saklambaç: geri sayım ve ebenin başında 👀
    if (now - this.lastTagHud > 250) {
      this.lastTagHud = now;
      this.whud.updateTag(serverNow);
    }
    const it = this.whud.it;
    if (it && time - this.lastMark > 1.3) {
      this.lastMark = time;
      const p = this.posOf(it);
      if (p) emoteFx.emit(p.x, 0.3, p.z, FX_CELL.eyes, time, undefined, 1);
    }

    // Sahne: DJ ışık şovu ve şarkıcıya takip spotu
    const singer = this.stage.singer ? this.posOf(this.stage.singer) : null;
    world.stageLights.update(time, this.stage.show, singer, this.c.music(), 1 - world.env.day * 0.85);

    // Hava ve havai fişek
    this.weatherFx.update(time, dt, camera.position, 0.35 + 0.65 * world.env.day);
    world.flash(this.weatherFx.flash);
  }

  /** Maçta herkesin altında takım renginde halka. */
  private updateRings(m: MatchState | null): void {
    const { me, remotes, net } = this.c;
    if (!m) {
      this.rings.count = 0;
      return;
    }
    const mtx = new THREE.Matrix4();
    let n = 0;
    const put = (sid: number, x: number, z: number) => {
      const team = m.teams[0].includes(sid) ? 0 : m.teams[1].includes(sid) ? 1 : -1;
      if (team < 0 || n >= 32) return;
      mtx.makeTranslation(x, 0.06, z);
      this.rings.setMatrixAt(n, mtx);
      this.rings.setColorAt(n, TEAM_COLORS[team]);
      n++;
    };
    put(net.you, me.x, me.z);
    for (const r of remotes.map.values()) if (r.hasData && !r.leaving) put(r.info.sid, r.x, r.z);
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
  }

  /** Sis, mevsim parçacıkları, sahne dumanı, konfeti ışığı ve ıslak zeminde adım sıçramaları. */
  private ambient(time: number, dt: number, world: World): void {
    const { camera, me, remotes, net } = this.c;
    const day = world.env.day;
    const w = this.weatherFx.current;
    // Sis: gün doğumunda pus, akşam hafif; sisli havada yoğun, yağmurda orta
    const h = world.hour();
    const dawn = Math.max(0, 1 - Math.abs(h - 6.9) / 2.2), evening = Math.max(0, 1 - Math.abs(h - 20.6) / 1.6) * 0.45;
    const weather = w.kind === "fog" ? 1 : w.kind === "rain" || w.kind === "storm" ? 0.45 : w.kind === "snow" ? 0.35 : 0;
    this.fogColor.copy((world.scene.fog as THREE.Fog).color);
    this.mist.update(camera.position, Math.max(dawn, evening, weather), this.fogColor, dt);
    this.leaves.update(camera.position, 0.35 + 0.65 * day, w.kind === "storm" ? 2.2 : w.kind === "rain" ? 1.4 : 1);
    this.haze.update(this.stage.show > 0, 1 - day, dt);
    const light = 0.4 + 0.6 * day;
    this.confetti.light = light;
    this.splashes.light = light;
    // Adım sıçraması: ıslak zeminde yürüyen/koşan (araçsız, yerde) herkes
    const wet = wetUniform.value;
    if (wet < 0.25) return;
    const step = (sid: number, x: number, z: number, flags: number, air: number) => {
      if (!(flags & FLAG_WALKING) || vehicleOf(flags) || air > 0.05) return;
      if (Math.hypot(x - camera.position.x, z - camera.position.z) > 30) return;
      const run = (flags & FLAG_RUNNING) !== 0;
      const last = this.lastStep.get(sid) ?? 0;
      if (time - last < (run ? 0.26 : 0.36)) return;
      this.lastStep.set(sid, time);
      this.splashes.step(x, z, time, wet * (run ? 1 : 0.6));
    };
    if (!me.onStage && !me.seated) step(net.you, me.x, me.z, me.flags, me.jumpY);
    for (const r of remotes.map.values()) if (r.hasData && !r.leaving && !r.lift) step(r.info.sid, r.x, r.z, r.flags, r.jumpY);
  }

  /** Bilek güreşi süren masalardaki oyuncular (kolları masada). */
  private wrestlers(): Set<number> {
    const out = new Set<number>();
    for (const spot of TABLES) {
      const g = spot.kind === "bilek" ? this.boards.table(spot.id)?.game : null;
      if (g?.kind === "bilek" && g.state.winner === null) for (const s of this.boards.table(spot.id)!.order) out.add(s);
    }
    return out;
  }

  /** Avatar çiziminden önce: kendi ve uzak avatarların ek durumları (sahne, mikrofon, isim gizleme). */
  decorate(): void {
    const { me, remotes, net } = this.c;
    me.mic = this.stage.singer === net.you && me.onStage;
    const wrestlers = this.wrestlers();
    me.grip = wrestlers.has(net.you);
    me.hideName = this.whud.hiddenName(net.you);
    me.hidden = settings.firstPerson && !me.driving && !this.photo.active;
    for (const r of remotes.map.values()) {
      r.lift = r.info.sid === this.stage.singer ? STAGE.h : 0;
      r.mic = r.info.sid === this.stage.singer;
      r.grip = wrestlers.has(r.info.sid);
      r.hideName = this.whud.hiddenName(r.info.sid);
    }
  }

  /** Avatarların yanında evcil hayvan ve araçlar; ocakçı. */
  pushExtras(time: number, dt: number): void {
    const { me, remotes, avatars, net } = this.c;
    avatars.push(this.teaMaker, time);
    const c = this.companions;
    c.begin();
    if (!me.driving) c.push(net.you, me, settings.pet || null, time, dt);
    for (const r of remotes.map.values()) if (r.hasData) c.push(r.info.sid, r, r.info.pet, time, dt);
    c.end();
  }

  /** Fotoğraf filtresi (0 yok): son işlem zorla açılır. */
  get filter(): number {
    return this.photo.active ? this.photo.filter : 0;
  }
}

