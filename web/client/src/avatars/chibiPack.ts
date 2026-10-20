// Chibi karakter paketi (scripts/bake-chibi.mjs çıktısı): kıyafeti tek BufferGeometry'ye birleştirir.
// Kurallar bot tarafındaki chibi_render.py ile aynı: boş üst/alt → temel atlet/şort, tek parça üst
// altı gizler, şapka takınca saç kafa merkezine doğru bastırılır, renkler parlaklığı koruyarak değişir.
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
}

export interface ChibiManifest {
  version: number;
  stride: number;
  posScale: number;
  limbs: Record<string, number>;
  tints: Record<string, number>;
  headCenter: number[];
  hatHairRadius: number;
  parts: Record<string, PartMeta>;
}

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

/** Uzuvlar: 0 gövde, 1 kafa, 2-3 kol (sol/sağ), 4-5 bacak (sol/sağ). */
export const LIMB_COUNT = 6;

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

  /** Kıyafeti tek geometriye birleştirir: position, normal, color (doğrusal), aLimb. */
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
    const index = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
    const dv = new DataView(this.buf);
    const hat = ids.some((id) => m.parts[id].cat === "hats");
    const [hx, hy, hz] = m.headCenter;
    const r0 = m.hatHairRadius;
    const want: Partial<Record<number, [number, number, number]>> = {};
    for (const c of LOOK_COLORS) {
      const h = hex(l.colors?.[c]);
      if (h) want[TINT_OF[c]] = h;
    }

    let v = 0, i = 0;
    for (const p of metas) {
      const squish = hat && p.cat === "hair";
      const refLum: Partial<Record<number, number>> = {};
      for (const c of LOOK_COLORS) {
        const r = p.ref?.[c];
        if (r) refLum[TINT_OF[c]] = Math.max(lum(r[0], r[1], r[2]), 1);
      }
      const base = v;
      for (let k = 0; k < p.vCount; k++, v++) {
        const o = p.vOff + k * m.stride;
        let x = dv.getInt16(o, true) * m.posScale;
        let y = dv.getInt16(o + 2, true) * m.posScale;
        let z = dv.getInt16(o + 4, true) * m.posScale;
        if (squish) {
          const dx = x - hx, dy = y - hy, dz = z - hz;
          const r = Math.hypot(dx, dy, dz);
          if (r > r0 && y > hy - 0.1) {
            x = hx + (dx * r0) / r;
            y = hy + (dy * r0) / r;
            z = hz + (dz * r0) / r;
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
      for (let k = 0; k < p.iCount; k++) index[i++] = idx[k] + base;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aLimb", new THREE.BufferAttribute(limb, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    return geo;
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
    for (let l = 0; l < LIMB_COUNT; l++) {
      if (!Number.isFinite(lo[l * 3])) continue;
      this.pivots[l * 3] = (lo[l * 3] + hi[l * 3]) / 2;
      // Kollarda omuz ucu, bacaklarda kalça: uzvun en üstünden biraz aşağısı
      this.pivots[l * 3 + 1] = hi[l * 3 + 1] - (l >= 4 ? 0.05 : 0.08);
      this.pivots[l * 3 + 2] = (lo[l * 3 + 2] + hi[l * 3 + 2]) / 2;
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
