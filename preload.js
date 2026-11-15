// preload.js - Güvenli Köprü (contextBridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sunifyAPI', {
  // Pencere kontrolleri
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  toggleFullscreen: () => ipcRenderer.send('window-fullscreen'),

  // Renderer'dan Discord RPC güncellemesi gönderir
  updateDiscordPresence: (playbackData) => {
    ipcRenderer.send('discord-rpc-update', playbackData);
  },
  // Discord durumunu temizler (şarkı bittiğinde veya durduğunda)
  clearDiscordPresence: () => {
    ipcRenderer.send('discord-rpc-clear');
  },
  onEmailVerificationResult: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('auth-email-verification-result', listener);
    return () => ipcRenderer.removeListener('auth-email-verification-result', listener);
  },
});
