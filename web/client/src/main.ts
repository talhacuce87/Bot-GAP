// GAP Dünyası istemcisi: giriş → dünya → ana döngü.
import * as THREE from "three";
import { INTERP_DELAY_MS } from "../../shared/constants";
import { AvatarAtlas } from "./avatars/atlas";
import { AvatarRenderer, colorFor, MAX_AVATARS } from "./avatars/avatars";
import { Bots } from "./avatars/bots";
import { Remotes } from "./avatars/remotes";
import { login, type Session } from "./discord";
import { Input } from "./input/input";
import { Net } from "./net";
import { PerfGovernor } from "./perf";
import { Player } from "./player";
import { Hud } from "./ui/hud";
import { openYoutubeTest } from "./ui/youtube";
import { buildWorld } from "./world/scene";

const params = new URLSearchParams(location.search);
const canvas = document.getElementById("scene") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud")!;
const loading = document.getElementById("loading")!;

const touch = matchMedia("(pointer: coarse)").matches;
// Zayıf cihazlarda MSAA kapalı: en pahalı ama en az fark edilen kalite ayarı.
const lowPower = params.has("low") || touch || (navigator.hardwareConcurrency || 4) <= 4;

function fail(msg: string): void {
  loading.textContent = msg;
  loading.classList.add("error");
}

async function start(): Promise<void> {
  const world = buildWorld();

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !lowPower,
      powerPreference: "high-performance",
      stencil: false,
    });
  } catch {
    fail("Bu cihazda WebGL açılamadı.");
    return;
  }
  renderer.setSize(innerWidth, innerHeight, false);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 120);
  const perf = new PerfGovernor(renderer, Math.min(devicePixelRatio, 1.5), !params.has("noadapt"));

  let session: Session;
  try {
    session = await login();
  } catch (err) {
    console.error(err);
    fail(`Giriş yapılamadı: ${(err as Error).message}`);
    return;
  }

  const atlas = new AvatarAtlas((id, hash) => `${session.base}/avatar/${id}/${hash}`);
  const avatars = new AvatarRenderer(atlas);
  world.scene.add(avatars.group);
  const remotes = new Remotes(atlas);

  const me = new Player(world, colorFor(session.user.id));
  me.cell = atlas.alloc(session.user.id, session.user.name, session.user.avatar, me.color);

  const input = new Input(canvas, hudRoot);
  const hud = new Hud(hudRoot, session.user.name, input.touch, () => input.triggerAction());
  const net = new Net(session.wsUrl, remotes);
  net.onStatus = (s) => hud.setStatus(s);
  hud.setStatus(net.status);
  if (params.has("debug")) hud.enableDebug(() => void openYoutubeTest(hudRoot, session));

  const botCount = Math.min(MAX_AVATARS - 1, Math.max(0, Number(params.get("bots")) || 0));
  const bots = botCount ? new Bots(remotes, botCount, world.seats) : null;

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  let last = performance.now();
  const frame = (now: number) => {
    const dtMs = now - last;
    last = now;
    const dt = Math.min(dtMs, 100) / 1000;
    const t0 = performance.now();
    const time = now / 1000;

    input.poll();
    me.update(dt, input);
    net.update(dt, me);
    const serverNow = net.serverNow();
    bots?.update(dt, serverNow);
    remotes.update(serverNow - INTERP_DELAY_MS, dt);

    avatars.begin();
    avatars.push(me, time);
    for (const r of remotes.map.values()) if (r.hasData) avatars.push(r, time);
    avatars.end();
    me.updateCamera(camera, dt);

    hud.setPrompt(me.seated ? "stand" : me.nearSeat ? "sit" : "");
    if (remotes.consumeChanged()) hud.renderPlayers(remotes);

    renderer.render(world.scene, camera);
    perf.frame(dtMs, performance.now() - t0);
    hud.updateDebug(now, perf.stats, net.rtt, remotes.map.size + 1);
  };

  // Görünmezken çizme: pil ve Discord'un kendisi için. Ağ bağlantısı açık kalır.
  const run = () => {
    last = performance.now();
    renderer.setAnimationLoop(frame);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) renderer.setAnimationLoop(null);
    else run();
  });
  run();
  loading.remove();
}

void start();
