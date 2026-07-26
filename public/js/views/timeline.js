// Timeline: every entity with a date, in chronological order.

import { el } from '../util.js';
import { state, types, typeOf, visibleEntities } from '../state.js';
import { snippetFor, formatWorldDate } from '../render.js';

export function render(container) {
  const enabled = new Set(Object.keys(types()));
  const list = el('div', {});

  function dated() {
    return visibleEntities()
      .filter((e) => e.date && Number.isFinite(e.date.year) && enabled.has(e.type))
      .sort((a, b) =>
        (a.date.year - b.date.year) ||
        ((a.date.month ?? 0) - (b.date.month ?? 0)) ||
        ((a.date.day ?? 0) - (b.date.day ?? 0)));
  }

  const presentTypes = new Set(visibleEntities().filter((e) => e.date && Number.isFinite(e.date.year)).map((e) => e.type));
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

  function refresh() {
    list.innerHTML = '';
    const items = dated();
    if (!items.length) {
      list.append(el('div', { class: 'notice' },
        'Nothing on the timeline yet. Open any entry and click “+ Add to timeline” to give it a date — events, births, founding of cities, anything.'));
      return;
    }
    const era = state.world.era ? ` ${state.world.era}` : '';
    for (const e of items) {
      const d = e.date;
      list.append(el('div', { class: 'tl-item' },
        el('div', { class: 'tl-date' },
          formatWorldDate(d),
          d.endYear ? el('span', { class: 'tl-range' }, `until ${d.endYear}${era}`) : null),
        el('div', { class: 'tl-body' },
          el('div', {},
            el('span', { class: 'dot', style: `background:${typeOf(e).color};margin-right:8px` }),
            el('a', { href: `#/e/${e.id}` }, e.name),
            ' ',
            el('span', { class: 'type-badge', style: 'margin-left:6px' }, typeOf(e).label),
            e.gmOnly && state.gm ? el('span', { class: 'gm-only-badge', style: 'margin-left:6px' }, '🔒 GM') : null),
          el('div', { class: 'snippet' }, snippetFor(e)))));
    }
  }
  refresh();

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Timeline'),
    state.world.calendar?.today
      ? el('div', { class: 'muted', style: 'margin:-6px 0 14px' }, `📅 Current date: ${state.world.calendar.today}`)
      : null,
    filters,
    list));
}
