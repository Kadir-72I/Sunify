const elements = {
  title: document.getElementById('title'),
  artist: document.getElementById('artist'),
  cover: document.getElementById('cover'),
  progress: document.getElementById('progress'),
  time: document.getElementById('time'),
  volume: document.getElementById('volume-control'),
  volumeSlider: document.getElementById('volume-slider'),
  volumeToggle: document.getElementById('volume-toggle'),
};
const miniPlayer = document.querySelector('.mini-player');
let volumeDragging = false;
let lastAudibleVolume = 0.8;

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => window.miniPlayerAPI.action(button.dataset.action));
});

document.getElementById('seek-track').addEventListener('click', (event) => {
  const bounds = event.currentTarget.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  window.miniPlayerAPI.action('seek', fraction);
});

function paintVolume(volume) {
  const value = Math.max(0, Math.min(1, Number(volume) || 0));
  elements.volumeSlider.value = String(value);
  elements.volumeSlider.style.setProperty('--fill', `${Math.round(value * 100)}%`);
  elements.volume.classList.toggle('is-muted', value === 0);
  elements.volumeSlider.title = `Ses düzeyi: %${Math.round(value * 100)}`;
}

function sendVolume(volume) {
  const value = Math.max(0, Math.min(1, Number(volume) || 0));
  if (value > 0) lastAudibleVolume = value;
  paintVolume(value);
  window.miniPlayerAPI.action('volume', value);
}

elements.volumeSlider.addEventListener('pointerdown', () => { volumeDragging = true; });
window.addEventListener('pointerup', () => { volumeDragging = false; });
elements.volumeSlider.addEventListener('input', (event) => sendVolume(event.target.value));
elements.volumeToggle.addEventListener('click', () => {
  const current = Number(elements.volumeSlider.value) || 0;
  sendVolume(current > 0 ? 0 : (lastAudibleVolume || 0.8));
});
elements.volume.addEventListener('wheel', (event) => {
  event.preventDefault();
  const current = Number(elements.volumeSlider.value) || 0;
  sendVolume(current + (event.deltaY < 0 ? 0.05 : -0.05));
}, { passive: false });

window.miniPlayerAPI.onSize((size) => {
  document.body.dataset.size = ['small', 'medium', 'large'].includes(size) ? size : 'medium';
});

window.miniPlayerAPI.onOpacity((opacity) => {
  const value = Math.max(0.35, Math.min(1, Number(opacity) || 0.88));
  miniPlayer.style.setProperty('--glass-opacity', String(value));
});

window.miniPlayerAPI.onState((state) => {
  const title = state.title || 'Sunify';
  const artist = state.artist || 'Bir şarkı seç';
  if (elements.title.textContent !== title) elements.title.textContent = title;
  if (elements.artist.textContent !== artist) elements.artist.textContent = artist;
  if (state.thumbnail && elements.cover.getAttribute('src') !== state.thumbnail) elements.cover.src = state.thumbnail;
  else if (!state.thumbnail && elements.cover.hasAttribute('src')) elements.cover.removeAttribute('src');
  elements.progress.style.width = `${Math.max(0, Math.min(100, Number(state.progress) || 0))}%`;
  elements.time.textContent = `${state.elapsed} / ${state.duration}`;
  if (!volumeDragging && Number.isFinite(Number(state.volume))) {
    if (Number(state.volume) > 0) lastAudibleVolume = Number(state.volume);
    paintVolume(state.volume);
  }
  miniPlayer.classList.toggle('is-playing', Boolean(state.playing));
  miniPlayer.style.setProperty('--accent', state.accent);
});

window.miniPlayerAPI.ready();
