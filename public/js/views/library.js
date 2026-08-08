// Compendium library: browse the bundled SRD content and your own imported
// 5e.tools packs across all worlds, and drop anything into the current world
// as a normal entity. GM-only, like the Import page.

import { el, uid, toast } from '../util.js';
import { state, types, newEntity, saveEntity, findByName } from '../state.js';
import {
  loadAllMonsters, invalidateLibraryCache, monsterToStat,
  normalizeSpell, spellToEntity, normalizeItem, itemToEntity,
} from '../importers.js';
import { crFromStat } from '../encounter.js';
import { api } from '../api.js';

let spellsCache = null, itemsCache = null;

async function loadSpells() {
  if (spellsCache) return spellsCache;
  const out = [];
  try {
    const res = await fetch('/srd52/spells.json');
    if (res.ok) out.push(...(await res.json()).spells.map((s) => ({ ...normalizeSpell(s), _pack: 'SRD 5.2' })));
  } catch { /* pack-only */ }
  try {
    for (const meta of await api.library()) {
      if (!meta.kinds?.includes('spell')) continue;
      const pack = await api.libraryPack(meta.id);
      out.push(...(pack.spell || []).map((s) => ({ ...normalizeSpell(s), _pack: meta.name })));
    }
  } catch { /* no server library */ }
  spellsCache = out;
  return out;
}

async function loadItems() {
  if (itemsCache) return itemsCache;
  const out = [];
  try {
    const res = await fetch('/srd52/equipment.json');
    if (res.ok) out.push(...(await res.json()).equipment.map((i) => ({ ...normalizeItem(i), _pack: 'SRD 5.2' })));
  } catch { /* pack-only */ }
  try {
    for (const meta of await api.library()) {
      if (!meta.kinds?.includes('item')) continue;
      const pack = await api.libraryPack(meta.id);
      out.push(...(pack.item || []).map((i) => ({ ...normalizeItem(i), _pack: meta.name })));
    }
  } catch { /* no server library */ }
  itemsCache = out;
  return out;
}

function invalidateAll() {
  spellsCache = null;
  itemsCache = null;
  invalidateLibraryCache();
}

export function render(container) {
  if (!state.gm) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice warn' }, 'The library is a GM area — switch to GM view first.')));
    return;
  }

  let tab = 'monsters';
  let query = '';
  let filter = '';
  let expanded = null;

  const searchInput = el('input', {
    type: 'search', placeholder: 'Search…', style: 'flex:1',
    oninput: (ev) => { query = ev.target.value.trim().toLowerCase(); expanded = null; renderList(); },
  });
  const filterSel = el('select', { onchange: (ev) => { filter = ev.target.value; expanded = null; renderList(); } });
  const listWrap = el('div', { class: 'import-list', style: 'max-height:none' });
  const countNote = el('span', { class: 'muted small' });

  const tabsRow = el('div', { class: 'tool-row' },
    [['monsters', '🐉 Monsters'], ['spells', '✨ Spells'], ['items', '🗡 Items']].map(([key, label]) =>
      el('button', {
        class: tab === key ? 'on' : '',
        onclick: (ev) => {
          tab = key;
          tabsRow.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
          ev.target.classList.add('on');
          query = '';
          searchInput.value = '';
          filter = '';
          expanded = null;
          syncFilter();
          renderList();
        },
      }, label)));

  function syncFilter() {
    filterSel.innerHTML = '';
    if (tab === 'spells') {
      filterSel.append(el('option', { value: '' }, 'any level'),
        ...Array.from({ length: 10 }, (_, i) => el('option', { value: String(i) }, i === 0 ? 'cantrips' : `level ${i}`)));
    } else if (tab === 'monsters') {
      filterSel.append(el('option', { value: '' }, 'any CR'),
        ...['0', '1/8', '1/4', '1/2', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((cr) => el('option', { value: cr }, `CR ${cr}`)));
    } else {
      filterSel.append(el('option', { value: '' }, 'all items'),
        el('option', { value: 'weapon' }, 'weapons'),
        el('option', { value: 'armor' }, 'armor & shields'),
        el('option', { value: 'gear' }, 'gear'));
    }
  }
  syncFilter();

  async function addMonster(mon) {
    if (findByName(mon.name)) { toast(`“${mon.name}” already exists`); return; }
    const stat = monsterToStat(mon);
    const e = newEntity(mon.name, types().creature ? 'creature' : 'note');
    e.tags = [String(typeof mon.type === 'string' ? mon.type : mon.type?.type || '').toLowerCase(), `cr-${crFromStat(stat) || '0'}`].filter(Boolean);
    e.blocks = [{ id: uid(), kind: 'statblock', text: '', secret: false, stat }];
    await saveEntity(e);
    toast(`Added ${mon.name} to ${state.world.name}`);
  }

  async function addSpell(sp) {
    if (findByName(sp.name)) { toast(`“${sp.name}” already exists`); return; }
    await saveEntity(spellToEntity(sp, newEntity));
    toast(`Added ${sp.name} to ${state.world.name}`);
  }

  async function addItem(it) {
    if (findByName(it.name)) { toast(`“${it.name}” already exists`); return; }
    await saveEntity(itemToEntity(it, newEntity));
    toast(`Added ${it.name} to ${state.world.name}`);
  }

  async function renderList() {
    listWrap.innerHTML = '';
    listWrap.append(el('div', { class: 'muted small', style: 'padding:8px' }, 'Loading…'));
    let rows = [];
    if (tab === 'monsters') {
      const all = await loadAllMonsters();
      rows = all.filter((m) => {
        if (query && !m.name.toLowerCase().includes(query)) return false;
        if (filter && String(typeof m.cr === 'object' ? m.cr?.cr : m.cr ?? '') !== filter) return false;
        return true;
      });
    } else if (tab === 'spells') {
      rows = (await loadSpells()).filter((s) => {
        if (query && !s.name.toLowerCase().includes(query)) return false;
        if (filter !== '' && String(s.level) !== filter) return false;
        return true;
      });
    } else {
      rows = (await loadItems()).filter((i) => {
        if (query && !i.name.toLowerCase().includes(query)) return false;
        if (filter === 'weapon' && !/weapon/.test(i.kind)) return false;
        if (filter === 'armor' && !/armor|shield/.test(i.kind)) return false;
        if (filter === 'gear' && /weapon|armor|shield/.test(i.kind)) return false;
        return true;
      });
    }
    countNote.textContent = `${rows.length} ${tab}`;
    listWrap.innerHTML = '';
    for (const row of rows.slice(0, 300)) {
      const name = row.name;
      const sub = tab === 'monsters'
        ? `CR ${typeof row.cr === 'object' ? row.cr?.cr : row.cr ?? '?'} · ${row._pack}`
        : tab === 'spells'
          ? `${row.level === 0 ? 'cantrip' : `L${row.level}`} ${row.school} · ${row._pack}`
          : `${row.kind}${row.rarity ? ` · ${row.rarity}` : ''} · ${row._pack}`;
      const rowEl = el('div', { class: 'import-row', style: 'cursor:pointer;flex-wrap:wrap' },
        el('span', {}, name),
        el('span', { class: 'muted small' }, sub),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'ghost small',
          onclick: (ev) => {
            ev.stopPropagation();
            if (tab === 'monsters') addMonster(row);
            else if (tab === 'spells') addSpell(row);
            else addItem(row);
          },
        }, '+ Add to world'));
      rowEl.addEventListener('click', () => {
        expanded = expanded === row ? null : row;
        renderList();
      });
      listWrap.append(rowEl);
      if (expanded === row) {
        const detail = tab === 'spells'
          ? [`${row.castingTime} · ${row.range} · ${row.duration}`, row.components ? `Components: ${row.components}` : '', row.text, row.higherLevel ? `At higher levels. ${row.higherLevel}` : ''].filter(Boolean).join('\n\n')
          : tab === 'items'
            ? [[row.cost, row.weight ? `${row.weight} lb.` : '', row.damage, row.ac ? `AC ${row.ac}` : '', row.attune].filter(Boolean).join(' · '), row.text].filter(Boolean).join('\n\n')
            : `${(row.size || []).join?.('/') || ''} — use “+ Add to world” for the full statblock.`;
        listWrap.append(el('div', {
          class: 'small', style: 'padding:8px 12px;border-left:2px solid var(--accent);margin:0 0 6px;white-space:pre-wrap;color:var(--muted)',
        }, detail.slice(0, 2600)));
      }
    }
    if (rows.length > 300) {
      listWrap.append(el('div', { class: 'muted small', style: 'padding:8px' }, `Showing the first 300 of ${rows.length} — narrow the search to see the rest.`));
    }
  }

  // ---------- packs card ----------
  const packsWrap = el('div', {});
  async function renderPacks() {
    packsWrap.innerHTML = '';
    let packs = [];
    try { packs = await api.library(); } catch { /* offline? */ }
    if (!packs.length) {
      packsWrap.append(el('p', { class: 'muted small' }, 'No packs imported yet — the bundled SRD content is always available below.'));
    }
    for (const p of packs) {
      packsWrap.append(el('div', { class: 'row small', style: 'margin-top:4px' },
        el('strong', {}, p.name),
        el('span', { class: 'muted' }, Object.entries(p.counts || {}).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ')),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'ghost danger small',
          onclick: async () => {
            if (!confirm(`Remove the pack “${p.name}”? (It moves to data/.trash; entities you already added stay.)`)) return;
            await api.deleteLibraryPack(p.id);
            invalidateAll();
            renderPacks();
            renderList();
          },
        }, 'Remove')));
    }
    const input = el('input', { type: 'file', accept: '.json', style: 'display:none' });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const meta = await api.importLibraryPack(f.name.replace(/\.json$/i, ''), data);
        invalidateAll();
        toast(`Imported “${meta.name}” (${Object.entries(meta.counts).map(([k, n]) => `${n} ${k}s`).join(', ')})`);
        renderPacks();
        renderList();
      } catch (err) {
        toast('Could not import that file: ' + err.message, 5000);
      }
    });
    packsWrap.append(el('div', { class: 'row', style: 'margin-top:8px' },
      el('button', { onclick: () => input.click() }, '📦 Import a 5e.tools JSON…'),
      el('span', { class: 'muted small' }, 'bestiaries, spells or items from your own local files — stored once, available in every world'),
      input));
  }
  renderPacks();

  container.append(el('div', { class: 'page wide' },
    el('h1', {}, 'Library'),
    el('div', { class: 'card' },
      el('h3', {}, 'Content packs'),
      packsWrap),
    el('div', { class: 'card' },
      tabsRow,
      el('div', { class: 'row', style: 'margin-top:8px' }, searchInput, filterSel, countNote),
      listWrap),
    el('p', { class: 'muted small' },
      'Adding creates a normal entry in the current world (', el('strong', {}, state.world.name),
      ') — bundled content is SRD 5.1/5.2 (CC-BY-4.0); packs come from your own files.')));

  renderList();
}
