// 📱 Telefon (GTA V gibi, iPhone görünümünde): ↑ ile sağ altta yukarı kayarak açılır, açıkken yürümeye devam
// edilir. Oklarla uygulamalar arasında gezilir, Enter açar, Backspace geri (ana ekranda kapatır), Esc kapatır;
// fareyle de tıklanır. Eski menünün (M) yerini alır: haritanın, inşanın ve diğer kısayollu şeylerin kendi tuşu var,
// telefonda yalnızca kısayolu olmayanlar ve yeni uygulamalar (işler, cüzdan, mesajlar) durur.
import { lira, type WalletView } from "../../../shared/economy";
import { JOB_PAY, JOBS, type JobKind, type JobView } from "../../../shared/jobs";
import { PETS, SKINS } from "../../../shared/protocol";
import { actionLabel } from "../input/keybinds";
import { settings, updateSettings } from "../settings";
import { type IconName, icon } from "./icons";
import { toolButton } from "./layout";
import { el } from "./panel";

/** Duvar kağıtları (Ayarlar uygulamasından seçilir). */
export const WALLS: Record<string, { name: string; bg: string }> = {
  gece: { name: "GAP gecesi", bg: "linear-gradient(160deg, #1b3a5c, #5b2a6e 60%, #c05a3c)" },
  bogaz: { name: "Boğaz", bg: "linear-gradient(180deg, #0f2a4a, #1e6091 45%, #f4a261 80%, #e76f51)" },
  cay: { name: "Çay bahçesi", bg: "linear-gradient(170deg, #3b2314, #8a3b12 55%, #e9b872)" },
  neon: { name: "Neon şehir", bg: "linear-gradient(150deg, #120024, #3a0ca3 45%, #f72585 85%)" },
  orman: { name: "Orman", bg: "linear-gradient(170deg, #0b2b1f, #1d6b48 50%, #a7c957)" },
  gri: { name: "Sade", bg: "linear-gradient(170deg, #1b1f27, #2b313d)" },
};

export interface PhoneApps {
  quests(): void;
  card(): void;
  album(): void;
  photo(): void;
  car(): void;
  /** GAP Galeri (araba satın al). */
  gallery(): void;
  fireworks(): void;
  tag(mode: "ebelemece" | "saklambac"): void;
  match(): void;
  volley(): void;
  battle(): void;
  weather(): void;
  queue(): void;
  radio(): void;
  /** Evcil hayvan / kamuflaj değişti (sunucuya bildir). */
  cosmetics(): void;
  /** Cüzdanı sunucudan iste (gelince showWallet). */
  wallet(): void;
  /** Banka: dünyadaki oyuncular ve para gönder. */
  players(): { sid: number; name: string }[];
  pay(sid: number, amount: number): void;
  /** İşe gir (kind) ya da işten çık (null); işin aracını yanına çağır. */
  job(kind: JobKind | null): void;
  jobCar(): void;
  /** Taksi çağır / çağrıyı iptal et. */
  taxi(on: boolean): void;
}

type AppId = "jobs" | "events" | "profile" | "camera" | "car" | "wallet" | "music" | "settings" | "messages";
/** Uygulamalar: simge ve iki tonlu zemin (üst, alt). */
const APPS: { id: AppId; icon: IconName; name: string; color: [string, string]; dock?: boolean }[] = [
  { id: "jobs", icon: "briefcase", name: "İşler", color: ["#2fbf8a", "#14845d"] },
  { id: "events", icon: "confetti", name: "Etkinlik", color: ["#ffb24a", "#e0741c"] },
  { id: "profile", icon: "user", name: "Profil", color: ["#8f86ff", "#5a4fd6"] },
  { id: "camera", icon: "camera", name: "Kamera", color: ["#59606b", "#2f343c"] },
  { id: "car", icon: "car", name: "Araba", color: ["#ff7a52", "#d4452a"] },
  { id: "wallet", icon: "wallet", name: "Cüzdan", color: ["#47c37c", "#23854d"], dock: true },
  { id: "music", icon: "music", name: "Müzik", color: ["#ff6f9b", "#d23a6c"], dock: true },
  { id: "settings", icon: "gear", name: "Ayarlar", color: ["#8d939d", "#555b65"], dock: true },
  { id: "messages", icon: "chat", name: "Mesajlar", color: ["#4ea2ff", "#2367c9"], dock: true },
];
const COLS = 4;

export class Phone {
  private root: HTMLDivElement;
  private screen: HTMLDivElement;
  private body: HTMLDivElement;
  private clock: HTMLElement;
  private app: AppId | null = null;
  /** Okla gezilen öğeler ve seçili olan. */
  private items: HTMLElement[] = [];
  private focus = 0;
  private balance = 0;
  private walletView: WalletView | null = null;
  private jobView: JobView | null = null;
  private calling = false;
  private timer = 0;

  constructor(parent: HTMLElement, touch: boolean, private a: PhoneApps) {
    toolButton(parent, { icon: "mobile", label: "Telefon", action: touch ? undefined : "menu", group: 0, order: 1, onClick: () => this.toggle() });
    this.root = el("div", "phone", parent);
    this.screen = el("div", "ph-screen", this.root);
    el("div", "ph-island", this.screen);
    const bar = el("div", "ph-status", this.screen);
    this.clock = el("span", "ph-clock", bar);
    const right = el("span", "ph-status-r", bar);
    icon("wifi", "", right);
    el("i", "ph-battery", right);
    this.body = el("div", "ph-body", this.screen);
    el("div", "ph-home-bar", this.screen).addEventListener("click", () => (this.app ? this.home() : this.close()));
    // Açıkken oklar, Enter ve Backspace telefona (yürüme WASD ile sürer)
    addEventListener("keydown", (e) => this.onKey(e), true);
    this.paintWall();
  }

  get isOpen(): boolean {
    return this.root.classList.contains("show");
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 10_000);
    this.home();
    this.root.classList.add("show");
  }

  close(): void {
    window.clearInterval(this.timer);
    this.root.classList.remove("show");
  }

  setBalance(b: number): void {
    this.balance = b;
    if (this.isOpen && !this.app) this.home(this.focus);
  }

  setJob(v: JobView | null): void {
    const was = !!this.jobView;
    this.jobView = v;
    if (this.isOpen && this.app === "jobs" && was !== !!v) this.openApp("jobs");
  }

  setCalling(on: boolean): void {
    this.calling = on;
    if (this.isOpen && this.app === "messages") this.openApp("messages");
  }

  showWallet(v: WalletView): void {
    this.walletView = v;
    if (this.isOpen && this.app === "wallet") this.openApp("wallet");
  }

  private tick(): void {
    this.clock.textContent = new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" });
  }

  private paintWall(): void {
    this.screen.style.background = (WALLS[settings.phoneWall] ?? WALLS.gece).bg;
  }

  // ---- Gezinme ----

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Backspace", "Escape"].includes(k)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && (k === "Enter" || k === "Backspace" || k === "Escape")) return;
    const n = this.items.length, grid = !this.app;
    if (k === "Escape") this.close();
    else if (k === "Backspace") this.app ? this.home() : this.close();
    else if (k === "Enter") this.items[this.focus]?.click();
    else if (n) {
      const step = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : k === "ArrowUp" ? (grid ? -COLS : -1) : grid ? COLS : 1;
      if (!grid && (k === "ArrowLeft" || k === "ArrowRight")) return;
      this.setFocus(Math.max(0, Math.min(n - 1, this.focus + step)));
    }
  }

  private setFocus(i: number): void {
    this.items[this.focus]?.classList.remove("focus");
    this.focus = i;
    const it = this.items[i];
    it?.classList.add("focus");
    it?.scrollIntoView({ block: "nearest" });
  }

  private reset(): void {
    this.body.replaceChildren();
    this.items = [];
    this.focus = 0;
  }

  // ---- Ana ekran ----

  private home(focus = 0): void {
    this.app = null;
    this.reset();
    this.body.className = "ph-body";
    const w = el("div", "ph-widget", this.body);
    const left = el("div", "", w);
    el("b", "", left, lira(this.balance));
    el("small", "", left, "GAP Cüzdan");
    const right = el("div", "ph-widget-r", w);
    el("b", "", right, "GAP Köyü");
    el("small", "", right, new Date().toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Istanbul" }));
    w.addEventListener("click", () => this.openApp("wallet"));
    const grid = el("div", "ph-apps", this.body);
    const dock = el("div", "ph-dock", this.body);
    for (const app of APPS) {
      const t = el("button", "ph-app", app.dock ? dock : grid);
      const tile = el("span", "ph-icon", t);
      tile.style.background = `linear-gradient(160deg, ${app.color[0]}, ${app.color[1]})`;
      icon(app.icon, "", tile);
      if (!app.dock) el("span", "ph-name", t, app.name);
      t.title = app.name;
      t.addEventListener("click", () => this.openApp(app.id));
      this.items.push(t);
    }
    // Dock ızgaranın son satırı gibi gezilir: ızgara satırını 4'e tamamla
    const pad = (COLS - (APPS.filter((x) => !x.dock).length % COLS)) % COLS;
    const dockStart = this.items.length - APPS.filter((x) => x.dock).length;
    for (let i = 0; i < pad; i++) this.items.splice(dockStart, 0, this.items[dockStart - 1]);
    this.setFocus(Math.min(focus, this.items.length - 1));
  }

  // ---- Uygulamalar ----

  private openApp(id: AppId, focus = 0): void {
    // Doğrudan açılanlar
    if (id === "camera") return this.run(this.a.photo);
    const app = APPS.find((x) => x.id === id)!;
    this.app = id;
    this.reset();
    this.body.className = `ph-body ph-app-${id}`;
    const head = el("div", "ph-head", this.body);
    const back = el("button", "ph-back", head);
    icon("back", "", back);
    back.setAttribute("aria-label", "Geri");
    back.addEventListener("click", () => this.home());
    el("b", "", head, app.name);
    const list = el("div", "ph-list", this.body);
    switch (id) {
      case "jobs": {
        const v = this.jobView;
        if (v) {
          const j = JOBS[v.kind];
          this.card(list, j.icon, `${j.name} · çalışıyorsun`, `Bugün ${v.done} iş · ${lira(v.earned)} kazandın`);
          this.row(list, v.kind === "kurye" ? "🛵" : "🚕", "Aracımı çağır", v.kind === "kurye" ? "GAP Kurye scooter'ı" : "Sarı GAP Taksi", () => this.run(this.a.jobCar));
          this.row(list, "🛑", "İşi bırak", "Aracın geri alınır", () => this.run(() => this.a.job(null)));
        } else {
          this.row(list, "📦", "Kuryelik", `Paketleri zamanında teslim et · ${JOB_PAY.kuryeMin}–${JOB_PAY.kuryeMax} ₺`, () => this.run(() => this.a.job("kurye")));
          this.row(list, "🚕", "Taksicilik", `Müşterileri götür · ${JOB_PAY.taksiMin}–${JOB_PAY.taksiMax} ₺`, () => this.run(() => this.a.job("taksi")));
          el("div", "ph-note", list, "İşe girince aracın yanına gelir; hedef haritada ve minimapte turuncu.");
        }
        break;
      }
      case "events":
        this.row(list, "⚽", "Futbol maçı", "5 dk, stadyumda", () => this.run(this.a.match));
        this.row(list, "🏐", "Voleybol", "Salona ışınlan", () => this.run(this.a.volley));
        this.row(list, "⚔️", "Tank savaşı", "", () => this.run(this.a.battle));
        this.row(list, "🏃", "Ebelemece", "", () => this.run(() => this.a.tag("ebelemece")));
        this.row(list, "🙈", "Saklambaç", "", () => this.run(() => this.a.tag("saklambac")));
        this.row(list, "🎆", "Havai fişek", "", () => this.run(this.a.fireworks));
        this.row(list, "🌦️", "Havayı değiştir", "", () => this.run(this.a.weather));
        break;
      case "profile":
        this.row(list, "🪪", "Kartım", actionLabel("card"), () => this.run(this.a.card));
        this.row(list, "📋", "Görevler", actionLabel("quests"), () => this.run(this.a.quests));
        this.row(list, "🐟", "Balık albümü", actionLabel("album"), () => this.run(this.a.album));
        el("h5", "ph-sub", list, "🐾 Evcil hayvan");
        this.chips(list, [["", "Yok"], ...PETS.map((p): [string, string] => [p.id, `${p.emoji} ${p.name}`])], settings.pet, (v) => {
          updateSettings({ pet: v });
          this.a.cosmetics();
        });
        el("h5", "ph-sub", list, "🪖 Tank kamuflajı");
        this.chips(list, SKINS.map((s): [string, string] => [s.id, s.name]), settings.skin, (v) => {
          updateSettings({ skin: v });
          this.a.cosmetics();
        });
        break;
      case "wallet": {
        const v = this.walletView;
        const top = el("div", "ph-balance", list);
        el("small", "", top, "Bakiye");
        el("b", "", top, lira(v?.balance ?? this.balance));
        this.row(list, "💸", "Para gönder", "Dünyadaki bir arkadaşına havale", () => this.sendScreen());
        if (v) {
          const day = el("div", "ph-day", list);
          el("span", "up", day, `Bugün + ${lira(v.earned)}`);
          el("span", "down", day, `− ${lira(v.spent)}`);
          for (const t of v.history.slice(0, 15)) {
            const r = el("div", "ph-tx", list);
            el("span", "", r, t.icon);
            el("span", "ph-tx-mid", r, t.reason);
            el("b", t.amount >= 0 ? "up" : "down", r, `${t.amount >= 0 ? "+" : "−"}${lira(Math.abs(t.amount))}`);
          }
          if (!v.history.length) el("div", "ph-note", list, "Henüz işlem yok.");
        }
        this.a.wallet();
        break;
      }
      case "car":
        this.row(list, "🚗", "Araçlarım", "Arabanı yanına çağır", () => this.run(this.a.car));
        this.row(list, "🏪", "GAP Galeri", "Doblo, Linea, Passat, E30", () => this.run(this.a.gallery));
        el("div", "ph-note", list, "GAP Galeri şehrin doğu ucunda (z=10 caddesinin sonu): arabaları yakından görebilirsin.");
        break;
      case "music":
        this.row(list, "🎵", "Şarkı kuyruğu", "Sinema ve sahnede çalar", () => this.run(this.a.queue));
        this.row(list, "📻", "Araba radyosu", actionLabel("radio"), () => this.run(this.a.radio));
        break;
      case "settings": {
        el("h5", "ph-sub", list, "🖼️ Duvar kağıdı");
        const walls = el("div", "ph-walls", list);
        for (const [id, w] of Object.entries(WALLS)) {
          const b = el("button", `ph-wall${settings.phoneWall === id ? " on" : ""}`, walls);
          b.style.background = w.bg;
          b.title = w.name;
          b.addEventListener("click", () => {
            updateSettings({ phoneWall: id });
            this.paintWall();
            this.openApp("settings", Object.keys(WALLS).indexOf(id));
          });
          this.items.push(b);
        }
        this.row(list, "⚙️", "Tüm ayarlar", "Görüntü, ses, tuşlar", () => this.run(() => dispatchEvent(new Event("gap:settings"))));
        break;
      }
      case "messages":
        this.row(list, "🚕", this.calling ? "Taksi çağrını iptal et" : "Taksi çağır", this.calling ? "Taksiciler yoluna çıktı" : `Taksimetre: ${JOB_PAY.meterStart} ₺ + 100 m'de ${JOB_PAY.meterPer100} ₺`, () => {
          this.a.taxi(!this.calling);
          this.setCalling(!this.calling);
        });
        el("div", "ph-note", list, "Taksi gelince yanına gidip F ile bin; inince ücret cüzdanından ödenir. Mesajlaşma çok yakında.");
        break;
    }
    this.setFocus(Math.min(focus, this.items.length - 1));
  }

  /** Banka havalesi: kime (dünyadakiler) ve ne kadar. */
  private sendScreen(): void {
    this.reset();
    this.body.className = "ph-body ph-app-wallet";
    const head = el("div", "ph-head", this.body);
    const back = el("button", "ph-back", head);
    icon("back", "", back);
    back.setAttribute("aria-label", "Geri");
    back.addEventListener("click", () => this.openApp("wallet"));
    el("b", "", head, "Para gönder");
    const list = el("div", "ph-list", this.body);
    const people = this.a.players();
    if (!people.length) {
      el("div", "ph-note", list, "Dünyada başka kimse yok.");
      return;
    }
    let to = people[0].sid;
    el("h5", "ph-sub", list, "Kime");
    this.chips(list, people.map((p): [string, string] => [String(p.sid), p.name]), String(to), (v) => (to = Number(v)));
    el("h5", "ph-sub", list, "Ne kadar (₺)");
    const amount = el("input", "ph-input", list);
    amount.inputMode = "numeric";
    amount.type = "number";
    amount.min = "1";
    amount.placeholder = "500";
    const send = el("button", "ph-row ph-send", list);
    el("span", "ph-row-ic", send, "💸");
    el("b", "ph-row-mid", send, "Gönder");
    send.addEventListener("click", () => {
      const n = Math.floor(Number(amount.value));
      if (!(n >= 1)) return amount.focus();
      this.a.pay(to, n);
      this.openApp("wallet");
    });
    this.items.push(send);
    this.setFocus(0);
  }

  /** Uygulamayı çalıştır ve telefonu kapat. */
  private run(fn: () => void): void {
    this.close();
    fn();
  }

  private row(parent: HTMLElement, emoji: string, name: string, hint: string, fn: () => void): void {
    const r = el("button", "ph-row", parent);
    el("span", "ph-row-ic", r, emoji);
    const mid = el("span", "ph-row-mid", r);
    el("b", "", mid, name);
    if (hint) el("small", "", mid, hint);
    icon("chevron", "ph-chev", r);
    r.addEventListener("click", fn);
    this.items.push(r);
  }

  private card(parent: HTMLElement, emoji: string, name: string, text: string): void {
    const c = el("div", "ph-card", parent);
    el("span", "ph-row-ic", c, emoji);
    const mid = el("span", "ph-row-mid", c);
    el("b", "", mid, name);
    el("small", "", mid, text);
  }

  private chips(parent: HTMLElement, opts: [string, string][], cur: string, pick: (v: string) => void): void {
    const box = el("div", "ph-chips", parent);
    for (const [v, label] of opts) {
      const b = el("button", `ph-chip${v === cur ? " on" : ""}`, box, label);
      b.addEventListener("click", () => {
        pick(v);
        for (const c of box.children) c.classList.toggle("on", c === b);
      });
      this.items.push(b);
    }
  }
}
