// Araçlar (GTA gibi): arabadan inince araba indiğin yerde park halinde kalır, herkes görür ve çarpar; yanına gelip
// F ile binersin. "Araçlarım" menüsünden (T) Tofaşları, Linea'yı, Doblo'yu, Passat'ı ya da E30'u çağırırsın: kendi tuning'iyle yanına
// gelir. GAP Garaj'daki parlayan işarete arabayla gelince tuning ekranı açılır; kamera araba etrafında döner ve
// seçili parçaya bakar (oda duvarlarının içinde kalır).
import * as THREE from "three";
import { carItem } from "../../shared/shop";
import { CAR_HULL_R, CAR_MODELS, carCircles, type CarSpec, ENTER_REACH, isJobCar, type ParkedCar } from "../../shared/car";
import { GARAGE } from "../../shared/zones";
import type { Remotes } from "./avatars/remotes";
import { Cars } from "./cars";
import type { FeatureAct } from "./features";
import type { Net } from "./net";
import type { Player } from "./player";
import { settings, updateSettings } from "./settings";
import { CarMenu } from "./ui/carMenu";
import type { Hud } from "./ui/hud";
import { sfx } from "./ui/sfx";
import { type CamPreset, Tuning } from "./ui/tuning";
import type { DynamicColliders, Vec2 } from "./world/colliders";
import type { World } from "./world/scene";

export interface VehicleContext {
  world: World;
  net: Net;
  me: Player;
  remotes: Remotes;
  hud: Hud;
  hudRoot: HTMLElement;
  camera: THREE.PerspectiveCamera;
  /** Menü açıkken dünya girişi durur. */
  block(on: boolean): void;
  /** Yarıştayken inilmez/çağrılmaz. */
  racing(): boolean;
  /** Çağırma efekti (ışıltı). */
  sparkle(x: number, z: number): void;
}

const UP = new THREE.Vector3(0, 1, 0);
/** "…'e bin" (yönelme hâli, okunuşa göre). */
const TO: Record<CarSpec["model"], string> = {
  sahin: "Şahin'e", dogan: "Doğan SLX'e", kartal: "Kartal'a", linea: "Linea'ya", doblo: "Doblo'ya", passat: "Passat'a", e30: "E30'a", motor: "Scooter'a", taksi: "Taksiye",
};

/** Park halindeki arabaların çizildiği en uzak mesafe. */
const DRAW_R = 150;

/** (px, pz)'nin p→q parçasına uzaklığı. */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / l2));
  return Math.hypot(px - ax - ex * t, pz - az - ez * t);
}

export class Vehicles {
  /** Kendi park halindeki araban (sunucu onaylar; bağlantı kopunca silinir). */
  myParked: ParkedCar | null = null;
  readonly menu: CarMenu;
  readonly tuning: Tuning;
  private parkedCars: Cars;
  private garageArmed = true;
  /** Tuning kamerasının yumuşatılmış hâli (yoksa ilk karede kurulur). */
  private orbit: CamPreset | null = null;
  private sendTimer = 0;
  private pos = new THREE.Vector3();
  private right = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(private c: VehicleContext) {
    this.parkedCars = new Cars(c.world.scene);
    this.menu = new CarMenu(c.hudRoot, {
      call: (m) => this.call(m),
      dismiss: () => this.dismiss(),
      state: () => ({
        cars: settings.cars,
        parked: this.myParked ? { model: this.myParked.car.model, dist: Math.hypot(this.myParked.x - c.me.x, this.myParked.z - c.me.z) } : null,
        driving: c.me.car ? settings.car.model : null,
      }),
      modal: (open) => c.block(open),
      buy: (m) => c.net.send({ t: "buy", item: carItem(m) }),
    });
    this.tuning = new Tuning(c.hudRoot, {
      preview: (spec) => (settings.car = spec),
      apply: (spec) => this.applyTune(spec),
      close: () => this.closeTuning(),
      buy: (item) => c.net.send({ t: "buy", item }),
    });
    c.net.onParked = (sid, parked) => {
      if (sid === c.net.you) this.myParked = parked;
    };
  }

  /** Park halindeki arabalar yayaları ve arabaları durdurur (zıplayan üstünden geçemez, araba alçak değil). */
  readonly colliders: DynamicColliders = {
    resolve: (p: Vec2, radius: number) => {
      for (const car of this.allParked()) {
        if (Math.abs(car.x - p.x) > 5 || Math.abs(car.z - p.z) > 5) continue;
        const [fx, fz, bx, bz] = carCircles(car.x, car.z, car.rot);
        for (const [cx, cz] of [[fx, fz], [bx, bz]]) {
          const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz), min = CAR_HULL_R + radius;
          if (d >= min) continue;
          if (d < 1e-4) p.x += min;
          else {
            p.x = cx + (dx / d) * min;
            p.z = cz + (dz / d) * min;
          }
        }
      }
    },
    groundAt: () => 0,
  };

  private *allParked(): Iterable<ParkedCar> {
    if (this.myParked) yield this.myParked;
    for (const r of this.c.remotes.map.values()) if (r.info.parked) yield r.info.parked;
  }

  /** Bağlantı koptu: sunucu park yerini unuttu. */
  reset(): void {
    this.myParked = null;
  }

  get modalOpen(): boolean {
    return this.menu.isOpen || this.tuning.isOpen;
  }

  /** Yürürken kendi arabanın yanındaysan: bin. */
  enterAct(): FeatureAct | null {
    const { me } = this.c;
    const p = this.myParked;
    if (!p || me.car || me.driving || me.jailed) return null;
    const [fx, fz, bx, bz] = carCircles(p.x, p.z, p.rot);
    if (segDist(me.x, me.z, fx, fz, bx, bz) > ENTER_REACH) return null;
    return { key: "f", label: `${TO[p.car.model] ?? "Arabana"} bin 🚗`, act: "car-enter" };
  }

  enter(): void {
    const { me, net, hud } = this.c;
    const p = this.myParked;
    if (!p || me.car) return;
    if (me.vehicle) me.setVehicle(0);
    me.enterCarAt(p.x, p.z, p.rot);
    settings.car = p.car;
    // İş aracı (scooter, taksi) ayarlara yazılmaz: işten çıkınca kendi arabana dönersin
    if (!isJobCar(p.car.model)) updateSettings({ car: p.car });
    this.myParked = null;
    net.send({ t: "car", car: p.car });
    hud.toast(`🚗 ${p.car.plate} · W/S gaz-fren · Space el freni · Shift güç · E korna · X selektör · G far · F in · R radyo`);
    if (p.car.model === "linea") window.setTimeout(() => hud.toast("⛽ Yakıt göstergesi kıpırdamıyor. Multijet işte abi."), 2500);
    else if (p.car.model === "passat") window.setTimeout(() => hud.toast("🧔 Sakal Passat: sol şeritte selektör yapmak serbest (X)."), 2500);
    else if (p.car.model === "e30") window.setTimeout(() => hud.toast("🌀 E30: Space ile el freni, gazla arkayı süpür."), 2500);
    else if (p.car.model === "doblo") window.setTimeout(() => hud.toast("📦 Doblo: virajlara yavaş gir, yalpalar."), 2500);
  }

  /** Arabadan in: araba indiğin yerde park halinde kalır. */
  exit(): boolean {
    const { me, net, hud } = this.c;
    if (!me.car) return false;
    if (this.c.racing()) {
      hud.toast("🏁 Yarıştayken arabadan inemezsin. Çıkmak için “Yarışı terk et”.");
      return true;
    }
    if (this.tuning.isOpen) return true;
    const parked: ParkedCar = { car: { ...settings.car }, x: me.x, z: me.z, rot: me.rot };
    me.exitCar();
    this.myParked = parked;
    net.send({ t: "car", car: null });
    net.send({ t: "park", parked });
    return true;
  }

  /** Araçlarım: model yanına gelir (eskisi kalkar). */
  call(model: CarSpec["model"]): void {
    const { me, net, hud, world } = this.c;
    if (me.car) return hud.toast("🚗 Önce arabadan in (F).");
    if (me.driving || me.jailed || me.onStage) return hud.toast("🚗 Şu an araba çağıramazsın.");
    if (me.vehicle === 3) return hud.toast("🛶 Önce kayıktan in.");
    const room = world.roomAt(me.x, me.z);
    if (room && room !== world.garage.room) return hud.toast("🚗 Arabayı dışarıda çağırabilirsin.");
    const prev = this.myParked;
    this.myParked = null;
    const spot = this.findSpot();
    if (!spot) {
      this.myParked = prev;
      return hud.toast("🚗 Burada araba için yer yok; biraz açık bir alana geç.");
    }
    const car = { ...settings.cars[model] };
    const parked: ParkedCar = { car, ...spot };
    this.myParked = parked;
    settings.car = car;
    updateSettings({ car });
    net.send({ t: "park", parked });
    this.c.sparkle(spot.x, spot.z);
    sfx.pop();
    hud.toast(`🚗 ${CAR_MODELS.find((m) => m.id === model)?.name} yanında! Yanına gidip F ile bin.`);
  }

  /** İşin aracı yanına gelir (scooter, taksi); ayarlara kaydedilmez. */
  callJob(car: CarSpec): void {
    const { me, hud } = this.c;
    if (me.car && settings.car.model === car.model) return;
    if (me.car) this.exit();
    if (!isJobCar(settings.car.model)) this.prevModel = settings.car.model;
    const spot = this.findSpot();
    if (!spot) return hud.toast("🚗 Burada araç için yer yok; biraz açık bir alana geç.");
    const parked: ParkedCar = { car: { ...car }, ...spot };
    this.myParked = parked;
    settings.car = parked.car;
    this.c.net.send({ t: "park", parked });
    this.c.sparkle(spot.x, spot.z);
    sfx.pop();
    hud.toast(car.model === "motor" ? "🛵 GAP Kurye scooter'ın yanında! F ile bin." : "🚕 GAP Taksi yanında! F ile bin.");
  }

  /** İş bitti: iş aracındaysan inersin, park edilmiş iş aracı kalkar; son arabana dönersin. */
  endJob(): void {
    const { me, net } = this.c;
    if (me.car && isJobCar(settings.car.model)) {
      me.exitCar();
      net.send({ t: "car", car: null });
    }
    if (this.myParked && isJobCar(this.myParked.car.model)) this.dismiss();
    if (isJobCar(settings.car.model)) settings.car = { ...settings.cars[this.prevModel] };
  }

  /** İşten önce sürdüğün model (iş bitince geri). */
  private prevModel: (typeof CAR_MODELS)[number]["id"] = "sahin";

  dismiss(): void {
    if (!this.myParked) return;
    this.myParked = null;
    this.c.net.send({ t: "park", parked: null });
    this.c.hud.toast("🅿️ Araban kaldırıldı.");
  }

  /** Yanında araba için boş yer: sol, sağ, ön, arka (oyuncunun baktığı yöne paralel). */
  private findSpot(): { x: number; z: number; rot: number } | null {
    const { me, world } = this.c;
    const c = Math.cos(me.rot), s = Math.sin(me.rot);
    for (const [lx, lz] of [[2.7, 0], [-2.7, 0], [0, 5.2], [0, -5.2], [3.6, 3], [-3.6, 3]]) {
      const x = me.x + lx * c + lz * s, z = me.z - lx * s + lz * c;
      const r = world.roomAt(x, z);
      if (r && r !== world.garage.room) continue;
      const [fx, fz, bx, bz] = carCircles(x, z, me.rot);
      let ok = true;
      for (const [px, pz] of [[fx, fz], [bx, bz], [x, z]]) {
        const p = { x: px, z: pz };
        world.colliders.resolve(p, CAR_HULL_R, 0);
        if (Math.hypot(p.x - px, p.z - pz) > 0.05) ok = false;
      }
      // Oyuncunun kendisi gövdenin içinde kalmasın
      if (ok && segDist(me.x, me.z, fx, fz, bx, bz) > CAR_HULL_R + 0.5) return { x, z, rot: me.rot };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // GAP Garaj ve tuning

  private applyTune(spec: CarSpec): void {
    settings.car = spec;
    updateSettings({ car: spec, cars: { ...settings.cars, [spec.model]: spec } });
    // Sunucu çok sık araba mesajını yok sayar: art arda takılanlar tek mesajda gider
    window.clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => {
      if (this.c.me.car) this.c.net.send({ t: "car", car: settings.car });
    }, 350);
  }

  private openTuning(): void {
    const { me, hudRoot } = this.c;
    const sp = GARAGE.spot;
    me.placeCar(sp.x, sp.z, sp.rot);
    me.hideAvatar = true;
    this.orbit = null;
    this.tuning.open(settings.cars[settings.car.model] ?? settings.car);
    this.c.block(true);
    hudRoot.classList.add("tuning-open");
    sfx.quest();
  }

  private closeTuning(): void {
    const { me, hudRoot } = this.c;
    settings.car = settings.cars[settings.car.model] ?? settings.car;
    me.focusView = null;
    me.hideAvatar = false;
    this.garageArmed = false;
    this.c.block(false);
    hudRoot.classList.remove("tuning-open");
  }

  /** Kare başına: park halindeki arabaları çiz, garaj işaretini yokla, tuning kamerası. */
  update(dt: number, time: number): void {
    const { me, world, net } = this.c;
    const night = world.env.lights;
    this.parkedCars.begin();
    if (this.myParked) this.pushParked(net.you, this.myParked, night);
    for (const r of this.c.remotes.map.values()) if (r.info.parked && !r.leaving) this.pushParked(r.info.sid, r.info.parked, night);
    this.parkedCars.end();

    const sp = GARAGE.spot;
    const d = Math.hypot(me.x - sp.x, me.z - sp.z);
    if (d > 4) this.garageArmed = true;
    if (me.car && !this.tuning.isOpen && this.garageArmed && d < 1.9 && !this.c.racing()) this.openTuning();
    world.garage.update(time, this.tuning.isOpen || !!(me.car && !this.garageArmed && d < 4));
    if (this.tuning.isOpen) {
      this.tuning.tick(dt);
      // Bir süre dokunulmazsa kamera araba etrafında ağır ağır döner (vitrin)
      if (performance.now() - this.tuning.lastTouch > 4000) this.tuning.yaw += dt * 0.12;
      this.tuneCamera(dt);
    }
  }

  private pushParked(sid: number, p: ParkedCar, night: number): void {
    const { me } = this.c;
    if (Math.abs(p.x - me.x) > DRAW_R || Math.abs(p.z - me.z) > DRAW_R) return;
    this.parkedCars.push(sid, p.car, p.x, p.z, p.rot, night);
  }

  /** Seçili kategorinin kamera ön ayarına yumuşakça geçer; oda duvarlarının içinde kalır. */
  private tuneCamera(dt: number): void {
    const { me, world } = this.c;
    const want = { ...this.tuning.cam };
    want.yaw += this.tuning.yaw;
    if (!this.orbit) this.orbit = { ...want };
    const o = this.orbit, k = 1 - Math.exp(-dt * 4);
    o.tx += (want.tx - o.tx) * k;
    o.ty += (want.ty - o.ty) * k;
    o.tz += (want.tz - o.tz) * k;
    o.pitch += (want.pitch - o.pitch) * k;
    o.dist += (want.dist - o.dist) * k;
    // Açı en kısa yoldan
    let dy = want.yaw - o.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    o.yaw += dy * k;
    const c = Math.cos(me.rot), s = Math.sin(me.rot);
    const local = (lx: number, ly: number, lz: number, out: THREE.Vector3) => out.set(me.x + lx * c + lz * s, ly, me.z - lx * s + lz * c);
    local(o.tx, o.ty, o.tz, this.look);
    const cp = Math.cos(o.pitch);
    local(o.tx + Math.sin(o.yaw) * cp * o.dist, o.ty + Math.sin(o.pitch) * o.dist, o.tz + Math.cos(o.yaw) * cp * o.dist, this.pos);
    // Garajın duvarları ve tavanı: kamera içeride kalır (hedeften kameraya doğru kısalır)
    const r = world.garage.room, m = 0.35, l = this.look, p = this.pos;
    const lim = (from: number, to: number, lo: number, hi: number) => (to > hi ? (hi - from) / (to - from) : to < lo ? (lo - from) / (to - from) : 1);
    const t = Math.max(0, Math.min(lim(l.x, p.x, r.minX + m, r.maxX - m), lim(l.z, p.z, r.minZ + m, r.maxZ - m), lim(l.y, p.y, 0.25, r.ceil - m)));
    if (t < 1) p.set(l.x + (p.x - l.x) * t, l.y + (p.y - l.y) * t, l.z + (p.z - l.z) * t);
    // Menü solu kaplıyor: kamera ve bakış birlikte sola kayar, araba sağdaki boş alanın ortasında görünür
    const cam = this.c.camera, dist = p.distanceTo(l);
    const halfW = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect * dist;
    const shift = halfW * (this.tuning.panelRight / 2) / (innerWidth / 2);
    this.right.subVectors(l, p).cross(UP).normalize().multiplyScalar(shift);
    p.sub(this.right);
    l.sub(this.right);
    me.focusView = { pos: this.pos.clone(), look: this.look.clone() };
  }
}
