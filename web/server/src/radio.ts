// Araba radyosu: YouTube ya da Spotify linkini çalınabilir bir YouTube videosuna ve görünen ada çevirir.
// YouTube'da başlık oEmbed'den; Spotify'da şarkı ve sanatçı şarkı sayfasının başlığından okunur, sonra
// YouTube aramasındaki ilk videoyla eşleştirilir (Spotify tam şarkıyı oturum açmadan çaldırmaz).
import { parseRadioUrl } from "../../shared/car";

export type RadioFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
  // AB'de çerez onay sayfası yerine sonuçlar gelsin
  Cookie: "CONSENT=YES+1; SOCS=CAI",
};

const cache = new Map<string, { id: string; title: string }>();

async function get(fetcher: RadioFetch, url: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetcher(url, { headers: HEADERS, signal: ac.signal });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** Spotify şarkı sayfasının başlığı: "Şarkı - song and lyrics by Sanatçı | Spotify" (ya da Türkçe karşılığı). */
export function spotifyTitle(html: string): string | null {
  const t = /<title>([^<]+)<\/title>/i.exec(html)?.[1];
  if (!t) return null;
  const m = /^(.+?) - (?:song(?: and lyrics)? by|şarkı(?: ve şarkı sözleri)?(?: by)?|single by|song by) (.+?) \| Spotify$/i.exec(decode(t));
  if (m) return `${m[2]} - ${m[1]}`;
  const og = /<meta property="og:title" content="([^"]+)"/i.exec(html)?.[1];
  const desc = /<meta property="og:description" content="([^"]+)"/i.exec(html)?.[1];
  if (og && desc) return `${decode(desc).split("·")[0].trim()} - ${decode(og)}`;
  return og ? decode(og) : null;
}

/** Spotify gömme sayfasından sanatçılar ("artists":[{"name":…}]). */
export function spotifyArtists(html: string): string[] {
  const block = /"artists":\[(.*?)\]/.exec(html)?.[1] ?? "";
  return [...block.matchAll(/"name":"([^"]+)"/g)].map((m) => decode(m[1])).slice(0, 3);
}

/** YouTube arama sonuçlarındaki ilk videonun kimliği. */
export function firstVideoId(html: string): string | null {
  return /"videoId":"([\w-]{11})"/.exec(html)?.[1] ?? null;
}

/** Linki çözer; olmazsa kullanıcıya gösterilecek hata. */
export async function resolveRadio(raw: string, fetcher: RadioFetch = fetch as unknown as RadioFetch): Promise<{ id: string; title: string } | { error: string }> {
  const src = parseRadioUrl(raw);
  if (!src) return { error: "📻 YouTube ya da Spotify şarkı linki yapıştır." };
  const key = `${src.kind}:${src.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let out: { id: string; title: string } | null = null;
  if (src.kind === "youtube") {
    const json = await get(fetcher, `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${src.id}`)}&format=json`);
    let title = "YouTube";
    try {
      const o = json ? (JSON.parse(json) as { title?: string; author_name?: string }) : null;
      if (o?.title) title = o.title;
      else if (json === null) return { error: "📻 Bu video bulunamadı ya da gömülemiyor." };
    } catch {
      // başlık okunamadı: yine de çal
    }
    out = { id: src.id, title };
  } else {
    // Şarkı adı oEmbed'den, sanatçılar gömme sayfasından (eski sayfa başlığı yedek)
    const track = `https://open.spotify.com/track/${src.id}`;
    let song: string | null = null;
    try {
      const o = JSON.parse((await get(fetcher, `https://open.spotify.com/oembed?url=${encodeURIComponent(track)}`)) ?? "null") as { title?: string } | null;
      song = o?.title ? decode(o.title) : null;
    } catch {
      song = null;
    }
    const embed = await get(fetcher, `https://open.spotify.com/embed/track/${src.id}`);
    const artists = embed ? spotifyArtists(embed) : [];
    let name = song && artists.length ? `${artists.join(", ")} - ${song}` : song;
    if (!name) {
      const page = await get(fetcher, track);
      name = page ? spotifyTitle(page) : null;
    }
    if (!name) return { error: "📻 Spotify şarkısı okunamadı." };
    const results = await get(fetcher, `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} audio`)}`);
    const id = results ? firstVideoId(results) : null;
    if (!id) return { error: `📻 "${name}" YouTube'da bulunamadı.` };
    out = { id, title: name };
  }
  out.title = out.title.slice(0, 90);
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}

// ---- Çalma listeleri: Spotify çalma listesi/albümü ve YouTube çalma listesi bütün şarkılarıyla sıraya ----

/** Sıradaki şarkı: YouTube kimliği belli ya da çalınca aranacak ad (Spotify). */
export interface RadioItem {
  title: string;
  id?: string;
  /** YouTube'da aranacak (Spotify şarkısı: "Sanatçı - Şarkı"). */
  q?: string;
}

/** Çalma listesi linki mi: Spotify çalma listesi/albümü ya da YouTube listesi (izleme linkindeki liste değil). */
export function parseListUrl(raw: string): { kind: "spotify"; type: "playlist" | "album"; id: string } | { kind: "youtube"; id: string } | null {
  const text = raw.trim();
  const sp = /^spotify:(playlist|album):([A-Za-z0-9]{22})$/.exec(text);
  if (sp) return { kind: "spotify", type: sp[1] as "playlist" | "album", id: sp[2] };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "open.spotify.com") {
    const i = parts.findIndex((p) => p === "playlist" || p === "album");
    const id = i >= 0 ? parts[i + 1] : null;
    return id && /^[A-Za-z0-9]{22}$/.test(id) ? { kind: "spotify", type: parts[i] as "playlist" | "album", id } : null;
  }
  if ((host === "youtube.com" || host === "youtu.be") && parts[0] === "playlist") {
    const list = url.searchParams.get("list");
    return list && /^[\w-]{10,64}$/.test(list) ? { kind: "youtube", id: list } : null;
  }
  return null;
}

/** JSON ağacında anahtar adıyla dizileri bul (sayfa yapısı değişse de iş görsün). */
function findArrays(o: unknown, key: string, out: unknown[][] = [], depth = 0): unknown[][] {
  if (!o || typeof o !== "object" || depth > 40) return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (k === key && Array.isArray(v)) out.push(v);
    else findArrays(v, key, out, depth + 1);
  }
  return out;
}
function findObjects(o: unknown, key: string, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (!o || typeof o !== "object" || depth > 60) return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (k === key && v && typeof v === "object") out.push(v as Record<string, unknown>);
    else findObjects(v, key, out, depth + 1);
  }
  return out;
}

/** Spotify gömme sayfasının şarkı listesi (başlık + sanatçılar). */
export function spotifyTracks(html: string): RadioItem[] {
  const json = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  let list: unknown[] = [];
  if (json) {
    try {
      list = findArrays(JSON.parse(json), "trackList")[0] ?? [];
    } catch {
      list = [];
    }
  }
  const out: RadioItem[] = [];
  for (const t of list) {
    const o = t as { title?: string; subtitle?: string };
    if (!o?.title) continue;
    const artist = (o.subtitle ?? "").split(",").slice(0, 2).join(",").trim();
    const title = artist ? `${artist} - ${o.title}` : o.title;
    out.push({ title: title.slice(0, 90), q: `${title} audio` });
  }
  return out;
}

/** YouTube çalma listesi sayfasındaki videolar. */
export function youtubeListItems(html: string): RadioItem[] {
  const raw = /var ytInitialData = (\{[\s\S]*?\});<\/script>/.exec(html)?.[1];
  if (!raw) return [];
  try {
    return findObjects(JSON.parse(raw), "playlistVideoRenderer")
      .map((r) => ({ id: r.videoId as string, title: ((r.title as { runs?: { text: string }[] })?.runs?.[0]?.text ?? "YouTube").slice(0, 90) }))
      .filter((x) => typeof x.id === "string" && /^[\w-]{11}$/.test(x.id));
  } catch {
    return [];
  }
}

/** Link: tek şarkı ya da çalma listesinin bütün şarkıları (sıraya eklenecek). */
export async function resolveRadioList(raw: string, fetcher: RadioFetch = fetch as unknown as RadioFetch): Promise<RadioItem[] | { error: string }> {
  const list = parseListUrl(raw);
  if (!list) {
    const one = await resolveRadio(raw, fetcher);
    return "error" in one ? one : [one];
  }
  if (list.kind === "spotify") {
    const html = await get(fetcher, `https://open.spotify.com/embed/${list.type}/${list.id}`);
    const items = html ? spotifyTracks(html) : [];
    return items.length ? items : { error: "📻 Spotify listesi okunamadı (gizli olabilir)." };
  }
  const html = await get(fetcher, `https://www.youtube.com/playlist?list=${list.id}`);
  const items = html ? youtubeListItems(html) : [];
  return items.length ? items : { error: "📻 YouTube listesi okunamadı (gizli olabilir)." };
}

/** Aranacak şarkının YouTube kimliği (sırada çalma anı gelince). */
export async function searchVideo(q: string, fetcher: RadioFetch = fetch as unknown as RadioFetch): Promise<string | null> {
  const hit = cache.get(`q:${q}`);
  if (hit) return hit.id;
  const results = await get(fetcher, `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`);
  const id = results ? firstVideoId(results) : null;
  if (id) cache.set(`q:${q}`, { id, title: q });
  return id;
}
