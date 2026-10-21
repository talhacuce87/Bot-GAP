// Prosedürel sahne için ortak yardımcılar: renkli geometri parçaları, instancing ve rüzgâr shader'ı.
import * as THREE from "three";

export function rng(seed: number): () => number {
  // mulberry32: herkes aynı dünyayı görsün diye sabit tohumlu.
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tmpColor = new THREE.Color();

/** Geometriyi index'siz, uv'siz hale getirip dönüştürür ve tek renge boyar. */
export function part(
  geo: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  m?: THREE.Matrix4,
  jitter = 0,
  rand?: () => number,
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  if (m) g.applyMatrix4(m);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  tmpColor.set(color);
  for (let i = 0; i < n; i += 3) {
    // Üçgen başına küçük ton farkı: doku olmadan "el yapımı" görünüm.
    const k = jitter && rand ? 1 + (rand() - 0.5) * jitter : 1;
    for (let v = 0; v < 3 && i + v < n; v++) {
      colors[(i + v) * 3] = tmpColor.r * k;
      colors[(i + v) * 3 + 1] = tmpColor.g * k;
      colors[(i + v) * 3 + 2] = tmpColor.b * k;
    }
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);

export function mat(x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromAxisAngle(_y, ry), _s.set(sx, sy, sz));
}

/** Yatay (XZ) düzleme yatırılmış dönüşüm; zemine serilen düz şekiller için. */
export function flatMat(x: number, y: number, z: number, sx = 1, sz = sx, ry = 0): THREE.Matrix4 {
  return mat(x, y, z, ry, sx, 1, sz).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
}

export function instanced(geo: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, matrices.length));
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.count = matrices.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Tüm animasyonlu shader'ların paylaştığı saat (saniye). Kare başına tek atama. */
export const timeUniform = { value: 0 };

/**
 * Rüzgâr: yerel yüksekliğe orantılı, örnek konumuna göre faz kaydırmalı salınım.
 * Tamamen vertex shader'da; CPU maliyeti yok.
 */
export function windMaterial(
  strength: number,
  params: THREE.MeshLambertMaterialParameters = {},
  /** [başla, bitir] metre: bu mesafede örnek toprağa gömülür (çimen/çiçek için ucuz LOD). */
  fade?: [number, number],
): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, ...params });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
        #else
          vec2 ip = vec2(0.0);
        #endif
        // Haritayı yavaşça geçen rüzgâr dalgası: ağaçlar sırayla eğilir.
        float gust = 0.55 + 0.45 * sin(uTime * 0.35 - ip.x * 0.045 - ip.y * 0.03);
        float sway = gust * (sin(uTime * 1.6 + ip.x * 0.31 + ip.y * 0.23) + 0.4 * sin(uTime * 3.1 + ip.x * 0.7));
        float h = max(position.y, 0.0);
        // Yaprak hışırtısı: yerel konuma bağlı, ortak köşeler aynı yer değiştirir, yüzeyler kopmaz.
        float flutter = sin(uTime * 6.0 + position.x * 4.0 + position.z * 3.0 + ip.x) * gust * ${(strength * 0.35).toFixed(4)} * h;
        transformed.x += sway * ${strength.toFixed(4)} * h + flutter;
        transformed.y += flutter * 0.5;
        transformed.z += sway * ${(strength * 0.6).toFixed(4)} * h - flutter;
        ${fade ? `
        #ifdef USE_INSTANCING
          vec4 wp = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          transformed *= 1.0 - smoothstep(${fade[0].toFixed(1)}, ${fade[1].toFixed(1)}, distance(wp.xz, cameraPosition.xz));
        #endif` : ""}`,
      );
  };
  m.customProgramCacheKey = () => `wind-${strength}-${fade ?? ""}`;
  return m;
}

/** Alev titremesi: Y ekseninde ölçek salınımı (meşaleler, mangal közü). */
export function flickerMaterial(color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float seed = instanceMatrix[3].x * 1.7 + instanceMatrix[3].z;
        #else
          float seed = 0.0;
        #endif
        float f = 1.0 + 0.18 * sin(uTime * 13.0 + seed) + 0.1 * sin(uTime * 23.0 + seed * 2.0);
        transformed.y *= f;
        transformed.xz *= 1.0 + 0.08 * sin(uTime * 17.0 + seed);`,
      );
  };
  m.customProgramCacheKey = () => "flicker";
  return m;
}

/** Yumuşak yuvarlak zemin gölgesi dokusu (ağaç, avatar, obje altları). */
export function blobTexture(alpha = 0.45): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(0,0,0,${alpha})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Bulut gölgesi kapsamı (0 açık gökyüzü, 1 kapalı); DayNight havaya göre yazar. */
export const cloudUniform = { value: 0.35 };

const CLOUD_GLSL = /* glsl */ `
  uniform float uCloud;
  uniform float uCloudTime;
  varying vec2 vCloudXZ;
  float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float cNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(cHash(i), cHash(i + vec2(1.0, 0.0)), u.x), mix(cHash(i + vec2(0.0, 1.0)), cHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float cloudShade(vec2 w) {
    vec2 q = w * 0.016 + uCloudTime * vec2(0.012, 0.005);
    float n = cNoise(q) * 0.6 + cNoise(q * 2.3 + 4.1) * 0.3 + cNoise(q * 5.1 + 9.3) * 0.1;
    float cover = smoothstep(1.0 - uCloud, 1.15 - uCloud, n);
    return 1.0 - cover * 0.6;
  }
`;

/**
 * Bulut gölgesi: güneşin doğrudan ışığını, rüzgârla kayan bulut desenine göre kısar (ortam ışığı kalır).
 * Var olan onBeforeCompile korunur; dünya konumu sis hesabından hemen önce alınır (instancing dahil).
 */
export function withCloudShadows<T extends THREE.Material>(m: T): T {
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uCloud = cloudUniform;
    shader.uniforms.uCloudTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vCloudXZ;")
      .replace(
        "#include <fog_vertex>",
        `#include <fog_vertex>
        #ifdef USE_INSTANCING
          vCloudXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;
        #else
          vCloudXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${CLOUD_GLSL}`)
      .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\nreflectedLight.directDiffuse *= cloudShade(vCloudXZ);");
  };
  m.customProgramCacheKey = () => `${prevKey()}-cloud`;
  return m;
}

/** Zemin ıslaklığı (0 kuru, 1 sırılsıklam): yağmurda artar, bitince yavaşça kurur (scene.ts yazar). */
export const wetUniform = { value: 0 };
/** Islak zeminin yansıttığı gök renkleri ve güneş yönü (scene.ts gökyüzü uniform'larına bağlar). */
export const wetEnv = {
  uWetSkyH: { value: new THREE.Color("#a9cfee") },
  uWetSkyT: { value: new THREE.Color("#5b8fd6") },
  uWetSun: { value: new THREE.Vector3(0, 1, 0) },
  uWetRain: { value: 0 },
};

const WET_GLSL = /* glsl */ `
  uniform float uWet;
  uniform float uWetTime;
  uniform float uWetRain;
  uniform vec3 uWetSkyH;
  uniform vec3 uWetSkyT;
  uniform vec3 uWetSun;
  varying vec3 vWetPos;
  float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), u.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
`;

/**
 * Islak zemin: yağmurda yukarı bakan yüzeyler koyulaşır, çukurlarda su birikir. Birikintiler gökyüzünü,
 * güneşi ve gece yakındaki lambaları (gerçek nokta ışıkları) yansıtır; yağarken içlerinde halkalar açılır.
 * Kuruyken (uWet = 0) dal hemen atlanır.
 */
export function withWetness<T extends THREE.Material>(m: T): T {
  const prev = m.onBeforeCompile.bind(m);
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uWet = wetUniform;
    shader.uniforms.uWetTime = timeUniform;
    Object.assign(shader.uniforms, wetEnv);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWetPos;")
      .replace(
        "#include <fog_vertex>",
        `#include <fog_vertex>
        #ifdef USE_INSTANCING
          vWetPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vWetPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${WET_GLSL}`)
      .replace(
        "#include <opaque_fragment>",
        `{
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float up = dot(normalize(normal), upV);
          if (uWet > 0.002 && up > 0.8 && vWetPos.y < 1.5) {
            float n = wNoise(vWetPos.xz * 0.32) * 0.65 + wNoise(vWetPos.xz * 1.1 + 3.7) * 0.35;
            float puddle = smoothstep(0.68 - uWet * 0.14, 0.72 - uWet * 0.14, n) * smoothstep(0.3, 0.8, uWet);
            float damp = uWet * smoothstep(0.8, 0.95, up);
            // Islak toprak/taş koyulaşır; birikintinin dibi daha da koyu
            outgoingLight *= 1.0 - damp * 0.32 - puddle * 0.3;
            // Yağmur halkaları: birikintide hücre başına rastgele anda açılan halka, yüzeyi oynatır
            vec2 g = vWetPos.xz * 2.2;
            vec2 id = floor(g);
            float h = wHash(id);
            float t = fract(uWetTime * 1.1 + h);
            vec2 c = id + 0.5 + (vec2(h, fract(h * 7.3)) - 0.5) * 0.6;
            float rr = abs(length(g - c) - t * 0.45);
            float ring = (1.0 - smoothstep(0.0, 0.06, rr)) * (1.0 - t) * uWetRain * step(h, 0.4) * puddle;
            vec3 Nw = normalize(vec3((wNoise(vWetPos.xz * 4.0 + uWetTime * 0.3) - 0.5) * 0.05 + ring * 0.08, 1.0, ring * 0.06));
            vec3 V = normalize(cameraPosition - vWetPos);
            vec3 R = reflect(-V, Nw);
            float fres = 0.05 + 0.95 * pow(1.0 - max(dot(V, Nw), 0.0), 5.0);
            float refl = (damp * 0.35 + puddle) * fres;
            vec3 sky = mix(uWetSkyH, uWetSkyT, pow(max(R.y, 0.0), 0.6));
            outgoingLight = mix(outgoingLight, sky, clamp(refl, 0.0, 0.85));
            float spec = (damp * 0.4 + puddle);
            outgoingLight += vec3(1.0, 0.95, 0.85) * pow(max(dot(R, normalize(uWetSun)), 0.0), 380.0) * 1.5 * spec * smoothstep(-0.05, 0.1, uWetSun.y);
            // Gece lambaları: ıslak yüzeyde uzayan parlak yansımalar (yalnızca gerçek nokta ışıkları)
            #if NUM_POINT_LIGHTS > 0
            vec3 Vv = normalize(vViewPosition);
            vec3 Nv = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
            for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
              vec3 Lv = pointLights[i].position + vViewPosition;
              float dist = length(Lv);
              float att = pointLights[i].distance > 0.0 ? pow(clamp(1.0 - dist / pointLights[i].distance, 0.0, 1.0), 2.0) : 0.0;
              vec3 Hv = normalize(normalize(Lv) + Vv);
              outgoingLight += pointLights[i].color * pow(max(dot(Nv, Hv), 0.0), 260.0) * att * spec * 0.05;
            }
            #endif
            outgoingLight += uWetSkyH * ring * 0.25;
          }
        }
        #include <opaque_fragment>`,
      );
  };
  m.customProgramCacheKey = () => `${prevKey()}-wet`;
  return m;
}
