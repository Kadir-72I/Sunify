const axios = require('axios');

const LRCLIB = 'https://lrclib.net/api';
const NETEASE = 'https://music.163.com';
const GENIUS_SEARCH = 'https://genius.com/api/search/multi';
const KUGOU_SEARCH = 'http://songsearch.kugou.com/song_search_v2';
const KUGOU_LRC_SEARCH = 'http://lyrics.kugou.com/search';
const KUGOU_LRC_DOWNLOAD = 'http://lyrics.kugou.com/download';
const LYRICS_OVH = 'https://api.lyrics.ovh/v1';

const RESULT_TTL_MS = 12 * 60 * 60 * 1000;
const MISS_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_SIZE = 300;
const resultCache = new Map();
const pendingRequests = new Map();

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cacheKey(title, artist, duration, source) {
  return [normalize(title), normalize(artist), Math.round(Number(duration) || 0), source].join('|');
}

function cacheSet(key, value) {
  if (resultCache.size >= MAX_CACHE_SIZE) resultCache.delete(resultCache.keys().next().value);
  resultCache.set(key, { value, expiresAt: Date.now() + (value.success ? RESULT_TTL_MS : MISS_TTL_MS) });
}

function getCached(key) {
  const item = resultCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    resultCache.delete(key);
    return null;
  }
  resultCache.delete(key);
  resultCache.set(key, item);
  return item.value;
}

function failure(source = 'Otomatik') {
  return { success: false, syncedLyrics: null, plainLyrics: null, source };
}

function titleSimilarity(target, candidate) {
  const a = normalize(target);
  const b = normalize(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const aWords = new Set(a.split(' '));
  const bWords = new Set(b.split(' '));
  const common = [...aWords].filter((word) => bWords.has(word)).length;
  return (2 * common) / (aWords.size + bWords.size);
}

function candidateScore(candidate, title, artist, duration) {
  const titleScore = titleSimilarity(title, candidate.trackName || candidate.name);
  const artistScore = titleSimilarity(artist, candidate.artistName || candidate.artist);
  const candidateDuration = Number(candidate.duration) || 0;
  const wantedDuration = Number(duration) || 0;
  const durationScore = candidateDuration && wantedDuration
    ? Math.max(0, 1 - Math.abs(candidateDuration - wantedDuration) / Math.max(12, wantedDuration * 0.22))
    : 0.5;
  return titleScore * 0.64 + artistScore * 0.25 + durationScore * 0.11;
}

function chooseCandidate(candidates, title, artist, duration) {
  return candidates
    .filter((item) => item && (item.syncedLyrics || item.plainLyrics))
    .map((item) => ({ item, score: candidateScore(item, title, artist, duration) }))
    .filter(({ item, score }) => score >= (item.syncedLyrics ? 0.48 : 0.58))
    .sort((a, b) => b.score - a.score)[0]?.item || null;
}

function formatLrclib(item, requestedDuration) {
  if (!item) return null;
  const durationGap = Number(requestedDuration) && Number(item.duration)
    ? Math.abs(Number(requestedDuration) - Number(item.duration))
    : 0;
  return {
    success: Boolean(item.syncedLyrics || item.plainLyrics),
    syncedLyrics: item.syncedLyrics || null,
    plainLyrics: item.plainLyrics || null,
    source: item.syncedLyrics ? 'LRCLIB (Senkron)' : 'LRCLIB (Düz)',
    durationGap,
  };
}

function axiosOptions(signal, timeout = 3500) {
  return {
    timeout,
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  };
}

// 1. LRCLIB Provider (Açık kaynak senkronize söz arşivi)
async function fetchLrclib(title, artist, duration, signal) {
  const roundedDuration = Math.round(Number(duration) || 0);
  const exactRequest = axios.get(`${LRCLIB}/get`, {
    ...axiosOptions(signal),
    params: { track_name: title, artist_name: artist || undefined, duration: roundedDuration || undefined },
  }).then((response) => response.data).catch(() => null);

  const queries = [
    `${title} ${artist}`.trim(),
    title,
  ];
  const searchRequests = queries.map((q) => axios.get(`${LRCLIB}/search`, {
    ...axiosOptions(signal), params: { q },
  }).then((response) => Array.isArray(response.data) ? response.data : []).catch(() => []));

  const [exact, ...searchResults] = await Promise.all([exactRequest, ...searchRequests]);
  if (exact && (exact.syncedLyrics || exact.plainLyrics)) {
    const score = candidateScore(exact, title, artist, duration);
    if (score >= 0.48) return formatLrclib(exact, duration);
  }
  const candidate = chooseCandidate(searchResults.flat(), title, artist, duration);
  return candidate ? formatLrclib(candidate, duration) : null;
}

// 2. NetEase Provider (Geniş Asya ve Küresel Senkronize Arşiv)
async function fetchNetease(title, artist, duration, signal) {
  const query = `${title} ${artist || ''}`.trim();
  const search = await axios.get(`${NETEASE}/api/search/get`, {
    ...axiosOptions(signal, 2800),
    params: { s: query, type: 1, limit: 8 },
    headers: { ...axiosOptions(signal).headers, Referer: `${NETEASE}/` },
  });
  const songs = search.data?.result?.songs || [];
  const candidates = songs.map((song) => ({
    trackName: song.name,
    artistName: song.artists?.map((entry) => entry.name).join(' '),
    duration: (Number(song.duration) || 0) / 1000,
    id: song.id,
  }));
  const chosen = chooseCandidate(candidates, title, artist, duration);
  if (!chosen) return null;
  const song = songs.find((entry) => String(entry.id) === String(chosen.id));
  if (!song) return null;

  const lyricResponse = await axios.get(`${NETEASE}/api/song/lyric`, {
    ...axiosOptions(signal, 2800), params: { id: song.id, lv: -1, tv: -1 },
    headers: { ...axiosOptions(signal).headers, Referer: `${NETEASE}/` },
  });
  const syncedLyrics = lyricResponse.data?.lrc?.lyric || null;
  const plainLyrics = lyricResponse.data?.tlyric?.lyric || null;
  if (!syncedLyrics && !plainLyrics) return null;
  return { success: true, syncedLyrics, plainLyrics, source: syncedLyrics ? 'NetEase (Senkron)' : 'NetEase (Düz)' };
}

// 3. Kugou Provider (Milyonlarca senkronize .LRC)
async function fetchKugou(title, artist, duration, signal) {
  try {
    const query = `${title} ${artist || ''}`.trim();
    const searchRes = await axios.get(KUGOU_SEARCH, {
      ...axiosOptions(signal, 3000),
      params: { keyword: query, page: 1, pagesize: 5, clientver: '' },
    });
    const songList = searchRes.data?.data?.lists || [];
    if (!songList.length) return null;

    const topSongs = songList.slice(0, 3);
    for (const song of topSongs) {
      if (!song.FileHash) continue;
      const lrcSearch = await axios.get(KUGOU_LRC_SEARCH, {
        ...axiosOptions(signal, 2500),
        params: { ver: 1, man: 'yes', client: 'pc', hash: song.FileHash, duration: (song.Duration || 0) * 1000 },
        headers: { ...axiosOptions(signal).headers, 'User-Agent': 'KuGou' },
      }).catch(() => null);

      const candidate = lrcSearch?.data?.candidates?.[0];
      if (!candidate?.id || !candidate?.accesskey) continue;

      const dl = await axios.get(KUGOU_LRC_DOWNLOAD, {
        ...axiosOptions(signal, 2500),
        params: { ver: 1, client: 'pc', id: candidate.id, accesskey: candidate.accesskey, fmt: 'lrc', charset: 'utf8' },
      }).catch(() => null);

      const base64Content = dl?.data?.content || '';
      if (!base64Content) continue;
      const decodedLrc = Buffer.from(base64Content, 'base64').toString('utf8').trim();
      if (decodedLrc && decodedLrc.includes('[')) {
        return {
          success: true,
          syncedLyrics: decodedLrc,
          plainLyrics: null,
          source: 'Kugou (Senkron)',
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// 4. Gerçek Genius API & Web Scraper (Özellikle Türkçe Şarkıların %98'ini Kapsar)
function cleanGeniusLyrics(html) {
  const regex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi;
  let match;
  const parts = [];
  while ((match = regex.exec(html)) !== null) {
    const clean = match[1]
      .replace(/<br\s*[\/]?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '');
    parts.push(clean);
  }
  let text = parts.join('\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

  // Genius meta metinlerini ve sayaçları temizle
  text = text.replace(/^[0-9]+\s+Contributors[\s\S]*?Lyrics\s*/i, '');
  text = text.replace(/^[0-9]+\s+Contributors[^\n]*\n?/i, '');
  text = text.replace(/Embed$/i, '').trim();
  return text;
}

async function fetchGenius(title, artist, signal) {
  try {
    const queries = [
      `${title} ${artist || ''}`.trim(),
      artist ? `${artist} ${title}` : title,
    ];
    let songHit = null;

    for (const q of queries) {
      const searchRes = await axios.get(GENIUS_SEARCH, {
        timeout: 3200,
        signal,
        params: { q },
        headers: {
          'User-Agent': 'Genius/2.3.0 (Android; 10; Scale/2.0)',
          'Accept': 'application/json',
        },
      }).catch(() => null);

      const songSection = searchRes?.data?.response?.sections?.find((sec) => sec.type === 'song');
      const hits = songSection?.hits || [];
      if (hits.length > 0 && hits[0].result?.url) {
        songHit = hits[0].result;
        break;
      }
    }

    if (!songHit?.url) return null;

    const pageRes = await axios.get(songHit.url, {
      timeout: 3500,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }).catch(() => null);

    if (!pageRes?.data) return null;

    const lyricsText = cleanGeniusLyrics(pageRes.data);
    if (!lyricsText || lyricsText.length < 20) return null;

    return {
      success: true,
      syncedLyrics: null,
      plainLyrics: lyricsText,
      source: 'Genius (Düz)',
    };
  } catch {
    return null;
  }
}

// 5. Lyrics.ovh Fallback Provider
async function fetchLyricsOvh(title, artist, signal) {
  if (!artist) return null;
  try {
    const response = await axios.get(`${LYRICS_OVH}/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, axiosOptions(signal, 2500));
    const lyrics = String(response.data?.lyrics || '').trim();
    return lyrics ? { success: true, syncedLyrics: null, plainLyrics: lyrics, source: 'Lyrics.ovh (Düz)' } : null;
  } catch {
    return null;
  }
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED';
}

async function findLyrics(title, artist, duration, source, signal) {
  if (source === 'lrclib') {
    const res = await fetchLrclib(title, artist, duration, signal).catch(() => null);
    return res || failure('LRCLIB');
  }
  if (source === 'netease') {
    const res = await fetchNetease(title, artist, duration, signal).catch(() => null);
    return res || failure('NetEase');
  }
  if (source === 'kugou') {
    const res = await fetchKugou(title, artist, duration, signal).catch(() => null);
    return res || failure('Kugou');
  }
  if (source === 'genius') {
    const res = await fetchGenius(title, artist, signal).catch(() => null);
    return res || failure('Genius');
  }
  if (source === 'lyricsovh') {
    const res = await fetchLyricsOvh(title, artist, signal).catch(() => null);
    return res || failure('Lyrics.ovh');
  }

  // AUTO MODU: Akıllı Çok Katmanlı Şarkı Sözü Bulma
  // 1. Senkron Arayıcılar (LRCLIB, NetEase, Kugou)
  const syncProviders = [
    () => fetchLrclib(title, artist, duration, signal),
    () => fetchKugou(title, artist, duration, signal),
    () => fetchNetease(title, artist, duration, signal),
  ];

  // 2. Kapsamlı Düz Metin Arayıcılar (Genius - Türkiye & Global Arşiv, Lyrics.ovh)
  const plainProviders = [
    () => fetchGenius(title, artist, signal),
    () => fetchLyricsOvh(title, artist, signal),
  ];

  const syncJobs = syncProviders.map((fn) => Promise.resolve().then(fn).catch((err) => {
    if (isAbort(err, signal)) throw err;
    return null;
  }));

  // İlk senkronize sözü beklemeden ekrana yansıtmak için yarış
  const firstSyncedPromise = Promise.any(
    syncJobs.map((job) => job.then((res) => (res?.syncedLyrics ? res : Promise.reject())))
  ).catch(() => null);

  const timedSynced = await Promise.race([
    firstSyncedPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);

  if (signal?.aborted) throw new axios.CanceledError('Lyrics request cancelled');
  if (timedSynced) return timedSynced;

  // Senkron bulunamazsa düz metin kaynaklarını (Genius vb.) devreye sok
  const plainJobs = plainProviders.map((fn) => Promise.resolve().then(fn).catch((err) => {
    if (isAbort(err, signal)) throw err;
    return null;
  }));

  const allResults = await Promise.all([...syncJobs, ...plainJobs]);

  const synced = allResults.find((item) => item?.syncedLyrics);
  if (synced) return synced;

  const plain = allResults.find((item) => item?.success && item?.plainLyrics);
  if (plain) return plain;

  return failure();
}

async function fetchLyrics(title, artist, duration, source = 'auto', options = {}) {
  const safeTitle = String(title || '').trim().slice(0, 240);
  const safeArtist = String(artist || '').trim().slice(0, 200);
  const allowedSources = ['auto', 'lrclib', 'netease', 'kugou', 'genius', 'lyricsovh'];
  const safeSource = allowedSources.includes(source) ? source : 'auto';
  const signal = options?.signal;
  if (!safeTitle) return failure();
  if (signal?.aborted) throw new axios.CanceledError('Lyrics request cancelled');

  const key = cacheKey(safeTitle, safeArtist, duration, safeSource);
  const cached = getCached(key);
  if (cached) return cached;

  if (!signal && pendingRequests.has(key)) return pendingRequests.get(key);

  const pending = findLyrics(safeTitle, safeArtist, duration, safeSource, signal)
    .then((result) => {
      cacheSet(key, result || failure());
      return result || failure();
    })
    .finally(() => {
      if (pendingRequests.get(key) === pending) pendingRequests.delete(key);
    });

  if (!signal) pendingRequests.set(key, pending);
  return pending;
}

module.exports = { fetchLyrics };
