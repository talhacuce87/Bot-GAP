# Plan 1: Performans (`perf/optimizasyon`)

**Neden.** Ölçüm (sahne Node'da kuruldu):
- Statik dünya tek mesh: 311 bin üçgen, 934 bin indekssiz köşe (~33 MB), yarıçapı 859 m, gölge düşürüyor.
- Ana geçişte ve gölge geçişinde her kare tamamı çiziliyor; gölge kutusu ise yalnızca 48–68 m (`SHADOW` içinde `half` 24/34).
- Bir chibi ~20 bin üçgen, konturla iki katı.
- Dünya kurulumu ~3,4 sn.

Diğer üç dal NPC, trafik ve canlı masalar ekleyecek; pay bu daldan açılacak.

**İşler**

1. **Ölçüm**
   - `?bench` modu (`client/src/bench.ts`):
     - Sabit saat (13:00 ve 22:00), sabit kamera yolu: meydan → otoban → şehir → casino içi → mahalle; 60 sn.
     - Çıktı: ortalama / p95 / p99 kare süresi, draw call ve üçgen sayısı.
     - Alt sistem süreleri `performance.mark` ile: world.update, remotes, features, avatars, render. Sonuç JSON olarak ekrana ve konsola yazılır.
   - `tests/sceneShim.ts`: `tests/roads.test.ts` içindeki DOM shim'leri buraya taşınır.
   - `tests/budget.test.ts`:
     - Tek nesnenin yarıçapı ≤ 200 m (izin listesi: gök, dağ, bulut, arazi).
     - Karo başına üçgen sınırı ve toplam rapor.
2. **Statik karolar**
   - `world/builder.ts` `add()` parçaları bounding box merkezine göre 96 m'lik karolara kovalar.
   - `world/scene.ts` (`statics` mesh'inin kurulduğu yer) her karo için ayrı mesh kurar: aynı malzeme, frustum culling açık.
3. **Prop bölgeleri.** Instanced proplar 256 m'lik bölgelere bölünür (`propMeshes`). `LampField` ampul listesi değişmez.
4. **İç mekânlar.** Dükkân ve casino iç mekânları yalnızca ≤ 60 m'de ya da içerideyken görünür.
5. **Köşe verisi**
   - Karolarda `mergeVertices`.
   - Normal Int8, renk Uint8 normalize: köşe başına 36 → 20 bayt.
   - Konumu Int16'ya nicemlemek yalnızca ölçüm gerektirirse.
   - Islaklık, bulut gölgesi ve LampField shader'ları ile çalıştığını gece ve yağmurda kontrol edin.
6. **Chibi LOD1**
   - `scripts/bake-chibi.mjs`: her parçaya meshopt ile ~%12'lik indeks aralığı (`i1Off` / `i1Count`; köşeler aynı, indeksler bin'in sonuna).
   - Kaynak paket: `chibi_asset_pack_v8/`. Bot'un `chibi_render.py`'si bozulmamalı.
   - `ChibiPack.build(look, lod)` ve `ChibiLayer`: 12 m'den uzakta LOD1; gölge yalnızca 25 m içinde.
7. **Küçükler**
   - Bloom yarım çözünürlükte (`world/post.ts`).
   - Kare başı ayırmalar azaltılır (`Cars.end` içindeki sıralama, `nearActs` dizileri).
   - Şehir ve mahalle karoları ilk kareden sonra parça parça kurulur.
   - "Kalabalık" ayarı: kapalı / az / normal / çok; grafik ön ayarına bağlı. Katkıcı 4 bunu okuyacak; `settings.crowd` alanı.

**Bitti.** Bench'te ana geçişteki üçgen sayısı ≥ %50, gölge geçişindeki ≥ %70 azalır; görsel fark yok. Önce/sonra bench JSON'u PR'a eklenir.

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
