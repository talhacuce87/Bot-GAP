// YouTube/Twitch/Kick'i sunucu üzerinden aktarır: yt-dlp sayfa linkini gerçek akış adreslerine çevirir,
// akış medya proxy'sinden (mediaProxy.ts) herkese gider. Gömülü oynatıcı (iframe) yerine perdede <video>
// oynar: senkron dosyadaki gibi hızla ince ayarlanır, gömme yasağı / reklam / çerez penceresi olmaz.
//
// - Canlı yayın (Kick, Twitch, YouTube canlı) ve HLS veren her şey: sitenin ana çalma listesi aktarılır.
// - YouTube kayıtlı video: görüntü ve ses ayrı fMP4 dosyaları. Dosyanın başındaki dizinden (sidx) bayt
//   aralıklı bir HLS listesi kurulur; her parça Range isteğiyle proxy'den geçer (proxy önbelleğe alır).
// - İkisi de olmazsa YouTube'un tek parça 360p MP4'ü.
// YouTube adresleri sunucunun IP'sine bağlıdır: izleyiciler doğrudan çekemez, her bayt sunucudan geçer.
import { execFile } from "node:child_process";
import type { Source } from "../../shared/media";

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const RESOLVE_TIMEOUT_MS = 45_000;
/** YouTube adresleri ~6 saatte geçersizleşir; bundan eskiyse liste istenince yeniden çözülür. */
const MAX_AGE_MS = 4 * 3600 * 1000;
const MAX_HEIGHT = 1080;
const HEAD_BYTES = 128 * 1024;

export interface Segment {
  offset: number;
  size: number;
  duration: number;
}

export interface Track {
  url: string;
  codecs: string;
  bandwidth: number;
  width?: number;
  height?: number;
  /** ftyp + moov: bayt aralığı [başlangıç, uzunluk]. */
  init: [number, number];
  segments: Segment[];
}

export type RelayPlan =
  | { kind: "hls"; url: string; live: boolean }
  | { kind: "dash"; video: Track[]; audio: Track }
  | { kind: "mp4"; url: string };

export interface Relay {
  plan: RelayPlan;
  title: string | null;
  at: number;
}

/** yt-dlp -J çıktısının kullandığımız kısmı. */
export interface YtFormat {
  format_id?: string;
  url?: string;
  manifest_url?: string;
  protocol?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  tbr?: number;
  abr?: number;
  language_preference?: number;
  /** YouTube adresi bu andan (epoch sn) önce 403 döner: site birkaç saniye bekletir. */
  available_at?: number;
}
export interface YtInfo {
  title?: string;
  is_live?: boolean;
  formats?: YtFormat[];
}

/** Kaynağın sayfa linki (yt-dlp'ye verilen); dosyada null. */
export function pageUrl(s: Source): string | null {
  switch (s.kind) {
    case "youtube":
      return `https://www.youtube.com/watch?v=${s.id}`;
    case "twitch":
      return `https://www.twitch.tv/${s.channel}`;
    case "twitch-vod":
      return `https://www.twitch.tv/videos/${s.video}`;
    case "kick":
      return `https://kick.com/${s.channel}`;
    case "file":
      return null;
  }
}

function runYtDlp(url: string): Promise<YtInfo | null> {
  return new Promise((resolve) => {
    execFile(
      YTDLP,
      ["-J", "--no-playlist", "--no-warnings", "--js-runtimes", "node", url],
      { timeout: RESOLVE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn(`[relay] yt-dlp çözemedi (${url}): ${String(stderr || err.message).trim().split("\n").pop()}`);
          return resolve(null);
        }
        try {
          resolve(JSON.parse(stdout) as YtInfo);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** YouTube sık değişir, eski yt-dlp çözemez: açılışta ve günde bir kendini günceller (yazılabilirse). */
export function keepYtDlpFresh(): void {
  const update = () =>
    execFile(YTDLP, ["-U"], { timeout: 120_000 }, (err, stdout) => {
      const line = String(stdout).trim().split("\n").pop();
      if (err) console.warn(`[relay] yt-dlp güncellenemedi: ${err.message.split("\n")[0]}`);
      else if (line) console.log(`[relay] ${line}`);
    });
  update();
  setInterval(update, 24 * 3600 * 1000).unref();
}

const isHls = (f: YtFormat) => /^m3u8/.test(f.protocol ?? "");
const hasVideo = (f: YtFormat) => !!f.vcodec && f.vcodec !== "none";
const hasAudio = (f: YtFormat) => !!f.acodec && f.acodec !== "none";

/** Canlı/HLS: sitenin ana listesi (uyarlamalı kalite); yoksa en iyi varyantın kendisi. */
export function pickHls(info: YtInfo): string | null {
  const list = (info.formats ?? []).filter((f) => isHls(f) && (f.manifest_url || f.url));
  if (!list.length) return null;
  const withManifest = list.find((f) => f.manifest_url);
  if (withManifest) return withManifest.manifest_url!;
  return list.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0].url!;
}

/** YouTube ayrık akışları: H.264 görüntüler (her yükseklikten en iyisi, ≤1080p) ve AAC ses. */
export function pickDash(info: YtInfo): { video: YtFormat[]; audio: YtFormat } | null {
  const plain = (info.formats ?? []).filter((f) => f.url && f.protocol === "https" && f.ext !== "webm");
  // Çok dilli videolarda özgün ses (language_preference yüksek); "drc" (sıkıştırılmış dinamik) sonda
  const audio = plain
    .filter((f) => !hasVideo(f) && /^mp4a/.test(f.acodec ?? ""))
    .sort((a, b) => (b.language_preference ?? 0) - (a.language_preference ?? 0) || +/drc/.test(a.format_id ?? "") - +/drc/.test(b.format_id ?? "") || (b.abr ?? 0) - (a.abr ?? 0))[0];
  const byHeight = new Map<number, YtFormat>();
  for (const f of plain) {
    if (!/^avc1/.test(f.vcodec ?? "") || hasAudio(f) || !f.height || f.height > MAX_HEIGHT) continue;
    const prev = byHeight.get(f.height);
    if (!prev || (f.tbr ?? 0) > (prev.tbr ?? 0)) byHeight.set(f.height, f);
  }
  const video = [...byHeight.values()].sort((a, b) => b.height! - a.height!).slice(0, 4);
  return audio && video.length ? { video, audio } : null;
}

/** Görüntü+ses bir arada MP4 (YouTube'da 360p): son çare. */
export function pickMuxed(info: YtInfo): YtFormat | null {
  return (info.formats ?? [])
    .filter((x) => x.url && x.protocol === "https" && x.ext === "mp4" && hasVideo(x) && hasAudio(x))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0] ?? null;
}

/** YouTube'un bekletme süresi (available_at) dolana kadar bekler. */
async function untilAvailable(f: YtFormat): Promise<void> {
  const wait = (f.available_at ?? 0) * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait + 200, 15_000)));
}

// ---------------------------------------------------------------------------
// fMP4 dizini (sidx): parçaların bayt aralıkları ve süreleri
// ---------------------------------------------------------------------------

interface Box {
  type: string;
  start: number;
  size: number;
}

function* boxes(buf: Buffer): Generator<Box> {
  let at = 0;
  while (at + 8 <= buf.length) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    if (size === 1) {
      if (at + 16 > buf.length) return;
      size = Number(buf.readBigUInt64BE(at + 8));
    }
    if (size < 8) return;
    yield { type, start: at, size };
    at += size;
  }
}

/**
 * Dosya başından init aralığını ve sidx'i okur. Eksikse istenecek bayt sayısını (`need`) döner.
 * Desteklenmeyen yapıda null.
 */
export function parseIndex(buf: Buffer): { init: [number, number]; segments: Segment[] } | { need: number } | null {
  let initEnd = -1;
  for (const b of boxes(buf)) {
    if (b.type === "moov") initEnd = b.start + b.size;
    if (b.type === "moof" || b.type === "mdat") return null; // dizin yok
    if (b.type !== "sidx") continue;
    if (b.start + b.size > buf.length) return { need: b.start + b.size };
    if (initEnd < 0) return null;
    let p = b.start + 8;
    const version = buf.readUInt8(p);
    p += 4 + 4; // sürüm/bayraklar, reference_ID
    const timescale = buf.readUInt32BE(p);
    p += 4;
    let firstOffset: number;
    if (version === 0) {
      firstOffset = buf.readUInt32BE(p + 4);
      p += 8;
    } else {
      firstOffset = Number(buf.readBigUInt64BE(p + 8));
      p += 16;
    }
    p += 2; // ayrılmış
    const count = buf.readUInt16BE(p);
    p += 2;
    let offset = b.start + b.size + firstOffset;
    const segments: Segment[] = [];
    for (let i = 0; i < count; i++) {
      const ref = buf.readUInt32BE(p);
      const dur = buf.readUInt32BE(p + 4);
      p += 12;
      if (ref & 0x80000000) return null; // iç içe sidx: YouTube'da olmaz
      const size = ref & 0x7fffffff;
      segments.push({ offset, size, duration: dur / timescale });
      offset += size;
    }
    return segments.length ? { init: [0, initEnd], segments } : null;
  }
  // sidx henüz okunan baytların ötesinde olabilir (moov büyükse)
  return buf.length < 2 * 1024 * 1024 ? { need: buf.length * 2 } : null;
}

async function fetchHead(url: string, bytes: number): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

async function loadTrack(f: YtFormat, codecs: string): Promise<Track | null> {
  await untilAvailable(f);
  let bytes = HEAD_BYTES;
  for (let i = 0; i < 4; i++) {
    const buf = await fetchHead(f.url!, bytes);
    if (!buf) return null;
    const idx = parseIndex(buf);
    if (!idx) return null;
    if ("need" in idx) {
      if (buf.length < bytes) return null; // dosya bitti, sidx yok
      bytes = idx.need;
      continue;
    }
    return { url: f.url!, codecs, bandwidth: Math.round((f.tbr ?? f.abr ?? 1000) * 1000), width: f.width, height: f.height, init: idx.init, segments: idx.segments };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HLS listeleri
// ---------------------------------------------------------------------------

/** Ana liste: görüntü varyantları ve ortak ses grubu. Adresler listenin kendisine göre görelidir. */
export function masterPlaylist(video: Track[], audio: Track): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Ses",DEFAULT=YES,AUTOSELECT=YES,URI="relay-a.m3u8"`);
  video.forEach((v, i) => {
    const res = v.width && v.height ? `,RESOLUTION=${v.width}x${v.height}` : "";
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth + audio.bandwidth}${res},CODECS="${v.codecs},${audio.codecs}",AUDIO="a"`);
    lines.push(`relay-v${i}.m3u8`);
  });
  return lines.join("\n") + "\n";
}

/** Bayt aralıklı medya listesi; parçalar `toProxy` adresinden (Range isteğiyle) çekilir. */
export function mediaPlaylist(t: Track, toProxy: (abs: string) => string): string {
  const ref = toProxy(t.url);
  const target = Math.ceil(Math.max(...t.segments.map((s) => s.duration)));
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-MEDIA-SEQUENCE:0"];
  lines.push(`#EXT-X-MAP:URI="${ref}",BYTERANGE="${t.init[1] - t.init[0]}@${t.init[0]}"`);
  for (const s of t.segments) lines.push(`#EXTINF:${s.duration.toFixed(3)},`, `#EXT-X-BYTERANGE:${s.size}@${s.offset}`, ref);
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------

export class Relays {
  private byKey = new Map<string, Relay>();
  private pending = new Map<string, Promise<Relay | null>>();

  constructor(private resolveInfo: (url: string) => Promise<YtInfo | null> = runYtDlp) {}

  /** Kaynağı aktarmaya hazırlar (önbellekte tazeyse hemen). Çözülemezse null: gömülü oynatıcıya dönülür. */
  prepare(s: Source, now = Date.now()): Promise<Relay | null> {
    const url = pageUrl(s);
    if (!url) return Promise.resolve(null);
    const cached = this.byKey.get(url);
    if (cached && now - cached.at < MAX_AGE_MS && cached.plan.kind !== "hls") return Promise.resolve(cached);
    let p = this.pending.get(url);
    if (!p) {
      p = this.build(url).finally(() => this.pending.delete(url));
      this.pending.set(url, p);
    }
    return p;
  }

  /** Hazırlanmış aktarma (liste isteklerinde); eskiyse yeniden çözülür. */
  async get(s: Source, now = Date.now()): Promise<Relay | null> {
    const url = pageUrl(s);
    if (!url) return null;
    const r = this.byKey.get(url);
    if (r && now - r.at < MAX_AGE_MS) return r;
    return this.prepare(s, now);
  }

  private async build(url: string): Promise<Relay | null> {
    const info = await this.resolveInfo(url);
    if (!info) return null;
    const plan = await this.plan(info);
    if (!plan) return null;
    const relay: Relay = { plan, title: info.title ? String(info.title).slice(0, 120) : null, at: Date.now() };
    this.byKey.set(url, relay);
    if (this.byKey.size > 50) this.byKey.delete(this.byKey.keys().next().value!);
    return relay;
  }

  private async plan(info: YtInfo): Promise<RelayPlan | null> {
    const hls = pickHls(info);
    if (info.is_live || (hls && !pickDash(info))) return hls ? { kind: "hls", url: hls, live: !!info.is_live } : null;
    const dash = pickDash(info);
    if (dash) {
      const audio = await loadTrack(dash.audio, dash.audio.acodec!);
      const video = audio ? (await Promise.all(dash.video.map((f) => loadTrack(f, f.vcodec!)))).filter((t): t is Track => !!t) : [];
      if (audio && video.length) return { kind: "dash", video, audio };
    }
    const mp4 = pickMuxed(info);
    if (!mp4) return null;
    await untilAvailable(mp4);
    return { kind: "mp4", url: mp4.url! };
  }
}

/** Aktarılan kaynağın proxy'de izin verilecek adresleri (origin'leri çıkarılır). */
export function relayUrls(plan: RelayPlan): string[] {
  if (plan.kind === "dash") return [plan.audio.url, ...plan.video.map((v) => v.url)];
  return [plan.url];
}
