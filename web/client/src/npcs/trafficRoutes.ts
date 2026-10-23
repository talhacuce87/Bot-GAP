// NPC trafiğinin rotaları ve zaman çizelgeleri (saf veri; herkeste aynı). Her rota sağ şeritte kapalı bir döngü:
// otoban (şehir ucunda U dönüşü, mahalle ucunda göbekli kavşak), mahallenin çevresi (iki yön), şehirde blok
// halkaları (iki yön, trafik lambalarında durur), köy ve bağlantı yolları (gidiş-dönüş). Bir arabanın döngüdeki
// yeri yalnızca saate bağlıdır: rota başına tek bir "örnek tur" önceden hesaplanır, arabalar ona zaman kaymasıyla
// dizilir. Lambalı rotalarda tur 12 sn'nin katıdır ve arabalar 12 sn arayla gider: hepsi lambalara aynı fazda
// varır, kuyrukta üst üste binmezler.
import { HOOD_ROADS, HOOD_ROUNDABOUT, HOOD_STREET_HALF } from "../../../shared/build";
import { LINK_ROADS, ROAD_HALF, ROAD_PATH, STREETS, VILLAGE_ROAD_HALF, VILLAGE_ROADS } from "../../../shared/zones";
import { smoothPath } from "../../../shared/path";
import { greenStart, SIGNAL_CYCLE, signalLamp } from "../world/signals";
import { offsetLine } from "../world/walkways";

type P = [number, number];

/** Durma çizgisi: rotada `s` metresinde, lamba grubu (0 yatay, 1 dikey cadde). */
export interface StopLine {
  s: number;
  group: 0 | 1;
}

export interface Route {
  name: string;
  pts: P[];
  cum: number[];
  len: number;
  /** Noktadaki en yüksek hız (viraj ve bölge sınırı). */
  vmax: Float32Array;
  stops: StopLine[];
  /** Örnek tur: 0.1 sn aralıkla tur başından alınan yol (m, sarılmamış); tur süresi (sn). */
  traj: Float32Array;
  period: number;
  /** Turun başladığı yer (lambalı rotada çapa durma çizgisi) ve turun başladığı döngü anı. */
  s0: number;
  t0: number;
  /** Arabaların zaman kaymaları (sn). */
  offsets: number[];
}

const DT = 0.1;
const ACCEL = 2.2;
const BRAKE = 3.5;
/** Viraj: yanal ivme sınırı (m/sn²). */
const LAT = 2.6;
/** Aynı rotadaki iki araba arasında en az bu kadar (m) kalır (kırmızıda kuyruk). */
const MIN_GAP = 7;

function reverse(p: P[]): P[] {
  return [...p].reverse();
}

/** Yolun ucunda U dönüşü: `a` uç, `dir` gidiş yönü; diğer şeride (`width` solda) döner. */
function uTurn(a: P, dir: P, width: number): P[] {
  const left: P = [dir[1], -dir[0]];
  const r = width / 2, ext = 4;
  const c: P = [a[0] + dir[0] * ext + left[0] * r, a[1] + dir[1] * ext + left[1] * r];
  const out: P[] = [[a[0] + dir[0] * ext, a[1] + dir[1] * ext]];
  for (let k = 1; k < 8; k++) {
    const th = (k / 8) * Math.PI;
    out.push([c[0] - left[0] * r * Math.cos(th) + dir[0] * r * Math.sin(th), c[1] - left[1] * r * Math.cos(th) + dir[1] * r * Math.sin(th)]);
  }
  out.push([a[0] + dir[0] * ext + left[0] * width, a[1] + dir[1] * ext + left[1] * width]);
  return out;
}

function unit(a: P, b: P): P {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

/** Yolun başından ve sonundan `a`, `b` metre kırpar (kavşağa girmeden dönülsün). */
function trim(p: P[], a: number, b: number): P[] {
  const cut = (pts: P[], d: number): P[] => {
    let left = d, i = 0;
    while (i < pts.length - 1) {
      const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (l > left) {
        const u = unit(pts[i], pts[i + 1]);
        return [[pts[i][0] + u[0] * left, pts[i][1] + u[1] * left], ...pts.slice(i + 1)];
      }
      left -= l;
      i++;
    }
    return pts.slice(-2);
  };
  return reverse(cut(reverse(cut(p, a)), b));
}

/** Gidiş-dönüş döngüsü: sağ şerit, uçta U dönüşü, karşı şerit, öbür uçta U dönüşü. */
function pingPong(p: P[], off: number): P[] {
  const fwd = offsetLine(p, off), back = offsetLine(reverse(p), off);
  const n = fwd.length;
  return [...fwd, ...uTurn(fwd[n - 1], unit(fwd[n - 2], fwd[n - 1]), off * 2), ...back, ...uTurn(back[n - 1], unit(back[n - 2], back[n - 1]), off * 2)];
}

/**
 * Göbekli kavşak: kırık çizginin adanın çevresindeki kısmı, sağa dönülerek ada etrafında yaya çevrilir
 * (çember `r` yarıçaplı). Giriş ve çıkış çizginin çemberi kestiği yerler.
 */
function roundabout(p: P[], cx: number, cz: number, rOut: number, r: number): P[] {
  const inside = (q: P) => Math.hypot(q[0] - cx, q[1] - cz) < rOut;
  const first = p.findIndex(inside);
  if (first <= 0) return p;
  let last = first;
  while (last + 1 < p.length && inside(p[last + 1])) last++;
  if (last + 1 >= p.length) return p;
  const a0 = Math.atan2(p[first - 1][1] - cz, p[first - 1][0] - cx), a1 = Math.atan2(p[last + 1][1] - cz, p[last + 1][0] - cx);
  // Sağa dönülerek: girişteki yönün sağı ile çemberin teğeti aynı tarafta
  const h = unit(p[first - 1], p[first]);
  const right: P = [-h[1], h[0]];
  const ccw = -Math.sin(a0) * right[0] + Math.cos(a0) * right[1] > 0;
  let sweep = a1 - a0;
  if (ccw) while (sweep <= 0.05) sweep += Math.PI * 2;
  else while (sweep >= -0.05) sweep -= Math.PI * 2;
  const arc: P[] = [];
  const n = Math.max(6, Math.ceil((Math.abs(sweep) * r) / 2));
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    arc.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return [...p.slice(0, first), ...arc, ...p.slice(last + 1)];
}

function cumulative(pts: P[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}

/** Şehrin lambalı kavşakları: yatay caddeyle dikey caddenin kesiştiği yerler ve dikeyin/yatayın yarı genişliği. */
function intersections(): { x: number; z: number; hHalf: number; vHalf: number }[] {
  const out: { x: number; z: number; hHalf: number; vHalf: number }[] = [];
  const horiz = STREETS.filter((s) => s.az === s.bz), vert = STREETS.filter((s) => s.ax === s.bx);
  for (const h of horiz) {
    for (const v of vert) {
      const x = v.ax, z = h.az;
      if (x < Math.min(h.ax, h.bx) || x > Math.max(h.ax, h.bx) || z < Math.min(v.az, v.bz) - 0.1 || z > Math.max(v.az, v.bz) + 0.1) continue;
      out.push({ x, z, hHalf: h.half, vHalf: v.half });
    }
  }
  return out;
}

/** Rotanın lambalı kavşaklardaki durma çizgileri. */
function stopLines(pts: P[], cum: number[]): StopLine[] {
  const out: StopLine[] = [];
  for (const it of intersections()) {
    // Köşede sağa/sola dönen de lambaya uyar: dönüş yayı merkezden biraz uzakta geçer
    let best = -1, bestD = 10;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - it.x, pts[i][1] - it.z);
      if (d < bestD) [best, bestD] = [i, d];
    }
    if (best < 0) continue;
    // Kavşağa gelirken gidilen yön (merkezden 12 m önce)
    let j = best;
    while (j > 0 && cum[best] - cum[j] < 12) j--;
    const u = unit(pts[j], pts[best]);
    const horizontal = Math.abs(u[0]) > Math.abs(u[1]);
    const back = (horizontal ? it.vHalf : it.hHalf) + 2.6;
    const len = cum[cum.length - 1];
    out.push({ s: (((cum[best] - back) % len) + len) % len, group: horizontal ? 0 : 1 });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Noktalardaki hız sınırı: bölge hızı ve viraj (yanal ivme), frenleme mesafesiyle geriye yayılır. */
function speeds(pts: P[], cum: number[], vZone: number): Float32Array {
  const n = pts.length, v = new Float32Array(n).fill(vZone);
  for (let i = 1; i < n - 1; i++) {
    const a = unit(pts[i - 1], pts[i]), b = unit(pts[i], pts[i + 1]);
    const turn = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));
    const ds = (cum[i + 1] - cum[i - 1]) / 2 || 1;
    if (turn > 1e-3) v[i] = Math.min(vZone, Math.sqrt((LAT * ds) / turn));
  }
  // Döngü: iki tur geriye doğru fren sınırı
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const nx = (i + 1) % n, ds = Math.max(0.01, nx ? cum[nx] - cum[i] : 0.01);
      v[i] = Math.min(v[i], Math.sqrt(v[nx] * v[nx] + 2 * BRAKE * ds));
    }
  }
  return v;
}

function vmaxAt(r: { cum: number[]; vmax: Float32Array; len: number }, s: number): number {
  s = ((s % r.len) + r.len) % r.len;
  let lo = 0, hi = r.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return Math.min(r.vmax[lo], r.vmax[hi]);
}

/**
 * Örnek tur: tek araba, rotanın başından (`s0`) duruşla başlar; lambalara uyar. Lambalı rotada tur, çapa
 * çizgisinde bir sonraki yeşilin başında biter (süre 12 sn'nin katı). `scale` hız çarpanı.
 */
function simulate(r: Omit<Route, "traj" | "period" | "offsets">, scale: number): { traj: number[]; period: number; wait: number } {
  const traj: number[] = [];
  const lit = r.stops.length > 0;
  let s = 0, v = 0, t = 0, wait = 0;
  // Sarılmamış yolda durma çizgileri (çapa hariç) ve turun sonu
  const lines = r.stops.map((L) => (((L.s - r.s0) % r.len) + r.len) % r.len).filter((x) => x > 0.5);
  const groups = r.stops.filter((L) => (((L.s - r.s0) % r.len) + r.len) % r.len > 0.5).map((L) => L.group);
  for (let step = 0; step < 20000; step++) {
    traj.push(s);
    const now = r.t0 + t;
    let vt = vmaxAt(r, r.s0 + s) * scale;
    // Önündeki kırmızı/sarı lamba
    for (let k = 0; k < lines.length; k++) {
      const d = lines[k] - s;
      if (d < -0.5 || d > 70) continue;
      if (signalLamp(now, groups[k]) !== 2 && d > -0.5) vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * BRAKE * (d - 0.4))));
      break;
    }
    if (lit) {
      // Turun sonu: çapa çizgisinde dur
      const d = r.len - s;
      vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * BRAKE * (d - 0.4))));
      if (d < 0.6 && v < 0.05) {
        // Bir sonraki yeşilin başına kadar bekle
        const g = greenStart(r.stops.find((L) => Math.abs(L.s - r.s0) < 0.01)!.group);
        let end = Math.ceil((now - g) / SIGNAL_CYCLE) * SIGNAL_CYCLE + g;
        if (end - now < 0.5) end += SIGNAL_CYCLE;
        wait = end - now;
        for (let k = 1; k * DT < wait; k++) traj.push(s);
        return { traj, period: end - r.t0, wait };
      }
    } else if (s >= r.len) {
      return { traj, period: t, wait: 0 };
    }
    v += Math.max(-BRAKE * DT, Math.min(ACCEL * DT, vt - v));
    if (v < 0) v = 0;
    s += v * DT;
    t += DT;
  }
  return { traj, period: t, wait };
}

function makeRoute(name: string, pts: P[], vZone: number, headway: number, maxCars: number): Route {
  // Çok yakın noktaları ayıkla (viraj hesabı bozulmasın)
  const clean: P[] = [pts[0]];
  for (const q of pts) if (Math.hypot(q[0] - clean[clean.length - 1][0], q[1] - clean[clean.length - 1][1]) > 0.3) clean.push(q);
  // Kapat: son nokta ilkine
  if (Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) > 0.3) clean.push(clean[0]);
  const cum = cumulative(clean);
  const len = cum[cum.length - 1];
  const vmax = speeds(clean, cum, vZone);
  const stops = stopLines(clean, cum);
  const base = { name, pts: clean, cum, len, vmax, stops, s0: stops[0]?.s ?? 0, t0: stops.length ? greenStart(stops[0].group) : 0 };
  let best = simulate(base, 1);
  if (stops.length) {
    // Turun sonunda yeşilde uzun beklemesin: çapaya kırmızıda varacak hız çarpanı
    for (const scale of [0.96, 0.92, 0.88, 0.84, 0.8]) {
      if (best.wait <= 6.5) break;
      const r = simulate(base, scale);
      if (r.wait < best.wait) best = r;
    }
  }
  const period = best.period;
  const traj = Float32Array.from(best.traj);
  const route: Route = { ...base, traj, period, offsets: [] };
  const offsetsFor = (step: number) => {
    const out: number[] = [];
    for (let o = 0; o + step * 0.5 < period && out.length < maxCars; o += step) out.push(o);
    return out;
  };
  if (!stops.length) {
    // Eşit aralıkla
    route.offsets = offsetsFor(period / Math.max(1, Math.min(maxCars, Math.floor(period / headway))));
    return route;
  }
  // Lambalı rota: döngü katlarında (lambalara aynı fazda varsınlar); kırmızıda bekleyene arkadaki çok yaklaşmasın
  for (let k = Math.max(1, Math.round(headway / SIGNAL_CYCLE)); ; k++) {
    route.offsets = offsetsFor(k * SIGNAL_CYCLE);
    if (route.offsets.length <= 1 || minGap(route) >= MIN_GAP) break;
  }
  return route;
}

/** Aynı rotadaki arabaların bir tur boyunca birbirine en çok yaklaştığı mesafe (m). */
function minGap(r: Route): number {
  let min = Infinity;
  const s = new Float32Array(r.offsets.length);
  for (let t = 0; t < r.period; t += 0.25) {
    r.offsets.forEach((o, i) => (s[i] = (((trajAt(r, t - o).s % r.len) + r.len) % r.len)));
    s.sort();
    for (let i = 0; i < s.length; i++) min = Math.min(min, (i + 1 < s.length ? s[i + 1] : s[0] + r.len) - s[i]);
  }
  return min;
}

/** Bütün rotalar (bir kez kurulur). */
export function buildRoutes(): Route[] {
  const routes: Route[] = [];
  const RA = HOOD_ROUNDABOUT, ringR = (RA.r + RA.island) / 2;
  // Otoban: mahalleden şehre sağ şerit, şehir ucunda U dönüşü, geri; mahalle ucunda göbekli kavşağın çevresinden
  // dolanıp yeniden gidiş şeridine
  {
    const off = ROAD_HALF / 2;
    const fwd = offsetLine(ROAD_PATH, off), back = offsetLine(reverse(ROAD_PATH), off);
    const n = fwd.length;
    const loop = [...fwd, ...uTurn(fwd[n - 1], unit(fwd[n - 2], fwd[n - 1]), off * 2), ...back];
    // Kavşağa girip ada çevresinde dönen kısım: geri şeridin ucundan adaya doğru, gidiş şeridinin başından dışarı
    const bIn = unit(back[n - 2], back[n - 1]), fOut = unit(fwd[0], fwd[1]);
    const ring = roundabout(
      [back[n - 1], [back[n - 1][0] + bIn[0] * 6, back[n - 1][1] + bIn[1] * 6], [RA.x, RA.z], [fwd[0][0] - fOut[0] * 6, fwd[0][1] - fOut[1] * 6], fwd[0]],
      RA.x, RA.z, RA.r - 1, ringR,
    );
    routes.push(makeRoute("otoban", smoothPath([...loop, ...ring.slice(1, -1)], 8), 15, 11, 9));
  }
  // Mahallenin çevresi: güney bulvarı batıya, park döngüsü, kuzey bulvarı doğuya, doğu caddesi (göbekli kavşaktan)
  {
    const [south, , north, east, park] = HOOD_ROADS;
    const full: P[] = [...south, ...park, ...reverse(north), ...reverse(east)];
    // Döngü güney bulvarının ortasından başlar (köşede başlarsa köşe yuvarlanmaz)
    const mid = Math.floor(south.length / 2);
    const ring: P[] = [...full.slice(mid), ...full.slice(1, mid + 1)];
    for (const dir of [1, -1]) {
      const pts = offsetLine(dir > 0 ? ring : reverse(ring), HOOD_STREET_HALF / 2);
      routes.push(makeRoute(dir > 0 ? "mahalle" : "mahalle-ters", smoothPath(roundabout(pts, RA.x, RA.z, RA.r, ringR), 6), 9, 10, 10));
    }
  }
  // Şehir: bulvar, 274 ve 358 caddeleri, 10 caddesi arasındaki blok; iki yön (iç ve dış şerit)
  {
    const [bv, w, e, , s10] = STREETS;
    const x0 = w.ax, x1 = e.ax, z0 = bv.az, z1 = s10.az;
    const ob = bv.half / 2 - 0.4, ow = w.half / 2, os = s10.half / 2;
    const right: P[] = [[x0 + ow, z0 + ob], [x1 - ow, z0 + ob], [x1 - ow, z1 - os], [x0 + ow, z1 - os]];
    const left: P[] = [[x0 - ow, z0 - ob], [x0 - ow, z1 + os], [x1 + ow, z1 + os], [x1 + ow, z0 - ob]];
    for (const [name, c] of [["şehir", right], ["şehir-ters", left]] as const) {
      // İlk kenarın ortasından başlayıp oraya dönen kapalı çizgi: dört köşe de yuvarlanır
      const m: P = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
      routes.push(makeRoute(name, smoothPath([m, c[1], c[2], c[3], c[0], m], 7), 11, 12, 5));
    }
  }
  // Köy yolları ve mahalle bağlantıları: gidiş-dönüş (otobana/kavşağa girmeden döner)
  VILLAGE_ROADS.forEach((p, i) => routes.push(makeRoute(`köy-${i}`, smoothPath(pingPong(trim(p, 10, 3), VILLAGE_ROAD_HALF / 2), 3), 7, 14, 2)));
  LINK_ROADS.forEach((p, i) => routes.push(makeRoute(`bağlantı-${i}`, smoothPath(pingPong(trim(p, 9, 9), ROAD_HALF / 2), 4), 12, 12, 4)));
  return routes;
}

/** Rotada `s` metredeki nokta ve yön. */
export function routePose(r: Route, s: number, out: { x: number; z: number; rot: number }): void {
  s = ((s % r.len) + r.len) % r.len;
  let lo = 0, hi = r.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const a = r.pts[lo], b = r.pts[hi], seg = r.cum[hi] - r.cum[lo] || 1, u = (s - r.cum[lo]) / seg;
  out.x = a[0] + (b[0] - a[0]) * u;
  out.z = a[1] + (b[1] - a[1]) * u;
  out.rot = Math.atan2(b[0] - a[0], b[1] - a[1]);
}

/** Örnek turda `tau` saniyedeki yol (rotada, sarılmış) ve hız. */
export function trajAt(r: Route, tau: number): { s: number; v: number } {
  const p = ((tau % r.period) + r.period) % r.period;
  const i = Math.min(r.traj.length - 2, Math.floor(p / DT)), u = p / DT - i;
  const s = r.traj[i] + (r.traj[i + 1] - r.traj[i]) * u;
  return { s: r.s0 + s, v: (r.traj[i + 1] - r.traj[i]) / DT };
}
