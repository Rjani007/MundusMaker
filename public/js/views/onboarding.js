// First-run welcome: three short panes shown once per browser profile
// (settings key 'onboarded'). Deliberately an overlay, not a page — the
// dashboard stays visible behind it, so nothing feels hidden.

import { el, readSetting, writeSetting } from '../util.js';
import { api } from '../api.js';

export async function maybeShowOnboarding() {
  if (readSetting('onboarded')) return;
  // Marked the moment it appears, not when it's dismissed — refreshing halfway
  // through the tour must not bring it back. Settings has a replay link.
  writeSetting('onboarded', '1');
  return showOnboarding();
}

/** Always shows — the "replay the tour" path from Settings. */
export async function showOnboarding() {
  let dataDir = 'the data folder next to the app';
  let hosted = false, mobile = false;
  try { const status = await api.status(); dataDir = status.dataDir; hosted = status.deployment === 'container'; mobile = status.deployment === 'mobile'; } catch { /* server info is a nicety, not a gate */ }

  const panes = [
    {
      title: '🌍 Welcome to MundusMaker',
      body: [
        el('p', {}, hosted
          ? 'A worldbuilding wiki for game masters, hosted on your own server. Open this server address from your other devices to continue with the same worlds.'
          : `A worldbuilding wiki for game masters that lives entirely on this ${mobile ? 'device' : 'computer'}. No account, no cloud, no AI, nobody reading over your shoulder.`),
        mobile
          ? el('p', { class: 'muted' }, 'Your worlds stay inside the app. Settings → Download backup makes a file you can keep safe, or open on a computer with Import → Restore a backup.')
          : el('p', { class: 'muted' }, 'Your worlds are plain files in ', el('code', {}, dataDir),
            '. Copy that folder and you have a complete backup of everything you ever wrote.'),
      ],
    },
    {
      title: '🔒 Secrets stay secret',
      body: [
        el('p', {}, 'The toggle in the top bar flips between your view and what your players would see. Check it before you share anything.'),
        el('p', { class: 'muted' }, 'Lock any paragraph, relationship or map pin with the 🔒. Whole entries can be GM-only. ',
          'The player handbook strips every locked thing on export, and it counts them so you can be sure.',
          hosted ? ' Anyone with the server password has full DM access. Share exported handouts with players; player preview is not a restricted login.' : ''),
      ],
    },
    {
      title: '📌 Make yourself at home',
      body: [
        el('p', {}, 'Everything autosaves as you type. The ✓ in the top bar tells you it landed.'),
        ...(hosted || mobile ? [] : [el('p', { class: 'muted' }, 'MundusMaker keeps running when you close this tab, so nothing is lost if you do. ',
          'To stop it, use ⏻ Quit at the top right, or the MundusMaker icon in the Windows tray or the Mac menu bar.')]),
        mobile
          ? el('p', { class: 'muted' }, 'The ☰ button at the top left opens your entries. When you have five minutes to spare, the Help tab has the tour.')
          : el('p', { class: 'muted' }, 'If you\'d rather have MundusMaker as its own window with a Start Menu entry, Edge and Chrome can install it: the little icon at the right end of the address bar. ',
            'And when you have five minutes to spare, the Help tab has the tour.'),
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
