// Oyuncak pist yarışı: pistler, araba fiziği, tur/sektör sayımı. İstemci kendi arabasını bununla sürer,
// sunucu aynı pist ve sektör hesabıyla turları sayar ve hızı doğrular. Birimler "pist birimi"
// (dünyada RACE_SCALE ile küçülür: oyuncak araba ~0.4 m); x doğu, z güney, yön açısı a: ileri (cos a, sin a).

export const RACE = {
  laps: 3,
  min: 2,
  max: 8,
  /** Pistin yarı genişliği. */
  halfW: 5,
  /** Tur sayımı için pist bu kadar sektöre bölünür; sırayla geçilmeli. */
  sectors: 12,
  countdownMs: 3500,
  /** İlk bitiren gelince diğerlerine kalan süre. */
  finishWaitMs: 20_000,
  maxMs: 4 * 60_000,
  /** Sonuç ekranı, sonra lobiye dönülür. */
  resultMs: 12_000,
};

export interface TrackDef {
  name: string;
  emoji: string;
  /** Kapalı orta çizginin kontrol noktaları; ilki başlangıç çizgisi, araçlar ikinciye doğru başlar. */
  pts: [number, number][];
}

export const TRACKS: TrackDef[] = [
  {
    name: "Halı Rallisi",
    emoji: "🧶",
    pts: [[-28, 28], [30, 28], [44, 20], [46, 4], [40, -14], [30, -26], [14, -26], [6, -18], [-4, -26], [-24, -28], [-42, -22], [-46, -6], [-44, 10], [-38, 22]],
  },
  {
    name: "Mutfak Masası",
    emoji: "🍳",
    pts: [[-38, 28], [34, 28], [46, 18], [40, 8], [10, 8], [2, -2], [12, -12], [40, -12], [46, -24], [34, -30], [-30, -30], [-44, -22], [-38, -10], [-24, -6], [-20, 2], [-30, 9], [-44, 14], [-47, 24]],
  },
  {
    name: "Çocuk Odası",
    emoji: "🧸",
    pts: [[-40, 26], [-20, 20], [0, 28], [20, 20], [38, 26], [46, 10], [38, -4], [46, -18], [34, -28], [-24, -28], [-38, -26], [-46, -16], [-44, -4], [-36, 6], [-46, 16]],
  },
  {
    name: "Lego Şehri",
    emoji: "🧱",
    pts: [[-40, 26], [36, 26], [46, 14], [40, 2], [20, 2], [12, -10], [24, -18], [38, -15], [47, -21], [42, -30], [-34, -30], [-46, -20], [-40, -6], [-26, -2], [-28, 12], [-42, 12], [-47, 22]],
  },
  {
    name: "Pervaz Sprint",
    emoji: "🏁",
    pts: [[-44, 26], [36, 26], [46, 16], [34, 6], [-14, 6], [-26, 4], [-30, -3], [-26, -10], [-14, -12], [34, -12], [46, -17], [44, -28], [32, -31], [-36, -30], [-46, -20], [-46, 12]],
  },
];

/** Örneklenmiş pist: orta çizgi noktaları (x, z) ve birim teğetler, 1 birim aralıkla. */
export interface Track {
  n: number;
  px: Float32Array;
  pz: Float32Array;
  tx: Float32Array;
  tz: Float32Array;
  length: number;
}

const SMOOTH = 80;

/** Centripetal Catmull-Rom (sivri kıvrım/ilmek yapmaz). */
function centripetal(p: [number, number][], i: number, t: number): [number, number] {
  const m = p.length;
  const p0 = p[(i - 1 + m) % m], p1 = p[i], p2 = p[(i + 1) % m], p3 = p[(i + 2) % m];
  const knot = (a: [number, number], b: [number, number]) => Math.sqrt(Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 1e-4));
  const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const lerp = (a: [number, number], b: [number, number], ta: number, tb: number): [number, number] => [
    ((tb - tt) * a[0] + (tt - ta) * b[0]) / (tb - ta),
    ((tb - tt) * a[1] + (tt - ta) * b[1]) / (tb - ta),
  ];
  const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
  return lerp(lerp(a1, a2, t0, t2), lerp(a2, a3, t1, t3), t1, t2);
}

function build(def: TrackDef): Track {
  const dense: [number, number][] = [];
  for (let i = 0; i < def.pts.length; i++) for (let k = 0; k < 60; k++) dense.push(centripetal(def.pts, i, k / 60));
  // Yay uzunluğuna göre 1 birim aralıkla yeniden örnekle
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1], b = dense[i % dense.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[cum.length - 1];
  const n = Math.floor(total);
  let pts: [number, number][] = [];
  for (let k = 0, j = 0; k < n; k++) {
    const s = (k * total) / n;
    while (cum[j + 1] < s) j++;
    const f = (s - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-9);
    const a = dense[j], b = dense[(j + 1) % dense.length];
    pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  // Yumuşatma: köşeler yuvarlanır, en dar viraj pist genişliği kadar olur
  for (let it = 0; it < SMOOTH; it++) {
    pts = pts.map((p, i) => {
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      return [0.5 * p[0] + 0.25 * (a[0] + b[0]), 0.5 * p[1] + 0.25 * (a[1] + b[1])];
    });
  }
  const t: Track = { n, px: new Float32Array(n), pz: new Float32Array(n), tx: new Float32Array(n), tz: new Float32Array(n), length: 0 };
  for (let i = 0; i < n; i++) {
    t.px[i] = pts[i][0];
    t.pz[i] = pts[i][1];
    t.length += Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]);
  }
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    t.tx[i] = (b[0] - a[0]) / l;
    t.tz[i] = (b[1] - a[1]) / l;
  }
  return t;
}

const cache = new Map<number, Track>();
export function trackOf(i: number): Track {
  const k = Math.max(0, Math.min(TRACKS.length - 1, Math.floor(i) || 0));
  let t = cache.get(k);
  if (!t) cache.set(k, (t = build(TRACKS[k])));
  return t;
}

export interface Projection {
  /** En yakın orta çizgi noktası. */
  i: number;
  /** Orta çizgiden yana uzaklık: + sağ (gidiş yönüne göre). */
  d: number;
}

/**
 * Noktanın pistteki yeri. `hint` (önceki i) verilirse yalnızca çevresine bakılır: pistin iki kolu
 * birbirine yakın olsa da araç yanlış kola "ışınlanmaz".
 */
export function project(t: Track, x: number, z: number, hint = -1): Projection {
  let best = 0, bd = Infinity;
  const scan = (i: number) => {
    const k = ((i % t.n) + t.n) % t.n;
    const d = (x - t.px[k]) ** 2 + (z - t.pz[k]) ** 2;
    if (d < bd) [bd, best] = [d, k];
  };
  if (hint >= 0) for (let i = hint - 30; i <= hint + 30; i++) scan(i);
  else for (let i = 0; i < t.n; i++) scan(i);
  // Sağ normal (teğet saat yönünde döndürülmüş): (−tz, tx)
  const d = (x - t.px[best]) * -t.tz[best] + (z - t.pz[best]) * t.tx[best];
  return { i: best, d };
}

export function sectorOf(t: Track, i: number): number {
  return Math.min(RACE.sectors - 1, Math.floor((i / t.n) * RACE.sectors));
}

/** Tur ilerlemesi: `next` beklenen sektör. Başlangıçta araçlar son sektörde (çizginin gerisinde), lap 0. */
export interface Progress {
  lap: number;
  next: number;
}

export function newProgress(): Progress {
  return { lap: 0, next: 0 };
}

/** Araç `i`'deyken ilerlemeyi günceller; beklenen sektöre girdiyse ilerler, 0. sektöre girince tur artar. */
export function advance(t: Track, p: Progress, i: number): void {
  if (sectorOf(t, i) !== p.next) return;
  if (p.next === 0) p.lap++;
  p.next = (p.next + 1) % RACE.sectors;
}

/** Sıralama için toplam ilerleme (tur × sektör + sektör içi konum). */
export function score(t: Track, p: Progress, i: number): number {
  const sec = (p.next - 1 + RACE.sectors) % RACE.sectors;
  const within = (i / t.n) * RACE.sectors - sectorOf(t, i);
  return (p.lap - 1) * RACE.sectors + sec + Math.max(0, Math.min(1, within));
}

/** Başlangıç dizilişi: çizginin gerisinde iki sıra, şaşırtmalı. */
export function gridSpot(t: Track, slot: number): { x: number; z: number; a: number } {
  const row = Math.floor(slot / 2), side = slot % 2 ? 1 : -1;
  const i = (t.n - 4 - row * 5 - (slot % 2) * 2 + t.n) % t.n;
  const nx = -t.tz[i], nz = t.tx[i];
  return { x: t.px[i] + nx * side * 2.3, z: t.pz[i] + nz * side * 2.3, a: Math.atan2(t.tz[i], t.tx[i]) };
}

// ---------------------------------------------------------------------------
// Araba
// ---------------------------------------------------------------------------

export const CAR = {
  len: 4.2,
  wid: 2.2,
  /** Çarpışma yarıçapı (duvar ve diğer arabalar). */
  r: 1.4,
  accel: 38,
  brake: 70,
  reverse: 20,
  maxV: 32,
  maxRev: 11,
  boostV: 46,
  boostAccel: 60,
  /** Hava/sürtünme (hızın bu oranı/sn). */
  drag: 0.5,
  /** Dönüş (rad/sn, hızlıyken). */
  turn: 2.9,
  /** Yanal tutunma: yan kayma bu hızla söner. Driftte azalır, dönüş artar. */
  grip: 9,
  driftGrip: 1.6,
  driftTurn: 1.55,
  /** Drift bu hızın altında başlamaz/sürmez. */
  driftMin: 11,
  /** Drift nitro doldurur (sn başına, tam kaymada); E basılıyken nitro bu hızla biter. */
  fill: 0.42,
  burn: 0.5,
};

export interface CarState {
  x: number;
  z: number;
  a: number;
  vx: number;
  vz: number;
  /** 0…1 nitro deposu. */
  nitro: number;
  drift: boolean;
  boost: boolean;
  /** Son izdüşüm (pistte arama ipucu). */
  hint: number;
}

export interface CarInput {
  /** +1 gaz, −1 fren/geri. */
  throttle: number;
  /** +1 sağa, −1 sola. */
  steer: number;
  drift: boolean;
  nitro: boolean;
}

export function newCar(t: Track, slot: number): CarState {
  const g = gridSpot(t, slot);
  return { x: g.x, z: g.z, a: g.a, vx: 0, vz: 0, nitro: 0, drift: false, boost: false, hint: project(t, g.x, g.z).i };
}

/** Bayraklar (ağda): 1 drift, 2 nitro. */
export function carFlags(c: CarState): number {
  return (c.drift ? 1 : 0) | (c.boost ? 2 : 0);
}

/** Bir fizik adımı. Duvara çarptıysa çarpma hızını (0 değilse) döner. */
export function stepCar(c: CarState, inp: CarInput, dt: number, t: Track): number {
  const fx = Math.cos(c.a), fz = Math.sin(c.a);
  const rx = -fz, rz = fx;
  let fwd = c.vx * fx + c.vz * fz;
  let lat = c.vx * rx + c.vz * rz;

  // Drift: Space basılı, dönerken ve yeterince hızlıyken
  const wantDrift = inp.drift && Math.abs(inp.steer) > 0.15;
  c.drift = wantDrift && fwd > (c.drift ? CAR.driftMin * 0.7 : CAR.driftMin);
  c.boost = inp.nitro && c.nitro > 0.01 && fwd > -1;

  // Direksiyon: duruyorken dönmez, geri giderken ters
  const speedK = Math.min(1, Math.abs(fwd) / 10) * Math.sign(fwd || 1);
  c.a += inp.steer * CAR.turn * speedK * (c.drift ? CAR.driftTurn : 1) * dt;

  if (inp.throttle > 0) fwd += (CAR.accel + (c.boost ? CAR.boostAccel : 0)) * inp.throttle * dt;
  else if (inp.throttle < 0) fwd += (fwd > 0.5 ? -CAR.brake : -CAR.reverse) * -inp.throttle * dt;
  else if (c.boost) fwd += CAR.boostAccel * dt;
  fwd -= fwd * CAR.drag * dt;
  const top = c.boost ? CAR.boostV : CAR.maxV;
  if (fwd > top) fwd = Math.max(top, fwd - 60 * dt); // nitro bitince yavaşça iner
  if (fwd < -CAR.maxRev) fwd = -CAR.maxRev;
  lat *= Math.exp(-(c.drift ? CAR.driftGrip : CAR.grip) * dt);

  if (c.drift) c.nitro = Math.min(1, c.nitro + CAR.fill * dt * Math.min(1, 0.35 + Math.abs(lat) / 8));
  if (c.boost) c.nitro = Math.max(0, c.nitro - CAR.burn * dt);

  const nfx = Math.cos(c.a), nfz = Math.sin(c.a);
  c.vx = nfx * fwd - nfz * lat;
  c.vz = nfz * fwd + nfx * lat;
  c.x += c.vx * dt;
  c.z += c.vz * dt;

  // Duvarlar: pistin iki yanı. Dışarı taşınca içeri itilir, dik hız seker ve azalır.
  const p = project(t, c.x, c.z, c.hint);
  c.hint = p.i;
  const lim = RACE.halfW - CAR.r * 0.6;
  if (Math.abs(p.d) <= lim) return 0;
  const s = Math.sign(p.d);
  const nx = -t.tz[p.i] * s, nz = t.tx[p.i] * s;
  const over = Math.abs(p.d) - lim;
  c.x -= nx * over;
  c.z -= nz * over;
  const vn = c.vx * nx + c.vz * nz;
  if (vn <= 0) return 0;
  c.vx -= nx * vn * 1.35;
  c.vz -= nz * vn * 1.35;
  c.vx *= 0.94;
  c.vz *= 0.94;
  return vn;
}

/**
 * Basit otomatik pilot (testler ve antrenman botları): ilerideki orta çizgi noktasına döner, viraj
 * sertse yavaşlar, virajda drift atar; `skill` 0…1 hız çarpanı.
 */
export function autopilot(t: Track, c: CarState, skill = 1): CarInput {
  const p = project(t, c.x, c.z, c.hint);
  const speed = Math.hypot(c.vx, c.vz);
  const ahead = (p.i + Math.round(6 + speed * 0.25)) % t.n;
  const want = Math.atan2(t.pz[ahead] - c.z, t.px[ahead] - c.x);
  const err = Math.atan2(Math.sin(want - c.a), Math.cos(want - c.a));
  const far = (p.i + 14) % t.n;
  const bend = Math.abs(Math.atan2(t.tx[p.i] * t.tz[far] - t.tz[p.i] * t.tx[far], t.tx[p.i] * t.tx[far] + t.tz[p.i] * t.tz[far]));
  const target = Math.max(9, 31 - bend * 16) * (0.8 + 0.2 * skill);
  return { throttle: speed > target ? -0.5 : 1, steer: Math.max(-1, Math.min(1, err * 2.5)), drift: bend > 0.5 && speed > 14, nitro: c.nitro > 0.5 && bend < 0.3 };
}

/** İki rapor arasında arabanın gidebileceği en uzun yol (sunucu doğrulaması, pay dahil). */
export function maxTravel(ms: number): number {
  return CAR.boostV * 1.3 * (ms / 1000) + 3;
}
