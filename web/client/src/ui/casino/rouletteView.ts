// Rulet ekranı: solda Avrupa çarkı (canvas; çark bir yöne, top öbür yöne döner, yavaşlayıp cebe düşer), sağda
// bahis masası. Çip seç, hücreye tıkla (sağ tık geri alır), ÇEVİR. Sonuç sunucudan gelir; çark ona göre durur.
import { MAX_BET, numberColor, type RouletteBet, type RouletteKind, rouletteWins, WHEEL } from "../../../../shared/casino";
import { sfx } from "../sfx";
import { chipRow } from "./blackjackView";
import { type CasinoCtx, type CasinoEvent, fmt, type GameView } from "./casinoUi";

const CHIPS = [10, 25, 100, 500];
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
const short = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));
const ease = (t: number, p = 3) => 1 - (1 - t) ** p;

export class RouletteView implements GameView {
  readonly el = document.createElement("div");
  private canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private size = 300;
  private board = document.createElement("div");
  private cells = new Map<string, HTMLButtonElement>();
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

  constructor(private ctx: CasinoCtx) {
    this.el.className = "cz-rl";
    const left = document.createElement("div");
    left.className = "cz-wheelbox";
    this.canvas.className = "cz-wheel";
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = this.canvas.height = this.size * dpr;
    this.g = this.canvas.getContext("2d")!;
    this.g.scale(dpr, dpr);
    this.resultEl.className = "cz-result";
    this.historyEl.className = "cz-history";
    left.append(this.canvas, this.resultEl, this.historyEl);
    const right = document.createElement("div");
    right.className = "cz-tablebox";
    this.board.className = "cz-board";
    this.buildBoard();
    this.ctrl.className = "cz-ctrl";
    right.append(this.board, this.ctrl);
    this.el.append(left, right);
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
  }

  refresh(): void {
    this.renderControls();
  }

  failed(): void {
    this.pending = false;
    this.renderControls();
  }

  event(ev: CasinoEvent): void {
    if (ev.t !== "roulette") return;
    this.pending = false;
    this.spinning = true;
    // Bahis düşülsün; kazanç top durunca eklenir
    this.ctx.setBalance(ev.balance - ev.payout);
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

  key(code: string): boolean {
    if (code === "Space") {
      this.spinNow();
      return true;
    }
    if (code === "KeyR") {
      this.rebet();
      return true;
    }
    if (code === "Backspace" || code === "Delete") {
      this.clearBets();
      return true;
    }
    return false;
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
  }

  /** Hücrenin üstündeyken kazandıracağı sayılar parlar. */
  private hover(b: RouletteBet | null): void {
    for (let n = 0; n <= 36; n++) this.cells.get(keyOf("n", n))!.classList.toggle("hl", !!b && b.kind !== "n" && rouletteWins(b, n));
  }

  private total(): number {
    let t = 0;
    for (const a of this.bets.values()) t += a;
    return t;
  }

  private place(k: string, amount: number): void {
    if (this.spinning || this.pending) return;
    const cur = this.bets.get(k) ?? 0;
    let next = Math.max(0, Math.min(MAX_BET, cur + amount));
    if (amount > 0 && this.total() - cur + next > this.ctx.balance()) {
      next = cur + Math.max(0, this.ctx.balance() - this.total());
      if (next === cur) return this.ctx.toast("💰 Bakiyen bu kadarına yetmiyor.");
    }
    if (next === cur) return;
    if (next) this.bets.set(k, next);
    else this.bets.delete(k);
    sfx.chip();
    this.renderBets();
  }

  private renderBets(): void {
    for (const [k, b] of this.cells) {
      const a = this.bets.get(k);
      let chip = b.querySelector<HTMLElement>(".cz-bchip");
      if (!a) {
        chip?.remove();
        continue;
      }
      if (!chip) {
        chip = document.createElement("i");
        chip.className = "cz-bchip";
        b.append(chip);
      }
      chip.textContent = short(a);
      chip.className = `cz-bchip c${a >= 500 ? 500 : a >= 100 ? 100 : a >= 25 ? 25 : 10}`;
    }
    this.renderControls();
  }

  private clearBets(): void {
    if (this.spinning || this.pending) return;
    this.bets.clear();
    this.renderBets();
  }

  private rebet(): void {
    if (this.spinning || this.pending || !this.lastBets.length) return;
    const total = this.lastBets.reduce((s, [, a]) => s + a, 0);
    if (total > this.ctx.balance()) return this.ctx.toast("💰 Önceki bahse bakiyen yetmiyor.");
    this.bets = new Map(this.lastBets);
    sfx.chip();
    this.renderBets();
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
    this.history = [ev.n, ...this.history].slice(0, 14);
    for (const [k, b] of this.cells) {
      const { kind, v } = parseKey(k);
      const win = rouletteWins({ kind, v, amount: 0 }, ev.n);
      b.classList.toggle("win", win && (kind === "n" || this.bets.has(k)));
      b.classList.toggle("lose", !win && this.bets.has(k));
    }
    this.ctx.setBalance(ev.balance);
    const staked = ev.bets.reduce((s, b) => s + b.amount, 0);
    if (ev.payout > 0) sfx.win(ev.payout >= staked * 10);
    this.renderResult(ev.payout, staked);
    // Kaybeden çipler toplanır; kazanan hücrelerin parıltısı bir süre kalır
    this.timers.push(window.setTimeout(() => {
      if (this.spinning) return;
      for (const b of this.cells.values()) b.classList.remove("lose");
      this.bets.clear();
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
      this.resultEl.innerHTML = "<span>Bahislerini koy ve çevir</span>";
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
      ...this.history.map((h, i) => {
        const d = document.createElement("i");
        d.className = `cz-num ${numberColor(h)}${i === 0 ? " last" : ""}`;
        d.textContent = String(h);
        return d;
      }),
    );
  }

  private renderControls(): void {
    const c = this.ctrl;
    c.replaceChildren();
    const lock = this.spinning || this.pending;
    const chips = chipRow(CHIPS, (v) => {
      this.chip = v;
      sfx.chip();
      this.renderControls();
    }, () => {}, this.chip);
    chips.classList.add("select");
    const total = document.createElement("div");
    total.className = "cz-bet";
    total.innerHTML = `<small>TOPLAM BAHİS</small><b>${fmt(this.total())}</b>`;
    const tools = document.createElement("div");
    tools.className = "cz-tools";
    const mini = (label: string, title: string, on: () => void, enabled: boolean) => {
      const b = document.createElement("button");
      b.className = "cz-mini";
      b.textContent = label;
      b.title = title;
      b.disabled = !enabled || lock;
      b.addEventListener("click", on);
      tools.append(b);
    };
    mini("Temizle", "Masadaki çipleri al (Backspace)", () => this.clearBets(), this.bets.size > 0);
    mini("↻ Tekrarla", "Önceki bahisleri koy (R)", () => this.rebet(), this.lastBets.length > 0 && !this.bets.size);
    const spin = document.createElement("button");
    spin.className = "cz-btn deal";
    spin.innerHTML = `<span>${this.spinning ? "DÖNÜYOR…" : "ÇEVİR"}</span><kbd>Space</kbd>`;
    spin.disabled = lock || !this.bets.size;
    spin.addEventListener("click", () => this.spinNow());
    c.append(chips, total, tools, spin);
  }

  // -------------------------------------------------------------------------
  // Çark

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const s = this.spin;
    if (s) {
      const t = Math.min(1, (now - s.t0) / SPIN_MS);
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
