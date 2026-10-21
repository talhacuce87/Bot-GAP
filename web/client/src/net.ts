// WebSocket istemcisi: zaman damgalı konum gönderimi (SEND_HZ), snapshot alımı, saat senkronu ve yeniden bağlanma.
import { type Act, SEND_HZ } from "../../shared/constants";
import type { Shot } from "../../shared/tank";
import type { BattleState } from "../../shared/protocol";
import type { PlotState } from "../../shared/build";
import {
  type BallState,
  type MatchState,
  type BoardEntry,
  type ChatLine,
  type ClientEvent,
  encodeState,
  type FishCatch,
  type Look,
  type PlayerState,
  type Profile,
  type QuestDone,
  readSnapshot,
  type ServerEvent,
  type StageState,
  STATE_BYTES,
  type TableState,
  type TagState,
  type WardrobeInfo,
  type WatchState,
  type Weather,
} from "../../shared/protocol";
import type { Remotes } from "./avatars/remotes";
import { Pacer, ServerClock } from "./clock";
import { InterpDelay } from "./jitter";
import { RttMonitor } from "./rtt";

export type NetStatus = "connecting" | "online" | "offline" | "denied" | "notfound";

const KEEPALIVE_MS = 1000;
const PING_MS = 2000;

export class Net {
  status: NetStatus = "connecting";
  you = -1;
  onStatus: (s: NetStatus) => void = () => {};
  /** Kendi sürgün durumumuz değişti (girişte ya da canlı). */
  onJail: (jailed: boolean, x: number, z: number, rot: number) => void = () => {};
  onBoard: (entries: BoardEntry[], updated: number) => void = () => {};
  /** `link`: izleme odasının tarayıcı adresi (Activity'de "Tarayıcıda izle"). */
  onWatch: (s: WatchState, link?: string) => void = () => {};
  onNotice: (text: string) => void = () => {};
  onEmote: (sid: number, e: number) => void = () => {};
  onAct: (sid: number, a: Act) => void = () => {};
  onFish: (sid: number, name: string, c: FishCatch) => void = () => {};
  onFishWait: (at: number) => void = () => {};
  onTank: (s: { driver: number; x: number; z: number; h: number; tr: number; el: number }) => void = () => {};
  onTaim: (h: number, tr: number, el: number) => void = () => {};
  onShell: (sid: number, shot: Shot, hits: { sid: number; vx: number; vz: number }[]) => void = () => {};
  onBattle: (s: BattleState) => void = () => {};
  onSpawn: (sid: number, x: number, z: number, h: number) => void = () => {};
  onBaim: (sid: number, h: number, tr: number, el: number) => void = () => {};
  onKill: (killer: number, victim: number) => void = () => {};
  /** Kendi kıyafetimiz (girişte bottan, gardıroptan kaydedince). */
  onMyLook: (look: Look) => void = () => {};
  onWardrobe: (w: WardrobeInfo | { error: string }) => void = () => {};
  onChat: (line: ChatLine) => void = () => {};
  onChatLog: (lines: ChatLine[]) => void = () => {};
  /** Sunucu bir dış bağlantı açtırıyor (ör. az önce açtığın sinema). */
  onOpen: (url: string) => void = () => {};
  /** Odadaki ekran paylaşımı değişti (`sid` 0: yok). */
  onShare: (sid: number, name: string) => void = () => {};
  onWeather: (w: Weather) => void = () => {};
  /** Dünyanın sabitlenmiş saati (!saat), null: gerçek saat. */
  onClock: (hour: number | null) => void = () => {};
  onFireworks: (seed: number, at: number, count: number) => void = () => {};
  /** Kendi evcil hayvanımız/kamuflajımız sunucudan döndü (diğerlerininki Remotes'a yazılır). */
  onCosm: (sid: number, pet: string | null, skin: string | null) => void = () => {};
  onTable: (t: TableState) => void = () => {};
  onBall: (b: BallState) => void = () => {};
  onGoal: (side: 0 | 1, sid: number, name: string, score: [number, number], assist?: string, own?: boolean) => void = () => {};
  /** Futbol maçı başladı/değişti/bitti. */
  onMatch: (m: MatchState | null) => void = () => {};
  /** Kaleciler (x, z, eğilme ×2) ve hakem kararı. */
  onGk: (k: number[]) => void = () => {};
  /** Sunucudaki istemci sürümü (deploy sonrası farklıysa yenilenir). */
  onVersion: (v: string) => void = () => {};
  onFb: (text: string) => void = () => {};
  /** Mahalle: bütün arsalar, tek arsa, tek blok. */
  onPlots: (plots: PlotState[]) => void = () => {};
  onPlot: (plot: PlotState) => void = () => {};
  onBset: (plot: number, i: number, j: number, k: number, b: number, r: number) => void = () => {};
  onScore: (score: [number, number]) => void = () => {};
  onTag: (s: TagState | null) => void = () => {};
  onPairReq: (from: number, name: string, kind: "five" | "hug") => void = () => {};
  onPair: (a: number, b: number, kind: "five" | "hug") => void = () => {};
  onQuest: (completed: QuestDone[]) => void = () => {};
  onProfile: (sid: number, name: string, profile: Profile | null, error?: string) => void = () => {};
  onStage: (s: StageState) => void = () => {};
  onSeason: (season: string, top: { id: string; name: string; kills: number; wins: number }[]) => void = () => {};

  private ws: WebSocket | null = null;
  private sendBuf = new ArrayBuffer(STATE_BYTES);
  private sendView = new DataView(this.sendBuf);
  private pacer = new Pacer(SEND_HZ);
  private lastSent = { x: NaN, z: NaN, rot: NaN, flags: -1 };
  private lastSentAt = 0;
  private pingTimer = 0;
  private retry = 0;
  private clock = new ServerClock();
  private monitor = new RttMonitor();
  /** Uzak oyuncuların çizim gecikmesi: hattın dalgalanmasına göre ayarlanır. */
  readonly interp = new InterpDelay();
  /** close() çağrıldı: yeniden bağlanılmaz (mod değişti). */
  private closed = false;
  /** Okunan snapshot'ın varış anı: sunucu saatiyle (saat belli değilse NaN) ve yerel saatle. */
  private arrival = NaN;
  private arrivedAt = 0;
  private readonly onEntry: (sid: number, x: number, z: number, rot: number, flags: number, time: number) => void;

  constructor(
    private url: string,
    private remotes: Remotes,
  ) {
    // Snapshot okuyucusu için sabit fonksiyon: mesaj başına closure oluşturulmaz.
    this.onEntry = (sid, x, z, rot, flags, time) => {
      if (sid === this.you) return;
      const r = this.remotes.map.get(sid);
      if (r) this.interp.feed(r, this.arrival, this.arrivedAt, time, x, z, rot, flags);
    };
    this.connect();
  }

  /** Ekrandaki ping (ms): son ölçümlerin ortancası. */
  get rtt(): number {
    return this.monitor.rtt;
  }

  /** Yerel saate göre tahmini sunucu zamanı (ölçüm düzeltmeleri sıçramadan, yavaşça uygulanır). */
  serverNow(): number {
    return this.clock.now(performance.timeOrigin + performance.now());
  }

  /** Sunucu saati − yerel saat (ms). */
  get offset(): number {
    return this.clock.offsetAt(performance.timeOrigin + performance.now());
  }

  private setStatus(s: NetStatus): void {
    this.status = s;
    this.onStatus(s);
  }

  private connect(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.clock.reset();
      this.interp.reset();
      this.monitor.reset(performance.now());
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = (e) => this.dropped(e.code);
  }

  private dropped(code: number): void {
    window.clearInterval(this.pingTimer);
    this.ws = null;
    this.you = -1;
    if (this.closed) return;
    // Upgrade reddi tarayıcıda 1006 olarak görünür; hiç açılmadan kapanırsa yine dene ama yavaşla.
    if (code === 4001 || code === 4004) {
      this.setStatus(code === 4001 ? "denied" : "notfound");
      return;
    }
    this.setStatus("offline");
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    window.setTimeout(() => this.connect(), delay);
  }

  /**
   * Bağlantı takıldı (pong'lar kuyrukta birikiyor ya da hiç gelmiyor): yenisini aç.
   * Takılmış soketin kapanış el sıkışması beklenmez; olayları koparılıp hemen yeniden bağlanılır.
   */
  private reconnect(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = null;
    ws.close(4000, "slow");
    this.dropped(4000);
  }

  private ping(): void {
    // Arka plandaki sekmede zamanlayıcılar kısılır; o sırada "pong gelmedi" yanılgısına düşme.
    if (!document.hidden && this.monitor.stalled(performance.now())) return this.reconnect();
    this.ws?.send(JSON.stringify({ t: "ping", c: performance.timeOrigin + performance.now() }));
  }

  private onMessage(data: ArrayBuffer | string): void {
    if (typeof data !== "string") {
      // Saat ofseti ilk pong'la belli olur; öncesinde gecikme ölçülmez
      this.arrival = this.clock.synced ? this.serverNow() : NaN;
      this.arrivedAt = performance.now();
      readSnapshot(new DataView(data), this.onEntry);
      return;
    }
    const ev = JSON.parse(data) as ServerEvent;
    switch (ev.t) {
      case "welcome":
        this.you = ev.you;
        this.remotes.clear();
        for (const p of ev.players) if (p.sid !== ev.you && !p.spectator) this.remotes.add(p);
        const me = ev.players.find((p) => p.sid === ev.you);
        if (me) this.onJail(me.jailed, NaN, NaN, NaN);
        if (me?.look) this.onMyLook(me.look);
        this.lastSent.flags = -1; // hemen tam durum gönder
        this.setStatus("online");
        break;
      case "join":
        if (ev.player.sid !== this.you && !ev.player.spectator) this.remotes.add(ev.player);
        break;
      case "jail":
        if (ev.sid === this.you) this.onJail(ev.jailed, ev.x, ev.z, ev.rot);
        else this.remotes.setJailed(ev.sid, ev.jailed, ev.x, ev.z, ev.rot);
        break;
      case "board":
        this.onBoard(ev.entries, ev.updated);
        break;
      case "watch": {
        const { t: _t, link, ...state } = ev;
        this.onWatch(state, link);
        break;
      }
      case "notice":
        this.onNotice(ev.text);
        break;
      case "emote":
        this.onEmote(ev.sid, ev.e);
        break;
      case "act":
        this.onAct(ev.sid, ev.a);
        break;
      case "tank":
        this.onTank(ev);
        break;
      case "taim":
        this.onTaim(ev.h, ev.tr, ev.el);
        break;
      case "shell":
        this.onShell(ev.sid, ev.shot, ev.hits);
        break;
      case "battle": {
        const { t: _t, ...state } = ev;
        this.onBattle(state);
        break;
      }
      case "spawn":
        this.onSpawn(ev.sid, ev.x, ev.z, ev.h);
        break;
      case "baim":
        this.onBaim(ev.sid, ev.h, ev.tr, ev.el);
        break;
      case "kill":
        this.onKill(ev.killer, ev.victim);
        break;
      case "fish":
        this.onFish(ev.sid, ev.name, ev.catch);
        break;
      case "fishwait":
        this.onFishWait(ev.at);
        break;
      case "look":
        if (ev.sid === this.you) this.onMyLook(ev.look);
        else this.remotes.setLook(ev.sid, ev.look);
        break;
      case "chat":
        this.onChat(ev.line);
        break;
      case "chatlog":
        this.onChatLog(ev.lines);
        break;
      case "open":
        this.onOpen(ev.url);
        break;
      case "share":
        this.onShare(ev.sid, ev.name);
        break;
      case "wardrobe": {
        const { t: _t, ...w } = ev;
        this.onWardrobe(w);
        break;
      }
      case "leave":
        this.remotes.leave(ev.sid);
        break;
      case "weather":
        this.onWeather(ev.weather);
        break;
      case "clock":
        this.onClock(ev.hour);
        break;
      case "fireworks":
        this.onFireworks(ev.seed, ev.at, ev.count);
        break;
      case "cosm":
        this.remotes.setCosmetics(ev.sid, ev.pet, ev.skin);
        this.onCosm(ev.sid, ev.pet, ev.skin);
        break;
      case "table": {
        const { t: _t, ...table } = ev;
        this.onTable(table);
        break;
      }
      case "ball": {
        const { t: _t, ...ball } = ev;
        this.onBall(ball);
        break;
      }
      case "goal":
        this.onGoal(ev.side, ev.sid, ev.name, ev.score, ev.assist, ev.own);
        break;
      case "match":
        this.onMatch(ev.match);
        break;
      case "gk":
        this.onGk(ev.k);
        break;
      case "version":
        this.onVersion(ev.v);
        break;
      case "fb":
        this.onFb(ev.text);
        break;
      case "plots":
        this.onPlots(ev.plots);
        break;
      case "plot":
        this.onPlot(ev.plot);
        break;
      case "bset":
        this.onBset(ev.plot, ev.i, ev.j, ev.k, ev.b, ev.r);
        break;
      case "score":
        this.onScore(ev.score);
        break;
      case "tag":
        this.onTag(ev.state);
        break;
      case "pairreq":
        this.onPairReq(ev.from, ev.name, ev.kind);
        break;
      case "pair":
        this.onPair(ev.a, ev.b, ev.kind);
        break;
      case "quest":
        this.onQuest(ev.completed);
        break;
      case "profile":
        this.onProfile(ev.sid, ev.name, ev.profile, ev.error);
        break;
      case "stage": {
        const { t: _t, ...stage } = ev;
        this.onStage(stage);
        break;
      }
      case "season":
        this.onSeason(ev.season, ev.top);
        break;
      case "pong": {
        const rtt = this.clock.sample(ev.c, ev.s, performance.timeOrigin + performance.now());
        if (this.monitor.sample(rtt, performance.now()) && !document.hidden) this.reconnect();
        break;
      }
    }
  }

  /** Bağlantıyı kalıcı olarak kapatır (dünya ↔ savaş geçişinde eski bağlantı). */
  close(): void {
    this.closed = true;
    window.clearInterval(this.pingTimer);
    this.ws?.close(1000, "mode");
  }

  send(ev: ClientEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  /**
   * Her kare çağrılır; durum değiştiyse SEND_HZ'de, değişmediyse saniyede bir gönderir.
   * Konum alındığı anla (sunucu saati) gider: uzak oyuncular yayın anına göre değil, bu ana göre çizilir.
   */
  update(dt: number, s: PlayerState): void {
    if (!this.pacer.due(dt)) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.you < 0) return;
    const l = this.lastSent;
    const now = performance.now();
    const same = Math.abs(l.x - s.x) < 0.005 && Math.abs(l.z - s.z) < 0.005 && Math.abs(l.rot - s.rot) < 0.005 && l.flags === s.flags;
    if (same && now - this.lastSentAt < KEEPALIVE_MS) return;
    encodeState(this.sendView, s, this.clock.synced ? this.serverNow() : 0);
    ws.send(this.sendBuf);
    l.x = s.x;
    l.z = s.z;
    l.rot = s.rot;
    l.flags = s.flags;
    this.lastSentAt = now;
  }
}
