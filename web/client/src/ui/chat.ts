// Oyun içi sohbet: Enter ile yaz, Esc ile çık. "!" ile başlayan mesajlar komuttur (cevap yalnızca sana).
// Metin her zaman textContent ile yazılır (HTML yorumlanmaz).
import type { ChatLine } from "../../../shared/protocol";
import { region, toolButton } from "./layout";

const MAX_LINES = 60;
/** Bu kadar süre yeni mesaj gelmezse sohbet soluklaşır (odaktayken hep görünür). */
const IDLE_MS = 12_000;

export interface ChatHooks {
  send(text: string): void;
  /** Satırdaki düğme (ör. sinemaya katıl). */
  open(url: string): void;
  /** İstemcide karşılanan komut (ör. !gardırop); true dönerse sunucuya gitmez. */
  local(text: string): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  parent?.append(e);
  return e;
}

export class Chat {
  private root: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  private idleTimer = 0;

  constructor(
    hud: HTMLElement,
    private hooks: ChatHooks,
    touch: boolean,
  ) {
    this.root = el("div", "chat", region(hud, "bl"));
    this.log = el("div", "chat-log", this.root);
    this.input = el("input", "chat-input", this.root);
    this.input.maxLength = 200;
    this.input.placeholder = touch ? "Mesaj yaz… (!yardım)" : "Sohbet için Enter · komutlar: !yardım";
    this.input.enterKeyHint = "send";

    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // WASD/E/F yürümesin, emote atmasın
      if (e.key === "Enter") {
        const text = this.input.value.trim();
        this.input.value = "";
        if (text && !this.hooks.local(text)) {
          // Komutları kendi sohbetinde de göster (cevap altına gelir)
          if (/^[!/]/.test(text)) this.add({ kind: "say", sid: -1, name: "Sen", text, at: Date.now() }, true);
          this.hooks.send(text);
        }
        this.input.blur();
      } else if (e.key === "Escape") {
        this.input.blur();
      }
    });
    this.input.addEventListener("focus", () => this.wake(true));
    this.input.addEventListener("blur", () => {
      this.root.classList.remove("open");
      this.wake();
    });
    // Dokunmatikte sohbet araç çubuğundan açılır (dar ekranda yazı kutusu gizli, joystick alanı boş kalsın)
    if (touch) toolButton(hud, { icon: "chat", label: "Sohbet", group: 0, order: 5, onClick: () => this.focus() });
    this.root.addEventListener("pointerdown", () => this.wake());

    // Enter (bir giriş kutusunda değilken) sohbeti açar
    addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      this.focus();
    });
    this.wake();
  }

  focus(prefill = ""): void {
    this.root.classList.add("open");
    if (prefill && !this.input.value) this.input.value = prefill;
    this.input.focus();
    const n = this.input.value.length;
    this.input.setSelectionRange(n, n);
  }

  /** Geçmiş (odaya girerken). */
  setLog(lines: ChatLine[]): void {
    this.log.replaceChildren();
    for (const l of lines) this.add(l);
  }

  add(line: ChatLine, mine = false): void {
    const row = el("div", `chat-line ${line.kind}${mine ? " mine" : ""}`, this.log);
    if (line.kind === "say") el("span", "chat-name", row, `${line.name}: `);
    el("span", "chat-text", row, line.text);
    if (line.link) {
      const url = line.link.url;
      const b = el("button", "chat-link", row, line.link.label);
      b.addEventListener("click", () => this.hooks.open(url));
    }
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
    this.wake();
  }

  /** Yeni mesajda ya da odakta tam görünür; bir süre sonra soluklaşır. */
  private wake(hold = false): void {
    this.root.classList.remove("idle");
    window.clearTimeout(this.idleTimer);
    if (hold || document.activeElement === this.input) return;
    this.idleTimer = window.setTimeout(() => {
      if (document.activeElement !== this.input) this.root.classList.add("idle");
    }, IDLE_MS);
  }
}
