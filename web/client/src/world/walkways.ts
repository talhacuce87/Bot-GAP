// Yürüyüş ağı: köy patikaları (sahne bunlardan taş ve lamba dizer), şehrin kaldırımları, mahallenin kaldırımları.
// NPC yayalar bu çizgilerde yürür; hepsi sabit veriden üretilir, her istemcide aynıdır.
import { BRIDGE, HALL, KAHVEHANE, LAKE, PLAZA, RACE_HOUSE, RIVER, ROAD_RIVER, ROAD_VILLAGE_GATE, STREETS, TUNNEL, WATERFALL } from "../../../shared/zones";
import { HOOD_ROADS, HOOD_SIDEWALK, HOOD_STREET_HALF } from "../../../shared/build";
import { TANK_PARK } from "../../../shared/tank";
import { FAME } from "./fame";
import { SAKURA } from "./sakura";
import { BRIDGE_AXES } from "./terrain";
import { GROVE_SIGN } from "./zones";

export type Zone = "village" | "city" | "hood";
type P = [number, number];

export interface Walkway {
  pts: P[];
  zone: Zone;
}

/** Köy patikaları: her biri kırık çizgi (meydan, kahvehane, göl, köprüler, sinema, saha). */
export function villagePaths(): P[][] {
  /** Köprünün iki ucu (meydan tarafı önce: batı yakası). */
  const ends = (i: number): [P, P] => {
    const a = BRIDGE_AXES[i], e = BRIDGE.half + 0.6;
    const p: P = [a.x - a.ux * e, a.z - a.uz * e], q: P = [a.x + a.ux * e, a.z + a.uz * e];
    return p[0] < q[0] ? [p, q] : [q, p];
  };
  const [b2w, b2e] = ends(0);
  const P = PLAZA, K = KAHVEHANE, H = HALL;
  const RW = ROAD_RIVER.west, RE = ROAD_RIVER.east;
  const [roadX, roadZ] = ROAD_VILLAGE_GATE;
  return [
    // Meydan → kahvehane → göl (otobanın altından geçer)
    [[P.x, P.z - 10.9], [K.x + 1, K.z + K.hd + 1.4]],
    // Kahvehane yolundan oyuncak pistin kapısına
    [[P.x - 0.6, RACE_HOUSE.z], [RACE_HOUSE.x + RACE_HOUSE.hw + 1.4, RACE_HOUSE.z]],
    [[K.x - 1, K.z - K.hd - 1.6], [LAKE.x - 4, LAKE.z + LAKE.r + 2.6]],
    // Meydan → köy yolunun ucu (yol kahvehanenin doğusundan otobana çıkar)
    [[P.x + 7.7, P.z - 7.7], [-88.5, 51.5]],
    // Kahvehane → otoban köprüsünün (güney kaldırımı) batı ucu; doğu ucundan (kuzey kaldırımı) sinemaya
    [[K.x + K.hw + 1.2, K.z - 2], [RW[0], RW[1] + 6.2]],
    [[RE[0], RE[1] - 6.2], [-6, -12.5], [0, -15]],
    // Meydan → 2. köprü → kapalı saha; köprüden şelaleye ve mağaraya
    [[P.x + 10.9, P.z], [b2w[0], b2w[1]]],
    [[b2e[0], b2e[1]], [H.x - H.hw - 1.5, H.z]],
    [[b2e[0], b2e[1]], [WATERFALL.x + 10, RIVER[0][1] - 6]],
    [[H.x - H.hw + 2, H.z - H.hd - 1.5], [TUNNEL[0][0], TUNNEL[0][1] - 2]],
    [[H.x - H.hw - 1.5, H.z + 4], [TUNNEL[0][0] - 1, TUNNEL[0][1] - 1]],
    // Meydan → kürsü, meydan → mangal
    [[P.x + 7.9, P.z + 7.6], [FAME.x - 3.4, FAME.z - 0.6]],
    [[P.x - 2, P.z + 10.9], [GROVE_SIGN.x, GROVE_SIGN.z - 1.5]],
    // Sinema → sakura; sinema → tank → saha
    [[12, -12], [SAKURA.x - 8.4, SAKURA.z + 6.6]],
    [[22, -14], [TANK_PARK.x - 5, TANK_PARK.z]],
    [[TANK_PARK.x, TANK_PARK.z + 5], [H.x + 4, H.z - H.hd - 1.5]],
    // Şehre giden asfaltın köydeki başı → sinema–tank yolu ve tank parkı
    [[roadX - 4.5, roadZ + 1], [60, 4.7]],
    [[roadX - 1, roadZ + 5.2], [TANK_PARK.x + 2, TANK_PARK.z - 5]],
  ];
}

/** Meydanın çevresinde halka (çeşmenin çevresinde dolaşanlar). */
function ring(x: number, z: number, r: number, n = 16): P[] {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([x + Math.cos(a) * r, z + Math.sin(a) * r]);
  }
  return out;
}

/** Kırık çizgiyi yana `d` kadar kaydırır (işaret tarafı seçer); köşede komşu noktaların yönü ortalanır. */
export function offsetLine(pts: P[], d: number): P[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    return [p[0] - (dz / l) * d, p[1] + (dx / l) * d] as P;
  });
}

/** Bütün yürüyüş yolları: köy patikaları ve meydan halkası, şehir ve mahalle kaldırımları (iki yan). */
export function walkways(): Walkway[] {
  const out: Walkway[] = [];
  for (const pts of villagePaths()) out.push({ pts, zone: "village" });
  // Yaya köprüleri: patikaların iki yakadaki uçlarını birleştirir
  for (const a of BRIDGE_AXES) {
    const e = BRIDGE.half + 0.6;
    out.push({ pts: [[a.x - a.ux * e, a.z - a.uz * e], [a.x + a.ux * e, a.z + a.uz * e]], zone: "village" });
  }
  out.push({ pts: ring(PLAZA.x, PLAZA.z, 6), zone: "village" });
  for (const s of STREETS) {
    const line: P[] = [[s.ax, s.az], [s.bx, s.bz]];
    for (const side of [-1, 1]) out.push({ pts: offsetLine(line, side * (s.half + s.walk / 2)), zone: "city" });
  }
  for (const r of HOOD_ROADS) {
    for (const side of [-1, 1]) out.push({ pts: offsetLine(r, side * (HOOD_STREET_HALF + HOOD_SIDEWALK / 2)), zone: "hood" });
  }
  return out;
}
