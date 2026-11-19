# Sunify – Bunker Launcher Entegrasyon Belgesi

**Kod inceleme tarihi:** 2026-11-15  
**İncelenen kaynak:** Bu çalışma alanındaki Sunify kaynak kodu. Örnek alan değerleri şematiktir; endpoint şekilleri kaynak koddaki sözleşmeye göre verilmiştir.  
**Mevcut destek durumu:** Sunify'ın yerel Express API'si vardır; fakat harici oynatıcı kontrolü, `now-playing` sorgusu, olay akışı ve entegrasyon tokenı **YOK**. 10. bölümdeki API yalnızca öneridir, bugün çalışan API değildir.

Kodda olmayan veya kaynaktan doğrulanamayan konular sırasıyla **YOK** ve **DOĞRULANMADI** diye işaretlenmiştir. Kullanıcı mesajındaki teknoloji listesi kaynak kodla çelişirse kaynak kod esas alınmıştır.

## 1. Genel mimari

### Klasör ağacı

```text
Sunify/
├─ package.json                 # Sürümler, komutlar, Electron Builder/NSIS yapılandırması
├─ data/
│  └─ supabase_config.json      # Varsayılan Supabase URL ve public anon/publishable key
├─ public/                      # Eski/yardımcı renderer varlıkları; ana pencerenin giriş noktası değil
├─ build/                       # Uygulama ikonu ve NSIS kurulum görselleri
├─ scripts/
│  ├─ prepare-windows-runtimes.js # yt-dlp ve Deno Windows ikililerini doğrulayarak alır
│  └─ create-installer-artwork.ps1 # Kurulum görsellerini üretir
├─ src/
│  ├─ main/
│  │  ├─ main.js                # Electron main, pencere, protokol, IPC, Express'i başlatır
│  │  ├─ preload.js             # Güvenli `window.sunifyAPI` köprüsü
│  │  └─ mini-player-preload.js # Mini oynatıcı IPC köprüsü
│  ├─ renderer/
│  │  ├─ index.html             # Ana arayüz
│  │  ├─ renderer.js            # UI, Audio elementi, oynatma/kuyruk/hesap mantığı
│  │  ├─ style.css
│  │  ├─ mini-player.html/js/css
│  │  └─ i18n.json
│  ├─ server.js                 # Express API
│  ├─ services/
│  │  ├─ audio/streamProxy.js   # yt-dlp/Python ile ses URL'si çözümleme ve cache
│  │  ├─ audio/lyricsService.js # LRCLIB, Netease ve LyricsOVH araması
│  │  ├─ audio/metadataCleaner.js
│  │  ├─ auth/localAuthService.js
│  │  ├─ auth/supabaseClient.js
│  │  ├─ rpc/rpc.js             # Electron main'den discord-rpc kullanımı
│  │  ├─ rpc/discordRpcService.js # Express'ten çağrılan ayrı Discord IPC uygulaması
│  │  └─ updateService.js
│  └─ build-info.json           # GitHub repository bilgisi
├─ supabase/
│  ├─ functions/sunify-admin/index.ts
│  └─ migrations/               # Ortak dinlenme tablosu fonksiyonları
├─ docs/                        # Proje dokümantasyonu
└─ tests/                       # Node testleri
```

### Süreçler ve iletişim

```text
Electron main (src/main/main.js)
  ├─ BrowserWindow → renderer (HTML/CSS/vanilla JS)
  │    ├─ preload: contextBridge + ipcRenderer → IPC → main
  │    └─ HTTP fetch → Express (127.0.0.1:<dinamik-port>/api)
  ├─ Express aynı Electron/Node main sürecinde çalışır
  ├─ Discord RPC (main ayrı modül)
  └─ child_process.spawn → yt-dlp.exe + Deno (paketli) veya Python/py (geliştirme fallback)
```

- Renderer, portu main'in `index.html?apiPort=...` sorgusundan okur ve Express'e HTTP ile gider. Ses akışı da Express üzerinden HTTP Range destekli proxy olarak sunulur.
- Renderer→main masaüstü işlevleri `contextBridge` ile sınırlı IPC'dir. `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true` kullanılır.
- Express, Electron main ile aynı Node sürecinde çalışır; renderer'dan `fetch` ile çağrılır. `npm run server` ile ayrı Node sürecinde de çalıştırılabilir, ancak bu durumda Electron pencere/IPC yoktur.
- Python (geliştirme yedeği) ve yt-dlp/Deno (paketli birincil yol) `child_process` ile çalıştırılır. stdout JSON, stderr hata metni içindir. Audio dosyası Python stdout'undan aktarılmaz.
- WebSocket/SSE: **YOK**.

### Sürümler ve bağımlılıklar

- Sunify sürümü: `package.json` 1.0.0; `src/build-info.json` yalnızca repo bilgisini taşır.
- Electron: package aralığı `^40.8.0`, lockfile'da **40.10.6**. Geliştirme bilgisayarındaki Electron ikilisi bu çalışma alanında olmadığı için çalıştırılan ikili sürümü **DOĞRULANMADI**.
- Node.js: bu inceleme makinesinin sistem Node'u v26.13.1; Electron içindeki Node sürümü **DOĞRULANMADI**. Electron runtime ayrı sürümlenebilir.
- Python: bu inceleme makinesinde Python 3.11.0 bulundu. Bu, son kullanıcıların sistem Python sürümü anlamına gelmez. Kurulu uygulamada normal ses URL çözümlemesi için paketli `yt-dlp.exe` ve `deno.exe` kullanılır.
- Doğrudan bağımlılıklar: `@supabase/supabase-js ^2.119.0`, `axios ^1.13.2`, `cors ^2.8.5`, `discord-rpc ^4.0.1`, `express ^5.2.1`, `node-vibrant ^4.0.4`, `yt-search 2.13.1`.
- Geliştirme bağımlılıkları: `electron ^40.8.0`, `electron-builder ^26.18.0`, `eslint ^8.57.0`, `eslint-config-prettier ^9.1.0`, `eslint-plugin-import ^2.29.1`, `prettier ^3.2.5`, `supabase ^3.1.0`.
- Gemini bağımlılığı **YOK**.

### Başlatma ve kapanış

- `npm start` → `electron src/main/main.js`.
- `npm run server` → `node src/server.js`.
- Main, `app.requestSingleInstanceLock()` alır. Kilidi alamayan ikinci süreç `app.exit(0)` ile kapanır; `second-instance` ilk pencereyi öne getirir. Komut satırı argümanları oynatmayı kontrol etmez; yalnızca `sunify://auth/callback` doğrulama sonucunu alır.
- İşletim sistemi açılışında otomatik başlatma ayarı/kodu **YOK**.
- Kapanışta `before-quit` global kısayolları kaldırır ve Discord durumunu temizler; Windows/Linux'ta son pencere kapanınca uygulama çıkar, macOS'ta süreç açık kalabilir.
- `Alt+Shift+O` mini oynatıcı kısayolu. `sunify://auth/callback` yalnızca e-posta doğrulama akışı içindir.

## 2. Express sunucusu

### Adres, port, CORS ve hata biçimi

- `src/server.js`: host `127.0.0.1`; LAN arayüzüne (`0.0.0.0`) bağlanmaz.
- Varsayılan `PORT=0`: işletim sistemi boş port seçer; dolayısıyla port **dinamiktir**. Main, seçilen portu renderer'a aktarır. `PORT` ortam değişkeni verilirse sabit port denemesi yapılır.
- Port ayrıca `app.locals.port` üzerinde tutulur ve `/api/diagnostics` yanıtında döner. Ayrı `npm run server` başlatmasında başlangıç portu konsola yazılır; kalıcı keşif dosyası **YOK**.
- Seçili CORS origin'leri `null`, `file://`, ve loopback host/portlardır. CORS bir tarayıcı kısıtıdır, kimlik doğrulama değildir. Origin'siz istekler CORS kontrolünü geçer.
- `/api/*` için bellek içi IP+path limit: 60 saniyede 120 istek; aşılırsa `429 {"error":"Çok fazla istek; lütfen biraz bekleyin."}`. JSON body limiti 2 MB.
- Hata JSON'ları çoğunlukla `{ "error": "..." }`; bazıları `detail`, `unavailable` de döndürür. Başarılı akış/indirme endpoint'leri JSON yerine medya baytları döndürebilir.
- API'de ortak bearer-token zorunluluğu **YOK**. Sadece auth/sync uçları kendi `Authorization: Bearer ...` kontrolünü yapar. `/api/admin` admin pin/oturum bilgilerini Supabase Edge Function'a iletir.

### Mevcut endpoint listesi

Base adresi örneği `http://127.0.0.1:PORT`. Aşağıdaki `PORT` gerçek Electron çalışmasında dinamik olarak bulunmalıdır. JSON yanıt örnekleri kaynaktaki şekli gösterir; değişken kimlikler/değerler örnektir.

| Yöntem ve yol | İstek / parametre | Başarılı yanıt veya davranış |
|---|---|---|
| `POST /api/discord-rpc` | JSON `{track, position, duration, isPlaying}`; track yoksa temizler | `{"success":true}` |
| `GET /api/diagnostics` | Parametre yok | `{"pythonAudio":{"python":false,"ytDlp":true,"deno":true,"bundled":true,"executable":"..."},"server":"ready","port":54321}`. Sistem sürüm durumuna göre `pythonAudio` değişir. |
| `GET /api/updates/latest` | Parametre yok | Repo yapılandırılmadıysa `{"configured":false,"currentVersion":"1.0.0","updateAvailable":false}`; yapılandırılmışsa aşağıdaki sürüm örneği. |
| `POST /api/admin` | JSON `{action,...}`; izinli action'lar aşağıda | Supabase `sunify-admin` Edge Function yanıtı aynen iletilir. |
| `GET /api/search?q=...` | `q` zorunlu | `{results:[{id,title,rawTitle,artist,thumbnail,duration,timestamp,views,url}]}`; en çok 25 video. |
| `GET /api/recommendations?q=...` | `q` zorunlu, en fazla 240 karakter | `{tracks:[{id,title,artist,thumbnail,duration,query}]}`; en çok 18 parça. |
| `GET /api/search/playlists?q=...` | `q` zorunlu, en fazla 120 karakter | `{playlists:[{id,title,author,thumbnail,size,url}]}`; en çok 12 liste. |
| `POST /api/discover/play` | JSON `{track:{id,title,artist?,thumbnail?}}` | `{"success":true}`; Supabase ortak sayaç RPC'sini çağırır. |
| `GET /api/discover/top?limit=10` | `limit` 1–20, varsayılan 10 | `{tracks:[...]}`; Supabase yok/hata ise `{"tracks":[],"unavailable":true}`. |
| `GET /api/artists/search?q=...` | `q` zorunlu, en fazla 120 karakter | `{artists:[{id,name,genre,image}]}`; iTunes kataloğu. |
| `GET /api/artists/:id` | Pozitif tamsayı iTunes artist ID | `{artist:{id,name,genre,image,bio},tracks:[...],albums:[...]}`. Track alanları `catalogId,title,artist,query,thumbnail,duration,albumId,album`; albüm `id,title,artist,image,year,trackCount`. |
| `GET /api/stream?id=...` veya `?q=...` | YouTube video ID veya arama sorgusu; isteğe bağlı `refresh=1` | yt-dlp metadata JSON; `url,duration,title,thumbnail,ext` içerir. Paketli yt-dlp'nin ham JSON'unda ek alanlar da olabilir; kararlı sözleşme olarak kabul edilmemeli. |
| `GET /api/audio-stream?id=...` veya `?q=...` | ID/sorgu, isteğe bağlı `refresh=1`, HTTP `Range` | Ses baytları, `200`/`206`, `Accept-Ranges: bytes`; hata JSON'u. |
| `GET /api/lyrics?title=...&artist=...&duration=...&source=auto` | `title` zorunlu; source `auto/lrclib/netease/genius` | Başarı `{source,syncedLyrics,plainLyrics,success,cleaned}`; bulunamazsa `{success:false,message,cleaned}`. |
| `POST /api/import-playlist` | JSON `{url}`; YouTube playlist veya Spotify playlist URL | `{id,name,author,thumbnail,tracks:[{id,title,artist,thumbnail,duration,query?}]}`. |
| `POST /api/library/folders` | JSON `{folders:["C:\\Music"]}`; en çok 20 klasör | `{"success":true,"folders":1}`; seçilen izinli dizin listesi süreç belleğinde. |
| `GET /api/library/file?path=...` | Yerel dosya tam yolu | Dosya baytları; yalnızca downloads veya daha önce izin verilen müzik kökleri altı. Hatalı/izin dışı dosya `404 {error}`. |
| `GET /api/local-downloads` | Parametre yok | `{tracks:[{id,title,artist,localFile,localUrl,thumbnail,duration,isLocal}]}`. |
| `POST /api/save-track-locally` | JSON `{title?,artist?,id?,query?}` | `{"success":true,"fileName":"Artist - Track.m4a","localUrl":"http://127.0.0.1:PORT/downloaded/..."}`; varsa `alreadyExists:true`. |
| `GET /api/download?id=...` veya `?q=...` | ID, query ya da title/artist | Başarıda indirme baytları + `Content-Disposition`; başarısızlıkta JSON `{error}`. |
| `GET /api/extract-color?url=...` | İsteğe bağlı görüntü URL | `{"rgb":[234,179,8],"hex":"#eab308"}` veya bulunan baskın renk. |
| `GET /api/auth/config` | Parametre yok | `{"isConfigured":true,"url":"https://<project>.supabase.co"}`. Key dönmez. |
| `POST /api/auth/config` | JSON `{url,anonKey}`; URL HTTPS olmalı | `{"success":true,"isConfigured":true}`. |
| `POST /api/auth/register` | JSON `{email,password,username?}` | `{"success":true,"user":{...},"session":{"access_token":"<redacted>","token_type":"bearer","user":{...}}}`; yerel auth veya Supabase oturumu. |
| `POST /api/auth/login` | JSON `{email,password}` | Aynı genel `{success,user,session}` şekli; önce Supabase, başarısızsa yerel hesap denenir. |
| `POST /api/auth/logout` | `Authorization: Bearer <session>` | `{"success":true}`. Kaynakta yerel session revoke edilir; Supabase signOut çağrısı **YOK**. |
| `GET /api/sync/pull` | `Authorization: Bearer <session>` | `{playlists:[...],analytics:{liked_tracks:[...],listening_stats:{...}}}`. |
| `POST /api/sync/reset-own-data` | Bearer token; body yok | `{"success":true}`; sadece o hesabın Sunify playlist/analytics verisini siler. |
| `POST /api/sync/push` | Bearer token; JSON `{playlists?,likedTracks?,listeningStats?}` | `{"success":true,"message":"Bulut senkronizasyonu tamamlandı."}` (yerel session ise yerel mesaj). |
| `GET /downloaded/:filename` | URL yolu | `downloads` klasöründeki statik dosya baytları (`express.static`). JSON API değildir. |

### İstek/yanıt örnekleri

```http
GET /api/search?q=Harvey HTTP/1.1
Host: 127.0.0.1:54321
```

```json
{"results":[{"id":"abcdefghijk","title":"Track","rawTitle":"Artist - Track","artist":"Artist","thumbnail":"https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg","duration":210,"timestamp":"3:30","views":12345,"url":"https://www.youtube.com/watch?v=abcdefghijk"}]}
```

```http
GET /api/stream?id=abcdefghijk HTTP/1.1
Host: 127.0.0.1:54321
```

Yanıt örneği:

```json
{"url":"https://rr.example.googlevideo.com/videoplayback?...","duration":210,"title":"Artist - Track","thumbnail":"https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg","ext":"m4a"}
```

Akış URL'si örnek/ephemeral'dır; gerçek yt-dlp JSON yanıtı daha fazla alan taşıyabilir. Oynatma için uygulama `/api/audio-stream?id=abcdefghijk` kullanır.

```http
POST /api/auth/login HTTP/1.1
Host: 127.0.0.1:54321
Content-Type: application/json

{"email":"user@example.com","password":"<şifre>"}
```

```json
{"success":true,"user":{"id":"<id>","email":"user@example.com"},"session":{"access_token":"<redacted>","token_type":"bearer","user":{"id":"<id>","email":"user@example.com"}}}
```

```http
GET /api/updates/latest HTTP/1.1
Host: 127.0.0.1:54321
```

```json
{"configured":true,"currentVersion":"1.0.0","version":"1.1.0","title":"Sunify 1.1.0","notes":"Release notes","releaseUrl":"https://github.com/Kadir-72I/Sunify/releases/tag/v1.1.0","downloadUrl":"https://github.com/Kadir-72I/Sunify/releases/download/v1.1.0/Sunify-Setup-1.1.0.exe","updateAvailable":true,"publishedAt":"2026-11-15T10:00:00Z"}
```

`POST /api/admin` action allowlist: `admin-login`, `list-users`, `get-user-data`, `delete-user-data`, `delete-user`, `create-release-upload`, `publish-release`. Body'de `action` ve eylemin gerektirdiği alanlar bulunur; admin pin `X-Admin-Pin` başlığından aktarılır, eylem yanıtları Supabase Edge Function tarafından belirlenir. Örnek login isteği:

```http
POST /api/admin HTTP/1.1
Host: 127.0.0.1:54321
Content-Type: application/json
X-Admin-Pin: <gizli>

{"action":"admin-login","email":"admin@example.com","password":"<şifre>"}
```

**Not:** Admin response şeması Edge Function'ın mevcut deployed sürümüne bağlı; sabit response şeması Express kaynak kodunda tanımlı değildir (**DOĞRULANMADI**).

Diğer request body/parametreleri yukarıdaki endpoint tablosundadır. Tipik hata yanıtları:

```json
{"error":"Query q is required"}
```

```json
{"error":"Çok fazla istek; lütfen biraz bekleyin."}
```

## 3. Çalma durumu ve kontrol

- Şu anda çalan parça ve kuyruğun kaynak-of-truth'u `src/renderer/renderer.js` içindeki renderer değişkenleridir: `currentTrack`, `currentPlaylist`, `currentIndex`, `isPlaying`, `isShuffle`, `isRepeat`; süre `HTMLAudioElement` `audio` üzerinden okunur.
- Ana renderer `index.html` içindeki `audioPlayer` HTML audio elementiyle sesi çalar; playlist seçilince `playSelectedTrack(track, playlist, index)` akışı başlar. Uzaktaki ses, önce `/api/stream` ile çözülür, sonra `/api/audio-stream` üzerinden oynatılır. Yerel dosyaysa `localUrl` kullanılır.
- Başlık/sanatçı/kapak/süre: `currentTrack.title`, `.artist`, `.thumbnail`, `.duration` (yt-dlp çözümünde güncellenebilir); geçen süre: `audio.currentTime`; oynuyor/durakladı: `isPlaying`/`audio.paused`.
- Ses seviyesi `audio.volume` (0..1), karıştırma `isShuffle`, tekrar `isRepeat` renderer belleğindedir. Bu durumların hiçbirini döndüren `GET /api/now-playing` endpoint'i **YOK**.
- Kontroller sadece renderer DOM olaylarıdır: play/pause `togglePlayPause`; sonraki `playNextTrack`; önceki `currentPlaylist/currentIndex`; seek `audio.currentTime`; ses `handleVolumeChange`; sıra görünümü renderer `currentPlaylist`. Bu işlevler dışarıya HTTP veya IPC API olarak açılmamıştır.
- Kuyruk, renderer belleğinde geçici `currentPlaylist` dizisidir. Kullanıcı playlistleri `localStorage` hesap-scope'lu `sunify_custom_playlists` alanında ve sync açıksa Supabase `user_playlists` tablosunda tutulur. Harici kuyruğu okuma/değiştirme endpoint'i **YOK**.
- Şarkı durum değişimi dış uygulamaya yayınlanmaz. Discord RPC için uygulama içi çağrı vardır; genel webhook/SSE/WebSocket **YOK**.

## 4. yt-dlp / Python katmanı

- Kurulu Windows paketinde `scripts/prepare-windows-runtimes.js`, yt-dlp projesinin `yt-dlp.exe` asset'ini ve Deno Windows x64 zip'ini GitHub Releases'ten alır, GitHub tarafından sunulan SHA-256 ile doğrular ve `build/runtime` içine koyar. Electron Builder bunları `resources/sunify-tools/` altına kopyalar.
- Paketli ana ses çözümlemesi Python değil, `yt-dlp.exe` + Deno'dur. Çağrı `spawn(exe, args)` ile; temel argümanlar:

```text
--dump-single-json --no-warnings --no-playlist
--format bestaudio[ext=m4a]/bestaudio --skip-download
--socket-timeout 15 --no-progress --quiet
--js-runtimes deno:<deno.exe> <YouTube URL | ytsearch1:query>
```

- Video ID, YouTube watch URL'ye; sorgu `ytsearch1:<query>` biçimine çevrilir. Timeout 30 saniye. 45 dakika TTL ve en çok 200 girişli bellek cache'i; aynı anda aynı sorgu istekleri birleştirilir.
- Geliştirme fallback'i sistem `python -c <script> <target>`, ardından `py -c ...` ile `yt_dlp` Python modülünü çağırır. `npm run setup:python` sadece geliştirici komutudur.
- Normal akış indirilmiş yerel dosyadan değil, yt-dlp'nin bulduğu geçici/süreli YouTube CDN URL'sinden (`/api/stream`) veya Sunify'ın range proxy'sinden (`/api/audio-stream`) verilir. Dış launcher'a dönen CDN URL'si kalıcı garanti taşımaz ve çalma kontrolü sağlamaz.
- İndirilen müzik: `<userData>\downloads`. Kullanıcı seçtiği başka dizinler sunucu belleğindeki `ALLOWED_MUSIC_DIRS` içinde tutulur; yeniden başlatmada yeniden seçilmeleri gerekir. Genel cache için ayrıca sabit medya klasörü belirtilmemiştir; stream URL cache'i RAM'dedir.
- Python/yt-dlp alt süreci hata verirse hata yakalanıp HTTP JSON hatasına çevrilir; Electron ana süreç otomatik kapanmaz. Paketlenmiş yt-dlp bulunamazsa geliştirme fallback'i Python/`py` denenir.
- **Risk:** Playlist import yardımcısı (`extractPlaylistWithYtDlp`) `yt-dlp.exe` paketli olsa bile Python `yt_dlp` modülünü çağırır; ardından `yt-search` fallback dener. Python'sız yeni Windows kurulumunda playlist import ilk yolu çalışmayabilir.

## 5. Gemini entegrasyonu

- Gemini kullanımı: **YOK**.
- Gemini API anahtarı/environment ayarı: **YOK**.
- Gemini endpoint'i, prompt'u, rate-limit'i: **YOK**.
- `package.json`'da Gemini SDK'sı bulunmuyor. Öneriler `yt-search` ile; sözler LRCLIB/Netease/LyricsOVH servisleriyle alınır. Kullanıcı mesajındaki `gemini-3.5-flash-lite` bilgisi kaynak kodda doğrulanmadı ve kodla desteklenmiyor.

## 6. Discord durumu (Rich Presence)

- İki Discord uygulaması görülüyor; bu önemli uyumsuzluk:
  1. `src/services/rpc/rpc.js`: `discord-rpc` npm paketi, IPC transport; main process `initRPC()` çağırır.
  2. `src/services/rpc/discordRpcService.js`: Node `net` ile Discord IPC framing'i elle kurar; Express `/api/discord-rpc` bunu çağırır.
- İki modülde yazılı Client ID: `1570821512984793228`. `src/config.js` içindeki `DISCORD_CLIENT_ID` ise farklı `1215372480352526366` değeridir ve incelenen iki RPC modülünde kullanılmıyor. Bu tutarsızlık nedeniyle yayınlanan gerçek Discord uygulama kimliği **DOĞRULANMADI**.
- Main RPC alanları: `details=başlık`, `state=sanatçı`; oynarken `startTimestamp/endTimestamp`; `largeImageKey=thumbnail URL` veya `sunify_logo`; `smallImageKey=sunify_logo`; `largeImageText` başlık; `smallImageText` Sunify. Duraklatmada state'e “(Duraklatıldı)” eklenir. Butonlar tanımlı **YOK**.
- Net implementasyonu aynı temel başlık/sanatçı ve timestamp'i `assets.large_image/large_text`, `small_image/small_text` alanlarıyla yollar. İki bağımsız IPC istemcisinin aynı Discord sürecine Presence yazması muhtemel ve güvenilir değildir.
- Kapak URL'si doğrudan image key olarak kullanılır (main tarafındaki `discord-rpc` uygulaması). Discord geliştirici uygulamasında her key'i önceden yükleme gereksinimi bu kodda ele alınmıyor; dış URL kabul edilip edilmeyeceği Discord davranışına bağlıdır (**DOĞRULANMADI**).
- Bunker'ın aynı Presence'i yayınlaması için Sunify kodunu paylaşmak gerekmez; ancak Bunker kendi Discord IPC bağlantısı/uygulama kimliğiyle ayrı presence yayınlamalıdır. Sunify RPC kodunu kütüphane olarak paylaşma ya da resmi ortak client modülü **YOK**. Aynı Discord client ID'yi iki uygulamanın aynı anda kullanması çakışma riski taşır. Bu belgeye göre modül ayırımı/ortaklaştırma yapılmamıştır.

## 7. Ayarlar ve veri

- Electron main `app.getPath('userData')` yolunu `%APPDATA%\SunifyPlayerData` olarak sabitler (Windows). Bu yol `userData` altındaki DB ve indirme dizinleri için kullanılır.
- Yerel kullanıcı DB: `%APPDATA%\SunifyPlayerData\sunify_users.json`. JSON dizi; kullanıcı alanları `id`, `username`, `email`, `passwordSalt`, `passwordHash`, `created_at`, `playlists`, `likedTracks`, `listeningStats`, `sessionTokenHash`. Şifre scrypt ile hash'lenir; session token'ın hash'i saklanır.
- Supabase bağlantı ayarı: `%APPDATA%\SunifyPlayerData\supabase_config.json`, şema `{"url":"https://...supabase.co","anonKey":"<public anon/publishable key>"}`. Başlangıçta bu dosya yoksa paket içindeki `data/supabase_config.json` okunur. Bu anon/publishable key gizli servis anahtarı değildir.
- İndirmeler: `%APPDATA%\SunifyPlayerData\downloads\`.
- Renderer ayarları, Electron Chromium `localStorage`'ında tutulur; kesin Chromium disk konumu Electron profil ayarına bağlıdır (**DOĞRULANMADI**). Tema, EQ gain, mini oynatıcı, çıktı aygıtı, söz gecikmesi ve font ayarı global key'lerdir.
- Hesap verileri `sunify_account_<encodeURIComponent(user-id veya guest)>_<alan>` anahtarlarına scope edilir. Alanlar: arama geçmişi, son çalınanlar, beğeniler, analytics, özel playlistler, dinleme istatistikleri. Örnek: `sunify_account_<id>_sunify_custom_playlists`.
- Bulut sync: Supabase `user_playlists` ve `user_analytics`; RLS politikaları Supabase migration/proje tarafına bağlıdır. Bu belge prod policy'leri canlı Supabase'ten doğrulamaz (**DOĞRULANMADI**).

## 8. Güvenlik

- Express yalnız `127.0.0.1`'e bind olur; ağdaki başka bilgisayarlardan doğrudan erişim beklenmez. Aynı bilgisayardaki başka bir süreç loopback portunu tarayabilir ve istek gönderebilir.
- CORS origin kontrolü tarayıcı içindir; yerel native istemci CORS'a uymak zorunda değildir. Portun dinamik olması tahmin edilmesini zorlaştırır ama güvenlik sınırı/token değildir.
- Oynatma/arama/indirme/kütüphane route'larının çoğu bearer token istemez. `/api/library/folders` keyfi yerel dizin yollarını kabul eder ve `/api/library/file` o dizinlerin altındaki dosyaları sunar. Yerel kötü niyetli uygulama açısından risk oluşturur.
- Supabase kullanıcı tokenları auth ve sync işlemlerinde doğrulanır. Supabase anon/publishable key istemci yapılandırmasında saklanır; service-role key'in renderer'da veya Supabase config'te bulunması kaynakta **YOK**.
- Admin GitHub tokenı ve PIN uygulamaya gömülü görünmüyor; Edge Function secrets ortamında kullanılması amaçlanmış. Bu repo incelemesi canlı secret değerlerini doğrulamaz (**DOĞRULANMADI**). Bu konuşma dizisinde kullanıcı tarafından paylaşılmış GitHub tokenlar güvenlik nedeniyle belgeye eklenmedi; kullanılmış veya dışarıya açılmışsa GitHub'dan iptal edilip yenisi üretilmelidir.
- Bunker entegrasyonu için öneri: yalnız loopback'e bind; en az 256-bit kriptografik token; tokenı renderer'a değil Electron main'e ait kullanıcı ACL'li `%APPDATA%\SunifyPlayerData\integration.json` gibi dosyada sakla; tokenı her istekte `Authorization: Bearer` ile gönder; timing-safe karşılaştır, rate-limit ve izinli alan doğrulaması yap. Bu dosya/protokol mevcut Sunify'da **YOK**.

## 9. Paketleme ve dağıtım

- Paketleme: `electron-builder` + Windows x64 NSIS. Komut `npm run build:win`; `dist/Sunify-Setup-<version>.exe` üretir. Tek başına/portable exe hedefi **YOK**.
- `appId=com.sunify.desktop`, `productName=Sunify`, uygulama exe adı varsayılan Electron Builder ürün adından `Sunify.exe` olur. NSIS kullanıcı başına kurulum (`perMachine:false`), kurulum yeri seçilebilir; masaüstü ve Start Menu kısayolları açıktır. Sabit kurulum yolu yok; kullanıcı seçebilir.
- Uygulama ve installer ikonu `build/sunify.ico`. Kurulumda yt-dlp ve Deno `resources/sunify-tools/` içine eklenir. Kullanıcının ayrıca Python/yt-dlp kurması normal paketli playback için gerekmemelidir.
- GitHub sürüm iş akışı ve otomatik güncelleme için `src/build-info.json` repository `Kadir-72I/Sunify`; public release GitHub API ile okunur. Private release indirme/yayınlama Supabase Edge Function üzerinden yapılandırılır.
- Protokol kaydı `sunify://` vardır, fakat yalnız `sunify://auth/callback` e-posta doğrulama URL'si işlenir. `sunify://play?...` veya başka playback deep-link **YOK**.
- Bunker'ın uygulamayı bulup başlatması için kayıt defteri arama API'si **YOK**, Windows App Paths kaydı **DOĞRULANMADI**, sabit exe yolu garanti edilmez. Kurulum yolu değiştirilebilir olduğundan sabit yol varsaymayın. Sunify için özel “play” argümanı da **YOK**. Windows protokol kaydı uygulamayı callback için açabilir; Bunker'ın playback talebi için API değildir.

## 10. Entegrasyon boşluk analizi ve önerilen API

### Şu an eksik olanlar

Sunify'da yerel API altyapısı olsa da Bunker'ın güvenli biçimde kullanması için aşağıdakiler eksik:

1. Sunify'ın seçilen dinamik portunu harici uygulamanın keşfedeceği kararlı yöntem.
2. Harici API için ayrı token kimlik doğrulama ve yetkilendirme.
3. Renderer'ın `currentTrack`/audio state'ini Node main/Express tarafına bildiren köprü.
4. Express'ten renderer'a play/pause/next/previous/seek/volume komut köprüsü.
5. `GET now-playing`, `POST` playback control ve SSE olay kanalı.
6. Uygulamanın aktif değil/kapalı olduğu durumda API lifecycle/connection response sözleşmesi.

Mevcut `/api/stream` ve `/api/audio-stream` ile şarkı URL'si çözülüp ses okunabilir; fakat Bunker'ın Sunify'daki mevcut çalan şarkıyı bulması veya Sunify playback'ini değiştirmesi mümkün değil. Önerilen API route'ları aşağıdaki örnek tasarımdır, kaynak koda henüz eklenmemiştir.

### Önerilen küçük protokol

- Main, Electron `userData` dizininde `integration.json` oluşturur: `{"port":54321,"token":"<32-byte-random-base64url>"}`. Dosya Windows'ta yalnız mevcut Windows kullanıcısına ACL ile sınırlandırılmalıdır. Dosya izinlerinin kodla kurulumu ve ACL doğrulaması mevcut değildir; uygulama eklenirken ayrıca yapılmalı.
- Bunker başlangıçta bu dosyayı okur; API adresi `http://127.0.0.1:<port>/api/launcher`. Token `Authorization: Bearer <token>` olarak gönderilir.
- Mevcut port zaten main'de `app.__sunifyApiPort` üzerinden biliniyor. Bu dosyanın yazımı/yenilenmesi şu an **YOK**.
- API'nin Express içinde çalışması tek başına yeterli değil. Electron main, renderer state IPC'sini alıp `getState()` sağlamalı; komutları `webContents.send` ile renderer'a yollamalı. Renderer bu komutları mevcut audio/queue fonksiyonlarına bağlamalı.

### Örnek Express eklemesi (öneri, mevcut kod değil)

Bu taslak, `startServer({ playbackBridge })` seçeneğine ve main↔renderer IPC köprüsüne göre tamamlanmalıdır. `playbackBridge.getState()` son renderer durumunu döndürür; `.command(action, value)` komutu renderer'a iletir ve renderer kabul edince `true` döndürür; `.on('state', callback)` state değişimlerini Express'e verir. Bu bridge arayüzü örnektir ve Sunify kodunda henüz **YOK**.

```js
// src/server.js içine eklenecek öneri. Token main'de crypto.randomBytes(32)
// ile oluşturulmalı; integration.json yalnız kullanıcı ACL'si ile yazılmalı.
const crypto = require('node:crypto');
let launcherToken = '';
let playbackBridge = null;
const launcherSseClients = new Set();

function attachLauncherIntegration({ token, bridge }) {
  launcherToken = token;
  playbackBridge = bridge;
  bridge.on('state', (state) => {
    const payload = `event: playback\\ndata: ${JSON.stringify(state)}\\n\\n`;
    for (const client of launcherSseClients) client.write(payload);
  });
}

function requireLauncherToken(req, res, next) {
  const supplied = (req.headers.authorization || '').replace(/^Bearer\\s+/i, '');
  const expected = Buffer.from(launcherToken);
  const actual = Buffer.from(supplied);
  if (!launcherToken || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/api/launcher', requireLauncherToken);
app.get('/api/launcher/now-playing', (_req, res) => {
  res.json(playbackBridge.getState());
});
app.post('/api/launcher/:action', async (req, res) => {
  const { action } = req.params;
  if (!['play', 'pause', 'next', 'previous', 'seek', 'volume'].includes(action)) {
    return res.status(404).json({ error: 'Unknown command' });
  }
  if (action === 'volume' && (!Number.isFinite(req.body?.value) || req.body.value < 0 || req.body.value > 1)) {
    return res.status(400).json({ error: 'value must be between 0 and 1' });
  }
  if (action === 'seek' && (!Number.isFinite(req.body?.seconds) || req.body.seconds < 0)) {
    return res.status(400).json({ error: 'seconds must be non-negative' });
  }
  const accepted = await playbackBridge.command(action, req.body || {});
  if (!accepted) return res.status(409).json({ error: 'Playback command unavailable' });
  res.status(202).json({ accepted: true, action });
});
app.get('/api/launcher/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(`event: playback\\ndata: ${JSON.stringify(playbackBridge.getState())}\\n\\n`);
  launcherSseClients.add(res);
  req.on('close', () => launcherSseClients.delete(res));
});
```

`crypto.randomBytes(32).toString('base64url')` token minting main process'te yapılmalıdır. Yukarıdaki kod `attachLauncherIntegration` çağrısını ve HTTP server'ın sadece 127.0.0.1 bind etmesini gerektirir. Body örnekleri:

```http
GET /api/launcher/now-playing HTTP/1.1
Host: 127.0.0.1:54321
Authorization: Bearer <token>
```

```json
{"playing":true,"track":{"id":"abcdefghijk","title":"Track","artist":"Artist","album":"Album","artworkUrl":"https://...","durationSeconds":210},"positionSeconds":42.5,"volume":0.8,"shuffle":false,"repeat":false}
```

```http
POST /api/launcher/volume HTTP/1.1
Host: 127.0.0.1:54321
Authorization: Bearer <token>
Content-Type: application/json

{"value":0.65}
```

```json
{"accepted":true,"action":"volume"}
```

Diğer önerilen kontroller:

| İstek | JSON gövdesi | Yanıt |
|---|---|---|
| `POST /api/launcher/play` | `{"trackId":"abcdefghijk"}` veya `{"query":"Artist Track"}` | `{"accepted":true,"action":"play"}` |
| `POST /api/launcher/pause` | `{}` | `{"accepted":true,"action":"pause"}` |
| `POST /api/launcher/next` | `{}` | `{"accepted":true,"action":"next"}` |
| `POST /api/launcher/previous` | `{}` | `{"accepted":true,"action":"previous"}` |
| `POST /api/launcher/seek` | `{"seconds":75.0}` | `{"accepted":true,"action":"seek"}` |
| `POST /api/launcher/volume` | `{"value":0.65}` (`0..1`) | `{"accepted":true,"action":"volume"}` |
| `GET /api/launcher/events` | Bearer token; SSE | `event: playback` ardından yukarıdaki durum JSON'u; her state değişiminde tekrar gönderilir. |

Örnek SSE frame:

```text
event: playback
data: {"playing":true,"track":{"id":"abcdefghijk","title":"Track","artist":"Artist","durationSeconds":210},"positionSeconds":43,"volume":0.65,"shuffle":false,"repeat":false}

```

Play endpoint'inin mevcut arayüzle hangi playlist/kuyruk bağlamını kullanacağı ürün kararıdır (**DOĞRULANMADI**). Öneri olarak yalnız `trackId`/`query` ile arama ve oynatma uygulanabilir; kaynaktaki `playSelectedTrack` şu anda modül dışına açılmamıştır.

## Launcher'dan Sunify'a bağlanmak için bilinmesi gereken her şey

**Şu anki kodda:** `http://127.0.0.1:<dinamik-port>/api`; port renderer URL sorgusuna aktarılır, fakat Bunker için keşif dosyası/token **YOK**. `/api/diagnostics` port döndürür, fakat launcher'ın Sunify içindeki endpoint'e erişmek için portu bilmesi gerekir. `/api/stream` ses URL'si çözebilir, `/api/audio-stream` audio proxy'sidir; `now-playing`, playback kontrolü ve olay kanalı **YOK**. Şu an mevcut endpoint'ler Bunker entegrasyonunu tamamlamaya yetmez.

**Önerilen son sözleşme:** kullanıcı ACL'li `%APPDATA%\SunifyPlayerData\integration.json` içinden `port` ve rastgele `token` keşfi; loopback HTTP; `Authorization: Bearer <token>`; `GET /api/launcher/now-playing`; `POST /api/launcher/play|pause|next|previous|seek|volume`; `GET /api/launcher/events` (SSE, `playback` event). Bu tasarım uygulanmadığı için Bunker geliştiricisi henüz bu endpoint'lere istek göndermemelidir.

## Dikkat edilmesi gerekenler

1. Port `0` ile dinamik seçiliyor; sabit port veya launcher discovery dosyası yok. Ayrıca `EADDRINUSE` fallback kolu yeni portu `app.locals.port`'a koysa da `options.onReady(actualPort)` çağırmıyor; Electron main renderer'ı başlatamayabilir. Kaynaktaki gerçek hata/risk.
2. CORS local API için auth değildir. Native Bunker istemcisi mevcut yetkisiz rotalara doğrudan erişebilir.
3. `/api/library/folders`, `/api/library/file`, `/api/download`, `/api/save-track-locally`, `/api/stream` gibi hassas yerel/medya işlemlerinde genel token koruması yok.
4. `GET /api/stream` paketli yt-dlp'nin ham JSON'unu döndürebilir; Python fallback'i sadece seçili alanları döndürür. Response şekli bu sebeple iki runtime'da aynı garanti edilmemiştir.
5. Playlist importta Python `yt_dlp` importu, paketlenmiş yt-dlp executable yolunu kullanmıyor; yeni kurulumda Python yoksa fallback davranışı test edilmelidir.
6. Discord client ID `src/config.js` ile RPC modüllerinde farklı; ayrıca aynı Discord IPC'ye yazan iki ayrı servis var. Tek implementation seçilip doğrulanmalı.
7. `/api/auth/register` önce yerel user kaydı yazar, sonra cloud sign-up dener; cloud başarısız olsa da local account ile başarı dönebilir. Launcher cloud hesabı varmış gibi varsaymamalı.
8. `/api/auth/logout`, Supabase client `signOut` çağırmıyor; yalnızca local session token iptal edilir.
9. Renderer state'i dışarı açılmadığı için HTTP ile kontrol/now-playing endpoint'i tasarlamak main↔renderer IPC köprüsü gerektirir; sadece Express route eklemek yeterli değildir.
10. Şarkı akışı YouTube'a/harici sağlayıcıya bağlı, URL geçici olabilir ve internet gerekir. Bunker'a `/api/stream` URL'sini kalıcı medya URL'si olarak saklatmayın.
11. Kurulum yolu özelleştirilebilir; Bunker'ın sabit `Program Files` yolunu varsayması güvenilir değildir. Uygulama kayıt defteri kaydı/özel launch argument'i kaynakta tanımlı değil.
