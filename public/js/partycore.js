// Party panel values (1.9), pure: read from a character sheet each time,
// never stored. party.js renders them; tests import this directly.

import { mod, profBonus, passivePerception, fmtMod } from './sheets/dndrules.js';

/** The first sheet on an entry and the stats that matter at the table. */
export function partyStats(entity) {
  const block = (entity?.blocks || []).find((b) => b.kind === 'sheet' && b.data);
  if (!block) return null;
  const d = block.data;
  if (block.system === 'dnd2024') {
    const pb = profBonus(d.klass?.level), hp = d.hp || {};
    return { system: 'D&D', stats: [
      ['AC', d.ac ?? 10],
      ['HP', `${hp.current ?? 0}/${hp.max ?? 0}${hp.temp ? ` +${hp.temp}` : ''}`],
      ['Passive Perception', passivePerception({ ...d, abilities: d.abilities || {} }, pb)],
      ['Spell save DC', d.spellcasting?.dc ?? '—'],
      ['Initiative', fmtMod(mod(d.abilities?.dex) + (d.initiativeBonus || 0))],
    ] };
  }
  if (block.system === 'vtm5') {
    const a = d.attributes || {};
    const left = (max, t = {}) => `${Math.max(0, max - (t.superficial || 0) - (t.aggravated || 0))}/${max}`;
    return { system: 'V5', stats: [
      ['Hunger', d.hunger ?? 0],
      ['Health', left((a.stamina ?? 1) + 3, d.health)],
      ['Willpower', left((a.composure ?? 1) + (a.resolve ?? 1), d.willpower)],
      ['Humanity', d.humanity ?? 7],
    ] };
  }
  if (block.system === 'coc7') {
    return { system: 'CoC', stats: [
      ['HP', `${d.hp?.current ?? 0}/${d.hp?.max ?? 0}`],
      ['SAN', d.san?.current ?? 0],
      ['MP', `${d.mp?.current ?? 0}/${d.mp?.max ?? 0}`],
      ['Luck', d.luck ?? 0],
    ] };
  }
  return null;
}
