// Tank savaşı istemcisi: arena, takım seçimi, herkes tankta. Dünyadan "!savaş" ile girilir (sayfa yenilenmeden, mode.ts).
// Kurallar sunucuda (server/src/battle.ts); burada sürüş, nişan, çizim ve arayüz var.
import * as THREE from "three";
import { TANK_HP, TEAMS, type Team } from "../../shared/arena";
import { INTERP_DELAY_MS } from "../../shared/constants";
import type { BattleState, Fighter } from "../../shared/protocol";
import { DEFAULT_ELEV, FIRE_COOLDOWN_MS } from "../../shared/tank";
import { AvatarAtlas } from "./avatars/atlas";
import { colorFor } from "./avatars/avatars";
import { EmoteFx, FX_CELL } from "./avatars/emotes";
import { Remotes } from "./avatars/remotes";
import { login } from "./discord";
import { beginMode, switchMode } from "./mode";
import { Input } from "./input/input";
import { onBinds } from "./input/keybinds";
import { Net } from "./net";
import { FrameLimiter, PerfGovernor } from "./perf";
import { Player } from "./player";
import { onSettings, settings } from "./settings";
import { Chat } from "./ui/chat";
import { Hud } from "./ui/hud";
import { SettingsPanel } from "./ui/settingsPanel";
import { buildArena } from "./world/arena";
import type { World } from "./world/scene";
import { aimRay, ShellFx, TankView } from "./world/tank";

/** Takım tonu, tankın nötr metaliyle çarpılır. */
const TINTS = ["#d8705f", "#6f95e6"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.append(e);
  return e;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

interface Foe {
  view: TankView;
  aim: { h: number; tr: number; el: number };
  label: HTMLDivElement;
  prev: { x: number; z: number };
}

export async function runBattle(canvas: HTMLCanvasElement, hudRoot: HTMLElement, loading: HTMLElement, lowPower: boolean): Promise<void> {
  const life = beginMode();
  const fail = (msg: string) => {
    loading.textContent = msg;
    loading.classList.add("error");
  };
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.antialias && !lowPower, powerPreference: "high-performance", stencil: false });
  } catch {
    fail("Bu cihazda WebGL açılamadı.");
    return;
  }
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.1, 260);
  const perf = new PerfGovernor(renderer, Math.min(devicePixelRatio, settings.maxDpr), settings.adaptive);
  const limiter = new FrameLimiter();
  const applySettings = () => {
    perf.adaptive = settings.adaptive;
    perf.configure(Math.min(devicePixelRatio, settings.maxDpr), settings.fpsCap);
    camera.fov = settings.fov;
    camera.updateProjectionMatrix();
  };
  applySettings();
  life.onStop(onSettings(applySettings));
  life.onStop(() => {
    renderer.setAnimationLoop(null);
    renderer.dispose();
    renderer.forceContextLoss();
    if (document.pointerLockElement) document.exitPointerLock();
  });
  addEventListener("resize", () => {
    if (!life.active) return;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  let session;
  try {
    session = await login();
  } catch (err) {
    fail(`Giriş yapılamadı: ${(err as Error).message}`);
    return;
  }
  if (!life.active) return;

  const arena = buildArena();
  const scene = arena.scene;
  const shells = new ShellFx();
  scene.add(shells.group);
  const fx = new EmoteFx();
  scene.add(fx.mesh);
  shells.onImpact = (x, y, z) => fx.emit(x, y, z, FX_CELL.splat, performance.now() / 1000, 0.3, 4);

  const remotes = new Remotes(new AvatarAtlas());
  const me = new Player(arena as unknown as World, colorFor(session.user.id));
  const input = new Input(canvas, hudRoot);
  const hud = new Hud(hudRoot, session.user.name, input.touch, () => input.triggerAction());
  life.onStop(() => input.dispose());
  life.onStop(onBinds(() => hud.refreshHint()));
  const net = new Net(`${session.wsUrl}&battle=1`, remotes);
  life.onStop(() => net.close());
  net.onStatus = (s) => hud.setStatus(s);
  net.onNotice = (text) => hud.toast(text);
  hud.setStatus(net.status);
  const chat = new Chat(hudRoot, { send: (text) => net.send({ t: "chat", text }), open: () => {}, local: () => false }, input.touch);
  net.onChat = (line) => chat.add(line, line.kind === "say" && line.sid === net.you);
  net.onChatLog = (lines) => chat.setLog(lines);
  if (input.touch) hud.jumpButton(() => input.triggerJump());
  new SettingsPanel(hudRoot, () => switchMode(true));
  const syncFps = () => (settings.showFps ? hud.enableDebug() : hud.disableDebug());
  syncFps();
  life.onStop(onSettings(syncFps));

  // ---- Arayüz ----
  const exit = el("button", "battle-exit", hudRoot, "🏠 Dünyaya dön");
  exit.addEventListener("click", () => switchMode(false));
  const board = el("div", "panel battle-board", hudRoot);
  const banner = el("div", "battle-banner", hudRoot);
  const feed = el("div", "battle-feed", hudRoot);
  const myHp = el("div", "panel battle-hp", hudRoot);
  const crosshair = el("div", "crosshair", hudRoot);
  const picker = el("div", "panel battle-picker", hudRoot);
  el("h2", "", picker, "⚔️ Tank Savaşı — takımını seç");
  const pickBtns = TEAMS.map((t, i) => {
    const b = el("button", "team-btn", picker);
    b.style.background = t.color;
    b.addEventListener("click", () => net.send({ t: "team", team: i as Team }));
    return b;
  });
  el("p", "battle-help", picker, input.touch
    ? "Joystick: sür · sağ yarı: nişan · ⤒: ateş · 3 isabette tank yanar, 5 sn sonra üste doğarsın."
    : "W/S/A/D: sür · fare: nişan · sol tık/Space: ateş · Esc: imleci bırak · 3 isabette tank yanar, 5 sn sonra üste doğarsın.");
  const switchBtn = el("button", "battle-switch", hudRoot, "Takım değiştir");
  switchBtn.addEventListener("click", () => picker.classList.toggle("show"));

  let state: BattleState = { phase: "wait", endsAt: 0, score: [0, 0], fighters: [] };
  const foes = new Map<number, Foe>();
  const myView = new TankView();
  scene.add(myView.group);
  const nameOf = (sid: number) => (sid === net.you ? session.user.name : remotes.map.get(sid)?.info.name ?? "?");
  const fighter = (sid: number): Fighter | undefined => state.fighters.find((f) => f.sid === sid);
  const teamColor = (sid: number) => {
    const t = fighter(sid)?.team ?? -1;
    return t >= 0 ? TEAMS[t as Team].color : "#ccc";
  };

  const renderUi = () => {
    const mine = fighter(net.you);
    const counts = [0, 1].map((t) => state.fighters.filter((f) => f.team === t).length);
    pickBtns.forEach((b, i) => {
      const full = counts[i] + (mine?.team === i ? 0 : 1) - counts[1 - i] + (mine?.team === 1 - i ? 1 : 0) > 1;
      b.textContent = `${TEAMS[i].name} (${counts[i]})${mine?.team === i ? " ✓" : ""}`;
      b.disabled = full || mine?.team === i;
    });
    if (!mine || mine.team < 0) picker.classList.add("show");
    switchBtn.classList.toggle("show", !!mine && mine.team >= 0);
    myHp.classList.toggle("show", !!mine && mine.team >= 0);
    if (mine && mine.team >= 0) myHp.textContent = mine.alive ? `${"❤️".repeat(mine.hp)}${"🖤".repeat(Math.max(0, TANK_HP - mine.hp))}` : "💥 Vuruldun — birazdan doğacaksın";
  };

  net.onBattle = (s) => {
    const was = state.phase;
    state = s;
    if (s.phase === "play" && was !== "play") hud.toast("⚔️ Maç başladı!");
    // Takımı olan uzak oyunculara tank; ayrılanlarınkini kaldır
    for (const f of s.fighters) {
      if (f.sid === net.you || f.team < 0) continue;
      let foe = foes.get(f.sid);
      if (!foe) {
        foe = { view: new TankView(), aim: { h: 0, tr: 0, el: DEFAULT_ELEV }, label: el("div", "tank-label", hudRoot), prev: { x: 0, z: 0 } };
        scene.add(foe.view.group);
        foes.set(f.sid, foe);
      }
      foe.view.setTint(TINTS[f.team as Team]);
      foe.view.dead = !f.alive;
    }
    for (const [sid, foe] of foes) {
      if (s.fighters.some((f) => f.sid === sid && f.team >= 0)) continue;
      scene.remove(foe.view.group);
      foe.label.remove();
      foes.delete(sid);
    }
    const mine = fighter(net.you);
    if (mine && mine.team >= 0) {
      myView.setTint(TINTS[mine.team as Team]);
      myView.dead = !mine.alive;
      if (!mine.alive && me.driving) me.driving.v = 0; // enkaz yuvarlanmasın
    }
    myView.shown = !!mine && mine.team >= 0;
    renderUi();
  };
  net.onSpawn = (sid, x, z, h) => {
    if (sid === net.you) {
      me.enterTank(x, z, h, h);
      input.setPointerLock(true);
      picker.classList.remove("show");
    } else {
      remotes.map.get(sid)?.teleport(x, z, h);
      const foe = foes.get(sid);
      if (foe) foe.aim = { h, tr: h, el: DEFAULT_ELEV };
    }
  };
  net.onBaim = (sid, h, tr, elv) => {
    const foe = foes.get(sid);
    if (foe) foe.aim = { h, tr, el: elv };
  };
  net.onShell = (sid, shot) => {
    const time = performance.now() / 1000;
    shells.fire(shot, time, camera.position);
    (sid === net.you ? myView : foes.get(sid)?.view)?.recoil(time);
    const foe = foes.get(sid);
    if (foe) foe.aim = { ...foe.aim, tr: Math.atan2(shot.dx, shot.dz), el: Math.atan2(shot.vy, shot.vh) };
  };
  net.onKill = (killer, victim) => {
    const line = el("div", "feed-line", feed);
    const k = el("span", "", line, nameOf(killer));
    k.style.color = teamColor(killer);
    line.append(" 💥 ");
    const v = el("span", "", line, nameOf(victim));
    v.style.color = teamColor(victim);
    while (feed.children.length > 5) feed.firstChild!.remove();
    window.setTimeout(() => line.remove(), 8000);
    if (victim === net.you) hud.toast(`💥 ${nameOf(killer)} seni vurdu!`);
    else if (killer === net.you) hud.toast(`🎯 ${nameOf(victim)} vuruldu!`);
  };

  // ---- Döngü ----
  const aimPoint = new THREE.Vector3();
  const labelPos = new THREE.Vector3();
  let lastAim = { h: NaN, tr: NaN, el: NaN, at: 0 };
  let lastFire = -Infinity;
  let myPrev = { x: 0, z: 0 };
  let last = performance.now();

  const frame = (now: number) => {
    if (!limiter.ready(now, settings.fpsCap)) return;
    const dt = Math.min(now - last, 100) / 1000;
    const dtMs = now - last;
    last = now;
    const t0 = performance.now();
    const time = now / 1000;
    arena.update(time);
    input.poll();
    const mine = fighter(net.you);
    const alive = !!mine?.alive && !!me.driving;
    // Enkazdayken yalnızca kamera döner
    if (!alive) input.moveX = input.moveY = 0;
    const others: number[] = [];
    for (const [sid, foe] of foes) {
      const f = fighter(sid);
      if (f && foe.view.shown) others.push(foe.view.x, foe.view.z);
    }
    me.otherTanks = others;
    if (me.driving) me.update(dt, input);
    if (!alive) me.wantsFire = false;

    if (me.driving && alive) {
      const d = me.driving;
      const changed = Math.abs(d.h - lastAim.h) + Math.abs(d.tr - lastAim.tr) + Math.abs(d.el - lastAim.el) > 0.01;
      if ((changed && now - lastAim.at > 66) || now - lastAim.at > 500) {
        lastAim = { h: d.h, tr: d.tr, el: d.el, at: now };
        net.send({ t: "taim", h: d.h, tr: d.tr, el: d.el });
      }
      if (me.wantsFire) {
        me.wantsFire = false;
        if (now - lastFire >= FIRE_COOLDOWN_MS && state.phase !== "count" && state.phase !== "end") {
          lastFire = now;
          net.send({ t: "fire", h: d.h, tr: d.tr, el: d.el });
        }
      }
    }
    net.update(dt, me);
    const serverNow = net.serverNow();
    remotes.update(serverNow - INTERP_DELAY_MS, dt);

    // Tanklar ve isim/can etiketleri
    if (me.driving) myView.set(me.x, me.z, me.driving.h, me.driving.tr, me.driving.el);
    const myMoving = Math.min(1, Math.hypot(myView.x - myPrev.x, myView.z - myPrev.z) / Math.max(dt, 1e-3) / 3);
    myPrev = { x: myView.x, z: myView.z };
    myView.update(time, myMoving);
    for (const [sid, foe] of foes) {
      const r = remotes.map.get(sid);
      foe.view.shown = !!r?.hasData;
      if (r?.hasData) foe.view.set(r.x, r.z, foe.aim.h, foe.aim.tr, foe.aim.el, 1 - Math.exp(-dt * 10));
      const moving = Math.min(1, Math.hypot(foe.view.x - foe.prev.x, foe.view.z - foe.prev.z) / Math.max(dt, 1e-3) / 3);
      foe.prev = { x: foe.view.x, z: foe.view.z };
      foe.view.update(time, moving);
    }

    if (me.driving) me.updateCamera(camera, dt);
    else {
      // Takım seçilene kadar arenanın üstünden bakış
      camera.position.set(Math.sin(time * 0.05) * 70, 48, Math.cos(time * 0.05) * 70);
      camera.lookAt(0, 0, 0);
    }
    shells.update(time, camera.position);

    for (const [sid, foe] of foes) {
      const f = fighter(sid);
      labelPos.set(foe.view.x, 3.2, foe.view.z).project(camera);
      const show = foe.view.shown && !!f && labelPos.z < 1 && Math.hypot(foe.view.x - camera.position.x, foe.view.z - camera.position.z) < 90;
      foe.label.classList.toggle("show", show);
      if (!show || !f) continue;
      foe.label.style.transform = `translate(${((labelPos.x + 1) / 2) * innerWidth}px, ${((1 - labelPos.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
      const text = `${nameOf(sid)} ${f.alive ? "▮".repeat(f.hp) + "▯".repeat(Math.max(0, TANK_HP - f.hp)) : "💥"}`;
      if (foe.label.textContent !== text) foe.label.textContent = text;
      foe.label.style.color = TEAMS[f.team as Team].color;
    }

    if (me.driving && alive) {
      me.aimAt = aimRay(camera, aimPoint);
      crosshair.classList.add("show");
      crosshair.classList.toggle("reloading", now - lastFire < FIRE_COOLDOWN_MS || !me.aimReady);
    } else {
      me.aimAt = null;
      crosshair.classList.remove("show");
    }

    // Skor, süre, evre mesajı
    const left = state.endsAt ? mmss(state.endsAt - serverNow) : "";
    const boardText = `${TEAMS[0].name} ${state.score[0]} — ${state.score[1]} ${TEAMS[1].name}${state.phase === "play" ? ` · ${left}` : ""}`;
    if (board.textContent !== boardText) board.textContent = boardText;
    let msg = "";
    if (state.phase === "wait") msg = "Rakip bekleniyor: her takımda en az 1 kişi olmalı (beklerken atış serbest)";
    else if (state.phase === "count") msg = `Maç ${left.replace(/^0:0?/, "")} sn sonra başlıyor`;
    else if (state.phase === "end") {
      const [r, b] = state.score;
      const best = [...state.fighters].filter((f) => f.team >= 0).sort((a, c) => c.kills - a.kills)[0];
      msg = `${r === b ? "Berabere!" : `${TEAMS[r > b ? 0 : 1].name} kazandı!`} ${r}–${b}${best?.kills ? ` · En iyi: ${nameOf(best.sid)} (${best.kills})` : ""}`;
    }
    if (banner.textContent !== msg) banner.textContent = msg;
    banner.classList.toggle("show", !!msg);

    if (remotes.consumeChanged()) hud.renderPlayers(remotes);
    renderer.render(scene, camera);
    perf.frame(dtMs, performance.now() - t0);
    hud.updateDebug(now, perf.stats, net.rtt, remotes.map.size + 1);
  };
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
