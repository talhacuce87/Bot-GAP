// Güneş gölgesi önbelleği (Unreal'ın önbellekli gölge haritaları gibi). Gölge haritası her kare bütün gölge
// düşürenlerle (karolar, ağaç bölgeleri, binalar) baştan çiziliyordu; oysa gölge kutusu yalnızca oyuncu birkaç
// metre yürüyünce ya da güneş dönünce (3 sn'de bir) kayar, düşürenlerin çoğu da hiç kıpırdamaz.
// Durağanlar bir kez ayrı bir derinlik hedefine "pişirilir"; her kare bu derinlik gölge haritasına kopyalanır
// (yalnızca hareketlilerin değdiği dikdörtgen) ve üstüne yalnızca hareketliler (oyuncular, arabalar, top) çizilir:
// hareketli gölgeler gecikmesiz, durağanlar bedava. Hangi nesnenin durağan olduğu elle işaretlenmez: dünya
// matrisi, örnek matrisleri ve köşeleri STILL kare boyunca değişmeyen gölge düşüren durağandır; kıpırdayan
// pişmiş nesne önbelleği bozar (bir kez yeniden pişer, o artık hareketli sayılır).
import * as THREE from "three";

/** Bu kadar kare kıpırdamayan gölge düşüren durağan sayılır (önbelleğe girer). */
const STILL = 30;
/** Yeni durağanları önbelleğe almak için yeniden pişirme en sık bu aralıkla (ms). */
const PROMOTE_MS = 2000;
/** Hareketlilerin dikdörtgenine eklenen pay (texel). */
const PAD = 2;

type Track = { e: Float64Array; geo: THREE.BufferGeometry | null; iv: number; pv: number; n: number; still: number; seen: number; baked: boolean };
type Rect = [number, number, number, number];
type Caster = THREE.Mesh | THREE.Line | THREE.Points;

/** Işık başına önbellek. */
class LightCache {
  target: THREE.WebGLRenderTarget | null = null;
  map: THREE.RenderTarget | null = null;
  key = new Float64Array(16);
  baked: Caster[] = [];
  lastBake = -Infinity;
  /** Önceki karede hareketlilerin gölge haritasında kirlettiği dikdörtgen (boş: x0 >= x1). */
  prev: Rect = [0, 0, 0, 0];
}

export interface ShadowCacheStats {
  frames: number;
  bakes: number;
  skipped: number;
  dynamic: number;
  statics: number;
  /** Son karede kopyalanan alanın haritaya oranı. */
  area: number;
  /** Yeniden pişirme nedenleri: kutu/güneş kaydı, pişmiş nesne değişti, yeni durağanlar. */
  why: { box: number; changed: number; promote: number };
}

/** `renderer.shadowMap.render`'ı sarar: tek yönlü ışıkta durağan gölge düşürenler önbellekten gelir. */
export function cacheShadows(renderer: THREE.WebGLRenderer): { stats: ShadowCacheStats; enabled: boolean; lists: { statics: THREE.Object3D[]; dynamics: THREE.Object3D[] } } {
  const sm = renderer.shadowMap;
  const orig = sm.render.bind(sm);
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const tracks = new WeakMap<THREE.Object3D, Track>();
  const caches = new WeakMap<THREE.Light, LightCache>();
  const stats: ShadowCacheStats = { frames: 0, bakes: 0, skipped: 0, dynamic: 0, statics: 0, area: 0, why: { box: 0, changed: 0, promote: 0 } };
  const statics: Caster[] = [], dynamics: Caster[] = [];
  /** `lists`: son karenin durağan/hareketli düşürenleri (hata ayıklama). */
  const api = { stats, enabled: true, lists: { statics, dynamics } };
  const noClear = () => {};
  const sphere = new THREE.Sphere(), p = new THREE.Vector3();
  let frame = 0;
  let frustum: THREE.Frustum;
  let camLayers: THREE.Layers;

  /** Değiştiyse true (ve yeni durumu saklar). */
  const moved = (o: Caster, t: Track): boolean => {
    const e = o.matrixWorld.elements, s = t.e;
    let m = false;
    for (let i = 0; i < 16; i++) if (s[i] !== e[i]) { s[i] = e[i]; m = true; }
    const geo = o.geometry, im = (o as THREE.InstancedMesh).instanceMatrix;
    const iv = im ? im.version : 0, pv = (geo.attributes.position as THREE.BufferAttribute | undefined)?.version ?? 0;
    const n = ((o as THREE.InstancedMesh).count ?? 0) * 1e6 + geo.drawRange.start * 1e3 + Math.min(geo.drawRange.count, 1e9);
    if (geo !== t.geo || iv !== t.iv || pv !== t.pv || n !== t.n) { t.geo = geo; t.iv = iv; t.pv = pv; t.n = n; m = true; }
    return m;
  };
  /** Her kare kendi içinde değişebilenler: hep hareketli. */
  const alwaysDynamic = (o: Caster) =>
    (o as THREE.SkinnedMesh).isSkinnedMesh || (o as THREE.BatchedMesh).isBatchedMesh || o.customDepthMaterial !== undefined ||
    !!(o as THREE.Mesh).morphTargetInfluences?.some((v) => v !== 0);

  // WebGLShadowMap.renderObject'in seçtiklerini aynı kurallarla toplar (görünürlük, katman, castShadow, gölge kesik piramidi)
  const collect = (o: THREE.Object3D) => {
    if (!o.visible) return;
    const c = o as Caster;
    if (((c as THREE.Mesh).isMesh || (c as THREE.Line).isLine || (c as THREE.Points).isPoints) && o.castShadow && o.layers.test(camLayers)) {
      let t = tracks.get(o);
      if (!t) tracks.set(o, (t = { e: new Float64Array(16), geo: null, iv: -1, pv: -1, n: -1, still: 0, seen: 0, baked: false }));
      // İzleme görünür bütün düşürenler için: kutuya yeni giren nesnenin geçmişi hazır olsun
      if (moved(c, t)) t.still = 0;
      else if (t.still < STILL) t.still++;
      const mat = c.material;
      if ((Array.isArray(mat) || mat.visible) && (!o.frustumCulled || o.intersectsFrustum(frustum))) {
        t.seen = frame;
        (t.still >= STILL && !alwaysDynamic(c) ? statics : dynamics).push(c);
      }
    }
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) collect(ch[i]);
  };

  /** Hareketlilerin gölge haritasındaki dikdörtgeni (texel). */
  const dynamicRect = (cam: THREE.OrthographicCamera, w: number, h: number, out: Rect): Rect => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const sx = w / (cam.right - cam.left), sy = h / (cam.top - cam.bottom);
    for (const o of dynamics) {
      const bs = (o as THREE.InstancedMesh).boundingSphere;
      if (bs !== undefined) {
        if (bs === null) (o as THREE.InstancedMesh).computeBoundingSphere();
        sphere.copy((o as THREE.InstancedMesh).boundingSphere!);
      } else {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        sphere.copy(o.geometry.boundingSphere!);
      }
      sphere.applyMatrix4(o.matrixWorld);
      p.copy(sphere.center).applyMatrix4(cam.matrixWorldInverse);
      const x = (p.x - cam.left) * sx, y = (p.y - cam.bottom) * sy, rx = sphere.radius * sx + PAD, ry = sphere.radius * sy + PAD;
      x0 = Math.min(x0, x - rx); x1 = Math.max(x1, x + rx);
      y0 = Math.min(y0, y - ry); y1 = Math.max(y1, y + ry);
    }
    out[0] = Math.max(0, Math.floor(x0)); out[1] = Math.max(0, Math.floor(y0));
    out[2] = Math.min(w, Math.ceil(x1)); out[3] = Math.min(h, Math.ceil(y1));
    return out;
  };

  /** Derinlik kopyası (aynı biçim, aynı konum). */
  const blit = (src: THREE.RenderTarget, dst: THREE.RenderTarget, r: Rect) => {
    const st = renderer.state, props = renderer.properties;
    st.setScissorTest(false);
    st.bindFramebuffer(gl.READ_FRAMEBUFFER, (props.get(src) as { __webglFramebuffer: WebGLFramebuffer }).__webglFramebuffer);
    st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, (props.get(dst) as { __webglFramebuffer: WebGLFramebuffer }).__webglFramebuffer);
    gl.blitFramebuffer(r[0], r[1], r[2], r[3], r[0], r[1], r[2], r[3], gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    st.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  };

  /** Yalnızca `list` dışındakiler gölge düşürmüyormuş gibi çizer; `clear` false: haritadaki derinliğin üstüne. */
  const pass = (lights: THREE.Light[], scene: THREE.Scene, camera: THREE.Camera, hide: Caster[], clear: boolean) => {
    for (const o of hide) o.castShadow = false;
    const c = renderer.clear;
    if (!clear) renderer.clear = noClear;
    try {
      orig(lights, scene, camera);
    } finally {
      renderer.clear = c;
      for (const o of hide) o.castShadow = true;
    }
  };

  const cur: Rect = [0, 0, 0, 0], union: Rect = [0, 0, 0, 0];
  sm.render = (lights, scene, camera) => {
    const light = lights[0] as THREE.DirectionalLight;
    const shadow = light?.shadow;
    if (
      !api.enabled || !sm.enabled || (!sm.autoUpdate && !sm.needsUpdate) || lights.length !== 1 || !light.isDirectionalLight ||
      (!shadow.autoUpdate && !shadow.needsUpdate) || sm.type !== THREE.PCFShadowMap
    ) {
      orig(lights, scene, camera);
      return;
    }
    let lc = caches.get(light);
    if (!lc) caches.set(light, (lc = new LightCache()));
    // Harita yoksa (ilk kare, çözünürlük değişti) önce WebGLShadowMap kursun
    if (!shadow.map) {
      orig(lights, scene, camera);
      lc.lastBake = -Infinity;
      return;
    }
    const map = shadow.map, w = map.width, h = map.height;
    if (lc.map !== map || !lc.target || lc.target.width !== w || lc.target.height !== h) {
      lc.target?.depthTexture?.dispose();
      lc.target?.dispose();
      const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      depth.format = THREE.DepthFormat;
      lc.target = new THREE.WebGLRenderTarget(w, h, { depthTexture: depth, generateMipmaps: false });
      renderer.initRenderTarget(lc.target);
      lc.map = map;
      lc.baked = [];
      lc.lastBake = -Infinity;
    }
    frame++;
    stats.frames++;
    shadow.updateMatrices(light);
    frustum = shadow.getFrustum();
    camLayers = camera.layers;
    statics.length = dynamics.length = 0;
    collect(scene);

    // Önbellek bozuldu mu: kutu/güneş yönü değişti, pişmiş bir nesne kıpırdadı ya da görünmez oldu
    let dirty = !Number.isFinite(lc.lastBake);
    const m = shadow.matrix.elements;
    for (let i = 0; i < 16; i++) if (lc.key[i] !== m[i]) { lc.key[i] = m[i]; dirty = true; }
    if (dirty) stats.why.box++;
    else for (const o of lc.baked) {
      const t = tracks.get(o)!;
      if (t.seen !== frame || t.still < STILL) { dirty = true; stats.why.changed++; break; }
    }
    // Yeni durağanlar (ör. yüklenen ya da durup kalan nesne) seyrek aralıkla önbelleğe alınır
    const now = performance.now();
    if (!dirty && now - lc.lastBake > PROMOTE_MS && statics.some((o) => !tracks.get(o)!.baked)) {
      dirty = true;
      stats.why.promote++;
    }
    stats.dynamic = dynamics.length;
    stats.statics = statics.length;

    const prevTarget = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    if (dirty) {
      stats.bakes++;
      lc.lastBake = now;
      for (const o of lc.baked) tracks.get(o)!.baked = false;
      for (const o of statics) tracks.get(o)!.baked = true;
      lc.baked = statics.slice();
      pass(lights, scene, camera, dynamics, true);
      blit(map, lc.target, [0, 0, w, h]);
      if (dynamics.length) pass(lights, scene, camera, statics, false);
      dynamicRect(shadow.camera, w, h, lc.prev);
      stats.area = 1;
    } else {
      dynamicRect(shadow.camera, w, h, cur);
      const pe = lc.prev[0] >= lc.prev[2] || lc.prev[1] >= lc.prev[3], ce = cur[0] >= cur[2] || cur[1] >= cur[3];
      if (pe && ce) {
        // Ne şimdi ne önceki karede hareketli yok: harita zaten durağan derinlik
        stats.skipped++;
        stats.area = 0;
        shadow.needsUpdate = false;
        sm.needsUpdate = false;
        return;
      }
      // Önceki karenin hareketli izleri silinir, bu karenin yerleri hazırlanır: iki dikdörtgenin birleşimi
      union[0] = pe ? cur[0] : ce ? lc.prev[0] : Math.min(cur[0], lc.prev[0]);
      union[1] = pe ? cur[1] : ce ? lc.prev[1] : Math.min(cur[1], lc.prev[1]);
      union[2] = pe ? cur[2] : ce ? lc.prev[2] : Math.max(cur[2], lc.prev[2]);
      union[3] = pe ? cur[3] : ce ? lc.prev[3] : Math.max(cur[3], lc.prev[3]);
      blit(lc.target, map, union);
      stats.area = ((union[2] - union[0]) * (union[3] - union[1])) / (w * h);
      if (dynamics.length) pass(lights, scene, camera, statics, false);
      lc.prev.splice(0, 4, ...cur);
    }
    shadow.needsUpdate = false;
    sm.needsUpdate = false;
    renderer.setRenderTarget(prevTarget, face, mip);
  };
  return api;
}
