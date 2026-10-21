// Bilek güreşi masasında kenetlenmiş iki kol: dirsekler minderlerde, eller ortada. Kaçırma farkı arttıkça
// kenetli eller kaybeden tarafa yatar; fark BILEK_LOSE olunca elin sırtı masaya değer.
import * as THREE from "three";
import { bilekLean } from "../../../shared/games/bilek";
import type { TableState } from "../../../shared/protocol";
import { TABLES } from "../../../shared/zones";

/** Dirsek minderinin masa ortasından uzaklığı ve masa üstü yüksekliği (kahvehane.ts ile aynı). */
const ELBOW_X = 0.15;
const TOP_Y = 0.81;
/** Kenetli ellerin dirsek ekseninden yüksekliği (dik dururken). */
const GRIP_R = 0.2;
/** Tam yatınca ellerin masadan yüksekliği (yumruk yarıçapı). */
const FIST = 0.045;
const SKIN = "#f1c6a5";
const BANDS = ["#c0392b", "#2e6fd0"];

interface Arms {
  spot: (typeof TABLES)[number];
  group: THREE.Group;
  fore: THREE.Mesh[];
  fist: THREE.Mesh;
  lean: number;
}

export class BilekArms {
  readonly group = new THREE.Group();
  private arms: Arms[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor() {
    const skin = new THREE.MeshLambertMaterial({ color: SKIN });
    const fore = new THREE.CylinderGeometry(0.032, 0.04, 1, 10);
    const band = new THREE.CylinderGeometry(0.044, 0.044, 0.05, 10).translate(0, -0.38, 0);
    const fist = new THREE.SphereGeometry(FIST, 12, 10);
    for (const spot of TABLES) {
      if (spot.kind !== "bilek") continue;
      const group = new THREE.Group();
      group.position.set(spot.x, 0, spot.z);
      group.visible = false;
      const arms = BANDS.map((c) => {
        const m = new THREE.Mesh(fore, skin);
        m.add(new THREE.Mesh(band, new THREE.MeshLambertMaterial({ color: c })));
        group.add(m);
        return m;
      });
      const f = new THREE.Mesh(fist, skin);
      group.add(f);
      this.group.add(group);
      this.arms.push({ spot, group, fore: arms, fist: f, lean: 0 });
    }
  }

  /** Masa durumuna göre (oyun yoksa gizli); `lean` yumuşakça hedefe gider. */
  update(table: (id: number) => TableState | undefined, dt: number): void {
    for (const r of this.arms) {
      const g = table(r.spot.id)?.game;
      r.group.visible = g?.kind === "bilek";
      if (g?.kind !== "bilek") continue;
      r.lean += (bilekLean(g.state) - r.lean) * (1 - Math.exp(-dt * 6));
      // Kenetli eller dirsekler arasındaki eksen etrafında döner; tam yatınca masaya değer.
      // + lean batıdaki (koltuk 0, kırmızı) tarafa yatırır.
      const th = -r.lean * Math.acos(FIST / GRIP_R);
      const hx = Math.sin(th) * GRIP_R, hy = TOP_Y + Math.cos(th) * GRIP_R;
      r.fist.position.set(hx, hy, 0);
      r.fore.forEach((m, i) => {
        this.a.set((i ? 1 : -1) * ELBOW_X, TOP_Y, 0);
        this.b.set(hx, hy, 0);
        const len = this.a.distanceTo(this.b);
        m.position.copy(this.a).add(this.b).multiplyScalar(0.5);
        m.scale.set(1, len, 1);
        m.quaternion.setFromUnitVectors(this.up, this.b.sub(this.a).normalize());
      });
    }
  }
}
