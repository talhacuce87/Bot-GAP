// Şehrin canlıları tek yerde: NPC yayalar (örnekli kalabalık), NPC trafik, güvercin sürüleri, sokak kedileri.
// Features her kare `update` çağırır: benzetim sabit adımla (~30 Hz, FixedStep) ilerler, çizim her kare son iki
// adımın arasından. Kediler evcil hayvan çizicisiyle (Companions) görünmez bir yürüyüşçünün peşinden gider.
import * as THREE from "three";
import { FLAG_RUNNING, FLAG_SEATED, FLAG_WALKING, outsideWorld, vehicleOf } from "../../../shared/constants";
import type { ClientEvent, Look } from "../../../shared/protocol";
import { CASINO, KAHVEHANE, PLAZA, SAKURA_SPOT } from "../../../shared/zones";
import { HOOD_PARK } from "../../../shared/build";
import manifest from "../../chibi/chibi.json";
import type { AvatarView } from "../avatars/avatars";
import type { ChibiLayer } from "../avatars/chibi";
import { type ChibiManifest, randomLook } from "../avatars/chibiPack";
import type { Companions } from "../avatars/companions";
import { CrowdRenderer } from "../avatars/crowd";
import type { Remotes } from "../avatars/remotes";
import type { Player } from "../player";
import { settings } from "../settings";
import type { Seat } from "../world/builder";
import { walkable } from "../world/terrain";
import { walkways } from "../world/walkways";
import { type Mover, type MyCar, PED_SID_BASE, Pedestrians } from "./pedestrians";
import { FixedStep } from "./fixedStep";
import { Pigeons, type Scarer } from "./pigeons";
import { AmbientTraffic, type TrafficMover } from "./traffic";
import { signalClock } from "../world/signals";

/** NPC kıyafetleri: sabit tohumlar (herkeste aynı yaya aynı kıyafette). */
const OUTFIT_SEEDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
/** Sokak kedileri: dolaştığı yerin merkezi ve yarıçapı; kimlikler oyuncu sid'leriyle çakışmaz. */
const CAT_ID_BASE = 70_000;
const CATS: [number, number, number][] = [
  [PLAZA.x - 3, PLAZA.z - 15, 3.5],
  [KAHVEHANE.x + 9, KAHVEHANE.z + 2, 3],
  [CASINO.x + 22, CASINO.z + 20, 4],
  [HOOD_PARK.x + 18, HOOD_PARK.z + 6, 4],
  [SAKURA_SPOT.x - 4, SAKURA_SPOT.z + 3, 3],
];
const CAT_DRAW_R = 90;
/** Kalabalık ayarı (Plan 1'in `settings.crowd` alanı): çarpan. Ayar yoksa cihaza göre. */
const CROWD_MUL: Record<string, number> = { off: 0, low: 0.5, normal: 1, high: 1.5 };

export interface CityLifeFrame {
  /** Kıyafet paketi ve kurulum işçisi (kalabalık için). */
  chibi: ChibiLayer;
  serverMs: number;
  /** Yerel animasyon saati (sn), avatarlarla aynı. */
  time: number;
  dt: number;
  camera: THREE.Vector3;
  hour: number;
  me: Player;
  remotes: Remotes;
  send(ev: ClientEvent): void;
}

export class CityLife {
  readonly group = new THREE.Group();
  private crowd = new CrowdRenderer();
  private peds: Pedestrians;
  private pigeons = new Pigeons();
  readonly traffic: AmbientTraffic;
  private trafficMovers: TrafficMover[] = [];
  private loading = false;
  private clock = new FixedStep();
  private movers: Mover[] = [];
  private scarers: Scarer[] = [];
  private prev = new Map<number, { x: number; z: number }>();
  private cats: AvatarView[];

  private taken: { x: number; z: number }[] = [];

  constructor(private lowPower: boolean, seats: Seat[]) {
    // Banklar: masa ve casino tabureleri değil; dünyanın içinde (stadyum ve salon tribünleri dışarıda)
    const benches = seats.filter((s) => !s.table && !s.game && outsideWorld(s.x, s.z) === 0);
    this.peds = new Pedestrians(walkways(), OUTFIT_SEEDS.length, benches, walkable);
    this.traffic = new AmbientTraffic(lowPower);
    this.group.add(this.crowd.group, this.pigeons.group, this.traffic.renderer.group);
    this.cats = CATS.map(([x, z], k) => ({
      x, z, rot: 0, flags: 0, alpha: 1, cell: -1, color: new THREE.Color(), phase: k * 1.7, emote: -1, emoteAt: 0, jumpY: 0, hidden: true,
    }));
  }

  /** Görünmeyen yayaları bu kare çizme (occlusion.ts; update'ten sonra). */
  cull(visible: (x: number, y: number, z: number, r: number) => boolean): void {
    this.crowd.cull(visible);
  }

  /** Kalabalık çarpanı: 0 kapalı. */
  private get mul(): number {
    const level = (settings as Partial<{ crowd: string }>).crowd;
    return level && level in CROWD_MUL ? CROWD_MUL[level] : this.lowPower ? 0.5 : 1;
  }

  /** Sunucu duyurdu: araba yayaya çarptı; söylenen cümleyi döndürür (konuşma balonu için). */
  hit(id: number, vx: number, vz: number, time: number): string | null {
    return this.peds.hit(id, vx, vz, time);
  }

  /** Konuşma balonunun yeri: yaya kimliği (PED_SID_BASE + id) ise. */
  anchor(sid: number): { x: number; z: number; y: number } | null {
    return sid >= PED_SID_BASE && sid < PED_SID_BASE + this.peds.count ? this.peds.anchor(sid - PED_SID_BASE) : null;
  }

  /**
   * Yükleme ekranında: trafik görünümlerinin mesh'leri ve kalabalık kıyafetleri (işçide) kurulur, shader ön
   * derlemesinden önce beklenir. Oyun sırasında NPC geometrisi kurulmaz.
   */
  prewarm(chibi: ChibiLayer): Promise<void> {
    // Kıyafetler işçide kurulurken arabalar burada
    const crowd = this.loadCrowd(chibi);
    this.traffic.renderer.prebuild();
    return crowd;
  }

  private loadCrowd(chibi: ChibiLayer): Promise<void> {
    if (this.loading || !chibi.pack) return Promise.resolve();
    this.loading = true;
    const looks: Look[] = OUTFIT_SEEDS.map((s) => randomLook(manifest as ChibiManifest, s));
    return this.crowd.load(chibi.pack, looks, (look) => chibi.bake(look, 1)!).catch((err) => console.warn("[kalabalık] kurulamadı:", err));
  }

  update(f: CityLifeFrame): void {
    // Paket yüklemede inmediyse kalabalık sonradan (işçide) kurulur
    if (f.chibi.pack && !this.loading) void this.loadCrowd(f.chibi);
    signalClock.ms = f.serverMs;
    const h = this.clock.advance(f.dt);
    if (h > 0) this.step(f, h);
    const a = this.clock.alpha;
    this.traffic.draw(a);
    this.peds.draw(this.crowd, f.time, a, f.camera);
    this.crowd.group.visible = this.mul > 0;
    this.pigeons.draw(f.time, a);
  }

  /** Benzetim adımı (`dt` adımın süresi): kim nerede, kim kimden kaçıyor, kim bekliyor. */
  private step(f: CityLifeFrame, dt: number): void {
    const { me, remotes } = f;
    // Hareket edenler: sen ve diğer oyuncular (arabadakilerin hızı kareden kareye konum farkından)
    this.movers.length = 0;
    this.scarers.length = 0;
    this.trafficMovers.length = 0;
    this.taken.length = 0;
    if (me.flags & FLAG_SEATED) this.taken.push(me);
    const waving = (v: AvatarView) => v.emote === 0 && f.time - v.emoteAt < 1.6;
    this.trafficMovers.push({ x: me.x, z: me.z, car: me.car ? { rot: me.rot } : null });
    if (!me.hidden) {
      const v = me.car?.v ?? 0;
      this.movers.push({ x: me.x, z: me.z, speed: Math.abs(v), vx: Math.sin(me.rot) * v, vz: Math.cos(me.rot) * v, wave: waving(me) });
      this.scarers.push({ x: me.x, z: me.z, fast: !!me.car || (me.flags & FLAG_RUNNING) !== 0 || vehicleOf(me.flags) !== 0 });
    }
    for (const r of remotes.map.values()) {
      if (!r.hasData || r.leaving) continue;
      if (r.flags & FLAG_SEATED) this.taken.push(r);
      this.trafficMovers.push({ x: r.x, z: r.z, car: r.info.car ? { rot: r.rot } : null });
      let vx = 0, vz = 0;
      const p = this.prev.get(r.info.sid);
      if (r.info.car && p && dt > 0) {
        vx = (r.x - p.x) / dt;
        vz = (r.z - p.z) / dt;
      }
      if (p) [p.x, p.z] = [r.x, r.z];
      else this.prev.set(r.info.sid, { x: r.x, z: r.z });
      const speed = r.info.car ? Math.hypot(vx, vz) : 0;
      this.movers.push({ x: r.x, z: r.z, speed, vx, vz, wave: waving(r) });
      this.scarers.push({ x: r.x, z: r.z, fast: !!r.info.car || (r.flags & FLAG_RUNNING) !== 0 || vehicleOf(r.flags) !== 0 });
    }
    if (this.prev.size > remotes.map.size + 8) for (const sid of this.prev.keys()) if (!remotes.map.has(sid)) this.prev.delete(sid);

    const myCar: MyCar | null = me.car ? { x: me.x, z: me.z, rot: me.rot, v: me.car.v } : null;
    const cam = { x: f.camera.x, z: f.camera.z };
    this.traffic.step(f.serverMs, dt, cam, f.hour, this.mul, this.trafficMovers);
    // Yayalar NPC arabalardan da kaçar (yakındakiler)
    for (const c of this.traffic.cars) {
      if (!c.shown || c.v < 4 || Math.abs(c.x - cam.x) > 60 || Math.abs(c.z - cam.z) > 60) continue;
      this.movers.push({ x: c.x, z: c.z, speed: c.v, vx: Math.sin(c.rot) * c.v, vz: Math.cos(c.rot) * c.v, wave: false });
    }
    this.peds.step(this.crowd, f.serverMs, f.time, dt, cam, f.hour, this.mul, this.movers, myCar, this.lowPower, f.send, this.taken);
    this.pigeons.step(f.time, dt, cam, this.scarers);
  }

  /**
   * Sokak kedileri: görünmez yürüyüşçü küçük bir halkada yürür-durur (12 sn'de 6 sn), kedi peşinden seker.
   * Konum sunucu saatinden: herkes kediyi aynı yerde görür.
   */
  pushCats(c: Companions, serverMs: number, time: number, dt: number, camera: THREE.Vector3): void {
    const t = serverMs / 1000;
    CATS.forEach(([x, z, r], k) => {
      if (Math.hypot(x - camera.x, z - camera.z) > CAT_DRAW_R) return;
      const w = this.cats[k];
      const cycle = 12, phase = t + k * 3.1;
      const n = Math.floor(phase / cycle), u = phase - n * cycle;
      const walked = n * 6 + Math.min(u, 6);
      const a = w.phase + (walked * 1.1) / r;
      w.x = x + Math.cos(a) * r;
      w.z = z + Math.sin(a) * r;
      w.rot = Math.atan2(-Math.sin(a), Math.cos(a));
      w.flags = u < 6 ? FLAG_WALKING : 0;
      c.push(CAT_ID_BASE + k, w, "cat", time, dt);
    });
  }
}
