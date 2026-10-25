// NPC trafik: rotalarda dönen arabalar (trafficRoutes.ts). Her arabanın yeri sunucu saatinden hesaplanır, herkes
// aynı arabayı aynı yerde görür; ağ trafiği yok. Önüne çıkan oyuncu ya da arabası için yerel olarak durur
// (beklediği kadar geride kalır, sonra biraz hızlanıp çizelgesine yetişir), uzun beklerse korna çalar. Arkadaki
// araba öndekine yaklaşınca o da bekler. Oyuncular ve arabaları NPC arabaların içinden geçemez.
import { CAR_HULL_R, carCircles } from "../../../shared/car";
import { falloff, sfx } from "../ui/sfx";
import type { DynamicColliders, Vec2 } from "../world/colliders";
import { TRAFFIC_LOOKS, TrafficCars } from "../world/trafficCars";
import { lerp, lerpAngle } from "./fixedStep";
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
  /** Yerel bekleme (sn) ve son benzetim adımındaki yeri. */
  delay: number;
  s: number;
  x: number;
  z: number;
  rot: number;
  /** Önceki adımdaki yeri (çizim ikisinin arasından). */
  px: number;
  pz: number;
  prot: number;
  /** Bu kare çizildiği yer (çarpışma da bunu kullanır: görünenle aynı). */
  rx: number;
  rz: number;
  rrot: number;
  v: number;
  shown: boolean;
  scale: number;
  blockedFor: number;
  honkAt: number;
  /** Çarpılınca: şeritten kayma (m), hızı (m/sn), dönüş (rad) ve dönüş hızı; sersemlik (sn, bu sürede durur). */
  bx: number;
  bz: number;
  bvx: number;
  bvz: number;
  brot: number;
  bspin: number;
  stun: number;
  /** Savrulma hâlinin son gönderildiği an (sn). */
  sentAt: number;
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
  /** Son adımda görünenler. */
  private shownList: Car[] = [];
  private lit: { x: number; z: number; rot: number }[] = [];

  constructor(private lowPower: boolean) {
    this.routes = buildRoutes();
    let seed = 99;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const route of this.routes) {
      const list: Car[] = [];
      for (const offset of route.offsets) {
        const car: Car = {
          route, offset, look: Math.floor(rand() * TRAFFIC_LOOKS.length), gate: rand(), delay: 0, s: 0, x: 0, z: 0, rot: 0, v: 0,
          px: 0, pz: 0, prot: 0, rx: 0, rz: 0, rrot: 0, shown: false, scale: 1, blockedFor: 0, honkAt: 0,
          bx: 0, bz: 0, bvx: 0, bvz: 0, brot: 0, bspin: 0, stun: 0, sentAt: 0,
        };
        this.cars.push(car);
        list.push(car);
      }
      this.byRoute.set(route, list);
    }
  }

  /** Savrulma hâli değişti (çarpan oyuncu): sunucu üzerinden herkese gider. */
  onBump: ((id: number, s: number[]) => void) | null = null;

  /** Başkası çarptı: savrulma hâlini uygula. */
  applyBump(id: number, s: number[]): void {
    const c = this.cars[id];
    if (!c) return;
    [c.bx, c.bz, c.brot, c.bvx, c.bvz, c.bspin, c.stun] = s;
  }

  /** Arabanın çarpabileceği NPC arabalar (görünenler): yeri, hızı ve çarpınca savrulması. */
  *bodies(near: { x: number; z: number }, mass: number): Iterable<import("../player").CarBody> {
    for (const c of this.shownList) {
      if (c.scale < 0.9 || Math.abs(c.rx - near.x) > 8 || Math.abs(c.rz - near.z) > 8) continue;
      const v = c.stun > 0 ? 0 : c.v;
      yield {
        x: c.rx, z: c.rz, rot: c.rrot, mass, hl: 2.15 * c.scale, hw: 0.86 * c.scale, omega: c.bspin,
        vx: Math.sin(c.rrot) * v + c.bvx, vz: Math.cos(c.rrot) * v + c.bvz,
        hit: (dvx, dvz, spin) => {
          c.bvx += dvx;
          c.bvz += dvz;
          c.bspin += spin;
          c.stun = Math.max(c.stun, 2.5 + Math.min(3, Math.hypot(dvx, dvz) * 0.3));
          const now = performance.now() / 1000;
          if (this.onBump && now - c.sentAt > 0.08) {
            c.sentAt = now;
            this.onBump(this.cars.indexOf(c), [c.bx, c.bz, c.brot, c.bvx, c.bvz, c.bspin, c.stun]);
          }
        },
      };
    }
  }

  /** Görünen arabalar oyuncuları ve arabalarını durdurur. */
  readonly colliders: DynamicColliders = {
    resolve: (p: Vec2, radius: number) => {
      for (const c of this.cars) {
        if (!c.shown || Math.abs(c.rx - p.x) > 5 || Math.abs(c.rz - p.z) > 5) continue;
        const [fx, fz, bx, bz] = carCircles(c.rx, c.rz, c.rrot);
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
    const out = this.lit;
    let n = 0;
    for (const c of this.shownList) {
      if (c.scale <= 0.5) continue;
      const o = (out[n++] ??= { x: 0, z: 0, rot: 0 });
      o.x = c.rx;
      o.z = c.rz;
      o.rot = c.rrot;
    }
    out.length = n;
    return out;
  }

  /**
   * Benzetim adımı (FixedStep): `serverMs` ortak saat, `dt` adımın süresi, `hour` dünyanın saati, `mul` kalabalık
   * çarpanı (0 kapalı), `movers` oyuncular (ilki sensin: korna sesi ona göre). Çizim `draw` ile.
   */
  step(serverMs: number, dt: number, cam: { x: number; z: number }, hour: number, mul: number, movers: TrafficMover[]): void {
    const t = serverMs / 1000;
    const R = this.lowPower ? DRAW_R_LOW : DRAW_R;
    const dens = trafficDensity(hour) * Math.min(1.2, mul);
    this.shownList.length = 0;
    for (const c of this.cars) {
      const was = c.shown;
      c.px = c.x;
      c.pz = c.z;
      c.prot = c.rot;
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
      // Çarpılmış: savrulma söner; sersemken durur, sonra şeridine yavaşça döner
      if (c.bvx || c.bvz || c.bspin || c.bx || c.bz || c.brot) {
        c.bx += c.bvx * dt;
        c.bz += c.bvz * dt;
        c.brot += c.bspin * dt;
        const k = Math.exp(-dt * 2.4);
        c.bvx *= k;
        c.bvz *= k;
        c.bspin *= Math.exp(-dt * 2);
        if (c.stun <= 0) {
          const back = Math.exp(-dt * 0.8);
          c.bx *= back;
          c.bz *= back;
          c.brot *= back;
          if (Math.abs(c.bx) + Math.abs(c.bz) + Math.abs(c.brot) < 0.02) c.bx = c.bz = c.brot = c.bvx = c.bvz = c.bspin = 0;
        }
      }
      if (c.stun > 0) {
        c.stun -= dt;
        c.delay += dt;
        const tr2 = trajAt(c.route, t - c.route.t0 - c.offset - c.delay);
        c.s = tr2.s;
        routePose(c.route, c.s, this.pose);
        c.x = this.pose.x;
        c.z = this.pose.z;
        c.rot = this.pose.rot;
        c.v = 0;
      }
      c.x += c.bx;
      c.z += c.bz;
      c.rot += c.brot;
      if (!c.shown) continue;
      // Yeni beliren ya da sıçrayan (rota başı, uzun bekleme) araba ara değerlenmez
      if (!was || Math.abs(c.x - c.px) + Math.abs(c.z - c.pz) > 6) {
        c.px = c.x;
        c.pz = c.z;
        c.prot = c.rot;
      }
      this.shownList.push(c);
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
  }

  /** Kare başına: arabalar son iki adımın arasında (`alpha` 0 önceki, 1 son adım) çizilir. */
  draw(alpha: number): void {
    const r = this.renderer;
    r.begin();
    for (const c of this.shownList) {
      c.rx = lerp(c.px, c.x, alpha);
      c.rz = lerp(c.pz, c.z, alpha);
      c.rrot = lerpAngle(c.prot, c.rot, alpha);
      r.push(c.look, c.rx, c.rz, c.rrot, 0.3 + 0.7 * c.scale);
    }
    r.end();
  }
}
