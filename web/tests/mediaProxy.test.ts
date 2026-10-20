import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { type Fetcher, isPrivateIp, isPublicUrl, MediaProxy, proxyRef, rewritePlaylist } from "../server/src/mediaProxy";

/** writeHead/end'i kaydeden sahte yanıt. */
function fakeRes() {
  const r = {
    status: 0,
    headers: {} as Record<string, unknown>,
    body: Buffer.alloc(0),
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      r.status = status;
      r.headers = headers ?? {};
      r.headersSent = true;
      return r;
    },
    end(chunk?: Buffer) {
      if (chunk) r.body = Buffer.concat([r.body, chunk]);
      return r;
    },
    on() {
      return r;
    },
  };
  return r;
}
const res = (r: ReturnType<typeof fakeRes>) => r as unknown as ServerResponse;

const publicDns = async (host: string) => (host === "intranet.local" ? ["10.0.0.5"] : ["93.184.216.34"]);

describe("adres güvenliği", () => {
  it("özel ve iç ağ adreslerini tanır", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.2", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2a00:1450:4017::200e"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("yalnızca herkese açık http(s) adreslerine izin verir", async () => {
    expect(await isPublicUrl(new URL("https://tv-trt1.medya.trt.com.tr/master.m3u8"), publicDns)).toBe(true);
    expect(await isPublicUrl(new URL("http://intranet.local/a.mp4"), publicDns)).toBe(false);
    expect(await isPublicUrl(new URL("http://127.0.0.1:8081/internal/fish"), publicDns)).toBe(false);
    expect(await isPublicUrl(new URL("http://[::1]/x"), publicDns)).toBe(false);
    expect(await isPublicUrl(new URL("ftp://example.com/a.mp4"), publicDns)).toBe(false);
    expect(await isPublicUrl(new URL("https://user:pw@example.com/a.mp4"), publicDns)).toBe(false);
  });
});

describe("çalma listesi", () => {
  it("medya satırlarını ve URI özniteliklerini aktarma adresine çevirir", () => {
    const origins: string[] = [];
    const out = rewritePlaylist(
      "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:6,\nseg1.ts\nhttps://cdn.example/seg2.ts\n",
      new URL("https://tv.example/live/master.m3u8"),
      proxyRef,
      (o) => origins.push(o),
    );
    expect(out).toContain(`URI="p?u=${encodeURIComponent("https://tv.example/live/key.bin")}"`);
    expect(out).toContain(`p?u=${encodeURIComponent("https://tv.example/live/seg1.ts")}`);
    expect(out).toContain(`p?u=${encodeURIComponent("https://cdn.example/seg2.ts")}`);
    expect(out.startsWith("#EXTM3U\n")).toBe(true);
    expect(origins).toContain("https://cdn.example");
  });
});

describe("MediaProxy", () => {
  const files: Record<string, { status?: number; type: string; body: string; location?: string }> = {
    "https://tv.example/live/master.m3u8": { type: "application/vnd.apple.mpegurl", body: "#EXTM3U\n#EXTINF:6,\nhttps://cdn.example/seg1.ts\n" },
    "https://cdn.example/seg1.ts": { type: "video/mp2t", body: "SEGMENT-1" },
    "https://tv.example/live/jump.ts": { status: 302, type: "text/plain", body: "", location: "http://intranet.local/secret" },
  };
  const make = () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url.toString());
      const f = files[url.toString()];
      if (!f) return new Response("yok", { status: 404 });
      const headers = new Headers({ "content-type": f.type, "content-length": String(f.body.length) });
      if (f.location) headers.set("location", f.location);
      return new Response(f.status && f.status >= 300 && f.status < 400 ? null : f.body, { status: f.status ?? 200, headers });
    };
    const proxy = new MediaProxy(fetcher, publicDns);
    proxy.allow("w1", "https://tv.example/live/master.m3u8");
    return { proxy, calls };
  };

  it("izinsiz origin'e 403, bilinmeyen sinemaya 403", async () => {
    const { proxy, calls } = make();
    const a = fakeRes();
    await proxy.handle(res(a), "w1", "https://evil.example/x.ts", undefined);
    expect(a.status).toBe(403);
    const b = fakeRes();
    await proxy.handle(res(b), "yok", "https://tv.example/live/master.m3u8", undefined);
    expect(b.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("çalma listesini yeniden yazar, CDN'e izin verir, parçayı bir kez çekip önbellekten dağıtır", async () => {
    const { proxy, calls } = make();
    const list = fakeRes();
    await proxy.handle(res(list), "w1", "https://tv.example/live/master.m3u8", undefined);
    expect(list.status).toBe(200);
    expect(list.body.toString()).toContain(proxyRef("https://cdn.example/seg1.ts"));

    for (let i = 0; i < 3; i++) {
      const seg = fakeRes();
      await proxy.handle(res(seg), "w1", "https://cdn.example/seg1.ts", undefined);
      expect(seg.status).toBe(200);
      expect(seg.body.toString()).toBe("SEGMENT-1");
    }
    expect(calls.filter((c) => c.endsWith("seg1.ts"))).toHaveLength(1);
    const s = proxy.stats();
    expect(s.hits).toBe(2);
    expect(s.bytes).toBeGreaterThan(9 * 3);
  });

  it("iç ağa yönlendirmeyi takip etmez", async () => {
    const { proxy, calls } = make();
    const r = fakeRes();
    await proxy.handle(res(r), "w1", "https://tv.example/live/jump.ts", undefined);
    expect(r.status).toBe(502);
    expect(calls).not.toContain("http://intranet.local/secret");
  });

  it("kaynak değişince eski origin'lerin izni düşer, oynat/duraklatta korunur", async () => {
    const { proxy } = make();
    await proxy.handle(res(fakeRes()), "w1", "https://tv.example/live/master.m3u8", undefined); // cdn izinli olur
    proxy.allow("w1", "https://tv.example/live/master.m3u8"); // aynı kaynak: korunur
    const same = fakeRes();
    await proxy.handle(res(same), "w1", "https://cdn.example/seg1.ts", undefined);
    expect(same.status).toBe(200);
    proxy.allow("w1", "https://other.example/film.mp4");
    const after = fakeRes();
    await proxy.handle(res(after), "w1", "https://cdn.example/seg1.ts", undefined);
    expect(after.status).toBe(403);
  });
});
