// server.js
const express = require('express');
const ytSearch = require('yt-search');
const axios = require('axios');
const dns = require('dns');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Windows BoringSSL EPROTO / IPv6 handshake hatasını kalıcı olarak engelle
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

const { fetchLyrics } = require('./services/audio/lyricsService');
const { cleanTrackMetadata } = require('./services/audio/metadataCleaner');
const { getDirectAudioUrl, getRuntimeStatus } = require('./services/audio/streamProxy');
const { updateDiscordPresence, clearDiscordPresence } = require('./services/rpc/discordRpcService');
const { getLatestRelease } = require('./services/updateService');
const {
  getSupabase,
  getSupabaseForToken,
  isConfigured,
  saveConfig,
  currentConfig,
} = require('./services/auth/supabaseClient');
const {
  registerUser,
  loginUser,
  getUserData,
  saveUserData,
  getUserIdForToken,
  revokeSession,
} = require('./services/auth/localAuthService');

const app = express();
const PORT = Number(process.env.PORT) || 0;
const HOST = '127.0.0.1';
const TRUSTED_ORIGINS = new Set(['null', 'file://', `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const ALLOWED_MUSIC_DIRS = new Set();
const RATE_LIMITS = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !TRUSTED_ORIGINS.has(origin)) return res.status(403).json({ error: 'İstek kaynağına izin verilmiyor.' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Pin,Range');
  res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges,Content-Length,Content-Range,Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const current = RATE_LIMITS.get(key) || { count: 0, resetAt: now + 60_000 };
  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + 60_000;
  }
  current.count += 1;
  RATE_LIMITS.set(key, current);
  if (current.count > 120) return res.status(429).json({ error: 'Çok fazla istek; lütfen biraz bekleyin.' });
  next();
});

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

app.get('/api/diagnostics', async (req, res) => {
  res.json({ pythonAudio: await getRuntimeStatus(), server: 'ready', port: app.locals.port || PORT });
});

app.get('/api/updates/latest', async (_req, res) => {
  try {
    res.json(await getLatestRelease(require('../package.json').version, currentConfig));
  } catch (error) {
    res.status(error.response?.status || 502).json({
      error: 'Güncelleme bilgisi alınamadı.',
      detail: error.response?.data?.error || (error.response?.status === 404
        ? 'GitHub Releases deposu bulunamadı veya henüz sürüm yayımlanmadı. Özel depolar için yeni sunify-admin Edge Function sürümünü dağıtın.'
        : error.message),
    });
  }
});

app.post('/api/admin', async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Supabase bağlantısı yapılandırılmamış.' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Admin isteği geçersiz.' });
  }
  const action = String(req.body.action || '');
  if (!['admin-login', 'list-users', 'get-user-data', 'delete-user', 'publish-release'].includes(action)) {
    return res.status(400).json({ error: 'Admin işlemi tanınmıyor.' });
  }
  try {
    const response = await axios.post(`${currentConfig.url}/functions/v1/sunify-admin`, req.body, {
      headers: {
        apikey: currentConfig.anonKey,
        Authorization: req.headers.authorization || `Bearer ${currentConfig.anonKey}`,
        'x-admin-pin': String(req.headers['x-admin-pin'] || req.body.pin || ''),
        'Content-Type': 'application/json',
      },
      timeout: 25_000,
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    const status = error.response?.status || 502;
    res.status(status).json(error.response?.data || { error: 'Admin sunucusuna erişilemedi.' });
  }
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

// Contextual song recommendations used by playlist details and smart queue.
app.get('/api/recommendations', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 240);
  if (!query) return res.status(400).json({ error: 'Öneri sorgusu gerekli.' });
  try {
    const result = await ytSearch(query);
    const tracks = (result.videos || []).slice(0, 18).map((video) => {
      const cleaned = cleanTrackMetadata(video.title, video.author?.name || '');
      return {
        id: video.videoId,
        title: cleaned.title || video.title,
        artist: cleaned.artist || video.author?.name || 'Bilinmeyen Sanatçı',
        thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
        duration: video.seconds || 0,
        query: `${cleaned.artist || video.author?.name || ''} ${cleaned.title || video.title}`.trim(),
      };
    });
    res.json({ tracks });
  } catch (error) {
    res.status(502).json({ error: `Öneriler alınamadı: ${error.message}` });
  }
});
// YouTube public playlist search for the global search overlay.
app.get('/api/search/playlists', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 120);
  if (!query) return res.status(400).json({ error: 'Query q is required' });
  try {
    const result = await ytSearch(query);
    const playlists = (result.playlists || []).slice(0, 12).map((playlist) => ({
      id: playlist.listId || playlist.playlistId || playlist.id,
      title: playlist.title || 'Çalma listesi',
      author: playlist.author?.name || playlist.author || 'YouTube',
      thumbnail: playlist.thumbnail || playlist.image || '',
      size: playlist.size || playlist.videoCount || '',
      url: playlist.url || (playlist.listId || playlist.playlistId ? `https://www.youtube.com/playlist?list=${playlist.listId || playlist.playlistId}` : ''),
    })).filter((playlist) => playlist.id && playlist.url);
    return res.json({ playlists });
  } catch (error) {
    return res.status(502).json({ error: `Playlist araması başarısız: ${error.message}` });
  }
});

// Shared public chart: aggregate anonymous play events, never expose per-user analytics.
app.post('/api/discover/play', async (req, res) => {
  const { track } = req.body || {};
  if (!track || typeof track !== 'object' || !String(track.id || '').trim() || !String(track.title || '').trim()) {
    return res.status(400).json({ error: 'Geçerli şarkı bilgisi gerekli.' });
  }
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ error: 'Ortak dinlenme listesi için Supabase yapılandırılmalı.' });
  try {
    const { error } = await supabase.rpc('record_sunify_play', {
      track_id: String(track.id).slice(0, 200),
      track_title: String(track.title).slice(0, 300),
      track_artist: String(track.artist || '').slice(0, 300),
      track_thumbnail: String(track.thumbnail || '').slice(0, 1000),
    });
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    return res.status(503).json({ error: `Ortak dinleme kaydı hazır değil: ${error.message}` });
  }
});

app.get('/api/discover/top', async (req, res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
  const supabase = getSupabase();
  if (!supabase) return res.json({ tracks: [], unavailable: true });
  try {
    const { data, error } = await supabase.rpc('get_sunify_global_top', { result_limit: limit });
    if (error) throw error;
    return res.json({ tracks: Array.isArray(data) ? data : [] });
  } catch (error) {
    console.warn('Sunify global chart is unavailable:', error.message);
    return res.json({ tracks: [], unavailable: true });
  }
});

// Artist profiles, discography and artwork from the public iTunes catalog.
app.get('/api/artists/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 120);
  if (!query) return res.status(400).json({ error: 'Query q is required' });

  try {
    const response = await axios.get('https://itunes.apple.com/search', {
      params: { term: query, entity: 'musicArtist', limit: 8 },
      timeout: 10000,
    });
    const artists = await Promise.all((response.data.results || []).slice(0, 6).map(async (artist) => {
      let image = '';
      try {
        const albumResponse = await axios.get('https://itunes.apple.com/search', {
          params: { term: artist.artistName, entity: 'album', limit: 1 },
          timeout: 8000,
        });
        image = albumResponse.data.results?.[0]?.artworkUrl100?.replace('100x100bb', '600x600bb') || '';
      } catch (error) {}
      return {
        id: artist.artistId,
        name: artist.artistName,
        genre: artist.primaryGenreName || '',
        image,
      };
    }));
    res.json({ artists });
  } catch (error) {
    res.status(502).json({ error: `Artist search failed: ${error.message}` });
  }
});

app.get('/api/artists/:id', async (req, res) => {
  const artistId = Number(req.params.id);
  if (!Number.isSafeInteger(artistId) || artistId <= 0) {
    return res.status(400).json({ error: 'Invalid artist id' });
  }

  try {
    const [catalogResult, trackResult] = await Promise.allSettled([
      axios.get('https://itunes.apple.com/lookup', {
        params: { id: artistId, entity: 'album', limit: 200 },
        timeout: 12000,
      }),
      axios.get('https://itunes.apple.com/lookup', {
        params: { id: artistId, entity: 'song', limit: 200 },
        timeout: 12000,
      }),
    ]);

    if (catalogResult.status !== 'fulfilled') throw catalogResult.reason;
    const results = catalogResult.value.data.results || [];
    const songResults = trackResult.status === 'fulfilled' ? trackResult.value.data.results || [] : [];
    const artist = results.find((item) => item.wrapperType === 'artist') || songResults.find((item) => item.wrapperType === 'artist') || {};
    const tracks = songResults
      .filter((item) => item.wrapperType === 'track' && item.trackId)
      .map((item) => ({
        id: '',
        catalogId: String(item.trackId),
        title: item.trackName,
        artist: item.artistName,
        query: `${item.artistName} ${item.trackName}`,
        thumbnail: item.artworkUrl100?.replace('100x100bb', '600x600bb') || '',
        duration: Math.round((item.trackTimeMillis || 0) / 1000),
        albumId: item.collectionId,
        album: item.collectionName || '',
      }));
    const albums = results
      .filter((item) => item.wrapperType === 'collection' && item.collectionId)
      .map((item) => ({
        id: item.collectionId,
        title: item.collectionName,
        artist: item.artistName,
        image: item.artworkUrl100?.replace('100x100bb', '600x600bb') || '',
        year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : '',
        trackCount: item.trackCount || 0,
      }));
    let bio = '';
    let profileImage = '';
    if (artist.artistName) {
      try {
        const wiki = await axios.get(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artist.artistName.replace(/ /g, '_'))}`,
          { timeout: 7000, headers: { 'User-Agent': 'Sunify/1.0 (desktop music app)' } }
        );
        bio = wiki.data.extract || '';
        profileImage = wiki.data.thumbnail?.source || '';
      } catch (error) {}
    }

    res.json({
      artist: {
        id: artistId,
        name: artist.artistName || '',
        genre: artist.primaryGenreName || '',
        image: profileImage || albums[0]?.image || tracks[0]?.thumbnail || '',
        bio,
      },
      tracks: tracks.slice(0, 50),
      albums: albums.slice(0, 24),
    });
  } catch (error) {
    res.status(502).json({ error: `Artist profile failed: ${error.message}` });
  }
});

// YouTube Audio Stream URL
app.get('/api/stream', async (req, res) => {
  const { id, q, refresh } = req.query;
  const target = id || q;
  if (!target) return res.status(400).json({ error: 'Video ID veya Query required' });

  try {
    const streamData = await getDirectAudioUrl(target, { forceRefresh: refresh === '1' });
    res.set('Cache-Control', 'no-store');
    res.json(streamData);
  } catch (err) {
    res.status(500).json({ error: 'Ses akışı alınamadı: ' + err.message });
  }
});

// Range-capable same-origin audio proxy. The renderer's Web Audio EQ needs
// CORS-readable media; direct YouTube CDN URLs are opaque to AudioContext.
app.get('/api/audio-stream', async (req, res) => {
  const target = String(req.query.id || req.query.q || '').trim();
  if (!target || target.length > 500) return res.status(400).json({ error: 'Video ID veya arama sorgusu gerekli.' });
  let upstream;
  try {
    const streamData = await getDirectAudioUrl(target, { forceRefresh: req.query.refresh === '1' });
    upstream = await axios.get(streamData.url, {
      responseType: 'stream',
      timeout: 30_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      validateStatus: (status) => status === 200 || status === 206,
    });
    res.status(upstream.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'last-modified', 'etag']) {
      if (upstream.headers[header]) res.setHeader(header, upstream.headers[header]);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    upstream.data.on('error', (error) => res.destroy(error));
    res.on('close', () => upstream.data.destroy());
    upstream.data.pipe(res);
  } catch (error) {
    upstream?.data?.destroy();
    if (!res.headersSent) res.status(error.response?.status || 502).json({ error: `Ses akışı aktarılamadı: ${error.message}` });
    else res.destroy(error);
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
async function extractPlaylistWithYtDlp(url) {
  const script = [
    'import json, sys, yt_dlp',
    'opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": "in_playlist", "ignoreerrors": True, "socket_timeout": 15}',
    'with yt_dlp.YoutubeDL(opts) as ydl:',
    ' info = ydl.extract_info(sys.argv[1], download=False)',
    ' entries = info.get("entries") or []',
    ' print(json.dumps({"title": info.get("title"), "uploader": info.get("uploader") or info.get("channel"), "thumbnail": info.get("thumbnail"), "entries": [{"id": e.get("id"), "title": e.get("title"), "uploader": e.get("uploader") or e.get("channel"), "duration": e.get("duration"), "thumbnail": e.get("thumbnail")} for e in entries if e]}))',
  ].join('\n');
  const candidates = [
    [process.env.SUNIFY_PYTHON || 'python', ['-c', script, url]],
    ['py', ['-3', '-c', script, url]],
  ];
  let lastError;
  for (const [command, args] of candidates) {
    try {
      const { stdout } = await execFileAsync(command, args, { windowsHide: true, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
      const data = JSON.parse(stdout.trim());
      const tracks = (Array.isArray(data.entries) ? data.entries : []).filter((entry) => entry.title).map((entry) => ({
        id: entry.id || '', title: entry.title, artist: entry.uploader || data.uploader || 'YouTube',
        thumbnail: entry.thumbnail || (entry.id ? `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg` : data.thumbnail || ''),
        duration: Number(entry.duration) || 180, query: `${entry.uploader || data.uploader || ''} ${entry.title}`.trim(),
      }));
      if (!tracks.length) throw new Error('Bu çalma listesinde görüntülenebilir şarkı bulunamadı.');
      return { name: data.title || 'YouTube Çalma Listesi', author: data.uploader || 'YouTube', thumbnail: data.thumbnail || tracks[0].thumbnail, tracks };
    } catch (error) {
      lastError = error;
      if (error.code !== 'ENOENT' && !/No module named ['"]yt_dlp/.test(error.stderr || '')) break;
    }
  }
  throw lastError || new Error('Playlist bilgileri alınamadı.');
}

app.post('/api/import-playlist', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url || url.length > 2048) return res.status(400).json({ error: 'Geçerli bir çalma listesi URL adresi gerekli.' });

  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host) && parsedUrl.searchParams.has('list')) {
      let playlist;
      try {
        playlist = await extractPlaylistWithYtDlp(url);
      } catch (extractError) {
        const listId = parsedUrl.searchParams.get('list');
        try {
          const result = await ytSearch({ listId });
          const tracks = (Array.isArray(result.videos) ? result.videos : []).filter((video) => video?.title).map((video) => {
            const author = video.author?.name || '';
            const cleaned = cleanTrackMetadata(video.title, author);
            return { id: video.videoId || '', title: cleaned.title || video.title, artist: cleaned.artist || author || 'YouTube', thumbnail: video.thumbnail || (video.videoId ? `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg` : ''), duration: Number(video.seconds || video.duration?.seconds) || 180 };
          });
          if (!tracks.length) throw extractError;
          playlist = { name: result.title || 'YouTube Çalma Listesi', author: result.author?.name || 'YouTube', thumbnail: tracks[0].thumbnail, tracks };
        } catch {
          throw new Error(`Çalma listesi okunamadı. ${extractError.message || ''}`.trim());
        }
      }
      return res.json({ id: `pl_${Date.now()}`, name: playlist.name, author: playlist.author, thumbnail: playlist.thumbnail, tracks: playlist.tracks });
    }

    if (host === 'open.spotify.com' && parsedUrl.pathname.includes('/playlist/')) {
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

const DOWNLOADS_DIR = process.env.SUNIFY_DOWNLOADS_DIR || path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// İndirilen Şarkılar Statik Erişimi
app.use('/downloaded', express.static(DOWNLOADS_DIR));

app.post('/api/library/folders', (req, res) => {
  const { folders } = req.body;
  if (!Array.isArray(folders) || folders.length > 20 || folders.some((folder) => typeof folder !== 'string')) {
    return res.status(400).json({ error: 'Klasör listesi geçersiz.' });
  }
  ALLOWED_MUSIC_DIRS.clear();
  for (const folder of folders) {
    const resolved = path.resolve(folder);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) ALLOWED_MUSIC_DIRS.add(resolved);
  }
  res.json({ success: true, folders: ALLOWED_MUSIC_DIRS.size });
});

app.get('/api/library/file', async (req, res) => {
  const filePath = path.resolve(String(req.query.path || ''));
  const allowed = [DOWNLOADS_DIR, ...ALLOWED_MUSIC_DIRS].some((root) => {
    const relative = path.relative(root, filePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!allowed || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).json({ error: 'Müzik dosyası bulunamadı.' });
  }
  res.sendFile(filePath);
});

// Tüm Cihazdaki Müzik Dosyalarını Otomatik Tara (.mp3, .m4a, .flac, .wav, .ogg, .aac, .wma)
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.wma', '.webm', '.opus']);

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
    const scanDirs = [DOWNLOADS_DIR, ...ALLOWED_MUSIC_DIRS];

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
      const safeLocalUrl = `http://${HOST}:${app.locals.port || PORT}/api/library/file?path=${encodeURIComponent(fileObj.fullPath)}`;

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
  if (typeof target !== 'string' || !target.trim()) return res.status(400).json({ error: 'Parça bilgisi gerekli' });

  try {
    const streamData = await getDirectAudioUrl(target);
    if (!streamData.url) {
      return res.status(404).json({ error: 'Ses akışı bulunamadı' });
    }

    const safeTitle = (title || streamData.title || 'Parça').replace(/[/\\?%*:|"<>]/g, '_').trim();
    const safeArtist = (artist || '').replace(/[/\\?%*:|"<>]/g, '_').trim();
    const extension = streamData.ext === 'mp3' ? '.mp3' : streamData.ext === 'webm' ? '.webm' : '.m4a';
    const fileName = `${safeArtist ? `${safeArtist} - ` : ''}${safeTitle}${extension}`;
    const filePath = path.join(DOWNLOADS_DIR, fileName);

    // Eğer zaten indirilmişse hemen başarılı dön
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 100000) {
      return res.json({
        success: true,
        alreadyExists: true,
        fileName,
        localUrl: `http://${HOST}:${app.locals.port || PORT}/downloaded/${encodeURIComponent(fileName)}`,
      });
    }

    const tempPath = `${filePath}.${process.pid}.part`;
    req.downloadTempPath = tempPath;
    const response = await axios({
      method: 'get',
      url: streamData.url,
      responseType: 'stream',
      timeout: 60_000,
      maxContentLength: 500 * 1024 * 1024,
      maxBodyLength: 500 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });

    const writer = fs.createWriteStream(tempPath, { flags: 'w' });
    await new Promise((resolve, reject) => {
      response.data.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
      response.data.pipe(writer);
    });
    if (fs.statSync(tempPath).size < 1000) throw new Error('İndirilen dosya boş veya eksik.');
    fs.renameSync(tempPath, filePath);
    res.json({ success: true, fileName, localUrl: `http://${HOST}:${app.locals.port || PORT}/downloaded/${encodeURIComponent(fileName)}` });
  } catch (err) {
    try { if (req.downloadTempPath) fs.unlinkSync(req.downloadTempPath); } catch {}
    res.status(500).json({ error: 'İndirme hatası: ' + err.message });
  }
});

app.get('/api/download', async (req, res) => {
  const { id, q, title, artist } = req.query;
  const target = id || q || `${artist || ''} ${title || ''}`;
  if (typeof target !== 'string' || !target.trim()) return res.status(400).json({ error: 'Parça bilgisi gerekli' });

  try {
    const streamData = await getDirectAudioUrl(target);
    if (!streamData.url) {
      return res.status(404).json({ error: 'İndirilecek ses akışı bulunamadı' });
    }

    const safeTitle = (title || streamData.title || 'Sunify_Track').replace(/[/\\?%*:|"<>]/g, '_');
    const safeArtist = (artist || '').replace(/[/\\?%*:|"<>]/g, '_');
    const extension = streamData.ext === 'mp3' ? 'mp3' : streamData.ext === 'webm' ? 'webm' : 'm4a';
    const filename = `${safeArtist ? `${safeArtist} - ` : ''}${safeTitle}.${extension}`;

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', extension === 'mp3' ? 'audio/mpeg' : extension === 'webm' ? 'audio/webm' : 'audio/mp4');

    const audioStream = await axios({
      method: 'get',
      url: streamData.url,
      responseType: 'stream',
      timeout: 60_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });

    audioStream.data.on('error', (error) => res.destroy(error));
    res.on('close', () => audioStream.data.destroy());
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
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') return res.status(400).json({ error: 'Supabase URL HTTPS kullanmalıdır.' });
    saveConfig(url, anonKey);
    res.json({ success: true, isConfigured: isConfigured() });
  } catch (error) {
    res.status(400).json({ error: `Supabase yapılandırması kaydedilemedi: ${error.message}` });
  }
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
    return res.status(400).json({ error: err.message });
  }

  // Bulut hesabını oluştur; başarısız olursa yerel hesap çevrimdışı kullanım için hazır kalır.
  const supabase = getSupabase();
  if (supabase && isConfigured()) {
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { username: username || email.split('@')[0] },
          emailRedirectTo: 'sunify://auth/callback',
        },
      });
      if (!error && data.session) {
        return res.json({ success: true, user: data.user, session: data.session });
      }
    } catch {}
  }

  return res.json({ success: true, user: localSession.user, session: localSession });
});

app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  revokeSession(token);
  res.json({ success: true });
});

// Giriş Yapma (Sign In)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'E-posta ve şifre zorunludur.' });
  }

  // Bulut oturumu, kullanıcı verilerini tüm cihazlarda senkronize edebilmek için önceliklidir.
  const supabase = getSupabase();
  if (supabase && isConfigured()) {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error && data.session) {
        return res.json({ success: true, user: data.user, session: data.session });
      }
    } catch {}
  }

  // Bulut hesabı kullanılamıyorsa mevcut çevrimdışı yerel hesapla devam et.
  try {
    const localSession = loginUser(email, password);
    return res.json({ success: true, user: localSession.user, session: localSession });
  } catch {
    return res.status(400).json({ error: 'E-posta veya şifre hatalı. Lütfen bilgilerinizi kontrol edin.' });
  }
});

// Bulut / Yerel Senkronizasyonu: Kullanıcının Verilerini İndir
app.get('/api/sync/pull', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme tokenı eksik' });

  const token = authHeader.replace(/^Bearer\s+/i, '');

  // Yerel oturum mu?
  if (token.startsWith('local_session_')) {
    const userId = getUserIdForToken(token);
    if (!userId) return res.status(401).json({ error: 'Geçersiz veya süresi bitmiş oturum.' });
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
    const userSupabase = getSupabaseForToken(token);
    if (!userSupabase) return res.status(400).json({ error: 'Supabase kullanıcı oturumu oluşturulamadı.' });

    // Çalma listelerini çek
    const { data: playlists, error: playlistsError } = await userSupabase
      .from('user_playlists')
      .select('*')
      .eq('user_id', user.id);
    if (playlistsError) throw playlistsError;

    // Dinleme analitiği ve beğenileri çek
    const { data: analytics, error: analyticsError } = await userSupabase
      .from('user_analytics')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    if (analyticsError) throw analyticsError;

    res.json({
      playlists: playlists || [],
      analytics: analytics || { liked_tracks: [], listening_stats: {} },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear only the currently authenticated account's legacy mixed data once requested by its client.
app.post('/api/sync/reset-own-data', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme tokenı eksik' });
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (token.startsWith('local_session_')) {
    const userId = getUserIdForToken(token);
    if (!userId) return res.status(401).json({ error: 'Geçersiz veya süresi bitmiş oturum.' });
    const cleared = saveUserData(userId, { playlists: [], likedTracks: [], listeningStats: {} });
    return cleared ? res.json({ success: true }) : res.status(404).json({ error: 'Hesap bulunamadı.' });
  }

  const supabase = getSupabase();
  if (!supabase) return res.status(400).json({ error: 'Supabase aktif değil.' });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Geçersiz oturum.' });
    const userSupabase = getSupabaseForToken(token);
    if (!userSupabase) return res.status(400).json({ error: 'Supabase kullanıcı oturumu oluşturulamadı.' });

    const { error: playlistsError } = await userSupabase.from('user_playlists').delete().eq('user_id', user.id);
    if (playlistsError) throw playlistsError;
    const { error: analyticsError } = await userSupabase.from('user_analytics').upsert({
      user_id: user.id,
      liked_tracks: [],
      listening_stats: {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (analyticsError) throw analyticsError;
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Hesap verileri temizlenemedi.' });
  }
});

// Bulut / Yerel Senkronizasyonu: Yerel Verileri Gönder (Push)
app.post('/api/sync/push', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Yetkilendirme tokenı eksik' });

  const token = authHeader.replace(/^Bearer\s+/i, '');
  const { playlists, likedTracks, listeningStats } = req.body;

  // Yerel oturum mu?
  if (token.startsWith('local_session_')) {
    const userId = getUserIdForToken(token);
    if (!userId) return res.status(401).json({ error: 'Geçersiz veya süresi bitmiş oturum.' });
    const validPayload =
      (playlists === undefined || Array.isArray(playlists)) &&
      (likedTracks === undefined || Array.isArray(likedTracks)) &&
      (listeningStats === undefined || (listeningStats && typeof listeningStats === 'object' && !Array.isArray(listeningStats)));
    if (!validPayload) return res.status(400).json({ error: 'Senkronizasyon verisi geçersiz.' });
    if (!saveUserData(userId, { playlists, likedTracks, listeningStats })) return res.status(404).json({ error: 'Hesap bulunamadı.' });
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
    const userSupabase = getSupabaseForToken(token);
    if (!userSupabase) return res.status(400).json({ error: 'Supabase kullanıcı oturumu oluşturulamadı.' });

    // Çalma listelerini eşitle
    if (Array.isArray(playlists)) {
      const { error: deleteError } = await userSupabase.from('user_playlists').delete().eq('user_id', user.id);
      if (deleteError) throw deleteError;
      for (const playlist of playlists) {
        if (!playlist.name) continue;
        const { error: playlistError } = await userSupabase.from('user_playlists').upsert({
          user_id: user.id,
          name: playlist.name,
          cover_url: playlist.cover || playlist.cover_url || '',
          tracks: Array.isArray(playlist.tracks) ? playlist.tracks : [],
          created_at: playlist.created_at || new Date().toISOString(),
        });
        if (playlistError) throw playlistError;
      }
    }

    // Analitik & Beğenileri eşitle
    const { error: analyticsError } = await userSupabase
      .from('user_analytics')
      .upsert({
        user_id: user.id,
        liked_tracks: likedTracks || [],
        listening_stats: listeningStats || {},
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    if (analyticsError) throw analyticsError;

    res.json({ success: true, message: 'Bulut senkronizasyonu tamamlandı.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let serverInstance = null;
function startServer(options = {}) {
  if (typeof options === 'function') options = { onReady: options };
  if (serverInstance) {
    if (options.onReady) options.onReady();
    return serverInstance;
  }
  serverInstance = app.listen(PORT, HOST);
  serverInstance.on('listening', () => {
    const address = serverInstance.address();
    const actualPort = address.port;
    app.locals.port = actualPort;
    TRUSTED_ORIGINS.add(`http://localhost:${actualPort}`);
    TRUSTED_ORIGINS.add(`http://127.0.0.1:${actualPort}`);
    console.log(`Sunify Core Server çalışıyor: http://${HOST}:${actualPort}`);
    if (options.onReady) options.onReady(actualPort);
  });
  serverInstance.on('error', (error) => {
    serverInstance = null;
    if (error.code === 'EADDRINUSE') {
      const fallbackServer = app.listen(0, HOST, () => {
        serverInstance = fallbackServer;
        const actualPort = fallbackServer.address().port;
        app.locals.port = actualPort;
        TRUSTED_ORIGINS.add(`http://localhost:${actualPort}`);
        TRUSTED_ORIGINS.add(`http://127.0.0.1:${actualPort}`);
        console.log(`Sunify Core Server çalışıyor: http://${HOST}:${actualPort}`);
      });
      return;
    }
    if (options.onError) options.onError(error);
    else console.error('Sunify sunucusu başlatılamadı:', error.message);
  });
  return serverInstance;
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, app };

