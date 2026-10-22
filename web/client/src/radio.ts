// Araba radyoları: yakındaki her çalan Tofaş için gizli bir YouTube oynatıcısı. Herkes şarkıyı sunucunun
// verdiği başlangıç anından dinler (kayarsa düzeltilir); ses arabaya uzaklıkla kısılır, menzil dışında
// oynatıcı kapatılır. Kendi arabandaysan tam sesle.
import { type CarRadio, RADIO_RANGE } from "../../shared/car";
import { createPlayer, type MediaPlayer } from "./watch/players";

export interface RadioSource {
  sid: number;
  radio: CarRadio;
  x: number;
  z: number;
  /** Bu arabanın içindesin. */
  own: boolean;
}

interface Live {
  key: string;
  player: MediaPlayer;
  at: number;
  checked: number;
}

/** Uzaklığa göre ses (0–1): yakında tam, menzilin sonunda sessiz. */
export function radioGain(d: number, own: boolean): number {
  if (own) return 1;
  const t = Math.max(0, 1 - Math.max(0, d - 3) / (RADIO_RANGE - 3));
  return t * t;
}

export class RadioMixer {
  private host: HTMLDivElement;
  private live = new Map<number, Live>();

  constructor() {
    // Oynatıcılar görünmez ama sayfada: YouTube küçük/gizli çerçevede çalmayı reddedebiliyor
    this.host = document.createElement("div");
    Object.assign(this.host.style, { position: "fixed", left: "0", bottom: "0", width: "240px", height: "136px", opacity: "0.001", pointerEvents: "none", zIndex: "-1", overflow: "hidden" });
    document.body.append(this.host);
  }

  /** Kare başına: duyulan en yüksek sesli radyoyu döndürür (etiket için). */
  update(sources: RadioSource[], lx: number, lz: number, serverNow: number, volume: number): { sid: number; title: string; gain: number } | null {
    const seen = new Set<number>();
    let loudest: { sid: number; title: string; gain: number } | null = null;
    for (const s of sources) {
      const d = Math.hypot(s.x - lx, s.z - lz);
      if (!s.own && d > RADIO_RANGE + 8) continue;
      seen.add(s.sid);
      const key = `${s.radio.id}@${s.radio.at}`;
      let l = this.live.get(s.sid);
      if (l && l.key !== key) {
        l.player.destroy();
        l = undefined;
      }
      const elapsed = Math.max(0, (serverNow - s.radio.at) / 1000);
      if (!l) {
        const player = createPlayer(this.host, { kind: "youtube", id: s.radio.id, start: elapsed });
        player.setMuted(false);
        l = { key, player, at: s.radio.at, checked: performance.now() };
        this.live.set(s.sid, l);
      }
      const gain = radioGain(d, s.own);
      l.player.setVolume(Math.min(1, gain * volume));
      // Ara ara: kaydıysa doğru saniyeye sar, durduysa yeniden başlat (şarkı bittiyse dokunma)
      const now = performance.now();
      if (now - l.checked > 3000) {
        l.checked = now;
        const t = l.player.time(), dur = l.player.duration();
        if (Number.isFinite(t) && (!Number.isFinite(dur) || elapsed < dur - 1)) {
          if (Math.abs(t - elapsed) > 2.5) l.player.seek(elapsed);
          if (!l.player.isPlaying()) l.player.play();
        }
      }
      if (gain > 0.03 && (!loudest || gain > loudest.gain)) loudest = { sid: s.sid, title: s.radio.title, gain };
    }
    for (const [sid, l] of this.live) {
      if (seen.has(sid)) continue;
      l.player.destroy();
      this.live.delete(sid);
    }
    return loudest;
  }

  dispose(): void {
    for (const l of this.live.values()) l.player.destroy();
    this.live.clear();
    this.host.remove();
  }
}
