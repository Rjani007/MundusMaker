'use strict';
// Importing a V5 character sheet PDF (the official fillable sheet, or Progeny's
// "Download PDF") as a vtm5 sheet. Hermetic: every PDF here is built by the test from
// field names alone (formpdf.js); no publisher's or Progeny's file is needed or shipped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./module-loader');
const { formPdf } = require('./formpdf');

async function importPdf(bytes) {
  const { readPdf, readForm, pageImages } = await load('sheets/pdfform.js');
  const { characterFromForm, recognizeLayout } = await load('sheets/vtmpdfimport.js');
  const doc = await readPdf(bytes);
  const form = await readForm(doc);
  return characterFromForm(form, recognizeLayout(form)?.id === 'progeny' ? await pageImages(doc) : []);
}

// A layout's fields, typed by its map: Humanity buttons, ticked boxes for counted rows, text
// for the rest. `set` maps a field name to its text, true (ticked), 'as-only' (ticked through
// /AS alone) or, for a button, { caption } / { drawn }.
async function layoutPdf(id, set = {}, humanityPictures = 0) {
  const { LAYOUTS } = await load('sheets/vtmpdfimport.js');
  const fields = Object.entries(LAYOUTS.find((l) => l.id === id).fields).map(([name, entry]) => {
    const v = set[name];
    if (/^(Button7\.|Humanity-)/.test(name)) return { name, type: 'pushbutton', ...(v || {}) };
    if (Array.isArray(entry)) return { name, type: 'checkbox', value: !!v, asOnly: v === 'as-only', widgets: name === 'adflaw1-5' ? 2 : 1 };
    return { name, type: 'text', value: v || '' };
  });
  return formPdf(fields, { imagesOver: Array.from({ length: humanityPictures }, (_, i) => `Humanity-${i + 1}`) });
}
const tick = (set, prefix, n) => { for (let k = 1; k <= n; k++) set[`${prefix}${k}`] = true; return set; };

// Humanity as Acrobat runs the official sheet's script: ✔ per point, ✕ per Stain
const CHECKED = { caption: '✔' }, STAINED = { caption: '✕' };
// "Use my own official sheet" draws a filled box and sets no caption
const DRAWN = { drawn: 'q 0 G 0.6 w 0.5 0.5 9 9 re S 0 g 2 2 6 6 re f Q' };

test('a filled-in official sheet imports with dots, damage, Humanity and powers', async () => {
  const set = {
    Name: 'Celeste Marchand', Concept: 'Jazz singer', Predator: 'Siren', Chronicle: 'Chicago Nights', Ambition: 'Be adored', Clan: 'toreador',
    Sire: 'Isolde', Desire: 'One more encore', Generation: '12th', Resonance: 'Sanguine', 'Clan Banes': 'Aesthetic fixation',
    'Blood Surge': 'Add 1 die', totalxp: '35', spentxp: '20 (15 left)', Notes: 'Lives above the club.',
    'Touchstones Convictions': 'Never harm a performer — Mara\nProtect the club',
    'AT.1.1.2.7': 'Singing, Jazz', 'AT.1.1.2.9': 'Seduction',
    Main1: 'Presence', Row1: 'Awe', Row2: '2 - Lingering Kiss', Main2: 'auspex', Row1_2: 'Heightened Senses (1)',
    adflaw1: 'Beautiful', adflaw2: 'Enemy (flaw)', adflaw5: 'Resources',
    health1: '/', health2: 'X', health3: 'o', will1: '/',
  };
  for (const [k, n] of Object.entries({ strength: 1, dexterity: 3, stamina: 2, charisma: 4, manipulation: 3, composure: 3, intelligence: 2, wits: 2, resolve: 2 })) tick(set, k, n);
  for (const [k, n] of Object.entries({ performance: 3, persuasion: 3, etiquette: 2, animalken: 1 })) tick(set, k, n);
  tick(set, 'main1-', 2); tick(set, 'main2-', 1); tick(set, 'hunger', 2); tick(set, 'potency', 1);
  tick(set, 'adflaw1-', 2); tick(set, 'adflaw2-', 1); tick(set, 'adflaw5-', 4);
  set['adflaw1-5'] = true; // row 5's fifth dot is this field's second box
  for (let i = 0; i < 6; i++) set[`Button7.${i}`] = CHECKED;
  set['Button7.6'] = { caption: '4' }; // ✔ as its ZapfDingbats code
  set['Button7.9'] = STAINED;

  const { name, data: d, report } = await importPdf(await layoutPdf('vtm5-renegade', set));
  assert.equal(name, 'Celeste Marchand');
  assert.equal(report.layout, 'the official V5 character sheet');
  assert.equal(d.clan, 'Toreador', 'a name typed in lowercase gets its capitals');
  assert.equal(d.generation, 12);
  assert.equal(d.predatorType, 'Siren');
  assert.equal(d.concept, 'Jazz singer');
  assert.equal(d.bloodSurge, 'Add 1 die');
  assert.deepEqual(d.attributes, { strength: 1, dexterity: 3, stamina: 2, charisma: 4, manipulation: 3, composure: 3, intelligence: 2, wits: 2, resolve: 2 });
  assert.equal(d.skills.Performance, 3);
  assert.equal(d.skills['Animal Ken'], 1);
  assert.equal(d.skills.Brawl, 0);
  assert.deepEqual(d.specialties, [{ skill: 'Performance', name: 'Singing' }, { skill: 'Performance', name: 'Jazz' }, { skill: 'Persuasion', name: 'Seduction' }]);
  assert.deepEqual(d.disciplines, [
    { name: 'Presence', rating: 2, powers: [{ name: 'Awe', level: 1, desc: '' }, { name: 'Lingering Kiss', level: 2, desc: '' }] },
    { name: 'Auspex', rating: 1, powers: [{ name: 'Heightened Senses', level: 1, desc: '' }] },
  ]);
  assert.deepEqual(d.advantages, [
    { name: 'Beautiful', dots: 2, flaw: false, desc: '' }, { name: 'Enemy', dots: 1, flaw: true, desc: '' }, { name: 'Resources', dots: 5, flaw: false, desc: '' },
  ]);
  assert.equal(d.hunger, 2);
  assert.equal(d.bloodPotency, 1);
  assert.equal(d.humanity, 7);
  assert.equal(d.stains, 1);
  assert.deepEqual(d.health, { superficial: 1, aggravated: 1 });
  assert.deepEqual(d.willpower, { superficial: 1, aggravated: 0 });
  assert.deepEqual(d.xp, { total: 35, spent: 20, ledger: [] });
  assert.deepEqual(d.convictions, ['Never harm a performer']);
  assert.deepEqual(d.touchstones, [{ name: 'Mara', conviction: 'Never harm a performer', desc: '' }]);
  assert.equal(d.notes, 'Lives above the club.\n\nTouchstones & Convictions, from the sheet:\nProtect the club');
  assert.ok(report.imported.includes('2 Disciplines with 3 powers'));
  assert.ok(report.warnings.some((w) => /Health box 3 \("o"\)/.test(w)));
  assert.ok(report.warnings.some((w) => /went into the notes/.test(w)));
  assert.equal(report.warnings.some((w) => /fifth dot/.test(w)), false, 'only row 5 has a fourth dot, so the shared box is row 5’s');
});

test('drawn Humanity, ticks kept only in /AS, and a shared fifth dot both rows could own', async () => {
  const set = { Name: 'Viktor', Clan: 'Thin-blood', strength1: 'as-only', strength2: 'as-only', adflaw1: 'Haven', adflaw5: 'Contacts' };
  tick(set, 'adflaw1-', 4); tick(set, 'adflaw5-', 4);
  set['adflaw1-5'] = true;
  for (let i = 0; i < 5; i++) set[`Button7.${i}`] = DRAWN;
  const { data: d, report } = await importPdf(await layoutPdf('vtm5-renegade', set));
  assert.equal(d.attributes.strength, 2, 'boxes ticked only through their widgets still count');
  assert.equal(d.humanity, 5);
  assert.equal(d.bloodPotency, 0, 'a thin-blood with no Blood Potency dots keeps 0');
  assert.deepEqual(d.advantages.map((a) => a.dots), [5, 5]);
  assert.ok(report.warnings.some((w) => /share their fifth dot/.test(w)));
  assert.equal(d.hunger, 1);
  assert.ok(report.warnings.some((w) => /No Hunger boxes/.test(w)));
});

test('Progeny’s PDF imports, with Humanity read from the ticks it draws on the page', async () => {
  const set = {
    Name: 'Viktor Hale', pcDescription: 'Bouncer with a past', 'Predator type': 'Alleycat', Ambition: 'Own the club', Clan: 'Brujah', Sire: 'Mara',
    Desire: 'A quiet night', Title: '12', ClanBane: 'Violent temper', ClanCompulsion: 'Rebellion', BloodSurge: '1', Mend: '1 superficial damage',
    specBra: 'Grappling', specStree: 'Gangs, Drugs',
    Disc1: 'Celerity', Disc1_Ability1: 'Cat’s Grace: Keep your balance', Disc1_Ability2: 'Fleetness: Move faster // Dexterity + Athletics // 1 rouse check',
    Disc2: 'Potence', Disc2_Ability1: 'Lethal Body: Hit harder',
    Disc3: 'Celerity (cont.)', Disc3_Ability1: 'Blink: Close the distance // Dexterity + Athletics // 2 rouse checks',
    Disc4: 'Blood sorcery', Disc4_Ability1: 'Corrosive Vitae: Corrode things', Disc4_Ability2: 'Ward against Ghouls: Keep them out // requires: blood; 5 minutes',
    Merit1: 'Resources: Comfortable', Merit2: 'Prey Exclusion (Mortals): Cannot feed on them',
    Convictions: 'Never leave a friend behind (Mara)\n\n (Jules)', touchstoneNotes: 'Mara\nher sire\n\nJules\nthe bartender',
    tEXP: '15 XP', PC_Notes: 'Has a motorbike.',
  };
  for (const [k, n] of Object.entries({ Str: 4, Dex: 3, Sta: 3, Cha: 2, Man: 2, Com: 2, Int: 1, Wit: 2, Res: 2, Bra: 3, Stre: 2, Ath: 2, Inti: 2 })) tick(set, `${k}-`, n);
  tick(set, 'Disc1-', 2); tick(set, 'Disc2-', 1); tick(set, 'Disc3-', 1); tick(set, 'Disc4-', 1);
  tick(set, 'Merit1-', 3); tick(set, 'Merit2-', 2);
  tick(set, 'Health-', 7); tick(set, 'WP-', 4); tick(set, 'BloodPotency-', 2);

  const { name, data: d, report } = await importPdf(await layoutPdf('progeny', set, 6));
  assert.equal(name, 'Viktor Hale');
  assert.equal(report.layout, 'a Progeny PDF (Nerdbert’s sheet)');
  assert.equal(d.concept, 'Bouncer with a past');
  assert.equal(d.predatorType, 'Alleycat');
  assert.equal(d.generation, 12, 'Progeny writes the generation in the field named Title');
  assert.equal(d.bane, 'Violent temper');
  assert.deepEqual(d.attributes, { strength: 4, dexterity: 3, stamina: 3, charisma: 2, manipulation: 2, composure: 2, intelligence: 1, wits: 2, resolve: 2 });
  assert.equal(d.skills.Brawl, 3);
  assert.equal(d.skills.Streetwise, 2);
  assert.deepEqual(d.specialties, [{ skill: 'Brawl', name: 'Grappling' }, { skill: 'Streetwise', name: 'Gangs' }, { skill: 'Streetwise', name: 'Drugs' }]);
  assert.deepEqual(d.disciplines, [
    { name: 'Celerity', rating: 3, powers: [
      { name: 'Cat’s Grace', desc: 'Keep your balance', level: 1 },
      { name: 'Fleetness', desc: 'Move faster', pool: 'Dexterity + Athletics', rouse: 1, level: 2 },
      { name: 'Blink', desc: 'Close the distance', pool: 'Dexterity + Athletics', rouse: 2, level: 3 },
    ] },
    { name: 'Potence', rating: 1, powers: [{ name: 'Lethal Body', desc: 'Hit harder', level: 1 }] },
    { name: 'Blood Sorcery', rating: 1, powers: [{ name: 'Corrosive Vitae', desc: 'Corrode things', level: 1 }] },
  ]);
  assert.deepEqual(d.rituals, [{ name: 'Ward against Ghouls', level: 1, desc: 'Keep them out · requires: blood; 5 minutes' }]);
  assert.deepEqual(d.advantages, [
    { name: 'Resources', dots: 3, flaw: false, desc: 'Comfortable' }, { name: 'Prey Exclusion (Mortals)', dots: 2, flaw: false, desc: 'Cannot feed on them' },
  ]);
  assert.deepEqual(d.convictions, ['Never leave a friend behind']);
  assert.deepEqual(d.touchstones, [{ name: 'Mara', conviction: 'Never leave a friend behind', desc: 'her sire' }, { name: 'Jules', conviction: '', desc: 'the bartender' }]);
  assert.equal(d.humanity, 6, 'one tick picture per point of Humanity');
  assert.equal(d.hunger, 1);
  assert.deepEqual(d.health, { superficial: 0, aggravated: 0 });
  assert.equal(d.bloodPotency, 2);
  assert.equal(d.healthMaxBonus, 1, '7 Health boxes against Stamina 3 + 3');
  assert.equal(d.willpowerMaxBonus, undefined);
  assert.equal(d.xp.total, 15);
  assert.equal(d.notes, ['Has a motorbike.', 'Rituals and ceremonies:\nWard against Ghouls — Keep them out · requires: blood; 5 minutes',
    'Clan compulsion: Rebellion', 'Health on the sheet: 7 boxes (the Attributes give 6).'].join('\n\n'));
  assert.ok(report.warnings.some((w) => /Merits and Flaws together/.test(w)));
  assert.ok(report.warnings.some((w) => /doesn’t carry Hunger/.test(w)));

  const bare = await importPdf(await layoutPdf('progeny', { Name: 'Ana', 'Str-1': true }));
  assert.equal(bare.data.humanity, 7);
  assert.ok(bare.report.warnings.some((w) => /No Humanity boxes/.test(w)));
});

test('empty, flattened and unknown PDFs explain themselves', async () => {
  await assert.rejects(importPdf(await layoutPdf('vtm5-renegade', {})), /still empty/);
  await assert.rejects(importPdf(await layoutPdf('progeny', {})), /still empty/);
  await assert.rejects(importPdf(formPdf([], { acroForm: false })), /no form fields/);
  await assert.rejects(importPdf(formPdf([{ name: 'CharacterName', type: 'text', value: 'Odo' }])), /isn’t a V5 sheet MundusMaker knows/);
});
