// NPC yayalar: kaldırımlarda ve köy patikalarında yürüyenler, köşede telefonla konuşan ya da sohbet edenler.
// Konumları sunucu saatinin fonksiyonudur (yürüyüş yolu, hız ve faz sabit tohumdan): herkes aynı yayayı aynı
// yerde görür, ağ trafiği yok. Oyuncuya yol verme, korna/arabadan kaçma, el sallamaya karşılık verme yereldir
// (kısa süren, herkeste küçük farklarla). Arabanın çarptığı yaya sunucu üzerinden herkese duyurulur ("pedhit").
import { CAR_HULL_R, carCircles } from "../../../shared/car";
import type { ClientEvent } from "../../../shared/protocol";
import type { CrowdPose, CrowdRenderer } from "../avatars/crowd";
import type { Walkway, Zone } from "../world/walkways";

/** Yayaların konuşma balonu kimlikleri bu sayıdan başlar (oyuncu sid'leriyle çakışmaz). */
export const PED_SID_BASE = 80_000;
/** Bölge başına yaya sayısı ("normal" kalabalıkta; yoğunluk saate göre bunun bir kısmı). */
const COUNTS: Record<Zone, number> = { village: 56, city: 72, hood: 64 };
/** Bu kadarı bir noktada durur (telefon, sohbet). */
const LOITER = 0.22;
const WALK_MIN = 1.05;
const WALK_MAX = 1.55;
/** Çizim yarıçapı ve en çok çizilen yaya (zayıf cihazda daha az). */
const DRAW_R = 75;
const DRAW_R_LOW = 45;
const MAX_DRAWN = 56;
const MAX_DRAWN_LOW = 22;
/** Çarpma: arabanın en az bu hızı (m/sn); aynı yayaya tekrar çarpma bekleme süresi (sn). */
export const HIT_SPEED = 3;
const HIT_COOLDOWN = 3;
/** Düşme animasyonu: savrulma, yerde kalma, kalkma (sn). */
const FLY_T = 0.55;
const LIE_T = 2.4;
const UP_T = 3.1;
const HIT_LINES = ["Kör müsün!", "Ayy belim!", "Hey! Yavaş!", "Ehliyeti nereden aldın?", "Polis çağırıyorum!", "Ah ah, gençler…"];

type Kind = "walk" | "phone" | "chat";

interface Ped {
  zone: Zone;
  kind: Kind;
  outfit: number;
  /** Yoğunluk eşiği: bölgenin o saatteki yoğunluğu bunun üstündeyse görünür. */
  gate: number;
  pts: [number, number][];
  cum: number[];
  len: number;
  v: number;
  phase: number;
  pauseA: number;
  pauseB: number;
  /** Yürürken yönün sağına kayma (iki yönde de sağdan yürür). */
  lat: number;
  /** Duranın yeri ve yönü. */
  sx: number;
  sz: number;
  srot: number;
}

/** Oyuncu ya da araba (her kare çağıran doldurur). */
export interface Mover {
  x: number;
  z: number;
  /** Arabadaysa hızı (m/sn), yayaysa 0. */
  speed: number;
  vx: number;
  vz: number;
  /** Az önce el salladı. */
  wave: boolean;
}

/** Kendi araban (çarpma bunun üzerinden sunucuya bildirilir). */
export interface MyCar {
  x: number;
  z: number;
  rot: number;
  v: number;
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bölgenin saate göre yoğunluğu (0–1), Türkiye saati. */
export function zoneDensity(zone: Zone, h: number): number {
  const at = (pts: [number, number][]) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [h0, d0] = pts[i], [h1, d1] = pts[i + 1];
      if (h >= h0 && h <= h1) return d0 + ((d1 - d0) * (h - h0)) / (h1 - h0);
    }
    return pts[pts.length - 1][1];
  };
  if (zone === "city") return at([[0, 0.6], [3, 0.2], [6, 0.25], [9, 0.65], [13, 0.7], [17, 0.85], [21, 1], [24, 0.6]]);
  if (zone === "hood") return at([[0, 0.2], [3, 0.05], [6, 0.1], [9, 0.45], [13, 0.5], [19, 0.55], [22, 0.35], [24, 0.2]]);
  return at([[0, 0.3], [3, 0.1], [6, 0.2], [9, 0.6], [13, 0.75], [18, 0.7], [22, 0.45], [24, 0.3]]);
}

function cumulative(pts: [number, number][]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}

/** Yol üzerinde `s` metredeki nokta ve yön (yürüyüş yönü +). */
function along(p: Ped, s: number, out: { x: number; z: number; dx: number; dz: number }): void {
  const { pts, cum } = p;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1, u = Math.min(1, Math.max(0, (s - cum[lo]) / seg));
  const a = pts[lo], b = pts[hi];
  out.x = a[0] + (b[0] - a[0]) * u;
  out.z = a[1] + (b[1] - a[1]) * u;
  out.dx = (b[0] - a[0]) / seg;
  out.dz = (b[1] - a[1]) / seg;
}

/** Yayalar ve kendi tepkileri. */
export class Pedestrians {
  private peds: Ped[] = [];
  /** Yerel tepki kayması (yol verme, kaçma) ve yumuşatılmış yön. */
  private ox: Float32Array;
  private oz: Float32Array;
  private rot: Float32Array;
  /** Son çizildiği kare (yönü ilk görüldüğünde yumuşatmadan koymak için). */
  private seen: Int32Array;
  /** Bu kare hesaplanan konum (konuşma balonu için). */
  private px: Float32Array;
  private pz: Float32Array;
  private down = new Map<number, { at: number; vx: number; vz: number }>();
  private lastHit = new Map<number, number>();
  private frame = 0;
  private pose: CrowdPose = { swing: 0, seated: false, wave: 0, phone: 0 };
  private tmp = { x: 0, z: 0, dx: 0, dz: 1 };
  private order: number[] = [];
  private dist: Float32Array;

  constructor(ways: Walkway[], outfits: number) {
    const rand = mulberry(0x5eed_9a7);
    for (const zone of ["village", "city", "hood"] as Zone[]) {
      const list = ways.filter((w) => w.zone === zone && w.pts.length > 1).map((w) => ({ pts: w.pts, cum: cumulative(w.pts) }));
      const total = list.reduce((s, w) => s + w.cum[w.cum.length - 1], 0);
      if (!total) continue;
      for (let k = 0; k < COUNTS[zone]; k++) {
        // Yol uzunluğuyla orantılı seçim
        let pick = rand() * total, w = list[0];
        for (const c of list) {
          const l = c.cum[c.cum.length - 1];
          if (pick < l) {
            w = c;
            break;
          }
          pick -= l;
        }
        const len = w.cum[w.cum.length - 1];
        const loiter = rand() < LOITER;
        const base: Ped = {
          zone, kind: "walk", outfit: Math.floor(rand() * Math.max(1, outfits)), gate: rand(),
          pts: w.pts, cum: w.cum, len, v: WALK_MIN + rand() * (WALK_MAX - WALK_MIN), phase: rand() * 1000,
          pauseA: 2 + rand() * 7, pauseB: 2 + rand() * 7, lat: 0.25 + rand() * 0.5, sx: 0, sz: 0, srot: 0,
        };
        if (!loiter) {
          this.peds.push(base);
          continue;
        }
        // Duran: yolun bir noktasında, yolun kenarında
        along(base, rand() * len, this.tmp);
        const side = rand() < 0.5 ? -1 : 1;
        const x = this.tmp.x - this.tmp.dz * 0.9 * side, z = this.tmp.z + this.tmp.dx * 0.9 * side;
        if (rand() < 0.5) {
          this.peds.push({ ...base, kind: "phone", sx: x, sz: z, srot: rand() * Math.PI * 2 });
        } else {
          // Sohbet: karşılıklı iki kişi
          const a = rand() * Math.PI * 2, ca = Math.sin(a) * 0.45, sa = Math.cos(a) * 0.45;
          this.peds.push({ ...base, kind: "chat", sx: x - ca, sz: z - sa, srot: a });
          this.peds.push({ ...base, kind: "chat", outfit: Math.floor(rand() * Math.max(1, outfits)), sx: x + ca, sz: z + sa, srot: a + Math.PI });
        }
      }
    }
    const n = this.peds.length;
    this.ox = new Float32Array(n);
    this.oz = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.seen = new Int32Array(n).fill(-10);
    this.px = new Float32Array(n).fill(NaN);
    this.pz = new Float32Array(n).fill(NaN);
    this.dist = new Float32Array(n);
  }

  get count(): number {
    return this.peds.length;
  }

  /** Yayanın `t` (sunucu saati, sn) anındaki temel konumu ve yönü; `moving` yürüyor mu. */
  baseAt(i: number, t: number, out: { x: number; z: number; rot: number; moving: boolean }): void {
    const p = this.peds[i];
    if (p.kind !== "walk") {
      out.x = p.sx;
      out.z = p.sz;
      out.rot = p.srot;
      out.moving = false;
      return;
    }
    // Gidiş-dönüş: başta bekle, git, sonda bekle, dön
    const walk = p.len / p.v, T = 2 * walk + p.pauseA + p.pauseB;
    const u = (((t + p.phase) % T) + T) % T;
    let s: number, dir: number, moving = true;
    if (u < p.pauseA) [s, dir, moving] = [0, 1, false];
    else if (u < p.pauseA + walk) [s, dir] = [(u - p.pauseA) * p.v, 1];
    else if (u < p.pauseA + walk + p.pauseB) [s, dir, moving] = [p.len, -1, false];
    else [s, dir] = [p.len - (u - p.pauseA - walk - p.pauseB) * p.v, -1];
    along(p, s, this.tmp);
    const dx = this.tmp.dx * dir, dz = this.tmp.dz * dir;
    // Yönün sağına (sağdan yürü): +z'ye giderken sağ −x
    out.x = this.tmp.x - dz * p.lat;
    out.z = this.tmp.z + dx * p.lat;
    out.rot = Math.atan2(dx, dz);
    out.moving = moving;
  }

  /** Sunucu duyurdu: araba çarptı. `time` yerel saat (sn). */
  hit(id: number, vx: number, vz: number, time: number): string | null {
    if (!(id >= 0 && id < this.peds.length)) return null;
    const cur = this.down.get(id);
    if (cur && time - cur.at < UP_T) return null;
    this.down.set(id, { at: time, vx, vz });
    return HIT_LINES[Math.floor(Math.random() * HIT_LINES.length)];
  }

  /** Konuşma balonunun yeri (yaya bu kare çizildiyse). */
  anchor(id: number): { x: number; z: number; y: number } | null {
    const x = this.px[id], z = this.pz[id];
    return id >= 0 && id < this.peds.length && this.seen[id] === this.frame && !Number.isNaN(x) ? { x, z, y: 0 } : null;
  }

  /**
   * Kare başına: `serverMs` ortak saat, `time` yerel animasyon saati (sn), `hour` dünyanın saati, `mul` kalabalık
   * çarpanı (0 kapalı). Yakındakileri kalabalık çizicisine iter; arabanla çarptığın yayayı `send` ile bildirir.
   */
  update(
    crowd: CrowdRenderer,
    serverMs: number,
    time: number,
    dt: number,
    cam: { x: number; z: number },
    hour: number,
    mul: number,
    movers: Mover[],
    myCar: MyCar | null,
    lowPower: boolean,
    send: (ev: ClientEvent) => void,
  ): void {
    this.frame++;
    if (!crowd.ready || mul <= 0) return;
    const t = serverMs / 1000;
    const R = lowPower ? DRAW_R_LOW : DRAW_R, maxDrawn = lowPower ? MAX_DRAWN_LOW : MAX_DRAWN;
    const dens: Record<Zone, number> = { village: zoneDensity("village", hour) * mul, city: zoneDensity("city", hour) * mul, hood: zoneDensity("hood", hour) * mul };
    const base = { x: 0, z: 0, rot: 0, moving: false };
    // Görünür ve yakın olanlar, yakından uzağa
    this.order.length = 0;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      if (dens[p.zone] - p.gate <= 0) continue;
      const a = p.pts[0];
      // Kaba eleme: yolun ilk noktası çok uzaksa (yollar en çok ~300 m) hesaplama
      if (Math.abs(a[0] - cam.x) > R + 320 || Math.abs(a[1] - cam.z) > R + 320) continue;
      this.baseAt(i, t, base);
      const d = Math.hypot(base.x - cam.x, base.z - cam.z);
      if (d > R) continue;
      this.dist[i] = d;
      this.order.push(i);
    }
    this.order.sort((a, b) => this.dist[a] - this.dist[b]);
    if (this.order.length > maxDrawn) this.order.length = maxDrawn;

    crowd.begin();
    const k = 1 - Math.exp(-dt * 4);
    for (const i of this.order) {
      const p = this.peds[i];
      this.baseAt(i, t, base);
      // Belirip kaybolma: yoğunluk eşiğe yakınken küçülerek
      const fade = Math.min(1, (dens[p.zone] - p.gate) / 0.06) * Math.min(1, (R - this.dist[i]) / 6);
      // Tepkiler: oyuncuya yol ver, arabadan kaç, el sallayana el salla
      let tx = 0, tz = 0, run = false, waveAt: Mover | null = null;
      for (const m of movers) {
        const dx = base.x - m.x, dz = base.z - m.z, d = Math.hypot(dx, dz);
        if (m.speed > 4 && d < 8) {
          // Yaklaşan arabanın yolundan yana çekil
          const sp = m.speed, ux = m.vx / sp, uz = m.vz / sp;
          if (dx * ux + dz * uz > -1.5) {
            const side = dx * -uz + dz * ux >= 0 ? 1 : -1;
            const want = 2.6 * (1 - d / 8);
            tx += -uz * side * want;
            tz += ux * side * want;
            run = true;
          }
        } else if (d < 1.4 && d > 1e-3) {
          tx += (dx / d) * (1.4 - d) * 0.8;
          tz += (dz / d) * (1.4 - d) * 0.8;
        }
        if (m.wave && d < 7) waveAt = m;
      }
      this.ox[i] += (tx - this.ox[i]) * (run ? Math.min(1, k * 3) : k);
      this.oz[i] += (tz - this.oz[i]) * (run ? Math.min(1, k * 3) : k);
      let x = base.x + this.ox[i], z = base.z + this.oz[i];
      let want = base.rot, moving = base.moving || run;
      if (waveAt && !run) {
        want = Math.atan2(waveAt.x - x, waveAt.z - z);
        moving = false;
      }
      if (this.seen[i] < this.frame - 1) this.rot[i] = want;
      const dr = Math.atan2(Math.sin(want - this.rot[i]), Math.cos(want - this.rot[i]));
      this.rot[i] += dr * Math.min(1, dt * 6);
      this.seen[i] = this.frame;

      // Araba çarptı: geriye savrulur, yatar, kalkar
      let fall = 0, y = p.zone === "village" ? 0 : 0.06;
      const dn = this.down.get(i);
      const ft = dn ? time - dn.at : -1;
      if (dn && ft < UP_T) {
        const sp = Math.hypot(dn.vx, dn.vz) || 1, f = Math.min(8, sp * 0.5);
        const u = Math.min(ft, FLY_T) / FLY_T, push = f * (1 - (1 - u) * (1 - u)) * 0.6;
        x += (dn.vx / sp) * push;
        z += (dn.vz / sp) * push;
        // Arabaya dönük düşer (sırtüstü)
        this.rot[i] = Math.atan2(-dn.vx, -dn.vz);
        fall = ft < FLY_T ? 1.45 * u : ft < LIE_T ? 1.45 : 1.45 * Math.max(0, 1 - (ft - LIE_T) / (UP_T - LIE_T));
        y += ft < FLY_T ? Math.sin(u * Math.PI) * 0.35 : 0.08;
        moving = false;
        // Kalkınca bulunduğu yerden yoluna yavaşça döner
        if (ft > LIE_T) {
          this.ox[i] = x - base.x;
          this.oz[i] = z - base.z;
        }
      } else if (dn) this.down.delete(i);
      this.px[i] = x;
      this.pz[i] = z;

      // Arabanla çarptın mı: sunucuya bildir (o herkese duyurur)
      if (myCar && Math.abs(myCar.v) > HIT_SPEED && !dn && time - (this.lastHit.get(i) ?? -Infinity) > HIT_COOLDOWN) {
        const [fx, fz, bx, bz] = carCircles(myCar.x, myCar.z, myCar.rot);
        const r = CAR_HULL_R + 0.3;
        if (Math.hypot(x - fx, z - fz) < r || Math.hypot(x - bx, z - bz) < r) {
          this.lastHit.set(i, time);
          const vx = Math.sin(myCar.rot) * myCar.v, vz = Math.cos(myCar.rot) * myCar.v;
          send({ t: "pedhit", id: i, vx: Math.round(vx * 10) / 10, vz: Math.round(vz * 10) / 10 });
        }
      }

      const po = this.pose;
      const stepHz = run ? 9 : 5.5;
      po.swing = moving ? Math.sin(time * stepHz + p.phase) * (run ? 0.7 : 0.42) : 0;
      po.seated = false;
      po.wave = waveAt && !run && !fall ? 1 : 0;
      po.phone = p.kind === "phone" && !fall ? 1 : 0;
      if (p.kind === "chat" && !moving && !fall) po.swing = Math.sin(time * 1.3 + p.phase) * 0.12;
      const bob = moving ? Math.abs(Math.sin(time * stepHz + p.phase)) * 0.05 : 0;
      crowd.push(p.outfit, x, y + bob, z, this.rot[i], po, time, fall, 0.3 + 0.7 * Math.max(0, fade));
    }
    crowd.end();
  }
}
