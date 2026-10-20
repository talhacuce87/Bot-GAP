// Activity'de sinema perdesi: video burada oynatılamaz (Discord, YouTube/Twitch/Kick'in video
// sunucularına erişimi engeller), bu yüzden perde "Şimdi oynuyor" tabelasına döner: küçük resim,
// başlık ve herkesle aynı süre. Video tarayıcıdaki izleme odasında oynar; ikisi aynı odadır.
import * as THREE from "three";
import { isLive } from "../../../shared/media";
import type { WatchState } from "../../../shared/protocol";

const W = 1024;
const H = 576;

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "--:--";
  const s = Math.floor(t);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Metni en fazla `lines` satıra böler, taşanı … ile keser. */
function wrap(g: CanvasRenderingContext2D, text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width <= width) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    line = word;
    if (out.length === lines) break;
  }
  if (out.length < lines && line) out.push(line);
  if (out.length > lines) out.length = lines;
  const last = out.length - 1;
  if (last >= 0 && out.join(" ").length < text.length) {
    while (out[last].length > 1 && g.measureText(`${out[last]}…`).width > width) out[last] = out[last].slice(0, -1);
    out[last] += "…";
  }
  return out;
}

export class CinemaSign {
  private canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private material: THREE.MeshBasicMaterial;
  private original: THREE.Material | THREE.Material[];
  private state: WatchState | null = null;
  private thumb: HTMLImageElement | null = null;
  private thumbKey = "";
  private lastDraw = 0;
  /** Ekran paylaşımı perdeyi kullanırken tabela perdeye dokunmaz. */
  private suspended = false;

  constructor(
    private screen: THREE.Mesh,
    /** API öneki ("/.proxy" Activity'de): küçük resim aynı origin'den gelir. */
    private base: string,
  ) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    this.material = new THREE.MeshBasicMaterial({ map: this.tex, fog: false });
    this.original = screen.material;
  }

  /** Sunucudan gelen sinema durumu; kaynak yoksa perde eski tabelasına döner. */
  set(state: WatchState | null): void {
    this.state = state?.source ? state : null;
    if (!this.suspended) this.screen.material = this.state ? this.material : this.original;
    const yt = this.state?.source?.kind === "youtube" ? this.state.source.id : "";
    if (yt !== this.thumbKey) {
      this.thumbKey = yt;
      this.thumb = null;
      if (yt) {
        const img = new Image();
        img.onload = () => {
          if (this.thumbKey === yt) {
            this.thumb = img;
            this.lastDraw = 0;
          }
        };
        img.src = `${this.base}/thumb/${yt}`;
      }
    }
    this.lastDraw = 0;
  }

  suspend(on: boolean): void {
    this.suspended = on;
    if (!on) this.screen.material = this.state ? this.material : this.original;
  }

  /** Saniyede bir yeniden çizer (süre ilerlesin). `serverNow`: sunucu saati (ms). */
  update(serverNow: number): void {
    const s = this.state;
    if (!s || serverNow - this.lastDraw < 1000) return;
    this.lastDraw = serverNow;
    const g = this.g;
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#141c30");
    grad.addColorStop(1, "#2c1f45");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    let x = 60;
    if (this.thumb) {
      g.drawImage(this.thumb, 50, 128, 448, 252);
      x = 530;
    }
    const width = W - x - 50;
    g.textAlign = "left";
    g.fillStyle = "#9fb0ff";
    g.font = "700 30px system-ui, sans-serif";
    g.fillText("🎬 ŞİMDİ OYNUYOR", x, 130);
    g.fillStyle = "#ffffff";
    g.font = "700 44px system-ui, sans-serif";
    const lines = wrap(g, s.title || "Video", width, 3);
    lines.forEach((l, i) => g.fillText(l, x, 196 + i * 54));

    const live = s.source ? isLive(s.source) : false;
    const pos = s.playing ? s.position + (serverNow - s.updatedAt) / 1000 : s.position;
    g.font = "600 34px system-ui, sans-serif";
    g.fillStyle = live ? "#ff6b6b" : "#c9cffd";
    g.fillText(live ? "● CANLI" : `${s.playing ? "▶" : "⏸"} ${fmt(pos)}`, x, 196 + lines.length * 54 + 24);

    g.textAlign = "center";
    g.fillStyle = "#c9cffd";
    g.font = "500 28px system-ui, sans-serif";
    g.fillText("İzlemek için: üstteki 🍿 Tarayıcıda izle — burada herkesle aynı odadasın", W / 2, H - 46);
    this.tex.needsUpdate = true;
  }
}
