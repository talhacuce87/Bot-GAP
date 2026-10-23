// NPC trafik: rotalarda dönen arabalar (trafficRoutes.ts). Her arabanın yeri sunucu saatinden hesaplanır, herkes
// aynı arabayı aynı yerde görür; ağ trafiği yok. Önüne çıkan oyuncu ya da arabası için yerel olarak durur
// (beklediği kadar geride kalır, sonra biraz hızlanıp çizelgesine yetişir), uzun beklerse korna çalar. Arkadaki
// araba öndekine yaklaşınca o da bekler. Oyuncular ve arabaları NPC arabaların içinden geçemez.
import { CAR_HULL_R, carCircles } from "../../../shared/car";
import { falloff, sfx } from "../ui/sfx";
import type { DynamicColliders, Vec2 } from "../world/colliders";
import { TRAFFIC_LOOKS, TrafficCars } from "../world/trafficCars";
import { buildRoutes, type Route, routePose, trajAt } from "./trafficRoutes";

/** Çizim ve tepki yarıçapı (m). */
const DRAW_R = 320;
const DRAW_R_LOW = 180;
/** Önünde bu kadar yakında (m, hıza göre uzar) ve şeritte biri varsa durur. */
const BLOCK_AHEAD = 7;
const BLOCK_SIDE = 1.9;
/** Aynı rotada öndeki arabaya en çok bu kadar yaklaşır. */
const FOLLOW_GAP = 8;
/** Bekledikten sonra çizelgesine yetişme hızı (sn/sn): biraz daha hızlı gider. */
const CATCH_UP = 0.25;
const HONK_AFTER = 1.6;

/** Oyuncu (yaya ya da arabası). */
export interface TrafficMover {
  x: number;
  z: number;
  /** Arabadaysa yönü (gövdesi de engel). */
  car: { rot: number } | null;
}

interface Car {
  route: Route;
  offset: number;
  look: number;
  /** Yoğunluk eşiği (saate göre azalır). */
  gate: number;
  /** Yerel bekleme (sn) ve bu kare yeri. */
  delay: number;
  s: number;
  x: number;
  z: number;
  rot: number;
  v: number;
  shown: boolean;
  scale: number;
  blockedFor: number;
  honkAt: number;
}

/** Saate göre trafik yoğunluğu (Türkiye saati). */
export function trafficDensity(h: number): number {
  const pts: [number, number][] = [[0, 0.45], [3, 0.2], [6, 0.35], [8, 0.95], [10, 0.75], [17, 0.9], [19, 1], [23, 0.6], [24, 0.45]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [h0, d0] = pts[i], [h1, d1] = pts[i + 1];
    if (h >= h0 && h <= h1) return d0 + ((d1 - d0) * (h - h0)) / (h1 - h0);
  }
  return 0.5;
}

export class AmbientTraffic {
  readonly renderer = new TrafficCars();
  readonly routes: Route[];
  readonly cars: Car[] = [];
  private pose = { x: 0, z: 0, rot: 0 };
  private byRoute = new Map<Route, Car[]>();

  constructor(private lowPower: boolean) {
    this.routes = buildRoutes();
    let seed = 99;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const route of this.routes) {
      const list: Car[] = [];
      for (const offset of route.offsets) {
        const car: Car = {
          route, offset, look: Math.floor(rand() * TRAFFIC_LOOKS.length), gate: rand(), delay: 0, s: 0, x: 0, z: 0, rot: 0, v: 0,
          shown: false, scale: 1, blockedFor: 0, honkAt: 0,
        };
        this.cars.push(car);
        list.push(car);
      }
      this.byRoute.set(route, list);
    }
  }

  /** Görünen arabalar oyuncuları ve arabalarını durdurur. */
  readonly colliders: DynamicColliders = {
    resolve: (p: Vec2, radius: number) => {
      for (const c of this.cars) {
        if (!c.shown || Math.abs(c.x - p.x) > 5 || Math.abs(c.z - p.z) > 5) continue;
        const [fx, fz, bx, bz] = carCircles(c.x, c.z, c.rot);
        for (const [cx, cz] of [[fx, fz], [bx, bz]]) {
          const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz), min = CAR_HULL_R * c.scale + radius;
          if (d >= min) continue;
          if (d < 1e-4) p.x += min;
          else {
            p.x = cx + (dx / d) * min;
            p.z = cz + (dz / d) * min;
          }
        }
      }
    },
    groundAt: () => 0,
  };

  /** Gece farı yanacak en yakın NPC arabalar (Cars gerçek far ışığını bunlarla paylaşır). */
  headlights(): { x: number; z: number; rot: number }[] {
    return this.cars.filter((c) => c.shown && c.scale > 0.5);
  }

  /**
   * Kare başına: `serverMs` ortak saat, `hour` dünyanın saati, `mul` kalabalık çarpanı (0 kapalı), `movers`
   * oyuncular (ilki sensin: korna sesi ona göre).
   */
  update(serverMs: number, dt: number, cam: { x: number; z: number }, hour: number, mul: number, movers: TrafficMover[]): void {
    const t = serverMs / 1000;
    const R = this.lowPower ? DRAW_R_LOW : DRAW_R;
    const dens = trafficDensity(hour) * Math.min(1.2, mul);
    for (const c of this.cars) {
      const want = dens - c.gate;
      c.scale = want <= 0 ? 0 : Math.min(1, want / 0.08);
      const tr = trajAt(c.route, t - c.route.t0 - c.offset - c.delay);
      c.s = tr.s;
      c.v = tr.v;
      routePose(c.route, c.s, this.pose);
      c.x = this.pose.x;
      c.z = this.pose.z;
      c.rot = this.pose.rot;
      c.shown = c.scale > 0 && Math.abs(c.x - cam.x) < R && Math.abs(c.z - cam.z) < R;
    }
    // Bekleme: önünde oyuncu ya da aynı rotada öndeki araba
    for (const [route, list] of this.byRoute) {
      for (const c of list) {
        if (!c.shown) {
          c.delay = Math.max(0, c.delay - dt * CATCH_UP);
          continue;
        }
        const fx = Math.sin(c.rot), fz = Math.cos(c.rot);
        const reach = BLOCK_AHEAD + Math.max(0, c.v) * 0.7;
        let blocked = false, byPlayer = false;
        for (const m of movers) {
          const dx = m.x - c.x, dz = m.z - c.z;
          const ahead = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx);
          if (ahead > 1.5 && ahead < reach && side < BLOCK_SIDE + (m.car ? 0.8 : 0)) {
            blocked = byPlayer = true;
            break;
          }
        }
        if (!blocked) {
          for (const o of list) {
            if (o === c || !o.shown) continue;
            const gap = (((o.s - c.s) % route.len) + route.len) % route.len;
            if (gap > 0.1 && gap < FOLLOW_GAP && o.delay >= c.delay - 0.05) {
              blocked = true;
              break;
            }
          }
        }
        if (blocked) {
          c.delay += dt;
          c.blockedFor = byPlayer ? c.blockedFor + dt : 0;
        } else {
          c.delay = Math.max(0, c.delay - dt * CATCH_UP);
          c.blockedFor = 0;
        }
        // Önüne çıkan oyuncuya korna (sesin şiddeti sana uzaklığa göre)
        if (c.blockedFor > HONK_AFTER && t - c.honkAt > 3 && movers[0]) {
          c.honkAt = t;
          const d = Math.hypot(movers[0].x - c.x, movers[0].z - c.z);
          if (d < 60) sfx.horn(falloff(d), Math.random() < 0.4);
        }
      }
    }
    const r = this.renderer;
    r.begin();
    for (const c of this.cars) if (c.shown) r.push(c.look, c.x, c.z, c.rot, 0.3 + 0.7 * c.scale);
    r.end();
  }
}
