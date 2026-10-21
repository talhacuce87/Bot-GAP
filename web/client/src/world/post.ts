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
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, uSat), 0.0) * uTint;
      // Gölgelere hafif renk (gece mavi, akşam mor): düz siyah yerine
      c.rgb += uLift * (1.0 - smoothstep(0.0, 0.25, l));
      float v = smoothstep(0.85, 0.2, length(vUv - 0.5));
      c.rgb *= mix(1.0, v, uVignette);
      gl_FragColor = c;
    }
  `,
};

const TINT_DAY = new THREE.Vector3(1.02, 1.0, 0.97);
const TINT_DUSK = new THREE.Vector3(1.05, 0.98, 0.94);
const TINT_NIGHT = new THREE.Vector3(0.94, 0.98, 1.08);
const LIFT_DUSK = new THREE.Vector3(0.006, 0.002, 0.012);
const LIFT_NIGHT = new THREE.Vector3(0.0, 0.006, 0.018);

export interface PostOptions {
  bloom: boolean;
  grade: boolean;
}

export class PostFx {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private size = { pr: 0, w: 0, h: 0 };

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    samples: number,
  ) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.8, 0.55, 0.72);
    this.composer.addPass(this.bloom);
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
    this.grade.enabled = o.grade;
    if (o.grade) {
      const u = this.grade.uniforms;
      const night = 1 - env.day;
      (u.uTint.value as THREE.Vector3).copy(TINT_DAY).lerp(TINT_NIGHT, night).lerp(TINT_DUSK, Math.min(1, env.dusk * 1.3));
      (u.uLift.value as THREE.Vector3).copy(LIFT_NIGHT).multiplyScalar(night).addScaledVector(LIFT_DUSK, env.dusk);
      u.uSat.value = 1.0 + 0.1 * env.day;
    }
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
