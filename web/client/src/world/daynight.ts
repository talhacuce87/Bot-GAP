// Gece/gündüz: Türkiye saatine göre gökyüzü, sis, ışıklar; gece yıldızlar ve lamba haleleri.
// Birkaç saniyede bir güncellenir (renk/yoğunluk ataması); kare başına maliyeti yok.
import * as THREE from "three";

/** Türkiye UTC+3 (yaz saati yok). `override` ile (?hour=21) test edilebilir. */
export function istanbulHour(now = Date.now(), override?: number): number {
  if (override !== undefined && Number.isFinite(override)) return ((override % 24) + 24) % 24;
  const d = new Date(now);
  return (d.getUTCHours() + 3 + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600) % 24;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 0 = gece, 1 = gündüz; gün doğumu ~06:00–07:30, batımı ~18:45–20:15. */
export function daylight(h: number): number {
  return smooth(5.9, 7.4, h) * (1 - smooth(18.7, 20.2, h));
}

/** Gün doğumu/batımı sıcak ton (0–1). */
function duskAmount(h: number): number {
  const bell = (c: number, w: number) => Math.max(0, 1 - Math.abs(h - c) / w);
  return Math.max(bell(6.7, 1.1), bell(19.4, 1.1));
}

const C = (hex: string) => new THREE.Color(hex);
const PAL = {
  dayHorizon: C("#a9cfee"), dayTop: C("#5b8fd6"),
  duskHorizon: C("#f2a36e"), duskTop: C("#4c5c9c"),
  nightHorizon: C("#1b2542"), nightTop: C("#060a18"),
  hemiDaySky: C("#dcefff"), hemiNightSky: C("#5b6fae"),
  hemiDayGround: C("#56683a"), hemiNightGround: C("#1b2416"),
  sunDay: C("#fff1d6"), moon: C("#a7b8ff"), sunDusk: C("#ffb072"),
  bulbOff: C("#e7e1c8"), bulbOn: C("#ffd36b"),
  cloudDay: C("#ffffff"), cloudNight: C("#3a4462"),
  cloudGlowDay: C("#9aa9bd"), cloudGlowNight: C("#141a2c"),
};

export interface DayNightParts {
  scene: THREE.Scene;
  skyGeometry: THREE.BufferGeometry;
  skyRadius: number;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  bulbMaterial: THREE.MeshBasicMaterial;
  cloudMaterial: THREE.MeshLambertMaterial;
  /** Lamba konumları: gece çevrelerinde hale yanar. */
  bulbMatrices: THREE.Matrix4[];
}

/** Lamba haleleri: kameraya dönük, toplamalı (additive) yumuşak daireler; tek draw call. */
function glowMesh(mats: THREE.Matrix4[]): THREE.InstancedMesh {
  const material = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      void main() {
        float s = length(instanceMatrix[0].xyz) * 2.6;
        vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vLocal = uv * 2.0 - 1.0;
        gl_Position = projectionMatrix * (center + vec4(position.xy * s, 0.0, 0.0));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec2 vLocal;
      void main() {
        float d = dot(vLocal, vLocal);
        if (d > 1.0) discard;
        float a = (1.0 - d) * (1.0 - d) * uOpacity;
        gl_FragColor = vec4(vec3(1.0, 0.78, 0.42) * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, mats.length);
  mats.forEach((mm, i) => m.setMatrixAt(i, mm));
  m.computeBoundingSphere();
  m.matrixAutoUpdate = false;
  m.renderOrder = 5;
  return m;
}

function starField(radius: number): THREE.Points {
  const n = 520;
  const pos = new Float32Array(n * 3);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const y = 0.12 + rand() * 0.88; // ufkun hemen üstünden tepeye
    const r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * r * radius, y * radius, Math.sin(a) * r * radius], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: "#ffffff", size: 1.8, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  p.matrixAutoUpdate = false;
  p.renderOrder = -1;
  return p;
}

export class DayNight {
  private glow: THREE.InstancedMesh;
  private stars: THREE.Points;
  private horizon = new THREE.Color();
  private top = new THREE.Color();
  private tmp = new THREE.Color();
  private lastUpdate = -Infinity;

  constructor(
    private p: DayNightParts,
    private override?: number,
    /** Diğer efektler için dışa açılan durum (gece ışıkları, toz rengi vb.). */
    private env: { day: number; lights: number } = { day: 1, lights: 0 },
  ) {
    this.glow = glowMesh(p.bulbMatrices);
    this.stars = starField(p.skyRadius * 0.95);
    p.scene.add(this.glow, this.stars);
    this.apply(Date.now());
  }

  /** Her karede çağrılabilir; gerçek iş 3 saniyede bir. */
  update(nowMs: number): void {
    if (nowMs - this.lastUpdate < 3000) return;
    this.apply(nowMs);
  }

  private apply(nowMs: number): void {
    this.lastUpdate = nowMs;
    const p = this.p;
    const h = istanbulHour(nowMs, this.override);
    const day = daylight(h);
    const dusk = duskAmount(h) * 0.75;

    this.horizon.copy(PAL.nightHorizon).lerp(PAL.dayHorizon, day).lerp(PAL.duskHorizon, dusk);
    this.top.copy(PAL.nightTop).lerp(PAL.dayTop, day).lerp(PAL.duskTop, dusk * 0.6);
    (p.scene.background as THREE.Color).copy(this.horizon);
    p.scene.fog!.color.copy(this.horizon);

    // Gökyüzü kubbesi: ufuktan tepeye geçiş (az sayıda köşe, saniyede bir bile ucuz)
    const pos = p.skyGeometry.attributes.position;
    const col = p.skyGeometry.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = Math.max(0, pos.getY(i) / p.skyRadius);
      this.tmp.copy(this.horizon).lerp(this.top, y ** 0.7);
      col.setXYZ(i, this.tmp.r, this.tmp.g, this.tmp.b);
    }
    col.needsUpdate = true;

    // Gece daha karanlık: lambaların aydınlattığı yerler öne çıksın
    p.hemi.intensity = 0.34 + 1.26 * day;
    p.hemi.color.copy(PAL.hemiNightSky).lerp(PAL.hemiDaySky, day);
    p.hemi.groundColor.copy(PAL.hemiNightGround).lerp(PAL.hemiDayGround, day);
    p.sun.intensity = 0.32 + 1.38 * day;
    p.sun.color.copy(PAL.moon).lerp(PAL.sunDay, day).lerp(PAL.sunDusk, dusk);

    // Hava kararınca lambalar yanar
    const lights = 1 - smooth(0.25, 0.7, day);
    this.env.day = day;
    this.env.lights = lights;
    p.bulbMaterial.color.copy(PAL.bulbOff).lerp(PAL.bulbOn, lights);
    (this.glow.material as THREE.ShaderMaterial).uniforms.uOpacity.value = lights * 0.55;
    this.glow.visible = lights > 0.01;

    const starA = (1 - smooth(0.0, 0.35, day)) * 0.9;
    (this.stars.material as THREE.PointsMaterial).opacity = starA;
    this.stars.visible = starA > 0.01;

    p.cloudMaterial.color.copy(PAL.cloudNight).lerp(PAL.cloudDay, day);
    p.cloudMaterial.emissive.copy(PAL.cloudGlowNight).lerp(PAL.cloudGlowDay, day);
  }
}
