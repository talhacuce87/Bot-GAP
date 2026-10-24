// Radyolar: duyulan her radyo için gizli bir YouTube oynatıcısı (her biri ayrı gizli kutuda; üst üste binen
// çerçeveler YouTube'u durdurabiliyordu). Herkes şarkıyı sunucunun verdiği başlangıç anından dinler; kayma
// büyükse ve seyrek düzeltilir (sık sarmak iki radyo birlikteyken sürekli tamponlamaya sokuyordu). Ses arabaya
// uzaklıkla kısılır, menzil dışında oynatıcı kapatılır; kendi radyon ve bindiğin arabanınki tam sesle. Her
// radyonun sesi ayrıca ayarlanır ya da kapatılır. Kendi şarkın bitince sunucuya bildirilir (sıradaki çalar).
import { type CarRadio, RADIO_RANGE } from "../../shared/car";
import { createPlayer, type MediaPlayer } from "./watch/players";

export interface RadioSource {
  sid: number;
  radio: CarRadio;
  x: number;
  z: number;
  /** Kendi radyon ya da bindiğin arabanınki: uzaklıktan bağımsız tam ses. */
  own: boolean;
}

interface Live {
  key: string;
  host: HTMLDivElement;
  player: MediaPlayer;
  checked: number;
  /** Son sarma (ms): sarmalar arasında en az SEEK_GAP. */
  seeked: number;
  ended: boolean;
}

/** Bu kadar kayınca düzeltilir; aynı oynatıcı en sık bu aralıkla sarılır. */
const DRIFT = 6;
const SEEK_GAP = 20_000;

/** Uzaklığa göre ses (0–1): yakında tam, menzilin sonunda sessiz. */
export function radioGain(d: number, own: boolean): number {
  if (own) return 1;
  const t = Math.max(0, 1 - Math.max(0, d - 3) / (RADIO_RANGE - 3));
  return t * t;
}

export class RadioMixer {
  private live = new Map<number, Live>();
  /** Kendi radyonun şarkısı bitti (ya da çalınamadı): sunucuya bildirilir. */
  onEnded: (id: string) => void = () => {};

  /**
   * Kare başına. `mix(sid)`: o radyonun ayrıca ayarlanan sesi (0 kapalı). Duyulan en yüksek sesli radyoyu
   * döndürür (etiket için).
   */
  update(sources: RadioSource[], lx: number, lz: number, serverNow: number, volume: number, mix: (sid: number) => number, me: number): { sid: number; title: string; gain: number } | null {
    const seen = new Set<number>();
    let loudest: { sid: number; title: string; gain: number } | null = null;
    for (const s of sources) {
      const d = Math.hypot(s.x - lx, s.z - lz);
      // Kendi radyon hep çalar (sesini kıssan da bitişi bilinsin)
      if (!s.own && d > RADIO_RANGE + 8) continue;
      seen.add(s.sid);
      const key = `${s.radio.id}@${s.radio.at}`;
      let l = this.live.get(s.sid);
      if (l && l.key !== key) {
        this.drop(s.sid);
        l = undefined;
      }
      const elapsed = Math.max(0, (serverNow - s.radio.at) / 1000);
      if (!l) {
        const host = document.createElement("div");
        Object.assign(host.style, { position: "fixed", left: "0", bottom: "0", width: "240px", height: "136px", opacity: "0.001", pointerEvents: "none", zIndex: "-1", overflow: "hidden" });
        document.body.append(host);
        const player = createPlayer(host, { kind: "youtube", id: s.radio.id, start: elapsed });
        player.setMuted(false);
        const live: Live = { key, host, player, checked: performance.now(), seeked: performance.now(), ended: false };
        // Çalınamayan şarkı da biter (sıradakine geçilsin)
        if (s.sid === me) player.onError = () => this.finish(live, s.radio.id);
        l = live;
        this.live.set(s.sid, l);
      }
      const gain = radioGain(d, s.own) * mix(s.sid);
      l.player.setVolume(Math.min(1, gain * volume));
      const now = performance.now();
      if (now - l.checked > 3000) {
        l.checked = now;
        const t = l.player.time(), dur = l.player.duration();
        // Şarkı bitti: kendi radyonsa sıradakine geçilsin
        if (s.sid === me && (l.player.ended?.() || (Number.isFinite(dur) && elapsed > dur + 4))) this.finish(l, s.radio.id);
        else if (Number.isFinite(t) && (!Number.isFinite(dur) || elapsed < dur - 1)) {
          // Çok kaydıysa (seyrek) doğru saniyeye sar; durduysa yalnızca devam ettir
          if (Math.abs(t - elapsed) > DRIFT && now - l.seeked > SEEK_GAP) {
            l.seeked = now;
            l.player.seek(elapsed);
          }
          if (!l.player.isPlaying()) l.player.play();
        }
      }
      if (gain > 0.03 && (!loudest || gain > loudest.gain)) loudest = { sid: s.sid, title: s.radio.title, gain };
    }
    for (const sid of [...this.live.keys()]) if (!seen.has(sid)) this.drop(sid);
    return loudest;
  }

  private finish(l: Live, id: string): void {
    if (l.ended) return;
    l.ended = true;
    this.onEnded(id);
  }

  private drop(sid: number): void {
    const l = this.live.get(sid);
    if (!l) return;
    l.player.destroy();
    l.host.remove();
    this.live.delete(sid);
  }

  dispose(): void {
    for (const sid of [...this.live.keys()]) this.drop(sid);
  }
}
