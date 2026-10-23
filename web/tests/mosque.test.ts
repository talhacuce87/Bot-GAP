import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../shared/protocol";
import { IMAM_SPOT, inHarim, KAMET_MS, mosqueLocal, mosqueWorld, postureAt, prayerLength, QIBLA_ROT, SADIRVAN, safSlot } from "../shared/mosque";
import { currentVakit, dayTimes, nextVakit, REKAT } from "../shared/prayer";
import { outsideWorld } from "../shared/constants";
import { terrainHeight, walkable } from "../client/src/world/terrain";
import type { SessionUser } from "../server/src/auth";
import { Mosque } from "../server/src/games/mosque";
import { type Conn, Room } from "../server/src/room";

const member = (id: string): SessionUser => ({ id, name: id, avatar: null, guest: false });

class FakeConn implements Conn {
  bufferedAmount = 0;
  text: ServerEvent[] = [];
  send(data: string | Uint8Array): void {
    if (typeof data === "string") this.text.push(JSON.parse(data));
  }
  notices(): string[] {
    return this.text.filter((e) => e.t === "notice").map((e) => (e as { text: string }).text);
  }
}

/** İstanbul saatiyle (UTC+3) o günün o saati. */
const at = (hhmm: string, day = "2026-10-23") => Date.parse(`${day}T${hhmm}:00+03:00`);

describe("namaz vakitleri", () => {
  it("İstanbul vakitleri Diyanet'e yakın ve sıralı", () => {
    const t = dayTimes(at("12:00", "2026-12-21"));
    const hm = (ms: number) => new Date(ms + 3 * 3600_000).toISOString().slice(11, 16);
    // Diyanet İstanbul 21 Aralık: 06:47 08:20 13:08 15:27 17:46 19:14 (±3 dk)
    const want = ["06:47", "08:20", "13:08", "15:27", "17:46", "19:14"];
    const got = [t.imsak, t.gunes, t.ogle, t.ikindi, t.aksam, t.yatsi];
    got.forEach((v, i) => {
      const diff = Math.abs(Date.parse(`2026-12-21T${want[i]}:00+03:00`) - v) / 60000;
      expect(diff, `${want[i]} ↔ ${hm(v)}`).toBeLessThan(4);
    });
  });

  it("vakit pencereleri: kerahatte vakit yok, gece yarısı yatsı, sıradaki ezan", () => {
    expect(currentVakit(at("10:00"))).toBeNull();
    expect(currentVakit(at("14:00"))?.key).toBe("ogle");
    expect(currentVakit(at("17:00"))?.key).toBe("ikindi");
    const night = currentVakit(at("02:00", "2026-10-24"));
    expect(night?.key).toBe("yatsi");
    expect(night?.id).toBe("2026-10-23:yatsi");
    expect(nextVakit(at("10:00")).key).toBe("ogle");
  });
});

describe("cami yerleşimi ve namaz akışı", () => {
  it("cami yürünür alanda, kıbleye dönük; yerel ↔ dünya tutarlı", () => {
    for (const p of [mosqueWorld(0, 0), mosqueWorld(IMAM_SPOT.x, IMAM_SPOT.z), mosqueWorld(SADIRVAN.x, SADIRVAN.z + 4), mosqueWorld(0, -60), mosqueWorld(14, 14), mosqueWorld(-17, -50)]) {
      expect(outsideWorld(p.x, p.z)).toBe(0);
      // Arazi düz ve yürünür (dağ ya da tepe külliyenin içine girmez)
      expect(terrainHeight(p.x, p.z)).toBe(0);
      expect(walkable(p.x, p.z)).toBe(true);
    }
    const l = mosqueLocal(mosqueWorld(3, -7).x, mosqueWorld(3, -7).z);
    expect(l.x).toBeCloseTo(3);
    expect(l.z).toBeCloseTo(-7);
    // İmam mihraba (kıbleye) bakar: kıble yönü güneydoğu (151.6°)
    expect(Math.sin(QIBLA_ROT)).toBeGreaterThan(0.4);
    expect(Math.cos(QIBLA_ROT)).toBeGreaterThan(0.8);
    // Saflar harimin içinde, imamın arkasında
    for (let i = 0; i < 120; i++) {
      const s = safSlot(i), w = mosqueWorld(s.x, s.z);
      expect(inHarim(w.x, w.z)).toBe(true);
      expect(s.z).toBeLessThan(IMAM_SPOT.z);
    }
  });

  it("rekâtlar ve duruşlar sırayla; selamla biter", () => {
    expect(REKAT.sabah).toBe(2);
    expect(REKAT.aksam).toBe(3);
    const len = prayerLength(4);
    expect(postureAt(4, 0.5)?.step.posture).toBe("tekbir");
    expect(postureAt(4, len - 0.5)?.step.posture).toBe("selamL");
    expect(postureAt(4, len + 1)).toBeNull();
    // 4 rekâtta 8 secde
    let secde = 0, prev = "";
    for (let t = 0; t < len; t += 0.25) {
      const p = postureAt(4, t)!.step;
      if (p.posture === "secde" && `${p.at}` !== prev) {
        secde++;
        prev = `${p.at}`;
      }
    }
    expect(secde).toBe(8);
  });
});

function setup(now: number) {
  const room = new Room("g:cami");
  const reports: [number, string][] = [];
  let clock = now;
  const mosque = new Mosque(room, (sid, e) => reports.push([sid, e]), () => clock);
  const ca = new FakeConn(), cb = new FakeConn();
  const sa = room.join(member("a"), ca, 0);
  const sb = room.join(member("b"), cb, 0);
  const put = (sid: number, lx: number, lz: number) => {
    const w = mosqueWorld(lx, lz);
    room.teleport(sid, w.x, w.z, 0, 0);
  };
  return { room, mosque, reports, sa, sb, ca, cb, put, tick: (ms: number) => ((clock += ms), mosque.tick(clock)), now: () => clock };
}

describe("cami: sunucu", () => {
  it("abdestsiz ve vakitsiz kılınmaz; bir vakit bir kez kılınır", () => {
    const { mosque, sa, ca, put, reports, tick, now } = setup(at("14:00"));
    put(sa, 0, 0);
    mosque.munferit(sa, now());
    expect(mosque.praying(sa)).toBe(false);
    expect(ca.notices().at(-1)).toMatch(/abdest/);
    // Şadırvandan uzakta abdest alınmaz
    mosque.abdestAl(sa, now());
    expect(mosque.hasAbdest(sa, now())).toBe(false);
    put(sa, SADIRVAN.x + 3.4, SADIRVAN.z);
    mosque.abdestAl(sa, now());
    expect(mosque.hasAbdest(sa, now())).toBe(true);
    put(sa, 0, 0);
    mosque.munferit(sa, now());
    expect(mosque.praying(sa)).toBe(true);
    tick(2000 + prayerLength(4) * 1000 + 100);
    expect(mosque.praying(sa)).toBe(false);
    expect(reports).toEqual([[sa, "namaz"]]);
    // Aynı vakit tekrar kılınmaz
    mosque.munferit(sa, now());
    expect(mosque.praying(sa)).toBe(false);
    expect(ca.notices().at(-1)).toMatch(/bu vakit kıldın/);
  });

  it("kerahat vaktinde kılınmaz", () => {
    const { mosque, sa, ca, put, now } = setup(at("10:00"));
    put(sa, SADIRVAN.x + 3.4, SADIRVAN.z);
    mosque.abdestAl(sa, now());
    put(sa, 0, 0);
    mosque.munferit(sa, now());
    expect(mosque.praying(sa)).toBe(false);
    expect(ca.notices().at(-1)).toMatch(/vakit yok/);
  });

  it("imam kamet açar, cemaat saf tutar; birlikte biter, bozan görev almaz", () => {
    const { mosque, room, sa, sb, put, reports, tick, now } = setup(at("17:00"));
    const sc = room.join(member("c"), new FakeConn(), 0);
    for (const sid of [sa, sb, sc]) {
      put(sid, SADIRVAN.x + 3.4, SADIRVAN.z);
      mosque.abdestAl(sid, now());
    }
    put(sa, IMAM_SPOT.x, IMAM_SPOT.z);
    mosque.imam(sa, now());
    expect(mosque.praying(sa)).toBe(true);
    put(sb, 2, 0);
    mosque.join(sb, now());
    put(sc, -2, 0);
    mosque.join(sc, now());
    // Saf yerine geçirildi
    const pb = room.players.get(sb)!.state, slot = mosqueWorld(safSlot(0).x, safSlot(0).z);
    expect(Math.hypot(pb.x - slot.x, pb.z - slot.z)).toBeLessThan(0.01);
    expect(room.players.get(sb)!.state.rot).toBeCloseTo(QIBLA_ROT);
    tick(KAMET_MS + 10_000);
    mosque.leave(sc); // c namazı bozar
    // Kamet bitince yeni gelen katılamaz
    tick(prayerLength(4) * 1000);
    expect(reports.sort()).toEqual([[sa, "namaz"], [sb, "namaz"]].sort());
  });
});
