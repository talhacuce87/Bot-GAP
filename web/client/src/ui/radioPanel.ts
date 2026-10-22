// 📻 Tofaş radyosu: YouTube ya da Spotify linki yapıştır, çal; çevredekiler yaklaştıkça daha yüksek duyar.
import type { CarRadio } from "../../../shared/car";
import { actionLabel } from "../input/keybinds";
import { settings, updateSettings } from "../settings";
import { button, el, Panel } from "./panel";

export class RadioPanel {
  private panel: Panel;
  private radio: CarRadio | null = null;

  constructor(root: HTMLElement, private a: { play(url: string): void; stop(): void }) {
    this.panel = new Panel(root, "📻 TOFAŞ RADYO", "hub-panel radio-panel");
  }

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  toggle(): void {
    if (this.panel.isOpen) this.panel.close();
    else {
      this.render();
      this.panel.open();
    }
  }

  close(): void {
    this.panel.close();
  }

  /** Çalan şarkı değişti (sunucudan). */
  set(radio: CarRadio | null): void {
    this.radio = radio;
    if (this.panel.isOpen) this.render();
  }

  private render(): void {
    const body = this.panel.body;
    body.replaceChildren();
    const now = el("div", "radio-now", body);
    el("span", "radio-eq", now, this.radio ? "▮▮▮" : "");
    el("span", "radio-title", now, this.radio ? this.radio.title : "Radyo kapalı");
    const row = el("div", "radio-row", body);
    const input = el("input", "radio-input", row);
    input.placeholder = "YouTube ya da Spotify şarkı linki…";
    const play = () => {
      const url = input.value.trim();
      if (url) this.a.play(url);
      input.value = "";
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") play();
    });
    button(row, "▶ Çal", play, "radio-play");
    if (this.radio) button(body, "■ Radyoyu kapat", () => this.a.stop(), "radio-stop");
    el("h4", "settings-section", body, "Ses");
    const vol = el("input", "radio-volume", body);
    vol.type = "range";
    vol.min = "0";
    vol.max = "100";
    vol.value = String(Math.round(settings.radioVolume * 100));
    vol.addEventListener("input", () => updateSettings({ radioVolume: Number(vol.value) / 100 }));
    el("div", "settings-note hub-note", body, `Etraftakiler arabana yaklaştıkça şarkıyı daha yüksek duyar. Radyo: ${actionLabel("radio")} · arabadan inince susar.`);
  }
}
