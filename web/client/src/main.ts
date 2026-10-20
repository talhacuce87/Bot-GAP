// GAP Dünyası istemcisi: giriş → dünya → ana döngü.
import * as THREE from "three";
import {
  ACT_COOLDOWN_MS,
  ACT_SPOTS,
  type Act,
  EMOTE_COOLDOWN_MS,
  EMOTES,
  FISH_COOLDOWN_MS,
  FLAG_RUNNING,
  FLAG_WALKING,
  FISH_SPOT,
  INTERP_DELAY_MS,
  JAIL_CENTER,
  JAIL_SPAWN,
  RELEASE_SPAWN,
} from "../../shared/constants";
import type { Look } from "../../shared/protocol";
import chibiBinUrl from "../chibi/chibi.bin?url";
import chibiManifest from "../chibi/chibi.json";
import { AvatarAtlas } from "./avatars/atlas";
import { AvatarRenderer, colorFor, MAX_AVATARS } from "./avatars/avatars";
import { ChibiLayer } from "./avatars/chibi";
import type { ChibiManifest } from "./avatars/chibiPack";
import { Bots } from "./avatars/bots";
import { EmoteFx, FX_CELL, ThrowFx } from "./avatars/emotes";
import { Remotes } from "./avatars/remotes";
import { login, type Session, watchIdFromPath } from "./discord";
import { Input } from "./input/input";
import { Net } from "./net";
import { PerfGovernor } from "./perf";
import { Player } from "./player";
import { Hud } from "./ui/hud";
import { sakuraEntrance } from "./ui/sakuraFx";
import { plainLook, Wardrobe } from "./ui/wardrobe";
import { openYoutubeTest } from "./ui/youtube";
import { ScreenVideo } from "./watch/screen";
import { WatchSync } from "./watch/sync";
import { WatchPanel } from "./ui/watchPanel";
import { buildWorld, SCREEN_W, SCREEN_Z } from "./world/scene";

const params = new URLSearchParams(location.search);
const canvas = document.getElementById("scene") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud")!;
const loading = document.getElementById("loading")!;

const touch = matchMedia("(pointer: coarse)").matches;
/** Tarayıcıda izleme odası: perdede video oynar (canvas'ın saydam olabilmesi gerekir). */
const watchRoom = watchIdFromPath() !== null;
// Zayıf cihazlarda MSAA kapalı: en pahalı ama en az fark edilen kalite ayarı.
const lowPower = params.has("low") || touch || (navigator.hardwareConcurrency || 4) <= 4;

function fail(msg: string): void {
  loading.textContent = msg;
  loading.classList.add("error");
}

async function start(): Promise<void> {
  const hourParam = params.get("hour");
  const world = buildWorld({ hour: hourParam !== null && hourParam !== "" ? Number(hourParam) : undefined });

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !lowPower,
      alpha: watchRoom,
      powerPreference: "high-performance",
      stencil: false,
    });
  } catch {
    fail("Bu cihazda WebGL açılamadı.");
    return;
  }
  renderer.setSize(innerWidth, innerHeight, false);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 260);
  const perf = new PerfGovernor(renderer, Math.min(devicePixelRatio, 1.5), !params.has("noadapt"));

  let session: Session;
  try {
    session = await login();
  } catch (err) {
    console.error(err);
    fail(`Giriş yapılamadı: ${(err as Error).message}`);
    return;
  }

  const atlas = new AvatarAtlas();
  // Yakındaki avatarlar chibi; paket (~2 MB) arka planda iner, o zamana kadar herkes kapsül.
  const chibi = new ChibiLayer(lowPower ? 14 : 28, lowPower ? 26 : 40);
  world.scene.add(chibi.group);
  void chibi.load(chibiManifest as ChibiManifest, chibiBinUrl).catch((err) => console.warn("[chibi]", err));
  const avatars = new AvatarRenderer(atlas, chibi);
  world.scene.add(avatars.group);
  const remotes = new Remotes(atlas);
  const emoteFx = new EmoteFx();
  world.scene.add(emoteFx.mesh);
  const throwFx = new ThrowFx(emoteFx);
  world.scene.add(throwFx.mesh);

  const me = new Player(world, colorFor(session.user.id));
  me.cell = atlas.alloc(session.user.name);

  // Debug: `?at=x,z,yön` ile istenen noktada başla (ekran görüntüsü, bölge testi).
  const atParam = params.has("debug") ? params.get("at") : null;
  const at = atParam ? atParam.split(",").map(Number) : [];
  if (at.length >= 2 && at.every(Number.isFinite)) me.teleport(at[0], at[1], at[2] ?? Math.PI);

  const input = new Input(canvas, hudRoot);
  const hud = new Hud(hudRoot, session.user.name, input.touch, () => input.triggerAction());
  world.fame.setAvatarUrl((id, hash) => `${session.base}/avatar/${id}/${hash}`);
  const net = new Net(session.wsUrl, remotes);
  net.onBoard = (entries, updated) => world.fame.set(entries, updated);
  net.onEmote = (sid, e) => {
    const r = remotes.map.get(sid);
    if (!r || !r.hasData || e < 0 || e >= EMOTES.length) return;
    const t = performance.now() / 1000;
    r.emote = e;
    r.emoteAt = t;
    emoteFx.emit(r.x, 0, r.z, e, t);
  };
  net.onStatus = (s) => hud.setStatus(s);
  net.onNotice = (text) => hud.toast(text);
  net.onJail = (jailed, x, z, rot) => {
    const was = me.jailed;
    me.jailed = jailed;
    atlas.setName(me.cell, session.user.name, jailed);
    hud.setJailed(jailed);
    if (!Number.isNaN(x)) me.teleport(x, z, rot);
    else if (jailed && !was) me.teleport(JAIL_SPAWN.x, JAIL_SPAWN.z, JAIL_SPAWN.rot);
    else if (!jailed && was) me.teleport(RELEASE_SPAWN.x, RELEASE_SPAWN.z, RELEASE_SPAWN.rot);
  };
  hud.setStatus(net.status);
  if (params.has("debug")) hud.enableDebug(() => void openYoutubeTest(hudRoot, session));

  // Watch party: video perdede, kontroller altta. Odaya giren sinemanın koridorunda başlar.
  let watch: { sync: WatchSync; screen: ScreenVideo; panel: WatchPanel } | null = null;
  if (session.mode === "watch") {
    const screen = new ScreenVideo(world.screen, SCREEN_W);
    const sync = new WatchSync(screen, () => net.serverNow());
    const panel = new WatchPanel(hudRoot, sync, {
      command: (op, pos) => net.send({ t: "wcmd", op, pos }),
      load: (url) => net.send({ t: "wload", url }),
      setInteractive: (on) => screen.setInteractive(on, canvas),
    });
    net.onWatch = (s) => {
      sync.apply(s);
      panel.onState(s);
    };
    net.onNotice = (text) => panel.notice(text);
    watch = { sync, screen, panel };
    hudRoot.classList.add("has-watch");
    if (!at.length) me.teleport(0, SCREEN_Z + 20, Math.PI);
  }

  hud.emoteBar(input.touch, (i) => input.triggerEmote(i));

  // ---- Gardırop: seçim kendi karakterinde canlı görünür; kayıt botta doğrulanır ----
  let savedLook: Look | null = null;
  let saveTimer = 0;
  const wardrobe = new Wardrobe(hudRoot, chibiManifest as ChibiManifest, {
    request: () => net.send({ t: "wardrobe" }),
    preview: (look) => (me.outfit = look),
    save: (look) => {
      net.send({ t: "outfit", outfit: plainLook(look) });
      // Kayıt reddedilirse (bot yok, üye değil) birkaç saniye sonra kayıtlı kıyafete dön.
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => (me.outfit = savedLook), 6000);
    },
    cancel: () => (me.outfit = savedLook),
    opened: () => me.faceCamera(),
  });
  net.onWardrobe = (w) => wardrobe.onInfo(w);
  net.onMyLook = (look) => {
    window.clearTimeout(saveTimer);
    savedLook = look;
    if (!wardrobe.isOpen) me.outfit = look;
  };
  hud.wardrobeButton(input.touch, () => wardrobe.toggle());
  // Debug: gardırobu bot olmadan denemek için (ekran görüntüsü testleri)
  if (params.has("debug")) Object.assign(window, { gapWardrobe: wardrobe });

  // ---- Etkileşimler: mangalda şiş çevir, zindanda çay ver / domates at ----
  const HEART = 2; // EMOTES içindeki ❤️
  const perform = (a: Act, x: number, z: number, name: string, time: number, self: boolean) => {
    if (a === "grill") {
      world.grillBoost(time);
      emoteFx.emit(ACT_SPOTS.grill.x, 1.1, ACT_SPOTS.grill.z, FX_CELL.skewer, time, 0, 3);
      return;
    }
    // Atanın konumuna en yakın sürgündeki kişi; içeride kimse yoksa hücrenin ortası.
    let tx = JAIL_CENTER.x, tz = JAIL_CENTER.z, best = Infinity, toMe = false;
    const consider = (px: number, pz: number, isMe: boolean) => {
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < best) [best, tx, tz, toMe] = [d, px, pz, isMe];
    };
    if (me.jailed) consider(me.x, me.z, true);
    for (const r of remotes.map.values()) if (r.info.jailed && r.hasData && !r.leaving) consider(r.x, r.z, false);
    const tea = a === "tea";
    throwFx.launch(x, 1.5, z, tx, 1.3, tz, tea ? FX_CELL.tea : FX_CELL.tomato, time, tea ? HEART : FX_CELL.splat);
    if (toMe && !self) hud.toast(tea ? `${name} sana çay uzattı 🍵` : `${name} sana domates attı 🍅`);
  };
  net.onAct = (sid, a) => {
    const r = remotes.map.get(sid);
    if (r?.hasData) perform(a, r.x, r.z, r.info.name, performance.now() / 1000, false);
  };
  // Balık: zar botta; sonuç herkese "fish" olayıyla gelir. Nadirlik arttıkça daha çok balık fışkırır.
  const FISH_BURST = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 6 } as const;
  net.onFish = (sid, name, c) => {
    const self = sid === net.you;
    const r = remotes.map.get(sid);
    const [x, z] = self ? [me.x, me.z] : r?.hasData ? [r.x, r.z] : [FISH_SPOT.x, FISH_SPOT.z];
    const time = performance.now() / 1000;
    emoteFx.emit(x, 0, z, FX_CELL.fish, time, undefined, FISH_BURST[c.rarity] ?? 1);
    if (c.rarity === "epic" || c.rarity === "legendary") emoteFx.emit(x, 0.4, z, FX_CELL.sparkle, time + 0.3, undefined, 4);
    if (self) {
      const luck = c.luck > 0 ? ` · şans +%${c.luck.toFixed(1)}` : "";
      hud.toast(`🐟 ${c.label}: ${c.fish}! ${c.hours} saat 2x XP · seri ${c.streak} gün${luck}`);
    } else if (c.rarity === "epic" || c.rarity === "legendary") {
      hud.toast(`🎣 ${name} ${c.label.toLowerCase()} bir ${c.fish} tuttu!`);
    }
  };
  const nearActs = (): { key: "f" | "g"; label: string; act: Act | "fish" }[] => {
    if (me.jailed) return [];
    const g = ACT_SPOTS.grill, bars = ACT_SPOTS.bars;
    if (Math.hypot(me.x - g.x, me.z - g.z) <= g.r) return [{ key: "f", label: "Şiş çevir 🍢", act: "grill" }];
    if (Math.hypot(me.x - FISH_SPOT.x, me.z - FISH_SPOT.z) <= FISH_SPOT.r) return [{ key: "f", label: "Balık tut 🎣", act: "fish" }];
    if (Math.hypot(me.x - bars.x, me.z - bars.z) <= bars.r) {
      return [
        { key: "f", label: "Çay ver 🍵", act: "tea" },
        { key: "g", label: "Domates at 🍅", act: "tomato" },
      ];
    }
    return [];
  };
  let lastAct = -Infinity;
  // Sakura Bahçesi: içeri girince karşılama (kenarda gidip gelirken tekrar tekrar patlamasın)
  const SAKURA_FX_COOLDOWN_MS = 30_000;
  let inGarden = world.sakura.inside(me.x, me.z);
  let lastGardenFx = -Infinity;
  if (input.touch) hud.jumpButton(() => input.triggerJump());
  let lastEmote = 0;

  const botCount = Math.min(MAX_AVATARS - 1, Math.max(0, Number(params.get("bots")) || 0));
  const bots = botCount ? new Bots(remotes, botCount, world.seats) : null;
  if (bots) bots.onEmote = (sid, e) => net.onEmote(sid, e);

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

    world.update(time);
    input.poll();
    const emote = input.consumeEmote();
    if (emote >= 0 && now - lastEmote >= EMOTE_COOLDOWN_MS) {
      lastEmote = now;
      me.emote = emote;
      me.emoteAt = time;
      emoteFx.emit(me.x, 0, me.z, emote, time);
      net.send({ t: "emote", e: emote });
    }
    me.update(dt, input);
    world.sakura.kick(me.x, me.z, me.flags & FLAG_RUNNING ? 1 : me.flags & FLAG_WALKING ? 0.6 : 0);
    if (!inGarden && world.sakura.inside(me.x, me.z, 0.5)) {
      inGarden = true;
      if (now - lastGardenFx >= SAKURA_FX_COOLDOWN_MS) {
        lastGardenFx = now;
        sakuraEntrance();
        hud.toast("🌸 Sakura Bahçesi");
      }
    } else if (inGarden && !world.sakura.inside(me.x, me.z, -1.5)) inGarden = false;

    const acts = nearActs();
    hud.setActs(acts, input.touch, (k) => input.triggerAct(k));
    const actKey = input.consumeAct();
    const act = actKey ? acts.find((a) => a.key === actKey)?.act : undefined;
    if (act === "fish" && now - lastAct >= FISH_COOLDOWN_MS) {
      lastAct = now;
      emoteFx.emit(me.x, 0, me.z, FX_CELL.rod, time, undefined, 1);
      net.send({ t: "fish" });
    } else if (act && act !== "fish" && now - lastAct >= ACT_COOLDOWN_MS) {
      lastAct = now;
      perform(act, me.x, me.z, session.user.name, time, true);
      net.send({ t: "act", a: act });
    }
    throwFx.update(time);
    net.update(dt, me);
    const serverNow = net.serverNow();
    bots?.update(dt, serverNow);
    remotes.update(serverNow - INTERP_DELAY_MS, dt);

    avatars.begin(camera.position);
    avatars.push(me, time, true);
    for (const r of remotes.map.values()) if (r.hasData) avatars.push(r, time);
    avatars.end();
    me.updateCamera(camera, dt);

    hud.setPrompt(me.seated ? "stand" : me.nearSeat ? "sit" : "");
    if (remotes.consumeChanged()) hud.renderPlayers(remotes);

    if (watch) {
      watch.sync.update(dt);
      watch.sync.setDistance(Math.hypot(me.x, me.z - SCREEN_Z));
      watch.panel.update(now);
    }

    renderer.render(world.scene, camera);
    watch?.screen.render(camera);
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
