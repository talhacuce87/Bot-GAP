import { describe, expect, it } from "vitest";
import { parseRadioUrl } from "../shared/car";
import type { ServerEvent } from "../shared/protocol";
import { firstVideoId, resolveRadio, spotifyTitle, type RadioFetch } from "../server/src/radio";
import { type Conn, Room } from "../server/src/room";
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

  it("radyo yalnızca arabadayken çalar ve arabadan inince susar", () => {
    const room = new Room("g:test");
    const a = new FakeConn(), b = new FakeConn();
    const sa = room.join({ id: "a", name: "a", avatar: null, guest: true }, a, 0);
    room.join({ id: "b", name: "b", avatar: null, guest: true }, b, 0);
    const song = { id: "AAAAAAAAAAA", title: "x", at: 1 };
    room.setRadio(sa, song);
    expect(room.players.get(sa)!.info.radio).toBeUndefined();
    room.setCar(sa, validCar({}));
    room.setRadio(sa, song);
    expect(b.text.some((e) => e.t === "radio" && e.sid === sa && e.radio?.id === song.id)).toBe(true);
    room.setCar(sa, null);
    expect(room.players.get(sa)!.info.radio).toBeNull();
    expect(b.text.at(-1)).toEqual({ t: "radio", sid: sa, radio: null });
  });
});
