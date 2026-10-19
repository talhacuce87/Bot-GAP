import { describe, expect, it } from "vitest";
import { describeSource, isLive, parseMediaUrl } from "../shared/media";

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
  ])("rejects %s", (url) => {
    expect(parseMediaUrl(url)).toBeNull();
  });

  it("marks live sources and describes them", () => {
    expect(isLive(parseMediaUrl("https://kick.com/abc")!)).toBe(true);
    expect(isLive(parseMediaUrl("https://youtu.be/dQw4w9WgXcQ")!)).toBe(false);
    expect(describeSource(parseMediaUrl("https://x.com/a/Film%20Gecesi.mp4")!)).toBe("Film Gecesi.mp4");
  });
});
