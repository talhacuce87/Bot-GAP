// Ekran paylaşımını izleyen taraf: sunucudan gelen WebM baytları MediaSource ile <video>'ya beslenir.
// Canlı kenarda kalır: geride kalınca ileri atlar, eski tamponu siler.

/** Canlıdan bu kadar gerideyse atla. */
const MAX_LAG = 2.5;
const KEEP_BEHIND = 20;

export class ShareViewer {
  readonly video = document.createElement("video");
  /**
   * Bağlantı kapandı ya da oynatılamıyor; `reason` varsa gösterilir. `unexpected`: paylaşım bitmeden
   * koptu (yeniden bağlanılabilir).
   */
  onEnd: (reason?: string, unexpected?: boolean) => void = () => {};
  private ws: WebSocket;
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  /** "reset": okuyucu sıfırlanır (geride kalınca sunucu başlığı ve anahtar kareyi yeniden yollar). */
  private queue: (ArrayBuffer | "reset")[] = [];
  private queued = 0;
  private timer = 0;
  private closed = false;

  constructor(url: string) {
    const v = this.video;
    v.muted = true;
    v.autoplay = true;
    v.playsInline = true;
    v.className = "share-video";
    v.addEventListener("error", () => this.end(`🖥️ Paylaşım oynatılamadı (${v.error?.message || v.error?.code}).`));
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        const m = JSON.parse(e.data) as { t: string; mime?: string };
        if (m.t === "init" && m.mime) this.init(m.mime);
        else if (m.t === "reset") {
          this.queue.push("reset");
          this.pump();
        }
        return;
      }
      this.queue.push(e.data as ArrayBuffer);
      this.queued += (e.data as ArrayBuffer).byteLength;
      // Kaynak hazır değilken bile sınırsız birikmesin (sıfırlama işaretine kadar)
      while (this.queued > 32 * 1024 * 1024 && this.queue.length > 1 && this.queue[0] !== "reset") this.queued -= (this.queue.shift() as ArrayBuffer).byteLength;
      this.pump();
    };
    // 4000: paylaşım bitti, 4004: paylaşım yok; diğerleri beklenmedik kopma
    this.ws.onclose = (e) => this.end(undefined, e.code !== 4000 && e.code !== 4004);
    this.timer = window.setInterval(() => this.chase(), 500);
  }

  private init(mime: string): void {
    if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(mime)) {
      this.end("🖥️ Bu cihaz ekran paylaşımını oynatamıyor.");
      return;
    }
    const ms = (this.ms = new MediaSource());
    this.video.src = URL.createObjectURL(ms);
    ms.addEventListener(
      "sourceopen",
      () => {
        URL.revokeObjectURL(this.video.src);
        this.sb = ms.addSourceBuffer(mime);
        this.sb.addEventListener("updateend", () => this.pump());
        this.pump();
      },
      { once: true },
    );
  }

  private pump(): void {
    const sb = this.sb;
    if (!sb || sb.updating || !this.queue.length || this.ms?.readyState !== "open") return;
    if (this.queue[0] === "reset") {
      this.queue.shift();
      sb.abort(); // yarım kalmış elemanı unut; ardından başlık + anahtar kare gelir
    }
    // Sıradaki sıfırlamaya kadar birikenleri tek seferde ekle
    const cut = this.queue.indexOf("reset");
    const take = (cut < 0 ? this.queue : this.queue.slice(0, cut)) as ArrayBuffer[];
    if (!take.length) return this.pump();
    this.queue = cut < 0 ? [] : this.queue.slice(cut);
    let n = 0;
    for (const b of take) n += b.byteLength;
    this.queued -= n;
    let data: Uint8Array<ArrayBuffer>;
    if (take.length === 1) data = new Uint8Array(take[0]);
    else {
      data = new Uint8Array(n);
      let o = 0;
      for (const b of take) {
        data.set(new Uint8Array(b), o);
        o += b.byteLength;
      }
    }
    try {
      sb.appendBuffer(data);
    } catch (err) {
      // Kota doldu: eski kısmı silip bu parçayı atla (sonraki kümede toparlanır)
      if ((err as DOMException).name === "QuotaExceededError" && this.video.buffered.length) {
        sb.remove(0, Math.max(0, this.video.currentTime - 2));
      } else {
        this.end("🖥️ Paylaşım oynatılamadı.");
      }
    }
  }

  /** Canlı kenarı takip eder: geride kalınca ya da tampon dışındaysa en sona atlar. */
  private chase(): void {
    const v = this.video, b = v.buffered;
    if (!b.length) return;
    const last = b.length - 1;
    const end = b.end(last);
    const inside = Array.from({ length: b.length }, (_, i) => v.currentTime >= b.start(i) && v.currentTime <= b.end(i)).some(Boolean);
    if (!inside || end - v.currentTime > MAX_LAG) v.currentTime = Math.max(b.start(last), end - 0.4);
    if (v.paused) void v.play().catch(() => {});
    const sb = this.sb;
    if (sb && !sb.updating && v.currentTime - b.start(0) > KEEP_BEHIND * 2) sb.remove(b.start(0), v.currentTime - KEEP_BEHIND);
  }

  setMuted(m: boolean): void {
    this.video.muted = m;
    if (!m) void this.video.play().catch(() => {});
  }

  setVolume(v: number): void {
    this.video.volume = Math.min(1, Math.max(0, v));
  }

  private end(reason?: string, unexpected = false): void {
    if (this.closed) return;
    if (reason) console.warn("[share]", reason);
    this.destroy();
    this.onEnd(reason, unexpected);
  }

  destroy(): void {
    this.closed = true;
    window.clearInterval(this.timer);
    if (this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.remove();
  }
}
