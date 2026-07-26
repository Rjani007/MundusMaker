// Hover cards for [[wiki-links]]: portrait, type badge and the first visible
// paragraph of the linked entry, after a short hover delay. Pure delegation —
// works on every view without the views knowing about it.

import { el } from './util.js';
import { state, getEntity, typeOf } from './state.js';
import { snippetFor } from './render.js';
import { api } from './api.js';

let card = null;
let showTimer = null;
let currentLink = null;

function hide() {
  clearTimeout(showTimer);
  showTimer = null;
  currentLink = null;
  card?.remove();
  card = null;
}

function show(link, e) {
  card?.remove();
  const ty = typeOf(e);
  const snip = snippetFor(e, 220);
  card = el('div', { class: 'wl-preview' },
    e.image ? el('img', { src: api.assetUrl(state.worldId, e.image), alt: '' }) : null,
    el('div', { class: 'wp-body' },
      el('div', { class: 'wp-name' }, e.name),
      el('div', {},
        el('span', { class: 'type-badge' },
          el('span', { class: 'dot', style: `background:${ty.color}` }), ty.label),
        state.gm && e.gmOnly ? el('span', { class: 'gm-only-badge', style: 'margin-left:6px' }, '🔒 GM-only') : null),
      el('div', { class: 'wp-snip' }, snip || 'Nothing written here yet.')));
  document.body.append(card);
  // below the link if it fits, above otherwise; clamped to the viewport
  const r = link.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.left, window.innerWidth - card.offsetWidth - 12));
  let y = r.bottom + 8;
  if (y + card.offsetHeight > window.innerHeight - 8) y = r.top - card.offsetHeight - 8;
  card.style.left = x + 'px';
  card.style.top = Math.max(8, y) + 'px';
}

export function wireLinkPreviews() {
  document.addEventListener('mouseover', (ev) => {
    const link = ev.target.closest?.('a.wl');
    if (!link || link.classList.contains('missing') || link === currentLink) return;
    hide();
    const m = (link.getAttribute('href') || '').match(/^#\/e\/(.+)$/);
    const e = m && getEntity(decodeURIComponent(m[1]));
    if (!e) return;
    if (!state.gm && e.gmOnly) return; // render.js already de-links these; belt and braces
    currentLink = link;
    showTimer = setTimeout(() => show(link, e), 350);
  });
  document.addEventListener('mouseout', (ev) => {
    if (ev.target.closest?.('a.wl') === currentLink) hide();
  });
  document.addEventListener('click', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('hashchange', hide);
}
