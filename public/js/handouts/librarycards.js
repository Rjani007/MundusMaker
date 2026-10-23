// Cards made from library rows (the bundled SRD and imported 5etools packs).
// Pure: a row in, an ordinary card handout out. The text lives in the entry's
// own blocks like any handout, so the GM can edit or delete any of it; the
// handout keeps only presentation, slots and `library`, which records the row
// a card came from so the same row reuses its card instead of making another.
import { HANDOUT_KINDS } from './handoutcore.js';
import { monsterToStat } from '../importers.js';

// 5etools weapon property codes, as the bundled SRD 5.2 equipment carries them.
const PROPERTIES = { A: 'Ammunition', AF: 'Ammunition', BF: 'Burst fire', F: 'Finesse', H: 'Heavy', L: 'Light', LD: 'Loading', R: 'Reach', RLD: 'Reload', S: 'Special', T: 'Thrown', '2H': 'Two-handed', V: 'Versatile' };
// The bundled content is CC-BY-4.0 and a card reproduces it, so it says where
// it came from. Imported packs are the GM's own files and get no credit line.
const CREDITS = { 'SRD 5.2': 'From the SRD 5.2 · CC-BY-4.0', SRD: 'From the SRD 5.1 · CC-BY-4.0' };
const capital = (text) => text ? text[0].toUpperCase() + text.slice(1) : '';
const lines = (pairs) => pairs.filter(([, value]) => value != null && String(value).trim()).map(([key, value]) => `${key}: ${value}`).join('\n');

export const libraryRef = (kind, row) => ({ kind, name: row.name, pack: row._pack || '' });

/** True when `entity` is the card made from this library row. */
export function isCardFor(entity, kind, row) {
  const ref = entity?.handout?.library, want = libraryRef(kind, row);
  return !!ref && ref.kind === want.kind && ref.name === want.name && ref.pack === want.pack;
}

function itemText(row) {
  const props = (row.properties || []).map((p) => PROPERTIES[String(p).split('|')[0]] || String(p).split('|')[0]);
  return {
    subtitle: [capital(row.kind), row.rarity, row.attune].filter(Boolean).join(' · '),
    details: lines([
      ['Damage', row.damage],
      ['Armor Class', row.ac == null || row.ac === '' ? '' : /shield/i.test(row.kind) ? `+${row.ac}` : row.ac],
      ['Properties', props.join(', ')],
      ['Weight', row.weight ? `${row.weight} lb.` : ''],
      ['Cost', row.cost],
    ]),
    body: row.text,
  };
}

function spellText(row) {
  const school = capital(row.school || '');
  return {
    subtitle: `${row.level === 0 ? `${school} cantrip` : `Level ${row.level} ${school}`}${row.ritual ? ' (ritual)' : ''}`.trim(),
    details: lines([
      ['Casting time', row.castingTime],
      ['Range', row.range],
      ['Components', row.components],
      ['Duration', row.duration],
      ['Classes', (row.classes || []).join(', ')],
    ]),
    body: [row.text, row.higherLevel].filter(Boolean).join('\n\n'),
  };
}

// Players see a monster's name and kind; its numbers are a GM note, and the
// description is left for the GM to write.
function monsterText(row) {
  const stat = monsterToStat(row), challenge = stat.vitals.find((v) => v.k === 'Challenge')?.v;
  return {
    subtitle: capital(stat.meta),
    body: '',
    gm: lines([['Armor Class', stat.ac], ['Hit Points', stat.hp], ['Speed', stat.speed], ['Challenge', challenge]]),
  };
}

/** Fills `entity` (a fresh handout entry) with a card for one library row. */
export function libraryCard(kind, row, entity, makeId) {
  const text = kind === 'monster' ? monsterText(row) : kind === 'spell' ? spellText(row) : itemText(row);
  const slots = {}, blocks = [];
  const add = (role, blockKind, value, secret = false) => {
    const id = makeId(); slots[id] = role;
    blocks.push({ id, kind: blockKind, text: value, secret });
  };
  add('title', 'heading', row.name);
  if (text.subtitle) add('subtitle', 'text', text.subtitle);
  if (text.details) add('body', 'text', text.details);
  add('body', 'text', text.body || '');
  if (text.gm) add('body', 'text', text.gm, true);
  if (CREDITS[row._pack]) add('credit', 'text', CREDITS[row._pack]);
  // A card that fits on one slot needs no "1 / 1" (fitCard sees to the fit).
  entity.handout = { kind: 'card', ...HANDOUT_KINDS.card.style, pageNumbers: false, slots, library: libraryRef(kind, row) };
  entity.blocks = blocks;
  return entity;
}
