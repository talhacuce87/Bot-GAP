// Girilebilir dükkânların içi: lambri, süpürgelik ve korniş, temaya göre zemin (parke, karo, mermer),
// gömme tavan ışıkları, sarkıt lambalar, ayaklı mobilyalar, saksı bitkileri, tablolar ve temaya özel
// eşyalar. Büyük katlarda arkada "personel" bölmesi: dükkân gereksiz büyük ve boş durmaz.
// AVM: ortada fıskiyeli atrium, iki yanda camlı mağazalar, arkada yemek katı, girişte danışma.
//
// Yerel çerçeve: x dükkânın enine, z kapıya doğru (+), merkez odanın ortası; `face` kapının dünyadaki yönü.
import * as THREE from "three";
import type { Look } from "../../../shared/protocol";
import type { PropKind } from "./builder";
import type { CityNpc } from "./city";
import { mat } from "./geo";

/** city.ts'nin verdiği çizim ve dünya araçları (dünya koordinatlarında). */
export interface Kit {
  rand(): number;
  /** Gölge almayan iç mesh'e geometri. */
  geo(g: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter?: number): void;
  /** Işıktan etkilenmeyen parlayan parça. */
  glowGeo(g: THREE.BufferGeometry, color: string, m: THREE.Matrix4): void;
  /** Şeffaf cam. */
  glassGeo(g: THREE.BufferGeometry, m: THREE.Matrix4): void;
  sign(text: string, w: number, h: number, m: THREE.Matrix4): void;
  seat(x: number, z: number, rot: number, h?: number): void;
  wall(ax: number, az: number, bx: number, bz: number, r: number, top?: number): void;
  prop(kind: PropKind, m: THREE.Matrix4): void;
  npc(n: CityNpc): void;
}

type Theme = "cafe" | "pharmacy" | "barber" | "bank" | "market" | "hotel" | "mall";
interface Worker {
  npc: string;
  outfit: Look;
  label: string;
  line: string;
  fx: CityNpc["act"]["fx"];
  /** Konuşunca açılan dükkân gardırobu (berber: saç, moda: kıyafet). */
  shop?: CityNpc["act"]["shop"];
}
const outfit = (hair: string, tops: string, bottoms: string, shoes: string, extra: Partial<Look> = {}, skin = "#e0b48a", hairColor = "#2a2522"): Look => ({
  hair, tops, bottoms, shoes, hats: null, glasses: null, facial: null, ...extra, colors: { hair: hairColor, skin },
});
const W_ = (npc: string, o: Look, label: string, line: string, fx: Worker["fx"], shop?: Worker["shop"]): Worker => ({ npc, outfit: o, label, line, fx, shop });

/** Tabelası olan dükkânın teması ve çalışanları. */
export const SHOPS: Record<string, { theme: Theme; workers: Worker[] }> = {
  "GAP KAHVE": { theme: "cafe", workers: [W_("Barista Elif", outfit("hair_topuz_orgu", "top_tisort", "bottom_kot", "shoes_sneaker", { hats: "hat_kep" }, "#e8c39e", "#3b2a20"), "Kahve söyle ☕", "Türk kahvesi mi, latte mi? Hemen hazırlıyorum!", "tea")] },
  ECZANE: { theme: "pharmacy", workers: [W_("Eczacı Ayşe", outfit("hair_uzun_dalgali", "top_kazak", "bottom_kumas", "shoes_klasik", { glasses: "glasses_yuvarlak" }, "#f0cfae", "#6b4226"), "Eczacıya danış 💊", "Geçmiş olsun! Bol su için, iyi dinlenin.", "sparkle")] },
  BERBER: { theme: "barber", workers: [W_("Berber Cemil", outfit("hair_pompadour", "top_ekose", "bottom_kumas", "shoes_klasik", { facial: "facial_biyik" }, "#d9a77c", "#1f1a17"), "Saçını kestir ✂️", "Sıfır mı, yanlardan biraz mı alalım abi?", "sparkle", "barber")] },
  "GAP BANK": { theme: "bank", workers: [W_("Veznedar Murat", outfit("hair_yan_ayrik", "top_takim", "bottom_kumas", "shoes_klasik", { glasses: "glasses_kalin" }), "Vezneye git 💰", "GAP Coin hesabınız çok yakında açılıyor!", "sparkle")] },
  "GAP MARKET": { theme: "market", workers: [W_("Kasiyer Zeynep", outfit("hair_kuyruk_orgu", "top_tisort", "bottom_kot", "shoes_sneaker", {}, "#f2d0b0", "#8a5a2b"), "Kasaya git 🛒", "Poşet ister misiniz? Bir de kampanyamız var!", "party")] },
  "OTEL GAP": { theme: "hotel", workers: [W_("Resepsiyonist Can", outfit("hair_joleli", "top_smokin", "bottom_smokin_alt", "shoes_klasik", {}, "#e5bf98", "#1a1512"), "Resepsiyon 🛎️", "Hoş geldiniz! Odalarımız çok yakında hizmetinizde.", "sparkle")] },
  "GAP AVM": {
    theme: "mall",
    workers: [
      W_("Burgerci Mert", outfit("hair_kisa_doku", "top_tisort", "bottom_kargo", "shoes_sneaker", { hats: "hat_kep_ters" }, "#d8a47a", "#4a3020"), "Burger söyle 🍔", "Bir GAP Burger, bol soslu, hemen geliyor!", "party"),
      W_("Güvenlik Kemal", outfit("hair_kirpi", "top_takim", "bottom_kumas", "shoes_klasik", { glasses: "glasses_pilot" }, "#c99b74", "#1a1512"), "Danışma ℹ️", "Mağazalar iki yanda, yemek katı en arkada. İyi alışverişler!", "sparkle"),
      W_("Satış Danışmanı Selin", outfit("hair_uzun_kivircik", "top_crop", "bottom_etek", "shoes_topuklu", {}, "#efc9a4", "#8a3b2b"), "Kıyafet dene 👗", "Yeni sezon geldi! Beğendiğini dene, kasaya gerek yok 😉", "sparkle", "fashion"),
    ],
  },
};
/** Atlasında bulunması gereken mağaza tabelaları (city.ts'nin neon atlası). */
export const MALL_SIGNS = ["GAP MODA", "GAP TEKNO", "EROTİK SHOP", "OYUNCAKÇI", "DONDURMA", "PERSONEL", "BİLGİ"];

interface Style {
  wall: string;
  panel: string;
  trim: string;
  floor: string;
  /** Zemin deseni: parke (ince derz), karo (ızgara), dama (iki renk), mermer (kenar bandı). */
  pattern: "plank" | "tile" | "check" | "marble";
  floor2: string;
  /** Lambri yüksekliği (0: yok). */
  wainscot: number;
}

/** Odanın yerel çerçevesi: yerel (lx, lz) → dünya, yerel dönüş → dünya dönüşü. */
function frame(kit: Kit, x: number, z: number, face: number) {
  const c = Math.cos(face), s = Math.sin(face);
  const at = (lx: number, lz: number): [number, number] => [x + c * lx + s * lz, z - s * lx + c * lz];
  const m = (lx: number, y: number, lz: number, lry = 0) => {
    const [px, pz] = at(lx, lz);
    return mat(px, y, pz, face + lry);
  };
  return {
    at,
    m,
    rand: kit.rand,
    box: (w: number, h: number, d: number, color: string, lx: number, y: number, lz: number, lry = 0, jitter = 0.03) => kit.geo(new THREE.BoxGeometry(w, h, d), color, m(lx, y, lz, lry), jitter),
    glow: (w: number, h: number, d: number, color: string, lx: number, y: number, lz: number, lry = 0) => kit.glowGeo(new THREE.BoxGeometry(w, h, d), color, m(lx, y, lz, lry)),
    glass: (w: number, h: number, d: number, lx: number, y: number, lz: number, lry = 0) => kit.glassGeo(new THREE.BoxGeometry(w, h, d), m(lx, y, lz, lry)),
    cyl: (r0: number, r1: number, h: number, color: string, lx: number, y: number, lz: number, seg = 14) => kit.geo(new THREE.CylinderGeometry(r0, r1, h, seg), color, m(lx, y, lz), 0.02),
    geo: (g: THREE.BufferGeometry, color: string, lx: number, y: number, lz: number, lry = 0) => kit.geo(g, color, m(lx, y, lz, lry), 0.02),
    glowGeo: (g: THREE.BufferGeometry, color: string, lx: number, y: number, lz: number, lry = 0) => kit.glowGeo(g, color, m(lx, y, lz, lry)),
    seat: (lx: number, lz: number, lrot: number, h?: number) => {
      const [px, pz] = at(lx, lz);
      kit.seat(px, pz, face + lrot, h);
    },
    wall: (lx0: number, lz0: number, lx1: number, lz1: number, r: number, top?: number) => kit.wall(...at(lx0, lz0), ...at(lx1, lz1), r, top),
    circle: (lx: number, lz: number, r: number) => kit.wall(...at(lx, lz), ...at(lx, lz), r),
    sign: (text: string, w: number, h: number, lx: number, y: number, lz: number, lry = 0) => kit.sign(text, w, h, m(lx, y, lz, lry)),
    npc: (wk: Worker, lx: number, lz: number, lrot: number, ax: number, az: number) => {
      const [px, pz] = at(lx, lz), [qx, qz] = at(ax, az);
      kit.npc({ name: wk.npc, x: px, z: pz, rot: face + lrot, outfit: wk.outfit, act: { x: qx, z: qz, r: 2.3, label: wk.label, line: wk.line, fx: wk.fx, shop: wk.shop } });
    },
  };
}
type F = ReturnType<typeof frame>;

/** Yerel (dx, dz) ofsetini `a` yönüne bakan nesnenin eksenine göre döndürür. */
const rot = (dx: number, dz: number, a: number): [number, number] => [dx * Math.cos(a) + dz * Math.sin(a), -dx * Math.sin(a) + dz * Math.cos(a)];

// ---------------------------------------------------------------------------
// Mobilya ve süs
// ---------------------------------------------------------------------------

/** Dört ayaklı sandalye (oturulur): `a` baktığı yön. */
function chair(f: F, lx: number, lz: number, a: number, wood = "#5a3d28", cushion = "#7a2622") {
  for (const [dx, dz] of [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]]) {
    const [ox, oz] = rot(dx, dz, a);
    f.box(0.04, 0.45, 0.04, wood, lx + ox, 0.225, lz + oz, a, 0);
  }
  f.box(0.46, 0.05, 0.46, wood, lx, 0.47, lz, a);
  f.box(0.4, 0.04, 0.4, cushion, lx, 0.51, lz, a);
  const [bx, bz] = rot(0, -0.21, a);
  f.box(0.46, 0.45, 0.04, wood, lx + bx, 0.74, lz + bz, a);
  f.seat(lx, lz, a);
}

/** Bar taburesi: ayak, ayak halkası, minder (oturma yüksekliği `h`). */
function stool(f: F, lx: number, lz: number, a: number, h = 0.75, top = "#2a2a2c") {
  f.cyl(0.2, 0.22, 0.03, "#2b2e33", lx, 0.015, lz, 14);
  f.cyl(0.035, 0.035, h - 0.05, "#9aa2ab", lx, (h - 0.05) / 2, lz, 8);
  f.geo(new THREE.TorusGeometry(0.15, 0.012, 4, 14).rotateX(Math.PI / 2), "#9aa2ab", lx, 0.32, lz);
  f.cyl(0.2, 0.18, 0.07, top, lx, h - 0.02, lz, 16);
  f.seat(lx, lz, a, h);
}

/** Dikdörtgen masa (dört ayak). */
function table(f: F, lx: number, lz: number, w: number, d: number, h: number, top: string, leg: string, a = 0) {
  f.box(w, 0.05, d, top, lx, h - 0.025, lz, a);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const [ox, oz] = rot(dx * (w / 2 - 0.06), dz * (d / 2 - 0.06), a);
    f.box(0.05, h - 0.05, 0.05, leg, lx + ox, (h - 0.05) / 2, lz + oz, a, 0);
  }
  f.circle(lx, lz, Math.max(w, d) * 0.45);
}

/** Yuvarlak kafe masası ve iki sandalye. */
function cafeSet(f: F, lx: number, lz: number, a: number, top = "#e9e2d2", wood = "#5a3d28", cushion = "#2f4a3a") {
  f.cyl(0.42, 0.42, 0.04, top, lx, 0.74, lz, 18);
  f.cyl(0.04, 0.05, 0.7, "#2b2e33", lx, 0.37, lz, 8);
  f.cyl(0.25, 0.27, 0.03, "#2b2e33", lx, 0.015, lz, 14);
  f.circle(lx, lz, 0.45);
  for (const s of [-1, 1]) {
    const [ox, oz] = rot(s * 0.82, 0, a);
    chair(f, lx + ox, lz + oz, a + (s > 0 ? -Math.PI / 2 : Math.PI / 2), wood, cushion);
  }
  f.cyl(0.04, 0.035, 0.09, "#f4f1ea", lx + 0.12, 0.81, lz, 10);
}

/** Kanepe (yerel `a` yönüne bakar): ahşap ayaklar, oturma ve sırt minderleri, kolçaklar; oturulur. */
function sofa(f: F, lx: number, lz: number, a: number, len: number, color: string, leg = "#3a2a1e") {
  const P = (dx: number, dz: number): [number, number] => {
    const [ox, oz] = rot(dx, dz, a);
    return [lx + ox, lz + oz];
  };
  for (const [dx, dz] of [[-len / 2 + 0.1, -0.3], [len / 2 - 0.1, -0.3], [-len / 2 + 0.1, 0.3], [len / 2 - 0.1, 0.3]]) f.box(0.06, 0.12, 0.06, leg, ...withY(P(dx, dz), 0.06), a, 0);
  f.box(len, 0.22, 0.8, color, ...withY(P(0, 0), 0.23), a);
  const n = Math.max(1, Math.round(len / 0.75));
  for (let i = 0; i < n; i++) {
    const cx = -len / 2 + 0.2 + (i + 0.5) * ((len - 0.4) / n);
    f.box((len - 0.4) / n - 0.03, 0.12, 0.62, color, ...withY(P(cx, 0.06), 0.4), a, 0.06);
    f.box((len - 0.4) / n - 0.03, 0.42, 0.16, color, ...withY(P(cx, -0.3), 0.6), a, 0.06);
    f.seat(...P(cx, 0.08), a, 0.46);
  }
  for (const s of [-1, 1]) f.box(0.2, 0.55, 0.8, color, ...withY(P(s * (len / 2 - 0.1), 0), 0.4), a);
  f.wall(...P(-len / 2 + 0.2, -0.15), ...P(len / 2 - 0.2, -0.15), 0.4);
}
/** [x, z] ve y'yi kutu çağrısının (x, y, z) sırasına koyar. */
function withY([x, z]: [number, number], y: number): [number, number, number] {
  return [x, y, z];
}

/** Park/AVM bankı: döküm ayaklar, ahşap çıtalı oturak ve sırtlık (yerel `a` yönüne bakar); oturulur. */
function bench(f: F, lx: number, lz: number, a: number, len: number, wood = "#9a6b43", metal = "#2b2e33") {
  const P = (dx: number, dz: number): [number, number] => {
    const [ox, oz] = rot(dx, dz, a);
    return [lx + ox, lz + oz];
  };
  for (const s of [-1, 1]) {
    const x = s * (len / 2 - 0.15);
    f.box(0.06, 0.42, 0.5, metal, ...withY(P(x, 0), 0.21), a, 0);
    f.box(0.06, 0.5, 0.06, metal, ...withY(P(x, -0.24), 0.65), a, 0);
    f.box(0.08, 0.04, 0.55, metal, ...withY(P(x, 0), 0.02), a, 0);
  }
  for (let k = 0; k < 4; k++) f.box(len, 0.035, 0.1, wood, ...withY(P(0, -0.18 + k * 0.12), 0.44), a, 0.05);
  for (let k = 0; k < 2; k++) f.box(len, 0.1, 0.03, wood, ...withY(P(0, -0.26), 0.62 + k * 0.17), a, 0.05);
  const n = Math.max(1, Math.round(len / 0.75));
  for (let i = 0; i < n; i++) f.seat(...P(-len / 2 + (i + 0.5) * (len / n), 0.02), a, 0.46);
  f.wall(...P(-len / 2 + 0.1, -0.05), ...P(len / 2 - 0.1, -0.05), 0.3);
}

/** Tekli koltuk. */
function armchair(f: F, lx: number, lz: number, a: number, color: string) {
  sofa(f, lx, lz, a, 1.0, color);
}

/** Saksı bitkisi: konik saksı, toprak, üst üste yaprak kümeleri. */
function plant(f: F, lx: number, lz: number, s = 1, pot = "#e8e2d6") {
  f.cyl(0.24 * s, 0.18 * s, 0.45 * s, pot, lx, 0.225 * s, lz, 12);
  f.cyl(0.21 * s, 0.21 * s, 0.03, "#3a2a1e", lx, 0.44 * s, lz, 12);
  const greens = ["#3f7a3a", "#4c8c42", "#5c9e40", "#2f6b34"];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + f.rand(), r = 0.12 * s;
    f.geo(new THREE.IcosahedronGeometry((0.2 + f.rand() * 0.1) * s, 0), greens[k % 4], lx + Math.cos(a) * r, (0.75 + k * 0.12 + f.rand() * 0.1) * s, lz + Math.sin(a) * r, a);
  }
  f.geo(new THREE.IcosahedronGeometry(0.22 * s, 0), greens[1], lx, 1.35 * s, lz);
  f.circle(lx, lz, 0.25 * s);
}

/** Sarkıt lamba: tavandan kordon, koni abajur, parlayan ampul. */
function pendant(f: F, lx: number, lz: number, y: number, ceil: number, shade = "#1d1e21") {
  f.cyl(0.006, 0.006, ceil - y - 0.2, "#111", lx, (ceil + y + 0.2) / 2, lz, 4);
  f.geo(new THREE.CylinderGeometry(0.06, 0.24, 0.24, 14, 1, true), shade, lx, y + 0.08, lz);
  f.glowGeo(new THREE.SphereGeometry(0.08, 10, 8), "#ffe7b0", lx, y, lz);
}

/** Halı (kenar şeritli). */
function rug(f: F, lx: number, lz: number, w: number, d: number, color: string, border: string, a = 0) {
  f.box(w, 0.012, d, border, lx, 0.072, lz, a, 0.02);
  f.box(w - 0.3, 0.014, d - 0.3, color, lx, 0.074, lz, a, 0.04);
}

/** Duvara asılı tablo: çerçeve ve soyut renk blokları (`a`: duvardan odaya bakan yön). */
function art(f: F, lx: number, y: number, lz: number, w: number, h: number, a: number, palette: string[]) {
  f.box(w, h, 0.05, "#2a2420", lx, y, lz, a, 0);
  const [ox, oz] = rot(0, 0.03, a);
  f.box(w - 0.12, h - 0.12, 0.02, "#f6f2ea", lx + ox, y, lz + oz, a, 0);
  for (let k = 0; k < 3; k++) {
    const [px, pz] = rot(-w / 4 + (k * w) / 4 - 0.02, 0.045, a);
    f.box(w / 4, (h - 0.3) * (0.4 + f.rand() * 0.6), 0.02, palette[k % palette.length], lx + px, y - 0.05 + f.rand() * 0.1, lz + pz, a, 0);
  }
}

/** Raf ünitesi: dikmeler, raflar ve üstünde rastgele ürünler (`a` yönüne bakar, uzunluk yerel x). */
function shelves(f: F, lx: number, lz: number, len: number, h: number, levels: number, a: number, colors: string[], depth = 0.42, frameColor = "#f1f1ee", item = 0.3, base = 0) {
  const P = (dx: number, dz: number): [number, number] => {
    const [ox, oz] = rot(dx, dz, a);
    return [lx + ox, lz + oz];
  };
  f.box(len, h, 0.04, frameColor, ...withY(P(0, -depth / 2 + 0.02), base + h / 2), a, 0);
  for (const s of [-1, 1]) f.box(0.04, h, depth, frameColor, ...withY(P(s * len / 2, 0), base + h / 2), a, 0);
  for (let l = 0; l <= levels; l++) {
    const y = base + 0.12 + l * ((h - 0.2) / levels);
    f.box(len, 0.03, depth, frameColor, ...withY(P(0, 0), y), a, 0);
    if (l === levels) continue;
    const n = Math.floor(len / item);
    for (let k = 0; k < n; k++) {
      if (f.rand() < 0.1) continue;
      const ph = Math.min((h - 0.2) / levels - 0.08, 0.14 + f.rand() * 0.22);
      f.box(item * 0.8, ph, depth * 0.7, colors[Math.floor(f.rand() * colors.length)], ...withY(P(-len / 2 + (k + 0.5) * (len / n), 0.02), y + 0.015 + ph / 2), a, 0.05);
    }
  }
  f.wall(...P(-len / 2, 0), ...P(len / 2, 0), depth / 2 + 0.05);
}

/** Sayaç / tezgâh: alt süpürgelik, ön panel (dikey çıtalı), üst tabla. */
function counter(f: F, lx: number, lz: number, len: number, front: string, top: string, a = 0, slats = "") {
  const P = (dx: number, dz: number): [number, number] => {
    const [ox, oz] = rot(dx, dz, a);
    return [lx + ox, lz + oz];
  };
  f.box(len - 0.1, 0.1, 0.6, "#1d1e21", ...withY(P(0, -0.02), 0.05), a, 0);
  f.box(len, 0.95, 0.65, front, ...withY(P(0, 0), 0.575), a);
  if (slats) for (let k = 0; k < Math.floor(len / 0.14); k++) f.box(0.05, 0.85, 0.02, slats, ...withY(P(-len / 2 + 0.07 + k * 0.14, 0.33), 0.58), a, 0.04);
  f.box(len + 0.1, 0.05, 0.75, top, ...withY(P(0, 0.03), 1.075), a, 0.01);
  f.wall(...P(-len / 2, 0), ...P(len / 2, 0), 0.38);
}

/** Açık yüzeyi içten görünür yapar (üçgen sırası ters, normaller içe): içinde durulan kavisli masa yüzleri için. */
function inward<G extends THREE.BufferGeometry>(g: G): G {
  const idx = g.index;
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
  }
  const n = g.getAttribute("normal");
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

/** Bilgisayar ekranı (parlayan) ve klavye. */
function monitor(f: F, lx: number, y: number, lz: number, a: number) {
  const [ox, oz] = rot(0, -0.05, a);
  f.box(0.06, 0.18, 0.06, "#2b2e33", lx + ox, y + 0.09, lz + oz, a, 0);
  f.box(0.5, 0.32, 0.04, "#1d1e21", lx + ox, y + 0.32, lz + oz, a, 0);
  const [gx, gz] = rot(0, -0.025, a);
  f.glow(0.46, 0.28, 0.01, "#9fd7ff", lx + gx, y + 0.32, lz + gz, a);
  const [kx, kz] = rot(0, 0.18, a);
  f.box(0.42, 0.02, 0.14, "#2b2e33", lx + kx, y + 0.01, lz + kz, a, 0);
}

/** Bölmeyi ayırırken duvar ve kapalı "personel" kapısı. */
function partition(f: F, W: number, zb: number, h: number, color: string, doorX: number) {
  f.box(W, h, 0.2, color, 0, h / 2, zb - 0.1, 0, 0.02);
  f.wall(-W / 2, zb - 0.1, W / 2, zb - 0.1, 0.12);
  f.box(1.0, 2.2, 0.06, "#6b4a2b", doorX, 1.1, zb + 0.03, 0, 0.03);
  f.box(1.1, 0.08, 0.08, "#3a2a1e", doorX, 2.24, zb + 0.03, 0, 0);
  f.box(0.04, 0.04, 0.14, "#c9ccd1", doorX + 0.38, 1.05, zb + 0.08, 0, 0);
  f.sign("PERSONEL", 0.9, 0.22, doorX, 2.5, zb + 0.07);
}

/** Duvar kaplaması: lambri (dikey derzli), boya, süpürgelik, sandalye bandı, korniş; zemin ve tavan ışıkları. */
function finish(f: F, W: number, zb: number, zf: number, h: number, st: Style, light = "#fff2d8") {
  const D = zf - zb, cz = (zb + zf) / 2;
  // Zemin
  f.box(W, 0.04, D, st.floor, 0, 0.045, cz, 0, 0.03);
  if (st.pattern === "plank") {
    for (let x = -W / 2 + 0.22; x < W / 2; x += 0.22) f.box(0.012, 0.003, D, st.floor2, x, 0.067, cz, 0, 0);
    for (let x = -W / 2 + 0.11, k = 0; x < W / 2; x += 0.22, k++) for (let z = zb + ((k % 3) * 0.6) + 0.4; z < zf; z += 1.8) f.box(0.21, 0.003, 0.012, st.floor2, x, 0.067, z, 0, 0);
  } else if (st.pattern === "tile") {
    for (let x = -W / 2 + 0.8; x < W / 2; x += 0.8) f.box(0.02, 0.003, D, st.floor2, x, 0.067, cz, 0, 0);
    for (let z = zb + 0.8; z < zf; z += 0.8) f.box(W, 0.003, 0.02, st.floor2, 0, 0.067, z, 0, 0);
  } else if (st.pattern === "check") {
    const n = Math.floor(W / 0.6), m = Math.floor(D / 0.6), tw = W / n, td = D / m;
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) if ((i + j) % 2) f.box(tw, 0.004, td, st.floor2, -W / 2 + (i + 0.5) * tw, 0.067, zb + (j + 0.5) * td, 0, 0.02);
  } else {
    f.box(W - 0.6, 0.004, 0.12, st.floor2, 0, 0.067, zb + 0.3, 0, 0);
    f.box(W - 0.6, 0.004, 0.12, st.floor2, 0, 0.067, zf - 0.3, 0, 0);
    for (const s of [-1, 1]) f.box(0.12, 0.004, D - 0.6, st.floor2, s * (W / 2 - 0.3), 0.067, cz, 0, 0);
    // Büyük mermer plakalar: zemine çok yakın renkte ince derz (çizik gibi durmasın diye düşük kontrast)
    const seam = new THREE.Color(st.floor).multiplyScalar(0.93).getStyle();
    for (let x = -W / 2 + 0.36 + 1.6; x < W / 2 - 0.4; x += 1.6) f.box(0.015, 0.002, D - 0.72, seam, x, 0.066, cz, 0, 0);
    for (let z = zb + 0.36 + 1.6; z < zf - 0.4; z += 1.6) f.box(W - 0.72, 0.002, 0.015, seam, 0, 0.066, z, 0, 0);
  }
  // Duvarlar: arka ve iki yan (ön duvar vitrin, yalnızca süpürgelik)
  const walls: [number, number, number, number][] = [
    [0, zb + 0.03, W, 0],
    [-W / 2 + 0.03, cz, D, Math.PI / 2],
    [W / 2 - 0.03, cz, D, -Math.PI / 2],
  ];
  for (const [wx, wz, len, a] of walls) {
    const [ox, oz] = rot(0, 0.012, a);
    f.box(len, h - 0.35, 0.02, st.wall, wx, (h - 0.35) / 2, wz, a, 0.01);
    if (st.wainscot) {
      f.box(len, st.wainscot, 0.03, st.panel, wx + ox, st.wainscot / 2, wz + oz, a, 0.03);
      for (let t = -len / 2 + 0.6; t < len / 2; t += 0.6) {
        const [gx, gz] = rot(t, 0.03, a);
        f.box(0.02, st.wainscot - 0.2, 0.01, st.trim, wx + gx, st.wainscot / 2 + 0.05, wz + gz, a, 0);
      }
      const [rx, rz] = rot(0, 0.04, a);
      f.box(len, 0.05, 0.05, st.trim, wx + rx, st.wainscot, wz + rz, a, 0);
    }
    const [sx2, sz2] = rot(0, 0.035, a);
    f.box(len, 0.12, 0.04, "#2a2420", wx + sx2, 0.06, wz + sz2, a, 0);
    f.box(len, 0.1, 0.08, st.trim, wx + sx2, h - 0.4, wz + sz2, a, 0);
    const [lx2, lz2] = rot(0, 0.07, a);
    f.glow(len - 0.4, 0.025, 0.025, light, wx + lx2, h - 0.47, wz + lz2, a);
  }
  f.box(W, 0.12, 0.04, "#2a2420", 0, 0.06, zf - 0.035, 0, 0);
  // Gömme tavan ışıkları (çerçeveli panel)
  for (let x = -W / 2 + 2; x < W / 2 - 1; x += 3.2) {
    for (let z = zb + 1.8; z < zf - 1; z += 3.2) {
      f.box(0.9, 0.03, 0.9, "#d8d3c8", x, h - 0.32, z, 0, 0);
      f.glow(0.75, 0.02, 0.75, light, x, h - 0.335, z);
    }
  }
}

// ---------------------------------------------------------------------------
// Temalar
// ---------------------------------------------------------------------------

const BOOKS = ["#8a2e2e", "#2e5a8a", "#2e7a4a", "#c9a24a", "#5a3d7a", "#d9822b", "#3a3a3a", "#e8e2d4"];

function cafe(f: F, W: number, zb: number, zf: number, h: number, wk: Worker[]) {
  finish(f, W, zb, zf, h, { wall: "#efe4d0", panel: "#2f4a3a", trim: "#b08850", floor: "#9a6e45", floor2: "#6f4c2f", pattern: "plank", wainscot: 1.1 }, "#ffe2b0");
  // Arka duvarda tuğla: harç bantları ve kaydırmalı derzler
  const bw = 9, bh = h - 0.5;
  f.box(bw, bh, 0.06, "#8a4a32", 0, bh / 2, zb + 0.07, 0, 0.12);
  for (let r = 0, y = 0.25; y < bh; y += 0.25, r++) {
    f.box(bw, 0.025, 0.02, "#cdbfae", 0, y, zb + 0.105, 0, 0);
    for (let x = -bw / 2 + (r % 2 ? 0.25 : 0.5); x < bw / 2; x += 0.5) f.box(0.025, 0.24, 0.02, "#cdbfae", x, y - 0.125, zb + 0.105, 0, 0);
  }
  f.sign("GAP KAHVE", 3.6, 0.9, 0, 4.1, zb + 0.13);
  for (const [x, w] of [[-2.8, 1.8], [0, 2.2], [2.8, 1.8]] as const) {
    f.box(w, 1.2, 0.05, "#2a2a2a", x, 2.75, zb + 0.13, 0, 0);
    f.box(w + 0.1, 1.3, 0.04, "#6b4a2b", x, 2.75, zb + 0.11, 0, 0);
    for (let k = 0; k < 6; k++) f.box(w * (0.45 + f.rand() * 0.4), 0.04, 0.01, "#efe9dc", x - w * 0.05, 3.2 - k * 0.16, zb + 0.16, 0, 0);
  }
  for (const s of [-1, 1]) {
    for (let l = 0; l < 3; l++) {
      f.box(1.6, 0.05, 0.3, "#6b4a2b", s * 5.6, 1.8 + l * 0.5, zb + 0.25);
      for (let k = 0; k < 5; k++) f.cyl(0.07, 0.07, 0.22, ["#c8763a", "#5a3d28", "#d8cbb0", "#2f4a3a"][(k + l) % 4], s * 5.6 - 0.6 + k * 0.3, 1.94 + l * 0.5, zb + 0.25, 10);
    }
  }
  // Tezgâh: ahşap çıtalı ön, mermer tabla; üstünde espresso makinesi, değirmen, kasa, pasta vitrini
  const cz = zb + 2.4;
  counter(f, 0, cz, 7, "#7a5232", "#efeae2", 0, "#5a3d28");
  f.box(7, 0.9, 0.55, "#5a3d28", 0, 0.45, zb + 0.45);
  f.box(7.1, 0.04, 0.6, "#2a2420", 0, 0.92, zb + 0.45, 0, 0);
  f.glow(1.6, 0.7, 0.02, "#e6f7ff", 2.6, 0.45, zb + 0.73);
  for (let k = 0; k < 8; k++) f.cyl(0.035, 0.04, 0.3, ["#b3121c", "#e9b44c", "#5a3d28", "#2e7a4a"][k % 4], -3 + k * 0.2, 1.08, zb + 0.4, 8);
  const ex = -2.0;
  f.box(0.9, 0.5, 0.55, "#c9ccd1", ex, 1.35, cz - 0.05);
  f.box(0.92, 0.04, 0.57, "#2b2e33", ex, 1.62, cz - 0.05, 0, 0);
  for (const s of [-1, 1]) {
    f.cyl(0.06, 0.06, 0.1, "#2b2e33", ex + s * 0.22, 1.12, cz + 0.2, 10);
    f.cyl(0.05, 0.045, 0.07, "#f4f1ea", ex + s * 0.22, 1.135, cz + 0.32, 10);
  }
  f.box(0.85, 0.03, 0.2, "#6b6e72", ex, 1.115, cz + 0.32, 0, 0);
  f.geo(new THREE.CylinderGeometry(0.16, 0.06, 0.3, 12), "#3a2a1e", -0.9, 1.45, cz - 0.05);
  f.box(0.25, 0.2, 0.25, "#2b2e33", -0.9, 1.2, cz - 0.05, 0, 0);
  monitor(f, 0.4, 1.1, cz - 0.05, 0);
  f.glass(1.7, 0.5, 0.6, 2.3, 1.36, cz);
  f.glow(1.6, 0.03, 0.5, "#ffe2b0", 2.3, 1.13, cz);
  for (let k = 0; k < 6; k++) f.cyl(0.11, 0.11, 0.1, ["#c8763a", "#f2d38a", "#8a4b2a", "#e889b5"][k % 4], 1.7 + (k % 3) * 0.4, 1.17 + Math.floor(k / 3) * 0.2, cz - 0.1 + Math.floor(k / 3) * 0.1, 12);
  for (let k = 0; k < 5; k++) pendant(f, -3 + k * 1.5, cz, 3.3, h);
  f.npc(wk[0], 0, zb + 1.5, 0, 0, cz + 1.3);
  // Vitrin önünde bar tezgâhı ve tabureler (kapının iki yanı)
  for (const s of [-1, 1]) {
    const bx = s * (W / 4 + 0.6), len = W / 2 - 3;
    f.box(len, 0.05, 0.45, "#6b4a2b", bx, 1.05, zf - 0.32);
    for (let k = 0; k < 3; k++) f.box(0.05, 1.0, 0.05, "#2b2e33", bx - len / 2 + 0.2 + k * ((len - 0.4) / 2), 0.5, zf - 0.2, 0, 0);
    for (let k = 0; k < Math.floor(len / 0.9); k++) stool(f, bx - len / 2 + 0.45 + k * 0.9, zf - 0.95, 0, 0.75);
    f.wall(bx - len / 2, zf - 0.32, bx + len / 2, zf - 0.32, 0.25);
  }
  // Masalar (ortada kapıdan tezgâha yol açık)
  for (const x of [-W / 2 + 2.2, -W / 2 + 5.2, W / 2 - 5.2, W / 2 - 2.2]) for (const z of [cz + 3.0, cz + 5.6]) cafeSet(f, x, z, 0);
  // Lounge köşesi: kanepe, iki berjer, sehpa, halı, kitaplık
  const lx = -W / 2 + 2.4, lz = zb + 1.6;
  rug(f, lx, lz + 0.6, 3.6, 2.6, "#7a2622", "#c9a24a");
  sofa(f, lx, lz, 0, 2.6, "#5a3d28");
  armchair(f, lx + 1.9, lz + 1.4, -Math.PI / 2, "#2f4a3a");
  f.box(1.0, 0.04, 0.6, "#6b4a2b", lx, 0.42, lz + 1.3);
  for (const s of [-1, 1]) for (const t of [-1, 1]) f.box(0.04, 0.38, 0.04, "#3a2a1e", lx + s * 0.45, 0.2, lz + 1.3 + t * 0.25, 0, 0);
  f.circle(lx, lz + 1.3, 0.5);
  shelves(f, -W / 2 + 0.25, lz + 3.6, 2.4, 2.2, 4, Math.PI / 2, BOOKS, 0.35, "#5a3d28", 0.12);
  for (const [x, z] of [[W / 2 - 0.6, zb + 0.7], [-W / 2 + 0.6, zf - 1.5], [W / 2 - 0.6, zf - 1.5], [W / 2 - 0.6, zb + 4.2]]) plant(f, x, z, 1.1, "#2f4a3a");
  for (const s of [-1, 1]) art(f, s * (W / 2 - 0.06), 2.6, zb + 6.6, 1.4, 1.0, s > 0 ? -Math.PI / 2 : Math.PI / 2, ["#c8763a", "#2f4a3a", "#e9b44c"]);
}

function pharmacy(f: F, W: number, zb: number, zf: number, h: number, wk: Worker[]) {
  finish(f, W, zb, zf, h, { wall: "#f7f9f8", panel: "#d6eee2", trim: "#2e8b57", floor: "#f2f5f4", floor2: "#dfe7e3", pattern: "check", wainscot: 0.9 }, "#f4fff9");
  const meds = ["#e94f4f", "#3b82f6", "#22c55e", "#f59e0b", "#ffffff", "#a855f7", "#ec4899", "#7dd3fc"];
  // Arka duvar: çekmeceli alt dolap, üstte açık raflar, yeşil haç ve tabela
  // Arka ünite personel kapısının (sol köşe) sağından başlar
  const ux0 = -W / 2 + 2.4, ux1 = W / 2 - 0.2, uw = ux1 - ux0, ucx = (ux0 + ux1) / 2;
  f.box(uw, 0.95, 0.5, "#ffffff", ucx, 0.475, zb + 0.3);
  for (let i = 0; i < Math.floor((uw - 0.2) / 0.5); i++) {
    for (let r = 0; r < 3; r++) {
      const x = ux0 + 0.35 + i * 0.5;
      f.box(0.44, 0.26, 0.02, "#eef3f1", x, 0.18 + r * 0.29, zb + 0.56, 0, 0);
      f.box(0.12, 0.025, 0.03, "#9aa2ab", x, 0.24 + r * 0.29, zb + 0.58, 0, 0);
    }
  }
  shelves(f, ucx, zb + 0.25, uw, 1.7, 4, 0, meds, 0.38, "#ffffff", 0.22, 0.97);
  f.wall(ux0, zb + 0.3, ux1, zb + 0.3, 0.3);
  f.sign("ECZANE", 2.8, 0.7, -0.6, 3.6, zb + 0.08);
  f.glow(0.32, 1.1, 0.12, "#38e07a", 2, 3.5, zb + 0.15);
  f.glow(1.1, 0.32, 0.12, "#38e07a", 2, 3.5, zb + 0.15);
  f.box(1.3, 1.3, 0.06, "#1d1e21", 2, 3.5, zb + 0.07, 0, 0);
  // Tezgâh: beyaz, yeşil şerit, şeffaf koruma camı, ekran, sepetler
  const cz = zb + 2.6;
  counter(f, 0, cz, W * 0.6, "#ffffff", "#e7ece9");
  f.box(W * 0.6, 0.08, 0.02, "#2e8b57", 0, 0.8, cz + 0.33, 0, 0);
  f.glass(W * 0.6 - 0.6, 0.6, 0.02, 0, 1.4, cz + 0.1);
  monitor(f, -1.2, 1.1, cz - 0.1, 0);
  for (const x of [0.6, 1.4]) {
    f.box(0.4, 0.12, 0.3, "#2e8b57", x, 1.16, cz + 0.15, 0, 0);
    for (let k = 0; k < 4; k++) f.box(0.08, 0.06, 0.12, meds[k], x - 0.12 + k * 0.08, 1.24, cz + 0.15, 0, 0);
  }
  f.npc(wk[0], 0, zb + 1.7, 0, 0, cz + 1.3);
  // Ortada iki kozmetik reyonu, yanlarda duvar rafları
  for (const s of [-1, 1]) {
    shelves(f, s * 2.4, cz + 3.6, 2.4, 1.4, 3, Math.PI, ["#f9c6d3", "#c6e2f9", "#fff1c1", "#d8c6f9", "#ffffff"], 0.35, "#ffffff", 0.2);
    shelves(f, s * 2.4, cz + 4.0, 2.4, 1.4, 3, 0, ["#f9c6d3", "#c6e2f9", "#fff1c1", "#d8c6f9", "#ffffff"], 0.35, "#ffffff", 0.2);
  }
  shelves(f, -W / 2 + 0.25, zf - 3.4, 3, 2, 4, Math.PI / 2, meds, 0.38, "#ffffff", 0.24);
  // Bekleme: üç sandalye, su sebili, tartı
  for (let k = 0; k < 3; k++) chair(f, W / 2 - 0.5, zf - 2.2 - k * 0.7, -Math.PI / 2, "#9aa2ab", "#2e8b57");
  f.box(0.35, 1.0, 0.35, "#f4f4f2", W / 2 - 0.45, 0.5, zf - 4.6);
  f.cyl(0.15, 0.15, 0.42, "#7dc4ee", W / 2 - 0.45, 1.22, zf - 4.6, 12);
  f.circle(W / 2 - 0.45, zf - 4.6, 0.3);
  f.box(0.5, 0.06, 0.4, "#2b2e33", -W / 2 + 1.2, 0.1, zf - 0.9);
  f.box(0.06, 1.0, 0.06, "#c9ccd1", -W / 2 + 1.2, 0.6, zf - 1.1, 0, 0);
  f.glow(0.24, 0.12, 0.02, "#7fd4ff", -W / 2 + 1.2, 1.15, zf - 1.07);
  plant(f, W / 2 - 0.5, zb + 3.6, 1);
}

function barber(f: F, W: number, zb: number, zf: number, h: number, wk: Worker[]) {
  finish(f, W, zb, zf, h, { wall: "#f1ece2", panel: "#7a2a2a", trim: "#c9a24a", floor: "#e9e3d8", floor2: "#6e655d", pattern: "check", wainscot: 1.1 }, "#fff0d0");
  for (const s of [-1, 1]) {
    const x = s * 1.7;
    // Ayna (pirinç çerçeve), altında tezgâh ve şişeler, üstte aplik
    f.box(1.4, 1.7, 0.04, "#c9a24a", x, 2.1, zb + 0.06, 0, 0);
    f.glass(1.25, 1.55, 0.02, x, 2.1, zb + 0.09);
    f.box(1.25, 1.55, 0.01, "#9fc0cc", x, 2.1, zb + 0.08, 0, 0);
    f.box(1.6, 0.85, 0.45, "#3a2a1e", x, 0.425, zb + 0.28);
    f.box(1.65, 0.04, 0.5, "#efeae2", x, 0.87, zb + 0.28, 0, 0);
    for (let k = 0; k < 5; k++) f.cyl(0.04, 0.045, 0.18 + (k % 2) * 0.06, ["#2e8b57", "#b3121c", "#1f4fbf", "#e9b44c", "#f4f4f0"][k], x - 0.5 + k * 0.22, 0.98, zb + 0.2, 8);
    f.box(0.5, 0.12, 0.3, "#f4f4f0", x + 0.45, 0.96, zb + 0.3, 0, 0);
    f.glow(0.5, 0.08, 0.08, "#fff0d0", x, 3.05, zb + 0.12);
    f.wall(x - 0.8, zb + 0.28, x + 0.8, zb + 0.28, 0.25);
    // Berber koltuğu: krom ayak, hidrolik gövde, kırmızı deri oturak, başlık, kolçak, ayaklık
    const cz = zb + 1.7;
    f.cyl(0.3, 0.34, 0.06, "#b9bec4", x, 0.03, cz, 18);
    f.cyl(0.08, 0.1, 0.42, "#b9bec4", x, 0.27, cz, 12);
    f.box(0.62, 0.14, 0.6, "#a8161d", x, 0.55, cz);
    f.box(0.66, 0.04, 0.64, "#c9ccd1", x, 0.47, cz, 0, 0);
    f.geo(new THREE.BoxGeometry(0.62, 0.8, 0.12).rotateX(0.12), "#a8161d", x, 0.98, cz + 0.32);
    f.box(0.34, 0.2, 0.1, "#a8161d", x, 1.5, cz + 0.4);
    for (const ax of [-1, 1]) {
      f.box(0.08, 0.06, 0.55, "#a8161d", x + ax * 0.35, 0.78, cz);
      f.box(0.04, 0.22, 0.04, "#c9ccd1", x + ax * 0.35, 0.66, cz - 0.2, 0, 0);
    }
    f.box(0.5, 0.04, 0.18, "#c9ccd1", x, 0.22, cz - 0.45, 0, 0);
    f.seat(x, cz, Math.PI, 0.62);
    f.circle(x, cz, 0.4);
  }
  // Şampuan lavabosu (sol duvar)
  f.box(0.8, 0.85, 0.6, "#f4f4f2", -W / 2 + 0.45, 0.425, zb + 4.2, 0, 0.02);
  f.geo(new THREE.CylinderGeometry(0.28, 0.2, 0.2, 16, 1, true), "#ffffff", -W / 2 + 0.45, 0.95, zb + 4.2);
  f.cyl(0.02, 0.02, 0.3, "#c9ccd1", -W / 2 + 0.2, 1.1, zb + 4.2, 6);
  f.circle(-W / 2 + 0.45, zb + 4.2, 0.4);
  // Bekleme: deri kanepe, sehpa ve dergiler, askılık, televizyon
  sofa(f, W / 2 - 0.55, zb + 4.6, -Math.PI / 2, 2.4, "#3a2a1e");
  f.box(0.5, 0.04, 1.0, "#6b4a2b", W / 2 - 1.6, 0.42, zb + 4.6);
  for (let k = 0; k < 3; k++) f.box(0.28, 0.02, 0.36, ["#b3121c", "#1f4fbf", "#e9b44c"][k], W / 2 - 1.6, 0.45 + k * 0.02, zb + 4.3 + k * 0.25, k * 0.3, 0);
  f.box(0.04, 0.4, 0.04, "#3a2a1e", W / 2 - 1.6, 0.2, zb + 4.6, 0, 0);
  f.circle(W / 2 - 1.6, zb + 4.6, 0.4);
  f.cyl(0.03, 0.03, 1.8, "#3a2a1e", -W / 2 + 0.5, 0.9, zf - 0.8, 6);
  f.cyl(0.22, 0.25, 0.03, "#3a2a1e", -W / 2 + 0.5, 0.015, zf - 0.8, 10);
  for (let k = 0; k < 4; k++) f.box(0.18, 0.03, 0.03, "#c9a24a", -W / 2 + 0.5 + Math.cos(k * 1.57) * 0.1, 1.72, zf - 0.8 + Math.sin(k * 1.57) * 0.1, k * 1.57, 0);
  f.box(1.4, 0.82, 0.06, "#111214", W / 2 - 0.06, 2.6, zb + 4.6, -Math.PI / 2, 0);
  f.glow(1.3, 0.72, 0.01, "#7fb6e8", W / 2 - 0.1, 2.6, zb + 4.6, -Math.PI / 2);
  for (const z of [zb + 6.5, zb + 8]) art(f, -W / 2 + 0.06, 2.4, z, 0.8, 1.0, Math.PI / 2, ["#1d1d1f", "#7a2a2a", "#c9a24a"]);
  // İçeride küçük berber direği
  f.cyl(0.08, 0.08, 0.1, "#c9a24a", 0, 1.3, zb + 0.15, 10);
  for (let k = 0; k < 5; k++) f.cyl(0.065, 0.065, 0.16, ["#d4111e", "#f4f4f0", "#1f4fbf"][k % 3], 0, 1.43 + k * 0.16, zb + 0.15, 10);
  f.cyl(0.08, 0.08, 0.1, "#c9a24a", 0, 2.25, zb + 0.15, 10);
  plant(f, W / 2 - 0.5, zf - 0.8, 1);
  f.npc(wk[0], 0.6, zb + 2.5, 0, 0, zb + 3.6);
}

function bank(f: F, W: number, zb: number, zf: number, h: number, wk: Worker[]) {
  finish(f, W, zb, zf, h, { wall: "#f3f0ea", panel: "#e3dfd6", trim: "#c9a24a", floor: "#ebe8e1", floor2: "#2b3a48", pattern: "marble", wainscot: 1.2 }, "#fff6e4");
  // Zeminde logo halkası
  f.geo(new THREE.TorusGeometry(1.6, 0.06, 4, 40).rotateX(Math.PI / 2), "#c9a24a", 0, 0.07, zf - 4.5);
  f.cyl(1.5, 1.5, 0.006, "#2b3a48", 0, 0.068, zf - 4.5, 40);
  // Vezne: mermer önlük, altın derzler, cam bölmeler, ekranlar, numaratörler
  const cz = zb + 3.0, len = 16;
  counter(f, 0, cz, len, "#e6e2da", "#2b2f35");
  for (let k = -4; k <= 4; k++) f.box(0.05, 0.9, 0.02, "#c9a24a", k * 2, 0.58, cz + 0.33, 0, 0);
  for (let k = 0; k < 4; k++) {
    const x = -6 + k * 4;
    f.glass(3.6, 1.0, 0.02, x, 1.6, cz + 0.05);
    f.box(0.06, 1.1, 0.08, "#c9a24a", x + 1.8, 1.6, cz + 0.05, 0, 0);
    monitor(f, x, 1.1, cz - 0.15, 0);
    f.box(0.5, 0.18, 0.06, "#1d1e21", x, 2.4, cz + 0.05, 0, 0);
    f.glow(0.4, 0.12, 0.02, "#ff3b3b", x, 2.4, cz + 0.09);
    // Arkada masa ve koltuk
    table(f, x, zb + 1.1, 1.4, 0.7, 0.75, "#3a3d44", "#2b2e33");
    chair(f, x, zb + 1.6, Math.PI, "#2b2e33", "#1d2b55");
  }
  f.npc(wk[0], 2, cz - 0.8, 0, 2, cz + 1.3);
  f.sign("GAP BANK", 4.4, 1.1, 0, 3.9, zb + 0.08);
  // Döviz panosu
  f.box(3.6, 1.6, 0.06, "#111214", -7.5, 3.3, zb + 0.06, 0, 0);
  for (let r = 0; r < 5; r++) {
    f.glow(1.2, 0.12, 0.01, "#e8f0ff", -8.4, 3.85 - r * 0.27, zb + 0.1);
    f.glow(0.7, 0.12, 0.01, r % 2 ? "#ff5c5c" : "#4dff88", -6.8, 3.85 - r * 0.27, zb + 0.1);
  }
  // Sıra bariyeri (direkler ve kırmızı halat)
  for (let k = 0; k < 4; k++) {
    for (const s of [-1, 1]) {
      const z = cz + 1.6 + k * 1.2, x = s * 1.2;
      f.cyl(0.04, 0.04, 0.95, "#c9a24a", x, 0.475, z, 8);
      f.cyl(0.16, 0.18, 0.04, "#c9a24a", x, 0.02, z, 12);
      if (k < 3) f.geo(new THREE.CylinderGeometry(0.025, 0.025, 1.2, 6).rotateX(Math.PI / 2), "#a8161d", x, 0.85, z + 0.6);
      f.circle(x, z, 0.1);
    }
  }
  // Sıra makinesi, ATM'ler, bekleme koltukları, broşür masası, bitkiler
  f.box(0.5, 1.4, 0.4, "#2b3a48", 3, 0.7, zf - 2);
  f.glow(0.36, 0.3, 0.02, "#9fd7ff", 3, 1.1, zf - 1.79);
  f.glow(0.3, 0.1, 0.02, "#ff3b3b", 3, 1.45, zf - 1.79);
  f.circle(3, zf - 2, 0.35);
  for (const z of [cz + 3, cz + 5]) {
    f.box(0.9, 1.75, 0.65, "#3a3f46", -W / 2 + 0.4, 0.875, z, Math.PI / 2);
    f.glow(0.02, 0.36, 0.44, "#7fd4ff", -W / 2 + 0.74, 1.35, z);
    f.box(0.06, 0.2, 0.3, "#1d1e21", -W / 2 + 0.76, 1.0, z, 0, 0);
    f.sign("GAP BANK", 0.62, 0.15, -W / 2 + 0.74, 1.62, z, Math.PI / 2);
    f.circle(-W / 2 + 0.4, z, 0.5);
  }
  for (let r = 0; r < 2; r++) for (let k = 0; k < 5; k++) chair(f, 4.5 + k * 0.8, cz + 3.2 + r * 1.6, Math.PI, "#2b2e33", "#1d2b55");
  f.cyl(0.4, 0.4, 0.04, "#2b2f35", -4, 1.05, zf - 2.5, 16);
  f.cyl(0.05, 0.05, 1.0, "#c9a24a", -4, 0.52, zf - 2.5, 8);
  f.circle(-4, zf - 2.5, 0.42);
  for (const [x, z] of [[-W / 2 + 0.6, zf - 0.8], [W / 2 - 0.6, zf - 0.8], [W / 2 - 0.6, cz + 1.6], [-W / 2 + 0.6, cz + 1.4]]) plant(f, x, z, 1.25, "#2b3a48");
  for (let k = 0; k < 4; k++) pendant(f, -6 + k * 4, cz + 1.2, 3.6, h, "#c9a24a");
}

function market(f: F, W: number, zb: number, zf: number, h: number, wk: Worker[]) {
  finish(f, W, zb, zf, h, { wall: "#f6f6f2", panel: "#2e8b57", trim: "#1f6b44", floor: "#e6e8e4", floor2: "#c9ccc7", pattern: "tile", wainscot: 0.6 }, "#f4fff9");
  const goods = ["#e94f4f", "#f59e0b", "#22c55e", "#3b82f6", "#fde047", "#f97316", "#a16207", "#ffffff", "#ec4899"];
  // Arka duvar: camlı soğutucular (içi ışıklı, raflarda ürünler)
  const fr = W - 1.2;
  f.box(fr, 2.3, 0.75, "#dfe6ea", 0, 1.15, zb + 0.4);
  for (let k = 0; k < Math.floor(fr / 1.0); k++) {
    const x = -fr / 2 + 0.5 + k * 1.0;
    f.glow(0.9, 1.8, 0.02, "#eaf8ff", x, 1.2, zb + 0.6);
    for (let l = 0; l < 4; l++) for (let j = 0; j < 3; j++) f.box(0.22, 0.2, 0.15, goods[(k + l + j) % goods.length], x - 0.28 + j * 0.28, 0.5 + l * 0.42, zb + 0.66, 0, 0.05);
    f.glass(0.92, 1.85, 0.02, x, 1.2, zb + 0.79);
    f.box(0.04, 0.4, 0.04, "#9aa2ab", x + 0.4, 1.2, zb + 0.82, 0, 0);
  }
  f.wall(-fr / 2, zb + 0.45, fr / 2, zb + 0.45, 0.42);
  f.sign("GAP MARKET", 3.4, 0.85, 0, 3.2, zb + 0.12);
  // Reyonlar (çift yüzlü), uçlarında kampanya rafı, üstte reyon tabelası
  const aisleZ = (zb + zf) / 2 - 1;
  for (const [i, x] of [-7.5, -4.5, -1.5, 1.5, 4.5].entries()) {
    // Çift yüzlü reyon: iki yarı sırt sırta, ürünler koridorlara bakar
    shelves(f, x - 0.22, aisleZ, 9, 1.7, 3, -Math.PI / 2, goods, 0.4, "#f1f1ee", 0.28);
    shelves(f, x + 0.22, aisleZ, 9, 1.7, 3, Math.PI / 2, goods, 0.4, "#f1f1ee", 0.28);
    f.box(0.9, 0.9, 0.5, "#e94f4f", x, 0.45, aisleZ + 4.8);
    for (let k = 0; k < 3; k++) f.box(0.25, 0.25, 0.25, goods[(k + i) % goods.length], x - 0.3 + k * 0.3, 1.03, aisleZ + 4.8, 0, 0.05);
    f.cyl(0.006, 0.006, h - 3, "#333", x, (h + 3) / 2, aisleZ, 4);
    f.box(0.9, 0.35, 0.04, "#2e8b57", x, 2.9, aisleZ, 0, 0);
    f.glow(0.3, 0.2, 0.05, "#ffffff", x, 2.9, aisleZ);
  }
  // Sağ duvar: manav (eğik kasalar ve meyveler)
  const fruits = ["#f97316", "#dc2626", "#84cc16", "#facc15", "#7c2d12"];
  for (let k = 0; k < 4; k++) {
    const z = zb + 3 + k * 1.6;
    f.geo(new THREE.BoxGeometry(1.0, 0.25, 1.4).rotateZ(-0.35), "#8a6a45", W / 2 - 0.8, 0.8, z);
    f.box(0.8, 0.7, 1.4, "#6b4a2b", W / 2 - 0.6, 0.35, z);
    for (let j = 0; j < 14; j++) {
      const r = 0.07 + (k === 3 ? 0.06 : 0);
      f.geo(new THREE.IcosahedronGeometry(r, 1), fruits[k], W / 2 - 1.1 + (j % 4) * 0.18, 0.98 - (j % 4) * 0.06 + Math.floor(j / 4) * 0.02, z - 0.55 + Math.floor(j / 4) * 0.3);
    }
    f.wall(W / 2 - 0.8, z - 0.7, W / 2 - 0.8, z + 0.7, 0.5);
  }
  // Sol duvar: ekmek ve içecek rafları
  shelves(f, -W / 2 + 0.25, zb + 6, 6, 2, 4, Math.PI / 2, ["#c8763a", "#a0522d", "#e9c58a", "#3b82f6", "#22c55e"], 0.42, "#e8e2d4", 0.3);
  // Kasalar: bant, ekran, poşet askısı, şeker rafı
  for (const [k, x] of [-3.5, 3.5].entries()) {
    const z = zf - 3.4;
    f.box(0.9, 0.95, 2.6, "#d9dcd8", x, 0.475, z);
    f.box(0.6, 0.03, 2.2, "#1a1a1a", x - 0.05, 0.965, z, 0, 0);
    monitor(f, x + 0.25, 0.97, z - 1.0, Math.PI / 2);
    f.box(0.7, 0.9, 0.3, "#f4f4f0", x - 0.9, 0.45, z - 1.5);
    for (let j = 0; j < 6; j++) f.box(0.12, 0.1, 0.06, goods[j], x - 1.15 + j * 0.1, 0.98, z - 1.5, 0, 0);
    f.wall(x, z - 1.3, x, z + 1.3, 0.48);
    if (k === 0) f.npc(wk[0], x + 0.85, z - 0.4, -Math.PI / 2, x - 1.2, z + 0.4);
  }
  // Alışveriş arabaları ve sepetler
  for (let k = 0; k < 4; k++) {
    const x = -W / 2 + 1.0 + k * 0.32, z = zf - 1.4;
    f.box(0.55, 0.4, 0.8, "#c9ccd1", x, 0.75, z, 0, 0);
    f.box(0.5, 0.03, 0.75, "#9aa2ab", x, 0.35, z, 0, 0);
    f.box(0.55, 0.04, 0.04, "#e94f4f", x, 1.0, z + 0.42, 0, 0);
    for (const s of [-1, 1]) for (const t of [-1, 1]) f.cyl(0.05, 0.05, 0.04, "#1a1a1a", x + s * 0.2, 0.06, z + t * 0.3, 8);
  }
  f.wall(-W / 2 + 0.6, zf - 1.4, -W / 2 + 2.2, zf - 1.4, 0.45);
  for (let k = 0; k < 5; k++) f.box(0.45, 0.2, 0.32, "#e94f4f", -W / 2 + 3, 0.1 + k * 0.08, zf - 1.2, 0, 0);
}

function hotel(f: F, W: number, zb: number, zf: number, h: number, wk: Worker[]) {
  finish(f, W, zb, zf, h, { wall: "#efe7d8", panel: "#5c3d24", trim: "#c9a24a", floor: "#f1ebe0", floor2: "#7a2a2a", pattern: "marble", wainscot: 1.3 }, "#ffe9c2");
  // Zemin madalyonu
  f.cyl(2.2, 2.2, 0.006, "#7a2a2a", 0, 0.068, (zb + zf) / 2 + 1, 40);
  f.geo(new THREE.TorusGeometry(2.2, 0.05, 4, 48).rotateX(Math.PI / 2), "#c9a24a", 0, 0.072, (zb + zf) / 2 + 1);
  for (let k = 0; k < 8; k++) f.box(0.12, 0.008, 3.6, "#c9a24a", 0, 0.072, (zb + zf) / 2 + 1, (k * Math.PI) / 8, 0);
  // Resepsiyon: tek parça kavisli masa, ön yüzü girişe bakar. Ceviz gövde, ortada arkadan aydınlatmalı mermer
  // bant, iki altın şerit, altın kenarlı granit tabla; içi (resepsiyonist tarafı) dolap yüzü, uçları kapalı
  const cz = zb + 2.8, R = 4.2, A = 0.7, DD = 0.7, oz = cz + 0.35 - R;
  const shell = (r: number, hgt: number, y: number, color: string, inner = false) => {
    const g = new THREE.CylinderGeometry(r, r, hgt, 48, 1, true, -A, 2 * A);
    f.geo(inner ? inward(g) : g, color, 0, y, oz);
  };
  const onArc = (r: number, t: number): [number, number] => [Math.sin(t) * r, oz + Math.cos(t) * r];
  shell(R - 0.06, 0.1, 0.05, "#1d1e21");
  shell(R, 0.95, 0.575, "#5c3d24");
  shell(R - DD, 1.05, 0.525, "#4a3220", true);
  f.glowGeo(new THREE.CylinderGeometry(R + 0.012, R + 0.012, 0.34, 48, 1, true, -A * 0.9, 2 * A * 0.9), "#ffe9c2", 0, 0.56, oz);
  for (const y of [0.33, 0.79]) {
    const L = 2 * A * 0.92;
    f.geo(new THREE.TorusGeometry(R + 0.02, 0.018, 4, 48, L).rotateX(Math.PI / 2).rotateY(L / 2 - Math.PI / 2), "#c9a24a", 0, y, oz);
  }
  f.geo(new THREE.RingGeometry(R - DD - 0.05, R + 0.08, 48, 1, -Math.PI / 2 - A, 2 * A).rotateX(-Math.PI / 2), "#2b2f35", 0, 1.1, oz);
  f.geo(new THREE.CylinderGeometry(R + 0.08, R + 0.08, 0.05, 48, 1, true, -A, 2 * A), "#c9a24a", 0, 1.075, oz);
  f.geo(inward(new THREE.CylinderGeometry(R - DD - 0.05, R - DD - 0.05, 0.05, 48, 1, true, -A, 2 * A)), "#2b2f35", 0, 1.075, oz);
  for (const s of [-1, 1]) {
    const [ex, ez] = onArc(R - DD / 2, s * A);
    f.box(0.06, 1.1, DD + 0.14, "#c9a24a", ex, 0.55, ez, s * A, 0);
  }
  for (let k = 0; k < 6; k++) f.wall(...onArc(R - DD / 2, -A + (k / 6) * 2 * A), ...onArc(R - DD / 2, -A + ((k + 1) / 6) * 2 * A), 0.4);
  // Tablada iki ekran (resepsiyoniste dönük), zil ve kayıt defteri
  for (const s of [-1, 1]) {
    const t = s * 0.36, [mx, mz] = onArc(R - DD + 0.22, t);
    monitor(f, mx, 1.12, mz, t + Math.PI);
  }
  const [bx0, bz0] = onArc(R - 0.2, 0.08);
  f.geo(new THREE.SphereGeometry(0.07, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), "#d6aa3c", bx0, 1.12, bz0);
  const [gx0, gz0] = onArc(R - 0.25, -0.12);
  f.box(0.34, 0.03, 0.24, "#7a2a2a", gx0, 1.13, gz0, -0.12, 0);
  f.npc(wk[0], 0, cz - 0.9, 0, 0, cz + 1.4);
  // Arka duvar: ceviz panel, tabela, üç saat
  f.box(8, h - 0.6, 0.06, "#5c3d24", 0, (h - 0.6) / 2, zb + 0.06, 0, 0.03);
  for (let k = -3; k <= 3; k++) f.box(0.03, h - 0.8, 0.02, "#c9a24a", k * 1.15, (h - 0.6) / 2, zb + 0.1, 0, 0);
  f.box(4.3, 1.2, 0.04, "#2a1c10", 0, 3.9, zb + 0.13, 0, 0);
  f.sign("OTEL GAP", 4, 1, 0, 3.9, zb + 0.17);
  for (const [k, name] of ["İST", "LON", "TYO"].entries()) {
    const x = -2 + k * 2;
    f.geo(new THREE.CylinderGeometry(0.32, 0.32, 0.05, 24).rotateX(Math.PI / 2), "#f6f2ea", x, 2.6, zb + 0.12);
    f.geo(new THREE.TorusGeometry(0.32, 0.03, 4, 24), "#c9a24a", x, 2.6, zb + 0.14);
    f.box(0.03, 0.22, 0.01, "#111", x, 2.68, zb + 0.15, 0, 0);
    f.box(0.16, 0.025, 0.01, "#111", x + 0.07, 2.6, zb + 0.15, 0, 0);
    void name;
  }
  // Mermer sütunlar
  for (const s of [-1, 1]) {
    const x = s * 5.5, z = zb + 6.5;
    f.box(0.9, 0.3, 0.9, "#c9a24a", x, 0.15, z, 0, 0);
    f.cyl(0.32, 0.32, h - 0.9, "#f4f2ee", x, 0.3 + (h - 0.9) / 2, z, 20);
    f.box(0.9, 0.3, 0.9, "#c9a24a", x, h - 0.5, z, 0, 0);
    f.circle(x, z, 0.4);
  }
  // Lounge: iki kanepe karşılıklı, iki berjer, sehpa, halı, ayaklı lambalar
  const lx = -W / 2 + 4.2, lz = zf - 4.8;
  rug(f, lx, lz, 4.2, 3.6, "#7a2a2a", "#c9a24a");
  sofa(f, lx, lz - 1.3, 0, 2.6, "#efe7d8");
  sofa(f, lx, lz + 1.3, Math.PI, 2.6, "#efe7d8");
  armchair(f, lx - 2.1, lz, Math.PI / 2, "#7a2a2a");
  f.box(1.2, 0.05, 0.7, "#2b2f35", lx, 0.42, lz);
  for (const s of [-1, 1]) f.box(0.05, 0.4, 0.6, "#c9a24a", lx + s * 0.5, 0.2, lz, 0, 0);
  f.circle(lx, lz, 0.6);
  for (const z of [lz - 2.2, lz + 2.2]) {
    f.cyl(0.02, 0.02, 1.6, "#c9a24a", lx + 1.8, 0.8, z, 6);
    f.cyl(0.2, 0.2, 0.03, "#c9a24a", lx + 1.8, 0.015, z, 12);
    f.geo(new THREE.CylinderGeometry(0.16, 0.24, 0.3, 14, 1, true), "#f6efe0", lx + 1.8, 1.65, z);
    f.glowGeo(new THREE.SphereGeometry(0.07, 8, 6), "#ffe9c2", lx + 1.8, 1.6, z);
  }
  // Asansörler, bavul arabası, bitkiler
  for (const z of [zb + 4.5, zb + 7]) {
    f.box(0.08, 2.5, 1.6, "#c9a24a", W / 2 - 0.05, 1.25, z, 0, 0);
    for (const s of [-1, 1]) f.box(0.03, 2.3, 0.7, "#b9bec4", W / 2 - 0.1, 1.15, z + s * 0.36, 0, 0);
    f.glow(0.02, 0.15, 0.4, "#ff9a3c", W / 2 - 0.1, 2.7, z);
    f.glow(0.02, 0.1, 0.06, "#9fd7ff", W / 2 - 0.1, 1.2, z + 1.0);
  }
  const bx = W / 2 - 1.6, bz = zf - 2.4;
  f.box(1.1, 0.06, 0.6, "#d6aa3c", bx, 0.3, bz);
  for (const s of [-1, 1]) f.box(0.05, 1.6, 0.05, "#d6aa3c", bx + s * 0.5, 1.1, bz, 0, 0);
  f.box(1.1, 0.05, 0.05, "#d6aa3c", bx, 1.9, bz, 0, 0);
  for (const [k, c] of ["#7a2622", "#1d2b55", "#2f4a3a"].entries()) f.box(0.42, 0.5 - k * 0.1, 0.32, c, bx - 0.25 + k * 0.25, 0.6 + k * 0.05, bz, k * 0.2);
  f.circle(bx, bz, 0.6);
  for (const [x, z] of [[-W / 2 + 0.6, zb + 0.7], [W / 2 - 0.6, zb + 0.7], [-W / 2 + 0.6, zf - 0.7], [W / 2 - 0.6, zf - 0.7]]) plant(f, x, z, 1.3, "#c9a24a");
  // Avize
  const chz = (zb + zf) / 2 + 1;
  for (const [r, y, n] of [[1.4, h - 1.2, 18], [0.9, h - 1.55, 12]] as const) {
    f.geo(new THREE.TorusGeometry(r, 0.04, 4, 32).rotateX(Math.PI / 2), "#d6aa3c", 0, y, chz);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      f.glowGeo(new THREE.OctahedronGeometry(0.07), "#fff6e4", Math.cos(a) * r, y - 0.18, chz + Math.sin(a) * r);
    }
  }
  f.cyl(0.02, 0.02, 1.0, "#d6aa3c", 0, h - 0.8, chz, 6);
}

function mall(f: F, W: number, zb: number, zf: number, h: number, wk: Worker[]) {
  finish(f, W, zb, zf, h, { wall: "#f7f6f2", panel: "#d9d6cf", trim: "#9aa2ab", floor: "#efeeea", floor2: "#d3d1cb", pattern: "tile", wainscot: 0 }, "#f5f9ff");
  const depth = 5.6, front = W / 2 - depth;
  const shopZ0 = zb + 7.6, shopZ1 = zf - 3.2, half = (shopZ1 - shopZ0) / 2;
  // İki yanda ikişer mağaza: cam vitrin (kapı boşluklu), ayırıcı duvar, tabela alınlığı
  const stores: [number, number, string, string][] = [
    [-1, shopZ1 - half / 2, "GAP MODA", "#f6eef0"],
    [-1, shopZ0 + half / 2, "EROTİK SHOP", "#3a1426"],
    [1, shopZ1 - half / 2, "GAP TEKNO", "#e9eef4"],
    [1, shopZ0 + half / 2, "OYUNCAKÇI", "#fdf3d8"],
  ];
  for (const s of [-1, 1]) {
    const fx = s * front;
    for (const z of [shopZ0, shopZ0 + half, shopZ1]) {
      f.box(depth, h - 0.3, 0.15, "#f2f1ec", s * (W / 2 - depth / 2), (h - 0.3) / 2, z, 0, 0.02);
      f.wall(fx, z, s * W / 2, z, 0.1);
    }
  }
  for (const [s, cz, name, floor] of stores) {
    const fx = s * front, a = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    f.box(depth - 0.2, 0.01, half - 0.2, floor, s * (W / 2 - depth / 2), 0.07, cz, 0, 0.03);
    for (const t of [-1, 1]) {
      const z0 = cz + t * 1.25, z1 = cz + t * (half / 2);
      f.glass(0.03, 2.9, Math.abs(z1 - z0), fx, 1.55, (z0 + z1) / 2);
      f.box(0.08, 3.0, 0.08, "#9aa2ab", fx, 1.5, z1, 0, 0);
      f.box(0.08, 3.0, 0.08, "#9aa2ab", fx, 1.5, z0, 0, 0);
      f.wall(fx, z0, fx, z1, 0.06);
    }
    f.box(0.2, h - 3.1, half, "#2b2f35", fx, 3.1 + (h - 3.1) / 2, cz, 0, 0);
    f.sign(name, 2.6, 0.65, fx + (s > 0 ? -0.11 : 0.11), 3.7, cz, a);
    for (let k = 0; k < 2; k++) f.glow(depth - 1, 0.02, 0.4, "#fff6e4", s * (W / 2 - depth / 2), h - 0.33, cz - 1 + k * 2);
    const ix = s * (W / 2 - 0.5);
    if (name === "GAP MODA") {
      for (const z of [cz - 1.6, cz + 1.6]) {
        f.box(0.04, 1.5, 1.6, "#c9ccd1", ix - s * 1.6, 1.5, z, 0, 0);
        for (const t of [-0.75, 0.75]) f.box(0.04, 1.5, 0.04, "#c9ccd1", ix - s * 1.6, 0.75, z + t, 0, 0);
        for (let k = 0; k < 8; k++) f.box(0.36, 0.7, 0.05, ["#e94f4f", "#1d2b55", "#f4f4f0", "#2e8b57", "#e889b5", "#1b1b1d"][k % 6], ix - s * 1.6, 1.1, z - 0.7 + k * 0.2, 0, 0.03);
        f.wall(ix - s * 1.6, z - 0.8, ix - s * 1.6, z + 0.8, 0.3);
      }
      for (const z of [cz - 1.9, cz + 1.9]) {
        const mx = fx + s * 1.0;
        f.cyl(0.18, 0.2, 0.04, "#2b2e33", mx, 0.02, z, 12);
        f.cyl(0.03, 0.03, 0.8, "#9aa2ab", mx, 0.42, z, 6);
        f.cyl(0.16, 0.12, 0.7, z < cz ? "#e94f4f" : "#1d2b55", mx, 1.15, z, 12);
        f.geo(new THREE.SphereGeometry(0.12, 12, 8), "#f4f1ea", mx, 1.65, z);
        f.circle(mx, z, 0.25);
      }
      shelves(f, s * (W / 2 - 0.25), cz, half - 0.6, 2.2, 4, a, ["#f4f4f0", "#1d2b55", "#c8763a", "#9aa2ab"], 0.4, "#ffffff", 0.35);
      f.npc(wk[2], fx + s * 2.2, cz + 1.0, a, fx + s * 0.9, cz + 1.0);
    } else if (name === "GAP TEKNO") {
      for (const z of [cz - 1.2, cz + 1.2]) {
        table(f, ix - s * 2.2, z, 1.6, 0.8, 0.9, "#f4f4f2", "#2b2e33");
        for (let k = 0; k < 3; k++) {
          f.box(0.08, 0.01, 0.16, "#111", ix - s * 2.2 - 0.5 + k * 0.5, 0.91, z, 0, 0);
          f.glow(0.07, 0.005, 0.14, "#7fd4ff", ix - s * 2.2 - 0.5 + k * 0.5, 0.918, z);
        }
      }
      for (let k = 0; k < 3; k++) {
        const z = cz - 1.6 + k * 1.6;
        f.box(0.06, 0.8, 1.3, "#111214", s * (W / 2 - 0.06), 2.4, z, 0, 0);
        f.glow(0.01, 0.7, 1.2, ["#3fa9ff", "#a86bff", "#4dff88"][k], s * (W / 2 - 0.1), 2.4, z);
      }
      shelves(f, s * (W / 2 - 0.25), cz, half - 0.6, 1.5, 3, a, ["#111", "#9aa2ab", "#f4f4f0", "#3b82f6"], 0.4, "#2b2e33", 0.3);
    } else if (name === "EROTİK SHOP") {
      // Butik: bordo kadife duvar, pembe ışık, arka duvarda kalp neonu, siyah raflarda pembe/mor kutular,
      // iç çamaşırlı iki manken, kadife perdeli "+18" köşesi, altın kasa tezgâhı
      const wx = s * (W / 2 - 0.08);
      f.box(0.04, h - 0.6, half - 0.4, "#5a1030", wx, (h - 0.6) / 2, cz, 0, 0.03);
      f.glowGeo(new THREE.TorusGeometry(0.42, 0.035, 6, 32, Math.PI).rotateY(Math.PI / 2).translate(0, 0.2, -0.21), "#ff4f9a", wx - s * 0.04, 2.15, cz);
      f.glowGeo(new THREE.TorusGeometry(0.42, 0.035, 6, 32, Math.PI).rotateY(Math.PI / 2).translate(0, 0.2, 0.21), "#ff4f9a", wx - s * 0.04, 2.15, cz);
      for (const t of [-1, 1]) f.glowGeo(new THREE.CylinderGeometry(0.035, 0.035, 0.85, 6).rotateX(t * 0.785), "#ff4f9a", wx - s * 0.04, 1.93, cz + t * 0.3);
      for (const z of [cz - 1.9, cz + 1.9]) shelves(f, s * (W / 2 - 0.25), z, 1.4, 2.0, 4, a, ["#ff4f9a", "#a855f7", "#1b1b1d", "#e11d48", "#f9a8d4"], 0.35, "#141015", 0.22);
      // Mankenler: siyah ve kırmızı dantel takım, pembe sabahlık
      for (const [z, top, bottom] of [[cz - 0.9, "#141015", "#141015"], [cz + 0.9, "#c8102e", "#c8102e"]] as const) {
        const mx = fx + s * 1.3;
        f.cyl(0.2, 0.22, 0.04, "#2b2e33", mx, 0.02, z, 14);
        const skin = "#f1d5c4";
        f.cyl(0.025, 0.025, 0.72, "#c9a24a", mx, 0.38, z, 6);
        f.cyl(0.15, 0.1, 0.16, skin, mx, 0.8, z, 16);
        f.cyl(0.16, 0.15, 0.16, bottom, mx, 0.95, z, 16);
        f.cyl(0.12, 0.16, 0.3, skin, mx, 1.18, z, 16);
        f.cyl(0.17, 0.12, 0.2, skin, mx, 1.43, z, 16);
        f.cyl(0.175, 0.17, 0.11, top, mx, 1.42, z, 16);
        f.cyl(0.07, 0.17, 0.1, skin, mx, 1.58, z, 16);
        f.cyl(0.04, 0.045, 0.12, skin, mx, 1.67, z, 8);
        f.geo(new THREE.SphereGeometry(0.1, 12, 10), skin, mx, 1.82, z);
        f.circle(mx, z, 0.25);
      }
      // "+18" kabini: yan duvarın dibinde bordo kadife perde ve üstünde küçük neon (arka duvardaki kalbi kapatmaz)
      const px = ix - s * 1.4, pz = cz + half / 2 - 0.9;
      f.box(1.6, 2.6, 0.06, "#2b2f35", px, 1.3, pz, 0, 0);
      for (let k = 0; k < 8; k++) f.box(0.2, 2.4, 0.08, k % 2 ? "#7a0f2e" : "#8e1538", px - 0.7 + k * 0.2, 1.2, pz - 0.05, 0, 0.02);
      f.glow(0.5, 0.22, 0.02, "#ff2d6f", px, 2.75, pz - 0.08);
      f.wall(px - 0.8, pz, px + 0.8, pz, 0.1);
      rug(f, fx + s * 2.0, cz, 2.2, 3.0, "#6b0f2e", "#ff4f9a", a);
      for (let k = 0; k < 2; k++) f.glow(depth - 1.2, 0.02, 0.3, "#ff7ab8", s * (W / 2 - depth / 2), h - 0.36, cz - 0.6 + k * 1.2);
    } else {
      shelves(f, s * (W / 2 - 0.25), cz, half - 0.6, 2.2, 4, a, ["#e94f4f", "#facc15", "#3b82f6", "#22c55e", "#f97316", "#a855f7"], 0.42, "#ffffff", 0.35);
      for (let k = 0; k < 18; k++) f.geo(new THREE.IcosahedronGeometry(0.12, 1), ["#e94f4f", "#facc15", "#3b82f6", "#22c55e"][k % 4], ix - s * 2.2 + (k % 3) * 0.2, 0.55 + Math.floor(k / 9) * 0.15, cz - 0.4 + (Math.floor(k / 3) % 3) * 0.25);
      f.box(0.9, 0.5, 0.9, "#f97316", ix - s * 2.2, 0.25, cz, 0, 0.02);
      f.circle(ix - s * 2.2, cz, 0.55);
      for (const z of [cz - 1.4, cz + 1.4]) {
        f.geo(new THREE.SphereGeometry(0.28, 12, 8), "#8a5a2b", ix - s * 2.0, 0.3, z);
        f.geo(new THREE.SphereGeometry(0.2, 12, 8), "#8a5a2b", ix - s * 2.0, 0.72, z);
        for (const e of [-1, 1]) f.geo(new THREE.SphereGeometry(0.07, 8, 6), "#6b4226", ix - s * 2.0 + e * 0.13, 0.9, z);
        f.circle(ix - s * 2.0, z, 0.3);
      }
    }
  }
  // Atrium: fıskiyeli havuz, çiçek halkası, çevresinde banklar
  const az = (shopZ0 + shopZ1) / 2;
  f.cyl(2.3, 2.4, 0.5, "#e8e5de", 0, 0.25, az, 32);
  f.geo(new THREE.TorusGeometry(2.33, 0.07, 6, 40).rotateX(Math.PI / 2), "#9aa2ab", 0, 0.5, az);
  f.glowGeo(new THREE.CylinderGeometry(2.15, 2.15, 0.03, 32), "#6fc8ee", 0, 0.46, az);
  f.cyl(0.3, 0.45, 1.0, "#e8e5de", 0, 0.9, az, 14);
  f.cyl(0.9, 0.5, 0.25, "#e8e5de", 0, 1.5, az, 20);
  f.glowGeo(new THREE.CylinderGeometry(0.05, 0.1, 1.2, 8), "#d8f4ff", 0, 2.2, az);
  f.glowGeo(new THREE.CylinderGeometry(0.9, 1.9, 1.0, 24, 1, true), "#a8e4ff", 0, 1.0, az);
  f.circle(0, az, 2.4);
  // Havuzun çevresinde dört bank (havuza sırtını dönmez: dışa bakar) ve aralarında saksılar
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4, r = 3.4;
    bench(f, Math.sin(a) * r, az + Math.cos(a) * r, a, 1.8);
    const b2 = a + Math.PI / 4;
    plant(f, Math.sin(b2) * 3.3, az + Math.cos(b2) * 3.3, 0.8, "#9aa2ab");
  }
  // Atriumun üstünde çatı penceresi (parlayan kare ve kayıtlar)
  f.box(6.4, 0.06, 6.4, "#9aa2ab", 0, h - 0.33, az, 0, 0);
  f.glow(6, 0.02, 6, "#eaf6ff", 0, h - 0.35, az);
  for (const t of [-1, 0, 1]) {
    f.box(0.08, 0.04, 6, "#9aa2ab", t * 2, h - 0.37, az, 0, 0);
    f.box(6, 0.04, 0.08, "#9aa2ab", 0, h - 0.37, az + t * 2, 0, 0);
  }
  // Yemek katı: Burger GAP tezgâhı, dondurmacı, masalar
  const fz = zb + 1.6;
  counter(f, -3.5, fz, 6, "#a8161d", "#f2c230");
  f.sign("BURGER GAP", 4.2, 1.05, -3.5, 3.6, zb + 0.08);
  for (let k = 0; k < 3; k++) f.glow(1.3, 0.8, 0.02, ["#ffe14d", "#ff9a3c", "#ffe14d"][k], -5 + k * 1.5, 2.5, zb + 0.08);
  f.box(5.5, 0.9, 0.55, "#c9ccd1", -3.5, 0.45, zb + 0.4);
  for (let k = 0; k < 3; k++) f.box(0.5, 0.35, 0.4, "#9aa2ab", -5 + k * 1.5, 1.12, zb + 0.4, 0, 0);
  f.npc(wk[0], -3.5, zb + 0.9, 0, -3.5, fz + 1.3);
  counter(f, 4, fz, 3.4, "#f9c6d3", "#ffffff");
  f.sign("DONDURMA", 2.6, 0.65, 4, 3.4, zb + 0.08);
  f.glass(3.0, 0.4, 0.5, 4, 1.32, fz);
  for (let k = 0; k < 8; k++) f.cyl(0.12, 0.12, 0.08, ["#f9c6d3", "#fff1c1", "#7c2d12", "#c6f9d8"][k % 4], 2.8 + (k % 4) * 0.8, 1.18, fz - 0.1 + Math.floor(k / 4) * 0.2, 12);
  for (const x of [-6, -2, 2, 6]) cafeSet(f, x, zb + 4.6, 0, "#f4f1ea", "#9aa2ab", "#a8161d");
  // Giriş: danışma, yön panosu, ATM, bitkiler; güvenlik görevlisi
  const ix0 = 2.8, iz = zf - 2.6, R = 1.15, arc = Math.PI * 1.4, a0 = Math.PI - arc / 2 + Math.PI;
  // Arkası açık (C biçimli) danışma masası: dış kabuk, iç kabuk, tabla, alt LED; görevli içinde durur
  f.geo(new THREE.CylinderGeometry(R, R, 1.05, 32, 1, true, a0, arc), "#f4f4f2", ix0, 0.525, iz);
  f.geo(inward(new THREE.CylinderGeometry(R - 0.45, R - 0.45, 1.05, 28, 1, true, a0, arc)), "#e4e2dc", ix0, 0.525, iz);
  f.geo(new THREE.RingGeometry(R - 0.5, R + 0.05, 32, 1, a0 - Math.PI / 2, arc).rotateX(-Math.PI / 2), "#2b2f35", ix0, 1.07, iz);
  f.glowGeo(new THREE.TorusGeometry(R + 0.01, 0.02, 4, 32, arc).rotateX(Math.PI / 2).rotateY(arc / 2 - Math.PI / 2), "#7fd4ff", ix0, 0.15, iz);
  for (let k = 0; k <= 6; k++) {
    const a = a0 + (k / 6) * arc, b2 = a0 + ((k + 1) / 6) * arc;
    if (k < 6) f.wall(ix0 + Math.sin(a) * (R - 0.2), iz + Math.cos(a) * (R - 0.2), ix0 + Math.sin(b2) * (R - 0.2), iz + Math.cos(b2) * (R - 0.2), 0.25);
  }
  monitor(f, ix0 - 0.3, 1.09, iz + 0.45, 0);
  f.sign("BİLGİ", 1.2, 0.3, ix0, 1.75, iz + R + 0.03);
  f.npc(wk[1], ix0, iz - 0.15, 0, ix0, iz + R + 0.9);
  f.box(1.4, 2.0, 0.12, "#2b2f35", -2.6, 1.0, iz, 0, 0);
  f.glow(1.2, 1.7, 0.02, "#e8f0ff", -2.6, 1.05, iz + 0.07);
  for (let k = 0; k < 6; k++) f.box(0.9, 0.08, 0.01, ["#e94f4f", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ec4899"][k], -2.6, 1.6 - k * 0.2, iz + 0.085, 0, 0);
  f.circle(-2.6, iz, 0.4);
  for (const [x, z] of [[-1.6, zf - 0.8], [1.6, zf - 0.8], [-front + 0.8, az], [front - 0.8, az]]) plant(f, x, z, 1.3, "#9aa2ab");
  // Girişin üstünde tavandan iki kabloyla asılı, çift yüzlü pankart
  {
    const bz = zf - 5, bw = 2.4, bh = 0.6, by = h - 1.0;
    for (const s of [-1, 1]) f.cyl(0.006, 0.006, h - 0.35 - (by + bh / 2), "#333", s * (bw / 2 - 0.2), (h - 0.35 + by + bh / 2) / 2, bz, 4);
    f.box(bw + 0.1, bh + 0.1, 0.03, "#1a0f2e", 0, by, bz, 0, 0);
    f.sign("GAP AVM", bw, bh, 0, by, bz + 0.025);
    f.sign("GAP AVM", bw, bh, 0, by, bz - 0.025, Math.PI);
  }
}

const THEMES: Record<Theme, (f: F, W: number, zb: number, zf: number, h: number, wk: Worker[]) => void> = { cafe, pharmacy, barber, bank, market, hotel, mall };
/** Kullanılan derinlik (m): bunun arkası personel bölmesi. */
const DEPTH: Record<Theme, number> = { cafe: 12, pharmacy: 11, barber: 10.5, bank: 13.5, market: 99, hotel: 14, mall: 99 };
/** Personel kapısının yeri: sağ (+1) ya da sol (−1) arka köşe. */
const STAFF_DOOR: Record<Theme, number> = { cafe: 1, pharmacy: -1, barber: 1, bank: 1, market: 1, hotel: 1, mall: 1 };

/**
 * Dükkânın içini döşer. W, D iç ölçüler; kapı yerel +z'de. Kullanılan alanın dünya kutusunu döndürür
 * (arkada personel bölmesi varsa kamera ondan öteye geçmesin diye oda bununla daraltılır).
 */
export function furnish(kit: Kit, shop: string, x: number, z: number, W: number, D: number, h: number, face: number): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  const k = SHOPS[shop];
  if (!k) return null;
  const f = frame(kit, x, z, face);
  const zf = D / 2, du = Math.min(D, DEPTH[k.theme]), zb = zf - du;
  if (du < D - 0.5) partition(f, W, zb, h, "#f2efe8", STAFF_DOOR[k.theme] * (W / 2 - 1.6));
  THEMES[k.theme](f, W, zb, zf, h, k.workers);
  const [ax, az] = f.at(-W / 2, zb), [bx, bz] = f.at(W / 2, zf);
  return { minX: Math.min(ax, bx), maxX: Math.max(ax, bx), minZ: Math.min(az, bz), maxZ: Math.max(az, bz) };
}
