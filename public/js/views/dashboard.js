// World dashboard: name/description, stats, recent entries, world management.
// Backup/restore and the data-folder card moved to #/settings in 0.10.

import { el, toast, readSetting, writeSetting, compareNames } from '../util.js';
import { state, types, typeOf, visibleEntities, scheduleWorldSave, createEntity, refreshWorlds } from '../state.js';
import { snippetFor } from '../render.js';
import { api } from '../api.js';
import { switchTo } from '../main.js';
import { advanceDate, daysUntilAnnual, formatDate, isRecurring } from '../calendar.js';
import { nameStyleForType, randomName } from '../names.js';

// One cheap scan per app load, and only while the user still has nothing but
// the sample world — an upgrader's first boot is exactly when it helps.
let scannedThisLoad = false;

function maybeOfferMigration(container) {
  if (scannedThisLoad || readSetting('migrateDismissed')) return;
  if (state.worlds.length !== 1 || state.worlds[0]?.id !== 'the-sundered-reach') return;
  scannedThisLoad = true;
  api.scanInstalls().then((found) => {
    if (!found.length || !container.isConnected) return;
    const worlds = found.flatMap((f) => f.worlds);
    container.prepend(el('div', { class: 'notice', style: 'margin-bottom:14px' },
      `📦 Found ${worlds.length} world${worlds.length === 1 ? '' : 's'} from an older install (${found[0].path}${found.length > 1 ? ', …' : ''}). `,
      el('a', { href: '#/import' }, 'Bring them in from the Import page'), ' — the old copy stays untouched. ',
      el('button', {
        class: 'ghost small',
        onclick: (ev) => { writeSetting('migrateDismissed', '1'); ev.target.closest('.notice').remove(); },
      }, 'Dismiss')));
  }).catch(() => { /* scanning is best-effort */ });
}

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

  // ---------- campaign clock ----------
  // Holidays are ordinary recurring entities, so visibleEntities() already
  // applies the same gmOnly rule as every other dashboard surface.
  const clockWrap = el('div', {});
  function refreshClock() {
    const cal = w.calendar || {};
    const today = cal.todayDate;
    const dateText = formatDate(today, cal, w.era) || cal.today || '';
    const upcoming = ents
      .filter((entry) => isRecurring(entry.date))
      .map((entry) => ({ entry, days: daysUntilAnnual(today, entry.date, cal) }))
      .filter((x) => Number.isFinite(x.days))
      .sort((a, b) => a.days - b.days || compareNames(a.entry.name, b.entry.name))[0];
    clockWrap.innerHTML = '';
    clockWrap.append(el('div', { class: 'row', style: 'align-items:center' },
      el('div', { style: 'flex:1;min-width:0' },
        el('div', {}, dateText ? ['Today is ', el('strong', {}, dateText)] : el('span', { class: 'muted' }, 'Today is not set yet.')),
        upcoming ? el('div', { class: 'muted small', style: 'margin-top:4px' },
          el('a', { href: `#/e/${upcoming.entry.id}` }, upcoming.entry.name),
          upcoming.days === 0 ? ' is today' : ` in ${upcoming.days} day${upcoming.days === 1 ? '' : 's'}`)
          : el('div', { class: 'muted small', style: 'margin-top:4px' },
            'Recurring events appear here as the next holiday.')),
      state.gm ? el('button', {
        class: 'primary small', disabled: !advanceDate(today, cal, 0),
        title: today ? 'Move the structured campaign date forward one day' : 'Set a structured date in Calendar first',
        onclick: () => {
          const next = advanceDate(cal.todayDate, cal, 1);
          if (!next) { toast('Set a valid structured date in Calendar first.'); return; }
          cal.todayDate = next;
          cal.today = formatDate(next, cal, w.era);
          saveWorldSoon();
          refreshClock();
        },
      }, 'Advance a day') : null,
      el('a', { href: '#/calendar', class: 'small' }, dateText ? 'Calendar' : 'Set date')));
  }
  refreshClock();

  const quickName = el('input', { placeholder: 'New entry name…', style: 'flex:1' });
  const quickStyle = el('select', { title: 'Kind of name to roll' },
    [['person', 'person'], ['settlement', 'settlement'], ['tavern', 'tavern'], ['ward', 'ward'],
      ['nation', 'nation'], ['region', 'region'], ['landmark', 'landmark']]
      .map(([value, label]) => el('option', { value }, label)));
  const quickType = el('select', {},
    Object.entries(types()).map(([key, t]) => el('option', { value: key }, t.label)));
  const syncQuickStyle = () => { quickStyle.value = nameStyleForType(quickType.value); };
  quickType.addEventListener('change', syncQuickStyle);
  syncQuickStyle();
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
            if (!confirm(`Delete the world “${world.name}” (${world.entities} entries)?\n\nIt is moved to the data folder's .trash and can be restored from Settings → Trash & snapshots.`)) return;
            await api.deleteWorld(world.id);
            await refreshWorlds();
            refreshWorldList();
            toast(`“${world.name}” moved to .trash; restore it from Settings`, 6000);
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
      el('button', { class: 'ghost', title: 'Roll a nation-style world name', onclick: () => { newName.value = randomName('nation'); newName.focus(); } }, '🎲'),
      el('button', { onclick: create }, '+ Create world')));
  }
  refreshWorldList();

  // The calendar editor moved to its own page (#/calendar) — months, lengths,
  // special days, ages and today's date no longer fit in a dashboard card.
  const calendarCard = el('div', { class: 'card' },
    el('h3', {}, '📅 Campaign clock'),
    clockWrap);

  const page = el('div', { class: 'page' },
    el('div', { class: 'row' }, nameInput,
      state.gm ? el('button', {
        class: 'ghost', title: 'Roll a nation-style world name',
        onclick: () => { nameInput.value = randomName('nation'); w.name = nameInput.value; saveWorldSoon(); },
      }, '🎲') : null),
    el('div', { class: 'card world-desc', style: 'margin-top:14px' },
      el('h3', {}, 'About this world'),
      desc,
      el('div', { class: 'row small', style: 'margin-top:8px' },
        el('span', { class: 'muted' }, 'Era suffix for timeline years:'), eraInput)),
    el('div', { class: 'row', style: 'margin-top:18px' }, el('h3', {}, 'Categories'), el('span', { class: 'spacer' }),
      el('a', { href: '#/categories' }, state.gm ? 'Browse / add categories →' : 'Browse categories →')),
    stats,
    el('div', { class: 'card' },
      el('h3', {}, 'Create'),
      el('div', { class: 'row' }, quickName,
        el('button', {
          class: 'ghost', title: 'Roll a name using the selected style',
          onclick: () => { quickName.value = randomName(quickStyle.value); quickName.focus(); },
        }, '🎲'), quickStyle, quickType,
        el('button', { class: 'primary', onclick: quickCreate }, '+ Create'),
        el('span', { class: 'spacer' }),
        el('a', { href: '#/create', title: 'Guided character creation: D&D 5.5e, Vampire V5, Call of Cthulhu' }, '🎭 Create a character…'),
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
        el('span', { class: 'muted small' }, 'Data folder & device sync, backups, about.'))));
  container.append(page);
  maybeOfferMigration(page);
}
