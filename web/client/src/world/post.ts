// Son işlem: HDR ara görüntü → parıltı (bloom) → tek "uber" geçiş: temizlik + ışık huzmeleri + alan derinliği +
// renk düzenleme + kenar karartma + ton eşleme/sRGB. Yalnızca ayarlarda açıksa kurulur; ara görüntü MSAA'lı
// (kenar yumuşatma son işlemde de kalsın). Tam ekran geçiş sayısı az: her geçiş yüksek çözünürlükte bellek
// bant genişliği yer (eskiden 6 ayrı geçiş, her biri 16 bitlik MSAA hedefe yazıp çözümlüyordu).
// Çözünürlük ölçeği < 1 iken sahne ve son işlem küçük çizilir, FSR benzeri büyütme tuvale taşır (upscale.ts).
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { QUAD_VERTEX, Upscaler } from "./upscale";

const COMMON = /* glsl */ `
  precision highp float;
  precision highp int;
  float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  // Temizlik: bazı ekran kartlarında tanımsız matematik (ya da 16 bitlik ara görüntüde 65504'ü aşan parlaklık)
  // NaN/sonsuz üretir; parıltının bulanıklaştırması bunu büyük bloklara yayar ve o bölge saydam çıkıp sayfa arka
  // planı görünür (gece parıltı güçlü olduğu için gece). NaN/sonsuz sıfırlanır, aşırı parlaklık sınırlanır;
  // çıkışın saydamlığı 1: son işlem yalnızca perdede video deliği yokken çalışır.
  vec3 clean(vec3 c) { return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : clamp(c, 0.0, 64.0); }
`;

/**
 * Parıltının parlak kısmı, yarım çözünürlükte: her piksel sahnenin 2×2'sini temizleyip ortalar (eskiden tam
 * çözünürlükte temizlik geçişi + çift-doğrusal örnek; sonuç aynı), eşiği geçen kalır. Alfa kanalı ışık
 * huzmelerinin maskesi: huzme her pikselde 30 örnek okur, tam çözünürlüklü sahne yerine bu küçük dokudan.
 */
const BRIGHT_FRAGMENT = /* glsl */ `
  ${COMMON}
  uniform sampler2D tScene;
  uniform float uThreshold;
  out vec4 outColor;
  void main() {
    ivec2 p = ivec2(gl_FragCoord.xy) * 2, lim = textureSize(tScene, 0) - 1;
    vec3 c = clean(texelFetch(tScene, min(p, lim), 0).rgb) + clean(texelFetch(tScene, min(p + ivec2(1, 0), lim), 0).rgb)
      + clean(texelFetch(tScene, min(p + ivec2(0, 1), lim), 0).rgb) + clean(texelFetch(tScene, min(p + ivec2(1, 1), lim), 0).rgb);
    c *= 0.25;
    float a = smoothstep(uThreshold, uThreshold + 0.01, lum(c));
    outColor = vec4(c * a, smoothstep(0.62, 1.1, lum(c)));
  }
`;

const UBER_FRAGMENT = /* glsl */ `
  ${COMMON}
  #include <packing>
  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tRays;
  uniform sampler2D tDepth;
  uniform float uBloom;
  uniform float uAspect;
  // Işık huzmeleri
  uniform vec2 uSun;
  uniform float uStrength;
  uniform float uFlare;
  uniform vec3 uColor;
  // Alan derinliği
  uniform float uDof;
  uniform float uFocus;
  uniform float uNear;
  uniform float uFar;
  // Renk düzenleme
  uniform float uGrade;
  uniform float uSat;
  uniform vec3 uTint;
  uniform float uVignette;
  uniform vec3 uLift;
  uniform float uFilter;
  // Gece sinema görünümü (0 gündüz/filtreli, 1 gece) ve film greninin kare tohumu
  uniform float uCine;
  uniform float uSeed;
  in vec2 vUv;
  out vec4 outColor;
  const int N = 30;

  // Sahne + parıltı (eskiden parıltı sahnenin üstüne toplanıyordu, sonraki geçişler bunu okuyordu)
  vec3 src(vec2 uv) {
    vec3 c = clean(texture(tScene, uv).rgb);
    if (uBloom > 0.5) c += texture(tBloom, uv).rgb;
    return c;
  }
  float bright(vec2 uv) { return smoothstep(0.8, 1.2, lum(src(uv))); }

  /**
   * Işık huzmeleri (god rays) ve lens parlaması: güneşin ekrandaki yerine doğru ışınsal örnekleme.
   * Yalnızca güneşe yakın parlak pikseller (gök) ışın saçar; ağaç ve binalar araya girince şeritler oluşur.
   * Güneş bir şeyin arkasındaysa lens parlaması söner.
   */
  vec3 rays() {
    vec3 add = vec3(0.0);
    if (uStrength > 0.001) {
      vec2 delta = (vUv - uSun) / float(N) * 0.85;
      // Pikselden piksele kaydırılmış başlangıç: az örnekle bantlanma olmasın
      vec2 uv = vUv - delta * fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
      float decay = 1.0, acc = 0.0;
      for (int i = 0; i < N; i++) {
        uv -= delta;
        vec2 d = (uv - uSun) * vec2(uAspect, 1.0);
        acc += textureLod(tRays, uv, 0.0).a * exp(-dot(d, d) * 9.0) * decay;
        decay *= 0.955;
      }
      add += uColor * acc / float(N) * uStrength;
    }
    if (uFlare > 0.001) {
      // Güneş görünüyor mu: çevresinden 5 örnek (önünde ağaç/bina varsa söner)
      vec2 o = vec2(0.006 / uAspect, 0.006);
      float vis = (bright(uSun) + bright(uSun + vec2(o.x, 0.0)) + bright(uSun - vec2(o.x, 0.0)) + bright(uSun + vec2(0.0, o.y)) + bright(uSun - vec2(0.0, o.y))) / 5.0;
      // Hayalet daireler: güneşten ekranın ortasından geçen çizgi üzerinde
      vec2 axis = vec2(0.5) - uSun;
      vec3 fl = vec3(0.0);
      float fs[5] = float[5](0.45, 0.8, 1.15, 1.45, 1.85);
      float rs[5] = float[5](0.035, 0.07, 0.02, 0.11, 0.05);
      vec3 cs[5] = vec3[5](vec3(1.0, 0.6, 0.3), vec3(0.4, 0.9, 0.6), vec3(1.0, 0.85, 0.5), vec3(0.4, 0.6, 1.0), vec3(0.9, 0.4, 0.8));
      for (int k = 0; k < 5; k++) {
        float d = length((vUv - (uSun + axis * fs[k])) * vec2(uAspect, 1.0));
        fl += cs[k] * (smoothstep(rs[k], rs[k] * 0.55, d) * 0.5 + smoothstep(rs[k] * 0.8, rs[k], d) * smoothstep(rs[k] * 1.05, rs[k], d) * 0.6);
      }
      // Güneşin çevresinde ince hale ve yatay çizgi
      vec2 sd = (vUv - uSun) * vec2(uAspect, 1.0);
      fl += vec3(0.8, 0.85, 1.0) * smoothstep(0.012, 0.0, abs(length(sd) - 0.18)) * 0.25;
      fl += uColor * exp(-abs(sd.y) * 220.0) * exp(-abs(sd.x) * 4.0) * 0.6;
      add += fl * 0.12 * uFlare * vis;
    }
    return add;
  }

  /**
   * Alan derinliği (fotoğraf modu): odaktaki karakter net, önü ve arkası derinliğe göre bulanık (bokeh).
   * Derinlik ayrı ve opak nesnelerle çizilir; parçacıklar/saydamlar derinliğe yazılmaz.
   */
  float dist(vec2 uv) {
    float d = unpackRGBAToDepth(texture(tDepth, uv));
    return -perspectiveDepthToViewZ(d, uNear, uFar);
  }
  float coc(float z) {
    // Odak çevresinde net bölge; uzaklaştıkça bulanıklık artar (önde daha hızlı)
    float k = z > uFocus ? (z - uFocus) / (uFocus * 2.5) : (uFocus - z) / (uFocus * 0.6);
    return clamp(k - 0.08, 0.0, 1.0);
  }
  vec3 dof(vec3 base) {
    float c = coc(dist(vUv));
    if (c < 0.01) return base;
    // Altın açılı spiral: 24 örnek, parlaklar ağırlıklı (bokeh daireleri)
    vec3 acc = base;
    float wsum = 1.0;
    float r = c * 0.012;
    for (int i = 1; i < 24; i++) {
      float fi = float(i);
      float a = fi * 2.39996;
      vec2 o = vec2(cos(a), sin(a)) * sqrt(fi / 24.0) * r * vec2(1.0 / uAspect, 1.0) * 1.6;
      vec2 uv = vUv + o;
      // Arkaplan örneği öndeki nete taşmasın
      float w = coc(dist(uv)) >= c * 0.5 ? 1.0 : 0.2;
      vec3 col = src(uv);
      w *= 1.0 + 2.0 * smoothstep(0.9, 1.6, dot(col, vec3(0.333)));
      acc += col * w;
      wsum += w;
    }
    return acc / wsum;
  }

  vec3 grade(vec3 c) {
    float l = lum(c);
    c = max(mix(vec3(l), c, uSat), 0.0) * uTint;
    // Gölgelere hafif renk (gece mavi, akşam mor): düz siyah yerine
    c += uLift * (1.0 - smoothstep(0.0, 0.25, l));
    // Gece: gölgeler yeşil-turkuaza, lamba ve ateş ışığı sıcağa kayar, en koyular biraz çöker
    // (düz lacivert gece yerine kamp ateşi fotoğrafı gibi)
    if (uCine > 0.0) {
      float L = lum(c);
      vec3 split = mix(vec3(0.8, 0.98, 0.92), vec3(1.14, 1.0, 0.8), smoothstep(0.03, 0.5, L));
      c = mix(c, c * split * mix(0.72, 1.0, smoothstep(0.0, 0.12, L)), uCine);
    }
    // Fotoğraf filtreleri: 1 sıcak, 2 soğuk, 3 siyah-beyaz, 4 sepya, 5 nostalji
    if (uFilter > 0.5) {
      float L = lum(c);
      if (uFilter < 1.5) c *= vec3(1.12, 1.0, 0.84);
      else if (uFilter < 2.5) c *= vec3(0.86, 0.98, 1.16);
      else if (uFilter < 3.5) c = vec3(L) * 1.05;
      else if (uFilter < 4.5) c = vec3(L) * vec3(1.22, 1.0, 0.72);
      else c = mix(vec3(L), c, 0.55) * vec3(1.1, 1.0, 0.8) + vec3(0.025, 0.018, 0.0);
    }
    float v = smoothstep(0.85, 0.2, length(vUv - 0.5));
    return c * mix(1.0, v, uVignette);
  }

  void main() {
    vec3 c = src(vUv);
    if (uDof > 0.5) c = dof(c);
    c += rays();
    if (uGrade > 0.5) c = grade(c);
    // Ton eşleme ve sRGB (OutputPass ile aynı)
    #if defined( LINEAR_TONE_MAPPING )
      c = LinearToneMapping(c);
    #elif defined( REINHARD_TONE_MAPPING )
      c = ReinhardToneMapping(c);
    #elif defined( CINEON_TONE_MAPPING )
      c = CineonToneMapping(c);
    #elif defined( ACES_FILMIC_TONE_MAPPING )
      c = ACESFilmicToneMapping(c);
    #elif defined( AGX_TONE_MAPPING )
      c = AgXToneMapping(c);
    #elif defined( NEUTRAL_TONE_MAPPING )
      c = NeutralToneMapping(c);
    #endif
    outColor = vec4(c, 1.0);
    #ifdef SRGB_TRANSFER
      outColor = sRGBTransferOETF(outColor);
    #endif
    // Film greni (gece): ekran uzayında, her kare farklı
    if (uCine > 0.0) {
      float n = fract(sin(dot(gl_FragCoord.xy + uSeed, vec2(12.9898, 78.233))) * 43758.5453);
      outColor.rgb += (n - 0.5) * 0.045 * uCine;
    }
  }
`;

const _sun = new THREE.Vector3();
const _clear = new THREE.Color();
const _fwd = new THREE.Vector3();
const _size = new THREE.Vector2();
const BLUR_X = new THREE.Vector2(1, 0);
const BLUR_Y = new THREE.Vector2(0, 1);

const TINT_DAY = new THREE.Vector3(1.02, 1.0, 0.97);
const TINT_DUSK = new THREE.Vector3(1.05, 0.98, 0.94);
const TINT_NIGHT = new THREE.Vector3(0.94, 0.98, 1.08);
const LIFT_DUSK = new THREE.Vector3(0.006, 0.002, 0.012);
const LIFT_NIGHT = new THREE.Vector3(0.0, 0.006, 0.018);

const TONE_DEFINES: Partial<Record<THREE.ToneMapping, string>> = {
  [THREE.LinearToneMapping]: "LINEAR_TONE_MAPPING",
  [THREE.ReinhardToneMapping]: "REINHARD_TONE_MAPPING",
  [THREE.CineonToneMapping]: "CINEON_TONE_MAPPING",
  [THREE.ACESFilmicToneMapping]: "ACES_FILMIC_TONE_MAPPING",
  [THREE.AgXToneMapping]: "AGX_TONE_MAPPING",
  [THREE.NeutralToneMapping]: "NEUTRAL_TONE_MAPPING",
};

export interface PostOptions {
  bloom: boolean;
  grade: boolean;
  /** Fotoğraf filtresi (0 yok); varsa renk düzenleme zorla açılır. */
  filter?: number;
  /** Işık huzmeleri ve lens parlaması; `sunDir` güneşin gökteki yönü. */
  godrays?: boolean;
  sunDir?: THREE.Vector3;
  /** Alan derinliği: odak uzaklığı (m), 0 kapalı. */
  dof?: number;
}

const raw = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
  new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, uniforms, vertexShader: QUAD_VERTEX, fragmentShader, depthTest: false, depthWrite: false });

export class PostFx {
  private target: THREE.WebGLRenderTarget;
  /** Ölçek < 1 iken uber çıkışı (ton eşlemeli, sRGB, 8 bit); büyütme bunu okur. */
  private ldr: THREE.WebGLRenderTarget | null = null;
  private upscaler = new Upscaler(0);
  /** Yalnızca bulanıklaştırma hedefleri ve malzemeleri kullanılır; geçişi burada sürülür. */
  private bloom: UnrealBloomPass;
  private bright: THREE.RawShaderMaterial;
  private uber: THREE.RawShaderMaterial;
  private quad = new FullScreenQuad();
  private tone: { map: THREE.ToneMapping; space: string } = { map: THREE.NoToneMapping, space: "" };
  private depthTarget: THREE.WebGLRenderTarget | null = null;
  private depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  private hidden: THREE.Object3D[] = [];
  private size = { w: 0, h: 0 };

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    samples: number,
  ) {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0.55, 0.72);
    this.bright = raw(BRIGHT_FRAGMENT, { tScene: { value: this.target.texture }, uThreshold: { value: 1 } });
    this.uber = raw(UBER_FRAGMENT, {
      tScene: { value: this.target.texture },
      tBloom: { value: this.bloom.renderTargetsHorizontal[0].texture },
      tRays: { value: this.bloom.renderTargetBright.texture },
      tDepth: { value: null },
      toneMappingExposure: { value: 1 },
      uBloom: { value: 0 },
      uAspect: { value: 1 },
      uSun: { value: new THREE.Vector2(0.5, 0.5) },
      uStrength: { value: 0 },
      uFlare: { value: 0 },
      uColor: { value: new THREE.Color(1, 0.9, 0.75) },
      uDof: { value: 0 },
      uFocus: { value: 8 },
      uNear: { value: 0.1 },
      uFar: { value: 260 },
      uGrade: { value: 0 },
      uSat: { value: 1.08 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uVignette: { value: 0.4 },
      uLift: { value: new THREE.Vector3(0, 0, 0) },
      uFilter: { value: 0 },
      uCine: { value: 0 },
      uSeed: { value: 0 },
    });
  }

  /**
   * Sahne shader'larını son işlemin hedefine göre derler: render target'a çizen program ton eşlemesiz ve
   * doğrusal çıkışlıdır, canvas için derlenenler burada kullanılamaz (ilk karede hepsi yeniden derlenirdi).
   */
  async compile(): Promise<void> {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    try {
      await r.compileAsync(this.scene, this.camera);
    } finally {
      r.setRenderTarget(prev);
    }
  }

  /**
   * Bir kare çizer. `env`: gün ışığı, gece lambaları, gün batımı (DayNight). `scale`: çözünürlük ölçeği
   * (1'de büyütme geçişi yok, uber doğrudan tuvale yazar).
   * Gündüz parıltı yalnızca HDR parlaklıkta (güneş diski) çalışır; gece lambalar ve ateş saçar.
   */
  render(_dt: number, env: { day: number; lights: number; dusk: number }, o: PostOptions, scale = 1): void {
    const r = this.renderer;
    const { x: w, y: h } = Upscaler.size(r, scale, _size);
    const s = this.size;
    if (w !== s.w || h !== s.h) {
      Object.assign(s, { w, h });
      this.target.setSize(w, h);
      this.bloom.setSize(w, h);
    }
    this.syncTone();
    const u = this.uber.uniforms;
    const aspect = innerWidth / innerHeight;
    u.uAspect.value = aspect;

    const prev = r.getRenderTarget();
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    // Tam ekran geçişler her pikseli yazar: temizlemeye gerek yok
    const autoClear = r.autoClear;
    r.autoClear = false;

    u.uBloom.value = o.bloom ? 1 : 0;
    const rays = !!o.godrays && !!o.sunDir && this.aimRays(o.sunDir, env);
    if (!rays) u.uStrength.value = u.uFlare.value = 0;
    if (o.bloom || rays) this.renderBright(env);
    if (o.bloom) this.renderBloom(env);
    u.uDof.value = o.dof ? 1 : 0;
    if (o.dof) this.renderDepth(o.dof);
    const filter = o.filter ?? 0;
    u.uGrade.value = o.grade || filter > 0 ? 1 : 0;
    u.uFilter.value = filter;
    u.uCine.value = 0;
    if (u.uGrade.value) {
      const night = 1 - env.day;
      u.uCine.value = filter ? 0 : night;
      u.uSeed.value = Math.random() * 512;
      u.uVignette.value = filter ? 0.65 : 0.4 + 0.25 * night;
      (u.uTint.value as THREE.Vector3).copy(TINT_DAY).lerp(TINT_NIGHT, night).lerp(TINT_DUSK, Math.min(1, env.dusk * 1.3));
      (u.uLift.value as THREE.Vector3).copy(LIFT_NIGHT).multiplyScalar(night).addScaledVector(LIFT_DUSK, env.dusk);
      u.uSat.value = 1.0 + 0.1 * env.day;
    }

    this.quad.material = this.uber;
    if (scale >= 1) {
      r.setRenderTarget(null);
      this.quad.render(r);
    } else {
      // Küçük çözünürlükte bitir, FSR benzeri büyütmeyle tuvale
      if (!this.ldr) this.ldr = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
      else if (this.ldr.width !== w || this.ldr.height !== h) this.ldr.setSize(w, h);
      r.setRenderTarget(this.ldr);
      this.quad.render(r);
      this.upscaler.blit(r, this.ldr.texture, w, h);
    }
    r.autoClear = autoClear;
    r.setRenderTarget(prev);
  }

  /** Ton eşleme ve çıkış renk uzayı renderer'dan (OutputPass gibi); değişince shader yeniden kurulur. */
  private syncTone(): void {
    const r = this.renderer, t = this.tone;
    if (t.map === r.toneMapping && t.space === r.outputColorSpace) return;
    t.map = r.toneMapping;
    t.space = r.outputColorSpace;
    const d: Record<string, string> = {};
    const tm = TONE_DEFINES[t.map];
    if (tm) d[tm] = "";
    if (THREE.ColorManagement.getTransfer(t.space) === THREE.SRGBTransfer) d.SRGB_TRANSFER = "";
    this.uber.defines = d;
    this.uber.needsUpdate = true;
    this.uber.uniforms.toneMappingExposure.value = r.toneMappingExposure;
  }

  /** Parlak kısım + huzme maskesi (yarım çözünürlük): parıltı ya da huzme açıksa. */
  private renderBright(env: { day: number }): void {
    const r = this.renderer, q = this.quad;
    // Ölçülü: yalnızca gerçekten parlak şeyler (ampul, far, stop, güneş) ışır, ışıma kaynağın çevresinde kalır.
    // Eşik düşük olunca lambaların aydınlattığı duvar, kaldırım ve yol da ışıyıp sahneyi bulanıklaştırıyordu.
    this.bright.uniforms.uThreshold.value = 0.95 + 0.2 * env.day;
    q.material = this.bright;
    r.setRenderTarget(this.bloom.renderTargetBright);
    q.render(r);
  }

  /**
   * Parıltı (UnrealBloomPass'in mip zinciri ve katsayıları): 5 mip ayrık Gauss, birleşim yarım çözünürlükte
   * bir dokuya; sahneye eklenmesi uber geçişte (ayrı tam ekran toplama yok).
   */
  private renderBloom(env: { day: number; lights: number }): void {
    const r = this.renderer, b = this.bloom, q = this.quad;
    let input = b.renderTargetBright;
    for (let i = 0; i < b.nMips; i++) {
      const m = b.separableBlurMaterials[i];
      q.material = m;
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = BLUR_X;
      r.setRenderTarget(b.renderTargetsHorizontal[i]);
      q.render(r);
      m.uniforms.colorTexture.value = b.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = BLUR_Y;
      r.setRenderTarget(b.renderTargetsVertical[i]);
      q.render(r);
      input = b.renderTargetsVertical[i];
    }
    const c = b.compositeMaterial.uniforms;
    c.bloomStrength.value = 0.35 * env.lights + 0.15 * env.day;
    c.bloomRadius.value = 0.35;
    q.material = b.compositeMaterial;
    r.setRenderTarget(b.renderTargetsHorizontal[0]);
    q.render(r);
  }

  /** Alan derinliği için derinlik görüntüsü: yalnızca derinliğe yazan opak nesneler. */
  private renderDepth(focus: number): void {
    const r = this.renderer;
    const w = Math.max(1, Math.floor(this.size.w * 0.5)), h = Math.max(1, Math.floor(this.size.h * 0.5));
    if (!this.depthTarget || this.depthTarget.width !== w || this.depthTarget.height !== h) {
      this.depthTarget?.dispose();
      this.depthTarget = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    }
    // Parçacıklar, ışık konileri, sis: shader'da konumlanır ya da saydamdır, derinliğe karışmasın
    this.hidden.length = 0;
    this.scene.traverseVisible((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && !Array.isArray(m) && (m.transparent || !m.depthWrite || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) this.hidden.push(o);
    });
    for (const o of this.hidden) o.visible = false;
    const bg = this.scene.background, fog = this.scene.fog;
    this.scene.background = null;
    this.scene.fog = null;
    this.scene.overrideMaterial = this.depthMaterial;
    const prevTarget = r.getRenderTarget();
    r.getClearColor(_clear);
    const clearAlpha = r.getClearAlpha();
    r.setRenderTarget(this.depthTarget);
    r.setClearColor(0xffffff, 1);
    r.clear();
    r.render(this.scene, this.camera);
    r.setRenderTarget(prevTarget);
    r.setClearColor(_clear, clearAlpha);
    this.scene.overrideMaterial = null;
    this.scene.background = bg;
    this.scene.fog = fog;
    for (const o of this.hidden) o.visible = true;
    const cam = this.camera as THREE.PerspectiveCamera;
    const u = this.uber.uniforms;
    u.tDepth.value = this.depthTarget.texture;
    u.uFocus.value = focus;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
  }

  /** Güneşin ekrandaki yeri ve ışın gücü; güneş arkada ya da batmışsa false (huzme hesabı atlanır). */
  private aimRays(sunDir: THREE.Vector3, env: { day: number; dusk: number }): boolean {
    const cam = this.camera;
    cam.getWorldDirection(_fwd);
    const facing = _fwd.dot(sunDir);
    if (facing < 0.05 || sunDir.y < -0.04) return false;
    _sun.copy(cam.position).addScaledVector(sunDir, 200).project(cam);
    const x = _sun.x * 0.5 + 0.5, y = _sun.y * 0.5 + 0.5;
    // Ekranın biraz dışındaki güneş de ışın saçar; çok dışındaysa söner
    const edge = Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5));
    const fade = 1 - THREE.MathUtils.smoothstep(edge, 0.6, 0.95);
    const low = THREE.MathUtils.smoothstep(sunDir.y, -0.04, 0.08);
    const strength = fade * low * Math.min(1, facing * 2) * (0.55 + 0.9 * env.dusk);
    if (strength < 0.01) return false;
    const u = this.uber.uniforms;
    (u.uSun.value as THREE.Vector2).set(x, y);
    u.uStrength.value = strength * 1.6;
    u.uFlare.value = edge < 0.5 ? strength : 0;
    (u.uColor.value as THREE.Color).setRGB(1, 0.9 - env.dusk * 0.2, 0.75 - env.dusk * 0.35);
    return true;
  }

  dispose(): void {
    this.depthTarget?.dispose();
    this.target.dispose();
    this.ldr?.dispose();
    this.bloom.dispose();
    this.bright.dispose();
    this.uber.dispose();
    this.quad.dispose();
    this.upscaler.dispose();
    this.depthMaterial.dispose();
  }
}
