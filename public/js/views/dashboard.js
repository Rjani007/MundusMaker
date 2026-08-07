// World dashboard: name/description, stats, recent entries, world management.
// Backup/restore and the data-folder card moved to #/settings in 0.10.

import { el, toast } from '../util.js';
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
      el('div', { class: 'row' },
        el('a', { href: '#/settings' }, '⚙ App settings'),
        el('span', { class: 'muted small' }, 'Data folder & device sync, backups, about.')))));
}
