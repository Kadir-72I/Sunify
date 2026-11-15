const elements = {
  title: document.getElementById('title'),
  artist: document.getElementById('artist'),
  cover: document.getElementById('cover'),
  progress: document.getElementById('progress'),
  time: document.getElementById('time'),
  playIcon: document.getElementById('play-icon'),
};

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

window.miniPlayerAPI.onState((state) => {
  elements.title.textContent = state.title || 'Sunify';
  elements.artist.textContent = state.artist || 'Bir şarkı seç';
  if (state.thumbnail) elements.cover.src = state.thumbnail;
  else elements.cover.removeAttribute('src');
  elements.progress.style.width = `${state.progress}%`;
  elements.time.textContent = `${state.elapsed} / ${state.duration}`;
  elements.playIcon.textContent = state.playing ? 'Ⅱ' : '▶';
  document.querySelector('.mini-player').style.setProperty('--accent', state.accent);
});
