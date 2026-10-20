// Kaynak başına oynatıcı bağlantısı: YouTube, Twitch, Kick ve doğrudan video dosyası.
// Hepsi aynı arayüzü sunar; senkron mantığı (sync.ts) hangi kaynak olduğunu bilmez.
import type { Source } from "../../../shared/media";

export interface MediaPlayer {
  /** Oynat/durdur/sar destekleniyor mu (Kick'in gömülü oynatıcısında API yok). */
  readonly controllable: boolean;
  play(): void;
  pause(): void;
  seek(t: number): void;
  /** Saniye; bilinmiyorsa NaN. */
  time(): number;
  /** Saniye; canlıda ya da bilinmiyorsa NaN. */
  duration(): number;
  isPlaying(): boolean;
  /** 0..1 */
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Harici betik yükleyici (her biri bir kez)
// ---------------------------------------------------------------------------

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`yüklenemedi: ${src}`));
      document.head.append(s);
    });
    scripts.set(src, p);
  }
  return p;
}

function hmsParam(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
}

// ---------------------------------------------------------------------------
// YouTube (IFrame Player API)
// ---------------------------------------------------------------------------

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(t: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer; PlayerState: { PLAYING: number; BUFFERING: number } };
    onYouTubeIframeAPIReady?: () => void;
    Twitch?: { Player: new (el: HTMLElement, opts: unknown) => TwitchPlayer };
  }
}

let ytReady: Promise<void> | null = null;
function loadYouTube(): Promise<void> {
  ytReady ??= new Promise<void>((resolve) => {
    if (window.YT?.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    void loadScript("https://www.youtube.com/iframe_api");
  });
  return ytReady;
}

class YouTubePlayer implements MediaPlayer {
  readonly controllable = true;
  private p: YTPlayer | null = null;
  private volume = 100;
  private muted = true;

  constructor(host: HTMLElement, id: string, start: number) {
    const el = document.createElement("div");
    host.append(el);
    void loadYouTube().then(() => {
      this.p = new window.YT!.Player(el, {
        videoId: id,
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, start: Math.floor(start) },
        events: {
          onReady: () => {
            this.p?.setVolume(this.volume);
            if (!this.muted) this.p?.unMute();
          },
        },
      });
    });
  }

  private ok(): YTPlayer | null {
    return this.p && typeof this.p.getCurrentTime === "function" ? this.p : null;
  }

  play(): void {
    this.ok()?.playVideo();
  }
  pause(): void {
    this.ok()?.pauseVideo();
  }
  seek(t: number): void {
    this.ok()?.seekTo(t, true);
  }
  time(): number {
    return this.ok()?.getCurrentTime() ?? Number.NaN;
  }
  duration(): number {
    return this.ok()?.getDuration() || Number.NaN;
  }
  isPlaying(): boolean {
    const s = this.ok()?.getPlayerState();
    return s === window.YT?.PlayerState.PLAYING || s === window.YT?.PlayerState.BUFFERING;
  }
  setVolume(v: number): void {
    this.volume = Math.round(v * 100);
    this.ok()?.setVolume(this.volume);
  }
  setMuted(m: boolean): void {
    this.muted = m;
    if (m) this.ok()?.mute();
    else this.ok()?.unMute();
  }
  destroy(): void {
    this.p?.destroy();
  }
}

// ---------------------------------------------------------------------------
// Twitch (Embed Player API) — kanal (canlı) ya da video (VOD)
// ---------------------------------------------------------------------------

interface TwitchPlayer {
  play(): void;
  pause(): void;
  seek(t: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  isPaused(): boolean;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
}

class TwitchEmbed implements MediaPlayer {
  readonly controllable = true;
  private p: TwitchPlayer | null = null;
  private host: HTMLElement;

  constructor(host: HTMLElement, opts: { channel?: string; video?: string; start?: number }) {
    this.host = document.createElement("div");
    this.host.style.cssText = "width:100%;height:100%";
    host.append(this.host);
    void loadScript("https://player.twitch.tv/js/embed/v1.js").then(() => {
      this.p = new window.Twitch!.Player(this.host, {
        width: "100%",
        height: "100%",
        channel: opts.channel,
        video: opts.video,
        time: opts.video ? hmsParam(opts.start ?? 0) : undefined,
        parent: [location.hostname],
        autoplay: true,
        muted: true,
      });
    });
  }

  play(): void {
    this.p?.play();
  }
  pause(): void {
    this.p?.pause();
  }
  seek(t: number): void {
    this.p?.seek(t);
  }
  time(): number {
    return this.p?.getCurrentTime() ?? Number.NaN;
  }
  duration(): number {
    return this.p?.getDuration() || Number.NaN;
  }
  isPlaying(): boolean {
    return this.p ? !this.p.isPaused() : false;
  }
  setVolume(v: number): void {
    this.p?.setVolume(v);
  }
  setMuted(m: boolean): void {
    this.p?.setMuted(m);
  }
  destroy(): void {
    this.host.remove();
  }
}

// ---------------------------------------------------------------------------
// Kick: herkese açık bir oynatıcı API'si yok; canlı olduğu için senkron da gerekmez.
// ---------------------------------------------------------------------------

class KickEmbed implements MediaPlayer {
  readonly controllable = false;
  private frame: HTMLIFrameElement;
  private muted = true;

  constructor(
    host: HTMLElement,
    private channel: string,
  ) {
    this.frame = document.createElement("iframe");
    this.frame.src = this.src(true);
    this.frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
    host.append(this.frame);
  }

  private src(muted: boolean): string {
    return `https://player.kick.com/${encodeURIComponent(this.channel)}?autoplay=true&muted=${muted}`;
  }

  play(): void {}
  pause(): void {}
  seek(): void {}
  time(): number {
    return Number.NaN;
  }
  duration(): number {
    return Number.NaN;
  }
  isPlaying(): boolean {
    return true;
  }
  setVolume(): void {}
  /**
   * Kick oynatıcısının API'si yok: sesi açmak için oynatıcı sesli parametreyle yeniden yüklenir.
   * "İzlemeye başla" tıklamasından sonra çağrıldığı için tarayıcı sesli oynatmaya izin verir
   * (iframe'e allow="autoplay" ile devredilir). Canlı yayında yeniden yükleme bir şey kaybettirmez.
   */
  setMuted(m: boolean): void {
    if (m || !this.muted) return;
    this.muted = false;
    this.frame.src = this.src(false);
  }
  destroy(): void {
    this.frame.remove();
  }
}

// ---------------------------------------------------------------------------
// Doğrudan dosya: <video>, .m3u8 için Safari'de yerel HLS, diğerlerinde hls.js (ayrı chunk)
// ---------------------------------------------------------------------------

class FilePlayer implements MediaPlayer {
  readonly controllable = true;
  private v: HTMLVideoElement;
  private hls: { destroy(): void } | null = null;

  constructor(host: HTMLElement, url: string, hls: boolean) {
    const v = document.createElement("video");
    v.playsInline = true;
    v.muted = true;
    v.autoplay = true;
    v.preload = "auto";
    host.append(v);
    this.v = v;
    if (hls && !v.canPlayType("application/vnd.apple.mpegurl")) {
      void import("hls.js").then(({ default: Hls }) => {
        if (!Hls.isSupported()) return;
        const h = new Hls({ maxBufferLength: 30 });
        h.loadSource(url);
        h.attachMedia(v);
        this.hls = h;
      });
    } else {
      v.src = url;
    }
  }

  play(): void {
    void this.v.play().catch(() => {});
  }
  pause(): void {
    this.v.pause();
  }
  seek(t: number): void {
    this.v.currentTime = t;
  }
  time(): number {
    return this.v.currentTime;
  }
  duration(): number {
    return Number.isFinite(this.v.duration) ? this.v.duration : Number.NaN;
  }
  isPlaying(): boolean {
    return !this.v.paused && !this.v.ended;
  }
  setVolume(v: number): void {
    this.v.volume = v;
  }
  setMuted(m: boolean): void {
    this.v.muted = m;
  }
  destroy(): void {
    this.hls?.destroy();
    this.v.removeAttribute("src");
    this.v.load();
    this.v.remove();
  }
}

export function createPlayer(host: HTMLElement, s: Source): MediaPlayer {
  switch (s.kind) {
    case "youtube":
      return new YouTubePlayer(host, s.id, s.start);
    case "twitch":
      return new TwitchEmbed(host, { channel: s.channel });
    case "twitch-vod":
      return new TwitchEmbed(host, { video: s.video, start: s.start });
    case "kick":
      return new KickEmbed(host, s.channel);
    case "file":
      return new FilePlayer(host, s.url, s.hls);
  }
}
