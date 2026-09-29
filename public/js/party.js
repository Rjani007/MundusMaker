// The party panel (1.9): the numbers a GM glances at during play, read from
// each character's sheet every time it renders. It stores only an ordered list
// of entry IDs (world.party), like DM Screen pins, never a copy of a value, so
// a level-up or an edited sheet shows at once. Tracker damage never changes a
// sheet (1.6), so the panel shows the sheet's own numbers. GM view only.

import { el, toast } from './util.js';
import { state, getEntity, scheduleWorldSave } from './state.js';
import { partyStats } from './partycore.js';

/** The panel for the DM Screen and Encounter pages. */
export function partyPanel({ current = () => true } = {}) {
  const world = state.world;
  const wrap = el('div', { class: 'card party-panel' });
  const ids = () => (Array.isArray(world.party) ? world.party : []);
  const setIds = (next) => {
    if (!current()) return;
    world.party = next;
    scheduleWorldSave();
    refresh();
  };
  function refresh() {
    wrap.replaceChildren(el('h3', {}, 'Party'));
    const members = ids().map((id) => getEntity(id)).filter(Boolean);
    if (!members.length) wrap.append(el('p', { class: 'muted small' }, 'Add the player characters to see their AC, hit points and the rest at a glance. Values come straight from each character sheet.'));
    const table = el('div', { class: 'party-rows' });
    members.forEach((e, i) => {
      const info = partyStats(e);
      table.append(el('div', { class: 'party-row' },
        el('a', { class: 'party-name', href: `#/e/${encodeURIComponent(e.id)}` }, e.name),
        info ? el('span', { class: 'party-system muted small' }, info.system) : null,
        el('span', { class: 'party-stats' }, info
          ? info.stats.map(([k, v]) => el('span', { class: 'party-stat' }, el('b', {}, String(v)), el('small', {}, k)))
          : el('span', { class: 'muted small' }, 'No character sheet')),
        el('span', { class: 'party-tools' },
          el('button', { class: 'ghost small', title: 'Move up', 'aria-label': `Move ${e.name} up`, disabled: i === 0, onclick: () => { const next = [...ids()]; const k = next.indexOf(e.id); [next[k - 1], next[k]] = [next[k], next[k - 1]]; setIds(next); } }, '↑'),
          el('button', { class: 'ghost small', title: 'Remove from the party (the entry stays)', 'aria-label': `Remove ${e.name} from the party`, onclick: () => setIds(ids().filter((x) => x !== e.id)) }, '✕'))));
    });
    wrap.append(table);
    const candidates = [...state.entities.values()]
      .filter((e) => !ids().includes(e.id) && (e.blocks || []).some((b) => b.kind === 'sheet'))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (candidates.length) {
      const pick = el('select', { 'aria-label': 'Character to add to the party' }, candidates.map((e) => el('option', { value: e.id }, e.name)));
      wrap.append(el('div', { class: 'row', style: 'margin-top:8px' }, pick,
        el('button', { class: 'small', onclick: () => { if (!ids().includes(pick.value)) setIds([...ids(), pick.value]); else toast('Already in the party.'); } }, 'Add to party')));
    }
  }
  refresh();
  return { element: wrap, refresh };
}
