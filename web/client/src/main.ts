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
  FLAG_SEATED,
  FLAG_WALKING,
  FISH_SPOT,
  INTERP_DELAY_MS,
  JAIL_CENTER,
  JAIL_SPAWN,
  PLAYER_RADIUS,
  RELEASE_SPAWN,
} from "../../shared/constants";
import type { Look } from "../../shared/protocol";
import { DEFAULT_ELEV, FIRE_COOLDOWN_MS, hullCircles, TANK_PARK, TANK_REACH, tankGround } from "../../shared/tank";
import chibiBinUrl from "../chibi/chibi.bin?url";
import chibiManifest from "../chibi/chibi.json";
import { AvatarAtlas } from "./avatars/atlas";
import { AvatarRenderer, bodyY, colorFor, MAX_AVATARS } from "./avatars/avatars";
import { ChibiLayer } from "./avatars/chibi";
import type { ChibiManifest } from "./avatars/chibiPack";
import { Bots } from "./avatars/bots";
import { DustFx } from "./avatars/dust";
import { EmoteFx, FX_CELL, ThrowFx } from "./avatars/emotes";
import { Remotes } from "./avatars/remotes";
import { login, type Session } from "./discord";
import { Input } from "./input/input";
import { onBinds } from "./input/keybinds";
import { Net } from "./net";
import { FrameLimiter, PerfGovernor } from "./perf";
import { Player } from "./player";
import { lowPowerDevice as lowPower, onSettings, settings } from "./settings";
import { Bubbles } from "./ui/bubbles";
import { Hud } from "./ui/hud";
import { sakuraEntrance } from "./ui/sakuraFx";
import { Chat } from "./ui/chat";
import { plainLook, Wardrobe } from "./ui/wardrobe";
import { SettingsPanel } from "./ui/settingsPanel";
import { openYoutubeTest } from "./ui/youtube";
import { ScreenSender } from "./share/sender";
import { ShareViewer } from "./share/viewer";
import { ScreenVideo } from "./watch/screen";
import { WatchSync } from "./watch/sync";
import { WatchPanel } from "./ui/watchPanel";
import { CinemaSign } from "./world/cinemaSign";
import { SEAT_H } from "./world/builder";
import { LEDGE } from "./world/colliders";
import { MAX_PUSHERS } from "./world/grassField";
import { PostFx } from "./world/post";
import { buildWorld, SCREEN_W, SCREEN_Z, type Season } from "./world/scene";
import { runBattle } from "./battle";
import { beginMode, setModeStarter, stopMode, switchMode, wantsBattle } from "./mode";
import { Features } from "./features";
import { aimRay, ShellFx, TankView } from "./world/tank";

/** Perdenin önü (oturma alanı): F ile sinema açılır. */
const CINEMA_FRONT = { minX: -12, maxX: 12, minZ: SCREEN_Z + 3, maxZ: SCREEN_Z + 22 };

const params = new URLSearchParams(location.search);
/** Mod değişince yenisiyle değişir (temiz WebGL bağlamı). */
let canvas = document.getElementById("scene") as HTMLCanvasElement;
const hudRoot = document.getElementById("hud")!;
const loading = document.getElementById("loading")!;

function fail(msg: string): void {
  loading.textContent = msg;
  loading.classList.add("error");
}

async function start(): Promise<void> {
  const life = beginMode();
  const hourParam = params.get("hour");
  const world = buildWorld({
    hour: hourParam !== null && hourParam !== "" ? Number(hourParam) : undefined,
    grass: settings.grass,
    lamps: settings.lamps,
    season: (["spring", "summer", "autumn", "winter"] as const).find((x) => x === params.get("season")) as Season | undefined,
  });

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: settings.antialias,
      // Saydam: sinema perdesi bir "delik"tir, video canvas'ın arkasındaki katmanda oynar
      // (izleme odasında ve Activity'de sunucudan aktarılan videoda).
      alpha: true,
      powerPreference: "high-performance",
      stencil: false,
    });
  } catch {
    fail("Bu cihazda WebGL açılamadı.");
    return;
  }
  renderer.setSize(innerWidth, innerHeight, false);
  // Ton eşleme: düşük poli renkler aynı kalır, yalnızca parlak uçlar (güneş, lambalar) yumuşar
  renderer.toneMapping = THREE.NeutralToneMapping;
  const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.1, 260);
  life.onStop(() => {
    renderer.setAnimationLoop(null);
    post?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  });
  const perf = new PerfGovernor(renderer, Math.min(devicePixelRatio, settings.maxDpr), settings.adaptive);
  perf.configure(Math.min(devicePixelRatio, settings.maxDpr), settings.fpsCap);
  const limiter = new FrameLimiter();
  // Kare başına elle sıfırlanır: son işlem açıkken birden çok geçişin çizimleri de sayılsın.
  renderer.info.autoReset = false;
  // Son işlem (parıltı, renk): ayarda açıksa ilk gerektiğinde kurulur. Perdede video varken kapalı
  // (video saydam "delik"ten görünür; son işlem alfayı korumaz).
  let post: PostFx | null = null;
  const applyGraphics = () => {
    renderer.shadowMap.enabled = settings.shadows !== "off";
    renderer.shadowMap.type = THREE.PCFShadowMap;
    world.setShadows(settings.shadows);
    perf.adaptive = settings.adaptive;
    perf.configure(Math.min(devicePixelRatio, settings.maxDpr), settings.fpsCap);
    camera.fov = settings.fov;
    camera.updateProjectionMatrix();
    hudRoot.classList.toggle("no-bubbles", !settings.bubbles);
  };
  applyGraphics();
  life.onStop(onSettings(applyGraphics));

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
  const dust = new DustFx();
  world.scene.add(dust.mesh);
  const bubbles = new Bubbles(hudRoot);
  /** Sinemada oynayan bir şey var: hoparlörler titrer, notalar çıkar. */
  let musicOn = false;
  let lastNote = 0;

  // ---- Tank: odada tek; boşsa yanında F ile binilir, Space ateş, F ile inilir ----
  const tankView = new TankView();
  world.scene.add(tankView.group);
  const shells = new ShellFx();
  world.scene.add(shells.group);
  const tank = { driver: 0, x: TANK_PARK.x, z: TANK_PARK.z, h: TANK_PARK.h, tr: TANK_PARK.h, el: DEFAULT_ELEV };
  tankView.set(tank.x, tank.z, tank.h, tank.tr, tank.el);
  let lastAim = { h: NaN, tr: NaN, el: NaN, at: 0 };
  let lastFire = -Infinity;
  let tankPrev = { x: tank.x, z: tank.z };
  // Nişangâh ekranın ortasında (GTA gibi); kule ve namlu oraya döner. Dönerken ve doldururken soluk.
  const crosshair = document.createElement("div");
  crosshair.className = "crosshair";
  hudRoot.append(crosshair);
  const aimPoint = new THREE.Vector3();

  const me = new Player(world, colorFor(session.user.id));
  me.cell = atlas.alloc(session.user.name);

  // Debug: `?at=x,z,yön` ile istenen noktada başla (ekran görüntüsü, bölge testi).
  const atParam = params.has("debug") ? params.get("at") : null;
  const at = atParam ? atParam.split(",").map(Number) : [];
  if (at.length >= 2 && at.every(Number.isFinite)) me.teleport(at[0], at[1], at[2] ?? Math.PI);

  const input = new Input(canvas, hudRoot);
  const hud = new Hud(hudRoot, session.user.name, input.touch, () => input.triggerAction());
  life.onStop(() => input.dispose());
  life.onStop(onBinds(() => hud.refreshHint()));
  world.fame.setAvatarUrl((id, hash) => `${session.base}/avatar/${id}/${hash}`);
  if (!life.active) return;
  const net = new Net(session.wsUrl, remotes);
  life.onStop(() => net.close());
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
  net.onTank = (s) => {
    Object.assign(tank, s);
    if (s.driver === net.you) {
      if (!me.driving) {
        me.enterTank(s.x, s.z, s.h, s.tr, s.el);
        input.setPointerLock(true);
        hud.toast(input.touch
          ? "🪖 Joystick: sür · sağ yarı: nişan · ⤒: ateş · F: in"
          : "🪖 W/S: ileri-geri · A/D: dön · fare: nişan · sol tık/Space: ateş · F: in · Esc: imleci bırak");
      }
    } else if (me.driving) {
      me.exitTank();
      input.setPointerLock(false);
    }
    if (!s.driver) tankView.set(s.x, s.z, s.h, s.tr, s.el);
  };
  net.onTaim = (h, tr, el) => {
    tank.h = h;
    tank.tr = tr;
    tank.el = el;
  };
  const nameOf = (sid: number) => (sid === net.you ? session.user.name : remotes.map.get(sid)?.info.name ?? "Biri");
  net.onShell = (sid, shot, hits) => {
    const time = performance.now() / 1000;
    shells.fire(shot, time, camera.position);
    // Uzak sürücünün kulesi "taim"den geride kalmış olabilir: atış yönüne hizala
    if (sid !== net.you) {
      tank.tr = tankView.tr = Math.atan2(shot.dx, shot.dz);
      tank.el = tankView.el = Math.atan2(shot.vy, shot.vh);
    }
    tankView.recoil(time);
    const mine = hits.find((h) => h.sid === net.you);
    if (mine) {
      window.setTimeout(() => {
        me.knock(mine.vx, mine.vz);
        hud.toast(`💥 ${nameOf(sid)} seni vurdu!`);
      }, shot.flight * 1000);
    }
  };
  shells.onImpact = (x, y, z) => emoteFx.emit(x, y, z, FX_CELL.splat, performance.now() / 1000, 0.3, 4);
  hud.setStatus(net.status);
  // Hata ayıklama paneli (?debug) ya da ayarlardaki FPS göstergesi
  const syncFps = () => {
    if (params.has("debug")) return;
    if (settings.showFps) hud.enableDebug();
    else hud.disableDebug();
  };
  if (params.has("debug")) hud.enableDebug(() => void openYoutubeTest(hudRoot, session));
  syncFps();
  life.onStop(onSettings(syncFps));
  new SettingsPanel(hudRoot, () => switchMode(false));

  // Watch party: video perdede, kontroller altta. Odaya giren sinemanın koridorunda başlar.
  let watch: { sync: WatchSync; screen: ScreenVideo; panel: WatchPanel } | null = null;
  // Perde tek: sinema videosu ve ekran paylaşımı aynı kutuda (paylaşım üstte).
  const screen = new ScreenVideo(world.screen, SCREEN_W);
  life.onStop(() => screen.destroy());
  /** Sinema sesi ayardan; video bitince sıradaki şarkı istenir. */
  const wireSync = (sync: WatchSync) => {
    sync.setVolume(settings.cinemaVolume);
    life.onStop(onSettings(() => sync.setVolume(settings.cinemaVolume)));
    sync.onEnded = () => net.send({ t: "wended" });
    return sync;
  };
  if (session.mode === "watch") {
    const sync = wireSync(new WatchSync(screen, () => net.serverNow()));
    const panel = new WatchPanel(hudRoot, sync, {
      command: (op, pos) => net.send({ t: "wcmd", op, pos }),
      load: (url) => net.send({ t: "wload", url }),
      setInteractive: (on) => screen.setInteractive(on, canvas),
      fullscreen: screen.canFullscreen ? () => void screen.toggleFullscreen() : null,
    });
    net.onWatch = (s) => {
      sync.apply(s);
      panel.onState(s);
      musicOn = !!s.source && s.playing;
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
  // Gardırop ekranı kaplarken dünya çizilmez (son kare arkada donuk kalır), GPU önizlemeye kalır
  let worldPaused = false;
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
    modal: (open) => {
      worldPaused = open;
      input.setBlocked(open);
      hudRoot.classList.toggle("modal-open", open);
    },
    pack: () => chibi.pack,
  }, session.user.name);
  life.onStop(() => wardrobe.dispose());
  net.onWardrobe = (w) => wardrobe.onInfo(w);
  const showStatus = net.onStatus;
  net.onStatus = (s) => {
    showStatus(s);
    if (s === "online") wardrobe.retry();
  };
  net.onMyLook = (look) => {
    window.clearTimeout(saveTimer);
    savedLook = look;
    if (!wardrobe.isOpen) me.outfit = look;
  };
  hud.wardrobeButton(input.touch, () => wardrobe.toggle());
  input.onWardrobe = () => wardrobe.toggle();
  // Geliştirirken doğrudan gardıropla açılır (?gardirop, sekmeyle: ?gardirop=tops)
  if (params.has("gardirop")) wardrobe.open(params.get("gardirop") ?? undefined);

  // ---- Sohbet ve sinema: "!" komutları, !izle ile izleme odası açılır ----
  // Activity içinde dış bağlantı Discord'un onay penceresiyle açılır; tarayıcıda yeni sekme.
  const openUrl = (url: string) => {
    if (session.sdk) void session.sdk.commands.openExternalLink({ url }).catch((err) => console.warn("[open]", err));
    else window.open(url, "_blank", "noopener");
  };
  const chat = new Chat(
    hudRoot,
    {
      send: (text) => net.send({ t: "chat", text }),
      open: openUrl,
      local: (text) => {
        if (/^[!/](payla[şs]|ekran)/i.test(text)) {
          void toggleShare();
          return true;
        }
        if (/^[!/](sava[şs]|tank)(\s|$)/i.test(text)) {
          switchMode(true);
          return true;
        }
        if (!/^[!/](gard[ıi]rop|kiyafet|kıyafet)\b/i.test(text)) return false;
        wardrobe.open();
        return true;
      },
    },
    input.touch,
  );
  net.onChat = (line) => {
    chat.add(line, line.kind === "say" && line.sid === net.you);
    if (line.kind === "say" && line.sid >= 0) bubbles.say(line.sid, line.text, performance.now());
  };
  net.onChatLog = (lines) => chat.setLog(lines);
  net.onOpen = openUrl;
  const openCinema = () => chat.focus("!izle ");
  // Activity'de video oynatılamaz: perde "Şimdi oynuyor" tabelasına döner, üstte "Tarayıcıda izle" bandı.
  // Sinema bu odaya bağlıdır; linkle gelenler de bu dünyaya girer.
  let cinemaSign: CinemaSign | null = null;
  /** Odadaki sinemanın tarayıcı linki (yalnızca tarayıcıda izlenebilen kaynakta); perdenin önünde F ile açılır. */
  let cinemaLink: string | null = null;
  /** Sinemada bir şey oynuyor mu (perdede ya da tarayıcıda). */
  let cinemaOn = false;
  // Tank savaşı: aynı odanın savaş odası (izleme odasından da); geçiş sayfa yenilenmeden
  const battleBtn = document.createElement("button");
  battleBtn.className = "wardrobe-btn battle-btn";
  battleBtn.textContent = "⚔️";
  battleBtn.title = "Tank savaşı (!savaş)";
  battleBtn.addEventListener("click", () => switchMode(true));
  hudRoot.append(battleBtn);
  if (session.mode !== "watch") {
    hud.cinemaButton(openCinema);
    // Dosya/HLS (TRT, .m3u8, .mp4) sunucu üzerinden aktarılır ve perdede oynar; YouTube/Twitch/Kick
    // Activity'de oynatılamaz: perde "Şimdi oynuyor" tabelası olur, video tarayıcıda izlenir.
    // ScreenVideo, CinemaSign'dan önce kurulur: ikisi de perdenin özgün malzemesini saklar.
    const sign = (cinemaSign = new CinemaSign(world.screen, session.base));
    let inWorld: { sync: WatchSync; panel: WatchPanel } | null = null;
    net.onWatch = (s, link) => {
      const id = link?.split("/w/")[1] ?? null;
      const src = s.source;
      cinemaOn = !!src;
      musicOn = !!src && s.playing;
      if (src?.kind === "file" && id) {
        sign.set(null);
        if (!inWorld) {
          const sync = wireSync(new WatchSync(screen, () => net.serverNow()));
          const panel = new WatchPanel(hudRoot, sync, {
            command: (op, pos) => net.send({ t: "wcmd", op, pos }),
            load: (url) => net.send({ t: "wload", url }),
            setInteractive: (on) => screen.setInteractive(on, canvas),
            fullscreen: screen.canFullscreen ? () => void screen.toggleFullscreen().catch(() => {}) : null,
          });
          inWorld = { sync, panel };
          watch = { sync, screen, panel };
          sync.setSuppressed(viewer !== null); // paylaşım sürüyorsa sinema sessiz başlar
        }
        const proxied = { ...src, url: `${session.base}/media/${id}/p?u=${encodeURIComponent(src.url)}` };
        inWorld.sync.apply({ ...s, source: proxied });
        inWorld.panel.onState(s);
        inWorld.panel.setVisible(true);
        hudRoot.classList.add("has-watch");
        cinemaLink = null;
        hud.setNowPlaying(null, null);
        return;
      }
      if (inWorld) {
        inWorld.sync.apply({ ...s, source: null });
        inWorld.panel.setVisible(false);
        hudRoot.classList.remove("has-watch");
      }
      sign.set(s);
      cinemaLink = src && link ? link : null;
      hud.setNowPlaying(src ? s.title : null, link ? () => openUrl(link) : null);
    };
  }
  // ---- Ekran paylaşımı: paylaşanın ekranı sunucu üzerinden herkesin sinema perdesine gelir ----
  const shareUrl = session.wsUrl.replace("/ws?", "/share?");
  let sender: ScreenSender | null = null;
  let viewer: ShareViewer | null = null;
  life.onStop(() => {
    sender?.stop();
    viewer?.destroy();
    viewer = null;
  });
  let sharer = { sid: 0, name: "" };
  /** İzleyen biri "Sesi aç"a bastı mı (sonraki paylaşımlarda da açık kalır). */
  let shareSound = false;
  const shareActions = {
    sound: () => {
      shareSound = true;
      viewer?.setMuted(false);
      renderShare();
    },
    fullscreen: screen.canFullscreen ? () => void screen.toggleFullscreen().catch(() => {}) : null,
    stop: () => sender?.stop(),
  };
  const renderShare = () => {
    const mine = sharer.sid !== 0 && sharer.sid === net.you;
    hud.setShare(sharer.sid ? { name: sharer.name, mine, muted: !mine && !shareSound } : null, shareActions);
  };
  /** Paylaşımı perdede açar; bağlantı beklenmedik koparsa paylaşım sürdükçe yeniden bağlanır. */
  const openViewer = (sid: number) => {
    const v = (viewer = new ShareViewer(`${shareUrl}&role=view`));
    // Paylaşan kendi sesini duymaz (yankı); diğerleri bir kez tıklayınca duyar
    v.setMuted(sid === net.you || !shareSound);
    v.onEnd = (reason, unexpected) => {
      if (viewer !== v) return;
      viewer = null;
      screen.setOverlay(null);
      if (reason) hud.toast(reason);
      else if (unexpected) {
        window.setTimeout(() => {
          if (!viewer && sharer.sid === sid) openViewer(sid);
        }, 1500);
      }
    };
    screen.setOverlay(v.video);
  };
  net.onShare = (sid, name) => {
    if (sid === sharer.sid && viewer) return;
    sharer = { sid, name };
    viewer?.destroy();
    viewer = null;
    if (sid) {
      openViewer(sid);
      cinemaSign?.suspend(true);
      watch?.sync.setSuppressed(true);
      if (sid !== net.you) hud.toast(`🖥️ ${name} ekranını paylaşıyor — sinema perdesine bak`);
    } else {
      screen.setOverlay(null);
      cinemaSign?.suspend(false);
      watch?.sync.setSuppressed(false);
    }
    renderShare();
  };
  /** Discord içinden paylaşılamıyorsa aynı odayı tarayıcıda açar (oradan paylaşılır, herkes perdede görür). */
  const shareInBrowser = () => {
    if (!session.sdk) return hud.toast("🖥️ Bu tarayıcı ekran paylaşımını desteklemiyor (bilgisayardan Chrome/Edge/Firefox dene).");
    hud.toast("🖥️ Discord içinden ekran paylaşılamıyor: aynı oda tarayıcıda açılıyor, oradan paylaş.");
    net.send({ t: "sharelink" });
  };
  const toggleShare = async () => {
    if (sender) return sender.stop();
    if (sharer.sid && sharer.sid !== net.you) return hud.toast(`🖥️ Şu an ${sharer.name} ekranını paylaşıyor.`);
    if (!ScreenSender.supported()) return shareInBrowser();
    const t0 = performance.now();
    let stream: MediaStream;
    try {
      stream = await ScreenSender.capture();
    } catch (err) {
      // İzin politikası (Discord içi) seçme penceresini hiç açmaz; kullanıcı iptali daha geç gelir.
      if (session.sdk && (/policy|not allowed in this context/i.test((err as Error).message) || performance.now() - t0 < 400)) shareInBrowser();
      return;
    }
    startShare(stream);
  };
  const startShare = (stream: MediaStream) => {
    const s = (sender = new ScreenSender(stream, `${shareUrl}&role=send&sid=${net.you}`));
    s.onStop = (reason) => {
      if (sender === s) sender = null;
      if (reason) hud.toast(reason);
    };
    if (!s.hasAudio) hud.toast("🖥️ Paylaşım başladı. Ses için paylaşırken \"sekme/sistem sesini paylaş\" kutusunu işaretle.");
  };
  hud.shareButton(() => void toggleShare());
  if (session.mode === "watch" && params.has("share")) {
    hud.highlightShare();
    hud.toast("🖥️ Ekranını paylaşmak için sağdaki 🖥️ düğmesine bas.");
  }

  // Debug: gardırobu bot olmadan denemek için (ekran görüntüsü testleri)
  if (params.has("debug")) Object.assign(window, { gapWardrobe: wardrobe, gapNet: net, gapDust: dust, gapMe: me, gapShare: startShare });

  // ---- Etkileşimler: mangalda şiş çevir, zindanda çay ver / domates at ----
  const HEART = 2; // EMOTES içindeki ❤️
  const perform = (a: Act, x: number, z: number, name: string, time: number, self: boolean) => {
    if (a === "cay") {
      emoteFx.emit(x, 0, z, FX_CELL.tea, time, undefined, 2);
      return;
    }
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
  // Günlük balık hakkı: göle gelince sunucuya sorulur; doluysa "Balık tut" yerine geri sayım çıkar.
  let fishAt = 0;
  let atPond = false;
  net.onFishWait = (at) => (fishAt = at);
  const fishLabel = (): string => {
    const left = Math.ceil((fishAt - net.serverNow()) / 1000);
    if (left <= 0) return "Balık tut 🎣";
    const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `🎣 Sonraki balık: ${h ? `${h}sa ` : ""}${p2(m)}dk ${p2(s)}sn`;
  };
  const nearActs = (): { key: "f" | "g"; label: string; act: string }[] => {
    if (me.jailed) return [];
    if (me.driving) return [{ key: "f", label: "Tanktan in 🚪", act: "tankout" }];
    const extra = features.acts();
    if (extra.length) return extra;
    if (!tank.driver && Math.hypot(me.x - tankView.x, me.z - tankView.z) <= TANK_REACH) {
      return [{ key: "f", label: "Tanka bin 🪖", act: "tankin" }];
    }
    const c = CINEMA_FRONT;
    if (session.mode !== "watch" && me.x >= c.minX && me.x <= c.maxX && me.z >= c.minZ && me.z <= c.maxZ) {
      // Sinema açıksa: F tarayıcıda izle, G videoyu değiştir
      return cinemaLink
        ? [
            { key: "f", label: "Tarayıcıda izle 🍿", act: "watch" },
            { key: "g", label: "Videoyu değiştir 🎬", act: "cinema" },
          ]
        : [{ key: "f", label: cinemaOn ? "Videoyu değiştir 🎬" : "Sinemayı aç 🎬", act: "cinema" }];
    }
    const g = ACT_SPOTS.grill, bars = ACT_SPOTS.bars;
    if (Math.hypot(me.x - g.x, me.z - g.z) <= g.r) return [{ key: "f", label: "Şiş çevir 🍢", act: "grill" }];
    const pond = Math.hypot(me.x - FISH_SPOT.x, me.z - FISH_SPOT.z) <= FISH_SPOT.r;
    if (pond && !atPond) net.send({ t: "fishq" });
    atPond = pond;
    if (pond) return [{ key: "f", label: fishLabel(), act: "fish" }];
    if (Math.hypot(me.x - bars.x, me.z - bars.z) <= bars.r) {
      return [
        { key: "f", label: "Çay ver 🍵", act: "tea" },
        { key: "g", label: "Domates at 🍅", act: "tomato" },
      ];
    }
    return [];
  };
  let lastAct = -Infinity;
  /** Oturanın koltuğu bankdan ne kadar alçak (kütük); Player.sitOn ile aynı. */
  const seatDrop = (x: number, z: number): number => {
    for (const s of world.seats) if (Math.abs(s.x - x) < 0.05 && Math.abs(s.z - z) < 0.05) return (s.h ?? SEAT_H) - SEAT_H;
    return 0;
  };
  // Sakura Bahçesi: içeri girince karşılama (kenarda gidip gelirken tekrar tekrar patlamasın)
  const SAKURA_FX_COOLDOWN_MS = 30_000;
  let inGarden = world.sakura.inside(me.x, me.z);
  let lastGardenFx = -Infinity;
  if (input.touch) hud.jumpButton(() => input.triggerJump());
  let lastEmote = 0;

  const botCount = Math.min(MAX_AVATARS - 1, Math.max(0, Number(params.get("bots")) || 0));
  const bots = botCount ? new Bots(remotes, botCount, world.seats) : null;
  if (bots) bots.onEmote = (sid, e) => net.onEmote(sid, e);

  // Çizim: son işlem açıksa (ya da fotoğraf filtresi varsa) composer, değilse doğrudan
  const postOpts = { bloom: false, grade: false, filter: 0, godrays: false, sunDir: world.sunDir, dof: 0 };
  const renderScene = (dt: number) => {
    if (worldPaused) return;
    postOpts.bloom = settings.bloom;
    postOpts.grade = settings.grade;
    postOpts.filter = features.filter;
    postOpts.godrays = settings.godrays;
    // Fotoğraf modu: karakter net, önü ve arkası bulanık (birinci şahısta bakılan yer uzak: kapalı)
    postOpts.dof = features.photo.active && !settings.firstPerson ? Math.hypot(camera.position.x - me.x, camera.position.y - 1, camera.position.z - me.z) : 0;
    if ((postOpts.bloom || postOpts.grade || postOpts.filter || postOpts.godrays || postOpts.dof) && !screen.isActive) {
      post ??= new PostFx(renderer, world.scene, camera, settings.antialias ? 4 : 0);
      post.render(dt, world.env, postOpts);
    } else {
      renderer.render(world.scene, camera);
    }
    screen.render(camera);
  };

  // ---- Yeni özellikler: hava, futbol, kahvehane, DJ, mini oyunlar, araçlar, görevler, fotoğraf ----
  const features = new Features({
    life, world, net, me, remotes, atlas, avatars, hud, hudRoot, input, emoteFx, session, camera, canvas, lowPower,
    renderNow: () => renderScene(0),
    say: (text) => net.send({ t: "chat", text }),
    battle: () => switchMode(true),
    music: () => (musicOn ? 1 : 0),
    cinemaOn: () => cinemaOn,
    inCinema: () => {
      const c = CINEMA_FRONT;
      return cinemaOn && me.x >= c.minX && me.x <= c.maxX && me.z >= c.minZ && me.z <= c.maxZ;
    },
  });

  addEventListener("resize", () => {
    if (!life.active) return;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  const pushers: { x: number; z: number; r: number }[] = [];
  let last = performance.now();
  const frame = (now: number) => {
    if (!limiter.ready(now, settings.fpsCap)) return;
    const dtMs = now - last;
    last = now;
    const dt = Math.min(dtMs, 100) / 1000;
    const t0 = performance.now();
    const time = now / 1000;
    renderer.info.reset();

    world.update(time, me);
    input.poll();
    const emote = input.consumeEmote();
    if (emote >= 0 && now - lastEmote >= EMOTE_COOLDOWN_MS) {
      lastEmote = now;
      me.emote = emote;
      me.emoteAt = time;
      emoteFx.emit(me.x, 0, me.z, emote, time);
      net.send({ t: "emote", e: emote });
    }
    features.keys();
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
    if (act && features.handleAct(act, now)) {
      // yeni özelliklerin etkileşimi işlendi
    } else if (act === "tankin") {
      net.send({ t: "tank", on: true });
    } else if (act === "tankout") {
      // Önce iniş mesajı, sonra yeni konum: sunucu tankı son sürüş konumuna park eder
      net.send({ t: "tank", on: false });
      me.exitTank();
      input.setPointerLock(false);
    } else if (act === "cinema") {
      openCinema();
    } else if (act === "watch") {
      if (cinemaLink) openUrl(cinemaLink);
    } else if (act === "fish" && now - lastAct >= FISH_COOLDOWN_MS) {
      lastAct = now;
      emoteFx.emit(me.x, 0, me.z, FX_CELL.rod, time, undefined, 1);
      net.send({ t: "fish" });
    } else if (act && act !== "fish" && now - lastAct >= ACT_COOLDOWN_MS) {
      lastAct = now;
      perform(act as Act, me.x, me.z, session.user.name, time, true);
      net.send({ t: "act", a: act as Act });
    }
    if (me.driving) {
      const d = me.driving;
      // Değişince en fazla 15 Hz; değişmese de yarım saniyede bir (düşen mesaj kalıcı sapma bırakmasın)
      const changed = Math.abs(d.h - lastAim.h) + Math.abs(d.tr - lastAim.tr) + Math.abs(d.el - lastAim.el) > 0.01;
      if ((changed && now - lastAim.at > 66) || now - lastAim.at > 500) {
        lastAim = { h: d.h, tr: d.tr, el: d.el, at: now };
        net.send({ t: "taim", h: d.h, tr: d.tr, el: d.el });
      }
      if (me.wantsFire) {
        me.wantsFire = false;
        if (now - lastFire >= FIRE_COOLDOWN_MS) {
          lastFire = now;
          net.send({ t: "fire", h: d.h, tr: d.tr, el: d.el });
        }
      }
    }
    throwFx.update(time);
    cinemaSign?.update(net.serverNow());
    net.update(dt, me);
    const serverNow = net.serverNow();
    bots?.update(dt, serverNow);
    // Başkalarının durduğu yüzey konumlarından bulunur (çeşme, bank, tank üstü)
    const hull = hullCircles(tankView.x, tankView.z, tankView.h);
    remotes.update(serverNow - INTERP_DELAY_MS, dt, (x, z, seated) =>
      seated
        ? seatDrop(x, z)
        : Math.max(world.colliders.groundAt(x, z, PLAYER_RADIUS), tankGround(hull, x, z, PLAYER_RADIUS * LEDGE)),
    );

    // Tank: kendi sürüşü yerel; uzak sürücüde konum onun snapshot'ı, açılar "taim"; yoksa park yeri
    const driver = tank.driver && tank.driver !== net.you ? remotes.map.get(tank.driver) : undefined;
    if (me.driving) tankView.set(me.x, me.z, me.driving.h, me.driving.tr, me.driving.el);
    else if (driver?.hasData) tankView.set(driver.x, driver.z, tank.h, tank.tr, tank.el, 1 - Math.exp(-dt * 10));
    else if (!tank.driver) tankView.set(tank.x, tank.z, tank.h, tank.tr, tank.el);
    const moving = Math.min(1, Math.hypot(tankView.x - tankPrev.x, tankView.z - tankPrev.z) / Math.max(dt, 1e-3) / 3);
    tankPrev = { x: tankView.x, z: tankView.z };
    tankView.setSkin(tank.driver === net.you ? settings.skin : tank.driver ? remotes.map.get(tank.driver)?.info.skin : null);
    tankView.update(time, moving);
    shells.update(time, camera.position);
    me.obstacle = me.driving ? null : hullCircles(tankView.x, tankView.z, tankView.h);

    features.decorate();
    avatars.begin(camera.position);
    if (!me.driving) avatars.push(me, time, true);
    for (const r of remotes.map.values()) if (r.hasData && r.info.sid !== tank.driver) avatars.push(r, time);
    features.pushExtras(time, dt);
    avatars.end();
    me.updateCamera(camera, dt);
    features.update(time, dt, now);
    if (me.driving) {
      me.aimAt = aimRay(camera, aimPoint);
      crosshair.classList.add("show");
      crosshair.classList.toggle("reloading", now - lastFire < FIRE_COOLDOWN_MS || !me.aimReady);
    } else {
      me.aimAt = null;
      crosshair.classList.remove("show");
    }

    // Zıplama tozu (kalkış/iniş) ve çimeni iten karakterler: sen + en yakınlar
    dust.light.value = 0.45 + 0.55 * world.env.day;
    dust.track(me, time, camera.position);
    pushers.length = 0;
    pushers.push({ x: me.x, z: me.z, r: me.seated ? 0.001 : 0.75 });
    for (const r of remotes.map.values()) {
      if (!r.hasData) continue;
      dust.track(r, time, camera.position);
      if (world.grass && (r.flags & FLAG_SEATED) === 0 && pushers.length < MAX_PUSHERS && (r.x - me.x) ** 2 + (r.z - me.z) ** 2 < 400) {
        pushers.push({ x: r.x, z: r.z, r: 0.75 });
      }
    }
    world.grass?.update(camera, pushers);

    world.setMusic(musicOn);
    if (musicOn && time - lastNote > 0.55) {
      lastNote = time;
      const sp = world.speakers[Math.floor(Math.random() * world.speakers.length)];
      emoteFx.emit(sp.x + (Math.random() - 0.5) * 0.8, sp.y, sp.z + 0.5, Math.random() < 0.5 ? FX_CELL.note : FX_CELL.notes, time, 0, 1);
    }

    bubbles.update(now, camera, (sid) => {
      if (sid === net.you) return { x: me.x, z: me.z, y: bodyY(me) };
      const r = remotes.map.get(sid);
      return r?.hasData && !r.leaving ? { x: r.x, z: r.z, y: bodyY(r) } : null;
    });

    hud.setPrompt(me.seated ? "stand" : me.nearSeat ? "sit" : "");
    if (remotes.consumeChanged()) hud.renderPlayers(remotes, (sid, name) => features.openCard(sid, name));

    // Paylaşımın sesi de sinemadan uzaklaştıkça kısılır
    viewer?.setVolume(settings.shareVolume * Math.min(1, Math.max(0.06, 1 - (Math.hypot(me.x, me.z - SCREEN_Z) - 18) / 45)));
    if (watch) {
      watch.sync.update(dt);
      watch.sync.setDistance(Math.hypot(me.x, me.z - SCREEN_Z));
      watch.panel.update(now);
    }

    renderScene(dt);
    perf.frame(dtMs, performance.now() - t0);
    hud.updateDebug(now, perf.stats, net.rtt, remotes.map.size + 1);
  };

  // Görünmezken çizme: pil ve Discord'un kendisi için. Ağ bağlantısı açık kalır.
  const run = () => {
    last = performance.now();
    renderer.setAnimationLoop(frame);
  };
  document.addEventListener("visibilitychange", () => {
    if (!life.active) return;
    if (document.hidden) renderer.setAnimationLoop(null);
    else run();
  });
  run();
  loading.remove();
}

/** Dünya ↔ savaş: çalışan mod durur, sayfa yenilenmeden diğeri başlar (Discord Activity'de yenileme güvenilir değil). */
setModeStarter((battle) => {
  stopMode();
  const fresh = canvas.cloneNode() as HTMLCanvasElement;
  canvas.replaceWith(fresh);
  canvas = fresh;
  hudRoot.replaceChildren();
  hudRoot.className = "";
  loading.textContent = battle ? "Tank savaşı yükleniyor…" : "GAP Dünyası yükleniyor…";
  loading.classList.remove("error");
  if (!loading.isConnected) document.body.append(loading);
  void (battle ? runBattle(canvas, hudRoot, loading, lowPower) : start());
});

void (wantsBattle() ? runBattle(canvas, hudRoot, loading, lowPower) : start());
