// Sinema sahnesi: DJ kabini (statik), sahne üstünde ışık kirişi ve hareketli spotlar (ışık şovu), karaoke için
// sahnedeki şarkıcıyı izleyen takip spotu ve mikrofon sehpası. Işık konileri toplamalı, tek draw call.
import * as THREE from "three";
import { DJ_BOOTH, STAGE } from "../../../shared/zones";
import type { Builder } from "./builder";
import { mat, part } from "./geo";

const MOVERS = 8;
const TRUSS_Y = 8.6;
const TRUSS_Z = STAGE.z + 0.4;

export function djBooth(b: Builder): void {
  const { x, z } = DJ_BOOTH;
  // Kürsü, iki pikap, mikser, önde neon şerit (gece parlar: ampul malzemesi)
  b.add(part(new THREE.BoxGeometry(2.6, 0.25, 1.8), "#2a2d36", mat(x, 0.12, z)));
  b.add(part(new THREE.BoxGeometry(1.9, 1.0, 0.7), "#1b1d24", mat(x, 0.75, z - 0.3)));
  b.add(part(new THREE.BoxGeometry(2.0, 0.06, 0.8), "#30343f", mat(x, 1.28, z - 0.3)));
  for (const sx of [-0.55, 0.55]) {
    b.add(part(new THREE.CylinderGeometry(0.24, 0.24, 0.03, 18), "#0e0f12", mat(x + sx, 1.33, z - 0.3)));
    b.add(part(new THREE.CylinderGeometry(0.05, 0.05, 0.035, 8), "#c62f2f", mat(x + sx, 1.35, z - 0.3)));
  }
  b.add(part(new THREE.BoxGeometry(0.4, 0.06, 0.45), "#3b4050", mat(x, 1.34, z - 0.3)));
  b.prop("bulb", mat(x - 0.7, 0.5, z + 0.06, 0, 0.25));
  b.prop("bulb", mat(x, 0.5, z + 0.06, 0, 0.25));
  b.prop("bulb", mat(x + 0.7, 0.5, z + 0.06, 0, 0.25));
  // Yanlarda hoparlör kuleleri
  for (const sx of [-1.6, 1.6]) {
    b.add(part(new THREE.BoxGeometry(0.7, 1.8, 0.6), "#20232b", mat(x + sx, 0.9, z - 0.4)));
    b.add(part(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 14).rotateX(Math.PI / 2), "#3a3e48", mat(x + sx, 1.3, z - 0.08)));
    b.add(part(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 12).rotateX(Math.PI / 2), "#3a3e48", mat(x + sx, 0.65, z - 0.08)));
  }
  b.colliders.segment(x - 2, z - 0.4, x + 2, z - 0.4, 0.55);
}

export function stageTruss(b: Builder): void {
  // Sahnenin iki ucunda direk, üstte kiriş; mikrofon sehpası
  for (const sx of [-1, 1]) {
    b.add(part(new THREE.BoxGeometry(0.3, TRUSS_Y, 0.3), "#3a3f4c", mat(sx * (STAGE.hw - 0.4), TRUSS_Y / 2, TRUSS_Z)));
  }
  b.add(part(new THREE.BoxGeometry(STAGE.hw * 2 - 0.5, 0.35, 0.35), "#3a3f4c", mat(0, TRUSS_Y, TRUSS_Z)));
  b.add(part(new THREE.CylinderGeometry(0.02, 0.02, 1.3, 6), "#202228", mat(0, STAGE.h + 0.65, STAGE.z + 1.9)));
  b.add(part(new THREE.CylinderGeometry(0.18, 0.2, 0.03, 10), "#202228", mat(0, STAGE.h + 0.02, STAGE.z + 1.9)));
  b.add(part(new THREE.SphereGeometry(0.06, 8, 6), "#555a66", mat(0, STAGE.h + 1.35, STAGE.z + 1.9)));
}

export interface StageLights {
  group: THREE.Group;
  /** `show` 0 kapalı; `singer` sahnedeki (yoksa null); `level` müzik (0–1); `night` 0–1. */
  update(time: number, show: number, singer: { x: number; z: number } | null, level: number, night: number): void;
}

/** Işık konisi: tepeden aşağı yumuşak kenarlı, uca doğru solan; renk örnek başına. */
function coneMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      varying float vH;
      varying vec3 vColor;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vH = uv.y;
        vColor = aColor;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying float vH;
      varying vec3 vColor;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        // Kenarlara doğru (bakışa dik yüzeyler) incelir: hacimli ışık hüzmesi hissi
        float rim = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
        float a = rim * pow(vH, 1.6) * uOpacity;
        gl_FragColor = vec4(vColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

const SHOW_COLORS: THREE.Color[][] = [
  [],
  ["#ff3b6b", "#ffb43b", "#3bff8a", "#3bb6ff", "#b43bff", "#ff3bd2"].map((c) => new THREE.Color(c)),
  ["#ffd27a", "#ffb35a", "#fff2c8"].map((c) => new THREE.Color(c)),
  ["#4a5bff", "#9a3bff", "#2ad8ff"].map((c) => new THREE.Color(c)),
];

export function stageLights(): StageLights {
  const group = new THREE.Group();
  // Uzunluk 1, tepe (uv.y = 1) yukarıda: ölçekle uzatılır
  const geo = new THREE.ConeGeometry(1, 1, 18, 1, true).translate(0, -0.5, 0);
  const mat = coneMaterial();
  const cones = new THREE.InstancedMesh(geo, mat, MOVERS + 1);
  cones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const colors = new Float32Array((MOVERS + 1) * 3);
  geo.setAttribute("aColor", new THREE.InstancedBufferAttribute(colors, 3));
  cones.frustumCulled = false;
  cones.renderOrder = 6;
  group.add(cones);
  // Zemine düşen ışık lekeleri (toplamalı daireler)
  const spotGeo = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
  const spotMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: false, color: "#ffffff" });
  const spots = new THREE.InstancedMesh(spotGeo, spotMat, MOVERS + 1);
  spots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  spots.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array((MOVERS + 1) * 3), 3);
  spots.frustumCulled = false;
  spots.renderOrder = 5;
  group.add(spots);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), from = new THREE.Vector3(), to = new THREE.Vector3(), dir = new THREE.Vector3();
  const down = new THREE.Vector3(0, -1, 0), s = new THREE.Vector3(), c = new THREE.Color();
  let fade = 0;

  const place = (i: number, fx: number, fy: number, fz: number, tx: number, tz: number, radius: number, color: THREE.Color, k: number) => {
    from.set(fx, fy, fz);
    to.set(tx, 0.05, tz);
    dir.subVectors(to, from);
    const len = dir.length();
    q.setFromUnitVectors(down, dir.normalize());
    m.compose(from, q, s.set(radius, len, radius));
    cones.setMatrixAt(i, m);
    c.copy(color).multiplyScalar(k);
    c.toArray(colors, i * 3);
    m.compose(to, q.identity(), s.set(radius * 1.05, 1, radius * 1.05));
    spots.setMatrixAt(i, m);
    spots.setColorAt(i, c.multiplyScalar(0.35));
  };

  return {
    group,
    update(time, show, singer, level, night) {
      const target = show || singer ? 1 : 0;
      fade += (target - fade) * 0.08;
      group.visible = fade > 0.01;
      if (!group.visible) return;
      // Gündüz ışıklar zor görünür: gece daha parlak
      mat.uniforms.uOpacity.value = fade * (0.18 + 0.5 * night);
      spotMat.opacity = fade * (0.25 + 0.5 * night);
      const beat = Math.pow(1 - ((time * 2) % 1), 2) * level;
      const palette = SHOW_COLORS[show] ?? SHOW_COLORS[1];
      for (let i = 0; i < MOVERS; i++) {
        const fx = -STAGE.hw + 1.5 + (i / (MOVERS - 1)) * (STAGE.hw * 2 - 3);
        if (!show) {
          place(i, fx, TRUSS_Y - 0.2, TRUSS_Z, fx, TRUSS_Z, 0.0001, palette[0] ?? c.set(0), 0);
          continue;
        }
        // Şova göre tarama: 1 gökkuşağı geniş salınım, 2 sıcak ritimli, 3 dar lazer çaprazları
        const ph = time * (show === 3 ? 1.6 : 0.7) + i * 0.8;
        const reach = show === 3 ? 22 : 16;
        const tx = fx * 0.6 + Math.sin(ph) * (show === 2 ? 4 : 9);
        const tz = STAGE.z + 6 + (0.5 + 0.5 * Math.sin(ph * 0.7 + i)) * reach;
        const radius = show === 3 ? 0.35 : show === 2 ? 1.6 + beat : 1.2;
        const color = palette[(i + Math.floor(time * (show === 1 ? 1 : 0.5))) % palette.length];
        place(i, fx, TRUSS_Y - 0.2, TRUSS_Z, tx, tz, radius, color, 0.6 + beat * 0.8);
      }
      // Takip spotu: şarkıcının üstünde beyaz
      if (singer) place(MOVERS, singer.x, TRUSS_Y - 0.2, TRUSS_Z, singer.x, singer.z, 1.1, c.set("#fff6e0"), 1.4);
      else place(MOVERS, 0, TRUSS_Y, TRUSS_Z, 0, TRUSS_Z, 0.0001, c.set(0), 0);
      cones.instanceMatrix.needsUpdate = true;
      (geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
      spots.instanceMatrix.needsUpdate = true;
      spots.instanceColor!.needsUpdate = true;
    },
  };
}
