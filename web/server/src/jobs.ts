// Odanın iş yöneticisi (kuryelik, taksicilik). İşe giren oyuncuya işin aracı izni verilir (scooter / taksi) ve
// görev hedefleri sunucuda seçilir; varış konumlardan bulunur (işin aracıyla, hedefin yakınında, yavaşlamış).
// Kurye: dükkândan paketi al → adrese teslim et (süre içinde: bonus). Taksi: yolda bekleyen NPC müşteriyi al →
// gideceği yere bırak. Oyuncular da taksi çağırabilir: çağrı taksicilerin haritasında görünür, oyuncu taksiye
// yolcu olarak binince taksimetre açılır, inince ücret yolcudan alınıp taksiciye geçer.
import {
  courierPay, courierTime, CUSTOMER_NAMES, JOB_PAY, JOBS, type JobKind, type JobView, meterFare, PICKUPS, type Place, PLACES, type TaxiCall, taxiFare,
} from "../../shared/jobs";
import type { ServerEvent } from "../../shared/protocol";
import type { Economy } from "./economy";
import type { Conn } from "./room";

/** İşlerin odadan istedikleri (test için arayüz). */
export interface JobRoom {
  players: Map<number, { info: { name: string; spectator?: boolean; car?: { model: string } | null; ride?: { d: number } | null; parked?: { car: { model: string } } | null }; state: { x: number; z: number }; conn: Conn }>;
  sendTo(conn: Conn, ev: ServerEvent): void;
  setCar(sid: number, car: null): void;
  setParked(sid: number, v: null): void;
}

interface Active {
  kind: JobKind;
  key: string;
  phase: JobView["phase"];
  target: Place | null;
  pay: number;
  until: number;
  /** Teslimatın/yolculuğun başladığı yer (mesafe için). */
  from: Place | null;
  npc: { x: number; z: number; name: string } | null;
  /** Taksi müşterisinin (NPC) adı. */
  npcName: string | null;
  /** Taksimetre: yolcu, gidilen yol, son konum; NPC işi bekletilir. */
  meter: { sid: number; name: string; dist: number; x: number; z: number } | null;
  /** Hız ölçümü (varış için yavaşlamış olmalı). */
  lx: number;
  lz: number;
  lt: number;
  speed: number;
}

const pickRandom = <T>(list: T[], rnd: () => number): T => list[Math.floor(rnd() * list.length) % list.length];
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const today = (now = Date.now()) => new Date(now + 3 * 3600_000).toISOString().slice(0, 10);

export class JobHost {
  private a = new Map<number, Active>();
  private calls = new Map<number, TaxiCall>();
  /** Bugün (hesap başına) yapılan iş ve kazanç. */
  private stats = new Map<string, { day: string; done: number; earned: number }>();
  /** Oturum → hesap (taksi ücreti yolcudan alınır). */
  private keys = new Map<number, string>();
  private last = 0;

  constructor(private room: JobRoom, private eco: Economy, private rnd: () => number = Math.random) {}

  join(sid: number, key: string): void {
    this.keys.set(sid, key);
  }

  /** İşteki oyuncunun sürebileceği iş aracı. */
  modelOf(sid: number): "motor" | "taksi" | null {
    const j = this.a.get(sid);
    return j ? JOBS[j.kind].model : null;
  }

  start(sid: number, kind: unknown, key: string, now = Date.now()): string | null {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator || (kind !== "kurye" && kind !== "taksi")) return null;
    if (this.a.get(sid)?.kind === kind) return null;
    this.stop(sid, false);
    const j: Active = { kind, key, phase: "idle", target: null, pay: 0, until: 0, from: null, npc: null, npcName: null, meter: null, lx: p.state.x, lz: p.state.z, lt: now, speed: 0 };
    this.a.set(sid, j);
    this.next(sid, j);
    if (kind === "taksi") this.sendCalls(sid);
    return null;
  }

  /** İşten çık: iş aracındaysa araçtan iner. */
  stop(sid: number, notify = true): void {
    const j = this.a.get(sid);
    if (!j) return;
    if (j.meter) this.endMeter(sid, j);
    this.a.delete(sid);
    const p = this.room.players.get(sid);
    if (!p) return;
    if (p.info.car && p.info.car.model === JOBS[j.kind].model) this.room.setCar(sid, null);
    if (p.info.parked && p.info.parked.car.model === JOBS[j.kind].model) this.room.setParked(sid, null);
    if (notify) this.room.sendTo(p.conn, { t: "job", view: null });
  }

  leave(sid: number): void {
    this.stop(sid, false);
    this.keys.delete(sid);
    if (this.calls.delete(sid)) this.broadcastCalls();
  }

  /** Oyuncu taksi çağırdı (ya da çağrıyı iptal etti). */
  call(sid: number, on: boolean): string | null {
    const p = this.room.players.get(sid);
    if (!p) return null;
    if (!on) {
      if (this.calls.delete(sid)) this.broadcastCalls();
      return null;
    }
    if ([...this.a.values()].every((j) => j.kind !== "taksi")) return "🚕 Şu an çalışan taksici yok.";
    this.calls.set(sid, { sid, name: p.info.name, x: Math.round(p.state.x), z: Math.round(p.state.z) });
    this.broadcastCalls();
    return null;
  }

  /** Biri bir arabaya yolcu olarak bindi ya da indi: taksiyse taksimetre. */
  rideChanged(sid: number, driver: number | null, prevDriver: number | null): void {
    if (prevDriver !== null) {
      const j = this.a.get(prevDriver);
      if (j?.meter?.sid === sid) this.endMeter(prevDriver, j);
    }
    if (driver === null) return;
    const j = this.a.get(driver), d = this.room.players.get(driver), p = this.room.players.get(sid);
    if (!j || j.kind !== "taksi" || j.meter || !d || !p || d.info.car?.model !== "taksi") return;
    j.meter = { sid, name: p.info.name, dist: 0, x: d.state.x, z: d.state.z };
    j.npc = null;
    if (this.calls.delete(sid)) this.broadcastCalls();
    this.room.sendTo(p.conn, { t: "notice", text: `🚕 Taksimetre açıldı: ${JOB_PAY.meterStart} ₺ açılış + 100 m başına ${JOB_PAY.meterPer100} ₺.` });
    this.send(driver, j);
  }

  /** Varışlar, süreler ve taksimetre (saniyede ~4). */
  tick(now = Date.now()): void {
    if (now - this.last < 250) return;
    this.last = now;
    for (const [sid, j] of this.a) {
      const p = this.room.players.get(sid);
      if (!p) continue;
      const dt = Math.max(0.05, (now - j.lt) / 1000);
      const step = Math.hypot(p.state.x - j.lx, p.state.z - j.lz);
      j.speed = step > 30 ? 0 : step / dt;
      j.lx = p.state.x;
      j.lz = p.state.z;
      j.lt = now;
      if (j.meter) {
        const m = j.meter;
        const s = Math.hypot(p.state.x - m.x, p.state.z - m.z);
        if (s < 40) m.dist += s;
        m.x = p.state.x;
        m.z = p.state.z;
        const fare = meterFare(m.dist);
        if (fare !== j.pay) {
          j.pay = fare;
          this.send(sid, j);
        }
        continue;
      }
      if (!j.target) continue;
      const inVehicle = p.info.car?.model === JOBS[j.kind].model;
      if (!inVehicle || dist(p.state, j.target) > JOB_PAY.reach || j.speed > JOB_PAY.stopSpeed) continue;
      this.arrive(sid, j, now);
    }
  }

  private arrive(sid: number, j: Active, now: number): void {
    const p = this.room.players.get(sid)!;
    if (j.phase === "pickup") {
      // Paket alındı: adres seç
      const from = j.target!;
      const to = this.farPlace(from, 150);
      const d = dist(from, to);
      j.phase = "deliver";
      j.from = from;
      j.target = to;
      j.pay = courierPay(d);
      j.until = now + courierTime(d);
      this.room.sendTo(p.conn, { t: "notice", text: `📦 Paketi aldın: ${to.name}'e götür.` });
      this.send(sid, j);
    } else if (j.phase === "deliver") {
      const onTime = now <= j.until;
      const bonus = onTime ? Math.round((j.pay * JOB_PAY.onTime) / 5) * 5 : 0;
      this.paid(j, j.pay + bonus, `Teslimat tamam${onTime ? ` · zamanında +${bonus} bonus` : " · geç kaldın"}`, "📦");
      this.next(sid, j);
    } else if (j.phase === "fetch") {
      // Müşteri bindi: gideceği yer
      const from = j.target!;
      const to = this.farPlace(from, 150);
      j.phase = "ride";
      j.from = from;
      j.target = to;
      j.pay = taxiFare(dist(from, to));
      j.until = 0;
      j.npc = null;
      this.room.sendTo(p.conn, { t: "notice", text: `🚕 ${j.npcName ?? "Müşteri"} bindi: "${to.name}'e lütfen."` });
      this.send(sid, j);
    } else if (j.phase === "ride") {
      this.paid(j, j.pay, `Taksi yolculuğu · ${j.npcName ?? "müşteri"}`, "🚕");
      this.next(sid, j);
    }
  }

  /** Yeni görev: kuryede paket alınacak dükkân, taksicide bekleyen müşteri. */
  private next(sid: number, j: Active): void {
    const p = this.room.players.get(sid);
    if (!p) return;
    j.until = 0;
    j.from = null;
    if (j.kind === "kurye") {
      j.phase = "pickup";
      j.target = pickRandom(PICKUPS, this.rnd);
      j.pay = 0;
      j.npc = null;
    } else {
      j.phase = "fetch";
      const at = this.farPlace(p.state, 80);
      j.target = at;
      j.pay = 0;
      j.npcName = pickRandom(CUSTOMER_NAMES, this.rnd);
      j.npc = { x: at.x, z: at.z, name: j.npcName };
    }
    this.send(sid, j);
  }

  /** `from`dan en az `min` metre uzak rastgele durak (yoksa herhangi biri). */
  private farPlace(from: { x: number; z: number }, min: number): Place {
    const far = PLACES.filter((q) => dist(q, from) >= min);
    return pickRandom(far.length ? far : PLACES, this.rnd);
  }

  private paid(j: Active, amount: number, reason: string, icon: string): void {
    this.eco.add(j.key, amount, { reason, icon });
    const s = this.stat(j.key);
    s.done++;
    s.earned += amount;
  }

  private endMeter(sid: number, j: Active): void {
    const m = j.meter!;
    j.meter = null;
    const passenger = this.room.players.get(m.sid);
    const fare = meterFare(m.dist);
    const pkey = this.keyOf(m.sid);
    const got = pkey ? this.eco.charge(pkey, fare, { reason: `Taksi ücreti · ${this.room.players.get(sid)?.info.name ?? "taksici"}`, icon: "🚕" }) : 0;
    if (got > 0) this.paid(j, got, `Taksi · ${m.name}`, "🚕");
    if (passenger) this.room.sendTo(passenger.conn, { t: "notice", text: `🚕 Taksimetre: ${fare} ₺${got < fare ? ` (yalnızca ${got} ₺ ödeyebildin)` : ""}. İyi günler!` });
    this.next(sid, j);
  }

  private keyOf(sid: number): string | null {
    return this.keys.get(sid) ?? null;
  }

  private stat(key: string): { day: string; done: number; earned: number } {
    const t = today();
    let s = this.stats.get(key);
    if (!s || s.day !== t) this.stats.set(key, (s = { day: t, done: 0, earned: 0 }));
    return s;
  }

  private send(sid: number, j: Active): void {
    const p = this.room.players.get(sid);
    if (!p) return;
    const s = this.stat(j.key);
    const view: JobView = {
      kind: j.kind,
      phase: j.meter ? "meter" : j.phase,
      target: j.meter ? null : j.target,
      pay: j.pay,
      until: j.until,
      done: s.done,
      earned: s.earned,
      who: j.meter?.name ?? j.npcName ?? undefined,
      npc: j.phase === "fetch" && !j.meter ? j.npc : null,
    };
    this.room.sendTo(p.conn, { t: "job", view });
  }

  private sendCalls(sid: number): void {
    const p = this.room.players.get(sid);
    if (p) this.room.sendTo(p.conn, { t: "taxicalls", calls: [...this.calls.values()] });
  }

  private broadcastCalls(): void {
    for (const [sid, j] of this.a) if (j.kind === "taksi") this.sendCalls(sid);
  }
}
