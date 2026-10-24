// Paintball silahı (marker): gövde, uzun namlu, üstte top haznesi (hopper), arkada hava tüpü, kabza ve ön tutamak.
// Namlu −z'ye bakar; orijin tetiğin üstü (sağ elin tuttuğu yer). Skin renkleri vertex rengi; desenli skinlerde
// (kamuflaj, karbon) gövde üçgenleri paletten rastgele boyanır, parlayan skinlerde vurgu parçaları ayrı ve ışıklı.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { type GunSkin } from "../../../shared/paintball";
import { part, rng } from "./geo";

/** Namlunun ucu (yerel): top buradan çıkar. */
export const MUZZLE = new THREE.Vector3(0, 0.03, -0.56);

const m4 = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));

/** Üçgen başına paletten renk (kamuflaj lekeleri). */
function patterned(geo: THREE.BufferGeometry, palette: string[], m: THREE.Matrix4, rand: () => number): THREE.BufferGeometry {
  const g = part(geo, palette[0], m);
  const col = g.attributes.color as THREE.BufferAttribute;
  const c = new THREE.Color();
  for (let i = 0; i < col.count; i += 3) {
    c.set(palette[Math.floor(rand() * palette.length)]);
    for (let v = 0; v < 3; v++) col.setXYZ(i + v, c.r, c.g, c.b);
  }
  return g;
}

export interface MarkerGeo {
  /** Gövde ve diğer parçalar (vertex renkli). */
  base: THREE.BufferGeometry;
  /** Vurgu parçaları: parlayan skinlerde ışıklı malzemeyle çizilir. */
  accent: THREE.BufferGeometry;
}

export function markerGeometry(skin: GunSkin): MarkerGeo {
  const rand = rng(0x9b1);
  const body = (geo: THREE.BufferGeometry, m: THREE.Matrix4) => (skin.pattern ? patterned(geo, skin.pattern, m, rand) : part(geo, skin.body, m));
  const base: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];
  const dark = "#1b1c1f";
  // Gövde (receiver) ve üst ray
  base.push(body(new THREE.BoxGeometry(0.072, 0.105, 0.3), m4(0, 0.012, -0.06)));
  base.push(body(new THREE.BoxGeometry(0.06, 0.03, 0.22), m4(0, 0.072, -0.08)));
  // Namlu: iki parça, ucunda halka
  base.push(part(new THREE.CylinderGeometry(0.021, 0.021, 0.2, 10), dark, m4(0, 0.03, -0.3, Math.PI / 2)));
  base.push(part(new THREE.CylinderGeometry(0.019, 0.017, 0.16, 10), skin.accent, m4(0, 0.03, -0.47, Math.PI / 2)));
  accent.push(part(new THREE.CylinderGeometry(0.026, 0.026, 0.026, 12), skin.accent, m4(0, 0.03, -0.545, Math.PI / 2)));
  // Hopper: boynu ve yumurta biçimli hazne
  base.push(part(new THREE.CylinderGeometry(0.022, 0.026, 0.07, 8), dark, m4(0, 0.1, -0.1)));
  const hop = new THREE.SphereGeometry(0.1, 12, 8);
  hop.scale(0.82, 0.68, 1.25);
  base.push(part(hop, skin.hopper, m4(0, 0.18, -0.06)));
  accent.push(part(new THREE.BoxGeometry(0.11, 0.022, 0.07), skin.accent, m4(0, 0.235, -0.13, -0.25)));
  // Yanlarda vurgu çizgisi
  for (const s of [-1, 1]) accent.push(part(new THREE.BoxGeometry(0.004, 0.02, 0.2), skin.accent, m4(s * 0.037, 0.02, -0.07)));
  // Kabza (geriye eğik) ve tetik korkuluğu
  base.push(part(new THREE.BoxGeometry(0.05, 0.14, 0.06), dark, m4(0, -0.1, 0.045, 0.28)));
  base.push(part(new THREE.BoxGeometry(0.014, 0.012, 0.075), dark, m4(0, -0.068, -0.025)));
  base.push(part(new THREE.BoxGeometry(0.008, 0.035, 0.008), skin.accent, m4(0, -0.05, -0.01, 0.3)));
  // Ön tutamak
  base.push(body(new THREE.BoxGeometry(0.045, 0.1, 0.055), m4(0, -0.085, -0.17, -0.1)));
  // Hava tüpü: kabzanın arkasından geriye, ucunda regülatör
  base.push(part(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 12), skin.tank, m4(0, -0.04, 0.2, Math.PI / 2)));
  base.push(part(new THREE.SphereGeometry(0.045, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), skin.tank, m4(0, -0.04, 0.31, Math.PI / 2)));
  accent.push(part(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 10), skin.accent, m4(0, -0.04, 0.075, Math.PI / 2)));
  return { base: mergeGeometries(base)!, accent: mergeGeometries(accent)! };
}

const cache = new Map<string, MarkerGeo>();

/** Skin başına bir kez kurulur (dünyadaki silahlar ve elindeki aynı geometriyi paylaşır). */
export function markerGeo(skin: GunSkin): MarkerGeo {
  let g = cache.get(skin.id);
  if (!g) cache.set(skin.id, (g = markerGeometry(skin)));
  return g;
}

/** Silah: iki mesh (gövde + vurgu); `fog` false ise birinci şahıs görünümü (sis ve ışık lekesi yok). */
export function markerMesh(skin: GunSkin, opts: { fog?: boolean } = {}): THREE.Group {
  const g = markerGeo(skin);
  const fog = opts.fog ?? true;
  const baseMat = new THREE.MeshLambertMaterial({ vertexColors: true, fog });
  const accMat = new THREE.MeshLambertMaterial({ vertexColors: true, fog, emissive: skin.glow ? skin.accent : "#000000", emissiveIntensity: skin.glow ?? 0 });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(g.base, baseMat), new THREE.Mesh(g.accent, accMat));
  group.userData.skin = skin.id;
  return group;
}
