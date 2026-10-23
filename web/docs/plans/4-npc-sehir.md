# Plan 4: NPC yayalar ve canlı şehir (`feat/npc-sehir`)

**Neden.** Şehir ve köyde oyunculardan başka hareket eden kimse yok. Hedef: kaldırımlarda yürüyen, saate göre yaşayan, oyunculara tepki veren yayalar.

**İşler**

1. **`shared/walkways.ts`**
   - Şehir caddelerinin iki yanındaki kaldırımlar (`STREETS` içindeki `half` ve `walk`), mahallede `HOOD_SIDEWALK`, meydan ve park halkaları.
   - Köy patikaları: şu an `world/scene.ts` `paths()` içinde satır içi tanımlı; bu veriye çıkarılır ve sahne de buradan okur.
   - Bekleme noktaları: bank, vitrin, durak, kahvehane.
2. **`client/src/npcs/pedestrians.ts`**
   - Her yayanın rotası, hızı ve fazı var; konumu `net.serverNow()` saatinin fonksiyonu (yürü, dur, otur, telefon, sohbet).
   - Herkes aynı yayayı aynı yerde görür; ağ trafiği yok.
   - Yoğunluk saate, bölgeye ve `settings.crowd` ayarına göre: sabah simitçi, öğlen kahvehane, gece casino önü.
3. **Yerel tepkiler**
   - Oyuncuya yol verir; yakındaki 👋 emote'una el sallar; korna ya da hızlı arabadan kaçar.
   - Çarpılırsa `{t:"pedhit", id}` gider, sunucu yayar; herkes yayanın savrulup düştüğünü görür, üstünde "Kör müsün!" balonu çıkar.
4. **`avatars/crowd.ts`: örnekli kalabalık**
   - 8–10 sabit kıyafet (`randomLook`) için `ChibiPack.build(look, 1)`; her kıyafet için bir InstancedMesh.
   - Uzuv açıları vertex shader'da örnek niteliklerinden (faz, poz, hız); chibi `LIMB_GLSL`'in örnekli sürümü.
   - Ten ve saç tonu örnek başına; gölge zemin lekesiyle. Hedef ~10 draw call.
   - LOD1 Plan 1'den gelir; o birleşene kadar tam geometriyle çalışın.
5. **Şehri canlandıranlar**
   - Meydanda güvercin sürüleri (koşunca havalanır).
   - Simitçi tezgâhı.
   - Sokak kedileri (`avatars/companions` altyapısıyla).
6. **Sonra (Plan 3 birleşince): GTA tarzı içerik**, öneri sırası:
   1. Dolmuş/taksi görevi.
   2. Düğün konvoyu.
   3. Sokak yarışı.
   4. Zabıta kovalamacası.
   5. Rampalar ve gizli çay bardakları.
   6. Langırt ve dart.
   7. Telefon.
   8. Casino soygunu.

**Testler.**
- Belirlenimlilik: aynı saatte aynı konumlar.
- Yayalar kaldırımda ya da yürünür alanda (`walkable`), asfaltta değil.
- `pedhit` için hız sınırı.
- `?bots=20` ve `?bench` ile kare süresi.

---

## Ortak kurallar (4 katkıcı için aynı)

**Proje.** GAP Dünyası `web/` altında. Komutlar:
- `npm run dev`: istemci :5173, sunucu :3000
- `npm run typecheck`
- `npm test` (vitest)

İkiden fazla tarayıcı sekmesiyle (misafir girişi) test edin.

**İlkeler.**
- Oyun bilgisi dünyada durur: masadaki fiş ve kart, dönen çark, tabela, havada yazı. Ekranda yalnızca ince ipucu şeridi kalır; büyük DOM panelleri yok.
- Oyun koltuklarında kamera first person.
- Sunucu otoriterdir; istemci zaman damgalı olaylardan canlandırır.
- Konum bayrağı baytı dolu (8 bit). Yeni oyuncu durumları JSON olay ve `PlayerInfo` alanıyla taşınır; snapshot formatı değişmez.

**Ortak dosyalar.** Çakışmaları azaltmak için `shared/protocol.ts`, `server/src/room.ts`, `server/src/games/world.ts`, `server/src/index.ts`, `client/src/features.ts`, `client/src/main.ts` ve `client/src/settings.ts` dosyalarına yalnızca ekleme yapın; mevcut satırları yeniden düzenlemeyin. Her katkıcının kendi bölümü olsun (yorum başlığıyla).

**Ayrılmış adlar.** Başkasının adını kullanmayın:

| Katkıcı | Mesaj / alan adları |
|---|---|
| 1 Performans | (protokol yok) |
| 2 Masalar | `csit`, `cleave`, `rl`, `bjt`, `cz`, `czsync`, `slotspin`; `Room.broadcastNear` |
| 3 Arabalar | `pax`, `paxoff`, `cardmg`, `fall`, `horn`, `passive`, `npcbump`; `MSG_TRAFFIC = 5`; `PlayerInfo.pax/dmg/passive` |
| 4 NPC | `pedhit`; `shared/walkways.ts` |

**Paylaşılan sözleşmeler.**
- `Room.broadcastNear(ev: ServerEvent, x: number, z: number, r: number): void`. Sahibi 2. Başkası gerekirse aynı imzayla ekler; birleştirmede tek kopya kalır.
- `ChibiPack.build(look, lod: 0 | 1 = 0)`. Sahibi 1. Katkıcı 4 bu imzayı kullanır; 1 birleşene kadar `lod` yok sayılır.
- `signalPhase(serverMs: number, group: 0 | 1): 0 | 1 | 2` (kırmızı / sarı / yeşil), `shared/traffic.ts` içinde. Sahibi 3.
- `client/src/seatCam.ts`. Sahibi 2. Arayüz: `seatCam.set({ eye, look, yawRange, pitchRange } | null)`.

**Birleştirme sırası:** 1 → 2 → 3 → 4. Sonrakiler `main`'e rebase eder.

**Bitti ölçütü (herkes için):** typecheck temiz, bütün testler geçiyor, iki sekmede elle denendi, PR açıklamasında ekran görüntüsü var.
