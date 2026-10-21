// Hızlı yol: konum mesajları ve snapshot'lar WebRTC veri kanalından (UDP, sırasız, yeniden göndermesiz).
// TCP'de kaybolan paket arkasındakileri de bekletir (takılma); burada kaybolan atlanır, sıradaki zaten daha yeni.
// Sinyalleşme oyun WebSocket'inden. Sunucu tek UDP portunda dinler (mux) ve adaylarını genel IP'siyle duyurur:
// konteyner yalnızca kendi iç IP'sini görür. UDP alan adının vekilinden (Cloudflare) geçmez, doğrudan sunucuya gider.
// Kurulamazsa ya da kapanırsa her şey WebSocket'ten devam eder.
import type { DataChannel, PeerConnection } from "node-datachannel";
import type { ServerEvent } from "../../shared/protocol";

type Ndc = typeof import("node-datachannel");

/** Kanalda bundan fazla bekleyen varsa snapshot atlanır (yavaş istemci; sıradaki zaten daha yeni). */
const MAX_BUFFERED = 64 * 1024;
/** Teklif SDP'si bundan uzun olamaz (oyun WebSocket'inin mesaj sınırı zaten 4 KB). */
const MAX_SDP = 4096;
const HOST_UDP4 = /(candidate:\S+ \d+ UDP \d+ )\d{1,3}(?:\.\d{1,3}){3}( \d+ typ host)/gi;
const IS_HOST_UDP4 = / UDP \d+ \d{1,3}(?:\.\d{1,3}){3} \d+ typ host/i;

/** Adaylardaki ve SDP'deki iç IPv4 adresini genel IP'yle değiştirir. */
export function announce(text: string, ip: string): string {
  return text.replace(HOST_UDP4, `$1${ip}$2`).replace(/^c=IN IP4 \S+/gm, `c=IN IP4 ${ip}`);
}

export class Rtc {
  constructor(
    private ndc: Ndc,
    readonly port: number,
    readonly ip: string,
  ) {}

  /** Bir oyuncu bağlantısının hızlı yolu. `signal`: WebSocket'ten olay, `onBinary`: kanaldan gelen ikili mesaj. */
  link(signal: (ev: ServerEvent) => void, onBinary: (buf: Buffer) => void): FastLink {
    return new FastLink(this.ndc, this.port, this.ip, signal, onBinary);
  }
}

/**
 * Sunucunun genel IP'si, STUN'a sorularak: alan adı Cloudflare gibi bir vekilin arkasındaysa DNS kaydı
 * vekilin IP'sini verir, işe yaramaz. Bulunamazsa boş.
 */
function discoverIp(ndc: Ndc, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    const pc = new ndc.PeerConnection("stun", { iceServers: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] });
    const finish = (ip: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.close();
      resolve(ip);
    };
    const timer = setTimeout(() => finish(""), timeoutMs);
    pc.onLocalCandidate((c) => {
      const m = / UDP \d+ (\d{1,3}(?:\.\d{1,3}){3}) \d+ typ srflx/i.exec(c);
      if (m) finish(m[1]);
    });
    // Aday toplamayı başlatır (dinleyici önce kaydedilmeli)
    pc.createDataChannel("probe");
  });
}

/**
 * Hızlı yolu hazırlar; `port` 0 ise kapalı. Genel IP `ip`, boşsa STUN'la öğrenilir.
 * Yerel kütüphane yüklenemez ya da IP bulunamazsa kapalı kalır (her şey WebSocket'ten).
 */
export async function setupRtc(port: number, ip: string): Promise<Rtc | null> {
  if (!port) return null;
  try {
    const ndc = await import("node-datachannel");
    const addr = ip || (await discoverIp(ndc));
    if (!addr) throw new Error("genel IP bulunamadı (STUN'a ulaşılamadı; WORLD_RTC_IP ile belirt)");
    console.log(`[rtc] hızlı yol açık: udp ${addr}:${port}`);
    return new Rtc(ndc, port, addr);
  } catch (err) {
    console.warn("[rtc] hızlı yol kapalı:", (err as Error).message);
    return null;
  }
}

export class FastLink {
  private pc: PeerConnection | null = null;
  private dc: DataChannel | null = null;

  constructor(
    private ndc: Ndc,
    private port: number,
    private ip: string,
    private signal: (ev: ServerEvent) => void,
    private onBinary: (buf: Buffer) => void,
  ) {}

  get open(): boolean {
    return this.dc?.isOpen() ?? false;
  }

  /** İstemcinin teklifi; yeni teklif eskisini kapatır. */
  offer(sdp: unknown): void {
    this.close();
    if (typeof sdp !== "string" || sdp.length > MAX_SDP) return;
    const pc = new this.ndc.PeerConnection("gap", {
      iceServers: [],
      enableIceUdpMux: true,
      portRangeBegin: this.port,
      portRangeEnd: this.port,
    });
    this.pc = pc;
    // Dinleyiciler anlaşmadan önce kaydedilmeli: sonra kaydedilirse ilk cevap kaybolur
    pc.onLocalDescription((d) => {
      if (pc === this.pc) this.signal({ t: "rtc", sdp: announce(d, this.ip) });
    });
    pc.onLocalCandidate((c, mid) => {
      // İstemci adayları gerekmez: sunucu genel IP'de, bağlantıyı istemci başlatır, sunucu onu kontrollerden tanır
      if (pc === this.pc && IS_HOST_UDP4.test(c)) this.signal({ t: "rtcice", c: announce(c, this.ip).replace(/^a=/, ""), mid });
    });
    pc.onDataChannel((dc) => {
      if (pc !== this.pc || this.dc) return dc.close();
      this.dc = dc;
      dc.onMessage((m) => {
        if (typeof m !== "string") this.onBinary(Buffer.isBuffer(m) ? m : Buffer.from(m));
      });
      dc.onClosed(() => {
        if (this.dc === dc) this.dc = null;
      });
    });
    pc.onStateChange((s) => {
      if (pc === this.pc && (s === "failed" || s === "closed")) this.close();
    });
    try {
      pc.setRemoteDescription(sdp, "offer");
    } catch {
      this.close();
    }
  }

  /** Kanal açıksa gönderir (dolu kanalda bilerek atlar) ve true; kanal yoksa false: WebSocket'ten gitmeli. */
  send(data: Uint8Array): boolean {
    const dc = this.dc;
    if (!dc?.isOpen()) return false;
    if (dc.bufferedAmount() > MAX_BUFFERED) return true;
    try {
      dc.sendMessageBinary(data);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    const { pc, dc } = this;
    this.pc = null;
    this.dc = null;
    try {
      dc?.close();
      pc?.close();
    } catch {
      // zaten kapanmış
    }
  }
}
