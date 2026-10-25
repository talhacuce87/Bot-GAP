// Dünya oyunlarının ekran parçaları: şarkı kuyruğu / DJ paneli, ebelemece-saklambaç bandı (ebeye göz kapama),
// futbol skoru ve şut gücü, beşlik/sarılma isteği.
import type { StageState, TagState } from "../../../shared/protocol";
import { region } from "./layout";
import { button, el, Panel } from "./panel";

const SHOWS = ["Kapalı", "🌈 Gökkuşağı", "🔥 Sıcak", "💜 Lazer"];

export interface WorldHudActions {
  dj(op: "take" | "leave" | "show" | "skip", show?: number): void;
  enqueue(url: string): void;
  tagJoin(): void;
  pairOk(from: number): void;
}

export class WorldHud {
  private queue: Panel;
  private stage: StageState = { dj: 0, show: 0, singer: 0, queue: [] };
  private tagEl: HTMLDivElement;
  private blind: HTMLDivElement;
  private score: HTMLDivElement;
  private power: HTMLDivElement;
  private powerFill: HTMLDivElement;
  private powerLabel: HTMLSpanElement;
  private pairEl: HTMLDivElement;
  private pairTimer = 0;
  private pairFrom = 0;
  private tag: TagState | null = null;
  private tagKey = "";

  constructor(root: HTMLElement, private me: () => number, private a: WorldHudActions, private nameOf: (sid: number) => string) {
    this.queue = new Panel(root, "Şarkı kuyruğu", "queue-panel", "music");
    this.tagEl = el("div", "tag-banner", region(root, "tc"));
    this.blind = el("div", "tag-blind", root);
    const bc = region(root, "bc");
    this.score = el("div", "pitch-score", bc);
    this.power = el("div", "kick-power", bc);
    this.powerFill = el("div", "kick-fill", this.power);
    this.powerLabel = el("span", "kick-label", this.power);
    this.pairEl = el("div", "pair-req", bc);
  }

  // ---- Şarkı kuyruğu ve DJ ----

  openQueue(): void {
    this.renderQueue();
    this.queue.open();
  }

  get queueOpen(): boolean {
    return this.queue.isOpen;
  }

  setStage(s: StageState): void {
    const wasDj = this.stage.dj === this.me();
    this.stage = s;
    if (s.dj === this.me() && !wasDj) this.openQueue();
    if (this.queue.isOpen) this.renderQueue();
  }

  private renderQueue(): void {
    const b = this.queue.body;
    b.replaceChildren();
    const s = this.stage;
    const iAmDj = s.dj === this.me();
    this.queue.title = iAmDj ? "🎧 DJ KABİNİ" : "🎵 ŞARKI KUYRUĞU";
    el("div", "settings-note", b, s.dj ? `DJ: ${this.nameOf(s.dj)}${s.singer ? ` · sahnede: ${this.nameOf(s.singer)} 🎤` : ""}` : "DJ yok · sinema kabininde (sahnenin solu) F ile DJ olabilirsin.");
    if (iAmDj) {
      el("h4", "settings-section", b, "Işık şovu");
      const seg = el("div", "settings-seg", b);
      SHOWS.forEach((name, i) => button(seg, name, () => this.a.dj("show", i), s.show === i ? "active" : ""));
    }
    const form = el("form", "queue-form", b);
    const input = el("input", "", form);
    input.placeholder = "YouTube / Twitch / .mp4 linki";
    input.setAttribute("aria-label", "Şarkı linki");
    button(form, "Ekle", () => {}, "primary").type = "submit";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const url = input.value.trim();
      if (!url) return;
      this.a.enqueue(url);
      input.value = "";
    });
    el("h4", "settings-section", b, `Sırada (${s.queue.length})`);
    const list = el("ol", "queue-list", b);
    if (!s.queue.length) el("li", "settings-note", list, "Kuyruk boş: link ekle, perde boşsa hemen çalar.");
    for (const q of s.queue) el("li", "", list, `${q.title} · ${q.by}`);
    const row = el("div", "bg-actions", b);
    if (!s.dj || iAmDj) button(row, "⏭ Geç", () => this.a.dj("skip"));
    if (iAmDj) button(row, "Kabinden çık", () => this.a.dj("leave"));
  }

  // ---- Ebelemece / saklambaç ----

  setTag(s: TagState | null, serverNow: number): void {
    this.tag = s;
    this.tagKey = "";
    this.updateTag(serverNow);
  }

  /** Saniyede birkaç kez: geri sayım metni. */
  updateTag(serverNow: number): void {
    const s = this.tag;
    if (!s) {
      this.tagEl.classList.remove("show");
      this.blind.classList.remove("show");
      return;
    }
    const left = Math.max(0, Math.ceil((s.endsAt - serverNow) / 1000));
    const me = this.me();
    const joined = s.players.includes(me);
    const title = s.mode === "ebelemece" ? "🏃 Ebelemece" : "🙈 Saklambaç";
    let text = "";
    if (s.phase === "join") text = `${title}: katılım ${left} sn · ${s.players.length} kişi`;
    else if (s.phase === "hide") text = s.it === me ? `${title}: gözlerin kapalı… ${left}` : `${title}: ${this.nameOf(s.it)} sayıyor, saklan! ${left}`;
    else if (s.phase === "play") {
      const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      if (s.mode === "ebelemece") text = s.it === me ? `${title}: EBE SENSİN! birine değ · ${mm}` : `${title}: ebe ${this.nameOf(s.it)} · kaç! · ${mm}`;
      else {
        const hidden = s.players.filter((p) => p !== s.it && !s.found.includes(p)).length;
        text = s.it === me ? `${title}: ara! ${hidden} kişi saklı · ${mm}` : s.found.includes(me) ? `${title}: bulundun 👀 · ${mm}` : `${title}: saklan · ${hidden} kişi saklı · ${mm}`;
      }
    } else text = s.result;
    const key = `${text}|${joined}`;
    if (key !== this.tagKey) {
      this.tagKey = key;
      this.tagEl.replaceChildren(el("span", "", document.createElement("div"), text));
      if (s.phase === "join" && !joined) button(this.tagEl, "Katıl", () => this.a.tagJoin(), "primary");
      this.tagEl.classList.add("show");
    }
    this.blind.textContent = left ? `🙈 ${left}` : "";
    this.blind.classList.toggle("show", s.phase === "hide" && s.it === me);
  }

  /** Saklambaçta saklananların ismi görünmez (oynamayanlar ve bulunanlar görünür). */
  hiddenName(sid: number): boolean {
    const s = this.tag;
    return !!s && s.mode === "saklambac" && (s.phase === "hide" || s.phase === "play") && sid !== s.it && s.players.includes(sid) && !s.found.includes(sid);
  }

  /** Ebelemecede ebe kim (işaret için). */
  get it(): number {
    const s = this.tag;
    return s && (s.phase === "play" || s.phase === "hide") ? s.it : 0;
  }

  // ---- Futbol ----

  /** Saha skoru; maçta takım renkleri, kalan süre ve oyuncunun takımı. */
  setScore(score: [number, number] | null, clock: string | null = null, team: 0 | 1 | null = null): void {
    this.score.classList.toggle("show", !!score);
    if (!score) return;
    const text = clock
      ? `🔴 ${score[0]} – ${score[1]} 🔵 · ⏱ ${clock}${team === null ? "" : team ? " · sen Mavi" : " · sen Kırmızı"}`
      : `⚽ ${score[0]} – ${score[1]}`;
    if (this.score.textContent !== text) this.score.textContent = text;
  }

  /** Şut gücü (null: gizli). */
  setPower(p: number | null, label = ""): void {
    this.power.classList.toggle("show", p !== null);
    if (p !== null) this.powerFill.style.width = `${Math.round(p * 100)}%`;
    if (this.powerLabel.textContent !== label) this.powerLabel.textContent = label;
  }

  // ---- Beşlik / sarılma ----

  pairRequest(from: number, name: string, kind: "five" | "hug"): void {
    this.pairFrom = from;
    const p = this.pairEl;
    p.replaceChildren();
    el("span", "", p, kind === "five" ? `🙌 ${name} sana beşlik çakmak istiyor` : `🤗 ${name} sana sarılmak istiyor`);
    button(p, "Kabul (Y)", () => this.acceptPair(), "primary");
    button(p, "Hayır", () => p.classList.remove("show"));
    p.classList.add("show");
    window.clearTimeout(this.pairTimer);
    this.pairTimer = window.setTimeout(() => p.classList.remove("show"), 9000);
  }

  /** Y tuşu ya da düğme: bekleyen isteği kabul et. */
  acceptPair(): boolean {
    if (!this.pairEl.classList.contains("show")) return false;
    this.pairEl.classList.remove("show");
    this.a.pairOk(this.pairFrom);
    return true;
  }
}
