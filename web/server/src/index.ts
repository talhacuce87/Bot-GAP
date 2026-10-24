// GAP Dünyası sunucusu: statik istemci, Discord giriş API'si, avatar proxy'si ve WebSocket odaları.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { ACT_COOLDOWN_MS, type Act, ACTS, actSpot, EMOTE_COOLDOWN_MS, EMOTES, FISH_COOLDOWN_MS, FISH_SPOT, TICK_HZ } from "../../shared/constants";
import { decodeState, type FishCatch, type Look, type PlayerState, type Profile, type QuestDone, type ServerEvent } from "../../shared/protocol";
import { validCar } from "../../shared/car";
import { Casino, type CasinoMsg, secureRng, Wallets } from "./casino";
import { RingHost, type RingMsg } from "./ring";
import { LiveHost, type LiveMsg } from "./liveTables";
import { CASINO } from "../../shared/zones";
import { cleanName, exchangeCode, type SessionUser, signSession, signValue, verifySession, verifyValue } from "./auth";
import { type Board, Boards } from "./board";
import { CHAT_COOLDOWN_MS, CHAT_HISTORY, CINEMA_COOLDOWN_MS, cleanChat, parseCommand, runCommand } from "./chat";
import { type BotPost, fetchLook, fetchWardrobe, OUTFIT_COOLDOWN_MS, sanitizeLook, saveLook, WARDROBE_COOLDOWN_MS } from "./looks";
import { type Conn, type JoinOptions, type Room, Rooms } from "./room";
import { type FastLink, setupRtc } from "./rtc";
import { MediaProxy } from "./mediaProxy";
import type { Source } from "../../shared/media";
import { resolveMedia, type Watch, Watches } from "./watch";
import { type Share, SHARE_MIME, Shares } from "./share";
import { WorldGames } from "./games/world";
import { WeatherWatch } from "./weather";
import { Builds, flushBuilds } from "./games/build";

/** Sinema videosu (dosya/HLS) sunucu üzerinden: Activity'de perdede oynar. */
const mediaProxy = new MediaProxy();

/** İzleme odasının tarayıcı adresi. */
function watchLink(w: Watch): string {
  return `${PUBLIC_URL || "http://localhost:5173"}/w/${w.id}`;
}

const PORT = Number(process.env.PORT || 3000);
/** Kalıcı küçük veriler (casino bakiyeleri); Docker'da volume. */
const DATA_DIR = process.env.WORLD_DATA_DIR || "data";
const casino = new Casino(new Wallets(join(DATA_DIR, "casino-wallets.json")));
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const SHARED_SECRET = process.env.WORLD_SHARED_SECRET || "";
const ALLOW_GUESTS = (process.env.WORLD_ALLOW_GUESTS ?? "true").toLowerCase() !== "false";
// Ortak secret yoksa oturumlar sadece bu süreç ömrü boyunca geçerlidir.
const SESSION_SECRET = SHARED_SECRET || randomBytes(32).toString("hex");
/** Tarayıcıdan erişilen adres (bot'un attığı izleme linkleri ve OAuth dönüşü için). */
const PUBLIC_URL = (process.env.WORLD_PUBLIC_URL || "").replace(/\/+$/, "");
/** Hızlı yol (WebRTC/UDP) portu; boşsa kapalı. Konteynerde aynı port UDP olarak dışarı açılmalı. */
const RTC_PORT = Number(process.env.WORLD_RTC_PORT || 0);
/** Hızlı yolun duyurulacak genel IP'si; boşsa sunucu STUN'la kendisi öğrenir. */
const RTC_IP = process.env.WORLD_RTC_IP || "";
/** Discord ayarlıysa izleme odalarına yalnızca Discord ile giriş yapanlar girer. */
const LOGIN_REQUIRED = !!(CLIENT_ID && CLIENT_SECRET);
const SESSION_COOKIE = "gw_session";
/** Botun iç HTTP ucu: balık zarı, seri ve XP boost'u orada (fishing.py). */
const BOT_URL = (process.env.BOT_INTERNAL_URL || "http://bot-gap:8081").replace(/\/+$/, "");

const STATIC_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../client");
/**
 * Tek dünya: kim nereden girerse girsin (hangi ses kanalı, Activity örneği, tarayıcı) aynı odaya düşer.
 * Tank savaşı da tek: "b:" + bu anahtar.
 */
const WORLD_ROOM = "dunya";
/**
 * Dünyanın Discord sunucusu: tarayıcıdan Discord hesabıyla girenin XP/balık/ev kayıtları buraya yazılır.
 * WORLD_GUILD_ID yoksa en son Activity'den gelen sunucu.
 */
const DEFAULT_GUILD = /^\d{5,20}$/.test(process.env.WORLD_GUILD_ID || "") ? process.env.WORLD_GUILD_ID! : null;
let lastGuild: string | null = null;
/** Botun bulunduğu sunucular (sürgün listesiyle her 20 sn'de gelir): tek sunucuysa dünyanın sunucusu odur. */
let botGuilds: string[] = [];
function worldGuild(): string | null {
  return DEFAULT_GUILD || lastGuild || botGuilds[0] || null;
}
/**
 * İstemci sürümü: derlenmiş sayfanın ana betiği (adında içerik özeti var). Bağlanan eski sürümdeyse
 * kendini yeniler; deploy sonrası herkes yeni koda kendiliğinden geçer. Geliştirmede (dist yok) null.
 */
const CLIENT_VERSION = (() => {
  try {
    return /\/assets\/(index-[\w-]+\.js)"/.exec(readFileSync(join(STATIC_DIR, "index.html"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
})();

const rooms = new Rooms();
const watches = new Watches();
const rtc = await setupRtc(RTC_PORT, RTC_IP);
/** İstemcilerin son bağlantı özeti (30 sn'de bir gelir); dakikada bir loga yazılır. */
const netStats = new Map<WebSocket, { rtt: number; ws: number; loss: number; delay: number; starve: number; udp: boolean; at: number }>();
/** Oda başına ekran paylaşımı (oda anahtarıyla). */
const shares = new Shares();

const boards = new Boards();

/** İstanbul'un havası: değişince bütün dünya odalarına. */
const weather = new WeatherWatch();
weather.onChange = (w) => {
  for (const room of rooms.all()) {
    if (room.games) room.games.sky.liveChanged();
    else if (!room.battle) room.broadcast({ t: "weather", weather: w });
  }
};
weather.start();

// ---------------------------------------------------------------------------
// Görev olayları: bota toplu gider (aynı oyuncunun aynı olayı 3 sn içinde birleşir)
// ---------------------------------------------------------------------------

const pendingReports = new Map<string, { guild: string; user: string; event: string; amount: number; room: Room }>();

/** Tamamlanan görevleri o kullanıcının odadaki bağlantılarına bildirir. */
function notifyQuests(room: Room, userId: string, completed: unknown): void {
  if (!Array.isArray(completed) || !completed.length) return;
  const ev: ServerEvent = { t: "quest", completed: completed as QuestDone[] };
  for (const p of room.players.values()) if (p.user.id === userId) room.sendTo(p.conn, ev);
}

function reportEvent(room: Room, sid: number, event: string, amount = 1): void {
  const p = room.players.get(sid);
  if (!p || p.user.guest || !p.guild || !SHARED_SECRET || !(amount > 0)) return;
  const key = `${p.guild}:${p.user.id}:${event}`;
  const cur = pendingReports.get(key);
  if (cur) {
    cur.amount += amount;
    cur.room = room;
    return;
  }
  pendingReports.set(key, { guild: p.guild, user: p.user.id, event, amount, room });
  setTimeout(() => {
    const e = pendingReports.get(key);
    pendingReports.delete(key);
    if (!e) return;
    botPost("/internal/world_event", { guild: e.guild, user: e.user, event: e.event, amount: e.amount })
      .then((r) => notifyQuests(e.room, e.user, r.body.completed))
      .catch((err) => console.warn("[quest]", (err as Error).message));
  }, 3000);
}

/** Odanın sinemasını yükleyen ve soran yardımcı (kuyruk/DJ için). */
function stageHost(room: Room) {
  const guild = () => {
    for (const p of room.players.values()) if (p.guild) return p.guild;
    return null;
  };
  return {
    play: async (url: string, by: string) => {
      const r = await openCinema(url, guild(), by, room.key);
      if ("error" in r) return r;
      room.say({ kind: "system", sid: 0, name: "Bot GAP", text: `🎵 Sıradaki: ${r.title} (${by})`, at: Date.now() }, CHAT_HISTORY);
      return { title: r.title };
    },
    title: async (url: string) => {
      const m = await resolveMedia(url);
      return m && "title" in m ? m.title : null;
    },
    loadedAt: () => {
      const w = cinemaOf(room.key);
      return w?.state.source ? w.loadedAt : 0;
    },
  };
}

rooms.onCreate = (room) => {
  room.onReport = (sid, event, amount) => reportEvent(room, sid, event, amount);
  if (!room.battle) {
    room.games = new WorldGames(room, room.onReport, stageHost(room), () => weather.current);
    room.games.builds = new Builds(room, SHARED_SECRET ? botPost : null);
    // Yarış ödülü casino cüzdanına (test coin) gider
    room.ring = new RingHost(room, (sid, amount) => {
      const p = room.players.get(sid);
      if (!p) return;
      const key = p.user.guest ? `guest:${p.user.id}` : p.user.id;
      casino.wallets.add(key, amount);
      room.sendTo(p.conn, { t: "wallet", balance: casino.wallets.get(key) });
      room.sendTo(p.conn, { t: "notice", text: `🏆 Yarış ödülü: +${amount} GAP test coin` });
    });
    room.live = new LiveHost(room, casino.wallets, secureRng);
  }
};

function sendBoard(conn: Conn, board: Board | null): void {
  if (board) conn.send(JSON.stringify({ t: "board", updated: board.updated, entries: board.entries }));
}

// Bot'un gönderdiği sürgün listesi: sunucu id → sürgündeki kullanıcı id'leri.
let exiles = new Map<string, Set<string>>();

function isExiled(userId: string, guild: string | null): boolean {
  if (guild) return exiles.get(guild)?.has(userId) ?? false;
  for (const set of exiles.values()) if (set.has(userId)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTTP yardımcıları
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  return parsed && typeof parsed === "object" ? parsed : {};
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** İsteğin geldiği dış adres: WORLD_PUBLIC_URL, yoksa (geliştirme) Host başlığı. */
function publicBase(req: IncomingMessage): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}

function redirect(res: ServerResponse, to: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(302, { Location: to, "Cache-Control": "no-store", ...headers });
  res.end();
}

/** `/.proxy/` önekini (Discord Activity proxy'si) yok sayar. */
function routePath(url: string): string {
  const path = url.split("?")[0];
  return path.startsWith("/.proxy/") ? path.slice(7) : path;
}

// ---------------------------------------------------------------------------
// Statik dosyalar (bellekte gzip + brotli önbelleği)
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".obj": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".map": "application/json",
};
// .bin: chibi karakter paketi (~5.8 MB → ~2.9 MB gzip, ~2.4 MB brotli)
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".map", ".bin", ".obj"]);
// Sıkıştırma libuv iş parçacıklarında: senkron gzip büyük pakette olay döngüsünü (oyun simülasyonunu) ~200 ms kilitliyordu
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

interface CachedFile {
  raw: Buffer;
  gz: Buffer | null;
  br: Buffer | null;
  type: string;
}
/** Aynı dosyaya eşzamanlı ilk istekler tek okuma/sıkıştırmayı bekler. Bulunamayanlar saklanmaz (rastgele yol taraması belleği şişirmesin). */
const fileCache = new Map<string, Promise<CachedFile | null>>();

function loadStatic(rel: string): Promise<CachedFile | null> {
  let hit = fileCache.get(rel);
  if (!hit) {
    hit = readStatic(rel);
    fileCache.set(rel, hit);
    void hit.then((f) => f || fileCache.delete(rel));
  }
  return hit;
}

async function readStatic(rel: string): Promise<CachedFile | null> {
  const full = normalize(join(STATIC_DIR, rel));
  if (!full.startsWith(STATIC_DIR + sep)) return null;
  let raw: Buffer;
  try {
    raw = await readFile(full);
  } catch {
    return null;
  }
  const ext = extname(full);
  const pack = COMPRESSIBLE.has(ext) && raw.length > 1024;
  const [gz, br] = pack
    ? await Promise.all([
        gzipAsync(raw),
        brotliAsync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
      ])
    : [null, null];
  return { raw, gz, br, type: MIME[ext] || "application/octet-stream" };
}

/** Açılışta paketler önceden sıkıştırılır: ilk gelen oyuncu ~1 sn beklemesin. */
async function warmStatic(): Promise<void> {
  const files = await readdir(join(STATIC_DIR, "assets")).catch(() => [] as string[]);
  for (const f of ["index.html", ...files.map((f) => `assets/${f}`)]) await loadStatic(`/${f}`);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  let rel = path === "/" ? "/index.html" : path;
  let file = await loadStatic(rel);
  if (!file && !extname(rel)) {
    rel = "/index.html";
    file = await loadStatic(rel);
  }
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const accept = String(req.headers["accept-encoding"] || "");
  const enc = file.br && /\bbr\b/.test(accept) ? "br" : file.gz && /\bgzip\b/.test(accept) ? "gzip" : null;
  res.writeHead(200, {
    "Content-Type": file.type,
    "Cache-Control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    ...(file.gz ? { Vary: "Accept-Encoding" } : {}),
    ...(enc ? { "Content-Encoding": enc } : {}),
  });
  res.end(enc === "br" ? file.br : enc === "gzip" ? file.gz : file.raw);
}

// ---------------------------------------------------------------------------
// Avatar proxy'si: Discord CDN'i aynı origin'den sunar (Activity CSP'si + canvas CORS)
// ---------------------------------------------------------------------------

const AVATAR_CACHE_MAX = 500;
const avatarCache = new Map<string, Buffer>();

async function serveAvatar(res: ServerResponse, id: string, hash: string): Promise<void> {
  if (!/^\d{5,20}$/.test(id) || !/^(a_)?[0-9a-f]{32}$/.test(hash)) {
    res.writeHead(400).end();
    return;
  }
  const key = `${id}/${hash}`;
  let img = avatarCache.get(key);
  if (!img) {
    const r = await fetch(`https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=64`);
    if (!r.ok) {
      res.writeHead(404).end();
      return;
    }
    img = Buffer.from(await r.arrayBuffer());
    if (avatarCache.size >= AVATAR_CACHE_MAX) avatarCache.delete(avatarCache.keys().next().value!);
    avatarCache.set(key, img);
  }
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
  res.end(img);
}

/** YouTube küçük resmi aynı origin'den (Activity CSP'si dış görsele izin vermez); sinema perdesinde gösterilir. */
const thumbCache = new Map<string, Buffer>();

async function serveThumb(res: ServerResponse, id: string): Promise<void> {
  let img = thumbCache.get(id);
  if (!img) {
    const r = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (!r?.ok) {
      res.writeHead(404).end();
      return;
    }
    img = Buffer.from(await r.arrayBuffer());
    if (thumbCache.size >= AVATAR_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value!);
    thumbCache.set(id, img);
  }
  res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
  res.end(img);
}

// ---------------------------------------------------------------------------
// Rotalar
// ---------------------------------------------------------------------------

function secretMatches(given: string | string[] | undefined): boolean {
  if (!SHARED_SECRET || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(SHARED_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = routePath(req.url || "/");
  const method = req.method || "GET";

  if (path === "/health") return json(res, 200, { ok: true, rooms: [...rooms.all()].length });

  if (path === "/api/config" && method === "GET") {
    return json(res, 200, { clientId: CLIENT_ID, guests: ALLOW_GUESTS });
  }

  if (path === "/api/token" && method === "POST") {
    if (!CLIENT_ID || !CLIENT_SECRET) return json(res, 503, { error: "discord not configured" });
    const body = await readJson(req);
    if (typeof body.code !== "string") return json(res, 400, { error: "code required" });
    try {
      const { accessToken, user } = await exchangeCode(body.code, CLIENT_ID, CLIENT_SECRET);
      return json(res, 200, { access_token: accessToken, session: signSession(user, SESSION_SECRET), user });
    } catch (err) {
      console.warn("[auth]", (err as Error).message);
      return json(res, 401, { error: "auth failed" });
    }
  }

  if (path === "/api/guest" && method === "POST") {
    if (!ALLOW_GUESTS) return json(res, 403, { error: "guests disabled" });
    const body = await readJson(req);
    const user: SessionUser = {
      id: `guest-${randomBytes(6).toString("hex")}`,
      name: cleanName(body.name, `Misafir-${Math.floor(Math.random() * 9000 + 1000)}`),
      avatar: null,
      guest: true,
    };
    return json(res, 200, { session: signSession(user, SESSION_SECRET), user });
  }

  // ---- Tarayıcıdan Discord girişi (izleme odaları Activity dışında açılır) ----
  if (path === "/auth/login" && method === "GET") {
    const lq = new URL(req.url || "/", "http://x").searchParams;
    const next = lq.get("next") || "/";
    const safeNext = /^\/[\w\-/?=&.]*$/.test(next) && !next.startsWith("//") ? next : "/";
    if (!LOGIN_REQUIRED) return redirect(res, safeNext);
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: `${publicBase(req)}/auth/callback`,
      scope: "identify",
      // Daha önce onaylayan sessizce döner; ilk kez gelen (ya da sessiz giriş reddedildiyse) onay ekranını görür
      prompt: lq.get("consent") === "1" ? "consent" : "none",
      // Durum: zaman | onay ekranı mı (yeniden deneme bir kez) | dönüş adresi
      state: signValue(`${Date.now()}|${lq.get("consent") === "1" ? 1 : 0}|${safeNext}`, SESSION_SECRET),
    });
    return redirect(res, `https://discord.com/oauth2/authorize?${q}`);
  }

  if (path === "/auth/callback" && method === "GET") {
    const q = new URL(req.url || "/", "http://x").searchParams;
    const state = verifyValue(q.get("state") || "", SESSION_SECRET);
    const parts = state ? state.split("|") : [];
    const ts = Number(parts[0] || 0), consented = parts[1] === "1", next = parts.slice(2).join("|") || "/";
    // Sessiz giriş reddedildi (uygulama bu tarayıcıda hiç onaylanmamış): onay ekranıyla bir kez daha
    if (state && !consented && q.get("error") && q.get("error") !== "access_denied") {
      return redirect(res, `/auth/login?consent=1&next=${encodeURIComponent(next)}`);
    }
    if (!state || Date.now() - ts > 10 * 60 * 1000 || !q.get("code")) return redirect(res, "/?login=failed");
    try {
      const { user } = await exchangeCode(q.get("code")!, CLIENT_ID, CLIENT_SECRET, `${publicBase(req)}/auth/callback`);
      const secure = publicBase(req).startsWith("https:") ? "; Secure" : "";
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(signSession(user, SESSION_SECRET))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`;
      return redirect(res, next, { "Set-Cookie": cookie });
    } catch (err) {
      console.warn("[auth]", (err as Error).message);
      return redirect(res, "/?login=failed");
    }
  }

  if (path === "/api/me" && method === "GET") {
    const user = verifySession(cookies(req)[SESSION_COOKIE] || "", SESSION_SECRET);
    return user ? json(res, 200, { user, loginRequired: LOGIN_REQUIRED }) : json(res, 401, { loginRequired: LOGIN_REQUIRED, guests: ALLOW_GUESTS });
  }

  const watchInfo = /^\/api\/watch\/([\w-]{6,16})$/.exec(path);
  if (watchInfo && method === "GET") {
    const w = watches.get(watchInfo[1]);
    return w ? json(res, 200, { id: w.id, title: w.state.title }) : json(res, 404, { error: "not found" });
  }

  const media = /^\/media\/([\w-]{6,16})\/p$/.exec(path);
  if (media && method === "GET") {
    const w = watches.get(media[1]);
    if (!w || w.state.source?.kind !== "file") return json(res, 404, { error: "not found" });
    mediaProxy.allow(w.id, w.state.source.url);
    const u = new URL(req.url || "/", "http://x").searchParams.get("u");
    return mediaProxy.handle(res, w.id, u, typeof req.headers.range === "string" ? req.headers.range : undefined);
  }

  if (path === "/internal/stats" && method === "GET") {
    if (!secretMatches(req.headers["x-world-secret"])) return json(res, 404, { error: "not found" });
    let players = 0;
    for (const r of rooms.all()) players += r.size;
    return json(res, 200, { media: mediaProxy.stats(), rooms: [...rooms.all()].length, players });
  }

  const thumb = /^\/thumb\/([\w-]{11})$/.exec(path);
  if (thumb && method === "GET") return serveThumb(res, thumb[1]);

  const avatar = /^\/avatar\/(\d+)\/([0-9a-f_]+)(?:\.png)?$/.exec(path);
  if (avatar && method === "GET") return serveAvatar(res, avatar[1], avatar[2]);

  if (path === "/internal/sessions" && method === "GET") {
    if (!secretMatches(req.headers["x-world-secret"])) return json(res, 404, { error: "not found" });
    return json(res, 200, { rooms: [...rooms.all()].map((r) => r.summary()) });
  }

  if (path === "/internal/exiles" && method === "POST") {
    if (!secretMatches(req.headers["x-world-secret"])) return json(res, 404, { error: "not found" });
    const body = await readJson(req, 256 * 1024);
    const guilds = body.guilds;
    if (!guilds || typeof guilds !== "object") return json(res, 400, { error: "guilds required" });
    const next = new Map<string, Set<string>>();
    for (const [gid, ids] of Object.entries(guilds as Record<string, unknown>)) {
      if (Array.isArray(ids)) next.set(String(gid), new Set(ids.map(String)));
    }
    exiles = next;
    botGuilds = [...next.keys()].filter((g) => /^\d{5,20}$/.test(g));
    // Sunucu bilgisi olmadan girmiş Discord kullanıcıları (deploy sonrası, bot henüz bildirmeden): şimdi ata
    const g = worldGuild();
    for (const room of rooms.all()) {
      if (g) for (const p of room.players.values()) if (!p.guild) p.guild = g;
      room.updateJail(isExiled);
    }
    return json(res, 200, { ok: true });
  }

  if (path === "/internal/leaderboard" && method === "POST") {
    if (!secretMatches(req.headers["x-world-secret"])) return json(res, 404, { error: "not found" });
    const body = await readJson(req, 256 * 1024);
    if (!body.guilds || typeof body.guilds !== "object") return json(res, 400, { error: "guilds required" });
    boards.replace(body.guilds as Record<string, unknown>);
    for (const room of rooms.all()) room.each((conn, guild) => sendBoard(conn, boards.for(guild)));
    return json(res, 200, { ok: true });
  }

  if (path === "/internal/watch" && method === "POST") {
    if (!secretMatches(req.headers["x-world-secret"])) return json(res, 404, { error: "not found" });
    const body = await readJson(req);
    const media = typeof body.url === "string" ? await resolveMedia(body.url) : null;
    if (!media) return json(res, 400, { error: "unsupported" });
    if ("error" in media) return json(res, 400, { error: "unsupported", reason: media.error });
    const guild = typeof body.guild === "string" && /^\d{5,20}$/.test(body.guild) ? body.guild : null;
    const by = cleanName((body.by as Record<string, unknown> | undefined)?.name, "Biri");
    // Discord'daki !izle de dünyanın tek sinemasına yükler: linkle gelen arkadaşlarıyla aynı dünyaya girer
    const w = loadCinema(WORLD_ROOM, media, guild, by);
    rooms.find(WORLD_ROOM)?.say({ kind: "system", sid: 0, name: "Bot GAP", text: `🎬 ${by} Discord'dan sinemayı açtı: ${media.title}`, at: Date.now() }, CHAT_HISTORY);
    return json(res, 200, { id: w.id, url: watchLink(w), title: media.title, kind: media.source.kind });
  }

  if (path === "/api/photo" && method === "POST") return postPhoto(req, res);

  if (method === "GET" || method === "HEAD") return serveStatic(req, res, path);
  res.writeHead(405).end();
}

// ---------------------------------------------------------------------------
// Fotoğraf modu: dünyadan çekilen kare bot üzerinden Discord kanalına
// ---------------------------------------------------------------------------

const PHOTO_COOLDOWN_MS = 30_000;
const lastPhoto = new Map<string, number>();

async function postPhoto(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req, 4_600_000);
  } catch {
    return json(res, 413, { error: "Fotoğraf çok büyük." });
  }
  const user = verifySession(String(body.session || "") || cookies(req)[SESSION_COOKIE] || "", SESSION_SECRET);
  const w = typeof body.watch === "string" ? watches.get(body.watch) : undefined;
  // Tarayıcıdan gelenin (ve misafirin) sunucu bilgisi yok: dünyanın sunucusu
  const guild = w?.guild ?? (typeof body.guild === "string" && /^\d{5,20}$/.test(body.guild) ? body.guild : null) ?? (user ? worldGuild() : null);
  if (!user || !guild) return json(res, 403, { error: "Fotoğraf gönderilemiyor (dünyaya bağlı değilsin)." });
  if (!SHARED_SECRET) return json(res, 503, { error: "Fotoğraf gönderme şu an kapalı (bot bağlı değil)." });
  if (typeof body.image !== "string" || !body.image) return json(res, 400, { error: "Fotoğraf okunamadı." });
  const now = Date.now();
  if (now - (lastPhoto.get(user.id) ?? 0) < PHOTO_COOLDOWN_MS) return json(res, 429, { error: "Biraz bekle: 30 sn'de bir fotoğraf." });
  lastPhoto.set(user.id, now);
  try {
    // Misafir kanala adıyla gider (görev/XP yok)
    const r = await fetch(`${BOT_URL}/internal/${user.guest ? "guest_photo" : "photo"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-world-secret": SHARED_SECRET },
      body: JSON.stringify(user.guest ? { guild, name: user.name, image: body.image } : { guild, user: user.id, image: body.image }),
      signal: AbortSignal.timeout(20_000),
    });
    const out = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string; completed?: unknown };
    if (!r.ok || !out.ok) {
      // Gönderilemeyen fotoğraf bekleme süresi doldurmasın
      lastPhoto.delete(user.id);
      console.warn("[photo] bot reddetti:", r.status, JSON.stringify(out));
      return json(res, 400, { error: out.reason === "no_channel" ? "Fotoğraf kanalı ayarlı değil." : "Fotoğraf gönderilemedi." });
    }
    return json(res, 200, { ok: true, completed: out.completed ?? [] });
  } catch (err) {
    lastPhoto.delete(user.id);
    console.warn("[photo]", (err as Error).message);
    return json(res, 502, { error: "Bot şu an cevap vermiyor." });
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[http]", err);
    if (!res.headersSent) json(res, 500, { error: "internal" });
    else res.end();
  });
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
/** Ekran paylaşımı: büyük video parçaları ayrı bağlantıda (konum mesajlarını bekletmesin). */
const shareWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
/**
 * Paylaşım izleyicileri ping ile kesilmez: yoğun video akışının arkasında kuyruktaki ping geç yanıtlanır
 * (arka plandaki sekme, küçültülmüş Discord). Ölü izleyiciye kuyruğu dolunca zaten gönderim durur.
 */
const shareViewers = new WeakSet<WebSocket>();
const alive = new WeakSet<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://x");
  const endpoint = routePath(url.pathname);
  if (endpoint !== "/ws" && endpoint !== "/share") {
    socket.destroy();
    return;
  }
  // Activity sorgu parametresiyle, tarayıcı çerezle gelir.
  const token = url.searchParams.get("session") || cookies(req)[SESSION_COOKIE] || "";
  const user = verifySession(token, SESSION_SECRET);
  const watch = watches.get(url.searchParams.get("watch") || "");
  const close = (code: number, reason: string) => wss.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
  let key: string | null = null;
  if (url.searchParams.has("watch")) {
    if (!watch) return close(4004, "watch not found");
    // Activity'den açılan sinemanın linkiyle gelen, o Activity'nin odasına (aynı dünyaya) girer.
    if (user && (!user.guest || ALLOW_GUESTS || !LOGIN_REQUIRED)) key = Watches.roomKeyOf(watch);
  } else if (user && (!user.guest || ALLOW_GUESTS)) key = WORLD_ROOM; // misafir girişi kapalıysa eski misafir oturumu da girmez
  if (!user || !key) {
    // HTTP 401 tarayıcıda 1006 olarak görünür; 4001 ile kapatırsak istemci yeniden denemeyi bırakır.
    return close(4001, "unauthorized");
  }
  // Tank savaşı: aynı Activity/oda (ya da izleme odası) için ayrı bir savaş odası
  const roomKey = url.searchParams.get("battle") === "1" ? `b:${key}` : key;
  if (endpoint === "/share") {
    shareWss.handleUpgrade(req, socket, head, (ws) => onShareConnection(ws, user, roomKey, url.searchParams));
    return;
  }
  const guildParam = url.searchParams.get("guild") || "";
  if (/^\d{5,20}$/.test(guildParam)) lastGuild = guildParam;
  // Tarayıcıdan gelenin (Activity değil) sunucu bilgisi yok: dünyanın sunucusu kullanılır. Misafir de o
  // sunucunun verilerini (sıralama, arsalar, sezon) görür; profil, XP ve kalıcı kayıtlar ayrıca misafire kapalı.
  const guild = watch?.guild ?? (/^\d{5,20}$/.test(guildParam) ? guildParam : null) ?? worldGuild();
  // Zindanı denemek için: yalnızca misafirler kendini zindana koyabilir.
  const forceJail = user.guest && url.searchParams.get("jail") === "1";
  const jailed = forceJail || (!user.guest && isExiled(user.id, guild));
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user, roomKey, { guild, jailed, forceJail }, watch));
});

function sendWatch(target: Room | WebSocket, w: Watch): void {
  const src = w.state.source;
  if (src?.kind === "file") mediaProxy.allow(w.id, src.url);
  const ev = { t: "watch" as const, ...w.state, link: watchLink(w) };
  if (target instanceof WebSocket) target.send(JSON.stringify(ev));
  else target.broadcast(ev);
}

/** İzleme odası komutları: herkes oynatıp durdurabilir, sarabilir ve link değiştirebilir. */
function onWatchMessage(ws: WebSocket, room: Room, w: Watch, user: SessionUser, msg: Record<string, unknown>, limiter: { last: number }): void {
  const now = Date.now();
  if (msg.t === "wcmd") {
    const op = msg.op;
    if ((op === "play" || op === "pause" || op === "seek") && w.apply({ op, pos: msg.pos as number | undefined }, user.name, now)) {
      sendWatch(room, w);
    }
  } else if (msg.t === "wload" && typeof msg.url === "string" && msg.url.length < 2048) {
    if (now - limiter.last < 3000) return;
    limiter.last = now;
    void resolveMedia(msg.url).then((media) => {
      if (!media || "error" in media) {
        ws.send(JSON.stringify({ t: "notice", text: media?.error ?? "Bu link açılamıyor. YouTube, Twitch, Kick ya da .mp4/.webm/.m3u8 linki dene." }));
        return;
      }
      w.load(media.source, media.title, user.name, Date.now());
      sendWatch(room, w);
    });
  }
}

const botPost: BotPost = async (path, body) => {
  const r = await fetch(`${BOT_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-world-secret": SHARED_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { ok: r.ok, body: ((await r.json().catch(() => ({}))) || {}) as Record<string, unknown> };
};

/**
 * Yerel geliştirme: WORLD_DEV_WARDROBE=1 ise Discord ve bot olmadan da gardırop açılır; bütün parçalar
 * kilitsiz, kayıt yalnızca bu süreçte (bellekte) tutulur. Canlıda tanımlanmaz.
 */
const DEV_WARDROBE = process.env.WORLD_DEV_WARDROBE === "1";
const devLooks = new Map<string, Look>();
const DEV_DEFAULT_LOOK: Look = { hair: "hair_kisa_doku", tops: "top_tisort", bottoms: "bottom_kot", shoes: "shoes_sneaker", hats: null, glasses: null, facial: null, colors: {} };

function onDevLookMessage(send: (ev: ServerEvent) => void, room: Room, sid: number, user: SessionUser, msg: Record<string, unknown>): void {
  if (msg.t === "wardrobe") return send({ t: "wardrobe", outfit: devLooks.get(user.id) ?? DEV_DEFAULT_LOOK, level: 99, locked: {} });
  const look = sanitizeLook(msg.outfit);
  if (!look) return send({ t: "notice", text: "👕 Kıyafet okunamadı." });
  devLooks.set(user.id, look);
  room.setLook(sid, look);
  send({ t: "notice", text: "👕 Kaydedildi (yerel test, sunucu kapanınca silinir)." });
}

/** Misafirin seçtiği kıyafet: yalnızca bellekte (yeniden bağlanınca da giyili), kalıcı değil. */
const guestLooks = new Map<string, Look>();

/** Misafir gardırobu: bot seviye 1 kilitleriyle doğrular, hiçbir yere kaydedilmez. */
async function onGuestLookMessage(send: (ev: ServerEvent) => void, room: Room, sid: number, user: SessionUser, msg: Record<string, unknown>): Promise<void> {
  const ask = async (outfit: unknown) => {
    const r = await botPost("/internal/guest_outfit", { outfit });
    const clean = sanitizeLook(r.body.outfit);
    if (!r.ok || !clean) throw new Error(`bot ${JSON.stringify(r.body)}`);
    const locked: Record<string, number> = {};
    for (const [k, v] of Object.entries((r.body.locked as Record<string, unknown>) || {})) if (typeof v === "number") locked[k] = v;
    return { outfit: clean, locked, dropped: Array.isArray(r.body.dropped) ? r.body.dropped.map(String) : [] };
  };
  try {
    if (msg.t === "wardrobe") {
      const r = await ask(guestLooks.get(user.id) ?? null);
      return send({ t: "wardrobe", outfit: r.outfit, level: 1, locked: r.locked });
    }
    const look = sanitizeLook(msg.outfit);
    if (!look) return send({ t: "notice", text: "👕 Kıyafet okunamadı." });
    const r = await ask(look);
    guestLooks.set(user.id, r.outfit);
    room.setLook(sid, r.outfit);
    send({ t: "notice", text: `👕 Giyildi (misafir: çıkınca kaydedilmez${r.dropped.length ? `; kilitli parçalar çıkarıldı: ${r.dropped.join(", ")}` : ""}).` });
  } catch (err) {
    console.warn("[outfit] misafir:", (err as Error).message);
    send(msg.t === "wardrobe" ? { t: "wardrobe", error: "Gardırop şu an açılamıyor, biraz sonra tekrar dene." } : { t: "notice", text: "👕 Kıyafet giyilemedi, biraz sonra tekrar dene." });
  }
}

/** Gardırop: aç (kayıtlı kıyafet + kilitler) ya da kaydet. Misafirin kıyafeti kaydedilmez. */
async function onLookMessage(ws: WebSocket, room: Room, sid: number, user: SessionUser, guild: string | null, msg: Record<string, unknown>): Promise<void> {
  const send = (ev: ServerEvent) => ws.send(JSON.stringify(ev));
  if (DEV_WARDROBE && (user.guest || !guild || !SHARED_SECRET)) return onDevLookMessage(send, room, sid, user, msg);
  if (user.guest && SHARED_SECRET) return onGuestLookMessage(send, room, sid, user, msg);
  const unavailable = user.guest || !guild ? "👕 Gardırop için dünyaya Discord'dan (ses kanalındaki Activity ile) gir." : !SHARED_SECRET ? "👕 Gardırop şu an kapalı (bot bağlı değil)." : null;
  if (msg.t === "wardrobe") {
    if (unavailable) return send({ t: "wardrobe", error: unavailable });
    return send({ t: "wardrobe", ...(await fetchWardrobe(botPost, guild!, user.id)) });
  }
  const look = sanitizeLook(msg.outfit);
  if (unavailable) return send({ t: "notice", text: unavailable });
  if (!look) return send({ t: "notice", text: "👕 Kıyafet okunamadı." });
  const r = await saveLook(botPost, guild!, user.id, look);
  if ("error" in r) return send({ t: "notice", text: `👕 ${r.error}` });
  room.setLook(sid, r.look);
  send({ t: "notice", text: r.dropped.length ? `👕 Kaydedildi; kilitli parçalar çıkarıldı: ${r.dropped.join(", ")}` : "👕 Kıyafetin kaydedildi!" });
}

/**
 * Oda başına tek sinema (anahtar → izleme odası). Oda boşalıp kapansa da sinema kalır; yeniden açılan
 * oda aynı sinemayı bulur. İzleme linkiyle gelen de o odaya (aynı dünyaya) girer.
 */
const cinemas = new Map<string, string>();

function cinemaOf(key: string): Watch | undefined {
  const id = cinemas.get(key);
  return id ? watches.get(id) : undefined;
}

/** Odanın sinemasına yükler (yoksa kurar) ve odadakilere gönderir. */
function loadCinema(key: string, media: { source: Source; title: string }, guild: string | null, by: string): Watch {
  let w = cinemaOf(key);
  if (w) w.load(media.source, media.title, by, Date.now());
  else {
    w = watches.create(guild, by, media.source, media.title, Date.now(), key);
    cinemas.set(key, w.id);
  }
  const room = rooms.find(key);
  if (room) sendWatch(room, w);
  return w;
}

/** Sinemayı açar ya da videosunu herkes için değiştirir. */
async function openCinema(link: string, guild: string | null, by: string, key: string): Promise<{ url: string; title: string; reused: boolean } | { error: string }> {
  const media = await resolveMedia(link);
  if (!media) return { error: "Bu link açılamıyor. YouTube, Twitch, Kick, tabii (TRT) ya da .mp4/.webm/.m3u8 linki dene." };
  if ("error" in media) return media;
  const reused = !!cinemaOf(key)?.state.source;
  const w = loadCinema(key, media, guild, by);
  return { url: watchLink(w), title: media.title, reused };
}

/** Sohbet mesajı ya da komut. Komut cevapları yalnızca sorana gider. */
async function onChat(ws: WebSocket, room: Room, sid: number, user: SessionUser, guild: string | null, text: string, viewer: boolean, cinemaGate: { last: number }): Promise<void> {
  const line = (kind: "system" | "reply", t: string, link?: { url: string; label: string }) => ({ kind, sid: 0, name: "Bot GAP", text: t, at: Date.now(), ...(link ? { link } : {}) });
  const parsed = parseCommand(text);
  if (!parsed) {
    room.say({ kind: "say", sid, name: user.name, text, at: Date.now() }, CHAT_HISTORY);
    return;
  }
  await runCommand(
    {
      user,
      sid,
      guild,
      bot: SHARED_SECRET ? botPost : null,
      inWatch: viewer,
      reply: (t, link) => ws.send(JSON.stringify({ t: "chat", line: line("reply", t, link) })),
      announce: (t, link) => room.say(line("system", t, link), CHAT_HISTORY),
      open: (url) => ws.send(JSON.stringify({ t: "open", url })),
      cinema: (url) => openCinema(url, guild, user.name, room.key),
      cinemaAllowed: () => {
        const now = Date.now();
        if (now - cinemaGate.last < CINEMA_COOLDOWN_MS) return false;
        cinemaGate.last = now;
        return true;
      },
      canControl: async () => {
        if (user.guest || !guild || !SHARED_SECRET) return false;
        try {
          const r = await botPost("/internal/can_control", { guild, user: user.id });
          return r.ok && r.body.allowed === true;
        } catch {
          return false;
        }
      },
      world: room.games
        ? {
            weather: () => weather.describe(),
            fireworks: () => room.games!.fireworks(Date.now(), 12),
            tag: (mode) => room.games!.openTag(sid, mode),
            tagJoin: () => room.games!.tag.join(sid),
            enqueue: (url) => room.games!.stage.enqueue(url, user.name),
            queueText: () => room.games!.stage.listText(),
            skip: () => room.games!.stage.djCommand(sid, "skip"),
            sky: room.games.sky,
            match: {
              start: (m) => room.games!.stadium.startMatch(m),
              end: () => room.games!.stadium.endMatch(),
              join: () => room.games!.stadium.joinMatch(sid),
              leave: () => room.games!.stadium.leaveMatch(sid),
            },
          }
        : undefined,
    },
    parsed.cmd,
    parsed.args,
  );
}

/**
 * Yerel geliştirme: WORLD_DEV_FISH=<saniye> ise bot olmadan da balık tutulur; günlük hak yerine
 * bu kadar saniye sonra yenilenir (geri sayımı denemek için). Canlıda tanımlanmaz.
 */
const DEV_FISH_S = Number(process.env.WORLD_DEV_FISH) || 0;
const devFishAt = new Map<string, number>();
function devFish(ws: WebSocket, room: Room, sid: number, user: SessionUser, query: boolean): void {
  const send = (ev: object) => ws.send(JSON.stringify(ev));
  const at = devFishAt.get(user.id) ?? 0;
  if (query || at > Date.now()) {
    send({ t: "fishwait", at: at > Date.now() ? at : 0 });
    if (!query) send({ t: "notice", text: FISH_REFUSED.already });
    return;
  }
  const next = Date.now() + DEV_FISH_S * 1000;
  devFishAt.set(user.id, next);
  send({ t: "fishwait", at: next });
  room.broadcast({ t: "fish", sid, name: user.name, catch: { rarity: "common", label: "Yaygın", fish: "Sazan", hours: 1, streak: 1, luck: 0 } });
}

/**
 * Misafirin balığı: zar burada (botun fishing.py'deki tablosuyla aynı ihtimaller), XP boost'u, seri,
 * görev ve Discord duyurusu yok. Günde bir (İstanbul gece yarısı yenilenir), yalnızca bellekte.
 */
const GUEST_FISH = [
  { rarity: "legendary", label: "Efsanevi", fish: "Altın Sazan", chance: 0.5 },
  { rarity: "epic", label: "Epik", fish: "Yayın Balığı", chance: 2 },
  { rarity: "rare", label: "Nadir", fish: "Turna", chance: 7.5 },
  { rarity: "uncommon", label: "Az Bulunur", fish: "Kızılkanat", chance: 20 },
  { rarity: "common", label: "Yaygın", fish: "Sazan", chance: 70 },
] as const;
const guestFishAt = new Map<string, number>();

/** Bir sonraki İstanbul gece yarısı (ms). */
function nextIstanbulMidnight(now = Date.now()): number {
  const tr = now + 3 * 3600_000;
  return Math.floor(tr / 86_400_000 + 1) * 86_400_000 - 3 * 3600_000;
}

function guestFish(ws: WebSocket, room: Room, sid: number, user: SessionUser, query: boolean, rand = Math.random): void {
  const send = (ev: object) => ws.send(JSON.stringify(ev));
  const at = guestFishAt.get(user.id) ?? 0;
  if (query || at > Date.now()) {
    send({ t: "fishwait", at: at > Date.now() ? at : 0 });
    if (!query) send({ t: "notice", text: "🎣 Bugünkü balığını tuttun, yarın tekrar gel." });
    return;
  }
  const next = nextIstanbulMidnight();
  guestFishAt.set(user.id, next);
  send({ t: "fishwait", at: next });
  let x = rand() * 100;
  const r = GUEST_FISH.find((f) => (x -= f.chance) < 0) ?? GUEST_FISH[GUEST_FISH.length - 1];
  room.broadcast({ t: "fish", sid, name: user.name, catch: { rarity: r.rarity, label: r.label, fish: r.fish, hours: 0, streak: 0, luck: 0 } });
}

const FISH_REFUSED: Record<string, string> = {
  already: "🎣 Bugünkü balığını tuttun. Yarın tekrar gel, serin bozulmasın!",
  exiled: "⛓️ Sürgündeyken balık tutamazsın.",
  not_member: "🎣 Balık tutmak için bu sunucunun üyesi olmalısın.",
};

/** Bot'a günün balığını sorar; tutulduysa odaya duyurur, tutulamadıysa yalnızca tutana söyler. */
async function fish(ws: WebSocket, room: Room, sid: number, user: SessionUser, guild: string | null): Promise<void> {
  const notice = (text: string) => ws.send(JSON.stringify({ t: "notice", text }));
  if (DEV_FISH_S && (user.guest || !guild || !SHARED_SECRET)) return devFish(ws, room, sid, user, false);
  if (user.guest || !guild) return guestFish(ws, room, sid, user, false);
  if (!SHARED_SECRET) return notice("🎣 Göl şu an kapalı (bot bağlı değil).");
  try {
    const r = await fetch(`${BOT_URL}/internal/fish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-world-secret": SHARED_SECRET },
      body: JSON.stringify({ guild, user: user.id }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await r.json()) as { ok?: boolean; reason?: string; next?: number } & Partial<FishCatch>;
    if (r.ok && typeof body.next === "number") ws.send(JSON.stringify({ t: "fishwait", at: body.next * 1000 }));
    if (!r.ok || !body.ok) return notice(FISH_REFUSED[body.reason ?? ""] ?? "🎣 Olta takıldı, biraz sonra tekrar dene.");
    const c: FishCatch = {
      rarity: body.rarity!,
      label: String(body.label),
      fish: String(body.fish),
      hours: Number(body.hours),
      streak: Number(body.streak),
      luck: Number(body.luck),
    };
    room.broadcast({ t: "fish", sid, name: user.name, catch: c });
    notifyQuests(room, user.id, (body as { completed?: unknown }).completed);
  } catch (err) {
    console.warn("[fish]", (err as Error).message);
    notice("🎣 Olta takıldı, biraz sonra tekrar dene.");
  }
}

/** Gölün yanına gelen oyuncuya sonraki balık hakkının ne zaman açılacağını söyler (misafire söylenmez). */
async function fishWait(ws: WebSocket, user: SessionUser, guild: string | null): Promise<void> {
  if (user.guest || !guild || !SHARED_SECRET) return;
  try {
    const r = await fetch(`${BOT_URL}/internal/fish_status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-world-secret": SHARED_SECRET },
      body: JSON.stringify({ guild, user: user.id }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await r.json()) as { next?: number };
    if (r.ok && typeof body.next === "number") ws.send(JSON.stringify({ t: "fishwait", at: body.next * 1000 }));
  } catch (err) {
    console.warn("[fishq]", (err as Error).message);
  }
}

/** Oyuncu kartı: bottan seviye, albüm, sayaçlar; başkasının kartında görevler gösterilmez. */
async function sendProfile(ws: WebSocket, room: Room, me: number, target: number): Promise<void> {
  const p = room.players.get(target);
  if (!p) return;
  const send = (profile: ServerEvent & { t: "profile" }) => ws.send(JSON.stringify(profile));
  const base = { t: "profile" as const, sid: target, name: p.info.name };
  if (p.user.guest || !p.guild) return send({ ...base, profile: null, error: "Misafir oyuncunun kartı yok." });
  if (!SHARED_SECRET) return send({ ...base, profile: null, error: "Kartlar şu an kapalı (bot bağlı değil)." });
  try {
    const r = await botPost("/internal/profile", { guild: p.guild, user: p.user.id });
    if (!r.ok || !r.body.ok) return send({ ...base, profile: null, error: "Bu sunucunun üyesi değil." });
    const profile = r.body as unknown as Profile;
    if (target !== me) profile.quests = [];
    send({ ...base, profile });
  } catch (err) {
    console.warn("[profile]", (err as Error).message);
    send({ ...base, profile: null, error: "Bot şu an cevap vermiyor." });
  }
}

/** Tank sezonu sıralaması (bu ay). */
async function sendSeason(ws: WebSocket, guild: string | null): Promise<void> {
  const empty = { t: "season" as const, season: "", top: [] };
  if (!guild || !SHARED_SECRET) return void ws.send(JSON.stringify(empty));
  try {
    const r = await botPost("/internal/season", { guild });
    ws.send(JSON.stringify(r.ok ? { t: "season", season: String(r.body.season ?? ""), top: Array.isArray(r.body.top) ? r.body.top : [] } : empty));
  } catch {
    ws.send(JSON.stringify(empty));
  }
}

function onConnection(ws: WebSocket, user: SessionUser, key: string, opts: JoinOptions, watch?: Watch): void {
  const room = rooms.get(key);
  // Snapshot'lar hızlı yol açıksa ondan, değilse WebSocket'ten; olaylar her zaman WebSocket'ten (sıralı, kaybolmaz)
  let fast: FastLink | null = null;
  const conn: Conn = {
    send: (data) => ws.send(data),
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    sendFast: (data) => fast?.send(data) ?? false,
  };
  const sid = room.join(user, conn, Date.now(), opts);
  // Süren ya da bekleyen yarış varsa yeni gelen de görsün (grid, lambalar, sıralama)
  if (room.ring && room.ring.session.phase !== "idle") ws.send(JSON.stringify({ t: "ring", ring: room.ring.view() }));
  const incoming: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
  const onState = (buf: Buffer) => {
    const sentAt = decodeState(new DataView(buf.buffer, buf.byteOffset, buf.byteLength), incoming);
    if (sentAt >= 0) room.applyState(sid, incoming, Date.now(), sentAt);
  };
  if (rtc) {
    fast = rtc.link((ev) => ws.send(JSON.stringify(ev)), onState);
    ws.send(JSON.stringify({ t: "rtcon" }));
  }
  let lastOffer = 0;
  let lastStat = 0;
  /** Oyuncunun sunucusu: bağlanınca bilinmiyorsa (tarayıcı, deploy sonrası) bot bildirince atanır. */
  const myGuild = () => room.players.get(sid)?.guild ?? opts.guild ?? null;
  if (CLIENT_VERSION) ws.send(JSON.stringify({ t: "version", v: CLIENT_VERSION }));
  // Kayıtlı kıyafet arka planda gelir; o zamana kadar varsayılan karakter çizilir.
  if (!user.guest && opts.guild && SHARED_SECRET) {
    void fetchLook(botPost, opts.guild, user.id).then((look) => look && room.setLook(sid, look));
  }
  const guestLook = user.guest ? guestLooks.get(user.id) : undefined;
  if (guestLook) room.setLook(sid, guestLook);
  sendBoard(ws, boards.for(myGuild()));
  // Sinema odaya bağlıdır: linkle gelen bağlar, Activity'den !izle ile sonradan da açılabilir.
  if (watch && !cinemaOf(room.key)) cinemas.set(room.key, watch.id);
  const roomWatch = () => cinemaOf(room.key);
  const current = roomWatch();
  if (current) sendWatch(ws, current);
  if (room.chat.length) ws.send(JSON.stringify({ t: "chatlog", lines: room.chat }));
  if (!room.battle) ws.send(JSON.stringify({ t: "weather", weather: room.games?.sky.weather() ?? weather.current }));
  const share = shares.get(room.key);
  if (share) ws.send(JSON.stringify({ t: "share", sid: share.sid, name: share.name }));
  const limiter = { last: 0 };
  let lastEmote = 0;
  let lastCar = 0;
  let lastPark = 0;
  let lastRadio = 0;
  let lastRadioOp = 0;
  let lastRide = 0;
  let lastCasino = 0;
  let lastLive = 0;
  let lastRing = 0;
  /** Casino cüzdanı: Discord hesabına bağlı (misafirde oturuma). */
  const walletKey = user.guest ? `guest:${user.id}` : user.id;
  let lastAct = 0;
  let lastFish = 0;
  let lastFishQ = 0;
  let lastAim = 0;
  let lastWardrobe = 0;
  let lastOutfit = 0;
  let lastChat = 0;
  let lastProfile = 0;
  let lastSeason = 0;
  const cinemaGate = { last: 0 };
  alive.add(ws);

  ws.on("pong", () => alive.add(ws));
  ws.on("message", (data, isBinary) => {
    if (isBinary) return onState(data as Buffer);
    try {
      const msg = JSON.parse(data.toString());
      if (msg && typeof msg === "object" && room.battle?.handle(sid, msg)) {
        // savaş mesajı işlendi
      } else if (msg?.t === "resume") {
        room.resume(sid, Number(msg.x), Number(msg.z), Number(msg.rot));
      } else if (msg?.t === "ping" && typeof msg.c === "number") {
        ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() }));
      } else if (msg?.t === "rtc" && fast) {
        const now = Date.now();
        if (now - lastOffer < 5000) return;
        lastOffer = now;
        fast.offer(msg.sdp);
      } else if (msg?.t === "netstat") {
        const now = Date.now();
        const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0);
        if (now - lastStat < 10_000) return;
        lastStat = now;
        netStats.set(ws, {
          rtt: num(msg.rtt, 10_000),
          ws: num(msg.ws, 10_000),
          loss: num(msg.loss, 1),
          delay: num(msg.delay, 10_000),
          starve: num(msg.starve, 1),
          udp: msg.udp === true,
          at: now,
        });
      } else if (msg?.t === "act" && ACTS.includes(msg.a)) {
        // Yalnızca o noktanın yanındaysa; sürgündekiler parmaklıktan bir şey atamaz.
        const a = msg.a as Act;
        const p = room.players.get(sid);
        const spot = actSpot(a);
        const now = Date.now();
        const near = p && Math.hypot(p.state.x - spot.x, p.state.z - spot.z) <= spot.r + 1;
        if (near && !p.info.spectator && !(a !== "grill" && p.info.jailed) && now - lastAct >= ACT_COOLDOWN_MS) {
          lastAct = now;
          room.broadcast({ t: "act", sid, a }, sid);
          if (a === "grill") reportEvent(room, sid, "grill");
          else if (a === "cay") reportEvent(room, sid, "tea");
        }
      } else if (msg?.t === "fish") {
        const p = room.players.get(sid);
        const now = Date.now();
        const near = p && Math.hypot(p.state.x - FISH_SPOT.x, p.state.z - FISH_SPOT.z) <= FISH_SPOT.r + 1;
        if (near && !p.info.spectator && !p.info.jailed && now - lastFish >= FISH_COOLDOWN_MS) {
          lastFish = now;
          void fish(ws, room, sid, user, myGuild());
        }
      } else if (msg?.t === "fishq") {
        const now = Date.now();
        if (now - lastFishQ >= FISH_COOLDOWN_MS) {
          lastFishQ = now;
          if (DEV_FISH_S && (user.guest || !myGuild() || !SHARED_SECRET)) devFish(ws, room, sid, user, true);
          else if (user.guest || !myGuild()) guestFish(ws, room, sid, user, true);
          else void fishWait(ws, user, myGuild());
        }
      } else if (msg?.t === "chat") {
        const now = Date.now();
        const text = cleanChat(msg.text);
        if (!text || now - lastChat < CHAT_COOLDOWN_MS) return;
        lastChat = now;
        void onChat(ws, room, sid, user, myGuild(), text, !!watch, cinemaGate);
      } else if (msg?.t === "wardrobe" || msg?.t === "outfit") {
        const now = Date.now();
        const isSave = msg.t === "outfit";
        if (now - (isSave ? lastOutfit : lastWardrobe) < (isSave ? OUTFIT_COOLDOWN_MS : WARDROBE_COOLDOWN_MS)) return;
        if (isSave) lastOutfit = now;
        else lastWardrobe = now;
        void onLookMessage(ws, room, sid, user, myGuild(), msg);
      } else if (msg?.t === "tank" && typeof msg.on === "boolean") {
        if (msg.on) {
          if (!room.enterTank(sid)) ws.send(JSON.stringify({ t: "notice", text: "🚫 Tanka şu an binemezsin (dolu ya da çok uzaktasın)." }));
        } else room.exitTank(sid);
      } else if (msg?.t === "taim" && typeof msg.h === "number" && typeof msg.tr === "number") {
        const now = Date.now();
        if (now - lastAim >= 50) {
          lastAim = now;
          room.aimTank(sid, msg.h, msg.tr, typeof msg.el === "number" ? msg.el : undefined);
        }
      } else if (msg?.t === "fire") {
        const el = typeof msg.el === "number" ? msg.el : undefined;
        room.fire(sid, typeof msg.h === "number" && typeof msg.tr === "number" ? { h: msg.h, tr: msg.tr, el } : undefined);
      } else if (msg?.t === "sharelink") {
        const now = Date.now();
        if (now - limiter.last < 3000) return;
        limiter.last = now;
        ws.send(JSON.stringify({ t: "open", url: `${watchLink(roomCinema(room, myGuild(), user.name))}?share=1` }));
      } else if (msg?.t === "emote") {
        const e = msg.e;
        const now = Date.now();
        if (Number.isInteger(e) && e >= 0 && e < EMOTES.length && now - lastEmote >= EMOTE_COOLDOWN_MS) {
          lastEmote = now;
          room.broadcast({ t: "emote", sid, e }, sid);
          reportEvent(room, sid, "emote");
        }
      } else if (msg?.t === "cosm") {
        room.setCosmetics(sid, msg.pet, msg.skin);
      } else if (msg?.t === "car") {
        const now = Date.now();
        if (now - lastCar < 300) return;
        lastCar = now;
        room.setCar(sid, validCar(msg.car));
      } else if (msg?.t === "cardmg") {
        const now = Date.now();
        if (now - lastCar < 300) return;
        lastCar = now;
        room.setCarDamage(sid, msg.d);
      } else if (msg?.t === "park") {
        const now = Date.now();
        if (now - lastPark < 250) return;
        lastPark = now;
        room.setParked(sid, msg.parked);
      } else if (msg?.t === "casino" || msg?.t === "bj" || msg?.t === "roulette" || msg?.t === "slot") {
        // Bakiye sorgusu ucuz: sınırsız. Oyun hamleleri çok hızlıysa da yanıt ver (istemci kilidini açsın).
        const now = Date.now();
        if (!(msg.t === "casino" && msg.op === "wallet")) {
          if (now - lastCasino < 150) return ws.send(JSON.stringify({ t: "notice", text: "🎰 Biraz yavaş, bir an bekle." }));
          lastCasino = now;
        }
        const st = room.players.get(sid)?.state;
        const inside = !!st && Math.abs(st.x - CASINO.x) < CASINO.hw && Math.abs(st.z - CASINO.z) < CASINO.hd;
        const out = casino.handle(sid, walletKey, msg as CasinoMsg, inside);
        ws.send(JSON.stringify("error" in out ? { t: "notice", text: out.error } : out));
      } else if (msg?.t === "live") {
        const now = Date.now();
        // Oturma, izleme ve kalkma sınırsız (masa ekranı açılırken art arda gider); bahis ve hamleler sınırlı
        if (msg.op === "bet" || msg.op === "act" || msg.op === "rebuy") {
          if (now - lastLive < 120) return ws.send(JSON.stringify({ t: "notice", text: "🎰 Biraz yavaş, bir an bekle." }));
          lastLive = now;
        }
        const err = room.live?.handle(sid, walletKey, msg as LiveMsg, now);
        if (err) ws.send(JSON.stringify({ t: "notice", text: err }));
      } else if (msg?.t === "ring") {
        const now = Date.now();
        if (now - lastRing < 300) return;
        lastRing = now;
        const err = room.ring?.handle(sid, msg as RingMsg, now);
        if (err) ws.send(JSON.stringify({ t: "notice", text: err }));
      } else if (msg?.t === "radio") {
        // Link sıraya eklenir (çalma listesi bütün şarkılarıyla); kontrol yalnızca arabada
        const now = Date.now();
        if (now - lastRadio < 1500) return ws.send(JSON.stringify({ t: "notice", text: "📻 Biraz yavaş, bir an bekle." }));
        lastRadio = now;
        if (typeof msg.url !== "string" || !msg.url.trim()) return void room.radioQ.op(sid, "stop");
        if (!room.players.get(sid)?.info.car) return ws.send(JSON.stringify({ t: "notice", text: "📻 Radyoyu arabadan kontrol edebilirsin." }));
        void room.radioQ.add(sid, msg.url).then((text) => text && ws.send(JSON.stringify({ t: "notice", text })));
      } else if (msg?.t === "radioq" && typeof msg.op === "string") {
        // Şarkı bitti bildirimi her yerden; diğerleri yalnızca arabada
        const now = Date.now();
        if (msg.op !== "ended") {
          if (now - lastRadioOp < 250) return;
          lastRadioOp = now;
          if (!room.players.get(sid)?.info.car) return ws.send(JSON.stringify({ t: "notice", text: "📻 Radyoyu arabadan kontrol edebilirsin." }));
        }
        const ops = ["next", "prev", "shuffle", "repeat", "jump", "remove", "clear", "stop", "play", "ended"] as const;
        const op = ops.find((o) => o === msg.op);
        if (op) void room.radioQ.op(sid, op, typeof msg.i === "number" ? msg.i : undefined, typeof msg.id === "string" ? msg.id : undefined);
      } else if (msg?.t === "carlights") {
        room.setLights(sid, msg.on);
      } else if (msg?.t === "ride") {
        const now = Date.now();
        if (now - lastRide < 500) return;
        lastRide = now;
        const err = room.ride(sid, typeof msg.d === "number" ? msg.d : null);
        if (err) ws.send(JSON.stringify({ t: "notice", text: err }));
      } else if (msg?.t === "profile" && typeof msg.sid === "number") {
        const now = Date.now();
        if (now - lastProfile < 1000) return;
        lastProfile = now;
        void sendProfile(ws, room, sid, msg.sid);
      } else if (msg?.t === "season") {
        const now = Date.now();
        if (now - lastSeason < 5000) return;
        lastSeason = now;
        void sendSeason(ws, myGuild());
      } else if (msg && typeof msg === "object" && room.games?.handle(sid, msg)) {
        // dünya oyunu mesajı işlendi
      } else if (msg && typeof msg === "object") {
        const w = roomWatch();
        if (w) onWatchMessage(ws, room, w, user, msg, limiter);
      }
    } catch {
      // bozuk mesaj yok sayılır
    }
  });
  ws.on("close", () => {
    fast?.close();
    netStats.delete(ws);
    const s = shares.get(room.key);
    if (s?.sid === sid) {
      s.closeSender();
      endShare(room, s);
    }
    casino.leave(sid, walletKey);
    room.leave(sid);
    if (room.size === 0) room.games?.builds?.dispose();
    rooms.release(room);
  });
}

/** Odanın tarayıcı linki: sinema varsa onun, yoksa sinemasız bir izleme odası açılır (aynı dünya). */
function roomCinema(room: Room, guild: string | null, by: string): Watch {
  const existing = cinemaOf(room.key);
  if (existing) return existing;
  const w = watches.create(guild, by, null, "", Date.now(), room.key);
  cinemas.set(room.key, w.id);
  return w;
}

function endShare(room: Room, s: Share): void {
  if (!shares.stop(room.key, s)) return;
  room.broadcast({ t: "share", sid: 0, name: "" });
  console.log(`[share] ${s.name} paylaşımı bitti · ${(s.sent / 1e6).toFixed(1)} MB dağıtıldı`);
}

/**
 * Ekran paylaşımı bağlantısı. `role=send`: paylaşan (önce {t:"start", mime}, sonra WebM parçaları);
 * `role=view`: izleyici (önce {t:"init"}, sonra WebM baytları). Paylaşan odada olmalı (`sid` kendisi).
 */
function onShareConnection(ws: WebSocket, user: SessionUser, key: string, params: URLSearchParams): void {
  const room = rooms.find(key);
  if (!room) return ws.close(4004, "room not found");
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));
  const role = params.get("role");
  if (role === "view") {
    const s = shares.get(key);
    if (!s) return ws.close(4004, "no share");
    shareViewers.add(ws);
    s.addViewer(ws);
    ws.on("close", () => s.removeViewer(ws));
    return;
  }
  const sid = Number(params.get("sid"));
  if (role !== "send" || room.players.get(sid)?.info.id !== user.id) return ws.close(4001, "not in room");
  let share: Share | null = null;
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      if (share) return;
      let msg: { t?: unknown; mime?: unknown } = {};
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t !== "start" || typeof msg.mime !== "string" || !SHARE_MIME.test(msg.mime)) return ws.close(4400, "bad start");
      const r = shares.start(key, sid, user.name, msg.mime);
      if ("busy" in r) {
        ws.send(JSON.stringify({ t: "busy", name: r.busy.name }));
        return ws.close(4009, "busy");
      }
      share = r.ok;
      share.closeSender = () => ws.close(4000, "left");
      ws.send(JSON.stringify({ t: "started" }));
      room.broadcast({ t: "share", sid, name: user.name });
      console.log(`[share] ${user.name} ekranını paylaşıyor (${msg.mime})`);
      return;
    }
    if (share && !share.data(data as Buffer)) ws.close(4008, "too fast");
  });
  ws.on("close", () => {
    if (share) endShare(room, share);
  });
}

// Video aktarımı sürerken dakikada bir yük özeti (Coolify loglarında görünür).
setInterval(() => {
  for (const [, s] of shares.all()) console.log(`[share] ${s.name} · ${s.viewerCount} izleyici · ${(s.sent / 1e6).toFixed(1)} MB`);
  const s = mediaProxy.stats();
  if (s.active > 0 || s.mbps > 0) {
    console.log(`[media] ${s.mbps} Mbit/sn · ${s.active} akış · önbellek ${s.hits}/${s.requests} · toplam ${(s.bytes / 1e9).toFixed(2)} GB`);
  }
}, 60_000);

// Bağlantı özeti (dakikada bir): oyuncuların pingi, çizim gecikmesi, bekleme oranı, hızlı yol ve sunucunun tıkanması.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
setInterval(() => {
  const now = Date.now();
  const s = [...netStats.values()].filter((v) => now - v.at < 90_000);
  const lag = loopDelay.percentile(99) / 1e6;
  loopDelay.reset();
  if (!s.length && lag < 50) return;
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1] ?? 0;
  const rtt = s.map((v) => v.rtt);
  const starve = s.map((v) => v.starve);
  const loss = s.map((v) => v.loss);
  console.log(
    `[net] ${s.length} oyuncu · ping ${med(rtt)} ms (en kötü ${Math.max(0, ...rtt)}) · WebSocket ${med(s.map((v) => v.ws))} ms` +
      ` · kayıp %${(med(loss) * 100).toFixed(1)} (en kötü %${(Math.max(0, ...loss) * 100).toFixed(1)}) · çizim gecikmesi ${med(s.map((v) => v.delay))} ms` +
      ` · bekleme %${(med(starve) * 100).toFixed(1)} (en kötü %${(Math.max(0, ...starve) * 100).toFixed(1)})` +
      ` · UDP ${s.filter((v) => v.udp).length}/${s.length} · event loop p99 ${lag.toFixed(0)} ms`,
  );
}, 60_000);

// Boş ve eskimiş izleme odalarını temizle.
setInterval(() => {
  for (const id of watches.sweep((w) => (rooms.find(Watches.roomKeyOf(w))?.size ?? 0) === 0)) mediaProxy.forget(id);
}, 10 * 60 * 1000);

// Ölü bağlantıları temizle.
setInterval(() => {
  for (const ws of [...wss.clients, ...shareWss.clients]) {
    if (shareViewers.has(ws)) continue;
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 20_000);

// Özel günlerde havai fişek: Cumhuriyet Bayramı, 23 Nisan, 19 Mayıs, 30 Ağustos akşamı 21.00 ve 21.30'da, yılbaşı gece yarısı.
const FIREWORK_DAYS = new Set(["04-23", "05-19", "08-30", "10-29"]);
let lastFireworkSlot = "";
setInterval(() => {
  const tr = new Date(Date.now() + 3 * 3600_000);
  const md = `${String(tr.getUTCMonth() + 1).padStart(2, "0")}-${String(tr.getUTCDate()).padStart(2, "0")}`;
  const h = tr.getUTCHours(), m = tr.getUTCMinutes();
  const show = (FIREWORK_DAYS.has(md) && h === 21 && (m === 0 || m === 30)) || (md === "01-01" && h === 0 && m <= 1);
  const slot = `${md}-${h}-${m >= 30 ? 30 : 0}`;
  if (!show || slot === lastFireworkSlot) return;
  lastFireworkSlot = slot;
  for (const room of rooms.all()) room.games?.fireworks(Date.now(), 40, true);
}, 20_000);

// Snapshot yayını: değişiklik varsa her tick, yoksa saniyede bir.
let tickCount = 0;
setInterval(() => {
  const now = Date.now();
  const force = ++tickCount % TICK_HZ === 0;
  for (const room of rooms.all()) room.tick(now, force);
}, 1000 / TICK_HZ);

// Coolify yeniden başlatırken: bekleyen arsa kayıtları yazılmadan çıkılmaz.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    void Promise.race([flushBuilds().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]).then(() => process.exit(0));
  });
}

server.listen(PORT, () => {
  void warmStatic();
  console.log(`[world] listening on :${PORT} (guests ${ALLOW_GUESTS ? "on" : "off"}, discord ${CLIENT_ID ? "on" : "off"}${DEV_WARDROBE ? ", yerel gardırop on" : ""}${DEV_FISH_S ? `, yerel göl ${DEV_FISH_S} sn` : ""})`);
});
