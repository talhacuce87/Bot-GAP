// Mahalle: arsalar bot veritabanında; oda açılınca yüklenir, blok değişiklikleri herkese anında gider ve
// birkaç saniyede bir toplu kaydedilir. Her üyenin tek arsası olur; yalnızca sahibi blok koyar/siler.
// Bot bağlı değilse (yerel geliştirme) arsalar yalnızca bellekte, misafirler de inşa edebilir.
import { type Block, cellKey, decodeBlocks, encodeBlocks, inPlot, PLOT_MAX_BLOCKS, PLOTS, type PlotState, blockDef } from "../../../shared/build";
import type { BotPost } from "../looks";
import type { Conn, Room } from "../room";

const SAVE_DELAY_MS = 4000;
/** Blok koyma sıklığı: saniyede en çok bu kadar. */
const EDIT_RATE = 20;

interface PlotData {
  owner: string | null;
  name: string;
  blocks: Map<number, Block>;
}

export class Builds {
  private plots: PlotData[] = PLOTS.map(() => ({ owner: null, name: "", blocks: new Map() }));
  private loaded = false;
  private loading: Promise<void> | null = null;
  private saveTimers = new Map<number, NodeJS.Timeout>();
  private edits = new Map<number, { at: number; n: number }>();

  constructor(
    private room: Room,
    private bot: BotPost | null,
  ) {}

  private guild(): string | null {
    for (const p of this.room.players.values()) if (p.guild) return p.guild;
    return null;
  }

  /** İlk girişte arsalar yüklenir; o zamana kadar boş görünür, yüklenince herkese gider. */
  private ensureLoaded(): void {
    if (this.loaded || this.loading) return;
    const guild = this.guild();
    if (!this.bot || !guild) {
      this.loaded = true;
      return;
    }
    this.loading = this.bot("/internal/builds", { guild })
      .then((r) => {
        const list = Array.isArray(r.body.plots) ? (r.body.plots as { plot: number; user: string; name?: string; data: string }[]) : [];
        for (const row of list) {
          const p = this.plots[row.plot];
          if (!p) continue;
          p.owner = String(row.user);
          p.name = typeof row.name === "string" ? row.name : "Komşu";
          p.blocks = new Map(decodeBlocks(String(row.data ?? "")).map((b) => [cellKey(b.i, b.j, b.k), b]));
        }
        this.loaded = true;
        this.room.broadcast({ t: "plots", plots: this.states() });
      })
      .catch((err) => console.warn("[build] yüklenemedi:", (err as Error).message))
      .finally(() => (this.loading = null));
  }

  private state(id: number): PlotState {
    const p = this.plots[id];
    return { id, owner: p.owner, name: p.name, data: encodeBlocks([...p.blocks.values()]) };
  }

  private states(): PlotState[] {
    return this.plots.map((_, id) => this.state(id));
  }

  sendTo(conn: Conn): void {
    this.ensureLoaded();
    this.room.sendTo(conn, { t: "plots", plots: this.states() });
  }

  private notice(sid: number, text: string): void {
    const conn = this.room.players.get(sid)?.conn;
    if (conn) this.room.sendTo(conn, { t: "notice", text });
  }

  /** İnşa edebilir mi (Discord'dan gelen üye; bot yoksa herkes). */
  private builder(sid: number): { id: string; name: string } | null {
    this.ensureLoaded();
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator) return null;
    if (this.bot && (p.user.guest || !p.guild)) return null;
    return { id: p.user.id, name: p.user.name };
  }

  plotOf(userId: string): number {
    return this.plots.findIndex((p) => p.owner === userId);
  }

  /** Boş arsa sahiplen (zaten varsa onu gösterir). */
  claim(sid: number): void {
    const u = this.builder(sid);
    if (!u) return this.notice(sid, "🔨 İnşa için dünyaya Discord'dan gir.");
    if (!this.loaded) return this.notice(sid, "🔨 Mahalle yükleniyor, birazdan tekrar dene.");
    if (this.plotOf(u.id) >= 0) return this.notice(sid, "🏠 Zaten bir arsan var.");
    const id = this.plots.findIndex((p) => !p.owner);
    if (id < 0) return this.notice(sid, "🏘️ Mahallede boş arsa kalmadı.");
    const p = this.plots[id];
    p.owner = u.id;
    p.name = u.name;
    p.blocks.clear();
    this.room.broadcast({ t: "plot", plot: this.state(id) });
    this.save(id, true);
  }

  /** Kendi arsasına blok koy (b > 0) ya da sil (b 0). */
  set(sid: number, i: number, j: number, k: number, b: number, r: number, now = Date.now()): void {
    const u = this.builder(sid);
    if (!u || !this.loaded) return;
    const id = this.plotOf(u.id);
    if (id < 0 || !inPlot(i, j, k) || !Number.isInteger(b) || !Number.isInteger(r) || r < 0 || r > 3) return;
    if (b !== 0 && !blockDef(b)) return;
    const e = this.edits.get(sid);
    if (e && now - e.at < 1000) {
      if (++e.n > EDIT_RATE) return;
    } else this.edits.set(sid, { at: now, n: 1 });
    const p = this.plots[id];
    const key = cellKey(i, j, k);
    if (b === 0) {
      if (!p.blocks.delete(key)) return;
    } else {
      if (!p.blocks.has(key) && p.blocks.size >= PLOT_MAX_BLOCKS) return this.notice(sid, `🧱 Arsada en çok ${PLOT_MAX_BLOCKS} blok olabilir.`);
      p.blocks.set(key, { i, j, k, b, r });
    }
    this.room.broadcast({ t: "bset", plot: id, i, j, k, b, r });
    this.save(id);
  }

  /** Arsayı boşalt (bütün blokları siler, arsa başkasına açılır). */
  free(sid: number): void {
    const u = this.builder(sid);
    if (!u) return;
    const id = this.plotOf(u.id);
    if (id < 0) return this.notice(sid, "🏠 Arsan yok.");
    const p = this.plots[id];
    p.owner = null;
    p.name = "";
    p.blocks.clear();
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    this.room.broadcast({ t: "plot", plot: this.state(id) });
    const guild = this.guild();
    if (this.bot && guild) void this.bot("/internal/build_free", { guild, user: u.id }).catch((err) => console.warn("[build]", (err as Error).message));
  }

  /** Kaydet: değişiklikler birikip birkaç saniye sonra tek seferde bota gider. */
  private save(id: number, now = false): void {
    const guild = this.guild();
    if (!this.bot || !guild) return;
    clearTimeout(this.saveTimers.get(id));
    const run = () => {
      this.saveTimers.delete(id);
      const p = this.plots[id];
      if (!p.owner) return;
      void this.bot!("/internal/build_save", { guild, user: p.owner, plot: id, data: encodeBlocks([...p.blocks.values()]) }).catch((err) =>
        console.warn("[build] kaydedilemedi:", (err as Error).message),
      );
    };
    if (now) run();
    else this.saveTimers.set(id, setTimeout(run, SAVE_DELAY_MS));
  }

  /** Oda kapanırken bekleyen kayıtlar hemen yazılır. */
  flush(): void {
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      this.save(id, true);
    }
  }
}
