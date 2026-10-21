// Stadyum: dünyanın dışında (ufkun ardında) duran, maçla ışınlanılan büyük saha. Koşu pisti, dört yanda
// basamaklı tribünler (batı yarısı kırmızı, doğu yarısı mavi koltuklar), seyirciler (gol olunca ayağa
// kalkıp zıplar), uzun kenarlarda çatı saçağı. Saha, kaleler, projektörler ve dev ekranlar pitch.ts'ten.
import * as THREE from "three";
import { STADIUM_PITCH } from "../../../shared/zones";
import type { Builder } from "./builder";
import { flatMat, mat, part } from "./geo";
import { type Pitch, pitch } from "./pitch";

/** Tribün: basamak sayısı, derinliği ve yüksekliği; sahadan uzaklığı. */
const STEPS = 10;
const STEP_D = 0.9;
const STEP_H = 0.6;
const SIDE_GAP = 3;
const END_GAP = 5;
const SEATS = { red: ["#c9372c", "#b23026"], blue: ["#2a62c4", "#2556ad"] };
const CONCRETE = "#9c9a94";
const SHIRTS = ["#e04a3a", "#2f6fd0", "#f2f2f2", "#f2c230", "#1d1f26", "#3a9a5a", "#e07a2e", "#8a4fd0"];
const SKIN = ["#e0b48a", "#c99067", "#8d5a3b", "#f1c9a2"];

export interface Stadium {
  pitch: Pitch;
  group: THREE.Group;
  /** Gol: seyirciler birkaç saniye ayağa kalkıp zıplar. */
  cheer(time: number): void;
  update(time: number): void;
}

export function stadium(b: Builder): Stadium {
  const F = STADIUM_PITCH;
  const { x: cx, z: cz, hx, hz } = F;
  const sidePad = F.sidePad ?? 0;
  const field = pitch(b, F, { stadium: true });
  const group = new THREE.Group();
  group.add(field.group);

  // Zemin ve koşu pisti
  b.add(part(new THREE.PlaneGeometry(260, 200), "#3f5a34", flatMat(cx, -0.01, cz)));
  b.add(part(new THREE.PlaneGeometry(hx * 2 + END_GAP * 2, hz * 2 + SIDE_GAP * 2 + sidePad * 2), "#b5523b", flatMat(cx, 0.005, cz), 0.04, b.rand));

  /** Seyirci yerleri (oturan, dönük yön). */
  const fans: { x: number; y: number; z: number; ry: number }[] = [];

  /**
   * Bir kenarın tribünü: `len` boyunca, sahaya `face` yönünde dönük. `at(d, s)`: sahadan `d` uzaklıkta,
   * kenar boyunca `s` konumundaki nokta. `red(s)`: o konumdaki koltuk kırmızı mı.
   */
  const stand = (len: number, along: "x" | "z", at: (d: number, s: number) => [number, number], ry: number, red: (s: number) => boolean, roof: boolean) => {
    // Ön duvar
    const [fx, fz] = at(-0.15, 0);
    b.add(part(new THREE.BoxGeometry(along === "x" ? len : 0.3, 1.1, along === "x" ? 0.3 : len), CONCRETE, mat(fx, 0.55, fz)));
    for (let i = 0; i < STEPS; i++) {
      const h = 0.9 + i * STEP_H, d = i * STEP_D + STEP_D / 2;
      const [x, z] = at(d, 0);
      b.add(part(new THREE.BoxGeometry(along === "x" ? len : STEP_D, h, along === "x" ? STEP_D : len), i % 2 ? CONCRETE : "#a6a39c", mat(x, h / 2, z), 0.02, b.rand));
      // Koltuk sırası: 4 m'lik parçalar, takım rengi
      for (let s = -len / 2 + 2; s < len / 2; s += 4) {
        const [sx, sz] = at(d + 0.12, s);
        const team = red(s) ? SEATS.red : SEATS.blue;
        b.add(part(new THREE.BoxGeometry(along === "x" ? 3.9 : 0.4, 0.3, along === "x" ? 0.4 : 3.9), team[i % 2], mat(sx, h + 0.15, sz)));
      }
      // Seyirciler: her sırada seyrek, rastgele
      for (let s = -len / 2 + 0.6; s < len / 2 - 0.6; s += 0.75) {
        if (b.rand() > 0.55) continue;
        const [px, pz] = at(d + 0.05, s + (b.rand() - 0.5) * 0.3);
        fans.push({ x: px, y: h + 0.3, z: pz, ry });
      }
    }
    // Arka duvar
    const top = 0.9 + STEPS * STEP_H;
    const [bx, bz] = at(STEPS * STEP_D + 0.3, 0);
    b.add(part(new THREE.BoxGeometry(along === "x" ? len : 0.6, top + 2.5, along === "x" ? 0.6 : len), "#7d7b76", mat(bx, (top + 2.5) / 2, bz)));
    if (!roof) return;
    // Çatı saçağı: arka duvardan tribünün üstüne, direklerle
    const [rx, rz] = at(STEPS * STEP_D * 0.55, 0);
    b.add(part(new THREE.BoxGeometry(along === "x" ? len + 2 : STEPS * STEP_D * 1.1, 0.35, along === "x" ? STEPS * STEP_D * 1.1 : len + 2), "#d9dde3", mat(rx, top + 4.2, rz)));
    for (let s = -len / 2; s <= len / 2; s += 12) {
      const [px, pz] = at(STEPS * STEP_D + 0.2, s);
      b.add(part(new THREE.CylinderGeometry(0.18, 0.22, 4.2, 6), "#5b6270", mat(px, top + 2.1, pz)));
    }
  };

  const sideLen = hx * 2 + END_GAP * 2, endLen = hz * 2 + sidePad * 2 + SIDE_GAP * 2;
  const z0 = hz + sidePad + SIDE_GAP, x0 = hx + END_GAP;
  // Uzun kenarlar (kuzey/güney): batı yarısı kırmızı, doğu yarısı mavi
  stand(sideLen, "x", (d, s) => [cx + s, cz - z0 - d], 0, (s) => s < 0, true);
  stand(sideLen, "x", (d, s) => [cx + s, cz + z0 + d], Math.PI, (s) => s < 0, true);
  // Kale arkaları: batı kırmızı, doğu mavi
  stand(endLen, "z", (d, s) => [cx - x0 - d, cz + s], Math.PI / 2, () => true, false);
  stand(endLen, "z", (d, s) => [cx + x0 + d, cz + s], -Math.PI / 2, () => false, false);
  // Köşeler: tribünler arasını kapatan yüksek bloklar
  const depth = STEPS * STEP_D + 0.6, top = 0.9 + STEPS * STEP_H + 2.5;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.add(part(new THREE.BoxGeometry(depth, top, depth), "#86847e", mat(cx + sx * (x0 + depth / 2), top / 2, cz + sz * (z0 + depth / 2)), 0.03, b.rand));
    }
  }
  // Dev ekranların ayakları (uzun kenarların arkasında)
  for (const sz of [-1, 1]) {
    for (const sx of [-4.5, 4.5]) b.add(part(new THREE.BoxGeometry(0.5, 15, 0.5), "#2f3440", mat(cx + sx, 7.5, cz + sz * (hz + 17.3))));
  }

  // Seyirciler: gövde ve kafa (instanced; gol olunca zıplarlar)
  const n = fans.length;
  const bodyMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.62, 0.3).translate(0, 0.31, 0), new THREE.MeshLambertMaterial(), n);
  const headMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.26, 0.26, 0.26).translate(0, 0.78, 0), new THREE.MeshLambertMaterial(), n);
  const color = new THREE.Color();
  const phase = new Float32Array(n);
  fans.forEach((_f, i) => {
    color.set(SHIRTS[Math.floor(b.rand() * SHIRTS.length)]);
    bodyMesh.setColorAt(i, color);
    color.set(SKIN[Math.floor(b.rand() * SKIN.length)]);
    headMesh.setColorAt(i, color);
    phase[i] = b.rand() * Math.PI * 2;
  });
  const m = new THREE.Matrix4();
  const place = (lift: (i: number) => number) => {
    fans.forEach((f, i) => {
      m.makeRotationY(f.ry).setPosition(f.x, f.y + lift(i), f.z);
      bodyMesh.setMatrixAt(i, m);
      headMesh.setMatrixAt(i, m);
    });
    bodyMesh.instanceMatrix.needsUpdate = headMesh.instanceMatrix.needsUpdate = true;
  };
  place(() => 0);
  for (const mesh of [bodyMesh, headMesh]) {
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }

  let cheerUntil = 0;
  let still = true;
  return {
    pitch: field,
    group,
    cheer(time) {
      cheerUntil = time + 4;
    },
    update(time) {
      if (time < cheerUntil) {
        const fade = Math.min(1, cheerUntil - time);
        place((i) => Math.max(0, Math.sin(time * 9 + phase[i])) * 0.35 * fade);
        still = false;
      } else if (!still) {
        place(() => 0);
        still = true;
      }
    },
  };
}
