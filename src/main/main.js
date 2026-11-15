const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
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
const { updatePresence, clearPresence, initRPC } = require('../services/rpc/rpc');
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;
let pendingEmailVerificationResult = null;
let miniPlayerWindow;
let miniPlayerDismissed = false;
const miniPlayerSettings = {
  enabled: true,
  onMinimize: true,
  alwaysOnTop: true,
  position: 'top-center',
  size: 'medium',
  opacity: 0.88,
};

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

function deliverEmailVerificationResult(rawUrl) {
  const result = parseEmailVerificationCallback(rawUrl);
  if (!result) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    pendingEmailVerificationResult = result;
    return;
  }
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.webContents.send('auth-email-verification-result', result);
}

function findEmailVerificationUrl(args) {
  return args.find((value) => typeof value === 'string' && value.startsWith('sunify://auth/callback'));
}

if (process.platform === 'win32' && process.argv.length > 1) {
  deliverEmailVerificationResult(findEmailVerificationUrl(process.argv) || '');
}
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverEmailVerificationResult(url);
});
app.on('second-instance', (_event, commandLine) => {
  deliverEmailVerificationResult(findEmailVerificationUrl(commandLine) || '');
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function miniPlayerBounds() {
  const { screen } = require('electron');
  const area = screen.getPrimaryDisplay().workArea;
  const dimensions = {
    small: { width: 312, height: 64 },
    medium: { width: 420, height: 76 },
    large: { width: 540, height: 90 },
  }[miniPlayerSettings.size] || { width: 420, height: 76 };
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

function showMiniPlayer(force = false) {
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
    miniPlayerWindow.loadFile(path.join(__dirname, '../renderer/mini-player.html'));
    miniPlayerWindow.once('ready-to-show', () => {
      applyMiniPlayerSettings();
      if (!miniPlayerDismissed && mainWindow?.isMinimized()) miniPlayerWindow?.showInactive();
    });
    miniPlayerWindow.on('closed', () => { miniPlayerWindow = null; });
  } else {
    applyMiniPlayerSettings();
    miniPlayerWindow.showInactive();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    frame: false,
    backgroundColor: '#0a0a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  const port = app.__sunifyApiPort || 3001;
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { apiPort: String(port) } });
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingEmailVerificationResult) {
      mainWindow.webContents.send('auth-email-verification-result', pendingEmailVerificationResult);
      pendingEmailVerificationResult = null;
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    miniPlayerWindow?.close();
  });
  mainWindow.on('minimize', showMiniPlayer);
  mainWindow.on('restore', () => {
    miniPlayerDismissed = false;
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) miniPlayerWindow.hide();
  });
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
    title: String(data.title || '').slice(0, 127),
    artist: String(data.artist || '').slice(0, 127),
    thumbnail: typeof data.thumbnail === 'string' && data.thumbnail.startsWith('https://') ? data.thumbnail : '',
    position: Number(data.position) || 0,
    duration: Number(data.duration) || 0,
    isPlaying: Boolean(data.isPlaying),
  });
});

ipcMain.on('discord-rpc-clear', (event) => {
  if (fromAppWindow(event)) clearPresence();
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
  if ((!miniPlayerSettings.enabled || !miniPlayerSettings.onMinimize) && miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.hide();
  } else {
    applyMiniPlayerSettings();
    if (miniPlayerSettings.enabled && miniPlayerSettings.onMinimize && mainWindow?.isMinimized()) {
      miniPlayerDismissed = false;
      showMiniPlayer();
    }
  }
});

ipcMain.on('mini-player-opacity', (event, opacity) => {
  if (!fromAppWindow(event)) return;
  miniPlayerSettings.opacity = Math.max(0.35, Math.min(1, Number(opacity) || 0.88));
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.webContents.send('mini-player-opacity', miniPlayerSettings.opacity);
  }
});

ipcMain.on('mini-player-state', (event, state) => {
  if (!fromAppWindow(event) || !miniPlayerWindow || miniPlayerWindow.isDestroyed()) return;
  if (!state || typeof state !== 'object') return;
  miniPlayerWindow.webContents.send('mini-player-state', {
    title: String(state.title || '').slice(0, 160),
    artist: String(state.artist || '').slice(0, 160),
    thumbnail: typeof state.thumbnail === 'string' && /^https:\/\//.test(state.thumbnail) ? state.thumbnail : '',
    playing: Boolean(state.playing),
    progress: Math.max(0, Math.min(100, Number(state.progress) || 0)),
    elapsed: String(state.elapsed || '0:00').slice(0, 8),
    duration: String(state.duration || '0:00').slice(0, 8),
    accent: /^#[\da-f]{6}$/i.test(state.accent || '') ? state.accent : '#a78bfa',
  });
});

ipcMain.on('mini-player-action', (event, action, value) => {
  if (!miniPlayerWindow || event.sender !== miniPlayerWindow.webContents) return;
  if (action === 'close') {
    miniPlayerDismissed = true;
    miniPlayerWindow.hide();
    return;
  }
  if (['toggle', 'previous', 'next', 'seek'].includes(action) && mainWindow && !mainWindow.isDestroyed()) {
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
  const cacheDir = app.getPath('cache');
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
      return;
    }
    miniPlayerDismissed = false;
    showMiniPlayer(true);
  });
  initRPC();
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
  globalShortcut.unregisterAll();
  clearPresence();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
