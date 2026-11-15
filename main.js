const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const { startServer } = require('../server');
const { updatePresence, clearPresence } = require('../services/rpc/rpc');

// Kalıcı userData dizini: Her açılışta oturum ve verilerin kaybolmasını engeller
const permanentUserData = path.join(app.getPath('appData'), 'SunifyPlayerData');
app.setPath('userData', permanentUserData);
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');
app.commandLine.appendSwitch('log-level', '3'); // Sadece kritik loglar

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    frame: false, // Windows varsayılan çubuğunu kaldır, özel modern frameless başlık çubuğu kullan
    backgroundColor: '#0a0a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false, // CORS ve stream oynatımı için
    },
    icon: path.join(__dirname, '../renderer/logo.png'),
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Pencere Kontrolleri (Minimize, Maximize/Restore, Close)
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.on('window-fullscreen', () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  }
});

// IPC Dinleyicileri (Renderer'dan gelen Discord RPC çağrıları)
ipcMain.on('discord-rpc-update', (event, data) => {
  updatePresence(data);
});

ipcMain.on('discord-rpc-clear', () => {
  clearPresence();
});

// Uygulama kapanırken Discord durumunu temizle
app.on('before-quit', () => {
  clearPresence();
});

app.whenReady().then(() => {
  startServer(() => {
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
