// Gece/gündüz: Türkiye saatine göre gökyüzü, güneşin yeri, sis, ışıklar; gece yıldızlar ve lamba haleleri.
// Birkaç saniyede bir güncellenir (renk/yoğunluk/yön ataması); kare başına maliyeti yok.
import * as THREE from "three";
import type { Weather } from "../../../shared/protocol";
import { cloudUniform, timeUniform } from "./geo";

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

/** Saat sabitlenince/bırakılınca geçiş süresi. */
const HOUR_FADE_MS = 4000;

const SUNRISE = 6.4;
const SUNSET = 19.6;
/** Doğuş yönü (yatay); batış tam karşısı: meydandan sinemaya bakınca güneş perdenin solunda batar. */
const RISE_DIR = new THREE.Vector2(0.62, 0.78).normalize();
/** Öğle yüksekliği (radyan). */
const NOON_ELEV = 1.05;

/**
 * Güneşin gökteki yönü (birim vektör). Doğudan doğar, öğlen güneyde yükselir, perdenin solunda batar;
 * geceleri ufkun altında kalır.
 */
export function sunDirection(h: number, out = new THREE.Vector3()): THREE.Vector3 {
  const t = (h - SUNRISE) / (SUNSET - SUNRISE);
  const elev = Math.sin(Math.PI * t) * NOON_ELEV * (t > 0 && t < 1 ? 1 : 0.35);
  // Yatay yön: doğuştan batışa güney (+x yanı) üzerinden yarım tur
  const a0 = Math.atan2(RISE_DIR.y, RISE_DIR.x);
  const a = a0 - Math.PI * Math.min(1.1, Math.max(-0.1, t));
  const c = Math.cos(elev);
  return out.set(Math.cos(a) * c, Math.sin(elev), Math.sin(a) * c).normalize();
}

const C = (hex: string) => new THREE.Color(hex);
const PAL = {
  dayHorizon: C("#a9cfee"), dayTop: C("#5b8fd6"),
  duskHorizon: C("#f3a27a"), duskTop: C("#4a4f9a"),
  nightHorizon: C("#1b2542"), nightTop: C("#060a18"),
  hemiDaySky: C("#dcefff"), hemiNightSky: C("#5b6fae"), hemiDuskSky: C("#f0b9a8"),
  hemiDayGround: C("#56683a"), hemiNightGround: C("#1b2416"),
  sunDay: C("#fff1d6"), moon: C("#a7b8ff"), sunDusk: C("#ffa25e"),
  sunDiscDay: C("#fff6e2"), sunDiscDusk: C("#ff9a4a"),
  bulbOff: C("#e7e1c8"), bulbOn: C("#ffd36b"),
  cloudDay: C("#ffffff"), cloudNight: C("#3a4462"),
  cloudGlowDay: C("#9aa9bd"), cloudGlowNight: C("#141a2c"), cloudGlowDusk: C("#e2928c"),
};

export interface DayNightParts {
  scene: THREE.Scene;
  sky: SkyDome;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  bulbMaterial: THREE.MeshBasicMaterial;
  cloudMaterial: THREE.MeshLambertMaterial;
  /** Uzak dağlar: ufuk rengiyle puslanır. */
  mountainMaterial: THREE.MeshLambertMaterial;
  /** Lamba konumları: gece çevrelerinde hale yanar. */
  bulbMatrices: THREE.Matrix4[];
  /** Ay yönü: gece ışık buradan gelir. */
  moonDir: THREE.Vector3;
}

/** Gökyüzü kubbesi: ufuk→tepe geçişi, güneş diski ve halesi, gün batımında ufukta sıcak bant. Tek draw call. */
export interface SkyDome {
  mesh: THREE.Mesh;
  radius: number;
  uniforms: {
    uHorizon: { value: THREE.Color };
    uTop: { value: THREE.Color };
    uSunDir: { value: THREE.Vector3 };
    uSunColor: { value: THREE.Color };
    uSun: { value: number };
    uDusk: { value: number };
  };
}

export function skyDome(radius: number): SkyDome {
  const uniforms = {
    uHorizon: { value: PAL.dayHorizon.clone() },
    uTop: { value: PAL.dayTop.clone() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: PAL.sunDiscDay.clone() },
    uSun: { value: 1 },
    uDusk: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon;
      uniform vec3 uTop;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSun;
      uniform float uDusk;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float y = max(d.y, 0.0);
        vec3 c = mix(uHorizon, uTop, pow(y, 0.7));
        float s = max(dot(d, uSunDir), 0.0);
        // Gün batımı: güneş tarafında ufka yayılan sıcak bant, karşı tarafta mor gölge
        float band = pow(1.0 - y, 5.0);
        c = mix(c, c * vec3(0.78, 0.7, 1.08), band * uDusk * (1.0 - s) * 0.6);
        c += vec3(1.0, 0.42, 0.2) * band * pow(s, 3.0) * uDusk * 0.75;
        // Hale ve disk (disk HDR: parıltı onu yakalar, ton eşleme yumuşatır)
        c += uSunColor * (pow(s, 8.0) * 0.28 + pow(s, 90.0) * 0.55) * uSun;
        c += uSunColor * smoothstep(0.99935, 0.99965, s) * 5.0 * uSun;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
  mesh.renderOrder = -1;
  mesh.matrixAutoUpdate = false;
  return { mesh, radius, uniforms };
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
        // Uzaktaki lamba da seçilsin: hale mesafeyle büyür (ekranda küçülüp kaybolmaz)
        s *= 1.0 + clamp(-center.z / 25.0, 0.0, 3.0);
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

/**
 * Kayan yıldızlar: birkaç çizgi, tamamen vertex shader'da. Her biri kendi aralığıyla (8–20 sn) gökte rastgele
 * bir yerden aşağı doğru kısa bir iz çizip söner; herkes aynı saatle aynı anda görür (tohum sabit).
 */
const METEORS = 4;
function meteors(radius: number): THREE.LineSegments {
  const seed = new Float32Array(METEORS * 2), end = new Float32Array(METEORS * 2);
  for (let i = 0; i < METEORS; i++) {
    seed.set([i + 0.37, i + 0.37], i * 2);
    end.set([0, 1], i * 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(METEORS * 6), 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  g.setAttribute("aEnd", new THREE.BufferAttribute(end, 1));
  const m = new THREE.LineSegments(
    g,
    new THREE.ShaderMaterial({
      uniforms: { uTime: timeUniform, uOpacity: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        attribute float aEnd;
        uniform float uTime;
        varying float vA;
        float h(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
        void main() {
          float period = 8.0 + h(aSeed) * 12.0;
          float k = (uTime + h(aSeed * 3.1) * 60.0) / period;
          float cycle = floor(k);
          float t = fract(k) * period;
          float dur = 0.7 + h(aSeed + cycle) * 0.5;
          float az = h(cycle * 1.7 + aSeed) * 6.2832;
          float el = 0.35 + h(cycle * 2.3 + aSeed) * 0.4;
          vec3 start = vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el));
          // Yana ve aşağı kayar
          vec3 side = normalize(cross(start, vec3(0.0, 1.0, 0.0)));
          vec3 vel = normalize(side * (h(cycle + aSeed * 5.0) > 0.5 ? 1.0 : -1.0) - vec3(0.0, 0.55, 0.0)) * 0.32;
          float p = clamp(t / dur, 0.0, 1.0);
          vec3 head = normalize(start + vel * p);
          vec3 tail = normalize(start + vel * max(p - 0.35, 0.0));
          vec3 pos = mix(head, tail, aEnd) * ${radius.toFixed(1)};
          vA = t < dur ? sin(p * 3.1416) * (1.0 - aEnd) : 0.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying float vA;
        void main() {
          gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * 2.2, vA * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    }),
  );
  m.frustumCulled = false;
  m.matrixAutoUpdate = false;
  m.renderOrder = -1;
  return m;
}

/** Hava → gökyüzünün kapalılığı (0 açık, 1 tamamen kapalı), sis mesafeleri ve bulut gölgesi kapsamı. */
function weatherLook(w: Weather): { overcast: number; fog: [number, number]; shadows: number } {
  switch (w.kind) {
    case "rain":
    case "storm":
      return { overcast: w.kind === "storm" ? 0.92 : 0.8, fog: [22, 95], shadows: 0 };
    case "snow":
      return { overcast: 0.75, fog: [18, 80], shadows: 0 };
    case "fog":
      return { overcast: 0.6, fog: [6, 55], shadows: 0 };
    case "cloudy":
      return { overcast: 0.25 + 0.35 * w.cloud, fog: [45, 130], shadows: 0.55 + 0.2 * w.cloud };
    default:
      return { overcast: 0.25 * w.cloud, fog: [55, 140], shadows: 0.25 + 0.3 * w.cloud };
  }
}

export class DayNight {
  /** Işığın geldiği yön (gündüz güneş, gece ay); gölge kamerası buna göre kurulur. */
  readonly lightDir = new THREE.Vector3(0, 1, 0);
  /** Havaya göre hesaplanan ortam ışığı (şimşek bunun üstüne eklenir). */
  hemiBase = 1.6;
  /** Güneşin (ya da ayın) havaya göre gücü; şimşek bunun üstüne eklenir. */
  sunBase = 1.7;
  /** Gösterilen saat (geçiş sırasında ara değer). */
  hour = 12;
  private weather: Weather = { kind: "clear", intensity: 0, cloud: 0.2, temp: null };
  private grey = new THREE.Color();
  private glow: THREE.InstancedMesh;
  private stars: THREE.Points;
  private meteors: THREE.LineSegments;
  private horizon = new THREE.Color();
  private top = new THREE.Color();
  private sunDir = new THREE.Vector3();
  private lastUpdate = -Infinity;
  /** Sabit saat (!saat, sinema, ayar), null: gerçek saat. Değişince eski saatten yumuşakça geçilir. */
  private forced: number | null = null;
  private fadeFrom = 0;
  private fadeStart = -Infinity;

  constructor(
    private p: DayNightParts,
    private override?: number,
    /** Diğer efektler için dışa açılan durum (gece ışıkları, toz rengi, parıltı vb.). */
    private env: { day: number; lights: number; dusk: number } = { day: 1, lights: 0, dusk: 0 },
  ) {
    this.glow = glowMesh(p.bulbMatrices);
    this.stars = starField(p.sky.radius * 0.95);
    this.meteors = meteors(p.sky.radius * 0.93);
    p.scene.add(this.glow, this.stars, this.meteors);
    this.stars.userData.sky = this.meteors.userData.sky = true;
    this.apply(Date.now());
  }

  /** İstanbul'un havası değişti: hemen uygula. */
  setWeather(w: Weather): void {
    this.weather = w;
    this.apply(Date.now());
  }

  /** Saati sabitle (null: gerçek saat); gök birkaç saniyede kayarak oraya varır. */
  setHour(h: number | null, nowMs = Date.now()): void {
    if (h === this.forced) return;
    this.fadeFrom = this.hourAt(nowMs);
    this.forced = h;
    this.fadeStart = nowMs;
  }

  /** O an gösterilen saat: geçiş sürüyorsa eski saatten yenisine kısa yoldan kayar. */
  private hourAt(nowMs: number): number {
    const to = this.forced ?? istanbulHour(nowMs, this.override);
    const k = (nowMs - this.fadeStart) / HOUR_FADE_MS;
    if (k >= 1) return to;
    const d = ((to - this.fadeFrom + 36) % 24) - 12;
    return (this.fadeFrom + d * k * k * (3 - 2 * k) + 24) % 24;
  }

  /** Her karede çağrılabilir; gerçek iş 3 saniyede bir (saat geçişi sürerken sık). */
  /** Hemen yeniden hesapla (ör. şimşek bitince güneş rengi geri gelsin). */
  refresh(): void {
    this.apply(Date.now());
  }

  update(nowMs: number): void {
    const fading = nowMs - this.fadeStart < HOUR_FADE_MS + 100;
    if (nowMs - this.lastUpdate < (fading ? 50 : 3000)) return;
    this.apply(nowMs);
  }

  private apply(nowMs: number): void {
    this.lastUpdate = nowMs;
    const p = this.p;
    const h = this.hourAt(nowMs);
    this.hour = h;
    const day = daylight(h);
    const dusk = duskAmount(h) * 0.75;

    const wl = weatherLook(this.weather);
    const oc = wl.overcast;
    this.horizon.copy(PAL.nightHorizon).lerp(PAL.dayHorizon, day).lerp(PAL.duskHorizon, dusk * (1 - oc * 0.8));
    this.top.copy(PAL.nightTop).lerp(PAL.dayTop, day).lerp(PAL.duskTop, dusk * 0.6 * (1 - oc));
    // Kapalı hava: gök griye döner (gece daha az fark edilir)
    const lum = (c: THREE.Color) => c.r * 0.3 + c.g * 0.55 + c.b * 0.15;
    this.horizon.lerp(this.grey.setRGB(1, 1, 1.04).multiplyScalar(lum(this.horizon) * 0.95), oc * 0.75);
    this.top.lerp(this.grey.setRGB(1, 1, 1.05).multiplyScalar(lum(this.top) * 0.9 + 0.04 * day), oc * 0.8);
    (p.scene.background as THREE.Color).copy(this.horizon);
    const fog = p.scene.fog as THREE.Fog;
    fog.color.copy(this.horizon);
    fog.near = wl.fog[0];
    fog.far = wl.fog[1];
    cloudUniform.value = wl.shadows * day;

    // Gökyüzü: renkler ve güneş
    sunDirection(h, this.sunDir);
    const u = p.sky.uniforms;
    u.uHorizon.value.copy(this.horizon);
    u.uTop.value.copy(this.top);
    u.uSunDir.value.copy(this.sunDir);
    u.uSunColor.value.copy(PAL.sunDiscDay).lerp(PAL.sunDiscDusk, Math.min(1, dusk * 1.4));
    u.uSun.value = smooth(-0.04, 0.03, this.sunDir.y) * (1 - oc);
    u.uDusk.value = dusk * (1 - oc * 0.8);

    // Işık yönü: güneş ufka inerken de zemin aydınlansın diye en az ~25° (gölgeler uzar ama kararmaz); gece ay
    const lit = this.sunDir.clone();
    lit.y = Math.max(lit.y, 0.42);
    this.lightDir.copy(p.moonDir).normalize().lerp(lit.normalize(), day).normalize();

    // Gece daha karanlık: lambaların aydınlattığı yerler öne çıksın
    // Gün batımında gök daha çok aydınlatır: güneşe karşı bakınca gölgede kalan yüzler kararmasın
    this.hemiBase = (0.34 + 1.26 * day + 0.5 * dusk) * (1 - 0.12 * oc);
    p.hemi.intensity = this.hemiBase;
    p.hemi.color.copy(PAL.hemiNightSky).lerp(PAL.hemiDaySky, day).lerp(PAL.hemiDuskSky, dusk * 0.5);
    p.hemi.groundColor.copy(PAL.hemiNightGround).lerp(PAL.hemiDayGround, day);
    this.sunBase = (0.32 + 1.38 * day) * (1 - 0.72 * oc);
    p.sun.intensity = this.sunBase;
    p.sun.color.copy(PAL.moon).lerp(PAL.sunDay, day).lerp(PAL.sunDusk, dusk);
    // Gölge: gündüz koyu, ay ışığında silik
    p.sun.shadow.intensity = (0.3 + 0.45 * day) * (1 - oc * 0.8);

    // Hava kararınca lambalar yanar
    const lights = 1 - smooth(0.25, 0.7, day);
    this.env.day = day;
    this.env.lights = lights;
    this.env.dusk = dusk;
    p.bulbMaterial.color.copy(PAL.bulbOff).lerp(PAL.bulbOn, lights);
    (this.glow.material as THREE.ShaderMaterial).uniforms.uOpacity.value = lights * 0.55;
    this.glow.visible = lights > 0.01;

    const starA = (1 - smooth(0.0, 0.35, day)) * 0.9 * (1 - oc);
    (this.stars.material as THREE.PointsMaterial).opacity = starA;
    this.stars.visible = starA > 0.01;
    (this.meteors.material as THREE.ShaderMaterial).uniforms.uOpacity.value = starA;
    this.meteors.visible = starA > 0.05;

    p.cloudMaterial.color.copy(PAL.cloudNight).lerp(PAL.cloudDay, day).multiplyScalar(1 - oc * 0.45);
    p.cloudMaterial.emissive.copy(PAL.cloudGlowNight).lerp(PAL.cloudGlowDay, day).lerp(PAL.cloudGlowDusk, dusk);
    // Dağlar ufuk rengine karışır (hava perspektifi): uzak, puslu, gün batımında pembe-mor
    p.mountainMaterial.emissive.copy(this.horizon).multiplyScalar(0.22 + 0.12 * day);
  }
}
