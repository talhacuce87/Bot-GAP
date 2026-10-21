// 🎒 Menü: dünyadaki yeni şeylere tek yerden erişim (görevler, kart/albüm, fotoğraf, araç, evcil hayvan,
// havai fişek, mini oyunlar, beşlik/sarılma, şarkı kuyruğu, hava). Kısayol: M.
import { PETS, SKINS } from "../../../shared/protocol";
import { actionLabel } from "../input/keybinds";
import { settings, updateSettings } from "../settings";
import { button, el, Panel } from "./panel";

export interface HubActions {
  quests(): void;
  card(): void;
  album(): void;
  photo(): void;
  vehicle(v: 0 | 1 | 2): void;
  fireworks(): void;
  tag(mode: "ebelemece" | "saklambac"): void;
  /** Futbol maçı başlat (5 dk) ya da süreni bitir. */
  match(): void;
  pair(kind: "five" | "hug"): void;
  queue(): void;
  weather(): void;
  battle(): void;
  /** Evcil hayvan / kamuflaj değişti (sunucuya bildir). */
  cosmetics(): void;
}

export class Hub {
  private panel: Panel;

  constructor(root: HTMLElement, touch: boolean, private a: HubActions) {
    const b = el("button", "wardrobe-btn hub-btn", root, "🎒");
    b.title = touch ? "Menü" : `Menü (${actionLabel("menu")})`;
    b.addEventListener("click", () => this.toggle());
    this.panel = new Panel(root, "MENÜ", "hub-panel");
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

  private render(): void {
    const body = this.panel.body;
    body.replaceChildren();
    const grid = (title: string) => {
      el("h4", "settings-section", body, title);
      return el("div", "hub-grid", body);
    };
    const tile = (parent: HTMLElement, emoji: string, label: string, fn: () => void, hint = "") => {
      const t = button(parent, "", () => {
        fn();
        this.panel.close();
      }, "hub-tile");
      el("span", "hub-emoji", t, emoji);
      el("span", "hub-label", t, label);
      if (hint) el("span", "hub-key", t, hint);
    };

    const me = grid("Ben");
    tile(me, "📋", "Görevler", this.a.quests, actionLabel("quests"));
    tile(me, "🪪", "Kartım", this.a.card, actionLabel("card"));
    tile(me, "🐟", "Balık albümü", this.a.album, actionLabel("album"));
    tile(me, "📸", "Fotoğraf", this.a.photo, actionLabel("photo"));

    const go = grid("Ulaşım");
    tile(go, "🚶", "Yürü", () => this.a.vehicle(0));
    tile(go, "🚲", "Bisiklet", () => this.a.vehicle(1), actionLabel("vehicle"));
    tile(go, "🛹", "Kaykay", () => this.a.vehicle(2));
    el("div", "settings-note hub-note", body, "🛶 Kayık: gölün batısındaki iskelede F.");

    const fun = grid("Eğlence");
    tile(fun, "🎆", "Havai fişek", this.a.fireworks);
    tile(fun, "🏃", "Ebelemece", () => this.a.tag("ebelemece"));
    tile(fun, "🙈", "Saklambaç", () => this.a.tag("saklambac"));
    tile(fun, "⚽", "Futbol maçı", this.a.match);
    tile(fun, "🙌", "Beşlik çak", () => this.a.pair("five"), actionLabel("five"));
    tile(fun, "🤗", "Sarıl", () => this.a.pair("hug"), actionLabel("hug"));
    tile(fun, "🎵", "Şarkı kuyruğu", this.a.queue);
    tile(fun, "🌦️", "Hava", this.a.weather);
    tile(fun, "⚔️", "Tank savaşı", this.a.battle);

    el("h4", "settings-section", body, "🐾 Evcil hayvan");
    const pets = el("div", "settings-seg hub-pets", body);
    const pick = (id: string) => {
      updateSettings({ pet: id });
      this.a.cosmetics();
      this.render();
    };
    button(pets, "Yok", () => pick(""), settings.pet === "" ? "active" : "");
    for (const p of PETS) button(pets, `${p.emoji} ${p.name}`, () => pick(p.id), settings.pet === p.id ? "active" : "");

    el("h4", "settings-section", body, "🪖 Tank kamuflajı");
    const skins = el("div", "settings-seg hub-pets", body);
    for (const s of SKINS) {
      button(skins, s.name, () => {
        updateSettings({ skin: s.id });
        this.a.cosmetics();
        this.render();
      }, settings.skin === s.id ? "active" : "");
    }
  }
}
