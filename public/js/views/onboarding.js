// First-run welcome: three short panes shown once per browser profile
// (settings key 'onboarded'). Deliberately an overlay, not a page: the
// dashboard stays visible behind it, so nothing feels hidden.

import { el, readSetting, writeSetting } from '../util.js';
import { api } from '../api.js';

export async function maybeShowOnboarding() {
  if (readSetting('onboarded')) return;
  // Marked the moment it appears, not when it's dismissed: refreshing halfway
  // through the tour must not bring it back. Settings has a replay link.
  writeSetting('onboarded', '1');
  return showOnboarding();
}

/** Always shows: the "replay the tour" path from Settings. */
export async function showOnboarding() {
  let dataDir = 'the data folder next to the app';
  let hosted = false, mobile = false;
  try { const status = await api.status(); dataDir = status.dataDir; hosted = status.deployment === 'container'; mobile = status.deployment === 'mobile'; } catch { /* server info is a nicety, not a gate */ }

  const panes = [
    {
      title: '🌍 Welcome to MundusMaker',
      body: [
        el('p', {}, hosted
          ? 'A worldbuilding wiki for game masters, on your own server. Open this address on any of your devices.'
          : `A worldbuilding wiki for game masters. It runs on this ${mobile ? 'device' : 'computer'}. No account, no cloud.`),
        el('p', { class: 'muted' }, 'Rename your world at the top of the dashboard. Want an example? Press Add the sample world under Your worlds.'),
      ],
    },
    {
      title: '🔒 Secrets',
      body: [
        el('p', {}, 'Lock a paragraph, relationship or map pin with 🔒, or make a whole entry GM-only. Players never see them.'),
        el('p', { class: 'muted' }, 'The switch at the top right shows what players see. Player exports leave secrets out.',
          hosted ? ' Anyone with the server password has full GM access; player preview is not a login.' : ''),
      ],
    },
    {
      title: '💾 Saving',
      body: [
        el('p', {}, 'Everything saves as you type. The ✓ in the top bar shows it saved.'),
        // body.append() would print a null, so a missing paragraph is an empty spread
        ...(mobile ? [el('p', { class: 'muted' }, 'Your worlds stay in the app. Settings → Download backup saves a copy. ☰ at the top left opens your entries.')]
          : hosted ? []
          : [el('p', { class: 'muted' }, 'Your worlds are in ', el('code', {}, dataDir), '. Copy that folder to back them up. ',
            'Closing the tab does not stop MundusMaker; quit with ⏻ at the top right.')]),
        el('p', { class: 'muted' }, 'The Help tab explains the rest.'),
      ],
    },
  ];

  let i = 0;
  const body = el('div', { class: 'onboard-body' });
  const dotsEl = el('div', { class: 'onboard-dots' });
  const nextBtn = el('button', { class: 'primary' });
  const skipBtn = el('button', { class: 'ghost' }, 'Skip');

  const done = () => { writeSetting('onboarded', '1'); overlay.remove(); };
  const show = () => {
    const p = panes[i];
    body.innerHTML = '';
    body.append(el('h2', {}, p.title), ...p.body);
    dotsEl.innerHTML = '';
    panes.forEach((_, n) => dotsEl.append(el('span', { class: `onboard-dot${n === i ? ' on' : ''}` })));
    nextBtn.textContent = i === panes.length - 1 ? 'Get started' : 'Next';
    skipBtn.style.visibility = i === panes.length - 1 ? 'hidden' : 'visible';
  };
  nextBtn.addEventListener('click', () => { if (i === panes.length - 1) done(); else { i++; show(); } });
  skipBtn.addEventListener('click', done);

  const dialog = el('div', { class: 'dialog onboard-dialog' },
    body,
    el('div', { class: 'row', style: 'margin-top:16px;align-items:center' },
      dotsEl, el('span', { class: 'spacer' }), skipBtn, nextBtn));
  const overlay = el('div', { class: 'overlay' }, dialog);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) done(); });
  show();
  document.body.append(overlay);
}
