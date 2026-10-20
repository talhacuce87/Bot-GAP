// Giriş: Discord Activity içindeysek SDK + OAuth2, değilse (tarayıcı/geliştirme) misafir oturumu.
import type { DiscordSDK } from "@discord/embedded-app-sdk";

export interface Session {
  /** discord: Activity içinde • watch: tarayıcıda izleme odası (/w/<id>) • guest: geliştirme/test */
  mode: "discord" | "watch" | "guest";
  session: string;
  user: { id: string; name: string; avatar: string | null };
  /** WebSocket ve API istekleri için önek ("/.proxy" ya da ""). */
  base: string;
  wsUrl: string;
  sdk?: DiscordSDK;
  /** İzleme odasının kimliği (mode === "watch"). */
  watchId?: string;
}

/** Bot'un attığı izleme linki: https://<dünya>/w/<oda> */
export function watchIdFromPath(): string | null {
  return /^\/w\/([\w-]{6,16})\/?$/.exec(location.pathname)?.[1] ?? null;
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

let session: Promise<Session> | null = null;

/** Oturum bir kez açılır; dünya ↔ savaş geçişinde Discord girişi tekrarlanmaz. */
export function login(): Promise<Session> {
  session ??= openSession().catch((err) => {
    session = null;
    throw err;
  });
  return session;
}

async function openSession(): Promise<Session> {
  const watchId = watchIdFromPath();
  if (watchId) return watchLogin(watchId);
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
  if (sdk.guildId) q.set("guild", sdk.guildId);
  return { mode: "discord", session: res.session, user: res.user, base, wsUrl: `${wsBase(base)}?${q}`, sdk };
}

/** Tarayıcıda izleme odası: çerezdeki Discord oturumu; yoksa girişe yönlendir (geliştirmede misafir). */
async function watchLogin(watchId: string): Promise<Session> {
  const base = { mode: "watch" as const, base: "", watchId };
  const me = await fetch("/api/me");
  if (me.ok) {
    const { user } = await me.json();
    return { ...base, session: "", user, wsUrl: `${wsBase("")}?watch=${watchId}` };
  }
  const { loginRequired } = await me.json().catch(() => ({ loginRequired: true }));
  if (loginRequired) {
    location.href = `/auth/login?next=${encodeURIComponent(location.pathname)}`;
    return new Promise(() => {}); // yönlendirme sürerken bekle
  }
  const guest = await guestLogin();
  return { ...base, session: guest.session, user: guest.user, wsUrl: `${wsBase("")}?watch=${watchId}&session=${encodeURIComponent(guest.session)}` };
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
  if (params.get("jail") === "1") q.set("jail", "1");
  return { mode: "guest", session: res.session, user: res.user, base: "", wsUrl: `${wsBase("")}?${q}` };
}
