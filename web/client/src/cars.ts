// Tofaşlar: Tofaşla gezen her oyuncunun (sen ve uzaktakiler) arabası, konumunda ve yönünde çizilir.
// Sürücü avatarı sol öndeki koltukta oturur. Aynı görünümdeki arabalar ayrı ayrı kurulur (az sayıda).
import * as THREE from "three";
import { FLAG_SEATED } from "../../shared/constants";
import type { CarSpec } from "../../shared/car";
import type { AvatarView } from "./avatars/avatars";
import { buildTofas, type TofasMesh } from "./world/tofas";

/** Sürücü koltuğu: arabanın merkezinden sola ve biraz arkaya; oturma yüzeyi alçak. */
const SEAT_SIDE = 0.33;
const SEAT_BACK = -0.25;
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
}

/** Aks aralığı (direksiyon açısı için) ve en büyük direksiyon açısı. */
const WHEELBASE = 2.49;
const MAX_STEER = 0.5;

export class Cars {
  private entries = new Map<number, Entry>();
  private seated = new Map<number, AvatarView>();

  constructor(private scene: THREE.Scene) {}

  begin(): void {
    for (const e of this.entries.values()) e.seen = false;
  }

  /** Bu kare `sid`in arabası (x, z, rot) — yoksa çağırma. */
  push(sid: number, spec: CarSpec, x: number, z: number, rot: number, night: number): void {
    const key = JSON.stringify(spec);
    let e = this.entries.get(sid);
    if (!e || e.key !== key) {
      if (e) this.drop(sid);
      const mesh = buildTofas(spec);
      this.scene.add(mesh.group);
      e = { key, mesh, seen: true, x, z, rot, steer: 0 };
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
  }

  /** Bu kare görünmeyen arabaları kaldırır. */
  end(): void {
    for (const [sid, e] of this.entries) if (!e.seen) this.drop(sid);
  }

  private drop(sid: number): void {
    const e = this.entries.get(sid);
    if (!e) return;
    this.scene.remove(e.mesh.group);
    e.mesh.dispose();
    this.entries.delete(sid);
    this.seated.delete(sid);
  }

  /**
   * Arabadaki oyuncunun avatarı: sürücü koltuğunda. Çizgi karakter oturunca bile Tofaşın tavanından yüksek
   * (kabine sığdırınca bacakları arabanın altından sarkıyordu); gövde çizilmez, isim etiketi tavanın üstünde kalır.
   */
  seat(sid: number, v: AvatarView): AvatarView {
    let s = this.seated.get(sid);
    if (!s) this.seated.set(sid, (s = { ...v }));
    Object.assign(s, v);
    const c = Math.cos(v.rot), sn = Math.sin(v.rot);
    s.x = v.x + c * SEAT_SIDE + sn * SEAT_BACK;
    s.z = v.z - sn * SEAT_SIDE + c * SEAT_BACK;
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
