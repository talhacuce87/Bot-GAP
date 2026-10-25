// 🚗 Araçlarım (GTA'daki kişisel araçlar gibi): Tofaşlar, Linea, Doblo, Passat ve E30 herkeste var. Karta tıkla (ya da 1-7)
// → o araba kendi tuning'iyle yanına gelir (park halinde); F ile binersin. Park edilen araba görünür, kaldırılabilir.
import * as THREE from "three";
import { CAR_COLORS, CAR_MODELS, type CarSpec } from "../../../shared/car";
import { buildTofas } from "../world/tofas";

export interface CarMenuHooks {
  /** Bu model yanına gelsin. */
  call(model: CarSpec["model"]): void;
  /** Park halindeki arabayı kaldır. */
  dismiss(): void;
  /** Her modelin güncel tuning'i ve park halindeki araba (model, uzaklık). */
  state(): { cars: Record<CarSpec["model"], CarSpec>; parked: { model: CarSpec["model"]; dist: number } | null; driving: CarSpec["model"] | null };
  /** Açılıp kapanınca (dünya girişi durur). */
  modal(open: boolean): void;
}

const TAGLINE: Record<CarSpec["model"], string> = {
  sahin: "Efsane sedan · ikiz far, kromlu ızgara",
  dogan: "Doğan SLX · tek parça far, sis farları",
  kartal: "Station · geniş bagaj, dikey stoplar",
  linea: "Yakmaz abi, 100'de 4 · kaldırmaz da",
  doblo: "Esnafın gözdesi · koltuk sökülür, kasa olur",
  passat: "Sakal Passat · chip'le uçak olur",
  e30: "Arkadan itiş · el freniyle drift kralı",
  motor: "GAP Kurye · arkada teslimat kutusu",
  taksi: "Sarı Doblo · tepede TAKSİ tabelası",
};

/** Kart görselleri: tek bir gizli WebGL sahnesinde çizilir, resme dönüştürülür (menü açıkken). */
class Thumbs {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 50);
  private cache = new Map<string, string>();

  render(spec: CarSpec): string {
    const key = JSON.stringify(spec);
    const hit = this.cache.get(key);
    if (hit) return hit;
    try {
      if (!this.renderer) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.setPixelRatio(1);
        this.renderer.setSize(480, 270, false);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.scene.add(new THREE.HemisphereLight("#ffffff", "#4a5260", 2.3));
        const sun = new THREE.DirectionalLight("#fff4e0", 2.6);
        sun.position.set(4, 7, 5);
        this.scene.add(sun);
        this.camera.position.set(5.4, 2.0, 5.0);
        this.camera.lookAt(0, 0.55, 0);
      }
      const car = buildTofas(spec);
      car.setNight(0.5);
      car.group.rotation.y = -0.25;
      this.scene.add(car.group);
      this.renderer.render(this.scene, this.camera);
      const url = this.renderer.domElement.toDataURL("image/png");
      this.scene.remove(car.group);
      car.dispose();
      this.cache.set(key, url);
      return url;
    } catch {
      return "";
    }
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }
}

export class CarMenu {
  private root: HTMLDivElement;
  private cards: HTMLDivElement;
  private foot: HTMLDivElement;
  private thumbs = new Thumbs();
  isOpen = false;

  constructor(parent: HTMLElement, private hooks: CarMenuHooks) {
    this.root = document.createElement("div");
    this.root.className = "carmenu";
    const panel = document.createElement("div");
    panel.className = "cm-panel";
    panel.innerHTML = '<div class="cm-head"><b>ARAÇLARIM</b><span>Bir araca tıkla: yanına gelsin · F ile bin</span><button class="cm-x" title="Kapat (Esc)">✕</button></div>';
    this.cards = document.createElement("div");
    this.cards.className = "cm-cards";
    this.foot = document.createElement("div");
    this.foot.className = "cm-foot";
    panel.append(this.cards, this.foot);
    this.root.append(panel);
    parent.append(this.root);
    panel.querySelector(".cm-x")!.addEventListener("click", () => this.close());
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
    addEventListener("keydown", (e) => {
      if (!this.isOpen || e.target instanceof HTMLInputElement) return;
      const i = CAR_MODELS.findIndex((_, k) => e.code === `Digit${k + 1}`);
      if (e.code === "Escape") this.close();
      else if (i >= 0) this.pick(CAR_MODELS[i].id);
      else return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.isOpen = true;
    this.root.classList.add("show");
    this.hooks.modal(true);
    this.render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove("show");
    this.hooks.modal(false);
    this.thumbs.dispose();
  }

  private pick(model: CarSpec["model"]): void {
    this.hooks.call(model);
    this.close();
  }

  private render(): void {
    const st = this.hooks.state();
    this.cards.replaceChildren(
      ...CAR_MODELS.map((m, i) => {
        const spec = st.cars[m.id];
        const card = document.createElement("button");
        card.className = `cm-card${st.parked?.model === m.id ? " parked" : ""}${st.driving === m.id ? " driving" : ""}`;
        const color = CAR_COLORS.find((c) => c.id === spec.color);
        const img = this.thumbs.render(spec);
        const status = st.driving === m.id ? "🟢 Şu an sürüyorsun" : st.parked?.model === m.id ? `🅿️ Park halinde · ${Math.round(st.parked.dist)} m` : "Garajda";
        card.innerHTML =
          `<div class="cm-img">${img ? `<img src="${img}" alt="">` : "🚗"}</div>` +
          `<div class="cm-info"><kbd>${i + 1}</kbd><b>${m.name.toUpperCase()}</b><small>${TAGLINE[m.id]}</small>` +
          `<div class="cm-tags"><span><i style="background:${color?.hex}"></i>${color?.name ?? ""}</span><span class="cm-plate">${spec.plate}</span></div>` +
          `<em>${status}</em></div>` +
          `<div class="cm-call">${st.parked?.model === m.id ? "YANIMA GETİR" : "ÇAĞIR"}</div>`;
        card.disabled = st.driving !== null;
        card.addEventListener("click", () => this.pick(m.id));
        return card;
      }),
    );
    this.foot.replaceChildren();
    const note = document.createElement("span");
    note.textContent = st.driving ? "Arabadayken çağıramazsın: önce F ile in." : "Tuning için arabanla GAP Garaj'a gir (berberin arkası) ve parlayan işarete gel.";
    this.foot.append(note);
    if (st.parked && !st.driving) {
      const b = document.createElement("button");
      b.className = "cm-dismiss";
      b.textContent = "🅿️ Park edilen arabayı kaldır";
      b.addEventListener("click", () => {
        this.hooks.dismiss();
        this.close();
      });
      this.foot.append(b);
    }
  }
}
