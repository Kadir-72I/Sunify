// renderer.js
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

const SUNIFY_ADMIN_EMAIL = 'abdulkadirguness72@gmail.com';
const LEGACY_ADMIN_EMAIL = 'abdulkadirgunes72jdheieksdj@gmail.com';

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
  let activeSession = normalizeSession(readStoredJson(SESSION_KEY, null));

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
    const stored = readStoredJson(PROFILES_KEY, []);
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
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
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
    if (activeSession) localStorage.setItem(SESSION_KEY, JSON.stringify(activeSession));
    else localStorage.removeItem(SESSION_KEY);
    return activeSession;
  }

  if (activeSession) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(activeSession)); } catch {}
  }
  return { getActive: () => activeSession, normalizeSession, setActive, list, remember };
})();

let currentAuthSession = SunifyAccountStore.getActive();
let knownProfiles = SunifyAccountStore.list();
const ACCOUNT_DATA_KEYS = [
  'sunify_search_history',
  'sunify_recent_tracks',
  'sunify_liked',
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
    return true;
  } catch (error) {
    console.warn(`Hesap verisi kaydedilemedi (${key}).`, error);
    return false;
  }
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

function enqueueTrackDownload(track) {
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
    activeDownloads += 1;
    downloadTrackFile(track).finally(() => {
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
let isRepeat = false;
let parsedLyrics = [];
let lyricsHaveTimestamps = false;
let searchHistory = readAccountJson('sunify_search_history', [], currentAuthSession, true);
let recentHistory = readAccountJson('sunify_recent_tracks', [], currentAuthSession, true);
let likedTracks = readAccountJson('sunify_liked', [], currentAuthSession, true);
let currentTheme = localStorage.getItem('sunify_theme') || 'dark';
let activeLibraryFilter = 'all';

// KAPSAMLI DİNLEME VERİLERİ (Analytics: Dinleme sayısı, süresi, günleri, playlist sayıları)
let trackAnalytics = readAccountJson('sunify_track_analytics', {}, currentAuthSession, true);
let globalTopTracks = [];

function trackSongStartEvent(track) {
  if (!track || !track.title) return;
  const key = `${track.artist || ''} - ${track.title}`.trim().toLowerCase();
  const dayName = new Intl.DateTimeFormat('tr-TR', { weekday: 'long' }).format(new Date());

  if (!trackAnalytics[key]) {
    trackAnalytics[key] = {
      title: track.title,
      artist: track.artist,
      playCount: 0,
      totalSeconds: 0,
      days: [],
      inPlaylistsCount: 0,
      lastPlayed: new Date().toISOString(),
    };
  }

  trackAnalytics[key].playCount += 1;
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
    if (response.ok) refreshGlobalTopTracks();
  }).catch(() => {});
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
    card.className = 'listening-stat-card';
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
    if (Math.floor(nextTotal / 10) > Math.floor(previousTotal / 10)) {
      writeAccountJson('sunify_track_analytics', trackAnalytics);
      renderListeningStats();
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
const tbNavBack = document.getElementById('tbNavBack');
const tbNavForward = document.getElementById('tbNavForward');

window.sunifyAPI?.onMiniPlayerControl?.((action, value) => {
  if (action === 'toggle') playPauseBtn.click();
  if (action === 'previous') prevBtn.click();
  if (action === 'next') nextBtn.click();
  if (action === 'seek') {
    const duration = audio.duration || currentTrack?.duration || 0;
    if (duration > 0) audio.currentTime = duration * Math.max(0, Math.min(1, Number(value) || 0));
  }
});

function publishMiniPlayerState() {
  if (!window.sunifyAPI?.updateMiniPlayerState) return;
  const duration = audio?.duration || currentTrack?.duration || 0;
  const current = audio?.currentTime || 0;
  const colorValue = getComputedStyle(document.body).getPropertyValue('--cover-color-solid').trim();
  let accent = '#a78bfa';
  const rgb = colorValue.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
  if (rgb) accent = `#${rgb.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
  else if (/^#[\da-f]{6}$/i.test(colorValue)) accent = colorValue;
  window.sunifyAPI.updateMiniPlayerState({
    title: currentTrack?.title || 'Sunify',
    artist: currentTrack?.artist || 'Bir şarkı seç',
    thumbnail: currentTrack?.thumbnail || '',
    playing: Boolean(currentTrack && isPlaying),
    progress: duration > 0 ? (current / duration) * 100 : 0,
    elapsed: formatTime(current),
    duration: formatTime(duration),
    accent,
  });
}
setInterval(publishMiniPlayerState, 1000);

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

if (tbNavBack) {
  tbNavBack.onclick = () => {
    if (viewArtist?.classList.contains('active')) {
      viewArtist.classList.remove('active');
      viewHome.classList.add('active');
      navHomeBtn.classList.add('active');
      return;
    }
    window.history.back();
  };
}
if (tbNavForward) {
  tbNavForward.onclick = () => {
    window.history.forward();
  };
}

// Views & Navigation
const viewHome = document.getElementById('viewHome');
const viewPlaylistDetail = document.getElementById('viewPlaylistDetail');
const viewLibrary = document.getElementById('viewLibrary');
const viewArtist = document.getElementById('viewArtist');
const viewSettings = document.getElementById('viewSettings');

const navHomeBtn = document.getElementById('navHomeBtn');
const navSearchTriggerBtn = document.getElementById('navSearchTriggerBtn');
const navLibraryBtn = document.getElementById('navLibraryBtn');
const navSettingsBtn = document.getElementById('navSettingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');

// Spotlight Arama
const headerSearchPill = document.getElementById('headerSearchPill');
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
    tracks: [
      {
        query: '2hollis poster boy',
        title: 'poster boy',
        artist: '2hollis',
        thumbnail: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=150',
        duration: 122,
      },
      {
        query: 'PIXY LEGACY',
        title: 'LEGACY',
        artist: 'PIXY',
        thumbnail: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        duration: 135,
      },
      {
        query: "Her's Harvey",
        title: 'Harvey',
        artist: "Her's",
        thumbnail: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        duration: 212,
      },
      {
        query: 'Buckshot Fever',
        title: 'Fever',
        artist: 'Buckshot',
        thumbnail: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150',
        duration: 145,
      },
      {
        query: 'kobzx2z i just wanna be loved',
        title: 'i just wanna be loved',
        artist: 'kobzx2z, mikeeysmind',
        thumbnail: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        duration: 192,
      },
      {
        query: 'LONOWN addiction Slowed',
        title: 'addiction (Slowed)',
        artist: 'LONOWN',
        thumbnail: 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=150',
        duration: 234,
      },
      {
        query: 'ONDA ANDAR type london',
        title: 'type london',
        artist: 'ONDA ANDAR',
        thumbnail: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=150',
        duration: 104,
      },
      {
        query: 'Malcolm Todd Earrings',
        title: 'Earrings',
        artist: 'Malcolm Todd',
        thumbnail: 'https://images.unsplash.com/photo-1487180144351-b8472da7d491?w=150',
        duration: 152,
      },
    ],
  },
  {
    id: 'lib_device',
    type: 'playlists',
    name: 'Bu Cihazdaki Müzikler',
    author: 'Yerel Depolama',
    coverClass: 'device-cover',
    icon: 'fa-folder',
    tracks: [
      {
        query: 'Alximo Paparazzi Dubstep',
        title: 'Paparazzi (Dubstep)',
        artist: 'Alximo',
        thumbnail: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        duration: 172,
      },
      {
        query: 'Sylendanna Nice 2 Know Ya Slowed',
        title: 'Nice 2 Know Ya (Slowed)',
        artist: 'Sylendanna',
        thumbnail: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150',
        duration: 172,
      },
      {
        query: 'wiv i love u slowed reverb',
        title: 'i love u. - slowed + reverb',
        artist: 'wiv',
        thumbnail: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150',
        duration: 133,
      },
    ],
  },
];

let customPlaylists = readAccountJson('sunify_custom_playlists', [], currentAuthSession, true);

function persistActiveAccountData(session = currentAuthSession) {
  [
    ['sunify_search_history', searchHistory],
    ['sunify_recent_tracks', recentHistory],
    ['sunify_liked', likedTracks],
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
  trackAnalytics = readAccountJson('sunify_track_analytics', {}, currentAuthSession);
  customPlaylists = readAccountJson('sunify_custom_playlists', [], currentAuthSession);

  [renderLibraryItems, renderRecentHistory, renderDailyMixes, renderNowPlayingDualGrid, renderListeningStats, updateLikeButtonUI]
    .forEach((render) => {
      try { render(); } catch (error) { console.warn('Hesap görünümü yenilenemedi:', error); }
    });
}

function migrateLegacyAccountData() {
  const migratedKey = 'sunify_account_data_migrated_v1';
  const savedSessions = knownProfiles
    .map((profile) => profile?.session)
    .filter((session) => session?.user?.id);
  const legacyOwner = savedSessions.find((session) => session.user.email?.trim().toLowerCase() === LEGACY_ADMIN_EMAIL);
  const otherSavedProfile = savedSessions.find((session) => session.user.id !== currentAuthSession?.user?.id);
  const targetSession = legacyOwner || otherSavedProfile || currentAuthSession;
  if (!localStorage.getItem(migratedKey)) {
    const loadedValues = {
      sunify_search_history: searchHistory,
      sunify_recent_tracks: recentHistory,
      sunify_liked: likedTracks,
      sunify_track_analytics: trackAnalytics,
      sunify_custom_playlists: customPlaylists,
      sunify_listening_stats: readStoredJson('sunify_listening_stats', {}),
    };
    for (const key of ACCOUNT_DATA_KEYS) {
      const oldValue = localStorage.getItem(key);
      const scopedKey = accountStorageKey(key, targetSession);
      if (oldValue !== null && localStorage.getItem(scopedKey) === null) {
        localStorage.setItem(scopedKey, JSON.stringify(loadedValues[key]));
      }
    }
    localStorage.setItem(migratedKey, 'true');
    if (targetSession?.user?.id !== currentAuthSession?.user?.id) {
      searchHistory = readAccountJson('sunify_search_history', [], currentAuthSession);
      recentHistory = readAccountJson('sunify_recent_tracks', [], currentAuthSession);
      likedTracks = readAccountJson('sunify_liked', [], currentAuthSession);
      trackAnalytics = readAccountJson('sunify_track_analytics', {}, currentAuthSession);
      customPlaylists = readAccountJson('sunify_custom_playlists', [], currentAuthSession);
    }
  }
  ACCOUNT_DATA_KEYS.forEach((key) => localStorage.removeItem(key));
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
  window.sunifyAPI?.onEmailVerificationResult?.((result) => {
    if (result?.success) {
      showAppNotification('E-posta doğrulandı', 'Hesabınız doğrulandı; şimdi giriş yapabilirsiniz.');
    } else {
      showAppNotification('E-posta doğrulaması tamamlanmadı', result?.message || 'Doğrulama bağlantısı geçersiz veya süresi dolmuş.', true);
    }
  });
  applyTheme(currentTheme);
  setupNavigation();
  setupSpotlightSearch();
  setupSettingsModal();
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
  document.getElementById('refreshHomeRecommendationsBtn')?.addEventListener('click', () => loadHomeRecommendations(true));
  renderRecentHistory();
  renderLibraryItems();
  loadLocalDownloadedTracks(); // downloads/ klasöründeki müzikleri otomatik yükle
  showRuntimeDiagnostics();
  window.setTimeout(() => checkForUpdates({ notifyOnUpdate: true }), 6000);

  const refreshMixesBtn = document.getElementById('refreshMixesBtn');
  if (refreshMixesBtn) {
    refreshMixesBtn.onclick = () => {
      renderDailyMixes();
      renderNowPlayingDualGrid();
    };
  }

  const createSmartMixBtn = document.getElementById('createSmartMixBtn');
  if (createSmartMixBtn) createSmartMixBtn.onclick = createSmartMix;

  // Son dinlenen şarkı varsa onu alt bara yükle (oynatmadan hazır bekle)
  if (recentHistory.length > 0) {
    const lastTrack = recentHistory[0];
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

// 1. TEMA UYGULAMA
function applyTheme(theme) {
  const safeTheme = ['dark', 'light'].includes(theme) ? theme : 'dark';
  currentTheme = safeTheme;
  document.body.setAttribute('data-theme', safeTheme);
  localStorage.setItem('sunify_theme', safeTheme);

  document.querySelectorAll('.theme-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.theme === safeTheme);
  });

  if (currentTrack?.thumbnail) applyCoverAdaptiveColor(currentTrack.thumbnail);
}

// 2. NAVİGASYON
function setupNavigation() {
  function switchView(targetView, targetBtn) {
    [viewHome, viewPlaylistDetail, viewLibrary, viewArtist].forEach((v) => v.classList.remove('active'));
    [navHomeBtn, navLibraryBtn].forEach((b) => b.classList.remove('active'));

    targetView.classList.add('active');
    if (targetBtn) targetBtn.classList.add('active');
  }

  navHomeBtn.onclick = () => switchView(viewHome, navHomeBtn);
  navLibraryBtn.onclick = () => {
    switchView(viewLibrary, navLibraryBtn);
    renderLibraryItems();
  };
  backFromPlaylistBtn.onclick = () => switchView(viewHome, navHomeBtn);

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggleSpotlightSearch();
    }
    if (e.key === 'Escape') {
      closeSpotlightSearch();
    }
  });

  navSearchTriggerBtn.onclick = toggleSpotlightSearch;
  headerSearchPill.onclick = toggleSpotlightSearch;

  document.addEventListener('click', (e) => {
    if (inlineSearchOverlay.classList.contains('active')) {
      const isInside =
        inlineSearchOverlay.contains(e.target) ||
        headerSearchPill.contains(e.target) ||
        navSearchTriggerBtn.contains(e.target);
      if (!isInside) {
        closeSpotlightSearch();
      }
    }
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

  const allItems = [...INITIAL_LIBRARY_ITEMS, ...customPlaylists];
  const query = libSearchInput ? libSearchInput.value.toLowerCase().trim() : '';

  const filtered = allItems.filter((item) => {
    const matchesFilter = activeLibraryFilter === 'all' || item.type === activeLibraryFilter;
    const matchesSearch =
      !query ||
      item.name.toLowerCase().includes(query) ||
      item.author.toLowerCase().includes(query);
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
          'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=350',
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
    spotlightInput.focus();
    renderSpotlightContent();
  }
}

function closeSpotlightSearch() {
  inlineSearchOverlay.classList.remove('active');
  spotlightInput.value = '';
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
    debounceTimer = setTimeout(() => executeSpotlightQuery(query), 350);
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
    const defaultTrack = recentHistory[0] || {
      title: 'Harvey',
      artist: "Her's",
      thumbnail: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
      duration: 212,
    };

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
    const [artistResponse, trackResponse, playlistResponse] = await Promise.allSettled([
      wantArtists ? fetch(`${API_BASE}/artists/search?q=${encodeURIComponent(requestQuery)}`).then((res) => res.json()) : Promise.resolve({ artists: [] }),
      wantTracks ? fetch(`${API_BASE}/search?q=${encodeURIComponent(requestQuery)}`).then((res) => res.json()) : Promise.resolve({ results: [] }),
      wantPlaylists ? fetch(`${API_BASE}/search/playlists?q=${encodeURIComponent(requestQuery)}`).then((res) => res.json()) : Promise.resolve({ playlists: [] }),
    ]);
    if (spotlightInput.value.trim() !== requestQuery) return;
    const artists = (artistResponse.status === 'fulfilled' ? artistResponse.value.artists || [] : [])
      .filter((artist) => artist && artist.id && artist.name);
    const tracks = trackResponse.status === 'fulfilled' ? trackResponse.value.results || [] : [];
    const playlists = playlistResponse.status === 'fulfilled' ? playlistResponse.value.playlists || [] : [];
    if (!artists.length && !tracks.length && !playlists.length) {
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
          item.classList.add('is-loading');
          item.querySelector('.spotlight-result-type').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          try {
            const response = await fetch(`${API_BASE}/import-playlist`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: playlist.url }),
            });
            const imported = await response.json();
            if (!response.ok) throw new Error(imported.error || 'Çalma listesi alınamadı.');
            const id = `youtube_${playlist.id}`;
            const preview = { id, type: 'playlists', name: imported.name || playlist.title, author: imported.author || playlist.author?.name || playlist.author || 'YouTube', cover: imported.thumbnail || playlist.thumbnail || '', tracks: Array.isArray(imported.tracks) ? imported.tracks : [], sourceUrl: playlist.url };
            closeSpotlightSearch();
            openPlaylistDetailView(preview);
          } catch (error) {
            item.classList.remove('is-loading');
            item.querySelector('.spotlight-result-type').textContent = 'Çalma listesi';
            showAppNotification('Çalma listesi açılamadı', error.message, true);
          }
        };
        spotlightListContainer.appendChild(item);
      });
    }
  } catch (error) {
    spotlightListContainer.innerHTML = `<p style="font-size:13px; color:#fff; background:rgba(0,0,0,0.3); padding:8px; border-radius:6px;">Arama hatası: ${error.message}</p>`;
  }
}

async function openArtistPage(artist) {
  closeSpotlightSearch();
  showAllArtistTracks = false;
  currentArtistProfile = null;
  const requestId = ++artistRequestId;
  [viewHome, viewPlaylistDetail, viewLibrary, viewArtist].forEach((view) => view.classList.remove('active'));
  viewArtist.classList.add('active');
  document.getElementById('mainScrollableArea').scrollTop = 0;
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
    container.innerHTML = '<p class="empty-state-card">Sunify kullanıcılarının ortak listesi, yeterli toplu dinleme verisi oluştuğunda burada görünür.</p>';
    return;
  }

  container.innerHTML = '';
  tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = 'dual-track-row';
    row.dataset.trackTitle = track.title;
    row.dataset.trackArtist = track.artist;
    row.innerHTML = `
      <div class="dual-track-left">
        <img class="dual-track-thumb" alt="Cover">
        <div class="dual-track-meta">
          <span class="dual-track-title"></span>
          <span class="dual-track-artist"></span>
        </div>
      </div>
      <div class="dual-track-right">
        <span class="dual-track-play-count"></span>
        <i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i>
      </div>
    `;
    row.querySelector('.dual-track-thumb').src = track.thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150';
    row.querySelector('.dual-track-title').textContent = track.title;
    row.querySelector('.dual-track-artist').textContent = track.artist;
    row.querySelector('.dual-track-play-count').textContent = `${track.playCount} dinleme`;
    row.onclick = () => playSelectedTrack(track, tracks, index);
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
  }
  renderNowPlayingDualGrid();
}

function renderDailyMixes() {
  const container = document.getElementById('dailyMixesGrid');
  if (!container) return;

  const topTracks = getMostPlayedTracks(20);
  if (!topTracks.length) {
    container.innerHTML = '<p class="empty-state-card">Daily Mix, en çok dinlediğin 20 şarkıya göre hazırlanacak. Önce birkaç şarkı dinle.</p>';
    return;
  }

  container.innerHTML = '';
  for (let start = 0; start < topTracks.length; start += 5) {
    const mixNumber = Math.floor(start / 5) + 1;
    const tracks = topTracks.slice(start, start + 5);
    const card = document.createElement('div');
    card.className = 'mix-card';
    card.innerHTML = `
      <div class="mix-cover-box"><img alt="Daily Mix ${mixNumber}"></div>
      <div class="mix-title">Daily Mix ${mixNumber}</div>
      <div class="mix-artists" style="font-size:11px; opacity:0.85;"></div>
    `;
    card.querySelector('img').src = tracks[0].thumbnail || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=350';
    card.querySelector('.mix-artists').textContent = `${tracks.length} en çok dinlediğin şarkı`;
    card.onclick = () => openPlaylistDetailView({
      name: `Daily Mix ${mixNumber}`,
      author: 'Dinleme geçmişin',
      cover: tracks[0].thumbnail,
      tracks,
    });
    container.appendChild(card);
  }
}

async function createSmartMix() {
  const mood = document.getElementById('smartMixMood')?.value || 'enerjik';
  const button = document.getElementById('createSmartMixBtn');
  if (button) button.disabled = true;
  try {
    let tracks = [];
    if (mood === 'favorilerim' || mood === 'favoriler') {
      const favorites = [...likedTracks];
      const seen = new Set(favorites.map((track) => track.id || `${track.artist}|${track.title}`));
      tracks = [...favorites, ...getMostPlayedTracks(30).filter((track) => !seen.has(track.id || `${track.artist}|${track.title}`))];
    } else {
      const seed = getMostPlayedTracks(3).map((track) => `${track.artist} ${track.title}`).join(', ');
      const response = await fetch(`${API_BASE}/recommendations?q=${encodeURIComponent(`${mood} music ${seed}`)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Mix hazırlanamadı.');
      tracks = data.tracks || [];
    }
    if (!tracks.length) throw new Error('Öneri hazırlamak için biraz dinleme geçmişi veya beğeni gerekli.');
    openPlaylistDetailView({ name: `${mood[0].toLocaleUpperCase('tr-TR')}${mood.slice(1)} Mix`, author: 'Sunify önerileri', cover: tracks[0].thumbnail, tracks });
  } catch (error) {
    showAppNotification('Mix oluşturulamadı', error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

let playlistRecommendationRequest = 0;
let homeRecommendationRequest = 0;
let homeRecommendationCache = { key: '', time: 0, tracks: [] };
async function loadHomeRecommendations(force = false) {
  const container = document.getElementById('homeRecommendationsGrid');
  if (!container) return;
  const seeds = [...getMostPlayedTracks(4), ...recentHistory].filter(Boolean);
  const uniqueSeeds = [...new Map(seeds.map((track) => [`${track.artist}|${track.title}`.toLowerCase(), track])).values()].slice(0, 5);
  if (!uniqueSeeds.length) {
    container.innerHTML = '<p class="empty-state-card">Dinleme geçmişin oluşunca tarzına uygun şarkılar burada görünecek.</p>';
    return;
  }
  const key = uniqueSeeds.map((track) => `${track.artist} ${track.title}`).join('|');
  const requestId = ++homeRecommendationRequest;
  if (!force && homeRecommendationCache.key === key && Date.now() - homeRecommendationCache.time < 10 * 60 * 1000) {
    return renderHomeRecommendationCards(container, homeRecommendationCache.tracks);
  }
  container.innerHTML = '<p class="empty-state-card"><i class="fa-solid fa-spinner fa-spin"></i> Sana uygun şarkılar aranıyor…</p>';
  try {
    const response = await fetch(`${API_BASE}/recommendations?q=${encodeURIComponent(`songs similar to ${key.replaceAll('|', ' ')}`)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Öneriler alınamadı.');
    if (requestId !== homeRecommendationRequest) return;
    const listened = new Set(seeds.map((track) => `${track.artist}|${track.title}`.toLowerCase()));
    const tracks = (data.tracks || []).filter((track) => !listened.has(`${track.artist}|${track.title}`.toLowerCase())).slice(0, 8);
    homeRecommendationCache = { key, time: Date.now(), tracks };
    renderHomeRecommendationCards(container, tracks);
  } catch (error) {
    if (requestId === homeRecommendationRequest) container.innerHTML = `<p class="empty-state-card">Öneriler yüklenemedi: ${error.message}</p>`;
  }
}

function renderHomeRecommendationCards(container, tracks) {
  container.replaceChildren();
  if (!tracks.length) {
    container.innerHTML = '<p class="empty-state-card">Şu an benzer yeni şarkı bulunamadı. Biraz sonra yenileyebilirsin.</p>';
    return;
  }
  tracks.forEach((track, index) => {
    const card = document.createElement('article'); card.className = 'home-recommendation-card'; card.tabIndex = 0; card.setAttribute('role', 'button');
    const image = document.createElement('img'); image.src = track.thumbnail || ''; image.alt = '';
    const text = document.createElement('div'); text.className = 'home-recommendation-meta';
    const title = document.createElement('strong'); title.textContent = track.title;
    const artist = document.createElement('span'); artist.textContent = track.artist || '';
    text.append(title, artist);
    const play = () => playSelectedTrack(track, tracks, index);
    card.onclick = play; card.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); play(); } };
    card.append(image, text); container.appendChild(card);
  });
}

async function loadPlaylistRecommendations(playlist = activePlaylistData) {
  const container = document.getElementById('playlistRecommendationsGrid');
  if (!container || !playlist) return;
  const requestId = ++playlistRecommendationRequest;
  const seeds = (playlist.tracks || []).slice(0, 4).map((track) => `${track.artist || ''} ${track.title || ''}`.trim()).filter(Boolean);
  if (!seeds.length) {
    container.innerHTML = '<p class="empty-state-card">Öneri için bu listeye önce şarkı ekle.</p>';
    return;
  }
  container.innerHTML = '<p class="empty-state-card"><i class="fa-solid fa-spinner fa-spin"></i> Listeye uygun şarkılar aranıyor…</p>';
  try {
    const query = `songs like ${seeds.join(' ')}`;
    const response = await fetch(`${API_BASE}/recommendations?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Öneriler alınamadı.');
    if (requestId !== playlistRecommendationRequest) return;
    const existing = new Set((playlist.tracks || []).map((track) => `${(track.artist || '').toLowerCase()}|${(track.title || '').toLowerCase()}`));
    const tracks = (data.tracks || []).filter((track) => !existing.has(`${(track.artist || '').toLowerCase()}|${(track.title || '').toLowerCase()}`)).slice(0, 8);
    container.replaceChildren();
    if (!tracks.length) {
      container.innerHTML = '<p class="empty-state-card">Şu an yeni öneri bulunamadı. Yenile’yi deneyebilirsin.</p>';
      return;
    }
    tracks.forEach((track) => {
      const card = document.createElement('article');
      card.className = 'playlist-recommendation-card';
      const cover = document.createElement('img'); cover.src = track.thumbnail || ''; cover.alt = ''; 
      const meta = document.createElement('div'); meta.className = 'playlist-recommendation-meta';
      const title = document.createElement('strong'); title.textContent = track.title;
      const artist = document.createElement('span'); artist.textContent = track.artist;
      meta.append(title, artist);
      const actions = document.createElement('div'); actions.className = 'playlist-recommendation-actions';
      const add = document.createElement('button'); add.className = 'icon-btn'; add.title = 'Çalma listesine ekle'; add.setAttribute('aria-label', `${track.title} şarkısını çalma listesine ekle`); add.innerHTML = '<i class="fa-solid fa-plus"></i>';
      add.onclick = (event) => {
        event.stopPropagation();
        if (!activePlaylistData) return;
        const duplicate = activePlaylistData.tracks.some((item) => item.id === track.id || (item.title === track.title && item.artist === track.artist));
        if (duplicate) return showAppNotification('Zaten listede', `${track.title} bu çalma listesinde var.`);
        activePlaylistData.tracks.push(track);
        persistPlaylistChanges();
        renderPlaylistTracks(activePlaylistData.tracks);
        loadPlaylistRecommendations(activePlaylistData);
        showAppNotification('Listeye eklendi', `${track.title} çalma listene eklendi.`);
      };
      actions.append(add);
      card.append(cover, meta, actions);
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `${track.title} şarkısını çal`);
      card.onclick = () => playSelectedTrack(track, tracks, tracks.indexOf(track));
      card.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); playSelectedTrack(track, tracks, tracks.indexOf(track)); } };
      container.appendChild(card);
    });
  } catch (error) {
    if (requestId === playlistRecommendationRequest) container.innerHTML = `<p class="empty-state-card">Öneriler yüklenemedi: ${error.message}</p>`;
  }
}

function setupQueueDrawer() {
  const drawer = document.getElementById('queueDrawer');
  const close = document.getElementById('closeQueueBtn');
  const closeDrawer = () => { drawer?.classList.remove('open'); drawer?.setAttribute('aria-hidden', 'true'); };
  close?.addEventListener('click', closeDrawer);
  document.getElementById('clearQueueBtn')?.addEventListener('click', () => {
    currentPlaylist = currentTrack ? [currentTrack] : [];
    currentIndex = currentTrack ? 0 : -1;
    renderQueueDrawer();
  });
  document.getElementById('smartQueueBtn')?.addEventListener('click', async () => {
    const button = document.getElementById('smartQueueBtn');
    button.disabled = true;
    try {
      const seed = currentTrack ? `${currentTrack.artist} ${currentTrack.title}` : getMostPlayedTracks(3).map((track) => `${track.artist} ${track.title}`).join(' ');
      if (!seed) throw new Error('Öneri için önce bir şarkı çal veya dinleme geçmişi oluştur.');
      const response = await fetch(`${API_BASE}/recommendations?q=${encodeURIComponent(`songs like ${seed}`)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Öneriler alınamadı.');
      const seen = new Set(currentPlaylist.map((track) => track.id || `${track.artist}|${track.title}`));
      const additions = (data.tracks || []).filter((track) => !seen.has(track.id || `${track.artist}|${track.title}`));
      currentPlaylist.push(...additions);
      renderQueueDrawer();
      showAppNotification('Akıllı sıra hazır', `${additions.length} uygun şarkı sıraya eklendi.`);
    } catch (error) { showAppNotification('Akıllı sıra kurulamadı', error.message, true); }
    finally { button.disabled = false; }
  });
  document.getElementById('refreshPlaylistRecommendationsBtn')?.addEventListener('click', () => loadPlaylistRecommendations());
}

function renderQueueDrawer() {
  const container = document.getElementById('queueList');
  if (!container) return;
  const count = document.getElementById('queueTrackCount');
  const upcoming = currentPlaylist.slice(Math.max(0, currentIndex + 1));
  if (count) count.textContent = `${upcoming.length} sıradaki parça`;
  const current = document.getElementById('queueCurrentTrack');
  if (current) current.innerHTML = currentTrack ? `<img src="${currentTrack.thumbnail || ''}" alt=""><div><small>ŞİMDİ ÇALIYOR</small><strong></strong><span></span></div>` : '<span>Şu anda çalan şarkı yok</span>';
  if (currentTrack && current) { current.querySelector('strong').textContent = currentTrack.title; current.querySelector('span').textContent = currentTrack.artist || ''; }
  container.replaceChildren();
  if (!upcoming.length) { container.innerHTML = '<p class="empty-state-card">Sırada başka şarkı yok. Akıllı sırayla öneri ekleyebilirsin.</p>'; return; }
  upcoming.forEach((track, offset) => {
    const index = Math.max(0, currentIndex + 1) + offset;
    const row = document.createElement('div'); row.className = 'queue-track-row'; row.draggable = true; row.dataset.queueIndex = String(index);
    row.innerHTML = `<img src="${track.thumbnail || ''}" alt=""><div class="queue-track-meta"><strong></strong><span></span></div><button class="icon-btn queue-up" title="Yukarı taşı"><i class="fa-solid fa-arrow-up"></i></button><button class="icon-btn queue-down" title="Aşağı taşı"><i class="fa-solid fa-arrow-down"></i></button><button class="icon-btn queue-remove" title="Sıradan çıkar"><i class="fa-solid fa-xmark"></i></button>`;
    row.querySelector('strong').textContent = track.title; row.querySelector('span').textContent = track.artist || '';
    row.onclick = (event) => { if (event.target.closest('button')) return; playSelectedTrack(track, currentPlaylist, index); };
    row.querySelector('.queue-remove').onclick = () => { currentPlaylist.splice(index, 1); if (index < currentIndex) currentIndex--; renderQueueDrawer(); };
    row.querySelector('.queue-up').onclick = () => moveQueueItem(index, index - 1);
    row.querySelector('.queue-down').onclick = () => moveQueueItem(index, index + 1);
    row.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', String(index)));
    row.addEventListener('dragover', (event) => event.preventDefault());
    row.addEventListener('drop', (event) => { event.preventDefault(); moveQueueItem(Number(event.dataTransfer.getData('text/plain')), index); });
    container.appendChild(row);
  });
}

function moveQueueItem(from, to) {
  const start = Math.max(0, currentIndex + 1);
  if (from < start || to < start || to >= currentPlaylist.length || from >= currentPlaylist.length || from === to) return;
  const [item] = currentPlaylist.splice(from, 1);
  currentPlaylist.splice(to, 0, item);
  if (from === currentIndex) currentIndex = to;
  renderQueueDrawer();
}

let lyricsFontSize = Math.max(18, Math.min(44, Number(localStorage.getItem('sunify_lyrics_font_size')) || 28));
function setupLyricsTools() {
  const filter = document.getElementById('lyricsFilterInput');
  const applyFont = () => document.getElementById('lyricsLinesContainer')?.style.setProperty('--lyrics-font-size', `${lyricsFontSize}px`);
  document.getElementById('lyricsFontDownBtn')?.addEventListener('click', () => { lyricsFontSize = Math.max(18, lyricsFontSize - 2); localStorage.setItem('sunify_lyrics_font_size', lyricsFontSize); applyFont(); });
  document.getElementById('lyricsFontUpBtn')?.addEventListener('click', () => { lyricsFontSize = Math.min(44, lyricsFontSize + 2); localStorage.setItem('sunify_lyrics_font_size', lyricsFontSize); applyFont(); });
  filter?.addEventListener('input', () => {
    applyLyricsFilter();
  });
  applyFont();
}

async function loadLocalDownloadedTracks() {
  try {
    const res = await fetch(`${API_BASE}/local-downloads`);
    const data = await res.json();
    INITIAL_LIBRARY_ITEMS[2].tracks = Array.isArray(data.tracks) ? data.tracks : [];
    renderLibraryItems();
  } catch (error) { console.warn('Yerel müzik klasörü taranamadı:', error); }
}

function findDownloadedTrack(track) {
  const normalize = (value) => String(value || '').toLocaleLowerCase('tr-TR').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const title = normalize(track?.title);
  const artist = normalize(track?.artist);
  return (INITIAL_LIBRARY_ITEMS?.[2]?.tracks || []).find((local) => normalize(local.title) === title && (!artist || normalize(local.artist) === artist)) || null;
}

// 6. KALDIĞIN YERDEN DEVAM ET
function addToRecentHistory(track) {
  recentHistory = recentHistory.filter((t) => t.title !== track.title);
  recentHistory.unshift(track);
  if (recentHistory.length > 14) recentHistory.pop();
  writeAccountJson('sunify_recent_tracks', recentHistory);
  renderRecentHistory();
}

function renderRecentHistory() {
  const container = document.getElementById('continueCards');
  if (recentHistory.length === 0) {
    container.innerHTML =
      '<p class="empty-state-card">Henüz dinlediğin bir şarkı yok. Bir şarkı başlatıldığında otomatik olarak buraya kaydedilecek!</p>';
    return;
  }

  container.innerHTML = '';
  recentHistory.forEach((track, index) => {
    const card = document.createElement('div');
    card.className = 'album-card';
    card.dataset.trackTitle = track.title;
    card.dataset.trackArtist = track.artist;
    card.innerHTML = `
      <img class="album-cover" src="${track.thumbnail}">
      <div class="album-title">${track.title}</div>
      <div class="album-sub">${track.artist}</div>
    `;
    card.onclick = () => playSelectedTrack(track, recentHistory, index);
    container.appendChild(card);
  });
  updateNowPlayingVisuals();
}

// 7. ÇALMA LİSTESİ İÇ DETAY SAYFASI
let activePlaylistData = null;

function openPlaylistDetailView(playlist) {
  playlist = { ...playlist, tracks: Array.isArray(playlist.tracks) ? playlist.tracks : [] };
  activePlaylistData = playlist;
  plHeroTitle.textContent = playlist.name;
  plHeroAuthor.textContent = playlist.author || 'Sunify Koleksiyonu';
  plHeroImg.src =
    playlist.cover ||
    playlist.thumbnail ||
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=350';
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
  loadPlaylistRecommendations(playlist);

  [viewHome, viewLibrary, viewArtist].forEach((v) => v.classList.remove('active'));
  viewPlaylistDetail.classList.add('active');

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
        [viewPlaylistDetail, viewHome].forEach((v) => v.classList.remove('active'));
        viewLibrary.classList.add('active');
        navLibraryBtn.classList.add('active');
        navHomeBtn.classList.remove('active');
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

function renderPlaylistTracks(tracks) {
  playlistTracksContainer.innerHTML = '';

  tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = `pl-track-row ${currentTrack && currentTrack.title === track.title ? 'playing is-current-track' : ''}`;
    row.dataset.trackTitle = track.title;
    row.dataset.trackArtist = track.artist;
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

    row.onclick = () => playSelectedTrack(track, tracks, index);
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

// 8. ŞARKI ÇALMA FONKSİYONU (BUFFER & GEÇİŞ SORUNU ÇÖZÜLDÜ, ANINDA ESKİYİ DURDURMA)
let playSessionId = 0; // Şarkı geçiş çakışmalarını önleyen oturum belirteci
let isResolvingPlayback = false;

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

async function playSelectedTrack(track, playlist = [], index = 0) {
  if (!track) return;
  // 1. Yeni şarkıya basıldığı AN eski şarkıyı ve sayacı derhal durdur!
  playSessionId++;
  const thisSession = playSessionId;

  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  // İlerleme çubuğunu ve süre göstergelerini hemen sıfırla
  progressBarFill.style.width = '0%';
  currentTimeLabel.textContent = '0:00';
  if (lyricsProgressFill) lyricsProgressFill.style.width = '0%';
  if (lyricsCurrentTime) lyricsCurrentTime.textContent = '0:00';

  currentTrack = track;
  isPlaying = false;
  isResolvingPlayback = true;
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
      const resolveAndSetSource = async (forceRefresh = false) => {
        const queryParam = track.id
          ? `id=${encodeURIComponent(track.id)}`
          : `q=${encodeURIComponent(track.query || `${track.artist} ${track.title}`)}`;
        const response = await fetch(`${API_BASE}/stream?${queryParam}${forceRefresh ? '&refresh=1' : ''}`, {
          signal: AbortSignal.timeout(35_000),
        });
        const streamData = await response.json();
        if (!response.ok) throw new Error(streamData.error || 'Ses bağlantısı alınamadı.');
        if (!streamData.url) throw new Error('Bu parça için ses akışı bulunamadı.');
        if (thisSession !== playSessionId) return null;

        if (streamData.thumbnail && (!track.thumbnail || /unsplash|placeholder/.test(track.thumbnail))) {
          track.thumbnail = streamData.thumbnail;
          currentThumb.src = track.thumbnail;
          lyricsBigCover.src = track.thumbnail;
          lyricsBackdrop.style.backgroundImage = `url('${track.thumbnail}')`;
        }
        if (streamData.duration) track.duration = streamData.duration;
        applyCoverAdaptiveColor(track.thumbnail);
        // Keep audio same-origin/CORS-readable so the Web Audio equalizer can process it.
        audio.crossOrigin = 'anonymous';
        audio.src = `${API_BASE}/audio-stream?${queryParam}`;
        return streamData;
      };

      let streamData = await resolveAndSetSource();
      if (!streamData || thisSession !== playSessionId) return;
      try {
        audio.preload = 'auto';
        audio.load();
        await audio.play();
      } catch (firstPlayError) {
        if (thisSession !== playSessionId) return;
        streamData = await resolveAndSetSource(true);
        if (!streamData || thisSession !== playSessionId) return;
        audio.load();
        await audio.play();
      }
      if (streamData.duration) syncDiscordRPC(track, 0, streamData.duration, true);
    }

    if (thisSession !== playSessionId) return;
    isResolvingPlayback = false;
    currentArtist.textContent = track.artist;
    addToRecentHistory(track);
    trackSongStartEvent(track);
    syncToCloudSilently();
    updatePlayPauseIcons(true);
    publishMiniPlayerState();
  } catch (err) {
    if (thisSession !== playSessionId) return;
    console.error('Audio stream error:', err);
    isResolvingPlayback = false;
    isPlaying = false;
    updatePlayPauseIcons(false);
    currentArtist.textContent = err.name === 'TimeoutError' ? 'Bağlantı zaman aşımına uğradı' : 'Oynatma hatası';
    showAppNotification('Şarkı çalınamadı', err.message || 'Ses akışı başlatılamadı.', true);
  }
}

// Lyrics requests have a visible loading/empty/error state and ignore stale responses after track changes.
let lyricsRequestId = 0;
function renderLyricsState(message, kind = 'empty', retry = false) {
  if (!lyricsLinesContainer) return;
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
  const requestId = ++lyricsRequestId;
  const safeSource = ['auto', 'lrclib', 'netease', 'genius'].includes(preferredSource) ? preferredSource : 'auto';
  const searchInput = document.getElementById('lyricsFilterInput');
  if (searchInput) searchInput.value = '';
  parsedLyrics = [];
  lyricsHaveTimestamps = false;
  activeLyricIndex = -1;
  const offsetTrigger = document.getElementById('lyricsOffsetTriggerBtn');
  if (offsetTrigger) {
    offsetTrigger.disabled = true;
    offsetTrigger.title = 'Bu parça için zaman damgalı söz aranıyor';
  }
  document.getElementById('lyricsOffsetPopup')?.classList.remove('active');
  renderLyricsState(`“${title}” için şarkı sözleri aranıyor…`, 'loading');
  if (lyricsCurrentSourceBadge) lyricsCurrentSourceBadge.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Kaynak aranıyor';

  const requestSource = async (source) => {
    const params = new URLSearchParams({ title: title || '', artist: artist || '', duration: String(Number(duration) || ''), source });
    const response = await fetch(`${API_BASE}/lyrics?${params.toString()}`, { signal: AbortSignal.timeout(30_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Şarkı sözleri alınamadı.');
    return data;
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
      const sourceLabel = `${sourceName || (data.success ? 'Şarkı sözleri' : 'Sonuç yok')}${plainOnly ? ' · Zaman damgası yok' : ''}`;
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
    renderLyricsState(error.name === 'TimeoutError' ? 'Söz araması zaman aşımına uğradı. Yeniden deneyebilirsin.' : `Sözler yüklenemedi: ${error.message}`, 'error', true);
    if (lyricsCurrentSourceBadge) lyricsCurrentSourceBadge.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Bağlantı sorunu';
  }
}

function parseLRCWithWordTiming(lrcText, totalDurationSeconds = 0) {
  const lines = lrcText.split('\n');
  const temp = [];
  const regex = /\[(\d{2}):(\d{2})\.?(\d{2,3})?\](.*)/;

  lines.forEach((line, idx) => {
    const match = line.match(regex);
    if (match) {
      const minutes = parseInt(match[1]);
      const seconds = parseInt(match[2]);
      const millis = match[3]
        ? match[3].length === 2
          ? parseInt(match[3]) * 10
          : parseInt(match[3])
        : 0;
      const totalSeconds = minutes * 60 + seconds + millis / 1000;
      const text = match[4].trim();

      if (text) {
        temp.push({
          time: totalSeconds,
          text: text,
          id: `line-${idx}`,
        });
      }
    }
  });

  temp.sort((a, b) => a.time - b.time);

  return temp.map((lineObj, i) => {
    const knownDuration = Number(totalDurationSeconds) || 0;
    const nextTime = temp[i + 1]
      ? temp[i + 1].time
      : knownDuration > lineObj.time
        ? knownDuration
        : lineObj.time + 4;
    const duration = Math.max(1.5, Math.min(nextTime - lineObj.time, 7));
    const words = lineObj.text.split(/\s+/).filter(Boolean);
    const wordDuration = duration / (words.length || 1);

    const timedWords = words.map((w, wIdx) => ({
      word: w,
      startTime: lineObj.time + wIdx * wordDuration,
      endTime: lineObj.time + (wIdx + 1) * wordDuration,
      id: `${lineObj.id}-w${wIdx}`,
    }));

    return {
      ...lineObj,
      endTime: nextTime,
      duration,
      instrumentalStart: lineObj.time + duration,
      instrumentalEnd: nextTime,
      instrumentalDuration: Math.max(0, nextTime - (lineObj.time + duration)),
      words: timedWords,
    };
  });
}

function renderSyncedLyrics(lyrics) {
  lyricsLinesContainer.innerHTML = '';
  activeInstrumentalGap = null;
  if (lyrics[0]?.time >= 1.35) {
    lyricsLinesContainer.appendChild(createLyricInstrumentalGap(0, lyrics[0].time));
  }
  lyrics.forEach((item, index) => {
    const p = document.createElement('p');
    p.className = 'lyric-line';
    p.id = item.id;

    item.words.forEach((wObj) => {
      const span = document.createElement('span');
      span.className = 'lyric-word';
      span.id = wObj.id;
      span.textContent = wObj.word;
      p.appendChild(span);
      p.appendChild(document.createTextNode(' '));
    });

    p.onclick = () => {
      audio.currentTime = item.time;
    };
    lyricsLinesContainer.appendChild(p);

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
  return note;
}

let activeInstrumentalGap = null;
function updateLyricInstrumentalGaps(currentTime) {
  document.querySelectorAll('#lyricsLinesContainer .lyric-instrumental-gap').forEach((note) => {
    const start = Number(note.dataset.gapStart);
    const end = Number(note.dataset.gapEnd);
    const duration = Math.max(0.001, end - start);
    const progress = Math.max(0, Math.min(1, (currentTime - start) / duration));
    const isActive = currentTime >= start && currentTime < end;
    note.style.setProperty('--note-progress', `${progress * 100}%`);
    note.classList.toggle('active', isActive);
    note.classList.toggle('complete', currentTime >= end);
    if (isActive && activeInstrumentalGap !== note) {
      activeInstrumentalGap = note;
      const container = lyricsLinesContainer;
      const containerRect = container.getBoundingClientRect();
      const noteRect = note.getBoundingClientRect();
      const target = container.scrollTop + noteRect.top - containerRect.top - container.clientHeight * 0.5;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      container.scrollTo({ top: Math.max(0, Math.min(maxScroll, target)), behavior: 'smooth' });
    } else if (!isActive && activeInstrumentalGap === note) {
      activeInstrumentalGap = null;
    }
  });
}

function renderPlainLyrics(plainText) {
  lyricsLinesContainer.innerHTML = '';
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
let userLyricOffset = parseFloat(localStorage.getItem('sunify_lyric_offset') || '0.0'); // Saniye cinsinden gecikme (+ / -)

async function showRuntimeDiagnostics() {
  try {
    const response = await fetch(`${API_BASE}/diagnostics`);
    const result = await response.json();
    if (!result.pythonAudio?.ytDlp) {
      showAppNotification(
        'Ses motoru kurulumu gerekli',
        result.pythonAudio?.python
          ? 'yt-dlp eksik. Terminalde npm run setup:python çalıştırın.'
          : 'Python 3 eksik. Kurup ardından npm run setup:python çalıştırın.',
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

  let activeIndex = -1;
  for (let i = 0; i < parsedLyrics.length; i++) {
    if (currentTime >= parsedLyrics[i].time) {
      activeIndex = i;
    } else {
      break;
    }
  }

  const lineElements = document.querySelectorAll('#lyricsLinesContainer .lyric-line');
  lineElements.forEach((element, index) => {
    element.classList.toggle('active', index === activeIndex);
    element.classList.toggle('passed', activeIndex >= 0 && index < activeIndex);
    const line = parsedLyrics[index];
    element.querySelectorAll('.lyric-word').forEach((wordElement, wordIndex) => {
      const word = line?.words?.[wordIndex];
      wordElement.classList.toggle('spoken', Boolean(word && currentTime >= word.startTime));
    });
  });

  if (activeIndex !== activeLyricIndex) {
    activeLyricIndex = activeIndex;
    if (activeIndex >= 0) {
      const activeEl = document.getElementById(parsedLyrics[activeIndex].id);
      if (activeEl) {
        const container = lyricsLinesContainer;
        const containerRect = container.getBoundingClientRect();
        const activeRect = activeEl.getBoundingClientRect();
        const target = container.scrollTop + activeRect.top - containerRect.top - container.clientHeight * 0.42;
        const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
        container.scrollTo({ top: Math.max(0, Math.min(maxScroll, target)), behavior: 'smooth' });
      }
    }
  }
}

// 11. AUDIO KONTROLLERİ & İLERLEME ÇUBUĞU
function setupAudioEvents() {
  async function togglePlayPause() {
    if (!currentTrack) return;
    if (isResolvingPlayback) return;
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
    if (!currentTrack || isResolvingPlayback || audio.networkState === HTMLMediaElement.NETWORK_EMPTY) return;
    isPlaying = false;
    updatePlayPauseIcons(false);
    currentArtist.textContent = 'Ses akışı kesildi';
    publishMiniPlayerState();
  };

  // Discord RPC Oynatma / Duraklatma / Sarma olayları
  audio.onplay = () => {
    isPlaying = true;
    updatePlayPauseIcons(true);
    updateNowPlayingVisuals();
    publishMiniPlayerState();
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
    isPlaying = false;
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
    if (currentTrack) {
      syncDiscordRPC(
        currentTrack,
        audio.currentTime,
        audio.duration || currentTrack.duration,
        !audio.paused
      );
    }
  };

  shuffleBtn.onclick = () => {
    isShuffle = !isShuffle;
    shuffleBtn.style.opacity = isShuffle ? '1' : '0.6';
    shuffleBtn.style.color = isShuffle ? '#fef08a' : '#ffffff';
    const lyricsShuffleBtn = document.getElementById('lyricsShuffleBtn');
    if (lyricsShuffleBtn) {
      lyricsShuffleBtn.style.opacity = isShuffle ? '1' : '0.6';
      lyricsShuffleBtn.style.color = isShuffle ? '#fef08a' : '#ffffff';
    }
  };
  const lyricsShuffleBtn = document.getElementById('lyricsShuffleBtn');
  if (lyricsShuffleBtn) lyricsShuffleBtn.onclick = () => shuffleBtn.click();

  repeatBtn.onclick = () => {
    isRepeat = !isRepeat;
    repeatBtn.style.opacity = isRepeat ? '1' : '0.6';
    repeatBtn.style.color = isRepeat ? '#fef08a' : '#ffffff';
    audio.loop = isRepeat;
    const lyricsRepeatBtn = document.getElementById('lyricsRepeatBtn');
    if (lyricsRepeatBtn) {
      lyricsRepeatBtn.style.opacity = isRepeat ? '1' : '0.6';
      lyricsRepeatBtn.style.color = isRepeat ? '#fef08a' : '#ffffff';
    }
  };
  const lyricsRepeatBtn = document.getElementById('lyricsRepeatBtn');
  if (lyricsRepeatBtn) lyricsRepeatBtn.onclick = () => repeatBtn.click();

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
  const audioOutputSelect = document.getElementById('audioOutputSelect');
  const audioOutputStatus = document.getElementById('audioOutputStatus');
  const equalizerStatus = document.getElementById('equalizerStatus');
  applyEqualizerGains(equalizerGains);

  if (equalizerBtn) {
    equalizerBtn.onclick = async () => {
      const open = !equalizerPopover?.classList.contains('open');
      equalizerPopover?.classList.toggle('open', open);
      if (open) {
        try {
          initializeAudioEqualizer();
          await audioContext.resume();
          if (equalizerStatus) equalizerStatus.textContent = 'Filtreler canlı sese uygulanıyor.';
        } catch (error) {
          equalizerPopover?.classList.remove('open');
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
    button.addEventListener('click', () => document.getElementById(button.dataset.closeAudioTool)?.classList.remove('open'));
  });
  document.addEventListener('click', (event) => {
    if (!document.getElementById('equalizerWrap')?.contains(event.target)) equalizerPopover?.classList.remove('open');
    if (!document.getElementById('audioOutputWrap')?.contains(event.target)) {
      audioOutputPopover?.classList.remove('open');
      audioOutputBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  async function refreshAudioOutputDevices() {
    if (!audioOutputSelect || !audioOutputStatus) return;
    const supportsOutputRouting = typeof audio.setSinkId === 'function'
      || typeof (window.AudioContext || window.webkitAudioContext)?.prototype?.setSinkId === 'function';
    if (!supportsOutputRouting || !navigator.mediaDevices?.enumerateDevices) {
      audioOutputSelect.disabled = true;
      audioOutputStatus.textContent = 'Bu Electron sürümü ses çıkış aygıtı seçimini desteklemiyor.';
      return;
    }
    try {
      const selectedId = localStorage.getItem('sunify_audio_output_id') || 'default';
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audiooutput');
      audioOutputSelect.replaceChildren(new Option('Varsayılan aygıt', 'default'));
      devices.forEach((device, index) => {
        const option = new Option(device.label || `Ses çıkışı ${index + 1}`, device.deviceId);
        audioOutputSelect.add(option);
      });
      audioOutputSelect.value = [...audioOutputSelect.options].some((option) => option.value === selectedId) ? selectedId : 'default';
      audioOutputSelect.disabled = devices.length === 0;
      if (selectedId !== 'default') {
        if (audioContext && typeof audioContext.setSinkId === 'function') await audioContext.setSinkId(selectedId);
        else if (typeof audio.setSinkId === 'function') await audio.setSinkId(selectedId);
      }
      audioOutputStatus.textContent = devices.length ? 'Seçim anında uygulanır.' : 'Ses çıkış aygıtı bulunamadı.';
    } catch (error) {
      audioOutputSelect.disabled = true;
      audioOutputStatus.textContent = `Aygıt listesi alınamadı: ${error.message}`;
    }
  }
  audioOutputBtn?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const open = !audioOutputPopover?.classList.contains('open');
    audioOutputPopover?.classList.toggle('open', open);
    audioOutputBtn.setAttribute('aria-expanded', String(open));
    if (open) await refreshAudioOutputDevices();
  });
  audioOutputSelect?.addEventListener('change', async () => {
    try {
      const deviceId = audioOutputSelect.value || 'default';
      if (audioContext && typeof audioContext.setSinkId === 'function') await audioContext.setSinkId(deviceId);
      else if (typeof audio.setSinkId === 'function') await audio.setSinkId(deviceId);
      else throw new Error('Bu ses motoru çıkış aygıtı değiştirmeyi desteklemiyor.');
      localStorage.setItem('sunify_audio_output_id', audioOutputSelect.value || 'default');
      if (audioOutputStatus) audioOutputStatus.textContent = `Ses ${audioOutputSelect.selectedOptions[0]?.textContent || 'aygıta'} yönlendiriliyor.`;
    } catch (error) {
      if (audioOutputStatus) audioOutputStatus.textContent = `Aygıt seçilemedi: ${error.message}`;
      showAppNotification('Ses çıkışı değiştirilemedi', error.message, true);
    }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshAudioOutputDevices);
  void refreshAudioOutputDevices();

  const volumeIconBtn = document.getElementById('volumeIconBtn');
  const volumeIcon = document.getElementById('volumeIcon');
  const playerVolumeWrap = document.getElementById('playerVolumeWrap');
  const volumePercent = document.getElementById('volumePercent');
  if (volumeIconBtn) {
    volumeIconBtn.onclick = () => {
      const open = playerVolumeWrap?.classList.toggle('open') ?? false;
      volumeIconBtn.setAttribute('aria-expanded', String(open));
    };
  }

  const toggleMiniPlayerBtn = document.getElementById('toggleMiniPlayerBtn');
  if (toggleMiniPlayerBtn) {
    toggleMiniPlayerBtn.onclick = () => {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) {
        if (sidebar.style.display === 'none') {
          sidebar.style.display = '';
          showAppNotification('Katman', 'Kenar çubuğu gösteriliyor.');
        } else {
          sidebar.style.display = 'none';
          showAppNotification('Katman', 'Kenar çubuğu gizlendi (Odak Modu).');
        }
      }
    };
  }

  function handleVolumeChange(val) {
    audio.volume = parseFloat(val);
    volumeSlider.value = val;
    if (lyricsVolumeSlider) lyricsVolumeSlider.value = val;
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
  handleVolumeChange(volumeSlider.value);
  document.addEventListener('pointerdown', (event) => {
    if (playerVolumeWrap && !playerVolumeWrap.contains(event.target)) {
      playerVolumeWrap.classList.remove('open');
      volumeIconBtn?.setAttribute('aria-expanded', 'false');
    }
  });
  if (lyricsVolumeSlider) {
    lyricsVolumeSlider.oninput = (e) => handleVolumeChange(e.target.value);
  }

  let lastRpcSync = 0;
  let lastTrackedTime = 0;

  audio.ontimeupdate = () => {
    const current = audio.currentTime;
    const duration = audio.duration || currentTrack?.duration || 0;
    publishMiniPlayerState();

    // Dinleme süresi farkını hesapla ve analitiğe ekle
    if (currentTrack && isPlaying) {
      if (lastTrackedTime > 0 && current > lastTrackedTime) {
        const delta = current - lastTrackedTime;
        if (delta < 2.5) {
          // Normal oynatma artışıysa kaydet
          updateTrackListeningDuration(currentTrack, delta);
        }
      }
      lastTrackedTime = current;
    }

    currentTimeLabel.textContent = formatTime(current);
    lyricsCurrentTime.textContent = formatTime(current);
    durationLabel.textContent = formatTime(duration);
    lyricsTotalTime.textContent = formatTime(duration);

    const percent = duration > 0 ? (current / duration) * 100 : 0;
    progressBarFill.style.width = `${percent}%`;
    progressBarContainer.setAttribute('aria-valuenow', String(Math.round(percent)));
    lyricsProgressFill.style.width = `${percent}%`;

    syncActiveLyric(current);

    // DISCORD RPC: Saniyeyi ve kalan süreyi 4 saniyede bir Discord'a aktar
    const now = Date.now();
    if (now - lastRpcSync > 4000 && currentTrack) {
      lastRpcSync = now;
      syncDiscordRPC(currentTrack, current, duration, isPlaying);
    }
  };

  function seekAudio(e, container) {
    const rect = container.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const width = rect.width;
    const duration = audio.duration || currentTrack?.duration || 0;
    if (duration > 0 && width > 0) {
      audio.currentTime = (clickX / width) * duration;
    }
  }

  const playerCapsule = document.querySelector('.player-floating-capsule');
  if (playerCapsule) {
    playerCapsule.addEventListener('click', (e) => {
      if (e.target.closest('button, input, a, .player-volume-popover')) return;
      seekAudio(e, playerCapsule);
    });
  }
  progressBarContainer.onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const duration = audio.duration || currentTrack?.duration || 0;
    if (!duration) return;
    if (e.key === 'Home') audio.currentTime = 0;
    else if (e.key === 'End') audio.currentTime = duration;
    else audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + (e.key === 'ArrowRight' ? 5 : -5)));
  };
  lyricsProgressContainer.onclick = (e) => seekAudio(e, lyricsProgressContainer);

  prevBtn.onclick = lyricsPrevBtn.onclick = () => {
    if (currentPlaylist.length > 0 && currentIndex > 0) {
      playSelectedTrack(currentPlaylist[currentIndex - 1], currentPlaylist, currentIndex - 1);
    }
  };

  nextBtn.onclick = lyricsNextBtn.onclick = () => {
    playNextTrack();
  };

  audio.onended = () => {
    if (isRepeat) return;
    if (window.sunifyAPI && window.sunifyAPI.clearDiscordPresence) {
      window.sunifyAPI.clearDiscordPresence();
    }
    playNextTrack();
  };
}

function playNextTrack() {
  if (currentPlaylist.length === 0) return;

  if (isShuffle) {
    const randIndex = Math.floor(Math.random() * currentPlaylist.length);
    playSelectedTrack(currentPlaylist[randIndex], currentPlaylist, randIndex);
  } else if (currentIndex < currentPlaylist.length - 1) {
    playSelectedTrack(currentPlaylist[currentIndex + 1], currentPlaylist, currentIndex + 1);
  } else {
    isPlaying = false;
    updatePlayPauseIcons(false);
  }
}

function updatePlayPauseIcons(playing) {
  const iconClass = playing ? 'fa-pause' : 'fa-play';
  playPauseIcon.className = `fa-solid ${iconClass}`;
  lyricsPlayPauseBtn.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
}

function syncDiscordRPC(track, position, duration, isPlaying) {
  // 1. Electron Main Process IPC üzerinden doğrudan Discord RPC gönderimi
  if (window.sunifyAPI && window.sunifyAPI.updateDiscordPresence) {
    window.sunifyAPI.updateDiscordPresence({
      title: track?.title,
      artist: track?.artist,
      thumbnail: track?.thumbnail,
      position: position || 0,
      duration: duration || track?.duration || 0,
      isPlaying: !!isPlaying,
    });
  }

  // 2. Web / Local Server yedeği
  fetch(`${API_BASE}/discord-rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ track, position, duration, isPlaying }),
  }).catch(() => {});
}

// Şarkı Kapağının Baskın Rengine Göre Söz Arka Planını Güncelle
let coverColorRequestId = 0;
async function applyCoverAdaptiveColor(coverUrl) {
  if (!coverUrl) return;
  const requestId = ++coverColorRequestId;

  function setGradient(r, g, b) {
    if (requestId !== coverColorRequestId) return;
    const coverAlpha = document.body.dataset.theme === 'light' ? 0.22 : 0.4;
    document.body.style.setProperty('--cover-color-solid', `rgb(${r}, ${g}, ${b})`);
    document.body.style.setProperty('--cover-color-soft', `rgba(${r}, ${g}, ${b}, 0.22)`);
    document.body.style.setProperty(
      '--cover-color',
      `rgba(${r}, ${g}, ${b}, ${coverAlpha})`
    );
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
  }

  // 1. Tarayıcı içi hızlı Canvas analizi (CORS hatası veya ağ gecikmesi olmadan %100 çalışır)
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 40;
        canvas.height = 40;
        ctx.drawImage(img, 0, 0, 40, 40);
        const imgData = ctx.getImageData(0, 0, 40, 40).data;
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
    localStorage.setItem('sunify_lyric_offset', userLyricOffset.toString());
    if (offsetTriggerBtn) {
      offsetTriggerBtn.disabled = !lyricsHaveTimestamps;
      offsetTriggerBtn.title = lyricsHaveTimestamps
        ? 'Söz gecikmesini ayarla. Pozitif değer sözleri geciktirir.'
        : 'Bu kaynak zaman damgası içermiyor; söz gecikmesi kullanılamaz.';
    }
    if (parsedLyrics.length) syncActiveLyric(audio.currentTime || 0);
  }

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
  const positionGroup = document.getElementById('settingOverlayPos');
  const sizeGroup = document.getElementById('settingOverlaySize');
  if (!enabled || !onMinimize || !alwaysOnTop) return;

  enabled.checked = localStorage.getItem('sunify_setting_overlay_enabled') !== 'false';
  onMinimize.checked = localStorage.getItem('sunify_setting_overlay_on_minimize') !== 'false';
  alwaysOnTop.checked = localStorage.getItem('sunify_setting_overlay_always_on_top') !== 'false';
  const position = localStorage.getItem('sunify_setting_overlay_pos') || 'top-center';
  const size = localStorage.getItem('sunify_setting_overlay_size') || 'medium';
  positionGroup?.querySelectorAll('.pill-btn').forEach((button) => button.classList.toggle('active', button.dataset.val === position));
  sizeGroup?.querySelectorAll('.pill-btn').forEach((button) => button.classList.toggle('active', button.dataset.val === size));

  const publish = () => window.sunifyAPI?.updateMiniPlayerSettings?.({
    enabled: enabled.checked,
    onMinimize: onMinimize.checked,
    alwaysOnTop: alwaysOnTop.checked,
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

  window.sunifyAPI?.getAppVersion?.().then((version) => {
    if (!version) return;
    const badge = document.getElementById('aboutVersionBadge');
    const detail = document.getElementById('aboutClientVersion');
    if (badge) badge.textContent = `v${version}`;
    if (detail) detail.textContent = `Client ${version} (Sunify Desktop) • Core ${version} (Express & yt-dlp)`;
  }).catch(() => {});


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
  document.querySelectorAll('#downloadLimitGroup .pill-btn').forEach((btn) => {
    btn.onclick = () => {
      document
        .querySelectorAll('#downloadLimitGroup .pill-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      localStorage.setItem('sunify_setting_download_limit', btn.dataset.limit);
      showAppNotification('İndirme Alanı', `Sınır ayarlandı: ${btn.textContent}`);
    };
  });

  document.querySelectorAll('#cacheLimitGroup .pill-btn').forEach((btn) => {
    btn.onclick = () => {
      document
        .querySelectorAll('#cacheLimitGroup .pill-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      localStorage.setItem('sunify_setting_cache_limit', btn.dataset.limit);
      showAppNotification('Önbellek Alanı', `Önbellek sınırı ayarlandı: ${btn.textContent}`);
    };
  });

  const btnClearStorageCacheBtn = document.getElementById('btnClearStorageCacheBtn');
  if (btnClearStorageCacheBtn) {
    btnClearStorageCacheBtn.onclick = () => {
      document.getElementById('cacheItemsSizeLabel').textContent = '0 B';
      document.getElementById('storageCacheSizeLabel').textContent = '0 B';
      document.getElementById('storageTotalSizeLabel').textContent = '0.0';
      document.getElementById('storageBarFill').style.width = '2%';
      showAppNotification('Önbellek Temizlendi', 'Tüm geçici kapak ve şarkı önbelleği silindi!');
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
    if (adminReleaseStatus) adminReleaseStatus.textContent = 'GitHub Actions yayını başlatılıyor...';
    try {
      const result = await adminRequest({ action: 'publish-release', version, notes });
      if (adminReleaseStatus) adminReleaseStatus.textContent = result.message;
      showAppNotification('Sürüm yayını', result.message);
    } catch (error) {
      if (adminReleaseStatus) adminReleaseStatus.textContent = error.message;
      showAppNotification('Yayın başlatılamadı', error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  });

  menuItems.forEach((item) => {
    item.onclick = () => {
      menuItems.forEach((m) => m.classList.remove('active'));
      item.classList.add('active');

      const targetTab = item.dataset.tab;
      Object.keys(panes).forEach((k) => {
        if (panes[k]) panes[k].classList.remove('active');
      });

      if (panes[targetTab]) {
        panes[targetTab].classList.add('active');
      } else if (panes.appearance) {
        panes.appearance.classList.add('active');
      }
      if (targetTab === 'account') {
        document.dispatchEvent(new CustomEvent('sunify:accounts-view'));
      }
    };
  });

  document.querySelectorAll('.theme-card').forEach((card) => {
    card.onclick = () => applyTheme(card.dataset.theme);
  });
}

// 14. ÇALMA LİSTESİ İÇE AKTARMA & MODALLAR
function setupModals() {
  openImportModalBtn.onclick = () => {
    importModal.classList.add('active');
    importUrlInput.focus();
  };

  closeImportModalBtn.onclick = () => {
    importModal.classList.remove('active');
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
  const importModalSub = document.getElementById('importModalSub');
  let currentModalMode = 'import';

  if (tabScratch && tabImport) {
    tabScratch.onclick = () => {
      tabScratch.classList.add('active');
      tabImport.classList.remove('active');
      tabScratchContent.style.display = 'block';
      tabImportContent.style.display = 'none';
      importModalTitle.textContent = 'Yeni Çalma Listesi Oluştur';
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
        thumbnail: plCover || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=350',
        cover: plCover || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=350',
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

    try {
      const res = await fetch(`${API_BASE}/import-playlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();

      if (data.tracks && data.tracks.length > 0) {
        data.type = 'playlists';
        customPlaylists.push(data);
        writeAccountJson('sunify_custom_playlists', customPlaylists);
        renderLibraryItems();

        importModal.classList.remove('active');
        importUrlInput.value = '';
        showAppNotification(
          'Çalma Listesi Aktarıldı',
          `"${data.name}" (${data.tracks.length} parça) başarıyla eklendi!`
        );
      } else {
        showAppNotification(
          'İçe Aktarma Başarısız',
          data.error || 'Çalma listesi içe aktarılamadı.',
          true
        );
      }
    } catch (err) {
      showAppNotification('Hata', err.message, true);
    } finally {
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

  const settingsSupabaseUrl = document.getElementById('settingsSupabaseUrl');
  const settingsSupabaseKey = document.getElementById('settingsSupabaseKey');
  const btnSaveSupabaseFromSettings = document.getElementById('btnSaveSupabaseFromSettings');

  // Supabase ayarlarını yükle
  fetch(`${API_BASE}/auth/config`)
    .then((r) => r.json())
    .then((conf) => {
      if (conf.url && settingsSupabaseUrl) {
        settingsSupabaseUrl.value = conf.url;
      }
    })
    .catch(() => {});

  if (btnSaveSupabaseFromSettings) {
    btnSaveSupabaseFromSettings.onclick = async () => {
      const url = settingsSupabaseUrl.value.trim();
      const anonKey = settingsSupabaseKey.value.trim();
      if (!url || !anonKey) {
        showAppNotification('Eksik Bilgi', 'Lütfen Supabase URL ve Key giriniz.', true);
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/auth/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, anonKey }),
        });
        const data = await res.json();
        if (data.success) {
          showAppNotification('Başarılı', 'Supabase bulut bağlantısı güncellendi!');
        } else {
          showAppNotification('Hata', data.error || 'Kaydedilemedi', true);
        }
      } catch (err) {
        showAppNotification('Bağlantı Hatası', err.message, true);
      }
    };
  }

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
    if (adminSettingsNav) adminSettingsNav.hidden = !isAdminAccount;
    document.dispatchEvent(new CustomEvent('sunify:auth-changed', { detail: { isAdmin: isAdminAccount } }));
  }

  // Ayarların sol altındaki profile tıklayınca doğrudan Hesap sekmesini aç
  if (settingsUserProfileBar) {
    settingsUserProfileBar.onclick = () => {
      openSettingsWindow();
      document.querySelector('.settings-menu-item[data-tab="account"]')?.click();
    };
  }

  if (btnOpenAuthGateModal) {
    btnOpenAuthGateModal.onclick = () => {
      openAuthGate();
    };
  }

  if (btnSettingsSyncNow) {
    btnSettingsSyncNow.onclick = async () => {
      btnSettingsSyncNow.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Eşitleniyor...';
      const pushed = await syncToCloudSilently();
      if (pushed) await pullFromCloud();
      btnSettingsSyncNow.innerHTML =
        '<i class="fa-solid fa-rotate" style="margin-right:6px;"></i>Şimdi Eşitle';
      showAppNotification('Bulut Eşitlemesi', 'Verileriniz bulut ile eşitlendi!');
    };
  }

  // AUTH FULLSCREEN GATE (GİRİŞ / KAYIT PENCERESİ)
  function openAuthGate() {
    authFullscreenGate.classList.add('active');
  }

  function logoutCurrentAccount() {
    // Switching to Guest must not revoke a saved account's reusable local session.
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
    logoutCurrentAccount();
    showAppNotification('Misafir Modu', 'Sunify yerel modda başlatıldı.');
    renderAccountProfiles();
  };

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
  btnGateDoRegister.onclick = async () => {
    const username = document.getElementById('gateRegUsername').value.trim();
    const email = document.getElementById('gateRegEmail').value.trim();
    const password = document.getElementById('gateRegPass').value;

    if (!email || !password) {
      showAppNotification('Uyarı', 'Lütfen tüm alanları doldurun.', true);
      return;
    }

    btnGateDoRegister.textContent = 'Hesap oluşturuluyor...';
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, username }),
      });
      const data = await res.json();
      if (data.user) {
        showAppNotification('Kayıt Başarılı', 'Hesabınız oluşturuldu. Giriş yapılıyor...');
        let accountData = data;
        if (data.session) {
          try {
            const loginResponse = await fetch(`${API_BASE}/auth/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password }),
            });
            const loginData = await loginResponse.json();
            if (loginData.session) accountData = loginData;
          } catch {}
        }
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
          authFullscreenGate.classList.remove('active');
          updateProfileUI();
          renderAccountProfiles();
          pullFromCloud();
          showAppNotification('Hesap Eklendi', 'Yeni hesap açıldı ve hesap listene kaydedildi.');
        } else {
          authGateTabLogin.click();
          document.getElementById('gateLoginEmail').value = email;
          document.getElementById('gateLoginPass').value = password;
        }
      } else {
        showAppNotification('Kayıt Başarısız', data.error || 'Kayıt olunamadı.', true);
      }
    } catch (err) {
      showAppNotification('Hata', err.message, true);
    } finally {
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
          activateAccountData(isGuest ? null : session);
          updateProfileUI();
          renderAccountProfiles();
          if (!isGuest) pullFromCloud();
          showAppNotification('Hesap Değiştirildi', `${name} profiline geçildi.`);
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

  // Hesap listesi ve geçerli oturumu başlat; hesap seçimi artık Ayarlar içinden yapılır.
  authFullscreenGate.classList.remove('active');
  updateProfileUI();
  renderAccountProfiles();
  if (currentAuthSession?.user) pullFromCloud();
}

// Buluta Sessiz Veri Gönderme (Push)
async function syncToCloudSilently() {
  if (!currentAuthSession || !currentAuthSession.access_token) return;

  const listeningStats = trackAnalytics;
  try {
    const response = await fetch(`${API_BASE}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentAuthSession.access_token}`,
      },
      body: JSON.stringify({
        playlists: customPlaylists,
        likedTracks: likedTracks,
        listeningStats: listeningStats,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Senkronizasyon gönderilemedi.');
    return true;
  } catch (err) {
    console.warn('Bulut eşitleme gönderilemedi:', err.message);
    return false;
  }
}

// Buluttan Verileri Çekme (Pull)
async function pullFromCloud() {
  if (!currentAuthSession || !currentAuthSession.access_token) return;
  const requestingUserId = currentAuthSession.user?.id;

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
        if (currentAuthSession?.user?.id !== requestingUserId) return;
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
    if (currentAuthSession?.user?.id !== requestingUserId) return;
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
  } catch (err) {
    console.warn('Bulut çekme hatası:', err.message);
  }
}

// Başlat
initAccountSystem();





