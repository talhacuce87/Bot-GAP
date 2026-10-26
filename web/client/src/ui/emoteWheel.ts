// Emote çarkı (Fortnite gibi): tuşu basılı tutunca ekranın ortasında altı dilimli çark açılır; fareyi bir dilime
// götürüp tuşu bırakınca o emote yapılır. Ortada kalırsan (ölü bölge) hiçbiri seçilmez. Fare kilitliyse (shift
// lock) farenin hareketi, değilse imlecin ortaya göre yeri seçer.
import { listen } from "../mode";
import { EMOTES } from "../../../shared/constants";
import { el } from "./panel";

const R_OUT = 150;
const R_IN = 58;
/** Ortadan bu kadar uzaklaşmadan seçilmez (px). */
const DEAD = 34;

export class EmoteWheel {
  private root: HTMLDivElement;
  private segs: SVGPathElement[] = [];
  private name: HTMLElement;
  private sel = -1;
  /** Kilitliyken biriken fare hareketi. */
  private vx = 0;
  private vy = 0;
  open = false;

  constructor(parent: HTMLElement) {
    this.root = el("div", "emote-wheel", parent);
    const n = EMOTES.length, size = R_OUT * 2 + 8, c = size / 2;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    const pt = (r: number, a: number) => `${c + Math.sin(a) * r} ${c - Math.cos(a) * r}`;
    for (let i = 0; i < n; i++) {
      const a0 = ((i - 0.5) / n) * Math.PI * 2 + 0.02, a1 = ((i + 0.5) / n) * Math.PI * 2 - 0.02;
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", `M ${pt(R_IN, a0)} L ${pt(R_OUT, a0)} A ${R_OUT} ${R_OUT} 0 0 1 ${pt(R_OUT, a1)} L ${pt(R_IN, a1)} A ${R_IN} ${R_IN} 0 0 0 ${pt(R_IN, a0)} Z`);
      p.setAttribute("class", "ew-seg");
      svg.append(p);
      this.segs.push(p);
      const t = document.createElementNS(ns, "text");
      const am = (i / n) * Math.PI * 2, rm = (R_IN + R_OUT) / 2;
      t.setAttribute("x", String(c + Math.sin(am) * rm));
      t.setAttribute("y", String(c - Math.cos(am) * rm + 12));
      t.setAttribute("class", "ew-emoji");
      t.textContent = EMOTES[i].emoji;
      svg.append(t);
    }
    this.root.append(svg);
    this.name = el("div", "ew-name", this.root);
    el("div", "ew-hint", this.root, "Fareyi götür · bırak");
    listen("mousemove", (e) => {
      if (!this.open) return;
      if (document.pointerLockElement) {
        this.vx = Math.max(-R_OUT, Math.min(R_OUT, this.vx + e.movementX));
        this.vy = Math.max(-R_OUT, Math.min(R_OUT, this.vy + e.movementY));
        this.aim(this.vx, this.vy);
      } else {
        this.aim(e.clientX - innerWidth / 2, e.clientY - innerHeight / 2);
      }
    });
  }

  show(): void {
    this.open = true;
    this.vx = this.vy = 0;
    this.aim(0, 0);
    this.root.classList.add("show");
  }

  /** Kapat; seçilen emote (yoksa -1). */
  hide(): number {
    this.open = false;
    this.root.classList.remove("show");
    return this.sel;
  }

  private aim(dx: number, dy: number): void {
    const n = EMOTES.length;
    this.sel = Math.hypot(dx, dy) < DEAD ? -1 : Math.round((((Math.atan2(dx, -dy) / (Math.PI * 2)) * n) % n + n) % n) % n;
    this.segs.forEach((s, i) => s.classList.toggle("on", i === this.sel));
    this.name.textContent = this.sel >= 0 ? EMOTES[this.sel].name : "";
  }
}
