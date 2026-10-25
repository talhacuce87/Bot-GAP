// 🗺️ Harita (U): dünyanın kuşbakışı, oyunun kendi verisinden çizilir (arazi, su, yollar, arsalar, yerler);
// yollar ya da arsalar değişince harita da kendiliğinden güncel kalır. Zemin katmanı ilk açılışta bir kez
// çizilir; üstünde her karede arsa sahipleri, oyuncular ve senin yerin (ok, baktığın yöne). Sürükle: kaydır,
// tekerlek ya da iki parmak: yakınlaştır. Işınlanılan odalar (stadyum, voleybol) haritada yok.
import { MOSQUE } from "../../../shared/mosque";
import { PB_FIELD } from "../../../shared/paintball";
import { CASINO, CAVE, CITY, FAME, GARAGE, GROVE, HALL, KAHVEHANE, LAKE, LINK_ROADS, PLAZA, RACE_HOUSE, ROAD_HALF, ROAD_PATH, SAKURA_SPOT, STAGE, STREETS, VILLAGE_ROAD_HALF, VILLAGE_ROADS, WATERFALL } from "../../../shared/zones";
import { HOOD_BOX, HOOD_PARK, HOOD_ROADS, HOOD_ROUNDABOUT, HOOD_SIDEWALK, HOOD_STREET_HALF, PLOTS } from "../../../shared/build";
import { WORLD_BOUNDS } from "../../../shared/constants";
import { RACE_AREA, TRACK, TRACK_HALF } from "../../../shared/ring";
import { TANK_PARK } from "../../../shared/tank";
import { actionLabel } from "../input/keybinds";
import { terrainHeight, walkable } from "../world/terrain";
import { button, el, Panel } from "./panel";

/** Haritanın kapsadığı dünya (ışınlanılan odalar dışında): mahalleden şehrin doğu kenarına. */
const AREA = {
  minX: HOOD_BOX.minX - 24,
  maxX: CITY.maxX + 24,
  minZ: Math.min(RACE_AREA.minZ, HOOD_BOX.minZ, WORLD_BOUNDS.minZ) - 24,
  maxZ: Math.max(WORLD_BOUNDS.maxZ, HOOD_BOX.maxZ) + 24,
};
/** Zemin katmanının çözünürlüğü (piksel / m) ve arazi örnekleme aralığı (m). */
const PX = 2;
const SAMPLE = 2;

const COLORS = {
  hill: "#a99b7f",
  peak: "#867a68",
  grass: "#96b86e",
  water: "#4a86c5",
  side: "#b8b1a2",
  asphalt: "#3a3c42",
  line: "#f0c43c",
  plot: "#c6df98",
  plotEdge: "#7f9a52",
  paved: "#cfcabd",
  building: "#d7cfbe",
  label: "#1f2226",
  halo: "rgba(250, 248, 240, 0.92)",
};

/** Yer adları (dünya koordinatı). */
const PLACES: [string, number, number][] = [
  ["Meydan", PLAZA.x, PLAZA.z],
  ["Kahvehane", KAHVEHANE.x, KAHVEHANE.z],
  ["Göl", LAKE.x, LAKE.z],
  ["Sinema", STAGE.x, STAGE.z - 6],
  ["Kapalı saha", HALL.x, HALL.z],
  ["Sakura", SAKURA_SPOT.x, SAKURA_SPOT.z],
  ["Tank", TANK_PARK.x, TANK_PARK.z],
  ["Oyuncak pist", RACE_HOUSE.x, RACE_HOUSE.z],
  ["Paintball", PB_FIELD.x, PB_FIELD.z],
  ["Mangal", GROVE.x, GROVE.z],
  ["Şöhret kürsüsü", FAME.x, FAME.z],
  ["Şelale", WATERFALL.x, WATERFALL.z],
  ["Zindan", CAVE.x, CAVE.z],
  ["Casino", CASINO.x, CASINO.z],
  ["GAP Garaj", GARAGE.x + 10, GARAGE.z - 4],
  ["GAP Şehri", (CITY.minX + CITY.maxX) / 2, CITY.minZ + 12],
  ["GAP Ring", (RACE_AREA.minX + RACE_AREA.maxX) / 2, (RACE_AREA.minZ + RACE_AREA.maxZ) / 2],
  ["Mahalle", (HOOD_BOX.minX + HOOD_BOX.maxX) / 2, HOOD_BOX.minZ + 4],
  ["Park", HOOD_PARK.x, HOOD_PARK.z - 32],
  ["GAP Camii", MOSQUE.x, MOSQUE.z],
];

export interface MapPlayer {
  x: number;
  z: number;
  name: string;
}

export interface WorldMapHost {
  /** Senin konumun ve yönün (rot: avatarın baktığı açı). */
  me(): { x: number; z: number; rot: number };
  /** Diğer oyuncular (konumu bilinenler). */
  others(): Iterable<MapPlayer>;
  /** Arsa sahiplerinin adları (arsa dizinine göre; boşsa null). */
  owner(plot: number): string | null;
  /** İş hedefi ve taksi çağrıları gibi işaretler. */
  marks?(): Iterable<{ x: number; z: number; label: string; color: string }>;
}

export class WorldMap {
  private panel: Panel;
  private canvas: HTMLCanvasElement;
  private base: HTMLCanvasElement | null = null;
  /** Arazi örneklemesi: oyun açıldıktan sonra boş anlarda parça parça (açılışta takılma olmasın). */
  private terrain = new TerrainRaster();
  /** Görünüm: dünya → ekran (piksel / m ve kayma). */
  private view = { s: 1, x: 0, y: 0 };
  private fitted = false;
  private raf = 0;
  private pointers = new Map<number, [number, number]>();
  private pinch = 0;

  constructor(root: HTMLElement, touch: boolean, private host: WorldMapHost) {
    const b = el("button", "wardrobe-btn map-btn", root, "🗺️");
    b.title = touch ? "Harita" : `Harita (${actionLabel("map")})`;
    b.addEventListener("click", () => this.toggle());
    this.panel = new Panel(root, "HARİTA", "map-panel");
    this.panel.onClose = () => cancelAnimationFrame(this.raf);
    this.canvas = el("canvas", "map-canvas", this.panel.body);
    const bar = el("div", "map-bar", this.panel.body);
    button(bar, "📍 Ben", () => this.centerOnMe());
    button(bar, "⤢ Tümü", () => this.fit());
    button(bar, "+", () => this.zoomAt(1.4));
    button(bar, "−", () => this.zoomAt(1 / 1.4));
    el("span", "map-hint", bar, touch ? "Sürükle: kaydır · İki parmak: yakınlaştır" : "Sürükle: kaydır · Tekerlek: yakınlaştır");
    this.listen();
    this.terrain.prepareInBackground();
  }

  /**
   * Minimap için zemin katmanı (arazi arka planda hazırlandıysa; yoksa null) ve dünya → piksel dönüşümü.
   * Haritayla aynı katman: bir kez çizilir.
   */
  minimapBase(): { canvas: HTMLCanvasElement; minX: number; minZ: number; px: number } | null {
    if (!this.base) {
      if (!this.terrain.done) return null;
      this.base = drawBase(this.terrain.finish());
    }
    return { canvas: this.base, minX: AREA.minX, minZ: AREA.minZ, px: PX };
  }

  toggle(): void {
    if (this.panel.isOpen) return this.panel.close();
    this.panel.open();
    // İlk açılış: zemin katmanı bir kez (arazi çoğunlukla arka planda hazırlanmış olur), sonra hep hazır
    this.base ??= drawBase(this.terrain.finish());
    if (!this.fitted) {
      this.fitted = true;
      this.resize();
      this.fit();
    }
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  private fit(): void {
    const w = this.canvas.width, h = this.canvas.height;
    const s = Math.min(w / (AREA.maxX - AREA.minX), h / (AREA.maxZ - AREA.minZ));
    this.view = { s, x: (w - (AREA.maxX - AREA.minX) * s) / 2, y: (h - (AREA.maxZ - AREA.minZ) * s) / 2 };
  }

  private centerOnMe(): void {
    const m = this.host.me(), s = Math.max(this.view.s, (this.canvas.width / (AREA.maxX - AREA.minX)) * 4);
    this.view = { s, x: this.canvas.width / 2 - (m.x - AREA.minX) * s, y: this.canvas.height / 2 - (m.z - AREA.minZ) * s };
  }

  private zoomAt(k: number, cx = this.canvas.width / 2, cy = this.canvas.height / 2): void {
    const min = Math.min(this.canvas.width / (AREA.maxX - AREA.minX), this.canvas.height / (AREA.maxZ - AREA.minZ)) * 0.8;
    const s = Math.min(14, Math.max(min, this.view.s * k));
    this.view = { s, x: cx - (cx - this.view.x) * (s / this.view.s), y: cy - (cy - this.view.y) * (s / this.view.s) };
  }

  private listen(): void {
    const c = this.canvas;
    const local = (e: { clientX: number; clientY: number }): [number, number] => {
      const r = c.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
    };
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, ...local(e));
    }, { passive: false });
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, local(e));
    });
    c.addEventListener("pointermove", (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const now = local(e);
      this.pointers.set(e.pointerId, now);
      if (this.pointers.size === 1) {
        this.view.x += now[0] - prev[0];
        this.view.y += now[1] - prev[1];
        return;
      }
      const [a, b] = [...this.pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (this.pinch) this.zoomAt(d / this.pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      this.pinch = d;
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.pinch = 0;
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    addEventListener("resize", () => {
      if (!this.panel.isOpen) return;
      this.resize();
      this.fit();
    });
  }

  /** Her kare (panel açıkken): zemin, arsa sahipleri, oyuncular. */
  private draw(): void {
    const g = this.canvas.getContext("2d");
    if (!g || !this.base) return;
    const { s, x, y } = this.view, k = s / PX;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = COLORS.peak;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.imageSmoothingEnabled = k < 2;
    g.drawImage(this.base, x, y, this.base.width * k, this.base.height * k);
    const X = (wx: number) => x + (wx - AREA.minX) * s, Z = (wz: number) => y + (wz - AREA.minZ) * s;
    const dpr = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width);
    const text = (t: string, px: number, py: number, size: number, weight = 700) => {
      g.font = `${weight} ${size * dpr}px system-ui, sans-serif`;
      g.lineWidth = 4 * dpr;
      g.strokeStyle = COLORS.halo;
      g.strokeText(t, px, py);
      g.fillStyle = COLORS.label;
      g.fillText(t, px, py);
    };
    g.textAlign = "center";
    g.textBaseline = "middle";
    // Arsalar: numara ve sahibi (yakınlaştıkça)
    for (const p of PLOTS) {
      const cx = X(p.x0 + p.size / 2), cz = Z(p.z0 + p.size / 2), name = this.host.owner(p.id);
      const big = p.size * s > 60 * dpr;
      text(`${p.id + 1}`, cx, big && name ? cz - 8 * dpr : cz, big ? 13 : 10);
      if (name && big) text(name, cx, cz + 8 * dpr, 11, 600);
      else if (name) {
        g.fillStyle = "#c9821f";
        g.beginPath();
        g.arc(cx, cz + 7 * dpr, 2.5 * dpr, 0, Math.PI * 2);
        g.fill();
      }
    }
    for (const [t, wx, wz] of PLACES) text(t, X(wx), Z(wz), 12);
    // Diğer oyuncular ve sen
    for (const o of this.host.others()) {
      g.fillStyle = "#3b6fd8";
      g.strokeStyle = "#ffffff";
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      g.arc(X(o.x), Z(o.z), 4 * dpr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (s > 2.5) text(o.name, X(o.x), Z(o.z) - 10 * dpr, 10, 600);
    }
    // İşaretler (iş hedefi: elmas ve adı)
    for (const k of this.host.marks?.() ?? []) {
      const px = X(k.x), pz = Z(k.z), q = 7 * dpr;
      g.fillStyle = k.color;
      g.strokeStyle = "#ffffff";
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.moveTo(px, pz - q);
      g.lineTo(px + q, pz);
      g.lineTo(px, pz + q);
      g.lineTo(px - q, pz);
      g.closePath();
      g.fill();
      g.stroke();
      text(k.label, px, pz - 16 * dpr, 11);
    }
    const m = this.host.me(), mx = X(m.x), mz = Z(m.z), r = 8 * dpr;
    // Ok: avatarın baktığı yöne (dünyada +z güney; rot 0 → +z)
    const fx = Math.sin(m.rot), fz = Math.cos(m.rot);
    g.fillStyle = "#e0412f";
    g.strokeStyle = "#ffffff";
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.moveTo(mx + fx * r, mz + fz * r);
    g.lineTo(mx - fx * r * 0.6 + fz * r * 0.6, mz - fz * r * 0.6 - fx * r * 0.6);
    g.lineTo(mx - fx * r * 0.25, mz - fz * r * 0.25);
    g.lineTo(mx - fx * r * 0.6 - fz * r * 0.6, mz - fz * r * 0.6 + fx * r * 0.6);
    g.closePath();
    g.fill();
    g.stroke();
  }
}

/** Arazinin renkleri örnekleme ızgarasında (RGBA). Satır satır, istenirse parça parça doldurulur. */
class TerrainRaster {
  readonly w = Math.ceil((AREA.maxX - AREA.minX) / SAMPLE);
  readonly h = Math.ceil((AREA.maxZ - AREA.minZ) / SAMPLE);
  readonly data = new Uint8ClampedArray(this.w * this.h * 4);
  private row = 0;

  /** Kare başına en çok ~4 ms: oyun akarken fark edilmez. */
  prepareInBackground(): void {
    const step = () => {
      const t0 = performance.now();
      while (this.row < this.h && performance.now() - t0 < 4) this.fillRow(this.row++);
      if (this.row < this.h) setTimeout(step, 50);
    };
    setTimeout(step, 5000);
  }

  get done(): boolean {
    return this.row >= this.h;
  }

  /** Kalan satırları hemen doldurur. */
  finish(): TerrainRaster {
    while (this.row < this.h) this.fillRow(this.row++);
    return this;
  }

  private fillRow(j: number): void {
    const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const hill = rgb(COLORS.hill), peak = rgb(COLORS.peak), grass = rgb(COLORS.grass), water = rgb(COLORS.water);
    for (let i = 0; i < this.w; i++) {
      const x = AREA.minX + (i + 0.5) * SAMPLE, z = AREA.minZ + (j + 0.5) * SAMPLE, h = terrainHeight(x, z);
      const c = walkable(x, z) ? grass : h < -0.05 ? water : h > 6 ? peak : hill;
      const o = (j * this.w + i) * 4;
      this.data[o] = c[0];
      this.data[o + 1] = c[1];
      this.data[o + 2] = c[2];
      this.data[o + 3] = 255;
    }
  }
}

/** Zemin katmanı: arazi (tepe, çimen, su), bölgeler, yollar, kavşak, gölet, arsalar. Bir kez çizilir. */
function drawBase(terrain: TerrainRaster): HTMLCanvasElement {
  // Arazi: örnekleme ızgarasında renk, sonra büyütülür
  const small = document.createElement("canvas");
  small.width = terrain.w;
  small.height = terrain.h;
  small.getContext("2d")!.putImageData(new ImageData(terrain.data, terrain.w, terrain.h), 0, 0);
  const base = document.createElement("canvas");
  base.width = Math.ceil((AREA.maxX - AREA.minX) * PX);
  base.height = Math.ceil((AREA.maxZ - AREA.minZ) * PX);
  const g = base.getContext("2d")!;
  g.imageSmoothingEnabled = true;
  g.drawImage(small, 0, 0, base.width, base.height);
  const X = (x: number) => (x - AREA.minX) * PX, Z = (z: number) => (z - AREA.minZ) * PX;
  const rect = (b: { minX: number; maxX: number; minZ: number; maxZ: number }, color: string) => {
    g.fillStyle = color;
    g.fillRect(X(b.minX), Z(b.minZ), (b.maxX - b.minX) * PX, (b.maxZ - b.minZ) * PX);
  };
  rect(CITY, COLORS.paved);
  rect(RACE_AREA, COLORS.paved);
  g.fillStyle = COLORS.building;
  g.fillRect(X(HALL.x - HALL.hw), Z(HALL.z - HALL.hd), HALL.hw * 2 * PX, HALL.hd * 2 * PX);
  g.fillRect(X(CASINO.x - CASINO.hw), Z(CASINO.z - CASINO.hd), CASINO.hw * 2 * PX, CASINO.hd * 2 * PX);
  // Yarış pisti
  stroke(g, TRACK.map((p) => [p.x, p.z] as [number, number]), TRACK_HALF, COLORS.asphalt, X, Z, true);
  // Yollar: önce kaldırım/banketler, sonra asfalt (kesişmeler temiz görünsün)
  const roads: { pts: [number, number][]; half: number; side: number }[] = [
    ...STREETS.map((s) => ({ pts: [[s.ax, s.az], [s.bx, s.bz]] as [number, number][], half: s.half, side: s.walk })),
    ...HOOD_ROADS.map((pts) => ({ pts, half: HOOD_STREET_HALF, side: HOOD_SIDEWALK })),
    ...VILLAGE_ROADS.map((pts) => ({ pts, half: VILLAGE_ROAD_HALF, side: 1 })),
    ...[ROAD_PATH, ...LINK_ROADS].map((pts) => ({ pts, half: ROAD_HALF, side: 1.4 })),
  ];
  for (const r of roads) stroke(g, r.pts, r.half + r.side, COLORS.side, X, Z);
  for (const r of roads) stroke(g, r.pts, r.half, COLORS.asphalt, X, Z);
  g.setLineDash([3 * PX, 3 * PX]);
  for (const pts of [ROAD_PATH, ...LINK_ROADS]) stroke(g, pts, 0.12, COLORS.line, X, Z);
  g.setLineDash([]);
  // Kavşak ve gölet
  const R = HOOD_ROUNDABOUT;
  disc(g, X(R.x), Z(R.z), R.r * PX, COLORS.asphalt);
  disc(g, X(R.x), Z(R.z), R.island * PX, COLORS.grass);
  disc(g, X(HOOD_PARK.x), Z(HOOD_PARK.z), HOOD_PARK.pond * PX, COLORS.water);
  // Arsalar
  for (const p of PLOTS) {
    g.fillStyle = COLORS.plot;
    g.fillRect(X(p.x0), Z(p.z0), p.size * PX, p.size * PX);
    g.strokeStyle = COLORS.plotEdge;
    g.lineWidth = 1.5;
    g.strokeRect(X(p.x0), Z(p.z0), p.size * PX, p.size * PX);
  }
  return base;
}

function stroke(g: CanvasRenderingContext2D, pts: readonly [number, number][], half: number, color: string, X: (x: number) => number, Z: (z: number) => number, closed = false): void {
  g.strokeStyle = color;
  g.lineWidth = Math.max(1, half * 2 * PX);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
  if (closed) g.closePath();
  g.stroke();
}

function disc(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}
