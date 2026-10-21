import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { type Look, type ServerEvent } from "../shared/protocol";
import { setLimbs, type LimbPose } from "../client/src/avatars/chibi";
import { type ChibiManifest, ChibiPack, DEFAULT_LOOK, LIMB_COUNT, lookKey, randomLook } from "../client/src/avatars/chibiPack";
import { type BotPost, fetchLook, fetchWardrobe, sanitizeLook, saveLook } from "../server/src/looks";
import { type Conn, Room } from "../server/src/room";

const dir = new URL("../client/chibi/", import.meta.url);
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("chibi.json", dir)), "utf8")) as ChibiManifest;
const raw = readFileSync(fileURLToPath(new URL("chibi.bin", dir)));
const pack = new ChibiPack(manifest, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

describe("chibi paketi", () => {
  it("kıyafeti bot çizicisiyle aynı kurallarla birleştirir", () => {
    expect(pack.compose({})).toEqual(["base", "base_top", "base_bottom"]);
    const dress = pack.compose({ tops: "top_gelinlik", bottoms: "bottom_kot" });
    expect(dress).toContain("top_gelinlik");
    expect(dress).not.toContain("bottom_kot");
    expect(dress).not.toContain("base_bottom");
    expect(pack.compose({ hair: "hat_fes" })).not.toContain("hat_fes"); // yanlış slot
    expect(pack.compose(null)).toContain(DEFAULT_LOOK.hair);
  });

  it("geçerli bir geometri kurar", () => {
    const geo = pack.build(DEFAULT_LOOK);
    const n = geo.attributes.position.count;
    const idx = geo.index!.array;
    expect(n).toBeGreaterThan(1000);
    expect(idx.length % 3).toBe(0);
    expect(Math.max(...idx)).toBeLessThan(n);
    const limb = geo.attributes.aLimb.array;
    expect(Math.min(...limb)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...limb)).toBeLessThan(LIMB_COUNT);
    const col = geo.attributes.color.array;
    expect(Math.min(...col)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...col)).toBeLessThanOrEqual(1);
    geo.computeBoundingBox();
    expect(geo.boundingBox!.max.y).toBeGreaterThan(1.8); // ~2.2 m chibi
  });

  it("kollar ve bacaklar doğru tarafta, omuzlar kalçadan yukarıda", () => {
    const p = pack.pivots;
    const at = (l: number) => ({ x: p[l * 3], y: p[l * 3 + 1] });
    // Paketteki "_L" bakanın solu: 2 ve 4 −X, 3 ve 5 +X (setLimbs açıları buna göre)
    expect(at(2).x).toBeLessThan(0);
    expect(at(3).x).toBeGreaterThan(0);
    expect(at(4).x).toBeLessThan(0);
    expect(at(5).x).toBeGreaterThan(0);
    expect(at(2).y).toBeGreaterThan(at(4).y);
  });

  it("şapka takınca saç her şapkanın kendi iç yüzeyine bastırılır", () => {
    const [hx, hy, hz] = manifest.headCenter;
    const hats = Object.keys(manifest.parts).filter((id) => manifest.parts[id].cat === "hats");
    expect(hats.length).toBeGreaterThan(0);
    // Saç köşelerinin birleşik geometrideki aralığı: compose sırasına göre
    const hairRange = (look: Look) => {
      let start = 0;
      for (const id of pack.compose(look)) {
        if (manifest.parts[id].cat === "hair") return [start, start + manifest.parts[id].vCount];
        start += manifest.parts[id].vCount;
      }
      throw new Error("saç yok");
    };
    // Şapkanın saç katmanının kapladığı yönde, iç yüzeyin dışında kalan saç köşesi sayısı
    const outside = (look: Look, hat: string) => {
      const cap = pack.hatCap(hat)!;
      const pos = pack.build({ tops: null, ...look }).attributes.position.array;
      const [a, b] = hairRange(look);
      let n = 0;
      for (let v = a; v < b; v++) {
        const dx = pos[v * 3] - hx, dy = pos[v * 3 + 1] - hy, dz = pos[v * 3 + 2] - hz;
        const r = Math.hypot(dx, dy, dz);
        const rh = cap(dx, dy, dz, r)[2];
        if (rh && r > rh + 1e-4) n++;
      }
      return n;
    };
    const hair = { hair: "hair_uzun_dalgali" } satisfies Look;
    expect(pack.hatCap("hat_bere")).not.toBeNull();
    // Şapkasız saç berenin dışına taşar; her şapkayla tamamen içeride kalır
    expect(outside(hair, "hat_bere")).toBeGreaterThan(100);
    for (const hat of hats) expect(outside({ ...hair, hats: hat }, hat), hat).toBe(0);
  });

  it("şapkalıyken hiçbir saç üçgeni şapkanın dış yüzeyinden taşmaz", () => {
    const [hx, hy, hz] = manifest.headCenter;
    const of = (cat: string) => Object.keys(manifest.parts).filter((id) => manifest.parts[id].cat === cat && !id.startsWith("base"));
    let bad = 0;
    for (const hat of of("hats")) {
      const cap = pack.hatCap(hat)!;
      for (const hair of of("hair")) {
        const look = { hair, hats: hat, tops: null } satisfies Look;
        let istart = 0;
        for (const id of pack.compose(look)) { if (id === hair) break; istart += manifest.parts[id].iCount; }
        const geo = pack.build(look);
        const pos = geo.attributes.position.array, idx = geo.index!.array;
        for (let t = istart; t < istart + manifest.parts[hair].iCount; t += 3) {
          const p = [0, 1, 2].map((k) => (pos[idx[t] * 3 + k] + pos[idx[t + 1] * 3 + k] + pos[idx[t + 2] * 3 + k]) / 3);
          const d = [p[0] - hx, p[1] - hy, p[2] - hz], r = Math.hypot(d[0], d[1], d[2]);
          const [ri, ro] = cap(d[0], d[1], d[2], r);
          if (ri && r > ro + 0.002) bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("saç rengi değişince saç köşelerinin rengi değişir, ten değişmez", () => {
    const a = pack.build({ hair: "hair_kisa_doku" }).attributes.color.array;
    const b = pack.build({ hair: "hair_kisa_doku", colors: { hair: "#ff00aa" } }).attributes.color.array;
    let changed = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
    expect(changed).toBeGreaterThan(100);
    // Temel karakterin ilk köşeleri (gövde teni) aynı kalır
    expect(Array.from(a.slice(0, 30))).toEqual(Array.from(b.slice(0, 30)));
  });

  it("kıyafet anahtarı ve rastgele kıyafet", () => {
    expect(lookKey(null)).toBe(lookKey(DEFAULT_LOOK));
    expect(lookKey({ hair: "hair_rasta" })).not.toBe(lookKey({ hair: "hair_kirpi" }));
    const r = randomLook(manifest, 7);
    expect(randomLook(manifest, 7)).toEqual(r);
    for (const [slot, id] of Object.entries(r)) {
      if (slot === "colors" || !id) continue;
      expect(manifest.parts[id as string].cat).toBe(slot);
    }
  });
});

describe("uzuv pozları", () => {
  const pose = (p: Partial<LimbPose>): THREE.Vector2[] => {
    const a = Array.from({ length: LIMB_COUNT }, () => new THREE.Vector2());
    setLimbs(a, { swing: 0, seated: false, wave: 0, dance: 0, time: 0, ...p });
    return a;
  };
  // Shader'daki limbMat ile aynı: rz * rx
  const rotate = (a: THREE.Vector2, v: THREE.Vector3) =>
    v.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), a.x).applyAxisAngle(new THREE.Vector3(0, 0, 1), a.y);

  it("otururken bacaklar öne kırılır", () => {
    const a = pose({ seated: true });
    const foot = rotate(a[4], new THREE.Vector3(0, -1, 0));
    expect(foot.z).toBeGreaterThan(0.9);
  });

  it("el sallarken bir kol yukarı kalkar", () => {
    const a = pose({ wave: 1 });
    const hand = rotate(a[3], new THREE.Vector3(0.7, -0.7, 0)); // 3: +X'teki kol, aşağı-dışa
    expect(hand.y).toBeGreaterThan(0.5);
    const other = rotate(a[2], new THREE.Vector3(-0.7, -0.7, 0));
    expect(other.y).toBeLessThan(0);
  });

  it("dansta iki kol da yukarıda", () => {
    const a = pose({ dance: 1, time: 0 });
    expect(rotate(a[2], new THREE.Vector3(-0.7, -0.7, 0)).y).toBeGreaterThan(0.5);
    expect(rotate(a[3], new THREE.Vector3(0.7, -0.7, 0)).y).toBeGreaterThan(0.5);
  });

  it("yürürken kollar ve bacaklar zıt sallanır", () => {
    const a = pose({ swing: 0.5 });
    expect(Math.sign(a[2].x)).toBe(-Math.sign(a[3].x));
    expect(Math.sign(a[4].x)).toBe(-Math.sign(a[5].x));
    expect(Math.sign(a[3].x)).toBe(Math.sign(a[4].x)); // çapraz kol ve bacak birlikte
  });
});

describe("dünya kıyafet akışı", () => {
  it("istemciden gelen kıyafetin biçimini denetler", () => {
    expect(sanitizeLook({ hair: "hair_rasta", hats: null, colors: { skin: "#AABBCC", hair: "red" } })).toEqual({
      hair: "hair_rasta", tops: null, bottoms: null, shoes: null, hats: null, glasses: null, facial: null, colors: { skin: "#aabbcc" },
    });
    expect(sanitizeLook({ hair: "../../etc" })).toBeNull();
    expect(sanitizeLook({ hair: 5 })).toBeNull();
    expect(sanitizeLook([])).toBeNull();
    expect(sanitizeLook("x")).toBeNull();
  });

  it("botla konuşur; bot yoksa ya da reddederse kibar hata döner", async () => {
    const calls: [string, unknown][] = [];
    const bot: BotPost = async (path, body) => {
      calls.push([path, body]);
      if (path === "/internal/outfits") return { ok: true, body: { outfits: { "5": { hair: "hair_rasta" } } } };
      if (path === "/internal/wardrobe") return { ok: true, body: { outfit: { hair: "hair_rasta" }, level: 3, locked: { top_xp_hoodie: 10 } } };
      return { ok: true, body: { ok: true, outfit: { hair: "hair_kirpi" }, dropped: ["XP Hoodie (seviye 10)"] } };
    };
    expect((await fetchLook(bot, "1", "5"))?.hair).toBe("hair_rasta");
    expect(await fetchLook(bot, "1", "6")).toBeNull();
    expect(await fetchWardrobe(bot, "1", "5")).toMatchObject({ level: 3, locked: { top_xp_hoodie: 10 } });
    expect(await saveLook(bot, "1", "5", { hair: "hair_kirpi" })).toMatchObject({ look: { hair: "hair_kirpi" }, dropped: ["XP Hoodie (seviye 10)"] });
    expect(calls.at(-1)).toEqual(["/internal/outfit", { guild: "1", user: "5", outfit: { hair: "hair_kirpi" } }]);

    const down: BotPost = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await fetchLook(down, "1", "5")).toBeNull();
    expect(await fetchWardrobe(down, "1", "5")).toHaveProperty("error");
    expect(await saveLook(down, "1", "5", {})).toHaveProperty("error");
    const refused: BotPost = async () => ({ ok: true, body: { ok: false, reason: "not_member" } });
    expect(await saveLook(refused, "1", "5", {})).toEqual({ error: expect.stringContaining("üyesi") });
  });

  it("oda kıyafeti herkese duyurur, ayrılan oyuncuyu yok sayar", () => {
    class FakeConn implements Conn {
      bufferedAmount = 0;
      text: ServerEvent[] = [];
      send(data: string | Uint8Array): void {
        if (typeof data === "string") this.text.push(JSON.parse(data));
      }
    }
    const room = new Room("d:test");
    const a = new FakeConn();
    const b = new FakeConn();
    const sa = room.join({ id: "1", name: "a", avatar: null, guest: false }, a);
    room.join({ id: "2", name: "b", avatar: null, guest: false }, b);
    room.setLook(sa, { hair: "hair_rasta" });
    expect(b.text.at(-1)).toEqual({ t: "look", sid: sa, look: { hair: "hair_rasta" } });
    expect(room.players.get(sa)!.info.look).toEqual({ hair: "hair_rasta" });
    room.leave(sa);
    const before = b.text.length;
    room.setLook(sa, { hair: "hair_kirpi" });
    expect(b.text.length).toBe(before);
  });
});
