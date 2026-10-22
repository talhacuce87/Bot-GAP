// Odanın yarış yöneticisi: oturumu (shared/race) oyunculara bağlar. Grid'e geçme, başlatma ve ayrılma
// istekleri; konumlardan tur sayımı; faz değişince ve yarışta saniyede iki kez durum yayını; bitince ödüller.
import { type RingView, RingSession } from "../../shared/ring";
import type { ServerEvent } from "../../shared/protocol";

/** Yarış yöneticisinin odadan istedikleri (test için arayüz). */
export interface RingRoom {
  players: { get(sid: number): { info: { name: string; car?: unknown; spectator?: boolean }; state: { x: number; z: number } } | undefined };
  broadcast(ev: ServerEvent): void;
}

export type RingMsg = { t: "ring"; op: "join"; slot: number } | { t: "ring"; op: "leave" } | { t: "ring"; op: "start"; laps: number };

/** Yarış sürerken sıralama yayın aralığı (ms). */
const STANDINGS_MS = 500;

export class RingHost {
  readonly session: RingSession;
  private lastSent = 0;
  private dirty = false;

  constructor(
    private room: RingRoom,
    /** Ödül: yarış bitince ilk üçe (sid, coin). */
    private reward: (sid: number, amount: number) => void,
    rng: () => number = Math.random,
  ) {
    this.session = new RingSession(rng);
  }

  view(): RingView {
    return this.session.view();
  }

  /** İstemci isteği: hata metni ya da null. */
  handle(sid: number, msg: RingMsg, now = Date.now()): string | null {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator) return "🏁 Önce dünyaya gir.";
    let err: string | null = null;
    if (msg.op === "join") {
      if (!p.info.car) return "🏁 Yarışmak için önce Tofaşına bin.";
      err = this.session.join(sid, p.info.name, Number(msg.slot), p.state.x, p.state.z);
    } else if (msg.op === "start") {
      err = this.session.start(sid, Number(msg.laps), now, (id) => this.room.players.get(id)?.state ?? null);
    } else if (msg.op === "leave") {
      this.session.leave(sid);
    } else return null;
    if (!err) this.send(now);
    return err;
  }

  /** Oyuncunun konumu güncellendi. */
  move(sid: number, x: number, z: number, now = Date.now()): void {
    if (!this.session.move(sid, x, z, now)) return;
    this.dirty = true;
    // Bitiş çizgisi geçişi beklemeden gider: tur sayacı tam çizgide değişsin
    if (this.session.urgent) this.send(now);
  }

  /** Oyuncu ayrıldı ya da arabadan indi. */
  leave(sid: number, now = Date.now()): void {
    if (this.session.leave(sid)) this.send(now);
  }

  tick(now = Date.now()): void {
    const s = this.session;
    if (!s.count && s.phase === "idle") return;
    const phase = s.phase;
    const changed = s.tick(now);
    if (changed && phase === "racing" && s.phase === "done") for (const [sid, amount] of s.rewards()) this.reward(sid, amount);
    if (changed || (this.dirty && now - this.lastSent >= STANDINGS_MS) || (s.phase === "racing" && now - this.lastSent >= 2000)) this.send(now);
  }

  private send(now: number): void {
    this.dirty = false;
    this.session.urgent = false;
    this.lastSent = now;
    this.room.broadcast({ t: "ring", ring: this.session.view() });
  }
}
