// İş görev kartı (GTA görev metni gibi ekranın üstünde ortada): ne yapacağın, nereden nereye, kalan mesafe,
// süre barı (kurye), ödül ya da taksimetre ve bugünkü iş sayısı.
import { JOBS, type JobView } from "../../../shared/jobs";
import { region } from "./layout";
import { el } from "./panel";

export class JobHud {
  private root: HTMLDivElement;
  private title: HTMLElement;
  private time: HTMLElement;
  private sub: HTMLElement;
  private bar: HTMLDivElement;
  private fill: HTMLElement;
  private pay: HTMLElement;
  private count: HTMLElement;
  private view: JobView | null = null;
  /** Kurye süresinin toplamı (bar oranı için). */
  private total = 1;

  constructor(parent: HTMLElement) {
    this.root = el("div", "job-card", region(parent, "tc"));
    const top = el("div", "job-top", this.root);
    this.title = el("b", "", top);
    this.time = el("span", "job-time", top);
    this.sub = el("span", "job-sub", this.root);
    this.bar = el("div", "job-bar", this.root);
    this.fill = el("i", "", this.bar);
    const bottom = el("div", "job-bottom", this.root);
    this.pay = el("span", "job-pay", bottom);
    this.count = el("span", "job-count", bottom);
  }

  set(v: JobView | null, serverNow: number): void {
    const was = this.view;
    this.view = v;
    this.root.classList.toggle("show", !!v);
    if (!v) return;
    if (v.until && (!was || was.until !== v.until)) this.total = Math.max(1, v.until - serverNow);
    const icon = JOBS[v.kind].icon;
    this.title.textContent =
      v.phase === "pickup" ? `${icon} Paketi al` :
      v.phase === "deliver" ? `${icon} Paketi teslim et` :
      v.phase === "fetch" ? `🧍 Müşteriyi al · ${v.who ?? ""}` :
      v.phase === "ride" ? `🚕 ${v.who ?? "Müşteri"}'yi götür` :
      v.phase === "meter" ? `🚕 Yolcu: ${v.who ?? ""}` : `${icon} ${JOBS[v.kind].name}`;
    this.pay.textContent =
      v.phase === "meter" ? `Taksimetre ₺${v.pay}` :
      v.phase === "deliver" ? `₺${v.pay} + zamanında ₺${Math.round((v.pay * 0.2) / 5) * 5}` :
      v.phase === "ride" ? `₺${v.pay}` : "";
    this.count.textContent = `Bugün ${v.done} iş · ₺${v.earned.toLocaleString("tr-TR")}`;
    this.bar.style.display = v.until ? "" : "none";
  }

  /** Kare başına: kalan mesafe ve süre. */
  frame(me: { x: number; z: number }, serverNow: number): void {
    const v = this.view;
    if (!v) return;
    const t = v.target;
    const d = t ? Math.round(Math.hypot(t.x - me.x, t.z - me.z)) : 0;
    this.sub.textContent = t ? `${t.name} · ${d} m` : v.phase === "meter" ? "Yolcu nereye isterse oraya" : "";
    if (v.until) {
      const left = v.until - serverNow;
      const s = Math.max(0, Math.ceil(left / 1000));
      this.time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      this.time.classList.toggle("late", left <= 0);
      this.fill.style.width = `${Math.max(0, Math.min(1, left / this.total)) * 100}%`;
    } else this.time.textContent = "";
  }
}
