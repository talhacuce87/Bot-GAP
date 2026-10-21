// WebSocket istemcisi: zaman damgalı konum gönderimi (SEND_HZ), snapshot alımı, saat senkronu ve yeniden bağlanma.
// Konum ve snapshot'lar sunucu açtıysa hızlı yoldan (WebRTC/UDP, rtc.ts), olaylar her zaman WebSocket'ten.
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
  MSG_PONG,
  PING_BYTES,
  type Look,
  type PlayerState,
  type Profile,
  type QuestDone,
  readPong,
  readSnapshot,
  type ServerEvent,
  type StageState,
  STATE_BYTES,
  type TableState,
  type TagState,
  type WardrobeInfo,
  type WatchState,
  type Weather,
  writePing,
} from "../../shared/protocol";
import type { Remotes } from "./avatars/remotes";
import { Pacer, ServerClock } from "./clock";
import { InterpDelay } from "./jitter";
import { NetStats } from "./netstats";
import { FastLink } from "./rtc";
import { RttMonitor } from "./rtt";

export type NetStatus = "connecting" | "online" | "offline" | "denied" | "notfound";

const KEEPALIVE_MS = 1000;
const PING_MS = 2000;
/** Duran oyuncunun son durumu bu kadar kez daha gider: hızlı yolda biri kaybolsa da son yeri ulaşır. */
const REPEAT = 3;
/** Bağlantı özeti (sunucu loguna) bu aralıkla gider. */
const NETSTAT_MS = 30_000;
/** Hızlı yolun ping aralığı; ağ paneli açıkken sık (grafik akıcı olsun). */
const UDP_PING_MS = 2000;
const UDP_PING_LIVE_MS = 250;

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
  /** `at`: doğmanın sunucu saati (uzak oyuncunun daha eski konum örnekleri yok sayılır). */
  onSpawn: (sid: number, x: number, z: number, h: number, at: number) => void = () => {};
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
  onGoal: (side: 0 | 1, sid: number, name: string, score: [number, number], assist?: string, own?: boolean, f?: 1) => void = () => {};
  /** Futbol maçı başladı/değişti/bitti. */
  onMatch: (m: MatchState | null) => void = () => {};
  /** Kaleciler (x, z, eğilme ×2) ve hakem kararı. */
  onGk: (k: number[], f?: 1) => void = () => {};
  /** Sunucu bir oyuncuyu taşıdı (stadyuma giriş/çıkış). */
  onTeleport: (x: number, z: number, rot: number) => void = () => {};
  /** Sunucudaki istemci sürümü (deploy sonrası farklıysa yenilenir). */
  onVersion: (v: string) => void = () => {};
  onFb: (text: string) => void = () => {};
  /** Mahalle: bütün arsalar, tek arsa, tek blok. */
  onPlots: (plots: PlotState[]) => void = () => {};
  onPlot: (plot: PlotState) => void = () => {};
  onBset: (plot: number, i: number, j: number, k: number, b: number, r: number) => void = () => {};
  onScore: (score: [number, number], f?: 1) => void = () => {};
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
  private repeat = 0;
  private lastStat = performance.now();
  private statFrames = 0;
  private statStarved = 0;
  private fast: FastLink | null = null;
  private pingBuf = new ArrayBuffer(PING_BYTES);
  private pingView = new DataView(this.pingBuf);
  private pingSeq = 0;
  private lastUdpPing = 0;
  /** Ağ panelinin verisi. */
  readonly stats = new NetStats();
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
    this.interp.onNeed = (need, now) => this.stats.need(need, now);
    this.connect();
  }

  /** Ekrandaki ping (ms): son ölçümlerin ortancası; hızlı yol açıksa onun (hareket o yoldan gidiyor). */
  get rtt(): number {
    const udp = this.udp ? this.stats.udp.median(5) : NaN;
    return Number.isFinite(udp) ? udp : this.monitor.rtt;
  }

  /** WebSocket'in pingi (olaylar, sohbet bu yoldan). */
  get wsRtt(): number {
    return this.monitor.rtt;
  }

  /** Saat ölçümünün henüz uygulanmamış düzeltmesi (ms). */
  get clockPending(): number {
    return this.clock.pending;
  }

  /** Yerel saate göre tahmini sunucu zamanı (ölçüm düzeltmeleri sıçramadan, yavaşça uygulanır). */
  serverNow(): number {
    return this.clock.now(performance.timeOrigin + performance.now());
  }

  /** Konum ve snapshot'lar hızlı yoldan (UDP) gidiyor. */
  get udp(): boolean {
    return this.fast?.open ?? false;
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
    ws.onmessage = (e) => this.onMessage(e.data, false);
    ws.onclose = (e) => this.dropped(e.code);
  }

  private dropped(code: number): void {
    window.clearInterval(this.pingTimer);
    this.fast?.close();
    this.fast = null;
    this.stats.dropPending();
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
    this.send({ t: "ping", c: performance.timeOrigin + performance.now() });
  }

  /** Hızlı yolun kendi ping'i: gidiş-dönüş, dalgalanma, kayıp (ve daha iyi saat ölçümü). */
  private udpPing(now: number): void {
    this.lastUdpPing = now;
    this.pingSeq = (this.pingSeq + 1) & 0xffff;
    writePing(this.pingView, this.pingSeq, performance.timeOrigin + now);
    if (!this.fast?.send(this.pingBuf)) return;
    this.stats.pingSent(this.pingSeq, now);
    this.stats.sent(PING_BYTES, true);
  }

  private onMessage(data: ArrayBuffer | string, udp: boolean): void {
    if (typeof data !== "string") {
      this.stats.received(data.byteLength, udp);
      const view = new DataView(data);
      if (view.byteLength && view.getUint8(0) === MSG_PONG) {
        const p = readPong(view);
        if (!p) return;
        const rtt = this.clock.sample(p.c, p.s, performance.timeOrigin + performance.now());
        this.stats.pong(p.seq, rtt, performance.now());
        return;
      }
      this.stats.snapshot();
      // Saat ofseti ilk pong'la belli olur; öncesinde gecikme ölçülmez
      this.arrival = this.clock.synced ? this.serverNow() : NaN;
      this.arrivedAt = performance.now();
      readSnapshot(view, this.onEntry);
      return;
    }
    this.stats.received(data.length, false);
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
        else this.remotes.setJailed(ev.sid, ev.jailed, ev.x, ev.z, ev.rot, ev.at);
        break;
      case "tp":
        if (ev.sid === this.you) this.onTeleport(ev.x, ev.z, ev.rot);
        else this.remotes.teleport(ev.sid, ev.x, ev.z, ev.rot, ev.at);
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
        this.onSpawn(ev.sid, ev.x, ev.z, ev.h, ev.at ?? 0);
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
        this.onGoal(ev.side, ev.sid, ev.name, ev.score, ev.assist, ev.own, ev.f);
        break;
      case "match":
        this.onMatch(ev.match);
        break;
      case "gk":
        this.onGk(ev.k, ev.f);
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
        this.onScore(ev.score, ev.f);
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
      case "rtcon":
        if (typeof RTCPeerConnection !== "undefined" && !this.fast) {
          const link = new FastLink(
            (e) => this.send(e),
            (d) => this.onMessage(d, true),
            () => {
              if (this.fast === link) this.fast = null;
            },
          );
          this.fast = link;
        }
        break;
      case "rtc":
        void this.fast?.answer(ev.sdp);
        break;
      case "rtcice":
        this.fast?.candidate(ev.c, ev.mid);
        break;
      case "pong": {
        const rtt = this.clock.sample(ev.c, ev.s, performance.timeOrigin + performance.now());
        this.stats.wsPong(rtt, performance.now());
        if (this.monitor.sample(rtt, performance.now()) && !document.hidden) this.reconnect();
        break;
      }
    }
  }

  /** Bağlantıyı kalıcı olarak kapatır (dünya ↔ savaş geçişinde eski bağlantı). */
  close(): void {
    this.closed = true;
    window.clearInterval(this.pingTimer);
    this.fast?.close();
    this.ws?.close(1000, "mode");
  }

  send(ev: ClientEvent): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify(ev);
    this.stats.sent(msg.length, false);
    this.ws.send(msg);
  }

  /**
   * Her kare çağrılır; durum değiştiyse SEND_HZ'de, değişmediyse saniyede bir gönderir.
   * Konum alındığı anla (sunucu saati) gider: uzak oyuncular yayın anına göre değil, bu ana göre çizilir.
   */
  update(dt: number, s: PlayerState): void {
    const t = performance.now();
    this.stats.tick(t, this.interp.delay, this.remotes.frames, this.remotes.starvedFrames);
    if (this.fast?.open && t - this.lastUdpPing > (this.stats.live ? UDP_PING_LIVE_MS : UDP_PING_MS)) this.udpPing(t);
    if (!this.pacer.due(dt)) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.you < 0) return;
    const l = this.lastSent;
    const now = performance.now();
    if (now - this.lastStat > NETSTAT_MS) {
      this.lastStat = now;
      const frames = this.remotes.frames - this.statFrames;
      const starve = frames > 0 ? (this.remotes.starvedFrames - this.statStarved) / frames : 0;
      this.statFrames = this.remotes.frames;
      this.statStarved = this.remotes.starvedFrames;
      const loss = this.stats.loss;
      this.send({
        t: "netstat",
        rtt: Math.round(this.rtt),
        ws: Math.round(this.monitor.rtt),
        loss: Number.isFinite(loss) ? Math.round(loss * 1000) / 1000 : 0,
        delay: Math.round(this.interp.delay),
        starve: Math.round(starve * 1000) / 1000,
        udp: this.udp,
      });
    }
    const same = Math.abs(l.x - s.x) < 0.005 && Math.abs(l.z - s.z) < 0.005 && Math.abs(l.rot - s.rot) < 0.005 && l.flags === s.flags;
    if (same && this.repeat <= 0 && now - this.lastSentAt < KEEPALIVE_MS) return;
    this.repeat = same ? this.repeat - 1 : REPEAT;
    encodeState(this.sendView, s, this.clock.synced ? this.serverNow() : 0);
    const udp = this.fast?.send(this.sendBuf) ?? false;
    if (!udp) ws.send(this.sendBuf);
    this.stats.sent(STATE_BYTES, udp);
    l.x = s.x;
    l.z = s.z;
    l.rot = s.rot;
    l.flags = s.flags;
    this.lastSentAt = now;
  }
}
