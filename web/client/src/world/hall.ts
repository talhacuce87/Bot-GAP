// Kapalı futbol salonu: sahanın çevresinde duvarlar, çatı ve dört kapı. Duvarların alt kuşağı statik
// (her zaman görünür). İçerideyken çatı gizlenir; üst duvarlardan yalnızca kameranın tarafındaki
// (kamerayla oyuncu arasında kalan) yarı saydam olur, diğer üçü salonu çevreler.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { HALL } from "../../../shared/zones";
import type { Builder } from "./builder";
import { flatMat, mat, part } from "./geo";

/** İçeriden bakınca kalan duvar kuşağı. */
const LOW = 1.3;
const T = 0.4;
const DOOR_H = 3.6;
const PANEL = ["#6d84a6", "#62789a"];
const BASE = "#9a9a94";
const TRIM = "#d8dde4";

export interface Hall {
  /** Üst duvarlar (kenar başına bir mesh) ve çatı. */
  upper: THREE.Group;
  inside(x: number, z: number): boolean;
  /** Kare başına: oyuncu (`focus`) içerideyse çatıyı gizle, kamera tarafındaki duvarı soldur. */
  update(focus: { x: number; z: number } | undefined, camera: THREE.Vector3 | undefined, dt: number): void;
  signAt: THREE.Matrix4;
}

export function hall(b: Builder): Hall {
  const { x: cx, z: cz, hw, hd, h, door } = HALL;
  /** Üst parçalar: 0–3 duvarlar (kuzey, güney, batı, doğu), 4 çatı. */
  const upper: THREE.BufferGeometry[][] = [[], [], [], [], []];
  let group = 4;
  const add = (g: THREE.BufferGeometry, color: string, m: THREE.Matrix4, top: boolean) => {
    const p = part(g, color, m, 0.04, b.rand);
    if (top) upper[group].push(p);
    else b.add(p);
  };
  b.clearBox(cx - hw - 1.5, cx + hw + 1.5, cz - hd - 1.5, cz + hd + 1.5);

  // Zemin: sahanın çevresi kauçuk kaplama (sahanın çiminin altında kalır)
  add(new THREE.PlaneGeometry(hw * 2 - T, hd * 2 - T), "#6c7884", flatMat(cx, 0.012, cz), false);

  /** Bir duvar: merkez (wx, wz), uzunluk boyunca `along` ekseni ('x' ya da 'z'), ortasında kapı. */
  const wall = (wx: number, wz: number, len: number, along: "x" | "z") => {
    const ry = along === "x" ? 0 : Math.PI / 2;
    const at = (o: number, y: number) => (along === "x" ? mat(wx + o, y, wz, ry) : mat(wx, y, wz + o, ry));
    const side = len / 2 - door;
    for (const s of [-1, 1]) {
      // Kapının iki yanı: 4 m'lik paneller (iki renk sırayla)
      const n = Math.max(1, Math.round(side / 4));
      for (let k = 0; k < n; k++) {
        const w = side / n;
        const o = s * (door + w * (k + 0.5));
        add(new THREE.BoxGeometry(w, LOW, T), BASE, at(o, LOW / 2), false);
        add(new THREE.BoxGeometry(w, h - LOW, T), PANEL[k % 2], at(o, LOW + (h - LOW) / 2), true);
      }
      // Kapı kasası (her zaman görünür)
      add(new THREE.BoxGeometry(0.35, DOOR_H, T + 0.12), TRIM, at(s * door, DOOR_H / 2), false);
      const ax = along === "x" ? wx + s * door : wx, az = along === "x" ? wz : wz + s * door;
      const bx = along === "x" ? wx + s * len / 2 : wx, bz = along === "x" ? wz : wz + s * len / 2;
      b.colliders.segment(ax, az, bx, bz, T / 2);
    }
    // Kapının üstü
    add(new THREE.BoxGeometry(door * 2, h - DOOR_H, T), PANEL[0], at(0, DOOR_H + (h - DOOR_H) / 2), true);
    add(new THREE.BoxGeometry(door * 2 + 0.35, 0.3, T + 0.12), TRIM, at(0, DOOR_H + 0.15), false);
    // Üst kenarda beyaz şerit
    add(new THREE.BoxGeometry(len + T, 0.35, T + 0.06), TRIM, at(0, h - 0.6), true);
  };
  group = 0;
  wall(cx, cz - hd, hw * 2, "x");
  group = 1;
  wall(cx, cz + hd, hw * 2, "x");
  group = 2;
  wall(cx - hw, cz, hd * 2, "z");
  group = 3;
  wall(cx + hw, cz, hd * 2, "z");
  group = 4;

  // Çatı: hafif taşan düz döşeme, ortada ışıklık sırtı, kenarda koyu saçak
  add(new THREE.BoxGeometry(hw * 2 + 0.8, 0.35, hd * 2 + 0.8), "#3b4350", mat(cx, h + 0.17, cz), true);
  add(new THREE.BoxGeometry(hw * 2 - 6, 1.1, 4.2), "#5f6b7c", mat(cx, h + 0.9, cz), true);
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(hw * 2 - 6.2, 0.7, 0.08), "#a9d4f2", mat(cx, h + 0.95, cz + s * 2.12), true);
  }
  for (let i = 0; i < 6; i++) {
    const x = cx - hw + 3 + i * ((hw * 2 - 6) / 5);
    add(new THREE.BoxGeometry(0.25, 0.25, hd * 2 + 0.8), "#2f353f", mat(x, h + 0.42, cz), true);
  }

  // Kapıların yanında dış lambalar
  for (const [lx, lz] of [[cx - hw - 1.2, cz - door - 1.2], [cx - hw - 1.2, cz + door + 1.2], [cx + hw + 1.2, cz - door - 1.2], [cx + hw + 1.2, cz + door + 1.2], [cx - door - 1.2, cz - hd - 1.2], [cx + door + 1.2, cz - hd - 1.2], [cx - door - 1.2, cz + hd + 1.2], [cx + door + 1.2, cz + hd + 1.2]]) {
    b.prop("post", mat(lx, 0, lz));
    b.prop("bulb", mat(lx, 2.7, lz));
    b.colliders.circle(lx, lz, 0.15);
  }

  const upperGroup = new THREE.Group();
  const meshes = upper.map((parts) => {
    const m = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 1 }));
    m.castShadow = m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    upperGroup.add(m);
    return m;
  });
  const inside = (x: number, z: number) => Math.abs(x - cx) < hw && Math.abs(z - cz) < hd;
  /** Duvarın iç yüzeyine göre kameranın konumu: bu duvarın tarafına geçmiş (ya da dibinde) mi. */
  const cameraSide = [
    (c: THREE.Vector3) => c.z < cz - hd + 2.5,
    (c: THREE.Vector3) => c.z > cz + hd - 2.5,
    (c: THREE.Vector3) => c.x < cx - hw + 2.5,
    (c: THREE.Vector3) => c.x > cx + hw - 2.5,
  ];
  return {
    upper: upperGroup,
    inside,
    update(focus, camera, dt) {
      const inHall = !!focus && inside(focus.x, focus.z);
      meshes[4].visible = !inHall;
      const k = 1 - Math.exp(-dt * 8);
      for (let i = 0; i < 4; i++) {
        const mat = meshes[i].material as THREE.MeshLambertMaterial;
        const target = inHall && camera && cameraSide[i](camera) ? 0.18 : 1;
        mat.opacity += (target - mat.opacity) * k;
        // Tam opakken saydamlık sıralaması gereksiz (gölge ve derinlik doğru kalsın)
        mat.depthWrite = mat.opacity > 0.95;
        meshes[i].castShadow = mat.opacity > 0.95;
      }
    },
    // Batı cephesinde, kapının üstünde (nehirden gelene bakar)
    signAt: mat(cx - hw - T / 2 - 0.06, DOOR_H + 1.9, cz, -Math.PI / 2),
  };
}
