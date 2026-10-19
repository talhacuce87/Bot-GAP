// Faz 0 spike'ı: YouTube iframe'i Activity'nin CSP/proxy kısıtlarıyla oynuyor mu?
// Developer Portal → URL Mappings'te `/youtube` → `www.youtube.com` ve `/ytimg` → `i.ytimg.com` gerekir.
import type { Session } from "../discord";

const TEST_VIDEO = "jNQXAC9IVRw";
let patched = false;

export async function openYoutubeTest(root: HTMLElement, session: Session): Promise<void> {
  if (root.querySelector(".yt-overlay")) return;
  if (session.mode === "discord" && !patched) {
    const { patchUrlMappings } = await import("@discord/embedded-app-sdk");
    patchUrlMappings(
      [
        { prefix: "/youtube", target: "www.youtube.com" },
        { prefix: "/ytimg", target: "i.ytimg.com" },
      ],
      { patchSrcAttributes: true },
    );
    patched = true;
  }
  const box = document.createElement("div");
  box.className = "yt-overlay";
  const bar = document.createElement("div");
  bar.className = "panel";
  bar.textContent = "Video oynuyorsa watch party bu yolla çalışır. ";
  const close = document.createElement("button");
  close.textContent = "Kapat";
  close.addEventListener("click", () => box.remove());
  bar.append(close);
  const frame = document.createElement("iframe");
  frame.allow = "autoplay; encrypted-media; picture-in-picture";
  frame.src = `https://www.youtube.com/embed/${TEST_VIDEO}?autoplay=1&mute=1&playsinline=1`;
  box.append(bar, frame);
  root.append(box);
}
