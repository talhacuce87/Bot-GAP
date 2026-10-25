// Bilek güreşi ekranı (canvas 760×460): üstte kenetli kollar (kaçıran tarafa yatar), altta iki oyuncunun
// skill check çemberi. Tepeden saat yönünde dönen ibre isabet yayındayken SPACE (ya da dokunma).
import { BILEK_LOSE, type BilekCheck, bilekProgress, type BilekState } from "../../../shared/games/bilek";
import type { TableState } from "../../../shared/protocol";

export const BILEK_W = 760;
export const BILEK_H = 460;
const SIDE_COLORS = ["#e2493b", "#3f86ea"];
const SKIN = "#f1c6a5";
/** Sonuç yazısı bu kadar (ms) görünür. */
const FLASH_MS = 700;

/** `lean` yumuşatılmış eğim (-1..1, + koltuk 0'a doğru); `me` oyundaki sıram (-1 izleyici). */
export function drawBilek(g: CanvasRenderingContext2D, t: TableState, s: BilekState | null, lean: number, me: number, now: number): void {
  const bg = g.createLinearGradient(0, 0, 0, BILEK_H);
  bg.addColorStop(0, "#2b2330");
  bg.addColorStop(1, "#1a1620");
  g.fillStyle = bg;
  g.fillRect(0, 0, BILEK_W, BILEK_H);
  const names = [0, 1].map((i) => (s ? t.names[t.seats.indexOf(t.order[i])] : t.names[i]) || "—");
  drawArms(g, lean, s, names);
  if (!s) {
    text(g, "İki kişi oturunca oyunu başlatın.", BILEK_W / 2, 330, 22, "#d8d0e0");
    text(g, "Çember gelince ibre parlak yaydayken SPACE'e bas (ya da ekrana dokun).", BILEK_W / 2, 365, 16, "#a99fb5");
    text(g, `Kaçıran tarafa kol eğilir · ${BILEK_LOSE} fark olunca bilek masaya değer.`, BILEK_W / 2, 392, 16, "#a99fb5");
    return;
  }
  for (const i of [0, 1] as const) drawCheck(g, s.checks[i], 200 + i * 360, 335, i, i === me, names[i], now);
  if (s.winner !== null) {
    g.fillStyle = "rgba(10, 8, 14, 0.72)";
    g.fillRect(0, 250, BILEK_W, BILEK_H - 250);
    text(g, `🏆 ${names[s.winner]} kazandı!`, BILEK_W / 2, 350, 34, SIDE_COLORS[s.winner]);
  } else if (!s.round) text(g, "Hazırlan…", BILEK_W / 2, 335, 26, "#f3ead2");
}

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "center"): void {
  g.font = `600 ${size}px Barlow, system-ui, sans-serif`;
  g.textAlign = align;
  g.textBaseline = "middle";
  g.fillStyle = color;
  g.fillText(s, x, y);
}

/** Masa ve kenetli kollar; iki yanda ad ve kaçırma sayısı, ortada fark çentikleri. */
function drawArms(g: CanvasRenderingContext2D, lean: number, s: BilekState | null, names: string[]): void {
  const cx = BILEK_W / 2, ty = 200, R = 120, ex = 78, fist = 20;
  g.fillStyle = "#6b4a2c";
  g.fillRect(cx - 230, ty, 460, 16);
  g.fillStyle = "#3b4250";
  g.fillRect(cx - 200, ty - 4, 400, 6);
  // Fark çentikleri: her kaçırma farkı bir adım
  for (let k = -BILEK_LOSE; k <= BILEK_LOSE; k++) {
    if (!k) continue;
    const a = (-k / BILEK_LOSE) * Math.acos(fist / R);
    g.strokeStyle = SIDE_COLORS[k > 0 ? 0 : 1];
    g.globalAlpha = 0.35 + 0.1 * Math.abs(k);
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx + Math.sin(a) * (R + 14), ty - Math.cos(a) * (R + 14));
    g.lineTo(cx + Math.sin(a) * (R + 26), ty - Math.cos(a) * (R + 26));
    g.stroke();
  }
  g.globalAlpha = 1;
  const th = -lean * Math.acos(fist / R);
  const hx = cx + Math.sin(th) * R, hy = ty - Math.cos(th) * R;
  g.lineCap = "round";
  for (const i of [0, 1]) {
    const x0 = cx + (i ? ex : -ex);
    g.strokeStyle = SKIN;
    g.lineWidth = 26;
    g.beginPath();
    g.moveTo(x0, ty - 6);
    g.lineTo(hx, hy);
    g.stroke();
    // Bileklik
    g.strokeStyle = SIDE_COLORS[i];
    g.lineWidth = 30;
    g.beginPath();
    g.moveTo(x0 + (hx - x0) * 0.12, ty - 6 + (hy - ty + 6) * 0.12);
    g.lineTo(x0 + (hx - x0) * 0.22, ty - 6 + (hy - ty + 6) * 0.22);
    g.stroke();
  }
  g.fillStyle = SKIN;
  g.beginPath();
  g.arc(hx, hy, fist + 6, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#c99a7c";
  g.lineWidth = 2;
  g.stroke();
  for (const i of [0, 1]) {
    const x = i ? BILEK_W - 24 : 24, align = i ? "right" : "left";
    text(g, names[i], x, 34, 22, SIDE_COLORS[i], align);
    if (s) text(g, `Kaçırma: ${s.misses[i]}`, x, 64, 16, "#cfc6da", align);
  }
  if (s) {
    const d = Math.abs(s.misses[0] - s.misses[1]);
    text(g, d ? `Fark ${d} / ${BILEK_LOSE}` : "Berabere", cx, 34, 18, "#f3ead2");
    if (s.round) text(g, `Tur ${s.round}`, cx, 60, 14, "#a99fb5");
  }
}

/** Skill check çemberi: gri iz, parlak isabet yayı, dönen ibre; sonuçta yeşil/kırmızı. */
function drawCheck(g: CanvasRenderingContext2D, c: BilekCheck | null, x: number, y: number, side: number, mine: boolean, name: string, now: number): void {
  const r = mine ? 82 : 70;
  text(g, mine ? "SEN" : name, x, y - r - 26, mine ? 20 : 16, mine ? "#ffffff" : SIDE_COLORS[side]);
  g.lineCap = "butt";
  g.lineWidth = 12;
  g.strokeStyle = "rgba(255, 255, 255, 0.12)";
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
  if (!c) return;
  const ang = (p: number) => -Math.PI / 2 + p * Math.PI * 2;
  const flash = c.res && now - c.done < FLASH_MS;
  g.strokeStyle = c.res === "hit" ? "#4fd16b" : c.res === "miss" ? "#e2493b" : "#f6f1e4";
  g.lineWidth = 16;
  g.beginPath();
  g.arc(x, y, r, ang(c.zone), ang(c.zone + c.width));
  g.stroke();
  // Dış kenarda oyuncunun rengi (hangi çember kimin)
  if (!c.res) {
    g.strokeStyle = SIDE_COLORS[side];
    g.lineWidth = 6;
    g.beginPath();
    g.arc(x, y, r + 11, ang(c.zone), ang(c.zone + c.width));
    g.stroke();
  }
  const p = c.res ? Math.min(1, (c.done - c.at) / c.dur) : Math.max(0, Math.min(1, bilekProgress(c, now)));
  g.strokeStyle = "#ff5b4a";
  g.lineWidth = 5;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + Math.cos(ang(p)) * (r + 8), y + Math.sin(ang(p)) * (r + 8));
  g.stroke();
  g.fillStyle = "#ff5b4a";
  g.beginPath();
  g.arc(x, y, 7, 0, Math.PI * 2);
  g.fill();
  if (flash) text(g, c.res === "hit" ? "TUTTU!" : "KAÇTI!", x, y + r + 34, 22, c.res === "hit" ? "#4fd16b" : "#e2493b");
  else if (mine && !c.res) text(g, bilekProgress(c, now) < 0 ? "Hazır…" : "SPACE", x, y + r + 34, 18, "#f3ead2");
}
