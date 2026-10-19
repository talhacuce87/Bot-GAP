// Sakura Bahçesi'ne girişte: pembe tam ekran parlama, yukarıdan süzülen yapraklar, esinti ve rüzgâr çanı.
// Görseller CSS animasyonu (bitince DOM'dan silinir), ses Web Audio ile üretilir; dosya yok.

const PETALS = 26;
/** "Hareketi azalt" açıksa: yumuşak parlama, daha az yaprak. */
const CALM_PETALS = 10;
const PETAL_COLORS = ["#fedfe1", "#f9c6cf", "#f4a9bb", "#ffeef0"];
/** Pentatonik, yüksek perdeli çan notaları (Hz). */
const CHIME_NOTES = [1046.5, 1174.7, 1396.9, 1568.0, 1760.0, 2093.0];

let audio: AudioContext | null = null;

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Pembe gürültüye yakın: beyaz gürültünün basit alçak geçirgeni, rüzgâr daha yumuşak duyulur.
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    last = last * 0.97 + (Math.random() * 2 - 1) * 0.03;
    data[i] = last * 6;
  }
  return buf;
}

function playWindAndChimes(volume = 0.5): void {
  try {
    audio ??= new AudioContext();
  } catch {
    return; // Web Audio yok: sessiz geç
  }
  const ctx = audio;
  void ctx.resume();
  const t0 = ctx.currentTime + 0.05;
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);

  // Derinden gelen esinti: süzgeci açılıp kapanan gürültü
  const wind = ctx.createBufferSource();
  wind.buffer = noiseBuffer(ctx, 4);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.8;
  band.frequency.setValueAtTime(260, t0);
  band.frequency.linearRampToValueAtTime(720, t0 + 1.6);
  band.frequency.linearRampToValueAtTime(320, t0 + 3.8);
  const windGain = ctx.createGain();
  windGain.gain.setValueAtTime(0, t0);
  windGain.gain.linearRampToValueAtTime(0.5, t0 + 1.2);
  windGain.gain.linearRampToValueAtTime(0, t0 + 3.9);
  wind.connect(band).connect(windGain).connect(master);
  wind.start(t0);
  wind.stop(t0 + 4);

  // Rüzgâr çanı: rastgele sırada birkaç vuruş, her biri çan kısmisiyle (×2.76) uzun sönümlü
  const notes = [...CHIME_NOTES].sort(() => Math.random() - 0.5).slice(0, 5);
  notes.forEach((f, i) => {
    const at = t0 + 0.5 + i * 0.32 + Math.random() * 0.18;
    for (const [mult, amp] of [[1, 0.09], [2.76, 0.03]]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(amp, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 2.6);
      osc.connect(g).connect(master);
      osc.start(at);
      osc.stop(at + 2.7);
    }
  });
}

/** Bahçeye girişin görsel ve işitsel karşılaması. */
export function sakuraEntrance(): void {
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const flash = document.createElement("div");
  flash.className = calm ? "sakura-flash calm" : "sakura-flash";
  flash.addEventListener("animationend", () => flash.remove());
  document.body.append(flash);

  {
    const layer = document.createElement("div");
    layer.className = "sakura-petals";
    let longest = 0;
    for (let i = 0; i < (calm ? CALM_PETALS : PETALS); i++) {
      const fall = document.createElement("span");
      fall.className = "sakura-fall";
      const dur = 5 + Math.random() * 4, delay = Math.random() * 2.2;
      longest = Math.max(longest, dur + delay);
      fall.style.left = `${Math.random() * 100}%`;
      fall.style.animationDuration = `${dur}s`;
      fall.style.animationDelay = `${delay}s`;
      const petal = document.createElement("span");
      petal.className = "sakura-petal";
      const size = 9 + Math.random() * 10;
      petal.style.width = `${size}px`;
      petal.style.height = `${size * 0.72}px`;
      petal.style.background = PETAL_COLORS[i % PETAL_COLORS.length];
      petal.style.animationDuration = `${1.6 + Math.random() * 1.6}s`;
      petal.style.animationDelay = `${-Math.random() * 2}s`;
      fall.append(petal);
      layer.append(fall);
    }
    document.body.append(layer);
    window.setTimeout(() => layer.remove(), (longest + 0.5) * 1000);
  }

  playWindAndChimes();
}
