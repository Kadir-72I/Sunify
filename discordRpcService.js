// discordRpcService.js
// Sunify Discord Rich Presence (Doğrudan IPC Socket Motoru)
// Discord Developer Portal'da kayıtlı onaylı "Sunify" uygulaması Client ID'si
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CLIENT_ID = '1570821512984793228'; // Sunify Client ID
let ipcSocket = null;
let isConnected = false;
let currentActivity = null;

// Windows Discord IPC Named Pipe bulucu
function getDiscordPipe() {
  const prefix = '\\\\?\\pipe\\';
  for (let i = 0; i < 10; i++) {
    const pipePath = `${prefix}discord-ipc-${i}`;
    try {
      return pipePath;
    } catch (e) {}
  }
  return '\\\\?\\pipe\\discord-ipc-0';
}

function connectToDiscord() {
  if (ipcSocket || isConnected) return;

  const pipePath = getDiscordPipe();
  ipcSocket = net.createConnection(pipePath, () => {
    // 1. Handshake Paketi Gönder (Opcode 0)
    sendPacket(0, { v: 1, client_id: CLIENT_ID });
  });

  ipcSocket.on('data', (data) => {
    try {
      const opcode = data.readInt32LE(0);
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
    // Discord açılırsa 5 saniye sonra tekrar bağlanmayı dene
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
    nonce: nonce,
  });
}

function updateDiscordPresence(track, position = 0, duration = 0, isPlaying = true) {
  if (!track || !track.title) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const startTimestamp = isPlaying ? Math.floor(nowSec - position) : undefined;
  const endTimestamp =
    isPlaying && duration > 0 ? Math.floor(startTimestamp + duration) : undefined;

  const coverUrl =
    track.thumbnail && track.thumbnail.startsWith('http')
      ? track.thumbnail
      : 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=300';

  const activity = {
    type: 2, // 2 = Dinliyor (Listening)
    details: track.title.substring(0, 127), // Şarkı Adı (Büyük başlık)
    state: (track.artist || 'Bilinmeyen Sanatçı').substring(0, 127), // Sanatçı Adı (Alt satır)
    timestamps:
      isPlaying && endTimestamp
        ? {
            start: startTimestamp,
            end: endTimestamp, // Spotify gibi sol/sağ zaman çubuğu
          }
        : undefined,
    assets: {
      large_image: coverUrl,
      large_text: `${track.title} - Sunify`,
      small_image: 'sunify_logo',
      small_text: isPlaying ? 'Sunify Music' : 'Duraklatıldı',
    },
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

// Başlat
connectToDiscord();

module.exports = { updateDiscordPresence, clearDiscordPresence };
