# Plan 3: Arabalar ve NPC trafik (`feat/arabalar-trafik`)

**Neden.** Araba tek kişilik (`PlayerInfo.car`). Sürülen arabalar birbirinin içinden geçiyor, yayaya çarpma yok, şehirde trafik yok. Trafik lambaları yerel saatle dönüyor (`world/city.ts` içinde `time % 12`), bu yüzden herkeste farklı.

**A. Arabalar**

1. **Yolcu olma (G)**
   - Mesajlar: `{t:"pax", driver}` ve `{t:"paxoff"}`. "ride" adı bisiklet raporunda kullanılıyor, o yüzden değil.
   - `PlayerInfo.pax = {driver, seat}`; en çok 3 yolcu.
   - Doğrulama: arabaya `ENTER_REACH + 1` yakınlık; sürgünde, tankta ya da izleyiciyken binilemez.
   - `room.applyState` içinde yolcunun konumu yok sayılır; yolcu sürücünün konumunu alır, hız sınırı arabanınkidir.
   - Sürücü inince, park edince ya da çıkınca yolcular arabanın yanına iner.
   - Park halindeki arabaya da binilir. Yolcu radyoya şarkı koyabilir.
   - İstemci tarafı `vehicles.ts` ve `cars.ts` `seat()`: koltuk ofsetleri ve isim etiketleri.
2. **Araba–araba çarpışması**
   - `race.ts` `RaceClient.collide` deseni: üst üste binmeyi aç, yaklaşma hızını paylaş. Uzak arabalar `carCircles` ile hareketli engel olur.
   - Kıvılcım, `sfx.bump` ve kamera sarsıntısı.
   - Görsel hasar üç kademe (`cardmg`); garajda ya da 2 dk sonra onarılır.
   - Saf fonksiyon `shared/carHit.ts` içinde, testiyle.
3. **Yayaya çarpma.** Kurban kendi istemcisinde çarpıldığını anlar; `me.knock` çalışır ve düşme pozu oynar. `{t:"fall", vx, vz}` herkese yayılır; `AvatarView.fall` alanı eklenir.
4. **Pasif mod.** `PlayerInfo.passive`: çarpışmaz, düşmez, düşürmez; araba yarı saydam görünür.
5. **Korna ve kokpit kamerası.** H tuşu `horn` gönderir, yakındakiler 3D ses duyar. Arabadayken V kokpit kamerasına geçirir.

**B. NPC trafik**

1. `shared/traffic.ts`:
   - Rotalar: `ROAD_PATH`, `LINK_ROADS`, `VILLAGE_ROADS`, `HOOD_ROADS` ve `STREETS` çizgilerinden sağ şeride kaydırılmış kapalı döngüler; dönüşler `smoothPath` ile.
   - `routePose(route, s)`, dur çizgileri ve `signalPhase`. `world/city.ts` lambaları bundan sonra sunucu saatiyle döner.
2. `server/src/games/traffic.ts` (15 Hz, `WorldGames.tick` içinde):
   - IDM takibi, arabanın önündeki 30 m'lik sensöre göre. Engeller: araba, oyuncu, kırmızı ışık.
   - Kilitlenme kırıcı: 6 sn hareketsiz kalan ve yakınında engel olmayan araba ilerler.
   - Hız sınırları: köy 8, mahalle 10, şehir 12, otoban 16 m/sn.
   - Araç sayısı: 10 + 2 × oyuncu, en çok 36; gece az. Oyuncu yoksa simülasyon durur.
   - Çarpılınca (`npcbump`) 3 sn durur, dörtlüleri yanar, yana kayıp şeridine döner.
3. **Yayın:** ikili `MSG_TRAFFIC`, 7,5 Hz. Araba başına `[id u8][rota u8][s u16][v u8][ofset i8][bayrak u8]`. UDP hızlı yolu açıksa `sendFast`.
4. **İstemci**
   - `client/src/traffic.ts`: tampon ve gecikmeli interpolasyon; NPC'ler oyuncu arabası için hareketli engel olur.
   - `world/trafficCars.ts`: örnekli çizim, ~9 draw call. Model başına gövde ve cam (boya maskesi köşe niteliğinde), tek tekerlek InstancedMesh'i, örnekli far ve stop parıltısı.
   - Bunun için `world/tofas.ts` içinden `tofasGeometry()` ayrılır. Bugün bir Tofaş 21 nesne; 36 arabayı böyle çizmek ~750 draw call ederdi.
   - Yakın farlar LampField'e verilir. Yol kenarında park halinde NPC arabaları.
5. **Belediye otobüsü** (bitirince): duraklı özel bir NPC araç; oyuncular `pax` ile biner (sürücüsü NPC id).

**Testler.**
- Yolcu (Room): doğrulama, sürücüyü takip, iniş, ayrılma.
- Çarpışma fonksiyonu.
- Rotalar asfaltta ve binalara değmiyor (`roads.test` kurulumu).
- Simülasyon: çarpışmasız takip, kırmızıda durma, oyuncunun önünde fren, kilitlenme kırıcı.
- `MSG_TRAFFIC` kodlaması.

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
