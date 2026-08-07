// App settings: where the data lives, backups, and what MundusMaker is made of.
// World content (types, calendar, entries) is managed on the dashboard and its
// own pages — this page is about the app itself.

import { el, toast, downloadBlob } from '../util.js';
import { state } from '../state.js';
import { api } from '../api.js';

export function render(container) {
  // ---------- data folder & sync ----------
  const syncWrap = el('div', {}, el('span', { class: 'muted small' }, 'Loading…'));
  const aboutWrap = el('div', {}, el('span', { class: 'muted small' }, 'Loading…'));

  (async () => {
    let status;
    try { status = await api.status(); } catch {
      syncWrap.textContent = 'Status unavailable — is the local server running?';
      aboutWrap.textContent = '';
      return;
    }
    const pathInput = el('input', {
      placeholder: status.platform === 'win32' ? 'e.g. C:\\Users\\you\\Dropbox\\MundusMaker' : 'e.g. /Users/you/Dropbox/MundusMaker',
      style: 'flex:1;min-width:0',
    });
    const syncNote = el('div', { class: 'small', style: 'margin-top:6px;color:var(--muted)' });
    const moveBtn = el('button', {
      onclick: async () => {
        const target = pathInput.value.trim();
        if (!target) { pathInput.focus(); return; }
        if (!confirm(`Copy your worlds into:\n\n${target}\n\nand make it the data folder from the next start? Your current data stays where it is as a fallback.`)) return;
        try {
          const res = await api.setDataDir(target, true);
          syncNote.textContent = `✓ Copied ${res.copied} world(s) to ${res.dataDir}. Restart MundusMaker (close the black window, start it again) to finish.`;
          syncNote.style.color = 'var(--ok)';
        } catch (err) {
          toast('Could not set data folder: ' + err.message, 5000);
        }
      },
    }, 'Copy data there & use it');
    syncWrap.innerHTML = '';
    syncWrap.append(
      el('div', { class: 'small' }, 'Your worlds live in: ', el('code', {}, status.dataDir),
        el('span', { class: 'muted' }, ` (set via ${status.configuredVia})`)),
      el('p', { class: 'muted small', style: 'margin:10px 0 6px' },
        'To sync between devices: point the data folder at a folder that Dropbox, Google Drive, OneDrive or Syncthing already syncs. Do the same on your other device (edit ',
        el('code', {}, 'mundusmaker.config.json'), ' next to the app, or use the box below). Only edit on one device at a time — the last save wins.'),
      el('div', { class: 'row' }, pathInput, moveBtn),
      syncNote);

    aboutWrap.innerHTML = '';
    aboutWrap.append(
      el('div', { class: 'small' }, el('strong', {}, `MundusMaker ${status.version}`),
        el('span', { class: 'muted' }, ` — running locally on ${status.platform}, nothing leaves this machine.`)),
      el('p', { class: 'muted small', style: 'margin:10px 0 4px' },
        'Free and open source under the MIT license. Third-party material bundled with the app:'),
      el('ul', { class: 'muted small', style: 'margin:4px 0 0 18px;padding:0' },
        el('li', {}, 'jsPDF — MIT license (vendored, used for the exported books).'),
        el('li', {}, 'Monster statblocks from the System Reference Document 5.1, and D&D 2024 character options from the System Reference Document 5.2 — both © Wizards of the Coast LLC, ',
          'licensed under the Creative Commons Attribution 4.0 International License (CC-BY-4.0).'),
        el('li', {}, 'The Vampire: The Masquerade creator is unofficial fan material under the World of Darkness Dark Pack. ',
          'Portions of the materials are the copyrights and trademarks of Paradox Interactive AB, and are used with permission. All rights reserved. ',
          'For more information please visit ', el('a', { href: 'https://www.worldofdarkness.com', target: '_blank', rel: 'noopener' }, 'worldofdarkness.com'), '.'),
        el('li', {}, 'The Call of Cthulhu creator is unofficial fan material under Chaosium’s Fan Material Policy. ',
          'Call of Cthulhu is a trademark of Chaosium Inc. Neither creator bundles any rules text — descriptions are yours to fill in from your own books.')));
  })();

  // ---------- backup ----------
  const withImages = el('input', { type: 'checkbox' });
  const backupCard = el('div', {},
    el('div', { class: 'row' },
      el('button', {
        onclick: async () => {
          const data = await api.backup(withImages.checked);
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          if (blob.size > 64 * 1024 * 1024) {
            toast('That backup is over 64 MB — for image-heavy worlds, syncing or copying the data folder itself is the better tool.', 7000);
          }
          downloadBlob(blob, `${(state.world.name || 'world').replace(/\W+/g, '-').toLowerCase()}-backup.json`);
          toast('Backup downloaded');
        },
      }, 'Download backup (.json)'),
      el('label', { class: 'small', style: 'display:flex;align-items:center;gap:6px' },
        withImages, 'Include images (portraits & uploads)')),
    el('p', { class: 'muted small', style: 'margin:8px 0 0' },
      'Backs up the current world. Restoring lives on the ', el('a', { href: '#/import' }, 'Import page'),
      '. Each world is also plain JSON files in the data folder — copy it anywhere, or put it in git.'));

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Settings'),
    el('div', { class: 'card' }, el('h3', {}, 'Data folder & sync'), syncWrap),
    el('div', { class: 'card' }, el('h3', {}, 'Backup'), backupCard),
    // migration-from-older-installs card lands here in 0.11 (plan phase B5)
    el('div', { class: 'card' }, el('h3', {}, 'About'), aboutWrap)));
}
