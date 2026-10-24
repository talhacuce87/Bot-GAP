// Çözünürlük ölçeği < 1 iken: sahne küçük çizilir, AMD FSR 1 benzeri tek geçişle tuvale büyütülür.
// EASU (kenara duyarlı büyütme) 12 örnek okur; RCAS (keskinleştirme) ortadaki 2×2 kaynak piksele aynı
// örneklerle uygulanır (ek okuma yok). İkisi de algısal (ton eşlemeli, sRGB) renkte çalışır, FSR'ın istediği gibi.
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/** Tam ekran üçgen (Pass.js'in FullScreenQuad'ı): kamera yok, konum doğrudan kırpma uzayında. */
export const QUAD_VERTEX = /* glsl */ `
  in vec3 position;
  in vec2 uv;
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FSR_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform sampler2D tInput;
  uniform vec2 uIn;
  uniform vec2 uOut;
  uniform float uSharp;
  in vec2 vUv;
  out vec4 outColor;
  ivec2 lim;
  vec3 tap(ivec2 p) { return texelFetch(tInput, clamp(p, ivec2(0), lim), 0).rgb; }
  float luma(vec3 c) { return c.g + 0.5 * (c.r + c.b); }

  // EASU: dört çift-doğrusal çeyreğin her birinden yön ve kenar uzunluğu
  void easuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
    float dc = lD - lC, cb = lC - lB;
    float lenX = max(abs(dc), abs(cb));
    lenX = lenX > 0.0 ? 1.0 / lenX : 0.0;
    float dirX = lD - lB;
    dir.x += dirX * w;
    lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
    len += lenX * lenX * w;
    float ec = lE - lC, ca = lC - lA;
    float lenY = max(abs(ec), abs(ca));
    lenY = lenY > 0.0 ? 1.0 / lenY : 0.0;
    float dirY = lE - lA;
    dir.y += dirY * w;
    lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
    len += lenY * lenY * w;
  }
  void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
    vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x))) * len2;
    float d2 = min(dot(v, v), clp);
    float wB = 0.4 * d2 - 1.0;
    float wA = lob * d2 - 1.0;
    wB *= wB;
    wA *= wA;
    wB = 1.5625 * wB - 0.5625;
    float w = wB * wA;
    aC += c * w;
    aW += w;
  }
  // RCAS: e ortadaki, b/d/f/h kuzey/batı/doğu/güney komşu; parlaklığı komşuların aralığından taşırmaz
  vec3 rcas(vec3 b, vec3 d, vec3 e, vec3 f, vec3 h) {
    vec3 mn4 = min(min(b, d), min(f, h));
    vec3 mx4 = max(max(b, d), max(f, h));
    vec3 hitMin = mn4 / (4.0 * mx4 + 1e-4);
    vec3 hitMax = (1.0 - mx4) / min(4.0 * mn4 - 4.0, -1e-4);
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * uSharp;
    // Gürültüde (tek parlak piksel) az keskinleştir
    float bL = luma(b), dL = luma(d), eL = luma(e), fL = luma(f), hL = luma(h);
    float nz = abs(0.25 * (bL + dL + fL + hL) - eL) / max(max(max(bL, dL), max(eL, fL)) - min(min(min(bL, dL), min(eL, fL)), hL), 1e-4);
    nz = max(nz, 0.0);
    lobe *= 1.0 - 0.5 * clamp(nz, 0.0, 1.0);
    return (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  }

  void main() {
    lim = ivec2(uIn) - 1;
    vec2 pp = gl_FragCoord.xy * (uIn / uOut) - 0.5;
    vec2 fp = floor(pp);
    pp -= fp;
    ivec2 o = ivec2(fp);
    //    b c
    //  e f g h
    //  i j k l
    //    n o
    vec3 b = tap(o + ivec2(0, -1)), c = tap(o + ivec2(1, -1));
    vec3 e = tap(o + ivec2(-1, 0)), f = tap(o), g = tap(o + ivec2(1, 0)), h = tap(o + ivec2(2, 0));
    vec3 i = tap(o + ivec2(-1, 1)), j = tap(o + ivec2(0, 1)), k = tap(o + ivec2(1, 1)), l = tap(o + ivec2(2, 1));
    vec3 n = tap(o + ivec2(0, 2)), oo = tap(o + ivec2(1, 2));
    float bL = luma(b), cL = luma(c), eL = luma(e), fL = luma(f), gL = luma(g), hL = luma(h);
    float iL = luma(i), jL = luma(j), kL = luma(k), lL = luma(l), nL = luma(n), oL = luma(oo);

    vec2 dir = vec2(0.0);
    float len = 0.0;
    easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
    easuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
    easuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
    easuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);
    float dirR = dot(dir, dir);
    bool zro = dirR < 1.0 / 32768.0;
    dir = zro ? vec2(1.0, 0.0) : dir * inversesqrt(dirR);
    len = len * 0.5;
    len *= len;
    float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
    vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
    float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
    float clp = 1.0 / lob;

    // Ortadaki dört kaynak piksel keskinleşir (komşuları zaten okundu)
    vec3 fs = rcas(b, e, f, g, j), gs = rcas(c, f, g, h, k);
    vec3 js = rcas(f, i, j, k, n), ks = rcas(g, j, k, l, oo);
    vec3 aC = vec3(0.0);
    float aW = 0.0;
    easuTap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);
    easuTap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);
    easuTap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
    easuTap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, js);
    easuTap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, fs);
    easuTap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
    easuTap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, ks);
    easuTap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);
    easuTap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);
    easuTap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, gs);
    easuTap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, oo);
    easuTap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);
    // Negatif loblardan halka olmasın: ortadaki 2×2'nin aralığına sıkıştır
    vec3 mn = min(min(fs, gs), min(js, ks)), mx = max(max(fs, gs), max(js, ks));
    vec3 rgb = clamp(aC / aW, mn, mx);
    // Sinema perdesindeki saydam "delik" (alfa 0, renk 0): alfa çift-doğrusal, renk alfayı aşmasın
    float a = texture(tInput, vUv).a;
    outColor = vec4(min(rgb, vec3(a)), a);
  }
`;

/**
 * Düşük çözünürlüklü çizimi tuvale büyütür. Son işlem kapalıyken sahne kendi hedefine çizilir: hedef
 * tuval gibi davranır (ton eşleme + sRGB çıkış, 8 bit), böylece sahne shader'ları tuvaldekilerle aynı kalır
 * ve ölçek değişince yeniden derlenmez. Son işlem açıkken büyük geçiş son işlemin LDR çıkışını alır.
 */
export class Upscaler {
  private material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tInput: { value: null as THREE.Texture | null },
      uIn: { value: new THREE.Vector2(1, 1) },
      uOut: { value: new THREE.Vector2(1, 1) },
      uSharp: { value: 0.8 },
    },
    vertexShader: QUAD_VERTEX,
    fragmentShader: FSR_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  private quad = new FullScreenQuad(this.material);
  private sceneTarget: THREE.WebGLRenderTarget | null = null;
  private out = new THREE.Vector2();

  constructor(private samples: number) {}

  /** Tuvalin piksel boyutu × ölçek (en az 1). */
  static size(renderer: THREE.WebGLRenderer, scale: number, out: THREE.Vector2): THREE.Vector2 {
    renderer.getDrawingBufferSize(out);
    return out.set(Math.max(1, Math.round(out.x * scale)), Math.max(1, Math.round(out.y * scale)));
  }

  /** Son işlemsiz: sahne ölçekli hedefe, oradan tuvale. */
  renderScene(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, scale: number): void {
    const { x: w, y: h } = Upscaler.size(renderer, scale, this.out);
    let t = this.sceneTarget;
    if (!t) {
      t = this.sceneTarget = new THREE.WebGLRenderTarget(w, h, { samples: this.samples });
      // Tuval gibi: ton eşleme ve sRGB kodlama shader'da (three bunu yalnızca XR hedefinde yapar);
      // depolama düz RGBA8, örnekleyen büyütme shader'ı kodlanmış değeri olduğu gibi tuvale yazar
      t.texture.colorSpace = THREE.SRGBColorSpace;
      t.texture.internalFormat = "RGBA8";
      (t as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
    } else if (t.width !== w || t.height !== h) {
      t.setSize(w, h);
    }
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(t);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    this.blit(renderer, t.texture, w, h);
  }

  /** `tex` (w×h, sRGB kodlu) → tuval. */
  blit(renderer: THREE.WebGLRenderer, tex: THREE.Texture, w: number, h: number): void {
    const u = this.material.uniforms;
    u.tInput.value = tex;
    (u.uIn.value as THREE.Vector2).set(w, h);
    renderer.getDrawingBufferSize(u.uOut.value as THREE.Vector2);
    renderer.setRenderTarget(null);
    // Her piksel yazılır: temizlemeye gerek yok
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
  }

  dispose(): void {
    this.sceneTarget?.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
