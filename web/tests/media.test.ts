import { describe, expect, it } from "vitest";
import { describeSource, isLive, parseMediaUrl } from "../shared/media";
import { detectHlsLive } from "../server/src/watch";

describe("parseMediaUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", { kind: "youtube", id: "dQw4w9WgXcQ", start: 0 }],
    ["https://youtu.be/dQw4w9WgXcQ?t=90", { kind: "youtube", id: "dQw4w9WgXcQ", start: 90 }],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s", { kind: "youtube", id: "dQw4w9WgXcQ", start: 90 }],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", { kind: "youtube", id: "dQw4w9WgXcQ", start: 0 }],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", { kind: "youtube", id: "dQw4w9WgXcQ", start: 0 }],
    ["https://www.twitch.tv/Elraenn", { kind: "twitch", channel: "elraenn" }],
    ["https://www.twitch.tv/videos/123456789?t=1h2m3s", { kind: "twitch-vod", video: "123456789", start: 3723 }],
    ["https://kick.com/Jahrein", { kind: "kick", channel: "jahrein" }],
    ["https://cdn.example.com/film.mp4", { kind: "file", url: "https://cdn.example.com/film.mp4", hls: false }],
    ["https://cdn.example.com/live/index.m3u8?token=x", { kind: "file", url: "https://cdn.example.com/live/index.m3u8?token=x", hls: true }],
  ])("%s", (url, expected) => {
    expect(parseMediaUrl(url)).toEqual(expected);
  });

  it.each([
    "not a url",
    "javascript:alert(1)",
    "https://www.youtube.com/watch?v=short",
    "https://www.twitch.tv/directory/game/x",
    "https://kick.com/",
    "https://www.netflix.com/watch/123",
    "ftp://example.com/film.mp4",
    "https://www.tabii.com/tr/watch/live/trtspor",
    "https://www.tabii.com/tr/watch/123",
  ])("rejects %s", (url) => {
    expect(parseMediaUrl(url)).toBeNull();
  });

  it("marks live sources and describes them", () => {
    expect(isLive(parseMediaUrl("https://kick.com/abc")!)).toBe(true);
    expect(isLive(parseMediaUrl("https://youtu.be/dQw4w9WgXcQ")!)).toBe(false);
    expect(describeSource(parseMediaUrl("https://x.com/a/Film%20Gecesi.mp4")!)).toBe("Film Gecesi.mp4");
  });

  it("tabii canlı yayın sayfasını TRT'nin açık akışına çevirir", () => {
    const s = parseMediaUrl("https://www.tabii.com/tr/watch/live/trt1?trackId=150002")!;
    expect(s).toEqual({ kind: "file", url: "https://tv-trt1.medya.trt.com.tr/master.m3u8", hls: true, live: true, label: "TRT 1" });
    expect(isLive(s)).toBe(true);
    expect(describeSource(s)).toBe("TRT 1 (canlı)");
    expect(parseMediaUrl("https://tabii.com/watch/live/trthaber")).toMatchObject({ label: "TRT Haber" });
  });
});

describe("detectHlsLive", () => {
  const lists: Record<string, string> = {
    "https://tv.example/master.m3u8": "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmaster_360.m3u8\n",
    "https://tv.example/master_360.m3u8": "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n",
    "https://vod.example/film.m3u8": "#EXTM3U\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n",
  };
  const get = async (u: string) => lists[u] ?? null;

  it("bitişi olmayan listeyi (ana listeden varyanta inerek) canlı sayar", async () => {
    expect(await detectHlsLive("https://tv.example/master.m3u8", get)).toBe(true);
    expect(await detectHlsLive("https://vod.example/film.m3u8", get)).toBe(false);
    expect(await detectHlsLive("https://down.example/x.m3u8", get)).toBe(false); // okunamadı: eski davranış
  });
});
