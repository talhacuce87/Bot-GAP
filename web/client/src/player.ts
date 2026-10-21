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
  STEP_UP,
  WALK_SPEED,
} from "../../shared/constants";
import type { Look, PlayerState } from "../../shared/protocol";
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
import type { AvatarView } from "./avatars/avatars";
import type { Input } from "./input/input";
import { LEDGE } from "./world/colliders";
import { SEAT_H } from "./world/builder";
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
  /** Zıplamanın başından geçen süre; yerdeyken JUMP_TIME. */
  private jumpT = JUMP_TIME;
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
    this.yaw -= this.look.x * 0.006;
    this.pitch = this.driving
      ? THREE.MathUtils.clamp(this.pitch + this.look.y * 0.004, TANK_PITCH_MIN, TANK_PITCH_MAX)
      : THREE.MathUtils.clamp(this.pitch + this.look.y * 0.004, 0.05, 1.25);
    this.dist = THREE.MathUtils.clamp(this.dist + input.consumeZoom() * 0.6, 2.5, 12);

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

    // Zıplama: ortak eğri (jumpHeight) bulunduğu yüzeyden; uzak istemciler aynı yayı sayaçtan çizer.
    if (jump && this.jumpT >= JUMP_TIME && this.vy === 0) this.startJump();
    this.rideTank();

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
      const accel = 1 - Math.exp(-dt * 12);
      const speedMax = WALK_SPEED * (input.run ? RUN_MULTIPLIER : 1);
      this.vx += (mx * speedMax - this.vx) * accel;
      this.vz += (mz * speedMax - this.vz) * accel;
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.fly(dt);
    this.world.colliders.resolve(this, PLAYER_RADIUS, this.elev);
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
    if (speed > 0.3) this.rot = dampAngle(this.rot, Math.atan2(this.vx, this.vz), 1 - Math.exp(-dt * 12));
    this.flags = (speed > 0.6 ? FLAG_WALKING : 0) | (speed > WALK_SPEED * 1.15 ? FLAG_RUNNING : 0) | this.jumpBits();

    this.nearSeat = this.findSeat();
    if (action && this.nearSeat) this.sitOn(this.nearSeat);
  }

  /** Ayaklar altındaki yüzeyin (yer, engel üstü, tank) yüksekliği; `y`: ayak yüksekliği. */
  private groundAt(y: number): number {
    const g = this.world.colliders.groundAt(this.x, this.z, PLAYER_RADIUS, y);
    const o = this.obstacle;
    return o ? Math.max(g, tankGround(o, this.x, this.z, PLAYER_RADIUS * LEDGE, y)) : g;
  }

  private startJump(): void {
    this.jumpT = 0;
    this.jumpSeq = (this.jumpSeq + 1) & 3;
    this.launchY = this.elev;
  }

  /** Havadaysa: önce zıplama eğrisi, bittiyse (ya da kenardan yürüyüp çıktıysa) serbest düşüş. */
  private fly(dt: number): void {
    if (this.jumpT < JUMP_TIME) {
      const prev = this.elev;
      this.jumpT = Math.min(JUMP_TIME, this.jumpT + dt);
      this.elev = this.launchY + jumpHeight(this.jumpT);
      this.vy = this.jumpT < JUMP_TIME ? (this.elev - prev) / Math.max(dt, 1e-4) : Math.min(this.vy, 0);
    } else if (this.elev > this.baseY || this.vy !== 0) {
      this.vy -= FALL_G * dt;
      this.elev += this.vy * dt;
    }
  }

  /** İnerken bir yüzeye değdiyse oraya konar; basamak kadar yüksek bir yüzeye yürüyerek çıkar. */
  private land(): void {
    const g = this.groundAt(this.elev);
    const falling = this.jumpT >= JUMP_TIME || this.vy <= 0;
    if (this.elev <= g && falling) {
      this.elev = g;
      this.vy = 0;
      this.jumpT = JUMP_TIME;
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

  /** Mermi savurdu: (vx, vz) hızıyla fırlar ve zıplar. Tanktaysa etkilenmez. */
  knock(vx: number, vz: number): void {
    if (this.driving) return;
    if (this.seat) this.standUp();
    this.vx = vx;
    this.vz = vz;
    this.knockT = KNOCK_TIME;
    if (this.jumpT >= JUMP_TIME) this.startJump();
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
    this.jumpT = JUMP_TIME;
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
    // Zıplarken kamera yarısı kadar yükselir: sarsmadan takip eder.
    const ty = this.driving ? TANK_CAM_Y : (this.seat ? 1.15 : 1.45) + this.baseY + this.jumpY * 0.5;
    this.target.x += (this.x - this.target.x) * k;
    this.target.y += (ty - this.target.y) * k;
    this.target.z += (this.z - this.target.z) * k;
    const cp = Math.cos(this.pitch);
    // Zindanda kamera duvarların ötesine çıkmasın: parmaklıklardan dışarı bakılır.
    const dist = this.jailed ? Math.min(this.dist, 3.4) : this.driving ? Math.max(this.dist, TANK_CAM_DIST) : this.dist;
    camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * dist,
      this.target.y + Math.sin(this.pitch) * dist,
      this.target.z + Math.cos(this.yaw) * cp * dist,
    );
    camera.lookAt(this.target);
  }
}
