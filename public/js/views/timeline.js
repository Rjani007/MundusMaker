// Timeline: every entity with a date, in chronological order — plus a separate
// band for the ones that come round every year.
//
// WHY TWO LISTS. A recurring date (recurs: 'annual') has no year at all, so
// feeding it to a chronological comparator produces undefined - undefined = NaN
// and an unstable, silently wrong order. isHistoric() filters them out before
// any year comparison; they are ordered by slot (the position of their month or
// special day in the year) with slotSortKey instead.

import { el } from '../util.js';
import { state, types, typeOf, visibleEntities } from '../state.js';
import { snippetFor, formatWorldDate } from '../render.js';
import { isHistoric, isRecurring, histSortKey, slotSortKey, cmpKey, formatYear, hasAges, ageBands } from '../calendar.js';

export function render(container) {
  const cal = state.world.calendar;
  const era = () => state.world.era || '';
  const enabled = new Set(Object.keys(types()));
  const list = el('div', {});

  const ticked = () => visibleEntities().filter((e) => e.date && enabled.has(e.type));

  function historic() {
    return ticked().filter((e) => isHistoric(e.date))
      .sort((a, b) => cmpKey(histSortKey(a.date, cal), histSortKey(b.date, cal)));
  }
  function annual() {
    return ticked().filter((e) => isRecurring(e.date))
      .sort((a, b) => cmpKey(slotSortKey(a.date, cal), slotSortKey(b.date, cal)) || a.name.localeCompare(b.name));
  }

  const onTimeline = (d) => isHistoric(d) || isRecurring(d);
  const anyRecurring = visibleEntities().some((e) => isRecurring(e.date));
  const presentTypes = new Set(visibleEntities().filter((e) => onTimeline(e.date)).map((e) => e.type));
  // a dated entry whose type the world no longer defines still gets a ticked
  // checkbox below, so it has to be in `enabled` or the tick would be a lie
  for (const key of presentTypes) enabled.add(key);
  const filters = el('div', { class: 'row', style: 'margin-bottom:14px' },
    [...presentTypes].map((key) => {
      const t = types()[key] || { label: key, color: '#888' };
      return el('label', { class: 'row small', style: 'gap:5px;cursor:pointer' },
        el('input', {
          type: 'checkbox', checked: true,
          onchange: (ev) => { ev.target.checked ? enabled.add(key) : enabled.delete(key); refresh(); },
        }),
        el('span', { class: 'dot', style: `background:${t.color}` }), t.plural || t.label);
    }));

  /** Three different empty timelines, three different next actions. */
  function emptyNotice() {
    if (presentTypes.size) {
      return el('div', { class: 'notice' }, 'No dated entries of the ticked types. Tick another one above.');
    }
    const newest = [...visibleEntities()].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))[0];
    if (!newest) {
      return el('div', { class: 'notice' },
        'The timeline lists every dated entry in order — wars, births, the founding of cities. ',
        el('a', { href: '#/' }, 'Create your first entry'), ' to start one.');
    }
    return el('div', { class: 'notice' },
      'Nothing on the timeline yet. Open an entry — say ',
      el('a', { href: `#/e/${newest.id}` }, newest.name),
      ' — and click “+ Add to timeline” to give it a date.');
  }

  function row(e) {
    const d = e.date;
    return el('div', { class: 'tl-item' },
      el('div', { class: 'tl-date' },
        formatWorldDate(d),
        // a recurring date has no year, so it can never carry a range
        isHistoric(d) && d.endYear
          ? el('span', { class: 'tl-range' }, `until ${formatYear(d.endYear, cal, era())}`)
          : null),
      el('div', { class: 'tl-body' },
        el('div', {},
          el('span', { class: 'dot', style: `background:${typeOf(e).color};margin-right:8px` }),
          el('a', { href: `#/e/${e.id}` }, e.name),
          ' ',
          el('a', {
            class: 'type-badge', style: 'margin-left:6px',
            href: `#/t/${encodeURIComponent(e.type || '')}`,
            title: `Open the ${typeOf(e).plural || typeOf(e).label} page`,
          }, typeOf(e).label),
          e.gmOnly && state.gm ? el('span', {
            class: 'gm-only-badge', style: 'margin-left:6px',
            title: 'GM-only — invisible to players everywhere, including exports',
          }, '🔒 GM') : null),
        el('div', { class: 'snippet' }, snippetFor(e))));
  }

  /** An age band header: the age's name, plus the year it opens on. */
  function bandHead(band) {
    return el('h2', { class: 'tl-section tl-band' },
      band.label,
      Number.isFinite(band.age?.startYear)
        ? el('span', { class: 'tl-band-from' }, `from ${band.age.startYear}`)
        : null);
  }

  function refresh() {
    list.innerHTML = '';
    const items = historic();
    const repeats = annual();
    if (!items.length && !repeats.length) {
      list.append(emptyNotice());
      return;
    }
    // Bands come from the filtered list, so unticking a type can empty an age out
    // of existence, and a band never announces an age only GM-only entries live in.
    if (hasAges(cal)) {
      for (const band of ageBands(items, cal, (e) => e.date)) {
        list.append(bandHead(band));
        for (const e of band.items) list.append(row(e));
      }
    } else {
      for (const e of items) list.append(row(e));
    }
    if (repeats.length) {
      list.append(el('h2', { class: 'tl-section' }, 'Every year'),
        el('div', { class: 'muted small', style: 'margin:-4px 0 12px' },
          'Holidays, festivals and anything else that comes round again. These have no year, so they sit outside the history above.'));
      for (const e of repeats) list.append(row(e));
    }
  }
  refresh();

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Timeline'),
    state.world.calendar?.today
      ? el('div', { class: 'muted', style: 'margin:-6px 0 14px' }, `📅 Current date: ${state.world.calendar.today}`)
      : null,
    filters,
    list,
    anyRecurring ? null : el('div', { class: 'muted small', style: 'margin-top:22px' },
      'Making a holiday? Give an entry a date and tick “Repeats every year” — it gets its own section here. Months, special days and ages live on the ',
      el('a', { href: '#/calendar' }, 'Calendar'), ' page.')));
}
