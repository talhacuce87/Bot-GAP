// Simitçi: meydanın batısında camlı kırmızı simit arabası, şemsiyesi ve arkasında simitçi.
import * as THREE from "three";
import { PLAZA } from "../../../shared/zones";
import type { Builder } from "./builder";
import type { CityNpc } from "./city";
import { mat, part } from "./geo";

/** Arabanın yeri: meydan döşemesinin batı ucu, çeşmeye bakar (+x). */
export const SIMIT_CART = { x: PLAZA.x - 7.2, z: PLAZA.z + 1.5, rot: Math.PI / 2 };

export function simitci(b: Builder): CityNpc[] {
  const { x, z, rot } = SIMIT_CART;
  const c = Math.cos(rot), s = Math.sin(rot);
  /** Arabanın yerel ekseninde (+z ön, +x sol) dünya konumu. */
  const at = (lx: number, lz: number): [number, number] => [x + lx * c + lz * s, z - lx * s + lz * c];
  const box = (w: number, h: number, d: number, color: string, lx: number, y: number, lz: number) => {
    const [px, pz] = at(lx, lz);
    b.add(part(new THREE.BoxGeometry(w, h, d), color, mat(px, y, pz, rot), 0.04, b.rand));
  };
  // Gövde: kırmızı sandık, üstünde camlı vitrin ve içinde simit yığını
  box(1.6, 0.55, 0.85, "#b8241c", 0, 0.62, 0);
  box(1.66, 0.06, 0.9, "#e9e3d6", 0, 0.92, 0);
  box(1.5, 0.5, 0.75, "#cfe3ea", 0, 1.2, 0);
  box(1.56, 0.05, 0.8, "#b8241c", 0, 1.47, 0);
  for (let i = 0; i < 9; i++) {
    const [px, pz] = at(-0.55 + (i % 3) * 0.55, -0.2 + Math.floor(i / 3) * 0.2);
    b.add(part(new THREE.TorusGeometry(0.11, 0.045, 6, 12).rotateX(Math.PI / 2), "#c98a3c", mat(px, 1.0 + Math.floor(i / 3) * 0.06, pz)));
  }
  // Tekerlekler ve tutamak
  for (const lx of [-0.62, 0.62]) {
    const [px, pz] = at(lx, 0.45);
    b.add(part(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 12).rotateZ(Math.PI / 2), "#2a2a2e", mat(px, 0.22, pz, rot)));
  }
  box(0.05, 0.05, 0.6, "#3a3a3e", 0.72, 0.85, -0.55);
  // Şemsiye
  const [ux, uz] = at(0, -0.1);
  b.add(part(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), "#d8d8d8", mat(ux, 2.2, uz)));
  b.add(part(new THREE.ConeGeometry(1.15, 0.45, 10), "#f2efe6", mat(ux, 3.05, uz)));
  b.add(part(new THREE.ConeGeometry(1.17, 0.4, 10, 1, true), "#c7302a", mat(ux, 3.02, uz, 0.31)));
  // Tabela
  box(1.0, 0.24, 0.03, "#f7e7b4", 0, 1.68, 0.43);
  b.colliders.segment(...at(-0.75, 0), ...at(0.75, 0), 0.5, 1.5);
  b.clearCircle(x, z, 1.8);
  const [wx, wz] = at(0, -0.95);
  const [ax, az] = at(0, 1.3);
  return [
    {
      name: "Simitçi Hüsnü",
      x: wx,
      z: wz,
      rot,
      outfit: { hair: "hair_kisa_doku", tops: "top_tisort", bottoms: "bottom_kot", shoes: "shoes_klasik", hats: null, glasses: null, facial: null, colors: { hair: "#3b2f2a", skin: "#d9a77c" } },
      act: { x: ax, z: az, r: 2, label: "Simit al 🥯", line: "Taze simit, sıcak simit! Çayını da kahvehanede iç.", fx: "sparkle", food: "simit" },
    },
  ];
}
