// Chibi paketine uzak görünüm (LOD1) ekler: her parçanın sadeleştirilmiş indeksleri aynı köşeleri kullanır,
// bin'in sonuna eklenir (parça başına i1Off / i1Count). Uzaktaki oyuncular ve NPC kalabalığı bunu çizer.
//
//   node scripts/lod-chibi.mjs        (bake-chibi.mjs'ten sonra; tekrar çalıştırılabilir)
//
// Yalnızca dünyanın paketi (client/chibi) değişir; botun paketi (assets/chibi) tam ayrıntıda kalır.
// Üçgenler uzva göre ayrılıp her uzuv kendi içinde sadeleşir: uzuvlar ayrı döner, aralarında köşe birleşmesin.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshoptSimplifier } from "meshoptimizer";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../client/chibi");
/** Üçgen oranı ve bundan küçük parçalar olduğu gibi kalır (gözlük, sakal gibi ince işler). */
const RATIO = 0.25;
const KEEP_SMALL = 120;

await MeshoptSimplifier.ready;
const manifest = JSON.parse(readFileSync(resolve(DIR, "chibi.json"), "utf8"));
let bin = readFileSync(resolve(DIR, "chibi.bin"));
// Önceki LOD verisi atılır
if (manifest.lodStart) bin = bin.subarray(0, manifest.lodStart);
const start = bin.length + ((4 - (bin.length % 4)) % 4);
const chunks = [bin, Buffer.alloc(start - bin.length)];
let offset = start;
let full = 0, lod = 0;

for (const p of Object.values(manifest.parts)) {
  const P = new Float32Array(p.vCount * 3);
  const A = new Float32Array(p.vCount * 6);
  const limb = new Uint8Array(p.vCount);
  for (let v = 0; v < p.vCount; v++) {
    const o = p.vOff + v * manifest.stride;
    for (let k = 0; k < 3; k++) {
      P[v * 3 + k] = bin.readInt16LE(o + k * 2) * manifest.posScale;
      A[v * 6 + k] = bin.readUInt8(o + 9 + k) / 255;
      A[v * 6 + 3 + k] = bin.readInt8(o + 6 + k) / 127;
    }
    limb[v] = bin.readUInt8(o + 13);
  }
  const src = new Uint16Array(bin.buffer.slice(bin.byteOffset + p.iOff, bin.byteOffset + p.iOff + p.iCount * 2));
  const tris = src.length / 3;
  let out = Array.from(src);
  if (tris > KEEP_SMALL) {
    const groups = new Map();
    for (let t = 0; t < src.length; t += 3) {
      const l = limb[src[t]];
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l).push(src[t], src[t + 1], src[t + 2]);
    }
    out = [];
    for (const g of groups.values()) {
      // Aynı yerdeki köşeleri birleştir (renk/normal dikişleri): yoksa sadeleştirici dikişleri kilitli sayar
      const key = new Map(), rep = [], wP = [], wA = [];
      const idx = Uint32Array.from(g, (v) => {
        const k = `${bin.readInt16LE(p.vOff + v * manifest.stride)},${bin.readInt16LE(p.vOff + v * manifest.stride + 2)},${bin.readInt16LE(p.vOff + v * manifest.stride + 4)}`;
        let w = key.get(k);
        if (w === undefined) {
          w = rep.length;
          key.set(k, w);
          rep.push(v);
          wP.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
          for (let j = 0; j < 6; j++) wA.push(A[v * 6 + j]);
        }
        return w;
      });
      const PW = Float32Array.from(wP), AW = Float32Array.from(wA);
      const target = Math.max(3, Math.floor((idx.length * RATIO) / 3) * 3);
      let [r] = MeshoptSimplifier.simplifyWithAttributes(idx, PW, 3, AW, 6, [0.6, 0.6, 0.6, 0.2, 0.2, 0.2], null, target, 0.05, ["Prune"]);
      if (r.length > target * 1.5) [r] = MeshoptSimplifier.simplifySloppy(idx, PW, 3, null, target, 0.08);
      // Köşe kendi rengini taşısın: üçgenin köşesi, aynı yerdeki asıl köşelerden üçgende geçenle eşleşir
      for (let t = 0; t < r.length; t += 3) {
        for (let k = 0; k < 3; k++) out.push(rep[r[t + k]]);
      }
    }
  }
  const ib = Buffer.from(new Uint16Array(out).buffer);
  p.i1Off = offset;
  p.i1Count = out.length;
  chunks.push(ib);
  offset += ib.length;
  const pad = (4 - (offset % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    offset += pad;
  }
  full += tris;
  lod += out.length / 3;
}
manifest.lodStart = start;
writeFileSync(resolve(DIR, "chibi.bin"), Buffer.concat(chunks));
writeFileSync(resolve(DIR, "chibi.json"), JSON.stringify(manifest));
console.log(`LOD1: ${full} → ${lod} üçgen (%${((lod / full) * 100).toFixed(0)}), +${((offset - start) / 1024).toFixed(0)} KB`);
