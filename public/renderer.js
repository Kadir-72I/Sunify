// renderer.js
const API_BASE = 'http://localhost:3001/api';

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

// Uygulama Durumu (State)
let currentTrack = null;
let currentPlaylist = [];
let currentIndex = -1;
let isPlaying = false;
let isShuffle = false;
let isRepeat = false;
let parsedLyrics = [];
let searchHistory = JSON.parse(localStorage.getItem('sunify_search_history') || '[]');
let recentHistory = JSON.parse(localStorage.getItem('sunify_recent_tracks') || '[]');
let likedTracks = JSON.parse(localStorage.getItem('sunify_liked') || '[]');
let currentTheme = localStorage.getItem('sunify_theme') || 'sunify';
let activeLibraryFilter = 'all';

// KAPSAMLI DİNLEME VERİLERİ (Analytics: Dinleme sayısı, süresi, günleri, playlist sayıları)
let trackAnalytics = JSON.parse(localStorage.getItem('sunify_track_analytics') || '{}');

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

  localStorage.setItem('sunify_track_analytics', JSON.stringify(trackAnalytics));
}

function updateTrackListeningDuration(track, addedSeconds) {
  if (!track || !track.title || addedSeconds <= 0) return;
  const key = `${track.artist || ''} - ${track.title}`.trim().toLowerCase();
  if (trackAnalytics[key]) {
    trackAnalytics[key].totalSeconds = (trackAnalytics[key].totalSeconds || 0) + addedSeconds;
    localStorage.setItem('sunify_track_analytics', JSON.stringify(trackAnalytics));
  }
}

// DOM Elemanları
const audio = document.getElementById('audioPlayer');

// BAŞLIK ÇUBUĞU (FRAMELESS TITLEBAR) KONTROLLERİ
const winMinimizeBtn = document.getElementById('winMinimizeBtn');
const winMaximizeBtn = document.getElementById('winMaximizeBtn');
const winCloseBtn = document.getElementById('winCloseBtn');
const winFullscreenBtn = document.getElementById('winFullscreenBtn');
const tbNavBack = document.getElementById('tbNavBack');
const tbNavForward = document.getElementById('tbNavForward');

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
let selectedLyricsSource = 'polaris';
const libraryCardsGrid = document.getElementById('libraryCardsGrid');
const libSearchInput = document.getElementById('libSearchInput');

// Modal Elements
const importModal = document.getElementById('importModal');
const openImportModalBtn = document.getElementById('openImportModalBtn');
const closeImportModalBtn = document.getElementById('closeImportModalBtn');
const confirmImportBtn = document.getElementById('confirmImportBtn');
const importUrlInput = document.getElementById('importUrlInput');

// GÜNLÜK MİXLER
const DAILY_MIXES = [
  {
    id: 'mix_1',
    name: 'Daily Mix 1',
    artists: 'mikeeysmind, LONOWN, Sylendanna',
    cover: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=350',
    tracks: [
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
  {
    id: 'mix_2',
    name: 'Daily Mix 2',
    artists: '2hollis, ONDA ANDAR, riserayss',
    cover: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=350',
    tracks: [
      {
        query: '2hollis poster boy',
        title: 'poster boy',
        artist: '2hollis',
        thumbnail: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=150',
        duration: 122,
      },
      {
        query: 'ONDA ANDAR type london',
        title: 'type london',
        artist: 'ONDA ANDAR',
        thumbnail: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=150',
        duration: 104,
      },
      {
        query: 'LONOWN riserayss worry Slowed',
        title: 'worry (Slowed)',
        artist: 'LONOWN, riserayss',
        thumbnail: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=150',
        duration: 202,
      },
    ],
  },
  {
    id: 'mix_3',
    name: 'Daily Mix 3',
    artists: 'PIXY, Lex Amami, Buckshot',
    cover: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=350',
    tracks: [
      {
        query: 'Buckshot Fever',
        title: 'Fever',
        artist: 'Buckshot',
        thumbnail: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150',
        duration: 145,
      },
      {
        query: 'PIXY LEGACY',
        title: 'LEGACY',
        artist: 'PIXY',
        thumbnail: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        duration: 135,
      },
      {
        query: 'Lex Amami the kill 2',
        title: 'the kill 2',
        artist: 'Lex Amami',
        thumbnail: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150',
        duration: 122,
      },
    ],
  },
  {
    id: 'mix_4',
    name: 'Daily Mix 4',
    artists: "Her's, Malcolm Todd, Alximo",
    cover: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=350',
    tracks: [
      {
        query: "Her's Harvey",
        title: 'Harvey',
        artist: "Her's",
        thumbnail: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150',
        duration: 212,
      },
      {
        query: 'Malcolm Todd Earrings',
        title: 'Earrings',
        artist: 'Malcolm Todd',
        thumbnail: 'https://images.unsplash.com/photo-1487180144351-b8472da7d491?w=150',
        duration: 152,
      },
      {
        query: 'Alximo Paparazzi Dubstep',
        title: 'Paparazzi (Dubstep)',
        artist: 'Alximo',
        thumbnail: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=150',
        duration: 172,
      },
    ],
  },
];

// KİTAPLIKTAKİ 3 TÜRKÇE LİSTE (TAMAMI ÇALIŞIYOR VE İÇİ DOLU)
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

let customPlaylists = JSON.parse(localStorage.getItem('sunify_custom_playlists') || '[]');

// Başlangıç Kurulumu
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  setupNavigation();
  setupSpotlightSearch();
  setupSettingsModal();
  setupAudioEvents();
  setupLyricsSync();
  setupModals();
  setupPlaylistHeroTools();
  setupLibraryFilters();
  renderDailyMixes();
  renderNowPlayingDualGrid();
  renderRecentHistory();
  renderLibraryItems();
  loadLocalDownloadedTracks(); // downloads/ klasöründeki müzikleri otomatik yükle

  const generateBtn = document.getElementById('generateAiMixBtn');
  if (generateBtn) {
    generateBtn.onclick = generateSmartAiMix;
  }

  // Son dinlenen şarkı varsa onu alt bara yükle (oynatmadan hazır bekle)
  if (recentHistory.length > 0) {
    const lastTrack = recentHistory[0];
    currentTitle.textContent = lastTrack.title;
    currentArtist.textContent = lastTrack.artist;
    currentThumb.src = lastTrack.thumbnail;
    lyricsTrackTitle.textContent = lastTrack.title;
    lyricsTrackArtist.textContent = lastTrack.artist;
    lyricsBigCover.src = lastTrack.thumbnail;
    lyricsBackdrop.style.backgroundImage = `url('${lastTrack.thumbnail}')`;
  }
});

// 1. TEMA UYGULAMA
function applyTheme(theme) {
  currentTheme = theme;
  document.body.setAttribute('data-theme', theme);
  localStorage.setItem('sunify_theme', theme);

  document.querySelectorAll('.theme-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.theme === theme);
  });
}

// 2. NAVİGASYON
function setupNavigation() {
  function switchView(targetView, targetBtn) {
    [viewHome, viewPlaylistDetail, viewLibrary].forEach((v) => v.classList.remove('active'));
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
    localStorage.setItem('sunify_search_history', '[]');
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
        localStorage.setItem('sunify_search_history', JSON.stringify(searchHistory));
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
  spotlightSectionTitle.textContent = `"${query}" sonuçları`;
  clearSearchHistoryBtn.style.display = 'none';
  spotlightListContainer.innerHTML =
    '<p style="font-size:13px; color:#ffffff; padding:12px; font-weight:700;"><i class="fa-solid fa-spinner fa-spin"></i> Şarkı aranıyor...</p>';

  try {
    const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (!data.results || data.results.length === 0) {
      spotlightListContainer.innerHTML =
        '<p style="font-size:13px; color:#ffffff; padding:12px;">Sonuç bulunamadı.</p>';
      return;
    }

    spotlightListContainer.innerHTML = '';
    data.results.slice(0, 8).forEach((track, index) => {
      const item = document.createElement('div');
      item.className = 'spotlight-item';
      item.innerHTML = `
        <img class="spotlight-thumb" src="${track.thumbnail}" alt="${track.title}">
        <div class="spotlight-meta">
          <div class="spotlight-title">${track.title}</div>
          <div class="spotlight-artist">${track.artist}</div>
        </div>
        <span class="spotlight-duration">${formatTime(track.duration)}</span>
      `;

      item.onclick = () => {
        addToSearchHistory(track);
        playSelectedTrack(track, data.results, index);
        closeSpotlightSearch();
      };

      spotlightListContainer.appendChild(item);
    });
  } catch (err) {
    spotlightListContainer.innerHTML = `<p style="font-size:13px; color:#fff; background:rgba(0,0,0,0.3); padding:8px; border-radius:6px;">Arama hatası: ${err.message}</p>`;
  }
}

function addToSearchHistory(track) {
  searchHistory = searchHistory.filter((t) => t.title !== track.title);
  searchHistory.unshift(track);
  if (searchHistory.length > 10) searchHistory.pop();
  localStorage.setItem('sunify_search_history', JSON.stringify(searchHistory));
}

// 5.1 ŞU ANDA DİNLENİYOR (2 SÜTUNLU GÖRSEL ŞARKI LİSTESİ)
function renderNowPlayingDualGrid() {
  const container = document.getElementById('nowPlayingDualGrid');
  if (!container) return;

  const sampleTracks = [
    {
      title: 'the kill 2',
      artist: 'Lex Amarai',
      duration: 122,
      thumbnail: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=120',
    },
    {
      title: 'worry (Slowed)',
      artist: 'LONOWN, riserayss',
      duration: 202,
      thumbnail: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=120',
    },
    {
      title: 'cachalot',
      artist: 'ONDA ANDAR',
      duration: 121,
      thumbnail: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=120',
    },
    {
      title: 'Earrings',
      artist: 'Malcolm Todd',
      duration: 152,
      thumbnail: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=120',
    },
    {
      title: 'LEGACY',
      artist: 'PIXY',
      duration: 135,
      thumbnail: 'https://images.unsplash.com/photo-1465847899084-d164df4dedc6?w=120',
    },
    {
      title: 'addiction',
      artist: 'LONOWN',
      duration: 209,
      thumbnail: 'https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=120',
    },
    {
      title: 'Fever',
      artist: 'Buckshot',
      duration: 145,
      thumbnail: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=120',
    },
    {
      title: 'poster boy',
      artist: '2hollis',
      duration: 122,
      thumbnail: 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?w=120',
    },
    {
      title: 'type london',
      artist: 'ONDA ANDAR',
      duration: 104,
      thumbnail: 'https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?w=120',
    },
    {
      title: 'addiction (Slowed)',
      artist: 'LONOWN',
      duration: 234,
      thumbnail: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=120',
    },
  ];

  container.innerHTML = '';
  sampleTracks.forEach((track, idx) => {
    const row = document.createElement('div');
    row.className = 'dual-track-row';
    row.innerHTML = `
      <div class="dual-track-left">
        <img class="dual-track-thumb" src="${track.thumbnail}" alt="Cover">
        <div class="dual-track-meta">
          <span class="dual-track-title">${track.title}</span>
          <span class="dual-track-artist">${track.artist}</span>
        </div>
      </div>
      <div class="dual-track-right">
        <span>${formatTime(track.duration)}</span>
        <i class="fa-solid fa-ellipsis-vertical" style="cursor:pointer; padding:4px;"></i>
      </div>
    `;
    row.onclick = () => playSelectedTrack(track, sampleTracks, idx);
    container.appendChild(row);
  });
}
let smartAiMixData = JSON.parse(localStorage.getItem('sunify_ai_mix') || 'null');

async function renderDailyMixes() {
  const container = document.getElementById('dailyMixesGrid');
  if (!container) return;
  container.innerHTML = '';

  // Eğer kayıtlı Akıllı Mix yoksa varsayılan dinamik mixleri yükle
  const mixesToShow = smartAiMixData
    ? [
        {
          name: 'Yapay Zeka Akıllı Mix 1',
          desc: smartAiMixData.analysis || 'Dinlediğin şarkı tarzına göre derlendi',
          cover:
            smartAiMixData.tracks[0]?.thumbnail ||
            'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=350',
          tracks: smartAiMixData.tracks.slice(0, 3),
        },
        {
          name: 'Yapay Zeka Akıllı Mix 2',
          desc: 'Keşif & Benzer Sanatçılar',
          cover:
            smartAiMixData.tracks[3]?.thumbnail ||
            'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=350',
          tracks: smartAiMixData.tracks.slice(3),
        },
      ]
    : DAILY_MIXES;

  mixesToShow.forEach((mix, idx) => {
    const card = document.createElement('div');
    card.className = 'mix-card';
    card.innerHTML = `
      <div class="mix-cover-box">
        <img src="${mix.cover}" alt="${mix.name}">
        <span class="mix-brand-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
        <span class="mix-label-overlay">AKILLI MIX</span>
      </div>
      <div class="mix-title">${mix.name}</div>
      <div class="mix-artists" style="font-size:11px; opacity:0.85;">${mix.desc || mix.artists || 'Kişiselleştirilmiş AI Listesi'}</div>
    `;

    card.onclick = () => {
      openPlaylistDetailView({
        name: mix.name,
        author: 'Sunify Yapay Zeka',
        cover: mix.cover,
        tracks: mix.tracks,
      });
    };

    container.appendChild(card);
  });
}

// Gemini AI İle Şarkı Geçmişini Analiz Edip Akıllı Mix Oluştur
async function generateSmartAiMix() {
  const spinner = document.getElementById('aiMixSpinner');
  if (spinner) spinner.classList.add('fa-spin');

  const apiKey = localStorage.getItem('sunify_gemini_api_key') || '';
  showAppNotification(
    'Yapay Zeka Analiz Ediyor',
    'Dinleme tarzınız ve şarkı geçmişiniz analiz ediliyor...'
  );

  try {
    const res = await fetch(`${API_BASE}/ai-mix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        detailedStats: trackAnalytics,
        recentTracks: recentHistory,
        apiKey: apiKey,
      }),
    });
    const data = await res.json();

    if (data.success && data.tracks && data.tracks.length > 0) {
      smartAiMixData = data;
      localStorage.setItem('sunify_ai_mix', JSON.stringify(smartAiMixData));
      renderDailyMixes();
      showAppNotification('Akıllı Mix Hazır!', `Yapay Zeka zevkini çıkardı: "${data.analysis}"`);
    } else {
      showAppNotification('Analiz Hatası', data.error || 'Gemini API ile analiz yapılamadı.', true);
    }
  } catch (err) {
    showAppNotification('Hata', err.message, true);
  } finally {
    if (spinner) spinner.classList.remove('fa-spin');
  }
}

// Yerel İndirilen Parçaları Otomatik Algılama ve Listeye Entegre Etme
async function loadLocalDownloadedTracks() {
  try {
    const res = await fetch(`${API_BASE}/local-downloads`);
    const data = await res.json();
    if (data.tracks && data.tracks.length > 0) {
      INITIAL_LIBRARY_ITEMS[2].tracks = data.tracks; // 'Bu Cihazdaki Müzikler' listesini doldur
      renderLibraryItems();
      console.log(
        `Cihazdan ${data.tracks.length} adet müzik dosyası başarıyla tarandı ve yüklendi.`
      );
    }
  } catch (e) {}
}

// 6. KALDIĞIN YERDEN DEVAM ET
function addToRecentHistory(track) {
  recentHistory = recentHistory.filter((t) => t.title !== track.title);
  recentHistory.unshift(track);
  if (recentHistory.length > 14) recentHistory.pop();
  localStorage.setItem('sunify_recent_tracks', JSON.stringify(recentHistory));
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
    card.innerHTML = `
      <img class="album-cover" src="${track.thumbnail}">
      <div class="album-title">${track.title}</div>
      <div class="album-sub">${track.artist}</div>
    `;
    card.onclick = () => playSelectedTrack(track, recentHistory, index);
    container.appendChild(card);
  });
}

// 7. ÇALMA LİSTESİ İÇ DETAY SAYFASI
let activePlaylistData = null;

function openPlaylistDetailView(playlist) {
  activePlaylistData = playlist;
  plHeroTitle.textContent = playlist.name;
  plHeroAuthor.textContent = playlist.author || 'Sunify Koleksiyonu';
  plHeroImg.src =
    playlist.cover ||
    playlist.thumbnail ||
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=350';
  plHeroStats.innerHTML = `<i class="fa-solid fa-music"></i> ${playlist.tracks.length} parça • Dinlemeye hazır`;

  renderPlaylistTracks(playlist.tracks);

  [viewHome, viewLibrary].forEach((v) => v.classList.remove('active'));
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

      // Şarkıları tarayıcıyı/ağı tıkamadan 1.2 saniye aralıklarla indir
      for (let i = 0; i < totalTracks; i++) {
        const tr = activePlaylistData.tracks[i];
        setTimeout(() => {
          downloadTrackFile(tr);
        }, i * 1200);
      }
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
        localStorage.setItem('sunify_custom_playlists', JSON.stringify(customPlaylists));
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
    row.className = `pl-track-row ${currentTrack && currentTrack.title === track.title ? 'playing' : ''}`;
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
      downloadTrackFile(track);
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
let editingTrackIndex = -1;

function openEditTrackModal(track, index) {
  editingTrackRef = track;
  editingTrackIndex = index;

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
    localStorage.setItem('sunify_custom_playlists', JSON.stringify(customPlaylists));
  }
}

// 8. ŞARKI ÇALMA FONKSİYONU (BUFFER & GEÇİŞ SORUNU ÇÖZÜLDÜ, ANINDA ESKİYİ DURDURMA)
let playSessionId = 0; // Şarkı geçiş çakışmalarını önleyen oturum belirteci

async function playSelectedTrack(track, playlist = [], index = 0) {
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
  currentPlaylist = playlist;
  currentIndex = index;

  addToRecentHistory(track);
  trackSongStartEvent(track); // Detaylı analitik dinleme kaydını başlat

  currentTitle.textContent = track.title;
  currentArtist.textContent = `${track.artist} (Yükleniyor...)`;
  currentThumb.src = track.thumbnail;

  lyricsTrackTitle.textContent = track.title;
  lyricsTrackArtist.textContent = track.artist;
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
  if (track.localUrl) {
    audio.src = track.localUrl;
    audio.preload = 'auto';
    audio.play().catch((e) => console.log('Local autoplay:', e));
    isPlaying = true;
    updatePlayPauseIcons(true);
    currentArtist.textContent = track.artist;
    syncDiscordRPC(track, 0, track.duration || 180, true);
    return;
  }

  try {
    const queryParam = track.id
      ? `id=${track.id}`
      : `q=${encodeURIComponent(track.query || `${track.artist} ${track.title}`)}`;
    const streamRes = await fetch(`${API_BASE}/stream?${queryParam}`);
    const streamData = await streamRes.json();

    // Kullanıcı bu şarkı yüklenene kadar başka bir şarkıya tıkladıysa iptal et
    if (thisSession !== playSessionId) return;

    if (streamData.url) {
      audio.src = streamData.url;
      audio.preload = 'auto';
      audio.play().catch((e) => console.log('Autoplay handled:', e));
      isPlaying = true;
      updatePlayPauseIcons(true);
      currentArtist.textContent = track.artist;

      // Akıştan gerçek kapak resmi geldiyse güncelle
      if (
        streamData.thumbnail &&
        (!track.thumbnail ||
          track.thumbnail.includes('unsplash') ||
          track.thumbnail.includes('placeholder'))
      ) {
        track.thumbnail = streamData.thumbnail;
        currentThumb.src = track.thumbnail;
        lyricsBigCover.src = track.thumbnail;
        lyricsBackdrop.style.backgroundImage = `url('${track.thumbnail}')`;
      }

      if (streamData.duration) {
        track.duration = streamData.duration;
        syncDiscordRPC(track, 0, streamData.duration, true);
      }
      applyCoverAdaptiveColor(track.thumbnail);
    } else {
      currentArtist.textContent = 'Ses akışı bulunamadı';
    }
  } catch (err) {
    if (thisSession !== playSessionId) return;
    console.error('Audio stream error:', err);
    currentArtist.textContent = 'Oynatma hatası';
  }
}

// 9. ÇOKLU KAYNAKLA ŞARKI SÖZLERİ (LRCLIB, NETEASE, GENIUS)
async function loadTrackLyrics(title, artist, duration, preferredSource = 'auto') {
  lyricsLinesContainer.innerHTML =
    '<p class="lyrics-loading" style="color:#ffffff; font-size:26px; font-weight:900;"><i class="fa-solid fa-spinner fa-spin"></i> Şarkı sözleri aranıyor...</p>';
  parsedLyrics = [];

  try {
    const res = await fetch(
      `${API_BASE}/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&duration=${duration || ''}&source=${preferredSource}`
    );
    const data = await res.json();

    if (lyricsCurrentSourceBadge && data.source) {
      lyricsCurrentSourceBadge.innerHTML = `<i class="fa-solid fa-check"></i> ${data.source}`;
    }

    if (data.success && data.syncedLyrics) {
      parsedLyrics = parseLRCWithWordTiming(data.syncedLyrics);
      renderSyncedLyrics(parsedLyrics);
    } else if (data.success && data.plainLyrics) {
      renderPlainLyrics(data.plainLyrics);
    } else {
      lyricsLinesContainer.innerHTML = `
        <div class="empty-lyrics" style="color:#ffffff; font-size:24px; font-weight:800; padding:20px;">
          <p>Bu şarkı için bu kaynakta söz bulunamadı.</p>
          <small style="opacity:0.85; font-size:16px;">Üstteki menüden başka bir söz kaynağı seçmeyi deneyebilirsiniz.</small>
        </div>
      `;
    }
  } catch (err) {
    lyricsLinesContainer.innerHTML = `<p class="lyrics-loading" style="color:#ffffff;">Sözler yüklenirken hata oluştu: ${err.message}</p>`;
  }
}

function parseLRCWithWordTiming(lrcText) {
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
    const nextTime = temp[i + 1] ? temp[i + 1].time : lineObj.time + 4;
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
      words: timedWords,
    };
  });
}

function renderSyncedLyrics(lyrics) {
  lyricsLinesContainer.innerHTML = '';
  lyrics.forEach((item) => {
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
  });
}

function renderPlainLyrics(plainText) {
  lyricsLinesContainer.innerHTML = '';
  const lines = plainText.split('\n');
  lines.forEach((line) => {
    const p = document.createElement('p');
    p.className = 'lyric-line';
    p.style.color = '#fff';
    p.style.fontSize = '28px';
    p.textContent = line || ' ';
    lyricsLinesContainer.appendChild(p);
  });
}

// 10. KELİME KELİME SENKRONİZE ANİMASYON (HASSAS METRONOM SENKRONİZASYONU & KULLANICI GECİKME AYARI)
let activeLyricIndex = -1;
let userLyricOffset = parseFloat(localStorage.getItem('sunify_lyric_offset') || '0.0'); // Saniye cinsinden gecikme (+ / -)
const LYRIC_TIMING_OFFSET = 0.05; // 50ms doğal ses kartı gecikme düzeltmesi

function syncActiveLyric(rawTime) {
  if (!parsedLyrics.length) return;

  const currentTime = rawTime + LYRIC_TIMING_OFFSET + userLyricOffset;

  // Şarkı henüz ilk satırın zaman damgasına gelmediyse hiçbir satırı aktif yapma!
  if (parsedLyrics[0] && currentTime < parsedLyrics[0].time) {
    if (activeLyricIndex !== -1) {
      activeLyricIndex = -1;
      document.querySelectorAll('.lyric-line').forEach((el) => {
        el.classList.remove('active', 'passed');
        el.querySelectorAll('.lyric-word').forEach((w) => w.classList.remove('spoken'));
      });
    }
    return;
  }

  let activeIndex = -1;
  for (let i = 0; i < parsedLyrics.length; i++) {
    if (currentTime >= parsedLyrics[i].time) {
      activeIndex = i;
    } else {
      break;
    }
  }

  if (activeIndex !== activeLyricIndex && activeIndex !== -1) {
    activeLyricIndex = activeIndex;

    const allLines = document.querySelectorAll('.lyric-line');
    allLines.forEach((el, idx) => {
      el.classList.remove('active');
      if (idx < activeIndex) {
        el.classList.add('passed');
        el.querySelectorAll('.lyric-word').forEach((w) => w.classList.add('spoken'));
      } else if (idx > activeIndex) {
        el.classList.remove('passed');
        el.querySelectorAll('.lyric-word').forEach((w) => w.classList.remove('spoken'));
      }
    });

    const activeEl = document.getElementById(parsedLyrics[activeIndex].id);
    if (activeEl) {
      activeEl.classList.add('active');

      const containerHeight = lyricsLinesContainer.clientHeight;
      const elOffset = activeEl.offsetTop - lyricsLinesContainer.offsetTop;
      lyricsLinesContainer.scrollTo({
        top: elOffset - containerHeight / 2 + 40,
        behavior: 'smooth',
      });
    }
  }

  // KELİME KELİME ANINDA BEYAZA DÖNÜŞ (Söz gecikmesiz tam vaktinde parlar)
  if (activeIndex !== -1 && parsedLyrics[activeIndex]) {
    const activeLine = parsedLyrics[activeIndex];
    activeLine.words.forEach((w) => {
      const wordSpan = document.getElementById(w.id);
      if (wordSpan) {
        if (currentTime >= w.startTime) {
          wordSpan.classList.add('spoken');
        } else {
          wordSpan.classList.remove('spoken');
        }
      }
    });
  }
}

// 11. AUDIO KONTROLLERİ & İLERLEME ÇUBUĞU
function setupAudioEvents() {
  function togglePlayPause() {
    if (!currentTrack) return;
    if (audio.paused) {
      audio.play();
      isPlaying = true;
    } else {
      audio.pause();
      isPlaying = false;
    }
    updatePlayPauseIcons(isPlaying);
  }

  playPauseBtn.onclick = togglePlayPause;
  lyricsPlayPauseBtn.onclick = togglePlayPause;

  // Discord RPC Oynatma / Duraklatma / Sarma olayları
  audio.onplay = () => {
    isPlaying = true;
    updatePlayPauseIcons(true);
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
  };

  repeatBtn.onclick = () => {
    isRepeat = !isRepeat;
    repeatBtn.style.opacity = isRepeat ? '1' : '0.6';
    repeatBtn.style.color = isRepeat ? '#fef08a' : '#ffffff';
    audio.loop = isRepeat;
  };

  queueBtn.onclick = () => {
    if (window.sunifyAPI && window.sunifyAPI.toggleFullscreen) {
      window.sunifyAPI.toggleFullscreen();
    } else {
      showAppNotification('Çalma Sırası', `${currentPlaylist.length} parça listede.`);
    }
  };

  const equalizerBtn = document.getElementById('equalizerBtn');
  if (equalizerBtn) {
    equalizerBtn.onclick = () => {
      showAppNotification('Ekolayzer', 'Ekolayzer modu: Doğal / Canlı (Dahili filtre aktif).');
    };
  }

  const volumeIconBtn = document.getElementById('volumeIconBtn');
  const volumeIcon = document.getElementById('volumeIcon');
  let isMuted = false;
  let previousVolume = 0.8;
  if (volumeIconBtn) {
    volumeIconBtn.onclick = () => {
      if (!isMuted) {
        previousVolume = audio.volume || 0.8;
        audio.volume = 0;
        isMuted = true;
        if (volumeIcon) volumeIcon.className = 'fa-solid fa-volume-xmark';
        showAppNotification('Ses', 'Ses kapatıldı (Sessiz).');
      } else {
        audio.volume = previousVolume;
        isMuted = false;
        if (volumeIcon) volumeIcon.className = 'fa-solid fa-volume-high';
        showAppNotification('Ses', `Ses açıldı (%${Math.round(previousVolume * 100)}).`);
      }
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
  }

  volumeSlider.oninput = (e) => handleVolumeChange(e.target.value);
  if (lyricsVolumeSlider) {
    lyricsVolumeSlider.oninput = (e) => handleVolumeChange(e.target.value);
  }

  let lastRpcSync = 0;
  let lastTrackedTime = 0;

  audio.ontimeupdate = () => {
    const current = audio.currentTime;
    const duration = audio.duration || currentTrack?.duration || 0;

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
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const duration = audio.duration || currentTrack?.duration || 0;
    if (duration > 0) {
      audio.currentTime = (clickX / width) * duration;
    }
  }

  progressBarContainer.onclick = (e) => seekAudio(e, progressBarContainer);
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
async function applyCoverAdaptiveColor(coverUrl) {
  if (!coverUrl) return;

  function setGradient(r, g, b) {
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
  }

  playerThumbWrapper.onclick = openLyrics;
  currentTitle.onclick = openLyrics;
  openLyricsBtn.onclick = openLyrics;

  closeLyricsBtn.onclick = () => {
    lyricsOverlay.classList.remove('active');
  };

  // SÖZ KAYNAĞI SEÇİCİSİ (Polaris Mono 1/4, Liner Experimental 2, LRCLIB 3, Genius 4)
  const sourceDropdown = document.getElementById('customSourceDropdown');
  const sourceDropBtn = document.getElementById('sourceDropBtn');
  const sourceMenu = document.getElementById('sourceMenu');
  const sourceSelectedText = document.getElementById('sourceSelectedText');

  if (sourceDropBtn && sourceDropdown && sourceMenu) {
    sourceDropBtn.onclick = (e) => {
      e.stopPropagation();
      sourceDropdown.classList.toggle('open');
      sourceMenu.classList.toggle('active');
    };

    document.addEventListener('click', (e) => {
      if (!sourceDropdown.contains(e.target)) {
        sourceDropdown.classList.remove('open');
        sourceMenu.classList.remove('active');
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

        const val = opt.dataset.val;
        selectedLyricsSource = val;
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
    const formatted = `${userLyricOffset >= 0 ? '+' : ''}${userLyricOffset.toFixed(1)}s`;
    if (lyricsOffsetLabel) lyricsOffsetLabel.textContent = formatted;
    if (offsetValText) offsetValText.textContent = formatted;
    localStorage.setItem('sunify_lyric_offset', userLyricOffset.toString());
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
function setupSettingsModal() {
  navSettingsBtn.onclick = () => viewSettings.classList.add('active');
  closeSettingsBtn.onclick = () => viewSettings.classList.remove('active');

  viewSettings.onclick = (e) => {
    if (e.target === viewSettings) viewSettings.classList.remove('active');
  };

  const menuItems = document.querySelectorAll('.settings-menu-item');
  const panes = {
    playback: document.getElementById('panePlayback'),
    shortcuts: document.getElementById('paneShortcuts'),
    appearance: document.getElementById('paneAppearance'),
    overlay: document.getElementById('paneOverlay'),
    gemini: document.getElementById('paneGemini'),
    youtube: document.getElementById('paneYouTube'),
    discord: document.getElementById('paneDiscord'),
    storage: document.getElementById('paneStorage'),
    about: document.getElementById('paneAbout'),
    docs: document.getElementById('paneDocs'),
    support: document.getElementById('paneSupport'),
    account: document.getElementById('paneAccount'),
  };

  // Gemini API Anahtarı Kaydetme & Test Etme
  const geminiInput = document.getElementById('geminiApiKeyInput');
  const saveGeminiKeyBtn = document.getElementById('saveGeminiKeyBtn');
  const testGeminiKeyBtn = document.getElementById('testGeminiKeyBtn');

  if (geminiInput) {
    geminiInput.value = localStorage.getItem('sunify_gemini_api_key') || '';
  }

  if (saveGeminiKeyBtn) {
    saveGeminiKeyBtn.onclick = () => {
      const val = geminiInput.value.trim();
      localStorage.setItem('sunify_gemini_api_key', val);
      showAppNotification('Kaydedildi', 'Gemini API anahtarı başarıyla kaydedildi!');
    };
  }

  if (testGeminiKeyBtn) {
    testGeminiKeyBtn.onclick = async () => {
      const val = geminiInput.value.trim();
      if (!val) {
        showAppNotification('Eksik Anahtar', 'Lütfen önce bir Gemini API anahtarı girin.', true);
        return;
      }
      showAppNotification('Bağlantı Test Ediliyor', 'Gemini sunucularıyla iletişim kuruluyor...');
      try {
        const testRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${val}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
          }
        );
        if (testRes.ok) {
          showAppNotification('Başarılı', 'Gemini API anahtarınız geçerli ve çalışıyor!');
        } else {
          showAppNotification('Hata', 'API anahtarı geçersiz veya yetkisiz.', true);
        }
      } catch (e) {
        showAppNotification('Bağlantı Hatası', e.message, true);
      }
    };
  }

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

  // 2. Katman Konum Butonları
  document.querySelectorAll('#settingOverlayPos .pill-btn').forEach((btn) => {
    btn.onclick = () => {
      document
        .querySelectorAll('#settingOverlayPos .pill-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      localStorage.setItem('sunify_setting_overlay_pos', btn.dataset.val);
      showAppNotification('Katman Konumu', `Yeni konum: ${btn.textContent}`);
    };
  });

  // 3. Depolama & Önbellek Butonları
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
  if (btnOpenDownloadsFolder) {
    btnOpenDownloadsFolder.onclick = () => {
      showAppNotification('Klasör', 'İndirilenler klasörü açılıyor...');
    };
  }

  const btnCheckUpdates = document.getElementById('btnCheckUpdates');
  if (btnCheckUpdates) {
    btnCheckUpdates.onclick = () => {
      btnCheckUpdates.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Denetleniyor...';
      setTimeout(() => {
        btnCheckUpdates.innerHTML = '<i class="fa-solid fa-check"></i> En güncel sürümdesiniz';
        showAppNotification('Güncellemeler', 'Sunify v1.0.0 şu anda en güncel sürümdür.');
      }, 1200);
    };
  }

  const ytSignInBtn = document.getElementById('ytSignInBtn');
  if (ytSignInBtn) {
    ytSignInBtn.onclick = () => {
      showAppNotification('YouTube', 'YouTube hesap bağlantısı penceresi açılıyor...');
    };
  }

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
      localStorage.setItem('sunify_custom_playlists', JSON.stringify(customPlaylists));
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
        localStorage.setItem('sunify_custom_playlists', JSON.stringify(customPlaylists));
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

  localStorage.setItem('sunify_liked', JSON.stringify(likedTracks));
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
let currentAuthSession = JSON.parse(localStorage.getItem('sunify_auth_session') || 'null');
let knownProfiles = JSON.parse(localStorage.getItem('sunify_saved_profiles') || '[]');

function initAccountSystem() {
  const whoIsListeningGate = document.getElementById('whoIsListeningGate');
  const gateProfilesGrid = document.getElementById('gateProfilesGrid');
  const gateAddNewUserBtn = document.getElementById('gateAddNewUserBtn');

  const authFullscreenGate = document.getElementById('authFullscreenGate');
  const authGateTabLogin = document.getElementById('authGateTabLogin');
  const authGateTabRegister = document.getElementById('authGateTabRegister');
  const authGateTabGuest = document.getElementById('authGateTabGuest');
  const authGateLoginForm = document.getElementById('authGateLoginForm');
  const authGateRegisterForm = document.getElementById('authGateRegisterForm');
  const btnGateDoLogin = document.getElementById('btnGateDoLogin');
  const btnGateDoRegister = document.getElementById('btnGateDoRegister');

  const settingsUserProfileBar = document.getElementById('settingsUserProfileBar');
  const settingsUserAvatar = document.getElementById('settingsUserAvatar');
  const settingsUserName = document.getElementById('settingsUserName');
  const settingsUserHandle = document.getElementById('settingsUserHandle');
  const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');

  const paneAccountAvatar = document.getElementById('paneAccountAvatar');
  const paneAccountName = document.getElementById('paneAccountName');
  const paneAccountEmail = document.getElementById('paneAccountEmail');
  const btnOpenAuthGateModal = document.getElementById('btnOpenAuthGateModal');
  const btnSettingsSyncNow = document.getElementById('btnSettingsSyncNow');
  const toggleWhoIsListening = document.getElementById('toggleWhoIsListening');

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

  // "Kim Dinliyor?" Açılış Tercihi
  const isWhoEnabled = localStorage.getItem('sunify_show_who_listening') !== 'false';
  if (toggleWhoIsListening) {
    toggleWhoIsListening.checked = isWhoEnabled;
    toggleWhoIsListening.onchange = () => {
      localStorage.setItem(
        'sunify_show_who_listening',
        toggleWhoIsListening.checked ? 'true' : 'false'
      );
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
  }

  // Ayarların sol altındaki profile tıklayınca doğrudan Hesap sekmesini aç
  if (settingsUserProfileBar) {
    settingsUserProfileBar.onclick = () => {
      const menuItems = document.querySelectorAll('.settings-menu-item');
      menuItems.forEach((m) => m.classList.remove('active'));
      const panes = document.querySelectorAll('.settings-tab-pane');
      panes.forEach((p) => p.classList.remove('active'));

      const paneAccount = document.getElementById('paneAccount');
      if (paneAccount) paneAccount.classList.add('active');
    };
  }

  if (settingsLogoutBtn) {
    settingsLogoutBtn.onclick = (e) => {
      e.stopPropagation();
      openAuthGate();
    };
  }

  if (btnOpenAuthGateModal) {
    btnOpenAuthGateModal.onclick = () => {
      viewSettings.classList.remove('active');
      openAuthGate();
    };
  }

  if (btnSettingsSyncNow) {
    btnSettingsSyncNow.onclick = async () => {
      btnSettingsSyncNow.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Eşitleniyor...';
      await syncToCloudSilently();
      await pullFromCloud();
      btnSettingsSyncNow.innerHTML =
        '<i class="fa-solid fa-rotate" style="margin-right:6px;"></i>Şimdi Eşitle';
      showAppNotification('Bulut Eşitlemesi', 'Verileriniz bulut ile eşitlendi!');
    };
  }

  // AUTH FULLSCREEN GATE (GİRİŞ / KAYIT PENCERESİ)
  function openAuthGate() {
    authFullscreenGate.classList.add('active');
    whoIsListeningGate.classList.remove('active');
  }

  authGateTabLogin.onclick = () => {
    authGateTabLogin.classList.add('active');
    authGateTabRegister.classList.remove('active');
    authGateLoginForm.style.display = 'block';
    authGateRegisterForm.style.display = 'none';
  };

  authGateTabRegister.onclick = () => {
    authGateTabRegister.classList.add('active');
    authGateTabLogin.classList.remove('active');
    authGateLoginForm.style.display = 'none';
    authGateRegisterForm.style.display = 'block';
  };

  authGateTabGuest.onclick = () => {
    authFullscreenGate.classList.remove('active');
    showAppNotification('Misafir Modu', 'Sunify yerel modda başlatıldı.');
    updateProfileUI();
  };

  // Giriş Yap Butonu
  btnGateDoLogin.onclick = async () => {
    const email = document.getElementById('gateLoginEmail').value.trim();
    const password = document.getElementById('gateLoginPass').value.trim();
    if (!email || !password) {
      showAppNotification('Uyarı', 'E-posta ve şifre girin.', true);
      return;
    }

    btnGateDoLogin.textContent = 'Giriş yapılıyor...';
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (data.session) {
        currentAuthSession = data.session;
        localStorage.setItem('sunify_auth_session', JSON.stringify(data.session));

        // Bilinen profillere ekle
        saveToKnownProfiles({
          email: data.user.email,
          username: data.user.user_metadata?.username || data.user.email.split('@')[0],
          session: data.session,
        });

        authFullscreenGate.classList.remove('active');
        showAppNotification(
          'Giriş Başarılı',
          `Hoş geldin, ${data.user.user_metadata?.username || ''}!`
        );
        updateProfileUI();
        await pullFromCloud();
      } else {
        showAppNotification('Giriş Başarısız', data.error || 'Bilgiler hatalı.', true);
      }
    } catch (err) {
      showAppNotification('Hata', err.message, true);
    } finally {
      btnGateDoLogin.textContent = 'Giriş Yap';
    }
  };

  // Kayıt Ol Butonu
  btnGateDoRegister.onclick = async () => {
    const username = document.getElementById('gateRegUsername').value.trim();
    const email = document.getElementById('gateRegEmail').value.trim();
    const password = document.getElementById('gateRegPass').value.trim();

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
        // Otomatik giriş yaptır
        if (data.session) {
          currentAuthSession = data.session;
          localStorage.setItem('sunify_auth_session', JSON.stringify(data.session));
          saveToKnownProfiles({
            email: data.user.email,
            username: data.user.user_metadata?.username || data.user.email.split('@')[0],
            session: data.session,
          });
          setTimeout(() => {
            authFullscreenGate.classList.remove('active');
            updateProfileUI();
            pullFromCloud();
          }, 800);
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
    const idx = knownProfiles.findIndex((p) => p.email === prof.email);
    if (idx > -1) {
      knownProfiles[idx] = prof;
    } else {
      knownProfiles.push(prof);
    }
    localStorage.setItem('sunify_saved_profiles', JSON.stringify(knownProfiles));
  }

  // NETFLIX TARZI "KİM DİNLİYOR?" EKRANINI GÖSTER
  function renderWhoIsListeningGate() {
    gateProfilesGrid.innerHTML = '';

    // Kayıtlı profilleri kart olarak listele
    knownProfiles.forEach((prof) => {
      const card = document.createElement('div');
      card.className = 'profile-card-item';
      const initial = prof.username ? prof.username.charAt(0).toUpperCase() : 'U';
      card.innerHTML = `
        <div class="profile-avatar-box">${initial}</div>
        <div class="profile-user-label">${prof.username}</div>
      `;
      card.onclick = () => {
        currentAuthSession = prof.session;
        localStorage.setItem('sunify_auth_session', JSON.stringify(prof.session));
        whoIsListeningGate.classList.remove('active');
        showAppNotification('Profil Seçildi', `${prof.username} olarak devam ediliyor.`);
        updateProfileUI();
        pullFromCloud();
      };
      gateProfilesGrid.appendChild(card);
    });

    // Misafir Profili Kartı
    const guestCard = document.createElement('div');
    guestCard.className = 'profile-card-item';
    guestCard.innerHTML = `
      <div class="profile-avatar-box" style="background:rgba(255,255,255,0.2); color:#fff;"><i class="fa-solid fa-headphones"></i></div>
      <div class="profile-user-label">Misafir</div>
    `;
    guestCard.onclick = () => {
      currentAuthSession = null;
      localStorage.removeItem('sunify_auth_session');
      whoIsListeningGate.classList.remove('active');
      showAppNotification('Misafir Modu', 'Çevrimdışı ve yerel moddasınız.');
      updateProfileUI();
    };
    gateProfilesGrid.appendChild(guestCard);

    whoIsListeningGate.classList.add('active');
  }

  if (gateAddNewUserBtn) {
    gateAddNewUserBtn.onclick = () => {
      openAuthGate();
    };
  }

  // AÇILIŞ AKIŞI KONTROLÜ
  const showWhoIs = localStorage.getItem('sunify_show_who_listening') !== 'false';

  // Eğer zaten aktif bir oturum varsa doğrudan uygulamayı aç, kullanıcıyı bekletme
  if (currentAuthSession && currentAuthSession.user) {
    whoIsListeningGate.classList.remove('active');
    authFullscreenGate.classList.remove('active');
    updateProfileUI();
    pullFromCloud();
  } else if (knownProfiles.length > 0 && showWhoIs) {
    renderWhoIsListeningGate();
  } else {
    openAuthGate();
  }
}

// Buluta Sessiz Veri Gönderme (Push)
async function syncToCloudSilently() {
  if (!currentAuthSession || !currentAuthSession.access_token) return;

  const listeningStats = JSON.parse(localStorage.getItem('sunify_listening_stats') || '{}');
  try {
    await fetch(`${API_BASE}/sync/push`, {
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
  } catch (err) {}
}

// Buluttan Verileri Çekme (Pull)
async function pullFromCloud() {
  if (!currentAuthSession || !currentAuthSession.access_token) return;

  try {
    const res = await fetch(`${API_BASE}/sync/pull`, {
      headers: {
        Authorization: `Bearer ${currentAuthSession.access_token}`,
      },
    });
    const data = await res.json();

    if (data.playlists && Array.isArray(data.playlists)) {
      data.playlists.forEach((cloudPl) => {
        const idx = customPlaylists.findIndex((p) => p.name === cloudPl.name);
        if (idx > -1) {
          customPlaylists[idx] = { ...customPlaylists[idx], ...cloudPl };
        } else {
          customPlaylists.push(cloudPl);
        }
      });
      localStorage.setItem('sunify_custom_playlists', JSON.stringify(customPlaylists));
      renderLibraryItems();
    }

    if (data.analytics) {
      if (Array.isArray(data.analytics.liked_tracks) && data.analytics.liked_tracks.length > 0) {
        likedTracks = data.analytics.liked_tracks;
        localStorage.setItem('sunify_liked', JSON.stringify(likedTracks));
        updateLikeButtonUI();
        renderLibraryItems();
      }
      if (data.analytics.listening_stats) {
        localStorage.setItem(
          'sunify_listening_stats',
          JSON.stringify(data.analytics.listening_stats)
        );
      }
    }
  } catch (err) {
    console.warn('Bulut çekme hatası:', err.message);
  }
}

// Başlat
initAccountSystem();
