# 🎵 Sunify - Masaüstü Müzik Çalar

Modern, zarif, senkronize şarkı sözü destekli masaüstü müzik yayın oynatıcısı (Electron tabanlı).

---

## 🚀 Proje Mimarisi

```
Sunify/
├── src/
│   ├── main/               # Electron Ana Süreci & Preload köprüsü
│   │   ├── main.js
│   │   └── preload.js
│   ├── renderer/           # Kullanıcı Arayüzü (HTML5, Vanilla JS, Modern CSS)
│   │   ├── index.html
│   │   ├── renderer.js
│   │   ├── style.css
│   │   └── i18n.json
│   ├── services/           # Bağımsız iş mantığı servisleri
│   │   ├── audio/          # Şarkı sözü (LRCLIB), ses akışı ve metadata temizleyici
│   │   ├── auth/           # Yerel profil ve Supabase bulut senkronizasyonu
│   │   └── rpc/            # Discord Rich Presence bağlantısı
│   ├── utils/              # Yardımcı fonksiyonlar (Logger, Renk Çıkarıcı)
│   ├── config.js           # Merkezi yapılandırma ve port ayarları
│   └── server.js           # Yerel proxy ve API motoru (Express)
├── data/                   # Yerel kullanıcı ve bulut ayar kayıtları
└── tests/                  # Test tanımları
```

---

## 🛠️ Kurulum & Çalıştırma

1. **Bağımlılıkları Yükle:**
   ```bash
   npm install
   ```

   Python 3.10+ kurulu olmalıdır. YouTube ses motoru için `npm run setup:python` komutunu da çalıştırın.

2. **Uygulamayı Başlat:**
   ```bash
   npm start
   ```

3. **Kod Kalite & Format Kontrolleri:**
   ```bash
   npm run lint
   npm run format
   ```

4. **Birim Testlerini Çalıştır:**
   ```bash
   npm test
   ```

---

## ✨ Temel Özellikler
- **Frameless Başlık Çubuğu:** Küçültme, Ekranı Kaplama, Kapatma ve Tam Ekran butonları.
- **Dinamik Şarkı Sözleri:** LRCLIB üzerinden milisaniye duyarlı hece/satır senkronizasyonu.
- **Discord Zengin Varlık (RPC):** O anda dinlenen şarkı, sanatçı ve kapak detayını Discord profilinde gösterir.
- **Hafif ve Hızlı:** Optimize edilmiş yerel mimari ve kalıcı kullanıcı verileri.

## Geliştirme notları

- `npm install` ile bağımlılıkları kur, `npm start` ile çalıştır, `npm test` ile test et.
- `npm run build:win` Windows kurulumunu üretir; yt-dlp/Deno ve kurulum görselleri (`build/*.bmp`) otomatik oluşturulur.
- Yazı tipi ve ikonlar `src/renderer/vendor` altında yereldir; uygulama çevrimdışı da aynı görünür.
- Tema katmanı: `src/renderer/modern.css` (style.css üstüne biner).
