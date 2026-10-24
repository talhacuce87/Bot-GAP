// Radyo sırası (Spotify gibi): oyuncu başına şarkı sırası. Link ekledikçe sıranın sonuna eklenir (çalma
// listesi bütün şarkılarıyla); sonraki/önceki, karıştır, tekrar (kapalı / liste / şarkı), sıradan şarkı seç ya
// da sil. Şarkı bitince (sahibinin oynatıcısı bildirir) sıradaki çalar. Çalan şarkı odaya radyo olarak gider
// (herkes aynı andan dinler); sıra yalnızca sahibine. Kontrol arabadayken; arabadan inince de çalmaya devam eder.
import { RADIO_QUEUE_MAX, type RadioQueueView } from "../../shared/car";
import type { ServerEvent } from "../../shared/protocol";
import { type RadioItem, resolveRadioList, searchVideo } from "./radio";

/** Sıranın odadan istedikleri (test için arayüz). */
export interface RadioRoom {
  players: { get(sid: number): { info: { car?: unknown; radio?: { id: string; at: number } | null }; conn: unknown } | undefined };
  setRadio(sid: number, radio: { id: string; title: string; at: number } | null): void;
  sendTo(conn: never, ev: ServerEvent): void;
}

interface Queue {
  items: RadioItem[];
  index: number;
  playing: boolean;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  /** Başlatılan şarkının sırası (arama bitmeden yenisi gelirse eskisi çalmasın). */
  gen: number;
}

export type RadioOp = "next" | "prev" | "shuffle" | "repeat" | "jump" | "remove" | "clear" | "stop" | "play" | "ended";

export class RadioQueues {
  private queues = new Map<number, Queue>();

  constructor(
    private room: RadioRoom,
    private resolve: typeof resolveRadioList = resolveRadioList,
    private search: typeof searchVideo = searchVideo,
    private rng: () => number = Math.random,
  ) {}

  private q(sid: number): Queue {
    let q = this.queues.get(sid);
    if (!q) this.queues.set(sid, (q = { items: [], index: -1, playing: false, shuffle: false, repeat: "off", gen: 0 }));
    return q;
  }

  /** Link ekle (tek şarkı ya da liste). Hata metni döner. */
  async add(sid: number, url: string): Promise<string | null> {
    const r = await this.resolve(url.slice(0, 300));
    if ("error" in r) return r.error;
    if (!this.room.players.get(sid)) return null;
    const q = this.q(sid);
    const room = RADIO_QUEUE_MAX - q.items.length;
    if (room <= 0) return `📻 Sırada en çok ${RADIO_QUEUE_MAX} şarkı olabilir.`;
    const first = q.items.length;
    const add = r.slice(0, room);
    q.items.push(...(q.shuffle ? this.shuffled(add) : add));
    // Çalan yoksa eklenen ilk şarkıdan başla
    if (!q.playing) {
      q.index = first;
      await this.start(sid);
    } else this.send(sid);
    return r.length > 1 ? `📻 ${add.length} şarkı sıraya eklendi.` : null;
  }

  /** Sıra işlemi. `i`: sıradaki yer (jump, remove), `id`: biten şarkı (ended). */
  async op(sid: number, op: RadioOp, i?: number, id?: string): Promise<void> {
    const p = this.room.players.get(sid);
    const q = this.queues.get(sid);
    if (!p || !q) return;
    const cur = p.info.radio;
    switch (op) {
      case "ended":
        // Çalan şarkı bittiyse (aynı bildirim iki kez gelmesin)
        if (!q.playing || !cur || cur.id !== id) return;
        if (q.repeat === "one") return this.start(sid);
        return this.step(sid, 1);
      case "next":
        return this.step(sid, 1);
      case "prev":
        // Şarkının başındaysa öncekine, ilerlediyse başa sar
        if (cur && Date.now() - cur.at > 3000) return this.start(sid);
        return this.step(sid, -1);
      case "jump":
        if (!Number.isInteger(i) || i! < 0 || i! >= q.items.length) return;
        q.index = i!;
        return this.start(sid);
      case "remove": {
        if (!Number.isInteger(i) || i! < 0 || i! >= q.items.length) return;
        q.items.splice(i!, 1);
        if (i! < q.index) q.index--;
        else if (i === q.index) {
          if (q.index >= q.items.length) q.index = q.items.length ? 0 : -1;
          if (q.playing && q.index >= 0) return this.start(sid);
          if (q.index < 0) return this.stop(sid);
        }
        return this.send(sid);
      }
      case "clear":
        q.items = [];
        q.index = -1;
        return this.stop(sid);
      case "stop":
        return this.stop(sid);
      case "play":
        if (q.playing || !q.items.length) return;
        q.index = Math.max(0, Math.min(q.index, q.items.length - 1));
        return this.start(sid);
      case "shuffle":
        q.shuffle = !q.shuffle;
        // Karıştırınca çalandan sonrakiler karışır (Spotify gibi)
        if (q.shuffle && q.index + 1 < q.items.length) q.items.splice(q.index + 1, Infinity, ...this.shuffled(q.items.slice(q.index + 1)));
        return this.send(sid);
      case "repeat":
        q.repeat = q.repeat === "off" ? "all" : q.repeat === "all" ? "one" : "off";
        return this.send(sid);
    }
  }

  /** Oyuncu ayrıldı. */
  leave(sid: number): void {
    this.queues.delete(sid);
  }

  view(sid: number): RadioQueueView {
    const q = this.q(sid);
    return { items: q.items.map((x) => ({ title: x.title })), index: q.index, playing: q.playing, shuffle: q.shuffle, repeat: q.repeat };
  }

  private shuffled<T>(list: T[]): T[] {
    const a = [...list];
    for (let k = a.length - 1; k > 0; k--) {
      const j = Math.floor(this.rng() * (k + 1));
      [a[k], a[j]] = [a[j], a[k]];
    }
    return a;
  }

  /** Sıradaki ya da önceki şarkı; listenin sonunda tekrar açıksa başa döner, değilse durur. */
  private async step(sid: number, dir: 1 | -1): Promise<void> {
    const q = this.q(sid);
    let next = q.index + dir;
    if (next >= q.items.length) {
      if (q.repeat !== "all") return this.stop(sid);
      next = 0;
    }
    if (next < 0) next = q.repeat === "all" ? q.items.length - 1 : 0;
    q.index = next;
    return this.start(sid);
  }

  /** Sıradaki yerdeki şarkıyı çal (adı aranacaksa önce YouTube'da bulunur; bulunamazsa geçilir). */
  private async start(sid: number, tries = 0): Promise<void> {
    const q = this.q(sid);
    const item = q.items[q.index];
    if (!item) return this.stop(sid);
    const gen = ++q.gen;
    q.playing = true;
    this.send(sid);
    if (!item.id && item.q) item.id = (await this.search(item.q)) ?? undefined;
    if (gen !== q.gen || !this.room.players.get(sid)) return;
    if (!item.id) {
      if (tries > 5 || q.index + 1 >= q.items.length) return this.stop(sid);
      q.index++;
      return this.start(sid, tries + 1);
    }
    this.room.setRadio(sid, { id: item.id, title: item.title, at: Date.now() });
  }

  private stop(sid: number): void {
    const q = this.q(sid);
    q.playing = false;
    q.gen++;
    this.room.setRadio(sid, null);
    this.send(sid);
  }

  private send(sid: number): void {
    const p = this.room.players.get(sid);
    if (p) this.room.sendTo(p.conn as never, { t: "radioq", q: this.view(sid) });
  }
}
