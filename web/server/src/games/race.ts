// Oyuncak pist yarışı. Binada katılınır (en çok 8); lobiyi ilk açan pisti seçer ve en az 2 kişiyle başlatır.
// Arabaları istemciler sürer, konumlarını ~15 Hz gönderir; sunucu hızı doğrular, sektörleri sırayla sayar
// (kestirme yok), sırayı belirler ve konumları herkese yayınlar.
import type { RacePlayer, RaceState } from "../../../shared/protocol";
import { advance, gridSpot, maxTravel, newProgress, type Progress, project, RACE, score, trackOf, TRACKS } from "../../../shared/race";
import { RACE_HOUSE } from "../../../shared/zones";
import type { Conn, Room } from "../room";

interface Racer {
  prog: Progress;
  x: number;
  z: number;
  a: number;
  f: number;
  hint: number;
  /** Son geçerli raporun anı. */
  at: number;
}

export class Race {
  state: RaceState | null = null;
  private racers = new Map<number, Racer>();
  private dirty = false;

  constructor(
    private room: Room,
    private report: (sid: number, event: string) => void,
  ) {}

  private publish(): void {
    this.room.broadcast({ t: "race", state: this.state });
  }

  sendTo(conn: Conn): void {
    this.room.sendTo(conn, { t: "race", state: this.state });
  }

  private notice(sid: number, text: string): void {
    const conn = this.room.players.get(sid)?.conn;
    if (conn) this.room.sendTo(conn, { t: "notice", text });
  }

  /** Oyuncu binanın içinde mi. */
  private inside(sid: number): boolean {
    const p = this.room.players.get(sid);
    return !!p && Math.abs(p.state.x - RACE_HOUSE.x) < RACE_HOUSE.hw + 0.5 && Math.abs(p.state.z - RACE_HOUSE.z) < RACE_HOUSE.hd + 0.5;
  }

  join(sid: number): void {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator || p.info.jailed) return;
    if (!this.inside(sid)) return this.notice(sid, "🏎️ Yarışa katılmak için Oyuncak Pist binasına gir.");
    const s = this.state;
    if (!s) {
      this.state = { phase: "lobby", host: sid, track: 0, players: [this.entry(sid)], startAt: 0, endsAt: 0 };
      return this.publish();
    }
    if (s.players.some((r) => r.sid === sid)) return;
    if (s.phase !== "lobby") return this.notice(sid, "🏎️ Yarış sürüyor; bitince katılabilirsin.");
    if (s.players.length >= RACE.max) return this.notice(sid, `🏎️ Pist dolu (${RACE.max} kişi).`);
    s.players.push(this.entry(sid));
    this.publish();
  }

  private entry(sid: number): RacePlayer {
    return { sid, lap: 0, place: 0, time: 0 };
  }

  leave(sid: number, now = Date.now()): void {
    const s = this.state;
    if (!s || !s.players.some((r) => r.sid === sid)) return;
    s.players = s.players.filter((r) => r.sid !== sid);
    this.racers.delete(sid);
    if (!s.players.length) {
      this.state = null;
      this.racers.clear();
      return this.publish();
    }
    if (s.host === sid) s.host = s.players[0].sid;
    if ((s.phase === "race" || s.phase === "countdown") && s.players.every((r) => r.place)) this.finish(now);
    this.publish();
  }

  setTrack(sid: number, i: number): void {
    const s = this.state;
    if (!s || s.host !== sid || (s.phase !== "lobby" && s.phase !== "end") || !Number.isInteger(i) || i < 0 || i >= TRACKS.length) return;
    s.track = i;
    this.publish();
  }

  start(sid: number, now = Date.now()): void {
    const s = this.state;
    if (!s || s.host !== sid || (s.phase !== "lobby" && s.phase !== "end")) return;
    s.players = s.players.filter((r) => this.room.players.has(r.sid));
    if (s.players.length < RACE.min) return this.notice(sid, `🏎️ Başlatmak için en az ${RACE.min} kişi gerekli.`);
    const t = trackOf(s.track);
    this.racers.clear();
    s.players.forEach((r, slot) => {
      Object.assign(r, this.entry(r.sid));
      const g = gridSpot(t, slot);
      this.racers.set(r.sid, { prog: newProgress(), x: g.x, z: g.z, a: g.a, f: 0, hint: project(t, g.x, g.z).i, at: now });
      this.report(r.sid, "race_play");
    });
    s.phase = "countdown";
    s.startAt = now + RACE.countdownMs;
    s.endsAt = s.startAt + RACE.maxMs;
    this.publish();
  }

  /** İstemcinin araba konumu (pist birimi). */
  car(sid: number, x: number, z: number, a: number, f: number, now = Date.now()): void {
    const s = this.state, r = this.racers.get(sid);
    if (!s || !r || s.phase !== "race" || ![x, z, a].every(Number.isFinite)) return;
    const me = s.players.find((p) => p.sid === sid);
    if (!me || me.place) return;
    const t = trackOf(s.track);
    // Işınlanma yok: iki rapor arasında gidilebilecek yoldan uzunsa yok sayılır
    if (Math.hypot(x - r.x, z - r.z) > maxTravel(now - r.at)) return;
    const p = project(t, x, z, r.hint);
    if (Math.abs(p.d) > RACE.halfW + 1.5) return;
    Object.assign(r, { x, z, a, f: f & 3, hint: p.i, at: now });
    const lap = r.prog.lap;
    advance(t, r.prog, p.i);
    this.dirty = true;
    if (r.prog.lap === lap) return;
    if (r.prog.lap > RACE.laps) {
      // Bitirdi
      me.lap = RACE.laps;
      me.time = now - s.startAt;
      me.place = s.players.filter((q) => q.place).length + 1;
      this.room.broadcast({ t: "notice", text: `🏁 ${this.room.players.get(sid)?.info.name ?? "Biri"} ${me.place}. bitirdi (${(me.time / 1000).toFixed(2)} sn)` });
      if (me.place === 1) s.endsAt = Math.min(s.endsAt, now + RACE.finishWaitMs);
      if (s.players.every((q) => q.place)) return this.finish(now);
    } else me.lap = r.prog.lap;
    this.publish();
  }

  private finish(now: number): void {
    const s = this.state!;
    // Bitiremeyenler ilerlemelerine göre sıralanır
    const t = trackOf(s.track);
    const rest = s.players.filter((r) => !r.place).sort((a, b) => this.progress(t, b.sid) - this.progress(t, a.sid));
    let place = s.players.filter((r) => r.place).length;
    for (const r of rest) r.place = ++place;
    const winner = s.players.find((r) => r.place === 1 && r.time);
    if (winner && s.players.length >= RACE.min) this.report(winner.sid, "race_win");
    s.phase = "end";
    s.endsAt = now + RACE.resultMs;
    this.publish();
  }

  private progress(t: ReturnType<typeof trackOf>, sid: number): number {
    const r = this.racers.get(sid);
    return r ? score(t, r.prog, r.hint) : -Infinity;
  }

  tick(now: number): void {
    const s = this.state;
    if (!s) return;
    if (s.phase === "countdown" && now >= s.startAt) {
      s.phase = "race";
      for (const r of this.racers.values()) r.at = now;
      this.publish();
    }
    if (s.phase === "race") {
      if (now >= s.endsAt) return this.finish(now);
      if (this.dirty) {
        this.dirty = false;
        const c: number[] = [];
        for (const [sid, r] of this.racers) c.push(sid, Math.round(r.x * 10), Math.round(r.z * 10), Math.round(r.a * 100), r.f);
        this.room.broadcast({ t: "rcars", c });
      }
    }
    if (s.phase === "end" && now >= s.endsAt) {
      // Lobiye dön: aynı oyuncular, aynı lobi sahibi; yeniden başlatılabilir
      s.phase = "lobby";
      s.players = s.players.filter((r) => this.room.players.has(r.sid)).map((r) => this.entry(r.sid));
      this.racers.clear();
      if (!s.players.length) this.state = null;
      else if (!s.players.some((r) => r.sid === s.host)) s.host = s.players[0].sid;
      this.publish();
    }
  }

  /** Yarışan (geri sayım dahil) oyuncu dünyada yürümez. */
  racing(sid: number): boolean {
    const s = this.state;
    return !!s && (s.phase === "countdown" || s.phase === "race") && s.players.some((r) => r.sid === sid);
  }
}
