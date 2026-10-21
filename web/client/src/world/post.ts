// Son işlem: HDR ara görüntü → parıltı (bloom) → renk düzenleme + kenar karartma → ton eşleme/sRGB.
// Yalnızca ayarlarda açıksa kurulur; ara görüntü MSAA'lı (kenar yumuşatma son işlemde de kalsın).
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

const GRADE = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSat: { value: 1.08 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uVignette: { value: 0.4 },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uFilter: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSat;
    uniform vec3 uTint;
    uniform float uVignette;
    uniform vec3 uLift;
    uniform float uFilter;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, uSat), 0.0) * uTint;
      // Gölgelere hafif renk (gece mavi, akşam mor): düz siyah yerine
      c.rgb += uLift * (1.0 - smoothstep(0.0, 0.25, l));
      // Fotoğraf filtreleri: 1 sıcak, 2 soğuk, 3 siyah-beyaz, 4 sepya, 5 nostalji
      if (uFilter > 0.5) {
        float L = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        if (uFilter < 1.5) c.rgb *= vec3(1.12, 1.0, 0.84);
        else if (uFilter < 2.5) c.rgb *= vec3(0.86, 0.98, 1.16);
        else if (uFilter < 3.5) c.rgb = vec3(L) * 1.05;
        else if (uFilter < 4.5) c.rgb = vec3(L) * vec3(1.22, 1.0, 0.72);
        else c.rgb = mix(vec3(L), c.rgb, 0.55) * vec3(1.1, 1.0, 0.8) + vec3(0.025, 0.018, 0.0);
      }
      float v = smoothstep(0.85, 0.2, length(vUv - 0.5));
      c.rgb *= mix(1.0, v, uVignette);
      gl_FragColor = c;
    }
  `,
};

/**
 * Işık huzmeleri (god rays) ve lens parlaması: güneşin ekrandaki yerine doğru ışınsal örnekleme.
 * Yalnızca güneşe yakın parlak pikseller (gök) ışın saçar; ağaç ve binalar araya girince şeritler oluşur.
 * Güneş bir şeyin arkasındaysa lens parlaması söner.
 */
const RAYS = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1 },
    uStrength: { value: 0 },
    uFlare: { value: 0 },
    uColor: { value: new THREE.Color(1, 0.9, 0.75) },
  },
  vertexShader: GRADE.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSun;
    uniform float uAspect;
    uniform float uStrength;
    uniform float uFlare;
    uniform vec3 uColor;
    varying vec2 vUv;
    const int N = 30;
    float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    float bright(vec2 uv) { return smoothstep(0.8, 1.2, lum(texture2D(tDiffuse, uv).rgb)); }
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 add = vec3(0.0);
      if (uStrength > 0.001) {
        vec2 delta = (vUv - uSun) / float(N) * 0.85;
        // Pikselden piksele kaydırılmış başlangıç: az örnekle bantlanma olmasın
        vec2 uv = vUv - delta * fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
        float decay = 1.0, acc = 0.0;
        for (int i = 0; i < N; i++) {
          uv -= delta;
          vec2 d = (uv - uSun) * vec2(uAspect, 1.0);
          acc += smoothstep(0.62, 1.1, lum(texture2D(tDiffuse, uv).rgb)) * exp(-dot(d, d) * 9.0) * decay;
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
      gl_FragColor = vec4(base.rgb + add, base.a);
    }
  `,
};
const _sun = new THREE.Vector3();
const _fwd = new THREE.Vector3();

const TINT_DAY =new THREE.Vector3(1.02, 1.0, 0.97);
const TINT_DUSK = new THREE.Vector3(1.05, 0.98, 0.94);
const TINT_NIGHT = new THREE.Vector3(0.94, 0.98, 1.08);
const LIFT_DUSK = new THREE.Vector3(0.006, 0.002, 0.012);
const LIFT_NIGHT = new THREE.Vector3(0.0, 0.006, 0.018);

export interface PostOptions {
  bloom: boolean;
  grade: boolean;
  /** Fotoğraf filtresi (0 yok); varsa renk düzenleme zorla açılır. */
  filter?: number;
  /** Işık huzmeleri ve lens parlaması; `sunDir` güneşin gökteki yönü. */
  godrays?: boolean;
  sunDir?: THREE.Vector3;
}

export class PostFx {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private rays: ShaderPass;
  private size = { pr: 0, w: 0, h: 0 };

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private camera: THREE.Camera,
    samples: number,
  ) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.8, 0.55, 0.72);
    this.composer.addPass(this.bloom);
    this.rays = new ShaderPass(RAYS);
    this.composer.addPass(this.rays);
    this.grade = new ShaderPass(GRADE);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  /**
   * Bir kare çizer. `env`: gün ışığı, gece lambaları, gün batımı (DayNight).
   * Gündüz parıltı yalnızca HDR parlaklıkta (güneş diski) çalışır; gece lambalar ve ateş saçar.
   */
  render(dt: number, env: { day: number; lights: number; dusk: number }, o: PostOptions): void {
    const pr = this.renderer.getPixelRatio();
    const s = this.size;
    if (pr !== s.pr || innerWidth !== s.w || innerHeight !== s.h) {
      Object.assign(s, { pr, w: innerWidth, h: innerHeight });
      this.composer.setPixelRatio(pr);
      this.composer.setSize(innerWidth, innerHeight);
    }
    this.bloom.enabled = o.bloom;
    if (o.bloom) {
      this.bloom.threshold = 0.72 + 0.4 * env.day;
      this.bloom.strength = 0.85 * env.lights + 0.4 * env.day;
      this.bloom.radius = 0.55;
    }
    this.rays.enabled = !!o.godrays && !!o.sunDir && this.aimRays(o.sunDir, env);
    const filter = o.filter ?? 0;
    this.grade.enabled = o.grade || filter > 0;
    this.grade.uniforms.uFilter.value = filter;
    this.grade.uniforms.uVignette.value = filter ? 0.65 : 0.4;
    if (this.grade.enabled) {
      const u = this.grade.uniforms;
      const night = 1 - env.day;
      (u.uTint.value as THREE.Vector3).copy(TINT_DAY).lerp(TINT_NIGHT, night).lerp(TINT_DUSK, Math.min(1, env.dusk * 1.3));
      (u.uLift.value as THREE.Vector3).copy(LIFT_NIGHT).multiplyScalar(night).addScaledVector(LIFT_DUSK, env.dusk);
      u.uSat.value = 1.0 + 0.1 * env.day;
    }
    this.composer.render(dt);
  }

  /** Güneşin ekrandaki yeri ve ışın gücü; güneş arkada ya da batmışsa false (geçiş atlanır). */
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
    const u = this.rays.uniforms;
    (u.uSun.value as THREE.Vector2).set(x, y);
    u.uAspect.value = innerWidth / innerHeight;
    u.uStrength.value = strength * 1.6;
    u.uFlare.value = edge < 0.5 ? strength : 0;
    (u.uColor.value as THREE.Color).setRGB(1, 0.9 - env.dusk * 0.2, 0.75 - env.dusk * 0.35);
    return true;
  }

  dispose(): void {
    this.composer.dispose();
  }
}
