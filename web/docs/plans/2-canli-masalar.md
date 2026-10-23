# Plan 2: Canlı masalar (`feat/canli-masalar`)

**Neden.**
- Casino tek kişilik: `server/src/casino.ts` her oyuncuya ayrı tur açar. Oyun ekranı DOM paneli (`client/src/ui/casino/*`); masadaki çark statik.
- Kahvehane oyunları DOM panelinde (`ui/boardGame.ts`).
- Hedef: rulete ya da blackjack'e biri oturunca herkes anlık görsün; oyun masanın üstünde, first person oynansın.

**Sunucu**

`server/src/games/casinoTables.ts`, `WorldGames` içinde çalışır. Cüzdan, `index.ts` içindeki `RingHost` ödülü gibi enjekte edilir (`Wallets` ve cüzdan anahtarı).

- **Koltuk:** `games/tables.ts` içindeki koltuk sahipliği ve yakınlık doğrulaması uygulanır (`csit` / `cleave`).
- **Rulet (2 masa × 4 tabure):**
  - Akış: `idle → bet` (ilk bahisle 20 sn) → `spin` → `result` (3 sn) → `idle`.
  - `spin`: `n` kripto rastgele seçilir; `spinAt` ve `landAt` (+6,5 sn) yayılır.
  - Mesaj: `{t:"rl", op:"bet"|"undo"|"clear"|"repeat", id, kind, v, amount}`.
  - Bahis anında bakiyeden düşer. Kalkan oyuncunun bahsi tur sonunda yine sonuçlanır; cüzdan anahtarı bahisle saklanır.
  - `validBet` ve `roulettePayout` aynen kullanılır.
- **Blackjack (2 masa × 5 tabure):**
  - Akış: `idle → bet` (12 sn) → `deal` → `turn` → `dealer` → `settle` (4 sn).
  - `turn`: koltuk sırasıyla, karar başına 20 sn; süre dolarsa oyuncu durur.
  - Masada tek ortak ayakkabı. `shared/casino.ts` dosyasına çok koltuklu saf fonksiyonlar eklenir (`bjtDeal`, `bjtAct`, `bjtDealer`); mevcut el hesabı ortak kullanılır.
- **Slot:** tek kişilik kalır; sonuç `{t:"slotspin", m, sid, stops, mult, at}` ile casinodakilere yayılır.
- **Yayın:** `{t:"cz", ...}` masa durumu `broadcastNear` ile gider. İçeri giren `czsync` ile tam durumu ister.
- Eski tek kişilik `bj` / `roulette` yolu ve panelleri kalkar; testleri taşınır. `wallet` ve `refill` kalır.

**İstemci**
- `world/casinoLive.ts`:
  - 37 cepli dönen çark ve top. Zaman çizelgesi `RouletteView`'daki çark/top matematiğinden ortak bir yardımcıya çıkarılır; herkeste top aynı cebe düşer.
  - Fişler tek InstancedMesh (oyuncu rengiyle); kartlar tek InstancedMesh ve 53 kartlık atlas.
  - Son 12 sayının tabelası; havada "+2.500" ve "BLACKJACK" yazıları.
  - Krupiye sıradaki koltuğa döner. Statik çark `world/casino.ts` içinden çıkarılır.
- `ui/casino/casinoHud.ts`: ince şerit. Bakiye, fiş seçimi (1–5), geri sayım, H/S/D/P, Tekrarla ve Temizle; dokunmatikte düğme.
- `client/src/seatCam.ts`:
  - Göz koltuktan ~1,05 m yukarıda, masaya bakar. Sağ tık sürükleyerek sınırlı bakınma; sol tık serbest.
  - Kendi gövden gizli. V ile omuz üstü kameraya geçilir.
  - `player.ts` `updateCamera` buna bağlanır; mevcut `focusView` geçişi yeniden kullanılır.
- Sol tık → raycast → rulet hücresi → bahis.

**Kahvehane**
- `BoardGameUi` panelsiz hale gelir: çizim ve isabet bölgeleri kalır.
- `world/boardSurface.ts`: her masanın tablasında `CanvasTexture` düzlem; durum değişince yeniden çizilir. Süs tahtalar kalkar (`world/kahvehane.ts`).
- Oturan oyuncu seatCam ile tahtaya bakar. Tıklama raycast ile UV'ye, oradan canvas koordinatına çevrilir ve mevcut `down` / `move` / `up` işleyicilerine gider.
- Okey ıstakası yalnızca oturanın ekranında; başkaları taşların sırtını görür.
- Başlat, pes et ve kalk: şerit tuşları (E / Q / F). Bilek güreşinin halkası masaya taşınır.

**Testler.** `tests/casinoTables.test.ts` (sahte saat ve sıralı rastgele sayılar):
- Faz geçişleri, bakiye ve iade, zaman aşımı.
- Kalkan oyuncu; iki oyuncu aynı turda.
- Split ve double.
- Yalnızca oturan bahis yapabilir.

**Elle deneme.** İki sekmede rulet aynı sayıda durur; fişler, kartlar ve slot makarası ikisinde de görünür. Kahvehanede hamle iki tarafta da tahtada görünür.

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
