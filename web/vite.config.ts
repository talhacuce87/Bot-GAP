import { defineConfig, type Plugin } from "vite";

// Ayrı bir kopyada (worktree) çalışırken farklı porttaki sunucuya bağlanmak için: WORLD_DEV_SERVER
const server = process.env.WORLD_DEV_SERVER || "http://localhost:3000";

/**
 * Service worker (PWA): adında içerik özeti olan /assets/ dosyaları önce önbellekten gelir, sayfa ve
 * API hep ağdan (deploy sonrası sürüm denetimi net.ts'te aynen çalışır). Bu derlemenin dosya listesi
 * sw.js'e yazılır: liste değişince tarayıcı yeni worker'ı kurar, o da önbellekte artık olmayanları siler.
 */
function serviceWorker(): Plugin {
  return {
    name: "gap-sw",
    apply: "build",
    generateBundle(_, bundle) {
      const assets = Object.keys(bundle).filter((f) => f.startsWith("assets/")).map((f) => `/${f}`).sort();
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const CACHE = "gap-assets";
const ASSETS = new Set(${JSON.stringify(assets)});
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) if (!ASSETS.has(new URL(req.url).pathname)) await cache.delete(req);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/assets/")) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.status === 200) e.waitUntil(cache.put(e.request, res.clone()));
    return res;
  })());
});
`,
      });
    },
  };
}

export default defineConfig({
  root: "client",
  // manifest ve ikonlar (client/public) olduğu gibi kopyalanır
  publicDir: "public",
  plugins: [serviceWorker()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    target: "es2020",
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: Number(process.env.WORLD_DEV_PORT || 5173),
    host: true,
    // Discord geliştirme tüneli (cloudflared) farklı bir host adıyla gelir.
    allowedHosts: true,
    proxy: {
      "/api": server,
      "/auth": server,
      "/avatar": server,
      "/thumb": server,
      "/health": server,
      "/ws": { target: server, ws: true },
    },
  },
});
