// Watch party kaynakları: hangi linkin nasıl oynatılacağını belirler (istemci ve sunucu ortak).

export type Source =
  | { kind: "youtube"; id: string; start: number }
  | { kind: "twitch"; channel: string }
  | { kind: "twitch-vod"; video: string; start: number }
  | { kind: "kick"; channel: string }
  | { kind: "file"; url: string; hls: boolean };

/** Canlı yayınlar herkes için zaten aynı anda akar: konum senkronu ve sarma yoktur. */
export function isLive(s: Source): boolean {
  return s.kind === "twitch" || s.kind === "kick";
}

const YT_ID = /^[\w-]{11}$/;
const CHANNEL = /^[A-Za-z0-9_]{2,30}$/;
const VIDEO_EXT = /\.(mp4|webm|m4v|mov|ogv|m3u8)$/i;

/** "1h2m3s", "90", "1m30s" → saniye */
function parseTime(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
}

/** Desteklenen bir link değilse null. */
export function parseMediaUrl(raw: string): Source | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
    let id = url.searchParams.get("v");
    if (!id && ["shorts", "live", "embed"].includes(parts[0])) id = parts[1] ?? null;
    if (id && YT_ID.test(id)) return { kind: "youtube", id, start: parseTime(url.searchParams.get("t") || url.searchParams.get("start")) };
    return null;
  }
  if (host === "youtu.be") {
    const id = parts[0];
    if (id && YT_ID.test(id)) return { kind: "youtube", id, start: parseTime(url.searchParams.get("t")) };
    return null;
  }
  if (host === "twitch.tv") {
    if (parts[0] === "videos" && /^\d+$/.test(parts[1] ?? "")) {
      return { kind: "twitch-vod", video: parts[1], start: parseTime(url.searchParams.get("t")) };
    }
    if (parts.length === 1 && CHANNEL.test(parts[0])) return { kind: "twitch", channel: parts[0].toLowerCase() };
    return null;
  }
  if (host === "kick.com") {
    if (parts.length === 1 && CHANNEL.test(parts[0])) return { kind: "kick", channel: parts[0].toLowerCase() };
    return null;
  }
  if (VIDEO_EXT.test(url.pathname)) {
    return { kind: "file", url: url.toString(), hls: /\.m3u8$/i.test(url.pathname) };
  }
  return null;
}

export function describeSource(s: Source): string {
  switch (s.kind) {
    case "youtube":
      return "YouTube";
    case "twitch":
      return `Twitch · ${s.channel} (canlı)`;
    case "twitch-vod":
      return "Twitch video";
    case "kick":
      return `Kick · ${s.channel} (canlı)`;
    case "file":
      return decodeURIComponent(s.url.split("/").pop()!.split("?")[0]) || "Video";
  }
}
