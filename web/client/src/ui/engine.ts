// Motor sesleri: kendi araban ve yakındaki birkaç araba (oyuncu ya da NPC). Dosya yok: testere dişi + kare
// dalga alçak geçiren süzgeçten; devir hızla, ses uzaklıkla değişir. Ses seviyesi efekt ayarına bağlı.
import { settings } from "../settings";
import { audioContext } from "./sfx";

/** Aynı anda en çok bu kadar motor (kendi araban dahil). */
const VOICES = 4;
const RANGE = 45;

interface Voice {
  osc: OscillatorNode;
  sub: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

export interface EngineSource {
  /** Arabanın hızı (m/sn, geri vitesteyse eksi olabilir) ve gaz (0–1). */
  speed: number;
  throttle: number;
  /** Dinleyene uzaklık (m) ve yan (−1 sol … 1 sağ). */
  dist: number;
  pan: number;
  /** Kendi araban: daha yüksek ve dolgun. */
  own?: boolean;
}

export class EngineSounds {
  private voices: Voice[] = [];

  private voice(ac: AudioContext, i: number): Voice {
    let v = this.voices[i];
    if (v) return v;
    const osc = ac.createOscillator(), sub = ac.createOscillator();
    osc.type = "sawtooth";
    sub.type = "square";
    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 2;
    const gain = ac.createGain();
    gain.gain.value = 0;
    const pan = ac.createStereoPanner();
    const subGain = ac.createGain();
    subGain.gain.value = 0.6;
    osc.connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(gain).connect(pan).connect(ac.destination);
    osc.start();
    sub.start();
    v = { osc, sub, filter, gain, pan };
    this.voices[i] = v;
    return v;
  }

  /** Kare başına: en yakın kaynaklar çalınır, gerisi susar. */
  update(sources: EngineSource[]): void {
    const ac = audioContext();
    if (!ac || ac.state !== "running") return;
    const list = sources.filter((s) => s.dist < RANGE).sort((a, b) => Number(!!b.own) - Number(!!a.own) || a.dist - b.dist).slice(0, VOICES);
    const t = ac.currentTime, k = 0.08;
    for (let i = 0; i < VOICES; i++) {
      const s = list[i];
      if (!s && !this.voices[i]) continue;
      const v = this.voice(ac, i);
      if (!s) {
        v.gain.gain.setTargetAtTime(0, t, k);
        continue;
      }
      const sp = Math.abs(s.speed);
      // Vites hissi: hız arttıkça devir yükselip her ~6 m/sn'de biraz düşer
      const gear = (sp % 6) / 6;
      const rpm = 32 + sp * 2.2 + gear * 18 + s.throttle * 10;
      v.osc.frequency.setTargetAtTime(rpm, t, k);
      v.sub.frequency.setTargetAtTime(rpm / 2, t, k);
      v.filter.frequency.setTargetAtTime(260 + sp * 40 + s.throttle * 500, t, k);
      const near = Math.max(0, 1 - s.dist / RANGE);
      const level = (s.own ? 0.05 : 0.035) * (0.45 + 0.35 * s.throttle + Math.min(0.4, sp / 40)) * near * near * settings.sfxVolume;
      v.gain.gain.setTargetAtTime(level, t, k);
      v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, s.pan)), t, k);
    }
  }

  /** Hepsini sustur (arabadan çıkınca ya da mod değişince). */
  silence(): void {
    const ac = audioContext();
    if (!ac) return;
    for (const v of this.voices) v.gain.gain.setTargetAtTime(0, ac.currentTime, 0.05);
  }
}
