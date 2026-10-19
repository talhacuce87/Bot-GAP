// Tek giriş soyutlaması: klavye + fare (masaüstü), sanal joystick + kaydırma (dokunmatik).
// Oyun mantığı yalnızca moveX/moveY ve consume*() değerlerini okur.

const JOY_RADIUS = 50;

export class Input {
  /** -1..1, sağ pozitif */
  moveX = 0;
  /** -1..1, ileri pozitif */
  moveY = 0;
  /** Shift basılı ya da joystick sonuna kadar itilmiş. */
  run = false;
  readonly touch: boolean;

  private keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private zoom = 0;
  private action = false;

  private joyId = -1;
  private joyOx = 0;
  private joyOy = 0;
  private joyX = 0;
  private joyY = 0;
  private lookId = -1;
  private lastX = 0;
  private lastY = 0;
  private mouseDown = false;
  private pinch = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;

  private joyBase: HTMLDivElement;
  private joyKnob: HTMLDivElement;

  constructor(private el: HTMLElement, hud: HTMLElement) {
    this.touch = matchMedia("(pointer: coarse)").matches;
    this.joyBase = document.createElement("div");
    this.joyBase.className = "joy-base";
    this.joyKnob = document.createElement("div");
    this.joyKnob.className = "joy-knob";
    hud.append(this.joyBase, this.joyKnob);

    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLocaleLowerCase("en");
      if (k === "e" || k === " ") this.action = true;
      this.keys.add(k);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLocaleLowerCase("en")));
    window.addEventListener("blur", () => this.reset());
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoom += Math.sign(e.deltaY);
    }, { passive: false });

    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e));
    el.addEventListener("pointercancel", (e) => this.onUp(e));
  }

  private reset(): void {
    this.keys.clear();
    this.joyId = this.lookId = -1;
    this.joyX = this.joyY = 0;
    this.mouseDown = false;
    this.pinch.clear();
    this.showJoy(false);
  }

  private onDown(e: PointerEvent): void {
    this.el.setPointerCapture(e.pointerId);
    if (e.pointerType === "mouse") {
      this.mouseDown = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }
    this.pinch.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.clientX < window.innerWidth * 0.45 && this.joyId < 0) {
      this.joyId = e.pointerId;
      this.joyOx = e.clientX;
      this.joyOy = e.clientY;
      this.joyX = this.joyY = 0;
      this.showJoy(true);
      this.placeJoy();
    } else if (this.lookId < 0) {
      this.lookId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === "mouse") {
      if (!this.mouseDown) return;
      this.lookX += e.clientX - this.lastX;
      this.lookY += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }
    const p = this.pinch.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    if (e.pointerId === this.joyId) {
      let dx = e.clientX - this.joyOx;
      let dy = e.clientY - this.joyOy;
      const d = Math.hypot(dx, dy);
      if (d > JOY_RADIUS) {
        dx *= JOY_RADIUS / d;
        dy *= JOY_RADIUS / d;
      }
      this.joyX = dx / JOY_RADIUS;
      this.joyY = -dy / JOY_RADIUS;
      this.placeJoy();
    } else if (e.pointerId === this.lookId) {
      // İki parmak kamerada ise: yakınlaştırma.
      if (this.pinch.size === 2 && this.joyId < 0) {
        const [a, b] = [...this.pinch.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0) this.zoom += (this.pinchDist - dist) / 40;
        this.pinchDist = dist;
        return;
      }
      this.lookX += (e.clientX - this.lastX) * 1.4;
      this.lookY += (e.clientY - this.lastY) * 1.4;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerType === "mouse") {
      this.mouseDown = false;
      return;
    }
    this.pinch.delete(e.pointerId);
    this.pinchDist = 0;
    if (e.pointerId === this.joyId) {
      this.joyId = -1;
      this.joyX = this.joyY = 0;
      this.showJoy(false);
    } else if (e.pointerId === this.lookId) {
      this.lookId = -1;
    }
  }

  private showJoy(on: boolean): void {
    const d = on ? "block" : "none";
    this.joyBase.style.display = d;
    this.joyKnob.style.display = d;
  }

  private placeJoy(): void {
    this.joyBase.style.transform = `translate3d(${this.joyOx}px, ${this.joyOy}px, 0)`;
    const kx = this.joyOx + this.joyX * JOY_RADIUS;
    const ky = this.joyOy - this.joyY * JOY_RADIUS;
    this.joyKnob.style.transform = `translate3d(${kx}px, ${ky}px, 0)`;
  }

  /** Kare başında çağrılır: klavye ve joystick'i tek vektöre indirger. */
  poll(): void {
    const k = this.keys;
    let x = (k.has("d") || k.has("arrowright") ? 1 : 0) - (k.has("a") || k.has("arrowleft") ? 1 : 0);
    let y = (k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0);
    if (this.joyId >= 0) {
      x = this.joyX;
      y = this.joyY;
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    this.moveX = x;
    this.moveY = y;
    this.run = this.joyId >= 0 ? len > 0.92 : k.has("shift");
  }

  /** Bu kare biriken kamera bakış hareketi (piksel). */
  consumeLook(out: { x: number; y: number }): void {
    out.x = this.lookX;
    out.y = this.lookY;
    this.lookX = this.lookY = 0;
  }

  consumeZoom(): number {
    const z = this.zoom;
    this.zoom = 0;
    return z;
  }

  /** Otur/kalk tuşu (E veya boşluk) ya da dokunmatik düğme. */
  consumeAction(): boolean {
    const a = this.action;
    this.action = false;
    return a;
  }

  triggerAction(): void {
    this.action = true;
  }
}
