// Sunucuyu tek dosyaya paketler; ws runtime bağımlılığı olarak dışarıda kalır.
import { build } from "esbuild";

await build({
  entryPoints: ["server/src/index.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});
