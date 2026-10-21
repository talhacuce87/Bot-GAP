// Uzak oyuncular: snapshot halka tamponu + uyarlanır gecikmeyle (jitter.ts) geriden interpolasyon.
import type * as THREE from "three";
import { FLAG_DRIVING, FLAG_SEATED, FLAG_WALKING, JUMP_MASK, JUMP_SHIFT, JUMP_TIME, jumpHeight } from "../../../shared/constants";
import type { PlayerInfo } from "../../../shared/protocol";
import type { AvatarAtlas } from "./atlas";
import { type AvatarView, colorFor } from "./avatars";

const BUF = 8;
/** Bu sid ve üstü yerel sahte oyunculara (bots) ayrılmıştır; ağ yeniden bağlanınca silinmez. */
export const LOCAL_SID_BASE = 60000;
const FADE_PER_SEC = 3;
/**
 * Örnek gecikince (TCP takılması) en fazla bu kadar (ms) ileri tahmin edilir. Normal hatta çizim gecikmesi
 * zaten yeter; bu yalnızca takılmada devreye girer. Duran oyuncunun fazla gidişi yumuşakça geri alınır.
 */
const EXTRAP_MS = 200;
/**
 * Son iki örnek bundan uzak aralıklıysa hız bilinmiyor sayılır. Gönderenin hattı takılınca örnekler
 * birkaç yüz ms aralıklı gelir, hız yine de geçerlidir; duran oyuncu zaten bayrak/yer değiştirmeyle elenir.
 */
const EXTRAP_SPAN_MS = 1000;
/** Bu bayraklardan biri varken yer değiştiren oyuncu hareket ediyor sayılır. */
const MOVE_FLAGS = FLAG_WALKING | FLAG_DRIVING;
/** Örnekler yetmediği an (bekleme, ileri tahmin) bitince kalan fark saniyede bu hızla (üstel) kapanır... */
const CORRECT_PER_SEC = 10;
/** ...ama saniyede en fazla bu kadar metre: oyuncu ışınlanmaz, kısa bir hamleyle yetişir. */
const CORRECT_MAX_MPS = 6;
/** Bundan büyük fark yumuşatılmaz (ışınlanma, sunucunun düzeltmesi); bisikletle 200 ms ~2 m. */
const SNAP_M = 3;
const TAU = Math.PI * 2;

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export type Ground = (x: number, z: number, seated: boolean) => number;

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
  grip = false;
  hideName = false;
  pair: AvatarView["pair"] = null;
  /** Altındaki yüzey: konumdan bulunur (yükseklik gönderilmez; engelin içine yerden girilemez). */
  baseY = 0;
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
  /** Son karede örnekler yetmediyse (bekleme/ileri tahmin) dayanılan en yeni örneğin zamanı, yoksa NaN. */
  private basis = NaN;
  /** Bekleme/ileri tahmin bitince kalan, yavaşça kapanan fark. */
  private ex = 0;
  private ez = 0;
  private ox = 0;
  private oz = 0;

  /** Henüz hiç konum gelmediyse çizilmez (yoksa dünya merkezinde belirir). */
  get hasData(): boolean {
    return this.n > 0;
  }

  /** En yeni örneğin zamanı (sunucu saati); örnek yoksa NaN. */
  get newestTime(): number {
    return this.n ? this.t[(this.head + BUF - 1) % BUF] : NaN;
  }

  /** En yeni iki örneğe göre hareket ediyor (yürüyor/sürüyor ve yer değiştirmiş). */
  get moving(): boolean {
    if (this.n < 2) return false;
    const i = (this.head + BUF - 1) % BUF;
    const j = (i + BUF - 1) % BUF;
    return (this.bf[i] & MOVE_FLAGS) !== 0 && (this.bx[i] !== this.bx[j] || this.bz[i] !== this.bz[j]);
  }

  constructor(
    readonly info: PlayerInfo,
    readonly cell: number,
  ) {
    this.color = colorFor(info.id);
    this.phase = (info.sid * 1.37) % TAU;
  }

  /** Yeni örnek; sıra dışı ya da yinelenen (konumu değişmemiş oyuncu her snapshot'ta aynı zamanla gelir) ise false. */
  push(time: number, x: number, z: number, rot: number, flags: number): boolean {
    const last = (this.head + BUF - 1) % BUF;
    if (this.n > 0 && time <= this.t[last]) return false;
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
    return true;
  }

  /**
   * Tamponu sıfırlayıp tek örnekle başlatır: aradaki yol boyunca kaymasın. `at`: ışınlanmanın sunucu saati;
   * ondan eski örnekler (hızlı yolda olaydan sonra gelen eski snapshot) yok sayılır. 0: sonraki her örnek kabul.
   */
  teleport(x: number, z: number, rot: number, at = 0): void {
    this.n = 0;
    this.head = 0;
    this.basis = NaN;
    this.ex = this.ez = 0;
    this.push(at, x, z, rot, 0);
  }

  /** Hareket ediyor ama örnekleri yetmedi (bekleniyor ya da ileri tahmin ediliyor). */
  get starved(): boolean {
    return !Number.isNaN(this.basis) && this.moving;
  }

  /**
   * `renderTime` anına (sunucu saati) göre konumu ve zıplamayı hesaplar. `ground`: konumdaki en üst yüzey;
   * otururken koltuğun bank yüksekliğine göre farkı (Player.baseY ile aynı).
   */
  sample(renderTime: number, dt: number, ground?: Ground): void {
    this.interp(renderTime, dt);
    // Tank sürerken konum tankın içinde: yüzeye çıkmaz
    const g = ground && !(this.flags & FLAG_DRIVING) ? ground(this.x, this.z, (this.flags & FLAG_SEATED) !== 0) : 0;
    // Çıkarken anında, düşerken yumuşak (kenardan inen havada süzülür gibi)
    this.baseY = g >= this.baseY ? g : this.baseY + (g - this.baseY) * (1 - Math.exp(-dt * 9));
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
    const basis = this.locate(renderTime);
    // Yeni örnek geldi: eski dayanağın şimdi göstereceği yerle yenisi arasındaki fark tek karede değil, yavaşça kapanır
    if (!Number.isNaN(this.basis) && basis !== this.basis) this.correct(this.basis, renderTime);
    this.basis = basis;
    const e = Math.hypot(this.ex, this.ez);
    if (e > SNAP_M) this.ex = this.ez = 0;
    else if (e > 0) {
      const f = 1 - Math.min(e * (1 - Math.exp(-dt * CORRECT_PER_SEC)), CORRECT_MAX_MPS * dt) / e;
      this.ex *= f;
      this.ez *= f;
    }
    this.x += this.ex;
    this.z += this.ez;
  }

  /** Konumu `renderTime`'a göre örneklerden bulur; örnekler yetmediyse (bekleme/ileri tahmin) en yeninin zamanını, yoksa NaN döndürür. */
  private locate(renderTime: number): number {
    const newest = (this.head + BUF - 1) % BUF;
    if (renderTime >= this.t[newest] || this.n === 1) {
      this.x = this.bx[newest];
      this.z = this.bz[newest];
      this.rot = this.br[newest];
      this.flags = this.bf[newest];
      // Örnek gecikti: hareket eden oyuncu donmasın, son hızıyla kısa bir süre devam etsin
      if (this.n > 1 && this.lead(newest, renderTime)) {
        this.x += this.ox;
        this.z += this.oz;
      }
      return this.t[newest];
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
        return NaN;
      }
    }
    const oldest = (newest - this.n + 1 + BUF) % BUF;
    this.x = this.bx[oldest];
    this.z = this.bz[oldest];
    this.rot = this.br[oldest];
    this.flags = this.bf[oldest];
    return NaN;
  }

  /** `i` örneğinden (ve bir öncekinden) son hızla en fazla EXTRAP_MS ileri gidiş ox/oz'ye; tahmin yapılamıyorsa false. */
  private lead(i: number, renderTime: number): boolean {
    const j = (i + BUF - 1) % BUF;
    const span = this.t[i] - this.t[j];
    if (!(this.bf[i] & MOVE_FLAGS) || span <= 0 || span > EXTRAP_SPAN_MS) return false;
    const u = Math.max(0, Math.min(renderTime - this.t[i], EXTRAP_MS)) / span;
    this.ox = (this.bx[i] - this.bx[j]) * u;
    this.oz = (this.bz[i] - this.bz[j]) * u;
    return true;
  }

  /** `basis` zamanlı örneğe dayanan bekleme/tahminin şimdi göstereceği yerle bulunan yer arasındaki farkı ex/ez'ye ekler. */
  private correct(basis: number, renderTime: number): void {
    for (let k = 0; k < this.n; k++) {
      const i = (this.head + 2 * BUF - 1 - k) % BUF;
      if (this.t[i] !== basis) continue;
      const led = k < this.n - 1 && this.lead(i, renderTime);
      this.ex += this.bx[i] + (led ? this.ox : 0) - this.x;
      this.ez += this.bz[i] + (led ? this.oz : 0) - this.z;
      return;
    }
  }
}

export class Remotes {
  readonly map = new Map<number, Remote>();
  private changed = true;
  /** Toplam kare ve bunlardan hareket eden biri beklenirken (örnekleri yetmedi) geçenler: okuyan farkını alır. */
  frames = 0;
  starvedFrames = 0;

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
  setJailed(sid: number, jailed: boolean, x: number, z: number, rot: number, at = 0): void {
    const r = this.map.get(sid);
    if (!r) return;
    r.info.jailed = jailed;
    this.atlas.setName(r.cell, r.info.name, jailed);
    r.teleport(x, z, rot, at);
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

  update(renderTime: number, dt: number, ground?: Ground): void {
    let starved = false;
    for (const r of this.map.values()) {
      r.sample(renderTime, dt, ground);
      if (r.starved) starved = true;
      if (r.leaving && r.alpha <= 0) this.drop(r.info.sid);
    }
    this.frames++;
    if (starved) this.starvedFrames++;
  }
}
