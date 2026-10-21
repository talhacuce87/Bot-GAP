// Watch party odaları: tek otoriter durum (kaynak, oynuyor mu, konum). İstemciler buna göre kendini ayarlar.
import { randomBytes } from "node:crypto";
import { describeSource, isLive, parseMediaUrl, type Source } from "../../shared/media";
import type { WatchState } from "../../shared/protocol";

/** Kimse yokken oda bu kadar saklanır. */
export const WATCH_IDLE_MS = 6 * 60 * 60 * 1000;
const MAX_POSITION = 7 * 24 * 3600;

export type WatchCommand = { op: "play" | "pause" | "seek"; pos?: number };

export class Watch {
  readonly state: WatchState;
  lastActive: number;
  /** Son video yüklendiği an: "bitti" bildirimleri yeni videoyu atlatmasın. */
  loadedAt: number;

  constructor(
    readonly id: string,
    readonly guild: string | null,
    readonly createdBy: string,
    /** null: sinemasız oda (ör. yalnızca ekran paylaşımı için açılan tarayıcı linki). */
    source: Source | null,
    title: string,
    now: number,
    /** Activity'den açıldıysa o odanın anahtarı: linkle gelenler de aynı odaya (ve dünyaya) girer. */
    readonly roomKey: string | null = null,
  ) {
    this.lastActive = now;
    this.loadedAt = now;
    this.state = { source, title, playing: true, position: source && (source.kind === "youtube" || source.kind === "twitch-vod") ? source.start : 0, updatedAt: now, by: createdBy, op: "load" };
  }

  /** Şu anki konum (saniye): oynuyorsa son güncellemeden beri geçen süre eklenir. */
  positionAt(now: number): number {
    const s = this.state;
    return s.playing ? s.position + (now - s.updatedAt) / 1000 : s.position;
  }

  load(source: Source, title: string, by: string, now: number): void {
    const start = source.kind === "youtube" || source.kind === "twitch-vod" ? source.start : 0;
    Object.assign(this.state, { source, title, playing: true, position: start, updatedAt: now, by, op: "load" });
    this.lastActive = now;
    this.loadedAt = now;
  }

  /** Geçersiz ya da anlamsız komutta false (canlı yayında sarma gibi). */
  apply(cmd: WatchCommand, by: string, now: number): boolean {
    const s = this.state;
    if (!s.source) return false;
    const live = isLive(s.source);
    const pos = typeof cmd.pos === "number" && Number.isFinite(cmd.pos) ? Math.min(MAX_POSITION, Math.max(0, cmd.pos)) : null;
    switch (cmd.op) {
      case "play":
        if (s.playing) return false;
        s.position = live ? 0 : (pos ?? s.position);
        s.playing = true;
        break;
      case "pause":
        if (!s.playing || live) return false;
        s.position = this.positionAt(now);
        s.playing = false;
        break;
      case "seek":
        if (live || pos === null) return false;
        s.position = pos;
        break;
      default:
        return false;
    }
    s.updatedAt = now;
    s.by = by;
    s.op = cmd.op;
    this.lastActive = now;
    return true;
  }
}

export class Watches {
  private byId = new Map<string, Watch>();

  create(guild: string | null, by: string, source: Source | null, title: string, now = Date.now(), roomKey: string | null = null): Watch {
    let id: string;
    do id = randomBytes(6).toString("base64url");
    while (this.byId.has(id));
    const w = new Watch(id, guild, by, source, title, now, roomKey);
    this.byId.set(id, w);
    return w;
  }

  get(id: string): Watch | undefined {
    return this.byId.get(id);
  }

  /** Odası boş ve uzun süredir dokunulmamış izleme odalarını siler; silinenlerin kimliklerini döner. */
  sweep(isEmpty: (w: Watch) => boolean, now = Date.now()): string[] {
    const removed: string[] = [];
    for (const [id, w] of this.byId) {
      if (isEmpty(w) && now - w.lastActive > WATCH_IDLE_MS) {
        this.byId.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /** İzleme odasının oyuncularının bulunduğu oda: Activity'ye bağlıysa o oda, değilse kendi odası. */
  static roomKeyOf(w: Watch): string {
    return w.roomKey ?? `w:${w.id}`;
  }
}

/** Çalma listesini okur (en fazla 64 KB, 4 sn). Okunamazsa null. */
async function fetchPlaylist(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return (await r.text()).slice(0, 64 * 1024);
  } catch {
    return null;
  }
}

/**
 * HLS canlı mı: bitiş etiketi (#EXT-X-ENDLIST) olmayan medya çalma listesi canlıdır.
 * Ana listeyse ilk varyanta bakılır. Okunamazsa kayıtlı video sayılır (eski davranış).
 */
export async function detectHlsLive(url: string, get: (u: string) => Promise<string | null> = fetchPlaylist): Promise<boolean> {
  let text = await get(url);
  if (!text) return false;
  if (text.includes("#EXT-X-STREAM-INF")) {
    const variant = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (!variant) return false;
    text = await get(new URL(variant, url).toString());
    if (!text) return false;
  }
  return !text.includes("#EXT-X-ENDLIST");
}

/** Link → kaynak + başlık. YouTube başlığı oEmbed'den alınır; alınamazsa kaynağın adı kullanılır. */
export async function resolveMedia(url: string): Promise<{ source: Source; title: string } | null> {
  const source = parseMediaUrl(url);
  if (!source) return null;
  if (source.kind === "file" && source.hls && source.live === undefined) source.live = await detectHlsLive(source.url);
  let title = describeSource(source);
  if (source.kind === "youtube") {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${source.id}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (r.ok) title = String(((await r.json()) as { title?: string }).title || title).slice(0, 120);
    } catch {
      // başlıksız da oynar
    }
  }
  return { source, title };
}
