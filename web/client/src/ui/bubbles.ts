// Konuşma baloncukları: sohbete yazılan mesaj, yazanın kafasının üstünde birkaç saniye görünür.
// DOM'da (emoji ve Türkçe karakterler net çizilir); her kare avatarın ekran konumuna taşınır.
// Metin her zaman textContent ile yazılır (HTML yorumlanmaz).
import * as THREE from "three";

/** Baloncuğun ekranda kaldığı süre: kısa mesaj en az 4 sn, uzunlar okunacak kadar. */
const minMs = (text: string) => Math.min(9000, 4000 + text.length * 60);
const FADE_MS = 400;
/** Bu mesafeden uzaktaki baloncuk gizlenir. */
const MAX_DIST = 32;
/** Kafanın üstü (isim etiketinin üstünde). */
const HEAD_Y = 2.25;

interface Bubble {
  el: HTMLDivElement;
  text: HTMLSpanElement;
  until: number;
}

export interface BubbleAnchor {
  x: number;
  z: number;
  /** Zemin üstü ek yükseklik (zıplama, oturma). */
  y: number;
}

export class Bubbles {
  private root: HTMLDivElement;
  private items = new Map<number, Bubble>();
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "bubbles";
    parent.prepend(this.root); // HUD düğmelerinin altında kalsın
  }

  /** Aynı kişinin yeni mesajı eskisinin yerini alır. */
  say(sid: number, text: string, now: number): void {
    let b = this.items.get(sid);
    if (!b) {
      const el = document.createElement("div");
      el.className = "bubble";
      const span = document.createElement("span");
      span.className = "bubble-text";
      el.append(span);
      this.root.append(el);
      b = { el, text: span, until: 0 };
      this.items.set(sid, b);
    }
    b.text.textContent = text;
    b.el.classList.remove("fading");
    b.el.classList.toggle("long", text.length > 60);
    b.until = now + minMs(text);
  }

  clear(sid: number): void {
    this.items.get(sid)?.el.remove();
    this.items.delete(sid);
  }

  /** Kare başına: `anchor` sid'in dünya konumu (yoksa baloncuk kaldırılır). */
  update(now: number, camera: THREE.PerspectiveCamera, anchor: (sid: number) => BubbleAnchor | null): void {
    if (!this.items.size) return;
    const w = innerWidth / 2, h = innerHeight / 2;
    for (const [sid, b] of this.items) {
      const a = now < b.until + FADE_MS ? anchor(sid) : null;
      if (!a) {
        this.clear(sid);
        continue;
      }
      if (now > b.until) b.el.classList.add("fading");
      this.v.set(a.x, HEAD_Y + a.y, a.z);
      const dist = this.v.distanceTo(camera.position);
      this.v.project(camera);
      if (this.v.z > 1 || dist > MAX_DIST || Math.abs(this.v.x) > 1.2 || Math.abs(this.v.y) > 1.2) {
        b.el.style.display = "none";
        continue;
      }
      // Uzaklaştıkça küçülür; yakındaki öndekini örter.
      const s = THREE.MathUtils.clamp(9 / dist, 0.55, 1.1);
      b.el.style.display = "";
      b.el.style.zIndex = String(1000 - Math.round(dist * 10));
      b.el.style.transform = `translate(${(this.v.x * w + w).toFixed(1)}px, ${(-this.v.y * h + h).toFixed(1)}px) translate(-50%, -100%) scale(${s.toFixed(3)})`;
    }
  }
}
