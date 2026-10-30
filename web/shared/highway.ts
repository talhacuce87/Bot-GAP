// Otoyol: sonsuz, virajlı ve yokuşlu çift yönlü yol. Yolun orta çizgisi tohumdan üretilir (herkes aynı yolu görür):
// virajlar yumuşak geçişli (eğrilik doğrusal değişir), yokuşlar kademeli. Ortada beton bariyer var; birkaç kilometrede
// bir kısa açıklık bırakılır, ters şeride yalnızca oradan geçilir. Trafik yol üstünde tanımlıdır (s: yol boyunca,
// d: yana) ve saatten hesaplanır; şeritlerinden çıkmaz. Sürüş oyunun kendi araba fiziğiyle (istemcide, Player);
// burada yol, trafik, makas puanı, hasar ve kaza kuralı var.
// Eksenler: yön açısı θ, ileri (sin θ, cos θ), sol (cos θ, −sin θ). d > 0 sol (karşı şeritler), d < 0 gidiş şeritleri.

export const HW = {
  laneW: 3.6,
  /** Orta beton bariyerin yarı genişliği ve şeritlerin başladığı yer (bariyer + iç emniyet payı). */
  barrier: 0.3,
  median: 0.6,
  /** Dış otokorkuluk orta çizgiden bu kadar uzakta (iki şerit + emniyet şeridi). */
  rail: 0.6 + 2 * 3.6 + 2.2,
  /** Arabanın yarı genişliği ve boyu (Tofaş). */
  halfW: 0.82,
  length: 4.34,
  /** Çarpmanın şiddeti (oyunun çarpışma ölçüsü) bunu aşarsa kaza; altı sürtme ve ittirme. */
  hard: 11,
  /** Doğunca (ve tekrar başlayınca) çarpışmasız süre (sn). */
  ghost: 2,
  /** Puan bu hızın altında sayılmaz (m/sn, ~43 km/s); hız çarpanı `fast`ta ×2'ye ulaşır. */
  scoreV: 12,
  fastV: 32,
  /** Makasların kombo sayılması için en çok bu kadar arayla gelmesi gerekir (sn). */
  comboGap: 4,
};

/** Şeritler: yana uzaklık ve trafiğin hızı (eksi: karşıdan gelen). 0–1 gidiş (sol hızlı), 2–3 karşı. */
export const LANES = [
  { d: -(HW.median + HW.laneW * 0.5), v: 19 },
  { d: -(HW.median + HW.laneW * 1.5), v: 14 },
  { d: HW.median + HW.laneW * 0.5, v: -18 },
  { d: HW.median + HW.laneW * 1.5, v: -14 },
];

/** Tamsayı karması → [0, 1). */
export function hash(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(a + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(b ^ 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// ---- Yol ----

/** Örnek aralığı (m). */
export const ROAD_STEP = 2;
/** Eğriliğin ve eğimin bir değerden ötekine geçtiği yol (m): viraja ve yokuşa yumuşak giriş. */
const CURVE_RAMP = 70;
const GRADE_RAMP = 90;
/** Yön açısı ve yükseklik bu sınırlara yaklaşınca yol geri döner (yol kendi üstüne kıvrılmaz, dağa tırmanmaz). */
const MAX_HEADING = 0.9;
const MAX_HEIGHT = 28;

export interface RoadPoint {
  x: number;
  z: number;
  /** Yükseklik, yön açısı, eğim (dh/ds) ve eğrilik (1/m, + sola). */
  h: number;
  th: number;
  g: number;
  k: number;
}

export interface RoadProjection {
  /** Yol boyunca konum, orta çizgiden yana uzaklık (+ sol) ve en yakın örnek. */
  s: number;
  d: number;
  i: number;
}

interface Plan {
  /** Bu bölümün başı/sonu (s) ve başlangıç/hedef değeri (eğrilik ya da eğim). */
  start: number;
  end: number;
  from: number;
  to: number;
  n: number;
}

/**
 * Yolun orta çizgisi: ilerledikçe örneklenir (2 m'de bir) ve saklanır. Bölümler sırayla seçilir: düz, sağa ya da
 * sola viraj (yarıçap 200–800 m); dikeyde düz, yokuş ya da iniş (±%6). Her bölümün başında değer bir öncekinden
 * yumuşakça geçer. Orta bariyerin açıklıkları da aynı tohumdan.
 */
export class Road {
  private xs: number[] = [0];
  private zs: number[] = [0];
  private hs: number[] = [0];
  private ths: number[] = [0];
  private curve: Plan = { start: 0, end: 0, from: 0, to: 0, n: 0 };
  private grade: Plan = { start: 0, end: 0, from: 0, to: 0, n: 0 };
  private gaps: [number, number][] = [];

  constructor(readonly seed: number) {}

  /** Örneklenmiş uzunluk (m). */
  get length(): number {
    return (this.xs.length - 1) * ROAD_STEP;
  }

  private static value(p: Plan, s: number, ramp: number): number {
    return p.from + (p.to - p.from) * Math.min(1, Math.max(0, (s - p.start) / ramp));
  }

  /** `s`e kadar örnekle. */
  ensure(s: number): void {
    while (this.length < s) this.extend();
  }

  private extend(): void {
    const i = this.xs.length - 1, s = i * ROAD_STEP, mid = s + ROAD_STEP / 2;
    if (s >= this.curve.end) this.nextCurve(s);
    if (s >= this.grade.end) this.nextGrade(s);
    const th0 = this.ths[i], th1 = th0 + Road.value(this.curve, mid, CURVE_RAMP) * ROAD_STEP, thm = (th0 + th1) / 2;
    this.ths.push(th1);
    this.xs.push(this.xs[i] + Math.sin(thm) * ROAD_STEP);
    this.zs.push(this.zs[i] + Math.cos(thm) * ROAD_STEP);
    this.hs.push(this.hs[i] + Road.value(this.grade, mid, GRADE_RAMP) * ROAD_STEP);
  }

  private nextCurve(s: number): void {
    const n = this.curve.n + 1, th = this.ths[this.ths.length - 1];
    const from = Road.value(this.curve, s, CURVE_RAMP);
    let to = 0, len: number;
    if (n === 1) len = 300;
    else if (hash(this.seed, 1000, n) < 0.3) len = 150 + hash(this.seed, 1001, n) * 400;
    else {
      const r = 200 + hash(this.seed, 1002, n) * 600;
      // Yön sınıra yaklaştıysa viraj geri döndürür; yoksa yazı tura
      const side = Math.abs(th) > MAX_HEADING * 0.4 ? -Math.sign(th) : hash(this.seed, 1003, n) < 0.5 ? 1 : -1;
      to = side / r;
      // Viraj en çok bu kadar döndürür (yol kendi üstüne kıvrılmasın)
      const turn = Math.min(0.2 + hash(this.seed, 1004, n) * 0.5, Math.max(0.1, MAX_HEADING - side * th));
      len = CURVE_RAMP + turn * r;
    }
    this.curve = { start: s, end: s + len, from, to, n };
  }

  private nextGrade(s: number): void {
    const n = this.grade.n + 1, h = this.hs[this.hs.length - 1];
    const from = Road.value(this.grade, s, GRADE_RAMP);
    let to = 0, len = 150 + hash(this.seed, 2001, n) * 350;
    if (n === 1) len = 400;
    else if (hash(this.seed, 2000, n) > 0.25) {
      to = 0.015 + hash(this.seed, 2002, n) * 0.045;
      // Yükseklik sınırına yaklaştıysa ters yöne
      const up = Math.abs(h) > MAX_HEIGHT * 0.5 ? h < 0 : hash(this.seed, 2003, n) < 0.5;
      if (!up) to = -to;
      // Bu bölüm sınırı aşmasın
      len = Math.min(len, Math.max(GRADE_RAMP + 20, (MAX_HEIGHT - Math.sign(to) * h) / Math.abs(to)));
    }
    this.grade = { start: s, end: s + len, from, to, n };
  }

  /** `s`teki nokta (başlangıçtan öncesi düz geri uzanır). */
  at(s: number, out: RoadPoint = { x: 0, z: 0, h: 0, th: 0, g: 0, k: 0 }): RoadPoint {
    if (s <= 0) return Object.assign(out, { x: 0, z: s, h: 0, th: 0, g: 0, k: 0 });
    this.ensure(s + ROAD_STEP);
    const u = s / ROAD_STEP, i = Math.floor(u), f = u - i;
    const lerp = (a: number[]) => a[i] + (a[i + 1] - a[i]) * f;
    out.x = lerp(this.xs);
    out.z = lerp(this.zs);
    out.h = lerp(this.hs);
    out.th = lerp(this.ths);
    out.g = (this.hs[i + 1] - this.hs[i]) / ROAD_STEP;
    out.k = (this.ths[i + 1] - this.ths[i]) / ROAD_STEP;
    return out;
  }

  /** Yol üstündeki (s, d) noktasının dünyadaki yeri (x, z) ve yolun o noktadaki yüksekliği. */
  world(s: number, d: number, out = { x: 0, z: 0, h: 0, th: 0 }): { x: number; z: number; h: number; th: number } {
    const p = this.at(s, tmp);
    out.x = p.x + Math.cos(p.th) * d;
    out.z = p.z - Math.sin(p.th) * d;
    out.h = p.h;
    out.th = p.th;
    return out;
  }

  /**
   * Noktanın yoldaki yeri. `hint` (önceki örnek) verilirse yalnızca çevresine bakılır; yoksa bütün örnekler
   * taranır (yol kendi üstüne kıvrılmadığı için en yakın örnek doğrudur).
   */
  project(x: number, z: number, hint = -1): RoadProjection {
    const n = this.xs.length;
    let lo = 0, hi = n - 1, stride = 8;
    if (hint >= 0) {
      this.ensure((hint + 60) * ROAD_STEP);
      [lo, hi, stride] = [Math.max(0, hint - 40), Math.min(this.xs.length - 1, hint + 40), 1];
    }
    let best = lo, bd = Infinity;
    for (let i = lo; i <= hi; i += stride) {
      const d = (x - this.xs[i]) ** 2 + (z - this.zs[i]) ** 2;
      if (d < bd) [bd, best] = [d, i];
    }
    // İpucu yanlışsa (ışınlanma) en yakın nokta pencerenin kenarında kalır: bütün yolu tara
    if (stride === 1 && ((best === lo && lo > 0) || (best === hi && hi < this.xs.length - 1))) return this.project(x, z);
    if (stride > 1) {
      for (let i = Math.max(0, best - stride); i <= Math.min(this.xs.length - 1, best + stride); i++) {
        const d = (x - this.xs[i]) ** 2 + (z - this.zs[i]) ** 2;
        if (d < bd) [bd, best] = [d, i];
      }
    }
    // Komşu iki parçadan hangisine düşüyorsa ona izdüş
    let s = best * ROAD_STEP;
    for (const j of [best - 1, best]) {
      if (j < 0 || j + 1 >= this.xs.length) continue;
      const ex = this.xs[j + 1] - this.xs[j], ez = this.zs[j + 1] - this.zs[j];
      const t = ((x - this.xs[j]) * ex + (z - this.zs[j]) * ez) / (ex * ex + ez * ez);
      if (t >= 0 && t <= 1) {
        s = (j + t) * ROAD_STEP;
        break;
      }
    }
    if (best === 0 && z < 0) s = z;
    const p = this.at(s, tmp);
    return { s, d: (x - p.x) * Math.cos(p.th) - (z - p.z) * Math.sin(p.th), i: Math.max(0, Math.round(s / ROAD_STEP)) };
  }

  /** Orta bariyerin açıklığı `s`i kapsıyorsa [başı, sonu]; yoksa null. Açıklıklar 2–5 km'de bir, 140–260 m. */
  gapAt(s: number): [number, number] | null {
    if (!this.gaps.length) this.gaps.push(this.gap(1, 900 + hash(this.seed, 3000, 0) * 600));
    while (this.gaps[this.gaps.length - 1][1] < s) {
      const n = this.gaps.length + 1, prev = this.gaps[this.gaps.length - 1][1];
      this.gaps.push(this.gap(n, prev + 1800 + hash(this.seed, 3000, n) * 2800));
    }
    for (let k = this.gaps.length - 1; k >= 0; k--) {
      const g = this.gaps[k];
      if (s >= g[0] && s <= g[1]) return g;
      if (g[1] < s) break;
    }
    return null;
  }

  /** [a, b] aralığındaki açıklıklar (çizim için). */
  gapsIn(a: number, b: number): [number, number][] {
    this.gapAt(b);
    return this.gaps.filter((g) => g[1] >= a && g[0] <= b);
  }

  private gap(n: number, start: number): [number, number] {
    return [start, start + 140 + hash(this.seed, 3001, n) * 120];
  }
}

const tmp: RoadPoint = { x: 0, z: 0, h: 0, th: 0, g: 0, k: 0 };

// ---- Trafik ----

/** Bir şeritte arabaların yer aldığı aralık (m); her yuvada araba olabilir ya da olmayabilir. */
const SLOT = 26;
/** Yuva içinde kayma: iki araba arasında en az ~6 m kalır. */
const JITTER = SLOT - 11;

export interface TrafficCar {
  id: number;
  lane: number;
  /** Yol üstündeki yeri ve hızı (m/sn, yol boyunca). */
  s: number;
  d: number;
  v: number;
  /** Görünüm (istemci TRAFFIC_LOOKS'tan seçer). */
  look: number;
}

/** Yuvalar boyunca yavaş değişen yoğunluk: seyrek ve sıkışık bölümler sırayla gelir. */
function density(seed: number, lane: number, k: number): number {
  const u = k / 9, i = Math.floor(u), f = u - i, sm = f * f * (3 - 2 * f);
  const n = hash(seed, lane + 100, i) * (1 - sm) + hash(seed, lane + 100, i + 1) * sm;
  return (lane < 2 ? 0.42 : 0.34) + (n - 0.5) * 0.5;
}

/** `t` anında (sn) yol üstünde [sMin, sMax] aralığındaki trafik arabaları. */
export function trafficAt(seed: number, t: number, sMin: number, sMax: number, out: TrafficCar[] = []): TrafficCar[] {
  out.length = 0;
  for (let lane = 0; lane < LANES.length; lane++) {
    const { d, v } = LANES[lane];
    const shift = v * t;
    const k0 = Math.floor((sMin - shift - JITTER / 2) / SLOT), k1 = Math.ceil((sMax - shift + JITTER / 2) / SLOT);
    for (let k = k0; k <= k1; k++) {
      if (hash(seed, lane, k) >= density(seed, lane, k)) continue;
      const s = k * SLOT + (hash(seed, lane + 10, k) - 0.5) * JITTER + shift;
      if (s < sMin || s > sMax) continue;
      out.push({ id: k * 4 + lane, lane, s, d, v, look: Math.floor(hash(seed, lane + 20, k) * 1e6) });
    }
  }
  return out;
}

/** Bekleyen trafik arabası öndekine (ya da oyuncuya) en çok bu kadar yaklaşır (merkezden merkeze, m). */
const FOLLOW = 8;
/** Önü açılınca çizelgesine yetişme hızı (m/sn): biraz daha hızlı gider. */
const CATCH_UP = 3;

/**
 * Arkadan gelen trafik oyuncuya çarpmaz: aynı yönde, aynı şeritte önünde yavaş bir oyuncu varsa yavaşlayıp
 * arkasında bekler (arkasındakiler de sırayla); önü açılınca biraz hızlanıp çizelgesine yetişir. Yereldir (dünyadaki
 * NPC trafiği gibi): araba kendi saatteki yerinden `gecikme` kadar geride çizilir. Karşıdan gelenler beklemez.
 */
export class TrafficYield {
  private delay = new Map<number, number>();

  /** `cars`ın yerlerini (s) beklemeye göre düzeltir; oyuncu (s, d)'de. */
  apply(cars: TrafficCar[], s: number, d: number, dt: number): void {
    const seen = new Set<number>();
    for (let lane = 0; lane < LANES.length; lane++) {
      // Önden arkaya: arkadaki öndekini geçmez
      const list = cars.filter((c) => c.lane === lane).sort((a, b) => b.s - a.s);
      let limit = Infinity, blocked = false;
      for (const c of list) {
        let del = Math.max(0, (this.delay.get(c.id) ?? 0) - CATCH_UP * dt);
        if (!blocked && c.v > 0 && Math.abs(c.d - d) < 2.6 && c.s - del <= s) {
          limit = Math.min(limit, s - FOLLOW);
          blocked = true;
        }
        if (c.s - del > limit) del = c.s - limit;
        c.s -= del;
        limit = c.s - FOLLOW;
        if (del > 0) this.delay.set(c.id, del);
        else this.delay.delete(c.id);
        seen.add(c.id);
      }
    }
    for (const id of this.delay.keys()) if (!seen.has(id)) this.delay.delete(id);
  }
}

// ---- Puan, hasar, kaza ----

export type HwEvent =
  | { k: "near"; tier: number; pts: number; combo: number; gap: number; side: number; oncoming: boolean }
  | { k: "bump"; impact: number }
  | { k: "crash"; impact: number };

/**
 * Makas dereceleri: gövdeler arası boşluk (m) en çok bu kadarsa; taban puan. İki araba kendi şeritlerinin
 * ortasındayken boşluk ~1,96 m: yan şeritteki arabayı geçmek en az "MAKAS"tır, çizgiye yaklaştıkça artar.
 */
export const TIERS = [
  { gap: 0.5, name: "KIL PAYI!", pts: 400 },
  { gap: 1.1, name: "ÇOK YAKIN!", pts: 200 },
  { gap: 2.1, name: "MAKAS!", pts: 100 },
];

/** Karşı şeritte mi (orta bariyerin solunda). */
export const wrongWay = (d: number) => d > HW.barrier;

/** Makas puanı: taban × hız (1–2) × karşı şerit (1,5) × kombo (her makas +0,5, en çok 5). */
export function nearMissPoints(tier: number, v: number, wrong: boolean, combo: number): number {
  const speed = 1 + Math.max(0, Math.min(1, (v - HW.scoreV) / (HW.fastV - HW.scoreV)));
  const mult = Math.min(5, 1 + 0.5 * (combo - 1));
  return Math.round((TIERS[tier].pts * speed * (wrong ? 1.5 : 1) * mult) / 5) * 5;
}

/** Çarpmanın hasarı (%): hafif temas az, sert temas çok. */
export const bumpDamage = (impact: number) => 5 + impact * 4;

interface Pass {
  /** Arabanın önünde görüldü mü (geçilecek araba). */
  ahead: boolean;
  /** Yan yanayken gövdeler arası en küçük boşluk. */
  gap: number;
  /** Değdi ya da çarpışmasızken yanından geçildi: makas sayılmaz. */
  touched: boolean;
  done: boolean;
  /** Son görüldüğü kare. */
  seen: number;
}

export interface RunStats {
  score: number;
  /** Gidilen yol (m), en yüksek hız (m/sn), makas sayısı, en uzun kombo, süre (sn). */
  dist: number;
  top: number;
  near: number;
  bestCombo: number;
  time: number;
}

/**
 * Bir sürüş: puan, kombo, hasar ve istatistikler. Her kare arabanın yol üstündeki yeri, hızı ve çevredeki trafik
 * verilir: önünden yanından geçilen arabalar makas puanı getirir, hızlı giderken yol puanı akar (4 m'de bir puan,
 * karşı şeritte iki katı). Çarpmalar (araba ya da bariyer) `hit` ile gelir.
 */
export class HwRun {
  stats: RunStats = { score: 0, dist: 0, top: 0, near: 0, bestCombo: 0, time: 0 };
  combo = 0;
  /** Son makastan beri geçen süre (sn): kombo `comboGap`'te biter. */
  sinceNear = Infinity;
  damage = 0;
  alive = true;
  ghost = HW.ghost;
  private passes = new Map<number, Pass>();
  private frame = 0;
  private lastS: number | null = null;

  /** Bir kare: arabanın yol üstündeki yeri (s, d), ileri hızı (m/sn) ve çevredeki trafik. Makaslar döner. */
  update(s: number, d: number, v: number, dt: number, cars: TrafficCar[]): HwEvent[] {
    const ev: HwEvent[] = [];
    if (!this.alive) return ev;
    const st = this.stats;
    st.time += dt;
    st.top = Math.max(st.top, v);
    this.ghost = Math.max(0, this.ghost - dt);
    const moved = this.lastS === null ? 0 : s - this.lastS;
    this.lastS = s;
    // Geri gitmek ve ışınlanma (yeniden başlama) sayılmaz
    if (moved > 0 && moved < 60) {
      st.dist += moved;
      if (v >= HW.scoreV) st.score += (moved / 4) * (wrongWay(d) ? 2 : 1);
    }
    this.sinceNear += dt;
    if (this.sinceNear > HW.comboGap) this.combo = 0;
    this.passCheck(s, d, v, cars, ev);
    return ev;
  }

  /** Bu trafik arabasına değildi: ondan makas puanı yok. */
  touch(id: number): void {
    const p = this.passes.get(id);
    if (p) p.touched = true;
    else this.passes.set(id, { ahead: false, gap: Infinity, touched: true, done: true, seen: this.frame });
  }

  /** Çarpma (araba ya da bariyer): sertse kaza, değilse hasar; her temas komboyu bozar. */
  hit(impact: number): HwEvent | null {
    if (!this.alive || this.ghost > 0) return null;
    this.combo = 0;
    if (impact > HW.hard) {
      this.alive = false;
      this.damage = 100;
      return { k: "crash", impact };
    }
    this.damage = Math.min(100, this.damage + bumpDamage(impact));
    if (this.damage >= 100) {
      this.alive = false;
      return { k: "crash", impact };
    }
    return { k: "bump", impact };
  }

  /** Geçilen arabalar: önündeyken görülüp arkada kalan, yan yanayken boşluğu yeterince dar olan makastır. */
  private passCheck(s: number, d: number, v: number, cars: TrafficCar[], ev: HwEvent[]): void {
    const frame = ++this.frame;
    for (const t of cars) {
      const ds = t.s - s;
      let p = this.passes.get(t.id);
      if (!p) this.passes.set(t.id, (p = { ahead: ds > 0, gap: Infinity, touched: false, done: false, seen: frame }));
      p.seen = frame;
      if (p.done) continue;
      if (ds > 0) p.ahead = true;
      if (Math.abs(ds) < HW.length) {
        p.gap = Math.min(p.gap, Math.abs(t.d - d) - 2 * HW.halfW);
        if (this.ghost > 0) p.touched = true;
      }
      if (ds > -HW.length * 0.6) continue;
      p.done = true;
      const tier = TIERS.findIndex((x) => p.gap <= x.gap);
      if (!p.ahead || p.touched || tier < 0 || v < HW.scoreV) continue;
      this.combo++;
      this.sinceNear = 0;
      const pts = nearMissPoints(tier, v, wrongWay(d), this.combo);
      this.stats.score += pts;
      this.stats.near++;
      this.stats.bestCombo = Math.max(this.stats.bestCombo, this.combo);
      ev.push({ k: "near", tier, pts, combo: this.combo, gap: Math.max(0, p.gap), side: Math.sign(t.d - d), oncoming: t.v < 0 });
    }
    // Görüş alanından çıkanları unut
    if (frame % 60 === 0) for (const [id, p] of this.passes) if (frame - p.seen > 120) this.passes.delete(id);
  }
}
