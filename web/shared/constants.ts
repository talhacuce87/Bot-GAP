// İstemci ve sunucunun ortak sabitleri.
import { CITY, GROVE, inStadium, inVolley, KAHVEHANE, LAKE, ROAD_WALK, roadDist, STADIUM, VOLLEY_HALL } from "./zones";
import { RACE_AREA } from "./ring";
import { HOOD_BOX, HOOD_CORNER } from "./build";
import { MOSQUE_AREA } from "./mosque";

/** Sunucunun anlık görüntü (snapshot) yayın hızı. */
export const TICK_HZ = 15;
/**
 * İstemcinin konum gönderme hızı: yayının iki katı, böylece her snapshot'ta herkesin en fazla
 * yarım yayın aralığı eski konumu olur. Her örnek kendi zamanını taşır (bkz. encodeState).
 */
export const SEND_HZ = 30;
/** Uzak oyuncuların çizim gecikmesinin başlangıç değeri (ms); sonra ölçüme göre ayarlanır (client/src/jitter.ts). */
export const INTERP_DELAY_MS = 100;

/** Köyün yürünebilir alanı (dikdörtgen, metre); kenarında ağaçlar, güneyinde dağlar. */
export const WORLD_BOUNDS = { minX: -135, maxX: 125, minZ: -88, maxZ: 162 };
/**
 * Bütün dünyayı (köy, doğudaki vadi yolu, GAP Şehri, batıdaki mahalle) kapsayan kutu. Gerçek sınır arazidedir: köyün ve
 * şehrin dışı ile yol koridorunun iki yanı tepe olarak yükselir (bkz. `outsideWorld`).
 */
export const WORLD_EXTENT = {
  minX: HOOD_BOX.minX,
  maxX: CITY.maxX,
  minZ: Math.min(WORLD_BOUNDS.minZ, CITY.minZ, RACE_AREA.minZ, HOOD_BOX.minZ),
  maxZ: Math.max(WORLD_BOUNDS.maxZ, HOOD_BOX.maxZ, MOSQUE_AREA.maxZ),
};

function outsideRect(b: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number): number {
  return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));
}

/** Köşeleri `r` yarıçapıyla yuvarlatılmış dikdörtgenin dışına uzaklık (içinde 0). */
function outsideRoundRect(b: { minX: number; maxX: number; minZ: number; maxZ: number }, r: number, x: number, z: number): number {
  return Math.max(0, outsideRect({ minX: b.minX + r, maxX: b.maxX - r, minZ: b.minZ + r, maxZ: b.maxZ - r }, x, z) - r);
}

/** Yürünür alanın (köy ∪ otoban koridoru ∪ şehir ∪ yarış pisti ∪ mahalle) dışına uzaklık; içinde 0. */
export function outsideWorld(x: number, z: number): number {
  return Math.min(
    outsideRect(WORLD_BOUNDS, x, z),
    outsideRect(CITY, x, z),
    outsideRect(RACE_AREA, x, z),
    // GAP Camii: şehrin güney kenarına bitişik
    outsideRect(MOSQUE_AREA, x, z),
    Math.max(0, roadDist(x, z) - ROAD_WALK),
    outsideRoundRect(HOOD_BOX, HOOD_CORNER, x, z),
  );
}

/**
 * `p`yi dünya sınırının `pad` kadar içinde tutar (yerinde değiştirir). Stadyumda ya da voleybol salonundaysa
 * onun içinde. Yürünür dünyadaki (köy, vadi yolu, şehir, pist) nokta ışınlanma bölgelerine çekilmez: vadi yolu
 * voleybol salonunun bölgesinin kenarından geçer.
 */
export function clampToWorld(p: { x: number; z: number }, pad = 0): void {
  const inWorld = outsideWorld(p.x, p.z) === 0;
  if (!inWorld && inStadium(p.x, p.z)) {
    const s = STADIUM;
    p.x = Math.min(s.x + s.hw - pad, Math.max(s.x - s.hw + pad, p.x));
    p.z = Math.min(s.z + s.hd - pad, Math.max(s.z - s.hd + pad, p.z));
    return;
  }
  if (!inWorld && inVolley(p.x, p.z)) {
    // Salonun içi (duvar kalınlığı kadar içeride)
    const s = VOLLEY_HALL, m = 0.6;
    p.x = Math.min(s.x + s.hw - m - pad, Math.max(s.x - s.hw + m + pad, p.x));
    p.z = Math.min(s.z + s.hd - m - pad, Math.max(s.z - s.hd + m + pad, p.z));
    return;
  }
  p.x = Math.min(WORLD_EXTENT.maxX - pad, Math.max(WORLD_EXTENT.minX + pad, p.x));
  p.z = Math.min(WORLD_EXTENT.maxZ - pad, Math.max(WORLD_EXTENT.minZ + pad, p.z));
}
/** Oyuncu yürüme hızı (m/sn). */
export const WALK_SPEED = 4.2;
/** Koşarken (Shift / joystick sonuna kadar) hız çarpanı. */
export const RUN_MULTIPLIER = 1.9;
/** Avatar gövdesinin çarpışma yarıçapı. */
export const PLAYER_RADIUS = 0.4;
/** Bu kadar alçak bir basamağa zıplamadan çıkılır (kütük, alçak taş). */
export const STEP_UP = 0.2;

/** Bir odada konumu yayınlanan en fazla oyuncu; fazlası izleyici olarak girer. */
export const ROOM_MAX_PLAYERS = 100;

/** Oyuncu durum bitleri. */
export const FLAG_WALKING = 1;
export const FLAG_SEATED = 2;
/** 2 bitlik zıplama sayacı: her yeni zıplamada artar, böylece arka arkaya zıplamalar da kaçmaz. */
export const JUMP_SHIFT = 2;
export const JUMP_MASK = 0b1100;
export const FLAG_RUNNING = 16;
/** Tankı sürüyor: avatarı çizilmez, konumu tankın konumudur. */
export const FLAG_DRIVING = 32;
/** 2 bitlik araç: 0 yaya, 1 bisiklet, 2 kaykay, 3 kayık. */
export const VEHICLE_SHIFT = 6;
export const VEHICLE_MASK = 0b11000000;
export const FLAG_MASK = FLAG_WALKING | FLAG_SEATED | JUMP_MASK | FLAG_RUNNING | FLAG_DRIVING | VEHICLE_MASK;

export const VEHICLES = [
  { name: "Yürü", emoji: "🚶", speed: 1 },
  { name: "Bisiklet", emoji: "🚲", speed: 2.3 },
  { name: "Kaykay", emoji: "🛹", speed: 1.9 },
  { name: "Kayık", emoji: "🛶", speed: 0.75 },
] as const;
export type Vehicle = 0 | 1 | 2 | 3;

export function vehicleOf(flags: number): Vehicle {
  return ((flags & VEHICLE_MASK) >> VEHICLE_SHIFT) as Vehicle;
}

/** Araçlıyken koşma yok: hız araç çarpanıyla (sunucu hız sınırı da buna göre). */
export function maxSpeed(flags: number): number {
  const v = vehicleOf(flags);
  return WALK_SPEED * (v ? VEHICLES[v].speed : RUN_MULTIPLIER);
}

/**
 * Herkesin zıplaması aynı: uzak istemciler yayı yükseklik göndermeden aynen çizer.
 * Parabol yerine "havada süzülen" eğri: hızlı ama yumuşak kalkış, tepede asılı kalma,
 * çıkıştan daha uzun ve yavaş iniş (yere sert çarpmaz).
 */
export const JUMP_PEAK = 1.3;
export const JUMP_TIME = 1.05;
/** Voleybol salonunda zıplama daha yüksek ve uzun (smaç ve blokta filenin üstüne çıkılır). */
export const VJUMP_PEAK = 2.3;
export const VJUMP_TIME = 1.35;
/** Sürenin bu kadarı çıkış, kalanı iniş. */
const JUMP_RISE = 0.4;

/** Zıplamanın süresi (`volley`: voleybol salonunda). */
export function jumpTime(volley = false): number {
  return volley ? VJUMP_TIME : JUMP_TIME;
}

/** Zıplamanın başından `t` sn sonraki yükseklik (havada değilse 0). */
export function jumpHeight(t: number, volley = false): number {
  const T = jumpTime(volley), peak = volley ? VJUMP_PEAK : JUMP_PEAK;
  if (!(t > 0 && t < T)) return 0;
  const u = t / T;
  if (u < JUMP_RISE) return peak * (1 - (1 - u / JUMP_RISE) ** 2);
  const s = (u - JUMP_RISE) / (1 - JUMP_RISE);
  // Tepede yavaş başlar, sona doğru hızlanır ama son anda biraz yumuşar
  return peak * (1 - s ** 2.2) * (1 - 0.15 * s ** 8);
}

/** Konumlar 2 cm hassasiyetinde int16 olarak gönderilir: ±655 m, şehir (x ≈ 550) dahil bütün dünya sığar. */
export const POS_SCALE = 50;

/**
 * Zindan hücresinin iç alanı (oyuncu merkezinin gidebileceği sınırlar, yarıçap düşülmüş).
 * Sürgündekiler burada doğar; sunucu da istemci de bu kutunun dışına çıkmalarına izin vermez.
 */
export const JAIL = { minX: 41.7, maxX: 48.6, minZ: 125, maxZ: 131 };
export const JAIL_SPAWN = { x: 45.2, z: 128, rot: Math.PI / 2 };
/** Sürgün bitince parmaklıkların önüne (mağaranın içine) çıkarılır. */
export const RELEASE_SPAWN = { x: 51.7, z: 128, rot: Math.PI / 2 };

export function clampToJail(p: { x: number; z: number }): void {
  p.x = Math.min(JAIL.maxX, Math.max(JAIL.minX, p.x));
  p.z = Math.min(JAIL.maxZ, Math.max(JAIL.minZ, p.z));
}

/** Emote'lar: sıra önemli (1–6 tuşları ve tel protokolündeki indeks). */
export const EMOTES = [
  { emoji: "👋", name: "El salla", anim: "wave" },
  { emoji: "😂", name: "Gül", anim: "hop" },
  { emoji: "❤️", name: "Kalp", anim: "hop" },
  { emoji: "🔥", name: "Ateş", anim: "hop" },
  { emoji: "👏", name: "Alkış", anim: "hop" },
  { emoji: "💃", name: "Dans", anim: "dance" },
] as const;
/** Kişi başı emote aralığı (sunucu da uygular). */
export const EMOTE_COOLDOWN_MS = 600;

/**
 * Etkileşim noktaları (sunucu mesafeyi doğrular): mangal ve zindan parmaklıklarının önü.
 * Konumlar sahnedeki yerleşimle aynı olmalı (zones.ts: GROVE + 0.6, zindan parmaklığı x=49.1).
 */
export const ACT_SPOTS = {
  grill: { x: GROVE.x + 0.6, z: GROVE.z, r: 3 },
  bars: { x: 51.4, z: 128, r: 4.5 },
} as const;
export const ACTS = ["grill", "tea", "tomato", "cay"] as const;
export type Act = (typeof ACTS)[number];
export const ACT_COOLDOWN_MS = 1200;
/** Atılan çay/domatesin, sürgünde kimse yoksa düştüğü yer: hücrenin ortası. */
export const JAIL_CENTER = { x: (JAIL.minX + JAIL.maxX) / 2, z: (JAIL.minZ + JAIL.maxZ) / 2 };

/** Gölde balık tutma: gölün çevresinde (zones.ts POND, su yarıçapı 6.5). Zar ve günlük sınır botta. */
export const FISH_SPOT = { x: LAKE.x, z: LAKE.z, r: LAKE.r + 2.5 };
/** Bot'a sorulmadan önce kişi başı bekleme: yanıt gelene kadar tekrar basılmasın. */
export const FISH_COOLDOWN_MS = 3000;

/** Kahvehane çay ocağı (shared/zones.ts TEA_COUNTER ile aynı). */
export const TEA_SPOT = { x: KAHVEHANE.x - 5.6, z: KAHVEHANE.z + 3.6, r: 2.4 };

export function actSpot(a: Act): { x: number; z: number; r: number } {
  return a === "grill" ? ACT_SPOTS.grill : a === "cay" ? TEA_SPOT : ACT_SPOTS.bars;
}
