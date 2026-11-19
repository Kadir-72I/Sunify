// server.js
const express = require('express');
const ytSearch = require('yt-search');
const axios = require('axios');
const dns = require('dns');
const path = require('path');
const fs = require('fs');
const { Readable, Transform } = require('stream');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const artistBioTranslationCache = new Map();

async function translateArtistBioToTurkish(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (artistBioTranslationCache.has(source)) return artistBioTranslationCache.get(source);

  // MyMemory accepts up to 500 UTF-8 bytes per segment; keep a safety margin.
  const words = source.split(/\s+/);
  const chunks = [];
  let chunk = '';
  for (const word of words) {
    const candidate = chunk ? `${chunk} ${word}` : word;
    if (Buffer.byteLength(candidate, 'utf8') > 420 && chunk) {
      chunks.push(chunk);
      chunk = word;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);

  const translated = [];
  for (const part of chunks) {
    const response = await axios.get('https://api.mymemory.translated.net/get', {
      params: { q: part, langpair: 'en|tr' },
      timeout: 7000,
      headers: { 'User-Agent': 'Sunify/1.0 (desktop music app)' },
    });
    const result = response.data?.responseData?.translatedText;
    if (!result || Number(response.data?.responseStatus) !== 200) throw new Error('Biography translation unavailable');
    translated.push(result.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  }
  const output = translated.join(' ').trim();
  artistBioTranslationCache.set(source, output);
  if (artistBioTranslationCache.size > 100) artistBioTranslationCache.delete(artistBioTranslationCache.keys().next().value);
  return output;
}

// Windows BoringSSL EPROTO / IPv6 handshake hatasını kalıcı olarak engelle
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

const { fetchLyrics } = require('./services/audio/lyricsService');
const { cleanTrackMetadata } = require('./services/audio/metadataCleaner');
const { getDirectAudioUrl, startCachedAudioDownload, getCachedAudioByKey, writeAudioCacheMetadata, isProgressivelyPlayableAudio, listCachedAudioFiles, getAudioCacheStats, clearAudioCache, setAudioCacheLimit, getRuntimeStatus, getActiveExtractions, setQueryResolver, warmUp } = require('./services/audio/streamProxy');
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
  deleteUserAccount,
  deleteLocalAccountForEmail,
} = require('./services/auth/localAuthService');

// Aynı sorgu için YouTube aramasını tek sefer yapar: önbellek + eşzamanlı isteklerin birleştirilmesi.
const SEARCH_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map();
const searchInFlight = new Map();
const playbackWarmupQueue = [];
const playbackWarmupQueued = new Set();
let playbackWarmupWorkers = 0;
function pumpPlaybackWarmupQueue() {
  while (playbackWarmupWorkers < 2 && playbackWarmupQueue.length) {
    const track = playbackWarmupQueue.shift();
    const id = String(track?.id || '').trim();
    if (!id) continue;
    playbackWarmupWorkers += 1;
    const startedAt = Date.now();
    void startCachedAudioDownload(id, { priority: 'low' })
      .then((audio) => {
        console.info(`[play-warmup] ${id} first audio bytes ready in ${Date.now() - startedAt}ms${audio.complete ? ' (cache hit)' : ''}`);
        if (track.title) {
          const metadata = { ...track, id, query: track.query || `${track.artist || ''} ${track.title}`.trim() };
          const persist = () => writeAudioCacheMetadata(audio.filePath, metadata);
          if (audio.complete) void persist().catch((error) => console.warn('Ön hazırlık bilgisi kaydedilemedi:', error.message));
          else void audio.completion.then(persist).catch((error) => console.warn('Ön hazırlık bilgisi kaydedilemedi:', error.message));
        }
      })
      .catch((error) => console.warn(`[play-warmup] ${id} failed: ${error.message}`))
      .finally(() => {
        playbackWarmupQueued.delete(id);
        playbackWarmupWorkers = Math.max(0, playbackWarmupWorkers - 1);
        pumpPlaybackWarmupQueue();
      });
  }
}
function queuePlaybackWarmup(videos) {
  // Warm only the first two visible choices to keep background bandwidth bounded.
  for (const video of (videos || []).slice(0, 2)) {
    const id = String(video?.id || video?.videoId || '').trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id) || playbackWarmupQueued.has(id)) continue;
    if (playbackWarmupQueue.length >= 12) break;
    playbackWarmupQueued.add(id);
    playbackWarmupQueue.push({
      id,
      title: String(video.title || '').trim(),
      artist: String(video.artist || video.author?.name || '').trim(),
      thumbnail: String(video.thumbnail || '').trim(),
      duration: Number(video.duration || video.seconds) || 0,
      query: String(video.query || `${video.artist || video.author?.name || ''} ${video.title || ''}`).trim(),
    });
  }
  if (playbackWarmupQueue.length) {
    console.info(`[play-warmup] queued ${playbackWarmupQueue.length} song(s), running ${playbackWarmupWorkers} warmup(s)`);
    setImmediate(pumpPlaybackWarmupQueue);
  }
}
function cachedYtSearch(query, { forceRefresh = false } = {}) {
  const key = (typeof query === 'string' ? query : JSON.stringify(query)).trim().toLowerCase();
  if (forceRefresh) searchCache.delete(key);
  const hit = searchCache.get(key);
  if (!forceRefresh && hit && Date.now() - hit.at < SEARCH_TTL_MS) return Promise.resolve(hit.data);
  if (!forceRefresh && searchInFlight.has(key)) return searchInFlight.get(key);
  let timeout;
  const request = Promise.race([
    ytSearch(query),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('YouTube araması zaman aşımına uğradı.')), 12_000);
    }),
  ]).then((data) => {
    if (searchInFlight.get(key) === request) {
      if (searchCache.size >= 120) searchCache.delete(searchCache.keys().next().value);
      searchCache.set(key, { at: Date.now(), data });
    }
    return data;
  }).finally(() => {
    clearTimeout(timeout);
    if (searchInFlight.get(key) === request) searchInFlight.delete(key);
  });
  searchInFlight.set(key, request);
  return request;
}
setQueryResolver(async (query, { excludeVideoIds = [], forceRefresh = false } = {}) => {
  const excluded = new Set((Array.isArray(excludeVideoIds) ? excludeVideoIds : []).map(String));
  const result = await cachedYtSearch(query, { forceRefresh: forceRefresh || excluded.size > 0 });
  const match = (result.videos || []).find((video) => {
    const id = String(video?.videoId || video?.id || '').trim();
    return /^[a-zA-Z0-9_-]{11}$/.test(id) && !excluded.has(id);
  });
  return match?.videoId || match?.id || '';
});
const artistSearchCache = new Map();

const PLACEHOLDER_COVER = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Cdefs%3E%3ClinearGradient id=%27g%27 x1=%270%27 y1=%270%27 x2=%271%27 y2=%271%27%3E%3Cstop offset=%270%27 stop-color=%27%237c5cff%27/%3E%3Cstop offset=%271%27 stop-color=%27%23241126%27/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width=%2764%27 height=%2764%27 fill=%27url(%23g)%27/%3E%3Cpath d=%27M26 40V22l16-4v18%27 fill=%27none%27 stroke=%27%23fff%27 stroke-opacity=%27.7%27 stroke-width=%273%27 stroke-linecap=%27round%27/%3E%3Ccircle cx=%2723%27 cy=%2741%27 r=%274%27 fill=%27%23fff%27 fill-opacity=%27.7%27/%3E%3Ccircle cx=%2739%27 cy=%2737%27 r=%274%27 fill=%27%23fff%27 fill-opacity=%27.7%27/%3E%3C/svg%3E";

const app = express();
const PORT = Number(process.env.PORT) || 0;
const HOST = '127.0.0.1';
const TRUSTED_ORIGINS = new Set(['null', 'file://', `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const ALLOWED_MUSIC_DIRS = new Set();
const RATE_LIMITS = new Map();
const FORWARDED_AUDIO_HEADERS = new Set(['user-agent', 'accept', 'accept-language', 'sec-fetch-mode', 'referer', 'origin']);

function getAudioRequestHeaders(streamData, range) {
  const headers = {};
  for (const [name, value] of Object.entries(streamData?.http_headers || {})) {
    if (FORWARDED_AUDIO_HEADERS.has(name.toLowerCase()) && typeof value === 'string') headers[name] = value;
  }
  if (range) headers.Range = range;
  return headers;
}

function createGrowingAudioStream(filePath, completion) {
  let position = 0;
  let pumping = false;
  let resumeRequested = false;
  let waitingForDrain = false;
  const output = new Readable({
    read() {
      waitingForDrain = false;
      resumeRequested = true;
      pump();
    },
  });

  async function pump() {
    if (pumping || output.destroyed) return;
    pumping = true;
    resumeRequested = false;
    try {
      while (!output.destroyed) {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let bytesRead = 0;
        let handle;
        try {
          handle = await fs.promises.open(filePath, 'r');
          ({ bytesRead } = await handle.read(buffer, 0, buffer.length, position));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        } finally {
          await handle?.close().catch(() => {});
        }
        if (bytesRead) {
          position += bytesRead;
          if (!output.push(buffer.subarray(0, bytesRead))) {
            waitingForDrain = true;
            break;
          }
          continue;
        }

        const completed = await Promise.race([
          completion.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 120)),
        ]);
        if (completed) {
          output.push(null);
          break;
        }
        if (!resumeRequested) break;
      }
    } catch (error) {
      output.destroy(error);
    } finally {
      pumping = false;
      if (resumeRequested && !output.destroyed) queueMicrotask(pump);
      else if (!waitingForDrain && !output.destroyed && !output.readableEnded) setTimeout(pump, 120);
    }
  }

  return output;
}

function sendAudioFileRange(req, res, filePath, stat) {
  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (start >= stat.size || start > end) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    status = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }
  const extension = path.extname(filePath).toLowerCase();
  const contentType = ({ '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.webm': 'audio/webm; codecs="opus"', '.opus': 'audio/ogg; codecs="opus"', '.ogg': 'audio/ogg' })[extension] || 'application/octet-stream';
  res.status(status);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', end - start + 1);
  res.setHeader('Accept-Ranges', 'bytes');
  const fileStream = fs.createReadStream(filePath, { start, end });
  fileStream.on('error', (streamError) => res.destroy(streamError));
  res.on('close', () => fileStream.destroy());
  fileStream.pipe(res);
}

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
  if (!['admin-login', 'list-users', 'get-user-data', 'delete-user-data', 'delete-user', 'create-release-upload', 'publish-release'].includes(action)) {
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
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Query q is required' });
  if (query.length > 200) return res.status(400).json({ error: 'Arama sorgusu en fazla 200 karakter olabilir.' });

  try {
    const searchResults = await cachedYtSearch(query);
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

    // Resolve a few likely choices while the user is looking at the results.
    // A click during warmup shares getDirectAudioUrl's in-flight promise.
    queuePlaybackWarmup(videos);
    res.json({ results: videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function normalizeRecommendationText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(official|music video|video|audio|lyrics?|visuali[sz]er|topic|remaster(?:ed)?|hd|4k|slowed|sped up|nightcore|karaoke|cover)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function recommendationTextSimilarity(left, right) {
  const a = new Set(normalizeRecommendationText(left).split(' ').filter((word) => word.length > 1));
  const b = new Set(normalizeRecommendationText(right).split(' ').filter((word) => word.length > 1));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / (a.size + b.size - intersection);
}

// Contextual recommendations combine several listening or playlist seeds.
app.get('/api/recommendations', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 240);
  const forceRefresh = req.query.refresh === '1';
  let seeds = [];
  try {
    const rawSeeds = typeof req.query.seeds === 'string' ? JSON.parse(req.query.seeds) : [];
    if (Array.isArray(rawSeeds)) {
      seeds = rawSeeds.filter((seed) => seed && typeof seed.title === 'string' && seed.title.trim())
        .slice(0, 6)
        .map((seed) => ({
          title: seed.title.trim().slice(0, 160),
          artist: String(seed.artist || '').trim().slice(0, 120),
          duration: Math.max(0, Number(seed.duration) || 0),
          weight: Math.max(1, Math.min(8, Number(seed.weight) || 1)),
        }));
    }
  } catch {
    return res.status(400).json({ error: 'Öneri kaynak parçaları okunamadı.' });
  }
  if (!seeds.length && query) seeds = [{ title: query, artist: '', duration: 0, weight: 1 }];
  if (!seeds.length) return res.status(400).json({ error: 'Öneri için şarkı veya liste bağlamı gerekli.' });
  try {
    const candidateGroups = await Promise.all(seeds.map(async (seed, seedIndex) => {
      const searchQuery = `songs like ${seed.artist} ${seed.title}`.trim();
      try {
        const result = await cachedYtSearch(searchQuery, { forceRefresh });
        return (result.videos || []).slice(0, 16).map((video) => {
          const cleaned = cleanTrackMetadata(video.title, video.author?.name || '');
          return {
            id: video.videoId,
            title: cleaned.title || video.title,
            artist: cleaned.artist || video.author?.name || 'Bilinmeyen Sanatçı',
            thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
            duration: Number(video.seconds) || 0,
            query: `${cleaned.artist || video.author?.name || ''} ${cleaned.title || video.title}`.trim(),
            seedIndex,
          };
        });
      } catch (error) {
        console.warn(`Öneri araması başarısız (${seed.title}):`, error.message);
        return [];
      }
    }));

    const seedDuration = seeds.filter((seed) => seed.duration > 0).map((seed) => seed.duration);
    const typicalDuration = seedDuration.length
      ? seedDuration.sort((a, b) => a - b)[Math.floor(seedDuration.length / 2)]
      : 0;
    const candidates = new Map();
    candidateGroups.flat().forEach((track) => {
      if (!track.id || !track.title) return;
      const seed = seeds[track.seedIndex];
      const titleMatch = Math.max(...seeds.map((item) => recommendationTextSimilarity(track.title, item.title)));
      const sameArtistAsSeed = seeds.some((item) => normalizeRecommendationText(item.artist) && normalizeRecommendationText(item.artist) === normalizeRecommendationText(track.artist));
      // Remove the seed songs themselves, including common alternate video/audio uploads.
      if (titleMatch >= (sameArtistAsSeed ? 0.66 : 0.88)) return;

      const artistKey = normalizeRecommendationText(track.artist);
      const duration = Number(track.duration) || 0;
      const durationDelta = typicalDuration && duration ? Math.abs(duration - typicalDuration) / typicalDuration : 0;
      const artistAffinity = seeds.reduce((sum, item) => (
        normalizeRecommendationText(item.artist) && normalizeRecommendationText(item.artist) === artistKey
          ? sum + item.weight
          : sum
      ), 0);
      const seedDurationDelta = seed?.duration && duration ? Math.abs(duration - seed.duration) / seed.duration : 0;
      const score = (artistAffinity * 0.55)
        + (seed?.weight || 1) * 0.15
        + (titleMatch >= 0.2 && titleMatch < 0.66 ? titleMatch * 1.1 : 0)
        + (durationDelta < 0.2 ? 1.2 : durationDelta < 0.45 ? 0.45 : durationDelta > 0.9 ? -0.8 : 0)
        + (seedDurationDelta < 0.2 ? 0.35 : 0);
      const key = normalizeRecommendationText(track.title);
      const previous = candidates.get(key);
      if (!previous || score > previous.score) candidates.set(key, { ...track, score, artistKey });
    });

    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
    const tracks = [];
    const artistCounts = new Map();
    let lastArtistKey = '';
    for (const track of ranked) {
      const sameVersion = tracks.some((existing) => recommendationTextSimilarity(existing.title, track.title) >= 0.82);
      if (sameVersion) continue;
      const count = artistCounts.get(track.artistKey) || 0;
      if (track.artistKey && (count >= 2 || track.artistKey === lastArtistKey)) continue;
      tracks.push({ id: track.id, title: track.title, artist: track.artist, thumbnail: track.thumbnail, duration: track.duration, query: track.query });
      if (track.artistKey) artistCounts.set(track.artistKey, count + 1);
      lastArtistKey = track.artistKey;
      if (tracks.length >= 25) break;
    }
    queuePlaybackWarmup(tracks);
    res.json({ tracks, seedCount: seeds.length });
  } catch (error) {
    res.status(502).json({ error: `Öneriler alınamadı: ${error.message}` });
  }
});
// YouTube public playlist search for the global search overlay.
app.get('/api/search/playlists', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 120);
  if (!query) return res.status(400).json({ error: 'Query q is required' });
  try {
    const result = await cachedYtSearch(query);
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

// Ortak dinlenme listesini sıfırlama tabanlı yeni sayım mekanizması:
// Sadece bu sıfırlama noktasından sonra "sonuna kadar dinlenen" parçalar
// En çok dinlenen şarkılar listesinde yer alır.
const GLOBAL_CHART_EPOCH_FILE = path.join(path.dirname(process.env.SUNIFY_USER_DB_FILE || path.join(__dirname, '../data/sunify_users.json')), 'sunify_global_chart_baseline.json');

function readGlobalChartBaseline() {
  try {
    if (fs.existsSync(GLOBAL_CHART_EPOCH_FILE)) {
      return JSON.parse(fs.readFileSync(GLOBAL_CHART_EPOCH_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function writeGlobalChartBaseline(baseline) {
  try {
    fs.mkdirSync(path.dirname(GLOBAL_CHART_EPOCH_FILE), { recursive: true });
    fs.writeFileSync(GLOBAL_CHART_EPOCH_FILE, JSON.stringify(baseline, null, 2), 'utf8');
  } catch {}
}

function normalizeGlobalTrackKey(artist, title) {
  return `${String(artist || '').trim().toLowerCase()}|${String(title || '').trim().toLowerCase()}`;
}

async function ensureGlobalChartBaseline(supabase) {
  let baseline = readGlobalChartBaseline();
  if (baseline && baseline.epoch === 2 && baseline.counts && typeof baseline.counts === 'object') {
    return baseline;
  }
  const counts = {};
  if (supabase) {
    try {
      const { data } = await supabase.rpc('get_sunify_global_top', { result_limit: 20 });
      if (Array.isArray(data)) {
        for (const item of data) {
          const key = normalizeGlobalTrackKey(item.artist, item.title);
          counts[key] = Math.max(0, Number(item.play_count) || 0);
        }
      }
    } catch {}
  }
  baseline = { epoch: 2, resetAt: new Date().toISOString(), counts, localCounts: {} };
  writeGlobalChartBaseline(baseline);
  return baseline;
}

// Shared public chart: aggregate anonymous play events, never expose per-user analytics.
app.post('/api/discover/play', async (req, res) => {
  const { track } = req.body || {};
  if (!track || typeof track !== 'object' || !String(track.id || '').trim() || !String(track.title || '').trim()) {
    return res.status(400).json({ error: 'Geçerli şarkı bilgisi gerekli.' });
  }
  const supabase = getSupabase();
  const baseline = await ensureGlobalChartBaseline(supabase);
  const key = normalizeGlobalTrackKey(track.artist, track.title);
  baseline.localCounts = baseline.localCounts || {};
  baseline.localCounts[key] = {
    track_id: String(track.id).slice(0, 200),
    title: String(track.title).slice(0, 300),
    artist: String(track.artist || '').slice(0, 300),
    thumbnail: String(track.thumbnail || '').slice(0, 1000),
    play_count: (Number(baseline.localCounts[key]?.play_count) || 0) + 1,
    updated_at: Date.now(),
  };
  writeGlobalChartBaseline(baseline);
  if (!supabase) return res.json({ success: true });
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
    return res.json({ success: true });
  }
});

app.get('/api/discover/top', async (req, res) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
  const supabase = getSupabase();
  try {
    const baseline = await ensureGlobalChartBaseline(supabase);
    const merged = new Map();
    if (supabase) {
      const { data } = await supabase.rpc('get_sunify_global_top', { result_limit: 20 });
      if (Array.isArray(data)) {
        for (const row of data) {
          const key = normalizeGlobalTrackKey(row.artist, row.title);
          const baseVal = Number(baseline.counts?.[key]);
          const rawCount = Number(row.play_count) || 0;
          // Baseline'da olmayan eski kayıtlar eğer zaten >1 ise ilk kez göründüğünde baseline'a kaydedilir
          if (!Number.isFinite(baseVal)) {
            if (rawCount > 1 && !baseline.localCounts?.[key]) {
              baseline.counts[key] = rawCount;
              writeGlobalChartBaseline(baseline);
              continue;
            }
          }
          const delta = Math.max(0, rawCount - (Number.isFinite(baseVal) ? baseVal : 0));
          if (delta > 0) {
            merged.set(key, {
              track_id: row.track_id,
              title: row.title,
              artist: row.artist,
              thumbnail: row.thumbnail,
              play_count: delta,
            });
          }
        }
      }
    }
    for (const [key, localEntry] of Object.entries(baseline.localCounts || {})) {
      const existing = merged.get(key);
      const localCount = Number(localEntry?.play_count) || 0;
      if (localCount <= 0) continue;
      if (!existing || localCount > existing.play_count) {
        merged.set(key, {
          track_id: localEntry.track_id,
          title: localEntry.title,
          artist: localEntry.artist,
          thumbnail: localEntry.thumbnail,
          play_count: localCount,
        });
      }
    }
    const tracks = [...merged.values()]
      .filter((t) => t.play_count >= 1)
      .sort((a, b) => b.play_count - a.play_count)
      .slice(0, limit);
    return res.json({ tracks });
  } catch (error) {
    console.warn('Sunify global chart is unavailable:', error.message);
    return res.json({ tracks: [], unavailable: true });
  }
});

// Today's shared listening chart is backed by per-play events (not the all-time aggregate).
app.get('/api/discover/daily-top', async (req, res) => {
  const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 25));
  const supabase = getSupabase();
  if (!supabase) return res.json({ tracks: [], unavailable: true });
  try {
    const { data, error } = await supabase.rpc('get_sunify_daily_top', { result_limit: limit });
    if (error) throw error;
    return res.json({ tracks: Array.isArray(data) ? data : [] });
  } catch (error) {
    console.warn('Sunify daily chart is unavailable:', error.message);
    return res.json({ tracks: [], unavailable: true });
  }
});

// Build an artist-focused mix from the user's most-played artists.
app.get('/api/daily-mix/artist-tracks', async (req, res) => {
  let artists = [];
  try {
    const raw = typeof req.query.artists === 'string' ? JSON.parse(req.query.artists) : [];
    if (Array.isArray(raw)) artists = [...new Set(raw.map((value) => String(value || '').trim().slice(0, 120)).filter(Boolean))].slice(0, 6);
  } catch {
    return res.status(400).json({ error: 'Sanatçı listesi okunamadı.' });
  }
  if (!artists.length) return res.json({ tracks: [] });
  try {
    const groups = await Promise.all(artists.map(async (artist) => {
      try {
        const result = await cachedYtSearch(`${artist} songs`);
        return (result.videos || []).slice(0, 20).map((video) => {
          const cleaned = cleanTrackMetadata(video.title, video.author?.name || '');
          return {
            id: video.videoId,
            title: cleaned.title || video.title,
            artist: cleaned.artist || video.author?.name || artist,
            thumbnail: video.thumbnail || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
            duration: Number(video.seconds) || 0,
            query: `${cleaned.artist || artist} ${cleaned.title || video.title}`.trim(),
          };
        });
      } catch (error) {
        console.warn(`Daily Mix sanatçı araması başarısız (${artist}):`, error.message);
        return [];
      }
    }));
    const artistKeys = artists.map(normalizeRecommendationText);
    const ranked = groups.flat().map((track) => {
      const artist = normalizeRecommendationText(track.artist);
      const artistIndex = artistKeys.findIndex((key) => key && (artist === key || artist.includes(key) || key.includes(artist)));
      return { track, score: artistIndex < 0 ? 0 : (artists.length - artistIndex) };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
    const seen = new Set();
    const tracks = [];
    for (const { track } of ranked) {
      const key = normalizeRecommendationText(`${track.artist} ${track.title}`);
      if (!track.id || !track.title || seen.has(key)) continue;
      seen.add(key);
      tracks.push(track);
      if (tracks.length >= 25) break;
    }
    queuePlaybackWarmup(tracks);
    return res.json({ tracks });
  } catch (error) {
    return res.status(502).json({ error: `Sanatçı karışımı alınamadı: ${error.message}` });
  }
});

// Artist profiles, discography and artwork from the public iTunes catalog.
app.get('/api/artists/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 120);
  if (!query) return res.status(400).json({ error: 'Query q is required' });

  const cachedArtists = artistSearchCache.get(query.toLowerCase());
  if (cachedArtists && Date.now() - cachedArtists.at < SEARCH_TTL_MS) return res.json({ artists: cachedArtists.artists });

  try {
    const response = await axios.get('https://itunes.apple.com/search', {
      params: { term: query, entity: 'musicArtist', limit: 8 },
      timeout: 6000,
    });
    const artists = await Promise.all((response.data.results || []).slice(0, 6).map(async (artist) => {
      let image = '';
      try {
        const albumResponse = await axios.get('https://itunes.apple.com/search', {
          params: { term: artist.artistName, entity: 'album', limit: 1 },
          timeout: 3500,
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
    if (artistSearchCache.size >= 60) artistSearchCache.delete(artistSearchCache.keys().next().value);
    artistSearchCache.set(query.toLowerCase(), { at: Date.now(), artists });
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
        const page = encodeURIComponent(artist.artistName.replace(/ /g, '_'));
        const headers = { 'User-Agent': 'Sunify/1.0 (desktop music app)' };
        try {
          const turkishWiki = await axios.get(`https://tr.wikipedia.org/api/rest_v1/page/summary/${page}`, { timeout: 7000, headers });
          bio = turkishWiki.data.extract || '';
          profileImage = turkishWiki.data.thumbnail?.source || '';
        } catch (error) {}

        if (!bio) {
          const englishWiki = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`, { timeout: 7000, headers });
          const englishBio = englishWiki.data.extract || '';
          profileImage = profileImage || englishWiki.data.thumbnail?.source || '';
          if (englishBio) {
            try { bio = await translateArtistBioToTurkish(englishBio); } catch (error) { bio = ''; }
          }
        }
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
    if (req.query.prefetch === '1' && getActiveExtractions() >= 1) return res.json({ skipped: true });
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
  const cacheKey = String(req.query.cacheKey || '').trim();
  const excludeVideoIds = String(req.query.excludeIds || req.query.excludeId || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[a-zA-Z0-9_-]{11}$/.test(id))
    .slice(0, 5);
  const retrySearch = req.query.retrySearch === '1';
  if ((!target && !cacheKey) || target.length > 500) return res.status(400).json({ error: 'Video ID, arama sorgusu veya önbellek anahtarı gerekli.' });
  try {
    const requestStartedAt = Date.now();
    console.info(`[play-timing] request: ${target}`);
    const range = req.headers.range;
    const rangeStart = range && /^bytes=(\d+)-/.exec(range)?.[1];
    // Use yt-dlp's own progressive download path; the player reads the growing
    // cache file while the same download continues in the background.
    const audio = cacheKey
      ? await getCachedAudioByKey(cacheKey)
      : await startCachedAudioDownload(target, { priority: 'high', excludeVideoIds, retrySearch });
    console.info(`[play-timing] ${cacheKey || target} audio endpoint ready in ${Date.now() - requestStartedAt}ms (first audio bytes ${audio.timing?.firstBytesMs ?? 'cached'}ms)`);
    const cacheMetadata = {
      id: String(req.query.trackId || (/^[a-zA-Z0-9_-]{11}$/.test(String(req.query.id || '')) ? req.query.id : '')).slice(0, 80),
      query: String(req.query.trackQuery || (req.query.id ? '' : target)).slice(0, 500),
      title: String(req.query.title || '').trim().slice(0, 240),
      artist: String(req.query.artist || '').trim().slice(0, 200),
      thumbnail: String(req.query.thumbnail || '').slice(0, 2000),
      duration: Math.max(0, Number(req.query.duration) || 0),
    };
    const saveCacheMetadata = () => writeAudioCacheMetadata(audio.filePath, cacheMetadata);
    const hasResolvedTrackTitle = cacheMetadata.title && !cacheMetadata.title.startsWith('Önbelleğe alınan parça ');
    if (hasResolvedTrackTitle) {
      if (audio.complete) await saveCacheMetadata().catch((error) => console.warn('Önbellek bilgisi kaydedilemedi:', error.message));
      else audio.completion.then(saveCacheMetadata).catch(() => {});
    }
    const extension = path.extname(audio.filePath).toLowerCase();
    const rangeHeader = req.headers.range;
    const isSeeking = rangeHeader && !/^bytes=0-?(?:\d+)?$/.test(rangeHeader.trim());

    if (audio.complete || isSeeking) {
      await audio.completion;
      const stat = await fs.promises.stat(audio.filePath);
      return sendAudioFileRange(req, res, audio.filePath, stat);
    }

    const contentType = ({ '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.webm': 'audio/webm; codecs="opus"', '.opus': 'audio/ogg; codecs="opus"', '.ogg': 'audio/ogg' })[extension] || 'application/octet-stream';
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    const growingStream = audio.stream || createGrowingAudioStream(audio.filePath, audio.completion);
    growingStream.on('error', (streamError) => res.destroy(streamError));
    res.on('close', () => growingStream.destroy());
    return growingStream.pipe(res);
  } catch (error) {
    console.error('Ses akışı başlatılamadı:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: `Ses akışı başlatılamadı: ${error.message}` });
    } else {
      res.destroy(error);
    }
  }
});

// Resolves once the progressive download behind an /api/audio-stream URL is
// complete. The renderer uses this before seeking into a part of a growing
// stream that is not seekable yet; after completion the same stream URL is
// served as a regular range-capable file, so the seek lands where requested
// instead of restarting the track.
app.get('/api/audio-ready', async (req, res) => {
  const target = String(req.query.id || req.query.q || '').trim();
  const cacheKey = String(req.query.cacheKey || '').trim();
  const excludeVideoIds = String(req.query.excludeIds || req.query.excludeId || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[a-zA-Z0-9_-]{11}$/.test(id))
    .slice(0, 5);
  const retrySearch = req.query.retrySearch === '1';
  if ((!target && !cacheKey) || target.length > 500) return res.status(400).json({ error: 'Video ID, arama sorgusu veya önbellek anahtarı gerekli.' });
  try {
    const audio = cacheKey
      ? await getCachedAudioByKey(cacheKey)
      : await startCachedAudioDownload(target, { priority: 'high', excludeVideoIds, retrySearch });
    if (!audio.complete) await audio.completion;
    res.json({ ready: true });
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ ready: false, error: error.message });
  }
});

// Warm the next track's progressive cache shortly before the current track ends.
// startCachedAudioDownload returns as soon as the first playable bytes exist;
// the rest continues in the background and is shared with /api/audio-stream.
app.post('/api/audio-prefetch', async (req, res) => {
  const videoId = String(req.body?.videoId || '').trim();
  const query = String(req.body?.query || '').trim();
  const target = /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? videoId : query;
  if (!target || target.length > 500) return res.status(400).json({ error: 'Ön yükleme için geçerli parça bilgisi gerekli.' });
  try {
    const result = await startCachedAudioDownload(target, { priority: 'low' });
    const metadata = {
      id: /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? videoId : String(req.body?.trackId || ''),
      query: String(req.body?.query || '').slice(0, 500),
      title: String(req.body?.title || '').trim().slice(0, 240),
      artist: String(req.body?.artist || '').trim().slice(0, 200),
      thumbnail: String(req.body?.thumbnail || '').slice(0, 2000),
      duration: Math.max(0, Number(req.body?.duration) || 0),
    };
    if (metadata.title) {
      const persist = () => writeAudioCacheMetadata(result.filePath, metadata);
      if (result.complete) await persist();
      else void result.completion.then(persist).catch((error) => console.warn('Ön hazırlık bilgisi kaydedilemedi:', error.message));
    }
    res.json({ ready: true, cached: Boolean(result.complete) });
  } catch (error) {
    res.status(502).json({ error: `Sıradaki parça önceden hazırlanamadı: ${error.message}` });
  }
});

app.post('/api/audio-cache', async (req, res) => {
  try {
    res.json({ tracks: await listCachedAudioFiles(req.body?.tracks) });
  } catch (error) {
    console.warn('Ses önbelleği eşleştirilemedi:', error.message);
    res.status(500).json({ error: 'Ses önbelleği eşleştirilemedi.' });
  }
});

app.get('/api/audio-cache', async (_req, res) => {
  try {
    res.json({ tracks: await listCachedAudioFiles() });
  } catch (error) {
    console.warn('Ses önbelleği listelenemedi:', error.message);
    res.json({ tracks: [] });
  }
});

// LRCLIB ve Çoklu Şarkı Sözleri (Seçilebilir Kaynak)
app.get('/api/lyrics', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim().slice(0, 200);
  const duration = req.query.duration;
  const requestedSource = String(req.query.source || 'auto');
  if (!title) return res.status(400).json({ error: 'Title required' });
  if (title.length > 240) return res.status(400).json({ error: 'Şarkı adı çok uzun.' });
  const source = ['auto', 'lrclib', 'netease', 'kugou', 'genius', 'lyricsovh'].includes(requestedSource) ? requestedSource : 'auto';
  const controller = new AbortController();
  const abortForClosedClient = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', abortForClosedClient);

  try {
    const result = await fetchLyrics(title, artist, duration, source, { signal: controller.signal });
    if (!res.destroyed && !res.writableEnded) res.json(result);
  } catch (error) {
    if (!res.destroyed && !res.writableEnded && !controller.signal.aborted) {
      res.status(502).json({ error: 'Şarkı sözleri alınamadı.', detail: error.message });
    }
  } finally {
    res.off('close', abortForClosedClient);
  }
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
    const ytRes = await cachedYtSearch(cleanTerm);
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
                thumbnail: PLACEHOLDER_COVER,
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
          thumbnail || PLACEHOLDER_COVER,
        tracks: tracks,
      });
    }

    return res.status(400).json({ error: 'Desteklenmeyen çalma listesi bağlantısı.' });
  } catch (err) {
    res.status(500).json({ error: 'İçe aktarma hatası: ' + err.message });
  }
});

const DOWNLOADS_DIR = process.env.SUNIFY_DOWNLOADS_DIR || path.join(__dirname, 'downloads');
let downloadLimitBytes = 5 * 1024 * 1024 * 1024;
let activeDownloadBytes = 0;
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

async function directorySizeBytes(directory, excludePartial = false) {
  let total = 0;
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySizeBytes(filePath, excludePartial);
    else if (entry.isFile()) {
      if (excludePartial && entry.name.endsWith('.part')) continue;
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat?.isFile()) total += stat.size;
    }
  }
  return total;
}

async function getStorageStats() {
  const [downloadsBytes, audioCache] = await Promise.all([
    directorySizeBytes(DOWNLOADS_DIR),
    getAudioCacheStats(),
  ]);
  let localMusicBytes = 0;
  for (const directory of ALLOWED_MUSIC_DIRS) {
    if (path.resolve(directory) === path.resolve(DOWNLOADS_DIR)) continue;
    const musicFiles = await scanDirectoryForMusic(directory, 3);
    localMusicBytes += musicFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  }
  return {
    downloadsBytes,
    localMusicBytes,
    audioCacheBytes: audioCache.bytes,
    totalBytes: downloadsBytes + localMusicBytes + audioCache.bytes,
    audioCacheFiles: audioCache.files,
    audioCacheLimitBytes: audioCache.limitBytes,
    downloadLimitBytes: downloadLimitBytes === Infinity ? 0 : downloadLimitBytes,
    activeDownloadBytes,
    cacheDirectory: audioCache.directory,
  };
}

app.get('/api/storage/stats', async (_req, res) => {
  try { res.json(await getStorageStats()); }
  catch (error) { res.status(500).json({ error: `Depolama bilgisi alınamadı: ${error.message}` }); }
});

app.post('/api/storage/settings', async (req, res) => {
  const downloadGB = Number(req.body?.downloadLimitGB);
  const cacheGB = Number(req.body?.cacheLimitGB);
  if (![0, 2, 5, 20].includes(downloadGB) || ![0, 1, 3, 10].includes(cacheGB)) {
    return res.status(400).json({ error: 'Depolama sınırı seçimi geçersiz.' });
  }
  downloadLimitBytes = downloadGB === 0 ? Infinity : downloadGB * 1024 * 1024 * 1024;
  try {
    setAudioCacheLimit(cacheGB);
    await getAudioCacheStats();
    res.json({ success: true, ...(await getStorageStats()) });
  } catch (error) { res.status(500).json({ error: `Depolama ayarları uygulanamadı: ${error.message}` }); }
});

app.post('/api/audio-cache/clear', async (_req, res) => {
  try {
    const cleared = await clearAudioCache();
    res.json({ success: true, ...cleared, ...(await getStorageStats()) });
  } catch (error) { res.status(500).json({ error: `Önbellek temizlenemedi: ${error.message}` }); }
});

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

async function scanDirectoryForMusic(dirPath, maxDepth = 3, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  let found = [];
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
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
        found = found.concat(await scanDirectoryForMusic(full, maxDepth, currentDepth + 1));
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          // Çok küçük sistem seslerini (örn 50KB altı click sesleri) filtrele
          try {
            const stat = await fs.promises.stat(full);
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
app.get('/api/local-downloads', async (req, res) => {
  try {
    const scanDirs = [DOWNLOADS_DIR, ...ALLOWED_MUSIC_DIRS];

    const seenPaths = new Set();
    const allFiles = [];

    for (const d of scanDirs) {
      if (fs.existsSync(d)) {
        const filesInDir = await scanDirectoryForMusic(d, 3);
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
        size: fileObj.size,
        localUrl: safeLocalUrl,
        thumbnail: PLACEHOLDER_COVER,
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

  let reservedBytes = 0;
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

    const downloadsBytes = await directorySizeBytes(DOWNLOADS_DIR, true);
    if (downloadLimitBytes !== Infinity && downloadsBytes + activeDownloadBytes >= downloadLimitBytes) {
      return res.status(507).json({ error: 'İndirme alanı sınırına ulaşıldı. Ayarlar > Önbellek ve Depolama bölümünden sınırı artırın veya eski dosyaları kaldırın.' });
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

    const contentLength = Number(response.headers?.['content-length']) || 0;
    if (downloadLimitBytes !== Infinity && contentLength > 0 && downloadsBytes + activeDownloadBytes + contentLength > downloadLimitBytes) {
      response.data.destroy();
      return res.status(507).json({ error: 'Bu dosya seçili indirme alanı sınırını aşar. Ayarlardan daha yüksek sınır seçin.' });
    }

    const writer = fs.createWriteStream(tempPath, { flags: 'w' });
    const quotaGuard = new Transform({
      transform(chunk, _encoding, callback) {
        if (downloadLimitBytes !== Infinity && downloadsBytes + activeDownloadBytes + chunk.length > downloadLimitBytes) {
          const error = new Error('İndirme alanı sınırına ulaşıldı. Ayarlardan sınırı artırın veya eski dosyaları kaldırın.');
          error.code = 'SUNIFY_DOWNLOAD_LIMIT';
          callback(error);
          return;
        }
        activeDownloadBytes += chunk.length;
        reservedBytes += chunk.length;
        callback(null, chunk);
      },
    });
    await new Promise((resolve, reject) => {
      response.data.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', resolve);
      quotaGuard.on('error', (error) => { response.data.destroy(); writer.destroy(error); reject(error); });
      response.data.pipe(quotaGuard).pipe(writer);
    });
    if (fs.statSync(tempPath).size < 1000) throw new Error('İndirilen dosya boş veya eksik.');
    fs.renameSync(tempPath, filePath);
    res.json({ success: true, fileName, localUrl: `http://${HOST}:${app.locals.port || PORT}/downloaded/${encodeURIComponent(fileName)}` });
  } catch (err) {
    try { if (req.downloadTempPath) fs.unlinkSync(req.downloadTempPath); } catch {}
    if (!res.headersSent) res.status(err.code === 'SUNIFY_DOWNLOAD_LIMIT' ? 507 : 500).json({ error: err.code === 'SUNIFY_DOWNLOAD_LIMIT' ? err.message : 'İndirme hatası: ' + err.message });
  } finally {
    activeDownloadBytes = Math.max(0, activeDownloadBytes - reservedBytes);
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
      headers: getAudioRequestHeaders(streamData),
    });

    audioStream.data.on('error', (error) => res.destroy(error));
    res.on('close', () => audioStream.data.destroy());
    audioStream.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'İndirme hatası: ' + err.message });
  }
});

// Görselden Baskın Renk Çıkarma (Şarkı Sözü Arka Planı İçin)
const extractedColorCache = new Map();
const ALLOWED_COVER_HOSTS = ['ytimg.com', 'googleusercontent.com', 'mzstatic.com', 'apple.com'];
app.get('/api/extract-color', async (req, res) => {
  const imageUrl = String(req.query.url || '');
  if (!imageUrl) return res.json({ rgb: [234, 179, 8], hex: '#eab308' });

  try {
    const parsedUrl = new URL(imageUrl);
    const allowedHost = ALLOWED_COVER_HOSTS.some((domain) => parsedUrl.hostname === domain || parsedUrl.hostname.endsWith(`.${domain}`));
    if (parsedUrl.protocol !== 'https:' || !allowedHost || parsedUrl.username || parsedUrl.password) {
      return res.status(400).json({ error: 'Kapak görseli adresine izin verilmiyor.' });
    }
    const cachedColor = extractedColorCache.get(parsedUrl.href);
    if (cachedColor) return res.json(cachedColor);

    const imageResponse = await axios.get(parsedUrl.href, {
      responseType: 'arraybuffer',
      timeout: 6000,
      maxContentLength: 4 * 1024 * 1024,
      maxRedirects: 0,
      headers: { 'User-Agent': 'Sunify/1.0 (cover color)' },
    });
    const imageBuffer = Buffer.from(imageResponse.data);
    const isPng = imageBuffer.length >= 8 && imageBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = imageBuffer.length >= 3 && imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff;
    if (!isPng && !isJpeg) return res.json({ rgb: [234, 179, 8], hex: '#eab308' });

    const Vibrant = require('node-vibrant');
    const palette = await Vibrant.from(imageBuffer).getPalette();
    const dominant =
      palette.Vibrant || palette.DarkVibrant || palette.Muted || palette.LightVibrant;
    if (dominant) {
      const color = {
        rgb: dominant.rgb.map(Math.round),
        hex: dominant.hex,
      };
      if (extractedColorCache.size >= 100) extractedColorCache.delete(extractedColorCache.keys().next().value);
      extractedColorCache.set(parsedUrl.href, color);
      return res.json(color);
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
  const { email, password, username } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'E-posta ve şifre zorunludur.' });
  }
  const supabase = getSupabase();
  if (supabase && isConfigured()) {
    try {
      const { data, error } = await supabase.auth.signUp({
        email: String(email).trim().toLowerCase(),
        password,
        options: {
          data: { username: String(username || '').trim().slice(0, 60) || String(email).split('@')[0] },
          emailRedirectTo: 'sunify://auth/callback',
        },
      });
      if (error) {
        const status = error.status === 429 ? 429 : error.status >= 500 ? 502 : 400;
        const message = /already registered|already been registered|user already exists/i.test(error.message || '')
          ? 'Bu e-posta adresiyle zaten bir hesap var.'
          : status === 429
            ? 'Çok fazla kayıt denemesi yapıldı. Biraz sonra tekrar deneyin.'
            : status === 502
              ? 'Bulut kayıt hizmeti şu an yanıt vermiyor. Yerel hesap oluşturulmadı.'
              : error.message || 'Bulut hesabı oluşturulamadı.';
        return res.status(status).json({ error: message, mode: 'cloud' });
      }
      if (!data.user) return res.status(502).json({ error: 'Supabase hesap kaydı tamamlanamadı. Yerel hesap oluşturulmadı.', mode: 'cloud' });
      if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        return res.status(409).json({ error: 'Bu e-posta adresiyle zaten bir hesap var.', mode: 'cloud' });
      }
      if (!data.session) {
        return res.status(202).json({ success: true, mode: 'cloud', requiresEmailConfirmation: true, user: data.user });
      }
      return res.json({ success: true, mode: 'cloud', user: data.user, session: data.session });
    } catch (error) {
      return res.status(502).json({ error: `Bulut kayıt hizmetine ulaşılamadı: ${error.message}. Yerel hesap oluşturulmadı.`, mode: 'cloud' });
    }
  }

  try {
    const localSession = registerUser(username, email, password);
    return res.json({ success: true, mode: 'offline', user: localSession.user, session: localSession });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Yerel hesap oluşturulamadı.', mode: 'offline' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const revoked = revokeSession(token);
  let cloudSessionRevoked = false;
  const refreshToken = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
  const supabase = getSupabase();
  if (!revoked && supabase && refreshToken) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      const client = createClient(currentConfig.url, currentConfig.anonKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const { error: sessionError } = await client.auth.setSession({ access_token: token, refresh_token: refreshToken });
      if (!sessionError) {
        const { error } = await client.auth.signOut({ scope: 'local' });
        cloudSessionRevoked = !error;
      }
    } catch (error) {
      console.warn('Bulut oturumu uzaktan sonlandırılamadı:', error.message);
    }
  }
  res.json({ success: true, localSessionRevoked: revoked, cloudSessionRevoked });
});

app.post('/api/auth/session', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Oturum anahtarı gerekli.' });
  if (token.startsWith('local_session_')) {
    return getUserIdForToken(token)
      ? res.json({ success: true, valid: true, mode: 'offline' })
      : res.status(401).json({ error: 'Bu cihazdaki oturumun süresi dolmuş. Yeniden giriş yap.' });
  }
  if (!isConfigured()) return res.status(503).json({ error: 'Bulut oturumu doğrulanamıyor; Supabase yapılandırmasını kontrol edin.' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const client = createClient(currentConfig.url, currentConfig.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (!error && data.user) return res.json({ success: true, valid: true, mode: 'cloud' });
    const refreshToken = typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : '';
    if (refreshToken) {
      const { data: refreshed, error: refreshError } = await client.auth.refreshSession({ refresh_token: refreshToken });
      if (!refreshError && refreshed.session && refreshed.user) {
        return res.json({ success: true, valid: true, mode: 'cloud', user: refreshed.user, session: refreshed.session, refreshed: true });
      }
    }
    return res.status(401).json({ error: 'Oturumun süresi dolmuş. Lütfen yeniden giriş yap.' });
  } catch (error) {
    return res.status(503).json({ error: `Oturum doğrulanamadı: ${error.message}` });
  }
});

// Delete only the account represented by the authenticated session, after password re-entry.
app.post('/api/auth/delete-account', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!token || !password) return res.status(400).json({ error: 'Oturum ve hesap şifresi gerekli.' });

  if (token.startsWith('local_session_')) {
    try {
      const account = deleteUserAccount(token, password);
      return res.json({ success: true, deletedEmail: account.email });
    } catch (error) {
      return res.status(401).json({ error: error.message || 'Şifre doğrulanamadı.' });
    }
  }

  if (!isConfigured() || !currentConfig.url || !currentConfig.anonKey) {
    return res.status(503).json({ error: 'Bulut hesabı silme için Supabase yapılandırması eksik.' });
  }
  try {
    const endpoint = `${currentConfig.url.replace(/\/$/, '')}/functions/v1/sunify-delete-account`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: currentConfig.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: data.error || 'Bulut hesabı silinemedi.' });
    try { deleteLocalAccountForEmail(data.deletedEmail); }
    catch (cleanupError) { console.warn('Bulut hesabı silindi ancak yerel hesap kaydı temizlenemedi:', cleanupError.message); }
    return res.json({ success: true, deletedEmail: data.deletedEmail });
  } catch (error) {
    return res.status(502).json({ error: `Supabase hesap silme servisine ulaşılamadı: ${error.message}` });
  }
});

// Giriş Yapma (Sign In)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'E-posta ve şifre zorunludur.' });
  }

  const supabase = getSupabase();
  if (supabase && isConfigured()) {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password });
      if (!error && data.session) {
        return res.json({ success: true, mode: 'cloud', user: data.user, session: data.session });
      }
      if (error) {
        const status = error.status === 429 ? 429 : error.status >= 500 ? 502 : 401;
        const errorCode = String(error.code || '').toLowerCase();
        const message = /email_not_confirmed/i.test(errorCode) || /email not confirmed/i.test(error.message || '')
          ? 'E-posta adresin doğrulanmamış. Gelen kutundaki doğrulama bağlantısını aç.'
          : status === 429
            ? 'Çok fazla giriş denemesi yapıldı. Biraz sonra tekrar deneyin.'
            : status === 502
              ? 'Bulut giriş hizmeti şu an yanıt vermiyor. Tekrar deneyin.'
              : 'E-posta veya şifre hatalı.';
        return res.status(status).json({ error: message, mode: 'cloud' });
      }
      return res.status(502).json({ error: 'Bulut hesabında oturum açılamadı.', mode: 'cloud' });
    } catch (error) {
      // Only a transport failure permits trying an existing offline account.
      if (error?.status || error?.code && !['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) {
        return res.status(502).json({ error: `Bulut giriş hizmetiyle bağlantı kurulamadı: ${error.message}`, mode: 'cloud' });
      }
      try {
        const localSession = loginUser(email, password);
        return res.json({ success: true, mode: 'offline', user: localSession.user, session: localSession, cloudUnavailable: true });
      } catch {
        return res.status(503).json({ error: 'Bulut giriş hizmetine ulaşılamıyor; bu cihazda eşleşen çevrimdışı hesap da bulunamadı.', mode: 'offline' });
      }
    }
  }

  try {
    const localSession = loginUser(email, password);
    return res.json({ success: true, mode: 'offline', user: localSession.user, session: localSession });
  } catch (error) {
    return res.status(401).json({ error: error.message || 'E-posta veya şifre hatalı.', mode: 'offline' });
  }
});

// Kurtarılan kişisel dinleme istatistiklerini (129 parça) sunify_users.json yedeğinden okuma uç noktası
app.get('/api/sync/recovered-stats', (_req, res) => {
  try {
    const dbFile = process.env.SUNIFY_USER_DB_FILE || path.join(__dirname, '../data/sunify_users.json');
    if (fs.existsSync(dbFile)) {
      const users = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      const userWithStats = (Array.isArray(users) ? users : []).find(
        (u) => u && u.listeningStats && Object.values(u.listeningStats).some((e) => e && Number(e.playCount) > 0)
      );
      if (userWithStats?.listeningStats) {
        return res.json({ listeningStats: userWithStats.listeningStats });
      }
    }
  } catch {}
  return res.json({ listeningStats: null });
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
      playlists: (playlists || []).map((playlist) => ({ ...playlist, id: playlist.client_id || playlist.id })),
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

    const { error: resetError } = await userSupabase.rpc('sync_sunify_account_data', {
      p_playlists: [],
      p_liked_tracks: [],
      p_listening_stats: {},
    });
    if (resetError) throw resetError;
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
  const { playlists, likedTracks, listeningStats } = req.body || {};

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

  if (!Array.isArray(playlists) || !Array.isArray(likedTracks)
    || !listeningStats || typeof listeningStats !== 'object' || Array.isArray(listeningStats)) {
    return res.status(400).json({ error: 'Bulut eşitlemesi için playlist, beğeni ve dinleme verisi geçerli tam biçimde gerekli.' });
  }
  if (playlists.length > 500 || likedTracks.length > 5000 || Object.keys(listeningStats).length > 10000) {
    return res.status(413).json({ error: 'Hesap verisi eşitleme sınırını aşıyor.' });
  }
  if (playlists.some((playlist) => !playlist || typeof playlist !== 'object' || Array.isArray(playlist)
    || !String(playlist.name || '').trim() || (playlist.tracks !== undefined && !Array.isArray(playlist.tracks)))) {
    return res.status(400).json({ error: 'Çalma listesi verilerinden biri geçersiz.' });
  }

  try {
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Geçersiz oturum' });
    const userSupabase = getSupabaseForToken(token);
    if (!userSupabase) return res.status(400).json({ error: 'Supabase kullanıcı oturumu oluşturulamadı.' });

    const { error: syncError } = await userSupabase.rpc('sync_sunify_account_data', {
      p_playlists: playlists,
      p_liked_tracks: likedTracks,
      p_listening_stats: listeningStats,
    });
    if (syncError) throw syncError;

    res.json({ success: true, message: 'Bulut senkronizasyonu tamamlandı.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Keep malformed and oversized API requests in the same JSON error format as other endpoints.
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status || error.statusCode) || 500;
  const message = status === 413
    ? 'İstek gövdesi izin verilen boyutu aşıyor.'
    : status < 500
      ? error.message || 'İstek geçersiz.'
      : 'Sunucu isteği tamamlayamadı.';
  res.status(status).json({ error: message });
});

let serverInstance = null;
function startServer(options = {}) {
  if (typeof options === 'function') options = { onReady: options };
  if (serverInstance) {
    if (options.onReady) options.onReady(app.locals.port);
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
    setTimeout(() => warmUp(), 1500);
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
        if (options.onReady) options.onReady(actualPort);
        setTimeout(() => warmUp(), 1500);
      });
      fallbackServer.on('error', (fallbackError) => {
        serverInstance = null;
        if (options.onError) options.onError(fallbackError);
        else console.error('Sunify sunucusu başlatılamadı:', fallbackError.message);
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

