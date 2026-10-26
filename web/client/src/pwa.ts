// Uygulama olarak kurulum (PWA) ve donanım hızlandırma uyarısı.
// Service worker yalnızca derlenmiş sürümde ve tarayıcıda kaydedilir (Activity'nin vekil alan adında değil);
// ne yaptığı build sırasında üretilen sw.js'te (vite.config.ts).
import type * as THREE from "three";
import { inDiscord } from "./discord";
import { toolMenuItem } from "./ui/layout";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Tarayıcının kurulum isteği: oyun yüklenirken gelir, menüdeki düğme sonra kullanır. */
let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();

if (import.meta.env.PROD && !inDiscord() && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("[pwa]", err));
}

addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as InstallPrompt;
  listeners.forEach((fn) => fn());
});
addEventListener("appinstalled", () => {
  deferred = null;
  listeners.forEach((fn) => fn());
});

/** "Diğer" menüsüne "Uygulama olarak yükle": yalnızca tarayıcı kuruluma izin verirken görünür. Kapatma döner. */
export function installMenuItem(hudRoot: HTMLElement): () => void {
  const item = toolMenuItem(hudRoot, {
    icon: "arrowDown",
    label: "Uygulama olarak yükle",
    order: 90,
    onClick: () => {
      const p = deferred;
      if (!p) return;
      deferred = null;
      sync();
      void p.prompt().catch(() => undefined);
    },
  });
  const sync = () => (item.hidden = !deferred);
  sync();
  listeners.add(sync);
  return () => listeners.delete(sync);
}

/** Yazılımla çizen WebGL: donanım hızlandırma kapalı ya da ekran kartı sürücüsü engellenmiş. */
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|lavapipe|basic render|software/i;

export function softwareRenderer(renderer: THREE.WebGLRenderer): string | null {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
  return SOFTWARE_GL.test(name) ? name : null;
}

let warned = false;

/** Oyun ekran kartı yerine işlemcide çiziliyorsa nasıl açılacağını anlatan, kapatılabilir uyarı. */
export function warnSoftwareRenderer(renderer: THREE.WebGLRenderer, hudRoot: HTMLElement): void {
  const name = softwareRenderer(renderer);
  // Sayfa başına bir kez: savaştan dünyaya dönünce tekrar çıkmasın
  if (!name || warned) return;
  warned = true;
  console.warn("[gpu] yazılımla çizim:", name);
  const firefox = /firefox/i.test(navigator.userAgent);
  const box = document.createElement("div");
  box.className = "gpu-warn";
  box.setAttribute("role", "alert");
  const title = document.createElement("strong");
  title.textContent = "Donanım hızlandırma kapalı";
  const text = document.createElement("p");
  text.textContent = firefox
    ? "Oyun ekran kartı yerine işlemcide çiziliyor, bu yüzden çok kasar. Ayarlar → Genel → Performans'ta \"Kullanılabilir olduğunda donanım hızlandırmasını kullan\"ı aç ve Firefox'u yeniden başlat."
    : "Oyun ekran kartı yerine işlemcide çiziliyor, bu yüzden çok kasar. Tarayıcı ayarlarında Sistem bölümünden \"Mümkün olduğunda grafik hızlandırmayı kullan\"ı aç ve tarayıcıyı yeniden başlat.";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn--ghost";
  close.textContent = "Tamam";
  close.addEventListener("click", () => box.remove());
  box.append(title, text, close);
  hudRoot.append(box);
}
