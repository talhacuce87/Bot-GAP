// Navigasyon oku (NFSU2 gibi): arabanın üstünde süzülen, kalın ve parlak mavi 3B ok. Rotada biraz ilerideki
// noktaya (bir sonraki dönüş) yumuşakça döner; ucu hafif öne eğik, hafifçe yukarı aşağı salınır. Yürürken başının
// üstünde, daha küçük. Hep görünür (binalar ve ağaçlar örtmez).
import * as THREE from "three";

const TOP = "#5ad8ff";
const SIDE = "#1066c4";
const GLOW = "#8fe6ff";
/** Okun boyu çarpanı (şekil ~1,2 m): arabanın üstünde uzaktan okunsun. */
const SIZE = 1.7;

function arrowShape(): THREE.Shape {
  // +y ucu: kalın gövde ve geniş baş (ölçü: m)
  const s = new THREE.Shape();
  s.moveTo(-0.22, -0.55);
  s.lineTo(0.22, -0.55);
  s.lineTo(0.22, 0.05);
  s.lineTo(0.52, 0.05);
  s.lineTo(0, 0.62);
  s.lineTo(-0.52, 0.05);
  s.lineTo(-0.22, 0.05);
  s.closePath();
  return s;
}

export class NavArrow {
  readonly group = new THREE.Group();
  private tilt = new THREE.Group();
  private yaw = 0;
  private shown = false;

  constructor() {
    const geo = new THREE.ExtrudeGeometry(arrowShape(), { depth: 0.16, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
    // Şekil xy düzleminde (+y uç): yatırılır, uç +z'ye (ileri), kalınlık aşağı
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0.1, 0);
    const opts = { fog: false, depthTest: false, depthWrite: false, transparent: true };
    const body = new THREE.Mesh(geo, [new THREE.MeshBasicMaterial({ color: TOP, ...opts }), new THREE.MeshBasicMaterial({ color: SIDE, ...opts })]);
    body.renderOrder = 21;
    // Parlama: arkasında biraz büyük, saydam kopya
    const glow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: GLOW, ...opts, opacity: 0.35, blending: THREE.AdditiveBlending, side: THREE.BackSide }));
    glow.scale.setScalar(1.18);
    glow.renderOrder = 20;
    this.tilt.add(glow, body);
    // Ucu öne eğik: arkadan bakan kamera üst yüzü görür
    this.tilt.rotation.x = 0.42;
    this.group.add(this.tilt);
    this.group.visible = false;
  }

  /**
   * Kare başına: `at` okun yeri (araba ya da baş üstü), `to` gösterdiği nokta; null gizler. `scale` yürürken küçük.
   */
  update(at: { x: number; y: number; z: number } | null, to: { x: number; z: number } | null, scale: number, dt: number, time: number): void {
    if (!at || !to) {
      this.group.visible = this.shown = false;
      return;
    }
    const want = Math.atan2(to.x - at.x, to.z - at.z);
    if (!this.shown) this.yaw = want;
    // Açı en kısa yoldan, yumuşak
    let d = want - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * (1 - Math.exp(-dt * 7));
    this.shown = this.group.visible = true;
    this.group.position.set(at.x, at.y + Math.sin(time * 2.4) * 0.07, at.z);
    this.group.rotation.y = this.yaw;
    this.group.scale.setScalar(SIZE * scale * (1 + Math.sin(time * 4.8) * 0.03));
  }
}
