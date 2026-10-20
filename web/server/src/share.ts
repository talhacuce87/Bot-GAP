// Ekran paylaşımı: paylaşanın tarayıcısı ekranı WebM olarak (MediaRecorder) parça parça yollar,
// sunucu odadaki izleyicilere aynen dağıtır (WebRTC yok: Activity'de de aynı origin'den çalışır,
// yükü sunucunun bant genişliği taşır). Sonradan gelen izleyici WebM başlığını ve
// son anahtar kareden itibaren alır, oradan canlıya katılır.

const EBML_ID = 0x1a45dfa3;
const SEGMENT_ID = 0x18538067;
const CLUSTER_ID = 0x1f43b675;
/** Segment'in küme dışındaki çocukları: bilinmeyen boyutlu kümenin bittiğini bunlardan anlarız. */
const SEGMENT_CHILDREN = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367, CLUSTER_ID]);

/** Başlık (EBML + Segment başı + Info/Tracks) en fazla bu kadar olabilir. */
const MAX_HEADER = 256 * 1024;
/** Son anahtar kareden bu kadar fazlası saklanmaz (çok uzun anahtar kare aralığı). */
const MAX_GOP = 16 * 1024 * 1024;
/** Anahtar kare başı için geriye dönük tutulan bayt (kararı bekleyen eleman başlığı + PEEK'ten fazlası). */
const RECENT_BYTES = 4096;
/** İzleyicinin gönderim kuyruğu bunu aşarsa bir sonraki kümeye kadar atlanır. */
const VIEWER_MAX_BUFFERED = 6 * 1024 * 1024;
/** Paylaşanın ortalama hızı (10 sn pencerede) bunu aşarsa bağlantı kesilir (~12 Mbit/sn). */
export const SHARE_MAX_BYTES_PER_10S = 15 * 1024 * 1024;
export const SHARE_MIME = /^video\/webm(;\s*codecs="?[\w.,]+"?)?$/i;

/** EBML değişken uzunluklu tamsayı: [değer, uzunluk]; `keepMarker` kimlikler için. Yetmezse null. */
function vint(b: Uint8Array, at: number, keepMarker: boolean): [number, number, boolean] | null {
  if (at >= b.length) return null;
  const first = b[at];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || at + len > b.length) return null;
  let v = keepMarker ? first : first & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[at + i];
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return [v, len, !keepMarker && allOnes];
}

/** Video izinin anahtar karesi: blok elemanının akıştaki konumu, toplam uzunluğu ve kümesinin zaman kodu. */
export interface Keyframe {
  at: number;
  length: number;
  timecode: number;
}

interface VideoTrack {
  track: number;
  codec: string;
}

/** Başlıktaki Tracks'ten video izinin numarası ve codec'i. */
function findVideoTrack(h: Uint8Array): VideoTrack | null {
  // EBML başlığını atla, Segment'e gir, Tracks > TrackEntry'leri gez
  const walk = (from: number, to: number, fn: (id: number, body: number, size: number) => void) => {
    let i = from;
    while (i < to) {
      const id = vint(h, i, true);
      const size = id && vint(h, i + id[1], false);
      if (!id || !size) return;
      const body = i + id[1] + size[1];
      const len = size[2] ? to - body : size[0];
      fn(id[0], body, len);
      i = body + len;
    }
  };
  let found: VideoTrack | null = null;
  walk(0, h.length, (id, body, size) => {
    if (id !== SEGMENT_ID) return;
    walk(body, Math.min(h.length, body + size), (cid, cbody, csize) => {
      if (cid !== 0x1654ae6b) return;
      walk(cbody, cbody + csize, (eid, ebody, esize) => {
        if (eid !== 0xae) return;
        let num = 0, type = 0, codec = "";
        walk(ebody, ebody + esize, (fid, fbody, fsize) => {
          let v = 0;
          for (let k = 0; k < fsize && k < 6; k++) v = v * 256 + h[fbody + k];
          if (fid === 0xd7) num = v;
          else if (fid === 0x83) type = v;
          else if (fid === 0x86) codec = String.fromCharCode(...h.subarray(fbody, fbody + fsize));
        });
        if (type === 1 && !found) found = { track: num, codec };
      });
    });
  });
  return found;
}

/**
 * Blok bir video anahtar karesi mi? `p`: blok gövdesi (SimpleBlock) ya da BlockGroup gövdesi.
 * Veri yetmezse null (daha fazla bayt beklenir).
 */
function isKeyframe(b: Uint8Array, p: number, end: number, simple: boolean, video: VideoTrack): boolean | null {
  if (!simple) {
    // BlockGroup: ilk çocuk Block (A1) olmalı; Block'ta anahtar kare bayrağı yok, codec'e bakılır
    if (p >= end) return null;
    if (b[p] !== 0xa1) return false;
    const s = vint(b, p + 1, false);
    if (!s) return null;
    p += 1 + s[1];
  }
  const tr = vint(b, p, false);
  if (!tr) return null;
  if (tr[0] !== video.track) return false;
  p += tr[1] + 2; // iz + göreli zaman
  if (p + 1 >= end) return null;
  const flags = b[p++];
  if (simple) return (flags & 0x80) !== 0;
  const x = b[p];
  if (video.codec === "V_VP8") return (x & 1) === 0;
  if (video.codec === "V_VP9") {
    // frame_marker(2) profile(2) [reserved(1) profil 3'te] show_existing(1) frame_type(1): 0 = anahtar
    const profile = ((x >> 5) & 1) | (((x >> 4) & 1) << 1);
    const bit = profile === 3 ? 2 : 3;
    if ((x >> bit) & 1) return false;
    return ((x >> (bit - 1)) & 1) === 0;
  }
  return false;
}

/** Bloğun anahtar kare olup olmadığını anlamak için gereken en fazla bayt. */
const PEEK = 24;

/**
 * Akış halindeki WebM'i eleman sınırlarından okur: başlığı (ilk kümeye kadar) ayırır ve video
 * anahtar karelerinin konumunu bildirir. Chrome kümeleri anahtar karelerde bölmez; sonradan gelen
 * izleyici anahtar kareden başlamalı (yoksa çözücü hata verir).
 */
export class WebmCutter {
  /** İlk kümeye kadarki baytlar; henüz bilinmiyorsa null. */
  header: Uint8Array | null = null;
  broken = false;
  private video: VideoTrack | null = null;
  private pre: Uint8Array[] = [];
  private pending = new Uint8Array(0);
  private abs = 0; // pending[0]'ın akıştaki konumu
  private skip = 0;
  private level: "top" | "segment" | "cluster" = "top";
  private timecode = 0;

  /** Yeni parçayı işler; bu parçada başlayan video anahtar karelerini döndürür. */
  feed(chunk: Uint8Array): Keyframe[] {
    const out: Keyframe[] = [];
    if (this.broken) return out;
    if (!this.header) this.pre.push(chunk);
    let b = this.pending.length ? concat([this.pending, chunk]) : chunk;
    let i = 0;
    while (i < b.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, b.length - i);
        this.skip -= n;
        i += n;
        continue;
      }
      const id = vint(b, i, true);
      const size = id && vint(b, i + id[1], false);
      if (!id || !size) break; // eleman başlığı tamamlanmadı: sonraki parçayı bekle
      const head = id[1] + size[1];
      const [eid] = id;
      const [esize, , unknown] = size;
      if (this.level === "cluster" && SEGMENT_CHILDREN.has(eid)) this.level = "segment";
      if (this.level === "top") {
        if (eid === SEGMENT_ID) this.level = "segment";
        else if (eid === EBML_ID && !unknown) this.skip = esize;
        else return this.fail(out);
        i += head;
      } else if (this.level === "segment") {
        if (eid === CLUSTER_ID) {
          if (!this.header) {
            this.header = concat(this.pre).slice(0, this.abs + i);
            this.pre = [];
            this.video = findVideoTrack(this.header);
          }
          this.timecode = 0;
          // Boyutlu kümede de çocuklar gezilir (anahtar kareler için); bitince sıradaki Segment çocuğu gelir
          this.level = "cluster";
        } else if (unknown) {
          return this.fail(out);
        } else {
          this.skip = esize;
        }
        i += head;
      } else {
        if (unknown) return this.fail(out); // küme çocuğu (SimpleBlock vb.) hep boyutludur
        const body = i + head;
        if (eid === 0xe7) {
          if (body + esize > b.length) break; // zaman kodunun tamamını bekle
          let tc = 0;
          for (let k = 0; k < esize; k++) tc = tc * 256 + b[body + k];
          this.timecode = tc;
        } else if ((eid === 0xa3 || eid === 0xa0) && this.video) {
          const end = Math.min(b.length, body + esize);
          if (end < body + Math.min(esize, PEEK)) break; // karar için yeterli bayt yok
          if (isKeyframe(b, body, end, eid === 0xa3, this.video)) out.push({ at: this.abs + i, length: head + esize, timecode: this.timecode });
        }
        this.skip = esize;
        i += head;
      }
      if (!this.header && this.abs + i > MAX_HEADER) return this.fail(out);
    }
    this.abs += i;
    b = b.subarray(i);
    this.pending = b.length ? b.slice() : new Uint8Array(0);
    return out;
  }

  private fail(out: Keyframe[]): Keyframe[] {
    this.broken = true;
    this.pending = new Uint8Array(0);
    this.pre = [];
    return out;
  }
}

/**
 * Anahtar karenin bloğunu MSE'nin "rastgele erişim noktası" sayacağı hale getirir. Chrome MediaRecorder
 * ilk kare dışındaki anahtar karelerin BlockGroup'una ReferenceBlock ekler; Matroska'ya göre bu kare
 * anahtar değildir ve Chrome MSE ona kadar her şeyi atar. ReferenceBlock çıkarılır (VP8/VP9 karesi
 * zaten bağımsızdır). SimpleBlock'a dokunulmaz.
 */
export function asRandomAccess(el: Uint8Array): Uint8Array {
  const id = vint(el, 0, true);
  const size = id && vint(el, id[1], false);
  if (!id || !size || id[0] !== 0xa0) return el;
  const kids: Uint8Array[] = [];
  let i = id[1] + size[1];
  while (i < el.length) {
    const cid = vint(el, i, true);
    const csize = cid && vint(el, i + cid[1], false);
    if (!cid || !csize) return el;
    const end = i + cid[1] + csize[1] + csize[0];
    if (cid[0] !== 0xfb) kids.push(el.subarray(i, end));
    i = end;
  }
  const body = concat(kids);
  // Boyut 8 baytlık vint olarak yazılır (her uzunluğa yeter)
  const out = new Uint8Array(1 + 8 + body.length);
  out[0] = 0xa0;
  out[1] = 0x01;
  let v = body.length;
  for (let k = 8; k >= 2; k--) {
    out[k] = v % 256;
    v = Math.floor(v / 256);
  }
  out.set(body, 9);
  return out;
}

/** Anahtar kareden başlayan yarım kümenin başı: bilinmeyen boyutlu Cluster + Timecode (8 bayt). */
export function clusterHead(timecode: number): Uint8Array {
  const out = new Uint8Array(4 + 8 + 2 + 8);
  out.set([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x88]);
  let v = timecode;
  for (let k = 21; k >= 14; k--) {
    out[k] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface ShareSink {
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
}

interface Viewer {
  /**
   * live: akışı sırayla alıyor. Değilse bir anahtar kareden (yeniden) başlamayı bekliyor:
   * `minGop` ve sonrasındaki ilk tamamlanmış anahtar kare grubundan başlar.
   */
  live: boolean;
  minGop: number;
}

/** Son anahtar kareden bu yana gelenler: sonradan gelenler ve geride kalanlar buradan başlar. */
interface Gop {
  id: number;
  timecode: number;
  /** Anahtar kare elemanının toplam uzunluğu (tamamı gelince yeniden yazılabilir). */
  keyLength: number;
  parts: Uint8Array[];
  bytes: number;
}

export class Share {
  readonly cutter = new WebmCutter();
  private pos = 0;
  /** Başlık gelmeden bağlanan izleyiciler için akışın başı. */
  private early: Uint8Array[] = [];
  private gop: Gop | null = null;
  private gopIds = 0;
  private viewers = new Map<ShareSink, Viewer>();
  /**
   * Önceki birkaç parça: anahtar kare kararı için bayt beklenince kare bir sonraki parçada bildirilir,
   * ama başı öncekinde kalmış olabilir.
   */
  private recent: { start: number; data: Uint8Array }[] = [];
  private window: { at: number; bytes: number } = { at: 0, bytes: 0 };
  /** Toplam gönderilen bayt (istatistik). */
  sent = 0;
  /** Paylaşanın bağlantısını kapatır (paylaşan dünyadan çıkınca). */
  closeSender: () => void = () => {};

  constructor(
    readonly sid: number,
    readonly name: string,
    readonly mime: string,
  ) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  /** Paylaşandan gelen parça. Hız sınırı aşılırsa false (bağlantı kesilmeli). */
  data(chunk: Uint8Array, now = Date.now()): boolean {
    if (now - this.window.at > 10_000) this.window = { at: now, bytes: 0 };
    this.window.bytes += chunk.length;
    if (this.window.bytes > SHARE_MAX_BYTES_PER_10S) return false;

    const start = this.pos;
    const hadHeader = !!this.cutter.header;
    const keys = this.cutter.feed(chunk);
    this.pos += chunk.length;
    if (!hadHeader && !this.cutter.header && !this.cutter.broken) this.early.push(chunk);
    else this.early = [];

    const last = keys.at(-1);
    if (last !== undefined) {
      const parts = this.from(last.at, chunk, start);
      this.gop = { id: ++this.gopIds, timecode: last.timecode, keyLength: last.length, parts, bytes: parts.reduce((n, c) => n + c.length, 0) };
    } else if (this.gop) {
      this.gop.parts.push(chunk);
      this.gop.bytes += chunk.length;
      if (this.gop.bytes > MAX_GOP) this.gop = null;
    }

    for (const [sink, v] of this.viewers) {
      if (!v.live) {
        this.tryStart(sink, v);
        continue;
      }
      if (sink.bufferedAmount > VIEWER_MAX_BUFFERED) {
        // Geride kaldı: bir sonraki anahtar kareden sıfırlanarak devam eder
        v.live = false;
        v.minGop = this.gopIds + 1;
        continue;
      }
      this.push(sink, chunk);
    }

    this.recent.push({ start, data: chunk });
    let kept = 0;
    for (const r of this.recent) kept += r.data.length;
    while (this.recent.length > 1 && kept - this.recent[0].data.length >= RECENT_BYTES) kept -= this.recent.shift()!.data.length;
    return true;
  }

  /** Akışın `at` konumundan bu parçanın sonuna kadarki baytlar (önceki parçalara taşabilir). */
  private from(at: number, chunk: Uint8Array, start: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const r of this.recent) {
      if (r.start + r.data.length > at) out.push(r.data.subarray(Math.max(0, at - r.start)));
    }
    out.push(chunk.subarray(Math.max(0, at - start)));
    return out;
  }

  /**
   * Bekleyen izleyiciyi anahtar kareden başlatır: okuyucusunu sıfırlar (elinde yarım eleman olabilir),
   * başlık + yarım küme başı + MSE'nin anahtar sayacağı blok + sonrası. Blok henüz tamamlanmadıysa bekler.
   */
  private tryStart(sink: ShareSink, v: Viewer): void {
    const g = this.gop, header = this.cutter.header;
    if (!g || !header || g.id < v.minGop || g.bytes < g.keyLength) return;
    const all = g.parts.length === 1 ? g.parts[0] : concat(g.parts);
    v.live = true;
    sink.send(JSON.stringify({ t: "reset" }));
    this.push(sink, header);
    this.push(sink, clusterHead(g.timecode));
    this.push(sink, asRandomAccess(all.subarray(0, g.keyLength)));
    if (all.length > g.keyLength) this.push(sink, all.subarray(g.keyLength));
  }

  /** İzleyici ekler: tür bilgisi gider; paylaşım yeni başladıysa akışın başından, değilse son anahtar kareden alır. */
  addViewer(sink: ShareSink): void {
    sink.send(JSON.stringify({ t: "init", mime: this.mime, name: this.name }));
    const v: Viewer = { live: false, minGop: 0 };
    this.viewers.set(sink, v);
    if (!this.cutter.header && !this.cutter.broken) {
      for (const c of this.early) this.push(sink, c);
      v.live = true;
      return;
    }
    this.tryStart(sink, v);
  }

  removeViewer(sink: ShareSink): void {
    this.viewers.delete(sink);
  }

  /** Paylaşım bitti: izleyiciler kapatılır. */
  end(): void {
    for (const sink of this.viewers.keys()) sink.close(4000, "ended");
    this.viewers.clear();
  }

  private push(sink: ShareSink, data: Uint8Array): void {
    this.sent += data.length;
    sink.send(data);
  }
}

/** Oda başına en fazla bir paylaşım. */
export class Shares {
  private byRoom = new Map<string, Share>();

  get(room: string): Share | undefined {
    return this.byRoom.get(room);
  }

  /** Başka biri paylaşıyorsa o paylaşım döner (başlatılmaz). */
  start(room: string, sid: number, name: string, mime: string): { ok: Share } | { busy: Share } {
    const cur = this.byRoom.get(room);
    if (cur) return { busy: cur };
    const s = new Share(sid, name, mime);
    this.byRoom.set(room, s);
    return { ok: s };
  }

  stop(room: string, share: Share): boolean {
    if (this.byRoom.get(room) !== share) return false;
    this.byRoom.delete(room);
    share.end();
    return true;
  }

  all(): IterableIterator<[string, Share]> {
    return this.byRoom.entries();
  }
}
