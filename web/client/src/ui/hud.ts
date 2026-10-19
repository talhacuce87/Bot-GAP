// Sade DOM arayüzü. Kare başına DOM'a dokunulmaz: liste olaylarda, debug saniyede iki kez güncellenir.
import type { Remotes } from "../avatars/remotes";
import type { NetStatus } from "../net";
import type { PerfStats } from "../perf";

const STATUS_TEXT: Record<NetStatus, string> = {
  connecting: "bağlanıyor…",
  online: "çevrimiçi",
  offline: "bağlantı koptu, yeniden deneniyor…",
  denied: "oturum geçersiz — Activity'yi yeniden aç",
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
  private promptState = "";
  private jail: HTMLDivElement;
  private lastDebug = 0;

  constructor(
    private root: HTMLElement,
    private myName: string,
    touch: boolean,
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
    el("div", "hint", root).textContent = touch
      ? "Sol: yürü • Sağ: kamera • İki parmak: yakınlaştır"
      : "WASD: yürü • Sürükle: kamera • Tekerlek: yakınlaştır • E: otur";
  }

  setStatus(s: NetStatus): void {
    this.status.textContent = STATUS_TEXT[s];
    this.status.classList.toggle("bad", s !== "online");
  }

  renderPlayers(remotes: Remotes): void {
    const names = [this.myName];
    for (const r of remotes.map.values()) if (!r.leaving) names.push(r.info.name);
    this.list.replaceChildren(
      ...names.map((n, i) => {
        const li = document.createElement("li");
        li.textContent = i === 0 ? `${n} (sen)` : n;
        if (i === 0) li.className = "me";
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

  enableDebug(onYoutubeTest: () => void): void {
    this.debug = el("div", "panel debug", this.root);
    this.debugText = el("div", "", this.debug);
    const btn = el("button", "", this.debug);
    btn.textContent = "YouTube testi";
    btn.addEventListener("click", onYoutubeTest);
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
