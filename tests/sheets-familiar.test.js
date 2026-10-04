'use strict';
// Familiar sheet layouts (1.9): the section maps stay on the
// page, never overlap, fit their content, move overflow to continued details,
// and draw the same thing to PDF and SVG.
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

test('section content fits the space drawn for it', async () => {
  const { familiarModel } = await load('sheets/familiar.js');
  // every text area carries the lines it prints and how many it has room for
  const areas = (v, out = []) => {
    if (v && typeof v === 'object') {
      if (Array.isArray(v.lines) && typeof v.cap === 'number') out.push(v);
      else for (const x of Object.values(v)) areas(x, out);
    }
    return out;
  };
  for (const [system, data] of Object.entries(samples())) {
    const model = familiarModel(system, data, { name: 'Test' });
    for (const sections of model.pages) for (const s of sections) {
      for (const a of areas(s)) assert.ok(a.lines.length <= a.cap, `${system}: ${s.title} prints ${a.lines.length} lines in room for ${a.cap}`);
      if (Array.isArray(s.rows) && typeof s.count === 'number') assert.ok(s.rows.length <= s.count, `${system}: ${s.title} has more rows than lines`);
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
  assert.match(dnd.notice, /not an official character sheet/);
  assert.match(dnd.notice, /CC-BY-4\.0/);
  assert.equal(dnd.pages[0].find((x) => x.title === 'Weapons & damage cantrips').rows.length, 6);
  const vtm = familiarModel('vtm5', s.vtm5, { name: 'Test' });
  assert.equal(vtm.pages[0].find((x) => x.title === 'Disciplines').cells.length, 6);
  assert.ok(vtm.continuations.some((c) => c.title === 'Discipline 7 2'), 'powers of disciplines past the sixth are kept');
  assert.ok(vtm.continuations.some((c) => c.title === 'Notes' && c.text === LONG.trim()));
  const coc = familiarModel('coc7', s.coc7, { name: 'Test' });
  const grid = coc.pages[0].find((x) => x.title === 'Investigator skills').grid;
  const shown = grid.flat().filter((c) => !c.blank).map((c) => c.label);
  const more = coc.continuations.find((c) => c.title === 'More skills')?.text || '';
  for (let i = 0; i < 50; i++) {
    const n = `Skill ${String(i).padStart(2, '0')}`;
    assert.ok(shown.includes(n) || more.includes(`${n}:`), `${n} is on the sheet or in the continued details`);
  }
});

test('Call of Cthulhu skills land in the printed sheet slots', async () => {
  const { familiarModel } = await load('sheets/familiar.js');
  const data = { skills: [{ name: 'Spot Hidden', value: 55 }, { name: 'Art/Craft (Photography)', value: 40 }, { name: 'Art/Craft (Painting)', value: 30 },
    { name: 'Language (Latin)', value: 41 }, { name: 'Science (Biology)', value: 31 }, { name: 'Computer Use', value: 20 }],
  skillBases: { 'Spot Hidden': 25, 'Art/Craft': 5, 'Language (Other)': 1, Science: 1 } };
  const grid = familiarModel('coc7', data, { name: 'T' }).pages[0].find((x) => x.title === 'Investigator skills').grid;
  assert.equal(grid.length, 4);
  assert.ok(grid.every((col) => col.length === 15));
  assert.equal(grid[3][4].label, 'Spot Hidden');
  assert.equal(grid[3][4].value, 55);
  // the first specialism takes the generic row, the next one its blank line
  assert.equal(grid[0][4].label, 'Art/Craft (Photography)');
  assert.equal(grid[0][5].label, 'Art/Craft (Painting)');
  assert.equal(grid[1][11].label, 'Language (Latin)');
  assert.equal(grid[3][0].label, 'Science (Biology)');
  // anything else takes a plain blank row
  assert.equal(grid[3][7].label, 'Computer Use');
  // Credit Rating and Cthulhu Mythos have no improvement box
  assert.equal(grid[0][9].tick, false);
  assert.equal(grid[0][10].tick, false);
});

test('the model reads sheet data without changing it', async () => {
  const { familiarModel, familiarHtml } = await load('sheets/familiar.js');
  for (const [system, data] of Object.entries(samples())) {
    const before = JSON.stringify(data);
    familiarModel(system, data, { name: 'Test' });
    const html = familiarHtml(system, data, { name: '<b>Test</b>' });
    assert.equal(JSON.stringify(data), before);
    assert.ok(!html.includes('<b>Test</b>'), 'names are escaped');
    assert.match(html, /<svg class="fam-svg"/);
    // the only permitted use is the disclaimer in the attribution
    assert.doesNotMatch(html.replace(/not an official character sheet/g, ''), /official/i, 'the UI never calls a layout official');
  }
});

test('the in-app sheet keeps its click targets', async () => {
  const { familiarHtml } = await load('sheets/familiar.js');
  const s = samples();
  const vtm = familiarHtml('vtm5', s.vtm5, { name: 'T' });
  assert.match(vtm, /class="dots" data-dots="attributes\.strength"/);
  assert.match(vtm, /class="dots" data-dots="skills\.Performance"/);
  assert.match(vtm, /class="track" data-track="health"/);
  assert.match(vtm, /class="track" data-track="hunger" data-mode="fill"/);
  const dnd = familiarHtml('dnd2024', s.dnd2024, { name: 'T' });
  assert.match(dnd, /data-dots="deathSaves\.success"/);
  assert.match(dnd, /data-track="spellcasting\.slots\.1\.used" data-mode="fill"/);
  const coc = familiarHtml('coc7', s.coc7, { name: 'T' });
  assert.match(coc, /data-track="hp\.current" data-mode="set"/);
  assert.match(coc, /data-track="san\.current" data-mode="set"/);
});

test('the V5 layout keeps the boxes measured from Renegade’s sheet', async () => {
  const { familiarModel, familiarHtml } = await load('sheets/familiar.js');
  const vtm = familiarModel('vtm5', samples().vtm5, { name: 'Test' });
  assert.equal(vtm.paper, '#faf3e9');
  assert.equal(typeof vtm.frame, 'function');
  const at = (page, kind) => vtm.pages[page].find((s) => s.kind === kind);
  // page 1: the info box, and the discipline grid under the rule at 84.5
  assert.deepEqual([at(0, 'v5-header').x, at(0, 'v5-header').y, at(0, 'v5-header').w], [9.7, 14.9, 80.6]);
  assert.equal(at(0, 'v5-disciplines').y + 3.1, 84.5);
  // page 2: one box for tenets, touchstones and bane; advantages over notes on the left; the rest on the right
  assert.deepEqual(vtm.pages[1].map((s) => s.kind), ['v5-trio', 'v5-advantages', 'v5-notes', 'v5-divider', 'v5-potency', 'v5-xp', 'v5-table']);
  assert.deepEqual(at(1, 'v5-trio').edges, [9.7, 36.8, 63.8, 90.3]);
  assert.equal(at(1, 'v5-advantages').count, 11);
  const table = at(1, 'v5-table');
  assert.ok(Math.abs(table.rows.reduce((n, r) => n + r.h, 0) - table.h) < 0.01, 'the table rows fill the column');
  assert.deepEqual(table.rows.map((r) => r.label), ['True age', 'Apparent age', 'Date of birth', 'Date of death', 'Appearance', 'Distinguishing features', 'History']);
  // the in-app sheet is the same drawing: cream page, framed, plain-text title
  const html = familiarHtml('vtm5', samples().vtm5, { name: 'Test' });
  assert.match(html, /fill="#faf3e9"/);
  assert.ok((html.match(/<polygon[^>]*stroke="#751016"/g) || []).length >= 4, 'two frame lines on each page');
  assert.match(html, />Vampire: The Masquerade</);
});

test('V5 sheets open in the familiar layout; each game keeps its own choice', async () => {
  const { sheetLayoutFor } = await load('sheets/familiar.js');
  const reader = (settings) => (key) => settings[key] ?? null;
  // nothing chosen: V5 is familiar, the others standard
  assert.equal(sheetLayoutFor('vtm5', reader({})), 'familiar');
  assert.equal(sheetLayoutFor('dnd2024', reader({})), 'standard');
  assert.equal(sheetLayoutFor('coc7', reader({})), 'standard');
  // a choice for one game leaves the others alone
  const chosen = reader({ 'sheetLayout.vtm5': 'standard', 'sheetLayout.coc7': 'familiar' });
  assert.equal(sheetLayoutFor('vtm5', chosen), 'standard');
  assert.equal(sheetLayoutFor('coc7', chosen), 'familiar');
  assert.equal(sheetLayoutFor('dnd2024', chosen), 'standard');
  // the older all-games "familiar" still applies where a game has no choice of its own
  const older = reader({ sheetLayout: 'familiar', 'sheetLayout.dnd2024': 'standard' });
  assert.equal(sheetLayoutFor('coc7', older), 'familiar');
  assert.equal(sheetLayoutFor('dnd2024', older), 'standard');
  // an older "standard" was the default of its day, not a choice against V5's new layout
  assert.equal(sheetLayoutFor('vtm5', reader({ sheetLayout: 'standard' })), 'familiar');
  // storage that throws falls back to the defaults; unknown games stay standard
  assert.equal(sheetLayoutFor('vtm5', () => { throw new Error('blocked'); }), 'familiar');
  assert.equal(sheetLayoutFor('nope', reader({ 'sheetLayout.nope': 'familiar', sheetLayout: 'familiar' })), 'standard');
});
