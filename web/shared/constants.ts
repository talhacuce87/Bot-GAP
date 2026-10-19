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
