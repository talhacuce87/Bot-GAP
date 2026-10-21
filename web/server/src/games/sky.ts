// Dünyanın saati ve havası: "!saat gece", "!hava yağmur". Yetkili rol (botta) hemen değiştirir, diğerleri oylama açar.
// Sabitlenen saat/hava bir süre sonra kendiliğinden gerçeğe (Türkiye saati, İstanbul'un havası) döner.
import type { Weather, WeatherKind } from "../../../shared/protocol";
import { CHAT_HISTORY } from "../chat";
import type { Conn, Room } from "../room";

/** Sabitleme bu kadar sürer; sonra gerçek saate/havaya dönülür. */
export const SKY_HOLD_MS = 2 * 60 * 60 * 1000;
/** Oy bu süre içinde toplanmazsa düşer. */
export const VOTE_TTL_MS = 60_000;

/** "!saat" değerleri (Türkiye saati); `null` gerçek saate dön. */
const HOURS: Record<string, number | null> = {
  sabah: 8, gunduz: 13, ogle: 13, ogleden: 15, aksam: 19.5, gunbatimi: 19.5, batim: 19.5, gece: 22, geceyarisi: 0,
  normal: null, gercek: null, sifirla: null, oto: null,
};
const HOUR_LABELS: [number, string][] = [[0, "🌌 gece yarısı"], [8, "🌅 sabah"], [13, "☀️ gündüz"], [15, "🌤️ öğleden sonra"], [19.5, "🌇 akşam"], [22, "🌙 gece"]];

/** "!hava" değerleri; `null` İstanbul'un havasına dön. */
const WEATHERS: Record<string, WeatherKind | null> = {
  acik: "clear", gunesli: "clear", gunes: "clear", bulutlu: "cloudy", bulut: "cloudy", sis: "fog", sisli: "fog",
  yagmur: "rain", yagmurlu: "rain", firtina: "storm", firtinali: "storm", kar: "snow", karli: "snow",
  normal: null, gercek: null, sifirla: null, oto: null,
};
const FIXED: Record<WeatherKind, Weather> = {
  clear: { kind: "clear", intensity: 0, cloud: 0.15, temp: null },
  cloudy: { kind: "cloudy", intensity: 0, cloud: 0.85, temp: null },
  fog: { kind: "fog", intensity: 0, cloud: 0.9, temp: null },
  rain: { kind: "rain", intensity: 0.7, cloud: 1, temp: null },
  storm: { kind: "storm", intensity: 1, cloud: 1, temp: null },
  snow: { kind: "snow", intensity: 0.7, cloud: 1, temp: null },
};
export const WEATHER_LABELS: Record<WeatherKind, string> = {
  clear: "☀️ açık", cloudy: "☁️ bulutlu", fog: "🌫️ sisli", rain: "🌧️ yağmurlu", storm: "⛈️ fırtınalı", snow: "❄️ karlı",
};

/** "gece" → 22, "21" → 21, "21:30" → 21.5, "normal" → null; anlaşılmazsa undefined. Girdi foldName'den geçmiş olmalı. */
export function parseHour(arg: string): number | null | undefined {
  const key = arg.replace(/\s+/g, "");
  if (key in HOURS) return HOURS[key];
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(key);
  if (!m) return undefined;
  const h = Number(m[1]), min = m[2] ? Number(m[2]) : 0;
  return h < 24 && min < 60 ? h + min / 60 : undefined;
}

export function parseWeather(arg: string): WeatherKind | null | undefined {
  const key = arg.replace(/\s+/g, "");
  return key in WEATHERS ? WEATHERS[key] : undefined;
}

export function hourLabel(h: number): string {
  const named = HOUR_LABELS.find(([v]) => Math.abs(v - h) < 0.01);
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return named ? `${named[1]} (${clock})` : `🕐 ${clock}`;
}

export class Sky {
  /** Sabit saat (Türkiye saati), null: gerçek saat. */
  hour: number | null = null;
  private hourUntil = 0;
  private fixedWeather: Weather | null = null;
  private weatherUntil = 0;
  /** "saat:22" → oy verenler. */
  private votes = new Map<string, { voters: Set<number>; at: number }>();

  constructor(
    private room: Room,
    private live: () => Weather,
  ) {}

  /** Odada geçerli hava: sabitlenmişse o, değilse İstanbul'unki. */
  weather(): Weather {
    return this.fixedWeather ?? this.live();
  }

  /** İstanbul'un havası değişti: sabit hava yoksa yayınla. */
  liveChanged(): void {
    if (!this.fixedWeather) this.room.broadcast({ t: "weather", weather: this.live() });
  }

  sendTo(conn: Conn): void {
    this.room.sendTo(conn, { t: "clock", hour: this.hour });
  }

  setHour(h: number | null, now = Date.now()): void {
    this.hour = h;
    this.hourUntil = h === null ? 0 : now + SKY_HOLD_MS;
    this.votes.delete(`saat:${h}`);
    this.room.broadcast({ t: "clock", hour: h });
  }

  setWeather(kind: WeatherKind | null, now = Date.now()): void {
    this.fixedWeather = kind ? FIXED[kind] : null;
    this.weatherUntil = kind ? now + SKY_HOLD_MS : 0;
    this.votes.delete(`hava:${kind}`);
    this.room.broadcast({ t: "weather", weather: this.weather() });
  }

  /** Oylamayı geçmek için gereken oy: tek başınaysan 1, yoksa odanın yarısı (en az 2, en çok 3). */
  needed(): number {
    let n = 0;
    for (const p of this.room.players.values()) if (!p.info.spectator) n++;
    return n <= 1 ? 1 : Math.min(3, Math.max(2, Math.ceil(n / 2)));
  }

  /** Oy ver; toplanan ve gereken oy sayısı döner (yeterliyse çağıran uygular). */
  vote(key: string, sid: number, now = Date.now()): { count: number; needed: number } {
    let v = this.votes.get(key);
    if (!v || now - v.at > VOTE_TTL_MS) {
      v = { voters: new Set(), at: now };
      this.votes.set(key, v);
    }
    v.voters.add(sid);
    return { count: v.voters.size, needed: this.needed() };
  }

  leave(sid: number): void {
    for (const v of this.votes.values()) v.voters.delete(sid);
  }

  tick(now: number): void {
    if (this.hour !== null && now > this.hourUntil) {
      this.setHour(null, now);
      this.room.say({ kind: "system", sid: 0, name: "Bot GAP", text: "🕐 Saat yeniden gerçek saate döndü.", at: now }, CHAT_HISTORY);
    }
    if (this.fixedWeather && now > this.weatherUntil) {
      this.setWeather(null, now);
      this.room.say({ kind: "system", sid: 0, name: "Bot GAP", text: "🌦️ Hava yeniden İstanbul'un havasına döndü.", at: now }, CHAT_HISTORY);
    }
    for (const [k, v] of this.votes) if (now - v.at > VOTE_TTL_MS) this.votes.delete(k);
  }
}
