// Tofaşlar: Tofaşla gezen her oyuncunun (sen ve uzaktakiler) arabası, konumunda ve yönünde çizilir.
// Sürücü avatarı sol öndeki koltukta, yolcular sağ önde ve arkada oturur. Aynı görünümdeki arabalar ayrı ayrı kurulur (az sayıda).
// Gece sürülen arabaların farları yanar: en yakın birkaçının ışığı yolu, duvarları ve insanları gerçekten
// aydınlatır (lamps.ts'in ızgaralı gece ışığı); havada huzme yalnızca yağmurda görünür. Düşük grafikte gerçek
// ışık yok: yolda ışık lekesi taklit eder.
import * as THREE from "three";
import { FLAG_SEATED } from "../../shared/constants";
import type { CarSpec } from "../../shared/car";
import type { AvatarView } from "./avatars/avatars";
import { wetEnv } from "./world/geo";
import { type LampField, MAX_CARS } from "./world/lamps";
import { buildTofas, type TofasMesh } from "./world/tofas";

/** Koltuklar (0 sürücü sol ön, 1 sağ ön, 2 sol arka, 3 sağ arka): merkezden yana ve arkaya; oturma yüzeyi alçak. */
const SEATS: [number, number][] = [[0.33, -0.25], [-0.33, -0.25], [0.33, -1.0], [-0.33, -1.0]];
const SEAT_DROP = -0.58;

interface Entry {
  key: string;
  mesh: TofasMesh;
  seen: boolean;
  /** Önceki karedeki yer (tekerlek dönüşü ve direksiyon buradan) ve yumuşatılmış direksiyon açısı. */
  x: number;
  z: number;
  rot: number;
  steer: number;
  /** Farlar yanıyor mu (gerçek far ışığı yalnızca bunlara). */
  lit: boolean;
}

export interface CarsOptions {
  /** Farlar gece yansın mı (sürülen arabalar evet, park halindekiler hayır). */
  headlights?: boolean;
  /** Gerçek gece ışığı (yoksa düşük grafik: farlar yolda ışık lekesiyle taklit edilir). */
  lamps?: LampField | null;
}

/** Farın arabanın merkezinden önü ve yerden yüksekliği. */
const HEAD_AHEAD = 2.3;
const HEAD_Y = 0.7;

/** Aks aralığı (direksiyon açısı için) ve en büyük direksiyon açısı. */
const WHEELBASE = 2.49;
const MAX_STEER = 0.5;
/** İnilen arabaların bu kadarı gizli bekletilir: tekrar binince Tofaş yeniden kurulmaz (~10 ms). */
const SPARE_MAX = 3;

export class Cars {
  private entries = new Map<number, Entry>();
  /** Kurulmuş ama şu an kimsenin binmediği arabalar (görünüm anahtarıyla). */
  private spare = new Map<string, TofasMesh>();
  private seated = new Map<number, AvatarView>();
  private night = 0;
  private focus = { x: 0, z: 0 };
  /** NPC arabalar (trafik): gerçek far ışığı oyuncu arabalarıyla birlikte en yakınlara verilir. */
  extra: { list: () => { x: number; z: number; rot: number }[]; night: number } | null = null;
  private static readonly NPC_HEAD = new THREE.Color("#fff6dc");

  constructor(
    private scene: THREE.Scene,
    private opts: CarsOptions = {},
  ) {}

  /** Kare başı; `fx/fz`: gerçek far ışığının hangi arabalara verileceği (en yakınlar). */
  begin(fx = 0, fz = 0): void {
    this.focus.x = fx;
    this.focus.z = fz;
    for (const e of this.entries.values()) e.seen = false;
  }

  /**
   * Bu kare `sid`in arabası (x, z, rot) — yoksa çağırma. `lights`: farlar açık / kapalı; verilmezse gece
   * kendiliğinden yanar.
   */
  push(sid: number, spec: CarSpec, x: number, z: number, rot: number, night: number, dmg = 0, lights: boolean | null = null): void {
    const key = JSON.stringify(spec);
    let e = this.entries.get(sid);
    if (!e || e.key !== key) {
      if (e) this.drop(sid);
      const mesh = this.take(key, spec);
      e = { key, mesh, seen: true, x, z, rot, steer: 0, lit: false };
      this.entries.set(sid, e);
    }
    e.seen = true;
    // Tekerlekler: arabanın baktığı yönde gidilen yol kadar yuvarlanır (geri giderken ters); ön tekerlekler
    // dönüş hızından bulunan direksiyon açısıyla döner. Işınlanma (bir karede > 4 m) sayılmaz.
    const dx = x - e.x, dz = z - e.z;
    if (Math.hypot(dx, dz) < 4) {
      const d = dx * Math.sin(rot) + dz * Math.cos(rot);
      const dr = Math.atan2(Math.sin(rot - e.rot), Math.cos(rot - e.rot));
      const want = Math.abs(d) > 0.004 ? Math.max(-MAX_STEER, Math.min(MAX_STEER, Math.atan((dr * WHEELBASE) / d))) : e.steer * 0.9;
      e.steer += (want - e.steer) * 0.25;
      e.mesh.roll(d, e.steer);
    }
    e.x = x;
    e.z = z;
    e.rot = rot;
    e.mesh.group.position.set(x, 0, z);
    e.mesh.group.rotation.y = rot;
    e.mesh.setNight(night);
    e.mesh.setDamage(dmg);
    // Açık farlar gündüz de yanar (camlar parlar); gerçek ışık yalnızca gece görünür
    const head = !this.opts.headlights || lights === false ? 0 : lights ? Math.max(night, 0.45) : night;
    e.lit = head > 0.01;
    e.mesh.setHeadlights(head, { decal: !this.opts.lamps, haze: wetEnv.uWetRain.value });
    this.night = night;
  }

  /** Bu kare görünmeyen arabaları kaldırır; gerçek far ışığını en yakın arabalara verir. */
  end(): void {
    for (const [sid, e] of this.entries) if (!e.seen) this.drop(sid);
    const lamps = this.opts.lamps;
    if (!lamps || !this.opts.headlights) return;
    const night = Math.max(this.entries.size ? this.night : 0, this.extra?.night ?? 0);
    if (night < 0.01) return lamps.setHeadlights([]);
    const all: { x: number; z: number; rot: number; color: THREE.Color }[] = [...this.entries.values()].filter((e) => e.lit).map((e) => ({ x: e.x, z: e.z, rot: e.rot, color: e.mesh.headColor }));
    if (this.extra) for (const c of this.extra.list()) all.push({ x: c.x, z: c.z, rot: c.rot, color: Cars.NPC_HEAD });
    const f = this.focus;
    all.sort((a, b) => (a.x - f.x) ** 2 + (a.z - f.z) ** 2 - ((b.x - f.x) ** 2 + (b.z - f.z) ** 2));
    lamps.setHeadlights(
      all.slice(0, MAX_CARS).map((e) => {
        const dx = Math.sin(e.rot), dz = Math.cos(e.rot);
        return { x: e.x + dx * HEAD_AHEAD, y: HEAD_Y, z: e.z + dz * HEAD_AHEAD, dx, dz, color: e.color };
      }),
    );
  }

  /**
   * Yükleme ekranında kendi arabanı kurar (gizli bekler): ilk binişte kurulum ve shader derlemesi olmasın.
   */
  prewarm(spec: CarSpec): void {
    const key = JSON.stringify(spec);
    if (!this.spare.has(key)) this.keep(key, this.build(spec));
  }

  private build(spec: CarSpec): TofasMesh {
    const mesh = buildTofas(spec);
    this.scene.add(mesh.group);
    return mesh;
  }

  /** Bekleyen aynı görünümlü araba varsa o, yoksa yenisi. */
  private take(key: string, spec: CarSpec): TofasMesh {
    const mesh = this.spare.get(key);
    if (!mesh) return this.build(spec);
    this.spare.delete(key);
    mesh.group.visible = true;
    return mesh;
  }

  private keep(key: string, mesh: TofasMesh): void {
    if (this.spare.has(key) || this.spare.size >= SPARE_MAX) {
      this.scene.remove(mesh.group);
      mesh.dispose();
      return;
    }
    mesh.group.visible = false;
    this.spare.set(key, mesh);
  }

  private drop(sid: number): void {
    const e = this.entries.get(sid);
    if (!e) return;
    this.keep(e.key, e.mesh);
    this.entries.delete(sid);
    this.seated.delete(sid);
  }

  /**
   * Arabadaki oyuncunun avatarı: sürücü koltuğunda. Çizgi karakter oturunca bile Tofaşın tavanından yüksek
   * (kabine sığdırınca bacakları arabanın altından sarkıyordu); gövde çizilmez, isim etiketi tavanın üstünde kalır.
   */
  seat(sid: number, v: AvatarView, seat = 0, car: { x: number; z: number; rot: number } = v): AvatarView {
    let s = this.seated.get(sid);
    if (!s) this.seated.set(sid, (s = { ...v }));
    Object.assign(s, v);
    const [side, back] = SEATS[seat] ?? SEATS[0];
    const c = Math.cos(car.rot), sn = Math.sin(car.rot);
    s.x = car.x + c * side + sn * back;
    s.z = car.z - sn * side + c * back;
    s.rot = car.rot;
    s.flags = FLAG_SEATED;
    s.bodyHidden = true;
    s.baseY = SEAT_DROP;
    s.jumpY = 0;
    s.lift = 0;
    return s;
  }

  dispose(): void {
    for (const sid of [...this.entries.keys()]) this.drop(sid);
  }
}
