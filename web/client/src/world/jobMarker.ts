// İş hedefinin dünyadaki işareti (GTA checkpoint gibi): yerde parlayan turuncu halka, içinden yükselen saydam
// ışık sütunu ve üstünde dönen ok. Uzaktan da görünür (sis etkilemez).
import * as THREE from "three";

const COLOR = "#ef9f27";

export class JobMarker {
  readonly group = new THREE.Group();
  private arrow: THREE.Mesh;

  constructor() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 3.1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.85, depthWrite: false, fog: false }),
    );
    ring.position.y = 0.08;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(2.9, 2.9, 7, 40, 1, true),
      new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }),
    );
    beam.position.y = 3.5;
    this.arrow = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.1, 4).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: COLOR, fog: false }));
    this.arrow.position.y = 5;
    this.group.add(ring, beam, this.arrow);
    this.group.visible = false;
  }

  set(at: { x: number; z: number; y: number } | null, time: number): void {
    this.group.visible = !!at;
    if (!at) return;
    this.group.position.set(at.x, at.y, at.z);
    this.arrow.rotation.y = time * 2;
    this.arrow.position.y = 5 + Math.sin(time * 3) * 0.35;
  }
}
