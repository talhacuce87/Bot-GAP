// Sade DOM arayüzü. Kare başına DOM'a dokunulmaz: liste olaylarda, debug saniyede iki kez güncellenir.
import { EMOTES } from "../../../shared/constants";
import type { Remotes } from "../avatars/remotes";
import type { Net, NetStatus } from "../net";
import type { PerfStats } from "../perf";
import { actionLabel } from "../input/keybinds";
import { NetPanel } from "./netPanel";

const STATUS_TEXT: Record<NetStatus, string> = {
  connecting: "bağlanıyor…",
  online: "çevrimiçi",
  offline: "bağlantı koptu, yeniden deneniyor…",
  denied: "oturum geçersiz — sayfayı yenile",
  notfound: "izleme odası bulunamadı (süresi dolmuş olabilir) — Discord'da yeniden !izle yaz",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.append(e);
  return e;
}

export class Hud {
  private list: HTMLUListElement;
  private status: HTMLDivElement;
  private prompt: HTMLButtonElement;
  private debug: HTMLDivElement | null = null;
  private debugText: HTMLDivElement | null = null;
  /** Sağ alt sütun: performans ve ağ paneli üst üste (çakışmasın). */
  private diag: HTMLDivElement;
  private net: NetPanel | null = null;
  private promptState = "";
  private jail: HTMLDivElement;
  private lastDebug = 0;
  private acts: HTMLDivElement;
  private actsKey = "";
  private toastEl: HTMLDivElement;
  private nowPlaying: HTMLDivElement | null = null;
  private shareBtn: HTMLButtonElement | null = null;
  private shareBar: HTMLDivElement | null = null;
  private toastTimer = 0;
  private hint: HTMLDivElement;

  constructor(
    private root: HTMLElement,
    private myName: string,
    private touch: boolean,
    onAction: () => void,
  ) {
    const players = el("div", "panel players", root);
    el("h3", "", players).textContent = "DÜNYADAKİLER";
    this.list = el("ul", "", players);
    this.status = el("div", "panel status", root);
    this.prompt = el("button", "prompt", root);
    this.jail = el("div", "panel jail-banner", root);
    this.jail.textContent = "⛓️ Sürgündesin — cezan bitene kadar zindandasın.";
    this.prompt.addEventListener("click", onAction);
    this.acts = el("div", "acts", root);
    this.toastEl = el("div", "panel toast", root);
    this.hint = el("div", "hint", root);
    this.diag = el("div", "diag", root);
    this.refreshHint();
  }

  /** Arabadayken alttaki ipucu sürüş tuşlarını gösterir. */
  private driving = false;

  setDriving(on: boolean): void {
    if (on === this.driving) return;
    this.driving = on;
    this.refreshHint();
  }

  /** Alttaki tuş ipucu; tuş atamaları değişince yeniden yazılır. */
  refreshHint(): void {
    if (this.touch) {
      this.hint.textContent = "Sol: yürü (sonuna kadar it: koş) • Sağ: kamera • İki parmak: yakınlaştır";
      return;
    }
    const k = actionLabel;
    const move = [k("forward"), k("left"), k("back"), k("right")];
    if (this.driving) {
      this.hint.textContent =
        `${k("forward")}/${k("back")}: gaz-fren • ${k("left")}/${k("right")}: direksiyon • ${k("jump")}: el freni • ${k("run")}: güç • ` +
        `${k("horn")}: korna • ${k("flash")}: selektör • ${k("actG")}: far • ${k("radio")}: radyo • ${k("actF")}: in`;
      return;
    }
    this.hint.textContent =
      `${move.every((m) => m.length === 1) ? move.join("") : move.join("/")}: yürü • ${k("run")}: koş • ${k("jump")}: zıpla • ` +
      `${k("sit")}: otur • ${k("actF")}/${k("actG")}: etkileşim • 1–6: emote • ${k("wardrobe")}: gardırop • ` +
      `${k("shiftlock")}: shift lock • Enter: sohbet`;
  }

  /** Sağ kenarda emote düğmeleri (masaüstünde 1–6 tuşları da çalışır). */
  emoteBar(touch: boolean, onEmote: (i: number) => void): void {
    const bar = el("div", "emotes", this.root);
    EMOTES.forEach((em, i) => {
      const b = el("button", "emote-btn", bar);
      b.textContent = em.emoji;
      b.title = touch ? em.name : `${em.name} (${i + 1})`;
      b.addEventListener("click", () => onEmote(i));
    });
  }

  /** Gardırop düğmesi (masaüstünde C). */
  wardrobeButton(touch: boolean, onOpen: () => void): void {
    const b = el("button", "wardrobe-btn", this.root);
    b.textContent = "👕";
    b.title = touch ? "Gardırop" : `Gardırop (${actionLabel("wardrobe")})`;
    b.addEventListener("click", onOpen);
  }

  /** Sinema düğmesi: sohbete "!izle " yazar, link yapıştırılınca sinema açılır. */
  cinemaButton(onOpen: () => void): void {
    const b = el("button", "wardrobe-btn cinema-btn", this.root);
    b.textContent = "🎬";
    b.title = "Sinemayı aç (link yapıştır)";
    b.addEventListener("click", onOpen);
  }

  /** Ekran paylaşımı düğmesi: paylaşmayı başlatır ya da kendi paylaşımını durdurur. */
  shareButton(onClick: () => void): void {
    const b = (this.shareBtn = el("button", "wardrobe-btn share-btn", this.root));
    b.textContent = "🖥️";
    b.title = "Ekranını paylaş (sinema perdesinde)";
    b.addEventListener("click", () => {
      b.classList.remove("pulse");
      onClick();
    });
  }

  /** Paylaşım linkiyle gelene düğmeyi gösterir. */
  highlightShare(): void {
    this.shareBtn?.classList.add("pulse");
  }

  /**
   * Odadaki paylaşım bandı: kim paylaşıyor; izleyene sesi aç ve tam ekran, paylaşana durdur.
   * `share` null ise band gizlenir.
   */
  setShare(share: { name: string; mine: boolean; muted: boolean } | null, actions: { sound(): void; fullscreen: (() => void) | null; stop(): void }): void {
    this.shareBtn?.classList.toggle("on", !!share?.mine);
    if (this.shareBtn) this.shareBtn.title = share?.mine ? "Paylaşımı durdur" : "Ekranını paylaş (sinema perdesinde)";
    if (!share) {
      this.shareBar?.classList.remove("show");
      return;
    }
    this.shareBar ??= el("div", "panel now-playing share-bar", this.root);
    const text = document.createElement("span");
    text.className = "now-title";
    text.textContent = share.mine ? "🔴 Ekranını paylaşıyorsun" : `🖥️ ${share.name} ekranını paylaşıyor`;
    const button = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    const parts: HTMLElement[] = [text];
    if (share.mine) parts.push(button("⏹ Durdur", actions.stop));
    else if (share.muted) parts.push(button("🔊 Sesi aç", actions.sound));
    if (!share.mine && actions.fullscreen) parts.push(button("⛶", actions.fullscreen));
    this.shareBar.replaceChildren(...parts);
    this.shareBar.classList.add("show");
  }

  /** Activity'de sinema bandı: ne oynuyor ve tarayıcıda izleme düğmesi; null ise gizlenir. */
  setNowPlaying(title: string | null, onWatch: (() => void) | null): void {
    if (!title) {
      this.nowPlaying?.classList.remove("show");
      return;
    }
    if (!this.nowPlaying) this.nowPlaying = el("div", "panel now-playing", this.root);
    const text = document.createElement("span");
    text.className = "now-title";
    text.textContent = `🎬 ${title}`;
    const parts: HTMLElement[] = [text];
    if (onWatch) {
      const b = document.createElement("button");
      b.textContent = "🍿 Tarayıcıda izle";
      b.addEventListener("click", onWatch);
      parts.push(b);
    }
    this.nowPlaying.replaceChildren(...parts);
    this.nowPlaying.classList.add("show");
  }

  /** Dokunmatikte zıplama düğmesi (masaüstünde Space). */
  jumpButton(onJump: () => void): void {
    const b = el("button", "jump-btn", this.root);
    b.textContent = "⤒";
    b.title = "Zıpla";
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      onJump();
    });
  }

  /** Yakındaki etkileşimler (mangal, zindan). Yalnızca liste değişince DOM'a yazılır. */
  setActs(list: { key: "f" | "g"; label: string }[], touch: boolean, onAct: (k: "f" | "g") => void): void {
    const text = (a: { key: "f" | "g"; label: string }) => (touch ? a.label : `${actionLabel(a.key === "f" ? "actF" : "actG")} · ${a.label}`);
    const key = list.map((a) => a.key + text(a)).join("|");
    if (key === this.actsKey) return;
    // Yalnızca yazı değiştiyse (ör. balık geri sayımı) düğmeler yerinde kalır, dokunuş kaybolmaz.
    const keys = list.map((a) => a.key).join("|");
    const same = keys === this.actsKey.split("|").map((k) => k[0]).join("|") && this.acts.children.length === list.length;
    this.actsKey = key;
    if (same && list.length) {
      list.forEach((a, i) => (this.acts.children[i].textContent = text(a)));
      return;
    }
    this.acts.replaceChildren(
      ...list.map((a) => {
        const b = document.createElement("button");
        b.className = "act-btn";
        b.textContent = text(a);
        b.addEventListener("click", () => onAct(a.key));
        return b;
      }),
    );
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove("show"), 3500);
  }

  setStatus(s: NetStatus): void {
    this.status.textContent = STATUS_TEXT[s];
    this.status.classList.toggle("bad", s !== "online");
  }

  /** `onPick`: isme tıklanınca (oyuncu kartı); kendin için sid -1. */
  renderPlayers(remotes: Remotes, onPick?: (sid: number, name: string) => void): void {
    const people: [number, string][] = [[-1, this.myName]];
    for (const r of remotes.map.values()) if (!r.leaving) people.push([r.info.sid, r.info.name]);
    this.list.replaceChildren(
      ...people.map(([sid, n], i) => {
        const li = document.createElement("li");
        li.textContent = i === 0 ? `${n} (sen)` : n;
        if (i === 0) li.className = "me";
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

  /** "sit" | "stand" | "" — sadece değişince DOM'a yazar. */
  setPrompt(state: "sit" | "stand" | ""): void {
    if (state === this.promptState) return;
    this.promptState = state;
    this.prompt.textContent = state === "sit" ? "Otur" : state === "stand" ? "Kalk" : "";
    this.prompt.classList.toggle("show", state !== "");
  }

  /** Performans paneli: ?debug'da YouTube testi düğmesiyle, ayarlardaki FPS göstergesinde yalnız. */
  enableDebug(onYoutubeTest?: () => void): void {
    if (this.debug) return;
    this.debug = el("div", "panel debug", this.diag);
    this.debugText = el("div", "", this.debug);
    if (!onYoutubeTest) return;
    const btn = el("button", "", this.debug);
    btn.textContent = "YouTube testi";
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

  updateDebug(now: number, s: PerfStats, rtt: number, avatars: number): void {
    if (!this.debugText || now - this.lastDebug < 500) return;
    this.lastDebug = now;
    this.debugText.textContent =
      `${s.fps.toFixed(0)} fps  ${s.frameMs.toFixed(1)} ms\n` +
      `cpu ${s.cpuMs.toFixed(2)} ms\n` +
      `draw ${s.calls}  tri ${(s.triangles / 1000).toFixed(1)}k\n` +
      `ölçek ${s.scale.toFixed(2)}  dpr ${devicePixelRatio}\n` +
      `ping ${rtt.toFixed(0)} ms  avatar ${avatars}`;
  }
}
