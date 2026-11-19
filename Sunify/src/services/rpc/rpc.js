// rpc.js - Discord Rich Presence Servisi (Sunify)
const DiscordRPC = require('discord-rpc');

const CLIENT_ID = '1570821512984793228';

// RPC kaydını Discord'a bildir
DiscordRPC.register(CLIENT_ID);
let rpc = null;

let isReady = false;
let currentActivity = null;
let lastUpdateTime = 0;
let pendingUpdate = null;
const RATE_LIMIT_MS = 3000; // Akıcı güncelleme için güvenli limit (en az 3 saniye)
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
    // Discord o an kapalıysa çökme yapmaz, 8 saniye sonra sessizce tekrar dener
    setTimeout(tryConnect, 8000);
  });
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

  // discord-rpc's setActivity() currently drops Activity.type, so Discord
  // displays Sunify as "Playing". Send the documented RPC payload directly
  // to retain type=2 (Listening) and the live track timestamps.
  const activity = {
    type: activityData.type ?? 0,
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
 * Şarkı durumunu güncelleyen ana fonksiyon
 * @param {Object} data - { title, artist, thumbnail, position, duration, isPlaying }
 */
function updatePresence(data) {
  if (!data || !data.title) {
    applyActivity(null);
    return;
  }

  const { title, artist, thumbnail, position = 0, duration = 0, isPlaying = true } = data;
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const enabled = settings.enabled !== false;
  const showPaused = settings.showPaused !== false;
  const showArtwork = settings.artwork !== false;
  const showArtistBadge = settings.artistBadge !== false;
  const showTimeline = settings.timeline !== false;
  const format = ['artist', 'title', 'both'].includes(settings.format) ? settings.format : 'artist';
  const details = (format === 'artist' ? (artist || 'Sanatçı') : format === 'both' ? `${title} · ${artist || 'Sanatçı'}` : title).substring(0, 127);
  const state = (format === 'artist' ? title : format === 'title' ? (artist || 'Sanatçı') : 'Sunify').substring(0, 127);
  if (!enabled || (!isPlaying && !showPaused)) {
    applyActivity(null);
    return;
  }
  const safePosition = Math.max(0, Number(position) || 0);
  const safeDuration = Math.max(0, Number(duration) || 0);
  const playUrl = `sunify://play?title=${encodeURIComponent(String(title).slice(0, 180))}&artist=${encodeURIComponent(String(artist || '').slice(0, 140))}`;
  const buttons = [];
  if (settings.buttonDownload !== false) buttons.push({ label: "Sunify'da indir", url: 'https://github.com/Kadir-72I/Sunify/releases/latest' });
  if (settings.buttonListen !== false) buttons.push({ label: "Sunify'da dinle", url: playUrl });
  const assets = {
    ...(showArtwork ? { largeImageKey: thumbnail && thumbnail.startsWith('http') ? thumbnail : 'sunify_logo', largeImageText: `${title} - Sunify` } : {}),
    ...(showArtistBadge ? { smallImageKey: 'sunify_logo', smallImageText: isPlaying ? 'Sunify Music' : 'Duraklatıldı' } : {}),
  };

  // Şarkı duraklatıldıysa Discord durumunda "Duraklatıldı" göster
  if (!isPlaying) {
    applyActivity({
      details,
      state: `${state} · Duraklatıldı`.substring(0, 127),
      ...assets,
      type: 2, // 2 = "Listening to" (Dinliyor)
      instance: false,
      ...(buttons.length ? { buttons } : {}),
    });
    return;
  }

  // Canlı geri sayım ilerleme çubuğu için start ve end zaman damgaları
  // Discord's Rich Presence timestamp fields use Unix milliseconds.
  const startTimestamp = Date.now() - Math.floor(safePosition * 1000);
  const endTimestamp = safeDuration > 0 ? startTimestamp + Math.floor(safeDuration * 1000) : undefined;

  const activity = {
    type: 2, // Discord'da "Dinliyor" başlığı ve Liner benzeri düzen.
    details,
    state,
    ...(showTimeline ? { startTimestamp, endTimestamp } : {}),
    ...assets,
    instance: false,
    ...(buttons.length ? { buttons } : {}),
  };

  applyActivity(activity);
}

function clearPresence() {
  applyActivity(null);
}

module.exports = { updatePresence, clearPresence, initRPC, setAccountChangedHandler };
