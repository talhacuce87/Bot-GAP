// Ekran paylaşan taraf: ekran (ve varsa sekme/sistem sesi) MediaRecorder ile WebM'e kodlanır,
// 200 ms'lik parçalar sırasıyla sunucuya gider. Sunucu odadaki herkese dağıtır.

const CHUNK_MS = 200;
/** Gönderim kuyruğu bunu aşarsa yükleme hızı yetmiyor demektir: paylaşım durur. */
const MAX_BUFFERED = 16 * 1024 * 1024;

function pickMime(audio: boolean): string {
  const list = audio ? ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"] : ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

export class ScreenSender {
  /** Paylaşım bitti; `reason` kullanıcıya gösterilir (kendisi durdurduysa yok). */
  onStop: (reason?: string) => void = () => {};
  private ws: WebSocket;
  private rec: MediaRecorder;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  static supported(): boolean {
    return !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined" && typeof WebSocket !== "undefined";
  }

  /** Tarayıcının ekran seçme penceresi (kullanıcı tıklamasıyla çağrılmalı). */
  static capture(): Promise<MediaStream> {
    return navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: true,
    });
  }

  constructor(
    private stream: MediaStream,
    url: string,
  ) {
    const audio = stream.getAudioTracks().length > 0;
    this.rec = new MediaRecorder(stream, {
      mimeType: pickMime(audio),
      videoBitsPerSecond: 3_000_000,
      audioBitsPerSecond: 128_000,
      // Sık anahtar kare: sonradan gelen en fazla ~2 sn bekler (destekleyen tarayıcıda)
      videoKeyFrameIntervalDuration: 2000,
    } as MediaRecorderOptions);
    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      // Parçalar sırayla gitmeli: arrayBuffer() zinciri sırayı korur
      this.chain = this.chain.then(async () => {
        const buf = await e.data.arrayBuffer();
        if (this.ws.readyState !== WebSocket.OPEN) return;
        if (this.ws.bufferedAmount > MAX_BUFFERED) return this.stop("📶 İnternetin paylaşım için yetmiyor, paylaşım durdu.");
        this.ws.send(buf);
      });
    };
    for (const t of stream.getTracks()) t.addEventListener("ended", () => this.stop()); // tarayıcının "Paylaşımı durdur" düğmesi
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this.ws.send(JSON.stringify({ t: "start", mime: this.rec.mimeType || pickMime(audio) }));
    this.ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data) as { t: string; name?: string };
      if (m.t === "started") this.rec.start(CHUNK_MS);
      else if (m.t === "busy") this.stop(`🖥️ Şu an ${m.name} ekranını paylaşıyor.`);
    };
    this.ws.onclose = (e) => this.stop(e.code === 4008 ? "📶 Paylaşım çok yüksek hızda, durduruldu." : e.code === 4009 || e.code === 4000 ? undefined : "🖥️ Paylaşım bağlantısı koptu.");
  }

  get hasAudio(): boolean {
    return this.stream.getAudioTracks().length > 0;
  }

  stop(reason?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.rec.state !== "inactive") this.rec.stop();
    for (const t of this.stream.getTracks()) t.stop();
    if (this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    this.onStop(reason);
  }
}
