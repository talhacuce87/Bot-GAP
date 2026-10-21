// Oyuncak pist arayüzü: lobi (oyuncular, pist seçimi, başlat), yarış göstergesi (tur, sıra, süre, nitro,
// drift, geri sayım), sonuç tablosu ve dokunmatik tuşlar.
import type { RaceState } from "../../../shared/protocol";
import { RACE, trackOf, TRACKS } from "../../../shared/race";

export interface RaceUiHooks {
  leave(): void;
  track(i: number): void;
  start(): void;
}

export interface RaceHudInfo {
  lap: number;
  place: number;
  count: number;
  /** Yarış süresi (ms). */
  time: number;
  nitro: number;
  drift: boolean;
  boost: boolean;
  /** Geri sayım (sn, > 0 iken) ya da "BAŞLA" (0 < x < 1 sn sonrası). */
  countdown: number;
  /** Bitirdiysem sıram (0 değil). */
  finished: number;
  /** Kısa süreli büyük yazı ("SON TUR!"), yoksa boş. */
  flash: string;
  standings: { name: string; color: string; lap: number; done: boolean }[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.append(e);
  return e;
}

/** Pistin küçük haritası (SVG yolu). */
function trackSvg(i: number): string {
  const t = trackOf(i);
  let d = "";
  for (let k = 0; k < t.n; k += 3) d += `${k ? "L" : "M"}${t.px[k].toFixed(1)} ${t.pz[k].toFixed(1)}`;
  const sx = t.px[0], sz = t.pz[0];
  return `<svg viewBox="-56 -40 112 80"><path d="${d}Z" fill="none" stroke="#2b2f3a" stroke-width="13" stroke-linejoin="round"/><path d="${d}Z" fill="none" stroke="#e8e8e0" stroke-width="1.2" stroke-dasharray="3 4"/><rect x="${(sx - 1.5).toFixed(1)}" y="${(sz - 6).toFixed(1)}" width="3" height="12" fill="#ffffff"/></svg>`;
}

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(2).padStart(5, "0")}`;

export class RaceUi {
  private panel: HTMLDivElement;
  private hud: HTMLDivElement;
  private touchPad: HTMLDivElement | null = null;
  private big: HTMLDivElement;
  private lapEl: HTMLSpanElement;
  private placeEl: HTMLSpanElement;
  private timeEl: HTMLSpanElement;
  private nitroFill: HTMLDivElement;
  private driftEl: HTMLDivElement;
  private standEl: HTMLOListElement;
  private panelKey = "";
  /** Dokunmatik tuşların anlık durumu. */
  readonly touch = { left: false, right: false, gas: false, brake: false, drift: false, nitro: false };

  constructor(
    root: HTMLElement,
    touch: boolean,
    private hooks: RaceUiHooks,
  ) {
    this.panel = el("div", "race-panel", root);
    this.hud = el("div", "race-hud", root);
    const top = el("div", "race-top", this.hud);
    const box = (label: string) => {
      const b = el("div", "race-stat", top);
      el("small", "", b).textContent = label;
      return el("span", "", b);
    };
    this.lapEl = box("TUR");
    this.placeEl = box("SIRA");
    this.timeEl = box("SÜRE");
    const quit = el("button", "race-quit", this.hud);
    quit.textContent = "✕ Yarıştan çık";
    quit.addEventListener("click", () => this.hooks.leave());
    this.standEl = el("ol", "race-stand", this.hud);
    const bottom = el("div", "race-bottom", this.hud);
    this.driftEl = el("div", "race-drift", bottom);
    this.driftEl.textContent = "DRIFT · NİTRO DOLUYOR";
    const nitro = el("div", "race-nitro", bottom);
    el("span", "race-nitro-label", nitro).innerHTML = touch ? "NİTRO" : "<kbd>E</kbd> NİTRO";
    this.nitroFill = el("div", "race-nitro-fill", el("div", "race-nitro-bar", nitro));
    if (!touch) el("div", "race-keys", bottom).innerHTML = "<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> sür · <kbd>Space</kbd> drift · <kbd>E</kbd> nitro";
    this.big = el("div", "race-big", this.hud);
    if (touch) this.buildTouch(root);
  }

  private buildTouch(root: HTMLElement): void {
    const pad = (this.touchPad = el("div", "race-touch", root));
    const btn = (parent: HTMLElement, text: string, key: keyof RaceUi["touch"], cls = "") => {
      const b = el("button", cls, parent);
      b.textContent = text;
      const set = (on: boolean) => (e: PointerEvent) => {
        e.preventDefault();
        this.touch[key] = on;
        b.classList.toggle("on", on);
      };
      b.addEventListener("pointerdown", set(true));
      for (const ev of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(ev, set(false) as EventListener);
    };
    const left = el("div", "race-touch-l", pad), right = el("div", "race-touch-r", pad);
    btn(left, "◀", "left");
    btn(left, "▶", "right");
    btn(right, "DRIFT", "drift", "small");
    btn(right, "NİTRO", "nitro", "small");
    btn(right, "FREN", "brake");
    btn(right, "GAZ", "gas", "gas");
  }

  /** Lobi/sonuç paneli (`state` null ya da ben yoksam kapalı). */
  setPanel(s: RaceState | null, you: number, nameOf: (sid: number) => string, colorOf: (sid: number) => string, now: number): void {
    const mine = !!s && s.players.some((p) => p.sid === you);
    const show = mine && (s!.phase === "lobby" || s!.phase === "end");
    this.panel.classList.toggle("show", show);
    if (!show || !s) {
      this.panelKey = "";
      return;
    }
    // Yalnızca durum değişince yeniden çiz (geri sayım yazısı hariç)
    const key = JSON.stringify([s.phase, s.host, s.track, s.players, Math.ceil((s.endsAt - now) / 1000)]);
    if (key === this.panelKey) return;
    this.panelKey = key;
    const host = s.host === you;
    this.panel.replaceChildren();
    const head = el("div", "race-head", this.panel);
    el("h3", "", head).textContent = "🏎️ OYUNCAK PİST";
    el("span", "race-count", head).textContent = `${s.players.length}/${RACE.max} oyuncu`;

    if (s.phase === "end") {
      el("div", "race-sub", this.panel).textContent = `${TRACKS[s.track].emoji} ${TRACKS[s.track].name} · sonuçlar`;
      const list = el("ol", "race-results", this.panel);
      for (const p of [...s.players].sort((a, b) => a.place - b.place)) {
        const li = el("li", p.place === 1 && p.time ? "win" : "", list);
        el("b", "", li).textContent = `${p.place}.`;
        const dot = el("i", "", li);
        dot.style.background = colorOf(p.sid);
        el("span", "", li).textContent = nameOf(p.sid);
        el("em", "", li).textContent = p.time ? fmt(p.time) : "bitiremedi";
      }
      el("div", "race-sub", this.panel).textContent = `Lobiye dönülüyor… ${Math.max(0, Math.ceil((s.endsAt - now) / 1000))}`;
    } else {
      const list = el("ul", "race-players", this.panel);
      for (const p of s.players) {
        const li = el("li", "", list);
        const dot = el("i", "", li);
        dot.style.background = colorOf(p.sid);
        el("span", "", li).textContent = `${nameOf(p.sid)}${p.sid === s.host ? " 👑" : ""}${p.sid === you ? " (sen)" : ""}`;
      }
      el("div", "race-sub", this.panel).textContent = host ? "Pisti seç ve başlat (en az 2 kişi)" : `Pisti ${nameOf(s.host)} seçiyor ve başlatacak`;
      const grid = el("div", "race-tracks", this.panel);
      TRACKS.forEach((t, i) => {
        const b = el("button", `race-track${i === s.track ? " on" : ""}`, grid);
        b.disabled = !host;
        b.innerHTML = trackSvg(i);
        el("span", "", b).textContent = `${t.emoji} ${t.name}`;
        b.addEventListener("click", () => this.hooks.track(i));
      });
    }
    const foot = el("div", "race-foot", this.panel);
    const leave = el("button", "", foot);
    leave.textContent = "Ayrıl";
    leave.addEventListener("click", () => this.hooks.leave());
    if (host) {
      const start = el("button", "primary", foot);
      start.textContent = s.phase === "end" ? "Tekrar yarış 🏁" : "Başlat 🏁";
      start.disabled = s.players.length < RACE.min;
      start.addEventListener("click", () => this.hooks.start());
    }
  }

  /** Yarış göstergesi (null: kapalı). */
  setHud(info: RaceHudInfo | null): void {
    this.hud.classList.toggle("show", !!info);
    this.touchPad?.classList.toggle("show", !!info && !info.finished);
    if (!info) return;
    this.lapEl.textContent = `${Math.max(1, Math.min(RACE.laps, info.lap))}/${RACE.laps}`;
    this.placeEl.textContent = `${info.place}/${info.count}`;
    this.timeEl.textContent = fmt(Math.max(0, info.time));
    this.nitroFill.style.width = `${Math.round(info.nitro * 100)}%`;
    this.nitroFill.classList.toggle("boost", info.boost);
    this.nitroFill.classList.toggle("full", info.nitro > 0.99);
    this.driftEl.classList.toggle("on", info.drift);
    const big = info.finished ? `🏁 ${info.finished}. oldun!` : info.countdown > 0 ? String(Math.ceil(info.countdown)) : info.countdown > -1 ? "BAŞLA!" : info.flash;
    this.big.textContent = big;
    this.big.className = `race-big${big ? " show" : ""}${info.countdown > 0 ? " count" : ""}`;
    this.standEl.replaceChildren(
      ...info.standings.map((s) => {
        const li = el("li", s.done ? "done" : "");
        const dot = el("i", "", li);
        dot.style.background = s.color;
        el("span", "", li).textContent = s.name;
        return li;
      }),
    );
  }

  dispose(): void {
    this.panel.remove();
    this.hud.remove();
    this.touchPad?.remove();
  }
}
