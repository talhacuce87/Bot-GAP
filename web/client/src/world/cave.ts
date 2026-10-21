// Mağara: dağın içindeki oyuk ve ona giden tünel. Tünelin ağzında ahşap maden kapısı ve ZİNDAN tabelası,
// içeride meşaleler, sarkıt/dikitler ve parlayan kristaller. Zindan hücresi zones.ts'te (mağaranın batısında).
import * as THREE from "three";
import { CAVE, TUNNEL, TUNNEL_HALF } from "../../../shared/zones";
import { JAIL } from "../../../shared/constants";
import type { Builder } from "./builder";
import { mat, part } from "./geo";
import { mountainHeight } from "./terrain";

const TIMBER = "#6b4a2b";
const TIMBER_DARK = "#4d3520";

function torch(b: Builder, x: number, z: number): void {
  b.add(part(new THREE.CylinderGeometry(0.06, 0.08, 1.9, 6), TIMBER_DARK, mat(x, 0.95, z)));
  b.add(part(new THREE.CylinderGeometry(0.18, 0.09, 0.22, 7), "#26282d", mat(x, 2.0, z)));
  b.prop("flame", mat(x, 2.28, z, 0, 0.8));
  b.colliders.circle(x, z, 0.15);
}

/** Tünel ağzının çerçevesi, tünel ve mağara süsleri. Tabela yeri döner. */
export function cave(b: Builder): { signAt: THREE.Matrix4 } {
  // Tünelin dağa girdiği yer: ilk parçada dağın başladığı nokta
  const [ax, az] = TUNNEL[0], [bx, bz] = TUNNEL[1];
  const len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
  let t = 0;
  while (t < len && mountainHeight(ax + ux * t, az + uz * t) < 2.5) t += 0.25;
  const fx = ax + ux * t, fz = az + uz * t;
  const px = -uz, pz = ux; // tünele dik
  const ry = Math.atan2(ux, uz);
  const w = TUNNEL_HALF - 0.45;
  // Maden kapısı: iki direk, üstte kalın kiriş, köşelerde payanda
  for (const s of [-1, 1]) {
    const x = fx + px * w * s, z = fz + pz * w * s;
    b.add(part(new THREE.BoxGeometry(0.4, 4.2, 0.4), TIMBER, mat(x, 2.1, z, ry), 0.1, b.rand));
    b.add(part(new THREE.BoxGeometry(0.22, 1.3, 0.22), TIMBER_DARK, mat(x - px * s * 0.45, 3.55, z - pz * s * 0.45, ry).multiply(new THREE.Matrix4().makeRotationZ(s * 0.75)), 0.1, b.rand));
    b.colliders.circle(x, z, 0.3);
    b.prop("flame", mat(x - ux * 0.5, 3.1, z - uz * 0.5, 0, 0.8));
  }
  b.add(part(new THREE.BoxGeometry(w * 2 + 1, 0.5, 0.5), TIMBER, mat(fx, 4.35, fz, ry), 0.1, b.rand));
  // Raylar: tünelin içine uzanan maden rayı
  for (const s of [-0.55, 0.55]) {
    const rl = 26;
    b.add(part(new THREE.BoxGeometry(0.08, 0.08, rl), "#5a5f66", mat(fx + px * s + ux * (rl / 2 - 3), 0.06, fz + pz * s + uz * (rl / 2 - 3), ry)));
  }
  for (let k = -3; k < 23; k += 1.2) {
    b.add(part(new THREE.BoxGeometry(1.6, 0.06, 0.22), TIMBER_DARK, mat(fx + ux * k, 0.03, fz + uz * k, ry), 0.1, b.rand));
  }
  b.clearSegment(TUNNEL[0][0], TUNNEL[0][1], TUNNEL[2][0], TUNNEL[2][1], TUNNEL_HALF + 1);

  // Tünel boyunca meşaleler (iki yanda, sırayla)
  for (let i = 0; i < TUNNEL.length - 1; i++) {
    const [sx, sz] = TUNNEL[i], [ex, ez] = TUNNEL[i + 1];
    const l = Math.hypot(ex - sx, ez - sz), dx = (ex - sx) / l, dz = (ez - sz) / l;
    for (let d = i ? 4 : t + 5, k = 0; d < l - 2; d += 7, k++) {
      const s = k % 2 ? 1 : -1;
      torch(b, sx + dx * d - dz * s * (TUNNEL_HALF - 0.7), sz + dz * d + dx * s * (TUNNEL_HALF - 0.7));
    }
  }

  // Mağara: duvar boyunca meşaleler (hücrenin ve tünel ağzının önü boş)
  const cellX = (JAIL.minX + JAIL.maxX) / 2;
  const [mx, mz] = TUNNEL[TUNNEL.length - 1];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = CAVE.x + Math.cos(a) * (CAVE.rx - 1.6), z = CAVE.z + Math.sin(a) * (CAVE.rz - 1.6);
    if (x < cellX + 6 || Math.hypot(x - mx, z - mz) < 6) continue;
    torch(b, x, z);
  }

  // Dikitler (yerden) ve kristal kümeleri: kenarlara yakın, yürüyüş alanını kapatmadan
  const crystal = ["#9b7bff", "#6fd3ff", "#c58bff"];
  for (let i = 0, n = 0; n < 22 && i < 400; i++) {
    const a = b.rand() * Math.PI * 2, r = 0.62 + b.rand() * 0.3;
    const x = CAVE.x + Math.cos(a) * CAVE.rx * r, z = CAVE.z + Math.sin(a) * CAVE.rz * r;
    if (x < cellX + 7 || Math.hypot(x - mx, z - mz) < 7) continue;
    const s = 0.6 + b.rand() * 0.9;
    if (n % 3 === 2) {
      for (let k = 0; k < 4; k++) {
        const g = new THREE.OctahedronGeometry(0.22 * s, 0);
        const m = mat(x + (b.rand() - 0.5) * 0.6, 0.25 * s + b.rand() * 0.2, z + (b.rand() - 0.5) * 0.6, b.rand() * 6, 1, 2.2, 1)
          .multiply(new THREE.Matrix4().makeRotationZ((b.rand() - 0.5) * 0.8));
        b.add(part(g, crystal[(n + k) % 3], m));
      }
      b.colliders.circle(x, z, 0.5 * s);
    } else {
      b.add(part(new THREE.ConeGeometry(0.45 * s, 2.2 * s, 6), n % 2 ? "#7a746a" : "#6a655c", mat(x, 1.1 * s, z, b.rand() * 6), 0.15, b.rand));
      b.colliders.circle(x, z, 0.4 * s);
    }
    n++;
  }
  // Mağaranın ortasında küçük su birikintisi
  b.add(part(new THREE.CircleGeometry(1.8, 12), "#3d5f78", mat(CAVE.x + 6, 0.02, CAVE.z + 3).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))));

  return { signAt: mat(fx - ux * 0.27, 4.35, fz - uz * 0.27, ry + Math.PI) };
}
