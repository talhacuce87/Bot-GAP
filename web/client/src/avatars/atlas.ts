// İsim etiketleri için ortak canvas atlası (profil fotoğrafı dünyada gösterilmez).
// Her avatar bir hücre alır; GPU'ya sadece bir hücre değiştiğinde yükleme yapılır.
import * as THREE from "three";

export const ATLAS_CELLS = 128;
export const NAME_GRID: [number, number] = [8, 16]; // 2048×1024, 256×64 hücre

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
  readonly nameTex: THREE.CanvasTexture;
  private name: CanvasRenderingContext2D;
  private free: number[] = [];

  constructor() {
    const [nc, n] = makeCanvas(NAME_GRID[0] * NAME_W, NAME_GRID[1] * NAME_H);
    this.name = n;
    this.nameTex = makeTexture(nc);
    for (let i = ATLAS_CELLS - 1; i >= 0; i--) this.free.push(i);
  }

  /** Bir hücre ayırır; dolduysa -1 (avatar isimsiz çizilir). */
  alloc(name: string, jailed = false): number {
    const cell = this.free.pop();
    if (cell === undefined) return -1;
    this.drawName(cell, name, jailed);
    return cell;
  }

  release(cell: number): void {
    if (cell >= 0) this.free.push(cell);
  }

  /** İsim etiketini yeniden çizer (ör. sürgün durumu değişince). */
  setName(cell: number, text: string, jailed: boolean): void {
    if (cell >= 0) this.drawName(cell, text, jailed);
  }

  private drawName(cell: number, text: string, jailed = false): void {
    const x = (cell % NAME_GRID[0]) * NAME_W;
    const y = Math.floor(cell / NAME_GRID[0]) * NAME_H;
    const g = this.name;
    g.clearRect(x, y, NAME_W, NAME_H);
    g.font = "600 31px Barlow, system-ui, sans-serif";
    let label = text;
    while (label.length > 1 && g.measureText(label).width > NAME_W - 28) label = label.slice(0, -1);
    if (label !== text) label = `${label.slice(0, -1)}…`;
    const w = Math.min(NAME_W - 4, g.measureText(label).width + 24);
    const cx = x + NAME_W / 2;
    g.fillStyle = jailed ? "rgba(150, 28, 28, 0.85)" : "rgba(10, 14, 20, 0.72)";
    g.beginPath();
    g.roundRect(cx - w / 2, y + 10, w, NAME_H - 20, (NAME_H - 20) / 2);
    g.fill();
    g.fillStyle = "#f2efe8";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, cx, y + NAME_H / 2 + 1);
    this.nameTex.needsUpdate = true;
  }
}
