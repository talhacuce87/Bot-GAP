// Örtme elemesi (Frostbite'ın yazılım örtmesi gibi): her kare büyük bina kutuları (örtücüler) CPU'da küçük bir
// derinlik tamponuna (96 × ~54) çizilir; karolar ve prop bölgeleri (ve kalabalığın örnekleri) kutularının bu
// tamponda tamamen arkada kaldığı karede çizilmez. Dükkân içleri kapı/vitrin yüzünden (portal) görünür:
// kamera içeride değilse ve cephenin önünde durmuyorsa ya da cephe örtülüyse çizilmez.
//
// Tutucu (yanlışlıkla gizlemez): örtücüler binaların içine sığan kutular; tampon pikseli yalnızca dört köşe
// ışını aynı kutuya çarpıyorsa (pikselin tamamı kutunun içinde: kutunun izdüşümü dışbükey) örtülü sayılır ve
// derinliği köşelerin en uzağıdır (kutuya giriş derinliği bir yüz üzerinde 1/z ile doğrusal: en büyüğü
// köşelerde). Hedefin kutusunun en yakın köşesi bile bu derinliklerin arkasındaysa hedef görünmez.
// Kamera her kare bakılır (önceden hesaplanmış görünürlük tablosu yok): üçüncü şahıs kamerası binanın üstünde
// ya da yanında da doğru; açılışta yalnızca hedeflerin kutuları çıkarılır (~20–40 ms).
//
// Gizlenen mesh ana geçişte atlanır ama gölge haritasına girer (ekran dışındaki binanın gölgesi görünen yere
// düşebilir): katman maskesi sıfırlanır (render listesi kurulurken atlanır), gölge geçişi başlarken geri açılır.
import * as THREE from "three";

/** Örtücü kutu (eksene hizalı). `hull`: içi boş dükkân katı (camdan içi görünür): kendisiyle kesişen hedefi örtmez. */
export interface OccluderBox {
  min: [number, number, number];
  max: [number, number, number];
  hull?: boolean;
  /**
   * Kamera bu kutunun (dükkân katının) içindeyse örtmez: katın üstündeki kule kutusu yere kadar iner (birleşim
   * yerinde örtülmemiş piksel şeridi kalmasın), içeriden bakınca o kısım havadır ve vitrinden dışarısı görünür.
   */
  room?: { min: [number, number, number]; max: [number, number, number] };
  /** Verilirse yalnızca doğru döndüğü karelerde örter (ör. casinonun duvarları saydamken değil). */
  active?: () => boolean;
}

/** Dükkânın içi yalnızca ön cepheden görünür: oda kutusu ve cephe dikdörtgeni (dış yüzde). */
export interface Portal {
  /** Kamera bunun içindeyse iç mekân hep çizilir. */
  room: THREE.Box3;
  /** Cephe (vitrin ve kapı dahil bütün yüz): ince kutu. */
  face: THREE.Box3;
  /** Cephenin dışa bakan normali (x ya da z ekseni) ve düzlemdeki bir nokta. */
  nx: number;
  nz: number;
  px: number;
  pz: number;
  /** Doğru döndüğü karelerde hep görünür (ör. casinonun duvarları saydamken). */
  open?: () => boolean;
}

interface Target {
  obj: THREE.Object3D;
  box: THREE.Box3;
  /** Kutunun çevrel küresi (ucuz görüş konisi testi için). */
  sphere: THREE.Sphere;
  /** Bir dükkân katıyla kesişiyor: o kat örtücüsünün içi boş, bu hedef örtme testine girmez. */
  skip: boolean;
  portal: Portal | null;
}

const W = 96;
/** Kamera kutuya bu kadar yakınsa (yakın düzlem) kutu örtücü sayılmaz. */
const NEAR_PAD = 0.3;
/** Hedef kutuları büyütülür: rüzgârda sallanan ağaç tepeleri (8 m ağaçta ~0.5 m) dışarı taşmasın. */
const PAD = 1;

export class Occlusion {
  enabled = true;
  /** Son karenin sayıları (debug). */
  readonly stats = { occluders: 0, tested: 0, hidden: 0, ms: 0 };
  private readonly occ: Float32Array;
  /** Örtücünün `room` kutusu (yoksa boş kutu: içinde olunamaz). */
  private readonly occRoom: Float32Array;
  private readonly occActive: ((() => boolean) | undefined)[];
  private readonly hulls: THREE.Box3[] = [];
  private readonly targets: Target[] = [];
  private hiddenList: THREE.Object3D[] = [];
  /**
   * Her karenin tamponu hazır olunca çağrılır: örnek örnek elenen hareketli şeyler (kalabalık) buradan
   * `sphereVisible` ile görünmeyen örneklerini o karelik çıkarır.
   */
  readonly dynamic: (() => void)[] = [];
  private h = 72;
  private readonly order: number[];
  private readonly dist: Float32Array;
  private raysReady = false;
  /** Yazılan piksellerin sınır dikdörtgeni (i0, i1, j0, j1): dışına taşan hedef örtülü olamaz. */
  private readonly cov = new Int32Array(4);
  /** Piksel köşelerinden geçen ışınların ters yönleri (dünya uzayı; ileri bileşeni 1: t = görüş derinliği). */
  private readonly ix = new Float32Array((W + 1) * 129);
  private readonly iy = new Float32Array((W + 1) * 129);
  private readonly iz = new Float32Array((W + 1) * 129);
  private readonly corner = new Float32Array((W + 1) * 129);
  private readonly depth = new Float32Array(W * 128);
  // Kare başına kamera
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private readonly r = new THREE.Vector3();
  private readonly u = new THREE.Vector3();
  private readonly f = new THREE.Vector3();
  private tanH = 1;
  private tanV = 1;
  private secH = 1;
  private secV = 1;
  private near = 0.1;

  constructor(occluders: OccluderBox[]) {
    this.occ = new Float32Array(occluders.length * 6);
    this.occRoom = new Float32Array(occluders.length * 6);
    this.occActive = occluders.map((o) => o.active);
    this.order = occluders.map((_, i) => i);
    this.dist = new Float32Array(occluders.length);
    occluders.forEach((o, i) => {
      this.occ.set([...o.min, ...o.max], i * 6);
      const g = NEAR_PAD;
      this.occRoom.set(o.room ? [...o.room.min.map((v) => v - g), ...o.room.max.map((v) => v + g)] : [0, 0, 0, -1, -1, -1], i * 6);
      if (o.hull) this.hulls.push(new THREE.Box3(new THREE.Vector3(...o.min), new THREE.Vector3(...o.max)));
    });
  }

  /** Mesh'in (ya da örnekli mesh'in) dünya kutusunu hedef olarak ekler. Statik olmalı. */
  add(obj: THREE.Object3D, portal: Portal | null = null): void {
    const inst = obj as THREE.InstancedMesh;
    const mesh = obj as THREE.Mesh;
    let box: THREE.Box3;
    if (inst.isInstancedMesh) {
      if (!inst.boundingBox) inst.computeBoundingBox();
      box = inst.boundingBox!.clone();
    } else {
      box = mesh.geometry.boundingBox?.clone() ?? positionBox(mesh.geometry);
    }
    obj.updateWorldMatrix(true, false);
    box.applyMatrix4(obj.matrixWorld).expandByScalar(PAD);
    const skip = !portal && this.hulls.some((h) => h.intersectsBox(box));
    this.targets.push({ obj, box, sphere: box.getBoundingSphere(new THREE.Sphere()), skip, portal });
  }

  /** Gizlenenleri geri açar: gölge geçişinin başında (ışık kamerası ana kameranın arkasını da görür). */
  restore(): void {
    for (const o of this.hiddenList) o.layers.mask = 1;
    this.hiddenList.length = 0;
  }

  /**
   * Kare başına, çizimden hemen önce (kamera son konumunda). `far`: sisin tam olduğu derinlik; ötesindeki
   * örtücüler çizilmez (arkalarındakiler zaten sisin içinde).
   */
  cull(camera: THREE.PerspectiveCamera, far = Infinity): void {
    const t0 = performance.now();
    this.restore();
    const s = this.stats;
    s.occluders = s.tested = s.hidden = s.ms = 0;
    if (!this.enabled) return;
    this.setup(camera);
    this.raysReady = false;
    this.cov.set([W, 0, this.h, 0]);
    const o = this.occ, rm = this.occRoom, { cx, cy, cz } = this, order = this.order, dist = this.dist;
    // Yakından uzağa: arkadaki örtücü öndekilerin arkasında kalmışsa çizilmez
    for (let i = 0, n = order.length; i < n; i++) {
      const q = i * 6;
      dist[i] = Math.hypot(Math.max(o[q] - cx, 0, cx - o[q + 3]), Math.max(o[q + 1] - cy, 0, cy - o[q + 4]), Math.max(o[q + 2] - cz, 0, cz - o[q + 5]));
    }
    order.sort((a, b) => dist[a] - dist[b]);
    for (const i of order) {
      const act = this.occActive[i];
      if (act && !act()) continue;
      const q = i * 6;
      if (cx > rm[q] && cx < rm[q + 3] && cy > rm[q + 1] && cy < rm[q + 4] && cz > rm[q + 2] && cz < rm[q + 5]) continue;
      if (this.raster(o[i * 6], o[i * 6 + 1], o[i * 6 + 2], o[i * 6 + 3], o[i * 6 + 4], o[i * 6 + 5], far)) s.occluders++;
    }
    // Hiçbir örtücü görünmüyorsa (şehrin dışı) yalnızca portallar (arkadan bakınca içerisi görünmez)
    this.cullTargets(s.occluders === 0);
    for (const f of this.dynamic) f();
    s.ms = performance.now() - t0;
  }

  private cullTargets(portalsOnly: boolean): void {
    const s = this.stats;
    for (const t of this.targets) {
      if (t.skip || (portalsOnly && !t.portal) || !t.obj.visible || !t.obj.parent?.visible || !this.inCone(t.sphere)) continue;
      s.tested++;
      if (t.portal ? this.portalVisible(t.portal) : this.test(t.box) !== HIDDEN) continue;
      t.obj.layers.mask = 0;
      this.hiddenList.push(t.obj);
      s.hidden++;
    }
  }

  /** Küre (yaklaşık; kutusu test edilir) bu kare görünebilir mi: görüş konisinde ve örtülmemiş. */
  sphereVisible(x: number, y: number, z: number, r: number): boolean {
    if (!this.enabled) return true;
    _sphere.center.set(x, y, z);
    _sphere.radius = r;
    if (!this.inCone(_sphere)) return false;
    if (!this.stats.occluders) return true;
    _box.min.set(x - r, y - r, z - r);
    _box.max.set(x + r, y + r, z + r);
    return this.test(_box) !== HIDDEN;
  }

  /** Kamera tabanı ve piksel köşesi ışınları. */
  private setup(camera: THREE.PerspectiveCamera): void {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
    this.cx = e[12];
    this.cy = e[13];
    this.cz = e[14];
    this.r.set(e[0], e[1], e[2]).normalize();
    this.u.set(e[4], e[5], e[6]).normalize();
    this.f.set(-e[8], -e[9], -e[10]).normalize();
    this.tanH = 1 / p[0];
    this.tanV = 1 / p[5];
    this.secH = Math.hypot(1, this.tanH);
    this.secV = Math.hypot(1, this.tanV);
    this.near = camera.near;
    this.h = Math.max(32, Math.min(128, Math.round((W * this.tanV) / this.tanH)));
  }

  /** Küre görüş konisinde mi (dört yan düzlem ve yakın düzlem; dışındakileri zaten three eler). */
  private inCone(sp: THREE.Sphere): boolean {
    const x = sp.center.x - this.cx, y = sp.center.y - this.cy, z = sp.center.z - this.cz, rad = sp.radius;
    const d = x * this.f.x + y * this.f.y + z * this.f.z;
    if (d + rad < this.near) return false;
    const sx = x * this.r.x + y * this.r.y + z * this.r.z, sy = x * this.u.x + y * this.u.y + z * this.u.z;
    // Yan düzlemlerin birim normalleriyle uzaklık: (±sx − d·tan) / √(1 + tan²)
    return Math.abs(sx) - d * this.tanH < rad * this.secH && Math.abs(sy) - d * this.tanV < rad * this.secV;
  }

  /** Piksel köşesi ışınları ve boş tampon: ilk örtücü ekrana düştüğünde (şehrin dışında hiç gerekmez). */
  private rays(): void {
    this.raysReady = true;
    this.depth.fill(Infinity, 0, W * this.h);
    const { r, u, f } = this;
    for (let j = 0, k = 0; j <= this.h; j++) {
      const sy = (1 - (2 * j) / this.h) * this.tanV;
      for (let i = 0; i <= W; i++, k++) {
        const sx = ((2 * i) / W - 1) * this.tanH;
        this.ix[k] = inv(f.x + r.x * sx + u.x * sy);
        this.iy[k] = inv(f.y + r.y * sx + u.y * sy);
        this.iz[k] = inv(f.z + r.z * sx + u.z * sy);
      }
    }
  }

  /**
   * Kutunun izdüşümü (tampon pikseli cinsinden). Yakın düzlemi kesiyorsa `cut`: dikdörtgen kutunun düzlemin
   * önündeki parçasınınki (kenarlar düzlemde kırpılır); hepsi arkadaysa `behind`.
   */
  private project(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Rect {
    const { r, u, f, near } = this;
    let back = 0, minZ = Infinity, maxZ = -Infinity;
    for (let c = 0; c < 8; c++) {
      const x = (c & 1 ? x1 : x0) - this.cx, y = (c & 2 ? y1 : y0) - this.cy, z = (c & 4 ? z1 : z0) - this.cz;
      const d = x * f.x + y * f.y + z * f.z;
      _vx[c] = x * r.x + y * r.y + z * r.z;
      _vy[c] = x * u.x + y * u.y + z * u.z;
      _vd[c] = d;
      if (d < near) back++;
      if (d < minZ) minZ = d;
      if (d > maxZ) maxZ = d;
    }
    _rect.near = minZ;
    _rect.far = maxZ;
    _rect.cut = back > 0;
    _rect.behind = back === 8;
    _b[0] = _b[2] = Infinity;
    _b[1] = _b[3] = -Infinity;
    for (let c = 0; c < 8; c++) {
      if (_vd[c] >= near) grow(_vx[c], _vy[c], _vd[c], this.tanH, this.tanV);
      else if (back < 8) {
        // Düzlemin önündeki komşu köşeye giden kenar düzlemi keser: kesişme noktası
        for (let bit = 1; bit < 8; bit <<= 1) {
          const n = c ^ bit;
          if (_vd[n] < near) continue;
          const t = (near - _vd[c]) / (_vd[n] - _vd[c]);
          grow(_vx[c] + (_vx[n] - _vx[c]) * t, _vy[c] + (_vy[n] - _vy[c]) * t, near, this.tanH, this.tanV);
        }
      }
    }
    _rect.x0 = ((_b[0] + 1) / 2) * W;
    _rect.x1 = ((_b[1] + 1) / 2) * W;
    _rect.y0 = ((1 - _b[3]) / 2) * this.h;
    _rect.y1 = ((1 - _b[2]) / 2) * this.h;
    return _rect;
  }

  /** Örtücü kutuyu tampona çizer; tampona bir piksel bile yazmadıysa false. */
  private raster(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, far: number): boolean {
    const { cx, cy, cz } = this, h = this.h;
    // Kamera kutunun içinde ya da yüzüne yapışık: örtücü değil
    if (cx > x0 - NEAR_PAD && cx < x1 + NEAR_PAD && cy > y0 - NEAR_PAD && cy < y1 + NEAR_PAD && cz > z0 - NEAR_PAD && cz < z1 + NEAR_PAD) return false;
    // Köşe aralığı: yalnızca tamamen içeride kalabilecek pikseller (kamera arkasına taşıyorsa bütün ekran)
    const pr = this.project(x0, y0, z0, x1, y1, z1);
    if (pr.behind || pr.near > far) return false;
    const i0 = Math.max(0, Math.ceil(pr.x0)), i1 = Math.min(W, Math.floor(pr.x1));
    const j0 = Math.max(0, Math.ceil(pr.y0)), j1 = Math.min(h, Math.floor(pr.y1));
    if (i1 - i0 < 1 || j1 - j0 < 1) return false;
    if (!this.raysReady) this.rays();
    const { ix, iy, iz, corner, depth } = this;
    if (!pr.cut && this.covered(pr)) return false;
    const ax = x0 - cx, bx = x1 - cx, ay = y0 - cy, by = y1 - cy, az = z0 - cz, bz = z1 - cz;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0, k = j * (W + 1) + i0; i <= i1; i++, k++) {
        // Işın-kutu (slab) testi: giriş derinliği ya da ıskalarsa sonsuz
        let t1 = ax * ix[k], t2 = bx * ix[k];
        let tn = t1 < t2 ? t1 : t2, tf = t1 < t2 ? t2 : t1;
        t1 = ay * iy[k];
        t2 = by * iy[k];
        tn = Math.max(tn, t1 < t2 ? t1 : t2);
        tf = Math.min(tf, t1 < t2 ? t2 : t1);
        t1 = az * iz[k];
        t2 = bz * iz[k];
        tn = Math.max(tn, t1 < t2 ? t1 : t2);
        tf = Math.min(tf, t1 < t2 ? t2 : t1);
        corner[k] = tn <= tf && tn > 0 ? tn : Infinity;
      }
    }
    let wrote = false;
    for (let j = j0; j < j1; j++) {
      for (let i = i0, k = j * (W + 1) + i0, p = j * W + i0; i < i1; i++, k++, p++) {
        const a = corner[k], b = corner[k + 1], c = corner[k + W + 1], e = corner[k + W + 2];
        const ab = a > b ? a : b, ce = c > e ? c : e, d = ab > ce ? ab : ce;
        if (d < depth[p]) {
          depth[p] = d;
          wrote = true;
        }
      }
    }
    if (wrote) {
      const c = this.cov;
      if (i0 < c[0]) c[0] = i0;
      if (i1 > c[1]) c[1] = i1;
      if (j0 < c[2]) c[2] = j0;
      if (j1 > c[3]) c[3] = j1;
    }
    return wrote;
  }

  /** Dikdörtgenin dokunduğu bütün pikseller `near`dan önde örtülü mü. */
  private covered(pr: Rect): boolean {
    const i0 = Math.max(0, Math.floor(pr.x0)), i1 = Math.min(W, Math.ceil(pr.x1));
    const j0 = Math.max(0, Math.floor(pr.y0)), j1 = Math.min(this.h, Math.ceil(pr.y1));
    const c = this.cov;
    if (i0 >= i1 || j0 >= j1 || i0 < c[0] || i1 > c[1] || j0 < c[2] || j1 > c[3]) return false;
    const near = pr.near, depth = this.depth;
    for (let j = j0; j < j1; j++) {
      for (let p = j * W + i0, e = j * W + i1; p < e; p++) if (!(depth[p] < near)) return false;
    }
    return true;
  }

  /** Kutu tamamen örtülü mü (HIDDEN), ekran dışında mı (OFFSCREEN), görünür mü (VISIBLE). */
  private test(b: THREE.Box3): number {
    const pr = this.project(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
    if (pr.behind) return OFFSCREEN;
    if (pr.cut) return VISIBLE;
    const i0 = Math.max(0, Math.floor(pr.x0)), i1 = Math.min(W, Math.ceil(pr.x1));
    const j0 = Math.max(0, Math.floor(pr.y0)), j1 = Math.min(this.h, Math.ceil(pr.y1));
    if (i0 >= i1 || j0 >= j1) return OFFSCREEN;
    return this.covered(pr) ? HIDDEN : VISIBLE;
  }

  private portalVisible(p: Portal): boolean {
    if (p.room.containsPoint(_cam.set(this.cx, this.cy, this.cz)) || p.open?.()) return true;
    // Cephenin arkasından (yan ve arka duvarlar opak) içerisi görünmez
    if ((this.cx - p.px) * p.nx + (this.cz - p.pz) * p.nz <= 0) return false;
    return this.test(p.face) === VISIBLE;
  }
}

const VISIBLE = 0, HIDDEN = 1, OFFSCREEN = 2;
interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  near: number;
  far: number;
  cut: boolean;
  behind: boolean;
}
const _rect: Rect = { x0: 0, x1: 0, y0: 0, y1: 0, near: 0, far: 0, cut: false, behind: false };
const _cam = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _box = new THREE.Box3();
/** Köşelerin görüş uzayı koordinatları (sağ, yukarı, derinlik) ve ekran sınırları (minX, maxX, minY, maxY). */
const _vx = new Float64Array(8), _vy = new Float64Array(8), _vd = new Float64Array(8), _b = new Float64Array(4);
function grow(x: number, y: number, d: number, tanH: number, tanV: number): void {
  const sx = x / (d * tanH), sy = y / (d * tanV);
  if (sx < _b[0]) _b[0] = sx;
  if (sx > _b[1]) _b[1] = sx;
  if (sy < _b[2]) _b[2] = sy;
  if (sy > _b[3]) _b[3] = sy;
}
/** Konum dizisinin kutusu: computeBoundingBox'tan birkaç kat hızlı (açılışta yüz binlerce köşe). */
function positionBox(geo: THREE.BufferGeometry): THREE.Box3 {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  if (!(pos.array instanceof Float32Array) || pos.itemSize !== 3) {
    geo.computeBoundingBox();
    return geo.boundingBox!.clone();
  }
  const a = pos.array;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
}

/** 1/v; sıfır bileşen sonsuz yerine çok büyük (0 · ∞ = NaN olmasın). */
const inv = (v: number) => 1 / (Math.abs(v) < 1e-9 ? 1e-9 : v);
