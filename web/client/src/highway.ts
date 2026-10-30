// Otoyol modu: sonsuz, virajlı ve yokuşlu yolda kendi arabanla trafiğin arasından makas atarsın. Dünyadan "Diğer"
// menüsündeki Otoyol ya da "!otoyol" ile girilir (sayfa yenilenmeden, mode.ts). Sürüş dünyadakiyle aynı: Player'ın
// araba fiziği (gaz, fren, drift, el freni, Shift güç; çarpışma tepkisi). Burada ona küçük bir dünya verilir:
// otokorkuluk ve orta bariyer duvar, trafik arabaları çarpışılabilir gövde. Yol ve trafik shared/highway.ts'te.
// Şimdilik tek kişilik (sunucusuz): yol ve trafik bu oturumun tohumundan, rekor cihazda.
import * as THREE from "three";
import { type CarSpec, isBike, isJobCar } from "../../shared/car";
import { HW, HwRun, type HwEvent, LANES, Road, type RoadPoint, TIERS, trafficAt, type TrafficCar, TrafficYield, wrongWay } from "../../shared/highway";
import { Input } from "./input/input";
import { beginMode, listen, listenDoc, switchMode } from "./mode";
import { FrameLimiter, PerfGovernor } from "./perf";
import { CAR_DIMS, type CarBody, Player } from "./player";
import { onSettings, settings } from "./settings";
import { EngineSounds } from "./ui/engine";
import { icon } from "./ui/icons";
import { modeButton, region } from "./ui/layout";
import { SettingsPanel } from "./ui/settingsPanel";
import { sfx } from "./ui/sfx";
import type { Vec2 } from "./world/colliders";
import { HighwayRoad } from "./world/highwayRoad";
import { buildMotor } from "./world/motor";
import type { World } from "./world/scene";
import { buildTofas } from "./world/tofas";
import { TRAFFIC_LOOKS, TrafficCars } from "./world/trafficCars";

/** Trafiğin çizildiği aralık (arabanın gerisi ve önü, m) ve çarpışmaya girdiği yakınlık. */
const DRAW_BACK = 60;
const DRAW_AHEAD = 650;
const BODY_NEAR = 25;
/** Trafik arabalarının kütlesi (oyuncu arabası ~1): raylarında giderler, çarpınca itilen oyuncudur. */
const TRAFFIC_MASS = 3;
/** Çizim kökü bu aralıkla kayar: sahne koordinatları küçük kalır (float hassasiyeti). */
const ORIGIN_STEP = 1000;
/** Yol başında doğulan yer (m). */
const START_S = 150;
/** Bariyer açıklığı bu kadar yakınsa haber verilir (m). */
const GAP_NOTICE = 350;
const BEST_KEY = "gap-otoyol-rekor";
const KMH = 3.6;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}

const fmt = (n: number) => Math.floor(n).toLocaleString("tr-TR");

function loadBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest(n: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(Math.floor(n)));
  } catch {
    // depolama kapalı: rekor yalnızca bu oturumda
  }
}

export async function runHighway(canvas: HTMLCanvasElement, hudRoot: HTMLElement, loading: HTMLElement, lowPower: boolean): Promise<void> {
  const life = beginMode();
  let renderer: THREE.WebGLRenderer;
  try {
    // Logaritmik derinlik: uzun yolda ince çizgiler uzakta asfaltla titreşmesin
    renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.antialias && !lowPower, powerPreference: "high-performance", stencil: false, logarithmicDepthBuffer: true });
  } catch {
    loading.textContent = "Bu cihazda WebGL açılamadı.";
    loading.classList.add("error");
    return;
  }
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.2, 2100);
  const perf = new PerfGovernor(renderer, Math.min(devicePixelRatio, settings.maxDpr));
  const limiter = new FrameLimiter();
  const applySettings = () => perf.configure(Math.min(devicePixelRatio, settings.maxDpr), settings.fpsCap, settings.renderScale);
  applySettings();
  life.onStop(onSettings(applySettings));
  listen("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  // Araba: dünyada sürdüğün (iş aracıysa kendi Şahin'in); Player fiziği settings.car'dan okur
  const prevCar = settings.car;
  const spec: CarSpec = isJobCar(settings.car.model) ? { ...settings.cars.sahin } : settings.car;
  settings.car = spec;
  life.onStop(() => (settings.car = prevCar));

  // ---- Sahne ----
  const seed = (Math.random() * 2 ** 31) | 0;
  const road = new Road(seed);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#d6e6ee");
  scene.fog = new THREE.Fog("#d3e2ea", 160, DRAW_AHEAD);
  scene.add(new THREE.HemisphereLight("#e4f0ff", "#5d7440", 1.15));
  const sun = new THREE.DirectionalLight("#fff0d8", 1.9);
  sun.position.set(-0.6, 1, 0.35);
  scene.add(sun);
  const view = new HighwayRoad(road);
  scene.add(view.group, view.far);
  const traffic = new TrafficCars();
  traffic.prebuild();
  scene.add(traffic.group);
  const carMesh = isBike(spec.model) ? buildMotor(spec) : buildTofas(spec);
  carMesh.setNight(0);
  carMesh.setHeadlights(0);
  scene.add(carMesh.group);
  life.onStop(() => {
    renderer.setAnimationLoop(null);
    view.dispose();
    carMesh.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  });

  // ---- Sürüş: oyunun araba fiziği, otoyolun duvarları ve trafiği ----
  let run = new HwRun();
  /** Arabanın yoldaki yeri (s, d) ve en yakın örnek (izdüşüm ipucu); bariyerin hangi yanındayız. */
  let proj = { s: START_S, d: LANES[1].d, i: -1 };
  let side = -1;
  const pt: RoadPoint = { x: 0, z: 0, h: 0, th: 0, g: 0, k: 0 };
  const bodies: CarBody[] = [];
  /**
   * Duvarlar: dış otokorkuluklar ve orta bariyer (açıklıkta yok; uçları yuvarlak). Nokta duvarın içindeyse yolun
   * yanına doğru dışarı itilir (Player itilme miktarından çarpışmayı hesaplar).
   */
  const walls = {
    resolve(p: Vec2, r: number): void {
      const pr = road.project(p.x, p.z, proj.i);
      const q = road.at(pr.s, pt);
      const lx = Math.cos(q.th), lz = -Math.sin(q.th), fx = Math.sin(q.th), fz = Math.cos(q.th);
      const lim = HW.rail - r, m = HW.barrier + r;
      let push = pr.d > lim ? lim - pr.d : pr.d < -lim ? -lim - pr.d : 0;
      const gap = road.gapAt(pr.s);
      if (!gap) {
        if (Math.abs(pr.d) < m) push = side * m - pr.d;
      } else {
        // Açıklığın iki ucundaki bariyer başı: yarım daire
        for (const [edge, dir] of [[gap[0], 1], [gap[1], -1]] as const) {
          const ds = (pr.s - edge) * dir, len = Math.hypot(ds, pr.d);
          if (ds >= m || len >= m || len < 1e-4) continue;
          const k = (m - len) / len;
          p.x += (fx * ds * dir + lx * pr.d) * k;
          p.z += (fz * ds * dir + lz * pr.d) * k;
          return;
        }
      }
      if (push) {
        p.x += lx * push;
        p.z += lz * push;
      }
    },
    groundAt: () => 0,
  };
  const world = {
    spawn: { x: 0, z: 0, rot: 0 },
    colliders: walls,
    carColliders: { resolve: () => {}, groundAt: () => 0 },
    carWater: null,
    carBodies: () => bodies,
    seats: [],
  } as unknown as World;
  const me = new Player(world, new THREE.Color("#ffffff"));
  const placeAt = (s: number) => {
    const w = road.world(s, LANES[1].d);
    if (!me.car) me.enterCarAt(w.x, w.z, w.th);
    me.placeCar(w.x, w.z, w.th);
    const c = me.car!;
    c.v = LANES[1].v;
    c.drift = c.spin = 0;
    proj = { s, d: LANES[1].d, i: -1 };
    side = -1;
  };
  placeAt(START_S);

  const input = new Input(canvas, hudRoot);
  life.onStop(() => input.dispose());
  const engine = new EngineSounds();
  life.onStop(() => engine.silence());

  // ---- Arayüz ----
  hudRoot.classList.add("hw");
  modeButton(hudRoot, { icon: "house", label: "Dünyaya dön", onClick: () => switchMode("world") });
  new SettingsPanel(hudRoot, () => switchMode("highway"));
  const top = el("div", "hw-top", region(hudRoot, "tc"));
  const scoreEl = el("div", "hw-score", top, "0");
  const comboEl = el("div", "hw-combo", top);
  const comboText = el("span", "", comboEl);
  const comboBar = el("i", "", el("b", "", comboEl));
  let best = loadBest();
  const bestEl = el("div", "hw-best", region(hudRoot, "tl"));
  const pops = el("div", "hw-pops", hudRoot);
  const bc = region(hudRoot, "bc");
  const help = el("div", "hw-help", bc, input.touch
    ? "Joystick: gaz, fren ve direksiyon · Arabaların yanından ne kadar yakın geçersen o kadar puan"
    : "W/S gaz-fren · A/D direksiyon · Space el freni · Shift güç · Arabaların yanından ne kadar yakın geçersen o kadar puan");
  const gapEl = el("div", "hw-gapnote", bc);
  const wrongEl = el("div", "hw-wrong", bc);
  icon("warning", "", wrongEl);
  el("span", "", wrongEl, "TERS ŞERİT · makas ×1,5 · yol puanı ×2");
  const dash = el("div", "hw-dash", bc);
  const flash = el("div", "hw-flash", hudRoot);
  const speedEl = el("div", "hw-speed", dash);
  const speedNum = el("b", "", speedEl, "0");
  el("span", "", speedEl, "km/s");
  const dmgRow = el("div", "hw-dmg", dash);
  el("span", "", dmgRow, "Hasar");
  const dmgFill = el("i", "", el("b", "", dmgRow));
  const result = el("div", "hw-result", hudRoot);
  const renderBest = () => {
    bestEl.replaceChildren();
    icon("trophy", "", bestEl);
    el("span", "", bestEl, `Rekor ${fmt(best)}`);
  };
  renderBest();

  const pop = (text: string, sub: string, cls: string) => {
    const p = el("div", `hw-pop ${cls}`, pops);
    el("b", "", p, text);
    if (sub) el("span", "", p, sub);
    while (pops.children.length > 4) pops.firstChild!.remove();
    window.setTimeout(() => p.remove(), 1300);
  };
  const hurt = (strong: boolean) => {
    flash.classList.remove("on", "strong");
    void flash.offsetWidth;
    flash.classList.add("on");
    if (strong) flash.classList.add("strong");
  };

  let crashAt = -1;
  /** Son kaza sert vuruştan mı (yoksa hasar mı doldu). */
  let hardCrash = true;
  let shownResult = false;
  let drove = 0;
  /** Trafik saati (sn): kareyle ilerler, sekme gizliyken durur. */
  let simT = 0;
  const cars: TrafficCar[] = [];
  const yieldTraffic = new TrafficYield();
  /** İlk gaza basılana kadar araba trafikle aynı hızda yuvarlanır ve çarpışmasızdır (yüklenirken yavaşlayıp arkadan gelene takılmasın). */
  let started = false;

  const onEvent = (e: HwEvent, now: number) => {
    switch (e.k) {
      case "near": {
        const tier = TIERS[e.tier];
        pop(tier.name, `+${fmt(e.pts)}${e.combo > 1 ? `  ·  ×${e.combo}` : ""}${e.oncoming ? "  ·  karşıdan" : ""}`, `t${e.tier}`);
        sfx.whoosh(1 - e.tier * 0.2, -e.side * 0.7, e.combo);
        break;
      }
      case "bump":
        sfx.bump(Math.min(1, 0.4 + e.impact / 8));
        hurt(false);
        pop("SÜRTME", `hasar %${Math.round(run.damage)}`, "bump");
        break;
      case "crash":
        sfx.crash(1);
        hurt(true);
        crashAt = now;
        hardCrash = e.impact > HW.hard;
        break;
    }
  };
  // Oyunun çarpışması: trafik ya da bariyer; şiddeti kazayı belirler
  me.onCrash = (speed) => {
    const e = run.hit(speed);
    if (e) onEvent(e, performance.now());
  };

  const restart = () => {
    placeAt(Math.max(START_S, proj.s));
    run = new HwRun();
    started = false;
    crashAt = -1;
    shownResult = false;
    result.classList.remove("show");
    pop("GAZLA!", "", "go");
  };
  listen("keydown", (e) => {
    if (e.code === "KeyR" && !run.alive && !(e.target instanceof HTMLInputElement)) restart();
  });
  if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { gapHighway: { run: () => run, me, road, cars: () => cars, proj: () => proj } });

  const showResult = () => {
    shownResult = true;
    const s = run.stats;
    const record = s.score > best && s.score > 0;
    if (record) {
      best = s.score;
      saveBest(best);
      renderBest();
    }
    result.replaceChildren();
    el("small", "hw-kicker", result, "Otoyol");
    el("h2", "", result, hardCrash ? "KAZA!" : "Araba hurdaya döndü");
    el("div", "hw-final", result, fmt(s.score));
    if (record) {
      const r = el("div", "hw-record", result);
      icon("trophy", "", r);
      el("span", "", r, "Yeni rekor!");
    }
    const grid = el("div", "hw-stats", result);
    const stat = (k: string, v: string) => {
      el("span", "", grid, k);
      el("b", "", grid, v);
    };
    stat("Yol", `${(s.dist / 1000).toFixed(2).replace(".", ",")} km`);
    stat("En yüksek hız", `${Math.round(s.top * KMH)} km/s`);
    stat("Makas", String(s.near));
    stat("En uzun kombo", s.bestCombo ? `×${s.bestCombo}` : "—");
    stat("Süre", `${Math.floor(s.time / 60)}:${String(Math.floor(s.time % 60)).padStart(2, "0")}`);
    const row = el("div", "hw-buttons", result);
    const again = el("button", "btn btn--primary", row);
    icon("repeat", "", again);
    el("span", "", again, input.touch ? "Tekrar" : "Tekrar (R)");
    again.addEventListener("click", restart);
    const home = el("button", "btn", row);
    icon("house", "", home);
    el("span", "", home, "Dünyaya dön");
    home.addEventListener("click", () => switchMode("world"));
    result.classList.add("show");
  };

  /** Yakındaki trafik arabaları, oyunun araba-araba çarpışmasına gövde olarak (çarpışmasız süredeyken yok). */
  const syncBodies = () => {
    bodies.length = 0;
    if (run.ghost > 0) return;
    for (const t of cars) {
      if (Math.abs(t.s - proj.s) > BODY_NEAR) continue;
      const w = road.world(t.s, t.d);
      const dims = CAR_DIMS[TRAFFIC_LOOKS[t.look % TRAFFIC_LOOKS.length].model] ?? CAR_DIMS.sahin;
      const id = t.id;
      bodies.push({
        x: w.x,
        z: w.z,
        rot: t.v > 0 ? w.th : w.th + Math.PI,
        vx: Math.sin(w.th) * t.v,
        vz: Math.cos(w.th) * t.v,
        mass: TRAFFIC_MASS,
        hl: dims.hl,
        hw: dims.hw,
        omega: 0,
        hit: () => run.touch(id),
      });
    }
  };

  // ---- Döngü ----
  let last = performance.now();
  let origin = { x: 0, z: 0 };

  const frame = (now: number) => {
    if (!limiter.ready(now, settings.fpsCap)) return;
    const dtMs = Math.min(now - last, 100);
    const dt = dtMs / 1000;
    last = now;
    const t0 = performance.now();
    simT += dt;
    input.poll();
    // Kazadan sonra direksiyon ve gaz yok: araba kendi kendine yavaşlar
    if (!run.alive) input.moveX = input.moveY = 0;
    if (!started && Math.abs(input.moveY) > 0.1) started = true;
    if (!started) run.ghost = HW.ghost;
    trafficAt(seed, simT, proj.s - DRAW_BACK, proj.s + DRAW_AHEAD, cars);
    yieldTraffic.apply(cars, proj.s, proj.d, dt);
    syncBodies();
    me.carWear = Math.min(3, Math.floor(run.damage / 34));
    me.update(dt, input);
    const c = me.car!;
    if (!run.alive) c.v *= Math.exp(-dt * 1.4);
    if (!started) c.v = LANES[1].v;
    proj = road.project(me.x, me.z, proj.i);
    if (Math.abs(proj.d) > 0.05) side = Math.sign(proj.d);
    for (const e of run.update(proj.s, proj.d, c.v, dt, cars)) onEvent(e, now);
    if (crashAt >= 0 && !shownResult && now - crashAt > 1600) showResult();
    if (c.throttle > 0 && run.alive) drove += dt;
    help.classList.toggle("hide", drove > 6);

    // Çizim kökü: arabanın yakını (sahne koordinatları küçük)
    if (Math.abs(me.x - origin.x) > ORIGIN_STEP || Math.abs(me.z - origin.z) > ORIGIN_STEP) origin = { x: Math.round(me.x / ORIGIN_STEP) * ORIGIN_STEP, z: Math.round(me.z / ORIGIN_STEP) * ORIGIN_STEP };
    const q = road.at(proj.s, pt);
    const roadY = q.h;
    // Araba: yolun yüksekliğinde, yokuşa göre burnu kalkık/inik
    carMesh.group.position.set(me.x - origin.x, roadY, me.z - origin.z);
    carMesh.group.rotation.set(-Math.atan(q.g * Math.cos(me.rot - q.th)), me.rot, 0, "YXZ");
    carMesh.roll(c.v * dt, -c.steer * 0.5);
    carMesh.setDamage(me.carWear);
    carMesh.group.visible = run.ghost <= 0 || Math.floor(now / 90) % 2 === 0;
    // Kamera: oyunun araba kamerası, yolun yüksekliğine kaldırılır
    me.updateCamera(camera, dt);
    camera.position.x -= origin.x;
    camera.position.z -= origin.z;
    camera.position.y += roadY;
    view.update(proj.s, origin.x, origin.z, camera.position, roadY);

    traffic.begin();
    for (const t of cars) {
      const g = road.at(t.s, pt).g;
      const w = road.world(t.s, t.d);
      traffic.push(t.look, w.x - origin.x, w.z - origin.z, t.v > 0 ? w.th : w.th + Math.PI, 1, w.h, -Math.atan(g) * Math.sign(t.v));
    }
    traffic.end();
    engine.update([{ speed: c.v, throttle: run.alive ? Math.max(0, c.throttle) : 0, dist: 0, pan: 0, own: true }]);

    // Gösterge
    const s = run.stats;
    const score = fmt(s.score);
    if (scoreEl.textContent !== score) scoreEl.textContent = score;
    const comboOn = run.combo > 1 && run.alive;
    comboEl.classList.toggle("show", comboOn);
    if (comboOn) {
      comboText.textContent = `KOMBO ×${run.combo}`;
      comboBar.style.width = `${Math.max(0, 1 - run.sinceNear / HW.comboGap) * 100}%`;
    }
    const kmh = String(Math.round(Math.abs(c.v) * KMH));
    if (speedNum.textContent !== kmh) speedNum.textContent = kmh;
    dmgFill.style.width = `${run.damage}%`;
    dmgRow.classList.toggle("high", run.damage > 66);
    wrongEl.classList.toggle("show", run.alive && wrongWay(proj.d));
    // Yaklaşan bariyer açıklığı: ters şeride geçilebilecek yer
    const gap = run.alive ? road.gapsIn(proj.s, proj.s + GAP_NOTICE)[0] : undefined;
    const gapText = !gap ? "" : gap[0] <= proj.s ? "Bariyer açıklığı: karşı şeride geçebilirsin" : `Bariyer açıklığı ${Math.round((gap[0] - proj.s) / 10) * 10} m ileride`;
    if (gapEl.textContent !== gapText) gapEl.textContent = gapText;
    gapEl.classList.toggle("show", !!gapText);

    renderer.render(scene, camera);
    perf.frame(dtMs, performance.now() - t0);
  };
  const runLoop = () => {
    last = performance.now();
    renderer.setAnimationLoop(frame);
  };
  listenDoc("visibilitychange", () => {
    if (document.hidden) renderer.setAnimationLoop(null);
    else runLoop();
  });

  // Yükleme ekranı açıkken: görünen yol parçaları kurulur, shader'lar derlenir (ilk karede donmasın)
  me.updateCamera(camera, 0);
  view.update(proj.s, origin.x, origin.z, camera.position, 0, true);
  traffic.begin();
  for (let i = 0; i < TRAFFIC_LOOKS.length; i++) traffic.push(i, (i % 4) * 3, 20 + i * 6, 0);
  traffic.end();
  await renderer.compileAsync(scene, camera).catch(() => undefined);
  if (!life.active) return;
  runLoop();
  loading.remove();
  pop("GAZLA!", "", "go");
}
