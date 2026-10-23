// The SRD and 5etools library as searchable rows: the bundled SRD content plus
// every imported pack, normalized and tagged with `_pack`. The Library page and
// the Handouts card picker search the same rows. Cached until a pack changes.

import { api } from './api.js';
import { loadAllMonsters, invalidateLibraryCache, normalizeSpell, normalizeItem } from './importers.js';

let spellsCache = null, itemsCache = null;

export async function loadSpells() {
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

export async function loadItems() {
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

/** Call after a pack is imported, downloaded or removed. */
export function invalidateCompendium() {
  spellsCache = null;
  itemsCache = null;
  invalidateLibraryCache();
}

const crOf = (m) => (typeof m.cr === 'object' ? m.cr?.cr : m.cr);

export const COMPENDIUM = {
  monster: {
    label: '🐉 Monsters', noun: 'monsters',
    filters: [['', 'any CR'], ...['0', '1/8', '1/4', '1/2', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((cr) => [cr, `CR ${cr}`])],
  },
  spell: {
    label: '✨ Spells', noun: 'spells',
    filters: [['', 'any level'], ...Array.from({ length: 10 }, (_, i) => [String(i), i === 0 ? 'cantrips' : `level ${i}`])],
  },
  item: {
    label: '🗡 Items', noun: 'items',
    filters: [['', 'all items'], ['weapon', 'weapons'], ['armor', 'armor & shields'], ['gear', 'gear']],
  },
};

/** Rows of one kind whose name contains `query`, narrowed by a COMPENDIUM filter value. */
export async function searchCompendium(kind, query = '', filter = '') {
  const q = query.trim().toLowerCase();
  const named = (row) => !q || row.name.toLowerCase().includes(q);
  if (kind === 'monster') {
    return (await loadAllMonsters()).filter((m) => named(m) && (!filter || String(crOf(m) ?? '') === filter));
  }
  if (kind === 'spell') {
    return (await loadSpells()).filter((s) => named(s) && (filter === '' || String(s.level) === filter));
  }
  return (await loadItems()).filter((i) => {
    if (!named(i)) return false;
    if (filter === 'weapon' && !/weapon/.test(i.kind)) return false;
    if (filter === 'armor' && !/armor|shield/.test(i.kind)) return false;
    if (filter === 'gear' && /weapon|armor|shield/.test(i.kind)) return false;
    return true;
  });
}

/** The one-line description a list shows beside a row's name. */
export function rowSummary(kind, row) {
  if (kind === 'monster') return `CR ${crOf(row) ?? '?'} · ${row._pack}`;
  if (kind === 'spell') return `${row.level === 0 ? 'cantrip' : `L${row.level}`} ${row.school} · ${row._pack}`;
  return `${row.kind}${row.rarity ? ` · ${row.rarity}` : ''} · ${row._pack}`;
}
