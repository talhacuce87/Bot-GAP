// Tel protokolü. Sık mesajlar (konum, snapshot) binary; seyrek olaylar JSON metin.
import { POS_SCALE } from "./constants";

export const MSG_STATE = 1; // istemci → sunucu: kendi konumu
export const MSG_SNAPSHOT = 2; // sunucu → istemci: odadaki herkesin konumu

const TAU = Math.PI * 2;

export interface PlayerState {
  x: number;
  z: number;
  rot: number;
  flags: number;
}

export interface PlayerInfo {
  sid: number;
  id: string;
  name: string;
  avatar: string | null;
  spectator: boolean;
  /** Sürgünde: zindan hücresinde tutulur. */
  jailed: boolean;
}

/** Sunucunun gönderdiği JSON olaylar. */
export type ServerEvent =
  | { t: "welcome"; you: number; room: string; players: PlayerInfo[] }
  | { t: "join"; player: PlayerInfo }
  | { t: "leave"; sid: number }
  | { t: "jail"; sid: number; jailed: boolean; x: number; z: number; rot: number }
  | { t: "pong"; c: number; s: number };

/** İstemcinin gönderdiği JSON olaylar. */
export type ClientEvent = { t: "ping"; c: number };

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
