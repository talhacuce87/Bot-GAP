# 🤖 Discord XP & Level Bot — Bot-GAP

<p align="center">
  <img src="assets/banner.jpg" alt="Banner" width="100%">
</p>

---

A feature-rich, high-performance Discord bot built with Python and Pillow that tracks user activity, rewards XP (text & voice), manages streaks, tracks voice pairs ("Best Friend"), levels users up, and renders gorgeous image cards.

---

## 🚀 Features

* 💬 **Mesaj XP:** Mesaj başına cooldown korumalı dinamik XP kazanımı.
* 🔊 **Ses XP & Takip:** Ses kanallarında geçirilen süreyi hassas biçimde kaydetme.
* 👥 **Best Friend Sistemi (`!bf`):** Ortak ses süresini takip eden ve 100 saatlik eşiğe göre özel çift kartı üreten sistem.
* 🎴 **Görsel Kullanıcı Kartı (`!kart`):** Pillow ile oluşturulan seviye, rol ve ilerleme kartı.
* 🏆 **Liderlik Sıralaması (`!liderlik`):** Sunucudaki ilk 10 kullanıcının madalyalı görsel sıralama kartı.
* 🗺️ **Rol Haritası (`!roller`):** Seviye kilitlerini ve XP hedeflerini gösteren görsel rol yol haritası.
* 🔥 **Günlük Seri (Streak):** Düzenli katılım için çarpanlı XP ödülleri.
* 📊 **SQLite WAL Modu:** Hızlı ve thread-safe asenkron veritabanı mimarisi (`aiosqlite`).

---

## 🛠️ Tech Stack

* Python 3.10+
* discord.py (v2)
* Pillow (PIL)
* aiosqlite (SQLite WAL)

---

## 📂 Project Structure

```
Bot-GAP/
├── Main.py              # Bot giriş noktası ve cog yükleyici
├── usercard.py          # !kart kullanıcı profili kart üretimi
├── leaderboard.py       # !liderlik ve !roller görsel kart üretimi
├── bestfriend.py        # !bf ses çifti takibi ve kart üretimi
├── rolescard.py         # XP rol haritası kart tasarımı
├── font_utils.py        # Font/glif temizleme ve emoji fallback yardımcıları
├── info.py              # !yardim, !yenilikler (changelog) ve ping komutları
├── audit.py             # Olay kaydı dinleyicileri, canlı hile dedektörü, analiz komutları
├── activitylog.py       # Log dosyası kurulumu ve toplu olay yazıcısı (activity_log)
├── analysis.py          # Geçmişe dönük hile/kasma analizi (CLI olarak da çalışır)
├── xp.py                # XP olayları, ses döngüleri ve komutlar
├── xproles.py           # Seviye eşikleri ve rol yönetimi
├── database.py          # Merkezi asenkron SQLite veritabanı
├── requirements.txt     # Bağımlılıklar
├── Dockerfile           # Konteyner yapılandırması
├── docker-compose.yaml  # Docker Compose dağıtım dosyası
└── assets/
    ├── banner.jpg       # Sunucu afişi
    ├── logo.jpg         # Bot logosu
    └── fonts/           # DejaVuSans TrueType fontları
```

---

## ⚙️ Setup

### 1. Clone the repository

```bash
git clone https://github.com/talhacuce87/Bot-GAP.git
cd Bot-GAP
```

### 2. Install dependencies

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Create a `.env` file

Create a file named `.env` in the root directory and add:

```env
DISCORD_TOKEN=your_bot_token_here
BOT_PREFIX=!
# İsteğe bağlı: şüpheli hareket ve admin işlemi bildirimlerinin gideceği kanal
LOG_CHANNEL_ID=123456789012345678
# İsteğe bağlı: yeni sürüm açıldığında güncelleme notlarının otomatik paylaşılacağı kanal
ANNOUNCE_CHANNEL_ID=123456789012345678
# İsteğe bağlı: log dosyası (gün) ve olay kaydı (gün) saklama süreleri
LOG_FILE_RETENTION_DAYS=90
EVENT_RETENTION_DAYS=365
```

---

## ▶️ Run the Bot

```bash
python Main.py
```

Or run via Docker:

```bash
docker compose up -d --build
```

---

## 📌 Commands

### 👥 Kullanıcı Komutları
* `!yardim` (alias: `!help`, `!komutlar`) → Tüm bot komutlarını ve açıklamalarını kategorize edilmiş embed olarak listeler.
* `!yenilikler` (alias: `!changelog`, `!surum`, `!guncelleme`) → Son deploy ve güncellemede gelen tüm yeni özellikleri gösterir.
* `!kart [@kullanıcı]` → Seviye, XP ve istatistik kartını görsel olarak gösterir.
* `!liderlik` (alias: `!lb`, `!top`) → Sunucu içi ilk 10 XP sıralama kartını oluşturur.
* `!roller` (alias: `!roles`, `!xproller`) → Seviye rol yol haritasını görsel kart olarak gösterir.
* `!bf [@kullanıcı]` → En çok vakit geçirilen ses partnerini ve 100 saatlik Best Friend durumunu gösterir.
* `!xp` → Detaylı metin tabanlı XP ve rol durumu embed'i gönderir.
* `!streak` → Günlük seri ve aktif çarpan durumunu görüntüler.
* `!feature <istek>` → Bot geliştiricisine özellik önerisi kaydeder.
* `!ping` → Bot gecikme ve WebSocket ping süresini ölçer.

### 🛡️ Yönetici Komutları
* `!yedekle` (alias: `!backup`) → Veritabanının anlık yedeğini güvenle alır.
* `!xpayarla @kullanıcı <miktar>` → Kullanıcının toplam XP'sini doğrudan ayarlar.
* `!xpekle @kullanıcı <miktar>` → Kullanıcıya XP ekler veya çıkarır.
* `!boost @kullanıcı <çarpan> [saat]` → Süreli XP boost çarpanı uygular.
* `!xpsenkronize` → Sunucudaki tüm üyelerin XP rollerini baştan kontrol edip senkronize eder.

---

## 📜 License

This project is open-source and free to use.

---

## 🕵️ Loglama & Hile Analizi

**Log dosyaları:** `data/logs/bot.log` (her gece döner, 90 gün saklanır). `data/` volume olduğu için redeploy'da silinmez.

**Olay kaydı (`activity_log` tablosu):** mesaj metadatası (içerik değil; uzunluk + hash), XP kazanımları (mesaj/ses/streak), seviye ve rol değişimleri, ses giriş/çıkış/mute/yayın, üye giriş/çıkış (hesap yaşı), mesaj silme/düzenleme, komutlar ve hatalar, tüm admin işlemleri ve şüpheli hareket bayrakları.

**Canlı dedektör** (`LOG_CHANNEL_ID` kanalına bildirir):
* `tekrar_mesaj` — aynı içerik tekrar tekrar
* `makro_zamanlama` — mesaj aralıkları neredeyse sabit (makro / self-bot)
* `cooldown_kasma` — mesajlar tam XP cooldown'ı dolunca atılıyor
* `sessiz_ses_kasma` — kanaldaki herkes 30+ dk mikrofonu kapalı ses XP'si alıyor
* `yeni_hesap_ses` — 14 günden yeni hesap ses XP'si alıyor

**Komut satırından analiz** (sunucuda):

```bash
docker exec <container> python analysis.py --guild <sunucu_id> --days 30
docker exec <container> python analysis.py --guild <sunucu_id> --user <üye_id> --days 90
docker exec <container> python analysis.py --guild <sunucu_id> --legacy   # kayıt öncesi toplam verilerden
```

---

## 🚀 Yeni Sürüm Yayınlama

1. `info.py` içinde `BOT_VERSION` ve `LAST_DEPLOY_DATE` değerlerini güncelle.
2. `_build_changelog_embed()` içindeki notları yeni sürüme göre yaz.
3. Deploy et. Bot açılınca sürüm numarası son duyurulandan farklıysa notları `ANNOUNCE_CHANNEL_ID` kanalına **bir kez** paylaşır (`data/announced_version.txt`). Sürüm numarası değişmeden yapılan yeniden başlatmalarda tekrar paylaşmaz.
