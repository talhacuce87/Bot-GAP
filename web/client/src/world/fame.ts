// Şöhret Kürsüsü: XP sıralaması panosu + ilk 3 için altın/gümüş/bronz heykelli podyum.
// Pano tek bir canvas dokusu; yalnızca bot yeni sıralama gönderince yeniden çizilir (kare başına maliyet yok).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BoardEntry } from "../../../shared/protocol";
import { colorFor } from "../avatars/avatars";
import type { Builder } from "./builder";
import { mat, part } from "./geo";

/** Kürsünün yeri: meydanın güneybatısı, yüzü meydana dönük. */
export const FAME = { x: -34, z: 42 };
const RY = Math.atan2(-FAME.x, -FAME.z);

const TEX = 1024;
const BOARD_H = 768; // dokunun üst kısmı pano, altı heykel portreleri
const PORTRAIT = 256;
const BOARD_W_M = 7.2;
const BOARD_H_M = 5.4;
const BOARD_Y = 1.15 + BOARD_H_M / 2;
const BOARD_Z = -2.6;

const RANK_COLORS = ["#e6b93b", "#c9d1d9", "#c47c3e"];
const STEP = [
  { u: 0, h: 1.0 }, // 1.
  { u: -1.6, h: 0.7 }, // 2.
  { u: 1.6, h: 0.45 }, // 3.
];
const STATUE_SCALE = 1.2;
const FACE_Y = 2.05;

const root = mat(FAME.x, 0, FAME.z, RY);
const local = (u: number, y: number, v: number, ry = 0, sx = 1, sy = sx, sz = sx) => root.clone().multiply(mat(u, y, v, ry, sx, sy, sz));

/** Kürsünün statik parçalarını (çerçeve, podyum) ve çarpışmalarını Builder'a ekler. */
export function fameStatics(b: Builder): void {
  const wood = "#5b3f25";
  const add = (g: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter = 0) => b.add(part(g, color, m, jitter, b.rand));

  // Pano çerçevesi, ayakları ve çatısı
  add(new THREE.BoxGeometry(BOARD_W_M + 0.5, BOARD_H_M + 0.5, 0.25), "#3a2a1a", local(0, BOARD_Y, BOARD_Z - 0.16));
  for (const u of [-3.1, 3.1]) add(new THREE.BoxGeometry(0.3, 1.3, 0.3), wood, local(u, 0.65, BOARD_Z - 0.16));
  add(new THREE.BoxGeometry(BOARD_W_M + 1, 0.22, 0.8), "#7a2f2f", local(0, BOARD_Y + BOARD_H_M / 2 + 0.36, BOARD_Z - 0.1));
  add(new THREE.ConeGeometry(0.28, 0.5, 6), RANK_COLORS[0], local(0, BOARD_Y + BOARD_H_M / 2 + 0.72, BOARD_Z - 0.1));

  // Podyum basamakları: mermer gövde + ön yüzde madalya renginde şerit
  STEP.forEach((s, i) => {
    add(new THREE.BoxGeometry(1.5, s.h, 1.4), "#dcd7cb", local(s.u, s.h / 2, 0), 0.05);
    add(new THREE.BoxGeometry(1.52, 0.14, 0.04), RANK_COLORS[i], local(s.u, s.h - 0.2, 0.71));
    // Sıra numarası yerine nokta sayısı kadar madalya pulu (yazı dokusu gerektirmez)
    for (let k = 0; k <= i; k++) {
      add(new THREE.CylinderGeometry(0.09, 0.09, 0.03, 10), RANK_COLORS[i], local(s.u + (k - i / 2) * 0.24, s.h / 2 - 0.1, 0.71, 0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
    }
  });
  add(new THREE.CircleGeometry(4.8, 24), "#cfc3a6", local(0, 0.015, -0.6).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)), 0.05);

  const seg = (u0: number, v0: number, u1: number, v1: number, r: number, top?: number) => {
    const a = new THREE.Vector3(u0, 0, v0).applyMatrix4(root);
    const c = new THREE.Vector3(u1, 0, v1).applyMatrix4(root);
    b.colliders.segment(a.x, a.z, c.x, c.z, r, top);
  };
  seg(-3.8, BOARD_Z - 0.16, 3.8, BOARD_Z - 0.16, 0.3);
  // Basamaklara çıkılır: 3.'den 2.'ye, oradan 1.'ye
  for (const s of STEP) seg(s.u - 0.05, 0, s.u + 0.05, 0, 0.7, s.h);
  b.shadow(FAME.x, FAME.z, 2.8);
  b.clearCircle(FAME.x, FAME.z, 6);

}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** Pano + heykeller: canlı güncellenen kısım. */
export class FameBoard {
  readonly group = new THREE.Group();
  private canvas = document.createElement("canvas");
  private g: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private statues: THREE.InstancedMesh;
  private entries: BoardEntry[] = [];
  private updated = 0;
  private images = new Map<string, HTMLImageElement>();
  private redrawTimer = 0;
  private avatarUrl: (id: string, hash: string) => string = () => "";

  constructor() {
    this.canvas.width = this.canvas.height = TEX;
    this.g = this.canvas.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;

    // Pano yüzü ve 3 heykel yüzü: tek geometri, tek doku, tek draw call.
    const quad = (w: number, h: number, u0: number, v0: number, u1: number, v1: number, m: THREE.Matrix4) => {
      const q = new THREE.PlaneGeometry(w, h);
      const uv = q.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
      return q.applyMatrix4(m);
    };
    const pv = PORTRAIT / TEX;
    const faces = STEP.map((s, i) => quad(0.72, 0.72, i * pv, 0, (i + 1) * pv, pv, local(s.u, s.h + FACE_Y, 0)));
    const board = quad(BOARD_W_M, BOARD_H_M, 0, 1 - BOARD_H / TEX, 1, 1, local(0, BOARD_Y, BOARD_Z));
    const surface = new THREE.Mesh(
      mergeGeometries([board, ...faces]),
      new THREE.MeshBasicMaterial({ map: this.tex, alphaTest: 0.5 }),
    );
    surface.matrixAutoUpdate = false;

    // Heykeller: avatar gövdesiyle aynı kapsül, madalya renginde ve hafif parlak
    const body = new THREE.CapsuleGeometry(0.32, 0.75, 3, 10).translate(0, 0.7, 0);
    this.statues = new THREE.InstancedMesh(body, new THREE.MeshLambertMaterial({ emissive: "#2a2410" }), 3);
    STEP.forEach((s, i) => {
      this.statues.setMatrixAt(i, local(s.u, s.h, 0, 0, STATUE_SCALE));
      this.statues.setColorAt(i, new THREE.Color(RANK_COLORS[i]));
    });
    // Sınır küresi 3 heykel varken hesaplanmalı; count=0 iken hesaplanırsa boş çıkar ve hep kırpılır.
    this.statues.computeBoundingSphere();
    this.statues.count = 0;
    this.statues.matrixAutoUpdate = false;

    this.group.add(surface, this.statues);
    this.draw();
  }

  setAvatarUrl(fn: (id: string, hash: string) => string): void {
    this.avatarUrl = fn;
  }

  set(entries: BoardEntry[], updated: number): void {
    this.entries = entries;
    this.updated = updated;
    this.statues.count = Math.min(3, entries.length);
    for (const e of entries) this.loadAvatar(e);
    this.draw();
  }

  private loadAvatar(e: BoardEntry): void {
    if (!e.avatar || this.images.has(e.id + e.avatar)) return;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => this.scheduleRedraw();
    img.src = this.avatarUrl(e.id, e.avatar);
    this.images.set(e.id + e.avatar, img);
  }

  /** Avatarlar ayrı ayrı yüklenir; her biri için yeniden yükleme yerine kısa bir bekleme ile tek çizim. */
  private scheduleRedraw(): void {
    window.clearTimeout(this.redrawTimer);
    this.redrawTimer = window.setTimeout(() => this.draw(), 150);
  }

  private avatar(e: BoardEntry, cx: number, cy: number, r: number, ring: string): void {
    const g = this.g;
    const img = e.avatar ? this.images.get(e.id + e.avatar) : undefined;
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.closePath();
    g.clip();
    if (img?.complete && img.naturalWidth) {
      g.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    } else {
      g.fillStyle = `#${colorFor(e.id).getHexString()}`;
      g.fillRect(cx - r, cy - r, r * 2, r * 2);
      g.fillStyle = "#ffffff";
      g.font = `700 ${Math.round(r * 1.05)}px system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText((e.name.trim()[0] || "?").toLocaleUpperCase("tr"), cx, cy + r * 0.06);
    }
    g.restore();
    g.lineWidth = Math.max(3, r * 0.1);
    g.strokeStyle = ring;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
  }

  private fit(text: string, max: number): string {
    let s = text;
    while (s.length > 1 && this.g.measureText(s).width > max) s = s.slice(0, -1);
    return s === text ? s : `${s.slice(0, -1)}…`;
  }

  private draw(): void {
    const g = this.g;
    g.clearRect(0, 0, TEX, TEX);

    // Zemin ve çerçeve
    const grad = g.createLinearGradient(0, 0, 0, BOARD_H);
    grad.addColorStop(0, "#1c2740");
    grad.addColorStop(1, "#121a2c");
    g.fillStyle = grad;
    g.fillRect(0, 0, TEX, BOARD_H);
    g.strokeStyle = RANK_COLORS[0];
    g.lineWidth = 10;
    g.strokeRect(5, 5, TEX - 10, BOARD_H - 10);

    g.textBaseline = "middle";
    g.textAlign = "center";
    g.fillStyle = RANK_COLORS[0];
    g.font = "900 64px system-ui, sans-serif";
    g.fillText("ŞÖHRET KÜRSÜSÜ", TEX / 2, 62);
    g.fillStyle = "#9fb0cc";
    g.font = "500 24px system-ui, sans-serif";
    g.fillText("Toplam XP sıralaması · ilk 10", TEX / 2, 108);

    const top = 140, rowH = 58;
    if (!this.entries.length) {
      g.fillStyle = "#9fb0cc";
      g.font = "500 34px system-ui, sans-serif";
      g.fillText("Sıralama bekleniyor…", TEX / 2, BOARD_H / 2);
    }
    this.entries.forEach((e, i) => {
      const y = top + i * rowH;
      const cy = y + rowH / 2;
      g.fillStyle = i % 2 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.07)";
      roundRect(g, 24, y + 4, TEX - 48, rowH - 8, 12);
      g.fill();

      const medal = RANK_COLORS[i] ?? "#4a5672";
      g.fillStyle = medal;
      g.beginPath();
      g.arc(70, cy, 21, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = i < 3 ? "#1b1b1b" : "#ffffff";
      g.font = "800 24px system-ui, sans-serif";
      g.textAlign = "center";
      g.fillText(String(i + 1), 70, cy + 1);

      this.avatar(e, 130, cy, 22, medal);

      g.textAlign = "left";
      g.fillStyle = "#f2f4f8";
      g.font = "700 30px system-ui, sans-serif";
      g.fillText(this.fit(e.name, 470), 168, cy);
      g.fillStyle = "#9fb0cc";
      g.font = "600 24px system-ui, sans-serif";
      g.fillText(`Sv. ${e.level}`, 670, cy);
      g.textAlign = "right";
      g.fillStyle = i < 3 ? medal : "#d7deea";
      g.font = "800 28px system-ui, sans-serif";
      g.fillText(`${e.xp.toLocaleString("tr-TR")} XP`, TEX - 48, cy);
    });

    if (this.updated) {
      const t = new Date(this.updated).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
      g.textAlign = "right";
      g.fillStyle = "#6f7f9c";
      g.font = "500 20px system-ui, sans-serif";
      g.fillText(`Güncellendi ${t}`, TEX - 30, BOARD_H - 22);
    }

    // Heykel portreleri (dokunun alt şeridi; dışı saydam, alphaTest ile kesilir)
    for (let i = 0; i < 3; i++) {
      const e = this.entries[i];
      if (e) this.avatar(e, i * PORTRAIT + PORTRAIT / 2, BOARD_H + PORTRAIT / 2, PORTRAIT / 2 - 14, RANK_COLORS[i]);
    }
    this.tex.needsUpdate = true;
  }
}
