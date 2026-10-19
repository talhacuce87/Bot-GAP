// Yüz (profil fotoğrafı) ve isim etiketleri için iki ortak canvas atlası.
// Her avatar bir hücre alır; GPU'ya sadece bir hücre değiştiğinde yükleme yapılır.
import * as THREE from "three";

export const ATLAS_CELLS = 128;
export const FACE_GRID: [number, number] = [16, 8]; // 1024×512, 64px hücre
export const NAME_GRID: [number, number] = [8, 16]; // 2048×1024, 256×64 hücre

const FACE_PX = 64;
const NAME_W = 256;
const NAME_H = 64;

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function makeTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

export class AvatarAtlas {
  readonly faceTex: THREE.CanvasTexture;
  readonly nameTex: THREE.CanvasTexture;
  private face: CanvasRenderingContext2D;
  private name: CanvasRenderingContext2D;
  private free: number[] = [];
  /** Hücre başına sürüm: geç yüklenen bir resim, hücre başkasına geçtiyse çizilmez. */
  private version = new Uint32Array(ATLAS_CELLS);

  constructor(private avatarUrl: (id: string, hash: string) => string) {
    const [fc, f] = makeCanvas(FACE_GRID[0] * FACE_PX, FACE_GRID[1] * FACE_PX);
    const [nc, n] = makeCanvas(NAME_GRID[0] * NAME_W, NAME_GRID[1] * NAME_H);
    this.face = f;
    this.name = n;
    this.faceTex = makeTexture(fc);
    this.nameTex = makeTexture(nc);
    for (let i = ATLAS_CELLS - 1; i >= 0; i--) this.free.push(i);
  }

  /** Bir hücre ayırır; dolduysa -1 (avatar yüzsüz ve isimsiz çizilir). */
  alloc(id: string, name: string, avatar: string | null, color: THREE.Color): number {
    const cell = this.free.pop();
    if (cell === undefined) return -1;
    const ver = ++this.version[cell];
    this.drawInitial(cell, name, color);
    this.drawName(cell, name);
    if (avatar && !id.startsWith("guest-")) {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (this.version[cell] !== ver) return;
        const [x, y] = this.faceOrigin(cell);
        this.face.clearRect(x, y, FACE_PX, FACE_PX);
        this.face.drawImage(img, x, y, FACE_PX, FACE_PX);
        this.faceTex.needsUpdate = true;
      };
      img.src = this.avatarUrl(id, avatar);
    }
    return cell;
  }

  release(cell: number): void {
    if (cell < 0) return;
    this.version[cell]++;
    this.free.push(cell);
  }

  private faceOrigin(cell: number): [number, number] {
    return [(cell % FACE_GRID[0]) * FACE_PX, Math.floor(cell / FACE_GRID[0]) * FACE_PX];
  }

  private drawInitial(cell: number, name: string, color: THREE.Color): void {
    const [x, y] = this.faceOrigin(cell);
    const g = this.face;
    g.fillStyle = `#${color.getHexString()}`;
    g.fillRect(x, y, FACE_PX, FACE_PX);
    g.fillStyle = "#ffffff";
    g.font = "700 34px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText((name.trim()[0] || "?").toLocaleUpperCase("tr"), x + FACE_PX / 2, y + FACE_PX / 2 + 2);
    this.faceTex.needsUpdate = true;
  }

  private drawName(cell: number, text: string): void {
    const x = (cell % NAME_GRID[0]) * NAME_W;
    const y = Math.floor(cell / NAME_GRID[0]) * NAME_H;
    const g = this.name;
    g.clearRect(x, y, NAME_W, NAME_H);
    g.font = "600 30px system-ui, sans-serif";
    let label = text;
    while (label.length > 1 && g.measureText(label).width > NAME_W - 28) label = label.slice(0, -1);
    if (label !== text) label = `${label.slice(0, -1)}…`;
    const w = Math.min(NAME_W - 4, g.measureText(label).width + 24);
    const cx = x + NAME_W / 2;
    g.fillStyle = "rgba(15, 20, 30, 0.7)";
    g.beginPath();
    g.roundRect(cx - w / 2, y + 10, w, NAME_H - 20, (NAME_H - 20) / 2);
    g.fill();
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, cx, y + NAME_H / 2 + 1);
    this.nameTex.needsUpdate = true;
  }
}
