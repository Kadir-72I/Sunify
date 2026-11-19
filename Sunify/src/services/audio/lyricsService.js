const axios = require('axios');
const { execFile } = require('child_process');

const LRCLIB = 'https://lrclib.net/api';
const NETEASE = 'https://music.163.com';
const GENIUS_SEARCH = 'https://genius.com/api/search/multi';
const KUGOU_SEARCH = 'http://songsearch.kugou.com/song_search_v2';
const KUGOU_MOBILE_SEARCH = 'http://mobilecdn.kugou.com/api/v3/search/song';
const KUGOU_LRC_SEARCH = 'http://lyrics.kugou.com/search';
const KUGOU_LRC_DOWNLOAD = 'http://lyrics.kugou.com/download';
const SARKISOZUM_BASE = 'https://www.sarkisozum.gen.tr';
const LYRICS_OVH = 'https://api.lyrics.ovh/v1';

const RESULT_TTL_MS = 12 * 60 * 60 * 1000;
const MISS_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_SIZE = 300;
const resultCache = new Map();
const pendingRequests = new Map();

function normalize(value) {
  return String(value || '')
    .replace(/[ıİ]/g, 'i')
    .replace(/[şŞ]/g, 's')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u')
    .replace(/[öÖ]/g, 'o')
    .replace(/[çÇ]/g, 'c')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanQueryMeta(value) {
  return String(value || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:offiziell|official|resmi|hd|4k|audio|video|clip|klip|lyrics?|sarki sozu|şarkı sözü|prod\.?[^)]*|explicit|Visualizer)[^)]*\)/gi, ' ')
    .replace(/\b(?:offiziell\s*hd|official\s*(?:music\s*)?video|official\s*audio|prod\.?\s*by\s+\S+)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitArtistTitle(rawTitle, rawArtist) {
  let title = cleanQueryMeta(rawTitle);
  let artist = cleanQueryMeta(rawArtist);
  if (title.includes(' - ') || title.includes(' – ') || title.includes(' — ')) {
    const parts = title.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      const left = parts[0].trim();
      const right = parts.slice(1).join(' - ').trim();
      if (!artist || normalize(artist) === normalize(left) || normalize(left).includes(normalize(artist))) {
        artist = artist || left;
        title = right;
      }
    }
  }
  const primaryArtist = artist.split(/\s*(?:,|&|\bx\b|\bfeat\.?\b|\bft\.?\b)\s*/i)[0]?.trim() || artist;
  const cleanTitle = title.replace(/\s*(?:\(|\[)?\b(?:feat\.?|ft\.?)\s+[^)\]]+(?:\)|\])?/gi, '').trim() || title;
  return { title, cleanTitle, artist, primaryArtist };
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
  const { cleanTitle, primaryArtist } = splitArtistTitle(title, artist);
  const titleScore = Math.max(
    titleSimilarity(title, candidate.trackName || candidate.name),
    titleSimilarity(cleanTitle, candidate.trackName || candidate.name)
  );
  const artistScore = Math.max(
    titleSimilarity(artist, candidate.artistName || candidate.artist),
    titleSimilarity(primaryArtist, candidate.artistName || candidate.artist)
  );
  const candidateDuration = Number(candidate.duration) || 0;
  const wantedDuration = Number(duration) || 0;
  const durationScore = candidateDuration && wantedDuration
    ? Math.max(0, 1 - Math.abs(candidateDuration - wantedDuration) / Math.max(12, wantedDuration * 0.22))
    : 0.5;
  return titleScore * 0.64 + artistScore * 0.25 + durationScore * 0.11;
}

function chooseCandidate(candidates, title, artist, duration) {
  return candidates
    .filter((item) => item && (item.syncedLyrics || item.plainLyrics || item.id))
    .map((item) => ({ item, score: candidateScore(item, title, artist, duration) }))
    .filter(({ item, score }) => score >= (item.syncedLyrics ? 0.45 : 0.52))
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

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

// Windows Schannel (curl.exe) ile Cloudflare JA3 TLS kontrolünü aşan yardımcı
function curlFetch(url, signal, timeoutMs = 4500) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return; }
    const maxSec = Math.max(2, Math.ceil(timeoutMs / 1000));
    const child = execFile(
      'curl.exe',
      [
        '-sL',
        '--compressed',
        '--max-time', String(maxSec),
        '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        '-H', 'Accept-Language: tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        url,
      ],
      { maxBuffer: 6 * 1024 * 1024, timeout: timeoutMs + 500, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout)
    );
    if (signal) {
      const onAbort = () => { try { child.kill(); } catch {} resolve(null); };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('exit', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

// 1. LRCLIB Provider (Açık kaynak senkronize söz arşivi)
async function fetchLrclib(title, artist, duration, signal) {
  const { cleanTitle, primaryArtist } = splitArtistTitle(title, artist);
  const roundedDuration = Math.round(Number(duration) || 0);
  const exactRequest = axios.get(`${LRCLIB}/get`, {
    ...axiosOptions(signal),
    params: { track_name: cleanTitle, artist_name: primaryArtist || artist || undefined, duration: roundedDuration || undefined },
  }).then((response) => response.data).catch(() => null);

  const queries = [...new Set([
    `${cleanTitle} ${primaryArtist || artist}`.trim(),
    `${title} ${artist}`.trim(),
    cleanTitle,
  ].filter(Boolean))];
  const searchRequests = queries.map((q) => axios.get(`${LRCLIB}/search`, {
    ...axiosOptions(signal), params: { q },
  }).then((response) => Array.isArray(response.data) ? response.data : []).catch(() => []));

  const [exact, ...searchResults] = await Promise.all([exactRequest, ...searchRequests]);
  if (exact && (exact.syncedLyrics || exact.plainLyrics)) {
    const score = candidateScore(exact, cleanTitle, primaryArtist || artist, duration);
    if (score >= 0.45) return formatLrclib(exact, duration);
  }
  const allCandidates = searchResults.flat().filter((item) => item && (item.syncedLyrics || item.plainLyrics));
  const candidate = chooseCandidate(allCandidates, cleanTitle, primaryArtist || artist, duration);
  return candidate ? formatLrclib(candidate, duration) : null;
}

// 2. NetEase Provider (Geniş Asya ve Küresel Senkronize Arşiv)
async function fetchNetease(title, artist, duration, signal) {
  const { cleanTitle, primaryArtist } = splitArtistTitle(title, artist);
  const query = `${cleanTitle} ${primaryArtist || artist || ''}`.trim();
  const [cloudRes, legacyRes] = await Promise.all([
    axios.get(`${NETEASE}/api/cloudsearch/pc`, {
      ...axiosOptions(signal, 3000),
      params: { s: query, type: 1, limit: 10 },
      headers: { ...axiosOptions(signal).headers, Referer: `${NETEASE}/` },
    }).catch(() => null),
    axios.get(`${NETEASE}/api/search/get`, {
      ...axiosOptions(signal, 3000),
      params: { s: query, type: 1, limit: 10 },
      headers: { ...axiosOptions(signal).headers, Referer: `${NETEASE}/` },
    }).catch(() => null),
  ]);

  const songs = [
    ...(cloudRes?.data?.result?.songs || []),
    ...(legacyRes?.data?.result?.songs || []),
  ];
  if (!songs.length) return null;

  const candidates = songs.map((song) => ({
    trackName: song.name,
    artistName: (song.ar || song.artists || []).map((entry) => entry.name).join(' '),
    duration: (Number(song.dt || song.duration) || 0) / 1000,
    id: song.id,
  }));
  const chosen = chooseCandidate(candidates, cleanTitle, primaryArtist || artist, duration);
  if (!chosen) return null;

  const lyricResponse = await axios.get(`${NETEASE}/api/song/lyric`, {
    ...axiosOptions(signal, 2800), params: { id: chosen.id, lv: -1, tv: -1 },
    headers: { ...axiosOptions(signal).headers, Referer: `${NETEASE}/` },
  }).catch(() => null);
  const rawLrc = String(lyricResponse?.data?.lrc?.lyric || '').trim();
  const rawTlyric = String(lyricResponse?.data?.tlyric?.lyric || '').trim();
  if (!rawLrc && !rawTlyric) return null;
  const hasTimestamps = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(rawLrc);
  return {
    success: true,
    syncedLyrics: hasTimestamps ? rawLrc : null,
    plainLyrics: hasTimestamps ? (rawTlyric || null) : (rawLrc || rawTlyric),
    source: hasTimestamps ? 'NetEase (Senkron)' : 'NetEase (Düz)',
  };
}

// 3. Kugou Provider (Milyonlarca senkronize .LRC)
async function fetchKugou(title, artist, duration, signal) {
  try {
    const { cleanTitle, primaryArtist } = splitArtistTitle(title, artist);
    const queries = [...new Set([
      `${primaryArtist || artist} ${cleanTitle}`.trim(),
      `${cleanTitle} ${primaryArtist || artist}`.trim(),
      cleanTitle,
    ].filter(Boolean))];

    const songList = [];
    for (const keyword of queries) {
      const [mobileRes, desktopRes] = await Promise.all([
        axios.get(KUGOU_MOBILE_SEARCH, {
          ...axiosOptions(signal, 2800),
          params: { format: 'json', keyword, page: 1, pagesize: 8, showtype: 1 },
        }).catch(() => null),
        axios.get(KUGOU_SEARCH, {
          ...axiosOptions(signal, 2800),
          params: { keyword, page: 1, pagesize: 6, clientver: '' },
        }).catch(() => null),
      ]);
      const mobileSongs = (mobileRes?.data?.data?.info || []).map((s) => ({
        hash: s.hash || s.FileHash,
        duration: Number(s.duration || s.Duration) || 0,
        filename: s.filename || s.FileName || `${s.singername || ''} - ${s.songname || ''}`,
        songname: s.songname || cleanTitle,
        singername: s.singername || primaryArtist,
      }));
      const desktopSongs = (desktopRes?.data?.data?.lists || []).map((s) => ({
        hash: s.FileHash || s.hash,
        duration: Number(s.Duration || s.duration) || 0,
        filename: s.FileName || s.filename || '',
        songname: s.SongName || cleanTitle,
        singername: s.SingerName || primaryArtist,
      }));
      songList.push(...mobileSongs, ...desktopSongs);
      if (songList.length >= 6) break;
    }

    const scoredSongs = songList
      .filter((s) => s.hash)
      .map((s) => ({
        song: s,
        score: Math.max(
          titleSimilarity(cleanTitle, s.songname),
          titleSimilarity(`${primaryArtist} ${cleanTitle}`, s.filename)
        ),
      }))
      .filter((entry) => entry.score >= 0.38)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    for (const { song } of scoredSongs) {
      const lrcSearch = await axios.get(KUGOU_LRC_SEARCH, {
        ...axiosOptions(signal, 2500),
        params: {
          ver: 1,
          man: 'yes',
          client: 'pc',
          keyword: song.filename || `${primaryArtist} - ${cleanTitle}`,
          hash: song.hash,
          duration: (song.duration || Number(duration) || 0) * 1000,
        },
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
      if (decodedLrc && /\[\d{1,2}:\d{2}/.test(decodedLrc)) {
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

// 4. Gerçek Genius API & Web Scraper + Yerli Türkçe Söz Arşivi (SarkiSozum)
// Doğrudan dengeli <div> ayrıştırıcı: iç içe LyricsHeader div'lerinde kesilmez.
function extractBalancedDivsByAttribute(html, attributeFragment) {
  const results = [];
  let searchPos = 0;
  const openTagRegex = new RegExp(`<div\\b[^>]*${attributeFragment}[^>]*>`, 'gi');
  let match;
  while ((match = openTagRegex.exec(html)) !== null) {
    const contentStart = match.index + match[0].length;
    let depth = 1;
    const tagScan = /<\/?div\b[^>]*>/gi;
    tagScan.lastIndex = contentStart;
    let scanMatch;
    while (depth > 0 && (scanMatch = tagScan.exec(html)) !== null) {
      if (scanMatch[0].startsWith('</')) depth -= 1;
      else if (!scanMatch[0].endsWith('/>')) depth += 1;
      if (depth === 0) {
        results.push(html.slice(contentStart, scanMatch.index));
        searchPos = tagScan.lastIndex;
        openTagRegex.lastIndex = searchPos;
      }
    }
  }
  return results;
}

function stripExcludedSelectionDivs(fragment) {
  const excluded = extractBalancedDivsByAttribute(fragment, 'data-exclude-from-selection="true"');
  let output = fragment;
  for (const block of excluded) {
    output = output.replace(block, '');
  }
  return output.replace(/<div\b[^>]*data-exclude-from-selection="true"[^>]*>\s*<\/div>/gi, '');
}

function cleanGeniusLyrics(html) {
  const containers = extractBalancedDivsByAttribute(html, 'data-lyrics-container="true"');
  if (!containers.length) return '';
  const parts = containers.map((raw) => {
    const cleaned = stripExcludedSelectionDivs(raw)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '');
    return decodeHtmlEntities(cleaned);
  });

  let text = parts.join('\n').trim();
  text = text.replace(/^[0-9]+\s+Contributors[\s\S]*?Lyrics\s*/i, '');
  text = text.replace(/^[0-9]+\s+Contributors[^\n]*\n?/i, '');
  text = text.replace(/^[^\n]{1,120}\s+Lyrics\s*\n+/i, '');
  text = text.replace(/You might also like/gi, '');
  text = text.replace(/\d*\s*Embed$/i, '').trim();
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchGeniusHtml(url, signal) {
  try {
    const res = await axios.get(url, {
      timeout: 3200,
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (res?.data) return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  } catch {}
  return curlFetch(url, signal, 4500);
}

// Yerli Türkçe şarkı sözü arşivi (SarkiSozum.gen.tr)
async function fetchTurkishSarkisozum(title, artist, signal) {
  try {
    const { cleanTitle, primaryArtist } = splitArtistTitle(title, artist);
    const slugify = (v) => normalize(v).replace(/\s+/g, '-');
    const artistSlug = slugify(primaryArtist || artist);
    const titleSlug = slugify(cleanTitle);

    const candidateUrls = [];
    if (artistSlug && titleSlug) {
      candidateUrls.push(`${SARKISOZUM_BASE}/${artistSlug}/${titleSlug}-sarkisozu`);
    }

    const searchQueries = [...new Set([
      `${primaryArtist} ${cleanTitle}`.trim(),
      cleanTitle,
      primaryArtist,
    ].filter(Boolean))];

    for (const q of searchQueries.slice(0, 2)) {
      const searchRes = await axios.get(`${SARKISOZUM_BASE}/arama/`, {
        ...axiosOptions(signal, 3000),
        params: { q },
      }).catch(() => null);
      const html = String(searchRes?.data || '');
      const links = [...html.matchAll(/href="(https:\/\/www\.sarkisozum\.gen\.tr\/[^"]+-sarkisozu)"/gi)]
        .map((m) => m[1]);
      for (const link of links) {
        if (!candidateUrls.includes(link)) candidateUrls.push(link);
      }
      if (candidateUrls.length >= 4) break;
    }

    const scoredUrls = candidateUrls
      .map((url) => {
        const slugPart = url.replace(SARKISOZUM_BASE, '').replace(/-sarkisozu$/, '').replace(/\//g, ' ');
        const score = titleSimilarity(`${primaryArtist} ${cleanTitle}`, slugPart) * 0.7
          + titleSimilarity(cleanTitle, slugPart) * 0.3;
        return { url, score };
      })
      .filter((item) => item.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (const { url } of scoredUrls) {
      const pageRes = await axios.get(url, axiosOptions(signal, 3000)).catch(() => null);
      const html = String(pageRes?.data || '');
      if (!html) continue;
      const blocks = [...html.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi)]
        .map((m) => m[1])
        .filter((b) => (b.match(/<br\s*\/?>/gi) || []).length >= 5 && b.length < 12000 && !/<script|<ins/i.test(b));
      if (!blocks.length) continue;
      const rawBlock = blocks[blocks.length - 1];
      const lyricsText = decodeHtmlEntities(
        rawBlock
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
      )
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (lyricsText.length >= 40) {
        return {
          success: true,
          syncedLyrics: null,
          plainLyrics: lyricsText,
          source: 'Genius · TR Arşiv (Düz)',
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchGenius(title, artist, signal) {
  try {
    const { cleanTitle, primaryArtist } = splitArtistTitle(title, artist);
    const queries = [...new Set([
      `${primaryArtist || artist} ${cleanTitle}`.trim(),
      `${cleanTitle} ${primaryArtist || artist}`.trim(),
      `${title} ${artist || ''}`.trim(),
      cleanTitle,
    ].filter(Boolean))];

    let bestHit = null;
    let bestScore = 0;

    for (const q of queries) {
      const rawJson = await fetchGeniusHtml(`${GENIUS_SEARCH}?q=${encodeURIComponent(q)}`, signal);
      if (!rawJson) continue;
      let parsed = null;
      try { parsed = JSON.parse(rawJson); } catch { parsed = null; }
      const sections = parsed?.response?.sections || [];
      const hits = [
        ...(sections.find((sec) => sec.type === 'song')?.hits || []),
        ...(sections.find((sec) => sec.type === 'top_hit')?.hits?.filter((h) => h.type === 'song') || []),
      ];
      for (const entry of hits) {
        const result = entry?.result;
        if (!result?.url || !/lyrics$/i.test(result.url)) continue;
        const score = candidateScore(
          { trackName: result.title || result.full_title, artistName: result.primary_artist?.name || result.artist_names },
          cleanTitle,
          primaryArtist || artist,
          0
        );
        if (score > bestScore) {
          bestScore = score;
          bestHit = result;
        }
      }
      if (bestHit && bestScore >= 0.45) break;
    }

    if (bestHit?.url && bestScore >= 0.35) {
      const pageHtml = await fetchGeniusHtml(bestHit.url, signal);
      if (pageHtml) {
        const lyricsText = cleanGeniusLyrics(pageHtml);
        if (lyricsText && lyricsText.length >= 25) {
          return {
            success: true,
            syncedLyrics: null,
            plainLyrics: lyricsText,
            source: 'Genius (Düz)',
          };
        }
      }
    }

    // Genius'ta bulunamazsa yerli Türkçe söz arşivini (SarkiSozum) dene
    const trFallback = await fetchTurkishSarkisozum(title, artist, signal);
    if (trFallback) return trFallback;
    return null;
  } catch {
    return null;
  }
}

// 5. Lyrics.ovh Fallback Provider
async function fetchLyricsOvh(title, artist, signal) {
  const { cleanTitle, primaryArtist } = splitArtistTitle(title, artist);
  const targetArtist = primaryArtist || artist;
  if (!targetArtist) return null;
  try {
    const response = await axios.get(`${LYRICS_OVH}/${encodeURIComponent(targetArtist)}/${encodeURIComponent(cleanTitle)}`, axiosOptions(signal, 3000));
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
  // 1. Senkron Arayıcılar (LRCLIB, Kugou, NetEase)
  const syncProviders = [
    () => fetchLrclib(title, artist, duration, signal),
    () => fetchKugou(title, artist, duration, signal),
    () => fetchNetease(title, artist, duration, signal),
  ];

  // 2. Kapsamlı Düz Metin Arayıcılar (Genius + TR Arşiv, Lyrics.ovh)
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
    new Promise((resolve) => setTimeout(() => resolve(null), 3200)),
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
