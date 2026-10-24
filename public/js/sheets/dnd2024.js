import { levelUpPanel } from './dndlevelup.js';
// D&D 5.5e (2024 rules) character sheet + creation wizard, powered by the
// bundled SRD 5.2 content pack (public/srd52/, CC-BY-4.0).

import { el, esc, makeRng } from '../util.js';
import { api } from '../api.js';
import { nameFor } from '../names.js';
import { normalizeSpell, normalizeItem } from '../importers.js';
import { linkDice } from '../render.js';
import {
  dotsHtml, boxesHtml, rollBtn, kvHtml, sectionHtml,
  frow, textInput, numInput, areaInput, listEdit, surprisePickButton,
} from './sheetlib.js';

export const label = 'D&D 5.5e (2024)';
export const tagline = 'The 2024 rules, with the whole SRD in the box.';

// ---------- SRD 5.2 data (lazy, cached) ----------

const cache = {};
async function fetchPack(name) {
  if (!cache[name]) {
    const res = await fetch(`/srd52/${name}.json`);
    if (!res.ok) throw new Error(`srd52/${name}.json is missing. Run npm run srd52.`);
    cache[name] = await res.json();
  }
  return cache[name];
}
export async function loadData() {
  const [classes, species, backgrounds, feats, spells, equipment, progression] = await Promise.all(
    ['classes', 'species', 'backgrounds', 'feats', 'spells', 'equipment', 'progression'].map(fetchPack));
  return {
    classes: classes.classes.map(c => {
      const p = progression.classes.find(p => p.name === c.name) || {};
      const sk = p.startingProficiencies?.skills?.[0] || {};
      return { ...c, subclass: c.subclass ? { ...c.subclass, ...p.subclassRules?.find(s => s.name === c.subclass.name) } : null,
        progression: p, skills: { choose: sk.any || sk.choose?.count || c.skills.choose,
        from: (sk.any ? SKILLS.map(([n]) => n) : sk.choose?.from || c.skills.from).map(canonSkill) } };
    }), species: species.species, backgrounds: backgrounds.backgrounds.map(b => ({ ...b,
      skills: b.skills.map(canonSkill), equipment: b.equipment || b.text.match(/Equipment:\.?\s*([^\n]+)/i)?.[1] || '' })),
    feats: feats.feats.map(f => ({ ...f, ...progression.feats?.find(p => p.name === f.name) })), spells: spells.spells, equipment: equipment.equipment,
  };
}

// Bundled classes win name clashes; the creator and advancement also read
// the user's local packs through loadCreatorData().
const lower = (s) => String(s || '').trim().toLowerCase();
const personName = () => nameFor(makeRng(`dnd-wizard:${Date.now()}:${Math.random()}`), 'person');

function clean5eText(s) {
  return String(s || '')
    .replace(/\{@(?:dice|damage) ([^}|]+)(?:\|[^}]*)?}/g, '$1')
    .replace(/\{@(?:spell|item|creature|condition|skill|action|sense|status|classFeature|subclassFeature) ([^}|]+)(?:\|[^}]*)?}/g, '$1')
    .replace(/\{@(?:b|i) ([^}]+)}/g, '$1')
    .replace(/\{@[^ ]+ ([^}|]+)(?:\|[^}]*)?}/g, '$1');
}

function entriesText(value) {
  if (typeof value === 'string') return clean5eText(value);
  if (Array.isArray(value)) return value.map(entriesText).filter(Boolean).join('\n\n');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'table') {
    const rows = (value.rows || []).map((row) => (row || []).map(entriesText).join(' | ')).join('\n');
    return [value.caption, rows].filter(Boolean).join('\n');
  }
  const body = entriesText(value.entries || value.items || value.entry);
  return [value.name ? `${clean5eText(value.name)}.` : '', body].filter(Boolean).join(' ');
}

function importedClassName(feature) {
  return feature?.className || feature?.class?.name || '';
}

function normalizeImportedFeature(feature, packName, kind) {
  const level = Number(feature?.level);
  if (!feature?.name || !Number.isInteger(level) || level < 1 || level > 20) return null;
  return {
    name: clean5eText(feature.name), level,
    text: entriesText(feature.entries), kind,
    pack: packName,
  };
}

/**
 * Resolve one class for the advancement assistant. Bundled SRD class and
 * subclass features are authoritative; locally imported 5etools data is a
 * fallback for non-SRD classes/subclasses and is never written until level-up.
 */
export async function loadAdvancementClass(className, subclassName = '') {
  const data = await loadData();
  const bundled = data.classes.find((c) => lower(c.name) === lower(className));
  const bundledSubclassMatches = lower(bundled?.subclass?.name) === lower(subclassName);
  const out = bundled ? {
    name: bundled.name,
    hitDie: bundled.hitDie,
    source: 'SRD 5.2',
    features: (bundled.features || []).map((f) => ({ ...f, kind: 'class', pack: 'SRD 5.2' })),
    subclassFeatures: bundledSubclassMatches
      ? (bundled.subclass.features || []).map((f) => ({ ...f, kind: 'subclass', pack: 'SRD 5.2' }))
      : [],
  } : null;
  if (out && (!subclassName || bundledSubclassMatches)) return out;

  let packs = [];
  try {
    const relevant = new Set(['class', 'classFeature', 'subclass', 'subclassFeature']);
    const metas = (await api.library()).filter((meta) => !Array.isArray(meta.kinds)
      || meta.kinds.some((kind) => relevant.has(kind)));
    packs = await Promise.all(metas.map(async (meta) => {
      try { return { meta, pack: await api.libraryPack(meta.id) }; }
      catch { return null; }
    }));
  } catch { /* older server, or no imported library */ }

  const wantedClass = lower(className), wantedSubclass = lower(subclassName);
  const importedClassFeatures = [], importedSubclassFeatures = [];
  let importedClass = null;

  for (const item of packs.filter(Boolean)) {
    const { meta, pack } = item;
    const packName = meta.name || 'Imported pack';
    const rawClass = (pack.class || []).find((c) => lower(c.name) === wantedClass);
    if (!importedClass && rawClass) importedClass = rawClass;

    if (!bundled) {
      for (const f of pack.classFeature || []) {
        if (lower(importedClassName(f)) !== wantedClass) continue;
        const normalized = normalizeImportedFeature(f, packName, 'class');
        if (normalized) importedClassFeatures.push(normalized);
      }
    }

    if (wantedSubclass && !(bundled && lower(bundled.subclass?.name) === wantedSubclass)) {
      const aliases = new Set([wantedSubclass]);
      const subclasses = [...(pack.subclass || []), ...((rawClass?.subclasses || []).filter((s) => typeof s === 'object'))];
      for (const sub of subclasses) {
        if (lower(sub.className || className) !== wantedClass) continue;
        if (![lower(sub.name), lower(sub.shortName)].includes(wantedSubclass)) continue;
        aliases.add(lower(sub.name)); aliases.add(lower(sub.shortName));
      }
      for (const f of pack.subclassFeature || []) {
        if (lower(importedClassName(f)) !== wantedClass) continue;
        const sub = lower(f.subclassShortName || f.subclassName);
        if (!aliases.has(sub)) continue;
        const normalized = normalizeImportedFeature(f, packName, 'subclass');
        if (normalized) importedSubclassFeatures.push(normalized);
      }
    }
  }

  if (out) {
    if (!out.subclassFeatures.length) out.subclassFeatures = importedSubclassFeatures;
    return out;
  }
  if (!importedClass && !importedClassFeatures.length) return null;
  return {
    name: importedClass?.name || className,
    hitDie: Number(importedClass?.hd?.faces || importedClass?.hitDie || 8),
    source: 'Imported library',
    features: importedClassFeatures,
    subclassFeatures: importedSubclassFeatures,
  };
}

// ---------- creator data: bundled SRD + the user's imported library (1.2) ----------

const CAP = (s) => String(s || '').replace(/\b\w/g, (ch) => ch.toUpperCase());
// 5etools writes skills lowercase; match ours by name ("sleight of hand" must
// land on "Sleight of Hand", which plain CAP would miss)
const canonSkill = (s) => SKILLS.map(([n]) => n).find((n) => lower(n) === lower(s)) || CAP(s);
const SIZE_WORDS = { T: 'Tiny', S: 'Small', M: 'Medium', L: 'Large' };

function normalizeImportedSpecies(raw, packName) {
  if (!raw?.name) return null;
  return {
    name: clean5eText(raw.name),
    size: (Array.isArray(raw.size) ? raw.size : ['M']).map((s) => SIZE_WORDS[s] || s).join(' or '),
    speed: typeof raw.speed === 'number' ? raw.speed : raw.speed?.walk || 30,
    darkvision: raw.darkvision || 0,
    traits: (raw.entries || []).filter((e) => e?.name)
      .map((e) => ({ name: clean5eText(e.name), text: entriesText(e.entries) })),
    _pack: packName, _source: raw.source || '',
  };
}

function normalizeImportedBackground(raw, packName) {
  if (!raw?.name) return null;
  const abilities = [...new Set((raw.ability || [])
    .flatMap((a) => a.choose?.weighted?.from || a.choose?.from || Object.keys(a).filter((k) => k !== 'choose')))]
    .filter((a) => ABILITIES.includes(a));
  return {
    name: clean5eText(raw.name),
    // 2014-era backgrounds declare no ability bonuses; the wizard then offers all six
    abilities,
    skills: (raw.skillProficiencies || []).flatMap((s) => Object.keys(s).filter((k) => k !== 'choose' && k !== 'any')).map(canonSkill),
    tool: (raw.toolProficiencies || []).flatMap((t) => Object.keys(t)).join(', '),
    feat: (raw.feats || []).flatMap((f) => Object.keys(f)).map((f) => CAP(f.split('|')[0])).join(', '),
    equipment: entriesText((raw.entries || []).filter((e) => /equipment/i.test(e?.name || ''))),
    text: entriesText((raw.entries || []).filter((e) => !e?.name || !/equipment/i.test(e.name))).slice(0, 400),
    skillChoices: (raw.skillProficiencies || []).flatMap(s => s.choose ? [s.choose] : s.any ? [{ count: s.any, from: SKILLS.map(([n]) => n) }] : []),
    _pack: packName, _source: raw.source || '',
  };
}

function normalizeImportedCreatorClass(raw, pack, packName) {
  if (!raw?.name) return null;
  const skillSpec = raw.startingProficiencies?.skills?.[0] || {};
  const skills = skillSpec.choose || {};
  const from = (skills.from || []).map(canonSkill).filter((n) => SKILLS.some(([sk]) => sk === n));
  const features = (pack.classFeature || [])
    .filter((f) => lower(importedClassName(f)) === lower(raw.name) && (!f.classSource || !raw.source || f.classSource === raw.source))
    .map((f) => ({ level: Number(f.level), name: clean5eText(f.name), text: entriesText(f.entries) }));
  return {
    name: clean5eText(raw.name),
    hitDie: Number(raw.hd?.faces || 8),
    saves: (raw.proficiency || []).filter((a) => ABILITIES.includes(a)),
    armor: (raw.startingProficiencies?.armor || []).map(x => clean5eText(typeof x === 'string' ? x : x.full || '')),
    weapons: (raw.startingProficiencies?.weapons || []).map(x => clean5eText(typeof x === 'string' ? x : x.full || '')),
    tools: (raw.startingProficiencies?.tools || []).map(x => clean5eText(typeof x === 'string' ? x : x.full || '')),
    skills: { choose: skillSpec.any || skills.count || 2, from: from.length ? from : SKILLS.map(([n]) => n) },
    primaryAbility: [...new Set((raw.primaryAbility || []).flatMap(a => typeof a === 'string' ? [a] : Object.keys(a)))].filter(a => ABILITIES.includes(a)),
    progression: raw,
    startingEquipment: entriesText(raw.startingEquipment?.entries || raw.startingEquipment?.default || []),
    spellcasting: raw.spellcastingAbility
      ? { ability: raw.spellcastingAbility, progression: raw.casterProgression || 'full' } : null,
    features,
    subclass: null,
    subclasses: [],
    _pack: packName, _source: raw.source || '',
  };
}

let creatorCache = null;
export function invalidateCreatorData() { creatorCache = null; }

/**
 * What the creation wizard sees: bundled SRD 5.2 plus everything
 * creation-shaped from the user's imported library packs. Bundled entries win
 * on a name clash; imported subclasses attach as extra options on any
 * matching class (including the bundled ones).
 */
export async function loadCreatorData() {
  if (creatorCache) return creatorCache;
  const base = await loadData();
  const merged = {
    ...base,
    classes: base.classes.map((c) => ({
      ...c,
      subclasses: c.subclass ? [{ ...c.subclass, _pack: 'SRD 5.2' }] : [],
    })),
    species: [...base.species],
    backgrounds: [...base.backgrounds],
    feats: [...base.feats],
    spells: base.spells.map((s) => ({ ...s })),
    equipment: base.equipment.map(e => ({ ...e, kind: e.category })),
    warnings: [],
  };
  let packs = [];
  try {
    // Re-importing an old pack must make its newer progression available.
    // Bundled rows still win; other name clashes use the newest local import.
    const metas = (await api.library()).sort((a, b) => String(b.imported || '').localeCompare(String(a.imported || '')) || String(a.id).localeCompare(String(b.id)));
    packs = (await Promise.all(metas.map(async (meta) => {
      try { return { meta, pack: await api.libraryPack(meta.id) }; } catch { merged.warnings.push(`Could not load ${meta.name || meta.id}. Reopen the creator after checking the Library.`); return null; }
    }))).filter(Boolean);
  } catch { merged.warnings.push('The local Library could not be read. Bundled SRD choices are still available.'); }

  const seen = (arr) => new Set(arr.map((x) => lower(x.name)));
  const classNames = seen(merged.classes);
  const speciesNames = seen(merged.species);
  const bgNames = seen(merged.backgrounds);
  const featNames = seen(merged.feats);
  const spellNames = seen(merged.spells);
  const equipmentNames = seen(merged.equipment);

  const pendingSubclasses = [];
  for (const { meta, pack } of packs) {
    const packName = meta.name || 'Imported pack';
    for (const raw of pack.class || []) {
      if (classNames.has(lower(raw.name))) continue;
      const norm = normalizeImportedCreatorClass(raw, pack, packName);
      if (norm) { merged.classes.push(norm); classNames.add(lower(norm.name)); }
    }
    for (const sub of pack.subclass || []) {
      if (sub?.name && sub.className) pendingSubclasses.push({ sub, packName, pack });
    }
    for (const raw of pack.race || []) {
      if (!raw?.name || speciesNames.has(lower(raw.name))) continue;
      const norm = normalizeImportedSpecies(raw, packName);
      if (norm) { merged.species.push(norm); speciesNames.add(lower(norm.name)); }
    }
    for (const raw of pack.background || []) {
      if (!raw?.name || bgNames.has(lower(raw.name))) continue;
      const norm = normalizeImportedBackground(raw, packName);
      if (norm) { merged.backgrounds.push(norm); bgNames.add(lower(norm.name)); }
    }
    for (const raw of pack.feat || []) {
      if (!raw?.name || featNames.has(lower(raw.name))) continue;
      merged.feats.push({ name: clean5eText(raw.name), category: ({ O: 'Origin', G: 'General', FS: 'Fighting Style', EB: 'Epic Boon' })[raw.category] || String(raw.category || ''),
        text: entriesText(raw.entries), prerequisite: raw.prerequisite, ability: raw.ability, repeatable: raw.repeatable, _pack: packName, _source: raw.source || '' });
      featNames.add(lower(raw.name));
    }
    for (const raw of pack.spell || []) {
      if (!raw?.name || spellNames.has(lower(raw.name))) continue;
      merged.spells.push({ ...normalizeSpell(raw), _pack: packName, _source: raw.source || '' });
      spellNames.add(lower(raw.name));
    }
    for (const raw of pack.item || []) {
      if (!raw?.name || equipmentNames.has(lower(raw.name))) continue;
      merged.equipment.push({ ...normalizeItem(raw), properties: raw.property || [], mastery: raw.mastery || [], weaponCategory: raw.weaponCategory || '', _pack: packName, _source: raw.source || '' });
      equipmentNames.add(lower(raw.name));
    }
  }
  for (const { sub, packName, pack } of pendingSubclasses) {
    const target = merged.classes.find((c) => lower(c.name) === lower(sub.className));
    if (!target || target.subclasses.some((x) => lower(x.name) === lower(sub.name))) continue;
    target.subclasses.push({ name: clean5eText(sub.name), _pack: packName, _source: sub.source || '', additionalSpells: sub.additionalSpells,
      features: (pack.subclassFeature || []).filter(f => lower(f.className) === lower(sub.className)
        && [lower(sub.shortName), lower(sub.name)].includes(lower(f.subclassShortName || f.subclassName))
        && (!f.subclassSource || !sub.source || f.subclassSource === sub.source))
        .map(f => ({ name: clean5eText(f.name), level: Number(f.level), text: entriesText(f.entries) })) });
  }
  merged.species.sort((a, b) => a.name.localeCompare(b.name));
  merged.backgrounds.sort((a, b) => a.name.localeCompare(b.name));
  creatorCache = merged;
  return merged;
}

// the wizard loads this instead of plain loadData (create.js prefers wizardData)
export const wizardData = loadCreatorData;

// ---------- rules constants ----------

export { ABILITIES, SKILLS, mod, profBonus, defaults } from './dndrules.js';
import { ABILITIES, ABILITY_NAMES, SKILLS, mod, profBonus, defaults, fmtMod, passivePerception, skillBonus, attackBonus } from './dndrules.js';

/** Mutates a sheet by exactly one level and returns the applied changes. */
export function advanceLevel(data, classData, { hpGain, addToCurrent = true } = {}) {
  if (!data?.klass) throw new Error('This sheet has no class to advance.');
  const from = Math.max(1, Number(data.klass.level) || 1);
  if (from >= 20) throw new Error('This character is already level 20.');
  if (!classData || lower(classData.name) !== lower(data.klass.name)) {
    throw new Error(`No advancement data found for ${data.klass.name || 'this class'}.`);
  }
  const to = from + 1;
  const gain = Math.max(1, Math.floor(Number(hpGain) || 1));
  const candidates = [...(classData.features || []), ...(classData.subclassFeatures || [])]
    .filter((f) => Number(f.level) === to);

  data.features ??= [];
  const added = [];
  const seen = new Set();
  for (const f of candidates) {
    const candidateKey = `${f.kind || 'class'}:${lower(f.name)}`;
    if (seen.has(candidateKey)) continue;
    seen.add(candidateKey);
    let source = f.kind === 'subclass'
      ? `${data.klass.subclass || 'Subclass'} ${to}`
      : `${classData.name} ${to}`;
    if (f.pack && f.pack !== 'SRD 5.2') source += ` · ${f.pack}`;
    const duplicate = data.features.some((old) => lower(old.name) === lower(f.name)
      && lower(old.source) === lower(source));
    if (duplicate) continue;
    const feature = { name: f.name, source, text: f.text || '' };
    if (f.pack && f.pack !== 'SRD 5.2') feature.pack = f.pack;
    data.features.push(feature);
    added.push(feature);
  }

  data.klass.level = to;
  data.klass.hitDie = Number(classData.hitDie) || data.klass.hitDie || 8;
  data.hp ??= { max: 0, current: 0, temp: 0 };
  data.hp.max = Math.max(0, Number(data.hp.max) || 0) + gain;
  if (addToCurrent) data.hp.current = Math.max(0, Number(data.hp.current) || 0) + gain;
  data.hitDice ??= { spent: 0 };
  data.hitDice.spent = Math.min(Number(data.hitDice.spent) || 0, to);
  data.advancement ??= { log: [] };
  data.advancement.log ??= [];
  data.advancement.log.push({
    at: new Date().toISOString(), from, to, hpGain: gain,
    features: added.map((f) => f.name),
  });
  if (data.advancement.log.length > 40) data.advancement.log.splice(0, data.advancement.log.length - 40);
  return { from, to, hpGain: gain, features: added };
}

export function summary(data) {
  const d = data || defaults();
  return `Level ${d.klass.level} ${d.species.name} ${d.klass.name}${d.klass.subclass ? ` (${d.klass.subclass})` : ''}`.replace(/\s+/g, ' ').trim();
}

export function searchText(data) {
  const d = data || {};
  return [d.species?.name, d.klass?.name, d.klass?.subclass, d.background?.name,
    ...(d.features || []).map((f) => f.name),
    ...(d.spellcasting?.prepared || []), ...(d.spellcasting?.cantrips || []),
  ].filter(Boolean).join(' ');
}

// ---------- rendered sheet ----------

export function html(data) {
  const d = { ...defaults(), ...(data || {}) };
  const pb = profBonus(d.klass.level);
  const abilityTiles = ABILITIES.map((a) => {
    const m = mod(d.abilities[a]);
    return `<div class="sb-ab"><div class="ab-n">${a.toUpperCase()}</div>` +
      `<div class="ab-v">${esc(d.abilities[a] ?? 10)}</div>` +
      `<div class="ab-m">${rollBtn({ kind: 'check', mod: m, label: `${ABILITY_NAMES[a]} check` }, fmtMod(m), 'Roll — Shift for advantage, Ctrl for disadvantage')}</div></div>`;
  }).join('');

  const saveRow = ABILITIES.map((a) => {
    const isProf = d.saves.includes(a);
    const m = mod(d.abilities[a]) + (isProf ? pb : 0);
    return `<span class="sheet-pill${isProf ? ' on' : ''}">${rollBtn({ kind: 'check', mod: m, label: `${ABILITY_NAMES[a]} save` }, `${a.toUpperCase()} ${fmtMod(m)}`, 'Roll save — Shift/Ctrl for adv/dis')}</span>`;
  }).join(' ');

  const skillRows = SKILLS.map(([name, a]) => {
    const entry = (d.skills || []).find((s) => s.key === name);
    const bonus = skillBonus(d, name, pb);
    const mark = entry ? (entry.prof === 'expert' ? '◉' : '●') : '○';
    return `<div class="sheet-skill">${mark} ${rollBtn({ kind: 'check', mod: bonus, label: name }, `${name} ${fmtMod(bonus)}`, 'Roll — Shift/Ctrl for adv/dis')} <span class="muted">(${a.toUpperCase()})</span></div>`;
  }).join('');

  const toHit = (atk) => { const b = attackBonus(atk); return b == null ? esc(atk.bonus) : rollBtn({ kind: 'check', mod: b, label: `${atk.name} attack` }, `${fmtMod(b)} to hit`, 'Attack roll — Shift/Ctrl adv/dis'); };
  const attacks = (d.attacks || []).length
    ? d.attacks.map((atk) => `<div class="sheet-kv"><span class="sk">${esc(atk.name)}</span><span class="sv">` +
        toHit(atk) +
        ` · ${linkDice(esc(atk.damage || ''))}${atk.notes ? ` <span class="muted">${esc(atk.notes)}</span>` : ''}</span></div>`).join('')
    : '<div class="muted small">No attacks recorded.</div>';

  let spellsHtml = '';
  if (d.spellcasting) {
    const sc = d.spellcasting;
    const slotRows = Object.entries(sc.slots || {}).filter(([, s]) => s.max > 0)
      .map(([lvl, s]) => kvHtml(`Level ${lvl} slots`, boxesHtml(s.max, s.used || 0, `spellcasting.slots.${lvl}.used`, `Level ${lvl} spell slots`)))
      .join('');
    spellsHtml = sectionHtml('Spellcasting',
      kvHtml('Ability', `${esc((sc.ability || '').toUpperCase())} · save DC ${esc(sc.dc ?? '—')} ·${rollBtn({ kind: 'check', mod: sc.attackBonus || 0, label: 'Spell attack' }, `${fmtMod(sc.attackBonus || 0)} to hit`, 'Spell attack roll')}`) +
      slotRows +
      ((sc.cantrips || []).length ? kvHtml('Cantrips', esc(sc.cantrips.join(', '))) : '') +
      ((sc.prepared || []).length ? kvHtml('Prepared', esc(sc.prepared.join(', '))) : ''));
    if (sc.alwaysPrepared?.length) spellsHtml += sectionHtml('Always prepared · subclass', esc(sc.alwaysPrepared.join(', ')));
    if (sc.spellbook?.length) spellsHtml += sectionHtml('Spellbook', esc(sc.spellbook.join(', ')));
  }

  const features = (d.features || []).map((f) =>
    `<div class="sheet-feature"><strong>${esc(f.name)}</strong>${f.source ? ` <span class="muted small">(${esc(f.source)})</span>` : ''}<div class="sheet-feature-text">${esc(f.text || '').replace(/\n/g, '<br>')}</div></div>`).join('');

  const equipment = (d.equipment || []).map((e) => `${esc(e.name)}${e.qty > 1 ? ` ×${esc(e.qty)}` : ''}`).join(', ');
  const initiative = fmtMod(mod(d.abilities.dex) + (d.initiativeBonus || 0));

  return `<div class="sheet sheet-dnd">
    <div class="sheet-head">
      <span class="sheet-title">${esc(summary(d))}</span>
      <span class="muted">${esc(d.background.name ? `${d.background.name} background` : '')}${d.background.feat ? ` · ${esc(d.background.feat)}` : ''}</span>
    </div>
    <div class="sb-abilities">${abilityTiles}</div>
    ${sectionHtml('Combat',
      kvHtml('AC', esc(d.ac)) + kvHtml('Initiative', rollBtn({ kind: 'check', mod: mod(d.abilities.dex) + (d.initiativeBonus || 0), label: 'Initiative' }, initiative, 'Roll initiative')) +
      kvHtml('Speed', `${esc(d.speed)} ft.`) +
      kvHtml('Hit points', `${esc(d.hp.current)} / ${esc(d.hp.max)}${d.hp.temp ? ` (+${esc(d.hp.temp)} temp)` : ''}`) +
      kvHtml('Hit dice', `${boxesHtml(d.klass.level, d.hitDice.spent || 0, 'hitDice.spent', 'Hit dice spent')} d${esc(d.klass.hitDie)}`) +
      kvHtml('Death saves', `${boxesHtml(3, d.deathSaves?.success || 0, 'deathSaves.success', 'Death save successes')} successes · ${boxesHtml(3, d.deathSaves?.failure || 0, 'deathSaves.failure', 'Death save failures')} failures`) +
      kvHtml('Proficiency', fmtMod(pb)))}
    ${sectionHtml('Saving throws', `<div class="sheet-pills">${saveRow}</div>`)}
    ${sectionHtml('Skills', `<div class="sheet-skills">${skillRows}</div>` + kvHtml('Passive Perception', String(passivePerception(d, pb))))}
    ${sectionHtml('Attacks', attacks)}
    ${spellsHtml}
    ${d.innateSpells?.length ? sectionHtml('Species & feat spells', d.innateSpells.map(s => kvHtml(s.name, `${esc(s.source)} · ${esc((s.ability || '').toUpperCase())}${s.uses ? ` · ${esc(s.uses)}/Long Rest` : ''}`)).join('')) : ''}
    ${d.languages?.length ? sectionHtml('Languages & proficiencies', kvHtml('Languages', esc(d.languages.join(', '))) + kvHtml('Training', esc([...(d.proficiencies?.armor || []), ...(d.proficiencies?.weapons || []), ...(d.proficiencies?.tools || [])].join(', ')))) : ''}
    ${features ? sectionHtml('Features & traits', features) : ''}
    ${equipment ? sectionHtml('Equipment', `<div class="small">${equipment}</div>` + kvHtml('Coins', `${esc(d.coins.gp || 0)} gp, ${esc(d.coins.sp || 0)} sp, ${esc(d.coins.cp || 0)} cp`)) : ''}
    ${Object.values(d.personality || {}).some(Boolean) ? sectionHtml('Personality',
      ['traits', 'ideals', 'bonds', 'flaws'].filter((k) => d.personality[k]).map((k) => kvHtml(k[0].toUpperCase() + k.slice(1), esc(d.personality[k]))).join('')) : ''}
    ${d.notes ? sectionHtml('Notes', `<div class="small">${esc(d.notes).replace(/\n/g, '<br>')}</div>`) : ''}
  </div>`;
}

// ---------- editor ----------

export function editor(block, save) {
  const d = block.data = { ...defaults(), ...(block.data || {}) };
  const wrap = el('div', { class: 'sb-form' });

  wrap.append(
    el('div', { class: 'row' },
      frow('Species', textInput(d.species.name, (v) => { d.species.name = v; save(); })),
      frow('Class', textInput(d.klass.name, (v) => { d.klass.name = v; save(); invalidateAdvancePreview(); })),
      frow('Subclass', textInput(d.klass.subclass, (v) => { d.klass.subclass = v; save(); invalidateAdvancePreview(); })),
      frow('Level', numInput(d.klass.level, (v) => { d.klass.level = Math.max(1, v); save(); invalidateAdvancePreview(); }, { min: 1, max: 20 }))),
    el('div', { class: 'row' },
      frow('Background', textInput(d.background.name, (v) => { d.background.name = v; save(); })),
      frow('Origin feat', textInput(d.background.feat, (v) => { d.background.feat = v; save(); }))),
    el('div', { class: 'sb-abrow' },
      ...ABILITIES.map((a) => el('label', {}, a.toUpperCase(),
        numInput(d.abilities[a], (v) => { d.abilities[a] = v; save(); if (a === 'con') invalidateAdvancePreview(); }, { min: 1, max: 30 })))),
    el('div', { class: 'row' },
      frow('AC', numInput(d.ac, (v) => { d.ac = v; if (d.defense) d.defense.automatic = false; save(); })),
      frow('Speed', numInput(d.speed, (v) => { d.speed = v; save(); })),
      frow('HP max', numInput(d.hp.max, (v) => { d.hp.max = v; save(); })),
      frow('HP now', numInput(d.hp.current, (v) => { d.hp.current = v; save(); })),
      frow('Temp', numInput(d.hp.temp, (v) => { d.hp.temp = v; save(); }))),
    el('div', { class: 'row small' }, 'Save proficiencies: ',
      ...ABILITIES.map((a) => el('label', { style: 'display:flex;gap:3px;align-items:center' },
        el('input', {
          type: 'checkbox', checked: d.saves.includes(a),
          onchange: (ev) => {
            d.saves = ev.target.checked ? [...d.saves, a] : d.saves.filter((x) => x !== a);
            save();
          },
        }), a.toUpperCase()))));

  const advanceDetails = levelUpPanel(d, save, loadCreatorData);
  function invalidateAdvancePreview() { advanceDetails.dispatchEvent(new Event('advance-refresh')); }
  wrap.append(advanceDetails);
  wrap.append(el('p', { class: 'small muted' }, 'Changing AC or an attack’s numbers here makes them manual. Level-up preserves those overrides.'));

  // skills: none / proficient / expertise
  const skillsWrap = el('div', { class: 'sheet-edit-skills' });
  for (const [name] of SKILLS) {
    const sel = el('select', {},
      el('option', { value: '' }, '—'),
      el('option', { value: 'prof' }, 'proficient'),
      el('option', { value: 'expert' }, 'expertise'));
    sel.value = (d.skills.find((s) => s.key === name) || {}).prof || '';
    sel.addEventListener('change', () => {
      d.skills = d.skills.filter((s) => s.key !== name);
      if (sel.value) d.skills.push({ key: name, prof: sel.value });
      save();
    });
    skillsWrap.append(el('label', { class: 'small' }, name, sel));
  }
  wrap.append(el('details', {}, el('summary', {}, 'Skills'), skillsWrap));

  function manualAttack(atk) {
    for (const key of ['ability', 'baseDamage', 'monkWeapon', 'weaponDamage', 'proficient', 'ranged']) delete atk[key];
  }
  wrap.append(el('details', {}, el('summary', {}, 'Attacks'),
    listEdit(d.attacks, (atk) => el('span', { class: 'row', style: 'flex:1' },
      textInput(atk.name, (v) => { atk.name = v; save(); }, { placeholder: 'Name', style: 'flex:1' }),
      numInput(atk.bonus, (v) => { atk.bonus = v; manualAttack(atk); save(); }, { title: 'to hit' }),
      textInput(atk.damage, (v) => { atk.damage = v; manualAttack(atk); save(); }, { placeholder: '1d8+3 slashing', style: 'flex:1' })),
      () => ({ name: '', bonus: 0, damage: '' }), save)));

  wrap.append(el('details', {}, el('summary', {}, 'Equipment & coins'),
    listEdit(d.equipment, (eq) => el('span', { class: 'row', style: 'flex:1' },
      textInput(eq.name, (v) => { eq.name = v; save(); }, { style: 'flex:1' }),
      numInput(eq.qty ?? 1, (v) => { eq.qty = v; save(); }, { min: 1 })),
      () => ({ name: '', qty: 1 }), save),
    el('div', { class: 'row' },
      frow('gp', numInput(d.coins.gp, (v) => { d.coins.gp = v; save(); })),
      frow('sp', numInput(d.coins.sp, (v) => { d.coins.sp = v; save(); })),
      frow('cp', numInput(d.coins.cp, (v) => { d.coins.cp = v; save(); })))));

  // spellcasting (toggleable)
  const scWrap = el('div', {});
  const renderSc = () => {
    scWrap.innerHTML = '';
    if (!d.spellcasting) {
      scWrap.append(el('button', {
        class: 'ghost small',
        onclick: () => { d.spellcasting = { ability: 'int', dc: 8 + profBonus(d.klass.level) + mod(d.abilities.int), attackBonus: profBonus(d.klass.level) + mod(d.abilities.int), slots: { 1: { max: 2, used: 0 } }, cantrips: [], prepared: [] }; save(); renderSc(); },
      }, '+ Add spellcasting'));
      return;
    }
    const sc = d.spellcasting;
    scWrap.append(
      el('div', { class: 'row' },
        frow('Ability', textInput(sc.ability, (v) => { sc.ability = v; save(); }, { style: 'width:60px' })),
        frow('Save DC', numInput(sc.dc, (v) => { sc.dc = v; save(); })),
        frow('Attack', numInput(sc.attackBonus, (v) => { sc.attackBonus = v; save(); })),
        el('button', { class: 'ghost danger small', onclick: () => { d.spellcasting = null; save(); renderSc(); } }, 'Remove')),
      el('div', { class: 'row' },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((lvl) => frow(`L${lvl} slots`, numInput(sc.slots?.[lvl]?.max ?? 0, (v) => {
          sc.slots ??= {};
          sc.slots[lvl] = { max: v, used: Math.min(sc.slots[lvl]?.used || 0, v) };
          save();
        }, { min: 0, max: 9 })))),
      frow('Cantrips', textInput((sc.cantrips || []).join(', '), (v) => { sc.cantrips = v.split(',').map((s) => s.trim()).filter(Boolean); save(); }, { placeholder: 'comma-separated', style: 'flex:1' })),
      frow('Prepared', textInput((sc.prepared || []).join(', '), (v) => { sc.prepared = v.split(',').map((s) => s.trim()).filter(Boolean); save(); }, { placeholder: 'comma-separated', style: 'flex:1' })));
  };
  renderSc();
  wrap.append(el('details', {}, el('summary', {}, 'Spellcasting'), scWrap));

  wrap.append(el('details', {}, el('summary', {}, 'Features & traits'),
    listEdit(d.features, (f) => el('span', { style: 'flex:1' },
      el('div', { class: 'row' },
        textInput(f.name, (v) => { f.name = v; save(); }, { placeholder: 'Feature', style: 'flex:1' }),
        textInput(f.source, (v) => { f.source = v; save(); }, { placeholder: 'Source', style: 'width:120px' })),
      areaInput(f.text, (v) => { f.text = v; save(); }, { placeholder: 'What it does…' })),
      () => ({ name: '', source: '', text: '' }), save)));

  wrap.append(el('details', {}, el('summary', {}, 'Personality & notes'),
    ...['traits', 'ideals', 'bonds', 'flaws'].map((k) =>
      frow(k[0].toUpperCase() + k.slice(1), textInput(d.personality[k], (v) => { d.personality[k] = v; save(); }, { style: 'flex:1' }))),
    areaInput(d.notes, (v) => { d.notes = v; save(); }, { placeholder: 'Notes…' })));

  return wrap;
}

// ---------- PDF ----------

export function writePdf(w, data) {
  const d = { ...defaults(), ...(data || {}) };
  const pb = profBonus(d.klass.level);
  w.line(summary(d), { bold: true });
  if (d.background.name) w.line(`${d.background.name} background${d.background.feat ? ` — ${d.background.feat}` : ''}`);
  w.line(ABILITIES.map((a) => `${a.toUpperCase()} ${d.abilities[a]} (${fmtMod(mod(d.abilities[a]))})`).join('   '));
  w.line(`AC ${d.ac}   Initiative ${fmtMod(mod(d.abilities.dex))}   Speed ${d.speed} ft.   HP ${d.hp.max}   Hit dice ${d.klass.level}d${d.klass.hitDie}   Proficiency ${fmtMod(pb)}`);
  w.line(`Passive Perception ${passivePerception(d, pb)}   Death saves: ${d.deathSaves?.success || 0} successes, ${d.deathSaves?.failure || 0} failures`);
  w.line(`Saves: ${ABILITIES.map((a) => `${a.toUpperCase()} ${fmtMod(mod(d.abilities[a]) + (d.saves.includes(a) ? pb : 0))}${d.saves.includes(a) ? '*' : ''}`).join(', ')}`);
  const profSkills = SKILLS.filter(([n]) => d.skills.some((s) => s.key === n));
  if (profSkills.length) {
    w.line(`Skills: ${profSkills.map(([n, a]) => {
      const entry = d.skills.find((s) => s.key === n);
      return `${n} ${fmtMod(mod(d.abilities[a]) + pb * (entry.prof === 'expert' ? 2 : 1))}`;
    }).join(', ')}`);
  }
  for (const atk of d.attacks || []) { const b = attackBonus(atk); w.line(`Attack: ${atk.name} ${b == null ? atk.bonus : `${fmtMod(b)} to hit`}, ${atk.damage || ''} ${atk.notes || ''}`); }
  if (d.spellcasting) {
    const sc = d.spellcasting;
    w.line(`Spellcasting (${(sc.ability || '').toUpperCase()}): DC ${sc.dc}, ${fmtMod(sc.attackBonus || 0)} to hit; slots ${Object.entries(sc.slots || {}).filter(([, s]) => s.max).map(([l, s]) => `L${l}: ${s.max}`).join(', ')}`);
    if (sc.cantrips?.length) w.line(`Cantrips: ${sc.cantrips.join(', ')}`);
    if (sc.prepared?.length) w.line(`Prepared: ${sc.prepared.join(', ')}`);
  }
  if (d.equipment?.length) w.line(`Equipment: ${d.equipment.map((e) => e.qty > 1 ? `${e.name} x${e.qty}` : e.name).join(', ')}`);
  for (const f of d.features || []) w.para(`${f.name}${f.source ? ` (${f.source})` : ''}. ${f.text || ''}`);
  for (const k of ['traits', 'ideals', 'bonds', 'flaws']) {
    if (d.personality?.[k]) w.line(`${k[0].toUpperCase() + k.slice(1)}: ${d.personality[k]}`);
  }
  if (d.notes) w.para(d.notes);
}

export { wizard } from './dndcreator.js';
