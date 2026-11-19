const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, safeStorage, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const { pipeline } = require('stream/promises');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.exit(0);

app.setName('Sunify');
app.setPath('userData', path.join(app.getPath('appData'), 'SunifyPlayerData'));
process.env.SUNIFY_USER_DB_FILE = path.join(app.getPath('userData'), 'sunify_users.json');
process.env.SUNIFY_SUPABASE_CONFIG_FILE = path.join(app.getPath('userData'), 'supabase_config.json');
process.env.SUNIFY_DOWNLOADS_DIR = path.join(app.getPath('userData'), 'downloads');
const { startServer } = require('../server');
const { updatePresence, clearPresence, initRPC, setAccountChangedHandler } = require('../services/rpc/rpc');
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --expose-gc --optimize-for-size');
app.commandLine.appendSwitch('disk-cache-size', '33554432');
app.commandLine.appendSwitch('media-cache-size', '16777216');
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,TranslateUI,AudioServiceOutOfProcess,HardwareMediaKeyHandling');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-print-preview');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('disable-component-update');

let mainWindow;
let discordAccountProfile = null;
let pendingEmailVerificationResult = null;
let pendingPlayRequest = null;
const secureAuthValues = new Map();
const SECURE_AUTH_KEYS = new Set(['sunify_auth_session', 'sunify_saved_profiles']);

function secureAuthFilePath(key) {
  if (!SECURE_AUTH_KEYS.has(key)) return null;
  return path.join(app.getPath('userData'), `${key}.enc`);
}

ipcMain.on('secure-auth-store:get', (event, key) => {
  if (!fromAppWindow(event) || !SECURE_AUTH_KEYS.has(key)) return;
  try {
    if (secureAuthValues.has(key)) { event.returnValue = secureAuthValues.get(key); return; }
    const file = secureAuthFilePath(key);
    if (!file || !fs.existsSync(file)) { event.returnValue = null; return; }
    if (!safeStorage.isEncryptionAvailable()) { event.returnValue = null; return; }
    const value = safeStorage.decryptString(fs.readFileSync(file));
    secureAuthValues.set(key, value);
    event.returnValue = value;
  } catch (error) {
    console.warn(`Güvenli hesap verisi okunamadı (${key}):`, error.message);
    event.returnValue = null;
  }
});

ipcMain.on('secure-auth-store:set', (event, key, value) => {
  if (!fromAppWindow(event) || !SECURE_AUTH_KEYS.has(key) || typeof value !== 'string') { event.returnValue = false; return; }
  try {
    if (!safeStorage.isEncryptionAvailable()) { event.returnValue = false; return; }
    const file = secureAuthFilePath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const encrypted = safeStorage.encryptString(value);
    fs.writeFileSync(file, encrypted, { mode: 0o600 });
    secureAuthValues.set(key, value);
    event.returnValue = true;
  } catch (error) {
    console.warn(`Güvenli hesap verisi saklanamadı (${key}):`, error.message);
    event.returnValue = false;
  }
});

ipcMain.on('secure-auth-store:delete', (event, key) => {
  if (!fromAppWindow(event) || !SECURE_AUTH_KEYS.has(key)) { event.returnValue = false; return; }
  try {
    const file = secureAuthFilePath(key);
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
    secureAuthValues.delete(key);
    event.returnValue = true;
  } catch (error) {
    console.warn(`Güvenli hesap verisi silinemedi (${key}):`, error.message);
    event.returnValue = false;
  }
});
let miniPlayerWindow;
let miniPlayerDismissed = false;
let miniPlayerForcedVisible = false;
let miniPlayerDestroyTimer = null;
let appTray = null;
let isQuittingApp = false;
let closeToTrayEnabled = true;
let latestPlaybackState = { title: 'Sunify', artist: 'Bir şarkı seç', playing: false };
const miniPlayerSettings = {
  enabled: true,
  onMinimize: true,
  alwaysOnTop: true,
  position: 'top-center',
  size: 'medium',
  opacity: 0.88,
};

function createGlyphIcon(kind) {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4, 0);
  const put = (x, y, a = 255) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 4;
    buf[idx] = 255;
    buf[idx + 1] = 255;
    buf[idx + 2] = 255;
    buf[idx + 3] = a;
  };
  if (kind === 'play') {
    for (let y = 3; y <= 12; y++) {
      const span = y <= 7 ? y - 3 : 12 - y;
      for (let x = 5; x <= 5 + span * 1.4; x++) put(Math.round(x), y);
    }
  } else if (kind === 'pause') {
    for (let y = 3; y <= 12; y++) {
      for (let x = 4; x <= 6; x++) put(x, y);
      for (let x = 9; x <= 11; x++) put(x, y);
    }
  } else if (kind === 'prev') {
    for (let y = 3; y <= 12; y++) {
      put(4, y);
      put(5, y);
      const span = y <= 7 ? 7 - y : y - 8;
      for (let x = 6 + span; x <= 12; x++) put(Math.round(x), y);
    }
  } else if (kind === 'next') {
    for (let y = 3; y <= 12; y++) {
      put(11, y);
      put(10, y);
      const span = y <= 7 ? y - 3 : 12 - y;
      for (let x = 4; x <= 4 + span; x++) put(Math.round(x), y);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function getAppIconImage() {
  const candidates = [
    path.join(__dirname, '../../build/sunify.ico'),
    path.join(__dirname, '../../build/sunify-icon-source.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const img = nativeImage.createFromPath(candidate);
      if (!img.isEmpty()) return img;
    }
  }
  return createGlyphIcon('play');
}

function updateTaskbarThumbarButtons() {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const playing = Boolean(latestPlaybackState.playing);
    mainWindow.setThumbarButtons([
      {
        tooltip: 'Önceki Şarkı',
        icon: createGlyphIcon('prev'),
        click: () => mainWindow?.webContents?.send('mini-player-control', 'previous'),
      },
      {
        tooltip: playing ? 'Duraklat' : 'Oynat',
        icon: createGlyphIcon(playing ? 'pause' : 'play'),
        click: () => mainWindow?.webContents?.send('mini-player-control', 'toggle'),
      },
      {
        tooltip: 'Sonraki Şarkı',
        icon: createGlyphIcon('next'),
        click: () => mainWindow?.webContents?.send('mini-player-control', 'next'),
      },
    ]);
  } catch {}
}

function updateSystemTrayMenu() {
  if (!appTray) return;
  const trackLabel = latestPlaybackState.title && latestPlaybackState.title !== 'Sunify'
    ? `${latestPlaybackState.title} — ${latestPlaybackState.artist || 'Sunify'}`.slice(0, 80)
    : 'Sunify Masaüstü Müzik Çalar';
  appTray.setToolTip(trackLabel);
  const contextMenu = Menu.buildFromTemplate([
    { label: trackLabel, enabled: false },
    { type: 'separator' },
    {
      label: latestPlaybackState.playing ? 'Duraklat' : 'Oynat',
      click: () => mainWindow?.webContents?.send('mini-player-control', 'toggle'),
    },
    {
      label: 'Önceki Şarkı',
      click: () => mainWindow?.webContents?.send('mini-player-control', 'previous'),
    },
    {
      label: 'Sonraki Şarkı',
      click: () => mainWindow?.webContents?.send('mini-player-control', 'next'),
    },
    { type: 'separator' },
    {
      label: 'Mini Oynatıcıyı Göster / Gizle',
      click: () => {
        if (miniPlayerWindow && !miniPlayerWindow.isDestroyed() && miniPlayerWindow.isVisible()) {
          miniPlayerDismissed = true;
          miniPlayerForcedVisible = false;
          miniPlayerWindow.hide();
        } else {
          miniPlayerDismissed = false;
          miniPlayerForcedVisible = true;
          showMiniPlayer(true);
        }
      },
    },
    {
      label: 'Sunify Penceresini Göster',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => {
        isQuittingApp = true;
        app.quit();
      },
    },
  ]);
  appTray.setContextMenu(contextMenu);
}

function ensureSystemTray() {
  if (appTray) return;
  try {
    appTray = new Tray(getAppIconImage());
    appTray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
    updateSystemTrayMenu();
  } catch (err) {
    console.warn('Sistem tepsisi oluşturulamadı:', err.message);
  }
}

function parseEmailVerificationCallback(rawUrl) {
  try {
    const callbackUrl = new URL(rawUrl);
    if (callbackUrl.protocol !== 'sunify:' || callbackUrl.hostname !== 'auth' || callbackUrl.pathname !== '/callback') return null;
    const params = new URLSearchParams(callbackUrl.search);
    new URLSearchParams(callbackUrl.hash.replace(/^#/, '')).forEach((value, key) => params.set(key, value));
    const error = params.get('error_description') || params.get('error');
    const isConfirmation = params.get('type') === 'signup' || params.has('access_token') || params.has('token_hash') || params.has('code');
    return {
      success: !error && isConfirmation,
      message: error ? error.replace(/\+/g, ' ') : '',
    };
  } catch {
    return null;
  }
}

function deliverSunifyDeepLink(rawUrl) {
  const result = parseEmailVerificationCallback(rawUrl);
  if (!result) {
    try {
      const deepLink = new URL(rawUrl);
      if (deepLink.protocol !== 'sunify:' || deepLink.hostname !== 'play') return;
      const title = String(deepLink.searchParams.get('title') || '').trim().slice(0, 180);
      const artist = String(deepLink.searchParams.get('artist') || '').trim().slice(0, 140);
      const query = `${artist} ${title}`.trim();
      if (!title || !query) return;
      const request = { title, artist, query };
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
        pendingPlayRequest = request;
      } else {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        mainWindow.webContents.send('sunify-play-request', request);
      }
    } catch {}
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingEmailVerificationResult = result;
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.webContents.send('auth-email-verification-result', result);
}

function findSunifyDeepLink(args) {
  return args.find((value) => typeof value === 'string' && value.startsWith('sunify://'));
}

if (process.platform === 'win32' && process.argv.length > 1) {
  deliverSunifyDeepLink(findSunifyDeepLink(process.argv) || '');
}
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverSunifyDeepLink(url);
});
app.on('second-instance', (_event, commandLine) => {
  deliverSunifyDeepLink(findSunifyDeepLink(commandLine) || '');
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function miniPlayerBounds() {
  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().workArea;
  const dimensions = {
    small: { width: 430, height: 72 },
    medium: { width: 540, height: 82 },
    large: { width: 650, height: 96 },
  }[miniPlayerSettings.size] || { width: 540, height: 82 };
  const margin = 18;
  const x = miniPlayerSettings.position === 'top-left'
    ? area.x + margin
    : miniPlayerSettings.position === 'top-right'
      ? area.x + area.width - dimensions.width - margin
      : area.x + Math.round((area.width - dimensions.width) / 2);
  return { ...dimensions, x, y: area.y + margin };
}

function applyMiniPlayerSettings() {
  if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
  const bounds = miniPlayerBounds();
  miniPlayerWindow.setBounds(bounds);
  miniPlayerWindow.setAlwaysOnTop(miniPlayerSettings.alwaysOnTop, 'floating');
  miniPlayerWindow.webContents.send('mini-player-size', miniPlayerSettings.size);
  miniPlayerWindow.webContents.send('mini-player-opacity', miniPlayerSettings.opacity);
}

function trimProcessMemory() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('trim-renderer-memory');
    }
  } catch {}
  try {
    if (typeof global.gc === 'function') global.gc();
  } catch {}
}

function showMiniPlayer(force = false) {
  if (miniPlayerDestroyTimer) {
    clearTimeout(miniPlayerDestroyTimer);
    miniPlayerDestroyTimer = null;
  }
  if (!miniPlayerSettings.enabled || (!force && !miniPlayerSettings.onMinimize) || miniPlayerDismissed) return;
  if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) {
    const { BrowserWindow } = require('electron');
    miniPlayerWindow = new BrowserWindow({
      ...miniPlayerBounds(),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      alwaysOnTop: miniPlayerSettings.alwaysOnTop,
      webPreferences: {
        preload: path.join(__dirname, 'mini-player-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const createdWindow = miniPlayerWindow;
    createdWindow.loadFile(path.join(__dirname, '../renderer/mini-player.html'));
    createdWindow.once('ready-to-show', () => {
      if (createdWindow.isDestroyed() || miniPlayerWindow !== createdWindow) return;
      applyMiniPlayerSettings();
      if (!miniPlayerDismissed && (force || mainWindow?.isMinimized())) createdWindow.showInactive();
    });
    createdWindow.on('closed', () => { if (miniPlayerWindow === createdWindow) miniPlayerWindow = null; });
  } else {
    applyMiniPlayerSettings();
    miniPlayerWindow.showInactive();
  }
}

// Windows 11 (build 22000+) gerçek acrylic saydamlığı. Eski sürümlerde veya --no-acrylic ile kapalı kalır.
const useAcrylic = process.platform === 'win32'
  && Number(String(os.release()).split('.')[2]) >= 22000
  && !process.argv.includes('--no-acrylic');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    frame: false,
    ...(useAcrylic ? { backgroundMaterial: 'acrylic', backgroundColor: '#00000000' } : { backgroundColor: '#0a0a0c' }),
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  const port = app.__sunifyApiPort || 3001;
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { apiPort: String(port), ...(useAcrylic ? { acrylic: '1' } : {}) } });
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('discord-account-profile', discordAccountProfile);
    if (pendingEmailVerificationResult) {
      mainWindow.webContents.send('auth-email-verification-result', pendingEmailVerificationResult);
      pendingEmailVerificationResult = null;
    }
    if (pendingPlayRequest) {
      mainWindow.webContents.send('sunify-play-request', pendingPlayRequest);
      pendingPlayRequest = null;
    }
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    updateTaskbarThumbarButtons();
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.on('close', (event) => {
    if (!isQuittingApp && closeToTrayEnabled && appTray) {
      event.preventDefault();
      mainWindow.hide();
      showMiniPlayer();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    miniPlayerWindow?.close();
  });
  // Wait until Windows has completed minimizing the main window before
  // checking its state or creating/showing the overlay (avoids a race).
  // The same path is used for every way of minimizing: the in-app button,
  // clicking the window's taskbar button, Win+D / Win+M and the system menu.
  const showMiniPlayerWhenMinimized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-minimized-state', true);
    }
    [60, 250, 700].forEach((delay) => setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) showMiniPlayer();
    }, delay));
    setTimeout(trimProcessMemory, 1200);
  };
  mainWindow.on('minimize', showMiniPlayerWhenMinimized);
  mainWindow.on('hide', showMiniPlayerWhenMinimized);
  const hideMiniPlayerWhenRestored = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    mainWindow.webContents.send('window-minimized-state', false);
    miniPlayerDismissed = false;
    if (miniPlayerForcedVisible) return;
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
      miniPlayerWindow.hide();
      // Ana pencere açıkken 2. renderer sürecini (mini-player) ~60 MB RAM tutmaması için 3 sn sonra kapat
      if (miniPlayerDestroyTimer) clearTimeout(miniPlayerDestroyTimer);
      miniPlayerDestroyTimer = setTimeout(() => {
        miniPlayerDestroyTimer = null;
        if (!miniPlayerForcedVisible && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized() && miniPlayerWindow && !miniPlayerWindow.isDestroyed() && !miniPlayerWindow.isVisible()) {
          miniPlayerWindow.destroy();
          miniPlayerWindow = null;
          trimProcessMemory();
        }
      }, 3000);
    }
  };
  mainWindow.on('restore', hideMiniPlayerWhenRestored);
  mainWindow.on('show', hideMiniPlayerWhenRestored);
  mainWindow.on('focus', hideMiniPlayerWhenRestored);
}

function fromAppWindow(event) {
  return Boolean(mainWindow && event.sender === mainWindow.webContents);
}

for (const [channel, action] of [
  ['window-minimize', (win) => win.minimize()],
  ['window-maximize', (win) => (win.isMaximized() ? win.unmaximize() : win.maximize())],
  ['window-close', (win) => win.close()],
  ['window-fullscreen', (win) => win.setFullScreen(!win.isFullScreen())],
]) {
  ipcMain.on(channel, (event) => {
    if (fromAppWindow(event)) action(mainWindow);
  });
}

ipcMain.on('discord-rpc-update', (event, data) => {
  if (!fromAppWindow(event) || !data || typeof data !== 'object') return;
  updatePresence({
    id: String(data.id || '').slice(0, 64),
    url: typeof data.url === 'string' && data.url.startsWith('https://') ? data.url.slice(0, 300) : '',
    title: String(data.title || '').slice(0, 127),
    artist: String(data.artist || '').slice(0, 127),
    thumbnail: typeof data.thumbnail === 'string' && data.thumbnail.startsWith('https://') ? data.thumbnail : '',
    position: Number(data.position) || 0,
    duration: Number(data.duration) || 0,
    isPlaying: Boolean(data.isPlaying),
    settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
  });
});

ipcMain.on('discord-rpc-clear', (event) => {
  if (fromAppWindow(event)) clearPresence();
});

ipcMain.handle('get-discord-account-profile', (event) => {
  if (!fromAppWindow(event)) return null;
  return discordAccountProfile;
});

ipcMain.on('mini-player-settings', (event, settings) => {
  if (!fromAppWindow(event) || !settings || typeof settings !== 'object') return;
  miniPlayerSettings.enabled = settings.enabled !== false;
  miniPlayerSettings.onMinimize = settings.onMinimize !== false;
  miniPlayerSettings.alwaysOnTop = settings.alwaysOnTop !== false;
  miniPlayerSettings.position = ['top-left', 'top-center', 'top-right'].includes(settings.position)
    ? settings.position : 'top-center';
  miniPlayerSettings.size = ['small', 'medium', 'large'].includes(settings.size)
    ? settings.size : 'medium';
  miniPlayerSettings.opacity = Math.max(0.35, Math.min(1, Number(settings.opacity) || 0.88));
  if (!miniPlayerSettings.enabled && miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerForcedVisible = false;
    miniPlayerWindow.hide();
  } else if (!miniPlayerSettings.onMinimize && !miniPlayerForcedVisible && miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.hide();
  } else {
    applyMiniPlayerSettings();
    if (miniPlayerSettings.enabled && (miniPlayerForcedVisible || (miniPlayerSettings.onMinimize && mainWindow?.isMinimized()))) {
      miniPlayerDismissed = false;
      showMiniPlayer(miniPlayerForcedVisible);
    }
  }
});

ipcMain.on('mini-player-toggle', (event, forceShow) => {
  if (!fromAppWindow(event) || !miniPlayerSettings.enabled) return;
  const isCurrentlyVisible = Boolean(miniPlayerWindow && !miniPlayerWindow.isDestroyed() && miniPlayerWindow.isVisible());
  if (forceShow === true) {
    miniPlayerDismissed = false;
    miniPlayerForcedVisible = true;
    showMiniPlayer(true);
    return;
  }
  if (isCurrentlyVisible) {
    miniPlayerDismissed = true;
    miniPlayerForcedVisible = false;
    miniPlayerWindow.hide();
  } else {
    miniPlayerDismissed = false;
    miniPlayerForcedVisible = true;
    showMiniPlayer(true);
  }
});

ipcMain.on('mini-player-opacity', (event, opacity) => {
  if (!fromAppWindow(event)) return;
  miniPlayerSettings.opacity = Math.max(0.35, Math.min(1, Number(opacity) || 0.88));
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('mini-player-opacity', miniPlayerSettings.opacity);
  }
});

ipcMain.on('close-to-tray-setting', (event, enabled) => {
  if (!fromAppWindow(event)) return;
  closeToTrayEnabled = Boolean(enabled);
});

ipcMain.on('mini-player-state', (event, state) => {
  if (!fromAppWindow(event) || !state || typeof state !== 'object') return;
  const nextTitle = String(state.title || '').slice(0, 160);
  const nextArtist = String(state.artist || '').slice(0, 160);
  const nextPlaying = Boolean(state.playing);
  const stateChanged = latestPlaybackState.title !== nextTitle
    || latestPlaybackState.artist !== nextArtist
    || latestPlaybackState.playing !== nextPlaying;
  latestPlaybackState = { title: nextTitle, artist: nextArtist, playing: nextPlaying };
  if (stateChanged) {
    updateTaskbarThumbarButtons();
    updateSystemTrayMenu();
  }
  if (!miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
  miniPlayerWindow.webContents.send('mini-player-state', {
    title: nextTitle,
    artist: nextArtist,
    thumbnail: typeof state.thumbnail === 'string' && /^https:\/\//.test(state.thumbnail) ? state.thumbnail : '',
    playing: nextPlaying,
    progress: Math.max(0, Math.min(100, Number(state.progress) || 0)),
    elapsed: String(state.elapsed || '0:00').slice(0, 8),
    duration: String(state.duration || '0:00').slice(0, 8),
    volume: Math.max(0, Math.min(1, Number.isFinite(Number(state.volume)) ? Number(state.volume) : 1)),
    accent: /^#[\da-f]{6}$/i.test(state.accent || '') ? state.accent : '#a78bfa',
  });
});

ipcMain.on('mini-player-ready', (event) => {
  if (!miniPlayerWindow || miniPlayerWindow.isDestroyed() || event.sender !== miniPlayerWindow.webContents) return;
  miniPlayerWindow.webContents.send('mini-player-size', miniPlayerSettings.size);
  miniPlayerWindow.webContents.send('mini-player-opacity', miniPlayerSettings.opacity);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mini-player-state-request');
});

ipcMain.on('mini-player-action', (event, action, value) => {
  if (!miniPlayerWindow || event.sender !== miniPlayerWindow.webContents) return;
  if (action === 'close') {
    miniPlayerDismissed = true;
    miniPlayerForcedVisible = false;
    miniPlayerWindow.hide();
    return;
  }
  if (['toggle', 'previous', 'next', 'seek', 'volume'].includes(action) && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mini-player-control', action, value);
  }
});

ipcMain.handle('choose-music-folders', async (event) => {
  if (!fromAppWindow(event)) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections'],
    title: 'Müzik klasörlerini seç',
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('open-downloads-folder', async (event) => {
  if (!fromAppWindow(event)) return 'İstek reddedildi.';
  const downloadsDir = process.env.SUNIFY_DOWNLOADS_DIR || path.resolve(__dirname, '..', 'downloads');
  try {
    await fs.promises.mkdir(downloadsDir, { recursive: true });
    return await shell.openPath(downloadsDir);
  } catch (error) {
    return error.message;
  }
});

ipcMain.handle('open-cache-folder', async (event) => {
  if (!fromAppWindow(event)) return 'İstek reddedildi.';
  const cacheDir = process.env.SUNIFY_AUDIO_CACHE_DIR || path.join(os.tmpdir(), 'SunifyAudioCache');
  try {
    await fs.promises.mkdir(cacheDir, { recursive: true });
    return await shell.openPath(cacheDir);
  } catch (error) {
    return error.message;
  }
});

ipcMain.handle('install-update-from-url', async (event, url) => {
  if (!fromAppWindow(event) || typeof url !== 'string') return 'İstek reddedildi.';
  if (process.platform !== 'win32') return 'Bu sürümde otomatik kurulum yalnızca Windows için kullanılabilir.';
  let installerPath = '';
  try {
    const parsed = new URL(url);
    const isPublicGitHubAsset = parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.includes('/releases/download/') && /\.exe$/i.test(parsed.pathname);
    let supabaseConfig = null;
    try { supabaseConfig = JSON.parse(await fs.promises.readFile(process.env.SUNIFY_SUPABASE_CONFIG_FILE, 'utf8')); } catch {}
    const expectedSupabaseHost = (() => { try { return new URL(supabaseConfig?.url).hostname; } catch { return ''; } })();
    const isPrivateReleaseAsset = parsed.protocol === 'https:'
      && expectedSupabaseHost
      && parsed.hostname === expectedSupabaseHost
      && parsed.pathname === '/functions/v1/sunify-admin'
      && parsed.searchParams.get('action') === 'download-release'
      && /^\d+$/.test(parsed.searchParams.get('assetId') || '');
    if (!isPublicGitHubAsset && !isPrivateReleaseAsset) {
      return 'Güncelleme bağlantısı güvenli değil.';
    }
    installerPath = path.join(app.getPath('temp'), 'Sunify-Update-Setup.exe');
    await fs.promises.rm(installerPath, { force: true });
    const response = await axios.get(parsed.toString(), {
      responseType: 'stream',
      timeout: 120_000,
      maxRedirects: 5,
      maxContentLength: 350 * 1024 * 1024,
      ...(isPrivateReleaseAsset ? { headers: { apikey: supabaseConfig.anonKey, Authorization: `Bearer ${supabaseConfig.anonKey}` } } : {}),
    });
    if (response.status !== 200) throw new Error(`İndirme sunucusu ${response.status} yanıtı verdi.`);
    await pipeline(response.data, fs.createWriteStream(installerPath, { flags: 'wx' }));
    return await new Promise((resolve) => {
      const installer = spawn(installerPath, [], { detached: true, stdio: 'ignore', windowsHide: false });
      installer.once('error', (error) => resolve(error.message));
      installer.once('spawn', () => {
        installer.unref();
        setTimeout(() => app.quit(), 250);
        resolve('');
      });
    });
  } catch (error) {
    if (installerPath) await fs.promises.rm(installerPath, { force: true }).catch(() => {});
    return error.message;
  }
});

ipcMain.handle('get-app-version', (event) => {
  if (!fromAppWindow(event)) return '';
  return app.getVersion();
});

ipcMain.handle('get-diagnostics', async () => {
  const { getRuntimeStatus } = require('../services/audio/streamProxy');
  return getRuntimeStatus();
});

app.whenReady().then(() => {
  if (app.isPackaged) app.setAsDefaultProtocolClient('sunify');
  else if (process.platform === 'win32') app.setAsDefaultProtocolClient('sunify', process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient('sunify');
  globalShortcut.register('Alt+Shift+O', () => {
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed() && miniPlayerWindow.isVisible()) {
      miniPlayerWindow.hide();
      miniPlayerDismissed = true;
      miniPlayerForcedVisible = false;
      return;
    }
    miniPlayerDismissed = false;
    miniPlayerForcedVisible = true;
    showMiniPlayer(true);
  });
  initRPC();
  ensureSystemTray();
  setAccountChangedHandler((profile) => {
    discordAccountProfile = profile;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('discord-account-profile', profile);
    }
  });
  startServer({
    onReady: (port) => {
      app.__sunifyApiPort = port;
      createWindow();
    },
    onError: (error) => dialog.showErrorBox('Sunify başlatılamadı', error.message),
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuittingApp = true;
  globalShortcut.unregisterAll();
  clearPresence();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
