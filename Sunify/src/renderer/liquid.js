// Liquid glass etkileşimleri: imleci izleyen parlama + ikon "pop" animasyonu.
// Ultra-hafif sürüm: MutationObserver yok, boundingRect önbellekli, pencere gizliyken
// veya düşük kaynak modunda sıfır CPU/GPU tüketir.
(() => {
  const GLASS = [
    '.tool-btn', '.tool-btn-icon', '.icon-round-btn', '.filter-tab', '.pill-btn', '.back-pill-btn', '.spotlight-filter',
    '.btn-cancel', '.btn-primary', '.play-all-pill', '.artist-play-btn', '.primary-pill-btn', '.artist-action-btn',
    '.titlebar-arrow-btn', '.nav-btn', '.play-pause-btn', '.player-right button', '.player-center button',
    '.heart-btn', '.close-overlay-btn', '.settings-menu-item',
    '.queue-drawer .icon-btn', '.queue-drawer .tool-btn',
  ].join(',');

  let frame = 0;
  let pending = null;
  let cachedTarget = null;
  let cachedRect = null;
  let cachedRectAt = 0;

  document.addEventListener('pointermove', (event) => {
    if (document.hidden || document.body.classList.contains('perf-low-power')) return;
    const target = event.target instanceof Element ? event.target.closest(GLASS) : null;
    if (!target) return;
    pending = { target, x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!pending) return;
      const now = performance.now();
      if (pending.target !== cachedTarget || now - cachedRectAt > 250) {
        cachedTarget = pending.target;
        cachedRect = cachedTarget.getBoundingClientRect();
        cachedRectAt = now;
      }
      if (cachedRect) {
        pending.target.style.setProperty('--mx', `${Math.round(pending.x - cachedRect.left)}px`);
        pending.target.style.setProperty('--my', `${Math.round(pending.y - cachedRect.top)}px`);
      }
      pending = null;
    });
  }, { passive: true });

  document.addEventListener('pointerout', (event) => {
    const target = event.target instanceof Element ? event.target.closest(GLASS) : null;
    if (target && !target.contains(event.relatedTarget)) {
      target.style.removeProperty('--mx');
      target.style.removeProperty('--my');
      if (cachedTarget === target) cachedTarget = null;
    }
  }, { passive: true });

  // Oynat/duraklat ve beğeni butonlarına tıklandığında hafif ikon yaylanması
  // (tüm DOM ağacını izleyen MutationObserver yerine doğrudan tıklama olayı)
  const popSelectors = '.play-pause-btn, .heart-btn, #playerLikeBtn, .lyrics-ctl-btns button';
  document.addEventListener('click', (event) => {
    if (document.hidden || document.body.classList.contains('perf-low-power')) return;
    const btn = event.target instanceof Element ? event.target.closest(popSelectors) : null;
    const icon = btn?.querySelector('i');
    if (!icon) return;
    icon.classList.remove('lg-pop');
    void icon.offsetWidth;
    icon.classList.add('lg-pop');
    icon.addEventListener('animationend', () => icon.classList.remove('lg-pop'), { once: true });
  }, { passive: true });
})();
