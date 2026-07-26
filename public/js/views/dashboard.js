// World dashboard: name/description, stats, recent entries, world management,
// backup/restore.

import { el, toast, downloadBlob } from '../util.js';
import { state, types, typeOf, visibleEntities, scheduleWorldSave, createEntity, refreshWorlds } from '../state.js';
import { snippetFor } from '../render.js';
import { api } from '../api.js';
import { switchTo } from '../main.js';

export function render(container) {
  const w = state.world;
  const ents = visibleEntities();
  const saveWorldSoon = scheduleWorldSave;

  const nameInput = el('input', {
    class: 'ent-title', value: w.name, placeholder: 'World name',
    oninput: (ev) => { w.name = ev.target.value; saveWorldSoon(); },
  });

  const desc = el('textarea', {
    placeholder: 'What is this world? A sentence or two shown on exports.',
    oninput: (ev) => { w.description = ev.target.value; saveWorldSoon(); },
  });
  desc.value = w.description || '';

  const eraInput = el('input', {
    value: w.era || '', placeholder: 'e.g. AR',
    style: 'width:110px',
    oninput: (ev) => { w.era = ev.target.value; saveWorldSoon(); },
  });

  // Real links: the stylesheet has always given these cards a pointer cursor and
  // a hover border, so they advertised a click target that did nothing.
  const stats = el('div', { class: 'stat-cards' },
    Object.entries(types()).map(([key, t]) => {
      const n = ents.filter((e) => e.type === key).length;
      const label = t.plural || t.label;
      return el('a', {
        class: 'stat-card', href: `#/t/${encodeURIComponent(key)}`,
        style: `border-left:3px solid ${t.color}`, title: `Open the ${label} page`,
      },
        el('div', { class: 'num' }, n),
        el('div', { class: 'lbl' }, label));
    }));

  const recent = [...ents].sort((a, b) => (b.updated || '').localeCompare(a.updated || '')).slice(0, 8);

  const quickName = el('input', { placeholder: 'New entry name…', style: 'flex:1' });
  const quickType = el('select', {},
    Object.entries(types()).map(([key, t]) => el('option', { value: key }, t.label)));
  const quickCreate = async () => {
    const name = quickName.value.trim();
    if (!name) return;
    const e = await createEntity(name, quickType.value);
    location.hash = `#/e/${e.id}`;
  };
  quickName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') quickCreate(); });

  // ---------- worlds management ----------
  const worldsWrap = el('div', {});
  function refreshWorldList() {
    worldsWrap.innerHTML = '';
    for (const world of state.worlds) {
      const isCurrent = world.id === state.worldId;
      worldsWrap.append(el('div', { class: 'world-row' },
        el('span', { class: 'wname' }, world.name),
        el('span', { class: 'muted small' }, `${world.entities} ${world.entities === 1 ? 'entry' : 'entries'}`),
        isCurrent ? el('span', { class: 'type-badge' }, 'current') : null,
        el('span', { class: 'spacer' }),
        isCurrent ? null : el('button', { class: 'small', onclick: () => switchTo(world.id) }, 'Open'),
        isCurrent || state.worlds.length <= 1 ? null : el('button', {
          class: 'ghost danger small',
          onclick: async () => {
            if (!confirm(`Delete the world “${world.name}” (${world.entities} entries)?\n\nIt is moved to the data folder's .trash — recoverable by hand, but gone from MundusMaker.`)) return;
            await api.deleteWorld(world.id);
            await refreshWorlds();
            refreshWorldList();
            toast(`“${world.name}” moved to .trash`);
          },
        }, 'Delete')));
    }
    const newName = el('input', { placeholder: 'New world name…', style: 'flex:1' });
    const create = async () => {
      if (!newName.value.trim()) return;
      const { id } = await api.createWorld(newName.value.trim());
      await refreshWorlds();
      await switchTo(id);
    };
    newName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') create(); });
    worldsWrap.append(el('div', { class: 'row', style: 'margin-top:10px' },
      newName,
      el('button', { onclick: create }, '+ Create world')));
  }
  refreshWorldList();

  // The calendar editor moved to its own page (#/calendar) — months, lengths,
  // special days, ages and today's date no longer fit in a dashboard card.
  const calendarCard = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('a', { href: '#/calendar' }, '📅 Calendar'),
      el('span', { class: 'muted small' }, 'Months and their lengths, special days, ages, today’s date.')));

  // ---------- sync across devices ----------
  const syncWrap = el('div', {}, el('span', { class: 'muted small' }, 'Loading…'));
  (async () => {
    let status;
    try { status = await api.status(); } catch { syncWrap.textContent = 'Status unavailable.'; return; }
    const pathInput = el('input', {
      placeholder: status.platform === 'win32' ? 'e.g. C:\\Users\\you\\Dropbox\\MundusMaker' : 'e.g. /Users/you/Dropbox/MundusMaker',
      style: 'flex:1;min-width:0',
    });
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
    const syncNote = el('div', { class: 'small', style: 'margin-top:6px;color:var(--muted)' });
    syncWrap.innerHTML = '';
    syncWrap.append(
      el('div', { class: 'small' }, 'Your worlds live in: ', el('code', {}, status.dataDir),
        el('span', { class: 'muted' }, ` (set via ${status.configuredVia})`)),
      el('p', { class: 'muted small', style: 'margin:10px 0 6px' },
        'To sync between devices: point the data folder at a folder that Dropbox, Google Drive, OneDrive or Syncthing already syncs. Do the same on your other device (edit ',
        el('code', {}, 'mundusmaker.config.json'), ' next to the app, or use the box below). Only edit on one device at a time — the last save wins.'),
      el('div', { class: 'row' }, pathInput, moveBtn),
      syncNote);
  })();

  container.append(el('div', { class: 'page' },
    nameInput,
    el('div', { class: 'card world-desc', style: 'margin-top:14px' },
      el('h3', {}, 'About this world'),
      desc,
      el('div', { class: 'row small', style: 'margin-top:8px' },
        el('span', { class: 'muted' }, 'Era suffix for timeline years:'), eraInput)),
    stats,
    el('div', { class: 'card' },
      el('h3', {}, 'Create'),
      el('div', { class: 'row' }, quickName, quickType,
        el('button', { class: 'primary', onclick: quickCreate }, '+ Create'),
        el('span', { class: 'spacer' }),
        el('a', { href: '#/import', title: 'Import Obsidian/Markdown notes or 5e.tools monsters' }, '⬇ Import…'))),
    recent.length
      ? el('div', { class: 'card' },
          el('h3', {}, 'Recently updated'),
          recent.map((e) => el('div', { style: 'margin:6px 0' },
            el('span', { class: 'dot', style: `background:${typeOf(e).color};margin-right:8px` }),
            el('a', { href: `#/e/${e.id}` }, e.name),
            ' ',
            el('span', { class: 'muted small' }, snippetFor(e, 90)))))
      : el('div', { class: 'notice' },
          // "empty" is a lie when the entries exist but are all GM-only
          state.entities.size
            ? '👁 Every entry here is GM-only. Switch to GM view in the top bar to see them.'
            : ['Nothing here yet. Name your first entry above — or ',
               el('a', { href: '#/import' }, 'import notes you already have'), '.']),
    calendarCard,
    el('div', { class: 'card' },
      el('h3', {}, 'Your worlds'),
      worldsWrap),
    el('div', { class: 'card' },
      el('h3', {}, 'Sync across devices'),
      syncWrap),
    el('div', { class: 'card' },
      el('h3', {}, 'Backup'),
      el('div', { class: 'row' },
        el('button', {
          onclick: async () => {
            const data = await api.backup();
            downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
              `${(w.name || 'world').replace(/\W+/g, '-').toLowerCase()}-backup.json`);
            toast('Backup downloaded');
          },
        }, 'Download backup (.json)'),
        el('button', {
          onclick: () => {
            const input = el('input', { type: 'file', accept: '.json' });
            input.addEventListener('change', async () => {
              const file = input.files[0];
              if (!file) return;
              if (!confirm('Restoring replaces ALL entries in the CURRENT world with the backup. Continue?')) return;
              try {
                const payload = JSON.parse(await file.text());
                await api.restore(payload);
                location.reload();
              } catch (err) {
                toast('Restore failed: ' + err.message);
              }
            });
            input.click();
          },
        }, 'Restore from backup…'),
        el('span', { class: 'muted small' }, 'Each world also lives as plain JSON files in the data folder — copy it anywhere, or put it in git.')))));
}
