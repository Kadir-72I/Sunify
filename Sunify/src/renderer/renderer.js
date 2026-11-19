// renderer.js
if (new URLSearchParams(location.search).get('acrylic') === '1') document.documentElement.classList.add('acrylic');
const PLACEHOLDER_COVER = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Cdefs%3E%3ClinearGradient id=%27g%27 x1=%270%27 y1=%270%27 x2=%271%27 y2=%271%27%3E%3Cstop offset=%270%27 stop-color=%27%237c5cff%27/%3E%3Cstop offset=%271%27 stop-color=%27%23241126%27/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width=%2764%27 height=%2764%27 fill=%27url(%23g)%27/%3E%3Cpath d=%27M26 40V22l16-4v18%27 fill=%27none%27 stroke=%27%23fff%27 stroke-opacity=%27.7%27 stroke-width=%273%27 stroke-linecap=%27round%27/%3E%3Ccircle cx=%2723%27 cy=%2741%27 r=%274%27 fill=%27%23fff%27 fill-opacity=%27.7%27/%3E%3Ccircle cx=%2739%27 cy=%2737%27 r=%274%27 fill=%27%23fff%27 fill-opacity=%27.7%27/%3E%3C/svg%3E";
const { parseLRCWithWordTiming } = window.SunifyLyricsTiming;
const API_BASE = `http://127.0.0.1:${new URLSearchParams(location.search).get('apiPort') || 3001}/api`;

function readStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (error) {
    console.warn(`Sunify ayarı okunamadı (${key}); varsayılan değer kullanılıyor.`, error);
    try { localStorage.removeItem(key); } catch {}
    return fallback;
  }
}

const AUTH_SECRET_KEYS = new Set(['sunify_auth_session', 'sunify_saved_profiles']);
function readAuthSecret(key, fallback) {
  if (!AUTH_SECRET_KEYS.has(key)) return fallback;
  try {
    const secureValue = window.sunifyAPI?.getSecureAuthValue?.(key);
    if (typeof secureValue === 'string') return JSON.parse(secureValue);
    // One-time migration of old plaintext browser storage to Electron safeStorage.
    const legacyValue = localStorage.getItem(key);
    if (legacyValue !== null && window.sunifyAPI?.setSecureAuthValue?.(key, legacyValue)) {
      localStorage.removeItem(key);
      return JSON.parse(legacyValue);
    }
  } catch (error) {
    console.warn(`Güvenli hesap oturumu okunamadı (${key}).`, error);
  }
  return fallback;
}

function writeAuthSecret(key, value) {
  if (!AUTH_SECRET_KEYS.has(key)) return false;
  try {
    const saved = window.sunifyAPI?.setSecureAuthValue?.(key, JSON.stringify(value));
    if (saved) localStorage.removeItem(key);
    return Boolean(saved);
  } catch (error) {
    console.error(`Hesap oturumu güvenli kaydedilemedi (${key}).`, error);
    return false;
  }
}

function deleteAuthSecret(key) {
  if (!AUTH_SECRET_KEYS.has(key)) return;
  try { window.sunifyAPI?.deleteSecureAuthValue?.(key); } catch {}
  localStorage.removeItem(key);
}

const SUNIFY_ADMIN_EMAIL = 'abdulkadirguness72@gmail.com';

function restoreSessionIdentity(session) {
  const token = session?.access_token;
  if (typeof token !== 'string' || token.startsWith('local_session_')) return session;
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = decodeURIComponent(Array.from(atob(payload), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
    const claims = JSON.parse(decoded);
    if (session.user && claims.sub) session.user.id = claims.sub;
    if (session.user && claims.email) session.user.email = claims.email;
  } catch {}
  return session;
}

// Single source of truth for signed-in profiles and the active session.
const SunifyAccountStore = (() => {
  const SESSION_KEY = 'sunify_auth_session';
  const PROFILES_KEY = 'sunify_saved_profiles';
  let activeSession = normalizeSession(readAuthSecret(SESSION_KEY, null));

  function normalizeSession(session) {
    const restored = restoreSessionIdentity(session);
    if (!restored || typeof restored.access_token !== 'string' || !restored.user) return null;
    const email = String(restored.user.email || '').trim().toLowerCase();
    const id = String(restored.user.id || '').trim();
    if (!email || !id) return null;
    return {
      ...restored,
      user: {
        ...restored.user,
        id,
        email,
        user_metadata: restored.user.user_metadata || {},
      },
    };
  }

  function identity(session) {
    const user = session?.user;
    return String(user?.id || user?.email || '').trim().toLowerCase();
  }

  function readProfiles() {
    const stored = readAuthSecret(PROFILES_KEY, []);
    if (!Array.isArray(stored)) return [];
    const unique = new Map();
    stored.forEach((entry) => {
      const session = normalizeSession(entry?.session);
      if (!session) return;
      const key = identity(session);
      if (!key) return;
      unique.set(key, {
        email: session.user.email,
        username: String(entry.username || session.user.user_metadata.username || session.user.email.split('@')[0]),
        session,
      });
    });
    return [...unique.values()];
  }

  function writeProfiles(profiles) {
    if (!writeAuthSecret(PROFILES_KEY, profiles)) throw new Error('Hesap listesi bu cihazda güvenli biçimde saklanamadı.');
  }

  function remember(session, username = '') {
    const normalized = normalizeSession(session);
    if (!normalized) throw new Error('Hesap oturumu geçersiz; e-posta ve oturum anahtarı bulunamadı.');
    const profiles = readProfiles();
    const key = identity(normalized);
    const index = profiles.findIndex((profile) => identity(profile.session) === key);
    const profile = {
      email: normalized.user.email,
      username: String(username || normalized.user.user_metadata.username || normalized.user.email.split('@')[0]),
      session: normalized,
    };
    if (index < 0) profiles.push(profile);
    else profiles[index] = profile;
    writeProfiles(profiles);
    return profile;
  }

  function list() {
    const profiles = readProfiles();
    if (activeSession) {
      const key = identity(activeSession);
      if (!profiles.some((profile) => identity(profile.session) === key)) {
        profiles.push({
          email: activeSession.user.email,
          username: activeSession.user.user_metadata.username || activeSession.user.email.split('@')[0],
          session: activeSession,
        });
        writeProfiles(profiles);
      }
    }
    return profiles;
  }

  function setActive(session) {
    activeSession = session ? normalizeSession(session) : null;
    if (session && !activeSession) throw new Error('Hesap oturumu geçersiz. Lütfen yeniden giriş yapın.');
    if (activeSession && !writeAuthSecret(SESSION_KEY, activeSession)) throw new Error('Oturum bu cihazda güvenli biçimde saklanamadı.');
    else if (!activeSession) deleteAuthSecret(SESSION_KEY);
    return activeSession;
  }

  function forget(session) {
    const key = identity(session);
    writeProfiles(readProfiles().filter((profile) => identity(profile.session) !== key));
    if (key && identity(activeSession) === key) {
      activeSession = null;
      deleteAuthSecret(SESSION_KEY);
    }
  }

  if (activeSession) {
    try { writeAuthSecret(SESSION_KEY, activeSession); } catch {}
  }
  return { getActive: () => activeSession, normalizeSession, setActive, list, remember, forget };
})();

let currentAuthSession = SunifyAccountStore.getActive();
let knownProfiles = SunifyAccountStore.list();

async function validateAndRefreshAccountSession(session) {
  if (!session?.access_token) throw new Error('Hesap oturumu bulunamadı. Yeniden giriş yap.');
  const response = await fetch(`${API_BASE}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ refresh_token: session.refresh_token || '' }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  if (!response.ok || !data.valid) throw new Error(data.error || 'Oturum artık geçerli değil. Yeniden giriş yap.');
  if (!data.refreshed || !data.session) return session;
  const user = data.user || data.session.user;
  const refreshedSession = { ...data.session, user: { ...data.session.user, ...user } };
  SunifyAccountStore.remember(refreshedSession, user?.user_metadata?.username || user?.email?.split('@')[0]);
  if (currentAuthSession?.user?.id === session.user?.id) SunifyAccountStore.setActive(refreshedSession);
  knownProfiles = SunifyAccountStore.list();
  return refreshedSession;
}

const ACCOUNT_DATA_KEYS = [
  'sunify_search_history',
  'sunify_recent_tracks',
  'sunify_liked',
  'sunify_recommendation_feedback',
  'sunify_track_analytics',
  'sunify_custom_playlists',
  'sunify_listening_stats',
];

function accountStorageKey(key, session = currentAuthSession) {
  const userId = session?.user?.id;
  const identity = userId ? String(userId).trim() : String(session?.user?.email || 'guest').trim().toLowerCase();
  return `sunify_account_${encodeURIComponent(identity)}_${key}`;
}

function isValidAccountValue(key, value) {
  if (['sunify_search_history', 'sunify_recent_tracks', 'sunify_liked', 'sunify_custom_playlists'].includes(key)) {
    return Array.isArray(value);
  }
  if (key === 'sunify_recommendation_feedback') {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      && Array.isArray(value.liked) && Array.isArray(value.dismissed);
  }
  if (['sunify_track_analytics', 'sunify_listening_stats'].includes(key)) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
  return true;
}

function readAccountJson(key, fallback, session = currentAuthSession, includeLegacy = false) {
  try {
    const accountValue = localStorage.getItem(accountStorageKey(key, session));
    if (accountValue !== null) {
      const parsed = JSON.parse(accountValue);
      return isValidAccountValue(key, parsed) ? parsed : fallback;
    }
    if (includeLegacy) {
      const legacyValue = readStoredJson(key, fallback);
      return isValidAccountValue(key, legacyValue) ? legacyValue : fallback;
    }
  } catch (error) {
    console.warn(`Hesap verisi okunamadı (${key}).`, error);
  }
  return fallback;
}

function writeAccountJson(key, value, session = currentAuthSession) {
  if (!isValidAccountValue(key, value)) return false;
  try {
    localStorage.setItem(accountStorageKey(key, session), JSON.stringify(value));
    if (session === currentAuthSession && currentAuthSession?.user
      && ['sunify_custom_playlists', 'sunify_liked', 'sunify_track_analytics'].includes(key)) {
      scheduleAccountCloudSync();
    }
    return true;
  } catch (error) {
    console.warn(`Hesap verisi kaydedilemedi (${key}).`, error);
    return false;
  }
}

let accountCloudSyncTimer = null;
let accountCloudSyncPaused = 0;
function scheduleAccountCloudSync(delay = 900) {
  if (!currentAuthSession?.user || accountCloudSyncPaused > 0) return;
  clearTimeout(accountCloudSyncTimer);
  accountCloudSyncTimer = setTimeout(() => {
    accountCloudSyncTimer = null;
    void syncToCloudSilently();
  }, delay);
}

// ----------------------------------------------------
// ZAMAN FORMATLAYICI & BİLDİRİM FONKSİYONU
// ----------------------------------------------------
function formatTime(secs) {
  if (isNaN(secs) || secs === null || secs === undefined) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

let toastTimer = null;
let activeDownloads = 0;
const MAX_PARALLEL_DOWNLOADS = 2;
const downloadQueue = [];
const activeDownloadKeys = new Set();
const downloadKey = (track) => track?.id ? String(track.id) : `${normalizeTrackText(track?.artist)}|${normalizeTrackText(track?.title)}`;

function enqueueTrackDownload(track) {
  if (!track || activeDownloadKeys.has(downloadKey(track))) return;
  const sameTrack = (item) => item && (item.id && track?.id ? String(item.id) === String(track.id) : normalizeTrackText(item.title) === normalizeTrackText(track?.title) && normalizeTrackText(item.artist) === normalizeTrackText(track?.artist));
  if (downloadQueue.some(sameTrack)) return;
  if (downloadQueue.length >= 100) {
    showAppNotification('İndirme kuyruğu dolu', 'Kuyrukta en fazla 100 parça olabilir.', true);
    return;
  }
  downloadQueue.push(track);
  processDownloadQueue();
  showAppNotification('İndirme kuyruğu', `${downloadQueue.length + activeDownloads} parça sırada.`);
}

function processDownloadQueue() {
  while (activeDownloads < MAX_PARALLEL_DOWNLOADS && downloadQueue.length) {
    const track = downloadQueue.shift();
    activeDownloadKeys.add(downloadKey(track));
    activeDownloads += 1;
    downloadTrackFile(track).finally(() => {
      activeDownloadKeys.delete(downloadKey(track));
      activeDownloads -= 1;
      processDownloadQueue();
    });
  }
}
function showAppNotification(title, message, isError = false) {
  const toast = document.getElementById('sunifyToast');
  const toastTitle = document.getElementById('toastTitle');
  const toastMsg = document.getElementById('toastMsg');
  const toastIcon = document.getElementById('toastIcon');

  if (!toast) return;

  toastTitle.textContent = title;
  toastMsg.textContent = message;
  toast.className = `sunify-toast ${isError ? 'error' : ''}`;
  toastIcon.innerHTML = isError
    ? '<i class="fa-solid fa-triangle-exclamation"></i>'
    : '<i class="fa-solid fa-circle-check"></i>';

  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 4000);
}

let updateCheckPromise = null;

async function checkForUpdates({ manual = false, notifyOnUpdate = false } = {}) {
  if (updateCheckPromise) return updateCheckPromise;
  const button = document.getElementById('btnCheckUpdates');
  const status = document.getElementById('updateStatusText');
  const defaultButtonHtml = '<i class="fa-solid fa-rotate"></i> Güncellemeleri denetle';
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Denetleniyor...';
  }
  if (status) status.textContent = 'GitHub Releases kontrol ediliyor...';

  updateCheckPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE}/updates/latest`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || 'Güncelleme bilgisi alınamadı.');
      if (!data.configured) {
        if (status) status.textContent = 'Güncelleme kaynağı henüz yapılandırılmadı.';
        if (button) {
          button.innerHTML = defaultButtonHtml;
          button.disabled = false;
          button.onclick = () => checkForUpdates({ manual: true });
        }
        if (manual) showAppNotification('Güncellemeler', 'GitHub Releases deposu yapılandırılmamış.', true);
        return data;
      }
      if (data.updateAvailable) {
        if (status) status.textContent = `Sunify v${data.version} indirip kurabilirsiniz.`;
        if (button) {
          button.innerHTML = `<i class="fa-solid fa-download"></i> v${data.version} indir ve kur`;
          button.disabled = !data.downloadUrl;
          button.onclick = async () => {
            if (!data.downloadUrl) {
              showAppNotification('Güncelleme', 'Bu sürümde Windows kurulum dosyası bulunamadı.', true);
              return;
            }
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> İndiriliyor...';
            const error = await window.sunifyAPI?.installUpdateFromUrl?.(data.downloadUrl);
            if (error) {
              button.disabled = false;
              button.innerHTML = `<i class="fa-solid fa-download"></i> v${data.version} indir ve kur`;
              showAppNotification('Güncelleme kurulamadı', error, true);
            }
          };
        }
        const notifiedVersion = localStorage.getItem('sunify_update_notified_version');
        if (notifyOnUpdate && notifiedVersion !== data.version) {
          showAppNotification('Yeni Sunify sürümü', `v${data.version} hazır. Ayarlar > Hakkında bölümünden indirip kurabilirsiniz.`);
          localStorage.setItem('sunify_update_notified_version', data.version);
        } else if (manual) {
          showAppNotification('Güncelleme bulundu', `Sunify v${data.version} indirip kurabilirsiniz.`);
        }
      } else {
        if (status) status.textContent = `Sunify v${data.currentVersion} güncel.`;
        if (button) {
          button.innerHTML = '<i class="fa-solid fa-circle-check"></i> Yeniden denetle';
          button.disabled = false;
          button.onclick = () => checkForUpdates({ manual: true });
        }
        if (manual) showAppNotification('Güncellemeler', `Sunify v${data.currentVersion} güncel.`);
      }
      return data;
    } catch (error) {
      if (status) status.textContent = `Güncelleme denetimi başarısız: ${error.message}`;
      if (button) {
        button.innerHTML = defaultButtonHtml;
        button.disabled = false;
      }
      if (manual) showAppNotification('Güncellemeler denetlenemedi', error.message, true);
      return null;
    } finally {
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

// Uygulama Durumu (State)
let currentTrack = null;
let currentPlaylist = [];
let currentIndex = -1;
let currentArtistProfile = null;
let showAllArtistTracks = false;
let artistRequestId = 0;
let isPlaying = false;
let isShuffle = false;
let repeatMode = 'off'; // 'off' | 'all' | 'one'
let shuffleHistory = [];
let parsedLyrics = [];
let lyricsHaveTimestamps = false;
let searchHistory = readAccountJson('sunify_search_history', [], currentAuthSession, true);
let recentHistory = readAccountJson('sunify_recent_tracks', [], currentAuthSession, true);
let playbackResumeState = readAccountJson('sunify_playback_state', null, currentAuthSession);
let likedTracks = readAccountJson('sunify_liked', [], currentAuthSession, true);
let recommendationFeedback = readAccountJson('sunify_recommendation_feedback', { liked: [], dismissed: [] }, currentAuthSession, true);
localStorage.setItem('sunify_theme', 'dark');
let activeLibraryFilter = 'all';

// KAPSAMLI DİNLEME VERİLERİ (Analytics: Dinleme sayısı, süresi, günleri, playlist sayıları)
let trackAnalytics = readAccountJson('sunify_track_analytics', {}, currentAuthSession, true);
let globalTopTracks = [];
let globalChartUnavailable = false;
const dailyMixCache = new Map();
const dailyMixInFlight = new Map();
let dailyMixRenderRequest = 0;

// Kişisel dinleme istatistiklerini (Daily Mixes, Dinleme Özeti, Sanatçı Dinlemeleri)
// koru; yanlışlıkla sıfırlanmışsa yerel sunify_users.json yedeğinden otomatik geri yükle.
const LISTEN_COUNT_VERSION = 3;
let statsRecoveryInFlight = null;
function applyListenCountMigration() {
  if (!trackAnalytics || typeof trackAnalytics !== 'object') trackAnalytics = {};
  const entries = Object.values(trackAnalytics).filter((e) => e && typeof e === 'object');
  const hasActiveStats = entries.some((e) => (Number(e.playCount) || 0) > 0);
  if (hasActiveStats || statsRecoveryInFlight) return;
  statsRecoveryInFlight = fetch(`${API_BASE}/sync/recovered-stats`)
    .then((r) => r.json())
    .then((data) => {
      const recovered = data?.listeningStats;
      if (!recovered || typeof recovered !== 'object') return;
      const recEntries = Object.values(recovered);
      if (!recEntries.some((e) => e && (Number(e.playCount) || 0) > 0)) return;
      for (const [k, v] of Object.entries(recovered)) {
        if (!v || typeof v !== 'object') continue;
        const cur = trackAnalytics[k] || {};
        trackAnalytics[k] = {
          ...cur,
          ...v,
          playCount: Math.max(Number(v.playCount) || 0, Number(cur.playCount) || 0),
          totalSeconds: Math.max(Number(v.totalSeconds) || 0, Number(cur.totalSeconds) || 0),
          days: Array.isArray(v.days) && v.days.length ? v.days : (cur.days || []),
          countVersion: LISTEN_COUNT_VERSION,
        };
      }
      writeAccountJson('sunify_track_analytics', trackAnalytics);
      writeAccountJson('sunify_listening_stats', trackAnalytics);
      renderDailyMixes();
      renderListeningStats();
    })
    .catch(() => {})
    .finally(() => { statsRecoveryInFlight = null; });
}
setTimeout(() => applyListenCountMigration(), 400);

function ensureTrackAnalyticsEntry(track) {
  const key = `${track.artist || ''} - ${track.title}`.trim().toLowerCase();
  if (!trackAnalytics[key]) {
    trackAnalytics[key] = {
      title: track.title,
      artist: track.artist,
      playCount: 0,
      totalSeconds: 0,
      days: [],
      inPlaylistsCount: 0,
      lastPlayed: new Date().toISOString(),
      countVersion: LISTEN_COUNT_VERSION,
    };
  }
  return key;
}

// Şarkı başladığında: yalnızca "son çalınan" bilgisini günceller, sayaç artmaz.
function trackSongStartEvent(track) {
  if (!track || !track.title) return;
  const key = ensureTrackAnalyticsEntry(track);
  trackAnalytics[key].lastPlayed = new Date().toISOString();
  trackAnalytics[key].thumbnail = track.thumbnail || trackAnalytics[key].thumbnail || '';
  trackAnalytics[key].duration = Number(track.duration) || trackAnalytics[key].duration || 0;
  trackAnalytics[key].id = track.id || trackAnalytics[key].id || '';
  trackAnalytics[key].query = track.query || trackAnalytics[key].query || '';
  writeAccountJson('sunify_track_analytics', trackAnalytics);
}

// Şarkı atlanmadan sonuna kadar dinlendiğinde çağrılır: dinleme sayısını artırır.
function trackSongCompletedEvent(track) {
  if (!track || !track.title) return;
  const key = ensureTrackAnalyticsEntry(track);
  const dayName = new Intl.DateTimeFormat('tr-TR', { weekday: 'long' }).format(new Date());

  trackAnalytics[key].playCount = (Number(trackAnalytics[key].playCount) || 0) + 1;
  trackAnalytics[key].lastPlayed = new Date().toISOString();
  if (!trackAnalytics[key].days.includes(dayName)) {
    trackAnalytics[key].days.push(dayName);
  }

  // Şarkının kaç çalma listesinde bulunduğunu hesapla
  let playlistCount = 0;
  customPlaylists.forEach((pl) => {
    if (pl.tracks && pl.tracks.some((t) => t.title === track.title)) playlistCount++;
  });
  if (likedTracks.some((t) => t.title === track.title)) playlistCount++;
  trackAnalytics[key].inPlaylistsCount = playlistCount;
  trackAnalytics[key].thumbnail = track.thumbnail || trackAnalytics[key].thumbnail || '';
  trackAnalytics[key].duration = Number(track.duration) || trackAnalytics[key].duration || 0;
  trackAnalytics[key].id = track.id || trackAnalytics[key].id || '';
  trackAnalytics[key].query = track.query || trackAnalytics[key].query || '';

  writeAccountJson('sunify_track_analytics', trackAnalytics);
  const sharedTrackId = String(track.id || `${key}`).slice(0, 200);
  fetch(`${API_BASE}/discover/play`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ track: { id: sharedTrackId, title: track.title, artist: track.artist || '', thumbnail: track.thumbnail || '' } }),
  }).then((response) => {
    if (!response.ok) {
      globalChartUnavailable = true;
      renderNowPlayingDualGrid();
      return;
    }
    globalChartUnavailable = false;
    refreshGlobalTopTracks();
  }).catch(() => {
    globalChartUnavailable = true;
    renderNowPlayingDualGrid();
  });
  renderDailyMixes();
  renderNowPlayingDualGrid();
  renderListeningStats();
  loadHomeRecommendations();
}

function renderListeningStats() {
  const grid = document.getElementById('listeningStatsGrid');
  if (!grid) return;
  const rows = Object.values(trackAnalytics || {});
  const totalPlays = rows.reduce((sum, item) => sum + (Number(item.playCount) || 0), 0);
  const totalMinutes = Math.round(rows.reduce((sum, item) => sum + (Number(item.totalSeconds) || 0), 0) / 60);
  const artists = new Map();
  rows.forEach((item) => artists.set(item.artist || 'Bilinmeyen', (artists.get(item.artist || 'Bilinmeyen') || 0) + (Number(item.playCount) || 0)));
  const topArtist = [...artists.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Henüz yok';
  const topTrack = [...rows].sort((a, b) => (Number(b.playCount) || 0) - (Number(a.playCount) || 0))[0];
  const stats = [
    ['Toplam çalma', totalPlays.toLocaleString('tr-TR'), 'fa-headphones'],
    ['Dinleme süresi', `${totalMinutes} dk`, 'fa-clock'],
    ['En çok dinlenen sanatçı', topArtist, 'fa-microphone'],
    ['En çok dinlenen parça', topTrack?.title || 'Henüz yok', 'fa-music'],
  ];
  grid.replaceChildren(...stats.map(([label, value, icon]) => {
    const card = document.createElement('article');
    card.className = 'hm-stat';
    card.innerHTML = `<i class="fa-solid ${icon}"></i><span></span><strong></strong>`;
    card.querySelector('span').textContent = label;
    card.querySelector('strong').textContent = value;
    return card;
  }));
}

function updateTrackListeningDuration(track, addedSeconds) {
  if (!track || !track.title || addedSeconds <= 0) return;
  const key = `${track.artist || ''} - ${track.title}`.trim().toLowerCase();
  if (trackAnalytics[key]) {
    const previousTotal = Number(trackAnalytics[key].totalSeconds) || 0;
    const nextTotal = previousTotal + addedSeconds;
    trackAnalytics[key].totalSeconds = nextTotal;
    // Disk/localStorage yazımını ve DOM güncellemesini 10 sn yerine 30 sn'de bir yap
    if (Math.floor(nextTotal / 30) > Math.floor(previousTotal / 30)) {
      writeAccountJson('sunify_track_analytics', trackAnalytics);
      if (!isWindowMinimized && !document.hidden && viewHome?.classList.contains('active')) {
        renderListeningStats();
      }
    }
  }
}

// DOM Elemanları
const audio = document.getElementById('audioPlayer');
audio.crossOrigin = 'anonymous';

const EQ_FREQUENCIES = [60, 250, 1000, 4000, 12000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bass: [6, 4, 0, -1, 1],
  vocal: [-2, 0, 3, 4, 1],
  treble: [-2, -1, 0, 3, 6],
};
let audioContext = null;
let audioMediaSource = null;
let equalizerFilters = [];
let equalizerGains = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('sunify_equalizer_gains') || 'null');
    return Array.isArray(saved) && saved.length === 5
      ? saved.map((gain) => Math.max(-12, Math.min(12, Number(gain) || 0)))
      : [...EQ_PRESETS.flat];
  } catch { return [...EQ_PRESETS.flat]; }
})();

function initializeAudioEqualizer() {
  if (equalizerFilters.length) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !audio) throw new Error('Bu sistemde Web Audio ekolayzeri desteklenmiyor.');
  audioContext = new AudioContextClass();
  audioMediaSource = audioContext.createMediaElementSource(audio);
  equalizerFilters = EQ_FREQUENCIES.map((frequency, index) => {
    const filter = audioContext.createBiquadFilter();
    filter.type = index === 0 ? 'lowshelf' : index === EQ_FREQUENCIES.length - 1 ? 'highshelf' : 'peaking';
    filter.frequency.value = frequency;
    filter.Q.value = 1;
    filter.gain.value = equalizerGains[index];
    return filter;
  });
  audioMediaSource.connect(equalizerFilters[0]);
  equalizerFilters.slice(0, -1).forEach((filter, index) => filter.connect(equalizerFilters[index + 1]));
  equalizerFilters[equalizerFilters.length - 1].connect(audioContext.destination);
  const savedOutput = localStorage.getItem('sunify_audio_output_id') || 'default';
  if (savedOutput !== 'default' && typeof audioContext.setSinkId === 'function') {
    audioContext.setSinkId(savedOutput).catch(() => {});
  }
}

async function applyEqualizerGains(gains) {
  equalizerGains = gains.map((gain) => Math.max(-12, Math.min(12, Number(gain) || 0)));
  localStorage.setItem('sunify_equalizer_gains', JSON.stringify(equalizerGains));
  if (equalizerFilters.length) {
    const now = audioContext.currentTime;
    equalizerFilters.forEach((filter, index) => filter.gain.setTargetAtTime(equalizerGains[index], now, 0.035));
  }
  const sliders = document.querySelectorAll('[data-eq-band]');
  sliders.forEach((slider) => {
    const value = equalizerGains[Number(slider.dataset.eqBand)] || 0;
    slider.value = String(value);
    const output = slider.parentElement.querySelector('output');
    if (output) output.value = `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
  });
  document.querySelectorAll('[data-eq-preset]').forEach((button) => {
    const preset = EQ_PRESETS[button.dataset.eqPreset];
    button.classList.toggle('active', Boolean(preset && preset.every((value, index) => value === equalizerGains[index])));
  });
}

// BAŞLIK ÇUBUĞU (FRAMELESS TITLEBAR) KONTROLLERİ
const winMinimizeBtn = document.getElementById('winMinimizeBtn');
const winMaximizeBtn = document.getElementById('winMaximizeBtn');
const winCloseBtn = document.getElementById('winCloseBtn');
const winFullscreenBtn = document.getElementById('winFullscreenBtn');

// --- Güvenilir konum atlama -------------------------------------------------
// İlerleyen (henüz inen) akışlarda tarayıcı, arabelleğe alınmamış bir konuma
// atlanınca parçayı baştan başlatabiliyordu. Hedef aranabilir değilse indirme
// tamamlanana kadar bekleyip aynı akışı tam dosya olarak yeniden açıyor ve
// tam istenen saniyeye gidiyoruz.
let pendingSeekTarget = null;
let seekRecoveryToken = 0;

// Dinleme oturumu: dinleme sayısı yalnızca gerçekten çalınan saniyeler
// şarkının sonuna kadar biriktiğinde artar; ileri atlamak sayımı iptal eder.
const listenSession = { track: null, listened: 0, skippedForward: false };
function resetListenSession(track = currentTrack) {
  listenSession.track = track || null;
  listenSession.listened = 0;
  listenSession.skippedForward = false;
}

function isAudioTimeSeekable(time) {
  const ranges = audio.seekable;
  if (!ranges) return false;
  for (let index = 0; index < ranges.length; index += 1) {
    if (time >= ranges.start(index) - 0.25 && time <= ranges.end(index) + 0.25) return true;
  }
  return false;
}

function seekAudioTo(seconds) {
  const duration = audio.duration || currentTrack?.duration || 0;
  const requested = Number(seconds);
  if (!Number.isFinite(requested) || !currentTrack) return;
  const target = Math.max(0, duration > 0 ? Math.min(Math.max(0, duration - 0.25), requested) : requested);
  const from = pendingSeekTarget ?? (audio.currentTime || 0);
  if (target > from + 1.5) listenSession.skippedForward = true;
  const source = audio.currentSrc || audio.src || '';
  if (!source.includes('/api/audio-stream') || isAudioTimeSeekable(target)) {
    seekRecoveryToken += 1;
    pendingSeekTarget = null;
    try { audio.currentTime = target; } catch {}
    return;
  }
  void recoverUnseekableSeek(target, source);
}

async function recoverUnseekableSeek(target, streamUrl) {
  const token = ++seekRecoveryToken;
  const session = playSessionId;
  const wasPlaying = !audio.paused || isPlaying;
  pendingSeekTarget = target;
  paintPlaybackPosition(target);
  try {
    const response = await fetch(streamUrl.replace('/api/audio-stream', '/api/audio-ready'));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.warn('[seek] stream readiness check failed:', error);
    if (token === seekRecoveryToken) {
      pendingSeekTarget = null;
      try { audio.currentTime = target; } catch {}
    }
    return;
  }
  if (token !== seekRecoveryToken || session !== playSessionId || (audio.currentSrc || audio.src) !== streamUrl) return;
  const finalTarget = pendingSeekTarget ?? target;
  suppressPauseSideEffects = true;
  try {
    await new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(audio.error || new Error('Akış yeniden açılamadı.')); };
      const cleanup = () => {
        audio.removeEventListener('loadedmetadata', done);
        audio.removeEventListener('error', fail);
      };
      audio.addEventListener('loadedmetadata', done, { once: true });
      audio.addEventListener('error', fail, { once: true });
      audio.load();
    });
    if (token !== seekRecoveryToken || session !== playSessionId) return;
    audio.currentTime = finalTarget;
    if (wasPlaying) await audio.play().catch(() => {});
  } catch (error) {
    console.warn('[seek] could not reopen completed stream:', error);
  } finally {
    suppressPauseSideEffects = false;
    if (token === seekRecoveryToken) pendingSeekTarget = null;
  }
}

let suppressPauseSideEffects = false;

function paintPlaybackPosition(seconds) {
  const duration = audio.duration || currentTrack?.duration || 0;
  const percent = duration > 0 ? Math.max(0, Math.min(100, (seconds / duration) * 100)) : 0;
  const label = formatTime(seconds);
  if (typeof progressBarFill !== 'undefined' && progressBarFill) progressBarFill.style.width = `${percent}%`;
  if (typeof lyricsProgressFill !== 'undefined' && lyricsProgressFill) lyricsProgressFill.style.width = `${percent}%`;
  if (typeof currentTimeLabel !== 'undefined' && currentTimeLabel) currentTimeLabel.textContent = label;
  if (typeof lyricsCurrentTime !== 'undefined' && lyricsCurrentTime) lyricsCurrentTime.textContent = label;
  publishMiniPlayerState(true);
}

window.sunifyAPI?.onMiniPlayerControl?.((action, value) => {
  if (action === 'toggle') playPauseBtn.click();
  if (action === 'previous') prevBtn.click();
  if (action === 'next') nextBtn.click();
  if (action === 'seek') {
    const duration = audio.duration || currentTrack?.duration || 0;
    if (duration > 0) seekAudioTo(duration * Math.max(0, Math.min(1, Number(value) || 0)));
  }
  if (action === 'volume') {
    const volume = Math.max(0, Math.min(1, Number(value)));
    if (Number.isFinite(volume) && typeof window.sunifySetVolume === 'function') window.sunifySetVolume(volume);
  }
});

let miniPlayerAccent = '#a78bfa';
let lastMiniPlayerStateKey = '';
function publishMiniPlayerState(force = false) {
  if (!window.sunifyAPI?.updateMiniPlayerState) return;
  const duration = audio?.duration || currentTrack?.duration || 0;
  const current = audio?.currentTime || 0;
  const title = currentTrack?.title || 'Sunify';
  const artist = currentTrack?.artist || 'Bir şarkı seç';
  const thumbnail = currentTrack?.thumbnail || '';
  const playing = Boolean(currentTrack && isPlaying);
  const volume = Math.round((audio?.volume ?? 1) * 100) / 100;
  // The mini player displays time at one-second precision, so do not resend
  // duplicate progress updates for every frequent media timeupdate event.
  const stateKey = `${title}\u0000${artist}\u0000${thumbnail}\u0000${playing}\u0000${Math.floor(current)}\u0000${Math.floor(duration)}\u0000${miniPlayerAccent}\u0000${volume}`;
  if (!force && stateKey === lastMiniPlayerStateKey) return;
  lastMiniPlayerStateKey = stateKey;
  window.sunifyAPI.updateMiniPlayerState({
    title,
    artist,
    thumbnail,
    playing,
    volume,
    progress: duration > 0 ? (current / duration) * 100 : 0,
    elapsed: formatTime(current),
    duration: formatTime(duration),
    accent: miniPlayerAccent,
  });
}

window.sunifyAPI?.onMiniPlayerStateRequest?.(() => publishMiniPlayerState(true));

if (winFullscreenBtn) {
  winFullscreenBtn.onclick = () => {
    if (window.sunifyAPI && window.sunifyAPI.toggleFullscreen) {
      window.sunifyAPI.toggleFullscreen();
    }
  };
}

if (winMinimizeBtn) {
  winMinimizeBtn.onclick = () => {
    if (window.sunifyAPI && window.sunifyAPI.minimizeWindow) {
      window.sunifyAPI.minimizeWindow();
    }
  };
}

if (winMaximizeBtn) {
  winMaximizeBtn.onclick = () => {
    if (window.sunifyAPI && window.sunifyAPI.maximizeWindow) {
      window.sunifyAPI.maximizeWindow();
    }
  };
}

if (winCloseBtn) {
  winCloseBtn.onclick = () => {
    if (window.sunifyAPI && window.sunifyAPI.closeWindow) {
      window.sunifyAPI.closeWindow();
    }
  };
}

// Views & Navigation
const viewHome = document.getElementById('viewHome');
const viewPlaylistDetail = document.getElementById('viewPlaylistDetail');
const viewLibrary = document.getElementById('viewLibrary');
const viewArtist = document.getElementById('viewArtist');
const viewSettings = document.getElementById('viewSettings');
let artistReturnState = null;

const navHomeBtn = document.getElementById('navHomeBtn');
const navSearchTriggerBtn = document.getElementById('navSearchTriggerBtn');
const navLibraryBtn = document.getElementById('navLibraryBtn');
const navSettingsBtn = document.getElementById('navSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');

// Spotlight Arama
const inlineSearchOverlay = document.getElementById('inlineSearchOverlay');
const spotlightInput = document.getElementById('spotlightInput');
const spotlightClearBtn = document.getElementById('spotlightClearBtn');
const spotlightListContainer = document.getElementById('spotlightListContainer');
const spotlightSectionTitle = document.getElementById('spotlightSectionTitle');
let spotlightSearchFilter = 'all';
const clearSearchHistoryBtn = document.getElementById('clearSearchHistoryBtn');

// Player Elements
const playerThumbWrapper = document.getElementById('playerThumbWrapper');
const currentThumb = document.getElementById('currentThumb');
const currentTitle = document.getElementById('currentTitle');
const currentArtist = document.getElementById('currentArtist');
const playPauseBtn = document.getElementById('playPauseBtn');
const playPauseIcon = document.getElementById('playPauseIcon');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const repeatBtn = document.getElementById('repeatBtn');
const queueBtn = document.getElementById('queueBtn');
const progressBarContainer = document.getElementById('progressBarContainer');
const progressBarFill = document.getElementById('progressBarFill');
const currentTimeLabel = document.getElementById('currentTimeLabel');
const durationLabel = document.getElementById('durationLabel');
const volumeSlider = document.getElementById('volumeSlider');
const playerLikeBtn = document.getElementById('playerLikeBtn');

// Lyrics Elements
const lyricsOverlay = document.getElementById('lyricsOverlay');
const openLyricsBtn = document.getElementById('openLyricsBtn');
const closeLyricsBtn = document.getElementById('closeLyricsBtn');
const lyricsBackdrop = document.getElementById('lyricsBackdrop');
const lyricsBigCover = document.getElementById('lyricsBigCover');
const lyricsTrackTitle = document.getElementById('lyricsTrackTitle');
const lyricsTrackArtist = document.getElementById('lyricsTrackArtist');
const lyricsHeaderTrackTitle = document.getElementById('lyricsHeaderTrackTitle');
const lyricsLinesContainer = document.getElementById('lyricsLinesContainer');
const lyricsProgressContainer = document.getElementById('lyricsProgressContainer');
const lyricsProgressFill = document.getElementById('lyricsProgressFill');
const lyricsCurrentTime = document.getElementById('lyricsCurrentTime');
const lyricsTotalTime = document.getElementById('lyricsTotalTime');
const lyricsPlayPauseBtn = document.getElementById('lyricsPlayPauseBtn');
const lyricsPrevBtn = document.getElementById('lyricsPrevBtn');
const lyricsNextBtn = document.getElementById('lyricsNextBtn');
const lyricsVolumeSlider = document.getElementById('lyricsVolumeSlider');

// Playlist Detail View Elements
const backFromPlaylistBtn = document.getElementById('backFromPlaylistBtn');
const plHeroImg = document.getElementById('plHeroImg');
const plHeroTitle = document.getElementById('plHeroTitle');
const plHeroAuthor = document.getElementById('plHeroAuthor');
const plHeroStats = document.getElementById('plHeroStats');
const plPlayAllBtn = document.getElementById('plPlayAllBtn');
const plShuffleBtn = document.getElementById('plShuffleBtn');
const plSearchInput = document.getElementById('plSearchInput');
const playlistTracksContainer = document.getElementById('playlistTracksContainer');

// ŞARKI SÖZÜ KAYNAK SEÇİCİ
const lyricsCurrentSourceBadge = document.getElementById('lyricsCurrentSourceBadge');
const libraryCardsGrid = document.getElementById('libraryCardsGrid');
const libSearchInput = document.getElementById('libSearchInput');
const libraryViewToggle = document.getElementById('libraryViewToggle');

// Modal Elements
const importModal = document.getElementById('importModal');
const openImportModalBtn = document.getElementById('openImportModalBtn');
const closeImportModalBtn = document.getElementById('closeImportModalBtn');
const confirmImportBtn = document.getElementById('confirmImportBtn');
const importUrlInput = document.getElementById('importUrlInput');

const INITIAL_LIBRARY_ITEMS = [
  {
    id: 'lib_liked',
    type: 'playlists',
    name: 'Beğenilen Şarkılar',
    author: 'Kişisel Koleksiyon',
    coverClass: 'liked-cover',
    icon: 'fa-heart',
    tracks: likedTracks,
  },
  {
    id: 'lib_cached',
    type: 'playlists',
    name: 'Önbelleğe Alınan Şarkılar',
    author: 'Sunify Cache',
    coverClass: 'cached-cover',
    icon: 'fa-clock',
    tracks: [],
  },
  {
    id: 'lib_device',
    type: 'playlists',
    name: 'Bu Cihazdaki Müzikler',
    author: 'Yerel Depolama',
    coverClass: 'device-cover',
    icon: 'fa-folder',
    tracks: [],
  },
];

let customPlaylists = readAccountJson('sunify_custom_playlists', [], currentAuthSession, true);

function persistActiveAccountData(session = currentAuthSession) {
  [
    ['sunify_search_history', searchHistory],
    ['sunify_recent_tracks', recentHistory],
    ['sunify_liked', likedTracks],
    ['sunify_recommendation_feedback', recommendationFeedback],
    ['sunify_track_analytics', trackAnalytics],
    ['sunify_custom_playlists', customPlaylists],
    ['sunify_listening_stats', readAccountJson('sunify_listening_stats', {}, session)],
  ].forEach(([key, value]) => writeAccountJson(key, value, session));
}

function activateAccountData(session) {
  const nextSession = session ? SunifyAccountStore.normalizeSession(session) : null;
  if (session && !nextSession) throw new Error('Bu hesap oturumu geçersiz. Lütfen yeniden giriş yapın.');

  persistActiveAccountData();
  currentAuthSession = SunifyAccountStore.setActive(nextSession);
  searchHistory = readAccountJson('sunify_search_history', [], currentAuthSession);
  recentHistory = readAccountJson('sunify_recent_tracks', [], currentAuthSession);
  likedTracks = readAccountJson('sunify_liked', [], currentAuthSession);
  recommendationFeedback = readAccountJson('sunify_recommendation_feedback', { liked: [], dismissed: [] }, currentAuthSession);
  trackAnalytics = readAccountJson('sunify_track_analytics', {}, currentAuthSession);
  applyListenCountMigration();
  customPlaylists = readAccountJson('sunify_custom_playlists', [], currentAuthSession);

  [renderLibraryItems, renderRecentHistory, renderDailyMixes, renderNowPlayingDualGrid, renderListeningStats, updateLikeButtonUI]
    .forEach((render) => {
      try { render(); } catch (error) { console.warn('Hesap görünümü yenilenemedi:', error); }
    });
  void loadHomeRecommendations(true, false);
}

function migrateLegacyAccountData() {
  const migratedKey = 'sunify_account_data_quarantined_v2';
  // Legacy keys had no owner identity. Quarantine them for manual recovery
  // instead of guessing which saved profile owns potentially shared data.
  for (const key of [...new Set([...ACCOUNT_DATA_KEYS, 'sunify_listening_stats'])]) {
    const oldValue = localStorage.getItem(key);
    if (oldValue !== null) {
      try {
        localStorage.setItem(`sunify_unassigned_legacy_v1_${key}`, oldValue);
        localStorage.removeItem(key);
      } catch (error) {
        console.warn(`Kimliği belirlenemeyen eski hesap verisi karantinaya alınamadı (${key}).`, error);
      }
    }
  }
  if (!localStorage.getItem(migratedKey)) localStorage.setItem(migratedKey, 'true');
  searchHistory = readAccountJson('sunify_search_history', [], currentAuthSession);
  recentHistory = readAccountJson('sunify_recent_tracks', [], currentAuthSession);
  likedTracks = readAccountJson('sunify_liked', [], currentAuthSession);
  recommendationFeedback = readAccountJson('sunify_recommendation_feedback', { liked: [], dismissed: [] }, currentAuthSession);
  trackAnalytics = readAccountJson('sunify_track_analytics', {}, currentAuthSession);
  applyListenCountMigration();
  customPlaylists = readAccountJson('sunify_custom_playlists', [], currentAuthSession);
}

migrateLegacyAccountData();

function getMostPlayedTracks(limit) {
  const normalize = (value) => String(value || '').trim().toLocaleLowerCase('tr-TR');
  const knownTracks = [
    ...(currentTrack ? [currentTrack] : []),
    ...recentHistory,
    ...customPlaylists.flatMap((playlist) => playlist.tracks || []),
    ...INITIAL_LIBRARY_ITEMS.flatMap((item) => item.tracks || []),
  ];

  return Object.entries(trackAnalytics)
    .map(([key, stats]) => {
      if (!stats || typeof stats !== 'object') return null;
      const title = stats.title || '';
      const artist = stats.artist || '';
      const knownTrack = knownTracks.find((track) => {
        if (!track) return false;
        const trackKey = `${normalize(track.artist)} - ${normalize(track.title)}`.trim();
        return trackKey === key || (normalize(track.title) === normalize(title) && normalize(track.artist) === normalize(artist));
      });
      return {
        ...(knownTrack || {}),
        title: title || knownTrack?.title || '',
        artist: artist || knownTrack?.artist || '',
        thumbnail: stats.thumbnail || knownTrack?.thumbnail || '',
        duration: Number(stats.duration || knownTrack?.duration) || 0,
        id: stats.id || knownTrack?.id || '',
        query: stats.query || knownTrack?.query || `${artist} ${title}`.trim(),
        playCount: Number(stats.playCount) || 0,
        totalSeconds: Number(stats.totalSeconds) || 0,
        lastPlayed: stats.lastPlayed || '',
      };
    })
    .filter((track) => track && track.title && track.playCount > 0)
    .sort((a, b) => b.playCount - a.playCount || b.totalSeconds - a.totalSeconds || Date.parse(b.lastPlayed || 0) - Date.parse(a.lastPlayed || 0))
    .slice(0, limit);
}

// Başlangıç Kurulumu
document.addEventListener('DOMContentLoaded', () => {
  // Keep the search overlay outside the scrolling, backdrop-filtered main pane.
  // A fixed child of that pane is positioned relative to the pane and jumps with its scroll.
  if (inlineSearchOverlay?.parentElement !== document.body) document.body.appendChild(inlineSearchOverlay);
  // Normalize the initial screen too; view-section CSS alone can be overridden by glass themes.
  [viewHome, viewPlaylistDetail, viewLibrary, viewArtist].forEach((view) => {
    view.hidden = view !== viewHome;
    view.classList.toggle('active', view === viewHome);
  });
  window.sunifyAPI?.onPlayRequest?.((request) => { void playRequestedTrack(request); });
  window.sunifyAPI?.onEmailVerificationResult?.((result) => {
    if (result?.success) {
      showAppNotification('E-posta doğrulandı', 'Hesabınız doğrulandı; şimdi giriş yapabilirsiniz.');
    } else {
      showAppNotification('E-posta doğrulaması tamamlanmadı', result?.message || 'Doğrulama bağlantısı geçersiz veya süresi dolmuş.', true);
    }
  });
  applyTheme();
  setupNavigation();
  setupGlassRpcFormatSelect();
  setupSpotlightSearch();
  setupSettingsModal();
  setupKeyboardShortcuts();
  // Keep the settings backdrop outside the scrolling/animated main content so it can cover the full app.
  document.body.appendChild(viewSettings);
  setupAudioEvents();
  setupLyricsSync();
  setupModals();
  setupPlaylistHeroTools();
  setupLibraryFilters();
  setupLibraryViewToggle();
  renderDailyMixes();
  renderNowPlayingDualGrid();
  renderListeningStats();
  setupQueueDrawer();
  setupLyricsTools();
  refreshGlobalTopTracks();
  loadHomeRecommendations();
  // Prepare familiar tracks early so a later click can reuse the progressive cache.
  prefetchTrackBatch(getMostPlayedTracks(20), 20);
  document.getElementById('refreshHomeRecommendationsBtn')?.addEventListener('click', () => loadHomeRecommendations(true, true));
  setupContinueCarousel();
  renderRecentHistory();
  renderLibraryItems();
  void loadLocalDownloadedTracks().then(() => {
    if (localStorage.getItem('sunify_setting_download_liked') === 'true') {
      likedTracks.filter((track) => !findDownloadedTrack(track)).forEach((track) => enqueueTrackDownload(track));
    }
  }); // İndirilen müzikleri yükle ve ayar açıksa eksik beğenileri indir.
  loadCachedAudioTracks(); // Yalnızca tamamlanmış gerçek ses önbelleğini göster
  showRuntimeDiagnostics();
  window.setTimeout(() => checkForUpdates({ notifyOnUpdate: true }), 6000);

  // Son dinlenen şarkı varsa onu alt bara yükle (oynatmadan hazır bekle)
  if (localStorage.getItem('sunify_setting_play_context') !== 'empty' && (playbackResumeState?.track?.title || recentHistory.length > 0)) {
    const lastTrack = playbackResumeState?.track?.title ? playbackResumeState.track : recentHistory[0];
    const savedPlaylist = Array.isArray(playbackResumeState?.playlist?.tracks)
      ? playbackResumeState.playlist.tracks.filter((track) => track?.title)
      : [];
    const sameTrack = (track) => track && (
      (lastTrack.id && track.id && String(lastTrack.id) === String(track.id)) ||
      (String(track.title || '').toLocaleLowerCase() === String(lastTrack.title || '').toLocaleLowerCase() &&
        String(track.artist || '').toLocaleLowerCase() === String(lastTrack.artist || '').toLocaleLowerCase())
    );
    currentTrack = lastTrack;
    currentPlaylist = savedPlaylist.length ? savedPlaylist : [lastTrack];
    currentIndex = Math.max(0, currentPlaylist.findIndex(sameTrack));
    if (savedPlaylist.length && playbackResumeState?.playlist?.name) {
      activePlaylistData = {
        id: playbackResumeState.playlist.id || '',
        name: playbackResumeState.playlist.name,
        tracks: savedPlaylist,
      };
    }
    currentTitle.textContent = lastTrack.title;
    currentArtist.textContent = lastTrack.artist;
    currentThumb.src = lastTrack.thumbnail;
    lyricsTrackTitle.textContent = lastTrack.title;
    lyricsTrackArtist.textContent = lastTrack.artist;
    if (lyricsHeaderTrackTitle) lyricsHeaderTrackTitle.textContent = `${lastTrack.title} · ${lastTrack.artist}`;
    lyricsBigCover.src = lastTrack.thumbnail;
    lyricsBackdrop.style.backgroundImage = `url('${lastTrack.thumbnail}')`;
    applyCoverAdaptiveColor(lastTrack.thumbnail);
  }
  updateNowPlayingVisuals();
});

function setupGlassRpcFormatSelect() {
  const select = document.getElementById('settingRpcFormat');
  if (!select || select.dataset.glassReady) return;
  select.dataset.glassReady = 'true';
  const storedValue = localStorage.getItem('sunify_discord_rpc_format');
  if (storedValue && [...select.options].some((option) => option.value === storedValue)) select.value = storedValue;

  const wrapper = document.createElement('div');
  wrapper.className = 'glass-select';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'glass-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  const chevron = document.createElement('i');
  chevron.className = 'fa-solid fa-chevron-down';
  trigger.append(label, chevron);
  const menu = document.createElement('div');
  menu.className = 'glass-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Discord durum biçimi');
  wrapper.append(trigger, menu);
  select.insertAdjacentElement('afterend', wrapper);
  select.classList.add('settings-select-native-hidden');

  const renderOptions = () => {
    const selected = select.selectedOptions[0];
    label.textContent = selected?.textContent || 'Seçim yapın';
    menu.replaceChildren(...[...select.options].map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'glass-select-option';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.value === select.value));
      const text = document.createElement('span');
      text.textContent = option.textContent;
      const check = document.createElement('i');
      check.className = 'fa-solid fa-check';
      button.append(text, check);
      button.addEventListener('click', () => {
        select.value = option.value;
        localStorage.setItem('sunify_discord_rpc_format', option.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        renderOptions();
        wrapper.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      });
      return button;
    }));
  };
  renderOptions();
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !wrapper.classList.contains('open');
    wrapper.classList.toggle('open', open);
    trigger.setAttribute('aria-expanded', String(open));
  });
  menu.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', (event) => {
    if (wrapper.contains(event.target)) return;
    wrapper.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    wrapper.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
  });
  select.addEventListener('change', renderOptions);
}

async function playRequestedTrack(request) {
  const query = String(request?.query || `${request?.artist || ''} ${request?.title || ''}`).trim().slice(0, 240);
  if (!query) return;
  try {
    const response = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(20_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Şarkı aranamadı.');
    const tracks = Array.isArray(data.results) ? data.results : [];
    if (!tracks.length) throw new Error('Bu şarkı Sunify aramasında bulunamadı.');
    const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('tr-TR').replace(/[^a-z0-9]+/g, ' ').trim();
    const expectedTitle = normalize(request.title);
    const expectedArtist = normalize(request.artist);
    const score = (track) => {
      const title = normalize(track.title);
      const artist = normalize(track.artist);
      return (title === expectedTitle ? 8 : title.includes(expectedTitle) || expectedTitle.includes(title) ? 4 : 0)
        + (expectedArtist && (artist === expectedArtist || artist.includes(expectedArtist) || expectedArtist.includes(artist)) ? 3 : 0);
    };
    const index = tracks.reduce((best, track, at) => score(track) > score(tracks[best]) ? at : best, 0);
    playSelectedTrack(tracks[index], tracks, index);
  } catch (error) {
    showAppNotification('Sunify’da dinle', error.message || 'Şarkı açılamadı.', true);
  }
}

// 1. TEMA UYGULAMA
function applyTheme() {
  document.body.setAttribute('data-theme', 'dark');
  localStorage.setItem('sunify_theme', 'dark');

  document.querySelectorAll('.theme-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.theme === 'dark');
  });

  if (currentTrack?.thumbnail) applyCoverAdaptiveColor(currentTrack.thumbnail);
}

// 2. NAVİGASYON
let appViewTransitionToken = 0;
const appViewAnimations = new WeakMap();
function transitionAppView(targetView, targetBtn, { scrollTop = 0, smoothScroll = true } = {}) {
  if (!targetView) return;
  const views = [viewHome, viewPlaylistDetail, viewLibrary, viewArtist].filter(Boolean);
  const buttons = [navHomeBtn, navLibraryBtn].filter(Boolean);
  const currentView = views.find((view) => view.classList.contains('active'));
  const token = ++appViewTransitionToken;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const showTarget = () => {
    if (token !== appViewTransitionToken) return;
    views.forEach((view) => {
      const active = view === targetView;
      view.classList.toggle('active', active);
      view.hidden = !active;
    });
    // Sanatçı veya çalma listesi detay görünümünden çıkıldığında, görünmeyen yüzlerce
    // DOM düğümünü ve kapak görseli bitmap'lerini serbest bırak (tekrar açıldığında zaten yeniden çizilir)
    if (targetView !== viewArtist && targetView !== viewPlaylistDetail) {
      document.getElementById('artistPopularTracks')?.replaceChildren();
      document.getElementById('artistAlbumsGrid')?.replaceChildren();
    }
    if (targetView !== viewPlaylistDetail && playlistTracksContainer && playlistTracksContainer.childElementCount > 40) {
      playlistTracksContainer.replaceChildren();
      const recGrid = document.getElementById('playlistRecommendationsGrid');
      if (recGrid) recGrid.replaceChildren();
    }
    buttons.forEach((button) => button.classList.toggle('active', button === targetBtn));
    const scroller = document.getElementById('mainScrollableArea');
    if (scroller && Number.isFinite(Number(scrollTop))) {
      scroller.scrollTo({ top: Math.max(0, Number(scrollTop)), behavior: smoothScroll ? 'smooth' : 'auto' });
    }
    if (!reducedMotion && typeof targetView.animate === 'function') {
      appViewAnimations.get(targetView)?.cancel();
      const enterAnimation = targetView.animate(
        [{ opacity: 0, transform: 'translateY(12px) scale(.99)' }, { opacity: 1, transform: 'none' }],
        { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' }
      );
      appViewAnimations.set(targetView, enterAnimation);
    }
  };

  if (currentView && currentView !== targetView && !reducedMotion && typeof currentView.animate === 'function') {
    appViewAnimations.get(currentView)?.cancel();
    const exitAnimation = currentView.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px) scale(.995)' }],
      { duration: 150, easing: 'ease-in', fill: 'forwards' }
    );
    appViewAnimations.set(currentView, exitAnimation);
    exitAnimation.finished.then(() => {
      exitAnimation.cancel();
      if (token === appViewTransitionToken) showTarget();
    }).catch(() => {});
  } else {
    showTarget();
  }
}

function setupNavigation() {
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches && viewHome?.animate) {
    viewHome.animate(
      [{ opacity: 0, transform: 'translateY(12px) scale(.99)' }, { opacity: 1, transform: 'none' }],
      { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)' }
    );
  }
  const restoreArtistReturnView = () => {
    const saved = artistReturnState;
    const destination = saved?.view || viewHome;
    void transitionAppView(destination, destination === viewHome ? navHomeBtn : destination === viewLibrary ? navLibraryBtn : null, {
      scrollTop: saved?.scrollTop || 0,
      smoothScroll: false,
    });
    artistReturnState = null;
    if (destination === viewLibrary) {
      renderLibraryItems();
      void Promise.all([loadLocalDownloadedTracks(), loadCachedAudioTracks()]);
    }
  };

  function switchView(targetView, targetBtn) {
    void transitionAppView(targetView, targetBtn, { scrollTop: 0, smoothScroll: true });
  }

  navHomeBtn.onclick = () => switchView(viewHome, navHomeBtn);
  navLibraryBtn.onclick = () => {
    switchView(viewLibrary, navLibraryBtn);
    renderLibraryItems();
    void Promise.all([loadLocalDownloadedTracks(), loadCachedAudioTracks()]);
  };
  backFromPlaylistBtn.onclick = () => {
    const destination = playlistReturnView === 'library' ? viewLibrary : viewHome;
    const button = destination === viewLibrary ? navLibraryBtn : navHomeBtn;
    switchView(destination, button);
    if (destination === viewLibrary) {
      renderLibraryItems();
      void Promise.all([loadLocalDownloadedTracks(), loadCachedAudioTracks()]);
    }
  };
  document.getElementById('artistPageBackBtn')?.addEventListener('click', restoreArtistReturnView);

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggleSpotlightSearch();
    }
    if (e.key === 'Escape') {
      if (inlineSearchOverlay?.classList.contains('active')) {
        closeSpotlightSearch();
        return;
      }
      const openPopovers = [
        document.getElementById('equalizerPopover'),
        document.getElementById('audioOutputPopover'),
        document.getElementById('audioOutputOptions'),
        document.getElementById('playerVolumePopover'),
        document.getElementById('playerVolumeWrap'),
      ].filter((el) => el?.classList.contains('open'));
      if (openPopovers.length) {
        openPopovers.forEach((el) => el.classList.remove('open'));
        document.getElementById('equalizerBtn')?.setAttribute('aria-expanded', 'false');
        document.getElementById('audioOutputBtn')?.setAttribute('aria-expanded', 'false');
        document.getElementById('audioOutputTrigger')?.setAttribute('aria-expanded', 'false');
        document.getElementById('volumeIconBtn')?.setAttribute('aria-expanded', 'false');
        return;
      }
      const offsetPopup = document.getElementById('lyricsOffsetPopup');
      if (offsetPopup?.classList.contains('active')) {
        offsetPopup.classList.remove('active');
        return;
      }
      const sourceMenu = document.getElementById('sourceMenu');
      if (sourceMenu?.classList.contains('active')) {
        sourceMenu.classList.remove('active');
        document.getElementById('customSourceDropdown')?.classList.remove('open');
        document.getElementById('sourceDropBtn')?.setAttribute('aria-expanded', 'false');
        return;
      }
      for (const modalId of ['wrappedModal', 'editTrackModal', 'addTrackModal', 'importModal']) {
        const modalEl = document.getElementById(modalId);
        if (modalEl?.classList.contains('active')) {
          modalEl.classList.remove('active');
          return;
        }
      }
      if (viewSettings?.classList.contains('active')) {
        closeSettingsBtn?.click();
        return;
      }
      if (lyricsOverlay?.classList.contains('active')) {
        closeLyricsBtn?.click();
      }
    }
  });

  navSearchTriggerBtn.onclick = toggleSpotlightSearch;

  document.addEventListener('click', (e) => {
    if (inlineSearchOverlay.classList.contains('active')) {
      const isInside =
        inlineSearchOverlay.contains(e.target) ||
        navSearchTriggerBtn.contains(e.target);
      if (!isInside) {
        closeSpotlightSearch();
      }
    }
  });
}

function setupKeyboardShortcuts() {
  let volumeBeforeMute = Number(localStorage.getItem('sunify_volume')) || 0.8;
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target?.matches?.('input, textarea, select, [contenteditable="true"]');
    if (typing || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (target === progressBarContainer && ['arrowleft', 'arrowright', 'home', 'end'].includes(key)) return;
    if (target?.matches?.('input[type="range"]')) return;
    if ((event.ctrlKey || event.metaKey) && key === 'arrowright') { event.preventDefault(); nextBtn?.click(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'arrowleft') { event.preventDefault(); prevBtn?.click(); return; }
    if (event.ctrlKey || event.metaKey) return;
    if (key === ' ' && !target?.closest?.('button, a')) { event.preventDefault(); playPauseBtn?.click(); }
    else if (key === 'arrowright') { event.preventDefault(); if (Number.isFinite(audio.duration)) seekAudioTo(Math.min(audio.duration, (pendingSeekTarget ?? audio.currentTime) + 5)); }
    else if (key === 'arrowleft') { event.preventDefault(); seekAudioTo(Math.max(0, (pendingSeekTarget ?? audio.currentTime) - 5)); }
    else if (key === 'arrowup' || key === 'arrowdown') {
      event.preventDefault();
      volumeSlider.value = String(Math.max(0, Math.min(1, Number(volumeSlider.value) + (key === 'arrowup' ? 0.05 : -0.05))));
      volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (key === 'm') {
      event.preventDefault();
      if (Number(volumeSlider.value) > 0) { volumeBeforeMute = Number(volumeSlider.value); volumeSlider.value = '0'; }
      else volumeSlider.value = String(volumeBeforeMute || 0.8);
      volumeSlider.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (key === '/') { event.preventDefault(); toggleSpotlightSearch(); }
    else if (key === 'q') { event.preventDefault(); queueBtn?.click(); }
    else if (key === 'f') { event.preventDefault(); window.sunifyAPI?.toggleFullscreen?.(); }
  });
}

// 3. KİTAPLIK FİLTRELEME & ŞARKILARI AÇMA (HEPSİ TÜRKÇE VE AKTİF)
function setupLibraryFilters() {
  const filterTabs = document.querySelectorAll('.filter-tab');
  filterTabs.forEach((tab) => {
    tab.onclick = () => {
      filterTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      activeLibraryFilter = tab.dataset.filter;
      renderLibraryItems();
    };
  });

  if (libSearchInput) {
    libSearchInput.oninput = () => renderLibraryItems();
  }
}

function setupLibraryViewToggle() {
  if (!libraryViewToggle || !libraryCardsGrid) return;
  const savedView = localStorage.getItem('sunify_library_view') === 'list' ? 'list' : 'grid';

  function setView(view) {
    const useList = view === 'list';
    libraryCardsGrid.classList.toggle('list-view', useList);
    libraryViewToggle.querySelectorAll('[data-library-view]').forEach((button) => {
      const active = button.dataset.libraryView === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    localStorage.setItem('sunify_library_view', view);
  }

  libraryViewToggle.querySelectorAll('[data-library-view]').forEach((button) => {
    button.onclick = () => setView(button.dataset.libraryView);
  });
  setView(savedView);
}

function renderLibraryItems() {
  libraryCardsGrid.innerHTML = '';

  // Güncel beğenilenler listesini güncelle
  INITIAL_LIBRARY_ITEMS[0].tracks = likedTracks;

  const savedPlaylists = customPlaylists.map((playlist, index) => ({
    ...playlist,
    id: playlist.id || `saved_playlist_${index}`,
    type: 'playlists',
    name: String(playlist.name || playlist.title || 'Adsız çalma listesi'),
    author: String(playlist.author || 'Senin listen'),
    tracks: Array.isArray(playlist.tracks) ? playlist.tracks : [],
  }));
  const allItems = [...INITIAL_LIBRARY_ITEMS, ...savedPlaylists];
  const query = libSearchInput ? libSearchInput.value.toLowerCase().trim() : '';

  const filtered = allItems.filter((item) => {
    const matchesFilter = activeLibraryFilter === 'all' || item.type === activeLibraryFilter;
    const matchesSearch =
      !query ||
      String(item.name || '').toLocaleLowerCase('tr-TR').includes(query) ||
      String(item.author || '').toLocaleLowerCase('tr-TR').includes(query);
    return matchesFilter && matchesSearch;
  });

  if (filtered.length === 0) {
    libraryCardsGrid.innerHTML =
      '<p class="empty-state-card" style="grid-column:1/-1;">Bu kategoride henüz bir çalma listesi veya albüm bulunamadı.</p>';
    return;
  }

  filtered.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'lib-card';

    let coverHTML = '';
    if (item.coverClass) {
      coverHTML = `<div class="lib-card-cover ${item.coverClass}"><i class="fa-solid ${item.icon}"></i></div>`;
    } else {
      coverHTML = `<div class="lib-card-cover" style="background: url('${item.cover || item.thumbnail || ''}') center/cover, #b45309;"><i class="fa-solid fa-music"></i></div>`;
    }

    card.innerHTML = `
      ${coverHTML}
      <div class="lib-card-info">
        <h3>${item.name}</h3>
        <span>${item.tracks ? item.tracks.length : 0} şarkı • ${item.author}</span>
      </div>
    `;

    // TIKLANDIĞINDA ÇALMA LİSTESİ SAYFASINI AÇ! (Boş olsa bile listeyi aç, şarkı eklenebilsin!)
    card.onclick = () => {
      openPlaylistDetailView({
        id: item.id,
        type: item.type,
        name: item.name,
        author: item.author,
        cover:
          item.cover ||
          item.thumbnail ||
          PLACEHOLDER_COVER,
        tracks: item.tracks || [],
      });
    };

    libraryCardsGrid.appendChild(card);
  });
}

// 4. SPOTLIGHT ARAMA
function toggleSpotlightSearch() {
  if (inlineSearchOverlay.classList.contains('active')) {
    closeSpotlightSearch();
  } else {
    inlineSearchOverlay.classList.add('active');
    spotlightInput.focus({ preventScroll: true });
    renderSpotlightContent();
  }
}

function closeSpotlightSearch() {
  inlineSearchOverlay.classList.remove('active');
  spotlightInput.value = '';
  // Arama penceresi kapandığında içerideki arama sonuçları DOM düğümlerini ve kapak bitmap'lerini serbest bırak
  if (spotlightListContainer) spotlightListContainer.replaceChildren();
}

function setupSpotlightSearch() {
  document.querySelectorAll('[data-search-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      spotlightSearchFilter = button.dataset.searchFilter || 'all';
      document.querySelectorAll('[data-search-filter]').forEach((tab) => {
        const active = tab === button;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      const query = spotlightInput.value.trim();
      if (query) executeSpotlightQuery(query);
      else renderSpotlightContent();
    });
  });
  spotlightClearBtn.onclick = (e) => {
    e.stopPropagation();
    if (spotlightInput.value.trim() !== '') {
      spotlightInput.value = '';
      renderSpotlightContent();
      spotlightInput.focus();
    } else {
      closeSpotlightSearch();
    }
  };

  clearSearchHistoryBtn.onclick = () => {
    searchHistory = [];
    searchHistory = [];
    writeAccountJson('sunify_search_history', searchHistory);
    renderSpotlightContent();
  };

  let debounceTimer;
  spotlightInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    const query = e.target.value.trim();
    if (!query) {
      renderSpotlightContent();
      return;
    }
    debounceTimer = setTimeout(() => executeSpotlightQuery(query), 220);
  });

  spotlightInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      const query = spotlightInput.value.trim();
      if (query) executeSpotlightQuery(query);
    }
  });
}

function renderSpotlightContent() {
  const query = spotlightInput.value.trim();
  if (query) return;

  spotlightSectionTitle.textContent = 'Son aramalar';
  clearSearchHistoryBtn.style.display = searchHistory.length > 0 ? 'block' : 'none';

  if (searchHistory.length === 0) {
    const defaultTrack = recentHistory[0];
    if (!defaultTrack) {
      spotlightListContainer.innerHTML = '<p class="spotlight-empty-state">Henüz arama geçmişi yok. Bir şarkı aradığında burada görünecek.</p>';
      return;
    }

    spotlightListContainer.innerHTML = `
      <div class="spotlight-item" id="defaultSpotlightItem">
        <img class="spotlight-thumb" src="${defaultTrack.thumbnail}" alt="${defaultTrack.title}">
        <div class="spotlight-meta">
          <div class="spotlight-title">${defaultTrack.title}</div>
          <div class="spotlight-artist">${defaultTrack.artist}</div>
        </div>
        <span class="spotlight-duration">${formatTime(defaultTrack.duration)}</span>
      </div>
    `;

    document.getElementById('defaultSpotlightItem').onclick = () => {
      playSelectedTrack(defaultTrack, [defaultTrack], 0);
      closeSpotlightSearch();
    };
    return;
  }

  spotlightListContainer.innerHTML = '';
  searchHistory.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = 'spotlight-item';
    item.innerHTML = `
      <img class="spotlight-thumb" src="${track.thumbnail}" alt="${track.title}">
      <div class="spotlight-meta">
        <div class="spotlight-title">${track.title}</div>
        <div class="spotlight-artist">${track.artist}</div>
      </div>
      <span class="spotlight-duration">${formatTime(track.duration)}</span>
      <button class="spotlight-remove-btn" title="Kaldır"><i class="fa-solid fa-xmark"></i></button>
    `;

    item.onclick = (e) => {
      if (e.target.closest('.spotlight-remove-btn')) {
        searchHistory.splice(index, 1);
        writeAccountJson('sunify_search_history', searchHistory);
        renderSpotlightContent();
        return;
      }
      playSelectedTrack(track, searchHistory, index);
      closeSpotlightSearch();
    };

    spotlightListContainer.appendChild(item);
  });
}

async function executeSpotlightQuery(query) {
  const requestQuery = query.trim();
  if (!requestQuery) return;
  spotlightSectionTitle.textContent = `"${requestQuery}" sonuçları`;
  clearSearchHistoryBtn.style.display = 'none';
  spotlightListContainer.innerHTML =
    '<p style="font-size:13px; color:#ffffff; padding:12px; font-weight:700;"><i class="fa-solid fa-spinner fa-spin"></i> Sonuçlar aranıyor...</p>';

  try {
    const wantTracks = spotlightSearchFilter === 'all' || spotlightSearchFilter === 'tracks';
    const wantArtists = spotlightSearchFilter === 'all' || spotlightSearchFilter === 'artists';
    const wantPlaylists = spotlightSearchFilter === 'all' || spotlightSearchFilter === 'playlists';
    executeSpotlightQuery.controller?.abort();
    const controller = (executeSpotlightQuery.controller = new AbortController());
    const encodedQuery = encodeURIComponent(requestQuery);
    const getJson = (path) => fetch(`${API_BASE}${path}`, { signal: controller.signal }).then((res) => res.json());
    let artists = [];
    let tracks = [];
    let playlists = [];
    let pending = 0;
    // Her kaynak hazır olur olmaz sonuçlar çizilir; yavaş bir kaynak diğerlerini bekletmez.
    const render = () => {
    if (controller.signal.aborted || spotlightInput.value.trim() !== requestQuery) return;
    if (!artists.length && !tracks.length && !playlists.length) {
      if (pending > 0) return;
      spotlightListContainer.innerHTML =
        '<p style="font-size:13px; color:#ffffff; padding:12px;">Sonuç bulunamadı.</p>';
      return;
    }

    spotlightListContainer.innerHTML = '';
    if (wantArtists && artists.length) {
      const heading = document.createElement('div');
      heading.className = 'spotlight-kind-heading';
      heading.textContent = 'Sanatçılar';
      spotlightListContainer.appendChild(heading);
      artists.slice(0, 6).forEach((artist) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'spotlight-item spotlight-artist-result';
        item.innerHTML = `
          <img class="spotlight-thumb spotlight-artist-avatar" alt="">
          <div class="spotlight-meta"><div class="spotlight-title"></div><div class="spotlight-artist"></div></div>
          <span class="spotlight-result-type">Sanatçı</span>
        `;
        const image = item.querySelector('img');
        if (artist.image) image.src = artist.image;
        item.querySelector('.spotlight-title').textContent = artist.name;
        item.querySelector('.spotlight-artist').textContent = artist.genre || 'Sanatçı profili';
        item.onclick = () => openArtistPage(artist);
        spotlightListContainer.appendChild(item);
      });
    }

    if (wantTracks && tracks.length) {
      const heading = document.createElement('div');
      heading.className = 'spotlight-kind-heading';
      heading.textContent = 'Şarkılar';
      spotlightListContainer.appendChild(heading);
      tracks.slice(0, 8).forEach((track, index) => {
        const item = document.createElement('div');
        item.className = 'spotlight-item';
        item.innerHTML = `
          <img class="spotlight-thumb" alt="">
          <div class="spotlight-meta"><div class="spotlight-title"></div><div class="spotlight-artist"></div></div>
          <span class="spotlight-duration"></span>
        `;
        item.querySelector('img').src = track.thumbnail || '';
        item.querySelector('.spotlight-title').textContent = track.title;
        item.querySelector('.spotlight-artist').textContent = track.artist;
        item.querySelector('.spotlight-duration').textContent = formatTime(track.duration);
        bindTrackAudioPrefetch(item, track);
        item.onclick = () => {
          addToSearchHistory(track);
          playSelectedTrack(track, tracks, index);
          closeSpotlightSearch();
        };
        spotlightListContainer.appendChild(item);
      });
    }
    if (wantPlaylists && playlists.length) {
      const heading = document.createElement('div');
      heading.className = 'spotlight-kind-heading';
      heading.textContent = 'Çalma listeleri';
      spotlightListContainer.appendChild(heading);
      playlists.slice(0, 8).forEach((playlist) => {
        const item = document.createElement('div');
        item.className = 'spotlight-item spotlight-playlist-result';
        item.innerHTML = `
          <img class="spotlight-thumb" alt="">
          <div class="spotlight-meta"><div class="spotlight-title"></div><div class="spotlight-artist"></div></div>
          <span class="spotlight-result-type">Çalma listesi</span>
        `;
        item.querySelector('img').src = playlist.thumbnail || '';
        item.querySelector('.spotlight-title').textContent = playlist.title || 'Çalma listesi';
        item.querySelector('.spotlight-artist').textContent = `${playlist.author || 'YouTube'} · ${playlist.size || 'Çalma listesi'}`;
        item.onclick = async () => {
          const sourceUrl = String(playlist.url || '').trim();
          if (!sourceUrl) {
            showAppNotification('Çalma listesi açılamadı', 'Bu sonuç için geçerli bir bağlantı bulunamadı.', true);
            return;
          }
          const id = `youtube_${playlist.id || encodeURIComponent(sourceUrl)}`;
          const preview = {
            id,
            type: 'playlists',
            name: playlist.title || 'Çalma listesi',
            author: playlist.author?.name || playlist.author || 'YouTube',
            cover: playlist.thumbnail || '',
            tracks: [],
            sourceUrl,
          };
          closeSpotlightSearch();
          openPlaylistDetailView(preview);
          playlistTracksContainer.innerHTML = '<div class="playlist-load-state"><i class="fa-solid fa-spinner fa-spin"></i><span>Çalma listesi yükleniyor…</span></div>';
          item.classList.add('is-loading');
          item.querySelector('.spotlight-result-type').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          try {
            const response = await fetch(`${API_BASE}/import-playlist`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: sourceUrl }),
              signal: AbortSignal.timeout(90_000),
            });
            const imported = await response.json();
            if (!response.ok) throw new Error(imported.error || 'Çalma listesi alınamadı.');
            const importedTracks = Array.isArray(imported.tracks)
              ? imported.tracks
                .filter((track) => track && (track.title || track.query))
                .map((track) => ({
                  ...track,
                  title: String(track.title || track.query || 'Bilinmeyen parça'),
                  artist: String(track.artist || 'Bilinmeyen sanatçı'),
                  thumbnail: String(track.thumbnail || imported.thumbnail || playlist.thumbnail || ''),
                  duration: Number(track.duration) || 0,
                }))
              : [];
            if (!importedTracks.length) throw new Error('Bu çalma listesinde açılabilir şarkı bulunamadı.');
            if (!viewPlaylistDetail.classList.contains('active') || activePlaylistData?.id !== id) return;
            openPlaylistDetailView({
              ...preview,
              name: imported.name || preview.name,
              author: imported.author || preview.author,
              cover: imported.thumbnail || preview.cover,
              tracks: importedTracks,
            });
          } catch (error) {
            if (viewPlaylistDetail.classList.contains('active') && activePlaylistData?.id === id) {
              const message = document.createElement('div');
              message.className = 'playlist-load-state playlist-load-error';
              const copy = document.createElement('span');
              copy.textContent = error.name === 'TimeoutError' ? 'Çalma listesi zaman aşımına uğradı. Tekrar deneyin.' : (error.message || 'Çalma listesi alınamadı.');
              const retry = document.createElement('button');
              retry.type = 'button';
              retry.className = 'tool-btn';
              retry.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Tekrar dene';
              retry.onclick = () => item.click();
              message.append(copy, retry);
              playlistTracksContainer.replaceChildren(message);
            }
            showAppNotification('Çalma listesi açılamadı', error.message, true);
          } finally {
            item.classList.remove('is-loading');
            const resultType = item.querySelector('.spotlight-result-type');
            if (resultType) resultType.textContent = 'Çalma listesi';
          }
        };
        spotlightListContainer.appendChild(item);
      });
    }
    };
    const run = (enabled, path, assign) => {
      if (!enabled) return null;
      pending += 1;
      return getJson(path)
        .then(assign)
        .catch(() => {})
        .finally(() => { pending -= 1; render(); });
    };
    await Promise.all([
      run(wantArtists, `/artists/search?q=${encodedQuery}`, (data) => { artists = (data.artists || []).filter((artist) => artist && artist.id && artist.name); }),
      run(wantTracks, `/search?q=${encodedQuery}`, (data) => { tracks = data.results || []; }),
      run(wantPlaylists, `/search/playlists?q=${encodedQuery}`, (data) => { playlists = data.playlists || []; }),
    ]);
  } catch (error) {
    if (error.name === 'AbortError') return;
    const message = document.createElement('p');
    message.style.cssText = 'font-size:13px; color:#fff; background:rgba(0,0,0,0.3); padding:8px; border-radius:6px;';
    message.textContent = `Arama hatası: ${error.message}`;
    spotlightListContainer.replaceChildren(message);
  }
}

async function openArtistPage(artist) {
  closeSpotlightSearch();
  if (!viewArtist.classList.contains('active')) {
    const activeView = [viewHome, viewPlaylistDetail, viewLibrary, viewArtist]
      .find((view) => view.classList.contains('active')) || viewHome;
    artistReturnState = {
      view: activeView,
      scrollTop: document.getElementById('mainScrollableArea')?.scrollTop || 0,
    };
  }
  showAllArtistTracks = false;
  currentArtistProfile = null;
  const requestId = ++artistRequestId;
  void transitionAppView(viewArtist, null, { scrollTop: 0, smoothScroll: false });
  document.getElementById('artistPageName').textContent = artist.name;
  document.getElementById('artistPageListeners').textContent = artist.genre || 'Sanatçı profili';
  document.getElementById('artistPageBio').textContent = 'Sanatçı bilgileri yükleniyor...';
  document.getElementById('artistPopularTracks').innerHTML = '<p class="artist-loading"><i class="fa-solid fa-spinner fa-spin"></i> Şarkılar yükleniyor...</p>';
  document.getElementById('artistAlbumsGrid').innerHTML = '';
  const portrait = document.getElementById('artistPageImage');
  portrait.src = artist.image || '';
  viewArtist.style.setProperty('--artist-wallpaper', artist.image ? `url("${artist.image}")` : 'none');

  try {
    const response = await fetch(`${API_BASE}/artists/${encodeURIComponent(artist.id)}`);
    const data = await response.json();
    if (requestId !== artistRequestId) return;
    if (!response.ok) throw new Error(data.error || 'Sanatçı profili yüklenemedi.');
    currentArtistProfile = {
      ...data,
      artist: {
        ...artist,
        ...(data.artist || {}),
        name: data.artist?.name || artist.name,
        genre: data.artist?.genre || artist.genre || '',
        image: data.artist?.image || artist.image || '',
      },
    };
    renderArtistProfile();
  } catch (error) {
    if (requestId !== artistRequestId) return;
    document.getElementById('artistPageBio').textContent = error.message;
    document.getElementById('artistPopularTracks').innerHTML = '';
    showAppNotification('Sanatçı profili', error.message, true);
  }
}

function renderArtistProfile() {
  if (!currentArtistProfile) return;
  const { artist, tracks = [], albums = [] } = currentArtistProfile;
  const normalize = (value) => String(value || '').trim().toLocaleLowerCase('tr-TR');
  const localPlays = Object.values(trackAnalytics).reduce((sum, item) => {
    if (!item || typeof item !== 'object') return sum;
    const artistNames = normalize(item.artist).split(',').map((name) => name.trim());
    return artistNames.includes(normalize(artist.name)) ? sum + (Number(item.playCount) || 0) : sum;
  }, 0);
  const portrait = document.getElementById('artistPageImage');
  portrait.src = artist.image || albums[0]?.image || tracks[0]?.thumbnail || '';
  document.getElementById('artistPageName').textContent = artist.name;
  document.getElementById('artistPageListeners').textContent = [
    localPlays ? `${localPlays.toLocaleString('tr-TR')} bu cihazda dinleme` : '',
    artist.genre,
  ].filter(Boolean).join(' • ') || 'Sanatçı profili';
  const bio = document.getElementById('artistPageBio');
  bio.textContent = artist.bio || `${artist.name} sanatçısının popüler şarkıları ve albümleri.`;
  const bioToggle = document.getElementById('artistBioToggle');
  bioToggle.hidden = bio.textContent.length < 180;
  bio.classList.remove('expanded');
  bioToggle.textContent = 'Tümünü göster';
  document.getElementById('artistPageImage').onerror = () => {
    portrait.src = albums[0]?.image || tracks[0]?.thumbnail || '';
  };
  viewArtist.style.setProperty('--artist-wallpaper', portrait.src ? `url("${portrait.src}")` : 'none');

  const trackList = document.getElementById('artistPopularTracks');
  const visibleTracks = showAllArtistTracks ? tracks : tracks.slice(0, 5);
  trackList.innerHTML = '';
  if (!tracks.length) {
    trackList.innerHTML = '<p class="artist-loading">Bu sanatçı için şarkı bulunamadı.</p>';
  }
  visibleTracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = 'artist-track-row';
    row.dataset.trackTitle = track.title;
    row.dataset.trackArtist = track.artist;
    row.innerHTML = `
      <span class="artist-track-rank"></span>
      <img class="artist-track-cover" alt="">
      <div class="artist-track-meta"><span class="artist-track-title"></span><span class="artist-track-subtitle"></span></div>
      <span class="artist-track-duration"></span>
      <i class="fa-solid fa-ellipsis-vertical artist-track-more" aria-hidden="true"></i>
    `;
    row.querySelector('.artist-track-rank').textContent = String(index + 1);
    row.querySelector('.artist-track-cover').src = track.thumbnail || artist.image || '';
    row.querySelector('.artist-track-title').textContent = track.title;
    row.querySelector('.artist-track-subtitle').textContent = track.artist;
    row.querySelector('.artist-track-duration').textContent = formatTime(track.duration);
    row.onclick = () => playSelectedTrack(track, tracks, index);
    trackList.appendChild(row);
  });
  const showAll = document.getElementById('artistShowAllTracksBtn');
  showAll.hidden = tracks.length <= 5;
  showAll.textContent = showAllArtistTracks ? 'Daha az göster' : 'Tümünü göster';
  showAll.onclick = () => {
    showAllArtistTracks = !showAllArtistTracks;
    renderArtistProfile();
  };
  document.getElementById('artistBioToggle').onclick = () => {
    bio.classList.toggle('expanded');
    bioToggle.textContent = bio.classList.contains('expanded') ? 'Daha az göster' : 'Tümünü göster';
  };

  const albumGrid = document.getElementById('artistAlbumsGrid');
  albumGrid.innerHTML = '';
  albums.forEach((album) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'artist-album-card';
    card.innerHTML = '<img class="artist-album-cover" alt=""><span class="artist-album-title"></span><span class="artist-album-meta"></span>';
    card.querySelector('img').src = album.image || '';
    card.querySelector('.artist-album-title').textContent = album.title;
    card.querySelector('.artist-album-meta').textContent = [album.year, 'Albüm'].filter(Boolean).join(' • ');
    card.onclick = () => {
      const albumTracks = tracks.filter((track) => String(track.albumId) === String(album.id));
      openPlaylistDetailView({ name: album.title, author: artist.name, cover: album.image, tracks: albumTracks });
    };
    albumGrid.appendChild(card);
  });

  document.getElementById('artistPlayBtn').onclick = () => {
    if (tracks.length) playSelectedTrack(tracks[0], tracks, 0);
  };
  document.getElementById('artistShuffleBtn').onclick = () => {
    if (!tracks.length) return;
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    playSelectedTrack(shuffled[0], shuffled, 0);
  };
  document.getElementById('artistSaveBtn').onclick = () => {
    if (!tracks.length) return;
    const playlist = { id: `artist_${artist.id}`, type: 'playlists', name: `${artist.name} • Şarkılar`, author: 'Sanatçı', cover: portrait.src, tracks };
    const existing = customPlaylists.findIndex((item) => item.id === playlist.id);
    if (existing >= 0) customPlaylists[existing] = playlist;
    else customPlaylists.unshift(playlist);
    writeAccountJson('sunify_custom_playlists', customPlaylists);
    renderLibraryItems();
    showAppNotification('Kitaplığa eklendi', `${artist.name} şarkıları kaydedildi.`);
  };
  document.getElementById('artistShareBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(artist.name);
      showAppNotification('Kopyalandı', `${artist.name} adı panoya kopyalandı.`);
    } catch (error) {
      showAppNotification('Paylaş', artist.name);
    }
  };
}
function addToSearchHistory(track) {
  searchHistory = searchHistory.filter((t) => t.title !== track.title);
  searchHistory.unshift(track);
  if (searchHistory.length > 10) searchHistory.pop();
  writeAccountJson('sunify_search_history', searchHistory);
}

// 5.1 ŞU ANDA DİNLENİYOR (2 SÜTUNLU GÖRSEL ŞARKI LİSTESİ)
function renderNowPlayingDualGrid() {
  const container = document.getElementById('nowPlayingDualGrid');
  if (!container) return;

  const tracks = globalTopTracks;
  if (!tracks.length) {
    const message = globalChartUnavailable
      ? 'Ortak dinleme listesi şu an yüklenemiyor. Supabase bağlantısını ve global dinleme listesi veritabanı kurulumunu kontrol edin.'
      : 'Henüz ortak dinleme kaydı yok. Çalınan ilk şarkılar burada görünür; az kullanıcı olması listeyi engellemez.';
    container.replaceChildren(Object.assign(document.createElement('p'), { className: 'hm-empty', textContent: message }));
    return;
  }

  container.innerHTML = '';
  tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = 'hm-track';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.dataset.trackTitle = track.title;
    row.dataset.trackArtist = track.artist;
    row.innerHTML = `
      <span class="hm-track-rank"></span>
      <img class="hm-track-thumb" alt="">
      <span class="hm-track-meta"><strong></strong><span></span></span>
      <span class="hm-track-count"></span>
      <i class="fa-solid fa-play hm-track-play" aria-hidden="true"></i>
    `;
    row.querySelector('.hm-track-rank').textContent = String(index + 1);
    row.querySelector('.hm-track-thumb').src = track.thumbnail || PLACEHOLDER_COVER;
    row.querySelector('.hm-track-meta strong').textContent = track.title;
    row.querySelector('.hm-track-meta span').textContent = track.artist;
    row.querySelector('.hm-track-count').textContent = `${track.playCount} dinleme`;
    const play = () => playSelectedTrack(track, tracks, index);
    row.onclick = play;
    row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); play(); } };
    container.appendChild(row);
  });
  updateNowPlayingVisuals();
}

async function refreshGlobalTopTracks() {
  const container = document.getElementById('nowPlayingDualGrid');
  if (!container) return;
  try {
    const response = await fetch(`${API_BASE}/discover/top?limit=10`);
    const result = await response.json();
    globalChartUnavailable = !response.ok || Boolean(result.unavailable);
    globalTopTracks = Array.isArray(result.tracks) ? result.tracks.map((track) => ({
      ...track,
      id: track.track_id || track.id,
      title: track.title,
      artist: track.artist,
      thumbnail: track.thumbnail || '',
      playCount: Number(track.play_count || track.playCount) || 0,
      duration: Number(track.duration) || 0,
      query: `${track.artist || ''} ${track.title || ''}`.trim(),
    })) : [];
  } catch (error) {
    globalTopTracks = [];
    globalChartUnavailable = true;
  }
  renderNowPlayingDualGrid();
}

function renderDailyMixes() {
  const container = document.getElementById('dailyMixesGrid');
  if (!container) return;

  const topTracks = getMostPlayedTracks(25);
  const allKnownTracks = [...recentHistory, ...likedTracks, ...topTracks];
  const discoverySeeds = (likedTracks.length
    ? likedTracks.slice(-12).reverse()
    : [...recentHistory].slice(5, 20)).map((track) => ({ track, weight: 4 }));
  const popularArtistTracks = new Map();
  for (const track of topTracks) {
    const key = normalizeRecommendationTitle(track.artist);
    if (!key) continue;
    const entry = popularArtistTracks.get(key) || { artist: track.artist, count: 0 };
    entry.count += Number(track.playCount) || 1;
    popularArtistTracks.set(key, entry);
  }
  const mixSpecs = [
    { name: 'En çok dinlediklerin', author: 'Dinleme geçmişin', tracks: topTracks, cover: topTracks[0]?.thumbnail || '' },
    { name: 'Sana benzer şarkılar', author: 'En çok dinlediklerine göre', tracks: null, seeds: buildRecommendationSeeds(topTracks.slice(0, 10).map((track) => ({ track, weight: 4 })), 6), exclude: topTracks.slice(0, 10) },
    { name: 'Bugün en çok dinlenenler', author: 'Sunify topluluğu · bugün', tracks: null, daily: true },
    { name: 'Favori sanatçıların', author: 'En çok dinlediğin sanatçılardan', tracks: null, artists: [...popularArtistTracks.values()].sort((a, b) => b.count - a.count).slice(0, 6).map((entry) => entry.artist) },
    { name: 'Yeni keşifler', author: 'Henüz dinlemediğin öneriler', tracks: null, seeds: buildRecommendationSeeds(discoverySeeds, 6), exclude: allKnownTracks },
  ];
  const requestId = ++dailyMixRenderRequest;
  container.innerHTML = '';

  const loadMixTracks = async (spec, index) => {
    if (Array.isArray(spec.tracks)) return spec.tracks.slice(0, 25);
    let key;
    let url;
    if (spec.daily) {
      key = 'daily-global-v1';
      url = `${API_BASE}/discover/daily-top?limit=25`;
    } else if (spec.artists?.length) {
      key = `artists:${spec.artists.join('|').toLocaleLowerCase('tr-TR')}`;
      url = `${API_BASE}/daily-mix/artist-tracks?${new URLSearchParams({ artists: JSON.stringify(spec.artists) })}`;
    } else if (spec.seeds?.length) {
      const excludedKey = index === 4 ? (spec.exclude || []).map(recommendationTrackKey).join(',') : '';
      key = `recommendations:${index}:${spec.seeds.map((seed) => `${seed.artist}:${seed.title}`).join('|')}:${excludedKey}`;
      url = `${API_BASE}/recommendations?${new URLSearchParams({ seeds: JSON.stringify(spec.seeds) })}`;
    } else {
      return [];
    }

    const cached = dailyMixCache.get(key);
    const ttl = spec.daily ? 60_000 : 15 * 60_000;
    if (cached && Date.now() - cached.time < ttl) return cached.tracks;
    if (dailyMixInFlight.has(key)) return dailyMixInFlight.get(key);
    const pending = fetch(url, { signal: AbortSignal.timeout(25_000) })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Daily Mix yüklenemedi.');
        let tracks = Array.isArray(data.tracks) ? data.tracks : [];
        if (index === 1) tracks = filterRecommendationCandidates(tracks, { exclude: spec.exclude || [], limit: 25 });
        if (index === 4) tracks = filterRecommendationCandidates(tracks, { exclude: spec.exclude || [], limit: 25 });
        tracks = tracks.slice(0, 25);
        if (!dailyMixCache.has(key) && dailyMixCache.size >= 24) dailyMixCache.delete(dailyMixCache.keys().next().value);
        dailyMixCache.set(key, { time: Date.now(), tracks });
        return tracks;
      })
      .finally(() => dailyMixInFlight.delete(key));
    dailyMixInFlight.set(key, pending);
    return pending;
  };

  mixSpecs.forEach((spec, index) => {
    const mixNumber = index + 1;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'hm-mix';
    card.innerHTML = `
      <span class="hm-mix-cover"><img alt=""><span class="hm-mix-label">MIX <b></b></span></span>
      <strong class="hm-mix-title"></strong>
      <span class="hm-mix-artists"></span>
    `;
    card.querySelector('img').src = spec.cover || PLACEHOLDER_COVER;
    card.querySelector('.hm-mix-label b').textContent = String(mixNumber);
    card.querySelector('.hm-mix-title').textContent = spec.name;
    card.querySelector('.hm-mix-artists').textContent = '25 şarkılık Daily Mix';
    card.disabled = !spec.tracks?.length && !(spec.seeds?.length || spec.artists?.length || spec.daily);
    card.onclick = () => {
      if (!Array.isArray(spec.tracks) || !spec.tracks.length) return;
      openPlaylistDetailView({ name: spec.name, author: spec.author, cover: spec.tracks[0]?.thumbnail || spec.cover || '', tracks: spec.tracks.slice(0, 25) });
    };
    container.appendChild(card);

    loadMixTracks(spec, index).then((tracks) => {
      if (requestId !== dailyMixRenderRequest || !card.isConnected) return;
      spec.tracks = tracks;
      if (tracks[0]?.thumbnail) card.querySelector('img').src = tracks[0].thumbnail;
      const artists = [...new Set(tracks.map((track) => track.artist).filter(Boolean))].slice(0, 3).join(', ');
      card.querySelector('.hm-mix-artists').textContent = tracks.length ? `${tracks.length} şarkı · ${artists || spec.author}` : 'Henüz yeterli dinleme verisi yok';
      card.disabled = tracks.length === 0;
      if (tracks.length) {
        prefetchTrackBatch(tracks, 3);
        card.onclick = () => openPlaylistDetailView({ name: spec.name, author: spec.author, cover: tracks[0].thumbnail || spec.cover || '', tracks: tracks.slice(0, 25) });
      }
    }).catch((error) => {
      if (requestId !== dailyMixRenderRequest || !card.isConnected) return;
      console.warn(`Daily Mix ${mixNumber} yüklenemedi:`, error.message);
      card.querySelector('.hm-mix-artists').textContent = spec.daily ? 'Günlük liste henüz hazır değil' : 'Öneriler şu an alınamadı';
      card.disabled = true;
    });
  });
}

let playlistRecommendationRequest = 0;
let homeRecommendationRequest = 0;
let homeRecommendationCache = { key: '', time: 0, tracks: [] };
async function loadHomeRecommendations(force = false, refreshSearch = false) {
  const container = document.getElementById('homeRecommendationsGrid');
  if (!container) return;
  const seedItems = [
    ...(recommendationFeedback.liked || []).slice(0, 4).map((track) => ({ track, weight: 6 })),
    ...likedTracks.slice(-5).reverse().map((track) => ({ track, weight: 5 })),
    ...getMostPlayedTracks(8).map((track) => ({ track, weight: 2 + Math.min(3, Math.floor(Math.log2((track.playCount || 1) + 1))) })),
    ...recentHistory.slice(0, 8).map((track) => ({ track, weight: 2 })),
  ];
  const rankedSeeds = buildRecommendationSeeds(seedItems, 10);
  const secondarySeeds = rankedSeeds.slice(1);
  if (refreshSearch && secondarySeeds.length > 5) {
    const offset = Math.floor(Math.random() * (secondarySeeds.length - 4));
    secondarySeeds.push(...secondarySeeds.splice(0, offset));
  }
  const seeds = rankedSeeds.length > 6
    ? [rankedSeeds[0], ...secondarySeeds.slice(0, 5)]
    : rankedSeeds;
  if (!seeds.length) {
    container.innerHTML = '<p class="hm-empty">Dinleme geçmişin oluşunca tarzına uygun şarkılar burada görünecek.</p>';
    return;
  }
  const refreshButton = document.getElementById('refreshHomeRecommendationsBtn');
  const feedbackKey = (recommendationFeedback.liked || []).map((item) => item.key).join(',');
  const dismissedKey = (recommendationFeedback.dismissed || []).map((item) => item.key).join(',');
  const key = `${seeds.map((track) => `${track.artist} ${track.title}:${track.weight}`).join('|')}#${feedbackKey}#${dismissedKey}`;
  const requestId = ++homeRecommendationRequest;
  if (refreshSearch && refreshButton) {
    refreshButton.disabled = true;
    refreshButton.classList.add('is-refreshing');
    refreshButton.setAttribute('aria-busy', 'true');
  }
  if (!force && homeRecommendationCache.key === key && Date.now() - homeRecommendationCache.time < 10 * 60 * 1000) {
    prefetchTrackBatch(homeRecommendationCache.tracks, 5);
    return renderHomeRecommendationCards(container, homeRecommendationCache.tracks);
  }
  container.innerHTML = '<p class="hm-empty"><i class="fa-solid fa-spinner fa-spin"></i> Sana uygun şarkılar aranıyor…</p>';
  try {
    const params = new URLSearchParams({ seeds: JSON.stringify(seeds), ...(refreshSearch ? { refresh: '1' } : {}) });
    const response = await fetch(`${API_BASE}/recommendations?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Öneriler alınamadı.');
    if (requestId !== homeRecommendationRequest) return;
    const tracks = filterRecommendationCandidates(data.tracks, {
      exclude: seeds,
      recent: recentHistory.slice(0, 8),
      limit: 8,
    });
    homeRecommendationCache = { key, time: Date.now(), tracks };
    renderHomeRecommendationCards(container, tracks);
    prefetchTrackBatch(tracks, 5);
  } catch (error) {
    if (requestId === homeRecommendationRequest) {
      container.innerHTML = '<p class="hm-empty"></p>';
      container.firstChild.textContent = `Öneriler yüklenemedi: ${error.message}`;
    }
  } finally {
    if (requestId === homeRecommendationRequest && refreshButton) {
      refreshButton.disabled = false;
      refreshButton.classList.remove('is-refreshing');
      refreshButton.removeAttribute('aria-busy');
    }
  }
}

let homeRecommendationPlaylistPickerCleanup = null;

function closeHomeRecommendationPlaylistPicker() {
  homeRecommendationPlaylistPickerCleanup?.();
  homeRecommendationPlaylistPickerCleanup = null;
}

function openHomeRecommendationPlaylistPicker(anchor, track) {
  closeHomeRecommendationPlaylistPicker();
  if (!customPlaylists.length) {
    showAppNotification('Çalma listesi yok', 'Önce Kitaplık bölümünden bir çalma listesi oluştur.', true);
    return;
  }

  const picker = document.createElement('div');
  picker.className = 'hm-recommendation-playlist-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Şarkının ekleneceği çalma listesini seç');
  const heading = document.createElement('strong');
  heading.textContent = 'Çalma listene ekle';
  picker.appendChild(heading);

  customPlaylists.forEach((playlist) => {
    const option = document.createElement('button');
    option.type = 'button';
    const existing = (playlist.tracks || []).some((item) => (
      normalizeTrackText(item.title) === normalizeTrackText(track.title)
      && normalizeTrackText(item.artist) === normalizeTrackText(track.artist)
    ));
    option.innerHTML = `<span></span><i class="fa-solid ${existing ? 'fa-check' : 'fa-plus'}"></i>`;
    option.querySelector('span').textContent = playlist.name || 'Adsız çalma listesi';
    option.disabled = existing;
    option.title = existing ? 'Bu şarkı zaten listede' : `“${playlist.name}” listesine ekle`;
    option.onclick = (event) => {
      event.stopPropagation();
      if (existing) return;
      const target = customPlaylists.find((item) => item === playlist || (playlist.id && item.id === playlist.id) || item.name === playlist.name) || playlist;
      if (!Array.isArray(target.tracks)) target.tracks = [];
      target.tracks.push({ ...track });
      writeAccountJson('sunify_custom_playlists', customPlaylists);
      syncToCloudSilently();
      renderLibraryItems();
      closeHomeRecommendationPlaylistPicker();
      showAppNotification('Listeye eklendi', `“${track.title}” · ${target.name}`);
    };
    picker.appendChild(option);
  });

  document.body.appendChild(picker);
  const anchorRect = anchor.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  const margin = 10;
  const left = Math.max(margin, Math.min(window.innerWidth - pickerRect.width - margin, anchorRect.right - pickerRect.width));
  const below = anchorRect.bottom + 8;
  const top = below + pickerRect.height <= window.innerHeight - margin
    ? below
    : Math.max(margin, anchorRect.top - pickerRect.height - 8);
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;

  const onPointerDown = (event) => {
    if (!picker.contains(event.target) && !anchor.contains(event.target)) closeHomeRecommendationPlaylistPicker();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') closeHomeRecommendationPlaylistPicker();
  };
  const cleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
    anchor.setAttribute('aria-expanded', 'false');
    picker.remove();
  };
  homeRecommendationPlaylistPickerCleanup = cleanup;
  anchor.setAttribute('aria-haspopup', 'dialog');
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown);
  picker.querySelector('button:not(:disabled)')?.focus();
}

function renderHomeRecommendationCards(container, tracks) {
  container.replaceChildren();
  if (!tracks.length) {
    container.innerHTML = '<p class="hm-empty">Şu an benzer yeni şarkı bulunamadı. Biraz sonra yenileyebilirsin.</p>';
    return;
  }
  tracks.forEach((track, index) => {
    const card = createHomeCoverCard(track, () => playSelectedTrack(track, tracks, index));
    card.classList.add('hm-recommendation-card');
    const controls = document.createElement('span');
    controls.className = 'hm-recommendation-feedback';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Öneri geri bildirimi');
    const feedback = getRecommendationFeedback(track);
    const like = document.createElement('button');
    like.type = 'button';
    like.className = `hm-recommendation-feedback-btn${feedback.liked ? ' is-active' : ''}`;
    like.title = feedback.liked ? 'Beğeniyi kaldır' : 'Bunu beğendim';
    like.setAttribute('aria-label', like.title);
    like.innerHTML = '<i class="fa-solid fa-thumbs-up"></i>';
    like.onclick = (event) => {
      event.stopPropagation();
      setRecommendationFeedback(track, feedback.liked ? null : 'liked');
      void loadHomeRecommendations(true, false);
    };
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'hm-recommendation-feedback-btn';
    add.title = 'Çalma listesine ekle';
    add.setAttribute('aria-label', add.title);
    add.innerHTML = '<i class="fa-solid fa-plus"></i>';
    add.onclick = (event) => {
      event.stopPropagation();
      openHomeRecommendationPlaylistPicker(add, track);
    };
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'hm-recommendation-feedback-btn';
    dismiss.title = 'Bunu önerme';
    dismiss.setAttribute('aria-label', dismiss.title);
    dismiss.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
    dismiss.onclick = (event) => {
      event.stopPropagation();
      setRecommendationFeedback(track, 'dismissed');
      card.remove();
      void loadHomeRecommendations(true, false);
    };
    controls.append(like, add, dismiss);
    card.querySelector('.hm-cover-art')?.appendChild(controls);
    container.appendChild(card);
  });
}

// Ana sayfadaki kapak kartı (öneriler ve "kaldığın yerden devam et" ortak kullanır).
function createHomeCoverCard(track, onPlay) {
  const card = document.createElement('article');
  card.className = 'hm-cover';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.dataset.trackTitle = track.title || '';
  card.dataset.trackArtist = track.artist || '';
  bindTrackAudioPrefetch(card, track);
  card.innerHTML = '<span class="hm-cover-art"><img alt=""><i class="fa-solid fa-play"></i></span><strong></strong><span class="hm-cover-artist"></span>';
  card.querySelector('img').src = track.thumbnail || PLACEHOLDER_COVER;
  card.querySelector('strong').textContent = track.title || '';
  card.querySelector('.hm-cover-artist').textContent = track.artist || '';
  card.onclick = onPlay;
  card.onkeydown = (event) => {
    if (event.target.closest('button')) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPlay(); }
  };
  return card;
}
function addToRecentHistory(track) {
  recentHistory = recentHistory.filter((t) => t.title !== track.title);
  recentHistory.unshift(track);
  if (recentHistory.length > 14) recentHistory.pop();
  writeAccountJson('sunify_recent_tracks', recentHistory);
  renderRecentHistory();
}

function renderRecentHistory() {
  const container = document.getElementById('continueCards');
  if (!container) return;
  if (recentHistory.length === 0) {
    container.innerHTML =
      '<p class="hm-empty">Henüz dinlediğin bir şarkı yok. Bir şarkı başlatıldığında otomatik olarak buraya kaydedilecek!</p>';
    updateContinueCarousel();
    return;
  }

  container.innerHTML = '';
  recentHistory.forEach((track, index) => {
    container.appendChild(createHomeCoverCard(track, () => playSelectedTrack(track, recentHistory, index)));
  });
  updateContinueCarousel();
  updateNowPlayingVisuals();
}

function updateContinueCarousel() {
  const container = document.getElementById('continueCards');
  const previous = document.getElementById('continuePreviousBtn');
  const next = document.getElementById('continueNextBtn');
  const carousel = document.getElementById('continueCarousel');
  if (!container || !previous || !next || !carousel) return;
  const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
  const canScroll = maxScroll > 2;
  carousel.classList.toggle('has-overflow', canScroll);
  previous.disabled = !canScroll || container.scrollLeft <= 2;
  next.disabled = !canScroll || container.scrollLeft >= maxScroll - 2;
}

function setupContinueCarousel() {
  const container = document.getElementById('continueCards');
  const previous = document.getElementById('continuePreviousBtn');
  const next = document.getElementById('continueNextBtn');
  if (!container || !previous || !next) return;
  previous.addEventListener('click', () => container.scrollBy({ left: -Math.max(300, container.clientWidth * 0.8), behavior: 'smooth' }));
  next.addEventListener('click', () => container.scrollBy({ left: Math.max(300, container.clientWidth * 0.8), behavior: 'smooth' }));
  container.addEventListener('scroll', updateContinueCarousel, { passive: true });
  window.addEventListener('resize', updateContinueCarousel);
  updateContinueCarousel();
}

// 7. ÇALMA LİSTESİ İÇ DETAY SAYFASI
let activePlaylistData = null;
let playlistReturnView = 'home';

function openPlaylistDetailView(playlist) {
  if (viewLibrary.classList.contains('active')) playlistReturnView = 'library';
  else if (viewHome.classList.contains('active')) playlistReturnView = 'home';
  playlist = { ...playlist, tracks: Array.isArray(playlist.tracks) ? playlist.tracks : [] };
  activePlaylistData = playlist;
  plHeroTitle.textContent = playlist.name;
  plHeroAuthor.textContent = playlist.author || 'Sunify Koleksiyonu';
  plHeroImg.src =
    playlist.cover ||
    playlist.thumbnail ||
    PLACEHOLDER_COVER;
  plHeroStats.innerHTML = `<i class="fa-solid fa-music"></i> ${playlist.tracks.length} parça • Dinlemeye hazır`;
  const savePlaylistBtn = document.getElementById('plSaveLibraryBtn');
  if (savePlaylistBtn) {
    const isPreview = Boolean(playlist.sourceUrl);
    const alreadySaved = customPlaylists.some((entry) => entry.id === playlist.id);
    savePlaylistBtn.hidden = !isPreview || alreadySaved;
    savePlaylistBtn.onclick = () => {
      if (!isPreview || !activePlaylistData) return;
      const saved = { ...activePlaylistData, sourceUrl: undefined };
      const existingIndex = customPlaylists.findIndex((entry) => entry.id === saved.id);
      if (existingIndex >= 0) customPlaylists[existingIndex] = saved;
      else customPlaylists.unshift(saved);
      writeAccountJson('sunify_custom_playlists', customPlaylists);
      renderLibraryItems();
      savePlaylistBtn.hidden = true;
      showAppNotification('Kitaplığa eklendi', `${saved.name} çalma listesi kaydedildi.`);
    };
  }

  renderPlaylistTracks(playlist.tracks);
  prefetchTrackBatch(playlist.tracks, 5);
  if (playlist.tracks.length) loadPlaylistRecommendations(playlist);

  void transitionAppView(viewPlaylistDetail, null, { scrollTop: 0, smoothScroll: true });

  plPlayAllBtn.onclick = () => {
    if (playlist.tracks.length > 0) {
      playSelectedTrack(playlist.tracks[0], playlist.tracks, 0);
    }
  };

  plShuffleBtn.onclick = () => {
    if (playlist.tracks.length > 0) {
      const shuffled = [...playlist.tracks].sort(() => Math.random() - 0.5);
      playSelectedTrack(shuffled[0], shuffled, 0);
    }
  };

  plSearchInput.oninput = (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = playlist.tracks.filter(
      (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)
    );
    renderPlaylistTracks(filtered);
  };
}

function setupPlaylistHeroTools() {
  const downloadAllBtn = document.getElementById('plDownloadAllBtn');
  const addTrackBtn = document.getElementById('plAddTrackBtn');
  const addToQueueBtn = document.getElementById('plAddToQueueBtn');
  const sortBtn = document.getElementById('plSortBtn');
  const deleteBtn = document.getElementById('plDeleteBtn');
  const moreBtn = document.getElementById('plMoreBtn');

  if (downloadAllBtn) {
    downloadAllBtn.onclick = async () => {
      if (
        !activePlaylistData ||
        !activePlaylistData.tracks ||
        activePlaylistData.tracks.length === 0
      ) {
        showAppNotification('Uyarı', 'İndirilecek şarkı bulunamadı.', true);
        return;
      }

      const totalTracks = activePlaylistData.tracks.length;
      showAppNotification('Toplu İndirme Başladı', `${totalTracks} şarkı sırayla indiriliyor...`);

      activePlaylistData.tracks.forEach(enqueueTrackDownload);
    };
  }

  if (addTrackBtn) {
    addTrackBtn.onclick = () => {
      document.getElementById('addTrackModal').classList.add('active');
      const input = document.getElementById('addTrackSearchInput');
      input.value = '';
      input.focus();
      document.getElementById('addTrackResultsContainer').innerHTML =
        '<p style="color:#ffffff; font-size:12px; padding:10px;">Aramak için bir şarkı veya sanatçı adı yazın...</p>';
    };
  }

  if (addToQueueBtn) {
    addToQueueBtn.onclick = () => {
      if (activePlaylistData && activePlaylistData.tracks) {
        currentPlaylist.push(...activePlaylistData.tracks);
        showAppNotification(
          'Sıraya Eklendi',
          `${activePlaylistData.tracks.length} parça mevcut sıraya eklendi!`
        );
      }
    };
  }

  if (sortBtn) {
    let sortAsc = true;
    sortBtn.onclick = () => {
      if (activePlaylistData && activePlaylistData.tracks) {
        activePlaylistData.tracks.sort((a, b) =>
          sortAsc ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title)
        );
        sortAsc = !sortAsc;
        renderPlaylistTracks(activePlaylistData.tracks);
        showAppNotification(
          'Sıralandı',
          sortAsc ? 'A-Z ye göre sıralandı.' : 'Z-A ya göre sıralandı.'
        );
      }
    };
  }

  if (deleteBtn) {
    deleteBtn.onclick = () => {
      if (!activePlaylistData) return;
      const plIndex = customPlaylists.findIndex(
        (p) => p.id === activePlaylistData.id || p.name === activePlaylistData.name
      );
      if (plIndex > -1) {
        const deletedName = customPlaylists[plIndex].name;
        customPlaylists.splice(plIndex, 1);
        writeAccountJson('sunify_custom_playlists', customPlaylists);
        renderLibraryItems();
        void transitionAppView(viewLibrary, navLibraryBtn, { scrollTop: 0, smoothScroll: true });
        showAppNotification('Çalma Listesi Silindi', `"${deletedName}" başarıyla kaldırıldı.`);
      } else {
        showAppNotification('Uyarı', 'Sistem varsayılan listeleri silinemez.', true);
      }
    };
  }

  if (moreBtn) {
    moreBtn.onclick = () => {
      showAppNotification(
        'Çalma Listesi Bilgisi',
        `${activePlaylistData?.name} • ${activePlaylistData?.tracks?.length || 0} parça`
      );
    };
  }
}

function activatePlaylistTrack(track, tracks, index) {
  if (localStorage.getItem('sunify_setting_double_click') === 'queue' && currentTrack) {
    const insertAt = Math.max(0, currentIndex + 1);
    currentPlaylist.splice(insertAt, 0, track);
    renderQueueDrawer();
    persistPlaybackResumeState(audio.currentTime);
    showAppNotification('Sıraya eklendi', `“${track.title}” sıradaki parçaya eklendi.`);
    return;
  }
  playSelectedTrack(track, tracks, index);
}

function renderPlaylistTracks(tracks) {
  playlistTracksContainer.innerHTML = '';

  tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = `pl-track-row ${currentTrack && currentTrack.title === track.title ? 'playing is-current-track' : ''}`;
    row.dataset.trackTitle = track.title;
    row.dataset.trackArtist = track.artist;
    bindTrackAudioPrefetch(row, track);
    row.innerHTML = `
      <img class="pl-track-thumb" src="${track.thumbnail || 'https://via.placeholder.com/50'}" alt="${track.title}">
      <div class="pl-track-details">
        <div class="pl-track-name">${track.title}</div>
        <div class="pl-track-artist">
          ${track.explicit ? '<span class="pl-explicit-badge">E</span>' : ''}
          ${track.artist}
        </div>
      </div>
      <span class="pl-track-time">${formatTime(track.duration)}</span>
      <div class="pl-track-actions">
        <button class="pl-action-icon-btn download-track" title="Şarkıyı İndir">
          <i class="fa-solid fa-download"></i>
        </button>
        <button class="pl-action-icon-btn edit-track" title="Şarkıyı Düzenle (Başlık/Sanatçı/Kapak)">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="pl-action-icon-btn delete-track" title="Şarkıyı Listeden Sil">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `;

    // Butonlara tıklanınca şarkının çalmasını engelle (stopPropagation)
    const dlBtn = row.querySelector('.download-track');
    const editBtn = row.querySelector('.edit-track');
    const delBtn = row.querySelector('.delete-track');

    dlBtn.onclick = (e) => {
      e.stopPropagation();
      enqueueTrackDownload(track);
    };

    editBtn.onclick = (e) => {
      e.stopPropagation();
      openEditTrackModal(track, index);
    };

    delBtn.onclick = (e) => {
      e.stopPropagation();
      removeTrackFromPlaylist(track, index);
    };

    row.onclick = () => activatePlaylistTrack(track, tracks, index);
    playlistTracksContainer.appendChild(row);
  });
}

// Şarkıyı Doğrudan Otomatik ve Optimize İndirme (Program klasöründeki downloads/ dizinine)
async function downloadTrackFile(track) {
  showAppNotification('İndiriliyor...', `"${track.title}" optimize ses formatında kaydediliyor...`);

  try {
    const res = await fetch(`${API_BASE}/save-track-locally`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: track.title,
        artist: track.artist,
        id: track.id,
        query: track.query,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'İndirme başlatılamadı.');
    if (data.success) {
      track.localUrl = data.localUrl;
      track.isLocal = true;
      persistPlaylistChanges();
      loadLocalDownloadedTracks(); // Yerel şarkılar listesini yenile
      showAppNotification(
        'İndirme Tamamlandı',
        `"${track.title}" yerel müzik klasörüne kaydedildi!`
      );
    } else {
      showAppNotification('İndirme Hatası', data.error || 'İndirilemedi', true);
    }
  } catch (err) {
    showAppNotification('Hata', err.message, true);
  }
}

// Listeden Şarkı Silme
function removeTrackFromPlaylist(track, index) {
  if (!activePlaylistData || !activePlaylistData.tracks) return;

  activePlaylistData.tracks.splice(index, 1);
  persistPlaylistChanges();
  renderPlaylistTracks(activePlaylistData.tracks);
  plHeroStats.innerHTML = `<i class="fa-solid fa-music"></i> ${activePlaylistData.tracks.length} parça • Dinlemeye hazır`;
  showAppNotification('Şarkı Silindi', `"${track.title}" çalma listesinden kaldırıldı.`);
}

// Şarkı Düzenleme (Metadata Editor)
let editingTrackRef = null;
function openEditTrackModal(track) {
  editingTrackRef = track;

  document.getElementById('editTrackTitleInput').value = track.title || '';
  document.getElementById('editTrackArtistInput').value = track.artist || '';
  document.getElementById('editTrackCoverInput').value = track.thumbnail || '';
  document.getElementById('editTrackModal').classList.add('active');
}

function persistPlaylistChanges() {
  if (!activePlaylistData) return;
  const plIdx = customPlaylists.findIndex(
    (p) => p.id === activePlaylistData.id || p.name === activePlaylistData.name
  );
  if (plIdx > -1) {
    customPlaylists[plIdx].tracks = activePlaylistData.tracks;
    writeAccountJson('sunify_custom_playlists', customPlaylists);
  }
}

// ---------------------------------------------------------------------------
// Yerel (indirilmiş / cihazdaki) müzikler
// ---------------------------------------------------------------------------
let localDownloadedTracks = [];
const normalizeTrackText = (value) => String(value || '').trim().toLocaleLowerCase('tr-TR');

function normalizeRecommendationTitle(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(official|music video|video|audio|lyrics?|visuali[sz]er|topic|remaster(?:ed)?|hd|4k|slowed|sped up|nightcore|karaoke|cover)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function recommendationTrackKey(track) {
  return normalizeRecommendationTitle(track?.title || track?.query || '');
}

function buildRecommendationSeeds(items, limit = 6) {
  const merged = new Map();
  for (const { track, weight = 1 } of items) {
    if (!track || !(track.title || track.query)) continue;
    const title = String(track.title || track.query).trim();
    const artist = String(track.artist || '').trim();
    const key = `${recommendationTrackKey({ title })}|${normalizeRecommendationTitle(artist)}`;
    if (!key || key.startsWith('|')) continue;
    const previous = merged.get(key);
    if (previous) {
      previous.weight = Math.min(8, previous.weight + weight);
      previous.duration ||= Number(track.duration) || 0;
    } else {
      merged.set(key, { title, artist, duration: Number(track.duration) || 0, weight: Math.max(1, Math.min(8, weight)) });
    }
  }
  const selected = [];
  const artistCounts = new Map();
  for (const seed of [...merged.values()].sort((a, b) => b.weight - a.weight)) {
    const artistKey = normalizeRecommendationTitle(seed.artist);
    if (artistKey && (artistCounts.get(artistKey) || 0) >= 2) continue;
    selected.push(seed);
    if (artistKey) artistCounts.set(artistKey, (artistCounts.get(artistKey) || 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function setRecommendationFeedback(track, action) {
  const key = recommendationTrackKey(track);
  if (!key) return;
  const removeMatching = (items) => items.filter((item) => item?.key !== key);
  recommendationFeedback.liked = removeMatching(recommendationFeedback.liked || []);
  recommendationFeedback.dismissed = removeMatching(recommendationFeedback.dismissed || []);
  if (action === 'liked') recommendationFeedback.liked.unshift({ key, title: track.title || '', artist: track.artist || '' });
  if (action === 'dismissed') recommendationFeedback.dismissed.unshift({ key, title: track.title || '', artist: track.artist || '' });
  recommendationFeedback.liked = recommendationFeedback.liked.slice(0, 200);
  recommendationFeedback.dismissed = recommendationFeedback.dismissed.slice(0, 300);
  writeAccountJson('sunify_recommendation_feedback', recommendationFeedback);
}

function getRecommendationFeedback(track) {
  const key = recommendationTrackKey(track);
  return {
    liked: (recommendationFeedback.liked || []).some((item) => item?.key === key),
    dismissed: (recommendationFeedback.dismissed || []).some((item) => item?.key === key),
  };
}

function filterRecommendationCandidates(candidates, { exclude = [], recent = [], limit = 8 } = {}) {
  const excludedTitles = [...exclude, ...recent].map(recommendationTrackKey).filter(Boolean);
  const dismissedTitles = (recommendationFeedback.dismissed || []).map((item) => item?.key).filter(Boolean);
  const selected = [];
  const seenTitles = [];
  const artistCounts = new Map();
  const similar = (left, right) => {
    const a = new Set(left.split(' ').filter((word) => word.length > 1));
    const b = new Set(right.split(' ').filter((word) => word.length > 1));
    if (!a.size || !b.size) return false;
    const intersection = [...a].filter((word) => b.has(word)).length;
    return intersection / (a.size + b.size - intersection) >= 0.84;
  };
  for (const track of candidates || []) {
    const titleKey = recommendationTrackKey(track);
    if (!titleKey || excludedTitles.some((key) => similar(titleKey, key)) || dismissedTitles.some((key) => similar(titleKey, key))) continue;
    if (seenTitles.some((key) => similar(titleKey, key))) continue;
    const artistKey = normalizeRecommendationTitle(track.artist);
    const artistCount = artistCounts.get(artistKey) || 0;
    if (artistKey && artistCount >= 2) continue;
    selected.push(track);
    seenTitles.push(titleKey);
    if (artistKey) artistCounts.set(artistKey, artistCount + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

// Aynı şarkı (başlık + sanatçı) diskte varsa onun yerel adresini döndürür.
function findDownloadedTrack(track) {
  if (!track || track.isLocal || !localDownloadedTracks.length) return null;
  const title = normalizeTrackText(track.title);
  const artist = normalizeTrackText(track.artist);
  if (!title) return null;
  return localDownloadedTracks.find(
    (local) => normalizeTrackText(local.title) === title && normalizeTrackText(local.artist) === artist
  ) || null;
}

async function loadLocalDownloadedTracks() {
  try {
    const response = await fetch(`${API_BASE}/local-downloads`, { signal: AbortSignal.timeout(15_000) });
    const data = await response.json();
    localDownloadedTracks = Array.isArray(data.tracks) ? data.tracks : [];
    const deviceItem = INITIAL_LIBRARY_ITEMS.find((item) => item.id === 'lib_device');
    if (deviceItem) deviceItem.tracks = localDownloadedTracks;
    renderLibraryItems();
  } catch (error) {
    console.warn('Yerel müzikler okunamadı:', error);
    const deviceItem = INITIAL_LIBRARY_ITEMS.find((item) => item.id === 'lib_device');
    if (deviceItem) deviceItem.tracks = [];
    renderLibraryItems();
  }
}

async function loadCachedAudioTracks() {
  const cachedItem = INITIAL_LIBRARY_ITEMS.find((item) => item.id === 'lib_cached');
  if (!cachedItem) return;
  try {
    const knownTracks = [
      ...(currentTrack ? [currentTrack] : []),
      ...recentHistory,
      ...likedTracks,
      ...customPlaylists.flatMap((playlist) => playlist.tracks || []),
      ...INITIAL_LIBRARY_ITEMS.filter((item) => item.id !== 'lib_cached').flatMap((item) => item.tracks || []),
      ...getMostPlayedTracks(300),
      ...[...preparedAudioTrackMetadata.values()],
    ].filter((track) => track?.title);
    const uniqueTracks = [...new Map(knownTracks.map((track) => {
      const videoId = getTrackYouTubeVideoId(track);
      const compactTrack = {
        videoId,
        id: track.id || '',
        query: String(track.query || `${track.artist || ''} ${track.title || ''}`).trim().slice(0, 500),
        title: String(track.title || '').slice(0, 240),
        artist: String(track.artist || '').slice(0, 200),
        thumbnail: String(track.thumbnail || '').slice(0, 2000),
        duration: Number(track.duration) || 0,
      };
      return [`${videoId || track.id || ''}|${track.title}|${track.artist || ''}`, compactTrack];
    })).values()].slice(0, 500);
    const response = await fetch(`${API_BASE}/audio-cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: uniqueTracks }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ses önbelleği okunamadı.');
    cachedItem.tracks = localStorage.getItem('sunify_setting_show_cached') === 'true' && Array.isArray(data.tracks) ? data.tracks : [];
  } catch (error) {
    console.warn('Ses önbelleği okunamadı:', error.message);
    cachedItem.tracks = [];
  }
  renderLibraryItems();
}

// ---------------------------------------------------------------------------
// Çalma sırası çekmecesi
// ---------------------------------------------------------------------------
const QUEUE_RENDER_LIMIT = 120;
let queueDragIndex = -1;

function makeQueueIconButton(iconClass, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.title = label;
  button.setAttribute('aria-label', label);
  const icon = document.createElement('i');
  icon.className = `fa-solid ${iconClass}`;
  button.appendChild(icon);
  button.onclick = (event) => { event.stopPropagation(); onClick(); };
  return button;
}

function renderQueueDrawer() {
  const drawer = document.getElementById('queueDrawer');
  const list = document.getElementById('queueList');
  const currentBox = document.getElementById('queueCurrentTrack');
  const count = document.getElementById('queueTrackCount');
  if (!drawer || !list || !currentBox || !count) return;

  const upcomingTotal = Math.max(0, currentPlaylist.length - currentIndex - 1);
  count.textContent = `${upcomingTotal} parça sırada`;
  if (!drawer.classList.contains('open')) return; // kapalıyken ağır çizim yapma

  currentBox.replaceChildren();
  if (currentTrack) {
    const cover = document.createElement('img');
    cover.src = currentTrack.thumbnail || PLACEHOLDER_COVER;
    cover.alt = '';
    const meta = document.createElement('div');
    const small = document.createElement('small'); small.textContent = 'ŞİMDİ ÇALIYOR';
    const title = document.createElement('strong'); title.textContent = currentTrack.title || '';
    const artist = document.createElement('span'); artist.textContent = currentTrack.artist || '';
    meta.append(small, title, artist);
    currentBox.append(cover, meta);
  }

  list.replaceChildren();
  if (!upcomingTotal) {
    const empty = document.createElement('p');
    empty.className = 'empty-state-card';
    empty.textContent = 'Sırada başka parça yok. “Akıllı sırayı doldur” ile öneri ekleyebilirsin.';
    list.appendChild(empty);
    return;
  }

  const start = currentIndex + 1;
  const end = Math.min(currentPlaylist.length, start + QUEUE_RENDER_LIMIT);
  for (let index = start; index < end; index += 1) {
    const track = currentPlaylist[index];
    if (!track) continue;
    const row = document.createElement('div');
    row.className = 'queue-track-row';
    row.draggable = true;
    row.dataset.queueIndex = String(index);

    const cover = document.createElement('img');
    cover.src = track.thumbnail || PLACEHOLDER_COVER;
    cover.alt = '';
    cover.loading = 'lazy';
    const meta = document.createElement('div');
    meta.className = 'queue-track-meta';
    const title = document.createElement('strong'); title.textContent = track.title || '';
    const artist = document.createElement('span'); artist.textContent = track.artist || '';
    meta.append(title, artist);

    row.append(
      cover,
      meta,
      makeQueueIconButton('fa-play', 'Şimdi çal', () => playSelectedTrack(track, currentPlaylist, index)),
      makeQueueIconButton('fa-xmark', 'Sıradan kaldır', () => {
        // Orijinal çalma listesini bozmamak için önce kopyala.
        currentPlaylist = currentPlaylist.filter((_, at) => at !== index);
        renderQueueDrawer();
      })
    );
    row.onclick = () => playSelectedTrack(track, currentPlaylist, index);

    row.addEventListener('dragstart', (event) => {
      queueDragIndex = index;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => { queueDragIndex = -1; row.classList.remove('dragging'); });
    row.addEventListener('dragover', (event) => { if (queueDragIndex >= 0) event.preventDefault(); });
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      if (queueDragIndex < 0 || queueDragIndex === index) return;
      const reordered = currentPlaylist.slice();
      const [moved] = reordered.splice(queueDragIndex, 1);
      reordered.splice(index, 0, moved);
      currentPlaylist = reordered;
      queueDragIndex = -1;
      renderQueueDrawer();
    });
    list.appendChild(row);
  }
}

function setupQueueDrawer() {
  const drawer = document.getElementById('queueDrawer');
  const closeDrawer = () => {
    drawer?.classList.remove('open');
    drawer?.setAttribute('aria-hidden', 'true');
  };
  document.getElementById('closeQueueBtn')?.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer?.classList.contains('open')) closeDrawer();
  });
  // Çekmece dışına tıklayınca kapan (sıra düğmesi hariç).
  document.addEventListener('pointerdown', (event) => {
    if (!drawer?.classList.contains('open')) return;
    if (drawer.contains(event.target) || queueBtn.contains(event.target)) return;
    closeDrawer();
  });

  document.getElementById('clearQueueBtn')?.addEventListener('click', () => {
    if (!currentPlaylist.length) return;
    currentPlaylist = currentPlaylist.slice(0, currentIndex + 1);
    renderQueueDrawer();
    showAppNotification('Sıra temizlendi', 'Çalan şarkıdan sonraki parçalar kaldırıldı.');
  });

  const smartButton = document.getElementById('smartQueueBtn');
  if (smartButton) {
    smartButton.addEventListener('click', async () => {
      if (!currentTrack) {
        showAppNotification('Önce bir şarkı çal', 'Akıllı sıra, çalan şarkıya göre öneri ekler.', true);
        return;
      }
      smartButton.disabled = true;
      try {
        const query = `${currentTrack.artist || ''} ${currentTrack.title || ''}`.trim();
        const response = await fetch(`${API_BASE}/recommendations?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(25_000) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Öneriler alınamadı.');
        const known = new Set(currentPlaylist.map((track) => `${normalizeTrackText(track.artist)}|${normalizeTrackText(track.title)}`));
        const fresh = (data.tracks || []).filter((track) => {
          const key = `${normalizeTrackText(track.artist)}|${normalizeTrackText(track.title)}`;
          if (known.has(key)) return false;
          known.add(key);
          return true;
        }).slice(0, 10);
        if (!currentPlaylist.length) { currentPlaylist = [currentTrack]; currentIndex = 0; }
        currentPlaylist = [...currentPlaylist, ...fresh];
        renderQueueDrawer();
        showAppNotification('Akıllı sıra', fresh.length ? `${fresh.length} öneri sıraya eklendi.` : 'Eklenecek yeni öneri bulunamadı.');
      } catch (error) {
        showAppNotification('Akıllı sıra başarısız', error.message, true);
      } finally {
        smartButton.disabled = false;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Çalma listesi önerileri
// ---------------------------------------------------------------------------
async function loadPlaylistRecommendations(playlist, refreshSearch = false) {
  const grid = document.getElementById('playlistRecommendationsGrid');
  const section = document.getElementById('playlistRecommendationsSection');
  const refreshButton = document.getElementById('refreshPlaylistRecommendationsBtn');
  if (!grid || !section) return;
  if (refreshButton) refreshButton.onclick = () => loadPlaylistRecommendations(activePlaylistData || playlist, true);

  const tracks = (playlist?.tracks || []).filter((track) => track && (track.title || track.query));
  if (!tracks.length) { section.style.display = 'none'; return; }
  section.style.display = '';

  const requestId = ++playlistRecommendationRequest;
  grid.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'empty-state-card';
  loading.textContent = 'Öneriler hazırlanıyor…';
  grid.appendChild(loading);

  const playlistSeedTracks = [];
  const sampleCount = Math.min(refreshSearch ? 4 : 5, tracks.length);
  const sampleOffset = refreshSearch && tracks.length > sampleCount
    ? Math.floor(Math.random() * tracks.length)
    : 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const position = sampleCount === 1
      ? sampleOffset % tracks.length
      : Math.floor((sampleOffset + index * tracks.length / sampleCount) % tracks.length);
    playlistSeedTracks.push(tracks[position]);
  }
  const seedItems = [
    ...playlistSeedTracks.map((track) => ({ track, weight: 4 })),
    ...(recommendationFeedback.liked || []).slice(0, 2).map((track) => ({ track, weight: 2 })),
    ...likedTracks.slice(-2).reverse().map((track) => ({ track, weight: 1 })),
  ];
  const seeds = buildRecommendationSeeds(seedItems, 6);
  try {
    const params = new URLSearchParams({ seeds: JSON.stringify(seeds), ...(refreshSearch ? { refresh: '1' } : {}) });
    const response = await fetch(`${API_BASE}/recommendations?${params}`, { signal: AbortSignal.timeout(35_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Öneriler alınamadı.');
    if (requestId !== playlistRecommendationRequest) return;

    const picks = filterRecommendationCandidates(data.tracks, {
      exclude: tracks,
      recent: recentHistory.slice(0, 5),
      limit: 8,
    });
    grid.replaceChildren();
    if (!picks.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state-card';
      empty.textContent = 'Şu an uygun öneri bulunamadı.';
      grid.appendChild(empty);
      return;
    }

    const currentEditablePlaylist = customPlaylists.find((item) => item.id === playlist.id || item.name === playlist.name);
    picks.forEach((track) => {
      const card = document.createElement('div');
      card.className = 'playlist-recommendation-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', `${track.title || 'Şarkı'} — ${track.artist || ''}. Şarkıyı çalmak için karta tıkla.`);
      const playTrack = () => playSelectedTrack(track, picks, picks.indexOf(track));
      card.addEventListener('click', playTrack);
      card.addEventListener('keydown', (event) => {
        if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        playTrack();
      });
      const cover = document.createElement('img');
      cover.src = track.thumbnail || PLACEHOLDER_COVER;
      cover.alt = '';
      cover.loading = 'lazy';
      const meta = document.createElement('div');
      meta.className = 'playlist-recommendation-meta';
      const title = document.createElement('strong'); title.textContent = track.title || '';
      const artist = document.createElement('span'); artist.textContent = track.artist || '';
      meta.append(title, artist);
      const actions = document.createElement('div');
      actions.className = 'playlist-recommendation-actions';
      const feedback = getRecommendationFeedback(track);
      const likeButton = makeQueueIconButton('fa-thumbs-up', feedback.liked ? 'Beğeniyi kaldır' : 'Bunu beğendim', () => {
        setRecommendationFeedback(track, feedback.liked ? null : 'liked');
        loadPlaylistRecommendations(activePlaylistData || playlist);
      });
      if (feedback.liked) likeButton.classList.add('is-feedback-active');
      const dismissButton = makeQueueIconButton('fa-eye-slash', 'Bunu önerme', () => {
        setRecommendationFeedback(track, 'dismissed');
        card.remove();
        loadPlaylistRecommendations(activePlaylistData || playlist);
      });
      const addButton = makeQueueIconButton('fa-plus', 'Çalma listesine ekle', () => {
        const addToPlaylist = (target) => {
          const targetTracks = Array.isArray(target.tracks) ? target.tracks : (target.tracks = []);
          const duplicate = targetTracks.some((item) => normalizeTrackText(item.title) === normalizeTrackText(track.title) && normalizeTrackText(item.artist) === normalizeTrackText(track.artist));
          if (duplicate) {
            showAppNotification('Zaten listede', `“${track.title}” bu çalma listesinde zaten var.`, true);
            return;
          }
          targetTracks.push({ ...track });
          const stored = customPlaylists.find((item) => item.id === target.id || item.name === target.name);
          if (stored) stored.tracks = targetTracks;
          writeAccountJson('sunify_custom_playlists', customPlaylists);
          if (activePlaylistData && (activePlaylistData.id === target.id || activePlaylistData.name === target.name)) {
            activePlaylistData.tracks = targetTracks;
            renderPlaylistTracks(targetTracks);
            plHeroStats.innerHTML = `<i class="fa-solid fa-music"></i> ${targetTracks.length} parça • Dinlemeye hazır`;
          }
          card.remove();
          showAppNotification('Listeye eklendi', `“${track.title}” · ${target.name}`);
        };

        if (currentEditablePlaylist) {
          addToPlaylist(currentEditablePlaylist);
          return;
        }

        const existingPicker = card.querySelector('.playlist-recommendation-picker');
        if (existingPicker) { existingPicker.remove(); return; }
        const picker = document.createElement('div');
        picker.className = 'playlist-recommendation-picker';
        picker.setAttribute('role', 'group');
        picker.setAttribute('aria-label', 'Eklenecek çalma listesini seç');
        picker.addEventListener('click', (event) => event.stopPropagation());
        if (!customPlaylists.length) {
          const empty = document.createElement('span');
          empty.textContent = 'Önce bir çalma listesi oluştur.';
          picker.appendChild(empty);
        } else {
          customPlaylists.forEach((target) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.textContent = target.name || 'Çalma listesi';
            option.onclick = (event) => { event.stopPropagation(); addToPlaylist(target); };
            picker.appendChild(option);
          });
        }
        card.appendChild(picker);
      });
      actions.append(likeButton, dismissButton, addButton);
      card.append(cover, meta, actions);
      grid.appendChild(card);
    });
  } catch (error) {
    if (requestId !== playlistRecommendationRequest) return;
    grid.replaceChildren();
    const failed = document.createElement('p');
    failed.className = 'empty-state-card';
    failed.textContent = `Öneriler yüklenemedi: ${error.message}`;
    grid.appendChild(failed);
  }
}

// ---------------------------------------------------------------------------
// Şarkı sözü araçları: arama filtresi + yazı boyutu
// ---------------------------------------------------------------------------
function setupLyricsTools() {
  const filterInput = document.getElementById('lyricsFilterInput');
  if (filterInput) filterInput.addEventListener('input', applyLyricsFilter);

  const MIN_SIZE = 18;
  const MAX_SIZE = 56;
  let size = 28;
  try {
    const saved = Number(localStorage.getItem('sunify_lyrics_font'));
    if (saved >= MIN_SIZE && saved <= MAX_SIZE) size = saved;
  } catch {}
  const apply = () => {
    document.documentElement.style.setProperty('--lyrics-font-size', `${size}px`);
    try { localStorage.setItem('sunify_lyrics_font', String(size)); } catch {}
  };
  apply();
  document.getElementById('lyricsFontDownBtn')?.addEventListener('click', () => { size = Math.max(MIN_SIZE, size - 2); apply(); });
  document.getElementById('lyricsFontUpBtn')?.addEventListener('click', () => { size = Math.min(MAX_SIZE, size + 2); apply(); });
}

// 8. ŞARKI ÇALMA FONKSİYONU (BUFFER & GEÇİŞ SORUNU ÇÖZÜLDÜ, ANINDA ESKİYİ DURDURMA)
let playSessionId = 0; // Şarkı geçiş çakışmalarını önleyen oturum belirteci
let isResolvingPlayback = false;
let upcomingPrefetch = null;
let activeAudioFallback = null;
const audioPrefetchRequests = new Map();
const audioPrefetchQueue = [];
const preparedAudioTrackMetadata = new Map();
let audioPrefetchWorkers = 0;
const MAX_CLIENT_PREFETCH_QUEUE = 40;
let cachedAudioMetadataRefreshTimer = null;

function bindTrackAudioPrefetch(element, track) {
  let timer = null;
  element.addEventListener('pointerenter', () => {
    timer = setTimeout(() => prefetchTrackAudio(track), 180);
  }, { passive: true });
  element.addEventListener('pointerleave', () => {
    clearTimeout(timer);
    timer = null;
  }, { passive: true });
}

function prefetchTrackAudio(track) {
  const videoId = getTrackYouTubeVideoId(track);
  const query = String(track?.query || `${track?.artist || ''} ${track?.title || ''}`).trim();
  const target = videoId || query;
  if (!target) return;
  preparedAudioTrackMetadata.set(target, {
    videoId,
    id: track.id || '',
    query,
    title: track.title || '',
    artist: track.artist || '',
    thumbnail: track.thumbnail || '',
    duration: Number(track.duration) || 0,
  });
  if (preparedAudioTrackMetadata.size > 800) preparedAudioTrackMetadata.delete(preparedAudioTrackMetadata.keys().next().value);
  if (audioPrefetchRequests.has(target)) return audioPrefetchRequests.get(target);
  if (audioPrefetchRequests.size >= MAX_CLIENT_PREFETCH_QUEUE) return Promise.resolve();
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  audioPrefetchRequests.set(target, request);
  audioPrefetchQueue.push({ target, videoId, query, track, resolve: resolveRequest });
  pumpAudioPrefetchQueue();
  return request;
}

function prefetchTrackBatch(tracks, limit = 5) {
  for (const track of (Array.isArray(tracks) ? tracks : []).slice(0, limit)) prefetchTrackAudio(track);
  if (localStorage.getItem('sunify_setting_show_cached') === 'true') {
    clearTimeout(cachedAudioMetadataRefreshTimer);
    cachedAudioMetadataRefreshTimer = setTimeout(() => { void loadCachedAudioTracks(); }, 1200);
  }
}

function pumpAudioPrefetchQueue() {
  while (audioPrefetchWorkers < 2 && audioPrefetchQueue.length) {
    const item = audioPrefetchQueue.shift();
    audioPrefetchWorkers += 1;
    fetch(`${API_BASE}/audio-prefetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: item.videoId,
        query: item.query,
        title: item.track?.title || '',
        artist: item.track?.artist || '',
        thumbnail: item.track?.thumbnail || '',
        duration: item.track?.duration || 0,
        trackId: item.track?.id || '',
        priority: 'low',
      }),
    }).catch((error) => console.debug('Ses ön hazırlığı başlatılamadı:', error.message))
      .finally(() => {
        audioPrefetchRequests.delete(item.target);
        item.resolve();
        audioPrefetchWorkers = Math.max(0, audioPrefetchWorkers - 1);
        pumpAudioPrefetchQueue();
      });
  }
}

function getTrackYouTubeVideoId(track) {
  const directId = String(track?.id || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(directId)) return directId;
  const candidateUrl = String(track?.url || track?.sourceUrl || '').trim();
  if (!candidateUrl) return '';
  try {
    const url = new URL(candidateUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const shortId = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[a-zA-Z0-9_-]{11}$/.test(shortId) ? shortId : '';
    }
    if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      const fromQuery = url.searchParams.get('v');
      const fromPath = url.pathname.match(/^\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})/i)?.[1];
      return /^[a-zA-Z0-9_-]{11}$/.test(fromQuery || '') ? fromQuery : (fromPath || '');
    }
  } catch {}
  return '';
}

function createTrackAudioStreamUrl(track, videoId, excludeVideoIds = [], retrySearch = false) {
  const cacheKey = String(track?.cacheKey || '').trim();
  const params = new URLSearchParams();
  if (!excludeVideoIds.length && /^[a-f0-9]{64}$/i.test(cacheKey)) {
    params.set('cacheKey', cacheKey);
  } else if (videoId && !excludeVideoIds.length) {
    params.set('id', videoId);
  } else {
    params.set('q', String(track?.query || `${track?.artist || ''} ${track?.title || ''}`).trim());
  }
  const query = String(track?.query || `${track?.artist || ''} ${track?.title || ''}`).trim();
  params.set('trackId', excludeVideoIds.length ? '' : (videoId || ''));
  params.set('trackQuery', query);
  params.set('title', track?.title || '');
  params.set('artist', track?.artist || '');
  params.set('thumbnail', track?.thumbnail || '');
  params.set('duration', String(Number(track?.duration) || 0));
  if (excludeVideoIds.length) params.set('excludeIds', excludeVideoIds.join(','));
  if (retrySearch) params.set('retrySearch', '1');
  return `${API_BASE}/audio-stream?${params.toString()}`;
}

function retryTrackWithAlternateSource(fallback) {
  if (!fallback || fallback.sessionId !== playSessionId) return Promise.resolve(false);
  if (fallback.retryPromise) return fallback.retryPromise;
  if (fallback.attempted) return Promise.resolve(false);
  fallback.attempted = true;
  fallback.retrying = true;
  fallback.retryPromise = (async () => {
    const audioElement = document.getElementById('audioPlayer');
    try {
      audioElement.pause();
      audioElement.src = createTrackAudioStreamUrl(
        fallback.track,
        '',
        fallback.videoId ? [fallback.videoId] : [],
        true
      );
      audioElement.load();
      await audioElement.play();
      console.info(`[playback-fallback] alternate video selected for "${fallback.track.title}"`);
      return true;
    } catch (error) {
      console.warn(`[playback-fallback] alternate source failed for "${fallback.track.title}":`, error);
      return false;
    } finally {
      fallback.retrying = false;
    }
  })();
  return fallback.retryPromise;
}

function getUpcomingTrackCandidate() {
  if (!currentTrack || !currentPlaylist.length || repeatMode === 'one') return null;
  if (isShuffle) {
    if (currentPlaylist.length < 2) return null;
    let index = currentIndex;
    do { index = Math.floor(Math.random() * currentPlaylist.length); } while (index === currentIndex);
    return { track: currentPlaylist[index], index };
  }
  if (currentIndex < currentPlaylist.length - 1) {
    return { track: currentPlaylist[currentIndex + 1], index: currentIndex + 1 };
  }
  return repeatMode === 'all' && currentPlaylist.length > 1
    ? { track: currentPlaylist[0], index: 0 }
    : null;
}

function maybePrefetchNextTrack(position, duration) {
  if (isResolvingPlayback || !isPlaying || !(duration > 0) || duration - position > 25) return;
  if (upcomingPrefetch?.sourceTrack === currentTrack && upcomingPrefetch.sourceIndex === currentIndex && upcomingPrefetch.sourcePlaylist === currentPlaylist) return;
  const next = getUpcomingTrackCandidate();
  if (!next?.track) return;

  const videoId = getTrackYouTubeVideoId(next.track);
  const query = String(next.track.query || `${next.track.artist || ''} ${next.track.title || ''}`).trim();
  if (!videoId && !query) return;
  const sourceTrack = currentTrack;
  const sourceIndex = currentIndex;
  const sourcePlaylist = currentPlaylist;
  upcomingPrefetch = { ...next, sourceTrack, sourceIndex, sourcePlaylist };
  fetch(`${API_BASE}/audio-prefetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId,
      query,
      title: next.track.title || '',
      artist: next.track.artist || '',
      thumbnail: next.track.thumbnail || '',
      duration: Number(next.track.duration) || 0,
      trackId: next.track.id || '',
    }),
  }).catch(() => {});
}

function updateNowPlayingVisuals() {
  const normalize = (value) => String(value || '').trim().toLocaleLowerCase();
  document.body.classList.toggle('is-playing', Boolean(currentTrack && isPlaying));
  document.querySelectorAll('[data-track-title]').forEach((element) => {
    const isCurrent = Boolean(
      currentTrack &&
        normalize(element.dataset.trackTitle) === normalize(currentTrack.title) &&
        normalize(element.dataset.trackArtist) === normalize(currentTrack.artist)
    );
    element.classList.toggle('is-current-track', isCurrent);
    element.setAttribute('aria-current', isCurrent ? 'true' : 'false');
  });
  publishMiniPlayerState();
}

async function playSelectedTrack(track, playlist = [], index = 0, options = {}) {
  if (!track) return;
  const playRequestedAt = performance.now();
  // 1. Yeni şarkıya basıldığı AN eski şarkıyı ve sayacı derhal durdur!
  playSessionId++;
  const thisSession = playSessionId;
  activeAudioFallback = null;
  upcomingPrefetch = null;

  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  // İlerleme çubuğunu ve süre göstergelerini hemen sıfırla
  progressBarFill.style.width = '0%';
  currentTimeLabel.textContent = '0:00';
  if (lyricsProgressFill) lyricsProgressFill.style.width = '0%';
  if (lyricsCurrentTime) lyricsCurrentTime.textContent = '0:00';

  currentTrack = track;
  seekRecoveryToken += 1;
  pendingSeekTarget = null;
  resetListenSession(track);
  isPlaying = false;
  isResolvingPlayback = true;
  playPauseBtn.classList.add('is-loading');
  playPauseBtn.setAttribute('aria-label', 'Şarkı yükleniyor');
  currentPlaylist = playlist;
  currentIndex = index;
  renderQueueDrawer();
  applyCoverAdaptiveColor(track.thumbnail);
  updateNowPlayingVisuals();

  currentTitle.textContent = track.title;
  currentArtist.textContent = `${track.artist} (Yükleniyor...)`;
  currentThumb.src = track.thumbnail;

  lyricsTrackTitle.textContent = track.title;
  lyricsTrackArtist.textContent = track.artist;
  if (lyricsHeaderTrackTitle) lyricsHeaderTrackTitle.textContent = `${track.title} · ${track.artist}`;
  lyricsBigCover.src = track.thumbnail;
  lyricsBackdrop.style.backgroundImage = `url('${track.thumbnail}')`;

  updateLikeButtonUI();
  updatePlayPauseIcons(false); // Yüklenirken duraklatma simgesi

  // Discord RPC ve Şarkı Sözlerini parallel yükle
  syncDiscordRPC(track, 0, track.duration || 180, false);
  lyricsRefetchedForDuration = false;
  loadTrackLyrics(track.title, track.artist, track.duration);

  if (viewPlaylistDetail.classList.contains('active') && activePlaylistData) {
    renderPlaylistTracks(activePlaylistData.tracks);
  }

  // Eğer şarkı yerel downloads klasöründe zaten varsa doğrudan yerelden ultra hızlı çal!
  try {
    const localTrack = findDownloadedTrack(track) || (track.isLocal ? track : null);
    const localUrl = localTrack?.localUrl || track.localUrl;
    if (localUrl) {
      audio.src = localUrl;
      audio.preload = 'auto';
      audio.load();
      await audio.play();
    } else {
      const videoId = getTrackYouTubeVideoId(track);
      const playbackQuery = String(track.query || `${track.artist || ''} ${track.title || ''}`).trim();
      // Search results already include title, cover and duration. Start the
      // progressive local stream directly instead of resolving a temporary URL first.
      applyCoverAdaptiveColor(track.thumbnail);
      audio.crossOrigin = 'anonymous';
      if (playbackQuery) activeAudioFallback = { sessionId: thisSession, track, videoId, attempted: false, retryPromise: null };
      audio.src = createTrackAudioStreamUrl(track, videoId);
      if (thisSession !== playSessionId) return;
      try {
        audio.preload = 'auto';
        audio.load();
        await audio.play();
      } catch (firstPlaybackError) {
        if (thisSession !== playSessionId) return;
        const recovered = await retryTrackWithAlternateSource(activeAudioFallback);
        if (!recovered) throw firstPlaybackError;
      }
      if (track.duration) syncDiscordRPC(track, 0, track.duration, true);
    }

    if (thisSession !== playSessionId) return;
    console.info(`[play-timing] "${track.title}" click-to-play: ${(performance.now() - playRequestedAt).toFixed(0)}ms`);
    const resumePosition = Math.max(0, Number(options.resumePosition) || 0);
    if (resumePosition > 2 && Number.isFinite(audio.duration) && audio.duration > resumePosition + 2) {
      seekAudioTo(resumePosition);
    }
    isResolvingPlayback = false;
    playPauseBtn.classList.remove('is-loading');
    playPauseBtn.setAttribute('aria-label', 'Oynat / Duraklat');
    currentArtist.textContent = track.artist;
    persistPlaybackResumeState(audio.currentTime || 0);
    addToRecentHistory(track);
    trackSongStartEvent(track);
    syncToCloudSilently();
    updatePlayPauseIcons(true);
    publishMiniPlayerState();
  } catch (err) {
    if (thisSession !== playSessionId) return;
    activeAudioFallback = null;
    console.error('Audio stream error:', err);
    isResolvingPlayback = false;
    playPauseBtn.classList.remove('is-loading');
    playPauseBtn.setAttribute('aria-label', 'Oynat / Duraklat');
    isPlaying = false;
    updatePlayPauseIcons(false);
    currentArtist.textContent = err.name === 'TimeoutError' ? 'Bağlantı zaman aşımına uğradı' : 'Oynatma hatası';
    showAppNotification('Şarkı çalınamadı', err.message || 'Ses akışı başlatılamadı.', true);
  }
}

let lastPersistedResumeTrackKey = '';
let lastPersistedPlaylistRef = null;
function persistPlaybackResumeState(position = audio?.currentTime || 0) {
  if (!currentTrack?.title) return;
  const trackKey = `${currentTrack.id || ''}|${currentTrack.artist || ''}|${currentTrack.title || ''}`;
  const activeTracks = Array.isArray(activePlaylistData?.tracks) ? activePlaylistData.tracks : [];
  const playlistRef = activeTracks.length ? activeTracks : currentPlaylist;

  // Aynı şarkı ve aynı çalma listesi çalarken her 5 sn'de bir tüm listeyi (yüzlerce şarkı)
  // yeniden kopyalayıp JSON üretmek yerine yalnızca position alanını güncelle
  if (playbackResumeState && lastPersistedResumeTrackKey === trackKey && lastPersistedPlaylistRef === playlistRef) {
    playbackResumeState.position = Math.max(0, Number(position) || 0);
    playbackResumeState.savedAt = Date.now();
    writeAccountJson('sunify_playback_state', playbackResumeState);
    return;
  }

  const compactTrack = (track) => ({
    id: track.id || '',
    title: track.title || '',
    artist: track.artist || '',
    thumbnail: track.thumbnail || PLACEHOLDER_COVER,
    duration: Number(track.duration) || 0,
    query: track.query || '',
    localUrl: track.localUrl || '',
    isLocal: Boolean(track.isLocal),
  });
  const trackMatches = (track) => track && (
    (currentTrack.id && track.id && String(currentTrack.id) === String(track.id)) ||
    (String(track.title || '').toLocaleLowerCase() === String(currentTrack.title || '').toLocaleLowerCase() &&
      String(track.artist || '').toLocaleLowerCase() === String(currentTrack.artist || '').toLocaleLowerCase())
  );
  const playlistTracks = activeTracks.some(trackMatches) ? activeTracks : currentPlaylist;
  const playlistIndex = playlistTracks.findIndex(trackMatches);
  // RAM ve localStorage şişmesini önlemek için devam durumu en fazla 60 şarkı saklar
  const startSlice = Math.max(0, playlistIndex - 15);
  const boundedTracks = playlistTracks.slice(startSlice, startSlice + 60);
  lastPersistedResumeTrackKey = trackKey;
  lastPersistedPlaylistRef = playlistRef;
  playbackResumeState = {
    track: compactTrack(currentTrack),
    position: Math.max(0, Number(position) || 0),
    playlist: {
      id: activeTracks.some(trackMatches) ? (activePlaylistData.id || '') : '',
      name: activeTracks.some(trackMatches) ? (activePlaylistData.name || '') : '',
      tracks: boundedTracks.map(compactTrack),
      index: playlistIndex >= 0 ? (playlistIndex - startSlice) : 0,
    },
    savedAt: Date.now(),
  };
  writeAccountJson('sunify_playback_state', playbackResumeState);
}

// Lyrics requests have a visible loading/empty/error state and ignore stale responses after track changes.
let lyricsRequestId = 0;
let activeLyricsAbortController = null;
let lyricsSyncAnimationFrame = 0;
let lastLyricsSyncFrameAt = 0;
let isWindowMinimized = false;
function stopLyricsSyncAnimation() {
  if (lyricsSyncAnimationFrame) cancelAnimationFrame(lyricsSyncAnimationFrame);
  lyricsSyncAnimationFrame = 0;
}
function syncLyricsAnimationFrame(timestamp = 0) {
  lyricsSyncAnimationFrame = 0;
  if (isWindowMinimized || document.hidden || !lyricsOverlay?.classList.contains('active') || audio.paused || !parsedLyrics.length) return;
  // 60-144 FPS yerine ~22 FPS (45ms aralık) kelime vurgusu için fazlasıyla akıcıdır ve CPU yükünü %65 azaltır
  if (!timestamp || timestamp - lastLyricsSyncFrameAt >= 45) {
    lastLyricsSyncFrameAt = timestamp;
    syncActiveLyric(audio.currentTime || 0);
  }
  lyricsSyncAnimationFrame = requestAnimationFrame(syncLyricsAnimationFrame);
}
function startLyricsSyncAnimation() {
  if (lyricsSyncAnimationFrame || isWindowMinimized || document.hidden || !lyricsOverlay?.classList.contains('active') || audio.paused || !parsedLyrics.length) return;
  syncActiveLyric(audio.currentTime || 0);
  lyricsSyncAnimationFrame = requestAnimationFrame(syncLyricsAnimationFrame);
}
function renderLyricsState(message, kind = 'empty', retry = false) {
  if (!lyricsLinesContainer) return;
  renderedLyricLines = [];
  renderedInstrumentalGaps = [];
  activeInstrumentalGap = null;
  completedInstrumentalGapCount = 0;
  lastInstrumentalSyncTime = -Infinity;
  activeLyricWordIndex = -1;
  activeLyricIndex = -1;
  const state = document.createElement('div');
  state.className = `lyrics-state-card ${kind}`;
  const icon = document.createElement('i');
  icon.className = `fa-solid ${kind === 'loading' ? 'fa-spinner fa-spin' : kind === 'error' ? 'fa-triangle-exclamation' : 'fa-music'}`;
  const text = document.createElement('span'); text.textContent = message;
  state.append(icon, text);
  if (retry) {
    const button = document.createElement('button');
    button.className = 'lyrics-retry-btn'; button.type = 'button';
    button.innerHTML = '<i class="fa-solid fa-rotate"></i> Yeniden dene';
    button.onclick = () => { if (currentTrack) loadTrackLyrics(currentTrack.title, currentTrack.artist, currentTrack.duration, 'auto'); };
    state.appendChild(button);
  }
  lyricsLinesContainer.replaceChildren(state);
}

function applyLyricsFilter() {
  const query = document.getElementById('lyricsFilterInput')?.value.trim().toLocaleLowerCase('tr-TR') || '';
  const lines = [...document.querySelectorAll('#lyricsLinesContainer .lyric-line')];
  document.querySelector('#lyricsLinesContainer .lyrics-no-filter-match')?.remove();
  lines.forEach((line) => {
    line.hidden = Boolean(query) && !line.textContent.toLocaleLowerCase('tr-TR').includes(query);
  });
  if (query && lines.length && lines.every((line) => line.hidden)) {
    const empty = document.createElement('div');
    empty.className = 'lyrics-no-filter-match';
    empty.textContent = 'Bu sözlerde eşleşme yok.';
    lyricsLinesContainer.appendChild(empty);
  }
}

async function loadTrackLyrics(title, artist, duration, preferredSource = 'auto') {
  activeLyricsAbortController?.abort();
  activeLyricsAbortController = new AbortController();
  stopLyricsSyncAnimation();
  const requestId = ++lyricsRequestId;
  const controller = activeLyricsAbortController;
  const requestTimeout = setTimeout(() => controller.abort(), 9000);
  const safeSource = ['auto', 'lrclib', 'netease', 'kugou', 'genius', 'lyricsovh'].includes(preferredSource) ? preferredSource : 'auto';
  const searchInput = document.getElementById('lyricsFilterInput');
  if (searchInput) searchInput.value = '';
  parsedLyrics = [];
  lyricsHaveTimestamps = false;
  activeLyricIndex = -1;
  lyricsFetchedDuration = Number(duration) || 0;
  userLyricOffset = getStoredLyricOffset(currentTrack);
  refreshLyricOffsetDisplay();
  const offsetTrigger = document.getElementById('lyricsOffsetTriggerBtn');
  if (offsetTrigger) {
    offsetTrigger.disabled = true;
    offsetTrigger.title = 'Bu parça için zaman damgalı söz aranıyor';
  }
  document.getElementById('lyricsOffsetPopup')?.classList.remove('active');
  renderLyricsState(`“${title}” için şarkı sözleri aranıyor…`, 'loading');
  if (lyricsCurrentSourceBadge) lyricsCurrentSourceBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Kaynak aranıyor';

  const requestSource = async (source) => {
    const offlineKey = `sunify_offline_lyrics_v2_${String(artist || '').trim().toLowerCase()}_${String(title || '').trim().toLowerCase()}_${source}`;
    try {
      const params = new URLSearchParams({ title: title || '', artist: artist || '', duration: String(Number(duration) || ''), source });
      const response = await fetch(`${API_BASE}/lyrics?${params.toString()}`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Şarkı sözleri alınamadı.');
      if (data?.success && (data.syncedLyrics || data.plainLyrics)) {
        try { localStorage.setItem(offlineKey, JSON.stringify(data)); } catch {}
      }
      return data;
    } catch (err) {
      try {
        const cached = JSON.parse(localStorage.getItem(offlineKey) || 'null');
        if (cached?.success) return cached;
      } catch {}
      throw err;
    }
  };

  try {
    let data = await requestSource(safeSource);
    if (!data.success && safeSource !== 'auto') data = await requestSource('auto');
    if (requestId !== lyricsRequestId) return;

    const synced = String(data.syncedLyrics || '').trim();
    const plain = String(data.plainLyrics || '').trim();
    if (data.success && synced) {
      parsedLyrics = parseLRCWithWordTiming(synced, Number(duration) || audio.duration || 0);
      if (parsedLyrics.length) {
        lyricsHaveTimestamps = true;
        renderSyncedLyrics(parsedLyrics);
        startLyricsSyncAnimation();
      }
      else if (plain) {
        renderPlainLyrics(plain);
      }
      else renderLyricsState('Söz bulundu ancak biçimi okunamadı.', 'error', true);
    } else if (data.success && plain) {
      renderPlainLyrics(plain);
    } else {
      renderLyricsState('Bu şarkı için söz bulunamadı. Otomatik aramayı veya başka bir kaynağı deneyebilirsin.', 'empty');
    }
    if (lyricsCurrentSourceBadge) {
      const plainOnly = Boolean(data.success && !lyricsHaveTimestamps && plain);
      const sourceName = plainOnly ? String(data.source || 'Şarkı sözleri').replace('(Senkron)', '(Düz)') : data.source;
      const gapHint = lyricsHaveTimestamps && Number(data.durationGap) > 2.5 ? ` · ~${Math.round(data.durationGap)} sn süre farkı` : '';
      const sourceLabel = `${sourceName || (data.success ? 'Şarkı sözleri' : 'Sonuç yok')}${plainOnly ? ' · Zaman damgası yok' : ''}${gapHint}`;
      lyricsCurrentSourceBadge.innerHTML = `<i class="fa-solid ${data.success ? 'fa-circle-check' : 'fa-circle-info'}"></i> ${sourceLabel}`;
    }
    if (offsetTrigger) {
      offsetTrigger.disabled = !lyricsHaveTimestamps;
      offsetTrigger.title = lyricsHaveTimestamps
        ? 'Söz gecikmesini ayarla. Pozitif değer sözleri geciktirir.'
        : 'Bu kaynak zaman damgası içermiyor; söz gecikmesi kullanılamaz.';
    }
    applyLyricsFilter();
  } catch (error) {
    if (requestId !== lyricsRequestId) return;
    if (controller.signal.aborted) {
      renderLyricsState('Söz araması zaman aşımına uğradı. Yeniden deneyebilirsin.', 'error', true);
    } else {
      renderLyricsState(`Sözler yüklenemedi: ${error.message}`, 'error', true);
    }
    if (lyricsCurrentSourceBadge) lyricsCurrentSourceBadge.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Bağlantı sorunu';
  } finally {
    clearTimeout(requestTimeout);
    if (activeLyricsAbortController === controller) activeLyricsAbortController = null;
  }
}

let renderedLyricLines = [];
let renderedInstrumentalGaps = [];
let activeInstrumentalGap = null;
let completedInstrumentalGapCount = 0;
let lastInstrumentalSyncTime = -Infinity;
let activeLyricWordIndex = -1;

function renderSyncedLyrics(lyrics) {
  lyricsLinesContainer.innerHTML = '';
  renderedLyricLines = [];
  renderedInstrumentalGaps = [];
  activeInstrumentalGap = null;
  completedInstrumentalGapCount = 0;
  lastInstrumentalSyncTime = -Infinity;
  activeLyricWordIndex = -1;
  activeLyricIndex = -1;
  if (lyrics[0]?.time >= 1.35) {
    lyricsLinesContainer.appendChild(createLyricInstrumentalGap(0, lyrics[0].time));
  }
  lyrics.forEach((item) => {
    const p = document.createElement('p');
    p.className = 'lyric-line';
    p.id = item.id;
    const wordElements = [];

    item.words.forEach((wObj) => {
      const span = document.createElement('span');
      span.className = 'lyric-word';
      span.id = wObj.id;
      span.textContent = wObj.word;
      p.appendChild(span);
      p.appendChild(document.createTextNode(' '));
      wordElements.push(span);
    });

    p.onclick = () => {
      seekAudioTo(item.time);
    };
    lyricsLinesContainer.appendChild(p);
    renderedLyricLines.push({ element: p, words: wordElements });

    if (item.instrumentalDuration >= 1.35) {
      lyricsLinesContainer.appendChild(createLyricInstrumentalGap(item.instrumentalStart, item.instrumentalEnd));
    }
  });
  updateLyricInstrumentalGaps(getLyricsSyncTime(audio.currentTime || 0));
}

function createLyricInstrumentalGap(start, end) {
  const note = document.createElement('div');
  note.className = 'lyric-instrumental-gap';
  note.dataset.gapStart = String(start);
  note.dataset.gapEnd = String(end);
  note.setAttribute('aria-label', 'Müzik aralığı');
  note.innerHTML = '<span class="lyric-note-base"><i class="fa-solid fa-music"></i></span><span class="lyric-note-fill"><i class="fa-solid fa-music"></i></span>';
  renderedInstrumentalGaps.push({ element: note, start, end });
  return note;
}

function updateLyricInstrumentalGaps(currentTime) {
  if (!renderedInstrumentalGaps.length) return;

  if (currentTime < lastInstrumentalSyncTime) {
    let low = 0;
    let high = renderedInstrumentalGaps.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (renderedInstrumentalGaps[middle].end <= currentTime) low = middle + 1;
      else high = middle;
    }
    const nextCompletedCount = low;
    for (let index = Math.min(completedInstrumentalGapCount, nextCompletedCount); index < Math.max(completedInstrumentalGapCount, nextCompletedCount); index += 1) {
      renderedInstrumentalGaps[index].element.classList.toggle('complete', index < nextCompletedCount);
    }
    completedInstrumentalGapCount = nextCompletedCount;
  } else {
    while (completedInstrumentalGapCount < renderedInstrumentalGaps.length
      && renderedInstrumentalGaps[completedInstrumentalGapCount].end <= currentTime) {
      renderedInstrumentalGaps[completedInstrumentalGapCount].element.classList.add('complete');
      completedInstrumentalGapCount += 1;
    }
  }

  const candidate = renderedInstrumentalGaps[completedInstrumentalGapCount];
  const nextActiveGap = candidate && currentTime >= candidate.start && currentTime < candidate.end ? candidate.element : null;
  if (activeInstrumentalGap !== nextActiveGap) {
    activeInstrumentalGap?.classList.remove('active');
    activeInstrumentalGap = nextActiveGap;
    if (activeInstrumentalGap) {
      activeInstrumentalGap.classList.add('active');
      // Şarkının başındaki intro boşluğunda (start === 0) sözleri aşağı kaydırma, en üstte kalsın
      if (candidate && candidate.start > 0) {
        const container = lyricsLinesContainer;
        const containerRect = container.getBoundingClientRect();
        const noteRect = activeInstrumentalGap.getBoundingClientRect();
        const target = container.scrollTop + noteRect.top - containerRect.top - container.clientHeight * 0.5;
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTo({ top: Math.max(0, Math.min(maxScroll, target)), behavior: 'smooth' });
      }
    }
  }

  if (activeInstrumentalGap && candidate) {
    const duration = Math.max(0.001, candidate.end - candidate.start);
    const progress = Math.max(0, Math.min(1, (currentTime - candidate.start) / duration));
    activeInstrumentalGap.style.setProperty('--note-progress', `${progress * 100}%`);
  }
  lastInstrumentalSyncTime = currentTime;
}

function renderPlainLyrics(plainText) {
  lyricsLinesContainer.innerHTML = '';
  renderedLyricLines = [];
  renderedInstrumentalGaps = [];
  activeInstrumentalGap = null;
  completedInstrumentalGapCount = 0;
  lastInstrumentalSyncTime = -Infinity;
  activeLyricWordIndex = -1;
  activeLyricIndex = -1;
  const lines = plainText.split('\n');
  lines.forEach((line) => {
    const p = document.createElement('p');
    p.className = 'lyric-line';
    p.style.color = '#fff';
    p.textContent = line || ' ';
    lyricsLinesContainer.appendChild(p);
  });
}

// 10. KELİME KELİME SENKRONİZE ANİMASYON (HASSAS METRONOM SENKRONİZASYONU & KULLANICI GECİKME AYARI)
let activeLyricIndex = -1;
let lyricsFetchedDuration = 0;
let lyricsRefetchedForDuration = false;
let userLyricOffset = 0; // Saniye cinsinden gecikme (+ / -). Artık her şarkı için ayrı saklanır.
let refreshLyricOffsetDisplay = () => {};
const lyricOffsetKey = (track) => `${String(track?.artist || '').trim().toLowerCase()}|${String(track?.title || '').trim().toLowerCase()}`;
function readLyricOffsets() {
  try { return JSON.parse(localStorage.getItem('sunify_lyric_offsets') || '{}') || {}; } catch { return {}; }
}
function getStoredLyricOffset(track) {
  const value = Number(readLyricOffsets()[lyricOffsetKey(track)]);
  return Number.isFinite(value) ? value : 0;
}
function saveLyricOffset(track, value) {
  if (!track || !track.title) return;
  const offsets = readLyricOffsets();
  const key = lyricOffsetKey(track);
  if (!value) delete offsets[key]; else offsets[key] = value;
  const keys = Object.keys(offsets);
  if (keys.length > 400) keys.slice(0, keys.length - 400).forEach((old) => delete offsets[old]);
  try { localStorage.setItem('sunify_lyric_offsets', JSON.stringify(offsets)); } catch {}
}

async function showRuntimeDiagnostics() {
  try {
    const response = await fetch(`${API_BASE}/diagnostics`);
    const result = await response.json();
    if (!result.pythonAudio?.ytDlp) {
      showAppNotification(
        'Ses motoru kurulumu gerekli',
        result.pythonAudio?.bundled
          ? 'Yerleşik YouTube ses bileşenleri başlatılamadı. Sunify kurulumunu onarın veya yeniden kurun.'
          : result.pythonAudio?.python
            ? 'yt-dlp eksik. Geliştirme sürümünde npm run setup:python çalıştırın.'
            : 'Ses bileşenleri bulunamadı. Sunify kurulumunu onarın veya yeniden kurun.',
        true
      );
    }
  } catch (error) {
    console.error('Sunify tanılama isteği başarısız:', error);
  }
}

async function chooseMusicFolders() {
  if (!window.sunifyAPI?.chooseMusicFolders) return;
  try {
    const folders = await window.sunifyAPI.chooseMusicFolders();
    if (!folders.length) return;
    const response = await fetch(`${API_BASE}/library/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Klasörler kaydedilemedi.');
    showAppNotification('Müzik klasörleri eklendi', `${result.folders} klasör kütüphaneye bağlandı.`);
    await loadLocalDownloadedTracks();
  } catch (error) {
    showAppNotification('Klasör seçimi başarısız', error.message, true);
  }
}
const LYRIC_TIMING_OFFSET = 0; // Kullanıcı ofseti dışında yapay gecikme uygulama.
function getLyricsSyncTime(rawTime) {
  // Pozitif değer sözleri geciktirir; negatif değer sözleri erkene alır.
  return rawTime + LYRIC_TIMING_OFFSET - userLyricOffset;
}

function syncActiveLyric(rawTime) {
  if (!parsedLyrics.length) return;

  const currentTime = getLyricsSyncTime(rawTime);
  updateLyricInstrumentalGaps(currentTime);

  let low = 0;
  let high = parsedLyrics.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (currentTime >= parsedLyrics[middle].time) low = middle + 1;
    else high = middle;
  }
  const activeIndex = low - 1;

  let activeWordIndex = -1;
  if (activeIndex >= 0) {
    const words = parsedLyrics[activeIndex].words || [];
    let wordLow = 0;
    let wordHigh = words.length;
    while (wordLow < wordHigh) {
      const middle = (wordLow + wordHigh) >>> 1;
      if (currentTime >= words[middle].startTime) wordLow = middle + 1;
      else wordHigh = middle;
    }
    activeWordIndex = wordLow - 1;
  }

  if (activeIndex !== activeLyricIndex) {
    const firstChangedLine = Math.max(0, Math.min(activeLyricIndex, activeIndex));
    const lastChangedLine = Math.min(parsedLyrics.length - 1, Math.max(activeLyricIndex, activeIndex));
    for (let index = firstChangedLine; index <= lastChangedLine; index += 1) {
      const renderedLine = renderedLyricLines[index];
      if (!renderedLine) continue;
      renderedLine.element.classList.toggle('active', index === activeIndex);
      renderedLine.element.classList.toggle('passed', activeIndex >= 0 && index < activeIndex);
      const words = parsedLyrics[index].words || [];
      renderedLine.words.forEach((wordElement, wordIndex) => {
        const word = words[wordIndex];
        const spoken = index < activeIndex || (index === activeIndex && Boolean(word && currentTime >= word.startTime));
        wordElement.classList.toggle('spoken', spoken);
      });
    }
    activeLyricIndex = activeIndex;
    activeLyricWordIndex = activeWordIndex;
    if (activeIndex < 0) {
      lyricsLinesContainer.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (activeIndex >= 0) {
      const activeEl = renderedLyricLines[activeIndex]?.element;
      if (activeEl) {
        const container = lyricsLinesContainer;
        const containerRect = container.getBoundingClientRect();
        const activeRect = activeEl.getBoundingClientRect();
        const target = container.scrollTop + activeRect.top - containerRect.top - container.clientHeight * 0.42;
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTo({ top: Math.max(0, Math.min(maxScroll, target)), behavior: 'smooth' });
      }
    }
    return;
  }

  if (activeIndex >= 0 && activeWordIndex !== activeLyricWordIndex) {
    const renderedLine = renderedLyricLines[activeIndex];
    if (renderedLine) {
      const firstWord = Math.max(0, Math.min(activeLyricWordIndex, activeWordIndex) + 1);
      const lastWord = Math.min(renderedLine.words.length - 1, Math.max(activeLyricWordIndex, activeWordIndex));
      const spoken = activeWordIndex > activeLyricWordIndex;
      for (let index = firstWord; index <= lastWord; index += 1) {
        renderedLine.words[index].classList.toggle('spoken', spoken);
      }
    }
    activeLyricWordIndex = activeWordIndex;
  }
}

// 11. AUDIO KONTROLLERİ & İLERLEME ÇUBUĞU
function setupAudioEvents() {
  async function togglePlayPause() {
    if (!currentTrack) return;
    if (isResolvingPlayback) return;
    if (!audio.currentSrc || audio.networkState === HTMLMediaElement.NETWORK_EMPTY) {
      await playSelectedTrack(currentTrack, currentPlaylist, currentIndex, {
        resumePosition: playbackResumeState?.position || 0,
      });
      return;
    }
    if (audio.paused) {
      try {
        await audio.play();
      } catch (error) {
        isPlaying = false;
        updatePlayPauseIcons(false);
        showAppNotification('Şarkı devam ettirilemedi', error.message, true);
      }
    } else {
      audio.pause();
    }
  }

  playPauseBtn.onclick = togglePlayPause;
  lyricsPlayPauseBtn.onclick = togglePlayPause;

  audio.onerror = () => {
    if (!currentTrack || audio.networkState === HTMLMediaElement.NETWORK_EMPTY) return;
    if (activeAudioFallback && activeAudioFallback.sessionId === playSessionId) {
      if (activeAudioFallback.retrying) return;
      if (!activeAudioFallback.attempted) {
        const fallback = activeAudioFallback;
        void retryTrackWithAlternateSource(fallback).then((recovered) => {
          if (recovered || fallback.sessionId !== playSessionId || isResolvingPlayback) return;
          isPlaying = false;
          updatePlayPauseIcons(false);
          currentArtist.textContent = 'Ses akışı kesildi';
          publishMiniPlayerState();
          showAppNotification('Şarkı çalınamadı', 'İlk ses kaynağı açılamadı ve alternatif eşleşme de kullanılamadı.', true);
        });
        return;
      }
    }
    if (isResolvingPlayback) return;
    isPlaying = false;
    updatePlayPauseIcons(false);
    currentArtist.textContent = 'Ses akışı kesildi';
    publishMiniPlayerState();
    const mediaErrorCode = audio.error?.code || 0;
    const mediaErrorMessage = mediaErrorCode === 2
      ? 'Ses akışında ağ hatası oluştu.'
      : mediaErrorCode === 3
        ? 'Ses dosyası çözümlenemedi.'
        : mediaErrorCode === 4
          ? 'Bu parça için oynatılabilir ses kaynağı bulunamadı.'
          : 'Ses akışı kesildi.';
    console.error('[audio-media-error]', { code: mediaErrorCode, message: mediaErrorMessage, source: audio.currentSrc });
    showAppNotification('Şarkı çalınamadı', mediaErrorMessage, true);
  };

  // Discord RPC Oynatma / Duraklatma / Sarma olayları
  audio.onplay = () => {
    isPlaying = true;
    updatePlayPauseIcons(true);
    updateNowPlayingVisuals();
    publishMiniPlayerState();
    startLyricsSyncAnimation();
    if (currentTrack) {
      syncDiscordRPC(
        currentTrack,
        audio.currentTime,
        audio.duration || currentTrack.duration,
        true
      );
    }
  };

  audio.onpause = () => {
    if (suppressPauseSideEffects) return;
    stopLyricsSyncAnimation();
    isPlaying = false;
    persistPlaybackResumeState(audio.currentTime || 0);
    updatePlayPauseIcons(false);
    updateNowPlayingVisuals();
    publishMiniPlayerState();
    if (currentTrack) {
      syncDiscordRPC(
        currentTrack,
        audio.currentTime,
        audio.duration || currentTrack.duration,
        false
      );
    }
  };

  audio.onseeked = () => {
    if (lyricsOverlay?.classList.contains('active')) syncActiveLyric(audio.currentTime || 0);
    if (currentTrack) {
      syncDiscordRPC(
        currentTrack,
        audio.currentTime,
        audio.duration || currentTrack.duration,
        !audio.paused
      );
    }
  };

  // Karıştır / Tekrarla: durum sınıfla gösterilir, kalıcıdır (yeniden açınca hatırlanır).
  const lyricsShuffleBtn = document.getElementById('lyricsShuffleBtn');
  const lyricsRepeatBtn = document.getElementById('lyricsRepeatBtn');
  const REPEAT_LABELS = { off: 'Tekrarla: kapalı', all: 'Tekrarla: tüm liste', one: 'Tekrarla: tek şarkı' };

  function paintPlaybackModes() {
    [shuffleBtn, lyricsShuffleBtn].forEach((button) => {
      if (!button) return;
      button.classList.toggle('is-active', isShuffle);
      button.setAttribute('aria-pressed', String(isShuffle));
      button.title = isShuffle ? 'Karıştır: açık' : 'Karıştır: kapalı';
    });
    [repeatBtn, lyricsRepeatBtn].forEach((button) => {
      if (!button) return;
      button.classList.toggle('is-active', repeatMode !== 'off');
      button.dataset.repeat = repeatMode;
      button.setAttribute('aria-pressed', String(repeatMode !== 'off'));
      button.title = REPEAT_LABELS[repeatMode];
    });
    audio.loop = repeatMode === 'one';
  }

  shuffleBtn.onclick = () => {
    isShuffle = !isShuffle;
    shuffleHistory = [];
    try { localStorage.setItem('sunify_shuffle', isShuffle ? '1' : '0'); } catch {}
    paintPlaybackModes();
    showAppNotification('Karıştır', isShuffle ? 'Açık: sıradaki şarkı rastgele seçilecek.' : 'Kapalı.');
  };
  if (lyricsShuffleBtn) lyricsShuffleBtn.onclick = () => shuffleBtn.click();

  repeatBtn.onclick = () => {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    try { localStorage.setItem('sunify_repeat', repeatMode); } catch {}
    paintPlaybackModes();
    showAppNotification('Tekrarla', repeatMode === 'off' ? 'Kapalı.' : repeatMode === 'all' ? 'Tüm liste bitince baştan başlar.' : 'Bu şarkı tekrar tekrar çalar.');
  };
  if (lyricsRepeatBtn) lyricsRepeatBtn.onclick = () => repeatBtn.click();

  try {
    isShuffle = localStorage.getItem('sunify_shuffle') === '1';
    const savedRepeat = localStorage.getItem('sunify_repeat');
    repeatMode = ['off', 'all', 'one'].includes(savedRepeat) ? savedRepeat : 'off';
  } catch {}
  paintPlaybackModes();

  queueBtn.onclick = () => {
    const drawer = document.getElementById('queueDrawer');
    const open = drawer?.classList.toggle('open') ?? false;
    drawer?.setAttribute('aria-hidden', String(!open));
    if (open) renderQueueDrawer();
  };

  const equalizerBtn = document.getElementById('equalizerBtn');
  const equalizerPopover = document.getElementById('equalizerPopover');
  const audioOutputBtn = document.getElementById('audioOutputBtn');
  const audioOutputPopover = document.getElementById('audioOutputPopover');
  const audioOutputTrigger = document.getElementById('audioOutputTrigger');
  const audioOutputOptions = document.getElementById('audioOutputOptions');
  // Render the device list in a top-level layer so the player's transforms and clipping
  // cannot squeeze the labels or turn the icons into oversized circles.
  const audioOutputPicker = document.getElementById('audioOutputPicker');
  if (audioOutputOptions && audioOutputPicker && audioOutputOptions.parentElement !== audioOutputPicker) {
    audioOutputPicker.appendChild(audioOutputOptions);
  }
  // These controls live in the bottom player, whose glass/overflow layers clip popovers.
  // Portal them to the document root and position them against their trigger buttons.
  if (equalizerPopover && equalizerPopover.parentElement !== document.body) document.body.appendChild(equalizerPopover);
  if (audioOutputPopover && audioOutputPopover.parentElement !== document.body) document.body.appendChild(audioOutputPopover);
  if (audioOutputOptions && audioOutputOptions.parentElement !== document.body) document.body.appendChild(audioOutputOptions);
  const playerVolumePopover = document.getElementById('playerVolumePopover');
  if (playerVolumePopover && playerVolumePopover.parentElement !== document.body) document.body.appendChild(playerVolumePopover);
  const audioOutputSelectedLabel = document.getElementById('audioOutputSelectedLabel');
  const audioOutputStatus = document.getElementById('audioOutputStatus');
  const equalizerStatus = document.getElementById('equalizerStatus');
  applyEqualizerGains(equalizerGains);

  function positionEqualizerPopover() {
    if (!equalizerBtn || !equalizerPopover) return;
    const rect = equalizerBtn.getBoundingClientRect();
    const panelHeight = equalizerPopover.getBoundingClientRect().height || 260;
    equalizerPopover.style.left = `${Math.max(8, Math.min(window.innerWidth - 326, rect.left + rect.width / 2 - 155))}px`;
    equalizerPopover.style.top = `${Math.max(8, rect.top - panelHeight - 12)}px`;
    equalizerPopover.style.right = 'auto';
    equalizerPopover.style.bottom = 'auto';
  }

  if (equalizerBtn) {
    equalizerBtn.onclick = async (event) => {
      event.stopPropagation();
      const open = !equalizerPopover?.classList.contains('open');
      equalizerPopover?.classList.toggle('open', open);
      equalizerBtn.setAttribute('aria-expanded', String(open));
      if (open) {
        audioOutputPopover?.classList.remove('open');
        audioOutputOptions?.classList.remove('open');
        audioOutputBtn?.setAttribute('aria-expanded', 'false');
        audioOutputTrigger?.setAttribute('aria-expanded', 'false');
        positionEqualizerPopover();
        try {
          initializeAudioEqualizer();
          await audioContext.resume();
          if (equalizerStatus) equalizerStatus.textContent = 'Filtreler canlı sese uygulanıyor.';
        } catch (error) {
          equalizerPopover?.classList.remove('open');
          equalizerBtn.setAttribute('aria-expanded', 'false');
          showAppNotification('Ekolayzer açılamadı', error.message, true);
        }
      }
    };
  }

  document.querySelectorAll('[data-eq-band]').forEach((slider) => {
    slider.addEventListener('input', async () => {
      const next = [...equalizerGains];
      next[Number(slider.dataset.eqBand)] = Number(slider.value);
      try {
        initializeAudioEqualizer();
        await audioContext.resume();
        await applyEqualizerGains(next);
        if (equalizerStatus) equalizerStatus.textContent = 'Özel ekolayzer ayarları uygulanıyor.';
      } catch (error) { showAppNotification('Ekolayzer uygulanamadı', error.message, true); }
    });
  });

  document.querySelectorAll('[data-eq-preset]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        initializeAudioEqualizer();
        await audioContext.resume();
        await applyEqualizerGains(EQ_PRESETS[button.dataset.eqPreset]);
        if (equalizerStatus) equalizerStatus.textContent = `${button.textContent.trim()} profili canlı sese uygulanıyor.`;
      } catch (error) { showAppNotification('Ekolayzer uygulanamadı', error.message, true); }
    });
  });

  document.querySelectorAll('[data-close-audio-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById(button.dataset.closeAudioTool)?.classList.remove('open');
      if (button.dataset.closeAudioTool === 'equalizerPopover') {
        equalizerBtn?.setAttribute('aria-expanded', 'false');
      }
      if (button.dataset.closeAudioTool === 'audioOutputPopover') {
        audioOutputOptions?.classList.remove('open');
        audioOutputTrigger?.setAttribute('aria-expanded', 'false');
        audioOutputBtn?.setAttribute('aria-expanded', 'false');
      }
    });
  });
  document.addEventListener('click', (event) => {
    if (!equalizerBtn?.contains(event.target) && !equalizerPopover?.contains(event.target)) {
      equalizerPopover?.classList.remove('open');
      equalizerBtn?.setAttribute('aria-expanded', 'false');
    }
    if (!audioOutputBtn?.contains(event.target) && !audioOutputPopover?.contains(event.target) && !audioOutputOptions?.contains(event.target)) {
      audioOutputPopover?.classList.remove('open');
      audioOutputOptions?.classList.remove('open');
      audioOutputBtn?.setAttribute('aria-expanded', 'false');
      audioOutputTrigger?.setAttribute('aria-expanded', 'false');
    }
  });

  async function refreshAudioOutputDevices() {
    if (!audioOutputOptions || !audioOutputStatus) return;
    const supportsOutputRouting = typeof audio.setSinkId === 'function'
      || typeof (window.AudioContext || window.webkitAudioContext)?.prototype?.setSinkId === 'function';
    if (!supportsOutputRouting || !navigator.mediaDevices?.enumerateDevices) {
      audioOutputTrigger.disabled = true;
      audioOutputStatus.textContent = 'Bu Electron sürümü ses çıkış aygıtı seçimini desteklemiyor.';
      return;
    }
    try {
      const savedId = localStorage.getItem('sunify_audio_output_id') || 'default';
      let selectedId = savedId;
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audiooutput');
      const friendlyName = (device, index) => {
        const label = String(device.label || '').trim();
        if (label) return label;
        const id = String(device.deviceId || '').toLowerCase();
        if (id === 'default') return 'Varsayılan aygıt';
        if (/communications|comm/.test(id)) return 'İletişim aygıtı';
        return `Ses çıkışı ${index + 1}`;
      };
      const choices = [{ id: 'default', label: 'Varsayılan aygıt', icon: 'fa-volume-high' }, ...devices.filter((device) => device.deviceId && device.deviceId !== 'default').map((device, index) => ({
        id: device.deviceId || 'default',
        label: friendlyName(device, index),
        icon: /head(phone|set)|kulaklık|ear(phone|bud)/i.test(device.label || '') ? 'fa-headphones' : 'fa-volume-high',
      })).filter((device, index, list) => list.findIndex((candidate) => candidate.id === device.id) === index)];
      if (!choices.some((choice) => choice.id === selectedId)) {
        selectedId = 'default';
        localStorage.setItem('sunify_audio_output_id', 'default');
        if (audioContext && typeof audioContext.setSinkId === 'function') await audioContext.setSinkId('default');
        else if (typeof audio.setSinkId === 'function') await audio.setSinkId('default');
      }
      audioOutputOptions.replaceChildren(...choices.map((choice) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'output-device-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(choice.id === selectedId));
        option.dataset.deviceId = choice.id;
        const icon = document.createElement('i');
        icon.className = `fa-solid ${choice.icon}`;
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'output-device-name';
        label.textContent = choice.label;
        const check = document.createElement('i');
        check.className = 'fa-solid fa-check output-device-check';
        check.setAttribute('aria-hidden', 'true');
        option.append(icon, label, check);
        option.addEventListener('click', () => selectAudioOutput(choice.id, choice.label));
        return option;
      }));
      // Keep the system default selectable even if Chromium hides device labels until permission is granted.
      audioOutputTrigger.disabled = false;
      const selectedChoice = choices.find((choice) => choice.id === selectedId) || choices[0];
      audioOutputSelectedLabel.textContent = selectedChoice.label;
      if (selectedId !== 'default') {
        if (audioContext && typeof audioContext.setSinkId === 'function') await audioContext.setSinkId(selectedId);
        else if (typeof audio.setSinkId === 'function') await audio.setSinkId(selectedId);
      }
      audioOutputStatus.textContent = devices.length ? 'Seçim anında uygulanır.' : 'Ses çıkış aygıtı bulunamadı.';
    } catch (error) {
      audioOutputTrigger.disabled = true;
      audioOutputStatus.textContent = `Aygıt listesi alınamadı: ${error.message}`;
    }
  }
  async function selectAudioOutput(deviceId, label) {
    try {
      // Respect the playback preference when the user explicitly switches output.
      if (localStorage.getItem('sunify_setting_pause_device_change') === 'true' && isPlaying) {
        audio.pause();
      }
      if (audioContext && typeof audioContext.setSinkId === 'function') await audioContext.setSinkId(deviceId);
      else if (typeof audio.setSinkId === 'function') await audio.setSinkId(deviceId);
      else throw new Error('Bu ses motoru çıkış aygıtı değiştirmeyi desteklemiyor.');
      localStorage.setItem('sunify_audio_output_id', deviceId || 'default');
      audioOutputSelectedLabel.textContent = label;
      audioOutputOptions.querySelectorAll('.output-device-option').forEach((option) => {
        option.setAttribute('aria-selected', String(option.dataset.deviceId === (deviceId || 'default')));
      });
      audioOutputStatus.textContent = `Ses ${label.toLocaleLowerCase('tr-TR')} aygıtına yönlendiriliyor.`;
      audioOutputOptions.classList.remove('open');
      audioOutputTrigger?.setAttribute('aria-expanded', 'false');
    } catch (error) {
      audioOutputStatus.textContent = `Aygıt seçilemedi: ${error.message}`;
      showAppNotification('Ses çıkışı değiştirilemedi', error.message, true);
    }
  }
  function positionAudioOutputOptions() {
    if (!audioOutputOptions || !audioOutputTrigger) return;
    const rect = audioOutputTrigger.getBoundingClientRect();
    const maxHeight = Math.min(240, window.innerHeight * 0.36);
    const popupHeight = Math.min(audioOutputOptions.scrollHeight, maxHeight);
    const spaceAbove = rect.top - 16;
    const spaceBelow = window.innerHeight - rect.bottom - 16;
    const placeAbove = spaceAbove >= popupHeight + 8 || spaceAbove >= spaceBelow;
    const desiredTop = placeAbove ? rect.top - popupHeight - 8 : rect.bottom + 8;
    audioOutputOptions.style.left = `${Math.max(8, Math.min(window.innerWidth - 308, rect.left + rect.width / 2 - 150))}px`;
    audioOutputOptions.style.top = `${Math.max(8, Math.min(window.innerHeight - popupHeight - 8, desiredTop))}px`;
    audioOutputOptions.style.bottom = 'auto';
  }
  audioOutputBtn?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const open = !audioOutputPopover?.classList.contains('open');
    audioOutputPopover?.classList.toggle('open', open);
    audioOutputBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      await refreshAudioOutputDevices();
      const rect = audioOutputBtn.getBoundingClientRect();
      const panelHeight = audioOutputPopover.getBoundingClientRect().height;
      audioOutputPopover.style.left = `${Math.max(8, Math.min(window.innerWidth - 326, rect.left + rect.width / 2 - 155))}px`;
      audioOutputPopover.style.top = `${Math.max(8, rect.top - panelHeight - 12)}px`;
      audioOutputPopover.style.right = 'auto';
      audioOutputPopover.style.bottom = 'auto';
      audioOutputOptions?.classList.remove('open');
      audioOutputTrigger?.setAttribute('aria-expanded', 'false');
    } else {
      audioOutputOptions?.classList.remove('open');
      audioOutputTrigger?.setAttribute('aria-expanded', 'false');
    }
  });
  audioOutputTrigger?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const open = !audioOutputOptions.classList.contains('open');
    if (open) await refreshAudioOutputDevices();
    audioOutputOptions?.classList.toggle('open', open);
    audioOutputTrigger.setAttribute('aria-expanded', String(open));
    if (open) positionAudioOutputOptions();
  });
  audioOutputOptions?.addEventListener('click', (event) => event.stopPropagation());
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioOutputDevices);
  void refreshAudioOutputDevices();

  const volumeIconBtn = document.getElementById('volumeIconBtn');
  const volumeIcon = document.getElementById('volumeIcon');
  const playerVolumeWrap = document.getElementById('playerVolumeWrap');
  const volumePercent = document.getElementById('volumePercent');
  function positionVolumePopover() {
    if (!volumeIconBtn || !playerVolumePopover) return;
    const rect = volumeIconBtn.getBoundingClientRect();
    playerVolumePopover.style.left = `${Math.max(8, Math.min(window.innerWidth - 64, rect.left + rect.width / 2 - 22))}px`;
    playerVolumePopover.style.right = 'auto';
    playerVolumePopover.style.top = `${Math.max(8, rect.top - playerVolumePopover.offsetHeight - 10)}px`;
    playerVolumePopover.style.bottom = 'auto';
  }
  if (volumeIconBtn) {
    volumeIconBtn.onclick = () => {
      const open = playerVolumeWrap?.classList.toggle('open') ?? false;
      playerVolumePopover?.classList.toggle('open', open);
      volumeIconBtn.setAttribute('aria-expanded', String(open));
      if (open) positionVolumePopover();
    };
  }
  window.addEventListener('resize', () => {
    if (equalizerPopover?.classList.contains('open')) positionEqualizerPopover();
    if (audioOutputPopover?.classList.contains('open') && audioOutputBtn) {
      const rect = audioOutputBtn.getBoundingClientRect();
      const panelHeight = audioOutputPopover.getBoundingClientRect().height;
      audioOutputPopover.style.left = `${Math.max(8, Math.min(window.innerWidth - 326, rect.left + rect.width / 2 - 155))}px`;
      audioOutputPopover.style.top = `${Math.max(8, rect.top - panelHeight - 12)}px`;
    }
    if (audioOutputOptions?.classList.contains('open')) positionAudioOutputOptions();
    if (playerVolumePopover?.classList.contains('open')) positionVolumePopover();
  });

  function handleVolumeChange(val) {
    const parsedVolume = Number.parseFloat(val);
    const normalizedVolume = Number.isFinite(parsedVolume) ? Math.max(0, Math.min(1, parsedVolume)) : 0.8;
    audio.volume = normalizedVolume;
    volumeSlider.value = String(normalizedVolume);
    if (lyricsVolumeSlider) lyricsVolumeSlider.value = String(normalizedVolume);
    try { localStorage.setItem('sunify_volume', String(normalizedVolume)); } catch (error) {}
    const percent = Math.round(audio.volume * 100);
    if (volumePercent) volumePercent.textContent = `${percent}%`;
    if (volumeIcon) {
      volumeIcon.className = audio.volume === 0
        ? 'fa-solid fa-volume-xmark'
        : audio.volume < 0.45
          ? 'fa-solid fa-volume-low'
          : 'fa-solid fa-volume-high';
    }
  }

  volumeSlider.oninput = (e) => handleVolumeChange(e.target.value);
  window.sunifySetVolume = (value) => { handleVolumeChange(value); publishMiniPlayerState(true); };
  audio.addEventListener('volumechange', () => publishMiniPlayerState());
  let savedVolume = null;
  try {
    const storedVolume = localStorage.getItem('sunify_volume');
    if (storedVolume !== null && storedVolume.trim() !== '') {
      const parsedVolume = Number.parseFloat(storedVolume);
      if (Number.isFinite(parsedVolume)) savedVolume = Math.max(0, Math.min(1, parsedVolume));
    }
  } catch (error) {}
  handleVolumeChange(savedVolume ?? volumeSlider.value);
  document.addEventListener('pointerdown', (event) => {
    if (playerVolumeWrap && !playerVolumeWrap.contains(event.target) && !playerVolumePopover?.contains(event.target)) {
      playerVolumeWrap.classList.remove('open');
      playerVolumePopover?.classList.remove('open');
      volumeIconBtn?.setAttribute('aria-expanded', 'false');
    }
  });
  if (lyricsVolumeSlider) {
    lyricsVolumeSlider.oninput = (e) => handleVolumeChange(e.target.value);
  }

  let lastRpcSync = 0;
  let lastTrackedTime = 0;
  let lastResumeStateSavedAt = 0;
  let lastRenderedSecond = -1;
  let lastRenderedDurationSec = -1;

  audio.ontimeupdate = () => {
    const current = audio.currentTime;
    const duration = audio.duration || currentTrack?.duration || 0;
    publishMiniPlayerState();
    if (currentTrack && isPlaying && Date.now() - lastResumeStateSavedAt >= 5000) {
      lastResumeStateSavedAt = Date.now();
      persistPlaybackResumeState(current);
    }

    // Dinleme süresi farkını hesapla ve analitiğe ekle
    if (currentTrack && isPlaying && pendingSeekTarget === null) {
      if (lastTrackedTime > 0 && current > lastTrackedTime) {
        const delta = current - lastTrackedTime;
        if (delta < 2.5) {
          // Normal oynatma artışıysa kaydet
          updateTrackListeningDuration(currentTrack, delta);
          if (listenSession.track === currentTrack) listenSession.listened += delta;
        }
      }
      lastTrackedTime = current;
    }

    // Pencere simge durumundayken (alta alındığında) ana pencerenin DOM'una hiç dokunma!
    if (!isWindowMinimized && !document.hidden) {
      const durationSec = Math.floor(duration);
      if (durationSec !== lastRenderedDurationSec) {
        lastRenderedDurationSec = durationSec;
        const formattedDuration = formatTime(duration);
        durationLabel.textContent = formattedDuration;
        lyricsTotalTime.textContent = formattedDuration;
      }
      if (!seekDragging && pendingSeekTarget === null) {
        const currentSec = Math.floor(current);
        if (currentSec !== lastRenderedSecond) {
          lastRenderedSecond = currentSec;
          const formattedCurrent = formatTime(current);
          currentTimeLabel.textContent = formattedCurrent;
          lyricsCurrentTime.textContent = formattedCurrent;
        }
        const percent = duration > 0 ? (current / duration) * 100 : 0;
        progressBarFill.style.width = `${percent}%`;
        progressBarContainer.setAttribute('aria-valuenow', String(Math.round(percent)));
        if (lyricsOverlay?.classList.contains('active')) {
          lyricsProgressFill.style.width = `${percent}%`;
          if (!lyricsSyncAnimationFrame) syncActiveLyric(current);
        }
      }
    }

    maybePrefetchNextTrack(current, duration);

    // DISCORD RPC: Saniyeyi ve kalan süreyi 4 saniyede bir Discord'a aktar
    const now = Date.now();
    if (now - lastRpcSync > 4000 && currentTrack) {
      lastRpcSync = now;
      syncDiscordRPC(currentTrack, current, duration, isPlaying);
    }
  };

  // Basılı tutup sürükleyerek konum seçme (ses çubuğundaki gibi).
  let seekDragging = false;
  function seekRatio(event, container) {
    const rect = container.getBoundingClientRect();
    return rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
  }
  function paintSeek(ratio) {
    const duration = audio.duration || currentTrack?.duration || 0;
    const label = formatTime(ratio * duration);
    progressBarFill.style.width = `${ratio * 100}%`;
    if (lyricsProgressFill) lyricsProgressFill.style.width = `${ratio * 100}%`;
    currentTimeLabel.textContent = label;
    lyricsCurrentTime.textContent = label;
    if (parsedLyrics.length) syncActiveLyric(ratio * duration);
  }
  function attachSeekDrag(container, guard) {
    container.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (guard && !guard(event))) return;
      const duration = audio.duration || currentTrack?.duration || 0;
      if (!(duration > 0)) return;
      event.preventDefault();
      seekDragging = true;
      document.body.classList.add('is-seeking');
      container.classList.add('is-dragging');
      try { container.setPointerCapture(event.pointerId); } catch {}
      let ratio = seekRatio(event, container);
      paintSeek(ratio);
      const move = (moveEvent) => { ratio = seekRatio(moveEvent, container); paintSeek(ratio); };
      const end = (endEvent) => {
        container.removeEventListener('pointermove', move);
        container.removeEventListener('pointerup', end);
        container.removeEventListener('pointercancel', end);
        try { container.releasePointerCapture(endEvent.pointerId); } catch {}
        seekDragging = false;
        document.body.classList.remove('is-seeking');
        container.classList.remove('is-dragging');
        if (endEvent.type !== 'pointercancel') seekAudioTo(ratio * duration);
      };
      container.addEventListener('pointermove', move);
      container.addEventListener('pointerup', end);
      container.addEventListener('pointercancel', end);
    });
  }

  const playerCapsule = document.querySelector('.player-floating-capsule');
  if (playerCapsule) {
    attachSeekDrag(playerCapsule, (event) => !event.target.closest('button, input, a, select, label, .player-volume-popover, .audio-tool-popover'));
  }
  attachSeekDrag(lyricsProgressContainer);
  // Şarkının gerçek süresi sonradan öğrenilirse sözleri doğru sürümle yeniden eşleştir.
  audio.addEventListener('loadedmetadata', () => {
    const real = audio.duration;
    if (!currentTrack || !Number.isFinite(real) || real <= 0 || lyricsRefetchedForDuration) return;
    if (lyricsFetchedDuration > 0 && Math.abs(lyricsFetchedDuration - real) <= 3) return;
    lyricsRefetchedForDuration = true;
    loadTrackLyrics(currentTrack.title, currentTrack.artist, real);
  });
  progressBarContainer.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const duration = audio.duration || currentTrack?.duration || 0;
    if (!duration) return;
    if (e.key === 'Home') seekAudioTo(0);
    else if (e.key === 'End') seekAudioTo(duration);
    else seekAudioTo(Math.max(0, Math.min(duration, (pendingSeekTarget ?? audio.currentTime) + (e.key === 'ArrowRight' ? 5 : -5))));
  };

  prevBtn.onclick = lyricsPrevBtn.onclick = () => {
    if (!currentPlaylist.length) return;
    // İlk saniyeler geçtiyse önce şarkıyı başa sar (çoğu oynatıcı gibi).
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (isShuffle && shuffleHistory.length) {
      const previous = shuffleHistory.pop();
      const at = currentPlaylist.indexOf(previous);
      if (at >= 0) { playSelectedTrack(previous, currentPlaylist, at); return; }
    }
    if (currentIndex > 0) playSelectedTrack(currentPlaylist[currentIndex - 1], currentPlaylist, currentIndex - 1);
    else if (repeatMode === 'all') playSelectedTrack(currentPlaylist[currentPlaylist.length - 1], currentPlaylist, currentPlaylist.length - 1);
    else audio.currentTime = 0;
  };

  nextBtn.onclick = lyricsNextBtn.onclick = () => {
    playNextTrack();
  };

  audio.onended = () => {
    void loadCachedAudioTracks();
    // Dinleme sayısı: yalnızca ileri atlanmadan, gerçekten çalınan saniyeler
    // şarkının sonuna kadar biriktiyse artar ("sona atla" sayılmaz).
    const endedTrack = currentTrack;
    const endedDuration = Number(audio.duration) || Number(endedTrack?.duration) || 0;
    if (endedTrack && listenSession.track === endedTrack && !listenSession.skippedForward
      && endedDuration > 0 && listenSession.listened >= Math.max(endedDuration * 0.95, endedDuration - 4)) {
      trackSongCompletedEvent(endedTrack);
    }
    resetListenSession(endedTrack);
    if (repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    if (window.sunifyAPI && window.sunifyAPI.clearDiscordPresence) {
      window.sunifyAPI.clearDiscordPresence();
    }
    playNextTrack({ allowSimilar: true });
  };
}

function playNextTrack({ allowSimilar = false } = {}) {
  if (currentPlaylist.length === 0) return;

  const warmedNext = upcomingPrefetch;
  if (warmedNext && warmedNext.sourceTrack === currentTrack && warmedNext.sourceIndex === currentIndex && warmedNext.sourcePlaylist === currentPlaylist) {
    const index = currentPlaylist.indexOf(warmedNext.track);
    upcomingPrefetch = null;
    if (index >= 0) {
      if (isShuffle && currentTrack) {
        shuffleHistory.push(currentTrack);
        if (shuffleHistory.length > 50) shuffleHistory.shift();
      }
      playSelectedTrack(warmedNext.track, currentPlaylist, index);
      return;
    }
  }

  if (isShuffle) {
    let randIndex = currentIndex;
    if (currentPlaylist.length > 1) {
      do { randIndex = Math.floor(Math.random() * currentPlaylist.length); } while (randIndex === currentIndex);
    }
    if (currentTrack) shuffleHistory.push(currentTrack);
    if (shuffleHistory.length > 50) shuffleHistory.shift();
    playSelectedTrack(currentPlaylist[randIndex], currentPlaylist, randIndex);
  } else if (currentIndex < currentPlaylist.length - 1) {
    playSelectedTrack(currentPlaylist[currentIndex + 1], currentPlaylist, currentIndex + 1);
  } else if (repeatMode === 'all') {
    playSelectedTrack(currentPlaylist[0], currentPlaylist, 0);
  } else {
    isPlaying = false;
    updatePlayPauseIcons(false);
    if (allowSimilar && localStorage.getItem('sunify_setting_auto_similar') !== 'false' && currentTrack) {
      void playSimilarAfterQueueEnds(currentTrack, currentPlaylist);
    }
  }
}

async function playSimilarAfterQueueEnds(track, previousPlaylist) {
  try {
    const seeds = JSON.stringify([{ title: track.title, artist: track.artist || '', duration: Number(track.duration) || 0, weight: 5 }]);
    const response = await fetch(`${API_BASE}/recommendations?${new URLSearchParams({ seeds })}`, { signal: AbortSignal.timeout(25000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Benzer parçalar alınamadı.');
    const picks = filterRecommendationCandidates(data.tracks, { exclude: previousPlaylist || [], recent: recentHistory.slice(0, 5), limit: 25 });
    if (!picks.length) return;
    currentPlaylist = picks;
    currentIndex = 0;
    playSelectedTrack(picks[0], picks, 0);
    showAppNotification('Akıllı sıra', 'Sıran bitti; benzer parçalar çalmaya başladı.');
  } catch (error) {
    console.warn('Otomatik benzer parça sırası oluşturulamadı:', error.message);
  }
}

function updatePlayPauseIcons(playing) {
  const iconClass = playing ? 'fa-pause' : 'fa-play';
  playPauseIcon.className = `fa-solid ${iconClass}`;
  lyricsPlayPauseBtn.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
}

function syncDiscordRPC(track, position, duration, isPlaying) {
  // Electron masaüstünde tek yayıncı ana süreçtir. HTTP yedeğini aynı anda
  // çağırmak ikinci bir RPC istemcisi oluşturup etkinlik kartını yarıştırır.
  if (window.sunifyAPI && window.sunifyAPI.updateDiscordPresence) {
    window.sunifyAPI.updateDiscordPresence({
      title: track?.title,
      artist: track?.artist,
      thumbnail: track?.thumbnail,
      position: position || 0,
      duration: duration || track?.duration || 0,
      isPlaying: !!isPlaying,
      settings: readDiscordRpcSettings(),
    });
    return;
  }

  // Electron dışı renderer çalıştırmaları için yerel sunucu yedeği.
  fetch(`${API_BASE}/discord-rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ track, position, duration, isPlaying, settings: readDiscordRpcSettings() }),
  }).catch(() => {});
}

function readDiscordRpcSettings() {
  const readToggle = (id, fallback = true) => {
    const stored = localStorage.getItem(`sunify_rpc_${id}`);
    return stored === null ? fallback : stored === 'true';
  };
  return {
    enabled: readToggle('master'),
    format: localStorage.getItem('sunify_discord_rpc_format') || 'artist',
    timeline: readToggle('timeline'),
    artwork: readToggle('artwork'),
    artistBadge: readToggle('artistBadge'),
    showPaused: readToggle('showPaused'),
    buttonListen: readToggle('buttonListen'),
    buttonDownload: readToggle('buttonDownload'),
  };
}

// Şarkı Kapağının Baskın Rengine Göre Söz Arka Planını Güncelle
let coverColorRequestId = 0;
const coverColorCache = new Map();
let sharedColorCanvas = null;
let sharedColorCtx = null;

async function applyCoverAdaptiveColor(coverUrl) {
  if (!coverUrl) return;
  const requestId = ++coverColorRequestId;

  function setGradient(r, g, b) {
    if (requestId !== coverColorRequestId) return;
    if (!coverColorCache.has(coverUrl)) {
      if (coverColorCache.size >= 80) coverColorCache.delete(coverColorCache.keys().next().value);
      coverColorCache.set(coverUrl, [r, g, b]);
    }
    const accentHex = `#${[r, g, b].map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
    const coverAlpha = document.body.dataset.theme === 'light' ? 0.22 : 0.4;
    document.body.style.setProperty('--cover-color-solid', `rgb(${r}, ${g}, ${b})`);
    document.body.style.setProperty('--cover-color-soft', `rgba(${r}, ${g}, ${b}, 0.22)`);
    document.body.style.setProperty('--cover-accent-rgb', `${r}, ${g}, ${b}`);
    document.body.style.setProperty('--accent-color', accentHex);
    document.body.style.setProperty('--accent-strong', `color-mix(in srgb, ${accentHex} 82%, white)`);
    document.body.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.18)`);
    document.body.style.setProperty('--accent-grad', `linear-gradient(135deg, color-mix(in srgb, ${accentHex} 88%, white), color-mix(in srgb, ${accentHex} 72%, #24152d))`);
    document.body.style.setProperty('--glow-color', `rgba(${r}, ${g}, ${b}, 0.62)`);
    document.body.style.setProperty('--cta-bg', `linear-gradient(145deg, color-mix(in srgb, ${accentHex} 82%, white), color-mix(in srgb, ${accentHex} 74%, #24152d))`);
    document.body.style.setProperty('--cta-fg', '#ffffff');
    document.body.style.setProperty(
      '--cover-color',
      `rgba(${r}, ${g}, ${b}, ${coverAlpha})`
    );
    miniPlayerAccent = accentHex;
    const darkR = Math.floor(r * 0.35);
    const darkG = Math.floor(g * 0.35);
    const darkB = Math.floor(b * 0.35);
    lyricsOverlay.style.setProperty(
      'background',
      `radial-gradient(circle at 35% 30%, rgb(${r}, ${g}, ${b}) 0%, rgb(${darkR}, ${darkG}, ${darkB}) 65%, #08080a 100%)`,
      'important'
    );
    const backdrop = document.getElementById('lyricsBackdrop');
    if (backdrop) {
      backdrop.style.backgroundImage = `url("${coverUrl}")`;
    }
    publishMiniPlayerState();
  }

  // Önbellekte varsa yeni Image + Canvas oluşturmadan doğrudan uygula (sıfır RAM tahsisi)
  const cachedRgb = coverColorCache.get(coverUrl);
  if (cachedRgb) {
    setGradient(cachedRgb[0], cachedRgb[1], cachedRgb[2]);
    return;
  }

  // 1. Tarayıcı içi hızlı Canvas analizi (tek paylaşımlı 32x32 canvas)
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        if (!sharedColorCanvas) {
          sharedColorCanvas = document.createElement('canvas');
          sharedColorCanvas.width = 32;
          sharedColorCanvas.height = 32;
          sharedColorCtx = sharedColorCanvas.getContext('2d', { willReadFrequently: true });
        }
        sharedColorCtx.drawImage(img, 0, 0, 32, 32);
        const imgData = sharedColorCtx.getImageData(0, 0, 32, 32).data;
        let r = 0,
          g = 0,
          b = 0,
          count = 0;
        for (let i = 0; i < imgData.length; i += 16) {
          r += imgData[i];
          g += imgData[i + 1];
          b += imgData[i + 2];
          count++;
        }
        img.onload = null;
        img.src = '';
        if (count > 0) {
          setGradient(Math.round(r / count), Math.round(g / count), Math.round(b / count));
          return;
        }
      } catch (e) {}
    };
    img.src = coverUrl;
  } catch (err) {}

  // 2. Node.js backend desteği
  try {
    const res = await fetch(`${API_BASE}/extract-color?url=${encodeURIComponent(coverUrl)}`);
    const data = await res.json();
    if (data.rgb && Array.isArray(data.rgb)) {
      setGradient(data.rgb[0], data.rgb[1], data.rgb[2]);
    }
  } catch (err) {}
}

// 12. ŞARKI SÖZLERİNİ AÇMA / KAPATMA & SÖZ GECİKMESİ (OFFSET) & SÖZ KAYNAKLARI
function setupLyricsSync() {
  function openLyrics() {
    lyricsOverlay.classList.add('active');
    startLyricsSyncAnimation();
    if (currentTrack && currentTrack.thumbnail) {
      applyCoverAdaptiveColor(currentTrack.thumbnail);
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const activeLyric = parsedLyrics[activeLyricIndex];
      const activeEl = activeLyric && document.getElementById(activeLyric.id);
      if (!activeEl || !lyricsLinesContainer) return;
      const container = lyricsLinesContainer;
      const containerRect = container.getBoundingClientRect();
      const activeRect = activeEl.getBoundingClientRect();
      const target = container.scrollTop + activeRect.top - containerRect.top - container.clientHeight * 0.42;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTo({ top: Math.max(0, Math.min(maxScroll, target)), behavior: 'smooth' });
    }));
  }

  playerThumbWrapper.onclick = openLyrics;
  currentTitle.onclick = openLyrics;
  openLyricsBtn.onclick = openLyrics;

  closeLyricsBtn.onclick = () => {
    lyricsOverlay.classList.remove('active');
    stopLyricsSyncAnimation();
  };

  // Şarkı sözü kaynağı seçicisi
  const sourceDropdown = document.getElementById('customSourceDropdown');
  const sourceDropBtn = document.getElementById('sourceDropBtn');
  const sourceMenu = document.getElementById('sourceMenu');
  const sourceSelectedText = document.getElementById('sourceSelectedText');

  if (sourceDropBtn && sourceDropdown && sourceMenu) {
    sourceDropBtn.onclick = (e) => {
      e.stopPropagation();
      const open = sourceDropdown.classList.toggle('open');
      sourceMenu.classList.toggle('active', open);
      sourceDropBtn.setAttribute('aria-expanded', String(open));
    };

    document.addEventListener('click', (e) => {
      if (!sourceDropdown.contains(e.target)) {
        sourceDropdown.classList.remove('open');
        sourceMenu.classList.remove('active');
        sourceDropBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.querySelectorAll('#sourceMenu .source-opt').forEach((opt) => {
      opt.onclick = (e) => {
        e.stopPropagation();
        document
          .querySelectorAll('#sourceMenu .source-opt')
          .forEach((o) => o.classList.remove('active'));
        opt.classList.add('active');
        sourceSelectedText.textContent = opt.textContent.trim();
        sourceDropdown.classList.remove('open');
        sourceMenu.classList.remove('active');
        sourceDropBtn.setAttribute('aria-expanded', 'false');

        const val = opt.dataset.val;
        document.querySelectorAll('#sourceMenu .source-opt').forEach((option) => option.setAttribute('aria-selected', String(option === opt)));
        showAppNotification('Söz Kaynağı Değiştirildi', opt.textContent.trim());
        if (currentTrack) {
          loadTrackLyrics(currentTrack.title, currentTrack.artist, currentTrack.duration, val);
        }
      };
    });
  }

  // SÖZ SENKRONİZASYON GECİKMESİ POPUP ELEMANLARI
  const offsetTriggerBtn = document.getElementById('lyricsOffsetTriggerBtn');
  const offsetPopup = document.getElementById('lyricsOffsetPopup');
  const offsetPopupCloseBtn = document.getElementById('offsetPopupCloseBtn');
  const offsetValText = document.getElementById('offsetValText');
  const lyricsOffsetLabel = document.getElementById('lyricsOffsetLabel');
  const offsetMinusStepBtn = document.getElementById('offsetMinusStepBtn');
  const offsetPlusStepBtn = document.getElementById('offsetPlusStepBtn');
  const offsetResetBtn = document.getElementById('offsetResetBtn');

  function updateOffsetDisplay() {
    userLyricOffset = Math.max(-10, Math.min(10, Math.round((Number(userLyricOffset) || 0) * 10) / 10));
    const formatted = `${userLyricOffset >= 0 ? '+' : ''}${userLyricOffset.toFixed(1)}s`;
    if (lyricsOffsetLabel) lyricsOffsetLabel.textContent = formatted;
    if (offsetValText) offsetValText.textContent = formatted;
    saveLyricOffset(currentTrack, userLyricOffset);
    if (offsetTriggerBtn) {
      offsetTriggerBtn.disabled = !lyricsHaveTimestamps;
      offsetTriggerBtn.title = lyricsHaveTimestamps
        ? 'Söz gecikmesini ayarla. Pozitif değer sözleri geciktirir.'
        : 'Bu kaynak zaman damgası içermiyor; söz gecikmesi kullanılamaz.';
    }
    if (parsedLyrics.length) syncActiveLyric(audio.currentTime || 0);
  }

  refreshLyricOffsetDisplay = updateOffsetDisplay;
  updateOffsetDisplay();

  if (offsetTriggerBtn && offsetPopup) {
    offsetTriggerBtn.onclick = (e) => {
      e.stopPropagation();
      offsetPopup.classList.toggle('active');
    };

    if (offsetPopupCloseBtn) {
      offsetPopupCloseBtn.onclick = (e) => {
        e.stopPropagation();
        offsetPopup.classList.remove('active');
      };
    }

    document.addEventListener('click', (e) => {
      if (offsetPopup && !offsetPopup.contains(e.target) && e.target !== offsetTriggerBtn) {
        offsetPopup.classList.remove('active');
      }
    });

    if (offsetMinusStepBtn) {
      offsetMinusStepBtn.onclick = (e) => {
        e.stopPropagation();
        userLyricOffset = Math.round((userLyricOffset - 0.1) * 10) / 10;
        updateOffsetDisplay();
      };
    }

    if (offsetPlusStepBtn) {
      offsetPlusStepBtn.onclick = (e) => {
        e.stopPropagation();
        userLyricOffset = Math.round((userLyricOffset + 0.1) * 10) / 10;
        updateOffsetDisplay();
      };
    }

    if (offsetResetBtn) {
      offsetResetBtn.onclick = (e) => {
        e.stopPropagation();
        userLyricOffset = 0.0;
        updateOffsetDisplay();
        showAppNotification(
          'Gecikme Sıfırlandı',
          'Söz senkronizasyonu varsayılan değere getirildi (0.0s).'
        );
      };
    }

    document.querySelectorAll('.offset-pill-btn').forEach((pill) => {
      pill.onclick = (e) => {
        e.stopPropagation();
        const delta = parseFloat(pill.dataset.offset || '0');
        userLyricOffset = Math.round((userLyricOffset + delta) * 10) / 10;
        updateOffsetDisplay();
      };
    });
  }
}

// 13. AYARLAR MODALI
let settingsCloseTimer = null;
function openSettingsWindow() {
  clearTimeout(settingsCloseTimer);
  viewSettings.classList.remove('closing');
  viewSettings.classList.add('active');
}

function closeSettingsWindow() {
  if (!viewSettings.classList.contains('active') || viewSettings.classList.contains('closing')) return;
  viewSettings.classList.add('closing');
  settingsCloseTimer = setTimeout(() => {
    viewSettings.classList.remove('active', 'closing');
  }, 220);
}

function setupMiniPlayerSettings() {
  const enabled = document.getElementById('settingOverlayEnabled');
  const onMinimize = document.getElementById('settingOverlayOnMinimize');
  const alwaysOnTop = document.getElementById('settingOverlayAlwaysOnTop');
  const opacity = document.getElementById('settingOverlayOpacity');
  const opacityValue = document.getElementById('settingOverlayOpacityValue');
  const positionGroup = document.getElementById('settingOverlayPos');
  const sizeGroup = document.getElementById('settingOverlaySize');
  if (!enabled || !onMinimize || !alwaysOnTop) return;

  enabled.checked = localStorage.getItem('sunify_setting_overlay_enabled') !== 'false';
  onMinimize.checked = localStorage.getItem('sunify_setting_overlay_on_minimize') !== 'false';
  alwaysOnTop.checked = localStorage.getItem('sunify_setting_overlay_always_on_top') !== 'false';
  const savedOpacity = Math.max(35, Math.min(100, Number(localStorage.getItem('sunify_setting_overlay_opacity')) || 88));
  if (opacity) opacity.value = String(savedOpacity);
  if (opacityValue) opacityValue.value = `${savedOpacity}%`;
  const position = localStorage.getItem('sunify_setting_overlay_pos') || 'top-center';
  const size = localStorage.getItem('sunify_setting_overlay_size') || 'medium';
  positionGroup?.querySelectorAll('.pill-btn').forEach((button) => button.classList.toggle('active', button.dataset.val === position));
  sizeGroup?.querySelectorAll('.pill-btn').forEach((button) => button.classList.toggle('active', button.dataset.val === size));

  const publish = () => window.sunifyAPI?.updateMiniPlayerSettings?.({
    enabled: enabled.checked,
    onMinimize: onMinimize.checked,
    alwaysOnTop: alwaysOnTop.checked,
    opacity: (Number(opacity?.value) || 88) / 100,
    position: localStorage.getItem('sunify_setting_overlay_pos') || 'top-center',
    size: localStorage.getItem('sunify_setting_overlay_size') || 'medium',
  });
  const syncSettings = () => {
    localStorage.setItem('sunify_setting_overlay_enabled', String(enabled.checked));
    localStorage.setItem('sunify_setting_overlay_on_minimize', String(onMinimize.checked));
    localStorage.setItem('sunify_setting_overlay_always_on_top', String(alwaysOnTop.checked));
    publish();
  };
  enabled.onchange = syncSettings;
  onMinimize.onchange = syncSettings;
  alwaysOnTop.onchange = syncSettings;
  opacity?.addEventListener('input', () => {
    const value = Math.max(35, Math.min(100, Number(opacity.value) || 88));
    if (opacityValue) opacityValue.value = `${value}%`;
    localStorage.setItem('sunify_setting_overlay_opacity', String(value));
    window.sunifyAPI?.updateMiniPlayerOpacity?.(value / 100);
  });

  positionGroup?.querySelectorAll('.pill-btn').forEach((button) => {
    button.onclick = () => {
      positionGroup.querySelectorAll('.pill-btn').forEach((item) => item.classList.toggle('active', item === button));
      localStorage.setItem('sunify_setting_overlay_pos', button.dataset.val);
      publish();
    };
  });
  sizeGroup?.querySelectorAll('.pill-btn').forEach((button) => {
    button.onclick = () => {
      sizeGroup.querySelectorAll('.pill-btn').forEach((item) => item.classList.toggle('active', item === button));
      localStorage.setItem('sunify_setting_overlay_size', button.dataset.val);
      publish();
    };
  });
  publish();
}

function setupSettingsModal() {
  navSettingsBtn.onclick = openSettingsWindow;
  closeSettingsBtn.onclick = closeSettingsWindow;

  viewSettings.onclick = (e) => {
    if (e.target === viewSettings) closeSettingsWindow();
  };

  const menuItems = document.querySelectorAll('.settings-menu-item');
  const panes = {
    playback: document.getElementById('panePlayback'),
    shortcuts: document.getElementById('paneShortcuts'),
    appearance: document.getElementById('paneAppearance'),
    overlay: document.getElementById('paneOverlay'),
    discord: document.getElementById('paneDiscord'),
    storage: document.getElementById('paneStorage'),
    about: document.getElementById('paneAbout'),
    docs: document.getElementById('paneDocs'),
    support: document.getElementById('paneSupport'),
    account: document.getElementById('paneAccount'),
    admin: document.getElementById('paneAdmin'),
  };

  setupMiniPlayerSettings();

  const settingsSearchInput = document.getElementById('settingsSearchInput');
  settingsSearchInput?.addEventListener('input', () => {
    const query = settingsSearchInput.value.trim().toLocaleLowerCase('tr-TR');
    document.querySelectorAll('.settings-nav-group').forEach((group) => {
      if (group.id === 'adminSettingsNav') return;
      const items = [...group.querySelectorAll('.settings-menu-item')];
      if (!items.length) return;
      let visible = 0;
      items.forEach((item) => {
        const match = !query || item.textContent.toLocaleLowerCase('tr-TR').includes(query);
        item.hidden = !match;
        if (match) visible += 1;
      });
      group.hidden = visible === 0;
    });
  });

  const shortcutCategoryGroup = document.getElementById('shortcutCategoryGroup');
  const shortcutSearchInput = document.getElementById('shortcutSearchInput');
  const shortcutCards = [...document.querySelectorAll('#shortcutCardsGrid .shortcut-card-item')];
  let shortcutCategory = 'main';
  shortcutCards.forEach((card) => {
    if (!card.dataset.shortcutCat) card.dataset.shortcutCat = card.querySelector('.shortcut-context')?.textContent.includes('Sistem geneli') ? 'global' : 'main';
  });
  const filterShortcutCards = () => {
    const query = shortcutSearchInput?.value.trim().toLocaleLowerCase('tr-TR') || '';
    shortcutCards.forEach((card) => {
      const categoryMatches = shortcutCategory === 'all' || card.dataset.shortcutCat === shortcutCategory;
      card.hidden = !categoryMatches || (query && !card.textContent.toLocaleLowerCase('tr-TR').includes(query));
    });
  };
  shortcutCategoryGroup?.querySelectorAll('.pill-btn').forEach((button) => {
    button.onclick = () => {
      shortcutCategory = button.dataset.cat || 'main';
      shortcutCategoryGroup.querySelectorAll('.pill-btn').forEach((item) => item.classList.toggle('active', item === button));
      filterShortcutCards();
    };
  });
  shortcutSearchInput?.addEventListener('input', filterShortcutCards);
  filterShortcutCards();

  const autoSimilarToggle = document.getElementById('settingAutoSimilar');
  if (autoSimilarToggle) {
    autoSimilarToggle.checked = localStorage.getItem('sunify_setting_auto_similar') !== 'false';
    autoSimilarToggle.onchange = () => localStorage.setItem('sunify_setting_auto_similar', String(autoSimilarToggle.checked));
  }
  const pauseOnDeviceToggle = document.getElementById('settingPauseOnDeviceChange');
  if (pauseOnDeviceToggle) {
    pauseOnDeviceToggle.checked = localStorage.getItem('sunify_setting_pause_device_change') === 'true';
    pauseOnDeviceToggle.onchange = () => localStorage.setItem('sunify_setting_pause_device_change', String(pauseOnDeviceToggle.checked));
  }
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (localStorage.getItem('sunify_setting_pause_device_change') === 'true' && isPlaying) audio.pause();
  });
  document.querySelectorAll('#settingDoubleClickAction .pill-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.val === (localStorage.getItem('sunify_setting_double_click') || 'play'));
  });
  document.querySelectorAll('#settingDefaultPlayContext .pill-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.val === (localStorage.getItem('sunify_setting_play_context') || 'restore'));
  });

  const rpcSettings = [
    ['settingRpcMasterToggle', 'master'], ['settingRpcTimeline', 'timeline'],
    ['settingRpcArtwork', 'artwork'], ['settingRpcArtistBadge', 'artistBadge'],
    ['settingRpcShowPaused', 'showPaused'], ['settingRpcBtnListen', 'buttonListen'],
    ['settingRpcBtnDownload', 'buttonDownload'],
  ];
  rpcSettings.forEach(([id, key]) => {
    const input = document.getElementById(id);
    if (!input) return;
    const stored = localStorage.getItem(`sunify_rpc_${key}`);
    if (stored !== null) input.checked = stored === 'true';
    input.addEventListener('change', () => {
      localStorage.setItem(`sunify_rpc_${key}`, String(input.checked));
      if (currentTrack) syncDiscordRPC(currentTrack, audio.currentTime, audio.duration || currentTrack.duration, isPlaying);
      else if (!input.checked && key === 'master') window.sunifyAPI?.clearDiscordPresence?.();
    });
  });
  document.getElementById('settingRpcFormat')?.addEventListener('change', () => {
    if (currentTrack) syncDiscordRPC(currentTrack, audio.currentTime, audio.duration || currentTrack.duration, isPlaying);
  });

  // Ayarlar İçi Etkileşimli Butonlar
  // 1. Çalma Ayarları Butonları
  document.querySelectorAll('#settingDoubleClickAction .pill-btn').forEach((btn) => {
    btn.onclick = () => {
      document
        .querySelectorAll('#settingDoubleClickAction .pill-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      localStorage.setItem('sunify_setting_double_click', btn.dataset.val);
      showAppNotification('Ayar Güncellendi', `Çift tıklama eylemi: ${btn.textContent}`);
    };
  });

  document.querySelectorAll('#settingDefaultPlayContext .pill-btn').forEach((btn) => {
    btn.onclick = () => {
      document
        .querySelectorAll('#settingDefaultPlayContext .pill-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      localStorage.setItem('sunify_setting_play_context', btn.dataset.val);
      showAppNotification('Ayar Güncellendi', `Çalma bağlamı: ${btn.textContent}`);
    };
  });

  // Depolama & Önbellek Butonları
  const storedLimit = (key, allowed, fallback) => {
    const value = Number(localStorage.getItem(key));
    return allowed.includes(value) ? value : fallback;
  };
  let downloadLimitGB = storedLimit('sunify_setting_download_limit', [0, 2, 5, 20], 5);
  let cacheLimitGB = storedLimit('sunify_setting_cache_limit', [0, 1, 3, 10], 3);
  const formatStorageSize = (bytes) => {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = value / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
    return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[unit]}`;
  };
  const refreshStorageStats = async () => {
    const response = await fetch(`${API_BASE}/storage/stats`, { signal: AbortSignal.timeout(15000) });
    const stats = await response.json();
    if (!response.ok) throw new Error(stats.error || 'Depolama bilgisi alınamadı.');
    const cacheBytes = Number(stats.audioCacheBytes) || 0;
    const downloadsBytes = Number(stats.downloadsBytes) || 0;
    const localBytes = Number(stats.localMusicBytes) || 0;
    const musicBytes = downloadsBytes + localBytes;
    const totalBytes = cacheBytes + musicBytes;
    const setText = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
    setText('storageTotalSizeLabel', formatStorageSize(totalBytes));
    const totalUnit = document.querySelector('#paneStorage .storage-number-row .storage-unit');
    if (totalUnit) totalUnit.textContent = '';
    setText('storageMusicSizeLabel', formatStorageSize(musicBytes));
    setText('storageCacheSizeLabel', formatStorageSize(cacheBytes));
    setText('cacheItemsSizeLabel', formatStorageSize(cacheBytes));
    setText('localMusicStorageSize', formatStorageSize(localBytes));
    const likedBytes = likedTracks.reduce((total, track) => total + (Number(findDownloadedTrack(track)?.size) || 0), 0);
    setText('likedSongsDownloadSize', formatStorageSize(likedBytes));
    setText('likedSongsDownloadCount', `${likedTracks.length} şarkı`);
    const cacheLimitBytes = Number(stats.audioCacheLimitBytes) || (cacheLimitGB === 0 ? 0 : cacheLimitGB * 1024 ** 3);
    const downloadCapBytes = downloadLimitGB === 0 ? 0 : downloadLimitGB * 1024 ** 3;
    const fill = document.getElementById('storageBarFill');
    const percent = totalBytes && (cacheLimitBytes || downloadCapBytes)
      ? Math.min(100, Math.round((cacheBytes / (cacheLimitBytes || Infinity) + musicBytes / (downloadCapBytes || Infinity)) * 100))
      : (totalBytes ? 4 : 0);
    if (fill) fill.style.width = `${Math.max(totalBytes ? 2 : 0, percent)}%`;
    const badge = document.getElementById('storageFreeBadge');
    if (badge) badge.textContent = totalBytes ? `Toplam ${formatStorageSize(totalBytes)}` : 'Henüz dosya yok';
    const downloadDesc = document.getElementById('storageDownloadLimitDesc');
    if (downloadDesc) downloadDesc.textContent = downloadLimitGB === 0
      ? 'Sınır yok. Disk alanı bitene kadar indirilebilir.'
      : `En fazla ${downloadLimitGB} GB. Şu an ${formatStorageSize(downloadsBytes)} kullanılıyor.`;
    const cacheDesc = document.getElementById('storageCacheLimitDesc');
    if (cacheDesc) cacheDesc.textContent = cacheLimitGB === 0
      ? 'Sınır yok. Önbellek dosyaları 7 gün sonra temizlenir.'
      : `${cacheLimitGB} GB sınır. Alan dolunca en eski önbellek dosyaları kaldırılır.`;
    return stats;
  };
  const applyStorageLimits = async () => {
    const response = await fetch(`${API_BASE}/storage/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadLimitGB, cacheLimitGB }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Depolama ayarları uygulanamadı.');
    return data;
  };
  const updateStorageControls = () => {
    document.querySelectorAll('#downloadLimitGroup .pill-btn').forEach((button) => button.classList.toggle('active', Number(button.dataset.limit) === downloadLimitGB));
    document.querySelectorAll('#cacheLimitGroup .pill-btn').forEach((button) => button.classList.toggle('active', Number(button.dataset.limit) === cacheLimitGB));
  };
  updateStorageControls();
  const settingDownloadLiked = document.getElementById('settingDownloadLiked');
  if (settingDownloadLiked) {
    settingDownloadLiked.checked = localStorage.getItem('sunify_setting_download_liked') === 'true';
    settingDownloadLiked.onchange = () => {
      localStorage.setItem('sunify_setting_download_liked', String(settingDownloadLiked.checked));
      if (settingDownloadLiked.checked) {
        likedTracks.filter((track) => !findDownloadedTrack(track)).forEach((track) => enqueueTrackDownload(track));
      }
    };
  }
  const showCachedToggle = document.getElementById('settingShowCachedInLibrary');
  if (showCachedToggle) {
    showCachedToggle.checked = localStorage.getItem('sunify_setting_show_cached') === 'true';
    showCachedToggle.onchange = () => {
      localStorage.setItem('sunify_setting_show_cached', String(showCachedToggle.checked));
      void loadCachedAudioTracks();
    };
  }

  document.querySelectorAll('#downloadLimitGroup .pill-btn').forEach((btn) => {
    btn.onclick = async () => {
      const previousLimit = downloadLimitGB;
      downloadLimitGB = Number(btn.dataset.limit);
      try {
        await applyStorageLimits();
        localStorage.setItem('sunify_setting_download_limit', String(downloadLimitGB));
        updateStorageControls(); await refreshStorageStats();
        showAppNotification('İndirme Alanı', `Sınır uygulandı: ${btn.textContent}`);
      } catch (error) {
        downloadLimitGB = previousLimit; updateStorageControls();
        showAppNotification('Ayar uygulanamadı', error.message, true);
      }
    };
  });

  document.querySelectorAll('#cacheLimitGroup .pill-btn').forEach((btn) => {
    btn.onclick = async () => {
      const previousLimit = cacheLimitGB;
      cacheLimitGB = Number(btn.dataset.limit);
      try {
        await applyStorageLimits();
        localStorage.setItem('sunify_setting_cache_limit', String(cacheLimitGB));
        updateStorageControls(); await refreshStorageStats();
        showAppNotification('Önbellek Alanı', `Sınır uygulandı: ${btn.textContent}`);
      } catch (error) {
        cacheLimitGB = previousLimit; updateStorageControls();
        showAppNotification('Ayar uygulanamadı', error.message, true);
      }
    };
  });

  const btnClearStorageCacheBtn = document.getElementById('btnClearStorageCacheBtn');
  if (btnClearStorageCacheBtn) {
    btnClearStorageCacheBtn.onclick = async () => {
      if (!window.confirm('Tamamlanmış şarkı önbelleği silinsin mi? İndirdiğin müzik dosyaları etkilenmez.')) return;
      btnClearStorageCacheBtn.disabled = true;
      try {
        const response = await fetch(`${API_BASE}/audio-cache/clear`, { method: 'POST', signal: AbortSignal.timeout(30000) });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Önbellek temizlenemedi.');
        await refreshStorageStats();
        await loadCachedAudioTracks();
        const activeNote = data.activeDownloadsSkipped ? ` ${data.activeDownloadsSkipped} etkin indirme korunuyor.` : '';
        showAppNotification('Önbellek temizlendi', `${data.files} dosya silindi (${formatStorageSize(data.bytes)}).${activeNote}`);
      } catch (error) { showAppNotification('Önbellek temizlenemedi', error.message, true); }
      finally { btnClearStorageCacheBtn.disabled = false; }
    };
  }

  const btnOpenDownloadsFolder = document.getElementById('btnOpenDownloadsFolder');
  const btnOpenCacheFolder = document.getElementById('btnOpenCacheFolder');
  const addMusicFolderBtn = document.getElementById('addMusicFolderBtn');
  if (addMusicFolderBtn) addMusicFolderBtn.onclick = chooseMusicFolders;
  if (btnOpenCacheFolder) {
    btnOpenCacheFolder.onclick = async () => {
      btnOpenCacheFolder.disabled = true;
      try {
        if (!window.sunifyAPI?.openCacheFolder) throw new Error('Önbellek klasörü masaüstü uygulamasında açılabilir.');
        const error = await window.sunifyAPI.openCacheFolder();
        if (error) throw new Error(error);
        showAppNotification('Önbellek', 'Sunify önbellek klasörü açıldı.');
      } catch (error) {
        showAppNotification('Klasör açılamadı', error.message || 'Önbellek klasörü açılamadı.', true);
      } finally {
        btnOpenCacheFolder.disabled = false;
      }
    };
  }
  if (btnOpenDownloadsFolder) {
    btnOpenDownloadsFolder.onclick = async () => {
      btnOpenDownloadsFolder.disabled = true;
      try {
        if (!window.sunifyAPI?.openDownloadsFolder) throw new Error('Klasör açma masaüstü sürümünde kullanılabilir.');
        const error = await window.sunifyAPI.openDownloadsFolder();
        if (error) throw new Error(error);
        showAppNotification('İndirilenler', 'İndirilenler klasörü açıldı.');
      } catch (error) {
        showAppNotification('Klasör açılamadı', error.message || 'İndirilenler klasörü açılamadı.', true);
      } finally {
        btnOpenDownloadsFolder.disabled = false;
      }
    };
  }
  void applyStorageLimits().then(refreshStorageStats).catch((error) => {
    console.warn('Depolama ayarları yüklenemedi:', error.message);
  });

  const btnCheckUpdates = document.getElementById('btnCheckUpdates');
  if (btnCheckUpdates) {
    btnCheckUpdates.onclick = () => checkForUpdates({ manual: true });
  }

  let adminAccessToken = '';
  let adminPin = '';
  let selectedAdminUserId = '';
  const adminLoginCard = document.getElementById('adminLoginCard');
  const adminDashboard = document.getElementById('adminDashboard');
  const adminLoginForm = document.getElementById('adminLoginForm');
  const adminLoginStatus = document.getElementById('adminLoginStatus');
  const adminUsersList = document.getElementById('adminUsersList');
  const adminUserDataPreview = document.getElementById('adminUserDataPreview');
  const adminSelectedUserLabel = document.getElementById('adminSelectedUserLabel');
  const adminClearUserDataButton = document.getElementById('adminClearUserDataButton');
  const adminDeleteUserButton = document.getElementById('adminDeleteUserButton');
  const adminReleaseStatus = document.getElementById('adminReleaseStatus');
  const adminReleaseFilesInput = document.getElementById('adminReleaseFiles');
  const adminReleaseFileList = document.getElementById('adminReleaseFileList');
  const adminReleaseFiles = [];
  const maxAdminReleaseFiles = 8;
  const releaseUploadChunkBytes = 20 * 1024 * 1024;
  const formatReleaseFileSize = (size) => (size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`);
  const renderAdminReleaseFiles = () => {
    if (!adminReleaseFileList) return;
    adminReleaseFileList.replaceChildren();
    adminReleaseFiles.forEach((file, index) => {
      const row = document.createElement('div');
      row.className = 'admin-release-file-row';
      const label = document.createElement('span');
      label.textContent = `${file.name} · ${formatReleaseFileSize(file.size)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tool-btn icon-only';
      remove.setAttribute('aria-label', `${file.name} dosyasını kaldır`);
      remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
      remove.addEventListener('click', () => {
        adminReleaseFiles.splice(index, 1);
        renderAdminReleaseFiles();
      });
      row.append(label, remove);
      adminReleaseFileList.append(row);
    });
  };
  document.getElementById('adminChooseReleaseFilesButton')?.addEventListener('click', () => adminReleaseFilesInput?.click());
  adminReleaseFilesInput?.addEventListener('change', () => {
    const incoming = Array.from(adminReleaseFilesInput.files || []);
    adminReleaseFilesInput.value = '';
    const available = maxAdminReleaseFiles - adminReleaseFiles.length;
    if (incoming.length > available) {
      showAppNotification('Dosya sınırı', `Bir sürüme en fazla ${maxAdminReleaseFiles} dosya ekleyebilirsin.`, true);
    }
    for (const file of incoming.slice(0, Math.max(0, available))) {
      if (adminReleaseFiles.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) continue;
      adminReleaseFiles.push(file);
    }
    renderAdminReleaseFiles();
  });
  const adminRequest = async (payload, authenticated = true) => {
    const response = await fetch(`${API_BASE}/admin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated && adminAccessToken ? { Authorization: `Bearer ${adminAccessToken}` } : {}),
        'x-admin-pin': adminPin,
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Admin isteği tamamlanamadı.');
    return data;
  };
  const lockAdminPanel = () => {
    adminAccessToken = '';
    adminPin = '';
    selectedAdminUserId = '';
    if (adminLoginCard) adminLoginCard.hidden = false;
    if (adminDashboard) adminDashboard.hidden = true;
    if (adminUsersList) adminUsersList.replaceChildren();
    if (adminUserDataPreview) adminUserDataPreview.textContent = 'Kullanıcı verileri burada görüntülenir.';
    if (adminSelectedUserLabel) adminSelectedUserLabel.textContent = 'Bir kullanıcı seçin';
    if (adminClearUserDataButton) adminClearUserDataButton.disabled = true;
    if (adminDeleteUserButton) adminDeleteUserButton.disabled = true;
  };
  document.addEventListener('sunify:auth-changed', (event) => {
    if (!event.detail?.isAdmin) {
      lockAdminPanel();
      if (panes.admin?.classList.contains('active')) {
        document.querySelector('.settings-menu-item[data-tab="appearance"]')?.click();
      }
    }
  });
  const loadAdminUserData = async (userId, email) => {
    selectedAdminUserId = userId;
    if (adminSelectedUserLabel) adminSelectedUserLabel.textContent = email;
    if (adminUserDataPreview) adminUserDataPreview.textContent = 'Kullanıcı verileri yükleniyor...';
    if (adminClearUserDataButton) adminClearUserDataButton.disabled = true;
    if (adminDeleteUserButton) adminDeleteUserButton.disabled = true;
    try {
      const data = await adminRequest({ action: 'get-user-data', userId });
      if (adminUserDataPreview) adminUserDataPreview.textContent = JSON.stringify(data, null, 2);
      if (adminClearUserDataButton) adminClearUserDataButton.disabled = false;
      if (adminDeleteUserButton) adminDeleteUserButton.disabled = false;
    } catch (error) {
      if (adminUserDataPreview) adminUserDataPreview.textContent = error.message;
    }
  };
  const refreshAdminUsers = async () => {
    if (!adminUsersList) return;
    adminUsersList.textContent = 'Kullanıcılar yükleniyor...';
    try {
      const { users } = await adminRequest({ action: 'list-users' });
      adminUsersList.replaceChildren();
      if (!users?.length) {
        adminUsersList.textContent = 'Kullanıcı bulunamadı.';
        return;
      }
      for (const user of users) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'admin-user-row';
        const email = document.createElement('span');
        email.textContent = user.email || 'E-posta yok';
        const details = document.createElement('small');
        details.textContent = `${user.emailConfirmed ? 'Doğrulanmış' : 'Doğrulanmamış'} · ${user.lastSignInAt ? new Date(user.lastSignInAt).toLocaleDateString('tr-TR') : 'Henüz giriş yok'}`;
        button.append(email, details);
        button.onclick = () => loadAdminUserData(user.id, user.email || 'Kullanıcı');
        adminUsersList.appendChild(button);
      }
    } catch (error) {
      adminUsersList.textContent = error.message;
    }
  };

  if (adminLoginForm) {
    adminLoginForm.onsubmit = async (event) => {
      event.preventDefault();
      const email = document.getElementById('adminEmailInput').value.trim().toLowerCase();
      const passwordInput = document.getElementById('adminPasswordInput');
      const pinInput = document.getElementById('adminPinInput');
      const pin = pinInput.value;
      const button = document.getElementById('adminLoginButton');
      if (email !== SUNIFY_ADMIN_EMAIL) {
        if (adminLoginStatus) adminLoginStatus.textContent = 'Bu e-posta admin erişimine yetkili değil.';
        return;
      }
      if (button) button.disabled = true;
      if (adminLoginStatus) adminLoginStatus.textContent = 'Supabase hesabı doğrulanıyor...';
      adminPin = pin;
      try {
        const result = await adminRequest({ action: 'admin-login', email, password: passwordInput.value }, false);
        adminAccessToken = result.accessToken;
        passwordInput.value = '';
        pinInput.value = '';
        if (adminLoginCard) adminLoginCard.hidden = true;
        if (adminDashboard) adminDashboard.hidden = false;
        if (adminLoginStatus) adminLoginStatus.textContent = '';
        showAppNotification('Admin paneli', 'Güvenli admin oturumu açıldı.');
        await refreshAdminUsers();
      } catch (error) {
        adminPin = '';
        if (adminLoginStatus) adminLoginStatus.textContent = error.message;
      } finally {
        if (button) button.disabled = false;
      }
    };
  }
  document.getElementById('adminRefreshUsersButton')?.addEventListener('click', refreshAdminUsers);
  document.getElementById('adminLockButton')?.addEventListener('click', lockAdminPanel);
  adminClearUserDataButton?.addEventListener('click', async () => {
    if (!selectedAdminUserId || !window.confirm('Bu kullanıcının tüm çalma listelerini, beğenilerini ve dinleme verilerini temizleyeyim mi?')) return;
    try {
      await adminRequest({ action: 'delete-user-data', userId: selectedAdminUserId });
      await loadAdminUserData(selectedAdminUserId, adminSelectedUserLabel.textContent);
      showAppNotification('Kullanıcı verileri', 'Bulut verileri temizlendi.');
    } catch (error) {
      showAppNotification('İşlem başarısız', error.message, true);
    }
  });
  adminDeleteUserButton?.addEventListener('click', async () => {
    if (!selectedAdminUserId || !window.confirm('Bu Supabase hesabı ve hesaba ait bulut verileri kalıcı olarak silinsin mi?')) return;
    try {
      await adminRequest({ action: 'delete-user', userId: selectedAdminUserId });
      selectedAdminUserId = '';
      if (adminSelectedUserLabel) adminSelectedUserLabel.textContent = 'Bir kullanıcı seçin';
      if (adminUserDataPreview) adminUserDataPreview.textContent = 'Hesap ve verileri silindi.';
      if (adminClearUserDataButton) adminClearUserDataButton.disabled = true;
      adminDeleteUserButton.disabled = true;
      await refreshAdminUsers();
      showAppNotification('Kullanıcı silindi', 'Supabase hesabı ve verileri silindi.');
    } catch (error) {
      showAppNotification('Silme başarısız', error.message, true);
    }
  });
  document.getElementById('adminPublishReleaseButton')?.addEventListener('click', async () => {
    const button = document.getElementById('adminPublishReleaseButton');
    const version = document.getElementById('adminReleaseVersion').value.trim();
    const notes = document.getElementById('adminReleaseNotes').value.trim();
    if (button) button.disabled = true;
    try {
      const uploadedAssets = [];
      for (let index = 0; index < adminReleaseFiles.length; index += 1) {
        const file = adminReleaseFiles[index];
        const chunkCount = Math.max(1, Math.ceil(file.size / releaseUploadChunkBytes));
        const chunks = [];
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          if (adminReleaseStatus) {
            adminReleaseStatus.textContent = `Dosyalar yükleniyor (${index + 1}/${adminReleaseFiles.length}) · ${file.name} (${chunkIndex + 1}/${chunkCount})...`;
          }
          const start = chunkIndex * releaseUploadChunkBytes;
          const chunk = file.slice(start, Math.min(file.size, start + releaseUploadChunkBytes));
          const chunkName = `${file.name}.part-${String(chunkIndex + 1).padStart(4, '0')}`;
          const { uploadUrl, path } = await adminRequest({ action: 'create-release-upload', name: chunkName });
          const uploadResponse = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' },
            body: chunk,
          });
          if (!uploadResponse.ok) throw new Error(`${file.name} yüklenemedi (${uploadResponse.status}).`);
          chunks.push({ index: chunkIndex, path });
        }
        uploadedAssets.push({ name: file.name, size: file.size, chunks });
      }
      if (adminReleaseStatus) adminReleaseStatus.textContent = 'GitHub Actions yayını başlatılıyor...';
      const result = await adminRequest({ action: 'publish-release', version, notes, assets: uploadedAssets });
      if (adminReleaseStatus) adminReleaseStatus.textContent = result.message;
      adminReleaseFiles.splice(0, adminReleaseFiles.length);
      renderAdminReleaseFiles();
      showAppNotification('Sürüm yayını', result.message);
    } catch (error) {
      if (adminReleaseStatus) adminReleaseStatus.textContent = error.message;
      showAppNotification('Yayın başlatılamadı', error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  });

  let settingsPaneTransitionToken = 0;
  menuItems.forEach((item) => {
    item.onclick = async () => {
      const transitionToken = ++settingsPaneTransitionToken;
      const targetTab = item.dataset.tab;
      const targetPane = panes[targetTab] || panes.appearance;
      const currentPane = Object.values(panes).find((pane) => pane?.classList.contains('active'));
      if (currentPane && currentPane !== targetPane && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches && currentPane.animate) {
        const exitAnimation = currentPane.animate(
          [{ opacity: 1, transform: 'translateX(0)', filter: 'blur(0)' }, { opacity: 0, transform: 'translateX(-8px)', filter: 'blur(2px)' }],
          { duration: 130, easing: 'ease-in', fill: 'forwards' }
        );
        await exitAnimation.finished.catch(() => {});
        exitAnimation.cancel();
        if (transitionToken !== settingsPaneTransitionToken) return;
      }
      menuItems.forEach((m) => m.classList.remove('active'));
      item.classList.add('active');

      Object.keys(panes).forEach((k) => {
        if (panes[k]) panes[k].classList.remove('active');
      });

      if (targetPane) {
        targetPane.classList.add('active');
        if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches && targetPane.animate) {
          targetPane.animate(
            [{ opacity: 0, transform: 'translateX(8px)', filter: 'blur(2px)' }, { opacity: 1, transform: 'translateX(0)', filter: 'blur(0)' }],
            { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' }
          );
        }
      }
      if (targetTab === 'account') {
        document.dispatchEvent(new CustomEvent('sunify:accounts-view'));
      }
      if (targetTab === 'storage') {
        void applyStorageLimits().then(refreshStorageStats).catch((error) => showAppNotification('Depolama bilgisi alınamadı', error.message, true));
      }
    };
  });

}

// 14. ÇALMA LİSTESİ İÇE AKTARMA & MODALLAR
function setupModals() {
  openImportModalBtn.onclick = () => {
    resetPlaylistImportProgress();
    importModal.classList.add('active');
    importUrlInput.focus();
  };

  closeImportModalBtn.onclick = () => {
    importModal.classList.remove('active');
    resetPlaylistImportProgress();
  };

  // Şarkı Ekleme Modalı Olayları
  const addTrackModal = document.getElementById('addTrackModal');
  const closeAddTrackModalBtn = document.getElementById('closeAddTrackModalBtn');
  const addTrackSearchInput = document.getElementById('addTrackSearchInput');
  const addTrackResultsContainer = document.getElementById('addTrackResultsContainer');

  closeAddTrackModalBtn.onclick = () => {
    addTrackModal.classList.remove('active');
  };

  let addTrackDebounce;
  addTrackSearchInput.oninput = (e) => {
    clearTimeout(addTrackDebounce);
    const q = e.target.value.trim();
    if (!q) {
      addTrackResultsContainer.innerHTML =
        '<p style="color:#ffffff; font-size:12px; padding:10px;">Aramak için bir şarkı veya sanatçı adı yazın...</p>';
      return;
    }
    addTrackResultsContainer.innerHTML =
      '<p style="color:#ffffff; font-size:12px; padding:10px;"><i class="fa-solid fa-spinner fa-spin"></i> Aranıyor...</p>';
    addTrackDebounce = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!data.results || data.results.length === 0) {
          addTrackResultsContainer.innerHTML =
            '<p style="color:#ffffff; font-size:12px; padding:10px;">Sonuç bulunamadı.</p>';
          return;
        }

        addTrackResultsContainer.innerHTML = '';
        data.results.slice(0, 7).forEach((t) => {
          const item = document.createElement('div');
          item.className = 'add-result-item';
          item.innerHTML = `
            <img class="add-result-thumb" src="${t.thumbnail}">
            <div class="add-result-meta">
              <div class="add-result-title">${t.title}</div>
              <div class="add-result-artist">${t.artist}</div>
            </div>
            <button class="pl-action-icon-btn" title="Bu Listeye Ekle"><i class="fa-solid fa-plus"></i></button>
          `;
          item.onclick = () => {
            if (activePlaylistData) {
              activePlaylistData.tracks.push(t);
              persistPlaylistChanges();
              renderPlaylistTracks(activePlaylistData.tracks);
              plHeroStats.innerHTML = `<i class="fa-solid fa-music"></i> ${activePlaylistData.tracks.length} parça • Dinlemeye hazır`;
              addTrackModal.classList.remove('active');
              showAppNotification('Şarkı Eklendi', `"${t.title}" listenize eklendi!`);
            }
          };
          addTrackResultsContainer.appendChild(item);
        });
      } catch (err) {
        addTrackResultsContainer.innerHTML = `<p style="color:#ffffff; font-size:12px; padding:10px;">Arama hatası: ${err.message}</p>`;
      }
    }, 350);
  };

  // Şarkı Düzenleme Modalı Olayları
  const editTrackModal = document.getElementById('editTrackModal');
  const closeEditTrackModalBtn = document.getElementById('closeEditTrackModalBtn');
  const saveEditTrackBtn = document.getElementById('saveEditTrackBtn');

  closeEditTrackModalBtn.onclick = () => {
    editTrackModal.classList.remove('active');
  };

  saveEditTrackBtn.onclick = () => {
    if (!editingTrackRef) return;

    const newTitle = document.getElementById('editTrackTitleInput').value.trim();
    const newArtist = document.getElementById('editTrackArtistInput').value.trim();
    const newCover = document.getElementById('editTrackCoverInput').value.trim();

    if (newTitle) editingTrackRef.title = newTitle;
    if (newArtist) editingTrackRef.artist = newArtist;
    if (newCover) editingTrackRef.thumbnail = newCover;

    // Arama sorgusunu da güncelle
    editingTrackRef.query = `${editingTrackRef.artist} - ${editingTrackRef.title}`;

    persistPlaylistChanges();
    if (activePlaylistData) renderPlaylistTracks(activePlaylistData.tracks);

    // Eğer şu an çalan şarkı düzenlendiyse oynatıcıyı da güncelle
    if (currentTrack && currentTrack.id === editingTrackRef.id) {
      currentTitle.textContent = editingTrackRef.title;
      currentArtist.textContent = editingTrackRef.artist;
      currentThumb.src = editingTrackRef.thumbnail;
      lyricsTrackTitle.textContent = editingTrackRef.title;
      lyricsTrackArtist.textContent = editingTrackRef.artist;
      lyricsBigCover.src = editingTrackRef.thumbnail;
    }

    editTrackModal.classList.remove('active');
    showAppNotification(
      'Şarkı Güncellendi',
      `"${editingTrackRef.title}" bilgileri başarıyla kaydedildi!`
    );
  };

  // Çalma Listesi Sekme Geçişleri (Sıfırdan vs İçe Aktar)
  const tabScratch = document.getElementById('tabScratch');
  const tabImport = document.getElementById('tabImport');
  const tabScratchContent = document.getElementById('tabScratchContent');
  const tabImportContent = document.getElementById('tabImportContent');
  const importModalTitle = document.getElementById('importModalTitle');
  const importModalIcon = document.querySelector('#importModal .modal-title-icon i');
  const importModalSub = document.getElementById('importModalSub');
  const playlistImportProgress = document.getElementById('playlistImportProgress');
  const playlistImportProgressTitle = document.getElementById('playlistImportProgressTitle');
  const playlistImportProgressText = document.getElementById('playlistImportProgressText');
  const playlistImportProgressCount = document.getElementById('playlistImportProgressCount');
  const playlistImportProgressBar = document.getElementById('playlistImportProgressBar');
  const playlistImportTrackList = document.getElementById('playlistImportTrackList');
  let currentModalMode = 'import';

  const resetPlaylistImportProgress = () => {
    playlistImportProgress.hidden = true;
    playlistImportProgressTitle.textContent = 'Çalma listesi hazırlanıyor';
    playlistImportProgressText.textContent = 'Şarkılar sırayla ekleniyor…';
    playlistImportProgressCount.textContent = '0 / 0';
    playlistImportProgressBar.style.width = '0%';
    playlistImportTrackList.replaceChildren();
  };

  const showPlaylistImportLoading = () => {
    playlistImportProgress.hidden = false;
    playlistImportProgressTitle.textContent = 'Çalma listesi okunuyor';
    playlistImportProgressText.textContent = 'Şarkılar bulunuyor, lütfen bekleyin…';
    playlistImportProgressCount.textContent = '…';
    playlistImportProgressBar.style.width = '4%';
    playlistImportTrackList.replaceChildren();
  };

  const animatePlaylistImportTracks = async (tracks) => {
    playlistImportProgress.hidden = false;
    playlistImportProgressTitle.textContent = 'Şarkılar listeye ekleniyor';
    playlistImportProgressText.textContent = 'Her parça sırayla aktarılıyor…';
    playlistImportTrackList.replaceChildren();
    const rows = tracks.map((track, index) => {
      const row = document.createElement('div');
      row.className = 'playlist-import-track-row';
      const status = document.createElement('span');
      status.className = 'playlist-import-track-status';
      status.textContent = String(index + 1);
      const name = document.createElement('span');
      name.className = 'playlist-import-track-name';
      name.textContent = `${track.title || 'Bilinmeyen parça'} · ${track.artist || 'Bilinmeyen sanatçı'}`;
      row.append(status, name);
      playlistImportTrackList.appendChild(row);
      return { row, status };
    });

    playlistImportProgressCount.textContent = `0 / ${tracks.length}`;
    const stepDelay = Math.max(30, Math.min(140, Math.ceil(2600 / tracks.length)));
    for (let index = 0; index < rows.length; index += 1) {
      const { row, status } = rows[index];
      row.classList.add('is-loading');
      status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      row.scrollIntoView({ block: 'nearest' });
      await new Promise((resolve) => setTimeout(resolve, stepDelay));
      row.classList.remove('is-loading');
      row.classList.add('is-done');
      status.innerHTML = '<i class="fa-solid fa-check"></i>';
      playlistImportProgressCount.textContent = `${index + 1} / ${tracks.length}`;
      playlistImportProgressBar.style.width = `${Math.round(((index + 1) / tracks.length) * 100)}%`;
    }
    playlistImportProgressTitle.textContent = 'Aktarım tamamlandı';
    playlistImportProgressText.textContent = `${tracks.length} şarkı çalma listene eklendi.`;
  };

  if (tabScratch && tabImport) {
    tabScratch.onclick = () => {
      tabScratch.classList.add('active');
      tabImport.classList.remove('active');
      tabScratchContent.style.display = 'block';
      tabImportContent.style.display = 'none';
      importModalTitle.textContent = 'Yeni Çalma Listesi Oluştur';
      if (importModalIcon) importModalIcon.className = 'fa-solid fa-circle-plus';
      importModalSub.textContent =
        'Sıfırdan boş bir çalma listesi oluşturun ve istediğiniz şarkıları ekleyin';
      confirmImportBtn.textContent = 'Oluştur';
      currentModalMode = 'scratch';
      document.getElementById('scratchPlaylistNameInput').focus();
    };

    tabImport.onclick = () => {
      tabImport.classList.add('active');
      tabScratch.classList.remove('active');
      tabImportContent.style.display = 'block';
      tabScratchContent.style.display = 'none';
      importModalTitle.textContent = 'Çalma Listesi İçe Aktar';
      if (importModalIcon) importModalIcon.className = 'fa-solid fa-file-import';
      importModalSub.textContent = "Spotify veya YouTube'daki mevcut bir çalma listesini içe aktar";
      confirmImportBtn.textContent = 'İçe aktar';
      currentModalMode = 'import';
      importUrlInput.focus();
    };
  }

  confirmImportBtn.onclick = async () => {
    if (currentModalMode === 'scratch') {
      const plName = document.getElementById('scratchPlaylistNameInput').value.trim();
      const plCover = document.getElementById('scratchPlaylistCoverInput').value.trim();

      if (!plName) {
        showAppNotification('Uyarı', 'Lütfen çalma listesi için bir isim belirleyin.', true);
        return;
      }

      const newPlaylist = {
        id: 'pl_' + Date.now(),
        type: 'playlists',
        name: plName,
        author: 'Senin Listen',
        thumbnail: plCover || PLACEHOLDER_COVER,
        cover: plCover || PLACEHOLDER_COVER,
        tracks: [],
      };

      customPlaylists.push(newPlaylist);
      writeAccountJson('sunify_custom_playlists', customPlaylists);
      renderLibraryItems();

      importModal.classList.remove('active');
      document.getElementById('scratchPlaylistNameInput').value = '';
      document.getElementById('scratchPlaylistCoverInput').value = '';

      showAppNotification(
        'Liste Oluşturuldu',
        `"${plName}" başarıyla oluşturuldu! Şimdi içine şarkı ekleyebilirsiniz.`
      );
      openPlaylistDetailView(newPlaylist);
      return;
    }

    const url = importUrlInput.value.trim();
    if (!url) {
      showAppNotification(
        'Uyarı',
        'Lütfen geçerli bir Spotify veya YouTube çalma listesi bağlantısı girin.',
        true
      );
      return;
    }

    confirmImportBtn.textContent = 'İçe aktarılıyor...';
    confirmImportBtn.disabled = true;
    if (tabImport) tabImport.disabled = true;
    if (tabScratch) tabScratch.disabled = true;
    showPlaylistImportLoading();

    try {
      const res = await fetch(`${API_BASE}/import-playlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Çalma listesi alınamadı.');

      if (data.tracks && data.tracks.length > 0) {
        await animatePlaylistImportTracks(data.tracks);
        data.type = 'playlists';
        customPlaylists.push(data);
        writeAccountJson('sunify_custom_playlists', customPlaylists);
        renderLibraryItems();

        importModal.classList.remove('active');
        importUrlInput.value = '';
        resetPlaylistImportProgress();
        showAppNotification(
          'Çalma Listesi Aktarıldı',
          `"${data.name}" (${data.tracks.length} parça) başarıyla eklendi!`
        );
      } else {
        playlistImportProgressTitle.textContent = 'İçe aktarma tamamlanamadı';
        playlistImportProgressText.textContent = data.error || 'Bu bağlantıda içe aktarılabilir şarkı bulunamadı.';
        playlistImportProgressCount.textContent = '—';
        showAppNotification(
          'İçe Aktarma Başarısız',
          data.error || 'Çalma listesi içe aktarılamadı.',
          true
        );
      }
    } catch (err) {
      playlistImportProgressTitle.textContent = 'İçe aktarma tamamlanamadı';
      playlistImportProgressText.textContent = err.message || 'Çalma listesi alınamadı.';
      playlistImportProgressCount.textContent = '—';
      showAppNotification('Hata', err.message, true);
    } finally {
      confirmImportBtn.disabled = false;
      if (tabImport) tabImport.disabled = false;
      if (tabScratch) tabScratch.disabled = false;
      confirmImportBtn.textContent = currentModalMode === 'scratch' ? 'Oluştur' : 'İçe aktar';
    }
  };
}

// 15. BEĞENİLEN ŞARKILAR
playerLikeBtn.onclick = () => {
  if (!currentTrack) return;
  const existsIndex = likedTracks.findIndex((t) => t.title === currentTrack.title);

  if (existsIndex > -1) {
    likedTracks.splice(existsIndex, 1);
  } else {
    likedTracks.push(currentTrack);
    if (localStorage.getItem('sunify_setting_download_liked') === 'true' && !findDownloadedTrack(currentTrack)) enqueueTrackDownload(currentTrack);
  }

  writeAccountJson('sunify_liked', likedTracks);
  updateLikeButtonUI();
  renderLibraryItems();
  syncToCloudSilently();
};

function updateLikeButtonUI() {
  if (!currentTrack) return;
  const isLiked = likedTracks.some((t) => t.title === currentTrack.title);
  const icon = playerLikeBtn.querySelector('i');
  if (isLiked) {
    icon.className = 'fa-solid fa-heart';
    playerLikeBtn.classList.add('liked');
  } else {
    icon.className = 'fa-regular fa-heart';
    playerLikeBtn.classList.remove('liked');
  }
}

// 16. SUPABASE HESAP, BULUT SENKRONİZASYON VE AÇILIŞ KAPILARI
function initAccountSystem() {
  const authFullscreenGate = document.getElementById('authFullscreenGate');
  const authGateTabLogin = document.getElementById('authGateTabLogin');
  const authGateTabRegister = document.getElementById('authGateTabRegister');
  const authGateTabGuest = document.getElementById('authGateTabGuest');
  const authGateCloseBtn = document.getElementById('authGateCloseBtn');
  const authGateLoginForm = document.getElementById('authGateLoginForm');
  const authGateRegisterForm = document.getElementById('authGateRegisterForm');
  const btnGateDoLogin = document.getElementById('btnGateDoLogin');
  const btnGateDoRegister = document.getElementById('btnGateDoRegister');
  const authGateLoginStatus = document.getElementById('authGateLoginStatus');

  document.querySelectorAll('#authFullscreenGate .auth-password-toggle').forEach((button) => {
    const passwordInput = document.getElementById(button.dataset.passwordTarget);
    if (!passwordInput) return;
    button.addEventListener('click', () => {
      const reveal = passwordInput.type === 'password';
      passwordInput.type = reveal ? 'text' : 'password';
      button.setAttribute('aria-pressed', String(reveal));
      button.setAttribute('aria-label', reveal ? 'Şifreyi gizle' : 'Şifreyi göster');
      button.title = reveal ? 'Şifreyi gizle' : 'Şifreyi göster';
      button.innerHTML = `<i class="fa-regular ${reveal ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i>`;
      passwordInput.focus();
    });
  });

  [
    ['gateLoginPass', 'gateLoginCapsWarning'],
    ['gateRegPass', 'gateRegCapsWarning'],
  ].forEach(([inputId, warningId]) => {
    const input = document.getElementById(inputId);
    const warning = document.getElementById(warningId);
    if (!input || !warning) return;
    const updateCapsWarning = (event) => {
      warning.hidden = !input.matches(':focus') || !event.getModifierState?.('CapsLock');
    };
    input.addEventListener('keydown', updateCapsWarning);
    input.addEventListener('keyup', updateCapsWarning);
    input.addEventListener('focus', (event) => updateCapsWarning(event));
    input.addEventListener('blur', () => { warning.hidden = true; });
  });

  const settingsUserProfileBar = document.getElementById('settingsUserProfileBar');
  const settingsUserAvatar = document.getElementById('settingsUserAvatar');
  const settingsUserName = document.getElementById('settingsUserName');
  const settingsUserHandle = document.getElementById('settingsUserHandle');
  const adminSettingsNav = document.getElementById('adminSettingsNav');

  const paneAccountAvatar = document.getElementById('paneAccountAvatar');
  const paneAccountName = document.getElementById('paneAccountName');
  const paneAccountEmail = document.getElementById('paneAccountEmail');
  const btnOpenAuthGateModal = document.getElementById('btnOpenAuthGateModal');
  const btnSettingsSyncNow = document.getElementById('btnSettingsSyncNow');
  const settingsAccountProfilesList = document.getElementById('settingsAccountProfilesList');
  const btnAccountLogout = document.getElementById('btnAccountLogout');
  const btnOpenAccountDelete = document.getElementById('btnOpenAccountDelete');
  const accountDeleteCard = document.getElementById('accountDeleteConfirmCard');
  const accountDeletePassword = document.getElementById('accountDeletePassword');
  const accountDeletePhrase = document.getElementById('accountDeletePhrase');
  const accountDeleteStatus = document.getElementById('accountDeleteStatus');
  const btnConfirmAccountDelete = document.getElementById('btnConfirmAccountDelete');

  // Profil Barlarını Güncelle (Ayarların Sol Altındaki Bar & Hesap Sekmesi)
  function updateProfileUI() {
    let name = 'Misafir';
    let handle = '@misafir';
    let initial = 'M';

    if (currentAuthSession && currentAuthSession.user) {
      name =
        currentAuthSession.user.user_metadata?.username ||
        currentAuthSession.user.email.split('@')[0];
      handle = `@${currentAuthSession.user.email.split('@')[0]}`;
      initial = name.charAt(0).toUpperCase();
    }

    if (settingsUserAvatar)
      settingsUserAvatar.innerHTML = `${initial}<span class="online-dot"></span>`;
    if (settingsUserName) settingsUserName.textContent = name;
    if (settingsUserHandle) settingsUserHandle.textContent = handle;

    if (paneAccountAvatar) paneAccountAvatar.textContent = initial;
    if (paneAccountName) paneAccountName.textContent = name;
    if (paneAccountEmail)
      paneAccountEmail.textContent = currentAuthSession?.user?.email || 'Yerel Profil';
    const isAdminAccount = currentAuthSession?.user?.email?.trim().toLowerCase() === SUNIFY_ADMIN_EMAIL;
    const signedIn = Boolean(currentAuthSession?.user);
    if (btnAccountLogout) btnAccountLogout.hidden = !signedIn;
    if (btnOpenAccountDelete) btnOpenAccountDelete.hidden = !signedIn;
    if (accountDeleteCard) accountDeleteCard.hidden = true;
    if (adminSettingsNav) adminSettingsNav.hidden = !isAdminAccount;
    document.dispatchEvent(new CustomEvent('sunify:auth-changed', { detail: { isAdmin: isAdminAccount } }));
  }
  window.sunifyUpdateProfileUI = updateProfileUI;

  // Ayarların sol altındaki profile tıklayınca doğrudan Hesap sekmesini aç
  if (settingsUserProfileBar) {
    settingsUserProfileBar.onclick = () => {
      openSettingsWindow();
      document.querySelector('.settings-menu-item[data-tab="account"]')?.click();
    };
  }

  if (btnOpenAuthGateModal) {
    btnOpenAuthGateModal.onclick = () => {
      authGateTabLogin.click();
      openAuthGate();
    };
  }

  if (btnSettingsSyncNow) {
    btnSettingsSyncNow.onclick = async () => {
      btnSettingsSyncNow.disabled = true;
      btnSettingsSyncNow.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Eşitleniyor...';
      try {
        const pushed = await syncToCloudSilently();
        if (!pushed) throw new Error('Buluta yazılamadı. Bağlantıyı ve Supabase migration durumunu kontrol edin.');
        const pulled = await pullFromCloud();
        if (!pulled) throw new Error('Buluta yazıldı ancak sunucudan doğrulanmış veri alınamadı.');
        showAppNotification('Bulut Eşitlemesi', 'Hesap verilerin eşitlendi.');
      } catch (error) {
        showAppNotification('Eşitleme tamamlanamadı', error.message || 'Supabase ile bağlantı kurulamadı.', true);
      } finally {
        btnSettingsSyncNow.disabled = false;
        btnSettingsSyncNow.innerHTML =
          '<i class="fa-solid fa-rotate" style="margin-right:6px;"></i>Şimdi Eşitle';
      }
    };
  }

  btnAccountLogout?.addEventListener('click', async () => {
    btnAccountLogout.disabled = true;
    const session = currentAuthSession;
    let remoteLogoutConfirmed = true;
    try {
      if (session?.access_token) {
        const response = await fetch(`${API_BASE}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ refresh_token: session.refresh_token || '' }),
          signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Oturum sunucuda kapatılamadı.');
        remoteLogoutConfirmed = session.access_token.startsWith('local_session_')
          ? Boolean(result.localSessionRevoked)
          : Boolean(result.cloudSessionRevoked);
      }
    } catch (error) {
      remoteLogoutConfirmed = false;
      console.warn('Çıkış sırasında uzak oturum sonlandırılamadı:', error.message);
    }
    logoutCurrentAccount(session);
    renderAccountProfiles();
    showAppNotification(
      remoteLogoutConfirmed ? 'Çıkış yapıldı' : 'Bu cihazdan çıkış yapıldı',
      remoteLogoutConfirmed ? 'Oturum sonlandırıldı; tekrar giriş yapman gerekecek.' : 'Bu cihazdaki oturum bilgileri kaldırıldı; sunucu oturumu bağlantı kurulunca sonlandırılabilir.',
      !remoteLogoutConfirmed,
    );
    btnAccountLogout.disabled = false;
  });
  btnOpenAccountDelete?.addEventListener('click', () => {
    if (!currentAuthSession?.user || !accountDeleteCard) return;
    accountDeleteCard.hidden = false;
    accountDeletePassword.value = '';
    accountDeletePhrase.value = '';
    accountDeleteStatus.hidden = true;
    accountDeletePassword.focus();
  });
  document.getElementById('btnCancelAccountDelete')?.addEventListener('click', () => {
    if (accountDeleteCard) accountDeleteCard.hidden = true;
  });
  btnConfirmAccountDelete?.addEventListener('click', async () => {
    const session = currentAuthSession;
    const password = accountDeletePassword?.value || '';
    const phrase = accountDeletePhrase?.value.trim().toLocaleUpperCase('tr-TR') || '';
    if (!session?.user) return;
    if (!password || phrase !== 'HESABIMI SİL') {
      accountDeleteStatus.textContent = 'Şifreni gir ve onay metnini aynen yaz.';
      accountDeleteStatus.hidden = false;
      return;
    }
    btnConfirmAccountDelete.disabled = true;
    btnConfirmAccountDelete.textContent = 'Siliniyor…';
    accountDeleteStatus.hidden = true;
    try {
      const response = await fetch(`${API_BASE}/auth/delete-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Hesap silinemedi.');
      activateAccountData(null);
      SunifyAccountStore.forget(session);
      ACCOUNT_DATA_KEYS.forEach((key) => localStorage.removeItem(accountStorageKey(key, session)));
      knownProfiles = SunifyAccountStore.list();
      updateProfileUI();
      renderAccountProfiles();
      accountDeleteCard.hidden = true;
      showAppNotification('Hesap silindi', 'Hesabın ve bu cihazdaki kullanıcı verilerin kaldırıldı.');
    } catch (error) {
      accountDeleteStatus.textContent = error.message || 'Hesap silme tamamlanamadı.';
      accountDeleteStatus.hidden = false;
    } finally {
      btnConfirmAccountDelete.disabled = false;
      btnConfirmAccountDelete.textContent = 'Hesabı sil';
    }
  });

  // AUTH FULLSCREEN GATE (GİRİŞ / KAYIT PENCERESİ)
  function openAuthGate() {
    authFullscreenGate.classList.add('active');
  }

  function logoutCurrentAccount(sessionToForget = null) {
    if (sessionToForget) SunifyAccountStore.forget(sessionToForget);
    activateAccountData(null);
    updateProfileUI();
  }

  authGateTabLogin.onclick = () => {
    authGateTabLogin.classList.add('active');
    authGateTabRegister.classList.remove('active');
    authGateLoginForm.style.display = 'block';
    authGateRegisterForm.style.display = 'none';
    if (authGateLoginStatus) authGateLoginStatus.hidden = true;
  };

  authGateTabRegister.onclick = () => {
    authGateTabRegister.classList.add('active');
    authGateTabLogin.classList.remove('active');
    authGateLoginForm.style.display = 'none';
    authGateRegisterForm.style.display = 'block';
  };

  authGateTabGuest.onclick = () => {
    authFullscreenGate.classList.remove('active');
    localStorage.setItem('sunify_initial_auth_prompt_seen', 'true');
    logoutCurrentAccount();
    showAppNotification('Misafir Modu', 'Sunify yerel modda başlatıldı.');
    renderAccountProfiles();
  };
  authGateCloseBtn?.addEventListener('click', () => {
    authFullscreenGate.classList.remove('active');
    localStorage.setItem('sunify_initial_auth_prompt_seen', 'true');
    if (!currentAuthSession?.user) {
      logoutCurrentAccount();
      renderAccountProfiles();
      showAppNotification('Misafir Modu', 'Sunify yerel modda başlatıldı.');
    }
  });

  // Giriş formu hem düğmeyle hem Enter tuşuyla aynı giriş yolunu kullanır.
  authGateLoginForm.onsubmit = async (event) => {
    event.preventDefault();
    if (btnGateDoLogin.disabled) return;
    const email = document.getElementById('gateLoginEmail').value.trim();
    const password = document.getElementById('gateLoginPass').value;
    if (!email || !password) {
      const message = 'E-posta ve şifre girin.';
      if (authGateLoginStatus) {
        authGateLoginStatus.textContent = message;
        authGateLoginStatus.classList.add('error');
        authGateLoginStatus.hidden = false;
      }
      showAppNotification('Uyarı', message, true);
      return;
    }

    if (authGateLoginStatus) {
      authGateLoginStatus.textContent = 'Hesap doğrulanıyor…';
      authGateLoginStatus.classList.remove('error');
      authGateLoginStatus.hidden = false;
    }
    btnGateDoLogin.disabled = true;
    btnGateDoLogin.textContent = 'Giriş yapılıyor...';
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
    if (res.ok && data.session) {
        const user = data.user || data.session.user;
        if (!user?.email) throw new Error('Giriş oturumu kullanıcı bilgilerini içermiyor. Tekrar giriş yapın.');
        const session = { ...data.session, user: { ...data.session.user, ...user } };
        saveToKnownProfiles({
          email: user.email,
          username: user.user_metadata?.username || user.email.split('@')[0],
          session,
        });
        activateAccountData(session);

        localStorage.setItem('sunify_initial_auth_prompt_seen', 'true');
        authFullscreenGate.classList.remove('active');
        updateProfileUI();
        renderAccountProfiles();
        pullFromCloud();
        showAppNotification('Giriş Başarılı', `${user.user_metadata?.username || user.email.split('@')[0]} hesabı açıldı.`);
      } else {
        throw new Error(data.error || 'E-posta veya şifre doğrulanamadı.');
      }
    } catch (err) {
      if (authGateLoginStatus) {
        authGateLoginStatus.textContent = err.message || 'Giriş tamamlanamadı.';
        authGateLoginStatus.classList.add('error');
        authGateLoginStatus.hidden = false;
      }
      showAppNotification('Hata', err.message, true);
    } finally {
      btnGateDoLogin.disabled = false;
      btnGateDoLogin.textContent = 'Giriş Yap';
    }
  };

  // Kayıt Ol Butonu
  authGateRegisterForm.onsubmit = async (event) => {
    event.preventDefault();
    if (btnGateDoRegister.disabled) return;
    const registerStatus = document.getElementById('authGateRegisterStatus');
    const showRegisterError = (message) => {
      if (registerStatus) { registerStatus.textContent = message; registerStatus.classList.add('error'); registerStatus.hidden = false; }
      showAppNotification('Uyarı', message, true);
    };
    const username = document.getElementById('gateRegUsername').value.trim();
    const email = document.getElementById('gateRegEmail').value.trim();
    const password = document.getElementById('gateRegPass').value;

    if (!email || !password) return showRegisterError('Lütfen e-posta ve şifre alanlarını doldurun.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showRegisterError('Geçerli bir e-posta adresi gir.');
    if (password.length < 8) return showRegisterError('Şifre en az 8 karakter olmalıdır.');
    if (password.length > 256) return showRegisterError('Şifre en fazla 256 karakter olabilir.');
    if (registerStatus) { registerStatus.hidden = true; registerStatus.classList.remove('error'); }

    btnGateDoRegister.disabled = true;
    btnGateDoRegister.textContent = 'Hesap oluşturuluyor...';
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, username }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kayıt tamamlanamadı.');
      if (data.requiresEmailConfirmation) {
        if (registerStatus) {
          registerStatus.classList.remove('error');
          registerStatus.textContent = 'Hesabın oluşturuldu. E-postandaki doğrulama bağlantısını açtıktan sonra giriş yap.';
          registerStatus.hidden = false;
        }
        authGateTabLogin.click();
        document.getElementById('gateLoginEmail').value = email;
        document.getElementById('gateLoginPass').value = '';
        showAppNotification('E-posta doğrulaması gerekli', 'Gelen kutundaki bağlantıyı onayla, ardından giriş yap.');
      } else if (data.user && data.session) {
        let accountData = data;
        // Otomatik giriş yaptır
        if (accountData.session) {
          const user = accountData.user || accountData.session.user;
          if (!user?.email) throw new Error('Hesap oluşturuldu ancak kullanıcı bilgileri alınamadı. Giriş yapmayı deneyin.');
          const session = { ...accountData.session, user: { ...accountData.session.user, ...user } };
          saveToKnownProfiles({
            email: user.email,
            username: user.user_metadata?.username || user.email.split('@')[0],
            session,
          });
          activateAccountData(session);
          localStorage.setItem('sunify_initial_auth_prompt_seen', 'true');
          authFullscreenGate.classList.remove('active');
        document.getElementById('gateLoginPass').value = '';
          updateProfileUI();
          renderAccountProfiles();
          pullFromCloud();
          if (registerStatus) { registerStatus.classList.remove('error'); registerStatus.textContent = 'Hesabın oluşturuldu ve giriş yapıldı.'; registerStatus.hidden = false; }
          showAppNotification('Hesap Eklendi', data.mode === 'offline'
            ? 'Çevrimdışı hesap oluşturuldu. Bu hesap yalnızca bu bilgisayarda kullanılabilir.'
            : 'Bulut hesabı oluşturuldu ve giriş yapıldı.');
        } else {
          throw new Error('Hesap oluşturuldu ancak oturum açılamadı. Giriş sekmesinden tekrar deneyin.');
        }
      } else {
        throw new Error(data.error || 'Sunucudan geçerli kayıt yanıtı alınamadı.');
      }
    } catch (err) {
      if (registerStatus) { registerStatus.textContent = err.message || 'Kayıt tamamlanamadı.'; registerStatus.classList.add('error'); registerStatus.hidden = false; }
      showAppNotification('Hata', err.message, true);
    } finally {
      btnGateDoRegister.disabled = false;
      btnGateDoRegister.textContent = 'Kayıt Ol ve Başla';
    }
  };

  // Bilinen Profilleri Yönetme
  function saveToKnownProfiles(prof) {
    SunifyAccountStore.remember(prof.session, prof.username);
    knownProfiles = SunifyAccountStore.list();
  }

  function ensureCurrentProfileIsKnown() {
    if (!currentAuthSession) return;
    knownProfiles = SunifyAccountStore.list();
  }

  function renderAccountProfiles() {
    if (!settingsAccountProfilesList) return;
    knownProfiles = SunifyAccountStore.list();
    ensureCurrentProfileIsKnown();
    settingsAccountProfilesList.innerHTML = '';

    const makeProfileRow = ({ name, email, session, isGuest = false }) => {
      const active = isGuest ? !currentAuthSession?.user : (
        currentAuthSession?.user?.id && session?.user?.id
          ? currentAuthSession.user.id === session.user.id
          : currentAuthSession?.user?.email?.trim().toLowerCase() === email?.trim().toLowerCase()
      );
      const row = document.createElement('div');
      row.className = `settings-account-profile-row${active ? ' active' : ''}`;
      const avatar = document.createElement('div');
      avatar.className = `settings-account-profile-avatar${isGuest ? ' guest' : ''}`;
      avatar.innerHTML = isGuest ? '<i class="fa-solid fa-headphones" aria-hidden="true"></i>' : '';
      if (!isGuest) avatar.textContent = (name || email || 'U').charAt(0).toUpperCase();

      const details = document.createElement('div');
      details.className = 'settings-account-profile-details';
      const title = document.createElement('strong');
      title.textContent = name;
      const subtitle = document.createElement('span');
      subtitle.textContent = email || 'Yerel profil · çevrimdışı';
      details.append(title, subtitle);

      const action = document.createElement('button');
      action.type = 'button';
      action.className = active ? 'settings-account-current-badge' : 'settings-account-switch-btn';
      action.innerHTML = active
        ? '<i class="fa-solid fa-check" aria-hidden="true"></i> Şu an açık'
        : '<i class="fa-solid fa-arrow-right-arrow-left" aria-hidden="true"></i> Geçiş yap';
      if (!active) {
        action.onclick = () => {
          void (async () => {
            action.disabled = true;
            action.textContent = 'Oturum doğrulanıyor…';
            try {
              const validatedSession = isGuest ? null : await validateAndRefreshAccountSession(session);
              activateAccountData(validatedSession);
              updateProfileUI();
              renderAccountProfiles();
              if (!isGuest) pullFromCloud();
              showAppNotification('Hesap Değiştirildi', `${name} profiline geçildi.`);
            } catch (error) {
              action.disabled = false;
              action.innerHTML = '<i class="fa-solid fa-arrow-right-arrow-left" aria-hidden="true"></i> Geçiş yap';
              showAppNotification('Hesap oturumu doğrulanamadı', error.message || 'Yeniden giriş yapman gerekiyor.', true);
            }
          })();
        };
      } else {
        action.disabled = true;
      }

      row.append(avatar, details, action);
      settingsAccountProfilesList.appendChild(row);
    };

    let renderedSavedProfiles = 0;
    knownProfiles.forEach((profile) => {
      const user = profile?.session?.user;
      if (!user?.email || !profile.session?.access_token) return;
      renderedSavedProfiles += 1;
      makeProfileRow({
        name: profile.username || user.user_metadata?.username || user.email.split('@')[0],
        email: user.email,
        session: profile.session,
      });
    });
    if (!renderedSavedProfiles) {
      const empty = document.createElement('p');
      empty.className = 'settings-account-empty-state';
      empty.textContent = 'Henüz eklenmiş başka bir hesap yok. “Hesap Ekle / Giriş Yap” ile hesap ekleyebilirsin.';
      settingsAccountProfilesList.appendChild(empty);
    }
    makeProfileRow({ name: 'Misafir', email: '', session: null, isGuest: true });
  }

  document.addEventListener('sunify:accounts-view', renderAccountProfiles);

  // İlk kurulumda hesap ekranını bir kez göster; var olan oturum/profilleri engelleme.
  const initialAuthPromptSeen = localStorage.getItem('sunify_initial_auth_prompt_seen') === 'true';
  if (!currentAuthSession && knownProfiles.length === 0 && !initialAuthPromptSeen) {
    authGateTabLogin.click();
    authFullscreenGate.classList.add('active');
  } else {
    authFullscreenGate.classList.remove('active');
          document.getElementById('gateRegPass').value = '';
  }
  updateProfileUI();
  renderAccountProfiles();
  if (currentAuthSession?.user) pullFromCloud();
}

function setupDiscordAccountProfile() {
  const avatar = document.getElementById('rpcDiscordAvatar');
  const username = document.getElementById('rpcDiscordUsername');
  const status = document.getElementById('rpcDiscordStatus');
  if (!avatar || !username || !status) return;

  const render = (profile) => {
    if (profile?.username) {
      username.textContent = profile.username;
      status.textContent = 'Discord hesabına bağlı';
      status.style.color = '#4ade80';
      status.classList.add('discord-account-connected');
      avatar.src = profile.avatarUrl || '';
      avatar.alt = `${profile.username} Discord avatarı`;
      avatar.hidden = !profile.avatarUrl;
    } else {
      username.textContent = 'Discord bağlı değil';
      status.textContent = 'Discord masaüstü uygulamasını açın';
      status.style.color = 'rgba(255,255,255,.58)';
      status.classList.remove('discord-account-connected');
      avatar.removeAttribute('src');
      avatar.alt = 'Discord avatarı yok';
      avatar.hidden = true;
    }
  };

  render(null);
  window.sunifyAPI?.getDiscordAccountProfile?.().then(render).catch(() => {});
  window.sunifyAPI?.onDiscordAccountProfile?.(render);
}

setupDiscordAccountProfile();

// Buluta Sessiz Veri Gönderme (Push)
let accountSyncQueue = Promise.resolve();
async function syncToCloudSilently() {
  if (accountCloudSyncTimer) {
    clearTimeout(accountCloudSyncTimer);
    accountCloudSyncTimer = null;
  }
  const session = currentAuthSession;
  if (!session?.access_token) return false;
  const payload = JSON.stringify({
    playlists: customPlaylists,
    likedTracks,
    listeningStats: trackAnalytics,
  });
  const performSync = async () => {
    try {
      const response = await fetch(`${API_BASE}/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: payload,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Senkronizasyon gönderilemedi.');
      return true;
    } catch (error) {
      console.warn('Bulut eşitleme gönderilemedi:', error.message);
      return false;
    }
  };
  const queuedSync = accountSyncQueue.catch(() => false).then(performSync);
  accountSyncQueue = queuedSync.then(() => undefined, () => undefined);
  return queuedSync;
}

// Buluttan Verileri Çekme (Pull)
async function pullFromCloud() {
  if (!currentAuthSession || !currentAuthSession.access_token) return false;
  const originalSession = currentAuthSession;
  try {
    const validatedSession = await validateAndRefreshAccountSession(originalSession);
    if (currentAuthSession?.user?.id !== originalSession.user?.id) return false;
    if (validatedSession !== originalSession) {
      currentAuthSession = SunifyAccountStore.setActive(validatedSession);
      knownProfiles = SunifyAccountStore.list();
      window.sunifyUpdateProfileUI?.();
    }
  } catch (error) {
    if (currentAuthSession?.user?.id === originalSession.user?.id) {
      console.warn('Hesap oturumu doğrulanamadı:', error.message);
      showAppNotification('Oturum doğrulanamadı', error.message || 'Tekrar giriş yapman gerekiyor.', true);
    }
    return false;
  }
  const requestingUserId = currentAuthSession.user?.id;
  accountCloudSyncPaused += 1;

  try {
    if (currentAuthSession.user?.email?.trim().toLowerCase() === SUNIFY_ADMIN_EMAIL) {
      const resetMarker = `sunify_account_partition_reset_${requestingUserId}`;
      if (!localStorage.getItem(resetMarker)) {
        const resetResponse = await fetch(`${API_BASE}/sync/reset-own-data`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${currentAuthSession.access_token}` },
        });
        const resetResult = await resetResponse.json();
        if (!resetResponse.ok) throw new Error(resetResult.error || 'Hesap verileri ayrıştırılamadı.');
        if (currentAuthSession?.user?.id !== requestingUserId) return false;
        customPlaylists = [];
        likedTracks = [];
        recentHistory = [];
        trackAnalytics = {};
        searchHistory = [];
        ACCOUNT_DATA_KEYS.forEach((key) => writeAccountJson(key, key === 'sunify_custom_playlists' || key === 'sunify_liked' || key === 'sunify_recent_tracks' || key === 'sunify_search_history' ? [] : {}));
        localStorage.setItem(resetMarker, 'true');
        renderLibraryItems();
        renderRecentHistory();
        renderDailyMixes();
        renderNowPlayingDualGrid();
        renderListeningStats();
        updateLikeButtonUI();
      }
    }

    const res = await fetch(`${API_BASE}/sync/pull`, {
      headers: {
        Authorization: `Bearer ${currentAuthSession.access_token}`,
      },
    });
    const data = await res.json();
    if (currentAuthSession?.user?.id !== requestingUserId) return false;
    if (!res.ok) throw new Error(data.error || 'Bulut verisi alınamadı.');

    if (Array.isArray(data.playlists)) {
      customPlaylists = data.playlists.map((cloudPlaylist) => ({
        ...cloudPlaylist,
        cover: cloudPlaylist.cover || cloudPlaylist.cover_url || '',
        tracks: Array.isArray(cloudPlaylist.tracks) ? cloudPlaylist.tracks : [],
      }));
      writeAccountJson('sunify_custom_playlists', customPlaylists);
      renderLibraryItems();
    }

    const analytics = data.analytics || {};
    likedTracks = Array.isArray(analytics.liked_tracks) ? analytics.liked_tracks : [];
    trackAnalytics = analytics.listening_stats && typeof analytics.listening_stats === 'object'
      ? analytics.listening_stats : {};
    applyListenCountMigration();
    recentHistory = Object.values(trackAnalytics)
      .filter((entry) => entry && entry.title)
      .sort((a, b) => new Date(b.lastPlayed || 0) - new Date(a.lastPlayed || 0))
      .slice(0, 14)
      .map((entry) => ({
        title: entry.title,
        artist: entry.artist || '',
        thumbnail: entry.thumbnail || '',
        duration: entry.duration || 0,
        id: entry.id || '',
        query: entry.query || `${entry.artist || ''} ${entry.title}`.trim(),
      }));
    writeAccountJson('sunify_liked', likedTracks);
    writeAccountJson('sunify_track_analytics', trackAnalytics);
    writeAccountJson('sunify_recent_tracks', recentHistory);
    writeAccountJson('sunify_listening_stats', trackAnalytics);
    renderLibraryItems();
    renderRecentHistory();
    renderDailyMixes();
    renderNowPlayingDualGrid();
    renderListeningStats();
    updateLikeButtonUI();
    return true;
  } catch (err) {
    console.warn('Bulut çekme hatası:', err.message);
    return false;
  } finally {
    accountCloudSyncPaused = Math.max(0, accountCloudSyncPaused - 1);
  }
}

// Başlat
initAccountSystem();






// --- GELİŞMİŞ OYNATMA, MEDYA OTURUMU, UYKU ZAMANLAYICISI VE ÖZET ---
(function initAdvancedSunifyFeatures() {
  // 1. Windows Media Session API (Klavye medya tuşları + Windows ses kaplaması)
  function syncWindowsMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      if (currentTrack && typeof MediaMetadata !== 'undefined') {
        const artwork = currentTrack.thumbnail && currentTrack.thumbnail.startsWith('http')
          ? [{ src: currentTrack.thumbnail, sizes: '512x512', type: 'image/jpeg' }]
          : [];
        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.title || 'Sunify',
          artist: currentTrack.artist || 'Sunify',
          album: 'Sunify',
          artwork,
        });
      }
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
      const duration = Number(audio.duration) || Number(currentTrack?.duration) || 0;
      const position = Math.max(0, Math.min(duration || 0, Number(audio.currentTime) || 0));
      if (duration > 0 && typeof navigator.mediaSession.setPositionState === 'function') {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: audio.playbackRate || 1,
          position,
        });
      }
    } catch {}
  }

  if ('mediaSession' in navigator) {
    const bindAction = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
    };
    bindAction('play', () => { if (audio.paused) playPauseBtn?.click(); });
    bindAction('pause', () => { if (!audio.paused) playPauseBtn?.click(); });
    bindAction('previoustrack', () => prevBtn?.click());
    bindAction('nexttrack', () => nextBtn?.click());
    bindAction('seekto', (details) => {
      if (details && Number.isFinite(details.seekTime)) seekAudioTo(details.seekTime);
    });
    bindAction('seekbackward', (details) => {
      const offset = Number(details?.seekOffset) || 5;
      seekAudioTo(Math.max(0, (audio.currentTime || 0) - offset));
    });
    bindAction('seekforward', (details) => {
      const offset = Number(details?.seekOffset) || 5;
      const duration = Number(audio.duration) || Number(currentTrack?.duration) || 0;
      seekAudioTo(Math.min(duration, (audio.currentTime || 0) + offset));
    });
  }

  audio.addEventListener('play', syncWindowsMediaSession);
  audio.addEventListener('pause', syncWindowsMediaSession);
  audio.addEventListener('loadedmetadata', syncWindowsMediaSession);
  audio.addEventListener('ratechange', syncWindowsMediaSession);

  // 2. Oynatma hızı (0.85x - 1.25x)
  let currentPlaybackSpeed = Number(localStorage.getItem('sunify_playback_speed')) || 1;
  function applyPlaybackSpeed(speed) {
    const safeSpeed = [0.85, 1, 1.15, 1.25].includes(Number(speed)) ? Number(speed) : 1;
    currentPlaybackSpeed = safeSpeed;
    localStorage.setItem('sunify_playback_speed', String(safeSpeed));
    audio.defaultPlaybackRate = safeSpeed;
    audio.playbackRate = safeSpeed;
    document.querySelectorAll('#settingPlaybackSpeed .pill-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.val) === safeSpeed);
    });
  }
  applyPlaybackSpeed(currentPlaybackSpeed);
  audio.addEventListener('loadedmetadata', () => {
    audio.playbackRate = currentPlaybackSpeed;
  });
  document.querySelectorAll('#settingPlaybackSpeed .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyPlaybackSpeed(Number(btn.dataset.val)));
  });

  // 3. Ses Seviyesi Dengeleme (DynamicsCompressorNode ile Loudness Normalization)
  let loudnessCompressor = null;
  let normalizationEnabled = localStorage.getItem('sunify_audio_normalize') === 'true';
  const normalizeToggle = document.getElementById('settingAudioNormalize');
  if (normalizeToggle) normalizeToggle.checked = normalizationEnabled;

  function applyLoudnessNormalization(enabled) {
    normalizationEnabled = Boolean(enabled);
    localStorage.setItem('sunify_audio_normalize', String(normalizationEnabled));
    if (normalizeToggle) normalizeToggle.checked = normalizationEnabled;
    if (!normalizationEnabled && !equalizerFilters.length) return;
    try {
      initializeAudioEqualizer();
      const lastFilter = equalizerFilters[equalizerFilters.length - 1];
      if (!lastFilter || !audioContext) return;
      if (!loudnessCompressor) {
        loudnessCompressor = audioContext.createDynamicsCompressor();
        loudnessCompressor.threshold.value = -24;
        loudnessCompressor.knee.value = 30;
        loudnessCompressor.ratio.value = 6;
        loudnessCompressor.attack.value = 0.005;
        loudnessCompressor.release.value = 0.25;
      }
      try { lastFilter.disconnect(); } catch {}
      try { loudnessCompressor.disconnect(); } catch {}
      if (normalizationEnabled) {
        lastFilter.connect(loudnessCompressor);
        loudnessCompressor.connect(audioContext.destination);
      } else {
        lastFilter.connect(audioContext.destination);
      }
    } catch (err) {
      console.warn('Ses dengeleme etkinleştirilemedi:', err.message);
    }
  }
  if (normalizationEnabled) applyLoudnessNormalization(true);
  normalizeToggle?.addEventListener('change', (e) => applyLoudnessNormalization(e.target.checked));

  // 4. Yumuşak Geçiş (Crossfade)
  let crossfadeSeconds = Number(localStorage.getItem('sunify_crossfade_seconds')) || 0;
  let crossfadeActive = false;
  let preFadeVolume = null;

  function setCrossfadeSeconds(sec) {
    const safeSec = [0, 3, 5, 8].includes(Number(sec)) ? Number(sec) : 0;
    crossfadeSeconds = safeSec;
    localStorage.setItem('sunify_crossfade_seconds', String(safeSec));
    document.querySelectorAll('#settingCrossfadeSeconds .pill-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.val) === safeSec);
    });
  }
  setCrossfadeSeconds(crossfadeSeconds);
  document.querySelectorAll('#settingCrossfadeSeconds .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => setCrossfadeSeconds(Number(btn.dataset.val)));
  });

  // 5. Uyku Zamanlayıcısı (15/30/60 dk veya Şarkı sonu)
  let sleepTimerMode = '0';
  let sleepTimerDeadline = 0;
  let sleepTimerInterval = null;
  const sleepStatusEl = document.getElementById('sleepTimerStatusText');

  function updateSleepTimerStatus() {
    if (!sleepStatusEl) return;
    if (sleepTimerMode === '0') {
      sleepStatusEl.textContent = 'Belirlenen süre sonunda müziği otomatik olarak durdurur.';
    } else if (sleepTimerMode === 'end') {
      sleepStatusEl.textContent = 'Etkin: Çalan şarkı bittiğinde müzik otomatik durdurulacak.';
    } else if (sleepTimerDeadline > Date.now()) {
      const remainingSec = Math.max(0, Math.ceil((sleepTimerDeadline - Date.now()) / 1000));
      const mins = Math.floor(remainingSec / 60);
      const secs = remainingSec % 60;
      sleepStatusEl.textContent = `Etkin: ${mins}:${String(secs).padStart(2, '0')} sonra müzik durdurulacak.`;
    }
  }

  function setSleepTimer(mode) {
    sleepTimerMode = String(mode || '0');
    if (sleepTimerInterval) {
      clearInterval(sleepTimerInterval);
      sleepTimerInterval = null;
    }
    document.querySelectorAll('#settingSleepTimer .pill-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.val === sleepTimerMode);
    });
    if (sleepTimerMode === '0' || sleepTimerMode === 'end') {
      sleepTimerDeadline = 0;
      updateSleepTimerStatus();
      return;
    }
    const minutes = Number(sleepTimerMode) || 0;
    sleepTimerDeadline = Date.now() + minutes * 60 * 1000;
    updateSleepTimerStatus();
    sleepTimerInterval = setInterval(() => {
      if (Date.now() >= sleepTimerDeadline) {
        setSleepTimer('0');
        if (!audio.paused) audio.pause();
        showAppNotification('Uyku zamanlayıcısı', 'Süre doldu, müzik duraklatıldı.');
      } else {
        updateSleepTimerStatus();
      }
    }, 1000);
  }

  document.querySelectorAll('#settingSleepTimer .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => setSleepTimer(btn.dataset.val));
  });

  // Crossfade & Şarkı sonu uyku zamanlayıcısı takibi
  audio.addEventListener('timeupdate', () => {
    if (!currentTrack || !isPlaying || document.body.classList.contains('is-seeking') || pendingSeekTarget !== null) return;
    const duration = Number(audio.duration) || Number(currentTrack.duration) || 0;
    const current = Number(audio.currentTime) || 0;
    if (!(duration > 15)) return;
    const remaining = duration - current;

    if (sleepTimerMode === 'end' && remaining <= 0.35) {
      setSleepTimer('0');
      audio.pause();
      showAppNotification('Uyku zamanlayıcısı', 'Şarkı tamamlandı, oynatma durduruldu.');
      return;
    }

    if (crossfadeSeconds > 0 && repeatMode !== 'one' && sleepTimerMode !== 'end' && remaining <= crossfadeSeconds && remaining > 0.15) {
      if (!crossfadeActive) {
        crossfadeActive = true;
        preFadeVolume = Number(localStorage.getItem('sunify_volume')) || audio.volume || 0.8;
      }
      const ratio = Math.max(0.05, Math.min(1, remaining / crossfadeSeconds));
      audio.volume = Math.max(0, Math.min(1, (preFadeVolume || 0.8) * ratio));
    } else if (crossfadeActive && remaining > crossfadeSeconds + 1) {
      crossfadeActive = false;
      if (preFadeVolume !== null) audio.volume = preFadeVolume;
    }
  });

  audio.addEventListener('emptied', () => {
    if (crossfadeActive && preFadeVolume !== null) {
      audio.volume = preFadeVolume;
    }
    crossfadeActive = false;
  });

  // 6. Kapatınca sistem tepsisine küçült ayarı
  const closeToTrayToggle = document.getElementById('settingCloseToTray');
  const savedCloseToTray = localStorage.getItem('sunify_close_to_tray') !== 'false';
  if (closeToTrayToggle) closeToTrayToggle.checked = savedCloseToTray;
  window.sunifyAPI?.updateCloseToTray?.(savedCloseToTray);
  closeToTrayToggle?.addEventListener('change', (e) => {
    const enabled = Boolean(e.target.checked);
    localStorage.setItem('sunify_close_to_tray', String(enabled));
    window.sunifyAPI?.updateCloseToTray?.(enabled);
  });

  // 7. Sunify Dinleme Özeti (Wrapped Modal)
  const wrappedModal = document.getElementById('wrappedModal');
  const openWrappedBtn = document.getElementById('openWrappedModalBtn');
  const closeWrappedBtn = document.getElementById('closeWrappedModalBtn');
  const wrappedBody = document.getElementById('wrappedModalBody');

  function renderWrappedSummary() {
    if (!wrappedBody) return;
    const entries = Object.values(trackAnalytics || {}).filter((e) => e && e.title);
    const totalPlays = entries.reduce((s, e) => s + (Number(e.playCount) || 0), 0);
    const totalMinutes = Math.round(entries.reduce((s, e) => s + (Number(e.totalSeconds) || 0), 0) / 60);
    const topTracks = [...entries]
      .filter((e) => (Number(e.playCount) || 0) > 0)
      .sort((a, b) => (Number(b.playCount) || 0) - (Number(a.playCount) || 0))
      .slice(0, 5);
    const artistCounts = new Map();
    entries.forEach((e) => {
      const count = Number(e.playCount) || 0;
      if (count > 0) {
        const name = e.artist || 'Bilinmeyen Sanatçı';
        artistCounts.set(name, (artistCounts.get(name) || 0) + count);
      }
    });
    const topArtists = [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

    const dayFreq = new Map();
    entries.forEach((e) => (e.days || []).forEach((d) => dayFreq.set(d, (dayFreq.get(d) || 0) + 1)));
    const favDay = [...dayFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Henüz belirlenmedi';

    wrappedBody.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
        <div style="padding:12px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)">
          <div style="font-size:11px;opacity:.7">Tam Dinlenen Şarkı</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px">${totalPlays}</div>
        </div>
        <div style="padding:12px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)">
          <div style="font-size:11px;opacity:.7">Toplam Süre</div>
          <div style="font-size:22px;font-weight:800;margin-top:4px">${totalMinutes} dk</div>
        </div>
        <div style="padding:12px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)">
          <div style="font-size:11px;opacity:.7">En Aktif Gün</div>
          <div style="font-size:16px;font-weight:800;margin-top:6px">${favDay}</div>
        </div>
      </div>
      <div style="padding:14px;border-radius:14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08)">
        <div style="font-size:12px;font-weight:700;opacity:.75;margin-bottom:8px">EN ÇOK DİNLEDİĞİN PARÇALAR</div>
        ${topTracks.length
          ? topTracks.map((t, i) => `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05)"><span><strong>${i + 1}.</strong> ${t.title} <span style="opacity:.65">· ${t.artist || ''}</span></span><strong>${t.playCount} kez</strong></div>`).join('')
          : '<div style="font-size:13px;opacity:.7">Bir şarkıyı atlamadan sonuna kadar dinlediğinde burada listelenir.</div>'}
      </div>
      <div style="padding:14px;border-radius:14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08)">
        <div style="font-size:12px;font-weight:700;opacity:.75;margin-bottom:8px">FAVORİ SANATÇILARIN</div>
        ${topArtists.length
          ? topArtists.map(([name, count], i) => `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px"><span><strong>${i + 1}.</strong> ${name}</span><span>${count} tam dinleme</span></div>`).join('')
          : '<div style="font-size:13px;opacity:.7">Henüz tam dinleme verisi yok.</div>'}
      </div>
    `;
  }

  openWrappedBtn?.addEventListener('click', () => {
    renderWrappedSummary();
    wrappedModal?.classList.add('active');
  });
  closeWrappedBtn?.addEventListener('click', () => wrappedModal?.classList.remove('active'));
  wrappedModal?.addEventListener('click', (e) => {
    if (e.target === wrappedModal) wrappedModal.classList.remove('active');
  });

  // 8. Pencere alta alındığında (Minimize) ve Düşük Kaynak Modunda GPU/CPU/VRAM tasarrufu
  function applyLowPowerMode(enabled) {
    const active = Boolean(enabled);
    document.body.classList.toggle('perf-low-power', active);
    localStorage.setItem('sunify_low_power_mode', String(active));
    const toggle = document.getElementById('settingLowPowerMode');
    if (toggle) toggle.checked = active;
  }
  const savedLowPower = localStorage.getItem('sunify_low_power_mode') === 'true';
  applyLowPowerMode(savedLowPower);
  document.getElementById('settingLowPowerMode')?.addEventListener('change', (e) => {
    applyLowPowerMode(e.target.checked);
  });

  function setWindowMinimizedState(minimized) {
    isWindowMinimized = Boolean(minimized);
    document.body.classList.toggle('window-minimized', isWindowMinimized);
    if (isWindowMinimized) {
      stopLyricsSyncAnimation();
    } else {
      if (lyricsOverlay?.classList.contains('active') && !audio.paused) {
        startLyricsSyncAnimation();
      }
      if (viewHome?.classList.contains('active')) {
        renderListeningStats();
      }
    }
  }
  window.sunifyAPI?.onWindowMinimizedState?.(setWindowMinimizedState);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLyricsSyncAnimation();
    } else if (!isWindowMinimized && lyricsOverlay?.classList.contains('active') && !audio.paused) {
      startLyricsSyncAnimation();
    }
  });

  // 9. Küçük kapak görsellerinde VRAM ve decode yükünü düşürme (lazy loading + async decode + hqdefault)
  function optimizeImageElement(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (img.id === 'currentThumb' || img.id === 'lyricsBigCover' || img.id === 'plHeroImg' || img.id === 'artistPageImage') {
      img.decoding = 'async';
      return;
    }
    img.loading = 'lazy';
    img.decoding = 'async';
    const src = img.getAttribute('src') || '';
    if (src.includes('i.ytimg.com/vi/') && (src.includes('/maxresdefault.') || src.includes('/hq720.'))) {
      img.src = src.replace(/\/(?:maxresdefault|hq720)\.(jpg|webp)/, '/hqdefault.$1');
    }
  }
  document.querySelectorAll('img').forEach(optimizeImageElement);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLImageElement) optimizeImageElement(node);
        else if (node instanceof Element) node.querySelectorAll('img').forEach(optimizeImageElement);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
