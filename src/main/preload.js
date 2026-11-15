const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sunifyAPI', {
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  toggleFullscreen: () => ipcRenderer.send('window-fullscreen'),
  updateDiscordPresence: (playbackData) => ipcRenderer.send('discord-rpc-update', playbackData),
  clearDiscordPresence: () => ipcRenderer.send('discord-rpc-clear'),
  chooseMusicFolders: () => ipcRenderer.invoke('choose-music-folders'),
  openDownloadsFolder: () => ipcRenderer.invoke('open-downloads-folder'),
  openCacheFolder: () => ipcRenderer.invoke('open-cache-folder'),
  installUpdateFromUrl: (url) => ipcRenderer.invoke('install-update-from-url', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
  updateMiniPlayerSettings: (settings) => ipcRenderer.send('mini-player-settings', settings),
  updateMiniPlayerState: (state) => ipcRenderer.send('mini-player-state', state),
  onMiniPlayerControl: (callback) => ipcRenderer.on('mini-player-control', (_event, action, value) => callback(action, value)),
});
