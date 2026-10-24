// Yerel oyuncu: anında tepki veren hareket (sunucuyu beklemez), oturma ve 3. şahıs kamera.
import * as THREE from "three";
import {
  clampToJail,
  FLAG_DRIVING,
  FLAG_RUNNING,
  FLAG_SEATED,
  FLAG_WALKING,
  JUMP_MASK,
  JUMP_SHIFT,
  JUMP_TIME,
  jumpHeight,
  jumpTime,
  PLAYER_RADIUS,
  RUN_MULTIPLIER,
  type Vehicle,
  VEHICLE_SHIFT,
  VEHICLES,
  STEP_UP,
  WALK_SPEED,
} from "../../shared/constants";
import { BOAT_R, POND_AREA, STAGE, STAGE_AREA } from "../../shared/zones";
import type { Look, PlayerState } from "../../shared/protocol";
import { settings } from "./settings";
import {
  DEFAULT_ELEV,
  ELEV_TURN,
  GUN_LEN,
  GUN_PIVOT_Z,
  HULL_TOP,
  hullCircles,
  MUZZLE_Y,
  solveElev,
  TANK_HULL_R,
  TANK_REVERSE,
  TANK_SPEED,
  TANK_TURN,
  tankGround,
  TURRET_R,
  TURRET_TOP,
  TURRET_TURN,
} from "../../shared/tank";
import { CAR_ACCEL, CAR_BRAKE, CAR_HULL_R, CAR_REVERSE, CAR_SPEED, CAR_TURN, carCircles } from "../../shared/car";
import type { AvatarView } from "./avatars/avatars";
import type { Input } from "./input/input";
import { LEDGE } from "./world/colliders";
import { SEAT_H } from "./world/builder";
import type { Room } from "./world/city";
import type { Seat, World } from "./world/scene";

const SEAT_REACH = 1.3;
const TAU = Math.PI * 2;

function angleDiff(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

function dampAngle(a: number, b: number, k: number): number {
  return a + angleDiff(a, b) * k;
}

/** Tank kamerası: tankın üstünden bakar; eğim negatife inebilir (gökyüzüne nişan = en uzak atış). */
const TANK_CAM_Y = 3.2;
const TANK_CAM_DIST = 9;
const TANK_PITCH_MIN = -0.15;
const TANK_PITCH_MAX = 1.0;
/** Nişan noktası tanka bundan yakınsa kule kameranın yönünü izler (altındaki noktaya kilitlenmesin). */
const AIM_MIN_DIST = 4;

/** Savrulma: kontrol bu kadar süre elden gider, hız yavaşça söner. */
const KNOCK_TIME = 0.8;
/** Shift lock'ta kameranın sağa kayması (m). */
const SHOULDER = 0.7;
/** Kenardan düşerken yerçekimi (zıplama eğrisinin inişi kadar yumuşak). */
const FALL_G = 12;

/** `p`yi (x, z) merkezli r yarıçaplı dairenin dışına iter. */
function pushOut(p: { x: number; z: number }, x: number, z: number, r: number): void {
  const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz);
  if (d >= r) return;
  if (d < 1e-4) p.x += r;
  else {
    p.x = x + (dx / d) * r;
    p.z = z + (dz / d) * r;
  }
}

export class Player implements AvatarView, PlayerState {
  x: number;
  z: number;
  rot: number;
  flags = 0;
  alpha = 1;
  cell = -1;
  phase = 0;
  emote = -1;
  emoteAt = 0;
  /** Altındaki yüzeyin yüksekliği (yer 0; çeşme, bank, tank…). */
  baseY = 0;
  /** Bu yüzeyin üstündeki yükseklik (zıplarken, düşerken). */
  jumpY = 0;
  pair: AvatarView["pair"] = null;
  slide: number | null = null;
  trick: { at: number; side: -1 | 1 } | null = null;
  vpose: AvatarView["vpose"] = null;
  /** Voleybol salonunda: yüksek zıplama, havada momentum korunur; A/D yana, W/S öne/geri yatırır. */
  volley = false;
  /** Havadaki yatış yönü (yana: -1 sol, 1 sağ; öne: 1 W, -1 S) ve çizimde yumuşatılmış halleri. */
  leanDir = 0;
  pitchDir = 0;
  vlean = 0;
  vpitch = 0;
  vstance: AvatarView["vstance"] = null;
  mic = false;
  grip = false;
  hideName = false;
  hidden = false;
  /** Zıplamanın başından geçen süre; yerdeyken JUMP_TIME. */
  private jumpT = JUMP_TIME;
  /** Bu zıplama voleybol zıplaması mı (süre ve yükseklik). */
  private bigJump = false;
  private jumpSeq = 0;
  /** Ayakların yüksekliği; zıplama eğrisi `launchY`den başlar, eğri bitince serbest düşüş `vy` ile. */
  private elev = 0;
  private launchY = 0;
  private vy = 0;
  /** Tankın üstünde duruyor: tank kayınca birlikte kayar. */
  private onTank = false;
  private lastTank: [number, number] | null = null;
  color: THREE.Color;
  /** Oturma menzilindeki koltuk (UI ipucu için), yoksa null. */
  nearSeat: Seat | null = null;
  /** Sürgünde: zindan hücresinden çıkamaz. */
  jailed = false;
  /** Chibi kıyafeti (gardıropta önizleme de buraya yazılır); null: varsayılan karakter. */
  outfit: Look | null = null;
  /** Tankı sürüyorsa gövde/kule/namlu açısı ve hız; konumu x/z'dir. */
  driving: { h: number; tr: number; el: number; v: number } | null = null;
  /** Masaya yaklaşma: kamera bu bakışa yumuşakça geçer (null: normal kamera). */
  focusView: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;
  private focusBlend = 0;
  private focusLast: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;
  private focusLook = new THREE.Vector3();
  /** Fareyle en son bakıştan beri geçen süre (sn). */
  private lookIdle = 0;
  /** Arabayla bir yere sertçe çarptı: çarpma anındaki hız (m/sn). */
  onCrash: ((speed: number) => void) | null = null;
  /** Tofaşla gidiyorsa hızı (m/sn, geri vitesteyse eksi); konumu x/z, yönü rot. */
  car: { v: number } | null = null;
  /** Yarış gridinde (yeşil yanana kadar): gaz/geri tutmaz, araba yerinde durur. */
  carLock = false;
  /** Kendi avatarını gizle (tuning ekranında araba vitrinde, sürücü görünmez). */
  hideAvatar = false;
  /** Başkasının arabasında yolcu: konum ve yön sürücünün arabası (her kare dışarıdan verilir); yürünmez. */
  riding: { x: number; z: number; rot: number } | null = null;
  /** İçinde bulunduğu dükkân (kamera odanın içinde kalır); main.ts her kare günceller. */
  room: Room | null = null;
  /** Sürerken Space'e basıldı (main.ts sunucuya ateş yollar). */
  wantsFire = false;
  /** Tankta: ekranın ortasındaki nişangâhın baktığı nokta (main.ts kameradan hesaplar). */
  aimAt: { x: number; y: number; z: number } | null = null;
  /** Kule ve namlu nişan noktasına oturdu mu (nişangâh soluk/parlak). */
  aimReady = false;
  /** Sürerken çarpılan diğer tankların merkezleri (x, z, x, z, …); savaşta her kare güncellenir. */
  otherTanks: number[] = [];
  /** Yürürken içinden geçilemeyen tank (gövde daireleri); main.ts her kare günceller. */
  obstacle: [number, number, number, number] | null = null;
  private knockT = 0;
  /** Araç: 0 yaya, 1 bisiklet, 2 kaykay, 3 kayık. */
  vehicle: Vehicle = 0;
  /** Bisiklet/kaykayla gidilen yol (m): görev için ara ara sunucuya bildirilir. */
  rideMeters = 0;
  /** Hız çarpanı (topla koşarken biraz yavaş: top sürmek bedava değil). */
  speedMul = 1;
  /** Sahnede (karaoke): sahne alanında kalır, sahne yüksekliğinde çizilir. */
  onStage = false;
  /** Fotoğraf modunda kamera daha uzağa açılır. */
  photo = false;

  get lift(): number {
    return this.onStage ? STAGE.h : 0;
  }

  /** Oturulan koltuğun masası (kahvehane), yoksa null. */
  get seatTable(): { id: number; seat: number } | null {
    return this.seat?.table ?? null;
  }

  private vx = 0;
  private vz = 0;
  private seat: Seat | null = null;
  private standX = 0;
  private standZ = 0;
  private standY = 0;

  private yaw = 0;
  private pitch = 0.42;
  private dist = 6.5;
  private target = new THREE.Vector3();
  private look = { x: 0, y: 0 };
  /** Shift lock omuz kamerası: 0 = ortada, 1 = sağ omuzda. */
  private shoulder = 0;
  private lookAt = new THREE.Vector3();

  constructor(
    private world: World,
    color: THREE.Color,
  ) {
    this.x = world.spawn.x;
    this.z = world.spawn.z;
    this.rot = world.spawn.rot;
    this.color = color;
    this.target.set(this.x, 1.4, this.z);
  }

  get seated(): boolean {
    return this.seat !== null;
  }

  update(dt: number, input: Input): void {
    input.consumeLook(this.look);
    // Fareyle bakılmayan süre (arabada kamera ancak bundan sonra arkaya döner)
    this.lookIdle = this.look.x !== 0 || this.look.y !== 0 ? 0 : this.lookIdle + dt;
    const sens = settings.sensitivity;
    const lookY = this.look.y * 0.004 * sens * (settings.invertY ? -1 : 1);
    this.yaw -= this.look.x * 0.006 * sens;
    const fp = settings.firstPerson && !this.driving && !this.car && !this.photo;
    this.pitch = this.driving
      ? THREE.MathUtils.clamp(this.pitch + lookY, TANK_PITCH_MIN, TANK_PITCH_MAX)
      : this.car
      ? THREE.MathUtils.clamp(this.pitch + lookY, 0.05, 0.9)
      : THREE.MathUtils.clamp(this.pitch + lookY, fp ? -1.2 : this.photo ? -0.3 : 0.05, fp ? 1.2 : 1.35);
    this.dist = THREE.MathUtils.clamp(this.dist + input.consumeZoom() * 0.6, 2.5, this.photo ? 30 : 12);
    const lockOn = input.shiftLock && !this.driving && !this.seat && !this.vehicle;
    this.shoulder += ((lockOn ? 1 : 0) - this.shoulder) * (1 - Math.exp(-dt * 10));

    if (this.driving) {
      this.drive(dt, input);
      return;
    }
    if (this.car) {
      this.driveCar(dt, input);
      return;
    }

    if (this.riding) {
      input.consumeAction();
      input.consumeJump();
      this.x = this.riding.x;
      this.z = this.riding.z;
      this.rot = this.riding.rot;
      this.vx = this.vz = 0;
      this.flags = FLAG_SEATED;
      return;
    }

    const action = input.consumeAction();
    let jump = input.consumeJump();
    const moving = Math.abs(input.moveX) > 0.15 || Math.abs(input.moveY) > 0.15;

    if (this.seat) {
      if (action || moving || jump) this.standUp();
      else return;
      jump = false; // kalkarken zıplama
    }

    // Zıplama: ortak eğri (jumpHeight) bulunduğu yüzeyden; uzak istemciler aynı yayı sayaçtan çizer. Kayıkta zıplanmaz.
    if (jump && this.jumpT >= this.jumpDur && this.vy === 0 && this.vehicle !== 3) this.startJump();
    this.rideTank();

    // Kameraya göre hareket yönü: ileri = kameranın baktığı yatay yön.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const mx = -sy * input.moveY + cy * input.moveX;
    const mz = -cy * input.moveY - sy * input.moveX;
    const air = this.jumpT < this.jumpDur || this.elev > this.baseY + 0.02;
    this.leanDir = this.volley && air ? Math.sign(Math.round(input.moveX)) : 0;
    this.pitchDir = this.volley && air ? Math.sign(Math.round(input.moveY)) : 0;
    const lk = 1 - Math.exp(-dt * 12);
    this.vlean += (this.leanDir - this.vlean) * lk;
    this.vpitch += (this.pitchDir - this.vpitch) * lk;
    if (this.volley && air && this.knockT <= 0) {
      // Voleybol: zıplarken momentum korunur (koşarak zıplayan ileri süzülür); tuşlar yalnızca gövdeyi yatırır
      const f = Math.exp(-dt * 1.6);
      this.vx *= f;
      this.vz *= f;
    } else if (this.knockT > 0) {
      // Savrulurken kontrol yok: hız yavaşça söner
      this.knockT -= dt;
      const f = Math.exp(-dt * 2.5);
      this.vx *= f;
      this.vz *= f;
    } else {
      // Araçta koşma yok: hız aracın; bisiklet ve kaykay yavaş hızlanır, kayık ağır
      const accel = 1 - Math.exp(-dt * (this.vehicle ? (this.vehicle === 3 ? 1.5 : 3.5) : 12));
      const speedMax = WALK_SPEED * (this.vehicle ? VEHICLES[this.vehicle].speed : input.run ? RUN_MULTIPLIER : 1) * this.speedMul;
      this.vx += (mx * speedMax - this.vx) * accel;
      this.vz += (mz * speedMax - this.vz) * accel;
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.fly(dt);
    if (this.vehicle === 3) {
      // Kayık yalnızca gölde: kıyıya değince durur
      const dx = this.x - POND_AREA.x, dz = this.z - POND_AREA.z, d = Math.hypot(dx, dz);
      if (d > BOAT_R) {
        this.x = POND_AREA.x + (dx / d) * BOAT_R;
        this.z = POND_AREA.z + (dz / d) * BOAT_R;
      }
    } else if (this.onStage) {
      // Sahnede: sahne alanında kalır (sahnenin çarpışma duvarı uygulanmaz); öne yürüyen sahneden iner
      this.x = THREE.MathUtils.clamp(this.x, STAGE_AREA.minX, STAGE_AREA.maxX);
      if (this.z > STAGE_AREA.maxZ + 0.3) this.setStage(false);
      else this.z = Math.max(this.z, STAGE_AREA.minZ);
    } else this.world.colliders.resolve(this, PLAYER_RADIUS, this.elev);
    const o = this.obstacle;
    if (o && this.elev + STEP_UP < HULL_TOP) {
      pushOut(this, o[0], o[1], TANK_HULL_R + PLAYER_RADIUS);
      pushOut(this, o[2], o[3], TANK_HULL_R + PLAYER_RADIUS);
    } else if (o && this.elev + STEP_UP < TURRET_TOP) {
      pushOut(this, (o[0] + o[2]) / 2, (o[1] + o[3]) / 2, TURRET_R + PLAYER_RADIUS);
    }
    if (this.jailed) clampToJail(this);
    this.land();

    const speed = Math.hypot(this.vx, this.vz);
    // Shift lock: karakter hep kameranın baktığı yöne döner (yana/geri yürürken de)
    if (lockOn) this.rot = dampAngle(this.rot, this.yaw + Math.PI, 1 - Math.exp(-dt * 20));
    else if (speed > 0.3) this.rot = dampAngle(this.rot, Math.atan2(this.vx, this.vz), 1 - Math.exp(-dt * (this.vehicle ? 5 : 12)));
    if (this.vehicle === 1 || this.vehicle === 2) this.rideMeters += speed * dt;
    this.flags =
      (speed > 0.6 ? FLAG_WALKING : 0) |
      (!this.vehicle && speed > WALK_SPEED * 1.15 ? FLAG_RUNNING : 0) |
      this.jumpBits() |
      (this.vehicle << VEHICLE_SHIFT);

    this.nearSeat = this.vehicle ? null : this.findSeat();
    if (action && this.nearSeat) this.sitOn(this.nearSeat);
  }

  /** Oturduğu tabure bir casino oyununa aitse oyunu. */
  get seatGame(): Seat["game"] | null {
    return this.seat?.game ?? null;
  }

  /** Dışarıdan kaldırma (ör. tabureye başkası oturdu). */
  standUpNow(): void {
    if (this.seat) this.standUp();
  }

  /** Araca bin/in. Kayık iskelede binilir ve gölün içine konur; inince iskeleye çıkılır. */
  setVehicle(v: Vehicle, dock?: { x: number; z: number }): void {
    if (this.driving || this.jailed) return;
    if (this.seat) this.standUp();
    if (this.vehicle === 3 && v !== 3 && dock) {
      this.x = dock.x;
      this.z = dock.z;
    }
    if (v === 3) {
      this.x = POND_AREA.x - BOAT_R + 0.6;
      this.z = POND_AREA.z;
      this.rot = Math.PI / 2;
    }
    this.vehicle = v;
    this.vx = this.vz = 0;
    if (v && this.onStage) this.setStage(false);
    this.flags = (this.flags & ~(3 << VEHICLE_SHIFT)) | (v << VEHICLE_SHIFT);
  }

  /** Sahneye çık (karaoke) ya da in. */
  setStage(on: boolean): void {
    this.onStage = on;
    if (on) {
      this.setVehicle(0);
      this.x = 0;
      this.z = STAGE_AREA.maxZ - 0.4;
      this.rot = 0;
      this.yaw = Math.PI;
    } else if (this.z < STAGE_AREA.maxZ + 1) {
      this.z = STAGE_AREA.maxZ + 2.2;
    }
  }

  /** Ayaklar altındaki yüzeyin (yer, engel üstü, tank) yüksekliği; `y`: ayak yüksekliği. */
  private groundAt(y: number): number {
    const g = this.world.colliders.groundAt(this.x, this.z, PLAYER_RADIUS, y);
    const o = this.obstacle;
    return o ? Math.max(g, tankGround(o, this.x, this.z, PLAYER_RADIUS * LEDGE, y)) : g;
  }

  private get jumpDur(): number {
    return jumpTime(this.bigJump);
  }

  private startJump(): void {
    this.jumpT = 0;
    this.bigJump = this.volley;
    this.jumpSeq = (this.jumpSeq + 1) & 3;
    this.launchY = this.elev;
  }

  /** Havadaysa: önce zıplama eğrisi, bittiyse (ya da kenardan yürüyüp çıktıysa) serbest düşüş. */
  private fly(dt: number): void {
    if (this.jumpT < this.jumpDur) {
      const prev = this.elev;
      this.jumpT = Math.min(this.jumpDur, this.jumpT + dt);
      this.elev = this.launchY + jumpHeight(this.jumpT, this.bigJump);
      this.vy = this.jumpT < this.jumpDur ? (this.elev - prev) / Math.max(dt, 1e-4) : Math.min(this.vy, 0);
    } else if (this.elev > this.baseY || this.vy !== 0) {
      this.vy -= FALL_G * dt;
      this.elev += this.vy * dt;
    }
  }

  /** İnerken bir yüzeye değdiyse oraya konar; basamak kadar yüksek bir yüzeye yürüyerek çıkar. */
  private land(): void {
    const g = this.groundAt(this.elev);
    const falling = this.jumpT >= this.jumpDur || this.vy <= 0;
    if (this.elev <= g && falling) {
      this.elev = g;
      this.vy = 0;
      this.jumpT = this.jumpDur;
    }
    this.baseY = g;
    this.jumpY = Math.max(0, this.elev - g);
    this.onTank = !!this.obstacle && this.jumpY === 0 && g > 0 && g === tankGround(this.obstacle, this.x, this.z, PLAYER_RADIUS * LEDGE, this.elev);
  }

  /** Üstünde durduğu tank kaydıysa birlikte kayar (main.ts `obstacle`ı her kare tanktan günceller). */
  private rideTank(): void {
    const o = this.obstacle;
    const mid: [number, number] | null = o ? [(o[0] + o[2]) / 2, (o[1] + o[3]) / 2] : null;
    if (this.onTank && mid && this.lastTank) {
      this.x += mid[0] - this.lastTank[0];
      this.z += mid[1] - this.lastTank[1];
    }
    this.lastTank = mid;
  }

  /** Tankı sür: gövde (x, z, h), kule tr. Kamera tankın arkasına geçer. */
  enterTank(x: number, z: number, h: number, tr: number, el = DEFAULT_ELEV): void {
    this.seat = null;
    this.vehicle = 0;
    this.onStage = false;
    this.knockT = 0;
    this.resetHeight();
    this.vx = this.vz = 0;
    this.driving = { h, tr, el, v: 0 };
    this.pitch = 0.2; // ufka yakın: nişan tankın 15–20 m önüne düşer
    this.x = x;
    this.z = z;
    this.rot = h;
    this.yaw = tr + Math.PI;
    this.target.set(x, TANK_CAM_Y, z);
  }

  /** Tofaşa bin: araba olduğu yerde, oyuncunun baktığı yöne doğru belirir. */
  enterCar(): void {
    this.seat = null;
    this.vehicle = 0;
    this.onStage = false;
    this.knockT = 0;
    this.resetHeight();
    this.vx = this.vz = 0;
    this.car = { v: 0 };
    this.flags = (this.flags & ~(3 << VEHICLE_SHIFT)) & ~(FLAG_WALKING | FLAG_RUNNING);
    this.yaw = this.rot + Math.PI;
  }

  /** Park halindeki arabaya bin: oyuncu arabanın yerine geçer. */
  enterCarAt(x: number, z: number, rot: number): void {
    this.x = x;
    this.z = z;
    this.rot = rot;
    this.enterCar();
  }

  /** Arabayı bir yere koy (yarış grid kutusu): durur, kamera arkasına geçer. */
  placeCar(x: number, z: number, rot: number): void {
    if (!this.car) return;
    this.x = x;
    this.z = z;
    this.rot = rot;
    this.car.v = 0;
    this.yaw = rot + Math.PI;
  }

  /** Tofaştan in: sürücü kapısından (sol) çıkar; araba kaybolur. */
  exitCar(): void {
    if (!this.car) return;
    this.car = null;
    this.x += Math.cos(this.rot) * 1.6;
    this.z -= Math.sin(this.rot) * 1.6;
    this.world.colliders.resolve(this, PLAYER_RADIUS);
    this.resetHeight();
    this.flags = this.jumpBits();
  }

  /** Sürüş: W gaz, S fren/geri, A/D direksiyon (hızla artar), Shift biraz daha hızlı; duvara çarpınca yavaşlar. */
  private driveCar(dt: number, input: Input): void {
    const c = this.car!;
    input.consumeAction();
    input.consumeJump();
    const top = CAR_SPEED * (input.run ? 1.15 : 1);
    if (this.carLock) c.v = 0;
    else if (input.moveY > 0.1) c.v += (c.v < -0.2 ? CAR_BRAKE : CAR_ACCEL * Math.max(0.15, 1 - c.v / top)) * input.moveY * dt;
    else if (input.moveY < -0.1) c.v -= (c.v > 0.2 ? CAR_BRAKE : CAR_ACCEL * 0.6) * -input.moveY * dt;
    else c.v *= Math.exp(-dt * 0.45);
    c.v = THREE.MathUtils.clamp(c.v, -CAR_REVERSE, top);
    if (Math.abs(c.v) < 0.03 && Math.abs(input.moveY) < 0.1) c.v = 0;
    const grip = Math.min(1, Math.abs(c.v) / 4) * (1 - Math.min(0.35, Math.abs(c.v) / 60));
    this.rot -= input.moveX * CAR_TURN * grip * Math.sign(c.v) * dt;
    this.x += Math.sin(this.rot) * c.v * dt;
    this.z += Math.cos(this.rot) * c.v * dt;
    // Gövdenin ön ve arka dairesini engellerden (ve yalnızca arabayı durduran kapılardan) çıkar
    const [fx, fz, bx, bz] = carCircles(this.x, this.z, this.rot);
    const f = { x: fx, z: fz }, b = { x: bx, z: bz };
    for (const p of [f, b]) {
      this.world.colliders.resolve(p, CAR_HULL_R);
      this.world.carColliders.resolve(p, CAR_HULL_R);
    }
    const ox = (f.x - fx + b.x - bx) / 2, oz = (f.z - fz + b.z - bz) / 2;
    this.x += ox;
    this.z += oz;
    const hit = Math.hypot(ox, oz);
    if (hit > 0.08 && Math.abs(c.v) > 2.5) this.onCrash?.(Math.abs(c.v));
    if (hit > 0.01) c.v *= hit > 0.08 ? 0.35 : 0.85;
    // Kamera serbest: fareyle çevrilir; fare 1,5 sn bırakılınca ve araba giderken yavaşça arkaya döner
    if (this.lookIdle > 1.5 && Math.abs(c.v) > 1) {
      const ease = Math.min(1, (this.lookIdle - 1.5) / 1.2);
      this.yaw = dampAngle(this.yaw, this.rot + Math.PI, 1 - Math.exp(-dt * 2.2 * ease));
    }
    this.elev = this.baseY = this.jumpY = 0;
    this.flags = this.jumpBits();
    this.nearSeat = null;
  }

  /** Tanktan in: gövdenin soluna çıkar (orası kapalıysa çarpışma iter). */
  exitTank(): void {
    const d = this.driving;
    if (!d) return;
    this.driving = null;
    this.wantsFire = false;
    this.x += Math.cos(d.h) * 2.4;
    this.z -= Math.sin(d.h) * 2.4;
    this.world.colliders.resolve(this, PLAYER_RADIUS);
    this.resetHeight();
    this.rot = d.h;
    this.flags = this.jumpBits();
  }

  /** Futbol: `t` sn kontrolsüz sürat (çalımda öne atılma, kayarak müdahale); hız yavaşça söner. */
  dash(vx: number, vz: number, t: number): void {
    if (this.driving || this.seat || this.vehicle) return;
    this.vx = vx;
    this.vz = vz;
    this.knockT = t;
  }

  /** Mermi savurdu: (vx, vz) hızıyla fırlar ve zıplar. Tanktaysa etkilenmez. */
  knock(vx: number, vz: number): void {
    if (this.driving) return;
    if (this.seat) this.standUp();
    this.vx = vx;
    this.vz = vz;
    this.knockT = KNOCK_TIME;
    if (this.jumpT >= this.jumpDur) this.startJump();
  }

  /** Sürüş: W/S gaz-geri, A/D gövdeyi döndürür; kule kameranın baktığı yöne döner. */
  private drive(dt: number, input: Input): void {
    const d = this.driving!;
    input.consumeAction();
    if (input.consumeJump()) this.wantsFire = true;
    const target = input.moveY * (input.moveY > 0 ? TANK_SPEED : TANK_REVERSE);
    d.v += (target - d.v) * (1 - Math.exp(-dt * 2.2));
    d.h -= input.moveX * TANK_TURN * dt;
    this.x += Math.sin(d.h) * d.v * dt;
    this.z += Math.cos(d.h) * d.v * dt;
    // Gövdenin ön ve arka dairesini ayrı ayrı engellerden çıkar, ortalama itmeyi uygula
    const [fx, fz, bx, bz] = hullCircles(this.x, this.z, d.h);
    const f = { x: fx, z: fz }, b = { x: bx, z: bz };
    this.world.colliders.resolve(f, TANK_HULL_R);
    this.world.colliders.resolve(b, TANK_HULL_R);
    const o = this.otherTanks;
    for (let i = 0; i < o.length; i += 2) {
      pushOut(f, o[i], o[i + 1], TANK_HULL_R * 2);
      pushOut(b, o[i], o[i + 1], TANK_HULL_R * 2);
    }
    const ox = (f.x - fx + b.x - bx) / 2, oz = (f.z - fz + b.z - bz) / 2;
    this.x += ox;
    this.z += oz;
    if (Math.hypot(ox, oz) > 0.01) d.v *= 0.85; // sürtünerek yavaşla
    // GTA gibi: kule nişangâhın baktığı noktaya döner, namlu mermiyi oraya düşürecek açıyı bulur
    let trT = this.yaw + Math.PI, elT = DEFAULT_ELEV;
    const a = this.aimAt;
    const aimDist = a ? Math.hypot(a.x - this.x, a.z - this.z) : 0;
    if (a && aimDist > AIM_MIN_DIST) {
      trT = Math.atan2(a.x - this.x, a.z - this.z);
      elT = solveElev(aimDist - GUN_PIVOT_Z - GUN_LEN, a.y - MUZZLE_Y);
    }
    const diff = angleDiff(d.tr, trT);
    d.tr += Math.sign(diff) * Math.min(Math.abs(diff), TURRET_TURN * dt);
    const elDiff = elT - d.el;
    d.el += Math.sign(elDiff) * Math.min(Math.abs(elDiff), ELEV_TURN * dt);
    this.aimReady = Math.abs(angleDiff(d.tr, trT)) < 0.02 && Math.abs(elT - d.el) < 0.005;
    this.rot = d.h;
    this.flags = FLAG_DRIVING | this.jumpBits();
    this.nearSeat = null;
  }

  /** Sunucunun belirlediği yere ışınlanır (zindana giriş/çıkış). */
  teleport(x: number, z: number, rot: number): void {
    this.driving = null;
    this.car = null;
    this.vehicle = 0;
    this.onStage = false;
    this.knockT = 0;
    this.seat = null;
    this.resetHeight();
    this.x = x;
    this.z = z;
    this.rot = rot;
    this.vx = this.vz = 0;
    this.flags = this.jumpBits();
    this.yaw = rot + Math.PI;
    this.target.set(x, 1.45, z);
  }

  private findSeat(): Seat | null {
    let best: Seat | null = null;
    let bestD = SEAT_REACH * SEAT_REACH;
    for (const s of this.world.seats) {
      const dx = s.x - this.x, dz = s.z - this.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** Sayaç her durumda korunur; sıfırlanırsa uzak istemciler sahte bir zıplama görür. */
  private jumpBits(): number {
    return (this.jumpSeq << JUMP_SHIFT) & JUMP_MASK;
  }

  private resetHeight(): void {
    this.elev = this.baseY = this.jumpY = this.vy = 0;
    this.jumpT = this.jumpDur;
    this.onTank = false;
  }

  private sitOn(s: Seat): void {
    this.standY = this.elev;
    this.resetHeight();
    // Oturma duruşu bank yüksekliğine göre: alçak koltukta (kütük) o kadar aşağı
    this.baseY = (s.h ?? SEAT_H) - SEAT_H;
    this.seat = s;
    this.standX = this.x;
    this.standZ = this.z;
    this.x = s.x;
    this.z = s.z;
    this.rot = s.rot;
    this.vx = this.vz = 0;
    this.flags = FLAG_SEATED | this.jumpBits();
    this.nearSeat = null;
    // Kamerayı perdeye doğru, oturanın arkasına çevir.
    this.yaw = s.rot + Math.PI;
  }

  private standUp(): void {
    this.seat = null;
    this.x = this.standX;
    this.z = this.standZ;
    this.elev = this.baseY = this.standY;
    this.flags = this.jumpBits();
  }

  /** Gardırop: kamera karakterin önüne, biraz yakına (kıyafet görünsün). */
  faceCamera(): void {
    this.yaw = this.rot;
    this.pitch = 0.18;
    this.dist = 4.2;
  }

  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const k = 1 - Math.exp(-dt * 14);
    if (settings.firstPerson && !this.driving && !this.car && !this.photo) {
      // Birinci şahıs: göz hizasından, bakış yönü kameranın açısı
      const eye = (this.seat ? 1.0 : 1.32) + this.baseY + this.jumpY + this.lift + (this.vehicle === 1 ? 0.3 : this.vehicle === 2 ? 0.14 : 0);
      this.target.set(this.x, eye, this.z);
      camera.position.copy(this.target);
      const cp = Math.cos(this.pitch);
      this.applyFocus(camera, this.focusLook.set(this.x - Math.sin(this.yaw) * cp, eye - Math.sin(this.pitch), this.z - Math.cos(this.yaw) * cp), dt);
      return;
    }
    // Zıplarken kamera yarısı kadar yükselir: sarsmadan takip eder.
    const ty = this.driving ? TANK_CAM_Y : this.car ? 1.8 : (this.seat ? 1.15 : 1.45) + this.baseY + this.jumpY * 0.5 + this.lift;
    this.target.x += (this.x - this.target.x) * k;
    this.target.y += (ty - this.target.y) * k;
    this.target.z += (this.z - this.target.z) * k;
    const cp = Math.cos(this.pitch);
    // Zindanda kamera duvarların ötesine çıkmasın: parmaklıklardan dışarı bakılır.
    const dist = this.jailed ? Math.min(this.dist, 3.4) : this.driving ? Math.max(this.dist, TANK_CAM_DIST) : this.car ? Math.max(this.dist, 7) : this.dist;
    // Shift lock'ta kamera sağ omza kayar: karakter ekranın ortasını kapatmaz
    const side = this.shoulder * SHOULDER;
    this.lookAt.set(this.target.x + Math.cos(this.yaw) * side, this.target.y, this.target.z - Math.sin(this.yaw) * side);
    camera.position.set(
      this.lookAt.x + Math.sin(this.yaw) * cp * dist,
      // Aşağıdan bakarken (fotoğraf modu) kamera zeminin altına inmesin
      Math.max(0.3, this.lookAt.y + Math.sin(this.pitch) * dist),
      this.lookAt.z + Math.cos(this.yaw) * cp * dist,
    );
    // Dükkânın içindeyse kamera odanın dışına (duvarın arkasına) ve tavanın üstüne çıkmaz
    const r = this.room;
    if (r && !this.car) {
      const p = camera.position, l = this.lookAt, m = 0.25;
      const lim = (from: number, to: number, lo: number, hi: number) => (to > hi ? (hi - from) / (to - from) : to < lo ? (lo - from) / (to - from) : 1);
      const t = Math.max(0, Math.min(lim(l.x, p.x, r.minX + m, r.maxX - m), lim(l.z, p.z, r.minZ + m, r.maxZ - m), lim(l.y, p.y, 0.3, r.ceil - m)));
      if (t < 1) p.set(l.x + (p.x - l.x) * t, l.y + (p.y - l.y) * t, l.z + (p.z - l.z) * t);
    }
    this.applyFocus(camera, this.focusLook.copy(this.lookAt), dt);
  }

  /** Normal kameradan masa bakışına (ve geri) yumuşak geçiş; `look` normal bakış noktası. */
  private applyFocus(camera: THREE.PerspectiveCamera, look: THREE.Vector3, dt: number): void {
    const f = this.focusView ?? this.focusLast;
    this.focusBlend = THREE.MathUtils.clamp(this.focusBlend + (this.focusView ? dt / 0.9 : -dt / 0.6), 0, 1);
    if (this.focusView) this.focusLast = this.focusView;
    if (f && this.focusBlend > 0) {
      const b = this.focusBlend, e = b * b * (3 - 2 * b);
      camera.position.lerp(f.pos, e);
      look.lerp(f.look, e);
    }
    camera.lookAt(look);
  }
}
