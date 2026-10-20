// İstemci ve sunucunun ortak sabitleri.

/** Sunucunun anlık görüntü (snapshot) yayın hızı. */
export const TICK_HZ = 15;
/** İstemcinin konum gönderme hızı. */
export const SEND_HZ = 15;
/** Uzak oyuncular bu kadar geriden (ms) interpolasyonla çizilir. */
export const INTERP_DELAY_MS = 100;

/** Yürünebilir alanın yarıçapı (metre). */
export const WORLD_RADIUS = 100;
/** Oyuncu yürüme hızı (m/sn). */
export const WALK_SPEED = 4.2;
/** Koşarken (Shift / joystick sonuna kadar) hız çarpanı. */
export const RUN_MULTIPLIER = 1.9;
/** Avatar gövdesinin çarpışma yarıçapı. */
export const PLAYER_RADIUS = 0.4;

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
export const FLAG_MASK = FLAG_WALKING | FLAG_SEATED | JUMP_MASK | FLAG_RUNNING | FLAG_DRIVING;

/** Herkesin zıplaması aynı: uzak istemciler yayı yükseklik göndermeden aynen çizer. */
export const JUMP_VELOCITY = 6.2;
export const GRAVITY = 19;
export const JUMP_TIME = (2 * JUMP_VELOCITY) / GRAVITY;

/** Zıplamanın başından `t` sn sonraki yükseklik (havada değilse 0). */
export function jumpHeight(t: number): number {
  return t > 0 && t < JUMP_TIME ? JUMP_VELOCITY * t - 0.5 * GRAVITY * t * t : 0;
}

/** Konumlar santimetre hassasiyetinde int16 olarak gönderilir. */
export const POS_SCALE = 100;

/**
 * Zindan hücresinin iç alanı (oyuncu merkezinin gidebileceği sınırlar, yarıçap düşülmüş).
 * Sürgündekiler burada doğar; sunucu da istemci de bu kutunun dışına çıkmalarına izin vermez.
 */
export const JAIL = { minX: -58.3, maxX: -51.4, minZ: 2.0, maxZ: 8.0 };
export const JAIL_SPAWN = { x: -54.8, z: 5, rot: Math.PI / 2 };
/** Sürgün bitince parmaklıkların önüne çıkarılır. */
export const RELEASE_SPAWN = { x: -48.3, z: 5, rot: Math.PI / 2 };

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
 * Konumlar sahnedeki yerleşimle aynı olmalı (zones.ts: GROVE + 0.6, zindan parmaklığı x=-50.9).
 */
export const ACT_SPOTS = {
  grill: { x: 58.6, z: 5, r: 3 },
  bars: { x: -48.6, z: 5, r: 4.5 },
} as const;
export const ACTS = ["grill", "tea", "tomato"] as const;
export type Act = (typeof ACTS)[number];
export const ACT_COOLDOWN_MS = 1200;
/** Atılan çay/domatesin, sürgünde kimse yoksa düştüğü yer: hücrenin ortası. */
export const JAIL_CENTER = { x: (JAIL.minX + JAIL.maxX) / 2, z: (JAIL.minZ + JAIL.maxZ) / 2 };

/** Gölde balık tutma: gölün çevresinde (zones.ts POND, su yarıçapı 6.5). Zar ve günlük sınır botta. */
export const FISH_SPOT = { x: 24, z: 56, r: 9 };
/** Bot'a sorulmadan önce kişi başı bekleme: yanıt gelene kadar tekrar basılmasın. */
export const FISH_COOLDOWN_MS = 3000;

export function actSpot(a: Act): { x: number; z: number; r: number } {
  return a === "grill" ? ACT_SPOTS.grill : ACT_SPOTS.bars;
}
