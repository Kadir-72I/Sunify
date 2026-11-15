// server.js
const express = require('express');
const cors = require('cors');
const ytSearch = require('yt-search');
const axios = require('axios');
const dns = require('dns');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Windows BoringSSL EPROTO / IPv6 handshake hatasını kalıcı olarak engelle
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

const { fetchLyrics } = require('./services/audio/lyricsService');
const { cleanTrackMetadata } = require('./services/audio/metadataCleaner');
const { getDirectAudioUrl } = require('./services/audio/streamProxy');
const { updateDiscordPresence, clearDiscordPresence } = require('./services/rpc/discordRpcService');
const {
  getSupabase,
  isConfigured,
  saveConfig,
  currentConfig,
} = require('./services/auth/supabaseClient');
const {
  registerUser,
  loginUser,
  getUserData,
  saveUserData,
} = require('./services/auth/localAuthService');
const logger = require('./utils/logger');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Discord RPC Güncelleme Uç Noktası
app.post('/api/discord-rpc', (req, res) => {
  const { track, position, duration, isPlaying } = req.body;
  if (!track) {
    clearDiscordPresence();
  } else {
    updateDiscordPresence(track, position, duration, isPlaying);
  }
  res.json({ success: true });
});

// YouTube Arama
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Query q is required' });

  try {
    const searchResults = await ytSearch(query);
    const videos = (searchResults.videos || []).slice(0, 25).map((video) => {
      const cleaned = cleanTrackMetadata(video.title, video.author?.name || '');
      return {
        id: video.videoId,
        title: cleaned.title || video.title,
        rawTitle: video.title,
        artist: cleaned.artist || video.author?.name || 'Bilinmeyen Sanatçı',
        thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
        duration: video.seconds,
        timestamp: video.timestamp,
        views: video.views,
        url: video.url,
      };
    });

    res.json({ results: videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// YouTube Audio Stream URL
app.get('/api/stream', async (req, res) => {
  const { id, q } = req.query;
  const target = id || q;
  if (!target) return res.status(400).json({ error: 'Video ID veya Query required' });

  try {
    const streamData = await getDirectAudioUrl(target);
    res.json(streamData);
  } catch (err) {
    res.status(500).json({ error: 'Ses akışı alınamadı: ' + err.message });
  }
});

// LRCLIB ve Çoklu Şarkı Sözleri (Seçilebilir Kaynak)
app.get('/api/lyrics', async (req, res) => {
  const { title, artist, duration, source } = req.query;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const result = await fetchLyrics(title, artist, duration, source || 'auto');
  res.json(result);
});

// Şarkı Kapak Resmi Bulucu (iTunes / Apple Music 600x600 HD + YouTube Music Fallback)
const coverCache = new Map();
async function fetchTrackCover(artist, title) {
  const cleanTerm = `${artist || ''} ${title || ''}`
    .replace(/[><\-_()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const key = cleanTerm.toLowerCase();
  if (coverCache.has(key)) return coverCache.get(key);

  // 1. iTunes HD Kapak
  try {
    const itunesRes = await axios.get('https://itunes.apple.com/search', {
      params: { term: cleanTerm, entity: 'song', limit: 1 },
      timeout: 3000,
    });
    const art = itunesRes.data?.results?.[0]?.artworkUrl100?.replace('100x100bb', '600x600bb');
    if (art) {
      coverCache.set(key, art);
      return art;
    }
  } catch (e) {}

  // 2. YouTube Music / Video Kapak Fallback
  try {
    const ytRes = await ytSearch(cleanTerm);
    const thumb = ytRes?.videos?.[0]?.thumbnail;
    if (thumb) {
      coverCache.set(key, thumb);
      return thumb;
    }
  } catch (e) {}

  return null;
}

// Çalma Listesi İçe Aktarma
app.post('/api/import-playlist', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    if (url.includes('youtube.com/playlist') || url.includes('list=')) {
      const listIdMatch = url.match(/[?&]list=([^&]+)/);
      const listId = listIdMatch ? listIdMatch[1] : null;

      if (!listId) return res.status(400).json({ error: 'Geçersiz YouTube Çalma Listesi URL' });

      const playlistData = await ytSearch({ listId });
      const tracks = (playlistData.videos || []).map((v) => {
        const cleaned = cleanTrackMetadata(v.title, v.author?.name || '');
        return {
          id: v.videoId,
          title: cleaned.title || v.title,
          artist: cleaned.artist || v.author?.name || 'Sanatçı',
          thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
          duration: v.duration?.seconds || 180,
        };
      });

      return res.json({
        id: 'pl_' + Date.now(),
        name: playlistData.title || 'İçe Aktarılan Liste',
        author: playlistData.author?.name || 'YouTube',
        thumbnail: tracks[0]?.thumbnail || '',
        tracks,
      });
    }

    if (url.includes('spotify.com/playlist/')) {
      const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
      const playlistId = match ? match[1] : null;

      if (!playlistId) {
        return res.status(400).json({ error: 'Geçersiz Spotify Çalma Listesi URL' });
      }

      let playlistTitle = 'Spotify Çalma Listesi';
      let thumbnail = '';
      let tracks = [];

      try {
        // 1. Spotify Embed Sayfasından tüm parçaları al (API key gerektirmez)
        const embedRes = await axios.get(`https://open.spotify.com/embed/playlist/${playlistId}`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          timeout: 10000,
        });

        const nextDataMatch = embedRes.data.match(
          /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
        );
        if (nextDataMatch) {
          const nextData = JSON.parse(nextDataMatch[1]);
          const entity = nextData?.props?.pageProps?.state?.data?.entity;

          if (entity) {
            playlistTitle = entity.title || entity.name || playlistTitle;

            // Kapak resmi
            if (entity.visualIdentity?.image?.[0]?.url) {
              thumbnail = entity.visualIdentity.image[0].url;
            }

            // Listedeki tüm parçaları tara ve eşleme bilgilerini ekle
            const rawTracks = entity.trackList || [];
            tracks = rawTracks.map((item, index) => {
              const trackTitle = item.title || item.name || `Parça ${index + 1}`;
              const artistName =
                item.subtitle ||
                (item.artists ? item.artists.map((a) => a.name).join(', ') : 'Bilinmeyen Sanatçı');
              const durationSec = item.duration ? Math.round(item.duration / 1000) : 180;
              const searchQuery = `${artistName} - ${trackTitle}`;

              return {
                id: '', // Dinlenirken YouTube üzerinde anlık sorgulanıp akışı açılır
                query: searchQuery,
                title: trackTitle,
                artist: artistName,
                explicit: !!item.isExplicit,
                duration: durationSec,
                thumbnail: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
              };
            });

            // Listedeki TÜM şarkıların gerçek kapaklarını 8'li gruplar halinde paralel çek
            const batchSize = 8;
            for (let i = 0; i < tracks.length; i += batchSize) {
              const batch = tracks.slice(i, i + batchSize);
              await Promise.all(
                batch.map(async (t) => {
                  const realCover = await fetchTrackCover(t.artist, t.title);
                  if (realCover) t.thumbnail = realCover;
                })
              );
            }
          }
        }
      } catch (embedErr) {
        console.warn('Spotify embed parse hatası, oEmbed deneniyor:', embedErr.message);
      }

      // Eğer embed başarısız olduysa veya kapak eksikse oEmbed yedeklemesi
      if (!thumbnail || tracks.length === 0) {
        try {
          const oembedRes = await axios.get(
            `https://open.spotify.com/oembed?url=https://open.spotify.com/playlist/${playlistId}`
          );
          if (oembedRes.data) {
            if (!playlistTitle || playlistTitle === 'Spotify Çalma Listesi') {
              playlistTitle = oembedRes.data.title || playlistTitle;
            }
            if (!thumbnail) {
              thumbnail = oembedRes.data.thumbnail_url || '';
            }
          }
        } catch (oembedErr) {
          console.warn('Spotify oEmbed hatası:', oembedErr.message);
        }
      }

      return res.json({
        id: 'pl_' + Date.now(),
        name: playlistTitle,
        author: 'Spotify Aktarımı',
        thumbnail:
          thumbnail || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300',
        tracks: tracks,
      });
    }

    return res.status(400).json({ error: 'Desteklenmeyen çalma listesi bağlantısı.' });
  } catch (err) {
    res.status(500).json({ error: 'İçe aktarma hatası: ' + err.message });
  }
});

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// İndirilen Şarkılar Statik Erişimi
app.use('/downloaded', express.static(DOWNLOADS_DIR));

// Tüm Cihazdaki Müzik Dosyalarını Otomatik Tara (.mp3, .m4a, .flac, .wav, .ogg, .aac, .wma)
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.wma']);

function scanDirectoryForMusic(dirPath, maxDepth = 3, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  let found = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const ent of entries) {
      if (
        ent.name.startsWith('.') ||
        ent.name.startsWith('$') ||
        ent.name === 'node_modules' ||
        ent.name === 'AppData'
      )
        continue;
      const full = path.join(dirPath, ent.name);
      if (ent.isDirectory()) {
        found = found.concat(scanDirectoryForMusic(full, maxDepth, currentDepth + 1));
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          // Çok küçük sistem seslerini (örn 50KB altı click sesleri) filtrele
          try {
            const stat = fs.statSync(full);
            if (stat.size > 200000) {
              // En az 200 KB
              found.push({
                name: ent.name,
                fullPath: full,
                size: stat.size,
              });
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
  return found;
}

// Yerel İndirilen ve Cihazdaki Tüm Şarkıları Listele
app.get('/api/local-downloads', (req, res) => {
  try {
    const userHome = os.homedir();
    const scanDirs = [
      DOWNLOADS_DIR,
      path.join(userHome, 'Music'),
      path.join(userHome, 'Downloads'),
      path.join(userHome, 'Desktop'),
    ];

    const seenPaths = new Set();
    const allFiles = [];

    for (const d of scanDirs) {
      if (fs.existsSync(d)) {
        const filesInDir = scanDirectoryForMusic(d, 3);
        for (const f of filesInDir) {
          if (!seenPaths.has(f.fullPath)) {
            seenPaths.add(f.fullPath);
            allFiles.push(f);
          }
        }
      }
    }

    const tracks = allFiles.map((fileObj, idx) => {
      const ext = path.extname(fileObj.name);
      const nameWithoutExt = fileObj.name.replace(new RegExp(`\\${ext}$`), '');
      const parts = nameWithoutExt.split(' - ');
      const artist = parts.length > 1 ? parts[0].trim() : 'Yerel Sanatçı';
      const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : parts[0].trim();

      // Electron ve yerel tarayıcı için yerel dosya URL'si
      const safeLocalUrl = 'file:///' + fileObj.fullPath.replace(/\\/g, '/');

      return {
        id: 'local_' + idx,
        title,
        artist,
        localFile: fileObj.name,
        localUrl: safeLocalUrl,
        thumbnail: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        duration: 210,
        isLocal: true,
      };
    });

    res.json({ tracks });
  } catch (e) {
    res.json({ tracks: [] });
  }
});

// Otomatik Optimize Yerel İndirme Uç Noktası (Arka planda doğrudan downloads/ klasörüne kaydeder)
app.post('/api/save-track-locally', async (req, res) => {
  const { title, artist, id, query } = req.body;
  const target = id || query || `${artist || ''} ${title || ''}`;
  if (!target.trim()) return res.status(400).json({ error: 'Parça bilgisi gerekli' });

  try {
    const streamData = await getDirectAudioUrl(target);
    if (!streamData.url) {
      return res.status(404).json({ error: 'Ses akışı bulunamadı' });
    }

    const safeTitle = (title || streamData.title || 'Parça').replace(/[/\\?%*:|"<>]/g, '_').trim();
    const safeArtist = (artist || '').replace(/[/\\?%*:|"<>]/g, '_').trim();
    const fileName = safeArtist ? `${safeArtist} - ${safeTitle}.mp3` : `${safeTitle}.mp3`;
    const filePath = path.join(DOWNLOADS_DIR, fileName);

    // Eğer zaten indirilmişse hemen başarılı dön
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 100000) {
      return res.json({
        success: true,
        alreadyExists: true,
        fileName,
        localUrl: `http://localhost:${PORT}/downloaded/${encodeURIComponent(fileName)}`,
      });
    }

    const response = await axios({
      method: 'get',
      url: streamData.url,
      responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    writer.on('finish', () => {
      res.json({
        success: true,
        fileName,
        localUrl: `http://localhost:${PORT}/downloaded/${encodeURIComponent(fileName)}`,
      });
    });

    writer.on('error', (err) => {
      res.status(500).json({ error: 'Yazma hatası: ' + err.message });
    });
  } catch (err) {
    res.status(500).json({ error: 'İndirme hatası: ' + err.message });
  }
});

// Gemini Yapay Zeka Destekli Akıllı Mix Analizi (Gemini 2.0 / 2.5 Flash Lite Modeli)
app.post('/api/ai-mix', async (req, res) => {
  const { detailedStats, recentTracks, apiKey } = req.body;
  const userKey = apiKey || process.env.GEMINI_API_KEY;

  if (!userKey) {
    return res.status(400).json({
      error:
        'Gemini API anahtarı bulunamadı. Lütfen Ayarlar > Gemini AI sekmesinden API anahtarınızı girin.',
    });
  }

  // Kullanıcının detaylı dinleme istatistikleri (kaç kere dinlendi, ne kadar süre dinlendi, hangi günlerde, kaç playliste eklendi)
  let statsSummaryText = '';
  if (detailedStats && Object.keys(detailedStats).length > 0) {
    statsSummaryText = Object.values(detailedStats)
      .slice(0, 20)
      .map(
        (s) =>
          `• "${s.artist} - ${s.title}": ${s.playCount || 1} kez çalındı, toplam ${Math.round((s.totalSeconds || 0) / 60)} dakika dinlendi, dinlenen günler: [${(s.days || []).join(', ')}], ${s.inPlaylistsCount || 0} farklı çalma listesinde ekli.`
      )
      .join('\n');
  } else {
    statsSummaryText =
      (recentTracks || [])
        .slice(0, 15)
        .map((t) => `• ${t.artist} - ${t.title}`)
        .join('\n') || "Her's - Harvey\n2hollis - poster boy\nSidney Gish - Impostor Syndrome";
  }

  const prompt = `Sen Sunify müzik uygulamasının profesyonel yapay zeka müzik küratörüsün.
Aşağıda kullanıcının dinlediği şarkılar, şarkıları toplam kaç kez dinlediği, ne kadar süre geçirdiği, haftanın hangi günlerinde dinlediği ve kaç çalma listesine eklediği gibi zengin dinleme metrikleri bulunmaktadır:

Kullanıcı Dinleme & Etkileşim Verileri:
${statsSummaryText}

GÖREV:
1. Kullanıcının tekrar tekrar dinlediği, yüksek süre ayırdığı ve çalma listelerine aldığı şarkıları baz alarak kullanıcının gerçek müzik tarzını (indie, shoegaze, alternative rock, hyperpop, lo-fi vs.) ve dinleme ruh halini analiz et.
2. Bu analize dayanarak kullanıcının bayılacağı 6 adet özel ve tutarlı şarkı önerisi oluştur.

SADECE aşağıdaki saf JSON formatında yanıt ver (markdown veya \`\`\`json etiketleri OLMADAN, doğrudan JSON):
{
  "analysis": "Kullanıcının müzik tarzına, dinleme alışkanlıklarına ve günlerine dair 1-2 cümlelik akıllı özet",
  "recommendations": [
    { "title": "Şarkı Adı", "artist": "Sanatçı Adı" },
    { "title": "Şarkı Adı", "artist": "Sanatçı Adı" },
    { "title": "Şarkı Adı", "artist": "Sanatçı Adı" },
    { "title": "Şarkı Adı", "artist": "Sanatçı Adı" },
    { "title": "Şarkı Adı", "artist": "Sanatçı Adı" },
    { "title": "Şarkı Adı", "artist": "Sanatçı Adı" }
  ]
}`;

  // Gemini 3.5 Flash Lite Modeli (ve fallback modeller)
  const candidateModels = [
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
  ];

  let candidateText = '';
  let lastError = null;

  for (const model of candidateModels) {
    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${userKey}`;
      const geminiRes = await axios.post(
        geminiUrl,
        {
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
        }
      );

      candidateText = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (candidateText) break; // Başarılı olduysa döngüyü tamamla
    } catch (e) {
      lastError = e;
      // Diğer modele geç
    }
  }

  if (!candidateText) {
    return res.status(500).json({
      error:
        'Gemini analizi başarısız: ' +
        (lastError?.response?.data?.error?.message || lastError?.message || 'Bağlantı kurulamadı'),
    });
  }

  try {
    const cleanJson = candidateText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    const parsedData = JSON.parse(cleanJson);

    // Önerilen şarkılara kapak resmi ve arama sorgusu ekle
    const enrichedTracks = await Promise.all(
      (parsedData.recommendations || []).map(async (item) => {
        const cover = await fetchTrackCover(item.artist, item.title);
        return {
          id: '',
          query: `${item.artist} - ${item.title}`,
          title: item.title,
          artist: item.artist,
          thumbnail: cover || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
          duration: 195,
        };
      })
    );

    res.json({
      success: true,
      analysis: parsedData.analysis,
      tracks: enrichedTracks,
    });
  } catch (parseErr) {
    res.status(500).json({ error: 'Yapay zeka yanıtı çözümlenemedi: ' + parseErr.message });
  }
});
app.get('/api/download', async (req, res) => {
  const { id, q, title, artist } = req.query;
  const target = id || q || `${artist || ''} ${title || ''}`;
  if (!target.trim()) return res.status(400).json({ error: 'Parça bilgisi gerekli' });

  try {
    const streamData = await getDirectAudioUrl(target);
    if (!streamData.url) {
      return res.status(404).json({ error: 'İndirilecek ses akışı bulunamadı' });
    }

    const safeTitle = (title || streamData.title || 'Sunify_Track').replace(/[/\\?%*:|"<>]/g, '_');
    const safeArtist = (artist || '').replace(/[/\\?%*:|"<>]/g, '_');
    const filename = safeArtist ? `${safeArtist} - ${safeTitle}.m4a` : `${safeTitle}.m4a`;

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'audio/mp4');

    const audioStream = await axios({
      method: 'get',
      url: streamData.url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });

    audioStream.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'İndirme hatası: ' + err.message });
  }
});

// Görselden Baskın Renk Çıkarma (Şarkı Sözü Arka Planı İçin)
app.get('/api/extract-color', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.json({ rgb: [234, 179, 8], hex: '#eab308' });

  try {
    const Vibrant = require('node-vibrant');
    const palette = await Vibrant.from(imageUrl).getPalette();
    const dominant =
      palette.Vibrant || palette.DarkVibrant || palette.Muted || palette.LightVibrant;
    if (dominant) {
      return res.json({
        rgb: dominant.rgb.map(Math.round),
        hex: dominant.hex,
      });
    }
    res.json({ rgb: [234, 179, 8], hex: '#eab308' });
  } catch (err) {
    res.json({ rgb: [234, 179, 8], hex: '#eab308' });
  }
});

// ==========================================
// SUPABASE AUTH & CLOUD SYNC API ENDPOINTS
// ==========================================

// Supabase Yapılandırmasını Alma / Kaydetme
app.get('/api/auth/config', (req, res) => {
  res.json({
    isConfigured: isConfigured(),
    url: currentConfig.url || '',
  });
});

app.post('/api/auth/config', (req, res) => {
  const { url, anonKey } = req.body;
  if (!url || !anonKey) {
    return res.status(400).json({ error: 'URL ve Anon Key zorunludur' });
  }
  saveConfig(url, anonKey);
  res.json({ success: true, isConfigured: isConfigured() });
});

// Kayıt Olma (Sign Up)
app.post('/api/auth/register', async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-posta ve şifre zorunludur.' });
  }

  // 1. Önce doğrudan yerel güvenli hesap veritabanına kaydet (E-posta doğrulama veya rate-limit beklemeden ANINDA giriş)
  let localSession;
  try {
    localSession = registerUser(username, email, password);
  } catch (err) {
    // Zaten varsa login yapmayı dene
    try {
      localSession = loginUser(email, password);
    } catch (loginErr) {
      return res.status(400).json({ error: err.message });
    }
  }

  // 2. Arka planda sessizce Supabase'e senkronize etmeyi dene (Hata verse bile kullanıcı engellenmez)
  const supabase = getSupabase();
  if (supabase && isConfigured()) {
    supabase.auth
      .signUp({
        email,
        password,
        options: { data: { username: username || email.split('@')[0] } },
      })
      .catch(() => {});
  }

  return res.json({ success: true, user: localSession.user, session: localSession });
});

// Giriş Yapma (Sign In)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-posta ve şifre zorunludur.' });
  }

  // 1. Önce yerel veritabanında doğrula
  try {
    const session = loginUser(email, password);
    return res.json({ success: true, user: session.user, session: session });
  } catch (localErr) {
    // 2. Yerelde bulunamadıysa Supabase bulutunda dene
    const supabase = getSupabase();
    if (supabase && isConfigured()) {
      try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (!error && data.session) {
          // Yerel veritabanına da kopyala
          try {
            registerUser(data.user.user_metadata?.username || email.split('@')[0], email, password);
          } catch (e) {}
          return res.json({ success: true, user: data.user, session: data.session });
        }
      } catch (e) {}
    }

    return res
      .status(400)
      .json({ error: 'E-posta veya şifre hatalı. Lütfen bilgilerinizi kontrol edin.' });
  }
});

// Bulut / Yerel Senkronizasyonu: Kullanıcının Verilerini İndir
app.get('/api/sync/pull', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme tokenı eksik' });

  const token = authHeader.replace('Bearer ', '');

  // Yerel oturum mu?
  if (token.startsWith('local_token_')) {
    const parts = token.split('_');
    const userId = parts[2] ? parts[2] + '_' + parts[3] : '';
    const data = getUserData(userId);
    return res.json(
      data || { playlists: [], analytics: { liked_tracks: [], listening_stats: {} } }
    );
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(400).json({ error: 'Supabase aktif değil.' });

  try {
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Geçersiz oturum' });

    // Çalma listelerini çek
    const { data: playlists } = await supabase
      .from('user_playlists')
      .select('*')
      .eq('user_id', user.id);

    // Dinleme analitiği ve beğenileri çek
    const { data: analytics } = await supabase
      .from('user_analytics')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    res.json({
      playlists: playlists || [],
      analytics: analytics || { liked_tracks: [], listening_stats: {} },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulut / Yerel Senkronizasyonu: Yerel Verileri Gönder (Push)
app.post('/api/sync/push', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme tokenı eksik' });

  const token = authHeader.replace('Bearer ', '');
  const { playlists, likedTracks, listeningStats } = req.body;

  // Yerel oturum mu?
  if (token.startsWith('local_token_')) {
    const parts = token.split('_');
    const userId = parts[2] ? parts[2] + '_' + parts[3] : '';
    saveUserData(userId, { playlists, likedTracks, listeningStats });
    return res.json({ success: true, message: 'Yerel kullanıcı verileri eşitlendi.' });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(400).json({ error: 'Supabase aktif değil.' });

  try {
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Geçersiz oturum' });

    // Çalma listelerini eşitle
    if (Array.isArray(playlists)) {
      for (const pl of playlists) {
        if (!pl.name) continue;
        await supabase
          .from('user_playlists')
          .upsert({
            user_id: user.id,
            name: pl.name,
            cover_url: pl.cover || '',
            tracks: pl.tracks || [],
            created_at: pl.created_at || new Date(),
          })
          .catch(() => {});
      }
    }

    // Analitik & Beğenileri eşitle
    await supabase
      .from('user_analytics')
      .upsert({
        user_id: user.id,
        liked_tracks: likedTracks || [],
        listening_stats: listeningStats || {},
        updated_at: new Date(),
      })
      .catch(() => {});

    res.json({ success: true, message: 'Bulut senkronizasyonu tamamlandı.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let serverInstance = null;
function startServer(cb) {
  serverInstance = app.listen(PORT, () => {
    console.log(`Sunify Core Server çalışıyor: http://localhost:${PORT}`);
    if (cb) cb();
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, app };
