// Kahvehane masası ekranı: satranç, tavla, okey tahtası ve bilek güreşi (canvas), oyunu başlat / pes et / kalk düğmeleri.
// Yasal hamleler paylaşılan kurallardan (shared/games) gösterilir; asıl doğrulama sunucuda.
import { bilekLean } from "../../../shared/games/bilek";
import { type ChessMove, type ChessState, inCheck, legalMoves } from "../../../shared/games/chess";
import { COLORS as OKEY_COLORS, tileOf } from "../../../shared/games/okey";
import { type TavlaMove, tavlaMoves, type TavlaState } from "../../../shared/games/tavla";
import type { ClientEvent, OkeyView, TableState } from "../../../shared/protocol";
import { BILEK_H, BILEK_W, drawBilek } from "./bilekUi";
import { button, el, Panel } from "./panel";
import { sfx } from "./sfx";

const KIND_NAMES = { tavla: "TAVLA", satranc: "SATRANÇ", okey: "OKEY", bilek: "BİLEK GÜREŞİ" } as const;
const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const TILE_COLORS = ["#d99a12", "#2a6fd6", "#1f1f24", "#d23a2a"];
const RACK = 15;
/** Bilek güreşi bitince SPACE bu kadar (ms) daha yutulur (son basışlar oyuncuyu kaldırmasın). */
const AFTER_WIN_MS = 2500;

type Hit = { kind: "sq"; i: number } | { kind: "pt"; i: number } | { kind: "bar" } | { kind: "off" } | { kind: "slot"; i: number } | { kind: "pile" } | { kind: "left" } | { kind: "mine" } | { kind: "press" };

export class BoardGameUi {
  private panel: Panel;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private info: HTMLDivElement;
  private actions: HTMLDivElement;
  private tables = new Map<number, TableState>();
  private id = -1;
  private W = 512;
  private H = 512;
  private hits: { x: number; y: number; w: number; h: number; hit: Hit }[] = [];
  // Satranç/tavla seçimi
  private sel: number | null = null;
  private promo: ChessMove | null = null;
  // Okey: istakadaki yerel diziliş (30 yuva) ve seçili taş
  private rack: (number | null)[] = new Array(RACK * 2).fill(null);
  private pick: number | null = null;
  private drag: { slot: number; x: number; y: number; moved: boolean } | null = null;
  private lastDice = "";
  // Bilek güreşi: ekran kendi döngüsüyle çizilir (ibre döner), kol eğimi yumuşatılır
  private raf = 0;
  private lean = 0;
  private paintAt = 0;
  /** Basılan turun başlangıcı (sunucu cevabı gelene kadar ikinci basış gitmesin). */
  private pressed = 0;

  constructor(
    root: HTMLElement,
    private me: () => number,
    private send: (ev: ClientEvent) => void,
    /** Sunucu saati (ms): bilek güreşinde ibre sunucunun zamanıyla döner. */
    private now: () => number,
  ) {
    this.panel = new Panel(root, "MASA", "board-panel");
    this.info = el("div", "bg-info", this.panel.body);
    this.canvas = el("canvas", "bg-canvas", this.panel.body);
    this.g = this.canvas.getContext("2d")!;
    this.actions = el("div", "bg-actions", this.panel.body);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    addEventListener("resize", () => this.isOpen && this.render());
    // Bilek güreşinde SPACE basıştır (panel kapalıyken de): oyuncu taburede kalsın (zıplayıp kalkmasın),
    // panel düğmesi tıklanmasın. Oyun bittikten hemen sonraki basışlar da yutulur (kalkmak için yürü/E).
    addEventListener(
      "keydown",
      (e) => {
        if (e.code !== "Space" || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        const t = this.wrestling();
        if (!t) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        if (!this.isOpen || this.id !== t.id) this.open(t.id);
        this.press(t);
      },
      { capture: true },
    );
    this.panel.onClose = () => {
      this.id = -1;
    };
  }

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  /** Şu an açık masa (yoksa -1). */
  get current(): number {
    return this.panel.isOpen ? this.id : -1;
  }

  table(id: number): TableState | undefined {
    return this.tables.get(id);
  }

  open(id: number): void {
    if (this.id !== id) {
      this.sel = null;
      this.pick = null;
      this.promo = null;
    }
    this.id = id;
    this.panel.open();
    this.render();
  }

  close(): void {
    this.panel.close();
  }

  update(t: TableState): void {
    const prev = this.tables.get(t.id);
    this.tables.set(t.id, t);
    // Zar sesi: tavlada yeni zar
    if (t.game?.kind === "tavla") {
      const key = `${t.id}:${t.game.state.rolled.join(",")}:${t.game.state.turn}`;
      if (key !== this.lastDice && prev?.game) sfx.dice();
      this.lastDice = key;
    } else if (t.game?.kind === "okey" && prev?.game?.kind === "okey" && JSON.stringify(prev.game.state.discards) !== JSON.stringify(t.game.state.discards)) sfx.tile();
    if (t.game?.kind === "bilek" && prev?.game?.kind === "bilek") {
      const me = this.myIndex(t);
      const c = t.game.state.checks[me], was = prev.game.state.checks[me];
      if (c?.res && c.n === was?.n && !was.res) (c.res === "hit" ? sfx.pop : sfx.bump)();
    }
    if (t.id === this.id && this.panel.isOpen) this.render();
  }

  /** Oturduğum, süren (ya da az önce biten) bilek güreşi masası. */
  private wrestling(): TableState | null {
    const now = this.now();
    for (const t of this.tables.values()) {
      const g = t.game;
      if (g?.kind !== "bilek" || !t.seats.includes(this.me()) || this.myIndex(t) < 0) continue;
      const ended = Math.max(0, ...g.state.checks.map((c) => c?.done ?? 0));
      if (g.state.winner === null || now - ended < AFTER_WIN_MS) return t;
    }
    return null;
  }

  /** Skill check'e bas: ibrenin sunucu saatindeki konumu gider (sunucu yayda mı, zamanı tutarlı mı bakar). */
  private press(t: TableState): void {
    const g = t.game;
    if (g?.kind !== "bilek") return;
    const c = g.state.checks[this.myIndex(t)];
    if (!c || c.res || this.pressed === c.at) return;
    const p = (this.now() - c.at) / c.dur;
    if (p < 0) return;
    this.pressed = c.at;
    this.send({ t: "tmove", id: t.id, move: { kind: "press", n: c.n, p } });
  }

  private seated(t: TableState): boolean {
    return t.seats.includes(this.me());
  }

  /** Bu oyunda benim sıram (yoksa -1). */
  private myIndex(t: TableState): number {
    return t.order.indexOf(this.me());
  }

  // ---------------------------------------------------------------------------

  private render(): void {
    const t = this.tables.get(this.id);
    if (!t) return;
    this.panel.title = `${KIND_NAMES[t.kind]} · MASA ${t.id + 1}`;
    const players = t.seats.map((s, i) => (s ? t.names[i] : "—")).join(" · ");
    this.info.textContent = `${players}\n${t.note || ""}`;
    this.paint(t);
    this.renderActions(t);
  }

  /** Tahtayı çizer; bilek güreşi açıkken her karede yeniden (ibre ve kol). */
  private paint(t: TableState): void {
    const g = t.game;
    this.hits = [];
    [this.W, this.H] = t.kind === "satranc" ? [512, 512] : t.kind === "tavla" ? [760, 520] : t.kind === "bilek" ? [BILEK_W, BILEK_H] : [760, 600];
    const aspect = this.W / this.H;
    // Panele ve ekran yüksekliğine sığsın (başlık, bilgi ve düğmeler için ~190 px)
    const cssW = Math.min(this.panel.body.clientWidth || 520, 640, Math.max(240, (innerHeight - 190) * aspect));
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssW / aspect}px`;
    // Boyut değişmedikçe tuvali yeniden ayırma (bilek güreşinde her kare çiziliyor)
    const cw = Math.round(cssW * dpr), ch = Math.round((cssW / aspect) * dpr);
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    const k = this.canvas.width / this.W;
    this.g.setTransform(k, 0, 0, k, 0, 0);
    this.g.clearRect(0, 0, this.W, this.H);
    if (t.kind === "satranc") this.drawChess(t, g?.kind === "satranc" ? g.state : null);
    else if (t.kind === "tavla") this.drawTavla(t, g?.kind === "tavla" ? g.state : null);
    else if (t.kind === "bilek") this.paintBilek(t);
    else this.drawOkey(t, g?.kind === "okey" ? g.state : null);
  }

  private paintBilek(t: TableState): void {
    const g = t.game?.kind === "bilek" ? t.game.state : null;
    const now = performance.now();
    const dt = this.paintAt ? Math.min(0.1, (now - this.paintAt) / 1000) : 1;
    this.paintAt = now;
    this.lean += ((g ? bilekLean(g) : 0) - this.lean) * (1 - Math.exp(-dt * 6));
    drawBilek(this.g, t, g, this.lean, this.myIndex(t), this.now());
    this.hits.push({ x: 0, y: 0, w: this.W, h: this.H, hit: { kind: "press" } });
    if (!this.raf)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        const cur = this.tables.get(this.id);
        if (this.isOpen && cur?.kind === "bilek") this.paint(cur);
        else this.paintAt = 0;
      });
  }

  private renderActions(t: TableState): void {
    const a = this.actions;
    a.replaceChildren();
    const seated = this.seated(t);
    const g = t.game;
    const over = !g || (g.kind === "tavla" || g.kind === "bilek" ? g.state.winner !== null : g.kind === "satranc" ? g.state.result !== null : g.state.winner !== null || g.state.draw);
    if (this.promo) {
      el("span", "", a, "Terfi:");
      for (const [p, label] of [["q", "♛ Vezir"], ["r", "♜ Kale"], ["b", "♝ Fil"], ["n", "♞ At"]]) {
        button(a, label, () => {
          this.send({ t: "tmove", id: t.id, move: { ...this.promo!, promo: p } });
          this.promo = null;
          this.render();
        });
      }
      return;
    }
    if (g?.kind === "okey" && this.myIndex(t) >= 0 && !over) {
      button(a, "🔀 Diz", () => this.autoSort(g.state));
      const mine = g.state.turn === this.myIndex(t) && g.state.phase === "discard";
      const at = button(a, "Taşı at", () => this.discard(t, false));
      const bitir = button(a, "🏁 Bitir", () => this.discard(t, true));
      at.disabled = bitir.disabled = !mine || this.pick === null;
    }
    if (seated && over && t.seats.filter(Boolean).length >= 2) button(a, g ? "🔁 Yeni oyun" : "▶️ Oyunu başlat", () => this.send({ t: "tstart", id: t.id }), "primary");
    if (seated && !over && this.myIndex(t) >= 0) button(a, "🏳️ Pes et", () => this.send({ t: "tresign", id: t.id }));
    if (seated) button(a, "🪑 Masadan kalk", () => this.send({ t: "tleave" }));
    if (!seated) el("span", "bg-watch", a, "👀 İzliyorsun · oynamak için boş tabureye otur (E)");
  }

  // ---------------------------------------------------------------------------
  // Satranç
  // ---------------------------------------------------------------------------

  private drawChess(t: TableState, s: ChessState | null): void {
    const g = this.g, C = 64;
    const myColor = this.myIndex(t) === 1 ? "b" : "w";
    const flip = myColor === "b";
    const pos = (i: number) => {
      const f = i & 7, r = i >> 3;
      return { x: (flip ? 7 - f : f) * C, y: (flip ? r : 7 - r) * C };
    };
    const board = s?.board ?? "RNBQKBNRPPPPPPPP" + ".".repeat(32) + "pppppppprnbqkbnr";
    const legal = s && this.sel !== null ? legalMoves(s).filter((m) => m.from === this.sel) : [];
    for (let i = 0; i < 64; i++) {
      const { x, y } = pos(i);
      const light = ((i & 7) + (i >> 3)) % 2 === 1;
      g.fillStyle = light ? "#ecd9b4" : "#a87a52";
      g.fillRect(x, y, C, C);
      if (s?.last && (s.last.from === i || s.last.to === i)) {
        g.fillStyle = "rgba(255, 220, 80, 0.35)";
        g.fillRect(x, y, C, C);
      }
      if (this.sel === i) {
        g.fillStyle = "rgba(80, 160, 255, 0.45)";
        g.fillRect(x, y, C, C);
      }
      const p = board[i];
      if (p !== ".") {
        const white = p === p.toUpperCase();
        if (s && p.toLowerCase() === "k" && inCheck(s, white ? "w" : "b")) {
          g.fillStyle = "rgba(230, 40, 40, 0.55)";
          g.beginPath();
          g.arc(x + C / 2, y + C / 2, C * 0.45, 0, Math.PI * 2);
          g.fill();
        }
        g.font = `${C * 0.78}px "Segoe UI Symbol", "Noto Sans Symbols 2", "DejaVu Sans", serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.lineWidth = 2.5;
        g.strokeStyle = white ? "#3a2a1a" : "#f2e6cc";
        g.fillStyle = white ? "#fbf7ee" : "#211a16";
        g.strokeText(GLYPH[p.toLowerCase()], x + C / 2, y + C / 2 + 3);
        g.fillText(GLYPH[p.toLowerCase()], x + C / 2, y + C / 2 + 3);
      }
      if (legal.some((m) => m.to === i)) {
        g.fillStyle = p !== "." ? "rgba(220, 50, 50, 0.5)" : "rgba(30, 30, 30, 0.35)";
        g.beginPath();
        g.arc(x + C / 2, y + C / 2, p !== "." ? C * 0.42 : C * 0.14, 0, Math.PI * 2);
        g.fill();
      }
      this.hits.push({ x, y, w: C, h: C, hit: { kind: "sq", i } });
    }
    // Kenar harfleri
    g.font = "600 11px Barlow, system-ui, sans-serif";
    g.fillStyle = "rgba(40, 25, 10, 0.75)";
    g.textAlign = "left";
    g.textBaseline = "top";
    for (let f = 0; f < 8; f++) {
      const { x } = pos(f);
      g.fillText("abcdefgh"[f], x + 3, 512 - 13);
    }
    if (s?.result) this.banner(s.result === "draw" ? `Berabere (${s.reason})` : `${s.result === "w" ? "Beyaz" : "Siyah"} kazandı (${s.reason})`);
    else if (s) this.turnTag(s.turn === myColor && this.myIndex(t) >= 0 ? "Sıra sende" : s.turn === "w" ? "Beyazın sırası" : "Siyahın sırası");
  }

  private clickChess(t: TableState, i: number): void {
    const g = t.game;
    if (g?.kind !== "satranc" || g.state.result) return;
    const s = g.state;
    const myColor = this.myIndex(t) === 1 ? "b" : "w";
    if (this.myIndex(t) < 0 || s.turn !== myColor) return;
    if (this.sel !== null) {
      const moves = legalMoves(s).filter((m) => m.from === this.sel && m.to === i);
      if (moves.length) {
        if (moves.length > 1) this.promo = { from: this.sel, to: i };
        else this.send({ t: "tmove", id: t.id, move: { from: this.sel, to: i } });
        this.sel = null;
        this.render();
        return;
      }
    }
    const p = s.board[i];
    this.sel = p !== "." && (p === p.toUpperCase() ? "w" : "b") === myColor && this.sel !== i ? i : null;
    this.render();
  }

  // ---------------------------------------------------------------------------
  // Tavla
  // ---------------------------------------------------------------------------

  private tavlaLayout(view: 0 | 1) {
    const w = 52, barW = 40, x0 = 20, y0 = 20, H = this.H;
    const col = (c: number) => (c < 6 ? x0 + c * w : x0 + 6 * w + barW + (c - 6) * w);
    /** Nokta → ekran sütunu ve satır (alt satır: oyuncunun evi sağ altta). */
    const place = (i: number) => {
      const d = view === 0 ? i : 23 - i;
      return d < 12 ? { c: 11 - d, bottom: true } : { c: d - 12, bottom: false };
    };
    return { w, barW, x0, y0, H, col, place, barX: x0 + 6 * w, offX: x0 + 12 * w + barW + 8 };
  }

  private drawTavla(t: TableState, s: TavlaState | null): void {
    const g = this.g;
    const me = this.myIndex(t);
    const view: 0 | 1 = me === 1 ? 1 : 0;
    const L = this.tavlaLayout(view);
    const W = this.W, H = this.H;
    g.fillStyle = "#5a3418";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#e3c896";
    g.fillRect(L.x0, L.y0, 12 * L.w + L.barW, H - 2 * L.y0);
    g.fillStyle = "#6b3f1f";
    g.fillRect(L.barX, L.y0, L.barW, H - 2 * L.y0);
    g.fillStyle = "#4a2a12";
    g.fillRect(L.offX, L.y0, W - L.offX - 10, H - 2 * L.y0);
    const moves = s ? tavlaMoves(s) : [];
    const mine = s && me >= 0 && s.turn === me;
    const targets = new Set(mine && this.sel !== null ? moves.filter((m) => m.from === this.sel).map((m) => m.to) : []);
    const sources = new Set(mine ? moves.map((m) => m.from) : []);
    for (let i = 0; i < 24; i++) {
      const { c, bottom } = L.place(i);
      const x = L.col(c);
      const base = bottom ? H - L.y0 : L.y0;
      const tip = bottom ? H - L.y0 - 200 : L.y0 + 200;
      g.fillStyle = c % 2 ? "#8a2f22" : "#2e4a6b";
      g.beginPath();
      g.moveTo(x + 2, base);
      g.lineTo(x + L.w - 2, base);
      g.lineTo(x + L.w / 2, tip);
      g.closePath();
      g.fill();
      if (targets.has(i)) {
        g.fillStyle = "rgba(90, 220, 120, 0.55)";
        g.fill();
      }
      this.hits.push({ x, y: bottom ? H / 2 : L.y0, w: L.w, h: H / 2 - L.y0, hit: { kind: "pt", i } });
      if (!s) continue;
      const n = Math.abs(s.points[i]);
      if (!n) continue;
      const white = s.points[i] > 0;
      const r = 22, step = n > 5 ? (180 - r * 2) / (n - 1) : r * 2;
      for (let k = 0; k < n; k++) {
        const cy = bottom ? base - r - k * step : base + r + k * step;
        this.checker(x + L.w / 2, cy, r, white, this.sel === i && k === n - 1 ? 2 : sources.has(i) && k === n - 1 ? 1 : 0);
      }
      if (n > 5) this.count(x + L.w / 2, bottom ? base - r - (n - 1) * step : base + r + (n - 1) * step, n);
    }
    if (s) {
      // Bar: izleyenin pulları altta, rakibinkiler üstte
      for (const side of [0, 1] as const) {
        const n = s.bar[side];
        const bottom = side === view;
        for (let k = 0; k < n; k++) this.checker(L.barX + L.barW / 2, bottom ? H / 2 + 34 + k * 30 : H / 2 - 34 - k * 30, 18, side === 0, side === me && this.sel === -1 ? 2 : side === me && sources.has(-1) ? 1 : 0);
        // Toplananlar
        const offN = s.off[side];
        for (let k = 0; k < offN; k++) {
          const yy = bottom ? H - L.y0 - 8 - k * 12 : L.y0 + 8 + k * 12;
          g.fillStyle = side === 0 ? "#f6f1e3" : "#24201c";
          g.fillRect(L.offX + 6, yy - 5, W - L.offX - 22, 10);
        }
      }
      this.hits.push({ x: L.barX, y: L.y0, w: L.barW, h: H - 2 * L.y0, hit: { kind: "bar" } });
      if (targets.has(-1)) {
        g.fillStyle = "rgba(90, 220, 120, 0.45)";
        g.fillRect(L.offX, H / 2, W - L.offX - 10, H / 2 - L.y0);
      }
      this.hits.push({ x: L.offX, y: L.y0, w: W - L.offX - 10, h: H - 2 * L.y0, hit: { kind: "off" } });
      // Zarlar: sıradakinin yarısında
      const dx = s.turn === view ? L.x0 + 9 * L.w + L.barW : L.x0 + 3 * L.w;
      s.rolled.forEach((d, k) => this.die(dx - 30 + k * 60, H / 2, d, s.dice.includes(d) || s.dice.length > s.rolled.length));
      if (s.winner !== null) this.banner(`${t.names[t.seats.indexOf(t.order[s.winner])] || (s.winner ? "Siyah" : "Beyaz")} kazandı${s.mars ? " (mars!)" : ""}`);
      else this.turnTag(mine ? (moves.length ? "Sıra sende: pul seç, sonra yeşil haneye" : "Oynayacak hamle yok…") : `${t.names[t.seats.indexOf(t.order[s.turn])] ?? ""} oynuyor`);
    }
  }

  private checker(x: number, y: number, r: number, white: boolean, mark: 0 | 1 | 2): void {
    const g = this.g;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = white ? "#f6f1e3" : "#24201c";
    g.fill();
    g.lineWidth = mark === 2 ? 4 : 2;
    g.strokeStyle = mark === 2 ? "#3bd16f" : mark === 1 ? "#f2c230" : white ? "#b9ab8c" : "#5a5048";
    g.stroke();
    g.beginPath();
    g.arc(x, y, r * 0.6, 0, Math.PI * 2);
    g.strokeStyle = white ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.12)";
    g.lineWidth = 1.5;
    g.stroke();
  }

  private count(x: number, y: number, n: number): void {
    const g = this.g;
    g.font = "700 16px Barlow, system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#e33";
    g.fillText(String(n), x, y);
  }

  private die(x: number, y: number, v: number, active: boolean): void {
    const g = this.g, s = 44;
    g.fillStyle = active ? "#fffdf6" : "rgba(255,253,246,0.45)";
    g.strokeStyle = "#333";
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(x - s / 2, y - s / 2, s, s, 8);
    g.fill();
    g.stroke();
    const pips: Record<number, [number, number][]> = {
      1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
      5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
    };
    g.fillStyle = "#222";
    for (const [px, py] of pips[v] ?? []) {
      g.beginPath();
      g.arc(x + px * 11, y + py * 11, 4.5, 0, Math.PI * 2);
      g.fill();
    }
  }

  private clickTavla(t: TableState, h: Hit): void {
    const g = t.game;
    if (g?.kind !== "tavla") return;
    const s = g.state;
    const me = this.myIndex(t);
    if (me < 0 || s.turn !== me || s.winner !== null) return;
    const moves = tavlaMoves(s);
    const at = h.kind === "pt" ? h.i : h.kind === "bar" ? -1 : h.kind === "off" ? -1 : null;
    if (at === null) return;
    // Hedef mi? (toplama için "off", bara hedef olmaz)
    if (this.sel !== null) {
      const dest = h.kind === "off" ? -1 : h.kind === "pt" ? h.i : null;
      const m = dest === null ? undefined : moves.filter((x) => x.from === this.sel && x.to === dest).sort((a, b) => a.die - b.die)[0];
      if (m) {
        this.send({ t: "tmove", id: t.id, move: m as TavlaMove });
        this.sel = null;
        this.render();
        return;
      }
    }
    const from = h.kind === "bar" ? -1 : h.kind === "pt" ? h.i : null;
    this.sel = from !== null && moves.some((m) => m.from === from) && this.sel !== from ? from : null;
    this.render();
  }

  // ---------------------------------------------------------------------------
  // Okey
  // ---------------------------------------------------------------------------

  private syncRack(hand: number[]): void {
    const set = new Set(hand);
    for (let i = 0; i < this.rack.length; i++) if (this.rack[i] !== null && !set.has(this.rack[i]!)) this.rack[i] = null;
    const placed = new Set(this.rack.filter((x) => x !== null));
    for (const id of hand) {
      if (placed.has(id)) continue;
      const free = this.rack.indexOf(null);
      if (free >= 0) this.rack[free] = id;
    }
    if (this.pick !== null && !set.has(this.pick)) this.pick = null;
  }

  private autoSort(s: OkeyView): void {
    // Renk, sonra sayı; okeyler (joker) sona
    const isOkey = (id: number) => {
      const tl = tileOf(id);
      return !!tl && tl.color === s.okey.color && tl.num === s.okey.num;
    };
    const key = (id: number) => {
      if (isOkey(id)) return 1000;
      const tl = tileOf(id) ?? s.okey;
      return tl.color * 20 + tl.num;
    };
    const sorted = [...s.hand].sort((a, b) => key(a) - key(b));
    this.rack = new Array(RACK * 2).fill(null);
    // Renk değişince bir boşluk bırak
    let slot = 0, prevColor = -1;
    for (const id of sorted) {
      const c = isOkey(id) ? 9 : (tileOf(id) ?? s.okey).color;
      if (prevColor >= 0 && c !== prevColor && slot % RACK !== 0) slot++;
      prevColor = c;
      if (slot >= RACK * 2) slot = this.rack.indexOf(null);
      this.rack[slot++] = id;
    }
    this.render();
  }

  private tile(x: number, y: number, id: number, s: OkeyView, w = 44, h = 60, highlight = false): void {
    const g = this.g;
    g.fillStyle = highlight ? "#fff6c2" : "#f7f2e4";
    g.strokeStyle = highlight ? "#f2a500" : "#b9ad8f";
    g.lineWidth = highlight ? 3 : 1.5;
    g.beginPath();
    g.roundRect(x, y, w, h, 6);
    g.fill();
    g.stroke();
    const tl = tileOf(id);
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (!tl) {
      // Sahte okey: yonca işareti
      g.fillStyle = "#2b8a4a";
      g.font = `700 ${h * 0.45}px Barlow, system-ui, sans-serif`;
      g.fillText("♣", x + w / 2, y + h * 0.48);
      return;
    }
    g.fillStyle = TILE_COLORS[tl.color];
    g.font = `800 ${h * 0.45}px Barlow, system-ui, sans-serif`;
    g.fillText(String(tl.num), x + w / 2, y + h * 0.42);
    g.beginPath();
    g.arc(x + w / 2, y + h * 0.78, 3.5, 0, Math.PI * 2);
    g.fill();
    if (tl.color === s.okey.color && tl.num === s.okey.num) {
      g.fillStyle = "#f2a500";
      g.font = "700 12px Barlow, system-ui, sans-serif";
      g.fillText("★", x + w - 8, y + 9);
    }
  }

  private drawOkey(t: TableState, s: OkeyView | null): void {
    const g = this.g, W = this.W, H = this.H;
    g.fillStyle = "#2f6d45";
    g.fillRect(0, 0, W, H);
    if (!s) {
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.font = "600 20px Barlow, system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText("2–4 kişi oturunca oyunu başlatın", W / 2, H / 2);
      return;
    }
    const me = this.myIndex(t);
    const n = s.players;
    const nameOf = (p: number) => t.names[t.seats.indexOf(t.order[p])] || "?";
    // Rakipler: benden sonraki sırayla sağ, üst, sol
    const spots = n === 2 ? [[W / 2, 40]] : n === 3 ? [[W - 90, 150], [90, 150]] : [[W - 90, 170], [W / 2, 40], [90, 170]];
    const base = me >= 0 ? me : 0;
    for (let k = 1; k < n; k++) {
      const p = (base + k) % n;
      const [x, y] = spots[k - 1];
      g.fillStyle = s.turn === p && s.winner === null ? "#f2c230" : "rgba(255,255,255,0.9)";
      g.font = "700 15px Barlow, system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText(`${nameOf(p)} · ${s.counts[p]} taş`, x, y);
      const top = s.discards[p][s.discards[p].length - 1];
      if (top !== undefined) this.tile(x - 20, y + 12, top, s, 40, 54);
    }
    // Orta: deste, gösterge
    g.fillStyle = "#e9e1cc";
    for (let k = 0; k < 4; k++) {
      g.beginPath();
      g.roundRect(W / 2 - 60 + k * 2, H / 2 - 70 - k * 2, 46, 62, 6);
      g.fill();
      g.strokeStyle = "#b9ad8f";
      g.stroke();
    }
    g.fillStyle = "#333";
    g.font = "700 14px Barlow, system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(`${s.pileCount}`, W / 2 - 31, H / 2 - 40);
    const myTurn = me >= 0 && s.turn === me && s.winner === null && !s.draw;
    if (myTurn && s.phase === "draw") {
      g.strokeStyle = "#5cff8a";
      g.lineWidth = 3;
      g.strokeRect(W / 2 - 66, H / 2 - 80, 60, 78);
    }
    this.hits.push({ x: W / 2 - 66, y: H / 2 - 80, w: 60, h: 78, hit: { kind: "pile" } });
    this.tile(W / 2 + 10, H / 2 - 74, s.indicator, s, 44, 60);
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.font = "600 12px Barlow, system-ui, sans-serif";
    g.fillText("Gösterge", W / 2 + 32, H / 2 - 82);
    g.fillText(`Okey: ${OKEY_COLORS[s.okey.color]} ${s.okey.num}`, W / 2, H / 2 + 6);
    // Soldakinin attığı (alınabilir) ve benim attıklarım
    if (me >= 0) {
      // Soldaki: benden önce oynayan (onun attığını alabilirim)
      const left = (me + n - 1) % n;
      const lt = s.discards[left][s.discards[left].length - 1];
      g.fillText("Soldan", 70, H - 225);
      if (lt !== undefined) {
        this.tile(48, H - 215, lt, s, 44, 60, myTurn && s.phase === "draw");
        this.hits.push({ x: 48, y: H - 215, w: 44, h: 60, hit: { kind: "left" } });
      }
      g.fillText("Attığın", W - 70, H - 225);
      const mt = s.discards[me][s.discards[me].length - 1];
      if (mt !== undefined) this.tile(W - 92, H - 215, mt, s, 44, 60);
      else {
        g.strokeStyle = "rgba(255,255,255,0.4)";
        g.setLineDash([5, 5]);
        g.strokeRect(W - 92, H - 215, 44, 60);
        g.setLineDash([]);
      }
      this.hits.push({ x: W - 100, y: H - 225, w: 60, h: 80, hit: { kind: "mine" } });
      // İstaka
      this.syncRack(s.hand);
      g.fillStyle = "#8a5a32";
      g.beginPath();
      g.roundRect(8, H - 150, W - 16, 142, 10);
      g.fill();
      for (let i = 0; i < RACK * 2; i++) {
        const x = 14 + (i % RACK) * 48.8, y = i < RACK ? H - 144 : H - 74;
        this.hits.push({ x, y, w: 48, h: 64, hit: { kind: "slot", i } });
        const id = this.rack[i];
        if (id === null || (this.drag?.moved && this.drag.slot === i)) {
          g.fillStyle = "rgba(0,0,0,0.12)";
          g.fillRect(x + 2, y + 2, 44, 60);
          continue;
        }
        this.tile(x + 2, y + 2, id, s, 44, 60, this.pick === id);
      }
      if (this.drag?.moved) {
        const id = this.rack[this.drag.slot];
        if (id !== null) this.tile(this.drag.x - 22, this.drag.y - 30, id, s, 44, 60, true);
      }
    }
    if (s.winner !== null) this.banner(`🏆 ${nameOf(s.winner)} eli bitirdi!`);
    else if (s.draw) this.banner("Ortada taş kalmadı: berabere");
    else if (myTurn) this.turnTag(s.phase === "draw" ? "Sıra sende: ortadan ya da soldan taş çek" : "Bir taş seç ve at (bitiyorsa 🏁 Bitir)");
    else this.turnTag(`${nameOf(s.turn)} oynuyor`);
  }

  private discard(t: TableState, finish: boolean): void {
    if (this.pick === null) return;
    this.send({ t: "tmove", id: t.id, move: { kind: "discard", tile: this.pick, finish } });
    this.pick = null;
  }

  // ---------------------------------------------------------------------------

  private banner(text: string): void {
    const g = this.g;
    g.fillStyle = "rgba(0,0,0,0.6)";
    g.fillRect(0, this.H / 2 - 28, this.W, 56);
    g.fillStyle = "#fff";
    g.font = "800 24px Barlow, system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, this.W / 2, this.H / 2);
  }

  private turnTag(text: string): void {
    this.info.textContent = `${this.info.textContent?.split("\n")[0] ?? ""}\n${text}`;
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.W, y: ((e.clientY - r.top) / r.height) * this.H };
  }

  private hitAt(x: number, y: number): Hit | null {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return h.hit;
    }
    return null;
  }

  private down(e: PointerEvent): void {
    const t = this.tables.get(this.id);
    if (!t) return;
    const p = this.local(e);
    const h = this.hitAt(p.x, p.y);
    if (!h) return;
    if (t.kind === "okey" && h.kind === "slot" && this.rack[h.i] !== null) {
      this.drag = { slot: h.i, x: p.x, y: p.y, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (t.kind === "satranc" && h.kind === "sq") this.clickChess(t, h.i);
    else if (t.kind === "tavla") this.clickTavla(t, h);
    else if (t.kind === "okey") this.clickOkey(t, h);
    else if (t.kind === "bilek" && this.myIndex(t) >= 0) this.press(t);
  }

  private move(e: PointerEvent): void {
    if (!this.drag) return;
    const p = this.local(e);
    if (!this.drag.moved && Math.hypot(p.x - this.drag.x, p.y - this.drag.y) < 6) return;
    this.drag.moved = true;
    this.drag.x = p.x;
    this.drag.y = p.y;
    this.render();
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const t = this.tables.get(this.id);
    const id = this.rack[d.slot];
    if (!t || id === null) return;
    if (!d.moved) {
      // Tıklama: seç / bırak
      this.pick = this.pick === id ? null : id;
      this.render();
      return;
    }
    const q = this.local(e);
    const h = this.hitAt(q.x, q.y);
    if (h?.kind === "slot") {
      [this.rack[d.slot], this.rack[h.i]] = [this.rack[h.i], this.rack[d.slot]];
    } else if (h?.kind === "mine") {
      this.pick = id;
      this.discard(t, false);
    }
    this.render();
  }

  private clickOkey(t: TableState, h: Hit): void {
    const g = t.game;
    if (g?.kind !== "okey") return;
    const s = g.state;
    const me = this.myIndex(t);
    if (me < 0 || s.turn !== me || s.winner !== null || s.draw) return;
    if (s.phase === "draw" && (h.kind === "pile" || h.kind === "left")) {
      this.send({ t: "tmove", id: t.id, move: { kind: "draw", from: h.kind === "pile" ? "pile" : "left" } });
    } else if (s.phase === "discard" && h.kind === "mine" && this.pick !== null) this.discard(t, false);
  }
}

