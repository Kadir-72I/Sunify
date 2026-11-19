// Liquid glass etkileşimleri: imleci izleyen parlama + ikon "pop" animasyonu.
// Hafif tutuldu: tek dinleyici, rAF ile sınırlı, yalnızca cam öğelerde çalışır.
(() => {
  const GLASS = [
    '.tool-btn', '.tool-btn-icon', '.icon-round-btn', '.filter-tab', '.pill-btn', '.back-pill-btn', '.spotlight-filter',
    '.btn-cancel', '.btn-primary', '.play-all-pill', '.artist-play-btn', '.primary-pill-btn', '.artist-action-btn',
    '.titlebar-arrow-btn', '.nav-btn', '.play-pause-btn', '.player-right button', '.player-center button',
    '.heart-btn', '.close-overlay-btn', '.settings-menu-item', '.player-floating-capsule', '.sidebar',
    '.queue-drawer', '.queue-drawer .icon-btn', '.queue-drawer .tool-btn', '.queue-track-row',
  ].join(',');

  let frame = 0;
  let pending = null;
  document.addEventListener('pointermove', (event) => {
    const target = event.target instanceof Element ? event.target.closest(GLASS) : null;
    if (!target) return;
    pending = { target, x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!pending) return;
      const rect = pending.target.getBoundingClientRect();
      pending.target.style.setProperty('--mx', `${Math.round(pending.x - rect.left)}px`);
      pending.target.style.setProperty('--my', `${Math.round(pending.y - rect.top)}px`);
      pending = null;
    });
  }, { passive: true });

  document.addEventListener('pointerout', (event) => {
    const target = event.target instanceof Element ? event.target.closest(GLASS) : null;
    if (target && !target.contains(event.relatedTarget)) {
      target.style.removeProperty('--mx');
      target.style.removeProperty('--my');
    }
  }, { passive: true });

  // Oynat/duraklat ve beğeni ikonları değiştiğinde yaylanma animasyonu oynat.
  const popTargets = '.play-pause-btn i, .heart-btn i, #playerLikeBtn i, .lyrics-ctl-btns i';
  const replay = (icon) => {
    icon.classList.remove('lg-pop');
    void icon.offsetWidth;
    icon.classList.add('lg-pop');
    icon.addEventListener('animationend', () => icon.classList.remove('lg-pop'), { once: true });
  };
  // lg-pop sınıfını eklemek/çıkarmak kendi gözlemcisini tetiklememeli (sonsuz döngü olurdu).
  const strip = (value) => String(value || '').split(/\s+/).filter((name) => name && name !== 'lg-pop').sort().join(' ');
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && strip(mutation.oldValue) === strip(mutation.target.className)) continue;
      const node = mutation.type === 'attributes' ? mutation.target : mutation.target.querySelector?.('i');
      if (node instanceof Element && node.matches(popTargets)) replay(node);
      else if (mutation.type === 'childList') mutation.addedNodes.forEach((added) => {
        const icon = added instanceof Element ? (added.matches('i') ? added : added.querySelector('i')) : null;
        if (icon && icon.matches(popTargets)) replay(icon);
      });
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true, childList: true });
})();
