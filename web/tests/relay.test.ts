import { describe, expect, it } from "vitest";
import { masterPlaylist, mediaPlaylist, pageUrl, parseIndex, pickDash, pickHls, pickMuxed, Relays, type Track, type YtInfo } from "../server/src/relay";
import { resolveMedia } from "../server/src/watch";

function box(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

/** sidx v0: timescale 1000, ilk parça sidx'ten `gap` bayt sonra. */
function sidx(refs: [size: number, ms: number][], gap = 0): Buffer {
  const b = Buffer.alloc(24 + refs.length * 12);
  b.writeUInt32BE(0, 0); // sürüm 0, bayraklar
  b.writeUInt32BE(1, 4); // reference_ID
  b.writeUInt32BE(1000, 8);
  b.writeUInt32BE(0, 12); // earliest_presentation_time
  b.writeUInt32BE(gap, 16); // first_offset
  b.writeUInt16BE(refs.length, 22);
  refs.forEach(([size, ms], i) => {
    b.writeUInt32BE(size, 24 + i * 12);
    b.writeUInt32BE(ms, 28 + i * 12);
    b.writeUInt32BE(0x90000000, 32 + i * 12);
  });
  return box("sidx", b);
}

describe("fMP4 dizini", () => {
  const head = Buffer.concat([box("ftyp", Buffer.alloc(12)), box("moov", Buffer.alloc(100))]);

  it("init aralığını ve parçaları sidx'ten çıkarır", () => {
    const s = sidx([[500, 5000], [700, 4800]]);
    const idx = parseIndex(Buffer.concat([head, s, box("moof", Buffer.alloc(8))]));
    expect(idx).toEqual({
      init: [0, head.length],
      segments: [
        { offset: head.length + s.length, size: 500, duration: 5 },
        { offset: head.length + s.length + 500, size: 700, duration: 4.8 },
      ],
    });
  });

  it("sidx yarım okunduysa gereken bayt sayısını ister", () => {
    const full = Buffer.concat([head, sidx([[1, 1], [2, 2], [3, 3]])]);
    expect(parseIndex(full.subarray(0, full.length - 5))).toEqual({ need: full.length });
  });

  it("dizinsiz dosyada null", () => {
    expect(parseIndex(Buffer.concat([head, box("moof", Buffer.alloc(8))]))).toBeNull();
  });
});

const yt: YtInfo = {
  title: "Film",
  formats: [
    { format_id: "18", url: "https://g/18", protocol: "https", ext: "mp4", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360 },
    { format_id: "140", url: "https://g/140", protocol: "https", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 129 },
    { format_id: "140-drc", url: "https://g/140d", protocol: "https", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 129 },
    { format_id: "251", url: "https://g/251", protocol: "https", ext: "webm", vcodec: "none", acodec: "opus", abr: 130 },
    { format_id: "137", url: "https://g/137", protocol: "https", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, tbr: 3000 },
    { format_id: "136", url: "https://g/136", protocol: "https", ext: "mp4", vcodec: "avc1.4D401F", acodec: "none", height: 720, tbr: 1000 },
    { format_id: "248", url: "https://g/248", protocol: "https", ext: "webm", vcodec: "vp9", acodec: "none", height: 1080, tbr: 1100 },
    { format_id: "401", url: "https://g/401", protocol: "https", ext: "mp4", vcodec: "av01.0.12M.08", acodec: "none", height: 2160, tbr: 9000 },
  ],
};

describe("format seçimi", () => {
  it("YouTube: H.264 görüntüler (yüksekten alçağa) ve drc olmayan AAC ses", () => {
    const d = pickDash(yt)!;
    expect(d.video.map((f) => f.format_id)).toEqual(["137", "136"]);
    expect(d.audio.format_id).toBe("140");
    expect(pickMuxed(yt)?.format_id).toBe("18");
    expect(pickHls(yt)).toBeNull();
  });

  it("canlı: sitenin ana listesi", () => {
    const live: YtInfo = { is_live: true, formats: [{ format_id: "720p", url: "https://k/720.m3u8", manifest_url: "https://k/master.m3u8", protocol: "m3u8_native", height: 720 }] };
    expect(pickHls(live)).toBe("https://k/master.m3u8");
  });

  it("sayfa linkleri", () => {
    expect(pageUrl({ kind: "kick", channel: "gogo" })).toBe("https://kick.com/gogo");
    expect(pageUrl({ kind: "youtube", id: "dQw4w9WgXcQ", start: 0 })).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(pageUrl({ kind: "file", url: "https://x/a.mp4", hls: false })).toBeNull();
  });
});

describe("HLS listeleri", () => {
  const track = (url: string, codecs: string, height?: number): Track => ({
    url,
    codecs,
    bandwidth: 1000,
    width: height ? (height * 16) / 9 : undefined,
    height,
    init: [0, 742],
    segments: [{ offset: 1230, size: 500, duration: 5.24 }, { offset: 1730, size: 400, duration: 4.1 }],
  });

  it("ana liste ses grubunu ve varyantları içerir", () => {
    const m = masterPlaylist([track("https://g/137", "avc1.640028", 1080)], track("https://g/140", "mp4a.40.2"));
    expect(m).toContain(`URI="relay-a.m3u8"`);
    expect(m).toContain(`RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="a"\nrelay-v0.m3u8`);
  });

  it("medya listesi bayt aralıklı ve kapalı (VOD)", () => {
    const m = mediaPlaylist(track("https://g/137", "avc1.640028", 1080), (u) => `p?u=${encodeURIComponent(u)}`);
    expect(m).toContain(`#EXT-X-MAP:URI="p?u=https%3A%2F%2Fg%2F137",BYTERANGE="742@0"`);
    expect(m).toContain("#EXTINF:5.240,\n#EXT-X-BYTERANGE:500@1230\np?u=https%3A%2F%2Fg%2F137");
    expect(m).toContain("#EXT-X-TARGETDURATION:6");
    expect(m.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });
});

describe("Relays", () => {
  it("canlı yayını HLS olarak hazırlar, aynı anda gelen istekleri birleştirir", async () => {
    let calls = 0;
    const relays = new Relays(async () => {
      calls++;
      return { title: "Yayın", is_live: true, formats: [{ protocol: "m3u8_native", manifest_url: "https://k/master.m3u8", url: "https://k/720.m3u8" }] };
    });
    const src = { kind: "kick" as const, channel: "gogo" };
    const [a, b] = await Promise.all([relays.prepare(src), relays.prepare(src)]);
    expect(a?.plan).toEqual({ kind: "hls", url: "https://k/master.m3u8", live: true });
    expect(b).toBe(a);
    expect(calls).toBe(1);
    expect(await relays.get(src)).toBe(a);
  });

  it("yt-dlp çözemezse null", async () => {
    expect(await new Relays(async () => null).prepare({ kind: "kick", channel: "yok" })).toBeNull();
  });
});

describe("resolveMedia + aktarma", () => {
  it("aktarılan Kick işaretlenir, başlığa yayın adı eklenir", async () => {
    const m = await resolveMedia("https://kick.com/gogo", async () => ({ hls: true, live: true, title: "Sohbet" }));
    expect(m && "source" in m && m.source).toEqual({ kind: "kick", channel: "gogo", relay: { hls: true, live: true } });
    expect(m && "title" in m && m.title).toBe("Kick · gogo (canlı) · Sohbet");
  });

  it("aktarılamazsa kaynak eskisi gibi (gömülü oynatıcı)", async () => {
    const m = await resolveMedia("https://kick.com/gogo", async () => null);
    expect(m && "source" in m && m.source).toEqual({ kind: "kick", channel: "gogo" });
  });
});
