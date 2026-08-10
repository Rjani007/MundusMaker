// Per-type landing page (#/t/<key>): every entry of one type in a sortable
// table, plus a create box. Reached from the dashboard cards, the sidebar
// group headings and the type badges — the "manage my Characters" surface.

import { el, helpTip } from '../util.js';
import { state, types, typeOf, visibleEntities, createEntity } from '../state.js';
import { nameStyleForType, randomName } from '../names.js';

// Same grey state.js falls back to, so an orphan type's dot matches everywhere.
const ORPHAN = { color: '#8a8f98', fields: [] };

export function render(container, rawKey) {
  const key = String(rawKey || '');
  const known = types();
  // hasOwn, not known[key] — a type named "constructor" would otherwise look defined
  const defined = Object.hasOwn(known, key);
  const all = [...state.entities.values()].filter((e) => (e.type || '') === key);
  const ents = visibleEntities().filter((e) => (e.type || '') === key);
  const nHidden = all.length - ents.length; // GM-only, so only non-zero in player preview

  const t = defined ? known[key] : { ...ORPHAN, label: key || 'Untyped', plural: key || 'Untyped' };
  const plural = t.plural || t.label || key || 'Untyped';

  // A hash someone typed or a type that was deleted after its entries were gone.
  if (!defined && !all.length) {
    container.append(el('div', { class: 'page' },
      el('h1', {}, 'Unknown type'),
      el('div', { class: 'notice warn' },
        key ? `This world has no “${key}” entry type.` : 'That entry type doesn’t exist in this world.'),
      el('p', {}, el('a', { href: '#/' }, '← Back to your world'))));
    return;
  }

  // ---------- columns ----------
  // The type's suggested fields first, then any extra field someone added by
  // hand; only keep the ones that actually hold a value somewhere, so a fresh
  // type shows a narrow table instead of six empty columns.
  const candidates = [];
  for (const k of t.fields || []) if (k && !candidates.includes(k)) candidates.push(k);
  for (const e of ents) {
    for (const k of Object.keys(e.fields || {})) if (k && !candidates.includes(k)) candidates.push(k);
  }
  const fieldCols = candidates.filter((k) => ents.some((e) => String(e.fields?.[k] ?? '').trim()));

  const cellValue = (e, col) => (col === '' ? e.name : String(e.fields?.[col] ?? '').trim());

  let sortKey = '';   // '' = name
  let sortDir = 1;

  function sortedEnts() {
    return [...ents].sort((a, b) => {
      const av = cellValue(a, sortKey), bv = cellValue(b, sortKey);
      if (!av && !bv) return a.name.localeCompare(b.name);
      if (!av) return 1;  // blanks sink to the bottom in both directions
      if (!bv) return -1;
      const c = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
      return (c || a.name.localeCompare(b.name)) * sortDir;
    });
  }

  const tableWrap = el('div', { class: 'type-table-wrap' });

  function headCell(col, label) {
    const active = sortKey === col;
    return el('th', { class: active ? 'sorted' : '' },
      el('button', {
        class: 'th-sort', title: `Sort by ${label}`,
        onclick: () => {
          if (sortKey === col) sortDir = -sortDir;
          else { sortKey = col; sortDir = 1; }
          fillTable();
        },
      }, label, el('span', { class: 'arrow' }, active ? (sortDir > 0 ? '▲' : '▼') : '')));
  }

  function fillTable() {
    tableWrap.innerHTML = '';
    if (!ents.length) return;
    const head = el('tr', {},
      headCell('', 'Name'),
      fieldCols.map((k) => headCell(k, k)),
      el('th', {}, 'Tags'),
      el('th', {}, 'Flags',
        helpTip('🗺 has a map · ⚔ has a statblock · 🔒 GM-only: invisible to players everywhere, including exports.')));
    const body = el('tbody', {},
      sortedEnts().map((e) => el('tr', {},
        el('td', {},
          el('span', { class: 'dot', style: `background:${typeOf(e).color};margin-right:8px` }),
          el('a', { href: `#/e/${e.id}` }, e.name)),
        fieldCols.map((k) => el('td', { class: 'fld' }, String(e.fields?.[k] ?? '').trim() || '—')),
        el('td', {}, (e.tags || []).map((tag) => el('span', { class: 'tag' }, tag))),
        el('td', { class: 'flags' },
          e.map ? el('span', { title: 'has a map' }, '🗺') : null,
          (e.blocks || []).some((b) => b.kind === 'statblock') ? el('span', { title: 'has a statblock' }, '⚔') : null,
          (e.blocks || []).some((b) => b.kind === 'sheet') ? el('span', { title: 'has a character sheet' }, '🎭') : null,
          (e.blocks || []).some((b) => b.kind === 'table') ? el('span', { title: 'has a rollable table' }, '🎲') : null,
          e.gmOnly ? el('span', { title: 'GM-only — invisible to players' }, '🔒') : null))));
    tableWrap.append(el('table', { class: 'type-table' }, el('thead', {}, head), body));
  }
  fillTable();

  // ---------- create ----------
  const nameInput = el('input', { placeholder: `New ${t.label} name…`, style: 'flex:1' });
  const createOne = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const e = await createEntity(name, key);
    location.hash = `#/e/${e.id}`;
  };
  nameInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') createOne(); });

  // createEntity() falls back to 'note' for a type the world doesn't define, so
  // offering a create box on an orphan group would quietly make the wrong thing.
  const createCard = defined
    ? el('div', { class: 'card' },
        el('h3', {}, `New ${t.label}`),
        el('div', { class: 'row' }, nameInput,
          el('button', {
            class: 'ghost', title: 'Suggest a fitting name',
            onclick: () => { nameInput.value = randomName(nameStyleForType(key)); nameInput.focus(); },
          }, '🎲'),
          el('button', { class: 'primary', onclick: createOne }, '+ Create'),
          key === 'character' ? el('a', { href: '#/create', title: 'Guided, rules-checked character build with an interactive sheet' }, '🎭 …or use the character creator') : null))
    : el('div', { class: 'notice' },
        `“${key}” isn’t one of this world’s entry types — these entries came from an import, or from a type that was deleted. Open one and pick a type to file it properly.`);

  const empty = nHidden
    ? el('div', { class: 'notice' }, '👁 Every entry here is GM-only. Switch to GM view in the top bar to see them.')
    : el('div', { class: 'notice' },
        `No ${plural} yet. `,
        defined
          ? el('button', { class: 'small', onclick: () => nameInput.focus() }, `+ New ${t.label}`)
          : null);

  container.append(el('div', { class: 'page wide', style: 'max-width:1100px;margin:0 auto' },
    el('h1', {},
      el('span', { class: 'dot', style: `background:${t.color};width:12px;height:12px;margin-right:10px` }),
      plural),
    el('p', { class: 'muted small', style: 'margin:-8px 0 16px' },
      `${ents.length} ${ents.length === 1 ? 'entry' : 'entries'}`,
      nHidden ? ` · 👁 player preview: ${nHidden} GM-only ${nHidden === 1 ? 'entry is' : 'entries are'} hidden` : ''),
    createCard,
    ents.length ? tableWrap : empty));
}
