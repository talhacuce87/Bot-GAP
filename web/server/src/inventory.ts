// Odanın çanta yöneticisi: dükkândan alışveriş (sepet tek seferde ödenir), çantadan kullanma (yemek/içmek
// barları doldurur, etki verir), slotlar arası taşıma, atma, yanındaki arkadaşa verme ve eldeki eşya (hızlı slot;
// herkes görür). Çanta hesaba bağlı, Economy'nin dosyasında saklanır.
import { addItems, INV, itemDef, type ItemId, moveSlot, type ShopId, SHOPS, type Slot } from "../../shared/items";
import type { ClientEvent, ServerEvent } from "../../shared/protocol";
import type { Economy } from "./economy";
import type { LifeHost } from "./life";
import type { Conn } from "./room";

/** Çantanın odadan istedikleri (test için arayüz). */
export interface BagRoom {
  players: Map<number, { info: { name: string; spectator?: boolean; held?: ItemId | null }; state: { x: number; z: number }; conn: Conn }>;
  sendTo(conn: Conn, ev: ServerEvent): void;
  broadcast(ev: ServerEvent): void;
}

/** Arkadaşa vermek için en çok bu kadar yakın (m). */
const GIVE_REACH = 3;

type InvMsg = Extract<ClientEvent, { t: "inv" }>;

export class Bags {
  /** Oturum → hesap ve elindeki hızlı slot. */
  private s = new Map<number, { key: string; hold: number | null }>();

  constructor(private room: BagRoom, private eco: Economy, private life: LifeHost | null) {}

  join(sid: number, key: string): void {
    this.s.set(sid, { key, hold: null });
    this.send(sid);
  }

  leave(sid: number): void {
    this.s.delete(sid);
  }

  /** Sepeti al: hepsi sığmalı ve para yetmeli. Hata metni döner. */
  shop(sid: number, shopId: unknown, cart: unknown): string | null {
    const me = this.s.get(sid);
    const shop = typeof shopId === "string" ? (SHOPS as Record<string, (typeof SHOPS)[ShopId]>)[shopId] : undefined;
    if (!me || !shop || !Array.isArray(cart) || !cart.length) return null;
    let slots = this.eco.inv(me.key);
    let total = 0, count = 0;
    for (const c of cart as { id?: unknown; n?: unknown }[]) {
      const id = c?.id as ItemId, n = c?.n;
      if (typeof id !== "string" || !(shop.items as string[]).includes(id) || !Number.isInteger(n) || (n as number) < 1) return null;
      count += n as number;
      if (count > INV.cartMax) return `🛒 Sepete en çok ${INV.cartMax} ürün.`;
      const next = addItems(slots, id, n as number);
      if (!next) return "🎒 Çantan dolu ya da çok ağır.";
      slots = next;
      total += itemDef(id)!.price * (n as number);
    }
    if (!this.eco.add(me.key, -total, { reason: `${shop.name} alışverişi`, icon: shop.icon })) return "💰 Bakiyen yetmiyor.";
    this.set(sid, slots);
    return null;
  }

  /** Çanta işlemleri. Hata metni döner. */
  handle(sid: number, msg: InvMsg, now = Date.now()): string | null {
    const me = this.s.get(sid);
    if (!me) return null;
    const slots = this.eco.inv(me.key);
    const at = (i: unknown) => (Number.isInteger(i) && (i as number) >= 0 && (i as number) < INV.slots ? (i as number) : -1);
    switch (msg.op) {
      case "get":
        this.send(sid);
        return null;
      case "use": {
        const i = at(msg.slot), s = slots[i];
        const use = s ? itemDef(s.id)?.use : undefined;
        if (!s || !use) return null;
        if (!this.life?.feed(sid, use, now)) return "🩸 Yaralıyken yiyip içemezsin.";
        slots[i] = s.n > 1 ? { id: s.id, n: s.n - 1 } : null;
        this.set(sid, slots);
        this.room.broadcast({ t: "eat", sid, item: s.id });
        return null;
      }
      case "drop": {
        const i = at(msg.slot);
        if (i < 0 || !slots[i]) return null;
        slots[i] = null;
        this.set(sid, slots);
        return null;
      }
      case "move": {
        const next = moveSlot(slots, at(msg.from), at(msg.to));
        if (next) this.set(sid, next);
        return null;
      }
      case "give": {
        const i = at(msg.slot), s = slots[i], to = this.s.get(msg.sid);
        const p = this.room.players.get(sid), q = this.room.players.get(msg.sid);
        if (!s || !to || !p || !q || msg.sid === sid || q.info.spectator) return null;
        if (Math.hypot(p.state.x - q.state.x, p.state.z - q.state.z) > GIVE_REACH) return "🤝 Vermek için yanına git.";
        const theirs = addItems(this.eco.inv(to.key), s.id, s.n);
        if (!theirs) return `🎒 ${q.info.name}'in çantası dolu.`;
        slots[i] = null;
        this.set(sid, slots);
        this.set(msg.sid, theirs);
        const d = itemDef(s.id)!;
        this.room.sendTo(q.conn, { t: "notice", text: `🤝 ${p.info.name} sana ${s.n} ${d.name} ${d.icon} verdi.` });
        return null;
      }
      case "hold": {
        const h = msg.slot === null ? null : Number.isInteger(msg.slot) && msg.slot >= 0 && msg.slot < INV.hotbar ? msg.slot : undefined;
        if (h === undefined) return null;
        me.hold = h;
        this.refreshHeld(sid, slots);
        return null;
      }
    }
    return null;
  }

  private set(sid: number, slots: Slot[]): void {
    const me = this.s.get(sid);
    if (!me) return;
    this.eco.setInv(me.key, slots);
    this.send(sid, slots);
    this.refreshHeld(sid, slots);
  }

  /** Elindeki eşya (seçili hızlı slottaki) değiştiyse herkese. */
  private refreshHeld(sid: number, slots: Slot[]): void {
    const me = this.s.get(sid), p = this.room.players.get(sid);
    if (!me || !p) return;
    const item = me.hold === null ? null : (slots[me.hold]?.id ?? null);
    if ((p.info.held ?? null) === item) return;
    p.info.held = item;
    this.room.broadcast({ t: "held", sid, item });
  }

  private send(sid: number, slots?: Slot[]): void {
    const me = this.s.get(sid), p = this.room.players.get(sid);
    if (me && p) this.room.sendTo(p.conn, { t: "inv", slots: slots ?? this.eco.inv(me.key) });
  }
}
