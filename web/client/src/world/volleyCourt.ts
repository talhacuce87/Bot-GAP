// Voleybol salonunun içi (Volleyball 4.2 gibi): mavi zemin üstünde turuncu saha, açık renk hücum bölgeleri ve
// kesik çizgili uzantıları, file (direkler, anten, beyaz bant), top arabası, kuzeyde basamaklı
// tribün, güneyde yedek kulübesi, hakem sandalyesi ve kuzey duvarında skor tabelası. Salonun duvarları hall.ts'ten.
import * as THREE from "three";
import { NET_HALF, NET_TOP } from "../../../shared/volley";
import { VOLLEY_COURT, VOLLEY_HALL } from "../../../shared/zones";
import type { Builder } from "./builder";
import { flatMat, mat, part } from "./geo";

const LINE_W = 0.08;
/** Hücum çizgisi fileden sahanın üçte biri kadar uzakta (gerçek sahada 3 m / 9 m). */
const ATTACK_LINE = VOLLEY_COURT.hx / 3;
const COURT = "#c9603e";
const ATTACK = "#d97c52";
const POST = "#d9dde4";

export interface VolleyCourt {
  group: THREE.Group;
  /** Tabela: takım skorları, servis atan, kısa not. */
  setBoard(score: [number, number], target: number, line: string): void;
}

export function volleyCourt(b: Builder): VolleyCourt {
  const C = VOLLEY_COURT, H = VOLLEY_HALL;
  const { x: cx, z: cz, hx, hz } = C;
  const group = new THREE.Group();

  // Salonun dışı: boşlukta kalmasın diye çevresi çimen
  b.add(part(new THREE.PlaneGeometry(140, 110), "#4a6a3c", flatMat(cx, -0.02, cz)));
  // Saha ve çizgiler (dış çizgiler sahanın içinde sayılır)
  b.add(part(new THREE.PlaneGeometry(hx * 2, hz * 2), COURT, flatMat(cx, 0.02, cz), 0.03, b.rand));
  b.add(part(new THREE.PlaneGeometry(ATTACK_LINE * 2, hz * 2), ATTACK, flatMat(cx, 0.024, cz), 0.02, b.rand));
  const line = (x: number, z: number, w: number, d: number) => b.add(part(new THREE.PlaneGeometry(w, d), "#e9ecef", flatMat(x, 0.028, z)));
  line(cx, cz - hz + LINE_W / 2, hx * 2, LINE_W);
  line(cx, cz + hz - LINE_W / 2, hx * 2, LINE_W);
  line(cx - hx + LINE_W / 2, cz, LINE_W, hz * 2);
  line(cx + hx - LINE_W / 2, cz, LINE_W, hz * 2);
  line(cx, cz, LINE_W, hz * 2);
  for (const s of [-1, 1]) {
    line(cx + s * ATTACK_LINE, cz, LINE_W, hz * 2);
    // Hücum çizgisinin saha dışındaki kesik uzantıları
    for (const e of [-1, 1]) for (let i = 0; i < 3; i++) line(cx + s * ATTACK_LINE, cz + e * (hz + 0.6 + i * 1.1), LINE_W * 1.6, 0.7);
  }

  // Top arabası (kuzeybatı köşesinde): tel sepet, içinde renkli toplar
  {
    const tx = cx - hx - 3, tz = cz - hz - 1.6;
    b.add(part(new THREE.BoxGeometry(1.4, 0.06, 0.8), "#b8bec8", mat(tx, 0.55, tz)));
    for (const [ox, oz] of [[-0.65, -0.35], [0.65, -0.35], [-0.65, 0.35], [0.65, 0.35]]) {
      b.add(part(new THREE.CylinderGeometry(0.025, 0.025, 1.05, 6), "#b8bec8", mat(tx + ox, 0.55, tz + oz)));
    }
    const colors = ["#2a5fc4", "#3fb8c9", "#8f6ad8", "#3fbf7a", "#2a5fc4", "#8f6ad8"];
    colors.forEach((c, i) => b.add(part(new THREE.SphereGeometry(0.2, 12, 8), c, mat(tx - 0.42 + (i % 3) * 0.42, 0.78 + Math.floor(i / 3) * 0.3, tz + (i % 2 ? 0.12 : -0.12)))));
    b.colliders.circle(tx, tz, 0.8);
  }

  // File direkleri, anten ve bant
  for (const s of [-1, 1]) {
    const pz = cz + s * NET_HALF;
    b.add(part(new THREE.CylinderGeometry(0.06, 0.07, NET_TOP + 0.35, 10), POST, mat(cx, (NET_TOP + 0.35) / 2, pz)));
    b.add(part(new THREE.CylinderGeometry(0.16, 0.18, 0.12, 10), "#5b6270", mat(cx, 0.06, pz)));
    b.colliders.circle(cx, pz, 0.12);
    // Anten: saha kenarının üstünde, kırmızı-beyaz
    for (let i = 0; i < 6; i++) {
      b.add(part(new THREE.CylinderGeometry(0.018, 0.018, 0.15, 6), i % 2 ? "#ffffff" : "#d8352a", mat(cx, NET_TOP + 0.075 + i * 0.15, cz + s * hz)));
    }
  }
  b.add(part(new THREE.BoxGeometry(0.03, 0.07, NET_HALF * 2), "#ffffff", mat(cx, NET_TOP - 0.035, cz)));
  b.add(part(new THREE.BoxGeometry(0.02, 0.05, NET_HALF * 2), "#ffffff", mat(cx, 0.4, cz)));
  // Filenin içinden geçilmez (iki yan arası direklerin dışından dolaşılır)
  b.colliders.segment(cx, cz - NET_HALF, cx, cz + NET_HALF, 0.1);

  // File: şeffaf ağ dokusu (alt kısmı daha seyrek görünür)
  const tex = netTexture();
  tex.repeat.set((NET_HALF * 2) / 0.5, NET_TOP / 0.5);
  const net = new THREE.Mesh(
    new THREE.PlaneGeometry(NET_HALF * 2, NET_TOP - 0.07),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.05 }),
  );
  net.position.set(cx, (NET_TOP - 0.07) / 2, cz);
  net.rotation.y = Math.PI / 2;
  net.renderOrder = 3;
  group.add(net);

  // Hakem sandalyesi (filenin güney ucunda)
  const rz = cz + NET_HALF + 0.9;
  b.add(part(new THREE.BoxGeometry(0.7, 1.4, 0.7), "#c7ccd4", mat(cx, 0.7, rz)));
  b.add(part(new THREE.BoxGeometry(0.75, 0.08, 0.75), "#2f353f", mat(cx, 1.44, rz)));
  b.add(part(new THREE.BoxGeometry(0.75, 0.6, 0.08), "#2f353f", mat(cx, 1.78, rz + 0.34)));
  b.colliders.circle(cx, rz, 0.5);

  // Kuzey tribünü: dört basamak, takım renginde koltuk şeritleri
  const st = { z0: cz - hz - 3.2, len: hx * 2 + 6 };
  for (let i = 0; i < 4; i++) {
    const h = 0.45 + i * 0.45, z = st.z0 - i * 0.85;
    b.add(part(new THREE.BoxGeometry(st.len, h, 0.85), i % 2 ? "#9aa1ab" : "#a9afb8", mat(cx, h / 2, z), 0.02, b.rand));
    for (const s of [-1, 1]) b.add(part(new THREE.BoxGeometry(st.len / 2 - 0.4, 0.12, 0.4), s < 0 ? "#cf3b2f" : "#2d63c2", mat(cx + s * (st.len / 4), h + 0.06, z + 0.12)));
    // Yalnızca ön sıraya oturulur (tribünün içine girilmez)
    if (!i) b.seats.push(...[-9, -6, -3, 3, 6, 9].map((o) => ({ x: cx + o, z: z + 0.15, rot: 0, h: h + 0.06 })));
  }
  b.colliders.segment(cx - st.len / 2, st.z0 + 0.45, cx + st.len / 2, st.z0 + 0.45, 0.05);
  // Güney: iki yedek kulübesi (oturulabilir)
  for (const s of [-1, 1]) {
    const bx = cx + s * 6, bz = cz + hz + 4.2;
    b.add(part(new THREE.BoxGeometry(3, 0.45, 0.5), s < 0 ? "#cf3b2f" : "#2d63c2", mat(bx, 0.225, bz)));
    b.add(part(new THREE.BoxGeometry(3, 0.8, 0.12), "#e9ecf1", mat(bx, 0.85, bz + 0.3)));
    b.colliders.segment(bx - 1.5, bz, bx + 1.5, bz, 0.25, 0.45);
    for (const o of [-1, 0, 1]) b.seats.push({ x: bx + o, z: bz - 0.05, rot: Math.PI, h: 0.45 });
  }

  // Skor tabelası: kuzey duvarında, tribünün üstünde
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const g = canvas.getContext("2d")!;
  const boardTex = new THREE.CanvasTexture(canvas);
  boardTex.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 2), new THREE.MeshBasicMaterial({ map: boardTex }));
  board.position.set(cx, 6.2, cz - H.hd + 0.32);
  group.add(board);
  b.add(part(new THREE.BoxGeometry(6.8, 2.4, 0.15), "#1d2129", mat(cx, 6.2, cz - H.hd + 0.25)));

  let last = "";
  const setBoard = (score: [number, number], target: number, text: string) => {
    const key = `${score}|${target}|${text}`;
    if (key === last) return;
    last = key;
    g.fillStyle = "#0e1117";
    g.fillRect(0, 0, 512, 160);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "700 26px system-ui, sans-serif";
    g.fillStyle = "#ff5a4a";
    g.fillText("KIRMIZI", 110, 32);
    g.fillStyle = "#5aa0ff";
    g.fillText("MAVİ", 402, 32);
    g.font = "800 84px system-ui, sans-serif";
    g.fillStyle = "#ffd23f";
    g.fillText(String(score[0]), 110, 96);
    g.fillText(String(score[1]), 402, 96);
    g.font = "600 22px system-ui, sans-serif";
    g.fillStyle = "#d8dde6";
    g.fillText(target ? `${target} sayı` : "Antrenman", 256, 40);
    g.fillText(text, 256, 140, 500);
    g.font = "800 60px system-ui, sans-serif";
    g.fillText("–", 256, 92);
    boardTex.needsUpdate = true;
  };
  setBoard([0, 0], 0, "🏐 P: pozisyon · maç başlat");

  return { group, setBoard };
}

/** File ağı: siyah ip kare ızgara, gerisi saydam. */
function netTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.strokeStyle = "rgba(20, 22, 28, 0.9)";
  g.lineWidth = 3;
  g.strokeRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  return t;
}
