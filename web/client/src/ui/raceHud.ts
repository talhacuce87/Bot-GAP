// GAP Ring yarış arayüzü: sol üstte sıra, tur, süre ve yarışçılar (lidere fark); üstte mini harita; ekranın
// üst ortasında F1 lambaları (5 kırmızı, sonra yeşil "BAŞLA!"); sol altta hız göstergesi; gridde bekleme şeridi;
// bitişte sonuç tablosu. Durumu sunucu gönderir (RaceView); konumlar her kare dışarıdan verilir.
import { lightsAt, type RaceView, raceTime, RACE_AREA, TRACK, TRACK_HALF } from "../../../shared/race";

export interface RaceFrame {
  race: RaceView | null;
  me: number;
  now: number;
  /** Hız (m/sn) ve araba yönü; yarışçıların konumları. */
  speed: number;
  pos: (sid: number) => { x: number; z: number } | null;
  wrongWay: boolean;
}

const COLORS = ["#ff3b3b", "#3fa9ff", "#ffd23f", "#4dff88", "#ff4fd8", "#ff8a1f", "#a86bff", "#25e8d8"];
const MAP_W = 230, MAP_H = 170;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.append(e);
  return e;
}

const gapText = (r: RaceView["racers"][number]) =>
  r.dnf ? "DNF" : r.total !== null && r.pos === 1 ? raceTime(r.total) : r.lapsDown ? `+${r.lapsDown} TUR` : r.gap !== null ? `+${(r.gap / 1000).toFixed(1)}` : "—";

export class RaceHud {
  private root: HTMLDivElement;
  private board: HTMLDivElement;
  private posEl: HTMLDivElement;
  private lapEl: HTMLDivElement;
  private timeEl: HTMLDivElement;
  private bestEl: HTMLDivElement;
  private list: HTMLOListElement;
  private map: HTMLCanvasElement;
  private mapBg: HTMLCanvasElement;
  private lights: HTMLDivElement;
  private lamps: HTMLElement[] = [];
  private goEl: HTMLDivElement;
  private speedo: HTMLCanvasElement;
  private lobby: HTMLDivElement;
  private results: HTMLDivElement;
  private wrong: HTMLDivElement;
  private alert: HTMLDivElement;
  private listKey = "";
  private resultsKey = "";
  private alertUntil = 0;
  private leaveBtn: HTMLButtonElement;
  private leaveArmed = 0;

  constructor(private hudRoot: HTMLElement, onLeave: () => void) {
    this.root = el("div", "race-hud", hudRoot);
    // Sol üst: sıra, tur, süre ve yarışçılar
    this.board = el("div", "rh-board", this.root);
    const head = el("div", "rh-head", this.board);
    this.posEl = el("div", "rh-pos", head);
    const meta = el("div", "rh-meta", head);
    this.lapEl = el("div", "rh-lap", meta);
    this.timeEl = el("div", "rh-time", meta);
    this.bestEl = el("div", "rh-best", meta);
    this.list = el("ol", "rh-list", this.board);
    // Yarışı terk et: yanlışlıkla basılmasın diye iki adım (ilk tık onay ister)
    this.leaveBtn = el("button", "rh-leave", this.root);
    this.leaveBtn.addEventListener("click", () => {
      if (this.root.dataset.phase === "lobby" || performance.now() < this.leaveArmed) {
        this.leaveArmed = 0;
        onLeave();
      } else this.leaveArmed = performance.now() + 4000;
      this.leaveBtn.blur();
    });
    // Üst orta: mini harita
    this.map = el("canvas", "rh-map", this.root);
    this.mapBg = document.createElement("canvas");
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const c of [this.map, this.mapBg]) {
      c.width = MAP_W * dpr;
      c.height = MAP_H * dpr;
    }
    this.drawMapBg(dpr);
    // F1 lambaları ve start
    this.lights = el("div", "rh-lights", this.root);
    for (let i = 0; i < 5; i++) {
      const pod = el("div", "rh-pod", this.lights);
      this.lamps.push(el("i", "", pod), el("i", "", pod));
    }
    this.goEl = el("div", "rh-go", this.root);
    this.goEl.textContent = "BAŞLA!";
    // Sol alt: hız
    this.speedo = el("canvas", "rh-speedo", this.root);
    this.speedo.width = this.speedo.height = 150 * dpr;
    this.lobby = el("div", "rh-lobby", this.root);
    this.results = el("div", "rh-results", this.root);
    this.wrong = el("div", "rh-wrong", this.root);
    this.wrong.textContent = "⟲ TERS YÖN";
    this.alert = el("div", "rh-alert", this.root);
  }

  /** Kısa büyük uyarı (erken kalkış, son tur, bitiş). */
  flash(text: string, ms = 2200, cls = ""): void {
    this.alert.textContent = text;
    this.alert.className = `rh-alert show ${cls}`;
    this.alertUntil = performance.now() + ms;
  }

  update(f: RaceFrame): void {
    const race = f.race;
    const mine = race?.racers.find((r) => r.sid === f.me) ?? null;
    const phase = race?.phase ?? "idle";
    const active = !!mine && phase !== "idle";
    this.root.classList.toggle("show", active);
    this.hudRoot.classList.toggle("racing", active && phase !== "lobby");
    if (performance.now() > this.alertUntil) this.alert.classList.remove("show");
    if (!race || !mine || !active) return;

    const inLobby = phase === "lobby";
    this.root.dataset.phase = phase;
    const canLeave = mine.total === null && !mine.dnf && phase !== "done";
    this.leaveBtn.hidden = !canLeave;
    const armed = performance.now() < this.leaveArmed;
    this.leaveBtn.classList.toggle("armed", armed);
    this.leaveBtn.textContent = inLobby ? "🚪 Gridden çık" : armed ? "⚠️ Emin misin? Tıkla: terk et (DNF)" : "🏳️ Yarışı terk et";
    // Gridde bekleme şeridi
    this.lobby.classList.toggle("show", inLobby);
    if (inLobby) {
      const host = race.racers.find((r) => r.sid === race.host);
      this.lobby.innerHTML = `<b>🏁 GRID · ${race.racers.length}/8</b><span>${race.racers.map((r) => `${r.slot + 1}. ${esc(r.name)}`).join(" · ")}</span><small>${race.host === f.me ? "F: yarışı başlat · G: tur sayısı" : `Yarışı ${esc(host?.name ?? "grid sahibi")} başlatacak · G: gridden çık`}</small>`;
    }

    // Lambalar
    const l = lightsAt(race, f.now);
    const showLights = phase === "lights" || (phase === "racing" && l.green);
    this.lights.classList.toggle("show", showLights);
    this.lamps.forEach((lamp, i) => {
      const on = Math.floor(i / 2) < l.red;
      lamp.className = l.green ? "green" : on ? "red" : "";
    });
    this.goEl.classList.toggle("show", l.green);

    // Sıra, tur, süre
    const racing = phase === "racing" || phase === "done";
    this.posEl.innerHTML = `P${mine.pos}<small>/${race.racers.length}</small>`;
    this.lapEl.textContent = `TUR ${mine.lap}/${race.laps}`;
    const t = mine.total ?? (race.goAt !== null && racing ? Math.max(0, f.now - race.goAt) : 0);
    this.timeEl.textContent = raceTime(t);
    this.bestEl.textContent = mine.bestLap !== null ? `EN İYİ ${raceTime(mine.bestLap)}` : mine.penalty ? `CEZA +${mine.penalty / 1000} sn` : race.endAt !== null && mine.total === null ? `SON ${Math.max(0, Math.ceil((race.endAt - f.now) / 1000))} sn` : "";
    const key = race.racers.map((r) => `${r.sid}:${r.pos}:${gapText(r)}:${r.penalty}:${r.total}`).join("|");
    if (key !== this.listKey) {
      this.listKey = key;
      this.list.replaceChildren(
        ...race.racers.map((r) => {
          const li = el("li", r.sid === f.me ? "me" : r.dnf ? "dnf" : "");
          const dot = el("i", "", li);
          dot.style.background = COLORS[r.slot % COLORS.length];
          el("span", "rh-n", li).textContent = `${r.pos}`;
          el("span", "rh-name", li).textContent = r.name;
          if (r.penalty) el("em", "", li).textContent = `+${r.penalty / 1000}s`;
          el("span", "rh-gap", li).textContent = r.pos === 1 && r.total === null && !r.dnf ? "LİDER" : gapText(r);
          return li;
        }),
      );
    }

    this.drawMap(race, f);
    this.drawSpeed(f.speed);
    this.wrong.classList.toggle("show", phase === "racing" && f.wrongWay && mine.total === null);

    // Sonuçlar
    this.results.classList.toggle("show", phase === "done");
    if (phase === "done") {
      const rk = race.racers.map((r) => `${r.sid}:${r.pos}:${r.prize}`).join("|");
      if (rk !== this.resultsKey) {
        this.resultsKey = rk;
        this.results.innerHTML =
          `<h3>🏁 SONUÇLAR</h3><table><tr><th>#</th><th>Pilot</th><th>Süre</th><th>En iyi tur</th><th>Ödül</th></tr>` +
          race.racers
            .map((r) => `<tr class="${r.sid === f.me ? "me" : ""}"><td>${r.dnf ? "—" : r.pos}</td><td>${esc(r.name)}</td><td>${r.dnf ? "DNF" : r.total !== null ? raceTime(r.total) : "—"}${r.penalty ? ` <em>(+${r.penalty / 1000}s)</em>` : ""}</td><td>${r.bestLap !== null ? raceTime(r.bestLap) : "—"}</td><td>${r.prize ? `💰 +${r.prize}` : ""}</td></tr>`)
            .join("") +
          `</table>${race.racers.length < 2 ? "<p>Ödül için en az iki yarışçı gerekir.</p>" : ""}`;
      }
    } else this.resultsKey = "";
  }

  // ---------------------------------------------------------------------------

  private mapXY(x: number, z: number): [number, number] {
    const pad = 10, w = RACE_AREA.maxX - RACE_AREA.minX, h = RACE_AREA.maxZ - RACE_AREA.minZ;
    const k = Math.min((MAP_W - 2 * pad) / w, (MAP_H - 2 * pad) / h);
    // Kuzey (−z) yukarıda
    return [MAP_W / 2 + (x - (RACE_AREA.minX + RACE_AREA.maxX) / 2) * k, MAP_H / 2 + (z - (RACE_AREA.minZ + RACE_AREA.maxZ) / 2) * k];
  }

  private drawMapBg(dpr: number): void {
    const g = this.mapBg.getContext("2d")!;
    g.scale(dpr, dpr);
    const path = () => {
      g.beginPath();
      TRACK.forEach((p, i) => {
        const [x, y] = this.mapXY(p.x, p.z);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
    };
    g.lineJoin = "round";
    path();
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = TRACK_HALF * 0.9 + 3;
    g.stroke();
    path();
    g.strokeStyle = "#2a2d33";
    g.lineWidth = TRACK_HALF * 0.9;
    g.stroke();
    // Start çizgisi: ilk grid kutusunun önü
    const [sx, sy] = this.mapXY(492, -138);
    g.fillStyle = "#fff";
    g.fillRect(sx - 1.5, sy - 5, 3, 10);
  }

  private drawMap(race: RaceView, f: RaceFrame): void {
    const g = this.map.getContext("2d")!;
    const dpr = this.map.width / MAP_W;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.map.width, this.map.height);
    g.drawImage(this.mapBg, 0, 0);
    g.scale(dpr, dpr);
    // Önce diğerleri, en üstte ben
    const order = [...race.racers].sort((a, b) => (a.sid === f.me ? 1 : 0) - (b.sid === f.me ? 1 : 0));
    for (const r of order) {
      const p = f.pos(r.sid);
      if (!p) continue;
      const [x, y] = this.mapXY(p.x, p.z);
      g.beginPath();
      g.arc(x, y, r.sid === f.me ? 5.5 : 4, 0, Math.PI * 2);
      g.fillStyle = COLORS[r.slot % COLORS.length];
      g.fill();
      g.lineWidth = r.sid === f.me ? 2.5 : 1.2;
      g.strokeStyle = r.sid === f.me ? "#fff" : "rgba(0,0,0,0.7)";
      g.stroke();
    }
  }

  private drawSpeed(v: number): void {
    const g = this.speedo.getContext("2d")!;
    const dpr = this.speedo.width / 150;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, 150, 150);
    const kmh = Math.abs(v) * 3.6, max = 80;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    g.lineCap = "round";
    g.lineWidth = 10;
    g.strokeStyle = "rgba(255,255,255,0.14)";
    g.beginPath();
    g.arc(75, 78, 58, a0, a1);
    g.stroke();
    const t = Math.min(1, kmh / max);
    const grad = g.createLinearGradient(20, 0, 130, 0);
    grad.addColorStop(0, "#3fa9ff");
    grad.addColorStop(0.7, "#ffd23f");
    grad.addColorStop(1, "#ff3b3b");
    g.strokeStyle = grad;
    g.beginPath();
    g.arc(75, 78, 58, a0, a0 + (a1 - a0) * t);
    g.stroke();
    // Çentikler (10 km/s)
    g.lineWidth = 2;
    g.strokeStyle = "rgba(255,255,255,0.5)";
    for (let k = 0; k <= max; k += 10) {
      const a = a0 + (a1 - a0) * (k / max);
      g.beginPath();
      g.moveTo(75 + Math.cos(a) * 44, 78 + Math.sin(a) * 44);
      g.lineTo(75 + Math.cos(a) * 49, 78 + Math.sin(a) * 49);
      g.stroke();
    }
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.font = "900 38px system-ui, sans-serif";
    g.fillText(String(Math.round(kmh)), 75, 86);
    g.font = "700 12px system-ui, sans-serif";
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.fillText("km/sa", 75, 106);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
