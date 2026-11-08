'use strict';
// MundusMaker's own V5 sheet PDF (Player sheet PDF in the Familiar layout) read back by
// vtmdrawnimport.js. Hermetic: every PDF here is drawn by familiar.js with the vendored jsPDF,
// the way the Player sheet PDF button draws it, so the reader is checked against the real
// drawing. If familiar.js moves a V5 section, these fail until vtmdrawnimport.js follows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jsPDF } = require('../public/vendor/jspdf.umd.min.js');
const load = require('./module-loader');
const vtm5Data = require('../public/systems/vtm5.json');
const { formPdf } = require('./formpdf');

// familiar.js measures text with jsPDF, as in the browser, so it wraps and cuts exactly as the button does
globalThis.window = { ...(globalThis.window || {}), jspdf: { jsPDF } };

// what pdf.js's pdfSafe keeps: Latin-1 and the rest of cp1252
const CP1252_HIGH = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const safe = (s) => [...String(s ?? '')].filter((c) => c.codePointAt(0) <= 0xFF || CP1252_HIGH.has(c)).join('');

async function drawAndRead(system, data, { name, format = 'a4', compress = false } = {}) {
  const { writeFamiliarSheet } = await load('sheets/familiar.js');
  const { readPdf, pageDrawing } = await load('sheets/pdfform.js');
  const { characterFromDrawing, powerLevels } = await load('sheets/vtmdrawnimport.js');
  const doc = new jsPDF({ unit: 'pt', format, orientation: 'portrait', compress });
  writeFamiliarSheet(doc, system, data, { name, safe, firstPage: true, format });
  const pdf = await readPdf(new Uint8Array(doc.output('arraybuffer')));
  return characterFromDrawing(await pageDrawing(pdf), { levels: powerLevels(vtm5Data) });
}

// Both sides in one shape: every skill, empty descriptions as '', specialties by skill
const TEXT = ['concept', 'predatorType', 'chronicle', 'ambition', 'clan', 'sire', 'desire', 'resonance', 'tenets', 'bane', 'bloodSurge', 'mendAmount', 'powerBonus',
  'rouseReroll', 'feedingPenalty', 'baneSeverity', 'trueAge', 'apparentAge', 'dateOfBirth', 'dateOfDeath', 'appearance', 'features', 'history'];
async function shape(d) {
  const { V5_SKILLS } = await load('sheets/familiar.js');
  return {
    ...Object.fromEntries(TEXT.filter((k) => d[k]).map((k) => [k, d[k]])),
    generation: d.generation, attributes: d.attributes,
    skills: Object.fromEntries(V5_SKILLS.flatMap(([, names]) => names).map((s) => [s, d.skills?.[s] || 0])),
    specialties: [...(d.specialties || [])].sort((a, b) => `${a.skill}/${a.name}`.localeCompare(`${b.skill}/${b.name}`)),
    disciplines: (d.disciplines || []).map((x) => ({ name: x.name, rating: x.rating, powers: x.powers.map((p) => ({ name: p.name, level: p.level, desc: p.desc || '' })) })),
    advantages: (d.advantages || []).map((a) => ({ name: a.name, dots: a.dots, flaw: !!a.flaw, desc: a.desc || '' })),
    convictions: d.convictions || [],
    touchstones: (d.touchstones || []).map((t) => ({ name: t.name, conviction: t.conviction || '', desc: t.desc || '' })),
    hunger: d.hunger, humanity: d.humanity, bloodPotency: d.bloodPotency, health: d.health, willpower: d.willpower,
    xp: { total: d.xp?.total || 0, spent: d.xp?.spent || 0 }, notes: d.notes || '',
  };
}

const neonate = {
  clan: 'Ventrue', generation: 12, bloodPotency: 1, predatorType: 'Consensualist', sire: 'Madame Ilse Kroger', concept: 'Disgraced banker',
  chronicle: 'Ashes of Lisbon', ambition: 'Take the seat of Prince', desire: 'Win back the house on the hill from the cousin who sold it for a song',
  attributes: { strength: 2, dexterity: 3, stamina: 4, charisma: 3, manipulation: 2, composure: 3, intelligence: 4, wits: 2, resolve: 5 },
  skills: { Athletics: 1, Craft: 2, Drive: 1, Firearms: 3, Melee: 2, Stealth: 1, Etiquette: 3, Insight: 2, Intimidation: 1, Leadership: 4, Persuasion: 3,
    Streetwise: 1, Subterfuge: 2, Academics: 2, Awareness: 1, Finance: 5, Investigation: 2, Occult: 1, Politics: 3, Technology: 1 },
  specialties: [{ skill: 'Finance', name: 'Offshore accounts' }, { skill: 'Leadership', name: 'Boardrooms' }, { skill: 'Leadership', name: 'Crisis' }, { skill: 'Etiquette', name: 'Elysium' }],
  disciplines: [
    { name: 'Dominate', rating: 3, powers: [{ name: 'Cloud Memory', level: 1 }, { name: 'Mesmerize', level: 2, desc: 'A command the target follows for a scene.' }, { name: 'Submerged Directive', level: 3 }] },
    { name: 'Presence', rating: 2, powers: [{ name: 'Awe', level: 1 }, { name: 'Daunt', level: 1 }] },
    { name: 'Fortitude', rating: 1, powers: [{ name: 'Resilience', level: 1 }] },
  ],
  advantages: [
    { name: 'Resources', dots: 4, desc: 'Old money, mostly frozen.' }, { name: 'Haven', dots: 2 }, { name: 'Herd', dots: 1 },
    { name: 'Prey Exclusion', dots: 1, flaw: true }, { name: 'Dark Secret', dots: 2, flaw: true, desc: 'Embezzled from the Camarilla.' },
  ],
  convictions: ['Never betray a client', 'Repay every debt'],
  touchstones: [{ name: 'Clara, my accountant', conviction: 'Never betray a client', desc: 'She still thinks I work nights.' }, { name: 'Father Anselm', conviction: 'Repay every debt' }],
  hunger: 2, humanity: 6, health: { superficial: 2, aggravated: 1 }, willpower: { superficial: 1, aggravated: 0 },
  bloodSurge: '+1 die', mendAmount: '1 Superficial', powerBonus: '+0', rouseReroll: 'Level 1', feedingPenalty: 'None', baneSeverity: '1',
  resonance: 'Melancholic', tenets: 'Do not feed in the cathedral district.\nThe Prince’s word is law.', bane: 'Feeds only on those who consent.',
  xp: { total: 25, spent: 12 }, trueAge: '84', apparentAge: '40', dateOfBirth: '3 March 1940', dateOfDeath: '9 May 1980',
  appearance: 'Tall and silver-haired, in impeccable suits.', features: 'A signet ring he never takes off.',
  history: 'Ran a private bank until the Embrace.\n\nNow keeps the ledgers of the Lisbon court.',
  notes: 'Owes a boon to the Nosferatu.\nKeeps a ledger of favours — and of debts.',
};

test('a MundusMaker sheet PDF reads back with every dot, box, power, touchstone and note', async () => {
  const { name, data, report } = await drawAndRead('vtm5', neonate, { name: 'Ottoline Vasquez-Thorne' });
  assert.equal(name, 'Ottoline Vasquez-Thorne');
  assert.equal(report.layout, 'a MundusMaker sheet PDF (Familiar layout)');
  // the heading row cuts a long Desire to fit, and the report says so
  assert.equal(data.desire, 'Win back the house on the hill fro…');
  assert.deepEqual(report.warnings, ['Some text was cut short to fit the PDF, so check: Desire.']);
  assert.deepEqual(await shape(data), await shape({ ...neonate, desire: data.desire }));
  // Presence's powers have no descriptions, so the sheet shows no levels: they come from systems/vtm5.json
  assert.deepEqual(data.disciplines[1].powers.map((p) => p.level), [1, 1]);
  assert.ok(report.imported.includes('3 Disciplines with 6 powers'));
  assert.deepEqual(data.imported, { from: 'mundusmaker-familiar' });
});

test('past six disciplines, eleven advantages or a full text box, the continued details fill in the rest (US Letter, compressed)', async () => {
  const history = Array.from({ length: 14 }, (_, i) => `In the year ${1700 + i * 20} she moved her court again, and each time she left one more friend behind in the old city.`).join(' ');
  const elder = {
    clan: 'Gangrel', generation: 9, bloodPotency: 4, predatorType: 'Alleycat', sire: 'Unknown', concept: 'Wanderer', ambition: 'Outlive the Prince', desire: 'A quiet night',
    attributes: { strength: 4, dexterity: 3, stamina: 5, charisma: 1, manipulation: 2, composure: 4, intelligence: 2, wits: 4, resolve: 3 },
    skills: { Athletics: 4, Brawl: 5, Stealth: 3, Survival: 5, 'Animal Ken': 4, Intimidation: 3, Awareness: 4, Occult: 2 },
    specialties: [{ skill: 'Brawl', name: 'Claws' }, { skill: 'Survival', name: 'Tracking' }],
    disciplines: [
      { name: 'Animalism', rating: 3, powers: [{ name: 'Bond Famulus', level: 1 }, { name: 'Feral Whispers', level: 2 }, { name: 'Quell the Beast', level: 3 }] },
      { name: 'Auspex', rating: 1, powers: [{ name: 'Heightened Senses', level: 1 }] },
      { name: 'Celerity', rating: 2, powers: [{ name: 'Rapid Reflexes', level: 1 }, { name: 'Fleetness', level: 2 }] },
      { name: 'Dominate', rating: 1, powers: [{ name: 'Compel', level: 1 }] },
      { name: 'Fortitude', rating: 4, powers: [{ name: 'Resilience', level: 1 }, { name: 'Toughness', level: 2 }, { name: 'Defy Bane', level: 3 }, { name: 'Draught of Endurance', level: 4 }] },
      { name: 'Obfuscate', rating: 1, powers: [{ name: 'Cloak of Shadows', level: 1 }] },
      { name: 'Protean', rating: 2, powers: [{ name: 'Eyes of the Beast', level: 1 }, { name: 'Feral Weapons', level: 2, desc: 'Claws that deal Aggravated damage.' }] },
    ],
    advantages: Array.from({ length: 10 }, (_, i) => ({ name: `Ally number ${i + 1}`, dots: (i % 5) + 1 }))
      .concat([{ name: 'Folkloric Bane', dots: 1, flaw: true }, { name: 'Obvious Predator', dots: 2, flaw: true }]),
    convictions: ['Never kill for sport'], touchstones: [{ name: 'The ferryman', conviction: 'Never kill for sport' }],
    hunger: 3, humanity: 5, health: { superficial: 0, aggravated: 3 }, willpower: { superficial: 2, aggravated: 1 },
    xp: { total: 180, spent: 172 }, history, notes: '',
  };
  const { name, data, report } = await drawAndRead('vtm5', elder, { name: 'Magdalena of the Seventh Bridge', format: 'letter', compress: true });
  assert.equal(name, 'Magdalena of the Seventh Bridge');
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(await shape(data), await shape(elder));
  assert.equal(data.disciplines.length, 7, 'the seventh is only in the continued details');
  assert.equal(data.advantages.length, 12, 'past eleven, the whole list is in the continued details');
  assert.equal(data.history, history, 'the full history, from the continued details');
});

test('other PDFs: none from MundusMaker, another game, or the Standard layout', async () => {
  const { readPdf, pageDrawing } = await load('sheets/pdfform.js');
  const { characterFromDrawing } = await load('sheets/vtmdrawnimport.js');
  assert.equal(characterFromDrawing(await pageDrawing(await readPdf(formPdf([], { acroForm: false })))), null);
  await assert.rejects(drawAndRead('dnd2024', {}, { name: 'Not a vampire' }), /MundusMaker D&D sheet, and this card reads V5 sheets/);
  const standard = [{ width: 595, height: 842, texts: [{ x: 50, y: 20, size: 7, font: 'Helvetica', text: 'MundusMaker · character sheet' }], circles: [], rects: [], lines: [] }];
  assert.throws(() => characterFromDrawing(standard), /Standard layout/);
});
