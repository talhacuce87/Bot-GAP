// Dünyanın yeni özellikleri tek yerde: hava ve havai fişek, futbol, kahvehane masaları ve çay ocağı, DJ ve sahne,
// ebelemece/saklambaç, beşlik/sarılma, araçlar ve evcil hayvanlar, görevler, oyuncu kartı, fotoğraf modu.
// main.ts her kare `update` çağırır; yakındaki etkileşimleri `acts` ile ekler.
import * as THREE from "three";
import { FLAG_RUNNING, FLAG_WALKING, vehicleOf, type Vehicle } from "../../shared/constants";
import type { KickKind, MatchState } from "../../shared/protocol";
import { assistedShot, attackSide, FINISH_RANGE, goalView } from "../../shared/football";
import { CASINO, DJ_BOOTH, DOCK, type Field, inStadium, KICK_REACH, PITCH, POND_AREA, RACE_HOUSE, STADIUM_PITCH, STAGE, STAGE_STEPS, TABLE_WATCH_R, TABLES, TEA_COUNTER, TEA_MAKER } from "../../shared/zones";
import { type Action, actionLabel, onBinds, profile, setProfile } from "./input/keybinds";
import { RaceClient } from "./race";
import { MosqueClient } from "./mosque";
import { PaintballClient } from "./paintball";
import { PB_FIELD } from "../../shared/paintball";
import { VolleyClient } from "./volley";
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
import { CAR_DIMS, CAR_MASS, CAR_PROBE_Y, type CarBody, type Player } from "./player";
import { settings, updateSettings } from "./settings";
import { BoardGameUi } from "./ui/boardGame";
import { CasinoUi, fmt } from "./ui/casino/casinoUi";
import { drawSpeedo, RingHud } from "./ui/ringHud";
import { Vehicles } from "./vehicles";
import { GRID, GRID_REACH, lightsAt, RACE_LAPS, type RingView, trackAt, trackProject } from "../../shared/ring";
import { LIVE_TABLES } from "../../shared/liveCasino";
import type { Hud } from "./ui/hud";
import { RadioPanel } from "./ui/radioPanel";
import { RadioMixer, type RadioSource } from "./radio";
import { type CarDents, type CarRadio, carCircles, CAR_ENGINES, CAR_MODELS, CAR_STATS, type CarSpec, DEFAULT_CAR, ENTER_REACH, NO_DENTS, RADIO_RANGE } from "../../shared/car";
import { Phone } from "./ui/phone";
import { GALLERY_SLOTS } from "./world/gallery";
import { JobHud } from "./ui/jobHud";
import { JobMarker } from "./world/jobMarker";
import { type JobKind, type JobView, type TaxiCall } from "../../shared/jobs";
import { WorldMap } from "./ui/worldMap";
import { LifeHud, type MapDot } from "./ui/lifeHud";
import { LIFE } from "../../shared/economy";
import { itemDef, type ItemId, KAFEIN_SPEED } from "../../shared/items";
import { ShopUi } from "./ui/shopUi";
import { InventoryUi } from "./ui/inventoryUi";
import { Hotbar } from "./ui/hotbar";
import { EmoteWheel } from "./ui/emoteWheel";
import { HeldItems } from "./world/heldItems";
import { eatPose } from "./avatars/avatars";
import { button, el, Panel } from "./ui/panel";
import { canvasToJpeg, PhotoMode } from "./ui/photo";
import { ProfileUi } from "./ui/profile";
import { falloff, sfx } from "./ui/sfx";
import { WorldHud } from "./ui/worldHud";
import { Confetti, Mist, SeasonParticles, Splashes, StageHaze } from "./world/ambient";
import { daylight, istanbulHour } from "./world/daynight";
import { wetUniform } from "./world/geo";
import { Fireworks } from "./world/fireworks";
import type { Pitch } from "./world/pitch";
import { SCREEN_H, SCREEN_W, type World } from "./world/scene";
import { ScreenGlow } from "./world/screenGlow";
import { BuildWorld } from "./world/buildWorld";
import type { Seat } from "./world/builder";
import { BuildMode } from "./ui/buildUi";
import { WeatherFx } from "./world/weather";
import { CityLife } from "./npcs/cityLife";
import { PED_SID_BASE } from "./npcs/pedestrians";
import type { ChibiLayer } from "./avatars/chibi";
import { EngineSounds, type EngineSource } from "./ui/engine";
import { Horns } from "./ui/horn";
import { CarSmoke } from "./world/carSmoke";

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
  /** Dükkân gardırobu: berberde yalnızca saç, modada yalnızca kıyafet. */
  shopWardrobe(shop: "barber" | "fashion"): void;
  // ---- NPC şehir (feat/npc-sehir) ----
  /** Chibi katmanı: inmiş paket ve kıyafet kurulum işçisi (NPC kalabalığı kıyafetleri için). */
  chibi: ChibiLayer;
  /** Dünyada konuşma balonu (NPC'ler: PED_SID_BASE + kimlik). */
  bubble(sid: number, text: string): void;
}

/** Kişisel saat ayarı → saat; sinema modu en az bu kadar karanlık. */
const CLOCK_HOURS = { day: 13, sunset: 19.5, night: 22 } as const;
const CINEMA_HOUR = 21;
/** Canlı casino masasını izleme eyleminin çıktığı uzaklık (masa merkezinden). */
const LIVE_WATCH_NEAR = 3.8;

const TEA_MAKER_NAME = "Ocakçı Rıza";
const RIDE_REPORT_MS = 8000;
/** F'ye bundan kısa basmak pas. */
const PASS_TAP = 0.18;
const TEAM_COLORS = [new THREE.Color("#ff3b30"), new THREE.Color("#2f8bff")];
/**
 * Stadyumda çalım (topun döndüğü yana çapraz atılış; `angle` baktığı yönden sapma) ve kayma: süratin hızı
 * (m/sn) ve süresi; yerel bekleme (sunucuyla aynı, rainbow da çalımla aynı beklemede).
 */
const SKILL_DASH = { speed: 7.5, t: 0.26, cooldown: 1.4, angle: 0.7 };
const SLIDE_DASH = { speed: 9.5, t: 0.5, cooldown: 1.6 };
const TACKLE_COOLDOWN = 1;
const FIELDS: readonly Field[] = [PITCH, STADIUM_PITCH];

/** Kalan maç süresi "m:ss". */
function matchClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** İşin aracı (scooter ya da sarı damalı taksi). */
const jobCar = (kind: JobKind): CarSpec =>
  kind === "kurye" ? { ...DEFAULT_CAR, model: "motor", plate: "GAP KURYE" } : { ...DEFAULT_CAR, model: "taksi", color: "taksi", decal: "dama", plate: "34 T 3434" };

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
  /** GAP Camii: abdest, cemaat, namaz. */
  readonly mosque: MosqueClient;
  /** GAP Paintball: kulübe, 1v1 maç (birinci şahıs). */
  readonly paintball: PaintballClient;
  /** Voleybol salonu. */
  readonly volley: VolleyClient;
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
  private phone: Phone;
  /** İş: görev kartı, dünyadaki hedef işareti, bekleyen NPC müşteri ve taksi çağrıları. */
  private jobHud: JobHud;
  private jobMarker = new JobMarker();
  private job: JobView | null = null;
  private calls: TaxiCall[] = [];
  private jobNpc: AvatarView | null = null;
  private npcCells = new Map<string, number>();
  /** Cüzdan cevabı telefona mı (Cüzdan uygulaması) yoksa para kutusunun paneline mi. */
  private walletToPhone = false;
  private map: WorldMap;
  /** Hayat barları, minimap, GAP ₺ ve yaralı kartı. */
  private lifeHud: LifeHud;
  private dots: MapDot[] = [];
  private repairAsked = false;
  /** Göçükler (herkes görür) ve taraf başına birikmiş hasar. */
  dents: CarDents = { ...NO_DENTS };
  private zones = { f: 0, r: 0, l: 0, rt: 0 };
  /** Diğer oyuncuların arabalarının önceki yeri (hız tahmini: çarpışmada). */
  private carPrev = new Map<number, { x: number; z: number; t: number; vx: number; vz: number }>();
  /** Yeme-içme: dükkân, çanta (I), hızlı slot (1–6), eldeki eşyalar ve emote çarkı ("). */
  private shopUi: ShopUi;
  private inv: InventoryUi;
  private hotbar: Hotbar;
  private wheel: EmoteWheel;
  private held = new HeldItems();
  private buffs: Partial<Record<string, number>> = {};
  private bloodAt = 0;
  /** Şu an kaldırdığın (0: yok). */
  private revivingTarget = 0;
  private whud: WorldHud;
  private stage = { dj: 0, show: 0, singer: 0 };
  /** Önceki karede sahnede miydik: inişi (F, öne yürüme, araç, ışınlanma) sunucuya bildirmek için. */
  private wasOnStage = false;
  /** Sunucunun sabitlediği saat (!saat), null: gerçek saat. */
  private worldClock: number | null = null;
  /** Skor: salon (0) ve stadyum (1). */
  private scores: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  /** Basılı tutulan vuruş: tuş, tür ve geçen süre (sn). */
  private charge: { key: Action; kind: "shot" | "lob" | "power"; t: number } | null = null;
  /** Stadyum: son çalım/müdahale anı (sn), tuş ipucu şeridi, stadyumda mıyız. */
  private lastSkill = -Infinity;
  private lastTackle = -Infinity;
  private fbHelp: HTMLDivElement;
  /** Yön tuşu yokken çalım sırayla iki yana. */
  private skillSide: -1 | 1 = 1;
  /** Stadyum: takım menüsü (B), dünyaya dön ve takım düğmeleri. */
  private teamPanel: Panel;
  private fbExit: HTMLButtonElement;
  private fbTeamBtn: HTMLButtonElement;
  private inArena = false;
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
  /** Şehirdeki dükkân çalışanları (world.npcs ile aynı sıra). */
  private workers: AvatarView[];
  /** Araçlar: park halindeki arabalar, Araçlarım menüsü (T), GAP Garaj tuning'i. */
  private vehicles: Vehicles;
  private radio = new RadioMixer();
  private radioPanel: RadioPanel;
  /** Kendi radyon (sunucudan; arabadan inince de çalar). */
  private myRadio: CarRadio | null = null;
  /** Radyoların ayrı sesleri (sid → ses, kapalı). */
  private radioMix = new Map<number, { vol: number; muted: boolean }>();
  private radioRowsAt = 0;
  /** Arabanın farları: açık, kapalı ya da (null) gece kendiliğinden. */
  myLights: boolean | null = null;
  /** Başkasının arabasında yolcuysan sürücü ve koltuk. */
  myRide: { d: number; s: number } | null = null;
  /** Yakında çalan şarkının etiketi. */
  private radioChip: HTMLDivElement;
  private down = { x: 0, y: 0, at: 0 };
  private proj = new THREE.Vector3();
  private casino: CasinoUi;
  /** GAP Ring: sunucunun yarış durumu, arayüz, seçilen tur sayısı ve ses/uyarı için önceki değerler. */
  private ring: RingView | null = null;
  private raceHud: RingHud;
  private raceLaps = 3;
  private raceRed = 0;
  private raceGreen = false;
  /** Oturulan casino taburesinin oyunu ve oturma anı: kamera masaya yaklaşınca oyun ekranı açılır. */
  private casinoSeat: { game: NonNullable<Seat["game"]>; at: number } | null = null;
  /** Casinonun içindeyken bakiye etiketi. */
  private casinoChip: HTMLDivElement;
  private inCasino = false;
  /** NPC yayalar, güvercinler, sokak kedileri. */
  private cityLife: CityLife;
  /** Kendi arabanın hasarı (0–3.99; seviye tam kısmı): çarptıkça artar, garajda onarılır. */
  private damage = 0;
  private engines = new EngineSounds();
  private engineSources: EngineSource[] = [];
  private prevCars = new Map<number, { x: number; z: number }>();
  /** Kornalar (sid başına) ve senin korna/selektör tuşun; başkalarının yanan selektörü (sid → yandığı an). */
  private horns = new Horns();
  private hornDown = false;
  private flashDown = false;
  private remoteFlash = new Map<number, number>();
  private remoteHorn = new Map<number, number>();
  /** Gazın bir önceki karesi (bırakınca turbo ve egzoz patlaması) ve son patlama. */
  private lastGas = 0;
  private popAt = 0;
  private fxTime = 0;
  private smoke = new CarSmoke();
  private smokeAt = 0;
  private lastCarV = 0;
  private hadCar = false;
  /** Sürerken sol altta hız göstergesi (yarışta yarışın kendi göstergesi var). */
  private speedo: HTMLCanvasElement;
  private shownKmh = -1;

  constructor(private c: FeatureContext) {
    const { world, net, hud, hudRoot, me } = c;
    world.scene.add(this.companions.group, this.fireworks.points);
    this.cityLife = new CityLife(c.lowPower, world.seats);
    // NPC trafiğe çarpma herkese: çarpan gönderir, diğerleri aynı savrulmayı uygular
    this.cityLife.traffic.onBump = (id, s) => net.send({ t: "tbump", id, s });
    net.onTbump = (id, s) => this.cityLife.traffic.applyBump(id, s);
    world.scene.add(this.smoke.mesh);
    this.speedo = document.createElement("canvas");
    this.speedo.className = "drive-speedo";
    this.speedo.width = this.speedo.height = 150 * Math.min(2, devicePixelRatio || 1);
    hudRoot.append(this.speedo);
    // Arabayla sert çarpma: ses, 💥, hasar (seviye değişince herkese)
    me.onCrash = (speed, lx = 0, lz = 2) => {
      const k = Math.min(1, speed / 14);
      sfx.crash(0.4 + 0.6 * k);
      // Kıvılcım/💥 çarpılan yerde (yerel → dünya)
      const cs = Math.cos(me.rot), sn = Math.sin(me.rot);
      c.emoteFx.emit(me.x + lx * cs + lz * sn, 0.6, me.z - lx * sn + lz * cs, FX_CELL.splat, performance.now() / 1000, undefined, 1);
      const before = this.carDamage;
      this.damage = Math.min(3.99, this.damage + Math.max(0, speed - 3) / 18);
      // Göçük: çarpılan taraf (ön/arka uçlar, yanlar); farlar sert önden çarpmada kırılır
      const zone = Math.abs(lz) > 1.0 ? (lz > 0 ? "f" : "r") : lx > 0 ? "l" : "rt";
      this.zones[zone] = Math.min(3.99, this.zones[zone] + Math.max(0, speed - 4) / 11);
      let hl = this.dents.hl;
      if (zone === "f" && speed > 10) hl |= Math.abs(lx) < 0.35 ? (speed > 18 ? 3 : lx >= 0 ? 1 : 2) : lx > 0 ? 1 : 2;
      const next = { f: Math.floor(this.zones.f), r: Math.floor(this.zones.r), l: Math.floor(this.zones.l), rt: Math.floor(this.zones.rt), hl };
      const changed = JSON.stringify(next) !== JSON.stringify(this.dents);
      this.dents = next;
      if (this.carDamage !== before || changed) {
        net.send({ t: "cardmg", d: this.carDamage, z: this.dents });
        if (this.carDamage === 3 && before !== 3) hud.toast("💨 Araban ağır hasarlı! GAP Garaj'da onarılır.");
      }
    };
    c.life.onStop(() => {
      this.engines.silence();
      this.horns.silence();
    });
    // Başkasının kornası ve selektörü
    net.onCarFx = (sid, k, on) => {
      const r = c.remotes.map.get(sid);
      if (k === "flash") {
        if (on) this.remoteFlash.set(sid, performance.now());
        else this.remoteFlash.delete(sid);
        return;
      }
      if (!on) return this.horns.release(sid);
      if (!r?.info.car) return;
      this.remoteHorn.set(sid, performance.now());
      this.horns.start(sid, r.info.car.horn, this.hornLevel(sid)?.level ?? 0);
    };
    world.scene.add(this.cityLife.group);
    // Binaların arkasındaki ve kameranın görmediği yayalar o kare çizilmez
    world.occlusion.dynamic.push(() => this.cityLife.cull((x, y, z, r) => world.occlusion.sphereVisible(x, y, z, r)));
    net.onPedhit = (id, vx, vz, by) => {
      const line = this.cityLife.hit(id, vx, vz, performance.now() / 1000);
      if (!line) return;
      c.bubble(PED_SID_BASE + id, line);
      if (by === net.you) sfx.bump(0.6);
    };
    this.weatherFx = new WeatherFx(c.lowPower);
    world.scene.add(this.weatherFx.group);
    // Mahalle: bloklar sahnede, çarpışmaya da katılır
    world.scene.add(this.buildWorld.group);
    this.build = new BuildMode(hudRoot, this.buildWorld, world.scene, c.canvas, c.camera, {
      userId: () => c.session.user.id,
      position: () => ({ x: c.me.x, z: c.me.z }),
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
    // Tuşlar değişince stadyum ipucu yenilenir; dünyadan çıkınca (savaş modu) dünya tuşları
    c.life.onStop(onBinds(() => this.renderFbHelp()));
    c.life.onStop(() => setProfile("world"));
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
    this.mosque = new MosqueClient({
      net,
      me,
      remotes: c.remotes,
      input: c.input,
      hudRoot,
      minarets: world.minarets,
      toast: (t) => hud.toast(t),
    });
    c.life.onStop(() => this.mosque.dispose());
    this.paintball = new PaintballClient({
      scene: world.scene,
      camera: c.camera,
      net,
      me,
      remotes: c.remotes,
      input: c.input,
      hudRoot,
      field: world.paintball,
      nameOf: (sid) => this.nameOf(sid),
      toast: (t) => hud.toast(t),
      // Debug (?debug&pbtest): sahada duran maket rakip
      dummy: () => ({
        x: PB_FIELD.x + 2.5, z: PB_FIELD.z + 8, rot: Math.PI, flags: 0, alpha: 1, cell: c.atlas.alloc("Rakip"),
        color: colorFor("rakip"), phase: 0.3, emote: -1, emoteAt: 0, jumpY: 0,
        outfit: { hair: "hair_kisa_doku", tops: "top_tisort", bottoms: "bottom_kot", shoes: "shoes_sneaker", facial: null, hats: null, glasses: null, colors: { hair: "#3a2a1e", skin: "#d9a77e" } },
      }),
    });
    c.life.onStop(() => this.paintball.dispose());
    this.volley = new VolleyClient({
      scene: world.scene,
      court: world.volley,
      net,
      input: c.input,
      me,
      remotes: c.remotes,
      camera: c.camera,
      hudRoot,
      nameOf: (sid) => this.nameOf(sid),
      toast: (t) => hud.toast(t),
    });
    c.life.onStop(() => this.volley.dispose());

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
    this.map = new WorldMap(hudRoot, c.input.touch, {
      me: () => ({ x: c.me.x, z: c.me.z, rot: c.me.rot }),
      others: function* () {
        for (const r of c.remotes.map.values()) if (r.hasData) yield { x: r.x, z: r.z, name: r.info.name };
      },
      owner: (plot) => {
        const p = this.buildWorld.plots[plot];
        return p?.owner ? p.name : null;
      },
      // İş hedefi ve taksi çağrıları
      marks: () => [
        ...(this.job?.target ? [{ x: this.job.target.x, z: this.job.target.z, label: this.job.target.name, color: "#ef9f27" }] : []),
        ...this.calls.map((k) => ({ x: k.x, z: k.z, label: `🚕 ${k.name}`, color: "#fac775" })),
      ],
    });
    this.lifeHud = new LifeHud(hudRoot, {
      openWallet: () => net.send({ t: "econ", op: "wallet" }),
      ambulance: () => net.send({ t: "ambulance" }),
      base: () => this.map.minimapBase(),
    });
    net.onMoney = (balance, tx) => {
      this.lifeHud.setMoney(balance, tx);
      this.phone.setBalance(balance);
      this.shopUi.setBalance(balance);
    };
    this.shopUi = new ShopUi(hudRoot, {
      buy: (shop, cart) => net.send({ t: "shop", shop, cart }),
      closed: () => {},
    });
    this.inv = new InventoryUi(hudRoot, {
      op: (op, slot) => net.send({ t: "inv", op, slot }),
      move: (from, to) => net.send({ t: "inv", op: "move", from, to }),
      give: (slot, sid) => net.send({ t: "inv", op: "give", slot, sid }),
      nearest: () => {
        let best: { sid: number; name: string } | null = null, bd = 3;
        for (const r of c.remotes.map.values()) {
          const d = Math.hypot(r.x - me.x, r.z - me.z);
          if (r.hasData && !r.leaving && !r.info.spectator && d < bd) (best = { sid: r.info.sid, name: r.info.name }), (bd = d);
        }
        return best;
      },
      pack: () => c.chibi?.pack ?? null,
      look: () => me.outfit ?? null,
    }, c.session.user.name);
    this.hotbar = new Hotbar(hudRoot, (i) => this.selectSlot(i));
    this.wheel = new EmoteWheel(hudRoot);
    world.scene.add(this.held.group);
    net.onInv = (slots) => {
      hudRoot.classList.add("has-inv");
      this.inv.setSlots(slots);
      this.hotbar.setSlots(slots);
      this.shopUi.bought();
      me.held = this.hotbar.held()?.id ?? null;
    };
    net.onEat = (sid, item) => {
      const t = performance.now() / 1000;
      if (sid === net.you) me.eatAt = t;
      else {
        const r = c.remotes.map.get(sid);
        if (r) r.eatAt = t;
      }
      if (sid === net.you) sfx.pop();
      const d = itemDef(item);
      if (sid === net.you && d) hud.toast(`${d.icon} ${d.name} ${d.cat === "drink" ? "içtin" : "yedin"}.`);
    };
    net.onCarDamage = (sid, d) => {
      if (sid !== net.you || d !== 0 || this.carDamage === 0) return;
      this.damage = 0;
      this.clearDents(false);
      hud.toast("🔧 Araban onarıldı.");
    };
    // Arabanın çarptığı oyuncu: savrulur, sırtüstü düşer, ~2 sn yatar, kalkar (herkes görür)
    net.onRunover = (sid, vx, vz) => {
      const ko = { at: performance.now() / 1000, rot: Math.atan2(-vx, -vz) };
      if (sid === net.you) {
        me.knock(vx, vz);
        me.ko = ko;
        sfx.bump(1);
      } else {
        const r = c.remotes.map.get(sid);
        if (r) r.ko = ko;
      }
    };
    net.onEcon = (w) => {
      if (this.walletToPhone) this.phone.showWallet(w);
      else this.lifeHud.showWallet(w);
      this.walletToPhone = false;
    };
    net.onReviving = (by, target, until) => {
      this.revivingTarget = until && by === net.you ? target : 0;
      const text = by === net.you ? `🩹 ${this.nameOf(target)} kaldırılıyor… yanında kal` : `🩹 ${this.nameOf(by)} seni kaldırıyor…`;
      this.lifeHud.setReviving(text, until);
    };
    net.onLife = (ev) => {
      hudRoot.classList.add("has-life");
      this.lifeHud.setLife(ev, ev.downed);
      this.buffs = ev.buffs ?? {};
      this.lifeHud.setBuffs(this.buffs);
      this.inv.setBuffs(this.buffs, net.serverNow());
      const was = me.downed;
      me.downed = ev.downed > 0;
      // Enerji bitince koşamazsın
      me.noRun = ev.energy <= 0;
      if (me.downed && !was) {
        if (me.seated) me.standUpNow();
        hud.toast("🩸 Bayıldın! Arkadaşın kaldırabilir ya da ambulans çağır.");
      }
      if (ev.tp) me.teleport(ev.tp.x, ev.tp.z, ev.tp.rot);
    };
    // Yüksekten düşme canı sunucuda (bildirdiğin yükseklikten)
    me.onFall = (h) => {
      if (h > LIFE.fallFrom && !me.vehicle) net.send({ t: "fall", h });
    };
    this.phone = new Phone(hudRoot, c.input.touch, {
      quests: () => this.profile.openQuests(),
      card: () => this.profile.open(net.you, c.session.user.name),
      album: () => this.profile.openAlbum(c.session.user.name),
      photo: () => this.photo.toggle(),
      fireworks: () => net.send({ t: "fireworks" }),
      tag: (mode) => c.say(`!${mode}`),
      match: () => c.say(!this.match ? "!maç 5" : this.myTeam() === null ? "!maç katıl" : "!maç bitir"),
      wallet: () => {
        this.walletToPhone = true;
        net.send({ t: "econ", op: "wallet" });
      },
      job: (kind) => net.send(kind ? { t: "job", op: "start", kind } : { t: "job", op: "stop" }),
      jobCar: () => this.job && this.vehicles.callJob(jobCar(this.job.kind)),
      gallery: () => this.vehicles.menu.open(true),
      players: () => [...c.remotes.map.values()].filter((r) => r.hasData && !r.leaving && !r.info.spectator).map((r) => ({ sid: r.info.sid, name: r.info.name })),
      pay: (sid, amount) => net.send({ t: "pay", sid, amount }),
      taxi: (on) => net.send({ t: "taxi", on }),
      queue: () => this.whud.openQueue(),
      weather: () => c.say("!hava"),
      battle: c.battle,
      volley: () => this.volley.menu(),
      cosmetics: () => this.sendCosmetics(),
      car: () => this.vehicles.menu.toggle(),
      radio: () => this.toggleRadio(),
    });
    this.radioPanel = new RadioPanel(hudRoot, {
      add: (url) => net.send({ t: "radio", url }),
      op: (op, i) => net.send({ t: "radioq", op, i }),
      mix: (sid, vol, muted) => {
        this.radioMix.set(sid, { vol, muted });
        this.radioRowsAt = 0;
      },
    });
    // Kendi şarkın bitti: sıradaki çalsın
    this.radio.onEnded = (id) => net.send({ t: "radioq", op: "ended", id });
    net.onRadioQueue = (q) => this.radioPanel.setQueue(q);
    net.onRide = (sid, ride) => {
      this.onRide(sid, ride);
      if (sid === net.you && ride) this.phone.setCalling(false);
    };
    this.jobHud = new JobHud(hudRoot);
    world.scene.add(this.jobMarker.group);
    net.onJob = (v) => {
      const prev = this.job;
      this.job = v;
      this.jobHud.set(v, net.serverNow());
      hudRoot.classList.toggle("has-job", !!v);
      this.phone.setJob(v);
      if (v && prev?.kind !== v.kind) {
        this.vehicles.callJob(jobCar(v.kind));
        hud.toast(v.kind === "kurye" ? "📦 Kuryeliğe başladın! Turuncu işarete git, paketi al." : "🚕 Taksiciliğe başladın! Turuncu işaretteki müşteriyi al.");
      }
      if (!v && prev) {
        this.vehicles.endJob();
        this.calls = [];
        hud.toast("🛑 İşi bıraktın.");
      }
      // Bekleyen NPC müşteri (taksi)
      const n = v?.npc;
      if (!n) this.jobNpc = null;
      else if (!this.jobNpc || this.jobNpc.x !== n.x || this.jobNpc.z !== n.z) {
        let cell = this.npcCells.get(n.name);
        if (cell === undefined) this.npcCells.set(n.name, (cell = c.atlas.alloc(n.name)));
        const look = world.npcs.length ? world.npcs[Math.floor(Math.random() * world.npcs.length)].outfit : null;
        this.jobNpc = {
          x: n.x + 2.5, z: n.z, rot: -Math.PI / 2, flags: 0, alpha: 1, cell, color: colorFor(`job-${n.name}`), phase: 0.7, emote: -1, emoteAt: 0, jumpY: 0,
          baseY: world.colliders.groundAt(n.x + 2.5, n.z, 0.4), outfit: look,
        };
      }
    };
    net.onTaxiCalls = (calls) => {
      const had = this.calls.length;
      this.calls = calls;
      if (calls.length > had) hud.toast(`🚕 Yeni taksi çağrısı: ${calls[calls.length - 1].name} (haritada sarı)`);
    };
    this.radioChip = document.createElement("div");
    this.radioChip.className = "radio-chip";
    hudRoot.append(this.radioChip);
    c.life.onStop(() => this.radio.dispose());
    this.casino = new CasinoUi(hudRoot, net, {
      onClose: () => me.standUpNow(),
      toast: (t) => hud.toast(t),
    });
    this.raceHud = new RingHud(hudRoot, () => net.send({ t: "ring", op: "leave" }));
    net.onRing = (r) => this.onRace(r);
    this.casinoChip = document.createElement("div");
    this.casinoChip.className = "radio-chip cz-hudchip";
    hudRoot.append(this.casinoChip);
    net.onCasino = (ev) => {
      this.casino.event(ev);
      if (this.inCasino) this.casinoChip.textContent = `💰 ${fmt(this.casino.balance)} ₺ · Oynamak için bir tabureye otur`;
    };
    // Reddedilen hamle bildirim olarak gelir: oyun ekranı beklemeyi bıraksın
    const notice = net.onNotice;
    net.onNotice = (text) => {
      notice(text);
      this.casino.failed();
    };
    this.vehicles = new Vehicles({
      world, net, me, remotes: c.remotes, hud, hudRoot, camera: c.camera,
      block: (on) => c.input.setBlocked(on),
      racing: () => this.racing,
      sparkle: (x, z) => c.emoteFx.emit(x, 0, z, FX_CELL.sparkle, performance.now() / 1000, undefined, 4),
    });
    // Mahalle blokları ve park halindeki arabalar birlikte çarpışır
    world.colliders.extra = {
      resolve: (p, r, y) => {
        this.buildWorld.resolve(p, r, y);
        this.vehicles.colliders.resolve(p, r, y);
        // Arabanın gövdesi NPC arabalarla duvar gibi değil, araç olarak çarpışır (carBodies: savrulurlar)
        if (y !== CAR_PROBE_Y) this.cityLife.traffic.colliders.resolve(p, r, y);
      },
      groundAt: (x, z, r, y) => this.buildWorld.groundAt(x, z, r, y),
    };
    // Arabanın çarpabildiği araçlar: diğer oyuncuların arabaları (kendi istemcileri savrulmayı hesaplar) ve NPC trafik
    world.carBodies = () => this.carBodies();
    // Dükkân çalışanları: tezgâhlarının arkasında duran sabit karakterler
    this.workers = world.npcs.map((n, i) => ({
      x: n.x, z: n.z, rot: n.rot, flags: 0, alpha: 1, cell: c.atlas.alloc(n.name),
      color: colorFor(`npc-${i}`), phase: 0.3 + i * 0.37, emote: -1, emoteAt: 0, jumpY: 0, outfit: n.outfit,
    }));

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
    // Stadyumda tuş ipucu: geçerli atamalarla (ayarlardan değişince yenilenir)
    this.fbHelp = document.createElement("div");
    this.fbHelp.className = "fb-help";
    hudRoot.append(this.fbHelp);
    // Stadyum: tank oyunundaki gibi sol üstte dünyaya dön ve takım düğmeleri; B ile takım menüsü
    this.fbExit = el("button", "battle-exit fb-exit", hudRoot, "🏠 Dünyaya dön");
    this.fbExit.addEventListener("click", () => this.goHome());
    this.fbTeamBtn = el("button", "battle-switch", hudRoot, "⚽ Takım");
    this.fbTeamBtn.addEventListener("click", () => this.toggleTeams());
    this.teamPanel = new Panel(hudRoot, "⚽ TAKIM SEÇ", "fb-team-panel");

    net.onBall = (b) => {
      this.pitchOf(b.f).setBall(b, net.serverNow());
      // Kayma ve çalım başkasındaysa: avatarı yere yatar / döner, top yanından yarım daire çizer
      if ((b.ev === "slide" || b.ev === "skill") && b.by !== net.you) {
        const r = c.remotes.map.get(b.by ?? 0);
        const t = performance.now() / 1000;
        if (b.ev === "skill") {
          this.pitchOf(b.f).trick(b.by ?? 0, b.side ?? 1, net.serverNow());
          if (r) r.trick = { at: t, side: b.side ?? 1 };
        } else if (r) r.slide = t;
      }
      // Vuruş/direk sesleri (kendi vuruşumuzun sesi basınca çaldı)
      if (!b.ev || b.by === net.you) return;
      const gain = falloff(Math.hypot(b.x - me.x, b.z - me.z));
      if (b.ev === "post" || b.ev === "bar") sfx.post(Math.max(0.15, gain));
      else if (b.ev === "save") {
        sfx.header(Math.max(0.3, gain));
        sfx.cheer(0.35 * gain);
      } else if (b.ev === "tackle" || b.ev === "slide") sfx.kick(0.35 * gain);
      else if (b.ev === "skill" || b.ev === "rainbow") sfx.kick(0.25 * gain);
      else if (b.ev === "head") sfx.header(gain);
      else sfx.kick((b.ev === "pass" ? 0.45 : b.ev === "power" ? 1 : 0.8) * gain);
    };
    net.onGk = (k, f) => this.pitchOf(f).setKeepers(k);
    net.onPlots = (p) => this.buildWorld.setAll(p);
    net.onPlot = (p) => {
      const was = this.buildWorld.plots[p.id]?.owner;
      this.buildWorld.setPlot(p);
      if (p.owner === c.session.user.id && was !== p.owner) hud.toast("🏠 Arsa senin! Mahallede tabelada adın yazıyor. N ile inşa et.");
    };
    net.onBset = (plot, i, j, k, b, r) => this.buildWorld.set(plot, i, j, k, b, r);
    net.onFb = (text) => {
      if (Math.hypot(me.x - PITCH.x, me.z - PITCH.z) > 40 && !inStadium(me.x, me.z)) return;
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
      if (this.teamPanel.isOpen) this.renderTeams();
    };
    net.onScore = (s, f) => {
      this.scores[f ?? 0] = s;
    };
    net.onGoal = (side, sid, name, s, assist, own, f) => {
      this.scores[f ?? 0] = s;
      const F = FIELDS[f ?? 0], p = this.pitchOf(f);
      // Uzaktaki sahanın golü: yalnızca skor (stadyumdakiler salonun golünü duymaz, tersi de)
      if (Math.hypot(F.x - me.x, F.z - me.z) > F.hx * 2.5) return;
      sfx.whistle();
      sfx.cheer(Math.max(f ? 0.8 : 0.3, falloff(Math.hypot(F.x - me.x, F.z - me.z))));
      const bp = p.ball;
      const t = performance.now() / 1000;
      p.netHit(bp.x, bp.y, bp.z, t);
      if (f) world.stadium.cheer(t);
      const gx = F.x + (side ? 1 : -1) * F.hx;
      c.emoteFx.emit(gx, 1, F.z, FX_CELL.party, t, 0.5, 6);
      this.confetti.burst(gx - (side ? 1 : -1) * 1.5, 1.5, F.z, t);
      c.emoteFx.emit(gx, 1.5, F.z, FX_CELL.ball, t + 0.2, 0.5, 3);
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
    net.onNamaz = (s) => this.mosque.onSessions(s);
    net.onPb = (s) => this.paintball.onState(s);
    net.onPbShot = (sid, o, d, at) => this.paintball.onShot(sid, o, d, at);
    net.onPbHit = (by, victim, x, y, z) => this.paintball.onHit(by, victim, x, y, z);
    net.onPbPoses = (p) => this.paintball.onPoses(p);
    net.onPbWins = (w) => this.paintball.onWins(w);
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
    net.onRadio = (sid, radio) => {
      if (sid === net.you) this.myRadio = radio;
    };
    const prevWelcome = net.onStatus;
    net.onStatus = (s) => {
      prevWelcome(s);
      if (s === "online") this.sendCosmetics();
      else this.vehicles.reset();
    };

    // 3B'de bir avatara tıklayınca oyuncu kartı (sürükleme değilse)
    c.canvas.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY, at: performance.now() }));
    c.canvas.addEventListener("pointerup", (e) => {
      if (this.build.active || this.volley.active || c.input.locked || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6 || performance.now() - this.down.at > 400) return;
      // Dükkân çalışanına tıklamak (yakındaysa) onunla konuşmak gibi: berber/moda gardırobu açılır
      const npc = this.pickWorker(e.clientX, e.clientY);
      if (npc >= 0) {
        this.handleAct(`npc:${npc}`, performance.now());
        return;
      }
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
    if (me.car && !this.vehicles.exit()) return;
    if (me.car) return;
    if (me.vehicle === 3 && v !== 3) me.setVehicle(v, DOCK);
    else me.setVehicle(v);
    if (v) this.c.hud.toast(v === 1 ? "🚲 Bisiklete bindin (B: değiştir)" : v === 2 ? "🛹 Kaykaydasın (B: değiştir)" : "🛶 Kayıktasın: iskelede F ile in");
  }

  /** Radyo paneli: sıra ve çalan radyolar her yerden görülür; kontrol arabadayken. */
  private toggleRadio(): void {
    this.radioPanel.toggle();
    this.radioRowsAt = 0;
  }

  /** Biri yolcu olarak bindi/indi. Sen indiysen (ya da sürücü indiyse) arabanın sağ kapısından çıkarsın. */
  private onRide(sid: number, ride: { d: number; s: number } | null): void {
    const { me, net, hud } = this.c;
    if (sid === net.you) {
      const was = this.myRide;
      this.myRide = ride;
      if (ride) hud.toast(`🚗 ${this.nameOf(ride.d)}'in arabasına bindin · F: in`);
      else if (was && me.riding && !me.car) {
        const { x, z, rot } = me.riding;
        me.riding = null;
        me.teleport(x - Math.cos(rot) * 1.8, z + Math.sin(rot) * 1.8, rot);
      }
      return;
    }
    if (ride?.d === net.you) hud.toast(`👥 ${this.nameOf(sid)} arabana bindi`);
  }

  /** Yolcuysan konumun her kare sürücünün arabası; arabadan inince farlar kendiliğine döner. */
  private updateRide(): void {
    const { me, remotes } = this.c;
    if (!me.car) this.myLights = null;
    this.radioPanel.setInCar(!!me.car);
    if (!this.myRide) {
      me.riding = null;
      return;
    }
    const d = remotes.map.get(this.myRide.d);
    if (d?.hasData && d.info.car) me.riding = { x: d.x, z: d.z, rot: d.rot };
  }

  /** Yanındaki (sürücüsü olan) başka arabaya yolcu olarak binme. */
  private rideAct(): FeatureAct | null {
    const { me, remotes } = this.c;
    if (me.car || me.seated || me.vehicle || this.myRide) return null;
    for (const r of remotes.map.values()) {
      if (!r.hasData || !r.info.car) continue;
      const [fx, fz, bx, bz] = carCircles(r.x, r.z, r.rot);
      const ex = bx - fx, ez = bz - fz, l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((me.x - fx) * ex + (me.z - fz) * ez) / l2));
      if (Math.hypot(me.x - fx - ex * t, me.z - fz - ez * t) <= ENTER_REACH) {
        return { key: "f", label: `${this.nameOf(r.info.sid)}'in arabasına yolcu olarak bin 🚗`, act: `ride:${r.info.sid}` };
      }
    }
    return null;
  }

  /** Radyolar: kendi radyon (arabadan inince de çalar), bindiğin arabanınki ve yakındakiler; etiket ve panel. */
  private updateRadios(serverNow: number): void {
    const { me, remotes, net } = this.c;
    const sources: RadioSource[] = [];
    if (this.myRadio) sources.push({ sid: net.you, radio: this.myRadio, x: me.x, z: me.z, own: true });
    for (const r of remotes.map.values()) {
      if (r.hasData && r.info.radio) sources.push({ sid: r.info.sid, radio: r.info.radio, x: r.x, z: r.z, own: this.myRide?.d === r.info.sid });
    }
    const mix = (sid: number) => {
      const m = this.radioMix.get(sid);
      return m ? (m.muted ? 0 : m.vol) : 1;
    };
    const top = this.radio.update(sources, me.x, me.z, serverNow, settings.radioVolume, mix, net.you);
    // Panel: radyo açan bütün üyeler (saniyede bir)
    const now = performance.now();
    if (this.radioPanel.isOpen && now - this.radioRowsAt > 1000) {
      this.radioRowsAt = now;
      this.radioPanel.setRadios(sources.map((s) => {
        const m = this.radioMix.get(s.sid);
        return {
          sid: s.sid, name: s.sid === net.you ? this.nameOf(s.sid) : this.nameOf(s.sid), title: s.radio.title, own: s.sid === net.you,
          heard: s.own || Math.hypot(s.x - me.x, s.z - me.z) < RADIO_RANGE, vol: m?.vol ?? 1, muted: m?.muted ?? false,
        };
      }));
    }
    if (top) {
      const who = top.sid === net.you ? "Radyon" : `${this.nameOf(top.sid)}'in Tofaşı`;
      this.radioChip.textContent = `🎵 ${top.title} · ${who}`;
      this.radioChip.style.opacity = String(Math.min(1, 0.35 + top.gain));
      this.radioChip.classList.add("show");
    } else this.radioChip.classList.remove("show");
  }

  /** Arabadayken: grid kutusuna geç, (grid sahibi) başlat ve tur seç, gridden çık; yarışta F ile inilmez (T ile iner, DNF). */
  private raceActs(): FeatureAct[] {
    const { me, net } = this.c;
    const off: FeatureAct = { key: "f", label: "Arabadan in 🚗", act: "car-off" };
    const r = this.ring, mine = r?.racers.find((x) => x.sid === net.you);
    const phase = r?.phase ?? "idle";
    if (mine && phase === "lobby") {
      if (r!.host === net.you) {
        return [
          { key: "f", label: `Yarışı başlat · ${this.raceLaps} tur 🏁`, act: "ring-start" },
          { key: "g", label: `Tur: ${this.raceLaps} → ${RACE_LAPS[(RACE_LAPS.indexOf(this.raceLaps as (typeof RACE_LAPS)[number]) + 1) % RACE_LAPS.length]}`, act: "ring-laps" },
        ];
      }
      return [{ key: "g", label: "Gridden çık", act: "ring-leave" }];
    }
    if (mine && (phase === "lights" || phase === "racing") && mine.total === null && !mine.dnf) return [];
    if (phase === "idle" || phase === "lobby") {
      const taken = new Set(r?.racers.map((x) => x.slot) ?? []);
      let best = -1, bestD = GRID_REACH;
      GRID.forEach((g, i) => {
        const d = Math.hypot(g.x - me.x, g.z - me.z);
        if (!taken.has(i) && d < bestD) [best, bestD] = [i, d];
      });
      if (best >= 0) return [off, { key: "g", label: `Grid ${best + 1}'e geç 🏁`, act: `ring-join:${best}` }];
    }
    return [off, this.lightsAct()];
  }

  /** G: farları aç/kapat (gece kendiliğinden yanar; elle seçilen kalıcı, arabadan inince sıfırlanır). */
  private lightsAct(): FeatureAct {
    return { key: "g", label: this.lightsOn() ? "Farları kapat 💡" : "Farları aç 💡", act: "lights" };
  }

  private lightsOn(): boolean {
    return this.myLights ?? this.c.world.env.lights > 0.3;
  }

  private onRace(r: RingView): void {
    const { net, hud } = this.c;
    const prev = this.ring?.racers.find((x) => x.sid === net.you);
    const mine = r.racers.find((x) => x.sid === net.you);
    const wasPhase = this.ring?.phase;
    this.ring = r;
    if (!mine) {
      if (prev && wasPhase === "lobby" && r.phase === "lobby") hud.toast("🏁 Gridden çıktın.");
      return;
    }
    if (!prev && r.phase === "lobby") hud.toast(r.host === net.you ? "🏁 Gride geçtin! F: başlat · G: tur sayısı" : "🏁 Gride geçtin, grid sahibinin başlatmasını bekle.");
    if (r.phase === "lights" && wasPhase === "lobby") hud.toast("🔴 Lambalara dikkat! Hepsi sönüp yeşil yanınca gaz!");
    if (prev && mine.penalty > prev.penalty) this.raceHud.flash(`ERKEN KALKIŞ! +${(mine.penalty - prev.penalty) / 1000} sn`, 2600, "bad");
    if (prev && r.phase === "racing" && mine.lap > prev.lap && mine.total === null) {
      sfx.lap();
      this.raceHud.flash(mine.lap === r.laps ? "SON TUR!" : `TUR ${mine.lap}/${r.laps}`, 1600);
    }
    if (prev && prev.total === null && mine.total !== null) {
      sfx.win(mine.pos === 1);
      this.raceHud.flash(mine.pos === 1 ? "🏆 KAZANDIN!" : `🏁 BİTİRDİN · P${mine.pos}`, 3200, "good");
    }
  }

  /** Lambalar (herkes görür), lamba sesleri (pistin yakınında), yarış arayüzü. */
  private updateRace(serverNow: number): void {
    const { me, net, remotes, world } = this.c;
    const r = this.ring;
    const l = r ? lightsAt(r, serverNow) : { red: 0, green: false };
    world.ring.setLights(l.red, l.green);
    // Gridde yeşile kadar araba kilitli; yarış sürerken pit kapısı kapalı (bitiren ve terk eden çıkabilir)
    const mine = r?.racers.find((x) => x.sid === net.you);
    const waiting = !!mine && (r!.phase === "lobby" || r!.phase === "lights");
    me.carLock = waiting || this.vehicles.tuning.isOpen;
    const active = r?.phase === "lights" || r?.phase === "racing";
    world.ring.setGate(!!active && (!mine || (mine.total === null && !mine.dnf)));
    const near = Math.hypot(me.x - 470, me.z + 200) < 140;
    if (near && l.red > this.raceRed) sfx.raceBeep();
    if (near && l.green && !this.raceGreen) sfx.raceBeep(true);
    this.raceRed = l.red;
    this.raceGreen = l.green;
    let wrongWay = false;
    const speed = me.car?.v ?? 0;
    if (me.car && r?.phase === "racing" && Math.abs(speed) > 2) {
      const p = trackAt(trackProject(me.x, me.z).s);
      wrongWay = (Math.sin(me.rot) * p.dx + Math.cos(me.rot) * p.dz) * Math.sign(speed) < -0.35;
    }
    this.raceHud.update({
      race: r,
      me: net.you,
      now: serverNow,
      speed,
      wrongWay,
      pos: (sid) => {
        if (sid === net.you) return me;
        const q = remotes.map.get(sid);
        return q?.hasData ? q : null;
      },
    });
  }

  /** Casino: tabureye oturunca kamera masaya (slotta ekrana) yaklaşır, sonra oyun ekranı açılır; kalkınca kapanır. */
  private updateCasino(now: number): void {
    const { me, net } = this.c;
    const game = me.seatGame;
    if (game && this.casinoSeat?.game !== game) {
      // Başka bir masaya geçildi: önceki oyunun ekranı kapanır, yaklaşma yeniden başlar
      this.casino.close();
      this.casinoSeat = { game, at: now };
      // Oturanın arkasından ve biraz yukarıdan masaya bakış
      const dx = game.x - me.x, dz = game.z - me.z, d = Math.hypot(dx, dz) || 1;
      const back = game.kind === "slot" ? 0.3 : 0.55, y = game.y + (game.kind === "slot" ? 0.18 : 1.2);
      me.focusView = { pos: new THREE.Vector3(me.x - (dx / d) * back, y, me.z - (dz / d) * back), look: new THREE.Vector3(game.x, game.y, game.z) };
    } else if (!game && this.casinoSeat) {
      this.casinoSeat = null;
      this.casino.close();
      me.focusView = null;
    }
    if (this.casinoSeat && !this.casino.isOpen && now - this.casinoSeat.at > 950) {
      const g = this.casinoSeat.game;
      this.casino.open(g.kind, g.table === undefined ? null : { table: g.table, seat: g.seat ?? 0 });
    }
    // Bağlantı (yeniden) kurulunca da bakiye istensin
    const inside = net.you > 0 && Math.abs(me.x - CASINO.x) < CASINO.hw && Math.abs(me.z - CASINO.z) < CASINO.hd && !me.car;
    if (inside && !this.inCasino) net.send({ t: "casino", op: "wallet" });
    this.inCasino = inside;
    this.casinoChip.classList.toggle("show", inside && !this.casinoSeat);
  }

  /** Tofaşa bin ya da in (arabanın görünümü garajdan; herkese sunucu üzerinden gider). */
  /** Yarışta (lambalar ya da yarış sürerken, bitirmeden): arabadan inilmez, pistten çıkılmaz. */
  private get racing(): boolean {
    const r = this.ring, mine = r?.racers.find((x) => x.sid === this.c.net.you);
    return !!mine && (r!.phase === "lights" || r!.phase === "racing") && mine.total === null && !mine.dnf;
  }

  /** Arabadaysan in (araba park halinde kalır); değilsen Araçlarım menüsü. */
  private toggleCar(): void {
    if (this.c.me.car) this.vehicles.exit();
    else this.vehicles.menu.toggle();
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
  /** Ekranda tıklanan dükkân çalışanı (en çok 6 m uzakta ve ekranda ~40 px yakın), yoksa -1. */
  private pickWorker(cx: number, cy: number): number {
    const { camera, me, world } = this.c;
    let best = -1, bestD = 40;
    for (const [i, n] of world.npcs.entries()) {
      if (Math.hypot(n.x - me.x, n.z - me.z) > 6) continue;
      for (const y of [0.7, 1.2]) {
        this.proj.set(n.x, y, n.z).project(camera);
        if (this.proj.z > 1) continue;
        const d = Math.hypot(((this.proj.x + 1) / 2) * innerWidth - cx, ((1 - this.proj.y) / 2) * innerHeight - cy);
        if (d < bestD) [best, bestD] = [i, d];
      }
    }
    return best;
  }

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

  /** Hızlı slot seç (aynısına yeniden basınca el boşalır); sunucu herkese eldekini söyler. */
  private selectSlot(i: number): void {
    const next = this.hotbar.selected === i ? null : i;
    this.hotbar.select(next);
    this.c.me.held = this.hotbar.held()?.id ?? null;
    this.c.net.send({ t: "inv", op: "hold", slot: next });
  }

  /** İş: görev kartı (mesafe, süre), dünyadaki hedef işareti ve el sallayan müşteri. */
  private updateJob(serverNow: number): void {
    const { me, world } = this.c;
    this.jobHud.frame(me, serverNow);
    const t = this.job?.target;
    const time = performance.now() / 1000;
    this.jobMarker.set(t ? { x: t.x, z: t.z, y: world.colliders.groundAt(t.x, t.z, 0.4) } : null, time);
    const n = this.jobNpc;
    if (n && time - n.emoteAt > 2.5) {
      n.emote = 0;
      n.emoteAt = time;
      n.rot = Math.atan2(me.x - n.x, me.z - n.z);
    }
  }

  /** Avatarların elindeki eşyalar (yerken el ağza). */
  private updateHeld(): void {
    const { me, remotes } = this.c;
    const t = performance.now() / 1000;
    this.held.begin();
    if (me.held && !me.hidden && !me.car && !me.downed && !me.seated) this.held.place(me, me.held as ItemId, eatPose(me, t));
    for (const r of remotes.map.values()) {
      if (!r.info.held || !r.hasData || r.leaving || r.info.downed || r.info.car || r.info.ride || r.alpha < 0.5) continue;
      this.held.place(r, r.info.held, eatPose(r, t));
    }
  }

  private *carBodies(): Iterable<CarBody> {
    const { me, remotes } = this.c;
    const t = performance.now() / 1000;
    for (const r of remotes.map.values()) {
      if (!r.info.car || !r.hasData || r.leaving) continue;
      if (Math.abs(r.x - me.x) > 8 || Math.abs(r.z - me.z) > 8) continue;
      let p = this.carPrev.get(r.info.sid);
      if (!p) this.carPrev.set(r.info.sid, (p = { x: r.x, z: r.z, t, vx: 0, vz: 0 }));
      else if (t - p.t > 0.03) {
        const dt = t - p.t;
        p.vx += ((r.x - p.x) / dt - p.vx) * 0.5;
        p.vz += ((r.z - p.z) / dt - p.vz) * 0.5;
        [p.x, p.z, p.t] = [r.x, r.z, t];
      }
      const dims = CAR_DIMS[r.info.car.model] ?? CAR_DIMS.sahin;
      yield { x: r.x, z: r.z, rot: r.rot, vx: p.vx, vz: p.vz, mass: CAR_MASS[r.info.car.model] ?? 1, hl: dims.hl, hw: dims.hw };
    }
    yield* this.cityLife.traffic.bodies(me, 1.1);
  }

  /** Göçükleri sil (onarım); `send`: herkese de bildir. */
  private clearDents(send = true): void {
    const had = this.dents.f || this.dents.r || this.dents.l || this.dents.rt || this.dents.hl;
    this.zones = { f: 0, r: 0, l: 0, rt: 0 };
    this.dents = { ...NO_DENTS };
    if (had && send) this.c.net.send({ t: "cardmg", d: 0, z: this.dents });
  }

  /** Minimap işaretleri (oyuncular, bayılanlar, park ettiğin araba) ve yaralı sayacı. */
  private updateLife(serverNow: number): void {
    const { me, remotes } = this.c;
    const d = this.dots;
    d.length = 0;
    // Bayılanların üstünde ara ara 🩸
    const t = performance.now() / 1000;
    const blood = t - this.bloodAt > 1.4;
    if (blood) {
      this.bloodAt = t;
      if (me.downed) this.c.emoteFx.emit(me.x, me.baseY, me.z, FX_CELL.blood, t, 0.5, 1);
      for (const r of remotes.map.values()) if (r.info.downed && !r.leaving) this.c.emoteFx.emit(r.x, r.baseY ?? 0, r.z, FX_CELL.blood, t, 0.5, 1);
    }
    for (const r of remotes.map.values()) if (r.hasData && !r.leaving && !r.info.spectator) d.push({ x: r.x, z: r.z, kind: r.info.downed ? "downed" : "player" });
    const p = this.vehicles.myParked;
    if (p) d.push({ x: p.x, z: p.z, kind: "car" });
    for (const k of this.calls) d.push({ x: k.x, z: k.z, kind: "call" });
    const goal = this.job?.target;
    if (goal) d.push({ x: goal.x, z: goal.z, kind: "target" });
    this.lifeHud.frame(me, d, serverNow);
  }

  acts(): FeatureAct[] {
    const { me, world } = this.c;
    if (me.jailed || me.driving || this.race.driving() || this.paintball.busy()) return [];
    // Yolcuyken yalnızca inmek
    if (this.myRide) return [{ key: "f", label: `Arabadan in 🚗 (${this.nameOf(this.myRide.d)}'in arabası)`, act: "ride-off" }];
    // Camide (namazda, abdest alırken, harimde ya da şadırvanda) yalnızca cami eylemleri
    if (this.mosque.busy()) return this.mosque.acts();
    const camii = this.mosque.acts();
    if (camii.length) return camii;
    const pb = this.paintball.acts();
    if (pb.length) return pb;
    if (me.car) return this.raceActs();
    const near = (p: { x: number; z: number }, r: number) => Math.hypot(me.x - p.x, me.z - p.z) <= r;
    if (me.vehicle === 3) return near(DOCK, 4.5) || Math.hypot(me.x - POND_AREA.x, me.z - POND_AREA.z) > 4.6 ? [{ key: "f", label: "Kayıktan in 🛶", act: "boat-off" }] : [];
    if (me.onStage) return [{ key: "f", label: "Sahneden in 🎤", act: "stage-off" }];
    // Stadyumda futbolun kendi tuşları var (Q/F/G/E/C), F/G etkileşimi yok (dokunmatikte düğmeler kalır)
    if (this.inArena && !this.c.input.touch) return [];
    // Voleybol salonunda da (kendi tuşları)
    if (this.volley.active && !this.c.input.touch) return [];
    const enter = this.vehicles.enterAct();
    if (enter) return [enter];
    const ride = this.rideAct();
    if (ride) return [ride];
    // Bayılmış arkadaşını kaldır
    for (const r of this.c.remotes.map.values()) {
      if (r.info.downed && !r.leaving && near(r, LIFE.reviveReach)) {
        if (this.revivingTarget === r.info.sid) return [];
        return [{ key: "f", label: `Kaldır 🩹 (${r.info.name})`, act: `revive:${r.info.sid}` }];
      }
    }
    // Mahallede kapı: Minecraft gibi açılıp kapanır (herkes)
    const door = me.seated ? null : this.buildWorld.doorNear(me.x, me.z, me.baseY);
    if (door) return [{ key: "f", label: door.open ? "Kapıyı kapat 🚪" : "Kapıyı aç 🚪", act: `door:${door.plot}:${door.i}:${door.j}:${door.k}` }];
    // Futbol: top ayaktaysa ya da serbest top yakınsa vuruş; rakibin ayağındaysa müdahale
    const { pitch } = this.here();
    const ball = pitch.ball;
    const owner = pitch.owner;
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
    for (const [i, n] of world.npcs.entries()) if (near(n.act, n.act.r)) return [{ key: "f", label: n.act.label, act: `npc:${i}` }];
    // Galerideki platformlar: arabanın yanında incele / satın al
    for (const s of GALLERY_SLOTS) {
      if (s.model && near(s, 4.3)) return [{ key: "f", label: `🚗 ${CAR_MODELS.find((m) => m.id === s.model)?.name} · İncele / satın al`, act: "gallery" }];
    }
    for (const t of TABLES) {
      if (near(t, TABLE_WATCH_R) && !me.seated) return [{ key: "f", label: "Masayı izle 👀 (oynamak için tabureye otur)", act: `table:${t.id}` }];
    }
    for (const t of LIVE_TABLES) {
      if (near(t, LIVE_WATCH_NEAR) && !me.seated) return [{ key: "f", label: `Canlı ${{ roulette: "rulet", blackjack: "blackjack", poker: "poker" }[t.kind]} masasını izle 👀 (oynamak için tabureye otur)`, act: `live:${t.id}` }];
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
    if (this.mosque.handleAct(act)) return true;
    if (this.paintball.handleAct(act)) return true;
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
    if (act.startsWith("revive:")) {
      net.send({ t: "revive", sid: Number(act.slice(7)) });
      return true;
    }
    if (act === "gallery") {
      this.vehicles.menu.open(true);
      return true;
    }
    if (act.startsWith("door:")) {
      const [plot, i, j, k] = act.slice(5).split(":").map(Number);
      net.send({ t: "bdoor", plot, i, j, k });
      return true;
    }
    if (act.startsWith("live:")) {
      const t = LIVE_TABLES[Number(act.slice(5))];
      if (t) this.casino.open(t.kind, { table: t.id, seat: null });
      return true;
    }
    if (act.startsWith("table:")) {
      this.boards.open(Number(act.slice(6)));
      return true;
    }
    if (act.startsWith("npc:")) {
      const i = Number(act.slice(4)), n = this.c.world.npcs[i], w = this.workers[i];
      if (!n || !w) return false;
      w.emote = 0;
      w.emoteAt = now / 1000;
      emoteFx.emit(me.x, 0, me.z, FX_CELL[n.act.fx], now / 1000, undefined, 2);
      hud.toast(`${n.name}: "${n.act.line}"`);
      if (n.act.shop) this.c.shopWardrobe(n.act.shop);
      if (n.act.food) this.shopUi.open(n.act.food);
      if (n.act.gallery) this.vehicles.menu.open(true);
      return true;
    }
    if (act.startsWith("ring-")) {
      const { me, net } = this.c;
      if (act.startsWith("ring-join:")) {
        const slot = Number(act.slice(10)), g = GRID[slot];
        // Kutuya tam yerleş (sunucu da yakınlığa bakar)
        me.placeCar(g.x, g.z, g.rot);
        net.send({ t: "ring", op: "join", slot });
      } else if (act === "ring-start") net.send({ t: "ring", op: "start", laps: this.raceLaps });
      else if (act === "ring-laps") {
        this.raceLaps = RACE_LAPS[(RACE_LAPS.indexOf(this.raceLaps as (typeof RACE_LAPS)[number]) + 1) % RACE_LAPS.length];
        this.c.hud.toast(`🏁 Tur sayısı: ${this.raceLaps}`);
      } else if (act === "ring-leave") net.send({ t: "ring", op: "leave" });
      return true;
    }
    if (act === "lights") {
      this.myLights = !this.lightsOn();
      net.send({ t: "carlights", on: this.myLights });
      sfx.chip();
      return true;
    }
    if (act.startsWith("ride:")) {
      net.send({ t: "ride", d: Number(act.slice(5)) });
      return true;
    }
    if (act === "ride-off") {
      net.send({ t: "ride", d: null });
      return true;
    }
    if (act === "car-enter") {
      this.vehicles.enter();
      return true;
    }
    if (act === "car-off") {
      this.toggleCar();
      return true;
    }
    switch (act) {
      case "cay":
        this.shopUi.open("cay");
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

  /** Sahanın çizimi: 1 stadyum, yoksa salon. */
  private pitchOf(f: 0 | 1 | undefined): Pitch {
    return f ? this.c.world.stadium.pitch : this.c.world.pitch;
  }

  /** Bulunduğum saha (stadyumdaysam stadyum) ve çizimi. */
  private here(): { F: Field; pitch: Pitch } {
    return this.inArena ? { F: STADIUM_PITCH, pitch: this.c.world.stadium.pitch } : { F: PITCH, pitch: this.c.world.pitch };
  }

  /** Hücum ettiğim kale ve ona göre durumum (top nerede, kaleye ne kadar dönüğüm). */
  private attack(): { side: -1 | 1; dist: number; off: number } {
    const { me } = this.c;
    const { F, pitch } = this.here();
    const b = pitch.ball;
    // Maç stadyumda: salonda takım yok, baktığın kaleye
    const side = attackSide(this.inArena ? this.myTeam() : null, b.x, b.z, me.rot, F);
    return { side, ...goalView(side, b.x, b.z, me.rot, F) };
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
    const { me } = this.c;
    const { F, pitch } = this.here();
    const b = pitch.ball;
    const a = this.attack();
    if (kind === "shot" || kind === "power") return assistedShot(a.side, b.x, b.z, me.rot, pitch.keeper(a.side).z, F);
    if (kind === "lob" && a.dist < 20 && a.off < 0.9) return assistedShot(a.side, b.x, b.z, me.rot, null, F);
    return me.rot;
  }

  private kick(power: number, kind: KickKind): void {
    const { me, net } = this.c;
    const ang = this.kickDir(kind);
    net.send({ t: "kick", dir: ang, power, kind, curve: 0 });
    me.rot = ang;
    sfx.kick(kind === "pass" ? 0.45 : kind === "power" ? 1 : 0.6 + power * 0.4);
  }

  // ---------------------------------------------------------------------------
  // Kare başına
  // ---------------------------------------------------------------------------

  /** Kısayollar (oyuncu güncellemesinden önce). */
  keys(): void {
    const { input, me } = this.c;
    if (input.consumeKey("menu")) this.phone.toggle();
    if (input.consumeKey("build")) this.build.toggle();
    if (input.consumeKey("map")) this.map.toggle();
    if (this.build.active) {
      const e = input.consumeSlot();
      if (e >= 0) this.build.pickSlot(e);
    } else {
      const e = input.consumeSlot();
      if (e >= 0) this.selectSlot(e);
    }
    if (input.consumeKey("inventory")) this.inv.toggle();
    // Emote çarkı: basılı tutunca açılır, bırakınca seçilen yapılır
    if (input.consumeKey("emotes") && !this.wheel.open) {
      if (document.pointerLockElement && !input.touch) document.exitPointerLock();
      this.wheel.show();
    }
    if (this.wheel.open && !input.heldAction("emotes")) {
      const e = this.wheel.hide();
      if (e >= 0) input.triggerEmote(e);
    }
    // Kısa sol tık: eldeki eşyayı ye/iç
    if (input.consumeClick() && !me.downed && !me.car) {
      const s = this.hotbar.held();
      if (s && itemDef(s.id)?.use && this.hotbar.selected !== null) this.c.net.send({ t: "inv", op: "use", slot: this.hotbar.selected });
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
    if (input.consumeKey("car")) this.vehicles.menu.toggle();
    if (input.consumeKey("radio")) this.toggleRadio();
    this.volley.keys(performance.now() / 1000);
    me.photo = this.photo.active;
  }

  update(time: number, dt: number, now: number): void {
    const { me, net, world, remotes, input, emoteFx, camera } = this.c;
    const serverNow = net.serverNow();
    this.updateRide();
    this.updateRadios(serverNow);
    this.updateCasino(now);
    this.updateRace(serverNow);
    this.updateCarControls();
    this.updateCarFx(time, dt);
    this.cityLife.update({
      chibi: this.c.chibi, serverMs: serverNow, time, dt, camera: camera.position, hour: world.hour(), me, remotes,
      send: (ev) => net.send(ev),
    });
    this.vehicles.update(dt, time);
    this.updateLife(serverNow);
    this.updateHeld();
    this.updateJob(serverNow);

    // Saat: kişisel ayar > sinema modu (gündüzse) > dünyanın saati (!saat) > gerçek saat
    let hour: number | null = settings.clock === "auto" ? this.worldClock : CLOCK_HOURS[settings.clock];
    // Karartma, karartılmış gökten değil asıl saatten karar verir (yoksa kararınca kapanıp gidip gelir)
    if (settings.clock === "auto" && settings.cinemaDim && this.c.inCinema() && daylight(hour ?? istanbulHour()) > 0.3) hour = CINEMA_HOUR;
    world.setHour(hour);

    this.buildWorld.update(world.env.lights);
    // İnşa lambaları gece ışığına (ızgaralı ışık; duvarlar gölge düşürür)
    if (this.buildWorld.lightDirty && world.lamps) {
      this.buildWorld.lightDirty = false;
      world.lamps.setBuild(this.buildWorld.light.lamps, this.buildWorld.light.occ);
    }
    this.build.update();
    this.race.update(dt, time, 1 - world.env.day);
    this.mosque.update(time);
    this.paintball.update(time);
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

    // Stadyuma girip çıkınca tuş takımı değişir; stadyumda futbolun kendi tuşları
    const arena = inStadium(me.x, me.z);
    if (arena !== this.inArena) this.enterArena(arena);
    this.arenaKeys(time);

    // Vuruş gücü: basılı tutuldukça dolar (0.9 sn'de tam). Salonda F'ye kısa dokunuş pas (kaleye yakınsa
    // plase şut), uzun basış şut; G aşırtma. Stadyumda pas ayrı tuşta (Q): şut tuşuna dokunmak hafif şut.
    // Yön oyuncunun baktığı/koştuğu yön, şut kaleye kendiliğinden nişan alır.
    // Power şut daha uzun dolar (1.1 sn) ve en az orta güçle çıkar.
    const ch = this.charge;
    if (ch) {
      const full = ch.kind === "power" ? 1.1 : 0.9;
      if (input.heldAction(ch.key)) {
        ch.t += dt;
        const p = Math.min(1, ch.t / full);
        const tap = ch.kind === "shot" && ch.t < PASS_TAP && !this.inArena;
        this.whud.setPower(tap ? null : p, ch.kind === "lob" ? "Aşırtma" : ch.kind === "power" ? "Power şut" : "Şut");
      } else {
        const tap = ch.kind === "shot" && ch.t < PASS_TAP;
        if (tap && !this.inArena) this.kick(this.finishing() ? 0.5 : 0.4, this.finishing() ? "shot" : "pass");
        else this.kick(Math.max(tap ? 0.3 : ch.kind === "power" ? 0.4 : 0.15, Math.min(1, ch.t / full)), ch.kind);
        this.charge = null;
        this.whud.setPower(null);
      }
    }
    // Nişan oku: topun yanındayken vuruş yönü ve gücü (bulunduğum sahada)
    const { pitch } = this.here();
    const other = this.inArena ? world.pitch : world.stadium.pitch;
    const ball = pitch.ball;
    const owner = pitch.owner;
    // Topla koşan biraz yavaş (FIFA/PES gibi): savunma yetişebilsin
    me.speedMul = (owner === net.you ? 0.88 : 1) * ((this.buffs.kafein ?? 0) > net.serverNow() ? KAFEIN_SPEED : 1);
    const canKick = (owner === net.you || (owner === 0 && Math.hypot(ball.x - me.x, ball.z - me.z) <= KICK_REACH + 0.6)) && !me.seated && !me.vehicle;
    other.setAim(null);
    pitch.setAim(
      canKick && !input.touch
        ? (() => {
            // Ok, gidecek yönü gösterir: şutta kaleye kilitlenen yön, pasta baktığın yön
            const kind: KickKind = ch ? (ch.kind === "shot" && ch.t < PASS_TAP && !this.finishing() && !this.inArena ? "pass" : ch.kind) : this.finishing() ? "shot" : "pass";
            return { ang: this.kickDir(kind), power: ch ? Math.min(1, ch.t / (ch.kind === "power" ? 1.1 : 0.9)) : 0, kind };
          })()
        : null,
    );
    const nearPitch = Math.abs(me.x - PITCH.x) < PITCH.hx + 8 && Math.abs(me.z - PITCH.z) < PITCH.hz + 8;
    const m = this.match;
    const clock = m ? matchClock(m.endsAt - serverNow) : null;
    const myTeam = this.myTeam();
    // Köşedeki skor: stadyumda ya da maç sürerken stadyumun, salonda salonun
    this.whud.setScore(this.inArena || m ? this.scores[1] : nearPitch ? this.scores[0] : null, this.inArena || m ? clock : null, myTeam);
    world.pitch.setScore(this.scores[0]);
    world.stadium.pitch.setScore(this.scores[1], clock);
    const pose = (sid: number) => {
      const run = (f: number) => (f & FLAG_RUNNING ? 2 : f & FLAG_WALKING ? 1 : 0);
      if (sid === net.you) return { x: me.x, z: me.z, rot: me.rot, run: run(me.flags) };
      const r = remotes.map.get(sid);
      return r?.hasData ? { x: r.x, z: r.z, rot: r.rot, run: run(r.flags) } : null;
    };
    world.pitch.update(dt, serverNow, world.env.lights, pose);
    world.stadium.pitch.update(dt, serverNow, world.env.lights, pose);
    world.stadium.update(performance.now() / 1000);
    this.volley.update(dt, time, serverNow);
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
    // İçeride yağmur ve yaprak yağmaz
    this.weatherFx.group.visible = !this.c.me.room;
    if (this.leaves.mesh) this.leaves.mesh.visible = !this.c.me.room;
    this.weatherFx.update(time, dt, camera.position, 0.35 + 0.65 * world.env.day);
    world.flash(this.weatherFx.flash);
  }

  /** Stadyuma girdi/çıktı: tuş takımı, ipucu şeridi ve yarım kalan vuruş. */
  private enterArena(on: boolean): void {
    this.inArena = on;
    setProfile(on ? "stadium" : "world");
    this.charge = null;
    this.whud.setPower(null);
    const keys = on && !this.c.input.touch;
    this.fbHelp.classList.toggle("show", keys);
    this.fbExit.classList.toggle("show", on);
    this.fbTeamBtn.classList.toggle("show", on);
    if (!on) this.teamPanel.close();
    if (keys) {
      this.renderFbHelp();
      this.c.hud.toast("🏟️ Stadyumdasın! Futbol tuşları geçerli (alttaki şeritte). Değiştirmek için ⌨️ Tuşlar.");
    }
  }

  /** Stadyum tuş ipucu: geçerli atamalarla. */
  renderFbHelp(): void {
    if (profile !== "stadium") return;
    const k = (a: Action) => `<b>${actionLabel(a)}</b>`;
    this.fbHelp.innerHTML =
      `${k("fbPass")} Pas · ${k("fbShoot")} Şut · ${k("fbPower")} Power · ${k("fbLob")} Aşırtma · ${k("fbSkill")} Çalım · ${k("fbRainbow")} Rainbow · ` +
      `${k("fbTackle")} Müdahale · ${k("run")}+${k("fbTackle")} Kayarak · ${k("fbTeam")} Takım <button type="button">⌨️ Tuşlar</button>`;
    this.fbHelp.querySelector("button")?.addEventListener("click", () => dispatchEvent(new Event("gap:keys")));
  }

  /** Stadyumdan salondaki sahaya (maçtaysa maçtan da çıkar). */
  private goHome(): void {
    this.teamPanel.close();
    this.c.net.send({ t: "fbhome" });
  }

  private toggleTeams(): void {
    if (this.teamPanel.isOpen) return this.teamPanel.close();
    this.renderTeams();
    this.teamPanel.open();
  }

  /** Takım menüsü: maçta kırmızı/mavi takıma geç (kişi sayılarıyla); maç yoksa başlat; dünyaya dön. */
  private renderTeams(): void {
    const b = this.teamPanel.body, m = this.match, mine = this.myTeam();
    b.replaceChildren();
    if (!m) {
      el("div", "settings-note", b, "Stadyumda süren maç yok.");
      button(b, "⚽ Maç başlat (5 dk)", () => {
        this.c.say("!maç 5");
        this.teamPanel.close();
      }, "fb-team-btn");
    } else {
      el("div", "settings-note", b, mine === null ? "Henüz bir takımda değilsin: seçtiğin takımın yarısına geçersin." : `Takımın: ${mine ? "🔵 Mavi" : "🔴 Kırmızı"}`);
      const row = el("div", "fb-team-row", b);
      for (const t of [0, 1] as const) {
        const btn = button(row, `${t ? "🔵 Mavi" : "🔴 Kırmızı"} · ${m.teams[t].length} kişi`, () => {
          this.c.net.send({ t: "fbteam", team: t });
          this.teamPanel.close();
        }, `fb-team-btn fb-team-${t}`);
        btn.disabled = mine === t;
      }
    }
    button(b, "🏠 Dünyaya dön", () => this.goHome(), "fb-team-btn fb-team-home");
  }

  /** Stadyum tuşları: pas, şut, power şut ve aşırtma (basılı tutulur), çalım, rainbow, müdahale (koşarken kayarak), takım menüsü. */
  private arenaKeys(time: number): void {
    const { input, me, net } = this.c;
    const pass = input.consumeKey("fbPass"), shoot = input.consumeKey("fbShoot"), lob = input.consumeKey("fbLob"), power = input.consumeKey("fbPower");
    const skill = input.consumeKey("fbSkill"), rainbow = input.consumeKey("fbRainbow"), tackle = input.consumeKey("fbTackle"), team = input.consumeKey("fbTeam");
    if (!this.inArena) return;
    if (team) this.toggleTeams();
    if (me.seated || me.vehicle || me.jailed) return;
    const { pitch } = this.here();
    const mine = pitch.owner === net.you;
    const canKick = mine || (pitch.owner === 0 && Math.hypot(pitch.ball.x - me.x, pitch.ball.z - me.z) <= KICK_REACH);
    if (canKick && !this.charge) {
      if (pass) this.kick(0.45, "pass");
      else if (shoot) this.charge = { key: "fbShoot", kind: "shot", t: 0 };
      else if (power) this.charge = { key: "fbPower", kind: "power", t: 0 };
      else if (lob) this.charge = { key: "fbLob", kind: "lob", t: 0 };
    }
    // Çalım (roulette): top yanından yarım daire çizer, oyuncu o yana dönerek çapraz atılır; o an müdahale
    // edilemezsin. Yan: basılı yön tuşu, yoksa sırayla iki yana.
    if (skill && mine && !this.charge && time - this.lastSkill > SKILL_DASH.cooldown) {
      this.lastSkill = time;
      const side: -1 | 1 = input.moveX > 0.1 ? 1 : input.moveX < -0.1 ? -1 : (this.skillSide = this.skillSide === 1 ? -1 : 1);
      net.send({ t: "skill", side });
      const a = me.rot - side * SKILL_DASH.angle;
      me.dash(Math.sin(a) * SKILL_DASH.speed, Math.cos(a) * SKILL_DASH.speed, SKILL_DASH.t);
      me.trick = { at: performance.now() / 1000, side };
      pitch.trick(net.you, side, net.serverNow());
      sfx.kick(0.25);
    }
    // Rainbow: top arkadan başının üstünden öne; koşup yetişirsin
    if (rainbow && mine && !this.charge && time - this.lastSkill > SKILL_DASH.cooldown) {
      this.lastSkill = time;
      net.send({ t: "rainbow" });
      sfx.kick(0.3);
    }
    // Müdahale: koşarken kayarak (uzun menzil, ıskalarsan bir an yerdesin), yürürken ayakta
    if (tackle && !mine) {
      const slide = input.run && (me.flags & FLAG_WALKING) !== 0;
      if (time - this.lastTackle > (slide ? SLIDE_DASH.cooldown : TACKLE_COOLDOWN)) {
        this.lastTackle = time;
        net.send({ t: "tackle", slide });
        if (slide) {
          me.dash(Math.sin(me.rot) * SLIDE_DASH.speed, Math.cos(me.rot) * SLIDE_DASH.speed, SLIDE_DASH.t);
          me.slide = performance.now() / 1000;
        }
        sfx.kick(0.3);
      }
    }
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
    // Kapalı voleybol salonunda yaprak/kar düşmez
    this.leaves.update(camera.position, 0.35 + 0.65 * day, w.kind === "storm" ? 2.2 : w.kind === "rain" ? 1.4 : 1, this.volley.active);
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
    me.hidden = (settings.firstPerson || !!me.fps) && !me.driving && !this.photo.active;
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
    if (this.jobNpc) avatars.push(this.jobNpc, time);
    for (const v of this.paintball.extras()) avatars.push(v, time);
    // Çalışanlar yalnızca yakındayken çizilir (her chibi on binlerce üçgen)
    for (const w of this.workers) if ((w.x - me.x) ** 2 + (w.z - me.z) ** 2 < 28 * 28) avatars.push(w, time);
    const c = this.companions;
    c.begin();
    if (!me.driving) c.push(net.you, me, settings.pet || null, time, dt);
    for (const r of remotes.map.values()) if (r.hasData) c.push(r.info.sid, r, r.info.pet, time, dt);
    this.cityLife.pushCats(c, net.serverNow(), time, dt, this.c.camera.position);
    c.end();
  }

  /**
   * Arabada korna (E, basılı tut) ve selektör (X, basılı tut): herkese gider. Arabadan inince ya da bir menü
   * açılınca susar.
   */
  private updateCarControls(): void {
    const { me, net, input } = this.c;
    this.c.hud.setDriving(!!me.car);
    const can = !!me.car && !this.vehicles.modalOpen;
    const horn = can && input.heldAction("horn"), flash = can && input.heldAction("flash");
    if (horn !== this.hornDown) {
      this.hornDown = horn;
      if (horn) this.horns.start(net.you, settings.car.horn);
      else this.horns.release(net.you);
      net.send({ t: "carfx", k: "horn", on: horn });
    }
    if (flash !== this.flashDown) {
      this.flashDown = flash;
      if (flash) sfx.tick(1.5);
      net.send({ t: "carfx", k: "flash", on: flash });
    }
    // Kornası/selektörü takılı kalanlar (mesajı kaybolan) bir süre sonra kendiliğinden söner; arabadan inenler hemen
    const now = performance.now();
    for (const [sid, at] of this.remoteFlash) if (now - at > 8000 || !this.c.remotes.map.get(sid)?.info.car) this.remoteFlash.delete(sid);
    for (const [sid, at] of this.remoteHorn) {
      if (now - at > 10000 || !this.c.remotes.map.get(sid)?.info.car) {
        this.remoteHorn.delete(sid);
        this.horns.kill(sid);
      }
    }
    this.horns.update((sid) => (sid === net.you ? { level: 1, pan: 0 } : this.hornLevel(sid)));
  }

  /** Başkasının kornasının sana göre sesi (uzaklık) ve yanı. */
  private hornLevel(sid: number): { level: number; pan: number } | null {
    const r = this.c.remotes.map.get(sid);
    if (!r) return null;
    const cam = this.c.camera, e = cam.matrixWorld.elements;
    const dx = r.x - cam.position.x, dz = r.z - cam.position.z, d = Math.hypot(dx, dz);
    const near = Math.max(0, 1 - d / 80);
    return { level: near * near, pan: (dx * e[0] + dz * e[2]) / Math.max(1, d) };
  }

  /** Kendi arabanın fren lambası, el freni ve selektörü (çizim için). */
  myCarFx(): { brake: boolean; hand: boolean; high: boolean } {
    const c = this.c.me.car;
    return { brake: !!c && (c.hand || (c.throttle < -0.1 && c.v > 0.3) || (c.throttle > 0.1 && c.v < -0.3)), hand: !!c?.hand, high: this.flashDown };
  }

  /** Başkasının arabası: selektör yanıyor mu. */
  carFxOf(sid: number): { high: boolean } {
    return { high: this.remoteFlash.has(sid) };
  }

  /** Kayan lastikten beyaz duman. */
  tireSmoke(x: number, z: number): void {
    this.smoke.emit(x, 0.25, z, this.fxTime, 0);
  }

  /** Kendi arabanın hasar seviyesi (0–3). */
  get carDamage(): number {
    return Math.floor(this.damage);
  }

  /** Motor sesleri, hasar dumanı, garajda onarım. */
  private updateCarFx(time: number, dt: number): void {
    const { me, net, remotes, camera } = this.c;
    this.fxTime = time;
    // Arabaya binince hasarı herkese bildir; garajda onar
    if (me.car && !this.hadCar && (this.carDamage || this.dents.f || this.dents.r || this.dents.l || this.dents.rt || this.dents.hl)) net.send({ t: "cardmg", d: this.carDamage, z: this.dents });
    this.hadCar = !!me.car;
    // Garajda: hafif çizik bedava silinir, hasar ücretle onarılır (sunucu parayı alıp hasarı sıfırlar)
    if (this.vehicles.tuning.isOpen && this.damage > 0 && !this.repairAsked) {
      if (this.carDamage === 0) {
        this.damage = 0;
        this.clearDents();
      }
      else {
        this.repairAsked = true;
        net.send({ t: "repair" });
      }
    }
    if (!this.vehicles.tuning.isOpen) this.repairAsked = false;
    me.carWear = me.car ? this.carDamage : 0;
    // Hız göstergesi: arabadayken (GAP Ring yarışında yarışın göstergesi çıkar)
    const inRing = !!this.ring && this.ring.phase !== "idle" && this.ring.racers.some((r) => r.sid === net.you);
    const showSpeed = !!me.car && !inRing;
    this.speedo.classList.toggle("show", showSpeed);
    if (showSpeed) {
      const kmh = Math.round(Math.abs(me.car!.v) * 3.6), key = kmh * 4 + (me.car!.hand ? 1 : 0) + (me.car!.v < -0.3 ? 2 : 0);
      if (key !== this.shownKmh) {
        this.shownKmh = key;
        drawSpeedo(this.speedo, me.car!.v, me.car!.hand);
      }
    }
    // Motorlar: sen, yakındaki oyuncu arabaları ve NPC arabalar
    const list = this.engineSources;
    list.length = 0;
    const cam = camera.position;
    // Kameranın sağ yönü (ses sağdan/soldan gelsin)
    const rx = camera.matrixWorld.elements[0], rz = camera.matrixWorld.elements[2];
    const add = (x: number, z: number, speed: number, throttle: number, own = false, car?: CarSpec) => {
      const dx = x - cam.x, dz = z - cam.z, dist = Math.hypot(dx, dz);
      const st = car ? CAR_STATS[car.model] : null;
      list.push({
        speed, throttle, dist: own ? 0 : dist, pan: own ? 0 : (dx * rx + dz * rz) / Math.max(1, dist), own,
        pitch: st?.pitch, diesel: st?.diesel, stage: car ? CAR_ENGINES.findIndex((e) => e.id === car.engine) : 0,
      });
    };
    if (me.car) {
      const acc = (me.car.v - this.lastCarV) / Math.max(dt, 1e-3);
      this.lastCarV = me.car.v;
      add(me.x, me.z, me.car.v, Math.max(0, Math.min(1, acc / 4 + 0.15)), true, settings.car);
      // Gazı birden bırakınca: turbo "pıssst", spor egzozdan ya da güçlü motordan patlamalar
      const gas = Math.max(0, me.car.throttle), car = settings.car;
      if (this.lastGas > 0.6 && gas < 0.2 && me.car.v > 9 && time - this.popAt > 0.8) {
        this.popAt = time;
        if (car.engine === "turbo" || car.engine === "yaris") sfx.turbo();
        if (car.exhaust === "spor" || car.engine === "yaris" || (car.engine !== "stok" && Math.random() < 0.5)) sfx.backfire(0.7);
      }
      this.lastGas = gas;
    } else this.lastGas = 0;
    for (const r of remotes.map.values()) {
      if (!r.hasData || !r.info.car) continue;
      const p = this.prevCars.get(r.info.sid);
      const sp = p && dt > 0 ? Math.hypot(r.x - p.x, r.z - p.z) / dt : 0;
      if (p) [p.x, p.z] = [r.x, r.z];
      else this.prevCars.set(r.info.sid, { x: r.x, z: r.z });
      add(r.x, r.z, sp, 0.4, false, r.info.car);
    }
    for (const car of this.cityLife.traffic.cars) if (car.shown) add(car.x, car.z, car.v, car.v > 1 ? 0.35 : 0.05);
    this.engines.update(list);
    // Hasarlı arabalardan duman (2: açık gri, 3: kara)
    if (time - this.smokeAt > 0.12) {
      this.smokeAt = time;
      const puff = (x: number, z: number, rot: number, d: number) => {
        if (d >= 2) this.smoke.emit(x + Math.sin(rot) * 1.7, 1.1, z + Math.cos(rot) * 1.7, time, d === 3 ? 0.9 : 0.3);
      };
      if (me.car) puff(me.x, me.z, me.rot, this.carDamage);
      for (const r of remotes.map.values()) if (r.hasData && r.info.car && Math.hypot(r.x - me.x, r.z - me.z) < 120) puff(r.x, r.z, r.rot, r.info.dmg ?? 0);
    }
    this.smoke.update(time, camera);
  }

  /** Gece farı yanan NPC arabalar (Cars gerçek far ışığını bunlarla paylaşır). */
  /**
   * Yükleme ekranında NPC mesh'leri (trafik, kalabalık) ve senin, ocakçının, çalışanların kıyafetleri (işçide):
   * oyun sırasında geometri kurulmasın.
   */
  prewarmNpcs(): Promise<unknown> {
    const { chibi, me } = this.c;
    const near = [me.outfit, this.teaMaker.outfit].map((look) => ({ look, lod: 0 as const }));
    const far = this.workers.map((w) => ({ look: w.outfit, lod: 1 as const }));
    const looks = chibi.warm([...near, ...far]);
    return Promise.all([this.cityLife.prewarm(chibi), looks]);
  }

  npcHeadlights(): { x: number; z: number; rot: number }[] {
    return this.cityLife.traffic.headlights();
  }

  /** Konuşma balonunun yeri: NPC yayalar (oyuncular main.ts'te). */
  anchor(sid: number): { x: number; z: number; y: number } | null {
    return this.cityLife.anchor(sid);
  }

  /** Fotoğraf filtresi (0 yok): son işlem zorla açılır. */
  get filter(): number {
    return this.photo.active ? this.photo.filter : 0;
  }
}

