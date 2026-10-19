// Şöhret Kürsüsü: bot'un gönderdiği sunucu bazlı XP sıralamaları.
import type { BoardEntry } from "../../shared/protocol";
import { cleanName } from "./auth";

export const BOARD_SIZE = 10;

export interface Board {
  updated: number;
  entries: BoardEntry[];
}

/** Gelen satırları doğrular ve kırpar; bozuk satırlar atlanır. */
export function sanitizeEntries(raw: unknown): BoardEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BoardEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const e = r as Record<string, unknown>;
    const id = String(e.id ?? "");
    if (!/^\d{5,20}$/.test(id)) continue;
    const avatar = typeof e.avatar === "string" && /^(a_)?[0-9a-f]{32}$/.test(e.avatar) ? e.avatar : null;
    const level = Math.max(0, Math.floor(Number(e.level) || 0));
    const xp = Math.max(0, Math.floor(Number(e.xp) || 0));
    out.push({ id, name: cleanName(e.name, `Üye ${id.slice(-4)}`), avatar, level, xp });
    if (out.length >= BOARD_SIZE) break;
  }
  return out;
}

export class Boards {
  private byGuild = new Map<string, Board>();

  replace(guilds: Record<string, unknown>, now = Date.now()): void {
    const next = new Map<string, Board>();
    for (const [gid, entries] of Object.entries(guilds)) {
      if (/^\d{5,20}$/.test(gid)) next.set(gid, { updated: now, entries: sanitizeEntries(entries) });
    }
    this.byGuild = next;
  }

  /** Oyuncunun sunucusunun panosu; sunucu bilinmiyorsa (misafir) ilk pano. */
  for(guild: string | null): Board | null {
    if (guild) return this.byGuild.get(guild) ?? null;
    return this.byGuild.values().next().value ?? null;
  }
}
