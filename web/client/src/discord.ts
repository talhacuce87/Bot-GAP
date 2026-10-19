// Giriş: Discord Activity içindeysek SDK + OAuth2, değilse (tarayıcı/geliştirme) misafir oturumu.
import type { DiscordSDK } from "@discord/embedded-app-sdk";

export interface Session {
  mode: "discord" | "guest";
  session: string;
  user: { id: string; name: string; avatar: string | null };
  /** WebSocket ve API istekleri için önek ("/.proxy" ya da ""). */
  base: string;
  wsUrl: string;
  sdk?: DiscordSDK;
}

/** Discord, Activity'yi `frame_id` ve `instance_id` sorgu parametreleriyle açar. */
export function inDiscord(): boolean {
  const q = new URLSearchParams(location.search);
  return q.has("frame_id") && q.has("instance_id");
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

function wsBase(base: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${base}/ws`;
}

export async function login(): Promise<Session> {
  if (!inDiscord()) return guestLogin();

  const base = "/.proxy";
  const config = await (await fetch(`${base}/api/config`)).json();
  if (!config.clientId) throw new Error("Sunucuda DISCORD_CLIENT_ID ayarlı değil.");
  const { DiscordSDK } = await import("@discord/embedded-app-sdk");
  const sdk = new DiscordSDK(config.clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: config.clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });
  const res = await post<{ access_token: string; session: string; user: Session["user"] }>(`${base}/api/token`, { code });
  await sdk.commands.authenticate({ access_token: res.access_token });
  const q = new URLSearchParams({ session: res.session, instance: sdk.instanceId });
  return { mode: "discord", session: res.session, user: res.user, base, wsUrl: `${wsBase(base)}?${q}`, sdk };
}

async function guestLogin(): Promise<Session> {
  const params = new URLSearchParams(location.search);
  let name = params.get("name") || "";
  try {
    name ||= localStorage.getItem("gap-world-name") || "";
  } catch {
    // depolama kapalı olabilir
  }
  const res = await post<{ session: string; user: Session["user"] }>("/api/guest", { name });
  try {
    localStorage.setItem("gap-world-name", res.user.name);
  } catch {
    // depolama kapalı olabilir
  }
  const room = (params.get("room") || "lobi").replace(/[^\w-]/g, "").slice(0, 32) || "lobi";
  const q = new URLSearchParams({ session: res.session, room });
  return { mode: "guest", session: res.session, user: res.user, base: "", wsUrl: `${wsBase("")}?${q}` };
}
