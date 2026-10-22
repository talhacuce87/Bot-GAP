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
