// Importers: Obsidian/Markdown folders and 5e.tools bestiary JSON.
// Both run fully in the browser — files never leave the machine.

import { uid } from './util.js';
import { xpForCr } from './encounter.js';

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

/** Markdown body → Loreweave blocks: # headings become heading blocks. */
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

// ---------- bundled SRD bestiary ----------

let bundled = null;
/** The ~322 SRD 5.1 monsters shipped with Loreweave (CC-BY-4.0). Cached. */
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

/** Convert one 5etools monster entry into a Loreweave statblock. */
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
