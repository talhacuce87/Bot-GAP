// Hızlı yol (istemci): konum ve snapshot'lar sırasız, yeniden göndermesiz WebRTC veri kanalından (UDP).
// Sunucu "rtcon" derse kurulur; açılamazsa (UDP'yi engelleyen ağ) ya da kapanırsa her şey WebSocket'ten devam eder.
import type { ClientEvent } from "../../shared/protocol";

/** Bu sürede açılamazsa vazgeçilir; bu bağlantı WebSocket'le sürer. */
const OPEN_TIMEOUT_MS = 8000;
/** Kanalda bundan fazla bekleyen varsa konum atlanır (sıradaki zaten daha yeni). */
const MAX_BUFFERED = 16 * 1024;
/** Oyun WebSocket'i 4 KB'tan büyük mesajı kabul etmez (bağlantı kopar): sığmayan teklif gönderilmez. */
const MAX_SDP = 3500;

export class FastLink {
  private pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private timer: ReturnType<typeof setTimeout>;
  /** Sunucunun cevabı uygulandı: adaylar artık eklenebilir (öncesinde gelenler bekler). */
  private ready = false;
  private pending: RTCIceCandidateInit[] = [];
  private closed = false;

  constructor(
    private signal: (ev: ClientEvent) => void,
    onBinary: (data: ArrayBuffer) => void,
    private onClose: () => void = () => {},
  ) {
    // Sunucu genel IP'de: STUN/TURN gerekmez, bağlantıyı istemci başlatır
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.dc = this.pc.createDataChannel("pos", { ordered: false, maxRetransmits: 0 });
    this.dc.binaryType = "arraybuffer";
    this.dc.onopen = () => clearTimeout(this.timer);
    this.dc.onclose = () => this.close();
    this.dc.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) onBinary(e.data);
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "failed") this.close();
    };
    this.timer = setTimeout(() => {
      if (!this.open) this.close();
    }, OPEN_TIMEOUT_MS);
    void this.offer();
  }

  get open(): boolean {
    return !this.closed && this.dc.readyState === "open";
  }

  private async offer(): Promise<void> {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      if (!offer.sdp || offer.sdp.length > MAX_SDP) return this.close();
      if (!this.closed) this.signal({ t: "rtc", sdp: offer.sdp });
    } catch {
      this.close();
    }
  }

  async answer(sdp: string): Promise<void> {
    if (this.closed || this.ready) return;
    try {
      await this.pc.setRemoteDescription({ type: "answer", sdp });
      this.ready = true;
      for (const c of this.pending.splice(0)) await this.pc.addIceCandidate(c);
    } catch {
      this.close();
    }
  }

  candidate(candidate: string, sdpMid: string): void {
    if (this.closed) return;
    if (this.ready) this.pc.addIceCandidate({ candidate, sdpMid }).catch(() => {});
    else this.pending.push({ candidate, sdpMid });
  }

  /** Kanal açıksa gönderir (dolu kanalda bilerek atlar) ve true; değilse false: WebSocket'ten gitmeli. */
  send(data: ArrayBuffer): boolean {
    if (!this.open) return false;
    if (this.dc.bufferedAmount <= MAX_BUFFERED) this.dc.send(data);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    try {
      this.dc.close();
      this.pc.close();
    } catch {
      // zaten kapanmış
    }
    this.onClose();
  }
}
