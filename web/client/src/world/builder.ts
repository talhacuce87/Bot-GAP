// Sahne parçalarını toplayan kurucu: bölgeler buraya ekler, sonunda her tür tek mesh'e iner.
// Böylece yeni bir bölge eklemek draw call sayısını artırmaz.
import * as THREE from "three";
import { Colliders } from "./colliders";
import { rng } from "./geo";

export interface Seat {
  x: number;
  z: number;
  rot: number;
}

/** Tekrarlanan objeler: her biri tek InstancedMesh olarak çizilir. */
export type PropKind = "pine" | "oak" | "rock" | "bush" | "stone" | "post" | "bulb" | "flame" | "log";

export class Builder {
  readonly rand = rng(0x6a7);
  /** Tek mesh'te birleştirilecek, vertex renkli statik geometri. */
  readonly statics: THREE.BufferGeometry[] = [];
  readonly colliders = new Colliders();
  readonly seats: Seat[] = [];
  readonly props: Record<PropKind, THREE.Matrix4[]> = {
    pine: [], oak: [], rock: [], bush: [], stone: [], post: [], bulb: [], flame: [], log: [],
  };
  /** Zemin gölgeleri: x, z, yarıçap. */
  readonly shadows: number[] = [];
  /** Çimen/çiçek serpilmeyecek alanlar. */
  private keepOut: { x: number; z: number; r: number }[] = [];
  private keepOutBoxes: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];

  add(geo: THREE.BufferGeometry): void {
    this.statics.push(geo);
  }

  prop(kind: PropKind, m: THREE.Matrix4): void {
    this.props[kind].push(m);
  }

  shadow(x: number, z: number, r: number): void {
    this.shadows.push(x, z, r);
  }

  clearCircle(x: number, z: number, r: number): void {
    this.keepOut.push({ x, z, r });
  }

  clearBox(minX: number, maxX: number, minZ: number, maxZ: number): void {
    this.keepOutBoxes.push({ minX, maxX, minZ, maxZ });
  }

  isClear(x: number, z: number): boolean {
    for (const c of this.keepOut) if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r) return false;
    for (const b of this.keepOutBoxes) if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return false;
    return true;
  }
}
