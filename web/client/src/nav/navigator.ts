// Navigasyon: hedef (iş hedefi ya da haritada işaretlediğin nokta) için yollar üstünden rota, arabanın üstünde
// NFSU2 gibi mavi 3B ok (bir sonraki dönüşü gösterir), işaretlenen yerde mavi ışık sütunu ve ekranın üstünde kalan
// mesafe. Rotadan çıkınca yeniden hesaplanır; işaretlenen yere varınca işaret kalkar.
import { icon } from "../ui/icons";
import { region } from "../ui/layout";
import { el } from "../ui/panel";
import { JobMarker } from "../world/jobMarker";
import { NavArrow } from "../world/navArrow";
import { lookAhead, RoadGraph, worldRoads } from "./roadGraph";

type P = [number, number];

/** Rota ve işaretin rengi (harita ve minimap da bunu kullanır). */
export const NAV_COLOR = "#36c8ff";
/** İşaretlenen yere bu kadar yaklaşınca varılmış sayılır. */
const ARRIVE = 12;
/** Rotadan bu kadar uzaklaşınca yeniden hesaplanır. */
const OFF_ROUTE = 18;

export interface NavSelf {
  x: number;
  z: number;
  rot: number;
  /** Arabadaysa hızı (ok daha ileriye bakar). */
  car: { v: number } | null;
  baseY: number;
}

export interface NavFrame {
  /** İş hedefi (varsa işaretten önce gelir). */
  job: { x: number; z: number } | null;
  /** Arabanın tavan yüksekliği (ok onun üstünde). */
  roof: number;
  firstPerson: boolean;
  /** Ok gösterilmesin (tuning, sahne, fotoğraf…). */
  hideArrow: boolean;
  groundAt(x: number, z: number): number;
  dt: number;
  time: number;
}

export class Navigator {
  waypoint: { x: number; z: number } | null = null;
  /** Şu anki rota (harita ve minimap çizer); hedef yoksa null. */
  route: P[] | null = null;
  readonly arrow = new NavArrow();
  readonly marker = new JobMarker(NAV_COLOR);
  private graph: RoadGraph | null = null;
  private dest: { x: number; z: number } | null = null;
  private routedAt = 0;
  private chip: HTMLDivElement;
  private chipText: HTMLElement;
  private shownText = "";

  constructor(hudRoot: HTMLElement, private onArrive: () => void) {
    this.chip = el("div", "nav-chip", region(hudRoot, "tc"));
    icon("navigation", "nav-chip-ic", this.chip);
    el("span", "nav-chip-label", this.chip, "Hedef");
    this.chipText = el("b", "", this.chip);
    const x = el("button", "nav-chip-x", this.chip);
    x.type = "button";
    icon("close", "", x);
    x.title = "İşareti kaldır";
    x.setAttribute("aria-label", "İşareti kaldır");
    x.addEventListener("click", () => this.setWaypoint(null));
  }

  /** Haritadan: hedef işaretle ya da kaldır. */
  setWaypoint(p: { x: number; z: number } | null): void {
    this.waypoint = p ? { x: p.x, z: p.z } : null;
    this.route = null;
  }

  update(me: NavSelf, f: NavFrame): void {
    const dest = f.job ?? this.waypoint;
    this.marker.set(this.waypoint && !f.job ? { x: this.waypoint.x, z: this.waypoint.z, y: f.groundAt(this.waypoint.x, this.waypoint.z) } : null, f.time);
    if (!dest) {
      this.route = this.dest = null;
      this.arrow.update(null, null, 1, f.dt, f.time);
      this.setChip("");
      return;
    }
    // Vardın
    if (!f.job && Math.hypot(dest.x - me.x, dest.z - me.z) < ARRIVE) {
      this.setWaypoint(null);
      this.onArrive();
      return this.update(me, f);
    }
    const now = performance.now();
    const moved = !this.dest || Math.hypot(dest.x - this.dest.x, dest.z - this.dest.z) > 1;
    let la = this.route ? lookAhead(this.track(this.route), me.x, me.z, 0) : null;
    if (moved || !this.route || (la && la.off > OFF_ROUTE && now - this.routedAt > 1200)) {
      this.graph ??= new RoadGraph(worldRoads());
      this.route = this.graph.route(me.x, me.z, dest.x, dest.z);
      this.dest = { ...dest };
      this.routedAt = now;
    }
    const route = this.route!;
    const ahead = me.car ? 14 + Math.abs(me.car.v) * 0.9 : 8;
    la = lookAhead(this.track(route), me.x, me.z, ahead);
    // Ok: arabanın üstünde biraz önde (birinci şahısta camın önünde), yürürken başının üstünde küçük
    const fx = Math.sin(me.rot), fz = Math.cos(me.rot);
    let at: { x: number; y: number; z: number } | null = null, scale = 1;
    if (!f.hideArrow) {
      // Tam aracın üstünde, isim etiketinin üstünde (öne kaydırılınca yandan bakınca kayık görünüyordu)
      if (me.car) at = f.firstPerson ? { x: me.x + fx * 6, y: 2.2, z: me.z + fz * 6 } : { x: me.x, y: f.roof + 1.1, z: me.z };
      else {
        at = { x: me.x, y: me.baseY + 2.9, z: me.z };
        scale = 0.5;
      }
    }
    this.arrow.update(at, la, scale, f.dt, f.time);
    // İş hedefinin mesafesini iş kartı gösterir; işaret için üstte etiket
    const left = la.left;
    this.setChip(f.job ? "" : `${left >= 1000 ? `${(left / 1000).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} km` : `${Math.round(left / 10) * 10} m`}`);
  }

  /**
   * Okun izlediği yol: rotanın ilk noktası hesaplandığı andaki yerin. O nokta yolun gerisinde kalabilir (en yakın
   * düğüm arkadaysa ok bir an geriyi gösterirdi); ok rotanın yol kısmına bağlanır.
   */
  private track(route: P[]): P[] {
    return route.length > 2 ? route.slice(1) : route;
  }

  private setChip(text: string): void {
    if (text === this.shownText) return;
    this.shownText = text;
    this.chip.classList.toggle("show", !!text);
    if (text) this.chipText.textContent = text;
  }
}
