// Ebelemece ve saklambaç. "!ebelemece" / "!saklambaç" 20 sn'lik katılım açar ("!katıl" ya da düğme).
// Ebelemece: ebe birine değince ebelik geçer (hemen geri alınamaz); 3 dk sonunda en az ebe kalan kazanır.
// Saklambaç: ebe 30 sn gözünü kapatır (hareket edemez), sonra değdiklerini bulur; 4 dk içinde hepsini bulursa ebe kazanır.
import type { TagMode, TagState } from "../../../shared/protocol";
import type { Conn, Room } from "../room";

const JOIN_MS = 20_000;
const HIDE_MS = 30_000;
const PLAY_MS: Record<TagMode, number> = { ebelemece: 3 * 60_000, saklambac: 4 * 60_000 };
const END_MS = 10_000;
const TOUCH_R = 1.3;
/** Ebelik geçince yeni ebe eski ebeye bu kadar süre dokunamaz. */
const NO_TAGBACK_MS = 3000;
const MIN_PLAYERS = 2;

export class Tag {
  state: TagState | null = null;
  private lastTag = 0;
  private prevIt = 0;
  private itSince = 0;

  constructor(
    private room: Room,
    private report: (sid: number, event: string) => void,
  ) {}

  private name(sid: number): string {
    return this.room.players.get(sid)?.info.name ?? "Biri";
  }

  private publish(): void {
    this.room.broadcast({ t: "tag", state: this.state });
  }

  sendTo(conn: Conn): void {
    this.room.sendTo(conn, { t: "tag", state: this.state });
  }

  /** Ebe saklambaçta gözü kapalıyken yürüyemez. */
  frozen(sid: number): boolean {
    return this.state?.phase === "hide" && this.state.it === sid;
  }

  open(sid: number, mode: TagMode, now = Date.now()): string | null {
    if (this.state && this.state.phase !== "end") return "Zaten bir oyun var: !katıl yazıp girebilirsin.";
    this.state = { mode, phase: "join", it: 0, players: [sid], found: [], endsAt: now + JOIN_MS, scores: {}, result: "" };
    this.publish();
    return null;
  }

  join(sid: number): void {
    const s = this.state;
    const p = this.room.players.get(sid);
    if (!s || s.phase !== "join" || !p || p.info.spectator || p.info.jailed || s.players.includes(sid)) return;
    s.players.push(sid);
    this.publish();
  }

  leave(sid: number, now = Date.now()): void {
    const s = this.state;
    if (!s || !s.players.includes(sid)) return;
    s.players = s.players.filter((p) => p !== sid);
    if (s.phase === "join") return this.publish();
    if (s.players.length < MIN_PLAYERS) return this.finish(now, "Oyuncu kalmadı, oyun bitti.");
    if (s.it === sid) {
      // Ebe çıktı: rastgele yeni ebe
      this.setIt(s.players.filter((p) => !s.found.includes(p))[0] ?? s.players[0], now);
    }
    this.publish();
  }

  private setIt(sid: number, now: number): void {
    const s = this.state!;
    if (s.it) s.scores[s.it] = (s.scores[s.it] ?? 0) + Math.round((now - this.itSince) / 1000);
    this.prevIt = s.it;
    s.it = sid;
    this.itSince = now;
    this.lastTag = now;
  }

  private finish(now: number, result: string): void {
    const s = this.state!;
    s.phase = "end";
    s.endsAt = now + END_MS;
    s.result = result;
    this.publish();
  }

  tick(now: number): void {
    const s = this.state;
    if (!s) return;
    if (s.phase === "join" && now >= s.endsAt) {
      s.players = s.players.filter((sid) => this.room.players.has(sid));
      if (s.players.length < MIN_PLAYERS) return this.finish(now, "Yeterli oyuncu katılmadı.");
      for (const sid of s.players) this.report(sid, "tag_play");
      this.setIt(s.players[Math.floor(Math.random() * s.players.length)], now);
      s.scores = {};
      if (s.mode === "saklambac") {
        s.phase = "hide";
        s.endsAt = now + HIDE_MS;
      } else {
        s.phase = "play";
        s.endsAt = now + PLAY_MS.ebelemece;
      }
      return this.publish();
    }
    if (s.phase === "hide" && now >= s.endsAt) {
      s.phase = "play";
      s.endsAt = now + PLAY_MS.saklambac;
      return this.publish();
    }
    if (s.phase === "play") {
      if (now >= s.endsAt) return this.timeUp(now);
      this.touches(now);
    }
    if (s.phase === "end" && now >= s.endsAt) {
      this.state = null;
      this.publish();
    }
  }

  private touches(now: number): void {
    const s = this.state!;
    const it = this.room.players.get(s.it);
    if (!it) return;
    for (const sid of s.players) {
      if (sid === s.it || s.found.includes(sid)) continue;
      const p = this.room.players.get(sid);
      if (!p || Math.hypot(p.state.x - it.state.x, p.state.z - it.state.z) > TOUCH_R) continue;
      if (s.mode === "ebelemece") {
        if (sid === this.prevIt && now - this.lastTag < NO_TAGBACK_MS) continue;
        if (now - this.lastTag < 800) continue;
        this.setIt(sid, now);
        this.room.broadcast({ t: "notice", text: `🏃 ${this.name(sid)} ebe oldu!` });
      } else {
        s.found.push(sid);
        this.room.broadcast({ t: "notice", text: `👀 ${this.name(s.it)}, ${this.name(sid)}'i buldu!` });
        if (s.players.every((q) => q === s.it || s.found.includes(q))) {
          this.report(s.it, "tag_win");
          return this.finish(now, `🙈 ${this.name(s.it)} herkesi buldu ve kazandı!`);
        }
      }
      this.publish();
      return;
    }
  }

  private timeUp(now: number): void {
    const s = this.state!;
    if (s.mode === "saklambac") {
      const hidden = s.players.filter((q) => q !== s.it && !s.found.includes(q));
      for (const h of hidden) this.report(h, "tag_win");
      return this.finish(now, `🫣 Süre bitti: ${hidden.map((h) => this.name(h)).join(", ")} bulunamadı, saklananlar kazandı!`);
    }
    this.setIt(s.it, now); // son ebenin süresi de yazılsın
    const ranked = [...s.players].sort((a, b) => (s.scores[a] ?? 0) - (s.scores[b] ?? 0));
    const best = ranked[0], worst = ranked[ranked.length - 1];
    if (best) this.report(best, "tag_win");
    this.finish(now, `⏱️ Bitti! En az ebe kalan ${this.name(best)} (${s.scores[best] ?? 0} sn) kazandı · en çok ebe kalan ${this.name(worst)} (${s.scores[worst] ?? 0} sn).`);
  }
}
