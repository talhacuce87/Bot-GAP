// Chibi kıyafetleri: kayıt ve doğrulama botta (outfit.py), dünya yalnızca aracı.
// Odaya yayınlanan kıyafet her zaman botun temizlediği hâlidir; istemcinin gönderdiği değil.
import { LOOK_COLORS, LOOK_SLOTS, type Look, type WardrobeInfo } from "../../shared/protocol";

/** Botun iç HTTP ucuna JSON POST (WORLD_SHARED_SECRET ile). */
export type BotPost = (path: string, body: unknown) => Promise<{ ok: boolean; body: Record<string, unknown> }>;

export const WARDROBE_COOLDOWN_MS = 1000;
export const OUTFIT_COOLDOWN_MS = 1500;

const ID = /^[a-z0-9_]{1,48}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** İstemciden gelen kıyafetin biçimini denetler (içerik kuralları botta). Bozuksa null. */
export function sanitizeLook(raw: unknown): Look | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Look = {};
  for (const slot of LOOK_SLOTS) {
    const v = src[slot];
    if (v === null || v === undefined || v === "") out[slot] = null;
    else if (typeof v === "string" && ID.test(v)) out[slot] = v;
    else return null;
  }
  const colors = src.colors && typeof src.colors === "object" ? (src.colors as Record<string, unknown>) : {};
  out.colors = {};
  for (const c of LOOK_COLORS) {
    const v = colors[c];
    if (typeof v === "string" && HEX.test(v)) out.colors[c] = v.toLowerCase();
  }
  return out;
}

/** Odaya giren üyenin kayıtlı kıyafeti; bot yoksa ya da cevap bozuksa null (varsayılan çizilir). */
export async function fetchLook(post: BotPost, guild: string, userId: string): Promise<Look | null> {
  try {
    const r = await post("/internal/outfits", { guild, users: [userId] });
    const outfits = r.body.outfits as Record<string, unknown> | undefined;
    return r.ok && outfits ? sanitizeLook(outfits[userId]) : null;
  } catch {
    return null;
  }
}

export async function fetchWardrobe(post: BotPost, guild: string, userId: string): Promise<WardrobeInfo | { error: string }> {
  try {
    const r = await post("/internal/wardrobe", { guild, user: userId });
    const outfit = sanitizeLook(r.body.outfit);
    if (!r.ok || !outfit) return { error: "Gardırop şu an açılamıyor, biraz sonra tekrar dene." };
    const locked: Record<string, number> = {};
    for (const [k, v] of Object.entries((r.body.locked as Record<string, unknown>) || {})) if (typeof v === "number") locked[k] = v;
    return { outfit, level: Number(r.body.level) || 1, locked };
  } catch {
    return { error: "Gardırop şu an açılamıyor (bot bağlı değil)." };
  }
}

const SAVE_REFUSED: Record<string, string> = {
  not_member: "Kıyafet kaydetmek için bu sunucunun üyesi olmalısın.",
};

export async function saveLook(
  post: BotPost,
  guild: string,
  userId: string,
  look: Look,
): Promise<{ look: Look; dropped: string[] } | { error: string }> {
  try {
    const r = await post("/internal/outfit", { guild, user: userId, outfit: look });
    const clean = sanitizeLook(r.body.outfit);
    if (!r.ok || !r.body.ok || !clean) return { error: SAVE_REFUSED[String(r.body.reason)] ?? "Kıyafet kaydedilemedi, biraz sonra tekrar dene." };
    const dropped = Array.isArray(r.body.dropped) ? r.body.dropped.map(String) : [];
    return { look: clean, dropped };
  } catch {
    return { error: "Kıyafet kaydedilemedi (bot bağlı değil)." };
  }
}
