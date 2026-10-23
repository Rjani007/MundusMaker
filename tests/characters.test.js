'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const urlCache = new Map();
function moduleUrl(file) {
  const absolute = path.resolve(__dirname, '../public/js', file);
  if (urlCache.has(absolute)) return urlCache.get(absolute);
  const src = fs.readFileSync(absolute, 'utf8').replace(/from '(\.\.?\/[^']+)'/g, (_, rel) => `from '${moduleUrl(path.relative(path.resolve(__dirname, '../public/js'), path.resolve(path.dirname(absolute), rel)))}'`);
  const url = 'data:text/javascript;base64,' + Buffer.from(src + '\n//# sourceURL=mundusmaker-test/' + file.replaceAll('\\', '/') + '\n').toString('base64'); urlCache.set(absolute, url); return url;
}
const rules = import(moduleUrl('sheets/dndrules.js'));
const advancement = import(moduleUrl('sheets/dndadvance.js'));
const categories = import(moduleUrl('categorycore.js'));
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../public/srd52', name + '.json'), 'utf8'));
const progression = read('progression');
const classes = read('classes').classes.map(c => { const p = progression.classes.find(p => p.name === c.name); return { ...c, progression: p, subclasses: c.subclass ? [{ ...c.subclass, ...p.subclassRules?.find(s => s.name === c.subclass.name) }] : [] }; });
const library = { classes, spells: read('spells').spells, equipment: read('equipment').equipment,
  feats: read('feats').feats.map(f => ({ ...f, ...progression.feats.find(p => p.name === f.name) })) };
const klass = name => classes.find(c => c.name === name);

test('ability methods reject invalid numbers, duplicate arrays and under/overspending', async () => {
  const { validateAbilities, recommendedAbilities } = await rules;
  const d = { abilityMethod: 'standard', abilities: recommendedAbilities(klass('Wizard')) };
  assert.equal(d.abilities.int, 15); assert.equal(validateAbilities(d), null);
  d.abilities.str = 15; assert.match(validateAbilities(d), /exactly once/);
  d.abilityMethod = 'roll'; d.abilities.str = 50; assert.match(validateAbilities(d), /3 and 18/);
  d.abilities.str = 10.5; assert.match(validateAbilities(d), /whole number/);
  d.abilityMethod = 'pointbuy'; d.abilities = Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map(k => [k, 8]));
  assert.match(validateAbilities(d), /27 points/);
});

test('legacy backgrounds give three chosen +1s, never six; bonus cap is enforced', async () => {
  const { finalAbilities, validateBackground } = await rules;
  const d = { background: { abilities: [] }, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, bgBonus: { mode: '1+1+1', three: ['str', 'con', 'wis'] } };
  assert.equal(validateBackground(d), null); assert.deepEqual(finalAbilities(d), { str: 11, dex: 10, con: 11, int: 10, wis: 11, cha: 10 });
  d.bgBonus.three.push('dex'); assert.match(validateBackground(d), /three different/);
  d.bgBonus = { mode: '2+1', two: 'str', one: 'str' }; assert.match(validateBackground(d), /different/);
});

test('starting equipment chooses one option, carries quantities and gold, and derives attacks and AC', async () => {
  const r = await rules;
  const options = r.equipmentChoices(klass('Barbarian').startingEquipment);
  assert.equal(options.length, 2); assert.equal(options[1].text, '75 GP');
  const gear = r.parseEquipment(options[0].text, library.equipment);
  assert.equal(gear.gp, 15); assert.equal(gear.items.find(x => x.name === 'Handaxe').qty, 4);
  const abs = { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 };
  assert.equal(r.armorClass(abs, klass('Fighter'), library.equipment.find(e => e.name === 'Chain Mail'), true), 18);
  assert.equal(r.armorClass(abs, klass('Barbarian'), null, false), 14);
  const sword = r.weaponAttack(library.equipment.find(e => e.name === 'Longsword'), abs, klass('Fighter'));
  assert.equal(sword.bonus, 5); assert.equal(sword.damage, '1d8+3 slashing');
});

test('SRD equipment: only the Shield is a shield, and armor carries its weight class', async () => {
  const r = await rules, find = n => library.equipment.find(e => e.name === n);
  assert.deepEqual(library.equipment.filter(e => /shield/i.test(e.category)).map(e => e.name), ['Shield']);
  for (const focus of ['Crystal', 'Orb', 'Rod', 'Wand']) assert.equal(find(focus).category, 'gear', focus);
  const weights = { light: ['Padded Armor', 'Leather Armor', 'Studded Leather Armor'], medium: ['Hide Armor', 'Chain Shirt', 'Scale Mail', 'Breastplate', 'Half Plate Armor'], heavy: ['Ring Mail', 'Chain Mail', 'Splint Armor', 'Plate Armor'] };
  for (const [weight, names] of Object.entries(weights)) for (const n of names) assert.equal(find(n).category, `${weight} armor`, n);
  assert.equal(library.equipment.filter(e => /armor/.test(e.category)).length, 12);
  // The weight class alone sets the Dex cap, so renamed armor still adds the right amount.
  const abs = { str: 10, dex: 18, con: 10, int: 10, wis: 10, cha: 10 };
  assert.equal(r.armorClass(abs, klass('Fighter'), { ...find('Breastplate'), name: 'Dwarven cuirass' }), 16);
  assert.equal(r.armorClass(abs, klass('Fighter'), { ...find('Plate Armor'), name: 'Old plate' }), 18);
});

test('all SRD classes have bounded level 1-20 progression and correct full/half/pact slots', async () => {
  const { spellProgression } = await rules;
  assert.equal(progression.classes.length, 12); assert.match(progression._meta.license, /Creative Commons/);
  for (const c of classes) for (let level = 1; level <= 20; level++) assert.equal(spellProgression(c, level).supported, true, `${c.name} ${level}`);
  assert.deepEqual(spellProgression(klass('Wizard'), 5).slots, { 1: 4, 2: 3, 3: 2 });
  assert.deepEqual(spellProgression(klass('Paladin'), 1).slots, { 1: 2 });
  assert.deepEqual(spellProgression(klass('Warlock'), 3).slots, { 2: 2 });
  assert.equal(spellProgression(klass('Wizard'), 20).prepared, 25);
  assert.equal(progression.classes.find(c => c.name === 'Bard').startingProficiencies.skills[0].any, 3);
});

test('level-up applies retroactive Constitution HP and ASIs atomically', async () => {
  const r = await rules, { planLevelUp } = await advancement;
  const d = r.defaults(); d.klass = { name: 'Barbarian', level: 3, hitDie: 12, subclass: klass('Barbarian').subclass.name };
  d.abilities.con = 13; d.hp = { max: 31, current: 20, temp: 4 };
  const before = structuredClone(d);
  const choices = { hpMethod: 'average', improvement: 'asi', abilityIncreases: { con: 1, dex: 1 } };
  const result = planLevelUp(d, klass('Barbarian'), choices, library);
  assert.deepEqual(d, before); assert.equal(result.data.hp.max, 43); assert.equal(result.data.hp.current, 32); assert.equal(result.data.hp.temp, 4);
  assert.equal(result.changes.retroactive, 3); assert.equal(result.data.abilities.con, 14);
  choices.abilityIncreases = { con: 3 }; assert.throws(() => planLevelUp(d, klass('Barbarian'), choices, library), /Assign/); assert.deepEqual(d, before);
});

test('wizard learns spells, changes slots, retains spent slots and requires Scholar expertise', async () => {
  const r = await rules, { planLevelUp } = await advancement, c = klass('Wizard');
  const d = r.defaults(); d.klass = { name: 'Wizard', level: 1, hitDie: 6, subclass: '' }; d.abilities.int = 16;
  d.skills = [{ key: 'Arcana', prof: 'prof' }];
  const spells = r.availableSpells(library, c, 1), cantrips = spells.filter(s => !s.level).slice(0, 3).map(s => s.name), book = spells.filter(s => s.level === 1).slice(0, 8).map(s => s.name);
  d.spellcasting = { cantrips, prepared: book.slice(0, 4), spellbook: book.slice(0, 6), slots: { 1: { max: 2, used: 1 } } };
  const choices = { hpMethod: 'average', cantrips, prepared: book.slice(0, 5), newSpells: book.slice(6, 8), expertise: ['Arcana'], featuresReviewed: true };
  const out = planLevelUp(d, c, choices, library).data;
  assert.deepEqual(out.spellcasting.slots, { 1: { max: 3, used: 1 } }); assert.equal(out.spellcasting.spellbook.length, 8); assert.equal(out.spellcasting.dc, 13); assert.equal(out.skills[0].prof, 'expert');
  assert.throws(() => planLevelUp(d, c, { ...choices, expertise: [] }, library), /expertise/);
  assert.throws(() => planLevelUp(d, c, { ...choices, newSpells: book.slice(0, 2) }, library), /spellbook/);
});

test('pact slot level changes preserve used slots and subclass is required', async () => {
  const r = await rules, { planLevelUp } = await advancement, c = klass('Warlock');
  const d = r.defaults(); d.klass = { name: 'Warlock', level: 2, hitDie: 8, subclass: '' }; d.abilities.cha = 16;
  const list = r.availableSpells(library, c, 2), cantrips = list.filter(s => !s.level).slice(0, 2).map(s => s.name), prepared = list.filter(s => s.level > 0).slice(0, 4).map(s => s.name);
  d.spellcasting = { cantrips, prepared: prepared.slice(0, 3), slots: { 1: { max: 2, used: 1 } } };
  const choices = { hpMethod: 'average', cantrips, prepared, subclass: c.subclasses[0].name, featuresReviewed: true };
  const out = planLevelUp(d, c, choices, library).data;
  assert.deepEqual(out.spellcasting.slots, { 2: { max: 2, used: 1 } }); assert.equal(out.klass.subclass, c.subclasses[0].name);
  assert.throws(() => planLevelUp(d, c, { ...choices, subclass: '' }, library), /subclass/);
});

test('invalid HP rolls, unavailable progression and level 20 do not mutate data', async () => {
  const r = await rules, { planLevelUp } = await advancement;
  const d = r.defaults(); d.klass = { name: 'Fighter', level: 1, hitDie: 10 }; const before = structuredClone(d);
  assert.throws(() => planLevelUp(d, klass('Fighter'), { hpMethod: 'rolled', hpRoll: 99 }, library), /hit-die/);
  assert.deepEqual(d, before); d.klass.level = 20;
  assert.throws(() => planLevelUp(d, klass('Fighter'), { hpMethod: 'average' }, library), /1 to 19/);
});

test('relationship groups and nearby entries never use hidden entities or secret edges', async () => {
  const { relatedEntries, connectedGroups } = await categories;
  const a = { id: 'a', name: 'A', relations: [{ to: 'hub', label: 'Member' }] }, b = { id: 'b', name: 'B', relations: [{ to: 'hub', label: 'Member', secret: true }] },
    hub = { id: 'hub', name: 'Guild' }, hidden = { id: 'hidden', name: 'Secret God', gmOnly: true, relations: [{ to: 'a' }] };
  const all = [a, b, hub, hidden];
  assert.deepEqual(relatedEntries(all, 'a', false).map(x => x.entry.name), ['Guild']);
  assert.deepEqual(relatedEntries(all, 'hidden', false), []);
  assert.equal(connectedGroups(all, [a, b], false).length, 2);
  assert.equal(connectedGroups(all, [a, b], true).length, 1);
  assert.ok(!JSON.stringify(connectedGroups(all, [a, b], false)).includes('Secret God'));
});

test('custom category ids are stable, unique, and cannot overwrite prototype keys; orphan entries remain visible', async () => {
  const { categoryKey, categoryGroups } = await categories;
  assert.equal(categoryKey('Gods', {}), 'gods'); assert.equal(categoryKey('Gods', { gods: {} }), 'gods-2');
  assert.equal(categoryKey('constructor', {}), 'constructor-2');
  assert.deepEqual(categoryGroups({ character: {} }, [{ type: 'forgotten' }]).map(([key]) => key), ['character', 'forgotten']);
});

test('planned subclasses wait until level 3 and cannot replace an existing subclass', async () => {
  const r = await rules, { planLevelUp } = await advancement, c = klass('Fighter');
  const d = r.defaults(); d.klass = { name: 'Fighter', level: 1, hitDie: 10, subclass: '', plannedSubclass: 'Champion' };
  assert.equal(planLevelUp(d, c, { hpMethod: 'average', featuresReviewed: true }, library).data.klass.subclass, '');
  assert.throws(() => planLevelUp(d, c, { hpMethod: 'average', subclass: 'Champion' }, library), /level 3/);
});

test('Monk weapons and restricted Rogue weapon training calculate correct attacks', async () => {
  const r = await rules, abs = { str: 10, dex: 16, con: 14, int: 8, wis: 14, cha: 10 };
  const find = n => library.equipment.find(e => e.name === n);
  assert.equal(r.weaponAttack(find('Quarterstaff'), abs, klass('Monk')).bonus, 5);
  assert.equal(r.weaponAttack(find('Dagger'), abs, klass('Monk')).damage, '1d6+3 piercing');
  assert.equal(r.weaponAttack(find('Quarterstaff'), abs, klass('Monk'), 5).damage, '1d8+3 bludgeoning');
  assert.equal(r.weaponAttack(find('Rapier'), abs, klass('Rogue')).bonus, 5);
  assert.equal(r.weaponAttack(find('Longsword'), abs, klass('Rogue')).proficient, false);
});

test('fixed class/subclass spells are extra and cannot consume prepared choices', async () => {
  const r = await rules, a = await advancement, c = klass('Cleric');
  const d = r.defaults(); d.klass = { name: c.name, level: 2, hitDie: c.hitDie, subclass: '' }; d.abilities.wis = 16;
  const grants = a.subclassSpells(c.subclasses[0], 3).map(n => library.spells.find(s => r.lower(s.name) === r.lower(n))?.name || n);
  const p = r.spellProgression(c, 3), spells = r.availableSpells(library, c, p.maxLevel);
  const choices = { hpMethod: 'average', featuresReviewed: true, subclass: c.subclasses[0].name,
    cantrips: spells.filter(s => !s.level).slice(0, p.cantrips).map(s => s.name),
    prepared: spells.filter(s => s.level && !grants.includes(s.name)).slice(0, p.prepared).map(s => s.name) };
  const result = a.planLevelUp(d, c, choices, library).data;
  assert.ok(result.spellcasting.alwaysPrepared.length >= 4); assert.equal(result.spellcasting.prepared.length, p.prepared);
  assert.throws(() => a.planLevelUp(d, c, { ...choices, prepared: [grants[0], ...choices.prepared.slice(1)] }, library), /always-prepared/);
  assert.deepEqual(r.classGrantedSpells(klass('Ranger'), 1), ["Hunter's Mark"]);
});

test('Magic Initiate advancement records separately validated innate spells', async () => {
  const r = await rules, { planLevelUp } = await advancement;
  const d = r.defaults(); d.klass = { name: 'Fighter', level: 3, hitDie: 10, subclass: 'Champion' };
  const list = r.availableSpells(library, klass('Wizard'), 1), initiate = { className: 'Wizard', ability: 'int', cantrips: list.filter(s => !s.level).slice(0, 2).map(s => s.name), spell: list.find(s => s.level === 1).name };
  const choices = { hpMethod: 'average', improvement: 'feat', feat: 'Magic Initiate', featReviewed: true, initiate };
  const result = planLevelUp(d, klass('Fighter'), choices, library).data;
  assert.equal(result.innateSpells.length, 3); assert.equal(result.innateSpells[2].uses, 1); assert.ok(result.spellDetails.length >= 3);
  assert.throws(() => planLevelUp(d, klass('Fighter'), { ...choices, initiate: { ...initiate, cantrips: [] } }, library), /cantrips/);
});

test('Bard Jack of All Trades adds half proficiency only to otherwise untrained skills', async () => {
  const r = await rules, d = r.defaults(); d.klass.level = 5; d.abilities.wis = 14;
  d.features = [{ name: 'Jack of All Trades' }]; d.skills = [{ key: 'Arcana', prof: 'expert' }];
  assert.equal(r.skillBonus(d, 'Perception'), 3); assert.equal(r.passivePerception(d, 3), 13);
  assert.equal(r.skillBonus(d, 'Arcana'), 6);
});

test('every SRD class advances from level 1 through 20 using its own choices and tables', async () => {
  const r = await rules, a = await advancement;
  for (const c of classes) {
    let d = r.defaults(); d.klass = { name: c.name, level: 1, hitDie: c.hitDie, subclass: '' };
    d.abilities = { str: 13, dex: 13, con: 13, int: 13, wis: 13, cha: 13 };
    d.skills = r.unique([...(c.skills.from || []).map(r.canonSkill), ...r.SKILLS.map(([n]) => n)]).slice(0, Math.max(5, c.skills.choose)).map(key => ({ key, prof: 'prof' }));
    d.features = (c.features || []).filter(f => f.level === 1).map(f => ({ ...f, source: `${c.name} 1` }));
    if (c.name === 'Wizard') d.spellcasting = { spellbook: r.availableSpells(library, c, 1).filter(s => s.level === 1).slice(0, 6).map(s => s.name) };
    for (let to = 2; to <= 20; to++) {
      const sub = c.subclasses[0], req = a.advancementRequirements(d, c, to >= 3 ? sub.name : ''), p = req.spells;
      const choices = { hpMethod: 'average', featuresReviewed: true, skills: [], expertise: [] };
      if (req.subclass) choices.subclass = sub.name;
      if (req.fightingStyle) choices.fightingStyle = library.feats.find(f => f.category === 'Fighting Style' && !d.features.some(x => x.name === f.name)).name;
      if (req.abilityOrFeat) { choices.improvement = 'asi'; choices.abilityIncreases = Object.fromEntries(r.ABILITIES.filter(k => d.abilities[k] < 20).slice(0, 2).map(k => [k, 1])); }
      choices.skills = req.skillOptions.filter(n => !d.skills.some(s => s.key === n)).slice(0, req.skill);
      choices.expertise = d.skills.filter(s => s.prof !== 'expert' && (c.name !== 'Wizard' || ['Arcana','History','Investigation','Medicine','Nature','Religion'].includes(s.key))).slice(0, req.expertise).map(s => s.key);
      if (c.spellcasting) {
        const grants = [...r.classGrantedSpells(c, to), ...a.subclassSpells(to >= 3 ? sub : null, to)].map(r.lower);
        const list = r.availableSpells(library, c, p.maxLevel).filter(s => !grants.includes(r.lower(s.name)));
        choices.cantrips = list.filter(s => !s.level).slice(0, p.cantrips).map(s => s.name);
        const leveled = list.filter(s => s.level);
        if (c.name === 'Wizard') {
          const book = d.spellcasting.spellbook;
          choices.newSpells = leveled.filter(s => !book.includes(s.name)).slice(0, 2).map(s => s.name);
          choices.prepared = [...book, ...choices.newSpells].slice(0, p.prepared);
        } else choices.prepared = leveled.slice(0, p.prepared).map(s => s.name);
      }
      const prior = JSON.stringify(d);
      let result; try { result = a.planLevelUp(d, c, choices, library); } catch (err) { throw new Error(`${c.name} to level ${to}: ${err.message}`); }
      assert.equal(JSON.stringify(d), prior, `${c.name} ${to} preview is pure`);
      d = result.data; assert.equal(d.klass.level, to); assert.ok(Number.isFinite(d.hp.max));
    }
    assert.equal(d.advancement.log.length, 19, c.name);
  }
});
