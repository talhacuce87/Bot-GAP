// GAP Ring: casino otoparkının arkasındaki (şehrin kuzeyi) yarış pisti ve yarış kuralları. Pistin orta çizgisi,
// grid kutuları, kontrol noktaları; F1 usulü start (5 kırmızı lamba saniyede bir yanar, rastgele beklemeden sonra
// hepsi söner = start), tur sayımı, sıralama, arayla fark, erken kalkış cezası ve ödüller. Saf mantık: sunucu
// yetkilidir (konumlardan sayar), istemci aynı pisti çizer ve arayüzü gösterir.
import { CITY_DX } from "./zones";

/** Pist alanı (dünyanın yürünür alanına eklenir; çevresi tepe). Güney kenarı şehre (otoparka) bağlanır. */
export const RACE_AREA = { minX: 394 + CITY_DX, maxX: 544 + CITY_DX, minZ: -292, maxZ: -116 };
/** Asfaltın yarı genişliği. */
export const TRACK_HALF = 6;
/** Bariyerler orta çizgiden bu kadar uzakta (asfalt + kaçış şeridi). */
export const BARRIER = TRACK_HALF + 3.5;
/** Pite giriş: ana düzlüğün güney bariyerindeki açıklık (otoparktan gelen yol buradan girer). */
export const PIT_GATE = { x: 466 + CITY_DX, half: 7 };
export const MAX_RACERS = 8;
export const RACE_LAPS = [1, 3, 5] as const;
/** İlk üçe test coin (en az iki yarışçı varsa). */
export const RACE_PRIZES = [2000, 1000, 500];
/** Erken kalkış cezası (ms) ve lambalar yanarken gridden izin verilen kayma (m). */
export const JUMP_PENALTY = 5000;
export const JUMP_TOLERANCE = 1.6;
/** Lambalar: her biri saniyede bir yanar; beşincisinden sonra 0,2–3 sn rastgele bekleme, sonra söner. */
export const LIGHT_STEP = 1000;
export const LIGHTS_DELAY = 1500;
/** İlk yarışçı bitirince diğerlerine kalan süre; sonuç ekranı süresi. */
export const FINISH_GRACE = 30_000;
export const RESULTS_MS = 12_000;
/** Kontrol noktası sayısı (bitiş çizgisi dahil); hepsi sırayla geçilmeden tur sayılmaz. */
export const CHECKPOINTS = 10;

/** Orta çizginin kontrol noktaları, sürüş yönünde. Ana düzlük güneyde (doğuya), sonra doğu kanadı kuzeye,
 *  saç tokası, kuzey düzlüğü batıya, batıda S virajları ve ana düzlüğe dönüş. */
const CONTROL: [number, number][] = ([
  [424, -138], [464, -138], [504, -138],
  [525, -146], [533, -168], [532, -198], [528, -226],
  [530, -252], [520, -272], [494, -281], [462, -280],
  [434, -270], [418, -248], [424, -224], [448, -213],
  [463, -201], [461, -183], [442, -171], [420, -170],
  [408.7, -165.3], [404, -154], [408.7, -142.7],
] as [number, number][]).map(([x, z]) => [x + CITY_DX, z]);

export interface TrackPoint {
  x: number;
  z: number;
  /** Başlangıçtan yay uzunluğu. */
  s: number;
  /** Birim yön (sürüş yönü). */
  dx: number;
  dz: number;
}

/** Kapalı Catmull-Rom eğrisi, ~1,5 m aralıklı. */
function buildTrack(): { pts: TrackPoint[]; length: number } {
  const n = CONTROL.length;
  const raw: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = CONTROL[(i - 1 + n) % n], p1 = CONTROL[i], p2 = CONTROL[(i + 1) % n], p3 = CONTROL[(i + 2) % n];
    const steps = Math.max(4, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 1.5));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const c = (a: number, b: number, cc: number, d: number) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      raw.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const pts: TrackPoint[] = [];
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    const [x, z] = raw[i], [nx, nz] = raw[(i + 1) % raw.length];
    const l = Math.hypot(nx - x, nz - z) || 1;
    pts.push({ x, z, s, dx: (nx - x) / l, dz: (nz - z) / l });
    s += l;
  }
  return { pts, length: s };
}

const built = buildTrack();
export const TRACK: readonly TrackPoint[] = built.pts;
export const TRACK_LENGTH = built.length;

/** Orta çizgide `s` (yay uzunluğu) noktası: konum ve yön (doğrusal ara değer). */
export function trackAt(s: number): { x: number; z: number; dx: number; dz: number } {
  const L = TRACK_LENGTH;
  s = ((s % L) + L) % L;
  let lo = 0, hi = TRACK.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (TRACK[mid].s <= s) lo = mid;
    else hi = mid - 1;
  }
  const a = TRACK[lo], b = TRACK[(lo + 1) % TRACK.length];
  const segLen = (lo + 1 === TRACK.length ? L : b.s) - a.s;
  const t = segLen > 0 ? (s - a.s) / segLen : 0;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: a.dx, dz: a.dz };
}

/** En yakın orta çizgi noktası: yay uzunluğu `s` ve orta çizgiye uzaklık `d` (işaretli: sürüş yönünün solu +). */
export function trackProject(x: number, z: number): { s: number; d: number } {
  let best = Infinity, bs = 0, bd = 0;
  for (let i = 0; i < TRACK.length; i++) {
    const a = TRACK[i], b = TRACK[(i + 1) % TRACK.length];
    const ex = b.x - a.x, ez = b.z - a.z, len2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / len2));
    const px = a.x + ex * t, pz = a.z + ez * t, dist2 = (x - px) ** 2 + (z - pz) ** 2;
    if (dist2 < best) {
      best = dist2;
      bs = a.s + Math.sqrt(len2) * t;
      // Sol: yönün (dx, dz) 90° saat yönü tersi (dz, -dx)… işaret yalnızca taraf için
      bd = (x - px) * a.dz - (z - pz) * a.dx;
    }
  }
  return { s: bs % TRACK_LENGTH, d: Math.sign(bd) * Math.sqrt(best) };
}

/** Start/bitiş çizgisi: ana düzlükte, pit kapısının doğusunda. */
export const START_S = trackProject(492 + CITY_DX, -138).s;
/** Grid kutuları: çizginin gerisinde iki sıra, kademeli (F1 gibi); yön sürüş yönü. */
export const GRID: { x: number; z: number; rot: number }[] = Array.from({ length: MAX_RACERS }, (_, i) => {
  const back = 9 + i * 5.5, side = i % 2 ? -2.8 : 2.8;
  const p = trackAt(START_S - back);
  // Sol normal (dz, -dx)
  return { x: p.x + p.dz * side, z: p.z - p.dx * side, rot: Math.atan2(p.dx, p.dz) };
});
/** Gridin yakınında mı (kutuya yerleşmek için). */
export const GRID_REACH = 4;

/** Çizgiden sonraki yol (0…L): kontrol noktaları bu ölçekte eşit aralıklı. */
export const lineU = (s: number) => (((s - START_S) % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;

// ---------------------------------------------------------------------------
// Yarış oturumu
// ---------------------------------------------------------------------------

export type RingPhase = "idle" | "lobby" | "lights" | "racing" | "done";

interface Racer {
  sid: number;
  name: string;
  slot: number;
  /** Geçilen kontrol noktası sayısı (bitiş çizgisi dahil; start çizgisini ilk geçiş 1). */
  cps: number;
  /** Son kontrol noktasının zamanı ve her noktanın geçiş zamanı (sıra = cps). */
  times: number[];
  u: number;
  prevU: number;
  penalty: number;
  jumped: boolean;
  /** Lambalar başlarken durduğu yer (erken kalkış buna göre). */
  ref: { x: number; z: number };
  /** Son bilinen konum (yeşil yandığında ilerleme buradan başlar). */
  at: { x: number; z: number };
  lapStart: number;
  bestLap: number | null;
  lastLap: number | null;
  /** Bitiş anı (sunucu saati), null sürüyor. */
  finishAt: number | null;
  dnf: boolean;
}

export interface RingRacer {
  sid: number;
  name: string;
  slot: number;
  /** Sıra (1…). */
  pos: number;
  /** Şu anki tur (1…laps); bitirdiyse laps. */
  lap: number;
  /** Lidere fark (ms) ya da geride kalan tur sayısı (laps). */
  gap: number | null;
  lapsDown: number;
  penalty: number;
  bestLap: number | null;
  lastLap: number | null;
  /** Bitirdiyse toplam süre (ceza dahil). */
  total: number | null;
  dnf: boolean;
  prize: number;
}

export interface RingView {
  phase: RingPhase;
  laps: number;
  host: number;
  /** Lambaların başladığı an (sunucu saati). */
  lightsAt: number;
  /** Start anı: lambalar sönene kadar null (bekleme süresi gizli). */
  goAt: number | null;
  /** İlk bitiren varsa diğerlerinin son anı. */
  endAt: number | null;
  racers: RingRacer[];
}

/** Tamamlanan tur sayısı: ilk geçiş (cps 1) start geçişidir; turlar yalnızca bitiş çizgisinde (cps 11, 21…) artar. */
const lapsOf = (cps: number) => (cps > 0 ? Math.floor((cps - 1) / CHECKPOINTS) : 0);

export class RingSession {
  phase: RingPhase = "idle";
  laps = 3;
  host = 0;
  lightsAt = 0;
  goAt = 0;
  endAt: number | null = null;
  private doneAt = 0;
  private racers = new Map<number, Racer>();
  private prizes = new Map<number, number>();
  /** Bitiş çizgisi geçildi ya da biri bitirdi: hemen yayınlanmalı (tur sayacı çizgide değişsin). */
  urgent = false;

  constructor(private rng: () => number = Math.random) {}

  get count(): number {
    return this.racers.size;
  }

  has(sid: number): boolean {
    return this.racers.has(sid);
  }

  /** Grid kutusuna geç (bekleme/lobi). */
  join(sid: number, name: string, slot: number, x: number, z: number): string | null {
    if (this.phase !== "idle" && this.phase !== "lobby") return "🏁 Yarış sürüyor; bitince katılabilirsin.";
    if (this.racers.has(sid)) return null;
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_RACERS) return "🏁 Geçersiz grid kutusu.";
    if ([...this.racers.values()].some((r) => r.slot === slot)) return "🏁 Bu kutu dolu.";
    const g = GRID[slot];
    if (Math.hypot(x - g.x, z - g.z) > GRID_REACH + 1.5) return "🏁 Grid kutusuna biraz daha yaklaş.";
    this.racers.set(sid, { sid, name, slot, cps: 0, times: [], u: 0, prevU: 0, penalty: 0, jumped: false, ref: { x: GRID[slot].x, z: GRID[slot].z }, at: { x, z }, lapStart: 0, bestLap: null, lastLap: null, finishAt: null, dnf: false });
    if (!this.host || !this.racers.has(this.host)) this.host = sid;
    this.phase = "lobby";
    return null;
  }

  /** Ayrıl: lobide çıkar, yarışta DNF. */
  leave(sid: number): boolean {
    const r = this.racers.get(sid);
    if (!r) return false;
    if (this.phase === "lobby" || this.phase === "idle" || this.phase === "done") {
      this.racers.delete(sid);
      if (this.host === sid) this.host = this.racers.keys().next().value ?? 0;
      if (!this.racers.size && this.phase === "lobby") this.phase = "idle";
    } else if (r.finishAt === null) r.dnf = true;
    return true;
  }

  /** Yarışı başlat (yalnızca grid sahibi): lambalar LIGHTS_DELAY sonra yanmaya başlar. `pos`: yarışçıların şu anki yeri. */
  start(sid: number, laps: number, now: number, pos: (sid: number) => { x: number; z: number } | null = () => null): string | null {
    if (this.phase !== "lobby") return "🏁 Önce gride geç.";
    if (sid !== this.host) return "🏁 Yarışı gridin sahibi başlatır.";
    if (!(RACE_LAPS as readonly number[]).includes(laps)) return "🏁 Tur sayısı 1, 3 ya da 5 olmalı.";
    this.laps = laps;
    this.lightsAt = now + LIGHTS_DELAY;
    this.goAt = this.lightsAt + 5 * LIGHT_STEP + 200 + Math.floor(this.rng() * 2800);
    this.endAt = null;
    this.prizes.clear();
    for (const r of this.racers.values()) {
      r.ref = pos(r.sid) ?? { x: GRID[r.slot].x, z: GRID[r.slot].z };
      r.at = { ...r.ref };
    }
    this.phase = "lights";
    return null;
  }

  /** Yarışçının konumu (her durum güncellemesinde). Değişiklik olduysa true (yayın gerekir). */
  move(sid: number, x: number, z: number, now: number): boolean {
    const r = this.racers.get(sid);
    if (!r || r.dnf || r.finishAt !== null) return false;
    r.at = { x, z };
    if (this.phase === "lobby") {
      // Lobide kutudan uzaklaşan gridden çıkar
      const g = GRID[r.slot];
      if (Math.hypot(x - g.x, z - g.z) > GRID_REACH + 4) return this.leave(sid);
      return false;
    }
    if (this.phase === "lights") {
      if (!r.jumped && Math.hypot(x - r.ref.x, z - r.ref.z) > JUMP_TOLERANCE) {
        r.jumped = true;
        r.penalty += JUMP_PENALTY;
        return true;
      }
      return false;
    }
    if (this.phase !== "racing") return false;
    const p = trackProject(x, z);
    if (Math.abs(p.d) > BARRIER + 4) return false;
    const L = TRACK_LENGTH, seg = L / CHECKPOINTS, u = lineU(p.s);
    r.prevU = r.u;
    r.u = u;
    // Sıradaki kontrol noktası: k = cps % N (0: bitiş çizgisi)
    const k = r.cps % CHECKPOINTS;
    let crossed = false;
    if (k === 0) crossed = r.prevU > L - seg && u < seg;
    else crossed = r.prevU < k * seg && u >= k * seg && u - r.prevU < seg;
    if (!crossed) return false;
    r.cps++;
    r.times.push(now);
    if (k === 0) {
      this.urgent = true;
      const lapsDone = lapsOf(r.cps);
      if (lapsDone >= 1) {
        const t = now - r.lapStart;
        r.lastLap = t;
        if (r.bestLap === null || t < r.bestLap) r.bestLap = t;
      }
      r.lapStart = lapsDone === 0 ? this.goAt : now;
      if (lapsDone >= this.laps) {
        r.finishAt = now;
        if (this.endAt === null) this.endAt = now + FINISH_GRACE;
      }
    }
    return true;
  }

  /** Zamanlayıcı: lambalar → yarış → bitiş → sonuç → boş. Faz değiştiyse true. */
  tick(now: number): boolean {
    if (this.phase === "lights" && now >= this.goAt) {
      this.phase = "racing";
      const seg = TRACK_LENGTH / CHECKPOINTS;
      for (const r of this.racers.values()) {
        // İlerleme yeşil anındaki gerçek yerden başlar; lambalar yanarken çizgiyi geçmiş olan (erken kalkış,
        // cezası yazıldı) start geçişini kaybetmesin, yoksa tur sayacı bir tur geriden gelirdi
        r.u = r.prevU = lineU(trackProject(r.at.x, r.at.z).s);
        r.lapStart = this.goAt;
        if (r.u < TRACK_LENGTH / 2) {
          r.cps = 1 + Math.floor(r.u / seg);
          for (let k = 0; k < r.cps; k++) r.times.push(this.goAt);
        }
      }
      return true;
    }
    if (this.phase === "racing") {
      const all = [...this.racers.values()];
      const running = all.filter((r) => !r.dnf && r.finishAt === null);
      if (!running.length || (this.endAt !== null && now >= this.endAt)) {
        for (const r of running) r.dnf = true;
        this.finish(now);
        return true;
      }
      return false;
    }
    if (this.phase === "done" && now >= this.doneAt) {
      this.phase = "idle";
      this.racers.clear();
      this.host = 0;
      return true;
    }
    return false;
  }

  /** Bitiş: sıralama ve ödüller (en az iki yarışçı varsa ilk üçe). */
  private finish(now: number): void {
    this.phase = "done";
    this.doneAt = now + RESULTS_MS;
    const order = this.standings();
    if (order.length >= 2) {
      order.forEach((r, i) => {
        if (i < RACE_PRIZES.length && !r.dnf && r.finishAt !== null) this.prizes.set(r.sid, RACE_PRIZES[i]);
      });
    }
  }

  /** Bu yarışta kazanılan ödüller (sid → coin), sonuçlandıktan sonra. */
  rewards(): Map<number, number> {
    return new Map(this.prizes);
  }

  private total(r: Racer): number {
    return r.finishAt === null ? Infinity : r.finishAt - this.goAt + r.penalty;
  }

  /** Sıra: bitirenler toplam süreyle (ceza dahil), sonra yarışanlar ilerlemeyle, en sonda DNF. */
  private standings(): Racer[] {
    const seg = TRACK_LENGTH / CHECKPOINTS;
    const prog = (r: Racer) => {
      // Son geçilen noktadan bu yana yol (0…seg)
      const last = ((r.cps % CHECKPOINTS) - 1 + CHECKPOINTS) % CHECKPOINTS;
      const since = (((r.u - last * seg) % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
      return r.cps * seg + Math.min(seg, r.cps ? since : 0) - (r.cps ? 0 : (TRACK_LENGTH - r.u) / 1000);
    };
    return [...this.racers.values()].sort((a, b) => {
      if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
      const fa = a.finishAt !== null, fb = b.finishAt !== null;
      if (fa && fb) return this.total(a) - this.total(b);
      if (fa !== fb) return fa ? -1 : 1;
      return prog(b) - prog(a) || a.slot - b.slot;
    });
  }

  view(): RingView {
    const order = this.standings();
    const lead = order[0];
    const racers = order.map((r, i): RingRacer => {
      const lapsDone = lapsOf(r.cps);
      let gap: number | null = null, lapsDown = 0;
      if (lead && r !== lead && r.cps > 0) {
        lapsDown = Math.floor((lead.cps - r.cps) / CHECKPOINTS);
        const t = lead.times[r.cps - 1];
        if (!lapsDown && t !== undefined) gap = r.times[r.cps - 1] - t;
      }
      if (r.finishAt !== null && lead && lead.finishAt !== null) {
        gap = this.total(r) - this.total(lead);
        lapsDown = 0;
      }
      return {
        sid: r.sid, name: r.name, slot: r.slot, pos: i + 1,
        lap: Math.max(1, Math.min(this.laps, lapsDone + (r.finishAt !== null ? 0 : 1))),
        gap, lapsDown, penalty: r.penalty, bestLap: r.bestLap, lastLap: r.lastLap,
        total: r.finishAt === null ? null : this.total(r), dnf: r.dnf, prize: this.prizes.get(r.sid) ?? 0,
      };
    });
    return {
      phase: this.phase, laps: this.laps, host: this.host, lightsAt: this.lightsAt,
      goAt: this.phase === "racing" || this.phase === "done" ? this.goAt : null,
      endAt: this.endAt, racers,
    };
  }
}

/** Lambalar: `now` anında yanık kırmızı sayısı (0–5) ve start verildi mi (yeşil). */
export function lightsAt(view: Pick<RingView, "phase" | "lightsAt" | "goAt">, now: number): { red: number; green: boolean } {
  if (view.phase === "lights") return { red: Math.max(0, Math.min(5, Math.floor((now - view.lightsAt) / LIGHT_STEP) + 1)) * (now >= view.lightsAt ? 1 : 0), green: false };
  if (view.phase === "racing" && view.goAt !== null && now - view.goAt < 4000) return { red: 0, green: true };
  return { red: 0, green: false };
}

/** Süre "1:23.456". */
export function raceTime(ms: number): string {
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
