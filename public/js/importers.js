// Importers: Obsidian/Markdown folders, CSV, 5e.tools JSON (bestiaries,
// spells, items), World Anvil article exports and Foundry VTT journals/actors.
// Everything runs fully in the browser — files never leave the machine.

import { uid } from './util.js';
import { xpForCr } from './encounter.js';
import { api } from './api.js';

// ---------- Markdown / Obsidian ----------

/** Parse simple YAML-ish frontmatter (---\nkey: value\n---). Best effort. */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim().replace(/^["']|["']$/g, '');
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[m[1]] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      meta[m[1]] = val;
    }
  }
  let body = text.slice(end + 4);
  // frontmatter lists continued on following lines ("tags:\n  - a") — cheap pass
  return { meta, body };
}

/** Markdown body → MundusMaker blocks: # headings become heading blocks. */
export function mdToBlocks(body) {
  const blocks = [];
  let buf = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) blocks.push({ id: uid(), kind: 'text', text: t, secret: false });
    buf = [];
  };
  for (const raw of String(body).split(/\r?\n/)) {
    const line = raw.replace(/!\[\[([^\]]+)\]\]/g, '[[$1]]'); // embeds → links
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (h) { flush(); blocks.push({ id: uid(), kind: 'heading', text: h[1].trim(), secret: false }); }
    else buf.push(line);
  }
  flush();
  if (!blocks.length) blocks.push({ id: uid(), kind: 'text', text: '', secret: false });
  return blocks;
}

// ---------- CSV ----------

/**
 * Hand-rolled CSV parse: BOM strip, CRLF, quoted fields (embedded delimiters,
 * newlines, doubled quotes), delimiter sniffed from the header line (, ; tab).
 * Returns an array of rows; blank rows dropped.
 */
export function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const headerEnd = text.indexOf('\n');
  const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
  let delim = ',', best = 0;
  for (const d of [',', ';', '\t']) {
    const n = header.split(d).length;
    if (n > best) { best = n; delim = d; }
  }
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

// ---------- bundled SRD bestiary ----------

let bundled = null;
/** The ~322 SRD 5.1 monsters shipped with MundusMaker (CC-BY-4.0). Cached. */
export async function loadBundledBestiary() {
  if (!bundled) {
    const res = await fetch('/bestiary/srd-bestiary.json');
    if (!res.ok) throw new Error('bundled bestiary missing');
    bundled = await res.json();
  }
  return bundled;
}

// ---------- 5e.tools bestiary ----------

const SIZE_NAMES = { T: 'Tiny', S: 'Small', M: 'Medium', L: 'Large', H: 'Huge', G: 'Gargantuan' };
const ALIGN_NAMES = {
  L: 'lawful', N: 'neutral', C: 'chaotic', G: 'good', E: 'evil',
  U: 'unaligned', A: 'any alignment', NX: 'neutral', NY: 'neutral',
};

/** Strip 5etools {@tag ...} markup down to readable text. */
export function clean5eTags(s) {
  return String(s)
    .replace(/\{@atk mw,rw\}/g, 'Melee or Ranged Weapon Attack:')
    .replace(/\{@atk mw\}/g, 'Melee Weapon Attack:')
    .replace(/\{@atk rw\}/g, 'Ranged Weapon Attack:')
    .replace(/\{@atk ms\}/g, 'Melee Spell Attack:')
    .replace(/\{@atk rs\}/g, 'Ranged Spell Attack:')
    .replace(/\{@atk ms,rs\}/g, 'Melee or Ranged Spell Attack:')
    .replace(/\{@h\}/g, 'Hit: ')
    .replace(/\{@hit ([^}|]+)[^}]*\}/g, (_, v) => (String(v).startsWith('-') ? v : '+' + v))
    .replace(/\{@dc ([^}|]+)[^}]*\}/g, 'DC $1')
    .replace(/\{@recharge (\d)\}/g, '(Recharge $1–6)')
    .replace(/\{@recharge\}/g, '(Recharge 6)')
    .replace(/\{@(?:damage|dice) ([^}|]+)[^}]*\}/g, '$1')
    // generic {@tag text|source|display} → display if present, else text
    .replace(/\{@\w+ ([^}]+)\}/g, (_, inner) => {
      const parts = inner.split('|');
      return parts[2] || parts[0];
    })
    .replace(/\{@\w+\}/g, '');
}

function joinEntries(entries) {
  const out = [];
  for (const e of entries || []) {
    if (typeof e === 'string') out.push(clean5eTags(e));
    else if (e?.items) out.push(e.items.map((i) => (typeof i === 'string' ? clean5eTags(i) : i?.name || '')).join('; '));
    else if (e?.entries) out.push(joinEntries(e.entries));
  }
  return out.join(' ');
}

function listish(v) {
  if (!v) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x?.special || Object.keys(x).filter((k) => Array.isArray(x[k])).map((k) => `${x[k].join(', ')} ${x.note || ''}`).join(', '))).join(', ');
  return String(v);
}

/** Convert one 5etools monster entry into a MundusMaker statblock. */
export function monsterToStat(mon) {
  const size = (mon.size || []).map((s) => SIZE_NAMES[s] || s).join(' or ') || 'Medium';
  const typeStr = typeof mon.type === 'string' ? mon.type
    : `${mon.type?.type || 'creature'}${mon.type?.tags?.length ? ` (${mon.type.tags.map((t) => typeof t === 'string' ? t : t.tag).join(', ')})` : ''}`;
  const align = (mon.alignment || []).map((a) => (typeof a === 'string' ? ALIGN_NAMES[a] || '' : '')).filter(Boolean).join(' ') || 'unaligned';

  const acEntry = Array.isArray(mon.ac) ? mon.ac[0] : mon.ac;
  const ac = typeof acEntry === 'number' ? String(acEntry)
    : acEntry ? `${acEntry.ac}${acEntry.from ? ` (${acEntry.from.map(clean5eTags).join(', ')})` : ''}` : '10';

  const hp = mon.hp?.special ? String(mon.hp.special)
    : `${mon.hp?.average ?? '?'}${mon.hp?.formula ? ` (${mon.hp.formula})` : ''}`;

  const speed = typeof mon.speed === 'object'
    ? Object.entries(mon.speed)
        .filter(([, v]) => v && typeof v !== 'boolean')
        .map(([k, v]) => `${k === 'walk' ? '' : k + ' '}${typeof v === 'object' ? v.number : v} ft.`)
        .join(', ')
    : `${mon.speed || 30} ft.`;

  const cr = typeof mon.cr === 'object' ? (mon.cr?.cr || '0') : String(mon.cr ?? '0');
  const vitals = [];
  if (mon.save) vitals.push({ k: 'Saving Throws', v: Object.entries(mon.save).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(', ') });
  if (mon.skill) vitals.push({ k: 'Skills', v: Object.entries(mon.skill).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)} ${v}`).join(', ') });
  if (mon.vulnerable) vitals.push({ k: 'Damage Vulnerabilities', v: listish(mon.vulnerable) });
  if (mon.resist) vitals.push({ k: 'Damage Resistances', v: listish(mon.resist) });
  if (mon.immune) vitals.push({ k: 'Damage Immunities', v: listish(mon.immune) });
  if (mon.conditionImmune) vitals.push({ k: 'Condition Immunities', v: listish(mon.conditionImmune) });
  const senses = [...(mon.senses || []), ...(mon.passive ? [`passive Perception ${mon.passive}`] : [])].join(', ');
  if (senses) vitals.push({ k: 'Senses', v: senses });
  if (mon.languages?.length) vitals.push({ k: 'Languages', v: mon.languages.join(', ') });
  vitals.push({ k: 'Challenge', v: `${cr} (${xpForCr(cr).toLocaleString()} XP)` });

  const section = (list, prefix = '') => (list || []).map((t) => ({
    name: prefix + clean5eTags(t.name || ''),
    text: joinEntries(t.entries),
  }));

  // spellcasting blocks → one trait each, with slot/at-will/daily lists flattened
  const ordinals = ['0th', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];
  const spellTraits = (mon.spellcasting || []).map((sc) => {
    const bits = [];
    if (sc.headerEntries) bits.push(joinEntries(sc.headerEntries));
    const spellList = (arr) => (arr || []).map((s) => clean5eTags(typeof s === 'string' ? s : s?.entry || '')).join(', ');
    if (sc.will?.length) bits.push(`At will: ${spellList(sc.will)}`);
    for (const [key, arr] of Object.entries(sc.daily || {})) {
      bits.push(`${key.replace(/e$/, '')}/day${key.endsWith('e') ? ' each' : ''}: ${spellList(arr)}`);
    }
    for (const [lvl, obj] of Object.entries(sc.spells || {})) {
      const label = lvl === '0' ? 'Cantrips (at will)' : `${ordinals[lvl] || lvl + 'th'} level${obj.slots ? ` (${obj.slots} slot${obj.slots === 1 ? '' : 's'})` : ''}`;
      bits.push(`${label}: ${spellList(obj.spells)}`);
    }
    return { name: clean5eTags(sc.name || 'Spellcasting'), text: bits.join(' — ') };
  });

  return {
    name: mon.name,
    meta: `${size} ${typeStr}, ${align}`,
    ac, hp, speed,
    str: mon.str ?? 10, dex: mon.dex ?? 10, con: mon.con ?? 10,
    int: mon.int ?? 10, wis: mon.wis ?? 10, cha: mon.cha ?? 10,
    vitals,
    traits: [...section(mon.trait), ...spellTraits],
    actions: [
      ...section(mon.action),
      ...section(mon.bonus, 'Bonus Action: '),
      ...section(mon.reaction, 'Reaction: '),
      ...section(mon.legendary, 'Legendary: '),
    ],
  };
}

// ---------- compendium library (0.14) ----------

let libraryMonstersCache = null;
/** Bundled SRD bestiary + every imported pack's monsters, tagged with a source. Cached. */
export async function loadAllMonsters() {
  if (libraryMonstersCache) return libraryMonstersCache;
  const out = [];
  try {
    const bundled = await loadBundledBestiary();
    out.push(...bundled.monster.map((m) => ({ ...m, _pack: 'SRD' })));
  } catch { /* bundled file missing — packs may still exist */ }
  try {
    for (const meta of await api.library()) {
      if (!meta.kinds?.includes('monster')) continue;
      const pack = await api.libraryPack(meta.id);
      out.push(...(pack.monster || []).map((m) => ({ ...m, _pack: meta.name })));
    }
  } catch { /* server without library routes */ }
  libraryMonstersCache = out;
  return out;
}
export function invalidateLibraryCache() { libraryMonstersCache = null; }

const SCHOOL_NAMES = { A: 'Abjuration', C: 'Conjuration', D: 'Divination', E: 'Enchantment', V: 'Evocation', I: 'Illusion', N: 'Necromancy', T: 'Transmutation' };

/** Normalize a spell — raw 5etools shape OR the bundled srd52 shape — to one display form. */
export function normalizeSpell(s) {
  if (s.castingTime !== undefined || typeof s.school === 'string' && s.school.length > 2) {
    // bundled srd52/spells.json shape — already formatted
    return { ...s, source: s.source || 'SRD 5.2' };
  }
  const t = s.time?.[0];
  const r = s.range;
  const dur = s.duration?.[0];
  const rangeStr = !r ? '' : r.type === 'point'
    ? (r.distance?.type === 'self' ? 'Self' : r.distance?.type === 'touch' ? 'Touch'
      : `${r.distance?.amount ?? ''} ${r.distance?.type ?? ''}`.trim())
    : `Self (${r.distance?.amount ?? ''}-${r.distance?.type ?? ''} ${r.type})`;
  const durStr = !dur ? '' : dur.type === 'instant' ? 'Instantaneous'
    : dur.type === 'special' ? 'Special'
    : dur.type === 'permanent' ? 'Until dispelled'
    : `${dur.concentration ? 'Concentration, up to ' : ''}${dur.duration?.amount ?? ''} ${dur.duration?.type ?? ''}${(dur.duration?.amount ?? 1) === 1 ? '' : 's'}`;
  return {
    name: s.name,
    level: s.level ?? 0,
    school: SCHOOL_NAMES[s.school] || s.school || '',
    castingTime: t ? `${t.number} ${t.unit}` : '',
    ritual: !!s.meta?.ritual,
    range: rangeStr,
    components: [s.components?.v && 'V', s.components?.s && 'S',
      s.components?.m && `M (${typeof s.components.m === 'string' ? clean5eTags(s.components.m) : clean5eTags(s.components.m?.text || '')})`].filter(Boolean).join(', '),
    duration: durStr,
    concentration: !!dur?.concentration,
    classes: (s.classes?.fromClassList || []).map((c) => c.name),
    text: joinEntriesBlocks(s.entries),
    higherLevel: s.entriesHigherLevel ? joinEntriesBlocks(s.entriesHigherLevel) : '',
    source: s.source || '',
  };
}

/** Like joinEntries but keeps paragraph breaks — for spell/item body text. */
function joinEntriesBlocks(entries) {
  const out = [];
  for (const e of entries || []) {
    if (typeof e === 'string') out.push(clean5eTags(e));
    else if (e?.items) out.push(e.items.map((i) => '• ' + (typeof i === 'string' ? clean5eTags(i) : clean5eTags(i?.name || ''))).join('\n'));
    else if (e?.entries) out.push((e.name ? `**${clean5eTags(e.name)}.** ` : '') + joinEntriesBlocks(e.entries));
  }
  return out.join('\n\n');
}

const spellLevelStr = (lvl) => lvl === 0 ? 'Cantrip' : `Level ${lvl}`;

/** Build a MundusMaker entity from a normalized spell. */
export function spellToEntity(sp, newEntity) {
  const e = newEntity(sp.name, 'spell');
  e.fields = {
    'Level': spellLevelStr(sp.level) + (sp.ritual ? ' (ritual)' : ''),
    'School': sp.school,
    'Casting time': sp.castingTime,
    'Range': sp.range,
    'Duration': sp.duration,
    'Classes': (sp.classes || []).join(', '),
  };
  for (const k of Object.keys(e.fields)) if (!e.fields[k]) delete e.fields[k];
  e.tags = ['spell', sp.level === 0 ? 'cantrip' : `level-${sp.level}`, sp.school.toLowerCase()].filter(Boolean);
  e.blocks = [
    sp.components ? { id: uid(), kind: 'text', text: `*Components:* ${sp.components}`, secret: false } : null,
    { id: uid(), kind: 'text', text: sp.text || '', secret: false },
    sp.higherLevel ? { id: uid(), kind: 'text', text: `**At higher levels.** ${sp.higherLevel}`, secret: false } : null,
  ].filter(Boolean);
  return e;
}

/** Normalize an item — raw 5etools shape OR the bundled srd52 equipment shape. */
export function normalizeItem(it) {
  if (it.category !== undefined) {
    // bundled srd52/equipment.json shape
    return {
      name: it.name, kind: it.category, rarity: '', attune: '',
      cost: it.cost || '', weight: it.weight || 0,
      damage: it.damage || '', ac: it.ac, text: '', source: 'SRD 5.2',
      properties: it.properties || [],
    };
  }
  const costStr = !it.value ? '' : it.value >= 100 ? `${it.value / 100} gp` : it.value >= 10 ? `${it.value / 10} sp` : `${it.value} cp`;
  const TYPE_NAMES = {
    M: 'melee weapon', R: 'ranged weapon', A: 'ammunition', LA: 'light armor',
    MA: 'medium armor', HA: 'heavy armor', S: 'shield', G: 'adventuring gear',
    P: 'potion', SC: 'scroll', RD: 'rod', RG: 'ring', WD: 'wand', ST: 'staff', T: 'tools',
  };
  const rawType = String(it.type || '').split('|')[0];
  return {
    name: it.name,
    kind: it.wondrous ? 'wondrous item' : TYPE_NAMES[rawType] || rawType || 'item',
    rarity: it.rarity && it.rarity !== 'none' ? it.rarity : '',
    attune: it.reqAttune === true ? 'requires attunement' : typeof it.reqAttune === 'string' ? `requires attunement ${clean5eTags(it.reqAttune)}` : '',
    cost: costStr,
    weight: it.weight || 0,
    damage: it.dmg1 ? `${it.dmg1} ${({ B: 'bludgeoning', P: 'piercing', S: 'slashing' })[it.dmgType] || ''}`.trim() : '',
    ac: it.ac,
    text: joinEntriesBlocks(it.entries),
    source: it.source || '',
    properties: [],
  };
}

/** Build a MundusMaker entity from a normalized item. */
export function itemToEntity(it, newEntity) {
  const e = newEntity(it.name, 'item');
  e.fields = { 'Kind': it.kind, 'Rarity': it.rarity };
  if (it.attune) e.fields['Attunement'] = it.attune;
  if (it.cost) e.fields['Cost'] = it.cost;
  if (it.weight) e.fields['Weight'] = `${it.weight} lb.`;
  if (it.damage) e.fields['Damage'] = it.damage;
  if (it.ac) e.fields['AC'] = String(it.ac);
  for (const k of Object.keys(e.fields)) if (!e.fields[k]) delete e.fields[k];
  e.tags = ['item', it.rarity || null].filter(Boolean).map((t) => t.toLowerCase());
  e.blocks = [{ id: uid(), kind: 'text', text: it.text || '', secret: false }];
  return e;
}

// ---------- HTML → blocks (World Anvil, Foundry journals) ----------

/** Convert exported HTML into MundusMaker blocks. Headings become heading
 *  blocks, blockquotes quotes, lists dashed lines; everything else is text. */
export function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script, style').forEach((n) => n.remove());
  const blocks = [];
  let buf = [];
  const flush = () => {
    const t = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t) blocks.push({ id: uid(), kind: 'text', text: t, secret: false });
    buf = [];
  };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent.trim();
        if (t) buf.push(t);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        flush();
        const t = child.textContent.trim();
        if (t) blocks.push({ id: uid(), kind: 'heading', text: t, secret: false });
      } else if (tag === 'blockquote') {
        flush();
        const t = child.textContent.trim();
        if (t) blocks.push({ id: uid(), kind: 'quote', text: t, secret: false });
      } else if (tag === 'li') {
        buf.push('- ' + child.textContent.trim());
      } else if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
        walk(child);
        buf.push('');
      } else if (tag === 'br') {
        buf.push('');
      } else if (tag === 'table') {
        buf.push('(table omitted)');
      } else {
        walk(child);
      }
    }
  };
  walk(doc.body);
  flush();
  if (!blocks.length) blocks.push({ id: uid(), kind: 'text', text: '', secret: false });
  return blocks;
}

// ---------- World Anvil ----------

const WA_TYPE_MAP = {
  person: 'npc', character: 'npc', location: 'location', settlement: 'location',
  geography: 'location', landmark: 'location', building: 'location',
  organization: 'faction', ethnicity: 'faction', item: 'item', vehicle: 'item',
  species: 'creature', condition: 'note', article: 'note', spell: 'spell',
  myth: 'note', ritual: 'note', document: 'note', law: 'note',
};

/** Parse a World Anvil export (a JSON array of articles, or {articles: []},
 *  or a single article object). Returns [{name, type, html, tags}]. */
export function parseWorldAnvil(data) {
  const arts = Array.isArray(data) ? data : Array.isArray(data?.articles) ? data.articles
    : data?.title || data?.name ? [data] : Object.values(data || {}).filter((x) => x?.title || x?.name);
  return arts.map((a) => {
    const template = String(a.template || a.entityClass || a.templateType || '').toLowerCase().replace(/article$/, '');
    return {
      name: String(a.title || a.name || '').trim(),
      type: WA_TYPE_MAP[template] || 'note',
      html: a.content_parsed || a.contentParsed || a.content || a.fullcontent || '',
      tags: typeof a.tags === 'string' ? a.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
        : Array.isArray(a.tags) ? a.tags.map((t) => String(t).toLowerCase()) : [],
    };
  }).filter((a) => a.name);
}

// ---------- Foundry VTT ----------

/** Parse Foundry export text: one JSON document, an array, or NeDB .db (JSON lines). */
export function parseFoundryText(text) {
  const t = String(text).trim();
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { /* fall through to JSON-lines */ }
  const docs = [];
  for (const line of t.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { docs.push(JSON.parse(l)); } catch { /* skip corrupt line */ }
  }
  return docs;
}

/** One Foundry journal (v10+ pages or classic content) → blocks. */
export function foundryJournalToBlocks(doc) {
  const blocks = [];
  if (Array.isArray(doc.pages)) {
    for (const page of doc.pages) {
      if (page.name && doc.pages.length > 1) blocks.push({ id: uid(), kind: 'heading', text: page.name, secret: false });
      const html = page.text?.content || page.text?.markdown || '';
      if (html) blocks.push(...htmlToBlocks(html));
    }
  } else if (doc.content) {
    blocks.push(...htmlToBlocks(doc.content));
  }
  return blocks.length ? blocks : [{ id: uid(), kind: 'text', text: '', secret: false }];
}

/** A dnd5e-system Foundry actor → statblock (best effort; other systems → null). */
export function foundryActorToStat(doc) {
  const sys = doc.system || doc.data;
  const ab = sys?.abilities;
  if (!ab?.str) return null;
  const attr = sys.attributes || {};
  const details = sys.details || {};
  const vitals = [];
  if (details.cr != null) vitals.push({ k: 'Challenge', v: `${details.cr} (${xpForCr(String(details.cr)).toLocaleString()} XP)` });
  const traits = (doc.items || [])
    .filter((it) => ['feat'].includes(it.type))
    .map((it) => ({ name: it.name, text: htmlToPlainText(it.system?.description?.value || '') }))
    .filter((t) => t.name);
  const actions = (doc.items || [])
    .filter((it) => ['weapon'].includes(it.type))
    .map((it) => ({ name: it.name, text: htmlToPlainText(it.system?.description?.value || '') }));
  return {
    name: doc.name,
    meta: [details.type?.value || details.type, details.alignment].filter(Boolean).join(', '),
    ac: String(attr.ac?.flat ?? attr.ac?.value ?? ''),
    hp: String(attr.hp?.max ?? attr.hp?.value ?? ''),
    speed: attr.movement ? Object.entries(attr.movement)
      .filter(([k, v]) => typeof v === 'number' && v > 0 && k !== 'units')
      .map(([k, v]) => `${k === 'walk' ? '' : k + ' '}${v} ft.`).join(', ') : '',
    str: ab.str?.value ?? 10, dex: ab.dex?.value ?? 10, con: ab.con?.value ?? 10,
    int: ab.int?.value ?? 10, wis: ab.wis?.value ?? 10, cha: ab.cha?.value ?? 10,
    vitals, traits, actions,
  };
}

function htmlToPlainText(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return doc.body.textContent.replace(/\s+/g, ' ').trim();
}
