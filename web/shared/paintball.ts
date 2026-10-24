// GAP Paintball: köyde, kahvehaneyle nehir arasında ağ çevrili turnuva sahası (şişme engeller). 1v1 süreli
// deathmatch: vurulan 3 sn sonra kendi üssünde doğar, süre bitince en çok vuran kazanır. Birinci şahıs; toplar
// yavaş ve bombeli gider (sürtünmeli balistik), engele/yere çarpınca boya lekesi bırakır.
// Sunucu (isabet, maç) ve istemci (sahne, top çizimi, çarpışma) aynı tanımları kullanır.

/** Saha (dünya koordinatı): uzun kenar z boyunca. Ağ kenarlarda. */
export const PB_FIELD = { x: -56, z: 32, hx: 10, hz: 18 };
export const NET_H = 4.2;
/** Bilet kulübesi (sıraya girme, silah skinleri): sahanın batısında, köy yoluna bakar. */
export const PB_BOOTH = { x: -71.2, z: 19.5, r: 3.2 };
/** Maç bitince oyuncuların bırakıldığı yer (ağın dışında, kulübenin yanı). */
export const PB_EXIT = { x: -68.6, z: 15.2, rot: -Math.PI / 2 };
/** Tribün: batı ağının dışında, sahaya bakar. */
export const PB_STANDS = { x: -69.4, z: 34, hw: 1.9, hd: 8 };
/** Kenarda sahayı izleyenin yakınlığı (kulübe ve tribün dahil). */
export const PB_AREA = { minX: -76, maxX: -42, minZ: 10, maxZ: 54 };

export const PB = {
  matchMs: 3 * 60 * 1000,
  countMs: 5000,
  endMs: 8000,
  respawnMs: 3000,
  /** Doğduktan sonra bu kadar vurulmaz (doğar doğmaz vurulmasın). */
  safeMs: 1500,
  /** Hazne, atış aralığı (dakikada 400), doldurma süresi. */
  hopper: 20,
  fireMs: 150,
  reloadMs: 2000,
  /** Sıradaki oyuncu sayısı sınırı. */
  maxQueue: 12,
  /** Gecikme telafisi: atanın gördüğü ana en çok bu kadar geri gidilir. */
  maxRewindMs: 350,
} as const;

// ---- Top balistiği: doğrusal sürtünmeli atış (kapalı form; sunucu ve istemci aynı yolu hesaplar) ----

export const BALL = { speed: 48, drag: 0.4, gravity: 9.8, r: 0.035, life: 2.5 };

export interface Shot {
  o: [number, number, number];
  /** Birim yön. */
  d: [number, number, number];
}

/** Atıştan `t` sn sonra topun yeri. */
export function ballAt(s: Shot, t: number, out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
  const k = BALL.drag, g = BALL.gravity;
  const e = 1 - Math.exp(-k * t);
  const r = (BALL.speed * e) / k;
  out.x = s.o[0] + s.d[0] * r;
  out.y = s.o[1] + s.d[1] * r - (g / k) * t + (g / (k * k)) * e;
  out.z = s.o[2] + s.d[2] * r;
  return out;
}

/** Topun hızı (çizimde iz yönü). */
export function ballVel(s: Shot, t: number, out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
  const k = BALL.drag, g = BALL.gravity;
  const f = Math.exp(-k * t);
  out.x = s.d[0] * BALL.speed * f;
  out.y = s.d[1] * BALL.speed * f - (g / k) * (1 - f);
  out.z = s.d[2] * BALL.speed * f;
  return out;
}

// ---- Engeller: şişme bunker'lar (kapsül: a–b ekseni, yarıçap, yükseklik; a = b ise silindir) ----

export type BunkerKind = "can" | "tower" | "dorito" | "cake" | "snake" | "brick";

export interface Bunker {
  kind: BunkerKind;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
  h: number;
}

const round = (kind: BunkerKind, x: number, z: number, r: number, h: number): Bunker => ({ kind, ax: x, az: z, bx: x, bz: z, r, h });
const long = (kind: BunkerKind, x: number, z: number, len: number, alongZ: boolean, r: number, h: number): Bunker => {
  const dx = alongZ ? 0 : len / 2, dz = alongZ ? len / 2 : 0;
  return { kind, ax: x - dx, az: z - dz, bx: x + dx, bz: z + dz, r, h };
};

// Sahanın yarısı (yerel; −z birinci oyuncunun üssü), merkeze göre 180° döndürülerek tamamlanır: iki taraf birebir aynı.
const HALF: Bunker[] = [
  long("brick", 0, -13.6, 1.6, false, 0.6, 1.25),
  round("can", -4.6, -12.4, 0.55, 1.5),
  round("can", 4.4, -11.8, 0.55, 1.5),
  round("dorito", -7.4, -8.8, 0.8, 1.35),
  long("snake", -8.4, -4.2, 5.6, true, 0.5, 0.85),
  round("tower", 3.6, -7.6, 0.8, 2.4),
  round("cake", -0.4, -5.6, 1.3, 1.05),
  round("dorito", 7.6, -4.4, 0.8, 1.35),
  long("brick", -4.2, -2.6, 1.8, true, 0.6, 1.3),
  round("can", 4.8, -1.4, 0.55, 1.6),
];

/** Yerel bunker listesi (saha merkezine göre). */
export const BUNKERS_LOCAL: Bunker[] = [
  ...HALF,
  ...HALF.map((b) => ({ ...b, ax: -b.bx, az: -b.bz, bx: -b.ax, bz: -b.az })),
  round("tower", 0, 0, 1.1, 2.8),
];

/** Dünya koordinatında bunker'lar. */
export const BUNKERS: Bunker[] = BUNKERS_LOCAL.map((b) => ({ ...b, ax: b.ax + PB_FIELD.x, az: b.az + PB_FIELD.z, bx: b.bx + PB_FIELD.x, bz: b.bz + PB_FIELD.z }));

/** Noktanın bunker eksenine yatay uzaklığı ve eksendeki en yakın nokta. */
export function bunkerDist(b: Bunker, x: number, z: number): { d: number; cx: number; cz: number } {
  const ex = b.bx - b.ax, ez = b.bz - b.az;
  const len2 = ex * ex + ez * ez;
  const t = len2 ? Math.max(0, Math.min(1, ((x - b.ax) * ex + (z - b.az) * ez) / len2)) : 0;
  const cx = b.ax + ex * t, cz = b.az + ez * t;
  return { d: Math.hypot(x - cx, z - cz), cx, cz };
}

/** Dorito'nun gövdesi yukarı doğru incelir (piramit); diğerleri dik kenarlı ve tepesi yuvarlak. */
export function bunkerRadiusAt(b: Bunker, y: number): number {
  if (y < 0 || y > b.h) return -1;
  if (b.kind === "dorito") return b.r * (1 - (y / b.h) * 0.85);
  const top = Math.min(b.r, 0.4);
  const u = y - (b.h - top);
  return u <= 0 ? b.r : b.r - top + Math.sqrt(Math.max(0, top * top - u * u));
}

export type BallStop = { kind: "ground" } | { kind: "bunker"; i: number } | { kind: "net" };

/** Topu durduran şey (yer, bunker, ağ) ya da null. */
export function ballBlocked(x: number, y: number, z: number): BallStop | null {
  if (y <= 0) return { kind: "ground" };
  const lx = x - PB_FIELD.x, lz = z - PB_FIELD.z;
  if ((Math.abs(lx) > PB_FIELD.hx || Math.abs(lz) > PB_FIELD.hz) && y < NET_H && Math.abs(lx) < PB_FIELD.hx + 0.6 && Math.abs(lz) < PB_FIELD.hz + 0.6) return { kind: "net" };
  if (Math.abs(lx) > PB_FIELD.hx + 1 || Math.abs(lz) > PB_FIELD.hz + 1) return null;
  for (let i = 0; i < BUNKERS.length; i++) {
    const b = BUNKERS[i];
    if (y > b.h + BALL.r) continue;
    const r = bunkerRadiusAt(b, Math.min(y, b.h));
    if (r < 0) continue;
    if (bunkerDist(b, x, z).d < r + BALL.r) return { kind: "bunker", i };
  }
  return null;
}

// ---- Oyuncu: isabet silindiri, göz hizası, hız ----

export const PLAYER = {
  hitR: 0.42,
  standH: 1.45,
  crouchH: 1.0,
  eye: 1.32,
  crouchEye: 0.86,
  /** Normal yürüyüş hızının çarpanı (sahada koşu yok) ve çömelince. */
  speed: 1.2,
  crouchSpeed: 0.5,
};

/** Top bu oyuncuya değiyor mu (ayak noktası x, y, z). */
export function hitsPlayer(bx: number, by: number, bz: number, px: number, py: number, pz: number, crouch: boolean): boolean {
  const top = py + (crouch ? PLAYER.crouchH : PLAYER.standH);
  if (by < py - BALL.r || by > top + BALL.r) return false;
  return Math.hypot(bx - px, bz - pz) < PLAYER.hitR + BALL.r;
}

/** Oyuncunun sahada kalacağı dikdörtgen (ağdan biraz içeride). */
export const PB_INNER = {
  minX: PB_FIELD.x - PB_FIELD.hx + 0.5,
  maxX: PB_FIELD.x + PB_FIELD.hx - 0.5,
  minZ: PB_FIELD.z - PB_FIELD.hz + 0.5,
  maxZ: PB_FIELD.z + PB_FIELD.hz - 0.5,
};

/** Ağın içinde mi (maç dışında oraya girilmez: kaldığın yerden devam saha içine konmaz). */
export function inPbField(x: number, z: number): boolean {
  return Math.abs(x - PB_FIELD.x) < PB_FIELD.hx + 0.4 && Math.abs(z - PB_FIELD.z) < PB_FIELD.hz + 0.4;
}

/** Doğma noktaları: her oyuncunun kendi üssü (0: kuzey, 1: güney), sahanın ortasına bakar. */
export function spawnSpots(slot: 0 | 1): { x: number; z: number; rot: number }[] {
  const s = slot === 0 ? -1 : 1;
  return [-5, 0, 5].map((x) => ({ x: PB_FIELD.x + x * s, z: PB_FIELD.z + s * 16.4, rot: slot === 0 ? 0 : Math.PI }));
}

/** Boya renkleri: her oyuncunun topu ve lekesi. */
export const PAINT = ["#ff7a1a", "#2fb8ff"] as const;

// ---- Silah skinleri: galibiyetle açılır ----

export interface GunSkin {
  id: string;
  name: string;
  /** Açmak için gereken paintball galibiyeti. */
  wins: number;
  body: string;
  accent: string;
  hopper: string;
  tank: string;
  /** Gövdede üçgen başına rastgele seçilen tonlar (kamuflaj, karbon). */
  pattern?: string[];
  /** Vurgu parçaları ışık saçar (neon, efsane). */
  glow?: number;
}

export const GUN_SKINS: GunSkin[] = [
  { id: "klasik", name: "Klasik", wins: 0, body: "#2c2f34", accent: "#8b929b", hopper: "#3a3f46", tank: "#c7cbd1" },
  { id: "simsek", name: "Kırmızı Şimşek", wins: 0, body: "#c9302c", accent: "#232323", hopper: "#ececec", tank: "#2a2a2a" },
  { id: "okyanus", name: "Okyanus", wins: 1, body: "#1f6fd1", accent: "#e9f2ff", hopper: "#163f73", tank: "#dfe7f2" },
  { id: "orman", name: "Orman Kamuflaj", wins: 3, body: "#4b5d33", accent: "#2b2f22", hopper: "#5d6b3c", tank: "#3d4a2b", pattern: ["#4b5d33", "#6b7a43", "#2f3a22", "#7c6a46"] },
  { id: "col", name: "Çöl", wins: 5, body: "#c9a978", accent: "#6e5a3c", hopper: "#b8956a", tank: "#8a7454", pattern: ["#c9a978", "#d8bd8f", "#a78659", "#e1cda6"] },
  { id: "neon", name: "Neon", wins: 8, body: "#17171b", accent: "#39ff7a", hopper: "#ff3fb4", tank: "#39ff7a", glow: 0.9 },
  { id: "sakura", name: "Sakura", wins: 12, body: "#f6c7d7", accent: "#ffffff", hopper: "#f08fb0", tank: "#fbe3ec", pattern: ["#f6c7d7", "#f9d9e5", "#ec9fbb", "#ffffff"] },
  { id: "karbon", name: "Karbon", wins: 16, body: "#1c1d20", accent: "#d23b3b", hopper: "#2a2c30", tank: "#3a3d42", pattern: ["#1c1d20", "#2b2d31", "#141517"] },
  { id: "altin", name: "Altın", wins: 25, body: "#d4a531", accent: "#8a6a1c", hopper: "#f1cf63", tank: "#b88a22", glow: 0.25 },
  { id: "efsane", name: "GAP Efsane", wins: 40, body: "#4a1f86", accent: "#ffcf3a", hopper: "#7a3fd1", tank: "#ffcf3a", glow: 0.8 },
];

export function gunSkin(id: string | null | undefined): GunSkin {
  return GUN_SKINS.find((s) => s.id === id) ?? GUN_SKINS[0];
}
