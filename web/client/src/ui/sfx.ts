// Kısa ses efektleri: dosya indirmeden WebAudio ile sentezlenir (havai fişek, gol düdüğü, beşlik, zar…).
// Tarayıcı ilk kullanıcı hareketinden önce ses çalmaya izin vermez; bağlam ilk tıklamada açılır.
import { settings } from "../settings";

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    return null;
  }
  // Beyaz gürültü (patlama, kalabalık, şut için)
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

for (const ev of ["pointerdown", "keydown"]) {
  addEventListener(ev, () => void audio()?.resume().catch(() => {}), { once: false, passive: true });
}

function out(gain: number, pan = 0): { ac: AudioContext; node: AudioNode } | null {
  const ac = audio();
  const v = settings.sfxVolume * gain;
  if (!ac || ac.state !== "running" || v <= 0.001) return null;
  const g = ac.createGain();
  g.gain.value = v;
  const p = ac.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  g.connect(p).connect(ac.destination);
  return { ac, node: g };
}

function tone(freq: number, dur: number, type: OscillatorType, gain: number, at = 0, slide = 0): void {
  const o = out(gain);
  if (!o) return;
  const { ac, node } = o;
  const t = ac.currentTime + at;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(1, t + 0.01);
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(env).connect(node);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function burst(dur: number, gain: number, filter: number, at = 0, pan = 0): void {
  const o = out(gain, pan);
  if (!o || !noise) return;
  const { ac, node } = o;
  const t = ac.currentTime + at;
  const src = ac.createBufferSource();
  src.buffer = noise;
  const f = ac.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.setValueAtTime(filter, t);
  f.frequency.exponentialRampToValueAtTime(80, t + dur);
  const env = ac.createGain();
  env.gain.setValueAtTime(1, t);
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f).connect(env).connect(node);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

/** Uzaklığa göre ses (yakın tam, 60 m'de sessiz). */
export function falloff(d: number): number {
  return Math.max(0, 1 - d / 60);
}

export const sfx = {
  /** Havai fişek: yükselen ıslık, gecikmeli patlama. */
  firework(delay: number, gain = 1, pan = 0): void {
    tone(900, 0.7, "sine", 0.05 * gain, Math.max(0, delay - 0.7), 1400);
    burst(1.4, 0.5 * gain, 1800, delay, pan);
    burst(0.3, 0.3 * gain, 5000, delay, pan);
  },
  whistle(): void {
    tone(2600, 0.25, "square", 0.05);
    tone(2600, 0.5, "square", 0.05, 0.3);
  },
  kick(gain = 1): void {
    burst(0.12, 0.35 * gain, 900);
    tone(110, 0.12, "sine", 0.25 * gain, 0, -60);
  },
  /** Kafa vuruşu: boğuk tok ses. */
  header(gain = 1): void {
    burst(0.08, 0.3 * gain, 500);
    tone(160, 0.1, "sine", 0.2 * gain, 0, -50);
  },
  /** Direk: metalik çınlama. */
  post(gain = 1): void {
    tone(1180, 0.6, "triangle", 0.09 * gain);
    tone(1730, 0.45, "sine", 0.06 * gain, 0.005);
    tone(2950, 0.25, "sine", 0.04 * gain, 0.01);
    burst(0.05, 0.25 * gain, 6000);
  },
  /** Kalabalık tezahüratı: kabaran ve sönen uğultu. */
  cheer(gain = 1): void {
    for (let i = 0; i < 6; i++) burst(1.6 - i * 0.12, 0.12 * gain, 1400 + i * 300, i * 0.08);
    tone(2600, 0.25, "square", 0.04 * gain, 0.05);
  },
  clap(): void {
    burst(0.08, 0.45, 4000);
    burst(0.1, 0.3, 3000, 0.02);
  },
  pop(): void {
    tone(660, 0.12, "sine", 0.12, 0, 300);
  },
  dice(): void {
    for (let i = 0; i < 5; i++) burst(0.04, 0.25, 3500, i * 0.07 + Math.random() * 0.03);
  },
  tile(): void {
    tone(1400, 0.05, "triangle", 0.1);
    burst(0.05, 0.12, 6000);
  },
  quest(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, "triangle", 0.09, i * 0.09));
  },
  splash(gain = 1): void {
    burst(0.5, 0.35 * gain, 2200);
  },
  thunder(): void {
    burst(2.6, 0.7, 400, 0.4);
    burst(0.4, 0.4, 1600, 0.3);
  },
  /** Ezan kaydı yoksa vakit girince: yumuşak, yankılı çan. */
  chime(gain = 1): void {
    [392, 523, 659].forEach((f, i) => tone(f, 2.2, "sine", 0.07 * gain, i * 0.5));
    tone(196, 3, "sine", 0.05 * gain, 1.4);
  },
  /** Yarış geri sayımı: kısa bip, başlarken tiz. */
  beep(go = false): void {
    tone(go ? 1320 : 660, go ? 0.45 : 0.18, "square", 0.06);
  },
  /** Oyuncak arabalar çarpıştı. */
  bump(gain = 1): void {
    burst(0.07, 0.3 * gain, 2500);
    tone(220, 0.08, "triangle", 0.12 * gain, 0, -80);
  },
  /** Araba kornası (iki ton birlikte, kısa ya da uzun). */
  horn(gain = 1, long = false): void {
    const d = long ? 0.6 : 0.28;
    tone(415, d, "square", 0.05 * gain);
    tone(523, d, "square", 0.04 * gain);
  },
  /** Nitro ateşlendi: yükselen vınlama. */
  boost(): void {
    tone(240, 0.5, "sawtooth", 0.035, 0, 520);
    burst(0.35, 0.18, 3000);
  },
  shutter(): void {
    burst(0.05, 0.4, 7000);
    burst(0.06, 0.3, 5000, 0.08);
  },
  /** Casino: kart kayışı, çip, makara durması, rulet topunun tıkırtısı, kazanç. */
  card(): void {
    burst(0.07, 0.22, 5200);
  },
  chip(): void {
    tone(2100, 0.05, "triangle", 0.07);
    tone(2900, 0.04, "triangle", 0.05, 0.03);
  },
  reel(): void {
    tone(180, 0.09, "square", 0.06, 0, -80);
    burst(0.05, 0.15, 1800);
  },
  tick(gain = 1): void {
    tone(3200, 0.02, "square", 0.025 * gain);
  },
  /** Yarış: start lambası bip'i (son lambada ince), start (yükselen), tur ve bitiş. */
  raceBeep(go = false): void {
    if (go) [880, 1175].forEach((f, i) => tone(f, 0.28, "square", 0.06, i * 0.06));
    else tone(440, 0.16, "square", 0.05);
  },
  lap(): void {
    [784, 988].forEach((f, i) => tone(f, 0.16, "triangle", 0.08, i * 0.1));
  },
  win(big = false): void {
    (big ? [523, 659, 784, 1047, 1319, 1568] : [659, 784, 1047]).forEach((f, i) => tone(f, 0.22, "triangle", 0.09, i * 0.08));
  },
};
