// İnşa modu (N): altta blok paleti; imlecin gösterdiği yerde hayalet blok. Sol tık koyar (silgide siler),
// 1–6 blok seçer, R döndürür, X silgi, Esc çıkar. Yalnızca kendi arsanda; arsan yoksa boş arsa alınır
// (boş bir arsanın üstündeysen o). Arsası olan, üstünde durduğu boş arsaya evini taşıyabilir.
// İnşa modu kapalıyken de bir arsanın üstündeysen üstte kimin arsası olduğu yazar.
import { listen } from "../mode";
import * as THREE from "three";
import { blockDef, cellKey, inPlot, PLOTS } from "../../../shared/build";
import { type BuildHit, type BuildWorld, PALETTE } from "../world/buildWorld";
import { type IconName, icon } from "./icons";
import { region } from "./layout";
import { button, el } from "./panel";

export interface BuildHost {
  /** Kendi kimliğin (arsanın sahibi). */
  userId(): string;
  /** Oyuncunun ayaklarının (x, z) konumu: üstünde durduğu boş arsa alınır. */
  position(): { x: number; z: number };
  send(ev: { t: "bclaim"; plot?: number } | { t: "bfree" } | { t: "bset"; i: number; j: number; k: number; b: number; r: number }): void;
  toast(text: string): void;
}

export class BuildMode {
  active = false;
  private bar: HTMLDivElement;
  private info: HTMLDivElement;
  private slots: HTMLButtonElement[] = [];
  private eraseBtn: HTMLButtonElement;
  private selected = 1;
  private rot = 0;
  private erase = false;
  private ghost: THREE.Mesh;
  private ghostMat: THREE.MeshBasicMaterial;
  private mouse = new THREE.Vector2(0, 0);
  private hasMouse = false;
  private ray = new THREE.Raycaster();
  private target: { i: number; j: number; k: number; erase: boolean } | null = null;
  private down = { x: 0, y: 0, at: 0 };
  private badge: HTMLDivElement;

  constructor(
    root: HTMLElement,
    private world: BuildWorld,
    scene: THREE.Scene,
    canvas: HTMLCanvasElement,
    private camera: THREE.Camera,
    private host: BuildHost,
  ) {
    this.badge = el("div", "plot-badge", region(root, "tc"));
    this.bar = el("div", "build-bar", region(root, "bc"));
    this.info = el("div", "build-info", this.bar);
    const row = el("div", "build-row", this.bar);
    PALETTE.forEach((p, idx) => {
      const b = button(row, "", () => this.pick(p.id), "build-slot");
      b.title = `${p.name}${idx < 6 ? ` (${idx + 1})` : ""}`;
      b.style.setProperty("--c", p.color);
      el("span", "build-emoji", b, p.emoji);
      if (idx < 6) el("span", "build-key", b, String(idx + 1));
      this.slots.push(b);
    });
    const tools = el("div", "build-row build-tools", this.bar);
    const tool = (name: IconName, label: string, key: string, fn: () => void) => {
      const b = button(tools, "", fn);
      icon(name, "", b);
      el("span", "", b, label);
      if (key) el("kbd", "", b, key);
      return b;
    };
    this.eraseBtn = tool("trash", "Silgi", "X", () => this.setErase(!this.erase));
    tool("reset", "Döndür", "R", () => this.rotate());
    tool("house", "Arsayı boşalt", "", () => {
      if (this.world.plotOf(this.host.userId()) < 0) return;
      if (confirm("Arsandaki bütün bloklar silinecek ve arsa başkasına açılacak. Emin misin?")) this.host.send({ t: "bfree" });
    });
    tool("signOut", "Çık", "Esc", () => this.toggle(false));

    this.ghostMat = new THREE.MeshBasicMaterial({ color: "#7dff9a", transparent: true, opacity: 0.35, depthWrite: false });
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1.02, 1.02, 1.02).translate(0, 0.51, 0), this.ghostMat);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.ghost.geometry), new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.8 }));
    this.ghost.add(edges);
    this.ghost.visible = false;
    this.ghost.renderOrder = 9;
    scene.add(this.ghost);

    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.hasMouse = true;
    });
    canvas.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY, at: performance.now() }));
    canvas.addEventListener("pointerup", (e) => {
      if (!this.active || e.button !== 0) return;
      // Sürükleme (kamera çevirme) değil, tık
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6 || performance.now() - this.down.at > 500) return;
      this.apply();
    });
    listen("keydown", (e) => {
      if (!this.active || e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "KeyR") this.rotate();
      else if (e.code === "KeyX") this.setErase(!this.erase);
      else if (e.code === "Escape") this.toggle(false);
    });
    this.render();
  }

  toggle(on = !this.active): void {
    this.active = on;
    this.bar.classList.toggle("show", on);
    this.ghost.visible = false;
    if (on) this.render();
  }

  /** 1–6: paletin ilk altı bloğu. */
  pickSlot(n: number): void {
    const p = PALETTE[n];
    if (p) this.pick(p.id);
  }

  private pick(id: number): void {
    this.selected = id;
    this.setErase(false);
  }

  private rotate(): void {
    this.rot = (this.rot + 1) % 4;
    this.render();
  }

  private setErase(on: boolean): void {
    this.erase = on;
    this.render();
  }

  private render(): void {
    this.slots.forEach((b, i) => b.classList.toggle("active", !this.erase && PALETTE[i].id === this.selected));
    this.eraseBtn.classList.toggle("active", this.erase);
    const mine = this.world.plotOf(this.host.userId());
    this.info.replaceChildren();
    if (mine < 0) {
      el("span", "", this.info, "🏘️ Henüz arsan yok. Mahalle köyün batısında, dağın ardında: otobanı batıya takip et.");
      button(this.info, "🏠 Boş arsa al", () => this.claim(), "primary");
      return;
    }
    button(this.info, "🚚 Arsanı taşı", () => this.move(mine));
    const def = blockDef(this.selected);
    el("span", "", this.info, this.erase ? "🧽 Silgi: tıkladığın blok silinir" : `${def?.emoji ?? ""} ${def?.name ?? ""} · yön ${this.rot * 90}° · sol tık: koy`);
  }

  /** Kare başına: üstünde durulan arsanın rozeti; inşa modunda imlecin altındaki hücre ve hayalet blok. */
  update(): void {
    this.updateBadge();
    if (!this.active) return;
    const mine = this.world.plotOf(this.host.userId());
    if (mine >= 0 && this.info.dataset.plot !== String(mine)) {
      this.info.dataset.plot = String(mine);
      this.render();
    } else if (mine < 0 && this.info.dataset.plot !== "-1") {
      this.info.dataset.plot = "-1";
      this.render();
    }
    this.target = null;
    this.ghost.visible = false;
    // Fare kilitliyken (shift lock) ekranın ortası nişan
    const locked = !!document.pointerLockElement;
    if (mine < 0 || (!this.hasMouse && !locked)) return;
    this.ray.setFromCamera(locked ? new THREE.Vector2(0, 0) : this.mouse, this.camera);
    const hit = this.world.raycast(this.ray, mine);
    if (!hit) return;
    const t = this.erase ? this.eraseCell(hit) : this.placeCell(hit, mine);
    if (!t) return;
    this.target = t;
    const p = PLOTS[mine];
    this.ghost.position.set(p.x0 + t.i + 0.5, t.j, p.z0 + t.k + 0.5);
    this.ghost.rotation.y = (this.rot * Math.PI) / 2;
    this.ghostMat.color.set(this.erase ? "#ff5a5a" : blockDef(this.selected)?.color ?? "#7dff9a");
    this.ghost.visible = true;
  }

  private eraseCell(hit: BuildHit): { i: number; j: number; k: number; erase: boolean } | null {
    return hit.j >= 0 ? { i: hit.i, j: hit.j, k: hit.k, erase: true } : null;
  }

  private placeCell(hit: BuildHit, plot: number): { i: number; j: number; k: number; erase: boolean } | null {
    const i = hit.i + hit.nx, j = hit.j + hit.ny, k = hit.k + hit.nz;
    if (!inPlot(plot, i, j, k)) return null;
    // Arsanın dışına taşma ya da dolu hücre
    if (this.world.plots[plot].blocks.has(cellKey(i, j, k))) return null;
    return { i, j, k, erase: false };
  }

  /** Oyuncunun üstünde durduğu arsa (yoksa -1). */
  private standing(): number {
    const { x, z } = this.host.position();
    return PLOTS.findIndex((p) => x >= p.x0 && x < p.x0 + p.size && z >= p.z0 && z < p.z0 + p.size);
  }

  /** Boş arsa iste: üstünde durduğun boş arsa varsa o. */
  private claim(): void {
    const plot = this.standing();
    this.host.send(plot >= 0 && !this.world.plots[plot].owner ? { t: "bclaim", plot } : { t: "bclaim" });
  }

  /** Taşın: üstünde durulan boş arsaya. */
  private move(mine: number): void {
    const at = this.standing();
    if (at < 0 || at === mine || this.world.plots[at].owner) return this.host.toast("🚚 Taşınmak istediğin boş arsanın üstüne git, sonra tekrar bas.");
    if (confirm(`Evin bloklarıyla birlikte ${plotLabel(at)} numaralı arsaya taşınacak, şimdiki arsan boşalır. Taşınalım mı?`)) {
      this.host.send({ t: "bclaim", plot: at });
    }
  }

  private updateBadge(): void {
    const at = this.standing();
    let text = "";
    if (at >= 0) {
      const p = this.world.plots[at];
      const mine = p.owner === this.host.userId();
      text = p.owner ? `🏠 ${mine ? "Senin arsan" : `Sahibi: ${p.name}`} · ${plotLabel(at)}` : `🔨 Boş arsa · ${plotLabel(at)} · N ile al`;
    }
    if (this.badge.textContent === text) return;
    this.badge.textContent = text;
    this.badge.classList.toggle("show", !!text);
  }

  private apply(): void {
    const t = this.target;
    if (!t) return;
    const plot = this.world.plotOf(this.host.userId());
    if (plot < 0) return;
    const b = t.erase ? 0 : this.selected;
    // İyimser: hemen çiz; sunucu aynısını herkese yayar
    this.world.set(plot, t.i, t.j, t.k, b, this.rot);
    this.host.send({ t: "bset", i: t.i, j: t.j, k: t.k, b, r: this.rot });
  }
}

/** Arsanın okunur adı: "Arsa 3" (1'den). */
export function plotLabel(id: number): string {
  return PLOTS[id] ? `Arsa ${id + 1}` : "";
}
