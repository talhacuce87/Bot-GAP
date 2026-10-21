// Tel protokolü. Sık mesajlar (konum, snapshot) binary; seyrek olaylar JSON metin.
import { type Act, POS_SCALE } from "./constants";
import type { Source } from "./media";
import type { Phase } from "./arena";
import type { Shot } from "./tank";

export const MSG_STATE = 1; // istemci → sunucu: kendi konumu
export const MSG_SNAPSHOT = 2; // sunucu → istemci: odadaki herkesin konumu

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
}

/** Tank savaşının durumu (değişince herkese): `endsAt` evrenin bittiği sunucu zamanı (ms). */
export interface BattleState {
  phase: Phase;
  endsAt: number;
  score: [number, number];
  fighters: Fighter[];
}

/** Sunucunun gönderdiği JSON olaylar. */
export type ServerEvent =
  | { t: "welcome"; you: number; room: string; players: PlayerInfo[] }
  | { t: "join"; player: PlayerInfo }
  | { t: "leave"; sid: number }
  | { t: "jail"; sid: number; jailed: boolean; x: number; z: number; rot: number }
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
  /** Tankın durumu (biri binince/inince ve girişte): `driver` 0 ise park halinde. */
  | { t: "tank"; driver: number; x: number; z: number; h: number; tr: number; el: number }
  /** Sürücünün gövde ve kule açısı (konumu sürücünün kendi snapshot'ından gelir). */
  | { t: "taim"; h: number; tr: number; el: number }
  /** Atış: herkes aynı yayı çizer; `hits` savrulanlar (yalnızca kendi sid'i olan uygular). */
  | { t: "shell"; sid: number; shot: Shot; hits: { sid: number; vx: number; vz: number }[] }
  | ({ t: "battle" } & BattleState)
  /** Savaşta (yeniden) doğma: sunucu konumu belirler, o oyuncu tankını oraya koyar. */
  | { t: "spawn"; sid: number; x: number; z: number; h: number }
  /** Savaşta bir tankın gövde/kule/namlu açısı (konumu snapshot'tan). */
  | { t: "baim"; sid: number; h: number; tr: number; el: number }
  | { t: "kill"; killer: number; victim: number };

/** İstemcinin gönderdiği JSON olaylar. */
export type ClientEvent =
  | { t: "ping"; c: number }
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
  | { t: "sharelink" };

export const STATE_BYTES = 8;
export const SNAPSHOT_HEADER_BYTES = 10;
export const SNAPSHOT_ENTRY_BYTES = 9;

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

/** [type u8][x i16][z i16][rot u16][flags u8] */
export function encodeState(view: DataView, s: PlayerState): void {
  view.setUint8(0, MSG_STATE);
  view.setInt16(1, quantPos(s.x), true);
  view.setInt16(3, quantPos(s.z), true);
  view.setUint16(5, quantRot(s.rot), true);
  view.setUint8(7, s.flags & 0xff);
}

export function decodeState(view: DataView, out: PlayerState): boolean {
  if (view.byteLength !== STATE_BYTES || view.getUint8(0) !== MSG_STATE) return false;
  out.x = view.getInt16(1, true) / POS_SCALE;
  out.z = view.getInt16(3, true) / POS_SCALE;
  out.rot = unquantRot(view.getUint16(5, true));
  out.flags = view.getUint8(7);
  return true;
}

/** Snapshot boyutu: [type u8][time f64][count u8] + count × [sid u16][x i16][z i16][rot u16][flags u8] */
export function snapshotSize(count: number): number {
  return SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_ENTRY_BYTES;
}

export function writeSnapshotHeader(view: DataView, time: number, count: number): void {
  view.setUint8(0, MSG_SNAPSHOT);
  view.setFloat64(1, time, true);
  view.setUint8(9, count);
}

export function writeSnapshotEntry(view: DataView, index: number, sid: number, s: PlayerState): void {
  const o = SNAPSHOT_HEADER_BYTES + index * SNAPSHOT_ENTRY_BYTES;
  view.setUint16(o, sid, true);
  view.setInt16(o + 2, quantPos(s.x), true);
  view.setInt16(o + 4, quantPos(s.z), true);
  view.setUint16(o + 6, quantRot(s.rot), true);
  view.setUint8(o + 8, s.flags & 0xff);
}

/**
 * Snapshot'ı allocation yapmadan okur: her oyuncu için `fn` çağrılır.
 * Geçersiz mesajda -1, aksi halde sunucu zamanını döndürür.
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
      time,
    );
  }
  return time;
}
