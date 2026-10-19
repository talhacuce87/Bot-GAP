// Yerel oyuncu: anında tepki veren hareket (sunucuyu beklemez), oturma ve 3. şahıs kamera.
import * as THREE from "three";
import { clampToJail, FLAG_SEATED, FLAG_WALKING, PLAYER_RADIUS, RUN_MULTIPLIER, WALK_SPEED } from "../../shared/constants";
import type { PlayerState } from "../../shared/protocol";
import type { AvatarView } from "./avatars/avatars";
import type { Input } from "./input/input";
import type { Seat, World } from "./world/scene";

const SEAT_REACH = 1.3;
const TAU = Math.PI * 2;

function dampAngle(a: number, b: number, k: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return a + d * k;
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
  color: THREE.Color;
  /** Oturma menzilindeki koltuk (UI ipucu için), yoksa null. */
  nearSeat: Seat | null = null;
  /** Sürgünde: zindan hücresinden çıkamaz. */
  jailed = false;

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
    this.yaw -= this.look.x * 0.006;
    this.pitch = THREE.MathUtils.clamp(this.pitch + this.look.y * 0.004, 0.05, 1.25);
    this.dist = THREE.MathUtils.clamp(this.dist + input.consumeZoom() * 0.6, 2.5, 12);

    const action = input.consumeAction();
    const moving = Math.abs(input.moveX) > 0.15 || Math.abs(input.moveY) > 0.15;

    if (this.seat) {
      if (action || moving) this.standUp();
      else return;
    }

    // Kameraya göre hareket yönü: ileri = kameranın baktığı yatay yön.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const mx = -sy * input.moveY + cy * input.moveX;
    const mz = -cy * input.moveY - sy * input.moveX;
    const accel = 1 - Math.exp(-dt * 12);
    const speedMax = WALK_SPEED * (input.run ? RUN_MULTIPLIER : 1);
    this.vx += (mx * speedMax - this.vx) * accel;
    this.vz += (mz * speedMax - this.vz) * accel;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.world.colliders.resolve(this, PLAYER_RADIUS);
    if (this.jailed) clampToJail(this);

    const speed = Math.hypot(this.vx, this.vz);
    if (speed > 0.3) this.rot = dampAngle(this.rot, Math.atan2(this.vx, this.vz), 1 - Math.exp(-dt * 12));
    this.flags = speed > 0.6 ? FLAG_WALKING : 0;

    this.nearSeat = this.findSeat();
    if (action && this.nearSeat) this.sitOn(this.nearSeat);
  }

  /** Sunucunun belirlediği yere ışınlanır (zindana giriş/çıkış). */
  teleport(x: number, z: number, rot: number): void {
    this.seat = null;
    this.x = x;
    this.z = z;
    this.rot = rot;
    this.vx = this.vz = 0;
    this.flags = 0;
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

  private sitOn(s: Seat): void {
    this.seat = s;
    this.standX = this.x;
    this.standZ = this.z;
    this.x = s.x;
    this.z = s.z;
    this.rot = s.rot;
    this.vx = this.vz = 0;
    this.flags = FLAG_SEATED;
    this.nearSeat = null;
    // Kamerayı perdeye doğru, oturanın arkasına çevir.
    this.yaw = s.rot + Math.PI;
  }

  private standUp(): void {
    this.seat = null;
    this.x = this.standX;
    this.z = this.standZ;
    this.flags = 0;
  }

  updateCamera(camera: THREE.PerspectiveCamera, dt: number): void {
    const k = 1 - Math.exp(-dt * 14);
    const ty = this.seat ? 1.15 : 1.45;
    this.target.x += (this.x - this.target.x) * k;
    this.target.y += (ty - this.target.y) * k;
    this.target.z += (this.z - this.target.z) * k;
    const cp = Math.cos(this.pitch);
    // Zindanda kamera duvarların ötesine çıkmasın: parmaklıklardan dışarı bakılır.
    const dist = this.jailed ? Math.min(this.dist, 3.4) : this.dist;
    camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * dist,
      this.target.y + Math.sin(this.pitch) * dist,
      this.target.z + Math.cos(this.yaw) * cp * dist,
    );
    camera.lookAt(this.target);
  }
}
