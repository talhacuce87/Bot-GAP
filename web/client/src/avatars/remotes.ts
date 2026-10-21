// Uzak oyuncular: snapshot halka tamponu + INTERP_DELAY_MS geriden interpolasyon.
import type * as THREE from "three";
import { JUMP_MASK, JUMP_SHIFT, JUMP_TIME, jumpHeight } from "../../../shared/constants";
import type { PlayerInfo } from "../../../shared/protocol";
import type { AvatarAtlas } from "./atlas";
import { type AvatarView, colorFor } from "./avatars";

const BUF = 8;
/** Bu sid ve üstü yerel sahte oyunculara (bots) ayrılmıştır; ağ yeniden bağlanınca silinmez. */
export const LOCAL_SID_BASE = 60000;
const FADE_PER_SEC = 3;
const TAU = Math.PI * 2;

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export class Remote implements AvatarView {
  x = 0;
  z = 0;
  rot = 0;
  flags = 0;
  alpha = 0;
  emote = -1;
  emoteAt = 0;
  jumpY = 0;
  lift = 0;
  mic = false;
  hideName = false;
  pair: AvatarView["pair"] = null;
  private lastJumpSeq = -1;
  private jumpT = JUMP_TIME;
  leaving = false;
  readonly color: THREE.Color;
  readonly phase: number;
  /** Kıyafet PlayerInfo'da durur; "look" olayıyla güncellenir. */
  get outfit() {
    return this.info.look ?? null;
  }
  private t = new Float64Array(BUF);
  private bx = new Float32Array(BUF);
  private bz = new Float32Array(BUF);
  private br = new Float32Array(BUF);
  private bf = new Uint8Array(BUF);
  private head = 0; // bir sonraki yazılacak yer
  private n = 0;

  /** Henüz hiç konum gelmediyse çizilmez (yoksa dünya merkezinde belirir). */
  get hasData(): boolean {
    return this.n > 0;
  }

  constructor(
    readonly info: PlayerInfo,
    readonly cell: number,
  ) {
    this.color = colorFor(info.id);
    this.phase = (info.sid * 1.37) % TAU;
  }

  push(time: number, x: number, z: number, rot: number, flags: number): void {
    const last = (this.head + BUF - 1) % BUF;
    if (this.n > 0 && time <= this.t[last]) return; // sıra dışı/yinelenen
    const i = this.head;
    this.t[i] = time;
    this.bx[i] = x;
    this.bz[i] = z;
    this.br[i] = rot;
    this.bf[i] = flags;
    this.head = (i + 1) % BUF;
    if (this.n < BUF) this.n++;
    if (this.n === 1) {
      this.x = x;
      this.z = z;
      this.rot = rot;
      this.flags = flags;
    }
  }

  /** Tamponu sıfırlayıp tek örnekle başlatır: aradaki yol boyunca kaymasın. */
  teleport(x: number, z: number, rot: number): void {
    // Zaman 0: sonraki her snapshot daha yeni sayılır, interpolasyon hemen yeni konuma oturur.
    this.n = 0;
    this.head = 0;
    this.push(0, x, z, rot, 0);
  }

  /** `renderTime` anına (sunucu saati) göre konumu ve zıplamayı hesaplar. */
  sample(renderTime: number, dt: number): void {
    this.interp(renderTime, dt);
    // Sayaç değiştiyse yeni zıplama: yay herkes için aynı olduğu için yerelde çizilir.
    const seq = (this.flags & JUMP_MASK) >> JUMP_SHIFT;
    if (this.lastJumpSeq >= 0 && seq !== this.lastJumpSeq) this.jumpT = 0;
    if (this.n > 0) this.lastJumpSeq = seq;
    this.jumpT += dt;
    this.jumpY = jumpHeight(this.jumpT);
  }

  private interp(renderTime: number, dt: number): void {
    this.alpha = this.leaving ? Math.max(0, this.alpha - dt * FADE_PER_SEC) : Math.min(1, this.alpha + dt * FADE_PER_SEC);
    if (this.n === 0) return;
    const newest = (this.head + BUF - 1) % BUF;
    if (renderTime >= this.t[newest] || this.n === 1) {
      this.x = this.bx[newest];
      this.z = this.bz[newest];
      this.rot = this.br[newest];
      this.flags = this.bf[newest];
      return;
    }
    // En yeniden geriye doğru, renderTime'ı kapsayan iki örneği bul.
    for (let k = 1; k < this.n; k++) {
      const b = (newest - k + 1 + BUF) % BUF;
      const a = (newest - k + BUF) % BUF;
      if (this.t[a] <= renderTime) {
        const span = this.t[b] - this.t[a];
        const u = span > 0 ? (renderTime - this.t[a]) / span : 1;
        this.x = this.bx[a] + (this.bx[b] - this.bx[a]) * u;
        this.z = this.bz[a] + (this.bz[b] - this.bz[a]) * u;
        this.rot = lerpAngle(this.br[a], this.br[b], u);
        this.flags = u < 0.5 ? this.bf[a] : this.bf[b];
        return;
      }
    }
    const oldest = (newest - this.n + 1 + BUF) % BUF;
    this.x = this.bx[oldest];
    this.z = this.bz[oldest];
    this.rot = this.br[oldest];
    this.flags = this.bf[oldest];
  }
}

export class Remotes {
  readonly map = new Map<number, Remote>();
  private changed = true;

  constructor(private atlas: AvatarAtlas) {}

  /** Liste UI'si sadece katılma/ayrılmada yeniden çizilir. */
  consumeChanged(): boolean {
    const c = this.changed;
    this.changed = false;
    return c;
  }

  add(info: PlayerInfo): Remote {
    const existing = this.map.get(info.sid);
    if (existing && !existing.leaving) return existing;
    if (existing) this.drop(info.sid);
    const r = new Remote(info, this.atlas.alloc(info.name, info.jailed));
    this.map.set(info.sid, r);
    this.changed = true;
    return r;
  }

  /** Kıyafet değişti (gardırop): chibi bir sonraki karede yeni kıyafetle çizilir. */
  setLook(sid: number, look: PlayerInfo["look"]): void {
    const r = this.map.get(sid);
    if (r) r.info.look = look;
  }

  /** Evcil hayvan ve tank kamuflajı. */
  setCosmetics(sid: number, pet: string | null, skin: string | null): void {
    const r = this.map.get(sid);
    if (!r) return;
    r.info.pet = pet;
    r.info.skin = skin;
  }

  /** Sürgün durumu değişti: etiketi güncelle, ışınlanmayı interpolasyonsuz uygula. */
  setJailed(sid: number, jailed: boolean, x: number, z: number, rot: number): void {
    const r = this.map.get(sid);
    if (!r) return;
    r.info.jailed = jailed;
    this.atlas.setName(r.cell, r.info.name, jailed);
    r.teleport(x, z, rot);
    this.changed = true;
  }

  leave(sid: number): void {
    const r = this.map.get(sid);
    if (r) {
      r.leaving = true;
      this.changed = true;
    }
  }

  /** Ağdan gelen oyuncuları siler (yeniden bağlanmada). */
  clear(): void {
    for (const sid of [...this.map.keys()]) if (sid < LOCAL_SID_BASE) this.drop(sid);
    this.changed = true;
  }

  private drop(sid: number): void {
    const r = this.map.get(sid);
    if (!r) return;
    this.atlas.release(r.cell);
    this.map.delete(sid);
  }

  update(renderTime: number, dt: number): void {
    for (const r of this.map.values()) {
      r.sample(renderTime, dt);
      if (r.leaving && r.alpha <= 0) this.drop(r.info.sid);
    }
  }
}
