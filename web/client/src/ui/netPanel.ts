// Ağ paneli: anlık ping (hızlı yol ve WebSocket), dalgalanma, kayıp, çizim gecikmesi, takılma, bant genişliği;
// iki canlı grafik (üzerine gelince o anın değerleri) ve aynı değerlerin özet tablosu.
// DOM saniyede beş kez güncellenir (kare başına değil); grafikler canvas'ta. Renkler CSS'te (.netpanel).
import { SEND_HZ, TICK_HZ } from "../../../shared/constants";
import type { Net } from "../net";
import { NEED_BUCKET_MS, SPAN_MS, type Series } from "../netstats";

const REFRESH_MS = 200;
/** Teslim grafiği daha kısa süreye bakar: sütunlar okunur kalsın. */
const FEED_SPAN_MS = 30_000;
/** Bu kadar boşluktan sonra çizgi kesilir (ölçüm yoktu: yol kapalı, sekme arka planda). */
const GAP_MS = 5000;
const PAD = { l: 30, r: 8, t: 6, b: 16 };

type Quality = "good" | "warning" | "serious";
const QUALITY: Record<Quality, { icon: string; label: string }> = {
  good: { icon: "●", label: "İyi" },
  warning: { icon: "▲", label: "Orta" },
  serious: { icon: "■", label: "Zayıf" },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
}

const ms = (v: number) => (Number.isFinite(v) ? `${Math.round(v)}` : "—");
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}` : "—");
const kb = (v: number) => (Number.isFinite(v) ? (v >= 10_240 ? (v / 1024).toFixed(0) : (v / 1024).toFixed(1)) : "—");
/** Kanal payı: gelen/giden baytın ne kadarı hızlı yoldan. */
const share = (r: { udp: number; ws: number }) => (r.udp + r.ws > 0 ? `UDP'den %${Math.round((r.udp / (r.udp + r.ws)) * 100)}` : "—");
const ago = (s: number) => (s < 0.5 ? "şimdi" : `${s.toFixed(1).replace(".", ",")} sn önce`);

/** Eksenin üst sınırı: verinin biraz üstünde, yuvarlak bir sayı. */
function niceMax(v: number): number {
  for (const n of [50, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 5000]) if (v * 1.1 <= n) return n;
  return Math.ceil(v / 1000) * 1000;
}

interface Colors {
  udp: string;
  ws: string;
  delay: string;
  need: string;
  late: string;
  grid: string;
  axis: string;
  label: string;
  cross: string;
  surface: string;
}

interface Row {
  key: string;
  value: string;
  label: string;
}

/** Tek eksenli küçük zaman grafiği: ızgara, eksen etiketleri, üzerine gelince dikey çizgi. */
class Plot {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  /** Üzerine gelinen x (css px), yoksa null. */
  hover: number | null = null;

  constructor(parent: HTMLElement, label: string, onHover: () => void) {
    this.canvas = el("canvas", "np-canvas", parent);
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", label);
    this.ctx = this.canvas.getContext("2d")!;
    this.canvas.addEventListener("pointermove", (e) => {
      this.hover = Math.max(PAD.l, Math.min(this.w - PAD.r, e.offsetX));
      onHover();
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      onHover();
    });
    // Klavye: odakta en yeni an, oklarla geriye/ileriye
    this.canvas.addEventListener("focus", () => {
      this.hover = this.w - PAD.r;
      onHover();
    });
    this.canvas.addEventListener("blur", () => {
      this.hover = null;
      onHover();
    });
    this.canvas.addEventListener("keydown", (e) => {
      if (this.hover === null || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      e.stopPropagation();
      const step = (this.w - PAD.l - PAD.r) / 30;
      this.hover = Math.max(PAD.l, Math.min(this.w - PAD.r, this.hover + (e.key === "ArrowLeft" ? -step : step)));
      onHover();
    });
  }

  /** Boyutu ve piksel oranını günceller, temizler. */
  begin(): void {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w !== this.w || h !== this.h || this.canvas.width !== Math.round(w * dpr)) {
      this.w = w;
      this.h = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
  }

  x(t: number, now: number, span: number): number {
    return PAD.l + ((t - (now - span)) / span) * (this.w - PAD.l - PAD.r);
  }

  y(v: number, max: number): number {
    return this.h - PAD.b - (Math.min(v, max) / max) * (this.h - PAD.t - PAD.b);
  }

  /** Üzerine gelinen x'in zamanı. */
  timeAt(x: number, now: number, span: number): number {
    return now - span + ((x - PAD.l) / (this.w - PAD.l - PAD.r)) * span;
  }

  /** Izgara (0, yarı, üst), y etiketleri ve zaman etiketleri. */
  axes(max: number, span: number, c: Colors): void {
    const { ctx } = this;
    ctx.font = "500 10px Barlow, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (const v of [0, max / 2, max]) {
      const y = Math.round(this.y(v, max)) + 0.5;
      ctx.strokeStyle = v === 0 ? c.axis : c.grid;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(this.w - PAD.r, y);
      ctx.stroke();
      ctx.fillStyle = c.label;
      ctx.textAlign = "right";
      ctx.fillText(`${v}`, PAD.l - 5, y);
    }
    ctx.textBaseline = "alphabetic";
    const s = span / 1000;
    ctx.textAlign = "left";
    ctx.fillText(`−${s} sn`, PAD.l, this.h - 3);
    ctx.textAlign = "center";
    ctx.fillText(`−${s / 2}`, PAD.l + (this.w - PAD.l - PAD.r) / 2, this.h - 3);
    ctx.textAlign = "right";
    ctx.fillText("şimdi", this.w - PAD.r, this.h - 3);
  }

  /** 2 px çizgi; uzun boşlukta kesilir. Son nokta: 2 px yüzey halkalı uç noktası. */
  line(series: Series, now: number, span: number, max: number, color: string, c: Colors): void {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.beginPath();
    let prevT = -Infinity;
    let lx = NaN;
    let ly = NaN;
    series.each(now - span, (t, v) => {
      const x = this.x(t, now, span);
      const y = this.y(v, max);
      if (t - prevT > GAP_MS) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      prevT = t;
      lx = x;
      ly = y;
    });
    ctx.stroke();
    if (Number.isFinite(lx) && now - prevT < GAP_MS) {
      ctx.fillStyle = c.surface;
      ctx.beginPath();
      ctx.arc(lx, ly, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lx, ly, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  crosshair(c: Colors): void {
    if (this.hover === null) return;
    const x = Math.round(this.hover) + 0.5;
    this.ctx.strokeStyle = c.cross;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(x, PAD.t);
    this.ctx.lineTo(x, this.h - PAD.b);
    this.ctx.stroke();
  }
}

export class NetPanel {
  readonly root: HTMLDivElement;
  private colors: Colors;
  private quality: HTMLSpanElement;
  private transport: HTMLSpanElement;
  private tiles = new Map<string, { value: HTMLElement; sub: HTMLElement }>();
  private pingPlot: Plot;
  private feedPlot: Plot;
  private pingLegend: HTMLElement[] = [];
  private feedLegend: HTMLElement[] = [];
  private cells = new Map<string, HTMLTableCellElement[]>();
  private foot: HTMLDivElement;
  private tip: HTMLDivElement;
  private last = 0;
  private now = 0;

  constructor(
    parent: HTMLElement,
    private net: Net,
    onClose: () => void,
  ) {
    this.root = el("div", "panel netpanel", parent);
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Ağ durumu");
    const css = getComputedStyle(this.root);
    const v = (name: string) => css.getPropertyValue(name).trim();
    this.colors = {
      udp: v("--np-udp"),
      ws: v("--np-ws"),
      delay: v("--np-delay"),
      need: v("--np-need"),
      late: v("--np-late"),
      grid: v("--np-grid"),
      axis: v("--np-axis"),
      label: v("--np-label"),
      cross: v("--np-cross"),
      surface: v("--np-surface"),
    };

    const head = el("div", "np-head", this.root);
    el("h3", "", head, "AĞ");
    this.transport = el("span", "np-badge", head);
    this.quality = el("span", "np-quality", head);
    const close = el("button", "np-close", head, "×");
    close.setAttribute("aria-label", "Ağ panelini kapat");
    close.addEventListener("click", onClose);

    const tiles = el("div", "np-tiles", this.root);
    for (const [key, label] of [
      ["ping", "Ping"],
      ["jitter", "Dalgalanma"],
      ["loss", "Kayıp"],
      ["delay", "Gecikme"],
      ["starve", "Takılma"],
      ["snaps", "Snapshot"],
      ["in", "Gelen"],
      ["out", "Giden"],
    ] as const) {
      const t = el("div", "np-tile", tiles);
      el("div", "np-tile-label", t, label);
      this.tiles.set(key, { value: el("div", "np-tile-value", t), sub: el("div", "np-tile-sub", t) });
    }

    const redraw = () => this.draw();
    const ping = el("figure", "np-chart", this.root);
    el("figcaption", "", ping, "Ping (ms) · son 60 sn");
    const pl = el("div", "np-legend", ping);
    this.pingLegend = [this.legend(pl, "line", "--np-udp"), this.legend(pl, "line", "--np-ws")];
    this.pingPlot = new Plot(ping, "Ping grafiği, son 60 saniye", redraw);

    const feed = el("figure", "np-chart", this.root);
    el("figcaption", "", feed, "Teslim (ms) · son 30 sn");
    const fl = el("div", "np-legend", feed);
    this.feedLegend = [this.legend(fl, "line", "--np-delay"), this.legend(fl, "rect", "--np-need"), this.legend(fl, "rect", "--np-late")];
    this.feedPlot = new Plot(feed, "Teslim grafiği: çizim gecikmesi ve en geç gelen örnek, son 30 saniye", redraw);

    const table = el("table", "np-table", this.root);
    const hr = el("tr", "", el("thead", "", table));
    for (const h of ["son 60 sn", "şimdi", "ort", "en az", "en çok"]) el("th", "", hr, h);
    const body = el("tbody", "", table);
    for (const [key, label] of [
      ["udp", "Ping · UDP"],
      ["ws", "Ping · WebSocket"],
      ["delay", "Çizim gecikmesi"],
      ["need", "En geç örnek"],
    ] as const) {
      const tr = el("tr", "", body);
      el("th", "", tr, label).scope = "row";
      this.cells.set(key, [0, 1, 2, 3].map(() => el("td", "", tr)));
    }
    el("div", "np-note", this.root, "ms · gelen/giden yalnızca yük (başlıklar hariç)");
    this.foot = el("div", "np-foot", this.root);
    this.tip = el("div", "np-tip", this.root);
    this.tip.setAttribute("role", "tooltip");
    net.stats.live = true;
  }

  private legend(parent: HTMLElement, shape: "line" | "rect", color: string): HTMLElement {
    const item = el("span", "np-key", parent);
    const sw = el("i", `np-swatch ${shape}`, item);
    sw.style.background = `var(${color})`;
    return el("span", "", item);
  }

  destroy(): void {
    this.net.stats.live = false;
    this.root.remove();
  }

  /** Her kare çağrılır; saniyede beş kez yazar. */
  update(now: number): void {
    if (now - this.last < REFRESH_MS) return;
    this.last = now;
    this.now = now;
    const { net } = this;
    const s = net.stats;
    const udp = net.udp;
    const rtt = net.rtt;
    const since = now - SPAN_MS;

    this.transport.textContent = udp ? "UDP · WebRTC" : net.status === "online" ? "WebSocket" : "bağlantı yok";
    const starve = s.starve.summary(now - 10_000)?.avg ?? 0;
    const loss = udp ? s.loss : NaN;
    const jitter = udp ? s.jitter : NaN;
    const q: Quality =
      rtt > 150 || loss > 0.03 || jitter > 30 || starve > 0.03
        ? "serious"
        : rtt > 80 || loss > 0.01 || jitter > 15 || starve > 0.01
          ? "warning"
          : "good";
    const qi = QUALITY[q];
    this.quality.className = `np-quality ${q}`;
    this.quality.textContent = "";
    el("b", "", this.quality, qi.icon);
    this.quality.append(` ${qi.label}`);

    this.tile("ping", ms(rtt), "ms", udp ? "UDP yolu" : "WebSocket");
    this.tile("jitter", ms(jitter), "ms", udp ? "ardışık fark" : "yalnız UDP");
    this.tile("loss", pct(loss), "%", udp ? "son 30 sn" : "yalnız UDP");
    this.tile("delay", ms(net.interp.delay), "ms", `hedef ${ms(net.interp.target)}`);
    this.tile("starve", pct(starve), "%", "son 10 sn");
    this.tile("snaps", ms(s.snapshots.last()), "/sn", `yayın ${TICK_HZ} Hz`);
    this.tile("in", kb(s.rateIn.udp + s.rateIn.ws), "kB/sn", share(s.rateIn));
    this.tile("out", kb(s.rateOut.udp + s.rateOut.ws), "kB/sn", share(s.rateOut));

    this.pingLegend[0].textContent = `UDP ${ms(s.udp.median(5))} ms`;
    this.pingLegend[1].textContent = `WebSocket ${ms(net.wsRtt)} ms`;
    this.feedLegend[0].textContent = `Gecikme ${ms(net.interp.delay)} ms`;
    this.feedLegend[1].textContent = "En geç örnek";
    this.feedLegend[2].textContent = "⚠ Geç kaldı";

    const need = s.needMax.summary(since);
    this.row("udp", s.udp.summary(since));
    this.row("ws", s.ws.summary(since));
    this.row("delay", s.delay.summary(since));
    this.row("need", need);

    const p = net.clockPending;
    this.foot.textContent =
      `Saat farkı ${net.offset >= 0 ? "+" : "−"}${Math.abs(net.offset).toFixed(0)} ms · düzeltme ${Math.abs(p) < 0.5 ? "yok" : `${p.toFixed(1)} ms kaldı`}` +
      ` · gönderim ${SEND_HZ} Hz`;
    this.draw();
  }

  private tile(key: string, value: string, unit: string, sub: string): void {
    const t = this.tiles.get(key)!;
    t.value.textContent = value;
    if (value !== "—") el("small", "", t.value, ` ${unit}`);
    t.sub.textContent = sub;
  }

  private row(key: string, sum: { now: number; avg: number; min: number; max: number } | null): void {
    const c = this.cells.get(key)!;
    const v = sum ? [sum.now, sum.avg, sum.min, sum.max] : [NaN, NaN, NaN, NaN];
    v.forEach((x, i) => (c[i].textContent = ms(x)));
  }

  private draw(): void {
    const now = this.now;
    if (!now) return;
    const s = this.net.stats;
    const c = this.colors;
    const rows: Row[] = [];
    let head = "";
    let anchor: Plot | null = null;

    // Ping: iki seri, tek eksen
    const pp = this.pingPlot;
    pp.begin();
    let pmax = 0;
    s.udp.each(now - SPAN_MS, (_t, v) => (pmax = Math.max(pmax, v)));
    s.ws.each(now - SPAN_MS, (_t, v) => (pmax = Math.max(pmax, v)));
    const pm = niceMax(pmax || 50);
    pp.axes(pm, SPAN_MS, c);
    pp.line(s.ws, now, SPAN_MS, pm, c.ws, c);
    pp.line(s.udp, now, SPAN_MS, pm, c.udp, c);
    pp.crosshair(c);
    if (pp.hover !== null) {
      const t = pp.timeAt(pp.hover, now, SPAN_MS);
      head = ago((now - t) / 1000);
      rows.push({ key: c.udp, value: `${ms(s.udp.nearest(t, 1500))} ms`, label: "UDP" });
      rows.push({ key: c.ws, value: `${ms(s.ws.nearest(t, 2500))} ms`, label: "WebSocket" });
      anchor = pp;
    }

    // Teslim: 500 ms'lik dilimlerin en geç örneği (sütun) ve çizim gecikmesi (çizgi)
    const fp = this.feedPlot;
    fp.begin();
    const buckets: { t: number; v: number; d: number }[] = [];
    const delayAt = (t: number) => {
      let d = 0;
      s.delay.each(t, (ti, v) => {
        if (ti < t + NEED_BUCKET_MS) d = Math.max(d, v);
      });
      return d || s.delay.nearest(t, 1000);
    };
    s.needMax.each(now - FEED_SPAN_MS, (t, v) => buckets.push({ t, v, d: delayAt(t) }));
    const open = s.openBucket();
    if (open && open.t >= now - FEED_SPAN_MS) buckets.push({ ...open, d: delayAt(open.t) });
    let fmax = 0;
    for (const b of buckets) fmax = Math.max(fmax, b.v);
    s.delay.each(now - FEED_SPAN_MS, (_t, v) => (fmax = Math.max(fmax, v)));
    const fm = niceMax(Math.min(fmax || 50, 2000));
    fp.axes(fm, FEED_SPAN_MS, c);
    const slot = ((fp.w - PAD.l - PAD.r) * NEED_BUCKET_MS) / FEED_SPAN_MS;
    const bw = Math.max(1, Math.min(24, slot - 2));
    for (const b of buckets) {
      const x = fp.x(b.t, now, FEED_SPAN_MS) + (slot - bw) / 2;
      if (x < PAD.l) continue;
      const y = fp.y(b.v, fm);
      const base = fp.h - PAD.b;
      const r = Math.min(4, bw / 2, base - y);
      fp.ctx.fillStyle = b.v > b.d ? c.late : c.need;
      fp.ctx.beginPath();
      fp.ctx.roundRect(x, y, bw, base - y, [r, r, 0, 0]);
      fp.ctx.fill();
    }
    fp.line(s.delay, now, FEED_SPAN_MS, fm, c.delay, c);
    fp.crosshair(c);
    if (fp.hover !== null) {
      const t = fp.timeAt(fp.hover, now, FEED_SPAN_MS);
      head = ago((now - t) / 1000);
      rows.length = 0;
      const b = buckets.find((x) => t >= x.t && t < x.t + NEED_BUCKET_MS);
      rows.push({ key: c.delay, value: `${ms(s.delay.nearest(t, 500))} ms`, label: "Çizim gecikmesi" });
      rows.push({ key: c.need, value: b ? `${ms(b.v)} ms` : "—", label: b ? "En geç örnek" : "Hareket eden yoktu" });
      if (b && b.v > b.d) rows.push({ key: c.late, value: "⚠", label: "Gecikmeyi aştı: ileri tahmin" });
      anchor = fp;
    }
    this.showTip(anchor, head, rows);
  }

  private showTip(plot: Plot | null, head: string, rows: Row[]): void {
    if (!plot || plot.hover === null) {
      this.tip.classList.remove("show");
      return;
    }
    this.tip.textContent = "";
    el("div", "np-tip-head", this.tip, head);
    for (const r of rows) {
      const line = el("div", "np-tip-row", this.tip);
      el("i", "np-swatch line", line).style.background = r.key;
      el("b", "", line, r.value);
      el("span", "", line, r.label);
    }
    // Panelin içinde, imlecin yanında; sağa sığmazsa soluna
    const cr = plot.canvas.getBoundingClientRect();
    const pr = this.root.getBoundingClientRect();
    this.tip.classList.add("show");
    const tw = this.tip.offsetWidth;
    let left = cr.left - pr.left + plot.hover + 12;
    if (left + tw > pr.width - 6) left = cr.left - pr.left + plot.hover - tw - 12;
    this.tip.style.left = `${Math.max(6, left)}px`;
    this.tip.style.top = `${cr.top - pr.top + this.root.scrollTop + 4}px`;
  }
}
