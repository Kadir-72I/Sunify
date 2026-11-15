const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniPlayerAPI', {
  action: (action, value) => ipcRenderer.send('mini-player-action', action, value),
  onState: (callback) => ipcRenderer.on('mini-player-state', (_event, state) => callback(state)),
  onSize: (callback) => ipcRenderer.on('mini-player-size', (_event, size) => callback(size)),
  onOpacity: (callback) => ipcRenderer.on('mini-player-opacity', (_event, opacity) => callback(opacity)),
});
