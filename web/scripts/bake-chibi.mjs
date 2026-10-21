// Chibi karakter paketini (base_character.glb + parça .glb'leri) oyuna hazır tek pakete dönüştürür.
//
//   node scripts/bake-chibi.mjs <paket klasörü>
//
// Çıktı (aynısı iki yere: bot imajı web/'i, dünya imajı kök dizini görmez):
//   ../assets/chibi/chibi.{json,bin}     → bot (!karakter resmi, chibi_render.py)
//   client/chibi/chibi.{json,bin}        → dünya (avatarlar)
//
// Her parça tek ağa birleştirilir, malzeme rengi köşe rengine gömülür ve sadeleştirilir.
// Köşe düzeni (16 bayt): konum int16×3 (POS_SCALE), normal int8×3, renk u8×3 (sRGB),
// renk sınıfı u8 (0 sabit, 1 ten, 2 saç, 3 göz), uzuv u8 (LIMB), kontur u8 (0 tam, 1..255 → 0..1
// inceltilmiş; thinOutline), 1 bayt boşluk.
// İndeksler u16, parçanın ilk köşesine göre.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshoptSimplifier } from "meshoptimizer";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIRS = [resolve(HERE, "../../assets/chibi"), resolve(HERE, "../client/chibi")];
export const POS_SCALE = 1 / 8000; // int16 → ±4 m, 0.125 mm çözünürlük
const STRIDE = 16;
const LIMB = { torso: 0, head: 1, armL: 2, armR: 3, legL: 4, legR: 5 };
const TINT = { none: 0, skin: 1, hair: 2, eye: 3 };

/** Kategori başına parça üçgen bütçesi (sadeleştirme hedefi). */
const BUDGET = { base: 9000, hair: 4000, tops: 3000, bottoms: 1500, shoes: 1000, hats: 1200, glasses: 600, facial: 600 };
const CATS = ["hair", "tops", "bottoms", "shoes", "hats", "glasses", "facial"];
const KEEP_SMALL = 256;
/**
 * Şapka haritası: kafa merkezinden az×el yöne ışın, şapkanın ilk (iç) ve son (dış) kesişim uzaklığı
 * unit katı olarak u8 (0: o yönde şapka yok). Şapka takınca saç ve gözlük bu iç yüzeyin içine çekilir.
 * Yön: açı atan2(x, z) ∈ [0, 2π), yükseklik asin(y/r) ∈ [elMin, π/2].
 * Üç katman: iç, dış, saç. Saç katmanı iç uzaklığın ±erode hücrelik komşulukta en küçüğü: kep
 * siperliği gibi uzak yüzeylerin altındaki perçem de tepeyle birlikte içeri alınır. Şapkanın kenarından
 * dışarı da `fade` hücre, hücre başına `fadeStep` gevşeyerek uzanır: bastırılan ve bastırılmayan saç
 * köşeleri arasındaki üçgenler gerilip şapka kenarından diken gibi çıkmasın. Saç katmanı kafatasının
 * `floor` dışından içeri inmez: aşındırma ve kenar geçişi fes gibi kafaya oturan şapkalarda değeri derinin
 * altına düşürüp saç tabanını kafatasına gömüyor, kafa kel görünüyordu. (Oyun saçı katmanın GAME_HAIR_GAP içine
 * çeker: taban 2.6 cm → saç derinin ≥2 cm dışında.)
 */
/** chibiPack.ts HAT_HAIR_GAP: oyun saçı saç katmanının bu kadar içine çeker. */
const GAME_HAIR_GAP = 0.005;
const HAT_CAP = { az: 128, el: 64, elMin: -1.0, unit: 0.005, erode: 4, fade: 6, fadeStep: 0.0075, floor: 0.026, minFloor: 0.016 };

// ---------------------------------------------------------------------------
// GLB okuma
// ---------------------------------------------------------------------------

function readGlb(path) {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
  return { json, bin };
}

const COMP = { 5120: [Int8Array, 127], 5121: [Uint8Array, 255], 5122: [Int16Array, 32767], 5123: [Uint16Array, 65535], 5125: [Uint32Array, 0], 5126: [Float32Array, 0] };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Erişimciyi düz Float32Array (ya da indeksler için Uint32Array) olarak okur. */
function accessor(glb, i, asIndex = false) {
  const a = glb.json.accessors[i];
  const view = glb.json.bufferViews[a.bufferView];
  const [Type, norm] = COMP[a.componentType];
  const n = SIZE[a.type];
  const elem = Type.BYTES_PER_ELEMENT;
  const stride = view.byteStride || n * elem;
  const base = glb.bin.byteOffset + (view.byteOffset || 0) + (a.byteOffset || 0);
  const dv = new DataView(glb.bin.buffer);
  const out = asIndex ? new Uint32Array(a.count * n) : new Float32Array(a.count * n);
  const get = {
    5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true),
    5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true),
  }[a.componentType];
  for (let k = 0; k < a.count; k++) {
    for (let c = 0; c < n; c++) {
      let v = get(base + k * stride + c * elem);
      if (!asIndex && a.normalized && norm) v = Math.max(v / norm, -1);
      out[k * n + c] = v;
    }
  }
  return { data: out, n };
}

// 4×4 sütun öncelikli matrisler
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Sahnedeki her ağ ilkelini dünya matrisi ve ata düğüm adlarıyla birlikte sıralar. */
function primitives(glb) {
  const out = [];
  const walk = (i, parent, path) => {
    const node = glb.json.nodes[i];
    const m = mul(parent, nodeMatrix(node));
    const names = [...path, node.name || ""];
    if (node.mesh !== undefined) {
      for (const prim of glb.json.meshes[node.mesh].primitives) out.push({ prim, matrix: m, names });
    }
    for (const c of node.children || []) walk(c, m, names);
  };
  for (const r of glb.json.scenes[glb.json.scene || 0].nodes) walk(r, IDENT, []);
  return out;
}

// ---------------------------------------------------------------------------
// Renk ve sınıflandırma
// ---------------------------------------------------------------------------

const toSrgb = (c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)));

function tintOf(cat, matName) {
  if (/^Skin/.test(matName)) return TINT.skin;
  if (/^Eye_Iris/.test(matName)) return TINT.eye;
  if (cat === "hair" || cat === "facial" || matName === "Brow") return TINT.hair;
  return TINT.none;
}

function limbOf(cat, names) {
  if (cat === "base" && names.includes("Head")) return LIMB.head;
  if (["hair", "hats", "glasses", "facial"].includes(cat)) return LIMB.head;
  const leaf = names[names.length - 1];
  const side = /_L(\d|$)/.test(leaf) || names.some((n) => /_(Arm|Leg)_L$/.test(n)) ? "L" : /_R(\d|$)/.test(leaf) || names.some((n) => /_(Arm|Leg)_R$/.test(n)) ? "R" : "";
  if (!side) return LIMB.torso;
  const arm = /Arm|Shoulder|Hand|Sleeve|Glove/.test(names.join("/")) || (cat === "tops" && /Cuff/.test(leaf));
  if (arm) return side === "L" ? LIMB.armL : LIMB.armR;
  return side === "L" ? LIMB.legL : LIMB.legR; // bacak, ayak, paça, ayakkabı
}

// ---------------------------------------------------------------------------
// Parça birleştirme ve sadeleştirme
// ---------------------------------------------------------------------------

/**
 * Bir glb'nin (ya da filtrelenmiş alt kümesinin) ilkellerini tek ağa birleştirir.
 * Yarı saydam: çok saydam camlar atılır, kirli sakal tenle karıştırılır, diğerleri opak olur.
 */
function collect(glb, cat, filter = () => true, skin = [0.92, 0.65, 0.51]) {
  const parts = [];
  for (const { prim, matrix, names } of primitives(glb)) {
    if (!filter(names)) continue;
    const mat = prim.material !== undefined ? glb.json.materials[prim.material] : {};
    const name = mat.name || "";
    const base = mat.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1];
    let alpha = mat.alphaMode === "BLEND" ? base[3] : 1;
    if (alpha < 0.3) continue;
    const pos = accessor(glb, prim.attributes.POSITION).data;
    const nor = prim.attributes.NORMAL !== undefined ? accessor(glb, prim.attributes.NORMAL).data : null;
    const col = prim.attributes.COLOR_0 !== undefined ? accessor(glb, prim.attributes.COLOR_0) : null;
    const count = pos.length / 3;
    const idx = prim.indices !== undefined ? accessor(glb, prim.indices, true).data : Uint32Array.from({ length: count }, (_, i) => i);
    const mix = /Stubble/.test(name) ? skin : null; // kirli sakal: tenle karışık opak
    const tint = tintOf(cat, name);
    const limb = limbOf(cat, names);

    const P = new Float32Array(count * 3);
    const N = new Float32Array(count * 3);
    const C = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      const [x, y, z] = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
      P[v * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      P[v * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      P[v * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
      if (nor) {
        const [a, b, c] = [nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]];
        let nx = matrix[0] * a + matrix[4] * b + matrix[8] * c;
        let ny = matrix[1] * a + matrix[5] * b + matrix[9] * c;
        let nz = matrix[2] * a + matrix[6] * b + matrix[10] * c;
        const l = Math.hypot(nx, ny, nz) || 1;
        N[v * 3] = nx / l; N[v * 3 + 1] = ny / l; N[v * 3 + 2] = nz / l;
      }
      for (let k = 0; k < 3; k++) {
        let c = base[k] * (col ? col.data[v * col.n + k] : 1);
        if (mix) c = alpha * c + (1 - alpha) * mix[k];
        C[v * 3 + k] = c;
      }
    }
    parts.push({ P, N, C, idx, hasNormals: !!nor, tint, limb, tris: idx.length / 3 });
  }
  return parts;
}

/** Konum + renk + sınıf aynı olan köşeleri birleştirir (saçlar indekssiz geliyor). */
function weld(p) {
  const map = new Map();
  const remap = new Uint32Array(p.P.length / 3);
  const P = [], N = [], C = [];
  for (let v = 0; v < remap.length; v++) {
    const key = [0, 1, 2].map((k) => Math.round(p.P[v * 3 + k] * 1e4)).join(",") + "|" + [0, 1, 2].map((k) => Math.round(p.C[v * 3 + k] * 255)).join(",") +
      (p.hasNormals ? "|" + [0, 1, 2].map((k) => Math.round(p.N[v * 3 + k] * 8)).join(",") : "");
    let id = map.get(key);
    if (id === undefined) {
      id = P.length / 3;
      map.set(key, id);
      for (let k = 0; k < 3; k++) { P.push(p.P[v * 3 + k]); N.push(p.N[v * 3 + k]); C.push(p.C[v * 3 + k]); }
    }
    remap[v] = id;
  }
  const idx = new Uint32Array(p.idx.length);
  for (let i = 0; i < idx.length; i++) idx[i] = remap[p.idx[i]];
  return { ...p, P: new Float32Array(P), N: new Float32Array(N), C: new Float32Array(C), idx };
}

/** Normali olmayan ya da sadeleştirilmiş ağlarda pürüzsüz normaller. */
function smoothNormals(P, idx) {
  const N = new Float32Array(P.length);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
  }
  return N;
}

function simplify(p, targetTris) {
  const w = weld(p);
  let idx = w.idx;
  if (targetTris < idx.length / 3) {
    const attrs = new Float32Array(w.C.length * 2);
    for (let v = 0; v < w.C.length / 3; v++) for (let k = 0; k < 3; k++) { attrs[v * 6 + k] = w.C[v * 3 + k]; attrs[v * 6 + 3 + k] = w.N[v * 3 + k]; }
    [idx] = MeshoptSimplifier.simplifyWithAttributes(idx, w.P, 3, attrs, 6, [1, 1, 1, 0.3, 0.3, 0.3], null, Math.max(3, targetTris * 3), 0.02, ["Prune"]);
    if (idx.length / 3 > targetTris * 1.5) [idx] = MeshoptSimplifier.simplifySloppy(idx, w.P, 3, null, targetTris * 3, 0.05);
  }
  const N = w.hasNormals ? w.N : smoothNormals(w.P, idx);
  return { ...w, idx: orient(w.P, N, idx), N };
}

/**
 * Sarım yönünü köşe normallerine uydurur. Sert sadeleştirme (özellikle saçın çift yüzlü katman
 * plakalarında) üçgenlerin yaklaşık üçte birini normaline ters bırakıyor; oyundaki kontur normal
 * boyunca şiştiği için ters üçgenlerin konturu saçın önüne geçip onu koyu lekelerle örtüyordu.
 */
function orient(P, N, idx) {
  const out = Uint32Array.from(idx);
  for (let t = 0; t < out.length; t += 3) {
    const [a, b, c] = [out[t] * 3, out[t + 1] * 3, out[t + 2] * 3];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
    if (fx * nx + fy * ny + fz * nz < 0) [out[t + 1], out[t + 2]] = [out[t + 2], out[t + 1]];
  }
  return out;
}

/**
 * İnce parça konturu: oyundaki kontur kabuğu normal boyunca OUTLINE_MODEL şişer. Siperlik gibi bundan
 * ince plakalarda arka yüzün kabuğu ön yüzden testere dişi gibi çıkıyordu. Kalınlık: köşeye en yakın,
 * köşe normaline ters bakan (karşı yüz) üçgenin uzaklığı; kontur bunun THIN_RATIO katına iner (keskin kenarda üst/alt yüz kabukları ayrışıp
 * diş diş görünmesin). 0 = tam kontur.
 */
const OUTLINE_MODEL = 0.012 / 0.72;
const THIN_CATS = new Set(["hats"]);
const THIN_RATIO = 0.25;
function thinOutline(verts, index) {
  const out = new Uint8Array(verts.length);
  const tris = [];
  for (let k = 0; k < index.length; k += 3) {
    const [a, b, c] = [verts[index[k]].p, verts[index[k + 1]].p, verts[index[k + 2]].p];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    tris.push([index[k], index[k + 1], index[k + 2], n.map((x) => x / l)]);
  }
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    let t = Infinity;
    for (const [a, b, c, n] of tris) {
      if (a === i || b === i || c === i) continue;
      if (n[0] * v.n[0] + n[1] * v.n[1] + n[2] * v.n[2] > -0.5) continue;
      t = Math.min(t, pointTri(v.p, verts[a].p, verts[b].p, verts[c].p));
    }
    const s = Math.min(1, (t * THIN_RATIO) / OUTLINE_MODEL);
    if (s < 1) out[i] = 1 + Math.round(s * 254);
  }
  return out;
}

/** Parçaları bütçeye göre sadeleştirip tek köşe/indeks dizisine paketler. */
function bake(parts, budget, cat) {
  const total = parts.reduce((s, p) => s + p.tris, 0);
  // Küçük parçalar (≤ KEEP_SMALL üçgen) sadeleştirilmez: kep siperliği gibi ince plakaların kenar şeridi
  // payına düşen birkaç düzine üçgenle parçalanıp zikzak görünüyordu
  const done = parts.map((p) => simplify(p, Math.max(Math.min(p.tris, KEEP_SMALL), Math.round((p.tris / total) * budget))));
  const verts = [], index = [];
  for (const p of done) {
    // Kullanılmayan köşeleri at
    const used = new Map();
    for (const i of p.idx) if (!used.has(i)) used.set(i, used.size + verts.length);
    for (const [i] of used) verts.push({ p: [p.P[i * 3], p.P[i * 3 + 1], p.P[i * 3 + 2]], n: [p.N[i * 3], p.N[i * 3 + 1], p.N[i * 3 + 2]], c: [p.C[i * 3], p.C[i * 3 + 1], p.C[i * 3 + 2]], tint: p.tint, limb: p.limb });
    for (const i of p.idx) index.push(used.get(i));
  }
  if (verts.length > 65535) throw new Error(`u16 sınırı aşıldı: ${verts.length} köşe`);
  const vb = Buffer.alloc(verts.length * STRIDE);
  const thin = THIN_CATS.has(cat) ? thinOutline(verts, index) : null;
  verts.forEach((v, i) => {
    const o = i * STRIDE;
    for (let k = 0; k < 3; k++) vb.writeInt16LE(Math.round(v.p[k] / POS_SCALE), o + k * 2);
    for (let k = 0; k < 3; k++) vb.writeInt8(Math.round(v.n[k] * 127), o + 6 + k);
    for (let k = 0; k < 3; k++) vb.writeUInt8(toSrgb(v.c[k]), o + 9 + k);
    vb.writeUInt8(v.tint, o + 12);
    vb.writeUInt8(v.limb, o + 13);
    if (thin) vb.writeUInt8(thin[i], o + 14);
  });
  const ib = Buffer.from(new Uint16Array(index).buffer);
  // Renk sınıfı başına ortalama renk: kullanıcının seçtiği renk bu referansa oranla uygulanır
  const sums = {};
  for (const v of verts) {
    if (!v.tint) continue;
    const s = (sums[v.tint] ||= [0, 0, 0, 0]);
    for (let k = 0; k < 3; k++) s[k] += toSrgb(v.c[k]);
    s[3]++;
  }
  const ref = {};
  for (const [name, id] of Object.entries(TINT)) {
    const s = sums[id];
    if (s) ref[name] = [0, 1, 2].map((k) => Math.round(s[k] / s[3]));
  }
  return { vb, ib, vertCount: verts.length, triCount: index.length / 3, ref };
}

/** HAT_CAP ızgarasındaki her yön için ışının ağa ilk ve son çarptığı uzaklık (çarpmıyorsa 0). */
function capRays(b, center, keep = () => true) {
  const P = [], L = [];
  for (let i = 0; i < b.vertCount; i++) {
    P.push([0, 1, 2].map((k) => b.vb.readInt16LE(i * STRIDE + k * 2) * POS_SCALE));
    L.push(b.vb.readUInt8(i * STRIDE + 13));
  }
  const I = new Uint16Array(b.ib.buffer, b.ib.byteOffset, b.ib.length / 2);
  const { az, el, elMin } = HAT_CAP;
  const near = new Float32Array(az * el), far = new Float32Array(az * el);
  for (let ei = 0; ei < el; ei++) {
    const e = elMin + (ei / (el - 1)) * (Math.PI / 2 - elMin);
    for (let ai = 0; ai < az; ai++) {
      const a = (ai / az) * 2 * Math.PI;
      const d = [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
      let n = Infinity, f = 0;
      for (let t = 0; t < I.length; t += 3) {
        if (!keep(L[I[t]])) continue;
        const h = rayTri(center, d, P[I[t]], P[I[t + 1]], P[I[t + 2]]);
        if (h > 0) { n = Math.min(n, h); f = Math.max(f, h); }
      }
      if (f > 0) { near[ei * az + ai] = n; far[ei * az + ai] = f; }
    }
  }
  return { near, far };
}

/** Bake edilmiş (nicelenmiş) şapka ağından HAT_CAP haritası: [iç, dış, saç] × az·el. skull: kafatası uzaklıkları. */
function hatCap(b, center, skull) {
  const { az, el, unit, erode, fade, fadeStep, floor, minFloor } = HAT_CAP;
  const out = new Uint8Array(az * el * 3);
  const q = (r) => Math.min(255, Math.max(1, Math.round(r / unit)));
  const { near, far } = capRays(b, center);
  for (let k = 0; k < az * el; k++) if (far[k] > 0) { out[k] = q(near[k]); out[az * el + k] = q(far[k]); }
  for (let ei = 0; ei < el; ei++) {
    for (let ai = 0; ai < az; ai++) {
      if (!out[ei * az + ai]) continue;
      let m = 255;
      for (let de = -erode; de <= erode; de++) {
        const e = ei + de;
        if (e < 0 || e >= el) continue;
        for (let da = -erode; da <= erode; da++) {
          const v = out[e * az + ((ai + da + az) % az)];
          if (v) m = Math.min(m, v);
        }
      }
      out[2 * az * el + ei * az + ai] = m;
    }
  }
  const hair = out.subarray(2 * az * el);
  const edge = Uint8Array.from(hair);
  for (let ei = 0; ei < el; ei++) {
    for (let ai = 0; ai < az; ai++) {
      if (edge[ei * az + ai]) continue;
      let m = Infinity;
      for (let de = -fade; de <= fade; de++) {
        const e = ei + de;
        if (e < 0 || e >= el) continue;
        for (let da = -fade; da <= fade; da++) {
          const v = edge[e * az + ((ai + da + az) % az)];
          // İlk halka gevşemez: şapka kenarındaki hücreyi kısmen örtüyor, orada gevşeyen saç kabuktan taşıyordu
          if (v) m = Math.min(m, v * unit + (Math.max(Math.abs(de), Math.abs(da)) - 1) * fadeStep);
        }
      }
      if (m < Infinity) hair[ei * az + ai] = q(m);
    }
  }
  // Taban şapkanın iç yüzeyini aşmaz (kep arkası gibi kafaya sıkı oturan kenarda saç şapkanın içinde kalır),
  // ama hiçbir yerde kafatası + minFloor altına inmez: saçların kafatasını saran taban katmanı (Base/Buzz)
  // derinin içine girince şapka kenarında deri görünüyordu (fes).
  for (let k = 0; k < az * el; k++) {
    if (!hair[k] || !(skull[k] > 0)) continue;
    const h = Math.max(hair[k], q(skull[k] + floor));
    // (şapkanın iç yüzeyi kafatasının altındaysa — börk, kalpak — en alt sınır da iç yüzeyi aşmaz; fes gibi deriye
    // tam oturan şapkada aşar, yoksa kenarın altında saç deriye girip şerit hâlinde kel kalıyordu, saç tabanı kafatasında gizli kalır)
    const lo = q(skull[k] + minFloor);
    hair[k] = Math.max(out[k] ? Math.min(h, Math.max(hair[k], out[k])) : h, out[k] && out[k] < q(skull[k]) ? Math.min(lo, out[k]) : lo);
    // Şapkanın altında deriye yakın kenar (fes): oyun saçı katmanın HAT_HAIR_GAP içine çeker; deri ile şapka
    // arasında yer varsa saç derinin hemen dışında kalsın (kenarın altından içeri bakınca deri görünüyordu)
    if (out[k] && out[k] >= q(skull[k])) hair[k] = Math.max(hair[k], q(Math.min(skull[k] + 0.004, out[k] * unit - 0.002) + GAME_HAIR_GAP));
  }
  return Buffer.from(out.buffer);
}

/** Noktanın üçgene en kısa uzaklığı (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTri(p, a, b, c) {
  const sub = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const at = (q) => Math.hypot(...sub(p, q));
  const lerp = (x, y, t) => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(lerp(a, b, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(lerp(a, c, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return at(lerp(b, c, (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/** Möller–Trumbore: ışının üçgene uzaklığı, kesmiyorsa 0. */
function rayTri(o, d, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return 0;
  const inv = 1 / det, s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < 0 || u > 1) return 0;
  const qv = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * inv;
  if (v < 0 || u + v > 1) return 0;
  const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * inv;
  return t > 0 ? t : 0;
}

// ---------------------------------------------------------------------------
// README: Türkçe adlar, gruplar ve "TAM" (alt giyimi gizler) bilgisi
// ---------------------------------------------------------------------------

function readmeLabels(dir) {
  const out = {};
  let text = "";
  try { text = readFileSync(join(dir, "README.txt"), "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s{3}((?:hair|top|bottom|shoes|hat|glasses|facial)_\w+)\s{2,}(.+?)\s*$/);
    if (!m) continue;
    const cols = m[2].split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    const full = cols.some((c) => /\bTAM\b/.test(c));
    // Saç ve üstlerde ilk sütun grup (Kısa, Forma…), sonra ad; diğerlerinde ilk sütun ad.
    const grouped = /^(hair|top)_/.test(m[1]) && cols.length >= 3;
    out[m[1]] = {
      label: grouped ? cols[1] : cols[0],
      group: grouped ? cols[0].replace(/\s*TAM\b/, "").trim() : undefined,
      full,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const dir = resolve(process.argv[2] || "");
  await MeshoptSimplifier.ready;
  const labels = readmeLabels(dir);
  const chunks = [];
  let offset = 0;
  const parts = {};
  const stats = [];

  let headCenter = null, skull = null, baseBaked = null;
  const add = (id, cat, glbParts, extra = {}) => {
    const b = bake(glbParts, BUDGET[cat], cat);
    if (id === "base") baseBaked = b;
    const align = (n) => (4 - (n % 4)) % 4;
    const vOff = offset; chunks.push(b.vb); offset += b.vb.length;
    const iOff = offset; chunks.push(b.ib); offset += b.ib.length;
    const pad = align(offset); if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    if (cat === "hats") {
      extra = { ...extra, cap: offset };
      skull ||= capRays(baseBaked, headCenter, (limb) => limb === LIMB.head).near;
      const cap = hatCap(b, headCenter, skull);
      chunks.push(cap); offset += cap.length;
    }
    parts[id] = { cat, vOff, vCount: b.vertCount, iOff, iCount: b.triCount * 3, ...(Object.keys(b.ref).length ? { ref: b.ref } : {}), ...extra };
    stats.push([id, b.triCount]);
  };

  const baseGlb = readGlb(join(dir, "base_character.glb"));
  const inOutfit = (names) => names.includes("Outfit_Base");
  add("base", "base", collect(baseGlb, "base", (n) => !inOutfit(n)));
  add("base_top", "tops", collect(baseGlb, "tops", (n) => n.includes("Outfit_Base_Top")), { label: "Atlet (temel)" });
  add("base_bottom", "bottoms", collect(baseGlb, "bottoms", (n) => inOutfit(n) && !n.includes("Outfit_Base_Top")), { label: "Şort (temel)" });

  // Kafa merkezi: şapka varken saçı bastırmak için (README: merkezden 0.55 dışındaki saçı içeri çek)
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of collect(baseGlb, "base", (n) => n.includes("Head_Skull"))) {
    for (let i = 0; i < p.P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.P[i + k]); hi[k] = Math.max(hi[k], p.P[i + k]); }
  }
  headCenter = lo.map((v, k) => +((v + hi[k]) / 2).toFixed(4));

  const skinBase = [0.92, 0.65, 0.51];
  for (const cat of CATS) {
    for (const file of readdirSync(join(dir, cat)).filter((f) => f.endsWith(".glb")).sort()) {
      const id = basename(file, ".glb");
      const meta = labels[id] || {};
      add(id, cat, collect(readGlb(join(dir, cat, file)), cat, () => true, skinBase), {
        label: meta.label || id,
        ...(meta.group ? { group: meta.group } : {}),
        ...(meta.full ? { full: true } : {}),
      });
    }
  }

  const bin = Buffer.concat(chunks);
  const manifest = {
    version: 1,
    stride: STRIDE,
    posScale: POS_SCALE,
    limbs: LIMB,
    tints: TINT,
    headCenter,
    hatHairRadius: 0.55,
    hatCap: HAT_CAP,
    parts,
  };
  for (const out of OUT_DIRS) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "chibi.bin"), bin);
    writeFileSync(join(out, "chibi.json"), JSON.stringify(manifest));
  }
  stats.sort((a, b) => b[1] - a[1]);
  console.log(`${Object.keys(parts).length} parça, ${(bin.length / 1048576).toFixed(2)} MB`);
  console.log("En ağır:", stats.slice(0, 6).map(([i, t]) => `${i}=${t}`).join(" "));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
