// Mahalle: arsalar bot veritabanında; ilk girişte yüklenir, blok değişiklikleri herkese anında gider ve
// birkaç saniyede bir toplu kaydedilir. Her üyenin tek arsası olur; yalnızca sahibi blok koyar/siler.
// Arsası olan başka boş arsaya evini bloklarıyla taşıyabilir. Eski (köydeki küçük) mahallelerin arsaları
// ilk yüklemede buradaki boş arsalara taşınır (veritabanında numarası PLOT_DB_BASE'in altında olanlar).
//
// Arsaların durumu Discord sunucusu başına tektir (PlotStore) ve süreç boyunca bellekte kalır: aynı sunucunun
// bütün odaları (dünya, izleme odaları) aynı arsaları görür. Oda başına ayrı kopya olsaydı eski kopyası olan
// oda kaydettiğinde yenisini ezerdi; oda kapanıp açılınca da kaydı yetişmemiş bloklar kaybolurdu.
// Bot bağlı değilse (yerel geliştirme) arsalar yalnızca o odanın belleğinde, misafirler de inşa edebilir.
import { type Block, blockDef, cellKey, decodeBlocks, encodeBlocks, inPlot, moveBlocks, PLOT_DB_BASE, plotOfDb, PLOTS, type PlotState } from "../../../shared/build";
import type { ServerEvent } from "../../../shared/protocol";
import type { BotPost } from "../looks";
import type { Conn, Room } from "../room";

/** İlk değişiklikten en geç bu kadar sonra kaydedilir (sürekli inşa ederken de ertelenmez). */
const SAVE_DELAY_MS = 4000;
/** Blok koyma sıklığı: saniyede en çok bu kadar. */
const EDIT_RATE = 20;

interface PlotData {
  owner: string | null;
  name: string;
  blocks: Map<number, Block>;
}

/** Bir Discord sunucusunun arsaları: yükleme, kayıt ve o sunucunun odalarına yayın. */
class PlotStore {
  plots: PlotData[] = PLOTS.map(() => ({ owner: null, name: "", blocks: new Map() }));
  loaded = false;
  private loading: Promise<void> | null = null;
  private saveTimers = new Map<number, NodeJS.Timeout>();
  /** Arsa başına son kayıt: kayıtlar sırayla gider (eski veri yenisinin üstüne yazılmasın). */
  private saving = new Map<number, Promise<void>>();
  /** Taşınılan arsalar: kayıt başarılı olana kadar sahibinin eski arsası da o kayıtta silinir. */
  moving = new Set<number>();
  readonly rooms = new Set<Room>();

  constructor(
    private guild: string | null,
    private bot: BotPost | null,
  ) {
    if (!bot || !guild) this.loaded = true;
  }

  broadcast(msg: ServerEvent): void {
    for (const room of this.rooms) room.broadcast(msg);
  }

  /** İlk girişte arsalar yüklenir; o zamana kadar boş görünür, yüklenince herkese gider. Hata olursa sonra yeniden denenir. */
  ensureLoaded(): void {
    if (this.loaded || this.loading || !this.bot || !this.guild) return;
    this.loading = this.bot("/internal/builds", { guild: this.guild })
      .then((r) => {
        // Bot hata döndüyse arsalar boş sayılmaz (yoksa herkesin evi yok görünür)
        if (!r.ok || !Array.isArray(r.body.plots)) throw new Error(`bot ${JSON.stringify(r.body)}`);
        type Row = { plot: number; user: string; name?: string; data: string };
        const legacy: Row[] = [];
        for (const row of r.body.plots as Row[]) {
          const id = plotOfDb(Number(row.plot));
          if (id < 0) {
            if (Number(row.plot) < PLOT_DB_BASE) legacy.push(row);
            continue;
          }
          this.fill(id, row.user, row.name, decodeBlocks(id, String(row.data ?? "")));
        }
        this.migrate(legacy);
        this.loaded = true;
        this.broadcast({ t: "plots", plots: this.states() });
      })
      .catch((err) => console.warn("[build] yüklenemedi:", (err as Error).message))
      .finally(() => (this.loading = null));
  }

  private fill(id: number, user: string, name: string | undefined, blocks: Block[]): void {
    const p = this.plots[id];
    p.owner = String(user);
    p.name = typeof name === "string" ? name : "Komşu";
    p.blocks = new Map(blocks.map((b) => [cellKey(b.i, b.j, b.k), b]));
  }

  /**
   * Eski mahallelerin arsaları: her biri ilk boş arsanın ortasına bloklarıyla taşınır ve kaydedilir (kayıt
   * eski satırı aynı işlemde siler). Eski arsalar bu arsalardan küçük olduğundan bloklar hep sığar.
   */
  private migrate(rows: { plot: number; user: string; name?: string; data: string }[]): void {
    for (const row of rows.sort((a, b) => a.plot - b.plot)) {
      if (this.plotOf(String(row.user)) >= 0) continue;
      const id = this.plots.findIndex((p) => !p.owner);
      if (id < 0) {
        console.warn("[build] eski arsa taşınamadı (boş arsa yok):", row.plot, row.user);
        continue;
      }
      this.fill(id, row.user, row.name, moveBlocks(decodeBlocks(id, String(row.data ?? "")), id));
      this.moving.add(id);
      console.log(`[build] eski arsa ${row.plot} (${row.user}) → ${PLOTS[id].db}: ${this.plots[id].blocks.size} blok`);
      void this.save(id, true);
    }
  }

  state(id: number): PlotState {
    const p = this.plots[id];
    return { id, owner: p.owner, name: p.name, data: encodeBlocks([...p.blocks.values()]) };
  }

  states(): PlotState[] {
    return this.plots.map((_, id) => this.state(id));
  }

  plotOf(userId: string): number {
    return this.plots.findIndex((p) => p.owner === userId);
  }

  /** Bekleyen kaydı iptal et (arsa boşaldı ya da taşınıldı). */
  cancel(id: number): void {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    this.moving.delete(id);
  }

  /** Arsayı bota bildirerek boşalt. */
  free(user: string): void {
    if (this.bot && this.guild) void this.bot("/internal/build_free", { guild: this.guild, user }).catch((err) => console.warn("[build]", (err as Error).message));
  }

  /**
   * Kaydet: değişiklikler birikip birkaç saniye sonra tek seferde bota gider. Zamanlayıcı yeni blokla
   * ertelenmez; yoksa durmadan inşa eden birinin arsası hiç kaydedilmez.
   */
  save(id: number, now = false): Promise<void> {
    const bot = this.bot, guild = this.guild;
    if (!bot || !guild) return Promise.resolve();
    if (!now) {
      if (!this.saveTimers.has(id)) this.saveTimers.set(id, setTimeout(() => void this.save(id, true), SAVE_DELAY_MS));
      return Promise.resolve();
    }
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    const prev = this.saving.get(id) ?? Promise.resolve();
    const next = prev.then(() => {
      const p = this.plots[id];
      if (!p.owner) return;
      const owner = p.owner;
      const move = this.moving.has(id);
      return bot("/internal/build_save", { guild, user: owner, plot: PLOTS[id].db, data: encodeBlocks([...p.blocks.values()]), move })
        .then((r) => {
          if (r.ok && r.body.ok !== false) {
            if (move && this.plots[id].owner === owner) this.moving.delete(id);
            return;
          }
          console.warn("[build] kaydedilemedi:", id, owner, JSON.stringify(r.body));
          this.tell(owner, "⚠️ Arsan kaydedilemedi, yöneticiye haber ver.");
        })
        .catch((err) => console.warn("[build] kaydedilemedi:", (err as Error).message));
    });
    this.saving.set(id, next);
    void next.finally(() => {
      if (this.saving.get(id) === next) this.saving.delete(id);
    });
    return next;
  }

  /** Üye hangi odadaysa ona bildirim. */
  private tell(user: string, text: string): void {
    for (const room of this.rooms) for (const p of room.players.values()) if (p.user.id === user) room.sendTo(p.conn, { t: "notice", text });
  }

  /** Bekleyen ve süren bütün kayıtlar. */
  flush(): Promise<void> {
    const ids = new Set([...this.saveTimers.keys(), ...this.saving.keys()]);
    return Promise.all([...ids].map((id) => (this.saveTimers.has(id) ? this.save(id, true) : this.saving.get(id)))).then(() => {});
  }
}

/** Sunucu başına arsalar (bot bağlıyken). */
const stores = new Map<string, PlotStore>();

/** Sunucu kapanırken bekleyen kayıtlar hemen yazılır. */
export function flushBuilds(): Promise<void> {
  return Promise.all([...stores.values()].map((s) => s.flush())).then(() => {});
}

/** Odanın inşa arayüzü: odadaki oyuncuların isteklerini o sunucunun arsalarına uygular. */
export class Builds {
  private bound: PlotStore | null = null;
  private edits = new Map<number, { at: number; n: number }>();

  constructor(
    private room: Room,
    private bot: BotPost | null,
  ) {
    // Bot yoksa odanın kendi (yalnızca bellekteki) arsaları
    if (!bot) this.bind(new PlotStore(null, null));
  }

  private bind(store: PlotStore): PlotStore {
    this.bound = store;
    store.rooms.add(this.room);
    return store;
  }

  /** Odanın sunucusunun arsaları (ilk Discord'lu oyuncu gelince bağlanır ve yüklenir). */
  private store(): PlotStore | null {
    if (!this.bound) {
      let guild: string | null = null;
      for (const p of this.room.players.values()) if (p.guild) guild = guild ?? p.guild;
      if (!guild) return null;
      let s = stores.get(guild);
      if (!s) stores.set(guild, (s = new PlotStore(guild, this.bot)));
      this.bind(s);
    }
    this.bound!.ensureLoaded();
    return this.bound;
  }

  sendTo(conn: Conn): void {
    const s = this.store();
    const plots = s ? s.states() : PLOTS.map((_, id) => ({ id, owner: null, name: "", data: "" }));
    this.room.sendTo(conn, { t: "plots", plots });
  }

  /** Oda kapanınca: arsalar sunucunun deposunda kalır, yalnızca yayın listesinden çıkar. */
  dispose(): void {
    this.bound?.rooms.delete(this.room);
  }

  private notice(sid: number, text: string): void {
    const conn = this.room.players.get(sid)?.conn;
    if (conn) this.room.sendTo(conn, { t: "notice", text });
  }

  /** İnşa edebilir mi (Discord'dan gelen üye; bot yoksa herkes). */
  private builder(sid: number): { id: string; name: string; store: PlotStore } | null {
    const p = this.room.players.get(sid);
    if (!p || p.info.spectator) return null;
    if (this.bot && (p.user.guest || !p.guild)) return null;
    const store = this.store();
    return store && { id: p.user.id, name: p.user.name, store };
  }

  plotOf(userId: string): number {
    return this.bound?.plotOf(userId) ?? -1;
  }

  /**
   * Boş arsa sahiplen: `want` boşsa o arsa (oyuncunun durduğu), değilse ilk boş arsa. Arsası olan `want`
   * verirse evi bloklarıyla oraya taşınır.
   */
  claim(sid: number, want?: number): void {
    const u = this.builder(sid);
    if (!u) return this.notice(sid, "🔨 İnşa için dünyaya Discord'dan gir.");
    const s = u.store;
    if (!s.loaded) return this.notice(sid, "🔨 Mahalle yükleniyor, birazdan tekrar dene.");
    const old = s.plotOf(u.id);
    const free = (id: number) => !!s.plots[id] && !s.plots[id].owner;
    let id: number;
    if (want !== undefined && Number.isInteger(want) && s.plots[want]) {
      if (want === old) return this.notice(sid, "🏠 Zaten bu arsa senin.");
      if (!free(want)) return this.notice(sid, "🏠 Bu arsanın sahibi var.");
      id = want;
    } else if (old >= 0) {
      return this.notice(sid, "🏠 Zaten bir arsan var. Taşınmak için boş bir arsanın üstüne git.");
    } else id = PLOTS.findIndex((pl) => free(pl.id));
    if (id < 0) return this.notice(sid, "🏘️ Mahallede boş arsa kalmadı.");
    const moved = old >= 0 ? moveBlocks(s.plots[old].blocks.values(), id) : [];
    if (old >= 0 && moved.length < s.plots[old].blocks.size) return this.notice(sid, "🧱 Evin bu arsaya sığmıyor.");
    const p = s.plots[id];
    p.owner = u.id;
    p.name = u.name;
    p.blocks = new Map(moved.map((b) => [cellKey(b.i, b.j, b.k), b]));
    s.moving.delete(id);
    if (old >= 0) {
      const from = s.plots[old];
      from.owner = null;
      from.name = "";
      from.blocks.clear();
      s.cancel(old);
      s.broadcast({ t: "plot", plot: s.state(old) });
      this.notice(sid, "🚚 Evin yeni arsana taşındı.");
      s.moving.add(id);
    }
    s.broadcast({ t: "plot", plot: s.state(id) });
    void s.save(id, true);
  }

  /** Kendi arsasına blok koy (b > 0) ya da sil (b 0). */
  set(sid: number, i: number, j: number, k: number, b: number, r: number, now = Date.now()): void {
    const u = this.builder(sid);
    if (!u || !u.store.loaded) return;
    const s = u.store;
    const id = s.plotOf(u.id);
    if (id < 0 || !inPlot(id, i, j, k) || !Number.isInteger(b) || !Number.isInteger(r) || r < 0 || r > 3) return;
    if (b !== 0 && !blockDef(b)) return;
    const p = s.plots[id];
    const key = cellKey(i, j, k);
    // İstemci bloğu hemen çizer: reddedilirse hücrenin gerçek hali geri gider (yoksa görünüp kaydedilmeyen blok kalır)
    const undo = () => {
      const cur = p.blocks.get(key);
      const conn = this.room.players.get(sid)?.conn;
      if (conn) this.room.sendTo(conn, { t: "bset", plot: id, i, j, k, b: cur?.b ?? 0, r: cur?.r ?? 0 });
    };
    const e = this.edits.get(sid);
    if (e && now - e.at < 1000) {
      if (++e.n > EDIT_RATE) return undo();
    } else this.edits.set(sid, { at: now, n: 1 });
    if (b === 0) {
      if (!p.blocks.delete(key)) return;
    } else {
      if (!p.blocks.has(key) && p.blocks.size >= PLOTS[id].max) {
        undo();
        return this.notice(sid, `🧱 Arsada en çok ${PLOTS[id].max} blok olabilir.`);
      }
      p.blocks.set(key, { i, j, k, b, r });
    }
    s.broadcast({ t: "bset", plot: id, i, j, k, b, r });
    void s.save(id);
  }

  /** Arsayı boşalt (bütün blokları siler, arsa başkasına açılır). */
  free(sid: number): void {
    const u = this.builder(sid);
    if (!u) return;
    const s = u.store;
    const id = s.plotOf(u.id);
    if (id < 0) return this.notice(sid, "🏠 Arsan yok.");
    const p = s.plots[id];
    p.owner = null;
    p.name = "";
    p.blocks.clear();
    s.cancel(id);
    s.broadcast({ t: "plot", plot: s.state(id) });
    s.free(u.id);
  }

  /** Bu odanın bekleyen kayıtları (bot yokken bir şey yapmaz). */
  flush(): Promise<void> {
    return this.bound?.flush() ?? Promise.resolve();
  }
}
