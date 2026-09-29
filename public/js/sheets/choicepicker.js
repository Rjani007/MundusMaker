import { el } from '../util.js';
import { sourceLabel } from './dndrules.js';

export function choicePicker({ items, selected, onPick, describe = () => '', details = () => '', browse = {}, label = 'choices' }) {
  const wrap = el('div', { class: 'choice-browser' }), grid = el('div', { class: 'choice-grid' });
  const count = el('div', { class: 'muted small', role: 'status' });
  const query = el('input', { type: 'search', value: browse.query || '', placeholder: `Search ${label}…`, 'aria-label': `Search ${label}`, oninput: () => { browse.query = query.value; browse.limit = 30; draw(); } });
  const source = el('select', { 'aria-label': `Filter ${label} by source`, onchange: () => { browse.source = source.value; browse.limit = 30; draw(); } },
    el('option', { value: '' }, 'All sources'), [...new Set(items.map(sourceLabel))].sort().map(s => el('option', { value: s }, s)));
  source.value = browse.source || '';
  const more = el('button', { class: 'ghost small', onclick: () => { browse.limit = (browse.limit || 30) + 30; draw(); } }, 'Show more');
  function draw() {
    grid.replaceChildren();
    const q = query.value.trim().toLowerCase();
    const matches = items.filter(item => (!source.value || sourceLabel(item) === source.value)
      && `${item.name} ${describe(item)} ${sourceLabel(item)}`.toLowerCase().includes(q));
    const limit = browse.limit || 30;
    count.textContent = `${matches.length} ${label}${selected ? ` · selected: ${selected.name || selected}` : ''}`;
    for (const item of matches.slice(0, limit)) grid.append(el('button', {
      type: 'button', class: `choice-card${(selected?.name || selected) === item.name ? ' selected' : ''}`,
      'aria-pressed': String((selected?.name || selected) === item.name), onclick: () => onPick(item),
    }, el('strong', {}, item.name), el('span', { class: 'small muted' }, describe(item)), el('span', { class: 'choice-source' }, sourceLabel(item))));
    if (!matches.length) grid.append(el('p', { class: 'notice' }, 'No matching choices. Try another search or source.'));
    more.hidden = matches.length <= limit;
  }
  wrap.append(el('div', { class: 'choice-filters row' }, query, source), count, grid, more);
  const pick = items.find(item => item.name === (selected?.name || selected));
  if (pick) {
    const content = details(pick);
    wrap.append(el('details', { class: 'choice-detail', open: true }, el('summary', {}, `About ${pick.name}`),
      typeof content === 'string' ? el('div', { class: 'choice-prose' }, content || 'No description included in this source.') : content));
  }
  draw(); return wrap;
}

export function spellPicker({ items, picks, onChange, limit, title, browse = {} }) {
  const wrap = el('section', { class: 'spell-picker' }), list = el('div', { class: 'spell-choices' });
  const count = el('span', { class: 'small', role: 'status' });
  const search = el('input', { type: 'search', value: browse.query || '', placeholder: 'Search name, school or source…', 'aria-label': `Search ${title}`, oninput: () => { browse.query = search.value; draw(); } });
  const source = el('select', { 'aria-label': `${title} source`, onchange: draw }, el('option', { value: '' }, 'All sources'),
    [...new Set(items.map(sourceLabel))].sort().map(s => el('option', { value: s }, s)));
  const selectedOnly = el('input', { type: 'checkbox', onchange: draw });
  function draw() {
    list.replaceChildren();
    count.textContent = `${picks.length}${limit == null ? '' : ` / ${limit}`} selected`;
    const names = new Set(items.map(s => s.name));
    for (const missing of picks.filter(n => !names.has(n))) list.append(el('label', { class: 'notice warn small' },
      el('input', { type: 'checkbox', checked: true, onchange: () => { picks.splice(picks.indexOf(missing), 1); onChange(picks); draw(); } }),
      `${missing} — unavailable for this choice; remove it or restore its source.`));
    const matches = items.filter(s => (!source.value || sourceLabel(s) === source.value) && (!selectedOnly.checked || picks.includes(s.name))
      && `${s.name} ${s.school} ${sourceLabel(s)}`.toLowerCase().includes(search.value.toLowerCase()));
    for (const s of matches) {
      const checked = picks.includes(s.name);
      list.append(el('div', { class: `spell-choice${checked ? ' selected' : ''}` },
        el('label', {}, el('input', { type: 'checkbox', checked, disabled: !checked && limit != null && picks.length >= limit,
          onchange: ev => { if (ev.target.checked) picks.push(s.name); else picks.splice(picks.indexOf(s.name), 1); onChange(picks); draw(); } }),
          el('strong', {}, s.name), el('span', { class: 'small muted' }, ` ${s.level ? `Level ${s.level}` : 'Cantrip'} · ${s.school || ''}`)),
        el('details', {}, el('summary', { class: 'small muted' }, `${sourceLabel(s)} · Details`),
          el('p', { class: 'small' }, [s.castingTime, s.range, s.components, s.duration, s.concentration ? 'Concentration' : '', s.ritual ? 'Ritual' : ''].filter(Boolean).join(' · ')),
          !s.classes?.length && s._pack ? el('p', { class: 'notice small' }, 'This pack has no class list for this spell. Check its availability with your DM.') : null,
          el('div', { class: 'choice-prose small' }, s.text || 'No description in this pack.'))));
    }
    if (!matches.length) list.append(el('p', { class: 'muted small' }, 'No matching spells.'));
  }
  wrap.append(el('div', { class: 'row' }, el('h3', {}, title), count), el('div', { class: 'row choice-filters' }, search, source,
    el('label', { class: 'small' }, selectedOnly, ' Selected only')), list);
  draw(); return wrap;
}
