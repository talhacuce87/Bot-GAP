// Sinema videosunu sunucu üzerinden aktarır: Activity, dış video sunucularına erişemez ama kendi
// origin'imizden (/.proxy/media/...) gelen videoyu oynatır. Yalnızca doğrudan dosya ve HLS (TRT vb.);
// YouTube/Twitch/Kick aktarılmaz (kullanım koşulları; tarayıcıda izlenir).
//
// Güvenlik: kullanıcının verdiği linki sunucu çeker, bu yüzden özel/iç ağ adresleri (127.x, 10.x,
// 172.16-31.x, 192.168.x, 169.254.x, Docker servis adları…) engellenir, yönlendirmeler tek tek denetlenir
// ve yalnızca o sinemanın kaynağıyla aynı origin'e (ya da çalma listesinin işaret ettiği origin'lere) gidilir.
import { lookup as dnsCallbackLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

const PLAYLIST_MAX = 2 * 1024 * 1024;
const SEGMENT_CACHE_MAX = 8 * 1024 * 1024; // tek parça
const CACHE_BYTES = 256 * 1024 * 1024; // toplam
const SEGMENT_TTL_MS = 60_000;
const PLAYLIST_TTL_MS = 1_000;
const MAX_REDIRECTS = 3;

/** Özel, döngü, yerel-bağlantı ve ayrılmış adresler: sunucu bunlara asla istek atmaz. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
}

export type Lookup = (host: string) => Promise<string[]>;
export type Fetcher = (url: URL, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
const dnsLookup: Lookup = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/** Adres herkese açık mı: http(s), varsayılan dışı portlar dahil, ama özel IP'ye çözülmüyor. */
export async function isPublicUrl(url: URL, resolve: Lookup = dnsLookup): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  try {
    const ips = isIP(host) ? [host] : await resolve(host);
    return ips.length > 0 && !ips.some(isPrivateIp);
  } catch {
    return false;
  }
}

/**
 * Bağlantı anında denetlenen DNS: bağlanılacak IP'lerden biri bile özelse bağlantı kurulmaz.
 * Önce kontrol edip sonra ayrıca çözmek DNS rebinding'e açık olurdu; burada kontrol edilen IP'ye bağlanılır.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsCallbackLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, "", 4);
    const list = addresses.filter((a) => (!options.family || a.family === options.family));
    if (!list.length || list.some((a) => isPrivateIp(a.address))) {
      return callback(Object.assign(new Error(`özel adres engellendi: ${hostname}`), { code: "EBLOCKED" }), "", 4);
    }
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

/** Yönlendirme izlemeyen, güvenli DNS'li HTTP(S) isteği; yanıtı web Response olarak döner. */
const guardedFetch: Fetcher = (url, init) =>
  new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: "GET", headers: { "User-Agent": "GAP-Dunyasi/1.0", ...init.headers }, lookup: guardedLookup, signal: init.signal },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        const status = res.statusCode ?? 502;
        const noBody = status === 204 || status === 304 || (status >= 300 && status < 400);
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });

/**
 * HLS çalma listesindeki adresleri aktarma adresine çevirir: medya satırları ve URI="…" öznitelikleri.
 * `onOrigin` listenin işaret ettiği her origin'i bildirir (CDN'e izin vermek için).
 */
export function rewritePlaylist(text: string, base: URL, toProxy: (abs: string) => string, onOrigin: (origin: string) => void): string {
  const fix = (ref: string) => {
    const abs = new URL(ref, base);
    onOrigin(abs.origin);
    return toProxy(abs.toString());
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (!t.startsWith("#")) return fix(t);
      return line.replace(/URI="([^"]+)"/g, (_m, ref: string) => `URI="${fix(ref)}"`);
    })
    .join("\n");
}

/** Aktarma adresi: çalma listesinin kendi adresine göre göreli (Activity'de /.proxy öneki korunur). */
export function proxyRef(abs: string): string {
  return `p?u=${encodeURIComponent(abs)}`;
}

interface CacheEntry {
  body: Buffer;
  type: string;
  expires: number;
}

export interface ProxyStats {
  /** Toplam gönderilen bayt. */
  bytes: number;
  /** Son 10 sn ortalaması (Mbit/sn). */
  mbps: number;
  /** Şu an akan istek sayısı. */
  active: number;
  /** Önbellek isabeti / toplam parça isteği. */
  hits: number;
  requests: number;
  cacheBytes: number;
}

export class MediaProxy {
  private cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  /** Sinema başına kaynak ve izinli origin'ler (kaynak + çalma listelerinin işaret ettikleri). */
  private origins = new Map<string, Set<string>>();
  private sources = new Map<string, string>();
  private sent = 0;
  private window: { at: number; bytes: number }[] = [];
  private active = 0;
  private hits = 0;
  private requests = 0;

  constructor(
    private fetchImpl: Fetcher = guardedFetch,
    private resolve: Lookup = dnsLookup,
  ) {}

  /** Sinemanın kaynağı değişince izinli origin'ler sıfırlanır (oynat/duraklatta korunur). */
  allow(watchId: string, sourceUrl: string): void {
    if (this.sources.get(watchId) === sourceUrl) return;
    this.sources.set(watchId, sourceUrl);
    this.origins.set(watchId, new Set([new URL(sourceUrl).origin]));
  }

  forget(watchId: string): void {
    this.origins.delete(watchId);
    this.sources.delete(watchId);
  }

  stats(now = Date.now()): ProxyStats {
    this.window = this.window.filter((w) => now - w.at < 10_000);
    const recent = this.window.reduce((s, w) => s + w.bytes, 0);
    return { bytes: this.sent, mbps: +((recent * 8) / 10 / 1e6).toFixed(2), active: this.active, hits: this.hits, requests: this.requests, cacheBytes: this.cacheBytes };
  }

  private count(n: number): void {
    this.sent += n;
    this.window.push({ at: Date.now(), bytes: n });
    if (this.window.length > 5000) this.window.splice(0, 2500);
  }

  /** Yönlendirmeleri tek tek denetleyerek çeker; her adım herkese açık adres olmalı. */
  private async safeFetch(url: URL, headers: Record<string, string>): Promise<Response | null> {
    let current = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (!(await isPublicUrl(current, this.resolve))) return null;
      const r = await this.fetchImpl(current, { headers, signal: AbortSignal.timeout(15_000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        current = new URL(r.headers.get("location")!, current);
        continue;
      }
      return r;
    }
    return null;
  }

  private remember(key: string, body: Buffer, type: string, ttl: number): void {
    if (body.length > SEGMENT_CACHE_MAX) return;
    const old = this.cache.get(key);
    if (old) this.cacheBytes -= old.body.length;
    this.cache.set(key, { body, type, expires: Date.now() + ttl });
    this.cacheBytes += body.length;
    const now = Date.now();
    for (const [k, e] of this.cache) {
      if (this.cacheBytes <= CACHE_BYTES && e.expires > now) break;
      this.cache.delete(k);
      this.cacheBytes -= e.body.length;
    }
  }

  private send(res: ServerResponse, status: number, type: string, body: Buffer, cache: string): void {
    res.writeHead(status, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": cache, "Access-Control-Allow-Origin": "*" });
    res.end(body);
    this.count(body.length);
  }

  /** GET /media/<watchId>/p?u=<adres> */
  async handle(res: ServerResponse, watchId: string, target: string | null, range: string | undefined): Promise<void> {
    const allowed = this.origins.get(watchId);
    let url: URL;
    try {
      url = new URL(target ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!allowed || !allowed.has(url.origin)) {
      res.writeHead(403).end();
      return;
    }
    const key = url.toString();
    const isPlaylist = /\.m3u8$/i.test(url.pathname);
    this.requests++;
    const hit = !range ? this.cache.get(key) : undefined;
    if (hit && hit.expires > Date.now()) {
      this.hits++;
      return this.send(res, 200, hit.type, hit.body, isPlaylist ? "no-cache" : "public, max-age=30");
    }

    this.active++;
    try {
      const upstream = await this.safeFetch(url, range ? { Range: range } : {});
      if (!upstream || (!upstream.ok && upstream.status !== 206)) {
        res.writeHead(upstream?.status === 404 ? 404 : 502).end();
        return;
      }
      const type = upstream.headers.get("content-type") || "application/octet-stream";
      if (isPlaylist || /mpegurl/i.test(type)) {
        const text = (await upstream.text()).slice(0, PLAYLIST_MAX);
        const body = Buffer.from(rewritePlaylist(text, url, proxyRef, (o) => allowed.add(o)));
        this.remember(key, body, "application/vnd.apple.mpegurl", PLAYLIST_TTL_MS);
        return this.send(res, 200, "application/vnd.apple.mpegurl", body, "no-cache");
      }
      const length = Number(upstream.headers.get("content-length") || NaN);
      // Küçük parçalar (HLS segmentleri) bir kez çekilip izleyicilere bellekten dağıtılır
      if (!range && upstream.status === 200 && Number.isFinite(length) && length <= SEGMENT_CACHE_MAX) {
        const body = Buffer.from(await upstream.arrayBuffer());
        this.remember(key, body, type, SEGMENT_TTL_MS);
        return this.send(res, 200, type, body, "public, max-age=30");
      }
      // Büyük dosya (mp4): olduğu gibi akıt, sarma için Range geçer
      const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
      for (const h of ["content-length", "content-range"]) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      res.writeHead(upstream.status, headers);
      if (!upstream.body) {
        res.end();
        return;
      }
      const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
      stream.on("data", (c: Buffer) => this.count(c.length));
      res.on("close", () => stream.destroy());
      await new Promise<void>((resolve) => {
        stream.on("end", resolve);
        stream.on("error", () => resolve());
        stream.on("close", resolve);
        stream.pipe(res);
      });
    } catch {
      if (!res.headersSent) res.writeHead(502).end();
      else res.end();
    } finally {
      this.active--;
    }
  }
}
