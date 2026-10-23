// Statik dünyayı karolara böler: her parça (uzun yol şeritleri üçgen üçgen) bulunduğu 96 m'lik karoya düşer,
// karo başına tek mesh. Tek parça dünya (yüz binlerce üçgen, 850 m yarıçap) hem ana çizimde hem gölge
// geçişinde her kare bütünüyle işleniyordu; karolarda kameranın görmediği ve gölge kutusunun dışındaki
// karolar atlanır. Normal 8 bit, renk 16 bit: köşe verisi ~%40 az. (Aynı köşeleri birleştirmek açılışa ~1 sn
// ekliyordu; karo elemesi asıl kazancı zaten verdiği için yapılmıyor.)
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const TILE = 96;

/** Normal Int8, renk Uint16 (normalize): ışık ve renk aynı, bellek ve bant genişliği az. */
function compact(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = geo.getAttribute("normal"), c = geo.getAttribute("color");
  if (n) {
    const a = new Int8Array(n.count * 3);
    for (let i = 0; i < n.count * 3; i++) a[i] = Math.round(Math.max(-1, Math.min(1, n.array[i])) * 127);
    geo.setAttribute("normal", new THREE.BufferAttribute(a, 3, true));
  }
  if (c) {
    const a = new Uint16Array(c.count * 3);
    for (let i = 0; i < c.count * 3; i++) a[i] = Math.round(Math.max(0, Math.min(1, c.array[i])) * 65535);
    geo.setAttribute("color", new THREE.BufferAttribute(a, 3, true));
  }
  return geo;
}

/** Üçgenleri ağırlık merkezlerinin karosuna göre ayırır (indekssiz geometri). */
function splitByTile(geo: THREE.BufferGeometry, into: Map<string, THREE.BufferGeometry[]>): void {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const names = Object.keys(g.attributes);
  const pos = g.getAttribute("position");
  const tris = new Map<string, number[]>();
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3, cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const key = `${Math.floor(cx / TILE)},${Math.floor(cz / TILE)}`;
    let list = tris.get(key);
    if (!list) tris.set(key, (list = []));
    list.push(t);
  }
  for (const [key, list] of tris) {
    const part = new THREE.BufferGeometry();
    for (const name of names) {
      const src = g.getAttribute(name) as THREE.BufferAttribute, size = src.itemSize;
      const arr = new (src.array.constructor as Float32ArrayConstructor)(list.length * 3 * size);
      let o = 0;
      for (const t of list) for (let k = 0; k < 3 * size; k++) arr[o++] = src.array[t * size + k];
      part.setAttribute(name, new THREE.BufferAttribute(arr, size, src.normalized));
    }
    let bucket = into.get(key);
    if (!bucket) into.set(key, (bucket = []));
    bucket.push(part);
  }
}

/** Statik parçalardan karo mesh'leri (aynı malzeme). */
export function tiledStatics(geos: THREE.BufferGeometry[], material: THREE.Material): THREE.Group {
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  const box = new THREE.Box3(), c = new THREE.Vector3();
  for (const geo of geos) {
    geo.computeBoundingBox();
    box.copy(geo.boundingBox!);
    // Karodan büyük parça (yol şeridi, uzun duvar) üçgen üçgen dağıtılır
    if (box.max.x - box.min.x > TILE / 2 || box.max.z - box.min.z > TILE / 2) {
      splitByTile(geo, buckets);
      continue;
    }
    box.getCenter(c);
    const key = `${Math.floor(c.x / TILE)},${Math.floor(c.z / TILE)}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = []));
    bucket.push(geo.index ? geo.toNonIndexed() : geo);
  }
  const group = new THREE.Group();
  for (const [key, list] of [...buckets].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const merged = mergeGeometries(list);
    if (!merged) continue;
    const geo = compact(merged);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `karo ${key}`;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
