import { defineConfig } from "vite";

const server = "http://localhost:3000";

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
    port: 5173,
    host: true,
    // Discord geliştirme tüneli (cloudflared) farklı bir host adıyla gelir.
    allowedHosts: true,
    proxy: {
      "/api": server,
      "/avatar": server,
      "/health": server,
      "/ws": { target: server, ws: true },
    },
  },
});
