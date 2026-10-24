// Odanın canlı casino masaları (shared/liveCasino): oturma, izleme, bahis ve hamle istekleri; zamanlayıcı;
// masa değişince oturan ve izleyenlere görünüm, parası değişene bakiye gönderir.
import { type BjBets, LIVE_TABLES, type LiveTable, LiveRoulette, type LiveTableView, makeTable, SEAT_R, WATCH_R } from "../../shared/liveCasino";
import type { RouletteBet } from "../../shared/casino";
import type { ServerEvent } from "../../shared/protocol";
import { CASINO } from "../../shared/zones";
import type { Conn } from "./room";

/** Masaların odadan istedikleri (test için arayüz). */
export interface LiveRoom {
  players: { get(sid: number): { info: { name: string; spectator?: boolean }; state: { x: number; z: number }; conn: Conn } | undefined };
  sendTo(conn: Conn, ev: ServerEvent): void;
}
export interface LiveWallets {
  get(key: string): number;
  add(key: string, delta: number): boolean;
}

export type LiveMsg =
  | { t: "live"; op: "sit"; table: number; seat: number }
  | { t: "live"; op: "watch"; table: number }
  | { t: "live"; op: "leave" }
  | { t: "live"; op: "bet"; bets?: RouletteBet[]; bj?: BjBets; ready?: boolean }
  | { t: "live"; op: "act"; a: "hit" | "stand" | "double" | "split" | "insure" };

export class LiveHost {
  readonly tables: LiveTable[];
  /** Oyuncunun baktığı masa (oturan da izler). */
  private watching = new Map<number, number>();
  /** Oturanın cüzdan anahtarı (bakiye göndermek için). */
  private keys = new Map<number, string>();
  private dirtyKeys = new Set<string>();

  constructor(private room: LiveRoom, private wallets: LiveWallets, rng: () => number = Math.random) {
    const w = {
      take: (key: string, a: number) => {
        if (a <= 0) return true;
        const ok = this.wallets.add(key, -a);
        if (ok) this.dirtyKeys.add(key);
        return ok;
      },
      give: (key: string, a: number) => {
        if (a <= 0) return;
        this.wallets.add(key, a);
        this.dirtyKeys.add(key);
      },
    };
    this.tables = LIVE_TABLES.map((d) => makeTable(d, w, rng));
  }

  /** İstemci isteği: hata metni ya da null. */
  handle(sid: number, key: string, msg: LiveMsg, now = Date.now()): string | null {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator) return "🎰 Önce dünyaya gir.";
    let err: string | null = null;
    let table: LiveTable | undefined;
    if (msg.op === "sit" || msg.op === "watch") {
      table = this.tables[Number(msg.table)];
      if (!table) return null;
      const { x, z } = p.state;
      if (!(Math.abs(x - CASINO.x) < CASINO.hw && Math.abs(z - CASINO.z) < CASINO.hd)) return "🎰 Masalar casinoda.";
      if (Math.hypot(x - table.def.x, z - table.def.z) > WATCH_R) return "🎰 Masaya yaklaş.";
      if (msg.op === "sit") {
        const seat = table.def.seats[Number(msg.seat)];
        if (!seat || Math.hypot(x - seat.x, z - seat.z) > SEAT_R) return "🎰 Tabureye yaklaş.";
        if (table.seats[Number(msg.seat)]?.sid === sid) return null;
        this.unseat(sid, now);
        err = table.sit(Number(msg.seat), sid, p.info.name, key);
        if (!err) this.keys.set(sid, key);
      }
      if (!err) this.watching.set(sid, table.def.id);
    } else if (msg.op === "leave") {
      this.unseat(sid, now);
      this.watching.delete(sid);
      return null;
    } else {
      table = this.seatOf(sid)?.table;
      if (!table) return "🎰 Önce masaya otur.";
      if (msg.op === "bet") err = table instanceof LiveRoulette ? table.bet(sid, msg.bets) : table.bet(sid, msg.bj, msg.ready === true);
      else if (msg.op === "act" && !(table instanceof LiveRoulette)) err = table.act(sid, String(msg.a), now);
      else return null;
    }
    if (table) {
      table.tick(now);
      this.send(table);
    }
    this.flushWallets();
    return err;
  }

  /** Oyuncu yürüdü: masadan uzaklaşan izleyici bırakır (oturan zaten oturur). */
  move(sid: number, x: number, z: number, now = Date.now()): void {
    const id = this.watching.get(sid);
    if (id === undefined) return;
    const d = this.tables[id].def;
    if (Math.hypot(x - d.x, z - d.z) > WATCH_R + 2) {
      this.unseat(sid, now);
      this.watching.delete(sid);
    }
  }

  leave(sid: number, now = Date.now()): void {
    this.unseat(sid, now);
    this.watching.delete(sid);
  }

  tick(now = Date.now()): void {
    for (const t of this.tables) if (t.tick(now)) this.send(t);
    this.flushWallets();
  }

  view(id: number): LiveTableView | null {
    return this.tables[id]?.view() ?? null;
  }

  private seatOf(sid: number): { table: LiveTable } | null {
    for (const table of this.tables) if (table.seats.some((s) => s?.sid === sid)) return { table };
    return null;
  }

  private unseat(sid: number, now: number): void {
    const s = this.seatOf(sid);
    if (!s) return;
    s.table.leave(sid);
    s.table.tick(now);
    this.send(s.table);
    this.flushWallets();
    this.keys.delete(sid);
  }

  private send(t: LiveTable): void {
    const ev: ServerEvent = { t: "live", table: t.view() };
    for (const [sid, id] of this.watching) {
      if (id !== t.def.id) continue;
      const p = this.room.players.get(sid);
      if (p) this.room.sendTo(p.conn, ev);
    }
  }

  private flushWallets(): void {
    if (!this.dirtyKeys.size) return;
    for (const [sid, key] of this.keys) {
      if (!this.dirtyKeys.has(key)) continue;
      const p = this.room.players.get(sid);
      if (p) this.room.sendTo(p.conn, { t: "wallet", balance: this.wallets.get(key) });
    }
    this.dirtyKeys.clear();
  }
}
