// Oda başına oyuncu durumu ve 15 Hz snapshot yayını.
import {
  clampToJail,
  clampToWorld,
  FLAG_DRIVING,
  FLAG_MASK,
  FLAG_SEATED,
  JAIL_SPAWN,
  maxSpeed,
  outsideWorld,
  RELEASE_SPAWN,
  ROOM_MAX_PLAYERS,
} from "../../shared/constants";
import {
  type ChatLine,
  type Look,
  type PlayerInfo,
  PETS,
  type PlayerState,
  type ServerEvent,
  SKINS,
  snapshotSize,
  writeSnapshotEntry,
  writeSnapshotHeader,
} from "../../shared/protocol";
import { GARAGE, GARAGE_KEEP_CLEAR, inStadium, inVolley, SPAWN } from "../../shared/zones";
import { inPbField } from "../../shared/paintball";
import { CAR_MAX_SPEED, type CarRadio, type CarSpec, ENTER_REACH, isJobCar, NO_DENTS, validDents, type ParkedCar, PARK_REACH, RIDE_SEATS, validCar } from "../../shared/car";
import { clampElev, computeShot, DEFAULT_ELEV, FIRE_COOLDOWN_MS, TANK_PARK, TANK_REACH, TANK_RETURN_MS } from "../../shared/tank";
import type { SessionUser } from "./auth";
import { Battle } from "./battle";
import type { WorldGames } from "./games/world";
import type { RingHost } from "./ring";
import type { LiveHost } from "./liveTables";
import { RadioQueues } from "./radioQueue";
import type { LifeHost } from "./life";
import type { Bags } from "./inventory";
import type { JobHost } from "./jobs";

const PET_IDS = new Set<string>(PETS.map((p) => p.id));
const SKIN_IDS = new Set<string>(SKINS.map((s) => s.id));

/** Odanın tek tankı. Sürücü varken konumu sürücünün konumudur. */
interface Tank {
  driver: number;
  x: number;
  z: number;
  h: number;
  tr: number;
  /** Namlu açısı. */
  el: number;
  lastFire: number;
  /** Son inişin zamanı: uzun süre boş kalırsa park yerine döner. */
  idleSince: number;
}

export interface Conn {
  send(data: string | Uint8Array): void;
  /** Gönderilmeyi bekleyen bayt; yavaş istemcilere snapshot atlanır. */
  readonly bufferedAmount: number;
  /** Hızlı yol (UDP, kaybolabilir): snapshot gittiyse true, yoksa WebSocket'ten gider. */
  sendFast?(data: Uint8Array): boolean;
}

interface Player {
  info: PlayerInfo;
  user: SessionUser;
  /** Activity'nin açıldığı sunucu (sürgün sunucu bazında). */
  guild: string | null;
  /** Test için zorla zindana konmuş misafir (`?jail=1`). */
  forceJail: boolean;
  state: PlayerState;
  /** `state`'in ait olduğu an (sunucu saati): istemcinin bildirdiği örnek zamanı, doğrulanmış. */
  sampledAt: number;
  /** Kabul edilen son istemci zamanı (ham): UDP'de sırası karışıp geç gelen eski konum yok sayılır. */
  sentAt: number;
  /** Son konum mesajının geldiği an (hız kontrolü buna göre). */
  lastUpdate: number;
  joinedAt: number;
  /** Kaldığı yerden başladı mı (girişte bir kez). */
  resumed?: boolean;
  conn: Conn;
}

/** Kaldığı yerden başlama isteği girişten sonra bu kadar süre kabul edilir. */
export const RESUME_MS = 10_000;

const MAX_BUFFERED = 64 * 1024;
const SPAWN_RADIUS = 3;
/** İstemcinin örnek zamanı varış anından bundan daha eski olamaz (takılmış hat, bozuk saat). */
const MAX_SAMPLE_AGE_MS = 1000;
/**
 * Bundan kısa süre geriden gelen konum, sırası karışmış eski pakettir (yok sayılır); daha da geriye gitmişse
 * istemcinin saati büyük bir düzeltmeyle atlamıştır (kabul edilir).
 */
const REORDER_MS = 250;
/** Son değişiklik bu kadar yayında daha gider: hızlı yolda biri kaybolsa da duran oyuncunun son yeri ulaşır. */
const TRAIL_TICKS = 3;

/**
 * Konumun ait olduğu an: istemci kendi saatini sunucu saatine çevirip yollar (`sentAt`, 0: bilinmiyor).
 * Gelecekte olamaz, çok eski olamaz ve oyuncunun bir önceki örneğinden geriye gidemez. Tam ms: snapshot'ta
 * yaş olarak gider, istemci her yayında birebir aynı zamanı okumalı (yoksa duran oyuncu "yeni örnek" sanılır).
 */
function sampleTime(sentAt: number, prev: number, now: number): number {
  const t = sentAt > 0 ? Math.min(now, Math.max(now - MAX_SAMPLE_AGE_MS, sentAt)) : now;
  return Math.max(Math.round(t), prev + 1);
}

export class Room {
  readonly players = new Map<number, Player>();
  /** Son sohbet mesajları (yalnızca bellekte); yeni gelen geçmişi görür. */
  readonly chat: ChatLine[] = [];
  readonly tank: Tank = { driver: 0, x: TANK_PARK.x, z: TANK_PARK.z, h: TANK_PARK.h, tr: TANK_PARK.h, el: DEFAULT_ELEV, lastFire: 0, idleSince: 0 };
  /** Tank savaşı odası ("b:..."): dünyanın tek tankı yerine takımlı maç. */
  readonly battle: Battle | null;
  /** Dünya odasının oyunları (savaş odasında yok); sunucu oda açılınca kurar. */
  games: WorldGames | null = null;
  /** GAP Ring yarışı (savaş odasında yok). */
  ring: RingHost | null = null;
  /** Canlı casino masaları (savaş odasında yok). */
  live: LiveHost | null = null;
  /** Hayat barları (savaş odasında yok). */
  life: LifeHost | null = null;
  /** Çantalar (savaş odasında yok). */
  bags: Bags | null = null;
  /** İşler: kuryelik, taksicilik (savaş odasında yok). */
  jobs: JobHost | null = null;
  /** Oyuncuların radyo sıraları. */
  readonly radioQ = new RadioQueues(this);
  /** Görev/sayaç olayı (botta): sunucu bağlar; tank isabeti, savaşta vuruş ve galibiyet buradan. */
  onReport: (sid: number, event: string, amount?: number) => void = () => {};
  private nextSid = 1;
  /** Kalan yayın sayısı (değişiklikten sonra TRAIL_TICKS). */
  private dirty = 0;

  constructor(readonly key: string) {
    this.battle = key.startsWith("b:") ? new Battle(this) : null;
  }

  get size(): number {
    return this.players.size;
  }

  private activeCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.info.spectator) n++;
    return n;
  }

  join(user: SessionUser, conn: Conn, now = Date.now(), opts: JoinOptions = {}): number {
    // 60000 ve üstü istemcide yerel sahte oyunculara ayrılmış.
    while (this.players.has(this.nextSid)) this.nextSid = (this.nextSid % 59999) + 1;
    const sid = this.nextSid;
    this.nextSid = (this.nextSid % 59999) + 1;
    const info: PlayerInfo = {
      sid,
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      spectator: this.activeCount() >= ROOM_MAX_PLAYERS,
      jailed: !!opts.jailed,
    };
    const a = Math.random() * Math.PI * 2;
    const state: PlayerState = {
      x: SPAWN.x + Math.cos(a) * SPAWN_RADIUS * Math.random(),
      z: SPAWN.z + Math.sin(a) * SPAWN_RADIUS * Math.random(),
      rot: SPAWN.rot,
      flags: 0,
    };
    if (info.jailed) Object.assign(state, JAIL_SPAWN);
    const others = [...this.players.values()].map((p) => p.info);
    this.players.set(sid, {
      info,
      user,
      guild: opts.guild ?? null,
      forceJail: !!opts.forceJail,
      state,
      sampledAt: Math.round(now),
      sentAt: 0,
      lastUpdate: now,
      joinedAt: now,
      conn,
    });
    this.sendTo(conn, { t: "welcome", you: sid, room: this.key, players: [info, ...others] });
    if (this.battle) this.battle.join(sid);
    else this.sendTo(conn, this.tankEvent());
    this.games?.join(sid, conn);
    this.broadcast({ t: "join", player: info }, sid);
    this.dirty = TRAIL_TICKS;
    return sid;
  }

  leave(sid: number): void {
    const p = this.players.get(sid);
    if (!p) return;
    if (this.tank.driver === sid) this.exitTank(sid);
    this.ejectRiders(sid);
    this.radioQ.leave(sid);
    this.life?.leave(sid);
    this.bags?.leave(sid);
    this.jobs?.leave(sid);
    this.players.delete(sid);
    this.battle?.leave(sid);
    this.games?.leave(sid);
    this.ring?.leave(sid);
    this.live?.leave(sid);
    this.broadcast({ t: "leave", sid });
    // Boşalan yere en eski izleyici geçer; istemciler onu yeni katılan gibi görür.
    if (!p.info.spectator) {
      for (const q of this.players.values()) {
        if (!q.info.spectator) continue;
        q.info.spectator = false;
        q.lastUpdate = Date.now();
        this.broadcast({ t: "join", player: q.info });
        break;
      }
    }
    this.dirty = TRAIL_TICKS;
  }

  /**
   * İstemcinin bildirdiği konumu sınırlar ve hız kontrolünden geçirerek uygular.
   * `sentAt`: konumun istemcide alındığı an (sunucu saati); snapshot'ta her oyuncu kendi zamanıyla gider.
   */
  applyState(sid: number, s: PlayerState, now = Date.now(), sentAt = 0): void {
    const p = this.players.get(sid);
    if (!p || p.info.spectator) return;
    if (this.battle && !this.battle.canMove(sid)) return;
    if (this.games?.frozen(sid)) {
      p.lastUpdate = now;
      return;
    }
    if (sentAt > 0 && sentAt <= p.sentAt && sentAt > p.sentAt - REORDER_MS) return;
    if (sentAt > 0) p.sentAt = sentAt;
    // Bayılan yerinde kalır (yerde oturur)
    if (this.life?.isDowned(sid)) {
      p.state.flags = FLAG_SEATED;
      p.lastUpdate = now;
      return;
    }
    // Yolcu: konumu sürücünün arabası (istemcinin söylediği yok sayılır)
    const driver = p.info.ride ? this.players.get(p.info.ride.d) : undefined;
    if (driver) {
      p.state.x = driver.state.x;
      p.state.z = driver.state.z;
      p.state.rot = driver.state.rot;
      p.state.flags = FLAG_SEATED;
      p.sampledAt = driver.sampledAt;
      p.lastUpdate = now;
      this.dirty = TRAIL_TICKS;
      return;
    }
    const dt = Math.min(1, Math.max(0, (now - p.lastUpdate) / 1000));
    // Araçtan inip binerken iki durumun hızlısı (bisikletten inen bir an daha hızlı gidebilir)
    const maxStep = (p.info.car ? CAR_MAX_SPEED : Math.max(maxSpeed(s.flags), maxSpeed(p.state.flags))) * dt * 1.3 + 0.5;
    let dx = s.x - p.state.x;
    let dz = s.z - p.state.z;
    const d = Math.hypot(dx, dz);
    if (d > maxStep) {
      dx *= maxStep / d;
      dz *= maxStep / d;
    }
    p.state.x += dx;
    p.state.z += dz;
    clampToWorld(p.state, -1);
    if (p.info.jailed) clampToJail(p.state);
    this.battle?.clamp(p.state);
    p.state.rot = s.rot;
    // Sürücü bayrağını yalnızca gerçekten süren taşır
    p.state.flags = s.flags & FLAG_MASK & (this.tank.driver === sid ? FLAG_MASK : ~FLAG_DRIVING);
    p.sampledAt = sampleTime(sentAt, p.sampledAt, now);
    p.lastUpdate = now;
    this.dirty = TRAIL_TICKS;
    if (p.info.car) {
      this.ring?.move(sid, p.state.x, p.state.z, now);
      this.life?.carMove(sid, p.state.x, p.state.z, now);
    }
    this.live?.move(sid, p.state.x, p.state.z, now);
  }

  /** Odaya sohbet satırı: geçmişe eklenir ve herkese gider. */
  say(line: ChatLine, max = 30): void {
    this.chat.push(line);
    if (this.chat.length > max) this.chat.splice(0, this.chat.length - max);
    this.broadcast({ t: "chat", line });
  }

  /** Evcil hayvan ve tank kamuflajı (istemcide saklanır): geçerli değilse boş. */
  setCosmetics(sid: number, pet: unknown, skin: unknown): void {
    const p = this.players.get(sid);
    if (!p) return;
    p.info.pet = typeof pet === "string" && PET_IDS.has(pet) ? pet : null;
    p.info.skin = typeof skin === "string" && SKIN_IDS.has(skin) ? skin : null;
    this.broadcast({ t: "cosm", sid, pet: p.info.pet, skin: p.info.skin });
    this.battle?.refresh();
  }

  /** Tofaşa bin (doğrulanmış araba) ya da in (null); odaya duyurur. */
  setCar(sid: number, car: CarSpec | null): void {
    const p = this.players.get(sid);
    if (!p || p.info.spectator || (car && (p.info.jailed || this.tank.driver === sid))) return;
    p.info.car = car;
    if (!car) {
      p.info.dmg = 0;
      p.info.dents = null;
    }
    this.broadcast({ t: "car", sid, car });
    // Park halindeki arabasına bindi: park yeri boşalır
    if (car && p.info.parked) this.setParked(sid, null);
    // Yolcuyken kendi arabasına binerse yolculuk biter; sürücü inerse yolcuları da iner. Radyo inince de çalar.
    if (car && p.info.ride) this.ride(sid, null);
    if (!car) {
      this.ejectRiders(sid);
      p.info.lights = null;
    }
    // Arabadan inen yarıştan çıkar (yarış sürüyorsa DNF)
    if (!car) this.ring?.leave(sid);
  }

  /** Arabanın radyosu: şarkı (herkes aynı andan dinler) ya da sus (null). Arabada değilse çalmaz. */
  /** Arabanın hasar seviyesi (0–3): yalnızca arabadayken; odaya duyurulur. */
  setCarDamage(sid: number, d: unknown, z?: unknown): void {
    const p = this.players.get(sid);
    if (!p || !p.info.car || !Number.isInteger(d) || (d as number) < 0 || (d as number) > 3) return;
    // İş araçları hasar almaz
    if (isJobCar(p.info.car.model)) {
      d = 0;
      z = NO_DENTS;
    }
    const dents = z === undefined ? (p.info.dents ?? null) : validDents(z);
    if (p.info.dmg === d && JSON.stringify(dents) === JSON.stringify(p.info.dents ?? null)) return;
    p.info.dmg = d as number;
    p.info.dents = dents;
    this.broadcast({ t: "cardmg", sid, d: d as number, z: dents });
  }

  /** Arabayı park et (indiği yer ya da çağırdığı yer): oyuncunun yakınında olmalı. Geçersizse yok sayılır. */
  setParked(sid: number, v: unknown): void {
    const p = this.players.get(sid);
    if (!p || p.info.spectator) return;
    let parked: ParkedCar | null = null;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const car = validCar(o.car);
      const want = (o.car as { model?: unknown } | null)?.model;
      if (car && isJobCar(want) && this.jobs?.modelOf(sid) === want) car.model = want;
      const x = Number(o.x), z = Number(o.z), rot = Number(o.rot);
      if (!car || ![x, z, rot].every(Number.isFinite)) return;
      if (Math.hypot(x - p.state.x, z - p.state.z) > PARK_REACH) return;
      if (Math.hypot(x - GARAGE.spot.x, z - GARAGE.spot.z) < GARAGE_KEEP_CLEAR) return;
      const at = { x, z };
      clampToWorld(at, 1);
      parked = { car, x: at.x, z: at.z, rot };
      // Göçükleriyle park eder (iş araçları hep sağlam)
      const dmg = o.dmg, dents = validDents(o.dents);
      if (!isJobCar(car.model)) {
        if (Number.isInteger(dmg) && (dmg as number) > 0 && (dmg as number) <= 3) parked.dmg = dmg as number;
        if (dents && (dents.f || dents.r || dents.l || dents.rt || dents.hl)) parked.dents = dents;
      }
    }
    if (!parked && !p.info.parked) return;
    p.info.parked = parked;
    this.broadcast({ t: "parked", sid, parked });
  }

  /** Arabanın farları (yalnızca arabadayken). */
  setLights(sid: number, on: unknown): void {
    const p = this.players.get(sid);
    if (!p || !p.info.car || typeof on !== "boolean") return;
    p.info.lights = on;
    this.broadcast({ t: "carlights", sid, on });
  }

  /** Korna ya da selektör (yalnızca arabadayken): yakındakiler duyar/görür (gönderene geri gitmez). */
  carFx(sid: number, k: unknown, on: unknown): void {
    const p = this.players.get(sid);
    if (!p || !p.info.car || (k !== "horn" && k !== "flash") || typeof on !== "boolean") return;
    this.broadcast({ t: "carfx", sid, k, on }, sid);
  }

  /**
   * Yolcu olarak bin (`driver`ın arabasına, yanındaysa ve boş koltuk varsa) ya da in (null). Hata metni döner.
   */
  ride(sid: number, driver: number | null): string | null {
    const p = this.players.get(sid);
    if (!p || p.info.spectator) return null;
    if (driver === null) {
      if (!p.info.ride) return null;
      const prev = p.info.ride.d;
      p.info.ride = null;
      this.broadcast({ t: "ride", sid, ride: null });
      this.jobs?.rideChanged(sid, null, prev);
      return null;
    }
    const d = this.players.get(driver);
    if (!d || !d.info.car || driver === sid) return "🚗 Bu arabanın sürücüsü yok.";
    if (p.info.car || p.info.jailed || this.tank.driver === sid) return "🚗 Önce arabandan in.";
    if (d.info.car.model === "motor") return "🛵 Kurye scooter'ına yolcu binmez.";
    if (Math.hypot(p.state.x - d.state.x, p.state.z - d.state.z) > ENTER_REACH + 2) return "🚗 Arabaya yaklaş.";
    const taken = new Set([...this.players.values()].filter((q) => q.info.ride?.d === driver).map((q) => q.info.ride!.s));
    const seat = [1, 2, 3].find((s) => s <= RIDE_SEATS && !taken.has(s));
    if (!seat) return "🚗 Arabada boş koltuk yok.";
    p.info.ride = { d: driver, s: seat };
    this.broadcast({ t: "ride", sid, ride: p.info.ride });
    this.jobs?.rideChanged(sid, driver, null);
    return null;
  }

  /** Sürücü indi ya da ayrıldı: yolcuları iner. */
  private ejectRiders(driver: number): void {
    for (const [sid, q] of this.players) if (q.info.ride?.d === driver) this.ride(sid, null);
  }

  setRadio(sid: number, radio: CarRadio | null): void {
    const p = this.players.get(sid);
    if (!p) return;
    p.info.radio = radio;
    this.broadcast({ t: "radio", sid, radio });
  }

  /** Bottan gelen (doğrulanmış) kıyafeti uygular ve odaya duyurur. Oyuncu ayrıldıysa bir şey yapmaz. */
  setLook(sid: number, look: Look): void {
    const p = this.players.get(sid);
    if (!p) return;
    p.info.look = look;
    this.broadcast({ t: "look", sid, look });
  }

  /**
   * Sürgün listesi değişince çağrılır: durumu değişen oyuncuyu zindana alır ya da çıkarır.
   * Konumu sunucu belirler ve herkese bildirir; istemci kendini oraya ışınlar.
   */
  updateJail(isExiled: (userId: string, guild: string | null) => boolean, now = Date.now()): void {
    for (const [sid, p] of this.players) {
      const jailed = p.forceJail || (!p.user.guest && isExiled(p.user.id, p.guild));
      if (jailed === p.info.jailed) continue;
      if (jailed && this.tank.driver === sid) this.exitTank(sid);
      if (jailed && p.info.car) this.setCar(sid, null);
      // Yolcuysa da iner (yoksa istemci onu sürücünün yanında tutar: zindandan kaçar)
      if (jailed && p.info.ride) this.ride(sid, null);
      p.info.jailed = jailed;
      Object.assign(p.state, jailed ? JAIL_SPAWN : RELEASE_SPAWN);
      p.state.flags = 0;
      p.sampledAt = sampleTime(0, p.sampledAt, now);
      p.lastUpdate = now;
      const { x, z, rot } = p.state;
      this.broadcast({ t: "jail", sid, jailed, x, z, rot, at: p.sampledAt });
      this.dirty = TRAIL_TICKS;
    }
  }

  /**
   * Sunucunun belirlediği yere koyar (savaşta doğma); sonraki hız kontrolü buradan başlar.
   * Işınlanmanın zamanını döndürür (istemciye duyurulur: daha eski konum örnekleri yok sayılsın).
   */
  teleport(sid: number, x: number, z: number, rot: number, now = Date.now()): number {
    const p = this.players.get(sid);
    if (!p) return 0;
    // Yolcu başka yere taşındı (hastane, savaş): yolculuk biter, yoksa istemci onu arabada tutar
    if (p.info.ride) this.ride(sid, null);
    Object.assign(p.state, { x, z, rot });
    p.sampledAt = sampleTime(0, p.sampledAt, now);
    p.lastUpdate = now;
    this.dirty = TRAIL_TICKS;
    return p.sampledAt;
  }

  /**
   * Kaldığı yerden başla: tarayıcının sakladığı son konum (oyuna yeniden girince) ya da yeniden bağlanınca
   * bulunduğu yer. Girişten sonra bir kez ve RESUME_MS içinde; yalnızca dünyanın içinde (ışınlanılan odalar,
   * sürgün, izleyici ve savaş odası hariç). Kabul edilirse herkese duyurulur. Yoksa oyuncu doğuş noktasında kalır.
   */
  resume(sid: number, x: number, z: number, rot: number, now = Date.now()): boolean {
    const p = this.players.get(sid);
    if (!p || p.resumed || now - p.joinedAt > RESUME_MS || p.info.jailed || p.info.spectator || this.battle) return false;
    if (![x, z, rot].every(Number.isFinite) || outsideWorld(x, z) > 0 || inStadium(x, z) || inVolley(x, z) || inPbField(x, z)) return false;
    p.resumed = true;
    this.moveTo(sid, x, z, rot, now);
    return true;
  }

  /** Sunucunun belirlediği yere taşır ve herkese duyurur (stadyuma giriş/çıkış). */
  moveTo(sid: number, x: number, z: number, rot: number, now = Date.now()): void {
    const at = this.teleport(sid, x, z, rot, now);
    if (at) this.broadcast({ t: "tp", sid, x, z, rot, at });
  }

  private tankEvent(): ServerEvent {
    const { driver, x, z, h, tr, el } = this.tank;
    return { t: "tank", driver, x, z, h, tr, el };
  }

  /** Tanka binme: yakında, boşta, izleyici ya da sürgünde değilse. Başarılıysa true. */
  enterTank(sid: number): boolean {
    const p = this.players.get(sid);
    const t = this.tank;
    if (!p || p.info.spectator || p.info.jailed || t.driver) return false;
    if (Math.hypot(p.state.x - t.x, p.state.z - t.z) > TANK_REACH + 0.5) return false;
    if (p.info.car) this.setCar(sid, null);
    t.driver = sid;
    // Sürücü tankın yerine geçer; sonraki konumları tankı taşır.
    p.state.x = t.x;
    p.state.z = t.z;
    this.broadcast(this.tankEvent());
    this.dirty = TRAIL_TICKS;
    return true;
  }

  /** İniş (ya da sürücü ayrıldı/sürgüne gitti): tank son konumunda park eder. */
  exitTank(sid: number, now = Date.now()): void {
    const p = this.players.get(sid);
    const t = this.tank;
    if (t.driver !== sid) return;
    t.driver = 0;
    t.idleSince = now;
    if (p) {
      t.x = p.state.x;
      t.z = p.state.z;
      p.state.flags &= ~FLAG_DRIVING;
    }
    this.broadcast(this.tankEvent());
  }

  aimTank(sid: number, h: number, tr: number, el = DEFAULT_ELEV): void {
    if (this.tank.driver !== sid || !Number.isFinite(h) || !Number.isFinite(tr)) return;
    this.tank.h = h;
    this.tank.tr = tr;
    this.tank.el = clampElev(el);
    this.broadcast({ t: "taim", h, tr, el: this.tank.el }, sid);
  }

  /**
   * Sürücü ateş etti: atışı hesaplar ve herkese yollar (bekleme süresi dolmadıysa yok sayılır).
   * `aim`: atış anındaki gövde/kule açısı; son "taim" gecikmiş ya da düşmüş olabilir.
   */
  fire(sid: number, aim?: { h: number; tr: number; el?: number }, now = Date.now()): void {
    const t = this.tank;
    const p = this.players.get(sid);
    if (t.driver !== sid || !p || now - t.lastFire < FIRE_COOLDOWN_MS) return;
    t.lastFire = now;
    if (aim && Number.isFinite(aim.h) && Number.isFinite(aim.tr)) {
      t.h = aim.h;
      t.tr = aim.tr;
      if (aim.el !== undefined) t.el = clampElev(aim.el);
    }
    const targets = [...this.players]
      .filter(([s, q]) => s !== sid && !q.info.spectator)
      .map(([s, q]) => ({ sid: s, x: q.state.x, z: q.state.z }));
    const { shot, hits } = computeShot(p.state.x, p.state.z, t.tr, targets, t.el);
    this.broadcast({ t: "shell", sid, shot, hits });
    if (hits.length) this.onReport(sid, "tank_hit", hits.length);
  }

  /** Değişiklik varsa (ya da her saniye) tüm aktif oyuncuların konumunu yayınlar. */
  tick(now: number, force = false): void {
    this.battle?.tick(now);
    this.games?.tick(now);
    this.ring?.tick(now);
    this.live?.tick(now);
    this.life?.tick(now);
    this.jobs?.tick(now);
    const t = this.tank;
    if (!t.driver && t.idleSince && now - t.idleSince > TANK_RETURN_MS) {
      Object.assign(t, { x: TANK_PARK.x, z: TANK_PARK.z, h: TANK_PARK.h, tr: TANK_PARK.h, el: DEFAULT_ELEV, idleSince: 0 });
      this.broadcast(this.tankEvent());
    }
    if (!this.dirty && !force) return;
    if (this.dirty) this.dirty--;
    let count = 0;
    for (const p of this.players.values()) if (!p.info.spectator) count++;
    const buf = new Uint8Array(snapshotSize(count));
    const view = new DataView(buf.buffer);
    // Tam ms: zaman − yaş, örnek zamanını birebir verir
    const at = Math.round(now);
    writeSnapshotHeader(view, at, count);
    let i = 0;
    for (const [sid, p] of this.players) {
      if (!p.info.spectator) writeSnapshotEntry(view, i++, sid, p.state, at - p.sampledAt);
    }
    for (const p of this.players.values()) {
      if (p.conn.sendFast?.(buf)) continue;
      if (p.conn.bufferedAmount < MAX_BUFFERED) p.conn.send(buf);
    }
  }

  /** Her bağlantıyı oyuncunun sunucusuyla gezer (sunucu bazlı yayınlar için). */
  each(fn: (conn: Conn, guild: string | null) => void): void {
    for (const p of this.players.values()) fn(p.conn, p.guild);
  }

  sendTo(conn: Conn, ev: ServerEvent): void {
    conn.send(JSON.stringify(ev));
  }

  broadcast(ev: ServerEvent, exceptSid?: number): void {
    const msg = JSON.stringify(ev);
    for (const [sid, p] of this.players) if (sid !== exceptSid) p.conn.send(msg);
  }

  summary() {
    return {
      room: this.key,
      players: [...this.players.values()].map((p) => ({
        id: p.info.id,
        name: p.info.name,
        spectator: p.info.spectator,
        jailed: p.info.jailed,
        since: p.joinedAt,
      })),
    };
  }
}

export interface JoinOptions {
  guild?: string | null;
  jailed?: boolean;
  forceJail?: boolean;
}

export class Rooms {
  private rooms = new Map<string, Room>();
  /** Yeni oda açılınca (sunucu oyunları ve raporlamayı bağlar). */
  onCreate: (room: Room) => void = () => {};

  get(key: string): Room {
    let r = this.rooms.get(key);
    if (!r) {
      r = new Room(key);
      this.rooms.set(key, r);
      this.onCreate(r);
    }
    return r;
  }

  find(key: string): Room | undefined {
    return this.rooms.get(key);
  }

  release(room: Room): void {
    if (room.size === 0) this.rooms.delete(room.key);
  }

  all(): Iterable<Room> {
    return this.rooms.values();
  }
}
