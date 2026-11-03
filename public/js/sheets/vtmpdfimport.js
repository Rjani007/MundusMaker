// V5 character sheet PDFs read back into a vtm5 sheet block. Pure: the form from
// pdfform.js readForm() (plus pageImages() for Progeny's PDF) in, sheet data and a
// report out. Nothing here writes; the Import page shows the report and the GM
// confirms first.
//
// Two layouts, read in two steps like dndpdfimport.js:
//   readValues()  PDF fields -> flat value keys ("attr.strength", "skill.Brawl",
//                 "disc.1.power.2"), the highest ticked box of a counted row;
//   buildSheet()  value keys -> sheet data. Only what the PDF carries is kept.
// The official sheet (Renegade Game Studios' free fillable PDF) is read through the
// very map "Use my own official sheet" fills it with (officialsheets.js,
// vtm5-renegade). Progeny's "Download PDF" fills Nerdbert's 2-page sheet; its field
// names come from Progeny's frontend/src/generator/pdfCreator.ts (AGPL: the names
// only, never its code). Elysium (../elysium, site/js/officialsheet.js) reads the
// same two layouts; change both.

import { TEMPLATES } from './officialsheets.js';
import { V5_ATTRS, V5_SKILLS } from './familiar.js';

const ATTRS = V5_ATTRS.flatMap(([, keys]) => keys);
const SKILLS = V5_SKILLS.flatMap(([, names]) => names);
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// a name typed all in lowercase ("auspex", "blood sorcery") gets the capitals MundusMaker's own names have
const tidy = (s) => (s === s.toLowerCase() ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : s);
const joinList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
const firstNumber = (s) => { const m = String(s ?? '').match(/\d+/); return m ? Number(m[0]) : null; };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- layouts ----------

// Progeny's sheet names its dots "<prefix>-1".."-5" and the specialty line beside each
// skill on its own; the names are uneven ("Fri" for Firearms, "specStree" for Streetwise).
const PROGENY_ATTRS = { strength: 'Str', dexterity: 'Dex', stamina: 'Sta', charisma: 'Cha', manipulation: 'Man', composure: 'Com', intelligence: 'Int', wits: 'Wit', resolve: 'Res' };
const PROGENY_SKILLS = {
  Athletics: ['Ath', 'specAth'], Brawl: ['Bra', 'specBra'], Craft: ['Cra', 'specCra'], Drive: ['Dri', 'specDri'], Firearms: ['Fri', 'specFir'],
  Larceny: ['Lar', 'specLar'], Melee: ['Mel', 'specMel'], Stealth: ['Ste', 'specStea'], Survival: ['Sur', 'specSur'],
  'Animal Ken': ['AniKen', 'specAniKen'], Etiquette: ['Etiq', 'specEtiq'], Insight: ['Insi', 'specInsi'], Intimidation: ['Inti', 'specInti'],
  Leadership: ['Lead', 'specLea'], Performance: ['Perf', 'specPerf'], Persuasion: ['Pers', 'specPers'], Streetwise: ['Stre', 'specStree'], Subterfuge: ['Subt', 'specSubt'],
  Academics: ['Acad', 'specAcad'], Awareness: ['Awar', 'specAwar'], Finance: ['Fina', 'specFina'], Investigation: ['Inve', 'specInve'],
  Medicine: ['Medi', 'specMedi'], Occult: ['Occu', 'specOccu'], Politics: ['Poli', 'specPoli'], Science: ['Scie', 'specScie'], Technology: ['Tech', 'specTech'],
};
const PROGENY = (() => {
  const f = {
    Name: 'name', pcDescription: 'concept', 'Predator type': 'predator', Ambition: 'ambition', Clan: 'clan', ClanBane: 'bane', ClanCompulsion: 'compulsion',
    Sire: 'sire', Desire: 'desire', Title: 'generation', BloodSurge: 'bloodSurge', Mend: 'mendAmount', PowBonus: 'powerBonus', ReRouse: 'rouseReroll',
    FeedPen: 'feedingPenalty', BaneSev: 'baneSeverity', Convictions: 'convictions', touchstoneNotes: 'touchstoneNotes', tEXP: 'xp.total', PC_Notes: 'notes',
  };
  for (const [a, p] of Object.entries(PROGENY_ATTRS)) for (let n = 1; n <= 5; n++) f[`${p}-${n}`] = [`attr.${a}`, n];
  for (const [s, [p, spec]] of Object.entries(PROGENY_SKILLS)) {
    f[spec] = `spec.${s}`;
    for (let n = 1; n <= 5; n++) f[`${p}-${n}`] = [`skill.${s}`, n];
  }
  // a title per discipline block and a line per power, ticked for each power
  for (let b = 1; b <= 6; b++) {
    f[`Disc${b}`] = `block.${b}.name`;
    for (let i = 1; i <= 5; i++) { f[`Disc${b}_Ability${i}`] = `block.${b}.line.${i}`; f[`Disc${b}-${i}`] = [`block.${b}.dot.${i}`, 1]; }
  }
  // the boxes a character has: Progeny ticks them up to the character's own maximums
  for (let i = 1; i <= 10; i++) { f[`Humanity-${i}`] = ['humanity', i]; f[`BloodPotency-${i}`] = ['potency', i]; f[`WP-${i}`] = ['willpower.max', i]; }
  for (let i = 1; i <= 20; i++) f[`Health-${i}`] = ['health.max', i];
  for (let n = 1; n <= 40; n++) {
    f[`Merit${n}`] = `merit.${n}`;
    for (let l = 1; l <= 5; l++) f[`Merit${n}-${l}`] = [`merit.${n}.dots`, l];
  }
  return f;
})();

/** Sheets MundusMaker reads. A map entry is a value key, or [key, n] for the nth box of a counted row. */
export const LAYOUTS = [
  { id: 'vtm5-renegade', label: 'the official V5 character sheet', fields: TEMPLATES.find((t) => t.id === 'vtm5-renegade').fields },
  // every Progeny PDF has these; merits and the boxes up to a character's maximums vary
  { id: 'progeny', label: 'a Progeny PDF (Nerdbert’s sheet)', fields: PROGENY,
    core: Object.keys(PROGENY).filter((n) => !/^(Merit\d|Health-|WP-|BloodPotency-)/.test(n)) },
];

/** The known layout this form is, if any: 90% of its field names present. */
export function recognizeLayout(form) {
  const names = new Set(form.fields.map((f) => f.name));
  let best = null;
  for (const layout of LAYOUTS) {
    const wanted = layout.core || Object.keys(layout.fields);
    const share = wanted.filter((n) => names.has(n)).length / wanted.length;
    if (share >= 0.9 && (!best || share > best.share)) best = { layout, share };
  }
  return best?.layout || null;
}

// ---------- reading ----------

// Humanity boxes: the official sheet's own script cycles each button's caption through ✔
// (Humanity), ✕ (a Stain) and blank; a viewer may store the ZapfDingbats codes "4" and
// "5" instead. MundusMaker's fill draws a filled box with no caption, and Progeny draws a
// tick picture over the box (pdfform.js pageImages).
const CHECK = /^(?:[✓✔☑✅]|[34])$/u;
const CROSS = /^(?:[✕✖✗✘×xX]|[5-8])$/u;
const DRAWN_BOX = /\bre\s+f\b/;
// Health and Willpower boxes on the official sheet are text: / is Superficial, X Aggravated
const SUPERFICIAL = /^[/\\]+$/;
const AGGRAVATED = /^[xX×✕✖✗✘*]+$/u;
const centreIn = (r, box) => { const x = (r[0] + r[2]) / 2, y = (r[1] + r[3]) / 2; return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]; };

/**
 * The form's values by value key: the highest ticked box of each counted row, text for the
 * rest; Humanity is the number of marked boxes and Stains the number crossed. `ticked`
 * answers for single boxes (the official sheet's shared fifth dot needs it).
 */
export function readValues(form, images = []) {
  const layout = recognizeLayout(form);
  const values = new Map(), boxes = new Map();
  if (!layout) return { layout: null, values, ticked: () => false };
  for (const f of form.fields) {
    const entry = layout.fields[f.name];
    if (!entry) continue;
    if (!Array.isArray(entry)) {
      const v = String(f.value ?? '').replace(/\r\n?/g, '\n').trim();
      if (v && f.type !== 'checkbox' && f.type !== 'radio') values.set(entry, v);
      continue;
    }
    const [key, n] = entry;
    if (f.type === 'pushbutton') {
      const w = f.widgets[0] || {};
      const mark = (w.caption || '').trim();
      const counted = CROSS.test(mark) ? 'stains'
        : CHECK.test(mark) || DRAWN_BOX.test(w.drawn || '') || images.some((im) => (w.page < 0 || im.page === w.page) && centreIn(im.rect, w.rect || [0, 0, 0, 0])) ? key : null;
      if (counted) values.set(counted, (values.get(counted) || 0) + 1);
      continue;
    }
    const on = (!!f.value && f.value !== 'Off') || f.widgets.some((w) => !!w.state && w.state !== 'Off');
    boxes.set(f.name, on);
    if (on) values.set(key, Math.max(values.get(key) || 0, n));
  }
  return { layout, values, ticked: (name) => !!boxes.get(name) };
}

// "Heightened Senses", "1 - Heightened Senses", "Heightened Senses (1)": the written level, else the row
function officialPower(raw, row) {
  let m = raw.match(/^(?:(?:level|lvl|lv|l)\.?\s*)?([1-5])\s*[:.)\-–—]\s*(.+)$/i);
  if (m) return { name: m[2].trim(), level: Number(m[1]), desc: '' };
  m = raw.match(/^(.+?)\s*\(\s*(?:(?:level|lvl|lv|l)\.?\s*)?([1-5])\s*\)$/i);
  if (m) return { name: m[1].trim(), level: Number(m[2]), desc: '' };
  return { name: raw, level: row, desc: '' };
}

// Progeny's power lines: "Awe: summary // Manipulation + Presence // 1 rouse check"; a ritual adds "// requires: …"
function progenyLine(line) {
  const [head, ...rest] = line.split(' // ');
  const at = head.indexOf(': ');
  const rouse = rest.map((s) => s.match(/^(\d+) rouse checks?$/i)).find(Boolean);
  const out = {
    name: (at > 0 ? head.slice(0, at) : head).trim(),
    desc: [at > 0 ? head.slice(at + 2).trim() : '', ...rest.filter((s) => /^requires:/i.test(s))].filter(Boolean).join(' · '),
  };
  const pool = rest.find((s) => !/^\d+ rouse checks?$/i.test(s) && !/^requires:/i.test(s));
  if (pool) out.pool = pool;
  if (rouse) out.rouse = Number(rouse[1]);
  return out;
}

/**
 * Value keys -> { name, data, report }. `report` lists what came across (`imported`) and what
 * is worth checking (`warnings`), for the Import page to show before anything is saved.
 */
export function buildSheet({ layout, values, ticked }) {
  const official = layout.id === 'vtm5-renegade';
  const imported = [], warnings = [];
  const n = (k) => values.get(k) || 0;
  const text = (k) => String(values.get(k) ?? '').trim();
  const d = {};

  for (const [k, key] of [['clan', 'clan'], ['predator', 'predatorType'], ['sire', 'sire'], ['ambition', 'ambition'], ['desire', 'desire'], ['concept', 'concept'],
    ['chronicle', 'chronicle'], ['resonance', 'resonance'], ['tenets', 'tenets'], ['bane', 'bane'], ['bloodSurge', 'bloodSurge'], ['mendAmount', 'mendAmount'],
    ['powerBonus', 'powerBonus'], ['rouseReroll', 'rouseReroll'], ['feedingPenalty', 'feedingPenalty'], ['baneSeverity', 'baneSeverity'],
    ['trueAge', 'trueAge'], ['apparentAge', 'apparentAge'], ['dateOfBirth', 'dateOfBirth'], ['dateOfDeath', 'dateOfDeath'],
    ['appearance', 'appearance'], ['features', 'features'], ['history', 'history']]) if (text(k)) d[key] = text(k);
  if (d.clan) d.clan = tidy(d.clan);
  const generation = firstNumber(text('generation'));
  d.generation = generation && generation >= 1 && generation <= 16 ? generation : 13;
  if (text('generation') && d.generation !== generation) warnings.push(`Generation “${text('generation').slice(0, 20)}” isn’t a number from 1 to 16, so it was set to 13.`);
  if (d.clan || d.predatorType || d.concept) imported.push('Clan, generation, predator type and the rest of who the character is');

  d.attributes = {};
  const undotted = [];
  for (const a of ATTRS) { d.attributes[a] = n(`attr.${a}`) || 1; if (!n(`attr.${a}`)) undotted.push(cap(a)); }
  if (undotted.length === ATTRS.length) warnings.push('No Attribute dots were ticked, so every Attribute starts at 1.');
  else {
    imported.push('Attributes');
    if (undotted.length) warnings.push(`No dots were ticked for ${joinList(undotted)}, so ${undotted.length > 1 ? 'they start' : 'it starts'} at 1, the lowest an Attribute can be.`);
  }
  d.skills = Object.fromEntries(SKILLS.map((s) => [s, Math.min(5, n(`skill.${s}`))]));
  d.specialties = [];
  for (const s of SKILLS) for (const name of text(`spec.${s}`).split(/[,;\n]+/)) if (name.trim()) d.specialties.push({ skill: s, name: name.trim() });
  imported.push(`Skills${d.specialties.length ? ` and ${d.specialties.length} ${d.specialties.length === 1 ? 'specialty' : 'specialties'}` : ''}`);

  // ---- disciplines, advantages, touchstones: each layout writes them its own way
  d.disciplines = [];
  d.advantages = [];
  d.convictions = [];
  d.touchstones = [];
  const notes = [text('notes')];
  if (official) {
    for (let i = 1; i <= 6; i++) {
      const name = text(`disc.${i}.name`), rating = Math.min(5, n(`disc.${i}.rating`));
      const powers = [];
      for (let row = 1; row <= 5; row++) if (text(`disc.${i}.power.${row}`)) powers.push(officialPower(text(`disc.${i}.power.${row}`), row));
      if (name) d.disciplines.push({ name: tidy(name), rating, powers });
      else if (rating || powers.length) warnings.push(`Discipline ${i} on the sheet has ${rating ? 'dots' : 'powers'} but no name, so it was left out.`);
    }
    // rows 1 and 5 share one fifth-dot field ("adflaw1-5"): it counts for a row whose
    // fourth dot is ticked, row 1 when neither is
    if (ticked('adflaw1-5')) {
      const one = ticked('adflaw1-4') || !ticked('adflaw5-4'), five = ticked('adflaw5-4');
      if (!one) values.set('adv.1.dots', [1, 2, 3, 4].filter((k) => ticked(`adflaw1-${k}`)).pop() || 0);
      if (five) values.set('adv.5.dots', 5);
      if (one && five) warnings.push('On this sheet, rows 1 and 5 of Advantages & Flaws share their fifth dot, so both read as 5 dots. Check them.');
    }
    for (let i = 1; i <= 11; i++) {
      const raw = text(`adv.${i}.name`), dots = Math.min(5, n(`adv.${i}.dots`));
      if (!raw) { if (dots) warnings.push(`Row ${i} of Advantages & Flaws has dots but no name, so it was left out.`); continue; }
      const flaw = /\(\s*flaw\s*\)$/i.test(raw) || /^flaw\s*[:\-–—]/i.test(raw);
      d.advantages.push({ name: raw.replace(/\s*\(\s*flaw\s*\)$/i, '').replace(/^flaw\s*[:\-–—]\s*/i, '') || raw, dots, flaw, desc: '' });
    }
    // "Use my own official sheet" writes each pair as "conviction — touchstone"; other lines go to the notes
    const loose = [];
    for (const line of text('touchstones').split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = line.match(/^(.+?)\s+[—–]\s+(.+)$/);
      if (m) { d.convictions.push(m[1].trim()); d.touchstones.push({ name: m[2].trim(), conviction: m[1].trim(), desc: '' }); } else loose.push(line);
    }
    if (loose.length) {
      notes.push(`Touchstones & Convictions, from the sheet:\n${loose.join('\n')}`);
      warnings.push('Touchstones and Convictions not written as “conviction — touchstone” went into the notes. Move them to their place on the sheet.');
    }
  } else {
    const discs = new Map(), rituals = [];
    for (let b = 1; b <= 6; b++) {
      const title = text(`block.${b}.name`).replace(/\s*\(cont\.\)$/i, '');
      const lines = [];
      for (let i = 1; i <= 5; i++) if (text(`block.${b}.line.${i}`)) lines.push({ ...progenyLine(text(`block.${b}.line.${i}`)), dot: !!n(`block.${b}.dot.${i}`) });
      if (!title) { if (lines.length) warnings.push(`Discipline block ${b} on the sheet has powers but no name, so it was left out.`); continue; }
      // "Celerity (cont.)" carries on an earlier block; unticked lines and "Oblivion Ceremonies" are rituals
      const ceremonies = /ceremon/i.test(title), key = title.toLowerCase();
      // Progeny capitalizes only the first word ("Blood sorcery")
      if (!ceremonies && !discs.has(key)) discs.set(key, { name: tidy(key), rating: 0, powers: [] });
      for (const { dot, ...line } of lines) {
        if (dot && !ceremonies) { const x = discs.get(key); x.rating = Math.min(5, x.rating + 1); x.powers.push({ ...line, level: Math.min(5, x.powers.length + 1) }); }
        else rituals.push({ name: line.name, level: 1, desc: line.desc });
      }
    }
    d.disciplines = [...discs.values()];
    if (rituals.length) {
      // Elysium shows rituals; MundusMaker's sheet has no list for them, so they are in the notes too
      d.rituals = rituals;
      notes.push(`Rituals and ceremonies:\n${rituals.map((r) => `${r.name}${r.desc ? ` — ${r.desc}` : ''}`).join('\n')}`);
    }
    for (let i = 1; i <= 40; i++) {
      const t = text(`merit.${i}`), dots = Math.min(5, n(`merit.${i}.dots`));
      if (!t) { if (dots) warnings.push(`Merit or Flaw ${i} on the sheet has dots but no name, so it was left out.`); continue; }
      const at = t.indexOf(': ');
      d.advantages.push({ name: (at > 0 ? t.slice(0, at) : t).trim(), dots, flaw: false, desc: at > 0 ? t.slice(at + 2).trim() : '' });
    }
    if (d.advantages.length) warnings.push('Progeny’s PDF lists Merits and Flaws together without saying which is which, so all of them came in as Advantages. Mark the Flaws on the sheet.');
    // "Never harm a performer (Mara)" per touchstone, a blank line between; the notes hold "Mara\nher accompanist"
    const descs = new Map();
    for (const block of text('touchstoneNotes').split(/\n\s*\n/)) {
      const [first, ...more] = block.split('\n');
      if (first?.trim()) descs.set(first.trim().toLowerCase(), more.join('\n').trim());
    }
    for (const block of text('convictions').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
      const m = block.match(/^([\s\S]*?)\s*\(([^()]*)\)$/);
      const conviction = (m ? m[1] : block).trim(), name = m ? m[2].trim() : '';
      if (conviction) d.convictions.push(conviction);
      if (name) d.touchstones.push({ name, conviction, desc: descs.get(name.toLowerCase()) || '' });
    }
    if (text('compulsion')) notes.push(`Clan compulsion: ${text('compulsion')}`);
  }
  if (d.disciplines.length) imported.push(`${plural(d.disciplines.length, 'Discipline')} with ${plural(d.disciplines.reduce((t, x) => t + x.powers.length, 0), 'power')}`);
  if (d.advantages.length) imported.push(`${d.advantages.length} ${d.advantages.length === 1 ? 'Advantage or Flaw' : 'Advantages and Flaws'}`);
  if (d.touchstones.length || d.convictions.length) imported.push('Touchstones and Convictions');

  // ---- trackers
  if (official) {
    d.hunger = Math.min(5, n('hunger'));
    if (!d.hunger) { d.hunger = 1; warnings.push('No Hunger boxes were ticked, so Hunger starts at 1.'); }
    for (const [key, label] of [['health', 'Health'], ['willpower', 'Willpower']]) {
      let superficial = 0, aggravated = 0;
      const odd = [];
      for (let i = 1; i <= 10; i++) {
        const mark = text(`${key}.box.${i}`);
        if (!mark) continue;
        if (SUPERFICIAL.test(mark)) superficial++;
        else if (AGGRAVATED.test(mark)) aggravated++;
        else odd.push(`${i} ("${mark.slice(0, 10)}")`);
      }
      if (odd.length) warnings.push(`${label} box${odd.length > 1 ? 'es' : ''} ${joinList(odd)} ${odd.length > 1 ? 'hold marks' : 'holds a mark'} that isn’t damage (/ for Superficial, X for Aggravated), so ${odd.length > 1 ? 'they were' : 'it was'} ignored.`);
      d[key] = { superficial, aggravated };
    }
    const max = { health: d.attributes.stamina + 3, willpower: d.attributes.composure + d.attributes.resolve };
    for (const [key, label] of [['health', 'Health'], ['willpower', 'Willpower']]) {
      const total = d[key].superficial + d[key].aggravated;
      if (total > max[key]) warnings.push(`${label} shows ${total} damage, but this character’s track has only ${max[key]} boxes. If a Discipline or Merit adds boxes, note it on the sheet.`);
    }
  } else {
    d.hunger = 1;
    d.health = { superficial: 0, aggravated: 0 };
    d.willpower = { superficial: 0, aggravated: 0 };
    warnings.push('Progeny’s PDF doesn’t carry Hunger or damage, so Hunger starts at 1 and Health and Willpower are undamaged.');
    // the boxes Progeny ticks are the character's maximums; more than the Attributes give is a bonus
    for (const [key, bonus, base, label] of [['health.max', 'healthMaxBonus', d.attributes.stamina + 3, 'Health'], ['willpower.max', 'willpowerMaxBonus', d.attributes.composure + d.attributes.resolve, 'Willpower']]) {
      if (n(key) && n(key) !== base) {
        d[bonus] = Math.max(-5, Math.min(10, n(key) - base));
        notes.push(`${label} on the sheet: ${n(key)} boxes (the Attributes give ${base}).`);
      }
    }
  }
  d.bloodPotency = Math.min(10, n('potency'));
  if (!d.bloodPotency && !/thin/i.test(d.clan || '')) { d.bloodPotency = 1; warnings.push('No Blood Potency dots were ticked, so Blood Potency starts at 1.'); }
  d.humanity = Math.min(10, n('humanity'));
  if (!d.humanity) {
    d.humanity = 7;
    warnings.push(official ? 'No Humanity boxes were marked ✔ (some PDF viewers can’t mark them), so Humanity starts at 7.' : 'No Humanity boxes were ticked on this sheet, so Humanity starts at 7.');
  }
  // Elysium tracks Stains; MundusMaker's sheet keeps the number for it
  if (n('stains')) d.stains = Math.min(10, n('stains'));
  imported.push(`Hunger ${d.hunger}, Humanity ${d.humanity}${d.stains ? ` (${plural(d.stains, 'Stain')})` : ''}, Blood Potency ${d.bloodPotency}${official && (d.health.superficial || d.health.aggravated || d.willpower.superficial || d.willpower.aggravated) ? ', and damage' : ''}`);

  d.xp = { total: firstNumber(text('xp.total')) ?? 0, spent: firstNumber(text('xp.spent')) ?? 0, ledger: [] };
  if (d.xp.total || d.xp.spent) imported.push(`Experience: ${d.xp.total} total, ${d.xp.spent} spent`);
  d.notes = notes.filter(Boolean).join('\n\n');
  if (d.history || d.appearance || d.notes) imported.push('History, appearance and notes');
  d.imported = { from: layout.id };
  return { name: text('name').slice(0, 120), data: d, report: { layout: layout.label, imported, warnings } };
}

/**
 * readValues() then buildSheet(): a form (and, for Progeny's PDF, the pictures drawn on its
 * pages) straight to { name, data, report }. Throws an Error that explains, in plain words,
 * a PDF it can't use.
 */
export function characterFromForm(form, images = []) {
  if (!form.fields.length) {
    throw new Error('This PDF has no form fields to read. Printing to PDF, flattening or scanning turns a character sheet’s fields into plain page content, which MundusMaker can’t sort into a sheet. Pick the copy you typed into.');
  }
  const read = readValues(form, images);
  if (!read.layout) {
    throw new Error('This PDF isn’t a V5 sheet MundusMaker knows: the official fillable V5 character sheet from Renegade Game Studios, or the PDF from Progeny’s “Download PDF”. A D&D sheet goes through the D&D card.');
  }
  if (!read.values.size) throw new Error('This copy of the sheet is still empty. Fill it in, save your changes in your PDF viewer, then pick the saved file.');
  return buildSheet(read);
}
