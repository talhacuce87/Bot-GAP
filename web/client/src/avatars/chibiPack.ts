// Chibi karakter paketi (scripts/bake-chibi.mjs çıktısı): kıyafeti tek BufferGeometry'ye birleştirir.
// Kurallar bot tarafındaki chibi_render.py ile aynı: boş üst/alt → temel atlet/şort, tek parça üst
// altı gizler, şapka takınca saç (ve şapkayı kesen gözlük) şapkanın iç yüzeyine doğru bastırılır,
// renkler parlaklığı koruyarak değişir.
import * as THREE from "three";
import { LOOK_COLORS, LOOK_SLOTS, type Look, type LookColor, type LookSlot } from "../../../shared/protocol";

export interface PartMeta {
  cat: string;
  vOff: number;
  vCount: number;
  iOff: number;
  iCount: number;
  label?: string;
  group?: string;
  full?: boolean;
  ref?: Partial<Record<LookColor, number[]>>;
  /** Şapkalarda: şapka haritasının pakette başladığı bayt (iç, dış, saç katmanları art arda). */
  cap?: number;
}

export interface ChibiManifest {
  version: number;
  stride: number;
  posScale: number;
  limbs: Record<string, number>;
  tints: Record<string, number>;
  headCenter: number[];
  hatHairRadius: number;
  /** Şapka haritası ızgarası (bake-chibi.mjs HAT_CAP); eski paketlerde yok. */
  hatCap?: { az: number; el: number; elMin: number; unit: number; erode: number };
  parts: Record<string, PartMeta>;
}

/** Şapka takınca saç şapkanın iç yüzeyinin bu kadar içine, şapkayı kesen gözlük kısmı bunun içine çekilir. */
const HAT_HAIR_GAP = 0.005;
const HAT_GLASSES_GAP = 0.006;
/** Kafa merkezinden bu kadar önde (+z) olan gözlük köşeleri ön çerçeve: şapkanın önüne itilir (en çok PUSH). */
const HAT_GLASSES_FRONT = 0.4;
const HAT_GLASSES_PUSH = 0.04;
/** Botun outfit.DEFAULT_OUTFIT'i ile aynı: misafirler ve kıyafeti henüz gelmeyenler. */
export const DEFAULT_LOOK: Look = {
  hair: "hair_kisa_doku",
  tops: "top_tisort",
  bottoms: "bottom_kot",
  shoes: "shoes_sneaker",
  hats: null,
  glasses: null,
  facial: null,
  colors: {},
};

/** Kol dönme noktası: kolun en üstünden bu kadar (m) aşağısına kadarki köşelerin x ortası. */
const SHOULDER_BAND = 0.12;

/** Uzuvlar: 0 gövde, 1 kafa, 2-3 kol (sol/sağ), 4-5 bacak (sol/sağ). */
export const LIMB_COUNT = 6;

/**
 * Saç ve sakal ince, sivri plakalardan oluşuyor: tam kalınlıkta kontur her tutamın etrafına kalın
 * koyu bir çerçeve çizip rengi bastırıyor. Bunlarda kontur ince (anime tarzı tutam çizgisi) kalır.
 */
const THIN_OUTLINE = new Set(["hair", "facial"]);
const THIN_OUTLINE_SCALE = 0.3;

const TINT_OF: Record<LookColor, number> = { skin: 1, hair: 2, eye: 3 };

/** Aynı kıyafet aynı anahtarı verir (geometri önbelleği için). */
export function lookKey(look: Look | null | undefined): string {
  const l = look ?? DEFAULT_LOOK;
  const parts = LOOK_SLOTS.map((s) => l[s] ?? "");
  const colors = LOOK_COLORS.map((c) => l.colors?.[c] ?? "");
  return [...parts, ...colors].join("|");
}

function hex(v: string | undefined): [number, number, number] | null {
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) return null;
  return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export class ChibiPack {
  /** Uzuv dönme noktaları (omuz/kalça), temel karakterden: [x,y,z] × LIMB_COUNT. */
  readonly pivots = new Float32Array(LIMB_COUNT * 3);

  constructor(
    readonly manifest: ChibiManifest,
    private buf: ArrayBuffer,
  ) {
    this.computePivots();
  }

  /** Bir slotta seçilebilir parçalar (temel atlet/şort hariç), pakette geldiği sırayla. */
  partsIn(slot: LookSlot): [string, PartMeta][] {
    return Object.entries(this.manifest.parts).filter(([id, p]) => p.cat === slot && !id.startsWith("base"));
  }

  /** Çizilecek parçalar: chibi_render.compose ile aynı kurallar. */
  compose(look: Look | null | undefined): string[] {
    const l = look ?? DEFAULT_LOOK;
    const parts = this.manifest.parts;
    const pick = (slot: LookSlot) => {
      const id = l[slot];
      return id && parts[id]?.cat === slot ? id : null;
    };
    const out = ["base"];
    const top = pick("tops");
    out.push(top ?? "base_top");
    if (!(top && parts[top].full)) out.push(pick("bottoms") ?? "base_bottom");
    for (const slot of ["shoes", "hair", "hats", "glasses", "facial"] as const) {
      const id = pick(slot);
      if (id) out.push(id);
    }
    return out;
  }

  /** Kıyafeti tek geometriye birleştirir: position, normal, color (doğrusal), aLimb, aOutline. */
  build(look: Look | null | undefined): THREE.BufferGeometry {
    const l = look ?? DEFAULT_LOOK;
    const m = this.manifest;
    const ids = this.compose(l);
    const metas = ids.map((id) => m.parts[id]);
    const vTotal = metas.reduce((s, p) => s + p.vCount, 0);
    const iTotal = metas.reduce((s, p) => s + p.iCount, 0);
    const pos = new Float32Array(vTotal * 3);
    const nor = new Float32Array(vTotal * 3);
    const col = new Float32Array(vTotal * 3);
    const limb = new Float32Array(vTotal);
    const outl = new Float32Array(vTotal);
    const index = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
    const dv = new DataView(this.buf);
    const hatId = ids.find((id) => m.parts[id].cat === "hats");
    const cap = hatId ? this.hatCap(hatId) : null;
    const [hx, hy, hz] = m.headCenter;
    const r0 = m.hatHairRadius;
    const want: Partial<Record<number, [number, number, number]>> = {};
    for (const c of LOOK_COLORS) {
      const h = hex(l.colors?.[c]);
      if (h) want[TINT_OF[c]] = h;
    }


    let v = 0, i = 0;
    for (const p of metas) {
      const squish = hatId && (p.cat === "hair" || (cap && p.cat === "glasses"));
      const refLum: Partial<Record<number, number>> = {};
      for (const c of LOOK_COLORS) {
        const r = p.ref?.[c];
        if (r) refLum[TINT_OF[c]] = Math.max(lum(r[0], r[1], r[2]), 1);
      }
      const base = v;
      const ow = THIN_OUTLINE.has(p.cat) ? THIN_OUTLINE_SCALE : 1;
      for (let k = 0; k < p.vCount; k++, v++) {
        const thin = dv.getUint8(p.vOff + k * m.stride + 14);
        outl[v] = thin ? (ow * (thin - 1)) / 254 : ow;
        const o = p.vOff + k * m.stride;
        let x = dv.getInt16(o, true) * m.posScale;
        let y = dv.getInt16(o + 2, true) * m.posScale;
        let z = dv.getInt16(o + 4, true) * m.posScale;
        if (squish) {
          const dx = x - hx, dy = y - hy, dz = z - hz;
          const r = Math.hypot(dx, dy, dz);
          let to = 0;
          if (cap) {
            // Şapkanın kapladığı yönde: saç iç yüzeyin içine. Gözlükte şapka kabuğunu kesen saplar içeri,
            // ön çerçeve kabuğun önüne (içeri çekilirse şapkanın içine kıvrılıyordu); çok uzaksa dokunulmaz.
            const [ri, ro, rh] = cap(dx, dy, dz, r);
            if (p.cat === "hair") to = rh && r > rh - HAT_HAIR_GAP ? rh - HAT_HAIR_GAP : 0;
            else if (!ri || r < Math.min(ri, rh) - HAT_GLASSES_GAP || r > ro + HAT_GLASSES_GAP) to = 0;
            else if (dz < HAT_GLASSES_FRONT) to = rh - HAT_GLASSES_GAP;
            else if (ro + HAT_GLASSES_GAP - r <= HAT_GLASSES_PUSH) to = ro + HAT_GLASSES_GAP;
          } else if (r > r0 && y > hy - 0.1) {
            to = r0;
          }
          if (to > 0) {
            x = hx + (dx * to) / r;
            y = hy + (dy * to) / r;
            z = hz + (dz * to) / r;
          }
        }
        pos[v * 3] = x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z;
        nor[v * 3] = dv.getInt8(o + 6) / 127;
        nor[v * 3 + 1] = dv.getInt8(o + 7) / 127;
        nor[v * 3 + 2] = dv.getInt8(o + 8) / 127;
        let r = dv.getUint8(o + 9), g = dv.getUint8(o + 10), b = dv.getUint8(o + 11);
        const tint = dv.getUint8(o + 12);
        const w = want[tint], rl = refLum[tint];
        if (w && rl) {
          // Açık/koyu katman farkı korunur ama yumuşatılır (chibi_render ile aynı)
          const f = Math.min(1.3, Math.sqrt(lum(r, g, b) / rl));
          r = Math.min(255, w[0] * f);
          g = Math.min(255, w[1] * f);
          b = Math.min(255, w[2] * f);
        }
        col[v * 3] = toLinear(r);
        col[v * 3 + 1] = toLinear(g);
        col[v * 3 + 2] = toLinear(b);
        limb[v] = dv.getUint8(o + 13);
      }
      const idx = new Uint16Array(this.buf, p.iOff, p.iCount);
      if (cap && p.cat === "hair") pullTriangles(pos, idx, base, m.headCenter, cap);
      for (let k = 0; k < p.iCount; k++) index[i++] = idx[k] + base;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aLimb", new THREE.BufferAttribute(limb, 1));
    geo.setAttribute("aOutline", new THREE.BufferAttribute(outl, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  /** Kafa merkezine göre (dx,dy,dz) yönünün şapka haritası hücresi [satır, sütun]; ızgaranın altındaysa null. */
  private capCell(dx: number, dy: number, dz: number): [number, number] | null {
    const g = this.manifest.hatCap!;
    const r = Math.hypot(dx, dy, dz);
    if (r < 1e-6) return null;
    const el = Math.asin(Math.max(-1, Math.min(1, dy / r)));
    const ei = Math.round(((el - g.elMin) / (Math.PI / 2 - g.elMin)) * (g.el - 1));
    if (ei < 0) return null;
    let az = Math.atan2(dx, dz);
    if (az < 0) az += 2 * Math.PI;
    return [Math.min(ei, g.el - 1), Math.round((az / (2 * Math.PI)) * g.az) % g.az];
  }

  /**
   * Şapka haritası okuyucu: kafa merkezine göre (dx,dy,dz) yönündeki şapka iç, dış ve saç (aşındırılmış
   * iç) uzaklığı; o yönde şapka yoksa sıfırlar. En yakın ızgara hücresi (chibi_render.py ile aynı).
   */
  hatCap(id: string): HatCap | null {
    const g = this.manifest.hatCap, off = this.manifest.parts[id]?.cap;
    if (!g || off === undefined) return null;
    const n = g.az * g.el;
    const cells = new Uint8Array(this.buf, off, n * 3);
    return (dx, dy, dz) => {
      const c = this.capCell(dx, dy, dz);
      if (!c) return [0, 0, 0];
      const k = c[0] * g.az + c[1];
      return [cells[k] * g.unit, cells[n + k] * g.unit, cells[2 * n + k] * g.unit];
    };
  }

  /** Kol ve bacakların dönme noktası: uzuv köşelerinin en üst ortası (omuz, kalça). */
  private computePivots(): void {
    const m = this.manifest;
    const p = m.parts.base;
    const dv = new DataView(this.buf);
    const lo = new Float32Array(LIMB_COUNT * 3).fill(Infinity);
    const hi = new Float32Array(LIMB_COUNT * 3).fill(-Infinity);
    for (let k = 0; k < p.vCount; k++) {
      const o = p.vOff + k * m.stride;
      const l = dv.getUint8(o + 13);
      for (let c = 0; c < 3; c++) {
        const val = dv.getInt16(o + c * 2, true) * m.posScale;
        lo[l * 3 + c] = Math.min(lo[l * 3 + c], val);
        hi[l * 3 + c] = Math.max(hi[l * 3 + c], val);
      }
    }
    // Kollar A duruşunda yana açık: kutunun ortası omzun ~20 cm dışında kalıyor, kol kalkınca omuz
    // gövdeden kopuyordu. Kollarda x, en üstteki şeridin (omuz topuzu) ortası.
    const top = new Float32Array(LIMB_COUNT * 2).fill(0);
    for (let k = 0; k < p.vCount; k++) {
      const o = p.vOff + k * m.stride;
      const l = dv.getUint8(o + 13);
      if (l !== 2 && l !== 3) continue;
      if (dv.getInt16(o + 2, true) * m.posScale < hi[l * 3 + 1] - SHOULDER_BAND) continue;
      top[l * 2] += dv.getInt16(o, true) * m.posScale;
      top[l * 2 + 1]++;
    }
    for (let l = 0; l < LIMB_COUNT; l++) {
      if (!Number.isFinite(lo[l * 3])) continue;
      this.pivots[l * 3] = top[l * 2 + 1] ? top[l * 2] / top[l * 2 + 1] : (lo[l * 3] + hi[l * 3]) / 2;
      // Kollarda omuz ucu, bacaklarda kalça: uzvun en üstünden biraz aşağısı
      this.pivots[l * 3 + 1] = hi[l * 3 + 1] - (l >= 4 ? 0.05 : 0.08);
      this.pivots[l * 3 + 2] = (lo[l * 3 + 2] + hi[l * 3 + 2]) / 2;
    }
  }
}

/** Şapka haritası okuyucusu: [iç, dış, saç] uzaklıkları. */
type HatCap = (dx: number, dy: number, dz: number, r: number) => [number, number, number];
/** Üçgen çekmede saç şapka kabuğunun dış yüzeyinin bu kadar içine (kabuk kalınlığının en çok yarısı) alınır. */
const SHELL_IN = 0.004;

/** Üçgen içinde yoklanan noktalar (ağırlık merkezi koordinatları). */
const TRI_SAMPLES = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.7, 0.15, 0.15], [0.15, 0.7, 0.15], [0.15, 0.15, 0.7]];

/**
 * Köşeler şapkanın içine bastırıldıktan sonra ikinci geçiş: bir ucu bastırılmış, öbür ucu şapka kenarının
 * dışında kalan uzun saç üçgenleri gerilip şapkanın üstünden diken gibi çıkıyordu. İçinde şapkanın dış
 * yüzeyinden taşan nokta olan üçgenin üç köşesi, o nokta kabuğun içine girecek kadar kafa merkezine çekilir.
 * Yalnız görünür taşma düzeltilir (çekme küçük kalır): saç sınırına kadar çekmek kep siperliği altındaki
 * kâkülü ve fes altındaki saçı kafanın içine sokup alnı kel bırakıyordu. İki tur (çekilen köşe komşu üçgeni de
 * etkiler). chibi_render.py ile aynı.
 */
function pullTriangles(pos: Float32Array, idx: Uint16Array, base: number, center: number[], cap: HatCap): void {
  const [hx, hy, hz] = center;
  for (let pass = 0; pass < 2; pass++) {
    for (let t = 0; t < idx.length; t += 3) {
      const vs = [idx[t] + base, idx[t + 1] + base, idx[t + 2] + base];
      let f = 1;
      for (const w of TRI_SAMPLES) {
        let x = -hx, y = -hy, z = -hz;
        for (let k = 0; k < 3; k++) {
          x += w[k] * pos[vs[k] * 3];
          y += w[k] * pos[vs[k] * 3 + 1];
          z += w[k] * pos[vs[k] * 3 + 2];
        }
        const r = Math.hypot(x, y, z);
        const [ri, ro] = cap(x, y, z, r);
        const lim = ro - Math.min(SHELL_IN, (ro - ri) / 2);
        if (ri && r > lim) f = Math.min(f, lim / r);
      }
      if (f >= 1) continue;
      for (const v of vs) {
        pos[v * 3] = hx + (pos[v * 3] - hx) * f;
        pos[v * 3 + 1] = hy + (pos[v * 3 + 1] - hy) * f;
        pos[v * 3 + 2] = hz + (pos[v * 3 + 2] - hz) * f;
      }
    }
  }
}

/** Sahte oyuncular (?bots) için sid'den sabit, rastgele bir kıyafet. */
export function randomLook(manifest: ChibiManifest, seed: number): Look {
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
  const ids = (slot: LookSlot) => Object.keys(manifest.parts).filter((id) => manifest.parts[id].cat === slot && !id.startsWith("base"));
  const pick = (slot: LookSlot, chance = 1) => {
    const list = ids(slot);
    return list.length && rnd() < chance ? list[Math.floor(rnd() * list.length)] : null;
  };
  return {
    hair: pick("hair"),
    tops: pick("tops"),
    bottoms: pick("bottoms"),
    shoes: pick("shoes"),
    hats: pick("hats", 0.25),
    glasses: pick("glasses", 0.2),
    facial: pick("facial", 0.2),
    colors: {},
  };
}
