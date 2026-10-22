// Slot ekranı: altın çerçeveli makine, üç makara ve orta çizgi. Bahsi seç, ÇEVİR (Space). Durak sunucudan gelir;
// makaralar sırayla (soldan sağa) yavaşlayıp o simgede durur, kazanç orta çizgide parlar.
import { SLOT_BETS, SLOT_PAYS, SLOT_STRIP, SLOT_SYMBOLS, SLOT_TWO_CHERRIES } from "../../../../shared/casino";
import { sfx } from "../sfx";
import { type CasinoCtx, type CasinoEvent, fmt, type GameView } from "./casinoUi";

const L = SLOT_STRIP.length;
/** Şerit kaç kez tekrarlanır (dönüş mesafesi için). */
const REPEAT = 9;
/** Makaraların durma süreleri (ms) ve kaç tur döndükleri. */
const STOP_MS = [1300, 1800, 2300];
const LOOPS = [3, 4, 5];

function symbolHtml(i: number): string {
  const s = SLOT_SYMBOLS[i];
  return s === "7" ? '<b class="sym seven">7</b>' : s === "GAP" ? '<b class="sym gap">GAP</b>' : `<span class="sym">${s}</span>`;
}

export class SlotView implements GameView {
  readonly el = document.createElement("div");
  private reels: { strip: HTMLDivElement; box: HTMLDivElement; pos: number }[] = [];
  private winEl = document.createElement("div");
  private ctrl = document.createElement("div");
  private lamps = document.createElement("div");
  private bet = SLOT_BETS[1];
  private pending = false;
  private spinning = false;
  private timers: number[] = [];

  constructor(private ctx: CasinoCtx) {
    this.el.className = "cz-sl";
    const machine = document.createElement("div");
    machine.className = "cz-machine";
    this.lamps.className = "cz-lamps";
    for (let i = 0; i < 18; i++) this.lamps.append(document.createElement("i"));
    const marquee = document.createElement("div");
    marquee.className = "cz-marquee";
    marquee.innerHTML = "<b>GAP</b> SLOT";
    const windowEl = document.createElement("div");
    windowEl.className = "cz-window";
    for (let r = 0; r < 3; r++) {
      const box = document.createElement("div");
      box.className = "cz-reel";
      const strip = document.createElement("div");
      strip.className = "cz-strip";
      const cells: string[] = [];
      for (let k = 0; k < L * REPEAT; k++) cells.push(`<div class="cz-sym">${symbolHtml(SLOT_STRIP[k % L])}</div>`);
      strip.innerHTML = cells.join("");
      box.append(strip);
      windowEl.append(box);
      // Başlangıçta her makara farklı bir yerde
      const pos = L * 2 + ((r * 7 + 3) % L);
      this.reels.push({ strip, box, pos });
      this.place(r, pos, false);
    }
    const line = document.createElement("div");
    line.className = "cz-payline";
    windowEl.append(line);
    this.winEl.className = "cz-win";
    machine.append(this.lamps, marquee, windowEl, this.winEl);
    const side = document.createElement("div");
    side.className = "cz-paytable";
    const rows = SLOT_PAYS.map((p, i) => ({ p, i })).reverse();
    side.innerHTML =
      '<div class="cz-pt-title">ÖDEME TABLOSU</div>' +
      rows.map(({ p, i }) => `<div class="cz-pt-row">${symbolHtml(i).repeat(3)}<b>×${p}</b></div>`).join("") +
      `<div class="cz-pt-row">${symbolHtml(0).repeat(2)}<span class="sym any">?</span><b>×${SLOT_TWO_CHERRIES}</b></div>` +
      '<div class="cz-pt-note">Orta çizgide üçlü. Katlar bahsin katıdır.</div>';
    const left = document.createElement("div");
    left.className = "cz-slotmain";
    this.ctrl.className = "cz-ctrl";
    left.append(machine, this.ctrl);
    this.el.append(left, side);
    this.showWin(null);
    this.renderControls();
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  refresh(): void {
    this.renderControls();
  }

  failed(): void {
    this.pending = false;
    this.renderControls();
  }

  event(ev: CasinoEvent): void {
    if (ev.t !== "slot") return;
    this.pending = false;
    this.spinning = true;
    this.ctx.setBalance(ev.balance - ev.payout);
    this.showWin(null);
    this.el.classList.remove("won", "big");
    this.reels.forEach((reel, r) => {
      // Aynı simgeye denk gelen yukarıdaki bir konuma atla (geçişsiz), sonra aşağı doğru dönerek durağa in
      const start = (reel.pos % L) + L * (REPEAT - 2);
      this.place(r, start, false);
      const target = ev.stops[r] + L * (REPEAT - 2 - LOOPS[r]);
      void reel.strip.offsetHeight;
      reel.box.classList.add("spinning");
      this.place(r, target, true, STOP_MS[r]);
      this.later(STOP_MS[r] - 120, () => {
        reel.box.classList.remove("spinning");
        sfx.reel();
      });
    });
    this.later(STOP_MS[2] + 120, () => this.finish(ev));
    this.renderControls();
  }

  key(code: string): boolean {
    if (code === "Space") {
      this.spin();
      return true;
    }
    const i = SLOT_BETS.indexOf(this.bet);
    if (code === "ArrowUp" || code === "ArrowRight") return this.setBet(SLOT_BETS[Math.min(SLOT_BETS.length - 1, i + 1)]);
    if (code === "ArrowDown" || code === "ArrowLeft") return this.setBet(SLOT_BETS[Math.max(0, i - 1)]);
    return false;
  }

  private later(ms: number, f: () => void): void {
    this.timers.push(window.setTimeout(f, ms));
  }

  /** Makarayı `pos` (şeritteki sıra, orta satırda görünen) konumuna getirir. */
  private place(r: number, pos: number, animate: boolean, ms = 0): void {
    const reel = this.reels[r];
    reel.pos = pos;
    reel.strip.style.transition = animate ? `transform ${ms}ms cubic-bezier(0.18, 0.7, 0.28, 1.04)` : "none";
    // Satır yüksekliği CSS'te (--row): kısa ekranda makaralar küçülür
    reel.strip.style.transform = `translateY(calc(${-(pos - 1)} * var(--row)))`;
  }

  private setBet(b: number): boolean {
    if (this.spinning || this.pending || b === this.bet) return true;
    this.bet = b;
    sfx.chip();
    this.renderControls();
    return true;
  }

  private spin(): void {
    if (this.spinning || this.pending) return;
    if (this.bet > this.ctx.balance()) return this.ctx.toast("💰 Bakiyen bu bahse yetmiyor.");
    this.pending = true;
    this.ctx.send({ t: "slot", bet: this.bet });
    this.renderControls();
  }

  private finish(ev: Extract<CasinoEvent, { t: "slot" }>): void {
    this.spinning = false;
    this.ctx.setBalance(ev.balance);
    if (ev.payout > 0) {
      const big = ev.mult >= 50;
      this.el.classList.add("won");
      this.el.classList.toggle("big", big);
      sfx.win(big);
      // Orta satırdaki simgeler parlar (iki kirazda yalnızca kirazlar)
      this.reels.forEach((reel) => {
        const cell = reel.strip.children[reel.pos] as HTMLElement | undefined;
        if (cell && (ev.mult >= 1 || SLOT_STRIP[reel.pos % L] === 0)) cell.classList.add("hit");
      });
      this.later(2600, () => {
        for (const reel of this.reels) for (const c of reel.strip.querySelectorAll(".hit")) c.classList.remove("hit");
        this.el.classList.remove("won", "big");
      });
    }
    this.showWin(ev.payout > 0 ? { payout: ev.payout, mult: ev.mult } : { payout: 0, mult: 0 });
    this.renderControls();
  }

  private showWin(w: { payout: number; mult: number } | null): void {
    if (!w) {
      this.winEl.className = "cz-win";
      this.winEl.innerHTML = this.spinning || this.pending ? "<span>İYİ ŞANSLAR!</span>" : "<span>ÇEVİR'E BAS</span>";
      return;
    }
    if (!w.payout) {
      this.winEl.className = "cz-win";
      this.winEl.innerHTML = "<span>Bu sefer olmadı</span>";
      return;
    }
    this.winEl.className = `cz-win on${w.mult >= 50 ? " big" : ""}`;
    this.winEl.innerHTML = `<small>${w.mult >= 300 ? "JACKPOT!" : w.mult >= 50 ? "BÜYÜK KAZANÇ!" : "KAZANÇ"}</small><b>+0</b><span>×${w.mult}</span>`;
    // Kazanç sayarak artar
    const b = this.winEl.querySelector("b")!;
    const t0 = performance.now(), dur = Math.min(1600, 500 + w.payout / 4);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      b.textContent = `+${fmt(w.payout * (1 - (1 - t) ** 2))}`;
      if (t < 1 && b.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private renderControls(): void {
    const c = this.ctrl;
    c.replaceChildren();
    const lock = this.spinning || this.pending;
    const bets = document.createElement("div");
    bets.className = "cz-chips select";
    for (const v of SLOT_BETS) {
      const b = document.createElement("button");
      b.className = `cz-chipbtn c${v >= 500 ? 500 : v >= 100 ? 100 : v >= 25 ? 25 : 10}${v === this.bet ? " sel" : ""}`;
      b.textContent = String(v);
      b.disabled = lock;
      b.addEventListener("click", () => this.setBet(v));
      bets.append(b);
    }
    const betBox = document.createElement("div");
    betBox.className = "cz-bet";
    betBox.innerHTML = `<small>BAHİS</small><b>${fmt(this.bet)}</b><small class="cz-dim">↑ ↓ ile değiştir</small>`;
    const spin = document.createElement("button");
    spin.className = "cz-btn deal cz-spin";
    spin.innerHTML = `<span>${this.spinning ? "DÖNÜYOR…" : "ÇEVİR"}</span><kbd>Space</kbd>`;
    spin.disabled = lock || this.bet > this.ctx.balance();
    spin.addEventListener("click", () => this.spin());
    c.append(bets, betBox, spin);
  }
}
