// App settings: where the data lives, backups, and what MundusMaker is made of.
// World content (types, calendar, entries) is managed on the dashboard and its
// own pages — this page is about the app itself.

import { el, toast, downloadBlob } from '../util.js';
import { state, loadAll, refreshWorlds, requireSaved } from '../state.js';
import { api } from '../api.js';
import { quitMundusMaker } from '../quit.js';
import { folderBackupCard } from './folderbackup.js';

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

// What Check for updates found, as plain text and at most one github.com link.
function updateMessage(result, status) {
  if (!result.configured) {
    return [el('div', { class: 'notice' }, 'Update checks are not switched on yet: this copy of MundusMaker does not name a public release page. Nothing was contacted.')];
  }
  if (!result.latest) return [el('div', { class: 'notice' }, result.note || 'No release has been published yet.')];
  if (!result.newer) return [el('div', { class: 'notice' }, `You have the newest version (${result.current}).`)];
  const release = result.release || {};
  const howTo = status.deployment === 'container'
    ? 'Pull the new image and restart the container (see DOCKER.md in your download); the /data volume keeps your worlds.'
    : status.deployment === 'mobile'
      ? 'Install the new app over this one; updating keeps your worlds.'
      : 'Download it from the release page and follow its install notes. Updating keeps your worlds.';
  const url = typeof release.url === 'string' && release.url.startsWith('https://github.com/') ? release.url : null;
  return [el('div', { class: 'notice' },
    el('strong', {}, `MundusMaker ${result.latest} is available`), ` (you have ${result.current}). ${howTo} `,
    url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the release page') : null,
    release.notes ? el('details', { style: 'margin-top:6px' }, el('summary', {}, 'What’s new'),
      el('div', { style: 'white-space:pre-wrap;margin-top:4px' }, release.notes)) : null)];
}

const megabytes = (n) => `${(Number(n || 0) / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MB`;

// MundusMaker on the website (web/boot.js sets window.mundusWeb): the GM's
// account, what syncs, and signing out. Returns [panel, stop listening].
function webAccountPanel(web) {
  const line = el('div', { class: 'small' });
  const usage = el('div', { class: 'muted small', style: 'margin-top:6px' });
  const forget = el('input', { type: 'checkbox' });
  const show = (s) => line.replaceChildren('Signed in as ', el('strong', {}, web.user?.email || 'you'), '. ',
    s.state === 'idle'
      ? `Your worlds are saved in this browser and in your account${s.lastSync ? `, last synced ${new Date(s.lastSync).toLocaleString()}` : ''}.`
      : s.message || 'Your worlds are saved in this browser; changes go to your account as soon as they can.');
  const off = web.onStatus(show);
  show(web.status());
  web.usage().then((u) => {
    if (u && u.limits) usage.textContent = `Your account holds ${megabytes(u.bytes)} of ${megabytes(u.limits.bytes)} in ${u.files} file${u.files === 1 ? '' : 's'}.`;
  });
  // A browser that hasn't promised to keep its copy may clear it when space runs low.
  const kept = el('div', { class: 'small', style: 'margin-top:8px' });
  const showKept = (yes) => {
    if (yes === null || yes === undefined) { kept.replaceChildren(); return; } // this browser can't say
    kept.replaceChildren(yes
      ? el('span', { class: 'muted' }, '✓ This browser has agreed to keep its copy of your worlds, even when space runs low.')
      : el('div', { class: 'notice warn' },
        '⚠ This browser may clear its copy of your worlds when space runs low, and Safari also clears sites you haven’t visited for about a week. ',
        'Everything that synced stays in your account; only changes that haven’t synced yet, and the things kept just in this browser, would be lost. ',
        el('button', {
          class: 'small', style: 'margin-top:6px',
          onclick: async () => {
            const yesNow = await web.storage.persist();
            showKept(yesNow);
            toast(yesNow ? 'This browser will keep your worlds, even when space runs low.'
              : 'The browser said no. Installing MundusMaker from the address bar, or allowing storage in this site’s settings, can change that.', 8000);
          },
        }, 'Ask the browser again')));
  };
  if (web.storage) web.storage.persisted().then(showKept);
  const panel = el('div', {},
    line, usage, kept,
    el('p', { class: 'muted small', style: 'margin:10px 0 6px' },
      'Each world’s entries and pictures go to your account, so they open in any browser you sign in to. ',
      'History, exports, the trash and library packs stay in the browser that made them. ',
      'If the same entry changes in two browsers before they sync, both versions are kept: the entry shows the other one as a copy to compare.'),
    el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;align-items:center' },
      el('button', { onclick: () => { web.syncNow(); toast('Syncing with your account…'); } }, '⟳ Sync now'),
      el('button', {
        onclick: async () => {
          try { await requireSaved(); } catch (err) { toast(err.message, 6000); return; }
          const s = web.status();
          if (forget.checked && (s.pending || s.state !== 'idle')
            && !confirm('Some changes have not reached your account yet. Remove this browser’s copy anyway? Those changes would be lost.')) return;
          await web.signOut({ forget: forget.checked });
        },
      }, 'Sign out'),
      el('label', { class: 'small', style: 'display:flex;align-items:center;gap:6px' }, forget, 'Also remove my worlds from this browser')),
    el('p', { class: 'muted small', style: 'margin:8px 0 0' },
      'Signing out keeps this browser’s copy for the next time you sign in, unless you tick the box; your account keeps everything that synced.'));
  return [panel, off];
}

export function render(container) {
  // ---------- data folder & sync ----------
  const syncWrap = el('div', {}, el('span', { class: 'muted small' }, 'Loading…'));
  const syncTitle = el('h3', {}, 'Data folder & sync');
  let stopAccount = null;
  const aboutWrap = el('div', {}, el('span', { class: 'muted small' }, 'Loading…'));

  const recoveryWrap = el('div', {}, el('span', { class: 'muted small' }, 'Loading...'));
  // Quit: launchers start MundusMaker without a window, so this is one way to
  // stop it. Hidden for a Docker server, whose lifecycle Docker owns.
  // Stop by itself once no tab has checked in for a while (server.js scheduleAutoStop)
  const after = (minutes) => minutes === 60 ? 'an hour' : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  let autoStopShown = 0;
  const autoStop = el('select', { id: 'autoStop', onchange: async () => {
    try {
      await api.setAutoStop(Number(autoStop.value));
      autoStopShown = Number(autoStop.value);
      toast(autoStopShown ? `MundusMaker will stop ${after(autoStopShown)} after its last tab closes.` : 'MundusMaker will keep running until you quit it.');
    } catch (err) { autoStop.value = String(autoStopShown); toast(`Not saved: ${err.message}`, 5000); }
  } }, el('option', { value: '0' }, 'Keep running until I quit it'), [5, 15, 60].map((m) => el('option', { value: String(m) }, `Stop after ${after(m)}`)));
  const runCard = el('div', { class: 'card', hidden: true }, el('h3', {}, 'Running MundusMaker'),
    el('p', { class: 'muted small' }, 'MundusMaker runs in the background, so closing this tab does not stop it or lose anything. ',
      'Quit it when you are done, here or with ⏻ Quit at the top right; saves in progress finish first. The MundusMaker icon in the Windows tray or the Mac menu bar can quit it too.'),
    el('button', { onclick: () => quitMundusMaker() }, 'Quit MundusMaker'),
    el('div', { class: 'row', style: 'margin-top:12px;gap:8px;align-items:center;flex-wrap:wrap' },
      el('label', { for: 'autoStop' }, 'When its last tab closes:'), autoStop),
    el('p', { class: 'muted small', style: 'margin-top:6px' }, 'Browsers sometimes put a tab you have not looked at for a while to sleep, and a sleeping tab counts as closed. ',
      'If MundusMaker stops while a tab is still open, that tab says so: start MundusMaker again and reload it.'));
  const integrityWrap = el('div', {}, el('span', { class: 'muted small' }, 'Checking map links...'));

  (async () => {
    let status;
    try { status = await api.status(); } catch {
      syncWrap.textContent = 'Status unavailable. Is the local server running?';
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
          await requireSaved();
          const res = await api.setDataDir(target, true);
          syncNote.textContent = `✓ Copied ${res.copied} world(s) to ${res.dataDir}. Restart MundusMaker to finish: quit it (below, or from its tray or menu-bar icon) and start it again.`;
          syncNote.style.color = 'var(--ok)';
        } catch (err) {
          toast('Could not set data folder: ' + err.message, 5000);
        }
      },
    }, 'Copy data there & use it');
    syncWrap.innerHTML = '';
    syncWrap.append(
      el('div', { class: 'small' }, 'Your worlds are stored in: ', el('code', {}, status.dataDir),
        el('span', { class: 'muted' }, ` (set via ${status.configuredVia})`)),
      el('p', { class: 'muted small', style: 'margin:10px 0 6px' },
        'To sync between devices: point the data folder at a folder that Dropbox, Google Drive, OneDrive or Syncthing already syncs. Do the same on your other device (edit ',
        el('code', {}, 'mundusmaker.config.json'), ' next to the app, or use the box below). Only edit on one device at a time and let syncing finish before opening another. MundusMaker detects file changes already on disk and preserves conflicting drafts in the data folder’s .conflicts folder.'),
      el('div', { class: 'row' }, pathInput, moveBtn),
      syncNote);
    runCard.hidden = status.deployment === 'container' || status.deployment === 'mobile' || status.deployment === 'web';
    autoStopShown = Number(status.autoStop) || 0;
    // a value written into the config file by hand still shows as itself
    if (![...autoStop.options].some((o) => Number(o.value) === autoStopShown)) autoStop.append(el('option', { value: String(autoStopShown) }, `Stop after ${after(autoStopShown)}`));
    autoStop.value = String(autoStopShown);
    if (status.deployment === 'container') {
      syncWrap.replaceChildren(
        el('div', { class: 'small' }, 'Your worlds are stored on your server in ', el('code', {}, status.dataDir), '.'),
        el('p', { class: 'muted small' }, 'Open this same server address on your other devices to use the same worlds. Wait for Saved before switching devices.'),
        el('p', { class: 'muted small' }, 'Docker manages this data volume. To change its location or back up every world and library pack, follow DOCKER.md in your download. Folder paths here refer to the server, not this browser’s computer.'),
        el('p', { class: 'muted small' }, 'Anyone with the server password has full DM access. Give players exported handouts or the player handbook; player preview does not restrict their access to the server.'));
    } else if (status.deployment === 'mobile') {
      // The phone app keeps its data folder inside the app, where nothing else can read it.
      syncWrap.replaceChildren(
        el('div', { class: 'small' }, 'Your worlds are stored inside the MundusMaker app on this device, where other apps cannot read them.'),
        el('p', { class: 'muted small' }, 'To move a world between this device and a computer, use Download backup below (tick Include images), send the file over, then Import → Restore a backup on the other side. Edit on one device at a time.'),
        el('p', { class: 'muted small' }, 'Uninstalling the app removes its worlds unless you choose to keep the app’s data, so keep a recent backup somewhere safe.'));
    } else if (status.deployment === 'web' && window.mundusWeb) {
      syncTitle.textContent = 'Your account & sync';
      const [panel, off] = webAccountPanel(window.mundusWeb);
      stopAccount = off;
      syncWrap.replaceChildren(panel);
    }

    // Check for updates: the server asks the release feed only on this click
    // (scripts/updates.js). It reports; it never downloads or installs.
    const updateResult = el('div', { class: 'small', style: 'margin-top:6px' });
    const updateButton = el('button', {
      class: 'ghost small', title: 'Ask the project’s release page whether a newer MundusMaker exists',
      onclick: async () => {
        updateButton.disabled = true;
        updateResult.replaceChildren(el('span', { class: 'muted' }, 'Checking…'));
        try {
          updateResult.replaceChildren(...updateMessage(await api.checkForUpdates(), status));
        } catch (err) {
          updateResult.replaceChildren(el('div', { class: 'notice warn' }, err.message));
        } finally {
          updateButton.disabled = false;
        }
      },
    }, '⟳ Check for updates');

    aboutWrap.innerHTML = '';
    aboutWrap.append(
      el('div', { class: 'small' }, el('strong', {}, `MundusMaker ${status.version}`),
        el('span', { class: 'muted' }, status.deployment === 'container'
          ? ` — hosted on your ${status.platform} server; your browsers connect to its saved worlds.`
          : status.deployment === 'mobile'
            ? ` — the ${({ android: 'Android', ios: 'iOS' })[status.platform] || status.platform} app; your world data never leaves this device.`
            : status.deployment === 'web'
            ? ' — running in your browser; your worlds are kept in this browser and in your account on this website.'
            : ` — running locally on ${status.platform}; your world data never leaves this machine.`)),
      el('div', { class: 'row', style: 'margin-top:6px' },
        // the website always runs its newest version
        status.deployment === 'web' ? null : updateButton,
        el('button', {
          class: 'ghost small', title: 'Show the three welcome panes again',
          onclick: () => import('./onboarding.js').then((m) => m.showOnboarding()),
        }, '↻ Replay the welcome tour')),
      status.deployment === 'web' ? el('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'The website always runs the newest MundusMaker. ',
        el('a', { href: window.mundusWeb?.releases || 'https://github.com/Rjani007/MundusMaker/releases/latest', target: '_blank', rel: 'noopener noreferrer' }, 'Download it for your computer'),
        ' to keep worlds in a folder of your own, with no account.') : el('p', { class: 'muted small', style: 'margin:6px 0 0' }, status.updates?.configured
        ? 'Check for updates asks GitHub for the newest release, only when you press it. Nothing about your worlds is sent, and nothing is downloaded or installed.'
        : 'Check for updates will ask the project’s release page for the newest version once MundusMaker is published. Until then it contacts nothing.'),
      updateResult,
      el('p', { class: 'muted small', style: 'margin:10px 0 4px' },
        'Free and open source under the MIT license. Third-party material bundled with the app:'),
      el('ul', { class: 'muted small', style: 'margin:4px 0 0 18px;padding:0' },
        el('li', {}, 'jsPDF — MIT license (vendored, used for the exported books).'),
        el('li', {}, 'DejaVu Serif and Sans 2.37 — offline handout fonts, based on Bitstream Vera with DejaVu and Arev contributions. ',
          el('a', { href: 'vendor/fonts/LICENSE.txt', target: '_blank', rel: 'noopener' }, 'Font copyright and license'), '.'),
        el('li', {}, 'Monster statblocks from the System Reference Document 5.1, D&D 2024 character options from SRD 5.2, and DM Screen reminders adapted from SRD 5.2.1 — by Wizards of the Coast LLC, ',
          'licensed under the Creative Commons Attribution 4.0 International License (CC-BY-4.0).'),
        el('li', {}, 'The optional Library downloader makes an explicit request to the public 5etools source mirror only when you press Download & import. ',
          'It uploads nothing and stores only your selected, locally trimmed pack; use it only for material you are allowed to use.'),
        el('li', {}, el('img', { src: 'vendor/dark-pack.webp', alt: 'World of Darkness Dark Pack', width: 100, style: 'display:block;margin:12px 0' }),
          'The Vampire: The Masquerade creator and references are unofficial fan material under the ',
          el('a', { href: 'https://www.paradoxinteractive.com/games/world-of-darkness/community/dark-pack-agreement', target: '_blank', rel: 'noopener' }, 'World of Darkness Dark Pack'), '. ',
          'Portions of the materials are the copyrights and trademarks of Paradox Interactive AB, and are used with permission. All rights reserved. ',
          'For more information please visit ', el('a', { href: 'https://www.worldofdarkness.com', target: '_blank', rel: 'noopener' }, 'worldofdarkness.com'), '.'),
        el('li', {}, 'The Call of Cthulhu creator is unofficial fan material under Chaosium’s Fan Material Policy. ',
          'Call of Cthulhu is a trademark of Chaosium Inc. The V5 and CoC DM Screen references are original mechanical summaries with source links; no publisher rulebook prose or power descriptions are reproduced.'),
        el('li', {}, 'Terrain world maps follow the approach of mapgen4 by Amit Patel (Red Blob Games, Apache-2.0), and their erosion options the rain-and-sediment and river-network methods of Daniel Andrino’s Terrain Erosion 3 Ways (MIT). ',
          'Modern city maps trace streets through a tensor field, the method of Chen, Esch, Wonka, Müller and Zhang (SIGGRAPH 2008) that Keir’s MapGenerator (LGPL-3.0) made popular. ',
          'All of these were written from the published methods for MundusMaker; no code from those projects is included.'),
        el('li', {}, 'The familiar character sheet layouts are drawn for MundusMaker. They follow the arrangement and field names of each game’s character sheet so players can find their numbers, but they are not official sheets and contain no publisher logos, artwork or fonts.'),
        el('li', {}, 'Official sheet… fills your own copy of a publisher’s free fillable character sheet on this computer. MundusMaker ships no publisher sheets: the publishers allow them for personal use only. When you press Get it from…, it downloads the sheet from the publisher’s own website, once, for you; otherwise you add the PDF yourself. The sheets stay in your data folder and are not part of world backups.')));
  })();

  // ---------- backup ----------
  const withImages = el('input', { type: 'checkbox' });
  const backupCard = el('div', {},
    el('div', { class: 'row' },
      el('button', {
        onclick: async () => {
          try {
            await requireSaved();
            const data = await api.backup(withImages.checked);
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            if (blob.size > 64 * 1024 * 1024) {
              toast('That backup is over 64 MB — for image-heavy worlds, syncing or copying the data folder itself is the better tool.', 7000);
            }
            downloadBlob(blob, `${(state.world.name || 'world').replace(/\W+/g, '-').toLowerCase()}-backup.json`);
            toast('Backup downloaded');
          } catch (err) { toast('Backup could not be made: ' + err.message, 8000); }
        },
      }, 'Download backup (.json)'),
      el('label', { class: 'small', style: 'display:flex;align-items:center;gap:6px' },
        withImages, 'Include images (portraits & uploads)')),
    el('p', { class: 'muted small', style: 'margin:8px 0 0' },
      'Backs up the current world. Restore is on the ', el('a', { href: '#/import' }, 'Import page'),
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
        await requireSaved();
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

  // ---------- map link integrity ----------
  async function loadLinkIntegrity() {
    if (!state.gm) {
      integrityWrap.innerHTML = '';
      integrityWrap.append(el('div', { class: 'notice warn' },
        'Map link details are available in GM view because they may name hidden maps and entries.'));
      return;
    }

    integrityWrap.innerHTML = '';
    integrityWrap.append(el('span', { class: 'muted small' }, 'Checking map links...'));
    let data;
    try {
      data = await api.linkIntegrity();
    } catch (err) {
      integrityWrap.textContent = 'Could not check map links: ' + err.message;
      return;
    }

    const worlds = Array.isArray(data.worlds) ? data.worlds : [];
    const checked = worlds.reduce((sum, world) => sum + Number(world.links || 0), 0);
    const broken = worlds.reduce((sum, world) => sum + (world.danglingLinks?.length || 0), 0);
    integrityWrap.innerHTML = '';

    if (!broken) {
      integrityWrap.append(el('div', { class: 'notice' },
        `Checked ${checked} map link${checked === 1 ? '' : 's'} in ${worlds.length} world${worlds.length === 1 ? '' : 's'}. Every linked entry is present.`));
      return;
    }

    integrityWrap.append(el('div', { class: 'notice warn' },
      `Checked ${checked} map link${checked === 1 ? '' : 's'} in ${worlds.length} world${worlds.length === 1 ? '' : 's'} and found ${broken} broken link${broken === 1 ? '' : 's'}. This report is read-only.`));
    for (const world of worlds.filter((item) => item.danglingLinks?.length)) {
      const rows = world.danglingLinks.map((item) => {
        const site = item.siteName ? `“${item.siteName}” (${item.siteKey})` : item.siteKey;
        const mapTitle = item.mapName === item.mapId ? item.mapName : `${item.mapName} (${item.mapId})`;
        return recoveryRow(mapTitle,
          `${item.mapKind} map. Site ${site}. Missing entry ID: ${item.targetId}.`,
          null);
      });
      const worldTitle = world.name === world.id ? world.name : `${world.name} (${world.id})`;
      integrityWrap.append(recoveryList(
        worldTitle,
        `${world.danglingLinks.length} broken link${world.danglingLinks.length === 1 ? '' : 's'} in this world.`,
        rows));
    }
  }
  loadLinkIntegrity();

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Settings'),
    el('div', { class: 'card' }, syncTitle, syncWrap),
    el('div', { class: 'card' }, el('h3', {}, 'Backup'), backupCard),
    folderBackupCard(),
    el('div', { class: 'card' }, el('h3', {}, 'Map link check'), integrityWrap),
    el('div', { class: 'card' }, el('h3', {}, 'Trash & snapshots'), recoveryWrap),
    runCard,
    el('div', { class: 'card' }, el('h3', {}, 'About'), aboutWrap)));
  return () => { if (stopAccount) stopAccount(); };
}
