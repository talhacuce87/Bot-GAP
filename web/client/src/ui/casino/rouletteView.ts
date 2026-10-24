// Rulet ekranı: solda Avrupa çarkı (canvas; çark bir yöne, top öbür yöne döner, yavaşlayıp cebe düşer), sağda
// bahis masası. Çip seç, hücreye tıkla (sağ tık geri alır), ÇEVİR. Sonuç sunucudan gelir; çark ona göre durur.
// Evolution'daki gibi sayıların arasındaki çizgilere/köşelere tıklayınca split, sıra, köşe ve altılı bahisleri; altta
// yarış pisti (çarktaki sıra): sayıya tıklayınca komşularıyla birlikte, bölümlere tıklayınca Tiers / Orphelins /
// Voisins / Zero ve Final bahisleri. Geri al, Temizle, x2, Tekrarla.
// Canlı masada ÇEVİR yok: bahis süresi bitince sunucu çevirir, herkesin çarkı aynı sayıda durur.
import { betNumbers, MAX_BET, numberColor, type RouletteBet, type RouletteKind, roulettePayout, rouletteWins, WHEEL } from "../../../../shared/casino";
import { LIVE_T, type RouletteTableView } from "../../../../shared/liveCasino";
import { sfx } from "../sfx";
import { chipRow } from "./blackjackView";
import { type CasinoCtx, type CasinoEvent, fmt, type GameView } from "./casinoUi";
import { CHIP_VALUES, chipTier, shortAmount } from "./chips";
import { LiveBar, type LiveCtx } from "./liveBar";

const CHIPS = CHIP_VALUES;
/** Masadaki tüm bahislerin üst sınırı (sunucuyla aynı). */
const TABLE_MAX = MAX_BET * 10;

// Yarış pisti: çarktaki sıra, oval üzerinde (üst sıra soldan sağa, sağ uçta 0, alt sıra sağdan sola, sol uçta 5 / 10)
const TRACK_TOP = [24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const TRACK_BOTTOM = [23, 8, 30, 11, 36, 13, 27, 6, 34, 17, 25, 2, 21, 4, 19, 15, 32];
/** Finale à cheval: iki rakamla biten komşu sayı çiftlerine split (eşi olmayan sayıya düz bahis). */
const A_CHEVAL: [string, [RouletteKind, number][]][] = [
  ["0/3", [["split", 3], ["split", 1013], ["split", 2023], ["split", 3033]]],
  ["1/4", [["split", 104], ["split", 1114], ["split", 2124], ["split", 3134]]],
  ["2/5", [["split", 205], ["split", 1215], ["split", 2225], ["split", 3235]]],
  ["3/6", [["split", 306], ["split", 1316], ["split", 2326], ["split", 3336]]],
  ["4/7", [["split", 407], ["split", 1417], ["split", 2427], ["n", 34]]],
  ["5/8", [["split", 508], ["split", 1518], ["split", 2528], ["n", 35]]],
  ["6/9", [["split", 609], ["split", 1619], ["split", 2629], ["n", 36]]],
  ["7/10", [["split", 710], ["split", 1720], ["split", 2730]]],
  ["8/11", [["split", 811], ["split", 1821], ["split", 2831]]],
  ["9/12", [["split", 912], ["split", 1922], ["split", 2932]]],
];
/** Masadaki tüm iç bahisler (tek sayı, split, sıra, köşe, altılı, trio, ilk dört). */
const ALL_INSIDE: [RouletteKind, number][] = (() => {
  const out: [RouletteKind, number][] = [];
  for (let n = 0; n <= 36; n++) out.push(["n", n]);
  for (let a = 0; a <= 36; a++) for (let b = a + 1; b <= 36; b++) if (betNumbers("split", a * 100 + b)) out.push(["split", a * 100 + b]);
  for (let v = 0; v <= 36; v++) for (const k of ["street", "corner", "line", "trio", "four"] as RouletteKind[]) if (betNumbers(k, v)) out.push([k, v]);
  return out;
})();
/** Tam bahis: sayıyı içeren her iç bahse kapsadığı sayı kadar çip (17 için 40 çip). */
const completeBet = (n: number): [RouletteKind, number, number][] =>
  ALL_INSIDE.map(([k, v]): [RouletteKind, number, number] => [k, v, betNumbers(k, v)!.length]).filter(([k, v]) => betNumbers(k, v)!.includes(n));
const OUTSIDE: [string, RouletteKind, number][] = [
  ["KIRMIZI", "red", 0], ["SİYAH", "black", 0], ["TEK", "odd", 0], ["ÇİFT", "even", 0], ["1–18", "low", 0], ["19–36", "high", 0],
  ["1. SÜTUN", "column", 1], ["1. DÜZİNE", "dozen", 1], ["2. SÜTUN", "column", 2], ["2. DÜZİNE", "dozen", 2], ["3. SÜTUN", "column", 3], ["3. DÜZİNE", "dozen", 3],
];
const FAV_KEY = "gap-rulet-favori";

/** Özel (anons) bahisler: masaya konan çipler [tür, değer, çip sayısı]. */
const SPECIAL: Record<"tiers" | "orphelins" | "voisins" | "zero", { label: string; title: string; chips: [RouletteKind, number, number][] }> = {
  tiers: {
    label: "TIER", title: "Tiers du Cylindre · 12 sayı, 6 çip (split)",
    chips: [["split", 508, 1], ["split", 1011, 1], ["split", 1316, 1], ["split", 2324, 1], ["split", 2730, 1], ["split", 3336, 1]],
  },
  orphelins: {
    label: "ORPHELINS", title: "Orphelins · 8 sayı, 5 çip",
    chips: [["n", 1, 1], ["split", 609, 1], ["split", 1417, 1], ["split", 1720, 1], ["split", 3134, 1]],
  },
  voisins: {
    label: "VOISINS", title: "Voisins du Zéro · 17 sayı, 9 çip",
    chips: [["trio", 2, 2], ["split", 407, 1], ["split", 1215, 1], ["split", 1821, 1], ["split", 1922, 1], ["split", 3235, 1], ["corner", 25, 2]],
  },
  zero: {
    label: "ZERO", title: "Jeu Zéro · 7 sayı, 4 çip",
    chips: [["split", 3, 1], ["split", 1215, 1], ["n", 26, 1], ["split", 3235, 1]],
  },
};
const SPIN_MS = 5200;
const TAU = Math.PI * 2;
const SEG = TAU / WHEEL.length;
const COLORS = { red: "#c8102e", black: "#16181d", green: "#0c8a43" } as const;
const COLOR_TR = { red: "KIRMIZI", black: "SİYAH", green: "YEŞİL" } as const;

const keyOf = (kind: RouletteKind, v: number) => `${kind}:${v}`;
function parseKey(k: string): { kind: RouletteKind; v: number } {
  const [kind, v] = k.split(":");
  return { kind: kind as RouletteKind, v: Number(v) };
}
const ease = (t: number, p = 3) => 1 - (1 - t) ** p;

export class RouletteView implements GameView {
  readonly el = document.createElement("div");
  private canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private size = 300;
  private board = document.createElement("div");
  /** Bahis yerleri: hücreler ve aralarındaki çizgi/köşe noktaları (anahtar "tür:değer"). */
  private cells = new Map<string, HTMLElement>();
  private track = document.createElement("div");
  private trackNums = new Map<number, HTMLElement>();
  /** Pistte sayıya tıklayınca her yanından kaç komşu. */
  private neighbours = 2;
  /** Geri alma: önceki masa durumları. */
  private undoStack: Map<string, number>[] = [];
  /** Immersive düzeni: alt çubuk (toplam bahis, araçlar), kazananlar/masadakiler, favori bahisler paneli. */
  private bottom = document.createElement("div");
  private winnersEl = document.createElement("div");
  private fav = document.createElement("div");
  /** İstatistik paneli: son çevirişlerden sıcak/soğuk sayılar ve dağılımlar. */
  private stats = document.createElement("div");
  private favTab: "fav" | "special" | "even" = "special";
  private ctrl = document.createElement("div");
  private resultEl = document.createElement("div");
  private historyEl = document.createElement("div");
  private bets = new Map<string, number>();
  private lastBets: [string, number][] = [];
  private chip = 25;
  private history: number[] = [];
  private pending = false;
  private spinning = false;
  // Çark ve top açıları (radyan), topun yarıçap oranı (1: dış kanal, 0: cep)
  private wheelA = 0;
  private ballA = 0;
  private ballR = 1;
  private landed: number | null = null;
  private spin: { t0: number; w0: number; w1: number; b0: number; b1: number; n: number; ev: Extract<CasinoEvent, { t: "roulette" }> } | null = null;
  private lastTickSeg = 0;
  private raf = 0;
  private last = performance.now();
  private timers: number[] = [];
  private spinMs = SPIN_MS;
  // Canlı masa: şerit, son görünüm, sunucuya geçmiş bahislerimiz ve gönderilmeyi bekleyen değişiklik
  private bar: LiveBar | null = null;
  private lv: RouletteTableView | null = null;
  private committed = 0;
  private sendTimer = 0;

  constructor(private ctx: CasinoCtx, private live: LiveCtx | null = null) {
    // Immersive düzeni: üstte eğik çark (ortasında durum ve süre), altında perspektifli masa; sağda geçmiş ve
    // pist; masanın altında çipler (GERİ AL · çipler · İKİYE KATLA); en altta toplam bahis ve ★ favori bahisler.
    this.el.className = "cz-rl cz-imm";
    const stage = document.createElement("div");
    stage.className = "cz-stage";
    this.canvas.className = "cz-wheel";
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = this.canvas.height = this.size * dpr;
    this.g = this.canvas.getContext("2d")!;
    this.g.scale(dpr, dpr);
    this.resultEl.className = "cz-result";
    this.historyEl.className = "cz-history";
    this.winnersEl.className = "cz-winners";
    stage.append(this.winnersEl, this.canvas, this.resultEl);
    const boardWrap = document.createElement("div");
    boardWrap.className = "cz-boardwrap";
    this.board.className = "cz-board";
    this.buildBoard();
    boardWrap.append(this.board);
    const side = document.createElement("div");
    side.className = "cz-rlside";
    this.track.className = "cz-track";
    this.buildTrack();
    side.append(this.historyEl, this.track);
    this.ctrl.className = "cz-ctrl";
    this.bottom.className = "cz-rlbottom";
    this.fav.className = "cz-fav";
    this.stats.className = "cz-fav cz-stats";
    this.el.append(stage, boardWrap, side, this.ctrl, this.bottom, this.fav, this.stats);
    if (live) {
      this.bar = new LiveBar(live);
      this.bar.status("MASAYA BAĞLANILIYOR", "", "info");
      this.el.classList.add("cz-live");
      stage.append(this.bar.el);
    }
    this.ballA = -Math.PI / 2;
    this.renderControls();
    this.renderResult();
    const loop = (now: number) => {
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const t of this.timers) clearTimeout(t);
    clearTimeout(this.sendTimer);
    this.bar?.dispose();
  }

  refresh(): void {
    this.renderControls();
  }

  failed(): void {
    this.pending = false;
    this.renderControls();
  }

  event(ev: CasinoEvent): void {
    if (ev.t === "live" && ev.table.kind === "roulette") return this.onLive(ev.table);
    if (ev.t !== "roulette") return;
    this.pending = false;
    this.startSpin(ev, SPIN_MS);
    // Bahis düşülsün; kazanç top durunca eklenir
    this.ctx.setBalance(ev.balance - ev.payout);
  }

  private startSpin(ev: Extract<CasinoEvent, { t: "roulette" }>, ms: number): void {
    this.spinning = true;
    this.spinMs = ms;
    this.clearWins();
    const i = WHEEL.indexOf(ev.n);
    const w0 = this.wheelA, w1 = w0 + TAU * 1.15;
    // Top öbür yöne ~4 tur atar ve cebin ortasına, çarkla birlikte oturur
    const pocket = w1 + i * SEG;
    const b0 = this.ballA;
    const b1 = pocket + TAU * Math.round((b0 - TAU * 4.2 - pocket) / TAU);
    this.landed = null;
    this.spin = { t0: performance.now(), w0, w1, b0, b1, n: ev.n, ev };
    this.renderControls();
    this.renderResult();
  }

  // -------------------------------------------------------------------------
  // Canlı masa

  private mine(v: RouletteTableView) {
    const s = this.live?.seat == null ? null : v.seats[this.live.seat];
    return s && s.sid === this.live!.me() ? s : null;
  }

  private canBet(): boolean {
    return !this.live || (this.live.seat !== null && this.lv?.phase === "bet");
  }

  /** Canlıda kullanılabilir para: masaya konmuş (sunucunun düştüğü) bahisler de bizim. */
  private avail(): number {
    return this.ctx.balance() + (this.live ? this.committed : 0);
  }

  private onLive(v: RouletteTableView): void {
    const prev = this.lv;
    this.lv = v;
    this.pending = false;
    const mine = this.mine(v);
    this.committed = mine ? mine.bets.reduce((a, b) => a + b.amount, 0) : 0;
    const serverBets = () => new Map((mine?.bets ?? []).map((b): [string, number] => [keyOf(b.kind, b.v), b.amount]));
    if (v.phase === "bet") {
      if (prev && prev.phase !== "bet") {
        // Yeni tur: masa temizlenir
        for (const b of this.cells.values()) b.classList.remove("win", "lose");
        this.bets.clear();
        this.undoStack = [];
        this.landed = null;
      } else if (!this.sendTimer) this.bets = serverBets();
      this.renderBets();
    } else if (v.phase === "spin" && v.n !== null && !this.spinning) {
      clearTimeout(this.sendTimer);
      this.sendTimer = 0;
      this.bets = serverBets();
      if (this.bets.size) this.lastBets = [...this.bets];
      this.renderBets();
      const bets = mine?.bets ?? [];
      // Çark sunucunun çark süresi içinde dursun (sonradan katılan kısa döner)
      const ms = v.endsAt - this.live!.now() - 250;
      const ev = { t: "roulette" as const, n: v.n, bets, payout: roulettePayout(bets, v.n), balance: this.ctx.balance() };
      if (ms > 900) this.startSpin(ev, Math.min(ms, LIVE_T.rlSpin));
      else this.finish(ev);
    } else if (v.phase === "result" && !this.spinning && v.n !== null && this.landed === null) {
      const bets = mine?.bets ?? [];
      this.bets = serverBets();
      this.finish({ t: "roulette", n: v.n, bets, payout: roulettePayout(bets, v.n), balance: this.ctx.balance() });
    }
    if (!this.spinning && this.history !== v.history) {
      this.history = v.history;
      if (this.stats.classList.contains("show")) this.renderStats();
    }
    this.renderLive();
    this.renderWinners();
    this.renderControls();
    if (!this.spinning) this.renderResult(this.landed === null ? undefined : mine?.payout ?? undefined, this.committed || undefined);
  }

  private renderLive(): void {
    const v = this.lv, bar = this.bar;
    if (!v || !bar) return;
    if (v.phase === "idle") {
      bar.status("OYUNCU BEKLENİYOR", "Bir tabureye oturan olunca tur başlar", "info");
      bar.countdown(0, 1);
    } else if (v.phase === "bet") {
      bar.status("BAHİSLERİNİZİ YAPIN", "Süre bitince çark döner", "bet");
      bar.countdown(v.endsAt, LIVE_T.rlBet);
    } else if (v.phase === "spin") {
      bar.status("BAHİSLER KAPANDI", "Top dönüyor…", "closed");
      bar.countdown(0, 1);
    } else {
      const n = v.n ?? 0;
      bar.status("KAZANAN SAYI " + n, COLOR_TR[numberColor(n)] + (n ? (n % 2 ? " · TEK" : " · ÇİFT") : "") + " · yeni tur birazdan", "win");
      bar.countdown(v.endsAt, LIVE_T.rlResult);
    }
    const me = this.live!.me();
    bar.seats(v.seats.map((s) => s && {
      name: s.name, me: s.sid === me, bet: s.bets.reduce((a, b) => a + b.amount, 0),
      won: v.phase === "result" && s.payout ? s.payout : 0,
    }));
  }

  /** Canlıda bahisler sunucuya kısa bir beklemeyle (çip tıklamaları birikerek) gider. */
  private sendBets(): void {
    if (!this.live) return;
    clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => {
      this.sendTimer = 0;
      if (this.lv?.phase !== "bet") return;
      this.ctx.send({ t: "live", op: "bet", bets: [...this.bets].map(([k, amount]) => ({ ...parseKey(k), amount })) });
    }, 350);
  }

  key(code: string): boolean {
    if (code === "Space" && this.live) return true;
    if (code === "Space") {
      this.spinNow();
      return true;
    }
    const keys: Record<string, () => void> = {
      KeyR: () => this.rebet(), Backspace: () => this.undo(), Delete: () => this.clearBets(), KeyX: () => this.double(),
    };
    keys[code]?.();
    return !!keys[code];
  }

  // -------------------------------------------------------------------------
  // Bahis masası

  private buildBoard(): void {
    const cell = (k: string, label: string, cls: string, col: string, row: string) => {
      const b = document.createElement("button");
      b.className = `cz-cell ${cls}`;
      b.style.gridColumn = col;
      b.style.gridRow = row;
      b.innerHTML = `<span>${label}</span>`;
      b.addEventListener("click", () => this.place(k, this.chip));
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.place(k, -this.chip);
      });
      const { kind, v } = parseKey(k);
      b.addEventListener("pointerenter", () => this.hover({ kind, v, amount: 0 }));
      b.addEventListener("pointerleave", () => this.hover(null));
      this.board.append(b);
      this.cells.set(k, b);
    };
    cell(keyOf("n", 0), "0", "green zero", "1", "1 / span 3");
    for (let n = 1; n <= 36; n++) {
      const col = Math.ceil(n / 3) + 1, row = 3 - ((n - 1) % 3);
      cell(keyOf("n", n), String(n), numberColor(n), String(col), String(row));
    }
    for (let c = 1; c <= 3; c++) cell(keyOf("column", c), "2:1", "outside col", "14", String(4 - c));
    for (let d = 1; d <= 3; d++) cell(keyOf("dozen", d), `${d}. 12'li`, "outside", `${(d - 1) * 4 + 2} / span 4`, "4");
    const even: [RouletteKind, string, string][] = [
      ["low", "1–18", ""], ["even", "ÇİFT", ""], ["red", "◆", "red"], ["black", "◆", "black"], ["odd", "TEK", ""], ["high", "19–36", ""],
    ];
    even.forEach(([kind, label, cls], i) => cell(keyOf(kind, 0), label, `outside ${cls}`, `${i * 2 + 2} / span 2`, "5"));
    // Çizgi ve köşe bahisleri: sayı hücresinin kenarlarındaki noktalar
    const hot = (n: number, kind: RouletteKind, v: number, cls: string) => {
      const k = keyOf(kind, v);
      const h = document.createElement("span");
      h.className = `cz-hot ${cls}`;
      h.addEventListener("click", (e) => {
        e.stopPropagation();
        this.place(k, this.chip);
      });
      h.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.place(k, -this.chip);
      });
      h.addEventListener("pointerenter", () => this.hover({ kind, v, amount: 0 }));
      h.addEventListener("pointerleave", () => this.hover(null));
      this.cells.get(keyOf("n", n))!.append(h);
      this.cells.set(k, h);
    };
    for (let n = 1; n <= 36; n++) {
      const row = (n - 1) % 3; // 0: alt sıra (1, 4, …), 2: üst sıra (3, 6, …)
      if (n <= 33) hot(n, "split", n * 100 + n + 3, "r");
      if (row < 2) hot(n, "split", n * 100 + n + 1, "t");
      if (row < 2 && n <= 32) hot(n, "corner", n, "tr");
      if (row === 0) hot(n, "street", n, "b");
      if (row === 0 && n <= 31) hot(n, "line", n, "br");
      if (n <= 3) hot(n, "split", n, "l");
    }
    hot(1, "trio", 1, "tl");
    hot(2, "trio", 2, "tl");
    hot(1, "four", 0, "bl");
  }

  /** Pist: çark sırasıyla sayılar (komşu bahsi) ve ortada özel bahis bölümleri, altında Final bahisleri. */
  private buildTrack(): void {
    const t = this.track;
    const head = document.createElement("div");
    head.className = "cz-trackhead";
    const nb = document.createElement("span");
    nb.className = "cz-nb";
    const nbVal = document.createElement("b");
    const step = (d: number) => {
      this.neighbours = Math.max(0, Math.min(9, this.neighbours + d));
      nbVal.textContent = String(this.neighbours);
    };
    const btn = (label: string, on: () => void) => {
      const b = document.createElement("button");
      b.className = "cz-mini";
      b.textContent = label;
      b.addEventListener("click", on);
      return b;
    };
    nb.append("KOMŞU", btn("−", () => step(-1)), nbVal, btn("+", () => step(1)));
    step(0);
    const title = document.createElement("small");
    title.textContent = "Pistte sayıya tıkla: o sayı ve komşuları · bölümler: özel bahisler";
    head.append(title, nb);
    const oval = document.createElement("div");
    oval.className = "cz-oval";
    const num = (n: number, col: string, row: string) => {
      const b = document.createElement("button");
      b.className = `cz-tn ${numberColor(n)}`;
      b.textContent = String(n);
      b.style.gridColumn = col;
      b.style.gridRow = row;
      b.title = `${n} ve her yanından ${this.neighbours} komşu`;
      b.addEventListener("click", () => this.placeMany(this.around(n).map((x): [string, number] => [keyOf("n", x), this.chip])));
      b.addEventListener("pointerenter", () => this.hoverNums(this.around(n)));
      b.addEventListener("pointerleave", () => this.hoverNums(null));
      oval.append(b);
      this.trackNums.set(n, b);
    };
    TRACK_TOP.forEach((n, i) => num(n, String(i + 2), "1"));
    TRACK_BOTTOM.forEach((n, i) => num(n, String(i + 2), "3"));
    num(5, "1", "1");
    num(10, "1", "3");
    num(0, "19", "1 / span 3");
    const sections: [keyof typeof SPECIAL, string][] = [["tiers", "1 / 7"], ["orphelins", "7 / 11"], ["voisins", "11 / 16"], ["zero", "16 / 19"]];
    for (const [name, col] of sections) {
      const sp = SPECIAL[name];
      const b = document.createElement("button");
      b.className = `cz-sec ${name}`;
      b.textContent = sp.label;
      b.title = sp.title;
      b.style.gridColumn = col;
      b.style.gridRow = "2";
      const nums = [...new Set(sp.chips.flatMap(([k, v]) => betNumbers(k, v) ?? []))];
      b.addEventListener("click", () => this.placeMany(sp.chips.map(([k, v, c]): [string, number] => [keyOf(k, v), this.chip * c])));
      b.addEventListener("pointerenter", () => this.hoverNums(nums));
      b.addEventListener("pointerleave", () => this.hoverNums(null));
      oval.append(b);
    }
    t.append(head, oval);
  }

  // -------------------------------------------------------------------------
  // Favori bahisler paneli (Evolution): FAVORİ (kaydedilenler) · ÖZEL (final, à cheval, tam bahis) · DÜZ BAHİS

  private toggleFav(open = !this.fav.classList.contains("show")): void {
    this.fav.classList.toggle("show", open);
    if (open) {
      this.stats.classList.remove("show");
      this.renderFav();
    }
  }

  private toggleStats(open = !this.stats.classList.contains("show")): void {
    this.stats.classList.toggle("show", open);
    if (open) {
      this.fav.classList.remove("show");
      this.renderStats();
    }
  }

  /** İstatistik: son çevirişlerde sıcak ve soğuk sayılar, renk/tek-çift/yarı/düzine/sütun yüzdeleri, son sonuçlar. */
  private renderStats(): void {
    const st = this.stats, h = this.history;
    st.replaceChildren();
    const head = document.createElement("div");
    head.className = "cz-favhead";
    head.innerHTML = `<b>📊 İstatistik · son ${h.length} çeviriş</b>`;
    const x = document.createElement("button");
    x.className = "cz-favx";
    x.textContent = "✕";
    x.addEventListener("click", () => this.toggleStats(false));
    head.append(x);
    st.append(head);
    if (!h.length) {
      const e = document.createElement("small");
      e.className = "cz-statempty";
      e.textContent = "Henüz çeviriş yok.";
      st.append(e);
      return;
    }
    const count = Array.from({ length: 37 }, (_, n) => ({ n, c: h.filter((x) => x === n).length, last: h.indexOf(n) }));
    // Soğuk: en az gelen; eşitse en uzun süredir gelmeyen
    const age = (o: { last: number }) => (o.last < 0 ? Infinity : o.last);
    const hot = count.filter((o) => o.c > 0).sort((a, b) => b.c - a.c || a.last - b.last).slice(0, 5);
    const cold = [...count].sort((a, b) => a.c - b.c || age(b) - age(a)).slice(0, 5);
    const nums = (title: string, list: { n: number; c: number }[], cls: string) => {
      const sec = document.createElement("div");
      sec.className = `cz-statnums ${cls}`;
      const t = document.createElement("h4");
      t.textContent = title;
      const row = document.createElement("div");
      for (const { n, c } of list) {
        const b = document.createElement("button");
        b.className = `cz-num ${numberColor(n)}`;
        b.textContent = String(n);
        b.title = `${n}: ${c} kez · tıkla: düz bahis`;
        b.addEventListener("click", () => this.place(keyOf("n", n), this.chip));
        b.addEventListener("pointerenter", () => this.hoverNums([n]));
        b.addEventListener("pointerleave", () => this.hoverNums(null));
        const k = document.createElement("small");
        k.textContent = `${c}×`;
        const cell = document.createElement("span");
        cell.append(b, k);
        row.append(cell);
      }
      sec.append(t, row);
      return sec;
    };
    const tot = h.length, pct = (k: number) => Math.round((k / tot) * 100);
    const by = (f: (n: number) => boolean) => h.filter(f).length;
    const bar = (parts: [string, number, string][]) => {
      const d = document.createElement("div");
      d.className = "cz-statbar";
      for (const [label, k, cls] of parts) {
        const p = document.createElement("span");
        p.className = cls;
        p.style.flexGrow = String(Math.max(k, 0.0001));
        p.textContent = k ? `${label} ${pct(k)}%` : "";
        p.title = `${label}: ${k} kez (%${pct(k)})`;
        d.append(p);
      }
      return d;
    };
    const red = by((n) => numberColor(n) === "red"), black = by((n) => numberColor(n) === "black"), zero = by((n) => n === 0);
    const bars = document.createElement("div");
    bars.className = "cz-statbars";
    bars.append(
      bar([["KIRMIZI", red, "r"], ["0", zero, "g"], ["SİYAH", black, "b"]]),
      bar([["TEK", by((n) => n > 0 && n % 2 === 1), "o"], ["0", zero, "g"], ["ÇİFT", by((n) => n > 0 && n % 2 === 0), "o2"]]),
      bar([["1–18", by((n) => n >= 1 && n <= 18), "o"], ["0", zero, "g"], ["19–36", by((n) => n >= 19), "o2"]]),
      bar([1, 2, 3].map((d): [string, number, string] => [`${d}. DÜZİNE`, by((n) => n > 0 && Math.ceil(n / 12) === d), `d${d}`])),
      bar([1, 2, 3].map((c): [string, number, string] => [`${c}. SÜTUN`, by((n) => n > 0 && ((n - 1) % 3) + 1 === c), `d${c}`])),
    );
    const last = document.createElement("div");
    last.className = "cz-statlast";
    for (const n of h.slice(0, 60)) {
      const i = document.createElement("i");
      i.className = `cz-num ${numberColor(n)}`;
      i.textContent = String(n);
      last.append(i);
    }
    const lh = document.createElement("h4");
    lh.textContent = "SON SONUÇLAR";
    st.append(nums("🔥 SICAK SAYILAR", hot, "hot"), nums("❄️ SOĞUK SAYILAR", cold, "cold"), bars, lh, last);
  }

  /** Bir düğme: tıklayınca çipleri koyar, üstüne gelince kapsadığı sayılar parlar. */
  private favBtn(label: string, title: string, chips: [RouletteKind, number, number][]): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "cz-favbtn";
    b.textContent = label;
    b.title = title;
    const nums = [...new Set(chips.flatMap(([k, v]) => (betNumbers(k, v) ?? Array.from({ length: 37 }, (_, n) => n).filter((n) => rouletteWins({ kind: k, v, amount: 0 }, n)))))];
    b.addEventListener("click", () => this.placeMany(chips.map(([k, v, c]): [string, number] => [keyOf(k, v), this.chip * c])));
    b.addEventListener("pointerenter", () => this.hoverNums(nums));
    b.addEventListener("pointerleave", () => this.hoverNums(null));
    return b;
  }

  private favSection(title: string, cls: string, items: HTMLElement[]): HTMLElement {
    const sec = document.createElement("div");
    sec.className = "cz-favsec";
    const h = document.createElement("h4");
    h.textContent = title;
    const grid = document.createElement("div");
    grid.className = `cz-favgrid ${cls}`;
    grid.append(...items);
    sec.append(h, grid);
    return sec;
  }

  private loadFavs(): { name: string; bets: [string, number][] }[] {
    try {
      const v = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
      return Array.isArray(v) ? v.slice(0, 8) : [];
    } catch {
      return [];
    }
  }

  private saveFavs(list: { name: string; bets: [string, number][] }[]): void {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 8)));
    } catch {
      this.ctx.toast("⭐ Favoriler bu tarayıcıda saklanamıyor.");
    }
  }

  private renderFav(): void {
    const f = this.fav;
    f.replaceChildren();
    const head = document.createElement("div");
    head.className = "cz-favhead";
    head.innerHTML = "<b>★ Favori Bahisler</b>";
    const x = document.createElement("button");
    x.className = "cz-favx";
    x.textContent = "✕";
    x.addEventListener("click", () => this.toggleFav(false));
    head.append(x);
    const tabs = document.createElement("div");
    tabs.className = "cz-favtabs";
    for (const [id, label] of [["fav", "FAVORİ"], ["special", "ÖZEL"], ["even", "DÜZ BAHİS"]] as const) {
      const t = document.createElement("button");
      t.textContent = label;
      t.className = this.favTab === id ? "on" : "";
      t.addEventListener("click", () => {
        this.favTab = id;
        this.renderFav();
      });
      tabs.append(t);
    }
    const body = document.createElement("div");
    body.className = "cz-favbody";
    if (this.favTab === "special") {
      const finals = Array.from({ length: 10 }, (_, d) => {
        const nums = Array.from({ length: 37 }, (_, n) => n).filter((n) => n % 10 === d);
        return this.favBtn(String(d), `Finale en plein ${d}: ${nums.join(", ")} (${nums.length} çip)`, nums.map((n): [RouletteKind, number, number] => ["n", n, 1]));
      });
      const cheval = A_CHEVAL.map(([label, bets]) => this.favBtn(label, `Finale à cheval ${label} (${bets.length} çip)`, bets.map(([k, v]): [RouletteKind, number, number] => [k, v, 1])));
      const full: HTMLElement[] = [];
      const zero = this.favBtn("0", "Tam bahis 0", completeBet(0));
      zero.classList.add("zero");
      full.push(zero);
      for (let row = 2; row >= 0; row--) for (let col = 0; col < 12; col++) {
        const n = col * 3 + row + 1, cb = completeBet(n);
        full.push(this.favBtn(String(n), `Tam bahis ${n}: ${cb.reduce((a, [, , c]) => a + c, 0)} çip`, cb));
      }
      body.append(
        this.favSection("FINALE EN PLEIN", "finals", finals),
        this.favSection("FINALE A CHEVAL", "cheval", cheval),
        this.favSection("TAM BAHİSLER", "full", full),
      );
    } else if (this.favTab === "even") {
      const even = OUTSIDE.map(([label, k, v]) => this.favBtn(label, label, [[k, v, 1]]));
      const sp = (["tiers", "orphelins", "voisins", "zero"] as const).map((n) => this.favBtn(SPECIAL[n].label === "TIER" ? "TIER" : SPECIAL[n].label, SPECIAL[n].title, SPECIAL[n].chips));
      body.append(this.favSection("DÜZ BAHİS", "even", even), this.favSection("ÖZEL BÖLGELER", "even", sp));
    } else {
      const favs = this.loadFavs();
      const items: HTMLElement[] = favs.map((fv, i) => {
        const row = document.createElement("div");
        row.className = "cz-favrow";
        const total = fv.bets.reduce((a, [, x]) => a + x, 0);
        const use = document.createElement("button");
        use.className = "cz-favbtn";
        use.textContent = `${fv.name} · ${fmt(total)}`;
        use.addEventListener("click", () => {
          const next = new Map(this.bets);
          for (const [k, a] of fv.bets) next.set(k, Math.min(MAX_BET, (next.get(k) ?? 0) + a));
          this.change(next);
        });
        const del = document.createElement("button");
        del.className = "cz-favx";
        del.textContent = "✕";
        del.title = "Sil";
        del.addEventListener("click", () => {
          this.saveFavs(favs.filter((_, j) => j !== i));
          this.renderFav();
        });
        row.append(use, del);
        return row;
      });
      const save = document.createElement("button");
      save.className = "cz-favsave";
      save.textContent = "★ Masadaki bahsi favorilere kaydet";
      save.disabled = !this.bets.size || favs.length >= 8;
      save.addEventListener("click", () => {
        this.saveFavs([...favs, { name: `Favori ${favs.length + 1}`, bets: [...this.bets] }]);
        this.renderFav();
      });
      if (!items.length) {
        const e = document.createElement("small");
        e.textContent = "Henüz favori yok: masaya bahis koy ve kaydet.";
        items.push(e);
      }
      body.append(this.favSection("KAYITLI BAHİSLER", "favs", items), save);
    }
    f.append(head, tabs, body);
  }

  /** Sol üst: bahis sürerken masadakiler, sonuçta kazananlar (Immersive'deki gibi). */
  private renderWinners(): void {
    const v = this.lv, w = this.winnersEl;
    w.replaceChildren();
    if (!v) return;
    const result = v.phase === "result";
    const rows = v.seats.filter((s) => s && (!result || (s.payout ?? 0) > 0));
    if (!rows.length) return;
    const h = document.createElement("b");
    h.textContent = result ? "KAZANANLAR" : "MASADAKİLER";
    w.append(h);
    for (const s of rows) {
      const r = document.createElement("div");
      const amount = result ? s!.payout ?? 0 : s!.bets.reduce((a, b) => a + b.amount, 0);
      r.innerHTML = `<em>${result ? "+" : ""}${fmt(amount)}</em> <span></span>`;
      r.querySelector("span")!.textContent = s!.name;
      w.append(r);
    }
  }

  /** Çarkta n ve her yanından seçili sayıda komşusu. */
  private around(n: number): number[] {
    const i = WHEEL.indexOf(n), k = this.neighbours;
    return Array.from({ length: 2 * k + 1 }, (_, d) => WHEEL[(i + d - k + WHEEL.length * 2) % WHEEL.length]);
  }

  /** Hücrenin üstündeyken kazandıracağı sayılar parlar. */
  private hover(b: RouletteBet | null): void {
    this.hoverNums(b && b.kind !== "n" ? Array.from({ length: 37 }, (_, n) => n).filter((n) => rouletteWins(b, n)) : null);
  }

  private hoverNums(ns: number[] | null): void {
    for (let n = 0; n <= 36; n++) {
      const on = !!ns?.includes(n);
      this.cells.get(keyOf("n", n))!.classList.toggle("hl", on);
      this.trackNums.get(n)?.classList.toggle("hl", on);
    }
  }

  private total(): number {
    let t = 0;
    for (const a of this.bets.values()) t += a;
    return t;
  }

  /** Masayı yeni duruma getir (geri alınabilir); bakiye ve masa sınırına bakar. */
  private change(next: Map<string, number>, msg = "💰 Bakiyen bu kadarına yetmiyor."): boolean {
    if (this.spinning || this.pending || !this.canBet()) return false;
    let t = 0;
    for (const a of next.values()) t += a;
    if (t > this.avail()) return this.ctx.toast(msg), false;
    if (t > TABLE_MAX || next.size > 150) return this.ctx.toast(`🎡 Masa sınırı: toplam ${fmt(TABLE_MAX)}.`), false;
    this.undoStack.push(this.bets);
    this.bets = next;
    sfx.chip();
    this.renderBets();
    this.sendBets();
    return true;
  }

  private place(k: string, amount: number): void {
    const next = new Map(this.bets);
    const cur = next.get(k) ?? 0, v = Math.max(0, Math.min(MAX_BET, cur + amount));
    if (v === cur) return;
    if (v) next.set(k, v);
    else next.delete(k);
    this.change(next);
  }

  /** Özel bahisler: birden çok yere birden çip (tek hamlede geri alınır). */
  private placeMany(list: [string, number][]): void {
    const next = new Map(this.bets);
    for (const [k, a] of list) next.set(k, Math.min(MAX_BET, (next.get(k) ?? 0) + a));
    this.change(next);
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    if (this.change(prev)) this.undoStack.pop();
    else this.undoStack.push(prev);
  }

  private double(): void {
    if (this.bets.size) this.change(new Map([...this.bets].map(([k, a]) => [k, Math.min(MAX_BET, a * 2)])), "💰 İkiye katlamaya bakiyen yetmiyor.");
  }

  private renderBets(): void {
    for (const [k, b] of this.cells) {
      const a = this.bets.get(k);
      // Yalnızca kendi çipi (hücrenin içindeki çizgi noktalarının çipleri ayrı)
      let chip = b.querySelector<HTMLElement>(":scope > .cz-bchip");
      if (!a) {
        chip?.remove();
        continue;
      }
      if (!chip) {
        chip = document.createElement("i");
        chip.className = "cz-bchip";
        b.append(chip);
      }
      chip.textContent = shortAmount(a);
      chip.className = `cz-bchip c${chipTier(a)}`;
    }
    this.renderControls();
    if (this.fav.classList.contains("show") && this.favTab === "fav") this.renderFav();
  }

  private clearBets(): void {
    if (this.bets.size) this.change(new Map());
  }

  private rebet(): void {
    if (this.lastBets.length && !this.bets.size) this.change(new Map(this.lastBets), "💰 Önceki bahse bakiyen yetmiyor.");
  }

  private spinNow(): void {
    if (this.spinning || this.pending) return;
    if (!this.bets.size) return this.ctx.toast("🎡 Önce masaya çip koy.");
    if (this.total() > this.ctx.balance()) return this.ctx.toast("💰 Bakiyen bu bahislere yetmiyor.");
    this.pending = true;
    this.lastBets = [...this.bets];
    const bets: RouletteBet[] = [...this.bets].map(([k, amount]) => ({ ...parseKey(k), amount }));
    this.ctx.send({ t: "roulette", bets });
    this.renderControls();
  }

  private clearWins(): void {
    for (const b of this.cells.values()) b.classList.remove("win", "lose");
  }

  /** Top durdu: kazanan hücreler parlar, ödeme eklenir, masa temizlenir. */
  private finish(ev: Extract<CasinoEvent, { t: "roulette" }>): void {
    this.spinning = false;
    this.landed = ev.n;
    // Canlıda geçmiş sunucudan gelir
    if (!this.live) this.history = [ev.n, ...this.history].slice(0, 14);
    for (const [k, b] of this.cells) {
      const { kind, v } = parseKey(k);
      const win = rouletteWins({ kind, v, amount: 0 }, ev.n);
      b.classList.toggle("win", win && (kind === "n" || this.bets.has(k)));
      b.classList.toggle("lose", !win && this.bets.has(k));
    }
    if (!this.live) this.ctx.setBalance(ev.balance);
    const staked = ev.bets.reduce((s, b) => s + b.amount, 0);
    if (ev.payout > 0) sfx.win(ev.payout >= staked * 10);
    this.renderResult(ev.payout, staked);
    // Kaybeden çipler toplanır; kazanan hücrelerin parıltısı bir süre kalır
    this.timers.push(window.setTimeout(() => {
      if (this.spinning || (this.live && this.lv?.phase === "bet")) return;
      for (const b of this.cells.values()) b.classList.remove("lose");
      this.bets.clear();
      this.undoStack = [];
      this.renderBets();
    }, 1600));
    this.renderControls();
  }

  private renderResult(payout?: number, staked?: number): void {
    const n = this.landed;
    if (this.spinning) {
      this.resultEl.className = "cz-result spinning";
      this.resultEl.innerHTML = "<span>Top dönüyor…</span>";
    } else if (n === null) {
      this.resultEl.className = "cz-result";
      this.resultEl.innerHTML = this.live ? "<span>Bahis süresi bitince çark döner</span>" : "<span>Bahislerini koy ve çevir</span>";
    } else {
      const c = numberColor(n);
      // Dönen tutar ve net sonuç (kırmızıya 25 koyup 17'ye 25 kaybedince dönen 50, net ±0)
      const net = (payout ?? 0) - (staked ?? 0);
      const netText = net > 0 ? `net +${fmt(net)}` : net < 0 ? `net −${fmt(-net)}` : "başa baş";
      const tail = payout === undefined ? "" : payout > 0 ? `<em class="${net >= 0 ? "up" : "down"}">+${fmt(payout)} · ${netText}</em>` : `<em class="down">−${fmt(staked ?? 0)}</em>`;
      this.resultEl.className = "cz-result";
      this.resultEl.innerHTML = `<b class="cz-num ${c}">${n}</b><span>${COLOR_TR[c]}${n ? ` · ${n % 2 ? "TEK" : "ÇİFT"}` : ""}</span>${tail}`;
    }
    this.historyEl.replaceChildren(
      ...this.history.slice(0, 14).map((h, i) => {
        const d = document.createElement("i");
        d.className = `cz-num ${numberColor(h)}${i === 0 ? " last" : ""}`;
        d.textContent = String(h);
        return d;
      }),
    );
  }

  /** Çip sırası (yanlarında GERİ AL ve İKİYE KATLA) ve alt çubuk (toplam bahis, Temizle, Tekrarla, ★, ÇEVİR). */
  private renderControls(): void {
    const c = this.ctrl, bot = this.bottom;
    c.replaceChildren();
    bot.replaceChildren();
    const lock = this.spinning || this.pending || !this.canBet();
    const has = this.bets.size > 0;
    const tool = (icon: string, label: string, title: string, on: () => void, ok: boolean, cls = "") => {
      const b = document.createElement("button");
      b.className = `cz-rtool ${cls}`;
      b.innerHTML = `<i>${icon}</i><span>${label}</span>`;
      b.title = title;
      b.disabled = !ok;
      b.addEventListener("click", on);
      return b;
    };
    const total = document.createElement("div");
    total.className = "cz-pill";
    total.innerHTML = `<small>${this.live && this.committed && !this.sendTimer ? "MASADA ✓" : "TOPLAM BAHİS"}</small><b>${fmt(this.total())}</b>`;
    const right = document.createElement("div");
    right.className = "cz-rlbtns";
    if (this.live?.seat === null) {
      const w = document.createElement("div");
      w.className = "cz-wait";
      w.textContent = !this.lv || this.lv.seats.some((s) => !s) ? "👀 İzliyorsun · oynamak için masadaki boş bir tabureye otur" : "👀 İzliyorsun · masa dolu";
      c.append(w);
      bot.append(total);
      return;
    }
    const chips = chipRow(CHIPS, (v) => {
      this.chip = v;
      sfx.chip();
      this.renderControls();
    }, () => {}, this.chip);
    chips.classList.add("select");
    c.append(
      tool("↶", "GERİ AL", "Son bahsi geri al (Backspace)", () => this.undo(), !lock && this.undoStack.length > 0),
      chips,
      tool("×2", "İKİYE KATLA", "Tüm bahisleri ikiye katla (X)", () => this.double(), !lock && has && this.total() * 2 <= this.avail()),
    );
    right.append(
      tool("✕", "Temizle", "Masadaki çipleri al (Delete)", () => this.clearBets(), !lock && has, "round"),
      tool("↻", "Tekrarla", "Önceki turun bahisleri (R)", () => this.rebet(), !lock && this.lastBets.length > 0 && !has, "round"),
      tool("📊", "İstatistik", "Son çevirişlerin istatistiği", () => this.toggleStats(), true, "round"),
      tool("★", "Favori", "Favori ve özel bahisler", () => this.toggleFav(), true, "round star"),
    );
    if (!this.live) {
      const spin = document.createElement("button");
      spin.className = "cz-btn deal";
      spin.innerHTML = `<span>${this.spinning ? "DÖNÜYOR…" : "ÇEVİR"}</span><kbd>Space</kbd>`;
      spin.disabled = lock || !has;
      spin.addEventListener("click", () => this.spinNow());
      right.append(spin);
    }
    bot.append(total, right);
  }

  // -------------------------------------------------------------------------
  // Çark

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const s = this.spin;
    if (s) {
      const t = Math.min(1, (now - s.t0) / this.spinMs);
      this.wheelA = s.w0 + (s.w1 - s.w0) * ease(t, 2);
      this.ballA = s.b0 + (s.b1 - s.b0) * ease(t, 3);
      // Son üçte birde top kanaldan cebe iner, iki kez sekerek
      const fall = Math.max(0, (t - 0.62) / 0.38);
      this.ballR = fall <= 0 ? 1 : Math.max(0, 1 - ease(fall, 2)) + Math.abs(Math.sin(fall * Math.PI * 3)) * 0.22 * (1 - fall);
      // Top cepleri geçerken tıkırdar
      const seg = Math.floor((this.ballA - this.wheelA) / SEG);
      if (fall > 0 && seg !== this.lastTickSeg) sfx.tick(1 - fall * 0.7);
      this.lastTickSeg = seg;
      if (t >= 1) {
        this.spin = null;
        this.finish(s.ev);
      }
    } else {
      // Boşta çark ağır ağır döner; top cebindeyse onunla birlikte
      const w = dt * 0.35;
      this.wheelA += w;
      if (this.landed !== null) this.ballA += w;
    }
    this.draw();
  }

  private draw(): void {
    const g = this.g, S = this.size, c = S / 2;
    g.clearRect(0, 0, S, S);
    const R = c - 4;
    // Ahşap gövde ve altın çember
    const wood = g.createRadialGradient(c, c, R * 0.6, c, c, R);
    wood.addColorStop(0, "#5a2e17");
    wood.addColorStop(1, "#2a140a");
    g.fillStyle = wood;
    circle(g, c, c, R);
    g.lineWidth = 3;
    g.strokeStyle = "#d9b45a";
    ring(g, c, c, R - 1.5);
    // Top kanalı (açık renk ahşap)
    const track = R * 0.86;
    g.fillStyle = "#3b2414";
    circle(g, c, c, track);
    g.strokeStyle = "#8a6a3a";
    g.lineWidth = 1;
    ring(g, c, c, track);
    // Cepler
    const outer = R * 0.74, inner = R * 0.5;
    g.save();
    g.translate(c, c);
    g.rotate(this.wheelA);
    WHEEL.forEach((n, i) => {
      const a0 = i * SEG - SEG / 2 - Math.PI / 2, a1 = a0 + SEG;
      g.beginPath();
      g.arc(0, 0, outer, a0, a1);
      g.arc(0, 0, inner, a1, a0, true);
      g.closePath();
      g.fillStyle = this.landed === n && !this.spinning ? "#f5d77a" : COLORS[numberColor(n)];
      g.fill();
      g.strokeStyle = "#c9a24a";
      g.lineWidth = 1;
      g.stroke();
      // Numara
      g.save();
      g.rotate(i * SEG);
      g.fillStyle = this.landed === n && !this.spinning ? "#1b1206" : "#fff";
      g.font = `bold ${Math.round(R * 0.085)}px system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(n), 0, -(outer - (outer - inner) * 0.24));
      g.restore();
    });
    // Orta koni ve altın haç
    const cone = g.createRadialGradient(-R * 0.1, -R * 0.1, 2, 0, 0, inner);
    cone.addColorStop(0, "#7a4a26");
    cone.addColorStop(1, "#3a1f0e");
    g.fillStyle = cone;
    circle(g, 0, 0, inner);
    g.strokeStyle = "#d9b45a";
    g.lineWidth = 2;
    ring(g, 0, 0, inner);
    g.fillStyle = "#e4c26a";
    for (let k = 0; k < 4; k++) {
      g.save();
      g.rotate((k * Math.PI) / 2);
      g.fillRect(-2, -inner * 0.62, 4, inner * 0.62);
      g.beginPath();
      g.arc(0, -inner * 0.62, 4.5, 0, TAU);
      g.fill();
      g.restore();
    }
    g.beginPath();
    g.arc(0, 0, inner * 0.18, 0, TAU);
    g.fill();
    g.restore();
    // Top
    const rest = inner + (outer - inner) * 0.3, groove = (track + outer) / 2;
    const br = rest + (groove - rest) * Math.min(1, this.ballR);
    const bx = c + Math.sin(this.ballA) * br, by = c - Math.cos(this.ballA) * br;
    g.fillStyle = "rgba(0,0,0,0.35)";
    circle(g, bx + 1.5, by + 2, 5.5);
    const ball = g.createRadialGradient(bx - 2, by - 2, 0.5, bx, by, 6);
    ball.addColorStop(0, "#ffffff");
    ball.addColorStop(1, "#b9bcc4");
    g.fillStyle = ball;
    circle(g, bx, by, 5.5);
  }
}

function circle(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
}
function ring(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.stroke();
}
