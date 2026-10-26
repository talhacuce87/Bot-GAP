// 📻 Radyo (Spotify gibi): YouTube ya da Spotify şarkı/çalma listesi linki ekle, sıraya girer; önceki, oynat/durdur,
// sonraki, karıştır, tekrar; sıradan şarkı seç ya da sil. Kontrol yalnızca arabadayken (inince radyo çalmaya devam
// eder). Altta radyo açan bütün üyeler: her birinin sesi ayrı ayarlanır ya da kapatılır.
import type { RadioQueueView } from "../../../shared/car";
import { actionLabel } from "../input/keybinds";
import { settings, updateSettings } from "../settings";
import { type IconName, icon } from "./icons";
import { button, el, Panel, paintRange } from "./panel";

export type RadioOp = "next" | "prev" | "shuffle" | "repeat" | "jump" | "remove" | "clear" | "stop" | "play";

/** Radyo açan bir üye (sen de olabilirsin). */
export interface RadioRow {
  sid: number;
  name: string;
  title: string;
  own: boolean;
  /** Şu an duyuluyor mu (menzilde). */
  heard: boolean;
  vol: number;
  muted: boolean;
}

export class RadioPanel {
  private panel: Panel;
  private queue: RadioQueueView | null = null;
  private inCar = false;
  private rows: RadioRow[] = [];
  private nowEl!: HTMLDivElement;
  private ctrlEl!: HTMLDivElement;
  private queueEl!: HTMLDivElement;
  private radiosEl!: HTMLDivElement;
  private rowsKey = "";

  constructor(
    root: HTMLElement,
    private a: { add(url: string): void; op(op: RadioOp, i?: number): void; mix(sid: number, vol: number, muted: boolean): void },
  ) {
    this.panel = new Panel(root, "Radyo", "hub-panel radio-panel", "radio");
  }

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  toggle(): void {
    if (this.panel.isOpen) this.panel.close();
    else {
      this.build();
      this.panel.open();
    }
  }

  close(): void {
    this.panel.close();
  }

  /** Kendi sıran değişti (sunucudan). */
  setQueue(q: RadioQueueView): void {
    this.queue = q;
    if (this.panel.isOpen) {
      this.renderNow();
      this.renderQueue();
    }
  }

  /** Arabaya bindin ya da indin: kontroller açılır/kapanır. */
  setInCar(on: boolean): void {
    if (on === this.inCar) return;
    this.inCar = on;
    if (this.panel.isOpen) this.build();
  }

  /** Radyo açan üyeler (sık çağrılır: yalnızca liste değişince yeniden çizilir, sürgüler bozulmaz). */
  setRadios(rows: RadioRow[]): void {
    this.rows = rows;
    if (!this.panel.isOpen) return;
    const key = rows.map((r) => `${r.sid}:${r.title}:${r.heard}:${r.muted}`).join("|");
    if (key !== this.rowsKey) this.renderRadios();
  }

  private build(): void {
    const body = this.panel.body;
    body.replaceChildren();
    this.nowEl = el("div", "radio-now", body);
    this.ctrlEl = el("div", "radio-ctrl", body);
    if (this.inCar) {
      const row = el("div", "radio-row", body);
      const input = el("input", "field radio-input", row);
      input.placeholder = "YouTube / Spotify şarkı ya da çalma listesi linki…";
      const add = () => {
        const url = input.value.trim();
        if (url) this.a.add(url);
        input.value = "";
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") add();
      });
      button(row, "Sıraya ekle", add, "radio-play");
    } else el("div", "settings-note hub-note radio-lock", body, `Radyoyu arabadan kontrol edebilirsin (${actionLabel("car")}). İnince çalmaya devam eder.`);
    el("h4", "settings-section", body, "Sıra");
    this.queueEl = el("div", "radio-queue", body);
    el("h4", "settings-section", body, "Çalan radyolar");
    this.radiosEl = el("div", "radio-list", body);
    el("h4", "settings-section", body, "Genel ses");
    const vol = el("input", "radio-volume", body);
    vol.type = "range";
    vol.min = "0";
    vol.max = "100";
    vol.value = String(Math.round(settings.radioVolume * 100));
    paintRange(vol);
    vol.addEventListener("input", () => {
      paintRange(vol);
      updateSettings({ radioVolume: Number(vol.value) / 100 });
    });
    el("div", "settings-note hub-note", body, `Etraftakiler arabana yaklaştıkça şarkıyı daha yüksek duyar. Radyo: ${actionLabel("radio")}`);
    this.renderNow();
    this.renderQueue();
    this.renderRadios();
  }

  private renderNow(): void {
    const q = this.queue, cur = q && q.playing ? q.items[q.index] : null;
    this.nowEl.replaceChildren();
    el("span", `radio-eq${cur ? " on" : ""}`, this.nowEl, cur ? "▮▮▮" : "");
    el("span", "radio-title", this.nowEl, cur ? cur.title : q?.items.length ? "Durduruldu" : "Sıra boş");
    const c = this.ctrlEl;
    c.replaceChildren();
    const has = !!q?.items.length, lock = !this.inCar;
    const b = (name: IconName, title: string, on: () => void, ok = true, cls = "") => {
      const x = button(c, "", on, `radio-btn ${cls}`);
      icon(name, "", x);
      x.title = title;
      x.setAttribute("aria-label", title);
      x.disabled = lock || !ok;
    };
    b("shuffle", "Karıştır", () => this.a.op("shuffle"), has, q?.shuffle ? "on" : "");
    b("skipBack", "Önceki / başa sar", () => this.a.op("prev"), has);
    b(q?.playing ? "stop" : "play", q?.playing ? "Durdur" : "Çal", () => this.a.op(q?.playing ? "stop" : "play"), has, "main");
    b("skipForward", "Sonraki", () => this.a.op("next"), has);
    const rep = q?.repeat ?? "off";
    b(rep === "one" ? "repeatOne" : "repeat", rep === "off" ? "Tekrar: kapalı" : rep === "all" ? "Tekrar: liste" : "Tekrar: şarkı", () => this.a.op("repeat"), has, rep !== "off" ? "on" : "");
  }

  private renderQueue(): void {
    const box = this.queueEl, q = this.queue;
    box.replaceChildren();
    if (!q?.items.length) {
      el("div", "settings-note hub-note", box, "Link ekledikçe şarkılar sıraya girer; çalma listesi linki bütün şarkılarını ekler.");
      return;
    }
    q.items.forEach((it, i) => {
      const row = el("div", `radio-item${i === q.index ? " cur" : ""}${i < q.index ? " past" : ""}`, box);
      const t = el("button", "radio-itemtitle", row, `${i === q.index && q.playing ? "▶ " : `${i + 1}. `}${it.title}`);
      t.disabled = !this.inCar;
      t.addEventListener("click", () => this.a.op("jump", i));
      const x = el("button", "radio-itemx", row);
      icon("close", "", x);
      x.title = "Sıradan çıkar";
      x.disabled = !this.inCar;
      x.addEventListener("click", () => this.a.op("remove", i));
    });
    if (this.inCar) button(box, "Sırayı temizle", () => this.a.op("clear"), "radio-clear");
    box.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
  }

  private renderRadios(): void {
    const box = this.radiosEl;
    if (!box) return;
    this.rowsKey = this.rows.map((r) => `${r.sid}:${r.title}:${r.heard}:${r.muted}`).join("|");
    box.replaceChildren();
    if (!this.rows.length) {
      el("div", "settings-note hub-note", box, "Şu an kimse radyo çalmıyor.");
      return;
    }
    for (const r of this.rows) {
      const row = el("div", `radio-member${r.muted ? " muted" : ""}${r.heard ? " heard" : ""}`, box);
      const head = el("div", "radio-memberhead", row);
      el("b", "", head, r.own ? `${r.name} (sen)` : r.name);
      el("span", "radio-membersong", head, `${r.title}${r.heard || r.own ? "" : " · uzakta"}`);
      const ctl = el("div", "radio-memberctl", row);
      const mute = el("button", "radio-mute", ctl);
      icon(r.muted ? "speakerOff" : "speaker", "", mute);
      mute.title = r.muted ? "Sesi aç" : "Sesi kapat";
      const vol = el("input", "radio-volume", ctl);
      vol.type = "range";
      vol.min = "0";
      vol.max = "100";
      vol.value = String(Math.round(r.vol * 100));
      vol.disabled = r.muted;
      paintRange(vol);
      mute.addEventListener("click", () => this.a.mix(r.sid, r.vol, !r.muted));
      vol.addEventListener("input", () => {
        paintRange(vol);
        r.vol = Number(vol.value) / 100;
        this.a.mix(r.sid, r.vol, false);
      });
    }
  }
}
