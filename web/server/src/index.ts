// GAP Dünyası sunucusu: statik istemci, Discord giriş API'si, avatar proxy'si ve WebSocket odaları.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";
import { TICK_HZ } from "../../shared/constants";
import { decodeState, type PlayerState } from "../../shared/protocol";
import { cleanName, exchangeCode, type SessionUser, signSession, verifySession } from "./auth";
import { type Board, Boards } from "./board";
import { type Conn, type JoinOptions, Rooms } from "./room";

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const SHARED_SECRET = process.env.WORLD_SHARED_SECRET || "";
const ALLOW_GUESTS = (process.env.WORLD_ALLOW_GUESTS ?? "true").toLowerCase() !== "false";
// Ortak secret yoksa oturumlar sadece bu süreç ömrü boyunca geçerlidir.
const SESSION_SECRET = SHARED_SECRET || randomBytes(32).toString("hex");

const STATIC_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../client");

const rooms = new Rooms();

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
  ".ico": "image/x-icon",
  ".map": "application/json",
};
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);

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

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const alive = new WeakSet<WebSocket>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://x");
  if (routePath(url.pathname) !== "/ws") {
    socket.destroy();
    return;
  }
  const user = verifySession(url.searchParams.get("session") || "", SESSION_SECRET);
  const instance = url.searchParams.get("instance") || "";
  const roomName = url.searchParams.get("room") || "lobi";
  let key: string | null = null;
  if (user && !user.guest && /^[\w-]{1,100}$/.test(instance)) key = `d:${instance}`;
  else if (user?.guest && /^[\w-]{1,32}$/.test(roomName)) key = `g:${roomName}`;
  if (!user || !key) {
    // HTTP 401 tarayıcıda 1006 olarak görünür; 4001 ile kapatırsak istemci yeniden denemeyi bırakır.
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, "unauthorized"));
    return;
  }
  const roomKey = key;
  const guildParam = url.searchParams.get("guild") || "";
  const guild = /^\d{5,20}$/.test(guildParam) ? guildParam : null;
  // Zindanı denemek için: yalnızca misafirler kendini zindana koyabilir.
  const forceJail = user.guest && url.searchParams.get("jail") === "1";
  const jailed = forceJail || (!user.guest && isExiled(user.id, guild));
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user, roomKey, { guild, jailed, forceJail }));
});

function onConnection(ws: WebSocket, user: SessionUser, key: string, opts: JoinOptions): void {
  const room = rooms.get(key);
  const sid = room.join(user, ws, Date.now(), opts);
  sendBoard(ws, boards.for(opts.guild ?? null));
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
      if (msg?.t === "ping" && typeof msg.c === "number") {
        ws.send(JSON.stringify({ t: "pong", c: msg.c, s: Date.now() }));
      }
    } catch {
      // bozuk mesaj yok sayılır
    }
  });
  ws.on("close", () => {
    room.leave(sid);
    rooms.release(room);
  });
}

// Ölü bağlantıları temizle.
setInterval(() => {
  for (const ws of wss.clients) {
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
  console.log(`[world] listening on :${PORT} (guests ${ALLOW_GUESTS ? "on" : "off"}, discord ${CLIENT_ID ? "on" : "off"})`);
});
