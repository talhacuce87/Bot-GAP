// Fotoğraf modu (P): arayüz gizlenir, kamera daha uzağa açılır, filtre seçilir; çekilen kare önizlenir,
// Discord'daki fotoğraf kanalına gönderilir ya da indirilir.
import type { QuestDone } from "../../../shared/protocol";
import { iconHtml } from "./icons";
import { region } from "./layout";
import { button, el } from "./panel";
import { sfx } from "./sfx";

export const FILTERS = ["Normal", "Sıcak", "Soğuk", "Siyah-beyaz", "Sepya", "Nostalji"] as const;

export interface PhotoHost {
  /** Sahneyi çizip görüntüyü JPEG olarak verir. */
  capture(): Promise<Blob | null>;
  setFilter(i: number): void;
  /** Fotoğrafı sunucuya yollar (bot kanala atar). */
  upload(image: string): Promise<{ ok: boolean; error?: string; completed?: QuestDone[] }>;
  toast(text: string): void;
  quests(done: QuestDone[]): void;
}

const MAX_W = 1600;

export class PhotoMode {
  active = false;
  filter = 0;
  private bar: HTMLDivElement;
  private preview: HTMLDivElement;

  constructor(private root: HTMLElement, private host: PhotoHost) {
    this.bar = el("div", "photo-bar", region(root, "bc"));
    this.preview = el("div", "photo-preview", root);
  }

  toggle(): void {
    if (this.active) this.exit();
    else this.enter();
  }

  enter(): void {
    this.active = true;
    this.root.classList.add("photo-mode");
    this.renderBar();
  }

  exit(): void {
    this.active = false;
    this.root.classList.remove("photo-mode");
    this.preview.classList.remove("show");
    this.host.setFilter(0);
  }

  private renderBar(): void {
    const b = this.bar;
    b.replaceChildren();
    const filters = el("div", "settings-seg", b);
    FILTERS.forEach((name, i) => {
      button(filters, name, () => {
        this.filter = i;
        this.host.setFilter(i);
        this.renderBar();
      }, i === this.filter ? "active" : "");
    });
    button(b, "", () => void this.shoot(), "primary photo-shoot").innerHTML = `${iconHtml("camera")}<span>Çek</span>`;
    button(b, "", () => this.exit()).innerHTML = `${iconHtml("close")}<span>Çık</span>`;
    el("div", "photo-hint", b, "Sürükle: kamerayı çevir · tekerlek/iki parmak: yakınlaştır · 1–6 emote · P: çık");
    this.host.setFilter(this.filter);
  }

  private async shoot(): Promise<void> {
    sfx.shutter();
    const blob = await this.host.capture();
    if (!blob) return this.host.toast("📸 Fotoğraf çekilemedi.");
    const url = URL.createObjectURL(blob);
    const p = this.preview;
    p.replaceChildren();
    const img = el("img", "photo-img", p);
    img.src = url;
    img.alt = "Çekilen fotoğraf";
    const row = el("div", "bg-actions", p);
    const send = button(row, "Discord'a gönder", () => {
      send.disabled = true;
      send.textContent = "Gönderiliyor…";
      void blobToBase64(blob).then(async (b64) => {
        const r = await this.host.upload(b64);
        if (r.ok) {
          this.host.toast("📸 Fotoğraf Discord'a gönderildi!");
          if (r.completed?.length) this.host.quests(r.completed);
          p.classList.remove("show");
        } else {
          this.host.toast(`📸 ${r.error ?? "Gönderilemedi."}`);
          send.disabled = false;
          send.textContent = "Discord'a gönder";
        }
      });
    }, "primary");
    const save = el("a", "photo-save", row, "İndir");
    save.href = url;
    save.download = `gap-dunyasi-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jpg`;
    button(row, "Kapat", () => {
      p.classList.remove("show");
      URL.revokeObjectURL(url);
    });
    p.classList.add("show");
  }
}

/**
 * WebGL tuvalini çizimin hemen ardından (aynı görevde) 2B tuvale kopyalar: tampon sonra temizlenir.
 * Büyük ekranlarda küçültülür (Discord sınırı, hız).
 */
export function canvasToJpeg(src: HTMLCanvasElement): Promise<Blob | null> {
  const c = document.createElement("canvas");
  const w = Math.min(src.width, MAX_W);
  c.width = w;
  c.height = Math.round((src.height / src.width) * w);
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), "image/jpeg", 0.88));
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}
