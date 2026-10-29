// Oyun içi sohbet: oda içi mesajlar ve "!" komutları. Mesajlar yalnızca bellekte (oda geçmişi) tutulur.
// Komut cevapları yalnızca sorana gider; !izle sinemayı açar ve odaya "Katıl" düğmeli duyuru atar.
import type { ChatLine, WeatherKind } from "../../shared/protocol";
import type { SessionUser } from "./auth";
import { hourLabel, parseHour, parseWeather, SKY_HOLD_MS, type Sky, WEATHER_LABELS } from "./games/sky";
import type { BotPost } from "./looks";

export const CHAT_MAX_LEN = 200;
export const CHAT_HISTORY = 30;
export const CHAT_COOLDOWN_MS = 600;
export const CINEMA_COOLDOWN_MS = 10_000;

/** Bot'un cevapladığı komutlar (takma ad → botun bildiği ad). */
export const BOT_COMMANDS: Record<string, string> = {
  xp: "xp", seviye: "xp", level: "xp", lvl: "xp",
  seri: "streak", streak: "streak",
  ses: "ses",
  sira: "rank", siralama: "rank", rank: "rank",
  lb: "top", liderlik: "top", top: "top", topxp: "top",
};

export const HELP_TEXT =
  "Komutlar: !izle <link> (sinemayı aç) · !kuyruk <link> (şarkı sıraya) · !kuyruk · !geç · !paylaş · !hava [yağmur…] · !saat [gece…] · !havaifişek · " +
  "!maç [dk] · !maç bitir · !ebelemece · !saklambaç · !katıl · !savaş · !otoyol · !xp · !seri · !ses · !sıra · !lb · !gardırop · !yardım. Diğer her şey odaya mesaj olarak gider.";

/** Kontrol karakterlerini atar, boşlukları sadeleştirir, uzunluğu sınırlar. Boşsa null. */
export function cleanChat(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, CHAT_MAX_LEN) : null;
}

/** Türkçe karakterlere duyarsız komut adı (!sıra = !sira, !gardırop = !gardirop). */
export function foldName(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

/** "!xp", "/izle link" → { cmd, args }; komut değilse null. */
export function parseCommand(text: string): { cmd: string; args: string } | null {
  const m = /^[!/](\S+)\s*(.*)$/s.exec(text);
  return m ? { cmd: foldName(m[1]), args: m[2].trim() } : null;
}

export interface ChatContext {
  user: SessionUser;
  sid: number;
  /** Activity'nin açıldığı (ya da izleme odasının ait olduğu) sunucu. */
  guild: string | null;
  /** Bot bağlı değilse (secret yok) null. */
  bot: BotPost | null;
  /** Tarayıcıdan izleme odasına gelen izleyici: video zaten açık, yeni sekme açılmaz. */
  inWatch: boolean;
  reply(text: string, link?: ChatLine["link"]): void;
  announce(text: string, link?: ChatLine["link"]): void;
  /** Yalnızca istekte bulunana dış bağlantıyı açtırır. */
  open(url: string): void;
  /** Sinemayı aç; odada sinema varsa videosunu değiştir (reused). */
  cinema(url: string): Promise<{ url: string; title: string; reused: boolean } | { error: string }>;
  /** Sinema açma sıklığı sınırı (true: izin var). */
  cinemaAllowed(): boolean;
  /** Saati/havayı oylamasız değiştirebilir mi (botta rol/yetki). */
  canControl(): Promise<boolean>;
  /** Dünya odasının oyunları (savaş odasında ve izleme odasında yok). */
  world?: WorldCommands;
}

export interface WorldCommands {
  weather(): string;
  /** false: bekleme süresi dolmadı. */
  fireworks(): boolean;
  /** Ebelemece/saklambaç turu aç; hata metni ya da null. */
  tag(mode: "ebelemece" | "saklambac"): string | null;
  tagJoin(): void;
  enqueue(url: string): Promise<string>;
  queueText(): string;
  skip(): void;
  /** Dünyanın saati ve havası (!saat, !hava <tür>). */
  sky?: Sky;
  /** Stadyumda futbol maçı: başlat (dakika; hata metni ya da null) / bitir / katıl / ayrıl. */
  match?: { start(minutes: number): string | null; end(): boolean; join(): string | null; leave(): boolean };
}

const HOLD_TEXT = `${SKY_HOLD_MS / 3_600_000} saat`;

/** !saat / !hava <değer>: yetkili hemen değiştirir, diğerleri oylama açar (aynı komutu yazan oy verir). */
async function skyCommand(ctx: ChatContext, sky: Sky, what: "saat" | "hava", args: string): Promise<void> {
  const arg = foldName(args);
  if (what === "saat" && !arg) {
    return ctx.reply(
      sky.hour === null
        ? "🕐 Dünya gerçek saatte (Türkiye). Değiştirmek için: !saat sabah / gündüz / akşam / gece / 21 / normal"
        : `🕐 Dünyanın saati ${hourLabel(sky.hour)} olarak sabit. !saat normal ile gerçek saate dönülür.`,
    );
  }
  const value = what === "saat" ? parseHour(arg) : parseWeather(arg);
  if (value === undefined) {
    return ctx.reply(
      what === "saat"
        ? "Kullanım: !saat sabah / gündüz / akşam / gece / 21 / 21:30 / normal"
        : "Kullanım: !hava açık / bulutlu / sis / yağmur / fırtına / kar / normal",
    );
  }
  const target =
    what === "saat"
      ? `saat → ${value === null ? "gerçek saat" : hourLabel(value as number)}`
      : `hava → ${value === null ? "İstanbul'un havası" : WEATHER_LABELS[value as WeatherKind]}`;
  const until = value === null ? "" : ` · ${HOLD_TEXT} sonra kendiliğinden gerçeğe döner`;
  const apply = () => (what === "saat" ? sky.setHour(value as number | null) : sky.setWeather(value as WeatherKind | null));
  if (await ctx.canControl()) {
    apply();
    return ctx.announce(`${what === "saat" ? "🕐" : "🌦️"} ${ctx.user.name}: ${target}${until}`);
  }
  const { count, needed } = sky.vote(`${what}:${value}`, ctx.sid);
  if (count >= needed) {
    apply();
    return ctx.announce(`🗳️ Oylama geçti (${count}/${needed}): ${target}${until}`);
  }
  ctx.announce(`🗳️ ${ctx.user.name} oylama açtı: ${target} (${count}/${needed}). Katılmak için 1 dk içinde !${what} ${args} yaz.`);
}

/** Komutu çalıştırır. Bilinmeyen komutta yardım önerir. */
export async function runCommand(ctx: ChatContext, cmd: string, args: string): Promise<void> {
  if (cmd === "yardim" || cmd === "help" || cmd === "komutlar") return ctx.reply(HELP_TEXT);

  if (cmd === "izle" || cmd === "sinema" || cmd === "watch") {
    if (!args) return ctx.reply("Kullanım: !izle <YouTube/Twitch/Kick ya da .mp4/.m3u8 linki>");
    if (!ctx.cinemaAllowed()) return ctx.reply("🎬 Biraz bekle, sinema az önce açıldı.");
    const r = await ctx.cinema(args);
    if ("error" in r) return ctx.reply(`🎬 ${r.error}`);
    if (!ctx.inWatch) ctx.open(r.url);
    const what = r.reused ? "videoyu değiştirdi" : "sinemayı açtı";
    ctx.announce(`🎬 ${ctx.user.name} ${what}: ${r.title}`, { url: r.url, label: "🍿 Tarayıcıda izle" });
    return;
  }

  const w = ctx.world;
  if (w?.sky && (cmd === "saat" || cmd === "zaman" || cmd === "time")) return skyCommand(ctx, w.sky, "saat", args);
  if (w?.sky && (cmd === "hava" || cmd === "weather") && args) return skyCommand(ctx, w.sky, "hava", args);
  if (cmd === "hava" || cmd === "weather") return ctx.reply(w ? w.weather() : "Hava bilgisi burada yok.");
  if (w && (cmd === "havaifisek" || cmd === "fisek" || cmd === "fireworks")) {
    if (!w.fireworks()) return ctx.reply("🎆 Biraz bekle, gökyüzü daha yeni aydınlandı.");
    return ctx.announce(`🎆 ${ctx.user.name} havai fişek attı!`);
  }
  if (w && (cmd === "ebelemece" || cmd === "saklambac")) {
    const err = w.tag(cmd);
    if (err) return ctx.reply(err);
    const label = cmd === "ebelemece" ? "🏃 Ebelemece" : "🙈 Saklambaç";
    return ctx.announce(`${label}: ${ctx.user.name} oyun açtı! 20 sn içinde !katıl yaz (ya da düğmeye bas).`);
  }
  if (w && cmd === "katil") return w.tagJoin();
  if (w && (cmd === "kuyruk" || cmd === "queue" || cmd === "sarki")) {
    if (!args) return ctx.reply(w.queueText());
    if (!ctx.cinemaAllowed()) return ctx.reply("🎵 Biraz bekle, az önce eklendi.");
    return ctx.reply(await w.enqueue(args));
  }
  if (w && (cmd === "gec" || cmd === "skip")) return w.skip();
  if (w?.match && (cmd === "mac" || cmd === "match")) {
    const sub = foldName(args);
    if (/^(bitir|dur|son)$/.test(sub)) return w.match.end() ? undefined : ctx.reply("⚽ Süren bir maç yok.");
    if (/^(katil|gir|join)$/.test(sub)) {
      const err = w.match.join();
      return err ? ctx.reply(err) : undefined;
    }
    if (/^(ayril|cik|leave)$/.test(sub)) return w.match.leave() ? undefined : ctx.reply("⚽ Bir maçta değilsin.");
    const minutes = Math.round(Math.max(1, Math.min(15, Number(args) || 5)));
    const err = w.match.start(minutes);
    if (err) return ctx.reply(err);
    return ctx.announce(
      `🏟️ ${ctx.user.name} maç başlattı (${minutes} dk)! Sahadakiler stadyuma ışınlandı: batı yarısındakiler 🔴 Kırmızı, doğudakiler 🔵 Mavi. Katılmak için !maç katıl, çıkmak için !maç ayrıl.`,
    );
  }

  const botCmd = BOT_COMMANDS[cmd];
  if (botCmd) {
    if (ctx.user.guest || !ctx.guild) return ctx.reply("Bu komut için dünyaya Discord'dan gir.");
    if (!ctx.bot) return ctx.reply("Bot şu an bağlı değil.");
    try {
      const r = await ctx.bot("/internal/command", { guild: ctx.guild, user: ctx.user.id, command: botCmd });
      const text = typeof r.body.text === "string" ? r.body.text : null;
      return ctx.reply(r.ok && text ? text : "Komut çalıştırılamadı, biraz sonra tekrar dene.");
    } catch {
      return ctx.reply("Bot şu an cevap vermiyor.");
    }
  }

  ctx.reply(`Bilinmeyen komut: !${cmd} — !yardım yaz.`);
}
