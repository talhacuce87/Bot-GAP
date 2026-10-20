// İzleme odası kontrolleri: herkes oynat/durdur/sar ve link değiştirebilir.
// Kare başına DOM'a dokunulmaz; süre göstergesi saniyede 4 kez güncellenir.
import type { WatchState } from "../../../shared/protocol";
import type { WatchSync } from "../watch/sync";

const OP_TEXT: Record<string, string> = {
  load: "yeni video açtı",
  play: "oynattı",
  pause: "duraklattı",
  seek: "ileri/geri sardı",
};

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "--:--";
  const s = Math.floor(t);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}

export interface WatchActions {
  command(op: "play" | "pause" | "seek", pos?: number): void;
  load(url: string): void;
  setInteractive(on: boolean): void;
  /** Videoyu tam ekran yap / çık; desteklenmiyorsa null (düğme gösterilmez). */
  fullscreen: (() => void) | null;
}

export class WatchPanel {
  private root: HTMLDivElement;
  private title: HTMLDivElement;
  private playBtn: HTMLButtonElement;
  private seek: HTMLInputElement;
  private time: HTMLSpanElement;
  private toast: HTMLDivElement;
  private start: HTMLButtonElement;
  private interactBtn: HTMLButtonElement;
  private interactive = false;
  private dragging = false;
  private lastUpdate = 0;
  private toastTimer = 0;
  private lastOp = "";

  constructor(
    hud: HTMLElement,
    private sync: WatchSync,
    private actions: WatchActions,
  ) {
    this.root = el("div", "panel watch", hud);
    this.title = el("div", "watch-title", this.root, "Watch party");
    const row = el("div", "watch-row", this.root);
    this.playBtn = el("button", "watch-btn", row, "⏸");
    this.playBtn.addEventListener("click", () => {
      const s = this.sync.state;
      if (s) this.actions.command(s.playing ? "pause" : "play", this.sync.target());
    });
    this.seek = el("input", "watch-seek", row);
    this.seek.type = "range";
    this.seek.min = "0";
    this.seek.step = "1";
    this.seek.addEventListener("pointerdown", () => (this.dragging = true));
    this.seek.addEventListener("change", () => {
      this.dragging = false;
      this.actions.command("seek", Number(this.seek.value));
    });
    this.time = el("span", "watch-time", row, "--:--");
    const full = this.actions.fullscreen;
    if (full) {
      const fs = el("button", "watch-btn small", row, "⛶");
      fs.title = "Tam ekran (Esc ile çık)";
      fs.addEventListener("click", () => full());
    }

    const row2 = el("div", "watch-row", this.root);
    el("span", "watch-label", row2, "🔊");
    const vol = el("input", "watch-vol", row2);
    vol.type = "range";
    vol.min = "0";
    vol.max = "1";
    vol.step = "0.05";
    vol.value = String(this.sync.userVolume);
    vol.addEventListener("input", () => this.sync.setVolume(Number(vol.value)));
    const link = el("input", "watch-link", row2);
    link.placeholder = "Yeni link yapıştır…";
    link.addEventListener("keydown", (e) => {
      e.stopPropagation(); // WASD yürümesin
      if (e.key === "Enter" && link.value.trim()) {
        this.actions.load(link.value.trim());
        link.value = "";
        link.blur();
      }
    });
    this.interactBtn = el("button", "watch-btn small", row2, "🖱");
    this.interactBtn.title = "Etkileşim modu: oynatıcıya doğrudan tıkla (ör. Kick'te sesi açmak için)";
    this.interactBtn.addEventListener("click", () => {
      this.interactive = !this.interactive;
      this.interactBtn.classList.toggle("on", this.interactive);
      this.actions.setInteractive(this.interactive);
    });

    this.toast = el("div", "panel toast", hud);
    this.start = el("button", "watch-start", hud, "🍿 İzlemeye başla (sesi aç)");
    this.start.addEventListener("click", () => {
      this.sync.unlock();
      this.start.remove();
    });
  }

  /** Activity'de sinema yalnızca dosya/HLS oynarken görünür (YouTube vb. tarayıcıda izlenir). */
  setVisible(on: boolean): void {
    this.root.style.display = on ? "" : "none";
    this.start.style.display = on ? "" : "none";
  }

  notice(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add("show");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove("show"), 3500);
  }

  /** Sunucudan durum geldi: başlık ve kimin ne yaptığı. */
  onState(s: WatchState): void {
    this.title.textContent = s.source ? s.title : "Bir link yapıştır";
    const key = `${s.op}|${s.updatedAt}`;
    if (key !== this.lastOp && s.by && OP_TEXT[s.op]) this.notice(`${s.by} ${OP_TEXT[s.op]}`);
    this.lastOp = key;
    const live = this.sync.live;
    const ctrl = this.sync.player?.controllable ?? false;
    this.seek.disabled = live || !ctrl;
    this.playBtn.disabled = live || !ctrl;
    this.root.classList.toggle("live", live);
  }

  update(now: number): void {
    if (now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    const s = this.sync.state;
    if (!s) return;
    this.playBtn.textContent = s.playing ? "⏸" : "▶";
    if (this.sync.live) {
      this.time.textContent = "● CANLI";
      return;
    }
    const t = this.sync.target();
    const dur = this.sync.player?.duration() ?? Number.NaN;
    if (Number.isFinite(dur)) this.seek.max = String(Math.floor(dur));
    if (!this.dragging) this.seek.value = String(Math.floor(t));
    this.time.textContent = `${fmt(t)} / ${fmt(dur)}`;
  }
}
