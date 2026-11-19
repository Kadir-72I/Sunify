// mobile-bridge.js — Sunify Android WebView köprüsü (masaüstünde pasiftir)
(function initSunifyMobileBridge() {
  const params = new URLSearchParams(location.search);
  const isMobile = params.get('mobile') === '1' || Boolean(window.SunifyAndroidBridge);
  if (!isMobile) return;

  document.documentElement.classList.add('is-mobile');
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('is-mobile');
  });

  if (window.sunifyAPI) return;

  const bridge = window.SunifyAndroidBridge;
  let mediaControlCallback = null;

  window.__sunifyOnAndroidMediaAction = (action, value) => {
    if (typeof mediaControlCallback === 'function') {
      mediaControlCallback(action, value);
    }
  };

  window.sunifyAPI = {
    minimizeWindow: () => {},
    maximizeWindow: () => {},
    closeWindow: () => {},
    toggleFullscreen: () => {},
    updateDiscordPresence: () => {},
    clearDiscordPresence: () => {},
    onPlayRequest: () => {},
    getDiscordAccountProfile: async () => null,
    onDiscordAccountProfile: () => {},
    chooseMusicFolders: async () => [],
    openDownloadsFolder: async () => 'İndirilenler uygulama içi önbellekte saklanır.',
    openCacheFolder: async () => 'Önbellek uygulama içi önbellekte saklanır.',
    installUpdateFromUrl: async () => 'Güncellemeler GitHub Releases üzerinden APK olarak yüklenir.',
    getAppVersion: async () => {
      try {
        return bridge?.getAppVersion ? String(bridge.getAppVersion()) : '1.2.1';
      } catch {
        return '1.2.1';
      }
    },
    getDiagnostics: async () => ({ ready: true, platform: 'android', engine: 'NewPipeExtractor' }),
    getSecureAuthValue: (key) => {
      try {
        const val = bridge?.getSecureAuthValue ? bridge.getSecureAuthValue(String(key)) : null;
        return val === '' || val === null || val === undefined ? null : String(val);
      } catch {
        return null;
      }
    },
    setSecureAuthValue: (key, value) => {
      try {
        return Boolean(bridge?.setSecureAuthValue?.(String(key), String(value)));
      } catch {
        return false;
      }
    },
    deleteSecureAuthValue: (key) => {
      try {
        bridge?.deleteSecureAuthValue?.(String(key));
        return true;
      } catch {
        return false;
      }
    },
    updateMiniPlayerSettings: () => {},
    updateMiniPlayerOpacity: () => {},
    updateMiniPlayerState: (state) => {
      try {
        if (bridge?.updatePlaybackNotification && state) {
          bridge.updatePlaybackNotification(JSON.stringify(state));
        }
      } catch {}
    },
    toggleMiniPlayer: () => {},
    updateCloseToTray: () => {},
    onMiniPlayerStateRequest: () => {},
    onMiniPlayerControl: (cb) => {
      mediaControlCallback = cb;
    },
    onWindowMinimizedState: () => {},
  };
})();
