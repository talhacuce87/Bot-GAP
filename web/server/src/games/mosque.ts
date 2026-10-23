// GAP Camii: şadırvanda abdest, mihrapta imam olup cemaatle ya da tek başına (münferit) vakit namazı.
// İmam başlatınca kamet süresince (KAMET_MS) harimdekiler safa durur; sonra herkes aynı anda duruşları yapar
// (akış shared/mosque.ts). Vakit girmeden kılınmaz; bir vakit kişi başı bir kez kılınır, tamamlayan "namaz"
// görevini ilerletir. Namazda yerinden ayrılan (ya da çıkan) bozmuş sayılır.
import { ABDEST_MS, atSadirvan, IMAM_SPOT, inHarim, KAMET_MS, mosqueWorld, prayerLength, QIBLA_ROT, safSlot } from "../../../shared/mosque";
import { currentVakit, REKAT, VAKIT_NAMES, type Vakit } from "../../../shared/prayer";
import type { NamazSession } from "../../../shared/protocol";
import type { Conn, Room } from "../room";

/** Namazdayken yerinden bu kadar uzaklaşan bozmuş sayılır. */
const LEAVE_R = 1.4;

interface Session extends NamazSession {
  vakit: Vakit;
}

export class Mosque {
  private sessions: Session[] = [];
  private nextId = 1;
  /** Abdest (sid → bitiş). */
  private abdest = new Map<number, number>();
  /** Kıldığı son vakit (üye id → vakit kimliği): bir vakit bir kez. */
  private prayed = new Map<string, string>();
  /** Namazdakilerin yerleri (sid → dünya x, z). */
  private spots = new Map<number, { x: number; z: number }>();

  constructor(
    private room: Room,
    private report: (sid: number, event: string) => void,
    private clock: () => number = () => Date.now(),
  ) {}

  private publish(): void {
    this.room.broadcast({ t: "namaz", sessions: this.sessions.map(({ vakit: _v, ...s }) => s) });
  }

  sendTo(conn: Conn): void {
    this.room.sendTo(conn, { t: "namaz", sessions: this.sessions.map(({ vakit: _v, ...s }) => s) });
  }

  private notice(sid: number, text: string): void {
    const conn = this.room.players.get(sid)?.conn;
    if (conn) this.room.sendTo(conn, { t: "notice", text });
  }

  private sessionOf(sid: number): Session | undefined {
    return this.sessions.find((s) => s.members.includes(sid));
  }

  /** Namaza durabilir mi: abdest, vakit, bu vakti kılmamış olmak. Değilse nedenini bildirir. */
  private ready(sid: number, now: number): Vakit | null {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator || p.info.jailed) return null;
    if (this.sessionOf(sid)) return null;
    const v = currentVakit(now);
    if (!v) {
      this.notice(sid, "🕌 Şu an vakit yok: güneş doğduktan sonra öğle ezanına kadar namaz kılınmaz.");
      return null;
    }
    if (this.prayed.get(p.user.id) === v.id) {
      this.notice(sid, `🕌 ${VAKIT_NAMES[v.key]} namazını bu vakit kıldın. Sıradaki vakti bekle.`);
      return null;
    }
    if ((this.abdest.get(sid) ?? 0) < now) {
      this.notice(sid, "💧 Önce avludaki şadırvanda abdest al.");
      return null;
    }
    return v;
  }

  abdestAl(sid: number, now = this.clock()): void {
    const p = this.room.players.get(sid);
    if (!p || !atSadirvan(p.state.x, p.state.z)) return;
    this.abdest.set(sid, now + ABDEST_MS);
    this.notice(sid, "💧 Abdest aldın. Harimde imam olabilir, cemaate katılabilir ya da tek başına kılabilirsin.");
  }

  hasAbdest(sid: number, now = this.clock()): boolean {
    return (this.abdest.get(sid) ?? 0) >= now;
  }

  /** Mihrapta imam ol: kamet başlar, cemaat saf tutar. */
  imam(sid: number, now = this.clock()): void {
    const p = this.room.players.get(sid);
    if (!p) return;
    const at = mosqueWorld(IMAM_SPOT.x, IMAM_SPOT.z);
    if (Math.hypot(p.state.x - at.x, p.state.z - at.z) > 2) return this.notice(sid, "🕌 İmam olmak için mihrabın önüne geç.");
    if (this.sessions.some((s) => s.imam)) return this.notice(sid, "🕌 Şu an cemaat var; safa durup katılabilirsin.");
    const v = this.ready(sid, now);
    if (!v) return;
    this.start(sid, v, now, true);
  }

  /** Tek başına kıl (harimin içinde, durduğu yerde). */
  munferit(sid: number, now = this.clock()): void {
    const p = this.room.players.get(sid);
    if (!p) return;
    if (!inHarim(p.state.x, p.state.z, 0.4)) return this.notice(sid, "🕌 Namaz camide, harimin içinde kılınır.");
    const v = this.ready(sid, now);
    if (!v) return;
    this.start(sid, v, now, false);
  }

  private start(sid: number, vakit: Vakit, now: number, imam: boolean): void {
    const rekat = REKAT[vakit.key];
    const startAt = now + (imam ? KAMET_MS : 2000);
    const s: Session = { id: this.nextId++, imam: imam ? sid : 0, members: [sid], vakitKey: vakit.key, rekat, startAt, endsAt: startAt + prayerLength(rekat) * 1000, vakit };
    this.sessions.push(s);
    const p = this.room.players.get(sid)!;
    const spot = imam ? mosqueWorld(IMAM_SPOT.x, IMAM_SPOT.z) : { x: p.state.x, z: p.state.z };
    this.place(sid, spot, now);
    if (imam) this.room.broadcast({ t: "notice", text: `🕌 ${p.info.name} ${VAKIT_NAMES[vakit.key]} namazı için imam oldu: cemaate katılmak için camide saf tutun!` });
    this.publish();
  }

  private place(sid: number, spot: { x: number; z: number }, now: number): void {
    this.spots.set(sid, spot);
    const at = this.room.teleport(sid, spot.x, spot.z, QIBLA_ROT, now);
    if (at) this.room.broadcast({ t: "tp", sid, x: spot.x, z: spot.z, rot: QIBLA_ROT, at });
  }

  /** Kamet sürerken cemaate katıl: sıradaki saf yerine geçer. */
  join(sid: number, now = this.clock()): void {
    const s = this.sessions.find((q) => q.imam && now < q.startAt);
    const p = this.room.players.get(sid);
    if (!s || !p) return;
    if (!inHarim(p.state.x, p.state.z)) return this.notice(sid, "🕌 Cemaate katılmak için harime gir.");
    const v = this.ready(sid, now);
    if (!v) return;
    s.members.push(sid);
    const slot = safSlot(s.members.length - 2);
    this.place(sid, mosqueWorld(slot.x, slot.z), now);
    this.publish();
  }

  /** Namazı boz / cemaatten ayrıl. */
  leave(sid: number): void {
    const s = this.sessionOf(sid);
    this.spots.delete(sid);
    if (!s) return;
    s.members = s.members.filter((m) => m !== sid);
    // İmam ayrılırsa kamet sırasında cemaat dağılır; namaz sürerken cemaat devam eder
    if (!s.members.length || (s.imam === sid && this.clock() < s.startAt)) {
      for (const m of s.members) this.spots.delete(m);
      this.sessions = this.sessions.filter((q) => q !== s);
    }
    this.publish();
  }

  /** Ayrılınca abdest de gider. */
  gone(sid: number): void {
    this.leave(sid);
    this.abdest.delete(sid);
  }

  /** Namazdaki oyuncu yürüyemez (istemci de kilitler; bu sunucu tarafı). */
  praying(sid: number): boolean {
    return !!this.sessionOf(sid);
  }

  tick(now = this.clock()): void {
    if (!this.sessions.length) return;
    let changed = false;
    for (const s of [...this.sessions]) {
      // Yerinden ayrılan namazı bozmuş olur
      for (const m of [...s.members]) {
        const p = this.room.players.get(m), spot = this.spots.get(m);
        if (!p || !spot || Math.hypot(p.state.x - spot.x, p.state.z - spot.z) > LEAVE_R) {
          s.members = s.members.filter((q) => q !== m);
          this.spots.delete(m);
          if (p) this.notice(m, "🕌 Yerinden ayrıldın, namazın bozuldu.");
          changed = true;
        }
      }
      if (!s.members.length) {
        this.sessions = this.sessions.filter((q) => q !== s);
        changed = true;
        continue;
      }
      if (now >= s.endsAt) {
        for (const m of s.members) {
          const p = this.room.players.get(m);
          if (!p) continue;
          this.prayed.set(p.user.id, s.vakit.id);
          this.spots.delete(m);
          this.report(m, "namaz");
          this.notice(m, `🤲 ${VAKIT_NAMES[s.vakit.key]} namazını ${s.members.length > 1 ? "cemaatle " : ""}kıldın. Allah kabul etsin.`);
        }
        this.sessions = this.sessions.filter((q) => q !== s);
        changed = true;
      }
    }
    if (changed) this.publish();
  }
}
