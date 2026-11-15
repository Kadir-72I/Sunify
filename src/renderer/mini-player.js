const elements = {
  title: document.getElementById('title'),
  artist: document.getElementById('artist'),
  cover: document.getElementById('cover'),
  progress: document.getElementById('progress'),
  time: document.getElementById('time'),
};
const miniPlayer = document.querySelector('.mini-player');

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => window.miniPlayerAPI.action(button.dataset.action));
});

document.getElementById('seek-track').addEventListener('click', (event) => {
  const bounds = event.currentTarget.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  window.miniPlayerAPI.action('seek', fraction);
});

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
  miniPlayer.classList.toggle('is-playing', Boolean(state.playing));
  miniPlayer.style.setProperty('--accent', state.accent);
});
