// Dünyanın HUD'u: sol üstte dünyadakiler, üstte ortada bildirimler, sağ üstte araç çubuğu, altta ortada etkileşim
// düğmeleri. Parçalar layout bölgelerine eklenir (üst üste binmez). Kare başına DOM'a dokunulmaz: liste olaylarda,
// etkileşimler yalnızca değişince, debug saniyede iki kez güncellenir.
import { EMOTES } from "../../../shared/constants";
import type { Remotes } from "../avatars/remotes";
import type { Net, NetStatus } from "../net";
import type { PerfStats } from "../perf";
import { actionLabel } from "../input/keybinds";
import { icon, stripEmoji } from "./icons";
import { pulseToolMenu, region, toolButton, toolMenuItem } from "./layout";
import { NetPanel } from "./netPanel";

const STATUS_TEXT: Record<NetStatus, string> = {
  connecting: "Bağlanıyor…",
  online: "Çevrimiçi",
  offline: "Bağlantı koptu, yeniden deneniyor…",
  denied: "Oturum geçersiz — sayfayı yenile",
  notfound: "İzleme odası bulunamadı (süresi dolmuş olabilir) — Discord'da yeniden !izle yaz",
};

/** Aynı anda görünen en çok bildirim; süresi (ms). */
const MAX_TOASTS = 3;
const TOAST_MS = 3800;

type ActKey = "f" | "g";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}

/** İsimden sabit bir renk tonu (oyuncu listesindeki baş harf). */
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}

/** "Masayı izle (oynamak için tabureye otur)" → ana metin ve açıklama; emojiler atılır. */
function splitLabel(label: string): [string, string] {
  const clean = stripEmoji(label);
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(clean);
  if (!m || !m[1]) return [clean, ""];
  const sub = m[2];
  return [m[1], sub.charAt(0).toLocaleUpperCase("tr-TR") + sub.slice(1)];
}

export class Hud {
  private list: HTMLUListElement;
  private players: HTMLDivElement;
  private count: HTMLElement;
  private status: HTMLDivElement;
  private debug: HTMLDivElement | null = null;
  private debugText: HTMLDivElement | null = null;
  /** Sağ alt sütun: performans ve ağ paneli üst üste. */
  private diag: HTMLDivElement;
  private net: NetPanel | null = null;
  private promptState: "sit" | "stand" | "" = "";
  private jail: HTMLDivElement;
  private lastDebug = 0;
  /** Etkileşim düğmeleri (F/G) ve otur/kalk: tek sütun, hızlı slotun üstünde. */
  private acts: HTMLDivElement;
  private actList: { key: ActKey; label: string }[] = [];
  private actTouch = false;
  private onAct: (k: ActKey) => void = () => {};
  private actsKey = "";
  private toasts: HTMLDivElement;
  private toastTimers = new WeakMap<Element, number>();
  private nowPlaying: HTMLDivElement | null = null;
  private shareBtn: HTMLButtonElement | null = null;
  private shareBar: HTMLDivElement | null = null;

  constructor(
    private root: HTMLElement,
    private myName: string,
    touch: boolean,
    private onAction: () => void,
  ) {
    // Sol üst: dünyadakiler (başlığa tıklayınca daralır)
    this.players = el("div", "players", region(root, "tl"));
    const head = el("button", "players-head", this.players);
    head.type = "button";
    icon("users", "", head);
    el("span", "players-title", head, "Dünyada");
    this.count = el("b", "players-count", head, "1");
    icon("chevron", "players-caret", head);
    head.addEventListener("click", () => {
      const collapsed = this.players.classList.toggle("collapsed");
      try {
        localStorage.setItem("gap-players-collapsed", collapsed ? "1" : "");
      } catch {
        // depolama kapalı
      }
    });
    let collapsed = touch;
    try {
      const saved = localStorage.getItem("gap-players-collapsed");
      if (saved !== null) collapsed = saved === "1";
    } catch {
      // depolama kapalı
    }
    this.players.classList.toggle("collapsed", collapsed);
    this.list = el("ul", "players-list", this.players);

    // Üst orta: bağlantı uyarısı, sürgün bandı, bildirimler
    const tc = region(root, "tc");
    this.status = el("div", "net-status", tc);
    this.jail = el("div", "jail-banner", tc);
    icon("lock", "", this.jail);
    el("span", "", this.jail, "Sürgündesin — cezan bitene kadar zindandasın.");
    this.toasts = el("div", "toasts", tc);
    this.toasts.setAttribute("role", "status");
    this.toasts.setAttribute("aria-live", "polite");

    // Alt orta: etkileşimler
    this.acts = el("div", "acts", region(root, "bc"));
    this.diag = el("div", "diag", region(root, "br"));
  }

  /** Tuş atamaları değişti: etkileşim ve araç çubuğundaki tuş adları yenilenir. */
  refreshKeys(): void {
    this.actsKey = "";
    this.renderActs();
  }

  /** Dokunmatikte sağ kenarda emote düğmeleri (masaüstünde emote çarkı var). */
  emoteBar(touch: boolean, onEmote: (i: number) => void): void {
    const bar = el("div", touch ? "emotes" : "emotes desk", this.root);
    EMOTES.forEach((em, i) => {
      const b = el("button", "emote-btn", bar);
      b.textContent = em.emoji;
      b.title = em.name;
      b.addEventListener("click", () => onEmote(i));
    });
  }

  /** Gardırop düğmesi (masaüstünde C). */
  wardrobeButton(touch: boolean, onOpen: () => void): void {
    toolButton(this.root, { icon: "shirt", label: "Gardırop", action: touch ? undefined : "wardrobe", group: 0, order: 4, onClick: onOpen });
  }

  /** Sinema ("Diğer" menüsünde): sohbete "!izle " yazar, link yapıştırılınca sinema açılır. */
  cinemaButton(onOpen: () => void): void {
    toolMenuItem(this.root, { icon: "film", label: "Sinemayı aç", order: 1, onClick: onOpen });
  }

  /** Ekran paylaşımı ("Diğer" menüsünde): paylaşmayı başlatır ya da kendi paylaşımını durdurur. */
  shareButton(onClick: () => void): void {
    this.shareBtn = toolMenuItem(this.root, { icon: "screencast", label: "Ekranını paylaş", order: 2, onClick });
  }

  /** Paylaşım linkiyle gelene menüyü gösterir. */
  highlightShare(): void {
    pulseToolMenu(this.root);
  }

  /**
   * Odadaki paylaşım bandı: kim paylaşıyor; izleyene sesi aç ve tam ekran, paylaşana durdur.
   * `share` null ise band gizlenir.
   */
  setShare(share: { name: string; mine: boolean; muted: boolean } | null, actions: { sound(): void; fullscreen: (() => void) | null; stop(): void }): void {
    this.shareBtn?.classList.toggle("on", !!share?.mine);
    const label = this.shareBtn?.querySelector("span");
    if (label) label.textContent = share?.mine ? "Paylaşımı durdur" : "Ekranını paylaş";
    if (!share) {
      this.shareBar?.classList.remove("show");
      return;
    }
    this.shareBar ??= el("div", "media-bar share-bar", region(this.root, "tc"));
    const text = document.createElement("span");
    text.className = "media-title";
    text.textContent = share.mine ? "Ekranını paylaşıyorsun" : `${share.name} ekranını paylaşıyor`;
    const lead = icon(share.mine ? "screencast" : "monitor", share.mine ? "media-ic live" : "media-ic");
    const button = (label: string, fn: () => void, cls = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn btn--sm${cls ? ` ${cls}` : ""}`;
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    const parts: HTMLElement[] = [lead, text];
    if (share.mine) parts.push(button("Durdur", actions.stop, "btn--danger"));
    else if (share.muted) parts.push(button("Sesi aç", actions.sound, "btn--primary"));
    if (!share.mine && actions.fullscreen) {
      const fs = button("", actions.fullscreen, "btn--icon");
      icon("cornersOut", "", fs);
      fs.title = "Tam ekran";
      parts.push(fs);
    }
    this.shareBar.replaceChildren(...parts);
    this.shareBar.classList.add("show");
  }

  /** Activity'de sinema bandı: ne oynuyor ve tarayıcıda izleme düğmesi; null ise gizlenir. */
  setNowPlaying(title: string | null, onWatch: (() => void) | null): void {
    if (!title) {
      this.nowPlaying?.classList.remove("show");
      return;
    }
    this.nowPlaying ??= el("div", "media-bar now-playing", region(this.root, "tc"));
    const text = document.createElement("span");
    text.className = "media-title";
    text.textContent = title;
    const parts: HTMLElement[] = [icon("film", "media-ic"), text];
    if (onWatch) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn--sm btn--primary";
      b.textContent = "Tarayıcıda izle";
      b.addEventListener("click", onWatch);
      parts.push(b);
    }
    this.nowPlaying.replaceChildren(...parts);
    this.nowPlaying.classList.add("show");
  }

  /** Dokunmatikte zıplama düğmesi (masaüstünde Space). */
  jumpButton(onJump: () => void): void {
    const b = el("button", "jump-btn", this.root);
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l7 8h-4.5v8h-5v-8H5z"/></svg>';
    b.setAttribute("aria-label", "Zıpla");
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      onJump();
    });
  }

  /** Yakındaki etkileşimler (F/G). Yalnızca liste değişince DOM'a yazılır. */
  setActs(list: { key: ActKey; label: string }[], touch: boolean, onAct: (k: ActKey) => void): void {
    this.actList = list;
    this.actTouch = touch;
    this.onAct = onAct;
    this.renderActs();
  }

  /** "sit" | "stand" | "" — otur/kalk satırı; yalnızca değişince yazılır. */
  setPrompt(state: "sit" | "stand" | ""): void {
    if (state === this.promptState) return;
    this.promptState = state;
    this.renderActs();
  }

  /**
   * Etkileşim satırları: [tuş] ana metin, altında açıklama (etiketin parantez içi). Otur/kalk en altta.
   * Yalnızca yazı değiştiyse (ör. balık geri sayımı) düğmeler yerinde kalır, dokunuş kaybolmaz.
   */
  private renderActs(): void {
    const rows: { id: string; key: string; main: string; sub: string; run: () => void }[] = this.actList.map((a) => {
      const [main, sub] = splitLabel(a.label);
      return { id: a.key, key: actionLabel(a.key === "f" ? "actF" : "actG"), main, sub, run: () => this.onAct(a.key) };
    });
    if (this.promptState) {
      rows.push({ id: "e", key: actionLabel("sit"), main: this.promptState === "sit" ? "Otur" : "Kalk", sub: "", run: this.onAction });
    }
    const key = rows.map((r) => `${r.id}${r.key}|${r.main}|${r.sub}`).join("¦") + (this.actTouch ? "t" : "");
    if (key === this.actsKey) return;
    const ids = rows.map((r) => r.id).join("");
    const same = this.acts.dataset.ids === ids && this.acts.children.length === rows.length;
    this.actsKey = key;
    this.acts.dataset.ids = ids;
    if (same && rows.length) {
      rows.forEach((r, i) => {
        const b = this.acts.children[i] as HTMLElement;
        b.querySelector("kbd")!.textContent = r.key;
        b.querySelector(".act-main")!.textContent = r.main;
        const s = b.querySelector(".act-sub")!;
        s.textContent = r.sub;
        b.classList.toggle("has-sub", !!r.sub);
      });
      return;
    }
    this.acts.replaceChildren(
      ...rows.map((r) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `act${r.sub ? " has-sub" : ""}${r.id === "e" ? " act-seat" : ""}`;
        el("kbd", this.actTouch ? "act-key touch" : "act-key", b, r.key);
        const t = el("span", "act-text", b);
        el("span", "act-main", t, r.main);
        el("span", "act-sub", t, r.sub);
        b.addEventListener("click", r.run);
        return b;
      }),
    );
  }

  /** Üstte ortada kısa bildirim; aynı metin zaten görünüyorsa süresi uzar. */
  toast(text: string): void {
    const same = [...this.toasts.children].find((t) => t.textContent === text && !t.classList.contains("out"));
    if (same) return this.armToast(same);
    const t = el("div", "toast", this.toasts, text);
    while (this.toasts.children.length > MAX_TOASTS) this.toasts.firstElementChild?.remove();
    this.armToast(t);
  }

  private armToast(t: Element): void {
    window.clearTimeout(this.toastTimers.get(t));
    t.classList.remove("out");
    this.toastTimers.set(
      t,
      window.setTimeout(() => {
        t.classList.add("out");
        window.setTimeout(() => t.classList.contains("out") && t.remove(), 260);
      }, TOAST_MS),
    );
  }

  setStatus(s: NetStatus): void {
    this.status.replaceChildren(icon(s === "connecting" ? "wifi" : "wifiOff"), document.createTextNode(STATUS_TEXT[s]));
    this.status.className = `net-status ${s}`;
  }

  /** `onPick`: isme tıklanınca (oyuncu kartı); kendin için sid -1. */
  renderPlayers(remotes: Remotes, onPick?: (sid: number, name: string) => void): void {
    const people: [number, string][] = [[-1, this.myName]];
    for (const r of remotes.map.values()) if (!r.leaving) people.push([r.info.sid, r.info.name]);
    this.count.textContent = String(people.length);
    this.list.replaceChildren(
      ...people.map(([sid, n], i) => {
        const li = document.createElement("li");
        const dot = el("i", "players-dot", li, n.slice(0, 1).toLocaleUpperCase("tr-TR"));
        dot.style.setProperty("--h", String(hueOf(n)));
        el("span", "players-name", li, n);
        if (i === 0) {
          li.className = "me";
          el("em", "", li, "Sen");
        }
        if (onPick) {
          li.classList.add("pick");
          li.title = "Oyuncu kartı";
          li.addEventListener("click", () => onPick(sid, n));
        }
        return li;
      }),
    );
  }

  setJailed(on: boolean): void {
    this.jail.classList.toggle("show", on);
  }

  /** Performans paneli: ?debug'da YouTube testi düğmesiyle, ayarlardaki FPS göstergesinde yalnız. */
  enableDebug(onYoutubeTest?: () => void): void {
    if (this.debug) return;
    this.debug = el("div", "debug", this.diag);
    this.debugText = el("div", "", this.debug);
    if (!onYoutubeTest) return;
    const btn = el("button", "btn btn--sm", this.debug, "YouTube testi");
    btn.addEventListener("click", onYoutubeTest);
  }

  disableDebug(): void {
    this.debug?.remove();
    this.debug = this.debugText = null;
  }

  /** Ağ paneli (ayarlardan ya da kısayolla): ping, kayıp, grafikler. */
  enableNet(net: Net, onClose: () => void): void {
    if (this.net) return;
    this.net = new NetPanel(this.diag, net, onClose);
    this.diag.prepend(this.net.root);
  }

  disableNet(): void {
    this.net?.destroy();
    this.net = null;
  }

  updateNet(now: number): void {
    this.net?.update(now);
  }

  updateDebug(now: number, s: PerfStats, rtt: number, avatars: number, hitch = ""): void {
    if (!this.debugText || now - this.lastDebug < 500) return;
    this.lastDebug = now;
    this.debugText.textContent =
      `${s.fps.toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms\n` +
      `cpu ${s.cpuMs.toFixed(2)} ms\n` +
      `draw ${s.calls}  tri ${(s.triangles / 1000).toFixed(1)}k\n` +
      `ölçek ${s.scale.toFixed(2)}  dpr ${devicePixelRatio}\n` +
      `ping ${rtt.toFixed(0)} ms  avatar ${avatars}` + (hitch ? `\n${hitch}` : "");
  }
}
