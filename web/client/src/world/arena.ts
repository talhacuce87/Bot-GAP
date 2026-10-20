// Tank savaşı arenası: düz toprak alan, kenarda beton duvar, ortada siperler, iki renkli üs.
// Siperler shared/arena.ts'teki COVER listesinden: sunucu mermiyi aynı yerlerde durdurur.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ARENA_RADIUS, ARENA_WALL_H, BASES, COVER, TEAMS } from "../../../shared/arena";
import { Colliders } from "./colliders";
import { flatMat, mat, part, rng, timeUniform } from "./geo";

export interface Arena {
  scene: THREE.Scene;
  colliders: Colliders;
  seats: never[];
  spawn: { x: number; z: number; rot: number };
  update(time: number): void;
}

const SKY = new THREE.Color("#b9cfe0");

export function buildArena(): Arena {
  const rand = rng(0xa7e4a);
  const scene = new THREE.Scene();
  scene.background = SKY;
  scene.fog = new THREE.Fog(SKY, 70, 170);
  scene.add(new THREE.HemisphereLight("#e4f0ff", "#6a5a3c", 1.5));
  const sun = new THREE.DirectionalLight("#fff0d2", 1.8);
  sun.position.set(30, 40, 15);
  scene.add(sun);

  const colliders = new Colliders();
  const geos: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, color: string, m: THREE.Matrix4, jitter = 0.12) => geos.push(part(g, color, m, jitter, rand));

  // Zemin: içte sıkışmış toprak, dışta çimen; tekerlek izi gibi lekeler
  add(new THREE.CircleGeometry(200, 48), "#6f8f4a", flatMat(0, -0.01, 0), 0.06);
  add(new THREE.CircleGeometry(ARENA_RADIUS + 3, 64), "#9c8562", flatMat(0, 0, 0), 0.1);
  for (let i = 0; i < 40; i++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * (ARENA_RADIUS - 4);
    add(new THREE.CircleGeometry(1.5 + rand() * 3, 9), rand() > 0.5 ? "#8b7553" : "#a89170", flatMat(Math.cos(a) * r, 0.01 + i * 0.0002, Math.sin(a) * r, 1, 0.6 + rand() * 0.8, rand() * 6));
  }

  // Kenar duvarı: beton bloklar; çarpışma için halka parçaları
  const n = 72;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * (ARENA_RADIUS + 1.2), z = Math.sin(a) * (ARENA_RADIUS + 1.2);
    const len = ((ARENA_RADIUS + 1.2) * Math.PI * 2) / n;
    add(new THREE.BoxGeometry(len * 0.96, ARENA_WALL_H, 0.9), i % 6 === 0 ? "#c9a227" : "#a6a39b", mat(x, ARENA_WALL_H / 2, z, -a + Math.PI / 2));
    const b = ((i + 1) / n) * Math.PI * 2;
    colliders.segment(x, z, Math.cos(b) * (ARENA_RADIUS + 1.2), Math.sin(b) * (ARENA_RADIUS + 1.2), 0.5);
  }

  // Siperler
  for (const c of COVER) {
    colliders.circle(c.x, c.z, c.r);
    if (c.kind === "rock") {
      add(new THREE.IcosahedronGeometry(1, 0), "#8a8d90", mat(c.x, c.h * 0.42, c.z, rand() * 6, c.r * 1.05, c.h * 0.62, c.r * 1.05), 0.25);
      add(new THREE.IcosahedronGeometry(1, 0), "#7b7e82", mat(c.x + c.r * 0.4, c.h * 0.25, c.z - c.r * 0.3, rand() * 6, c.r * 0.6, c.h * 0.35, c.r * 0.6), 0.25);
    } else if (c.kind === "crates") {
      const s = c.r * 0.95;
      for (const [ox, oz, oy] of [[-0.5, -0.5, 0], [0.5, -0.4, 0], [-0.4, 0.5, 0], [0.45, 0.45, 0], [0, 0, 1]]) {
        add(new THREE.BoxGeometry(s, s * 0.95, s), oy ? "#a8784a" : "#94683f", mat(c.x + ox * s, (oy + 0.5) * s * 0.95, c.z + oz * s, rand() * 0.4));
      }
    } else {
      // Kum torbası duvarı: dairesel siperin içine sığan, üç sıra
      for (let row = 0; row < 3; row++) {
        add(new THREE.BoxGeometry(c.r * 1.7, c.h / 3, 1.1), "#b8a47a", mat(c.x, (row + 0.5) * (c.h / 3), c.z, Math.PI / 2 + row * 0.05), 0.15);
      }
    }
  }

  // Üsler: takım renginde zemin, bayrak direği
  BASES.forEach((b, team) => {
    const color = TEAMS[team].color;
    add(new THREE.CircleGeometry(9, 32), color, flatMat(b.x, 0.02, b.z), 0.04);
    add(new THREE.RingGeometry(9, 9.6, 32), "#e8e4da", flatMat(b.x, 0.03, b.z), 0);
    const fx = b.x - Math.sin(b.h) * 6, fz = b.z;
    add(new THREE.CylinderGeometry(0.08, 0.1, 6, 6), "#d8d8d8", mat(fx, 3, fz));
    add(new THREE.BoxGeometry(0.06, 1.1, 1.8), color, mat(fx, 5.4, fz + 0.9), 0);
    colliders.circle(fx, fz, 0.2);
  });

  const statics = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  statics.matrixAutoUpdate = false;
  scene.add(statics);

  return {
    scene,
    colliders,
    seats: [],
    spawn: { x: 0, z: 0, rot: 0 },
    update(time) {
      timeUniform.value = time;
    },
  };
}
