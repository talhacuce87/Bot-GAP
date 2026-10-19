// `?bots=N`: performans testi için yerel sahte oyuncular. Gerçek ağ yolunu (Remotes + interpolasyon) kullanır.
import { FLAG_SEATED, FLAG_WALKING, SEND_HZ, WALK_SPEED, WORLD_RADIUS } from "../../../shared/constants";
import type { Seat } from "../world/scene";
import { LOCAL_SID_BASE, type Remotes } from "./remotes";

interface Bot {
  sid: number;
  x: number;
  z: number;
  rot: number;
  tx: number;
  tz: number;
  wait: number;
  seated: boolean;
}

export class Bots {
  private bots: Bot[] = [];
  private acc = 0;

  constructor(
    private remotes: Remotes,
    count: number,
    private seats: Seat[],
  ) {
    for (let i = 0; i < count; i++) {
      const sid = LOCAL_SID_BASE + i;
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 6;
      const b: Bot = { sid, x: Math.sin(a) * r, z: Math.cos(a) * r + 6, rot: 0, tx: 0, tz: 0, wait: 0, seated: false };
      this.pickTarget(b);
      this.bots.push(b);
      remotes.add({ sid, id: `bot-${i}`, name: `Bot ${i + 1}`, avatar: null, spectator: false });
    }
  }

  private pickTarget(b: Bot): void {
    if (Math.random() < 0.25 && this.seats.length) {
      const s = this.seats[Math.floor(Math.random() * this.seats.length)];
      b.tx = s.x;
      b.tz = s.z;
      return;
    }
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * (WORLD_RADIUS - 3);
    b.tx = Math.sin(a) * r;
    b.tz = Math.cos(a) * r;
  }

  /** `serverNow`: Remotes'un beklediği saat ekseni. */
  update(dt: number, serverNow: number): void {
    for (const b of this.bots) {
      if (b.wait > 0) {
        b.wait -= dt;
        if (b.wait <= 0) {
          b.seated = false;
          this.pickTarget(b);
        }
        continue;
      }
      const dx = b.tx - b.x;
      const dz = b.tz - b.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.3) {
        b.wait = 2 + Math.random() * 6;
        b.seated = this.seats.some((s) => s.x === b.tx && s.z === b.tz);
        if (b.seated) b.rot = this.seats.find((s) => s.x === b.tx && s.z === b.tz)!.rot;
        continue;
      }
      const step = Math.min(d, WALK_SPEED * 0.6 * dt);
      b.x += (dx / d) * step;
      b.z += (dz / d) * step;
      b.rot = Math.atan2(dx, dz);
    }
    // Gerçek sunucu gibi 15 Hz örnek gönder.
    this.acc += dt;
    if (this.acc < 1 / SEND_HZ) return;
    this.acc = 0;
    for (const b of this.bots) {
      const flags = b.wait > 0 ? (b.seated ? FLAG_SEATED : 0) : FLAG_WALKING;
      this.remotes.map.get(b.sid)?.push(serverNow, b.x, b.z, b.rot, flags);
    }
  }
}
