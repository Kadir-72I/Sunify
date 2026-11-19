// rpc.js - Discord Rich Presence Servisi (Sunify)
const DiscordRPC = require('discord-rpc');
const { cleanTrackMetadata } = require('../audio/metadataCleaner');

const CLIENT_ID = '1570821512984793228';

// RPC kaydını Discord'a bildir
DiscordRPC.register(CLIENT_ID);
let rpc = null;

let isReady = false;
let currentActivity = null;
let lastUpdateTime = 0;
let pendingUpdate = null;
const RATE_LIMIT_MS = 3000;
let accountChangedHandler = () => {};

function getConnectedAccount() {
  if (!isReady || !rpc?.user?.id) return null;
  const user = rpc.user;
  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${String(user.avatar).startsWith('a_') ? 'gif' : 'png'}?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${(Number(user.discriminator) || 0) % 5}.png`;
  return {
    id: String(user.id),
    username: String(user.global_name || user.username || 'Discord kullanıcısı'),
    avatarUrl,
  };
}

function setAccountChangedHandler(handler) {
  accountChangedHandler = typeof handler === 'function' ? handler : () => {};
  accountChangedHandler(getConnectedAccount());
}

function initRPC() {
  if (rpc) {
    try {
      rpc.destroy();
    } catch (e) {}
  }

  rpc = new DiscordRPC.Client({ transport: 'ipc' });

  rpc.on('ready', () => {
    isReady = true;
    accountChangedHandler(getConnectedAccount());
    console.log(
      `[Sunify RPC] Discord bağlantısı aktif! Kullanıcı: ${rpc.user ? rpc.user.username : 'Giriş yapıldı'}`
    );
    if (currentActivity) {
      applyActivity(currentActivity);
    }
  });

  rpc.on('disconnected', () => {
    isReady = false;
    accountChangedHandler(null);
    console.log('[Sunify RPC] Discord bağlantısı koptu. 5 saniye sonra tekrar denenecek...');
    setTimeout(tryConnect, 5000);
  });

  tryConnect();
}

function tryConnect() {
  if (isReady || !rpc) return;
  rpc.login({ clientId: CLIENT_ID }).catch(() => {
    setTimeout(tryConnect, 8000);
  });
}

function formatRpcClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function padRpcField(text, fallback = 'Sunify') {
  const trimmed = String(text || fallback).trim() || fallback;
  return trimmed.length < 2 ? `${trimmed} ` : trimmed.slice(0, 127);
}

function polishRpcMetadata(rawTitle, rawArtist, rawThumbnail, rawId) {
  const cleaned = cleanTrackMetadata(rawTitle || '', rawArtist || '');
  let title = cleaned.title || String(rawTitle || '').trim();
  let artist = cleaned.artist || String(rawArtist || '').trim();

  // Başlığın başında hâlâ "Sanatçı - " veya "Sanatçı – " tekrarı varsa ayıkla
  if (/[-–—]/.test(title)) {
    const parts = title.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      const left = parts[0].trim();
      const right = parts.slice(1).join(' – ').trim();
      if (!artist || left.toLowerCase() === artist.toLowerCase() || left.toLowerCase().includes(artist.toLowerCase())) {
        artist = artist || left;
        title = right || title;
      }
    }
  }
  title = title.replace(/\s*\((?:offiziell[^)]*|official[^)]*|hd|4k|audio|video)\)/gi, '').trim() || String(rawTitle || 'Sunify');
  artist = artist.replace(/\s*-\s*Topic$/i, '').trim() || 'Bilinmeyen Sanatçı';

  let artworkUrl = typeof rawThumbnail === 'string' && rawThumbnail.startsWith('https://') ? rawThumbnail : '';
  const vidMatch = artworkUrl.match(/i\.ytimg\.com\/vi\/([a-zA-Z0-9_-]{11})\//);
  const videoId = /^[a-zA-Z0-9_-]{11}$/.test(String(rawId || '')) ? String(rawId) : (vidMatch?.[1] || '');
  if (videoId) {
    // Discord etkinlik kartında siyah şeritsiz net kare/HD kapak için hqdefault/hq720
    artworkUrl = artworkUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  return { title, artist, artworkUrl, videoId };
}

function applyActivity(activityData) {
  if (!isReady || !rpc) {
    currentActivity = activityData;
    return;
  }

  const now = Date.now();
  if (now - lastUpdateTime < RATE_LIMIT_MS && activityData !== null) {
    clearTimeout(pendingUpdate);
    pendingUpdate = setTimeout(
      () => {
        applyActivity(activityData);
      },
      RATE_LIMIT_MS - (now - lastUpdateTime)
    );
    return;
  }

  lastUpdateTime = now;
  currentActivity = activityData;

  if (activityData === null) {
    rpc.clearActivity().catch(() => {});
    return;
  }

  const activity = {
    type: activityData.type ?? 2,
    status_display_type: activityData.statusDisplayType ?? 0,
    details: activityData.details,
    state: activityData.state,
    timestamps: activityData.startTimestamp || activityData.endTimestamp
      ? { start: activityData.startTimestamp, end: activityData.endTimestamp }
      : undefined,
    assets: activityData.largeImageKey || activityData.largeImageText || activityData.smallImageKey || activityData.smallImageText
      ? {
          large_image: activityData.largeImageKey,
          large_text: activityData.largeImageText,
          small_image: activityData.smallImageKey,
          small_text: activityData.smallImageText,
        }
      : undefined,
    buttons: activityData.buttons,
    instance: Boolean(activityData.instance),
  };

  rpc.request('SET_ACTIVITY', { pid: process.pid, activity }).catch((err) => {
    console.warn('[Sunify RPC] Etkinlik güncelleme hatası:', err.message);
  });
}

/**
 * Şarkı durumunu güncelleyen ana fonksiyon — Spotify / Apple Music tarzı şık görünüm
 */
function updatePresence(data) {
  if (!data || !data.title) {
    applyActivity(null);
    return;
  }

  const { position = 0, duration = 0, isPlaying = true } = data;
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const enabled = settings.enabled !== false;
  const showPaused = settings.showPaused !== false;
  const showArtwork = settings.artwork !== false;
  const showArtistBadge = settings.artistBadge !== false;
  const showTimeline = settings.timeline !== false;

  if (!enabled || (!isPlaying && !showPaused)) {
    applyActivity(null);
    return;
  }

  const { title, artist, artworkUrl, videoId } = polishRpcMetadata(
    data.title,
    data.artist,
    data.thumbnail,
    data.id
  );

  // Format seçeneğine göre üst (details) ve alt (state) satırları şık biçimde oluştur:
  // Varsayılan ('artist' veya 'title'): Üstte kalın Şarkı Adı, altta "by Sanatçı" (Spotify düzeni)
  const format = ['artist', 'title', 'both'].includes(settings.format) ? settings.format : 'artist';
  const details = padRpcField(
    format === 'both' ? `🎵 ${title} — ${artist}` : title,
    'Sunify'
  );
  const baseState = format === 'both'
    ? 'Sunify Desktop • Hi-Fi Audio'
    : `sanatçı: ${artist}`;

  const safePosition = Math.max(0, Number(position) || 0);
  const safeDuration = Math.max(0, Number(duration) || 0);

  // Discord RPC butonları yalnızca https:// protokolünü güvenilir şekilde kabul eder:
  // 1. buton: Şarkıyı YouTube Music / YouTube üzerinde doğrudan açar
  // 2. buton: Sunify GitHub Releases sayfasını açar
  const listenTargetUrl = videoId
    ? `https://music.youtube.com/watch?v=${videoId}`
    : (typeof data.url === 'string' && data.url.startsWith('https://')
        ? data.url
        : `https://music.youtube.com/search?q=${encodeURIComponent(`${artist} ${title}`.trim())}`);

  const buttons = [];
  if (settings.buttonListen !== false) {
    buttons.push({ label: "🎵 Sunify'da Dinle", url: listenTargetUrl });
  }
  if (settings.buttonDownload !== false) {
    buttons.push({ label: "✨ Sunify'ı İndir", url: 'https://github.com/Kadir-72I/Sunify/releases/latest' });
  }

  const durationBadge = safeDuration > 0 ? ` [${formatRpcClock(safePosition)} / ${formatRpcClock(safeDuration)}]` : '';
  const largeHoverText = padRpcField(`${title} — ${artist}${durationBadge}`, 'Sunify Music');
  const smallHoverText = isPlaying
    ? `▶ Sunify Desktop • Şimdi Çalıyor`
    : `⏸ Duraklatıldı${safeDuration > 0 ? ` • ${formatRpcClock(safePosition)}` : ''}`;

  const assets = {
    ...(showArtwork
      ? {
          largeImageKey: artworkUrl || 'sunify_logo',
          largeImageText: largeHoverText,
        }
      : {}),
    ...(showArtistBadge
      ? {
          smallImageKey: 'sunify_logo',
          smallImageText: smallHoverText,
        }
      : {}),
  };

  if (!isPlaying) {
    const pausedTime = safeDuration > 0 ? ` (${formatRpcClock(safePosition)} / ${formatRpcClock(safeDuration)})` : '';
    applyActivity({
      type: 2,
      statusDisplayType: format === 'title' ? 2 : 1,
      details,
      state: padRpcField(`⏸ Duraklatıldı · ${artist}${pausedTime}`),
      ...assets,
      instance: false,
      ...(buttons.length ? { buttons } : {}),
    });
    return;
  }

  const startTimestamp = Date.now() - Math.floor(safePosition * 1000);
  const endTimestamp = safeDuration > 0 ? startTimestamp + Math.floor(safeDuration * 1000) : undefined;

  applyActivity({
    type: 2,
    statusDisplayType: format === 'title' ? 2 : 1,
    details,
    state: padRpcField(baseState),
    ...(showTimeline ? { startTimestamp, endTimestamp } : {}),
    ...assets,
    instance: false,
    ...(buttons.length ? { buttons } : {}),
  });
}

function clearPresence() {
  applyActivity(null);
}

module.exports = { updatePresence, clearPresence, initRPC, setAccountChangedHandler };
