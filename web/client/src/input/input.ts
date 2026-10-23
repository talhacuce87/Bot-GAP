// Tek giriş soyutlaması: klavye + fare (masaüstü), sanal joystick + kaydırma (dokunmatik).
// Oyun mantığı yalnızca moveX/moveY ve consume*() değerlerini okur. Tuşlar keybinds.ts'ten (ayarlanabilir).
import { type Action, actionsOf, binds, HOTKEYS, reserved } from "./keybinds";

const JOY_RADIUS = 50;
/** Dokunuştan sonra tarayıcının ürettiği sahte fare olayları bu süre yok sayılır. */
const TOUCH_MOUSE_MS = 800;
/** Kilit açılırken bazı tarayıcıların verdiği tek seferlik dev sıçrama. */
const MAX_LOCK_STEP = 300;

export class Input {
  /** -1..1, sağ pozitif */
  moveX = 0;
  /** -1..1, ileri pozitif */
  moveY = 0;
  /** Koşma tuşu basılı ya da joystick sonuna kadar itilmiş. */
  run = false;
  /** Shift lock: imleç gizli, kamera fareyi izler, karakter kameranın baktığı yöne döner. */
  shiftLock = false;
  readonly touch: boolean;
  /** Gardırop tuşu. */
  onWardrobe: (() => void) | null = null;
  /** Ekranı kaplayan pencere (gardırop) açık: dünya tuşları yok sayılır, yalnızca gardırop tuşu çalışır. */
  private blocked = false;

  /** Basılı tuşlar (keybinds adlarıyla: KeyW, Mouse1 …). */
  private held = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private zoom = 0;
  private action = false;
  private jump = false;
  private act: "f" | "g" | null = null;
  private emote = -1;
  /** Tek seferlik dünya kısayolları (keybinds HOTKEYS): menü, fotoğraf, araç, beşlik… */
  private hot = new Set<Action>();

  private joyId = -1;
  private joyOx = 0;
  private joyOy = 0;
  private joyX = 0;
  private joyY = 0;
  private lookId = -1;
  private lastX = 0;
  private lastY = 0;
  private mouseDown = false;
  private lastTouch = -Infinity;
  private pinch = new Map<number, { x: number; y: number }>();
  /** Tankta: fare kilitlenmek isteniyor (kilit Esc ile bırakılırsa tıklayınca yeniden). */
  private wantLock = false;
  /** Sağ tık basılıyken: imleç tıklanan yerde kalır, fare kamerayı çevirir. */
  private dragLock = false;
  private pinchDist = 0;
  private abort = new AbortController();

  private joyBase: HTMLDivElement;
  private joyKnob: HTMLDivElement;

  constructor(private el: HTMLElement, hud: HTMLElement) {
    this.touch = matchMedia("(pointer: coarse)").matches;
    this.joyBase = document.createElement("div");
    this.joyBase.className = "joy-base";
    this.joyKnob = document.createElement("div");
    this.joyKnob.className = "joy-knob";
    hud.append(this.joyBase, this.joyKnob);

    const signal = this.abort.signal;
    addEventListener("keydown", (e) => {
      // Alt (alt-tab'ın yarısı): Firefox bırakılınca menü çubuğunu odaklar, sonraki tuşlar oyuna gelmez
      if (e.key === "Alt") e.preventDefault();
      if (e.repeat) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (this.blocked) {
        const acts = actionsOf(e.code);
        if (acts.includes("wardrobe")) this.onWardrobe?.();
        // G (ikinci etkileşim) açık kalır: namazı bozmak gibi kilitliyken gereken tek eylem
        else if (acts.includes("actG")) this.act = "g";
        return;
      }
      // Rakam emote; voleybolda bir eyleme atandıysa o eylem
      const d = /^Digit([1-6])$/.exec(e.code);
      if (d && !actionsOf(e.code).length) this.emote = Number(d[1]) - 1;
      // Atanmış tuş: Space/oklar sayfayı kaydırmasın, odaktaki düğmeyi tetiklemesin
      if (this.press(e.code)) e.preventDefault();
    }, { signal });
    addEventListener("keyup", (e) => {
      if (e.key === "Alt") e.preventDefault();
      this.held.delete(e.code);
    }, { signal });
    // Alt-tab: bırakılan tuşların keyup'ı gelmez; basılı kalıp karakter kendi kendine yürümesin
    addEventListener("blur", () => this.reset(), { signal });
    document.addEventListener("visibilitychange", () => document.hidden && this.reset(), { signal });
    el.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.deltaY) this.press(e.deltaY < 0 ? "WheelUp" : "WheelDown", false);
    }, { passive: false, signal });

    el.addEventListener("mousedown", (e) => this.onMouseDown(e), { signal });
    addEventListener("mousemove", (e) => this.onMouseMove(e), { signal });
    addEventListener("mouseup", (e) => this.onMouseUp(e), { signal });
    // Yan tuşlar tarayıcıda geri/ileri gitmesin
    el.addEventListener("auxclick", (e) => e.preventDefault(), { signal });
    document.addEventListener("pointerlockchange", () => this.onLockChange(), { signal });
    document.addEventListener("pointerlockerror", () => this.onLockChange(), { signal });

    el.addEventListener("pointerdown", (e) => this.onDown(e), { signal });
    el.addEventListener("pointermove", (e) => this.onMove(e), { signal });
    el.addEventListener("pointerup", (e) => this.onUp(e), { signal });
    el.addEventListener("pointercancel", (e) => this.onUp(e), { signal });
  }

  /** Mod değişince: dinleyiciler ve fare kilidi bırakılır. */
  dispose(): void {
    this.abort.abort();
    this.wantLock = this.dragLock = this.shiftLock = false;
    if (this.locked) document.exitPointerLock();
  }

  private reset(): void {
    this.held.clear();
    this.joyId = this.lookId = -1;
    this.joyX = this.joyY = 0;
    this.mouseDown = false;
    this.pinch.clear();
    this.showJoy(false);
  }

  /** Tuşa basıldı: atanmış eylemleri tetikler. Tuş bir eyleme atanmışsa true. */
  private press(bind: string, hold = true): boolean {
    const acts = actionsOf(bind);
    if (!acts.length) return false;
    if (hold) this.held.add(bind);
    for (const a of acts) this.trigger(a);
    return true;
  }

  private trigger(a: Action): void {
    switch (a) {
      case "jump":
        this.jump = true;
        break;
      case "sit":
        this.action = true;
        break;
      case "actF":
        this.act = "f";
        break;
      case "actG":
        this.act = "g";
        break;
      case "wardrobe":
        this.onWardrobe?.();
        break;
      case "shiftlock":
        this.toggleShiftLock();
        break;
      case "zoomIn":
        this.zoom -= 1;
        break;
      case "zoomOut":
        this.zoom += 1;
        break;
      default:
        if (HOTKEYS.includes(a)) this.hot.add(a);
    }
  }

  private isHeld(a: Action): boolean {
    const [p, s] = binds[a];
    return (!!p && this.held.has(p)) || (!!s && this.held.has(s));
  }

  /** Fare kilitli mi (imleç gizli, her hareket kamerayı çevirir). */
  get locked(): boolean {
    return document.pointerLockElement === this.el;
  }

  /** Pencere açılınca: basılı tuşlar bırakılır (karakter yürümeye devam etmesin), fare kilidi açılır. */
  setBlocked(on: boolean): void {
    this.blocked = on;
    if (!on) return;
    this.reset();
    this.dragLock = false;
    if (this.shiftLock) this.toggleShiftLock();
    if (this.locked) document.exitPointerLock();
  }

  /** Tanka binince açılır: imleç ortada kilitlenir, sol tık ateş eder. Dokunmatikte etkisiz. */
  setPointerLock(on: boolean): void {
    this.wantLock = on && !this.touch;
    this.syncLock();
  }

  toggleShiftLock(): void {
    if (this.touch) return;
    this.shiftLock = !this.shiftLock;
    this.el.classList.toggle("shiftlock", this.shiftLock);
    this.syncLock();
  }

  /** Kilit isteyen biri (tank, shift lock, sağ tık) varsa kilitler, kalmadıysa bırakır. */
  private syncLock(): void {
    const want = this.wantLock || this.shiftLock || this.dragLock;
    if (want && !this.locked) this.requestLock();
    else if (!want && this.locked) document.exitPointerLock();
  }

  private requestLock(): void {
    // Kullanıcı hareketi yoksa ya da çerçeve izin vermiyorsa reddedilir: sürükleyerek bakma çalışmaya devam eder.
    try {
      const r = this.el.requestPointerLock() as unknown;
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      // yok say
    }
  }

  private onLockChange(): void {
    if (this.locked) return;
    // Kilit Esc ile (ya da ayarlar açılınca) bırakıldı: shift lock da kapanır
    this.dragLock = false;
    if (this.shiftLock) {
      this.shiftLock = false;
      this.el.classList.remove("shiftlock");
    }
  }

  private onMouseDown(e: MouseEvent): void {
    if (performance.now() - this.lastTouch < TOUCH_MOUSE_MS) return;
    const bind = `Mouse${e.button}`;
    if (!reserved(bind)) {
      e.preventDefault(); // orta tık otomatik kaydırma açmasın
      this.press(bind);
      return;
    }
    if (this.wantLock) {
      if (!this.locked) this.requestLock();
      else if (e.button === 0) this.jump = true; // sol tık: ateş
      if (this.locked) return;
    }
    if (this.locked) return;
    this.mouseDown = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (e.button === 2) {
      this.dragLock = true;
      this.syncLock();
    }
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.locked) {
      if (Math.abs(e.movementX) > MAX_LOCK_STEP || Math.abs(e.movementY) > MAX_LOCK_STEP) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
      return;
    }
    // Kilit alınamadıysa (çerçeve izin vermiyor): sürükleyerek, shift lock'ta da düz hareketle bakılır
    if (this.mouseDown || (this.shiftLock && e.target === this.el)) {
      this.lookX += e.clientX - this.lastX;
      this.lookY += e.clientY - this.lastY;
    }
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  }

  private onMouseUp(e: MouseEvent): void {
    this.held.delete(`Mouse${e.button}`);
    if (e.button === 3 || e.button === 4) e.preventDefault();
    if ((e.buttons & 3) === 0) this.mouseDown = false;
    if (e.button === 2 && this.dragLock) {
      this.dragLock = false;
      this.syncLock();
    }
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === "mouse") return; // fare: mousedown
    this.lastTouch = performance.now();
    this.el.setPointerCapture(e.pointerId);
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
    if (e.pointerType === "mouse") return;
    this.lastTouch = performance.now();
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
    if (e.pointerType === "mouse") return;
    this.lastTouch = performance.now();
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
    let x = (this.isHeld("right") ? 1 : 0) - (this.isHeld("left") ? 1 : 0);
    let y = (this.isHeld("forward") ? 1 : 0) - (this.isHeld("back") ? 1 : 0);
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
    this.run = this.joyId >= 0 ? len > 0.92 : this.isHeld("run");
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

  /** Otur/kalk tuşu (E) ya da dokunmatik düğme. */
  consumeAction(): boolean {
    const a = this.action;
    this.action = false;
    return a;
  }

  /** 1–6 tuşu ya da ekrandaki emote düğmesi; yoksa -1. */
  consumeEmote(): number {
    const e = this.emote;
    this.emote = -1;
    return e;
  }

  triggerEmote(i: number): void {
    this.emote = i;
  }

  /** Etkileşim tuşu (F / G) ya da ekrandaki etkileşim düğmesi. */
  consumeAct(): "f" | "g" | null {
    const a = this.act;
    this.act = null;
    return a;
  }

  triggerAct(k: "f" | "g"): void {
    this.act = k;
  }

  consumeJump(): boolean {
    const j = this.jump;
    this.jump = false;
    return j;
  }

  triggerJump(): void {
    this.jump = true;
  }

  triggerAction(): void {
    this.action = true;
  }

  /** Kısayol bu kare basıldı mı (bir kez true döner). */
  consumeKey(k: Action): boolean {
    return this.hot.delete(k);
  }

  /** Eylemin tuşu basılı tutuluyor mu (futbolda şut gücü: actF). */
  heldAction(a: Action): boolean {
    return this.isHeld(a);
  }
}
