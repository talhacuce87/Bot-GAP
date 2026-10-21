// Sinema sahnesi: şarkı/video kuyruğu (!sıra), DJ kabini (ışık şovu, geç) ve karaoke için sahneye çıkan.
// Perdedeki video bitince izleyenlerden biri "wended" yollar; kuyrukta sıradaki varsa o yüklenir.
import type { StageState } from "../../../shared/protocol";
import { DJ_BOOTH, STAGE_STEPS } from "../../../shared/zones";
import type { Conn, Room } from "../room";

const QUEUE_MAX = 20;
/** Yeni yüklenen video bu süreden önce "bitti" sayılmaz (başka istemcinin eski bildirimi). */
const MIN_PLAY_MS = 15_000;
const SHOWS = 4;

export interface StageHost {
  /** Videoyu perdeye yükler; başlık ya da hata. */
  play(url: string, by: string): Promise<{ title: string } | { error: string }>;
  /** Linkin başlığı (kuyruğa eklerken); açılamıyorsa null. */
  title(url: string): Promise<string | null>;
  /** Şu anki video ne zaman yüklendi (yoksa 0). */
  loadedAt(): number;
}

export class Stage {
  dj = 0;
  show = 0;
  singer = 0;
  private queue: { url: string; title: string; by: string }[] = [];
  /** Son video bitti, kuyruk da boştu: yeni eklenen hemen çalar. */
  private idle = false;

  constructor(
    private room: Room,
    private host: StageHost,
    private report: (sid: number, event: string) => void,
  ) {}

  private view(): StageState {
    return { dj: this.dj, show: this.show, singer: this.singer, queue: this.queue.map(({ title, by }) => ({ title, by })) };
  }

  private publish(): void {
    this.room.broadcast({ t: "stage", ...this.view() });
  }

  sendTo(conn: Conn): void {
    this.room.sendTo(conn, { t: "stage", ...this.view() });
  }

  private near(sid: number, spot: { x: number; z: number; r: number }): boolean {
    const p = this.room.players.get(sid);
    return !!p && !p.info.spectator && !p.info.jailed && Math.hypot(p.state.x - spot.x, p.state.z - spot.z) <= spot.r + 1;
  }

  /** Kuyruğa ekler; perde boşsa hemen çalar. Cevap metni (yalnızca ekleyene). */
  async enqueue(url: string, by: string): Promise<string> {
    if (this.queue.length >= QUEUE_MAX) return "🎵 Kuyruk dolu (20 şarkı).";
    if (!this.host.loadedAt() || this.idle) {
      this.idle = false;
      const r = await this.host.play(url, by);
      return "error" in r ? `🎵 ${r.error}` : `🎵 Çalıyor: ${r.title}`;
    }
    const title = await this.host.title(url);
    if (!title) return "🎵 Bu link açılamıyor. YouTube, Twitch, Kick ya da .mp4/.m3u8 linki dene.";
    this.queue.push({ url, title, by });
    this.publish();
    return `🎵 Sıraya eklendi (#${this.queue.length}): ${title}`;
  }

  /** Sıradakini çalar (kuyruk boşsa bir şey yapmaz). */
  async next(): Promise<void> {
    const item = this.queue.shift();
    if (!item) return;
    this.publish();
    const r = await this.host.play(item.url, item.by);
    if ("error" in r) await this.next();
  }

  /** Perdedeki video bitti (izleyenden). */
  ended(now = Date.now()): void {
    const at = this.host.loadedAt();
    if (!at || now - at < MIN_PLAY_MS) return;
    if (!this.queue.length) this.idle = true;
    else void this.next();
  }

  listText(): string {
    if (!this.queue.length) return "🎵 Kuyruk boş. !sıra <link> ile şarkı ekle.";
    return "🎵 Sırada: " + this.queue.slice(0, 8).map((q, i) => `${i + 1}. ${q.title} (${q.by})`).join(" · ");
  }

  djCommand(sid: number, op: string, show?: number): void {
    if (op === "take") {
      if ((this.dj && this.room.players.has(this.dj) && this.dj !== sid) || !this.near(sid, DJ_BOOTH)) return;
      this.dj = sid;
      this.show = this.show || 1;
      this.report(sid, "stage");
    } else if (op === "leave") {
      if (this.dj !== sid) return;
      this.dj = 0;
      this.show = 0;
    } else if (op === "show") {
      if (this.dj !== sid || !Number.isInteger(show) || show! < 0 || show! >= SHOWS) return;
      this.show = show!;
    } else if (op === "skip") {
      // DJ varken yalnızca DJ geçer
      if (this.dj && this.dj !== sid) return;
      void this.next();
      return;
    } else return;
    this.publish();
  }

  setSinger(sid: number, on: boolean): void {
    if (on) {
      if ((this.singer && this.room.players.has(this.singer) && this.singer !== sid) || !this.near(sid, STAGE_STEPS)) return;
      this.singer = sid;
      this.report(sid, "stage");
    } else if (this.singer === sid) this.singer = 0;
    else return;
    this.publish();
  }

  leave(sid: number): void {
    let changed = false;
    if (this.dj === sid) {
      this.dj = 0;
      this.show = 0;
      changed = true;
    }
    if (this.singer === sid) {
      this.singer = 0;
      changed = true;
    }
    if (changed) this.publish();
  }
}
