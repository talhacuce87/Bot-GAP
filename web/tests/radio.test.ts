import { describe, expect, it } from "vitest";
import { parseRadioUrl } from "../shared/car";
import type { ServerEvent } from "../shared/protocol";
import { firstVideoId, parseListUrl, resolveRadio, spotifyTitle, spotifyTracks, type RadioFetch } from "../server/src/radio";
import { type Conn, Room } from "../server/src/room";
import { RadioQueues } from "../server/src/radioQueue";
import { radioGain } from "../client/src/radio";
import { validCar } from "../shared/car";

class FakeConn implements Conn {
  bufferedAmount = 0;
  text: ServerEvent[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.text.push(JSON.parse(data));
  }
}

/** Adrese göre sahte cevap. */
const fake = (pages: Record<string, string>): RadioFetch => async (url) => {
  const key = Object.keys(pages).find((k) => url.includes(k));
  return { ok: !!key, text: async () => (key ? pages[key] : "") };
};

describe("araba radyosu", () => {
  it("YouTube ve Spotify şarkı linklerini tanır, diğerlerini reddeder", () => {
    expect(parseRadioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10")).toEqual({ kind: "youtube", id: "dQw4w9WgXcQ" });
    expect(parseRadioUrl("https://youtu.be/dQw4w9WgXcQ")).toEqual({ kind: "youtube", id: "dQw4w9WgXcQ" });
    expect(parseRadioUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ kind: "youtube", id: "dQw4w9WgXcQ" });
    expect(parseRadioUrl("https://open.spotify.com/intl-tr/track/4cOdK2wGLETKBW3PvgPWqT?si=x")).toEqual({ kind: "spotify", id: "4cOdK2wGLETKBW3PvgPWqT" });
    expect(parseRadioUrl("spotify:track:4cOdK2wGLETKBW3PvgPWqT")).toEqual({ kind: "spotify", id: "4cOdK2wGLETKBW3PvgPWqT" });
    expect(parseRadioUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")).toBeNull();
    expect(parseRadioUrl("javascript:alert(1)")).toBeNull();
  });

  it("Spotify şarkısını sanatçı ve adla YouTube'da bulur; YouTube başlığını oEmbed'den alır", async () => {
    expect(spotifyTitle("<title>Gülpembe - song and lyrics by Barış Manço | Spotify</title>")).toBe("Barış Manço - Gülpembe");
    expect(firstVideoId('xx "videoId":"abcdefghijk" yy "videoId":"zzzzzzzzzzz"')).toBe("abcdefghijk");
    const spotify = await resolveRadio("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", fake({
      "open.spotify.com/oembed": JSON.stringify({ title: "Gülpembe" }),
      "open.spotify.com/embed": '{"name":"Gülpembe","artists":[{"name":"Barış Manço","uri":"x"}]}',
      "youtube.com/results": '"videoId":"AAAAAAAAAAA"',
    }));
    expect(spotify).toEqual({ id: "AAAAAAAAAAA", title: "Barış Manço - Gülpembe" });
    const yt = await resolveRadio("https://youtu.be/BBBBBBBBBBB", fake({ oembed: JSON.stringify({ title: "Şarkı" }) }));
    expect(yt).toEqual({ id: "BBBBBBBBBBB", title: "Şarkı" });
    expect("error" in (await resolveRadio("https://example.com/x", fake({})))).toBe(true);
  });

  it("ses yakında tam, menzilin sonunda sıfır; kendi arabanda hep tam", () => {
    expect(radioGain(2, false)).toBe(1);
    expect(radioGain(30, false)).toBeGreaterThan(radioGain(45, false));
    expect(radioGain(60, false)).toBe(0);
    expect(radioGain(500, true)).toBe(1);
  });

  it("radyo arabadan inince de çalar (kontrol arabada)", () => {
    const room = new Room("g:test");
    const a = new FakeConn(), b = new FakeConn();
    const sa = room.join({ id: "a", name: "a", avatar: null, guest: true }, a, 0);
    room.join({ id: "b", name: "b", avatar: null, guest: true }, b, 0);
    const song = { id: "AAAAAAAAAAA", title: "x", at: 1 };
    room.setCar(sa, validCar({}));
    room.setRadio(sa, song);
    expect(b.text.some((e) => e.t === "radio" && e.sid === sa && e.radio?.id === song.id)).toBe(true);
    room.setCar(sa, null);
    expect(room.players.get(sa)!.info.radio).toEqual(song);
  });
});

describe("radyo sırası", () => {
  function setup() {
    const room = new Room("g:test");
    const a = new FakeConn();
    const sid = room.join({ id: "a", name: "a", avatar: null, guest: true }, a, 0);
    room.setCar(sid, validCar({}));
    // Link: "liste" üç şarkı, diğerleri tek şarkı (kimliği linkin kendisi)
    const resolve = async (url: string) =>
      url === "liste"
        ? [{ title: "A - 1", q: "A - 1 audio" }, { title: "B - 2", q: "B - 2 audio" }, { title: "C - 3", q: "C - 3 audio" }]
        : [{ id: url.padEnd(11, "x").slice(0, 11), title: url }];
    const q = new RadioQueues(room, resolve, async (s) => s.slice(0, 1).repeat(11), () => 0);
    const cur = () => room.players.get(sid)!.info.radio;
    return { room, q, sid, cur, a };
  }

  it("eklenen link sıraya girer; çalan yoksa çalar, bitince sıradaki", async () => {
    const { q, sid, cur } = setup();
    await q.add(sid, "bir");
    expect(cur()?.title).toBe("bir");
    await q.add(sid, "iki");
    expect(cur()?.title).toBe("bir");
    expect(q.view(sid).items.map((x) => x.title)).toEqual(["bir", "iki"]);
    await q.op(sid, "ended", undefined, cur()!.id);
    expect(cur()?.title).toBe("iki");
    // Sıranın sonu, tekrar kapalı: durur
    await q.op(sid, "ended", undefined, cur()!.id);
    expect(cur()).toBeNull();
    expect(q.view(sid).playing).toBe(false);
  });

  it("çalma listesi bütün şarkılarıyla eklenir; sonraki, önceki, tekrar", async () => {
    const { q, sid, cur } = setup();
    expect(await q.add(sid, "liste")).toContain("3 şarkı");
    expect(cur()?.title).toBe("A - 1");
    await q.op(sid, "next");
    expect(cur()?.title).toBe("B - 2");
    await q.op(sid, "prev");
    expect(cur()?.title).toBe("A - 1");
    await q.op(sid, "repeat"); // liste
    await q.op(sid, "jump", 2);
    await q.op(sid, "ended", undefined, cur()!.id);
    expect(cur()?.title).toBe("A - 1");
    await q.op(sid, "repeat"); // şarkı
    await q.op(sid, "ended", undefined, cur()!.id);
    expect(cur()?.title).toBe("A - 1");
  });

  it("karıştırınca çalandan sonrakiler karışır; silinen çıkar", async () => {
    const { q, sid } = setup();
    await q.add(sid, "liste");
    await q.op(sid, "shuffle");
    const v = q.view(sid);
    expect(v.shuffle).toBe(true);
    expect(v.items[0].title).toBe("A - 1");
    expect(v.items.map((x) => x.title).sort()).toEqual(["A - 1", "B - 2", "C - 3"]);
    await q.op(sid, "remove", 1);
    expect(q.view(sid).items.length).toBe(2);
  });

  it("liste linkleri ve Spotify gömme sayfası", () => {
    expect(parseListUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1")).toEqual({ kind: "spotify", type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    expect(parseListUrl("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG")).toEqual({ kind: "youtube", id: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG" });
    expect(parseListUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1")).toBeNull();
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { trackList: [{ title: "Şarkı", subtitle: "Sanatçı" }] } } } } } })}</script>`;
    expect(spotifyTracks(html)).toEqual([{ title: "Sanatçı - Şarkı", q: "Sanatçı - Şarkı audio" }]);
  });
});

describe("yolcu ve farlar", () => {
  it("sürücünün yanındaki yolcu biner, konumu arabayla gider; sürücü inince yolcu da iner", () => {
    const room = new Room("g:test");
    const sa = room.join({ id: "a", name: "a", avatar: null, guest: true }, new FakeConn(), 0);
    const sb = room.join({ id: "b", name: "b", avatar: null, guest: true }, new FakeConn(), 0);
    expect(room.ride(sb, sa)).not.toBeNull(); // sürücü arabada değil
    room.setCar(sa, validCar({}));
    expect(room.ride(sb, sa)).toBeNull();
    expect(room.players.get(sb)!.info.ride).toEqual({ d: sa, s: 1 });
    room.players.get(sa)!.state.x = 5;
    room.applyState(sb, { x: -50, z: 0, rot: 0, flags: 0 }, 1000);
    expect(room.players.get(sb)!.state.x).toBe(5);
    room.setLights(sa, false);
    expect(room.players.get(sa)!.info.lights).toBe(false);
    room.setCar(sa, null);
    expect(room.players.get(sb)!.info.ride).toBeNull();
  });
});
