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

  constructor(
    readonly id: string,
    readonly guild: string | null,
    readonly createdBy: string,
    source: Source,
    title: string,
    now: number,
  ) {
    this.lastActive = now;
    this.state = { source, title, playing: true, position: source.kind === "youtube" || source.kind === "twitch-vod" ? source.start : 0, updatedAt: now, by: createdBy, op: "load" };
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

  create(guild: string | null, by: string, source: Source, title: string, now = Date.now()): Watch {
    let id: string;
    do id = randomBytes(6).toString("base64url");
    while (this.byId.has(id));
    const w = new Watch(id, guild, by, source, title, now);
    this.byId.set(id, w);
    return w;
  }

  get(id: string): Watch | undefined {
    return this.byId.get(id);
  }

  /** Boş ve uzun süredir dokunulmamış odaları siler. */
  sweep(isEmpty: (id: string) => boolean, now = Date.now()): void {
    for (const [id, w] of this.byId) if (isEmpty(id) && now - w.lastActive > WATCH_IDLE_MS) this.byId.delete(id);
  }
}

/** Link → kaynak + başlık. YouTube başlığı oEmbed'den alınır; alınamazsa kaynağın adı kullanılır. */
export async function resolveMedia(url: string): Promise<{ source: Source; title: string } | null> {
  const source = parseMediaUrl(url);
  if (!source) return null;
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
