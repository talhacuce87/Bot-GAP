// `?bots=N`: performans testi için yerel sahte oyuncular. Gerçek ağ yolunu (Remotes + interpolasyon) kullanır.
import { EMOTES, FLAG_SEATED, FLAG_WALKING, JUMP_SHIFT, TICK_HZ, WALK_SPEED } from "../../../shared/constants";
import { PLAZA } from "../../../shared/zones";
import type { Seat } from "../world/scene";
import manifest from "../../chibi/chibi.json";
import { type ChibiManifest, randomLook } from "./chibiPack";
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
  jumpSeq: number;
}

export class Bots {
  private bots: Bot[] = [];
  private acc = 0;
  /** Sahte oyuncular ara sıra emote atar (ağdan gelmiş gibi). */
  onEmote: (sid: number, e: number) => void = () => {};

  constructor(
    private remotes: Remotes,
    count: number,
    private seats: Seat[],
  ) {
    for (let i = 0; i < count; i++) {
      const sid = LOCAL_SID_BASE + i;
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 6;
      const b: Bot = { sid, x: Math.sin(a) * r, z: Math.cos(a) * r + 6, rot: 0, tx: 0, tz: 0, wait: 0, seated: false, jumpSeq: 0 };
      this.pickTarget(b);
      this.bots.push(b);
      const look = randomLook(manifest as ChibiManifest, i + 1);
      remotes.add({ sid, id: `bot-${i}`, name: `Bot ${i + 1}`, avatar: null, spectator: false, jailed: false, look });
    }
  }

  private pickTarget(b: Bot): void {
    if (Math.random() < 0.25 && this.seats.length) {
      const s = this.seats[Math.floor(Math.random() * this.seats.length)];
      b.tx = s.x;
      b.tz = s.z;
      return;
    }
    // Meydanın çevresinde dolaşır (nehir ve dağlar engel; botlar çarpışma bilmez)
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 30;
    b.tx = PLAZA.x + Math.sin(a) * r;
    b.tz = PLAZA.z + Math.cos(a) * r;
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
    if (this.acc < 1 / TICK_HZ) return;
    this.acc = 0;
    for (const b of this.bots) {
      if (Math.random() < 0.012) this.onEmote(b.sid, Math.floor(Math.random() * EMOTES.length));
      if (!b.seated && Math.random() < 0.01) b.jumpSeq = (b.jumpSeq + 1) & 3;
      const flags = (b.wait > 0 ? (b.seated ? FLAG_SEATED : 0) : FLAG_WALKING) | (b.jumpSeq << JUMP_SHIFT);
      this.remotes.map.get(b.sid)?.push(serverNow, b.x, b.z, b.rot, flags);
    }
  }
}
