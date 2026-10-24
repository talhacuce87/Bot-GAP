// Canlı blackjack (Evolution tarzı): üstte krupiye, altta yay boyunca 7 koltuk. Bahis süresinde çip seçilir ve
// kendi koltuğundaki alana tıklanır: ortada ana bahis, solda Perfect Pairs, sağda 21+3 (her tık bir çip). Geri al,
// Temizle, x2 ve Tekrarla; bahisler sunucuya kendiliğinden gider. HAZIR (Space): masadaki herkes hazırsa süre
// beklenmeden dağıtılır; bahis değişince hazırlık düşer. Dağıtınca yan bahisler hemen sonuçlanır, krupiye
// As açtıysa sigorta sorulur, sonra sıra koltuktan koltuğa geçer (her oyuncuya karar süresi).
import { type Card, handValue, MAX_BET, PP_PAYS, T21_PAYS } from "../../../../shared/casino";
import { betTotal, type BjBets, type BlackjackTableView, LIVE_T, NO_BETS, SIDE_MAX } from "../../../../shared/liveCasino";
import { sfx } from "../sfx";
import { cardEl, chipRow, valueText } from "./blackjackView";
import { type CasinoCtx, type CasinoEvent, fmt, type GameView } from "./casinoUi";
import { betTools, CHIP_VALUES, chipEl } from "./chips";
import { LiveBar, type LiveCtx } from "./liveBar";

const RESULT = { blackjack: "BLACKJACK!", win: "KAZANDI", push: "BERABERE", lose: "KAYBETTİ", bust: "PATLADI" } as const;
const PAIR_TR = { perfect: "PERFECT PAIR", coloured: "RENKLİ ÇİFT", mixed: "KARIŞIK ÇİFT" } as const;
const T21_TR = { suitedTrips: "RENKLİ ÜÇLÜ", straightFlush: "SIRALI RENK", trips: "ÜÇLÜ", straight: "KENT", flush: "RENK" } as const;
type Spot = keyof BjBets;
const SPOT_MAX: Record<Spot, number> = { main: MAX_BET, pp: SIDE_MAX, t21: SIDE_MAX };

export class LiveBlackjackView implements GameView {
  readonly el = document.createElement("div");
  private bar: LiveBar;
  private dealerEl = document.createElement("div");
  private dealerVal = document.createElement("div");
  private seatsEl = document.createElement("div");
  private ctrl = document.createElement("div");
  private s: BlackjackTableView | null = null;
  private chip = 25;
  /** Koltuğumuza konan bahisler (sunucuya kısa bir beklemeyle gider), geri alma yığını ve önceki elin bahisleri. */
  private local: BjBets = { ...NO_BETS };
  private undoStack: BjBets[] = [];
  private lastRound: BjBets | null = null;
  private sendTimer = 0;
  private pending = false;
  /** Sigortayı geri çevirdik (bu el). */
  private declined = false;
  /** Ekranda gösterilen kart sayıları (yalnızca yeni kartlar kayarak gelir). */
  private shownHands: number[] = [];
  private shownDealer = 0;
  private holeShown = false;
  private revealed = 0;
  private timer = 0;
  private paid = false;
  /** Alanlarda gösterilen çip tutarları: yalnızca değişen çip düşerek gelir. */
  private shownBets = new Map<string, number>();

  constructor(private ctx: CasinoCtx, private live: LiveCtx) {
    this.el.className = "cz-bj cz-live";
    this.bar = new LiveBar(live);
    const felt = document.createElement("div");
    felt.className = "cz-felt cz-livefelt";
    const dealer = document.createElement("div");
    dealer.className = "cz-dealer";
    const label = document.createElement("div");
    label.className = "cz-label";
    label.textContent = "KRUPİYE";
    this.dealerEl.className = "cz-cards";
    this.dealerVal.className = "cz-val";
    dealer.append(label, this.dealerEl, this.dealerVal);
    const rules = document.createElement("div");
    rules.className = "cz-rules";
    rules.innerHTML = "<b>BLACKJACK 3:2 ÖDER · SİGORTA 2:1 ÖDER</b><span>Krupiye 17'de durur, 16'da çeker · 8 deste · Perfect Pairs 25:1 · 21+3 100:1</span>";
    this.seatsEl.className = "cz-bjseats";
    felt.append(dealer, rules, this.seatsEl);
    this.ctrl.className = "cz-ctrl";
    this.el.append(this.bar.el, felt, this.ctrl);
    this.bar.status("MASAYA BAĞLANILIYOR", "", "info");
    // Krupiye kartlarını açarken
    this.timer = window.setInterval(() => this.tick(), 120);
    this.render();
  }

  dispose(): void {
    clearInterval(this.timer);
    clearTimeout(this.sendTimer);
    this.bar.dispose();
  }

  refresh(): void {
    this.renderControls();
  }

  failed(): void {
    this.pending = false;
    // Sunucu bahsi almadı: masadaki hâline dön
    if (!this.sendTimer) this.local = { ...(this.mySeat()?.bets ?? NO_BETS) };
    this.render();
  }

  event(ev: CasinoEvent): void {
    if (ev.t !== "live" || ev.table.kind !== "blackjack") return;
    const prev = this.s;
    const v = ev.table;
    this.pending = false;
    const dealt = prev?.phase === "bet" && v.phase !== "bet";
    if (!prev || (v.phase === "bet" && prev.phase !== "bet") || dealt) {
      this.shownHands = [];
      this.shownDealer = 0;
      this.holeShown = false;
      this.paid = false;
      this.declined = false;
    } else if (prev && v.hands.length > prev.hands.length && prev.active >= 0) {
      // Bölme: iki elde de ilk kart zaten masada
      this.shownHands.splice(prev.active, 1, 1, 1);
    }
    if (v.phase === "bet") {
      if (prev && prev.phase !== "bet") {
        this.local = { ...NO_BETS };
        this.undoStack = [];
      } else if (!this.sendTimer) this.local = { ...(this.mineIn(v)?.bets ?? NO_BETS) };
    } else if (dealt) {
      clearTimeout(this.sendTimer);
      this.sendTimer = 0;
      const st = this.live.seat === null ? null : v.stakes[this.live.seat];
      if (st && this.mineIn(v)) this.lastRound = { main: st.main, pp: st.pp, t21: st.t21 };
      // Yan bahis kazancı
      if (st?.ppWin || st?.t21Win) sfx.win(false);
    }
    if (v.shuffled && dealt) this.ctx.toast("🃏 Krupiye desteyi karıştırdı");
    if (v.phase === "play" && prev?.phase === "play" && v.active !== prev.active && this.mine(v.active, v)) sfx.chip();
    this.s = v;
    this.render();
  }

  key(code: string): boolean {
    const s = this.s;
    if (!s || this.live.seat === null) return false;
    if (s.phase === "play" && this.myTurn()) {
      if (code === "KeyH") return this.act("hit");
      if (code === "KeyS") return this.act("stand");
      if (code === "KeyD") return s.canDouble && this.act("double");
      if (code === "KeyP") return s.canSplit && this.act("split");
    }
    if (s.phase === "insurance" && this.canInsure()) {
      if (code === "KeyI") return this.act("insure");
      if (code === "KeyN") return this.decline();
    }
    if (s.phase !== "bet") return false;
    const keys: Record<string, () => void> = {
      Backspace: () => this.undo(), Delete: () => this.clear(), KeyX: () => this.double(), KeyR: () => this.repeat(), Space: () => this.toggleReady(),
    };
    keys[code]?.();
    return !!keys[code];
  }

  // ---------------------------------------------------------------------------

  private mineIn(v: BlackjackTableView) {
    const s = this.live.seat === null ? null : v.seats[this.live.seat];
    return s && s.sid === this.live.me() ? s : null;
  }
  private mySeat() {
    return this.s ? this.mineIn(this.s) : null;
  }
  private mine(hand: number, s = this.s): boolean {
    const h = s?.hands[hand];
    return !!h && s!.seats[h.seat]?.sid === this.live.me();
  }
  private myTurn(): boolean {
    return !!this.s && this.s.active >= 0 && this.mine(this.s.active);
  }
  private myStake() {
    return this.live.seat === null || !this.mySeat() ? null : this.s?.stakes[this.live.seat] ?? null;
  }
  private canInsure(): boolean {
    const st = this.myStake();
    return this.s?.phase === "insurance" && !!st && !st.ins && !this.declined;
  }
  private canBet(): boolean {
    return this.s?.phase === "bet" && !!this.mySeat();
  }
  /** Bahislerimiz için kullanılabilir para: masada duran (sunucunun düştüğü) bahis de bizim. */
  private avail(): number {
    return this.ctx.balance() + betTotal(this.mySeat()?.bets ?? NO_BETS);
  }

  private act(op: "hit" | "stand" | "double" | "split" | "insure"): boolean {
    if (this.pending) return true;
    if (op === "insure" && this.ctx.balance() < (this.myStake()?.main ?? 0) / 2) {
      this.ctx.toast("💰 Bakiyen sigortaya yetmiyor.");
      return true;
    }
    this.pending = true;
    this.ctx.send({ t: "live", op: "act", a: op });
    this.renderControls();
    return true;
  }

  private decline(): boolean {
    this.declined = true;
    this.renderControls();
    return true;
  }

  /** Bahsi değiştir (geri alınabilir). */
  private setBets(next: BjBets, msg = "💰 Bakiyen bu kadarına yetmiyor."): void {
    if (!this.canBet()) return;
    if (betTotal(next) > this.avail()) return this.ctx.toast(msg);
    this.undoStack.push(this.local);
    this.apply(next);
  }

  /** Masadaki bahsi göster ve sunucuya gönder (çip tıklamaları birikerek). */
  private apply(next: BjBets): void {
    this.local = next;
    sfx.chip();
    // Yalnızca kendi alanlarımız ve alt çubuk: bütün masayı yeniden çizmek titretir
    const i = this.live.seat!;
    this.seatsEl.querySelector(`[data-seat="${i}"] .cz-bjspots`)?.replaceWith(this.spotsOf(i));
    this.renderControls();
    clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => {
      this.sendTimer = 0;
      if (this.s?.phase !== "bet") return;
      this.pending = true;
      this.ctx.send({ t: "live", op: "bet", bj: this.local });
    }, 300);
  }

  /** Hazır / değil: bekleyen bahis değişikliği de aynı mesajla gider. */
  private toggleReady(): void {
    const me = this.mySeat();
    if (!this.canBet() || !me || this.pending) return;
    clearTimeout(this.sendTimer);
    this.sendTimer = 0;
    this.pending = true;
    sfx.chip();
    this.ctx.send({ t: "live", op: "bet", bj: this.local, ready: !me.ready });
    this.renderControls();
  }

  /** Seçili çipi alana koy. */
  private add(spot: Spot): void {
    if (!this.canBet()) return;
    const cur = this.local[spot];
    if (cur >= SPOT_MAX[spot]) return this.ctx.toast(`🪙 Bu alanın sınırı ${fmt(SPOT_MAX[spot])}.`);
    if (spot !== "main" && !this.local.main) return this.ctx.toast("🃏 Yan bahis için önce ana bahis alanına çip koy.");
    this.setBets({ ...this.local, [spot]: Math.min(SPOT_MAX[spot], cur + this.chip) });
  }

  private undo(): void {
    if (!this.canBet() || !this.undoStack.length) return;
    const prev = this.undoStack[this.undoStack.length - 1];
    if (betTotal(prev) > this.avail()) return this.ctx.toast("💰 Bakiyen yetmiyor.");
    this.undoStack.pop();
    this.apply(prev);
  }

  private clear(): void {
    if (betTotal(this.local)) this.setBets({ ...NO_BETS });
  }

  private double(): void {
    const l = this.local;
    if (!betTotal(l)) return;
    this.setBets({ main: Math.min(MAX_BET, l.main * 2), pp: Math.min(SIDE_MAX, l.pp * 2), t21: Math.min(SIDE_MAX, l.t21 * 2) }, "💰 İkiye katlamaya bakiyen yetmiyor.");
  }

  private repeat(): void {
    if (this.lastRound && !betTotal(this.local)) this.setBets({ ...this.lastRound }, "💰 Önceki bahse bakiyen yetmiyor.");
  }

  // ---------------------------------------------------------------------------

  /** Krupiye kartlarını açarken: sunucunun ayırdığı sürede birer birer. */
  private tick(): void {
    const s = this.s;
    if (s?.phase !== "dealer") return;
    const start = s.endsAt - LIVE_T.bjDealerCard * Math.max(1, s.dealer.length - 1);
    const n = Math.min(s.dealer.length, 2 + Math.floor((this.live.now() - start) / LIVE_T.bjDealerCard));
    if (n !== this.revealed) this.render();
  }

  private dealerCards(s: BlackjackTableView): (Card | null)[] {
    if (s.phase !== "dealer") return s.dealer;
    const start = s.endsAt - LIVE_T.bjDealerCard * Math.max(1, s.dealer.length - 1);
    this.revealed = Math.max(2, Math.min(s.dealer.length, 2 + Math.floor((this.live.now() - start) / LIVE_T.bjDealerCard)));
    return s.dealer.slice(0, this.revealed);
  }

  private render(): void {
    const s = this.s;
    this.dealerEl.replaceChildren();
    this.dealerVal.textContent = "";
    this.renderBar();
    if (s) {
      const cards = this.dealerCards(s);
      cards.forEach((c, i) => {
        const anim = i >= this.shownDealer ? "deal" : i === 1 && c && !this.holeShown ? "flip" : "";
        this.dealerEl.append(cardEl(c, anim, 0));
      });
      this.shownDealer = cards.length;
      this.holeShown = !!cards[1];
      const vis = cards.filter((c): c is Card => !!c);
      if (vis.length) {
        const dv = handValue(vis).total;
        // El sürerken yumuşak el "7/17"; krupiye açınca tek sayı
        this.dealerVal.textContent = s.phase === "play" || s.phase === "insurance" ? valueText(vis) : String(dv);
        this.dealerVal.className = `cz-val${dv > 21 ? " bust" : ""}`;
      }
    }
    this.renderSeats();
    this.renderControls();
    if (s?.phase === "result" && !this.paid) {
      this.paid = true;
      const mine = s.hands.filter((h) => s.seats[h.seat]?.sid === this.live.me());
      if (mine.some((h) => (h.payout ?? 0) > h.bet)) sfx.win(mine.some((h) => h.result === "blackjack"));
    }
  }

  private renderBar(): void {
    const s = this.s;
    if (!s) return;
    const name = (i: number) => s.seats[s.hands[i]?.seat]?.name ?? "Oyuncu";
    if (s.phase === "idle") {
      this.bar.status("OYUNCU BEKLENİYOR", "Bir tabureye oturan olunca el başlar", "info");
      this.bar.countdown(0, 1);
    } else if (s.phase === "bet") {
      const seated = s.seats.filter((x) => x), ready = seated.filter((x) => x!.ready).length;
      this.bar.status("BAHİSLERİNİZİ YAPIN", ready ? `${ready}/${seated.length} oyuncu hazır · herkes hazır olunca dağıtılır` : "Çip seç, koltuğundaki alana tıkla · bitince HAZIR'a bas", "bet");
      this.bar.countdown(s.endsAt, LIVE_T.bjBet);
    } else if (s.phase === "insurance") {
      this.bar.status("SİGORTA?", "Krupiye As açtı · sigorta ana bahsin yarısı, 2:1 öder", "closed");
      this.bar.countdown(s.endsAt, LIVE_T.bjInsurance);
    } else if (s.phase === "play") {
      const me = this.myTurn();
      this.bar.status(me ? "SIRA SENDE" : `${name(s.active).toUpperCase()} OYNUYOR`, me ? "Kart çek, dur, ikiye katla ya da böl" : "Bahisler kapandı", me ? "bet" : "closed");
      this.bar.countdown(s.turnEndsAt, LIVE_T.bjTurn);
    } else if (s.phase === "dealer") {
      this.bar.status("KRUPİYE OYNUYOR", "Kartlar açılıyor", "closed");
      this.bar.countdown(0, 1);
    } else {
      const dv = handValue(s.dealer.filter((c): c is Card => !!c)).total;
      this.bar.status(dv > 21 ? "KRUPİYE PATLADI" : `KRUPİYE ${dv}`, "Yeni el birazdan", "win");
      this.bar.countdown(s.endsAt, LIVE_T.bjResult);
    }
    const won = (i: number) => {
      if (s.phase !== "result") return 0;
      const st = s.stakes[i];
      const mine = s.hands.filter((h) => h.seat === i);
      const back = mine.reduce((a, h) => a + (h.payout ?? 0), 0) + (st?.ppWin?.pay ?? 0) + (st?.t21Win?.pay ?? 0) + (st?.insWin ?? 0);
      const staked = mine.reduce((a, h) => a + h.bet, 0) + (st ? st.pp + st.t21 + st.ins : 0);
      return Math.max(0, back - staked);
    };
    const stake = (i: number) => (s.phase === "bet" ? betTotal(s.seats[i]?.bets ?? NO_BETS) : s.stakes[i] ? betTotal(s.stakes[i]!) : 0);
    this.bar.seats(s.seats.map((x, i) => x && { ready: s.phase === "bet" && x.ready, name: x.name, bet: stake(i), me: x.sid === this.live.me(), won: won(i), active: s.phase === "play" && s.hands[s.active]?.seat === i }));
  }

  private renderSeats(): void {
    const s = this.s;
    const out: HTMLElement[] = [];
    const n = s?.seats.length ?? 7;
    // Ekranda soldan sağa son koltuktan ilke (krupiye ilk koltuğa, kendi soluna, önce dağıtır)
    for (let i = n - 1; i >= 0; i--) {
      const seat = s?.seats[i] ?? null;
      const box = document.createElement("div");
      const me = !!seat && seat.sid === this.live.me();
      const active = !!s && s.phase === "play" && s.hands[s.active]?.seat === i;
      box.className = `cz-bjseat${seat ? "" : " empty"}${me ? " me" : ""}${active ? " active" : ""}`;
      // Masanın kavisi boyunca: 0. koltuk sağda, yüzü krupiyeye dönük
      const f = ((n - 1) / 2 - i) / ((n - 1) / 2), th = (f * 64 * Math.PI) / 180;
      box.dataset.seat = String(i);
      box.style.left = `${50 + Math.sin(th) * 43}%`;
      box.style.top = `${42 + Math.cos(th) * 50}%`;
      box.style.setProperty("--rot", `${-f * 16}deg`);
      box.append(this.handsOf(i), this.spotsOf(i), this.nameOf(i));
      out.push(box);
    }
    this.seatsEl.replaceChildren(...out);
  }

  private handsOf(i: number): HTMLElement {
    const s = this.s;
    const hands = document.createElement("div");
    hands.className = "cz-bjhands";
    if (!s) return hands;
    const active = s.phase === "play" && s.hands[s.active]?.seat === i;
    s.hands.forEach((h, k) => {
      if (h.seat !== i) return;
      const hb = document.createElement("div");
      const done = s.phase === "result" && h.result;
      hb.className = `cz-hand${active && k === s.active ? " active" : ""}${done ? ` r-${h.result}` : ""}`;
      const row = document.createElement("div");
      row.className = "cz-cards";
      const seen = this.shownHands[k] ?? 0;
      h.cards.forEach((c, j) => row.append(cardEl(c, j >= seen ? "deal" : "", (j - seen) * 120)));
      this.shownHands[k] = h.cards.length;
      const v = handValue(h.cards).total;
      const info = document.createElement("div");
      info.className = "cz-hinfo";
      info.innerHTML = `<span class="cz-val${v > 21 ? " bust" : v === 21 ? " best" : ""}">${valueText(h.cards)}</span>${h.doubled ? '<span class="cz-stake">×2</span>' : ""}`;
      if (done) {
        const net = (h.payout ?? 0) - h.bet;
        const r = document.createElement("b");
        r.className = "cz-res";
        r.textContent = `${RESULT[h.result!]}${net > 0 ? ` +${fmt(net)}` : ""}`;
        info.append(r);
      }
      hb.append(row, info);
      hands.append(hb);
    });
    return hands;
  }

  /** Koltuğun bahis alanları: Perfect Pairs · ana bahis · 21+3 (kendi koltuğumuzda bahis süresinde tıklanır). */
  private spotsOf(i: number): HTMLElement {
    const s = this.s;
    const wrap = document.createElement("div");
    wrap.className = "cz-bjspots";
    const seat = s?.seats[i] ?? null;
    const me = !!seat && seat.sid === this.live.me();
    const betting = s?.phase === "bet";
    const st = s && !betting ? s.stakes[i] : null;
    const bets: BjBets = betting ? (me ? this.local : seat?.bets ?? NO_BETS) : st ?? NO_BETS;
    const wins = document.createElement("div");
    wins.className = "cz-sidewins";
    const spot = (key: Spot, label: string, title: string) => {
      const b = document.createElement(me && betting ? "button" : "div");
      b.className = `cz-bjspot ${key}`;
      b.title = title;
      const lab = document.createElement("small");
      lab.textContent = label;
      b.append(lab);
      if (bets[key]) {
        const id = `${i}:${key}`;
        b.append(chipEl(bets[key], this.shownBets.get(id) !== bets[key] ? "drop" : ""));
        this.shownBets.set(id, bets[key]);
      } else this.shownBets.delete(`${i}:${key}`);
      // Yan bahis sonucu: kazanan parlar, kaybeden söner
      if (st && key !== "main" && bets[key]) {
        const win = key === "pp" ? st.ppWin : st.t21Win;
        b.classList.add(win ? "won" : "lost");
        if (win) {
          const t = document.createElement("em");
          t.textContent = `${key === "pp" ? PAIR_TR[st.ppWin!.kind] : T21_TR[st.t21Win!.kind]} +${fmt(win.pay - bets[key])}`;
          wins.append(t);
        }
      }
      if (key === "main" && st?.ins) {
        const ins = chipEl(st.ins, "ins");
        ins.title = `Sigorta ${fmt(st.ins)}`;
        b.append(ins);
      }
      if (me && betting) b.addEventListener("click", () => this.add(key));
      wrap.append(b);
    };
    spot("pp", "PP", `Perfect Pairs · ${PP_PAYS.perfect}:1 / ${PP_PAYS.coloured}:1 / ${PP_PAYS.mixed}:1`);
    spot("main", "", "Ana bahis");
    spot("t21", "21+3", `21+3 · renkli üçlü ${T21_PAYS.suitedTrips}:1 … renk ${T21_PAYS.flush}:1`);
    if (wins.childElementCount) wrap.append(wins);
    return wrap;
  }

  private nameOf(i: number): HTMLElement {
    const s = this.s;
    const seat = s?.seats[i] ?? null;
    const tag = document.createElement("div");
    tag.className = "cz-bjname";
    tag.textContent = seat ? (seat.sid === this.live.me() ? `${seat.name} (sen)` : seat.name) : "Boş koltuk";
    if (seat && s?.phase === "bet" && seat.ready) {
      tag.classList.add("ready");
      tag.prepend("✓ ");
    }
    if (s && s.phase === "play" && s.hands[s.active]?.seat === i) {
      const t = document.createElement("i");
      t.className = "cz-turnbar";
      const left = Math.max(0, s.turnEndsAt - this.live.now());
      t.style.animationDuration = `${left}ms`;
      t.style.setProperty("--from", String(left / LIVE_T.bjTurn));
      tag.append(t);
    }
    return tag;
  }

  private button(label: string, key: string, cls: string, on: () => void, enabled = true): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = `cz-btn ${cls}`;
    b.innerHTML = `<span>${label}</span><kbd>${key}</kbd>`;
    b.disabled = !enabled || this.pending;
    b.addEventListener("click", on);
    return b;
  }

  private note(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "cz-wait";
    d.textContent = text;
    return d;
  }

  private renderControls(): void {
    const c = this.ctrl;
    c.replaceChildren();
    const s = this.s;
    if (!s) return;
    if (this.live.seat === null) {
      const free = s.seats.some((x) => !x);
      c.append(this.note(free ? "👀 İzliyorsun · oynamak için masadaki boş bir tabureye otur" : "👀 İzliyorsun · masa dolu"));
      return;
    }
    if (s.phase === "insurance") {
      const st = this.myStake();
      if (this.canInsure()) {
        c.append(
          this.button(`SİGORTA AL · ${fmt(st!.main / 2)}`, "I", "double", () => this.act("insure"), this.ctx.balance() >= st!.main / 2),
          this.button("HAYIR", "N", "stand", () => this.decline()),
        );
      } else c.append(this.note(st?.ins ? `🛡️ Sigortalandı (${fmt(st.ins)}) · krupiye bakıyor…` : "Krupiye blackjack'e bakacak…"));
      return;
    }
    if (s.phase === "play") {
      if (!this.myTurn()) {
        const mine = s.hands.some((h) => s.seats[h.seat]?.sid === this.live.me());
        c.append(this.note(mine ? "Sıranı bekle…" : "Bu elde yoksun · sonraki elde bahis koy"));
        return;
      }
      const h = s.hands[s.active];
      const afford = this.ctx.balance() >= h.bet;
      c.append(
        this.button("KART ÇEK", "H", "hit", () => this.act("hit")),
        this.button("DUR", "S", "stand", () => this.act("stand")),
        this.button("İKİYE KATLA", "D", "double", () => this.act("double"), s.canDouble && afford),
        this.button("BÖL", "P", "split", () => this.act("split"), s.canSplit && afford),
      );
      return;
    }
    if (s.phase !== "bet") {
      c.append(this.note(s.phase === "dealer" ? "Krupiye oynuyor…" : s.phase === "result" ? "Yeni el birazdan başlıyor" : "Oyuncu bekleniyor…"));
      return;
    }
    // Bahis: çip seç, koltuktaki alanlara tıkla
    const chips = chipRow(CHIP_VALUES, (v) => {
      this.chip = v;
      sfx.chip();
      this.renderControls();
    }, () => {}, this.chip);
    chips.classList.add("select");
    const mine = betTotal(this.local), placed = betTotal(this.mySeat()?.bets ?? NO_BETS);
    const ready = !!this.mySeat()?.ready;
    const readyBtn = this.button(ready ? "HAZIR ✓ · İPTAL" : "HAZIR", "Space", `ready${ready ? " on" : ""}`, () => this.toggleReady(), !!this.mySeat());
    readyBtn.title = "Masadaki herkes hazır olunca kartlar beklemeden dağıtılır";
    const total = document.createElement("div");
    total.className = "cz-bet";
    total.innerHTML = `<small>${mine && placed === mine && !this.sendTimer ? "MASADA ✓" : "TOPLAM BAHİS"}</small><b>${fmt(mine)}</b>`;
    // Araçlar sağda: sol alt köşede sohbet kutusu durur
    c.append(
      chips,
      total,
      betTools({
        undo: () => this.undo(), clear: () => this.clear(), double: () => this.double(), repeat: () => this.repeat(),
        can: { undo: this.undoStack.length > 0, clear: mine > 0, double: mine > 0 && mine * 2 <= this.avail(), repeat: !!this.lastRound && !mine },
      }),
      readyBtn,
    );
  }
}
