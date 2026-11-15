// lyricsService.js
// Çoklu Şarkı Sözü Sağlayıcıları (LRCLIB, Musixmatch / Netease Synced, Genius Düz Metin)
const axios = require('axios');
const { cleanTrackMetadata } = require('./metadataCleaner');

const headers = {
  'User-Agent': 'Sunify-Desktop/1.0.0 (https://github.com/sunify/sunify)',
};

// 1. LRCLIB (Zaman damgalı LRC)
async function fetchFromLRCLIB(cleaned, duration) {
  try {
    const params = {
      artist_name: cleaned.artist,
      track_name: cleaned.title,
    };
    if (duration) params.duration = Math.round(duration);

    const res = await axios.get('https://lrclib.net/api/get', { params, headers, timeout: 4500 });
    if (res.data && (res.data.syncedLyrics || res.data.plainLyrics)) {
      return {
        source: 'LRCLIB (Senkron)',
        syncedLyrics: res.data.syncedLyrics,
        plainLyrics: res.data.plainLyrics,
        success: true,
      };
    }
  } catch (e) {}

  // Arama Fallback
  try {
    const query = `${cleaned.artist} ${cleaned.title}`.trim();
    const searchRes = await axios.get('https://lrclib.net/api/search', {
      params: { q: query },
      headers,
      timeout: 4500,
    });
    if (searchRes.data && searchRes.data.length > 0) {
      const best = searchRes.data.find((item) => item.syncedLyrics) || searchRes.data[0];
      return {
        source: 'LRCLIB (Arama)',
        syncedLyrics: best.syncedLyrics,
        plainLyrics: best.plainLyrics,
        success: true,
      };
    }
  } catch (e) {}

  return null;
}

// 2. Netease Cloud Music (Milyonlarca Şarkı ve Türkçe LRC desteği)
async function fetchFromNetease(cleaned) {
  try {
    const searchUrl = `https://music.163.com/api/search/get/web?csrf_token=hlpretag=&hlposttag=&s=${encodeURIComponent(`${cleaned.artist} ${cleaned.title}`)}&type=1&offset=0&total=true&limit=1`;
    const sRes = await axios.get(searchUrl, { timeout: 4500 });
    const songId = sRes.data?.result?.songs?.[0]?.id;

    if (songId) {
      const lyricUrl = `https://music.163.com/api/song/lyric?os=pc&id=${songId}&lv=-1&kv=-1&tv=-1`;
      const lRes = await axios.get(lyricUrl, { timeout: 4500 });
      const lrc = lRes.data?.lrc?.lyric;
      if (lrc && lrc.trim()) {
        return {
          source: 'Netease (Senkron)',
          syncedLyrics: lrc,
          plainLyrics: null,
          success: true,
        };
      }
    }
  } catch (e) {}
  return null;
}

// 3. Genius (Düz Sözler / Plain Lyrics)
async function fetchFromGenius(cleaned) {
  try {
    // Açık kaynak genius api gateway
    const query = `${cleaned.artist} ${cleaned.title}`;
    const res = await axios.get(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(cleaned.artist)}/${encodeURIComponent(cleaned.title)}`,
      { timeout: 4500 }
    );
    if (res.data?.lyrics) {
      return {
        source: 'Genius / LyricsOVH (Düz)',
        syncedLyrics: null,
        plainLyrics: res.data.lyrics,
        success: true,
      };
    }
  } catch (e) {}
  return null;
}

/**
 * Ana Söz Arama Motoru
 * İstenen kaynak: 'auto' (en iyisi), 'lrclib', 'netease', 'genius'
 */
async function fetchLyrics(rawTitle, rawArtist = '', duration = null, preferredSource = 'auto') {
  const cleaned = cleanTrackMetadata(rawTitle, rawArtist);

  if (preferredSource === 'lrclib') {
    const res = await fetchFromLRCLIB(cleaned, duration);
    if (res) return { ...res, cleaned };
  } else if (preferredSource === 'netease') {
    const res = await fetchFromNetease(cleaned);
    if (res) return { ...res, cleaned };
  } else if (preferredSource === 'genius') {
    const res = await fetchFromGenius(cleaned);
    if (res) return { ...res, cleaned };
  }

  // 'auto' modunda sırayla en zengin senkronize kaynaktan başla:
  // 1. LRCLIB -> 2. Netease -> 3. Genius
  const lrclibRes = await fetchFromLRCLIB(cleaned, duration);
  if (lrclibRes && lrclibRes.syncedLyrics) return { ...lrclibRes, cleaned };

  const neteaseRes = await fetchFromNetease(cleaned);
  if (neteaseRes && neteaseRes.syncedLyrics) return { ...neteaseRes, cleaned };

  if (lrclibRes && lrclibRes.plainLyrics) return { ...lrclibRes, cleaned };

  const geniusRes = await fetchFromGenius(cleaned);
  if (geniusRes && geniusRes.plainLyrics) return { ...geniusRes, cleaned };

  return {
    success: false,
    message: 'Hiçbir kaynakta söz bulunamadı',
    cleaned,
  };
}

module.exports = { fetchLyrics };
