// Builds the bundled SRD 5.2 content pack (D&D 2024 rules) for the character
// creator: classes, species, backgrounds, feats, spells and equipment.
// Downloads 5etools data and keeps ONLY entries flagged `srd52`, which Wizards
// of the Coast releases under Creative Commons CC-BY-4.0 and is therefore
// legal to redistribute with attribution. The full 2024 Player's Handbook is
// NOT — do not remove the srd52 filter.
//
//   node scripts/build-srd52.js   → public/srd52/{classes,species,backgrounds,feats,spells,equipment}.json
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://raw.githubusercontent.com/5etools-mirror-3/5etools-src/main/data';
const OUT_DIR = path.join(__dirname, '..', 'public', 'srd52');
const LICENSE = 'This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/legalcode).';

const CLASS_FILES = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
  'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'];

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchJson(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------- 5etools text → plain text ----------

function cleanTags(s) {
  return String(s)
    .replace(/\{@dc ([^}|]+)[^}]*\}/g, 'DC $1')
    .replace(/\{@(?:damage|dice|scaledamage|scaledice) ([^}|]+)[^}]*\}/g, '$1')
    .replace(/\{@\w+ ([^}]+)\}/g, (_, inner) => {
      const parts = inner.split('|');
      return parts[parts.length - 1].includes('{') ? parts[0] : (parts[2] || parts[0]);
    })
    .replace(/\{@\w+\}/g, '');
}

/** Flatten a 5etools entries[] tree to readable paragraphs. Tables are elided. */
function flattenEntries(entries, depth = 0) {
  const out = [];
  for (const e of entries || []) {
    if (typeof e === 'string') { out.push(cleanTags(e)); continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'list') {
      out.push((e.items || []).map((i) => '• ' + (typeof i === 'string' ? cleanTags(i)
        : i?.name ? `${cleanTags(i.name)}. ${flattenEntries(i.entries || (i.entry ? [i.entry] : []), depth + 1)}`
        : flattenEntries(i?.entries || [], depth + 1))).join('\n'));
    } else if (e.type === 'table') {
      out.push('(table — see the SRD)');
    } else if (e.entries || e.entry) {
      const inner = flattenEntries(e.entries || [e.entry], depth + 1);
      out.push(e.name ? `${cleanTags(e.name)}. ${inner}` : inner);
    } else if (e.items) {
      out.push(flattenEntries(e.items, depth + 1));
    }
  }
  return out.join(depth ? ' ' : '\n\n');
}

const bySrdName = (x) => (typeof x.srd52 === 'string' ? { ...x, name: x.srd52 } : x);

// ---------- builders ----------

async function buildClasses() {
  const classes = [];
  for (const file of CLASS_FILES) {
    const data = await fetchJson(`${BASE}/class/class-${file}.json`);
    const cls = (data.class || []).find((c) => c.srd52);
    if (!cls) { console.warn(`! no srd52 class in class-${file}.json`); continue; }
    const features = (data.classFeature || []).filter((f) => f.srd52);
    const findFeature = (ref) => {
      const [name, , , level] = String(ref.classFeature || ref).split('|');
      return features.find((f) => f.name.toLowerCase() === name.toLowerCase() && f.level === Number(level));
    };
    const sub = (data.subclass || []).find((s) => s.srd52);
    const subFeatures = (data.subclassFeature || []).filter((f) => f.srd52);

    const skills = cls.startingProficiencies?.skills?.[0]?.choose || {};
    classes.push({
      name: cls.name,
      hitDie: cls.hd?.faces || 8,
      primaryAbility: cls.primaryAbility?.[0] ? Object.keys(cls.primaryAbility[0]).filter((k) => cls.primaryAbility[0][k]) : [],
      saves: cls.proficiency || [],
      armor: (cls.startingProficiencies?.armor || []).map((a) => (typeof a === 'string' ? a : a?.proficiency || '')).filter(Boolean),
      weapons: (cls.startingProficiencies?.weapons || []).map((w) => (typeof w === 'string' ? w : w?.proficiency || '')).filter(Boolean),
      skills: { choose: skills.count || 2, from: (skills.from || []).map((s) => s[0].toUpperCase() + s.slice(1)) },
      startingEquipment: flattenEntries(cls.startingEquipment?.entries || cls.startingEquipment?.default || []),
      spellcasting: cls.spellcastingAbility ? {
        ability: cls.spellcastingAbility,
        progression: cls.casterProgression || 'full',
        cantrips: !!cls.cantripProgression,
      } : null,
      features: (cls.classFeatures || []).map((ref) => {
        const f = findFeature(ref);
        return f && { level: f.level, name: f.name, text: flattenEntries(f.entries) };
      }).filter(Boolean),
      subclass: sub ? {
        name: sub.name,
        features: (sub.subclassFeatures || []).map((ref) => {
          const [name, , , , , level] = String(ref).split('|');
          const f = subFeatures.find((x) => x.name.toLowerCase() === String(name).toLowerCase() && x.level === Number(level))
            || subFeatures.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
          return f && { level: f.level, name: f.name, text: flattenEntries(f.entries) };
        }).filter(Boolean),
      } : null,
    });
    console.log(`  class ${cls.name}: ${classes[classes.length - 1].features.length} features, subclass ${sub?.name || '—'}`);
  }
  return classes;
}

async function buildSpecies() {
  const data = await fetchJson(`${BASE}/races.json`);
  return (data.race || []).filter((r) => r.srd52 && !r._copy).map(bySrdName).map((r) => ({
    name: r.name,
    size: (r.size || ['M']).map((s) => ({ T: 'Tiny', S: 'Small', M: 'Medium', L: 'Large' }[s] || s)).join(' or '),
    speed: typeof r.speed === 'number' ? r.speed : r.speed?.walk || 30,
    darkvision: r.darkvision || 0,
    traits: (r.entries || []).filter((e) => e?.name).map((e) => ({ name: cleanTags(e.name), text: flattenEntries(e.entries) })),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

async function buildBackgrounds() {
  const data = await fetchJson(`${BASE}/backgrounds.json`);
  return (data.background || []).filter((b) => b.srd52 && !b._copy).map(bySrdName).map((b) => ({
    name: b.name,
    abilities: [...new Set((b.ability || []).flatMap((a) => a.choose?.weighted?.from || a.choose?.from || Object.keys(a).filter((k) => k !== 'choose')))],
    skills: (b.skillProficiencies || []).flatMap((s) => Object.keys(s).filter((k) => k !== 'choose' && k !== 'any')).map((s) => s[0].toUpperCase() + s.slice(1)),
    tool: (b.toolProficiencies || []).flatMap((t) => Object.keys(t)).join(', '),
    feat: (b.feats || []).flatMap((f) => Object.keys(f)).map((f) => f.split('|')[0])
      .map((f) => f.replace(/\b\w/g, (ch) => ch.toUpperCase())).join(', '),
    equipment: flattenEntries((b.entries || []).filter((e) => /equipment/i.test(e?.name || ''))),
    text: flattenEntries((b.entries || []).filter((e) => !e?.name || !/equipment/i.test(e.name))),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

async function buildFeats() {
  const data = await fetchJson(`${BASE}/feats.json`);
  return (data.feat || []).filter((f) => f.srd52 && !f._copy).map(bySrdName).map((f) => ({
    name: f.name,
    category: { O: 'Origin', G: 'General', FS: 'Fighting Style', EB: 'Epic Boon' }[f.category] || f.category || '',
    prereq: f.prerequisite ? flattenEntries([f.prerequisite.map?.((p) => JSON.stringify(p)).join('; ') || '']) : '',
    text: flattenEntries(f.entries),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

const SCHOOLS = { A: 'Abjuration', C: 'Conjuration', D: 'Divination', E: 'Enchantment', V: 'Evocation', I: 'Illusion', N: 'Necromancy', T: 'Transmutation' };

async function buildSpells() {
  const data = await fetchJson(`${BASE}/spells/spells-xphb.json`);
  // class spell lists live in a generated lookup, keyed by source → spell name
  let lookup = null;
  try {
    lookup = await fetchJson(`${BASE}/generated/gendata-spell-source-lookup.json`);
  } catch { console.warn('! spell class lookup unavailable — spells will carry no class lists'); }
  const classesFor = (spell) => {
    const entry = lookup?.[spell.source?.toLowerCase()]?.[spell.name.toLowerCase()];
    const out = new Set();
    for (const c of entry?.class ? Object.values(entry.class).flatMap((m) => Object.keys(m)) : []) out.add(c);
    // classVariant etc. ignored — base lists only
    return [...out].sort();
  };
  const timeStr = (t) => t?.[0] ? `${t[0].number} ${t[0].unit}${t[0].condition ? ` (${cleanTags(t[0].condition)})` : ''}` : '';
  const rangeStr = (r) => {
    if (!r) return '';
    if (r.type === 'point') {
      const d = r.distance || {};
      return d.type === 'self' ? 'Self' : d.type === 'touch' ? 'Touch' : d.type === 'sight' ? 'Sight' : d.type === 'unlimited' ? 'Unlimited' : `${d.amount ?? ''} ${d.type ?? ''}`.trim();
    }
    return `Self (${r.distance?.amount ?? ''}-${r.distance?.type ?? ''} ${r.type})`;
  };
  const durStr = (d) => {
    const x = d?.[0];
    if (!x) return '';
    if (x.type === 'instant') return 'Instantaneous';
    if (x.type === 'permanent') return x.ends ? 'Until dispelled' : 'Permanent';
    if (x.type === 'special') return 'Special';
    const dur = x.duration ? `${x.duration.amount} ${x.duration.type}${x.duration.amount === 1 ? '' : 's'}` : '';
    return `${x.concentration ? 'Concentration, up to ' : ''}${dur}`;
  };
  return (data.spell || []).filter((s) => s.srd52 && !s._copy).map(bySrdName).map((s) => ({
    name: s.name,
    level: s.level,
    school: SCHOOLS[s.school] || s.school,
    castingTime: timeStr(s.time),
    ritual: !!s.meta?.ritual,
    range: rangeStr(s.range),
    components: [s.components?.v && 'V', s.components?.s && 'S', s.components?.m && `M (${typeof s.components.m === 'string' ? cleanTags(s.components.m) : cleanTags(s.components.m?.text || '')})`].filter(Boolean).join(', '),
    duration: durStr(s.duration),
    concentration: !!s.duration?.[0]?.concentration,
    classes: classesFor(s),
    text: flattenEntries(s.entries),
    higherLevel: s.entriesHigherLevel ? flattenEntries(s.entriesHigherLevel) : '',
  })).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
}

async function buildEquipment() {
  const [baseData, itemData] = await Promise.all([
    fetchJson(`${BASE}/items-base.json`),
    fetchJson(`${BASE}/items.json`),
  ]);
  const costStr = (v) => (v == null ? '' : v >= 100 ? `${v / 100} gp` : v >= 10 ? `${v / 10} sp` : `${v} cp`);
  const conv = (it, category) => ({
    name: it.name,
    category,
    cost: costStr(it.value),
    weight: it.weight || 0,
    ac: it.ac || undefined,
    damage: it.dmg1 ? `${it.dmg1} ${({ B: 'bludgeoning', P: 'piercing', S: 'slashing' })[it.dmgType] || it.dmgType || ''}`.trim() : undefined,
    properties: (it.property || []).map((p) => String(typeof p === 'string' ? p : p?.uid || '').split('|')[0]).filter(Boolean),
    mastery: (it.mastery || []).map((m) => String(m).split('|')[0]),
  });
  const cat = (it) => it.weaponCategory ? `${it.weaponCategory} weapon`
    : it.armor ? `${({ 'L': 'light', 'M': 'medium', 'H': 'heavy' })[it.type?.split('|')[0]] || ''} armor`.trim()
    : it.type?.startsWith('S') ? 'shield' : 'gear';
  const base = (baseData.baseitem || []).filter((i) => i.srd52 && !i._copy).map(bySrdName).map((i) => conv(i, cat(i)));
  const items = (itemData.item || []).filter((i) => i.srd52 && !i._copy && !i.wondrous && !/^\+\d/.test(i.name)).map(bySrdName)
    .map((i) => conv(i, 'gear'));
  return [...base, ...items].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- main ----------

(async () => {
  console.log('building SRD 5.2 pack from', BASE);
  const [classes, species, backgrounds, feats, spells, equipment] = [
    await buildClasses(), await buildSpecies(), await buildBackgrounds(),
    await buildFeats(), await buildSpells(), await buildEquipment(),
  ];

  const counts = { classes: classes.length, species: species.length, backgrounds: backgrounds.length, feats: feats.length, spells: spells.length, equipment: equipment.length };
  console.log('counts:', JSON.stringify(counts));
  if (classes.length !== 12) throw new Error(`expected 12 classes, got ${classes.length} — source format changed?`);
  if (species.length < 9) throw new Error(`only ${species.length} species — source format changed?`);
  if (spells.length < 300) throw new Error(`only ${spells.length} spells — source format changed?`);
  if (backgrounds.length < 3) throw new Error(`only ${backgrounds.length} backgrounds — source format changed?`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const write = (name, key, arr) => {
    const file = path.join(OUT_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ _meta: { license: LICENSE, count: arr.length }, [key]: arr }));
    console.log(`✓ ${path.relative(path.join(__dirname, '..'), file)} — ${arr.length} entries, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  };
  write('classes', 'classes', classes);
  write('species', 'species', species);
  write('backgrounds', 'backgrounds', backgrounds);
  write('feats', 'feats', feats);
  write('spells', 'spells', spells);
  write('equipment', 'equipment', equipment);
})().catch((err) => {
  console.error('build-srd52 failed:', err.message);
  process.exit(1);
});
