// İstemci ve sunucunun ortak sabitleri.

/** Sunucunun anlık görüntü (snapshot) yayın hızı. */
export const TICK_HZ = 15;
/** İstemcinin konum gönderme hızı. */
export const SEND_HZ = 15;
/** Uzak oyuncular bu kadar geriden (ms) interpolasyonla çizilir. */
export const INTERP_DELAY_MS = 100;

/** Yürünebilir alanın yarıçapı (metre). */
export const WORLD_RADIUS = 28;
/** Oyuncu yürüme hızı (m/sn). */
export const WALK_SPEED = 4.2;
/** Avatar gövdesinin çarpışma yarıçapı. */
export const PLAYER_RADIUS = 0.4;

/** Bir odada konumu yayınlanan en fazla oyuncu; fazlası izleyici olarak girer. */
export const ROOM_MAX_PLAYERS = 100;

/** Oyuncu durum bitleri. */
export const FLAG_WALKING = 1;
export const FLAG_SEATED = 2;

/** Konumlar santimetre hassasiyetinde int16 olarak gönderilir. */
export const POS_SCALE = 100;
