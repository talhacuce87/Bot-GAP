// Blackjack ekranı: çiple bahis, dağıt; kart çek / dur / ikiye katla / böl. Yeni kartlar kayarak gelir;
// el bitince krupiyenin kapalı kartı döner ve çektiği kartlar tek tek düşer, sonra sonuç ve ödeme.
import { type BjView, type Card, handValue, MAX_BET, MIN_BET } from "../../../../shared/casino";
import { sfx } from "../sfx";
import { type CasinoCtx, type CasinoEvent, fmt, type GameView } from "./casinoUi";

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const CHIPS = [10, 25, 100, 500, 1000];
/** Kartlar arası dağıtma aralığı ve krupiye kartları arası bekleme (ms). */
const DEAL_GAP = 140;
const DEALER_GAP = 560;

export function cardEl(c: Card | null, anim: "" | "deal" | "flip", delay = 0): HTMLElement {
  const el = document.createElement("div");
  if (!c) el.className = "cz-card back";
  else {
    el.className = `cz-card${c.s === 1 || c.s === 2 ? " red" : ""}`;
    const r = RANKS[c.r], s = SUITS[c.s];
    el.innerHTML = `<span class="cz-corner">${r}<i>${s}</i></span><span class="cz-pip${c.r > 10 ? " face" : ""}">${c.r > 10 ? r : s}</span><span class="cz-corner cz-flip">${r}<i>${s}</i></span>`;
  }
  if (anim) {
    el.classList.add(anim);
    el.style.animationDelay = `${delay}ms`;
    window.setTimeout(() => sfx.card(), delay);
  }
  return el;
}

/** El değeri metni: yumuşaksa "7/17". */
export function valueText(cards: Card[]): string {
  const v = handValue(cards);
  return v.soft && v.total < 21 ? `${v.total - 10}/${v.total}` : String(v.total);
}

const RESULT = { blackjack: "BLACKJACK!", win: "KAZANDIN", push: "BERABERE", lose: "KAYBETTİN", bust: "PATLADIN" } as const;

type Phase = "bet" | "play" | "reveal" | "done";

export class BlackjackView implements GameView {
  readonly el = document.createElement("div");
  private dealerEl: HTMLDivElement;
  private dealerVal: HTMLDivElement;
  private handsEl: HTMLDivElement;
  private msgEl: HTMLDivElement;
  private ctrl: HTMLDivElement;
  private bet = 100;
  private state: BjView | null = null;
  private phase: Phase = "bet";
  /** Ekranda gösterilen kart sayıları: yalnızca yeni kartlar kayarak gelir. */
  private shownDealer = 0;
  private shownHands: number[] = [];
  private holeShown = false;
  /** El biterken açılmış krupiye kartı sayısı. */
  private revealed = 0;
  private pending = false;
  private timers: number[] = [];

  constructor(private ctx: CasinoCtx) {
    this.el.className = "cz-bj";
    const felt = document.createElement("div");
    felt.className = "cz-felt";
    const dealer = document.createElement("div");
    dealer.className = "cz-dealer";
    this.dealerVal = document.createElement("div");
    this.dealerVal.className = "cz-val";
    this.dealerEl = document.createElement("div");
    this.dealerEl.className = "cz-cards";
    const label = document.createElement("div");
    label.className = "cz-label";
    label.textContent = "KRUPİYE";
    dealer.append(label, this.dealerEl, this.dealerVal);
    const rules = document.createElement("div");
    rules.className = "cz-rules";
    rules.innerHTML = "<b>BLACKJACK 3:2 ÖDER</b><span>Krupiye 17'de durur · 6 deste · Sigorta yok</span>";
    this.msgEl = document.createElement("div");
    this.msgEl.className = "cz-msg";
    this.handsEl = document.createElement("div");
    this.handsEl.className = "cz-hands";
    felt.append(dealer, rules, this.msgEl, this.handsEl);
    this.ctrl = document.createElement("div");
    this.ctrl.className = "cz-ctrl";
    this.el.append(felt, this.ctrl);
    this.render();
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  refresh(): void {
    this.renderControls();
  }

  failed(): void {
    this.pending = false;
    if (this.phase === "bet" && this.state) this.phase = "done";
    this.render();
  }

  event(ev: CasinoEvent): void {
    if (ev.t !== "bj") return;
    this.pending = false;
    const prev = this.state;
    const fresh = !prev || this.phase === "bet" || this.phase === "done";
    if (fresh) {
      for (const t of this.timers) clearTimeout(t);
      this.timers = [];
      this.shownDealer = 0;
      this.shownHands = [];
      this.holeShown = false;
    } else if (prev && ev.view.hands.length > prev.hands.length) {
      // Bölme: iki elde de ilk kart zaten masada, yalnızca yeni ikinci kartlar gelsin
      this.shownHands.splice(prev.active, 1, 1, 1);
    }
    this.state = ev.view;
    if (ev.view.shuffled) this.ctx.toast("🃏 Krupiye desteyi karıştırdı");
    if (ev.view.phase === "player") {
      this.phase = "play";
      this.ctx.setBalance(ev.balance);
      this.render();
      return;
    }
    // El bitti: kapalı kart döner, krupiyenin çektikleri tek tek gelir, sonra sonuç ve ödeme
    this.phase = "reveal";
    this.revealed = 1;
    this.render();
    let at = fresh ? 4 * DEAL_GAP + 300 : 420;
    for (let i = 1; i < ev.view.dealer.length; i++) {
      this.later(at, () => {
        this.revealed = i + 1;
        this.render();
      });
      at += DEALER_GAP;
    }
    this.later(at, () => {
      this.phase = "done";
      this.ctx.setBalance(ev.balance);
      const won = ev.view.hands.some((h) => (h.payout ?? 0) > h.bet);
      if (won) sfx.win(ev.view.hands.some((h) => h.result === "blackjack"));
      this.render();
    });
  }

  key(code: string): boolean {
    if (this.phase === "play") {
      if (code === "KeyH") return this.act("hit");
      if (code === "KeyS") return this.act("stand");
      if (code === "KeyD") return this.canDouble() && this.act("double");
      if (code === "KeyP") return this.canSplit() && this.act("split");
    }
    if ((this.phase === "bet" || this.phase === "done") && code === "Space") {
      this.deal();
      return true;
    }
    return false;
  }

  private later(ms: number, f: () => void): void {
    this.timers.push(window.setTimeout(f, ms));
  }

  private act(op: "hit" | "stand" | "double" | "split"): boolean {
    if (this.pending) return true;
    this.pending = true;
    this.ctx.send({ t: "bj", op });
    this.renderControls();
    return true;
  }

  private deal(): void {
    if (this.pending) return;
    if (this.bet < MIN_BET) return this.ctx.toast(`🪙 Önce çiplerle bahis koy (en az ${MIN_BET}).`);
    if (this.bet > this.ctx.balance()) return this.ctx.toast("💰 Bakiyen bu bahse yetmiyor.");
    this.pending = true;
    this.phase = "bet";
    this.ctx.send({ t: "bj", op: "deal", bet: this.bet });
    this.renderControls();
  }

  private activeBet(): number {
    const s = this.state;
    return s ? s.hands[s.active]?.bet ?? 0 : 0;
  }
  private canDouble(): boolean {
    return !!this.state?.canDouble && this.ctx.balance() >= this.activeBet();
  }
  private canSplit(): boolean {
    return !!this.state?.canSplit && this.ctx.balance() >= this.activeBet();
  }

  /** Krupiyenin ekrandaki kartları: el biterken açılanlar, açılmamış kapalı kart sırtı. */
  private dealerCards(s: BjView): (Card | null)[] {
    if (this.phase !== "reveal") return s.dealer;
    const out: (Card | null)[] = s.dealer.slice(0, this.revealed);
    if (out.length < 2) out.push(null);
    return out;
  }

  private render(): void {
    const s = this.state;
    this.dealerEl.replaceChildren();
    this.handsEl.replaceChildren();
    this.dealerVal.textContent = "";
    if (s) {
      // Dağıtma sırası: oyuncu, krupiye, oyuncu, krupiye (kapalı)
      const cards = this.dealerCards(s);
      const first = this.shownDealer === 0;
      cards.forEach((c, i) => {
        const anim = i >= this.shownDealer ? "deal" : i === 1 && c && !this.holeShown ? "flip" : "";
        const delay = first ? (i * 2 + 1) * DEAL_GAP : 0;
        this.dealerEl.append(cardEl(c, anim, anim ? delay : 0));
      });
      this.shownDealer = cards.length;
      this.holeShown = !!cards[1];
      const visible = cards.filter((c): c is Card => !!c);
      const dv = handValue(visible).total;
      this.dealerVal.textContent = visible.length ? valueText(visible) : "";
      this.dealerVal.className = `cz-val${dv > 21 ? " bust" : ""}`;

      const done = this.phase === "done";
      s.hands.forEach((h, k) => {
        const box = document.createElement("div");
        box.className = `cz-hand${this.phase === "play" && k === s.active && s.hands.length > 1 ? " active" : ""}${done && h.result ? ` r-${h.result}` : ""}`;
        const row = document.createElement("div");
        row.className = "cz-cards";
        const seen = this.shownHands[k] ?? 0;
        h.cards.forEach((c, i) => row.append(cardEl(c, i >= seen ? "deal" : "", seen === 0 && i < 2 ? i * 2 * DEAL_GAP : (i - seen) * DEAL_GAP)));
        this.shownHands[k] = h.cards.length;
        const v = handValue(h.cards).total;
        const info = document.createElement("div");
        info.className = "cz-hinfo";
        const val = document.createElement("span");
        val.className = `cz-val${v > 21 ? " bust" : v === 21 ? " best" : ""}`;
        val.textContent = valueText(h.cards);
        const chip = document.createElement("span");
        chip.className = "cz-stake";
        chip.textContent = `${fmt(h.bet)}${h.doubled ? " · ×2" : ""}`;
        info.append(val, chip);
        if (done && h.result) {
          const net = (h.payout ?? 0) - h.bet;
          const res = document.createElement("b");
          res.className = "cz-res";
          res.textContent = `${RESULT[h.result]}${net > 0 ? ` +${fmt(net)}` : net < 0 ? ` −${fmt(-net)}` : ""}`;
          info.append(res);
        }
        box.append(row, info);
        this.handsEl.append(box);
      });
    }
    this.renderMessage();
    this.renderControls();
  }

  private renderMessage(): void {
    const s = this.state;
    let msg = "Çiplerle bahsini koy, DAĞIT'a bas", cls = "";
    if (this.phase === "bet" && this.pending) msg = "Kartlar dağıtılıyor…";
    else if (this.phase === "play" && s) {
      const v = handValue(s.hands[s.active].cards).total;
      msg = `${s.hands.length > 1 ? `${s.active + 1}. el: ` : ""}${v} · Kart çek ya da dur`;
    } else if (this.phase === "reveal") msg = "Krupiye kartını açıyor…";
    else if (this.phase === "done" && s) {
      const back = s.hands.reduce((a, h) => a + (h.payout ?? 0), 0), staked = s.hands.reduce((a, h) => a + h.bet, 0);
      const bj = s.hands.some((h) => h.result === "blackjack");
      if (back > staked) [msg, cls] = [`${bj ? "🂡 BLACKJACK! " : "🎉 "}+${fmt(back - staked)} kazandın`, "win"];
      else if (back === staked) [msg, cls] = ["🤝 Berabere, bahsin geri döndü", "push"];
      else [msg, cls] = [`Kasa kazandı · −${fmt(staked - back)}`, "lose"];
    }
    this.msgEl.textContent = msg;
    this.msgEl.className = `cz-msg ${cls}`;
  }

  private button(parent: HTMLElement, label: string, key: string, cls: string, on: () => void, enabled = true): void {
    const b = document.createElement("button");
    b.className = `cz-btn ${cls}`;
    b.innerHTML = `<span>${label}</span><kbd>${key}</kbd>`;
    b.disabled = !enabled || this.pending;
    b.addEventListener("click", on);
    parent.append(b);
  }

  private renderControls(): void {
    const c = this.ctrl;
    c.replaceChildren();
    if (this.phase === "play") {
      this.button(c, "KART ÇEK", "H", "hit", () => this.act("hit"));
      this.button(c, "DUR", "S", "stand", () => this.act("stand"));
      this.button(c, "İKİYE KATLA", "D", "double", () => this.act("double"), this.canDouble());
      this.button(c, "BÖL", "P", "split", () => this.act("split"), this.canSplit());
      return;
    }
    if (this.phase === "reveal") {
      const wait = document.createElement("div");
      wait.className = "cz-wait";
      wait.textContent = "Krupiye oynuyor…";
      c.append(wait);
      return;
    }
    c.append(chipRow(CHIPS, (v) => this.addBet(v), (v) => this.addBet(-v)));
    const betBox = document.createElement("div");
    betBox.className = "cz-bet";
    betBox.innerHTML = `<small>BAHİS</small><b>${fmt(this.bet)}</b>`;
    const clear = document.createElement("button");
    clear.className = "cz-mini";
    clear.textContent = "Sıfırla";
    clear.disabled = this.pending;
    clear.addEventListener("click", () => {
      this.bet = 0;
      this.renderControls();
    });
    betBox.append(clear);
    c.append(betBox);
    const ok = this.bet >= MIN_BET && this.bet <= this.ctx.balance();
    this.button(c, this.phase === "done" ? "TEKRAR DAĞIT" : "DAĞIT", "Space", "deal", () => this.deal(), ok);
  }

  private addBet(v: number): void {
    if (this.pending) return;
    const next = Math.max(0, Math.min(MAX_BET, this.bet + v));
    if (v > 0 && next > this.ctx.balance()) return this.ctx.toast("💰 Bakiyen bu kadarına yetmiyor.");
    this.bet = next;
    sfx.chip();
    this.renderControls();
  }
}

/** Çip sırası: tıkla ekle, sağ tıkla çıkar. */
export function chipRow(values: number[], add: (v: number) => void, remove: (v: number) => void, selected?: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "cz-chips";
  for (const v of values) {
    const b = document.createElement("button");
    b.className = `cz-chipbtn c${v}${selected === v ? " sel" : ""}`;
    b.textContent = v >= 1000 ? `${v / 1000}K` : String(v);
    b.title = selected === undefined ? `Tıkla: +${v} · Sağ tık: −${v}` : `${v}'lik çip`;
    b.addEventListener("click", () => add(v));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      remove(v);
    });
    row.append(b);
  }
  return row;
}
