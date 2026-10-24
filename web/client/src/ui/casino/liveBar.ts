// Canlı masa şeridi (Evolution tarzı): "CANLI" rozeti, büyük durum bandı (BAHİSLERİNİZİ YAPIN / BAHİSLER
// KAPANDI …), sunucu saatine göre geri sayım halkası ve masadaki oyuncular. Rulet ve blackjack ortak kullanır.
import { fmt } from "./casinoUi";

/** Canlı masanın istemci bağlamı: hangi masa, oturduysak koltuk, kim olduğumuz ve sunucu saati. */
export interface LiveCtx {
  table: number;
  seat: number | null;
  me(): number;
  now(): number;
}

export interface LiveSeatChip {
  name: string;
  /** Bu turdaki bahis (0: yok). */
  bet: number;
  me: boolean;
  /** Kazanç (sonuçta): artı ise yeşil. */
  won?: number;
  active?: boolean;
  /** Bahis süresinde "hazır". */
  ready?: boolean;
}

const R = 21, C = 2 * Math.PI * R;

export class LiveBar {
  readonly el = document.createElement("div");
  private banner = document.createElement("div");
  private sub = document.createElement("small");
  private timer = document.createElement("div");
  private secs = document.createElement("b");
  private arc: SVGCircleElement;
  private seatsEl = document.createElement("div");
  private watchEl = document.createElement("span");
  private endsAt = 0;
  private span = 1;
  private raf = 0;
  private lastSec = -1;

  constructor(private live: LiveCtx) {
    this.el.className = "cz-livebar";
    const badge = document.createElement("span");
    badge.className = "cz-livebadge";
    badge.innerHTML = "<i></i>CANLI";
    this.watchEl.className = "cz-watching";
    const left = document.createElement("div");
    left.className = "cz-liveleft";
    left.append(badge, this.watchEl);
    const mid = document.createElement("div");
    mid.className = "cz-banner";
    mid.append(this.banner, this.sub);
    this.timer.className = "cz-timer";
    this.timer.innerHTML = `<svg viewBox="0 0 50 50"><circle class="bg" cx="25" cy="25" r="${R}"/><circle class="fg" cx="25" cy="25" r="${R}" stroke-dasharray="${C}"/></svg>`;
    this.arc = this.timer.querySelector(".fg")!;
    this.timer.append(this.secs);
    this.seatsEl.className = "cz-liveseats";
    this.el.append(left, mid, this.timer, this.seatsEl);
    this.watchEl.textContent = live.seat === null ? "👀 İzliyorsun" : `🪑 ${live.seat + 1}. koltuk`;
    const loop = () => {
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }

  /** Durum metni ve rengi (bet: yeşil, closed: kırmızı, info: altın). */
  status(text: string, sub: string, tone: "bet" | "closed" | "info" | "win"): void {
    this.banner.textContent = text;
    this.sub.textContent = sub;
    this.el.dataset.tone = tone;
  }

  /** Geri sayım: `endsAt` sunucu saati, `span` fazın toplam süresi; 0 gizler. */
  countdown(endsAt: number, span: number): void {
    this.endsAt = endsAt;
    this.span = Math.max(1, span);
    this.lastSec = -1;
    this.frame();
  }

  seats(list: (LiveSeatChip | null)[]): void {
    this.seatsEl.replaceChildren(
      ...list.map((s, i) => {
        const d = document.createElement("div");
        d.className = `cz-lseat${s ? "" : " empty"}${s?.me ? " me" : ""}${s?.active ? " active" : ""}${s?.won ? " won" : ""}${s?.ready ? " ready" : ""}`;
        const n = document.createElement("span");
        n.className = "cz-lseatn";
        n.textContent = String(i + 1);
        const name = document.createElement("b");
        name.textContent = s ? `${s.ready ? "✓ " : ""}${s.name}` : "Boş";
        const bet = document.createElement("small");
        bet.textContent = !s ? "" : s.won ? `+${fmt(s.won)}` : s.bet ? fmt(s.bet) : "—";
        d.append(n, name, bet);
        return d;
      }),
    );
  }

  private frame(): void {
    const left = this.endsAt ? this.endsAt - this.live.now() : 0;
    const on = left > 0;
    this.timer.classList.toggle("show", on);
    if (!on) return;
    const f = Math.max(0, Math.min(1, left / this.span));
    this.arc.style.strokeDashoffset = String(C * (1 - f));
    const sec = Math.ceil(left / 1000);
    if (sec !== this.lastSec) {
      this.lastSec = sec;
      this.secs.textContent = String(sec);
      this.timer.classList.toggle("hurry", sec <= 3);
    }
  }
}
