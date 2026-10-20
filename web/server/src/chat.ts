// Oyun içi sohbet: oda içi mesajlar ve "!" komutları. Mesajlar yalnızca bellekte (oda geçmişi) tutulur.
// Komut cevapları yalnızca sorana gider; !izle sinemayı açar ve odaya "Katıl" düğmeli duyuru atar.
import type { ChatLine } from "../../shared/protocol";
import type { SessionUser } from "./auth";
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
};

export const HELP_TEXT =
  "Komutlar: !izle <link> (sinemayı aç) · !xp · !seri · !ses · !sıra · !gardırop · !yardım. " +
  "Diğer her şey odaya mesaj olarak gider.";

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
  /** İzleme odasındaysak !izle o odadaki videoyu değiştirir. */
  inWatch: boolean;
  reply(text: string, link?: ChatLine["link"]): void;
  announce(text: string, link?: ChatLine["link"]): void;
  /** Yalnızca istekte bulunana dış bağlantıyı açtırır. */
  open(url: string): void;
  /** Sinemayı aç / izleme odasında videoyu değiştir. */
  cinema(url: string): Promise<{ url: string; title: string } | { error: string }>;
  /** Sinema açma sıklığı sınırı (true: izin var). */
  cinemaAllowed(): boolean;
}

/** Komutu çalıştırır. Bilinmeyen komutta yardım önerir. */
export async function runCommand(ctx: ChatContext, cmd: string, args: string): Promise<void> {
  if (cmd === "yardim" || cmd === "help" || cmd === "komutlar") return ctx.reply(HELP_TEXT);

  if (cmd === "izle" || cmd === "sinema" || cmd === "watch") {
    if (!args) return ctx.reply("Kullanım: !izle <YouTube/Twitch/Kick ya da .mp4/.m3u8 linki>");
    if (!ctx.inWatch && (ctx.user.guest || !ctx.guild)) return ctx.reply("🎬 Sinema için dünyaya Discord'dan (ses kanalındaki Activity ile) gir.");
    if (!ctx.cinemaAllowed()) return ctx.reply("🎬 Biraz bekle, sinema az önce açıldı.");
    const r = await ctx.cinema(args);
    if ("error" in r) return ctx.reply(`🎬 ${r.error}`);
    if (ctx.inWatch) return; // izleme odasında video değişti; durum zaten herkese gitti
    ctx.open(r.url);
    ctx.announce(`🎬 ${ctx.user.name} sinemayı açtı: ${r.title}`, { url: r.url, label: "🍿 Katıl" });
    return;
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
