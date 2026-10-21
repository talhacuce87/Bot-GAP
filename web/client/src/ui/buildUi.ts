// İnşa modu (N): altta blok paleti; imlecin gösterdiği yerde hayalet blok. Sol tık koyar (silgide siler),
// 1–6 blok seçer, R döndürür, X silgi, Esc çıkar. Yalnızca kendi arsanda; arsan yoksa boş arsa alınır.
import * as THREE from "three";
import { blockDef, cellKey, inPlot, PLOTS } from "../../../shared/build";
import { type BuildHit, type BuildWorld, PALETTE } from "../world/buildWorld";
import { button, el } from "./panel";

export interface BuildHost {
  /** Kendi kimliğin (arsanın sahibi). */
  userId(): string;
  send(ev: { t: "bclaim" } | { t: "bfree" } | { t: "bset"; i: number; j: number; k: number; b: number; r: number }): void;
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

  constructor(
    root: HTMLElement,
    private world: BuildWorld,
    scene: THREE.Scene,
    canvas: HTMLCanvasElement,
    private camera: THREE.Camera,
    private host: BuildHost,
  ) {
    this.bar = el("div", "panel build-bar", root);
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
    this.eraseBtn = button(tools, "🧽 Silgi (X)", () => this.setErase(!this.erase));
    button(tools, "🔄 Döndür (R)", () => this.rotate());
    button(tools, "🏚️ Arsayı boşalt", () => {
      if (this.world.plotOf(this.host.userId()) < 0) return;
      if (confirm("Arsandaki bütün bloklar silinecek ve arsa başkasına açılacak. Emin misin?")) this.host.send({ t: "bfree" });
    });
    button(tools, "✕ Çık (Esc)", () => this.toggle(false));

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
    addEventListener("keydown", (e) => {
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
      el("span", "", this.info, "🏘️ Henüz arsan yok. Mahalle zindanın kuzeyinde (yön tabelasında ↙ MAHALLE).");
      button(this.info, "🏠 Boş arsa al", () => this.host.send({ t: "bclaim" }), "primary");
      return;
    }
    const def = blockDef(this.selected);
    el("span", "", this.info, this.erase ? "🧽 Silgi: tıkladığın blok silinir" : `${def?.emoji ?? ""} ${def?.name ?? ""} · yön ${this.rot * 90}° · sol tık: koy`);
  }

  /** Kare başına: imlecin altındaki hücre ve hayalet blok. */
  update(): void {
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
    const hit = this.world.raycast(this.ray);
    if (!hit || hit.plot !== mine) return;
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
    if (!inPlot(i, j, k)) return null;
    // Arsanın dışına taşma ya da dolu hücre
    if (this.world.plots[plot].blocks.has(cellKey(i, j, k))) return null;
    return { i, j, k, erase: false };
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
