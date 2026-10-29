// Otoyol modu: sonsuz düz yolda kendi Tofaş'ınla trafiğin arasından makas atarsın. Dünyadan "Diğer" menüsündeki
// Otoyol ya da "!otoyol" ile girilir (sayfa yenilenmeden, mode.ts). Kurallar shared/highway.ts'te; burada sürüş döngüsü,
// kamera, çizim ve arayüz var. Şimdilik tek kişilik (sunucusuz): trafik bu oturumun tohumundan, rekor cihazda.
// Tuşlar: W/S ya da oklar gaz/fren, A/D şerit değiştir, R tekrar.
import * as THREE from "three";
import { HW, HwRun, type HwEvent, TIERS, trafficAt, type TrafficCar, wrongWay } from "../../shared/highway";
import { Input } from "./input/input";
import { beginMode, listen, listenDoc, switchMode } from "./mode";
import { FrameLimiter, PerfGovernor } from "./perf";
import { onSettings, settings } from "./settings";
import { EngineSounds } from "./ui/engine";
import { icon } from "./ui/icons";
import { modeButton, region } from "./ui/layout";
import { SettingsPanel } from "./ui/settingsPanel";
import { sfx } from "./ui/sfx";
import { HighwayRoad } from "./world/highwayRoad";
import { buildTofas } from "./world/tofas";
import { TrafficCars } from "./world/trafficCars";

const STEP = 1 / 120;
/** Trafiğin çizildiği aralık (arabanın gerisi ve önü, m). */
const DRAW_BACK = 60;
const DRAW_AHEAD = 650;
/** Çizim kökü bu aralıkla kayar: sahne koordinatları küçük kalır (float hassasiyeti). */
const ORIGIN_STEP = 1000;
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
    // Logaritmik derinlik: uzun düz yolda ince çizgiler uzakta asfaltla titreşmesin
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
  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  };
  listen("resize", onResize);

  // ---- Sahne ----
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#d6e6ee");
  scene.fog = new THREE.Fog("#d3e2ea", 160, DRAW_AHEAD);
  scene.add(new THREE.HemisphereLight("#e4f0ff", "#5d7440", 1.15));
  const sun = new THREE.DirectionalLight("#fff0d8", 1.9);
  sun.position.set(-0.6, 1, 0.35);
  scene.add(sun);
  const road = new HighwayRoad();
  scene.add(road.group, road.far);
  const traffic = new TrafficCars();
  traffic.prebuild();
  scene.add(traffic.group);
  const car = buildTofas(settings.car);
  car.setNight(0);
  car.setHeadlights(0);
  scene.add(car.group);
  life.onStop(() => {
    renderer.setAnimationLoop(null);
    road.dispose();
    car.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  });

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
    ? "Joystick: yukarı gaz, aşağı fren, sağa sola şerit · Arabaların yanından ne kadar yakın geçersen o kadar puan"
    : "W/↑ gaz · S/↓ fren · A/D şerit değiştir · Arabaların yanından ne kadar yakın geçersen o kadar puan");
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

  // ---- Sürüş ----
  const seed = (Math.random() * 2 ** 31) | 0;
  let run = new HwRun(seed, 0);
  /** Trafik saati (sn): fizik adımlarıyla ilerler, sekme gizliyken durur. */
  let simT = 0;
  let acc = 0;
  /** Önceki adımın arabası (çizimde iki adım arası yumuşatılır). */
  const prev = { x: run.car.x, z: run.car.z, a: run.car.a };
  let crashAt = -1;
  /** Son kaza sert vuruştan mı (yoksa hasar mı doldu). */
  let hardCrash = true;
  let shownResult = false;
  let lastScrape = 0;
  let drove = 0;
  const cam = { x: run.car.x, z: run.car.z - 7, look: new THREE.Vector3() };
  const cars: TrafficCar[] = [];

  const restart = () => {
    run = new HwRun(seed, run.car.z);
    Object.assign(prev, { x: run.car.x, z: run.car.z, a: run.car.a });
    crashAt = -1;
    shownResult = false;
    result.classList.remove("show");
    pop("GAZLA!", "", "go");
  };
  function onKey(e: KeyboardEvent): void {
    if (e.code === "KeyR" && !run.car.alive && !(e.target instanceof HTMLInputElement)) restart();
  }
  listen("keydown", onKey);
  if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { gapHighway: { run: () => run, cars: () => cars, seed } });

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

  const onEvent = (e: HwEvent, now: number) => {
    switch (e.k) {
      case "near": {
        const tier = TIERS[e.tier];
        pop(tier.name, `+${fmt(e.pts)}${e.combo > 1 ? `  ·  ×${e.combo}` : ""}${e.oncoming ? "  ·  karşıdan" : ""}`, `t${e.tier}`);
        sfx.whoosh(1 - e.tier * 0.2, -e.side * 0.7, e.combo);
        break;
      }
      case "bump":
        sfx.bump(Math.min(1, 0.4 + e.impact / 6));
        hurt(false);
        pop("SÜRTME", `hasar %${Math.round(run.car.damage)}`, "bump");
        break;
      case "rail":
        if (now - lastScrape > 140) {
          lastScrape = now;
          sfx.scrape(run.car.x > 0 ? -0.6 : 0.6);
          if (e.impact > 2) hurt(false);
        }
        break;
      case "crash":
        sfx.crash(1);
        hurt(true);
        crashAt = now;
        hardCrash = e.impact > HW.hard;
        break;
    }
  };

  // ---- Döngü ----
  const up = new THREE.Vector3(0, 1, 0);
  const lookAt = new THREE.Vector3();
  let last = performance.now();
  let shake = 0;

  const frame = (now: number) => {
    if (!limiter.ready(now, settings.fpsCap)) return;
    const dtMs = Math.min(now - last, 100);
    const dt = dtMs / 1000;
    last = now;
    const t0 = performance.now();
    input.poll();
    const c = run.car;
    const inp = { gas: Math.max(0, input.moveY), brake: Math.max(0, -input.moveY), steer: input.moveX };
    acc += dt;
    while (acc >= STEP) {
      prev.x = c.x;
      prev.z = c.z;
      prev.a = c.a;
      for (const e of run.update(inp, STEP, simT)) onEvent(e, now);
      simT += STEP;
      acc -= STEP;
    }
    if (crashAt >= 0 && !shownResult && now - crashAt > 1400) showResult();
    if (inp.gas > 0 && c.alive) drove += dt;
    help.classList.toggle("hide", drove > 5);

    // İki adım arası: araba ve trafik aynı ana çizilir
    const k = acc / STEP;
    const x = prev.x + (c.x - prev.x) * k, z = prev.z + (c.z - prev.z) * k, a = prev.a + (c.a - prev.a) * k;
    const tr = simT - STEP * (1 - k);
    const origin = Math.floor(z / ORIGIN_STEP) * ORIGIN_STEP;

    // Kamera: arkadan takip; hız arttıkça biraz geri çekilir, görüş açısı genişler. Kazada yerinde kalır.
    const sp = c.v / HW.vmax;
    if (c.alive) {
      cam.x += (x - cam.x) * (1 - Math.exp(-dt * 5));
      cam.z = z - 6.4 - sp * 1.6;
    }
    shake = c.alive ? sp * sp * 0.025 : Math.max(0, shake - dt * 0.05);
    camera.position.set(cam.x + (Math.random() - 0.5) * shake, 2.35 + sp * 0.35 + (Math.random() - 0.5) * shake, cam.z - origin);
    const lookX = c.alive ? x * 0.65 + cam.x * 0.35 : x;
    cam.look.lerp(lookAt.set(lookX, 1.05, (c.alive ? z + 14 : z) - origin), c.alive ? 1 : 1 - Math.exp(-dt * 4));
    camera.lookAt(cam.look);
    const fov = settings.fov + sp * 16;
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 4);
      camera.updateProjectionMatrix();
    }

    road.update(z, origin, camera.position);
    traffic.begin();
    for (const t of trafficAt(seed, tr, z - DRAW_BACK, z + DRAW_AHEAD, cars)) traffic.push(t.look, t.x, t.z - origin, t.v > 0 ? 0 : Math.PI);
    traffic.end();

    car.group.position.set(x, 0, z - origin);
    car.group.quaternion.setFromAxisAngle(up, a);
    car.roll(c.v * dt, c.alive ? -inp.steer * 0.35 : 0);
    car.setDamage(Math.min(3, Math.floor(c.damage / 34)));
    car.group.visible = c.ghost <= 0 || Math.floor(now / 90) % 2 === 0;
    engine.update([{ speed: c.v * 0.42, throttle: c.alive ? inp.gas : 0, dist: 0, pan: 0, own: true }]);

    // Gösterge
    const s = run.stats;
    const score = fmt(s.score);
    if (scoreEl.textContent !== score) scoreEl.textContent = score;
    const comboOn = run.combo > 1 && c.alive;
    comboEl.classList.toggle("show", comboOn);
    if (comboOn) {
      comboText.textContent = `KOMBO ×${run.combo}`;
      comboBar.style.width = `${Math.max(0, 1 - run.sinceNear / HW.comboGap) * 100}%`;
    }
    const kmh = String(Math.round(c.v * KMH));
    if (speedNum.textContent !== kmh) speedNum.textContent = kmh;
    dmgFill.style.width = `${c.damage}%`;
    dmgRow.classList.toggle("high", c.damage > 66);
    wrongEl.classList.toggle("show", c.alive && wrongWay(c));

    renderer.render(scene, camera);
    perf.frame(dtMs, performance.now() - t0);
  };
  const runLoop = () => {
    last = performance.now();
    renderer.setAnimationLoop(frame);
  };
  const onVisible = () => {
    if (document.hidden) renderer.setAnimationLoop(null);
    else runLoop();
  };
  listenDoc("visibilitychange", onVisible);

  // Shader'lar yükleme ekranı açıkken derlenir (ilk karede donmasın)
  traffic.begin();
  for (let i = 0; i < 24; i++) traffic.push(i, (i % 4) * 3, 20 + i * 6, 0);
  traffic.end();
  await renderer.compileAsync(scene, camera).catch(() => undefined);
  if (!life.active) return;
  runLoop();
  loading.remove();
  pop("GAZLA!", "", "go");
}
