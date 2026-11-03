'use strict';
// Importing a D&D character sheet PDF (D&D Beyond's "Export to PDF", or any
// filled-in fillable 5e sheet) as a dnd2024 sheet. Hermetic: every PDF here is
// built by the test from field names alone; no D&D Beyond or publisher file
// is needed or shipped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jsPDF } = require('../public/vendor/jspdf.umd.min.js');
const load = require('./module-loader');

// every PDF here is built from field names by the shared helper
const { formPdf } = require('./formpdf');

async function formOf(bytes) {
  const { readPdf, readForm } = await load('sheets/pdfform.js');
  return readForm(await readPdf(bytes));
}

// a 5th-level bard, written onto the 2024 sheet the way "Use my own official sheet" fills it
const BARD = {
  klass: { name: 'Bard', level: 5, hitDie: 8, subclass: 'College of Lore' }, species: { name: 'Halfling', size: 'Small', speed: 30 }, background: { name: 'Entertainer' },
  abilities: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 18 }, saves: ['dex', 'cha'],
  skills: [{ key: 'Arcana', prof: 'prof' }, { key: 'Performance', prof: 'expert' }, { key: 'Sleight of Hand', prof: 'prof' }],
  ac: 14, speed: 25, hp: { max: 38, current: 31, temp: 3 }, hitDice: { spent: 2 }, deathSaves: { success: 2, failure: 1 }, inspiration: true, defense: { shield: true },
  attacks: [{ name: 'Rapier', bonus: 5, damage: '1d8+2 piercing', notes: 'Finesse' }, { name: 'Vicious Mockery', bonus: 'DC 15', damage: '2d6 psychic' }],
  features: [{ name: 'Bardic Inspiration', source: 'Bard 1' }, { name: 'Jack of All Trades', source: 'Bard 2' }, { name: 'Luck', source: 'Halfling' }, { name: 'Musician', source: 'Origin feat' }],
  proficiencies: { armor: ['light'], weapons: ['Simple weapons'], tools: ['Lute', 'Flute'] }, languages: ['Common', 'Halfling', 'Elvish'],
  spellcasting: { ability: 'cha', dc: 15, attackBonus: 7, slots: { 1: { max: 4, used: 3 }, 2: { max: 3, used: 0 }, 3: { max: 2, used: 1 } }, cantrips: ['Vicious Mockery', 'Light'], prepared: ['Bless', 'Healing Word', 'Hypnotic Pattern'] },
  spellDetails: [{ name: 'Bless', level: 1, castingTime: '1 action', range: '30 feet', concentration: true, components: 'V, S, M' }, { name: 'Hypnotic Pattern', level: 3, castingTime: '1 action', concentration: true }, { name: 'Healing Word', level: 1, castingTime: '1 bonus action' }],
  equipment: [{ name: 'Rapier', qty: 1 }, { name: 'Dagger', qty: 2 }, { name: 'Lute', qty: 1 }], coins: { gp: 147, sp: 3, cp: 12, pp: 1 },
  attuned: ['Cloak of Elvenkind'], appearance: 'Short, curly hair', backstory: 'Ran away with the circus.', personality: { traits: 'Loud', flaws: 'Can’t keep a secret' }, alignment: 'Chaotic Good', xp: 6500,
};

async function filled2024() {
  const { TEMPLATES, planFill } = await load('sheets/officialsheets.js');
  const { readPdf, readForm, fillForm } = await load('sheets/pdfform.js');
  const t = TEMPLATES.find((x) => x.id === 'dnd2024-wotc');
  const blank = formPdf(Object.keys(t.fields).map((name) => ({ name, type: /^Check Box/.test(name) ? 'checkbox' : 'text' })));
  const doc = await readPdf(blank);
  const form = await readForm(doc);
  const { fill } = planFill('dnd2024', BARD, 'Vesper Ashgrove', form);
  return (await fillForm(doc, form, fill)).bytes;
}

// ---------- the 2024 sheet ----------

test('a filled 2024 sheet comes back as the character that was written onto it', async () => {
  const { characterFromForm } = await load('sheets/dndpdfimport.js');
  const form = await formOf(await filled2024());
  const { name, data: d, fields, report } = characterFromForm(form, { classes: [{ name: 'Bard', hitDie: 8 }] });
  assert.equal(name, 'Vesper Ashgrove');
  assert.equal(report.layout, 'the 2024 D&D character sheet');
  assert.deepEqual(d.klass, { name: 'Bard', level: 5, hitDie: 8, subclass: 'College of Lore' });
  assert.deepEqual(d.species, { name: 'Halfling', size: 'Small', speed: 25 });
  assert.equal(d.background.name, 'Entertainer');
  assert.deepEqual(d.abilities, BARD.abilities);
  assert.deepEqual(d.saves.sort(), ['cha', 'dex']);
  assert.deepEqual(d.skills, [{ key: 'Arcana', prof: 'prof' }, { key: 'Performance', prof: 'expert' }, { key: 'Sleight of Hand', prof: 'prof' }], 'expertise is read from the printed bonus');
  assert.equal(d.ac, 14);
  assert.equal(d.speed, 25);
  assert.deepEqual(d.hp, BARD.hp);
  assert.deepEqual(d.hitDice, { spent: 2 });
  assert.deepEqual(d.deathSaves, { success: 2, failure: 1 }, 'ticked boxes are counted');
  assert.equal(d.inspiration, true);
  assert.equal(d.defense.shield, true);
  assert.equal(d.defense.automatic, false, 'level-up keeps the imported armor class');
  assert.deepEqual(d.attacks, [{ name: 'Rapier', bonus: 5, damage: '1d8+2 piercing', notes: 'Finesse' }, { name: 'Vicious Mockery', bonus: 'DC 15', damage: '2d6 psychic' }]);
  assert.deepEqual(d.features.map((f) => [f.name, f.source]), [['Bardic Inspiration', 'Bard'], ['Jack of All Trades', 'Bard'], ['Luck', 'Halfling trait'], ['Musician', 'Feat']]);
  assert.deepEqual(d.proficiencies, BARD.proficiencies);
  assert.deepEqual(d.languages, BARD.languages);
  assert.equal(d.spellcasting.ability, 'cha');
  assert.equal(d.spellcasting.dc, 15);
  assert.equal(d.spellcasting.attackBonus, 7);
  assert.deepEqual(d.spellcasting.slots, BARD.spellcasting.slots);
  assert.deepEqual(d.spellcasting.cantrips.sort(), ['Light', 'Vicious Mockery']);
  assert.deepEqual(d.spellcasting.prepared.sort(), ['Bless', 'Healing Word', 'Hypnotic Pattern']);
  const bless = d.spellDetails.find((s) => s.name === 'Bless');
  assert.deepEqual({ ...bless }, { name: 'Bless', level: 1, castingTime: 'Action', range: '30 feet', concentration: true, components: 'M' });
  assert.deepEqual(d.equipment, BARD.equipment);
  assert.deepEqual(d.coins, { cp: 12, sp: 3, ep: 0, gp: 147, pp: 1 });
  assert.deepEqual(d.attuned, ['Cloak of Elvenkind']);
  assert.equal(d.appearance, 'Short, curly hair');
  assert.deepEqual(d.personality, { traits: 'Loud', ideals: '', bonds: '', flaws: 'Can’t keep a secret' }, 'personality lines leave the shared backstory box');
  assert.equal(d.backstory, 'Ran away with the circus.');
  assert.equal(d.alignment, 'Chaotic Good');
  assert.equal(d.xp, 6500);
  assert.equal(d.notes, '', 'every number on the sheet agrees with what MundusMaker works out');
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(fields, { Species: 'Halfling' });
});

test('the 2024 sheet’s own numbers are kept when they disagree', async () => {
  const { readValues, buildSheet } = await load('sheets/dndpdfimport.js');
  const read = readValues(await formOf(await filled2024()));
  // a Stone of Good Luck: +1 to every save and skill on the printed sheet
  for (const [k, v] of read.values) if (/^(skill\.[^.]+|[a-z]{3}\.save)$/.test(k)) read.values.set(k, `+${Number(v) + 1}`);
  read.values.set('pb', '+4');
  const { data, report } = buildSheet(read);
  assert.deepEqual(data.skills.map((s) => s.key), ['Arcana', 'Performance', 'Sleight of Hand'], 'the tick boxes decide proficiency, not the bonus');
  assert.match(data.notes, /On the imported sheet: Strength save \+0, Dexterity save \+6,/);
  assert.match(data.notes, /Perception \+2,/, 'Jack of All Trades +1, and the stone');
  assert.ok(report.warnings.some((w) => /proficiency bonus is \+4; level 5 gives \+3/.test(w)));
  assert.ok(report.warnings.some((w) => /numbers differ/.test(w)));
});

// ---------- D&D Beyond's export ----------

// An invented cleric laid out the way D&D Beyond's "Export to PDF" lays a
// character out: its field names, its marks, text cut across boxes, and spell
// rows under level headers, all as page widgets with no AcroForm.
const SPELL_COLS = ['Prepared', 'Name', 'Source', 'SaveHit', 'CastingTime', 'Range', 'Components', 'Duration', 'Page', 'Notes'];
function ddbFields() {
  const t = (name, value = '') => ({ name, type: 'text', value });
  const out = [
    t('CharacterName', 'Odo Brightwater'), t('CLASS  LEVEL', 'Cleric 6'), t('PLAYER NAME', 'Pat'), t('RACE', 'Dwarf'), t('BACKGROUND', 'Acolyte'), t('EXPERIENCE POINTS', '(Milestone)'),
    t('STR', '14'), t('STRmod', '+2'), t('DEX', '10'), t('DEXmod ', '+0'), t('CON', '16'), t('CONmod', '+3'), t('INT', '8'), t('INTmod', '-1'), t('WIS', '17'), t('WISmod', '+3'), t('CHA', '12'), t('CHamod', '+1'),
    t('StrProf'), t('ST Strength', '+2'), t('DexProf'), t('ST Dexterity', '+0'), t('ConProf'), t('ST Constitution', '+3'),
    t('IntProf'), t('ST Intelligence', '-1'), t('WisProf', '•'), t('ST Wisdom', '+6'), t('ChaProf', '•'), t('ST Charisma', '+4'),
    t('Defenses', 'Resistances - Poison'), t('SaveModifiers'),
    t('AthleticsProf'), t('Athletics', '+2'), t('AthleticsMod', 'STR'), t('InsightProf', 'P'), t('Insight', '+6'), t('InsightMod', 'WIS'),
    t('MedicineProf', 'E'), t('Medicine', '+9'), t('MedicineMod', 'WIS'), t('PerceptionProf'), t('Perception', '+3'), t('PerceptionMod', 'WIS'),
    t('ReligionProf', 'P'), t('Religion', '+2'), t('ReligionMod', 'INT'), t('CustomProf1'), t('Custom Skill Bonus 1'), t('CustomSkill1'),
    t('Passive1', '13'), t('Passive2', '16'), t('Passive3', '9'), t('AdditionalSenses', 'Darkvision 120 ft.'),
    t('Init', '+0'), t('AC', '18'), t('ProfBonus', '+3'), t('AbilitySaveDC'), t('Speed', '25 ft. (Walking)'), t('MaxHP', '51'), t('CurrentHP', '40'), t('TempHP', '--'), t('Total', '6d8'), t('HD', '4'),
    ...[12, 13, 14, 15, 16, 17].map((n) => ({ name: `Check Box ${n}`, type: 'checkbox', value: n === 12 || n === 15 })),
    t('ProficienciesLang', '=== ARMOR === \nHeavy Armor, Light Armor, Medium Armor, Shields \n\n=== WEAPONS === \nSimple Weapons \n\n=== TOOLS === \nCalligrapher’s Supplies \n\n=== LANGUAGES === \nCommon, Dwarvish'),
    t('Actions1', '=== ACTIONS === \nStandard Actions \n     Attack, Magic, Dash \n\nChannel Divinity • 2 / Short Rest \n     You channel divine energy'),
    t('Actions2', 'directly from the gods. \n\n=== BONUS ACTIONS === \nSpiritual Weapon'),
    t('Wpn Name', 'Warhammer'), t('Wpn1 AtkBonus', '+5'), t('Wpn1 Damage', '1d8+2 Bludgeoning'), t('Wpn Notes 1', 'Versatile'),
    t('Wpn Name 2', 'Sacred Flame'), t('Wpn2 AtkBonus ', 'DEX 14'), t('Wpn2 Damage ', '2d8 Radiant'), t('Wpn Notes 2', 'V/S'),
    t('Wpn Name 3'), t('Wpn3 AtkBonus  '), t('Wpn3 Damage '), t('Wpn Notes 3'),
    { name: 'Inspiration', type: 'checkbox', value: true, on: 'Inspired' },
    t('CharacterName2', 'Odo Brightwater'), t('CLASS  LEVEL2', 'Cleric 6'), t('RACE2', 'Dwarf'),
    t('FeaturesTraits1', '=== CLERIC FEATURES === \n\n* Spellcasting • PHB-2024 69 \nYou can cast cleric spells. \n\n* Divine Order • PHB-2024 69 \n\n   | Protector \n\n* Cleric Subclass • PHB-2024 70 \n\n   | Life Domain \n\n* Channel Divinity • PHB-2024 70'),
    t('FeaturesTraits2', 'You can channel divine energy directly from the gods. \n\n   | 2 / Short Rest \n\n=== DWARF SPECIES TRAITS ==='),
    t('FeaturesTraits3'),
    t('FeaturesTraits4', '* Dwarven Resilience • PHB-2024 188 \nYou have Resistance to Poison damage. \n\n* Stonecunning • PHB-2024 188 \n\n=== FEATS === \n\n* Magic Initiate (Wizard) • PHB-2024 203 \nYou learn two Wizard cantrips. \n\n   | Intelligence • PHB-2024 \n\n* Healer • PHB-2024 201 \nBattle Medic. If you have a Healer’s Kit, you can expend'),
    t('FeaturesTraits5', 'one use of it and tend to a creature.'),
    t('CP', '5'), t('SP', ''), t('EP', '0'), t('GP', '120'), t('PP', '0'), t('Weight Carried', '90 lb.'), t('Encumbered', '210 lb.'), t('PushDragLift', '420 lb.'),
    ...[['Warhammer', '1', '5 lb.'], ['Chain Mail', '1', '55 lb.'], ['Shield', '1', '6 lb.'], ['Healer’s Kit', '1', '3 lb.'], ['Rations', '10', '20 lb.'], ['', '', '']]
      .flatMap(([n, q, w], i) => [t(`Eq Name${i}`, n), t(`Eq Qty${i}`, q), t(`Eq Weight${i}`, w)]),
    t('Attuned Name1', 'Periapt of Wound Closure'), t('Attuned Qty1', '1'), t('Attuned Weight1', '--'), t('Attuned Name2'), t('Attuned Qty2'), t('AttunedWeight3'),
    t('CharacterName4', 'Odo Brightwater'), t('GENDER'), t('AGE', '120'), t('SIZE', 'Medium'), t('HEIGHT', '4’5”'), t('WEIGHT'), t('ALIGNMENT', 'Lawful Good'), t('FAITH', 'Moradin'),
    t('SKIN'), t('EYES', 'Grey'), t('HAIR'), { name: 'CHARACTER IMAGE', type: 'pushbutton' }, t('AlliesOrganizations', 'The Temple of the Forge'),
    t('PersonalityTraits ', 'Patient'), t('Ideals', 'Tradition'), t('Bonds', 'My temple'), t('Appearance', 'A braided red beard.'), t('Flaws', 'Stubborn'),
    t('Backstory', 'Raised in the temple.'), t('AdditionalNotes1', 'Owes the temple a favor.'), t('AdditionalNotes2'),
    t('spellCastingAbility0', 'WIS'), t('spellSaveDC0', '14'), t('spellAtkBonus0', '+6'), t('spellCastingClass0', 'Cleric'),
  ];
  let row = 0;
  const level = (i, heading, slots, spells) => {
    if (i) out.push(...SPELL_COLS.map((c) => t(`spell${c}BlankHeader${i}`)));
    out.push(t(`spellPreparedHeader${i}`), t(`spellHeader${i}`, heading), t(`spellSlotHeader${i}`, slots), ...SPELL_COLS.slice(3).map((c) => t(`spell${c}Header${i}`)));
    for (const s of spells) { out.push(...SPELL_COLS.map((c, k) => t(`spell${c}${row}`, s[k] || ''))); row++; }
  };
  level(0, '=== CANTRIPS ===', '(At Will)', [
    ['O', 'Sacred Flame', 'Cleric', 'DEX 14', '1A', '60 ft.', 'V,S', 'Instantaneous', 'PHB-2024 311', 'V/S'],
    ['O', 'Guidance', 'Cleric', '--', '1A', 'Touch', 'V,S', 'Concentration, up to 1 minute', 'PHB-2024 282', 'D: 1m, V/S'],
    ['O', 'Fire Bolt', 'Magic Initiate (Wizard)', '+5', '1A', '120 ft.', 'V,S', 'Instantaneous', 'PHB-2024 274', 'V/S'],
  ]);
  level(1, '=== 1st LEVEL ===', '4 Slots XOOO', [
    ['P', 'Bless', 'Life Domain (Always Prepared)', '--', '1A', '30 ft.', 'V,S,M', 'Concentration, up to 1 minute', 'PHB-2024 247', 'D: 1m, V/S/M'],
    ['O', 'Healing Word', 'Cleric', '--', '1BA', '60 ft.', 'V', 'Instantaneous', 'PHB-2024 284', 'V'],
    ['O', 'Sleep', 'Magic Initiate (Wizard)', 'WIS 14', '1A', '60 ft.', 'V,S,M', 'Concentration, up to 1 minute', 'PHB-2024 318', '1/LR, D: 1m, V/S/M'],
    ['O', 'Sleep', 'Magic Initiate (Wizard)', 'WIS 14', '1A', '60 ft.', 'V,S,M', 'Concentration, up to 1 minute', 'PHB-2024 318', 'D: 1m, V/S/M'],
  ]);
  level(2, '=== 2nd LEVEL ===', '3 Slots OOO', [
    ['O', 'Spiritual Weapon', 'Cleric', '+6', '1BA', '60 ft.', 'V,S', 'Concentration, up to 1 minute', 'PHB-2024 321', 'D: 1m, V/S'],
    ['O', 'Augury', 'Cleric', '--', '1m', 'Self', 'V,S,M', 'Instantaneous', 'PHB-2024 244', 'V/S/M'],
  ]);
  level(3, '=== 3rd LEVEL ===', '3 Slots OOO', [['O', 'Revivify', 'Cleric', '--', '1A', 'Touch', 'V,S,M', 'Instantaneous', 'PHB-2024 314', 'V/S/M']]);
  for (const c of ['Prepared', 'SpellName', 'SpellSource', 'SaveHit', 'CastingTime', 'Range', 'Components', 'Duration', 'Source', 'Notes']) out.push(t(`${c}43`));
  return out;
}

test('a page widget outside any AcroForm is still a field', async () => {
  const form = await formOf(formPdf([{ name: 'CharacterName', type: 'text', value: 'Odo' }, { name: 'Inspiration', type: 'checkbox', value: true, on: 'Inspired' }], { listed: false }));
  assert.equal(form.hasForm, true);
  assert.equal(form.unlisted, 2);
  assert.deepEqual(form.fields.map((f) => [f.name, f.value]), [['CharacterName', 'Odo'], ['Inspiration', 'Inspired']]);
});

test('D&D Beyond’s export comes in whole: marks, run-on boxes and the spell table', async () => {
  const { characterFromForm } = await load('sheets/dndpdfimport.js');
  const { name, data: d, blocks, report } = characterFromForm(await formOf(formPdf(ddbFields(), { listed: false })), { classes: [{ name: 'Cleric', hitDie: 8 }] });
  assert.equal(name, 'Odo Brightwater');
  assert.equal(report.layout, 'a D&D Beyond character sheet export');
  assert.equal(report.leftovers, 0, 'every filled-in field is read or knowingly passed over');
  assert.deepEqual(report.skipped, []);
  assert.deepEqual({ ...d.klass }, { name: 'Cleric', level: 6, hitDie: 8, subclass: 'Life Domain' }, 'the subclass is the choice under “Cleric Subclass”');
  assert.deepEqual(d.species, { name: 'Dwarf', size: 'Medium', speed: 25 });
  assert.equal(d.background.name, 'Acolyte');
  assert.equal(d.xp, 'Milestone');
  assert.equal(d.alignment, 'Lawful Good');
  assert.deepEqual(d.abilities, { str: 14, dex: 10, con: 16, int: 8, wis: 17, cha: 12 });
  assert.deepEqual(d.saves, ['wis', 'cha'], '“•” marks a proficient save');
  assert.deepEqual(d.skills, [{ key: 'Insight', prof: 'prof' }, { key: 'Medicine', prof: 'expert' }, { key: 'Religion', prof: 'prof' }], 'P is proficient, E expertise');
  assert.equal(d.ac, 18);
  assert.deepEqual(d.hp, { max: 51, current: 40, temp: 0 }, '“--” is an empty box');
  assert.deepEqual(d.hitDice, { spent: 2 }, 'six hit dice with four left');
  assert.deepEqual(d.deathSaves, { success: 1, failure: 1 });
  assert.equal(d.inspiration, true);
  assert.equal(d.initiativeBonus, undefined);
  assert.deepEqual(d.attacks, [{ name: 'Warhammer', bonus: 5, damage: '1d8+2 Bludgeoning', notes: 'Versatile' }, { name: 'Sacred Flame', bonus: 'DEX 14', damage: '2d8 Radiant', notes: 'V/S' }]);
  assert.deepEqual(d.proficiencies, { armor: ['Heavy Armor', 'Light Armor', 'Medium Armor', 'Shields'], weapons: ['Simple Weapons'], tools: ['Calligrapher’s Supplies'] });
  assert.deepEqual(d.languages, ['Common', 'Dwarvish']);
  assert.deepEqual(d.features.map((f) => [f.name, f.source]), [
    ['Spellcasting', 'Cleric'], ['Divine Order', 'Cleric'], ['Cleric Subclass', 'Cleric'], ['Channel Divinity', 'Cleric'],
    ['Dwarven Resilience', 'Dwarf trait'], ['Stonecunning', 'Dwarf trait'], ['Magic Initiate (Wizard)', 'Feat'], ['Healer', 'Feat']]);
  const channel = d.features.find((f) => f.name === 'Channel Divinity');
  assert.equal(channel.ref, 'PHB-2024 70', 'a heading that ends one box keeps the text of the next');
  assert.equal(channel.text, 'You can channel divine energy directly from the gods.\n2 / Short Rest');
  assert.equal(d.features.find((f) => f.name === 'Healer').text, 'Battle Medic. If you have a Healer’s Kit, you can expend one use of it and tend to a creature.', 'text cut between boxes joins up');
  const sc = d.spellcasting;
  assert.equal(sc.ability, 'wis');
  assert.equal(sc.dc, 14);
  assert.equal(sc.attackBonus, 6);
  assert.deepEqual(sc.slots, { 1: { max: 4, used: 1 }, 2: { max: 3, used: 0 }, 3: { max: 3, used: 0 } }, 'slots come from the level headers');
  assert.deepEqual(sc.cantrips, ['Sacred Flame', 'Guidance']);
  assert.deepEqual(sc.prepared, ['Healing Word', 'Spiritual Weapon', 'Augury', 'Revivify']);
  assert.deepEqual(sc.alwaysPrepared, ['Bless']);
  assert.deepEqual(d.innateSpells, [
    { name: 'Fire Bolt', level: 0, source: 'Magic Initiate (Wizard)', ability: 'int' },
    { name: 'Sleep', level: 1, source: 'Magic Initiate (Wizard)', ability: 'int', uses: 1 }], 'feat spells, with the ability the feat records and a daily casting');
  const detail = (n) => d.spellDetails.find((s) => s.name === n);
  assert.deepEqual({ ...detail('Healing Word') }, { name: 'Healing Word', level: 1, castingTime: 'Bonus Action', range: '60 ft.', components: 'V', duration: 'Instantaneous' });
  assert.deepEqual({ ...detail('Guidance') }, { name: 'Guidance', level: 0, castingTime: 'Action', range: 'Touch', components: 'V, S', duration: 'up to 1 minute', concentration: true });
  assert.equal(detail('Augury').castingTime, '1 minute');
  assert.equal(d.spellDetails.filter((s) => s.name === 'Sleep').length, 1, 'a second row for the same spell adds nothing');
  assert.deepEqual(d.equipment, [{ name: 'Warhammer', qty: 1 }, { name: 'Chain Mail', qty: 1 }, { name: 'Shield', qty: 1 }, { name: 'Healer’s Kit', qty: 1 }, { name: 'Rations', qty: 10 }]);
  assert.deepEqual(d.coins, { cp: 5, sp: 0, ep: 0, gp: 120, pp: 0 });
  assert.deepEqual(d.attuned, ['Periapt of Wound Closure']);
  assert.equal(d.appearance, 'A braided red beard.\nAge: 120 · Height: 4’5” · Eyes: Grey · Faith: Moradin');
  assert.deepEqual(d.personality, { traits: 'Patient', ideals: 'Tradition', bonds: 'My temple', flaws: 'Stubborn' });
  assert.equal(d.backstory, 'Raised in the temple.');
  assert.equal(d.notes, ['Senses: Darkvision 120 ft.', 'Defenses: Resistances - Poison', 'Allies & organizations: The Temple of the Forge', 'Player: Pat', 'Owes the temple a favor.'].join('\n\n'),
    'every number agrees with what MundusMaker works out, so the notes hold only what has no place on the sheet');
  assert.deepEqual(blocks, [{ title: 'Actions', text: 'Standard Actions\nAttack, Magic, Dash\n\nChannel Divinity • 2 / Short Rest\nYou channel divine energy directly from the gods.\n\n**Bonus Actions**\nSpiritual Weapon' }]);
});

// ---------- other sheets, by field name ----------

const CLASSIC = [
  ['CharacterName', 'Mira Quickfoot'], ['ClassLevel', 'Wizard 3 / Rogue 2'], ['Race ', 'Lightfoot Halfling'], ['Background', 'Sage'], ['Alignment', 'Neutral Good'],
  ['XP', '6,500'], ['PlayerName', 'Sam'], ['STR', '8'], ['STRmod', '-1'], ['DEX', '16'], ['DEXmod ', '+3'], ['CON', '14'], ['CONmod', '+2'],
  ['INT', '16'], ['INTmod', '+3'], ['WIS', '12'], ['WISmod', '+1'], ['CHA', '10'], ['CHamod', '+0'], ['ProfBonus', '+3'],
  ['ST Strength', '-1'], ['ST Dexterity', '+6'], ['ST Constitution', '+2'], ['ST Intelligence', '+6'], ['ST Wisdom', '+1'], ['ST Charisma', '+0'],
  ['Stealth ', '+9'], ['Arcana', '+6'], ['Perception ', '+1'], ['Insight', '+2'], ['SleightofHand', '+6'], ['Passive', '11'],
  ['AC', '13'], ['Initiative', '+3'], ['Speed', '25ft.'], ['HPMax', '27'], ['HPCurrent', ''], ['HPTemp', ''], ['HDTotal', '5'], ['HD', '3'],
  ['Wpn Name', 'Dagger'], ['Wpn1 AtkBonus', '+6'], ['Wpn1 Damage', '1d4+3 piercing'], ['Wpn Name 2', 'Fire Bolt'], ['Wpn2 AtkBonus ', '+6'], ['Wpn2 Damage ', '1d10 fire'],
  ['ProficienciesLang', '=== ARMOR ===\nLight Armor\n=== WEAPONS ===\nDaggers, Darts, Hand Crossbows\n=== TOOLS ===\nThieves’ Tools\n=== LANGUAGES ===\nCommon, Halfling, Elvish'],
  ['Equipment', 'Dagger x2\nSpellbook\n50 ft. of hempen rope\n3 Torches'], ['GP', '75'], ['SP', ''], ['CP', '4'],
  ['Features and Traits', '* Sneak Attack • PHB 96\nOnce per turn, you can deal an extra 1d6 damage.\n* Arcane Recovery • PHB 115\nRegain spell slots on a short rest.\n* Lucky\nReroll a 1.'],
  ['PersonalityTraits ', 'Curious about everything'], ['Ideals', 'Knowledge'], ['Bonds', 'My old library'], ['Flaws', 'Overconfident'],
  ['Age', '30'], ['Height', '3’1”'], ['Backstory', 'Left the library to see the world.'], ['Allies', 'The Lantern Society'], ['Treasure', 'A silver locket'],
  ['Spellcasting Class 2', 'Wizard'], ['SpellcastingAbility 2', 'INT'], ['SpellSaveDC  2', '14'], ['SpellAtkBonus 2', '+6'], ['SlotsTotal 19', '4'], ['SlotsRemaining 19', '1'], ['SlotsTotal 20', '2'],
  ['Spells 1014', 'Fire Bolt'], ['Spells 1015', 'Mage Hand'], ['Mystery Field', 'Owes the guild 40 gp'],
];

test('an unfamiliar sheet is read by field name, and proficiency is worked out from its bonuses', async () => {
  const { characterFromForm } = await load('sheets/dndpdfimport.js');
  const form = await formOf(formPdf([...CLASSIC.map(([name, value]) => ({ name, type: 'text', value })), { name: 'Check Box 11', type: 'checkbox', value: true }]));
  const { name, data: d, report } = characterFromForm(form, { classes: [{ name: 'Wizard', hitDie: 6 }] });
  assert.equal(name, 'Mira Quickfoot');
  assert.equal(report.layout, '');
  assert.deepEqual({ ...d.klass }, { name: 'Wizard', level: 5, hitDie: 6, subclass: '' }, 'the first class at the total level; the hit die from the class list');
  assert.ok(report.warnings.some((w) => /multiclassed \(Wizard 3 \/ Rogue 2\)/.test(w)));
  assert.match(d.notes, /Classes: Wizard 3 \/ Rogue 2/);
  assert.equal(d.species.name, 'Lightfoot Halfling');
  assert.equal(d.xp, 6500);
  assert.deepEqual(d.abilities, { str: 8, dex: 16, con: 14, int: 16, wis: 12, cha: 10 });
  assert.deepEqual(d.saves, ['dex', 'int']);
  assert.deepEqual(d.skills, [{ key: 'Arcana', prof: 'prof' }, { key: 'Sleight of Hand', prof: 'prof' }, { key: 'Stealth', prof: 'expert' }]);
  assert.ok(report.warnings.some((w) => /worked out from the bonuses/.test(w)));
  assert.match(d.notes, /On the imported sheet: Insight \+2\./, 'a bonus MundusMaker can’t explain is kept');
  assert.equal(d.speed, 25);
  assert.deepEqual(d.hp, { max: 27, current: 27, temp: 0 });
  assert.ok(report.warnings.some((w) => /Current hit points were blank/.test(w)));
  assert.equal(d.hitDice.spent, 2, 'five hit dice with three left');
  assert.deepEqual(d.attacks, [{ name: 'Dagger', bonus: 6, damage: '1d4+3 piercing' }, { name: 'Fire Bolt', bonus: 6, damage: '1d10 fire' }]);
  assert.deepEqual(d.proficiencies, { armor: ['Light Armor'], weapons: ['Daggers', 'Darts', 'Hand Crossbows'], tools: ['Thieves’ Tools'] });
  assert.deepEqual(d.languages, ['Common', 'Halfling', 'Elvish']);
  assert.deepEqual(d.equipment, [{ name: 'Dagger', qty: 2 }, { name: 'Spellbook', qty: 1 }, { name: '50 ft. of hempen rope', qty: 1 }, { name: 'Torches', qty: 3 }]);
  assert.deepEqual(d.coins, { cp: 4, sp: 0, ep: 0, gp: 75, pp: 0 });
  assert.deepEqual(d.features.map((f) => [f.name, f.ref || '', f.text]), [
    ['Sneak Attack', 'PHB 96', 'Once per turn, you can deal an extra 1d6 damage.'], ['Arcane Recovery', 'PHB 115', 'Regain spell slots on a short rest.'], ['Lucky', '', 'Reroll a 1.']]);
  assert.deepEqual(d.personality, { traits: 'Curious about everything', ideals: 'Knowledge', bonds: 'My old library', flaws: 'Overconfident' });
  assert.equal(d.appearance, 'Age: 30 · Height: 3’1”');
  assert.equal(d.backstory, 'Left the library to see the world.');
  assert.equal(d.spellcasting.ability, 'int');
  assert.equal(d.spellcasting.dc, 14);
  assert.deepEqual(d.spellcasting.slots, { 1: { max: 4, used: 3 }, 2: { max: 2, used: 0 } });
  assert.deepEqual(d.spellcasting.cantrips, [], 'numbered spell rows don’t say which are cantrips');
  for (const kept of ['Spells on the sheet: Fire Bolt, Mage Hand', 'Mystery Field: Owes the guild 40 gp', 'Allies & organizations: The Lantern Society', 'Treasure: A silver locket', 'Player: Sam']) {
    assert.ok(d.notes.includes(kept), `notes keep “${kept}”`);
  }
  assert.ok(!d.notes.includes('Check Box'), 'tick boxes that mean nothing here are not copied as text');
});

test('a box ticked only through its widget counts, and an empty or flattened form reads as nothing', async () => {
  const { characterFromForm } = await load('sheets/dndpdfimport.js');
  const ticked = await formOf(formPdf([{ name: 'CharacterName', type: 'text', value: 'Wren' }, { name: 'Inspiration', type: 'checkbox', value: true, asOnly: true }]));
  assert.equal(ticked.fields.find((f) => f.name === 'Inspiration').value, '', 'no /V on the field');
  assert.equal(characterFromForm(ticked).data.inspiration, true);

  const flat = await formOf(formPdf([{ name: 'CharacterName', type: 'text', value: 'Wren' }], { acroForm: false }));
  assert.equal(flat.hasForm, false);
  assert.equal(flat.fields.length, 0);
  const none = characterFromForm(flat);
  assert.equal(none.name, '');
  assert.deepEqual(none.report.imported, []);
  assert.ok(none.report.skipped.some((s) => /^Class/.test(s)));
  assert.equal(none.data.spellcasting, null);
});

test('class, feature and equipment text is parsed the way sheets write it', async () => {
  const { parseClassLevel, parseFeatures, parseEquipment, sheetNumber } = await load('sheets/dndpdfimport.js');
  assert.deepEqual(parseClassLevel('Rogue 5 (Thief)'), [{ name: 'Rogue', level: 5, subclass: 'Thief' }]);
  assert.deepEqual(parseClassLevel('Fighter (Champion) 3 / Wizard 2'), [{ name: 'Fighter', level: 3, subclass: 'Champion' }, { name: 'Wizard', level: 2, subclass: '' }]);
  assert.deepEqual(parseClassLevel('Paladin'), []);
  assert.deepEqual(parseFeatures('Rage\nUnarmored Defense', 'Barbarian').map((f) => f.name), ['Rage', 'Unarmored Defense']);
  assert.deepEqual(parseFeatures('=== BARBARIAN FEATURES ===\n* Rage • PHB-2024 51\nIn battle, you fight with primal ferocity.\n   | 3 / Long Rest\n* 8: Ability Score Improvement', '', (h) => `from ${h}`), [
    { name: 'Rage', source: 'from BARBARIAN FEATURES', text: 'In battle, you fight with primal ferocity.\n3 / Long Rest', ref: 'PHB-2024 51', details: ['3 / Long Rest'] },
    { name: 'Ability Score Improvement (level 8)', source: 'from BARBARIAN FEATURES', text: '' }]);
  assert.deepEqual(parseEquipment('Rations (10)\n2 × Flask of oil\nBackpack'), [{ name: 'Rations', qty: 10 }, { name: 'Flask of oil', qty: 2 }, { name: 'Backpack', qty: 1 }]);
  assert.deepEqual(parseEquipment('Backpack, Bedroll, 10 days of rations'), [{ name: 'Backpack', qty: 1 }, { name: 'Bedroll', qty: 1 }, { name: '10 days of rations', qty: 1 }]);
  assert.equal(sheetNumber('−2'), -2);
  assert.equal(sheetNumber('30 ft.'), 30);
  assert.equal(sheetNumber('DC 15'), null);
});

// ---------- the imported character on every sheet layout ----------

test('an imported character draws in the familiar layout and the printable sheet', async () => {
  const { characterFromForm } = await load('sheets/dndpdfimport.js');
  const { familiarModel, familiarHtml } = await load('sheets/familiar.js');
  const { writeSystemSheet } = await load('sheets/sheetpdf.js');
  for (const bytes of [await filled2024(), formPdf(ddbFields(), { listed: false }), formPdf(CLASSIC.map(([name, value]) => ({ name, type: 'text', value })))]) {
    const { name, data } = characterFromForm(await formOf(bytes));
    const saved = JSON.parse(JSON.stringify(data)); // what the server stores
    const model = familiarModel('dnd2024', saved, { name });
    assert.equal(model.pages.length, 2);
    const svg = familiarHtml('dnd2024', saved, { name });
    assert.ok(svg.includes(name.split(' ')[0]), 'the name is on the sheet');
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const printed = [], original = doc.text.bind(doc);
    doc.text = (value, ...rest) => { printed.push([].concat(value).join(' ')); return original(value, ...rest); };
    writeSystemSheet(doc, 'dnd2024', saved, { name, safe: String, firstPage: true, gm: false, secret: false });
    assert.ok(printed.some((t) => t.includes(saved.attacks[0].name)));
    if (saved.attacks.some((a) => a.bonus === 'DC 15')) {
      assert.ok(printed.includes('DC 15'), 'a save DC prints as written');
      assert.ok(!printed.some((t) => /Vicious Mockery: \+0 to hit/.test(t)), 'never as a +0 attack');
    }
  }
});
