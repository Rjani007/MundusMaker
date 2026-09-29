// Familiar sheet layouts (1.9). Each system has ONE section map: the sections
// of that game's standard character sheet, in its order and positions, with
// its field names and conventions (dot tracks, damage boxes, skills grouped
// the same way). The PDF and the in-app sheet both render that map, so screen
// and print agree. Everything is drawn for the project: no publisher logos,
// artwork, borders or fonts, and nothing here calls a layout "official".
// Values come from the existing sheet data; the data model does not change.
//
// Page space: portrait 100 x 129 units, landscape 129 x 100 (US Letter's
// shape). On A4 the page is scaled to fit and centered, so neither clips.

import { ABILITIES, ABILITY_NAMES, SKILLS, mod, fmtMod, profBonus, passivePerception, skillBonus } from './dndrules.js';

const PORTRAIT = [100, 129], LANDSCAPE = [129, 100];
const LABELS = { dnd2024: 'D&D 2024', vtm5: 'VAMPIRE: THE MASQUERADE V5', coc7: 'CALL OF CTHULHU 7TH EDITION' };
export const FAMILIAR_SYSTEMS = Object.keys(LABELS);
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
const str = (v) => (v == null ? '' : String(v));

// Rough capacity of a text area, so both renderers get the same excerpt and
// the rest moves to the continued details.
function fit(text, w, h, size, continuations, title) {
  const value = str(text).trim();
  if (!value) return '';
  const perLine = Math.max(8, Math.floor((w - 2) / (size * 0.5))), lines = Math.max(1, Math.floor(h / (size * 1.3)));
  let used = 0, out = '';
  for (const para of value.split(/\n/)) {
    const need = Math.max(1, Math.ceil(para.length / perLine));
    if (used + need > lines) {
      const room = Math.max(0, (lines - used) * perLine - 12);
      if (room > 20) out += (out ? '\n' : '') + para.slice(0, room).trimEnd() + '…';
      continuations.push({ title, text: value });
      return out + '\n(continued on a later page)';
    }
    out += (out ? '\n' : '') + para; used += need;
  }
  return out;
}

// ---------- D&D 2024 (landscape, two pages) ----------
function dnd(d, name) {
  const cont = [];
  const abs = d.abilities || {}, c = d.klass || {}, hp = d.hp || {}, pb = profBonus(c.level);
  const skillRow = (n) => { const s = d.skills?.find((x) => x.key === n); return { t: 'check', label: n, on: !!s, expert: s?.prof === 'expert', value: fmtMod(skillBonus(d, n, pb)) }; };
  const saveRow = (a) => { const on = !!d.saves?.includes(a); return { t: 'check', label: 'Saving Throw', on, value: fmtMod(mod(abs[a]) + (on ? pb : 0)) }; };
  const ability = (a, x, y, w) => {
    const skills = SKILLS.filter(([, ab]) => ab === a).map(([n]) => n);
    return { title: ABILITY_NAMES[a], x, y, w, h: 8.2 + (skills.length + 1) * 2.3,
      items: [{ t: 'ability', score: abs[a] ?? 10, mod: fmtMod(mod(abs[a])) }, saveRow(a), ...skills.map(skillRow)] };
  };
  const features = d.features || [];
  const isFeat = (f) => /feat/i.test(f.source || '') || f.kind === 'feat';
  const isSpecies = (f) => (d.species?.name && (f.source || '').includes(d.species.name)) || /species|lineage|trait/i.test(f.source || '');
  const names = (list) => list.map((f) => f.name).join('\n');
  const classFeats = features.filter((f) => !isFeat(f) && !isSpecies(f)), speciesTraits = features.filter((f) => !isFeat(f) && isSpecies(f)), feats = features.filter(isFeat);
  if (features.some((f) => f.text)) cont.push(...features.filter((f) => f.text).map((f) => ({ title: [f.name, f.source].filter(Boolean).join(' · '), text: f.text })));
  const attacks = d.attacks || [];
  const prof = d.proficiencies || {};
  const armor = (prof.armor || []).map((s) => String(s).toLowerCase());
  const hasArmor = (k) => armor.some((a) => a.includes(k));

  const page1 = [
    { title: 'Character name', x: 3, y: 3, w: 38, h: 11.5, items: [{ t: 'value', value: name || '', size: 3 }] },
    { title: 'Background', x: 42, y: 3, w: 20, h: 5.6, items: [{ t: 'value', value: d.background?.name }] },
    { title: 'Class', x: 63, y: 3, w: 20, h: 5.6, items: [{ t: 'value', value: c.name }] },
    { title: 'Species', x: 42, y: 8.9, w: 20, h: 5.6, items: [{ t: 'value', value: d.species?.name }] },
    { title: 'Subclass', x: 63, y: 8.9, w: 20, h: 5.6, items: [{ t: 'value', value: c.subclass }] },
    { title: 'Level', x: 84, y: 3, w: 8, h: 11.5, items: [{ t: 'big', value: c.level || 1, sub: d.xp != null ? `XP ${d.xp}` : 'XP' }] },
    { title: 'Armor class', x: 93, y: 3, w: 9, h: 11.5, shield: true, items: [{ t: 'big', value: d.ac ?? 10 }] },
    { title: 'Hit points', x: 103, y: 3, w: 13, h: 11.5, items: [{ t: 'big', value: hp.current ?? 0, sub: `Temp ${hp.temp || 0} · Max ${hp.max ?? 0}` }] },
    { title: 'Hit dice', x: 117, y: 3, w: 9, h: 5.6, items: [{ t: 'value', value: `${c.level || 1}d${c.hitDie || 8} · ${d.hitDice?.spent || 0} used`, size: 1.15 }] },
    { title: 'Death saves', x: 117, y: 8.9, w: 9, h: 5.6, items: [{ t: 'marks', rows: [['S', d.deathSaves?.success || 0, 3, 'deathSaves.success'], ['F', d.deathSaves?.failure || 0, 3, 'deathSaves.failure']] }] },
    { title: 'Proficiency bonus', x: 3, y: 16, w: 19, h: 6.5, items: [{ t: 'big', value: fmtMod(pb), size: 2.6 }] },
    ability('str', 3, 23.5, 19), ability('dex', 3, 37.3, 19), ability('con', 3, 55.7, 19),
    { title: 'Heroic inspiration', x: 3, y: 66.8, w: 19, h: 7.5, items: [{ t: 'check', label: 'Inspired', on: !!d.inspiration }] },
    ability('int', 23, 16, 19), ability('wis', 23, 38.2, 19), ability('cha', 23, 60.4, 19),
    { title: 'Equipment training & proficiencies', x: 3, y: 81, w: 39, h: 16, items: [
      { t: 'row', items: [['Light', 'light'], ['Medium', 'medium'], ['Heavy', 'heavy'], ['Shields', 'shield']].map(([l, k]) => ({ t: 'check', label: l, on: hasArmor(k) })) },
      { t: 'field', label: 'Weapons', value: fit((prof.weapons || []).join(', '), 37, 3, 1.25, cont, 'Weapon proficiencies') },
      { t: 'field', label: 'Tools', value: fit((prof.tools || []).join(', '), 37, 3, 1.25, cont, 'Tool proficiencies') },
    ] },
    { title: 'Initiative', x: 44, y: 16, w: 19.5, h: 8, items: [{ t: 'big', value: fmtMod(mod(abs.dex) + (d.initiativeBonus || 0)) }] },
    { title: 'Speed', x: 64.5, y: 16, w: 19.5, h: 8, items: [{ t: 'big', value: `${d.speed ?? 30} ft` }] },
    { title: 'Size', x: 85, y: 16, w: 19.5, h: 8, items: [{ t: 'big', value: d.species?.size || 'Medium', size: 2 }] },
    { title: 'Passive perception', x: 105.5, y: 16, w: 20.5, h: 8, items: [{ t: 'big', value: passivePerception({ ...d, abilities: abs }, pb) }] },
    { title: 'Weapons & damage cantrips', x: 44, y: 26, w: 82, h: 25, items: [{ t: 'table', cols: [['Name', 34], ['Atk bonus / DC', 16], ['Damage & type', 25], ['Notes', 25]], min: 7,
      rows: attacks.slice(0, 7).map((a) => [a.name, fmtMod(a.bonus || 0), a.damage, a.notes]) }] },
    // two columns hold twice the lines
    { title: 'Class features', x: 44, y: 52.5, w: 82, h: 27, items: [{ t: 'text', value: fit(names(classFeats), 39, 44, 1.3, cont, 'Class features'), columns: 2 }] },
    { title: 'Species traits', x: 44, y: 81, w: 40.5, h: 16, items: [{ t: 'text', value: fit(names(speciesTraits), 38, 12, 1.3, cont, 'Species traits') }] },
    { title: 'Feats', x: 85.5, y: 81, w: 40.5, h: 16, items: [{ t: 'text', value: fit(names(feats), 38, 12, 1.3, cont, 'Feats') }] },
  ];
  if (attacks.length > 7) cont.push({ title: 'All weapons & attacks', text: attacks.map((a) => `${a.name}: ${fmtMod(a.bonus || 0)}; ${a.damage || ''}; ${a.notes || ''}`).join('\n') });

  const sc = d.spellcasting || {};
  const spells = spellList(d);
  const slots = Array.from({ length: 9 }, (_, i) => sc.slots?.[i + 1] || { max: 0, used: 0 });
  const personality = Object.entries(d.personality || {}).filter(([, v]) => str(v).trim()).map(([k, v]) => `${cap(k)}: ${v}`).join('\n');
  const coins = d.coins || {};
  const page2 = [
    { title: 'Spellcasting ability', x: 3, y: 3, w: 15, h: 8, items: [{ t: 'big', value: (sc.ability || '').toUpperCase() || '—', size: 2.4 }] },
    { title: 'Spellcasting modifier', x: 19, y: 3, w: 15, h: 8, items: [{ t: 'big', value: sc.ability ? fmtMod(mod(abs[sc.ability])) : '—', size: 2.4 }] },
    { title: 'Spell save DC', x: 35, y: 3, w: 15, h: 8, items: [{ t: 'big', value: sc.dc ?? '—', size: 2.4 }] },
    { title: 'Spell attack bonus', x: 51, y: 3, w: 15, h: 8, items: [{ t: 'big', value: sc.attackBonus == null ? '—' : fmtMod(sc.attackBonus), size: 2.4 }] },
    { title: 'Spell slots', x: 3, y: 12.5, w: 63, h: 12, items: [{ t: 'slots', slots: slots.map((s, i) => ({ level: i + 1, max: s.max || 0, used: s.used || 0, path: `spellcasting.slots.${i + 1}.used` })) }] },
    { title: 'Cantrips & prepared spells', x: 3, y: 26, w: 63, h: 71, items: [{ t: 'table', cols: [['Level', 8], ['Name', 34], ['Casting time', 18], ['Range', 16], ['C R M', 10], ['Notes', 14]], min: 26,
      rows: spells.slice(0, 26).map((s) => [s.level === 0 ? 'C' : s.level ?? '', s.name, s.castingTime, s.range, [s.concentration ? 'C' : '', s.ritual ? 'R' : '', /M/.test(s.components || '') ? 'M' : ''].filter(Boolean).join(' '), s.note]) }] },
    { title: 'Appearance', x: 68, y: 3, w: 58, h: 14, items: [{ t: 'text', value: fit(d.appearance, 56, 10, 1.3, cont, 'Appearance') }] },
    { title: 'Backstory & personality', x: 68, y: 18.5, w: 58, h: 28, items: [{ t: 'text', value: fit([personality, d.backstory || ''].filter(Boolean).join('\n'), 56, 24, 1.3, cont, 'Backstory & personality') }] },
    { title: 'Alignment', x: 68, y: 48, w: 20, h: 9.5, items: [{ t: 'value', value: d.alignment }] },
    { title: 'Languages', x: 89, y: 48, w: 37, h: 9.5, items: [{ t: 'text', value: fit((d.languages || []).join(', '), 35, 6, 1.3, cont, 'Languages') }] },
    { title: 'Equipment', x: 68, y: 59, w: 38, h: 28, items: [{ t: 'text', value: fit((d.equipment || []).map((e) => `${e.qty || 1} × ${e.name}`).join('\n'), 36, 24, 1.25, cont, 'Equipment') }] },
    { title: 'Magic item attunement', x: 107, y: 59, w: 19, h: 28, items: [{ t: 'lines', values: (d.attuned || []).slice(0, 3), count: 3 }] },
    { title: 'Coins', x: 68, y: 88.5, w: 58, h: 8.5, items: [{ t: 'row', items: ['cp', 'sp', 'ep', 'gp', 'pp'].map((k) => ({ t: 'field', label: k.toUpperCase(), value: coins[k] ?? '' })) }] },
  ];
  if (spells.length > 26) cont.push({ title: 'All spells', text: spells.map((s) => `${s.level === 0 ? 'Cantrip' : `Level ${s.level ?? '?'}`} · ${s.name}${s.note ? ` · ${s.note}` : ''}`).join('\n') });
  for (const s of spells.filter((x) => x.text)) cont.push({ title: s.name, text: [[s.castingTime, s.range, s.components, s.duration].filter(Boolean).join(' · '), s.text, s.higherLevel].filter(Boolean).join('\n\n') });
  if (d.notes) cont.push({ title: 'Notes', text: d.notes });
  cont.push({ title: 'Rules attribution', text: 'Includes material from the System Reference Document 5.2 by Wizards of the Coast LLC, licensed under CC-BY-4.0. Sheet layout drawn by MundusMaker; not an official character sheet.' });
  return { size: LANDSCAPE, pages: [page1, page2], continuations: cont };
}

function spellList(d) {
  const sc = d.spellcasting || {}, found = new Map();
  for (const [list, note] of [[sc.cantrips, ''], [sc.alwaysPrepared, 'Always prepared'], [sc.prepared, ''], [sc.spellbook, 'Spellbook']]) {
    for (const nm of list || []) if (!found.has(nm)) { const detail = d.spellDetails?.find((s) => s.name === nm) || {}; found.set(nm, { ...detail, level: detail.level ?? (list === sc.cantrips ? 0 : undefined), name: nm, note }); }
  }
  for (const s of d.innateSpells || []) if (!found.has(s.name)) found.set(s.name, { ...(d.spellDetails?.find((x) => x.name === s.name) || {}), ...s, note: s.uses ? `${s.uses}/Long Rest` : (s.source || 'Innate') });
  return [...found.values()].sort((a, b) => (a.level ?? 99) - (b.level ?? 99) || a.name.localeCompare(b.name));
}

// ---------- Vampire: The Masquerade V5 (portrait, two pages) ----------
const V5_ATTRS = [['Physical', ['strength', 'dexterity', 'stamina']], ['Social', ['charisma', 'manipulation', 'composure']], ['Mental', ['intelligence', 'wits', 'resolve']]];
const V5_SKILLS = [['Physical', ['Athletics', 'Brawl', 'Craft', 'Drive', 'Firearms', 'Larceny', 'Melee', 'Stealth', 'Survival']],
  ['Social', ['Animal Ken', 'Etiquette', 'Insight', 'Intimidation', 'Leadership', 'Performance', 'Persuasion', 'Streetwise', 'Subterfuge']],
  ['Mental', ['Academics', 'Awareness', 'Finance', 'Investigation', 'Medicine', 'Occult', 'Politics', 'Science', 'Technology']]];

function vtm(d, name) {
  const cont = [];
  const a = d.attributes || {}, sk = d.skills || {};
  const spec = (s) => (d.specialties || []).filter((x) => x.skill === s).map((x) => x.name).join(', ');
  const health = (a.stamina ?? 1) + 3, wp = (a.composure ?? 1) + (a.resolve ?? 1);
  const disciplines = (d.disciplines || []).slice(0, 6);
  while (disciplines.length < 6) disciplines.push(null);
  for (const x of d.disciplines || []) {
    const text = (x.powers || []).map((p) => `${p.name} (level ${p.level})${p.desc ? `\n${p.desc}` : ''}`).join('\n\n');
    if (text) cont.push({ title: `${x.name} ${x.rating}`, text });
  }
  const touch = (d.convictions || []).map((cv, i) => `${cv}${d.touchstones?.[i]?.name ? ` — ${d.touchstones[i].name}` : ''}`).join('\n');
  const page1 = [
    { title: '', x: 3, y: 3, w: 94, h: 16, bare: true, items: [{ t: 'grid', cols: 3, fields: [
      ['Name', name], ['Concept', d.concept], ['Predator', d.predatorType],
      ['Chronicle', d.chronicle], ['Ambition', d.ambition], ['Clan', d.clan],
      ['Sire', d.sire], ['Desire', d.desire], ['Generation', d.generation ? `${d.generation}th` : ''],
    ] }] },
    { title: 'Attributes', x: 3, y: 20, w: 94, h: 13.5, items: [{ t: 'columns', cols: V5_ATTRS.map(([head, list]) => ({ head, items: list.map((k) => ({ t: 'dots', label: cap(k), value: a[k] ?? 1, max: 5, path: `attributes.${k}` })) })) }] },
    { title: 'Health', x: 3, y: 34.5, w: 45.5, h: 7, items: [{ t: 'track', max: health, sup: d.health?.superficial || 0, agg: d.health?.aggravated || 0, path: 'health' }] },
    { title: 'Willpower', x: 51.5, y: 34.5, w: 45.5, h: 7, items: [{ t: 'track', max: wp, sup: d.willpower?.superficial || 0, agg: d.willpower?.aggravated || 0, path: 'willpower' }] },
    { title: 'Skills', x: 3, y: 42.5, w: 94, h: 36, items: [{ t: 'columns', cols: V5_SKILLS.map(([head, list]) => ({ head, items: list.map((s) => ({ t: 'dots', label: s, spec: spec(s), value: sk[s] || 0, max: 5, path: `skills.${s}` })) })) }] },
    { title: 'Disciplines', x: 3, y: 79.5, w: 94, h: 26, items: [{ t: 'cells', cols: 3, cells: disciplines.map((x) => x
      ? { head: x.name, dots: x.rating || 0, lines: (x.powers || []).slice(0, 4).map((p) => p.name) }
      : { head: '', dots: 0, lines: [] }) }] },
    { title: 'Resonance', x: 3, y: 106.5, w: 30, h: 8, items: [{ t: 'value', value: d.resonance }] },
    { title: 'Hunger', x: 34.5, y: 106.5, w: 30, h: 8, items: [{ t: 'boxes', max: 5, used: d.hunger || 0, path: 'hunger' }] },
    { title: 'Humanity', x: 66, y: 106.5, w: 31, h: 8, items: [{ t: 'boxes', max: 10, used: d.humanity ?? 7, path: 'humanity' }] },
    { title: 'Chronicle tenets', x: 3, y: 115.5, w: 30, h: 11, items: [{ t: 'text', value: fit(d.tenets, 28, 7, 1.2, cont, 'Chronicle tenets') }] },
    { title: 'Touchstones & convictions', x: 34.5, y: 115.5, w: 30, h: 11, items: [{ t: 'text', value: fit(touch, 28, 7, 1.2, cont, 'Touchstones & convictions') }] },
    { title: 'Clan bane', x: 66, y: 115.5, w: 31, h: 11, items: [{ t: 'text', value: fit(d.bane, 29, 7, 1.2, cont, 'Clan bane') }] },
  ];
  const advantages = d.advantages || [];
  const advText = (flaw) => advantages.filter((x) => !!x.flaw === flaw).map((x) => `${x.name} ${'•'.repeat(Math.max(0, Math.min(5, x.dots || 0)))}`).join('\n');
  for (const x of advantages.filter((y) => y.desc)) cont.push({ title: `${x.flaw ? 'Flaw' : 'Advantage'} · ${x.name}`, text: x.desc });
  for (const t of (d.touchstones || []).filter((y) => y.desc || y.conviction)) cont.push({ title: `Touchstone · ${t.name}`, text: [t.conviction, t.desc].filter(Boolean).join('\n') });
  const page2 = [
    { title: 'Blood potency', x: 3, y: 3, w: 46, h: 22, items: [
      { t: 'dots', label: 'Potency', value: d.bloodPotency ?? 1, max: 10, path: 'bloodPotency' },
      { t: 'grid', cols: 2, fields: [['Blood surge', d.bloodSurge], ['Mend amount', d.mendAmount], ['Power bonus', d.powerBonus], ['Rouse re-roll', d.rouseReroll], ['Feeding penalty', d.feedingPenalty], ['Bane severity', d.baneSeverity]] },
    ] },
    { title: 'Experience', x: 51, y: 3, w: 46, h: 9, items: [{ t: 'row', items: [{ t: 'field', label: 'Total', value: d.xp?.total ?? 0 }, { t: 'field', label: 'Spent', value: d.xp?.spent ?? 0 }] }] },
    { title: '', x: 51, y: 13.5, w: 46, h: 11.5, bare: true, items: [{ t: 'grid', cols: 2, fields: [['True age', d.trueAge], ['Apparent age', d.apparentAge], ['Date of birth', d.dateOfBirth], ['Date of death', d.dateOfDeath]] }] },
    { title: 'Advantages & flaws', x: 3, y: 26.5, w: 94, h: 38, items: [{ t: 'row', items: [
      { t: 'text', head: 'Merits & backgrounds', value: fit(advText(false), 44, 30, 1.3, cont, 'Merits & backgrounds') },
      { t: 'text', head: 'Flaws', value: fit(advText(true), 44, 30, 1.3, cont, 'Flaws') }] }] },
    { title: 'Appearance', x: 3, y: 66, w: 46, h: 16, items: [{ t: 'text', value: fit(d.appearance, 44, 12, 1.3, cont, 'Appearance') }] },
    { title: 'Distinguishing features', x: 51, y: 66, w: 46, h: 16, items: [{ t: 'text', value: fit(d.features, 44, 12, 1.3, cont, 'Distinguishing features') }] },
    { title: 'History', x: 3, y: 83.5, w: 94, h: 20, items: [{ t: 'text', value: fit(d.history, 92, 16, 1.3, cont, 'History') }] },
    { title: 'Notes', x: 3, y: 105, w: 94, h: 21.5, items: [{ t: 'text', value: fit(d.notes, 92, 17, 1.3, cont, 'Notes') }] },
  ];
  return { size: PORTRAIT, pages: [page1, page2], continuations: cont };
}

// ---------- Call of Cthulhu 7th edition (portrait, two pages) ----------
function coc(d, name) {
  const cont = [];
  const ch = d.characteristics || {};
  const stat = (k, label = k) => ({ label, value: ch[k] ?? 0, half: Math.floor((ch[k] ?? 0) / 2), fifth: Math.floor((ch[k] ?? 0) / 5) });
  const bases = d.skillBases || {};
  const baseOf = (n) => { const b = bases[n]; return b == null ? '' : typeof b === 'number' ? `${String(b).padStart(2, '0')}%` : b === 'EDU' ? 'EDU' : 'half DEX'; };
  const skills = (d.skills || []).slice().sort((x, y) => x.name.localeCompare(y.name));
  const perCol = Math.max(16, Math.ceil(skills.length / 3));
  const cols = [0, 1, 2].map((i) => skills.slice(i * perCol, (i + 1) * perCol));
  if (skills.length > perCol * 3) cont.push({ title: 'More skills', text: skills.slice(perCol * 3).map((s) => `${s.name}: ${s.value}%`).join('\n') });
  const weapons = [{ name: 'Unarmed', skill: (skills.find((s) => s.name === 'Fighting (Brawl)')?.value ?? 25), damage: `1D3${d.damageBonus && d.damageBonus !== '0' ? ` + ${d.damageBonus}` : ''}`, range: '—', attacks: '1' }, ...(d.weapons || [])];
  const b = d.backstory || {};
  const back = [['Personal description', b.description], ['Ideology / beliefs', b.ideology], ['Significant people', b.significantPeople], ['Meaningful locations', b.meaningfulLocations],
    ['Treasured possessions', b.treasuredPossessions], ['Traits', b.traits], ['Injuries & scars', b.injuries], ['Phobias & manias', b.phobias],
    ['Arcane tomes, spells & artifacts', b.tomes], ['Encounters with strange entities', b.encounters]];
  const page1 = [
    { title: 'Investigator', x: 3, y: 3, w: 47, h: 26, items: [['Name', name], ['Player', d.player], ['Occupation', d.occupation?.name], ['Age', d.age], ['Sex', d.sex], ['Residence', d.residence], ['Birthplace', d.birthplace]].map(([label, value]) => ({ t: 'line', label, value })) },
    { title: 'Characteristics', x: 51, y: 3, w: 46, h: 26, items: [{ t: 'stats', cols: 3, stats: [stat('STR'), stat('DEX'), stat('INT'), stat('CON'), stat('APP'), stat('POW'), stat('SIZ'), stat('EDU'), { label: 'Move rate', value: d.move ?? 8 }] }] },
    { title: 'Hit points', x: 3, y: 30.5, w: 22, h: 17, items: [{ t: 'field', label: 'Max', value: d.hp?.max ?? 0 }, { t: 'numtrack', from: 0, to: Math.max(d.hp?.max ?? 0, 1), current: d.hp?.current ?? 0, perRow: 10 }] },
    { title: 'Sanity', x: 26, y: 30.5, w: 35, h: 17, items: [{ t: 'row', items: [{ t: 'field', label: 'Start', value: d.san?.start ?? '' }, { t: 'field', label: 'Max', value: d.san?.max ?? 99 }] },
      { t: 'row', items: [{ t: 'check', label: 'Temporary insanity', on: !!d.tempInsane }, { t: 'check', label: 'Indefinite insanity', on: !!d.indefInsane }] },
      { t: 'numtrack', from: 0, to: 99, current: d.san?.current ?? 0, perRow: 20 }] },
    { title: 'Luck', x: 62, y: 30.5, w: 17, h: 17, items: [{ t: 'big', value: d.luck ?? 0 }] },
    { title: 'Magic points', x: 80, y: 30.5, w: 17, h: 17, items: [{ t: 'field', label: 'Max', value: d.mp?.max ?? 0 }, { t: 'numtrack', from: 0, to: Math.max(d.mp?.max ?? 0, 1), current: d.mp?.current ?? 0, perRow: 8 }] },
    { title: 'Investigator skills', x: 3, y: 49, w: 94, h: 52.5, items: [{ t: 'skillcols', cols: cols.map((list) => list.map((s) => ({ name: s.name, base: baseOf(s.name), value: s.value ?? 0, improve: !!s.improve }))) }] },
    { title: 'Weapons', x: 3, y: 102.5, w: 66, h: 24, items: [{ t: 'table', cols: [['Weapon', 26], ['Regular', 10], ['Hard', 8], ['Extreme', 10], ['Damage', 16], ['Range', 10], ['Attacks', 8], ['Ammo', 6], ['Malf', 6]], min: 6,
      rows: weapons.slice(0, 7).map((w) => { const v = Number(w.skill) || 0; return [w.name, `${v}%`, Math.floor(v / 2), Math.floor(v / 5), w.damage, w.range, w.attacks ?? '', w.ammo ?? '', w.malf ?? '']; }) }] },
    { title: 'Combat', x: 70, y: 102.5, w: 27, h: 24, items: [{ t: 'field', label: 'Damage bonus', value: d.damageBonus ?? '0' }, { t: 'field', label: 'Build', value: d.build ?? 0 },
      { t: 'field', label: 'Dodge', value: `${d.dodge ?? 0}% · ${Math.floor((d.dodge ?? 0) / 2)} · ${Math.floor((d.dodge ?? 0) / 5)}` }] },
  ];
  if ((d.weapons || []).length > 6) cont.push({ title: 'All weapons', text: d.weapons.map((w) => `${w.name} · ${w.skill}% · ${w.damage} · ${w.range || ''}`).join('\n') });
  const page2 = [
    { title: 'Backstory', x: 3, y: 3, w: 94, h: 62, items: [{ t: 'row', items: [0, 1].map((col) => ({ t: 'stack', items: back.filter((_, i) => i % 2 === col).map(([head, value]) => ({ t: 'text', head, value: fit(value, 44, 8.5, 1.25, cont, head) })) })) }] },
    { title: 'Gear & possessions', x: 3, y: 66.5, w: 46, h: 38, items: [{ t: 'text', value: fit((d.gear || []).map((g) => g.name || g).join('\n'), 44, 34, 1.3, cont, 'Gear & possessions') }] },
    { title: 'Cash & assets', x: 51, y: 66.5, w: 46, h: 18, items: [{ t: 'field', label: 'Spending level', value: d.spendingLevel }, { t: 'field', label: 'Cash', value: d.cash }, { t: 'field', label: 'Assets', value: fit(d.assets, 44, 3, 1.3, cont, 'Assets') }] },
    { title: 'Fellow investigators', x: 51, y: 86, w: 46, h: 18.5, items: [{ t: 'lines', values: d.fellows || [], count: 5 }] },
    { title: 'Notes', x: 3, y: 106, w: 94, h: 20.5, items: [{ t: 'text', value: fit(d.notes, 92, 16, 1.3, cont, 'Notes') }] },
  ];
  return { size: PORTRAIT, pages: [page1, page2], continuations: cont };
}

/** The section map filled with one character's data. Pure; Node tests use it. */
export function familiarModel(system, data, { name = '' } = {}) {
  const d = data || {};
  if (system === 'dnd2024') return dnd(d, name);
  if (system === 'vtm5') return vtm(d, name);
  if (system === 'coc7') return coc(d, name);
  return null;
}

// ---------- item heights (units), shared by both renderers ----------
export const SECTION_TOP = (s) => (s.bare || !s.title ? PAD : TITLE_H);
const TITLE_H = 2.3, PAD = 0.9;
export function itemHeight(it, w) {
  switch (it.t) {
    case 'value': return (it.size || 1.6) * 1.4;
    case 'field': return 4.2;
    case 'line': return 3.3;
    case 'check': case 'dots': return it.spec ? 3.2 : 2.3;
    case 'ability': return 5.6;
    case 'track': case 'boxes': return 3.4;
    case 'marks': return it.rows.length * 1.55 + 0.3;
    case 'grid': return Math.ceil(it.fields.length / it.cols) * 4.4;
    case 'row': return Math.max(...it.items.map((x) => itemHeight(x, w / it.items.length)));
    case 'stack': return it.items.reduce((n, x) => n + itemHeight(x, w), 0);
    case 'columns': return 2.4 + Math.max(...it.cols.map((c) => c.items.reduce((n, x) => n + itemHeight(x, w / it.cols.length), 0)));
    case 'text': return (it.head ? 2 : 0) + Math.ceil(Math.max(1, str(it.value).split('\n').length) / (it.columns || 1)) * 1.75;
    case 'table': return 2.3 + Math.max(it.min || 0, it.rows.length) * 2.35;
    default: return 0;
  }
}

// ---------- PDF ----------

/**
 * Write one sheet in its familiar layout. `safe` is the caller's PDF text
 * sanitizer (pdfSafe); every page, continuation pages included, carries the
 * edition banner. `firstPage` draws onto the document's current page first.
 */
export function writeFamiliarSheet(doc, system, data, { name, gm = false, secret = false, safe = (s) => s, firstPage = false, format = 'a4', footer = true }) {
  const model = familiarModel(system, data, { name });
  if (!model) return;
  const [PW, PH] = model.size, landscape = PW > PH;
  const ink = [30, 31, 36], gray = [104, 108, 118], line = [120, 124, 132];
  const banner = secret ? 'GM SECRET' : gm ? 'GM EDITION' : 'PLAYER COPY';
  let first = firstPage, pageW, pageH, u, ox, oy;
  const newPage = (land) => {
    if (first) first = false;
    else doc.addPage(format, land ? 'landscape' : 'portrait');
    pageW = doc.internal.pageSize.getWidth(); pageH = doc.internal.pageSize.getHeight();
  };
  const setGeometry = (pw, ph) => {
    u = Math.min(pageW / pw, pageH / ph); ox = (pageW - pw * u) / 2; oy = (pageH - ph * u) / 2;
  };
  const X = (v) => ox + v * u, Y = (v) => oy + v * u;
  const font = (size, bold = false, color = ink) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size * u); doc.setTextColor(...color); };
  const say = (value, x, y, size, opts = {}) => {
    font(size, opts.bold, opts.color || ink);
    const t = safe(str(value));
    if (!t) return;
    let out = t;
    if (opts.maxW) { while (out.length > 1 && doc.getTextWidth(out) > opts.maxW * u) out = out.slice(0, -2) + '…'; }
    doc.text(out, X(x), Y(y), { align: opts.align || 'left', baseline: 'alphabetic' });
  };
  const circle = (x, y, r, filled) => { doc.setDrawColor(...line); doc.setFillColor(...ink); doc.setLineWidth(0.15 * u); doc.circle(X(x), Y(y), r * u, filled ? 'FD' : 'S'); };
  const box = (x, y, w, h, filled) => { doc.setDrawColor(...line); doc.setFillColor(...ink); doc.setLineWidth(0.15 * u); doc.rect(X(x), Y(y), w * u, h * u, filled ? 'FD' : 'S'); };
  const rule = (x1, y1, x2, y2, width = 0.12) => { doc.setDrawColor(...line); doc.setLineWidth(width * u); doc.line(X(x1), Y(y1), X(x2), Y(y2)); };
  const bannerLine = (width) => {
    say(LABELS[system], 3, 1.9, 1.05, { bold: true, color: gray });
    say(`${banner} · familiar layout`, width - 3, 1.9, 1.05, { bold: true, color: secret ? [138, 60, 120] : gray, align: 'right' });
  };

  function drawItem(it, x, y, w) {
    const h = itemHeight(it, w);
    switch (it.t) {
      case 'value': say(it.value, x, y + (it.size || 1.6) * 1.05, it.size || 1.6, { bold: (it.size || 1.6) > 2, maxW: w }); break;
      case 'field': say(it.value, x + 0.3, y + 2, 1.45, { maxW: w - 0.6 }); rule(x, y + 2.6, x + w - 0.5, y + 2.6); say(it.label.toUpperCase(), x + 0.3, y + 3.7, 0.95, { color: gray, bold: true, maxW: w - 0.6 }); break;
      case 'line': say(it.label, x, y + 2.2, 1.15, { color: gray, bold: true }); rule(x + 11, y + 2.6, x + w, y + 2.6); say(it.value, x + 11.5, y + 2.2, 1.45, { maxW: w - 12 }); break;
      case 'check': {
        circle(x + 0.9, y + 1.2, 0.65, it.on); if (it.expert) circle(x + 0.9, y + 1.2, 1.0, false);
        say(it.label, x + 2.3, y + 1.65, 1.2, { maxW: w - (it.value ? 6.5 : 2.5) });
        if (it.value != null) say(it.value, x + w - 0.6, y + 1.65, 1.25, { bold: true, align: 'right' });
        break;
      }
      case 'dots': {
        const dw = 1.55, dx = x + w - it.max * dw - 0.4;
        say(it.label, x + 0.3, y + 1.65, 1.2, { maxW: dx - x - 0.8 });
        if (it.spec) say(it.spec, x + 0.9, y + 2.9, 0.95, { color: gray, maxW: dx - x - 1.2 });
        for (let i = 0; i < it.max; i++) circle(dx + i * dw + 0.7, y + 1.2, 0.55, i < it.value);
        break;
      }
      case 'track': case 'boxes': {
        const n = Math.min(it.max, 20), bw = Math.min(2.2, (w - 1) / n);
        for (let i = 0; i < n; i++) {
          const bx = x + 0.4 + i * bw;
          if (it.t === 'boxes') { box(bx, y + 0.4, bw - 0.5, bw - 0.5, i < it.used); continue; }
          box(bx, y + 0.4, bw - 0.5, bw - 0.5, false);
          const state = i < it.agg ? 2 : i < it.agg + it.sup ? 1 : 0;
          if (state) rule(bx, y + 0.4 + bw - 0.5, bx + bw - 0.5, y + 0.4, 0.2);
          if (state === 2) rule(bx, y + 0.4, bx + bw - 0.5, y + 0.4 + bw - 0.5, 0.2);
        }
        break;
      }
      case 'marks': it.rows.forEach(([label, value, max], r) => { say(label, x, y + 1.3 + r * 1.55, 1.0, { bold: true, color: gray }); for (let i = 0; i < max; i++) circle(x + 2.4 + i * 1.5, y + 0.95 + r * 1.55, 0.5, i < value); }); break;
      case 'ability': {
        say(it.mod, x + w / 2, y + 3.3, 2.8, { bold: true, align: 'center' });
        doc.setDrawColor(...line); doc.setLineWidth(0.15 * u); doc.roundedRect(X(x + w / 2 - 2.4), Y(y + 3.9), 4.8 * u, 1.6 * u, 0.6 * u, 0.6 * u, 'S');
        say(it.score, x + w / 2, y + 5.1, 1.1, { align: 'center' });
        break;
      }
      case 'big': say(it.value, x + w / 2, y + (it.size || 3.2) * 1.02, it.size || 3.2, { bold: true, align: 'center', maxW: w }); if (it.sub) say(it.sub, x + w / 2, y + (it.size || 3.2) * 1.02 + 2, 1.0, { color: gray, align: 'center', maxW: w }); break;
      case 'grid': it.fields.forEach(([label, value], i) => drawItem({ t: 'field', label, value }, x + (i % it.cols) * (w / it.cols), y + Math.floor(i / it.cols) * 4.4, w / it.cols - 1)); break;
      case 'row': it.items.forEach((child, i) => drawItem(child, x + i * (w / it.items.length), y, w / it.items.length - 0.8)); break;
      case 'stack': { let yy = y; for (const child of it.items) { drawItem(child, x, yy, w); yy += itemHeight(child, w); } break; }
      case 'columns': {
        const cw = w / it.cols.length;
        it.cols.forEach((c, i) => { say(c.head.toUpperCase(), x + i * cw + cw / 2, y + 1.6, 1.1, { bold: true, color: gray, align: 'center' }); let yy = y + 2.4; for (const child of c.items) { drawItem(child, x + i * cw + 0.3, yy, cw - 1.2); yy += itemHeight(child, cw); } });
        break;
      }
      case 'text': {
        let yy = y;
        if (it.head) { say(it.head.toUpperCase(), x + 0.3, yy + 1.4, 1.0, { bold: true, color: gray }); yy += 2; }
        font(1.25);
        const cols = it.columns || 1, cw = w / cols, all = str(it.value).split('\n').flatMap((p) => doc.splitTextToSize(safe(p), (cw - 1) * u));
        const per = Math.ceil(all.length / cols);
        all.forEach((ln, i) => { const c = Math.floor(i / per); doc.text(ln, X(x + 0.3 + c * cw), Y(yy + 1.35 + (i - c * per) * 1.75)); });
        break;
      }
      case 'lines': for (let i = 0; i < it.count; i++) { rule(x + 0.3, y + 3 + i * 3.2, x + w - 0.3, y + 3 + i * 3.2); say(it.values[i] || '', x + 0.5, y + 2.6 + i * 3.2, 1.3, { maxW: w - 1 }); } break;
      case 'slots': {
        const sw = w / 9;
        it.slots.forEach((s, i) => {
          const sx = x + i * sw;
          say(`LEVEL ${s.level}`, sx + sw / 2, y + 1.3, 0.9, { bold: true, color: gray, align: 'center' });
          say(`Total ${s.max || '—'}`, sx + sw / 2, y + 3.1, 1.05, { align: 'center' });
          for (let k = 0; k < Math.min(4, s.max); k++) box(sx + 0.8 + k * 1.5, y + 4.2, 1.1, 1.1, k < s.used);
          if (s.max > 4) say(`${s.used}/${s.max}`, sx + sw / 2, y + 7.2, 0.95, { color: gray, align: 'center' });
        });
        break;
      }
      case 'cells': {
        const cw = w / it.cols, ch = 11.2;
        it.cells.forEach((c, i) => {
          const cx = x + (i % it.cols) * cw, cy = y + Math.floor(i / it.cols) * ch;
          rule(cx + 0.3, cy + 2.3, cx + cw - 5.5, cy + 2.3); say(c.head, cx + 0.5, cy + 1.9, 1.3, { bold: true, maxW: cw - 7 });
          for (let k = 0; k < 5; k++) circle(cx + cw - 5 + k * 1.05, cy + 1.5, 0.42, k < c.dots);
          for (let k = 0; k < 4; k++) { rule(cx + 0.3, cy + 4.6 + k * 2, cx + cw - 1, cy + 4.6 + k * 2, 0.08); say(c.lines[k] || '', cx + 0.6, cy + 4.3 + k * 2, 1.1, { maxW: cw - 1.5 }); }
        });
        break;
      }
      case 'stats': {
        const cw = w / it.cols, rh = 7.2;
        it.stats.forEach((s, i) => {
          const sx = x + (i % it.cols) * cw, sy = y + Math.floor(i / it.cols) * rh;
          say(s.label, sx + 0.4, sy + 1.7, 1.1, { bold: true, color: gray, maxW: cw - 1 });
          doc.setDrawColor(...line); doc.setLineWidth(0.15 * u); doc.rect(X(sx + 0.4), Y(sy + 2.3), (cw * 0.55) * u, 4.2 * u, 'S');
          say(s.value, sx + 0.4 + cw * 0.275, sy + 5.6, 2.3, { bold: true, align: 'center' });
          if (s.half != null) { say(s.half, sx + cw * 0.62 + 1.6, sy + 3.9, 1.1, { align: 'center' }); say(s.fifth, sx + cw * 0.62 + 1.6, sy + 6.1, 1.1, { align: 'center' }); rule(sx + cw * 0.62, sy + 4.5, sx + cw - 0.6, sy + 4.5, 0.08); }
        });
        break;
      }
      case 'numtrack': {
        const count = it.to - it.from + 1, per = it.perRow, cw = w / per;
        for (let n = it.from; n <= it.to; n++) {
          const i = n - it.from, cx = x + (i % per) * cw + cw / 2, cy = y + 1.4 + Math.floor(i / per) * 1.55;
          say(n, cx, cy, n === it.current ? 1.05 : 0.95, { align: 'center', bold: n === it.current, color: n === it.current ? ink : gray });
          if (n === it.current) { doc.setDrawColor(...ink); doc.setLineWidth(0.18 * u); doc.circle(X(cx), Y(cy - 0.35), 0.85 * u, 'S'); }
        }
        void count;
        break;
      }
      case 'skillcols': {
        const cw = w / it.cols.length;
        it.cols.forEach((list, c) => list.forEach((s, r) => {
          const sx = x + c * cw, sy = y + r * 2.15;
          box(sx + 0.3, sy + 0.55, 1.05, 1.05, s.improve);
          say(`${s.name}${s.base ? ` (${s.base})` : ''}`, sx + 1.9, sy + 1.5, 1.08, { maxW: cw - 9.5 });
          say(s.value, sx + cw - 5.2, sy + 1.55, 1.2, { bold: true, align: 'right' });
          say(`${Math.floor(s.value / 2)} ${Math.floor(s.value / 5)}`, sx + cw - 0.8, sy + 1.55, 0.95, { color: gray, align: 'right' });
        }));
        break;
      }
      case 'table': {
        const total = it.cols.reduce((n, [, cw]) => n + cw, 0);
        let cx = x;
        const xs = it.cols.map(([, cw]) => { const at = cx; cx += (cw / total) * w; return at; });
        it.cols.forEach(([label], i) => say(label.toUpperCase(), xs[i] + 0.3, y + 1.5, 0.9, { bold: true, color: gray, maxW: (it.cols[i][1] / total) * w - 0.5 }));
        const rows = Math.max(it.min || 0, it.rows.length);
        for (let r = 0; r < rows; r++) {
          const ry = y + 2.3 + r * 2.35;
          rule(x, ry + 2.1, x + w, ry + 2.1, 0.08);
          (it.rows[r] || []).forEach((v, i) => say(v, xs[i] + 0.3, ry + 1.6, 1.15, { maxW: (it.cols[i][1] / total) * w - 0.6 }));
        }
        break;
      }
      default: break;
    }
    return h;
  }

  model.pages.forEach((sections, pageIndex) => {
    newPage(landscape);
    setGeometry(PW, PH);
    bannerLine(PW);
    for (const s of sections) {
      if (!s.bare) {
        doc.setDrawColor(...line); doc.setLineWidth(0.18 * u);
        if (s.shield) {
          const cx = s.x + s.w / 2;
          doc.lines([[s.w / 2 * u, 0], [0, s.h * 0.55 * u], [-s.w / 2 * u, s.h * 0.45 * u], [-s.w / 2 * u, -s.h * 0.45 * u], [0, -s.h * 0.55 * u]], X(cx), Y(s.y), [1, 1], 'S', true);
        } else doc.roundedRect(X(s.x), Y(s.y), s.w * u, s.h * u, 0.8 * u, 0.8 * u, 'S');
        if (s.title) say(s.title.toUpperCase(), s.shield ? s.x + s.w / 2 : s.x + PAD, s.y + 1.6, 1.0, { bold: true, color: gray, align: s.shield ? 'center' : 'left', maxW: s.w - 1 });
      }
      let y = s.y + (s.bare || !s.title ? PAD : TITLE_H);
      for (const it of s.items) y += drawItem(it, s.x + PAD, y, s.w - PAD * 2);
    }
    if (footer) say(`MundusMaker · page ${pageIndex + 1}`, 3, PH - 0.8, 0.9, { color: gray });
  });

  // continuation pages: portrait text, banner repeated on every page
  if (model.continuations.length) {
    const PW2 = 100, PH2 = 129;
    let y = 0;
    const contPage = (title) => { newPage(false); setGeometry(PW2, PH2); bannerLine(PW2); say(`${name || 'Character'} · ${title}`, 3, 6, 1.9, { bold: true }); rule(3, 7.3, 97, 7.3); y = 10; };
    contPage('continued details');
    for (const entry of model.continuations) {
      font(1.5, true); const head = doc.splitTextToSize(safe(entry.title), 94 * u);
      font(1.3); const body = String(entry.text || '').split('\n').flatMap((p) => doc.splitTextToSize(safe(p), 94 * u));
      if (y + head.length * 2 + 4 > PH2 - 4) contPage('continued details');
      for (const ln of head) { font(1.5, true); doc.text(ln, X(3), Y(y)); y += 2; }
      y += 0.6;
      for (const ln of body) {
        if (y > PH2 - 4) { contPage('continued details'); font(1.3, true); doc.text(safe(`${entry.title} · continued`), X(3), Y(y)); y += 2.4; }
        font(1.3); doc.text(ln, X(3), Y(y)); y += 1.75;
      }
      y += 2.4;
    }
  }
}

// ---------- HTML (the in-app sheet) ----------

const esc = (s) => str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const em = (v) => `${Math.round(v * 100) / 100}em`;

function itemHtml(it) {
  switch (it.t) {
    case 'value': return `<div class="fam-value" style="font-size:${em(it.size || 1.6)}">${esc(it.value)}</div>`;
    case 'field': return `<div class="fam-field"><div class="fam-fv">${esc(it.value)}</div><div class="fam-fl">${esc(it.label)}</div></div>`;
    case 'line': return `<div class="fam-line"><span class="fam-ll">${esc(it.label)}</span><span class="fam-lv">${esc(it.value)}</span></div>`;
    case 'check': return `<div class="fam-check"><span class="fam-bubble${it.on ? ' on' : ''}${it.expert ? ' expert' : ''}"></span><span class="fam-cl">${esc(it.label)}</span>${it.value != null ? `<b>${esc(it.value)}</b>` : ''}</div>`;
    case 'dots': {
      let dots = `<span class="dots"${it.path ? ` data-dots="${esc(it.path)}"` : ''}>`;
      for (let i = 1; i <= it.max; i++) dots += `<span class="dot-p${i <= it.value ? ' on' : ''}"${it.path ? ` data-dot="${i}"` : ''}></span>`;
      return `<div class="fam-dots"><span class="fam-cl">${esc(it.label)}${it.spec ? `<i>${esc(it.spec)}</i>` : ''}</span>${dots}</span></div>`;
    }
    case 'track': {
      let out = `<span class="track"${it.path ? ` data-track="${esc(it.path)}"` : ''}>`;
      for (let i = 0; i < it.max; i++) { const s = i < it.agg ? 'agg' : i < it.agg + it.sup ? 'sup' : ''; out += `<span class="track-box ${s}" data-box="${i}">${s === 'agg' ? '✕' : s === 'sup' ? '╱' : ''}</span>`; }
      return `<div class="fam-track">${out}</span></div>`;
    }
    case 'boxes': {
      let out = `<span class="track"${it.path ? ` data-track="${esc(it.path)}" data-mode="fill"` : ''}>`;
      for (let i = 0; i < it.max; i++) out += `<span class="track-box${i < it.used ? ' agg' : ''}" data-box="${i}">${i < it.used ? '■' : ''}</span>`;
      return `<div class="fam-track">${out}</span></div>`;
    }
    case 'marks': return it.rows.map(([label, value, max, path]) => `<div class="fam-marks"><b>${esc(label)}</b><span class="dots" data-dots="${esc(path)}">${Array.from({ length: max }, (_, i) => `<span class="dot-p${i < value ? ' on' : ''}" data-dot="${i + 1}"></span>`).join('')}</span></div>`).join('');
    case 'ability': return `<div class="fam-ability"><div class="fam-mod">${esc(it.mod)}</div><div class="fam-score">${esc(it.score)}</div></div>`;
    case 'big': return `<div class="fam-big" style="font-size:${em(it.size || 3.2)}">${esc(it.value)}</div>${it.sub ? `<div class="fam-sub">${esc(it.sub)}</div>` : ''}`;
    case 'grid': return `<div class="fam-grid" style="grid-template-columns:repeat(${it.cols},1fr)">${it.fields.map(([label, value]) => itemHtml({ t: 'field', label, value })).join('')}</div>`;
    case 'row': return `<div class="fam-row">${it.items.map((x) => `<div>${itemHtml(x)}</div>`).join('')}</div>`;
    case 'stack': return it.items.map(itemHtml).join('');
    case 'columns': return `<div class="fam-row">${it.cols.map((c) => `<div><div class="fam-colhead">${esc(c.head)}</div>${c.items.map(itemHtml).join('')}</div>`).join('')}</div>`;
    case 'text': return `${it.head ? `<div class="fam-colhead left">${esc(it.head)}</div>` : ''}<div class="fam-text"${it.columns ? ` style="column-count:${it.columns}"` : ''}>${esc(it.value).replace(/\n/g, '<br>')}</div>`;
    case 'lines': return Array.from({ length: it.count }, (_, i) => `<div class="fam-ruled">${esc(it.values[i] || '')}</div>`).join('');
    case 'slots': return `<div class="fam-slots">${it.slots.map((s) => {
      let boxes = `<span class="track" data-track="${esc(s.path)}" data-mode="fill">`;
      for (let i = 0; i < s.max; i++) boxes += `<span class="track-box${i < s.used ? ' agg' : ''}" data-box="${i}">${i < s.used ? '■' : ''}</span>`;
      return `<div><div class="fam-fl">Level ${s.level}</div><div class="fam-sub">Total ${s.max || '—'}</div>${boxes}</span></div>`;
    }).join('')}</div>`;
    case 'cells': return `<div class="fam-cells" style="grid-template-columns:repeat(${it.cols},1fr)">${it.cells.map((c) => `<div><div class="fam-cellhead"><b>${esc(c.head)}</b><span class="dots">${Array.from({ length: 5 }, (_, i) => `<span class="dot-p${i < c.dots ? ' on' : ''}"></span>`).join('')}</span></div>${Array.from({ length: 4 }, (_, i) => `<div class="fam-ruled small">${esc(c.lines[i] || '')}</div>`).join('')}</div>`).join('')}</div>`;
    case 'stats': return `<div class="fam-stats" style="grid-template-columns:repeat(${it.cols},1fr)">${it.stats.map((s) => `<div><div class="fam-fl">${esc(s.label)}</div><div class="fam-stat"><b>${esc(s.value)}</b>${s.half != null ? `<span>${esc(s.half)}<br>${esc(s.fifth)}</span>` : ''}</div></div>`).join('')}</div>`;
    case 'numtrack': {
      let out = `<div class="fam-num" style="grid-template-columns:repeat(${it.perRow},1fr)">`;
      for (let n = it.from; n <= it.to; n++) out += `<span${n === it.current ? ' class="on"' : ''}>${n}</span>`;
      return out + '</div>';
    }
    case 'skillcols': return `<div class="fam-row">${it.cols.map((list) => `<div>${list.map((s) => `<div class="fam-skill"><span class="fam-box${s.improve ? ' on' : ''}"></span><span class="fam-cl">${esc(s.name)}${s.base ? ` <i>(${esc(s.base)})</i>` : ''}</span><b>${esc(s.value)}</b><small>${Math.floor(s.value / 2)} ${Math.floor(s.value / 5)}</small></div>`).join('')}</div>`).join('')}</div>`;
    case 'table': {
      const rows = Math.max(it.min || 0, it.rows.length);
      return `<table class="fam-table"><colgroup>${it.cols.map(([, w]) => `<col style="width:${w}%">`).join('')}</colgroup><thead><tr>${it.cols.map(([l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead><tbody>${Array.from({ length: rows }, (_, r) => `<tr>${it.cols.map((_, i) => `<td>${esc(it.rows[r]?.[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    default: return '';
  }
}

/** The in-app sheet in its familiar layout: the same section map as the PDF. */
export function familiarHtml(system, data, { name = '' } = {}) {
  const model = familiarModel(system, data, { name });
  if (!model) return '';
  const [PW, PH] = model.size;
  const pages = model.pages.map((sections) => `<div class="fam-page" style="aspect-ratio:${PW}/${PH};font-size:calc(100cqw / ${PW})">${sections.map((s) =>
    `<section class="fam-sec${s.bare ? ' bare' : ''}${s.shield ? ' shield' : ''}" style="left:${em(s.x)};top:${em(s.y)};width:${em(s.w)};height:${em(s.h)}">${s.title ? `<div class="fam-title">${esc(s.title)}</div>` : ''}${s.items.map(itemHtml).join('')}</section>`).join('')}</div>`).join('');
  const more = model.continuations.length
    ? `<details class="fam-more"><summary>Continued details (${model.continuations.length})</summary>${model.continuations.map((c) => `<h4>${esc(c.title)}</h4><p>${esc(c.text).replace(/\n/g, '<br>')}</p>`).join('')}</details>` : '';
  return `<div class="fam-wrap fam-${esc(system)}"><div class="fam-label">${esc(LABELS[system])} · familiar layout</div>${pages}${more}</div>`;
}
