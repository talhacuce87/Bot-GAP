// Odanın hayat yöneticisi: oyuncuların can/açlık/enerji barları (sunucu yetkili). Saniyede bir açlık ve enerji
// düşer (koşarken hızlı, otururken enerji dolar), açlık sıfırken can gider. Yüksekten düşme (istemci bildirir,
// sınırlı) ve hızlı arabanın yayaya çarpması (sunucu konumlardan bulur) can götürür. Can sıfırlanınca bayılır:
// yanındaki kaldırabilir; kimse kaldırmazsa ya da ambulans çağırırsa hastanede uyanır ve fatura öder.
import { FLAG_RUNNING, FLAG_SEATED } from "../../shared/constants";
import { carHitDamage, ECON, fallDamage, LIFE, type LifeState, stepLife } from "../../shared/economy";
import type { ServerEvent } from "../../shared/protocol";
import { SPAWN } from "../../shared/zones";
import type { Economy } from "./economy";
import type { Conn } from "./room";

/** Hastane: şimdilik köy meydanı (sağlık ocağı). */
export const HOSPITAL = { x: SPAWN.x, z: SPAWN.z, rot: SPAWN.rot };

/** Hayatın odadan istedikleri (test için arayüz). */
export interface LifeRoom {
  players: Map<number, { info: { name: string; spectator?: boolean; car?: unknown; ride?: unknown; downed?: boolean }; state: { x: number; z: number; flags: number }; conn: Conn }>;
  sendTo(conn: Conn, ev: ServerEvent): void;
  broadcast(ev: ServerEvent): void;
  teleport(sid: number, x: number, z: number, rot: number, now?: number): number;
}

interface Entry {
  key: string;
  l: LifeState;
  /** Son gönderilen (yalnızca değişince ya da ara ara gönderilir). */
  sent: LifeState;
  sentAt: number;
  /** Bayıldıysa uyanacağı an (sunucu saati), değilse 0. */
  downed: number;
  /** Son düşme bildirimi (sınır). */
  fallAt: number;
}

export class LifeHost {
  private e = new Map<number, Entry>();
  private last = 0;
  private savedAt = 0;
  /** Sürücülerin önceki konumu (hız) ve son çarptıkları (aynı kişiye arka arkaya vurmasın). */
  private drivers = new Map<number, { x: number; z: number; at: number }>();
  private hits = new Map<string, number>();
  /** Süren kaldırmalar: bayılan → kaldıran ve bitiş anı. */
  private reviving = new Map<number, { by: number; until: number }>();

  constructor(private room: LifeRoom, private eco: Economy) {}

  join(sid: number, key: string, now = Date.now()): void {
    const l = this.eco.life(key);
    // Bayılmış çıkan geri gelince hastanede değil, olduğu yerde kalkar (can en az kaldırma kadar)
    if (l.hp <= 0) l.hp = LIFE.reviveHp;
    this.e.set(sid, { key, l, sent: { ...l }, sentAt: 0, downed: 0, fallAt: -Infinity });
    this.send(sid, now, true);
  }

  leave(sid: number): void {
    this.cancelRevives(sid);
    const x = this.e.get(sid);
    if (x) this.eco.setLife(x.key, x.l);
    this.e.delete(sid);
    this.drivers.delete(sid);
  }

  isDowned(sid: number): boolean {
    return (this.e.get(sid)?.downed ?? 0) > 0;
  }

  /** Saniyede bir barlar; bayılanın süresi; ara ara kayıt. */
  tick(now = Date.now()): void {
    this.checkRevives(now);
    if (now - this.last < 1000) return;
    const dt = this.last ? Math.min(5, (now - this.last) / 1000) : 1;
    this.last = now;
    for (const [sid, x] of this.e) {
      const p = this.room.players.get(sid);
      if (!p || p.info.spectator) continue;
      if (x.downed) {
        if (now >= x.downed) this.hospital(sid, now);
        continue;
      }
      x.l = stepLife(x.l, dt, { running: (p.state.flags & FLAG_RUNNING) !== 0, seated: (p.state.flags & FLAG_SEATED) !== 0 || !!p.info.ride });
      if (x.l.hp <= 0) this.down(sid, now);
      this.send(sid, now);
    }
    if (now - this.savedAt > 15_000) {
      this.savedAt = now;
      for (const x of this.e.values()) this.eco.setLife(x.key, x.l);
    }
  }

  /** Can götür (düşme, çarpma). */
  hurt(sid: number, amount: number, now = Date.now()): void {
    const x = this.e.get(sid);
    if (!x || x.downed || amount <= 0) return;
    x.l.hp = Math.max(0, x.l.hp - amount);
    if (x.l.hp <= 0) this.down(sid, now);
    this.send(sid, now, true);
  }

  /** İstemci: yüksekten düştü (`h` metre). Sınırlı ve seyrek. */
  fall(sid: number, h: unknown, now = Date.now()): void {
    const x = this.e.get(sid);
    if (!x || typeof h !== "number" || !Number.isFinite(h) || now - x.fallAt < 1000) return;
    x.fallAt = now;
    this.hurt(sid, fallDamage(Math.min(h, 40)), now);
  }

  /**
   * Sürücünün yeni konumu: hızlıysa yoluna çıkan yayalara çarpar (aynı kişiye 1,5 sn'de bir). Yolcular ve
   * arabadakiler çarpılmaz.
   */
  carMove(sid: number, x: number, z: number, now = Date.now()): void {
    const prev = this.drivers.get(sid);
    this.drivers.set(sid, { x, z, at: now });
    if (!prev || now - prev.at > 500 || now <= prev.at) return;
    const v = Math.hypot(x - prev.x, z - prev.z) / ((now - prev.at) / 1000);
    const dmg = carHitDamage(v);
    if (!dmg) return;
    for (const [other, q] of this.room.players) {
      if (other === sid || q.info.spectator || q.info.car || q.info.ride || this.isDowned(other)) continue;
      if (Math.hypot(q.state.x - x, q.state.z - z) > 1.9) continue;
      const k = `${sid}:${other}`;
      if (now - (this.hits.get(k) ?? -Infinity) < 1500) continue;
      this.hits.set(k, now);
      this.hurt(other, dmg, now);
      const me = this.room.players.get(other);
      if (me) this.room.sendTo(me.conn, { t: "notice", text: `🚗 ${this.room.players.get(sid)?.info.name ?? "Bir araba"} sana çarptı! −${dmg} can` });
    }
    if (this.hits.size > 500) this.hits.clear();
  }

  /** Bayılanı kaldırmaya başla (yanındaysa): `LIFE.reviveMs` yanında kalırsa kalkar. Hata metni döner. */
  revive(sid: number, target: number, now = Date.now()): string | null {
    const me = this.room.players.get(sid), p = this.room.players.get(target), x = this.e.get(target);
    if (!me || !p || !x?.downed || sid === target) return null;
    if (this.isDowned(sid)) return null;
    if (!this.near(sid, target)) return "🩹 Kaldırmak için yanına git.";
    const cur = this.reviving.get(target);
    if (cur) return cur.by === sid ? null : "🩹 Onu zaten biri kaldırıyor.";
    for (const r of this.reviving.values()) if (r.by === sid) return null;
    const until = now + LIFE.reviveMs;
    this.reviving.set(target, { by: sid, until });
    this.tellRevive(sid, target, until);
    return null;
  }

  private near(a: number, b: number): boolean {
    const p = this.room.players.get(a), q = this.room.players.get(b);
    return !!p && !!q && Math.hypot(p.state.x - q.state.x, p.state.z - q.state.z) <= LIFE.reviveReach + 0.5;
  }

  private tellRevive(by: number, target: number, until: number): void {
    for (const s of [by, target]) {
      const p = this.room.players.get(s);
      if (p) this.room.sendTo(p.conn, { t: "reviving", by, target, until });
    }
  }

  /** Süren kaldırmalar: süre dolduysa kalkar; kaldıran uzaklaştıysa, bayıldıysa ya da çıktıysa iptal. */
  private checkRevives(now: number): void {
    for (const [target, r] of this.reviving) {
      const ok = this.isDowned(target) && !this.isDowned(r.by) && this.near(r.by, target);
      if (!ok) {
        this.reviving.delete(target);
        this.tellRevive(r.by, target, 0);
      } else if (now >= r.until) {
        this.reviving.delete(target);
        this.tellRevive(r.by, target, 0);
        this.finishRevive(r.by, target, now);
      }
    }
  }

  /** `sid` ile ilgili (kaldıran ya da kaldırılan) kaldırmaları iptal et. */
  private cancelRevives(sid: number): void {
    for (const [target, r] of this.reviving) {
      if (target !== sid && r.by !== sid) continue;
      this.reviving.delete(target);
      this.tellRevive(r.by, target, 0);
    }
  }

  private finishRevive(sid: number, target: number, now: number): void {
    const me = this.room.players.get(sid), p = this.room.players.get(target), x = this.e.get(target);
    if (!me || !p || !x?.downed) return;
    x.downed = 0;
    x.l.hp = LIFE.reviveHp;
    this.setDowned(target, false);
    this.send(target, now, true);
    this.room.sendTo(p.conn, { t: "notice", text: `🩹 ${me.info.name} seni kaldırdı.` });
  }

  /** Bayılan beklemeden ambulans çağırır: hastanede uyanır. */
  ambulance(sid: number, now = Date.now()): void {
    if (this.isDowned(sid)) this.hospital(sid, now);
  }

  private down(sid: number, now: number): void {
    const x = this.e.get(sid)!;
    x.l.hp = 0;
    x.downed = now + LIFE.downedMs;
    this.setDowned(sid, true);
    this.send(sid, now, true);
  }

  /** Hastanede uyan: fatura (yetmezse eldeki), can yarıya. */
  private hospital(sid: number, now: number): void {
    const x = this.e.get(sid), p = this.room.players.get(sid);
    if (!x || !p) return;
    this.cancelRevives(sid);
    x.downed = 0;
    x.l.hp = LIFE.hospitalHp;
    this.eco.charge(x.key, ECON.hospitalFee, { reason: "Hastane faturası", icon: "🚑" });
    this.room.teleport(sid, HOSPITAL.x, HOSPITAL.z, HOSPITAL.rot, now);
    this.setDowned(sid, false);
    this.send(sid, now, true, HOSPITAL);
    this.eco.setLife(x.key, x.l);
  }

  private setDowned(sid: number, on: boolean): void {
    const p = this.room.players.get(sid);
    if (!p) return;
    p.info.downed = on;
    this.room.broadcast({ t: "downed", sid, on });
  }

  /** Barları sahibine gönder: değiştiyse ya da 5 sn'de bir. */
  private send(sid: number, now: number, force = false, tp?: { x: number; z: number; rot: number }): void {
    const x = this.e.get(sid), p = this.room.players.get(sid);
    if (!x || !p) return;
    const ch = Math.abs(x.l.hp - x.sent.hp) >= 0.5 || Math.abs(x.l.hunger - x.sent.hunger) >= 0.5 || Math.abs(x.l.energy - x.sent.energy) >= 0.5;
    if (!force && !ch && now - x.sentAt < 5000) return;
    x.sent = { ...x.l };
    x.sentAt = now;
    this.room.sendTo(p.conn, { t: "life", hp: Math.round(x.l.hp), hunger: Math.round(x.l.hunger), energy: Math.round(x.l.energy), downed: x.downed, tp });
  }
}
