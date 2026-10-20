// GAP Dünyası sunucusu: statik istemci, Discord giriş API'si, avatar proxy'si ve WebSocket odaları.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { ACT_COOLDOWN_MS, type Act, ACTS, actSpot, EMOTE_COOLDOWN_MS, EMOTES, FISH_COOLDOWN_MS, FISH_SPOT, TICK_HZ } from "../../shared/constants";
import { decodeState, type FishCatch, type Look, type PlayerState, type ServerEvent } from "../../shared/protocol";
import { cleanName, exchangeCode, type SessionUser, signSession, signValue, verifySession, verifyValue } from "./auth";
import { type Board, Boards } from "./board";
import { CHAT_COOLDOWN_MS, CHAT_HISTORY, CINEMA_COOLDOWN_MS, cleanChat, parseCommand, runCommand } from "./chat";
import { type BotPost, fetchLook, fetchWardrobe, OUTFIT_COOLDOWN_MS, sanitizeLook, saveLook, WARDROBE_COOLDOWN_MS } from "./looks";
import { type Conn, type JoinOptions, type Room, Rooms } from "./room";
import { MediaProxy } from "./mediaProxy";
import { resolveMedia, type Watch, Watches } from "./watch";
import { type Share, SHARE_MIME, Shares } from "./share";

/** Sinema videosu (dosya/HLS) sunucu üzerinden: Activity'de perdede oynar. */
const mediaProxy = new MediaProxy();

/** İzleme odasının tarayıcı adresi. */
function watchLink(w: Watch): string {
  return `${PUBLIC_URL || "http://localhost:5173"}/w/${w.id}`;
}

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const SHARED_SECRET = process.env.WORLD_SHARED_SECRET || "";
const ALLOW_GUESTS = (process.env.WORLD_ALLOW_GUESTS ?? "true").toLowerCase() !== "false";
// Ortak secret yoksa oturumlar sadece bu süreç ömrü boyunca geçerlidir.
const SESSION_SECRET = SHARED_SECRET || randomBytes(32).toString("hex");
/** Tarayıcıdan erişilen adres (bot'un attığı izleme linkleri ve OAuth dönüşü için). */
const PUBLIC_URL = (process.env.WORLD_PUBLIC_URL || "").replace(/\/+$/, "");
/** Discord ayarlıysa izleme odalarına yalnızca Discord ile giriş yapanlar girer. */
const LOGIN_REQUIRED = !!(CLIENT_ID && CLIENT_SECRET);
const SESSION_COOKIE = "gw_session";
/** Botun iç HTTP ucu: balık zarı, seri ve XP boost'u orada (fishing.py). */
const BOT_URL = (process.env.BOT_INTERNAL_URL || "http://bot-gap:8081").replace(/\/+$/, "");

const STATIC_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../client");

const rooms = new Rooms();
const watches = new Watches();
/** Oda başına ekran paylaşımı (oda anahtarıyla). */
const shares = new Shares();

const boards = new Boards();

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
// Statik dosyalar (bellekte gzip önbelleği)
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
// .bin: chibi karakter paketi (~4.3 MB → ~2.3 MB gzip)
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".map", ".bin", ".obj"]);

interface CachedFile {
  raw: Buffer;
  gz: Buffer | null;
  type: string;
}
const fileCache = new Map<string, CachedFile>();

async function loadStatic(rel: string): Promise<CachedFile | null> {
  const hit = fileCache.get(rel);
  if (hit) return hit;
  const full = normalize(join(STATIC_DIR, rel));
  if (!full.startsWith(STATIC_DIR + sep)) return null;
  try {
    const raw = await readFile(full);
    const ext = extname(full);
    const file: CachedFile = {
      raw,
      gz: COMPRESSIBLE.has(ext) && raw.length > 1024 ? gzipSync(raw) : null,
      type: MIME[ext] || "application/octet-stream",
    };
    fileCache.set(rel, file);
    return file;
  } catch {
    return null;
  }
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
  const useGz = file.gz && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  res.writeHead(200, {
    "Content-Type": file.type,
    "Cache-Control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    ...(useGz ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
  });
  res.end(useGz ? file.gz : file.raw);
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
    const next = new URL(req.url || "/", "http://x").searchParams.get("next") || "/";
    const safeNext = /^\/[\w\-/?=&.]*$/.test(next) && !next.startsWith("//") ? next : "/";
    if (!LOGIN_REQUIRED) return redirect(res, safeNext);
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: `${publicBase(req)}/auth/callback`,
      scope: "identify",
      prompt: "none",
      state: signValue(`${Date.now()}|${safeNext}`, SESSION_SECRET),
    });
    return redirect(res, `https://discord.com/oauth2/authorize?${q}`);
  }

  if (path === "/auth/callback" && method === "GET") {
    const q = new URL(req.url || "/", "http://x").searchParams;
    const state = verifyValue(q.get("state") || "", SESSION_SECRET);
    const [ts, next] = state ? [Number(state.split("|")[0]), state.slice(state.indexOf("|") + 1)] : [0, "/"];
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
    return user ? json(res, 200, { user, loginRequired: LOGIN_REQUIRED }) : json(res, 401, { loginRequired: LOGIN_REQUIRED });
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
    for (const room of rooms.all()) room.updateJail(isExiled);
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
    const guild = typeof body.guild === "string" && /^\d{5,20}$/.test(body.guild) ? body.guild : null;
    const by = cleanName((body.by as Record<string, unknown> | undefined)?.name, "Biri");
    const w = watches.create(guild, by, media.source, media.title);
    return json(res, 200, { id: w.id, url: `${PUBLIC_URL || "http://localhost:5173"}/w/${w.id}`, title: media.title, kind: media.source.kind });
  }

  if (method === "GET" || method === "HEAD") return serveStatic(req, res, path);
  res.writeHead(405).end();
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
  const instance = url.searchParams.get("instance") || "";
  const roomName = url.searchParams.get("room") || "lobi";
  const watch = watches.get(url.searchParams.get("watch") || "");
  const close = (code: number, reason: string) => wss.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
  let key: string | null = null;
  if (url.searchParams.has("watch")) {
    if (!watch) return close(4004, "watch not found");
    // Activity'den açılan sinemanın linkiyle gelen, o Activity'nin odasına (aynı dünyaya) girer.
    if (user && (!user.guest || !LOGIN_REQUIRED)) key = Watches.roomKeyOf(watch);
  } else if (user && !user.guest && /^[\w-]{1,100}$/.test(instance)) key = `d:${instance}`;
  else if (user?.guest && /^[\w-]{1,32}$/.test(roomName)) key = `g:${roomName}`;
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
  const guild = watch?.guild ?? (/^\d{5,20}$/.test(guildParam) ? guildParam : null);
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
      if (!media) {
        ws.send(JSON.stringify({ t: "notice", text: "Bu link açılamıyor. YouTube, Twitch, Kick ya da .mp4/.webm/.m3u8 linki dene." }));
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

/** Gardırop: aç (kayıtlı kıyafet + kilitler) ya da kaydet. Misafirler ve sunucusuz odalar kullanamaz. */
async function onLookMessage(ws: WebSocket, room: Room, sid: number, user: SessionUser, guild: string | null, msg: Record<string, unknown>): Promise<void> {
  const send = (ev: ServerEvent) => ws.send(JSON.stringify(ev));
  if (DEV_WARDROBE && (user.guest || !guild || !SHARED_SECRET)) return onDevLookMessage(send, room, sid, user, msg);
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
 * Sinemayı açar. Odada zaten bir sinema varsa videosunu herkes için değiştirir; yoksa bu odaya bağlı
 * yeni bir izleme odası kurar (linkle gelenler bu odaya, aynı dünyaya girer).
 */
async function openCinema(link: string, guild: string | null, by: string, room: Room): Promise<{ url: string; title: string; reused: boolean } | { error: string }> {
  const media = await resolveMedia(link);
  if (!media) return { error: "Bu link açılamıyor. YouTube, Twitch, Kick, tabii (TRT) ya da .mp4/.webm/.m3u8 linki dene." };
  const existing = room.watchId ? watches.get(room.watchId) : undefined;
  if (existing) {
    existing.load(media.source, media.title, by, Date.now());
    sendWatch(room, existing);
    return { url: watchLink(existing), title: media.title, reused: true };
  }
  const w = watches.create(guild, by, media.source, media.title, Date.now(), room.key);
  room.watchId = w.id;
  sendWatch(room, w);
  return { url: watchLink(w), title: media.title, reused: false };
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
      cinema: (url) => openCinema(url, guild, user.name, room),
      cinemaAllowed: () => {
        const now = Date.now();
        if (now - cinemaGate.last < CINEMA_COOLDOWN_MS) return false;
        cinemaGate.last = now;
        return true;
      },
    },
    parsed.cmd,
    parsed.args,
  );
}

const FISH_REFUSED: Record<string, string> = {
  already: "🎣 Bugünkü balığını tuttun. Yarın tekrar gel, serin bozulmasın!",
  exiled: "⛓️ Sürgündeyken balık tutamazsın.",
  not_member: "🎣 Balık tutmak için bu sunucunun üyesi olmalısın.",
};

/** Bot'a günün balığını sorar; tutulduysa odaya duyurur, tutulamadıysa yalnızca tutana söyler. */
async function fish(ws: WebSocket, room: Room, sid: number, user: SessionUser, guild: string | null): Promise<void> {
  const notice = (text: string) => ws.send(JSON.stringify({ t: "notice", text }));
  if (user.guest || !guild) return notice("🎣 Balık tutmak için dünyaya Discord'dan (ses kanalındaki Activity ile) gir.");
  if (!SHARED_SECRET) return notice("🎣 Göl şu an kapalı (bot bağlı değil).");
  try {
    const r = await fetch(`${BOT_URL}/internal/fish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-world-secret": SHARED_SECRET },
      body: JSON.stringify({ guild, user: user.id }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await r.json()) as { ok?: boolean; reason?: string } & Partial<FishCatch>;
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
  } catch (err) {
    console.warn("[fish]", (err as Error).message);
    notice("🎣 Olta takıldı, biraz sonra tekrar dene.");
  }
}

function onConnection(ws: WebSocket, user: SessionUser, key: string, opts: JoinOptions, watch?: Watch): void {
  const room = rooms.get(key);
  const sid = room.join(user, ws, Date.now(), opts);
  // Kayıtlı kıyafet arka planda gelir; o zamana kadar varsayılan karakter çizilir.
  if (!user.guest && opts.guild && SHARED_SECRET) {
    void fetchLook(botPost, opts.guild, user.id).then((look) => look && room.setLook(sid, look));
  }
  sendBoard(ws, boards.for(opts.guild ?? null));
  // Sinema odaya bağlıdır: linkle gelen bağlar, Activity'den !izle ile sonradan da açılabilir.
  if (watch && !room.watchId) room.watchId = watch.id;
  const roomWatch = () => (room.watchId ? watches.get(room.watchId) : undefined);
  const current = roomWatch();
  if (current) sendWatch(ws, current);
  if (room.chat.length) ws.send(JSON.stringify({ t: "chatlog", lines: room.chat }));
  const share = shares.get(room.key);
  if (share) ws.send(JSON.stringify({ t: "share", sid: share.sid, name: share.name }));
  const limiter = { last: 0 };
  let lastEmote = 0;
  let lastAct = 0;
  let lastFish = 0;
  let lastAim = 0;
  let lastWardrobe = 0;
  let lastOutfit = 0;
  let lastChat = 0;
  const cinemaGate = { last: 0 };
  const incoming: PlayerState = { x: 0, z: 0, rot: 0, flags: 0 };
  alive.add(ws);

  ws.on("pong", () => alive.add(ws));
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = data as Buffer;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      if (decodeState(view, incoming)) room.applyState(sid, incoming);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg && typeof msg === "object" && room.battle?.handle(sid, msg)) {
        // savaş mesajı işlendi
      } else if (msg?.t === "ping" && typeof msg.c === "number") {
        ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() }));
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
        }
      } else if (msg?.t === "fish") {
        const p = room.players.get(sid);
        const now = Date.now();
        const near = p && Math.hypot(p.state.x - FISH_SPOT.x, p.state.z - FISH_SPOT.z) <= FISH_SPOT.r + 1;
        if (near && !p.info.spectator && !p.info.jailed && now - lastFish >= FISH_COOLDOWN_MS) {
          lastFish = now;
          void fish(ws, room, sid, user, opts.guild ?? null);
        }
      } else if (msg?.t === "chat") {
        const now = Date.now();
        const text = cleanChat(msg.text);
        if (!text || now - lastChat < CHAT_COOLDOWN_MS) return;
        lastChat = now;
        void onChat(ws, room, sid, user, opts.guild ?? null, text, !!watch, cinemaGate);
      } else if (msg?.t === "wardrobe" || msg?.t === "outfit") {
        const now = Date.now();
        const isSave = msg.t === "outfit";
        if (now - (isSave ? lastOutfit : lastWardrobe) < (isSave ? OUTFIT_COOLDOWN_MS : WARDROBE_COOLDOWN_MS)) return;
        if (isSave) lastOutfit = now;
        else lastWardrobe = now;
        void onLookMessage(ws, room, sid, user, opts.guild ?? null, msg);
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
        ws.send(JSON.stringify({ t: "open", url: `${watchLink(roomCinema(room, opts.guild ?? null, user.name))}?share=1` }));
      } else if (msg?.t === "emote") {
        const e = msg.e;
        const now = Date.now();
        if (Number.isInteger(e) && e >= 0 && e < EMOTES.length && now - lastEmote >= EMOTE_COOLDOWN_MS) {
          lastEmote = now;
          room.broadcast({ t: "emote", sid, e }, sid);
        }
      } else if (msg && typeof msg === "object") {
        const w = roomWatch();
        if (w) onWatchMessage(ws, room, w, user, msg, limiter);
      }
    } catch {
      // bozuk mesaj yok sayılır
    }
  });
  ws.on("close", () => {
    const s = shares.get(room.key);
    if (s?.sid === sid) {
      s.closeSender();
      endShare(room, s);
    }
    room.leave(sid);
    rooms.release(room);
  });
}

/** Odanın tarayıcı linki: sinema varsa onun, yoksa sinemasız bir izleme odası açılır (aynı dünya). */
function roomCinema(room: Room, guild: string | null, by: string): Watch {
  const existing = room.watchId ? watches.get(room.watchId) : undefined;
  if (existing) return existing;
  const w = watches.create(guild, by, null, "", Date.now(), room.key);
  room.watchId = w.id;
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

// Snapshot yayını: değişiklik varsa her tick, yoksa saniyede bir.
let tickCount = 0;
setInterval(() => {
  const now = Date.now();
  const force = ++tickCount % TICK_HZ === 0;
  for (const room of rooms.all()) room.tick(now, force);
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`[world] listening on :${PORT} (guests ${ALLOW_GUESTS ? "on" : "off"}, discord ${CLIENT_ID ? "on" : "off"}${DEV_WARDROBE ? ", yerel gardırop on" : ""})`);
});
