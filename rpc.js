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

function initRPC() {
  if (rpc) {
    try {
      rpc.destroy();
    } catch (e) {}
  }

  rpc = new DiscordRPC.Client({ transport: 'ipc' });

  rpc.on('ready', () => {
    isReady = true;
    console.log(
      `[Sunify RPC] Discord bağlantısı aktif! Kullanıcı: ${rpc.user ? rpc.user.username : 'Giriş yapıldı'}`
    );
    if (currentActivity) {
      applyActivity(currentActivity);
    }
  });

  rpc.on('disconnected', () => {
    isReady = false;
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

  rpc.setActivity(activityData).catch((err) => {
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

  // Şarkı duraklatıldıysa Discord durumunda "Duraklatıldı" göster
  if (!isPlaying) {
    applyActivity({
      details: title.substring(0, 127),
      state: `${artist || 'Bilinmeyen Sanatçı'} (Duraklatıldı)`.substring(0, 127),
      largeImageKey: thumbnail && thumbnail.startsWith('http') ? thumbnail : 'sunify_logo',
      largeImageText: title,
      smallImageKey: 'sunify_logo',
      smallImageText: 'Sunify - Duraklatıldı',
      type: 2, // 2 = "Listening to" (Dinliyor)
      instance: false,
    });
    return;
  }

  // Canlı geri sayım ilerleme çubuğu için start ve end zaman damgaları
  const nowSeconds = Math.floor(Date.now() / 1000);
  const startTimestamp = Math.floor(nowSeconds - position);
  const endTimestamp = duration > 0 ? Math.floor(startTimestamp + duration) : undefined;

  const activity = {
    details: title.substring(0, 127), // 1. Satır: Şarkı Adı
    state: (artist || 'Sanatçı').substring(0, 127), // 2. Satır: Sanatçı Adı
    startTimestamp: startTimestamp,
    endTimestamp: endTimestamp, // İlerleme çubuğunu Discord'da canlı akıtır
    largeImageKey: thumbnail && thumbnail.startsWith('http') ? thumbnail : 'sunify_logo',
    largeImageText: `${title} - Sunify`,
    smallImageKey: 'sunify_logo',
    smallImageText: 'Sunify Music',
    type: 2, // 2 = "Listening to" (Dinliyor) modu
    instance: false,
  };

  applyActivity(activity);
}

function clearPresence() {
  applyActivity(null);
}

// Servisi başlat
initRPC();

module.exports = { updatePresence, clearPresence };
