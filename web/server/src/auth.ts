// Discord OAuth2 code değişimi ve kısa ömürlü, HMAC imzalı oturum token'ları.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionUser {
  id: string;
  name: string;
  avatar: string | null;
  guest: boolean;
}

interface SessionPayload extends SessionUser {
  exp: number;
}

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signSession(user: SessionUser, secret: string, now = Date.now()): string {
  const payload: SessionPayload = { ...user, exp: now + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body, secret)}`;
}

export function verifySession(token: string, secret: string, now = Date.now()): SessionUser | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(body, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof p.exp !== "number" || p.exp < now) return null;
    return { id: p.id, name: p.name, avatar: p.avatar, guest: p.guest };
  } catch {
    return null;
  }
}

export function cleanName(raw: unknown, fallback: string): string {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f]/g, "").trim() : "";
  return (s || fallback).slice(0, 32);
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

/** Activity'nin verdiği code'u access token'a çevirir ve kullanıcıyı getirir. */
export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; user: SessionUser }> {
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!userRes.ok) throw new Error(`user fetch failed: ${userRes.status}`);
  const u = (await userRes.json()) as DiscordUser;
  return {
    accessToken: access_token,
    user: { id: u.id, name: cleanName(u.global_name || u.username, "Gezgin"), avatar: u.avatar ?? null, guest: false },
  };
}
