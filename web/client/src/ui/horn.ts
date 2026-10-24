// Kornalar: kendi arabanın ve yakındaki arabaların kornası (WebAudio, dosya yok). Basılı tutulan kornalar
// (standart, dolmuş, TIR) bırakılınca susar; melodili olanlar (La Cucaracha, düğün konvoyu) bir kez sonuna kadar
// çalar. Ses uzaklıkla kısılır (her kare `level`).
import type { CarSpec } from "../../../shared/car";
import { settings } from "../settings";
import { audioContext } from "./sfx";

type Kind = CarSpec["horn"];

/** Basılı tutulan korna: tonlar (Hz), dalga biçimi, süzgeç ve ses. */
const HELD: Partial<Record<Kind, { f: number[]; type: OscillatorType; cut: number; gain: number }>> = {
  standart: { f: [415, 523], type: "square", cut: 2400, gain: 0.05 },
  dolmus: { f: [740, 932], type: "sawtooth", cut: 4200, gain: 0.032 },
  kamyon: { f: [185, 233, 277], type: "sawtooth", cut: 1400, gain: 0.07 },
};
const G4 = 392, C5 = 523, E5 = 659;
/** Melodi: [nota (Hz, 0 es), süre (sn)]. */
const TUNES: Partial<Record<Kind, [number, number][]>> = {
  cucaracha: [
    [G4, 0.12], [0, 0.03], [G4, 0.12], [0, 0.03], [G4, 0.12], [0, 0.03], [C5, 0.3], [0, 0.06], [E5, 0.3], [0, 0.16],
    [G4, 0.12], [0, 0.03], [G4, 0.12], [0, 0.03], [G4, 0.12], [0, 0.03], [C5, 0.3], [0, 0.06], [E5, 0.45],
  ],
  // Dıt dıt dıııt · dıt dıt dıt dıt dıııııt
  dugun: [
    [C5, 0.1], [0, 0.08], [C5, 0.1], [0, 0.08], [C5, 0.42], [0, 0.22],
    [C5, 0.1], [0, 0.08], [C5, 0.1], [0, 0.08], [C5, 0.1], [0, 0.08], [C5, 0.1], [0, 0.08], [C5, 0.6],
  ],
};

interface Voice {
  out: GainNode;
  pan: StereoPannerNode;
  oscs: OscillatorNode[];
  base: number;
  /** Melodinin bittiği an (basılı tutulan kornada sonsuz). */
  until: number;
  held: boolean;
}

/** Kornanın melodi mi (bir kez çalar, bırakınca susmaz). */
export function hornIsTune(kind: Kind): boolean {
  return !!TUNES[kind];
}

export class Horns {
  private voices = new Map<number, Voice>();

  /** `key`in (oyuncu sid'i) kornası çalmaya başlar; `level` 0–1 yakınlık, `pan` −1 sol … 1 sağ. */
  start(key: number, kind: Kind, level = 1, pan = 0): void {
    this.kill(key);
    const ac = audioContext();
    if (!ac || ac.state !== "running") return;
    const t = ac.currentTime;
    const out = ac.createGain();
    out.gain.value = 0;
    const p = ac.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(p).connect(ac.destination);
    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.connect(out);
    const oscs: OscillatorNode[] = [];
    const held = HELD[kind];
    let until = Infinity, base: number;
    if (held) {
      filter.frequency.value = held.cut;
      for (const hz of held.f) {
        const o = ac.createOscillator();
        o.type = held.type;
        o.frequency.value = hz;
        o.connect(filter);
        o.start(t);
        oscs.push(o);
      }
      base = held.gain;
    } else {
      // Melodi: iki ses (nota ve üstündeki büyük üçlü), notalar arasında kısa sessizlik
      const tune = TUNES[kind] ?? [];
      filter.frequency.value = 3000;
      const env = ac.createGain();
      env.gain.value = 0;
      env.connect(filter);
      for (const mul of [1, 1.26]) {
        const o = ac.createOscillator();
        o.type = "square";
        o.connect(env);
        oscs.push(o);
        let at = t;
        for (const [hz, d] of tune) {
          if (hz) o.frequency.setValueAtTime(hz * mul, at);
          at += d;
        }
      }
      let at = t;
      for (const [hz, d] of tune) {
        if (hz) {
          env.gain.setValueAtTime(0, at);
          env.gain.linearRampToValueAtTime(1, at + 0.01);
          env.gain.setValueAtTime(1, at + d - 0.02);
          env.gain.linearRampToValueAtTime(0, at + d);
        }
        at += d;
      }
      for (const o of oscs) {
        o.start(t);
        o.stop(at + 0.05);
      }
      until = at;
      base = 0.04;
    }
    out.gain.setTargetAtTime(base * level * settings.sfxVolume, t, 0.01);
    this.voices.set(key, { out, pan: p, oscs, base, until, held: !!held });
  }

  /** Korna bırakıldı: basılı tutulan korna susar (melodi sonuna kadar çalar). */
  release(key: number): void {
    const v = this.voices.get(key);
    if (v?.held) this.kill(key);
  }

  /** Hemen sustur. */
  kill(key: number): void {
    const v = this.voices.get(key);
    if (!v) return;
    this.voices.delete(key);
    const ac = audioContext();
    if (!ac) return;
    const t = ac.currentTime;
    v.out.gain.setTargetAtTime(0, t, 0.02);
    for (const o of v.oscs) {
      try {
        o.stop(t + 0.1);
      } catch {
        // zaten durmuş
      }
    }
  }

  playing(key: number): boolean {
    return this.voices.has(key);
  }

  /** Kare başına: uzaklığa göre ses (`level` verilmeyen değişmez); biten melodiler silinir. */
  update(level: (key: number) => { level: number; pan: number } | null): void {
    const ac = audioContext();
    if (!ac) return;
    const t = ac.currentTime;
    for (const [key, v] of this.voices) {
      if (t > v.until + 0.1) {
        this.voices.delete(key);
        continue;
      }
      const l = level(key);
      if (!l) continue;
      v.out.gain.setTargetAtTime(v.base * l.level * settings.sfxVolume, t, 0.05);
      v.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, l.pan)), t, 0.05);
    }
  }

  silence(): void {
    for (const key of [...this.voices.keys()]) this.kill(key);
  }
}
