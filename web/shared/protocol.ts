// Tel protokolü. Sık mesajlar (konum, snapshot) binary; seyrek olaylar JSON metin.
import { type Act, POS_SCALE } from "./constants";
import type { PlotState } from "./build";
import type { Source } from "./media";
import type { Phase } from "./arena";
import type { Shot } from "./tank";
import type { BilekMove, BilekState } from "./games/bilek";
import type { ChessMove, ChessState } from "./games/chess";
import type { OkeyMove, OkeyState } from "./games/okey";
import type { TavlaMove, TavlaState } from "./games/tavla";
import type { TableKind } from "./zones";

export const MSG_STATE = 1; // istemci → sunucu: kendi konumu
export const MSG_SNAPSHOT = 2; // sunucu → istemci: odadaki herkesin konumu
export const MSG_PING = 3; // istemci → sunucu, hızlı yol: yolun kendi gidiş-dönüşü ve kaybı
export const MSG_PONG = 4; // sunucu → istemci, hızlı yol

const TAU = Math.PI * 2;

export interface PlayerState {
  x: number;
  z: number;
  rot: number;
  flags: number;
}

/** Chibi karakter kıyafeti; parça kimlikleri chibi.json'dan, doğrulama botta (outfit.py). */
export const LOOK_SLOTS = ["hair", "tops", "bottoms", "shoes", "hats", "glasses", "facial"] as const;
export type LookSlot = (typeof LOOK_SLOTS)[number];
export const LOOK_COLORS = ["skin", "hair", "eye"] as const;
export type LookColor = (typeof LOOK_COLORS)[number];
export type Look = Partial<Record<LookSlot, string | null>> & { colors?: Partial<Record<LookColor, string>> };

export interface PlayerInfo {
  sid: number;
  id: string;
  name: string;
  avatar: string | null;
  spectator: boolean;
  /** Sürgünde: zindan hücresinde tutulur. */
  jailed: boolean;
  /** Bottan gelen kıyafet; yoksa (misafir, henüz yüklenmedi) varsayılan karakter. */
  look?: Look | null;
  /** Peşinden gelen evcil hayvan (PETS) ve tank kamuflajı (SKINS); istemcide saklanır. */
  pet?: string | null;
  skin?: string | null;
}

export const PETS = [
  { id: "duck", name: "Ördek yavrusu", emoji: "🐥" },
  { id: "cat", name: "Kedi", emoji: "🐱" },
  { id: "dog", name: "Köpek", emoji: "🐶" },
  { id: "bunny", name: "Tavşan", emoji: "🐰" },
] as const;

export const SKINS = [
  { id: "std", name: "Standart" },
  { id: "desert", name: "Çöl" },
  { id: "forest", name: "Orman" },
  { id: "winter", name: "Kış" },
  { id: "urban", name: "Şehir" },
  { id: "pink", name: "Pembe" },
  { id: "gold", name: "Altın" },
] as const;

/** İstanbul'un anlık havası (Open-Meteo): `intensity` yağış şiddeti, `cloud` bulutluluk (0–1). */
export type WeatherKind = "clear" | "cloudy" | "fog" | "rain" | "storm" | "snow";
export interface Weather {
  kind: WeatherKind;
  intensity: number;
  cloud: number;
  temp: number | null;
}

/** Okey'de herkes yalnızca kendi elini görür. */
export type OkeyView = Omit<OkeyState, "hands" | "pile"> & { hand: number[]; counts: number[]; pileCount: number };

export type TableGame =
  | { kind: "tavla"; state: TavlaState }
  | { kind: "satranc"; state: ChessState }
  | { kind: "okey"; state: OkeyView }
  | { kind: "bilek"; state: BilekState };

export type TableMove = TavlaMove | ChessMove | OkeyMove | BilekMove;

/** Kahvehane masası: oturanlar (sid, 0 boş), adları ve oyun (yoksa bekliyor). */
export interface TableState {
  id: number;
  kind: TableKind;
  seats: number[];
  names: string[];
  game: TableGame | null;
  /** Oyundakilerin sırası (sid): tavla/satrançta 0 beyaz; okey'de oyuncu sırası. */
  order: number[];
  /** Son olay ("Ali kazandı", "Sıra Ayşe'de"…). */
  note: string;
}

/** Futbol topu: `at` sunucu zamanındaki konum ve hız (istemci ileri tahmin eder). */
export interface BallState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  at: number;
  /** Falso (rad/sn): top uçarken yönü bu hızla döner (+ sağa). */
  spin?: number;
  /** Bu yayına yol açan olay (ses/efekt için) ve yapan. */
  ev?: BallEvent;
  by?: number;
  /** Top kimin ayağında: oyuncu sid'i; -1 batı, -2 doğu kalecisi; yoksa serbest. */
  owner?: number;
  /** Hangi saha: 1 stadyum, yoksa salon. */
  f?: 1;
  /** Çalımda topun döndüğü yan (1 sağ, -1 sol). */
  side?: -1 | 1;
}

/**
 * "skill": çalım (roulette: top yanından yarım daire çizer), "rainbow": top arkadan başın üstünden öne,
 * "slide": kayarak müdahale başladı (yapan yere yatar), "power": power şut.
 */
export type BallEvent = KickKind | "head" | "post" | "bar" | "save" | "tackle" | "skill" | "rainbow" | "slide";
export type KickKind = "shot" | "pass" | "lob" | "power";

/** Futbol maçı (stadyumda): süre, takımlar (sid listeleri; 0 kırmızı batıyı savunur, 1 mavi doğuyu). */
export interface MatchState {
  endsAt: number;
  teams: [number[], number[]];
}

export type TagMode = "ebelemece" | "saklambac";
/** Ebelemece / saklambaç turu. `it` ebe; `found` saklambaçta bulunanlar; `scores` ebelikte geçen sn. */
export interface TagState {
  mode: TagMode;
  phase: "join" | "hide" | "play" | "end";
  it: number;
  players: number[];
  found: number[];
  endsAt: number;
  scores: Record<number, number>;
  /** Bitince sonuç cümlesi. */
  result: string;
}

/** Oyuncak pist yarışçısı: `lap` 1'den başlar (0: çizgiye gelmedi); bitirdiyse `place` ve `time` (ms). */
export interface RacePlayer {
  sid: number;
  lap: number;
  place: number;
  time: number;
}

/** Oyuncak pist: lobi (ilk giren başlatır), geri sayım, yarış, sonuç. */
export interface RaceState {
  phase: "lobby" | "countdown" | "race" | "end";
  host: number;
  track: number;
  players: RacePlayer[];
  /** Yeşil ışık (sunucu saati, ms). */
  startAt: number;
  /** Yarış/sonuç ekranının bittiği an. */
  endsAt: number;
}

/** Sinema kuyruğu, DJ ve sahne. `show` ışık şovu (0 kapalı). */
export interface StageState {
  dj: number;
  show: number;
  singer: number;
  queue: { title: string; by: string }[];
}

export interface QuestDone {
  key: string;
  title: string;
  xp: number;
}

/** Oyuncu kartı (bottan). */
export interface Profile {
  level: number;
  xp: number;
  floor: number;
  ceiling: number;
  rank: number;
  streak: number;
  fish: Record<string, number>;
  stats: Record<string, number>;
  season: { key: string; tank_kills?: number; tank_wins?: number; goals?: number };
  quests: { key: string; title: string; target: number; progress: number; done: boolean; xp: number }[];
}

export type BattleMode = "tdm" | "ffa" | "ctf";

/** Bayrak kapmaca: takımın bayrağı nerede (`carrier` taşıyan sid, 0 yok; `home` üssünde). */
export interface FlagState {
  x: number;
  z: number;
  carrier: number;
  home: boolean;
}

/**
 * Sohbet satırı. say: oyuncu mesajı (odaya) • system: oda duyurusu (ör. sinema açıldı)
 * • reply: komut cevabı (yalnızca sorana). `link` varsa satırda bir düğme gösterilir.
 */
export interface ChatLine {
  kind: "say" | "system" | "reply";
  sid: number;
  name: string;
  text: string;
  at: number;
  link?: { url: string; label: string };
}

/** Gardırop açılınca: kayıtlı kıyafet, seviye ve seviyeyle açılan parçalar. */
export interface WardrobeInfo {
  outfit: Look;
  level: number;
  locked: Record<string, number>;
}

/** Şöhret Kürsüsü satırı (XP sıralaması, bot gönderir). */
export interface BoardEntry {
  id: string;
  name: string;
  avatar: string | null;
  level: number;
  xp: number;
}

/** Watch party'nin otoriter durumu: `position` saniyesi `updatedAt` (sunucu ms) anındadır. */
export interface WatchState {
  source: Source | null;
  title: string;
  playing: boolean;
  position: number;
  updatedAt: number;
  /** Son değişikliği yapanın adı ve yaptığı ("load" | "play" | "pause" | "seek"). */
  by: string;
  op: string;
}

/** Gölden çıkan balık (bot zarı atar): boost `hours` saat 2x XP, `luck` efsanevi şansına eklenen yüzde. */
export interface FishCatch {
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  label: string;
  fish: string;
  hours: number;
  streak: number;
  luck: number;
}

/** Tank savaşında bir oyuncu: `team` -1 ise henüz takım seçmedi. */
export interface Fighter {
  sid: number;
  team: -1 | 0 | 1;
  hp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  /** Tank kamuflajı (SKINS). */
  skin?: string;
}

/** Tank savaşının durumu (değişince herkese): `endsAt` evrenin bittiği sunucu zamanı (ms). */
export interface BattleState {
  phase: Phase;
  endsAt: number;
  score: [number, number];
  fighters: Fighter[];
  mode?: BattleMode;
  /** Bayrak kapmacada iki takımın bayrağı. */
  flags?: [FlagState, FlagState];
}

/** Sunucunun gönderdiği JSON olaylar. */
export type ServerEvent =
  | { t: "welcome"; you: number; room: string; players: PlayerInfo[] }
  /** Sunucunun sunduğu istemci sürümü (ana betiğin adı): farklıysa istemci kendini yeniler. */
  | { t: "version"; v: string }
  | { t: "join"; player: PlayerInfo }
  | { t: "leave"; sid: number }
  /** `at`: ışınlanmanın sunucu saati; bundan eski konum örnekleri (geç gelen UDP paketi) yok sayılır. */
  | { t: "jail"; sid: number; jailed: boolean; x: number; z: number; rot: number; at?: number }
  | { t: "board"; updated: number; entries: BoardEntry[] }
  /** `link`: izleme odasının tarayıcı adresi (Activity'de "Tarayıcıda izle" için). */
  | ({ t: "watch"; link?: string } & WatchState)
  | { t: "notice"; text: string }
  | { t: "emote"; sid: number; e: number }
  | { t: "act"; sid: number; a: Act }
  | { t: "fish"; sid: number; name: string; catch: FishCatch }
  /** Yalnızca soran oyuncuya: sonraki balık hakkının açılacağı an (epoch ms); hak varsa 0. */
  | { t: "fishwait"; at: number }
  | { t: "look"; sid: number; look: Look }
  | { t: "chat"; line: ChatLine }
  | { t: "chatlog"; lines: ChatLine[] }
  /** Yalnızca isteyene: dış bağlantıyı aç (Activity'de Discord onay penceresiyle). */
  | { t: "open"; url: string }
  | ({ t: "wardrobe" } & (WardrobeInfo | { error: string }))
  /** Odadaki ekran paylaşımı: `sid` 0 ise paylaşım yok. */
  | { t: "share"; sid: number; name: string }
  | { t: "pong"; c: number; s: number }
  /** Hızlı yol (WebRTC veri kanalı) açık: istemci teklif gönderebilir. */
  | { t: "rtcon" }
  /** Hızlı yol sinyalleşmesi: sunucunun cevabı ve adayları. */
  | { t: "rtc"; sdp: string }
  | { t: "rtcice"; c: string; mid: string }
  /** Tankın durumu (biri binince/inince ve girişte): `driver` 0 ise park halinde. */
  | { t: "tank"; driver: number; x: number; z: number; h: number; tr: number; el: number }
  /** Sürücünün gövde ve kule açısı (konumu sürücünün kendi snapshot'ından gelir). */
  | { t: "taim"; h: number; tr: number; el: number }
  /** Atış: herkes aynı yayı çizer; `hits` savrulanlar (yalnızca kendi sid'i olan uygular). */
  | { t: "shell"; sid: number; shot: Shot; hits: { sid: number; vx: number; vz: number }[] }
  | ({ t: "battle" } & BattleState)
  /** Savaşta (yeniden) doğma: sunucu konumu belirler, o oyuncu tankını oraya koyar. */
  | { t: "spawn"; sid: number; x: number; z: number; h: number; at?: number }
  /** Savaşta bir tankın gövde/kule/namlu açısı (konumu snapshot'tan). */
  | { t: "baim"; sid: number; h: number; tr: number; el: number }
  | { t: "kill"; killer: number; victim: number }
  | { t: "weather"; weather: Weather }
  /** Dünyanın sabitlenmiş saati (Türkiye saati, ondalıklı), null: gerçek saat. */
  | { t: "clock"; hour: number | null }
  /** Havai fişek gösterisi: `seed` herkes aynı patlamaları görsün, `at` başlangıç (sunucu ms). */
  | { t: "fireworks"; seed: number; at: number; count: number }
  | { t: "cosm"; sid: number; pet: string | null; skin: string | null }
  | ({ t: "table" } & TableState)
  | ({ t: "ball" } & BallState)
  | { t: "goal"; side: 0 | 1; sid: number; name: string; score: [number, number]; assist?: string; own?: boolean; f?: 1 }
  | { t: "match"; match: MatchState | null }
  /** Kaleciler: [batı x, z, eğilme, doğu x, z, eğilme] (eğilme: plonjon, -1…1). */
  | { t: "gk"; k: number[]; f?: 1 }
  /** Futbol hakem kararı (taç, korner, aut…): düdük ve kısa yazı. */
  | { t: "fb"; text: string }
  /** Mahalle: bütün arsalar (girişte), tek arsa (sahiplenme/boşaltma), tek blok değişimi (b 0: silindi). */
  | { t: "plots"; plots: PlotState[] }
  | { t: "plot"; plot: PlotState }
  | { t: "bset"; plot: number; i: number; j: number; k: number; b: number; r: number }
  | { t: "score"; score: [number, number]; f?: 1 }
  /** Sunucu oyuncuyu bir yere taşıdı (stadyuma giriş/çıkış): ara geçiş olmadan oraya konur. */
  | { t: "tp"; sid: number; x: number; z: number; rot: number; at: number }
  | { t: "tag"; state: TagState | null }
  | { t: "race"; state: RaceState | null }
  /** Yarıştaki arabalar: [sid, x×10, z×10, açı×100, bayrak] tekrarlı (pist birimi). */
  | { t: "rcars"; c: number[] }
  /** İkili etkileşim isteği (yalnızca hedefe) ve gerçekleşen etkileşim (herkese). */
  | { t: "pairreq"; from: number; name: string; kind: "five" | "hug" }
  | { t: "pair"; a: number; b: number; kind: "five" | "hug" }
  | { t: "quest"; completed: QuestDone[] }
  | { t: "profile"; sid: number; name: string; profile: Profile | null; error?: string }
  | ({ t: "stage" } & StageState)
  | { t: "season"; season: string; top: { id: string; name: string; kills: number; wins: number }[] };

/** İstemcinin gönderdiği JSON olaylar. */
export type ClientEvent =
  | { t: "ping"; c: number }
  /** Hızlı yol teklifi (WebRTC). */
  | { t: "rtc"; sdp: string }
  /**
   * Bağlantı özeti (30 sn'de bir, sunucu loguna): ping ortancası (hızlı yol açıksa onun, `ws` WebSocket'in),
   * hızlı yolda kayıp oranı, çizim gecikmesi (ms), hareket eden biri beklenirken (örnek yetmedi) geçen
   * karelerin oranı, hızlı yol açık mı.
   */
  | { t: "netstat"; rtt: number; ws: number; loss: number; delay: number; starve: number; udp: boolean }
  | { t: "wcmd"; op: "play" | "pause" | "seek"; pos?: number }
  | { t: "wload"; url: string }
  | { t: "emote"; e: number }
  | { t: "act"; a: Act }
  | { t: "fish" }
  /** Gölün yanına gelince: sonraki balık hakkı ne zaman? (cevap "fishwait") */
  | { t: "fishq" }
  | { t: "wardrobe" }
  | { t: "outfit"; outfit: Look }
  | { t: "chat"; text: string }
  | { t: "tank"; on: boolean }
  | { t: "taim"; h: number; tr: number; el: number }
  /** Atış anındaki açılar da gelir: mermi tam o an kulenin baktığı yöne gider. */
  | { t: "fire"; h: number; tr: number; el: number }
  | { t: "team"; team: 0 | 1 }
  /** Activity'den paylaşılamıyorsa: aynı odanın tarayıcı linki istenir (cevap "open"). */
  | { t: "sharelink" }
  | { t: "cosm"; pet: string | null; skin: string | null }
  /** Masaya otur / kalk / oyunu başlat / hamle / pes et. */
  | { t: "tsit"; id: number; seat: number }
  | { t: "tleave" }
  | { t: "tstart"; id: number }
  | { t: "tmove"; id: number; move: TableMove }
  | { t: "tresign"; id: number }
  /** Topa vur: yön (radyan), güç (0–1), tür ve falso (-1 sola … 1 sağa). */
  | { t: "kick"; dir: number; power: number; kind?: KickKind; curve?: number }
  /** Rakibin ayağındaki topa müdahale; `slide`: koşarken kayarak (uzun menzil, kaçarsa yerde kalır). */
  | { t: "tackle"; slide?: boolean }
  /** Çalım (roulette; `side` topun döndüğü yan) ve rainbow; stadyumda takım değiştir, dünyaya dön. */
  | { t: "skill"; side?: -1 | 1 }
  | { t: "rainbow" }
  | { t: "fbteam"; team: 0 | 1 }
  | { t: "fbhome" }
  /** İnşa: boş arsa sahiplen, kendi arsana blok koy/sil (b 0), arsanı boşalt. */
  | { t: "bclaim" }
  | { t: "bset"; i: number; j: number; k: number; b: number; r: number }
  | { t: "bfree" }
  | { t: "tagjoin" }
  /** Oyuncak pist: katıl/ayrıl, pist seç ve başlat (lobiyi açan), araba konumu (yarışta ~15 Hz). */
  | { t: "rjoin" }
  | { t: "rleave" }
  | { t: "rtrack"; i: number }
  | { t: "rstart" }
  | { t: "rcar"; x: number; z: number; a: number; f: number }
  | { t: "pair"; kind: "five" | "hug"; to: number }
  | { t: "pairok"; from: number }
  | { t: "profile"; sid: number }
  | { t: "fireworks" }
  /** DJ kabini: kabine geç/bırak, ışık şovu, şarkı geç. Sahne: çık/in. */
  | { t: "dj"; op: "take" | "leave" | "show" | "skip"; show?: number }
  | { t: "stage"; on: boolean }
  /** Perdedeki video bitti (sıradaki çalsın). */
  | { t: "wended" }
  /** Bisiklet/kaykayla gidilen yol (m), görev için. */
  | { t: "ride"; m: number }
  | { t: "season" }
  | { t: "bmode"; mode: BattleMode }
  | { t: "skin"; skin: string };

/** Konum mesajı: durum + konumun ait olduğu an (gönderenin sunucu saati tahmini). */
export const STATE_BYTES = 16;
/** Zaman damgasız eski konum mesajı (deploy sırasında henüz yenilenmemiş sayfa). */
const LEGACY_STATE_BYTES = 8;
export const SNAPSHOT_HEADER_BYTES = 10;
export const SNAPSHOT_ENTRY_BYTES = 11;
/** Snapshot'ta örnek yaşı u16 ms: daha eskisi bu kadar sayılır (konumu zaten değişmiyor). */
const MAX_AGE_MS = 0xffff;

function quantPos(v: number): number {
  return Math.max(-32767, Math.min(32767, Math.round(v * POS_SCALE)));
}

function quantRot(r: number): number {
  const n = ((r % TAU) + TAU) % TAU;
  return Math.round((n / TAU) * 65535) & 0xffff;
}

function unquantRot(q: number): number {
  return (q / 65535) * TAU;
}

/** [type u8][x i16][z i16][rot u16][flags u8][time f64] — `time`: konumun ait olduğu an (sunucu saati, ms), 0: bilinmiyor. */
export function encodeState(view: DataView, s: PlayerState, time = 0): void {
  view.setUint8(0, MSG_STATE);
  view.setInt16(1, quantPos(s.x), true);
  view.setInt16(3, quantPos(s.z), true);
  view.setUint16(5, quantRot(s.rot), true);
  view.setUint8(7, s.flags & 0xff);
  view.setFloat64(8, time, true);
}

/** Geçersiz mesajda -1, aksi halde gönderenin örnek zamanı (yoksa ya da anlamsızsa 0). */
export function decodeState(view: DataView, out: PlayerState): number {
  const n = view.byteLength;
  if ((n !== STATE_BYTES && n !== LEGACY_STATE_BYTES) || view.getUint8(0) !== MSG_STATE) return -1;
  out.x = view.getInt16(1, true) / POS_SCALE;
  out.z = view.getInt16(3, true) / POS_SCALE;
  out.rot = unquantRot(view.getUint16(5, true));
  out.flags = view.getUint8(7);
  if (n === LEGACY_STATE_BYTES) return 0;
  const time = view.getFloat64(8, true);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

/** Snapshot boyutu: [type u8][time f64][count u8] + count × [sid u16][x i16][z i16][rot u16][flags u8][age u16] */
export function snapshotSize(count: number): number {
  return SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_ENTRY_BYTES;
}

export function writeSnapshotHeader(view: DataView, time: number, count: number): void {
  view.setUint8(0, MSG_SNAPSHOT);
  view.setFloat64(1, time, true);
  view.setUint8(9, count);
}

/** `age`: oyuncunun konumunun snapshot zamanından ne kadar eski olduğu (ms). */
export function writeSnapshotEntry(view: DataView, index: number, sid: number, s: PlayerState, age = 0): void {
  const o = SNAPSHOT_HEADER_BYTES + index * SNAPSHOT_ENTRY_BYTES;
  view.setUint16(o, sid, true);
  view.setInt16(o + 2, quantPos(s.x), true);
  view.setInt16(o + 4, quantPos(s.z), true);
  view.setUint16(o + 6, quantRot(s.rot), true);
  view.setUint8(o + 8, s.flags & 0xff);
  view.setUint16(o + 9, Math.max(0, Math.min(MAX_AGE_MS, Math.round(age))), true);
}

export const PING_BYTES = 11;
export const PONG_BYTES = 19;

/** [type u8][seq u16][c f64] — `c`: istemcinin gönderdiği an (yerel saat, ms). */
export function writePing(view: DataView, seq: number, c: number): void {
  view.setUint8(0, MSG_PING);
  view.setUint16(1, seq & 0xffff, true);
  view.setFloat64(3, c, true);
}

/** Ping'in cevabı: [type u8][seq u16][c f64][s f64] — `s`: sunucunun cevapladığı an. Ping değilse null. */
export function pongFor(ping: DataView, s: number): Uint8Array | null {
  if (ping.byteLength !== PING_BYTES || ping.getUint8(0) !== MSG_PING) return null;
  const out = new Uint8Array(PONG_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, MSG_PONG);
  view.setUint16(1, ping.getUint16(1, true), true);
  view.setFloat64(3, ping.getFloat64(3, true), true);
  view.setFloat64(11, s, true);
  return out;
}

export function readPong(view: DataView): { seq: number; c: number; s: number } | null {
  if (view.byteLength !== PONG_BYTES || view.getUint8(0) !== MSG_PONG) return null;
  return { seq: view.getUint16(1, true), c: view.getFloat64(3, true), s: view.getFloat64(11, true) };
}

/**
 * Snapshot'ı allocation yapmadan okur: her oyuncu için `fn` çağrılır (`time`: o oyuncunun konumunun ait olduğu an).
 * Geçersiz mesajda -1, aksi halde snapshot'ın sunucu zamanını döndürür.
 */
export function readSnapshot(
  view: DataView,
  fn: (sid: number, x: number, z: number, rot: number, flags: number, time: number) => void,
): number {
  if (view.byteLength < SNAPSHOT_HEADER_BYTES || view.getUint8(0) !== MSG_SNAPSHOT) return -1;
  const time = view.getFloat64(1, true);
  const count = view.getUint8(9);
  if (view.byteLength !== snapshotSize(count)) return -1;
  for (let i = 0; i < count; i++) {
    const o = SNAPSHOT_HEADER_BYTES + i * SNAPSHOT_ENTRY_BYTES;
    fn(
      view.getUint16(o, true),
      view.getInt16(o + 2, true) / POS_SCALE,
      view.getInt16(o + 4, true) / POS_SCALE,
      unquantRot(view.getUint16(o + 6, true)),
      view.getUint8(o + 8),
      time - view.getUint16(o + 9, true),
    );
  }
  return time;
}
