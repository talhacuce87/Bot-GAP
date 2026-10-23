import { describe, expect, it } from "vitest";
import type { WatchState } from "../shared/protocol";
import type { MediaPlayer } from "../client/src/watch/players";
import { WatchSync } from "../client/src/watch/sync";
import { Stage } from "../server/src/games/stage";
import { Room } from "../server/src/room";

/** Saati elle ilerleyen sahte oynatıcı: tamponlamayı (`lag`) taklit edebilir. */
class FakePlayer implements MediaPlayer {
  readonly controllable = true;
  t = 0;
  playing = true;
  done = false;
  seeks: number[] = [];
  plays = 0;
  rate = 1;
  dur = 100;
  onError = () => {};
  play() {
    this.plays++;
    this.playing = true;
  }
  pause() {
    this.playing = false;
  }
  seek(t: number) {
    this.seeks.push(t);
    this.t = t;
  }
  time() {
    return this.t;
  }
  duration() {
    return this.dur;
  }
  isPlaying() {
    return this.playing && !this.done;
  }
  ended() {
    return this.done;
  }
  setVolume() {}
  setMuted() {}
  setRate(r: number) {
    this.rate = r;
  }
  destroy() {}
}

function setup(kind: "youtube" | "file", position = 0) {
  let now = 0;
  const sync = new WatchSync({} as never, () => now);
  const p = new FakePlayer();
  const source = kind === "youtube" ? { kind, id: "abcdefghijk", start: 0 } : { kind, url: "https://x/a.mp4", hls: false };
  sync.player = p;
  sync.state = { source, title: "x", playing: true, position, updatedAt: 0, by: "a", op: "load" } as WatchState;
  /** `sec` saniye ilerlet; oynatıcı `speed` hızında akar (tamponlarken 0). */
  const run = (sec: number, speed = 1) => {
    for (let i = 0; i < sec * 20; i++) {
      now += 50;
      if (p.isPlaying()) p.t += 0.05 * speed * p.rate;
      sync.update(0.05);
    }
  };
  return { sync, p, run };
}

describe("watch party senkronu", () => {
  it("bitmiş videoyu yeniden oynatmaz (baştan başlayıp sona sarılma döngüsü yok)", () => {
    const { p, run } = setup("youtube", 99.8);
    p.t = 100;
    p.done = true;
    run(3);
    expect(p.plays).toBe(0);
  });

  it("yavaş bağlantıda her sarıştan sonra eşik büyür: sar-takıl döngüsü seyrekleşir", () => {
    const { p, run } = setup("youtube");
    // Yarı hızda akabilen (sürekli tamponlayan) oynatıcı: 60 sn'de eşik sabit kalsaydı ~20 kez sarardı
    run(60, 0.5);
    expect(p.seeks.length).toBeGreaterThan(0);
    expect(p.seeks.length).toBeLessThan(12);
  });

  it("dosyada küçük sapma sarılmaz, oynatma hızıyla kapatılır", () => {
    const { p, run } = setup("file");
    p.t = -1; // 1 sn geride
    run(1);
    expect(p.seeks).toEqual([]);
    expect(p.rate).toBeGreaterThan(1);
    run(30);
    expect(Math.abs(p.t - 31)).toBeLessThan(0.3);
  });
});

describe("sinema kuyruğu", () => {
  it("kuyruk boşken biten videodan sonra !izle ile yeni video açıldıysa eklenen sıraya girer, perdedekini ezmez", async () => {
    let loadedAt = 1000;
    const played: string[] = [];
    const stage = new Stage(new Room("k"), {
      play: async (url) => {
        played.push(url);
        return { title: url };
      },
      title: async (url) => url,
      loadedAt: () => loadedAt,
    }, () => {});
    stage.ended(1000 + 60_000); // video bitti, kuyruk boş
    loadedAt = 70_000; // biri !izle ile yeni video açtı
    expect(await stage.enqueue("b", "x")).toContain("Sıraya eklendi");
    expect(played).toEqual([]);
    // Bu da bitince sıradaki çalar; ondan sonra kuyruk boşsa eklenen hemen çalar
    stage.ended(70_000 + 60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(played).toEqual(["b"]);
  });
});
