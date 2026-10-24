// D&D character sheet PDFs (D&D Beyond's "Export to PDF", or a fillable sheet
// filled in by hand) read back into a dnd2024 sheet block. Pure: the form from
// pdfform.js readForm() in, sheet data and a report out. Nothing here writes;
// the Import page shows the report and the GM confirms first.
//
// officialsheets.js in reverse, in two steps:
//   readValues()  PDF fields -> flat value keys ("str.score", "skill.Arcana.mark"),
//                 through a known layout's field map or, for any other sheet,
//                 by field name;
//   buildSheet()  value keys -> sheet data. Only what the PDF carries is kept.
//                 Numbers MundusMaker works out itself (modifiers, saves, skill
//                 bonuses, passive Perception) are compared with the sheet's,
//                 and a disagreement is written into the notes, not dropped.
//
// D&D Beyond's export (checked against a real one, October 2026) uses its own
// version of the classic 5e layout for 2014 and 2024 characters alike. Its
// quirks: the fields sit on the pages with no AcroForm listing them (pdfform
// reads them anyway); proficiency is a text mark (saves "•"; skills P, E for
// expertise, H for half from Jack of All Trades); long text runs on across
// numbered boxes (FeaturesTraits1-6, Actions1-2), cut between words; and the
// spell table's levels are header rows ("=== 1st LEVEL ===", "4 Slots OOOO")
// placed between the spell rows, so spells are read in page order.

import { ABILITIES, ABILITY_NAMES, SKILLS, mod, fmtMod, profBonus, canonSkill, defaults, lower, skillBonus, passivePerception } from './dndrules.js';
import { TEMPLATES } from './officialsheets.js';

const str = (v) => (v == null ? '' : String(v)).trim();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const title = (s) => lower(s).replace(/\b\w/g, (c) => c.toUpperCase());
/** The leading whole number of a sheet value ("+5", "30 ft.", "−1"), or null. */
export function sheetNumber(v) {
  const m = str(v).replace(/[−–]/g, '-').match(/^([+-]?)\s*(\d+)/);
  return m ? Number(`${m[1]}${m[2]}`) : null;
}
const isBonus = (v) => /^[+\-−–]?\s*\d+$/.test(str(v));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- field names ----------

// Field names as the classic 5e fillable sheet and most fan-made sheets write
// them, compared without case, spaces or punctuation.
const BY_NAME = (() => {
  const m = {
    charactername: 'name', classlevel: 'classlevel', classandlevel: 'classlevel', class: 'class', level: 'level', subclass: 'subclass',
    background: 'background', race: 'species', species: 'species', alignment: 'alignment', xp: 'xp', experiencepoints: 'xp', playername: 'player',
    ac: 'ac', armorclass: 'ac', initiative: 'initiative', init: 'initiative', speed: 'speed', profbonus: 'pb', proficiencybonus: 'pb', size: 'size',
    hpmax: 'hp.max', maxhp: 'hp.max', hitpointmaximum: 'hp.max', hpcurrent: 'hp.current', currenthp: 'hp.current', currenthitpoints: 'hp.current',
    hptemp: 'hp.temp', temphp: 'hp.temp', temporaryhitpoints: 'hp.temp', hdtotal: 'hitdice.max', hd: 'hitdice.left', inspiration: 'inspiration',
    passive: 'passive', passiveperception: 'passive', passivewisdomperception: 'passive', passivewisdom: 'passive',
    proficiencieslang: 'prof.other', otherproficienciesandlanguages: 'prof.other', languages: 'languages', equipment: 'equipment',
    featuresandtraits: 'features', featurestraits: 'features', feattraits: 'features', attacksspellcasting: 'attacks.text',
    personalitytraits: 'personality.traits', ideals: 'personality.ideals', bonds: 'personality.bonds', flaws: 'personality.flaws',
    age: 'look.Age', height: 'look.Height', weight: 'look.Weight', eyes: 'look.Eyes', skin: 'look.Skin', hair: 'look.Hair',
    appearance: 'appearance', backstory: 'backstory', characterbackstory: 'backstory', allies: 'allies', alliesandorganizations: 'allies', factionname: 'faction', treasure: 'treasure',
    spellcastingclass: 'spell.class', spellcastingclass2: 'spell.class', spellcastingability: 'spell.ability', spellcastingability2: 'spell.ability',
    spellsavedc: 'spell.dc', spellsavedc2: 'spell.dc', spellatkbonus: 'spell.attack', spellatkbonus2: 'spell.attack', spellattackbonus: 'spell.attack',
    cp: 'coins.cp', sp: 'coins.sp', ep: 'coins.ep', gp: 'coins.gp', pp: 'coins.pp', notes: 'notes', additionalnotes: 'notes',
    wpnname: 'attack.0.name', wpn1atkbonus: 'attack.0.bonus', wpn1damage: 'attack.0.damage',
  };
  for (let i = 2; i <= 6; i++) Object.assign(m, { [`wpnname${i}`]: `attack.${i - 1}.name`, [`wpn${i}atkbonus`]: `attack.${i - 1}.bonus`, [`wpn${i}damage`]: `attack.${i - 1}.damage` });
  for (const a of ABILITIES) {
    const full = norm(ABILITY_NAMES[a]);
    Object.assign(m, { [a]: `${a}.score`, [full]: `${a}.score`, [`${a}mod`]: `${a}.mod`, [`${full}mod`]: `${a}.mod`, [`st${full}`]: `${a}.save`, [`${full}save`]: `${a}.save` });
  }
  for (const [skill] of SKILLS) m[norm(skill)] = `skill.${skill}`;
  m.animal = 'skill.Animal Handling';
  // the classic sheet numbers its slot rows 19-27 for spell levels 1-9
  for (let lvl = 1; lvl <= 9; lvl++) { m[`slotstotal${18 + lvl}`] = `slots.${lvl}.total`; m[`slotsremaining${18 + lvl}`] = `slots.${lvl}.left`; }
  return m;
})();

// D&D Beyond's names on top of those
const DDB_NAMES = (() => {
  const m = {
    ...BY_NAME, total: 'hitdice.max', passive1: 'passive', additionalsenses: 'senses', defenses: 'defenses', savemodifiers: 'saveModifiers',
    gender: 'look.Gender', faith: 'look.Faith', alliesorganizations: 'allies', additionalnotes1: 'notes', additionalnotes2: 'notes',
    spellcastingability0: 'spell.ability', spellsavedc0: 'spell.dc', spellatkbonus0: 'spell.attack', spellcastingclass0: 'spell.class',
    checkbox12: ['death.success', 1], checkbox13: ['death.success', 2], checkbox14: ['death.success', 3],
    checkbox15: ['death.failure', 1], checkbox16: ['death.failure', 2], checkbox17: ['death.failure', 3],
  };
  for (let i = 1; i <= 6; i++) m[`wpnnotes${i}`] = `attack.${i - 1}.notes`;
  for (let i = 1; i <= 6; i++) m[`attunedname${i}`] = `attuned.${i - 1}`;
  for (const a of ABILITIES) m[`${a}prof`] = `${a}.save.mark`;
  for (const [skill] of SKILLS) m[`${norm(skill)}prof`] = `skill.${skill}.mark`;
  return m;
})();
// read by readDdbRows(), or repeated, or worked out from other fields
const DDB_IGNORE = new RegExp(`^(?:(?:charactername|classlevel|playername|race|background|experiencepoints)\\d|(?:${SKILLS.map(([s]) => norm(s)).join('|')}|animal)mod$|passive[23]$|weightcarried$|encumbered$|pushdraglift$|attuned(?:qty|weight)\\d|attunedweight\\d|eq(?:name|qty|weight)\\d|featurestraits\\d|actions\\d|customprof\\d|customskill(?:bonus)?\\d|(?:spell)?(?:prepared|name|spellname|source|spellsource|savehit|castingtime|range|components|duration|page|notes)(?:blank)?(?:header)?\\d|spell(?:slot)?header\\d)`);

const template = (id) => TEMPLATES.find((t) => t.id === id).fields;

/**
 * Sheets MundusMaker knows. `fields` maps exact field names (the 2024 sheet's
 * own map from officialsheets.js); `names` maps normalized names. A map entry
 * is a value key, or [key, n] for the nth box of a counted row (death saves,
 * expended slots), whose ticked boxes are counted.
 */
export const LAYOUTS = [
  { id: 'dnd2024-wotc', label: 'the 2024 D&D character sheet', fields: template('dnd2024-wotc'), marks: 'boxes' },
  { id: 'ddb', label: 'a D&D Beyond character sheet export', names: DDB_NAMES, ignore: DDB_IGNORE, marks: 'text', read: readDdbRows,
    core: ['CLASS  LEVEL', 'PLAYER NAME', 'StrProf', 'ChaProf', 'AcrobaticsProf', 'SleightOfHandProf', 'Passive1', 'MaxHP', 'Wpn Name', 'Wpn Notes 1', 'ProficienciesLang', 'Actions1'] },
];

/** The known layout this form is, if any. */
export function recognizeLayout(form) {
  const names = new Set(form.fields.map((f) => f.name));
  const normalized = new Set(form.fields.map((f) => norm(f.name)));
  let best = null;
  for (const layout of LAYOUTS) {
    const wanted = layout.fields ? Object.keys(layout.fields) : layout.core;
    const have = layout.fields ? (n) => names.has(n) : (n) => normalized.has(norm(n));
    const share = wanted.filter(have).length / wanted.length;
    if (share >= (layout.fields ? 0.9 : 0.75) && (!best || share > best.share)) best = { layout, share };
  }
  return best?.layout || null;
}

// ---------- reading ----------

/** A checkbox's state: the field's /V, else any widget's own /AS. */
const ticked = (f) => (f.value ? f.value !== 'Off' : f.widgets.some((w) => w.state && w.state !== 'Off'));

function fieldValue(f) {
  if (f.type === 'checkbox' || f.type === 'radio') return ticked(f);
  if (f.type === 'text' || f.type === 'choice') return String(f.value ?? '').replace(/\r\n?/g, '\n');
  return undefined; // push buttons and signatures hold nothing to import
}

/** Text that runs on from one box into the next, cut between two words (or after a heading). */
function runOn(parts) {
  const heading = /^\s*(?:\*|=)/;
  return parts.reduce((all, part) => {
    if (!part.trim()) return all;
    if (!all) return part;
    const last = all.split('\n').pop();
    return /\n\s*$/.test(all) || heading.test(last) || heading.test(part) ? `${all.replace(/[ \t]+$/, '')}\n${part}` : `${all.replace(/\s+$/, '')} ${part.replace(/^\s+/, '')}`;
  }, '');
}

const DDB_TIMES = { A: 'Action', BA: 'Bonus Action', R: 'Reaction' };
/** "1A", "1BA", "1R", "10m", "8h" as the casting times MundusMaker writes. */
function castingTime(t) {
  const m = str(t).match(/^(\d+)\s*(A|BA|R|m|min|h|hr)\b\s*(.*)$/i);
  if (!m) return str(t);
  const n = Number(m[1]), unit = m[2], rest = m[3] ? ` ${m[3]}` : '';
  if (DDB_TIMES[unit.toUpperCase()] && unit === unit.toUpperCase()) return `${n === 1 ? '' : `${n} `}${DDB_TIMES[unit.toUpperCase()]}${rest}`;
  return `${n} ${/^h/i.test(unit) ? 'hour' : 'minute'}${n === 1 ? '' : 's'}${rest}`;
}

/**
 * D&D Beyond's repeated groups, which need the page order: equipment rows,
 * the run-on boxes, and the spell table with its level headers.
 */
function readDdbRows(form, values, used) {
  const by = new Map(form.fields.map((f) => [norm(f.name), f]));
  const val = (n) => str(by.get(n)?.value);
  const boxes = (prefix) => [...by.keys()].filter((k) => new RegExp(`^${prefix}\\d+$`).test(k)).sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  const features = runOn(boxes('featurestraits').map((k) => String(by.get(k).value || '')));
  if (features.trim()) values.set('features', features);
  const actions = runOn(boxes('actions').map((k) => String(by.get(k).value || '')));
  if (actions.trim()) values.set('actions', actions);
  const equipment = [];
  for (const k of boxes('eqname')) {
    const i = k.slice(6), name = val(k);
    if (name) equipment.push({ name, qty: sheetNumber(val(`eqqty${i}`)) || 1 });
  }
  if (equipment.length) values.set('equipment.rows', equipment);
  const custom = [1, 2, 3].map((i) => [val(`customskill${i}`), val(`customskillbonus${i}`), val(`customprof${i}`)]).filter(([n]) => n);
  if (custom.length) values.set('customSkills', custom.map(([n, b, p]) => `${n}${b ? ` ${b}` : ''}${p ? ` (${p})` : ''}`).join(', '));

  const rows = new Map(), slots = {};
  let level;
  for (const f of form.fields) {
    const n = norm(f.name);
    let m = n.match(/^spellheader\d+$/);
    if (m) {
      const h = str(f.value);
      level = /cantrip/i.test(h) ? 0 : sheetNumber(h.replace(/^[=\s]+/, '')) ?? level;
      continue;
    }
    if (/^spellslotheader\d+$/.test(n)) {
      const total = sheetNumber(f.value);
      // "4 Slots OOOO": each O a slot still to use, any other mark one spent
      if (level > 0 && total > 0) slots[level] = { max: total, used: Math.min(total, (str(f.value).replace(/^\d+\s*slots?/i, '').match(/[^O\s]/gi) || []).length) };
      continue;
    }
    m = f.name.match(/^(spell)?(Prepared|Name|SpellName|Source|SpellSource|SaveHit|CastingTime|Range|Components|Duration|Page|Notes)(\d+)$/i);
    if (!m || /header/i.test(f.name)) continue;
    const lowerFamily = !!m[1], col = lower(m[2]), i = `${lowerFamily ? 's' : 'S'}${m[3]}`;
    const key = col === 'spellname' ? 'name' : col === 'spellsource' ? 'source' : !lowerFamily && col === 'source' ? 'page' : col;
    if (!rows.has(i)) rows.set(i, {});
    const row = rows.get(i);
    row[key] = str(f.value);
    if (key === 'name') row.level = level;
  }
  const spells = [...rows.values()].filter((r) => r.name);
  if (spells.length) values.set('spells.rows', spells);
  if (Object.keys(slots).length) values.set('slots.rows', slots);
  for (const f of form.fields) if (DDB_IGNORE.test(norm(f.name))) used.add(f.name);
}

/**
 * The form's fields as value keys. Returns { values, layout, leftovers }:
 * `leftovers` are filled-in text fields no key reads, kept for the notes.
 */
export function readValues(form) {
  const layout = recognizeLayout(form);
  const names = layout?.names || BY_NAME;
  const values = new Map(), leftovers = [], used = new Set();
  layout?.read?.(form, values, used);
  for (const f of form.fields) {
    const v = fieldValue(f);
    if (v === undefined || used.has(f.name)) continue;
    const entry = layout?.fields ? layout.fields[f.name] : names[norm(f.name)];
    if (!entry) {
      if (typeof v === 'string' && v.trim()) leftovers.push({ field: f.name.trim(), value: v.trim() });
      continue;
    }
    if (Array.isArray(entry)) { values.set(entry[0], (values.get(entry[0]) || 0) + (v === true ? 1 : 0)); continue; }
    if (typeof v === 'boolean') { values.set(entry, v || values.get(entry) === true); continue; }
    if (!v.trim() || v.trim() === '--') continue;
    // a key fed by two fields (a page-2 name, two feature columns) keeps both
    const had = values.get(entry);
    if (typeof had === 'string' && had.trim() !== v.trim()) values.set(entry, /^(name|class|species|background|spell\.)/.test(entry) ? had : `${had}\n${v}`);
    else values.set(entry, v);
  }
  return { values, layout, leftovers };
}

// ---------- text parsing ----------

const lines = (text) => str(text).split('\n').map((s) => s.trim()).filter(Boolean);
const list = (text) => str(text).split(/[\n,;]+/).map((s) => s.replace(/^[•*\-–]\s*/, '').trim()).filter(Boolean);

/** "Fighter 3 / Wizard 2", "Rogue 5 (Thief)" -> [{ name, level, subclass }]. */
export function parseClassLevel(text) {
  const out = [];
  for (const part of str(text).split(/\s*[/,]\s*|\s+and\s+/i)) {
    const m = part.match(/^(.+?)\s*(?:\(([^)]*)\))?\s+(\d+)\s*(?:\(([^)]*)\))?$/) || part.match(/^(\d+)(?:st|nd|rd|th)?[- ]level\s+(.+)$/i);
    if (!m) continue;
    if (/^\d/.test(m[1])) out.push({ name: m[2].trim(), level: Number(m[1]), subclass: '' });
    else out.push({ name: m[1].trim(), level: Number(m[3]), subclass: str(m[2] || m[4]) });
  }
  return out;
}

/**
 * A features box as features. Sheets either list names one per line, or mark
 * each feature's first line ("* Second Wind • PHB 72") and put its text under
 * it. "=== BARD FEATURES ===" headings name where the features below come
 * from, through `sourceFor(heading)`; "| College of Glamour" lines are the
 * choices D&D Beyond records, kept in `details` and in the text.
 */
export function parseFeatures(text, source = '', sourceFor = () => source) {
  const out = [];
  const head = /^\s*[*•▸►]\s*(.+?)\s*$|^\s*-\s+(.+?)\s*$/;
  const section = /^\s*={2,}\s*(.+?)\s*={2,}\s*$/;
  const all = str(text).split('\n');
  const marked = all.some((l) => head.test(l));
  let from = source, cur = null;
  for (const raw of all) {
    const line = raw.trim();
    if (!line) continue;
    const s = line.match(section);
    if (s) { from = sourceFor(s[1]); cur = null; continue; }
    const h = marked ? line.match(head) : null;
    if (h || !marked) {
      const [nameText, ref] = (h ? h[1] || h[2] : line).split(/\s+[•|]\s+/);
      // a feature gained again later: "8: Ability Score Improvement"
      const name = nameText.replace(/[:.]\s*$/, '').replace(/^(\d+):\s*(.+)$/, '$2 (level $1)').trim();
      cur = { name, source: from, text: '' };
      if (ref?.trim()) cur.ref = ref.trim();
      out.push(cur);
      continue;
    }
    if (!cur) { cur = { name: line, source: from, text: '' }; out.push(cur); continue; }
    const detail = line.match(/^\|\s*(.*?)\s*•?\s*$/);
    if (detail) (cur.details ||= []).push(detail[1].replace(/\s*•\s*$/, ''));
    cur.text = cur.text ? `${cur.text}\n${detail ? detail[1] : line}` : detail ? detail[1] : line;
  }
  return out;
}

/** An equipment box as items: "2 × Dagger", "Dagger x2", "Rope (50 ft)", "Torch (10)". */
export function parseEquipment(text) {
  const rows = lines(text).length > 1 ? lines(text) : list(text);
  return rows.map((row) => row.replace(/^[•*\-–]\s*/, '')).filter(Boolean).map((row) => {
    // a leading number is a count, unless it measures the item ("50 ft. of rope")
    let m = row.match(/^(\d+)\s*(?:[×x*]\s*)?(?!(?:ft|feet|foot|lbs?|pounds?|gal|gallons?|days?|pints?|oz|inch(?:es)?|in|yds?|yards?|miles?|gp|sp|cp|ep|pp)\b)([^\d\s].*)$/i);
    if (m) return { name: m[2].trim(), qty: Number(m[1]) };
    m = row.match(/^(.+?)\s*(?:[×x*]\s*(\d+)|\((\d+)\))$/i);
    if (m) return { name: m[1].trim(), qty: Number(m[2] || m[3]) };
    return { name: row, qty: 1 };
  });
}

/** D&D Beyond's actions box as Markdown for a text block under an "Actions" heading: headings bold, indents dropped. */
function actionsText(text) {
  return str(text).split('\n').map((l) => l.trim()).map((l) => l.replace(/^={2,}\s*(.+?)\s*={2,}$/, (_, h) => `**${title(h)}**`)).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().replace(/^\*\*Actions\*\*\n+/, '');
}

const ABILITY_WORDS = Object.fromEntries(ABILITIES.flatMap((a) => [[a, a], [lower(ABILITY_NAMES[a]), a]]));
const abilityKey = (text) => ABILITY_WORDS[lower(text).replace(/[^a-z]/g, '')] || '';
const spellLevel = (text) => { const t = lower(text); if (!t) return undefined; if (/^(c|0|cantrip)/.test(t)) return 0; const n = sheetNumber(t); return n != null && n >= 0 && n <= 9 ? n : undefined; };

// ---------- building the sheet ----------

/**
 * Sheet data for a dnd2024 block from readValues()'s output.
 * `classes` (optional, [{ name, hitDie }]) supplies a hit die the PDF doesn't
 * print. Returns { name, data, fields, blocks, report }: `blocks` are extra
 * { title, text } sections for the entry (D&D Beyond's actions), and report
 * has imported/skipped/warnings lists of plain sentences for the preview.
 */
export function buildSheet({ values, layout, leftovers = [] }, { classes = [] } = {}) {
  const get = (k) => values.get(k);
  const text = (k) => str(get(k));
  const has = (k) => values.has(k) && get(k) !== '' && get(k) != null;
  const d = defaults();
  const imported = [], skipped = [], warnings = [], notes = [], blocks = [];
  const took = (what) => imported.push(what);
  const missed = (what, why) => skipped.push(why ? `${what}: ${why}` : what);
  d.abilityMethod = 'manual';

  // identity
  const name = text('name');
  const parsed = parseClassLevel(text('classlevel'));
  const className = text('class') || parsed[0]?.name || '';
  const level = sheetNumber(get('level')) ?? (parsed.length ? parsed.reduce((n, c) => n + c.level, 0) : null);
  d.klass = { ...d.klass, name: className, subclass: text('subclass') || parsed[0]?.subclass || '', level: Math.min(20, Math.max(1, level || 1)) };
  if (level == null) missed('Level', 'not on the sheet, so the sheet starts at level 1');
  if (parsed.length > 1) {
    const all = parsed.map((c) => `${c.name} ${c.level}${c.subclass ? ` (${c.subclass})` : ''}`).join(' / ');
    warnings.push(`This character is multiclassed (${all}). MundusMaker’s sheet follows one class, so it shows ${className} at the character’s total level ${d.klass.level}; the split is kept in the notes.`);
    notes.push(`Classes: ${all}`);
  }
  const die = text('hitdice.max').match(/d\s*(\d+)/i);
  const known = classes.find((c) => lower(c.name) === lower(className));
  if (die) d.klass.hitDie = Number(die[1]);
  else if (known?.hitDie) d.klass.hitDie = Number(known.hitDie);
  else missed('Hit die', 'not on the sheet, left at d8');
  const totalDice = sheetNumber(get('hitdice.max')), leftDice = sheetNumber(get('hitdice.left'));
  const spentDice = sheetNumber(get('hitdice.spent')) ?? (totalDice != null && leftDice != null && leftDice <= totalDice ? totalDice - leftDice : null);
  if (spentDice != null) d.hitDice.spent = Math.max(0, Math.min(d.klass.level, spentDice));

  d.species = { ...d.species, name: text('species') };
  if (has('size')) d.species.size = text('size');
  d.background = { ...d.background, name: text('background') };
  if (has('alignment')) d.alignment = text('alignment');
  if (has('xp')) d.xp = /^\d[\d, ]*$/.test(text('xp')) ? Number(text('xp').replace(/[, ]/g, '')) : text('xp').replace(/^\((.*)\)$/, '$1');

  // features first: the subclass and Jack of All Trades come from them
  const sourceFor = (heading) => {
    const h = lower(heading);
    if (/species|racial|race|lineage/.test(h)) return d.species.name ? `${d.species.name} trait` : 'Species trait';
    if (/^feats?$/.test(h)) return 'Feat';
    if (/background/.test(h)) return d.background.name ? `${d.background.name} background` : 'Background';
    const cls = parsed.find((c) => h.startsWith(lower(c.name))) || (className && h.startsWith(lower(className)) ? { name: className } : null);
    return cls ? cls.name : title(heading.replace(/\s+features?$/i, ''));
  };
  const classSource = className || 'Class';
  d.features = [
    ...parseFeatures([text('features.class.a'), text('features.class.b'), text('features.class')].filter(Boolean).join('\n'), classSource),
    ...parseFeatures(text('features.species'), d.species.name ? `${d.species.name} trait` : 'Species trait'),
    ...parseFeatures(text('feats'), 'Feat'),
    ...parseFeatures(text('features'), '', sourceFor),
  ];
  const featureDetails = new Map(d.features.map((f) => [lower(f.name), f.details || []]));
  for (const f of d.features) delete f.details;
  // D&D Beyond records the subclass as the choice under "<Class> Subclass"
  if (!d.klass.subclass) {
    const pick = [...featureDetails].find(([n, det]) => /subclass$/.test(n) && (!className || n.startsWith(lower(className))) && det[0]);
    if (pick) d.klass.subclass = pick[1][0];
  }
  if (className) took(`Class: ${className}${d.klass.subclass ? ` (${d.klass.subclass})` : ''}, level ${d.klass.level}`); else missed('Class', 'not on the sheet');
  if (d.species.name) took(`Species: ${d.species.name}`); else missed('Species', 'not on the sheet');
  if (d.background.name) took(`Background: ${d.background.name}`);
  if (d.features.length) took(`${plural(d.features.length, 'feature')} and trait${d.features.length === 1 ? '' : 's'}${d.features.some((f) => f.text) ? ', with their descriptions' : ''}`);

  // abilities
  const pb = profBonus(d.klass.level);
  const sheetPb = sheetNumber(get('pb'));
  if (sheetPb != null && sheetPb !== pb) warnings.push(`The sheet’s proficiency bonus is ${fmtMod(sheetPb)}; level ${d.klass.level} gives ${fmtMod(pb)}, which MundusMaker uses.`);
  const missingScores = [];
  for (const a of ABILITIES) {
    const score = sheetNumber(get(`${a}.score`));
    if (score != null && score >= 1 && score <= 30) d.abilities[a] = score;
    else missingScores.push(ABILITY_NAMES[a]);
  }
  if (missingScores.length < 6) took(`Ability scores: ${ABILITIES.map((a) => `${a.toUpperCase()} ${d.abilities[a]}`).join(', ')}`);
  if (missingScores.length) missed(`${missingScores.join(', ')} score${missingScores.length === 1 ? '' : 's'}`, 'not on the sheet, left at 10');

  // proficiency: the sheet's own boxes or marks when it has them, otherwise
  // worked out from the bonuses it prints (a bonus at least the proficiency
  // bonus above the modifier is proficient; twice that is expertise)
  const differ = [];
  const derive = (bonus, m) => (bonus == null ? null : bonus - m >= 2 * pb ? 'expert' : bonus - m >= pb ? 'prof' : '');
  let derivedAny = false;
  for (const a of ABILITIES) {
    const box = get(`${a}.save.prof`), mark = get(`${a}.save.mark`), bonus = sheetNumber(get(`${a}.save`)), m = mod(d.abilities[a]);
    let on;
    if (typeof box === 'boolean') on = box;
    else if (layout?.marks === 'text') on = !!str(mark) && !/^h$/i.test(str(mark));
    else { derivedAny ||= bonus != null; on = !!derive(bonus, m); }
    if (on) d.saves.push(a);
    if (bonus != null && bonus !== m + (on ? pb : 0)) differ.push(`${ABILITY_NAMES[a]} save ${fmtMod(bonus)}`);
  }
  for (const [skill, a] of SKILLS) {
    const box = get(`skill.${skill}.prof`), mark = str(get(`skill.${skill}.mark`)).toUpperCase(), bonus = sheetNumber(get(`skill.${skill}`)), m = mod(d.abilities[a]);
    let prof;
    if (typeof box === 'boolean') prof = box ? (bonus != null && bonus - m >= 2 * pb ? 'expert' : 'prof') : '';
    else if (layout?.marks === 'text') prof = mark === 'E' ? 'expert' : mark && mark !== 'H' ? 'prof' : '';
    else { derivedAny ||= bonus != null; prof = derive(bonus, m) || ''; }
    if (prof) d.skills.push({ key: canonSkill(skill), prof });
    if (bonus != null && bonus !== skillBonus(d, skill, pb)) differ.push(`${skill} ${fmtMod(bonus)}`);
  }
  if (d.saves.length || d.skills.length) took(`Proficiencies: ${plural(d.saves.length, 'saving throw')}, ${plural(d.skills.length, 'skill')}${d.skills.some((s) => s.prof === 'expert') ? ' (with expertise)' : ''}`);
  if (derivedAny && !layout) warnings.push('Save and skill proficiencies were worked out from the bonuses printed on the sheet.');

  // combat
  const ac = sheetNumber(get('ac'));
  if (ac != null) { d.ac = ac; took(`Armor class ${ac}`); } else missed('Armor class', 'not on the sheet, left at 10');
  d.defense = { armor: null, shield: get('shield') === true, automatic: false };
  const speed = sheetNumber(get('speed'));
  if (speed != null) {
    d.speed = speed; d.species.speed = speed; took(`Speed ${speed} ft.`);
    if ((text('speed').match(/\d+/g) || []).length > 1) notes.push(`Speed: ${text('speed')}`);
  } else missed('Speed', 'not on the sheet, left at 30 ft.');
  const hpMax = sheetNumber(get('hp.max')), hpNow = sheetNumber(get('hp.current')), hpTemp = sheetNumber(get('hp.temp'));
  if (hpMax != null) {
    d.hp = { max: hpMax, current: hpNow ?? hpMax, temp: hpTemp ?? 0 };
    took(`Hit points ${d.hp.current} / ${hpMax}${d.hp.temp ? ` (+${d.hp.temp} temporary)` : ''}`);
    if (hpNow == null) warnings.push('Current hit points were blank, so they start at the maximum.');
  } else missed('Hit points', 'not on the sheet, left at 8');
  d.deathSaves = { success: Math.min(3, Number(get('death.success')) || 0), failure: Math.min(3, Number(get('death.failure')) || 0) };
  const init = sheetNumber(get('initiative'));
  if (init != null && init !== mod(d.abilities.dex)) d.initiativeBonus = init - mod(d.abilities.dex);
  if (get('inspiration') === true || /^(yes|y|x|1|✓|true)$/i.test(text('inspiration'))) d.inspiration = true;
  const passive = sheetNumber(get('passive'));
  if (passive != null && passive !== passivePerception(d, pb)) differ.push(`passive Perception ${passive}`);
  if (differ.length) {
    warnings.push(`The sheet’s own numbers differ from what MundusMaker works out for ${differ.length === 1 ? 'one value' : `${differ.length} values`} (usually an item or feature it doesn’t track); they are listed in the notes.`);
    notes.push(`On the imported sheet: ${differ.join(', ')}.`);
  }
  for (const [k, label] of [['senses', 'Senses'], ['defenses', 'Defenses'], ['saveModifiers', 'Saving throw notes'], ['customSkills', 'Other skills']]) if (has(k)) notes.push(`${label}: ${text(k).replace(/\s*\n\s*/g, '; ')}`);

  // attacks
  for (let i = 0; i < 12; i++) {
    const atkName = text(`attack.${i}.name`);
    if (!atkName) continue;
    const bonus = text(`attack.${i}.bonus`);
    const atk = { name: atkName, bonus: isBonus(bonus) ? sheetNumber(bonus) : bonus || 0, damage: text(`attack.${i}.damage`) };
    if (has(`attack.${i}.notes`)) atk.notes = text(`attack.${i}.notes`);
    d.attacks.push(atk);
  }
  if (d.attacks.length) took(plural(d.attacks.length, 'attack'));
  if (has('attacks.text')) notes.push(`Attacks & spellcasting: ${text('attacks.text')}`);
  if (has('actions')) blocks.push({ title: 'Actions', text: actionsText(text('actions')) });

  // training and languages
  const armor = ['light', 'medium', 'heavy', 'shield'].filter((k) => get(`armor.${k}`) === true);
  d.proficiencies = { armor, weapons: list(text('prof.weapons')), tools: list(text('prof.tools')) };
  d.languages = list(text('languages'));
  if (has('prof.other')) {
    // the classic sheet keeps everything in one box, often under headings
    let bucket = 'other';
    const rest = [];
    for (const raw of text('prof.other').split('\n')) {
      const h = raw.match(/^\s*(?:=+\s*)?(armor|weapons?|tools?|languages?)\s*(?:proficienc(?:y|ies))?\s*[:=]+\s*(.*)$/i);
      if (h) { bucket = lower(h[1]).replace(/s$/, ''); if (!h[2].trim()) continue; }
      const items = list(h ? h[2] : raw);
      if (bucket === 'language') d.languages.push(...items);
      else if (bucket === 'weapon') d.proficiencies.weapons.push(...items);
      else if (bucket === 'tool') d.proficiencies.tools.push(...items);
      else if (bucket === 'armor') d.proficiencies.armor.push(...items);
      else rest.push(...items);
    }
    if (rest.length) notes.push(`Proficiencies & languages: ${rest.join(', ')}`);
  }
  if (d.languages.length) took(`Languages: ${d.languages.join(', ')}`);
  if (d.proficiencies.armor.length || d.proficiencies.weapons.length || d.proficiencies.tools.length) took('Armor, weapon and tool training');

  // spellcasting
  const spells = [];
  for (let i = 0; i < 60; i++) {
    const spellName = text(`spells.${i}.name`);
    if (!spellName) continue;
    const s = { name: spellName, level: spellLevel(text(`spells.${i}.level`)) };
    if (has(`spells.${i}.time`)) s.castingTime = text(`spells.${i}.time`);
    if (has(`spells.${i}.range`)) s.range = text(`spells.${i}.range`);
    if (get(`spells.${i}.c`) === true) s.concentration = true;
    if (get(`spells.${i}.r`) === true) s.ritual = true;
    if (get(`spells.${i}.m`) === true) s.components = 'M';
    if (has(`spells.${i}.notes`)) s.text = text(`spells.${i}.notes`);
    spells.push(s);
  }
  const castClass = lower(text('spell.class') || className);
  const alwaysPrepared = [], innate = [];
  for (const r of get('spells.rows') || []) {
    const s = { name: r.name, level: r.level };
    if (r.castingtime) s.castingTime = castingTime(r.castingtime);
    if (r.range && r.range !== '--') s.range = r.range;
    if (r.components && r.components !== '--') s.components = r.components.split(/\s*,\s*/).join(', ');
    if (r.duration && r.duration !== '--') { s.duration = r.duration.replace(/^concentration,\s*/i, ''); if (/^concentration/i.test(r.duration)) s.concentration = true; }
    if (/\britual\b|\(R\)/i.test(`${r.castingtime} ${r.notes}`)) s.ritual = true;
    const source = str(r.source).replace(/\s*\(always prepared\)\s*$/i, '');
    const uses = sheetNumber((str(r.notes).match(/(\d+)\s*\/\s*LR/i) || [])[1]);
    const old = spells.find((x) => x.name === s.name);
    if (old) { old.uses ||= uses; continue; } // D&D Beyond lists a free daily casting as a second row
    s.uses = uses;
    if (/^p$/i.test(str(r.prepared)) || /always prepared/i.test(str(r.source))) { s.list = 'always'; s.source = source; }
    else if (!source || lower(source) === castClass || parsed.some((c) => lower(c.name) === lower(source))) s.list = s.level === 0 ? 'cantrip' : 'prepared';
    else { s.list = 'innate'; s.source = source; }
    spells.push(s);
  }
  for (const s of spells.filter((x) => x.list === 'innate')) {
    // "| Charisma" under the feature that grants the spell names its ability
    const ability = abilityKey((featureDetails.get(lower(s.source)) || []).map((x) => x.split(/\s*•\s*/)[0]).find(abilityKey) || '');
    innate.push({ name: s.name, level: s.level, source: s.source, ...(ability ? { ability } : {}), ...(s.uses ? { uses: s.uses } : {}) });
  }
  const slots = { ...(get('slots.rows') || {}) };
  for (let lvl = 1; lvl <= 9; lvl++) {
    const max = sheetNumber(get(`slots.${lvl}.total`));
    if (max == null || max <= 0) continue;
    const left = sheetNumber(get(`slots.${lvl}.left`));
    slots[lvl] = { max, used: Math.min(max, left != null ? Math.max(0, max - left) : Number(get(`slots.${lvl}.used`)) || 0) };
  }
  const ability = abilityKey(text('spell.ability'));
  const dc = sheetNumber(get('spell.dc')), atkBonus = sheetNumber(get('spell.attack'));
  const classSpells = spells.filter((s) => s.list !== 'innate');
  if (classSpells.length || Object.keys(slots).length || ability || dc != null) {
    for (const s of classSpells) if (s.list === 'always') alwaysPrepared.push(s.name);
    d.spellcasting = { ability, dc: dc ?? null, attackBonus: atkBonus ?? null, slots,
      cantrips: classSpells.filter((s) => s.list ? s.list === 'cantrip' : s.level === 0).map((s) => s.name),
      prepared: classSpells.filter((s) => s.list ? s.list === 'prepared' : s.level !== 0).map((s) => s.name) };
    if (alwaysPrepared.length) d.spellcasting.alwaysPrepared = alwaysPrepared;
    if (!ability && has('spell.ability')) missed('Spellcasting ability', `“${text('spell.ability')}” is not an ability name`);
    if (has('spell.class') && lower(text('spell.class')) !== lower(className)) notes.push(`Spellcasting class: ${text('spell.class')}`);
    const lvl = Object.keys(slots).map(Number);
    took(`Spellcasting: ${plural(d.spellcasting.cantrips.length, 'cantrip')}, ${plural(d.spellcasting.prepared.length + alwaysPrepared.length, 'spell')}${lvl.length ? `, slots to level ${Math.max(...lvl)}` : ''}`);
  }
  if (innate.length) { d.innateSpells = innate; took(`${plural(innate.length, 'spell')} from species or feats`); }
  const details = spells.map(({ list: _l, uses: _u, source: _s, ...s }) => s).filter((s) => Object.keys(s).length > 2 || s.level != null);
  if (details.length) d.spellDetails = details;

  // gear
  d.equipment = get('equipment.rows') || parseEquipment(text('equipment'));
  if (d.equipment.length) took(plural(d.equipment.length, 'equipment line'));
  d.coins = {};
  for (const k of ['cp', 'sp', 'ep', 'gp', 'pp']) d.coins[k] = sheetNumber(text(`coins.${k}`).replace(/[, ]/g, '')) ?? 0;
  if (Object.values(d.coins).some(Boolean)) took(`Coins: ${['pp', 'gp', 'ep', 'sp', 'cp'].filter((k) => d.coins[k]).map((k) => `${d.coins[k]} ${k}`).join(', ')}`);
  const attuned = [0, 1, 2, 3, 4, 5].map((i) => text(`attuned.${i}`)).filter(Boolean);
  if (attuned.length) { d.attuned = attuned; took(plural(attuned.length, 'attuned item')); }
  if (has('treasure')) notes.push(`Treasure: ${text('treasure')}`);

  // story
  for (const k of ['traits', 'ideals', 'bonds', 'flaws']) if (has(`personality.${k}`)) d.personality[k] = text(`personality.${k}`);
  const look = ['Gender', 'Age', 'Height', 'Weight', 'Eyes', 'Skin', 'Hair', 'Faith'].filter((k) => has(`look.${k}`)).map((k) => `${k}: ${text(`look.${k}`)}`);
  const appearance = [text('appearance'), look.join(' · ')].filter(Boolean).join('\n');
  if (appearance) d.appearance = appearance;
  if (has('backstory')) {
    // the 2024 sheet shares one box between personality and backstory; lines
    // that start "Traits:", "Ideals:" and so on go back to their own fields
    const rest = [];
    for (const line of text('backstory').split('\n')) {
      const m = line.match(/^\s*(?:personality\s+)?(traits?|ideals?|bonds?|flaws?)\s*:\s*(.+)$/i);
      const k = m && `${lower(m[1]).replace(/s$/, '')}s`;
      if (m && !d.personality[k]) d.personality[k] = m[2].trim();
      else rest.push(line);
    }
    if (rest.join('\n').trim()) d.backstory = rest.join('\n').trim();
  }
  if (has('allies')) notes.push(`Allies & organizations: ${text('allies')}${has('faction') ? ` (${text('faction')})` : ''}`);
  if (has('player')) notes.push(`Player: ${text('player')}`);
  if (has('notes')) notes.push(text('notes'));
  if (appearance || d.backstory || Object.values(d.personality).some(Boolean)) took('Appearance, personality and backstory');
  // spell rows on sheets MundusMaker doesn't know are numbered, not labelled
  const spellRows = leftovers.filter((l) => /^spells?\s*\d+$/i.test(l.field)), others = leftovers.filter((l) => !spellRows.includes(l));
  if (spellRows.length) notes.push(`Spells on the sheet: ${spellRows.map((l) => l.value).join(', ')}`);
  if (others.length) notes.push(`Other fields on the sheet:\n${others.map((l) => `${l.field}: ${l.value}`).join('\n')}`);
  if (blocks.length) took(`${blocks.map((b) => b.title).join(', ')} as a section of the entry`);
  d.notes = notes.join('\n\n');
  d.imported = { from: layout ? layout.id : 'pdf-by-name' };

  const fields = {};
  if (d.species.name) fields.Species = d.species.name;
  return { name, data: d, fields, blocks, report: { layout: layout?.label || '', imported, skipped, warnings, leftovers: leftovers.length } };
}

/** readValues() then buildSheet(): a form straight to { name, data, fields, blocks, report }. */
export function characterFromForm(form, options) {
  return buildSheet(readValues(form), options);
}
