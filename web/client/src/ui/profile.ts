// Oyuncu kartı (seviye, XP, sıra, seri, balık albümü, dünya sayaçları, sezon) ve günlük görevler.
// Veriler botta; sunucu üzerinden istenir. Kendi kartında görevler de görünür.
import type { Profile, QuestDone } from "../../../shared/protocol";
import { button, el, Panel } from "./panel";

/** Bottaki balıklar (fishing.py RARITIES ile aynı sıra: yaygından nadire). */
const FISH = [
  { key: "common", name: "Sazan", label: "Yaygın", emoji: "🐟", color: "#9fb3c8" },
  { key: "uncommon", name: "Kızılkanat", label: "Az Bulunur", emoji: "🐠", color: "#6fcf7f" },
  { key: "rare", name: "Turna", label: "Nadir", emoji: "🦈", color: "#5aa8ff" },
  { key: "epic", name: "Yayın Balığı", label: "Epik", emoji: "🐋", color: "#b06cff" },
  { key: "legendary", name: "Altın Sazan", label: "Efsanevi", emoji: "🌟", color: "#ffc93c" },
];

const STATS: [string, string, (v: number) => string][] = [
  ["goals", "⚽ Gol", String],
  ["wins", "🏆 Kahvehane galibiyeti", String],
  ["games", "🎲 Oynanan oyun", String],
  ["tank_kills", "💥 Vurulan tank", String],
  ["tank_wins", "🪖 Kazanılan savaş", String],
  ["tag_wins", "🏃 Ebelemece/saklambaç", String],
  ["race_wins", "🏎️ Yarış galibiyeti", String],
  ["pb_wins", "🎯 Paintball galibiyeti", String],
  ["pb_hits", "🎨 Paintball isabeti", String],
  ["fives", "🙌 Beşlik", String],
  ["hugs", "🤗 Sarılma", String],
  ["photos", "📸 Fotoğraf", String],
  ["ride_m", "🚲 Bisiklet/kaykay", (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} km` : `${v} m`)],
];

export class ProfileUi {
  private card: Panel;
  private questPanel: Panel;
  private wanted = 0;
  private myProfile: Profile | null = null;

  constructor(
    root: HTMLElement,
    private opts: {
      me: () => number;
      request: (sid: number) => void;
      /** Avatar görseli (yoksa null). */
      avatar: (sid: number) => string | null;
    },
  ) {
    this.card = new Panel(root, "OYUNCU KARTI", "profile-card");
    this.questPanel = new Panel(root, "GÜNÜN GÖREVLERİ", "quest-panel");
  }

  /** Bir oyuncunun kartını aç (veri gelince dolar). */
  open(sid: number, name: string): void {
    this.wanted = sid;
    this.card.title = sid === this.opts.me() ? "KARTIM" : "OYUNCU KARTI";
    this.card.body.replaceChildren();
    el("div", "pc-loading", this.card.body, `${name} · yükleniyor…`);
    this.card.open();
    this.opts.request(sid);
  }

  openQuests(): void {
    this.questPanel.open();
    this.renderQuests();
    this.opts.request(this.opts.me());
  }

  toggleQuests(): void {
    if (this.questPanel.isOpen) this.questPanel.close();
    else this.openQuests();
  }

  /** Albüm: kendi kartını aç ve albüme kaydır. */
  openAlbum(name: string): void {
    this.open(this.opts.me(), name);
    this.card.root.classList.add("album-focus");
  }

  onProfile(sid: number, name: string, p: Profile | null, error?: string): void {
    if (sid === this.opts.me() && p) {
      this.myProfile = p;
      if (this.questPanel.isOpen) this.renderQuests();
    }
    if (sid !== this.wanted || !this.card.isOpen) return;
    const b = this.card.body;
    b.replaceChildren();
    const head = el("div", "pc-head", b);
    const url = this.opts.avatar(sid);
    if (url) {
      const img = el("img", "pc-avatar", head);
      img.src = url;
      img.alt = "";
    } else el("div", "pc-avatar pc-noavatar", head, name.slice(0, 1).toLocaleUpperCase("tr-TR"));
    const who = el("div", "pc-who", head);
    el("div", "pc-name", who, name);
    if (!p) {
      el("div", "pc-sub", who, error ?? "Kart bulunamadı.");
      return;
    }
    el("div", "pc-sub", who, `Seviye ${p.level} · #${p.rank} · 🔥 ${p.streak} gün`);
    const span = Math.max(1, p.ceiling - p.floor);
    const bar = el("div", "pc-bar", b);
    const fill = el("div", "pc-fill", bar);
    fill.style.width = `${Math.min(100, ((p.xp - p.floor) / span) * 100)}%`;
    el("div", "pc-xp", b, p.ceiling > p.xp ? `${p.xp.toLocaleString("tr")} XP · sonraki seviyeye ${(p.ceiling - p.xp).toLocaleString("tr")}` : `${p.xp.toLocaleString("tr")} XP · en üst seviye`);

    el("h4", "settings-section", b, "🐟 Balık albümü");
    const album = el("div", "pc-album", b);
    let total = 0;
    for (const f of FISH) {
      const n = p.fish[f.key] ?? 0;
      total += n;
      const c = el("div", `pc-fish${n ? "" : " locked"}`, album);
      c.style.setProperty("--rarity", f.color);
      el("div", "pc-fish-emoji", c, n ? f.emoji : "❔");
      el("div", "pc-fish-name", c, n ? f.name : "???");
      el("div", "pc-fish-count", c, n ? `×${n}` : f.label);
    }
    el("div", "settings-note", b, `${total} balık · ${FISH.filter((f) => (p.fish[f.key] ?? 0) > 0).length}/5 tür`);

    el("h4", "settings-section", b, "🌍 Dünyada");
    const grid = el("div", "pc-stats", b);
    for (const [key, label, fmt] of STATS) {
      const v = p.stats[key] ?? 0;
      if (!v && key !== "goals" && key !== "wins") continue;
      const row = el("div", "pc-stat", grid);
      el("span", "", row, label);
      el("b", "", row, fmt(v));
    }
    if (p.season.key) {
      const [y, m] = p.season.key.split("-");
      const month = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("tr", { month: "long" });
      el("div", "settings-note", b, `Bu ay (${month}) tank sezonu: ${p.season.tank_kills ?? 0} vuruş · ${p.season.tank_wins ?? 0} galibiyet · ${p.season.goals ?? 0} gol`);
    }
    if (sid === this.opts.me() && p.quests.length) {
      el("h4", "settings-section", b, "📋 Günün görevleri");
      this.questList(b, p);
    }
    if (this.card.root.classList.contains("album-focus")) {
      album.scrollIntoView({ block: "center" });
      this.card.root.classList.remove("album-focus");
    }
  }

  private questList(parent: HTMLElement, p: Profile): void {
    const list = el("div", "quest-list", parent);
    for (const q of p.quests) {
      const row = el("div", `quest${q.done ? " done" : ""}`, list);
      el("span", "quest-check", row, q.done ? "✅" : "⬜");
      const text = el("div", "quest-text", row);
      el("div", "", text, q.title);
      const bar = el("div", "quest-bar", text);
      el("div", "quest-fill", bar).style.width = `${Math.min(100, (q.progress / q.target) * 100)}%`;
      el("span", "quest-xp", row, `+${q.xp} XP`);
    }
  }

  private renderQuests(): void {
    const b = this.questPanel.body;
    b.replaceChildren();
    const p = this.myProfile;
    if (!p) {
      el("div", "pc-loading", b, "Görevler yükleniyor… (görevler Discord'dan girenlere açık)");
      return;
    }
    this.questList(b, p);
    el("div", "settings-note", b, "Görevler her gün (Türkiye saatiyle) yenilenir. Tamamlayınca XP hesabına eklenir.");
    button(b, "Kartımı aç", () => this.open(this.opts.me(), "Ben"), "settings-reset");
  }

  /** Tamamlanan görev: kartta güncel kalsın. */
  questsDone(done: QuestDone[]): void {
    if (!this.myProfile) return;
    for (const d of done) {
      const q = this.myProfile.quests.find((x) => x.key === d.key);
      if (q) {
        q.done = true;
        q.progress = q.target;
      }
    }
    if (this.questPanel.isOpen) this.renderQuests();
  }
}
