// App settings: where the data lives, backups, and what MundusMaker is made of.
// World content (types, calendar, entries) is managed on the dashboard and its
// own pages — this page is about the app itself.

import { el, toast, downloadBlob } from '../util.js';
import { state, loadAll, refreshWorlds } from '../state.js';
import { api } from '../api.js';

async function recoveryRequest(method, body) {
  const response = await fetch(method === 'GET' ? '/api/recovery' : '/api/recovery/restore', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let message = response.statusText;
    try { message = (await response.json()).error || message; } catch { /* keep status text */ }
    throw new Error(message);
  }
  return response.json();
}

function recoveryMoment(value) {
  if (!value) return 'date unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'date unknown' : date.toLocaleString();
}

function recoveryList(title, note, items) {
  return el('section', { style: 'margin-top:16px' },
    el('h4', { style: 'margin:0 0 3px' }, `${title} (${items.length})`),
    el('p', { class: 'muted small', style: 'margin:0 0 7px' }, note),
    items.length
      ? el('div', { class: 'import-list', style: 'margin-top:0' }, items)
      : el('div', { class: 'notice' }, 'Nothing here.'));
}

function recoveryRow(primary, secondary, button) {
  return el('div', {
    style: 'display:flex;align-items:center;gap:12px;padding:9px 2px;border-bottom:1px solid var(--line)',
  },
  el('div', { style: 'flex:1;min-width:0' },
    el('div', { style: 'overflow-wrap:anywhere' }, el('strong', {}, primary)),
    el('div', { class: 'muted small', style: 'margin-top:2px;overflow-wrap:anywhere' }, secondary)),
  button);
}

export function render(container) {
  // ---------- data folder & sync ----------
  const syncWrap = el('div', {}, el('span', { class: 'muted small' }, 'Loading…'));
  const aboutWrap = el('div', {}, el('span', { class: 'muted small' }, 'Loading…'));

  const recoveryWrap = el('div', {}, el('span', { class: 'muted small' }, 'Loading...'));

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
        el('span', { class: 'muted' }, ` — running locally on ${status.platform}; your world data never leaves this machine.`)),
      el('div', { class: 'row', style: 'margin-top:6px' },
        el('button', {
          class: 'ghost small', title: 'Show the three welcome panes again',
          onclick: () => import('./onboarding.js').then((m) => m.showOnboarding()),
        }, '↻ Replay the welcome tour')),
      el('p', { class: 'muted small', style: 'margin:10px 0 4px' },
        'Free and open source under the MIT license. Third-party material bundled with the app:'),
      el('ul', { class: 'muted small', style: 'margin:4px 0 0 18px;padding:0' },
        el('li', {}, 'jsPDF — MIT license (vendored, used for the exported books).'),
        el('li', {}, 'Monster statblocks from the System Reference Document 5.1, and D&D 2024 character options from the System Reference Document 5.2 — both © Wizards of the Coast LLC, ',
          'licensed under the Creative Commons Attribution 4.0 International License (CC-BY-4.0).'),
        el('li', {}, 'The optional Library downloader makes an explicit request to the public 5etools source mirror only when you press Download & import. ',
          'It uploads nothing and stores only your selected, locally trimmed pack; use it only for material you are allowed to use.'),
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

  // ---------- trash & snapshots ----------
  async function loadRecovery() {
    if (!state.gm) {
      recoveryWrap.innerHTML = '';
      recoveryWrap.append(el('div', { class: 'notice warn' },
        'Recovery is available in GM view so deleted secret entries are not revealed in player preview.'));
      return;
    }
    recoveryWrap.innerHTML = '';
    recoveryWrap.append(el('span', { class: 'muted small' }, 'Checking Trash and snapshots...'));
    let data;
    try {
      data = await recoveryRequest('GET');
    } catch (err) {
      recoveryWrap.textContent = 'Recovery list unavailable: ' + err.message;
      return;
    }

    async function restore(button, payload, promptText) {
      if (!confirm(promptText)) return;
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = 'Restoring...';
      try {
        const result = await recoveryRequest('POST', { ...payload, confirm: true });
        const restored = result.restored;
        if (result.kind === 'entity') {
          if (restored.worldId === state.worldId) await loadAll();
          else await refreshWorlds();
          toast(`Restored ${restored.name}${restored.renamed ? ` as ${restored.entityId}` : ''}. The Trash copy is still safe.`, 7000);
        } else {
          await refreshWorlds();
          toast(`Restored ${restored.name} as world "${restored.worldId}". The recovery source is unchanged.`, 7000);
        }
        await loadRecovery();
      } catch (err) {
        toast('Could not restore: ' + err.message, 7000);
        button.disabled = false;
        button.textContent = oldText;
      }
    }

    const entityRows = data.trash.entities.map((item) => {
      const needsDestination = !!item.destinationRequired;
      const button = el('button', {
        disabled: needsDestination,
        title: needsDestination ? 'Choose the world this entry belongs to' : 'Restore a copy of this entry',
      }, 'Restore');
      const chooser = needsDestination ? el('select', {
        title: 'Destination world',
        'aria-label': `Destination world for ${item.name}`,
        style: 'max-width:230px',
        onchange: (event) => { button.disabled = !event.target.value; },
      },
      el('option', { value: '' }, 'Choose destination...'),
      state.worlds.map((world) => el('option', { value: world.id }, `${world.name} (${world.id})`))) : null;
      button.onclick = () => {
        const destinationWorldId = chooser ? chooser.value : item.worldId;
        const destination = state.worlds.find((world) => world.id === destinationWorldId);
        if (!destinationWorldId || !destination) {
          toast('Choose an existing destination world first.');
          return;
        }
        restore(button, { kind: 'entity', key: item.key, destinationWorldId },
          `Restore "${item.name}" to "${destination.name}" (${destination.id})?\n\nNo live entry will be overwritten. If its old ID is occupied, MundusMaker will give the restored entry a new one.`);
      };
      const detail = `${item.worldName} | ${item.type} | deleted ${recoveryMoment(item.deletedAt)}`
        + (item.destinationAmbiguous ? ' | a deleted world with this ID also exists; choose the correct destination'
          : !item.worldAvailable ? ' | original world is not live; choose a destination'
            : item.idCollision ? ' | old entry ID is in use; a new ID will be chosen' : '');
      const controls = el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end' },
        chooser, button);
      return recoveryRow(item.name, detail, controls);
    });

    const worldRows = data.trash.worlds.map((item) => {
      const button = el('button', {}, 'Restore');
      button.onclick = () => restore(button, { kind: 'world', key: item.key },
        `Restore "${item.name}" as a world?\n\nThe deleted copy stays in Trash, and an existing world with the same ID will not be overwritten.`);
      const detail = `${item.entities} entr${item.entities === 1 ? 'y' : 'ies'} | deleted ${recoveryMoment(item.deletedAt)}`
        + (item.idCollision ? ' | its old ID is in use; a new ID will be chosen' : '');
      return recoveryRow(item.name, detail, button);
    });

    const snapshotRows = data.snapshots.map((item) => {
      const button = el('button', {}, 'Restore copy');
      button.onclick = () => restore(button, { kind: 'snapshot', worldId: item.worldId, stamp: item.stamp },
        `Restore the ${recoveryMoment(item.createdAt)} snapshot of "${item.name}"?\n\nIt will become a separate world. Your current world and the snapshot will both stay unchanged.`);
      return recoveryRow(item.name,
        `${item.entities} entr${item.entities === 1 ? 'y' : 'ies'} | snapshot ${recoveryMoment(item.createdAt)}`,
        button);
    });

    recoveryWrap.innerHTML = '';
    recoveryWrap.append(
      el('div', { class: 'notice' },
        'Recovery is copy-only: it never overwrites a live file, and the source stays in Trash or snapshots. Restored snapshots become separate worlds.'),
      recoveryList('Deleted entries', 'When an original world is missing or ambiguous, choose the correct existing world before restoring.', entityRows),
      recoveryList('Deleted worlds', 'A restored world keeps its old ID when available, otherwise it gets a safe new one.', worldRows),
      recoveryList('Snapshots', 'Up to seven automatic snapshots per world; restoring one never rolls back the live world.', snapshotRows));
  }
  loadRecovery();

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Settings'),
    el('div', { class: 'card' }, el('h3', {}, 'Data folder & sync'), syncWrap),
    el('div', { class: 'card' }, el('h3', {}, 'Backup'), backupCard),
    el('div', { class: 'card' }, el('h3', {}, 'Trash & snapshots'), recoveryWrap),
    // migration-from-older-installs card lands here in 0.11 (plan phase B5)
    el('div', { class: 'card' }, el('h3', {}, 'About'), aboutWrap)));
}
