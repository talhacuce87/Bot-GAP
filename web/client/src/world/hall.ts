// Kapalı binalar (futbol salonu, oyuncak pist): duvarlar, çatı ve kapılar. Duvarların alt kuşağı statik
// (her zaman görünür). İçerideyken çatı gizlenir; üst duvarlardan yalnızca kameranın tarafındaki
// (kamerayla oyuncu arasında kalan) yarı saydam olur, diğer üçü binayı çevreler.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { HALL, RACE_HOUSE, VOLLEY_HALL } from "../../../shared/zones";
import type { Builder } from "./builder";
import { flatMat, mat, part } from "./geo";

/** İçeriden bakınca kalan duvar kuşağı. */
const LOW = 1.3;
const T = 0.4;
const DOOR_H = 3.6;

type Side = "n" | "s" | "w" | "e";

interface ShedSpec {
  x: number;
  z: number;
  hw: number;
  hd: number;
  h: number;
  /** Kapının yarı genişliği. */
  door: number;
  doors: Side[];
  panel: [string, string];
  base: string;
  trim: string;
  roof: string;
  floor: string;
  /** Çatıda ışıklık sırtı (büyük salon). */
  skylight: boolean;
}

export interface Hall {
  /** Üst duvarlar (kenar başına bir mesh) ve çatı. */
  upper: THREE.Group;
  inside(x: number, z: number): boolean;
  /** Kare başına: oyuncu (`focus`) içerideyse çatıyı gizle, kamera tarafındaki duvarı soldur. */
  update(focus: { x: number; z: number } | undefined, camera: THREE.Vector3 | undefined, dt: number): void;
  signAt: THREE.Matrix4;
}

function shed(b: Builder, spec: ShedSpec): Hall {
  const { x: cx, z: cz, hw, hd, h, door } = spec;
  /** Üst parçalar: 0–3 duvarlar (kuzey, güney, batı, doğu), 4 çatı. */
  const upper: THREE.BufferGeometry[][] = [[], [], [], [], []];
  let group = 4;
  const add = (g: THREE.BufferGeometry, color: string, m: THREE.Matrix4, top: boolean) => {
    const p = part(g, color, m, 0.04, b.rand);
    if (top) upper[group].push(p);
    else b.add(p);
  };
  b.clearBox(cx - hw - 1.5, cx + hw + 1.5, cz - hd - 1.5, cz + hd + 1.5);
  add(new THREE.PlaneGeometry(hw * 2 - T, hd * 2 - T), spec.floor, flatMat(cx, 0.012, cz), false);

  /** Bir duvar: merkez (wx, wz), uzunluk boyunca `along` ekseni ('x' ya da 'z'); `gap` ise ortasında kapı. */
  const wall = (wx: number, wz: number, len: number, along: "x" | "z", gap: boolean) => {
    const ry = along === "x" ? 0 : Math.PI / 2;
    const at = (o: number, y: number) => (along === "x" ? mat(wx + o, y, wz, ry) : mat(wx, y, wz + o, ry));
    const d = gap ? door : 0;
    const side = len / 2 - d;
    for (const s of [-1, 1]) {
      // Kapının iki yanı: 4 m'lik paneller (iki renk sırayla)
      const n = Math.max(1, Math.round(side / 4));
      for (let k = 0; k < n; k++) {
        const w = side / n;
        const o = s * (d + w * (k + 0.5));
        add(new THREE.BoxGeometry(w, LOW, T), spec.base, at(o, LOW / 2), false);
        add(new THREE.BoxGeometry(w, h - LOW, T), spec.panel[k % 2], at(o, LOW + (h - LOW) / 2), true);
      }
      // Kapı kasası (her zaman görünür)
      if (gap) add(new THREE.BoxGeometry(0.35, DOOR_H, T + 0.12), spec.trim, at(s * d, DOOR_H / 2), false);
      const ax = along === "x" ? wx + s * d : wx, az = along === "x" ? wz : wz + s * d;
      const bx = along === "x" ? wx + s * len / 2 : wx, bz = along === "x" ? wz : wz + s * len / 2;
      b.colliders.segment(ax, az, bx, bz, T / 2);
    }
    if (gap) {
      // Kapının üstü
      add(new THREE.BoxGeometry(d * 2, h - DOOR_H, T), spec.panel[0], at(0, DOOR_H + (h - DOOR_H) / 2), true);
      add(new THREE.BoxGeometry(d * 2 + 0.35, 0.3, T + 0.12), spec.trim, at(0, DOOR_H + 0.15), false);
    }
    // Üst kenarda şerit
    add(new THREE.BoxGeometry(len + T, 0.35, T + 0.06), spec.trim, at(0, h - 0.6), true);
  };
  const has = (s: Side) => spec.doors.includes(s);
  group = 0;
  wall(cx, cz - hd, hw * 2, "x", has("n"));
  group = 1;
  wall(cx, cz + hd, hw * 2, "x", has("s"));
  group = 2;
  wall(cx - hw, cz, hd * 2, "z", has("w"));
  group = 3;
  wall(cx + hw, cz, hd * 2, "z", has("e"));
  group = 4;

  // Çatı: hafif taşan düz döşeme; büyük salonda ortada ışıklık sırtı ve kirişler
  add(new THREE.BoxGeometry(hw * 2 + 0.8, 0.35, hd * 2 + 0.8), spec.roof, mat(cx, h + 0.17, cz), true);
  if (spec.skylight) {
    add(new THREE.BoxGeometry(hw * 2 - 6, 1.1, 4.2), "#5f6b7c", mat(cx, h + 0.9, cz), true);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(hw * 2 - 6.2, 0.7, 0.08), "#a9d4f2", mat(cx, h + 0.95, cz + s * 2.12), true);
    for (let i = 0; i < 6; i++) {
      const x = cx - hw + 3 + i * ((hw * 2 - 6) / 5);
      add(new THREE.BoxGeometry(0.25, 0.25, hd * 2 + 0.8), "#2f353f", mat(x, h + 0.42, cz), true);
    }
  } else {
    add(new THREE.BoxGeometry(hw * 2 + 0.9, 0.2, hd * 2 + 0.9), spec.trim, mat(cx, h + 0.02, cz), true);
  }

  // Kapıların yanında dış lambalar
  const lamps: Record<Side, [number, number][]> = {
    w: [[cx - hw - 1.2, cz - door - 1.2], [cx - hw - 1.2, cz + door + 1.2]],
    e: [[cx + hw + 1.2, cz - door - 1.2], [cx + hw + 1.2, cz + door + 1.2]],
    n: [[cx - door - 1.2, cz - hd - 1.2], [cx + door + 1.2, cz - hd - 1.2]],
    s: [[cx - door - 1.2, cz + hd + 1.2], [cx + door + 1.2, cz + hd + 1.2]],
  };
  for (const side of spec.doors) {
    for (const [lx, lz] of lamps[side]) {
      b.prop("post", mat(lx, 0, lz));
      b.prop("bulb", mat(lx, 2.7, lz));
      b.colliders.circle(lx, lz, 0.15);
    }
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
  // Tabela: ilk kapının üstünde, dışarı bakar
  const signs: Record<Side, THREE.Matrix4> = {
    w: mat(cx - hw - T / 2 - 0.06, DOOR_H + 1.9, cz, -Math.PI / 2),
    e: mat(cx + hw + T / 2 + 0.06, DOOR_H + 1.9, cz, Math.PI / 2),
    n: mat(cx, DOOR_H + 1.9, cz - hd - T / 2 - 0.06, Math.PI),
    s: mat(cx, DOOR_H + 1.9, cz + hd + T / 2 + 0.06, 0),
  };
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
    signAt: spec.doors.length ? signs[spec.doors[0]] : new THREE.Matrix4(),
  };
}

/** Kapalı futbol salonu: dört kapı, ışıklıklı çatı. Tabela batı kapısının üstünde (nehirden gelene bakar). */
export function hall(b: Builder): Hall {
  return shed(b, {
    ...HALL,
    doors: ["w", "n", "s", "e"],
    panel: ["#6d84a6", "#62789a"],
    base: "#9a9a94",
    trim: "#d8dde4",
    roof: "#3b4350",
    floor: "#6c7884",
    skylight: true,
  });
}

/** Oyuncak pist binası: renkli, tek kapısı yola (doğuya) bakar. */
export function raceHouse(b: Builder): Hall {
  return shed(b, {
    ...RACE_HOUSE,
    doors: ["e"],
    panel: ["#f2b544", "#ef8a3c"],
    base: "#d9d2c4",
    trim: "#ffffff",
    roof: "#c4473a",
    floor: "#d8c7a6",
    skylight: false,
  });
}

/** Voleybol salonu: dünyanın dışında, kapısız (ışınlanılır); ahşap rengi duvarlar, mavi serbest bölge. */
export function volleyHall(b: Builder): Hall {
  return shed(b, {
    ...VOLLEY_HALL,
    door: 0,
    doors: [],
    panel: ["#e9e1d2", "#ded5c4"],
    base: "#3d6fb0",
    trim: "#f4f1ea",
    roof: "#4a5262",
    floor: "#2f68b0",
    skylight: true,
  });
}
