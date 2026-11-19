// discordRpcService.js
// Sunify Discord Rich Presence (Doğrudan IPC Socket Motoru - Yerel Sunucu Yedeği)
const net = require('net');
const fs = require('fs');
const { cleanTrackMetadata } = require('../audio/metadataCleaner');

const CLIENT_ID = '1570821512984793228';
let ipcSocket = null;
let isConnected = false;
let currentActivity = null;

function getDiscordPipe() {
  const prefix = '\\\\?\\pipe\\';
  for (let i = 0; i < 10; i++) {
    const pipePath = `${prefix}discord-ipc-${i}`;
    try {
      if (fs.existsSync(pipePath)) return pipePath;
    } catch (e) {}
  }
  return '\\\\?\\pipe\\discord-ipc-0';
}

function connectToDiscord() {
  if (ipcSocket || isConnected) return;

  const pipePath = getDiscordPipe();
  ipcSocket = net.createConnection(pipePath, () => {
    sendPacket(0, { v: 1, client_id: CLIENT_ID });
  });

  ipcSocket.on('data', (data) => {
    try {
      data.readInt32LE(0);
      const length = data.readInt32LE(4);
      const body = JSON.parse(data.slice(8, 8 + length).toString());

      if (body.cmd === 'DISPATCH' && body.evt === 'READY') {
        isConnected = true;
        console.log('✅ Discord RPC Başarıyla Bağlandı! Kullanıcı:', body.data?.user?.username);
        if (currentActivity) {
          sendActivity(currentActivity);
        }
      }
    } catch (err) {}
  });

  ipcSocket.on('error', () => {
    isConnected = false;
    ipcSocket = null;
  });

  ipcSocket.on('close', () => {
    isConnected = false;
    ipcSocket = null;
    setTimeout(connectToDiscord, 5000);
  });
}

function sendPacket(opcode, payload) {
  if (!ipcSocket || !ipcSocket.writable) return;
  const jsonStr = JSON.stringify(payload);
  const jsonLen = Buffer.byteLength(jsonStr);
  const packet = Buffer.alloc(8 + jsonLen);

  packet.writeInt32LE(opcode, 0);
  packet.writeInt32LE(jsonLen, 4);
  packet.write(jsonStr, 8);

  ipcSocket.write(packet);
}

function sendActivity(act) {
  const nonce = String(Date.now());
  sendPacket(1, {
    cmd: 'SET_ACTIVITY',
    args: {
      pid: process.pid,
      activity: act,
    },
    nonce,
  });
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateDiscordPresence(track, position = 0, duration = 0, isPlaying = true, settings = {}) {
  if (!track || !track.title) return;
  const cfg = settings && typeof settings === 'object' ? settings : {};
  if (cfg.enabled === false || (!isPlaying && cfg.showPaused === false)) {
    clearDiscordPresence();
    return;
  }

  const cleaned = cleanTrackMetadata(track.title || '', track.artist || '');
  let title = (cleaned.title || track.title || 'Sunify').replace(/\s*\((?:offiziell[^)]*|official[^)]*|hd|4k)\)/gi, '').trim();
  let artist = (cleaned.artist || track.artist || 'Bilinmeyen Sanatçı').replace(/\s*-\s*Topic$/i, '').trim();
  if (title.length < 2) title += ' ';
  if (artist.length < 2) artist += ' ';

  const format = ['artist', 'title', 'both'].includes(cfg.format) ? cfg.format : 'artist';
  const details = (
    format === 'both'
      ? `${title} — ${artist}`
      : format === 'title'
        ? `🎵 ${title}`
        : title
  ).substring(0, 127);
  const activeState = format === 'both'
    ? 'Sunify Desktop • Hi-Fi Audio'
    : format === 'title'
      ? `${artist} • Sunify`
      : `sanatçı: ${artist}`;

  const nowMs = Date.now();
  const showTimeline = cfg.timeline !== false;
  const startTimestamp = isPlaying && showTimeline ? Math.floor(nowMs - position * 1000) : undefined;
  const endTimestamp = isPlaying && showTimeline && duration > 0 ? Math.floor(startTimestamp + duration * 1000) : undefined;

  const coverUrl = track.thumbnail && track.thumbnail.startsWith('http')
    ? track.thumbnail
    : 'sunify_logo';

  const vidMatch = coverUrl.match(/i\.ytimg\.com\/vi\/([a-zA-Z0-9_-]{11})\//);
  const videoId = /^[a-zA-Z0-9_-]{11}$/.test(String(track.id || '')) ? String(track.id) : (vidMatch?.[1] || '');
  const listenUrl = videoId
    ? `https://music.youtube.com/watch?v=${videoId}`
    : `https://music.youtube.com/search?q=${encodeURIComponent(`${artist} ${title}`.trim())}`;

  const buttons = [];
  if (cfg.buttonListen !== false) {
    buttons.push({ label: "🎵 Sunify'da Dinle", url: listenUrl });
  }
  if (cfg.buttonDownload !== false) {
    buttons.push({ label: "✨ Sunify'ı İndir", url: 'https://github.com/Kadir-72I/Sunify/releases/latest' });
  }

  const durationBadge = duration > 0 ? ` [${formatClock(position)} / ${formatClock(duration)}]` : '';
  const assets = {};
  if (cfg.artwork !== false) {
    assets.large_image = coverUrl;
    assets.large_text = `${title} — ${artist}${durationBadge}`.substring(0, 127);
  }
  if (cfg.artistBadge !== false) {
    assets.small_image = 'sunify_logo';
    assets.small_text = isPlaying ? '▶ Sunify Desktop • Şimdi Çalıyor' : '⏸ Duraklatıldı';
  }

  const activity = {
    type: 2,
    details,
    state: (isPlaying ? activeState : `⏸ Duraklatıldı · ${artist}`).substring(0, 127),
    timestamps: isPlaying && endTimestamp ? { start: startTimestamp, end: endTimestamp } : undefined,
    ...(Object.keys(assets).length ? { assets } : {}),
    ...(buttons.length ? { buttons } : {}),
  };

  currentActivity = activity;

  if (isConnected) {
    sendActivity(activity);
  } else {
    connectToDiscord();
  }
}

function clearDiscordPresence() {
  currentActivity = null;
  if (isConnected) {
    sendActivity(null);
  }
}

module.exports = { updateDiscordPresence, clearDiscordPresence };
