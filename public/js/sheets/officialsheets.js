// "Use my own official sheet": which character value goes into which field of
// a publisher's fillable PDF. MundusMaker never ships or downloads these PDFs;
// the GM picks their own copy, and pdfform.js fills it locally.
//
// Three layers, all pure:
//   sheetValues()  one system's character data as flat, labelled values
//                  ("str.score", "skill.Arcana.prof", "disc.1.power.2");
//   TEMPLATES      built-in field maps for sheets checked against the
//                  publishers' own files (recognised by their field names);
//   suggestKey()   name matching for any other fillable sheet, which the
//                  review screen lets the GM correct field by field.
// A map entry is a value key, or [key, n] for a box that is ticked when the
// value is at least n (dots, damage, slots, death saves).

import { ABILITIES, ABILITY_NAMES, SKILLS, mod, fmtMod, profBonus, passivePerception, skillBonus } from './dndrules.js';
import { spellList, shortTime, V5_ATTRS, V5_SKILLS } from './familiar.js';

const str = (v) => (v == null ? '' : String(v));
const num = (v, d = 0) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());

// ---------- values ----------

function valueSet() {
  const values = new Map();
  const put = (key, label, value, group) => values.set(key, { label, value, group });
  return { values, put };
}

function dndValues(d, name) {
  const { values, put } = valueSet();
  const abs = d.abilities || {}, c = d.klass || {}, hp = d.hp || {}, level = num(c.level, 1), pb = profBonus(level);
  let g = 'Identity';
  put('name', 'Character name', name, g); put('background', 'Background', d.background?.name, g); put('class', 'Class', c.name, g);
  put('subclass', 'Subclass', c.subclass, g); put('species', 'Species', d.species?.name, g); put('level', 'Level', level, g); put('xp', 'Experience points', d.xp ?? '', g);
  put('alignment', 'Alignment', d.alignment, g);
  g = 'Combat';
  put('ac', 'Armor class', d.ac ?? 10, g); put('shield', 'Shield', !!d.defense?.shield, g);
  put('hp.current', 'Current hit points', hp.current ?? '', g); put('hp.temp', 'Temporary hit points', hp.temp || '', g); put('hp.max', 'Hit point maximum', hp.max ?? '', g);
  put('hitdice.spent', 'Hit dice spent', d.hitDice?.spent || 0, g); put('hitdice.max', 'Hit dice', `${level}d${c.hitDie || 8}`, g);
  put('death.success', 'Death save successes', num(d.deathSaves?.success), g); put('death.failure', 'Death save failures', num(d.deathSaves?.failure), g);
  put('pb', 'Proficiency bonus', fmtMod(pb), g); put('initiative', 'Initiative', fmtMod(mod(abs.dex) + num(d.initiativeBonus)), g);
  put('speed', 'Speed', `${d.speed ?? 30} ft`, g); put('size', 'Size', d.species?.size || 'Medium', g);
  put('passive', 'Passive perception', passivePerception({ ...d, abilities: abs }, pb), g); put('inspiration', 'Heroic inspiration', !!d.inspiration, g);
  g = 'Abilities';
  for (const a of ABILITIES) {
    const on = !!d.saves?.includes(a), m = mod(abs[a]);
    put(`${a}.score`, `${ABILITY_NAMES[a]} score`, abs[a] ?? 10, g); put(`${a}.mod`, `${ABILITY_NAMES[a]} modifier`, fmtMod(m), g);
    put(`${a}.save`, `${ABILITY_NAMES[a]} saving throw`, fmtMod(m + (on ? pb : 0)), g); put(`${a}.save.prof`, `${ABILITY_NAMES[a]} save proficiency`, on, g);
  }
  g = 'Skills';
  for (const [skill] of SKILLS) {
    const entry = (d.skills || []).find((s) => s.key === skill);
    put(`skill.${skill}`, skill, fmtMod(skillBonus(d, skill, pb)), g); put(`skill.${skill}.prof`, `${skill} proficiency`, !!entry, g);
  }
  g = 'Weapons & damage cantrips';
  const attacks = d.attacks || [];
  for (let i = 0; i < 6; i++) {
    const a = attacks[i] || {};
    put(`attack.${i}.name`, `Attack ${i + 1} name`, a.name, g);
    put(`attack.${i}.bonus`, `Attack ${i + 1} bonus or DC`, a.name ? (typeof a.bonus === 'number' ? fmtMod(a.bonus) : str(a.bonus)) : '', g);
    put(`attack.${i}.damage`, `Attack ${i + 1} damage`, a.damage, g); put(`attack.${i}.notes`, `Attack ${i + 1} notes`, a.notes, g);
  }
  g = 'Features';
  const features = d.features || [];
  const isFeat = (f) => /feat/i.test(f.source || '') || f.kind === 'feat';
  const isSpecies = (f) => (d.species?.name && (f.source || '').includes(d.species.name)) || /species|lineage|trait/i.test(f.source || '');
  const classFeats = features.filter((f) => !isFeat(f) && !isSpecies(f)).map((f) => f.name);
  const half = Math.ceil(classFeats.length / 2);
  put('features.class', 'Class features', classFeats.join('\n'), g);
  put('features.class.a', 'Class features (first column)', classFeats.slice(0, half).join('\n'), g);
  put('features.class.b', 'Class features (second column)', classFeats.slice(half).join('\n'), g);
  put('features.species', 'Species traits', features.filter((f) => !isFeat(f) && isSpecies(f)).map((f) => f.name).join('\n'), g);
  put('feats', 'Feats', features.filter(isFeat).map((f) => f.name).join('\n'), g);
  g = 'Proficiencies';
  const armor = (d.proficiencies?.armor || []).map((s) => String(s).toLowerCase());
  for (const [k, label] of [['light', 'Light armor'], ['medium', 'Medium armor'], ['heavy', 'Heavy armor'], ['shield', 'Shields']]) put(`armor.${k}`, `${label} training`, armor.some((a) => a.includes(k)), g);
  put('prof.weapons', 'Weapon proficiencies', (d.proficiencies?.weapons || []).join(', '), g); put('prof.tools', 'Tool proficiencies', (d.proficiencies?.tools || []).join(', '), g);
  put('languages', 'Languages', (d.languages || []).join(', '), g);
  g = 'Spellcasting';
  const sc = d.spellcasting || {};
  put('spell.ability', 'Spellcasting ability', sc.ability ? ABILITY_NAMES[sc.ability] || String(sc.ability).toUpperCase() : '', g);
  put('spell.mod', 'Spellcasting modifier', sc.ability ? fmtMod(mod(abs[sc.ability])) : '', g);
  put('spell.dc', 'Spell save DC', sc.dc ?? '', g); put('spell.attack', 'Spell attack bonus', sc.attackBonus == null || sc.attackBonus === '' ? '' : fmtMod(num(sc.attackBonus)), g);
  for (let lvl = 1; lvl <= 9; lvl++) {
    const s = sc.slots?.[lvl] || {};
    put(`slots.${lvl}.total`, `Level ${lvl} slots`, s.max || '', g); put(`slots.${lvl}.used`, `Level ${lvl} slots expended`, num(s.used), g);
  }
  const spells = spellList(d);
  for (let i = 0; i < 30; i++) {
    const s = spells[i];
    put(`spells.${i}.level`, `Spell ${i + 1} level`, s ? (s.level === 0 ? 'C' : str(s.level ?? '')) : '', g);
    put(`spells.${i}.name`, `Spell ${i + 1} name`, s?.name, g); put(`spells.${i}.time`, `Spell ${i + 1} casting time`, shortTime(s?.castingTime), g);
    put(`spells.${i}.range`, `Spell ${i + 1} range`, s?.range, g); put(`spells.${i}.c`, `Spell ${i + 1} concentration`, !!s?.concentration, g);
    put(`spells.${i}.r`, `Spell ${i + 1} ritual`, !!s?.ritual, g); put(`spells.${i}.m`, `Spell ${i + 1} material`, /\bM\b/.test(s?.components || ''), g);
    put(`spells.${i}.notes`, `Spell ${i + 1} notes`, s?.note, g);
  }
  put('spells.all', 'All spells', spells.map((s) => `${s.level === 0 ? 'Cantrip' : `L${s.level ?? '?'}`} ${s.name}`).join('\n'), g);
  g = 'Story & gear';
  const personality = Object.entries(d.personality || {}).filter(([, v]) => str(v).trim()).map(([k, v]) => `${cap(k)}: ${v}`).join('\n');
  put('appearance', 'Appearance', d.appearance, g); put('backstory', 'Backstory & personality', [personality, d.backstory || ''].filter(Boolean).join('\n'), g);
  put('equipment', 'Equipment', (d.equipment || []).map((e) => `${(e.qty || 1) > 1 ? `${e.qty} × ` : ''}${e.name}`).join('\n'), g);
  for (let i = 0; i < 3; i++) { put(`attuned.${i}`, `Attuned item ${i + 1}`, d.attuned?.[i] || '', g); put(`attuned.${i}.on`, `Attuned item ${i + 1} marked`, !!d.attuned?.[i], g); }
  for (const k of ['cp', 'sp', 'ep', 'gp', 'pp']) put(`coins.${k}`, k.toUpperCase(), d.coins?.[k] ?? '', g);
  put('notes', 'Notes', d.notes, g);
  return values;
}

function vtmValues(d, name) {
  const { values, put } = valueSet();
  const a = d.attributes || {}, sk = d.skills || {};
  let g = 'Identity';
  for (const [k, label, v] of [['name', 'Name', name], ['concept', 'Concept', d.concept], ['predator', 'Predator type', d.predatorType], ['chronicle', 'Chronicle', d.chronicle],
    ['ambition', 'Ambition', d.ambition], ['clan', 'Clan', d.clan], ['sire', 'Sire', d.sire], ['desire', 'Desire', d.desire], ['generation', 'Generation', d.generation ? `${d.generation}th` : '']]) put(k, label, v, g);
  g = 'Attributes';
  for (const [, keys] of V5_ATTRS) for (const k of keys) put(`attr.${k}`, cap(k), num(a[k], 1), g);
  g = 'Skills';
  for (const [, names] of V5_SKILLS) for (const s of names) {
    put(`skill.${s}`, s, num(sk[s]), g);
    put(`spec.${s}`, `${s} specialties`, (d.specialties || []).filter((x) => x.skill === s).map((x) => x.name).join(', '), g);
  }
  g = 'Trackers';
  const health = num(a.stamina, 1) + 3, wp = num(a.composure, 1) + num(a.resolve, 1);
  for (const [key, label, max, track] of [['health', 'Health', health, d.health || {}], ['willpower', 'Willpower', wp, d.willpower || {}]]) {
    const agg = num(track.aggravated), sup = num(track.superficial);
    put(`${key}.max`, `${label} maximum`, max, g);
    for (let i = 1; i <= 10; i++) put(`${key}.box.${i}`, `${label} box ${i}`, i > max ? '' : i <= agg ? 'X' : i <= agg + sup ? '/' : '', g);
  }
  put('hunger', 'Hunger', num(d.hunger), g); put('humanity', 'Humanity', num(d.humanity, 7), g); put('resonance', 'Resonance', d.resonance, g);
  g = 'Disciplines';
  for (let i = 0; i < 6; i++) {
    const x = (d.disciplines || [])[i];
    put(`disc.${i + 1}.name`, `Discipline ${i + 1}`, x?.name, g); put(`disc.${i + 1}.rating`, `Discipline ${i + 1} rating`, num(x?.rating), g);
    for (let k = 0; k < 5; k++) put(`disc.${i + 1}.power.${k + 1}`, `Discipline ${i + 1} power ${k + 1}`, x?.powers?.[k]?.name, g);
  }
  g = 'Chronicle';
  const touch = (d.convictions || []).map((cv, i) => `${cv}${d.touchstones?.[i]?.name ? ` — ${d.touchstones[i].name}` : ''}`)
    .concat((d.touchstones || []).slice((d.convictions || []).length).map((t) => t.name)).join('\n');
  put('tenets', 'Chronicle tenets', d.tenets, g); put('touchstones', 'Touchstones & convictions', touch, g); put('bane', 'Clan bane', d.bane, g);
  g = 'Advantages & flaws';
  const adv = d.advantages || [];
  const rows = adv.filter((x) => !x.flaw).concat(adv.filter((x) => x.flaw));
  for (let i = 0; i < 11; i++) {
    const x = rows[i];
    put(`adv.${i + 1}.name`, `Advantage or flaw ${i + 1}`, x ? (x.flaw ? `${x.name} (flaw)` : x.name) : '', g);
    put(`adv.${i + 1}.dots`, `Advantage or flaw ${i + 1} dots`, num(x?.dots), g);
  }
  g = 'Blood';
  put('potency', 'Blood potency', num(d.bloodPotency, 1), g);
  for (const [k, label] of [['bloodSurge', 'Blood surge'], ['mendAmount', 'Mend amount'], ['powerBonus', 'Power bonus'], ['rouseReroll', 'Rouse re-roll'], ['feedingPenalty', 'Feeding penalty'], ['baneSeverity', 'Bane severity']]) put(k, label, d[k], g);
  g = 'Story';
  put('xp.total', 'Total experience', d.xp?.total ?? 0, g); put('xp.spent', 'Spent experience', d.xp?.spent ?? 0, g);
  for (const [k, label] of [['trueAge', 'True age'], ['apparentAge', 'Apparent age'], ['dateOfBirth', 'Date of birth'], ['dateOfDeath', 'Date of death'], ['appearance', 'Appearance'], ['features', 'Distinguishing features'], ['history', 'History'], ['notes', 'Notes']]) put(k, label, d[k], g);
  return values;
}

// Call of Cthulhu skills: catalog names, and the groups whose specialisms
// fill a sheet's blank rows ("Science (Chemistry)" -> a Science row)
export const COC_GROUPS = [['Art/Craft', /^art\s*\/\s*craft\b/i], ['Fighting', /^fighting\b(?!\s*\(brawl\))/i], ['Firearms', /^firearms\b(?!\s*\((handgun|rifle\/shotgun)\))/i],
  ['Language', /^language\s*\((?!own\b)/i], ['Science', /^science\b/i], ['Pilot', /^pilot\b/i], ['Survival', /^survival\b/i]];
const specName = (name) => (String(name).match(/\(([^)]*)\)\s*$/) || [])[1] || '';

function cocValues(d, name) {
  const { values, put } = valueSet();
  const ch = d.characteristics || {};
  let g = 'Investigator';
  for (const [k, label, v] of [['name', 'Name', name], ['player', 'Player', d.player], ['occupation', 'Occupation', d.occupation?.name], ['age', 'Age', d.age],
    ['sex', 'Sex / pronouns', d.sex], ['residence', 'Residence', d.residence], ['birthplace', 'Birthplace', d.birthplace]]) put(k, label, v, g);
  g = 'Characteristics';
  for (const k of ['STR', 'CON', 'SIZ', 'DEX', 'APP', 'INT', 'POW', 'EDU']) {
    const v = num(ch[k]);
    put(`char.${k}`, k, v, g); put(`char.${k}.half`, `${k} half`, Math.floor(v / 2), g); put(`char.${k}.fifth`, `${k} fifth`, Math.floor(v / 5), g);
  }
  g = 'Attributes';
  put('hp.max', 'Hit points maximum', d.hp?.max ?? '', g); put('hp.current', 'Current hit points', d.hp?.current ?? '', g);
  put('mp.max', 'Magic points maximum', d.mp?.max ?? '', g); put('mp.current', 'Current magic points', d.mp?.current ?? '', g);
  put('luck.start', 'Starting luck', d.luckStart ?? d.luck ?? '', g); put('luck', 'Current luck', d.luck ?? '', g);
  put('san.start', 'Starting sanity', d.san?.start ?? '', g); put('san.current', 'Current sanity', d.san?.current ?? '', g);
  put('san.max', 'Maximum sanity', d.san?.max ?? 99, g); put('san.insane', 'Indefinite insanity threshold', d.san?.current != null ? Math.floor(num(d.san.current) / 5) : '', g);
  for (const [k, label] of [['tempInsane', 'Temporary insanity'], ['indefInsane', 'Indefinite insanity'], ['majorWound', 'Major wound'], ['unconscious', 'Unconscious'], ['dying', 'Dying']]) put(k, label, !!d[k], g);
  put('move', 'Move rate', d.move ?? 8, g); put('build', 'Build', d.build ?? 0, g); put('db', 'Damage bonus', d.damageBonus ?? '0', g);
  g = 'Skills';
  for (const s of d.skills || []) {
    const v = num(s.value);
    put(`skill.${s.name}`, s.name, v, g); put(`skill.${s.name}.half`, `${s.name} half`, Math.floor(v / 2), g);
    put(`skill.${s.name}.fifth`, `${s.name} fifth`, Math.floor(v / 5), g); put(`skill.${s.name}.improve`, `${s.name} improvement`, !!s.improve, g);
  }
  const dodge = num(d.skills?.find((s) => s.name === 'Dodge')?.value ?? d.dodge);
  put('dodge', 'Dodge', dodge, g); put('dodge.half', 'Dodge half', Math.floor(dodge / 2), g); put('dodge.fifth', 'Dodge fifth', Math.floor(dodge / 5), g);
  g = 'Weapons';
  const brawl = num(d.skills?.find((s) => s.name === 'Fighting (Brawl)')?.value, 25);
  put('unarmed', 'Unarmed', brawl, g); put('unarmed.half', 'Unarmed half', Math.floor(brawl / 2), g); put('unarmed.fifth', 'Unarmed fifth', Math.floor(brawl / 5), g);
  for (let i = 0; i < 6; i++) {
    const w = (d.weapons || [])[i], v = w ? num(w.skill) : null;
    put(`weapon.${i + 1}.name`, `Weapon ${i + 1}`, w?.name, g); put(`weapon.${i + 1}.regular`, `Weapon ${i + 1} regular`, v ?? '', g);
    put(`weapon.${i + 1}.hard`, `Weapon ${i + 1} hard`, v == null ? '' : Math.floor(v / 2), g); put(`weapon.${i + 1}.extreme`, `Weapon ${i + 1} extreme`, v == null ? '' : Math.floor(v / 5), g);
    for (const [k, label] of [['damage', 'damage'], ['range', 'range'], ['attacks', 'attacks'], ['ammo', 'ammo'], ['malf', 'malfunction']]) put(`weapon.${i + 1}.${k}`, `Weapon ${i + 1} ${label}`, w?.[k] ?? '', g);
  }
  g = 'Backstory';
  const b = d.backstory || {};
  for (const [k, label] of [['description', 'Personal description'], ['ideology', 'Ideology / beliefs'], ['significantPeople', 'Significant people'], ['meaningfulLocations', 'Meaningful locations'],
    ['treasuredPossessions', 'Treasured possessions'], ['traits', 'Traits'], ['injuries', 'Injuries & scars'], ['phobias', 'Phobias & manias'], ['tomes', 'Arcane tomes, spells & artifacts'], ['encounters', 'Encounters with strange entities'], ['story', 'My story']]) put(`back.${k}`, label, b[k], g);
  g = 'Possessions';
  const gear = (d.gear || []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
  put('gear', 'Gear & possessions', gear.join('\n'), g);
  put('gear.a', 'Gear (first column)', gear.slice(0, Math.ceil(gear.length / 2)).join('\n'), g); put('gear.b', 'Gear (second column)', gear.slice(Math.ceil(gear.length / 2)).join('\n'), g);
  put('spending', 'Spending level', d.spendingLevel, g); put('cash', 'Cash', d.cash, g); put('assets', 'Assets', d.assets, g);
  for (let i = 0; i < 6; i++) {
    const [char, player] = str((d.fellows || [])[i]).split(/\s+[—-]\s+/);
    put(`fellow.${i + 1}.char`, `Fellow investigator ${i + 1}`, char || '', g); put(`fellow.${i + 1}.player`, `Fellow investigator ${i + 1} player`, player || '', g);
  }
  put('notes', 'Notes', d.notes, g);
  return values;
}

/** One character's sheet data as flat labelled values: key -> { label, value, group }. */
export function sheetValues(system, data, name = '') {
  const d = data || {};
  if (system === 'dnd2024') return dndValues(d, name);
  if (system === 'vtm5') return vtmValues(d, name);
  if (system === 'coc7') return cocValues(d, name);
  return new Map();
}

// ---------- built-in maps ----------

function dndOfficial() {
  const f = {
    Text1: 'name', Text6: 'background', Text7: 'class', Text8: 'species', Text9: 'subclass', Text11: 'level', Text12: 'xp', Text13: 'ac', 'Check Box3': 'shield',
    Text14: 'hp.current', Text15: 'hp.temp', Text16: 'hp.max', Text18: 'hitdice.spent', Text17: 'hitdice.max',
    'Check Box5': ['death.success', 1], 'Check Box6': ['death.success', 2], 'Check Box7': ['death.success', 3],
    'Check Box8': ['death.failure', 1], 'Check Box9': ['death.failure', 2], 'Check Box10': ['death.failure', 3],
    Text19: 'pb', Text26: 'initiative', Text27: 'speed', Text28: 'size', Text29: 'passive', 'Check Box11': 'inspiration',
    Text54: 'features.class.a', Text55: 'features.class.b', Text57: 'features.species', Text58: 'feats',
    'Check Box13': 'armor.light', 'Check Box14': 'armor.medium', 'Check Box15': 'armor.heavy', 'Check Box12': 'armor.shield',
    Text59: 'prof.weapons', Text60: 'prof.tools',
    Text111: 'spell.ability', Text93: 'spell.mod', Text94: 'spell.dc', Text95: 'spell.attack',
    Text96: 'appearance', Text97: 'backstory', Text100: 'alignment', Text98: 'languages', Text99: 'equipment',
    Text226: 'coins.cp', Text267: 'coins.sp', Text268: 'coins.ep', Text269: 'coins.gp', Text270: 'coins.pp',
  };
  // ability blocks: [modifier, score, save box, save value, skills [box, value, name]...]
  const blocks = {
    str: ['Text21', 'Text64', 'Check Box37', 'Text91', [['Check Box38', 'Text92', 'Athletics']]],
    dex: ['Text22', 'Text66', 'Check Box33', 'Text87', [['Check Box34', 'Text88', 'Acrobatics'], ['Check Box35', 'Text89', 'Sleight of Hand'], ['Check Box36', 'Text90', 'Stealth']]],
    con: ['Text24', 'Text67', 'Check Box32', 'Text86', []],
    int: ['Text20', 'Text63', 'Check Box4', 'Text69', [['Check Box16', 'Text70', 'Arcana'], ['Check Box17', 'Text71', 'History'], ['Check Box19', 'Text72', 'Investigation'], ['Check Box20', 'Text73', 'Nature'], ['Check Box18', 'Text74', 'Religion']]],
    wis: ['Text23', 'Text65', 'Check Box21', 'Text75', [['Check Box22', 'Text76', 'Animal Handling'], ['Check Box23', 'Text77', 'Insight'], ['Check Box25', 'Text78', 'Medicine'], ['Check Box31', 'Text79', 'Perception'], ['Check Box24', 'Text80', 'Survival']]],
    cha: ['Text25', 'Text68', 'Check Box26', 'Text81', [['Check Box27', 'Text82', 'Deception'], ['Check Box28', 'Text83', 'Intimidation'], ['Check Box30', 'Text84', 'Performance'], ['Check Box29', 'Text85', 'Persuasion']]],
  };
  for (const [a, [m, score, box, save, skills]] of Object.entries(blocks)) {
    f[m] = `${a}.mod`; f[score] = `${a}.score`; f[box] = `${a}.save.prof`; f[save] = `${a}.save`;
    for (const [sb, sv, skill] of skills) { f[sb] = `skill.${skill}.prof`; f[sv] = `skill.${skill}`; }
  }
  for (let i = 0; i < 6; i++) ['name', 'bonus', 'damage', 'notes'].forEach((k, c) => { f[`Text${30 + i * 4 + c}`] = `attack.${i}.${k}`; });
  // spell slots: totals and expended diamonds, in the sheet's order
  [[1, 'Text112', [227, 228, 229, 230]], [2, 'Text113', [231, 232, 233]], [3, 'Text114', [234, 235, 236]], [4, 'Text117', [237, 238, 239]], [5, 'Text116', [240, 241, 242]],
    [6, 'Text115', [243, 244]], [7, 'Text118', [245, 246]], [8, 'Text119', [247]], [9, 'Text120', [248]]].forEach(([lvl, total, boxes]) => {
    f[total] = `slots.${lvl}.total`;
    boxes.forEach((n, k) => { f[`Check Box${n}`] = [`slots.${lvl}.used`, k + 1]; });
  });
  // thirty spell rows; the C/R/M boxes come in three numbered runs
  const notes = [108, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 227, 228, 229, 230, 244, 231, 232, 233, 234, 235, 236];
  for (let i = 0; i < 30; i++) {
    f[`Text105.${i}`] = `spells.${i}.level`; f[`Text106.${i}`] = `spells.${i}.name`; f[`Text107.${i}`] = `spells.${i}.time`; f[`Text109.${i}`] = `spells.${i}.range`;
    f[`Text${notes[i]}`] = `spells.${i}.notes`;
    const [c, r, m, k] = i < 7 ? ['Check Box252', 'Check Box253', 'Check Box254.0', i] : i < 20 ? ['Check Box255', 'Check Box256', 'Check Box257', i - 7] : ['Check Box258', 'Check Box259', 'Check Box260', i - 20];
    f[`${c}.${k}`] = `spells.${i}.c`; f[`${r}.${k}`] = `spells.${i}.r`; f[`${m}.${k}`] = `spells.${i}.m`;
  }
  ['Text101', 'Text102', 'Text103'].forEach((t, i) => { f[t] = `attuned.${i}`; f[`Check Box${249 + i}`] = `attuned.${i}.on`; });
  return f;
}

function vtmOfficial() {
  const f = { Name: 'name', Concept: 'concept', Predator: 'predator', Chronicle: 'chronicle', Ambition: 'ambition', Clan: 'clan', Sire: 'sire', Desire: 'desire', Generation: 'generation',
    Resonance: 'resonance', 'Chronicle Tenets': 'tenets', 'Touchstones Convictions': 'touchstones', 'Clan Banes': 'bane', Notes: 'notes',
    'Blood Surge': 'bloodSurge', 'Mend Amount': 'mendAmount', 'Power Bonus': 'powerBonus', 'Rouse ReRoll': 'rouseReroll', 'Feeding Penalty': 'feedingPenalty', 'Bane Severity': 'baneSeverity',
    totalxp: 'xp.total', spentxp: 'xp.spent', 'True age': 'trueAge', 'Apparent Age': 'apparentAge', 'Date of Birth': 'dateOfBirth', 'Date of Death': 'dateOfDeath',
    Appearance: 'appearance', 'Distinguishing features': 'features', History: 'history' };
  for (const [, keys] of V5_ATTRS) for (const k of keys) for (let n = 1; n <= 5; n++) f[`${k}${n}`] = [`attr.${k}`, n];
  for (const [, names] of V5_SKILLS) for (const s of names) for (let n = 1; n <= 5; n++) f[`${s.toLowerCase().replace(/\s+/g, '')}${n}`] = [`skill.${s}`, n];
  // the specialty line after each skill, by its position on the sheet
  const spec = { 'AT.0.0.0': 'Athletics', 'AT.0.1': 'Animal Ken', 'AT.1.0': 'Academics', 'AT.1.1.0': 'Brawl', 'AT.0.0.1': 'Etiquette', 'AT.1.1.2.1': 'Awareness',
    'AT.0.0.2': 'Craft', 'AT.1.1.2.0': 'Insight', 'AT.1.1.1': 'Finance', 'AT.0.0.3': 'Drive', 'AT.1.1.2.2': 'Intimidation', 'AT.1.1.2.3': 'Investigation',
    'AT.1.1.3': 'Firearms', 'AT.1.1.2.5': 'Leadership', 'AT.1.1.2.4': 'Medicine', 'AT.0.0.4': 'Larceny', 'AT.1.1.2.7': 'Performance', 'AT.1.1.2.6': 'Occult',
    'AT.1.1.4': 'Melee', 'AT.1.1.2.9': 'Persuasion', 'AT.1.1.2.8': 'Politics', 'AT.0.0.5': 'Stealth', 'AT.1.1.2.12': 'Streetwise', 'AT.1.1.2.10': 'Science',
    'AT.1.1.5': 'Survival', 'AT.1.1.2.14': 'Subterfuge', 'AT.1.1.2.13': 'Technology' };
  for (const [field, skill] of Object.entries(spec)) f[field] = `spec.${skill}`;
  for (let i = 1; i <= 10; i++) { f[`health${i}`] = `health.box.${i}`; f[`will${i}`] = `willpower.box.${i}`; f[`potency${i}`] = ['potency', i]; f[`Button7.${i - 1}`] = ['humanity', i]; }
  for (let n = 1; n <= 5; n++) f[`hunger${n}`] = ['hunger', n];
  for (let i = 1; i <= 6; i++) {
    f[`Main${i}`] = `disc.${i}.name`;
    for (let n = 1; n <= 5; n++) { f[`main${i}-${n}`] = [`disc.${i}.rating`, n]; f[i === 1 ? `Row${n}` : `Row${n}_${i}`] = `disc.${i}.power.${n}`; }
  }
  for (let i = 1; i <= 11; i++) { f[`adflaw${i}`] = `adv.${i}.name`; for (let n = 1; n <= 5; n++) f[`adflaw${i}-${n}`] = [`adv.${i}.dots`, n]; }
  // the fifth dot of row 5 is a second widget of "adflaw1-5" on this sheet, so
  // it shows whatever row 1's fifth dot shows
  delete f['adflaw5-5'];
  return f;
}

// Call of Cthulhu sheets: fixed skill fields plus slots for specialisms and
// anything else. A slot is [name field, value field, half, fifth, tick box].
function cocChaosium1920s() {
  const f = { investigator_name: 'name', investigator_occupation: 'occupation', investigator_age: 'age', investigator_gender: 'sex', investigator_residence: 'residence', investigator_birthplace: 'birthplace',
    attribute_hit_point_max: 'hp.max', attribute_hit_point_current: 'hp.current', attribute_magic_points_max: 'mp.max', attribute_magic_points_current: 'mp.current',
    attribute_luck_starting: 'luck.start', attribute_luck_current: 'luck', attribute_sanity_starting: 'san.start', attribute_sanity_current: 'san.current',
    attribute_sanity_insane: 'san.insane', attribute_sanity_max: 'san.max', attribute_sanity_temporary_insanity_check: 'tempInsane', attribute_sanity_indefinite_insanity_check: 'indefInsane',
    attribute_major_wound_check: 'majorWound', attribute_unconsious_check: 'unconscious', attribute_dying_check: 'dying',
    attribute_move: 'move', attribute_build: 'build', attribute_damage_bonus: 'db', skill_dodge: 'dodge', skill_dodge_half: 'dodge.half', skill_dodge_fifth: 'dodge.fifth',
    background_personal_description: 'back.description', background_traits: 'back.traits', background_ideology_beliefs: 'back.ideology', background_injuries: 'back.injuries',
    background_significant_people: 'back.significantPeople', background_phobias_manias: 'back.phobias', background_meaningful_locations: 'back.meaningfulLocations',
    background_tomes_spells: 'back.tomes', background_possessions: 'back.treasuredPossessions', background_encounters_with_strange_entities: 'back.encounters', background_my_story_1: 'back.story',
    resources_gear_posessions_1: 'gear.a', resources_gear_posessions_2: 'gear.b', resources_spending_level: 'spending', resources_cash: 'cash', resources_assets: 'assets' };
  for (const k of ['STR', 'CON', 'DEX', 'INT', 'SIZ', 'POW', 'APP', 'EDU']) { const l = k.toLowerCase(); f[`characteristic_${l}`] = `char.${k}`; f[`characteristic_${l}_half`] = `char.${k}.half`; f[`characteristic_${l}_fifth`] = `char.${k}.fifth`; }
  for (let i = 1; i <= 6; i++) { f[`associates_character_${i}_name`] = `fellow.${i}.char`; f[`associates_player_${i}_name`] = `fellow.${i}.player`; }
  for (let i = 1; i <= 3; i++) {
    f[`weapon_${i}_name`] = `weapon.${i}.name`; f[`weapon_${i}`] = `weapon.${i}.regular`; f[`weapon_${i}_half`] = `weapon.${i}.hard`; f[`weapon_${i}_fifth`] = `weapon.${i}.extreme`;
    f[`weapon_${i}_damage`] = `weapon.${i}.damage`; f[`weapon_${i}_number_of_attacks`] = `weapon.${i}.attacks`; f[`weapon_${i}_range`] = `weapon.${i}.range`; f[`weapon_${i}_ammo`] = `weapon.${i}.ammo`; f[`weapon_${i}_malfunction`] = `weapon.${i}.malf`;
  }
  const fixed = { Accounting: 'accounting', Anthropology: 'anthropology', Appraise: 'appraise', Archaeology: 'archaeology', Charm: 'charm', Climb: 'climb', 'Credit Rating': 'credit_rating',
    'Cthulhu Mythos': 'cthulhu_mythos', Disguise: 'disguise', 'Drive Auto': 'drive_auto', 'Electrical Repair': 'electrical_repair', 'Fast Talk': 'fast_talk', 'Fighting (Brawl)': 'fighting_brawl',
    'Firearms (Handgun)': 'firearms_handgun', 'Firearms (Rifle/Shotgun)': 'firearms_rifle_shotgun', 'First Aid': 'first_aid', History: 'history', Intimidate: 'intimidate', Jump: 'jump',
    'Language (Own)': 'language_own', Law: 'law', 'Library Use': 'library_use', Listen: 'listen', Locksmith: 'locksmith', 'Mechanical Repair': 'mechanical_repair', Medicine: 'medicine',
    'Natural World': 'natural_world', Navigate: 'navigate', Occult: 'occult', Persuade: 'persuade', Psychoanalysis: 'psychoanalysis', Psychology: 'psychology', Ride: 'ride',
    'Sleight of Hand': 'sleight_of_hand', 'Spot Hidden': 'spot_hidden', Stealth: 'stealth', Swim: 'swim', Throw: 'throw', Track: 'track' };
  for (const [skill, slug] of Object.entries(fixed)) {
    f[`skill_${slug}`] = `skill.${skill}`; f[`skill_${slug}_half`] = `skill.${skill}.half`; f[`skill_${slug}_fifth`] = `skill.${skill}.fifth`;
    if (skill !== 'Credit Rating' && skill !== 'Cthulhu Mythos') f[`skill_${slug}_check`] = `skill.${skill}.improve`;
  }
  f.skill_dodge_check = 'skill.Dodge.improve';
  const slot = (base, check = `${base}_check`) => [`${base}_name`, base, `${base}_half`, `${base}_fifth`, check];
  const slots = {
    'Art/Craft': [slot('skill_art_craft_1'), slot('skill_art_craft_2')],
    Fighting: [slot('skill_fighting_1', 'skill_skill_fighting_1_check'), slot('skill_fighting_2')],
    Firearms: [slot('skill_firearms_1')],
    Language: [slot('skill_language_other_1'), slot('skill_language_other_2'), slot('skill_language_other_3')],
    Science: [slot('skill_science_1'), slot('skill_science_2'), slot('skill_science_3')],
    Pilot: [slot('skill_pilot')], Survival: [slot('skill_survival')],
    other: [1, 2, 3, 4].map((i) => slot(`skill_custom_${i}`)),
  };
  return { fields: f, slots };
}

function cocChaosiumModern() {
  const f = { Investigators_Name: 'name', Occupation: 'occupation', Age: 'age', Pronouns: 'sex', Residence: 'residence', Birthplace: 'birthplace',
    StartingHP: 'hp.max', CurrentHP: 'hp.current', StartingMagic: 'mp.max', CurrentMagic: 'mp.current', StartingLuck: 'luck.start', CurrentLuck: 'luck',
    StartingSanity: 'san.start', CurrentSanity: 'san.current', InsaneSanity: 'san.insane', MaxSanity: 'san.max',
    TempInsanity_Chk: 'tempInsane', IndefInsanity_Chk: 'indefInsane', MajorWound_Chk: 'majorWound', Unconscious_Chk: 'unconscious', Dying_Chk: 'dying',
    MOV: 'move', Build: 'build', DamageBonus: 'db', Dodge_Copy: 'dodge', Dodge_Copy_half: 'dodge.half', Dodge_Copy_fifth: 'dodge.fifth',
    Weapon_Regular0: 'unarmed', Weapon_Hard0: 'unarmed.half', Weapon_Extreme0: 'unarmed.fifth',
    PersonalDescription: 'back.description', Traits: 'back.traits', 'Ideology/Beliefs': 'back.ideology', 'Significant People': 'back.significantPeople', Locations: 'back.meaningfulLocations',
    Possessions: 'back.treasuredPossessions', Injuries: 'back.injuries', 'Phobias/Manias': 'back.phobias', 'Tomes/Spells': 'back.tomes', Encounters: 'back.encounters', MyStory: 'back.story',
    'Gear/Possessions': 'gear.a', 'Gear/Possessions1': 'gear.b', SpendingLevel: 'spending', Cash: 'cash', Assets1: 'assets', ExtraText: 'notes' };
  for (const k of ['STR', 'CON', 'DEX', 'INT', 'SIZ', 'POW', 'APP', 'EDU']) { f[k] = `char.${k}`; f[`${k}_half`] = `char.${k}.half`; f[`${k}_fifth`] = `char.${k}.fifth`; }
  for (let i = 1; i <= 6; i++) { f[`Character_Name${i}`] = `fellow.${i}.char`; f[`Character_Player${i}`] = `fellow.${i}.player`; }
  for (let i = 1; i <= 3; i++) {
    f[`Weapon_Name${i}`] = `weapon.${i}.name`; f[`Weapon_Regular${i}`] = `weapon.${i}.regular`; f[`Weapon_Hard${i}`] = `weapon.${i}.hard`; f[`Weapon_Extreme${i}`] = `weapon.${i}.extreme`;
    f[`Weapon_Damage${i}`] = `weapon.${i}.damage`; f[`Weapon_Range${i}`] = `weapon.${i}.range`; f[`Weapon_Attacks${i}`] = `weapon.${i}.attacks`; f[`Weapon_Ammo${i}`] = `weapon.${i}.ammo`; f[`Weapon_Malf${i}`] = `weapon.${i}.malf`;
  }
  const fixed = { Accounting: 'Accounting', Anthropology: 'Anthropology', Appraise: 'Appraise', Archaeology: 'Archaeology', Charm: 'Charm', Climb: 'Climb', 'Credit Rating': 'Credit',
    'Cthulhu Mythos': 'Cthulhu', Disguise: 'Disguise', Dodge: 'Dodge', 'Drive Auto': 'Drive', 'Electrical Repair': 'ElecRepair', 'Fast Talk': 'FastTalk', 'Fighting (Brawl)': 'Fighting',
    'Firearms (Handgun)': 'FireArmsHandguns', 'Firearms (Rifle/Shotgun)': 'FireArmsRifles', 'First Aid': 'FirstAid', History: 'History', Intimidate: 'Intimidate', Jump: 'Jump',
    'Language (Own)': 'OwnLanguage', Law: 'Law', 'Library Use': 'LibraryUse', Listen: 'Listen', Locksmith: 'Locksmith', 'Mechanical Repair': 'MechRepair', Medicine: 'Medicine',
    'Natural World': 'NaturalWorld', Navigate: 'Navigate', Occult: 'Occult', Persuade: 'Persuade', Psychoanalysis: 'Psychoanalysis', Psychology: 'Psychology', Ride: 'Ride',
    'Sleight of Hand': 'Sleight', 'Spot Hidden': 'SpotHidden', Stealth: 'Stealth', Swim: 'Swim', Throw: 'Throw', Track: 'Track', 'Computer Use': 'Computer', Electronics: 'Electronic' };
  for (const [skill, slug] of Object.entries(fixed)) {
    f[`Skill_${slug}`] = `skill.${skill}`; f[`Skill_${slug}_half`] = `skill.${skill}.half`; f[`Skill_${slug}_fifth`] = `skill.${skill}.fifth`;
    if (skill !== 'Credit Rating' && skill !== 'Cthulhu Mythos') f[`Skill_${slug}_Chk`] = `skill.${skill}.improve`;
  }
  // the sheet names the Occult row's tick box after Religion
  delete f.Skill_Occult_Chk;
  f.Skill_Religion_Chk = 'skill.Occult.improve';
  const slot = (base) => [`SkillDef_${base}`, `Skill_${base}`, `Skill_${base}_half`, `Skill_${base}_fifth`, `Skill_${base}_Chk`];
  const slots = {
    'Art/Craft': [slot('ArtCraft1'), slot('ArtCraft2')], Fighting: [slot('Fighting1')], Firearms: [slot('Firearms')],
    Language: [slot('OtherLanguage'), slot('OtherLanguage1'), slot('OtherLanguage2')], Science: [slot('Science'), slot('Science1'), slot('Science2')],
    Pilot: [slot('Pilot')], Survival: [slot('Survival')], other: [slot('Custom1'), slot('Custom2'), slot('Custom3')],
  };
  return { fields: f, slots };
}

/**
 * The sheets MundusMaker knows field by field. Each was mapped against the
 * publisher's own file; a PDF is recognised when nearly all of a template's
 * field names are present, so a re-save that keeps the names still matches.
 */
export const TEMPLATES = [
  { id: 'dnd2024-wotc', system: 'dnd2024', label: 'D&D 2024 character sheet (Wizards of the Coast, free rules)', where: 'D&D Beyond’s free 2024 rules, “Character sheet”', fields: dndOfficial() },
  { id: 'vtm5-renegade', system: 'vtm5', label: 'Vampire: The Masquerade V5 fillable sheet (Renegade Game Studios)', where: 'the free download in the World of Darkness or Renegade store', fields: vtmOfficial() },
  { id: 'coc7-chaosium-1920s', system: 'coc7', label: 'Call of Cthulhu 7e investigator sheet, 1920s (Chaosium)', where: 'chaosium.com, Call of Cthulhu character sheets', ...cocChaosium1920s() },
  { id: 'coc7-chaosium-modern', system: 'coc7', label: 'Call of Cthulhu 7e investigator sheet, Modern (Chaosium)', where: 'chaosium.com, Call of Cthulhu character sheets', ...cocChaosiumModern() },
];

/** The built-in template whose field names this form carries, if any. */
export function recognize(system, form) {
  const names = new Set(form.fields.map((f) => f.name));
  let best = null;
  for (const t of TEMPLATES.filter((x) => x.system === system)) {
    const wanted = Object.keys(t.fields);
    const share = wanted.filter((n) => names.has(n)).length / wanted.length;
    if (share >= 0.9 && (!best || share > best.share)) best = { template: t, share };
  }
  return best?.template || null;
}

// ---------- name matching for other sheets ----------

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = {
  dnd2024: { name: ['charactername', 'name', 'charname'], class: ['class', 'classlevel'], level: ['level', 'lvl'], background: ['background'], species: ['species', 'race'],
    alignment: ['alignment'], xp: ['xp', 'experience', 'experiencepoints'], ac: ['ac', 'armorclass'], initiative: ['initiative', 'init'], speed: ['speed'], pb: ['profbonus', 'proficiencybonus'],
    'hp.max': ['hpmax', 'maxhp', 'hitpointmaximum'], 'hp.current': ['hpcurrent', 'currenthp', 'currenthitpoints'], 'hp.temp': ['hptemp', 'temphp', 'temporaryhitpoints'],
    'hitdice.max': ['hdtotal', 'hitdice', 'hd'], passive: ['passive', 'passiveperception', 'passivewisdomperception'], languages: ['proficiencieslang', 'languages'],
    equipment: ['equipment'], 'features.class': ['featuresandtraits', 'features', 'classfeatures'], backstory: ['backstory', 'personalitytraits'], appearance: ['appearance'],
    'spell.ability': ['spellcastingability'], 'spell.dc': ['spellsavedc'], 'spell.attack': ['spellatkbonus', 'spellattackbonus'],
    'coins.cp': ['cp'], 'coins.sp': ['sp'], 'coins.ep': ['ep'], 'coins.gp': ['gp'], 'coins.pp': ['pp'] },
  vtm5: { name: ['name'], concept: ['concept'], predator: ['predator', 'predatortype'], chronicle: ['chronicle'], ambition: ['ambition'], clan: ['clan'], sire: ['sire'], desire: ['desire'],
    generation: ['generation'], resonance: ['resonance'], tenets: ['chronicletenets', 'tenets'], touchstones: ['touchstonesconvictions', 'touchstones'], bane: ['clanbane', 'clanbanes', 'bane'],
    history: ['history'], notes: ['notes'], appearance: ['appearance'], features: ['distinguishingfeatures'] },
  coc7: { name: ['name', 'investigatorname', 'investigatorsname'], occupation: ['occupation'], age: ['age'], sex: ['sex', 'gender', 'pronouns'], residence: ['residence'], birthplace: ['birthplace'],
    player: ['player', 'playername'], 'hp.current': ['currenthp', 'hitpointscurrent', 'hpcurrent'], 'hp.max': ['maxhp', 'hpmax', 'hitpointmax'], 'san.current': ['currentsanity', 'sanity'],
    'mp.current': ['currentmagic', 'magicpoints'], luck: ['currentluck', 'luck'], move: ['move', 'mov', 'moverate'], build: ['build'], db: ['damagebonus', 'db'], cash: ['cash'],
    spending: ['spendinglevel'], assets: ['assets'] },
};

/** A value key for a field of an unrecognised sheet, by its name, or ''. */
export function suggestKey(system, field, values) {
  const n = norm(field.name.split('.').pop());
  if (!n) return '';
  for (const [key, names] of Object.entries(ALIASES[system] || {})) if (names.includes(n) && values.has(key)) return key;
  // "Strength", "STR", "STRmod", "ST Strength", "Arcana" and the like
  for (const [key, entry] of values) {
    const label = norm(entry.label);
    if (label && label === n && (field.type === 'text') === (typeof entry.value !== 'boolean')) return key;
  }
  if (system === 'dnd2024') {
    for (const a of ABILITIES) {
      if (n === a) return `${a}.score`;
      if (n === `${a}mod`) return `${a}.mod`;
      if (n === `st${norm(ABILITY_NAMES[a])}`) return `${a}.save`;
    }
  }
  if (system === 'coc7') {
    const m = n.match(/^(str|con|siz|dex|app|int|pow|edu)(half|fifth)?$/);
    if (m) return `char.${m[1].toUpperCase()}${m[2] ? `.${m[2]}` : ''}`;
  }
  return '';
}

// ---------- the plan ----------

function valueFor(entry, values) {
  if (!entry) return undefined;
  const [key, atLeast] = Array.isArray(entry) ? entry : [entry, null];
  const v = values.get(key)?.value;
  if (atLeast != null) return num(v) >= atLeast;
  return v;
}

function cocSlotValues(template, data, values) {
  const out = {};
  if (!template.slots) return out;
  const bases = data.skillBases || {};
  const fixedKeys = new Set(Object.values(template.fields).filter((k) => typeof k === 'string' && k.startsWith('skill.') && !/\.(half|fifth|improve)$/.test(k)).map((k) => k.slice(6)));
  const groups = Object.fromEntries(Object.keys(template.slots).map((g) => [g, []]));
  for (const s of data.skills || []) {
    if (fixedKeys.has(s.name) || s.name === 'Dodge') continue;
    const group = COC_GROUPS.find(([, re]) => re.test(s.name))?.[0];
    const generic = group && (!specName(s.name) || /^other$/i.test(specName(s.name)));
    const untrained = bases[s.name] != null && num(s.value) <= num(bases[s.name], 0);
    // an untrained generic row ("Science 01%") only takes a slot when nothing better does
    if (generic && untrained) { (groups[group] ||= []).generic = s; continue; }
    // untrained skills the sheet has no row for stay off it, as on paper
    if (!group && untrained) continue;
    if (group && groups[group]) groups[group].push(generic ? { ...s, name: group } : s);
    else groups.other.push(s);
  }
  const put = (slot, s, label) => {
    const [nameF, valueF, halfF, fifthF, checkF] = slot, v = num(s.value);
    out[nameF] = label; out[valueF] = v; out[halfF] = Math.floor(v / 2); out[fifthF] = Math.floor(v / 5); if (checkF) out[checkF] = !!s.improve;
  };
  const overflow = [];
  for (const [group, slots] of Object.entries(template.slots)) {
    if (group === 'other') continue;
    const list = groups[group] || [];
    if (!list.length && list.generic) list.push(list.generic);
    list.forEach((s, i) => { if (i < slots.length) put(slots[i], s, specName(s.name)); else overflow.push(s); });
  }
  [...groups.other, ...overflow].forEach((s, i) => { if (i < template.slots.other.length) put(template.slots.other[i], s, s.name); });
  return out;
}

/**
 * What filling `form` would write: one row per field with the value key that
 * feeds it (built-in map, then the GM's own choices, then name matching) and
 * the value. `choices` maps field name -> value key, or '' to leave it blank.
 */
export function planFill(system, data, name, form, choices = {}) {
  const values = sheetValues(system, data, name);
  const template = recognize(system, form);
  const slotValues = template ? cocSlotValues(template, data || {}, values) : {};
  const rows = [];
  const fill = {};
  for (const field of form.fields) {
    if (field.type === 'signature' || field.type === 'unknown') continue;
    if (field.type === 'pushbutton' && !(template && template.fields[field.name])) continue;
    let entry = null, source = '', value;
    if (Object.prototype.hasOwnProperty.call(choices, field.name)) {
      entry = choices[field.name] || null; source = 'yours';
      value = entry ? valueFor(entry, values) : undefined;
    } else if (template && Object.prototype.hasOwnProperty.call(slotValues, field.name)) {
      source = 'built-in'; value = slotValues[field.name];
    } else if (template && template.fields[field.name]) {
      entry = template.fields[field.name]; source = 'built-in'; value = valueFor(entry, values);
    } else if (!template) {
      entry = suggestKey(system, field, values) || null; source = entry ? 'matched' : '';
      value = entry ? valueFor(entry, values) : undefined;
    }
    const key = Array.isArray(entry) ? entry[0] : entry;
    if (value !== undefined) {
      if (field.type === 'checkbox' || field.type === 'radio' || field.type === 'pushbutton') fill[field.name] = typeof value === 'boolean' ? value : num(value) > 0;
      else fill[field.name] = value === false || value === true ? '' : str(value);
      // nothing to write into a field that is already empty
      if (fill[field.name] === '' && !field.value) delete fill[field.name];
    }
    rows.push({ field: field.name, type: field.type, page: field.widgets[0]?.page ?? -1, key: key || '', atLeast: Array.isArray(entry) ? entry[1] : null, label: key ? values.get(key)?.label || key : '', value: fill[field.name], source });
  }
  return { template, values, rows, fill };
}
