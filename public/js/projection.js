// The player projection: the ONE set of rules that decides what a reader of a
// given edition may see. The world PDF, the player wiki and the safety check
// all filter through these functions. Two filters that disagreed would repeat
// the two-comparator failure (AGENTS.md → Chronology), so extract here rather
// than copy. Pure: no DOM and no app state, so Node tests import it directly.

import { isHistoric, isRecurring, histSortKey, slotSortKey, cmpKey, hasAges, ageBands, formatDate, formatYear } from './calendar.js';
import { mdToPlain, WIKILINK } from './markdown.js';
import { computeEncounter } from './encounter.js';
import { projectHandout, localAsset } from './handouts/handoutcore.js';
import { tableRows } from './randomtable.js';
import { compareNames } from './util.js';

/** The key an entity is grouped under (missing/blank types share one group). */
export const typeKeyOf = (e) => e.type || '';

/** gmOnly is the only entity-level flag. */
export const entityVisible = (e, gm) => !!e && (gm || !e.gmOnly);

/** Chapter groups: every type the world defines, then any type that only exists
 *  on an entity — from an import, a hand-edited file, or a deleted type. */
export function typeGroupsOf(known, entities) {
  const extra = new Map();
  for (const e of entities) {
    const key = typeKeyOf(e);
    // hasOwn, not `known[key]` — a type literally named "constructor" would
    // otherwise look defined and vanish again
    if (Object.hasOwn(known, key) || extra.has(key)) continue;
    extra.set(key, { label: key || 'Untyped', plural: key || 'Untyped', color: '#8a8f98', fields: [] });
  }
  return [...Object.entries(known), ...[...extra].sort((a, b) => a[0].localeCompare(b[0]))];
}

export const blockHasContent = (b) =>
  b.kind === 'statblock' || b.kind === 'encounter' || b.kind === 'sheet' || b.kind === 'table' || !!b.text?.trim();

/** Blocks an edition prints: secret ones dropped for players, and headings
 *  whose whole section is empty skipped (fresh template scaffolds). */
export function printableBlocks(entity, gm) {
  const shown = (entity.blocks || []).filter((b) => gm || !b.secret);
  return shown.filter((b, i) => {
    if (b.kind !== 'heading') return true;
    for (let j = i + 1; j < shown.length && shown[j].kind !== 'heading'; j++) {
      if (blockHasContent(shown[j])) return true;
    }
    return false;
  });
}

/** Quick-fact keys in print order: the type's fields, then the entry's own. */
export function factKeys(entity, typeDef) {
  return [...new Set([...(typeDef?.fields || []), ...Object.keys(entity.fields || {})])]
    .filter((k) => entity.fields?.[k]);
}

/** Relations an edition shows: secret ones dropped for players, and never one
 *  pointing at an entry the edition leaves out. */
export function visibleRelations(entity, { gm, byId, included }) {
  return (entity.relations || [])
    .filter((r) => gm || !r.secret)
    .map((r) => ({ r, target: byId.get(r.to) }))
    .filter(({ target }) => target && included(target));
}

/** First visible text block as a one-line snippet. */
export function snippetOf(entity, gm, maxLen = 150) {
  for (const b of entity.blocks || []) {
    if (b.kind !== 'text' || !b.text?.trim()) continue;
    if (b.secret && !gm) continue;
    const plain = mdToPlain(b.text).replace(/\s+/g, ' ').trim();
    return plain.length > maxLen ? plain.slice(0, maxLen) + '…' : plain;
  }
  return '';
}

// ---------- maps ----------

/** GM-only and missing targets whose cached overlay labels players must not
 *  see (a cached label could name a deleted secret). */
export function hiddenOverlayLinkIds(map, entities) {
  const all = [...entities];
  const known = new Set(all.map((entity) => entity.id));
  const hidden = new Set(all.filter((entity) => entity.gmOnly).map((entity) => entity.id));
  for (const item of [...(map?.markers || []), ...(map?.stamps || [])]) {
    if (item.to && !known.has(item.to)) hidden.add(item.to);
  }
  return hidden;
}

export function overlayVisible(item, opts) {
  if (opts.gm) return true;
  if (item.secret) return false;
  return !(item.to && opts.hiddenLinkIds?.has(item.to));
}

/**
 * Visible markers + stamps in map-key order (markers first) — matches the
 * numbers drawn by opts.numbered, so the printed key and the badges agree.
 */
export function mapKey(map, opts = {}) {
  return [...(map.markers || []), ...(map.stamps || [])].filter((o) => overlayVisible(o, opts));
}

/** A map's printed key for one edition. `numbered` is whether badges draw at
 *  all; rows skip unnamed items, which keep their number on the map only. */
export function mapKeyRows(map, { gm, entities, byId }) {
  const hiddenLinkIds = hiddenOverlayLinkIds(map, entities);
  const items = mapKey(map, { gm, hiddenLinkIds });
  const numbered = items.some((mk) => mk.label || mk.to);
  const rows = [];
  items.forEach((mk, i) => {
    const target = mk.to ? byId.get(mk.to) : null;
    const linked = entityVisible(target, gm) ? target : null;
    const label = mk.label || linked?.name;
    if (label) rows.push({ n: i + 1, label, linked, secret: !!mk.secret });
  });
  return { hiddenLinkIds, numbered, rows };
}

export const mapLevels = (map) => map.kind === 'dungeon' ? Math.max(1, Math.min(5, map.params?.levels || 1)) : 1;

// ---------- chronology ----------

/** Split BEFORE sorting (a recurring date has no year), then sort each list
 *  with the kernel. Bands come from the already-filtered list, so a band never
 *  announces an age only hidden entries fall in. */
export function timelineGroups(list, cal) {
  const dated = list.filter((e) => isHistoric(e.date))
    .sort((a, b) => cmpKey(histSortKey(a.date, cal), histSortKey(b.date, cal)));
  const annual = list.filter((e) => isRecurring(e.date))
    .sort((a, b) => cmpKey(slotSortKey(a.date, cal), slotSortKey(b.date, cal)) || compareNames(a.name, b.name));
  return { dated, annual, bands: hasAges(cal) ? ageBands(dated, cal, (e) => e.date) : null };
}

// ---------- links ----------

/** Wiki-links resolve by name (case-insensitive) or id, exactly as the app's
 *  findByName does. */
export function nameResolver(entities) {
  // Indexed for big worlds, keeping findByName's answer: the FIRST entry, in
  // iteration order, whose name or id matches.
  const byName = new Map(), byId = new Map();
  [...entities].forEach((e, i) => {
    const key = e.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, [i, e]);
    if (!byId.has(e.id)) byId.set(e.id, [i, e]);
  });
  return (name) => {
    const n = String(name).trim().toLowerCase();
    const a = byName.get(n), b = byId.get(n);
    return (a && b ? (a[0] <= b[0] ? a : b) : a || b)?.[1] || null;
  };
}

// ---------- the player wiki ----------

const isHandout = (e) => !!e.handout || e.type === 'handout';

/**
 * Everything the player wiki may show, as plain data. Player edition only:
 * there is deliberately no `gm` option. Entity ids are used as internal refs
 * and must never reach output; the site builder assigns page names.
 *
 * Images are requested as `needs` keyed by opaque internal keys; the exporter
 * renders or loads each one and names the file by a hash of its bytes.
 * `sheetLines(block, entryName)` turns a character sheet into text lines (the
 * browser passes one built on each system's printer; tests may omit it).
 */
export function projectPlayerWorld({ world, worldId, entities, typeKeys = null, include = {}, sheetLines = () => [] }) {
  const gm = false;
  const inc = { maps: true, timeline: true, relations: true, handouts: true, ...include };
  const all = [...entities];
  const byId = new Map(all.map((e) => [e.id, e]));
  const known = world.types || {};
  const groups = typeGroupsOf(known, all);
  const typeDef = new Map(groups);
  const included = (e) => entityVisible(e, gm) && (!typeKeys || typeKeys.has(typeKeyOf(e)));
  const shown = all.filter(included)
    .sort((a, b) => compareNames(a.name, b.name) || typeKeyOf(a).localeCompare(typeKeyOf(b)) || (a.id < b.id ? -1 : 1));
  const resolve = nameResolver(all);
  const cal = world.calendar || {};
  const needs = new Map();
  const need = (key, spec) => { if (!needs.has(key)) needs.set(key, spec); return key; };
  const assetNeed = (url) => {
    const local = localAsset(url, worldId);
    return local ? need(`asset:${local}`, { kind: 'asset', url: local }) : null;
  };

  /** A [[link]] target as the wiki shows it: a ref when the entry is in the
   *  wiki, null (plain text) when it is hidden, left out or missing. */
  const linkRef = (target) => {
    const ent = resolve(target);
    return ent && included(ent) ? ent.id : null;
  };

  const entries = new Map();
  for (const e of shown) {
    const t = typeDef.get(typeKeyOf(e)) || { label: typeKeyOf(e) || 'Untyped', color: '#8a8f98', fields: [] };
    const blocks = [];
    for (const b of printableBlocks(e, gm)) {
      if (b.kind === 'statblock') blocks.push({ kind: 'statblock', stat: statFor(b.stat, e.name) });
      else if (b.kind === 'encounter') blocks.push(encounterFor(b, byId, gm));
      else if (b.kind === 'table') blocks.push({ kind: 'table', title: b.table?.title || 'Random table', rows: tableRows(b.table).filter((r) => r.text.trim()) });
      else if (b.kind === 'sheet') blocks.push({ kind: 'sheet', system: b.system, lines: sheetLines(b, e.name) || [] });
      else if (b.text?.trim()) {
        blocks.push({ kind: ['heading', 'quote'].includes(b.kind) ? b.kind : 'text', text: b.text });
        for (const m of b.text.matchAll(/!\[[^\]]*\]\((\/assets\/[^\s)]+)\)/g)) assetNeed(m[1]);
      }
    }
    const date = e.date && (isHistoric(e.date) || isRecurring(e.date)) ? {
      text: formatDate(e.date, cal, world.era),
      until: isHistoric(e.date) && Number.isFinite(e.date.endYear) ? formatYear(e.date.endYear, cal, world.era) : '',
    } : null;
    let map = null;
    if (inc.maps && e.map) {
      const key = mapKeyRows(e.map, { gm, entities: all, byId });
      map = {
        levels: Array.from({ length: mapLevels(e.map) }, (_, lvl) =>
          need(`map:${e.id}:${lvl}`, { kind: 'map', ref: e.id, level: lvl, numbered: key.numbered, hiddenLinkIds: key.hiddenLinkIds })),
        key: key.rows.map((row) => ({ n: row.n, label: row.label, ref: row.linked && included(row.linked) ? row.linked.id : null, linkedName: row.linked?.name || '' })),
      };
    }
    let handout = null;
    if (inc.handouts && isHandout(e)) {
      const model = projectHandout(e, { entities: byId, worldId, gm });
      if (model && (model.blocks.length || model.image)) handout = need(`handout:${e.id}`, { kind: 'handout', ref: e.id });
    }
    entries.set(e.id, {
      ref: e.id, name: e.name, typeKey: typeKeyOf(e), typeLabel: t.label || typeKeyOf(e) || 'Untyped', color: t.color || '#8a8f98',
      tags: [...(e.tags || [])], date,
      portrait: e.image ? assetNeed(e.image) : null,
      facts: factKeys(e, t).map((k) => [k, String(e.fields[k])]),
      blocks,
      relations: inc.relations ? visibleRelations(e, { gm, byId, included }).map(({ r, target }) => ({ label: r.label || 'related to', ref: target.id })) : [],
      backlinks: [],
      map, handout,
      snippet: snippetOf(e, gm),
    });
  }

  // Backlinks from what the wiki prints: mentions in printable text and
  // visible relations. A secret block or relation never creates one.
  for (const src of entries.values()) {
    const seen = new Set();
    for (const b of src.blocks) {
      if (!b.text) continue;
      for (const m of b.text.matchAll(WIKILINK)) {
        const ref = linkRef(m[1]);
        if (ref && ref !== src.ref && !seen.has(ref)) { seen.add(ref); entries.get(ref).backlinks.push({ ref: src.ref, via: 'mention' }); }
      }
    }
    for (const rel of src.relations) {
      if (rel.ref !== src.ref) entries.get(rel.ref).backlinks.push({ ref: src.ref, via: 'relation', label: rel.label });
    }
  }
  for (const entry of entries.values()) {
    entry.backlinks.sort((a, b) => compareNames(entries.get(a.ref).name, entries.get(b.ref).name));
    entry.search = searchText(entry, entries);
  }

  const categories = groups
    .map(([key, t]) => ({ key, label: t.label || key, plural: t.plural || t.label || key || 'Untyped', color: t.color || '#8a8f98',
      entries: shown.filter((e) => typeKeyOf(e) === key).map((e) => e.id) }))
    .filter((c) => c.entries.length);

  let timeline = null;
  if (inc.timeline) {
    const tg = timelineGroups(shown.filter((e) => e.date), cal);
    if (tg.dated.length || tg.annual.length) {
      timeline = {
        today: cal.today || '',
        dated: tg.dated.map((e) => e.id),
        bands: tg.bands?.map((band) => ({ label: band.label, from: Number.isFinite(band.age?.startYear) ? band.age.startYear : null, items: band.items.map((e) => e.id) })) || null,
        annual: tg.annual.map((e) => e.id),
      };
    }
  }

  return {
    world: { name: world.name || 'Untitled world', description: world.description || '', today: cal.today || '' },
    order: shown.map((e) => e.id), entries, categories, timeline, needs,
    linkRef,
    // lookup only: every image the pages may show was requested above
    imageFor: (url) => { const local = localAsset(url, worldId); return local && needs.has(`asset:${local}`) ? `asset:${local}` : null; },
  };
}

function statFor(stat, fallbackName) {
  const s = stat || {};
  const pick = (list) => (list || []).filter((t) => t && (t.name || t.text)).map((t) => ({ name: String(t.name || ''), text: String(t.text || '') }));
  return {
    name: String(s.name || fallbackName || 'Unnamed'), meta: String(s.meta || ''),
    ac: String(s.ac ?? '—'), hp: String(s.hp ?? '—'), speed: String(s.speed ?? '—'),
    abilities: ['str', 'dex', 'con', 'int', 'wis', 'cha'].map((a) => [a, Number(s[a] ?? 10)]),
    vitals: (s.vitals || []).filter((v) => v && (v.k || v.v)).map((v) => [String(v.k || ''), String(v.v || '')]),
    traits: pick(s.traits), actions: pick(s.actions),
  };
}

// A revealed encounter may reference a gmOnly creature: it resolves to null,
// so computeEncounter falls back to the row's own typed name (as the PDF does).
function encounterFor(b, byId, gm) {
  const enc = b.enc || { partySize: 4, partyLevel: 1, rows: [] };
  const c = computeEncounter(enc, (id) => { const m = byId.get(id); return entityVisible(m, gm) ? m : null; });
  return {
    kind: 'encounter', difficulty: c.difficulty,
    rows: c.rows.map((r) => ({ count: r.count, name: r.displayName, cr: String(r.cr), xp: r.xpEach * r.count })),
    totalXp: c.totalXp, adjustedXp: c.adjustedXp, multiplier: c.multiplier,
    partySize: enc.partySize, partyLevel: enc.partyLevel,
  };
}

/** Search text from projected content only — the same text the pages show. */
function searchText(entry, entries) {
  // the name and category are indexed separately (site.js), so excerpts show body text
  const parts = [...entry.tags, ...entry.facts.flat()];
  for (const b of entry.blocks) {
    if (b.text) parts.push(mdToPlain(b.text));
    else if (b.kind === 'statblock') parts.push(b.stat.name);
    else if (b.kind === 'table') parts.push(b.title, ...b.rows.map((r) => r.text));
    else if (b.kind === 'sheet') parts.push(...b.lines.map((l) => l.text));
  }
  for (const rel of entry.relations) parts.push(rel.label, entries.get(rel.ref).name);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
}
