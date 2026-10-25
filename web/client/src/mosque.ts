// GAP Camii (istemci): şadırvanda abdest, harimde imam ol / cemaate katıl / tek başına kıl, namazı boz (G).
// Sunucunun namaz oturumlarından herkesin duruşu aynı akışla (shared/mosque.ts) çizilir; namazdayken karakter
// yürümez. Vakit girince herkese bildirim, camiye yakınsan minarelerden ezan.
import { ABDEST_MS, atSadirvan, IMAM_SPOT, inHarim, mosqueWorld, type Posture, POSTURE_NAMES, postureAt, prayerPlan } from "../../shared/mosque";
import type { NamazSession } from "../../shared/protocol";
import { clock, currentVakit, dayTimes, nextVakit, VAKIT_NAMES, type VakitKey } from "../../shared/prayer";
import type { AvatarView } from "./avatars/avatars";
import type { Remotes } from "./avatars/remotes";
import type { FeatureAct } from "./features";
import type { Input } from "./input/input";
import type { Net } from "./net";
import type { Player } from "./player";
import { region } from "./ui/layout";
import { sfx } from "./ui/sfx";

/** Ezanın duyulduğu uzaklık (m, en yakın minareye). */
const EZAN_RANGE = 260;
/** Ezan kaydı (varsa): web/client/public/audio/ezan.mp3. Yoksa yumuşak bir çan çalar. */
const EZAN_URL = "/audio/ezan.mp3";

export interface MosqueContext {
  net: Net;
  me: Player;
  remotes: Remotes;
  input: Input;
  hudRoot: HTMLElement;
  minarets: { x: number; z: number }[];
  toast(text: string): void;
}

export class MosqueClient {
  private sessions: NamazSession[] = [];
  /** Abdestin (yerelde tahmini) bitişi; sunucu asıl kararı verir. */
  private abdestUntil = 0;
  /** Abdest animasyonu sürerken yürünmez. */
  private abdestEnd = 0;
  private blocked = false;
  private banner: HTMLDivElement;
  private lastCheck = Date.now();
  private ezan: HTMLAudioElement | null = null;
  private ezanMissing = false;
  /** Debug (?debug&namaz=ruku): karakter bu duruşta sabit kalır. */
  private debugT: number | null = null;

  constructor(private c: MosqueContext) {
    this.banner = document.createElement("div");
    this.banner.className = "namaz-banner";
    region(c.hudRoot, "tc").append(this.banner);
  }

  /** Debug: kendi karakterini bir duruşun ortasında sabitler (görünüm denemesi). */
  debugPose(posture: string): void {
    const step = prayerPlan(4).find((s) => s.posture === (posture as Posture));
    this.debugT = step ? step.at + step.dur / 2 : null;
  }

  onSessions(s: NamazSession[]): void {
    this.sessions = s;
  }

  private mine(): NamazSession | undefined {
    return this.sessions.find((s) => s.members.includes(this.c.net.you));
  }

  /** Namazda (kamet dahil) ya da abdest alırken: dünya etkileşimleri kapalı. */
  busy(): boolean {
    return !!this.mine() || performance.now() < this.abdestEnd;
  }

  acts(): FeatureAct[] {
    const { me, net } = this.c;
    const now = net.serverNow();
    if (this.mine()) return [{ key: "g", label: "Namazı boz", act: "nleave" }];
    if (performance.now() < this.abdestEnd) return [];
    if (atSadirvan(me.x, me.z)) {
      return Date.now() < this.abdestUntil ? [] : [{ key: "f", label: "Abdest al 💧", act: "abdest" }];
    }
    if (!inHarim(me.x, me.z, 0.4)) return [];
    const vakit = currentVakit(now);
    if (!vakit) {
      const n = nextVakit(now);
      return [{ key: "f", label: `🕌 Vakit yok · ${VAKIT_NAMES[n.key]} ${clock(n.at)}`, act: "namaz-info" }];
    }
    const kamet = this.sessions.find((s) => s.imam && now < s.startAt);
    if (kamet) return [{ key: "f", label: `Cemaate katıl, saf tut 🤲 (${VAKIT_NAMES[kamet.vakitKey]})`, act: "saf" }];
    const imamAt = mosqueWorld(IMAM_SPOT.x, IMAM_SPOT.z);
    const atMihrab = Math.hypot(me.x - imamAt.x, me.z - imamAt.z) < 2;
    const cemaat = this.sessions.some((s) => s.imam);
    const solo: FeatureAct = { key: atMihrab && !cemaat ? "g" : "f", label: `${VAKIT_NAMES[vakit.key]} namazını tek başına kıl 🤲`, act: "munferit" };
    return atMihrab && !cemaat ? [{ key: "f", label: `İmam ol, ${VAKIT_NAMES[vakit.key]} namazını cemaatle kıl 🕌`, act: "imam" }, solo] : [solo];
  }

  handleAct(act: string): boolean {
    const { net, me } = this.c;
    switch (act) {
      case "abdest":
        net.send({ t: "abdest" });
        (me as AvatarView).abdestAt = performance.now() / 1000;
        this.abdestEnd = performance.now() + 4500;
        this.abdestUntil = Date.now() + ABDEST_MS;
        sfx.splash(0.6);
        return true;
      case "imam":
      case "munferit":
      case "saf":
        net.send({ t: act });
        return true;
      case "nleave":
        net.send({ t: "nleave" });
        return true;
      case "namaz-info": {
        const n = nextVakit(net.serverNow());
        this.c.toast(`🕌 Güneş doğduktan öğleye kadar namaz vakti yok. ${VAKIT_NAMES[n.key]} ezanı ${clock(n.at)}.`);
        return true;
      }
      default:
        return false;
    }
  }

  /** Kare başı: duruşlar, yürüme kilidi, gösterge, ezan. `time` döngü saati (sn). */
  update(time: number): void {
    const { me, remotes, net, input } = this.c;
    const now = net.serverNow();
    const views = new Map<number, AvatarView>();
    for (const s of this.sessions) {
      for (const sid of s.members) {
        const v: AvatarView | undefined = sid === net.you ? me : remotes.map.get(sid);
        if (!v) continue;
        v.namaz = { start: time - (now - s.startAt) / 1000, rekat: s.rekat };
        views.set(sid, v);
      }
    }
    if (this.debugT !== null) {
      (me as AvatarView).namaz = { start: time - this.debugT, rekat: 4 };
      (me as AvatarView).poseYaw = Number(new URLSearchParams(location.search).get("pozaci") ?? Math.PI / 2); // yandan görünsün
    }
    else if (!views.has(net.you)) (me as AvatarView).namaz = null;
    for (const r of remotes.map.values()) {
      const v: AvatarView = r;
      if (!views.has(r.info.sid)) v.namaz = null;
    }

    const busy = this.busy();
    if (busy !== this.blocked) {
      this.blocked = busy;
      input.setBlocked(busy);
    }
    this.updateBanner(now);
    this.checkEzan();
  }

  private updateBanner(now: number): void {
    const s = this.mine();
    let text = "";
    if (s) {
      const name = VAKIT_NAMES[s.vakitKey];
      if (now < s.startAt) {
        text = s.imam === this.c.net.you
          ? `🕌 Kamet: ${Math.ceil((s.startAt - now) / 1000)} sn · cemaat saf tutuyor (${s.members.length - 1} kişi)`
          : `🕌 ${name} namazı birazdan başlıyor (${Math.ceil((s.startAt - now) / 1000)} sn)`;
      } else {
        const at = postureAt(s.rekat, (now - s.startAt) / 1000);
        if (at) text = `🕌 ${name} · ${at.step.rekat}/${s.rekat}. rekât · ${POSTURE_NAMES[at.step.posture]}${s.members.length > 1 ? ` · ${s.members.length} kişi` : ""}`;
      }
    }
    this.banner.textContent = text;
    this.banner.classList.toggle("show", !!text);
  }

  /** Vakit girdiyse: herkese bildirim, camiye yakınsan ezan sesi. */
  private checkEzan(): void {
    const now = Date.now();
    if (now - this.lastCheck < 1000) return;
    const t = dayTimes(now);
    const starts: [VakitKey, number][] = [["sabah", t.imsak], ["ogle", t.ogle], ["ikindi", t.ikindi], ["aksam", t.aksam], ["yatsi", t.yatsi]];
    for (const [key, at] of starts) if (this.lastCheck < at && at <= now) this.callEzan(key);
    this.lastCheck = now;
  }

  private callEzan(key: VakitKey): void {
    const { me, minarets } = this.c;
    this.c.toast(`🕌 ${VAKIT_NAMES[key]} ezanı okunuyor · GAP Camii'nde namaz vakti`);
    const d = Math.min(...minarets.map((m) => Math.hypot(me.x - m.x, me.z - m.z)));
    if (d > EZAN_RANGE) return;
    const volume = Math.max(0.08, 1 - d / EZAN_RANGE);
    if (!this.ezanMissing) {
      this.ezan ??= new Audio(EZAN_URL);
      this.ezan.volume = volume;
      this.ezan.currentTime = 0;
      this.ezan.play().catch(() => {
        // Kayıt yok ya da tarayıcı izin vermedi: çan çal
        this.ezanMissing = true;
        sfx.chime(volume);
      });
    } else sfx.chime(volume);
  }

  dispose(): void {
    if (this.blocked) this.c.input.setBlocked(false);
    this.banner.remove();
    this.ezan?.pause();
  }
}
