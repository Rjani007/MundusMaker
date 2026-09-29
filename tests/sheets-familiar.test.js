'use strict';
// Familiar sheet layouts (1.9): the section maps stay on the page, never
// overlap, fit their content, and move overflow to continued details.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');

const LONG = 'The long night began at the harbor. '.repeat(60);

function samples() {
  return {
    dnd2024: {
      klass: { name: 'Wizard', level: 5, hitDie: 6, subclass: 'Evoker' }, species: { name: 'Elf', size: 'Medium' }, background: { name: 'Sage' },
      abilities: { str: 8, dex: 14, con: 13, int: 18, wis: 12, cha: 10 }, saves: ['int'], skills: [{ key: 'Arcana', prof: 'expert' }],
      hp: { max: 27, current: 21, temp: 0 }, attacks: Array.from({ length: 9 }, (_, i) => ({ name: `Weapon ${i}`, bonus: 3, damage: '1d6' })),
      features: Array.from({ length: 40 }, (_, i) => ({ name: `Feature ${i}`, source: i % 3 ? 'Wizard 2' : 'Species: Elf', text: 'Does a thing.' })),
      spellcasting: { ability: 'int', dc: 15, attackBonus: 7, slots: { 1: { max: 4, used: 1 } }, cantrips: ['Light'], prepared: Array.from({ length: 30 }, (_, i) => `Spell ${i}`) },
      personality: { traits: LONG }, notes: 'SECRET-FREE NOTE',
    },
    vtm5: { clan: 'Toreador', generation: 12, attributes: { strength: 2, stamina: 3, composure: 2, resolve: 2 }, skills: { Performance: 3 },
      disciplines: Array.from({ length: 8 }, (_, i) => ({ name: `Discipline ${i}`, rating: 2, powers: [{ name: 'Power', level: 1, desc: 'A description.' }] })),
      health: { superficial: 1, aggravated: 1 }, willpower: {}, hunger: 2, humanity: 7, advantages: [{ name: 'Resources', dots: 2, desc: 'Money.' }], notes: LONG },
    coc7: { occupation: { name: 'Antiquarian' }, age: 42, characteristics: { STR: 45, CON: 60, SIZ: 55, DEX: 50, APP: 65, INT: 80, POW: 60, EDU: 85 },
      hp: { max: 11, current: 9 }, mp: { max: 12, current: 12 }, san: { start: 60, current: 57, max: 99 },
      skills: Array.from({ length: 50 }, (_, i) => ({ name: `Skill ${String(i).padStart(2, '0')}`, value: 20 + i })), backstory: { description: LONG } },
  };
}

test('every section sits on its page and none overlap', async () => {
  const { familiarModel } = await load('sheets/familiar.js');
  for (const [system, data] of Object.entries(samples())) {
    const model = familiarModel(system, data, { name: 'Test' });
    const [PW, PH] = model.size;
    for (const [p, sections] of model.pages.entries()) {
      for (const s of sections) {
        assert.ok(s.x >= 2 && s.y >= 2 && s.x + s.w <= PW - 2 && s.y + s.h <= PH - 2, `${system} p${p + 1} ${s.title} is inside the margins`);
      }
      for (let i = 0; i < sections.length; i++) for (let j = i + 1; j < sections.length; j++) {
        const a = sections[i], b = sections[j];
        const overlap = a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
        assert.ok(!overlap, `${system} p${p + 1}: ${a.title} overlaps ${b.title}`);
      }
    }
  }
});

test('section content fits the section height', async () => {
  const { familiarModel, itemHeight, SECTION_TOP } = await load('sheets/familiar.js');
  for (const [system, data] of Object.entries(samples())) {
    const model = familiarModel(system, data, { name: 'Test' });
    for (const sections of model.pages) for (const s of sections) {
      const used = SECTION_TOP(s) + s.items.reduce((n, it) => n + itemHeight(it, s.w - 1.8), 0);
      assert.ok(used <= s.h + 0.6, `${system}: ${s.title || '(fields)'} needs ${used.toFixed(1)} of ${s.h}`);
    }
  }
});

test('overflow moves to continued details, in full', async () => {
  const { familiarModel } = await load('sheets/familiar.js');
  const s = samples();
  const dnd = familiarModel('dnd2024', s.dnd2024, { name: 'Test' });
  assert.ok(dnd.continuations.some((c) => c.title === 'All weapons & attacks'));
  assert.ok(dnd.continuations.some((c) => c.title === 'All spells' && c.text.includes('Spell 29')));
  assert.ok(dnd.continuations.some((c) => c.title === 'Backstory & personality' && c.text.includes(LONG.trim())));
  assert.ok(dnd.continuations.some((c) => /Rules attribution/.test(c.title) && /not an official character sheet/.test(c.text)));
  const table = dnd.pages[0].find((x) => x.title === 'Weapons & damage cantrips').items[0];
  assert.equal(table.rows.length, 7);
  const vtm = familiarModel('vtm5', s.vtm5, { name: 'Test' });
  assert.equal(vtm.pages[0].find((x) => x.title === 'Disciplines').items[0].cells.length, 6);
  assert.ok(vtm.continuations.some((c) => c.title === 'Discipline 7 2'), 'powers of disciplines past the sixth are kept');
  assert.ok(vtm.continuations.some((c) => c.title === 'Notes' && c.text === LONG.trim()));
  const coc = familiarModel('coc7', s.coc7, { name: 'Test' });
  const cols = coc.pages[0].find((x) => x.title === 'Investigator skills').items[0].cols;
  assert.equal(cols.flat().length, 50, 'every skill is on the sheet');
});

test('the model reads sheet data without changing it', async () => {
  const { familiarModel, familiarHtml } = await load('sheets/familiar.js');
  for (const [system, data] of Object.entries(samples())) {
    const before = JSON.stringify(data);
    familiarModel(system, data, { name: 'Test' });
    const html = familiarHtml(system, data, { name: '<b>Test</b>' });
    assert.equal(JSON.stringify(data), before);
    assert.ok(!html.includes('<b>Test</b>'), 'names are escaped');
    // the only permitted use is the disclaimer in the attribution
    assert.doesNotMatch(html.replace(/not an official character sheet/g, ''), /official/i, 'the UI never calls a layout official');
  }
});
