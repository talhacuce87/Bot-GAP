// Watch party senkronu: sunucunun tek otoriter durumuna göre yerel oynatıcıyı ayarlar.
// Konum = position + (sunucuŞimdi − updatedAt); sapma eşiği aşılırsa oynatıcı oraya sarılır.
import { isLive, type Source } from "../../../shared/media";
import type { WatchState } from "../../../shared/protocol";
import { createPlayer, type MediaPlayer } from "./players";
import type { ScreenVideo } from "./screen";

const CHECK_EVERY = 0.25; // sn
/** Bu kadar sapınca sar. Gömülü oynatıcılar sarınca tamponlar; eşik düşük olursa sürekli takılır. */
const DRIFT_SEEK = { file: 0.6, other: 1.2 };
/** Sardıktan sonra tamponlama bitene kadar yeniden sarma. */
const SEEK_COOLDOWN = 2.5;

function sameSource(a: Source | null, b: Source | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class WatchSync {
  state: WatchState | null = null;
  player: MediaPlayer | null = null;
  /** Kullanıcı bir kez tıklayana kadar sessiz (tarayıcı otomatik sesli oynatmayı engeller). */
  unlocked = false;
  userVolume = 0.8;
  /** Ekran paylaşımı sürerken sinema sesi kısılır. */
  private suppressed = false;
  private acc = 0;
  private cooldown = 0;
  private distanceGain = 1;
  /** Bu kaynağın sonuna gelindi (kuyruktaki sıradakini istemek için bir kez bildirilir). */
  private endedSent = false;
  onEnded: () => void = () => {};

  constructor(
    private screen: ScreenVideo,
    private serverNow: () => number,
  ) {}

  /** Sunucudan yeni durum geldi. */
  apply(s: WatchState): void {
    const changed = !this.state || !sameSource(this.state.source, s.source);
    this.state = s;
    if (changed) {
      this.endedSent = false;
      this.player?.destroy();
      this.screen.host.replaceChildren();
      this.player = s.source ? createPlayer(this.screen.host, s.source) : null;
      this.screen.setActive(!!this.player);
      this.applyVolume();
    }
    this.cooldown = 0; // komut geldi: hemen hizala
    this.acc = CHECK_EVERY;
  }

  get live(): boolean {
    return !!this.state?.source && isLive(this.state.source);
  }

  /** Sunucuya göre şu an olması gereken konum (sn). */
  target(): number {
    const s = this.state;
    if (!s) return 0;
    return s.playing ? s.position + (this.serverNow() - s.updatedAt) / 1000 : s.position;
  }

  unlock(): void {
    this.unlocked = true;
    this.applyVolume();
    if (this.state?.playing) this.player?.play();
  }

  setVolume(v: number): void {
    this.userVolume = v;
    this.applyVolume();
  }

  /** Perdeye uzaklık: sinemadan uzaklaştıkça ses kısılır. */
  setDistance(d: number): void {
    const g = Math.min(1, Math.max(0.06, 1 - (d - 18) / 45));
    if (Math.abs(g - this.distanceGain) < 0.02) return;
    this.distanceGain = g;
    this.applyVolume();
  }

  setSuppressed(on: boolean): void {
    this.suppressed = on;
    this.applyVolume();
  }

  private applyVolume(): void {
    const p = this.player;
    if (!p) return;
    p.setMuted(!this.unlocked || this.suppressed);
    p.setVolume(this.userVolume * this.distanceGain);
  }

  update(dt: number): void {
    const p = this.player, s = this.state;
    if (!p || !s || !p.controllable) return;
    this.cooldown -= dt;
    this.acc += dt;
    if (this.acc < CHECK_EVERY) return;
    this.acc = 0;

    if (s.playing !== p.isPlaying()) {
      if (s.playing) p.play();
      else p.pause();
    }
    if (this.live || this.cooldown > 0) return;
    const now = p.time();
    if (!Number.isFinite(now)) return;
    const dur = p.duration();
    let want = this.target();
    if (Number.isFinite(dur) && want > dur - 0.3) want = dur; // bitti: sonda bekle
    if (Number.isFinite(dur) && dur > 5 && this.target() >= dur - 0.5 && !this.endedSent) {
      this.endedSent = true;
      this.onEnded();
    }
    const limit = s.source?.kind === "file" ? DRIFT_SEEK.file : DRIFT_SEEK.other;
    if (Math.abs(now - want) > limit) {
      p.seek(want);
      this.cooldown = SEEK_COOLDOWN;
    }
  }
}
