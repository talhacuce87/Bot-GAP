// Canlı poker (Texas Hold'em, oyuncular birbirine karşı): oval masa, kendi koltuğun hep altta ortada. Ortada
// ortak kartlar ve pot; koltuklarda isim, yığın, son hamle, bahis çipi, D/SB/BB işaretleri; sırası gelenin
// çevresinde süre halkası. Sıra sendeyse PAS / CHECK-CALL / RAISE (kaydırıcı ve ½ pot, pot, all-in). Showdown'da
// açılan eller ve kazananlar. Parası biten masaya yeniden para ekler.
import type { Card } from "../../../../shared/casino";
import { bestScore, handName, POKER, type PokerTableView } from "../../../../shared/poker";
import { sfx } from "../sfx";
import { cardEl } from "./blackjackView";
import { type CasinoCtx, type CasinoEvent, fmt, type GameView } from "./casinoUi";
import { chipEl } from "./chips";
import { LiveBar, type LiveCtx } from "./liveBar";

const PHASE_TR = { preflop: "PREFLOP", flop: "FLOP", turn: "TURN", river: "RIVER" } as const;

export class LivePokerView implements GameView {
  readonly el = document.createElement("div");
  private bar: LiveBar;
  private felt = document.createElement("div");
  private boardEl = document.createElement("div");
  private potEl = document.createElement("div");
  private seatsEl = document.createElement("div");
  private ctrl = document.createElement("div");
  private s: PokerTableView | null = null;
  private raiseTo = 0;
  private pending = false;
  private shownBoard = 0;
  private shownHand = -1;
  private paidHand = -1;
  private timer = 0;

  constructor(private ctx: CasinoCtx, private live: LiveCtx) {
    this.el.className = "cz-pk cz-live";
    this.bar = new LiveBar(live);
    this.felt.className = "cz-pkfelt";
    const mid = document.createElement("div");
    mid.className = "cz-pkmid";
    this.boardEl.className = "cz-cards cz-pkboard";
    this.potEl.className = "cz-pkpot";
    mid.append(this.potEl, this.boardEl);
    this.seatsEl.className = "cz-pkseats";
    this.felt.append(mid, this.seatsEl);
    this.ctrl.className = "cz-ctrl cz-pkctrl";
    this.el.append(this.bar.el, this.felt, this.ctrl);
    this.bar.status("MASAYA BAĞLANILIYOR", "", "info");
    // Sıra halkası her saniye güncellensin
    this.timer = window.setInterval(() => this.renderSeats(), 1000);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.bar.dispose();
  }

  refresh(): void {
    this.renderControls();
  }

  failed(): void {
    this.pending = false;
    this.renderControls();
  }

  event(ev: CasinoEvent): void {
    if (ev.t !== "live" || ev.table.kind !== "poker") return;
    const prev = this.s, v = ev.table;
    this.pending = false;
    if (v.hand !== this.shownHand) {
      this.shownHand = v.hand;
      this.shownBoard = 0;
    }
    // Yeni hamle: çip sesi; sıra bana geldi: kısa uyarı
    if (prev && v.toAct >= 0 && v.toAct !== prev.toAct && this.mySeat(v) === v.toAct) sfx.chip();
    if (prev && v.toAct !== prev.toAct) this.raiseTo = 0;
    this.s = v;
    this.render();
    // Kazandım
    const me = this.mySeat(v);
    if (v.phase === "showdown" && me >= 0 && this.paidHand !== v.hand && v.winners.some((w) => w.seat === me)) {
      this.paidHand = v.hand;
      sfx.win(v.winners.find((w) => w.seat === me)!.amount >= 1000);
    }
  }

  key(code: string): boolean {
    if (!this.myTurn()) return false;
    if (code === "KeyF") return this.act("fold"), true;
    if (code === "KeyC") return this.act(this.toCall() > 0 ? "call" : "check"), true;
    if (code === "KeyR") return this.raise(), true;
    if (code === "KeyA") return this.act("allin"), true;
    return false;
  }

  // ---------------------------------------------------------------------------

  /** Benim koltuğum (oturmadıysam −1). */
  private mySeat(v = this.s): number {
    if (!v || this.live.seat === null) return -1;
    return v.seats[this.live.seat]?.sid === this.live.me() ? this.live.seat : -1;
  }
  private myTurn(): boolean {
    const me = this.mySeat();
    return me >= 0 && this.s!.toAct === me;
  }
  private toCall(): number {
    const v = this.s!, me = v.seats[this.mySeat()];
    return me ? Math.max(0, Math.min(v.currentBet - me.bet, me.stack)) : 0;
  }
  /** Raise sınırları: en az (bu turda toplam) ve en çok (all-in). */
  private raiseRange(): [number, number] {
    const v = this.s!, me = v.seats[this.mySeat()]!;
    const max = me.bet + me.stack;
    return [Math.min(max, v.currentBet + v.minRaise), max];
  }

  private act(a: "fold" | "check" | "call" | "raise" | "allin", amount?: number): void {
    if (this.pending || !this.myTurn()) return;
    this.pending = true;
    sfx.chip();
    this.ctx.send({ t: "live", op: "act", a, amount });
    this.renderControls();
  }

  private raise(): void {
    const [min, max] = this.raiseRange();
    const to = Math.max(min, Math.min(max, this.raiseTo || min));
    this.act(to >= max ? "allin" : "raise", to);
  }

  // ---------------------------------------------------------------------------

  private render(): void {
    this.renderBar();
    this.renderBoard();
    this.renderSeats();
    this.renderControls();
  }

  private renderBar(): void {
    const v = this.s;
    if (!v) return;
    const bar = this.bar;
    const name = (i: number) => v.seats[i]?.name ?? "Oyuncu";
    if (v.phase === "idle") {
      bar.status("OYUNCU BEKLENİYOR", `El için en az ${v.need} oyuncu gerekli · masada ${v.ready}`, "info");
      bar.countdown(0, 1);
    } else if (v.phase === "start") {
      bar.status("YENİ EL BAŞLIYOR", `Körler ${v.blinds[0]}/${v.blinds[1]} · ${v.ready} oyuncu`, "bet");
      bar.countdown(v.endsAt, POKER.startMs);
    } else if (v.phase === "showdown") {
      const w = v.winners.map((x) => `${name(x.seat)} +${fmt(x.amount)}${x.best ? ` (${x.best})` : ""}`).join(" · ");
      bar.status(v.winners.length > 1 ? "POT BÖLÜŞÜLDÜ" : `${name(v.winners[0]?.seat ?? 0).toUpperCase()} KAZANDI`, w, "win");
      bar.countdown(v.endsAt, POKER.showMs);
    } else {
      const me = this.myTurn();
      bar.status(me ? "SIRA SENDE" : `${name(v.toAct).toUpperCase()} DÜŞÜNÜYOR`, `${PHASE_TR[v.phase]} · el #${v.hand} · körler ${v.blinds[0]}/${v.blinds[1]}`, me ? "bet" : "closed");
      bar.countdown(v.turnEndsAt, POKER.turnMs);
    }
    bar.seats(v.seats.map((x, i) => x && { name: x.name, bet: x.stack, me: i === this.mySeat(), won: x.won, active: v.toAct === i }));
  }

  private renderBoard(): void {
    const v = this.s!;
    this.boardEl.replaceChildren(
      ...v.board.map((c, i) => cardEl(c, i >= this.shownBoard ? "deal" : "", (i - this.shownBoard) * 160)),
      // Boş yerler (5 kartlık)
      ...Array.from({ length: 5 - v.board.length }, () => {
        const e = document.createElement("div");
        e.className = "cz-card cz-pkslot";
        return e;
      }),
    );
    this.shownBoard = v.board.length;
    this.potEl.innerHTML = v.pot ? `<small>POT</small><b>${fmt(v.pot)}</b>` : `<small>KÖRLER</small><b>${v.blinds[0]}/${v.blinds[1]}</b>`;
  }

  private renderSeats(): void {
    const v = this.s;
    if (!v) return;
    const n = v.seats.length, me = this.mySeat(v);
    // Kendi koltuğum altta ortada; izleyende 0. koltuk altta
    const base = me >= 0 ? me : 0;
    const out: HTMLElement[] = [];
    v.seats.forEach((s, i) => {
      const d = (i - base + n) % n, th = Math.PI / 2 + (d * 2 * Math.PI) / n;
      const box = document.createElement("div");
      const won = v.phase === "showdown" && s && s.won > 0;
      box.className = `cz-pkseat${s ? "" : " empty"}${i === me ? " me" : ""}${v.toAct === i ? " active" : ""}${s?.folded ? " folded" : ""}${won ? " won" : ""}`;
      const x = 50 + Math.cos(th) * 42, y = 50 + Math.sin(th) * 35;
      box.style.left = `${x}%`;
      box.style.top = `${y}%`;
      if (!s) {
        box.innerHTML = `<span class="cz-pkname">Boş koltuk</span>`;
        out.push(box);
        return;
      }
      // Kartlar
      const cards = document.createElement("div");
      cards.className = "cz-cards cz-pkcards";
      const own = i === me;
      for (const card of s.cards) cards.append(cardEl(card, "", 0));
      if (own) cards.classList.add("own");
      // İsim, yığın, son hamle
      const info = document.createElement("div");
      info.className = "cz-pkinfo";
      const tags = [i === v.button ? "D" : "", i === v.sbSeat && v.phase !== "idle" && v.phase !== "start" ? "SB" : "", i === v.bbSeat && v.phase !== "idle" && v.phase !== "start" ? "BB" : ""].filter(Boolean);
      info.innerHTML = `<span class="cz-pkname"></span><b>${fmt(s.stack)}</b>`;
      info.querySelector(".cz-pkname")!.textContent = s.gone ? `${s.name} (ayrıldı)` : own ? `${s.name} (sen)` : s.name;
      for (const t of tags) {
        const tg = document.createElement("i");
        tg.className = `cz-pktag ${t === "D" ? "dealer" : ""}`;
        tg.textContent = t;
        info.append(tg);
      }
      box.append(cards, info);
      if (s.action || won || s.best) {
        const a = document.createElement("em");
        a.className = `cz-pkact${won ? " win" : ""}`;
        a.textContent = won ? `+${fmt(s.won)}${s.best ? ` · ${s.best}` : ""}` : s.best ?? s.action ?? "";
        box.append(a);
      }
      // Sıra halkası
      if (v.toAct === i) {
        const left = Math.max(0, v.turnEndsAt - this.live.now());
        const ring = document.createElement("i");
        ring.className = "cz-pkturn";
        ring.style.setProperty("--p", String(left / POKER.turnMs));
        box.append(ring);
      }
      out.push(box);
      // Bahis çipi: koltukla masa ortası arasında
      if (s.bet > 0) {
        const chip = chipEl(s.bet, "cz-pkbet");
        chip.style.left = `${50 + Math.cos(th) * 27}%`;
        chip.style.top = `${50 + Math.sin(th) * 24}%`;
        out.push(chip);
      }
    });
    this.seatsEl.replaceChildren(...out);
  }

  private note(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "cz-wait";
    d.textContent = text;
    return d;
  }

  private button(label: string, key: string, cls: string, on: () => void, enabled = true): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = `cz-btn ${cls}`;
    b.innerHTML = `<span>${label}</span><kbd>${key}</kbd>`;
    b.disabled = !enabled || this.pending;
    b.addEventListener("click", on);
    return b;
  }

  private renderControls(): void {
    const c = this.ctrl, v = this.s;
    c.replaceChildren();
    if (!v) return;
    if (this.live.seat === null) {
      c.append(this.note(v.seats.some((x) => !x) ? "👀 İzliyorsun · oynamak için masadaki boş bir tabureye otur" : "👀 İzliyorsun · masa dolu"));
      return;
    }
    const me = this.mySeat(v), s = v.seats[me];
    if (!s) return;
    // Elimin gücü
    const strength = document.createElement("div");
    strength.className = "cz-pkhand";
    const mine = s.cards.filter((x): x is Card => !!x);
    if (mine.length === 2) {
      const sc = v.board.length >= 3 ? handName(bestScore([...mine, ...v.board])) : mine[0].r === mine[1].r ? "Cep çifti" : "Ön el";
      strength.innerHTML = `<small>ELİN</small><b>${sc}</b>`;
    }
    if (!this.myTurn()) {
      if (s.stack < v.blinds[1] && !s.inHand) {
        const add = Math.min(POKER.buyIn, POKER.maxBuyIn - s.stack);
        c.append(this.note("Paran bitti"), this.button(`MASAYA ${fmt(add)} EKLE`, "", "deal", () => {
          this.pending = true;
          this.ctx.send({ t: "live", op: "rebuy", amount: add });
          this.renderControls();
        }, this.ctx.balance() >= add));
      } else if (v.phase === "idle") c.append(this.note(`Oyuncu bekleniyor · ${v.ready}/${v.need} (en az ${v.need} kişiyle oynanır)`));
      else if (v.phase === "start") c.append(this.note("Yeni el başlıyor…"));
      else if (s.inHand && v.phase !== "showdown") c.append(this.note("Sıranı bekle…"));
      else if (v.phase !== "showdown") c.append(this.note("Bu elde yoksun · sonraki el başlayınca oynarsın"));
      if (mine.length) c.prepend(strength);
      return;
    }
    const toCall = this.toCall();
    const [min, max] = this.raiseRange();
    if (!this.raiseTo) this.raiseTo = min;
    const canRaise = max > v.currentBet;
    c.append(
      strength,
      this.button("PAS", "F", "stand", () => this.act("fold")),
      toCall > 0
        ? this.button(toCall >= s.stack ? `ALL-IN ${fmt(toCall)}` : `CALL ${fmt(toCall)}`, "C", "hit", () => this.act("call"))
        : this.button("CHECK", "C", "hit", () => this.act("check")),
    );
    if (canRaise) {
      const box = document.createElement("div");
      box.className = "cz-pkraise";
      const range = document.createElement("input");
      range.type = "range";
      range.min = String(min);
      range.max = String(max);
      range.step = String(v.blinds[0]);
      range.value = String(this.raiseTo);
      const verb = v.currentBet ? "RAISE" : "BET";
      const go = this.button(`${verb} ${fmt(this.raiseTo)}`, "R", "double", () => this.raise());
      const set = (to: number) => {
        this.raiseTo = Math.max(min, Math.min(max, Math.round(to)));
        range.value = String(this.raiseTo);
        go.querySelector("span")!.textContent = this.raiseTo >= max ? `ALL-IN ${fmt(max)}` : `${verb} ${fmt(this.raiseTo)}`;
      };
      range.addEventListener("input", () => set(Number(range.value)));
      const presets = document.createElement("div");
      presets.className = "cz-pkpresets";
      const after = v.pot + toCall;
      for (const [label, to] of [["Min", min], ["½ Pot", v.currentBet + after / 2], ["Pot", v.currentBet + after], ["All-in", max]] as [string, number][]) {
        const b = document.createElement("button");
        b.className = "cz-mini";
        b.textContent = label;
        b.addEventListener("click", () => set(to));
        presets.append(b);
      }
      set(this.raiseTo);
      box.append(presets, range);
      c.append(box, go);
    }
  }
}
