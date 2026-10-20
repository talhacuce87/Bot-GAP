import { defineConfig } from "vite";

// Ayrı bir kopyada (worktree) çalışırken farklı porttaki sunucuya bağlanmak için: WORLD_DEV_SERVER
const server = process.env.WORLD_DEV_SERVER || "http://localhost:3000";

export default defineConfig({
  root: "client",
  publicDir: false,
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
