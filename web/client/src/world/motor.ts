// Scooter: kuryelik işinde verilen turkuaz GAP Kurye scooter'ı (arkasında "GAP KURYE" yazılı beyaz teslimat
// kutusu) ve GAP Galeri'den alınan kişisel scooter (kutusuz; boya, jant, neon, far rengi, egzoz ve plaka
// modifiyesiyle). Arabalarla aynı arayüz (TofasMesh): tekerlekler yuvarlanır, gidon döner, virajda gövde yatar,
// gece far ve stop yanar. Sürücü avatarı selede görünür (cars.ts).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CAR_COLORS, CAR_LIGHTS, CAR_NEONS, type CarSpec } from "../../../shared/car";
import { mat, part } from "./geo";
import { plateTexture, softTexture, type TofasMesh } from "./tofas";

const COURIER = "#1d9e75";
const DARK = "#0f6e56";
const BLACK = "#16181c";
const CHROME = "#c9ced4";
const WHEEL_R = 0.23;
/** Ön ve arka aks (merkezden). */
const FRONT_Z = 0.66;
const REAR_Z = -0.6;
/** Selenin yüksekliği (sürücü buraya oturur). */
export const MOTOR_SEAT_Y = 0.62;

function boxLabel(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4f6f5";
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = COURIER;
  g.fillRect(0, 196, 256, 60);
  g.fillStyle = COURIER;
  g.font = "900 92px system-ui, sans-serif";
  g.textAlign = "center";
  g.fillText("GAP", 128, 120);
  g.fillStyle = "#fff";
  g.font = "800 40px system-ui, sans-serif";
  g.fillText("KURYE", 128, 240);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Jant göbeğinin rengi. */
const RIM: Record<CarSpec["rim"], string> = { celik: CHROME, spor: "#8d949b", altin: "#d4a531", siyah: "#1b1c1f" };

export function buildMotor(spec: CarSpec): TofasMesh {
  // Kurye scooter'ı şirket renginde ve kutulu; kişisel scooter seçilen boyada
  const courier = spec.model === "motor";
  const paint = courier ? COURIER : (CAR_COLORS.find((c) => c.id === spec.color)?.hex ?? "#f1efe7");
  const trim = courier ? DARK : `#${new THREE.Color(paint).multiplyScalar(0.62).getHexString()}`;
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const add = (into: THREE.BufferGeometry[], g: THREE.BufferGeometry, color: string, m: THREE.Matrix4) => into.push(part(g, color, m));
  const box = (w: number, h: number, d: number, color: string, x: number, y: number, z: number, rx = 0) =>
    add(body, new THREE.BoxGeometry(w, h, d), color, mat(x, y, z).multiply(new THREE.Matrix4().makeRotationX(rx)));

  // Gövde: ayak tabanı, arka kaporta (sele altı), sele, ön kalkan ve bacak koruması
  box(0.34, 0.08, 0.72, trim, 0, 0.26, 0.05);
  box(0.4, 0.3, 0.62, paint, 0, 0.45, -0.38);
  add(body, new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1.45), paint, mat(0, 0.58, -0.4));
  box(0.32, 0.09, 0.56, BLACK, 0, MOTOR_SEAT_Y - 0.03, -0.3);
  box(0.4, 0.62, 0.1, paint, 0, 0.62, 0.47, -0.25);
  box(0.36, 0.16, 0.22, paint, 0, 0.32, 0.5);
  // Arka çamurluk ve egzoz (standart tek, çift çıkış iki yanda, spor kalın krom)
  box(0.16, 0.06, 0.32, trim, 0, 0.52, -0.82);
  const pipe = spec.exhaust === "spor" ? [0.055, 0.065, 0.48] : [0.035, 0.04, 0.42];
  for (const sx of spec.exhaust === "cift" ? [-1, 1] : [-1]) add(body, new THREE.CylinderGeometry(pipe[0], pipe[1], pipe[2], 10).rotateX(Math.PI / 2), CHROME, mat(sx * 0.17, 0.28, -0.6));
  // Arka taşıyıcı; kuryede teslimat kutusu
  box(0.36, 0.03, 0.34, BLACK, 0, 0.74, -0.68);
  if (courier) {
    box(0.46, 0.44, 0.44, "#f4f6f5", 0, 0.98, -0.7);
    box(0.47, 0.05, 0.45, paint, 0, 1.2, -0.7);
  }

  // Ön çatal ve gidon (direksiyonla döner)
  const steer = new THREE.Group();
  steer.position.set(0, 0, FRONT_Z);
  const fork: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) fork.push(part(new THREE.CylinderGeometry(0.02, 0.02, 0.62, 6), CHROME, mat(sx * 0.07, 0.48, -0.06).multiply(new THREE.Matrix4().makeRotationX(-0.28))));
  fork.push(part(new THREE.CylinderGeometry(0.018, 0.018, 0.62, 6).rotateZ(Math.PI / 2), BLACK, mat(0, 0.98, -0.2)));
  for (const sx of [-1, 1]) fork.push(part(new THREE.CylinderGeometry(0.028, 0.028, 0.1, 8).rotateZ(Math.PI / 2), BLACK, mat(sx * 0.3, 0.98, -0.2)));
  fork.push(part(new THREE.BoxGeometry(0.26, 0.12, 0.12), paint, mat(0, 0.93, -0.14)));
  // Ön çamurluk
  fork.push(part(new THREE.SphereGeometry(0.25, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.4).scale(0.6, 0.45, 1), paint, mat(0, 0.2, 0)));
  const forkMesh = new THREE.Mesh(mergeGeometries(fork), new THREE.MeshLambertMaterial({ vertexColors: true }));
  steer.add(forkMesh);

  // Tekerlekler
  const wheelGeo = mergeGeometries([
    part(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.11, 18).rotateZ(Math.PI / 2), BLACK),
    part(new THREE.CylinderGeometry(WHEEL_R * 0.55, WHEEL_R * 0.55, 0.12, 12).rotateZ(Math.PI / 2), RIM[spec.rim] ?? CHROME),
  ]);
  const wheelMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const front = new THREE.Mesh(wheelGeo, wheelMat);
  front.position.set(0, WHEEL_R, 0);
  steer.add(front);
  const rear = new THREE.Mesh(wheelGeo, wheelMat);
  rear.position.set(0, WHEEL_R, REAR_Z);

  // Far (camın rengi modifiyeden) ve stop
  const headHex = CAR_LIGHTS.find((l) => l.id === spec.lights)?.hex ?? "#fff6dc";
  const headMat = new THREE.MeshBasicMaterial({ color: headHex });
  const head = new THREE.Mesh(new THREE.CircleGeometry(0.07, 14), headMat);
  head.position.set(0, 0.93, -0.07);
  steer.add(head);
  add(glow, new THREE.BoxGeometry(0.16, 0.05, 0.02), "#b3121c", mat(0, 0.56, -0.99));
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const glowMesh = new THREE.Mesh(mergeGeometries(glow), glowMat);

  const lean = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const bodyMesh = new THREE.Mesh(mergeGeometries(body), bodyMat);
  bodyMesh.castShadow = forkMesh.castShadow = true;
  // Kuryede kutunun yazısı (arkada ve iki yanda); arka çamurlukta plaka
  const label = courier ? boxLabel() : null;
  const labelMat = new THREE.MeshLambertMaterial({ map: label });
  const decals: THREE.Mesh[] = [];
  if (courier) {
    for (const [x, z, ry] of [[0, -0.925, Math.PI], [0.233, -0.7, Math.PI / 2], [-0.233, -0.7, -Math.PI / 2]] as const) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), labelMat);
      p.position.set(x, 0.98, z);
      p.rotation.y = ry;
      decals.push(p);
    }
  }
  const plateTex = plateTexture(spec.plate);
  const plateMat = new THREE.MeshLambertMaterial({ map: plateTex });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.057), plateMat);
  plate.position.set(0, 0.44, -1.0);
  plate.rotation.set(-0.15, Math.PI, 0);
  decals.push(plate);
  lean.add(bodyMesh, glowMesh, steer, rear, ...decals);
  const group = new THREE.Group();
  group.add(lean);

  // Gölge
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }));
  shadow.position.y = 0.05;
  group.add(shadow);

  // Neon: yere vuran yumuşak hâle (siyah neon koyu hâle) ve tabanın altında tüp
  const neonHex = CAR_NEONS.find((n) => n.id === spec.neon)?.hex;
  const darkNeon = spec.neon === "siyah";
  const neonMat = neonHex
    ? new THREE.MeshBasicMaterial({ color: neonHex, map: softTexture("glow"), transparent: true, blending: darkNeon ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 })
    : null;
  const neonGeo = new THREE.PlaneGeometry(1.5, 2.6).rotateX(-Math.PI / 2);
  if (neonMat) {
    const halo = new THREE.Mesh(neonGeo, neonMat);
    halo.position.y = 0.07;
    halo.renderOrder = 2;
    group.add(halo);
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.66, 6).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: neonHex }));
    tube.position.set(0, 0.2, 0.05);
    lean.add(tube);
  }

  const headColor = new THREE.Color(headHex);
  const disposables: { dispose(): void }[] = [bodyMesh.geometry, bodyMat, forkMesh.geometry, forkMesh.material as THREE.Material, wheelGeo, wheelMat, headMat, head.geometry, glowMesh.geometry, glowMat, labelMat, plateTex, plateMat, neonGeo, shadow.geometry, shadow.material as THREE.Material, ...decals.map((d) => d.geometry)];
  if (label) disposables.push(label);
  if (neonMat) disposables.push(neonMat);
  let spin = 0;
  return {
    group,
    headColor,
    setNight(n) {
      if (neonMat) neonMat.opacity = darkNeon ? 0.4 : 0.4 + 0.5 * n;
    },
    setHeadlights(n) {
      headMat.color.set(headHex).multiplyScalar(0.62 + 0.38 * n);
    },
    setBrake(on) {
      glowMat.color.setScalar(on ? 1.6 : 1);
    },
    // İki tekerlekte viraj: gövde içe yatar (arabadan çok daha fazla)
    setLean(roll, pitch) {
      lean.rotation.z = -roll * 4;
      lean.rotation.x = pitch * 0.6;
    },
    roll(dist, steerA) {
      spin += dist / WHEEL_R;
      front.rotation.x = rear.rotation.x = spin;
      steer.rotation.y = steerA * 0.8;
    },
    setDamage() {},
    setDents() {},
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
