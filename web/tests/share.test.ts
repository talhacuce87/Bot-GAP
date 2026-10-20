import { describe, expect, it } from "vitest";
import { asRandomAccess, clusterHead, Share, SHARE_MAX_BYTES_PER_10S, SHARE_MIME, Shares, type ShareSink, WebmCutter } from "../server/src/share";

// ---- Sentetik WebM (Chrome MediaRecorder yapısı): EBML, canlı Segment, Info, Tracks (video 1 + ses 2), kümeler ----
const id = (n: number) => {
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
};
const size = (n: number) => [0x40 | (n >> 8), n & 0xff]; // 2 baytlık boyut
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const el = (eid: number, body: number[]) => [...id(eid), ...size(body.length), ...body];
const fill = (n: number, v: number) => Array.from({ length: n }, (_, i) => (v + i * 7) & 0xff);
const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0));
const track = (num: number, type: number, codec: string) => el(0xae, [...el(0xd7, [num]), ...el(0x83, [type]), ...el(0x86, ascii(codec))]);

const HEADER = [
  ...el(0x1a45dfa3, fill(20, 1)), // EBML
  ...id(0x18538067), ...UNKNOWN, // Segment (canlı)
  ...el(0x1549a966, fill(30, 7)), // Info
  ...el(0x1654ae6b, [...track(1, 1, "V_VP8"), ...track(2, 2, "A_OPUS")]), // Tracks
];

/** Akış kurucu: her bloğun konumunu kaydeder; anahtar karelerin [konum, küme zaman kodu]. */
class Stream {
  bytes = [...HEADER];
  keys: { at: number; length: number; timecode: number }[] = [];
  private tc = 0;
  cluster(tc: number, known = false, blocks: (() => number[])[] = []): this {
    this.tc = tc;
    if (known) {
      // Boyutlu küme: içeriği önce kur
      const inner = new Stream();
      inner.bytes = [];
      inner.tc = tc;
      const body = [...el(0xe7, [tc >> 8, tc & 0xff])];
      inner.bytes = body;
      for (const b of blocks) inner.bytes.push(...b());
      const headLen = id(0x1f43b675).length + 2;
      const base = this.bytes.length + headLen;
      inner.keys.forEach((k) => this.keys.push({ at: base + k.at, length: k.length, timecode: tc }));
      this.bytes.push(...id(0x1f43b675), ...size(inner.bytes.length), ...inner.bytes);
      return this;
    }
    this.bytes.push(...id(0x1f43b675), ...UNKNOWN, ...el(0xe7, [tc >> 8, tc & 0xff]));
    return this;
  }
  /**
   * Video bloğu: SimpleBlock ya da (Chrome gibi) BlockGroup > Block [+ ReferenceBlock]; VP8 kare bayrağı
   * ilk baytın 0. biti. Chrome ilk kare dışındaki anahtar karelere de ReferenceBlock koyar.
   */
  video(key: boolean, group = true, n = 60, ref = group && this.keys.length > 0): this {
    const frame = [key ? 0x50 : 0x11, 0x1f, 0x43, 0xb6, 0x75, ...fill(n, this.bytes.length)]; // içinde küme kimliği taklidi
    const block = [0x81, 0, 0, group ? 0 : key ? 0x80 : 0, ...frame];
    const bytes = group ? el(0xa0, [...el(0xa1, block), ...(ref ? el(0xfb, [0x07, 0x92]) : [])]) : el(0xa3, block);
    if (key) this.keys.push({ at: this.bytes.length, length: bytes.length, timecode: this.tc });
    this.bytes.push(...bytes);
    return this;
  }
  /** Ses bloğu: hep "anahtar" bayraklı ama video değil. */
  audio(): this {
    this.bytes.push(...el(0xa3, [0x82, 0, 0, 0x80, ...fill(20, 3)]));
    return this;
  }
}

const sample = () =>
  new Stream()
    .cluster(0).video(true).audio().video(false).audio().video(false)
    .video(true, false).audio().video(false)
    .cluster(4250).video(false).audio().video(false).video(true).audio().video(false)
    .cluster(9000).video(false, false).video(true, false).video(false);

function split(bytes: number[], sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0, k = 0;
  while (i < bytes.length) {
    const n = sizes[k++ % sizes.length];
    out.push(Uint8Array.from(bytes.slice(i, i + n)));
    i += n;
  }
  return out;
}

describe("WebM kesici", () => {
  const s = sample();
  for (const sizes of [[s.bytes.length], [1], [3, 7, 1, 50], [64]]) {
    it(`başlığı ve video anahtar karelerini parça boyutundan bağımsız bulur (${sizes.join(",")})`, () => {
      const c = new WebmCutter();
      const found = split(s.bytes, sizes).flatMap((p) => c.feed(p));
      expect(c.broken).toBe(false);
      expect([...c.header!]).toEqual(HEADER);
      expect(found).toEqual(s.keys);
      expect(found.map((k) => k.timecode)).toEqual([0, 0, 4250, 9000]);
    });
  }

  it("boyutlu kümelerde de çalışır", () => {
    const st = new Stream().cluster(0, true, [() => el(0xa3, [0x81, 0, 0, 0x80, 0x50, 1, 2])]);
    const c = new WebmCutter();
    expect(c.feed(Uint8Array.from(st.bytes)).map((k) => k.timecode)).toEqual([0]);
  });

  it("WebM olmayan veride bozuk işaretler", () => {
    const c = new WebmCutter();
    c.feed(Uint8Array.from([0x80, 0x81, 1, 2, 3, 4]));
    expect(c.broken).toBe(true);
  });

  it("anahtar karenin BlockGroup'undan ReferenceBlock'u çıkarır, SimpleBlock'a dokunmaz", () => {
    const block = [0x81, 0, 0, 0, 0x50, 1, 2, 3];
    const group = Uint8Array.from(el(0xa0, [...el(0xa1, block), ...el(0x9b, [5]), ...el(0xfb, [0x07, 0x92])]));
    const fixed = asRandomAccess(group);
    expect(fixed[0]).toBe(0xa0);
    expect(fixed[1]).toBe(0x01); // 8 baytlık boyut
    expect(Buffer.from(fixed.subarray(2, 9)).readUIntBE(1, 6)).toBe(fixed.length - 9);
    expect([...fixed.subarray(9)]).toEqual([...el(0xa1, block), ...el(0x9b, [5])]);
    const simple = Uint8Array.from(el(0xa3, [0x81, 0, 0, 0x80, 0x50]));
    expect(asRandomAccess(simple)).toBe(simple);
  });

  it("yapay küme başı geçerli bir bilinmeyen boyutlu Cluster + Timecode'dur", () => {
    const h = clusterHead(4019);
    expect([...h.subarray(0, 4)]).toEqual([0x1f, 0x43, 0xb6, 0x75]);
    expect([...h.subarray(12, 14)]).toEqual([0xe7, 0x88]);
    expect(Buffer.from(h.subarray(14)).readBigUInt64BE()).toBe(4019n);
  });
});

function sink(buffered = 0) {
  const s = { got: [] as number[], texts: [] as string[], closed: 0, bufferedAmount: buffered } as ShareSink & { got: number[]; texts: string[]; closed: number; bufferedAmount: number };
  s.send = (d) => (typeof d === "string" ? s.texts.push(d) : s.got.push(...d));
  s.close = (code) => (s.closed = code ?? 1);
  return s;
}

describe("paylaşım dağıtımı", () => {
  const s = sample();

  it("baştan izleyen her şeyi, sonradan gelen başlık + son anahtar kareden itibaren alır", () => {
    const share = new Share(5, "Barış", "video/webm;codecs=vp8,opus");
    const early = sink();
    share.addViewer(early);
    const parts = split(s.bytes, [13]);
    const key = s.keys[2]; // kümenin ortasındaki anahtar kare (4250)
    let fed = 0, i = 0;
    for (; fed < key.at + 60; i++) {
      share.data(parts[i]);
      fed += parts[i].length;
    }
    const late = sink();
    share.addViewer(late);
    for (; i < parts.length; i++) share.data(parts[i]);

    expect(JSON.parse(early.texts[0])).toEqual({ t: "init", mime: "video/webm;codecs=vp8,opus", name: "Barış" });
    expect(early.got).toEqual(s.bytes);
    expect(late.texts.slice(1)).toEqual([JSON.stringify({ t: "reset" })]);
    const keyEl = Uint8Array.from(s.bytes.slice(key.at, key.at + key.length));
    expect(late.got).toEqual([...HEADER, ...clusterHead(4250), ...asRandomAccess(keyEl), ...s.bytes.slice(key.at + key.length)]);
  });

  it("geride kalan izleyici sıfırlanıp bir sonraki anahtar kareden devam eder", () => {
    const share = new Share(5, "Barış", "video/webm");
    const slow = sink();
    share.addViewer(slow);
    const parts = split(s.bytes, [s.keys[1].at + 3, 9, 4000]);
    share.data(parts[0]);
    slow.bufferedAmount = 50 * 1024 * 1024;
    share.data(parts[1]); // atlanır
    slow.bufferedAmount = 0;
    for (const p of parts.slice(2)) share.data(p);
    // Geride kaldıktan sonra gelen parçadaki en yeni anahtar kareden başlar
    const next = s.keys.at(-1)!;
    const keyEl = Uint8Array.from(s.bytes.slice(next.at, next.at + next.length));
    expect(slow.texts.slice(1)).toEqual([JSON.stringify({ t: "reset" })]);
    expect(slow.got).toEqual([...s.bytes.slice(0, parts[0].length), ...HEADER, ...clusterHead(next.timecode), ...asRandomAccess(keyEl), ...s.bytes.slice(next.at + next.length)]);
  });

  it("anahtar kare bloğu tamamlanmadan izleyiciyi başlatmaz", () => {
    const share = new Share(5, "Barış", "video/webm");
    const key = s.keys[2];
    share.data(Uint8Array.from(s.bytes.slice(0, key.at + 30))); // blok yarım
    const late = sink();
    share.addViewer(late);
    expect(late.got).toEqual([]);
    const until = s.keys[3].at; // sonraki anahtar kareden önce
    share.data(Uint8Array.from(s.bytes.slice(key.at + 30, until)));
    const keyEl = Uint8Array.from(s.bytes.slice(key.at, key.at + key.length));
    expect(late.got).toEqual([...HEADER, ...clusterHead(key.timecode), ...asRandomAccess(keyEl), ...s.bytes.slice(key.at + key.length, until)]);
  });

  it("hız sınırını aşan paylaşımı reddeder; bitince izleyicileri kapatır", () => {
    const share = new Share(1, "a", "video/webm");
    const v = sink();
    v.send = () => {}; // büyük parçaları biriktirme
    share.addViewer(v);
    expect(share.data(new Uint8Array(SHARE_MAX_BYTES_PER_10S - 10), 1000)).toBe(true);
    expect(share.data(new Uint8Array(100), 2000)).toBe(false);
    expect(share.data(new Uint8Array(100), 20_000)).toBe(true); // yeni pencere
    share.end();
    expect(v.closed).toBe(4000);
  });

  it("odada aynı anda tek paylaşım", () => {
    const shares = new Shares();
    const a = shares.start("d:1", 1, "Ayşe", "video/webm");
    expect("ok" in a).toBe(true);
    const b = shares.start("d:1", 2, "Cem", "video/webm");
    expect("busy" in b && b.busy.name).toBe("Ayşe");
    expect("ok" in shares.start("d:2", 2, "Cem", "video/webm")).toBe(true);
    if ("ok" in a) expect(shares.stop("d:1", a.ok)).toBe(true);
    expect("ok" in shares.start("d:1", 2, "Cem", "video/webm")).toBe(true);
  });

  it("yalnızca WebM türlerini kabul eder", () => {
    for (const m of ["video/webm", "video/webm;codecs=vp8,opus", 'video/webm; codecs="vp9"']) expect(SHARE_MIME.test(m), m).toBe(true);
    for (const m of ["video/mp4", "text/html", "video/webm;codecs=<x>"]) expect(SHARE_MIME.test(m), m).toBe(false);
  });
});
