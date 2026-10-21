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
  PLAYER_RADIUS,
  RUN_MULTIPLIER,
  type Vehicle,
  VEHICLE_SHIFT,
  VEHICLES,
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
  hullCircles,
  MUZZLE_Y,
  solveElev,
  TANK_HULL_R,
  TANK_REVERSE,
  TANK_SPEED,
  TANK_TURN,
  TURRET_TURN,
} from "../../shared/tank";
import type { AvatarView } from "./avatars/avatars";
import type { Input } from "./input/input";
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
  /** Zemin üstü yükseklik (zıplarken). */
  jumpY = 0;
  pair: AvatarView["pair"] = null;
  mic = false;
  hideName = false;
  hidden = false;
  /** Zıplamanın başından geçen süre; yerdeyken JUMP_TIME. */
  private jumpT = JUMP_TIME;
  private jumpSeq = 0;
  color: THREE.Color;
  /** Oturma menzilindeki koltuk (UI ipucu için), yoksa null. */
  nearSeat: Seat | null = null;
  /** Sürgünde: zindan hücresinden çıkamaz. */
  jailed = false;
  /** Chibi kıyafeti (gardıropta önizleme de buraya yazılır); null: varsayılan karakter. */
  outfit: Look | null = null;
  /** Tankı sürüyorsa gövde/kule/namlu açısı ve hız; konumu x/z'dir. */
  driving: { h: number; tr: number; el: number; v: number } | null = null;
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

  private yaw = 0;
  private pitch = 0.42;
  private dist = 6.5;
  private target = new THREE.Vector3();
  private look = { x: 0, y: 0 };

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
    const sens = settings.sensitivity;
    const lookY = this.look.y * 0.004 * sens * (settings.invertY ? -1 : 1);
    this.yaw -= this.look.x * 0.006 * sens;
    const fp = settings.firstPerson && !this.driving && !this.photo;
    this.pitch = this.driving
      ? THREE.MathUtils.clamp(this.pitch + lookY, TANK_PITCH_MIN, TANK_PITCH_MAX)
      : THREE.MathUtils.clamp(this.pitch + lookY, fp ? -1.2 : this.photo ? -0.3 : 0.05, fp ? 1.2 : 1.35);
    this.dist = THREE.MathUtils.clamp(this.dist + input.consumeZoom() * 0.6, 2.5, this.photo ? 30 : 12);

    if (this.driving) {
      this.drive(dt, input);
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

    // Zıplama: ortak eğri (jumpHeight); uzak istemciler aynı yayı sayaçtan çizer. Kayıkta zıplanmaz.
    if (jump && this.jumpT >= JUMP_TIME && this.vehicle !== 3) {
      this.jumpT = 0;
      this.jumpSeq = (this.jumpSeq + 1) & 3;
    }
    if (this.jumpT < JUMP_TIME) {
      this.jumpT = Math.min(JUMP_TIME, this.jumpT + dt);
      this.jumpY = jumpHeight(this.jumpT);
    }

    // Kameraya göre hareket yönü: ileri = kameranın baktığı yatay yön.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const mx = -sy * input.moveY + cy * input.moveX;
    const mz = -cy * input.moveY - sy * input.moveX;
    if (this.knockT > 0) {
      // Savrulurken kontrol yok: hız yavaşça söner
      this.knockT -= dt;
      const f = Math.exp(-dt * 2.5);
      this.vx *= f;
      this.vz *= f;
    } else {
      // Araçta koşma yok: hız aracın; bisiklet ve kaykay yavaş hızlanır, kayık ağır
      const accel = 1 - Math.exp(-dt * (this.vehicle ? (this.vehicle === 3 ? 1.5 : 3.5) : 12));
      const speedMax = WALK_SPEED * (this.vehicle ? VEHICLES[this.vehicle].speed : input.run ? RUN_MULTIPLIER : 1);
      this.vx += (mx * speedMax - this.vx) * accel;
      this.vz += (mz * speedMax - this.vz) * accel;
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    if (this.vehicle === 3) {
      // Kayık yalnızca gölde: kıyıya değince durur
      const dx = this.x - POND_AREA.x, dz = this.z - POND_AREA.z, d = Math.hypot(dx, dz);
      if (d > BOAT_R) {
        this.x = POND_AREA.x + (dx / d) * BOAT_R;
        this.z = POND_AREA.z + (dz / d) * BOAT_R;
      }
    } else this.world.colliders.resolve(this, PLAYER_RADIUS);
    if (this.onStage) {
      this.x = THREE.MathUtils.clamp(this.x, STAGE_AREA.minX, STAGE_AREA.maxX);
      this.z = THREE.MathUtils.clamp(this.z, STAGE_AREA.minZ, STAGE_AREA.maxZ);
    }
    const o = this.obstacle;
    if (o) {
      pushOut(this, o[0], o[1], TANK_HULL_R + PLAYER_RADIUS);
      pushOut(this, o[2], o[3], TANK_HULL_R + PLAYER_RADIUS);
    }
    if (this.jailed) clampToJail(this);

    const speed = Math.hypot(this.vx, this.vz);
    if (speed > 0.3) this.rot = dampAngle(this.rot, Math.atan2(this.vx, this.vz), 1 - Math.exp(-dt * (this.vehicle ? 5 : 12)));
    if (this.vehicle === 1 || this.vehicle === 2) this.rideMeters += speed * dt;
    this.flags =
      (speed > 0.6 ? FLAG_WALKING : 0) |
      (!this.vehicle && speed > WALK_SPEED * 1.15 ? FLAG_RUNNING : 0) |
      this.jumpBits() |
      (this.vehicle << VEHICLE_SHIFT);

    this.nearSeat = this.vehicle ? null : this.findSeat();
    if (action && this.nearSeat) this.sitOn(this.nearSeat);
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
    if (v) this.onStage = false;
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

  /** Tankı sür: gövde (x, z, h), kule tr. Kamera tankın arkasına geçer. */
  enterTank(x: number, z: number, h: number, tr: number, el = DEFAULT_ELEV): void {
    this.seat = null;
    this.vehicle = 0;
    this.onStage = false;
    this.knockT = 0;
    this.jumpY = 0;
    this.jumpT = JUMP_TIME;
    this.vx = this.vz = 0;
    this.driving = { h, tr, el, v: 0 };
    this.pitch = 0.2; // ufka yakın: nişan tankın 15–20 m önüne düşer
    this.x = x;
    this.z = z;
    this.rot = h;
    this.yaw = tr + Math.PI;
    this.target.set(x, TANK_CAM_Y, z);
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
    this.rot = d.h;
    this.flags = this.jumpBits();
  }

  /** Mermi savurdu: (vx, vz) hızıyla fırlar ve zıplar. Tanktaysa etkilenmez. */
  knock(vx: number, vz: number): void {
    if (this.driving) return;
    if (this.seat) this.standUp();
    this.vx = vx;
    this.vz = vz;
    this.knockT = KNOCK_TIME;
    if (this.jumpT >= JUMP_TIME) {
      this.jumpT = 0;
      this.jumpSeq = (this.jumpSeq + 1) & 3;
    }
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
    this.vehicle = 0;
    this.onStage = false;
    this.knockT = 0;
    this.seat = null;
    this.jumpY = 0;
    this.jumpT = JUMP_TIME;
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

  private sitOn(s: Seat): void {
    this.jumpY = 0;
    this.jumpT = JUMP_TIME;
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
    if (settings.firstPerson && !this.driving && !this.photo) {
      // Birinci şahıs: göz hizasından, bakış yönü kameranın açısı
      const eye = (this.seat ? 1.0 : 1.32) + this.jumpY + this.lift + (this.vehicle === 1 ? 0.3 : this.vehicle === 2 ? 0.14 : 0);
      this.target.set(this.x, eye, this.z);
      camera.position.copy(this.target);
      const cp = Math.cos(this.pitch);
      camera.lookAt(this.x - Math.sin(this.yaw) * cp, eye - Math.sin(this.pitch), this.z - Math.cos(this.yaw) * cp);
      return;
    }
    // Zıplarken kamera yarısı kadar yükselir: sarsmadan takip eder.
    const ty = this.driving ? TANK_CAM_Y : (this.seat ? 1.15 : 1.45) + this.jumpY * 0.5 + this.lift;
    this.target.x += (this.x - this.target.x) * k;
    this.target.y += (ty - this.target.y) * k;
    this.target.z += (this.z - this.target.z) * k;
    const cp = Math.cos(this.pitch);
    // Zindanda kamera duvarların ötesine çıkmasın: parmaklıklardan dışarı bakılır.
    const dist = this.jailed ? Math.min(this.dist, 3.4) : this.driving ? Math.max(this.dist, TANK_CAM_DIST) : this.dist;
    camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * dist,
      // Aşağıdan bakarken (fotoğraf modu) kamera zeminin altına inmesin
      Math.max(0.3, this.target.y + Math.sin(this.pitch) * dist),
      this.target.z + Math.cos(this.yaw) * cp * dist,
    );
    camera.lookAt(this.target);
  }
}
