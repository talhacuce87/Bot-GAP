// Kahvehane masaları: oturma, oyunu başlatma, hamle doğrulama (kurallar shared/games), pes etme.
// Masaya oturan kalkarsa süren oyun biter. Okey'de herkese yalnızca kendi eli gönderilir.
import { chessInitial, chessMove, type ChessMove, type ChessState } from "../../../shared/games/chess";
import { okeyDeal, okeyMove, type OkeyMove, type OkeyState, okeyView } from "../../../shared/games/okey";
import { type Side, tavlaInitial, tavlaMove, type TavlaMove, tavlaMoves, tavlaNextTurn, type TavlaState } from "../../../shared/games/tavla";
import type { ServerEvent, TableGame, TableMove } from "../../../shared/protocol";
import { TABLES, type TableSpot } from "../../../shared/zones";
import type { Conn, Room } from "../room";

type Game =
  | { kind: "tavla"; state: TavlaState; order: number[]; passAt: number }
  | { kind: "satranc"; state: ChessState; order: number[] }
  | { kind: "okey"; state: OkeyState; order: number[] };

interface Table {
  spot: TableSpot;
  seats: number[];
  game: Game | null;
  note: string;
}

/** Oturmak için koltuğa bu kadar yakın olmalı. */
const SIT_REACH = 2.6;
/** Tavlada oynanacak hamle yoksa sıra bu kadar sonra geçer (zarlar görünsün). */
const PASS_MS = 1600;

const die = () => 1 + Math.floor(Math.random() * 6);

export class Tables {
  private tables: Table[] = TABLES.map((spot) => ({ spot, seats: spot.seats.map(() => 0), game: null, note: "" }));

  constructor(
    private room: Room,
    /** Görev/sayaç olayı (botta): oyun oynandı, kazanıldı. */
    private report: (sid: number, event: string) => void,
  ) {}

  private name(sid: number): string {
    return this.room.players.get(sid)?.info.name ?? "Biri";
  }

  private seatOf(sid: number): { t: Table; seat: number } | null {
    for (const t of this.tables) {
      const seat = t.seats.indexOf(sid);
      if (seat >= 0) return { t, seat };
    }
    return null;
  }

  /** Oyuncunun görebileceği masa durumu (okey'de kendi eli). */
  private view(t: Table, sid: number): ServerEvent {
    let game: TableGame | null = null;
    const g = t.game;
    if (g?.kind === "okey") {
      const idx = g.order.indexOf(sid);
      game = { kind: "okey", state: okeyView(g.state, idx) };
    } else if (g) game = { kind: g.kind, state: g.state } as TableGame;
    const names = t.seats.map((s) => (s ? this.name(s) : ""));
    return { t: "table", id: t.spot.id, kind: t.spot.kind, seats: t.seats, names, game, note: t.note, order: g?.order ?? [] };
  }

  private publish(t: Table): void {
    for (const [sid, p] of this.room.players) this.room.sendTo(p.conn, this.view(t, sid));
  }

  /** Yeni gelene bütün masalar. */
  sendAll(conn: Conn, sid: number): void {
    for (const t of this.tables) this.room.sendTo(conn, this.view(t, sid));
  }

  sit(sid: number, id: number, seat: number): boolean {
    const t = this.tables[id];
    const p = this.room.players.get(sid);
    const spot = t?.spot.seats[seat];
    if (!t || !p || !spot || p.info.spectator || p.info.jailed || t.seats[seat]) return false;
    if (Math.hypot(p.state.x - spot.x, p.state.z - spot.z) > SIT_REACH) return false;
    this.leave(sid);
    t.seats[seat] = sid;
    if (!t.game) t.note = this.readyNote(t);
    this.publish(t);
    return true;
  }

  private readyNote(t: Table): string {
    // Her oyun en az iki kişiyle (okey 2–4)
    return t.seats.filter(Boolean).length >= 2 ? "Hazır: oturanlardan biri oyunu başlatabilir." : "Rakip bekleniyor…";
  }

  /** Kalkış (ya da çıkış): süren oyun biter. */
  leave(sid: number): void {
    const at = this.seatOf(sid);
    if (!at) return;
    const { t, seat } = at;
    t.seats[seat] = 0;
    if (t.game && t.game.order.includes(sid)) {
      t.game = null;
      t.note = `${this.name(sid)} masadan kalktı, oyun bitti.`;
    } else if (!t.game) t.note = this.readyNote(t);
    this.publish(t);
  }

  start(sid: number, id: number): void {
    const t = this.tables[id];
    if (!t || !t.seats.includes(sid) || (t.game && !this.finished(t.game))) return;
    const seated = t.seats.filter(Boolean);
    if (seated.length < 2) return;
    const kind = t.spot.kind;
    if (kind === "okey") {
      // Oturuş sırasıyla; başlatan ilk oynar
      const order = t.seats.filter(Boolean);
      const starter = order.indexOf(sid);
      t.game = { kind, state: okeyDeal(order.length, Math.random, starter), order };
      t.note = `Okey başladı · ${this.name(sid)} 15 taşla başlıyor, bir taş atar.`;
    } else {
      const order = [t.seats[0], t.seats[1]];
      if (!order[0] || !order[1]) return;
      if (kind === "tavla") {
        // İlk zar: büyük atan başlar (eşitse yeniden)
        let a = die(), b = die();
        while (a === b) [a, b] = [die(), die()];
        const first: Side = a > b ? 0 : 1;
        t.game = { kind, state: tavlaInitial(first, [Math.max(a, b), Math.min(a, b)]), order, passAt: 0 };
        t.note = `Tavla başladı · ${this.name(order[first])} başlıyor (${a}–${b}).`;
        this.checkPass(t.game);
      } else {
        t.game = { kind, state: chessInitial(), order };
        t.note = `Satranç başladı · beyaz: ${this.name(order[0])}, siyah: ${this.name(order[1])}.`;
      }
    }
    for (const s of t.game.order) this.report(s, "game_play");
    this.publish(t);
  }

  private finished(g: Game): boolean {
    if (g.kind === "tavla") return g.state.winner !== null;
    if (g.kind === "satranc") return g.state.result !== null;
    return g.state.winner !== null || g.state.draw;
  }

  private checkPass(g: Game & { kind: "tavla" }): void {
    g.passAt = g.state.winner === null && !tavlaMoves(g.state).length ? Date.now() + PASS_MS : 0;
  }

  move(sid: number, id: number, move: TableMove): void {
    const t = this.tables[id];
    const g = t?.game;
    if (!g || this.finished(g)) return;
    const idx = g.order.indexOf(sid);
    if (idx < 0) return;
    if (g.kind === "tavla") {
      if (g.state.turn !== idx) return;
      const r = tavlaMove(g.state, move as TavlaMove);
      if (!r) return;
      g.state = r.state;
      if (r.state.winner !== null) this.win(t, sid, r.state.mars ? "mars ederek kazandı" : "kazandı");
      else if (r.turnOver) {
        g.state = tavlaNextTurn(g.state, [die(), die()]);
        t.note = `Sıra ${this.name(g.order[g.state.turn])}'de (${g.state.rolled.join("–")}).`;
        this.checkPass(g);
      }
    } else if (g.kind === "satranc") {
      if ((g.state.turn === "w" ? 0 : 1) !== idx) return;
      const next = chessMove(g.state, move as ChessMove);
      if (!next) return;
      g.state = next;
      if (next.result === "draw") t.note = `Berabere (${next.reason}).`;
      else if (next.result) this.win(t, sid, "mat etti");
      else t.note = `Sıra ${this.name(g.order[next.turn === "w" ? 0 : 1])}'de.`;
    } else {
      const next = okeyMove(g.state, idx, move as OkeyMove);
      if (!next) {
        if ((move as OkeyMove).kind === "discard" && (move as { finish?: boolean }).finish) this.notice(sid, "🀄 Bu el bitmiyor: taşlar per/seri ya da 7 çift olmalı.");
        return;
      }
      g.state = next;
      if (next.winner !== null) this.win(t, sid, "eli bitirdi");
      else if (next.draw) t.note = "Ortada taş kalmadı: el berabere.";
      else t.note = `Sıra ${this.name(g.order[next.turn])}'de.`;
    }
    this.publish(t);
  }

  resign(sid: number, id: number): void {
    const t = this.tables[id];
    const g = t?.game;
    if (!g || this.finished(g) || !g.order.includes(sid)) return;
    const others = g.order.filter((s) => s !== sid);
    if (g.kind === "satranc") {
      g.state = { ...g.state, result: g.order[0] === sid ? "b" : "w", reason: "terk" };
    }
    t.game = g.kind === "satranc" ? g : null;
    t.note = `${this.name(sid)} pes etti.`;
    if (others.length === 1) this.win(t, others[0], "kazandı (rakip pes etti)");
    this.publish(t);
  }

  private win(t: Table, sid: number, what: string): void {
    t.note = `🏆 ${this.name(sid)} ${what}!`;
    this.report(sid, "game_win");
  }

  private notice(sid: number, text: string): void {
    const conn = this.room.players.get(sid)?.conn;
    if (conn) this.room.sendTo(conn, { t: "notice", text });
  }

  tick(now: number): void {
    for (const t of this.tables) {
      const g = t.game;
      if (g?.kind !== "tavla" || !g.passAt || now < g.passAt) continue;
      const stuck = this.name(g.order[g.state.turn]);
      g.state = tavlaNextTurn(g.state, [die(), die()]);
      t.note = `${stuck} oynayamadı · sıra ${this.name(g.order[g.state.turn])}'de (${g.state.rolled.join("–")}).`;
      this.checkPass(g);
      this.publish(t);
    }
  }
}
