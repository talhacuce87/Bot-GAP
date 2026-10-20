import { describe, expect, it } from "vitest";
import type { ChatLine, ServerEvent } from "../shared/protocol";
import { type ChatContext, cleanChat, HELP_TEXT, parseCommand, runCommand } from "../server/src/chat";
import { type Conn, Room } from "../server/src/room";

const member = { id: "5", name: "Barış", avatar: null, guest: false };
const guest = { id: "guest-1", name: "Misafir", avatar: null, guest: true };

function ctx(over: Partial<ChatContext> = {}) {
  const out = { replies: [] as string[], announced: [] as { text: string; link?: ChatLine["link"] }[], opened: [] as string[], botCalls: [] as unknown[] };
  let allowed = true;
  const c: ChatContext = {
    user: member,
    sid: 3,
    guild: "1",
    inWatch: false,
    bot: async (path, body) => {
      out.botCalls.push([path, body]);
      return { ok: true, body: { text: "⭐ Seviye 4" } };
    },
    reply: (t) => out.replies.push(t),
    announce: (text, link) => out.announced.push({ text, link }),
    open: (url) => out.opened.push(url),
    cinema: async () => ({ url: "https://gap.example/w/abc123", title: "Maç özeti" }),
    cinemaAllowed: () => {
      const a = allowed;
      allowed = false;
      return a;
    },
    ...over,
  };
  return { c, out };
}

describe("sohbet metni", () => {
  it("kontrol karakterlerini atar, boşlukları sadeleştirir, uzunluğu sınırlar", () => {
    expect(cleanChat("  merhaba \n\t dünya  ")).toBe("merhaba dünya");
    expect(cleanChat(`a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)}c`)).toBe("a b c");
    expect(cleanChat("x".repeat(500))).toHaveLength(200);
    expect(cleanChat("   ")).toBeNull();
    expect(cleanChat(42)).toBeNull();
  });

  it("komutları Türkçe karakterlere duyarsız ayrıştırır", () => {
    expect(parseCommand("!Sıra")).toEqual({ cmd: "sira", args: "" });
    expect(parseCommand("/izle https://youtu.be/x  ")).toEqual({ cmd: "izle", args: "https://youtu.be/x" });
    expect(parseCommand("merhaba !xp")).toBeNull();
  });
});

describe("komutlar", () => {
  it("!yardım ve bilinmeyen komut", async () => {
    const { c, out } = ctx();
    await runCommand(c, "yardim", "");
    await runCommand(c, "uç", "");
    expect(out.replies[0]).toBe(HELP_TEXT);
    expect(out.replies[1]).toContain("Bilinmeyen komut");
  });

  it("bot komutları bota gider, cevap yalnızca sorana", async () => {
    const { c, out } = ctx();
    await runCommand(c, "seviye", "");
    expect(out.botCalls).toEqual([["/internal/command", { guild: "1", user: "5", command: "xp" }]]);
    expect(out.replies).toEqual(["⭐ Seviye 4"]);
    expect(out.announced).toEqual([]);
  });

  it("misafir ve bot yokken kibar cevap", async () => {
    const g = ctx({ user: guest, guild: null });
    await runCommand(g.c, "xp", "");
    expect(g.out.replies[0]).toContain("Discord'dan");
    const nobot = ctx({ bot: null });
    await runCommand(nobot.c, "xp", "");
    expect(nobot.out.replies[0]).toContain("bağlı değil");
    const down = ctx({ bot: async () => { throw new Error("ECONNREFUSED"); } });
    await runCommand(down.c, "xp", "");
    expect(down.out.replies[0]).toContain("cevap vermiyor");
  });

  it("!izle sinemayı açar, açana bağlantıyı açtırır, odaya Katıl düğmesi atar", async () => {
    const { c, out } = ctx();
    await runCommand(c, "izle", "https://youtu.be/abc");
    expect(out.opened).toEqual(["https://gap.example/w/abc123"]);
    expect(out.announced[0].text).toContain("Barış sinemayı açtı: Maç özeti");
    expect(out.announced[0].link).toEqual({ url: "https://gap.example/w/abc123", label: "🍿 Katıl" });
    // Hemen ikinci kez: sınır
    await runCommand(c, "izle", "https://youtu.be/def");
    expect(out.replies.at(-1)).toContain("Biraz bekle");
  });

  it("!izle: link yoksa kullanım, açılamazsa hata, misafire izin yok", async () => {
    const a = ctx();
    await runCommand(a.c, "izle", "");
    expect(a.out.replies[0]).toContain("Kullanım");
    const bad = ctx({ cinema: async () => ({ error: "Bu link açılamıyor." }) });
    await runCommand(bad.c, "izle", "nope");
    expect(bad.out.replies[0]).toContain("açılamıyor");
    expect(bad.out.opened).toEqual([]);
    const g = ctx({ user: guest, guild: null });
    await runCommand(g.c, "izle", "https://youtu.be/abc");
    expect(g.out.replies[0]).toContain("Discord'dan");
  });

  it("izleme odasında !izle yalnızca videoyu değiştirir (duyuru ve yeni sekme yok)", async () => {
    const { c, out } = ctx({ inWatch: true, guild: null });
    await runCommand(c, "izle", "https://youtu.be/abc");
    expect(out.opened).toEqual([]);
    expect(out.announced).toEqual([]);
  });
});

describe("oda sohbeti", () => {
  it("mesajı herkese yayınlar ve geçmişi sınırlı tutar", () => {
    const text: ServerEvent[] = [];
    const conn: Conn = { bufferedAmount: 0, send: (d) => typeof d === "string" && text.push(JSON.parse(d)) };
    const room = new Room("d:x");
    room.join(member, conn);
    for (let i = 0; i < 40; i++) room.say({ kind: "say", sid: 1, name: "a", text: `m${i}`, at: i }, 30);
    expect(room.chat).toHaveLength(30);
    expect(room.chat[0].text).toBe("m10");
    expect(text.at(-1)).toEqual({ t: "chat", line: { kind: "say", sid: 1, name: "a", text: "m39", at: 39 } });
  });
});
