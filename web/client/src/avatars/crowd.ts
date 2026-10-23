// NPC kalabalığı: birkaç sabit kıyafet, her biri tek InstancedMesh (chibi paketinin uzak görünümü, LOD1) ve
// oyuncularla aynı kontur. Uzuv açıları vertex shader'da örnek başına poz niteliğinden (salınım, oturma, el
// sallama, telefon) bulunur; gölge haritası yok (zemin lekesi var). Onlarca yaya ~20 draw call.
import * as THREE from "three";
import type { Look } from "../../../shared/protocol";
import { blobTexture, boundInstances } from "../world/geo";
import { CHIBI_SCALE } from "./chibi";
import { type ChibiPack, LIMB_COUNT } from "./chibiPack";

/** Kıyafet başına en çok bu kadar yaya çizilir. */
const PER_OUTFIT = 48;
/** Kontur: chibi.ts ile aynı kalınlık ve kameradan itme (oyuncularla aynı çizgi). */
const OUTLINE_WIDTH = 0.012;
const OUTLINE_PUSH = 0.03;
/** Bundan uzakta kontur pikselden ince: çizilmez (yarı üçgen). Yayalar yakından uzağa gelir. */
const OUTLINE_R = 28;
/** Bundan uzaktakiler daha kaba görünümle (LOD2, ~1/5 üçgen) çizilir. */
const NEAR_R = 18;

const CROWD_GLSL = /* glsl */ `
  attribute vec4 aPose;
  attribute float aLimb;
  attribute float aOutline;
  uniform vec3 uPivot[${LIMB_COUNT}];
  mat3 crowdMat(vec2 a) {
    float cx = cos(a.x), sx = sin(a.x), cz = cos(a.y), sz = sin(a.y);
    mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
    mat3 rz = mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
    return rz * rx;
  }
  // chibi.ts setLimbs'in alt kümesi: x salınım, y oturma, z > 0 el sallama / z < 0 telefon, w saat
  vec2 crowdLimb(int i) {
    vec2 a = vec2(0.0);
    float s = aPose.x;
    if (i == 2) a.x = -s * 0.9;
    if (i == 3) a.x = s * 0.9;
    if (aPose.y > 0.5) {
      if (i == 4 || i == 5) a.x = -1.45;
    } else {
      if (i == 4) a.x = s;
      if (i == 5) a.x = -s;
    }
    if (i == 3 && aPose.z > 0.0) a = vec2(0.0, (1.65 + sin(aPose.w * 14.0) * 0.2) * aPose.z);
    if (i == 3 && aPose.z < 0.0) a = vec2(-2.3, 0.5) * -aPose.z;
    return a;
  }
`;

export interface CrowdPose {
  /** Kol/bacak salınımı (radyan). */
  swing: number;
  seated: boolean;
  /** 0..1 el sallama. */
  wave: number;
  /** 0..1 telefonla konuşma (el kulakta). */
  phone: number;
}

interface Batch {
  mesh: THREE.InstancedMesh;
  outline: THREE.InstancedMesh;
  pose: THREE.InstancedBufferAttribute;
  n: number;
  /** Konturu çizilen ilk örnek sayısı. */
  lined: number;
}

export class CrowdRenderer {
  readonly group = new THREE.Group();
  /** Kıyafet başına [yakın, uzak] (paket LOD2 taşımıyorsa yalnızca yakın). */
  private batches: Batch[][] = [];
  private shadow: THREE.InstancedMesh;
  private shadowN = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private tilt = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(CHIBI_SCALE, CHIBI_SCALE, CHIBI_SCALE);
  private up = new THREE.Vector3(0, 1, 0);
  private side = new THREE.Vector3(1, 0, 0);
  ready = false;

  constructor() {
    this.shadow = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.9, 0.9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: blobTexture(0.35), transparent: true, depthWrite: false }),
      PER_OUTFIT * 4,
    );
    this.shadow.count = 0;
    this.shadow.frustumCulled = false;
    this.shadow.renderOrder = 1;
    this.group.add(this.shadow);
  }

  /** Kıyafetlerin geometrisi kare kare kurulur (açılışta takılma olmasın). */
  async load(pack: ChibiPack, looks: Look[]): Promise<void> {
    const pivots = Array.from({ length: LIMB_COUNT }, (_, l) => new THREE.Vector3().fromArray(pack.pivots, l * 3));
    const patch = (shader: THREE.WebGLProgramParametersWithUniforms, outline: boolean) => {
      shader.uniforms.uPivot = { value: pivots };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${CROWD_GLSL}`)
        .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\nobjectNormal = crowdMat(crowdLimb(int(aLimb + 0.5))) * objectNormal;`)
        .replace(
          "#include <begin_vertex>",
          `int li = int(aLimb + 0.5);
           mat3 lm = crowdMat(crowdLimb(li));
           vec3 transformed = lm * (position - uPivot[li]) + uPivot[li];` +
            (outline ? `\ntransformed += normalize(lm * normal) * (${(OUTLINE_WIDTH / CHIBI_SCALE).toFixed(4)} * aOutline);` : ""),
        );
      if (outline) {
        shader.vertexShader = shader.vertexShader.replace(
          "#include <project_vertex>",
          `#include <project_vertex>\nmvPosition.z -= ${OUTLINE_PUSH.toFixed(3)};\ngl_Position = projectionMatrix * mvPosition;`,
        );
      }
    };
    const material = new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide });
    material.onBeforeCompile = (shader) => patch(shader, false);
    material.customProgramCacheKey = () => "crowd";
    const line = new THREE.MeshBasicMaterial({ color: 0x1c1622, side: THREE.BackSide });
    line.onBeforeCompile = (shader) => patch(shader, true);
    line.customProgramCacheKey = () => "crowd-outline";
    for (const look of looks) {
      // Kıyafetler arasında kareye nefes aldır
      await new Promise((r) => setTimeout(r, 0));
      const geo = pack.build(look, 1);
      const tiers = [geo];
      // Uzak görünüm aynı köşeleri kaba indeksle çizer (köşe belleği paylaşılır)
      const farIndex = geo.userData.farIndex as THREE.BufferAttribute | undefined;
      if (farIndex) {
        const g2 = new THREE.BufferGeometry();
        for (const name of ["position", "normal", "color", "aLimb", "aOutline"]) g2.setAttribute(name, geo.getAttribute(name));
        g2.setIndex(farIndex);
        g2.boundingSphere = geo.boundingSphere;
        tiers.push(g2);
      }
      this.batches.push(tiers.map((g) => this.batch(g, material, line)));
    }
    this.ready = true;
  }

  private batch(geo: THREE.BufferGeometry, material: THREE.Material, line: THREE.Material): Batch {
    const pose = new THREE.InstancedBufferAttribute(new Float32Array(PER_OUTFIT * 4), 4);
    pose.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aPose", pose);
    const mesh = new THREE.InstancedMesh(geo, material, PER_OUTFIT);
    mesh.receiveShadow = true;
    // Kontur aynı örnek matrislerini kullanır
    const outline = new THREE.InstancedMesh(geo, line, PER_OUTFIT);
    outline.instanceMatrix = mesh.instanceMatrix;
    // Örnekler her kare yer değiştirir: küre end()'de yeniden hesaplanır (iki mesh aynı küre)
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    mesh.boundingSphere = outline.boundingSphere = new THREE.Sphere();
    for (const m of [mesh, outline]) {
      m.count = 0;
      this.group.add(m);
    }
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return { mesh, outline, pose, n: 0, lined: 0 };
  }

  get outfits(): number {
    return this.batches.length;
  }

  private camX = 0;
  private camZ = 0;

  /** Kamera konumu: konturlar yalnızca yakındakilere (örnekler yakından uzağa itilmeli). */
  begin(camX = 0, camZ = 0): void {
    this.camX = camX;
    this.camZ = camZ;
    for (const tiers of this.batches) for (const b of tiers) b.n = b.lined = 0;
    this.shadowN = 0;
  }

  /**
   * Bir yaya: kıyafet, ayakların konumu (y zeminden), yön, poz. `fall` (radyan) gövdeyi geriye yatırır,
   * `scale` belirip kaybolurken küçültür.
   */
  push(outfit: number, x: number, y: number, z: number, rot: number, p: CrowdPose, time: number, fall = 0, scale = 1): void {
    const tiers = this.batches[outfit % this.batches.length];
    if (!tiers) return;
    const d2 = (x - this.camX) ** 2 + (z - this.camZ) ** 2;
    const b = tiers[d2 < NEAR_R * NEAR_R ? 0 : tiers.length - 1];
    if (b.n >= PER_OUTFIT) return;
    const i = b.n++;
    if (d2 < OUTLINE_R * OUTLINE_R) b.lined = b.n;
    this.q.setFromAxisAngle(this.up, rot);
    if (fall) this.q.multiply(this.tilt.setFromAxisAngle(this.side, -fall));
    this.v.set(x, y, z);
    this.s.setScalar(CHIBI_SCALE * scale);
    this.m.compose(this.v, this.q, this.s);
    b.mesh.setMatrixAt(i, this.m);
    b.pose.setXYZW(i, p.swing, p.seated ? 1 : 0, p.wave > 0 ? p.wave : -p.phone, time);
    if (this.shadowN < this.shadow.instanceMatrix.count) {
      this.m.makeScale(scale, 1, scale).setPosition(x, 0.04, z);
      this.shadow.setMatrixAt(this.shadowN++, this.m);
    }
  }

  end(): void {
    for (const b of this.batches.flat()) {
      b.mesh.count = b.n;
      b.outline.count = b.lined;
      // El sallama ve düşme pozu geometrinin dışına taşar: yarım metre pay
      if (b.n) boundInstances(b.mesh, 0.5);
      b.mesh.instanceMatrix.needsUpdate = true;
      b.pose.needsUpdate = true;
    }
    this.shadow.count = this.shadowN;
    this.shadow.instanceMatrix.needsUpdate = true;
  }
}
