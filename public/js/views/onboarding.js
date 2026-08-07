// First-run welcome: three short panes shown once per browser profile
// (settings key 'onboarded'). Deliberately an overlay, not a page — the
// dashboard stays visible behind it, so nothing feels hidden.

import { el, readSetting, writeSetting } from '../util.js';
import { api } from '../api.js';

export async function maybeShowOnboarding() {
  if (readSetting('onboarded')) return;
  let dataDir = 'the data folder next to the app';
  try { dataDir = (await api.status()).dataDir; } catch { /* server info is a nicety, not a gate */ }

  const panes = [
    {
      title: '🌍 Welcome to MundusMaker',
      body: [
        el('p', {}, 'A worldbuilding wiki for game masters that runs entirely on this machine — no cloud, no account, no AI.'),
        el('p', { class: 'muted' }, 'Your worlds are plain JSON files in ', el('code', {}, dataDir),
          '. Copy that folder and you have copied everything.'),
      ],
    },
    {
      title: '🔒 Secrets stay secret',
      body: [
        el('p', {}, 'The GM toggle in the top bar switches between your view and what players would see.'),
        el('p', { class: 'muted' }, 'Any block, relation or map marker can be marked 🔒 secret, and whole entries can be GM-only. ',
          'Exports come in two editions — the player book redacts every one of them.'),
      ],
    },
    {
      title: '📌 Make it feel installed',
      body: [
        el('p', {}, 'In Edge or Chrome, click the install icon at the right end of the address bar to give MundusMaker its own window and Start-menu entry.'),
        el('p', { class: 'muted' }, 'Everything autosaves as you type. The Help page has a five-minute tour when you want it.'),
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
