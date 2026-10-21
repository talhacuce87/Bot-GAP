// İstanbul'un anlık havası (Open-Meteo, anahtarsız): 10 dakikada bir sorulur, değişince odalara yayınlanır.
// Erişilemezse son bilinen hava kalır (ilk açılışta açık hava). WORLD_WEATHER=rain gibi sabitlenebilir (test).
import type { Weather, WeatherKind } from "../../shared/protocol";

const URL =
  "https://api.open-meteo.com/v1/forecast?latitude=41.01&longitude=28.98&current=weather_code,precipitation,cloud_cover,temperature_2m";
const POLL_MS = 10 * 60 * 1000;

/** WMO hava kodu → dünyadaki hava. */
export function fromWmo(code: number, precipitation: number, cloudCover: number, temp: number | null): Weather {
  let kind: WeatherKind = "clear";
  if (code >= 95) kind = "storm";
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) kind = "snow";
  else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) kind = "rain";
  else if (code === 45 || code === 48) kind = "fog";
  else if (code >= 2 || cloudCover >= 60) kind = "cloudy";
  // Şiddet: çiseleme hafif, sağanak/fırtına yoğun; ölçüm varsa mm/sa'ten
  const base = kind === "storm" ? 1 : [61, 63, 65, 66, 67, 73, 75, 81, 82, 86].includes(code) ? 0.75 : 0.45;
  const intensity = kind === "rain" || kind === "snow" || kind === "storm" ? Math.min(1, Math.max(base, precipitation / 4)) : 0;
  return { kind, intensity, cloud: Math.min(1, Math.max(0, cloudCover / 100)), temp };
}

const FIXED: Record<string, Weather> = {
  clear: { kind: "clear", intensity: 0, cloud: 0.15, temp: 22 },
  cloudy: { kind: "cloudy", intensity: 0, cloud: 0.85, temp: 16 },
  fog: { kind: "fog", intensity: 0, cloud: 0.9, temp: 9 },
  rain: { kind: "rain", intensity: 0.7, cloud: 1, temp: 12 },
  storm: { kind: "storm", intensity: 1, cloud: 1, temp: 14 },
  snow: { kind: "snow", intensity: 0.7, cloud: 1, temp: -1 },
};

export class WeatherWatch {
  current: Weather = FIXED.clear;
  onChange: (w: Weather) => void = () => {};
  private timer: NodeJS.Timeout | null = null;

  start(fixed = process.env.WORLD_WEATHER): void {
    if (fixed && FIXED[fixed]) {
      this.current = FIXED[fixed];
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    try {
      const r = await fetch(URL, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const c = ((await r.json()) as { current?: Record<string, number> }).current;
      if (!c) return;
      const w = fromWmo(c.weather_code ?? 0, c.precipitation ?? 0, c.cloud_cover ?? 0, typeof c.temperature_2m === "number" ? Math.round(c.temperature_2m) : null);
      const changed = w.kind !== this.current.kind || Math.abs(w.intensity - this.current.intensity) > 0.1 || Math.abs(w.cloud - this.current.cloud) > 0.15;
      this.current = w;
      if (changed) this.onChange(w);
    } catch (err) {
      console.warn("[weather]", (err as Error).message);
    }
  }

  /** "!hava" cevabı. */
  describe(): string {
    const w = this.current;
    const label: Record<WeatherKind, string> = {
      clear: "☀️ Açık", cloudy: "☁️ Bulutlu", fog: "🌫️ Sisli", rain: "🌧️ Yağmurlu", storm: "⛈️ Fırtınalı", snow: "❄️ Karlı",
    };
    return `İstanbul şu an: ${label[w.kind]}${w.temp !== null ? ` · ${w.temp}°C` : ""} — dünyadaki hava da böyle.`;
  }
}
